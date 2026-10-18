# sim-p48-fold-observed-in-campaign

Evidence status: PROPOSED. SIM-P48, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A fold or host compaction occurs at least once per campaign.

No harness code, test, or run exists yet. The surface lands in M5
(#1029).

M5 (#1030) observed folds in the live S runs `recovery-2` and `recovery-3`
(seed 101, Pi, eidnara arm) at a 30000-token context limit: each made
`history_summarizer` calls in sessions `s-0004` and `s-0005`, and the final
store holds their history segments (`<arm>/store-check.json`). The default
context limit gave no fold in the earlier S smoke runs, so a tier run reaches
this property only once sessions grow past the fold threshold.

## Failure scenario

Fold fidelity is never measured.

## Timing windows and dependencies

None.

## What a test must construct

Forced p90 sessions.

## Investigation log

No open questions.
