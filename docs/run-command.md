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
these values. The run refuses a seed outside the pre-registration, an arm
outside the seed's order, a non-positive count, a `--faults` file that is not
an array of complete episodes (known type and strategy, numeric params, a
seam, unique ids) valid against the compiled scenario (`validateFault`),
an `--out` directory that overlaps the Eidnara checkout in either direction
by resolved path (an output directory above the checkout would derive an arm
root inside it), a schedule with a fault type the host driver has no
mechanism for (`host_upgrade`, `two_hosts_one_daemon`, so a full XL run is
refused up front), a `--models` list that repeats an entry, and a
`model_switch` schedule with fewer than two models. A directory whose journal
already ends in `EndRun` is a completed run and is refused, so the sealed
journal gains no entry. Before taking the lease, every artifact the run appends to or
replaces (`journal.jsonl`, `calls.jsonl`, the manifest, the scenario, the
fault and preflight files, this process's staging names for the lease, the
scenario, and the manifest, and each arm's `resources.jsonl`, clock offset,
and `state.json`) must be a regular file or absent; a symlink there is
refused, and the scenario and manifest staging files are created
exclusively without following a link.

## Run sequence

1. Take the lease (`docs/run.md`). SIGINT and SIGTERM run the same teardown
   as a normal end, which runs once however many paths reach it, and exit
   with 130 or 143. After a signal, every driver call refuses with
   `HarnessFailure`, so the scheduler starts nothing the teardown has already
   passed; the teardown itself waits up to thirty seconds for every driver
   call in flight (a reset, resume, event, or fault, including a mid-fold
   fault overlapping its turn) before it stops the arm, so a daemon or host
   whose start is still pending is stopped rather than orphaned. Later
   signals wait for the teardown. The tier's `tier_wall_budget_ms` starts a
   timer at the same point; once it fires, every driver call refuses the
   same way, and a call that was in flight when it fired fails on return,
   so the run stops before `EndArm` and fails.
2. Open the journal, and compile the scenario into `scenario.json` on the
   first invocation. Every invocation recomputes the SHA-256 of the file's
   body and refuses a `scenario.json` whose `scenario_hash` differs, or one
   compiled for another tier or seed.
3. Run `preflight` (`docs/time.md`). On the first invocation, write
   `manifest.json` with the tier, seed, host, arm order, event count, context
   limit, models, fault override, scenario hash, pre-registration hash,
   eidnara commit, eidnara-sim commit, a digest of the eidnara-sim working
   tree's uncommitted content (tracked edits and untracked files), the
   SHA-256 of the daemon, OpenCode, and Pi executables, base wall time, and
   preflight result.
   A later invocation refuses when any option it states differs from the
   manifest, when the manifest's arm order names an arm outside the tier's
   pre-registered arms, when the scenario hash, pre-registration hash,
   eidnara commit, eidnara-sim commit, working-tree digest, or an executable
   digest changed, when an interception result
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
5. Run the scheduler over the arms. On resume, each started arm resumes
   through its driver.
6. At the end, or after a failure or signal, stop each arm's sampler and
   driver, stop the proxy, append this invocation's proxy-fault witness
   report to `faults.jsonl` (a completed run appends it before `EndRun`, so
   a sealed journal always has its witness line; teardown appends it only
   when that did not happen), close the journal, and release the lease. Each
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
over. The proxy's `observe` event for a background component (history
summarizer, memory capture, memory classifier, context researcher, title,
native compaction) registers a job, and the completion of that same call ends
it, whether its record was written or refused. The resource sampler takes a baseline sample when an arm starts,
one at the end of every user turn, and one per pre-registered interval, and
registers `daemon-cpu-<arm>` while the daemon's CPU fraction is above the
pre-registered threshold, with one job id per busy period. Both hold the
clock (SIM-P13, OQ-2). Job ids continue from the journal's count, so a
resumed run issues new ones. A job that holds the clock longer than the
pre-registered `job_deadline_ms` (20 minutes at S) after its own
`RegisterJob` stops the run with the held ids (SIM-L02). The sampler drops
an unterminated final sample when it reopens `resources.jsonl` on resume. A periodic sample that fails
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
`EndTurn`, then exits 0 with no turn rebilled, and every finished run ends
in `EndRun` with contiguous call `seq` values from 0 and no journal
invariant violation (including a repeated sleep jump). The summary parses
final journals and call records strictly; a corrupt complete line fails the
witness, while polling during a run tolerates an unterminated final line.
The scheduled and resume runs must also show their evidence per arm: every
deterministic fault of the set fired, every fault with a mechanism observed,
agent calls on both configured models, and no duplicate `Event` entry (the
mid-fold kills fire only when a summarizer call happens, so they are not
required).

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

