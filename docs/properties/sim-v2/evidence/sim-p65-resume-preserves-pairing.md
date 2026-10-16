# sim-p65-resume-preserves-pairing

Evidence status: PROPOSED. SIM-P65, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A resumed sibling arm replays the same `tape_id` and reports the same divergence
index for all events before the interrupt.

At the 2026-10-12 proposal no harness code, test, or run existed; the
surface landed in M4 (#1028).

M4 (#1028) resumes each arm from its own cursor over the shared event list; the
resume tests check that every arm's completed events equal the full event list
in order. That is partial evidence: `tape_id` and divergence indices land with
the tapes in M6, and no test compares them across a resume yet.

## Failure scenario

Pairing breaks silently after resume.

## Timing windows and dependencies

Resume rebuilds tape state from disk.

## What a test must construct

An interrupt in a sibling arm.

## Investigation log

No open questions.
