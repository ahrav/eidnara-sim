# Tier report

`src/report/` turns finished run directories into the per-tier report.

## Soak

`soak(run, arm, resource)` reads an arm's resource samples (`rss`, `heap`,
or `store_bytes`) from its first nonzero sample on, and the journal's
session ends; it reports the longest wall-time gap between samples beside
the pre-registered `leak_bound.sample_interval_ms`; the sampler takes a
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
time at or before the sample's, so a sample taken while a session is
still closing belongs to the open session.

## Intrusiveness

`intrusiveness(run, arm)` gives, per arm:

| Metric | Source |
|---|---|
| Internal-string hits | The F7 oracle's patterns over every relayed agent response of the arm, each tagged with that source: the host shows the user each response of a turn, between tool calls as well as the last, so each is user-visible text; the user-sim reads only the last. Tool output shown to the agent has no capture to scan |
| Corrections referencing injected text | Delivered user-sim pushback and redirect replies (the `tape.jsonl` entries an arm's pairing records name by `tape_key`, fallbacks left out) that share a five-word run of Unicode letters, digits, and `_`, `-`, `[`, `]` with a memory note first delivered at least 1 s before the turn's `BeginTurn` (`<arm>/memory.json`; both times in the hosts' faked clock, `base_wall_ms` plus scenario time, whose offset is rounded to whole seconds), where neither four-word half of the run appears in the scripted user turns of the run's `scenario.json` up to and including that turn; a reply whose turn has no `BeginTurn` or no `UserTurn` with `delivered: true` is left out, since a pairing record alone is the user-sim's intent and a kill before the turn ended leaves it undelivered. `null` when `memory.json` records that the notes could not be read |
| Reverted edits | Tool runs that exited 0 holding `git revert`, `git restore` (unless `--staged` or `-S`, alone or in a cluster such as `-Sq`, appears among the options before `--` without `--worktree` or `-W`), `git checkout ... -- <pathspec>`, or `git reset --hard`, with or without `-C` or `-c` options, where every later command in the tool run is joined by `&&`, so the zero exit is the revert's too. A `git` invocation starts at a command position (line start, or after `;`, `&&`, `\|\|`, `\|`, `&`, or `(`, past `VAR=value` assignments and `sudo`, `env`, `time`, `nice`, `nohup`, or `exec`) and ends at its line; comments, quoted strings (which become one word), and the body lines of a heredoc opened outside quotes are set aside first, so `echo git restore x` and `echo 'git restore x'` are text and `git -C "a dir" restore f` keeps its shape |
| Turn latency | p50 and p95 of `prompt_ms` on each `EndTurn` with outcome `ok`: the host's prompt call alone, on the monotonic clock, after the user-sim has delivered the turn's text. Failed turns and hangs are dependability's |

A revert is counted on every arm, so the difference from the host arm is
the part memory can be held to.

## Cost

`costPanel(run, arm, grades)` sums calls and input, output, cache-read, and
cache-write tokens by component and prices them at the table the run's
manifest recorded when it started (`price_table`: today `v1`, USD 5, 25,
0.5, and 6.25 per million tokens for every model, from `src/run/price.ts`);
the panel names that version, and is `null` for a run whose manifest
recorded no table. The arm's total leaves out the harness's own user-sim and
refused calls, which it reports apart, and divides by the arm's
passing P1 to P12 items, each item at its highest graded version, for the
cost per useful retrieval. The arm driver writes `<arm>/memory.json` at
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
belongs to the run; it is `null` when the run was not graded or recorded
no table.

## Assembly

`scripts/report.ts <run dir>... [--out <dir>]` groups the runs by tier and
writes `report-<tier>.md` and the gate verdict as `report-<tier>.json`
through staged files renamed into place (an unbounded rate ratio is written
as the string `"Infinity"`), or prints the Markdown; it refuses a manifest
tier outside the registered literals and an `--out` inside
`sim.config.json`'s `eidnara_checkout`. `loadGraded` refuses a run directory whose manifest
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
| `failed_turns`, `hangs` | Per run (`<tier>-<host>-<seed>`), the distinct turns with an `EndTurn` outcome other than `ok` or an `Event` outcome `failed(interrupted)` (which a resume records for a turn without an `EndTurn`), and F4 activations |
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
schema, corpus manifest, and embedding model, the tapes it replayed, and the
preflight's toolchain probes) the runs disagree on, each run with
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
its band, each L run whose registered arms' `StartArm`/`EndArm` spans
share no common moment while `load_stress` registers concurrent arms, each registered A/A pair whose count
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
`cusumScale` gives each rule the scale of the tier its `sd_source` names
once that tier's own campaign is complete, so L's rules take M's A/A pairs
when the complete M runs are in the same `scripts/report.ts` invocation.
The scale pools the controls that reached `EndArm`.

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
