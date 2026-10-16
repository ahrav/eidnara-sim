import { describe, expect, test } from "bun:test";
import {
    appendFileSync,
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    shuffle,
    streams,
    type Template,
} from "./compile";
import {
    type FaultEpisode,
    type FaultSession,
    SEAMS,
    scheduleFaults,
    validateFault,
} from "./faults";
import { CONSUMED_FILES, langOf, loadCompileInput, loadPrereg, verifyCorpus } from "./inputs";
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
        }, 180_000);
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
        const outOf = (p: (typeof p4)[number]) => {
            const lang = s.projects.find((x) => x.id === p.project)?.lang ?? "";
            const [tpl] = (input.bank[lang]?.scoped_update ?? []) as Template[];
            return JSON.stringify(p.check) === JSON.stringify(tpl?.out_check);
        };
        const scopes = new Set(p4.map((p) => `${p.project}/${outOf(p)}`));
        expect(scopes.size).toBeGreaterThanOrEqual(4);
        const outs = p4.filter(outOf);
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

    test("a hand-applied constraint diff sits inside the scope its statement names", () => {
        const diffs = s.events.filter((e) => e.kind === "apply_diff") as unknown as {
            fact: string;
            path: string;
        }[];
        const checked = s.facts.filter(
            (f) => f.kind === "constraint" && f.manner === "hand_applied_diff",
        );
        expect(checked.length).toBeGreaterThan(0);
        for (const f of checked) {
            const scope = /\b((?:src|tests?)\/[\w./-]*)/.exec(f.statement)?.[1] ?? "";
            const path = diffs.find((d) => d.fact === f.id)?.path ?? "";
            const expected = /\.[a-z]+$/.test(scope) ? "notes/" : `${scope.replace(/\/$/, "")}/`;
            expect({ fact: f.id, path: path.slice(0, expected.length) }).toEqual({
                fact: f.id,
                path: expected,
            });
        }
    });

    test("P14 items in one session take disjoint windows inside its last third", () => {
        const bySession = new Map<string, { from: number; to: number }[]>();
        for (const p of s.probes.filter((x) => x.type === "P14")) {
            const c = p.check as { window_from_turn: number; window_to_turn: number };
            const list = bySession.get(p.session) ?? [];
            list.push({ from: c.window_from_turn, to: c.window_to_turn });
            bySession.set(p.session, list);
        }
        for (const [session, windows] of bySession) {
            const turns = s.sessions.find((x) => x.id === session)?.requests ?? 0;
            windows.sort((a, b) => a.from - b.from);
            expect(windows[0]?.from).toBe(Math.floor((2 * turns) / 3));
            expect(windows.at(-1)?.to).toBe(turns);
            for (const [i, w] of windows.entries()) {
                expect(w.to - w.from).toBeGreaterThanOrEqual(10);
                if (i > 0) expect(w.from).toBe(windows[i - 1]?.to ?? -1);
            }
        }
    });

    test("a reversed fact forbids its superseded value beside the final one", () => {
        const reversed = s.facts.filter((f) => f.manner === "stated_then_reversed");
        expect(reversed.length).toBeGreaterThan(0);
        for (const f of reversed) {
            for (const p of s.probes.filter((x) => x.fact === f.id && x.text)) {
                const c = p.check as { must?: string[]; must_not?: string[] };
                const harm = p.type === "P2" || p.type === "P11" || p.type === "P10";
                if (!harm && !c.must_not?.length) continue;
                const forbidden = c.must_not ?? [];
                const need = harm ? 2 : 1;
                expect({ probe: p.type, count: forbidden.length }).toEqual({
                    probe: p.type,
                    count: forbidden.length >= need ? forbidden.length : need,
                });
                expect(new Set(forbidden).size).toBe(forbidden.length);
            }
        }
    });

    test("a reversed fact forbids its superseded value in every channel its check uses", () => {
        for (const f of s.facts.filter((x) => x.manner === "stated_then_reversed")) {
            for (const p of s.probes.filter((x) => x.fact === f.id && x.text)) {
                const c = p.check as Record<string, string[] | undefined>;
                const positive = Object.keys(c).filter(
                    (k) => k.endsWith("must") && f.kind !== "decision",
                );
                for (const key of positive) {
                    expect({ probe: p.type, key, forbids: (c[`${key}_not`] ?? []).length }).toEqual(
                        {
                            probe: p.type,
                            key,
                            forbids:
                                (c[`${key}_not`] ?? []).length > 0
                                    ? (c[`${key}_not`] ?? []).length
                                    : 1,
                        },
                    );
                }
                if (c.answer_must_not) expect(c.answer_must_not.length).toBe(2);
            }
        }
    });

    test("a check never forbids a pattern it requires", () => {
        for (const p of s.probes) {
            const c = p.check as Record<string, string[] | undefined>;
            for (const key of Object.keys(c).filter((k) => k.endsWith("must"))) {
                const forbidden = new Set(c[`${key}_not`] ?? []);
                for (const pattern of c[key] ?? []) {
                    expect({
                        probe: p.id,
                        key,
                        pattern,
                        forbidden: forbidden.has(pattern),
                    }).toEqual({
                        probe: p.id,
                        key,
                        pattern,
                        forbidden: false,
                    });
                }
            }
        }
    });

    test("SIM-P08: an authoritative P3 diff is scored against its fact's probes", () => {
        const diffs = s.events.filter((e) => e.kind === "apply_diff") as unknown as {
            fact: string;
            content: string;
        }[];
        for (const f of s.facts.filter((x) => x.kind === "decision")) {
            const authority = diffs.find((d) => d.fact === f.id && !f.cues.includes(d.content));
            expect(authority).toBeDefined();
            for (const p of s.probes.filter((x) => x.fact === f.id && x.text)) {
                const scored = s.similarity.filter((x) => x.probe === p.id);
                expect(scored.length).toBe(f.cues.length + 1);
            }
        }
    });

    test("SIM-P08: every cue/probe pair is journaled below both thresholds", () => {
        const authorities = s.events.filter(
            (e) =>
                e.kind === "apply_diff" &&
                e.role === undefined &&
                s.facts.find((f) => f.id === e.fact)?.cues.includes(e.content as string) === false,
        ).length;
        const expected = s.probes
            .filter((p) => p.text)
            .reduce((n, p) => {
                const fact = s.facts.find((f) => f.id === p.fact);
                const authority = fact?.kind === "decision" ? 1 : 0;
                return n + (fact?.cues.length ?? 0) + authority;
            }, 0);
        expect(authorities).toBeGreaterThan(0);
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
            const perProject = new Map<string, number>();
            for (const x of forced) perProject.set(x.project, (perProject.get(x.project) ?? 0) + 1);
            const bases = input.projects.filter((p) => !p.twin_of).length;
            expect(perProject.size).toBe(Math.min(bases, forced.length));
            expect(
                Math.max(...perProject.values()) - Math.min(...perProject.values()),
            ).toBeLessThanOrEqual(1);
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

describe("corpus identity", () => {
    test("corpus/manifest.json digests every corpus file the compiler reads", () => {
        const manifest = JSON.parse(readFileSync(join(ROOT, "corpus", "manifest.json"), "utf8"));
        expect(Object.keys(manifest.files).sort()).toEqual(
            [
                "distributions.json",
                "fact-bank.json",
                "repos.json",
                "tool-outputs/error-codes.jsonl",
                "tool-outputs/samples.jsonl",
            ].sort(),
        );
    });
});

describe("fact bank checks", () => {
    const bank = inputS(101).bank;
    const templates = (kind: string) =>
        Object.values(bank).flatMap((k) =>
            (typeof k === "object" ? ((k[kind] ?? []) as (Template | string)[]) : []).filter(
                (t): t is Template => typeof t === "object",
            ),
        );

    test("a filename convention is graded on changed paths, not added lines", () => {
        const t = templates("constraint").find((x) => x.id === "ts-test-name");
        expect(Object.keys(t?.check ?? {})).toEqual(["paths_must"]);
    });

    test("the module-level Map rule matches typed and let declarations and leaves WeakMap alone", () => {
        const t = templates("rejected").find((x) => x.id === "ts-no-module-map");
        const re = new RegExp((t?.check as { must_not: string[] }).must_not[0] ?? "$^", "m");
        for (const line of [
            "const cache = new Map()",
            "const cache = new Map<string, Handler>()",
            "let cache: Map<string, Handler> = new Map()",
        ])
            expect({ line, hit: re.test(line) }).toEqual({ line, hit: true });
        expect(re.test("const size = cache.size")).toBe(false);
    });

    test("the commit-tag rule requires the tag at the start of the message", () => {
        const t = templates("session_rule").find((x) => x.id === "session-commit-tag");
        const pattern = (t?.check as { commands_must: string[] }).commands_must[0] ?? "$^";
        const re = new RegExp(pattern.replaceAll("{token}", "quiet_vole"));
        expect(re.test("git commit -m '[quiet_vole] implement cap'")).toBe(true);
        expect(re.test('git commit -am "[quiet_vole] implement cap"')).toBe(true);
        expect(re.test("git commit --message='[quiet_vole] implement cap'")).toBe(true);
        expect(re.test("git commit -m 'implement cap [quiet_vole]'")).toBe(false);
    });

    test("every check pattern compiles as a JavaScript regular expression", () => {
        const vars = {
            token: "quiet_vole",
            TOKEN: "QUIET_VOLE",
            value: "12345",
            value2: "54321",
            codename: "brisk-otter-07",
            code: "ValueError",
            context: "x",
            code_re: "ValueError",
        };
        const render = (t: string) =>
            t.replace(/\{(\w+)\}/g, (_, k: string) => vars[k as keyof typeof vars] ?? "");
        for (const kind of [
            "constraint",
            "decision",
            "plan",
            "rationale",
            "rejected",
            "scoped_update",
            "lookup",
            "never_settled",
            "anchor",
            "tool_error",
            "session_rule",
        ]) {
            for (const t of templates(kind)) {
                for (const c of [t.check, t.out_check ?? {}]) {
                    for (const [key, v] of Object.entries(c)) {
                        if (!key.endsWith("must") && !key.endsWith("must_not")) continue;
                        for (const pattern of v as string[]) {
                            expect({
                                id: t.id,
                                key,
                                ok: (() => {
                                    try {
                                        new RegExp(render(pattern));
                                        return true;
                                    } catch {
                                        return false;
                                    }
                                })(),
                            }).toEqual({ id: t.id, key, ok: true });
                        }
                    }
                }
            }
        }
    });

    test("the file-header rule grades the first line of each new file from its start", () => {
        const t = templates("session_rule").find((x) => x.id === "session-file-header");
        expect(Object.keys(t?.check ?? {})).toEqual(["first_line_must"]);
        const re = new RegExp(
            ((t?.check as { first_line_must: string[] }).first_line_must[0] ?? "$^").replaceAll(
                "{token}",
                "quiet_vole",
            ),
        );
        expect(re.test("// quiet_vole")).toBe(true);
        expect(re.test("export const x = 1; // quiet_vole")).toBe(false);
    });

    test("the helper-prefix rule accepts underscores after the token", () => {
        const t = templates("constraint").find((x) => x.id === "ts-utils-prefix");
        const re = new RegExp(
            ((t?.check as { must: string[] }).must[0] ?? "$^").replaceAll("{token}", "quiet_vole"),
        );
        expect(re.test("function quiet_vole_strip_slash(path: string) {}")).toBe(true);
        expect(re.test("const quiet_voleClamp = (n: number) => n")).toBe(true);
    });

    test("the Proxy rule matches generic constructions", () => {
        const t = templates("rejected").find((x) => x.id === "ts-no-proxy");
        const re = new RegExp((t?.check as { must_not: string[] }).must_not[0] ?? "$^");
        expect(re.test("return new Proxy<Context>(target, handler)")).toBe(true);
        expect(re.test("return new Proxy (target, handler)")).toBe(true);
    });

    test("the commit-tag rule reads the first message option", () => {
        const t = templates("session_rule").find((x) => x.id === "session-commit-tag");
        const pattern = (t?.check as { commands_must: string[] }).commands_must[0] ?? "$^";
        const re = new RegExp(pattern.replaceAll("{token}", "quiet_vole"));
        expect(re.test('git commit -m "wrong" -m "[quiet_vole] later"')).toBe(false);
        expect(re.test('git commit -m "[quiet_vole] first" -m "body"')).toBe(true);
    });

    test("the quote-style rule is a structural check over string literals", () => {
        const t = templates("scoped_update").find((x) => x.id === "ts-scope-quotes");
        expect(t?.check).toEqual({ quote_style_must: "double" });
        expect(t?.out_check).toEqual({ quote_style_must: "single" });
    });

    test("tag and prefix conventions require the tag at the start of the string", () => {
        const re = (id: string) => {
            const t = templates("constraint").find((x) => x.id === id);
            return new RegExp(
                ((t?.check as { must: string[] }).must[0] ?? "$^").replaceAll(
                    "{token}",
                    "quiet_vole",
                ),
            );
        };
        expect(
            re("rs-cmd-error-tag").test('return Err("[quiet_vole] unknown subcommand".into());'),
        ).toBe(true);
        expect(re("rs-cmd-error-tag").test('return Err("failure [quiet_vole]".into());')).toBe(
            false,
        );
        expect(
            re("ts-error-tag").test("throw new Error('[quiet_vole] malformed expires attribute')"),
        ).toBe(true);
        expect(re("ts-error-tag").test("throw new Error(`[quiet_vole] malformed ${name}`)")).toBe(
            true,
        );
        expect(re("ts-error-tag").test("throw new Error('malformed [quiet_vole]')")).toBe(false);
        expect(
            re("ts-warn-prefix").test("console.warn('(quiet_vole) duplicate route registered')"),
        ).toBe(true);
        expect(re("ts-warn-prefix").test("console.warn('duplicate route (quiet_vole)')")).toBe(
            false,
        );
    });

    test("the commit-tag rule accepts the attached short option form", () => {
        const t = templates("session_rule").find((x) => x.id === "session-commit-tag");
        const pattern = (t?.check as { commands_must: string[] }).commands_must[0] ?? "$^";
        const re = new RegExp(pattern.replaceAll("{token}", "quiet_vole"));
        expect(re.test('git commit -m"[quiet_vole] implement cap"')).toBe(true);
        expect(re.test("git commit -m[quiet_vole]")).toBe(true);
        expect(re.test("git commit --message[quiet_vole]")).toBe(false);
        expect(re.test('git commit --dry-run -m "[quiet_vole] cap"')).toBe(false);
        expect(re.test('git commit -m "[quiet_vole] cap" --dry-run')).toBe(false);
        expect(re.test("git commit --message=[quiet_vole] cap")).toBe(true);
        expect(re.test("git commit -mwrong -m[quiet_vole]")).toBe(false);
        expect(re.test('git commit -m "wrong" -m"[quiet_vole] later"')).toBe(false);
    });

    test("grading patterns bind to identifiers and admit equivalent forms", () => {
        const must = (kind: string, id: string, key = "must", out = false) => {
            const t = templates(kind).find((x) => x.id === id);
            const c = (out ? t?.out_check : t?.check) as Record<string, string[]>;
            return new RegExp(
                (c[key]?.[0] ?? "$^")
                    .replaceAll("{TOKEN}", "QUIET_VOLE")
                    .replaceAll("{code_re}", "ValueError"),
            );
        };
        expect(
            must("constraint", "rs-cmd-const-prefix").test(
                "pub const QUIET_VOLE_MAX_KEYS: usize = 4;",
            ),
        ).toBe(true);
        expect(
            must("constraint", "rs-cmd-const-prefix").test(
                "pub const DEFAULT_QUIET_VOLE_MAX_KEYS: usize = 4;",
            ),
        ).toBe(false);
        expect(
            must("constraint", "ts-const-prefix").test("export const DEFAULT_QUIET_VOLE_X = 1"),
        ).toBe(false);
        expect(
            must("tool_error", "error-recurred").test("Fix the ValueError raised by parse()"),
        ).toBe(true);
        expect(must("tool_error", "error-recurred").test("Fix the NotAValueErrorsWrapper")).toBe(
            false,
        );
        expect(
            must("scoped_update", "rs-scope-log-level").test(
                "tracing::event!(tracing::Level::TRACE, command = %name);",
            ),
        ).toBe(true);
        expect(
            must("scoped_update", "rs-scope-log-level", "must", true).test(
                'tracing::event!(Level::DEBUG, "bound");',
            ),
        ).toBe(true);
        const mutex = new RegExp(
            (
                templates("rejected").find((x) => x.id === "rs-no-global-mutex")?.check as {
                    must_not: string[];
                }
            ).must_not[0] ?? "$^",
        );
        expect(
            mutex.test("static STORE: Mutex<HashMap<String, Bytes>> = Mutex::new(HashMap::new());"),
        ).toBe(true);
        expect(
            mutex.test(
                "static KEY_LOCKS: OnceLock<DashMap<String, Arc<Mutex<()>>>> = OnceLock::new();",
            ),
        ).toBe(false);
        const map = new RegExp(
            (
                templates("rejected").find((x) => x.id === "ts-no-module-map")?.check as {
                    must_not: string[];
                }
            ).must_not[0] ?? "$^",
            "m",
        );
        expect(map.test("const cache = new WeakMap<App, Handler>()")).toBe(false);
        expect(map.test("const cache = new Map<string, Handler>()")).toBe(true);
    });

    test("every anchor forbids its value in the diff and in the final answer", () => {
        for (const t of templates("anchor")) {
            expect({ id: t.id, keys: Object.keys(t.check).sort() }).toEqual({
                id: t.id,
                keys: ["answer_must_not", "must_not"],
            });
        }
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

    test("an embedder that returns empty or short vectors is refused", async () => {
        const empty: Embedder = { model: "empty", embed: async (texts) => texts.map(() => []) };
        await expect(withInput(() => undefined, empty)).rejects.toThrow(/embedder empty returned/);
        const short: Embedder = {
            model: "short",
            embed: async (texts) => texts.slice(1).map(() => [1, 0]),
        };
        await expect(withInput(() => undefined, short)).rejects.toThrow(/embedder short returned/);
    });

    test("a forced p90 quota above a project's sessions is refused", async () => {
        const input = loadCompileInput(101, "S", hashEmbedder, true);
        const prereg = structuredClone(input.prereg);
        prereg.scenario.forced_p90_sessions = 50;
        await expect(compileScenario({ ...input, prereg })).rejects.toThrow(
            /forced_p90_sessions 50 exceeds/,
        );
    });

    test("an embedder whose vectors have no usable norm is refused", async () => {
        const zero: Embedder = { model: "zero", embed: async (texts) => texts.map(() => [0, 0]) };
        await expect(withInput(() => undefined, zero)).rejects.toThrow(/embedder zero returned/);
        const huge: Embedder = {
            model: "huge",
            embed: async (texts) => texts.map((_, i) => (i % 2 ? [1e200, 1e200] : [1, 0])),
        };
        await expect(withInput(() => undefined, huge)).rejects.toThrow(/embedder huge returned/);
    });

    test("a seed outside the unsigned 32-bit range is refused", async () => {
        const input = loadCompileInput(0, "S", hashEmbedder, true);
        await expect(compileScenario({ ...input, seed: 2 ** 32 })).rejects.toThrow(
            /seed 4294967296 is outside/,
        );
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

    test("a filler that carries a P14 item id is refused", async () => {
        await expect(
            withInput((bank) => {
                for (const lang of ["rust", "typescript"] as const) {
                    (bank[lang] as Record<string, string[]>).filler = ["Tidy the q-0084 helper."];
                }
            }),
        ).rejects.toThrow(/delivered text carries markers q-0084/);
    });

    test("a diff whose content carries a ledger key is refused", async () => {
        await expect(
            withInput((bank) => {
                for (const t of (bank.rust?.constraint ?? []) as Template[])
                    t.example = { path: "src/{token}.rs", content: `// ${t.id}` };
                for (const t of (bank.typescript?.constraint ?? []) as Template[])
                    t.example = { path: "src/{token}.ts", content: `// ${t.id}` };
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

describe("input loading", () => {
    test("a pre-registration whose tier differs from its filename is refused", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-prereg-"));
        const prereg = JSON.parse(readFileSync(join(ROOT, "prereg", "M.json"), "utf8"));
        writeFileSync(join(dir, "S.json"), JSON.stringify(prereg));
        expect(() => loadPrereg("S", dir)).toThrow(/prereg\/S\.json names tier M/);
    });

    test("a repository role outside the two known roles is refused", () => {
        expect(langOf("rust-service")).toBe("rust");
        expect(langOf("typescript-package")).toBe("typescript");
        expect(() => langOf("python-service")).toThrow(/role python-service/);
    });
});

describe("P4 scope across seeds", () => {
    test("the pooled in-scope and out-of-scope counts balance per language over the S seeds", async () => {
        const counts = new Map<string, number>();
        for (const seed of [101, 102]) {
            const input = inputS(seed);
            const s = await compileScenario(input);
            for (const p of s.probes.filter((x) => x.type === "P4")) {
                const lang = s.projects.find((x) => x.id === p.project)?.lang ?? "";
                const [tpl] = (input.bank[lang]?.scoped_update ?? []) as Template[];
                const out = JSON.stringify(p.check) === JSON.stringify(tpl?.out_check);
                const key = `${lang}/${out ? "out" : "in"}`;
                counts.set(key, (counts.get(key) ?? 0) + 1);
            }
        }
        for (const lang of ["rust", "typescript"]) {
            expect({ lang, in: counts.get(`${lang}/in`), out: counts.get(`${lang}/out`) }).toEqual({
                lang,
                in: 3,
                out: 3,
            });
        }
    });
});

describe("corpus verification", () => {
    test("a consumed corpus file whose bytes differ from the manifest digest is refused", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-corpus-"));
        for (const path of ["manifest.json", ...CONSUMED_FILES]) {
            mkdirSync(join(dir, dirname(path)), { recursive: true });
            copyFileSync(join(ROOT, "corpus", path), join(dir, path));
        }
        expect(() => verifyCorpus(dir)).not.toThrow();
        appendFileSync(join(dir, "fact-bank.json"), "\n");
        expect(() => verifyCorpus(dir)).toThrow(/corpus\/fact-bank\.json: sha256 .* differs/);
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
        const inherited = { ...good, type: "__proto__", seam: {} } as unknown as FaultEpisode;
        expect(() => validateFault(inherited, sessions)).toThrow(/seam entry missing or altered/);
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
        for (const [t, seam] of Object.entries(SEAMS)) {
            const layer = PROVIDER.includes(t)
                ? "proxy-sink"
                : t === "laptop_sleep"
                  ? "clock"
                  : "scheduler";
            expect([t, seam.layer]).toEqual([t, layer]);
        }
    });

    for (const tier of TIERS)
        test(`tier ${tier} schedules the spec's fault types once each on compiler-owned events`, async () => {
            const s = await compileScenario(loadCompileInput(1, tier, hashEmbedder, true));
            expect(s.faults.map((f) => f.type as string)).toEqual(SPEC_FAULTS[tier] ?? []);
            expect(s.faults.map((f) => f.id)).toEqual(
                s.faults.map((_, i) => `fault-${String(i).padStart(3, "0")}`),
            );
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
                else if (!PROVIDER.includes(f.type))
                    expect([f.type, f.strategy]).toEqual([f.type, "single"]);
            }
            expect(providerSessions.size).toBe(
                s.faults.filter((f) => PROVIDER.includes(f.type)).length,
            );
        }, 60_000);

    for (const seed of [314, 301])
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
            const diffAt = new Set(
                s.events.filter((e) => e.kind === "apply_diff").map((e) => e.scenario_ms),
            );
            const quiet = s.sessions.slice(1).filter((x) => !diffAt.has(x.start_ms));
            expect(sleep.params.duration_ms).toBe(Math.max(...quiet.map((x) => x.gap_before_ms)));
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
        for (const [seed, l] of [
            [301, a],
            [302, b],
        ] as const) {
            const eligible = (l?.probes ?? []).filter((p) => ["P1", "P3", "P5"].includes(p.type));
            const cf = l?.cf_deletions ?? [];
            expect(cf).toHaveLength(Math.round(0.2 * eligible.length));
            expect(new Set(cf.map((d) => d.probe)).size).toBe(cf.length);
            expect(cf.map((d) => d.probe)).not.toEqual(
                eligible.slice(0, cf.length).map((p) => p.id),
            );
            const recomputed = shuffle([...eligible], streams(seed)("counterfactual"))
                .slice(0, cf.length)
                .map((p) => p.id)
                .sort();
            expect(cf.map((d) => d.probe)).toEqual(recomputed);
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
