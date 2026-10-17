# sim-p03-divergence-is-recorded-never-hidden

Evidence status: PROPOSED. SIM-P03, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

If the agent-visible context hash differs at `event_idx` between two arms, a
divergence record with that index and both hashes exists before the next
`IssueUserText` for either arm.

M6 (#1031) appends a `divergedAt` record with the index and both digests to
`<run>/pairing.jsonl` before the turn it describes is sent; a test reads the
file after each delivery. In `usersim-1`, the eidnara arm diverged at index 1
of sessions `s-0003`, `s-0005`, and `s-0009`.

Contract versus code: the catalog check requires the divergence record to
precede the next `IssueUserText` in journal order and to carry both
agent-visible context hashes. The journal has no `IssueUserText` entry; the
user turn is journaled as `UserTurn`, and the `divergedAt` record lives in
`<run>/pairing.jsonl`, appended before the turn's text is sent
(`src/usersim/usersim.ts`, `UserSim.deliver`). The record carries `digest` and
`reference_digest`, the normalised last-output digests the pre-registration
names as the divergence hash input (`divergence_policy.hash_input`), and
`context_sha256`, the arm's chained session digests; the reference arm's
chained context is on its own turn record for the event, not on this record.
The ordering the check names holds across the two files, not within the
journal.

## Failure scenario

A diverged pair is analysed as paired and the report overstates pairing.

## Timing windows and dependencies

The divergence check runs between `EndTurn` and the next `IssueUserText`; a
crash in that window must not drop the record.

## What a test must construct

Two arms whose agent outputs differ after normalisation.

## Investigation log

### Q: See the record
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: Same as SIM-P02: the hash input is pre-registered in `divergence_policy`; the
  diagnostic full-prefix hash is recorded beside it.
- Missing evidence: a full-tier run; the `usersim-1` smoke run (S seed 101,
  45 events) and the `src/usersim/usersim.test.ts` cases are the evidence so far.
- Conclusion: unresolved, needs a harness run
