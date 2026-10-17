# Failure-class oracles

`src/oracle/` reads a run directory and reports each time a known failure
class fired. `loadRun` admits a complete run only, through the journal
check grading uses (`requireComplete`, SIM-P67): every scheduled event
ended once per arm, an `EndArm` per arm, and an `EndRun`; a `scenario.json`
whose digest differs from the manifest's `scenario_hash` is refused, and so
is a manifest tier other than the scenario's, a manifest arm outside the
pre-registered names, a manifest event count
outside 1 to the scenario's length, a scheduled user turn without one
`BeginTurn` and one `EndTurn` per arm (a turn the resume path closed as
`failed(interrupted)` has no `EndTurn`), a `BeginTurn` or `EndTurn` for an
unscheduled event, a call or tool run naming a turn outside the schedule, a
call with a negative token count, resource samples that name a pid on some
rows and not others, name a process start time on some rows and not others
or null against a pid, pair a reading with a null pid, or carry a negative
reading or run backwards in scenario time, a journal whose entries run
backwards in scenario time within an arm, a call attributed to a turn that
starts outside that turn's `BeginTurn` to `EndTurn` interval, a daemon arm with no numeric RSS sample, no reading in its final
sample, or no `daemon.log`, a manifest with no arms, a call whose status is
neither the proxy's `0` sentinel nor an HTTP status, whose end precedes its
start, or whose sequence number breaks the file's `0..n-1` order, a call record that fails the proxy's
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
| F4 hang | A turn that hit its deadline (the harness's own wording: OpenCode's `turn deadline <N> ms` or Pi's `Timed out after <N>ms`) with no agent call, or whose recorded activity (turn start, call starts and ends, tool starts, turn end) has a gap above `oracles.hang_quiet_ms`, so a turn active to its deadline is a long turn and a tool that waited on until the deadline is a hang; a turn that began and saw no agent call, tool start, or turn end within `oracles.hang_quiet_ms` (five minutes, SIM-P39), whatever its outcome (an auxiliary call alone is not agent activity); or an agent call that completed, whatever its status, and was followed by no tool start, other same-turn call starting at or after its end (a persistence call counts), or turn end within that bound: one activation per turn, its evidence naming every silent window; a tool that starts within a second of the call's end counts as progress however long it runs in a turn that completed, and its silence counts in a turn that hit the deadline |
| F5 RSS growth | A daemon lifetime's final RSS sample at or above `2 x RSS(0) + sessions x leak_bound.c_bytes_per_session` (SIM-P57's `RSS(T)` bound; a spike freed before the end is not a leak), or an RSS-per-session slope above that bound with a fit at or above `leak_bound.r2_threshold`; each daemon lifetime (the samples sharing a pid and process start time) is read on its own, with its first sample as RSS(0) and sessions counted from its start, so a restart hides no leak. The sampler records a sample when each daemon process is up (reset, resume, and after a fault's restart), one before a fault takes a daemon down, and a final sample when the arm finishes; a run whose daemon arm has no numeric RSS sample is refused by `loadRun` rather than read as leak-free |
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
F1 and F2, `transform` for F3, `memory_capture` for F8), and
`uncovered: true` when it never fired in that tier.
`scripts/oracle-run.ts <run dir>...` writes each run's activations, ledgers,
recoveries,
and the pre-registration digest it used to `<run>/oracles.json`, warns when
that digest differs from the one the run's manifest recorded, and prints the
report. A run directory named more than once, by any path, counts once;
`oracles.json` is written through a rename, so a symlink at that name is
replaced, never followed.

F1 misses an overflow the plugin hid by serving a raw history that still fit
the window; F3 counts those passes.

## Recovery

`recoveries(run)` reads each infrastructure fault the journal observed and
the turns that end after it, starting with the turn a mid-turn fault such
as `daemon_sigkill_mid_fold` interrupted, whose window opens at the fault.
A clean turn ends `ok`, has no gateway 4xx and no overflow among its calls,
and has no fail-open publication in the plugin log (`serving the input
unchanged`, `decision=error`) from its start until the next turn starts. A
pass the daemon declined by policy, such as `declined:invocation_budget`,
also serves raw history and counts toward F3, and leaves the turn clean.
The plugin stamps its log in the host's faked clock: wall time plus the
whole-second offset the harness journaled as `offset_s` at the arm's start
(`ClockOffset`) and on each clock jump (`AdvanceClock`). The oracle maps a stamp back to wall time through each
offset whose span contains the result and reads the turns' windows in the
journal's `wall_ms`; when an offset shrank, a stamp can fall in two spans and
counts in both turns. A journal without offsets, recorded
before the harness journaled them, is read as `base_wall_ms` plus
scenario time, which the offset's rounding and the idle wall time since the
last jump can skew; a journal whose turns began before its first offset is
refused, since neither reading covers its prefix. A stalled
daemon gives a turn that looks clean to the agent, and its fail-open
publication keeps the turn from counting.

For each fault the oracle reports `turns_to_first_clean` and `recovered`,
which is false with no clean turn after the fault, and lists the reasons.
The infrastructure faults are the scenario compiler's set
(`src/scenario/faults.ts`) plus `host_upgrade` and `two_hosts_one_daemon`.
A fault an arm skipped, such as a daemon fault on the `host` arm, has
`recovered: null` and the skip as its reason, so tallies leave it out.

A daemon restart (`daemon_restart`, `daemon_sigkill_mid_fold`) also needs a
sound store, which three checks of the store (`src/hosts/storecheck.ts`)
judge. The arm driver checks the store after the SIGKILL and before the
replacement daemon starts, which shows the state the crash left and keeps
the replacement's startup out of the baseline; at the first turn boundary
(a turn's start, or its end after its background jobs settle) at which the
plugin log, past its length at the restart, shows a pass the replacement
served (`served_from=transform`), so the check follows the turn whose passes
include the first pass after the crash, or else at the session's end, the
arm's finish, or a later daemon fault before it kills the daemon, and journals
that
check as `StoreChecked` with the fault's id (`event` names the turn or
session end, or is null at finish), one entry per restart it settles, written
before the turn's `EndTurn`; and
`finish` checks the final store after the daemon
stops and writes it to `<arm>/store-check.json`. Each check runs SQLite's
`integrity_check`, lists every history segment, and looks for segments of
one session whose message ranges overlap; the memory store refuses such a
segment on write ("ranges must be strictly increasing",
`crates/memory-store/src/lib.rs` in eidnara), so a stored overlap or a
duplicated segment means a write bypassed that refusal. A segment whose own
bounds are inverted passes SQLite's pragma, so the check appends it to the
integrity string (`ok; inverted range <session>/<sequence>`). A store that
fails to open reports `error: <reason>` as its integrity.

The wire contract's post-crash rule (`docs/host-wire-protocol.md` in
eidnara, the revert paragraph of the transform section) is that the next
pass after a crash folds from the surviving history and removes nothing
further. The oracle checks it as: each segment the crash check listed is
still present at the post-crash check with the same bounds and the same
digest of its message ids, title, and content, so a segment refolded within
the same bounds reads as changed. A check recorded before ranges carried
digests compares bounds only, which cannot certify the rule; the oracle names
that as a reason and withholds `recovered`. A host compaction in the
same turn can also remove segments under the contract's compaction rule;
the reason names the segments, so a maintainer can tell the two apart from
the turn's calls. `recovered` needs all three checks present, each with
integrity `ok` and no overlap, and the surviving segments kept; a missing
check is a reason of its own. `two_hosts_one_daemon` has no mechanism yet
(`docs/hosts.md`), so no run observes it, and the oracle has no check for
two clients reading one proposal.

The recorded `witness-8` eidnara arm reaches a clean turn after each of its
five faults: the laptop sleep, the restart, and the plugin reload at the
first later turn, and the model switch and full store at the second, because
the turn on the full store published a fail-open pass. The sleep's row comes
from its `FaultFired` and clock jump, since that run predates the sleep's
`FaultObserved` entry; the run also predates the store check, so its restart
is unrecovered for want of one.

In the live `recovery-3` run (S seed 101, Pi, eidnara arm, a 30000-token
context limit so that sessions fold), the daemon took a SIGKILL during the
history-summarizer calls of `s-0004` and `s-0005` and a restart at
`s-0005`'s start. Each restart left the one segment of `s-0003`; each
post-crash check and the final store kept it with integrity `ok` and no
overlap, by bounds. The `s-0005` faults reach a clean turn at the first
turn. The `s-0004` kill reaches one at the second: in the turn it cut, the
plugin logged a failed pass (`connection generation retired`) about a second
after the restart. The final store holds two segments of `s-0005` and none
of `s-0004`, whose only fold the kill cut. The run is the fixture
`tests/fixtures/recovery/recovery-3-eidnara.json`. Its store checks predate
the content digests, so the oracle withholds `recovered` from all three
faults with the reason `store ranges lack content digests`; a test that
empties its post-crash segment lists adds the removed segment as a second
reason. In `recovery-2`, a restart of an empty store behaved the same way,
and the plugin logged two `declined:invocation_budget` passes, which count
toward F3 and leave their turns clean.

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
