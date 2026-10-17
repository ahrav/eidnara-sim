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
inconclusive, insufficient-runs, and descriptive, and the string `parity` is
absent from every report.

M7 (#1032) emits, per metric, better, worse,
no-difference-above-X-detectable-at-n, inconclusive, insufficient-runs(k),
within-bound, failed-gate(metric, ids), or descriptive for a family whose
pre-registration names no interval method, and refuses any evaluation whose
output contains the word parity; a test scans its fixture verdicts. The
report check (`src/prereg/report.ts`) expects one family-level verdict from
this vocabulary, `descriptive` exactly for a descriptive-claim family, while
the gate's family result carries per-metric verdicts and `passed: null` for
such a family; the translation from metric verdicts to one family verdict is
the report path's part (#1033) and is unresolved here.

## Failure scenario

A null at small n is read as equivalence.

## Timing windows and dependencies

None.

## What a test must construct

Any tier report.

## Investigation log

### Q: See the record
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: The verdict vocabulary adds three kinds to the spec index's four:
  `inconclusive` from the M7 statistics ticket (#1032), `insufficient-runs`
  from SIM-P56, and `descriptive` for a family the pre-registration does not
  gate. Whether the spec index should list them is a design decision (needs
  human input).
- Missing evidence: a harness run that exercises the record.
- Conclusion: unresolved, needs a harness run
