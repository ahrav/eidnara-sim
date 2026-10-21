# Host drivers

`src/hosts/` holds the arm drivers. `arms.ts` launches Pi or OpenCode and
wraps the daemon stack, and `driver.ts` runs one arm's events and
scheduler-layer faults. `docs/run-command.md` describes the run command that
wires them to the proxy, clock, and scheduler.

## Eidnara build

The plugins, native addon, daemon, and host fixture come from one commit.
`scripts/eidnara-build.sh <checkout> <clone>` clones the eidnara source
checkout, checks out its `HEAD`, and builds every artefact inside the clone,
so the source checkout itself stays read-only; it refuses a clone path that
is the checkout or lies beneath it, and reuses an existing clone only when
its `.sim-build-source` names the same checkout. It refuses a symlink at `<clone>.lock`, holds the lock with `flock` for the whole build, so a second build of the same clone is
refused, and it reuses a clone only when its `.git` is a real directory
inside the clone. A first clone is made in a fresh `<clone>.partial.XXXXXX` directory that
holds an owner record, and is renamed into place once it carries its source
record; the next build removes only partial directories whose owner record
names the same source. A source that tracks either
record path is refused, and each record is unlinked before it is written. `.sim-build-commit` holds
the built commit from the end of one successful build until the next build
starts, and preflight requires it to match the clone's `HEAD` and
`daemon_binary` to be the clone's own
`target/release/examples/direct_host_fixture`, so a partial or mixed tree,
or a daemon from another commit, stops the run. On a reused clone it force-checks
out the fetched commit and removes untracked files, so edits and stray files
from an earlier build go while ignored outputs (`node_modules`, `target`, the
plugin `dist` directories) stay for the incremental build. The clone is the
harness's own build tree and this script is its one writer. `sim.config.json`
points `eidnara_checkout` and the artefact paths at the clone, and
`daemon_binary` names the `direct_host_fixture` the hermetic host stack
launches. The plugin
builds in the checkout's own `dist` directories can lag its daemon source: on
commit `bb866266c` the stale Pi plugin sent a window the daemon refused, and
every transform pass served its input unchanged.

The v1 harness closure pins OpenCode 1.18.22 and starts `opencode` from
`PATH`, so `opencode_binary` names that release and the host's wrapper, first
on `PATH` as `opencode`, launches it through the sandbox.

## Arms

`src/hosts/profiles.ts` declares each arm's profile, and the host stack
derives Pi's `compaction.enabled`, OpenCode's `compaction.auto` and
`compaction.prune`, and the user-tier `eidnara.jsonc` `compaction.enabled`
from it.

| Arm | Role | Daemon | Plugin | Eidnara compaction | Host compaction | Search route |
|---|---|---|---|---|---|---|
| `host` | host-only | none | none | n/a | on | none |
| `eidnara` | fallback-search | `direct_host_fixture` | Eidnara | on | off | legacy scan |
| `eidnara-kl` | knowledge-only | `direct_host_fixture` | Eidnara | off | on | legacy scan |
| `eidnara-cf` | fallback-search | `direct_host_fixture` | Eidnara | on | off | legacy scan |
| `eidnara-hybrid` | production-hybrid | production `eidnara-host` | Eidnara | on | off | fused |

`eidnara-cf` runs as `eidnara` here; its counterfactual deletions land with
the counterfactual arm. `eidnara-kl` keeps Eidnara's knowledge layer
(memory, injection, notes, `eidnara_search`, `eidnara_memory`) and leaves the
context window to the host (SIM-P76); with Eidnara compaction off, OpenCode's
conflict check reports no conflict with its native compaction.

Each daemon variant provides a fixed capability set, read from the Eidnara
source at commit `08de9051a`:

| Variant | Search route | Embeddings | Memory reviewer | Side calls |
|---|---|---|---|---|
| `direct_host_fixture` | legacy scan (no query route limits) | deterministic 8-dimension engine | none | through the proxy, by the `--harness-runtime` redirect extension |
| production `eidnara-host` | fused | `gte-modernbert-base-f32` | yes | straight to Bedrock |

The production launcher admits only its compiled-in qualified harness
closures, runs Pi with `--no-extensions` and a fresh `HOME`, and refuses AWS
endpoint overrides, so its model calls cannot reach the proxy and their cost
goes unmeasured. `armOrder` refuses an arm whose profile declares a
capability its variant lacks, naming each gap, before the run writes a
manifest or starts preflight; `eidnara-hybrid` is refused that way for its
side calls, and no tier pre-registers it.

## Capability evidence

The run checks each arm's evidence against its profile, and an arm is
complete evidence only when the two agree:

- At every `session_end` of the arm, the plugin log (`<arm>/r/eidnara.log`)
  must hold an enabled boot (Pi's `registered tools:` line, OpenCode's
  `plugin enabled` line) and no `disabled due to conflicts` or `plugin
  DISABLED` line, and Pi's boots must match the arm's Eidnara compaction
  (`eidnara_reduce` registered when on, `compaction-off mode` when off); a
  host-only arm must hold no boot. A mismatch fails the event, so the journal
  records it fatal and a resume refuses the run.
- At the arm's finish, after its host and daemon stop, the run writes
  `<arm>/capabilities.json`: the profile, the observed boots, the number of
  `served_from=transform` passes, the routes Pi's transcripts show each
  `eidnara_search` result came from (`null` on OpenCode, whose transcripts
  this check does not read), and the arm's proxy calls by component. It
  then fails the finish on any mismatch: a host-only arm with a plugin boot
  or an Eidnara component call; an arm with Eidnara compaction on that
  answered agent calls with no transform pass; one with it off that shows a
  transform pass or a `history_summarizer` call; or a search result from a
  route other than the declared one.

`HostDriver` owns the arm's daemon and its current host. `reset` stops both,
deletes the arm root and store, clones each scenario repository into a
workspace, and, on an Eidnara arm, starts a fresh daemon through the v1
`HermeticHostStack` with the interposer environment. `finish` runs after the
arm's last event, before `EndArm`: it closes the host, stops the daemon with
SIGTERM so its store stays on disk, and unmounts the store; a host or daemon
whose teardown fails stays held with its recorded identity, so the failure's
state names it for the next reap, and a driver that finishes before it ever
reset or resumed adds the failure to the record on disk, leaving the
identities the killed harness wrote in place; the daemon's
output reaches `<arm>/daemon.log` as it is written.
`stop` first waits for a host `openSession` or a daemon start or restart still
in flight, so a process spawned moments before a stop is closed rather than
leaked, and ends a counterfactual deletion child before the store goes;
concurrent closes of one host share a single shutdown.

`DaemonStack` starts the daemon through the v1 `HermeticHostStack` with the
interposer environment, restarts it with SIGKILL against the same store, and
stops it with SIGTERM so its store stays on disk; a daemon that outlives
SIGTERM is killed with the stack's SIGKILL path and the stop still fails. It
appends every chunk the daemon writes to the arm's `daemon.log` as it
arrives, across restarts, so a kill at any point loses nothing already
written; the output the readiness wait captured before the log attached
comes first, as the v1 stack buffered it (its stdout, then its stderr), and
the live stream after it keeps the order of arrival; the log opens with `O_NOFOLLOW` and `O_NONBLOCK` and must be a
regular file, so a symlink or FIFO left there fails the append without
blocking, and the first such failure surfaces at stop together with a failed
SIGKILL fallback.
`crash` kills the daemon by SIGKILL and leaves the store as the kill left
it; the next `restart` starts the replacement without a second kill, so a
caller can inspect the store in between.
The run's resource sampler takes a sample when each daemon process is up and
before a fault takes one down; a final sample that cannot be written fails
the arm's finish after the arm is shut down, so the run is not complete
evidence.

The sandbox has its own mount, pid, and System V IPC namespaces. `closeSession`
keeps its host handle until the whole teardown succeeds, so a failed close
can be retried. Each `session_start` launches one host process in the
session's workspace, which must lie below a kept path since the launcher
masks the run root, through the sandbox launcher, and each `session_end`
closes it; when the readiness check fails or Pi
refuses it, or the OpenCode SDK setup or session listing fails after the
launch, `openSession` closes the session it started before it throws. The
control files the hosts write under the arm root (Pi's settings, model list,
and Eidnara config; OpenCode's config, data, and cache directories; the
daemon's runtime and store directories) go through real directories only,
walked one component at a time so a symlinked ancestor is refused before
anything is created below it, and are created fresh and renamed into place, so a symlink an earlier
session left there is refused or replaced, never followed. OpenCode's config
directory and the daemon's runtime directory are regenerated on every start,
so they are removed first. The sandbox runs the host under
root-owned `sudo` and `unshare`, so closing a host walks the launcher's
process tree and signals every process the user owns, with SIGKILL after
10 s; what is left of a launch whose identity was pinned at spawn, including a
launcher still root-owned in its privileged setup, is then killed through the
passwordless `sudo` the launcher runs under, and a process that survives that
stops the run. The launcher root's start time is
taken when it is spawned, so a root pid the kernel has since reused is left
alone, and a launch whose start time could not be read is not signalled. Each pid in that walk is
paired with its start time and checked against it before every signal, so a
pid the kernel reuses during the grace period is left alone. The launcher's
pid namespace ends with its init, so a child forked while the tree stops dies
with the namespace. `prompt` sends one user turn with the turn deadline and
returns the host's error, if any. Pi emits `agent_end` with `willRetry: true`
before it retries a failed request itself, so a Pi turn ends only at an
`agent_end` Pi will not retry. After that end Pi may compact the session and
continue the run, so a turn is settled only once `get_state` reports Pi
neither streaming nor compacting and a 1 s window passes with no
`agent_start` or `compaction_start`, and no `compaction_end` with
`willRetry: true` waits for its continuation's start; its result is the last
such `agent_end`.
Both waits are bounded by the turn's remaining time (the state check gets at
least 1 s), and a refused `get_state` counts as unsettled, so the turn goes
through the abort and drain below. A prompt Pi refuses in preflight starts no
turn, so its error is returned at once. After a Pi turn fails, the host
aborts it and, alongside the abort, waits up to 30 s for its `agent_end`
(an end the turn's own waiter saw before the failure counts, and the drain
waiter is armed before that check so no end falls between); a turn still
running then stops the run, so a late end cannot finish the next turn. OpenCode turns race the deadline,
abort the session (waiting at most 30 s for the abort call), and wait 30 s for
the call to drain; a call still running then stops the run, and so does an
abort call still pending after 30 s, since it would cancel the next turn,
an OpenCode session setup (listing or creating the session) still pending
after 120 s,
and so does a deadline abort the server does not confirm with `true`. A
scheduled interrupt's abort the server refuses or fails leaves the turn to run
on under its deadline, reported as it ends. A
prompt request that fails before the server answers is aborted the same way,
and an abort that fails stops the run, since the turn's completion cannot be
established. A Pi interrupt sends `abort` and reads the turn's own `agent_end`
within the drain wait, whatever the abort's answer; the turn is `interrupted`
only when the last assistant message stopped with `aborted`. A prompt the host
refused, a prompt request that failed before Pi accepted it or the OpenCode
server answered, and a turn whose deadline the user-sim call or the message
listing spent before the prompt report `undelivered`, and the runner journals
that turn's `UserTurn` as not delivered. The runner passes each turn the part of
its deadline the user-sim call left (`deadline_ms`). A Pi `agent_end` seen before the prompt response fails settles
that turn with its result.
Every deadline timer is cleared once its race settles. An OpenCode prompt that returns before the session's last
assistant step finishes (`finish` other than `stop` or `length`) is a
failed turn, and the session is aborted first (an abort still unanswered
after the abort wait stops the run) so the step runs into no later turn. A
prompt that returns with no assistant message of its own is a failed turn
too. A prompt sent in that state ends its conversation on an
assistant message, which Bedrock refuses as a prefill.
An `apply_diff` event writes its file inside the
workspace and commits that path alone, so the agent's own uncommitted edits
stay uncommitted; content already committed adds no commit, and a path that
resolves outside the workspace through `..` or a symlink stops the run before
any directory is created. The file is written whole and renamed into place,
so a hard link the agent left at the path keeps its other name's content, and
the `git add` and `git commit` run inside the arm's sandbox under the turn
deadline, with the selected workspace and a harness-owned git home
(`<arm>/git-home`) kept and the sibling workspaces, the host's home, and
the daemon's store masked, with the hosts' read-only paths (toolchains, the interposer, the
build clone, the Pi, Node, and OpenCode installs) read-only, a fresh
environment, and the system path alone (`/usr/local/bin:/usr/bin:/bin`) for
resolving `timeout` and `git`, since the sandbox enters the workspace before
it resolves them, and only against a `.git` that is the workspace's own directory, so a hook,
filter, or config the agent planted in the repository acts with the host's
own view of the filesystem and sees none of the harness's variables, and a
hook that hangs stops the run instead of the harness. The run's pid is in
`state.json` before its process starts (the shell waits for a line on stdin
until the record is written, then execs the launcher, so the recorded pid is
the launcher's `sudo` and the deadline's `timeout` runs inside the sandbox),
so a resume stops one the killed harness left behind and removes its
`index.lock` before replaying the event; a launch whose start time the
kernel did not report is ended unreleased and stops the run, since the
record names a process by pid and start; a run that fails removes its own
`index.lock`, `HEAD.lock`, `packed-refs.lock`, and any ref lock, and both
removals leave a `.git` that is a link alone. The commit's author and committer dates are the
event's scenario instant (`baseMs + scenario_ms`), so paired arms and a
resumed delivery produce the same commit. Every session and `apply_diff`
requires the workspace to resolve to the real `<arm>/r/workspaces/<project>`;
a symlink the agent put at it or above it stops the run, since the harness
and the launcher would follow it with their own privileges; the daemon's
`runtime` and data directories get the same check before every daemon start
and restart; the data directory is bound to itself, so it is a mount point
the host cannot rename or replace while a restart writes under it, and the
daemon's harness runtime lives at `<arm>/runtime`, beside the arm and outside
every path the host can write, so a restart executes what the harness
generated.

Each host process starts in the session's workspace, which the launcher
enters after its privilege drop. Pi runs in RPC mode with `--session-id sim-<session>`, its agent directory,
settings, and model list under the arm root, and the Eidnara extension from
the build clone on Eidnara arms. OpenCode runs through the v1 `spawnOpencode`,
with a wrapper script that launches the pinned binary, resolved to its
canonical path so the read-only install covers the file that runs, through the sandbox
launcher, and titles each session `sim-<session>`. The v1 runner starts the
wrapper as the harness's own child and the wrapper execs the launcher, so
`closeSession` stops the one process serving the session's port whose parent
is the harness. The v1 runner executes the
wrapper on the host, outside the sandbox, so it lives at
`<run>/hostbin/<arm>/opencode` beside the launcher: the sandbox masks the run
root, and the arm root the agent can write holds nothing a later session
executes with the user's privileges. Each OpenCode session
denies the `question`, `plan_enter`, and `plan_exit` permissions, as
`opencode run` does for a non-interactive session: in the first live
OpenCode run, the agent asked the user a question and the turn waited until
its 900 s deadline. The harness also preloads `libfaketimeMT.so.1`, the
build that serializes libfaketime's shared state across threads; under the
single-threaded build, OpenCode crashed with `double free detected` after
libfaketime read a torn timestamp line. Both reach Bedrock only through the
proxy, with placeholder AWS credentials.

The launcher binds kept paths read-write and read-only paths read-only, and
refuses a writable kept path under a read-only one, compared through
canonical paths so a symlink alias cannot split them, and any path that
equals or contains a masked root (`/tmp`, the user's home, the run root),
directly or through a symlink, so narrow paths such as
`~/.cargo` stay visible while the home itself stays hidden. Configured paths
must be normalized, since the launcher refuses others. The arm's own
directories are read-write; the scenario clock's directory is read-only
inside the sandbox, since the scheduler writes it from outside. The toolchain paths, the tool
wrappers, the interposer build, the eidnara build clone, and the Node and Pi
installs are read-only, so the agent reads and runs them while later
sessions and arms run the same files; `touch` under `~/.cargo/bin` fails inside
the sandbox with `Read-only file system`.

The agent's build tools come from `config.toolchain`: its `bin` directories,
each under a `keep` path, come first on the host's `PATH`, followed by the
system directories `/usr/local/bin:/usr/bin:/bin`, the same `PATH` the
toolchain probe and both hosts use, its `keep` paths (the cargo binaries, registry, and
git cache, rustup, and the bun binary and install cache) stay visible and
read-only inside the sandbox (a mount nested inside a read-only path is
remounted read-only too), and its `env` sets `CARGO_HOME`, `RUSTUP_HOME`,
and `BUN_INSTALL_CACHE_DIR`, the only variables `toolchain.env` accepts, since
a variable that selects an executable would bypass preflight. The hosts replace `HOME`, and Bun resolves its
cache from `HOME` unless that variable names it, so the variable is what points
`bun install` at the kept cache. Preflight requires each of these paths to lie
under a read-only keep path or under a masked root (the home or `/tmp`, which
each sandbox sees as its own empty tmpfs), so no arm writes a tool home or
cache another arm reads. The agent builds and tests against the
dependencies already in those caches; fetching a dependency they lack fails
against those caches. The sandbox keeps the host network namespace, since the
hosts reach the proxy over loopback, so an agent that points a cache at its
writable workspace can fetch, and preflight records the distortion in those
terms.

Every process the host starts inherits the interposer. rustc 1.99 hangs at
startup under libfaketime 0.9.10: in the first two-arm witness run
(`witness-5`, 2026-10-16), the agent's `cargo test` sat in `rustc -vV` until
Pi's 600 s tool timeout, and `LD_PRELOAD=libfaketime.so.1 rustc -vV` hangs
outside the sandbox too. Each
tool in `wall_clock_tools` (rustc and rustdoc, the only accepted names)
therefore runs through a wrapper
in `<run>/toolbin` that drops the preload, and `RUSTC` and `RUSTDOC` point
cargo at the wrappers, since rustup puts its own toolchain directory first on
cargo's `PATH`. Those tools read wall-clock time, and preflight records that
distortion. Preflight writes the wrappers, then runs `cargo --version`,
`"${RUSTC:-rustc}" -vV`, `"${RUSTDOC:-rustdoc}" --version`, and `bun --version` under the interposer through the
launcher, so the rustc check goes through the same wrapper cargo uses (or
`rustc` on `PATH` when no wrapper is configured), and
records each version line, which must name the tool's version (`rustdoc
--version` runs too, through its wrapper); a tool that
fails, prints no version, or runs past 60 s has its tree
stopped and stops the run.

The daemon's store directory `<arm>/s` stays visible inside the sandbox on
Eidnara arms, because the plugin reaches the daemon through the connection
file and socket under it, and a daemon restart recreates them there. The
agent can therefore read the store, as it can on a workstation where the
store sits under the user's home.

## Resume

The driver keeps `<arm>/state.json` current with the model index, the
daemon restarts whose `StoreChecked` entry the journal may still lack (each
with its plugin-log mark), and the
pid and start time of the daemon and of the host while a session is open,
replacing the file whole so a kill mid-write leaves the previous state. Pi's
pid is recorded as soon as its process exists, before the readiness wait, and
the launcher runs only once that record is written (the gating shell waits
on a pipe the driver releases after the write; the record carries the start
time captured at the launch, and a launch whose start the kernel did not
report is killed unreleased and fails the session);
OpenCode's once `spawnOpencode` returns, before the SDK setup; the OpenCode
wrapper also writes its own pid and start time to `<arm>/opencode.launch`
(staged and renamed whole; a record it cannot write ends the wrapper before
the launcher) before it execs the launcher, so a harness killed while the
server starts leaves a record the next resume reaps. A daemon the fixture spawned before
the harness died carries this arm's data directory as its `--state-root`, and
the reaper finds and stops it by that argument. The state
also carries the length and allocated blocks of an active `store_full`
ballast with the fault's id (cleared before the file goes, so a kill in
between leaves a leftover the resume removes, and a ballast whose fault the
journal fired and never observed is removed on resume instead of refilled,
since the run records that fault as interrupted), a `refilling` flag while a resume has removed the ballast
and has yet to fill the store again, so a kill inside that window refills on
the next attempt, and, through `transcripts.json`, a transcript-store gap
already found; a resume stops on a ballast whose length or blocks changed, or
that is a link (a sparse replacement, a punched hole, or a look-alike
elsewhere all count), or on a recorded gap, since neither may heal.
A new harness process calls `reap()` and then `resume(open)` on an arm that
has `StartArm` and no `EndArm`; an arm whose every event is journaled resumes
with `resume(null)`, which restores its daemon, store, and owed store checks
without opening a session, and then finishes, so its final store check reads
the store the killed harness left. `reap` requires the state, stops each recorded process, host first,
and then refuses an arm whose `finish` failed earlier (the state records the
failure, so a resume cannot heal it, while the reap still releases what it
can),
whose start time still matches, then unmounts a store left mounted; every
step runs and the first failure surfaces afterwards (a process that outlives
SIGTERM and SIGKILL stops the resume with `HarnessFailure`),
before the scheduler arms any proxy fault again. `resume` restores the host model index (the daemon keeps the arm's first
model, as it did before the kill) and the owed store checks, mounts the
existing store image (a missing image or `state.json` stops the resume,
since only `reset` formats one and the state names what to stop), starts the daemon against the existing store, and, when
the next event is inside a session, opens that session again. Pi reopens the
same session transcript by its session id, and OpenCode reuses the session
with the same title. `reset` stops recorded processes first (a clone in
flight is recorded like an `apply_diff`'s git), since a daemon the killed
harness left holds the data directory busy, then its own, and unmounts the
store before it deletes anything, so a harness killed during `reset`
leaves no recorded process running into the next attempt, and it removes the
`daemon.log` and `transcripts.json` of an abandoned attempt. A daemon or an
OpenCode server still starting when the harness dies has no pid in
`state.json` yet; the reaper finds the daemon by its `--state-root` argument
and the OpenCode launcher by the wrapper's `opencode.launch` record, so both
stop before the next `reset` or `resume` proceeds.

## Transcript-store check

After an arm's first `session_end`, the driver expands the preflight's
transcript-store paths for the host version with the host's own variables
(`$PI_CODING_AGENT_DIR`, `$XDG_DATA_HOME`) and writes the result to
`<arm>/transcripts.json`. A missing path stops the run (OQ-7); a link at the
store or at any ancestor below the arm root, or a node of the other kind (`TRANSCRIPT_STORES` names `opencode.db` as the one
file, the rest are directories), left where the store should be counts as
missing.

## Infrastructure faults

The scheduler opens an outage window before a daemon fault and closes it at
the next event. The harness owns every daemon restart, through the hermetic
host stack's `crashHost`, which sends SIGKILL, and `restartHost`, which
starts the fixture against the same store (OQ-10); the driver inspects the
store between the two.

| Fault | Mechanism | Evidence |
|---|---|---|
| `daemon_sigkill_mid_fold` | The session's first observed history-summarizer call fires it; SIGKILL and restart | `pid_before`, `pid_after`, `restarted_by: harness`, and the store check between the SIGKILL and the replacement's start (`docs/oracles.md`); the first turn boundary, session end, or finish at which the plugin log shows a pass the replacement served (`served_from=transform` past the log's length at the restart), or a later daemon fault before it kills the daemon, journals a second check as `StoreChecked` |
| `daemon_restart` | At `session_start`, SIGKILL and restart | As above |
| `store_full` | When the scenario schedules `store_full`, each Eidnara arm's store lives on a sparse 2 GiB ext4 loop mount (`nosuid,nodev,noexec`) at `<arm>/s`, room for the daemon to materialize its harness closures twice, with its image outside the sandbox's kept paths; the fault fills it with a `fallocate`d ballast topped up by `dd`, so the sparse image stays small, and `session_end` removes the ballast (the arm's `finish` removes a ballast no `session_end` cleared, under the same checks, before it unmounts the store); a resume that finds the ballast removes it for the daemon's start and fills the store again, whether or not that start succeeds, and requires the store to report no free space afterwards; the store is writable to the host, so `session_end` requires the ballast to be the regular file it created with its length and blocks unchanged, its only name (a second hard link would keep the blocks allocated after the unlink), and the store to still report no free space, and stops the run otherwise; the fault replaces whatever the host left at the ballast's name with a fresh regular file before allocating | `avail_kb: 0`; any other value stops the run |
| `plugin_reload` | The host process and its plugin start afresh at every `session_start` | The reload note |
| `model_switch` | Later sessions use the next configured model; the daemon keeps running with its summarizer model | The new model id |
| `laptop_sleep` | One event-free clock jump (`docs/run.md`) | The `AdvanceClock` entry, and `clock_advanced_ms` |
| `host_upgrade` | Later sessions run the next pinned version of the arm's host, `config.upgrade.pi_install` or `config.upgrade.opencode_binary` (Pi 0.87.1 and OpenCode 1.18.23 in `sim.config.json`); the daemon's harness closures keep the pinned versions; preflight records each configured version and its transcript store paths, refusing a target that resolves to the current version, which the fault's evidence reports and the next `session_end` checks again for the upgraded host, requiring the store to have changed during that session (symlinks in the store are skipped), with `transcripts.json` recording that result so a resume repeats a failed check and accepts only the upgraded host's own fresh check once upgraded, and `state.json` keeping the session's opening mark across a stop, and probes the next OpenCode binary's time interception as `opencode-upgrade`; without a configured version the fault is skipped | `from`, `to`, both `--version` strings, and `takes_effect` |
| `two_hosts_one_daemon` | At its `session_start`, a second host client opens session `<session>-b` in the same workspace on the arm's daemon and runs one fixed turn, with the proxy's scope on `<session>-b` and its tool runs in `tools.jsonl` under turn `<session>-b`; after the turn the proxy's scope is the primary session with no turn; it stays attached while the primary session opens and runs, and closes at the primary's `session_end`, which first requires its host process to be running, so both clients are registered on the daemon together; `state.json` holds its pid for a resumed arm to reap, and keeps it when the close fails; a run stopped inside that session reaps it and attaches a fresh second client when that session next opens on resume (`state.json` names the session, with or without a live pid, and keeps naming it across further stops until the client is attached or the session ends), its fixed turn already run; daemon calls made for the second client after its turn carry the primary session's scope | The second session, its host pid, the daemon pid, the turn's outcome, and `attached_until` |

`daemon_restart`, `plugin_reload`, `model_switch`, `store_full`,
`host_upgrade`, `two_hosts_one_daemon`, and `apply_diff` fire between
sessions, while the host is stopped, so the harness's writes (the ballast
among them) meet no concurrent host process; one fired inside a session stops
the run. A scheduler-layer fault type with no mechanism here stops the run
before `StartRun`, through the driver's `supports`, so a resume cannot heal
it; provider faults belong to the proxy and the sleep to the clock, so
`supports` accepts them. A daemon that exits outside an
outage window stops the run with `HarnessFailure`; the driver checks the
daemon after every turn, including a turn whose prompt rejected (the daemon's
exit is the cause of a lost connection, so it is reported first), and at
every `session_end`.

## Limits

- Closing the host at `session_end` can cut a memory capture still
  streaming; one smoke run recorded it as `stream_cut`.
- A daemon that dies during a turn is detected when the turn ends; one that
  dies after the last `session_end` of an arm is detected by the next arm's
  resume or by its own log.
- `plugin_reload` adds no mechanism beyond the per-session host process.
- On OpenCode, the turn deadline aborts the session through the server, so a
  server that ignores the abort holds the run for the 30 s drain window.
