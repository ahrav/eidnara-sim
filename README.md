# eidnara-sim

Live-slice world simulation for [Eidnara](https://github.com/ahrav/eidnara).
It drives real Pi and OpenCode binaries, with and without Eidnara, through a
simulated span of developer work and reports paired, pre-registered
comparisons of behaviour, harm, cost, latency, leaks, and known failure
classes.

The specification is
[ahrav/eidnara#1007](https://github.com/ahrav/eidnara/issues/1007). Each
milestone lands through one implementation ticket in that tracker.

## Commands

```sh
bun install
bun run check      # typecheck, lint, test
```

## Layout

| Path | Contents |
| --- | --- |
| `AGENTS.md`, `REVIEW.md` | agent and review guidance |
| `docs/` | system documents, agent guidance, property catalog |
| `scripts/` | repository checks |
| `src/` | harness source |
| `runs/` | run data, journals, reports (git-ignored) |
