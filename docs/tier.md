# Tier command

`scripts/tier.ts --tier S --out <dir> [--hosts pi,opencode] [--turn-ms N]
[--plan-only]` runs one tier end to end. It compiles each seed's scenario,
plans one run per pre-registered host and seed, starts the runs in
parallel, grades each one, reports its A/A pairs, and writes the tier
report. `<dir>/tier-plan.json` holds the plan and `<dir>/tier-result.json`
the outcome of each run; each run directory keeps its `tier.log`.

## Plan

Each run gets its seed's pre-registered arm order plus an A/A control
(`<arm>~aa`) for every pair in `aa_controls` whose arm is in the order.
Every arm runs the same prefix of the scenario: the longest one that ends
on a session end and whose user turns, at `--turn-ms` each (45 to 75 s on
Pi with Opus 5.5 in the S smoke runs), fit 85% of the tier's
`liveness_bounds.tier_wall_budget_ms` once per arm. The rest of the
budget covers setup and the turns' spread. A run still going at 125% of
the budget is stopped with SIGTERM and stays resumable; rerunning the
command resumes every run from its journal.

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
- `unreached` when the check found no instance, or the record has no
  run-level check.

The run-level checks cover:

- SIM-P02 and SIM-P03: pairing before divergence, and divergence records
  ahead of their turn;
- SIM-P04: a divergence occurred;
- SIM-P10: user-sim rates inside their bands, on uncapped runs only;
- SIM-P11, SIM-P12, and SIM-P14: the journal's order, idle jumps, and
  scheduled jumps, from `checkJournal`;
- SIM-P15: proxy records carry both times;
- SIM-P25: every user turn has a label;
- SIM-P30: every observed fault was scheduled;
- SIM-P41: each item's snapshot is set once;
- SIM-P42: grade versions only increase.

## Sandbox labels

A control label puts a tilde inside run paths (`<run>/host~aa/r`). The
sandbox launcher passes paths and values to a shell, so it accepts a
tilde only inside a word, never at a word's start or after `:` or `=`,
where a shell would expand it.
