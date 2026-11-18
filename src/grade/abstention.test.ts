import { afterEach, describe, expect, test } from "bun:test";
import { sha256Hex } from "../prereg/canonical";
import { currentGradingRevision, gradingRevisionHash } from "../prereg/grading";
import type { RetryPolicy } from "../run/retry";
import {
    ABSTAIN_REASONS,
    abstainIdentity,
    abstainPrompt,
    isAbstainJudgment,
    judgedText,
    judgmentStands,
    parseLabel,
    proxyAbstainJudge,
} from "./abstention";
import { GradeRefused } from "./artefacts";

const revision = currentGradingRevision();
const FAST_RETRY: RetryPolicy = { attempts: 3, totalMs: 5_000, backoffMs: [0] };

describe("the text the abstention judge reads", () => {
    test("an answer is normalised and every arm name becomes [name]", () => {
        expect(judgedText("**Nobody** owns it.\n- `eidnara_search` found nothing")).toBe(
            "Nobody owns it. [name]_search found nothing",
        );
        expect(judgedText("The Host  Arm said so, and EIDNARA agreed.")).toBe(
            "The [name] said so, and [name] agreed.",
        );
        // A word that only ends in an arm token's first word keeps its text.
        expect(judgedText("Raise the alarm a second time.")).toBe("Raise the alarm a second time.");
    });

    test("the prompt holds the rubric, the question, the statement, and the judged text, in that order", () => {
        const prompt = abstainPrompt("RUBRIC", "Who owns it?", "nobody is named yet", "`Ana`?");
        expect(prompt).toBe(
            "RUBRIC\n\nQUESTION:\nWho owns it?\n\nUSER'S EARLIER STATEMENT:\nnobody is named yet\n\nREPLY:\n<<<\nAna?\n>>>\n\nAnswer with exactly one letter: A, B, C, or D.",
        );
    });

    test("the judge identity names the revision's model and digests its rubric", () => {
        const id = abstainIdentity(revision);
        expect(id.model).toBe(revision.judge.model);
        expect(id.rubric_digest).toBe(sha256Hex(revision.rubric));
        const reworded = { ...revision, rubric: `${revision.rubric} More.` };
        expect(abstainIdentity(reworded).rubric_digest).not.toBe(id.rubric_digest);
        expect(abstainIdentity(reworded).prompt_digest).toBe(id.prompt_digest);
    });
});

describe("the judge's reply", () => {
    test("one label letter is a label, with a closing period or exclamation mark at most", () => {
        expect(["A", " B\n", "C.", "D!"].map(parseLabel)).toEqual(["A", "B", "C", "D"]);
        for (const reply of ["", "a", "E", "A or B", "Label: A", "A B"]) {
            expect(() => parseLabel(reply)).toThrow(GradeRefused);
        }
    });

    test("label A alone carries no failure reason", () => {
        expect(ABSTAIN_REASONS.A).toBeUndefined();
        expect(Object.values(ABSTAIN_REASONS).filter(Boolean)).toHaveLength(3);
    });
});

describe("the judge behind the proxy", () => {
    let server: ReturnType<typeof Bun.serve> | null = null;
    afterEach(() => server?.stop(true));

    test("a label request goes through the proxy as component judge with the revision's model and token limit", async () => {
        const seen: { path: string; header: string | null; body: unknown }[] = [];
        server = Bun.serve({
            port: 0,
            async fetch(req) {
                seen.push({
                    path: new URL(req.url).pathname,
                    header: req.headers.get("x-sim-component"),
                    body: await req.json(),
                });
                const content = [{ reasoningContent: {} }, { text: "B." }];
                return Response.json({ output: { message: { content } }, stopReason: "end_turn" });
            },
        });
        const judge = proxyAbstainJudge(
            `http://127.0.0.1:${server.port}`,
            revision,
            "global.anthropic.claude-opus-5-5",
        );
        const frame = judge.frame("Who owns it?", "nobody is named yet", "Probably Ana.");
        expect(await judge.label(frame.prompt)).toBe("B");
        expect(seen).toEqual([
            {
                path: `/model/${encodeURIComponent(revision.judge.model)}/converse`,
                header: "judge",
                body: {
                    messages: [{ role: "user", content: [{ text: frame.prompt }] }],
                    inferenceConfig: { maxTokens: revision.judge.max_tokens },
                },
            },
        ]);
        expect(frame.prompt_digest).toBe(sha256Hex(frame.prompt));
        expect(frame.answer_digest).toBe(sha256Hex("Probably Ana."));
        expect(judge.revision).toBe(gradingRevisionHash(revision));
    });

    test("a judge of the agent model's family is refused before any call", () => {
        expect(() =>
            proxyAbstainJudge("http://judge.invalid", revision, "global.openai.gpt-5.6-terra"),
        ).toThrow("shares the agent model's family");
    });

    test("a reply cut at the token limit is refused", async () => {
        server = Bun.serve({
            port: 0,
            fetch: () =>
                Response.json({
                    output: { message: { content: [] } },
                    stopReason: "max_tokens",
                }),
        });
        const judge = proxyAbstainJudge(
            `http://127.0.0.1:${server.port}`,
            revision,
            "anthropic.x",
            { retry: FAST_RETRY },
        );
        await expect(judge.label("prompt")).rejects.toThrow("judge reply stopped for max_tokens");
    });
});

describe("a stored judgment", () => {
    const judge = proxyAbstainJudge("http://judge.invalid", revision, "anthropic.x");
    const frame = judge.frame("Who owns it?", "nobody is named yet", "Nobody yet.");
    const stored = {
        prompt_digest: frame.prompt_digest,
        answer_digest: frame.answer_digest,
        judge: judge.identity,
        revision: judge.revision,
        label: "A" as const,
    };

    test("stands for the same prompt, answer, judge, and revision", () => {
        expect(isAbstainJudgment(stored)).toBe(true);
        expect(judgmentStands(stored, frame, judge)).toBe(true);
    });

    test("stands for nothing else", () => {
        const other = judge.frame("Who owns it?", "nobody is named yet", "Nobody, yet.");
        expect(judgmentStands(stored, other, judge)).toBe(false);
        const moved = { ...judge, revision: sha256Hex("another revision") };
        expect(judgmentStands(stored, frame, moved)).toBe(false);
        const model = { ...judge, identity: { ...judge.identity, model: "global.openai.other" } };
        expect(judgmentStands(stored, frame, model)).toBe(false);
    });

    test("a row with a label outside the four, or a digest that is not one, is no judgment", () => {
        expect(isAbstainJudgment({ ...stored, label: "E" })).toBe(false);
        expect(isAbstainJudgment({ ...stored, answer_digest: "abc" })).toBe(false);
        expect(isAbstainJudgment({ ...stored, judge: null })).toBe(false);
        expect(isAbstainJudgment(null)).toBe(false);
    });
});
