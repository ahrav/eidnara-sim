# Host drivers

`src/hosts/` holds the arm drivers. `arms.ts` launches Pi or OpenCode and
wraps the daemon stack, and `driver.ts` runs one arm's events and
scheduler-layer faults. `docs/run-command.md` describes the run command that
wires them to the proxy, clock, and scheduler.

## Eidnara build

The plugins, native addon, daemon, and host fixture come from one commit.
`scripts/eidnara-build.sh <checkout> <clone>` clones the configured eidnara
checkout, checks out its `HEAD`, and builds every artefact inside the clone,
so the checkout itself stays read-only. `sim.config.json` points
`eidnara_checkout` and the artefact paths at the clone, and `daemon_binary`
names the `direct_host_fixture` the hermetic host stack launches. The plugin
builds in the checkout's own `dist` directories can lag its daemon source: on
commit `bb866266c` the stale Pi plugin sent a window the daemon refused, and
every transform pass served its input unchanged.

The v1 harness closure pins OpenCode 1.18.22 and finds it on `PATH`, so
`opencode_binary` names that release, and an Eidnara arm needs the release's
`node_modules/.bin` first on `PATH`.

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
stops it with SIGTERM so its store stays on disk. It appends the daemon's
stdout and stderr to the arm's `daemon.log` before each restart and at stop,
each line once: stderr copied a megabyte at a time from the log file the v1
stack writes each chunk to and truncates at each host start, stdout from the
stack's `diagnostics` view, which keeps the last 256 KiB. The saved log file
is removed once copied, and `daemon.log.source` names the live lifetime's
file, so a `start` after a harness kill saves the dead lifetime's stderr
first. The run's resource sampler takes a sample when each daemon process is
up and before a fault takes one down.

Each `session_start` launches one host process in the session's workspace
through the sandbox launcher, and each `session_end` closes it. The sandbox runs the host under
root-owned `sudo` and `unshare`, so closing a host walks the launcher's
process tree and signals every process the user owns, with SIGKILL after
10 s; a process that survives SIGKILL stops the run. A user turn is one prompt with the turn deadline, and the host's error
becomes a failed turn. After a Pi turn fails, the host aborts it and waits up
to 30 s for its `agent_end`, so a late end cannot finish the next turn.
OpenCode turns race the deadline, abort the session (waiting at most 5 s for
the abort call), and wait 30 s for the call to drain; a call still running
then stops the run. An `apply_diff` event writes its file inside the
workspace and commits that path alone, so the agent's own uncommitted edits
stay uncommitted; content already committed adds no commit, and a path that
resolves outside the workspace through `..` or a symlink stops the run. The
commit is built with plumbing (`hash-object --no-filters`, a scratch index
whose entry keeps the file's executable bit, `commit-tree`, `update-ref`) and every workspace git run pins `GIT_DIR` and
`GIT_WORK_TREE`, points `core.hooksPath` at an absent directory, turns
`core.fsmonitor` and `commit.gpgsign` off, and runs with the repository's
config swapped for the clone's baseline (the agent's config returns
afterwards), because the agent can write that config and the harness process
runs outside the sandbox. The workspace path itself must be a real directory
under the arm root, an existing ancestor of the diff's path must resolve
inside it before any directory is created, and a `.git` that is a file or
symlink, any entry under `.git` that is not a regular file or directory, a
missing `.git/config`, or an `objects/info/alternates` file stops the run
before git writes anything; every workspace git run is bounded by the turn
deadline.

Pi runs in RPC mode with `--session-id sim-<session>`, its agent directory,
settings, and model list under the arm root, and the Eidnara extension from
the build clone on Eidnara arms. OpenCode runs through the v1 `spawnOpencode`,
with a wrapper script that launches the pinned binary through the sandbox
launcher, and titles each session `sim-<session>`. Each OpenCode session
denies the `question`, `plan_enter`, and `plan_exit` permissions, as
`opencode run` does for a non-interactive session: in the first live
OpenCode run, the agent asked the user a question and the turn waited until
its 900 s deadline. The harness also preloads `libfaketimeMT.so.1`, the
build that serializes libfaketime's shared state across threads; under the
single-threaded build, OpenCode crashed with `double free detected` after
libfaketime read a torn timestamp line. Both reach Bedrock only
through the proxy, with placeholder AWS credentials.

The launcher binds kept paths read-write and read-only paths read-only.
The arm's own directories are read-write. The toolchain paths, the tool
wrappers, the interposer build, the eidnara build clone, and the Node and Pi
installs are read-only, so the agent reads and runs them while later
sessions and arms run the same files; `touch` under `~/.cargo/bin` fails inside
the sandbox with `Read-only file system`.

The agent's build tools come from `config.toolchain`: its `bin` directories
join the host's `PATH`, its `keep` paths (the cargo binaries, registry, and
git cache, rustup, and the bun binary and install cache) stay visible and
read-only inside the sandbox, and its `env` sets `CARGO_HOME` and
`RUSTUP_HOME`. The agent builds and tests against the dependencies already
in those caches; fetching a dependency they lack fails, and preflight
records that distortion.

Every process the host starts inherits the interposer. rustc 1.99 hangs at
startup under libfaketime 0.9.10: in the first two-arm witness run
(`witness-5`, 2026-10-16), the agent's `cargo test` sat in `rustc -vV` until
Pi's 600 s tool timeout, and `LD_PRELOAD=libfaketime.so.1 rustc -vV` hangs
outside the sandbox too. Each
tool in `wall_clock_tools` (rustc, rustdoc) therefore runs through a wrapper
in `<run>/toolbin` that drops the preload, and `RUSTC` and `RUSTDOC` point
cargo at the wrappers, since rustup puts its own toolchain directory first on
cargo's `PATH`. Those tools read wall-clock time, and preflight records that
distortion. Preflight writes the wrappers, then runs `cargo --version`,
`"$RUSTC" -vV`, and `bun --version` under the interposer through the
launcher, so the rustc check goes through the same wrapper cargo uses, and
records the versions; a tool that fails or runs past 60 s has its tree
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
| `daemon_sigkill_mid_fold` | The session's first observed history-summarizer call fires it; SIGKILL and restart | `pid_before`, `pid_after`, `restarted_by: harness` |
| `daemon_restart` | At `session_start`, SIGKILL and restart | As above |
| `store_full` | When the scenario schedules `store_full`, each Eidnara arm's store lives on a sparse 2 GiB ext4 loop mount (`nosuid,nodev,noexec`) at `<arm>/s`, room for the daemon to materialize its harness closures twice, with its image outside the sandbox's kept paths; the fault fills it, and `session_end` removes the ballast | `avail_kb: 0`; any other value stops the run |
| `plugin_reload` | The host process and its plugin start afresh at every `session_start` | The reload note |
| `model_switch` | Later sessions use the next configured model; the daemon keeps running with its summarizer model | The new model id |
| `laptop_sleep` | One event-free clock jump (`docs/run.md`) | The `AdvanceClock` entry |

`plugin_reload` and `model_switch` fire between sessions; one fired inside a
session stops the run, and so does a fault type with no mechanism here
(`host_upgrade`, `two_hosts_one_daemon`). A daemon that exits outside an
outage window stops the run with `HarnessFailure`; the driver checks the
daemon after every turn.

## Limits

- Closing the host at `session_end` can cut a memory capture still
  streaming; one smoke run recorded it as `stream_cut`.
- A daemon that dies during a turn is detected when the turn ends.
- `plugin_reload` adds no mechanism beyond the per-session host process.
- On OpenCode, the turn deadline aborts the session through the server, so a
  server that ignores the abort holds the run for the 30 s drain window.
