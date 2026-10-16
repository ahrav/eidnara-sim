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
an array of episodes valid against the compiled scenario (`validateFault`),
and an `--out` directory inside the Eidnara checkout, by resolved path.

## Run sequence

1. Take the lease (`docs/run.md`). SIGINT and SIGTERM run the same teardown
   as a normal end, which runs once however many paths reach it, and exit
   with 130 or 143. After a signal, every driver call refuses with
   `HarnessFailure`, so the scheduler starts nothing the teardown has already
   passed, and later signals wait for the teardown. The tier's
   `tier_wall_budget_ms` starts a timer at the same point; once it fires,
   every driver call refuses the same way, so the run stops at the next
   event and fails.
2. Open the journal, and compile the scenario into `scenario.json` on the
   first invocation. Every invocation recomputes the SHA-256 of the file's
   body and refuses a `scenario.json` whose `scenario_hash` differs, or one
   compiled for another tier or seed.
3. Run `preflight` (`docs/time.md`). On the first invocation, write
   `manifest.json` with the tier, seed, host, arm order, event count, context
   limit, models, fault override, scenario hash, pre-registration hash,
   eidnara commit, base wall time, and preflight result. A later invocation
   refuses when any option it states differs from the manifest, when the
   scenario hash, pre-registration hash, or eidnara commit changed, when
   an interception result changed, or when the selected host's version or
   transcript paths changed, and appends its preflight result to
   `preflight.jsonl`.
4. Start the capture proxy; its records append to `calls.jsonl`, and a
   reopened writer continues the sequence after the last complete record. A
   cut last line is dropped; a complete line that fails to parse refuses the
   run. The fault injector replays the existing records, so a fault injected
   and observed before a hard kill keeps its witness in the resumed run.
5. Run the scheduler over the arms. On resume, each started arm resumes
   through its driver.
6. At the end, or after a failure or signal, stop each arm's sampler and
   driver, stop the proxy, append this invocation's proxy-fault witness
   report to `faults.jsonl`, close the journal, and release the lease. Each
   step runs even when an earlier one fails, and the first failure is
   rethrown after the last step, so the command exits nonzero. Stopping the
   proxy aborts in-flight handlers and waits up to ten seconds for them to
   write their call records. A handler failure recorded during the run (for
   example, a refused call record) fails the run after the scheduler ends
   and again at teardown.

The scheduler's `onClock` hook writes each arm's offset file, so every
process the arm launches reads `base_wall_ms + scenario_ms`. The proxy's
`observe` event for a background component (history summarizer, memory
capture, memory classifier, context researcher, title, native compaction)
registers a job, and that call's record ends it; jobs are matched per arm and
component. The resource sampler takes a baseline sample when an arm starts,
one at the end of every user turn, and one per pre-registered interval, and
registers `daemon-cpu-<arm>` while the daemon's CPU fraction is above the
pre-registered threshold, with one job id per busy period. Both hold the
clock (SIM-P13, OQ-2). Job ids continue from the journal's count, so a
resumed run issues new ones. A job that holds the clock longer than the
pre-registered `job_deadline_ms` (20 minutes at S) after its `RegisterJob`
stops the run with the held ids (SIM-L02).

## Journal check

`checkJournal(entries, schedule)` reads a journal against the scenario's
event times and reports, per arm:

| Field | Meaning |
|---|---|
| `decreasing_scenario_ms` | entries whose `scenario_ms` falls below the arm's previous entry (SIM-P11) |
| `advance_while_busy` | `AdvanceClock` entries while a turn or job is open, counting an interrupted turn and a job ended on resume as closed (SIM-P12) |
| `off_schedule_jumps` | jumps, event or sleep, that land anywhere but the earliest unrun scheduled time after `from_ms` (SIM-P14, SIM-P18); a sleep is the jump onto its session's first event, so its size is the remaining gap, not the nominal `duration_ms` |
| `events_inside_sleep` | sleep jumps that pass an unrun scheduled event (SIM-P18) |
| `jobs_held_after_turn` | jobs registered with no turn or other job open (SIM-P13) |
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
script exits nonzero when a run it started exits unexpectedly or never
reaches the awaited state within twenty minutes, or when a check fails:
`scheduled` exits 0, `rogue` exits nonzero with the daemon-exit refusal,
`resume` is killed with 137 while `e-000007` has `BeginTurn` and no
`EndTurn`, then exits 0 with no turn rebilled, and every finished run ends
in `EndRun` with unique call `seq` values and no journal invariant
violation.

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

