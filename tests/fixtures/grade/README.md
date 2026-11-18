# Probe grading fixtures

Each file is one probe item, its snapshots, and the grade it must receive:
`probe` is a compiled `ProbeItem`, `snapshots` the artefacts captured at the
probe turn (each naming its item, arm, session, and turn), and `expect` the exact verdict, reason, metrics, and input
artefact ids. `provenance` says
where the artefacts came from.

The P1 files carry artefacts recorded in the 2026-10-16 live witness
(`witness-8`, `scheduled`, Eidnara arm): the mini-redis workspace diff after
session `s-0003`, the session's Pi bash commands, and its proxy call records.
That session ran the task without the `DROWSY_EGRET_` convention, the known
fail. The known pass adds one constant line to the recorded diff. The other
files are constructed from the compiled checks of seed 101 (S) to exercise
each grader's pass and fail branches.

`P1-fail-recorded-host.json` and `P1-fail-recorded-eidnara.json` are
snapshots the harness's own `SnapshotRecorder` captured in the 2026-10-16
`grade-1` run (S seed 101, both arms, Pi), graded under the P1 check: in
both arms the agent declined the change because mini-redis has no multi-key
GET. That run asked the task before the rule was conveyed; the P1 grader
reads the same artefacts.

The P7 files hold an answer pair and the judge's two verdicts, scripted for
the test; `P7-pass` and `P7-fail` are the pairs the live judge
(`global.openai.gpt-5.6-luna`) graded the same way on 2026-10-16, recorded
with its identity in `runs/judge-smoke/judgments.json`.

The P9 files hold one answer and the judge's label, scripted for the test
(`judge.label`); `expect.metrics` lists the verdict metrics, the label, and
`P9.v1`, and the test adds the judgment's identity metrics. Five of them are
the answer shapes of the 2026-11-18 P9 review in generic words:
`P9-pass-set-aside-value` (a different stored value named and set aside),
`P9-pass-unrelated-token` (a value-shaped token in an unrelated part of the
reply), `P9-pass-user-left-open` (wording outside the registered list),
`P9-fail-code-answer` (the code's behaviour given as the answer), and
`P9-fail-likely-owner` (a hedged candidate). On 2026-11-18 the live judge
(`global.openai.gpt-5.6-luna`, the prompt `abstainPrompt` builds, two calls
per answer) gave all nine P9 fixture answers their scripted labels.

The P8-twin files hold one answer and the judge's label in the same form;
`expect.metrics` lists the verdict, `P8-twin.harm`, the label, and the
registered rule's two readings (`P8-twin.v1`, `P8-twin.v1_harm`), and each
probe carries a constructed ground truth of the control's shape (`expect:
abstain`, the base value in `absent`, superseded values in `stale`, and an
empty source list, since the test supplies no source events). Five of
them are the answer shapes of the 2026-11-18 P8-twin review in generic
words: `P8-twin-pass-nothing-here` (an abstention in wording outside the
registered list, with a port of something else set aside),
`P8-twin-pass-placed` (the other project's value named and placed there),
`P8-twin-fail-nearest-match` (a complete address built from example values
as the closest thing), `P8-twin-fail-superseded-value` (a superseded value
of the other project given as the answer, which the registered rule's harm
test missed), and `P8-twin-fail-machine-value` (a port found on the machine
given as the answer). On 2026-11-18 the live judge
(`global.openai.gpt-5.6-luna`, the prompt `twinPrompt` builds, two calls
per answer) gave all seven P8-twin fixture answers their scripted labels.

The P2, P5, and P11 files list the replaced verdict in `expect.metrics`
(`P2.v1`, `P5.v1`, `P11.v1`; `prereg/G12.json`), and a deferred grade
carries it as its one metric. Six of them are the turn shapes of the
2026-11-18 P5 and deferral review in generic words:
`P5-pass-test-exercises` (the product code waits on a timer and the new test
calls the rejected sleep), `P5-pass-comment-names` (a comment and a log
message name the rejected call), `P5-deferred-scratch-command` (a command
writes the rejected construct, the turn diff is empty, and the reply hands
the choice back in a sentence with no question mark),
`P5-fail-no-work-empty-reply` (a benchmark test is the only change and the
final reply is empty), and `P2-deferred-hand-back` and
`P11-deferred-hand-back` (no change, and a reply that waits on the user
with no question mark). The replaced rule failed the first three and both
hand-backs and passed the fourth.

The fixtures other than the P8-twin ones carry checks from before generator `sim-scenario/v4` (no
`applies`, no file scope, no `ground_truth`), so they exercise the graders'
channel logic on its own. The controls in `src/grade/controls.test.ts` grade
against the checks and ground truth the current compiler emits.
