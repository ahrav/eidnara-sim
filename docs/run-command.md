# Run command

`scripts/run-tier.ts` runs one tier and seed against Pi or OpenCode through
the capture proxy, the clock, the scheduler, and the arm drivers
(`docs/hosts.md`). `src/run/run.ts` wires them together.

```sh
PATH=<opencode release>/node_modules/.bin:$PATH \
bun scripts/run-tier.ts --tier S --seed 101 --out runs/S-101-pi \
    [--host pi|opencode] [--arms host,eidnara] [--events N] \
    [--faults episodes.json] [--context-limit N] [--models a,b]
```

The v1 harness closure resolves `opencode` through a shell, and that shell
sees the `PATH` the harness started with, so the run refuses to start
unless the pinned OpenCode release's `node_modules/.bin` is on `PATH`.

`--arms` keeps the listed arms of the seed's pre-registered order, and
`--events N` runs the first N scenario events. `--faults` replaces the
scenario's fault schedule, `--context-limit` sets the model window the host
sees (200,000 by default), and `--models` lists the models `model_switch`
cycles through (`agent_model` by default). The manifest records every one of
these values. An argument outside this list, an option without a value, or
an empty model name is refused. The run refuses a seed outside the pre-registration, an arm
outside the seed's order, a non-positive count, a `--faults` file that is not
an array of complete episodes (known type and strategy, numeric params with
probabilities in [0, 1], positive integer counts, non-negative durations and
timeouts, a `single` strategy for scheduler-layer faults (`persistent` for
`store_full`), `count` for a `burst`, and `probability` and `calls` for an
`intermittent`, a seam, unique ids, and a `session_start` trigger for the
between-session faults `laptop_sleep`, `daemon_restart`, `plugin_reload`,
`model_switch`, and `store_full`) valid against the compiled scenario
(`validateFault`); the compiled scenario's own faults pass the same checks
when `scenario.json` is loaded,
an `--out` directory that overlaps the Eidnara checkout in either direction
by resolved path (an output directory above the checkout would derive an arm
root inside it), a schedule with a fault type the host driver has no
mechanism for (`host_upgrade`, `two_hosts_one_daemon`, so a full XL run is
refused up front), a `--models` list that repeats an entry, and a
`model_switch` schedule with fewer than two models. A `daemon_sigkill_mid_fold` needs a
`first_summarizer_call` trigger. An `--out` inside this checkout must be
ignored by git (`runs/` is), and may not overlap a corpus checkout, since
both trees are part of the run identity. Before taking the lease, every artifact the run appends to or
replaces (`journal.jsonl`, `calls.jsonl`, the manifest, the scenario, the
fault and preflight files, this process's staging names for the lease, the
scenario, and the manifest, and each arm's `resources.jsonl`, clock offset,
`state.json`, `daemon.log`, `store.img`, and `transcripts.json`, plus this
process's staging names for the clock offset and `state.json`) must be absent or a regular file with a single link (the arm,
clock, `r`, `s`, `interception`, `toolbin`, and `hostbin` directories must be
directories; the OpenCode wrapper and its staging name under `hostbin/<arm>`
are checked the same way); a symlink, a hard link, or another
file type there is refused. Every staged write (scenario, manifest, clock
offset, `state.json`, the sandbox launcher) creates its staging file
exclusively without following a link, then renames it into place, and the
toolchain wrappers are created exclusively after removing any planted name.

## Run sequence

1. Take the lease (`docs/run.md`). SIGINT and SIGTERM run the same teardown
   as a normal end, which runs once however many paths reach it, and exit
   with 130 or 143. After a signal, every driver call refuses with
   `HarnessFailure`, so the scheduler starts nothing the teardown has already
   passed; the teardown itself waits up to thirty seconds for every driver
   call in flight (scenario compilation and preflight, or a reset, resume,
   event, fault, or finish, including a mid-fold
   fault overlapping its turn) before it stops the arm, so a daemon or host
   whose start is still pending is stopped rather than orphaned. Later
   signals wait for the teardown. The tier's `tier_wall_budget_ms` starts a
   timer at the same point; once it fires, every driver call refuses the
   same way, the scheduler's idle wait and next step fail at once, and a
   call that was in flight when it fired fails on return, so the run stops
   before `EndArm` and fails. A turn or job in flight is bounded by its own
   deadline (15 or 20 minutes), so the overrun past the budget is at most
   that long.
2. Open the journal, and compile the scenario into `scenario.json` on the
   first invocation. Every invocation recomputes the SHA-256 of the file's
   body and refuses a `scenario.json` whose `scenario_hash` differs, one
   compiled for another tier or seed, one whose project ids are not plain
   names, one with a repeated event id, an unknown event kind, a non-numeric
   or decreasing `scenario_ms`, a missing session, a turn without an index,
   or one whose events name an undeclared project. A directory whose
   journal already ends in `EndRun` is refused before the scenario is read or
   preflight runs, so a sealed run's artifacts stay untouched.
3. Run `preflight` (`docs/time.md`). On the first invocation, write
   `manifest.json` with the tier, seed, host, arm order, event count, context
   limit, models, fault override, scenario hash, pre-registration hash,
   eidnara commit and working-tree digest, eidnara-sim commit and
   working-tree digest (a digest covers tracked edits and untracked
   unignored files), the commit and working-tree digest of every corpus
   checkout the scenario's projects clone from, the SHA-256 of the daemon,
   OpenCode, and Pi executables, the Node runtime Pi runs on, the libfaketime
   interposer, and the OpenCode SDK module the host stack imports (`absent`
   when not installed), the
   Bedrock region and profile name, base wall time, and preflight result. The working-tree digest hashes an
   untracked symlink's target text.
   A later invocation refuses a manifest whose `schema` is not
   `sim-run-manifest/v1`, and refuses when any option it states differs from
   the manifest, when the manifest's arm order is not a non-empty subsequence
   of the tier's pre-registered arms, when any of those digests changed, when an
   interception result, probed path, or toolchain version
   changed, or when the selected host's version or transcript paths changed,
   and appends its preflight result to `preflight.jsonl`; on resume the
   mechanism checks (fault types, models) run against the manifest's saved
   values, so omitted options inherit. Every invocation
   then journals a `Preflight` entry with its interception results and host
   identities before `StartRun` or `ResumeRun` (SIM-P16).
4. Start the capture proxy; its records append to `calls.jsonl`, and a
   reopened writer continues the sequence after the last complete record. A
   cut last line is dropped; a complete line that is not a record in
   sequence refuses the run. The fault injector replays the existing
   records, so a fault injected and observed before a hard kill keeps its
   witness in the resumed run. Witnesses are kept per arm: the scheduler arms
   each proxy fault for the arm it is running, and `faults.jsonl` lists one
   witness per arm and episode.
5. Run the scheduler over the arms. On resume, each started arm first reaps
   the processes its state file records, then resumes through its driver.
   An arm ends only after its busy set drains twice: after its last event,
   and again after the driver's shutdown, which can still register a job or
   trigger a mid-fold kill that the arm then awaits.
6. At the end, or after a failure or signal, stop each arm's sampler and
   driver, stop the proxy, append this invocation's proxy-fault witness
   report to `faults.jsonl` (a completed run appends it before `EndRun`, so
   a sealed journal always has its witness line; teardown appends it only
   when that did not happen), close the journal, and release the lease. A
   request's arrival hook, completion hook, or release that fails to journal
   its job is recorded as a handler failure and fails the run at the next
   verification; the busy set still clears. A handler that settles after the
   proxy's drain gave up on it writes no record and ends no job; it is
   recorded as a failure instead. Each call's record carries the wall time of
   its first byte and the call order of its arrival. Each
   step runs even when an earlier one fails, and the first failure is
   rethrown after the last step, so the command exits nonzero. Stopping the
   proxy aborts in-flight handlers and waits up to ten seconds for them to
   write their call records; a handler still active after that is recorded
   as a failure. The scheduler asks the run to verify before it writes
   `EndArm` and before `EndRun`: a handler failure (for example, a refused
   call record) or a sampler failure leaves the entry unwritten and fails
   the run, and the same check runs again at teardown. Before an arm
   finishes, a daemon that has exited outside a scheduled outage is reported
   through the scheduler and fails the run.

The scheduler's `onClock` hook writes each arm's offset file, so every
process the arm launches reads `base_wall_ms + scenario_ms`. Every request
registers a `request-<n>` job from its first byte, released once the call is
classified or the upload is abandoned, so an upload that outlives its turn or
straddles the settle period holds the clock until the classified call takes
over. The proxy's `observe` event for every classified call registers a job named
after its component, and the completion of that same call ends it, whether
its record was written or refused, so a call that outlives its turn (for
example, a provider timeout longer than the turn deadline) holds the clock
until its record is final. A `RegisterJob` append that fails leaves the busy
set untouched and is recorded as a handler failure. The resource sampler takes a baseline sample when an arm starts, one at the
end of every user turn and another two seconds later while a `settle-cpu`
job holds the clock, so daemon work that follows a turn is measured before
the clock may jump, and one per pre-registered interval, and
registers `daemon-cpu-<arm>` while the daemon's CPU fraction is above the
pre-registered threshold, with one job id per busy period. The post-turn hold
timers are owned by the run: teardown cancels any still pending and ends
their holds before the journal closes. Both hold the
clock (SIM-P13, OQ-2). Job ids continue from the journal's count, so a
resumed run issues new ones. A job that holds the clock longer than the
pre-registered `job_deadline_ms` (20 minutes at S) after its own
`RegisterJob`, measured on the monotonic clock, stops the run with the held
ids (SIM-L02). The sampler drops an unterminated final sample when it
reopens `resources.jsonl` on resume. Every host launch uses the launcher
this invocation's preflight wrote and probed. A periodic sample that fails
(for example, a full disk under `resources.jsonl`) stops the sampler and the
run the same way a signal does, so the teardown runs.

## Journal check

`checkJournal(entries, schedule)` reads a journal against the scenario's
event times and reports, per arm:

| Field | Meaning |
|---|---|
| `decreasing_scenario_ms` | entries whose `scenario_ms` falls below the arm's previous entry (SIM-P11) |
| `advance_while_busy` | `AdvanceClock` entries while a turn or job is open, counting an interrupted turn and a job ended on resume as closed (SIM-P12) |
| `off_schedule_jumps` | jumps, event or sleep, that land anywhere but the earliest unrun scheduled time at or after `from_ms` (SIM-P14, SIM-P18); a sleep is the jump onto its session's first event, so its size is the remaining gap, not the nominal `duration_ms` |
| `events_inside_sleep` | sleep jumps that pass an unrun scheduled event (SIM-P18) |
| `repeated_sleeps` | a second sleep jump for the same fault in one arm |
| `missing_events` | scheduled events an arm never journaled as `Event` although it reached `EndArm` |
| `out_of_order_events` | `Event` entries unknown to the schedule or breaking its order |
| `jump_origin_mismatch` | `AdvanceClock` entries whose `from_ms` differs from the arm's preceding `scenario_ms`; crossing checks use the observed value |
| `jobs_held_after_turn` | jobs that held the clock while no turn was open, whether registered after the turn or registered inside it and outliving it, once per job at its `RegisterJob` seq (SIM-P13) |
| `next_event_jumps`, `sleep_jumps` | how many jumps of each kind the check covered |

## Live witness

`tests/witness-faults.ts <dir> [scheduled,rogue,resume]` runs three live
runs of the S scenario for seed 101 on Pi with a 24,000-token context window,
so folds happen within six sessions, and writes `witness.json`:

- `scheduled` runs the `host` and `eidnara` arms over the first six
  sessions with one fault of each M4 infrastructure type, a two-minute laptop
  sleep at the fourth session's start (shorter than the idle gap before it),
  a mid-fold SIGKILL in five sessions, and two models;
- `rogue` runs the `eidnara` arm with an empty fault list while the script
  sends SIGKILL to the daemon during the second session's turn;
- `resume` runs the `eidnara` arm over four sessions with a model switch at
  the third and a full store at the fourth, sends SIGKILL to the harness once
  the third session's turn has made its first model call, runs the same
  command again, and compares each turn's call count before and after.

`--summarize` rebuilds `witness.json` from an existing directory. The
script exits nonzero when a run it started exits unexpectedly, never
reaches the awaited state within twenty minutes, or runs past the S wall
budget plus five minutes (it is then killed and reported `timed_out`), or
when a check fails:
`scheduled` exits 0, `rogue` exits nonzero with the daemon-exit refusal,
`resume` is killed with 137 while `e-000007` has `BeginTurn` and no
`EndTurn`, then exits 0 with no turn rebilled and exactly one `ItemState
failed(interrupted)` and one `Event failed(interrupted)`, both for
`e-000007`, and every finished run ends
in `EndRun` with contiguous call `seq` values from 0 and no journal
invariant violation (including a repeated sleep jump). The summary parses
final journals and call records strictly; a corrupt complete line fails the
witness, while polling during a run tolerates an unterminated final line.
The scheduled and resume runs must also show their evidence per arm: every
deterministic fault of the set fired, every fault with a mechanism observed
(on `eidnara`, the restart with a new daemon pid and `restarted_by: harness`,
the full store with `avail_kb: 0`), one fault-tagged sleep jump per arm and
sleep, agent calls on both configured models, and no duplicate `Event` entry
(the mid-fold kills fire only when a summarizer call happens, so they are not
required); the scheduled run must hold the clock with at least one job while
no turn is open (SIM-P13), and every finished run's journal must open with a
`Preflight` entry, before `StartRun` or `ResumeRun`, whose probed binaries
all intercepted, hold exactly one `EndArm` per arm the manifest names, and
include at least one ordinary event jump. All three case directories must be
present.
Every summarized directory must have been written by the current harness
revision and working tree (`sim_commit`, `sim_worktree`), so a rerun of one
case cannot certify stale evidence from another. These checks run on every
summarized directory, with or without a cached launch outcome.

Runs on 2026-10-16 against eidnara `bb866266c` (`witness-8`; `resume` ran
again after the store image grew to 2 GiB):

| Check | Result |
|---|---|
| Run outcomes | `scheduled` exit 0; `rogue` exit 1 with `daemon exited outside a scheduled outage window` after `e-000004`; `resume` killed with 137, then exit 0 |
| Faults | each arm fired the sleep and all five M4 scheduler faults; on `host`, the daemon and store faults recorded `skipped`; on `eidnara`, the restart recorded a new pid and `restarted_by: harness`, and the full store recorded `avail_kb: 0` |
| Full store | the Eidnara log holds `database or disk is full` 2 times in `scheduled` and 35 in `resume` (`full_store_enospc_log_lines`; the log line alone does not show what the transform returned) |
| Turns | 11 of 11 `ok` on each arm of `scheduled` |
| Models in agent calls | Opus 5.5, then Haiku 4.5 after the switch, on both arms |
| Journal invariants | 7 event jumps and 2 sleep jumps checked: no decreasing `scenario_ms`, no jump while busy, no off-schedule jump, no event inside a sleep |
| Jobs registered with nothing else open | 6 in `scheduled`: two native compactions on `host` and four memory captures on `eidnara` |
| Resume | the kill landed after `e-000007` made its first model call; that turn journaled `failed(interrupted)` once, the run continued at `e-000008`, reopened no completed turn, and ran `e-000010` and `e-000011` on the switched model with the store image mounted again and then filled; every turn recorded before the kill had the same call count after the resume, and call `seq` values stayed unique |

Those runs made no history-summarizer call, so no mid-fold SIGKILL fired.
An earlier run of the witness on 2026-10-16 (`witness-4`, Eidnara arm only,
before the read-only toolchain and the per-arm finish) fired it in the three
of five sessions that made a summarizer call; each restart recorded a new
daemon pid, and every later turn completed.

