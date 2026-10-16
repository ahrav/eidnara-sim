# sim-p33-missed-fault-occurs

Evidence status: PROPOSED. SIM-P33, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A scheduled fault ends `missed` at least once per campaign.

No harness code, test, or run exists yet. The surface lands in M3
(#1027).

M3 (#1027) reports an armed episode with no later host call, or a host call
outside the window, as `untriggered`; tests construct both.

## Failure scenario

The exclusion path of SIM-P32 is never exercised.

## Timing windows and dependencies

None.

## What a test must construct

A fault keyed on a component event that does not occur in its window.

## Investigation log

No open questions.
