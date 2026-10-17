import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config/config";
import type { Snapshot } from "../src/grade/artefacts";
import { gradeP7, judgePair, p7Pair, proxyJudge } from "../src/grade/judge";
import { deltaMem, GradeLog, type GradeRecord, gradeItem } from "../src/grade/probes";
import { armBase } from "../src/hosts/arms";
import { canonicalJson, sha256Hex } from "../src/prereg/canonical";
import { preregistrationHash } from "../src/prereg/validate";
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
const prereg = loadPrereg(manifest.tier);
// Grades derive from the registration's rules, so a run made under another one is refused
// before the log changes.
if (manifest.prereg_sha256 !== preregistrationHash(prereg)) {
    console.error(
        `${dir} ran under pre-registration ${manifest.prereg_sha256}; the grader's is ${preregistrationHash(prereg)}`,
    );
    process.exit(2);
}
// The grades derive from the scenario's checks too, so a scenario that no longer hashes to the
// manifest's record is refused before the log changes.
const { scenario_hash: _hash, ...scenarioBody } = scenario;
if (sha256Hex(canonicalJson(scenarioBody)) !== manifest.scenario_hash) {
    console.error(`${dir}: scenario.json hashes to other than the manifest's scenario_hash`);
    process.exit(2);
}
const rules = prereg.grading;
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
    // readJournal drops a record a kill cut short at the end of the file.
    for (const s of readJournal(path) as unknown as Snapshot[]) {
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
const append = (...grades: GradeRecord[]) => {
    const records = grades.map((g) => ({ ...g, version: log.nextVersion(g.item, g.arm) }));
    log.appendAll(records);
    graded.push(...records);
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
        // The pair lands in one write, so the memory arm's grade means its pair stands; the host
        // snapshot is shared by every memory arm's pair and says nothing about this one.
        if (gradedBefore(probe.id, arm, a.id)) {
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
                // Host side first: a write cut after one record leaves the memory arm ungraded,
                // which is what makes the pair stand or fall on the next grading.
                const sides = gradeP7(judgment, context, rules);
                append(
                    ...sides.filter((g) => g.arm === "host"),
                    ...sides.filter((g) => g.arm !== "host"),
                );
            } catch (caught) {
                judgeErrors++;
                console.error(`${probe.id} (${arm}): ${String(caught)}`);
            }
        }
    } finally {
        await gateway.stop();
    }
}

// The summary describes the run's current grades, the ones kept from earlier invocations included.
const current = log.latest();
const summary: Record<string, Record<string, number>> = {};
for (const g of current) {
    const key = `${g.arm}/${g.probe_type}`;
    summary[key] ??= {};
    const row = summary[key] as Record<string, number>;
    row[g.verdict] = (row[g.verdict] ?? 0) + 1;
}
const p11 = Object.fromEntries(
    arms.map((arm) => {
        const mine = current.filter((g) => g.arm === arm && g.probe_type === "P11");
        const score = mine.reduce((n, g) => n + Number(g.metrics["P11.weighted_score"] ?? 0), 0);
        return [arm, { n: mine.length, weighted_score: score }];
    }),
);
const delta = memoryArms.map((arm) => ({ arm, delta_mem: deltaMem(current, arm) }));
console.log(
    JSON.stringify(
        {
            verdicts: summary,
            graded: graded.length,
            skipped,
            p11,
            p3: delta,
            judge_errors: judgeErrors,
        },
        null,
        2,
    ),
);
if (judgeErrors > 0) process.exit(1);
