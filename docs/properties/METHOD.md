# Method contract for property-discovery agents

Every agent working on this catalog reads this file first. It is the single source
for the record schema, the check-semantics rules, and the conventions, so
individual task prompts stay short.

Method: `/testing:property-discovery-and-catalog`.

## Non-negotiable rules

1. **Verify every line reference against HEAD before writing it.** Correct any
   that are off and note the correction. If you cannot confirm a claim, record it
   as unresolved rather than restating it as fact.
2. **Never fabricate an answer to clear an open question.** `needs human input` is
   a valid conclusion. So is `unresolved, needs X`.
3. **A documented guarantee is a claim under test.** The documentation establishes
   the contractual obligation. It never establishes that the implementation
   satisfies it. Report contract-versus-code disagreements with both sides cited;
   do not resolve them in favour of the doc.
4. **Verify reachability class per record, at authoring time.** Every record is
   labelled `default-production`, `explicit-config-only`, or `test-only`, with the
   evidence for that label. Do not assert a blanket reachability claim in a
   preamble; that error has already been made once and cost a whole revision.
5. **Touch only the files you are told to create.** Never run a formatter,
   re-wrapper, prettier, or any directory-wide edit. An agent once ran a
   directory-wide re-wrapper and damaged 24 files belonging to other agents.
6. **No fixes.** This is evidence and analysis, not remediation. Do not edit
   source, tests, or CI.
7. **Prose style.** Plain, direct, present tense. Full sentences. No hype, no
   emoji, no em dashes as connectors. A spaced hyphen separates an enumerated
   field head from its note (`yes - <note>`). Wrap at about 80 columns.

## Record schema

Every catalog record uses exactly these fields, in this order:

```
### <kebab-case-slug>

Type: safety | liveness | reachability
Reachability: default-production | explicit-config-only | test-only
Status: active | invalidated
Exercised: not yet - <what is missing> | partial - <what is covered> | yes - <what constructed it>
Guarantee: <one sentence>
Check: `<semantics>` - <the exact condition to assert, plus why these semantics>
Fault/timing angle: <the window, the interleaving, or "none">
Required faults and enabling state: <concretely what must occur>
Confidence: high | medium | low - [evidence](evidence/<slug>.md). <what you verified and how>
Existing check: <location + what it covers, or "none">
Impact: <consequence if it fails>
Open questions:
- <question> (append "(needs human input)" for a design decision)
```

`Open questions: None.` is valid and preferred over an empty list.

## Check semantics

Choose from exactly these five, and record the rationale in the `Check:` line.

| The property says | Semantics |
| --- | --- |
| this must hold whenever evaluated | `always` |
| an optional path may never run, but must be safe when it does | `always-or-unreached` |
| a meaningful state must occur at least once per campaign | `sometimes` |
| a specific code point or path should be executed | `reachable` |
| a forbidden code point must never be entered | `unreachable` |

Two rules that are violated most often:

- A forbidden **state** with no dedicated detection point uses `always(!X)`, never
  `unreachable`. `unreachable` is only for a code location that must not execute.
- `reachable` is location coverage. `sometimes` is situation coverage. A campaign
  can execute a branch's lines while never producing the operational state the
  branch represents; when that distinction matters, the answer is `sometimes`.

## Coverage-check rules

A coverage check asserts the independent **preconditions** that jointly create a
vulnerable window, so it still fires on a correct implementation.

- Never assert the violation itself.
- Never pair `always(!X)` with `sometimes(X)`; that marker can only fire by
  observing the defect. Assert the independent preconditions instead.
- Marker names are constant and globally unique. Never construct them
  dynamically.

## Liveness rules

- A liveness check needs a **bounded** fault-free window: run under load, stop the
  pressure, poll until stable within an explicit bound, then check.
- Never write an unbounded "eventually". A finite test cannot refute it, and a
  generous timeout cannot distinguish one recovery pass from a thousand.
- State the bound in the units the code actually bounds: attempts, deadlines, or
  an explicit interval.

## Effect accounting under loss

When counting effects on a path where a response or a message can be lost, track
**attempted** and **acknowledged** separately and state bounds: observed effects at
least the acknowledged count, at most the attempted count. Aggregate totals can
cancel inside a one-to-one contract, so per-identity checks are the primary oracle
and the bounds are a cheap screen.

## Agent workspace actions and harness guards

An agent acts on its workspace by its own choice, and the agents of two arms
may act differently. A harness guard fails a turn for an agent action only
when the action changes an input the guarded measurement reads. A record for
such a guard names that input and the check that shows the measurement reads
it. An action on any other file is agent behaviour: the harness records it,
the turn keeps its outcome, and every arm gets the same treatment.

A guard that fails a turn removes graded items, and it removes them where the
agent acted, so the loss falls unevenly on arms and seeds. Before adding such
a guard, move the measurement's input out of the agent's reach: have the
harness read the input from a copy it controls, taken before the agent ran.
The agent's action is then an ordinary recorded change and the turn stays
gradable. Keep a guard only for the case where the harness cannot control the
input, and name that case in the record.

The probe snapshot is the worked case (`docs/grading.md`). Git reads ignore
rules and attributes from in-tree `.gitignore` and `.gitattributes` files, so
under the workspace's own rules an agent edit could keep new files out of the
recorder's tree or change the bytes it stores. The recorder builds every tree
under the project's baseline rule files, held in its own repository: ignore
rules through `check-ignore` in a directory that holds only the baseline
`.gitignore` files, attributes through `GIT_ATTR_SOURCE`. An agent edit of an
in-tree rule file is in the diff like any other file change, an edit under
the clone's `.git/info/` reaches no recorder run, and neither fails a turn on
any arm. The case the recorder cannot
control is a git that ignores `GIT_ATTR_SOURCE`; the recorder checks for it
once and builds no tree with such a git.

Recording an action and judging it are separate steps. The recorder's tree
holds every file the baseline rules leave in, including the cache a tool
writes beside the code (`.pytest_cache`, a virtualenv), whose own
`.gitignore` ignores every path below it. A measurement of what the agent
changed reads the project as the project's git lists it, so the recorder
names each self-ignoring directory on the diff artefact and the graders and
the user sim's rule check read the patch without its files
(`docs/grading.md`, Self-ignoring directories). The rule is stated on the
directory's rule file, never on tool names, it holds for every arm, and the
stored tree and patch stay whole. Its bounds are the cases where the files
are the agent's work: a directory of the project's fresh clone is never
self-ignoring, and a file the item's check names by scope or path pattern is
read wherever it lies. The rule reads the fresh clone's directories and the
rule file, so it differs from git in one case: a directory created after the
clone by a commit that also adds a catch-all rule file is read as
self-ignoring, while git still lists the files that commit tracks there.

## Grading rules as measurements

A probe's grading rule is a measurement of the property the probe names. A
difference between arms under a rule is read as behaviour only after the
rule has been checked against labelled answers, and a record whose check is
a probe verdict cites that check. The P9 rule is the worked case
(`docs/grading.md`, Grading revision 10): the registered wording rule agreed
with blind labels on 428 of 744 answers. It failed 277 answers the labels
pass, through a value-shaped token the reply set aside or carried in an
unrelated part and through wording outside its list, so a pass-rate
difference between two builds under it (19 against 12 of 24) stood beside
labels that differ by one answer the other way (23 against 24 of 24).
P8-twin is the second case (Grading revision 11): its registered rule agreed
with blind labels on 363 of 753 answers, failed 369 of the 715 answers the
labels pass, and recorded no harm on the one answer that gave a superseded
value of the other project as its own. P5 is the third case (Grading
revision 12) and the first whose replacement is a rule the grader computes.
The rule it replaced agreed with blind labels on 536 of 637 turns: it failed
55 turns whose product code did the task another way (a test or a comment
held the rejected call) and 28 turns that handed the decision back without
a question mark. The registered replacement agrees on 623 of the 637 (487 of
500 design turns, 136 of 137 test turns).
The positive, diff-graded probes are the fourth case (Grading revisions 13
and 14). Over 3,698 labelled turns of P1, P3, P4, P6, P12, and P13 the
rules these revisions replace erred mostly as false fails, 118 of them,
and 100 of those fell on the memory arms, so those rules understated one
side: a tag carried
through a constant, a figure the code already held, a superseded error
class cited as a cross-reference, and a commit whose message the command
text hid behind a variable or a shell function. The replacements read
product code apart from tests and comments (P1 reads the tests and
support code of a change that holds no governed unit in product code, and
a P4 rule over literals reads the literals of test files too) and read a
commit's message from git's own record, and a judge labels the reply of a P3 turn that
changed no product code, in a project where the arm wrote the value
earlier and the reply names it.
P1's no-work turns are the fifth case (Grading revision 15), and one where
the item's task decides the outcome in every arm: 157 of 860 graded P1
turns changed no code file, six task wordings hold 145 of them, and blind
labels read 152 as a question about a choice the task leaves open. The
rule of revision 13 failed all of them; the registered deferral of
revision 12, extended to P1, agrees with the labels on 105 of the 108
design turns and 49 of the 49 test turns, and defers 18.1% of the host's
graded P1 turns and 18.0% of the Eidnara arms'.

- State the property in one sentence and write the rubric from it before
  any answer is labelled. Give every class a label, the passing one and each
  way of failing, and write down each boundary ruling the labelling needs.
- Label blind to arm. Collect the answers of every arm and campaign that
  reached the probe, remove arm, run, seed, and build names from the
  metadata and replace arm names inside the answer text, shuffle, and keep
  the id map apart from the labels. An answer can still show what its arm
  provides, such as a memory tool's output, so the per-arm tables below are
  part of the check.
- Use two independent label passes and read by hand every disagreement and
  a random sample of at least 15% of the agreements. Report the agreement
  between the passes and the count read by hand.
- Report the rule under review as a confusion table against the labels,
  per arm after unblinding and per campaign, with the share of passing
  labels beside the rule's pass rate.
- Split the labelled set before designing a replacement: design on one
  campaign and run each candidate once on the other. Choose by agreement on
  the test split and state the residual error and which way it errs. The
  winner's test agreement is the best of the candidates run, so report every
  candidate's test agreement and the winner's design agreement beside it.
  Report the chosen rule's pass rate and errors per arm and per campaign,
  and keep the rule under review when the errors differ by arm.
- A replacement treats every arm identically: it reads the answer, the
  probe, and the scenario, and no arm, build, or tool name.
- Keep the rule under review computed and stored as a secondary metric, so
  earlier results stay comparable: an earlier grade's primary metric
  compares with a later grade's secondary metric (`P9.pass` before the
  revision with `P9.v1` after it), and the primary metric on both sides of a
  revision compares two rules. Register the replacement in a file of its
  own when a run manifest records the digest of the file that holds the old
  rule.
- A judge-graded rule pins the judge model, registers the rubric, stores
  the label with the digests of the prompt and the answer, and reads a
  stored label on a later pass, so grading a run again gives the same
  verdicts.
- When nearly every answer carries the passing label, a rule that passes
  every answer scores that share. Report it beside each candidate, and
  report how many failing answers each candidate fails and how many passing
  answers it fails (P8-twin: 95% of the answers pass, the judge fails 8 of
  the 10 failing test answers and the registered rule 2).
- A fact the label rests on that an exact match can decide is computed and
  given to the judge, and a label that needs the fact is refused without
  it. The P8-twin harm label is accepted only for an answer that holds one
  of the other project's values as a whole token.
- Check what the labeller is told against what the answers call things.
  The twin repositories name their package by the base project's name, and
  a judge given both project names read `the server exposes no metrics` as
  a statement about the other project until the rubric said the names are
  shared.
- Prefer a rule the grader computes over a judge when its test agreement is
  at most two points below the judge's, and fix that choice before the test
  run: the rule regrades a finished run with no model call. Register it
  with the same evidence as a judged rule (P5: 136 of 137 test turns, above
  the judge's 133). A judge rubric that carries rulings from the label
  audit has seen the shapes of both splits, so say so beside its test
  agreement: the comparison then favours the judge.
- A token rule reads where the token stands. A pattern for a rejected call
  matched tests that exercised it and comments that said it was avoided, and
  an arm that remembers the rejection writes such lines more often (label M:
  8% of host turns, 20% of Eidnara-arm turns), so the error fell unevenly on
  arms. Read the pattern in the code the product ships, with comments and
  string contents set aside.
- When a class has one observable mark in the labelled set, register the
  mark and state what the set cannot show. Every labelled no-work turn that
  hands nothing back has an empty final reply (20 of 20), and every one
  whose reply holds text hands the next step to the user (424 of 424), so
  the deferral rule reads whether the reply holds text; a reply that reports
  and stops lies outside the labelled set.
- Tuning a system to raise its score under a rule that has not passed this
  check is tuning to the grader.

## Evidence file structure

One file per record at `evidence/<slug>.md`:

```
# <slug>

## Discovery trigger
## Evidence trail
## Failure scenario
## Timing windows and dependencies
## What a test must construct
## Investigation log
### Q: <open question>
- Sources examined:
- Findings:
- Missing evidence:
- Conclusion: <resolved with answer | unresolved, needs X | needs human input>
```

Target 60 to 120 lines. Exceeding it to keep verified evidence is correct; say so
in your report rather than deleting evidence to hit a number.

## Per-part artifacts

Each part directory contains:

| File | Contents |
| --- | --- |
| `catalog.md` | Scope, reachability classes, index table, the records, relationship map |
| `existing-checks.md` | Every existing claim-bearing check, with per-check status `unaudited`, plus explicit "none found" for empty categories, plus suspiciously quiet areas |
| `fault-map.md` | Fault classes with availability, per-property required faults, coverage checks to add, leverage ranking by cheapest valid oracle |
| `portfolio-evaluation.md` | Independent evaluation, finding disposition, gaps queued, biases for a human |
| `evidence/<slug>.md` | One per record |

An existing check never removes a property from the catalog. Catalog the property,
link the check, and mark its status `unaudited`. Adequacy verdicts belong to
`/testing:invariant-test-review` for tests and
`/low-level-systems:defensive-assertions-and-invariant-guards` for production
guards.

## Pipeline

1. **Scope survey.** Module sizes, test inventory, docs, assertion density.
2. **Lens passes**, in parallel, one attention focus each; wildcard runs last and
   deliberately hunts outside the others' territory. Each writes its findings to
   `_lenses/<lens>.md` in the part directory and returns a short summary only.
3. **Synthesis.** One agent reads the lens files and writes `catalog.md`,
   `existing-checks.md`, and `fault-map.md`.
4. **Evidence.** Agents write `evidence/<slug>.md` per record.
5. **Evaluation.** A fresh-context agent that has not seen the discovery reasoning
   evaluates the portfolio through four lenses: harness fit, coverage balance,
   implementability, wildcard. It classifies every finding as gap, refinement, or
   bias.
6. **Disposition.** Refinements applied, gaps queued, biases surfaced to a human.
7. **Verification.** Mechanical: records equal index rows equal evidence files, all
   links resolve, no schema gaps, semantics distribution recorded.

`_lenses/` is working material, not a deliverable. It stays for traceability.
