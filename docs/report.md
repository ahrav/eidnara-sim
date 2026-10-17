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

`judgeCost(run)` prices the P7 judge calls the grader wrote to
`judge-calls.jsonl` under its own arm `judge`, at the same recorded table.
A judge call compares a memory arm with the host arm, so the figure
belongs to the run; it is `null` when the run was not graded or recorded
no table.
