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
bun run check            # typecheck, lint, test, pre-registration, catalog, corpus
bun run prereg:validate  # validate prereg/<tier>.json and print each digest
bun run catalog:check    # check docs/properties/sim-v2 against METHOD.md
bun run corpus:verify    # rebuild the corpus in place; fail on any change
bun run corpus:repos     # clone repositories and twins, run their suites offline
bun scripts/compile-scenario.ts --tier S --seed 101   # compile a scenario (docs/scenario.md)
scripts/eidnara-build.sh <checkout> <clone>            # build eidnara artefacts in a clone (docs/hosts.md)
PATH=<pinned opencode .bin>:$PATH bun scripts/run-tier.ts --tier S --seed 101 --out runs/S-101-pi   # run or resume a tier (docs/run-command.md)
bun tests/witness-faults.ts runs/witness             # live fault and resume witness (docs/run-command.md)
```

## Layout

| Path | Contents |
| --- | --- |
| `AGENTS.md`, `REVIEW.md` | agent and review guidance |
| `docs/` | system documents (claim boundary, eval-core mapping), agent guidance, property catalog |
| `prereg/` | frozen per-tier pre-registrations (`sim-prereg/v1`) |
| `corpus/` | fitted distributions, tool-output samples, error codes, repositories (see `docs/corpus.md`) |
| `sim.config.json` | paths to the eidnara checkout, plugin builds, daemon, hosts, and Bedrock profile; `SIM_CONFIG` overrides the file |
| `scripts/` | repository checks |
| `src/` | harness source; `src/proxy/` is the capture proxy (`docs/proxy.md`), `src/run/` the journal, clock, scheduler, and run command (`docs/run.md`, `docs/time.md`, `docs/run-command.md`), `src/hosts/` the arm drivers (`docs/hosts.md`) |
| `runs/` | run data, journals, reports (git-ignored) |
