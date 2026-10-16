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
history segments for `sim-s-0003` and `sim-s-0005`. The default context limit
gave no fold in the earlier S smoke runs, so a tier run reaches this property
only once sessions grow past the fold threshold. No check counts folds yet.

## Failure scenario

Fold fidelity is never measured.

## Timing windows and dependencies

None.

## What a test must construct

Forced p90 sessions.

## Investigation log

No open questions.
