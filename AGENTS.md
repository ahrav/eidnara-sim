# AGENTS.md

Standalone Bun/TypeScript project: the live-slice world simulation (v2) for
Eidnara, specified by
[ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007).

- This tree lives outside the eidnara repository. It reads the eidnara
  checkout, its plugin builds, and its daemon binary only through paths named
  in `sim.config.json`. Never create, modify, or commit a file under the
  eidnara checkout from this tree; an Eidnara fix a run motivates is separate
  work under that repository's own gates.
- The eidnara repository's `docs/host-wire-protocol.md` is the normative host
  wire contract. Wire names and literals this harness depends on follow that
  document; this tree never redefines them.
- The `eval-core` contracts described in the eidnara repository's
  `docs/evaluator.md` (manifest, run identity, paired statistics, campaign
  profile, analysis family, judge firewall, live settings) are consumed, not
  re-defined. A needed extension is recorded in `docs/eval-core-mapping.md`
  with the protocol version it would need.
- Use `.github/workflows/ci.yml` as the source of truth for required checks.
  `bun run check` runs typecheck, lint, and tests in that order.
- Never append a comment-lint `allow(...)` override marker to a comment.
  `scripts/forbid-comment-markers.sh` rejects it in CI and in the tracked
  `.githooks/pre-commit` hook (installed by `bun install` through the
  `prepare` script). Rewrite or delete the comment instead.
- Before changing `docs/properties/`, read `docs/properties/METHOD.md`.
- Review policy lives in `REVIEW.md`.

## Documentation

Keep one current system document per boundary directly in `docs/`.
Keep agent guidance in `docs/agents/` and property catalogs in
`docs/properties/`. Specs and implementation plans belong in the issue
tracker, not local copies. Run data, journals, and reports live under the
git-ignored `runs/` directory and are not committed.

## Agent skills

### Work tracking

Specs and implementation tickets live in the eidnara repository's issue
tracker. Read `docs/agents/issue-tracker.md` before any tracker operation.
