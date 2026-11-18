# sim-p80-wrong-project-lookup-is-no-answer

Evidence status: Workstream A S5 record, written with the
`wrong-project-lookup` control.

## Discovery trigger

S5 asks for stale, superseded, wrong-project, and should-not-apply controls.
Tier scenarios hold wrong-project items only in code form (P11); no item asks
for a value that belongs to the other project.

## Evidence trail

`src/scenario/compile.ts` adds a `P8-twin` item for each P8 fact when the
compile input's qualification names `wrong-project-lookup`: the P8 question
in a twin-project session after the conveyance, check
`{ abstain: true, answer_must_not: [value], owner: <base project> }`, ground
truth `abstain` with the value in `absent` and the base project's sources. `proveExposure` proves the
sources precede the probe in the fact's project and carry the value. Without
the qualification the compiled bytes are the tier scenario's (S-101 and S-102
hashes unchanged in this change).

`src/grade/probes.ts` grades the item sentence by sentence: a sentence that
names the value must carry `DISOWNS` wording (`src/grade/text.ts`) or name
`check.owner`, or the item fails with `P8-twin.harm`. The answer must then
abstain under the P9 rule, with the value counted among the question's words;
an answer whose every value sentence places it elsewhere counts as
abstaining. `requireTruth` refuses a check whose forbidden values differ from
the ground truth's `absent` and a check whose owner is the item's own
project. `src/grade/controls.test.ts` grades six passing and eight failing
answers.

Grading revision 11 (`prereg/G11.json`, `docs/grading.md`) replaced that
rule as the verdict. grade-run has a judge label each answer under the
registered rubric, and the grader passes labels A and P, sets
`P8-twin.harm` for label C, refuses labels P and C for an answer that holds
none of the base project's values (`ground_truth.absent` and
`ground_truth.stale`, matched as whole tokens) and label A for an answer
that holds one, and stores the sentence
rule's verdict and harm as `P8-twin.v1` and `P8-twin.v1_harm`. On 753
blind-labelled answers of c8 and w2 the sentence rule agreed with the
labels on 363 and the judge on 740; the one answer labelled C gave a
superseded base value, which the sentence rule's harm test does not read.

## Failure scenario

The agent carries the base project's alias into the twin and the item passes
because the answer also says it is unsure.

## Timing windows and dependencies

None.

## What a test must construct

A qualification scenario with a P8 fact and its twin item, and answers that
abstain, disown, name the value, hedge on it, or guess another.

## Investigation log

### Q: Should an answer that disowns the value and then uses it fail?
- Sources examined: the `P8-twin` grader, PR #32 review.
- Findings: the grader reads each sentence that names the value, so a later
  recommendation fails the item; `src/grade/controls.test.ts` holds two such
  answers.
- Missing evidence: none.
- Conclusion: resolved with answer: it fails.

### Q: Should a sentence that names the owner and still recommends the value fail?
- Sources examined: the `P8-twin` grader; `prereg/G11.json`; the 753
  labelled P8-twin answers of c8 `M` and `MX` and w2 `S` and `S2`.
- Findings: under the sentence rule (`P8-twin.v1`) naming the owner places
  the sentence elsewhere, so it passes. The registered rubric labels such a
  reply C. No labelled answer has that shape: none holds the current base
  value, and the one that holds a superseded value gives it as the answer.
- Missing evidence: an answer of that shape and the judge's label of it.
- Conclusion: unresolved, needs such an answer.
