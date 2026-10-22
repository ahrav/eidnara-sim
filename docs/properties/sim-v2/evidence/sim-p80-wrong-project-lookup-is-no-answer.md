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
- Sources examined: the `P8-twin` grader.
- Findings: naming the owner places the sentence elsewhere, so it passes.
- Missing evidence: Q campaign answers showing whether agents answer that way.
- Conclusion: unresolved, needs the Q campaign's answers.
