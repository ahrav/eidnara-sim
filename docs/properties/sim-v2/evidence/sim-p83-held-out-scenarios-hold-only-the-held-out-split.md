# sim-p83-held-out-scenarios-hold-only-the-held-out-split

Evidence status: ACTIVE. Added for c8 item S6, the held-out corpus pair.

## Discovery trigger

The c7 diagnosis read transcripts of mini-redis and elysia only, and the
c8 changes to Eidnara were motivated by those transcripts. The overfit
guardrails for the c8 comparison (`~/scratch/.simmerge/OVERFIT-GUARDRAILS.md`,
2026-11-06) require at least one held-out corpus repository pair, in a
language and project not used so far, with held-out results reported apart
from the diagnosed ones. A held-out report is valid only when its scenarios
hold no diagnosed project and its seeds were never compiled from the
diagnosed corpus.

## Evidence trail

`corpus/repos.json` gives each repository a `split`: `mini-redis` and
`elysia` are `diagnosed`, and `chi` (go-chi/chi at `9f8adb1a`) is
`held-out`. `loadRepos` in `src/corpus/repos.ts` refuses any other value.
`loadCompileInput(seed, tier, embedder, standIn, split)` in
`src/scenario/inputs.ts` keeps only the repositories of `split` (default
`diagnosed`) and builds `projects` from them and their twins, so the
compiler's session plan, fact owners, and probe projects draw from that list
alone. It also checks fact-bank presuppositions on that split's checkouts
only.

`prereg/H.json` is a `sim-qualification/v1` registration with
`corpus: "held-out"`. `validateQualification` in
`src/prereg/qualification.ts` refuses a held-out registration that names a
tier seed, and a diagnosed one that names a seed outside the tier's.
`scripts/compile-scenario.ts` and `loadScenario` in `src/run/run.ts` pass
the registration's `corpus` to `loadCompileInput`. The scenario manifest
records `qualification_sha256`, so a run reuses a cached scenario only under
the same registration.

A held-out compile sets `items` so each base repository carries the tier's
item load: `paired_items_per_probe_type` times the held-out base count over
the diagnosed base count. Under H at M that is 10 items per probe type on
chi, against 20 shared by mini-redis and elysia in a tier M scenario; each
base repository has 120 sessions in both.

## Failure scenario

A compile ignores the split and builds a held-out scenario from every
repository in `repos.json`, or a held-out registration reuses seed 201. The
held-out report then carries mini-redis or elysia items, or repeats a
diagnosed scenario's random draws, and a gain fitted to the diagnosed corpus
reads as a held-out gain.

## Timing windows and dependencies

None. The split is fixed at compile, before any event runs.

## What a test must construct

A tier compile and a held-out compile of the same tier, and a held-out
registration edited to name a tier seed.

## Investigation log

### Q: Do the diagnosed scenarios change when chi joins repos.json?
- Sources examined: M-201 compiled with `--embedder local` before and after
  the change.
- Findings: the two scenarios differ only in
  `manifest.corpus_inputs_sha256` and `scenario_hash`, since `repos.json`
  and `fact-bank.json` are corpus inputs.
- Missing evidence: none.
- Conclusion: resolved; tier scenarios keep their content.

### Q: Does every registered held-out seed compile under Titan?
- Sources examined: Titan compiles of seeds 601 to 611 under H.
- Findings: seed 610 refuses at placement, since no chi-twin session falls
  after one P8 conveyance inside its window for the P8-twin control; H
  registers 601 to 609 and 611, each of which compiles within the
  thresholds.
- Missing evidence: none.
- Conclusion: resolved; the registered seeds are the ten that compile, chosen
  before any run.

### Q: Does one held-out pair support a claim beyond chi?
- Sources examined: `corpus/repos.json`.
- Findings: the held-out split holds one Go package.
- Missing evidence: a second held-out repository in another language.
- Conclusion: unresolved, needs a second held-out pair for a cross-project
  claim.
