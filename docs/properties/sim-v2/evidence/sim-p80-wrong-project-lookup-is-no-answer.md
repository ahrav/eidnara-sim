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
`{ abstain: true, answer_must_not: [value] }`, ground truth `abstain` with the
value in `absent` and the base project's sources. `proveExposure` proves the
sources precede the probe in the fact's project and carry the value. Without
the qualification the compiled bytes are the tier scenario's (S-101 and S-102
hashes unchanged in this change).

`src/grade/probes.ts` grades the item with the P9 abstention rule, the value
counted among the question's words and `DISOWNS` wording
(`src/grade/text.ts`) counted as abstention; naming the value without that
wording is `P8-twin.harm`. `requireTruth` refuses a check whose forbidden
values differ from the ground truth's `absent`.
`src/grade/controls.test.ts` grades five passing and six failing answers.

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
- Sources examined: the `P8-twin` grader.
- Findings: the wording rule passes it.
- Missing evidence: Q campaign answers showing whether agents answer that way.
- Conclusion: unresolved, needs the Q campaign's answers.
