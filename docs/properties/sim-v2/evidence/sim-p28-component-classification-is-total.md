# sim-p28-component-classification-is-total

Evidence status: PROPOSED. SIM-P28, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

Every record has exactly one component in the fixed set, and unknown shapes map
to `other`, never dropped.

M3 (#1027) tags every record with a component from a closed set: asserted by
the `x-sim-component` header for the user simulator and the judge, inferred
from the request body otherwise, and `rejected` for refused requests. The
writer refuses a record without a known component and source.

## Failure scenario

Cost by component does not sum to the total.

## Timing windows and dependencies

None.

## What a test must construct

Traffic from every component, plus one unrecognised request shape.

## Investigation log

No open questions.
