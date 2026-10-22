# Probe grading fixtures

Each file is one probe item, its snapshots, and the grade it must receive:
`probe` is a compiled `ProbeItem`, `snapshots` the artefacts captured at the
probe turn (each naming its item, arm, session, and turn), and `expect` the exact verdict, reason, metrics, and input
artefact ids. `provenance` says
where the artefacts came from.

The P1 and P1-control files carry artefacts recorded in the 2026-10-16 live
witness (`witness-8`, `scheduled`, Eidnara arm): the mini-redis workspace
diff after session `s-0003`, the session's Pi bash commands, and its proxy
call records. That session ran the P1-control item `q-0012` without the
`DROWSY_EGRET_` convention, its known fail. The known pass adds one
constant line to the recorded diff. The other files are constructed from the
compiled checks of seed 101 (S) to exercise each grader's pass and fail
branches.

`P1-control-fail-recorded-host.json` and `P1-control-fail-recorded-eidnara.json`
are snapshots the harness's own `SnapshotRecorder` captured in the
2026-10-16 `grade-1` run (S seed 101, both arms, Pi): in both arms the agent
declined the change because mini-redis has no multi-key GET.

The P7 files hold an answer pair and the judge's two verdicts, scripted for
the test; `P7-pass` and `P7-fail` are the pairs the live judge
(`global.openai.gpt-5.6-luna`) graded the same way on 2026-10-16, recorded
with its identity in `runs/judge-smoke/judgments.json`.

These fixtures carry checks from before generator `sim-scenario/v4` (no
`applies`, no file scope, no `ground_truth`), so they exercise the graders'
channel logic on its own. The controls in `src/grade/controls.test.ts` grade
against the checks and ground truth the current compiler emits.
