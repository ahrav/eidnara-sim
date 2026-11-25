import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../src/prereg/canonical";
import { loadReviewerRevision, reviewerRevisionHash } from "../src/prereg/reviewer";
import type { Upstream } from "../src/proxy/gateway";
import { readChanges } from "../src/reviewer/changes";
import { changeDigest, changeIdentity, proxyChangeJudge } from "../src/reviewer/judge";
import { ARM, ROWS, reviewerRun } from "../tests/reviewer-run";
import {
    gradeReviewer,
    REVIEWER_GRADES,
    REVIEWER_JUDGMENTS,
    type ReviewerGrade,
    reviewerGraderDigest,
} from "./grade-reviewer";

const dirs: string[] = [];
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
const run = () => {
    const dir = reviewerRun();
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
            return {
                json: {
                    output: { message },
                    stopReason: "end_turn",
                    usage: { inputTokens: 1, outputTokens: 1 },
                },
            };
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

describe("grading the reviewer's changes of a finished run", () => {
    test("each change gets its judged label, the literal rule's reading, its delivery, and the in-force reading of a user statement", async () => {
        const dir = run();
        const upstream = judgeSays(fair);
        const summary = await gradeReviewer(dir, null, upstream);
        expect(summary).toMatchObject({
            changes: { [ARM]: 4 },
            labels: { R: 3, W: 1 },
            literal: { right: 1, wrong: 2, "no truth": 1 },
            left_automatic: { ended: 2 },
            judge_calls: 4,
            judge_errors: 0,
            revision: reviewerRevisionHash(loadReviewerRevision()),
            grader: { digest: reviewerGraderDigest() },
        });
        const rows = grades(dir);
        expect(
            rows.map((r) => [
                r.target,
                r.label,
                r.verdict,
                r.metrics["R1.v1"],
                r.delivery.left_automatic,
                r.in_force?.reading ?? null,
            ]),
        ).toEqual([
            // The user closed the plan in a sentence without a literal: the judge reads right, the literal rule wrong.
            ["mem_plan", "R", "right", "wrong", true, "ended"],
            // A question the commit answered: right, though its tag is in force.
            ["mem_question", "R", "right", "wrong", false, null],
            // A note disputed on the message it was written from: wrong, and the scenario holds it in force.
            ["mem_note", "W", "wrong", "no truth", false, "in force"],
            ["mem_tag0", "R", "right", "right", true, "ended"],
        ]);
        expect(rows.every((r) => r.schema === "sim-reviewer-grade/v1" && r.arm === ARM)).toBe(true);
        expect(rows[0]?.scenario_ms).toBe(152_000);
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
        expect(calls.map((c) => JSON.parse(c).component)).toEqual([
            "judge",
            "judge",
            "judge",
            "judge",
        ]);
        const before = readFileSync(join(dir, REVIEWER_GRADES), "utf8");
        // Without a config and without an upstream, the stored labels alone carry the pass.
        const again = await gradeReviewer(dir, null);
        expect(again).toMatchObject({ labels: { R: 3, W: 1 }, judge_calls: 0, judge_errors: 0 });
        expect(readFileSync(join(dir, REVIEWER_GRADES), "utf8")).toBe(before);
        expect(judgments(dir)).toHaveLength(4);
    });

    test("a label made under another revision lapses, and its change needs a judge again", async () => {
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
    });

    test("a reply that is no label leaves its change without one and counts an error", async () => {
        const dir = run();
        const summary = await gradeReviewer(
            dir,
            null,
            judgeSays((p) => (p.includes("agent note") ? "probably W" : "R")),
        );
        expect(summary).toMatchObject({ labels: { R: 3, none: 1 }, judge_errors: 1 });
        expect(grades(dir)[2]).toMatchObject({
            target: "mem_note",
            label: null,
            verdict: null,
            reason: "judge call failed",
            judgment: null,
        });
        expect(judgments(dir)).toHaveLength(3);
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

    test("a scenario that differs from the manifest's digest is refused before anything is written", async () => {
        const dir = run();
        const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
        scenario.events[1].text = "another statement";
        writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
        await expect(gradeReviewer(dir, null, judgeSays(fair))).rejects.toThrow("scenario_hash");
        expect(existsSync(join(dir, REVIEWER_GRADES))).toBe(false);
        expect(existsSync(join(dir, REVIEWER_JUDGMENTS))).toBe(false);
    });

    test("the judge is of another family than the run's models and the reviewer's own", () => {
        const revision = loadReviewerRevision();
        const sameFamily = {
            ...revision,
            judge: { ...revision.judge, model: "global.anthropic.claude-haiku-5-5" },
        };
        expect(() =>
            proxyChangeJudge("http://judge.invalid", sameFamily, [
                "global.anthropic.claude-opus-5-5",
            ]),
        ).toThrow("shares the agent model's family");
        expect(() => proxyChangeJudge("http://judge.invalid", revision, [])).toThrow(
            "the manifest records no run model",
        );
        expect(
            proxyChangeJudge("http://judge.invalid", revision, ["global.anthropic.claude-opus-5-5"])
                .identity,
        ).toEqual(changeIdentity(revision));
    });
});
