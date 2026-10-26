# sim-p81-template-presuppositions-hold-on-pinned-trees

Evidence status: ACTIVE. Added in rr-campaign-3 after the Q ambiguity audit.

## Discovery trigger

The host-oracle ambiguity audit of the S-101 and S-102 Q runs (PR #43) found
agents asking which code a task meant: P3 "login token issued without an
explicit lifetime" on Elysia, which has no login code; P3 "page size for
chunking output" on mini-redis, which has no chunked or multi-value reply;
and P4 "close reason when the websocket server rejects a frame" on Elysia,
whose websocket module closes no socket on a rejected frame.

## Evidence trail

`corpus/fact-bank.json` (`sim-fact-bank/v4`) gives every Rust and TypeScript
template a `requires` list of a project path and a pattern.
`src/corpus/presuppositions.ts` reads each path with `git cat-file blob` at
the commit `corpus/repos.json` pins for the base repository and its twin, and
`presuppositionProblems` names each template, tree, path, and pattern that
fails. `loadCompileInput` calls `checkPresuppositions`, required for a Titan
compile and a run's compile; `scripts/corpus-repos.ts` runs the same check
after cloning; `bankProblems` refuses a language template without a
non-empty list of fixed paths and valid patterns.

## Failure scenario

A template asks for work on a construct the repository lacks, or for
behaviour the repository already has. The agent asks for clarification or
reports nothing to do, and the grader fails the item on every arm.

## Timing windows and dependencies

None. The check reads committed trees before any event runs.

## What a test must construct

A bank and a set of pinned trees, one of which lacks a required file or
pattern.

## Investigation log

### Q: Does every template target code the pinned trees hold?
- Sources examined: mini-redis 3d93b42 and elysia e037eca source, their twins
  22d7d08 and 2eb6116, and every template in `corpus/fact-bank.json`.
- Findings: 31 templates rewritten (the rr-campaign-3 PR body holds the
  table); every requirement holds in all four trees.
- Missing evidence: a check that a task asks for absent behaviour.
- Conclusion: unresolved, needs a semantic check beyond pattern presence.
