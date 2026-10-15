# sim-p36-transcript-search-occurs

Evidence status: PROPOSED. SIM-P36, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

The `host` arm reads its transcript store during an item window at least once
per campaign.

No harness code, test, or run exists yet. The surface lands in M8
(#1034).

## Failure scenario

The D2 attribution split is never exercised.

## Timing windows and dependencies

None.

## What a test must construct

A host arm facing a cross-session probe.

## Investigation log

No open questions.
