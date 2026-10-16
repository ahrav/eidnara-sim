# sim-p08-cue-and-probe-are-lexically-dissimilar

Evidence status: PROPOSED. SIM-P08, reconstructed from the condensed property
index in spec [ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007)
at its 2026-10-12 revision.

## Discovery trigger

The spec's invariant-driven domain-modeling pass proposed this record for the
v2 harness before any harness code existed.

## Evidence trail

For every cue and probe pair, the pre-registered BM25 and embedding similarity
are below threshold at compile, and the scores are journaled.

No harness code, test, or run exists yet. The surface lands in M2
(#1026).

M2 (#1026) computes a BM25 ratio and an embedding cosine for every cue and
probe pair, journals both in the scenario's `similarity` list, and refuses the
compile when either exceeds the revision 2 pre-registered threshold (`bm25_max`
0.4, `cosine_max` 0.6 for `amazon.titan-embed-text-v2:0`) or when the embedder
is another model. With Titan embeddings, every pre-registered seed (S 101 and
102, M 201 to 203, L 301 to 303, XL 401) compiles; docs/scenario.md lists each
scenario_hash and largest score, with a largest cosine of 0.5194. The tests use
a local stand-in embedder, refuse a pair on BM25 alone and on cosine alone, and
refuse a scenario compiled with an unregistered embedder.

## Failure scenario

Recall is measured by lexical overlap and `grep` over a flat file wins.

## Timing windows and dependencies

None - compile time.

## What a test must construct

The conveyance plan and probe plan with their texts.

## Investigation log

No open questions.
