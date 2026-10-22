# Tier report

`src/report/` turns finished run directories into the per-tier report. The
evidence-path section (`## Evidence path`: per-probe stages and attributed
causes, session context health, and an arm comparison with flagged sessions
apart) comes from `bun scripts/evidence-run.ts` and `src/evidence/`
(`docs/evidence.md`); the gated panels below still count flagged-session
turns.

## Soak

`soak(run, arm, resource)` reads an arm's resource samples (`rss`, `heap`,
or `store_bytes`) and the journal's session ends. It is `null` when a
sample lacks the resource's field, as `heap` is absent from samples
written before the sampler recorded it, so a verdict never rests on the
suffix that has it; and for `rss` and `heap` when a sample with a process
lacks `start`, since two processes sharing a pid could then be told
apart only by a `pid: null` row between them. A row with a `pid` and a `null` `start` opens no generation; the strict loader refuses such a row, and the sampler writes `pid: null` with `start: null` when its stat read fails. Each daemon process is its own memory trajectory:
the `rss` and `heap` samples split into generations at every change of
`pid` (a daemon restart, a kill fault, or a resume), where a process is its
`pid` together with its start time `start` (clock ticks since boot, as a decimal string), so a replacement that
reuses the number after a resume still starts a new one, and a sample
with no process (`pid: null`) is a boundary of its own; each generation is judged from its first nonzero sample on,
and the verdict is the most decisive generation's (`leak`, then `no
leak`, then `insufficient samples`; at a tie the one with more samples),
with `generations` and the chosen `generation` reported. `store_bytes`
is one trajectory across processes. An arm with no sample of the
resource, such as the host arm's `rss`, has `generations: 0` and the
`insufficient samples` verdict. The verdict it reports the longest wall-time gap between sampler rows, rows taken
with the daemon down included, beside the pre-registered
`leak_bound.sample_interval_ms`; the sampler takes a
last sample when the arm finishes, after its final session end. That
first sample is
the baseline, `value(0)`, and a sample's `sessions` counts the session
ends completed after it, so growth before the baseline is in the
baseline and is granted no allowance twice. The `heap` is the
daemon's anonymous resident memory (`RssAnon`), which also counts other
anonymous mappings. The first tenth of the samples is the warmup and
the last tenth the cooldown; a least-squares fit of the steady window's
value against completed sessions gives the slope per session and R
squared. The verdict is `leak` when any of these holds:

- the slope exceeds `leak_bound.c_bytes_per_session` with R squared at or
  above `leak_bound.r2_threshold`;
- some sample breaks the bound `value(T) < 2 * value(0) + sessions(T) * c`,
  which the verdict carries with its `c`,
  which the verdict reports at its worst sample;
- for RSS and heap, the cooldown median sits more than `c` above the warmup
  median, so memory did not return to its baseline. A store keeps what it
  learns, so `store_bytes` has no return check.

Otherwise it is `no leak`. With no nonzero sample it is `insufficient
samples`; so is a steady window too short or too flat in sessions to fit
when the bound and return checks, which need no fit, both pass. A sample's
completed sessions are the session ends whose journal entry has a wall
time before the sample's; a tie at millisecond resolution, like a sample
taken while a session is still closing, belongs to the open session.

## Intrusiveness

`intrusiveness(run, arm)` gives, per arm:

| Metric | Source |
|---|---|
| Internal-string hits | Every match of every F7 pattern in every relayed agent response of the arm, each tagged with that source (the F7 oracle itself fires once per response); `null` when an agent response reached the proxy's `RESPONSE_TEXT_LIMIT` (262,144 characters) or carries `response_text_truncated`, an agent record without an `error` has no `response_text` field (the proxy writes one, empty when nothing was relayed, and omits it only on a call that failed before any text, so its absence on a clean call marks a record from before the capture), or a turn was interrupted (`ItemState` `failed(interrupted)` naming the turn's `event`; a scheduler fault's record precedes any turn and leaves the scan intact), since the recorded text may lack the suffix the user saw, or a streamed response has no record at all, and a scan of the records cannot clear the arm: the host shows the user each response of a turn, between tool calls as well as the last, so each is user-visible text; the user-sim reads only the last. `tool_output_hits` is SIM-P59's second source, tool output shown to the agent, and is `null`: the hosts record each tool run's command and exit status, so there is no tool output to scan |
| Corrections referencing injected text | Delivered user-sim pushback and redirect replies (the `tape.jsonl` entries an arm's pairing records name by `tape_key`, fallbacks left out; `null` when a delivered reply's record has no `tape_key`, as in a run begun before the key was recorded) that share a five-word run of Unicode letters, digits, and `_`, `-`, `[`, `]` with a memory note first delivered at least 1 s before the turn's `BeginTurn` (`<arm>/memory.json`; both times in the hosts' faked clock, `base_wall_ms` plus scenario time, whose offset is rounded to whole seconds), where neither four-word half of the run appears in the user's own text up to that turn, the scripted user turns of the run's `scenario.json` through the turn itself and the user-sim's replies before it that the journal shows delivered; a reply whose turn has no `BeginTurn` or no delivery evidence (a `UserTurn` with `delivered: true`, or an `EndTurn` with outcome `ok` and a `prompt_ms`, the record of a prompt that ran) is left out, since a pairing record alone is the user-sim's intent and a kill before the turn ended leaves it undelivered. `null` for a memory arm with no readable `memory.json`, whether it recorded `null` or the arm finished before the driver wrote the file; the host arm keeps no store and quotes nothing |
| Reverted edits | `null` when a turn was interrupted, since the host drains a turn's tool runs into `tools.jsonl` when the turn ends and a kill mid-turn loses the runs it had observed. Otherwise tool runs that exited 0 holding `git revert`, `git restore` (unless `--staged` or `-S`, alone or in a cluster such as `-Sq`, appears among the options before `--` without `--worktree` or `-W`), `git checkout ... -- <pathspec>`, or `git reset --hard`, with or without `-C <path>`, `-c <k>=<v>`, or other `--` global options such as `--no-pager` or `--git-dir=…` before the subcommand, where the invocation does not follow `||` (the shell may have skipped it) and every later command in the tool run is joined by `&&`, so the zero exit is the revert's too; trailing whitespace, a closing `;`, and comment-only lines end the command list, so `git restore f;` is the last command. A `git` invocation starts at a command position (line start, or after `;`, `&&`, `\|\|`, `\|`, `&`, or a grouping `(`; a `$(…)` substitution's status is the outer command's, so it is no position; past `VAR=value` assignments and `sudo`, `env`, `time`, `nice`, `nohup`, `exec`, or `command` with their `-x` options and `VAR=value` entries; an option taking a separate argument, as in `sudo -u bob`, is not read) and ends at its line; comments (`#` at a word start or after a control operator), unquoted backslash-newline continuations (joined), redirections such as `2>&1`, quoted strings, across lines too (which become the one word the shell passes, so `"-S"` keeps its meaning and a `git` inside `printf '…'` is text), and the body lines of a heredoc opened outside quotes are set aside first, so `echo git restore x` and `echo 'git restore x'` are text and `git -C "a dir" restore f` keeps its shape |
| Turn latency | p50 and p95 of `prompt_ms` on each `EndTurn` with outcome `ok`: the host's prompt call alone, on the monotonic clock, after the user-sim has delivered the turn's text. Failed turns and hangs are dependability's, and a turn the user-sim skipped (`UserTurn` with `delivered: false`) ran no prompt; a completed turn with a `prompt_ms` counts whether or not the journal holds a `UserTurn` for it. `null` when a completed, unskipped turn has no `prompt_ms`, as in a journal begun before the field existed, so the sample is never a suffix of the run |

A revert is counted on every arm, so the difference from the host arm is
the part memory can be held to.

## Cost

`costPanel(run, arm, grades)` sums calls and input, output, cache-read, and
cache-write tokens by component and prices them at the table the run's
manifest recorded when it started (`price_table`: today `v1`, USD 5, 25,
0.5, and 6.25 per million tokens for every model, from `src/run/price.ts`);
the panel names that version, and is `null` for a run whose manifest
recorded no table. It also carries the arm's token totals summed over
its calls directly, so SIM-P38's conservation (arm totals equal the
component sums) is auditable from the panel. The arm's total leaves out the harness's own user-sim and
refused calls, which it reports apart, and divides by the arm's
passing P1 to P12 items, each item at its highest graded version, for the
cost per useful retrieval; an item judged in several pairs (the host arm's
P7 against each memory arm, each grade naming that arm in `against`) passes when its
latest grade in every pair passes; `passes` and `usd_per_pass` are `null` until
`grade-summary.json`, which `bun scripts/grade-run.ts` removes when it
starts and writes when it finishes, shows `judge_errors: 0`, a `journal_seq` equal to the run journal's last
`seq`, and no skipped item in any arm other than P14's (which has no probe turn), so
a grading pass cut short, a rerun cut short, an ungraded run, a run
resumed after grading, or an item the grader skipped (no journaled
snapshot, a P7 pair without two completed snapshots) reports no total.
The whole panel is `null` for an arm with an interrupted turn
(`ItemState` `failed(interrupted)` naming its `event`), whose provider
request may have been billed with no `CallRecord` to price. The arm driver writes `<arm>/memory.json` at
`finish` for a daemon arm, with every memory note and its delivery count,
from which the panel reports the memory writes and the writes with zero
later reads; both are `null` for an arm with no `memory.json` (the host
arm) and for one whose `memory.json` records that the notes could not be
read.

The cost table's `TOTAL` row sums every component's calls and tokens; its
estimate is the arm's non-harness spend, as the heading states.
`judgeCost(run)` prices the P7 judge calls the grader wrote to
`judge-calls.jsonl` under its own arm `judge`, at the same recorded table.
A judge call compares a memory arm with the host arm, so the figure
belongs to the run; it is `null` when the run recorded no table or
grading did not finish under the same `grade-summary.json` conditions,
since a judge request in flight at a kill may be billed with no record.

## Assembly

`scripts/report.ts <run dir>... [--out <dir>]` groups the runs by tier and
writes `report-<tier>.md` and the gate verdict as `report-<tier>.json`
through staged files renamed into place (an unbounded rate ratio is written
as the string `"Infinity"`), or prints the Markdown; it refuses a manifest
tier outside the registered literals and an `--out` inside
`sim.config.json`'s `eidnara_checkout`. It exits 1 after writing when the
property witness holds a violated record, so a verdict over runs that
broke an invariant does not pass unremarked. `loadGraded` refuses a run
directory whose manifest
records a `prereg_sha256` other than the hash of the tier's current
pre-registration, or whose `scenario.json` hashes to other than the
manifest's `scenario_hash`, so a verdict carries the registration and the
scenario its runs were made under; a run started with `--faults` takes the
manifest's `fault_override` as its fault schedule, and its `faults.jsonl` lines, one per attempt, merge into the
proxy's fault witnesses, a fault once `fired` staying fired. `grades.jsonl` gives the
run its latest grade per item and arm, and every P7 judgment (latest per
item, arm, and `inputs`), so a P7 pair takes the host grade from the same
judgment as the treatment's (same `inputs` and judge verdicts, so a
re-grade interrupted between its two appends pairs nothing, and an item
with several complete judgments takes the newest), a P7
exclusion counts against its own judgment, and the host's P7 row in the accuracy and cost panels is its newest
complete judgment against `arms.default`; a judgment pairs only with `gate_eligible`
recorded `true`. Each run directory needs `grades.jsonl` from
`scripts/grade-run.ts` for its probe items; a run without one reports its
run-level metrics alone.

`tierInput` (`src/report/observe.ts`) builds the gate observations,
treatment arm (`arms.default`, `eidnara`) against `host`:

| Family metrics | Observation |
|---|---|
| `<type>.pass`, `<type>.harm` | Per probe item, both arms' grade metric joined by item id across runs (`<host>/<seed>/<item>`), clustered by `<seed>/<ledger fact>`, in issue order; `P8` and `P9` cross-session rates read `P8.pass` and `P9.pass` |
| `failed_turns`, `hangs` | Per run (`<tier>-<host>-<seed>`), the distinct turns with an `EndTurn` outcome other than `ok` or marked `failed(interrupted)` on resume (`Event` outcome or `ItemState`, recorded for a turn without an `EndTurn`), and F4 activations |
| `turn_latency_p50_delta_ms`, `turn_latency_p95_delta_ms` | Per run, the treatment minus control percentile of turn wall time; a control arm without turn latencies leaves the run out |
| `daemon_rss_growth_bytes_per_session`, `daemon_heap_growth_bytes_per_session`, `store_growth_bytes_per_session` | Per run, the treatment minus control soak slope, with a `host` control that runs no daemon counted as zero; the heap is the daemon's anonymous resident memory (`RssAnon`), which the sampler records as `heap` |
| `internal_string_hits`, `user_corrections_referencing_injected_text` | Per run, the panel's counts; a run without `calls.jsonl`, or with a completed turn no agent call with a response covers, has no hit count, and a daemon arm without `memory.json`, whose notes could not be read, or whose replies name a `tape_key` with no `tape.jsonl` has no corrections count; either leaves the observation |
| `reverted_memory_edits` | Per run, the treatment's reverted edits minus the control's; an arm without `tools.jsonl` has no count and leaves the observation; the zero-tolerance bound fails a run whose difference is above zero |
| `usd_per_component`, `usd_per_useful_retrieval` | Per run, the cost panel's total and cost per pass |
| `P13.fold_fidelity_score`, `P14.post_compaction_correction_count` | Per run, the mean (in percentage points, the family's scale) and the sum of the item metric over the items both arms graded without exclusion and outside the fault-asymmetric stratum |

Graded items the treatment or control arm excluded are listed as
excluded, and probe items of a session where a fault landed in one arm
only form the fault-asymmetric stratum; a fault landed where the
scheduler recorded `FaultObserved` or the proxy stamped a call's
`fault_ref`, which is how provider faults show. The input's `incomplete`
list names each pre-registered host and seed without a run, each run with
a pre-registered arm (`arms.run`) that has no `EndArm` entry, each run whose manifest
`events` stops short of its scenario's events, each manifest setting
(`eidnara_commit`, `models`, `context_limit`, the preflight's clock
`distortions`, its host versions, the scenario's generator, random
schema, corpus inputs digest, and embedding model, the digests the run
recorded of the tapes and pairing logs it replayed (`tape_sha256`), the
preflight's toolchain probes, the `grader` digests of the grades the
report uses, and the manifest's pinned execution identities: the Eidnara
working tree, the harness commit and working tree, and digests of the
corpus checkouts, the executables, the Bedrock route, the named tools,
and the price table, and `turns_await_jobs`, with a manifest from before
that field read as `true`) the runs disagree on, each run whose used
grades come from more than one grader, each run that lacks one metric of a
run-level family (the run then leaves every metric of that family, so the
family's metrics come from one set of runs), each run with
a scheduled proxy fault without its witness in `faults.jsonl`, each run made
with a fault override, each run with grades for
items outside its scenario's probes, for a metric of another probe type
than the item's, with a binary metric recorded as other than a boolean,
or with a P13 score outside `[0, 1]` or a P14 count that is not a
non-negative integer (any of which pairs nothing), each run without
`pairing.jsonl`, without a pairing record and a delivered `UserTurn` for a
scripted user turn in an analysed arm (the pair, every A/A control with its
arm, and their reference arms), or whose records fail the checks of
`scripts/pairing-check.ts` (`pairingFailures`: a pre-divergence reply
differing from the reference arm's, an altered probe or paste turn, an
unsent non-filler turn) or whose `UserSimRates` entry names a rate outside
its band, each registered A/A pair whose count
of control arms that reached `EndArm` across the runs differs from
`aa_controls.repeats`, each control arm whose pair lacks any registered metric of a P1
to P12 probe other than P7 (the judge grades P7 for memory arms against
`host` alone), each run-unit gate metric a run has no value for, each probe type,
P13 and P14 included, and each other item-unit family metric (the harm
metrics) with fewer paired items outside the excluded and
fault-asymmetric sets than `stopping_rule.paired_items_per_probe_type`,
each daemon arm resource whose soak verdict is `leak`, and each CUSUM rule
without its A/A scale; the tier passes only with an
empty list. Two runs with one host and seed, or a run outside the
pre-registered hosts and seeds, are refused. The input's `journal_seq_at_eval` records, per run id, the
last journal `seq` the observations read. `tierInput` and `tierReport` order the runs by the pre-registration's
hosts then seeds, so items tied in issue order and the falsification
set's pairs keep one order whatever order the directories arrive in.
`aaScale` takes the CUSUM rules' scale from the runs' A/A controls
(`<arm>~<tag>`), pooled over every control and leaving out the pairs'
fault-asymmetric items: the standard deviation of their paired item
differences, over the per-item maximum across the harm metrics, as the
harm statistic is built, and over the P1 items.
`cusumScale` gives each rule the scale the `cusum_sd` of
`<tier>-resizing.json` beside the run directories recorded from the
complete source campaign, else the scale of the tier its `sd_source`
names when that tier's complete runs are in the same `scripts/report.ts`
invocation. The scale pools the controls that reached `EndArm`. The same
file's `paired_items_per_probe_type` is the count the campaign-completeness
check uses for a resized tier and the number of pairs per item metric the
analysis reads, in issue order, so a compile rounded up per seed never
adds pairs past the recorded count; it is passed beside the
pre-registration so the verdict keeps the registered hash. A tier that
pre-registers resizing is reported only with its record, every run of
the tier binds to one identical record, and runs beside different
records are refused as one campaign.

The falsification set (`src/report/falsify.ts`) pairs, per run, each A/A
control with its arm, or else the treatment with `host`, and pools the
pairs: P1-control pass per item, the
gateway 4xx share per session with no scheduled fault, the pushback share
per session before the first divergence index in either arm, and the wall time the
harness spent from the preceding scripted event's completion (its `Event`
entry) to each scripted clock jump. On an A/B pair the daemon arm's
background work holds the clock, so the idle-gap check measures that work
there; the set is a zero-effect check on an A/A pair, and the report says
which pairs it used.

A run recorded before the sampler took the `heap` field has no heap
samples, so its `daemon_heap_growth_bytes_per_session` is `inconclusive`
and the resources gate fails until the run is repeated.

`renderTier` writes, in order: the runs, arms, and each run's recorded
clock distortions, the accuracy table by probe type in the v1
sweep report's layout, the gate verdict with every metric's n, difference,
interval (or the rate-ratio upper bound a sign-test gate decides on), p,
detectable difference, resolution ratio, verdict, and gate
result (a bound family shows its observed per-run values, or a binary
metric's treatment rate over the pairs the verdict kept), the campaign's
open requirements, the harm
panel, oracle activations with the uncovered list, recovery (a run with
an `untriggered` witness is named and left out of it, SIM-P32), soak for the
daemon arms per run with the longest sampling gap, intrusiveness with each arm's latency delta against its run's `host`,
cost with the run's judge calls priced once (`judgeCost`), the
falsification set with the pairs it used, the A/A reports (`<run>/aa.json`, each with its `run` and marked stale
when `grades.jsonl` is newer, or a note
that control arms ran without one), the claim boundary, and the
pre-registration. The soak, intrusiveness, and cost tables name each
row's run, and the intrusiveness table takes each arm's latency delta
against the `host` arm of the same run. It refuses a report whose own text, outside the
attached boundary and pre-registration, contains the word parity.

## Run conditions and continuity

`src/report/conditions.ts` opens the report with each run's conditions,
read from its manifest and arm directories: the events its furthest arm
reached against the events planned, and the planned prefix against the
scenario's total when it is a capped prefix; the time
interception outcome per binary from the preflight; and any transcript
store path the driver found missing after the first `session_end`, or
`<arm> unchecked` for an arm that never reached that check or whose
`transcripts.json` a stop cut short or left in another shape. It then
reads each host's transcripts back, Pi's session files under
`.pi/agent/sessions` (regular files under a real directory that resolves
inside the arm's directory; a symlinked root or entry, or a path that
leads outside the arm, is left unread) and OpenCode's `session` table in
`opencode.db` (a store that cannot be opened or queried yields no
sessions), and
compares each `sim-<session>` creation time with the session's scheduled
wall time (`base_wall_ms` plus the `session_start` event's scenario time). The table
names the reached sessions the store lacks (a transcript with no finite
creation time among them), says whether the creation
times follow scenario order, and gives the largest lead and lag; an arm
whose transcript check never ran reads `unchecked` there too. Hosts run at wall pace between clock jumps, so a
lead up to the idle wall time since the last jump is expected; a lag, or
an order break, is a D2 caveat for that host.

The continuity table gives each host and arm's P8 and P9 pass rate, over
non-excluded items, beside the v1
harness's cross-session recall (host 0 to 3%, Eidnara 99 to 100%). For
every pass it counts the passes whose turn ran a simple command whose
program is a reader or searcher (`cat`, `grep`, `rg`, `find`, `sqlite3`,
Pi's `read`, and the like) with the host's transcript store, as the
sandboxed agent names it (Pi's `agent/sessions`, OpenCode's
`opencode/opencode.db` or `opencode/storage`), among its words, so a
`host` pass is split between transcript search and the rest.
