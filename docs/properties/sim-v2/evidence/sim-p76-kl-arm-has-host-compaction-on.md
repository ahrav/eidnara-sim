# sim-p76-kl-arm-has-host-compaction-on

Evidence status: PROPOSED. SIM-P76, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

`eidnara-kl` runs with Eidnara's `compaction.enabled=false` and host compaction
enabled, and at least one `native_compaction` call record exists in a p90
session.

`src/hosts/profiles.ts` declares `eidnara-kl` with host compaction on and
Eidnara compaction off; `src/hosts/arms.ts` writes Pi's `compaction.enabled`,
OpenCode's `compaction.auto` and `compaction.prune`, and the user-tier
`eidnara.jsonc` `compaction.enabled` from that profile. Runs before this
profile wrote no Eidnara `compaction.enabled`: on OpenCode the plugin logged
`disabled due to conflicts: OpenCode auto-compaction is enabled` at every
session start (`smr/tier-S/S-101-opencode/eidnara-kl/r/eidnara.log`, 10
lines), and on Pi each boot registered the transform
(`smr/tier-S/S-101-pi/eidnara-kl`, 9 boots).

`src/run/capabilities.ts` checks the arm's evidence: each session's plugin
boots at its `session_end`, and before `EndArm` the transform passes and the
arm's `history_summarizer` calls. The Pi smoke runs `smoke-s1/b-eidnara-kl`
and `smoke-s1/c-eidnara-kl` (S seed 101, 9 events) show 3 boots in
compaction-off mode, no transform pass, and memory capture calls. From Eidnara
`18ba63f8b` the Pi plugin submits a pass in every compaction mode (#1062), and
the daemon serves a compaction-off session additively, so the arm's passes
deliver memory and keep every host message: in the exploratory run
`rr/explore/kl` (S seed 101, 32 events) each `rust pass` line logged
`out=` equal to `in=` and no `history_summarizer` call ran. The check now
requires a pass on every arm that loads the plugin and refuses a
compaction-off pass that narrows its input. No check asserts a
`native_compaction` record in a p90 session.

## Failure scenario

The knowledge-layer comparison arm is not the configuration it claims.

## Timing windows and dependencies

None.

## What a test must construct

A p90 session in the `eidnara-kl` arm.

## Investigation log

No open questions.
