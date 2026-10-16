# Run journal, clock, and scheduler

A run directory holds numbered lease files and `journal.jsonl`. `src/run/` owns
both.

## Lease

Leases are files `lease.<n>.json`, and the highest number names the holder.
`takeLease(dir)` resolves the directory path once and works on the resolved
path, so a symlink repointed mid-way touches nothing else; it reads the highest lease: one held by a live process, or by any
process on another machine, refuses the call. The machine is `/etc/machine-id`
(`hostname:<name>` where that file is absent), so machines or containers that
share a hostname on one directory stay distinct; a lease carries the kernel
boot id, so one left by an earlier boot of this machine reads as dead, while a
boot mismatch under the hostname fallback is refused as another machine; it carries the
holder's pid namespace, so a lease from another namespace on this machine, or
one whose namespace is known on only one side, is refused rather than probed
against unrelated local pids; every `lease.*.json` name outside the canonical
`lease.<n>.json` spelling is corrupt; and the holder is
identified by pid and by its kernel start time (`/proc/<pid>/stat`), so a pid
that a later process reuses still reads as a dead holder; a holder whose
identity cannot be read is treated as alive and refused. A lease is read through
a descriptor that follows no symlink and must name a small regular file; a
lease that cannot be read or does not parse to a lease refuses the directory,
since a lease is linked into place whole and a damaged one is corruption, never
a holder to take over. `releaseLease(dir, lease)` reads the highest lease only and releases it when
it is the acquisition `takeLease` returned, compared on every identifying field
including its random token. A zombie
holder reads as dead, and a lease file whose number is spelled other than as a
canonical decimal refuses the directory. A lease whose process on this host has
exited is taken over by writing a uniquely named temporary file with the process id, host, start time, and start ticks
and linking it to `lease.<n+1>.json`. Exactly one of several racing resumers can create that
name; the others read the winner's live lease on their next attempt and are
refused. The winner removes the lower-numbered files. `releaseLease` marks the calling
process's own lease released in place, so the directory keeps its highest
generation and every later taker targets the next number; a released lease is
free whichever machine released it.

## Journal

`Journal` opens its file without following symlinks, requires a regular
file with one link owned by the harness user, checks through
`/proc/self/fd` that the file the kernel opened lives in the directory
`takeLease` fixed (`lease.within`, the device and inode read before the lease
files were touched and checked again after; by default the directory the path
names as the constructor starts), so a directory symlink repointed between
the lease and the open cannot route the journal elsewhere, refuses a file
over `MAX_JOURNAL_BYTES` (256 MiB) before reading it and an append that would
carry it over, flushes the directory when it creates the file and each
appended line with `fdatasync` before the entry counts as appended, so an
acknowledged entry survives a power loss, and flushes the truncation that
rolls a failed append back (closing the journal when that flush fails), so a
refused entry cannot reappear after a crash, reads and truncates the file
through that one descriptor, and refuses every operation after `close`. On
read it
splits lines on raw newline bytes, so the complete prefix is measured in bytes,
and accepts a line only when it is valid UTF-8 that parses, carries the next
`seq`, names a known `kind`, has `arm` and finite `scenario_ms` and `wall_ms`,
and keeps its arm's `scenario_ms` non-decreasing. An append that fails part-way truncates back to the complete prefix, or
closes the journal when it cannot. It appends one JSON line per entry with `seq` (0, 1, 2, ... in append
order), `kind`, `arm`, `scenario_ms`, and `wall_ms`; a line is written whole
before the entry counts as appended. On open, it truncates the
file to its complete prefix, dropping only a last line that a kill cut
mid-write before its newline, and refuses a journal whose newline-terminated
line does not parse. `append`
refuses an entry whose `scenario_ms` is not finite or is below the same arm's
previous entry.
Scenario time is monotone per arm: each arm starts its own clock at 0, so
entries of different arms are not ordered by scenario time.

| Kind | Written when |
|---|---|
| `StartRun`, `ResumeRun`, `EndRun` | The run starts (with the arm order and the canonical-JSON SHA-256 of the events and faults), a restarted harness takes it up (with the same), and it ends; these carry `arm` null and `scenario_ms` 0 |
| `StartArm`, `EndArm` | An arm starts, after its driver's reset, and finishes |
| `AdvanceClock` | The clock jumps; carries `from_ms`, an empty `busy` list, and the next event id or the laptop-sleep fault |
| `BeginTurn` | A user turn is delivered |
| `EndTurn` | The turn is answered; a probe turn carries `probe` and `state` (`completed`, or `failed` whenever the driver returned `failed`, even empty) |
| `RegisterJob`, `EndJob` | A background job starts and ends; on resume, a job in flight at the kill gets an `EndJob` with outcome `failed(interrupted)` |
| `FaultFired`, `FaultObserved` | A scheduled fault fires, and the driver returns its evidence |
| `ItemState` | On resume, an in-flight turn or a scheduler fault without evidence is `failed(interrupted)`; the daemon exits; a scheduler fault the driver could not carry out is `failed` with `fatal: true`, as is a daemon exit outside an outage window |
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
For each arm, it resets the driver (on a fresh arm) and, on every entry
including a resume, the proxy's fault state (`ProxyControl.reset`: `FaultInjector` clears armed and pending faults, empties
its witnesses, and returns its generator to its seed, so every arm draws one
fault mask and `report()` describes the current arm), then walks the events, and
before `EndArm` waits for a pending kill and for the busy set to empty, then
closes any outage window and the current session. A turn that rejects still
waits for a pending kill's evidence before the error propagates. After
`EndArm`, and on any error that ends the arm, the arm's handle is dead and a
call through it is refused:

1. Wait one settle interval after each answered turn (`settleMs`, 1 s by
   default), so a background job the host starts after its answer registers
   before the clock moves; then wait until no mid-fold kill is pending and the
   busy set is empty at the same time, so a kill a job fires during the wait,
   or a job that registers during a kill, holds the clock and the outage
   window until it is observed.
2. Close any outage window from the previous event.
3. Jump to the event's scheduled time if it is later than now. When the event
   opens a session with a laptop sleep, that jump carries the fault id and the
   sleep fires first; the compiler sizes the sleep to the gap before its
   session, so the jump spans the gap and lands on the session's first event.
   When the clock has already reached the session, because a job ran that
   long, there is no jump to carry the sleep and it is journaled
   `ItemState missed`.
4. Fire the faults keyed on the event. Provider faults are armed on the proxy
   at the Nth user turn of their session, and `FaultFired` is journaled after
   the proxy accepted the arming; a failed append disarms the episode before
   the error propagates. Scheduler faults call the driver's
   `fault` and journal its evidence. The mid-fold SIGKILL, the daemon restart,
   and the host upgrade open an outage window first.
5. Deliver the event to the driver. A user turn is bracketed by `BeginTurn`
   and `EndTurn` and holds the clock busy while it runs; its settle interval
   is raced against the fatal channel, and a fatal exit inside it refuses the
   run before the turn's `Event`. An `apply_diff`
   leaves the session closed; the following `session_start` opens it.
6. At a session end, disarm every provider fault of the session, so one that
   its turn left unexhausted reaches no later session or arm.
7. Wait for a mid-fold kill fired during the event, then journal `Event` for
   the event.

Each arm's driver receives an `ArmHandle` through `bind` once the arm has
started and its recovery entries are on disk: on a fresh arm after `reset`
returned and `StartArm` is journaled; on a resume after the open jobs are
closed, the interrupted turn and faults are marked, and the fired faults are
counted, so every entry the handle writes follows the recovery it would
otherwise race, a bind-time registration of a job id the crash left open is
valid, an observation during `bind` fires no second kill, and a daemon exit
reported through the new handle is unexpected because the interruption marker
closed the outage window. The session the journal left open is restored
before `bind`, so a late summarizer observation from it still fires its kill.
live job unregistered or the clock busy forever), `observe`, and
`daemonExited`, and every call checks that its arm is still the one running,
so a callback a finished arm left behind is refused instead of writing under
the next arm. `observe("history_summarizer")` fires the session's mid-fold
SIGKILL on the first observed summarizer call. `daemonExited` inside an outage
window is journaled as expected and closes the window (a failed append of
that record is fatal, so a watcher that swallows the throw cannot let the run
succeed without exit evidence), as does the fault's
`FaultObserved`, so a second exit of the replacement daemon is unexpected; outside one, it journals a fatal `ItemState`,
throws `HarnessFailure`, and fails the run at once: a driver call in flight is
raced against it, an idle wait on a job that never ends is ended by it, and
`EndRun` is refused, whether or not the caller swallowed the throw. A scheduler fault whose driver call rejects
journals a fatal `ItemState` and fails the run at once, ending any turn still
in flight.

## Resume

A restarted harness opens the same journal. An arm order that repeats an arm is refused before anything is written.
A journal whose first entry is anything but `StartRun`, or that holds a
second `StartRun`, is refused, as is one with entries after `EndRun`, a run
record (`StartRun`, `ResumeRun`, `EndRun`) carrying an arm or a clock reading,
a `ResumeRun` naming another arm order or scenario, arms started out of the
configured order or while another is open, a `StartArm` with a clock reading
past zero, or arm evidence before its `StartArm`. An arm is complete when its
`EndArm` follows an `Event` for every scheduled event with no job registration
open, every sleep jump fired, and every fired scheduler fault observed or
interrupted; evidence journaled after `EndArm` does not count. A journal holding a fatal
`ItemState` (a daemon exit outside an outage window, or a scheduler fault the
driver could not carry out), before or after `EndRun`, is a failed run and is
refused with `HarnessFailure`; an arm with `EndArm` before every scheduled
event completed, a turn entry naming anything but a configured user turn, an
`EndTurn` before its `BeginTurn`, a `FaultObserved` before its `FaultFired`,
`Event` records outside the configured order or timestamped before their
schedule, a turn's `Event` with no `EndTurn` or interruption marker before
it or with an outcome other than that record's, an `EndTurn` without an
outcome or misreporting its event's probe, a `FaultFired` or `FaultObserved`
naming a type or layer other than its episode's, a `FaultObserved` without an
evidence object, an `Event` that passes a
session-start or user-turn trigger whose fault neither fired nor was missed,
a `BeginTurn` for a turn other than the one due, repeated for one turn,
timestamped before its schedule, or while a job is open, a second `EndTurn`
for a turn, an `Event` while a fired scheduler fault is still unobserved and
unmarked, an interruption marker that closes no open turn
or unobserved fault, a `RegisterJob` for a job still open or an `EndJob` with
no open `RegisterJob`, an `AdvanceClock` while a turn or job is open, landing
anywhere but the event due, jumping nowhere, or starting behind the arm's
last clock reading, a `FaultFired` repeated or
away from its trigger's place in the event sequence (a session-start or
user-turn trigger fires while its event is next due, a summarizer-call
trigger while its session is open), a sleep's `FaultFired` without its tagged
jump, a missed sleep after its jump, a missed sleep or fault-tagged jump for
anything but a laptop sleep at its place, or a daemon exit marked expected
outside a replayed outage window, is refused as corrupt, complete or not,
before `ResumeRun` or any recovery entry is written; otherwise a journal with `EndRun` is complete
and the run returns at once, after checking that `StartRun` names this arm
order and scenario and that every arm has `StartArm`, `EndArm`, and an `Event`
for every scheduled event. Otherwise the harness checks that every
unfinished arm has a driver, refuses an arm order or scenario hash different
from the ones `StartRun` recorded, journals `ResumeRun`, and, for each arm
without `EndArm`:

- waits one settle interval so a job an answered turn started can still
  register, waits for any kill that interval fired, and refuses the run if a
  fatal exit landed meanwhile; then journals `Event` for each turn with
  `EndTurn` but no `Event`,
  so the answered turn is never delivered again and a kill inside the window
  repeats it;
- journals `ItemState failed(interrupted)` and `Event` for a `BeginTurn`
  with no `EndTurn`, and `EndJob failed(interrupted)` for each `RegisterJob`
  beyond its id's `EndJob` count;
- marks every fired fault, and every laptop sleep journaled `missed`, as
  handled, journals `FaultFired` for a fault-tagged `AdvanceClock` that lacks
  it, arms again a persistent provider fault
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
