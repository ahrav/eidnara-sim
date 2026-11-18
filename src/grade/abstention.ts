import { ARM_PROFILES } from "../hosts/profiles";
import { sha256Hex } from "../prereg/canonical";
import {
    ABSTAIN_LABELS,
    type AbstainLabel,
    type GradingRevision,
    gradingRevisionHash,
} from "../prereg/grading";
import { GradeRefused } from "./artefacts";
import {
    ARM_TOKENS,
    type JudgeIdentity,
    normalise,
    PREPROCESSING_VERSION,
    type ProxyJudgeOptions,
    proxyReply,
} from "./judge";

/** What stands in for an arm name in the text the abstention judge reads. */
const REDACTED = "[name]";
const spaced = (name: string, gap: string) => name.split(/[ -]/).join(gap);
/**
 * Arm names, longest first: each arm of `ARM_PROFILES` whose name joins words (`eidnara-kl`),
 * with a hyphen or spaces between them, then the judge's `ARM_TOKENS`, whose words a hyphen, an
 * underscore, or spaces join. A one-word token matches inside a longer word; a name of several
 * words matches as whole words.
 */
const ARM_NAMES = new RegExp(
    [
        ...Object.keys(ARM_PROFILES)
            .filter((arm) => arm.includes("-"))
            .map((arm) => `\\b${spaced(arm, "[-\\s]+")}\\b`),
        ...ARM_TOKENS.map((token) =>
            token.includes(" ") ? `\\b${spaced(token, "[-_\\s]+")}\\b` : token,
        ),
    ]
        .sort((a, b) => b.length - a.length)
        .join("|"),
    "gi",
);

/**
 * An answer as the abstention judge reads it: normalised as a P7 answer is, with every arm name
 * replaced by `[name]`. A registered arm name is replaced whole (`eidnara-kl`), and a one-word
 * arm token is replaced inside a longer word too, so a tool named after an arm keeps its suffix
 * and loses the name. A run of three or more `<` or `>` is written with spaces between the
 * marks, which keeps the prompt's reply frame distinct from the reply's text.
 */
export const judgedText = (answer: string): string =>
    normalise(answer)
        .replace(ARM_NAMES, REDACTED)
        // The prompt frames the reply between `<<<` and `>>>`; a run of three inside it is spaced
        // apart, so the frame's own marks are the only ones the judge reads.
        .replace(/<{3,}|>{3,}/g, (run) => run.split("").join(" "));

/**
 * The prompt for one answer to a P9 item: the registered rubric, the probe's question, the
 * statement that left the value open, and the answer.
 */
export function abstainPrompt(
    rubric: string,
    question: string,
    statement: string,
    answer: string,
): string {
    return `${rubric}\n\nQUESTION:\n${question}\n\nUSER'S EARLIER STATEMENT:\n${statement}\n\nREPLY:\n<<<\n${judgedText(answer)}\n>>>\n\nAnswer with exactly one letter: ${ABSTAIN_LABELS.slice(0, -1).join(", ")}, or ${ABSTAIN_LABELS.at(-1)}.`;
}

/** The judge's identity for a revision: its model, the prompt frame with the preprocessing version and the arm-name pattern, and the rubric. */
export function abstainIdentity(revision: GradingRevision): JudgeIdentity {
    return {
        model: revision.judge.model,
        prompt_digest: sha256Hex(
            `${PREPROCESSING_VERSION}\n${REDACTED}\n${ARM_NAMES.source}\n${abstainPrompt("", "", "", "")}`,
        ),
        rubric_digest: sha256Hex(revision.rubric),
    };
}

/**
 * A judge's label of one answer. `prompt_digest` covers the rubric, question, statement, and
 * judged text, so a stored judgment stands for exactly the prompt that produced it.
 */
export interface AbstainJudgment {
    prompt_digest: string;
    /** SHA-256 of the answer as the proxy relayed it. */
    answer_digest: string;
    judge: JudgeIdentity;
    /** `gradingRevisionHash` of the revision whose rubric and judge made the label. */
    revision: string;
    label: AbstainLabel;
}

export function parseLabel(text: string): AbstainLabel {
    const letter = text.trim().replace(/[.!]$/, "");
    if ((ABSTAIN_LABELS as readonly string[]).includes(letter)) return letter as AbstainLabel;
    throw new GradeRefused(`judge reply ${JSON.stringify(text.slice(0, 80))} is not a label`);
}

export interface AbstainJudge {
    identity: JudgeIdentity;
    revision: string;
    /** The prompt for an answer and the digests a judgment of it carries. */
    frame(
        question: string,
        statement: string,
        answer: string,
    ): { prompt: string; prompt_digest: string; answer_digest: string };
    label(prompt: string): Promise<AbstainLabel>;
}

/** The revision's judge behind the capture proxy; it refuses a model of the agent's family. */
export function proxyAbstainJudge(
    gatewayUrl: string,
    revision: GradingRevision,
    agentModel: string,
    options: ProxyJudgeOptions = {},
): AbstainJudge {
    const reply = proxyReply(
        gatewayUrl,
        revision.judge.model,
        agentModel,
        revision.judge.max_tokens,
        options,
    );
    return {
        identity: abstainIdentity(revision),
        revision: gradingRevisionHash(revision),
        frame(question, statement, answer) {
            const prompt = abstainPrompt(revision.rubric, question, statement, answer);
            return {
                prompt,
                prompt_digest: sha256Hex(prompt),
                answer_digest: sha256Hex(answer),
            };
        },
        label: async (prompt) => parseLabel(await reply(prompt)),
    };
}

const sameIdentity = (a: JudgeIdentity, b: JudgeIdentity) =>
    a.model === b.model &&
    a.prompt_digest === b.prompt_digest &&
    a.rubric_digest === b.rubric_digest;

/** Whether a stored judgment answers `frame` under `judge`: the same prompt, judge, and revision. */
export const judgmentStands = (
    stored: AbstainJudgment,
    frame: { prompt_digest: string; answer_digest: string },
    judge: Pick<AbstainJudge, "identity" | "revision">,
): boolean =>
    stored.prompt_digest === frame.prompt_digest &&
    stored.answer_digest === frame.answer_digest &&
    stored.revision === judge.revision &&
    sameIdentity(stored.judge, judge.identity);

const hex = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** Whether a parsed row of `abstain-judgments.jsonl` holds a judgment. */
export function isAbstainJudgment(value: unknown): value is AbstainJudgment {
    if (typeof value !== "object" || value === null) return false;
    const j = value as Record<string, unknown>;
    const judge = j.judge as Record<string, unknown> | null;
    return (
        hex(j.prompt_digest) &&
        hex(j.answer_digest) &&
        hex(j.revision) &&
        (ABSTAIN_LABELS as readonly unknown[]).includes(j.label) &&
        typeof judge === "object" &&
        judge !== null &&
        typeof judge.model === "string" &&
        hex(judge.prompt_digest) &&
        hex(judge.rubric_digest)
    );
}

/** Why each failing label fails; label A passes. */
export const ABSTAIN_REASONS: Record<AbstainLabel, string | undefined> = {
    A: undefined,
    B: "offered a candidate beside the abstention",
    C: "answered instead of abstaining",
    D: "answered another question",
};
