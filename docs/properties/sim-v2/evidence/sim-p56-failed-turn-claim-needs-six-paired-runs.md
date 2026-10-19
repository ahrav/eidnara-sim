# sim-p56-failed-turn-claim-needs-six-paired-runs

Evidence status: PROPOSED. SIM-P56, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A dependability verdict on failed turns or hangs is emitted only with at least
six paired runs; below that the verdict is `insufficient-runs(k)`.

`src/prereg/validate.test.ts` constructs a run-level gate below six paired
runs, which `validatePreregistration` refuses, and a report verdict below the
family's floor, which `checkReport` refuses unless it is `insufficient-runs`.

M7 (#1032) answers `insufficient-runs(k)` for a run-level gate with a paired
claim below its family's registered floor, which the validator keeps at six or
more for such gates (a bound gate such as S dependability registers two and
answers `within-bound` or `failed-gate`); a test
checks four runs against the floor of six, six runs give a sign-test verdict,
and six runs against a registered floor of eight give `insufficient-runs(6)`.

## Failure scenario

A run-level claim is made from one or two runs.

## Timing windows and dependencies

None.

## What a test must construct

A tier with fewer than six paired runs.

## Investigation log

### Q: See the record
- Sources examined: spec #1007 Open Questions; the M0 pre-registration files.
- Findings: The S tier gates failed turns, internal-string hits, and p95 latency delta as
  `zero-tolerance` and `threshold` families, each comparing every run to a
  fixed bound with no paired interval, because the S ticket (#1034) stops the
  pipeline on any of them. The validator exempts such bound gates from the
  six-run floor and refuses them a paired interval method. Whether a bound
  gate at S fits the spec's "S and M run-level numbers are descriptive" is a
  design decision (needs human input).
- Missing evidence: a harness run that exercises the record.
- Conclusion: needs human input
