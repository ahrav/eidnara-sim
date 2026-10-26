# sim-p49-p1-control-instance-paired

Evidence status: INVALIDATED (sim-scenario/v6). Originally PROPOSED. SIM-P49, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Every P1 item has a no-cue control instance with the same task, and the report
pairs them.

M2 (#1026) compiles one `P1-control` probe per P1 fact in
`src/scenario/compile.ts`: the same task text and project as the P1 item,
placed in the same window before the fact is conveyed, and the compiler refuses
a scenario whose control follows a conveyance of its fact. The test `a P1
control asks the same task before its fact is conveyed` in
`src/scenario/compile.test.ts` checks text, project, and order on an S
scenario. The report-side pairing lands with the report in M7.

M5 (#1029) labels each P1 and P1-control grade with its fact id, so the pair is joined by fact; a test grades a recorded control and a P1 item of the same fact.

## Failure scenario

P1 compliance cannot be separated from the task's base rate.

## Timing windows and dependencies

None.

## What a test must construct

A probe plan with P1 items.

## Investigation log

### Q: Does the control instance measure the P1 task's base rate?
- Sources examined: the S-101 Q runs (`rr/Q/S-101-*`, sim-scenario/v4) items
  q-0013, q-0021, q-0025, and q-0029; `src/hosts/driver.ts` `reset` and
  `openSession`.
- Findings: the driver clones each project once per arm at reset and applies
  scripted commits between sessions; the agent's edits stay. On every arm the
  agent carried out the P1 task at its control turn, and at the P1 probe it
  reported the task already done.
- Missing evidence: none.
- Conclusion: resolved with answer: no. The record is invalidated; generator
  `sim-scenario/v6` compiles no control, and qualification Q revision 3
  registers `host` as the no-source control.
