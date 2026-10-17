# Run journal, clock, and scheduler

A run directory holds `lease.json` and `journal.jsonl`. `src/run/` owns both.

## Lease

`takeLease(dir)` writes a temporary file with the process id, host, and start
time and links it to `lease.json`, which fails while another lease exists. A
lease held by a live process, or by any process on another host, refuses the
call. A lease whose process on this host has exited, or that a kill left
unreadable, is renamed aside in one step and replaced; only one of two racing
resumers can rename it. `releaseLease` removes the lease at the end of a run.

## Journal

`Journal` appends one JSON line per entry with `seq` (0, 1, 2, ... in append
order), `kind`, `arm`, `scenario_ms`, and `wall_ms`. On open, it truncates the
file to its complete prefix, dropping only a last line that a kill cut
mid-write, and refuses a journal whose earlier line does not parse. `append`
refuses an entry whose `scenario_ms` is below the same arm's previous entry.
Scenario time is monotone per arm: each arm starts its own clock at 0, so
entries of different arms are not ordered by scenario time.

| Kind | Written when |
|---|---|
| `StartRun`, `EndRun` | The run starts (with the arm order) and ends |
| `StartArm`, `EndArm` | An arm starts, after its driver's reset, and finishes |
| `AdvanceClock` | The clock jumps; carries `from_ms`, an empty `busy` list, and the next event id or the laptop-sleep fault |
| `BeginTurn` | A user turn is delivered |
| `EndTurn` | The turn is answered; a probe turn carries `probe` and `state` (`completed` or `failed`) |
| `RegisterJob`, `EndJob` | A background job starts and ends |
| `FaultFired`, `FaultObserved` | A scheduled fault fires, and the driver returns its evidence |
| `ItemState` | On resume, an in-flight turn or a scheduler fault without evidence is `failed(interrupted)`; the daemon exits |
| `Event` | A scheduled event is complete, with its outcome |

## Clock

`Clock` keeps scenario time and a busy set of turns, background jobs, and
scheduler fault mechanisms.
While anything is busy, scenario time runs at wall speed; while nothing is
busy, it holds. `advanceTo` jumps forward to a target time and refuses while
anything is busy. Each arm's clock starts at 0, or, on resume, at the arm's
last journaled `scenario_ms`.

## Scheduler

`Scheduler` runs the arms in the given order, one at a time, over one event
list. For each arm, it resets the driver, then walks the events:

1. Wait one settle interval after each answered turn (`settleMs`, 1 s by
   default), so a background job the host starts after its answer registers
   before the clock moves, then wait until the busy set is empty.
2. Close any outage window from the previous event.
3. On a laptop sleep, jump by the fault's `duration_ms`; then jump to the
   event's scheduled time if it is still later than now.
4. Fire the faults keyed on the event. Provider faults are armed on the proxy
   at the Nth user turn of their session. Scheduler faults call the driver's
   `fault`, hold the clock busy while its mechanism runs, and journal its
   evidence. The mid-fold SIGKILL and the daemon restart open an outage
   window first.
5. Deliver the event to the driver. A user turn is bracketed by `BeginTurn`
   and `EndTurn` and holds the clock busy while it runs.
6. At a session end, disarm the session's persistent provider faults.
7. Journal `Event` for the event.

After the arm's last event, the scheduler waits for the busy set to empty and
for a mid-fold SIGKILL still restarting the daemon, then calls the driver's
`finish` and journals `EndArm`, so nothing an arm started runs into the next
arm.

`observe("history_summarizer", driver)` fires the session's mid-fold SIGKILL
on the first observed summarizer call. `daemonExited` inside an outage window
is journaled as expected; outside one, it throws `HarnessFailure`.

## Resume

A restarted harness opens the same journal and, for each arm without
`EndArm`:

- journals `Event` for a turn with `EndTurn` but no `Event`, so the answered
  turn is never delivered again;
- journals `ItemState failed(interrupted)` and `Event` for a `BeginTurn`
  with no `EndTurn`;
- marks every fired fault as fired, arms again a persistent provider fault
  whose session has not ended and a one-shot provider fault whose turn has not
  begun, and journals `ItemState failed(interrupted)` for a scheduler fault
  with no `FaultObserved`;
- journals `EndJob` with `interrupted: true` for each job registered without
  an `EndJob`, since the killed process's jobs ended with it;
- calls the driver's `resume` with the `session_start` of the session the
  next event belongs to, or null between sessions, so the driver restarts
  what the killed process ran;
- continues with the first event that has no `Event` entry, with the arm's
  clock restored.

The resume tests kill the harness with SIGKILL mid-turn, after a turn's
answer, and during the second arm, and check the journal prefix, the next
event, the restored clock, the absence of duplicates, and the per-event
billing log.
