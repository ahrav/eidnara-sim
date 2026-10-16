# Probe grading

`src/grade/` grades a probe item from the artefacts its turn produced. A
grader is a pure function of the compiled probe, the snapshot, and the
pre-registered `grading` rules (revision 4); it starts no process and reads
no file.

## Artefacts

A snapshot holds the artefacts the harness captured at a probe turn's first
`EndTurn`. Five classes are grade inputs:

| Class | Contents |
|---|---|
| `diff` | A unified diff: `turn` for the probe turn, `prior-session` for the project's previous session |
| `command-log` | Each command the agent ran, with its exit code and scenario time: `turn` for the probe turn, `session` for every turn of its session so far |
| `test-result` | A test command, its exit code, and its summary lines |
| `workspace-state` | Selected workspace files by path |
| `proxy-call` | Call records with component, turn, scenario time, token counts, and the response text the proxy relayed |

`gradeItem` refuses a snapshot with an artefact of any other class, such as
an agent transcript or self-report (SIM-P40), and an item whose check lacks
a key its grader needs. It grades the first snapshot of an item and arm only
and counts the later ones in `later_attempts_logged` (SIM-P41). An item
whose probe turn ended `failed` gets no grade (SIM-P46). Each grade lists the
ids of the artefacts its grader read. The answer a P8, P9, or P10 grader
reads is the last agent response of the probe turn in the `proxy-call`
artefact.

`GradeLog` appends grades to one JSONL file. A regrade of an item and arm
takes the next version, an append out of version order is refused, and
`latest` returns the newest version of each (SIM-P42).

## Capture

The arm driver captures a snapshot at every probe turn
(`src/hosts/snapshot.ts`), and the scheduler journals `SnapshotArtefacts`
with the item and snapshot id once per item and arm, right after the turn's
first `EndTurn` (SIM-P41). Snapshots append to `<arm>/snapshots.jsonl`; a
snapshot id is `<arm>:<item>:<turn event>`, so each attempt has its own id.

| Artefact | Source |
|---|---|
| `diff` (`turn`) | A git tree of the workspace, untracked files included, written to a separate index before the prompt and after it, and diffed |
| `diff` (`prior-session`) | The same trees at the start and end of the project's previous session |
| `command-log` | The host's tool runs, each a bash command or the tool name and its path, with a 0 or 1 error flag (null for a run that never finished) and the scenario time it started. Pi reports `tool_execution_start` and `tool_execution_end` events; OpenCode's tool parts come from the session messages the turn added, each timed from its start relative to the turn's first new message, both in OpenCode's own clock |
| `proxy-call` | The session's call records from `calls.jsonl`, each with the index of the user turn it belongs to (a background call takes the preceding turn's), and the response text the proxy records for agent, user-sim, and judge calls (the first 32,768 characters) |

The recorder keeps each project's session-start tree, the last session's
tree pair, and the open session's commands in `<arm>/snapshot-state.json`,
so a resumed arm reopens its session with the same start tree and commands.
The harness captures no `test-result` or `workspace-state` artefact yet;
the graders read neither.

`scripts/grade-run.ts <run dir>` grades every snapshot the journal names
into `grades.jsonl` and judges each P7 item for each memory arm against the
host arm, through a gateway it starts for the judge. It prints the verdict
counts per arm and probe type, the skipped items by reason, the summed
`P11.weighted_score` per arm, Δmem per memory arm, and the judge errors,
and exits 1 when a judge call failed. The scenario plants no canary
strings, so it passes the judge none; blinding still refuses arm names. P14 items have no probe turn of their
own and wait on the user simulator's labels (M6), so it lists them as
skipped.

## Graders

| Probe | Pass when | Other metrics |
|---|---|---|
| P1 | The diff's added lines match every `must` pattern | `P1.pass`; `pair` names the fact (SIM-P49) |
| P1 control | As P1, for the same task before the fact is conveyed | `P1-control.pass`, so the no-cue base rate stays out of `P1.pass`; `pair` as P1 |
| P2 | No added line matches `must_not` | `P2.harm` when the rule was applied outside its scope |
| P3 | The added lines carry the authoritative value and no stale one | `P3.reliance` (`authoritative`, `stale`, `neither`), `P3.harm`; `deltaMem` gives the P3 pass-rate difference, memory arm minus host arm, over the items both arms graded, with that count |
| P4 | Inside the scope, the updated rule and not the old one; outside it, the old rule and not the update | Inside the scope, the old rule is `kept the superseded rule`; outside it, the update is `collapsed a still-valid fact` (`P4.collapsed`, `P4.harm`) |
| P5 | Neither the added lines nor the turn's commands match the rejected approach | |
| P6 | The added lines or the commands carry the planned next step | `P6.reread_files` (read commands, including Pi's `read` tool, naming files the prior session changed), `P6.ran_tests` (the turn ran a test command), `P6.rediscovery_tokens` (input and output tokens of the turn's agent calls, cache reads excluded) |
| P8 | The answer carries the value as a whole word (`lookup_match`) | |
| P9 | The answer abstains: a first line of `UNKNOWN` alone, or abstention wording with no value-shaped guess (`abstain_rule`) | |
| P10 | Neither the added lines nor the answer carry the anchor value | `P10.harm` |
| P11 | No added line carries the other project's rule | `P11.harm` (binary); `P11.weighted_score` is +1 for a hit and minus `p11_false_positive_weight` (−2) for an injection, so summed over items an injection costs twice a hit (SIM-P50) |
| P12 | The added lines name the exception from the replayed error | |
| P13 | Score 1, over the folds whose call falls in the item's `check.turns` range: after the first of them, the session rule still holds; every fold call's output-to-input token ratio, summarizer or native compaction, is within `p13_reduction_ratio` (0.02 to 0.5); and no command from before the fold repeats after it, builds, tests, status reads, and listings aside | `P13.fold_fidelity_score` is the share of the three parts that hold, `P13.folds` the folds in range; with none the item is excluded |
| P14 | No user-sim `pushback` label at or after `window_from_turn` once the session compacted | `P14.post_compaction_correction_count`; an item is excluded with no compaction or when any user-sim call lacks its label or turn index |

Check patterns match line by line, so `^` anchors each added line. A pattern
that starts with `(?i)` matches case-insensitively. P8 and P9 use the v1 A/B
harness's answer rules unchanged.

The pre-registered P8 and P9 families name `P8.cross_session_pass_rate` and
`P9.cross_session_pass_rate`. The compiler places every P8 and P9 item in a
session after the one that conveyed its fact, so the family rate is the
mean of `P8.pass` and `P9.pass` over graded items.

These parts of the ticket's grader list are narrower here. P1 checks the
diff alone; the lint and test checks need the `test-result` artefact, which
the harness does not capture yet. P13 has no verbatim-dependent-edit part,
and it grades one record per item from the first fold in range and counts
the rest in `P13.folds`, while SIM-P47 asks for one record per fold. Δmem
is a point estimate with its item count; its interval comes with the paired
statistics (M7). A P13 item needs `must` or `commands_must` besides its
range.

## P7 judge path

P7 is the one judge-graded probe. `src/grade/judge.ts` re-implements the
eval-core judge contract (`crates/eval-core/src/judge.rs`), which TypeScript
cannot call, and the divergences are listed below.

1. `p7Pair` builds the pair from the two arms' snapshots of one P7 item:
   it refuses a snapshot with a non-grade artefact, reads each probe turn's
   last agent answer from the `proxy-call` artefact, refuses an empty
   answer, and returns the ids it read as the grades' inputs.
2. `blind` takes a pair of answers to one P7 item, the memory arm's as `a`
   and the host arm's as `b`, and refuses either answer when it carries a
   canary or names an arm. Names are matched as whole words after folding
   case, full width, and separators and dropping invisible characters and
   every combining mark after canonical decomposition (eval-core drops the
   combining diacritics block only). The
   arm names are eval-core's six plus `eidnara`, `host arm`, and
   `memory arm`. Doubled emphasis marks (`**`, `__`), backticks, heading
   marks, bullet marks, and code fence lines are stripped and whitespace
   collapsed before the judge sees either answer.
3. `judgePair` shows the pair in both orders, under the rubric and the
   item's reference reason, and reads one verdict per order: `first`,
   `second`, `both`, or `neither`. eval-core's verdicts are `first`,
   `second`, and `tie`; recall needs `both` and `neither` to tell two
   recalls apart from none. Unswapped verdicts that disagree make the pair
   `Inconsistent`, which grades as excluded with that reason and is never
   averaged. A reply that is not exactly one verdict word refuses the call.
4. The judgment records each answer's length after normalisation, and
   `longer_recalled_alone` records whether the longer answer was the one
   recalled alone, for the verbosity audit.
5. `gradeP7` writes one grade per arm. Each grade carries the judge model,
   the prompt and rubric digests, both order verdicts, both answer lengths
   and `longer_recalled_alone`, the calibration digest, and the permutation
   check's result and counts. It computes the digest and runs the check
   itself and records a refusal of either as `refused: <reason>`, so
   `gate_eligible` is true only for a calibration set that validates and a
   permutation check that passes.
6. `permutationCheck` refuses arm identification above the pre-registered
   60% ceiling, correct or inverted.
7. `calibrationDigest` validates a calibration set: at least 20 pairs, and a
   human sample of at least 10% rounded up and never below 20 pairs. Only a
   set that passes gets a digest; a blank pair id, a human label naming no
   pair or naming one twice, a label other than `a`, `b`, `both`, or
   `neither`, and another schema are refused. The set holds the judge identity,
   a label per pair, and the ids of the human-labelled pairs; eval-core's
   `CalibrationSet` holds human labels alone and takes the human floor from
   the campaign's `SamplingPlan`, which the sim does not have yet. The maintainer's 20 labelled anchor pairs
   do not exist yet, so P7 grades carry `calibration_digest: none` and stay
   out of gates.
8. `humanCheckSample` draws the 10% of P7 items, rounded up, to journal as
   `human_check_pending` (SIM-P44).

`proxyJudge` sends each verdict request through the capture proxy with the
`judge` component header. It refuses a judge model from the agent model's
family (SIM-P43); the pre-registered judge is `global.openai.gpt-5.6-luna`.
On 2026-10-16 the two P7 fixtures went through the gateway to that model
(`sim-runs/judge-smoke/judge-calls.jsonl` holds the four `judge` call
records and `judgments.json` the verdicts), and the real verdicts (`first`,
then `second`, and the reverse) graded as the fixtures record.

The judge identity is the model id with the prompt and rubric digests;
eval-core's `JudgeIdentity` also names the provider and tokenizer profile,
and digests a rubric document under `eval-judge-rubric/v1` where the sim
digests the rubric text.

The pre-registered cross-judge (`grading.judge.cross_judge`, Haiku 5.5)
re-judges the calibration set, so it waits on the maintainer's anchor pairs
too. Its model shares the agent's family, which `proxyJudge` refuses for
judging arm answers; calibration judging will need its own entry point.

## Fixtures

`tests/fixtures/grade/` holds a known pass and a known fail for every
probe type (P7's as an answer pair with scripted judge verdicts), extra fixtures for each branch a grader can take,
and P1 control items (`tests/fixtures/grade/README.md` gives their
provenance). The P1 and P1 control items come from live runs; the others
are constructed from compiled checks, because those probe types have not
reached a live run yet.
