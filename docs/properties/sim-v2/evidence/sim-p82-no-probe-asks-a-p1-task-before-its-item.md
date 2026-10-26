# sim-p82-no-probe-asks-a-p1-task-before-its-item

Evidence status: ACTIVE. Added in rr-campaign-3 with the removal of the P1
control items (SIM-P49).

## Discovery trigger

The S-101 qualification audit found the P1 probe reporting its task done at
q-0013, q-0021, q-0025, and q-0029 on every arm: the P1 control had asked
the same task earlier in the same workspace.

## Evidence trail

`src/hosts/driver.ts` clones each project once per arm at reset and applies
scripted commits between sessions, so the agent's edits persist. Generator
`sim-scenario/v6` compiles no control item, and
`src/scenario/compile.test.ts` `no probe of a project asks a P1 task before
that P1 item` checks the compiled S-101 scenario.

## Failure scenario

An earlier probe asks a P1 task; the agent implements it then, without the
rule, and the P1 probe finds the work done.

## Timing windows and dependencies

Every session after the earlier asking, in the same arm's workspace.

## What a test must construct

A compiled scenario with P1 items and the event order of every probe.

## Investigation log

### Q: Does a revised line re-ask a P1 task?
- Sources examined: the compiled Titan seeds at rr-campaign-3.
- Findings: at S no P1 line repeats; at M-201 ten P1 items repeat an
  earlier instance's task behind a framing.
- Missing evidence: a per-instance task in the fact bank.
- Conclusion: unresolved, needs per-instance probe texts.
