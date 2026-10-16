# Host drivers

`src/hosts/arms.ts` launches Pi or OpenCode for one session and wraps the
daemon stack. The arm driver that runs a scenario's events and faults on them
lands next.

## Eidnara build

The plugins, native addon, daemon, and host fixture come from one commit.
`scripts/eidnara-build.sh <checkout> <clone>` clones the eidnara source
checkout, checks out its `HEAD`, and builds every artefact inside the clone,
so the source checkout itself stays read-only; it refuses a clone path that
is the checkout or lies beneath it, and reuses an existing clone only when
its `.sim-build-source` names the same checkout. It holds `<clone>.lock`
with `flock` for the whole build, so a second build of the same clone is
refused. A first clone is made at `<clone>.partial` and renamed into place
once it carries its source record, so an interrupted clone leaves only the
partial tree, which the next build removes. `.sim-build-commit` holds
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

`DaemonStack` starts the daemon through the v1 `HermeticHostStack` with the
interposer environment, restarts it with SIGKILL against the same store, and
stops it with SIGTERM so its store stays on disk; a daemon that outlives
SIGTERM is killed with the stack's SIGKILL path and the stop still fails. It
appends the daemon's output to the arm's `daemon.log` before each restart and
at stop, opening the log with `O_NOFOLLOW` so a symlink left there fails the
append; the v1
stack keeps the last 256 KiB of that output, so a longer stretch keeps its
tail.

`openSession` launches one host process in a workspace through the sandbox
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
10 s; a process that survives SIGKILL stops the run, and so does a launcher
root that has not exited by then, since a launcher still in its privileged
setup has no user-owned process to signal. The launcher root's start time is
taken when it is spawned, so a root pid the kernel has since reused is left
alone. Each pid in that walk is
paired with its start time and checked against it before every signal, so a
pid the kernel reuses during the grace period is left alone. The launcher's
pid namespace ends with its init, so a child forked while the tree stops dies
with the namespace. `prompt` sends one user turn with the turn deadline and
returns the host's error, if any. Pi emits `agent_end` with `willRetry: true`
before it retries a failed request itself, so a Pi turn ends only at an
`agent_end` Pi will not retry. After that end Pi may compact the session and
continue the run, so a turn is settled only once `get_state` reports Pi
neither streaming nor compacting and a 1 s window passes with no
`agent_start` or `compaction_start`; its result is the last such `agent_end`.
Both waits are bounded by the turn's remaining time (the state check gets at
least 1 s), and a refused `get_state` counts as unsettled, so the turn goes
through the abort and drain below. A prompt Pi refuses in preflight starts no
turn, so its error is returned at once. After a Pi turn fails, the host
aborts it and waits up to 30 s for its `agent_end`; a turn still running then
stops the run, so a late end cannot finish the next turn. OpenCode turns race the deadline,
abort the session (waiting at most 5 s for the abort call), and wait 30 s for
the call to drain; a call still running then stops the run, and so does an
abort call still pending after 30 s, since it would cancel the next turn,
and so does an abort that fails or reports an error. A
prompt request that fails before the server answers is aborted the same way,
and an abort that fails stops the run, since the turn's completion cannot be
established. A Pi `agent_end` seen before the prompt response fails settles
that turn with its result.
Every deadline timer is cleared once its race settles.

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
executes with the user's privileges. Both reach Bedrock only through the
proxy, with placeholder AWS credentials.

The launcher binds kept paths read-write and read-only paths read-only, and
refuses a writable kept path under a read-only one and any path that equals
or contains a masked root (`/tmp`, the user's home), so narrow paths such as
`~/.cargo` stay visible while the home itself stays hidden. Configured paths
must be normalized, since the launcher refuses others. The arm's own
directories are read-write. The toolchain paths, the tool
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
and `BUN_INSTALL_CACHE_DIR`. The hosts replace `HOME`, and Bun resolves its
cache from `HOME` unless that variable names it, so the variable is what points
`bun install` at the kept cache. The agent builds and tests against the
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
tool in `wall_clock_tools` (rustc, rustdoc) therefore runs through a wrapper
in `<run>/toolbin` that drops the preload, and `RUSTC` and `RUSTDOC` point
cargo at the wrappers, since rustup puts its own toolchain directory first on
cargo's `PATH`. Those tools read wall-clock time, and preflight records that
distortion. Preflight writes the wrappers, then runs `cargo --version`,
`"${RUSTC:-rustc}" -vV`, and `bun --version` under the interposer through the
launcher, so the rustc check goes through the same wrapper cargo uses (or
`rustc` on `PATH` when no wrapper is configured), and
records each version line, which must name the tool's version; a tool that
fails, prints no version, or runs past 60 s has its tree
stopped and stops the run.
