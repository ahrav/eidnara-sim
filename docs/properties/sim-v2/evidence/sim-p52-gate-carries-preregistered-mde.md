# sim-p52-gate-carries-preregistered-mde

Evidence status: PROPOSED. SIM-P52, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A verdict records MDE, n, and the pre-registration hash journaled at `StartRun`,
and the hash matches the pre-registration file.

M7 (#1032) puts the pre-registration digest, each family's MDE and margin, n,
the detectable difference, and the resolution ratio into every verdict.

## Failure scenario

A gate is passed under an analysis chosen after seeing the data.

## Timing windows and dependencies

None.

## What a test must construct

A tier report and its pre-registration file.

## Investigation log

No open questions.
