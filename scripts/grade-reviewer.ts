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
import {
    blindConversation,
    blindText,
    changeView,
    readConversation,
    requestOf,
    reviewRequests,
} from "../src/reviewer/view";
import { Rng } from "../src/rng";
import { writeAtomic } from "../src/run/atomic";
import { CallLog } from "../src/run/calllog";
import {
    keepCompleteLines,
    readJournal,
    releaseLease,
    requireAppendable,
    requireComplete,
    takeLease,
} from "../src/run/journal";
import { simIdentity } from "../src/run/run";
import { scenarioHash } from "../src/scenario/compile";

export const REVIEWER_JUDGMENTS = "reviewer-judgments.jsonl";
export const REVIEWER_GRADES = "reviewer-grades.jsonl";
export const REVIEWER_GRADE_SCHEMA = "sim-reviewer-grade/v1";
const JUDGE_CALLS = "judge-calls.jsonl";
/** Why a change carries no label: each is evidence the run lacks, or a judge call that failed. */
export const UNJUDGED = {
    clock: "the commit time maps to no single wall time",
    proposal: "no applied proposal recorded for the change",
    request: "no single stage-2 request recorded for the change",
    judge: "judge call failed",
} as const;
/**
 * Why a created row carries no label: the revision's rubric grades a change to a row that stood
 * before it, and a row the reviewer wrote anew has no such target.
 */
export const OUTSIDE = "a created row lies outside the revision's property";

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
    /** The gateway's sequence number of the stage-2 request the view read the cited sources from. */
    request_seq: number | null;
    /** The judged label and its reading; null with `reason` when no judgment stands. */
    label: ChangeLabel | null;
    verdict: string | null;
    reason?: string;
    /** The registered literal rule's reading (`R1.v1`), kept beside the label. */
    metrics: { "R1.v1": LiteralReading["verdict"] };
    literal_lines: LiteralReading["lines"];
    /** The statement's visibility before and after the change, and whether the change took it out of automatic delivery. */
    delivery: { before: string | null; after: string | null; left_automatic: boolean };
    /** For a user statement: whether the scenario held it in force at the change, by its supersession and plan records. */
    in_force: { reading: InForce; statements: ScenarioStatement[] } | null;
    judgment: Omit<ChangeJudgment, "label"> | null;
    /** `reviewerGraderDigest` of the code that made the row. */
    grader: string;
}

export interface ReviewerSummary {
    /** The written changes by arm; an arm without a Kernel store counts 0 and is listed in `without_store`. */
    changes: Record<string, number>;
    without_store: string[];
    /** Over every arm: the changes by judged label; `none` counts a change without a label. */
    labels: Record<string, number>;
    /** The changes without a label, by reason. */
    unjudged: Record<string, number>;
    /** The changes of a kind the revision grades that have no label; the step exits 1 when it is above 0. */
    unlabelled: number;
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

/** One change as the step read it, with the judge's prompt when the run holds the evidence for one. */
interface Read {
    arm: string;
    change: ReviewerChange;
    scenario_ms: number | null;
    literal: LiteralReading;
    in_force: ReviewerGrade["in_force"];
    request_seq: number | null;
    /** Why the change gets no judge call; absent on a change with a prompt. */
    unjudged?: string;
}
interface Framed extends Read {
    prompt: string;
    prompt_digest: string;
    answer_digest: string;
}
const isFramed = (item: Read): item is Framed => "prompt" in item;

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
        // A later row for the same prompt and change is the newer label.
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
    for (const path of [log, join(dir, JUDGE_CALLS)]) {
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
    const records = new RecordWriter(join(dir, JUDGE_CALLS), { resume: true });
    const gateway = new Gateway({
        upstream,
        records,
        injector: new FaultInjector([], new Rng(1), 1_000),
        rng: new Rng(seed),
        clock: { scenarioMs: () => 0 },
        scope: () => ({ arm: "judge", session: null, turn: null }),
    });
    const fresh: { item: Framed; judgment: ChangeJudgment; seqs: number[] }[] = [];
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
                    seqs: records.records.slice(firstCall).map((r) => r.seq),
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
        for (const f of gateway.failures) console.error(`${JUDGE_CALLS}: ${String(f)}`);
        return { labels, calls, judgeErrors: judgeErrors + gateway.failures.length + fresh.length };
    }
    if (fresh.length > 0) {
        keepCompleteLines(log);
        appendFileSync(
            log,
            fresh
                .map(({ item, judgment, seqs }) =>
                    JSON.stringify({
                        change: item.change.job,
                        arm: item.arm,
                        calls: seqs,
                        judgment,
                    }),
                )
                .map((row) => `${row}\n`)
                .join(""),
        );
        for (const { item, judgment } of fresh) labels.set(item, judgment);
    }
    return { labels, calls, judgeErrors };
}

/** The grade row of one change: its readings, and its label when a judgment stands. */
function gradeRow(item: Read, judgment: ChangeJudgment | null, grader: string): ReviewerGrade {
    const { change } = item;
    const { label, ...made } = judgment ?? { label: null };
    return {
        schema: REVIEWER_GRADE_SCHEMA,
        arm: item.arm,
        change: change.job,
        kind: change.kind,
        target: change.target,
        target_kind: change.target_kind,
        user_statement: change.user_statement,
        commit_seq: change.commit_seq,
        recorded_ms: change.recorded_ms,
        scenario_ms: item.scenario_ms,
        request_seq: item.request_seq,
        label,
        verdict: label === null ? null : CHANGE_VERDICTS[label],
        ...(label === null ? { reason: item.unjudged ?? UNJUDGED.judge } : {}),
        metrics: { "R1.v1": item.literal.verdict },
        literal_lines: item.literal.lines,
        delivery: { ...change.delivery, left_automatic: leftAutomatic(change) },
        in_force: item.in_force,
        judgment: judgment ? (made as Omit<ChangeJudgment, "label">) : null,
        grader,
    };
}

const tally = (counts: Record<string, number>, key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
};

/**
 * Grades the written changes of the memory reviewer in a finished run. The step holds the run
 * directory's lease, requires the scenario to hash to the manifest's digest and the journal to
 * record a complete run, and reads each arm's final store, the journal, the gateway's call and
 * request logs, and Pi's transcripts. It writes `reviewer-grades.jsonl` whole, one row per
 * change, and appends new labels to `reviewer-judgments.jsonl`. A change whose commit time,
 * applied proposal, or stage-2 request the run's records leave open gets a row with no label and
 * no judge call, and so does a row the reviewer created, which the revision's rubric leaves out.
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
            order?: unknown;
            models?: unknown;
            events?: unknown;
            seed?: number;
            base_wall_ms?: number;
        };
        const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
        if (scenarioHash(scenario) !== manifest.scenario_hash) {
            throw new Error(`${dir}: scenario.json differs from the manifest's scenario_hash`);
        }
        const read = scenario as ReviewScenario;
        const arms = manifest.order;
        if (!Array.isArray(arms) || !arms.every((a): a is string => typeof a === "string")) {
            throw new Error(`${dir}: the manifest records no arm order`);
        }
        const entries = readJournal(join(dir, "journal.jsonl"));
        const events = Number.isSafeInteger(manifest.events)
            ? (manifest.events as number)
            : read.events.length;
        requireComplete(
            entries,
            arms,
            read.events.slice(0, events).map((e) => e.id),
        );
        const callLog = new CallLog(join(dir, "calls.jsonl"));
        calls = callLog;
        const requestsPath = join(dir, "requests.jsonl");
        const stored = lstatSync(requestsPath, { throwIfNoEntry: false })?.isFile()
            ? new RequestPartLog(requestsPath)
            : null;
        parts = stored;
        const bodyOf = (position: number) => {
            const ref = stored ? callLog.request(position) : null;
            return ref && stored ? rebuildRequest(ref, stored) : null;
        };
        const revision = loadReviewerRevision();
        const grader = reviewerGraderDigest();
        const timeline = factTimeline(read);
        const names = [resolve(dir).split("/").at(-1) ?? "", ...arms];
        const blinded = (text: string) => blindText(text, names);
        const items: Read[] = [];
        const summary: ReviewerSummary = {
            changes: {},
            without_store: [],
            labels: {},
            unjudged: {},
            unlabelled: 0,
            literal: {},
            left_automatic: {},
            judge_calls: 0,
            judge_errors: 0,
            revision: reviewerRevisionHash(revision),
            grader: { digest: grader, ...simIdentity() },
        };
        for (const arm of arms) {
            // An arm is one directory of this run, and its store a directory inside it.
            const root = join(dir, arm);
            const named = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/.test(arm);
            if (!named || !lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) {
                throw new Error(`${dir}: arm ${JSON.stringify(arm)} is no directory of the run`);
            }
            const store = join(root, "final-store");
            const entry = lstatSync(store, { throwIfNoEntry: false });
            if (entry && !entry.isDirectory()) throw new Error(`${store} is no directory`);
            const changes = entry ? readChanges(store) : null;
            summary.changes[arm] = changes?.length ?? 0;
            if (changes === null) summary.without_store.push(arm);
            if (!changes || changes.length === 0) continue;
            const clock = daemonClock(entries, arm, manifest.base_wall_ms ?? null);
            const delivered = deliveredAt(entries, arm);
            const requests = reviewRequests(callLog.calls, bodyOf, arm);
            const spoken = readConversation(
                join(root, "r", "home", ".pi", "agent", "sessions"),
                root,
            );
            const conversation = spoken && blindConversation(spoken, blinded);
            for (const change of changes) {
                const wallMs = clock.wall(change.recorded_ms);
                const scenarioMs = clock.scenario(change.recorded_ms);
                const cites = change.proposal !== null || change.contested_by !== null;
                // The request lies inside the job's last attempt, taken back to wall time.
                const from = change.attempt && clock.wall(change.attempt.committed_ms);
                const to = change.attempt && clock.wall(change.attempt.terminal_ms);
                const timed =
                    wallMs !== null && (!change.attempt || (from !== null && to !== null));
                const request =
                    timed && cites && typeof from === "number" && typeof to === "number"
                        ? requestOf(change, requests, { from, to })
                        : null;
                const item: Read = {
                    arm,
                    change,
                    scenario_ms: scenarioMs,
                    literal: literalReading(change.text, scenarioMs, timeline),
                    in_force:
                        change.user_statement && wallMs !== null
                            ? inForceReading(change.text, wallMs, read, delivered)
                            : null,
                    request_seq: request?.seq ?? null,
                };
                if (change.kind === "created" || wallMs === null || request === null) {
                    const unjudged =
                        change.kind === "created"
                            ? OUTSIDE
                            : !timed
                              ? UNJUDGED.clock
                              : cites
                                ? UNJUDGED.request
                                : UNJUDGED.proposal;
                    items.push({ ...item, unjudged });
                    continue;
                }
                const prompt = changePrompt(
                    revision.rubric,
                    changeView({
                        change,
                        wallMs,
                        request,
                        conversation,
                        scenario: read,
                        timeline,
                        delivered,
                        clock,
                        blinded,
                    }),
                );
                const framed: Framed = {
                    ...item,
                    prompt,
                    prompt_digest: sha256Hex(prompt),
                    answer_digest: changeDigest(change),
                };
                items.push(framed);
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
        const framed = items.filter(isFramed);
        const judged =
            framed.length > 0
                ? await judgeChanges({
                      items: framed,
                      dir,
                      upstream:
                          judgeUpstream ??
                          (config
                              ? bedrockUpstream(config.bedrock.region, config.bedrock.aws_profile)
                              : null),
                      seed: manifest.seed ?? 0,
                      revision,
                      models,
                  })
                : { labels: new Map<Framed, ChangeJudgment>(), calls: 0, judgeErrors: 0 };
        summary.judge_calls = judged.calls;
        summary.judge_errors = judged.judgeErrors;
        const rows = items.map((item) =>
            gradeRow(item, isFramed(item) ? (judged.labels.get(item) ?? null) : null, grader),
        );
        for (const row of rows) {
            tally(summary.labels, row.label ?? "none");
            if (row.reason !== undefined) tally(summary.unjudged, row.reason);
            if (row.label === null && row.reason !== OUTSIDE) summary.unlabelled++;
            tally(summary.literal, row.metrics["R1.v1"]);
            if (row.user_statement && row.delivery.left_automatic && row.in_force) {
                tally(summary.left_automatic, row.in_force.reading);
            }
        }
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
    // A change the revision grades that has no label leaves the grades incomplete.
    if (summary.unlabelled > 0) process.exit(1);
}
