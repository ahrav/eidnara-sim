# Run journal, clock, and scheduler

A run directory holds numbered lease files and `journal.jsonl`. `src/run/` owns
both.

## Lease

Leases are files `lease.<n>.json`, and the highest number names the holder.
`takeLease(dir)` reads the highest lease: one held by a live process, or by any
process on another host, refuses the call. The holder is identified by pid and
by its kernel start time (`/proc/<pid>/stat`), so a pid that a later process
reuses still reads as a dead holder. A lease whose process on this host has
exited, or that a kill left unreadable, is taken over by writing a uniquely
named temporary file with the process id, host, start time, and start ticks
and linking it to `lease.<n+1>.json`. Exactly one of several racing resumers can create that
name; the others read the winner's live lease on their next attempt and are
refused. The winner removes the lower-numbered files. `releaseLease` removes
the calling process's own lease at the end of a run.

## Journal

`Journal` opens its file without following symlinks and requires a regular
file, then appends one JSON line per entry with `seq` (0, 1, 2, ... in append
order), `kind`, `arm`, `scenario_ms`, and `wall_ms`; a line is written whole
before the entry counts as appended. On open, it truncates the
file to its complete prefix, dropping only a last line that a kill cut
mid-write before its newline, and refuses a journal whose newline-terminated
line does not parse. `append`
refuses an entry whose `scenario_ms` is below the same arm's previous entry.
Scenario time is monotone per arm: each arm starts its own clock at 0, so
entries of different arms are not ordered by scenario time.

| Kind | Written when |
|---|---|
| `StartRun`, `ResumeRun`, `EndRun` | The run starts (with the arm order and a hash of the events and faults), a restarted harness takes it up (with the same), and it ends; these carry `arm` null and `scenario_ms` 0 |
| `StartArm`, `EndArm` | An arm starts, after its driver's reset, and finishes |
| `AdvanceClock` | The clock jumps; carries `from_ms`, an empty `busy` list, and the next event id or the laptop-sleep fault |
| `BeginTurn` | A user turn is delivered |
| `EndTurn` | The turn is answered; a probe turn carries `probe` and `state` (`completed` or `failed`) |
| `RegisterJob`, `EndJob` | A background job starts and ends; on resume, a job in flight at the kill gets an `EndJob` with outcome `failed(interrupted)` |
| `FaultFired`, `FaultObserved` | A scheduled fault fires, and the driver returns its evidence |
| `ItemState` | On resume, an in-flight turn or a scheduler fault without evidence is `failed(interrupted)`; the daemon exits |
| `Event` | A scheduled event is complete, with its outcome |

## Clock

`Clock` keeps scenario time and a busy set of turns and background jobs; an
id that is already busy is refused, so two jobs never share one marker, and an
end for an id that is not busy is refused before anything is journaled.
While anything is busy, scenario time runs at wall speed, measured on the
monotonic clock (`performance.now()`), so a system clock step never reaches
scenario time; while nothing is busy, it holds. Scenario time only ratchets
forward: an injected wall source that steps backward while busy holds scenario
time at the highest value already read until the source passes it again. `advanceTo` jumps forward to a target time and
refuses while anything is busy. Each arm's clock starts at 0, or, on resume, at the arm's
last journaled `scenario_ms`.

## Scheduler

`Scheduler` runs the arms in the given order, one at a time, over one event
list. A scheduler whose scenario holds provider faults requires proxy
control at construction, so a journaled `FaultFired` always armed the proxy.
For each arm, it resets the driver, then walks the events, and before `EndArm`
waits for a pending kill and for the busy set to empty, then closes any
outage window and the current session:

1. Wait one settle interval after each answered turn (`settleMs`, 1 s by
   default), so a background job the host starts after its answer registers
   before the clock moves; then wait for any pending mid-fold kill, and last
   until the busy set is empty, so a job that registers during the kill is
   seen before the jump.
2. Close any outage window from the previous event.
3. Jump to the event's scheduled time if it is later than now. When the event
   opens a session with a laptop sleep, that jump carries the fault id and the
   sleep fires first; the compiler sizes the sleep to the gap before its
   session, so the jump spans the gap and lands on the session's first event.
4. Fire the faults keyed on the event. Provider faults are armed on the proxy
   at the Nth user turn of their session. Scheduler faults call the driver's
   `fault` and journal its evidence. The mid-fold SIGKILL, the daemon restart,
   and the host upgrade open an outage window first.
5. Deliver the event to the driver. A user turn is bracketed by `BeginTurn`
   and `EndTurn` and holds the clock busy while it runs.
6. At a session end, disarm every provider fault of the session, so one that
   its turn left unexhausted reaches no later session or arm.
7. Wait for a mid-fold kill fired during the event, then journal `Event` for
   the event.

`observe("history_summarizer", driver)` fires the session's mid-fold SIGKILL
on the first observed summarizer call. `daemonExited` inside an outage window
is journaled as expected; outside one, it throws `HarnessFailure`.

## Resume

A restarted harness opens the same journal. A journal with `EndRun` is
complete and the run returns at once; one holding an `ItemState` for a daemon
exit outside an outage window is a failed run and is refused with
`HarnessFailure`. Otherwise the harness checks that every
unfinished arm has a driver, refuses an arm order or scenario hash different
from the ones `StartRun` recorded, journals `ResumeRun`, and, for each arm
without `EndArm`:

- journals `Event` for a turn with `EndTurn` but no `Event`, so the answered
  turn is never delivered again;
- journals `ItemState failed(interrupted)` and `Event` for a `BeginTurn`
  with no `EndTurn`, and `EndJob failed(interrupted)` for each `RegisterJob`
  beyond its id's `EndJob` count;
- marks every fired fault as fired, arms again a persistent provider fault
  whose session has not ended and a one-shot provider fault whose turn has not
  begun, and journals `ItemState failed(interrupted)` for a scheduler fault
  with no `FaultObserved`. A `single`, `burst`, or `intermittent` fault whose
  turn had begun is spent with that interrupted turn: its remaining calls are
  not injected into later turns, and the proxy's call records keep
  `fault_ref` on every call it did fault;
- continues with the first event that has no `Event` entry, with the arm's
  clock restored.

Each recovery entry is written only while its item has no terminal entry, so
a harness killed during recovery leaves nothing for the next resume to write
twice. The driver handed to a resumed scheduler owns its host and daemon
state: `reset()` runs only before `StartArm`, so a driver built for a resume
brings the daemon up itself before the first event. A non-turn event with no
`Event` entry is delivered again; `apply_diff` carries its full `path` and
`content`, so a driver writes the whole file and a repeat is idempotent.

The resume tests kill the harness with SIGKILL mid-turn, after a turn's
answer, and during the second arm, and check the journal prefix, the next
event, the restored clock, the absence of duplicates, and the per-event
billing log.
