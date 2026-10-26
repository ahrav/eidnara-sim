# Scenario compiler

`bun scripts/compile-scenario.ts --tier <S|M|L|XL> --seed <n>` compiles one
scenario to `runs/scenarios/<tier>-<seed>.json`; a `--embedder local` compile
defaults to `runs/scenarios/<tier>-<seed>.local.json`, so a stand-in never
replaces a Titan scenario. The inputs are the seed, the
tier's pre-registration in `prereg/<tier>.json`, the corpus under `corpus/`,
and the generator version `sim-scenario/v5`. The same inputs produce the same
bytes in any process, and a run reuses a cached `scenario.json` only when its
top-level `schema`, generator version, pre-registration hash, and corpus
inputs hash match the current inputs. The compiler scores cue and probe pairs with
`amazon.titan-embed-text-v2:0`, the model the pre-registration names, through
the AWS profile in `sim.config.json`, and caches each vector in
`embeddings.jsonl` beside the output. It refuses any other embedder.
`--embedder local` swaps in a hashed bag of words and rewrites the threshold
model to match; the tests use it, and its scenarios name the stand-in model in
both `manifest.embedding_model` and `manifest.cue_probe_similarity`, so they
do not witness SIM-P08. The CLI accepts exactly `--tier`, `--seed`,
`--embedder`, `--out`, and `--qualification`, each once with a value; any
other token, an `--embedder` value other than `local`, or a non-integer seed
exits with the usage line, and a Titan compile accepts only a seed the tier's
pre-registration lists (`--embedder local` compiles any seed, which the tests
use). `--qualification Q` compiles under `prereg/Q.json` with its control
items, as a qualification run does, to
`runs/scenarios/<tier>-<seed>-Q.json`, and a Titan compile there accepts the
registration's seeds and hold-out seeds. An `--out` path, its directory, or its sibling `embeddings.jsonl` that resolves
inside `eidnara_checkout` is refused before any directory is created, as is an
`--out` that names the cache file itself, and an `embeddings.jsonl` that is a
hard link. The scenario is written to a random same-directory temporary name,
created exclusively, then renamed into place; the embedder reserves its Bedrock
response file the same way.

## Output

The scenario file is canonical JSON with these sections:

| Section | Contents |
|---|---|
| `manifest` | Seed, tier, generator and random-schema versions, one sha256 over the bytes of every corpus file the compiler parsed (`manifest.json`, `fact-bank.json`, `repos.json`, `distributions.json`, and `tool-outputs/samples.jsonl`, read once), the sha256 of the pre-registration, the embedding model, the similarity thresholds, the gap scale factors, and the probe count per type |
| `projects` | Each repository in `corpus/repos.json` and its twin |
| `sessions` | Session id, project, start time, request count, the idle gap before the session, the minimum gap the compiler enforced, and whether the request count was forced into the p90 regime |
| `facts` | Ledger facts with template, kind, project, conveyance manner, `basis`, `line`, `revision`, `supersedes`, statement, the cue texts that carry it, and for P12 facts the `form` (`tool_result` or `pasted`) |
| `probes` | Probe items P1 to P14 and the P1 controls with project, session, user text, the grading check, the event that delivers it, and, for every probe with user text, its `ground_truth`. Check keys: `must` and `must_not` regexes over the added lines of the agent's diff, `paths_must` and `paths_must_not` over the paths the diff adds or changes, `first_line_must` over the first line of every file the diff adds, `quote_style_must` (`double` or `single`) over the delimiter of every string literal in the added lines, `commands_must` and `commands_must_not` over the command log, an optional `scope` (a directory prefix or one file path) that limits the diff-channel keys to files under it (on a P4 `out` item, to the files outside it), `applies` (regexes for the constructs a constraint governs, each of which must carry the `must` patterns), `answer`, `answer_must_not`, `abstain`, and `judge` over the final assistant text, `clarify` for a P6 item whose right response is a question (patterns the final answer must all carry), `side` (`in` or `out`) for P4, `turns` for P13, and `window_from_turn` and `window_to_turn` for P14. Every `*_must` and `*_must_not` key holds a list of JavaScript regular expressions |
| `plans` | One record per P6 fact: project, `expect` (`resume` or `clarify`), and its history, each entry an event with the status it set (`accepted`, `revised`, `completed`) and the next actions it leaves open |
| `similarity` | BM25 ratio and embedding cosine for every cue and probe pair, each committed file of the fact and each shared first turn that joins its cue counted as a cue, each record naming its cue by `cue_sha256`, journaled to four decimals; the threshold gate compares the full-precision values |
| `events` | `apply_diff` (a whole-file `content`, or `remove: true`), `session_start`, `user_turn`, and `session_end` events in scenario time |
| `faults` | Fault episodes with type, strategy, trigger, parameters, and seam-table entry |
| `cf_deletions` | Counterfactual deletions before 20% of the P1, P3, and P5 probes (L only) |
| `scenario_hash` | sha256 of the canonical JSON of every other section |

## Sessions and time

Each base repository gets `sessions_per_project` sessions and each twin a
quarter as many, shuffled into one sequence. Every session opens on the
repository state the scenario defines: the pinned commit plus the
`apply_diff` events scheduled so far. An agent's edits in one session do not
carry into the next, so every arm of a seed meets the same repository in every
session, and a task text that recurs (the P1 control and its item, the
single scoped-update template per language) is graded against the same
starting tree each time. The scheduler owns that restore; the compiler relies
on it. `forced_p90_sessions` sessions
draw their request count from the tail above p90: each base repository takes
an equal share, a seeded draw assigns any remainder, and each share spreads
evenly over that repository's sessions; every other session draws from the full fitted distribution with
at least one request. Idle gaps within a session come from
`idle_within_session_s` and gaps between sessions from
`idle_between_sessions_s`.

The sampled gaps run longer than the tier's `simulated_days`, so the compiler
scales them to fit. Within-session gaps scale down only when the sessions alone
would fill more than 80% of the span; the P13 turn ranges of the forced p90
sessions then join the session time, and between-session gaps fill the rest,
each at least one millisecond. `manifest.within_session_gap_scale` and
`manifest.between_session_gap_scale` record both factors. For the
pre-registered seeds, within-session gaps scale to between 8% and 37% and
between-session gaps to between 0.4% and 1.3%.

Every session keeps its sampled gap after the previous session ends. A session
that opens with a P6 probe widens that gap to at least one hour, and turns
added during placement lengthen their session, so both push every later
session back by the same amount and a scenario runs past `simulated_days`; the
pre-registered seeds end between 0.2 and 1.2 days past it.

## Facts, conveyance, and probes

Each probe type gets `paired_items_per_probe_type / (seeds * hosts)` items;
the pre-registration validator requires that division to be exact. Facts come
from the templates in `corpus/fact-bank.json` (`sim-fact-bank/v3`), filled
with generated tokens: `adjective_noun` words in lower, upper, and Pascal
case, five-digit numbers from 10000 to 65535 (so a figure a template states
as a port is a valid TCP port), and `adjective-noun-NN` codenames, from the v1
harness word lists.

### Lines and supersession

A fact's `line` is its project and template (`<project>/<template>`), or
`<project>/plan` for P6. The compiler splits each project's sessions into
consecutive windows, one per round of templates, and conveys and probes every
fact inside its window, so instance `k + 1` of a line starts after every probe
of instance `k`. Instance `k + 1` supersedes instance `k` explicitly:

- its cue is the template's `revise` wording, which names the old value and
  the new one (`{old_*}` placeholders bind instance `k`'s values); a template
  that would repeat in a project without a `revise` wording is a compile
  refusal, so a rejected approach or an open question never repeats in a
  project, and the bank holds enough of them for XL;
- a template without generated state that still repeats (the two scoped
  updates) draws a different `variants` entry per instance, such as the next
  log level or the flipped quote rule;
- `supersedes` names instance `k`, and the check forbids what instance `k`
  required, the values it forbade apart from those requirements (a
  decision's stated figure, an anchor value; a forbid that names the
  predecessor's own required value, such as a commit-tag rule's complement,
  is that requirement restated and stays out), and everything earlier
  instances forbade, except a
  pattern the new check requires. The P1 control of a revised constraint
  carries the new requirement without those inherited forbids, since its
  agent has yet to hear the revision;
- the session that conveys instance `k + 1` opens with commits that remove
  every file the line committed earlier and the new instance does not
  rewrite, so the repository never holds two live states of one line; a
  revision conveyed by a commit says so (the note and the check script's
  output name the replacement, and the first turn says the change replaces
  something set up earlier).

When a project reuses a probe text for another fact, the later probe gets a
neutral framing from the bank's `framings` list (`New request.`, `Next
item.`, ...); a probe text asked for two facts of one project is a compile
refusal.

### Basis

Every fact and probe records its `basis`: `instruction` (the user stated it,
in conversation, a committed note, or a check script's output),
`convention` (a committed example file the agent generalises from),
`incidental` (an anchor value mentioned in passing that the agent must not
apply), or `observation` (a P12 error the agent's tool run printed or the user
pasted, and a P3 value read from its authoritative file).

### Placement

| Probe | Fact kind | Placement |
|---|---|---|
| P1 | constraint | Later session of the same project, inside the constraint's scope |
| P1 control | the P1 fact | The same task as the P1 item, in the same window before the fact is conveyed; `ground_truth.expect` is `baseline`, its `sources` are empty, and a revised line's control omits the forbids it would inherit |
| P2 | the P1 fact | Later session of the same project, outside the scope; the check forbids the convention |
| P3 | decision | A later session opens with a commit of the template's authoritative file (one stable path per template) and a first turn naming that path and saying it replaces the stated figure; the commit removes the line's notes and check scripts, and the probe follows in a later session; the check requires the file's value and forbids the stated one |
| P4 | scoped update | A second conveyance narrows the rule to one module; items alternate inside and outside it, with the alternation offset by seed parity so the pooled counts balance per language across seeds, and `check.side` says which (`in` or `out`); both sides carry the update's `check.scope` |
| P5 | rejected approach | Later session; the check forbids the rejected approach |
| P6 | plan | First turn of the project's next session after the plan's latest conveyance, at least one hour after the previous session ends; see Plans below |
| P7 | rationale | Later session; judge-graded against the reference reason |
| P8 | lookup | Later session; the answer must carry the value |
| P8-twin | the P8 fact | Qualification control `wrong-project-lookup` only: the same question in a session of the twin project after the conveyance; `ground_truth.expect` is `abstain`, `absent` holds the base project's value, `check.owner` names the base project, and `sources` are the base project's |
| P9 | never settled | Later session; the answer must abstain |
| P10 | anchor | Later, unrelated task; the value must not appear |
| P11 | the P1 fact | A session of the twin project after the conveyance; the check forbids the convention |
| P12 | tool error | `tool_result`: a session opens with a commit of a check script under `scripts/`, and its first turn asks the agent to run it, so the error reaches the agent as its own tool result; a later session opens with a commit removing the script once "the fix is in", and the probe follows. `pasted`: the user pastes a failure of this project's own test command (`cargo test` or `bun test`) on a branch. Items alternate between the forms; the error identity (`<Word>Error`) is generated per fact, the probe names the failure by its issue number, and the check requires the identity in the file the probe names (`README.md` for Rust, `CONTRIBUTING.md` for TypeScript) |
| P13 | session rule | Conveyed in the first third of a turn range in a forced p90 session and probed in its last third; each P13 item has its own range of at least 30 turns, so at least 11 turns separate cue and probe, and `check.turns` gives the turn after the cue and the turn after the probe, so the range holds exactly the folds the probe turn's snapshot can carry. Session rules are placed in scenario order, and a later rule of a template in the project supersedes the earlier one through its `revise` wording |
| P14 | none | The last third of a forced p90 session, split into one window of at least ten turns per item (`window_from_turn` to `window_to_turn`), measured from user-sim labels; the item's `event` is the session's last user turn, where its snapshot is taken |

### Plans (P6)

Each project's P6 facts get one window each, so plans run one after another.
A plan template is a `task`; a fact states one task (`resume`) or two tasks
with no order (`clarify`) when `(slot + project index + seed) mod 3` is 2,
where `slot` counts the project's P6 facts. A resume item in an odd slot is
revised before its probe ("Change of plan for
next time: drop A; the next step is B instead"). After the probe, a status
turn closes the plan. `plans` records each step. A resume item's check
requires the current next step and forbids the dropped one and earlier
plans' steps; a clarify item's check sets `clarify` to both tasks' patterns
and forbids both in the diff, so the item passes on a question that names
both tasks and no edit toward either. The compiler refuses a P6 probe that
finds another plan of its project accepted and not completed.

A plan's latest conveyance (its statement, or the change of plan in an odd
slot) is the last request of its session: the compiler places it in the
session's last slot, extending the session when that slot is taken, and a
turn placed into that session later takes a new slot before it. The P6 probe
opens the project's next session. So between the plan's latest conveyance
and the probe the project receives no request and no commit, and its
conversation's last open item is the plan, and the generic resume wording
("what we left unfinished") names it alone. `proveResumeFollowsPlan`
refuses a scenario in which a request or commit of the project falls between
them. Plans take no committed note, so no plan's latest
conveyance is a session's opening.

### Conveyance

Conveyance manners follow the fixed weights 35/20/15/10/10/10 for correction,
hand-applied diff, tool error, rejected approach, direct statement, and stated
then reversed. The compiler rounds each weight with largest remainders over
the scenario's facts. P5 facts take the rejected-approach manner, P8 facts the
direct statement, and P12 facts the tool error. Only rejected facts take the
rejected-approach wording, and only constraint, decision, and tool-error facts
take the tool-error manner. P13 facts and scoped updates take no diff, so no
committed note goes stale before an update; P6 facts take none, so a plan's
conveyance can end its session (Plans above); and a template whose statement has no
generated token takes no reversal, since its decoy would equal the statement.
A reversed fact's checks forbid the decoy's rendering beside the final value:
the decoy's `*_must_not` lists join every check, its `*_must` lists join the
P2 and P11 forbids, and a `*_must` pattern whose placeholders were all swapped
joins the fact's own `*_must_not`, so applying or leaking the superseded value
scores as harm. A fact whose remaining pool holds no permitted manner takes a
correction, so the realised mix sits a little off the weights; the 100-seed
test keeps it within 5 percentage points.

Commits fire only between sessions, so every commit lands at the start of
the session whose first turn points at it:

- a hand-applied diff adds a file whose content implies the fact, and the
  first turn names that file and asks the agent to look it over without
  stating the fact. A constraint template whose scope is a directory names an example
  path inside that scope (`src/cmd/{token}.rs`, `src/adapter/{token}.ts`,
  `tests/{token}.rs`, `test/{codename}.{token}.test.ts`); every other template
  adds `notes/{token}.md`, a note that states the fact's current state;
- a tool-error conveyance of a constraint or decision commits
  `scripts/check_{token}.sh`, which prints the rule as an error and exits 1,
  and the first turn asks the agent to run it;
- the commits of several facts may share one session opening; its first turn
  then joins each fact's cue, `facts` names them all, and the similarity gate
  scores the joined turn against each of those facts' probes beside each
  fragment. A probe that opens a session (P6) holds that opening alone.

Every other turn avoids a session's first turn, extending its session when no
later slot is free. Every request that carries no conveyance or probe is a
filler task from the fact bank, or, with probability 0.1, a paste of a corpus
tool-output sample.

## Controls

Every tier scenario carries four control classes, and a qualification
registration adds its own items on top (`docs/run-command.md`):

| Class | Items | What makes the right answer |
|---|---|---|
| stale | `ground_truth.stale` on reversed facts (the decoy), on revised instances (the predecessor's literals), on a revised P6 plan (the dropped step), and on P3 (the stated figure) | the current value, with the stale one absent; the compiler proves no stale literal reaches the agent after the current one or sits in the tree at the probe |
| superseded | revised instances of a line (`supersedes` non-empty), on P3, P4, P6, P7, P10, P12, and P13 at S | the latest instance's rule or value |
| wrong project | P11 (a P1 rule's task in the twin project), and with `wrong-project-lookup` P8-twin (a P8 question in the twin project) | the other project's rule stays out of the code; the other project's value is no answer |
| should not apply | P1-control (the task before the rule is conveyed), P2 (outside the rule's scope), a P4 `out` item, P5 (a rejected approach), P9 (a question nobody settled), P10 (an incidental anchor) | the baseline behaviour, the rule absent, an abstention |

The compiler adds P8-twin items only when its input names the qualification
and the control; the manifest then records `qualification_sha256`, and a run
reuses a cached `scenario.json` only under the same qualification. Without one
the compiled bytes are those of the tier scenario.

## Ground truth and exposure

Each probe with user text carries `ground_truth`: `expect` (`apply`,
`baseline`, `avoid`, `answer`, `abstain`, `explain`, `resume`, or
`clarify`), `basis`, `present` (per rule pattern, the generated literals and
variant words of which correct work carries at least one), `absent` (those it must not carry, including the other delimiter of a quote-style
rule), `stale` (literals of
superseded instances, decoys, a dropped plan step, and a P3 fact's stated
figure), `supersedes`, and `sources` (every event that exposes the fact). The
compiler proves each record against the event sequence and refuses the
scenario when:

- a source does not precede the probe, or lies outside the fact's project (a
  P11 or P8-twin item's sources are its base project's);
- a `present` or own `absent` literal appears in no source, compared
  case-insensitively, with a number matched as a whole value;
- the scenario-defined tree at the probe, every `apply_diff` before it
  replayed, holds a `stale` generated literal (a variant word such as a log
  level is a common word, so it is left to the exposure and grading checks);
- a `stale` generated literal reaches the agent after the last source that
  carries a `present` literal;
- a P3 item's authoritative value (one literal of each pattern) is missing
  from the tree, or a
  `tool_result` P12 item's check script is still in it;
- a P1 control follows a source of its fact.

Provider faults trigger after the last probe, source, or plan status turn of
their session and after any P14 window in it, so a fault never withholds a
source a probe depends on or a turn the ledger records.

## Compile-time refusals

The compiler throws, and writes nothing, when:

- the seed is outside the unsigned 32-bit range of the random streams;
- `forced_p90_sessions` asks a base repository for more forced sessions than
  it has;
- the embedder differs from `cue_probe_similarity.embedding_model`, or returns
  a vector count or shape that does not match the texts;
- a cue and probe pair has a BM25 ratio above `bm25_max` or a cosine above
  `cosine_max` (SIM-P08);
- any user text or diff path or content matches the marker set: probe ids,
  the word probe, fact, template, or probe item ids, or grading words
  (SIM-P07);
- a probe turn precedes any conveyance, update, or diff of its fact, or a P1
  control follows the first conveyance of its fact (SIM-P06);
- a template repeats in a project without a `revise` wording, or a probe text
  repeats for more facts of one project than the bank holds framings;
- a commit finds no free session opening in its window;
- a probe's ground truth fails a check in Ground truth and exposure, or a P6
  probe finds another plan of its project open;
- `validateFault`, which the compiler runs on every scheduled episode,
  refuses a trigger other than a session start, the Nth user turn of a
  session, or the first summarizer call of a session; a trigger that names an
  unknown session or a turn the session lacks; and an episode whose seam entry
  differs from the seam table (SIM-P05);
- `scheduleFaults` finds fewer sessions with two or more turns and two turns
  after every probe and source than provider episodes, no forced p90 session for the mid-fold SIGKILL, or no session
  after the first that starts without a hand-applied diff for the sleep.

## Faults

`src/scenario/faults.ts` holds the seam table: layer, legal outcomes,
in-flight fate, surviving state, and observing oracle for each fault type. S
schedules one provider 429 episode; M schedules every provider fault; L adds
the infrastructure faults; XL adds the host upgrade and two hosts on one
daemon. Each type gets one episode.

| Layer | Trigger | Strategy |
|---|---|---|
| Proxy sink (provider faults) | The Nth user turn of a session with at least two turns, after its last probe, source, or plan status turn and any P14 window, and before its last turn, so a later agent call can witness the fault; each provider episode gets its own session | single (1 call), burst (3 calls), intermittent (probability 0.3 over 10 calls), or persistent (to the end of the session) |
| Scheduler, mid-fold SIGKILL | The first observed summarizer call of a forced p90 session (OQ-8, schedule half) | single |
| Clock, laptop sleep | The start of the session after the widest idle gap, among sessions that start without a hand-applied diff | single, with `duration_ms` equal to that gap, so the jump holds no events (SIM-P18) |
| Scheduler, every other type | The start of a session after the first | single; the store-full fault is persistent for that one session (`sessions: 1`) |

The scenario fixes each episode's trigger condition and strategy; the
realized firing time of the mid-fold SIGKILL (an observed call) and of an
intermittent episode's calls comes from the run. The run manifest (spec
#1007, decision tape) carries the values an episode acts
with that depend on the run rather than the seed: the second host binary a
host upgrade installs, the second model a model switch selects, and the
seeded fault-jitter stream whose draws decide which of an intermittent
episode's calls fault. Both arms of a seed read the same manifest, so those
values are shared across arms.

## Counterfactual deletions

When the tier runs the `eidnara-cf` arm (L), the compiler shuffles the P1,
P3, and P5 probes with its own seeded stream and takes the first 20%, rounded.
Each deletion names the probe, its fact, and the event the deletion precedes.
The `eidnara-cf` arm carries every deletion of the scenario, so once a second
deletion has fired the arm's context differs from `eidnara`'s for more than
one fact. How M9 attributes outcomes to single deletions (SIM-P72) is an open
question for that milestone.

## Pre-registered seeds

With Titan embeddings, every pre-registered seed compiles within the
thresholds (`bm25_max` 0.4, `cosine_max` 0.6):

| Tier | Seed | `scenario_hash` | Largest BM25 ratio | Largest cosine |
|---|---|---|---|---|
| S | 101 | `1463d12e` | 0.2767 | 0.4802 |
| S | 102 | `9bbb45a3` | 0.2689 | 0.5229 |
| M | 201 | `eda5ff8e` | 0.2606 | 0.5807 |
| M | 202 | `1ea62d69` | 0.2595 | 0.5807 |
| M | 203 | `3498591b` | 0.2593 | 0.551 |
| L | 301 | `0443dc48` | 0.2599 | 0.5807 |
| L | 302 | `b834c8b7` | 0.2593 | 0.5807 |
| L | 303 | `d1fc2004` | 0.2605 | 0.5807 |
| XL | 401 | `274d5843` | 0.2607 | 0.5807 |

Under qualification Q (revision 2, `d03fd8ca`), which adds its P8-twin
controls, the seeds compile to these scenarios; 103 is its exploratory
hold-out:

| Registration | Seed | `scenario_hash` | Largest BM25 ratio | Largest cosine |
|---|---|---|---|---|
| Q | 101 | `f36d5033` | 0.2767 | 0.4802 |
| Q | 102 | `6ab5a114` | 0.2668 | 0.5229 |
| Q | 103 | `c0b8dcf3` | 0.2705 | 0.4939 |

## Known limits

- SWE-chat's per-prompt intent labels are gated, so sessions carry no intent
  kind.
- Filler pastes still come from the OpenHands tool-output samples, which are
  Python runs; no probe depends on them.
- The exposure proof covers delivery: a source turn was sent and its commit
  landed. Whether the agent ran the check script is run evidence: the P12
  grader reads it from the arm's tool ledger and excludes a tool-result item
  whose check never ran (`docs/grading.md`).
- At the current pre-registration sizes, an S scenario holds about 50 sessions
  and 500 user turns per arm. That is larger than the two-hour S wall budget
  admits, and M8 resizes S through a pre-registration revision.
