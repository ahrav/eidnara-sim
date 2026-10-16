# sim-p47-fold-event-yields-p13-record

Evidence status: PROPOSED. SIM-P47, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Every observed fold or host compaction event, a `history_summarizer` or
`native_compaction` call followed by a context-size drop, yields one P13 record
naming the event.

No harness code, test, or run exists yet. The surface lands in M5
(#1029).

M5 (#1029) grades each P13 item from the first fold call inside its compiled turn range and counts the range's folds in `P13.folds`; one record per fold remains open.

## Failure scenario

Fold fidelity is measured on a subset of folds.

## Timing windows and dependencies

A fold killed mid-way yields a partial event.

## What a test must construct

A p90 session.

## Investigation log

No open questions.
