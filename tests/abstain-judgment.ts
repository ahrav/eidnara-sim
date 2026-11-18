import { type AbstainJudgment, abstainIdentity } from "../src/grade/abstention";
import { sha256Hex } from "../src/prereg/canonical";
import {
    type AbstainLabel,
    currentGradingRevision,
    gradingRevisionHash,
} from "../src/prereg/grading";

const revision = currentGradingRevision();

/** A judgment of `answer` carrying `label` under the current grading revision, as the judge step hands one to the P9 grader. */
export const judgmentOf = (answer: string, label: AbstainLabel): AbstainJudgment => ({
    prompt_digest: sha256Hex(`scripted prompt for ${answer}`),
    answer_digest: sha256Hex(answer),
    judge: abstainIdentity(revision),
    revision: gradingRevisionHash(revision),
    label,
});

/** The metrics a P9 grade records from its judgment besides the verdict, the label, and `P9.v1`. */
export const judgmentMetrics = (j: AbstainJudgment) => ({
    "P9.judge_model": j.judge.model,
    "P9.judge_prompt_digest": j.judge.prompt_digest,
    "P9.judge_rubric_digest": j.judge.rubric_digest,
    "P9.answer_digest": j.answer_digest,
    "P9.grading_revision": j.revision,
});
