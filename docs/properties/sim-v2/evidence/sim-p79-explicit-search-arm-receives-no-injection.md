# sim-p79-explicit-search-arm-receives-no-injection

Evidence status: Workstream A S5 record; the arm is refused before preflight.

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

`src/hosts/profiles.ts` records `memory_injection: "always-on"` for both
daemon variants with that reading and its sources (audited by
`requireAuditedVariants`), and declares `eidnara-search` with
`requires.memory_injection: "switchable"`, so `capabilityGaps` refuses it.
`armOrder` refuses it before the manifest, and the qualification validator
refuses a registration that lists it. The arm writes
`memory.auto_search.enabled=false` (`src/hosts/arms.ts`).

`deliveryMismatches` fails an explicit-search arm whose agent request
carries a plugin block or cannot be rebuilt; `src/run/delivery.test.ts`
covers a `<project-memory>` block.

## Failure scenario

An Eidnara change adds a switch, the arm runs, and a code path still writes
recalled memory into the request; the comparison then measures automatic
delivery under another name.

## Timing windows and dependencies

None.

## What a test must construct

An Eidnara build with the switch, a revised `memory_injection` reading, and
a run of `eidnara-search` that reaches a probe with a stored memory.

## Investigation log

### Q: Which Eidnara switch should drop the block?
- Sources examined: `crates/daemon/src/config.rs`, `m0_compose.rs`,
  `packages/opencode-plugin/src/config/schema/eidnara.ts`,
  `packages/pi-plugin/src/tools/eidnara-search.ts`.
- Findings: no existing key; the block and the search source share
  `memory.enabled`.
- Missing evidence: an Eidnara design decision.
- Conclusion: needs human input.
