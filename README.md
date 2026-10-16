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
bun run check            # typecheck, lint, test, pre-registration, catalog
bun run prereg:validate  # validate prereg/<tier>.json and print each digest
bun run catalog:check    # check docs/properties/sim-v2 against METHOD.md
```

## Layout

| Path | Contents |
| --- | --- |
| `AGENTS.md`, `REVIEW.md` | agent and review guidance |
| `docs/` | system documents (claim boundary, eval-core mapping), agent guidance, property catalog |
| `prereg/` | frozen per-tier pre-registrations (`sim-prereg/v1`) |
| `sim.config.json` | paths to the eidnara checkout, plugin builds, daemon, hosts, and Bedrock profile; `SIM_CONFIG` overrides the file |
| `scripts/` | repository checks |
| `src/` | harness source |
| `runs/` | run data, journals, reports (git-ignored) |
