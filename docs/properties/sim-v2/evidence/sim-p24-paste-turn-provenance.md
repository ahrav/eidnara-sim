# sim-p24-paste-turn-provenance

Evidence status: PROPOSED. SIM-P24, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

A paste turn's record names its corpus item id and byte length, and the bytes
delivered equal the corpus bytes.

M6 (#1031) delivers paste turns verbatim, and `pairing-check.ts` checks each
paste and probe turn's delivered-text hash against the compiled text;
`usersim-1` passed.

## Failure scenario

A paste carries unlicensed or altered content.

## Timing windows and dependencies

None.

## What a test must construct

A scenario with paste turns.

## Investigation log

No open questions.
