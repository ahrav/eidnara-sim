# Tier command

`scripts/tier.ts --tier S --out <dir> [--hosts pi,opencode] [--turn-ms N]
[--resize-from <M tier dir>] [--restart-at <fraction>] [--plan-only]` runs one tier end to end. It compiles each seed's scenario,
plans one run per pre-registered host and seed, builds the vendored
libfaketime once as a supervised child (`<dir>/faketime.log`), starts
the runs in parallel, grades each one, reports
its A/A pairs, and writes the tier report. A run whose journal already
holds `EndRun` is complete and is graded and reported as it finished. A
job that fails in orchestration stops the sibling runs before the command
exits. A run whose directory another live process holds (its highest
`lease.<n>.json` unreleased, read before the run and again before
grading; grading and the A/A report each take the run's own lease) is
left ungraded, kept out of the report, and fails the command. A child's log (`tier.log`, `faketime.log`,
`report.log`) is opened once without following symlinks and held for the
child's life. The report child runs under the same 125% limit. `<dir>/tier-plan.json` holds
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
(`scenarios-<seed>`, a run) that is a symlink, every run directory being
checked before any run starts, or an output directory another invocation
holds (`<dir>/lease.<n>.json`). `tier-plan.json` and `tier-result.json` are
staged under a name created exclusively and renamed in. Every exit, a thrown setup
error or a signal during setup included, releases that lease. SIGINT, SIGTERM, or
SIGHUP to the command reaches every child it started, SIGKILLs any still
live a minute later together with its descendants, and starts no further
grading or report; each run tears down and stays resumable.

A seed's scenario is compiled once into `<dir>/scenarios-<seed>/` and
copied into each new run directory. A cached scenario whose body no
longer hashes to its `scenario_hash`, or compiled from another generator
version, pre-registration, or corpus (the bytes of the manifest, fact
bank, repository list, distributions, and tool outputs, as one digest of
the bytes the compiler read), is refused. The libfaketime build's
download, extraction, and compilation each end within ten minutes; each
build runs in a staging directory of its own under `vendor/build` and
renames the finished library into place, so another command sees a
complete library or none. The embedding cache's
directory, `runs/scenarios/`, is created before the first compilation.

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

A scheduled fault whose trigger session lies past the prefix moves into
it (`compressFaults`): the faults keep their order and spread evenly over
the prefix's sessions, each onto the first session from its place that
has enough user turns for a turn-triggered fault, or that is in the p90
regime (else the longest session) for a summarizer-triggered one; a
session-start fault never lands on the prefix's first session, as the
compiler never schedules one there. The
moved schedule goes to `<run>/faults.json` and the run's `--faults`, so
the manifest records it; a fault no prefix session can host keeps its
trigger and stays untriggered.

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
  to the `tape_sha256` digest of tape and pairing log the run's manifest
  took at its start), and
  no turn whose
  context digest differs
  from its reference arm's without a divergence record;
- SIM-P04: a divergence occurred, its turn on the pairing log;
- SIM-P10: user-sim rates recomputed from the journaled turn labels
  inside their bands, with the journaled `UserSimRates` summary equal to
  the recomputation, over the completed arms (those with that entry) of
  uncapped runs;
- SIM-P11, SIM-P12, and SIM-P14: the journal's order, idle jumps, and
  scheduled jumps (each from the arm's clock before it), from
  `checkJournal` over the entries in `seq` order, a repeated or
  non-integer `seq` counting as a break;
- SIM-P15: proxy records (every record on `calls.jsonl`, one naming an
  arm outside the run being a violation) carry both times, each with a
  fresh integer `seq` across the run, with wall time in `seq` order across
  the run, a receipt time that is finite and at or before completion and
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
  item whose record is still on the arm's `snapshots.jsonl`;
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

## M and L profiles

After its paired runs finish, a tier runs the profiles its pre-registration
calls for, all of one profile in parallel and each reported apart under
`<dir>/<profile>/`, so a profile's load never overlaps the paired runs.
Every profile run takes the first seed's paired-run prefix, so it covers
the paired runs' items. `tier-result.json` gives each profile's start skew
from its runs' first journal entries:

| Tier | Profile | Runs |
|---|---|---|
| M | `side-haiku` | Per host, the first seed's `host` and `eidnara` arms with Eidnara's summarizer and researcher calls on Haiku 5.5 (`--side-model`), the model factor against the paired runs' Opus |
| M | `usersim-luna` | One Pi run of the first seed's `host` and `eidnara` arms with `gpt-5.6-luna` as the user-sim (`--user-sim-model`) |
| L | `concurrent` | Per host, each arm of the first seed alone in its own run (`<dir>/L-301-<host>-concurrent/<arm>`), all started together |

M's six paired runs (three seeds on two hosts) each carry `host~aa` and
`eidnara~aa`, which gives six repeats of each A/A pair.

L starts only after `<dir>/L-resizing.json` records its paired items per
probe type. `--resize-from <M tier dir>` computes it from the M tier's
paired runs, the `main` group of its `tier-plan.json`, and refuses while
any of them is ungraded, so the profiles' changed models never enter it.
It applies the pre-registered rule (`src/run/resize.ts`) to each
superiority and noninferiority item metric:
the discordance M observed, the ledger-fact design effect from M's
intraclass correlation, and the n that reaches the family's L effect at
its power, with Holm's first step over the harm family's metrics; L's count is the
largest n, and a type M never saw discordant keeps the planning count.
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
journaled as skipped. A run with an `eidnara-cf` arm stops at start when
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

## XL

XL runs one seed per host with `host` and `eidnara`. Its scenario's fault
schedule adds `host_upgrade` and `two_hosts_one_daemon` (`docs/hosts.md`).
Each XL paired run is stopped once with SIGTERM when its journal holds
`--restart-at` (0.4 by default at XL, a fraction in [0, 1)) of its planned
events across its arms, checked every 30 s, and resumed from its journal
within the rest of its wall limit. The restart writes `<run>/restarted`,
so a rerun of the command neither restarts that run again nor reports it
unrestarted; `tier-result.json` records `restarted` per run, and the
command exits 1 naming any paired run without a restart.
A run stopped by the scheduled restart logs no `EndTurn` for the turn the
stop cut, so the resumed run marks that turn `failed(interrupted)`.

The XL report adds a within-month RSS soak verdict per month of scenario
time for each daemon arm, the last month partial: each
month's slope, bound, and return-to-baseline use that month's samples and
sessions alone, and the whole-span soak verdict stays the gate's input.

`scripts/report.ts --recall-reference <dir>/continuity-L.json` adds a recall
drift table to the XL report: each host, arm, and probe's P8 or P9 pass
rate against the L tier's 95% Clopper-Pearson interval for the same row,
`drift` when outside it. Every report writes its continuity rows to
`continuity-<tier>.json` beside `report-<tier>.json` for this use.
