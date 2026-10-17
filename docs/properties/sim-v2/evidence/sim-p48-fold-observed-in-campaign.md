# sim-p48-fold-observed-in-campaign

Evidence status: PROPOSED. SIM-P48, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A fold or host compaction occurs at least once per campaign.

M5 (#1030) observed folds in the live S run `recovery-3` (seed 101, Pi,
eidnara arm) at a 30000-token context limit, recorded as
`tests/fixtures/recovery/recovery-3-eidnara.json`: its call records hold five
`history_summarizer` calls across sessions `s-0003` to `s-0005`, and the
final store (`<arm>/store-check.json`, the fixture's `finalStore`) holds
history segments for `sim-s-0003` and `sim-s-0005`. Whether a run at the
default context limit folds is unresolved: no retained artifact records both
an S run and its default limit. No check counts folds yet.

## Failure scenario

Fold fidelity is never measured.

## Timing windows and dependencies

None.

## What a test must construct

Forced p90 sessions.

## Investigation log

### Q: Does a run at the default context limit fold?

- Sources examined: `tests/fixtures/recovery/recovery-3-eidnara.json` (a
  30000-token limit), `tests/fixtures/recovery/witness-8-eidnara.json` (names
  no limit), the `runs/` directory of this tree.
- Findings: the only retained run with recorded folds ran at a lowered limit;
  no retained artifact records an S run together with its default limit.
- Missing evidence: a default-limit S run's journal, call records, and final
  store.
- Conclusion: unresolved, needs a default-limit S run.
