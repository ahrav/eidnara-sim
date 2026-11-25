import { appendFileSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, type SimConfig } from "../src/config/config";
import { GradeRefused } from "../src/grade/artefacts";
import { sha256Hex } from "../src/prereg/canonical";
import {
    CHANGE_VERDICTS,
    type ChangeLabel,
    loadReviewerRevision,
    type ReviewerRevision,
    reviewerRevisionHash,
} from "../src/prereg/reviewer";
import { bedrockUpstream, Gateway, type Upstream } from "../src/proxy/gateway";
import { FaultInjector } from "../src/proxy/inject";
import { REVIEWER_COMPONENTS, RecordWriter } from "../src/proxy/records";
import { RequestPartLog, rebuildRequest } from "../src/proxy/requests";
import {
    type ChangeKind,
    daemonClock,
    leftAutomatic,
    type ReviewerChange,
    readChanges,
    type TargetKind,
} from "../src/reviewer/changes";
import {
    type ChangeJudge,
    type ChangeJudgment,
    changeDigest,
    changeJudgmentStands,
    changePrompt,
    isChangeJudgment,
    proxyChangeJudge,
} from "../src/reviewer/judge";
import {
    deliveredAt,
    factTimeline,
    type InForce,
    inForceReading,
    type LiteralReading,
    literalReading,
    type ReviewScenario,
    type ScenarioStatement,
} from "../src/reviewer/truth";
import { changeView, readConversation, requestOf, reviewRequests } from "../src/reviewer/view";
import { Rng } from "../src/rng";
import { writeAtomic } from "../src/run/atomic";
import { CallLog } from "../src/run/calllog";
import {
    type Entry,
    keepCompleteLines,
    readJsonl,
    releaseLease,
    requireAppendable,
    takeLease,
} from "../src/run/journal";
import { simIdentity } from "../src/run/run";
import { scenarioHash } from "../src/scenario/compile";

export const REVIEWER_JUDGMENTS = "reviewer-judgments.jsonl";
export const REVIEWER_GRADES = "reviewer-grades.jsonl";
export const REVIEWER_GRADE_SCHEMA = "sim-reviewer-grade/v1";
const JUDGE_FAILED = "judge call failed";

/** One reviewer change with its judged label, the registered literal rule's reading, and its delivery. */
export interface ReviewerGrade {
    schema: typeof REVIEWER_GRADE_SCHEMA;
    arm: string;
    /** The review job that wrote the change. */
    change: string;
    kind: ChangeKind;
    target: string;
    target_kind: TargetKind;
    user_statement: boolean;
    commit_seq: number;
    /** The change's commit time on the daemon's clock, and its scenario time. */
    recorded_ms: number;
    scenario_ms: number | null;
    /** The judged label and its reading; null with `reason` when no judgment stands. */
    label: ChangeLabel | null;
    verdict: string | null;
    reason?: string;
    /** The registered literal rule's reading (`R1.v1`), kept beside the label. */
    metrics: { "R1.v1": LiteralReading["verdict"] };
    literal_lines: LiteralReading["lines"];
    /** The target's visibility before and after the change, and whether the change took it out of automatic delivery. */
    delivery: { before: string | null; after: string | null; left_automatic: boolean };
    /** For a user statement: whether the scenario held it in force at the change, by its supersession and plan records. */
    in_force: { reading: InForce; statements: ScenarioStatement[] } | null;
    judgment: Omit<ChangeJudgment, "label"> | null;
    /** `reviewerGraderDigest` of the code that made the row. */
    grader: string;
}

export interface ReviewerSummary {
    /** The written changes by arm. */
    changes: Record<string, number>;
    /** Over every arm: the changes by judged label; `none` counts a change without a standing judgment. */
    labels: Record<string, number>;
    /** Over every arm: the changes by the literal rule's reading. */
    literal: Record<string, number>;
    /** User statements a change took out of automatic delivery, by the in-force reading. */
    left_automatic: Record<string, number>;
    judge_calls: number;
    judge_errors: number;
    revision: string;
    grader: { digest: string; sim_commit: string; sim_worktree: string };
}

/** A digest over the step's own source files and its revision, so a row names the implementation that made it. */
export const reviewerGraderDigest = (): string =>
    sha256Hex(
        [
            "../src/reviewer/changes.ts",
            "../src/reviewer/truth.ts",
            "../src/reviewer/view.ts",
            "../src/reviewer/judge.ts",
            "../src/prereg/reviewer.ts",
            "../prereg/G16.json",
            "grade-reviewer.ts",
        ]
            .map((f) => readFileSync(join(import.meta.dir, f), "utf8"))
            .join("\n"),
    );

interface Framed {
    arm: string;
    change: ReviewerChange;
    prompt: string;
    prompt_digest: string;
    answer_digest: string;
}

/**
 * The stored judgments of `log`, keyed by prompt and change digest. A completed row that holds
 * no judgment refuses the pass by its line number; the text after the last line feed is a cut
 * append, which the next append overwrites.
 */
function storedJudgments(log: string): Map<string, ChangeJudgment> {
    const rows = new Map<string, ChangeJudgment>();
    if (!existsSync(log)) return rows;
    const lines = readFileSync(log, "utf8").split("\n");
    for (const [i, line] of lines.slice(0, -1).entries()) {
        let row: { judgment?: unknown } | null;
        try {
            row = JSON.parse(line);
        } catch {
            row = null;
        }
        const judgment = row?.judgment;
        if (!isChangeJudgment(judgment)) {
            throw new Error(`${log}: line ${i + 1} holds no change judgment`);
        }
        rows.set(`${judgment.prompt_digest}:${judgment.answer_digest}`, judgment);
    }
    return rows;
}

/**
 * Labels each framed change under the revision's rubric and judge. A stored row for the same
 * prompt, change, judge, and revision stands, so a later pass reads the stored label and calls
 * no judge. A change without one gets one call through a gateway this starts, logged to
 * `judge-calls.jsonl`, and its row is appended to `reviewer-judgments.jsonl` with the sequence
 * numbers of the calls that made the label. A change whose call fails keeps no label and is
 * counted, as is every new row of a pass whose call log lost a write.
 */
export async function judgeChanges(o: {
    items: readonly Framed[];
    dir: string;
    upstream: Upstream | null;
    seed: number;
    revision: ReviewerRevision;
    models: readonly string[];
}): Promise<{ labels: Map<Framed, ChangeJudgment>; calls: number; judgeErrors: number }> {
    const { items, dir, upstream, seed, revision, models } = o;
    const log = join(dir, REVIEWER_JUDGMENTS);
    for (const path of [log, join(dir, "judge-calls.jsonl")]) {
        requireAppendable(path);
        const links = lstatSync(path, { throwIfNoEntry: false })?.nlink ?? 1;
        if (links !== 1)
            throw new Error(`${path} has ${links} links; refusing to write through it`);
    }
    const stored = storedJudgments(log);
    const offline = proxyChangeJudge("http://judge.invalid", revision, models);
    const labels = new Map<Framed, ChangeJudgment>();
    const pending: Framed[] = [];
    for (const item of items) {
        const kept = stored.get(`${item.prompt_digest}:${item.answer_digest}`);
        if (kept && changeJudgmentStands(kept, item, offline)) labels.set(item, kept);
        else pending.push(item);
    }
    if (pending.length === 0) return { labels, calls: 0, judgeErrors: 0 };
    if (!upstream) throw new Error("reviewer-change judging needs the sim config");
    const records = new RecordWriter(join(dir, "judge-calls.jsonl"), { resume: true });
    const gateway = new Gateway({
        upstream,
        records,
        injector: new FaultInjector([], new Rng(1), 1_000),
        rng: new Rng(seed),
        clock: { scenarioMs: () => 0 },
        scope: () => ({ arm: "judge", session: null, turn: null }),
    });
    const fresh: { item: Framed; judgment: ChangeJudgment; calls: number[] }[] = [];
    let judgeErrors = 0;
    let calls = 0;
    try {
        await gateway.start();
        const judge: ChangeJudge = proxyChangeJudge(gateway.urls[0] as string, revision, models);
        for (const item of pending) {
            const firstCall = records.records.length;
            try {
                const label = await judge.label(item.prompt);
                fresh.push({
                    item,
                    judgment: {
                        prompt_digest: item.prompt_digest,
                        answer_digest: item.answer_digest,
                        judge: judge.identity,
                        revision: judge.revision,
                        label,
                    },
                    calls: records.records.slice(firstCall).map((r) => r.seq),
                });
            } catch (caught) {
                if (!(caught instanceof GradeRefused)) throw caught;
                judgeErrors++;
                console.error(`${item.change.job} (${item.arm}): ${String(caught)}`);
            }
            calls += records.records.length - firstCall;
        }
    } finally {
        try {
            await gateway.stop();
        } finally {
            records.close();
        }
    }
    // A label rests on a recorded call, so a pass whose call log lost a write keeps none of its new rows.
    if (gateway.failures.length > 0) {
        for (const f of gateway.failures) console.error(`judge-calls.jsonl: ${String(f)}`);
        return { labels, calls, judgeErrors: judgeErrors + gateway.failures.length + fresh.length };
    }
    if (fresh.length > 0) {
        keepCompleteLines(log);
        appendFileSync(
            log,
            fresh
                .map(({ item, judgment, calls }) =>
                    JSON.stringify({ change: item.change.job, arm: item.arm, calls, judgment }),
                )
                .map((row) => `${row}\n`)
                .join(""),
        );
        for (const { item, judgment } of fresh) labels.set(item, judgment);
    }
    return { labels, calls, judgeErrors };
}

const tally = (counts: Record<string, number>, key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
};

/**
 * Grades the written changes of the memory reviewer in a finished run. The step holds the run
 * directory's lease, requires the scenario to hash to the manifest's digest, and reads each arm's
 * final store, the journal, the gateway's call and request logs, and Pi's transcripts. It writes
 * `reviewer-grades.jsonl` whole, one row per change, and appends new labels to
 * `reviewer-judgments.jsonl`; every other file of the run stays as it was.
 */
export async function gradeReviewer(
    dir: string,
    config: SimConfig | null,
    /** Stands in for the Bedrock route the judge calls take, so a test scripts the judge. */
    judgeUpstream?: Upstream,
): Promise<ReviewerSummary> {
    const lease = takeLease(dir);
    let calls: CallLog | null = null;
    let parts: RequestPartLog | null = null;
    try {
        const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
            scenario_hash?: string;
            order?: string[];
            models?: unknown;
            seed?: number;
            base_wall_ms?: number;
        };
        const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
        if (scenarioHash(scenario) !== manifest.scenario_hash) {
            throw new Error(`${dir}: scenario.json differs from the manifest's scenario_hash`);
        }
        const read = scenario as ReviewScenario;
        const entries = readJsonl<Entry>(join(dir, "journal.jsonl"));
        const callLog = new CallLog(join(dir, "calls.jsonl"));
        calls = callLog;
        const requestsPath = join(dir, "requests.jsonl");
        parts = lstatSync(requestsPath, { throwIfNoEntry: false })?.isFile()
            ? new RequestPartLog(requestsPath)
            : null;
        const stored = parts;
        const bodyOf = (position: number) => {
            const ref = stored ? callLog.request(position) : null;
            return ref && stored ? rebuildRequest(ref, stored) : null;
        };
        const revision = loadReviewerRevision();
        const grader = reviewerGraderDigest();
        const timeline = factTimeline(read);
        const runName = resolve(dir).split("/").at(-1) ?? "";
        const framed: Framed[] = [];
        const readings = new Map<
            Framed,
            {
                scenario_ms: number | null;
                literal: LiteralReading;
                in_force: ReviewerGrade["in_force"];
            }
        >();
        const summary: ReviewerSummary = {
            changes: {},
            labels: {},
            literal: {},
            left_automatic: {},
            judge_calls: 0,
            judge_errors: 0,
            revision: reviewerRevisionHash(revision),
            grader: { digest: grader, ...simIdentity() },
        };
        for (const arm of manifest.order ?? []) {
            // An arm is one directory of this run.
            if (!/^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(arm)) {
                throw new Error(`${dir}: arm ${JSON.stringify(arm)} is not a directory name`);
            }
            const changes = readChanges(join(dir, arm, "final-store")) ?? [];
            summary.changes[arm] = changes.length;
            if (changes.length === 0) continue;
            const clock = daemonClock(entries, arm, manifest.base_wall_ms ?? null);
            const delivered = deliveredAt(entries, arm);
            const requests = reviewRequests(callLog.calls, bodyOf, arm);
            const conversation = readConversation(
                join(dir, arm, "r", "home", ".pi", "agent", "sessions"),
                join(dir, arm),
            );
            for (const change of changes) {
                const view = changeView({
                    change,
                    request: requestOf(change, requests, clock),
                    conversation,
                    scenario: read,
                    delivered,
                    clock,
                    runName,
                });
                const prompt = changePrompt(revision.rubric, view);
                const item: Framed = {
                    arm,
                    change,
                    prompt,
                    prompt_digest: sha256Hex(prompt),
                    answer_digest: changeDigest(change),
                };
                framed.push(item);
                const scenarioMs = clock.scenario(change.recorded_ms);
                readings.set(item, {
                    scenario_ms: scenarioMs,
                    literal: literalReading(change.text, scenarioMs, timeline),
                    in_force: change.user_statement
                        ? inForceReading(
                              change.text,
                              clock.real(change.recorded_ms),
                              read,
                              delivered,
                          )
                        : null,
                });
            }
        }
        // The judge is of another family than the run's agent models and the models the reviewer called.
        const models = [
            ...new Set([
                ...(Array.isArray(manifest.models) ? manifest.models.map(String) : []),
                ...callLog.calls
                    .filter((c) => (REVIEWER_COMPONENTS as readonly string[]).includes(c.component))
                    .map((c) => c.model),
            ]),
        ];
        const upstream =
            judgeUpstream ??
            (config ? bedrockUpstream(config.bedrock.region, config.bedrock.aws_profile) : null);
        const judged =
            framed.length > 0
                ? await judgeChanges({
                      items: framed,
                      dir,
                      upstream,
                      seed: manifest.seed ?? 0,
                      revision,
                      models,
                  })
                : { labels: new Map<Framed, ChangeJudgment>(), calls: 0, judgeErrors: 0 };
        summary.judge_calls = judged.calls;
        summary.judge_errors = judged.judgeErrors;
        const rows: ReviewerGrade[] = framed.map((item) => {
            const { change, arm } = item;
            const reading = readings.get(item) as NonNullable<ReturnType<typeof readings.get>>;
            const judgment = judged.labels.get(item) ?? null;
            const left = leftAutomatic(change);
            tally(summary.labels, judgment?.label ?? "none");
            tally(summary.literal, reading.literal.verdict);
            if (change.user_statement && left && reading.in_force) {
                tally(summary.left_automatic, reading.in_force.reading);
            }
            const { label, ...made } = judgment ?? { label: null };
            return {
                schema: REVIEWER_GRADE_SCHEMA,
                arm,
                change: change.job,
                kind: change.kind,
                target: change.target,
                target_kind: change.target_kind,
                user_statement: change.user_statement,
                commit_seq: change.commit_seq,
                recorded_ms: change.recorded_ms,
                scenario_ms: reading.scenario_ms,
                label,
                verdict: label === null ? null : CHANGE_VERDICTS[label],
                ...(label === null ? { reason: JUDGE_FAILED } : {}),
                metrics: { "R1.v1": reading.literal.verdict },
                literal_lines: reading.literal.lines,
                delivery: { ...change.delivery, left_automatic: left },
                in_force: reading.in_force,
                judgment: judgment ? (made as Omit<ChangeJudgment, "label">) : null,
                grader,
            };
        });
        writeAtomic(join(dir, REVIEWER_GRADES), rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
        return summary;
    } finally {
        parts?.close();
        calls?.close();
        releaseLease(dir, lease);
    }
}

if (import.meta.main) {
    const dir = resolve(process.argv[2] ?? "");
    if (!process.argv[2] || !existsSync(join(dir, "manifest.json"))) {
        console.error("usage: bun scripts/grade-reviewer.ts <run dir>");
        process.exit(2);
    }
    const summary = await gradeReviewer(dir, loadConfig());
    console.log(JSON.stringify(summary, null, 2));
    if (summary.judge_errors > 0) process.exit(1);
}
