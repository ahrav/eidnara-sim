# Time injection, launcher, and preflight

## Launcher

`writeLauncher(runRoot)` writes `sandbox.sh` into the run root. The script
runs a command in private mount and PID namespaces through `sudo` and
`unshare`, mounts a private `/dev/shm`, masks `/tmp`, the home directory,
and the run root with tmpfs, binds the kept paths back in, and drops
privilege with `setpriv` (same UID and GID, no new privileges, no
capabilities). The staging tree for the kept paths and the interposer's
shared-memory objects live in the private `/dev/shm`, so they end with the
namespace on every exit path. The privileged part of the script runs with
`PATH=/usr/sbin:/usr/bin:/sbin:/bin` from `/`, so root's tools come from
system directories and the harness working directory stays hidden when it
lies inside a masked tree; the caller's `PATH` reaches the command through
`env` after the privilege drop, and the command starts in the directory
`launch` names (`/` by default; a host names its workspace, a kept path,
through `env --chdir`). `unshare`
runs with `--kill-child`, and the interception test wraps each launch in
GNU `timeout -s KILL`, which signals the launcher's whole process group;
`unshare --fork` ignores `TERM` while it waits and namespace PID 1 has no
`TERM` handler, so `KILL` to the group is what ends a hung probe.
`launch(launcher, keep, env,
command, readOnly)` builds the argv: kept paths, then `--ro` and the
read-only paths, then `--env` and `NAME=value` pairs, then `--` and the
command. Read-only paths are kept too and remounted read-only after the
rebind. `env` sets those variables after `setpriv`, because the setuid
`sudo` boundary strips `LD_PRELOAD`. Paths and values must be plain words,
since the script splits them on spaces, and kept paths must be normalized
absolute paths, since the script joins them onto the staging directory. A
read-only remount of a parent takes the kept paths below it with it, so
`launch` refuses a writable kept path under a read-only one. `probes` resolves each configured binary to its canonical
path, so the kept directory and the path the loader reports in its binding
lines match.

## Interposer

`buildFaketime()` downloads libfaketime 0.9.10, checks its sha256 against the
pinned digest, builds `libfaketimeMT.so.1`, the thread-safe build, in a
staging directory under `vendor/build/` (ignored by git), and renames the
finished library into place, so the published path holds only a complete
build. `faketimeEnv(file)` preloads it with these settings:

| Variable | Value | Effect |
|---|---|---|
| `FAKETIME_TIMESTAMP_FILE` | the run's offset file | Every time call reads the offset from the file |
| `FAKETIME_NO_CACHE` | `1` | The offset applies on the next call after a write |
| `FAKETIME_DONT_FAKE_MONOTONIC` | `1` | Monotonic clocks stay real, so timers keep wall pace |

`writeOffset(file, baseMs, scenarioMs)` writes the whole-second offset that
puts a process clock at `baseMs + scenarioMs` now. The scheduler's `onClock`
hook receives each arm's starting time and every clock jump; the run command
(`docs/run-command.md`) writes the offset from that hook and returns it, and
the scheduler journals it as `offset_s`, with the wall instants before and
after the rename as `offset_wall_ms` and `offset_settled_ms`, on a
`ClockOffset` entry at the arm's start or resume and after each jump. A jump's
`AdvanceClock` lands before the offset is written, so every time a process
can read is on record, and its `ClockOffset` follows the write, so an oracle
can map a process's log stamp back to wall time from the instant each offset
could first be read, placing a stamp from inside the rename through both
offsets. A kill between the two leaves the jump without its offset; the
resume writes the offset again and journals it before the arm continues.
Between
jumps the offset holds, so host clocks run at wall pace while scenario time
holds and lead it by the idle wall time since the last jump; the preflight
distortions record this.

## Eidnara's timed rules under the simulator's clocks

The daemon runs under the interposer above, so its wall clock (`SystemTime`,
the daemon's `now_ms`) is scenario time and its monotonic clock (`Instant`,
`tokio::time`) is real time. A rule of the product that reads the wall
clock therefore runs over a scenario's span, and a rule that reads the
monotonic clock runs over the run's real duration. The harness changes,
overrides, and shortens none of the product's constants, on any arm: every
arm's daemon starts with the interposer's four variables and the arm's
user-tier configuration, whose keys are the ones `eidnaraUserConfig` and
`fixtureDaemonConfig` list (`src/hosts/arms.ts`). The one product
configuration key among the rules below is
`memory.injection_budget_tokens`, the block budget, and no arm writes it
(nor the Memory Classifier's schedule under `memory_classifier`), so every
arm runs the default of 4,000 tokens. `src/hosts/arms.test.ts` pins the
set of configuration keys each arm writes and the variables the daemon
starts with.

`bun scripts/scenario-span.ts [--json] <scenario.json>...` reports how
scenario time lies in a compiled scenario: events, user turns, sessions,
the sessions per project, the span from the first event to the last in
days, the largest advance between two consecutive events and between a
session's end and the next session's start, the advances of at least 30 s,
60 s, 1 h, 24 h, and 7 days, and per project the span from its first
session to its last and its largest gap between two of its sessions, with
the gaps of 24 h and of 7 days or more. It reads the scenario file alone.
The scheduler advances an arm's clock by at most each of those steps, since
scenario time also runs at wall speed while a turn or a background job is
open (`docs/run.md`, Clock).

Scenario spans, from that report:

| Scenarios | Events | Sessions (per project) | Span, days | Largest advance between two events | Advances of 60 s or more | Advances of 24 h or more | Largest gap between two sessions of one project | Gaps of 24 h or more per project | Gaps of 7 days or more |
|---|---|---|---|---|---|---|---|---|---|
| Tier S, the S5 campaign's seeds 104, 107, 109 (diagnosed) and 614, 617 (held-out) | 557 to 1,182 | 50 (20 for a main project, 5 for its twin) or 25 | 3.05 to 3.24 | 9.3 to 13.4 h | 174 to 364 | 0 | 65.0 h | 0 to 2 | 0 |
| Tier M, the WM seeds 213 to 216 (diagnosed) and the WMH seeds 612, 616 (held-out) | 1,924 to 6,387 | 300 (120 for a main project, 30 for its twin) or 150 | 14.29 to 14.78 | 21.7 to 89.0 h | 560 to 1,475 | 0 to 4 | 156.6 h (6.5 days; seed 216, a twin project) | 0 to 4 | 0 |

The product's timed rules and limits at `eval/wM`, with the clock each
reads and what a span of each tier does to it:

| Rule | Constant | Clock | Over an S span (3 days) | Over an M span (14.8 days) | Binds at M |
|---|---|---|---|---|---|
| Review hold of a disputed or pending target | 7 days; at most 64 active holds per project, 256 per store | wall (scenario) | never lapses; a project with 64 disputes stops being reviewed for the rest of the run | a hold placed in the first 7.8 days lapses inside the run; the memory is reviewed again only on evidence newer than its last job's. A project that reaches 64 holds inside 7 scenario days gets no selection and no run until its oldest hold ends (`reviews of a project wait`, counted as `waits.hold_bound`) | yes: holds lapse; the 64-hold bound binds on any project with 64 disputes or contests in 7 days |
| Review job queue lifetime | 24 h | wall (scenario) | binds only for a job still queued at a jump of 24 h or more; the settle step drains at each session end and before each advance that brings the skipped time to 30 s | the same; an M scenario holds 0 to 4 advances of 24 h or more, and a project 0 to 4 gaps of 24 h or more. A job left queued by a drain that outlasted its step's 300 s wait, by the 60 s stage-1 cooldown, or by the hold bound expires at such a jump, and its evidence starts no later review | yes, for jobs left queued at those few jumps |
| Review run deadline and task lease | 120 s and 40 s | wall (scenario) | a clock advance while a run is in flight closes it (`run ended without settlement: fenced`); the settle step before advances keeps this near 0 | the same | only for a run still in flight at an advance |
| Review metadata quota | 2,047 jobs per project and 8,191 per store (64 MiB and 256 MiB at 32 KiB a job); a charge is released 91 days after enqueue | wall (scenario) | no release; S5 queued up to about 2,000 reviews per run over 2 to 4 projects on `eval/w9` | no release inside the run. A project that enqueues 2,047 reviews gets no further review for the rest of the run (`selection queues no new review for a project`, `projects_at_metadata_quota` above 0). Expired jobs count | can bind on the largest projects; reported per run (`reviewer.log.quota_refused`, `daemon_status.memory_reviewer.metadata_quota`) |
| Review walk | 4,096 claim descriptors a pass (about 2,048 memories over all projects of the store) | none (a count) | S stores stay near or under it | an M store holds more: a selection covers the store over several passes, and a later statement reaches an earlier one only when one walk examines both (`selection examines at most 4096 claim descriptors a pass ...`, counted as `waits.selection_resumed`) | yes |
| Jobs per selection pass | 8, the delivered block's rows first | none | bounds every pass | bounds every pass | bounds every pass |
| Worker idle interval; stage-1 failure cooldown | 30 s; 60 s | monotonic (real) | the settle step supplies the pass the idle interval would have given | the same | the cooldown, after a failed stage-1 request |
| Captured-source retention; contradiction-candidate rows; capture replay identities; use-outcome records | 30 days; candidate rows also capped at 4,096 per project | wall (scenario) | never | never (14.8 days is under 30); the 4,096-row candidate cap can bind on a project with that many rows | retention: no; row cap: possible |
| Settled review jobs retire | 91 days | wall (scenario) | never | never | no |
| Lifetime classes (`lasting`, `current_work`, `status`, `request`, `unsettled`) | no duration | none | a class never expires by time | the same | no clock |
| Work in progress (`<CURRENT_WORK>`) | no age rule; at most a quarter of the block budget, after the lasting rows | none | a row leaves when a user statement replaces it, a review disputes it, or the budget trims it | the same over 120 sessions: rows accumulate until the section's budget share trims the oldest | by the budget, with no clock |
| Block budget and trimming order | 4,000 tokens (`memory.injection_budget_tokens`); `NAMED_FILES` first, up to an eighth (8 rows at most); then lasting rows newest first; then `CURRENT_WORK` | none | reached on two projects of S2 on the base build | reached on long projects: the oldest lasting rows leave the block and stay on search | yes (a count of statements, with no clock) |
| `NAMED_FILES` rows | no age rule; 8 listed of 32 checked, ordered by the sessions that used the file, then the latest use | wall for the latest use | a file stays a candidate while it exists | the same | no clock |
| Capture pause after failures | 3 failures pause a source 6 h; 9 dispatches abandon it | wall (scenario) | the pause ends at the first session 6 scenario hours later, however little real time passed | the same | after provider refusals |
| Pi plugin's capture offer window | 48 h | the Pi process's clock (scenario time under the harness) | messages are captured before the clock moves (the open-jobs wait) | the same; a session never resumes after 48 h in a scenario | no |
| Source-capture revision lead | 1 h between a harness timestamp and the daemon's wall clock | both on scenario time | within the lead | within the lead | no |
| Read freshness of an explicit search | 60 s lag age of a consumer a search serves from | wall (scenario) | before `eval/wM` the reviewer's consumer counted, and a clock jump made a search answer `stale` | on `eval/wM` with the plain route no consumer counts; a search reads the canonical tip with the no-consumer note | no |
| Health watchdog (`LifecycleFatal("health callback deadline expired")`) | 30 s | monotonic (real) | a host-wide stall of 30 s ends the daemon | the same; the c8 tier M campaign lost 14 daemons to two host stalls | on host stalls |
| Block recomposition after idle | 5 min since the last response | wall (scenario) | a jump of 5 min or more recomposes the block at the next pass | the same | at most at session gaps |

The rules that bind at tier M and stay out of reach at tier S are therefore
the 7-day review hold, which lapses inside a 14.8-day span, the review
walk's 4,096 descriptors, which an M store exceeds, and the block budget on
a long project. The review-metadata quota can bind on a project that
enqueues 2,047 reviews, and the 24 h queue lifetime on a job still queued
at one of an M scenario's 0 to 4 advances of 24 h or more. Every one of
them reads the same constant on every arm and at every tier; a tier differs
only in the span and the store its scenario builds.

## Per-binary interception test

`preflight(config, runRoot)` builds the interposer, writes the launcher, and
runs each binary through the launcher with its clock 8 hours ahead. The run
command (`docs/run-command.md`) calls it on every invocation before the
scheduler journals its first entry, records the first result in the run
manifest, and refuses to resume when an interception result changes.



| Binary | Probe | Intercepted when |
|---|---|---|
| Pi (its Node runtime) | `node -e` prints `Date.now()` and a 100 ms timer | The clock is within 5 s of the jump and the timer fires in 90 ms to 1 s |
| OpenCode (Bun-compiled) | `BUN_BE_BUN=1 opencode -e` with the same script | As for Pi |
| Daemon | `LD_DEBUG=bindings direct_host_fixture --help` | The dynamic linker binds the daemon binary's own `clock_gettime` import to `libfaketimeMT.so.1` |

The Pi probe runs Pi's Node runtime, not the Pi CLI, so it shows that the
runtime Pi runs on reads the interposed clock. A probe is intercepted only
when it also exits normally under the interposer: exit 0, or for the daemon
fixture, which has no successful no-op invocation, its usage error (exit 1
with the usage line on stderr); a binary that fails, or outlives
the 30 s deadline, is recorded `wall_clock_only`, and the run proceeds with
that limitation in its distortions. If neither Pi nor the daemon is
intercepted, preflight throws (OQ-9 stop condition). On this host all three
intercept, which resolves OQ-9 for OpenCode 1.18.22 and 1.19.0.

The preflight result's `distortions` always records that monotonic clocks are
real, so in-process idle timers see wall time; that provider-side time, cache
warmth, and rate limits follow wall time; and that host clocks lead scenario
time between jumps (SIM-P19).

## Transcript-store table

`TRANSCRIPT_STORES` maps each host version to the paths where the host keeps
its own transcripts, so the control arm's reads of them can be attributed
(SIM-P35). Preflight reads each host's version (`pi --version`, `opencode
--version`) and refuses a version with no row. After an arm's first session
the driver checks that each resolved path exists (`docs/hosts.md`). The
first live OpenCode 1.18.22 run kept its sessions in `opencode.db` alone and
created no `storage` directory, so the check stopped that run until the row
named the database only.

| Host | Versions | Paths |
|---|---|---|
| Pi | 0.80.x | `$PI_CODING_AGENT_DIR/sessions` |
| OpenCode | 1.18.x, 1.19.x | `$XDG_DATA_HOME/opencode/opencode.db` |

## Resource sampler

`ResourceSampler` samples a process every interval (the pre-registered
`leak_bound.sample_interval_ms`). Each JSONL sample has wall and scenario
time, the PID, RSS, CPU time, the CPU fraction since the last sample, and the
store's bytes. When the daemon's CPU fraction exceeds the pre-registered
`liveness_bounds.daemon_busy_cpu_fraction` (0.05, added in pre-registration
revision 3), the sampler reports busy through `onBusy`; the run command
registers that as a background job that holds the clock until the fraction
drops (OQ-2). `start()` takes the baseline sample at once, so the first
fraction is available one interval later. A sample with no fraction (a new
PID after a daemon restart, an unreadable `/proc` entry, or the baseline)
reports `cpu_fraction: null` and keeps the previous busy state, so a busy
hold lasts until a same-PID interval measures idleness. RSS comes from
`VmRSS` in `/proc/<pid>/status` and CPU time from `/proc/<pid>/stat` ticks
divided by the host's `CLK_TCK`. `store_bytes` is `null` when the store
directory itself is unreadable.
