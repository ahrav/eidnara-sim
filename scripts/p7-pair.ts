import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { loadConfig } from "../src/config/config";
import { GradeLog, type GradeRecord, graderDigest, verdictCounts } from "../src/grade/probes";
import { armBase } from "../src/hosts/arms";
import { canonicalJson } from "../src/prereg/canonical";
import { bedrockUpstream, type Upstream } from "../src/proxy/gateway";
import { writeAtomic } from "../src/run/atomic";
import { releaseLease, takeLease } from "../src/run/journal";
import { simIdentity } from "../src/run/run";
import { judgeFirewall, judgeP7, type OpenRun, openRun, p7Pairs } from "./grade-run";

export const PAIRED_FIELDS = [
    "tier",
    "seed",
    "scenario_hash",
    "prereg_sha256",
    "events",
    "host",
    "models",
    "context_limit",
    "fault_override",
    "user_sim_model",
    "corpus",
    "qualification",
    "turns_await_jobs",
    "side_model",
    "tape_sha256",
    "binaries",
    "toolchain",
    "eidnara_commit",
] as const;

/** A manifest from before `turns_await_jobs` ran every turn after its jobs. */
const pairedValue = (manifest: Record<string, unknown>, field: (typeof PAIRED_FIELDS)[number]) =>
    field === "turns_await_jobs" ? (manifest[field] ?? true) : (manifest[field] ?? null);

interface RunIdentity {
    dir: string;
    manifest_sha256: string;
    journal_sha256: string;
    arms: string[];
}

export interface PairIdentity {
    schema: "sim-p7-pair/v1";
    host_run: RunIdentity;
    memory_run: RunIdentity;
    shared: Record<string, unknown>;
}

export interface PairSummary {
    pair: PairIdentity;
    verdicts: Record<string, Record<string, number>>;
    graded: number;
    skipped: Record<string, Record<string, number>>;
    judge_errors: number;
    grader: { digest: string } & ReturnType<typeof simIdentity>;
}

const summaryPath = (out: string) => join(out, "p7-summary.json");

function runIdentity(run: OpenRun): RunIdentity {
    const digest = (name: string) =>
        createHash("sha256")
            .update(readFileSync(join(run.dir, name)))
            .digest("hex");
    return {
        dir: realpathSync(run.dir),
        manifest_sha256: digest("manifest.json"),
        journal_sha256: digest("journal.jsonl"),
        arms: run.arms,
    };
}

/** The out directory lies outside both runs, through any link on its path. */
function requireOutside(out: string, runs: readonly string[]): void {
    let existing = resolve(out);
    const rest: string[] = [];
    while (!existsSync(existing)) {
        rest.unshift(basename(existing));
        existing = dirname(existing);
    }
    const real = join(realpathSync(existing), ...rest);
    for (const run of runs) {
        if (real === run || real.startsWith(`${run}${sep}`)) {
            throw new Error(`${out} lies inside the run ${run}, which pairing leaves unwritten`);
        }
    }
}

function requirePairable(host: OpenRun, memory: OpenRun): string[] {
    const differ = PAIRED_FIELDS.filter(
        (k) =>
            canonicalJson(pairedValue(host.manifest, k)) !==
            canonicalJson(pairedValue(memory.manifest, k)),
    );
    if (differ.length > 0) {
        throw new Error(`the runs differ in ${differ.join(", ")}; P7 pairs one scenario's arms`);
    }
    if (!host.arms.includes("host")) throw new Error(`${host.dir} has no host arm`);
    if (memory.arms.includes("host")) {
        throw new Error(`${memory.dir} holds a host arm; grade-run pairs its P7 items in the run`);
    }
    const memoryArms = memory.arms.filter((a) => armBase(a) !== "host");
    if (memoryArms.length === 0) throw new Error(`${memory.dir} has no memory arm`);
    return memoryArms;
}

export async function pairRuns(
    hostDir: string,
    memoryDir: string,
    out: string,
    upstream: Upstream | null,
    regrade = false,
): Promise<PairSummary> {
    const [host, memory] = [await openRun(hostDir), await openRun(memoryDir)];
    const memoryArms = requirePairable(host, memory);
    const identity: PairIdentity = {
        schema: "sim-p7-pair/v1",
        host_run: runIdentity(host),
        memory_run: runIdentity(memory),
        shared: Object.fromEntries(PAIRED_FIELDS.map((k) => [k, pairedValue(host.manifest, k)])),
    };
    requireOutside(out, [identity.host_run.dir, identity.memory_run.dir]);
    mkdirSync(out, { recursive: true });
    const lease = takeLease(out);
    try {
        const recorded = join(out, "pair.json");
        const placeless = (p: PairIdentity) => ({
            ...p,
            host_run: { ...p.host_run, dir: "" },
            memory_run: { ...p.memory_run, dir: "" },
        });
        if (existsSync(recorded)) {
            const before = JSON.parse(readFileSync(recorded, "utf8")) as PairIdentity;
            if (canonicalJson(placeless(before)) !== canonicalJson(placeless(identity))) {
                throw new Error(`${recorded} pairs other runs or other states of these runs`);
            }
        } else {
            writeAtomic(recorded, `${JSON.stringify(identity, null, 2)}\n`);
        }
        rmSync(summaryPath(out), { force: true });
        const log = new GradeLog(join(out, "grades.jsonl"));
        const grader = graderDigest(["../../scripts/p7-pair.ts"]);
        const graderSim = simIdentity();
        const skipped: PairSummary["skipped"] = {};
        const skip = (arm: string, why: string) => {
            skipped[arm] ??= {};
            const mine = skipped[arm] as Record<string, number>;
            mine[why] = (mine[why] ?? 0) + 1;
        };
        const prior = new Set(
            regrade
                ? []
                : log
                      .latest()
                      .filter((g) => g.grader === grader)
                      .map((g) => `${g.item}/${g.arm}/${g.against ?? ""}/${g.snapshot}`),
        );
        const pairs = p7Pairs({
            probes: host.scenario.probes.filter((p) => p.type === "P7"),
            memoryArms,
            memory,
            host,
            outside: `probe turn outside the runs' ${String(host.manifest.events)} events`,
            skip,
            gradedBefore: (item, arm, against, snapshot) =>
                prior.has(`${item}/${arm}/${against}/${snapshot}`),
        });
        const models = host.models;
        let judgeErrors = 0;
        const staged: GradeRecord[] = [];
        if (pairs.length > 0) {
            judgeFirewall("http://judge.invalid", host.rules, models);
            if (!upstream) throw new Error("P7 judging needs the sim config");
            const judged = await judgeP7({
                pairs,
                dir: out,
                upstream,
                seed: Number(host.manifest.seed),
                rules: host.rules,
                models,
                skip,
            });
            judgeErrors = judged.judgeErrors;
            staged.push(...judged.grades);
        }
        const records = staged.map((g) => ({ ...g, version: log.nextVersion(g), grader }));
        log.appendAll(records);
        const summary: PairSummary = {
            pair: identity,
            verdicts: verdictCounts(log.latest()),
            graded: records.length,
            skipped,
            judge_errors: judgeErrors,
            grader: { digest: grader, ...graderSim },
        };
        writeAtomic(summaryPath(out), `${JSON.stringify(summary, null, 2)}\n`);
        return summary;
    } finally {
        releaseLease(out, lease);
    }
}

if (import.meta.main) {
    const [hostDir, memoryDir, out] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
    if (!hostDir || !memoryDir || !out) {
        console.error(
            "usage: bun scripts/p7-pair.ts <host run> <memory run> <out dir> [--regrade]",
        );
        process.exit(2);
    }
    const config = loadConfig();
    const summary = await pairRuns(
        resolve(hostDir),
        resolve(memoryDir),
        resolve(out),
        bedrockUpstream(config.bedrock.region, config.bedrock.aws_profile),
        process.argv.includes("--regrade"),
    );
    console.log(JSON.stringify(summary, null, 2));
    if (summary.judge_errors > 0) process.exit(1);
}
