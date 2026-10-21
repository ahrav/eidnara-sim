# sim-p40-grade-inputs-are-artefacts-only

Evidence status: PROPOSED. SIM-P40, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Each grade record lists its input artefact ids, every id is of class diff,
command-log, test-result, workspace-state, or proxy-call, and classes transcript
and agent self-report never appear.

M5 (#1029) refuses a snapshot carrying any artefact outside the five classes,
and each grade lists the artefact ids its grader read; a test adds a transcript
artefact and checks the refusal (`docs/grading.md`).

## Failure scenario

A system that restates a rule and then violates it scores as compliant.

## Timing windows and dependencies

None.

## What a test must construct

Grades for every programmatic probe type.

## Investigation log

No open questions.
