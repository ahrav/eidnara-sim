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
| Internal-string hits | The F7 oracle's patterns over the agent's relayed responses, the text the user-sim reads, each tagged with that source; tool output shown to the agent has no capture to scan |
| Corrections referencing injected text | Delivered user-sim pushback and redirect replies (the tape entries an arm's pairing records name, fallbacks left out) that share a five-word run with a memory note first delivered at or before the turn's `BeginTurn` (`<arm>/memory.json`; both times in the hosts' faked clock, `base_wall_ms` plus scenario time), where neither four-word half of the run appears in the scripted user turns of the run's `scenario.json`; a reply whose turn has no `BeginTurn` is left out. `null` when `memory.json` records that the notes could not be read |
| Reverted edits | Tool runs that exited 0 of `git revert`, `git restore` (unless `--staged` or `-S`, alone or in a cluster such as `-Sq`, appears anywhere in the invocation without `--worktree` or `-W`), `git checkout ... --` within one command, or `git reset --hard`, with or without `-C` or `-c` options |
| Turn latency | p50 and p95 of each turn's `prompt_ms` on `EndTurn`: the host's prompt call alone, after the user-sim has delivered the turn's text |

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
