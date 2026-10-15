# Review policy

Review for correctness, security, simplicity, and coherence, in that order.
Prefer the smallest change that preserves the contract, not the fewest lines.
Stay read-only. Review the diff; read callers, contracts, and tests to verify impact.
Do not turn a PR review into a repository-wide redesign.

## Project contracts

- Read root `AGENTS.md` and scoped `AGENTS.md` files for affected directories.
- This tree never writes under the eidnara checkout. A change that creates,
  modifies, or commits a file there is a blocker.
- The eidnara repository's `docs/host-wire-protocol.md` is the normative host
  wire contract, and its `docs/evaluator.md` defines the `eval-core` contracts
  this harness consumes. Check that wire names, literals, and contract fields
  match those documents rather than parallel definitions.
- Use `.github/workflows/ci.yml` for required checks. Do not claim an unrun or
  skipped check passed.
- A run result is believed only from its journal and artefacts on disk. Check
  that grades, gates, and reports derive from recorded evidence, never from
  agent self-report.

## Review priorities

- **Correctness:** Trace changed behavior through callers and failure paths.
  Check state transitions, partial writes, recovery, retries, cancellation,
  shutdown, and bounded resource use. A timeout does not prove rollback.
- **Security:** Check runtime validation at trust boundaries, credential handling,
  file ownership and symlink safety, child-process lifetimes, and sandbox boundaries.
  Provider credentials stay in the configured AWS profile and never enter
  journals, tapes, or reports.
  TypeScript annotations and casts do not validate runtime input.
- **Simplicity:** Look for existing code, standard-library functions, platform
  features, and installed dependencies before proposing new machinery. Challenge
  dead code, duplicated logic, speculative configuration, and pass-through layers.
  Name what can be removed and what replaces it. Preserve validation, cleanup,
  safety checks, supported behavior, and useful regression tests.
- **Coherence:** Keep invariants and mutable state with a clear owner. Check
  dependency direction, module responsibilities, naming, and public contracts.
  An abstraction should protect a present invariant, lifecycle, boundary, or
  required variation. One implementation alone is not grounds for deletion.
  Prefer local changes; extracting helpers or moving files is not inherently simpler.

## Tests and evidence

- Ask which plausible wrong implementation each changed test would reject.
  Verify setup reaches the claimed behavior and assertions inspect the result,
  relevant state, and forbidden side effects. Avoid circular expected values.
- Request the smallest test that distinguishes the bug from correct behavior.
  Do not demand a framework, one test per input, or coverage for its own sake.
- Suggest test deletion only when a named surviving test covers the same inputs,
  invariant, failure modes, and supported configurations. Consolidation must
  preserve every original case. Keep bug-referenced regressions, unique boundary
  cases, readable usage anchors, and the last ungated baseline.
- Honor scoped verification rules: unit tests on recorded artefacts do not
  replace a ticket's run-to-verify command against real host binaries.

## Findings

Report actionable issues introduced or worsened by this change, ordered by impact.
For each, give the location, trigger or evidence, consequence, and smallest fix.
For simplifications, show the maintenance cost removed and behavior preserved.
Keep optional improvements separate from blockers. Do not inflate severity for style.
Skip cosmetic preferences, speculative future needs, and formatter/linter noise.
Verify findings before reporting; state missing evidence instead of inventing certainty.
No findings is a valid result. Keep the summary short and name verification gaps.

## Sub-agents

The ticket's Pre-PR Gate names the review set for a change. This file sets no
count. Always run `ponytail-review` and `/code-quality:reduce-complexity`. Run
the TypeScript testing-approach owner the router names. Use `/research-planning:ask-skills`
against the ticket and the actual diff to select the additional skills the
change needs, including architecture, language-design, concurrency, and
security coverage where applicable. Record each selected skill, its scope, and
the selection reason. When the host blocks nested router invocation, apply the
`ask-skills` contract in-context and record `contract-applied; nested
invocation unavailable`.

Run every selected review concurrently in separate, fresh-context, read-only
sub-agents against the same diff and base. Each returns location, severity,
evidence, and rationale; none posts comments or edits code. The main reviewer
consolidates and deduplicates findings, keeps the contributing reviewers, and
verifies each finding against the implementation before reporting it. Rerun a
review when fixes change its reviewed surface. If a required skill or the
concurrent-agent capability is unavailable, report a blocked gate; never claim
a review ran.
