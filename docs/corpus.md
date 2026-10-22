# Corpus

The corpus under `corpus/` holds everything the scenario compiler samples
from: fitted distributions, real tool-output excerpts, real error codes, and
the repositories agents work in. The compiler reads these files and needs no
network access.

## Sources

`corpus/sources.json` pins each dataset to a Hugging Face revision and records
the sha256 of every file the build reads. `corpus/manifest.json` records the
dataset revisions and the sha256 of every corpus file the scenario compiler
reads: the derived `distributions.json` and tool-output files, and the
hand-authored `fact-bank.json` and `repos.json`.

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
rates, so `n` is null. The paper reports the mind-changer persona share,
which stands in for redirects, separately for vibe coding (4.6%) and other
modes (8.0%); `redirect_per_session` keeps both under `by_mode`. The dataset does not capture abandoned sessions, so the
abandon rate is the paper's sensitivity band of 10% to 30%.

The ticket names SWE-chat session logs as a second source of tool output.
With the tables gated, all tool output comes from the OpenHands trajectories,
which record real command output from real GitHub repositories.

## Distributions

`corpus/distributions.json` stores each quantity as a table of probability
and value points, with its definition, unit, source table, and sample size
`n`. A count quantity stores every distinct count with its cumulative
probability and inverts as a step function, so draws stay integer and follow
the empirical distribution. A continuous quantity stores quantiles on a 0.5%
grid plus a finer tail up to p99.99 and interpolates between them.

`requests_per_session` keeps the 1.6% of TraceLab sessions that hold no
user-message round, so the sampler can draw a session with zero requests.
The scenario compiler conditions on at least one request.

| Quantity | n | p50 | p90 | p99 |
|---|---|---|---|---|
| `requests_per_session` | 8,058 | 1 | 16 | 152 |
| `tool_steps_per_request` | 79,216 | 2 | 18 | 90 |
| `append_tokens_per_step` | 661,022 | 1,042 | 6,964 | 160,073 |
| `idle_within_session_s` | 71,290 | 101 | 938 | 40,358 |
| `idle_between_sessions_s` | 1,675 | 2,641 | 245,896 | 1,787,034 |
| `tool_output_chars` | 743,050 | 407 | 8,219 | 40,151 |

Tool output size has a public distribution in TraceLab's `tool_calls.result_chars`,
so the corpus fits it directly and the append-per-step proxy is unused.

`tool_mix` groups TraceLab's 743,819 tool calls into shell, edit, read, plan,
web, search, agent, and other, with each group's share and error rate.

## Cited percentiles

`corpus/cited-percentiles.json` lists the percentiles the spec cites, the
TraceLab paper v2 value for each, and one tolerance rule: a measured value
passes when it is within 40% of the cited value. The band was set after the
fit was first measured, so it is a reporting tolerance rather than a
pre-registered test. It spans the gap between the cited figures and the
paper v2 figures for the same percentiles; the widest gap among checks with a
pooled v2 value is 37% (idle p90: 15 minutes cited, 20.6 minutes in v2).
Paper v2 reports append percentiles per provider only.

| Check | Cited | Fitted | Status |
|---|---|---|---|
| requests/session p50, p90, p99 | 1, 16, 161 | 1, 16, 152 | within |
| idle p50, p90, p99 (s) | 86, 900, 39,600 | 101, 938, 40,358 | within |
| append p50 | ~1k | 1,042 | within |
| append p90 | ~4.4k | 6,964 | recorded deviation |

The append p90 deviation is a recorded waiver, and the M1 exit criterion
holds for that percentile only through it. TraceLab paper v2
Table 8 reports p90 of 5,342 for Claude and 8,310 for Codex. The pooled v0.0.2
trace measures between the two, so the cited 4.4k matches neither provider in
the current release. Steps appending 10k tokens or more make up 7.1% of steps; the tail check
requires at least 1%.

`bun run corpus:check` prints this table from the committed files and fails
when a check leaves its band without a recorded deviation, or when a check
with a recorded deviation comes back into band.

## Tool outputs and error codes

`corpus/tool-outputs/samples.jsonl` holds 600 excerpts, 150 each of test runs,
grep results, file reads, and stack traces, taken from the first 4,096
trajectories in row order with at most one excerpt per trajectory and kind.
`error-codes.jsonl` holds 200 distinct exception names from the output of
completed commands that exited nonzero or printed a traceback, each at its
first occurrence with its message and the eight lines before it; a name
without a message counts only directly below a traceback frame. Every entry
carries `license` and `source_id`; `bun run corpus:check` rejects an entry
missing either. `corpus/tool-outputs/NOTICE.md` gives the attribution.
The scenario compiler reads `samples.jsonl` for filler pastes; P12 error
identities are generated per fact from the fact bank's language-specific
`tool_error` templates, so `error-codes.jsonl` is corpus evidence the
compiler does not read.

## Repositories

`corpus/repos.json` records the selection criteria, the candidates
considered, and two picks, each with a near-twin:

| Repository | Role | Commit | License | Offline test outcome |
|---|---|---|---|---|
| tokio-rs/mini-redis | Rust service | `3d93b42b` | MIT | exit 0, 25 tests pass |
| elysiajs/elysia | TypeScript package | `e037eca7` | MIT | exit 1, 1,610 pass, 4 fixed failures |

Each twin is one commit on top of the pinned commit. It applies the regex
renames in `repos.json` and overlays the files in `corpus/twins/<id>/`. Git
runs with fixed author, committer, and dates, without the user's global or
system git config, and without commit hooks, so the twin SHA in `repos.json`
reproduces.

`mini-redis-twin` renames `Db` to `Keyspace` and `DbDropGuard` to
`KeyspaceDropGuard` across the source, sets rustfmt `max_width = 80`, and adds
`clippy::unwrap_used = "warn"` to `Cargo.toml`. `elysia-twin` switches
prettier to two-space indent, semicolons, and double quotes and makes eslint
report `prefer-const` and `eqeqeq`. Each twin's `CONVENTIONS.md` also states
naming and error-handling rules for new and changed code; those rules exist
as text, and existing upstream code keeps its own style.

The clones live in `corpus/repos/<id>/`, which git ignores; each license is
copied to `corpus/repos/<id>.LICENSE`, which git tracks.

## Commands

| Command | Effect |
|---|---|
| `bun run corpus:fetch` | Downloads every public dataset file to `corpus/cache/` and checks its sha256 |
| `bun run corpus:build` | Fetches, then rebuilds the derived files and `corpus/manifest.json` |
| `bun run corpus:verify` | Fetches, rebuilds the derived files in place, and fails when `git status` shows any change under `corpus/` |
| `bun run corpus:check` | Checks the committed files offline, including the fact bank's template and check shapes; part of `bun run check` |
| `bun run corpus:repos` | Clones each repository, rebuilds its twin, and runs both suites offline |

`corpus:repos` runs each suite under `unshare -rn` with only loopback up, after
a prepare step (`cargo fetch --locked` or `bun install --frozen-lockfile
--ignore-scripts`) that downloads dependencies. The twin must reproduce its
base repository's outcome. The command fails when a twin SHA or a test
outcome differs from `repos.json`; `--record` writes each twin SHA and each
base outcome instead. The prepare and test steps run upstream code as the
current user; they trust the pinned commits.
