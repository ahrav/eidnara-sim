import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { table } from "../corpus/distributions";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import { TIERS } from "../prereg/schema";
import { Rng } from "../rng";
import {
    type Bank,
    type CompileInput,
    compileScenario,
    MANNER_WEIGHTS,
    type Manner,
    mannerQuota,
    markerHits,
    type Scenario,
    type Template,
} from "./compile";
import {
    type FaultEpisode,
    type FaultSession,
    SEAMS,
    scheduleFaults,
    validateFault,
} from "./faults";
import { loadCompileInput } from "./inputs";
import { type Embedder, hashEmbedder } from "./similarity";

const ROOT = join(import.meta.dir, "..", "..");
const inputS = (seed: number): CompileInput => loadCompileInput(seed, "S", hashEmbedder, true);
type TurnEvent = {
    id: string;
    scenario_ms: number;
    text: string;
    role: string;
    index: number;
    fact?: string;
    probe?: string;
    session: string;
    paste?: { sample_id: string; bytes: number };
};
const turns = (s: Scenario) =>
    s.events.filter((e) => e.kind === "user_turn") as unknown as TurnEvent[];
const p90Of = (input: CompileInput) => {
    const t = table(input.dist, "requests_per_session");
    return t.x[t.p.findIndex((p) => p >= 0.9)] ?? Number.NaN;
};

describe("SIM-P01: deterministic compile across processes", () => {
    for (const tier of TIERS) {
        test(`tier ${tier}: two processes write equal bytes, and scenario_hash covers every section`, () => {
            const seed = loadCompileInput(0, tier, hashEmbedder, true).prereg.seeds[0] ?? 0;
            const dir = mkdtempSync(join(tmpdir(), "sim-compile-"));
            const run = (name: string) => {
                const out = join(dir, name);
                const args = [
                    "--tier",
                    tier,
                    "--seed",
                    String(seed),
                    "--embedder",
                    "local",
                    "--out",
                    out,
                ];
                const r = Bun.spawnSync(["bun", "scripts/compile-scenario.ts", ...args], {
                    cwd: ROOT,
                });
                expect(r.exitCode).toBe(0);
                return readFileSync(out);
            };
            const a = run("a.json");
            expect(a.equals(run("b.json"))).toBe(true);
            const { scenario_hash, ...body } = JSON.parse(a.toString());
            expect(scenario_hash).toBe(sha256Hex(canonicalJson(body)));
            expect(body.manifest).toMatchObject({
                seed,
                tier,
                generator_version: "sim-scenario/v1",
            });
        }, 60_000);
    }

    test("a different seed yields a different scenario", async () => {
        const [a, b] = await Promise.all([compileScenario(inputS(1)), compileScenario(inputS(2))]);
        expect(a.scenario_hash).not.toBe(b.scenario_hash);
    });

    test("an embedder other than the pre-registered model is refused", async () => {
        await expect(compileScenario(loadCompileInput(101, "S", hashEmbedder))).rejects.toThrow(
            /differs from the pre-registered amazon.titan-embed-text-v2:0/,
        );
    });
});

describe("compiled S scenario", async () => {
    const input = inputS(101);
    const s = await compileScenario(input);
    const all = turns(s);
    const order = new Map(s.events.map((e, i) => [e.id, i]));

    test("every probe type P1 to P14 and the P1 control have the per-type count", () => {
        const counts = new Map<string, number>();
        for (const p of s.probes) counts.set(p.type, (counts.get(p.type) ?? 0) + 1);
        for (let i = 1; i <= 14; i++) expect(counts.get(`P${i}`)).toBe(s.manifest.probes_per_type);
        expect(counts.get("P1-control")).toBe(s.manifest.probes_per_type);
    });

    test("SIM-P06: each probe turn comes after every conveyance and update of its fact", () => {
        for (const p of s.probes) {
            if (!p.text || p.type === "P1-control") continue;
            const probeTurn = all.find((t) => t.probe === p.id);
            const cues = s.events.filter((e) => e.fact === p.fact && e.role !== "probe");
            expect(cues.length).toBeGreaterThan(0);
            for (const c of cues) {
                expect(order.get(c.id) ?? Infinity).toBeLessThan(
                    order.get(probeTurn?.id ?? "") ?? -1,
                );
                expect(c.scenario_ms as number).toBeLessThanOrEqual(probeTurn?.scenario_ms ?? -1);
            }
        }
    });

    test("a P1 control asks the same task before its fact is conveyed", () => {
        for (const c of s.probes.filter((p) => p.type === "P1-control")) {
            const p1 = s.probes.find((p) => p.type === "P1" && p.fact === c.fact);
            expect(c.text).toBe(p1?.text ?? "missing");
            expect(s.sessions.find((x) => x.id === c.session)?.project).toBe(
                p1?.project ?? "missing",
            );
            const first = s.events.findIndex((e) => e.fact === c.fact && e.role !== "probe");
            expect(order.get(c.event ?? "") ?? Infinity).toBeLessThan(first);
        }
    });

    test("a scoped update and a reversal follow their first statement", () => {
        for (const f of s.facts) {
            const own = all.filter((t) => t.fact === f.id && t.role !== "probe");
            const roles = own.map((t) => t.role);
            if (f.kind === "scoped_update") expect(roles.at(-1)).toBe("update");
            if (f.manner === "stated_then_reversed") {
                expect(roles[0]).toBe("reversal");
                expect(own[0]?.text).not.toContain(f.statement);
                expect(own.at(-1)?.text).toContain(f.statement);
            }
        }
    });

    test("only rejected facts take the rejected-approach wording", () => {
        for (const f of s.facts)
            if (f.manner === "rejected_approach") expect(f.kind).toBe("rejected");
    });

    test("each P13 probe follows its conveyance by at least ten user turns", () => {
        for (const p of s.probes.filter((x) => x.type === "P13")) {
            const probe = all.find((t) => t.probe === p.id) as TurnEvent;
            const cue = all.find((t) => t.fact === p.fact && t.role === "conveyance") as TurnEvent;
            expect(probe.session).toBe(cue.session);
            expect(probe.index - cue.index).toBeGreaterThanOrEqual(10);
        }
    });

    test("no two live facts of one template and project share a probe window", () => {
        const live = new Map<string, { fact: string; until: number }>();
        for (const e of s.events) {
            const fact = s.facts.find((f) => f.id === e.fact);
            if (!fact || e.role === "probe") continue;
            const key = `${fact.project}/${fact.template}`;
            const prev = live.get(key);
            if (prev && prev.fact !== fact.id)
                expect(order.get(e.id) ?? 0).toBeGreaterThan(prev.until);
            const ends = s.probes
                .filter((p) => p.fact === fact.id && p.event)
                .map((p) => order.get(p.event ?? "") ?? 0);
            live.set(key, { fact: fact.id, until: Math.max(...ends) });
        }
    });

    test("P4 items split evenly inside and outside the update's scope in both languages", () => {
        const p4 = s.probes.filter((p) => p.type === "P4");
        const must = (p: (typeof p4)[number]) => (p.check as { must?: string[] }).must?.[0];
        const scopes = new Set(p4.map((p) => `${p.project}/${must(p)}`));
        expect(scopes.size).toBeGreaterThanOrEqual(4);
        const outs = p4.filter((p) => {
            const tpl = input.bank[s.projects.find((x) => x.id === p.project)?.lang ?? ""];
            const scoped = (tpl?.scoped_update ?? []) as Template[];
            return scoped.some((t) => (t.out_check as { must?: string[] })?.must?.[0] === must(p));
        });
        expect(Math.abs(2 * outs.length - p4.length)).toBeLessThanOrEqual(1);
    });

    test("each P6 item opens a session that follows at least one hour of idle time", () => {
        for (const p of s.probes.filter((x) => x.type === "P6")) {
            const t = all.find((x) => x.probe === p.id) as TurnEvent;
            expect(t.index).toBe(0);
            const i = s.sessions.findIndex((x) => x.id === t.session);
            const start = s.events.find(
                (e) => e.kind === "session_start" && e.session === t.session,
            );
            const prevEnd = s.events.find(
                (e) => e.kind === "session_end" && e.session === s.sessions[i - 1]?.id,
            );
            expect(
                (start?.scenario_ms as number) - (prevEnd?.scenario_ms as number),
            ).toBeGreaterThanOrEqual(3_600_000);
        }
    });

    test("SIM-P08: every cue/probe pair is journaled below both thresholds", () => {
        const expected = s.probes
            .filter((p) => p.text)
            .reduce((n, p) => n + (s.facts.find((f) => f.id === p.fact)?.cues.length ?? 0), 0);
        expect(s.similarity.length).toBe(expected);
        const t = s.manifest.cue_probe_similarity;
        for (const x of s.similarity) {
            expect(x.bm25).toBeLessThanOrEqual(Number(t.bm25_max));
            expect(x.cosine).toBeLessThanOrEqual(Number(t.cosine_max));
        }
    });

    test("SIM-P07: no delivered user text, diff path, or diff content carries a marker", () => {
        const keys = [...s.facts.flatMap((f) => [f.id, f.template]), ...s.probes.map((p) => p.id)];
        const diffs = s.events.filter((e) => e.kind === "apply_diff") as unknown as {
            id: string;
            path: string;
            content: string;
        }[];
        expect(diffs.length).toBeGreaterThan(0);
        const delivered = [
            ...all.map((t) => ({ id: t.id, text: t.text })),
            ...diffs.map((d) => ({ id: d.id, text: `${d.path}\n${d.content}` })),
        ];
        for (const t of delivered)
            expect({ id: t.id, hits: markerHits(t.text, keys) }).toEqual({ id: t.id, hits: [] });
    });

    test("scenario time is monotone and sessions do not overlap", () => {
        for (const [i, e] of s.events.entries()) {
            if (i > 0)
                expect(e.scenario_ms as number).toBeGreaterThanOrEqual(
                    s.events[i - 1]?.scenario_ms as number,
                );
        }
        const ends = s.events
            .filter((e) => e.kind === "session_end")
            .map((e) => e.scenario_ms as number);
        for (const [i, x] of s.sessions.slice(1).entries())
            expect(x.start_ms).toBeGreaterThan(ends[i] ?? Infinity);
    });

    test("paste turns name a corpus sample and carry its exact bytes", () => {
        const pastes = all.filter((t) => t.role === "paste");
        expect(pastes.length).toBeGreaterThan(0);
        for (const t of pastes) {
            const sample = input.pastes.find((p) => p.id === t.paste?.sample_id);
            expect(t.text).toContain(sample?.content ?? "missing");
            expect(t.paste?.bytes).toBe(Buffer.byteLength(sample?.content ?? ""));
        }
    });
});

describe("over 100 seeds", () => {
    test("SIM-P09 holds for every scenario and the manner mix stays within 5 pp of the weights", async () => {
        const counts = new Map<Manner, number>();
        let total = 0;
        for (let seed = 0; seed < 100; seed++) {
            const input = inputS(seed);
            const s = await compileScenario(input);
            const forced = s.sessions.filter((x) => x.forced_p90);
            expect(forced.length).toBeGreaterThanOrEqual(input.prereg.scenario.forced_p90_sessions);
            for (const x of forced) expect(x.requests).toBeGreaterThanOrEqual(p90Of(input));
            for (const f of s.facts) counts.set(f.manner, (counts.get(f.manner) ?? 0) + 1);
            total += s.facts.length;
        }
        for (const [m, w] of Object.entries(MANNER_WEIGHTS)) {
            expect(Math.abs((counts.get(m as Manner) ?? 0) / total - w)).toBeLessThan(0.05);
        }
    }, 120_000);

    test("mannerQuota rounds each weight to within one item", () => {
        for (const total of [1, 7, 66, 220, 331]) {
            const quota = mannerQuota(total);
            expect(quota).toHaveLength(total);
            for (const [m, w] of Object.entries(MANNER_WEIGHTS)) {
                expect(Math.abs(quota.filter((q) => q === m).length - w * total)).toBeLessThan(1);
            }
        }
    });
});

describe("markerHits", () => {
    test.each([
        "P7",
        "P14",
        "probe",
        "Probes",
        "grading",
        "rubric",
        "scored",
        "f-0003",
        "rs-cmd-error-tag",
    ])("flags %s", (word) => {
        expect(
            markerHits(`text ${word} text`, ["f-0003", "rs-cmd-error-tag"]).length,
        ).toBeGreaterThan(0);
    });
    test.each(["P15", "approve", "proben", "P0", "f-0004"])("passes %s", (word) => {
        expect(markerHits(`text ${word} text`, ["f-0003"])).toEqual([]);
    });
});

describe("compile-time refusals", () => {
    const withInput = (edit: (bank: Bank) => void, embedder: Embedder = hashEmbedder) => {
        const input = loadCompileInput(101, "S", embedder, true);
        const bank = structuredClone(input.bank);
        edit(bank);
        return compileScenario({ ...input, bank });
    };
    const lookups = (bank: Bank) => (bank.any?.lookup ?? []) as Template[];

    test("a probe that shares its cue's wording is refused on the BM25 ratio alone", async () => {
        const orthogonal: Embedder = {
            model: "orthogonal",
            embed: async (texts) => texts.map((_, i) => texts.map((__, j) => (i === j ? 1 : 0))),
        };
        await expect(
            withInput((bank) => {
                for (const t of lookups(bank)) t.probe = `${t.statement}, for the record`;
            }, orthogonal),
        ).rejects.toThrow(/bm25 1, cosine 0 exceeds/);
    });

    test("a probe whose embedding matches its cue is refused on the cosine alone", async () => {
        const same: Embedder = { model: "same", embed: async (texts) => texts.map(() => [1, 0]) };
        await expect(withInput(() => undefined, same)).rejects.toThrow(/cosine 1 exceeds/);
    });

    test("a template whose user text announces the probe is refused", async () => {
        await expect(
            withInput((bank) => {
                for (const t of lookups(bank))
                    t.probe = `This probe checks the deploy target. ${t.probe}`;
            }),
        ).rejects.toThrow(/delivered text carries markers probe/);
    });

    test("a diff whose content carries a ledger key is refused", async () => {
        await expect(
            withInput((bank) => {
                for (const t of (bank.rust?.constraint ?? []) as Template[])
                    t.example = `// ${t.id}`;
                for (const t of (bank.typescript?.constraint ?? []) as Template[])
                    t.example = `// ${t.id}`;
            }),
        ).rejects.toThrow(/diff .* delivered text carries markers/);
    });

    test("a template carrying its own ledger key is refused", async () => {
        await expect(
            withInput((bank) => {
                for (const t of lookups(bank)) t.probe = `${t.probe} (${t.id})`;
            }),
        ).rejects.toThrow(/delivered text carries markers lookup-/);
    });
});

describe("between-session gaps", () => {
    test("sessions keep their sampled gaps after placement extends earlier sessions", async () => {
        const s = await compileScenario(inputS(101));
        const end = new Map(
            s.events
                .filter((e) => e.kind === "session_end")
                .map((e) => [e.session as string, e.scenario_ms as number]),
        );
        const gaps = s.sessions
            .slice(1)
            .map((x, i) => x.start_ms - (end.get(s.sessions[i]?.id ?? "") ?? 0));
        expect(gaps.filter((g) => g <= 1).length).toBeLessThan(0.05 * gaps.length);
        const sorted = [...gaps].sort((a, b) => a - b);
        expect(sorted[Math.floor(sorted.length / 2)] ?? 0).toBeGreaterThan(1_000);
    });
});

const PROVIDER = [
    "provider_429",
    "provider_5xx",
    "provider_timeout",
    "truncated_length",
    "truncated_no_length",
    "empty_content",
    "schema_wrong_tool_call",
    "slow_stream",
];
const INFRA = [
    "daemon_sigkill_mid_fold",
    "daemon_restart",
    "store_full",
    "plugin_reload",
    "model_switch",
    "laptop_sleep",
];
const SPEC_FAULTS: Record<string, string[]> = {
    S: ["provider_429"],
    M: PROVIDER,
    L: [...PROVIDER, ...INFRA],
    XL: [...PROVIDER, ...INFRA, "host_upgrade", "two_hosts_one_daemon"],
};
const PARAMS: Record<string, Record<string, number>> = {
    single: { count: 1 },
    burst: { count: 3 },
    intermittent: { probability: 0.3, calls: 10 },
    persistent: {},
};

describe("fault schedule", () => {
    const episode = (trigger: unknown): FaultEpisode =>
        ({
            id: "fault-x",
            type: "provider_429",
            strategy: "single",
            trigger,
            params: { count: 1 },
            seam: SEAMS.provider_429,
        }) as FaultEpisode;
    const sessions = new Map([["s-0000", 4]]);

    test("a fault keyed on an agent-produced count is refused", () => {
        const agentCount = episode({ kind: "tool_call", session: "s-0000", n: 3 });
        expect(() => validateFault(agentCount, sessions)).toThrow(/not a compiler-owned event/);
    });

    test("a fault past the last turn, on an unknown session, or with an altered seam is refused", () => {
        const late = episode({ kind: "user_turn", session: "s-0000", n: 5 });
        expect(() => validateFault(late, sessions)).toThrow(/outside the session's 4 turns/);
        const zero = episode({ kind: "user_turn", session: "s-0000", n: 0 });
        expect(() => validateFault(zero, sessions)).toThrow(/outside the session's 4 turns/);
        const lost = episode({ kind: "session_start", session: "s-9999" });
        expect(() => validateFault(lost, sessions)).toThrow(/unknown session/);
        const good = episode({ kind: "user_turn", session: "s-0000", n: 2 });
        const altered = { ...good, seam: { ...SEAMS.provider_429, oracle: "none" } };
        expect(() => validateFault(altered, sessions)).toThrow(/seam entry missing or altered/);
        const unknownType = {
            ...good,
            type: "provider_418",
            seam: undefined,
        } as unknown as FaultEpisode;
        expect(() => validateFault(unknownType, sessions)).toThrow(/seam entry missing or altered/);
        const copied = JSON.parse(JSON.stringify(good)) as FaultEpisode;
        expect(() => validateFault(copied, sessions)).not.toThrow();
    });

    test("a session list too small for the tier's faults is refused by name", () => {
        const session = (id: string, requests: number, gap_before_ms = 1000): FaultSession => ({
            id,
            requests,
            forced_p90: false,
            has_diff: false,
            gap_before_ms,
        });
        const few = [session("s-0000", 3), session("s-0001", 3), session("s-0002", 1)];
        expect(() => scheduleFaults("M", few, new Rng(1))).toThrow(
            /8 provider faults need 8 sessions with two or more turns; 2 available/,
        );
        const noP90 = Array.from({ length: 9 }, (_, i) => session(`s-${i}`, 3));
        expect(() => scheduleFaults("L", noP90, new Rng(1))).toThrow(/no forced p90 session/);
        const allDiffs = noP90.map((x, i) => ({ ...x, forced_p90: i === 1, has_diff: i > 0 }));
        expect(() => scheduleFaults("L", allDiffs, new Rng(1))).toThrow(
            /no session starts without a hand-applied diff/,
        );
    });

    test("every seam entry names its layer, outcomes, in-flight fate, surviving state, and oracle", () => {
        expect(Object.keys(SEAMS).sort()).toEqual(
            [...PROVIDER, ...INFRA, "host_upgrade", "two_hosts_one_daemon"].sort(),
        );
        for (const seam of Object.values(SEAMS)) {
            expect(seam.legal_outcomes.length).toBeGreaterThan(0);
            for (const field of [seam.in_flight_fate, seam.surviving_state, seam.oracle])
                expect(field.length).toBeGreaterThan(5);
        }
        for (const t of PROVIDER) expect(SEAMS[t as keyof typeof SEAMS].layer).toBe("proxy-sink");
    });

    for (const tier of TIERS)
        test(`tier ${tier} schedules the spec's fault types once each on compiler-owned events`, async () => {
            const s = await compileScenario(loadCompileInput(1, tier, hashEmbedder, true));
            expect(s.faults.map((f) => f.type as string)).toEqual(SPEC_FAULTS[tier] ?? []);
            const sessions = new Map(s.sessions.map((x) => [x.id, x]));
            const providerSessions = new Set<string>();
            for (const f of s.faults) {
                const session = sessions.get(f.trigger.session);
                expect(session).toBeDefined();
                if (PROVIDER.includes(f.type)) {
                    expect(f.trigger.kind).toBe("user_turn");
                    const n = f.trigger.kind === "user_turn" ? f.trigger.n : 0;
                    expect(n >= 1 && n <= (session?.requests ?? 0)).toBe(true);
                    expect(f.params).toEqual(PARAMS[f.strategy] ?? {});
                    providerSessions.add(f.trigger.session);
                } else if (f.type === "daemon_sigkill_mid_fold") {
                    expect(f.trigger.kind).toBe("first_summarizer_call");
                    expect(session?.forced_p90).toBe(true);
                } else {
                    expect(f.trigger.kind).toBe("session_start");
                    expect(f.trigger.session).not.toBe(s.sessions[0]?.id);
                }
                if (f.type === "laptop_sleep")
                    expect(f.params).toEqual({ duration_ms: session?.gap_before_ms ?? -1 });
                if (f.type === "store_full")
                    expect([f.strategy, f.params]).toEqual(["persistent", { sessions: 1 }]);
            }
            expect(providerSessions.size).toBe(
                s.faults.filter((f) => PROVIDER.includes(f.type)).length,
            );
        }, 60_000);

    for (const seed of [300, 301])
        test(`the laptop sleep spans an event-free gap of its full duration (seed ${seed})`, async () => {
            const s = await compileScenario(loadCompileInput(seed, "L", hashEmbedder, true));
            const sleep = s.faults.find((f) => f.type === "laptop_sleep") as FaultEpisode;
            const start = s.events.findIndex(
                (e) => e.kind === "session_start" && e.session === sleep.trigger.session,
            );
            const before = s.events[start - 1] as unknown as { kind: string; scenario_ms: number };
            expect(before.kind).toBe("session_end");
            const at = s.events[start]?.scenario_ms as number;
            expect(at - before.scenario_ms).toBe(sleep.params.duration_ms ?? -1);
            expect(sleep.params.duration_ms ?? 0).toBeGreaterThan(0);
        }, 60_000);

    test("provider faults use every strategy across seeds", async () => {
        const strategies = new Set<string>();
        for (let seed = 0; seed < 6; seed++) {
            const s = await compileScenario(loadCompileInput(seed, "M", hashEmbedder, true));
            for (const f of s.faults) if (PROVIDER.includes(f.type)) strategies.add(f.strategy);
        }
        expect([...strategies].sort()).toEqual(["burst", "intermittent", "persistent", "single"]);
    }, 60_000);
});

describe("counterfactual deletions", () => {
    test("L deletes before a seeded 20% sample of distinct P1, P3, and P5 probes", async () => {
        const [a, b] = await Promise.all(
            [301, 302].map((seed) =>
                compileScenario(loadCompileInput(seed, "L", hashEmbedder, true)),
            ),
        );
        for (const l of [a, b]) {
            const eligible = (l?.probes ?? []).filter((p) => ["P1", "P3", "P5"].includes(p.type));
            const cf = l?.cf_deletions ?? [];
            expect(cf).toHaveLength(Math.round(0.2 * eligible.length));
            expect(new Set(cf.map((d) => d.probe)).size).toBe(cf.length);
            expect(cf.map((d) => d.probe)).not.toEqual(
                eligible.slice(0, cf.length).map((p) => p.id),
            );
            for (const d of cf) {
                const probe = eligible.find((p) => p.id === d.probe);
                expect(d.before_event).toMatch(/^e-\d{6}$/);
                expect(d.before_event as string).toBe(probe?.event as string);
                expect(d.fact as string).toBe(probe?.fact as string);
            }
        }
        expect(a?.cf_deletions.map((d) => d.probe)).not.toEqual(
            b?.cf_deletions.map((d) => d.probe),
        );
    }, 60_000);

    test("tiers without the eidnara-cf arm schedule no deletions", async () => {
        for (const tier of ["S", "M", "XL"] as const) {
            const s = await compileScenario(loadCompileInput(2, tier, hashEmbedder, true));
            expect(s.cf_deletions).toEqual([]);
        }
    }, 60_000);
});
