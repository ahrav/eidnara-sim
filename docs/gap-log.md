# Gap log

Eidnara findings from live simulator runs. Each entry names the run, the
evidence, and what it does and does not establish. Harness defects are
fixed in the sim tree and recorded in the commit that fixes them.

## G1. OpenCode returns a prompt early on Eidnara arms

Runs: `tier-S/S-102-opencode` arm `eidnara~aa`, and `tier-S2/S-102-opencode`
arms `eidnara-kl` and `eidnara~aa`; session `s-0000`, turn `e-000001`.

In each case the prompt for `e-000001` returned while the session's last
assistant step had not finished (`finish: tool-calls`), so the agent had
not answered. The next user turn, `e-000002`, sent a conversation ending
on that assistant message; Bedrock refused it with HTTP 400 ("does not
support assistant message prefill"), F2 recorded it, and OpenCode then
resumed the earlier answer. The three occurrences are all on Eidnara
OpenCode arms; the same turn on the two runs' `host` and `host~aa` arms
answered normally, and no Pi arm shows it. That points at the OpenCode
plugin path, without isolating it. The driver now reports such a turn as
failed, so it counts against dependability.

## G2. Daemon anonymous memory does not return to its warmup level

Runs: the 12 Eidnara-arm soak series of `tier-S` (three daemon arms in
each of four runs).

Daemon `RssAnon` ends above its warmup level in 10 of 12 series (the
`heap` soak verdict `leak` with `returned: false`), while RSS returns in
all 12. Slopes run from 0 to 7.5 MB per session with R2 at most 0.23, and
the growth bound holds in 11 of 12. The series cover 7 to 9 sessions of a
capped prefix, so this is retention after warmup, not a measured leak;
M and L runs carry the longer series that settle it.

## G3. No durable memory forms in the S prefix

Runs: every Eidnara arm of `tier-S`.

Each arm ran 5 to 15 `memory_capture` calls, and every store ends with
0 notes, 0 user memories, and 0 memory candidates; history segments hold
0 to 3 rows. The facts the S prefixes plant are session rules ("for the
rest of this session"), which carry no durable memory, so this is
consistent with the design and leaves cross-session recall unmeasured at
S.

## G4. The daemon exits on a dispatch task that outlives route close

Runs: `tier-M/M-201-pi` arm `eidnara~aa`, `tier-M/M-202-pi` arm
`eidnara-kl`, and `tier-M/M-202-opencode` arm `eidnara~aa` (Eidnara
`bb866266c`).

In each, the daemon's last log line is
`Error: LifecycleFatal("dispatch task did not stop before route-gone")`,
written by the forced route close in `crates/host-runtime/src/dispatch.rs`
when a dispatch task neither finishes nor observes its abort within the
route-close budget. The pass logged just before took 41,050 ms, 27,968 ms,
and 63,313 ms of handler time, against tens to hundreds of milliseconds for
the passes around it, so a long in-flight pass held the route when the
host closed it. The daemon exited outside any scheduled outage, the
harness stopped each run there, and each run resumed from its journal with
a fresh daemon. All three are on M runs, on both hosts, during user turns
with long sessions; no S run and no host arm shows the line.

## G5. The fixture daemon serves memory search from the legacy scan

Runs: every `eidnara` arm of the 2026-10-18 `smr/full` and `smr/sched` Pi
runs (Eidnara `08de9051a`).

Each `eidnara_search` result in those arms' Pi transcripts opens with
`Memory: the fused search route is unavailable (disabled); results come
from the legacy snapshot scan.` The hermetic host stack starts
`direct_host_fixture`, which never sets the query route limits, links a
deterministic 8-dimension embedding engine, and has no memory reviewer;
production `eidnara-host serve` sets all three. The runs measure Eidnara's
fallback search, not its production hybrid search. The `eidnara` arm now
declares that route (`docs/hosts.md`), and a production-hybrid arm waits on
an Eidnara seam that lets the production daemon's model calls reach the
proxy.

## G6. The knowledge-layer arm ran another configuration

Runs: every `eidnara-kl` arm before the capability check, on both hosts.

The harness never wrote Eidnara's `compaction.enabled=false` for
`eidnara-kl`. On OpenCode the plugin logged `disabled due to conflicts:
OpenCode auto-compaction is enabled` at every session start (for example
`tier-S/S-101-opencode`), so the arm ran as a host arm; on Pi, Eidnara's
transform ran beside Pi's own compaction. Neither arm measured the
knowledge layer alone, and their results do not describe SIM-P76's arm.
