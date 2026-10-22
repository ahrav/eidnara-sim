# Evidence path

`bun scripts/evidence-run.ts <run dir>... [--out <dir>]` follows each graded
probe of each arm from its source to the agent's answer and names one cause
for every probe whose stages did not all hold. `src/evidence/` owns the
stages, the attribution, the session health rows, and the report section. The
script opens run artefacts for reading only. Without `--out` it writes
`evidence.jsonl`, `evidence-sessions.jsonl`, and (for one run) `evidence.md`
into the run directory; with `--out` it writes `<out>/<run name>/` per run and
`<out>/evidence.md`, so a run another process still owns is never written.

## Stages

A memory arm (one whose profile loads the Eidnara plugin) has six stages; a
host arm has `source`, `context`, and `application`. The oracle-context arm
(`host-oracle`) is a host arm whose probe turn carries the oracle note
(`docs/hosts.md`), so its `context` stage reads the note with the rest of the
request. Each stage carries a
status, a reason, and pointers (`path` and `at`: a call `seq`, a journal
`seq`, a `tools.jsonl` line, a store object id, a transcript `toolCallId`, or
a grade record).

| Stage | Holds when | Evidence |
|---|---|---|
| `source` | Every `ground_truth.sources` event has a journaled `Event` with outcome `ok` before the probe's `BeginTurn`; for a P12 item whose sources commit a check script, `tools.jsonl` shows a run of that script with a recorded exit in a source session's turns (the S3 grader's rule); an agent request of the probe's project between the first source and the probe carries every `present` group; on a memory arm, a `memory_capture`, `history_summarizer`, or `memory_classifier` request in that window carries it too, or a stored object does | `journal.jsonl`, `<arm>/tools.jsonl`, `calls.jsonl` + `requests.jsonl` |
| `persisted` | A kernel decision or proposition, a store note, or a user memory carries each group and was created before the probe began, on the daemon's clock; both databases must read, or the stage is `unobserved` | `<arm>/final-store/kernel.sqlite` (`object_registry`, `decisions`, `propositions`, `commit_log`), `store.db` (`notes`, `user_memories`) |
| `eligibility` | One such object per group is live at the probe (not invalidated, not superseded) and in the probe project's scope: the kernel `project:<key>` scope whose key the project's capture jobs carry, or a note whose project path ends in the project | the same stores, `memory_capture_jobs` |
| `retrieval` | An `eidnara_*` tool result new in the probe turn, or a block the plugin writes into the request (`<project-memory>`, `<memory-updates>`, `<project-note>`, `<eidnara-search-auto>`, `<eidnara-search-hint>`), carries each group; the detail gives each hit's source and line (its rank) and every search's input, route (`fused`, `legacy-scan` with the fallback reason, `errored`), and whether its result reached a request | Pi transcripts (what the tool returned), request bodies (what the model received) |
| `delivery` / `context` | A probe-turn agent request carries each group, with the probe's own text removed first | `calls.jsonl` + `requests.jsonl` |
| `application` | The latest grade passes (the S3 grade) | `grades.jsonl`, `<arm>/snapshots.jsonl` |

Daemon times are compared with the probe through the arm's journaled
`ClockOffset` entries: the daemon reads wall time plus the offset in effect.

Statuses: `ok`; `failed`, the evidence existed and this stage lost it;
`unavailable`, the evidence never existed for the agent (a source event not
delivered, a check script that never ran to an exit); `unobserved`, the
artefact that decides the stage is absent (a run recorded before the proxy
kept request bodies, a missing final store, a scenario without ground truth);
`excluded`, the grader set the item aside; `n/a`, the item names nothing for
the stage.

## Attribution

Each probe gets one `attributed` cause with a status and reason:

1. A control item (ground truth with no sources: `P1-control`, expect
   `baseline`) holds when its grade fails, since the grade passes only when
   the agent applied the rule. A control that applied the rule is attributed
   to `eligibility` (memory arm) or `context` (host arm) when the rule's
   literal reached the probe context, and to `application` otherwise.
2. A passing grade is attributed `none`.
3. A probe in a session flagged by context health at or before the probe
   turn is attributed `compaction-refused` or `context-overflow`, whatever its
   stages show.
4. A superseded literal in the probe context with the current one absent is
   attributed to `eligibility` (memory arm) or `context` (host arm).
5. A probe whose context carried every group is attributed to `application`.
6. Otherwise the first stage whose status is not `ok` or `n/a`.

## Context health

`evidence-sessions.jsonl` holds one row per arm session: compaction attempts
(`native_compaction` and `history_summarizer`), refused compactions (a 200
answer with `finish_reason` `content_filtered` or zero output tokens), failed
compactions, the peak agent prompt (input plus cache read and write tokens)
against the manifest's `context_limit`, calls over it, and prompt-too-long
refusals. The cause is `compaction-refused` when a refused compaction finished
(`wall_ms`) before the first over-window prompt or prompt-too-long refusal
was sent (`started_wall_ms`), since records are numbered as calls finish, and
`context-overflow` when such a prompt has no refused compaction before it; a
refused compaction followed by prompts inside the window flags nothing.
`flagged_from` is the turn of the mark that set the cause, or the session's
next turn for a mark recorded between turns. The rows measure only; the host
runs unchanged.

On an arm whose host compacts beside the Eidnara plugin, each forced p90
session's row reports whether it holds a `native_compaction` record
(SIM-P76), and the report states the count.

## Probe-time state

`probe_time` records the `BeginTurn` and `EndTurn` pointers, the turn outcome
and prompt time, the probe turn's agent calls, its tool runs with exits, its
searches, the jobs still open at `BeginTurn`, the capture jobs created and not
yet committed or abandoned at the probe (all and the probe project's), the
store objects that existed, the plugin's transform passes in the session, the
background calls credited to the turn (`origin_turn` or `turn`), and the
session's health cause.

## Report section

`evidence.md` holds the `## Evidence path` section: counts by arm and cause,
one row per probe with its stage statuses, cause, reason, and the pointers of
the attributed stage, the context-health rows, the SIM-P76 line, and an arm
comparison whose healthy rows leave out the turns, calls, and probes of
flagged sessions from `flagged_from` on, which get rows of their own.

## Historical runs

A run whose scenario carries no ground truth predates the current generator;
when the current grader refuses its grade log, the log is read line by line
for item, arm, verdict, and version, and nothing is regraded. A current run's
refused grade log refuses the evidence run. A run without `requests.jsonl`
reports `source`, `retrieval`, and `delivery` as `unobserved`, since the probe
turn's tool uses come from its request bodies.
