# sim-p12-clock-advances-only-when-idle

Evidence status: PROPOSED. SIM-P12, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Every `AdvanceClock` entry is preceded by `busy_set` empty at the same sequence,
and between a `BeginTurn` or `RegisterJob` and the matching `EndTurn` or
`EndJob` `scenario_ms` moves only at wall speed.

M4 (#1028) advances scenario time only through `Clock.advanceTo`, which refuses
while any turn or job is busy. The tests rebuild the busy set from the
journal's turn and job entries and check that it is empty at every
`AdvanceClock`.

The live witness (`tests/witness-faults.ts`, `docs/run-command.md`) on 2026-10-16
journaled 167 entries over the `host` and `eidnara` arms on Pi; `checkJournal`
found no `AdvanceClock` while a turn or job was open across 7 event jumps and
2 sleep jumps, with jobs registered from proxy observations of background
calls and from the daemon CPU sampler.

## Failure scenario

A fold or capture job sees a simulated gap mid-execution and its timing metrics
are invalid.

## Timing windows and dependencies

A background job registered from a proxy observation can arrive after the
scheduler decided to jump.

## What a test must construct

A turn followed by a fold or memory-capture job that outlives the turn.

## Investigation log

### Q: OQ-2
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: OQ-2: busy-set membership for daemon-internal work with no proxy call. The M4
  ticket resolves it as daemon CPU time above a pre-registered threshold; the
  threshold value is unresolved, needs the M4 sampler data.
- Missing evidence: a harness run that exercises the record.
- Conclusion: resolved with answer
