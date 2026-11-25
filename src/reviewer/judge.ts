import { GradeRefused } from "../grade/artefacts";
import { type JudgeIdentity, type ProxyJudgeOptions, proxyReply } from "../grade/judge";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import {
    CHANGE_LABELS,
    type ChangeLabel,
    type ReviewerRevision,
    reviewerRevisionHash,
} from "../prereg/reviewer";
import type { ReviewerChange } from "./changes";
import { VIEW_LIMITS, VIEW_VERSION } from "./view";

export function changePrompt(rubric: string, view: string): string {
    return `${rubric}\n\n${view}\n\nAnswer with exactly one letter: ${CHANGE_LABELS.slice(0, -1).join(", ")}, or ${CHANGE_LABELS.at(-1)}.`;
}

/**
 * A judgment carries this digest as its answer digest, so a stored label stands for one written
 * change: the same kind, target, target text, commit, and applied proposal.
 */
export const changeDigest = (change: ReviewerChange): string =>
    sha256Hex(
        canonicalJson({
            kind: change.kind,
            target: change.target,
            text: change.text,
            commit_seq: change.commit_seq,
            proposal: change.proposal,
            contested_by: change.contested_by,
        }),
    );

/**
 * The prompt digest covers the view's version and limits, so a view that renders the same
 * change as other text gives the judge another identity and its stored labels lapse.
 */
export function changeIdentity(revision: ReviewerRevision): JudgeIdentity {
    return {
        model: revision.judge.model,
        prompt_digest: sha256Hex(
            `${VIEW_VERSION}\n${canonicalJson(VIEW_LIMITS)}\n${changePrompt("", "")}`,
        ),
        rubric_digest: sha256Hex(revision.rubric),
    };
}

/**
 * A judge's label of one change. `prompt_digest` covers the rubric and the whole view, so a
 * stored judgment stands for exactly the prompt that produced it.
 */
export interface ChangeJudgment {
    prompt_digest: string;
    /** `changeDigest` of the change the label is for. */
    answer_digest: string;
    judge: JudgeIdentity;
    /** `reviewerRevisionHash` of the revision whose rubric and judge made the label. */
    revision: string;
    label: ChangeLabel;
}

/** A reply is a label when it is the letter with one closing `.` or `!` at most. */
export function parseChangeLabel(text: string): ChangeLabel {
    const letter = text.trim().replace(/[.!]$/, "");
    const found = CHANGE_LABELS.find((l) => l === letter);
    if (found !== undefined) return found;
    throw new GradeRefused(`judge reply ${JSON.stringify(text.slice(0, 80))} is not a label`);
}

export interface ChangeJudge {
    identity: JudgeIdentity;
    revision: string;
    label(prompt: string): Promise<ChangeLabel>;
}

/**
 * The revision's judge behind the capture proxy. It refuses a judge of the family of any model
 * in `models`: the run's agent models and the models the reviewer itself called.
 */
export function proxyChangeJudge(
    gatewayUrl: string,
    revision: ReviewerRevision,
    models: readonly string[],
    options: ProxyJudgeOptions = {},
): ChangeJudge {
    const replies = models.map((m) =>
        proxyReply(gatewayUrl, revision.judge.model, m, revision.judge.max_tokens, options),
    );
    const reply = replies[0];
    if (!reply) throw new Error("the manifest records no run model");
    return {
        identity: changeIdentity(revision),
        revision: reviewerRevisionHash(revision),
        label: async (prompt) => parseChangeLabel(await reply(prompt)),
    };
}

const sameIdentity = (a: JudgeIdentity, b: JudgeIdentity) =>
    a.model === b.model &&
    a.prompt_digest === b.prompt_digest &&
    a.rubric_digest === b.rubric_digest;

/** A stored judgment stands for a prompt and change when the prompt, the change, the judge, and the revision are the same. */
export const changeJudgmentStands = (
    stored: ChangeJudgment,
    frame: { prompt_digest: string; answer_digest: string },
    judge: Pick<ChangeJudge, "identity" | "revision">,
): boolean =>
    stored.prompt_digest === frame.prompt_digest &&
    stored.answer_digest === frame.answer_digest &&
    stored.revision === judge.revision &&
    sameIdentity(stored.judge, judge.identity);

const hex = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

export function isChangeJudgment(value: unknown): value is ChangeJudgment {
    if (typeof value !== "object" || value === null) return false;
    const j = value as Record<string, unknown>;
    const judge = j.judge as Record<string, unknown> | null;
    return (
        hex(j.prompt_digest) &&
        hex(j.answer_digest) &&
        hex(j.revision) &&
        (CHANGE_LABELS as readonly unknown[]).includes(j.label) &&
        typeof judge === "object" &&
        judge !== null &&
        typeof judge.model === "string" &&
        hex(judge.prompt_digest) &&
        hex(judge.rubric_digest)
    );
}
