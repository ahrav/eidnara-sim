# Run journal, clock, and scheduler

A run directory holds numbered lease files and `journal.jsonl`. `src/run/` owns
both.

## Lease

Leases are files `lease.<n>.json`, and the highest number names the holder.
`takeLease(dir)` opens the directory once and performs every read, write,
link, rename, and deletion through `/proc/self/fd/<fd>/`, which the kernel
resolves against that open directory, so a symlink repointed or a directory
renamed mid-way cannot move an operation elsewhere (`releaseLease` works the
same way); it flushes the staged lease before linking it and the directory
after (a link whose directory flush fails is unlinked again and that unlink
flushed before the failure is raised; when the rollback cannot be flushed
either, the error names the directory's lease state as uncertain), so an acknowledged lease or release survives a storage crash; it reads the highest lease: one held by a live process, or by any
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

`Journal` opens the run directory once, checks that it is the one
`takeLease` fixed (`lease.within`, the device and inode of the directory the
lease landed in, carried at the kernel's full width as decimal strings; by default the directory the path names as the constructor
starts), and opens, reads, and marks its file through that directory handle
(`/proc/self/fd/<fd>/journal.jsonl`), so a symlink repointed or a directory
renamed after the lease cannot route the journal, or its failure marker,
elsewhere; it opens the file without following symlinks, requires a regular
file with one link owned by the harness user, refuses a file
over `MAX_JOURNAL_BYTES` (256 MiB) before reading it and an append that would
carry it over, flushes the directory when it creates the file and each
appended line with `fdatasync` before the entry counts as appended, so an
acknowledged entry survives a power loss, and flushes the truncation that
rolls a failed append back (poisoning the run when that flush fails, so the
uncertain tail is never resumed), so a refused entry cannot reappear after a
crash, and refuses to open while a
`journal.jsonl.failed` marker sits beside the file the kernel opened
(`poison` writes the marker through the same directory handle, so a run
directory renamed since the open still gets its marker beside the journal,
creates it exclusively, or opens an existing marker without blocking and
truncates and rewrites it only when that file is this user's regular
single-link file,
and flushes it and its directory entry when a record that must land, such as a fatal fault, its evidence, an
exit, or a job transition, cannot be appended; the marker is read through a
descriptor opened without following links or blocking and must be a regular
single-link file of at most 4 KiB, so a marker of any other shape is itself a
failed run), so a later process cannot resume past a failure the journal
itself could not record), reads and truncates the file
through that one descriptor (a path handed to `readJournal` is likewise opened
once, without following links or blocking, and must be a regular file), and
refuses every operation after `close`. On
read it
splits lines on raw newline bytes, so the complete prefix is measured in bytes,
and accepts a line only when it is valid UTF-8 that parses, carries the next
`seq`, names a known `kind`, has `arm` and finite `scenario_ms` and `wall_ms`,
and keeps its arm's `scenario_ms` non-decreasing. An append that fails part-way truncates back to the complete prefix, or
closes the journal when it cannot. It appends one JSON line per entry with `seq` (0, 1, 2, ... in append
order), `kind`, `arm`, `scenario_ms`, and `wall_ms`, taking a structured
clone of the entry so a caller's `toJSON` or other function cannot change
what lands on disk; a line is written whole
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
| `ClockOffset` | The arm starts or resumes, or a jump was published, after its `AdvanceClock`; carries `offset_s`, the whole-second offset the arm's processes read from then on, and `offset_wall_ms` and `offset_settled_ms`, the wall instants before and after the rename that put it in effect (`docs/time.md`) |
| `BeginTurn` | A user turn is delivered |
| `EndTurn` | The turn is answered, with `prompt_ms`, the wall time of the host's prompt call (`null` when the turn spent its deadline before the prompt); a probe turn carries `probe` and `state` (`completed`, or `failed` whenever the driver returned `failed`, even empty) |
| `RegisterJob`, `EndJob` | A background job starts and ends; on resume, a job in flight at the kill gets an `EndJob` with outcome `failed(interrupted)` |
| `FaultFired`, `FaultObserved` | A scheduled fault fires, and the driver returns its evidence |
| `ItemState` | On resume, an in-flight turn or a scheduler fault without evidence is `failed(interrupted)` with the `cause` that stopped the arm; a kill the fatal channel cut is `failed(interrupted)`; the daemon exits; a scheduler fault the driver could not carry out, an event whose delivery failed, or a job past its deadline is `failed` with `fatal: true` and a `cause`, as is a daemon exit outside an outage window; a sleep or summarizer fault that never fired is `missed` |
| `Recovered` | On resume, once per fatal `ItemState` of a recoverable cause, before any other entry of the arm but its clock offset; carries `recovers` (the fatal record's `seq`), `cause`, and the item the record names |
| `Event` | A scheduled event is complete, with its outcome |
| `StoreChecked` | A store check a daemon restart owed is settled, once per restart; carries the fault id, the check, and the turn or session end that settled it, or `event: null` at a later fault or the finish (`docs/oracles.md`) |

## Clock

`Clock` keeps scenario time and a busy set of turns, background jobs, and
scheduler fault mechanisms; an
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
including a resume, the proxy's fault state (`ProxyControl.reset`: `FaultInjector` clears armed and pending faults,
keeps its witnesses, which are per arm, and returns its generator to its seed,
so every arm draws one fault mask and `report(arm)` describes one arm), then walks the events, and
before `EndArm` waits for a pending kill and for the busy set to empty, then
closes any outage window and the current session. A turn that rejects fails
the run and cuts a pending kill through the fatal channel; the cut kill is
journaled `failed(interrupted)`, and the one fatal record names the turn. After
`EndArm`, and on any error that ends the arm, the arm's handle is dead and a
call through it is refused:

1. Wait one settle interval after each answered turn (`settleMs`, 1 s by
   default), so a background job the host starts after its answer registers
   before the clock moves. A user turn in the session already open, with no
   fault keyed to it, then waits only until no mid-fold kill is pending and the
   scenario clock, which runs at wall speed while background work holds it,
   reaches the turn's scheduled time; background work still running keeps
   running into the turn, as a real user replies at their own pace while the
   host summarizes or captures in the background, and each job's deadline
   still counts from its `RegisterJob`: a timer per job stops the run once a
   job runs past it, whatever the arm is waiting on, after journaling a fatal
   `ItemState` naming the job with cause `job-deadline`, which a resume
   takes up as an interruption (Fatal stops, below). A mid-fold kill that starts while the turn is prepared ends
   before the turn's `BeginTurn`. Every other event, a turn with a fault keyed to it included, in every attempt (so a
   fault's mechanism never cuts the preceding turn's background work), and every user turn under
   `turnsAwaitJobs` (`--turns-await-jobs true`, recorded in the manifest),
   waits until no mid-fold kill is pending and the busy set is empty at the
   same time, so a kill a job fires during the wait, or a job that registers
   during a kill, holds the clock and the outage window until it is observed.
   The clock never jumps while the busy set holds it. The driver's `settle` hook (`quiesceJobs`)
   also waits until no job has started or ended for a further settle interval
   (every job start and end resets the window, so a job that begins and ends
   between two polls counts), so a job that starts another after it ends is
   waited for too; the whole wait shares one liveness deadline
   (`job_deadline_ms`), checked on every poll, so jobs that keep flickering
   between polls end the run too. `--events` must lie within the compiled
   scenario.
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
   `fault`, hold the clock busy while its mechanism runs, and journal its evidence, which must serialize to a JSON object
   (the journaled form is what is checked, so a `toJSON` that yields anything
   else fails the fault and the run); a daemon exit's detail is held to the
   same shape. The mid-fold SIGKILL, the daemon restart,
   and the host upgrade open an outage window first.
5. Deliver the event to the driver, as a copy, so a driver that mutates it
   touches nothing the scheduler records. Its outcome must be an object whose
   `failed` is absent or a string other than `"ok"` (the success literal);
   anything else, or a delivery that rejects, fails the run: a fatal
   `ItemState` names the event (poisoning the run when that record cannot be
   appended), the fatal channel cuts a pending kill like any other in-flight
   driver call, and a later process takes the run up or refuses it by the
   record's cause (Fatal stops, below); a rejection that the harness's own stop
   (a signal or the wall budget) caused journals no fatal record, so the resume
   marks the turn interrupted as after a kill. An `EndTurn` that cannot be
   appended poisons the run the same way. When a fault keyed
   to the turn fired, the scheduler quiesces again before `BeginTurn`, so a
   job the fault's callback started ends first. The outcome's `failed` string is copied
   out once, so `EndTurn` and `Event` carry one value whatever the driver does
   to its object afterwards. A user turn is bracketed by `BeginTurn`
   and `EndTurn` and holds the clock busy while it runs; its settle interval
   is raced against the fatal channel, and a fatal exit inside it refuses the
   run before the turn's `Event`. An `apply_diff`
   leaves the session closed; the following `session_start` opens it.
6. At a session end, disarm every provider fault of the session, so one that
   its turn left unexhausted reaches no later session or arm.
7. Wait for a mid-fold kill fired during the event, then journal `Event` for
   the event. Every record written after the driver acted (`Event`, a
   recovered turn's `Event`, a missed fault) poisons the run when its append
   fails, so a later process cannot deliver the event again. A fatal record
   lands before the fatal channel is rejected, so the paths the channel wakes
   find it on disk. At a `session_end`, a summarizer-call fault of that session that
   never fired is journaled `ItemState missed` first, so every configured
   fault leaves a record.

After the arm's last event, the scheduler waits for a mid-fold SIGKILL still
restarting the daemon and for the busy set to empty, calls the driver's
`finish`, waits for the busy set again (a job the shutdown itself started
ends before the arm does, and before a failed finish surfaces), closes any
outage window and the current session,
and journals `EndArm`, so nothing an arm started runs into the next arm. When `reset`, the
`StartArm` append, an event, or a fault throws, the scheduler waits for a
mid-fold restart still in flight, calls the driver's `abort` (the stop a
signal teardown runs, without `finish`'s final checks, so the failed arm leaves
no recorded finish failure for its resume; a driver without `abort` gets
`finish`), waits for every job the stop itself started (a job the failed work left open is the resume's to
close), then fails with the original error; the arm's journal ends before `EndArm`, so a resume takes it up again.

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
The handle carries `jobStart` and `jobEnd`, which take a non-empty string
id and journal `RegisterJob` before the job holds the clock and `EndJob` with the reading the clock then
stops at, so each busy transition and its record share one clock sample (a
failed append of either is fatal and poisons the run, so a caller that
swallows the throw cannot leave a live job unregistered or the clock busy
forever), `observe`, and `daemonExited` (its detail must be an object), and every call checks that its arm is still the one running,
so a callback a finished arm left behind is refused instead of writing under
the next arm. An arm that ends without `EndArm` disarms every proxy fault on
its way out, so a late call cannot take an experiment fault after the arm
aborted. The run wires the gateway and the host driver to the scheduler's `jobHold`, `observe`, and `daemonExited`, which route through the running arm's handle, so they carry the same checks; `jobHold` registers a job and returns its release, which acts only while that arm runs (Fatal stops, below). `observe("history_summarizer")` fires the session's mid-fold
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

A restarted harness opens the same journal.

### Fatal stops

A fatal `ItemState` stops the run and carries one `cause`:

| Cause | Written when | On resume |
|---|---|---|
| `job-deadline` | a job held the clock past `job_deadline_ms` (a host stall, a suspended machine, a hung call), by its own timer or, as `DeadlineOverrun`, during a probe turn's wait on its background jobs (an event record) | recovered |
| `harness-transport` | a user turn's delivery failed with `TransportFailure`: a user-sim call whose bounded retries all failed in transport | recovered |
| `daemon-exit` | the daemon exited outside an outage window | recovered |
| `fault-error` | a scheduler fault's mechanism failed | refused |
| `event-error` | an event's delivery failed for any other reason | refused |

A daemon exit, a fault, and a job take their cause from the record's shape; an
event's record carries `harness-transport`, `job-deadline`, or `event-error`,
and the replay refuses a stored cause its shape contradicts. An event record
from before records carried `cause` takes it from the start of its error
text: a deadline overrun names `job-deadline`; a user-sim timeout or 429/5xx,
a closed socket, or a reset or refused connection names `harness-transport`;
anything else, a host error that only wraps such text included, names
`event-error`.

A recoverable stop leaves the measurement intact up to the stop, so a resume
applies the registered missingness policy (`in_flight_at_interrupt:
failed(interrupted)`): it journals `Recovered` for each such record, then the
usual recovery entries, each interruption marker carrying the cause (a stop
with no fatal record, such as a kill or a reboot, is `harness-exit`), and the
arm continues at its next event with the host session restarted through the
driver's `resume`. The interrupted items are excluded from recall and counted
in dependability; `grade-run` reports them per arm (`interruptions`: the
interrupted turns by cause, the recovered stops by cause, the unexpected
daemon exits, which stay an Eidnara reliability finding, and any unresolved
stop; `src/run/interruptions.ts`). A failed fault mechanism or an unexplained
delivery failure names a harness or driver defect whose effect on the arm is
unknown, so such a run, and one whose journal is poisoned, tampered with, or
bound to another identity, stays refused. The replay refuses a `Recovered`
entry outside a resume's recovery, one that names no pending fatal record of
its arm, and one that misreports the record's cause or item,
any other arm entry of a resumed process before the recovery, and an
`EndArm` with a fatal record unrecovered.

A request, model call, or hold that settles after its arm stopped, or between
arms, releases nothing: the run registers each through `Scheduler.jobHold`,
whose release ends the job only while the arm that registered it runs. An arm
journals `EndArm` only with its busy set empty, so such a job belongs to an
arm that stopped early, and that arm's resume closes it as
`failed(interrupted)`. An arm order that repeats an arm is refused before anything is written.
A journal whose first entry is anything but `StartRun`, or that holds a
second `StartRun`, is refused, as is one with entries after `EndRun`, a run
record (`StartRun`, `ResumeRun`, `EndRun`) carrying an arm or a clock reading,
a `ResumeRun` naming another arm order or scenario, arms started out of the
configured order or while another is open, a `StartArm` with a clock reading
past zero, or arm evidence before its `StartArm`. An arm is complete when its
`EndArm` follows an `Event` for every scheduled event with no job registration
open, every sleep jump fired, and every fired scheduler fault observed or
interrupted; evidence journaled after `EndArm` does not count. The clock keeps
the highest wall reading it has seen, so a wall source that steps backward
across an idle gap never counts the rollback twice. A journal holding a fatal
`ItemState` that no `Recovered` entry resolves, when its cause is not
recoverable (Fatal stops, above) or the journal holds `EndRun`, is a failed
run and is refused with `HarnessFailure`; an arm with `EndArm` before every scheduled
event completed, a turn entry naming anything but a configured user turn, an
`EndTurn` before its `BeginTurn`, a `FaultObserved` before its `FaultFired`,
`Event` records outside the configured order or timestamped before their
schedule, a turn's `Event` with no `EndTurn` or interruption marker before
it or with an outcome other than that record's, an `Event` or `EndTurn`
without a string outcome, an `EndTurn` misreporting its event's probe, a
`FaultObserved` after the fault's interruption marker, a `FaultFired` or `FaultObserved`
naming a type or layer other than its episode's, a `FaultObserved` without a
non-array evidence object, a daemon exit without an object detail, a
`RegisterJob` or `EndJob` without a non-empty string job, an `Event` that passes a
session-start or user-turn trigger whose fault neither fired nor was missed,
a `BeginTurn` for a turn other than the one due, repeated for one turn,
timestamped before its schedule, while a job is open when the turn opens no
running session, has a fault keyed to it, or the run sets `turnsAwaitJobs`, before a fault keyed to
that turn fired, or while such a scheduler fault is unresolved, a second
`EndTurn` for a turn, an `Event` while a fired scheduler fault is still unobserved and
unmarked, an interruption marker that closes no open turn
or unobserved fault, a `RegisterJob` for a job still open or an `EndJob` with
no open `RegisterJob`, an `AdvanceClock` while a turn or job is open, landing
anywhere but the event due, jumping nowhere, starting anywhere but the
replayed clock, or naming anything but exactly one of a sleep fault and the
event due, any other entry whose clock reading leaves the replayed clock
(an entry written while idle carries the clock exactly; one written while a
turn or job is open carries a reading at or past it and moves it; only an
`AdvanceClock` or busy work moves the clock), a `FaultFired` repeated or
away from its trigger's place in the event sequence (a session-start or
user-turn trigger fires while its event is next due, a summarizer-call
trigger while its session is open), a sleep's `FaultFired` without its tagged
jump, a missed sleep after its jump, a missed record for anything but a
laptop sleep at its place or a summarizer-call fault at its session's end, a
fault-tagged jump for anything but a laptop sleep at its place, a
`StoreChecked` repeated or for anything but a fired daemon restart, or placed
anywhere but inside or after the turn it names, at the non-turn event being
delivered, or unattached (`event: null`), an `Event`
that passes a trigger (a session's end, for a summarizer-call fault) whose
fault neither fired nor was missed, or a daemon exit marked expected
outside a replayed outage window, is refused as corrupt, complete or not,
before `ResumeRun` or any recovery entry is written; otherwise a journal with `EndRun` is complete
and the run returns at once, after checking that `StartRun` names this arm
order and scenario and that every arm has `StartArm`, `EndArm`, and an `Event`
for every scheduled event. Otherwise the harness checks that every
unfinished arm has a driver, refuses an arm order or scenario hash different
from the ones `StartRun` recorded, journals `ResumeRun`, and, for each arm
without `EndArm`:

- journals the recovery entries in replay order: open jobs closed, fired
  faults counted and the unobserved ones marked interrupted (a `single`,
  `burst`, or `intermittent` proxy fault whose turn had begun is interrupted
  too, since the calls it consumed are unknown; a `persistent` one, or one
  whose turn had not begun, is armed again), then the interrupted turn's
  marker and `Event`;
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
  it and `FaultObserved` (the jump's `clock_advanced_ms`) for a sleep with a
  jump and no observation, arms again a persistent provider fault
  whose session has not ended and a one-shot provider fault whose turn has not
  begun (a `session_start` trigger's turn is its session's first), and journals `ItemState failed(interrupted)` for a scheduler fault
  with no `FaultObserved`. A `single`, `burst`, or `intermittent` fault whose
  turn had begun is spent with that interrupted turn: its remaining calls are
  not injected into later turns, and the proxy's call records keep
  `fault_ref` on every call it did fault;
- calls the driver's `reap` before any fault is armed again, so a host the
  killed harness left running cannot reach a re-armed proxy, then its
  `resume` with the `session_start` of the session the journal left open, or
  null between sessions, and with the ids of the scheduler faults fired
  without `FaultObserved`, so the driver restarts what the killed process ran
  and clears a fault the journal records as interrupted;
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
