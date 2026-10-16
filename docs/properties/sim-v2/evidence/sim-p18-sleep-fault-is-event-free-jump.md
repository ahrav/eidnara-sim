# sim-p18-sleep-fault-is-event-free-jump

Evidence status: PROPOSED. SIM-P18, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A laptop-sleep fault produces exactly one `AdvanceClock` of the scheduled
duration with `busy_set` empty and no events inside the gap.

M4 (#1028) makes a scheduled laptop sleep the one jump onto its session's
first event, journaled with the fault id, whatever kind of event opens the
session. The compiler sizes `duration_ms` to the gap before the session, so the
jump spans that gap. A test opens the session with an `apply_diff` at the same
time as `session_start` and checks one such jump, landing on the session's
first event, with the fault fired right after it and no event inside the gap.
The catalog record's check follows this wording and the M4 ticket's acceptance
criterion ("exactly one jump with no events inside", with every `AdvanceClock`
landing on the earliest later event). The condensed index's "of the scheduled
duration" cannot hold exactly, because the previous session's last turn runs
at wall speed and consumes part of the nominal gap.

The live witness (`tests/witness-faults.ts`, `docs/run-command.md`) on 2026-10-16
fired a two-minute laptop sleep at a session start on both arms, inside the
idle gap before that session; each sleep jump measured its scheduled duration
with no unrun event inside it, and the next jump landed on the session's
scheduled start.

## Failure scenario

The sleep fault tests a different condition than the one scheduled.

## Timing windows and dependencies

A sleep scheduled while a job is busy must wait for the job.

## What a test must construct

A scheduled laptop-sleep fault.

## Investigation log

No open questions.
