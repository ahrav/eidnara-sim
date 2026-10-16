# sim-p67-incomplete-run-refuses-load

Evidence status: PROPOSED. SIM-P67, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

`LoadRun` refuses an arm with fewer terminal items than scheduled or without a
done marker, and the error names the arm and counts.

No harness code, test, or run exists yet. The surface lands in M4
(#1028).

## Failure scenario

A partial run is analysed as complete.

## Timing windows and dependencies

None.

## What a test must construct

A run interrupted without resume.

## Investigation log

### Q: Does an early-stopped run load?
- Sources examined: spec #1007 (CUSUM harm or futility stop; "a stopped tier
  yields no pass claim"); SIM-P55; this record's guarantee.
- Findings: the guarantee refuses an arm with fewer terminal items than
  scheduled; an early stop leaves scheduled items unissued by design, so a
  literal reading refuses every stopped run and its harm result.
- Missing evidence: the journal's stop marker (M4) and the loader's treatment
  of it.
- Conclusion: needs human input
