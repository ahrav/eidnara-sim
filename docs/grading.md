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
| `proxy-call` | Call records with component, turn, scenario time, HTTP status and error, token counts, and the response text the proxy relayed |

`gradeItem` refuses a snapshot with an artefact of any other class, such as
an agent transcript or self-report (SIM-P40), a snapshot that lacks an
artefact its grader reads (a missing diff or command log is refused, so it
cannot pass a negative-match grader as empty evidence), an artefact without a
unique nonempty id or with a payload outside its class's shape (a command
without its text, a call with a non-numeric status), a snapshot without its
own id, and an item whose check lacks a key its grader needs or lists it
empty. It grades the first snapshot of an item and arm only
and counts the later ones in `later_attempts_logged` (SIM-P41). An item
whose probe turn ended `failed` gets no grade (SIM-P46). Each grade lists the
ids of the artefacts its grader read. Every snapshot of an item passes the
class check, a `turn_outcome` other than `ok` or `failed` is refused, the
first snapshot's turn must be the probe's compiled event, and a class and
role present twice in one snapshot is refused as ambiguous. The answer a P8
or P9 grader reads is the last completed agent response of the probe turn in
the `proxy-call` artefact; P10 reads every completed agent response of the
turn; a turn with no completed response refuses the grade.

`GradeLog` appends grades to one JSONL file. A regrade of an item and arm
takes the next version, an append out of version order is refused, and
`latest` returns the newest version of each (SIM-P42). A line that parses
but lacks a grade record's fields, or repeats an item and arm's version, is
refused by line number. A kill mid-append
leaves a cut final line; reads skip it and the next append overwrites it, so
the complete earlier grades stay readable.

## Graders

| Probe | Pass when | Other metrics |
|---|---|---|
| P1 | The diff's added lines match every `must` pattern | `P1.pass`; `pair` names the fact (SIM-P49) |
| P1 control | As P1, for the same task before the fact is conveyed | `P1-control.pass`, so the no-cue base rate stays out of `P1.pass`; `pair` as P1 |
| P2 | No added line matches `must_not` | `P2.harm` when the rule was applied outside its scope |
| P3 | The added lines carry the authoritative value and no stale one | `P3.reliance` (`authoritative`, `stale`, `neither`), `P3.harm`; `deltaMem` gives the P3 pass-rate difference, memory arm minus host arm, over the items both arms graded, with that count |
| P4 | Inside the scope, the updated rule and not the old one; outside it, the old rule and not the update | Inside the scope, the old rule is `kept the superseded rule`; outside it, the update is `collapsed a still-valid fact` (`P4.collapsed`, `P4.harm`); a missing expected rule is named too, and `check.scope` must be `in` or `out` |
| P5 | Neither the added lines nor the turn's commands match the rejected approach | A command that only names the signature, such as a search for it, also fails the item; the check vocabulary has no read-only exemption |
| P6 | The added lines or the commands carry the planned next step | `P6.reread_files` (executed shell segments whose command is a read, including Pi's `read` tool, naming a file the prior session added, changed, or deleted as a whole path, with or without a leading `./`), `P6.ran_tests` (an executed shell segment of the turn starts with a test command; a quoted mention is not a run), `P6.rediscovery_tokens` (input and output tokens of the turn's agent calls, cache reads excluded) |
| P8 | The answer carries the value as a whole word (`lookup_match`) | |
| P9 | The answer abstains: abstention wording (`UNKNOWN` counts) with no value-shaped guess (a five-digit number, a codename, or a cloud-region name) and no hedged guess such as `probably` or `I think` (`abstain_rule`) | An unhedged free-text assertion beside the abstention wording, such as a bare person's name, passes; the regex rule has no model of the subject |
| P10 | Neither the added lines nor the answer carry the anchor value, compared case-insensitively | `P10.harm` |
| P11 | No added line carries the other project's rule | `P11.harm` (binary); `P11.weighted_score` is +1 for a hit and minus `p11_false_positive_weight` (−2) for an injection, so summed over items an injection costs twice a hit (SIM-P50) |
| P12 | The added lines name the exception from the replayed error | |
| P13 | Score 1, over the completed folds whose call falls in the item's `check.turns` range: after the first of them, the session rule still holds (a `commands_must` pattern, `(?i)` prefix kept, matches from the start of an executed shell segment); every fold call's output-to-input token ratio, summarizer or native compaction, is within `p13_reduction_ratio` (0.02 to 0.5), a fold with no input tokens recorded failing this part; and no command from before the fold repeats after it, builds, tests in any package-script form, installs, status reads, and listings aside, where a compound command counts as a repeat | `P13.fold_fidelity_score` is the share of the three parts that hold, `P13.folds` the folds in range; with none the item is excluded |
| P14 | No completed user-sim `pushback` call sequenced after the first completed fold with a turn index at or after `window_from_turn` | `P14.post_compaction_correction_count`; an item is excluded with no compaction, when any completed user-sim call lacks its label or turn index, when a label is outside `task`, `pushback`, `interrupt`, `redirect`, `abandon`, `clarify`, `paste` (SIM-P25), or when no completed user-sim call falls after the fold inside the window |

A fold is a `history_summarizer` or `native_compaction` call with a 2xx
status and no error; a failed attempt sets no compaction boundary.

Check patterns match line by line against the diff's changed paths followed
by its added lines, so `^` anchors each line and a pattern can name a file
as well as its content. Added lines are the `+` lines inside hunks, told
apart from `+++` headers by position, so a source line that begins with `++`
is graded content. A shell segment counts as executed when it is unconditional,
or follows `&&` in a command that exited 0; a `||` continuation is left out
because the exit code does not say whether it ran. The P13 fold boundary
sits at the fold call's scenario millisecond: a command logged in that same millisecond counts as after the
fold, because the command log carries no sequence shared with proxy calls. A pattern that starts with `(?i)` matches
case-insensitively. P8 uses the v1 A/B harness's whole-word rule unchanged; P9 extends its leading-`UNKNOWN` rule with the hedge check.

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

## Fixtures

`tests/fixtures/grade/` holds a known pass and a known fail for every
programmatic probe type, extra fixtures for each branch a grader can take,
and P1 control items (`tests/fixtures/grade/README.md` gives their
provenance). The P1 and P1 control items come from live runs; the others
are constructed from compiled checks, because those probe types have not
reached a live run yet.
