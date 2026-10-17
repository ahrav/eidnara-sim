import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, type SimConfig } from "../src/config/config";
import {
    AnswerRefused,
    assertArtefactsOnly,
    type CallView,
    GradeRefused,
    type Snapshot,
} from "../src/grade/artefacts";
import {
    BlindingRefused,
    gradeP7,
    type Judgment,
    judgePair,
    type P7Inputs,
    p7Pair,
    proxyJudge,
} from "../src/grade/judge";
import {
    deltaMem,
    GradeLog,
    type GradeRecord,
    gradeItem,
    verdictCounts,
} from "../src/grade/probes";
import { canonicalJson, sha256Hex } from "../src/prereg/canonical";
import { preregistrationHash } from "../src/prereg/validate";
import { bedrockUpstream, Gateway } from "../src/proxy/gateway";
import { FaultInjector } from "../src/proxy/inject";
import type { CallRecord } from "../src/proxy/records";
import { RecordWriter } from "../src/proxy/records";
import { Rng } from "../src/rng";
import {
    type Entry,
    keepCompleteLines,
    readJournal,
    releaseLease,
    takeLease,
} from "../src/run/journal";
import { projectCall } from "../src/run/run";
import type { Scenario } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";

export interface Summary {
    verdicts: Record<string, Record<string, number>>;
    /** Skipped item counts by arm, then by reason. */
    skipped: Record<string, Record<string, number>>;
    /** Each grade version maps to the number of aggregated grades carrying it. */
    versions: Record<string, number>;
    p11: Record<string, { n: number; weighted_score: number }>;
    p3: { arm: string; delta_mem: { delta: number; n: number } | null }[];
    judge_errors: number;
}

/**
 * `gradeRun` holds the run directory's lease while it grades, which serializes grade-version
 * allocation across invocations, and requires the pre-registration and scenario to hash to
 * the digests recorded in the manifest.
 */
export async function gradeRun(dir: string, config: SimConfig | null): Promise<Summary> {
    takeLease(dir);
    try {
        return await grade(dir, config);
    } finally {
        releaseLease(dir);
    }
}

function requireComplete(entries: Entry[], arms: string[], scheduled: string[]): void {
    const started = entries.find((e) => e.kind === "StartRun");
    const journaled = Array.isArray(started?.order) ? started.order : null;
    const malformed = arms.some((a) => typeof a !== "string") || new Set(arms).size !== arms.length;
    if (malformed || !journaled || JSON.stringify(journaled) !== JSON.stringify(arms)) {
        throw new Error(
            `manifest order ${JSON.stringify(arms)} differs from the journaled order ${JSON.stringify(journaled)}`,
        );
    }
    for (const arm of arms) {
        const mine = entries.filter((e) => e.arm === arm);
        const ended = mine.filter((e) => e.kind === "Event").map((e) => String(e.event));
        const closed = mine.some((e) => e.kind === "EndArm");
        const once = new Set(ended);
        const missing = scheduled.filter((id) => !once.has(id));
        const stray = ended.filter((id, i) => !scheduled.includes(id) || ended.indexOf(id) !== i);
        if (!closed || missing.length > 0 || stray.length > 0) {
            const marker = closed ? "EndArm present" : "no EndArm";
            const count = `${scheduled.length - missing.length} of ${scheduled.length} events ended`;
            const extra = stray.length > 0 ? `, unexpected or repeated: ${stray.join(", ")}` : "";
            throw new Error(`arm ${arm} is incomplete: ${count}, ${marker}${extra}`);
        }
    }
    if (!entries.some((e) => e.kind === "EndRun")) {
        throw new Error("run is incomplete: the journal has no EndRun");
    }
}

/** Yields a JSONL file's non-empty lines one at a time, so a log of large records costs one record of memory. */
async function* jsonlLines(path: string): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    const pending: string[] = [];
    for await (const chunk of Bun.file(path).stream()) {
        let piece = decoder.decode(chunk, { stream: true });
        for (let at = piece.indexOf("\n"); at !== -1; at = piece.indexOf("\n")) {
            pending.push(piece.slice(0, at));
            const line = pending.join("");
            pending.length = 0;
            if (line) yield line;
            piece = piece.slice(at + 1);
        }
        if (piece) pending.push(piece);
    }
    pending.push(decoder.decode());
    const rest = pending.join("");
    if (rest) yield rest;
}

async function grade(dir: string, config: SimConfig | null): Promise<Summary> {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
    const { scenario_hash: _recorded, ...body } = scenario;
    const digests = {
        prereg_sha256: preregistrationHash(loadPrereg(manifest.tier)),
        scenario_hash: sha256Hex(canonicalJson(body)),
    };
    const changed = Object.entries(digests).filter(([k, v]) => manifest[k] !== v);
    if (changed.length > 0) {
        const names = changed.map(([k]) => k).join(", ");
        throw new Error(`inputs differ from the run's manifest: ${names}`);
    }
    const rules = loadPrereg(manifest.tier).grading;
    const arms = manifest.order as string[];
    const models = manifest.models as string[];
    const entries = readJournal(join(dir, "journal.jsonl"));
    const scheduled = scenario.events.slice(0, manifest.events).map((e) => String(e.id));
    requireComplete(entries, arms, scheduled);
    const log = new GradeLog(join(dir, "grades.jsonl"));

    const named = new Map<string, { arm: string; item: string }>();
    const firstOf = new Set<string>();
    for (const e of entries.filter((e) => e.kind === "SnapshotArtefacts")) {
        const id = String(e.snapshot);
        const key = `${String(e.arm)}/${String(e.item)}`;
        if (named.has(id) || firstOf.has(key)) {
            throw new Error(`journal names more than one first snapshot for ${key} (${id})`);
        }
        named.set(id, { arm: String(e.arm), item: String(e.item) });
        firstOf.add(key);
    }
    const journaled = new Set(named.keys());
    const turnEnds = new Map<string, string>();
    for (const e of entries.filter((e) => e.kind === "EndTurn" && typeof e.snapshot === "string")) {
        turnEnds.set(String(e.snapshot), String(e.outcome));
    }
    const probes = new Map(scenario.probes.map((p) => [p.id, p]));
    const snapshots = new Map<string, Snapshot[]>();
    for (const arm of arms) {
        const path = join(dir, arm, "snapshots.jsonl");
        if (!existsSync(path)) continue;
        for await (const line of jsonlLines(path)) {
            const s = JSON.parse(line) as Snapshot;
            if (s.arm !== arm || !Array.isArray(s.artefacts) || s.artefacts.length === 0) {
                throw new Error(
                    `snapshot ${s.id} in ${arm}/snapshots.jsonl names arm ${s.arm} or has no artefacts`,
                );
            }
            assertArtefactsOnly(s);
            const entry = named.get(s.id);
            if (entry && (entry.arm !== arm || entry.item !== s.item)) {
                throw new Error(
                    `snapshot ${s.id} in ${arm}/snapshots.jsonl does not match its journal entry (${entry.arm}, ${entry.item})`,
                );
            }
            const probe = entry ? probes.get(s.item) : undefined;
            if (entry && probe) {
                const turnOk = probe.event === undefined || s.turn === probe.event;
                const sessionOk = s.session === probe.session;
                if (!turnOk || !sessionOk) {
                    throw new Error(
                        `snapshot ${s.id} is of turn ${s.turn} in session ${String(s.session)}, not the probe's event ${String(probe.event)} in session ${probe.session}`,
                    );
                }
                const ended = turnEnds.get(s.id);
                if (!ended) {
                    throw new Error(`snapshot ${s.id} has no EndTurn naming it in the journal`);
                }
                const expected = ended === "ok" ? "ok" : "failed";
                if (s.turn_outcome !== expected) {
                    throw new Error(
                        `snapshot ${s.id} records turn_outcome ${String(s.turn_outcome)}, but its EndTurn ended ${ended}`,
                    );
                }
            }
            const key = `${arm}/${s.item}`;
            const kept = entry ? s : { ...s, artefacts: [] };
            snapshots.set(key, [...(snapshots.get(key) ?? []), kept]);
        }
    }
    const occurrences = new Map<string, number>();
    for (const s of [...snapshots.values()].flat()) {
        occurrences.set(s.id, (occurrences.get(s.id) ?? 0) + 1);
    }
    const lost = [...named.keys()].filter((id) => !occurrences.has(id));
    if (lost.length > 0) {
        throw new Error(`journaled snapshots have no row in snapshots.jsonl: ${lost.join(", ")}`);
    }
    const doubled = [...named.keys()].filter((id) => (occurrences.get(id) ?? 0) > 1);
    if (doubled.length > 0) {
        throw new Error(
            `journaled snapshots have more than one row in snapshots.jsonl: ${doubled.join(", ")}`,
        );
    }
    const wanted = new Map<string, Array<{ snapshot: string; call: CallView }>>();
    for (const rows of snapshots.values()) {
        for (const s of rows) {
            if (!journaled.has(s.id)) continue;
            const calls = s.artefacts.find((a) => a.class === "proxy-call");
            if (calls?.class !== "proxy-call") continue;
            for (const c of calls.calls) {
                if (c.component === "agent")
                    wanted.set(`${s.arm}/${c.seq}`, [
                        ...(wanted.get(`${s.arm}/${c.seq}`) ?? []),
                        { snapshot: s.id, call: c },
                    ]);
            }
        }
    }
    const agentModels = new Set<string>();
    const callsPath = join(dir, "calls.jsonl");
    if (existsSync(callsPath)) {
        for await (const line of jsonlLines(callsPath)) {
            const r = JSON.parse(line) as CallRecord;
            if (r.component !== "agent") continue;
            if (typeof r.model !== "string" || typeof r.seq !== "number") {
                throw new Error(`calls.jsonl record ${String(r.seq)} names no model`);
            }
            agentModels.add(r.model);
            const copies = wanted.get(`${r.arm}/${r.seq}`);
            if (!copies) continue;
            const expected = canonicalJson(projectCall(r));
            for (const held of copies) {
                const { turn_index: _turn, ...stored } = held.call;
                if (canonicalJson(stored) !== expected) {
                    throw new Error(
                        `snapshot ${held.snapshot} holds agent call ${r.seq} with content that differs from calls.jsonl`,
                    );
                }
            }
            wanted.delete(`${r.arm}/${r.seq}`);
        }
    }
    const unrecorded = [...agentModels].filter((m) => !models.includes(m));
    if (unrecorded.length > 0) {
        throw new Error(
            `agent calls used models the manifest does not record: ${unrecorded.join(", ")}`,
        );
    }
    const [orphan] = wanted;
    if (orphan) {
        const [key, copies] = orphan;
        const snapshot = copies[0]?.snapshot ?? "?";
        throw new Error(
            `snapshot ${snapshot} holds agent call ${key.split("/").pop()}, which calls.jsonl does not record for arm ${key.split("/")[0]}`,
        );
    }
    const attempts = (arm: string, item: string): Snapshot[] | undefined => {
        const rows = snapshots.get(`${arm}/${item}`) ?? [];
        const first = rows.findIndex((s) => journaled.has(s.id));
        return first === -1 ? undefined : rows.slice(first);
    };
    const ran = new Set(
        scenario.events
            .slice(0, manifest.events)
            .map((e) => (e as { probe?: string }).probe)
            .filter(Boolean),
    );

    const graded: GradeRecord[] = [];
    const skipped: Summary["skipped"] = {};
    const skip = (arm: string, why: string) => {
        skipped[arm] ??= {};
        const mine = skipped[arm] as Record<string, number>;
        mine[why] = (mine[why] ?? 0) + 1;
    };
    const staged: GradeRecord[] = [];
    const commit = () => {
        for (const g of staged) {
            const record = { ...g, version: log.nextVersion(g) };
            log.append(record);
            graded.push(record);
        }
    };
    const outside = `probe turn outside the run's ${manifest.events} events`;
    let judgeErrors = 0;
    const p7 = scenario.probes.filter((p) => p.type === "P7");
    const memoryArms = arms.filter((a) => a !== "host");
    const pairs = p7.flatMap((probe) =>
        memoryArms.flatMap((arm) => {
            if (!ran.has(probe.id)) {
                for (const side of [arm, "host"]) skip(side, outside);
                return [];
            }
            const sides = { [arm]: attempts(arm, probe.id), host: attempts("host", probe.id) };
            const lost = new Set<string>();
            for (const [side, rows] of Object.entries(sides)) {
                if (!rows) skip(side, "no journaled snapshot");
                else if (rows[0]?.turn_outcome !== "ok") skip(side, "P7 probe turn failed");
                else continue;
                lost.add(side);
            }
            for (const side of Object.keys(sides)) {
                if (lost.size > 0 && !lost.has(side)) skip(side, "P7 pairing lost");
            }
            const [mine, host] = [sides[arm], sides.host];
            if (lost.size > 0 || !mine?.[0] || !host?.[0]) return [];
            return [{ probe, arm, a: mine[0], b: host[0], rows: { a: mine, b: host } }];
        }),
    );
    const firewall = (url: string) => {
        const judges = models.map((m) => proxyJudge(url, rules.judge.model, m));
        if (!judges[0]) throw new Error("the manifest records no run model");
        return judges[0];
    };
    if (pairs.length > 0) {
        firewall("http://judge.invalid");
        if (!config) throw new Error("P7 judging needs the sim config");
    }

    for (const probe of scenario.probes.filter((p) => p.type !== "P7")) {
        for (const arm of arms) {
            if (probe.type === "P14") {
                skip(arm, "P14 has no probe turn");
                continue;
            }
            if (!ran.has(probe.id)) {
                skip(arm, outside);
                continue;
            }
            const mine = attempts(arm, probe.id);
            if (!mine) {
                skip(arm, "no journaled snapshot");
                continue;
            }
            let grade: GradeRecord | null;
            try {
                grade = gradeItem(probe, mine, rules);
            } catch (caught) {
                if (!(caught instanceof AnswerRefused)) throw caught;
                skip(arm, "answer refused");
                console.error(`${probe.id} (${arm}): ${String(caught)}`);
                continue;
            }
            if (grade) staged.push(grade);
            else skip(arm, "probe turn failed");
        }
    }

    if (pairs.length > 0 && config) {
        const records = new RecordWriter(join(dir, "judge-calls.jsonl"));
        const gateway = new Gateway({
            upstream: bedrockUpstream(config.bedrock.region, config.bedrock.aws_profile),
            records,
            injector: new FaultInjector([], new Rng(1), 1_000),
            rng: new Rng(manifest.seed),
            clock: { scenarioMs: () => 0 },
            scope: () => ({ arm: "judge", session: null, turn: null }),
        });
        await gateway.start();
        const judged: { arm: string; grades: GradeRecord[] }[] = [];
        const judgments: Record<string, unknown>[] = [];
        try {
            const judge = firewall(gateway.urls[0] as string);
            for (const { probe, arm, a, b, rows } of pairs) {
                const reference = String((probe.check as { judge?: string }).judge ?? "");
                const both = (why: string) => {
                    for (const side of [arm, "host"]) skip(side, why);
                };
                const refuse = (caught: unknown) => {
                    both("P7 refused");
                    console.error(`${probe.id} (${arm}): ${String(caught)}`);
                };
                const fail = (caught: unknown) => {
                    judgeErrors++;
                    both("P7 judge call failed");
                    console.error(`${probe.id} (${arm}): ${String(caught)}`);
                };
                let built: P7Inputs | null;
                try {
                    built = p7Pair(probe.id, a, b);
                } catch (caught) {
                    refuse(caught);
                    continue;
                }
                if (!built) {
                    both("P7 probe turn failed");
                    continue;
                }
                let judgment: Judgment;
                const firstCall = records.records.length;
                try {
                    judgment = await judgePair(judge, built.pair, reference, []);
                } catch (caught) {
                    if (caught instanceof BlindingRefused) refuse(caught);
                    else fail(caught);
                    continue;
                }
                const calls = records.records.slice(firstCall).map((r) => r.seq);
                const context = {
                    probe,
                    snapshots: rows,
                    calibration: null,
                    permutation: null,
                    cross_judge: null,
                };
                let grades: GradeRecord[];
                try {
                    grades = gradeP7(judgment, context, rules);
                } catch (caught) {
                    if (caught instanceof GradeRefused) throw caught;
                    fail(caught);
                    continue;
                }
                judged.push({ arm, grades });
                judgments.push({ item: probe.id, arm, against: "host", calls, judgment });
            }
        } finally {
            await gateway.stop();
        }
        if (gateway.failures.length > 0) {
            judgeErrors += gateway.failures.length;
            for (const f of gateway.failures) console.error(`judge-calls.jsonl: ${String(f)}`);
            for (const { arm } of judged)
                for (const side of [arm, "host"]) skip(side, "P7 judge call failed");
        } else {
            const rows = judgments.map((j) => `${JSON.stringify(j)}\n`).join("");
            const log = join(dir, "judgments.jsonl");
            keepCompleteLines(log);
            appendFileSync(log, rows);
            for (const { grades } of judged) staged.push(...grades);
        }
    }
    commit();

    const p11 = Object.fromEntries(
        arms.map((arm) => {
            const mine = graded.filter((g) => g.arm === arm && g.probe_type === "P11");
            const score = mine.reduce(
                (n, g) => n + Number(g.metrics["P11.weighted_score"] ?? 0),
                0,
            );
            return [arm, { n: mine.length, weighted_score: score }];
        }),
    );
    const p3 = memoryArms.map((arm) => ({ arm, delta_mem: deltaMem(graded, arm) }));
    const versions: Summary["versions"] = {};
    for (const g of graded) versions[g.version] = (versions[g.version] ?? 0) + 1;
    return {
        verdicts: verdictCounts(graded),
        skipped,
        versions,
        p11,
        p3,
        judge_errors: judgeErrors,
    };
}

if (import.meta.main) {
    const dir = resolve(process.argv[2] ?? "");
    if (!process.argv[2] || !existsSync(join(dir, "manifest.json"))) {
        console.error("usage: bun scripts/grade-run.ts <run dir>");
        process.exit(2);
    }
    const summary = await gradeRun(dir, loadConfig());
    console.log(JSON.stringify(summary, null, 2));
    if (summary.judge_errors > 0) process.exit(1);
}
