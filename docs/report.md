# Tier report

`src/report/` turns finished run directories into the per-tier report.

## Soak

`soak(run, arm, resource)` reads an arm's resource samples (`rss`, `heap`,
or `store_bytes`) and the journal's session ends. It is `null` when a
sample lacks the resource's field, as `heap` is absent from samples
written before the sampler recorded it, so a verdict never rests on the
suffix that has it; and for `rss` and `heap` when a sample with a process
lacks `pid_started`, since two processes sharing a pid could then be told
apart only by a `pid: null` row between them. A row whose process stat read failed (`pid` set, `pid_started: null`) carries no value and opens no generation. Each daemon process is its own memory trajectory:
the `rss` and `heap` samples split into generations at every change of
`pid` (a daemon restart, a kill fault, or a resume), where a process is its
`pid` together with its start time `pid_started`, so a replacement that
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
| Internal-string hits | Every match of every F7 pattern in every relayed agent response of the arm, each tagged with that source (the F7 oracle itself fires once per response); `null` when an agent response reached the proxy's `RESPONSE_TEXT_LIMIT` (32,768 characters) or a turn was interrupted (`ItemState` `failed(interrupted)` naming the turn's `event`; a scheduler fault's record precedes any turn and leaves the scan intact), since the recorded text may lack the suffix the user saw, or a streamed response has no record at all, and a scan of the records cannot clear the arm: the host shows the user each response of a turn, between tool calls as well as the last, so each is user-visible text; the user-sim reads only the last. `tool_output_hits` is SIM-P59's second source, tool output shown to the agent, and is `null`: the hosts record each tool run's command and exit status, so there is no tool output to scan |
| Corrections referencing injected text | Delivered user-sim pushback and redirect replies (the `tape.jsonl` entries an arm's pairing records name by `tape_key`, fallbacks left out; `null` when a delivered reply's record has no `tape_key`, as in a run begun before the key was recorded) that share a five-word run of Unicode letters, digits, and `_`, `-`, `[`, `]` with a memory note first delivered at least 1 s before the turn's `BeginTurn` (`<arm>/memory.json`; both times in the hosts' faked clock, `base_wall_ms` plus scenario time, whose offset is rounded to whole seconds), where neither four-word half of the run appears in the user's own text up to that turn, the scripted user turns of the run's `scenario.json` through the turn itself and the user-sim's delivered replies before it; a reply whose turn has no `BeginTurn` or no delivery evidence (a `UserTurn` with `delivered: true`, or an `EndTurn` with outcome `ok` and a `prompt_ms`, the one record a kill between the two writes leaves) is left out, since a pairing record alone is the user-sim's intent and a kill before the turn ended leaves it undelivered. `null` for a memory arm with no readable `memory.json`, whether it recorded `null` or the arm finished before the driver wrote the file; the host arm keeps no store and quotes nothing |
| Reverted edits | Tool runs that exited 0 holding `git revert`, `git restore` (unless `--staged` or `-S`, alone or in a cluster such as `-Sq`, appears among the options before `--` without `--worktree` or `-W`), `git checkout ... -- <pathspec>`, or `git reset --hard`, with or without `-C <path>`, `-c <k>=<v>`, or other `--` global options such as `--no-pager` or `--git-dir=…` before the subcommand, where the invocation does not follow `||` (the shell may have skipped it) and every later command in the tool run is joined by `&&`, so the zero exit is the revert's too; trailing whitespace, a closing `;`, and comment-only lines end the command list, so `git restore f;` is the last command. A `git` invocation starts at a command position (line start, or after `;`, `&&`, `\|\|`, `\|`, `&`, or a grouping `(`; a `$(…)` substitution's status is the outer command's, so it is no position; past `VAR=value` assignments and `sudo`, `env`, `time`, `nice`, `nohup`, `exec`, or `command` with their `-x` options and `VAR=value` entries; an option taking a separate argument, as in `sudo -u bob`, is not read) and ends at its line; comments (`#` at a word start or after a control operator), unquoted backslash-newline continuations (joined), redirections such as `2>&1`, quoted strings, across lines too (which become the one word the shell passes, so `"-S"` keeps its meaning and a `git` inside `printf '…'` is text), and the body lines of a heredoc opened outside quotes are set aside first, so `echo git restore x` and `echo 'git restore x'` are text and `git -C "a dir" restore f` keeps its shape |
| Turn latency | p50 and p95 of `prompt_ms` on each `EndTurn` with outcome `ok`: the host's prompt call alone, on the monotonic clock, after the user-sim has delivered the turn's text. Failed turns and hangs are dependability's, and a turn the user-sim skipped (`UserTurn` with `delivered: false`) ran no prompt; a completed turn with a `prompt_ms` counts whether or not its `UserTurn` was journaled. `null` when a completed, unskipped turn has no `prompt_ms`, as in a journal begun before the field existed, so the sample is never a suffix of the run |

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
cost per useful retrieval; `passes` and `usd_per_pass` are `null` until
`grade-summary.json`, which `bun scripts/grade-run.ts` removes when it
starts and writes when it finishes, shows `judge_errors: 0`, a `journal_seq` equal to the run journal's last
`seq`, and no skipped item other than P14's (which has no probe turn), so
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

`judgeCost(run)` prices the P7 judge calls the grader wrote to
`judge-calls.jsonl` under its own arm `judge`, at the same recorded table.
A judge call compares a memory arm with the host arm, so the figure
belongs to the run; it is `null` when the run was not graded or recorded
no table.
