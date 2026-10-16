# Scenario compiler

`bun scripts/compile-scenario.ts --tier <S|M|L|XL> --seed <n>` compiles one
scenario to `runs/scenarios/<tier>-<seed>.json`. The inputs are the seed, the
tier's pre-registration in `prereg/<tier>.json`, the corpus under `corpus/`,
and the generator version `sim-scenario/v1`. The same inputs produce the same
bytes in any process. The compiler scores cue and probe pairs with
`amazon.titan-embed-text-v2:0`, the model the pre-registration names, through
the AWS profile in `sim.config.json`, and caches each vector in
`embeddings.jsonl` beside the output. It refuses any other embedder.
`--embedder local` swaps in a hashed bag of words and rewrites the threshold
model to match; the tests use it, and its scenarios name the stand-in model in
both `manifest.embedding_model` and `manifest.cue_probe_similarity`, so they
do not witness SIM-P08. Any other `--embedder` value, a non-integer seed, or a
flag without a value exits with the usage line, and an `--out` path inside
`eidnara_checkout` is refused before any directory is created.

## Output

The scenario file is canonical JSON with these sections:

| Section | Contents |
|---|---|
| `manifest` | Seed, tier, generator and random-schema versions, the sha256 of `corpus/manifest.json`, the embedding model, the similarity thresholds, the gap scale factors, and the probe count per type |
| `projects` | Each repository in `corpus/repos.json` and its twin |
| `sessions` | Session id, project, start time, request count, the minimum idle gap before the session, and whether the request count was forced into the p90 regime |
| `facts` | Ledger facts with template, kind, project, conveyance manner, statement, and the cue texts that carry it |
| `probes` | Probe items P1 to P14 and the P1 controls with project, session, user text, the grading check, and the event that delivers it |
| `similarity` | BM25 ratio and embedding cosine for every cue and probe pair, journaled to four decimals; the threshold gate compares the full-precision values |
| `events` | `apply_diff`, `session_start`, `user_turn`, and `session_end` events in scenario time |
| `scenario_hash` | sha256 of the canonical JSON of every other section |

## Sessions and time

Each base repository gets `sessions_per_project` sessions and each twin a
quarter as many, shuffled into one sequence. `forced_p90_sessions` sessions
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

Each probe type gets `ceil(paired_items_per_probe_type / (seeds * hosts))`
items. Facts come from the templates in `corpus/fact-bank.json`, filled with
generated tokens: `adjective_noun` words, five-digit numbers, and
`adjective-noun-NN` codenames, from the v1 harness word lists.

A project holds more facts of one kind than the bank holds templates, so
templates repeat with fresh tokens. The compiler splits each project's
sessions into consecutive windows, one per round of templates, and conveys
and probes every fact inside its window. Two facts that share a template and
a project therefore never overlap: the later one starts after every probe of
the earlier one and supersedes it.

| Probe | Fact kind | Placement |
|---|---|---|
| P1 | constraint | Later session of the same project, inside the constraint's scope |
| P1 control | the P1 fact | The same task as the P1 item, in the same window before the fact is conveyed |
| P2 | the P1 fact | Later session of the same project, outside the scope; the check forbids the convention |
| P3 | decision | A diff changes the authoritative value before a later session; the check requires the new value |
| P4 | scoped update | A second conveyance narrows the rule to one module; items alternate inside and outside it |
| P5 | rejected approach | Later session; the check forbids the rejected approach |
| P6 | plan | First turn of a later session, at least one hour after the previous session ends |
| P7 | rationale | Later session; judge-graded against the reference reason |
| P8 | lookup | Later session; the answer must carry the value |
| P9 | never settled | Later session; the answer must abstain |
| P10 | anchor | Later, unrelated task; the value must not appear |
| P11 | the P1 fact | A session of the twin project after the conveyance; the check forbids the convention |
| P12 | tool error | A real error from `corpus/tool-outputs/error-codes.jsonl`; the check requires the exception name |
| P13 | session rule | Conveyed in the first third of a turn range in a forced p90 session and probed in its last third; each P13 item has its own range of at least 30 turns, so at least 11 turns separate cue and probe |
| P14 | none | The last third of a forced p90 session, split into one window of at least ten turns per item (`window_from_turn` to `window_to_turn`), measured from user-sim labels |

Conveyance manners follow the fixed weights 35/20/15/10/10/10 for correction,
hand-applied diff, tool error, rejected approach, direct statement, and stated
then reversed. The compiler rounds each weight with largest remainders over
the scenario's facts. P5 facts take the rejected-approach manner, P8 facts the
direct statement, and P12 facts the tool error. Only rejected facts take the
rejected-approach wording, and only constraint, decision, and tool-error facts
take the tool-error wording. P13 facts, which convey and probe within one
session, take neither the diff nor the reversal manner, and a template whose
statement has no generated token takes no reversal, since its decoy would
equal the statement. A reversed fact's checks forbid the decoy's rendering
beside the final value, so applying or leaking the superseded value scores as
harm. A fact whose remaining pool holds no permitted manner
takes a correction, so the realised mix sits a little off the weights; the
100-seed test keeps it within 5 percentage points. A
hand-applied diff is an `apply_diff` event before the session, adding a file
whose content implies the fact, followed by a user turn that points at the
latest commit without stating the fact. A constraint template whose scope is
a directory names an example path inside that scope (`src/cmd/{token}.rs`,
`src/adapter/{token}.ts`, `tests/{token}.rs`, `test/{codename}.{token}.test.ts`);
every other template adds `notes/{token}.md`, a note that states the fact in
its own words, so a diff cue always carries the fact's scope.

Every request that carries no conveyance or probe is a filler task from the
fact bank, or, with probability 0.1, a paste of a corpus tool-output sample.

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
  control follows the first conveyance of its fact (SIM-P06).

## Pre-registered seeds

With Titan embeddings, every pre-registered seed compiles within the
thresholds (`bm25_max` 0.4, `cosine_max` 0.6):

| Tier | Seed | `scenario_hash` | Largest BM25 ratio | Largest cosine |
|---|---|---|---|---|
| S | 101 | `a1268adc` | 0.2137 | 0.5194 |
| S | 102 | `aae3af1d` | 0.2527 | 0.4867 |
| M | 201 | `d2a71a28` | 0.2526 | 0.4992 |
| M | 202 | `52d25090` | 0.2522 | 0.4997 |
| M | 203 | `cd7ff3ec` | 0.2498 | 0.4843 |
| L | 301 | `85b1cc09` | 0.2613 | 0.5092 |
| L | 302 | `8536f4af` | 0.258 | 0.4957 |
| L | 303 | `2de95d48` | 0.2512 | 0.5083 |
| XL | 401 | `04a5517e` | 0.2562 | 0.4962 |

## Known limits

- SWE-chat's per-prompt intent labels are gated, so sessions carry no intent
  kind.
- The corpus error codes are Python exceptions from the OpenHands
  trajectories, so P12 pastes a Python failure into a Rust or TypeScript
  project.
- At the current pre-registration sizes, an S scenario holds about 50 sessions
  and 500 user turns per arm. That is larger than the two-hour S wall budget
  admits, and M8 resizes S through a pre-registration revision.
