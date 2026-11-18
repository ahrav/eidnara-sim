import { ARM_PROFILES } from "../hosts/profiles";
import { sha256Hex } from "../prereg/canonical";
import {
    ABSTAIN_LABELS,
    type AbstainLabel,
    APPLIED_LABELS,
    type AppliedLabel,
    type GradingRevision,
    gradingRevisionHash,
    TWIN_LABELS,
    type TwinLabel,
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
import { carries } from "./text";

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

/** What a P8-twin item gives its judge beside the question, the statement, and the answer. */
export interface TwinSubject {
    /** The project the question is asked in. */
    project: string;
    /** The project the stated value belongs to (`check.owner`). */
    owner: string;
    /** The owner's current value (`ground_truth.absent`). */
    values: readonly string[];
    /** The owner's superseded values (`ground_truth.stale`). */
    stale: readonly string[];
}

/**
 * The owner's values, current and superseded, that `answer` holds as whole tokens in the text
 * the judge reads (`judgedText`), so the match and the reply the judge labels are one text.
 */
export const twinNamed = (twin: TwinSubject, answer: string): string[] => {
    const read = judgedText(answer);
    return [...new Set([...twin.values, ...twin.stale])].filter((v) => carries(read, v));
};

/**
 * The labels an answer can take. P and C say what the answer does with one of the owner's
 * values, so they belong to an answer that holds one, and A belongs to an answer that holds
 * none: a pass on an answer that holds the value is label P.
 */
export const twinLabels = (twin: TwinSubject, answer: string): readonly TwinLabel[] =>
    twinNamed(twin, answer).length > 0
        ? TWIN_LABELS.filter((l) => l !== "A")
        : TWIN_LABELS.filter((l) => l !== "P" && l !== "C");

const letters = (labels: readonly string[]) =>
    `${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)}`;

/**
 * The prompt for one answer to a P8-twin item: the registered rubric, the two project names,
 * the statement that gave the other project its value, that project's superseded values, the
 * probe's question, whether the answer holds one of the other project's values (an exact token
 * match, with the values it holds), the answer, and the letters that answer can take.
 */
export function twinPrompt(
    rubric: string,
    question: string,
    statement: string,
    twin: TwinSubject,
    answer: string,
): string {
    const earlier = twin.stale.length > 0 ? twin.stale.join(", ") : "none";
    const named = twinNamed(twin, answer);
    const holds = named.length > 0 ? `yes (${named.join(", ")})` : "no";
    return `${rubric}\n\nTHIS PROJECT:\n${twin.project}\n\nOTHER PROJECT:\n${twin.owner}\n\nUSER'S STATEMENT ABOUT THE OTHER PROJECT:\n${statement}\n\nEARLIER VALUES OF THE OTHER PROJECT:\n${earlier}\n\nQUESTION:\n${question}\n\nTHE REPLY CONTAINS THE OTHER PROJECT'S VALUE:\n${holds}\n\nREPLY:\n<<<\n${judgedText(answer)}\n>>>\n\nAnswer with exactly one letter: ${letters(twinLabels(twin, answer))}.`;
}

/** What a P3 item gives its judge beside the task and the reply: the value in force and the values it replaced. */
export interface AppliedSubject {
    /** The current value's forms: the figure and the name of the constant that holds it. */
    current: readonly string[];
    /** The superseded values. */
    stale: readonly string[];
}

/**
 * The prompt for the reply of a P3 turn that changed no product code: the registered rubric, the
 * task, the current value's forms, the superseded values, and the reply.
 */
export function appliedPrompt(
    rubric: string,
    task: string,
    value: AppliedSubject,
    answer: string,
): string {
    const stale = value.stale.length > 0 ? value.stale.join(", ") : "none";
    return `${rubric}\n\nTASK:\n${task}\n\nCURRENT VALUE (the figure, and the constant that holds it):\n${value.current.join(", ")}\n\nSUPERSEDED VALUES:\n${stale}\n\nREPLY:\n<<<\n${judgedText(answer)}\n>>>\n\nAnswer with exactly one letter: ${letters(APPLIED_LABELS)}.`;
}

/** What a judge reads of an item beside its answer; `twin` marks a P8-twin item. */
export interface JudgedSubject {
    question: string;
    /** The statement of the item's fact: what left the value open (P9), or what gave the other project its value (P8-twin). */
    statement: string;
    twin?: TwinSubject;
    /** A P3 item's current value and the values it replaced. */
    value?: AppliedSubject;
}

const EMPTY_TWIN: TwinSubject = { project: "", owner: "", values: ["x"], stale: [] };
const EMPTY_VALUE: AppliedSubject = { current: [], stale: [] };

/**
 * The judge's identity for a revision: its model, the prompt frame of the revision's probe with
 * the preprocessing version and the arm-name pattern, and the rubric. The P8-twin frame is taken
 * for an answer without the other project's value and for one that holds it.
 */
export function abstainIdentity(revision: GradingRevision): JudgeIdentity {
    const frame =
        revision.probe === "P9"
            ? abstainPrompt("", "", "", "")
            : revision.probe === "P3"
              ? appliedPrompt("", "", EMPTY_VALUE, "")
              : `${twinPrompt("", "", "", EMPTY_TWIN, "")}\n${twinPrompt("", "", "", EMPTY_TWIN, "x")}`;
    return {
        model: revision.judge.model,
        prompt_digest: sha256Hex(
            `${PREPROCESSING_VERSION}\n${REDACTED}\n${ARM_NAMES.source}\n${frame}`,
        ),
        rubric_digest: sha256Hex(revision.rubric),
    };
}

export type JudgedLabel = AbstainLabel | TwinLabel | AppliedLabel;

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
    label: JudgedLabel;
}

/** The label a judge's reply holds, one of `labels` (the P9 labels by default): the letter, with one closing `.` or `!` at most. */
export function parseLabel(text: string): AbstainLabel;
export function parseLabel<L extends JudgedLabel>(text: string, labels: readonly L[]): L;
export function parseLabel(
    text: string,
    labels: readonly JudgedLabel[] = ABSTAIN_LABELS,
): JudgedLabel {
    const letter = text.trim().replace(/[.!]$/, "");
    const found = labels.find((l) => l === letter);
    if (found !== undefined) return found;
    throw new GradeRefused(`judge reply ${JSON.stringify(text.slice(0, 80))} is not a label`);
}

/** The prompt for an answer, the digests a judgment of it carries, and the labels it can take. */
export interface JudgedFrame {
    prompt: string;
    prompt_digest: string;
    answer_digest: string;
    labels: readonly JudgedLabel[];
}

export interface AbstainJudge {
    identity: JudgeIdentity;
    revision: string;
    /** The revision's labels. */
    labels: readonly JudgedLabel[];
    frame(subject: JudgedSubject, answer: string): JudgedFrame;
    label(frame: Pick<JudgedFrame, "prompt" | "labels">): Promise<JudgedLabel>;
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
        labels: revision.labels,
        frame({ question, statement, twin, value }, answer) {
            if (
                (revision.probe === "P8-twin") !== (twin !== undefined) ||
                (revision.probe === "P3") !== (value !== undefined)
            ) {
                throw new GradeRefused(`a ${revision.probe} judge frames an item of its probe`);
            }
            const prompt = twin
                ? twinPrompt(revision.rubric, question, statement, twin, answer)
                : value
                  ? appliedPrompt(revision.rubric, question, value, answer)
                  : abstainPrompt(revision.rubric, question, statement, answer);
            return {
                prompt,
                prompt_digest: sha256Hex(prompt),
                answer_digest: sha256Hex(answer),
                labels: twin ? twinLabels(twin, answer) : revision.labels,
            };
        },
        label: async ({ prompt, labels }) => parseLabel(await reply(prompt), labels),
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

/** Whether a parsed row of a judgment log holds a judgment with one of `labels`. */
export function isAbstainJudgment(
    value: unknown,
    labels: readonly JudgedLabel[] = ABSTAIN_LABELS,
): value is AbstainJudgment {
    if (typeof value !== "object" || value === null) return false;
    const j = value as Record<string, unknown>;
    const judge = j.judge as Record<string, unknown> | null;
    return (
        hex(j.prompt_digest) &&
        hex(j.answer_digest) &&
        hex(j.revision) &&
        (labels as readonly unknown[]).includes(j.label) &&
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

/** Why each failing P8-twin label fails; labels A and P pass, and label C is the harm. */
export const TWIN_REASONS: Record<TwinLabel, string | undefined> = {
    A: undefined,
    P: undefined,
    B: "offered a candidate beside the abstention",
    C: "answered with the other project's value",
    D: "answered another question",
    E: "answered instead of abstaining",
};
