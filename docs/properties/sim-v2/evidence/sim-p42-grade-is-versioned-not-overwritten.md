# sim-p42-grade-is-versioned-not-overwritten

Evidence status: PROPOSED. SIM-P42, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

For an item and arm, grade versions are strictly increasing, the report names
the version used, and no journal entry rewrites an earlier version.

M5 (#1029) appends grades to a JSONL log in which a regrade takes the next
version for its item and arm, and refuses an append out of order; a test checks
both.

## Failure scenario

A report silently uses a different grade than the one recorded.

## Timing windows and dependencies

None.

## What a test must construct

A regrade after a grader fix.

## Investigation log

No open questions.
