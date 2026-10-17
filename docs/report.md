# Tier report

`src/report/` turns finished run directories into the per-tier report.

## Soak

`soak(run, arm, resource)` reads an arm's resource samples (`rss`, `heap`,
or `store_bytes`) from its first nonzero sample on, and the journal's
session ends; it reports the longest wall-time gap between samples beside
the pre-registered `leak_bound.sample_interval_ms`. The `heap` is the
daemon's anonymous resident memory (`RssAnon`), which also counts other
anonymous mappings. The first tenth of the samples is the warmup and
the last tenth the cooldown; a least-squares fit of the steady window's
value against completed sessions gives the slope per session and R
squared. The verdict is `leak` when any of these holds:

- the slope exceeds `leak_bound.c_bytes_per_session` with R squared at or
  above `leak_bound.r2_threshold`;
- some sample breaks the bound `value(T) < 2 * value(0) + sessions(T) * c`,
  which the verdict reports at its worst sample;
- for RSS and heap, the cooldown median sits more than `c` above the warmup
  median, so memory did not return to its baseline. A store keeps what it
  learns, so `store_bytes` has no return check.

Otherwise it is `no leak`. With no nonzero sample, or a steady window too
short or too flat in sessions to fit, it is `insufficient samples`.

## Intrusiveness

`intrusiveness(run, arm)` gives, per arm:

| Metric | Source |
|---|---|
| Internal-string hits | The F7 oracle's patterns over the agent's relayed responses, the text the user-sim reads, each tagged with that source; tool output shown to the agent has no capture to scan |
| Corrections referencing injected text | Delivered user-sim pushback and redirect replies (the tape entries an arm's pairing records name, fallbacks left out) that share a five-word run with a memory note delivered before the turn (`<arm>/memory.json`; both times in the hosts' faked clock, `base_wall_ms` plus scenario time), where neither four-word half of the run appears in the scenario's scripted user text |
| Reverted edits | Tool runs of `git revert`, `git restore` (not `--staged`), `git checkout ... --` within one command, or `git reset --hard`, with or without `-C` or `-c` options |
| Turn latency | p50 and p95 of each turn's wall time from `BeginTurn` to `EndTurn` |

A revert is counted on every arm, so the difference from the host arm is
the part memory can be held to.

## Cost

`costPanel(run, arm, grades)` sums calls and input, output, cache-read, and
cache-write tokens by component and prices them at one table, `v1`, for
every model (USD 5, 25, 0.5, and 6.25 per million tokens); the panel names
the table. The arm's total leaves out the harness's own user-sim, judge,
and refused calls, which it reports apart, and divides by the arm's
passing P1 to P12 items for the cost per useful retrieval. The arm
driver writes `<arm>/memory.json` at `finish` with every memory note and
its delivery count, from which the panel reports the memory writes and the
writes with zero later reads.

## Assembly

`scripts/report.ts <run dir>... [--out <dir>]` groups the runs by tier and
writes `report-<tier>.md` and the gate verdict as `report-<tier>.json`, or
prints the Markdown. Each run directory needs `grades.jsonl` from
`scripts/grade-run.ts` for its probe items; a run without one reports its
run-level metrics alone.

`tierInput` (`src/report/observe.ts`) builds the gate observations,
treatment arm (`arms.default`, `eidnara`) against `host`:

| Family metrics | Observation |
|---|---|
| `<type>.pass`, `<type>.harm` | Per probe item, both arms' grade metric joined by item id across runs (`<seed>/<item>`), clustered by `<seed>/<ledger fact>`, in issue order; `P8` and `P9` cross-session rates read `P8.pass` and `P9.pass` |
| `failed_turns`, `hangs` | Per run, turns with an `EndTurn` outcome other than `ok` or marked `failed(interrupted)` on resume, each turn once; and F4 activations |
| `turn_latency_p50_delta_ms`, `turn_latency_p95_delta_ms` | Per run, the treatment minus control percentile of turn wall time |
| `daemon_rss_growth_bytes_per_session`, `daemon_heap_growth_bytes_per_session`, `store_growth_bytes_per_session` | Per run, the treatment minus control soak slope, with a `host` control that runs no daemon counted as zero; the heap is the daemon's anonymous resident memory (`RssAnon`), which the sampler records as `heap` |
| intrusiveness metrics | Per run, the panel's counts |
| `usd_per_component`, `usd_per_useful_retrieval` | Per run, the cost panel's total and cost per pass |
| `P13.fold_fidelity_score`, `P14.post_compaction_correction_count` | Per run, the mean and the sum of the item metric |

Graded items the treatment or control arm excluded are listed as
excluded, and probe items of a
session where a fault fired in one arm only form the fault-asymmetric
stratum. When the runs hold an A/A control (`<arm>~<tag>`), the standard
deviation of its paired item differences sets the CUSUM rules' scale: over
the per-item maximum across the harm metrics, as the harm statistic is
built, and over the P1 items.

The falsification set (`src/report/falsify.ts`) pairs the A/A control with
its arm, or else the treatment with `host`: P1-control pass per item, the
gateway 4xx share per session with no scheduled fault, the pushback share
per session before the treatment's divergence index, and the wall time the
harness spent before each scripted clock jump. On an A/B pair the daemon arm's
background work holds the clock, so the idle-gap check measures that work
there; the set is a zero-effect check on an A/A pair, and the report says
which pair it used.

A run recorded before the sampler took the `heap` field has no heap
samples, so its `daemon_heap_growth_bytes_per_session` is `inconclusive`
and the resources gate fails until the run is repeated.

`renderTier` writes, in order: the accuracy table by probe type in the v1
sweep report's layout, the gate verdict with every metric's n, difference,
interval, p, detectable difference, resolution ratio, verdict, and gate
result (a bound family shows its observed per-run values, or a binary
metric's treatment rate), the harm
panel, oracle activations with the uncovered list, recovery, soak for the
daemon arms with the longest sampling gap, intrusiveness with each arm's latency delta against `host`,
cost, the falsification set, the A/A reports (`<run>/aa.json`, or a note
that control arms ran without one), the claim boundary, and the
pre-registration. It refuses a report whose own text, outside the
attached boundary and pre-registration, contains the word parity.

## Run conditions and continuity

`src/report/conditions.ts` opens the report with each run's conditions,
read from its manifest and arm directories: the events its furthest arm
reached against the events planned, and the planned prefix against the
scenario's total when it is a capped prefix; the time
interception outcome per binary from the preflight; and any transcript
store path the driver found missing after the first `session_end`. It then
reads each host's transcripts back, Pi's session files under
`.pi/agent/sessions` and OpenCode's `session` table in `opencode.db`, and
compares each `sim-<session>` creation time with the session's scheduled
wall time (`base_wall_ms` plus the `session_start` event's scenario time). The table
says whether the creation times follow scenario order and gives the
largest lead and lag. Hosts run at wall pace between clock jumps, so a
lead up to the idle wall time since the last jump is expected; a lag, or
an order break, is a D2 caveat for that host.

The continuity table gives each host and arm's P8 and P9 pass rate, over
non-excluded items, beside the v1
harness's cross-session recall (host 0 to 3%, Eidnara 99 to 100%). For
every pass it counts the passes whose turn ran a command that reads the
host's transcript store, so a `host` pass is split between transcript
search and the rest.
