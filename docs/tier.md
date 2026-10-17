# Tier command

`scripts/tier.ts --tier S --out <dir> [--hosts pi,opencode] [--turn-ms N]
[--plan-only]` runs one tier end to end. It compiles each seed's scenario,
plans one run per pre-registered host and seed, builds the vendored
libfaketime once as a supervised child (`<dir>/faketime.log`), starts
the runs in parallel, grades each one, reports
its A/A pairs, and writes the tier report. A run whose journal already
holds `EndRun` is complete and is graded and reported as it finished. A
job that fails in orchestration stops the sibling runs before the command
exits. A run whose directory another process holds (`lease.json` with a
live pid) is left ungraded, kept out of the report, and fails the
command. `<dir>/tier-plan.json` holds
the plan and `<dir>/tier-result.json` the outcome of each run, with the
run's own wall time and whether it exceeded the tier's wall budget; each
run directory keeps its `tier.log`. The command exits 1 when any run,
grading, A/A report, or the tier report fails or any run exceeded
`liveness_bounds.tier_wall_budget_ms` (SIM-L03) or the report's
property witness holds a violated record, and 2 on a malformed flag, a
plan where no session fits the budget, a plan whose prefix, arms, host,
or seed differ from what a run with a manifest ran, an unreadable
`tier-plan.json` with no `--turn-ms` to replace it, an `--out` resolving
(symlinks included) inside the Eidnara checkout, a generated directory
(`scenarios-<seed>`, a run) that is a symlink, or an output directory
another invocation holds (`<dir>/lease.json`). Every exit, a thrown setup
error or a signal during setup included, releases that lease. SIGINT, SIGTERM, or
SIGHUP to the command reaches every child it started, SIGKILLs any still
live a minute later together with its descendants, and starts no further
grading or report; each run tears down and stays resumable.

A seed's scenario is compiled once into `<dir>/scenarios-<seed>/` and
copied into each new run directory. A cached scenario whose body no
longer hashes to its `scenario_hash`, or compiled from another generator
version, pre-registration, or corpus (the bytes of the manifest, fact
bank, repository list, distributions, and tool outputs), is refused for a
new run; a run that already has a manifest keeps the
scenario it ran. The libfaketime build's download,
extraction, and compilation each end within ten minutes; invocations
serialise on a lease over `vendor/build`, and the finished tree is
renamed into place, so another command sees a complete library or none.

## Plan

Each run gets its seed's pre-registered arm order. The A/A controls
(`<arm>~aa` for every pair in `aa_controls` whose arm is in the order)
ride on exactly `aa_controls.repeats` of the runs, seeds varying first so
they spread across hosts, each control right after its arm as the run's
manifest orders them, which is the count the report's completeness
check wants; a host and seed selection planning fewer runs than that
exits 2. Every arm of every run runs the same prefix of the scenario: the
longest one that ends on a session end and whose user turns, at
`--turn-ms` each (45 to 75 s on Pi with Opus 5.5 in the S smoke runs),
fit 85% of the tier's `liveness_bounds.tier_wall_budget_ms` once per arm
of the run with the most arms. The rest of the
budget covers setup and the turns' spread. A run's wall time is its
journaled `StartRun` to `EndRun`, read after the run child exits, across
resumptions. A run that finishes past
the budget fails the command; one still going at 125% of the budget is
stopped with SIGTERM, and with SIGKILL a minute later if its teardown
stalls; it stays resumable, with what remains of the limit. Grading and the A/A report run under the same
125% limit. Rerunning the command resumes every run from its journal;
without `--turn-ms` it reuses the `turn_ms` of the existing
`tier-plan.json`, so the planned prefixes match the manifests. Every run
that wrote a manifest is graded and reported, including one stopped at
the limit; grading leaves the grades that already cite their snapshot, so
a rerun spends no judge calls on finished items. The report's
run-conditions panel gives the events each run reached against its plan.

The prefix is a cap on the pre-registered scenario, so a tier report
covers fewer items than the pre-registered `paired_items_per_probe_type`;
the report's n and detectable differences say how few. The capped prefix
also cannot match whole-scenario user-sim rates, so the property witness
marks SIM-P10 unreached.

## Report

After the runs, `scripts/report.ts` writes `<dir>/report-<tier>.md` and
`report-<tier>.json`, which add a property-witness panel to the panels in
`docs/report.md`. For each record of `docs/properties/sim-v2/catalog.md`,
it is:

- `witnessed` when a run-level check found instances and every one held;
- `violated` when a check found a failing instance, which it names;
- `unreached` when the check found no instance;
- `unchecked` when the record has no run-level check.

The panel lists records by id, without their catalog names.

The run-level checks cover:

- SIM-P02 and SIM-P03: pairing before divergence over turns below their
  arm's divergence that have a reference counterpart, each delivered as
  its counterpart was and both journaled as sent, divergence records
  (those whose turns are on the log) ahead of their turn carrying
  the two turns' digests (a replayed run's against the digest its source
  tape's pairing log recorded, which must be present and must still hash
  to the `tape_pairing_sha256` the run's manifest took at its start), and
  no turn whose
  context digest differs
  from its reference arm's without a divergence record;
- SIM-P04: a divergence occurred;
- SIM-P10: user-sim rates recomputed from the journaled turn labels
  inside their bands, with the journaled `UserSimRates` summary equal to
  the recomputation, over the completed arms (those with that entry) of
  uncapped runs;
- SIM-P11, SIM-P12, and SIM-P14: the journal's order, idle jumps, and
  scheduled jumps (each from the arm's clock before it), from
  `checkJournal` over the entries in `seq` order, a repeated or
  non-integer `seq` counting as a break;
- SIM-P15: proxy records carry both times, with wall time in `seq` order
  per arm, a receipt time that is finite and at or before completion and
  that the journal has begun by, and each call's scenario time within 5 s
  of the clock the arm's journal implies at the call's start (wall pace
  while a turn or job is open, closed by `EndTurn`, `EndJob`, or the
  interrupted `ItemState` a resume writes, held while idle, jumping where
  an entry says);
- SIM-P25: every user turn has a label;
- SIM-P30: every observed fault was scheduled, and every injected call
  names a scheduled fault (from the manifest's `fault_override` when the
  run had one) fired before it, before its trigger session ended, and
  within a bounded fault's count of eligible agent calls since it fired,
  injected or not; the injected calls are the instances, so a run with
  scheduler faults alone is unreached;
- SIM-P41: every reached probe has a snapshot, set once, after the
  probe's first `EndTurn` and before any later turn, every snapshot
  belongs to a reached probe, and every persisted
  grade, earlier versions included, cites a journaled snapshot of its
  item;
- SIM-P42: grade versions are positive integers that only increase, the
  report grades at the latest version (for a P7 row, the latest of its
  judgment, by inputs), and the panel names the versions used;
- SIM-L03: each completed run's wall time from `StartRun` to `EndRun`,
  both finite and in order, is inside the tier's wall budget.

SIM-P10 is checked over the uncapped runs and unreached when every run
is capped. The liveness records SIM-L01 and SIM-L02 appear as unchecked.

## Sandbox labels

A control label puts a tilde inside run paths (`<run>/host~aa/r`). The
sandbox launcher passes paths and values to a shell, so it accepts a
tilde only inside a word, never at a word's start or after `:` or `=`,
where a shell would expand it.
