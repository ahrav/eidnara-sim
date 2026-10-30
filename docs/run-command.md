# Run command

`scripts/run-tier.ts` runs one tier and seed against Pi or OpenCode through
the capture proxy, the clock, the scheduler, and the arm drivers
(`docs/hosts.md`). `src/run/run.ts` wires them together.

```sh
PATH=<opencode release>/node_modules/.bin:$PATH \
bun scripts/run-tier.ts --tier S --seed 101 --out runs/S-101-pi \
    [--host pi|opencode] [--arms host,eidnara] [--events N] \
    [--faults episodes.json] [--context-limit N] [--models a,b] \
    [--tapes tape.jsonl,...] [--qualification Q] [--wall-budget-ms N] \
    [--sim-upgrade <commit>]
```

The v1 harness closure resolves `opencode` through a shell, and that shell
sees the `PATH` the harness started with, so the run refuses to start
unless the pinned OpenCode release's `node_modules/.bin` is on `PATH` and is
the first entry there that holds an `opencode`.

`--arms` keeps the listed arms of the seed's pre-registered order, plus
any A/A control label such as `host~aa` (`docs/user-sim.md`), and
`--events N` runs the first N scenario events. `--faults` replaces the
scenario's fault schedule, `--context-limit` sets the model window the host
sees (200,000 by default), and `--models` lists the models `model_switch`
cycles through (`agent_model` by default). `--tapes` names earlier runs'
user-sim tapes to replay replies from (`docs/user-sim.md`), `--side-model`
sets Eidnara's side-call model for a model-factor run, and `--user-sim-model`
replaces the pre-registered user-sim model for a variant run. The manifest
records every one of these values, and a digest of each tape and the
pairing log beside it (`tape_sha256`).

`--wall-budget-ms N` replaces the tier's `liveness_bounds.tier_wall_budget_ms`
as this invocation's wall budget, so a run of the whole scenario, whose turns
outlast the budget a tier campaign's capped prefix is planned for, ends in one
invocation instead of stopping mid-turn and resuming. The manifest records it
as `wall_budget_ms` (null for the tier's budget); a resume without the flag
reads it from the manifest before its preflight and runs under it, and a
resume naming another value is refused. `scripts/tier.ts`
runs every campaign run under the registered budget, and the tier report's
SIM-L03 check reads the tier's.

`--sim-upgrade <commit>` lets a resume take up a run under a newer
eidnara-sim commit, for a change that is harness recovery only. The value must
name the commit this checkout runs. The resume is refused unless the run's
latest revision (the last entry of the manifest's `sim_revisions`, or
`sim_commit` when there is none) and this one are clean checkouts, this commit
descends from it, and no path in `MEASUREMENT_PATHS` (`src/run/run.ts`: the
pre-registration and its schema, the scenario compiler and corpus, the
user-sim, the oracle note, the arm profiles, call classification, records, and
fault injection, the clock and its injection, and the resource sampler)
differs between them; every other pinned input is compared as on any resume.
Once every check passes, the manifest gains a `sim_revisions` entry (`commit`,
`worktree`, `from_commit`, the arms without `EndArm`, `accepted_wall_ms`), and
each `Preflight` entry keeps binding the same execution digest, which leaves
`sim_revisions` out. `sim_commit` keeps naming the revision that started the
run. Without the flag, a changed revision is refused as before, with a hint
when the revision is the only changed input. Graders run after `EndRun` over
the recorded artefacts and each grade records its grader digest, so a grader
change is outside this check: `grade-run` grades every run of a campaign with
the grader it runs.

`--qualification Q` runs under the qualification registration
`prereg/Q.json` (`sim-qualification/v1`, `src/prereg/qualification.ts`)
instead of the tier's arm order. The registration binds one tier's
pre-registration by hash and lists its own seeds, hosts, arms with one order
per seed, descriptive contrasts between arms of different delivery modes,
and the control items it adds to the scenario (`docs/scenario.md`). It may
also carry three sections:

- `aa_controls` (`seeds`, `pairs`): whole-scenario A/A controls. On each
  listed seed, each `[arm, arm]` pair runs `<arm>~aa` right after its arm,
  over the same events as the rest of the run, so `aa-report` reads it on
  its whole-scenario path, where realised user-sim rates must sit inside
  their bands.
- `holdout` (`seeds`, `arms`, `order_by_seed`, `pooled: false`):
  exploratory seeds outside `seeds`, which need not be tier seeds, run over
  `arms` in their own order. A hold-out
  run is reported on its own and never pooled into the registered
  contrasts or the ranking gate.
- `ranking_gate` (`order`, `items`): the qualification's delivery-mode gate.
  The pooled pass rates of `order` (oracle context, automatic delivery, no
  delivery) hold from first to last on the positive sourced probes only:
  P1, P3, P4 on its `in` side, P6 items that expect `resume`, P8, P12, and
  P13 (`RANKING_GATE_ITEMS`). Avoid, abstain, and should-not-apply items
  (P2, P5, P9, P10, P11, P8-twin, a P4 `out` item, a P6
  `clarify` item) are outside the gate: their right answer withholds or
  leaves out what a source says, and the oracle note quotes it, so the
  oracle arm sits below the host there by design. The apply graders stay
  strict: a clarifying question on an apply item fails it.

- `no_source_control`: the run arm that serves as the memory-free control.
  It must be a run arm whose delivery mode is `none`: it meets the same
  scripted conveyances, commits, and probes as every arm, in its own
  workspace, and receives no memory between sessions. An item's base rate is
  that arm's pass rate on the same scripted item.

Revision 2 registers whole-scenario A/A controls `host~aa` and `eidnara~aa`
on seed 102, hold-out seed 103 over `eidnara` then `host`, and the ranking
gate over `host-oracle`, `eidnara`, `host`. Revision 3 (`e8c1f508`) names
`host` as the no-source control, in place of the P1 control items of
generator `sim-scenario/v5`. Those asked the P1 task in the same workspace
before the rule was conveyed, and agent edits persist across sessions, so on
every arm the agent had done the P1 task before its P1 probe.

The validator (`bun run prereg:validate`) refuses a stale tier digest, a seed or
host the tier does not run, an arm without a profile or with a capability
gap, an order that is not a permutation of the run arms, and a contrast
between arms of one delivery mode; an A/A seed outside `seeds` or a pair
that is not one run arm twice; a hold-out seed inside `seeds`, a hold-out arm
outside the run arms, or a hold-out order that does not permute
`holdout.arms`; and a ranking gate whose order is not one run arm per mode in
that order or whose items differ from `RANKING_GATE_ITEMS`; and a
no-source control that is not a run arm or delivers memory. The run refuses
a qualification over another tier, a seed or host it does not list, an arm
outside the seed's order, and an A/A control label the seed does not
register; the tier pre-registration still supplies the liveness bounds,
user-sim, and grading rules. The manifest records
`qualification` (`{id, sha256}`, or `null` for a tier run), the scenario
manifest records `qualification_sha256`. A resume compares both;
`grade-run`, `pairing-check`, and `oracle-run` require the scenario's digest
to equal the manifest's (none for a tier run), the registration to still
hash to it, the host and seed (registered or hold-out) to be ones it lists,
and the order to be a subsequence of the seed's registered order, each A/A
control right after its arm. `scripts/report.ts` refuses a
qualification run, since the tier report reads the tier's gates and the
qualification registers descriptive contrasts. Each tape must come from a finished
run (its journal holds `EndRun`) of the same seed, scenario,
pre-registration, fault override, and `turns_await_jobs` (a source
manifest from before that field counts as `true`) that ran every arm of this run over
at least its events, with a pairing record per arm and user turn and a tape
entry for each recorded reactive turn (`checkTapeSources`); a resume checks
the sources again against the manifest's event count, order, and override. An argument outside this list, an option without a value, an
empty model name, or an `--events` count above the compiled schedule is
refused. The run refuses a seed outside the pre-registration, an arm
outside the seed's order, an arm listed twice, an A/A control label whose
`[arm, arm]` pair the tier does not pre-register or whose arm is not run, a
non-positive count, a `--faults` file that is not
an array of complete episodes (known type and strategy, numeric params with
probabilities in [0, 1], positive integer counts, non-negative durations and
timeouts, a `single` strategy for scheduler-layer faults (`persistent` for
`store_full`), `count` for a `burst`, and `probability` and `calls` for an
`intermittent`, a seam, ids unique among the faults and distinct from every
scenario event id, and a `session_start` trigger for the
between-session faults `laptop_sleep`, `daemon_restart`, `plugin_reload`,
`model_switch`, `store_full`, `host_upgrade`, and `two_hosts_one_daemon`) valid against the compiled scenario
(`validateFault`); the compiled scenario's own faults pass the same checks
when `scenario.json` is loaded,
an `--out` directory that overlaps the Eidnara checkout in either direction
by resolved path (an output directory above the checkout would derive an arm
root inside it), a schedule with a fault type the host driver has no
mechanism for (`driverSupports`; every compiled type through XL has one),
a `--models` list that repeats an entry, and a
`model_switch` schedule with fewer than two models. A `daemon_sigkill_mid_fold` needs a
`first_summarizer_call` trigger, one session carries at most one mid-fold
kill and one laptop sleep, a laptop sleep needs an idle gap before its
session's first event (an `apply_diff` that opens the session shares the
start's time), a strategy accepts only its own limit parameters (`count`
for `burst`; `probability` and `calls` for `intermittent`), and `store_full`
supports `sessions: 1` only; a proxy `single` may carry the compiler's
`count: 1`; each mechanism accepts only the parameter it reads
(`timeout_ms` for `provider_timeout`, `delay_ms` for `slow_stream`,
`duration_ms` for `laptop_sleep`, `sessions` for `store_full`); durations stay within the timer limit (2^31 - 1 ms). `--out /`
is refused.
`--out` may not overlap the Pi install either. An `--out` inside this checkout must be
ignored by git (`runs/` is), and may not overlap a corpus checkout, since
both trees are part of the run identity. Before taking the lease, every artifact the run appends to or
replaces (`journal.jsonl`, `calls.jsonl`, `requests.jsonl`, the manifest, the scenario, the
fault and preflight files, `tape.jsonl`, `pairing.jsonl`, `downstream.jsonl`, this process's staging names for the lease, the
scenario, and the manifest, and each arm's `resources.jsonl`, clock offset,
`state.json`, `daemon.log`, `store.img`, `transcripts.json`, and the snapshot
and store-check files (`snapshots.jsonl`, `tools.jsonl`, `commands.jsonl`,
`store-check.json`, `memory.json`), `capabilities.json`, plus this
process's staging names for the clock offset and `state.json`) must be absent
or a regular file with a single link; a `lease.<pid>.tmp` left by a dead
acquirer is removed first, so a crash between link and unlink stays resumable
(the arm,
clock, `r`, `s`, `interception`, `toolbin`, and `hostbin` directories must be
directories; `toolbin` is recreated from scratch before preflight on a resume, so only
the configured wrappers are on the sandbox `PATH`; the OpenCode wrapper and its staging name under `hostbin/<arm>`
are checked the same way); a symlink, a hard link, or another
file type there is refused. A run whose journal is still empty refuses an
output directory that already holds call, fault, preflight, tape, pairing, or
downstream evidence, a `toolbin`, `interception`, or `hostbin` directory, or
an arm's payload (`r`, `s`, `store.img`, `daemon.log`, `transcripts.json`,
`resources.jsonl`, `state.json`, `opencode.launch`, `snapshot.git`,
`snapshot-state.json`, and the snapshot and store-check files), since a fresh run would extend or delete them; a
`journal.jsonl` with bytes but no complete entry is refused rather than
truncated. A fresh run writes `attempt.json` before its preflight, so the
scratch that preflight creates (`toolbin`, `interception`, `hostbin`) is
recognized as this harness's own and removed when a failed or killed first
preflight left it behind; without that marker those directories are refused
like the other artifacts. Every staged write (scenario, manifest, clock
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
   signals wait for the teardown. The tier's `tier_wall_budget_ms` (or the
   run's `--wall-budget-ms`) starts a timer at the same point; once it fires, every driver call refuses the
   same way, the scheduler's idle wait and next step fail at once, a
   call that was in flight when it fired fails on return, and a call still
   blocked thirty seconds after it fired is abandoned, so the run proceeds to
   teardown (which stops the drivers and their process trees) and fails
   before `EndArm`. A turn or job in flight is bounded by its own deadline
   (15 or 20 minutes), so the overrun past the budget is at most that long.
2. Open the journal, and compile the scenario into `scenario.json` on the
   first invocation (the shared embedding cache `runs/scenarios/embeddings.jsonl`,
   its staging file, and its directory must be plain entries resolving inside
   this tree's `runs/` and outside the Eidnara checkout). Every invocation recomputes the SHA-256 of the file's
   body and refuses a `scenario.json` whose `scenario_hash` differs, one
   compiled for another tier or seed, one whose project ids are not plain
   names, one with a repeated event id, an unknown event kind, a non-numeric
   or decreasing `scenario_ms`, a missing session, a turn without an index,
   or one whose events name an undeclared project. A directory whose
   journal already ends in `EndRun` is refused before the scenario is read or
   preflight runs, so a sealed run's artifacts stay untouched.
3. On a resume, read the manifest and compare every passive identity (the
   digests below) before running any probe, so a replaced executable is
   refused before it executes; then run `preflight` (`docs/time.md`). On the
   first invocation, run `preflight` first (it builds the interposer), then
   compute the digests and write
   `manifest.json` with the tier, seed, host, arm order, event count, context
   limit, models, fault override, scenario hash, pre-registration hash,
   eidnara commit and working-tree digest, eidnara-sim commit and
   working-tree digest (a digest covers tracked edits and untracked
   unignored files), the commit and working-tree digest of every corpus
   checkout the scenario's projects clone from, the configured toolchain
   (bin, keep, env, wall-clock tools) with each named tool's content digest
   (resolved through the toolchain bins, then the sandbox's system path), the
   Git executable the identity checks run (a Pi install symlink that escapes
   the install also hashes its target's content), the SHA-256 of the daemon,
   OpenCode, and Pi executables, the whole Pi install tree (every file and
   link under `pi_install`, since Node resolves the CLI's dependencies
   there), the Node runtime Pi runs on, the libfaketime interposer, the
   OpenCode SDK package directory the host stack imports and the e2e
   workspace's lock file (`absent` when not installed), the Pi and OpenCode
   plugin `dist` trees the hosts load (ignored build outputs, so the eidnara
   working-tree digest omits them; `absent` when not built), each ordered
   arm's profile with the user-tier `eidnara.jsonc` and daemon configuration
   it writes (`arms`, `docs/hosts.md`), the
   Bedrock region and profile name, base wall time, price table (the version
   and rates the report prices the run's calls at), and preflight result. The working-tree digest hashes an
   untracked symlink's target text.
   A later invocation refuses a manifest whose `schema` is not
   `sim-run-manifest/v3` or whose execution fields are out of range (an event
   count outside the compiled schedule, a non-positive context limit, an
   unnamed model, a non-integer seed, an unknown host, a price table without a
   version or with a negative or non-finite rate), revalidates a saved
   fault override as on the first run, and refuses when any option it states differs from the manifest, when the manifest's arm order is not a non-empty subsequence
   of the seed's pre-registered arm order (with each A/A control right after
   its arm), when a resumed journal breaks the
   run's state machine (a `ResumeRun` or arm entry before `StartRun`, an arm
   entry before `StartArm` or after `EndArm`, an `EndTurn` or `EndJob` with
   no open item, an `Event` that is not the arm's next scheduled event, a
   user turn's `Event` without its `EndTurn` or interruption marker, or an
   `EndArm` with an item open or events of the prefix still unrun, an item
   opened twice or a turn reopened, a `UserTurn` outside its open turn or
   repeated, an arm's second `UserSimRates`, a `StartArm` out of the manifest's order,
   an `Event` recorded before its scheduled time, a `StartArm` while the
   previous arm is open, any entry after `EndRun`, or
   a row whose `seq` or `scenario_ms` is not a number), when any of those digests, a replay
   tape's digest (`tape_sha256`), or an arm's recorded configuration (`arms`) changed, when an
   interception result, probed path, or toolchain version
   changed, when a probed host version or install path (current or
   `config.upgrade`) changed, or when the selected host's version or transcript
   paths changed,
   and appends its preflight result to `preflight.jsonl` (dropping an
   unterminated final line first). The `Preflight` journal entry carries a
   digest of the manifest's execution fields (everything but the
   per-invocation preflight); a resume whose manifest no longer matches the
   digest every `Preflight` entry of the journal bound is refused, so inherited
   options cannot change under a run's journaled identity. On resume the
   mechanism checks (fault types, models) run against the manifest's saved
   values, so omitted options inherit. Every invocation
   then journals a `Preflight` entry with its interception results and host
   identities before `StartRun` or `ResumeRun` (SIM-P16).
4. Start the capture proxy; its records append to `calls.jsonl`, each
   forwarded body's parts to `requests.jsonl` (`docs/proxy.md`), and a
   reopened writer continues the sequence after the last complete record. A
   cut last line is dropped; a complete line that is not a record in
   sequence refuses the run. The writer advances its sequence only after an
   append succeeded, so a failed append leaves the file recoverable. The run's
   call index reads the existing records once, checking each line's fields and
   its `seq`, and the fault injector restores its witnesses from their fault
   fields in arrival order, so a fault injected and observed before a hard kill keeps its
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
   report to `faults.jsonl` (a completed run stops the proxy, drains its
   handlers, appends the report, and rechecks the wall budget before `EndRun`, so
   a sealed journal always has its witness line; teardown appends it only
   when that did not happen; an unterminated final line left by an earlier
   kill is dropped first), close the journal, and release the lease. A
   request's arrival hook, completion hook, or release that fails to journal
   its job is recorded as a handler failure and fails the run at the next
   verification; the busy set still clears. A handler that settles after the
   proxy's drain gave up on it writes no record and ends no job; it is
   recorded as a failure instead. Each call's record carries the wall time,
   scenario time, and call order of its first byte, and the fault window
   opens at that instant; an upload the client abandons yields one `rejected`
   record with status 0. Each
   step runs even when an earlier one fails, and the first failure is
   rethrown after the last step, so the command exits nonzero. After a
   teardown with no failure the command exits 0 at once, so a launch whose
   exit the runtime never reported cannot keep the sealed run's process
   alive. Stopping the
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
pre-registered threshold (the fraction is measured over monotonic time), with
one job id per busy period. The post-turn hold
timers are owned by the run: teardown cancels any still pending and ends
their holds before the journal closes. Both hold the
clock (SIM-P13, OQ-2). Job ids continue from the journal's count, so a
resumed run issues new ones. Once an arm's `StartArm` is journaled (or its
processes reaped on resume) the same two-second hold runs, so daemon work
that follows startup is measured before the first event. A job that holds the clock longer than the
pre-registered `job_deadline_ms` (20 minutes at S) after its own
`RegisterJob`, measured on the monotonic clock, stops the run with the held
ids (SIM-L02). The sampler drops an unterminated final sample when it
reopens `resources.jsonl` on resume. Every host launch uses the launcher
this invocation's preflight wrote and probed. A periodic sample that fails
(for example, a full disk under `resources.jsonl`) stops the sampler and the
run the same way a signal does, so the teardown runs.

## Campaign supervisor

`scripts/campaign.ts <campaign.json> [--once]` runs a list of `run-tier`
jobs to the end and keeps their state where an operator sees it. The
campaign file:

```json
{
    "schema": "sim-campaign/v1",
    "out": "/abs/campaign/Q",
    "args": ["--tier", "S", "--qualification", "Q", "--host", "pi",
             "--wall-budget-ms", "345600000"],
    "runs": [
        { "name": "S-101-host", "args": ["--seed", "101", "--arms", "host"] },
        { "name": "S-102-eidnara", "args": ["--seed", "102", "--arms", "eidnara,eidnara~aa"] }
    ],
    "max_resumes": 6,
    "poll_ms": 60000,
    "stale_ms": 2700000,
    "inode_paths": ["/tmp"]
}
```

Each run is `bun scripts/run-tier.ts`, the shared `args`, the run's `args`,
and `--out <out>/<name>` (`run_command` replaces the first part, and
`finalize_commands`, with `{dir}` and `{evidence}` placeholders, the
finalize steps; both exist for tests). Every `poll_ms` the supervisor:

- reads each run's journal and manifest and treats a run as running while
  the child it launched lives or the run directory's lease is held, so a
  restarted supervisor picks up runs it did not launch;
- launches a run that has not started, and relaunches one that stopped
  before `EndRun` (a resume) until it has relaunched `max_resumes` times,
  or until two attempts in a row journaled nothing past their `Preflight`,
  the sign of a refusal every resume repeats; either ends the run as
  `gave-up`, logged with a banner on stderr and an `ALERT` line;
- on `EndRun`, runs `grade-run`, `evidence-run --out <out>/evidence`, and
  `pairing-check` once, logging each exit code (a nonzero one is an alert);
- writes `<out>/campaign-status.json` (`sim-campaign-status/v1`): per run,
  the state, launches, last `error:` line of its log, events done and total,
  failed and interrupted turns, daemon exits, journal resumes, unresolved
  fatal causes, the last entry's wall time, and the ETA at the event rate of
  the last six hours; plus the current alerts;
- raises an alert for a run that gave up, a running run whose journal gained
  no entry for `stale_ms` (45 minutes by default, past the 20-minute job
  deadline), a failed finalize step, and each `inode_paths` filesystem whose
  inode use passes 80%.

Each attempt logs to `<out>/logs/<name>.log`; the previous attempt's log moves
to `<name>.attempt<k>.log`. `<out>/campaign.log` keeps every decision. Runs
are launched detached, so stopping the supervisor leaves them running and
starting it again resumes supervision; `--once` makes one pass and exits,
for a cron entry. The supervisor exits 0 once every run is finalized with
clean finalize steps, and 1 when any run gave up or a step failed. It inherits
`PATH` and `SIM_CONFIG` from its environment:

```sh
PATH=<opencode release>/node_modules/.bin:$PATH SIM_CONFIG=<sim.config.json> \
    nohup bun scripts/campaign.ts campaign.json > campaign.out 2>&1 &
jq '.alerts, (.runs[] | {name, state, events_done, events_total, eta_at, last_error})' \
    <out>/campaign-status.json
```

## Journal check

`checkJournal(entries, schedule)` reads a journal against the scenario's
event times and reports, per arm:

| Field | Meaning |
|---|---|
| `decreasing_scenario_ms` | entries whose `scenario_ms` falls below the arm's previous entry (SIM-P11) |
| `advance_while_busy` | `AdvanceClock` entries while a turn or job is open, counting an interrupted turn and a job ended on resume as closed (SIM-P12) |
| `off_schedule_jumps` | jumps, event or sleep, that do not advance, cross an unrun event at or after their origin, or land anywhere but the earliest unrun scheduled time after it (SIM-P14, SIM-P18); a sleep is the jump onto its session's first event, so its size is the remaining gap, not the nominal `duration_ms` |
| `events_inside_sleep` | sleep jumps that pass an unrun scheduled event (SIM-P18) |
| `repeated_sleeps` | a second sleep jump for the same fault in one arm |
| `missing_events` | scheduled events an arm never journaled as `Event` although it reached `EndArm` |
| `out_of_order_events` | `Event` entries unknown to the schedule or not the next one it expects (a skip is reported at the row that skipped) |
| `jump_origin_mismatch` | `AdvanceClock` entries whose `from_ms` differs from the arm's preceding `scenario_ms`; crossing checks use the observed value |
| `jobs_held_after_turn` | jobs that held the clock while no turn was open, whether registered after the turn or registered inside it and outliving it, once per job at its `RegisterJob` seq (SIM-P13) |
| `next_event_jumps`, `sleep_jumps`, `sleep_jump_faults` | how many jumps of each kind the check covered, and each sleep jump's arm and fault id |

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
budget plus five minutes counted from its launch (it is then killed and
reported `timed_out`), or
when a check fails:
`scheduled` exits 0, `rogue` exits nonzero with the daemon-exit refusal,
`resume` is killed with 137 while `e-000007` has `BeginTurn` and no
`EndTurn`, then exits 0 with no turn rebilled and exactly one `ItemState
failed(interrupted)` and one `Event failed(interrupted)`, both for
`e-000007`, and every finished run ends
in `EndRun` with contiguous call `seq` values from 0 and no journal
invariant violation (including a repeated sleep jump). The summary parses
final journals and call records strictly; a corrupt or unterminated final line
or a call row that fails the `CallRecord` schema fails the witness, while
polling during a run tolerates an unterminated final line. Every case needs
its launch outcome recorded as an object in `outcome.json`, and each case's
exit, kill, and rebilling assertions run unconditionally on it; the `rogue`
outcome must record the SIGKILL the script sent to the daemon `state.json`
named (`rogue_killed`, with no `rogue_kill_error`); each cached
`scenario.json` must still hash to its `scenario_hash`, each `manifest.json`
must name that hash, carry the case's prescribed tier, seed, arms, event
count, context limit, models, and fault override, and match the digest its
journal's every `Preflight` entry bound; the rogue journal must record exactly
one unexpected daemon exit; each
session-start fault must have fired exactly once, at the session's scheduled
start time, right before its first event; each sleep jump must land on its session's first event; every
`StartRun` or `ResumeRun` must follow its own all-intercepted `Preflight`
entry; and the journal must pass the resume shape check with contiguous
`seq`. The rogue witness signals the daemon only while its recorded pid still
carries the recorded start time.
The scheduled and resume runs must also show their evidence per arm: every
deterministic fault of the set fired, every fault with a mechanism observed
(on `eidnara`, the restart with a new daemon pid and `restarted_by: harness`,
the full store with `avail_kb: 0`, and the model switch's boundary: sessions
before its trigger used the first model, sessions from it on the second,
where each agent call is placed by the session the scenario schedules for
its turn and a call whose recorded session differs from that fails the check),
exactly one jump tagged with each sleep episode's id per arm, agent calls on both configured models, and no duplicate `Event` entry
(the mid-fold kills fire only when a summarizer call happens, so they are not
required; `plugin_reload` has no startup record to inspect beyond the
driver's evidence and the turns that follow), every completed turn `ok` (so a
store filled by `store_full` still served the turns after it) and, on
`eidnara`, the daemon's log naming the full store; the scheduled run must hold the clock with at least one background or
daemon-cpu job while no turn is open (the synthetic `settle-cpu` and
`request` holds do not count) (SIM-P13), and every finished run's journal must open with a
`Preflight` entry, before `StartRun` or `ResumeRun`, whose probes are exactly
`pi`, `opencode`, and `daemon`, all intercepted (the same for every later
`Preflight` entry), the `host` arm's restart and full store recorded as
`skipped`, hold exactly one `EndArm` per arm the manifest names, and
include at least one ordinary event jump. All three case directories must be
present.
Every summarized directory's manifest identity (pre-registration, Eidnara
and harness commits and working trees, executables, corpus checkouts, Bedrock
routing) must match the identity recomputed from the current environment, so
a rerun of one case cannot certify stale evidence from another. These checks run on every
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

