# sim-p53-parity-never-emitted

Evidence status: PROPOSED. SIM-P53, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

The verdict vocabulary is better, worse,
no-difference-above-X-pp-detectable-at-n, failed-gate(metric, items),
inconclusive, insufficient-runs, passed-gate, and descriptive, and the string
`parity` is absent from every report.

`src/prereg/validate.test.ts` constructs a report carrying the token `parity`,
which `checkReport` (`src/prereg/report.ts`) refuses. The report emitter lands
in M7 (#1032); no run exists yet.

M7 (#1032) emits better, worse, no-difference-above-X-detectable-at-n, inconclusive, insufficient-runs(k), within-bound, or failed-gate(metric, ids), and refuses any evaluation whose output contains the word parity; a test scans its fixture verdicts.

## Failure scenario

A null at small n is read as equivalence.

## Timing windows and dependencies

None.

## What a test must construct

Any tier report.

## Investigation log

### Q: See the record
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: The verdict vocabulary adds four kinds to the spec index's four:
  `inconclusive` from the M7 statistics ticket (#1032), `insufficient-runs`
  from SIM-P56, `passed-gate` for a bound gate every run satisfied, and
  `descriptive` for a family the pre-registration does not gate. Whether the
  spec index should list them is a design decision (needs human input).
- Missing evidence: a harness run that exercises the record.
- Conclusion: needs human input
