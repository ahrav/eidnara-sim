import { afterAll, describe, expect, test } from "bun:test";
import {
    appendFileSync,
    existsSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../src/prereg/canonical";
import { loadReviewerRevision, reviewerRevisionHash } from "../src/prereg/reviewer";
import type { Upstream } from "../src/proxy/gateway";
import { readChanges } from "../src/reviewer/changes";
import { changeDigest, changeIdentity, proxyChangeJudge } from "../src/reviewer/judge";
import { ARM, EXTRA, OTHER_ARM, ROWS, type RunOptions, reviewerRun } from "../tests/reviewer-run";
import {
    gradeReviewer,
    OUTSIDE,
    REVIEWER_GRADES,
    REVIEWER_JUDGMENTS,
    type ReviewerGrade,
    reviewerGraderDigest,
    UNJUDGED,
} from "./grade-reviewer";

const dirs: string[] = [];
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const run = (o?: RunOptions) => {
    const dir = reviewerRun(o);
    dirs.push(dir);
    return dir;
};
/** A judge that answers each prompt with `reply(prompt)` and keeps the prompts it was sent. */
const judgeSays = (reply: (prompt: string) => string): Upstream & { prompts: string[] } => {
    const up = {
        prompts: [] as string[],
        async converse(_model: string, body: { messages?: unknown }) {
            const [first] = body.messages as { content: { text: string }[] }[];
            const prompt = first?.content[0]?.text ?? "";
            up.prompts.push(prompt);
            const message = { role: "assistant", content: [{ text: reply(prompt) }] };
            const usage = { inputTokens: 1, outputTokens: 1 };
            return { json: { output: { message }, stopReason: "end_turn", usage } };
        },
    };
    return up as unknown as Upstream & { prompts: string[] };
};
/** The note was disputed on the message it was written from; every other fixture change is right. */
const fair = (prompt: string) => (prompt.includes("Writer kind: agent note") ? "W" : "R");
const grades = (dir: string) =>
    readFileSync(join(dir, REVIEWER_GRADES), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as ReviewerGrade);
const judgments = (dir: string) =>
    readFileSync(join(dir, REVIEWER_JUDGMENTS), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
const reading = (r: ReviewerGrade) => [
    r.target,
    r.label,
    r.verdict,
    r.metrics["R1.v1"],
    r.delivery.left_automatic,
    r.in_force?.reading ?? null,
];

describe("grading the reviewer's changes of a finished run", () => {
    test("each change gets its judged label, the literal rule's reading, its delivery, and the in-force reading of a user statement", async () => {
        const dir = run();
        const upstream = judgeSays(fair);
        const summary = await gradeReviewer(dir, null, upstream);
        expect(summary).toEqual({
            changes: { [ARM]: 4 },
            without_store: [],
            labels: { R: 3, W: 1 },
            unjudged: {},
            unlabelled: 0,
            literal: { right: 1, wrong: 2, "no truth": 1 },
            left_automatic: { ended: 2 },
            judge_calls: 4,
            judge_errors: 0,
            revision: reviewerRevisionHash(loadReviewerRevision()),
            grader: { ...summary.grader, digest: reviewerGraderDigest() },
        });
        const rows = grades(dir);
        expect(rows.map(reading)).toEqual([
            // The user closed the plan in a sentence without a literal: the judge reads right, the literal rule wrong.
            ["mem_plan", "R", "right", "wrong", true, "ended"],
            // A question the commit answered: right, though its tag is in force.
            ["mem_question", "R", "right", "wrong", false, null],
            // A note disputed on the message it was written from: wrong, and the scenario holds it in force.
            ["mem_note", "W", "wrong", "no truth", false, "in force"],
            ["mem_tag0", "R", "right", "right", true, "ended"],
        ]);
        expect(rows.every((r) => r.schema === "sim-reviewer-grade/v1" && r.arm === ARM)).toBe(true);
        expect(rows.map((r) => r.request_seq)).toEqual([0, 1, 2, 3]);
        expect(rows[0]?.scenario_ms).toBe(152_000);
    });

    test("a statement the arm had yet to see replaced when it was disputed counts as in force and out of delivery", async () => {
        // The replacing tag reached this arm at wall second 79, after the dispute of the first tag at 78.
        const dir = run({ tagAt: 79 });
        const summary = await gradeReviewer(dir, null, judgeSays(fair));
        expect(summary.left_automatic).toEqual({ ended: 1, "in force": 1 });
        expect(reading(grades(dir)[3] as ReviewerGrade)).toEqual([
            "mem_tag0",
            "R",
            "right",
            "right",
            true,
            "in force",
        ]);
    });

    test("a contest mark, a revision, and a created row are graded as changes, and a marked statement stays in delivery", async () => {
        const dir = run({ extra: true });
        const upstream = judgeSays(fair);
        const summary = await gradeReviewer(dir, null, upstream);
        expect(summary.changes).toEqual({ [ARM]: 7 });
        // A row the reviewer created has no target the rubric grades: no judge call, and no missing label.
        expect(summary.labels).toEqual({ R: 5, W: 1, none: 1 });
        expect(summary.unjudged).toEqual({ [OUTSIDE]: 1 });
        expect(summary.unlabelled).toBe(0);
        expect(upstream.prompts).toHaveLength(6);
        const rows = grades(dir);
        expect(rows.slice(4).map((r) => [r.kind, r.target, r.change, r.delivery])).toEqual([
            [
                "contested",
                EXTRA.contest.id,
                EXTRA.contest.job,
                { before: "automatic", after: "automatic", left_automatic: false },
            ],
            [
                "revised",
                EXTRA.revised.id,
                EXTRA.revised.job,
                { before: "explicit_labeled", after: "explicit_labeled", left_automatic: false },
            ],
            [
                "created",
                EXTRA.created.id,
                EXTRA.created.job,
                { before: null, after: "explicit_labeled", left_automatic: false },
            ],
        ]);
        expect(upstream.prompts[5]).toContain(`New text:\n<<<\n${EXTRA.revised.revised}\n>>>`);
        expect(summary.left_automatic).toEqual({ ended: 2 });
    });

    test("a judgment is stored with the digests of its prompt and its change and the calls that made it, and a later pass reads it without a call", async () => {
        const dir = run();
        const upstream = judgeSays(fair);
        await gradeReviewer(dir, null, upstream);
        const revision = loadReviewerRevision();
        const changes = readChanges(join(dir, ARM, "final-store")) ?? [];
        const stored = judgments(dir);
        expect(stored.map((s) => [s.change, s.arm, s.calls, s.judgment.label])).toEqual([
            [ROWS.plan.job, ARM, [0], "R"],
            [ROWS.question.job, ARM, [1], "R"],
            [ROWS.note.job, ARM, [2], "W"],
            [ROWS.tag.job, ARM, [3], "R"],
        ]);
        stored.forEach((s, i) => {
            expect(s.judgment.prompt_digest).toBe(sha256Hex(upstream.prompts[i] as string));
            expect(s.judgment.answer_digest).toBe(
                changeDigest(changes[i] as (typeof changes)[number]),
            );
            expect(s.judgment.judge).toEqual(changeIdentity(revision));
            expect(s.judgment.revision).toBe(reviewerRevisionHash(revision));
        });
        expect(upstream.prompts[0]).toStartWith(`${revision.rubric}\n\nTARGET ROW\n`);
        expect(upstream.prompts[0]).toEndWith("\n\nAnswer with exactly one letter: R, P, W, or U.");
        const calls = readFileSync(join(dir, "judge-calls.jsonl"), "utf8").trim().split("\n");
        expect(calls.map((c) => JSON.parse(c).component)).toEqual(Array(4).fill("judge"));
        const before = readFileSync(join(dir, REVIEWER_GRADES), "utf8");
        // Without a config and without an upstream, the stored labels alone carry the pass.
        const again = await gradeReviewer(dir, null);
        expect(again).toMatchObject({ labels: { R: 3, W: 1 }, judge_calls: 0, judge_errors: 0 });
        expect(readFileSync(join(dir, REVIEWER_GRADES), "utf8")).toBe(before);
        expect(judgments(dir)).toHaveLength(4);
    });

    test("a label made under another revision lapses, its change is judged again once, and a cut last row is dropped", async () => {
        const dir = run();
        await gradeReviewer(dir, null, judgeSays(fair));
        const log = join(dir, REVIEWER_JUDGMENTS);
        const rows = judgments(dir);
        rows[1].judgment.revision = "0".repeat(64);
        writeFileSync(log, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
        await expect(gradeReviewer(dir, null)).rejects.toThrow(
            "reviewer-change judging needs the sim config",
        );
        const upstream = judgeSays(() => "P");
        const summary = await gradeReviewer(dir, null, upstream);
        expect(upstream.prompts).toHaveLength(1);
        expect(summary.labels).toEqual({ R: 2, P: 1, W: 1 });
        expect(grades(dir)[1]).toMatchObject({
            target: "mem_question",
            label: "P",
            verdict: "partly right",
        });
        // The newer row is the label; a write a kill cut leaves no row and breaks no pass.
        appendFileSync(log, '{"change":"cut');
        const third = await gradeReviewer(dir, null);
        expect(third).toMatchObject({ labels: { R: 2, P: 1, W: 1 }, judge_calls: 0 });
        expect(readFileSync(log, "utf8").split("\n").slice(0, -1)).toHaveLength(5);
    });

    test("a reply that is no label leaves its change without one and counts an error", async () => {
        const dir = run();
        const summary = await gradeReviewer(
            dir,
            null,
            judgeSays((p) => (p.includes("agent note") ? "probably W" : "R")),
        );
        expect(summary).toMatchObject({
            labels: { R: 3, none: 1 },
            unjudged: { [UNJUDGED.judge]: 1 },
            judge_errors: 1,
        });
        expect(grades(dir)[2]).toMatchObject({
            target: "mem_note",
            label: null,
            verdict: null,
            reason: UNJUDGED.judge,
            judgment: null,
        });
        expect(judgments(dir)).toHaveLength(3);
    });

    test("a change whose stage-2 request the run kept no record of gets no judge call and no label", async () => {
        const dir = run();
        rmSync(join(dir, "requests.jsonl"));
        const upstream = judgeSays(fair);
        const summary = await gradeReviewer(dir, null, upstream);
        expect(upstream.prompts).toHaveLength(0);
        expect(summary).toMatchObject({
            labels: { none: 4 },
            unjudged: { [UNJUDGED.request]: 4 },
            judge_calls: 0,
            judge_errors: 0,
        });
        const rows = grades(dir);
        expect(rows.map((r) => [r.label, r.reason, r.request_seq])).toEqual(
            Array(4).fill([null, UNJUDGED.request, null]),
        );
        // The readings that need no request stand.
        expect(rows.map((r) => r.metrics["R1.v1"])).toEqual([
            "wrong",
            "wrong",
            "no truth",
            "right",
        ]);
        expect(existsSync(join(dir, REVIEWER_JUDGMENTS))).toBe(false);
    });

    test("a change without an applied proposal on record, and a change whose commit time two clock offsets claim, get no judge call and no label", async () => {
        const bare = run();
        rmSync(join(bare, ARM, "final-store", "store.db"));
        const upstream = judgeSays(fair);
        const summary = await gradeReviewer(bare, null, upstream);
        expect(upstream.prompts).toHaveLength(0);
        expect(summary).toMatchObject({
            labels: { none: 4 },
            unjudged: { [UNJUDGED.proposal]: 4 },
            unlabelled: 4,
        });
        // The arm's offset shrinks by 30 s at wall second 77, so daemon times from wall second 47 to 107 are
        // read twice: three commit times, and the last change's attempt, map to no single wall time.
        const shrunk = run({ shrinkAt: 77 });
        const again = judgeSays(fair);
        const second = await gradeReviewer(shrunk, null, again);
        expect(again.prompts).toHaveLength(0);
        expect(second).toMatchObject({
            labels: { none: 4 },
            unjudged: { [UNJUDGED.clock]: 4 },
            unlabelled: 4,
        });
        expect(
            grades(shrunk).map((r) => [r.target, r.reason, r.in_force?.reading ?? null]),
        ).toEqual([
            ["mem_plan", UNJUDGED.clock, null],
            ["mem_question", UNJUDGED.clock, null],
            ["mem_note", UNJUDGED.clock, null],
            // This commit's own time maps to one wall time, so its scenario reading stands.
            ["mem_tag0", UNJUDGED.clock, "ended"],
        ]);
    });

    test("a completed log row that holds no judgment refuses the pass by its line, and the lease is released", async () => {
        const dir = run();
        writeFileSync(join(dir, REVIEWER_JUDGMENTS), '{"judgment":{"label":"R"}}\n');
        await expect(gradeReviewer(dir, null, judgeSays(fair))).rejects.toThrow(
            "line 1 holds no change judgment",
        );
        rmSync(join(dir, REVIEWER_JUDGMENTS));
        expect((await gradeReviewer(dir, null, judgeSays(fair))).labels).toEqual({ R: 3, W: 1 });
    });

    test("a scenario that differs from the manifest's digest, a journal of an unfinished run, and a store that is no database are each refused before anything is written", async () => {
        const changed = run();
        const scenario = JSON.parse(readFileSync(join(changed, "scenario.json"), "utf8"));
        scenario.events[1].text = "another statement";
        writeFileSync(join(changed, "scenario.json"), JSON.stringify(scenario));
        await expect(gradeReviewer(changed, null, judgeSays(fair))).rejects.toThrow(
            "scenario_hash",
        );

        const unfinished = run();
        const journal = readFileSync(join(unfinished, "journal.jsonl"), "utf8").trim().split("\n");
        writeFileSync(join(unfinished, "journal.jsonl"), `${journal.slice(0, -1).join("\n")}\n`);
        await expect(gradeReviewer(unfinished, null, judgeSays(fair))).rejects.toThrow(
            "the journal has no EndRun",
        );

        const broken = run();
        writeFileSync(join(broken, ARM, "final-store", "kernel.sqlite"), "no database");
        await expect(gradeReviewer(broken, null, judgeSays(fair))).rejects.toThrow();

        for (const dir of [changed, unfinished, broken]) {
            expect(existsSync(join(dir, REVIEWER_GRADES))).toBe(false);
            expect(existsSync(join(dir, REVIEWER_JUDGMENTS))).toBe(false);
        }
    });

    test("an arm without a store is listed and grades nothing, and an arm directory that is a link is refused", async () => {
        const dir = run({ otherArm: true });
        const summary = await gradeReviewer(dir, null, judgeSays(fair));
        expect(summary.changes).toEqual({ [OTHER_ARM]: 0, [ARM]: 4 });
        expect(summary.without_store).toEqual([OTHER_ARM]);
        // The other arm's clock, turns, and request leave the reviewer arm's readings as they are alone.
        expect(grades(dir).map(reading)).toEqual([
            ["mem_plan", "R", "right", "wrong", true, "ended"],
            ["mem_question", "R", "right", "wrong", false, null],
            ["mem_note", "W", "wrong", "no truth", false, "in force"],
            ["mem_tag0", "R", "right", "right", true, "ended"],
        ]);
        expect(grades(dir).map((r) => r.request_seq)).toEqual([1, 2, 3, 4]);

        const linked = run();
        renameSync(join(linked, ARM), join(linked, "moved"));
        symlinkSync(join(linked, "moved"), join(linked, ARM));
        await expect(gradeReviewer(linked, null, judgeSays(fair))).rejects.toThrow(
            "is no directory of the run",
        );
    });

    test("the judge is of another family than the run's models and than the models the reviewer called", async () => {
        const revision = loadReviewerRevision();
        const judge = { ...revision.judge, model: "global.anthropic.claude-haiku-5-5" };
        const url = "http://judge.invalid";
        const agent = "global.anthropic.claude-opus-5-5";
        expect(() => proxyChangeJudge(url, { ...revision, judge }, [agent])).toThrow(
            "shares the agent model's family",
        );
        // Every listed model is checked, whatever its place in the list.
        const second = revision.judge.model.replace(/[^.]+$/, "another-model");
        expect(() => proxyChangeJudge(url, revision, [agent, second])).toThrow(
            "shares the agent model's family",
        );
        expect(() => proxyChangeJudge(url, revision, [])).toThrow(
            "the manifest records no run model",
        );
        expect(proxyChangeJudge(url, revision, [agent]).identity).toEqual(changeIdentity(revision));
        // A run whose reviewer called a model of the judge's family is refused, though its agent model is another's.
        const dir = run({ reviewerModel: second });
        await expect(gradeReviewer(dir, null, judgeSays(fair))).rejects.toThrow(
            "shares the agent model's family",
        );
    });
});
