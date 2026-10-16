# Tier command

`scripts/tier.ts --tier S --out <dir> [--hosts pi,opencode] [--turn-ms N]
[--plan-only]` runs one tier end to end. It compiles each seed's scenario,
plans one run per pre-registered host and seed, starts the runs in
parallel, grades each one, reports its A/A pairs, and writes the tier
report. `<dir>/tier-plan.json` holds the plan and `<dir>/tier-result.json`
the outcome of each run; each run directory keeps its `tier.log`. The
command exits 1 when any run, grading, A/A report, or the tier report
fails, and 2 on a malformed flag or a plan where no session fits the
budget. SIGINT, SIGTERM, or SIGHUP to the command reaches every child it
started, SIGKILLs any still live a minute later, and starts no further
grading or report; each run tears down and stays resumable.

## Plan

Each run gets its seed's pre-registered arm order plus an A/A control
(`<arm>~aa`) for every pair in `aa_controls` whose arm is in the order.
Every arm runs the same prefix of the scenario: the longest one that ends
on a session end and whose user turns, at `--turn-ms` each (45 to 75 s on
Pi with Opus 5.5 in the S smoke runs), fit 85% of the tier's
`liveness_bounds.tier_wall_budget_ms` once per arm. The rest of the
budget covers setup and the turns' spread. A run still going at 125% of
the budget is stopped with SIGTERM, and with SIGKILL a minute later if its
teardown stalls; it stays resumable. Rerunning the command resumes every
run from its journal; without `--turn-ms` it reuses the `turn_ms` of the
existing `tier-plan.json`, so the planned prefixes match the manifests.
Every run that wrote a manifest is graded and reported, including one
stopped at the limit; the report's run-conditions panel gives the events
each run reached against its plan.

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

- SIM-P02 and SIM-P03: pairing before divergence, divergence records
  ahead of their turn, and no turn whose context digest differs from its
  reference arm's without a divergence record;
- SIM-P04: a divergence occurred;
- SIM-P10: user-sim rates inside their bands, on uncapped runs only;
- SIM-P11, SIM-P12, and SIM-P14: the journal's order, idle jumps, and
  scheduled jumps, from `checkJournal`;
- SIM-P15: proxy records carry both times, with wall time in `seq` order
  per arm;
- SIM-P25: every user turn has a label;
- SIM-P30: every observed fault was scheduled;
- SIM-P41: each item's snapshot is set once, and its latest grade cites
  that snapshot;
- SIM-P42: grade versions only increase.

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

When an arm's samples span more than 30 days of scenario time, the report
adds a within-month RSS soak verdict per month of scenario time: each
month's slope, bound, and return-to-baseline use that month's samples and
sessions alone, and the whole-span soak verdict stays the gate's input.
