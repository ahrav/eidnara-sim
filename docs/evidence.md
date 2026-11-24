# Evidence path

`bun scripts/evidence-run.ts <run dir>... [--out <dir>]` follows each graded
probe of each arm from its source to the agent's answer and names one cause
for every probe whose stages did not all hold. `src/evidence/` owns the
stages, the attribution, the session health rows, and the report section. The
script opens run artefacts for reading only. Without `--out` it writes
`evidence.jsonl`, `evidence-sessions.jsonl`, `evidence-reviewer.json`, and
(for one run) `evidence.md` into the run directory; with `--out` it writes `<out>/<run name>/` per run and
`<out>/evidence.md`, so a run another process still owns is never written.
The request part log `requests.jsonl` is read on demand: one streaming pass
checks every line and keeps each part's offset, and a body is rebuilt from
its parts when a stage reads it, with the last 64 MiB of parsed parts cached.
The source stage searches each part's text in turn (the last 256 Mi
characters of part text cached), since `bodyText` joins lines and a
single-line literal never spans two parts; a literal holding a newline is
searched in the rebuilt body. Memory stays bounded by the part index and the
two caches, whatever the run's length.

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
| `fold` | P13 items only, before `application`: the grade found a fold in the item's range (else `unavailable`) and every fold's output-to-input token ratio is within `p13_reduction_ratio` (else `failed`), read from the grade's `P13.ratio_in_bounds`; a grade that records no ratio (a historical schema) leaves the stage `unobserved` | `grades.jsonl` |
| `application` | The latest grade passes (the S3 grade) | `grades.jsonl`, `<arm>/snapshots.jsonl` |

A stage finds a literal in text as the grade's evidence names it. A number
stands with no digit beside it. A quote-style or log-level word (`single`,
`double`, `trace`, `debug`, `info`, `warn`, `error`) counts only inside its
rule's wording, case-insensitively: `double quotes`, `double-quoted`, `the
info level`, `log at INFO`, `warn-level logs`; `single-shot`, `single
quota`, `traced`, or `an error` carries nothing. A retrieval hit's rank is
the first line that carries the literal, or, when the wording wraps, the
line where the match completes (found by bisection over line prefixes, so a
wrapped match ahead of a one-line repeat ranks first). Any other literal is a generated identifier
that the scenario uses as a stem (`OCHRE_IBIS_MAX`, `onYONDER_EGRET`), and
it matches case-sensitively anywhere, so `AMBER_DINGO` is absent from
`amber_dingo.ts`. A probe whose rule is to be applied (`expect` `apply` or
`resume`) but whose ground truth names no literal reports `delivery` or
`context` as `unobserved`, since nothing can show the rule reached it; any
other probe with no literal reports `n/a`.

### How each reader treats each mark of `<project-memory>`

A `<project-memory>` block holds statements and, from `eval/w9` on, text
that holds none. Two kinds of reader meet it, by one rule on every arm and
build.

The readers that count statements and marks read the whole body of the
block (`injectedBlocks`): the retrieval stage's list of injected blocks,
and the delivery counts of the capability check (`docs/hosts.md`). A
statement counts wherever it sits: in a category element, in
`<CURRENT_WORK>`, on a marked line, in a contest excerpt.

The readers that search for a literal read the block by its statements
(`statementText`; `statementContext` applies it to each block of a text and
leaves every other part of the text as it is). These are the readers of
the probe-turn context (the `retrieval` and `delivery` stages, and the
stale and forbidden values of the context) and the `source` stage's search
of the window's requests. A day or a minute is digits beside `-`, `:`, or
`T`, which the literal rule reads as a free-standing number, so `09:30Z`
would deliver the literal `30`.

| Part of the block | Product form | Literal readers | Counted as (capability check) |
|---|---|---|---|
| Named files | the element `<NAMED_FILES note="...">` with one row per file: `<path> (the agent used it in <n> earlier session(s), last on <day>; last changed <minute>)` | removed whole: a row is a path with a use count and times, and holds no statement | `delivery.named_file_blocks` |
| Closing sentence | the block's last line, `The lines above are a partial record of this project's sessions: ...` | removed where it is the block's last line | `delivery.closing_blocks` |
| Recorded minute | ` [YYYY-MM-DDTHH:MMZ]` at the end of a `User stated:` line | removed at a line's end; the statement before it is read as written | none of its own |
| Replacement mark | `<statement> (stated <day>; it replaces a value recorded <day> that the user had not stated)` | the clause is removed whole, so the line reads as its statement: the live statement of the user, which is neither a superseded value nor a contested one | `delivery.replaced_blocks` |
| Contested mark | `<statement> (stated <day>; contested <day> by <memory id>: "<excerpt>")`, written by capture or by the memory reviewer | the two days are removed; the statement, the contesting id, and the excerpt stay, so the statement can carry the superseded value and the excerpt the current one | `delivery.contested_blocks` |
| Statement in a category element or in `<CURRENT_WORK>` | `<memory id>: <text>` | read as written | `delivery.work_blocks` for the element |

A day reads `YYYY-MM-DD` or `unknown date`. A body that holds none of these
parts comes back as the same string. The contested mark exists from
`eval/w2` on, so a block of an earlier build with a contested line loses
that line's two days for the literal readers and keeps every other byte.

On an arm whose profile consents to source capture, the memory arm's
`source` stage detail records `source_descriptors`: the Kernel source
descriptors live at the probe and those published from the first source
event to the probe (from a user-turn source's `BeginTurn`, since capture can
publish while the turn runs, or a commit's `Event`), by class, read from
`final-store/kernel.sqlite`; a descriptor whose creation or retirement commit
the log lacks, or a creation or retirement on a boundary's own millisecond,
leaves the counts null. Every
memory arm's probe-time state carries the same counts (null when the Kernel
store is unreadable). The counts describe capture; the stage status and
the attribution do not read them.

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

1. A passing grade is attributed `none`.
2. A probe in a session flagged by context health at or before the probe
   turn is attributed `compaction-refused` or `context-overflow`, whatever its
   stages show.
3. A superseded literal in the probe context with the current one absent is
   attributed to `eligibility` (memory arm) or `context` (host arm).
4. A P13 probe whose `fold` stage failed is attributed to `fold`: the fold
   ratio belongs to the summarizer or the native compaction, not to the
   agent's work.
5. A probe whose context carried every group is attributed to `application`.
6. Otherwise the first stage whose status is not `ok` or `n/a`.

A probe excluded with reason `no completed agent response` is the
grader's (`application`, `excluded`) whatever its other stages hold.
Another excluded probe names the stage whose evidence never existed, such as a
P12 check that never ran or a P13 item with no fold in its range (`fold`,
`unavailable`, which the grader's own reason takes ahead of an earlier
unavailable stage); any other exclusion is the grader's (`application`,
`excluded`).

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

Each row also counts the session's answers that carry an Eidnara marker:
the `§<n>§` block tag the transform prefixes to every text block it tags,
or the opening or closing tag of a block Eidnara injects (`project-memory`,
`session-history`, `session-history-since`, `eidnara-search-hint`,
`eidnara-search-auto`, `packed-context`, `project-note`, `memory-updates`, `new-notes`,
`covered-system-messages`, `project-docs`, `new-history_segments`), as
`EIDNARA_MARKER` in `src/evidence/health.ts` matches them. A turn's answer is its final text, counted two ways:

- `answers_streamed` and `marker_answers_streamed`: the turn's last
  completed agent call (status 200, no error, stream not cut), as the proxy
  relayed the provider stream (`calls.jsonl` `response_text`, its first
  262,144 characters); a turn whose last completed call has no text has no
  answer, and a session whose final completed call of a turn carries no
  whole recorded text (no `response_text`, as a run from before the proxy
  kept it records, or a prefix the proxy cut at its cap) has both streamed
  counts `null`. Graders read their answers the same way, the user simulator
  receives its replies from this stream, and a live UI may show it while
  streaming.
- `answers_persisted` and `marker_answers_persisted`: the text of the turn's
  last assistant message in the host transcript, what the user keeps; a
  turn whose last assistant message has no text has no answer, as on the
  streamed side.
  On Pi it comes from `<arm>/r/home/.pi/agent/sessions/**/<time>_sim-<session>.jsonl`
  (`readPiAnswers`), where a user message opens a turn and a complete last
  record without its newline is read too; a link on the path from the arm
  directory down reads as no transcript, and a session with a complete user
  or assistant record that does not parse reads as unread. On a host whose transcript this
  harness does not read (OpenCode), or for a declared session with no
  transcript file, both are `null`, and so is the arm's total in the report;
  a session the scenario does not declare (a second client's `-b` session)
  counts 0 on both sides.

The Pi plugin rewrites a leading tag out of the message it persists at
`message_end`, so the two counts differ on an Eidnara arm; a turn a stop cut
can also leave a streamed answer the transcript lacks. In the c7 final
runs the Eidnara arms streamed a marker in 3.4% to 7.2% of answers and
persisted none.

`content_filtered_calls` counts the session's calls (every component but
the user simulator's and the judge's) that the provider ended with
`finish_reason` `content_filtered`, and `content_filtered_turns` the turns
of agent calls so ended, so comparisons can set those turns apart.

## Probe-time state

`probe_time` records the `BeginTurn` and `EndTurn` pointers, the turn outcome
and prompt time, the probe turn's agent calls, its tool runs with exits, its
searches, the jobs still open at `BeginTurn`, the capture jobs created and not
yet committed or abandoned at the probe (all and the probe project's), the
store objects that existed, the source descriptors (above), the plugin's
transform passes in the session, the
background calls credited to the turn (`origin_turn` or `turn`), and the
session's health cause.

## Report section

`evidence.md` holds the `## Evidence path` section: counts by arm and cause,
one row per probe with its stage statuses, cause, reason, and the pointers of
the attributed stage, the context-health rows, the SIM-P76 line, a per-arm
table of answers with an Eidnara marker (streamed and persisted, each with its
share) and of `content_filtered` calls and turns, and an arm comparison whose healthy rows leave out the turns, calls, and probes of
flagged sessions from `flagged_from` on, which get rows of their own.
The `### Search route answers` table has one row per run and arm that
declares the fused route and whose capability record holds a search
observation (a Pi arm), read from the arm's `capabilities.json`: the
answered `eidnara_search` results, the ones the fused route ranked, the
degraded answers with their transient reasons and their share of the
answered results, the bound the run registered (`search_fallback`,
`docs/hosts.md`), the persistent fallback reasons, and the errored
results. A record written before the bound existed gives the same counts
from its `observed.search`.

The `### Memory reviewer` table has one row per run and arm that loads the
Eidnara plugin, sets the reviewer switch, or shows a sign of the reviewer,
read from the arm's artefacts by one rule (`reviewerEvidence`), so a run
without a capability record has its row too:

- the arm's switch, from the profile the manifest records;
- the reviewer's lines in `<arm>/daemon.log` over every daemon generation
  (`docs/hosts.md`, `reviewer.log`): review jobs enqueued by trigger,
  selection passes, stage-1 decisions by decider with the models named,
  failed stage-1 requests, reviews ended on a later reference the model was
  not shown, proposals applied by kind, proposals left for a reader and
  left unapplied, and the lines that report reviews waiting;
- the settle steps of `<arm>/review-drain.jsonl`: steps, runs settled, wall
  time in all and the longest, and steps with an error;
- the gateway's calls of `memory_reviewer_stage1` and
  `memory_reviewer_stage2` in `calls.jsonl`;
- the reviewer's activation state in the daemon status readings of
  `<arm>/resources.jsonl`: the readings that report `open`, and the last
  state;
- the final store's failed-command records and disputed objects, live and
  retired, or `unread` without a readable Kernel store.

`evidence-reviewer.json` holds the same record per arm (`schema`
`sim-evidence-reviewer/v1`, `arms`). An arm with the switch off shows no
review; a disputed object there comes from the agent's own `eidnara_memory`
dispute action.

An arm of the manifest's order is a directory of the run: a plain name, or an
A/A control label `<arm>~<tag>` that the run's tier registers as an
`[arm, arm]` pair in `aa_controls` (under a qualification, a pair its
`aa_controls` registers for the run's seed), right after its arm; a
qualification run's order must also be one its registration admits for the
run's seed (`admittedArms`), hold-out seeds included; a control label in a
manifest without a known tier is refused.

## Historical runs

A run whose scenario carries no ground truth predates the current generator;
when the current grader refuses its grade log, the log is read line by line
for item, arm, verdict, and version, and nothing is regraded. A current run's
refused grade log refuses the evidence run. A run without `requests.jsonl`
reports `source`, `retrieval`, and `delivery` as `unobserved`, since the probe
turn's tool uses come from its request bodies.
