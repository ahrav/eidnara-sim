# Time injection, launcher, and preflight

## Launcher

`writeLauncher(runRoot)` writes `sandbox.sh` into the run root. The script
runs a command in private mount and PID namespaces through `sudo` and
`unshare`, mounts a private `/dev/shm`, masks `/tmp`, the home directory,
and the run root with tmpfs, binds the kept paths back in, and drops
privilege with `setpriv` (same UID and GID, no new privileges, no
capabilities). The staging tree for the kept paths and the interposer's
shared-memory objects live in the private `/dev/shm`, so they end with the
namespace on every exit path. `launch(launcher, keep, env,
command)` builds the argv: kept paths, then `--env` and `NAME=value` pairs,
then `--` and the command. `env` sets those variables after `setpriv`,
because the setuid `sudo` boundary strips `LD_PRELOAD`. Paths and values
must be plain words, since the script splits them on spaces, and kept paths
must be normalized absolute paths, since the script joins them onto the
staging directory. `probes` resolves each configured binary to its canonical
path, so the kept directory and the path the loader reports in its binding
lines match.

## Interposer

`buildFaketime()` downloads libfaketime 0.9.10, checks its sha256 against the
pinned digest, and builds `libfaketime.so.1` under `vendor/build/` (ignored by
git). `faketimeEnv(file)` preloads it with these settings:

| Variable | Value | Effect |
|---|---|---|
| `FAKETIME_TIMESTAMP_FILE` | the run's offset file | Every time call reads the offset from the file |
| `FAKETIME_NO_CACHE` | `1` | The offset applies on the next call after a write |
| `FAKETIME_DONT_FAKE_MONOTONIC` | `1` | Monotonic clocks stay real, so timers keep wall pace |

`writeOffset(file, baseMs, scenarioMs)` writes the whole-second offset that
puts a process clock at `baseMs + scenarioMs` now. The scheduler's `onClock`
hook receives each arm's starting time and every clock jump; the run command
that lands with the host drivers writes the offset from that hook. Between
jumps the offset holds, so host clocks run at wall pace while scenario time
holds and lead it by the idle wall time since the last jump; the preflight
distortions record this.

## Per-binary interception test

`preflight(config, runRoot)` builds the interposer, writes the launcher, and
runs each binary through the launcher with its clock 8 hours ahead. The run
command that lands with the host drivers calls it at `StartRun` and records
its result in the run manifest.



| Binary | Probe | Intercepted when |
|---|---|---|
| Pi (its Node runtime) | `node -e` prints `Date.now()` and a 100 ms timer | The clock is within 5 s of the jump and the timer fires in 90 ms to 1 s |
| OpenCode (Bun-compiled) | `BUN_BE_BUN=1 opencode -e` with the same script | As for Pi |
| Daemon | `LD_DEBUG=bindings eidnara-host build-profile` | The dynamic linker binds the daemon binary's own `clock_gettime` import to `libfaketime.so.1` |

The Pi probe runs Pi's Node runtime, not the Pi CLI, so it shows that the
runtime Pi runs on reads the interposed clock. A binary that fails is recorded
`wall_clock_only`, and the run proceeds with that limitation in its
distortions. If neither Pi nor the daemon is
intercepted, preflight throws (OQ-9 stop condition). On this host all three
intercept, which resolves OQ-9 for OpenCode 1.19.0.

The preflight result's `distortions` always records that monotonic clocks are
real, so in-process idle timers see wall time; that provider-side time, cache
warmth, and rate limits follow wall time; and that host clocks lead scenario
time between jumps (SIM-P19).

## Transcript-store table

`TRANSCRIPT_STORES` maps each host version to the paths where the host keeps
its own transcripts, so the control arm's reads of them can be attributed
(SIM-P35). Preflight reads each host's version (`pi --version`, `opencode
--version`) and refuses a version with no row. The check that each resolved
path exists after an arm's first session lands with the host drivers.

| Host | Versions | Paths |
|---|---|---|
| Pi | 0.80.x | `$PI_CODING_AGENT_DIR/sessions` |
| OpenCode | 1.19.x | `$XDG_DATA_HOME/opencode/opencode.db`, `$XDG_DATA_HOME/opencode/storage` |

## Resource sampler

`ResourceSampler` samples a process every interval (the pre-registered
`leak_bound.sample_interval_ms`). Each JSONL sample has wall and scenario
time, the PID, RSS, CPU time, the CPU fraction since the last sample, and the
store's bytes. When the daemon's CPU fraction exceeds the pre-registered
`liveness_bounds.daemon_busy_cpu_fraction` (0.05, added in pre-registration
revision 3), the sampler reports busy through `onBusy`; the run command
registers that as a background job that holds the clock until the fraction
drops (OQ-2). A sample after a daemon restart, with a new PID, reports no
fraction.
