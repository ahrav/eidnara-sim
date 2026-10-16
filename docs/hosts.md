# Host drivers

`src/hosts/arms.ts` launches Pi or OpenCode for one session and wraps the
daemon stack. The arm driver that runs a scenario's events and faults on them
lands next.

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

`DaemonStack` starts the daemon through the v1 `HermeticHostStack` with the
interposer environment, restarts it with SIGKILL against the same store, and
stops it with SIGTERM so its store stays on disk. It appends the daemon's
output to the arm's `daemon.log` before each restart and at stop; the v1
stack keeps the last 256 KiB of that output, so a longer stretch keeps its
tail.

`openSession` launches one host process in a workspace through the sandbox
launcher, and `closeSession` stops it. The sandbox runs the host under
root-owned `sudo` and `unshare`, so closing a host walks the launcher's
process tree and signals every process the user owns, with SIGKILL after
10 s; a process that survives SIGKILL stops the run. `prompt` sends one user turn with the turn deadline and returns the
host's error, if any. After a Pi turn fails, the host aborts it and waits up
to 30 s for its `agent_end`, so a late end cannot finish the next turn.
OpenCode turns race the deadline, abort the session (waiting at most 5 s for
the abort call), and wait 30 s for the call to drain; a call still running
then stops the run.

Pi runs in RPC mode with `--session-id sim-<session>`, its agent directory,
settings, and model list under the arm root, and the Eidnara extension from
the build clone on Eidnara arms. OpenCode runs through the v1 `spawnOpencode`,
with a wrapper script that launches the pinned binary through the sandbox
launcher, and titles each session `sim-<session>`. Both reach Bedrock only
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
