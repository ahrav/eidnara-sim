import { type AbstainJudgment, abstainIdentity } from "../src/grade/abstention";
import { sha256Hex } from "../src/prereg/canonical";
import {
    type AbstainLabel,
    type AppliedLabel,
    type GradingRevision,
    gradingRevisionFor,
    gradingRevisionHash,
    type TwinLabel,
} from "../src/prereg/grading";

const scripted = (
    revision: GradingRevision,
    answer: string,
    label: AbstainLabel | TwinLabel | AppliedLabel,
) => ({
    prompt_digest: sha256Hex(`scripted prompt for ${answer}`),
    answer_digest: sha256Hex(answer),
    judge: abstainIdentity(revision),
    revision: gradingRevisionHash(revision),
    label,
});

/** A judgment of `answer` carrying `label` under the P9 grading revision, as the judge step hands one to the P9 grader. */
export const judgmentOf = (answer: string, label: AbstainLabel): AbstainJudgment =>
    scripted(gradingRevisionFor("P9"), answer, label);

/** A judgment of `answer` carrying `label` under the P8-twin grading revision. */
export const twinJudgmentOf = (answer: string, label: TwinLabel): AbstainJudgment =>
    scripted(gradingRevisionFor("P8-twin"), answer, label);

/** A judgment of the reply `answer` carrying `label` under the P3 grading revision. */
export const appliedJudgmentOf = (answer: string, label: AppliedLabel): AbstainJudgment =>
    scripted(gradingRevisionFor("P3"), answer, label);

/** The metrics a judged grade of `type` records from its judgment besides the verdict, the label, and the stored earlier rule. */
export const judgmentMetrics = (j: AbstainJudgment, type: "P9" | "P8-twin" | "P3" = "P9") => ({
    [`${type}.judge_model`]: j.judge.model,
    [`${type}.judge_prompt_digest`]: j.judge.prompt_digest,
    [`${type}.judge_rubric_digest`]: j.judge.rubric_digest,
    [`${type}.answer_digest`]: j.answer_digest,
    [`${type}.grading_revision`]: j.revision,
});
