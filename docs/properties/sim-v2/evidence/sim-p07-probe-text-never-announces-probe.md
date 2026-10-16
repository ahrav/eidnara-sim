# sim-p07-probe-text-never-announces-probe

Evidence status: PROPOSED. SIM-P07, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

No delivered user text contains a probe id, the word `probe`, a ledger key name,
or a grading hint from a fixed marker set.

No harness code, test, or run exists yet. The surface lands in M2
(#1026).

## Failure scenario

The agent recognises the probe and the score measures test awareness.

## Timing windows and dependencies

The user-sim may paraphrase a hidden script into an announcing phrase at run
time.

## What a test must construct

The compiled probe plan and the live user-sim outputs for every probe turn.

## Investigation log

No open questions.
