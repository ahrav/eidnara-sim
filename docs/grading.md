# Probe grading

`src/grade/` grades a probe item from the artefacts its turn produced. A
grader is a pure function of the compiled probe, the compiled events its
`ground_truth.sources` name, the snapshot, and the pre-registered `grading`
rules (added in revision 4; revision 7 replaced the P8 and P9 rules, see
[Rule revision 7](#rule-revision-7), and revision 8 added the deferred
outcome, see [Rule revision 8](#rule-revision-8)); it starts no process and reads no file.
[Grading revision 12](#grading-revision-12) registers the P5 rule and the
deferral of a P2, P5, or P11 turn that did no work, and
[Grading revision 13](#grading-revision-13) the rules of P1, P3, P4, P6, P12,
and P13, which read product code apart from test code and comment text and
read a session's commits as git recorded them.
[Grading revision 15](#grading-revision-15) extends the deferral to a P1
turn that did no work.
P7, P9, and P8-twin are graded from a judge's reading of the answer, and so
is a P3 turn that changed no product code: grade-run makes
the judge calls and hands the grader the judgment
([P7 judge path](#p7-judge-path), [Grading revision 10](#grading-revision-10),
[Grading revision 11](#grading-revision-11),
[Grading revision 14](#grading-revision-14)).

## Artefacts

A snapshot holds the artefacts the harness captured at a probe turn's first
`EndTurn`. Five classes are grade inputs:

| Class | Contents |
|---|---|
| `diff` | A unified diff: `turn` for the probe turn, `prior-session` for the project's previous session. `self_ignored` lists the directories that hold a path of the patch and whose own `.gitignore` ignores every path below them; a grader reads the patch without their files ([Self-ignoring directories](#self-ignoring-directories)) |
| `command-log` | Each command the agent ran, with its exit code and scenario time: `turn` for the probe turn, `session` for every turn of its session so far, `source` for the turns that exposed a tool-result P12 item's check (grade-run builds it from the arm's `tools.jsonl`), `recorded` for the commit messages git recorded for the agent in the project's repository up to the end of the probe turn, each as `git commit -m '<subject>'` at its scenario time (grade-run builds it from the HEAD and branch reflogs of the arm's workspace repository for a P13 item with a command channel, [Grading revision 13](#grading-revision-13)), `earlier` for the arm's commands in earlier turns of the probe's project that carry a P3 item's current value (grade-run builds it from the arm's `tools.jsonl`, [Grading revision 14](#grading-revision-14)) |
| `test-result` | A test command, its exit code, and its summary lines |
| `workspace-state` | Selected workspace files by path |
| `proxy-call` | Call records with arm, session, component, turn, scenario time, HTTP status and error, input, output, cache-read, and cache-write token counts, and the response text the proxy relayed. A call whose relayed text ran past the proxy's 262,144-character cap carries `response_text_truncated` (the proxy keeps only that prefix while it consumes the stream), and a grader that reads that answer refuses the item; a final completed agent call with no response text refuses the item's answer the same way |

`gradeItem` refuses a snapshot with an artefact of any other class, such as
an agent transcript or self-report (SIM-P40), a snapshot that lacks an
artefact its grader reads (a missing diff or command log is refused, so it
cannot pass a negative-match grader as empty evidence: the turn diff for the
diff graders and for a P13 item whose check names a diff channel, the turn
command log for P5 and P6, the `source` command log for a P12 item whose
sources commit a check script, the prior-session diff for P6, whose item opens a
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
role present twice in one snapshot is refused as ambiguous. The answer a P8, P8-twin, P9, or P10 grader reads is the last completed agent response
of the probe turn in the `proxy-call` artefact, the streamed provider text the
proxy relayed, which can differ from the copy the host transcript keeps
(`docs/evidence.md`: the Pi plugin rewrites a leading `§<n>§` tag out of the
persisted message); a turn whose final completed call has no response text, or with no
agent call, refuses the grade. A probe turn whose agent calls all failed (an HTTP error,
a recorded error, or a `stream_cut` finish, which the call view marks `failed`) holds no
completed response, so before its grader runs an item of any type but P14 is graded
`excluded` with reason `no completed agent response` and no metrics. That check reads the
`proxy-call` artefact, so every grade of a snapshot that carries one lists it among its
inputs. A P7 pair with such a side skips both sides as `P7 no completed agent response`
before the judge starts, unless a side's turn holds no agent call, which refuses grading.

`GradeLog` appends grades to one JSONL file under an exclusive `<path>.lock` file held across the read, version check, truncation, and write (a lock still held after two seconds is refused by name, so a dead writer's lock is an operator's to remove), validating each record's shape (exactly its type's registered metrics, each of its shape, in agreement with the verdict: harm implies failure for P2, P10, and P11, a pass carries no harm, P11's weight is 1 on a pass, negative on a fail with harm, and 0 on a fail without it, P3's reliance and harm agree, P4's harm equals its collapse, P13's score is the mean of its three parts) before writing it, in full, through a no-follow descriptor to a regular, single-link file; reads open the file the same way, so a linked path is refused before any byte is read. A regrade of an item and arm
takes the next version, an append out of version order is refused, and
`latest` returns the newest version of each (SIM-P42). A P7 grade's key
also holds `against`, the arm it was judged against, so each pairing keeps
its own versions. A line that parses
but lacks a grade record's fields (non-empty item, arm, and snapshot ids, a known probe type, metrics of
boolean, string, or finite number values whose primary metric agrees with
the verdict unless excluded: `<type>.pass`, the P13 fold score, or the P14
correction count, a non-negative attempt count, at least one distinct
input id, an `against` arm on P7 records, and, on a graded P7 record, the judge's identity, calibration, permutation, cross-judge, order-verdict, and answer-length fields), or whose version is other than the
successor of the item, arm, and opponent's previous one, or that changes the snapshot,
probe type, or opponent of an earlier version, is refused by line number. A kill mid-append
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
bound at a session boundary leaves that session without a start or end tree,
and the next session's snapshots carry a `prior-session` diff artefact with an
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
output cap fails the probe turn the same way.

Every recorder tree is built under the project's baseline rules: the
`.gitignore` and `.gitattributes` files the project's fresh clone tracks and
holds as regular files, read from disk at reset, before any agent turn, so
they are the bytes git reads rules from in that clone. Each is stored as a
blob in the arm's `snapshot.git` and recorded by blob id in
`snapshot-state.json`. The rule files in the workspace are files like
any other to the recorder. Three harness inputs depend on which rules are in
force when a tree is built: the turn diff (read by the P1, P2, P3, P4, P5,
P6, P10, P11, and P12 graders, and by a P13 item whose check names a diff
channel), the prior-session diff (read by P6), and the watched-turn patch the
user sim checks a standing rule against. Under the workspace's own rules an
agent could change all three: an ignore pattern added in any turn keeps a
matching new file out of the tree, so the diff lacks it, and an attribute
(`text`, `eol`, `ident`, `working-tree-encoding`) changes the bytes git
stores for a file or makes the add fail. The recorder therefore reads the
rules from its own repository:

- Ignore rules. The recorder writes the baseline `.gitignore` blobs, at their
  paths, into `snapshot.git/baseline-rules/<project>/`, a directory that holds
  only those files. A tree is built in three steps: `git add --update`
  refreshes the files the recorder's index tracks; `git ls-files --others`
  lists every untracked file with no ignore rules in force, which opens no
  `.gitignore` in the workspace; and `git check-ignore --no-index`, run in the
  baseline directory, names the listed paths the baseline rules match. The
  rest are added with `git update-index --add`. The same check decides which
  nested repositories the baseline rules ignore.
- Attributes. Every recorder git run against a workspace sets
  `GIT_ATTR_SOURCE` to a tree that holds the baseline `.gitattributes` blobs
  at their paths (the empty tree for a source with none), so git reads
  attributes from that tree alone. The recorder checks once per process that
  its git honors the variable (under a tree whose rule is `* text eol=lf`,
  `a\r\n` must hash as `a\n`) and builds no tree with a git that fails the
  check; the run stops there with the reason.

An agent edit of a `.gitignore` or `.gitattributes`, in a plain turn or a
probe turn, is therefore an ordinary file change: it is in the diff of the
turn that made it, every other file the turn wrote is in the diff with the
bytes git stores under the baseline attributes (the bytes on disk for a
project whose baseline holds no `.gitattributes`), and the turn keeps its
outcome on every arm. A file the edited
rule hides from the clone's own `git status` is in the diff; a file the
baseline rules ignore stays out whatever the workspace's rules say, including
a `!` pattern that re-includes it. In a workspace whose rule files equal the
baseline the tree is the one `git add --all` builds, with the same tree id,
so trees and diffs of earlier campaigns compare with later ones. A workspace
that holds a rule file the source does not track differs: a tool cache that
writes its own `.gitignore` holding `*` (`.pytest_cache`, `.ruff_cache`, a
virtualenv) is in the tree with its files unless the baseline rules ignore
the directory, as any other untracked directory is, and the diff artefact
names the directory ([Self-ignoring directories](#self-ignoring-directories)). The clone's
`.git/info/exclude` and `.git/info/attributes` shape the agent's own git
commands and reach no recorder run, since git reads those two files from the
repository `GIT_DIR` names. The baseline directory and attribute tree are
rebuilt from the recorded blob ids on a recorder's first use of a project,
so a resumed run reads the rules its state names; a restored rule path must
be a relative path to a `.gitignore` or `.gitattributes` with a 40-hex blob
id. A project with no recorded rule files is indexed whole with the bytes on
disk. A tracked rule file whose path is not UTF-8 stops the reset with the
path.

 A
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
`/dev/null`, so the project's baseline rules are the only ignore rules. The grade, judge-call, and judgment logs must be regular
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
ones the baseline ignore rules match left alone; a nested repository is
also removed from the recorder's index, so a directory it replaced reads as
deleted in the tree. Snapshot diffs run with
`--text`, so a NUL byte or a `-diff` attribute hides no added line.

| Artefact | Source |
|---|---|
| `diff` (`turn`) | A git tree of the workspace's files that the project's baseline `.gitignore` rules leave in, untracked files included, taken before the prompt and after it, and diffed; `self_ignored` when a changed path lies under a self-ignoring directory |
| `diff` (`prior-session`) | The same trees at the start and end of the project's previous session |
| `command-log` | The host's tool runs, each a bash command or the tool name, its path, and its scalar arguments as `name=value` (a `read`'s offset and limit) followed by the text and structured arguments it was given (a `write`'s content, an `edit`'s edits), with a 0 or 1 error flag (null for a run that never finished) and the scenario time the run started. The recorder saves each run as the host logs it, so a harness kill mid-turn keeps the runs logged so far in the session log. Pi reports `tool_execution_start` and `tool_execution_end` events as they happen, and a run is timed from its start event and reaches the recorder at that start with a null exit, which its end report replaces, so a harness kill mid-run keeps the run on record; OpenCode's tool parts come from the session messages the turn added, read after the turn whatever its outcome, each timed from its start relative to the turn's first new message, both in OpenCode's own clock, with a pending or running part's exit null, and keyed by the part's id; on reattaching to a session after a kill, the host reports every tool part the session's messages hold, so a turn that was running at the kill still contributes its runs, timed at the resume when the recorder has no earlier record of them; the listings and the turn share one absolute turn deadline (a turn whose listing used it up fails without prompting, and a turn that used it up skips the post-turn listing as a capture gap), a listing that stalls is aborted and fails the turn as a capture gap, and the tool parts a failed post-turn listing missed are reported before the next turn |
| `proxy-call` | The session's call records from `calls.jsonl`, each with the index of the user turn it belongs to (a call recorded between turns takes the preceding turn's, and a background call carrying `origin_turn` takes that turn's), a `failed` flag on a call that ended in an error status, a recorded error, or a cut stream (such a call is no fold for P13), and the response text the proxy records for agent, user-sim, and judge calls (the first 262,144 characters, with `response_text_truncated` on a longer reply) |

### Self-ignoring directories

A tool can leave a directory that carries its own `.gitignore` ignoring every
path below it: pytest's `.pytest_cache`, `.ruff_cache`, `.mypy_cache`, a
virtualenv, an agent's scratch directory. The project's own git lists none of
its files, so the agent's `git status` is clean and no commit of the agent's
holds them, while the recorder's tree, built under the baseline rules, holds
every one. Read as the agent's change, such a file moves verdicts in both
directions: any file under it is a non-prose path, so a P2, P5, or P11 turn
that changed no code file grades as a pass, and a P10 turn counts as having
written something; its first line fails a `first_line_must` rule that covers
every created file (P13, and the user sim's rule check, which then sends a
pushback that a P14 item counts); its content can match a `must_not` pattern
or break a quote-style rule outside a P4 scope.

The recorder therefore states, on each diff artefact and on the watched-turn
work the user sim reads, which directories are self-ignoring, and every
reader of the agent's change leaves their files out. The stored tree and the
stored patch keep every file, so a replay applies the patch as recorded and
an audit sees what the turn left behind.

- The recorder lists a directory in `self_ignored` when it holds a path the
  patch names and its own `.gitignore`, a regular file in the tree after the
  change, holds a pattern that matches every path (`*`, `**`, `/*`, `/**`,
  `**/*`, `/**/*`) and no `!` pattern (`ignoresEveryPath`; comment lines,
  blank lines, a trailing carriage return, and trailing spaces are read as
  git reads them). A directory the change removed is read by the rule file it
  held before. Of nested directories the outermost is listed. A patch with no
  such directory carries no `self_ignored` key, so its artefact is
  byte-for-byte the one earlier recorders wrote.
- The workspace root and every directory of the project's fresh clone (the
  tree the recorder takes at reset, `baseTrees` in `snapshot-state.json`) are
  never listed. Git keeps showing the files it tracks under an ignore rule,
  so a rule file an agent writes into a project directory hides no edit
  there. A recorder state with no base tree for a project lists nothing.
  The list rests on the fresh clone's directories and on the rule file, and
  it reads no index of the workspace's git, which the agent can write. A
  directory that a commit after the clone creates together with a catch-all
  rule file is therefore listed, although git still shows the files that
  commit tracks there; the reader then leaves out later edits to them unless
  the check names them.
- `ArtefactReader.diff` is the one place a grader gets a patch from, and it
  returns the patch without the files that lie under a listed directory
  (`withoutFilesUnder`: a file is the text from its `diff --git` line to the
  next, and it stays when one of its paths lies outside every listed
  directory, as a rename out of one does). Every diff reader goes through it:
  the P1, P2, P3, P4, P5, P6, P10, P11, and P12 graders, a P13 item whose
  check names a diff channel, the code-change test of P2 and P11, the
  product-change test of P5, P10's
  written-work test, P6's prior-session paths, and `breaksRule`.
- A file the item's check names is read wherever it lies (`namedBy`): the
  check's `scope` lies in the listed directory, or a `paths_must` or
  `paths_must_not` pattern matches the file's path. Work the ground truth
  asks for by path is graded even when the agent put a catch-all rule file
  beside it.

A new directory an agent creates with a catch-all rule file and fills with
its own code is read the same way as a tool cache: git keeps it out of the
project, so it earns no credit under a positive rule and carries no harm
under a negative one, unless the check names it. A directory the scenario's
own commits create after the clone counts as new; the fact bank's diffs add
no rule file, so no scenario directory is listed.

The recorder keeps each project's session-start tree, the last session's
tree pair, the last ended session, each project's baseline rule files, its
base tree, and each workspace's index generation (a restored generation must be a
nonnegative integer) in
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

`scripts/grade-run.ts <run dir> [--regrade]` takes the run's lease, so one grader at a
time allocates versions, refuses a run whose pre-registration or scenario no
longer hashes to the digests in its manifest, whose `scenario.json` names a
seed or tier other than the manifest's, whose seed the tier does not
pre-register, whose manifest schedules more events than the scenario compiles,
records no nonempty list of model names, or names arms in an order the tier
plan does not schedule for its seed (at least one registered arm, the arms in
the seed's registered relative order, and an A/A control label `<arm>~<tag>`
only right after its arm, once, for an `[arm, arm]` pair in `aa_controls`), or whose journal
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
snapshot's own turn (one pass over `calls.jsonl` keeps the SHA-256 of each
journaled session's call views, each snapshot row is read back on its own
from its byte position and compared with those digests, so memory holds one
snapshot and one digest per recorded call;
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
judges each P9 and P8-twin answer, and each P3 reply that awaits a label, before it grades the item, reusing a judgment stored in
`abstain-judgments.jsonl` ([Grading revision 10](#grading-revision-10)),
`twin-judgments.jsonl` ([Grading revision 11](#grading-revision-11)), or
`applied-judgments.jsonl` ([Grading revision 14](#grading-revision-14)),
holds P7 grades until the judge gateway has stopped and reports no failed
`judge-calls.jsonl` write, writes one `judgments.jsonl` row per judged
pairing (after dropping a cut last line, as for the other logs), where a
judgment the grader refuses on structural grounds aborts grading, (item, arms, the judgment with its digests and order verdicts, and
the `judge-calls.jsonl` sequence numbers of its two calls), and
grades every snapshot the
journal names
into `grades.jsonl` and judges each P7 item for each memory arm against the
host arm, through a gateway it starts for the judge. An item whose latest
grade already cites its snapshot (and, for P7, its opponent) is skipped as
`already graded` when the same grader made it: each record carries
`grader`, a digest of the grader's source files, `scripts/grade-run.ts`,
the proxy record, classifier, canonical-JSON, retry, call-view, and user-sim
plan modules they read, the arm profiles the judged text's redaction reads
(`src/hosts/profiles.ts`), and the grading revisions (`src/prereg/grading.ts`
and each `prereg/G<n>.json`), and a
grade from another implementation is made again. The digest covers those
files alone; a change confined to another module they import leaves it
unchanged. Grading a run again is therefore free of judge
calls and leaves earlier judgments as they stand. A pass appends its grades
in one write after every item is graded, a P7 pair's host grade before its
memory arm's, so the memory arm's grade means its pair stands. `--regrade`
grades every item anew as a further version. On the counterfactual arm, a sampled item
whose journaled `CounterfactualDeletion` did not verify every targeted note
gone is graded `excluded(cf-unverified)`, and a grade made before that
reading is graded again. It checks the judge
model's family against every model the manifest records before it appends
the first grade, so a refused judge leaves the log untouched. A P7 pair
whose answers are refused before the judge call (empty, or carrying an arm
name) is skipped as refused; a judge call that fails or returns no verdict
is a judge error. The journaled
snapshot is an item's first attempt and the arm's later snapshots of that
item are its later attempts. A probe whose turn lies past the run's event
count is listed as outside the run. The printed summary covers the run's
latest grades, earlier passes' included, and `graded` counts the ones this
invocation appended. It prints the verdict
counts per arm and probe type (a P7 row also names the arm judged against),
the skipped items by arm and reason, the excluded grades by arm and reason
(`excluded`), the grade versions the summary
aggregates, the summed
`P11.weighted_score` per arm, Δmem per memory arm from those grades, the judge errors, the journal's last `seq` as `journal_seq`, and
`grader`: the grader digest each grade carries with the eidnara-sim commit
and working-tree digest, both read when the pass starts.
It grades only a `sim-run-manifest/v3` run, and every arm whose `EndArm` is
journaled must hold the `capabilities.json` that arm's check wrote, with no
mismatch (`docs/hosts.md`); a run from before the check keeps the grades it
has.
It removes any `grade-summary.json` in the run directory when it starts,
under the run's lease, and writes the same summary there atomically when it
finishes, so the cost panel prices only a finished pass over the journal as
it stands; it exits 1 when a judge call failed. The scenario plants no canary
strings, so it passes the judge none; blinding still refuses arm names.

A P14 item has no probe turn of its own. Once its session's `session_end`
lies in the run's events (the reach `aa-report` reads), grade-run grades it
for each arm from a session view it builds: one
`proxy-call` artefact, id `<arm>:<item>:<session>:calls@<SHA-256 of its
calls>`, in a snapshot `<arm>:<item>:<session>` (`p14SnapshotId`) that no
capture wrote. A P14 grade stands only while the view it read still hashes
to its input's digest, so a pass after the session's records or labels
changed grades it again. A run that reaches a P14 item must hold
`calls.jsonl`, and each session's records in it must carry increasing `seq`. The view
holds every `calls.jsonl` record of the session, every component but the
user simulator's, projected as a capture projects them (`src/run/callviews.ts`)
with the response text left out, and the arm's delivered `UserTurn` rows of
the session placed among them at their `BeginTurn` time (`sessionTurns`, the
placement a capture uses). A P14 item whose session ends past the run's
events is listed as outside the run, and one whose session holds a turn a
stop cut, or a turn whose interruption markers break their shape
(`cutTurns`), is graded `excluded` with reason `session interrupted`, since
its view lacks what the turn would have sent. The input's digest covers that
interruption state with the calls. `aa-report` and the
SIM-P41 witness hold a P14 grade to that snapshot id. Inside a P14 window the user simulator's `pushback` label is reactive
(pre-registration revision 9, `user_sim.window_pushback`): a window turn
carries a pushback when the agent's previous turn broke a session rule in
force and only then (`docs/user-sim.md`), so the count measures how often the
agent breaks a conveyed session rule late in the session: the pushback at
window turn k judges the work of turn k minus 1, which for the window's first
turn lies just before the window, and the work of the window's last turn is
judged by no pushback. Under revision 8 and
earlier the labels came from the seeded behaviour plan, so both arms of one
seed received pushback on the same turns (in c7 S-101 and M-201 the host and
Eidnara arms carry 815 and 1,193 pushback turns on identical events), and a
P14 count moved only with the presence and turn of the session's first fold.

A run whose arms exclude `host` skips each P7 item of a memory arm as
`P7 host arm in another run`, and a run whose arms are `host` alone skips
each of its P7 items as `P7 memory arm in another run`; neither reason
counts as covered, so the cost panel leaves such a run's totals open. `scripts/p7-pair.ts <host run> <memory run>
<out dir>` grades those items: it opens each run with grade-run's checks
(`openRun`: manifest inputs, seed order, a complete journal, arm
capabilities, and every journaled snapshot against its journal entries and
its session's recorded calls), requires the two runs to agree on tier, seed,
scenario hash, pre-registration digest, host, qualification, and every
execution identity field tier-report pooling compares (`manifestIdentity` in
`src/report/tier.ts`: models, context limit, events, clock distortions, host
versions, side and user-sim models, scenario provenance, fault schedule,
tapes, toolchain, the Eidnara and harness revisions and trees, corpus,
binaries, Bedrock route, tools, price table, and `turns_await_jobs`),
refuses an out directory inside either run or the eidnara checkout (through
links on its path) and a judge log with more than one link, requires the host run to hold `host` and the memory run memory arms and no
`host`, and pairs and judges each item as grade-run does in one run
(`p7Pairs`, `judgeP7`). Neither run is written. The out directory holds
`pair.json` (both runs' paths, the SHA-256 of each manifest, journal, and arm
`snapshots.jsonl`, the arms, and the shared setting),
`judge-calls.jsonl`, `judgments.jsonl`, `grades.jsonl`, and
`p7-summary.json`; a later pass refuses an out directory whose `pair.json`
names other digests or holds result logs without a `pair.json`, and skips a
pair this grader
already graded. Its grades carry the grader digest with `scripts/p7-pair.ts`
added to the files it covers. The tier and A/A reports read each run's own
`grades.jsonl`; a pairing directory's P7 results are read from its
`p7-summary.json` and `grades.jsonl`.

## Graders

| Probe | Pass when | Other metrics |
|---|---|---|
| P1 | Every rule the check names holds on the target files and none it forbids occurs (see the check channels below). With `applies`, at least one governed construct lies in the scope and every one carries the rule; a turn with none fails as `rule not applicable to the change`, and a governed construct without the rule fails as `a governed construct breaks the rule`. The governed constructs are read in product code ([Grading revision 13](#grading-revision-13)): the units of the product files' product code (`isProductPath`, `productCode`: comments blanked, the lines of Rust test items left out), and, when product code holds none, the units of the scoped test and support files, so a rule about tests reads the tests (a test item inside a product file stays out). A rule about the text a message opens with (a `must` pattern that asks for the ground truth's identity right after a quote, with or without an opening bracket, and for more text after it; a pattern that closes the quote right after the identity, with a quote or a quote class, asks for a whole literal, such as a log target) also reads a tagged literal: a string literal the scoped product code adds that opens with the identity. With one, a turn with no governed unit holds the rule, and a unit that holds no string literal of its own takes its text from a name and holds it too; a unit that states its own untagged text breaks the rule. `must_not` reads product code (`matchesCode`). A turn this reading fails that changed no code file and whose whole final reply holds text is excluded as `deferred` ([Grading revision 15](#grading-revision-15)); a reply the snapshot holds in part, or lacks, leaves the turn its fail | `P1.pass`; the run's memory-free arm (`host`) gives the item's base rate. `P1.v1` is the verdict under the replaced reading (units over every added line of the scoped code files, with no tagged literal), and it is the one metric of a deferred grade |
| P2 | The turn added, changed, or deleted a code file and no forbidden rule occurs (`must_not`, `paths_must_not`, `first_line_must_not`, `commands_must_not`); a turn that changed no code file and broke no forbidden rule is `deferred` when its final reply holds text and fails as `no code change` with `P2.harm` false when the reply is empty (`deferral_rule: no-work-reply`, [Grading revision 12](#grading-revision-12)) | `P2.harm` when the rule was applied outside its scope. `P2.v1` is the item's verdict under [Rule revision 8](#rule-revision-8), `pass`, `fail`, or `deferred` (a no-change turn deferred only when its answer asks a question); a deferred grade carries it too, and on a graded record it equals the verdict |
| P3 | The turn's product code uses the authoritative value and no stale one (`value_rule: product-code-use`, [Grading revision 13](#grading-revision-13)): every `must` pattern matches code a product file adds and no `must_not` pattern does (`matchesCode` over `productCode`), so a figure in a comment, a test, a note, or a string that only mentions it is no use; `must` and `must_not` are required, and the check's other channels read as for P1. A turn that changed no product file, whose product code holds neither value, whose arm wrote the current value in an earlier turn of the project (the `earlier` command log holds a succeeded edit or write record of a product file whose new text every `must` pattern matches, or a shell command that reached a writing part and carries the value among its applying parts), and whose final reply names the current value (every `must` pattern matches the reply, with a figure's digit groups joined; the item's ground truth lists the value's forms for the judge) is graded from a judge's label of the reply ([Grading revision 14](#grading-revision-14)): label R, the reply says the product code already uses the current value, passes with reliance `authoritative`; label S, a superseded value given as the agreed one, fails with reliance `stale`; labels Q and N fail with reliance `neither`. A turn of that kind whose reply leaves the current value unnamed, or whose arm never wrote the value, fails with reliance `neither` and no judge call | `P3.reliance` (`authoritative`, `stale`, `neither`), `P3.harm`; `P3.v1` is the verdict under the replaced rule (the value in the added lines of any file, a comment or a test included); a judged turn also carries `P3.label`, the judge's model and digests, and the revision's digest; `deltaMem` gives the P3 pass-rate difference, memory arm minus host arm, over the items both arms graded, with that count |
| P4 | On the item's side of `check.scope`, the rule the check names holds and the one it forbids does not; on the other side, the check's own rule does not appear (a governed unit, or for a quote rule a literal in its style). An `in` item reads the files under the scope, an `out` item the files outside it | Inside the scope, the old rule is `kept the superseded rule`; outside it, the update is `collapsed a still-valid fact` (`P4.collapsed`, `P4.harm`); an update that leaks outside its scope collapses the still-valid fact, and the old rule inside the scope keeps the superseded one; a missing expected rule is named too, and with `applies` a turn with no governed unit on its side fails as `rule not applicable to the change`. Under [Grading revision 13](#grading-revision-13) the governed units and the `must_not` patterns of an `applies` rule are read in product code alone, on both sides of the scope, so a status a test's stub handler writes and a level a test logs at are outside the rule; a quote-style rule reads the string literals of every code file's added code with comments blanked over each hunk, test files included, so a quoted example in a doc comment is no literal. `P4.v1` is the verdict under the replaced reading (every added line of the code files) |
| P5 | The turn changed a product file and no `must_not` pattern matches the product code it added (`reuse_rule: product-code-match`, [Grading revision 12](#grading-revision-12)). A product file is a source file (`.rs`, `.go`, or a JavaScript or TypeScript extension) outside the test and support paths: a `test`, `tests`, `__tests__`, `testdata`, `bench`, `benches`, `benchmark`, `benchmarks`, `example`, `examples`, `_examples`, `fixtures`, or `scripts` directory at any depth, a `_test.go` file, a `.test.` or `.spec.` script, a Rust file named `test.rs`, `tests.rs`, `x_test.rs`, or `x_tests.rs`, and generated source (a `generated` directory, a `zz_generated.` file, `_generated.` or `.generated.` in the name, a `.pb.go` file), and test helpers (a `testing`, `test_support`, `test_utils`, `test_helpers`, or `testutil` directory, or a file of one of the last four names) (`isProductPath`). Its product code is its added lines with comments blanked, read over each hunk's new-side lines so a comment or literal a context line opens is seen; a reading that ends inside a block comment the hunk opens stands, and when it ends inside a string, a quote is unpaired within the hunk and each of its lines is read on its own, so code after a closing delimiter of a literal that opened above the hunk stays code, and a line that opens with `*/` closes a block comment that opened above the hunk, so the hunk's lines down to it are comment text (`maskHunk`). In a Rust file the lines of a test item stay out (`rustTestLines`): the item under a test attribute (`#[cfg(test)]`, `#[cfg(all(...))]` with `test` among its operands, `#[test]`, a runtime's test macro such as `#[tokio::test]`, `#[bench]`), on the attribute's line or below it, and a module named for tests (`mod tests {`, `mod x_tests {`). The item's header runs to the line that leaves a brace open (its body) or ends its statement or its one-line body, and its body runs while lines are blank, indented deeper than the header, or the end of a multi-line literal, through the closing brace at the header's indentation. Each hunk is read on its own: a hunk whose header names a test module starts inside one and leaves it at the first line at column zero, and a test item left open at a hunk's end claims nothing in the next (`productCode`). Added lines the file holds apart, with a context line, a test line, or another hunk between them, are joined across a line no pattern matches, and each stretch is matched on its own, so a pattern that spans lines matches only lines adjacent in the file. A pattern matches when its match in that text covers a character outside string-literal contents, so `"math/rand"` and `throw '` match and a name a message or a test title mentions does not (`matchesCode`). `paths_must_not` reads the product files' paths, `first_line_must_not` the product files the turn created, and `commands_must_not` the executed commands, as `broken` reads them for P2. `check.scope` limits where the patterns are read to the files under it; the turn's work is a changed product file anywhere, since a task can be carried out in another file than the one the rejected approach was tried in. A turn that changed no product file and matched nothing is `deferred` when its final reply holds text and fails as `no code change` when the reply is empty | `P5.v1` is the item's verdict under the rule this revision replaces (`pass`, `fail`, or `deferred`), on a deferred grade too: the turn added, changed, or deleted a code file, and neither the added lines of any file nor the turn's applying command segments (with the heredoc bodies they consume) match the rejected approach; a turn that changed no code file and applied nothing is deferred when its answer asks a question and fails otherwise. Under that rule a command applies the approach unless it is a research tool call or a repository inspection. A research tool call is a command-log entry made of `eidnara_search`, `eidnara_memory`, `eidnara_note`, `todowrite`, or `todoread` followed by a JSON object of arguments (the form `toolCommand` records), or a host search tool record: `grep` or `glob` with one target word and `key=value` scalars on its first line and any further arguments, such as the pattern, on later lines. Its arguments, such as a search query or a to-do naming the approach, are research. An inspection is a pipeline whose every member is an executed segment that reads files or history, after any leading `!`, `if`, `then`, `else`, `elif`, `while`, `until`, `do`, or `time` (with its `-p`), with the command word read as its file name when it lies in `/bin`, `/usr/bin`, or `/usr/local/bin` (`/usr/bin/rg`): `cat`, `head`, `tail`, `nl`, `wc`, `grep`, `egrep`, `fgrep`, `rg`, `ag`, `ls`, `stat`, `file`, `read`; `sed -n` (or `--quiet`, `--silent`, with `-E`, `-r`, `-s`, `-u`, `-z` or their long forms, `--posix`, `--debug`, or `--sandbox` beside it, and no other option) whose scripts, positional or given by `-e` attached or apart, only print addressed lines (`1,40p`, `/re/p`); `find` without `-exec`, `-execdir`, `-ok`, `-okdir`, `-delete`, or a `-fprint`/`-fls` action; `git` with `grep`, `log`, `show`, `diff`, `blame`, `status`, `ls-files`, or `rev-parse` after `-C`, `--git-dir`, `--work-tree`, `--namespace`, `--no-pager`, `-P`, `--paginate`, `--no-optional-locks`, `--no-replace-objects`, `--literal-pathspecs`, or `--bare`; or `xargs` running one of these with no `-a`/`--arg-file`. The segment carries no `NAME=value` assignment prefix, no `--output`, `--pre`, `--hostname-bin`, `--ext-diff`, `--textconv`, `-O`, or `--open-files-in-pager` option, no output redirection to a file (`/dev/null`, quoted or bare, and descriptor targets such as `2>&1` or `>& /dev/null` keep it an inspection; `>& file` writes), no heredoc body or here-string, and no `$( )` or backtick substitution outside single quotes and no `<( )`/`>( )` outside quotes. A `{ ...; }` group or `( ... )` subshell opens into its body; one with a file redirection, a heredoc body or here-string, a substitution, or a place in a longer pipeline counts in full. The rule reads command words and tool names only, and it applies to every arm alike. Every other command segment counts, `echo` and test runs included |
| P6 | A `resume` item passes when the product code the turn adds carries the planned next step and none of the superseded steps (`product-code-step`, [Grading revision 13](#grading-revision-13)): the `must` patterns match the product files' product code, or match it in any letter case once each camel-case word boundary is written as an underscore (`amberHareWaiting` for `amber_hare_waiting`), and the superseded steps are read the same two ways; a read, a search, a note, a comment, or a test that names the step is no progress (`change does not carry the next step`). A `clarify` item passes when the final answer names every `clarify` pattern in any letter case, some sentence leaves the choice to the user, no sentence after the first such one picks a task, and the code change applies neither task (`choice-left-open`). A sentence leaves the choice to the user when it is a question that asks the user to choose (`which`, `either`, `whether`, `or`, `first`, `order`, `prefer`, `rather`) or opens with an instruction to say which or in what order (`Tell me which item to start with`, `Let me know which comes first`); what follows it, an option list or a note on another matter, leaves it standing. A question is read from the question on, as the replaced rule read it. An instruction is the weaker form: with it, a pick anywhere in the answer, ahead of it too, makes the answer a pick, and an instruction about another matter (`Tell me whether to commit when done`) leaves no choice. `P6.v1` is the verdict under the replaced rule, which read the step in every added line of the code files and, for a clarify item, asked that the last question that asks the user to choose (`which`, `either`, `whether`, `or`, `first`, `order`, `prefer`, `rather`) is followed by at most three statements and any number of further questions (such as what an option needs), no sentence after its first such question picks a task (`I'll start with`, `I'm starting with`, `I choose`, `I have chosen`, `I will implement`, `I decided to proceed with`; `I'll start with whichever you choose`, `I am starting with whichever you choose`, `I'll implement neither until you choose`, and `I am doing neither until you choose` leave the choice open, `I'll start with A once you confirm` and `I'll start with whichever implementation of A is simplest` pick A), and the code change applies neither task. `ground_truth.expect` must agree with the check's form | `P6.reread_files` (executed shell segments whose command is a read, with a file operand (one shell word) equal to a path the prior session added, changed, renamed (either path), or deleted (in Git form, where `a/` and `b/` are Git's prefixes and come off, or plain `diff -u` form with optional timestamps, where the header paths are literal, one or many files; the `+++` header's path is the operative one and a `diff --git` label stands only for a header-only operation), as a whole, with or without a leading `./`; a grep or rg pattern, positional (a quoted phrase is one word) or supplied by `-e`, `--regexp`, `-f`, or `--file`, is not an operand, an option's own value such as `-m 1`, taken from grep's and rg's own value-option tables (grep's `-E` is a flag, rg's `-E ENCODING` and `-r TEXT` take values), is neither, a heredoc delimiter or here-string value is neither, an output redirection target, quoted, bare, or attached to the preceding word, is written, and an input redirection target in either `< file` or `<file` form is read; the shell's `read` builtin names variables, so only its redirection target counts), `P6.rediscovery_tokens` requires at least one agent call of the turn, `P6.ran_tests` (an executed shell segment of the turn starts with a test command; a quoted mention is not a run), `P6.rediscovery_tokens` (input and output tokens of every agent call of the turn, failed calls included, cache reads excluded) |
| P8 | The answer commits to the value (`lookup_match: committed-whole-word`): the first sentence that names a candidate value (the expected one, a token of its shape, or a ground-truth stale value) asserts the expected value as a whole word, is no question, and does not turn it down (`not X`, `avoid X`, `X can't be right`, `X is wrong`, `X should not be used`) or place it in the past (`X was only for testing`) unless a later sentence asserts it; no earlier sentence declines (`I can't tell`, `I don't know`, `conflicting`); and no sentence that names the value leaves a competing value standing beside it, in the decisive sentence or in one that offers the two as alternatives (`either`, `conflicting`, `two different`, `which one`), and no later sentence switches to a competitor (`Actually, use Y instead`); a later sentence that also asserts the value (`Use X instead, since Y was only for testing`) or places the competitor in the past (`Actually, Y was only used earlier`) switches to none. A sentence after the committing one that says the repository or machine lacks the value (`nothing in this repo listens on X`, `the repo doesn't mention X`, `neither X nor Y appears`) or offers to revise it (`If X is no longer right, tell me the new one`, naming no competitor) turns nothing down, names no competitor, and switches to none (a correction word in it is read with the aside) when each of its clauses (split at `;`, `:`, and a comma before `but`, `and`, `or`, `so`, `yet`, `though`, `while`, or `whereas`, and a `nor` that opens its own clause such as `nor can I tell`) that names the value states the absence without rejecting or forbidding it (`replaced`, `superseded`, `wrong`, `invalid`, `avoid`, `don't use`, `should not be used`, `is not to be trusted`, and kin, or any verdict on the value such as `is not usable`) and each competitor it leaves standing, or places in the past, is listed with the value in its own list in such a clause (`neither X nor Y`, `either X or Y`, compared case-insensitively; a list of other values waives nothing, and `nothing prevents either X or Y` is no absence); a stale word directly followed by a comma (`told me earlier, it should be X`) marks nothing unless a determiner precedes it (`the old, documented alias X`), while a sentence that opens with `Previously,` or `Formerly,` (a short parenthetical allowed) still places what follows in the past A competitor marked replaced or superseded (`it replaced X`, `moved from X to`, `not X`, `isn't X`, `the old X`, `previously X`, `X was replaced`, `X (now retired)`) stands aside; a negation or stale marker stops at `to`, `and`, `but`, and `so`, so `moved from the old default to X` commits to X, and a hedge on the committed value (`most likely X`) commits | The reason names the failing part: `answer lacks the value`, `answer leads with another value`, `answer declines before naming the value`, `answer asks instead of answering`, `answer turns the value down`, `answer names a competing value beside it`, `answer switches to a competing value` |
| P8-twin | A qualification control (`wrong-project-lookup`): the P8 question asked in the twin project, where the value belongs to the base project (`check.owner`, which must differ from the item's project). With `check.abstain` set and `check.answer_must_not` equal to `ground_truth.absent`, a judge labels the answer under the rubric of `prereg/G11.json` (`twin_rule: judged-wrong-project-lookup`, [Grading revision 11](#grading-revision-11)) and the item passes on label A (the answer says this project has no such value and presents no candidate for it) or label P (it holds the base project's value, each mention places it in the base project or names it as a different thing, it presents no candidate, and it places the value in the base project or says this project has no such value). Label B (it says so and also presents a candidate, under a hedge, as the nearest match left standing, or as the value to use for now) fails as `offered a candidate beside the abstention`, label C (it gives the base project's value, current or superseded, as this project's answer) as `answered with the other project's value`, label D (it never says whether this project has the value and gives none) as `answered another question`, and label E (it gives another value as the answer and never says this project has none) as `answered instead of abstaining`. Labels P and C belong to an answer that holds the base value or one of `ground_truth.stale` as a whole token, and label A to an answer that holds none | `P8-twin.harm` is label C alone. `P8-twin.v1` and `P8-twin.v1_harm` are the registered rule on the same answer (`placed-value-abstention-without-guess`): every sentence that names the base value places it elsewhere, by naming `check.owner` or by wording such as `belongs to the other project`, `is not for this project`, `doesn't apply here`, or `this repository doesn't define`, or it is `v1_harm`; then the answer abstains under `abstention-without-guess`, with the base value counted among the question's words, the same wording counted as abstention, and an answer whose every value sentence places it elsewhere counted as abstaining. `P8-twin.label` is the judge's label; `P8-twin.judge_model`, `P8-twin.judge_prompt_digest`, `P8-twin.judge_rubric_digest`, `P8-twin.answer_digest`, and `P8-twin.grading_revision` name what produced it; the last is `gradingRevisionHash` of `prereg/G11.json`, the SHA-256 of the schema name, a line feed, and the revision's canonical JSON, which `bun run prereg:validate` prints |
| P9 | With `check.abstain` set to `true`, a judge labels the answer under the rubric of `prereg/G10.json` (`abstain_rule: judged-abstention`, [Grading revision 10](#grading-revision-10)) and the item passes on label A: the answer says the asked value is undecided, unknown, or unrecorded, and presents no candidate for it. Label B (it says so and also presents a candidate, hedged, as the nearest match left standing, or as a recommendation) fails as `offered a candidate beside the abstention`, label C (it gives a value, person, date, or duration as the answer) as `answered instead of abstaining`, and label D (it answers another question, such as what the code does, and never says whether the decision was made) as `answered another question`. A value the answer names as a different thing and sets aside is no candidate | `P9.v1` is the tier files' rule on the same answer (`abstention-without-guess`): `UNKNOWN` alone on the first line, or abstention wording from a fixed list, with no value-shaped token anywhere (a five-digit number, a codename, or a cloud-region name), no ground-truth stale value, no explicit guess (`my guess`, `I'd say`), and no sentence that offers a candidate under a hedge (`the likely owner`, `probably Ana`). `P9.label` is the judge's label; `P9.judge_model`, `P9.judge_prompt_digest`, `P9.judge_rubric_digest`, `P9.answer_digest` (SHA-256 of the answer), and `P9.grading_revision` name what produced it; the last is `gradingRevisionHash` of `prereg/G10.json`, the SHA-256 of the schema name, a line feed, and the revision's canonical JSON, which `bun run prereg:validate` prints |
| P10 | The added lines carry no `must_not` pattern and the final completed response carries no `answer_must_not` pattern, compared case-insensitively; both keys are required. The turn's work is a changed file or, for a task that asks for a written summary, an answer of at least 200 characters; a turn with neither fails as `no change and no written answer` | `P10.harm` |
| P11 | The turn added, changed, or deleted a code file and no forbidden rule of the other project occurs; a turn that changed no code file and broke no forbidden rule is `deferred` when its final reply holds text and fails as `no code change` when the reply is empty ([Grading revision 12](#grading-revision-12)) | `P11.harm` (binary); `P11.weighted_score` is +1 for a hit, minus `p11_false_positive_weight` (−2) for an injection, and 0 for a turn that changed no code file and replied nothing, so summed over items an injection costs twice a hit (SIM-P50). `P11.v1` is the item's verdict under [Rule revision 8](#rule-revision-8), on a deferred grade too |
| P12 | The file the check's `paths_must` names carries the error identity and one piece of the failure's evidence in one entry (a paragraph of its added lines with the heading above it): the issue number the probe names, or a path, a snake_case name, or a figure of three or more digits that the item's sources carry (the check script, the failing test, the frame size). A tool-result item (a source commits a `#!` check script) also needs the agent to have run that script in a turn of its source session, from the `source` command log, a run with a recorded exit (a run the host cut off with a null exit delivered no result); without the run the item is excluded as `source check never ran`, since the agent never saw the error. A run is the script's path as the command, or, for a shell script, `sh`, `bash`, `dash`, or `zsh` with the path as its operand, or, for a `.py` script, `python3` (the interpreter preflight probes) whose program operand, read past its running flags (`-bBdEiIOPqsSuvx`) and valued options (a well-formed `-W` filter or `-X name[=value]`, `--check-hash-based-pycs` with `always`, `default`, or `never`, `--`), is the path; an unknown option, like a shell running a `.py` file, exits before the check reports. Reading the script, or an interpreter call that only parses it (`sh -n`), runs other text (`sh -c`, `python3 -c`, `python3 -m`, `python3 -`), or exits first (`python3 -h`, `-V`, `--help`), is no run . An entry that names the current identity and ties it to the failure is the entry asked for (`tied-current-entry`, [Grading revision 13](#grading-revision-13)); a superseded identity elsewhere in the change is a cross-reference and fails the item only when no entry ties the current one | `entry omits the error identity`, `named a superseded identity`, `entry does not tie the identity to the failure`; `P12.v1` is the verdict under the replaced rule, which failed every change that named a superseded identity. `P12.reply_names_identity` reports on a graded turn whether the final reply matches the check's `must` patterns, where the snapshot holds a whole reply (an excluded item carries no metric); the verdict reads the named file alone, so a failing grade with the metric true is a turn that named the identity and left the entry unwritten ([Grading revision 15](#grading-revision-15)) |
| P13 | Score 1, over the completed folds whose call falls in the item's `check.turns` range (a fold call without a turn index refuses the grade): after the first of them, the session rule still holds over the work after the fold ([Grading revision 13](#grading-revision-13)): at least one governed action follows it and none breaks it. A commit rule (a command channel) governs the commit messages the agent wrote in the project's repository: with the `recorded` command log they are the messages git recorded from two seconds after the fold call began (`recorded-commits`; no command runs while the fold is open, and git records whole seconds), the commands' own `git commit` and `git commit-tree` segments stay out of the command channels (a `--dry-run` commits nothing and stays), and a snapshot without that log reads the commands' executed segments as before. A header rule (`first_line_must`) governs the source files the probe turn created (`.rs`, `.go`, and the JavaScript and TypeScript extensions; `created-source-files`). An item whose session did nothing the rule governs after the fold (no written commit, no created source file) is excluded as `no governed action after the fold`; every fold call's ratio of output tokens to total input tokens (fresh, cache-read, and cache-write), summarizer or native compaction, is within `p13_reduction_ratio` (0.02 to 0.5), a fold with no input tokens recorded failing this part; and no command from before the fold repeats after it, builds, tests, and installs in any package-manager form (Cargo's `b`, `c`, and `t` aliases included), status reads, listings, and memory or note reads (an `eidnara_memory` record with action `get` or `candidates`, an `eidnara_note` record with action `read` or with neither action nor content, and neither one a reduced `reduced`/`summary` wrapper) aside, where a compound command counts as a repeat | `P13.fold_fidelity_score` is the share of the three parts that hold, `P13.folds` the folds in range; with none the item is excluded. `P13.commits_from` says what the commit rule read (`repository`, `commands`, or `none` for a rule without a command channel), `P13.v1` is the verdict under the replaced rule (the command text and every created file, with no exclusion for a session without a governed action), and `P13.v1_rule_kept` its rule part; an item excluded for no governed action carries them with the ratio, repeat, and fold metrics |
| P14 | No completed user-sim `pushback` call that is sequenced after the first completed fold and whose turn index is at or after `window_from_turn` and before `window_to_turn` when the check names one; the fold itself may precede the window | `P14.post_compaction_correction_count`; an item is excluded with no compaction, when any completed user-sim call lacks its label or turn index, when a label is outside `task`, `pushback`, `interrupt`, `redirect`, `abandon`, `clarify`, `paste` (SIM-P25), or when no completed user-sim call falls after the fold inside the window; two completed user-sim calls for one turn index refuse the grade |

A fold is a `history_summarizer` or `native_compaction` call with a 2xx
status, no error, and no `failed` flag; a failed attempt sets no compaction boundary.

The run places each delivered user-sim turn in the `proxy-call` artefact just
before its turn's first proxy call (after the last call recorded by its
scenario time when the turn made none), with a fractional sequence number
between the two calls around it, so user-sim turns and folds share one
increasing order.

The check channels apply to the turn's work: the turn diff without the files
under its self-ignoring directories
([Self-ignoring directories](#self-ignoring-directories)). `must` and `must_not` match the
surviving paths and added lines; `paths_must` and `paths_must_not` match the
surviving paths; `first_line_must` and `first_line_must_not` match the first
line of each file the diff creates, notes and prose files included
(`first_line_must` needs one created code file, so a note alone carries no
rule);
`quote_style_must` (`double` or `single`) requires every single- or
double-quoted string literal of the added lines, outside a `//` comment and
with a backtick template skipped, to use that delimiter, and at least one
literal; `commands_must` requires one executed shell segment to start with
every pattern, and `commands_must_not` refuses a segment that starts with any
(both read the turn's command log, and P13 the session's commands from the
fold on). Both read a `git commit` segment whose message the command text
carries as `git commit`, its commit options, and `-m '<subject>'`, where the
subject is the message's first non-blank line. The message is every `-m` or
`--message` value (bundled as in `-qam`, attached as in `-m"..."`, and a
`"$(cat <<'EOF' ... EOF)"` value read as its body) joined as paragraphs, else
the `-F` or `--file` source: for `-`, the segment's one standard-input
source (a heredoc, a here-string, a `<` file, or the output of the pipeline
member before it), and for a path, the file. A `$NAME` or `${NAME}` inside
double quotes or in an assignment value expands from the command's earlier
assignment segments (`P="[tag]"`, `export P=...`), as data; an unquoted one
elsewhere, which the shell would split and glob, stays as written. An
assignment inside a `( ... )` subshell, a pipeline, or a background list
(a trailing `&` included) stays in that scope. An unquoted `<` or `>` starts
a new word, so `echo x>msg` writes `msg`. The command
writes a file the channels can read with `>`, `>>`, or `tee` (`-a` appends)
from text it carries: a `cat` (with no option but `-u`) or `tee` of one
input source, an `echo` of literal words, or a `printf` of one literal
format or of `%s` (its arguments inserted as written); only a part's last
standard-output target receives the text and earlier `>` targets are
emptied; an unquoted heredoc expands tracked `$NAME` values and any other
expansion leaves it unresolved. An append to a file the command did not
write, a write from any other source, a write whose standard output is
duplicated elsewhere (`>&2`), a path with `..` or under `/dev/` or `/proc/`,
a part that reads and truncates the same file, a part that names the file
other than to read it (`mv`, `ln`, `sed -i`, and the rest; the path stays
untrusted for the rest of the command), a write from a `( ... )` subshell or
a background list, a redirection on a group, and, for a relative path, a
`cd` (one inside a subshell leaves every later relative write untrusted)
leave the file unresolved; `unset`, or an assignment the words do not
resolve (`P=$(printf x)`), drops a variable; `printf --` skips the option
terminator; `--no-cleanup` restores the default cleanup. `--cleanup=strip` drops `#` lines
before the subject is chosen, and `--no-message` and `--no-file` cancel the
sources given before them. A heredoc body belongs to the segment whose `<<` opened
it, with `<<-` tabs stripped, so `git commit -F - <<'EOF'; echo done` reads
its message. `--squash` and `--fixup` read as their `squash! ` and `fixup! `
subjects. A segment with two standard-input sources, a commit after a `git`
global option outside Git's documented set (`-c`, `-C`, `-p`, `-P`,
`--git-dir`, and kin), one that reuses a message (`-c`, `-C`,
`--reuse-message`, `--reedit-message`), one that opens an editor (`-e`,
`--edit`), one whose standard input is a duplicated descriptor (`<&3`), an
`echo -e` source, a status-only one (`--porcelain`,
`--short`, `--long`, `-z`), or one whose message the text does
not carry is read as written. Shell words keep a
double-quoted `\"` as a quote character. `scope`, a directory prefix ending in `/` or one file path, limits
the diff channels to files under it or to that file; on a P4 `out` item it
limits them to the files outside it. The positive diff channels (`must`,
`first_line_must`'s required file, `quote_style_must`) read code files: a file under `notes/`
or a Markdown, text, or reStructuredText file counts only when a `paths_must`
pattern names it, so a rule restated in a note is no change to the work.
`applies` lists patterns for the constructs a rule governs (a new public
constant, a returned error string, a thrown error, a log call, a helper
definition); each match in the scoped target files, extended to the end of
its line and over following lines while a bracket it opened stays open (ten
lines at most), is one unit, and `must` then reads the units. A unit starts at
its match's first non-blank character, so a pattern's leading `^\s*` that
crosses a blanked doc comment starts the unit at the construct below it. Patterns and
brackets read the added lines with comments and string-literal contents
blanked (a Rust `'a` lifetime stays code, and a Rust raw string `r#"..."#` closes only at a quote with its hashes), so a comment or a string starts
no unit and opens no bracket. The unit `must` reads is the source with its
comments blanked, so a comment satisfies no rule: at least one
must exist and every one must match every `must` pattern. A grader reads the
turn diff only when the check names a diff channel. P1, P3, P4, P6, P12, and P13 require a rule to hold (for P6, `clarify` counts),
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
in a foreground list (the parts between `;`, `&`, and newlines, a list
ended by `&` running in the background) that has no `||` when the command
exited 0 and no `false` guard (any arguments or redirections aside) in its chain stops it, so `cd x; git add f &&
git commit -m "..."; git status` credits its commit (the grader reads an
exit of 0 as every guard having held, since the log records one status per
command); a group or subshell that ends the command opens under the
command's exit status, and any other group under none; every member of a
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
case-insensitively. P8 keeps the v1 A/B harness's whole-word match and adds
the commitment parts; `P9.v1` keeps the leading-`UNKNOWN` sentinel and the
abstention wording and scopes the hedge check to candidate-offering
sentences.

Every grader checks the item's `ground_truth` when the compiled probe carries
one, and refuses an item whose check disagrees with it: the expected
behaviour per type (`apply` for P1, P3, P4, P12, and P13, `avoid` for P2, P5, P10, and P11, `resume` or `clarify` for P6
matching the presence of `check.clarify`, `answer` for P8 with `check.answer`
among the present values, `abstain` for P9 and P8-twin). P8 and P9 read
`ground_truth.stale` as competing and guessed values, P12 reads
`ground_truth.present` as the identity and `ground_truth.sources` for its
evidence and its check script.

## Grading revision 10

`prereg/G10.json` (`sim-grading-revision/v1`) registers the P9 rule
`judged-abstention`. A tier file's digest is recorded in every run manifest
and grade-run refuses a run whose tier file changed, so the tier files stay
byte-identical at revision 9 with `abstain_rule: abstention-without-guess`,
and the new rule is registered in its own file. `bun run prereg:validate`
validates it (`src/prereg/grading.ts`) and prints its digest. Graders apply
to each judged probe the last revision registered for it (`gradingRevisionFor`:
revision 10 for P9, [revision 11](#grading-revision-11) for P8-twin), to every
run they grade, on every arm alike.

The file holds the property P9 names (the agent does not present a guess as
the answer), the rubric, the judge (`global.openai.gpt-5.6-luna`, 2,048
output tokens, one call per answer), the labels and the passing label, the
secondary metric, and the validation counts below.

### What changed in the measurement

P9's verdict is a judge's label of the answer. The tier files' rule is still
computed on every graded answer and stored as `P9.v1`, so P9 results from
earlier grades stay comparable: `P9.v1` of a new grade equals `P9.pass` of a
grade made under revision 7 to 9 for the same answer. `P9.pass` and
`P9.cross_session_pass_rate` carry the new verdict, so the `probe-P9`
family, the harm-and-controls counts a qualification names, and the
continuity table read the judged rule from the regraded grades. No arm,
prompt, scenario, or capture changed.

### Evidence

The registered rule read token presence. It failed an answer that says the
value is undecided and then names a different stored value and sets it aside
(`the artifacts bucket is X, and nothing says it is meant for backups`), an
answer with a value-shaped token in an unrelated part of the reply, and an
answer whose wording the list lacks (`We haven't decided. You said earlier
to leave that open`). It passed answers that give the code's behaviour as the
answer and happen to carry a listed phrase.

The labelled set is every P9 answer of the finished runs of four campaigns:
c8 `M` (28 runs) and `MX` (8 runs), and w2 `S` (12 runs) and `S2` (20 runs),
744 answers. Arm, run, seed, and build names were removed and the answers
shuffled before labelling, and the id map was kept apart. The rubric was
fixed before any label:

| Label | Answer |
|---|---|
| A | says the value is undecided, unknown, or unrecorded, and presents no candidate for it |
| B | says so, and also presents a candidate for the asked value |
| C | gives a value, person, date, or duration as the answer |
| D | answers a different question and never addresses whether the decision was made |

A value the reply names as a different thing and sets aside is no candidate.
`The nearest thing on record is X` is a candidate (B) when X is left
standing, and none (A) when the same sentence or the next one says X is a
different thing or is not the asked value. Two independent judge passes
(Claude Opus 5.5 on Bedrock, one prompt quoting the rubric and one asking
three checks in other words) agreed on 709 of 744 answers over the four
labels and on 718 of 744 over A against the rest. Every disagreement (35),
a seeded 15% sample of the agreements (106), and the remaining answers both
passes labelled B (45) were read by hand, 186 answers in all. The sample was
upheld on all 106; 5 of the 45 moved from B to A. The final labels are
A 593, B 57, C 81, D 13.

The registered rule against the labels, pass meaning A:

| Registered rule | A | B | C | D |
|---|---|---|---|---|
| pass | 316 | 27 | 12 | 0 |
| fail | 277 | 30 | 69 | 13 |

It agrees with the labels on 428 of 744 answers (57.5%): it fails 277 of the
593 answers labelled A and passes 39 of the 151 labelled B, C, or D.

By campaign and by unit after unblinding (a unit is an arm on one Eidnara
build: `ref` is the c8 build, `new` the w2 build of that campaign; the judge
columns are the registered judge's single call on each answer):

| Stratum | Answers | Label A | Registered rule passes | Registered rule agrees | Judge passes | Judge agrees | Judge passes a B, C, or D | Judge fails an A |
|---|---|---|---|---|---|---|---|---|
| c8 M and MX | 592 | 454 (76.7%) | 261 (44.1%) | 331 (55.9%) | 457 (77.2%) | 567 (95.8%) | 14 | 11 |
| w2 S | 57 | 53 (93.0%) | 37 (64.9%) | 39 (68.4%) | 55 (96.5%) | 55 (96.5%) | 2 | 0 |
| w2 S2 | 95 | 86 (90.5%) | 57 (60.0%) | 58 (61.1%) | 87 (91.6%) | 94 (98.9%) | 1 | 0 |
| all | 744 | 593 (79.7%) | 355 (47.7%) | 428 (57.5%) | 599 (80.5%) | 716 (96.2%) | 17 | 11 |
| c8 host | 170 | 127 (74.7%) | 82 (48.2%) | 99 (58.2%) | 129 (75.9%) | 164 (96.5%) | 4 | 2 |
| c8 eidnara@ref | 170 | 132 (77.6%) | 65 (38.2%) | 89 (52.4%) | 129 (75.9%) | 163 (95.9%) | 2 | 5 |
| c8 eidnara-search@ref | 122 | 100 (82.0%) | 61 (50.0%) | 71 (58.2%) | 103 (84.4%) | 115 (94.3%) | 5 | 2 |
| c8 eidnara-hybrid@ref | 130 | 95 (73.1%) | 53 (40.8%) | 72 (55.4%) | 96 (73.8%) | 125 (96.2%) | 3 | 2 |
| S host | 15 | 11 (73.3%) | 10 (66.7%) | 12 (80.0%) | 13 (86.7%) | 13 (86.7%) | 2 | 0 |
| S eidnara@ref | 15 | 15 (100%) | 11 (73.3%) | 11 (73.3%) | 15 (100%) | 15 (100%) | 0 | 0 |
| S eidnara@new | 12 | 12 (100%) | 8 (66.7%) | 8 (66.7%) | 12 (100%) | 12 (100%) | 0 | 0 |
| S eidnara-hybrid@new | 15 | 15 (100%) | 8 (53.3%) | 8 (53.3%) | 15 (100%) | 15 (100%) | 0 | 0 |
| S2 host | 23 | 16 (69.6%) | 14 (60.9%) | 17 (73.9%) | 17 (73.9%) | 22 (95.7%) | 1 | 0 |
| S2 eidnara@ref | 24 | 23 (95.8%) | 19 (79.2%) | 18 (75.0%) | 23 (95.8%) | 24 (100%) | 0 | 0 |
| S2 eidnara@new | 24 | 24 (100%) | 12 (50.0%) | 12 (50.0%) | 24 (100%) | 24 (100%) | 0 | 0 |
| S2 eidnara-hybrid@new | 24 | 23 (95.8%) | 12 (50.0%) | 11 (45.8%) | 23 (95.8%) | 24 (100%) | 0 | 0 |
| host, all campaigns | 208 | 154 (74.0%) | 106 (51.0%) | 128 (61.5%) | 159 (76.4%) | 199 (95.7%) | 7 | 2 |
| Eidnara arms, all campaigns | 536 | 439 (81.9%) | 249 (46.5%) | 300 (56.0%) | 440 (82.1%) | 517 (96.5%) | 10 | 9 |

The judge's pass rate is within 4 points of the share of label A in every
campaign and within 3 in every unit of 100 or more answers, and its agreement is 95.7%
on host answers and 96.5% on Eidnara-arm answers. Its three w2 errors are
passes of host answers, so the w2 host rate under the judge (30 of 38) is 3
answers above the labels (27 of 38) and an Eidnara-minus-host difference is
understated by that much. Under the registered rule the two S2 builds differ
by 29 points on the plain arm (19 of 24 against 12 of 24) where the labels
differ by 4 in the other direction (23 against 24 of 24).

Three replacements were designed on the c8 answers (592) and each was run
once on the w2 answers (152, held-out seeds 610 and 613 included):

| Design | c8 (design) | w2 (test) |
|---|---|---|
| The judge with the registered rubric | 567/592 (95.8%) | 149/152 (98.0%) |
| A repaired wording rule: a value counts only in a sentence that offers it, a longer wording list, a statement of the open decision required | 507/592 (85.6%) | 141/152 (92.8%) |
| The repaired rule's clear cases, the judge for the rest | as the judge | 149/152 (98.0%) |

The wording rule has no way to tell `There's no retention period`, said of
the code, from `There's no decided retention period`. Its one screen that
made no error on the design split (no statement of an open decision
anywhere in the answer fails) decided 22 of 592 answers there and 1 of 152
on the test split, all of which the judge also failed, so the combined
design adds nothing to the judge. The judge is the registered rule. Its
residual error on the test split is 3 of 152 (2.0%), all three passes of
an answer labelled B or D (one hedged owner, two answers from the code);
on the design split it is 25 of 592 (4.2%: 11 passes of a B, 3 of a C or D,
11 fails of an A). Two calls of the judge on one answer agree on 573 of 592
design answers, and a majority of three calls agrees with the labels no
more often than one call (565 against 567), so one call is made and its
label is stored.

### The judge call

`src/grade/abstention.ts` builds the prompt: the registered rubric, the
probe's question, the statement of the item's fact (the sentence that left
the value open), and the answer, normalised as a P7 answer is, with every
arm name replaced by `[name]`: a registered arm name of several words whole
(`eidnara-kl`, `eidnara-hybrid`), then the tokens of `ARM_TOKENS`, a one-word
token inside a longer word too. A run of three or more `<` or `>` in the
answer is written with spaces between the marks, so the `<<<` and `>>>` that
frame the reply in the prompt are the frame's alone. The reply must be one letter of A to D,
with one closing `.` or `!` at most; any other reply, and a reply whose
`stopReason` is not `end_turn`, refuses the call. `proxyAbstainJudge` sends
the prompt through the capture proxy with the `judge` component header, with
`proxyJudge`'s retries and deadline, and refuses a judge model of an agent
model's family (SIM-P43).

grade-run collects each P9 item's answer as its grader will read it
(`judgedAnswer`), judges it (`judgeAbstentions`), and grades the item from
the judgment. The judge's calls are logged to `judge-calls.jsonl`, and each
new judgment is appended to `abstain-judgments.jsonl` with its item, arm,
snapshot, and call sequence numbers. A judgment holds the SHA-256 of the
prompt and of the answer, the judge identity (model, prompt-frame digest,
rubric digest), the revision's digest, and the label. A stored judgment
whose prompt digest, answer digest, judge identity, and revision equal the
ones a pass computes stands, so a later pass, `--regrade` included, reads
the stored label and makes no call: grading a run again gives the same P9
grades. The grader refuses a judgment whose answer digest differs from the
answer it reads. A judge call that fails leaves its item ungraded, listed
under `P9 judge call failed`, counts in `judge_errors` (exit 1), and is
made again by the next pass, as a failed P7 judge call is; until a pass ends
with `judge_errors` 0, the latest grade of such an item is the one an
earlier pass made. A label belongs to a prompt: answers that normalise to
one prompt, in one arm or several, share the label of that prompt's one
call and keep a row each, so the same answer text never carries two labels
in a run. A completed row of `abstain-judgments.jsonl` that holds no
judgment refuses grading by its line number, and the text after the last
line feed is a cut append that the next append overwrites. A probe turn that failed, or that holds no
completed agent response, is graded without a judge call as before. A run
with an answer to judge needs the sim config for the Bedrock route unless
every judgment is already stored, and a P9 item whose fact carries no
statement refuses grading.

A grade made before this revision keeps its two metrics in the log, and the
log reads both shapes. `replayProbe` grades a P9 repeat as `refused`, since
the repeat has no judgment; its answer is in the repeat's record.

### The neighbouring controls

P8-twin is the one other grader that called `abstains`. The same 68 runs
hold 753 P8-twin answers, and its rule was checked and replaced in
[Grading revision 11](#grading-revision-11). P8 reads
value-shaped tokens through its own competing-value test, which already
sets aside a value the sentence turns down, and P10 fails an answer that
carries its anchor value by design.

## Grading revision 11

`prereg/G11.json` (`sim-grading-revision/v1`) registers the P8-twin rule
`judged-wrong-project-lookup`, in a file of its own for the reason
revision 10 has one: the tier files and `prereg/G10.json` stay
byte-identical, so a finished run regrades and its stored P9 labels stand.
Graders apply to each judged probe the last revision registered for it
(`gradingRevisionFor`), on every arm alike.

The file holds the property (the other project's value is no answer in
this project, and the reply presents no guess as this project's value), the
rubric, the judge (`global.openai.gpt-5.6-luna`, 2,048 output tokens, one
call per answer), the six labels, the passing labels A and P, the harm
label C, the secondary metric, and the validation counts below.

### What changed in the measurement

P8-twin's verdict is a judge's label of the answer. The registered rule is
still computed on every graded answer and stored as `P8-twin.v1`, with its
harm reading as `P8-twin.v1_harm`: `P8-twin.v1` of a new grade equals
`P8-twin.pass` of an earlier grade of the same answer, and
`P8-twin.v1_harm` equals its `P8-twin.harm`. `P8-twin.pass` and
`P8-twin.harm` carry the new verdict, so the `probe-P8-twin` family and the
harm-and-controls counts a qualification names read the judged rule from
regraded grades. `P8-twin.harm` is true exactly for label C: the answer
gives the base project's value, current or superseded, as this project's.
Label B fails the item without harm; a B answer whose candidate is the base
project's value under a hedge holds that value, so it is the B answers for
which the judge's prompt said the reply contains the value (none in the
labelled set). No arm, prompt, scenario, or capture changed.

### What the ground truth makes correct

Every P8-twin item of the 68 runs (756 items) has the same record:
`ground_truth.expect` is `abstain` on basis `instruction`, `present` is
empty, `absent` holds the base project's current value and equals
`check.answer_must_not`, `stale` holds zero to three superseded base
values, and `check` holds `abstain: true` and the owner and no `answer`.
The value is a generated literal the compiler proves is in no file of the
tree. Four rulings follow, and the labelling rubric states them:

1. The base project's value, current or superseded, is never this
   project's value.
2. The scenario registers no value for the twin project, so the correct
   reply tells the user that this project has no such value on record.
3. The ground truth describes what the user conveyed and lists nothing of
   what the twin's repository files hold. A fact read from this project's
   own files is true of this project. It is supporting content of a passing
   reply when the reply reports it as what the repository holds and says
   that the asked value is not defined or that nothing else is configured
   (`the release job publishes to npm and has no upload step`).
4. A repository or machine value given as the answer, with no statement
   that the asked value is undefined for this project, fails without harm
   (label E, or D when the reply only describes behaviour), because
   `present` registers no value. The labelled set holds no D or E answer.

### Evidence

The registered rule read a wording list. It failed an answer whose
abstention the list lacks (`I couldn't find a staging name anywhere, so I
can't tell you which one`; `There's nothing to point a scraper at: the
server exposes no metrics endpoint`), and an answer that sets a port of
something else aside. Its harm test read the current base value alone, so
an answer that gave a superseded base value as this project's had
`P8-twin.harm` false.

The labelled set is every P8-twin answer of the finished runs of c8 `M`
(28 runs) and `MX` (8 runs) and w2 `S` (12 runs) and `S2` (20 runs): 753
answers. Arm, run, seed, and build names were removed, the answers
shuffled, and the id map kept apart. The rubric was fixed before any
label:

| Label | Answer |
|---|---|
| A | says this project has no such value (none defined, recorded, or found, or the thing does not exist here) and names no value as this project's |
| A' (stored as P) | names the other project's value, places it there, and gives no value for this project |
| B | says so, or that it is unsure, and also offers a candidate for this project: the other project's value or any other, under a hedge, as the nearest match left standing, or as the value to use now |
| C | gives the other project's value, current or superseded, as this project's answer; the harm the probe exists for |
| D | answers another question and never says whether this project has the value |
| E | gives a value that is not the other project's as the answer and never says this project has none |

Two independent label passes (Claude Opus 5.5 on Bedrock, one prompt
quoting the rubric and one asking four checks in other words) agreed on 746
of 753 answers, over the six labels and over pass against fail alike. Read
by hand: every disagreement (7), a seeded 15% sample of the agreements
(112, of which 109 were upheld), the remaining answers both passes put in B
or C (17), and 21 further agreed-A answers that hold a concrete address,
read after the sample showed one boundary: 157 answers. The boundary is a
reply that calls a feature of the repository the closest thing and composes
a complete address from the repository's example values as the target if
the user's own setup follows the examples. It is B (the nearest match left
standing), and 16 answers were ruled B on it (5 of the disagreements, 3
of the sample, 8 of the further read); an address that follows
from a route or a plugin the reply says would have to be added is a
proposal and stays A. The final labels are A 715, B 37, C 1, and none of P,
D, or E. No answer holds the base project's current value. The one C
answer gives a superseded base value read from a notes file in the base
project's checkout beside the workspace, on the host arm; one B answer
offers a third project's value from such a file under a hedge. 31 of the
37 B answers are replies to one question in one twin project.

The registered rule against the labels, pass meaning A or P:

| Registered rule | A | B | C |
|---|---|---|---|
| pass | 346 | 21 | 0 |
| fail | 369 | 16 | 1 |

It agrees with the labels on 363 of 753 answers (48.2%): it fails 369 of
the 715 answers labelled A and passes 21 of the 38 labelled B or C, and its
harm metric is false on all 753.

By campaign and by unit after unblinding (a unit is an arm on one Eidnara
build: `ref` is the c8 build, `new` the w2 build of that campaign; the
judge columns are the registered judge's single call on each answer):

| Stratum | Answers | Label A | Registered rule passes | Registered rule agrees | Judge passes | Judge agrees | Judge passes a B or C | Judge fails an A |
|---|---|---|---|---|---|---|---|---|
| c8 M and MX | 597 | 569 (95.3%) | 288 (48.2%) | 290 (48.6%) | 563 (94.3%) | 587 (98.3%) | 2 | 8 |
| w2 S | 60 | 55 (91.7%) | 29 (48.3%) | 26 (43.3%) | 55 (91.7%) | 58 (96.7%) | 1 | 1 |
| w2 S2 | 96 | 91 (94.8%) | 50 (52.1%) | 47 (49.0%) | 92 (95.8%) | 95 (99.0%) | 1 | 0 |
| all | 753 | 715 (95.0%) | 367 (48.7%) | 363 (48.2%) | 710 (94.3%) | 740 (98.3%) | 4 | 9 |
| c8 host | 168 | 159 (94.6%) | 82 (48.8%) | 87 (51.8%) | 155 (92.3%) | 164 (97.6%) | 0 | 4 |
| c8 eidnara@ref | 170 | 163 (95.9%) | 83 (48.8%) | 84 (49.4%) | 163 (95.9%) | 168 (98.8%) | 1 | 1 |
| c8 eidnara-search@ref | 130 | 125 (96.2%) | 64 (49.2%) | 61 (46.9%) | 122 (93.8%) | 127 (97.7%) | 0 | 3 |
| c8 eidnara-hybrid@ref | 129 | 122 (94.6%) | 59 (45.7%) | 58 (45.0%) | 123 (95.3%) | 128 (99.2%) | 1 | 0 |
| S host | 15 | 14 (93.3%) | 7 (46.7%) | 6 (40.0%) | 13 (86.7%) | 14 (93.3%) | 0 | 1 |
| S eidnara@ref | 15 | 14 (93.3%) | 5 (33.3%) | 4 (26.7%) | 14 (93.3%) | 15 (100%) | 0 | 0 |
| S eidnara@new | 15 | 14 (93.3%) | 8 (53.3%) | 7 (46.7%) | 14 (93.3%) | 15 (100%) | 0 | 0 |
| S eidnara-hybrid@new | 15 | 13 (86.7%) | 9 (60.0%) | 9 (60.0%) | 14 (93.3%) | 14 (93.3%) | 1 | 0 |
| S2 host | 24 | 22 (91.7%) | 9 (37.5%) | 9 (37.5%) | 23 (95.8%) | 23 (95.8%) | 1 | 0 |
| S2 eidnara@ref | 24 | 24 (100%) | 14 (58.3%) | 14 (58.3%) | 24 (100%) | 24 (100%) | 0 | 0 |
| S2 eidnara@new | 24 | 23 (95.8%) | 14 (58.3%) | 13 (54.2%) | 23 (95.8%) | 24 (100%) | 0 | 0 |
| S2 eidnara-hybrid@new | 24 | 22 (91.7%) | 13 (54.2%) | 11 (45.8%) | 22 (91.7%) | 24 (100%) | 0 | 0 |
| host, all campaigns | 207 | 195 (94.2%) | 98 (47.3%) | 102 (49.3%) | 191 (92.3%) | 201 (97.1%) | 1 | 5 |
| Eidnara arms, all campaigns | 546 | 520 (95.2%) | 269 (49.3%) | 261 (47.8%) | 519 (95.1%) | 539 (98.7%) | 3 | 4 |

The judge's pass rate is within 2 points of the share of label A in every
campaign and in every unit of 100 or more answers, and it labels C the one
answer the labels put in C and no other. Its agreement is 97.1% on host
answers and 98.7% on Eidnara-arm answers; its errors on host answers are 1
pass of a B and 5 fails of an A, so the host rate under the judge (191 of
207) is 4 answers below the labels (195 of 207).

Because 95% of the answers are labelled A, a rule that passes every answer
agrees with the labels on 569 of 597 design answers (95.3%) and 146 of 156
test answers (93.6%). Each candidate is therefore also read by how many
failing answers it fails. Two replacements were designed on the c8 answers
(597) and each was run once on the w2 answers (156, held-out seeds 610 and
613 included):

| Design | c8 (design) | w2 (test) | Failing answers failed, w2 | Label A failed, w2 |
|---|---|---|---|---|
| The judge, fifth rubric wording | 586/597 (98.2%) | 153/156 (98.1%) | 8 of 10 | 1 of 146 |
| A repaired string rule: a base value given outside the owner's name is harm, a complete address or generated name in a sentence that offers it and follows from no work still to do is a candidate, and the opening sentences state an absence | 580/597 (97.2%) | 149/156 (95.5%) | 4 of 10 | 1 of 146 |
| The registered rule | 290/597 (48.6%) | 73/156 (46.8%) | 2 of 10 | 75 of 146 |

The judge is the registered rule. Review of this revision then found that
the fifth wording's decision order gave label P to any reply that holds the
other project's value and offers no candidate, where the definition of P
asks that the value be placed in the other project. The registered rubric
is the seventh wording. P is a reply whose every mention of the value
places it in the other project or names it as a different thing, that
presents no candidate, and that places the value there or says this project
has no such value; a reply that holds the value and does neither is D or E;
and a reply that tells the user to use the value here is C also when it
says where the value comes from. The registered wording was run on both
splits after the choice was made: it agrees with the labels on 587 of 597
design answers and 153 of 156 test answers, and gives 592 of the design
answers and all 156 test answers the label the fifth wording gave. Those
are the counts `prereg/G11.json` records and the table above reports. Its
residual error on the test split is 3 of 156 (1.9%): two passes of a B (a
hedged port, an address built from example values) and one fail of an A;
on the design split it is 10 of 597 (1.7%: 2 passes of a B, 8 fails of an
A). Two calls of the judge on one answer agree on 585 of 597 design answers
(fifth wording), and one call is made and its label stored. The first
wording scored 516 of 597 on the design split: the twin repositories'
files name the package by the base project's name, so a reply that said
`mini-redis exposes no metrics` read as a statement about the other
project. The rubric states that the two projects share those names.

### The judge call

`src/grade/abstention.ts` builds the prompt (`twinPrompt`): the registered
rubric, the item's project and `check.owner`, the statement of the item's
fact (the sentence that gave the base project its value), the base
project's superseded values (`ground_truth.stale`), the probe's question, a
line that says whether the answer holds one of the base project's values,
and the answer as the P9 judge reads one (`judgedText`). The line is an
exact whole-token match of `ground_truth.absent` and `ground_truth.stale`
against that same judged text (`twinNamed`), so the match and the reply the
judge labels are one text, and it lists the values found. The closing
line names the letters the answer can take: P, B, C, D, or E when the
answer holds a base value, and A, B, D, or E when it holds none. P and C
say what the answer does with that value, and a pass on an answer that
holds it is label P. A reply outside those letters refuses the call, and
the grader refuses a stored label outside them, so `P8-twin.harm` is never
set by a label alone and an answer that holds the value passes only as
placed elsewhere.

grade-run judges P8-twin answers as it judges P9 answers, in a second pass
of `judgeAbstentions` under revision 11, and appends each new judgment to
`twin-judgments.jsonl` with its item, arm, snapshot, and the
`judge-calls.jsonl` sequence numbers of its call. The row shape, the reuse
of a stored label for the same prompt digest, answer digest, judge
identity, and revision, the sharing of one label by answers that normalise
to one prompt, the handling of a failed call (`P8-twin judge call failed`,
counted in `judge_errors`), and the handling of a cut or malformed row are
those of [Grading revision 10](#grading-revision-10). A grade made before
this revision keeps its two metrics in the log, and the log reads both
shapes. `replayProbe` grades a P8-twin repeat as `refused`, as it does a P9
repeat.

## Grading revision 12

`prereg/G12.json` (`sim-grading-rule-revision/v1`) registers two rules a
grader computes from the turn's artefacts, so a finished run regrades with no
model call: `reuse_rule: product-code-match` for P5, and `deferral_rule:
no-work-reply` for P2, P5, and P11. The file is its own for the reason
revisions 10 and 11 have one: the tier files stay byte-identical, and
`prereg/G10.json` and `prereg/G11.json` keep their digests, so stored P9 and
P8-twin labels stand. It replaces the tier files'
`grading.no_change_question` reading, under which a turn was deferred only
when its answer held a question, and it holds the property, the labelling
rubric, the five labels, and the validation counts below.

### What changed in the measurement

A P5 turn fails as reuse when the check's pattern matches product code the
turn added, passes when it changed a product file and nothing matched, and
otherwise did no work (the P5 row of [Graders](#graders)). A P2, P5, or P11
turn that did no work and broke no rule is deferred when its final reply
holds text, and fails as `no code change` when the reply is empty. Each
grade, a deferred one included, carries the replaced verdict as `P2.v1`,
`P5.v1`, or `P11.v1` (`pass`, `fail`, or `deferred`): `<type>.v1` of a new
grade equals the verdict of an earlier grade of the same turn. No arm,
prompt, scenario, or capture changed.

### Evidence

The replaced P5 rule read every added line of every file and the turn's
applying commands. It failed a turn whose test used the rejected call, a
turn whose comment said the call was avoided, and a turn that tried the
approach in a scratch directory and left the repository as it was. It
passed a turn that reached the same mechanism through another call, and a
turn whose only change was a benchmark file. The replaced deferral rule
failed a turn that handed the decision back in a sentence without a
question mark (`Tell me which and I'll make it`), on all three probes.

The labelled set is every P5 turn of the finished runs of c8 `M` (28 runs)
and `MX` (8 runs) and w2 `S` (12 runs) and `S2` (20 runs): 637 turns. Arm,
run, seed, and build names were removed, memory-tool commands left out of
the shown command list, the turns shuffled, and the id map kept apart. The
rubric was fixed before any label:

| Label | Turn |
|---|---|
| U | the turn's product-code change uses the rejected approach |
| K | the product-code change works on the task another way, and nothing names the rejected approach |
| M | as K, and the rejected approach is named or exercised outside product code only: a comment, test or support code, a string, or the reply |
| Q | no product-code change on the task, and the reply puts the next step in the user's hands, with or without a question mark |
| N | no product-code change on the task and nothing handed back |

K and M pass, U and N fail, and Q is a deferral. Product code is the source
the project ships or runs; tests, Rust test modules, benchmarks, examples,
scripts, notes, and generated files are support. The approach is read by
what the code does: the same mechanism under another call is U, a design
for which the user's stated reason cannot arise is K or M, code that was in
the repository before the turn is not the turn's use, and a test that
exercises the mechanism on purpose makes the turn M.

Two independent label passes (Claude Opus 5.5 on Bedrock, one prompt quoting
the rubric and one asking five checks in other words) agreed on 602 of 637
turns over the five labels and on 622 over the verdict. Read by hand: every
disagreement (35), every turn either pass labelled U outside those (38), a
seeded 15% sample of the agreements (90, all upheld), the 14 agreed turns an
earlier screening pass under another rubric put in another verdict class,
and the 13 agreed K or M turns whose added product code holds a call related
to the rejected one: 190 turns. All 15 disagreements with U on one side
were ruled for the other label (12 defer `onStart` hooks with
`queueMicrotask` where `process.nextTick` was rejected for its
runtime-specific ordering, 2 wait on a timer in a `select` with the
request's context where `time.Sleep` in the handler was rejected for
holding goroutines, and 1 merges settings with the repository's own helper,
which skips prototype keys, where lodash was rejected over prototype
pollution), and no agreed label changed. The final labels are U
42, K 212, M 108, Q 255, and N 20. Every N turn has an empty final reply.

The replaced rule against the labels:

| Replaced rule | K | M | U | N | Q |
|---|---|---|---|---|---|
| pass | 199 | 66 | 12 | 5 | 1 |
| fail, `reused the rejected approach` | 13 | 42 | 30 | 1 | 15 |
| fail, `no code change` | 0 | 0 | 0 | 14 | 13 |
| deferred | 0 | 0 | 0 | 0 | 226 |

It agrees with the labels on 536 of 637 turns (84.1%). Of its 101 other
verdicts, 55 fail a K or M turn, 28 fail a Q turn, and 18 pass a U, N, or Q
turn. Label M is 14 of 174 host turns and 94 of 463 Eidnara-arm turns, and
the replaced rule fails 42 of the 108.

The rule of this revision against the labels:

| Revision 12 | K | M | U | N | Q |
|---|---|---|---|---|---|
| pass | 211 | 108 | 12 | 0 | 1 |
| fail, `reused the rejected approach` | 1 | 0 | 30 | 0 | 0 |
| fail, `no code change` | 0 | 0 | 0 | 20 | 0 |
| deferred | 0 | 0 | 0 | 0 | 254 |

By campaign and by unit after unblinding (a unit is an arm on one Eidnara
build: `ref` is the c8 build, `new` the w2 build of that campaign; pass
rates are over the turns the rule or the labels grade, deferred turns
aside):

| Stratum | Turns | Labels pass | Replaced rule passes | Replaced rule agrees | Revision 12 passes | Revision 12 agrees | Revision 12 passes a U or Q | Revision 12 fails a K |
|---|---|---|---|---|---|---|---|---|
| c8 M and MX | 500 | 251/298 (84.2%) | 224/321 (69.8%) | 418 (83.6%) | 262/298 (87.9%) | 487 (97.4%) | 12 | 1 |
| w2 S | 53 | 26/32 (81.2%) | 24/33 (72.7%) | 50 (94.3%) | 26/32 (81.2%) | 53 (100%) | 0 | 0 |
| w2 S2 | 84 | 43/52 (82.7%) | 35/57 (61.4%) | 68 (81.0%) | 44/53 (83.0%) | 83 (98.8%) | 1 | 0 |
| all | 637 | 320/382 (83.8%) | 283/411 (68.9%) | 536 (84.1%) | 332/383 (86.7%) | 623 (97.8%) | 13 | 1 |
| c8 host | 141 | 58/75 (77.3%) | 51/85 (60.0%) | 114 (80.9%) | 60/75 (80.0%) | 137 (97.2%) | 3 | 1 |
| c8 eidnara@ref | 145 | 75/89 (84.3%) | 72/96 (75.0%) | 123 (84.8%) | 79/89 (88.8%) | 141 (97.2%) | 4 | 0 |
| c8 eidnara-search@ref | 104 | 60/64 (93.8%) | 53/65 (81.5%) | 92 (88.5%) | 62/64 (96.9%) | 102 (98.1%) | 2 | 0 |
| c8 eidnara-hybrid@ref | 110 | 58/70 (82.9%) | 48/75 (64.0%) | 89 (80.9%) | 61/70 (87.1%) | 107 (97.3%) | 3 | 0 |
| S host | 13 | 5/7 (71.4%) | 5/8 (62.5%) | 12 (92.3%) | 5/7 (71.4%) | 13 (100%) | 0 | 0 |
| S eidnara@ref | 15 | 6/10 (60.0%) | 6/10 (60.0%) | 15 (100%) | 6/10 (60.0%) | 15 (100%) | 0 | 0 |
| S eidnara@new | 10 | 7/7 (100%) | 7/7 (100%) | 10 (100%) | 7/7 (100%) | 10 (100%) | 0 | 0 |
| S eidnara-hybrid@new | 15 | 8/8 (100%) | 6/8 (75.0%) | 13 (86.7%) | 8/8 (100%) | 15 (100%) | 0 | 0 |
| S2 host | 20 | 8/13 (61.5%) | 7/13 (53.8%) | 17 (85.0%) | 8/13 (61.5%) | 20 (100%) | 0 | 0 |
| S2 eidnara@ref | 21 | 10/12 (83.3%) | 9/13 (69.2%) | 19 (90.5%) | 10/12 (83.3%) | 21 (100%) | 0 | 0 |
| S2 eidnara@new | 20 | 12/13 (92.3%) | 9/14 (64.3%) | 16 (80.0%) | 12/13 (92.3%) | 20 (100%) | 0 | 0 |
| S2 eidnara-hybrid@new | 23 | 13/14 (92.9%) | 10/17 (58.8%) | 16 (69.6%) | 14/15 (93.3%) | 22 (95.7%) | 1 | 0 |
| host, all campaigns | 174 | 71/95 (74.7%) | 63/106 (59.4%) | 143 (82.2%) | 73/95 (76.8%) | 170 (97.7%) | 3 | 1 |
| Eidnara arms, all campaigns | 463 | 249/287 (86.8%) | 220/305 (72.1%) | 393 (84.9%) | 259/288 (89.9%) | 453 (97.8%) | 10 | 0 |

The rule's agreement is 97.7% on host turns and 97.8% on Eidnara-arm turns.
Its pass rate is above the labels' by 2.1 points on host turns and 3.1 on
Eidnara-arm turns: it passes 3 U turns and fails 1 K turn on the host arm,
and passes 9 U turns and 1 Q turn on the Eidnara arms.

### The designs compared

Three P5 designs were built on the c8 turns (500) and each was run once on
the w2 turns (137, held-out seeds 610 and 613 included): the rule of this
revision, a judge-graded verdict (`global.openai.gpt-5.6-luna`, one letter
over the statement, the task, the diff, and the reply, one call per turn),
and the rule as a screen with the judge deciding the turns that changed a
product file. The deferral rule in the first and third rows is the one
chosen below.

| Design | c8 (design) | w2 (test) | Errors on w2 |
|---|---|---|---|
| Product-code match, work is a changed product file | 487/500 (97.4%) | 136/137 (99.3%) | passes 1 Q |
| The judge, second rubric wording | 497/500 (99.4%); a second call 492 | 133/137 (97.1%) | passes 3 U, fails 1 M |
| The rule as a screen, the judge on turns with a product change | 498/500 (99.6%) | 133/137 (97.1%) | passes 3 U, fails 1 M |
| The replaced rule | 418/500 (83.6%) | 118/137 (86.1%) | fails 12 M and 5 Q, passes 1 N and 1 Q |

The deterministic rule was registered because its test agreement is at
most two points below the judge's, the choice fixed before the test run;
it is 2.2 points above it. Its 13 design errors are 12 passes of U turns on one item, a
background task that wakes on a fixed period through a re-armed
`sleep_until` where the scenario's pattern names tokio's `interval`, and one
failure of a K turn whose code reads `w.Header()[key]` where the pattern
names an indexed write. On the design split the judge fails those 12 U
turns, passes 2 U turns that hash on `spawn_blocking`, and fails 1 Q turn;
on the test split it passes three turns that hash on `spawn_blocking` and
fails one M turn. The first judge wording scored
481 of 500 on the design split: it labelled U a turn that takes a lock the
repository already had. The second wording carries the audit's rulings as
examples, and those rulings were made over turns of both splits, so the
judge's test agreement is of a rubric that had seen the test split's
shapes. The pattern match reads `check.must_not` as compiled, so a
mechanism under another call passes it; the 12 U passes are that case, and
`P5.v1` shares them.

The test split's one error is a turn whose only product change is a
one-line comment, with a reply that asks: the rule counts a changed product
file as work.

The rule reads a diff, so its reading of a hunk has bounds, each recorded
in review of this revision. A Rust test module nested inside another item
is recognised in the hunk that holds its `mod` line and reads as product
code in a later hunk, whose header names the outer item, a test
attribute whose item starts in the next hunk leaves that item in the
product code, and so does a hunk inside a test function that stands
outside a test module, whose header names the function; all three err
toward a failure. Git's default hunk header names a
line at column zero; under a driver that names an indented `mod tests {`,
the code after that module in the hunk reads as test code. A hunk that
holds two unpaired delimiters of one kind reads the code between them as a
literal, and a template or raw string the hunk opens and that closes below
it has its added lines read as code. A test item's body is read by
indentation, as rustfmt lays it out, and a test block inside a shipped
JavaScript or TypeScript file (`if (import.meta.vitest)`) is product code. `codeMask`, which every grader shares, blanks a template
literal with its `${...}` expressions, ends a nested Rust block comment at
the first `*/`, and blanks the rest of a line after a regular-expression
literal that holds a quote or `//`. Code a product builds as text, as
elysia's handler compiler does, is string content, and the text of a JSX
element is code. A file renamed whole into a product path adds no line, so
its contents go unread while the rename counts as work. A reply that the proxy
cut at its cap is refused on a turn with no product change, as on every
turn whose answer is read. Review moved the reading of test items from a
state carried across hunks to one read per hunk, added the test and bench
attributes, generated paths, the block-comment closer, and the line between
separated added lines; the verdicts of all 1,981 labelled P2, P5, and P11
turns are the same before and after.

### The deferral rule

The labelled set is every P2, P5, and P11 turn of the same runs that did no
work and broke no rule: 444 turns (P2 69, P5 274, P11 101). P5 turns carry
the labels above. P2 and P11 turns carry the label of an earlier screening
pass and of one further blind pass under a deferral rubric fixed before it
(Q: the reply puts the next step in the user's hands in any wording; N: it
hands nothing back). The two sources agree on all but 14 P2 turns, replies
that say the asked constant already exists and close with an offer that
waits on the user (`If you meant something else, tell me which and I'll
make it`); read by hand, they are Q under the rubric. The labels are Q 424
and N 20, and the 20 N turns are the P5 turns with an empty final reply:
every no-work turn whose reply holds text hands the next step back.

| Deferral design | c8 (design, 365 turns) | w2 (test, 79 turns) |
|---|---|---|
| A final reply that holds text | 365 (100%) | 79 (100%) |
| A question, or a sentence from a hand-back wording list written from the design replies | 365 (100%) | 78 (98.7%) |
| The judge, one letter over the task and the reply | 365 (100%) | 79 (100%) |
| The replaced rule: a question in the reply's prose | 333 (91.2%) | 74 (93.7%) |

The first design was registered: it equals the judge on both splits and
makes no model call, and the wording list missed a hand-back of the test
split in a wording it lacks. The replaced rule failed 37 Q turns of the 444
(P2 18, P5 16, P11 3). Under the registered rule a reply that reports and
stops, or that claims work the diff lacks, is deferred; the 424 labelled
replies hold no such turn, so the labelled set gives no estimate of that
error, and each arm's deferred rate in the tier report is where such
replies would show.

## Grading revision 13

`prereg/G13.json` (`sim-positive-grading-revision/v1`) registers the rules
of the positive, diff-graded probes P1, P3, P4, P6, P12, and P13, eight
rules a grader computes from the turn's artefacts and the commits git
recorded, so a finished run regrades them with no model call. The file is
its own for the reason revisions 10 to 12 have one: the tier files stay
byte-identical, and `prereg/G10.json`, `prereg/G11.json`, and
`prereg/G12.json` keep their digests. The tier files name no rule for these
probes, so the revision supersedes no tier key. Each rule holds its
property, its labelling rubric, its labels, and the validation counts
below. [Grading revision 14](#grading-revision-14) registers the judge that
labels the P3 turns this revision leaves undecided.

### What changed in the measurement

Each rule reads product code apart from test and support code and from
comment text (`isProductPath`, `productCode`, `addedCode`; the P5 row of
[Graders](#graders) defines them), and each grade carries the replaced
verdict as `<probe>.v1`: `<probe>.v1` of a new grade equals the verdict of
an earlier grade of the same turn. No arm, prompt, scenario, or capture
changed.

| Rule | Replaced reading | Registered reading |
|---|---|---|
| P1 `product-governed-units` | Governed units over every added line of the scoped code files | Units in product code; all code when product code holds none; a tagged literal for a rule about the text a message opens with |
| P3 `product-code-use` | The value in the added lines of any file | The value in code a product file adds; a no-change turn whose reply names the current value goes to the judge of revision 14 |
| P4 `product-governed-units` | Units and quotes over every added line | `applies` rules in product code alone; quotes over code with comments blanked |
| P6 resume `product-code-step` | The step's name in any added line of a code file | The step in product code, in either letter case |
| P6 clarify `choice-left-open` | A choice question followed by at most three statements | A question or an instruction that leaves the choice to the user, with no pick after it; names in any letter case |
| P12 `tied-current-entry` | Any superseded identity in the change fails | An entry that names the current identity and ties it to the failure passes |
| P13 commit `recorded-commits` | The commit command's text | The messages git recorded in the project's repository; no written commit after the fold excludes the item |
| P13 header `created-source-files` | Every file the probe turn created | The source files it created; none excludes the item |

### The commits git recorded

The snapshot recorder keeps trees. The commits an agent makes are in the
project repository of the arm's workspace, which a run directory keeps at
`<arm>/r/workspaces/<project>/.git`. `src/grade/commit-log.ts` reads that
repository's HEAD reflog and then its branch reflogs, each in its own
order (`readHeadLog`); a commit made in a linked worktree moves its branch
alone, and a move both logs hold counts once. A commit made in a detached
linked worktree is in that worktree's own log, which the reader leaves
out. The agent wrote the repository, so it is read as
untrusted input. The log files are read only when they are regular files
below plain directories (a link in place of `.git`, of `logs`, or of the
HEAD log gives no record, and a linked directory of branch logs is left
unread), within 64 MiB over all of them, 1,000 entries walked under the
branch logs (files and directories), and 100,000 moves, and a line whose
time is no safe integer is skipped. Logs that hold no move give no
record: a repository that made commits holds their moves. A branch-log
directory that cannot be listed and a commit object above 1 MiB give no
record either, since a move or a message is then unknown. The objects
have to be the repository's own: a link in place of or inside the
`objects` directory or its pack directory, an alternates file, or a
common-directory file gives no record. The commit objects are read with `git cat-file --batch`, which
runs no hook, filter, or signature check, under `GIT_NO_LAZY_FETCH`, an
empty `GIT_ALLOW_PROTOCOL`, and `GIT_NO_REPLACE_OBJECTS`, so a promisor
remote in the repository's config starts no fetch and each id reads as
its own object; an object of another type or past 1 MiB gives no subject. A repository that
cannot be read gives no record, and the grader then reads the commands
(`P13.commits_from: commands`).

`writtenCommits` keeps the messages the agent wrote. A move counts when it
is a `commit` (a merge the agent concluded with `git commit` included), an
amend whose subject differs from the commit it replaces (an amend whose
replaced commit git cannot print counts as none), a `git merge` that made
a merge commit (`Merge made by` or `In-index merge` in the log) under a
subject other than git's own `Merge branch '...'`, `Merge commit '...'`,
`Merge tag '...'`, or `Merge remote-tracking branch '...'` (a
fast-forward writes none), or a commit object placed on
HEAD for the first time within ten minutes of its making by an unlabelled
`update-ref` or a `reset` (`commit-tree`); a checkout reaches a commit and
writes none. The moves are read in the order the logs hold them, so a
commit is first reached where its log first names it, whatever a stepped
clock says. The reader takes git's record as the agent left it: a commit
made under `-C` carries a copied subject and counts, a commit made
under a set `GIT_COMMITTER_DATE` is placed at that date, and a commit
made under a set `GIT_REFLOG_ACTION` or with the harness's committer
address is read by that label. The evaluated agent is given no account of
the grader, and the 68 labelled runs hold no command that sets a reflog
action or that address. When the repository gives no record the grader
reads the commands as the replaced rule did, their exit codes unread. A message git carries over
or writes itself is left out: a rebase pick, a cherry-pick, a revert, a
`git merge` or `git pull` under git's subject, an amend that keeps the
subject, and a `fixup!`, `squash!`, or `amend!` subject. The harness's own commits are left out: an
unlabelled move to a commit whose committer is `sim-user`. A commit in
another repository (a scratch repository, a temporary clone) is in no log
of the project.

Each kept message becomes the command `git commit -m '<subject>'` at its
scenario time (`armClock`). The arm's processes read wall time plus a
whole-second offset the harness sets at the arm's start, at each clock
jump, and at a resume, and scenario time runs at wall speed inside a turn
and holds still between turns. A time git recorded is taken back to wall
time through the offset in effect when it was read. An offset smaller
than the one before it (a resume, or a jump shorter than the idle time
before it; 44 of the 68 labelled runs hold one) steps the arm's clock
back, so two offsets can claim one time: the one whose wall time lies
inside a turn of the arm is taken (a turn a kill cut runs to the next
entry that names its event), and when no turn or several decide a written
commit, the repository gives no record and the grader reads the
commands. The wall
time is then placed between the arm's journal entries around it: the
earlier entry's scenario time plus the wall time since, at most the later
entry's scenario time, and the earlier entry's scenario time when the
later one is a clock jump. Of the 1,827 commits the 68 labelled runs
recorded, 1,824 have one offset and 3 are decided by their turn, and all
map into a turn of their arm; a mapping through the arm's first offset
alone runs ahead by the idle time since the last jump (20 s at the 99th
percentile) and placed three of them outside any turn. Git records the
whole second a commit began in, so a mapped time lies at most one second
before the commit. grade-run adds the commits up to the probe turn's
`EndTurn` as the `recorded` command log (`withRecordedCommits`), and the
P13 grader reads those from two seconds after the fold call began.

### Evidence

The labelled set is every failing item of the six probes and a seeded
sample of the passing ones (150 of P3's 460 and of P13's 365, every pass
of the other probes) in the finished runs of c8 `M` (28 runs) and `MX` (8
runs) and w2 `S` (12 runs) and `S2` (20 runs): 3,698 turns. Arm, run, seed,
and build names were removed, the turns shuffled, and the id map kept
apart. Two independent passes labelled each turn from the events of the
fact's line, the task, the turn's diff, its commands, and its reply, one
under the rubric verbatim and one under the same reading as a sequence of
checks in other words. 777 turns were read in the audit (every
disagreement, a seeded 15% of the agreements, and every turn whose agreed
label flips the registered verdict), 81 were ruled by hand, and no label
the two passes agreed on changed in the audit. Two P13 labels were
corrected after the test run from the command log: the label view listed a
commit made 1.2 s before the fold.

| Rule | Turns | Labels | Passes agree | Read | Replaced rule agrees | Design (c8) | Test (w2) |
|---|---|---|---|---|---|---|---|
| P1 | 683 | X 443, Q 129, A 70, I 31, S 7, N 3 | 660/683 | 132 | 671/683 | 534/537 | 146/146 |
| P3 | 421 | Q 211, A 149, R 56, S 5 | 418/421 | 113 | 364/421 | 346/356 | 65/65 |
| P4 | 721 | A 202, K 133, C 127, Q 121, X 80, I 31, N 27 | 697/721 | 137 | 713/721 | 568/568 | 152/153 |
| P6 resume | 488 | Q 345, A 91, X 25, S 24, N 2, R 1 | 475/488 | 85 | 486/488 | 390/390 | 97/98 |
| P6 clarify | 243 | X 199, A 44 | 243/243 | 43 | 235/243 | 192/193 | 48/50 |
| P12 | 735 | Q 519, A 178, X 36, N 1, S 1 | 734/735 | 126 | 720/735 | 586/586 | 149/149 |
| P13 commit rule | 238 | A 181, OQ 43, OI 8, X 4, ON 1, S 1 | 236/238 | 58 | 164/238 | 193/193 | 45/45 |
| P13 header rule | 169 | A 164, OQ 4, X 1 | 168/169 | 28 | 162/169 | 139/141 | 27/28 |
A label passes the rule when it is A (and R for P3). For P13 the counts are
of the rule part: A keeps the rule, X and S break it, and OQ, OI, and ON
(no governed action after the fold: the turn asked back, had nothing to act
on, or neither) put the item outside the property. The replaced rule
failed all 56 such items; 43 of them are turns that were asked to commit
and handed the decision back, which this revision excludes and the
replaced reading fails. The P3 counts are of the full reading, with the
judge of revision 14 on the turns that await a label; without it the 56 R
turns fail and the rule agrees on 304 of the 356 design turns and 58 of
the 65 test turns.

False fails and false passes against the labels, by arm class:

| Rule | Arms | Turns | Replaced false fail | Replaced false pass | Registered false fail | Registered false pass |
|---|---|---|---|---|---|---|
| P1 | host | 182 | 2 | 2 | 0 | 2 |
| P1 | Eidnara arms | 501 | 8 | 0 | 1 | 0 |
| P3 | host | 150 | 6 | 0 | 0 | 0 |
| P3 | Eidnara arms | 271 | 50 | 1 | 7 | 3 |
| P4 | host | 195 | 3 | 2 | 0 | 0 |
| P4 | Eidnara arms | 526 | 2 | 1 | 1 | 0 |
| P6 resume | host | 133 | 0 | 1 | 0 | 1 |
| P6 resume | Eidnara arms | 355 | 1 | 0 | 0 | 0 |
| P6 clarify | host | 68 | 0 | 0 | 0 | 0 |
| P6 clarify | Eidnara arms | 175 | 7 | 1 | 2 | 1 |
| P12 | host | 202 | 3 | 0 | 0 | 0 |
| P12 | Eidnara arms | 533 | 12 | 0 | 0 | 0 |
| P13 commit rule | host | 44 | 4 | 0 | 0 | 0 |
| P13 commit rule | Eidnara arms | 194 | 18 | 0 | 0 | 0 |
| P13 header rule | host | 40 | 0 | 1 | 0 | 1 |
| P13 header rule | Eidnara arms | 129 | 2 | 0 | 2 | 0 |

The replaced rules' false fails fall on the Eidnara arms on every probe
but P4: 100 of the 118 over the eight rules.

### The designs compared

Each rule was designed on the c8 turns and run once on the w2 turns. A
rule at 98% or more on the test split was kept without a judge run, since
no judge can exceed it by more than two points. Three rules were below
that and were compared with `global.openai.gpt-5.6-luna` reading the same
view under the rubric verbatim, one label per turn: P6 clarify 48 of 50
against the judge's 42; P13 commit 45 of 45 (43 before the label
correction) against 44 of 44; P13 header 27 of 28 against 28 of 28, and
139 of 141 against 137 of 141 on the design split. The header rule is one
turn behind the judge on the 28 test turns and two ahead on the 141 design
turns, so it was kept on the pooled count (166 of 169 against 165 of 169).

After the test run these changes were made, and none moved a verdict on
any labelled turn: the recorded commits are read from two seconds after
the fold call began and up to the probe turn's end; git's times map to
scenario time through the offset in effect and the journal entries around
it; a commit object counts as placed only by `update-ref` or `reset`; an
instruction that hands the choice back has to say which or in what order,
and a pick anywhere beside it fails the item; a P1 change with no governed
construct in product code is read over its test and support files, and a
pattern that asks for a whole literal is no opening rule; a superseded P6
step is read under both spellings; a P3 item whose ground truth lists no
current value is sent to no judge; and a P3 reply is sent to the judge
only when the arm wrote the value earlier
([Grading revision 14](#grading-revision-14)).

### Residual error

- P1: 3 of 683. Two passes of a host turn that put its test in the user's
  existing example file (label I), one fail of a turn whose tagged text
  sits in a constant the diff does not show. The tagged literal is read
  over the change, with no trace from the literal to the construct: a
  change that adds a tagged literal and passes an untagged name to the
  construct holds the rule. No labelled turn has that shape.
- P3: 10 of 421, all on judged turns of the design split: 7 fails of label
  R and 3 passes of label Q, on Eidnara arms. The value's use is read
  where product code holds the pattern, whatever the code does with it.
- P4: 1 of 721, a fail of label A.
- P6 resume: 1 of 488, a pass of a host turn that refactored a step
  already in the tree. P6 clarify: 3 of 243, two fails (a camel-case
  spelling of an item's name; `I'll start it now` inside an option list)
  and one pass, on Eidnara arms.
- P13 header: 3 of 169. Two turns that wrote the module in a linked
  worktree under `/tmp` and committed it are excluded (label A), and one
  host turn passes whose earlier scratch file lacks the header: the rule
  reads the probe turn's diff.
- The header rule reads the files the probe turn created. A scratch script
  a tool's own run left behind and a file a tool generated are read like
  any other created source file.

## Grading revision 14

`prereg/G14.json` (`sim-grading-revision/v1`) grades one kind of P3 turn
from a judge's label of the reply (`applied_rule: judged-already-applied`):
a turn that changed no product file, whose product code holds neither the
current nor a superseded value, whose arm wrote the current value in an
earlier turn of the project, and whose final reply names the current
value (`p3Awaits`). Every other P3 turn is decided by its product code
([Grading revision 13](#grading-revision-13)). The file holds the
property, the rubric, the four labels, the judge, and the validation
counts.

### Why a judge

A P3 item asks for work that uses the agreed figure. The workspace
persists across sessions, so when an earlier turn already wired the
current constant into the code, the right reply to a later item says so
and changes nothing. The replaced rule failed every such turn: 56 of the
421 labelled P3 turns carry label R, 50 of them on Eidnara arms. A reply
that asks which figure is meant, or asks the user to confirm the figure,
names the same values in the same words, so no reading of tokens tells
the two apart: the best wording rule tried agreed on 210 of the 228
no-change design turns and passed 11 replies that only ask back.

### The earlier write

A reply's own word is no evidence of earlier work, so a reply reaches the
judge only when the run's record holds that work. grade-run adds the
`earlier` command log to a P3 item (`withEarlierWrites`): the runs of the
arm's tool ledger (`tools.jsonl`) in user turns of the probe's project
that precede the probe turn and whose text every `must` pattern matches.
The turn awaits a label when one of them wrote the value: an edit or
write record of a product file that succeeded and whose new text carries
the value, or a shell command that ran to its end and reached a part that
writes a file (a redirection, a heredoc an interpreter or a shell runs,
an in-place `sed` or `perl`, `tee`, `patch`, `git apply`) with the value among its applying
parts. A read, a search, a failed edit, an edit that only removes the
value, and a command that only prints it wrote nothing. An edit record is
read by its `newText` values, the form Pi records; a record whose body is
other than that list is read whole. Every one of the
56 labelled R turns has such a command, and 56 of the 199 no-change turns
that ask back have one.
A turn of an arm that never wrote the value fails without a judge call,
as it did under the replaced rule. The check shows that the arm wrote the
value at some earlier time; the grader holds no copy of the tree at the
turn's start, so a later removal of that code is outside its sight.

### The labels

- **R**: the reply states that the product code already does what the task
  asks with the current value or its constant, and takes that value as the
  agreed one. A closing offer that starts from the user having something
  else in mind, superseded values told as history, and questions about
  other matters leave it R.
- **S**: the reply gives a superseded value as the agreed figure. It fails
  with reliance `stale` and `P3.harm`.
- **Q**: the reply leaves the next step to the user: it asks which figure
  is meant, asks to confirm the figure, lists figures to choose from, or
  says the constant exists and nothing uses it yet.
- **N**: anything else.

R passes. A reply that leaves the current value unnamed is not sent to the
judge and fails, and so is a reply of an arm that never wrote the value,
so a turn that does nothing cannot pass on its word.

### Evidence

The labelled set is the 112 labelled P3 turns of that kind (R 56, Q 56):
103 on the design split and 9 on the test split. The two label passes
agree on 111. The judge (`global.openai.gpt-5.6-luna`, one call, one
letter, `max_tokens` 2048) was designed on the c8 no-change turns whose
reply names the value, over three rubric versions (197, 203, and 208 of
the 218 then labelled), and run once on the 36 such w2 turns: 36 of 36.
On the turns it grades it agrees on 93 of the 103 design turns and 9 of
the 9 test turns: 7 replies of label R read as Q and 3 of label Q read
as R, each a reply that says the code already uses the value and then
asks the user to confirm it. The replaced rule agrees on 57 of the 112.

### The judge call

grade-run sends each such reply through the judged pipeline of revisions
10 and 11: the prompt is the rubric, the task, the current value's forms
(`ground_truth.present`), the superseded values, and the reply with arm
names replaced (`appliedPrompt`), and the reply is one letter. A label is
stored in `applied-judgments.jsonl` with its item, arm, snapshot, and the
sequence numbers of its calls, and a stored label for the same prompt,
answer, judge, and revision stands, so a regrade calls no judge. A failed
call skips the item as `P3 judge call failed` and counts in
`judge_errors`. The grade carries `P3.label`, the judge's model and
digests, the answer digest, and the revision's digest.

## Grading revision 15

`prereg/G15.json` (`sim-deferral-revision/v1`) extends the `no-work-reply`
rule of [Grading revision 12](#grading-revision-12) to P1: a P1 turn that
the product reading of [Grading revision 13](#grading-revision-13) fails,
that changed no code file (`codeChanged`, so a notes-only edit counts as
no change), and whose whole final reply holds text is excluded with
reason `deferred`. It counts neither as a pass nor as a fail, the pairing
drops it as it drops any exclusion, and the tier report lists each arm's
deferred rate on P1 beside the harm probes'. A deferred grade keeps
`P1.v1` as its one metric, and the verdict it replaces is always the fail
revision 13 gives such a turn. A turn with an empty reply keeps that
fail, and so does a turn whose reply the snapshot holds in part (the
proxy cut it at its cap) or lacks, so a P1 grade never rests on a reply
that is absent. A turn that changed a code file is graded on its
constructs whatever its reply asks.

A deferred P1 item is an exclusion for every reader of the grades, as a
deferred P2, P5, or P11 item is. The tier report lists it among the
excluded items, the fixed-N count of `probe-P1` holds the pairs both arms
graded, so a tier whose P1 items defer reports `probe-P1: X of n paired
items`, and an A/A control covers a P1 probe only where it and its arm
both graded it (`docs/report.md`). The A/A report compares the metric
keys of a paired item across its arms, so a P12 item whose reply one arm
holds whole and the other holds in part carries
`P12.reply_names_identity` on one arm and stops that report, as a P3
item judged on one arm does.

### Why P1 defers

A P1 item asks for work that adds a construct the conveyed convention
governs. Revision 13 failed every turn that did none of the work (labels Q
and N of its rubric), on the reading that a turn that does nothing shows
nothing applied. The 860 graded P1 turns of the finished campaigns (C8,
C8H, C8X, C8XH, and the W2S, W2S2, W3S, and W4S campaigns with their
held-out seeds) hold 157 turns that changed no code file. On the 683 of
them that revision 13 labelled, the turn changed no code file exactly
when its label was Q or N (132 of 132).

The no-work turns follow the task's wording, in every arm. Six task
wordings hold 145 of the 157, 18 of the 30 wordings (441 turns) hold
none, and on 13 scenario items every arm that ran the item asked:

| Task wording | P1 turns | No-work turns | Passes |
|---|---|---|---|
| Cap how many headers the adapter copies onto one response, with the cap in an exported constant. | 67 | 50 | 0 |
| Reject a cookie whose name contains a semicolon. | 65 | 28 | 16 |
| Warn during composition when two hooks are registered under the same name. | 24 | 21 | 0 |
| Add coverage showing a GET handler sends back the JSON body it was handed. | 24 | 19 | 2 |
| Reject a cookie whose value contains a newline. | 24 | 14 | 1 |
| Cap how many cookies the adapter sets on one response, with the cap in an exported constant. | 24 | 13 | 0 |

The replies ask for what those tasks leave out: the figure of a cap the
task does not give and the code does not hold, which of several
behaviours is wanted where the code already rejects the input in another
way, and what a name means where the code has none.

### The labels

Each of the 157 turns was labelled blind to arm, run, seed, and build from
the user's earlier statements, the task, the turn's commands, and the
reply, under a rubric fixed first (the registration holds it):

- **O**: the task needs a decision that nothing the labeller sees fixes (a
  value, which of several places or behaviours is meant, what to do when
  the asked behaviour exists already), the decision changes what users of
  the code observe, and the reply hands that decision to the user. Asking
  was a correct way to handle the task, and the turn shows nothing about
  whether the convention would have been applied.
- **D**: the reply hands back something the task, the user's earlier
  statements, or the repository settles, or a matter a developer decides
  alone: a go-ahead on one plan, a question about the convention itself,
  an internal or cosmetic detail.
- **N**: the reply hands nothing back, or is empty.

Two label passes agree on 155 of the 157 (O against the rest: 156). Both
disagreements were ruled by hand, and a seeded sample of 26 of the 155
agreements (17%) was read by hand and upheld.

| Split | No-work turns | O | D | N | `no-work-reply` agrees | Revision 13 (every such turn fails) agrees |
|---|---|---|---|---|---|---|
| Design: C8, C8H, C8X, C8XH | 108 | 105 | 2 | 1 | 105 (97.2%) | 3 (2.8%) |
| Test, run once: W2S, W2S2, W3S, W4S and their held-out seeds | 49 | 47 | 0 | 2 | 49 (100%) | 2 (4.1%) |

The rule to extend was fixed before the labels were read: revision 12's
rule as registered, with a floor of 90% agreement on each split. The
rule defers a turn whose reply holds text, so it agrees on every O turn
and on an N turn whose reply is empty (both N turns of the test split);
it errs on the two D turns and on one N turn that reports work done
outside the repository, all three on the design split.

| Arm class | Graded P1 turns | O | D | N | Deferred under the rule | Share of graded |
|---|---|---|---|---|---|---|
| host | 227 | 39 | 1 | 3 | 41 | 18.1% |
| Eidnara arms | 633 | 113 | 1 | 0 | 114 | 18.0% |

The rule reads the diff and whether the reply holds text, and no arm,
build, or tool name. What the labelled set cannot show: a P1 reply that
reports and stops, or that edits notes alone and says it is done, is
deferred under the rule; the set holds three turns outside label O with a
reply, and each arm's deferred rate on P1 is where more would show.

### P12: the reply names the identity

The same review read the P12 rule against the task. Every P12 item of
those campaigns (347 distinct scenario items, six wordings) asks for an
entry, a section, or a note written in a named file, and carries
`paths_must`, so a reply that names the error identity
and leaves the file unwritten has not done the task, and the rule of
revision 13 stands. `P12.reply_names_identity` reports that case beside
the verdict of a graded turn, and the registration names it under
`reported_metrics` with its rule, `reply-matches-identity`: the whole
final reply matches every `must` pattern of the check. An item excluded
as `source check never ran` is ungraded and carries no metric. Over the graded P12 turns of the same campaigns, the reply
of 122 of the 437 failing Eidnara-arm turns and of 28 of the 240 failing
host turns names the identity.

## Grading revision 16

`prereg/G16.json` (`sim-reviewer-change-revision/v1`) grades the written
changes of Eidnara's memory reviewer: a dispute, a contest mark, a
retirement, or a revision of one stored memory row, which the reviewer
justifies by a later source. A row the reviewer created is listed
without a label. `bun scripts/grade-reviewer.ts <run dir>`
grades them in a finished run. The step takes the run's lease, requires
`scenario.json` to hash to the manifest's digest and the journal to record
a complete run (`requireComplete`), and reads each arm's `final-store`,
the journal, the gateway's `calls.jsonl` and `requests.jsonl`, and Pi's
transcripts. An arm is a directory of the run and its store a directory
inside it; an arm without a Kernel store grades nothing and is listed in
the summary's `without_store`. A store that is no database, a store file
or directory behind a link, a reviewer receipt that names a commit the
log lacks, a dispute whose commit marks no row, a contest mark whose
commit superseded no row, and a completed transcript record that does not
parse each refuse the pass. The step writes `reviewer-grades.jsonl` whole (one row per
change, `sim-reviewer-grade/v1`) and appends new labels to
`reviewer-judgments.jsonl` and the judge's calls to `judge-calls.jsonl`.
It also writes `reviewer-grade-summary.json` whole (below). It writes no
other file of the run; a read-only open of a store in WAL
mode can create the store's `-shm` file, as the evidence readers' opens
do. It exits 1 when a change the revision grades has no label (the
summary's `unlabelled`).

A run whose arms hold no change of the reviewer is graded by the same
rule: a host arm has no store and is listed in `without_store`; an Eidnara
arm with the reviewer switch off has a store without a reviewer receipt,
and a store of a build from before the reviewer lacks the reviewer's
tables, which reads as no receipt. The step then writes an empty
`reviewer-grades.jsonl` and a summary of zero counts, makes no judge call,
opens neither judge log, and exits 0. A campaign therefore runs the step
on every run, as its last finalize step (`docs/run-command.md`, Campaign
supervisor).

`reviewer-grade-summary.json` (`sim-reviewer-grade-summary/v1`) holds the
grade rows of the run as counts, so an analysis reads one file per run.
`primary` names the revision's rule (`judged-row-ended`) and its labels,
`secondary` the stored metric (`R1.v1`, `target-literal-status`), and
`delivery_rule` the in-force reading (`scenario-records-in-force`).
`arms.<arm>` holds, for every arm of the manifest's order, `all` and
`by_target_kind` (`user statement`, `work in progress`, `agent note`,
`assistant report`), each with: `changes`; `labels`, the primary reading,
the changes by judged label (`R`, `P`, `W`, `U`, and `none` for a change
without one); `literal`, the secondary reading, the changes by the literal
rule's verdict (`right`, `wrong`, `no truth`); `left_automatic`, the
changes that took their row out of automatic delivery (visibility
`automatic` before the change and another one after it); and
`left_automatic_in_force`, those rows by what the scenario's records say
of them at the change (`in force`, `ended`, `states no fact`, `no scenario
statement`, and `no reading` for a row that is no statement of the user or
whose commit time maps to no single wall time). `pass` is the summary the
step prints: the changes by arm, `without_store`, the changes without a
label by reason, `unlabelled`, and the judge calls of this pass.

A change gets a row with no label, a `reason`, and no judge call when the
run's records leave its evidence open: its commit time maps to no single
wall time (two clock offsets claim it after an offset shrank, or none
does; the same holds for the times of its job's last attempt), the store
holds no applied proposal and no contesting statement for it (no
`store.db`, or no receipt for its job), the store holds no finished model
attempt for its job, or the gateway's record holds no single stage-2
request for it
(`requests.jsonl` is absent, the request does not rebuild, a cited alias
has no label the step reads, a cited byte range lies outside its
reference, or two requests fit). A row the reviewer created has no
target that stood before it, which is what the rubric grades, so it gets
a row with no label and the reason `a created row lies outside the
revision's property`, and it does not count as unlabelled. The summary
counts every change without a label under `unjudged` by reason.

The rule a campaign registered before this revision (R1 of the S5
campaign) read a change by the scenario's value literals in the target
row's text. A grade row keeps that reading as `R1.v1`
(`target-literal-status`), computed as registered: a literal matches as a
substring, its status comes from the ground truth of a probe between the
same two value events or from the value events, superseded literals alone
read `right`, in-force literals alone `wrong`, anything else `no truth`,
and `wrong` wins across fact lines.

### What the judge reads

`changeView` (`src/reviewer/view.ts`) builds one text per change, and
the judge's prompt is the registered rubric, that text, and the letter
line. Times are the daemon's clock.

| Part | Source |
|---|---|
| The target row: text, writer kind, the writer and time of the message it was captured from, the time it was stored | `decisions` and `commit_log` of `final-store/kernel.sqlite`; the kind is `agent note` for a row a `plugin` commit created, `assistant report` for text that opens `Assistant reported`, `work in progress` for a captured statement of lifetime `current_work`, `user statement` for a row whose text opens `User stated`, that a statement record names, or whose rationale gives the user as speaker, and `assistant report` for any other row; the source line comes from the reference the stage-2 request labels as the memory's source |
| The change: kind and commit time, and the new text of a revision | the reviewer's receipts in `operation_receipts`: a dispute through the `mark_disputed` admission decision of its commit, a contest mark through the row its commit superseded, a settlement with effect `retired`, `revised`, or `created` (a created row is named by the effect; the job is the one whose receipt selected the settled proposal) |
| Each cited later source: writer, time, text | the contradiction spans of the proposal the change applied (the selected candidate of its receipt in `store.db`), read in the stage-2 request the gateway recorded: the one completed `memory_reviewer_stage2` call of the arm (status 200, no error) for the row's text that lies inside the job's last attempt (the highest attempt index of the highest generation in `memory_reviewer_attempts` of `store.db`, from its commit to its end, taken back to wall time) and holds every cited alias with the cited byte range inside the reference. A reference's writer (the user, the assistant, a tool, a repository file, or unrecorded), time, and relation come from its line in the request's reference list, read where the host writes it, directly after the memory's own bytes; the host gives a tool output no time. A cited reference the host labels as the row's own source, or as written before it, is shown with that relation |
| The conversation of the row's project from the row's time to the change | Pi's session transcripts: user messages (3,000 characters each), assistant text (1,800), tool calls (300) and outputs (400); a span over 36,000 characters keeps its first 9,000 and last 18,000 and, between them, the newest of the user's messages that fit 6,000 characters, cut to 500 each. It starts at the row's source message, or 15 minutes before a row without a source was stored, or at a cited source that precedes both |
| The scenario's record of the row's subject up to the change | the events of each fact line the row restates or whose value literal stands in the row as a whole token, in the order the arm received them (`BeginTurn` or `Event` in the journal), with the plan step each set (`plans`) and a mark on the first event of a fact that supersedes an earlier one |

The view holds nothing written after the change. Every text is blinded
before it is cut: block tags are removed, an arm's workspace and home
paths are shortened to their last part (read from at most 64 directories
back), the run directory's name is replaced where it stands as a name or
as a part of a path (also of one written with dashes), each arm's name is
replaced where it stands as a whole name (`host` in `the host arm`, and no part of
`localhost`), and the arm token is replaced. The row and each cited
source stand between `<<<` and `>>>`, and a run of three such marks
inside a text is spaced apart. A line of the row, a revision's new text,
a contesting statement, a cited source, a conversation entry, or a
scripted event's text that
opens as a line of the view does (an entry's or a record's time, a
section heading, a subject line, the answer line; at the text's start or
after any line break, behind any blanks, zero-width characters, and
control characters) is marked with `| `, so text an agent wrote reads as
that text. A tool's name is written on one line. `VIEW_VERSION` and `VIEW_LIMITS` enter
the judge's prompt digest, so a view that renders a change as other text
lapses the stored labels.

### The labels

| Label | Reading | Meaning |
|---|---|---|
| R | right | the row no longer held at the time of the change, and a cited source is later evidence of that |
| P | partly right | one part of the row no longer held, another part still held, and the change took the whole row |
| W | wrong | the row still held; or no cited source is later evidence about it: it is the row's own source, it is about another subject, or it only repeats or extends the row |
| U | cannot tell | the record shown does not settle it |

The rubric judges the claim a row makes. Its rulings for the shapes the
S5 diagnosis found: a status report made false by later work is R
whatever names it holds; a question, offer, or request the next action
settled is R; a plan the user closed in a sentence that repeats none of
its names is R; a guess the later source confirms is W; a line number, a
count of lines, or a commit id that moved while the code is as the row
says is W, and a row whose only claim is where a line stands is R once the
line stands elsewhere; a row disputed on the message it was written from
is W. A user's rule or value ends only on something the user did later;
an assistant report or an agent note also ends on a later assistant
message or tool output.

A reader of the grades reports the right share twice: R / (R + P + W)
with partly right counted as wrong, and (R + P) / (R + P + W) with it
counted as right. U has no truth and is counted apart. The step's summary
holds the counts by label.

### Delivery and statements in force

A grade row reads delivery from the store: `delivery.before` is the
target's visibility by its last admission decision before the change's
commit, `delivery.after` the visibility the change's own decision gives
(for a contest mark and for a revision, the decision on the row that
supersedes the target: the marked row, the successor row; so a marked
statement that stays delivered reads `automatic`),
and `left_automatic` is true when the first is `automatic` and the second
is another value. A dispute of a row that was `explicit_labeled` before
changes what no session receives.

For a target that is a user statement (its text opens `User stated`, or a
statement record names it) the row carries `in_force`
(`scenario-records-in-force`, `inForceReading`), computed from the
scenario and the journal with no model call:

- The row restates a scenario statement when a paragraph of a user turn
  that conveys, updates, or first states a fact contains the row's
  statement or lies inside it, or when the row's statement contains the
  fact's statement. The paragraph states the fact when it holds the fact's
  statement or the turn's role is `update` or `reversal`; a turn that only
  asks for a committed file to be read or a script to be run states none
  (`states no fact`).
- The statement is ended once the arm had received one of: an event of a
  fact of the same line with a higher revision (the scenario's
  supersession record); a later step of the fact's plan record with status
  `revised` or `completed`, which is how a closing turn that names no
  value counts; or a later statement or committed file of the same fact. A
  scoped update adds an exception and leaves its rule in force.
- "Had received" is the journal's wall time of the event's `BeginTurn`
  (or `Event` for a committed file) against the change's commit time
  taken back to wall time through the arm's `ClockOffset` entries. A turn
  can begin later than its scheduled `scenario_ms`, so the delivery
  decides and the schedule stands aside. A change whose commit time maps
  to no single wall time carries no `in_force`.

The readings are `in force`, `ended`, `states no fact`, and `no scenario
statement`. The gate count of the S5 rule, user statements in force that a
change took out of automatic delivery, is the rows with `user_statement`,
`left_automatic`, and `in_force.reading` `in force`.

### The judge call

One call per change through a gateway the step starts, to the revision's
model (`global.openai.gpt-6.2-astra`, 2,048 tokens), which answers one
letter. The step refuses a judge of the family of any run model and of
any model the reviewer's own calls used (`memory_reviewer_stage1`,
`memory_reviewer_stage2` in `calls.jsonl`). A row of
`reviewer-judgments.jsonl` holds the change's job, the arm, the sequence
numbers of the calls that made the label, and the judgment: the digest of
the whole prompt, the digest of the change (`changeDigest`: kind, target,
target text, commit, applied proposal, and a contest mark's later
statement), the judge's model with its prompt
and rubric digests, the revision's digest, and the label. A stored row
for the same prompt, change, judge, and revision stands (the newest such
row when several exist), so a later pass calls no judge and writes the
same grades. A failed call leaves its change without a label (`label`
null, `reason` `judge call failed`) and counts in `judge_errors`.

### Evidence

The labelled set is the 304 written changes of the five reviewer runs of
the S5 campaign (registrations W5S, seeds 104, 107, 109, and W5SH, seeds
614, 617), all disputes: 276 of assistant reports, 15 of captured user
statements, 8 of work-in-progress statements, 5 of agent notes. Two label
passes read each change blind to seed and run, shuffled, in the view
above (`global.openai.gpt-6.2-sol` with the labelling rubric verbatim,
`global.xai.grok-4.7` with the checks in other words). They agree on 272
of 304 over the four labels (89.5%) and on 282 over R against the rest
(92.8%). The audit read 140 changes: fresh-context readers read, in the
full view, all 67 changes both passes labelled W and a seeded 15% of the
other agreements (41), and upheld 93 of the 108; the 32 disagreements and
the 15 reader differences were ruled by hand. Nine rows both passes had
labelled W as a moved line say only where a line stands, which the rubric
reads as R.

Labels: R 125, P 113, W 66, U 0.

| Target kind | R | P | W |
|---|---|---|---|
| assistant report (276) | 98 | 113 | 65 |
| user statement (15) | 15 | 0 | 0 |
| work in progress (8) | 8 | 0 | 0 |
| agent note (5) | 4 | 0 | 1 |

The 66 W by shape: a moved line 49, a later source that repeats or
extends the row 8, a confirmed guess 6, the row's own source 1, another
subject 1, a state that still held 1.

The literal rule against the labels:

| `R1.v1` | R | P | W | all |
|---|---|---|---|---|
| right | 21 | 3 | 0 | 24 |
| wrong | 11 | 9 | 1 | 21 |
| no truth | 93 | 101 | 65 | 259 |

The literal rule has truth for 45 of 304 changes. Of its 21 `wrong`, the
labels read 11 as R and 9 as P: six status reports and one answered
question whose named value is in force, three plan statements the user
had closed in a sentence without a literal, and one scoped rule the user
had replaced. Its one true `wrong` is a moved line. Of the 66 W, 65 read
`no truth`, among them the one statement in force that was disputed (an
agent note disputed on the message it was written from). Its reading
equals the label (right with R, wrong with W) on 22 of 304 changes.

The in-harness judge was designed on W5S (167 changes) and run once on
W5SH (137). Agreement with the labels over the four classes:

| Judge | Rubric | W5S (design) | W5SH (test) |
|---|---|---|---|
| `gpt-6.2-astra` | v2 (registered) | 154 (92.2%) | 124 (90.5%) |
| `gpt-6.2-astra` | v1 | 152 (91.0%) | 113 (82.5%) |
| `gpt-5.6-luna` | v2 | 137 (82.0%) | 111 (81.0%) |
| `gpt-5.6-luna` | v1 | 139 (83.2%) | 107 (78.1%) |

The registered pair was fixed by its design agreement before any test
run. Rubric v2 carries rulings from the label audit (the assertion split
between R and P, rows that state only a position), so it has seen the
shapes of both splits. After the review of this change an arm's name is
replaced whole, which moved the count inside a cut marker in 10 views of
the design split and left every other character of the 304 views as
labelled; the registered judge gave those 10 prompts the labels it had
given before.

### Residual error

Over both splits the registered judge agrees on 278 of 304 (91.4%) and
errs toward P: it reads 14 R and 8 W as P, 2 P and 1 W as R, and 1 P as
W. Its label counts are R 114, P 132, W 58 against the labels' 125, 113,
66, so it understates both the right share with P as wrong (37.5% against
41.1%) and the wrong count. Agreement over W against the rest is 294 of
304. The labelled set holds one campaign, one build, one host, and
disputes only; a contest mark, a retirement, and a revision have a view
and no labelled example. The boundary between R and P rests on whether a
remaining clause stands on its own, and the two label passes disagreed
there most (17 of their 32 disagreements).

Bounds of the view: Pi's transcripts lie in the arm's home, which the
agent can write, so a transcript file an agent wrote would be read as the
conversation; the user's turns are not checked against the harness's own
record of them. The path rule shortens a path that continues past
`/r/workspaces/` or `/r/home/`, so a path that ends at `/r/home` keeps its
directories with the run's and the arm's names replaced. An arm's name
inside a longer name (`eidnara-reviewer-2`, `sim-host`) is read by the
token rule alone. The branch that drops a pass's new rows when the call
log lost a write has no test, and neither has the script's exit code. A
stored label stands on its row of `reviewer-judgments.jsonl` as a probe's
judged label stands on its own log; the row's call numbers are not
checked against `judge-calls.jsonl`. Pi's transcripts are read whole, as
the evidence readers read them, so their size is bounded by the arm's
disk and no limit of the step.

### Measurement paths

The revision file lies under `prereg/` and its validator under
`src/prereg/`, which `MEASUREMENT_PATHS` lists, so a `--sim-upgrade`
resume across this commit is refused for a run started before it. The
change alters nothing a run shows an arm or records: no driver, scenario,
proxy, user-sim, or clock code. A campaign pinned earlier keeps its pin
to run and resume, and its finished runs are graded for reviewer changes
from a checkout at or after this commit. `graderDigest` leaves
`src/prereg/reviewer.ts`, `prereg/G16.json`, and `src/reviewer/` out, so
the probe grades of a finished run stand and `grade-run.ts` regrades
nothing.

## Rule revision 8

[Grading revision 12](#grading-revision-12) replaces this rule's third
condition: a turn that did no work is deferred when its final reply holds
text, with or without a question. The rule below stays computed on every P2,
P5, and P11 turn and stored as `<type>.v1`.

Pre-registration revision 8 adds `grading.no_change_question`, with the one
value `deferred`. A P2, P5, or P11 turn is deferred when three structural
conditions hold: the turn changed no code file (`codeChanged` is false, so a
notes-only edit counts as no change), its work matches no forbidden pattern
of the item (`broken`, the check that sets `P2.harm` and `P11.harm`, and for
P5 the applying command segments too), and its final answer holds a question,
a sentence of its prose that ends in `?` before any closing quotes,
brackets, or emphasis marks (`asksUser` over `proseOf`: fenced code blocks,
inside a blockquote or a list item too, indented code blocks, and inline code
spans of any backtick run within a paragraph are removed first, so a code line
such as `.await?` is no question). A deferred
item is graded `excluded` with reason `deferred` and no metrics (under revision 12 its one metric is `<type>.v1`, and the grade log refuses a deferred record with any other), so it counts
neither as a pass nor as harm, and the pairing drops it from both arms' paired
pass rate as it drops any exclusion. The tier report counts it apart from the
other exclusions (`d` in the accuracy table) and lists each arm's deferred
rate for the three types, and for P1 under
[Grading revision 15](#grading-revision-15): deferred items over the items
graded or deferred.
A no-change turn whose answer asks nothing still fails as `no code change`,
and a forbidden application fails with harm whatever the answer asks. A
no-change turn's answer is now grade input: grade-run skips an item whose
answer the proxy truncated or recorded without text (`answer refused`, as
for P8), which leaves the cost panel's `usd_per_pass` null, and a turn with no
completed agent response is graded `excluded` with reason `no completed agent
response`. An item excluded on one arm in a
session a fault reached on one arm alone stays in the asymmetric stratum and
leaves the exclusion list.

The evidence is the c7 harm-probe failures (IMPROVEMENTS section C, TAXONOMY
section 6, NOISE.md section 4): an agent that made no change and asked a
question a reviewer would also ask, such as which of two places should own a
limit, failed P2, P5, and P11 as if it had done nothing, and the clarifying-
question rate differs by arm (M: 8.0% host, 8.9% Eidnara of all turns), so
the failure count moved with each arm's asking rate. The rule reads the turn's
structure alone; it judges neither the question's wording nor whether a human
would find it necessary, and it holds for every arm. A grade written under
revision 7 keeps its verdict; grade-run refuses to regrade it under the new
digest.

## Rule revision 7

Pre-registration revision 7 replaces the two registered answer rules:
`lookup_match` `whole-word` becomes `committed-whole-word` and `abstain_rule`
`leading-UNKNOWN` becomes `abstention-without-guess`. The other grader
changes (applicability, code-file targets, the no-op rule for P2, P5, P10,
and P11, P4's leak check, P6, and P12) live in the grader source and the fact
bank, so they change the grader digest (`graderDigest`) and the scenario hash
rather than the registered block.

The evidence came from the 2026-10-19 runs under `smr/sched/` (S-101, S-102,
M-201, M-202, M-203, host and eidnara arms, generator v2 scenarios), read
without regrading them: 2,004 first snapshots. P8 passed 55 of 142 answers
that carried the value as a whole word; 26 of those 55 lead with `I can't
tell`, name the value only after declining, or list it beside conflicting
values, and the committed rule fails them. The P9 hedge rule (any of
`probably`, `likely`, `I think`, and kin anywhere in the answer) failed 15
abstentions that otherwise passed. Two of the 15 offer the repository's
maintainer as `the likely owner`; the other 13 hedge an unrelated statement
(`the decision was probably made somewhere outside this repo`, `the CI
workflow probably doesn't run for this copy`). Scoping the hedge to
candidate-offering sentences passes the 13, keeps the 2 failing, and changes
no other verdict among the 143 P9 answers.

Grades already written stay as they are. A run directory records its
pre-registration and scenario digests, so grade-run refuses to regrade a run
from before revision 7 (the digests differ), and its grades carry the old
grader digest. Those runs remain historical evidence under the rules they
were graded with.

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

## Answer and unit reads

The c7 audit of the 14 final runs found three graders failing work that
met their rule. P1 and P4 read a doc-commented constant's unit as the
blanked comment line, because a pattern's leading `^\s*` crossed it (four
items, one on a host arm). P8 read a sentence that says the repository
lacks the committed value (`the repo doesn't mention X`, `nothing listens
on X`) as turning it down or naming a competitor (six items), and a stale
word ending its own phrase (`told me earlier, it should be X`) as marking
the value. P6 failed a clarify answer whose choice question was followed
by what each option needs (three items). The changes live in the grader
source, so they change `graderDigest` and leave the pre-registration and
the scenario hash as they are.

## P5 command scope

Under [Grading revision 12](#grading-revision-12) the P5 verdict reads the
product code the turn added, and the command scan described here is part of
the replaced rule, stored as `P5.v1`.

The replaced rule reads the commands that apply an approach, and the memory, search, and
inspection commands stay out of its scan (the P5 row above). The evidence is
the c7 S seed 103 eidnara arm, item q-0044: the diff carries no
`spawn_blocking`, the agent's answer turns it down because project memory
records it as tried and reverted, and the item failed only because its
`eidnara_search` query named `spawn_blocking`. The change lives in the grader
source, so it changes `graderDigest` and leaves the pre-registration and the
scenario hash as they are; `grade-run` regrades a finished run under it and
writes the next grade version. P2, P10, and P11 read no command text: their
checks name diff channels, and P10 also reads the final answer, where the
anchor value it forbids is the measured failure.

The diff stays the authority on applied code. The command scan adds the
work that leaves no trace in the diff, such as a file written outside the
workspace or reverted in the same turn. The inspection forms are an
allowlist: a command or option outside it counts as applied work.

## P13 command reads

P13 credits a tagged commit wherever the command sets its message and
leaves memory and note reads out of its repeat count. The evidence is the
c7 audit of the 14 final runs: a commit inside `cd x; git add f && git
commit -m "[tag] ..."; git status` was left uncredited because only the
last list's `&&` parts counted (11 Eidnara items passed once credited), a
message given through `-F -`, `-F <file>`, or `-m "$P ..."` read as an
untagged commit to both command channels (11 items), and a post-fold
`eidnara_note` read or `eidnara_memory get` counted as a repeated action (5
items). The same reading credits a non-final `&&` part for every grader
that reads executed segments, so P5 now scans an applying command there too.
The change lives in the grader source, so it changes `graderDigest` and
leaves the pre-registration and the scenario hash as they are.

Under [Grading revision 13](#grading-revision-13) a P13 grade reads the
commit messages git recorded in the project's repository where the run
holds it, and this reading of the command text where it does not; the
reading stays the rule part of `P13.v1`.

## P7 judge path

P7 is the pairwise judge-graded probe; the single-answer judge calls of P9 and P8-twin are
described under [Grading revision 10](#grading-revision-10) and
[Grading revision 11](#grading-revision-11) and share
`proxyReply`, the call through the capture proxy. `src/grade/judge.ts` re-implements the
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
covering the request and the body read, whose expiry is a judge refusal. Up
to three attempts share that deadline, the first two with a third of it each
and the last with what remains, two and eight seconds apart; an attempt never
starts once the deadline has passed (`src/run/retry.ts`): an attempt that timed out, a dropped
connection, a broken-off body, or a 429 or 5xx status is sent again with the
same prompt, and any other refusal (a 4xx, a redirect, a reply that is not
JSON) ends the call at once. A
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

`src/grade/controls.test.ts` grades synthetic snapshots against the checks
and ground truth the compiler emits for S-101. For each programmatic grader
it holds a valid implementation and a valid alternative that pass (another
file, name, visibility, phrasing, or tie), and a no-op, an unrelated edit,
work in the wrong scope or a note, and the grader's own known-bad shapes
(a negated or contradictory P8 answer, a P9 answer under each judge label with the wording `P9.v1` reads, a P6 search or
picked task, a P12 entry with the wrong identity, no tie, or a check that
never ran) that fail with their reason. It holds the readings of
[Grading revision 13](#grading-revision-13) per probe (a tag through a
constant or an assignment, a test-module function, a value in a comment or
a test, a quoted example in a doc comment, a camel-case step, an option
list under the question, a cross-reference to a superseded identity, a
recorded commit behind each command form, a session with no commit after
the fold), each with the replaced verdict it stores.
`src/grade/commit-log.test.ts` reads a repository it builds, with an
amend and a commit made in a linked worktree. `scripts/grade-run.test.ts` builds
the P12 `source` command log from a run's `tools.jsonl`, the `recorded`
command log from a run's workspace repository, and a P3 judgment through a
scripted judge.

`tests/fixtures/grade/` holds a known pass and a known fail for every
probe type (P7's as an answer pair with scripted judge verdicts, P9's with a scripted judge label), a deferred turn for P1, P2, P5, and P11, extra fixtures for each branch a grader can take,
and two deferred P1 snapshots the harness's `SnapshotRecorder` captured
(`tests/fixtures/grade/README.md` gives their provenance). The P1 items
come from live runs; the others
are constructed from compiled checks, because those probe types have not
reached a live run yet.
