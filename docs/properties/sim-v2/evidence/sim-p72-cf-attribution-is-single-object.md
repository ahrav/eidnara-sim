# sim-p72-cf-attribution-is-single-object

Evidence status: PROPOSED. SIM-P72, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

An attribution record, a P1 pass flipped by deletion, exists only when exactly
one deletion lies between the pair's last common event and the target item;
otherwise the item is unattributed.

No harness code, test, or run exists yet. The surface lands in M9
(#1035).

## Failure scenario

A flip is attributed to the wrong object.

## Timing windows and dependencies

None.

## What a test must construct

Targets with one and with several deletions.

## Investigation log

No open questions.
