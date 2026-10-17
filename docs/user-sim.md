# User simulator

`src/usersim/` sends each scripted user turn of a run. The compiled scenario
is the hidden script: the user-sim delivers its probe, paste, and plain task
turns verbatim, and writes a short reply in front of the script text for the
turns the behaviour plan marks. A Haiku 5.5 call through the capture proxy
(component `user-sim`, asserted by header) writes each reply; the persona
prompt carries the label's instruction, the agent's last reply, and the
script text that follows the reply. A conveyance, update, or reversal turn
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
| `abandon` | session | the first of a session's trailing filler turns | A reply that drops the work; the later trailing fillers are never sent |
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
`interrupted: true`; an agent that finished before the delay leaves the
journal label `task` with `scheduled: "interrupt"`, so the journaled labels
and the realised interrupt rate count only the turns that were aborted.

## Tape and divergence

The first arm of the run's order is the reference. Each reply is keyed by
seed, event, label, and the digest of the agent's last reply (the last
agent call of the session whose response carried text) after the
pre-registered normalisation (`divergence_policy.normalisation`: ISO-8601
timestamps, durations, pids, temp paths, run ids). `<run>/tape.jsonl`
records every reply the run delivered, replayed ones included; `--tapes`
adds earlier runs' tapes to replay from. A reply whose key is on the tape
is replayed with no model call.

Before each turn the user-sim appends a record to `<run>/pairing.jsonl`:
arm, session, event, index, label, the digest, a hash of the agent-visible
prefix (the session's agent replies and user texts so far), the hash
of the delivered text, and its source (`script`, `tape`, or `live`). When a
non-reference arm's digest first differs from the reference arm's at the
same event, a `divergedAt` record with the index and both digests comes
first. From then on that session's reply keys also carry the arm, so the
arm's replies come from a replay of its own recorded run or from a live
call. An arm that has not diverged reuses its reference arm's replies, and
through it the replies of the arm that reference reuses. In a replay
(`--tapes`), the pairing logs beside the replayed tapes give each arm's
recorded digests; an arm whose digest first differs from its own recorded
one gets a `divergedAt` record with `against: "recorded"`, ahead of the
comparison with its reference arm. A reply that is empty, cut at `user_sim.max_tokens`, or carries a
probe-announcement marker or a ledger key is replaced by a fixed line for
its label, and the record lists the cause in `fallback`.
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
and `interrupted`) after its `EndTurn`, and each arm's `UserSimRates` before
its `EndArm`: the rates over the turns it delivered and the rates outside
their band. A run cut short of its scenario can leave a band and is
flagged. The P14 grader reads the `UserTurn` labels of the session, since a
replayed reply makes no model call.

## A/A control

An arm label `<arm>~<tag>`, such as `host~aa`, runs as `<arm>` under its own
label, with its own directories, journal entries, and call records
(`armBase` in `src/hosts/arms.ts`). `--arms host,host~aa` runs it right
after its arm, once, and only for a pair the tier pre-registers in
`aa_controls.pairs` (S and M). A control's reference arm is its own arm,
so its divergence records and tape replies pair it with that arm; every
other arm's reference is the first of the order. Both arms of a pair share
the scenario, the behaviour plan, and the tape, so the control measures
the noise the agent and the user-sim add on their own. `grade-run.ts`
judges a control of `host` against nothing, and P7 grades, which come from
judgments against the host arm, stay out of the A/A pairing.

`scripts/aa-report.ts <run>` reads the run's graded items and, for each
control, pairs every item both arms graded. For each metric, verdicts as
`<type>.pass` and each numeric grade metric, it reports the mean
difference with a percentile bootstrap interval that resamples ledger
facts (the pre-registered `cluster_key`), using the pre-registered
`bootstrap` replicates and seed. A metric over fewer than five ledger
facts is listed as uninformative and decides nothing. Over the rest it
reports whether every interval covers zero and the metrics whose interval
misses it against the five percent expected by chance, the share of paired items whose verdicts
differ (the disagreement rate), and how many sessions diverged at which
index. With fewer than five pre-registered A/A repeats the result is
descriptive. M7 applies each family's own pre-registered interval method;
this report uses the cluster bootstrap for every metric. It writes
`<run>/aa.json`.

## Limits

- The persona writes only the reactive part of a turn; the task wording is
  the compiled script.
