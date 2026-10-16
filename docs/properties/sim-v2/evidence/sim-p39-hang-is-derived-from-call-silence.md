# sim-p39-hang-is-derived-from-call-silence

Evidence status: PROPOSED. SIM-P39, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A turn is `hang` iff its wall duration exceeds 5 minutes with no call record
from the agent's component in that window, or a completed model call is followed
by no persistence or tool execution within the bound; the turn ends `failed`
with cause `hang`.

Before M5 (#1030) no harness code, test, or run existed; the F4 oracle landed
with M5.

M5 (#1030) derives a hang from the call records, journal, and tool runs in `f4`
(`src/oracle/oracles.ts`): a turn at its deadline (OpenCode's `turn deadline`
or Pi's `Timed out after ... ms`), or a completed agent call followed by five
minutes (pre-registration revision 5, `oracles.hang_quiet_ms`) with no tool
start, other same-turn call, or turn end. The oracle reads the journaled
turn after the fact rather than labelling the turn `failed(hang)` as it ends,
and it counts a tool that starts within a second of the call's end as progress
however long the tool runs, so a tool that waits forever surfaces at the
deadline; the property's biconditional is checked against the recorded
evidence, not enforced by the runner. A resumed run restarts its clock at the
last journal entry, so a turn the harness kill cut has no measurable quiet
time and is journaled `failed(interrupted)` instead. The recorded OpenCode
turn that waited on its question tool fires it (`F4-bad.json`); the recorded
Pi turn with tool runs does not (`F4-good.json`); `src/oracle/oracles.test.ts`
constructs a sub-second call followed by silence and a persistence call inside
the window. No tier run has exercised it yet.

## Failure scenario

The intermittent Pi hang goes undetected or a slow turn is mislabelled.

## Timing windows and dependencies

The observed Pi hang had a completed model call.

## What a test must construct

A turn with a completed call and no follow-up.

## Investigation log

No open questions.
