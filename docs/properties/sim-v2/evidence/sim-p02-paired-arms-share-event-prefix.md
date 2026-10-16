# sim-p02-paired-arms-share-event-prefix

Evidence status: PROPOSED. SIM-P02, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

For arms A and B of one run and every `event_idx < divergence_idx(A, B)`, the
delivered user text, pasted bytes, and fault parameters are byte-identical.

No harness code, test, or run exists yet. The surface lands in M6
(#1031).

## Failure scenario

A measured effect is confounded with different user input.

## Timing windows and dependencies

The user-sim tape lookup races the agent's last output; a stale context hash
serves the wrong tape entry.

## What a test must construct

Two arms of one seed; a tape recorded by the first arm; at least one paste and
one scheduled fault before divergence.

## Investigation log

### Q: OQ-3 policy half is resolved in the M0 pre-registration
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: OQ-3 policy half is resolved in the M0 pre-registration: the divergence hash
  is the normalised last agent output. Whether that hash diverges too early on
  long tool output is measured at S (needs human input if it does).
- Missing evidence: a harness run that exercises the record.
- Conclusion: unresolved, needs the S measurement of divergence on long tool
  output
