# User simulator

`src/usersim/` sends each scripted user turn of a run. The compiled scenario
is the hidden script: the user-sim delivers its probe, paste, and plain task
turns verbatim, and writes a short reply in front of the script text for the
turns the behaviour plan marks. A Haiku 5.5 call through the capture proxy
(component `user-sim`, asserted by header) writes each reply, bounded by the
pre-registered turn deadline, which the host prompt then shares; the persona
and the label's instruction go in the system prompt, and the agent's last
reply and the script text that follows the reply go in the user message as
quoted data, with any `>>>` in them spaced so the quote cannot close
itself. A conveyance, update, or reversal turn
carries a ledger fact, so its prompt leaves the script text out, and a
probe turn gets no reply at all. The prompt also forbids the reply to deny,
withdraw, or restate anything the agent attributes to the user, or to ask
the agent to forget anything, so a reply never undoes a conveyed fact; the
`usersim-1` smoke run showed a pushback disowning a rule the user had
conveyed before this instruction existed.

## Behaviour plan

`behaviourPlan(turns, prereg, seed)` labels every user turn from a seeded
stream, so every arm of one seed gets the same plan. Each label is one of
`task`, `pushback`, `interrupt`, `redirect`, `abandon`, `clarify`, or
`paste`. Rounded quotas from the pre-registered `user_sim.rates` (revision
6) pick, in order:

| Label | Per | Eligible turns | Effect |
|---|---|---|---|
| `paste` | every paste turn | `paste` role | The compiled paste, verbatim |
| `abandon` | session | the first of a session's trailing filler turns, after the last turn a fault fires at | A reply that drops the work; the later trailing fillers are never sent |
| `redirect` | session | a filler turn after the first | A change of direction, then the task |
| `interrupt` | delivered turn | filler turns | The task, then a hard abort through the host's abort path after a delay drawn from `user_sim.interrupt_after_ms` |
| `pushback` | delivered turn | filler, conveyance, update, and reversal turns after the first | A challenge to the agent's last reply, then the script text |

Probe turns stay `task` and are never skipped, interrupted, or prefixed, so
the compiled cue and probe text reach the agent unchanged. A conveyance
keeps its compiled text after any pushback, so each ledger fact is conveyed
once in its compiled manner, by the script text alone. At delivery, a `task` filler turn whose
agent reply ended with a question becomes `clarify`, and the reply answers
it. Over the whole S seed 101 scenario the plan gives pushback 45.7%,
interrupt 4.5%, and redirect and abandon 6% of 50 sessions, inside every
band.

An interrupt aborts Pi through its RPC `abort` command and OpenCode through
`session.abort`, then waits for the turn to drain. The turn ends `ok` with
`interrupted: true` when the abort landed: Pi's last assistant message
stopped with `aborted`, or OpenCode's `session.abort` answered `true`. An
agent that finished before the delay, or an abort that was refused or lost,
leaves the turn reported as it ended, and the journal label `task` with
`scheduled: "interrupt"`, so the journaled labels and the realised interrupt
rate count only the turns that were aborted. A turn a fault fires at is
never skipped by an abandon and never interrupted, and for a provider fault
neither is any later turn of its session, so the fault meets that turn's
agent call and runs to its own outcome.

## Tape and divergence

The first arm of the run's order is the reference. Each reply is keyed by
seed, event, label, the scripted text, and the session's context: the
chained digests of the agent's last reply before each turn so far (the last
agent call of the session whose response carried text, after the
pre-registered normalisation `divergence_policy.normalisation`: ISO-8601
timestamps, durations, pids, temp paths, run ids). Two arms, or two runs,
whose agent outputs matched through the session so far share a key, so the
later one replays the earlier one's reply; an output that differed anywhere
earlier in the session gives another key. `<run>/tape.jsonl`
records every reply, replayed ones included; `--tapes` adds earlier runs'
tapes to replay from; each must exist with its `pairing.jsonl` and
`manifest.json` beside it, come from the run's seed, scenario, and
pre-registration, and hold whole rows. A reply whose key is on the tape is replayed with no model call. The
proxy record keeps the first 262,144 characters of a reply; a cut reply is
keyed by the digest of its whole text as well, so replies that differ only
past the cut never pair, and its label and persona prompt read the recorded
tail. A cut last line in either log, left by a kill mid-append, is dropped on
the next open and the log cut back to it; a complete line that does not
parse is refused.

Before each turn the user-sim appends a record to `<run>/pairing.jsonl`:
arm, session, event, index, label, the digest, a hash of the agent-visible
prefix (the session's agent replies and user texts so far), the hash
of the delivered text, and its source (`script`, `tape`, or `live`). When a
non-reference arm's digest first differs from the reference arm's at the
same event, a `divergedAt` record with the index and both digests comes
first; from that turn on the arm's context differs from the reference's, so
its replies come from an arm or run that shared its outputs, or from a live
call. In a replay (`--tapes`), the pairing logs beside the replayed tapes
give each arm's recorded digests; an arm whose session context (its chained digests so far) matches none of
their recorded turns gets a `divergedAt` record with `against: "recorded"`,
ahead of the comparison with its reference arm; a skipped turn is compared
too. A reply that is empty, that stopped for any reason other than `end_turn`
or `stop_sequence` (`max_tokens`, a guardrail or content filter, a context
window overflow), or that carries a probe-announcement marker or a ledger
key is replaced by a fixed line for its label, and the record lists the
cause in `fallback`.
The whole delivered text is checked against the markers again before it is
sent, and a hit stops the run.

The prefix hash chains each record's prefix and delivered-text hashes with
the hash of the next agent reply (the session's last agent call that
carried text), so a resumed arm continues it from the pairing log.

`pairingMismatches(records, reference)` lists the sessions where an arm's
delivered text differs from the reference arm's before the recorded
divergence index. `scripts/pairing-check.ts <run>` reports those
mismatches, the divergences, each arm's reply sources and fallbacks, probe
or paste text that differs from the script, non-filler turns left unsent,
and each arm's rates; it exits 1 on any of them or on a rate outside its
band.

## Journal

The scheduler journals each turn's `UserTurn` (session, label, `delivered`,
and `interrupted`) before its `EndTurn`, so a resume that reads the
`EndTurn` as the whole turn has the user record too, and each arm's
`UserSimRates` before its `EndArm`: the rates over the turns it delivered
and the rates outside their band. A run cut short of its scenario can leave
a band and is flagged, and `scripts/pairing-check.ts` fails a run that lacks
an arm's `UserSimRates`. The P14 grader reads the `UserTurn` labels of the session, since a
replayed reply makes no model call.

## A/A control

An arm label `<arm>~<tag>`, with a lowercase alphanumeric tag such as
`host~aa`, runs as `<arm>` under its own label, with its own directories,
journal entries, and call records (`armBase` and `CONTROL_LABEL` in
`src/hosts/arms.ts`). `--arms host,host~aa` runs it right after its arm,
one control per arm, and only for a pair the tier pre-registers in
`aa_controls.pairs` (S and M); the oracle loader and the A/A report hold a
manifest order to the same rule, adjacency included (`requireOrder`). A control's reference arm is its own arm,
so its divergence records and tape replies pair it with that arm; every
other arm's reference is the first of the order. Both arms of a pair share
the scenario, the behaviour plan, and the tape, so the control measures
the noise the agent and the user-sim add on their own. `grade-run.ts`
judges a control of `host` against nothing, and P7 grades, which come from
judgments against the host arm, stay out of the A/A pairing.

`scripts/aa-report.ts <run>` reads the run's graded items and, for each
control, pairs every item both arms graded. It takes the run path only as
a directory itself (a symlink is refused), holds the run's lease while
it reads, opens `grades.jsonl` only as a regular file (`GradeLog` repairs a
cut last line in place), requires the journal complete for the manifest order and the
scheduled events (`requireComplete`, as `grade-run.ts` does), checks each
pairing record's shape and arm (`readPairing`, which
`pairing-check.ts` shares, refusing a corrupt terminated line), requires a
turn record from each arm of the pair for every scheduled user turn, refuses a
control whose delivered text differed from its arm's before its recorded
divergence (`pairingMismatches`, the check `pairing-check.ts` runs), checks each
latest grade's arm, item, probe type, and version against the run, refuses
a run graded under another pre-registration or whose scenario no longer
hashes to the manifest's digest, requires the manifest's tier and seed to
match the compiled scenario's, and records the pre-registration hash it
used. It reports, per arm and leaving P7 aside, the excluded grades and
the probes the run reached that the arm has no grade for, and the items
graded on one side only, which pair nothing. A grading run cut short converges on its rerun: the rerun grades
every item again and the report pairs each side's latest grade. For each metric,
verdicts as `<type>.pass` and each numeric grade metric, it reports the
mean difference with a percentile bootstrap interval that resamples the
family's pre-registered `cluster_key`: ledger facts for item-level
families, and the run itself for run-level families (P13, P14), which one
run therefore leaves uninformative. The bootstrap uses the pre-registered
`bootstrap` replicates and seed. A metric over fewer than five clusters
is listed as uninformative and decides nothing. Over the rest it
reports whether every interval covers zero (`null` when no metric is
informative) and the metrics whose interval misses it against the five
percent expected by chance, the share of paired items whose verdicts
differ (the disagreement rate), and how many sessions diverged at which
index. It stages `<run>/aa.json` under an exclusive create beside it and
renames it into place. A
divergence is recorded against the control's arm or, under
`--tapes`, against the control's own recorded run; either way the control
stops sharing its arm's taped replies from that turn, so both count. The
report describes one run; the five pre-registered M repeats are a claim
for their aggregation, which this script does not make. M7 applies each
family's own pre-registered interval method; this report uses the cluster
bootstrap for every metric.

## Limits

- The persona writes only the reactive part of a turn; the task wording is
  the compiled script.
