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
| `command-log` | Each command the agent ran, with its exit code and scenario time |
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
   it refuses a snapshot of another item or one snapshot on both sides
   (two runs of one arm, as in an A/A pair, are distinct snapshots),
   refuses a snapshot with a non-grade artefact, returns null when either
   probe turn ended `failed` (SIM-P46), reads each probe turn's last agent
   answer from the `proxy-call` artefact, refuses an answer that is empty
   after normalisation, and
   returns the snapshot ids, arm names, and the artefact ids it read as the
   grades' inputs.
2. `blind` takes a pair of answers to one P7 item, the memory arm's as `a`
   and the host arm's as `b`, and refuses either answer, or the reference
   reason, when it carries a
   canary or names an arm. Names are matched as whole words after folding
   case and separators, applying compatibility decomposition (NFKD, which
   also folds full-width, circled, and mathematical letters), and dropping
   invisible characters and
   every combining mark (eval-core drops the
   combining diacritics block only); an invisible character is tried both
   as nothing and as a word separator, so `eid\u200bnara` and `arm\u200ba`
   both match, the normalised text is checked as well as the raw text, so
   `Ei**dnara` matches, and canaries and one-word arm names are also
   matched with every separator removed, so `eid-nara` and `CAN-ARY-7f3`
   match. Blinding covers the forms an agent's answer takes when it
   mentions an arm through formatting, encoding, or spacing; it is a safety
   net under the structural guarantee that no arm is told its label, and
   adversarial obfuscation (entity references nested inside entity
   references, letters of a multi-word label split by punctuation, and
   confusable or mixed-script homoglyphs) is outside what it refuses. The
   arm names are eval-core's six plus `eidnara`, `host arm`, and
   `memory arm`. HTML comments and tags are dropped, the common and
   numeric entities decoded (an entity outside the code-point range is
   dropped, any other named entity becomes a space), markup the decoding
   exposed is dropped again, invisible characters are dropped, Markdown
   links and images, inline or reference-style, keep
   their label and lose their destination, identifier, and definition line, doubled or tripled emphasis marks (`**`, `***`, `__`, `___`), backticks, heading
   marks, bullet marks, and code fence lines (a line that starts with three
   backticks and holds no further backtick, whatever its info string) are
   stripped and whitespace
   collapsed before the judge sees either answer; backticks inside a line
   are removed and the text between them stays.
3. `judgePair` shows the pair in both orders, under the rubric and the
   item's reference reason, and reads one verdict per order: `first`,
   `second`, `both`, or `neither`. eval-core's verdicts are `first`,
   `second`, and `tie`; recall needs `both` and `neither` to tell two
   recalls apart from none. Unswapped verdicts that disagree make the pair
   `Inconsistent`, which grades as excluded with that reason and is never
   averaged. A reply that is not exactly one verdict word, with trailing
   `.` or `!` at most, refuses the call.
4. The judgment records each answer's length after normalisation, and
   `longer_recalled_alone` records whether the longer answer was the one
   recalled alone, for the verbosity audit.
5. `gradeP7` takes the judgment, the compiled P7 probe, and the two
   snapshots, rebuilds the pair from the snapshots (so the arms, snapshot
   ids, artefact inputs, answer digests, and lengths it records all come
   from the snapshots that produced the judged answers) and the reference
   digest from the probe's `check.judge`, and writes one grade per arm,
   each with its arm's later-attempt count, for the item, the exact
   answers, and the reference reason the judgment names (the judgment
   carries the answers' and the reference's digests), and only when the
   judgment's
   recall is the one its two order verdicts imply, each of which must be one
   of the four verdict words, and its answer lengths and
   `longer_recalled_alone` are the ones the pair and that recall imply. Each grade carries the judge model,
   the prompt and rubric digests, both order verdicts, both answer lengths
   and `longer_recalled_alone`, the calibration digest, and the permutation
   check's result and counts. It computes the digest and runs the check
   itself and records a refusal of either as `refused: <reason>`, so
   `gate_eligible` is true only when the judgment's judge identity, the
   calibration set's judge identity, and the permutation evidence's judge
   identity all equal the pre-registered judge's (`grading.judge.model`
   with the current prompt and rubric digests), the recall is consistent,
   the set validates, the permutation check passes, and a cross-judge record
   carries the pre-registered cross-judge's identity
   (`grading.judge.cross_judge`) and the set's digest (recorded as
   `cross_judge: valid`; absent evidence reads `none`).
6. `permutationCheck` refuses counts that are not safe whole numbers and arm
   identification above the pre-registered 60% ceiling, correct or inverted,
   compared in exact integer arithmetic.
7. `calibrationDigest` validates a calibration set: at least 20 pairs, and a
   human sample of at least 10% rounded up and never below 20 pairs. Only a
   set that passes gets a digest; a blank pair id, a human label naming no
   pair or naming one twice, a label other than `a`, `b`, `both`, or
   `neither`, labels that are not an object keyed by pair id, a human id
   that is not a string, and another
   schema are refused. The set holds the judge identity,
   a label per pair, and the ids of the human-labelled pairs under the sim's
   own schema literal, `sim-judge-calibration/v1`, which also prefixes the
   digest; eval-core's
   `CalibrationSet` (`eval-judge/v1`) holds human labels alone and takes the
   human floor from the campaign's `SamplingPlan`, which the sim does not
   have yet, and `docs/eval-core-mapping.md` names the fields `eval-judge/v2`
   would carry. The maintainer's 20 labelled anchor pairs
   do not exist yet, so P7 grades carry `calibration_digest: none` and stay
   out of gates.
8. `humanCheckSample` draws the 10% of P7 items, rounded up, to journal as
   `human_check_pending` (SIM-P44).

`proxyJudge` sends each verdict request through the capture proxy with the
`judge` component header, bounded by a per-call deadline (900 s by default)
covering the request and the body read, whose expiry is a judge refusal. A
reply whose `stopReason` is not `end_turn` (a truncated or filtered
generation) is a judge refusal before its text is read. It refuses a judge model from the agent model's
family (SIM-P43), where the family is the provider segment of the model id
(`provider.model` or `region.provider.model`), and a model id whose provider
it does not know; an unreachable gateway, a reply that is not JSON, one that
carries no text block, or one whose text blocks together are not one verdict
word is a judge refusal. The
pre-registered judge is `global.openai.gpt-5.6-luna`.
On 2026-10-16 the two P7 fixtures went through the gateway to that model,
and the real verdicts (`first`, then `second`, and the reverse) graded as
the fixtures record. The run's records (`judge-calls.jsonl` with the four
`judge` call records, `judgments.json` with the verdicts) are run data under
`runs/judge-smoke/` on the host that ran it; run data is never committed, so
this claim is checked against that host's records, and the fixtures' own
verdicts are scripted.

The judge identity is the model id with the prompt and rubric digests; the
prompt digest covers `PREPROCESSING_VERSION` (`sim-judge-preprocessing/v2`),
which changes whenever normalisation, folding, or the arm tokens change what
the judge sees, so judgments and calibration sets made under older
preprocessing stop matching;
eval-core's `JudgeIdentity` also names the provider and tokenizer profile,
and digests a rubric document under `eval-judge-rubric/v1` where the sim
digests the rubric text.

The pre-registered cross-judge (`grading.judge.cross_judge`, Haiku 5.5)
re-judges the calibration set, so it waits on the maintainer's anchor pairs
too. Its model shares the agent's family, which `proxyJudge` refuses for
judging arm answers; calibration judging will need its own entry point.
Until then `P7Context.cross_judge` is the record that entry point will
produce (its identity and the digest of the set it labelled), gate
eligibility requires it, and the agreement rule between the two judges'
labels is still to be pre-registered.

## Fixtures

`tests/fixtures/grade/` holds a known pass and a known fail for every
probe type (P7's as an answer pair with scripted judge verdicts), extra fixtures for each branch a grader can take,
and P1 control items (`tests/fixtures/grade/README.md` gives their
provenance). The P1 and P1 control items come from live runs; the others
are constructed from compiled checks, because those probe types have not
reached a live run yet.
