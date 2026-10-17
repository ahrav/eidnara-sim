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

| Arm | Daemon | Plugin | Host compaction |
|---|---|---|---|
| `host` | none | none | on |
| `eidnara` | hermetic host stack | Eidnara | off |
| `eidnara-kl` | hermetic host stack | Eidnara | on |
| `eidnara-cf` | hermetic host stack | Eidnara | off |

`eidnara-cf` runs as `eidnara` here; its counterfactual deletions land with
the counterfactual arm.

`HostDriver` owns the arm's daemon and its current host. `reset` stops both,
deletes the arm root and store, clones each scenario repository into a
workspace, and, on an Eidnara arm, starts a fresh daemon through the v1
`HermeticHostStack` with the interposer environment. `finish` runs after the
arm's last event, before `EndArm`: it closes the host, stops the daemon with
SIGTERM so its store stays on disk, appends the daemon's output to
`<arm>/daemon.log`, and unmounts the store. The daemon also appends its output
there before each restart.

`DaemonStack` starts the daemon through the v1 `HermeticHostStack` with the
interposer environment, restarts it with SIGKILL against the same store, and
stops it with SIGTERM so its store stays on disk; a daemon that outlives
SIGTERM is killed with the stack's SIGKILL path and the stop still fails. It
appends the daemon's output to the arm's `daemon.log` before each restart and
after the daemon has stopped, opening the log with `O_NOFOLLOW` and `O_NONBLOCK` and requiring a regular
file, so a symlink or FIFO left there fails the append without blocking; a
failed SIGKILL fallback still records the log and reports both failures; the v1
stack keeps the last 256 KiB of that output, so a longer stretch keeps its
tail.

The sandbox has its own mount, pid, and System V IPC namespaces. `closeSession`
keeps its host handle until the whole teardown succeeds, so a failed close
can be retried. `openSession` launches one host process in a workspace, which must lie below
a kept path since the launcher masks the run root, through the sandbox
launcher, and `closeSession` stops it; when the readiness check fails or Pi
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
aborts it and, alongside the abort, waits up to 30 s for its `agent_end`; a turn still running then
stops the run, so a late end cannot finish the next turn. OpenCode turns race the deadline,
abort the session (waiting at most 30 s for the abort call), and wait 30 s for
the call to drain; a call still running then stops the run, and so does an
abort call still pending after 30 s, since it would cancel the next turn,
an OpenCode session setup (listing or creating the session) still pending
after 120 s,
and so does an abort the server does not confirm with `true`. A
prompt request that fails before the server answers is aborted the same way,
and an abort that fails stops the run, since the turn's completion cannot be
established. A Pi `agent_end` seen before the prompt response fails settles
that turn with its result.
Every deadline timer is cleared once its race settles. An OpenCode prompt that returns before the session's last
assistant step finishes (`finish` other than `stop` or `length`) is a
failed turn; a prompt sent in that state ends its conversation on an
assistant message, which Bedrock refuses as a prefill.
An `apply_diff` event writes its file inside the
workspace and commits that path alone, so the agent's own uncommitted edits
stay uncommitted; content already committed adds no commit, and a path that
resolves outside the workspace through `..` or a symlink stops the run. The
commit is built with plumbing (`hash-object --no-filters`, a scratch index
whose entry keeps the file's executable bit, `commit-tree`, `update-ref`) and every workspace git run pins `GIT_DIR` and
`GIT_WORK_TREE`, points `core.hooksPath` at an absent directory, turns
`core.fsmonitor` and `commit.gpgsign` off, and runs with the repository's
config swapped for the clone's baseline (saved at reset through an exclusive
create, so a symlink planted at its path is replaced, and the agent's config
returns afterwards), because the agent can write that config and the harness process
runs outside the sandbox. The workspace path itself must be a real directory
under the arm root, an existing ancestor of the diff's path must resolve
inside it before any directory is created, and a `.git` that is a file or
symlink, any entry under `.git` that is not a regular file or directory, a missing `.git/config`, or an `objects/info/alternates`, `commondir`, or
`gitdir` file stops the run before git writes anything; every workspace and
recorder git run ignores replacement refs (`GIT_NO_REPLACE_OBJECTS=1`); every workspace git run is bounded by the turn
deadline, the walk of `.git` stops at that deadline or 200,000 entries, a
target path that exists must be a regular file, and a real-index update
that times out removes the `index.lock` it left.

Pi runs in RPC mode in the session workspace (the launcher starts its command
at `/`, so the command changes into the workspace before exec) with
`--session-id sim-<session>`, its agent directory,
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

The driver keeps `<arm>/state.json` current with the model index and the
pid and start time of the daemon and of the host while a session is open.
A new harness process calls `resume(open)` on an arm that has `StartArm` and
no `EndArm`. The driver restores the model index, stops each recorded process
whose start time still matches, unmounts a store left mounted, mounts the
existing store image, starts the daemon against the existing store, and, when
the next event is inside a session, opens that session again. Pi reopens the
same session transcript by its session id, and OpenCode reuses the session
with the same title. `reset` stops recorded processes and unmounts the store
the same way before it deletes anything, so a harness killed during `reset`
leaves no recorded process running into the next attempt. A daemon still
starting when the harness dies has no pid on record yet; its mount then
stays busy and the next `reset` or `resume` stops with the `umount` error.

## Transcript-store check

After an arm's first `session_end`, the driver expands the preflight's
transcript-store paths for the host version with the host's own variables
(`$PI_CODING_AGENT_DIR`, `$XDG_DATA_HOME`) and writes the result to
`<arm>/transcripts.json`. A missing path stops the run (OQ-7).

## Infrastructure faults

The scheduler opens an outage window before a daemon fault and closes it at
the next event. The harness owns every daemon restart, through the hermetic
host stack's `restartHost`, which sends SIGKILL and starts the fixture
against the same store (OQ-10).

| Fault | Mechanism | Evidence |
|---|---|---|
| `daemon_sigkill_mid_fold` | The session's first observed history-summarizer call fires it; SIGKILL and restart | `pid_before`, `pid_after`, `restarted_by: harness`, and the store check right after the restart (`docs/oracles.md`); the end of the turn in progress at the restart, or else the next turn, journals a second check as `StoreChecked` |
| `daemon_restart` | At `session_start`, SIGKILL and restart | As above |
| `store_full` | When the scenario schedules `store_full`, each Eidnara arm's store lives on a sparse 2 GiB ext4 loop mount (`nosuid,nodev,noexec`) at `<arm>/s`, room for the daemon to materialize its harness closures twice, with its image outside the sandbox's kept paths; the fault fills it, and `session_end` removes the ballast | `avail_kb: 0`; any other value stops the run |
| `plugin_reload` | The host process and its plugin start afresh at every `session_start` | The reload note |
| `model_switch` | Later sessions use the next configured model; the daemon keeps running with its summarizer model | The new model id |
| `laptop_sleep` | One event-free clock jump (`docs/run.md`) | The `AdvanceClock` entry, and `clock_advanced_ms` |
| `host_upgrade` | Later sessions run the next pinned version of the arm's host, `config.upgrade.pi_install` or `config.upgrade.opencode_binary` (Pi 0.87.1 and OpenCode 1.18.23 in `sim.config.json`); the daemon's harness closures keep the pinned versions; preflight records each configured version, which the fault's evidence reports, and probes the next OpenCode binary's time interception as `opencode-upgrade`; without a configured version the fault is skipped | `from`, `to`, both `--version` strings, and `takes_effect` |
| `two_hosts_one_daemon` | At its `session_start`, a second host client opens session `<session>-b` in the same workspace on the arm's daemon and runs one fixed turn, with the proxy's scope on `<session>-b`; it stays attached while the primary session opens and runs, and closes at the primary's `session_end`, so both clients are registered on the daemon together; `state.json` holds its pid for a resumed arm to reap, and a run stopped inside that session closes it without reopening it on resume; daemon calls made for the second client after its turn carry the primary session's scope | The second session, its host pid, the daemon pid, the turn's outcome, and `attached_until` |

`plugin_reload`, `model_switch`, `host_upgrade`, and `two_hosts_one_daemon`
fire between sessions; one fired inside a session stops the run, and so
does a fault type with no mechanism here. A daemon that exits outside an
outage window stops the run with `HarnessFailure`; the driver checks the
daemon after every turn.

## Limits

- Closing the host at `session_end` can cut a memory capture still
  streaming; one smoke run recorded it as `stream_cut`.
- A daemon that dies during a turn is detected when the turn ends.
- `plugin_reload` adds no mechanism beyond the per-session host process.
- On OpenCode, the turn deadline aborts the session through the server, so a
  server that ignores the abort holds the run for the 30 s drain window.
