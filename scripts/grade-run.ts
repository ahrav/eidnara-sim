import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, type SimConfig } from "../src/config/config";
import { assertArtefactsOnly, type Snapshot } from "../src/grade/artefacts";
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
import { RecordWriter } from "../src/proxy/records";
import { Rng } from "../src/rng";
import { type Entry, readJournal, releaseLease, takeLease } from "../src/run/journal";
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

    const journaled = new Set(
        entries.filter((e) => e.kind === "SnapshotArtefacts").map((e) => String(e.snapshot)),
    );
    const snapshots = new Map<string, Snapshot[]>();
    for (const arm of arms) {
        const path = join(dir, arm, "snapshots.jsonl");
        if (!existsSync(path)) continue;
        for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
            const s = JSON.parse(line) as Snapshot;
            const key = `${arm}/${s.item}`;
            snapshots.set(key, [...(snapshots.get(key) ?? []), s]);
        }
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
    const append = (g: GradeRecord) => {
        const record = { ...g, version: log.nextVersion(g) };
        log.append(record);
        graded.push(record);
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
            for (const side of [mine[0], host[0]]) assertArtefactsOnly(side);
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
            const grade = gradeItem(probe, mine, rules);
            if (grade) append(grade);
            else skip(arm, "probe turn failed");
        }
    }

    if (pairs.length > 0 && config) {
        const gateway = new Gateway({
            upstream: bedrockUpstream(config.bedrock.region, config.bedrock.aws_profile),
            records: new RecordWriter(join(dir, "judge-calls.jsonl")),
            injector: new FaultInjector([], new Rng(1), 1_000),
            rng: new Rng(manifest.seed),
            clock: { scenarioMs: () => 0 },
            scope: () => ({ arm: "judge", session: null, turn: null }),
        });
        await gateway.start();
        const staged: { arm: string; grades: GradeRecord[] }[] = [];
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
                try {
                    judgment = await judgePair(judge, built.pair, reference, []);
                } catch (caught) {
                    if (caught instanceof BlindingRefused) refuse(caught);
                    else fail(caught);
                    continue;
                }
                const context = {
                    probe,
                    snapshots: rows,
                    calibration: null,
                    permutation: null,
                    cross_judge: null,
                };
                try {
                    staged.push({ arm, grades: gradeP7(judgment, context, rules) });
                } catch (caught) {
                    fail(caught);
                }
            }
        } finally {
            await gateway.stop();
        }
        if (gateway.failures.length > 0) {
            judgeErrors += gateway.failures.length;
            for (const f of gateway.failures) console.error(`judge-calls.jsonl: ${String(f)}`);
            for (const { arm } of staged)
                for (const side of [arm, "host"]) skip(side, "P7 judge call failed");
        } else {
            for (const { grades } of staged) for (const g of grades) append(g);
        }
    }

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
