# sim-p79-explicit-search-arm-receives-no-injection

Evidence status: Workstream A S5 record; the arm is admitted at Eidnara
`1f2867036` and has not run a measured campaign.

## Discovery trigger

The S5 requalification compares automatic delivery with explicit search: the
agent has Eidnara's tools and nothing arrives in its context on its own.

## Evidence trail

Eidnara at `08de9051a` (read-only) delivers automatically through the
daemon's `<project-memory>` block, composed from the selected project
memories whenever `memory_enabled` holds (`crates/daemon/src/m0_compose.rs`),
and the plugin's `<eidnara-search-hint>` (`memory.auto_search.enabled`). The
daemon key set (`crates/daemon/src/config.rs` `ConfigKey`) has no key that
drops the block while memory stays on, and `memory.injection_budget_tokens`
has a schema minimum of 500
(`packages/opencode-plugin/src/config/schema/eidnara.ts`).
`memory.enabled=false` disables the plugin's kernel memory client
(`packages/opencode-plugin/src/shared/kernel-client/state.ts`), which also
serves the memory source of Pi's `eidnara_search`
(`packages/pi-plugin/src/tools/eidnara-search.ts`), so it removes the tools'
data too.

Eidnara at `1f2867036` (read-only, `eval/c8`) adds the user-tier key
`/memory/auto_inject/enabled` (`crates/daemon/src/config.rs`, default true,
ignored in the project tier). The transform injects m0 memory only while
`memory_enabled && memory_auto_inject` holds
(`crates/daemon/src/transform.rs`), and `compose_m0` drops the
project-memory and user-profile blocks when `inject_memory` is false
(`crates/daemon/src/m0_compose.rs`). `memory.enabled` stays on, so the kernel
memory client keeps serving `eidnara_search`.

`src/hosts/profiles.ts` records `memory_injection: "switchable"` for every
daemon variant with probes on those three sources (audited by
`requireAuditedVariants`), so `capabilityGaps` admits `eidnara-search`. The
arm writes `memory.auto_search.enabled=false` and
`memory.auto_inject.enabled=false` into the plugin's user tier and the
daemon's (`src/hosts/arms.ts`).

`deliveryMismatches` fails an explicit-search arm whose agent request
carries a plugin block or cannot be rebuilt; `memoryMismatches` fails one
whose final store holds a user statement due in a later session while its
transcripts hold no `eidnara_search` result. `src/run/delivery.test.ts`
covers a `<project-memory>` block and the due rule.

## Failure scenario

An Eidnara change adds a switch, the arm runs, and a code path still writes
recalled memory into the request; the comparison then measures automatic
delivery under another name.

## Timing windows and dependencies

None.

## What a test must construct

A run of `eidnara-search` on the audited build that reaches a session after
a captured user statement.

## Investigation log

### Q: Which Eidnara switch should drop the block?
- Sources examined: `crates/daemon/src/config.rs`, `transform.rs`,
  `m0_compose.rs` at `1f2867036`.
- Findings: `/memory/auto_inject/enabled`, read from the user tier only,
  drops both memory blocks while `memory.enabled` keeps the search source.
- Missing evidence: a measured run of the arm.
- Conclusion: resolved by Eidnara PR #1203.
