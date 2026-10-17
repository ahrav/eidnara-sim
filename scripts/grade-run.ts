import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config/config";
import type { Snapshot } from "../src/grade/artefacts";
import { gradeP7, judgePair, p7Pair, proxyJudge } from "../src/grade/judge";
import { deltaMem, GradeLog, type GradeRecord, gradeItem } from "../src/grade/probes";
import { armBase } from "../src/hosts/arms";
import { bedrockUpstream, Gateway } from "../src/proxy/gateway";
import { FaultInjector } from "../src/proxy/inject";
import { RecordWriter } from "../src/proxy/records";
import { Rng } from "../src/rng";
import { readJournal } from "../src/run/journal";
import type { Scenario } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";

const dir = resolve(process.argv[2] ?? "");
const regrade = process.argv.includes("--regrade");
if (!process.argv[2] || !existsSync(join(dir, "manifest.json"))) {
    console.error("usage: bun scripts/grade-run.ts <run dir> [--regrade]");
    process.exit(2);
}
const config = loadConfig();
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
const rules = loadPrereg(manifest.tier).grading;
const log = new GradeLog(join(dir, "grades.jsonl"));
const arms = manifest.order as string[];

const journaled = new Set(
    readJournal(join(dir, "journal.jsonl"))
        .filter((e) => e.kind === "SnapshotArtefacts")
        .map((e) => String(e.snapshot)),
);
const snapshots = new Map<string, Snapshot[]>();
for (const arm of arms) {
    const path = join(dir, arm, "snapshots.jsonl");
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
        const s = JSON.parse(line) as Snapshot;
        if (!journaled.has(s.id)) continue;
        const key = `${arm}/${s.item}`;
        snapshots.set(key, [...(snapshots.get(key) ?? []), s]);
    }
}

const graded: GradeRecord[] = [];
const skipped: Record<string, number> = {};
const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
};
/** A grade already on the log for this item, arm, and snapshot stands unless `--regrade` asks anew. */
const prior = new Set(regrade ? [] : log.latest().map((g) => `${g.item}/${g.arm}/${g.snapshot}`));
const gradedBefore = (item: string, arm: string, snapshot: string) =>
    prior.has(`${item}/${arm}/${snapshot}`);
const append = (g: GradeRecord) => {
    const record = { ...g, version: log.nextVersion(g.item, g.arm) };
    log.append(record);
    graded.push(record);
};
for (const probe of scenario.probes.filter((p) => p.type !== "P7")) {
    for (const arm of arms) {
        const mine = snapshots.get(`${arm}/${probe.id}`);
        if (!mine) {
            skip(probe.type === "P14" ? "P14 has no probe turn" : "no journaled snapshot");
            continue;
        }
        if (gradedBefore(probe.id, arm, (mine[0] as Snapshot).id)) {
            skip("already graded");
            continue;
        }
        const grade = gradeItem(probe, mine, rules);
        if (grade) append(grade);
        else skip("probe turn failed");
    }
}

let judgeErrors = 0;
const p7 = scenario.probes.filter((p) => p.type === "P7");
const memoryArms = arms.filter((a) => armBase(a) !== "host");
const pairs = p7.flatMap((probe) =>
    memoryArms.flatMap((arm) => {
        const a = snapshots.get(`${arm}/${probe.id}`)?.[0];
        const b = snapshots.get(`host/${probe.id}`)?.[0];
        if (!a || !b || a.turn_outcome !== "ok" || b.turn_outcome !== "ok") {
            skip("P7 without two completed snapshots");
            return [];
        }
        if (gradedBefore(probe.id, arm, a.id) && gradedBefore(probe.id, "host", b.id)) {
            skip("already graded");
            return [];
        }
        return [{ probe, arm, a, b }];
    }),
);
if (pairs.length > 0) {
    const gateway = new Gateway({
        upstream: bedrockUpstream(config.bedrock.region, config.bedrock.aws_profile),
        records: new RecordWriter(join(dir, "judge-calls.jsonl")),
        injector: new FaultInjector([], new Rng(1), 1_000),
        rng: new Rng(manifest.seed),
        clock: { scenarioMs: () => 0 },
        scope: () => ({ arm: "judge", session: null, turn: null }),
    });
    await gateway.start();
    try {
        const judge = proxyJudge(gateway.urls[0] as string, rules.judge.model, config.agent_model);
        for (const { probe, arm, a, b } of pairs) {
            const reference = String((probe.check as { judge?: string }).judge ?? "");
            try {
                const { pair, inputs } = p7Pair(probe.id, a, b);
                const judgment = await judgePair(judge, pair, reference, []);
                const context = {
                    item: probe.id,
                    snapshots: { a: a.id, b: b.id },
                    arms: { a: arm, b: "host" },
                    inputs,
                    calibration: null,
                    permutation: null,
                };
                for (const g of gradeP7(judgment, context, rules)) append(g);
            } catch (caught) {
                judgeErrors++;
                console.error(`${probe.id} (${arm}): ${String(caught)}`);
            }
        }
    } finally {
        await gateway.stop();
    }
}

const summary: Record<string, Record<string, number>> = {};
for (const g of graded) {
    const key = `${g.arm}/${g.probe_type}`;
    summary[key] ??= {};
    const row = summary[key] as Record<string, number>;
    row[g.verdict] = (row[g.verdict] ?? 0) + 1;
}
const p11 = Object.fromEntries(
    arms.map((arm) => {
        const mine = graded.filter((g) => g.arm === arm && g.probe_type === "P11");
        const score = mine.reduce((n, g) => n + Number(g.metrics["P11.weighted_score"] ?? 0), 0);
        return [arm, { n: mine.length, weighted_score: score }];
    }),
);
const delta = memoryArms.map((arm) => ({ arm, delta_mem: deltaMem(log.latest(), arm) }));
console.log(
    JSON.stringify(
        { verdicts: summary, skipped, p11, p3: delta, judge_errors: judgeErrors },
        null,
        2,
    ),
);
if (judgeErrors > 0) process.exit(1);
