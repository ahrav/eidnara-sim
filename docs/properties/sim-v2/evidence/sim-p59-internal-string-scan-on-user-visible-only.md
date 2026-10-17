# sim-p59-internal-string-scan-on-user-visible-only

Evidence status: PROPOSED. SIM-P59, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

The internal-string regex set runs over agent output delivered to the user-sim
and over tool output shown to the agent, each hit is journaled by source, and
the S gate requires zero hits.

M7 (#1033) scans the agent's relayed responses, the text the user-sim reads, with the F7 patterns, including the mutant fixture; tool output shown to the agent has no capture yet, so that half of the scan is open.

## Failure scenario

Leaked internal text reaches users unreported.

## Timing windows and dependencies

None.

## What a test must construct

A mutant fixture with an internal string.

## Investigation log

No open questions.
