# Corpus

The corpus under `corpus/` holds everything the scenario compiler samples
from: fitted distributions, real tool-output excerpts, real error codes, and
the repositories agents work in. The compiler reads these files and needs no
network access.

## Sources

`corpus/sources.json` pins each dataset to a Hugging Face revision and records
the sha256 of every file the build reads.

| Dataset | Revision | License | Use |
|---|---|---|---|
| UW-SyFI/TraceLab v0.0.2 | `7256bbf7` | CC-BY-4.0 | Session shape, idle gaps, append sizes, tool mix |
| nebius/SWE-rebench-openhands-trajectories | `35455389` | CC-BY-4.0 | Tool-output samples and error codes |
| SALT-NLP/SWE-chat | `202b071f` | ODC-BY-1.0 | User-behaviour rates, from the paper |

SWE-chat gates its tables behind a Hugging Face account that accepts the
dataset terms. The build host holds no Hugging Face token, so the tables
return HTTP 401. `corpus/published-rates.json` takes pushback, interrupt,
redirect, and abandon rates from the SWE-chat paper v2 (arXiv:2604.20779v2),
with the quoted sentence for each. The paper gives no denominators for these
rates, so `n` is null. The dataset does not capture abandoned sessions, so the
abandon rate is the paper's sensitivity band of 10% to 30%.

The ticket names SWE-chat session logs as a second source of tool output.
With the tables gated, all tool output comes from the OpenHands trajectories,
which record real command output from real GitHub repositories.

## Distributions

`corpus/distributions.json` stores each quantity as quantiles at fixed
probabilities: a 0.5% grid plus a finer tail up to p99.99. Each quantity
records its definition, unit, source table, and sample size `n`. Count
quantities invert as a step function and stay integer; continuous quantities
interpolate between stored points.

| Quantity | n | p50 | p90 | p99 |
|---|---|---|---|---|
| `requests_per_session` | 8,058 | 1 | 16 | 152 |
| `tool_steps_per_request` | 79,216 | 2 | 18 | 90 |
| `append_tokens_per_step` | 665,453 | 1,045 | 6,963 | 159,485 |
| `idle_within_session_s` | 71,338 | 105 | 958 | 40,586 |
| `idle_between_sessions_s` | 4,221 | 1,605 | 111,627 | 1,043,601 |
| `tool_output_chars` | 743,050 | 407 | 8,219 | 40,151 |

Tool output size has a public distribution in TraceLab's `tool_calls.result_chars`,
so the corpus fits it directly and the append-per-step proxy is unused.

`tool_mix` groups TraceLab's 743,819 tool calls into shell, edit, read, plan,
web, search, agent, and other, with each group's share and error rate.

## Cited percentiles

`corpus/cited-percentiles.json` lists the percentiles the spec cites and one
tolerance rule: a measured value passes when it is within 40% of the cited
value. The cited figures are rounded values from an earlier TraceLab paper
revision, and the widest gap between a cited value and the paper v2 value for
the same percentile is 37% (idle p90: 15 minutes cited, 20.6 minutes in v2).

| Check | Cited | Fitted | Status |
|---|---|---|---|
| requests/session p50, p90, p99 | 1, 16, 161 | 1, 16, 152 | within |
| idle p50, p90, p99 (s) | 86, 900, 39,600 | 105, 958, 40,586 | within |
| append p50 | ~1k | 1,045 | within |
| append p90 | ~4.4k | 6,963 | recorded deviation |

The append p90 deviation is recorded with its reason. TraceLab paper v2
Table 8 reports p90 of 5,342 for Claude and 8,310 for Codex. The pooled v0.0.2
trace measures between the two, so the cited 4.4k matches neither provider in
the current release. Steps appending 10k tokens or more make up 7.1% of steps.

`bun run corpus:check` prints this table from the committed files and fails
when a check leaves its band without a recorded deviation, or when a check
with a recorded deviation comes back into band.

## Tool outputs and error codes

`corpus/tool-outputs/samples.jsonl` holds 600 excerpts, 150 each of test runs,
grep results, file reads, and stack traces, taken from the first 4,096
trajectories in row order with at most one excerpt per trajectory and kind.
`error-codes.jsonl` holds 200 distinct exception names, each at its first
occurrence with its message and the eight lines before it. Every entry
carries `license` and `source_id`; `bun run corpus:check` rejects an entry
missing either. `corpus/tool-outputs/NOTICE.md` gives the attribution.

## Repositories

`corpus/repos.json` records the selection criteria, the candidates
considered, and two picks, each with a near-twin:

| Repository | Role | Commit | License | Offline test outcome |
|---|---|---|---|---|
| tokio-rs/mini-redis | Rust service | `3d93b42b` | MIT | exit 0, 25 tests pass |
| elysiajs/elysia | TypeScript package | `e037eca7` | MIT | exit 1, 1,610 pass, 4 fixed failures |

Each twin is a commit on top of the pinned commit. It renames identifiers
and overlays the files in `corpus/twins/<id>/` (a `CONVENTIONS.md` and lint
configuration), with fixed author, committer, and dates, so the twin SHA in
`repos.json` reproduces. `mini-redis-twin` renames `Db` to `Keyspace` and
sets rustfmt `max_width = 80`. `elysia-twin` switches prettier to two-space
indent, semicolons, and double quotes and makes eslint report `prefer-const`
and `eqeqeq`.

The clones live in `corpus/repos/<id>/`, which git ignores; each license is
copied to `corpus/repos/<id>.LICENSE`, which git tracks.

## Commands

| Command | Effect |
|---|---|
| `bun run corpus:fetch` | Downloads every public dataset file to `corpus/cache/` and checks its sha256 |
| `bun run corpus:build` | Fetches, then rebuilds the derived files and `corpus/manifest.json` |
| `bun run corpus:verify` | Fetches, rebuilds in memory, and compares each digest with the manifest |
| `bun run corpus:check` | Checks the committed files offline; part of `bun run check` |
| `bun run corpus:repos` | Clones each repository, rebuilds its twin, and runs both suites offline |

`corpus:repos` runs each suite under `unshare -rn` with only loopback up, after
a prepare step (`cargo fetch --locked` or `bun install --frozen-lockfile`)
that downloads dependencies. It fails when a twin SHA or a test outcome
differs from `repos.json`; `--record` writes them instead.
