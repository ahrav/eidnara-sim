# Failure-class oracles

`src/oracle/` reads a run directory and reports each time a known failure
class fired. `loadRun` admits a complete run only, through the journal
check grading uses (`requireComplete`, SIM-P67): every scheduled event
ended once per arm, an `EndArm` per arm, and an `EndRun`; a `scenario.json`
whose digest differs from the manifest's `scenario_hash` is refused, and so
is a manifest arm outside the pre-registered names, a manifest event count
outside 1 to the scenario's length, a scheduled user turn without one
`BeginTurn` and one `EndTurn` per arm (a turn the resume path closed as
`failed(interrupted)` has no `EndTurn`), a `BeginTurn` or `EndTurn` for an
unscheduled event, a call or tool run naming a turn outside the schedule, a
call with a negative token count, resource samples that name a pid on some
rows and not others or pair a reading with a null pid, a daemon arm with no
numeric RSS sample or no `daemon.log`, a call record that fails the proxy's
record contract (`recordProblems`), names an arm outside the manifest, or
repeats a sequence number, a journal entry, resource sample, or tool run
missing a field (an `EndTurn` needs its `outcome`), or an evidence file with
a line that does not parse. It gathers, per arm, the call records, journal entries,
plugin log (`<arm>/r/eidnara.log`), daemon log (`<arm>/daemon.log`),
resource samples, and tool runs (`<arm>/tools.jsonl`, one line per tool
report with its turn; a Pi run with a `call` id is reported at its start with
a null exit and again at its end, so it has two lines with one start time). `runOracles` returns every activation with its arm, where it
happened, and the evidence.

| Oracle | Fires on |
|---|---|
| F1 fold-lag overflow | An HTTP 4xx call whose error says the prompt exceeds the context (`prompt is too long`, `ContextOverflow`, `input is too long`), or a failed turn whose outcome says so and whose agent calls carry no overflow wording of their own, at any status (an auxiliary call's overflow in the same turn leaves the turn's activation in place; an agent 5xx with overflow wording keeps the turn out of F1) |
| F2 array-shape 400 | An HTTP 4xx call whose error names a message-array shape fault: roles that fail to alternate, an assistant prefill, a final assistant message, modified thinking blocks, or empty or non-list content |
| F3 raw-history fallback | A plugin `rust pass` line with `served_from=raw`, one per transform pass that served its input unchanged; the warning the plugin logs before a failed pass is not counted again; a pass the daemon declined by policy (`declined:invocation_budget`) also serves raw and counts |
| F4 hang | A turn that hit its deadline (OpenCode's `turn deadline` or Pi's `Timed out after ... ms`) with no agent call, or whose recorded activity (turn start, call starts and ends, tool starts, turn end) has a gap above `oracles.hang_quiet_ms`, so a turn active to its deadline is a long turn and a tool that waited on until the deadline is a hang; a turn that began and saw no agent call, tool start, or turn end within `oracles.hang_quiet_ms` (five minutes, SIM-P39), whatever its outcome (an auxiliary call alone is not agent activity); or an agent call that completed, whatever its status, and was followed by no tool start, other same-turn call starting at or after its end (a persistence call counts), or turn end within that bound: one activation per turn, its evidence naming every silent window; a tool that starts within a second of the call's end counts as progress however long it runs in a turn that completed, and its silence counts in a turn that hit the deadline |
| F5 RSS growth | A daemon lifetime's final RSS sample at or above `2 x RSS(0) + sessions x leak_bound.c_bytes_per_session` (SIM-P57's `RSS(T)` bound; a spike freed before the end is not a leak), or an RSS-per-session slope above that bound with a fit at or above `leak_bound.r2_threshold`; each daemon lifetime (the samples sharing a pid) is read on its own, with its first sample as RSS(0) and sessions counted from its start, so a restart hides no leak. The sampler records a sample when each daemon process is up (reset, resume, and after a fault's restart), one before a fault takes a daemon down, and a final sample when the arm finishes; a run whose daemon arm has no numeric RSS sample is refused by `loadRun` rather than read as leak-free |
| F6 cost | An arm whose total tokens exceed `oracles.cost_ratio_max` (1.5) times the host arm's, or that makes more title calls than the host arm: one activation per arm and run, its evidence naming each exceeded bound; until the report prices tokens (M7) this is a token ratio |
| F7 visible internal text | An agent response carrying plugin markup or diagnostics: history-segment tags, `eidnara` tags, context-researcher augmentation, `[eidnara]` log prefixes, or pass fields such as `row_version` and `served_from`; read from the recorded response text, the first 262,144 characters; a call whose text ran past that cap carries `response_text_truncated` |
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
report. A run directory named more than once, by any path, counts once;
`oracles.json` is written through a rename, so a symlink at that name is
replaced, never followed.

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
