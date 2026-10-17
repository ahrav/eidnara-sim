# sim-p54-pairing-by-item-identity

Evidence status: PROPOSED. SIM-P54, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

McNemar and bootstrap pairs are keyed by `item_id` across arms, never by
position.

M7 (#1032) `pairByItem` joins two arms by item id; a test feeds each arm in a
different order and gets the pairs by id.

## Failure scenario

Discordance is computed on mismatched items.

## Timing windows and dependencies

An exclusion in one arm shifts positions.

## What a test must construct

A run with one excluded item in one arm.

## Investigation log

No open questions.
