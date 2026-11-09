# sim-p79-explicit-search-arm-receives-no-injection

Evidence status: Workstream A S5 record; the arm is admitted at Eidnara
`1f2867036`, and C8H-M-603-eidnara-search ran its events at `8e6265d2c`.

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
carries a block whose tag is in `AUTOMATIC_RECALL_TAGS` (`<project-memory>`,
`<project-note>`, `<eidnara-search-auto>`, `<eidnara-search-hint>`) or
cannot be rebuilt; `memoryMismatches` fails one whose final store holds a
user statement due in a later session while its transcripts hold no
`eidnara_search` result. `src/run/delivery.test.ts` covers each recall tag,
a `<memory-updates>` block inside `<session-history-since>`, and the due
rule.

Eidnara at `8e6265d2c` (read-only, `eval/c8`) renders `<memory-updates>`
inside `<session-history-since>` from the current session's own
history-summarizer claims: `render_memory_updates`
(`crates/daemon/src/m1_compose.rs:160`) reads the segments
`load_history_segments_above` loads with `WHERE session_id = ?1`
(`crates/memory-store/src/lib.rs:12891-12902`). `compose_m1` gates only the
user-profile block on `inject_memory`, so the block appears on every arm
with Eidnara compaction. C8H-M-603-eidnara-search carried it in 21 of 5,989
agent requests, each holding one claim keyed in session s-0128 alone, and
no automatic recall block.

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

### Q: Does `<memory-updates>` count as automatic delivery?
- Sources examined: `crates/daemon/src/m1_compose.rs`,
  `crates/memory-store/src/lib.rs` at `8e6265d2c`; the 21 requests of
  C8H-M-603-eidnara-search rebuilt from `requests.jsonl`.
- Findings: the block holds the session's own summarizer claims, read from
  its own history segments; it carries no stored memory and no content from
  another session.
- Missing evidence: none for the tag rule. The history summarizer's input
  includes `<project-memory>` while `memory.enabled` holds, an indirect path
  this check does not read.
- Conclusion: resolved; the guarantee names the four automatic recall tags,
  and `<memory-updates>` may appear.
