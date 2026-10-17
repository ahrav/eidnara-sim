# Tier command

`scripts/tier.ts --tier S --out <dir> [--hosts pi,opencode] [--turn-ms N]
[--resize-from <M tier dir>] [--models a,b] [--plan-only]` runs one tier
end to end. `--models` lists the models the runs' `model_switch` fault
cycles through; a tier whose scenarios schedule that fault refuses to start
with fewer than two distinct models, and the plan records the list. It compiles each seed's scenario,
plans one run per pre-registered host and seed, builds the vendored
libfaketime once, starts the runs in parallel, grades each one, reports
its A/A pairs, and writes the tier report. A run whose journal already
holds `EndRun` is complete and is graded and reported as it finished. A
job that fails in orchestration stops the sibling runs before the command
exits. `<dir>/tier-plan.json` holds
the plan and `<dir>/tier-result.json` the outcome of each run, with the
run's own wall time and whether it exceeded the tier's wall budget; each
run directory keeps its `tier.log`. The command exits 1 when any run,
grading, A/A report, or the tier report fails or any run exceeded
`liveness_bounds.tier_wall_budget_ms` (SIM-L03) or the report's
property witness holds a violated record, and 2 on a malformed flag, a
plan where no session fits the budget, a `--turn-ms` whose prefix differs
from one a run with a manifest ran, an unreadable `tier-plan.json` with
no `--turn-ms` to replace it, or an output directory another invocation
holds (`<dir>/lease.json`). SIGINT, SIGTERM, or
SIGHUP to the command reaches every child it started, SIGKILLs any still
live a minute later together with its descendants, and starts no further
grading or report; each run tears down and stays resumable.

A seed's scenario is compiled once into `<dir>/scenarios-<seed>/` and
copied into each new run directory. A cached scenario compiled from
another generator version, corpus manifest, fact bank, repository list,
or pre-registration is refused for a new run; a run that already has a
manifest keeps the scenario it ran. The libfaketime build's download,
extraction, and compilation each end within ten minutes.

## Plan

Each run gets its seed's pre-registered arm order plus an A/A control
(`<arm>~aa`) for every pair in `aa_controls` whose arm is in the order.
Every arm runs the same prefix of the scenario: the longest one that ends
on a session end and whose user turns, at `--turn-ms` each (45 to 75 s on
Pi with Opus 5.5 in the S smoke runs), fit 85% of the tier's
`liveness_bounds.tier_wall_budget_ms` once per arm. The rest of the
budget covers setup and the turns' spread. A run's wall time counts from
its journaled `StartRun`, across resumptions. A run that finishes past
the budget fails the command; one still going at 125% of the budget is
stopped with SIGTERM, and with SIGKILL a minute later if its teardown
stalls; it stays resumable, with what remains of the limit. Grading and the A/A report run under the same
125% limit. Rerunning the command resumes every run from its journal;
without `--turn-ms` it reuses the `turn_ms` of the existing
`tier-plan.json`, so the planned prefixes match the manifests. A group's
runs are all awaited before any of them is graded, so grading never loads
a run still inside its measurement window. Every run
that wrote a manifest is graded and reported, including one stopped at
the limit; grading leaves the grades that already cite their snapshot, so
a rerun spends no judge calls on finished items. The report's
run-conditions panel gives the events each run reached against its plan.

A scheduled fault whose trigger session lies past the prefix moves into
it (`compressFaults`): each fault's index in the schedule sets where its
search starts, spread evenly over the prefix's sessions, and the search
wraps around the prefix, so two moved faults can land in either session
order. Each lands on the first session from its start that has enough
user turns for a turn-triggered fault, that is in the p90 regime (else
the longest session) for a summarizer-triggered one, or that has an idle
gap before it for a laptop sleep, measured from the preceding session's
end, whose duration becomes that gap; a
session-start fault never lands on the prefix's first session, as the
compiler never schedules one there. The
moved schedule goes to `<run>/faults.json` and the run's `--faults`, so
the manifest records it, and the report reads the schedule from the
manifest; a fault no prefix session can host keeps its trigger and stays
untriggered.

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
  its counterpart was, divergence records
  ahead of their turn carrying
  the two turns' digests (a replayed run's against the digest its source
  tape's pairing log recorded), and no turn whose context digest differs
  from its reference arm's without a divergence record;
- SIM-P04: a divergence occurred;
- SIM-P10: user-sim rates recomputed from the journaled turn labels
  inside their bands, with the journaled `UserSimRates` summary equal to
  the recomputation, over the completed arms (those with that entry) of
  uncapped runs;
- SIM-P11, SIM-P12, and SIM-P14: the journal's order, idle jumps, and
  scheduled jumps (each from the arm's clock before it), from
  `checkJournal`;
- SIM-P15: proxy records carry both times, with wall time in `seq` order
  per arm;
- SIM-P25: every user turn has a label;
- SIM-P30: every observed fault was scheduled, and every injected call
  names a scheduled fault (from the manifest's `fault_override` when the
  run had one) fired before it, before its trigger session ended, and
  within a bounded fault's count; the injected calls are the instances,
  so a run with scheduler faults alone is unreached;
- SIM-P41: every reached probe has a snapshot, set once, after the
  probe's first `EndTurn` and before any later turn, and every grade
  cites a journaled snapshot of its item;
- SIM-P42: grade versions only increase, the report grades at the latest
  version, and the panel names the versions used;
- SIM-L03: each completed run's wall time from `StartRun` to `EndRun` is
  inside the tier's wall budget.

SIM-P10 is checked over the uncapped runs and unreached when every run
is capped. The liveness records SIM-L01 and SIM-L02 appear as unchecked.

## Sandbox labels

A control label puts a tilde inside run paths (`<run>/host~aa/r`). The
sandbox launcher passes paths and values to a shell, so it accepts a
tilde only inside a word, never at a word's start or after `:` or `=`,
where a shell would expand it.

## M and L profiles

After its paired runs finish, a tier runs the profiles its pre-registration
calls for, all of one profile in parallel and each reported apart under
`<dir>/<profile>/`, so a profile's load never overlaps the paired runs.
A profile whose runs each hold one arm of the same host and seed gets no
paired report; `tier-result.json` lists its runs under `unreported` with
`reports.<profile>` null, and the command's exit ignores a null report.
Every profile run takes the first seed's paired-run prefix, so it covers
the paired runs' items. `tier-result.json` gives each profile's start skew
from its runs' first journal entries:

| Tier | Profile | Runs |
|---|---|---|
| M | `side-haiku` | Per host, the first seed's `host` and `eidnara` arms with Eidnara's summarizer and researcher calls on Haiku 5.5 (`--side-model`), replaying the paired run's user-sim tape (`--tapes`), the model factor against the paired runs' Opus; it runs only once that paired run completed inside its budget, else `tier-result.json` records it as skipped |
| M | `usersim-luna` | One Pi run of the first seed's `host` and `eidnara` arms with `gpt-5.6-luna` as the user-sim (`--user-sim-model`) |
| L | `concurrent` | Per host, each arm of the first seed alone in its own run (`<dir>/L-301-<host>-concurrent/<arm>`), all started together; a group some of whose runs began and not all finished is refused until its run directories are removed, so a resumed member never measures alone |

M's six paired runs (three seeds on two hosts) each carry `host~aa` and
`eidnara~aa`, which gives six repeats of each A/A pair.

L starts only after `<dir>/L-resizing.json` records its paired items per
probe type. `--resize-from <M tier dir>` computes it from the M tier's
paired runs, the `main` group of its `tier-plan.json`, and refuses until
that plan is the M tier's with a run for every pre-registered host and
seed and its `tier-result.json` records a zero `run_exit` and `grade_exit`
for each of them and a zero exit for the main report, so an interrupted
run or grading, a report whose witness found a violation, a partial campaign,
and the profiles' changed models never enter it; while the M directory
holds a live lease, so a campaign still being graded never enters it; and
while the M report's campaign-completeness list holds anything besides
its CUSUM scale, so truncated runs, differing settings, or missing A/A
controls never enter it. The record names its source directory and both
pre-registration hashes; a later invocation refuses a record of another
L pre-registration, or a `--resize-from` naming another source or an M
pre-registration the record did not see. The record is written through a
rename, so a killed command leaves no partial file. Fault-asymmetric
pairs leave the discordance and design effect, as they leave the M gates.
It applies the pre-registered rule (`src/run/resize.ts`) to each
superiority and noninferiority item metric:
the discordance M observed, the ledger-fact design effect from M's
intraclass correlation, and the n that reaches the family's L effect at
its power, with Holm's first step over the harm family's metrics; L's count is the
largest n, where a type M never saw discordant counts as the planning
count, so L never falls below it.
The L scenarios are compiled with that count.

## Counterfactual arm

L's `eidnara-cf` arm runs like `eidnara`, except at the `session_start` of
each session that holds a probe the scenario's `cf_deletions` samples (P1,
P3, or P5), before the host opens. There it deletes from the live store
every memory note that carries the probe's fact, with the note's
deliveries and evaluation claims, and journals the deleted ids and a
verification read as `CounterfactualDeletion` before the next deletion
starts and before the session's first event; a resumed arm skips each
deletion already journaled.

A note carries the fact when it shares a four-word run with the fact's
statement that no other fact's statement holds, or names one of the
fact's distinctive values (a bracketed token, or one of four or more
characters with a digit or underscore, that no other statement holds) as
a whole word. The verification
read counts the notes left that match by three-word runs or values. The
delete runs through `python3`'s `sqlite3`, which registers the store's
caller-scope functions so its ownership triggers admit a delete inside
the note's own project and report no facade authority drain, so the
authority triggers stay inactive for the delete; a failed delete is
journaled as skipped, as is a store path that is a symlink or resolves
outside the arm's data directory, and the child is stopped with the arm
when the run is torn down. Each deleted note is journaled first as its own
`DeleteMemoryObject` entry with the object id, its kind, the target probe,
and the scenario time. The grader marks the arm's grade for a sampled probe whose
deletion was skipped, deleted nothing, or left matching notes as
`excluded(cf-unverified)`, so the gates never read an outcome from an
intervention of unknown effect. A run with an `eidnara-cf` arm stops at start when
`python3` is not on `PATH`.

The report's counterfactual panel counts a sampled item only when its own
run's deletion is verified: notes deleted and none left by the verification
read. The attribution rate is the share of those items the `eidnara` arm
passed that the counterfactual arm fails, with a Clopper-Pearson
interval, beside a placebo rate: the same flip share over the unsampled
P1, P3, and P5 items, where nothing was deleted. Deletions accumulate
over a run, so a later item's flip can follow an earlier deletion as
well. Memory the store keeps outside notes, such as user memories or
history summaries, stays in place.
