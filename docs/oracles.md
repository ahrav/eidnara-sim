# Failure-class oracles

`src/oracle/` reads a run directory and reports each time a known failure
class fired. `loadRun` admits a complete run only, through the journal
check grading uses (`requireComplete`, SIM-P67): every scheduled event
ended once per arm, an `EndArm` per arm, and an `EndRun`; a `scenario.json`
whose digest differs from the manifest's `scenario_hash` is refused. It
gathers, per arm, the call records, journal entries,
plugin log (`<arm>/r/eidnara.log`), daemon log (`<arm>/daemon.log`),
resource samples, and tool runs (`<arm>/tools.jsonl`, one line per tool run
with its turn). `runOracles` returns every activation with its arm, where it
happened, and the evidence.

| Oracle | Fires on |
|---|---|
| F1 fold-lag overflow | An HTTP 4xx call whose error says the prompt exceeds the context (`prompt is too long`, `ContextOverflow`, `input is too long`), or a failed turn whose outcome says so |
| F2 array-shape 400 | An HTTP 4xx call whose error names a message-array shape fault: roles that fail to alternate, an assistant prefill, a final assistant message, modified thinking blocks, or empty or non-list content |
| F3 raw-history fallback | A plugin `rust pass` line with `served_from=raw`, one per transform pass that served its input unchanged; the warning the plugin logs before a failed pass is not counted again; a pass the daemon declined by policy (`declined:invocation_budget`) also serves raw and counts |
| F4 hang | A turn that hit its deadline (OpenCode's `turn deadline` or Pi's `Timed out after ... ms`), with or without agent calls, or an agent call that completed and was followed by no tool start, other same-turn call (a persistence call counts), or turn end within `oracles.hang_quiet_ms` (five minutes, SIM-P39); a tool that starts within a second of the call's end counts as progress however long it runs, so a tool that waits forever surfaces at the deadline |
| F5 RSS growth | A daemon RSS sample at or above `2 x RSS(0) + sessions x leak_bound.c_bytes_per_session`, or an RSS-per-session slope above that bound with a fit at or above `leak_bound.r2_threshold`; each daemon lifetime (the samples sharing a pid) is read on its own, with its first sample as RSS(0) and sessions counted from its start, so a restart hides no leak. The sampler records RSS(0) when the arm starts and a final sample when the arm finishes |
| F6 cost | An arm whose total tokens exceed `oracles.cost_ratio_max` (1.5) times the host arm's, or that makes more title calls than the host arm: one activation per arm and run, its evidence naming each exceeded bound; until the report prices tokens (M7) this is a token ratio |
| F7 visible internal text | An agent response carrying plugin markup or diagnostics: history-segment tags, `eidnara` tags, context-researcher augmentation, `[eidnara]` log prefixes, or pass fields such as `row_version` and `served_from`; read from the recorded response text, the first 32,768 characters |
| F8 invalid memory-capture array | A plugin or daemon log line where the daemon refused capture output (`memory capture output rejected`, or the refusal reason: schema mismatch, unsupported version, size or decision bounds, an unclosed code fence, missing or unknown source ids) |
| F9 compaction ownership gap | An arm with host compaction off (`eidnara`, `eidnara-cf`) whose agent conversation overflowed (an agent-component or turn-level F1) and that made no native-compaction call |

A token count is input, output, cache-read, and cache-write tokens. `ledger`
sums them per component, leaving out the harness's own user-sim, judge, and
refused calls, and per-arm totals are the sum of the per-component totals
(SIM-P38).

`oracleReport(runs)` groups activations by tier and, for each oracle, gives
the count, the count per arm and per component (the call's component for
F1 and F2, `transform` for F3, `memory_capture` for F8), and `uncovered: true` when it never fired in that tier.
`scripts/oracle-run.ts <run dir>...` writes each run's activations, ledgers,
and the pre-registration digest it used to `<run>/oracles.json`, warns when
that digest differs from the one the run's manifest recorded, and prints the
report. A run directory named more than once, by any path, counts once.

F1 misses an overflow the plugin hid by serving a raw history that still fit
the window; F3 counts those passes.

## Fixtures

`tests/fixtures/oracle/` holds a known-bad and a known-good fixture for each
oracle, plus a mutant F7 fixture whose renamed markers the patterns still
catch, F4 known-bad fixtures with no model call in OpenCode's and Pi's
wording, and the recorded question-tool hang with its tool start logged.
Each file is the
per-arm logs one run would load, with the activation counts it must give and
its provenance.

| Recorded from | Fixtures |
|---|---|
| An eidnara-live OpenCode run (2026-09-25): `prompt is too long: 510702 tokens > 200000 maximum` | F1 bad |
| `witness-8` call records, resource samples, and daemon log | F1, F5, F8 good |
| `witness-2` summarizer HTTP 400s (temperature refusals) | F2 good |
| `witness-4` plugin log on the full store | F3 bad |
| `grade-2` plugin log, turn calls, tool runs, responses, and call records | F3, F4, F6, F7 good; F6 bad (`F6-bad-recorded`, the eidnara arm at 1.53 times the host arm's tokens) |
| `oc-3`, an OpenCode turn that waited on its question tool until the deadline; the harness then logged OpenCode tools on successful turns only, so the record holds no tool start | F4 bad |

The other known-bad fixtures are constructed: F2's array-shape refusals,
F5's steady RSS growth, F6's title calls, F7's markup, F8's capture
refusals, and F9's eidnara-arm overflow. Over the `grade-2` and `oc-4`
runs, `oracle-run.ts` reports F6 once (the eidnara arm at 1.53 times the
host arm's tokens) and F4 once, in a `grade-2` turn whose bash tool ran for
600 s; `grade-2` predates `tools.jsonl`, so that tool run is missing from
its logs. The other oracles are uncovered.
