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
regime (else the longest session) for a summarizer-triggered one. The
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

Beside its paired runs, a tier runs the profiles its pre-registration
calls for, each reported apart under `<dir>/<profile>/`:

| Tier | Profile | Runs |
|---|---|---|
| M | `side-haiku` | Per host, the first seed's `host` and `eidnara` arms with Eidnara's summarizer and researcher calls on Haiku 5.5 (`--side-model`), the model factor against the paired runs' Opus |
| M | `usersim-luna` | One Pi run of the first seed's `host` and `eidnara` arms with `gpt-5.6-luna` as the user-sim (`--user-sim-model`) |
| L | `concurrent` | Per host, each arm of the first seed alone in its own run (`<dir>/L-301-<host>-concurrent/<arm>`), all started together on the paired runs' prefix; `tier-result.json` records the start skew |

M's six paired runs (three seeds on two hosts) each carry `host~aa` and
`eidnara~aa`, which gives six repeats of each A/A pair.

L starts only after `<dir>/L-resizing.json` records its paired items per
probe type. `--resize-from <M tier dir>` computes it from the graded M
runs with the pre-registered rule (`src/run/resize.ts`): per probe type,
the discordance M observed, the ledger-fact design effect from M's
intraclass correlation, and the n that reaches the family's L effect at
its power, with Holm's first step for the harm metrics; L's count is the
largest n, and a type M never saw discordant keeps the planning count.
The L scenarios are compiled with that count.

## Counterfactual arm

L's `eidnara-cf` arm runs like `eidnara` except before each turn the
scenario's `cf_deletions` names: there it deletes from the live store
every memory note that carries the sampled P1, P3, or P5 fact (a note
sharing a four-word run with the fact's statement, or holding one of its
distinctive values) with the note's deliveries, reads back how many such
notes remain, and journals both as `CounterfactualDeletion`. The report's
counterfactual panel gives the attribution rate: of the sampled items the
`eidnara` arm passed, the share the counterfactual arm fails, with a
Clopper-Pearson interval.
