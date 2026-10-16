# sim-p26-user-sim-noise-floor-run-is-paired

Evidence status: PROPOSED. SIM-P26, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

The same-config paired run shares `scenario_hash` and arm config and differs
only in user-sim seed, and the report names its disagreement rate.

No harness code, test, or run exists yet. The surface lands in M6
(#1031).

## Failure scenario

The user-sim's own noise is read as a treatment effect.

## Timing windows and dependencies

None.

## What a test must construct

An A/A run at S or M, the tiers whose pre-registration carries `aa_controls`.

## Investigation log

### Q: Does L need its own A/A pair?
- Sources examined: spec #1007 statistics section (A/A controls at S and M);
  `prereg/L.json` `stopping_rule.cusum[].sd_source` ("the M tier's A/A pairs");
  `docs/eval-core-mapping.md` rows `aa_controls` and
  `stopping_rule.cusum[].sd_source`.
- Findings: the spec registers A/A pairs at S and M only; L and XL carry no
  `aa_controls`, and the validator refuses the section there. L's CUSUM is
  standardised on M's spread, so L makes paired claims with no same-tier
  noise-floor pair.
- Missing evidence: a design decision on whether L's paired claims need a
  same-tier noise floor.
- Conclusion: needs human input
