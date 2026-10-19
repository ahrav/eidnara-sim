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
| `proxy-call` | Call records with arm, session, component, turn, scenario time, HTTP status and error, input, output, cache-read, and cache-write token counts, and the response text the proxy relayed. A call whose relayed text ran past the proxy's 262,144-character cap carries `response_text_truncated` (the proxy keeps only that prefix while it consumes the stream), and a grader that reads that answer refuses the item; a final completed agent call with no response text refuses the item's answer the same way |

`gradeItem` refuses a snapshot with an artefact of any other class, such as
an agent transcript or self-report (SIM-P40), a snapshot that lacks an
artefact its grader reads (a missing diff or command log is refused, so it
cannot pass a negative-match grader as empty evidence: the turn diff for the
diff graders and for a P13 item whose check names a diff channel, the turn
command log for P5 and P6, the prior-session diff for P6, whose item opens a
later session of its project, the `proxy-call` artefact for P6 to P10, P13,
and P14, and the session command log for P13), an artefact without a
unique nonempty id or with a payload outside its class's shape (a non-empty
patch that is not a well-formed unified diff with complete, paired file headers ahead of each file's hunks, at least one hunk per text file, hunks whose line counts match their headers, change at least one line, advance through the file in order, and whose every line carries its ` `, `+`, or `-` prefix, a `diff --git` label whose paths are quoted, equal, named by the file's rename, copy, or `---`/`+++` lines, or whitespace-separated, in that order (so a path with spaces is read from the equal halves or the metadata), each metadata line carrying its payload grammar (octal modes, hex index pair, percentage similarity, non-empty rename and copy names), and metadata-only files that form a complete operation (a mode pair, a rename or copy pair, an empty-file creation or deletion with its index line, a `Binary files <old> and <new> differ` note naming the label's files or `/dev/null`, or a Git binary patch with its two closed `literal`/`delta` blocks), a command or test result without its text or with a
fractional exit status, a call with a non-integer
status, a component outside the proxy's set, a negative token count or
scenario time, a sequence number that fails to increase, or an arm or session
other than the snapshot's, a workspace state whose files are not a map), two artefacts of one class and role, a snapshot listed twice, a snapshot without its own id or from another session than
the probe's, and an item whose check lacks a key its grader needs, holds a
malformed value, or carries an unknown key (a pattern that is empty after its `(?i)` prefix or fails to compile, an
empty answer, a window or turn range that is not a non-negative integer or
whose range fails to increase). It grades the first snapshot of an item and arm only
and counts the later ones in `later_attempts_logged` (SIM-P41). An item
whose probe turn ended `failed` gets no grade (SIM-P46). Each grade lists the
ids of the artefacts its grader read. Every snapshot of an item passes the
class check, every snapshot's turn and session must be the probe's compiled
event and session before the first one's outcome is read, a `turn_outcome`
other than `ok` or `failed` is refused, and a class and
role present twice in one snapshot is refused as ambiguous. The answer a P8, P9, or P10 grader reads is the last completed agent response
of the probe turn in the `proxy-call` artefact; a turn whose final completed call has no response text, or with no
completed response, refuses the grade.

`GradeLog` appends grades to one JSONL file under an exclusive `<path>.lock` file held across the read, version check, truncation, and write (a lock still held after two seconds is refused by name, so a dead writer's lock is an operator's to remove), validating each record's shape (exactly its type's registered metrics, each of its shape, in agreement with the verdict: harm equals failure for P2, P10, and P11, P11's weight is 1 on a pass and negative on a fail, P3's reliance and harm agree, P4's harm equals its collapse, P13's score is the mean of its three parts) before writing it, in full, through a no-follow descriptor to a regular, single-link file; reads open the file the same way, so a linked path is refused before any byte is read. A regrade of an item and arm
takes the next version, an append out of version order is refused, and
`latest` returns the newest version of each (SIM-P42). A P7 grade's key
also holds `against`, the arm it was judged against, so each pairing keeps
its own versions. A line that parses
but lacks a grade record's fields (non-empty item, arm, and snapshot ids, a known probe type, metrics of
boolean, string, or finite number values whose primary metric agrees with
the verdict unless excluded: `<type>.pass`, the P13 fold score, or the P14
correction count, a non-negative attempt count, at least one distinct
input id, a `pair` on P1 and P1-control records, an `against` arm on P7 records, and, on a graded P7 record, the judge's identity, calibration, permutation, cross-judge, order-verdict, and answer-length fields), or whose version is other than the
successor of the item, arm, and opponent's previous one, or that changes the snapshot,
probe type, pair, or opponent of an earlier version, is refused by line number. A kill mid-append
leaves a cut final line; reads skip it and the next append overwrites it, so
the complete earlier grades stay readable. An append holds `grades.jsonl.lock`, created
exclusively, while it reads, validates, and writes, so concurrent graders take
versions one at a time, and a log path that is a link or not a regular file is
refused when the log is opened.

## Capture

The arm driver captures a snapshot at every probe turn
(`src/hosts/snapshot.ts`), and the scheduler journals `SnapshotArtefacts`
with the item and snapshot id once per item and arm, right after the turn's
first `EndTurn` (SIM-P41). The `EndTurn` entry names the snapshot too, so a
resume after a kill between the two entries journals the snapshot from it.
Snapshots append to `<arm>/snapshots.jsonl`, and a recorder rebuilt after a
kill drops a cut last line, found by scanning the file's tail in chunks (the
run's call-record writer reopens `calls.jsonl` the same way, reading only the
tail); a
snapshot id is `<arm>:<item>:<turn event>`, so each attempt has its own id,
and each snapshot names its session, which the P7 grader checks against the
probe's.
The driver takes the snapshot after the scheduler's background jobs (a
summarizer or compaction call the turn started) have ended, so the
`proxy-call` artefact holds those calls. Each recorder git run against a
workspace is bounded by the turn deadline; a run past it fails the probe turn
with `snapshot: git ... timed out` and the item has no snapshot; a run past the
bound at a session boundary leaves that session without a start or end tree;
the session's end also checks the workspace's rule files against the reset
baseline, as a probe turn does, and a changed rule leaves no end tree. Either
way the next session's snapshots carry a `prior-session` diff artefact with an
empty patch and a `refused` reason, and a P6 item reading it is skipped as
`evidence refused`. The recorder refuses a
restored state whose tree ids are not 40-hex object ids before any git run.
The recorder removes the index lock a killed git leaves after a timeout; a recorder rebuilt after a
kill that finds a workspace index lock moves that workspace to a fresh,
numbered index file and leaves the lock and its index to the orphaned git
child that may still hold them.
The nested-repository check and the recorder's workspace path check run
before any walk of the workspace, and the walk itself stops at the bound or
at 200,000 entries, failing the probe turn. A `git diff` past the 256 MiB
output cap fails the probe turn the same way. A probe turn that adds,
changes, or removes a `.gitignore` or `.gitattributes`, or edits
`.git/info/exclude` or `.git/info/attributes`, ends `failed` with
`rule files changed: <paths>`: a rule added in the turn would hide that turn's
files from the diff, and an attribute (`ident`, `eol`, a clean driver) would
rewrite the content git indexes. The baseline is the source's `.gitignore` and
`.gitattributes` blobs and the clone's `exclude` and `attributes` files,
recorded at reset. The probe turn's rule check runs before the workspace is
indexed, and a turn with changed rules keeps its start tree as its end tree;
a `git add` that fails under changed rule files (an attribute that names an
encoding git lacks) fails the turn the same way, at the turn's start or the
session's end too. The rule files are found by name in the workspace walk and
hashed from disk, so a rule that ignores its own file still surfaces it; a rule
path that is a symlink, FIFO, or directory, or larger than 1 MiB, reads as a
changed rule, a workspace with more than 1,000 rule files fails the probe
turn during the walk, and hashing them runs under the recorder bound. A
workspace with more than 1,000 nested repositories fails the probe turn
before git runs. Each probe snapshot reads its session's call records by position from an
index the proxy's writer keeps (seeded once from `calls.jsonl` on resume), so
capture cost grows with the session, not the run; the run's writer keeps no
record in memory once it is on disk. The workspace walk reads
each directory one entry at a time, so its entry cap and deadline hold inside
a wide directory too, and the walk checks its deadline once per directory, so
a forest of empty directories ends in time. The driver waits the scheduler's settle window and then its background
jobs before it takes a probe snapshot, and checks the daemon is alive after
the prompt and again after the snapshot, reporting an exit once with the
turn's id. A proxy call record the gateway failed to write stops the run at
the next snapshot or before `EndArm` and `EndRun` are journaled, so the run
stays open for a resume and `calls.jsonl` never silently lacks a call the host
made. Recorder git children run with global and system config disabled and
the per-user excludes file (`$XDG_CONFIG_HOME/git/ignore`) pointed at
`/dev/null`, so the workspace's own rules are the only ignore rules. The grade, judge-call, and judgment logs must be regular
files or absent, checked before the judge gateway starts; a symlink at any of those paths stops grading before a
write.
The snapshot tree adds, with `--force`, the paths the project's source
repository tracks although its ignore rules match them (the driver lists
them from the source at reset), so a change to such a file is in the diff.
The snapshot tree leaves out a git repository nested in the workspace (git
would index it as a gitlink, hiding its files), and a probe turn that leaves
one behind ends `failed` with `embedded repository at <path>`, so the item
is excluded (SIM-P46) instead of graded on a diff that lacks that content.
The recorder's git refuses a workspace path that is a symlink or lies behind
one, and a tracked-but-ignored path whose parent became a symlink is left out
of the tree. Nested repositories are found by their `.git` entries, with the
ones the workspace's ignore rules match left alone; a nested repository is
also removed from the recorder's index, so a directory it replaced reads as
deleted in the tree. Snapshot diffs run with
`--text`, so a NUL byte or a `-diff` attribute hides no added line.

| Artefact | Source |
|---|---|
| `diff` (`turn`) | A git tree of the workspace's files that its `.gitignore` rules leave in, untracked files included, taken before the prompt and after it, and diffed |
| `diff` (`prior-session`) | The same trees at the start and end of the project's previous session |
| `command-log` | The host's tool runs, each a bash command or the tool name, its path, and its scalar arguments as `name=value` (a `read`'s offset and limit) followed by the text and structured arguments it was given (a `write`'s content, an `edit`'s edits), with a 0 or 1 error flag (null for a run that never finished) and the scenario time the run started. The recorder saves each run as the host logs it, so a harness kill mid-turn keeps the runs logged so far in the session log. Pi reports `tool_execution_start` and `tool_execution_end` events as they happen, and a run is timed from its start event and reaches the recorder at that start with a null exit, which its end report replaces, so a harness kill mid-run keeps the run on record; OpenCode's tool parts come from the session messages the turn added, read after the turn whatever its outcome, each timed from its start relative to the turn's first new message, both in OpenCode's own clock, with a pending or running part's exit null, and keyed by the part's id; on reattaching to a session after a kill, the host reports every tool part the session's messages hold, so a turn that was running at the kill still contributes its runs, timed at the resume when the recorder has no earlier record of them; the listings and the turn share one absolute turn deadline (a turn whose listing used it up fails without prompting, and a turn that used it up skips the post-turn listing as a capture gap), a listing that stalls is aborted and fails the turn as a capture gap, and the tool parts a failed post-turn listing missed are reported before the next turn |
| `proxy-call` | The session's call records from `calls.jsonl`, each with the index of the user turn it belongs to (a background call takes the preceding turn's), a `failed` flag on a call that ended in an error status, a recorded error, or a cut stream (such a call is no fold for P13), and the response text the proxy records for agent, user-sim, and judge calls (the first 262,144 characters, with `response_text_truncated` on a longer reply) |

The recorder keeps each project's session-start tree, the last session's
tree pair, the last ended session, and each workspace's index generation (a
restored generation must be a nonnegative integer) in
`<arm>/snapshot-state.json` (written through a freshly created staging file
and renamed into place), and the open session's commands in
`<arm>/commands.jsonl`, one appended line per tool report (a report whose
call id matches an earlier line replaces that record on reload), so a resumed
arm reopens its session with the same start tree and commands, and a
`session_start` and `session_end` that a resume replays for a session that
already ended leave its trees as recorded. Discovered nested-repository and
forced paths reach git as literal pathspecs. The driver records the host's
pid before the recorder takes the session's start tree, so a kill during that
capture leaves a resume able to stop the host.

The trees live in a bare repository the recorder owns, `<arm>/snapshot.git`,
with one index per workspace. The agent can write the workspace's `.git`, so
the recorder's git runs with `GIT_DIR` on its own repository, `GIT_WORK_TREE`
on the workspace, every inherited `GIT_*` variable dropped, and global and
system config off (`src/git.ts`); no filter, fsmonitor, external diff,
textconv, or `core.worktree` from the workspace's config applies. The
persistent index lets a later tree rehash only the files whose stat data
changed.

The harness captures no `test-result` or `workspace-state` artefact yet;
the graders read neither.

`scripts/grade-run.ts <run dir>` takes the run's lease, so one grader at a
time allocates versions, refuses a run whose pre-registration or scenario no
longer hashes to the digests in its manifest, whose `scenario.json` names a
seed or tier other than the manifest's, whose seed the tier does not
pre-register, whose manifest schedules more events than the scenario compiles,
records no nonempty list of model names, or names arms that are not a nonempty
subsequence of the tier's registered order for its seed, or whose journal
(a regular file, like every log grading reads) lacks `EndRun`
or an arm's `EndArm` and one terminal `Event` per scheduled event, in the
scheduled order (SIM-P67),
skips a cut last line of `grades.jsonl`, requires one `SnapshotArtefacts` entry per arm and item, exactly one row for
every journaled snapshot id, every snapshot row to name its directory's arm and
carry grade-class artefacts only (a command log's entries each carry command
text, a numeric or null exit, and a scenario time), every journaled row to
name an item the scenario compiles and match its journal entry's arm and item
and the compiled probe's event and session, to be named
by an `EndTurn` of the same arm, item, and event whose outcome agrees with its
`turn_outcome`, every
agent call's model in `calls.jsonl` to be one
the manifest records, and every journaled snapshot's calls, every
component but the user simulator's, to be a prefix of its session's `calls.jsonl` records under the
snapshot's arm, in log order, each with the same content and the turn index
capture derives from the scenario, reaching at least the last record of the
snapshot's own turn (each snapshot row is read back on its own
from its byte position and compared with its session's records through the
call index, so memory holds one snapshot and one session's records at most;
every log grading streams must be a regular file),
an item with no journaled snapshot to have a turn that ended `failed` with no
snapshot (reported as `probe turn failed`) or a terminal `Event` of
`failed(interrupted)` with no `EndTurn` (`probe turn interrupted`), since a
turn that ended `ok` or named a snapshot the journal never entered, or an
event that ended any other way without an `EndTurn`, makes the journal
invalid, reads each arm's snapshot log one row at a time and
keeps the artefacts of journaled rows only, computes every grade before it
appends any (an item whose answer the proxy truncated is skipped as `answer
refused`, and a P7 pair with an empty answer on either side as `P7 refused`;
a turn with no agent call has no answer and aborts grading, as does any other
structural artefact violation, with nothing appended),
holds P7 grades until the judge gateway has stopped and reports no failed
`judge-calls.jsonl` write, writes one `judgments.jsonl` row per judged
pairing (after dropping a cut last line, as for the other logs), where a
judgment the grader refuses on structural grounds aborts grading, (item, arms, the judgment with its digests and order verdicts, and
the `judge-calls.jsonl` sequence numbers of its two calls), and
grades every snapshot the
journal names
into `grades.jsonl` and judges each P7 item for each memory arm against the
host arm, through a gateway it starts for the judge. It checks the judge
model's family against every model the manifest records before it appends
the first grade, so a refused judge leaves the log untouched. A P7 pair
whose answers are refused before the judge call (empty, or carrying an arm
name) is skipped as refused; a judge call that fails or returns no verdict
is a judge error. The journaled
snapshot is an item's first attempt and the arm's later snapshots of that
item are its later attempts. A probe whose turn lies past the run's event
count is listed as outside the run. It prints the verdict
counts per arm and probe type (a P7 row also names the arm judged against),
the skipped items by arm and reason, the grade versions the summary
aggregates, the summed
`P11.weighted_score` per arm, Δmem per memory arm from this invocation's
grades, the judge errors, and the journal's last `seq` as `journal_seq`.
It removes any `grade-summary.json` in the run directory when it starts,
under the run's lease, and writes the same summary there atomically when it
finishes, so the cost panel prices only a finished pass over the journal as
it stands; it exits 1 when a judge call failed. The scenario plants no canary
strings, so it passes the judge none; blinding still refuses arm names. P14 items have no probe turn of their
own and wait on the user simulator's labels (M6), so it lists them as
skipped.

## Graders

| Probe | Pass when | Other metrics |
|---|---|---|
| P1 | Every rule the check names holds and none it forbids occurs (see the check channels below) | `P1.pass`; `pair` names the fact (SIM-P49) |
| P1 control | As P1, for the same task before the fact is conveyed | `P1-control.pass`, so the no-cue base rate stays out of `P1.pass`; `pair` as P1 |
| P2 | No forbidden rule occurs (`must_not`, `paths_must_not`, `first_line_must_not`, `commands_must_not`) | `P2.harm` when the rule was applied outside its scope |
| P3 | The work carries the authoritative value (the rules to hold) and no stale one (the rules to break); `must` and `must_not` are required | `P3.reliance` (`authoritative`, `stale`, `neither`), `P3.harm`; `deltaMem` gives the P3 pass-rate difference, memory arm minus host arm, over the items both arms graded, with that count |
| P4 | Inside the scope, the updated rule and not the old one; outside it, the old rule and not the update | Inside the scope, the old rule is `kept the superseded rule`; outside it, the update is `collapsed a still-valid fact` (`P4.collapsed`, `P4.harm`); a missing expected rule is named too; `check.side` (`in` or `out`) names the side, and `check.scope` limits the diff channels to its directory |
| P5 | Neither the added lines nor the turn's reachable command segments (with the heredoc bodies they consume) match the rejected approach | A command that only names the signature, such as a search for it, also fails the item; the check vocabulary has no read-only exemption |
| P6 | The added lines or the reachable command segments carry the planned next step | `P6.reread_files` (executed shell segments whose command is a read, with a file operand (one shell word) equal to a path the prior session added, changed, renamed (either path), or deleted (in Git form, where `a/` and `b/` are Git's prefixes and come off, or plain `diff -u` form with optional timestamps, where the header paths are literal, one or many files; the `+++` header's path is the operative one and a `diff --git` label stands only for a header-only operation), as a whole, with or without a leading `./`; a grep or rg pattern, positional (a quoted phrase is one word) or supplied by `-e`, `--regexp`, `-f`, or `--file`, is not an operand, an option's own value such as `-m 1`, taken from grep's and rg's own value-option tables (grep's `-E` is a flag, rg's `-E ENCODING` and `-r TEXT` take values), is neither, a heredoc delimiter or here-string value is neither, an output redirection target, quoted, bare, or attached to the preceding word, is written, and an input redirection target in either `< file` or `<file` form is read; the shell's `read` builtin names variables, so only its redirection target counts), `P6.rediscovery_tokens` requires at least one agent call of the turn, `P6.ran_tests` (an executed shell segment of the turn starts with a test command; a quoted mention is not a run), `P6.rediscovery_tokens` (input and output tokens of every agent call of the turn, failed calls included, cache reads excluded) |
| P8 | The answer carries the value as a whole word (`lookup_match`) | |
| P9 | With `check.abstain` set to `true`, the answer abstains: `UNKNOWN` alone on the first line, or abstention wording, with no value-shaped guess (a five-digit number, a codename, or a cloud-region name) and no hedged guess such as `probably` or `I think` (`abstain_rule`) | An unhedged free-text assertion beside the abstention wording, such as a bare person's name, passes; the regex rule has no model of the subject |
| P10 | The added lines carry no `must_not` pattern and the final completed response carries no `answer_must_not` pattern, compared case-insensitively; both keys are required | `P10.harm` |
| P11 | No forbidden rule of the other project occurs | `P11.harm` (binary); `P11.weighted_score` is +1 for a hit and minus `p11_false_positive_weight` (−2) for an injection, so summed over items an injection costs twice a hit (SIM-P50) |
| P12 | The rules to hold name the exception from the replayed error, and none forbidden occurs | |
| P13 | Score 1, over the completed folds whose call falls in the item's `check.turns` range (a fold call without a turn index refuses the grade): after the first of them, the session rule still holds over the session's commands from the fold on and the turn diff (every rule the check names holds and none it forbids occurs); every fold call's ratio of output tokens to total input tokens (fresh, cache-read, and cache-write), summarizer or native compaction, is within `p13_reduction_ratio` (0.02 to 0.5), a fold with no input tokens recorded failing this part; and no command from before the fold repeats after it, builds, tests, and installs in any package-manager form (Cargo's `b`, `c`, and `t` aliases included), status reads, and listings aside, where a compound command counts as a repeat | `P13.fold_fidelity_score` is the share of the three parts that hold, `P13.folds` the folds in range; with none the item is excluded |
| P14 | No completed user-sim `pushback` call that is sequenced after the first completed fold and whose turn index is at or after `window_from_turn` and before `window_to_turn` when the check names one; the fold itself may precede the window | `P14.post_compaction_correction_count`; an item is excluded with no compaction, when any completed user-sim call lacks its label or turn index, when a label is outside `task`, `pushback`, `interrupt`, `redirect`, `abandon`, `clarify`, `paste` (SIM-P25), or when no completed user-sim call falls after the fold inside the window; two completed user-sim calls for one turn index refuse the grade |

A fold is a `history_summarizer` or `native_compaction` call with a 2xx
status, no error, and no `failed` flag; a failed attempt sets no compaction boundary.

The run places each delivered user-sim turn in the `proxy-call` artefact just
before its turn's first proxy call (after the last call recorded by its
scenario time when the turn made none), with a fractional sequence number
between the two calls around it, so user-sim turns and folds share one
increasing order.

The check channels apply to the turn's work. `must` and `must_not` match the
surviving paths and added lines; `paths_must` and `paths_must_not` match the
surviving paths; `first_line_must` and `first_line_must_not` match the first
line of each file the diff creates (`first_line_must` needs one such file);
`quote_style_must` (`double` or `single`) requires every single- or
double-quoted string literal of the added lines, outside a `//` comment and
with a backtick template skipped, to use that delimiter, and at least one
literal; `commands_must` requires one executed shell segment to start with
every pattern, and `commands_must_not` refuses a segment that starts with any
(both read the turn's command log, and P13 the session's commands from the
fold on). `scope`, a directory prefix ending in `/`, limits the diff channels
to files under it. A grader reads the turn diff only when the check names a
diff channel. P1, P1-control, P3, P4, P6, P12, and P13 require a rule to hold,
and P2, P3, P5, P10, and P11 a rule to break; an item without one is refused.

Check patterns match line by line against the diff's surviving paths (the
new side of each file, a header-only rename included, so a deletion, with
or without hunks, names none) followed by its added
lines, so `^` anchors each line and a pattern can name a file as well as its
content. Added lines are the `+` lines inside hunks, told
apart from `+++` headers by position, so a source line that begins with `++`
is graded content; a Git-quoted header path is decoded before matching. Shell segments split on `;`, `&`, `|`, `&&`, `||`, and newlines outside quotes,
parenthesised or braced groups, word-initial `#` comments, and heredoc bodies
(every delimiter on a line, quoted or bare, is queued after shell quote
removal; terminators match exactly, `<<-` strips leading tabs; an unquoted
backslash-newline joins lines), so quoted, commented, and heredoc text stays out of
the executed commands, and a `{ ...; }` group or `( ... )` subshell opens
into its body's segments; a segment counts as executed when it is
unconditional, follows `&&` after a chain of `true` or `:`, or follows `&&`
in the command's last list when that list has no `||` and the command exited
0 (the exit code is that list's); every member of a
pipeline shares the guard of its first command; a command without a recorded
exit status credits its first list only; segments after a sure, foreground `exit`
or command-bearing `exec`, assignment-prefixed or bare, or after a `{ ...; }`
group whose body holds one, are unreachable (one inside a pipeline, a
background job, or a `( ... )` subshell ends its own process only; a `return` has
no function context in a captured command and does not end it); leading `NAME=value` assignments, parsed as shell words with quotes,
escapes, and `$( )`, `${ }`, and backtick substitutions, are dropped before
the command word is classified, and
`cargo`'s `+toolchain` selector and global options (`-q`, `-v`, `--locked`,
`--offline`, `--frozen`, `--color`, `-C`, `--config`, `-Z`) and the package
managers' (`--silent`, `-s`, `--cwd`, `-C`, `--prefix`, `--filter`,
`--loglevel`, and kin) are read past before the subcommand; a `||` continuation is left out
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
statistics (M7). A P13 item needs a rule to hold besides its range.

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
   item's reference reason (normalised like the answers), and reads one
   verdict per order: `first`,
   `second`, `both`, or `neither`. eval-core's verdicts are `first`,
   `second`, and `tie`; recall needs `both` and `neither` to tell two
   recalls apart from none. Unswapped verdicts that disagree make the pair
   `Inconsistent`, which grades as excluded with that reason and is never
   averaged. A reply that is not exactly one verdict word, with trailing
   `.` or `!` at most, refuses the call.
4. The judgment records each answer's length after normalisation, and
   `longer_recalled_alone` records whether the longer answer was the one
   recalled alone, for the verbosity audit.
5. `gradeP7` takes the judgment, the compiled P7 probe, and each arm's
   snapshots in attempt order, requires every snapshot to come from the
   probe's session and, when the probe names its event, from that turn,
   grades the first snapshot of each arm and
   counts the rest as later attempts (as `gradeItem` does), rebuilds the
   pair from those two snapshots (so the arms, snapshot ids, artefact
   inputs, answer digests, and lengths it records all come from the
   snapshots that produced the judged answers) and the reference digest
   from the probe's `check.judge`, and writes one grade per arm naming the other arm in
   `against`, for the
   item, the exact
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
