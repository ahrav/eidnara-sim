# Host drivers

`src/hosts/` holds the arm drivers. `arms.ts` launches Pi or OpenCode and
wraps the daemon stack, and `driver.ts` runs one arm's events and
scheduler-layer faults. `docs/run-command.md` describes the run command that
wires them to the proxy, clock, and scheduler.

## Eidnara build

The plugins, native addon, daemon, and host fixture come from one commit.
`scripts/eidnara-build.sh <checkout> <clone>` clones the eidnara source
checkout, checks out its `HEAD`, and builds every artefact inside the clone,
so the source checkout itself stays read-only; it refuses a clone path that
is the checkout or lies beneath it, and reuses an existing clone only when
its `.sim-build-source` names the same checkout. It refuses a symlink at `<clone>.lock`, holds the lock with `flock` for the whole build, so a second build of the same clone is
refused, and it reuses a clone only when its `.git` is a real directory
inside the clone. A first clone is made in a fresh `<clone>.partial.XXXXXX` directory that
holds an owner record, and is renamed into place once it carries its source
record; the next build removes only partial directories whose owner record
names the same source. A source that tracks either
record path is refused, and each record is unlinked before it is written. `.sim-build-commit` holds
the built commit from the end of one successful build until the next build
starts, and preflight requires it to match the clone's `HEAD` and
`daemon_binary` to be the clone's own
`target/release/examples/direct_host_fixture`, so a partial or mixed tree,
or a daemon from another commit, stops the run. On a reused clone it force-checks
out the fetched commit and removes untracked files, so edits and stray files
from an earlier build go while ignored outputs (`node_modules`, `target`, the
plugin `dist` directories) stay for the incremental build. The clone is the
harness's own build tree and this script is its one writer. `sim.config.json`
points `eidnara_checkout` and the artefact paths at the clone, and
`daemon_binary` names the `direct_host_fixture` the hermetic host stack
launches. The plugin
builds in the checkout's own `dist` directories can lag its daemon source: on
commit `bb866266c` the stale Pi plugin sent a window the daemon refused, and
every transform pass served its input unchanged.

The v1 harness closure pins OpenCode 1.18.22 and starts `opencode` from
`PATH`, so `opencode_binary` names that release and the host's wrapper, first
on `PATH` as `opencode`, launches it through the sandbox.

## Arms

`src/hosts/profiles.ts` declares each arm's profile, and the host stack
derives Pi's `compaction.enabled`, OpenCode's `compaction.auto` and
`compaction.prune`, and the user-tier `eidnara.jsonc` `compaction.enabled`
from it.

| Arm | Role | Daemon | Plugin | Eidnara compaction | Host compaction | Search route | Delivery |
|---|---|---|---|---|---|---|---|
| `host` | host-only | none | none | n/a | on | none | none |
| `eidnara` | fallback-search | `direct_host_fixture` | Eidnara | on | off | legacy scan | automatic |
| `eidnara-kl` | knowledge-only | `direct_host_fixture` | Eidnara | off | on | legacy scan | automatic |
| `eidnara-cf` | fallback-search | `direct_host_fixture` | Eidnara | on | off | legacy scan | automatic |
| `eidnara-hybrid` | production-hybrid | `direct_host_fixture` on the production query route | Eidnara | on | off | fused | automatic |
| `eidnara-search` | explicit-search-only | `direct_host_fixture` | Eidnara | on | off | legacy scan | explicit search |
| `host-oracle` | oracle-context | none | none | n/a | on | none | oracle context |

`eidnara-cf` runs as `eidnara` here; its counterfactual deletions land with
the counterfactual arm.

Source capture is on for `eidnara`, `eidnara-cf`, `eidnara-hybrid`, and
`eidnara-search` (`source_capture` in the profile) and off on every other
arm, so each c8 contrast with `eidnara` differs in one setting. The user-only consent key
`source_capture.enabled` goes into the daemon's own user tier
(`fixtureDaemonConfig`, which the hermetic host stack writes as the
daemon's `eidnara.jsonc`) and into the plugin's user tier, as one user-tier
file would carry it. The daemon captures only when the key and
`memory.enabled` both hold (`consents` in
`crates/daemon/src/source_capture.rs`): it retains user and assistant
message text, tool outputs and errors, and the configured repository
documents as Kernel source descriptors. `eidnara-kl` keeps its knowledge-layer
configuration unchanged, so its SIM-P76 comparison with earlier runs holds. `eidnara-kl` keeps Eidnara's knowledge layer
(memory, injection, notes, `eidnara_search`, `eidnara_memory`) and leaves the
context window to the host (SIM-P76); with Eidnara compaction off, OpenCode's
conflict check reports no conflict with its native compaction.

Delivery names how knowledge from earlier sessions reaches the agent
(`deliveryOf` in `src/hosts/profiles.ts`; an arm without a declared mode
delivers automatically with the plugin and not at all without it):

- automatic: Eidnara's tools beside its automatic injection, the daemon's
  `<project-memory>` block and the plugin's `<eidnara-search-hint>`. The
  arm writes `memory.auto_inject.enabled=true` and
  `memory.auto_search.enabled=true`. Captured whole user statements reach the
  `<project-memory>` block of later sessions (`user_statement_delivery`).
- explicit search: Eidnara's tools with the auto-search hint and the
  recalled-memory block off (`memory.auto_search.enabled=false`,
  `memory.auto_inject.enabled=false`). The daemon reads
  `/memory/auto_inject/enabled` from its user tier only, and injects m0
  memory only while `memory.enabled` and that key both hold
  (`crates/daemon/src/transform.rs`); `memory.enabled` stays on, so the
  plugin's kernel memory client keeps serving Pi's `eidnara_search`. The arm
  writes the key into the daemon's user tier (`fixtureDaemonConfig`) and the
  plugin's (`eidnaraUserConfig`). An explicit-search arm receives no
  automatic recall from stored memory: no `<project-memory>`,
  `<project-note>`, `<eidnara-search-auto>`, or `<eidnara-search-hint>` block
  (`AUTOMATIC_RECALL_TAGS` in `src/run/capabilities.ts`). Eidnara compaction
  still runs, so its session-local fold output reaches the agent as on every
  arm with Eidnara compaction: `<memory-updates>` inside
  `<session-history-since>` holds the current session's own
  history-summarizer claims, read from that session's history segments
  (`render_memory_updates` in `crates/daemon/src/m1_compose.rs`,
  `load_history_segments_above` in `crates/memory-store/src/lib.rs`), and the
  arm may carry it. The history summarizer reads `<project-memory>` as
  dedup and contradiction input whenever `memory.enabled` holds
  (`project_memory_read` in `crates/daemon/src/lib.rs`), so on this arm, as
  on the automatic ones, session summaries are written with project memory
  in view; the delivery check reads block tags and leaves that indirect path
  to the arm definition.
- oracle context: the harness-only upper-bound control. `host-oracle` runs
  the host alone, and each probe turn whose `ground_truth.sources` names
  events carries those events' text ahead of the user's own (`src/run/oracle-note.ts`).
  It stands for no production configuration.

### Oracle note

The note is a prefix of the probe turn's user message. Both hosts take
per-turn context only through the prompt, a system-prompt change needs a
host restart, and the host arm runs Pi with `--no-extensions`, so the prompt
is the one channel that reaches the model as ordinary context on both hosts.
The run adds it after the user-sim decides the turn, so the pairing log
hashes the scripted text and the oracle arm stays paired with the others; a
turn the user-sim abandons gets no note. The sources are quoted earliest
first, under the name of the project they belong to (the base project for a
`P8-twin` or P11 item asked in its twin):

````text
Background from earlier sessions on <project>, quoted as it came up:

Earlier I wrote:
> <each line of a user-turn source>

Committed then as <path>:
```
<content of an apply_diff source>
```

<path> was removed from the repository.

My request now:
<the delivered turn text>
````

The fence around a file is one backtick longer than the longest backtick run
in it. The run refuses to start an oracle arm when a scenario text holds the
opening `Background from earlier sessions on ` or a note carries a marker
(SIM-P07). The note stays in the session's history after its turn, as any
earlier user message does; the next session starts without it.

Each daemon variant provides a fixed capability set, read from the Eidnara
source at an audited commit. `AUDITED_BUILDS` in `src/hosts/profiles.ts`
registers every build a run may bind, each with its commit, its label, and
the variants read there:

| Build | Commit | Variants | Read for |
|---|---|---|---|
| `eval/w4` (`AUDITED_EIDNARA`, the current build) | `6aabc77e1` | all three | the correctness retest (W4S, W4SH, W4P): `main` `228f9fb74` (which holds the merged Eidnara #1221 to #1224) plus the open heads of #1230, #1227, #1228, and #1229 |
| `eval/w3-all` | `a996cc466` | all three | the caching-on retest (W3S, W3SH, W3P): `main` `2fbeb6059` (which holds #1220 as merged, three capture commits past the head in `eval/w2b`) plus the open heads of Eidnara #1223, #1224, #1221, and #1222 |
| `eval/w2b` | `ae1b673b7` | all three | the S rerun (W2S2, W2S2H) and the reference arm of both retests: `main` `1bf1ae612` (which holds the merged heads of Eidnara #1209, #1212, #1213, #1214, and #1215) plus the open heads of #1220 and #1217 |
| `eval/w2` | `7901aae39` | all three | the first focused S run (W2S, W2SH): `main` `da360026c` (which holds Eidnara #1210, #1211, and #1219) plus the open heads of #1209, #1212, #1213, #1214, #1215, #1217 |
| `eval/c8` | `8e6265d2c` | `direct_host_fixture` (legacy route) | the c8 reference arm |

A qualification may name two of these builds in its `builds` section, the
current one and a reference, so one arm on each is a registered contrast
(`docs/run-command.md`); its runs then bind one of those two.

A run binds the first registered build whose commit its build clone holds,
whose table registers every daemon variant its arms run, and whose copies of
those variants' source files match the clone's working tree. The manifest
records the bound build as `eidnara_build` (`commit`, `label`, and the
capability values of each variant the arms run), a resume must bind the same
build, and the arm's evidence is checked against that build's values. One
sim revision therefore runs the retest's arms on the `eval/w4` build and
a reference arm on the `eval/w2b` build, each run with its own `SIM_CONFIG`
(`docs/run-command.md`, campaign `config`). The `eval/w3-all`, `eval/w2b`,
and `eval/w2` entries keep the earlier registrations bound to the commits
they name; `eval/w3-all` has its own table (`W3_VARIANTS`) and the two w2
builds share one (`W2_VARIANTS`). The table below holds for the current
build, the w3 build, and both w2 builds:

| Variant | Search route | Embeddings | Memory reviewer | Side calls | Memory injection | Source capture |
|---|---|---|---|---|---|---|
| `direct_host_fixture` | legacy scan (started without `--query-route`) | deterministic 8-dimension engine | none (its `review-witness` control runs reviewer jobs against a scripted local provider on a test's request) | through the proxy, by the `--harness-runtime` redirect extension | switchable | on the consent key; its control socket reports the settled `source_capture` counters |
| `direct_host_fixture` fused (`direct-host-fixture-fused`) | fused: `--query-route production --local-embeddings-manifest <payload-manifest.json>` | `gte-modernbert-base-f32`, the payload's local embedding lane | none | through the proxy | switchable | on the consent key |
| production `eidnara-host` | fused | `gte-modernbert-base-f32` | yes | straight to Bedrock | switchable | on the consent key |

Every variant also records the behaviours the arms run on, each with its
own probes. Every build shares four: captured whole user statements delivered
in later sessions' `<project-memory>` (`user_statement_delivery`, accepted
`stm_*` decisions in the `user-statements` domain), small tool outputs whole
in the history summarizer's digest (`whole_small_tool_outputs`), error lines
kept with a captured failure report (`failure_lines_captured`), and block
tags stripped from Pi's streamed message events (`stream_tags_stripped`).
The c8 build and the two w2 builds differ in six:

| Capability | `eval/c8` | `eval/w2`, `eval/w2b` |
|---|---|---|
| `settled_lines_retired` | `true`: summarizer validation retires a settled waiting or constraint line inside its segment (`retire_settled_lines`) | `false` |
| `keyed_open_items` | `false` | `true`: the history renderer derives open items from the stored segments (`history_open_items.rs`), so a `Waiting on user (key)` line renders only in the newest summarized segment of the rows rendered together |
| `statement_lineage` | `shared`: every statement record has source id `memory_capture_statement`, so the Kernel's 64 authority bearers per lineage bound a data home's accepted statements | `per-message`: the source id is `memory_capture_statement:<32 hex digits of the capture job id>`, and a refused approval stores the statement labeled and counts it in `decisions_approval_refused` |
| `contested_statements` | `false` | `true`: a statement an observation contradicts renders as `<statement> (stated <date>; contested <date> by <memory>: "<excerpt>")` in `<project-memory>` and with a `Contested by <memory>: "<excerpt>"` line in an `eidnara_search` result |
| `process_memory` | `false` | `true`: the Context module's `status` answer carries `process_memory` (anonymous, file, and shared resident bytes, threads, glibc C-heap bytes, the arena limit of 4, and the C-heap release counts) |
| `search_progress` | not registered (no fused variant) | `true` on the fused variants: `search.lifecycle.status` answers with `progress` (`tip`, `checkpoint`, `lag_commits`, `rebuilds`, `blocked`); `false` on the legacy fixture, which starts no lifecycle owner |

The w3 build differs from the two w2 builds in two more, on every variant,
and the current build keeps both values:

| Capability | `eval/w2`, `eval/w2b` (and `eval/c8`) | `eval/w3-all` |
|---|---|---|
| `statement_lifetime` | `false`: a whole user statement is approved by its quotation alone | `true`: the extractor classes each proposal of a user source as `lasting`, `current_work`, `status`, or `unsettled`, capture writes the class into the fact's rationale as `lifetime`, and a whole user statement is approved, and so served in `<project-memory>`, when its class is `lasting` or `unsettled` or it carries none; a `current_work` or `status` statement is stored labeled for explicit search (Eidnara #1221). #1222, in the same build, reads the sentences of a paragraph written in lowercase as sentences |
| `background_cache_points` | `system-and-message`: a background call (memory capture, a daemon-run call) carries Pi's two cache points, after the system prompt and at the end of its one user message | `system`: the capture executor (`packages/pi-plugin/src/memory-capture-native.ts`) and the bundled model-execution hook (`crates/host-runtime/assets/pi-model_execution-extension.mjs`) remove cache markers from user messages, so a background call writes a cache entry for its system prompt alone (Eidnara #1224). #1223, in the same build, starts every Pi model-execution run in one working directory, so the system prompt Pi ends with that directory is the same text on every daemon-run call |

The current build differs from the w3 build in one more, on every variant:

| Capability | `eval/w3-all` (and every earlier build) | `eval/w4` |
|---|---|---|
| `current_work_delivery` | `false`: `<project-memory>` has no `<CURRENT_WORK>` element and no row holds an `ended_by` record; on `eval/w3-all` a `current_work` statement is stored labeled | `true`: a whole user statement classed `current_work` is approved, and a live one is served to later sessions in the element `<CURRENT_WORK note="...">` that closes `<project-memory>`, newest first, within a quarter of `memory.injection_budget_tokens` after the lasting rows; a later whole statement of the user that names it under `replaces` or `also_replaces` ends it, and the row that supersedes it is labeled and records `ended_by` (the ending memory and its session) in its rationale; the extractor's classes gain `request`, an instruction its own turn answers, stored labeled for explicit search; an `eidnara_search` result of such a row shows `lifetime=current_work state=live` or `state=ended` (Eidnara #1230) |

#1227, #1228, and #1229, in the same build, change no capability value:
capture sends a source the provider keeps refusing in a request of its own;
`model_execution` reports removal residue at shutdown only when its
registry still holds it; and a memory call made after another transport
closed the shared daemon connection dials a new one.

The fused fixture's projection is served to readers while it trails the
kernel tip by at most `FIXTURE_READER_LAG_COMMITS` (1,024) commits, the
`catchup_lag_commits` bound of the fixture's admission records
(`crates/daemon/examples/search_admission_records/records.rs`); a probe pins
the value.

The fused variant is the fixture started with the production query route
over the build clone's development payload,
`packages/host-linux-x64-gnu/payload-manifest.json`
(`payloadManifest` in `src/hosts/arms.ts`), which the hermetic host stack
passes as `productionSearchManifest`. The fixture checks each payload file
against the manifest's digests, installs search admission from its fixture
records, and logs `direct_host_fixture: search route production, embedding
model <model>` on stderr at each start. The production route, in the fused
fixture and in `eidnara-host`, registers search-projection outbox
consumers, so both fused variants' statement delivery and search also rest
on `canonical_memory.rs`, whose
`read_project_memory` serves the canonical rows at the pinned tip at any
consumer lag (it calls no `decide_for_tip_read`), and on
`search_lifecycle_owner.rs`, which reports a rebuild whose deadline passed
as `SliceOutcome::Expired` and renews it. Both files are among each fused
variant's sources and probes. The run records the manifest's
digest as `binaries.payload_manifest` and refuses a fused arm before
preflight when the manifest is absent. `scripts/eidnara-build.sh` builds
the payload last: it fetches the host inputs, builds the debug
`eidnara-host` launcher whose digest the payload records, builds the native
addon, and runs `bun run payload:dev`. The production launcher admits only
its compiled-in qualified harness closures, runs Pi with `--no-extensions`
and a fresh `HOME`, and refuses AWS endpoint overrides, so its model calls
cannot reach the proxy and their cost goes unmeasured; no arm runs it.
`armOrder` refuses an arm whose profile declares a capability its variant
lacks, naming each gap, before the run writes a manifest or starts
preflight. Before preflight, the run also
requires the build clone to hold `AUDITED_EIDNARA` and its copies of each
running variant's source files (`sources` in `src/hosts/profiles.ts`) to
match that commit's, so a build whose fixture changed stops until the
capabilities are read again. The fixture's sources include the Pi context
handler, the Pi transform window, and the shared transform client whose
`rust pass` line the knowledge-only check reads.

Each variant also records `probes`: one regular expression per capability
reading that a named source file at the audited commit matches or lacks
(for example, the fixture lacks `with_memory_reviewer_host`, and
`source_capture.rs` gates capture on `config.source_capture_enabled &&
config.memory_enabled`). Moving the pin to a new Eidnara commit is one
command against a checkout that holds both commits:

```sh
bun scripts/audit-eidnara.ts <eidnara checkout> <commit>
```

It lists, per variant, the audited source files that differ between
`AUDITED_EIDNARA` and the commit, and evaluates every probe at the commit.
Git runs with its repository-local variables cleared and
`--no-replace-objects`, so it reads the named commits' own objects in the
named checkout even when a hook invokes the audit.
Exit 0 (`unchanged`): no audited source differs, so the table holds and the
pin may stay. Exit 1 (`reread`): sources differ and every probe holds; the
script prints the `git diff` to read, and after that reading the pin moves to
the commit. Exit 2 (`broken`): a probe fails, so `DAEMON_VARIANTS` needs
revising before the pin moves. The pin names only merged commits, so a run
built from an unmerged branch stops at preflight once its fixture sources
differ from the pin's. A third argument names another registered build to
audit against, by label or commit:

```sh
bun scripts/audit-eidnara.ts <eidnara checkout> <commit> eval/c8
```

At `7901aae39` the verdict against `eval/w2` is `unchanged`, and at
`8e6265d2c` the verdict against `eval/c8` is `unchanged`. Each build's
commit returns `broken` against the other build's table: `8e6265d2c` has no
`history_open_items.rs`, `process_memory.rs`, `contested_line`, or
per-message statement source id, and `7901aae39` has no
`retire_settled_lines`. Audited from the previous pin `837c3bab3`
(`eval/c8h`) to `84282f549`, the first `eval/w2` head, the two
`settled_lines_retired` probes of that pin break, because Eidnara #1215
replaces #1207's validation-time retirement with render-time open items.
From `84282f549` to `7901aae39` every probe holds and three audited sources
change: `crates/daemon/src/lib.rs`, `crates/daemon/src/tool_outcome.rs`,
and `crates/daemon/src/memory_capture.rs`. Eidnara #1219 scans a tool
output as printed before the store keeps the chunk transcript, and the text
the summarizer model reads is the same. The later heads of #1212
(`2c28cc809`) and #1213 (`ebaabdafe`) change how `memory_capture.rs` reads
paragraph whitespace, classifies quotation marks, and looks up summary
words when ranking candidates, with the same results. Every capability
value stands. The head also holds #1209 at `aebeb0bd8`, whose chunked
`kernel.read` lies outside the audited sources.

At `ae1b673b7` the verdict against `eval/w2b` is `unchanged`. From
`7901aae39` to `ae1b673b7` every probe holds with one probe widened: the
contested-line probe reads the format string
`(stated {}; contested {} by {}: {})`, because Eidnara `1ac2d933c` passes
the contesting id through `contest_id`, which shows a plain id bare and
quotes any other; `7901aae39` names the id inline as `{memory}`, and the
probe accepts both. The rendered line of a plain memory id is the same
text. Eight audited sources change: `canonical_memory.rs`,
`history_open_items.rs`, `history_summarizer_citations.rs`,
`memory_capture.rs`, `memory_capture/native.rs`, and `transform.rs` under
`crates/daemon/src/`, and `kernel-memory-search.ts` and `render.ts` under
`packages/opencode-plugin/src/tools/eidnara-search/`. Eidnara #1220 joins
the sentences of a statement a colon introduces into one statement and
reads a quotation mark inside an inline code span as code; #1215's final
head keeps a constraint in force unless a lift claim cites text the user
wrote; #1212's and #1213's final heads leave quoted and code text out of a
widened statement and drop a contest whose observation the same commit
retires. Every capability value stands.

At `a996cc466` the verdict against `eval/w3-all` is `unchanged`, and
`ae1b673b7` stays `unchanged` against `eval/w2b`. From `ae1b673b7` to
`a996cc466` every probe of the w2 table holds except the three that read
the two capabilities above as absent, and five audited sources change:
`memory_capture.rs` and `memory_capture/native.rs` under
`crates/daemon/src/` (the lifetime class of #1221, the lowercase
sentence rule of #1222, and the last three commits of #1220, which main
merged after `eval/w2b` was cut: `c1e1f9d5b`, `e85d444d7`, and `d489a43a8`
join quotations that overlap, give a quotation that occurs twice one
decision, and check a joined run against the size limit),
`crates/host-runtime/src/model_execution/pi.rs` (the shared working
directory of #1223), and the capture executor and the model-execution
hook, which #1224 changes and which this revision adds to the audited
sources of every build. The other capability values stand.

At `6aabc77e1` the verdict against `eval/w4` is `unchanged`, `a996cc466`
stays `unchanged` against `eval/w3-all`, and `ae1b673b7` against
`eval/w2b`. From `a996cc466` to `6aabc77e1` every probe of the w3 table
holds except the two that read `current_work_delivery` as absent, and nine
audited sources change: `canonical_memory.rs`, `m0_compose.rs`,
`memory_capture.rs`, and `lib.rs` under `crates/daemon/src/` (the
current-work rows, their element, their budget, and their end, all #1230),
`memory_capture/native.rs` (#1230, and the stepped capture requests of
#1227), `kernel-memory-search.ts` and `render.ts` under
`packages/opencode-plugin/src/tools/eidnara-search/` (the class and state
of a search result), and the capture executor and the model-execution hook
(the merged forms of #1224). The w4 table adds
`crates/daemon/src/memory_render.rs`, which renders the element, to its
audited sources. The other capability values stand.

## Prompt caching

A qualification registers `prompt_caching: "on"` or `"off"` for all its
arms (`docs/run-command.md`); a tier run and a registration that names
none run `off`. The manifest records the condition as `prompt_caching`, a
resume compares it, and each arm's `capabilities.json` repeats it beside
what the arm's requests show; `grade-run` and the probe replay take an
arm's record only when its condition equals the manifest's.

Pi 0.80.2's Bedrock client (`bedrock-converse-stream.js` in pi-ai) places
a cache point after the system prompt and one at the end of the last
message when that message has the user role, which every request's last
message has (`buildSystemPrompt`, `convertMessages`). Bedrock orders a
prefix as tools, system, messages, so the system point covers the tool
definitions. Pi's default retention is `short`: a cache point with
Bedrock's default 5-minute lifetime. `PI_CACHE_RETENTION=long` adds
`ttl: "1h"`; the sandbox passes Pi no such variable. Pi places the points
only for a Claude model whose id or display name holds a family string it
knows (`supportsPromptCaching`: `-4-`, `claude-3-7-sonnet`,
`claude-3-5-haiku`; Pi 0.87 adds `opus-5`, `sonnet-5`, `fable-5`), so for
`global.anthropic.claude-opus-5-5` Pi 0.80.2 places none.

Under `on`, `piModelName` writes each model of Pi's `models.json` with a
display name that holds `-4-`, and Pi's own code places its two cache
points. The model id, and with it the request's `modelId` and every other
byte of the body, stays the same; Pi reads the name only to match model
families and to show it. Every caller that runs in the arm's Pi reads
that definition. The daemon's own model calls run in a child `pi` from the
daemon's Pi closure, with a private home and Pi's built-in model list
(`crates/host-runtime/src/model_execution/pi.rs`), where the arm's
definition stays out of reach; for those the proxy places cache points on
a body that carries none (`daemonCachePoints`): the points that Pi's
request carries for a model it recognises on the build the run bound
(`background_cache_points`). Pi's client places the same two as for every
caller; on a `system` build the bundled hook removes the user message's
before the request leaves, so the proxy places the system prompt's alone.
The call record names how many the proxy placed as `cache_points_placed`:

| Caller | Path to the model | Cache points under `on` |
|---|---|---|
| `agent` | Pi's agent loop | system, last user or tool-result message |
| `native_compaction` | Pi's compaction, through the same client | system, last user message on Pi 0.80.2; none on Pi 0.87, which sends its compaction summary with cache retention `none` |
| `memory_capture` | the plugin's `streamSimple` call with the model from Pi's registry (`packages/pi-plugin/src/memory-capture-native.ts`) | system, the one user message; system alone on a `system` build, whose executor removes the message's marker |
| `history_summarizer`, `context_researcher`, `memory_classifier` | the daemon's model-execution backend: a child `pi --print --mode json --no-session --no-tools` from the daemon's Pi closure, with its own home and a provider extension that sets the proxy's address | system, last user message, placed by the proxy; system alone on a `system` build |
| `user-sim`, `judge` | the harness, straight to the proxy | none; their bodies are the same under both values, and the report prices them at the run's table |

The host arm and the Eidnara arms therefore run under one policy, set by
Pi. Each caller has a system prompt of its own, and the agent has the tool
definitions, so a prefix is shared among the calls of one component and
with no other. A capture or summarizer call reads the system prompt an
earlier call of the same component wrote, in any session of the arm, when
the two prompts are the same text; on a `system-and-message` build it also
writes its own user message to the cache, an entry no later call reads.
Pi ends a system prompt with the working directory, and before Eidnara
#1223 each daemon-run call had a directory of its own, so on the w2 builds
a summarizer call reads nothing and writes its whole prompt.

OpenCode 1.18.22 places its own cache points for a model whose id holds
`anthropic` or `claude`: one after the system prompt and one on each of
the last two messages, with the default lifetime. It does so under either
value, so `off` describes Pi's requests, and an OpenCode run records
cache-read and cache-write tokens under both.

Bedrock accepts at most 4 cache points per request for Claude Opus 5.5,
caches a prefix of at least 512 tokens, and offers the 5-minute and the
1-hour lifetime
(https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html).
A read restarts the lifetime. The usage of a response reports
`cacheReadInputTokens`, `cacheWriteInputTokens`, and the writes per
lifetime in `cacheDetails`; `inputTokens` is the prompt less both.

Cache lifetime runs on wall time, and the run's wall clock differs from
scenario time between turns. Scenario time runs at wall speed while a
turn or a background job is busy, and jumps over the idle gap to the next
scheduled event (`docs/run.md`). Inside a turn the two gaps between calls
are equal. Between turns and between sessions, scenario time advances by
the scheduled gap while the wall clock advances by the harness's own work
(the settle hold, the user-sim call, a host restart), a few seconds to a
minute. A call that follows a scheduled gap above the lifetime therefore
reads a cache that a user at the scenario's pace would find expired, and
the recorded cost of such a call is a cache read where that user pays a
cache write. Eidnara's daemon runs on the arm's injected clock and
rewrites the first message once its last response is more than its
`cache_ttl` (5 minutes) old, on the reasoning that the provider's cache
has expired by then; in a run that rewrite replaces a prefix the wall
clock still holds, so the Eidnara arm pays a write where the host arm
keeps reading. Each call record of a caching-on run carries `cache_gap`
(`docs/proxy.md`): the scenario and wall time since the previous served
call of its session, so an analysis prices a run both as recorded and
with the lifetime applied on scenario time, where a call after a scenario
gap above the record's `ttl_ms` pays its cache reads as writes on every
arm. The provider reports one cache-read count per call, so this view
reprices all of a call's reads and is an estimate: it leaves the recorded
cost as it is beside it. A session's first call reads only the tools and
system prompt an earlier session wrote; Pi's system prompt names the workspace, so the
analysis finds the earlier call that sent the same tools and system
prompt among the stored request parts and applies the same rule to the
time since its answer. A resume after a stop is the opposite case: the
wall gap exceeds the lifetime while the scenario gap does not, and
`cache_gap` shows that call too.

## Capability evidence

The run checks each arm's evidence against its profile, and an arm is
complete evidence only when the two agree:

- At every `session_end` of the arm, the part of the plugin log
  (`<arm>/r/eidnara.log`) written since the session's host started (its
  length at `session_start`, or at the resume that reopened the session)
  must hold an enabled boot (Pi's `registered tools:` line, OpenCode's
  `plugin enabled` line) and no `disabled due to conflicts` or `plugin
  DISABLED` line, and each Pi boot must match the arm's Eidnara compaction
  (`eidnara_reduce` registered when on, `compaction-off mode` when off; a
  registration naming neither mode is a mismatch); a host-only arm must hold
  no boot. A mismatch fails the event, so the journal records it fatal
  (`event-error`) and a resume refuses the run.
- Before `EndArm`, once the arm's finish and every job it started have
  ended, a session still open when the arm ended (an `--events` prefix can
  stop inside one) gets the same boot check, and the run writes
  `<arm>/capabilities.json`: the profile, the observed boots, the number of
  `served_from=transform` passes, the routes Pi's transcripts show each
  `eidnara_search` result came from (the legacy scan when the result carries
  the plugin's fallback note, an error when it reports one, and the fused
  route for every other success; `null` on OpenCode, whose transcripts this
  check does not read), the arm's proxy calls by component, the run's
  `prompt_caching` condition, and `prompt_caching` under `observed`: per
  component the arm's hosts call from, the stored requests, how many of
  them carry a cache point, how many of those the proxy placed, and the
  input, cache-read, and cache-write tokens, and, counted from the stored
  bodies at the arm's end, how many of the requests with cache points of
  their own carry one in a message (`with_message_points`) and one after
  the system prompt (`with_system_points`). Under `on`, every stored request of the agent and of the
  Eidnara components carries a cache point; one without, or one with a
  part `requests.jsonl` lacks, is a mismatch. On a Pi arm the requests an
  Eidnara component sent with its own cache points also show the bound
  build's `background_cache_points`: each carries one after the system
  prompt and none outside the system prompt and the messages
  (`with_other_points`), and on a `system-and-message` build one in its
  user message, where on a `system` build none does; a request of another
  kind is a mismatch at the arm's end. Those are the
  capture calls, which run in the arm's Pi. A request whose points the
  proxy placed follows the declared layout by construction, so the counts
  leave each such request out and the build's source probes stand for it. Pi's own compaction is
  recorded and held to nothing, since its cache points depend on the Pi
  version. The run applies the same rule at every `session_end` to the
  requests counted as calls started (`call_started` names each body's
  cache points; a resume first counts the requests the log holds), and a
  mismatch there fails the event like a boot mismatch, so a host that
  stops placing cache points stops the run at the session that shows it.
  A mismatch leaves `EndArm` unwritten, so the run is incomplete and a resume checks the
  same evidence again: a host-only arm with a plugin boot
  or an Eidnara component call; an arm with Eidnara compaction on that
  answered agent calls with no transform pass, whatever its Eidnara
  compaction, since the Pi plugin submits a pass on every request in both
  modes and the daemon serves it additively when compaction is off; one with
  Eidnara compaction off whose pass logged fewer output messages than input
  (`in=` and `out=`), logged no counts, or that made a `history_summarizer`
  call; or a search result from a
  route other than the declared one, read for a fused-route arm as the
  next item states.
- A fused-route arm's legacy-scan answers are read by the reason the
  plugin's fallback note names. The product's contract (Eidnara
  `docs/properties/fusion-routes/query-route/catalog.md`) ends one call as
  `lane_unavailable` with reason `snapshot_changed` when a kernel commit
  lands between two revalidation slices, and with reason `no_lane` when
  every lane the query declares fails for that call; the plugin then
  answers that call from the legacy snapshot scan and names the reason
  (`route-search.ts`, `execute.ts`). Those two reasons are transient
  (`TRANSIENT_FALLBACK_REASONS`), and a legacy-scan answer that names one
  is a degraded answer of the declared route. `no_lane` reports only that
  every declared lane failed, so a lane that fails on every call reports
  it as well; the
  share bound is the check that tells a route failing call after call from
  one that lost a single call. Every other reason reports a
  state that outlasts the call, such as `disabled` (the route holds no
  limit set), a search admission code (`no_manifest`, `lane_not_ready`,
  `no_family`, `family_refused`), or an unreadable projection
  (`projection_read`), and is persistent. The record's `search_fallback`
  holds the counts of a fused arm whose transcripts the check reads (a Pi
  arm): `answered` (fused plus legacy-scan results), `degraded` with its
  `degraded_reasons`, `degraded_share` (`degraded` over `answered`, `null`
  with no answer; errored results carry no answer and stay out),
  `persistent` with its `persistent_reasons`, and `max_degraded_share`,
  the bound the run's qualification registers (`search_fallback`,
  `docs/run-command.md`) or `null`. Under a registered bound the arm is a
  mismatch when an answer names a persistent reason or when
  `degraded_share` exceeds the bound.
  A run whose registration names no bound keeps the rule it ran under:
  every legacy-scan answer on a fused arm is a mismatch. `observed.search`
  keeps one `legacy_scan` reason per fallback result either way. The
  mismatches a run recorded are its verdict; the counts are derived from
  `observed.search` with the transient reasons of the commit that reads
  them.
- `capabilities.json` also holds `source_capture`: the Kernel source
  descriptors (`srcdesc:*` observations) in `<arm>/final-store/kernel.sqlite`
  by class (`messages`, `raw_tool_spans`, `repository_documents`), how many
  of them are live, and the `source_capture` counters summed over the arm's
  daemon generations. A count is process-local, so the driver reads a
  generation's counters through the fixture's control socket
  (`settledSourceCapture`) before that generation ends, as below, and lists every
  generation in `<arm>/source-capture.json` under `generations`, each with its
  `daemon` identity (pid and start time), what `ended` it (`finish`, a harness
  `stop`, `fault <id>`, or `harness`), and its `counters` or read `error`. A
  finish or a harness stop (a teardown, an abort) waits up to 30 s for every
  capture job to settle and up to 35 s for the read as a whole; a second stop
  during the read waits for that read. A `daemon_restart` fault reads the
  report once without waiting for capture to settle and gives the reply at
  most 250 ms before its kill; a generation still capturing, or one whose
  reply comes later, is listed unread. A `daemon_sigkill_mid_fold` kill must
  land while the fold runs, so it lists its generation unread and kills at
  once. A
  resume lists the generation its killed harness ran as `harness`, unread,
  unless that generation is already listed: a read the killed harness left
  pending stays unread. The record's top level holds the arm's total over
  the generations read (event counts summed, `publish_ms_max` the largest,
  and the gauges `active`, `draining`, `retained_bytes`, `publish_ms_last`,
  and `oldest_deferred_age_ms` from the last generation read alone), an
  `error` (that of a `finish` whose read failed or never returned, whatever
  generation followed it, else the last generation's), and
  `unread_generations`, the generations the total leaves out, which
  `capabilities.json` repeats. The descriptors cover the whole arm. The driver writes
  each generation's entry as pending before the read and replaces it with
  the result. `reset` removes the record with the arm. A final read that
  fails or times out is recorded with its error, the daemon still stops and
  its store is archived, and then the finish fails, so the arm's recorded
  failure keeps a resume from replacing the record. Counters without numeric `admitted` and
  `completed`, with a value that is not a non-negative integer (`null` only
  for `oldest_deferred_age_ms`), or beside a recorded error count as unread. An arm that consents to source capture and answered agent calls is a
  mismatch when its final store is unreadable, holds no `messages`
  descriptor, or its counters were not read; a daemon arm without the
  consent is a mismatch when its final store holds any descriptor, or when
  it answered agent calls and its final store is unreadable.
- In a run whose order holds an oracle-context arm, and on every Eidnara
  arm, `capabilities.json` also holds `delivery`: the arm's
  agent request bodies rebuilt from `requests.jsonl`, those that could not
  be, those carrying an automatic recall block (`<project-memory>`,
  `<project-note>`, `<eidnara-search-auto>`, `<eidnara-search-hint>`;
  `<memory-updates>`, session-local compaction output, passes), and the
  oracle notes the arm owed (one per
  delivered `UserTurn` of a probe with sources; a row a resume recovered from
  the pairing log places its note but owes no delivery), delivered, and
  misplaced. A note is delivered when a prompt of its own turn starts with it
  and ends with the turn's scripted text. An oracle-context arm is a mismatch
  when it owed no note, when an owed note was not delivered, when a request carries a
  note before its turn or in another session or an opening that matches no
  owed note; any other arm is a mismatch when a request carries a note; an
  explicit-search arm is a mismatch when a request carries an automatic
  recall block;
  and every arm whose delivery is read is a mismatch when a body cannot be
  rebuilt. Openings are counted in the system blocks and user messages, the
  text that enters the context, since the agent's own replies may quote a
  note; a note is owned only in a user message, at most as many times as
  notes of the same text came due in the session by that turn, so a note in a
  system block or prefixed twice is misplaced.
- `delivery` also counts the agent requests whose system blocks or user
  messages carry a `<project-memory>` block (`memory_blocks`), the sessions
  with an agent request, `memory_due`, and `due_blocks`. `statements` counts
  the committed user statements in the final store (`stm_*` decisions whose
  commit the log holds), and of them the records an invalidation retired
  (`retired`): a retired record approves nothing, as when a later statement
  ends work in progress on a build with `current_work_delivery`, so its
  statement owes no block. The capability check reads no retirement time
  from the final store, so a record retired during the run is left out for
  the whole run, the sessions before its retirement included; the evidence
  path (`docs/evidence.md`) reads the block of each probe turn directly.
  `statements.sessions` lists the
  capture sessions the rationales of the live records name; Pi
  names an Eidnara session `sim-<session>`, and a name without that prefix
  stands for every session that made a `memory_capture` call, as does a
  statement whose payload names no session. A request owes a statement's
  block when it belongs to another session of the statement's project and
  starts after the last answered (status 200) `memory_capture` call of the
  statement's session ended (`started_wall_ms` against `wall_ms`), since Eidnara leaves the
  current session's statements out of its own block; `memory_due` holds when
  any request owes one, and `due_blocks` counts the owing requests that
  carry a block. `due_sessions` counts the sessions with an owing request,
  `covered_sessions` those in which an owing request carried a block, and
  `uncovered_sessions` names the rest. Once one is due, an automatic-delivery
  arm is a mismatch when no owing request carried a `<project-memory>`
  block, and also when `covered_sessions` is below
  `REQUIRED_MEMORY_COVERAGE` (1) times `due_sessions`: automatic delivery
  serves the statements of earlier sessions on each later session's passes,
  so every owing session carries the block, and the mismatch names the
  uncovered sessions. An
  explicit-search arm is a mismatch when its Pi transcripts hold no
  `eidnara_search` result. An Eidnara arm that made agent calls is a
  mismatch when its final store's decisions cannot be read, and one whose
  agent worked in two or more sessions is a mismatch when the proxy records
  hold no `memory_capture` call, since every side call goes through the
  proxy.
- `daemon_routes` reads the arm's `daemon.log` in order. `DaemonStack`
  appends each start's captured stdout, with the ready record, before its
  captured stderr, with the fixture's production search route line, so a
  generation opens at its ready record and counts as production when a
  route line follows before the next ready record; `models` lists the
  embedding models the route lines name. A fused-route arm is a mismatch
  when a ready generation logged no route line, when the daemon never
  became ready while the agent made calls, and when a route ran an embedding
  model other than the one the arm requires; any other daemon arm is a
  mismatch when a route line appears.
- A fused-route arm must also show a served projection: of its
  `eidnara_search` results the fused route handled (answered or errored), the
  answered share must exceed `MIN_FUSED_ANSWER_SHARE` (0.5). The arm declares
  the fused route as its search path, and an errored search carries no
  ranking from any route, so the fused route is the arm's search path while
  it answers more of the arm's searches than it refuses; at one half or
  below, the arm's usual search has no answer. The bound follows from the
  arm's declaration and is not fitted to any run. The mismatch names the
  errored count and the share; the share itself stays in
  `capabilities.json` (`search.fused`, `search.errored`) for the analysis,
  which judges registered expectations on it.
- The checks below read the capabilities of the arm's variant on the bound
  build (`eidnara_build` in `capabilities.json`):
  - `statements.lineages` counts the Kernel lineages (`object_registry`
    source ids) the committed statement records join, the statements on the
    largest, and the statements on a per-message lineage. A `per-message`
    build is a mismatch when a statement sits on another lineage, and a
    `shared` build when one sits on a per-message lineage or the statements
    sit on more than one lineage. A source-capture
    arm on a `per-message` build is a mismatch when its counters hold no
    `decisions_approval_refused`, and on a `shared` build when they hold it.
    The count of statements on the largest lineage and the counter show
    whether a run passed the old ceiling of 64 statements or met a refusal.
  - `statements.lifetimes` counts the committed captured facts (`mem_*`
    decisions) by the `lifetime` class their rationale names. A fact with a
    class is a mismatch on a build without `statement_lifetime`; a build
    with it may show none, since the extractor may class no proposal, and
    a class outside `lasting`, `current_work`, `status`, and `unsettled`
    is a mismatch there. A build with `current_work_delivery` names
    `request` as well.
  - `delivery.work_blocks` counts agent requests whose `<project-memory>`
    block holds a `<CURRENT_WORK>` element, and `statements.ended_work` the
    committed facts classed `current_work` whose rationale holds an
    `ended_by` record. Either above zero is a mismatch on a build without
    `current_work_delivery`; a build with it may show none, since the
    element needs a live statement of work in progress from an earlier
    session and an end needs a later statement that names it.
  - `delivery.contested_blocks` counts agent requests whose
    `<project-memory>` block renders a contested statement, and
    `search.contested` the `eidnara_search` results with a `Contested by`
    line. Either above zero is a mismatch on a build without
    `contested_statements`; a build with it may show none, since a contest
    needs an observation that contradicts a delivered statement.
  - `delivery.open_items` reads the `<session-history>` and
    `<session-history-since>` blocks of each agent request: the blocks with a
    rendered segment, those with a `Waiting on user (key)` line, and those
    where a segment with a waiting line is followed in the same block by a
    segment holding a status line (`Waiting on user`, `Constraint`,
    `Decided`, `Lifted`, each after at most one `- ` or `* ` bullet). A later
    segment with a status line is a summarized one, so that waiting line is
    outside the block's newest summarized segment. One such block is a
    mismatch on a build with `keyed_open_items`, and the record lists the
    first requests. The baseline block keeps its bytes between rebuilds and
    the rows above it render as their own block, so a waiting line in the
    baseline beside its answer in `<session-history-since>` is the build's
    documented behaviour and is counted in neither.
  - `daemon_status` totals the status readings in `<arm>/resources.jsonl`
    (`docs/run-command.md`): the samples of a live daemon, the readings that
    returned (`readings`) and the reads that failed (`read_errors`), the
    readings carrying `process_memory`, the largest `rss_anon_bytes`, the
    last `c_heap_releases`, and for `search.lifecycle.status` the readings
    with a `progress` block, those of a served projection (record `current`,
    admission `admitted`, `lag_commits` at most
    `FIXTURE_READER_LAG_COMMITS`), the largest and the last lag, the last
    rebuild counts, and the readings naming a blocking reason. A read
    returns after the sample that started it, so only readings that returned
    count as evidence. An arm that answered agent calls and has at least one
    reading is a mismatch when its build declares `process_memory` and no
    reading carries the block, when its build lacks the capability and a
    reading carries it, and, on a fused arm whose build declares
    `search_progress`, when no reading carries a `progress` block. An arm
    with no reading and at least one failed read is a mismatch, since the
    declared status is unverified; an arm too short for any read to return
    owes none. The lag and rebuild totals are recorded for the analysis and
    decide no mismatch.

The plugin writes its log inside the arm root, which the agent's tools can
write too, so the evidence holds against an agent that leaves the log alone;
a log replaced by a link or a non-regular file is refused.

`HostDriver` owns the arm's daemon and its current host. `reset` stops both,
deletes the arm root and store, clones each scenario repository into a
workspace, and, on an Eidnara arm, starts a fresh daemon through the v1
`HermeticHostStack` with the interposer environment. `finish` runs after the
arm's last event, before `EndArm`: it closes the host, stops the daemon with
SIGTERM so its store stays on disk, and unmounts the store; a host or daemon
whose teardown fails stays held with its recorded identity, so the failure's
state names it for the next reap, and a driver that finishes before it ever
reset or resumed adds the failure to the record on disk, leaving the
identities the killed harness wrote in place; the daemon's
output reaches `<arm>/daemon.log` as it is written.
`stop` first waits for a host `openSession` or a daemon start or restart still
in flight, so a process spawned moments before a stop is closed rather than
leaked, and ends a counterfactual deletion child before the store goes;
concurrent closes of one host share a single shutdown.

`DaemonStack` starts the daemon through the v1 `HermeticHostStack` with the
interposer environment, restarts it with SIGKILL against the same store, and
stops it with SIGTERM so its store stays on disk; a daemon that outlives
SIGTERM is killed with the stack's SIGKILL path and the stop still fails. It
appends every chunk the daemon writes to the arm's `daemon.log` as it
arrives, across restarts, so a kill at any point loses nothing already
written; the output the readiness wait captured before the log attached
comes first, as the v1 stack buffered it (its stdout, then its stderr), and
the live stream after it keeps the order of arrival; the log opens with `O_NOFOLLOW` and `O_NONBLOCK` and must be a
regular file, so a symlink or FIFO left there fails the append without
blocking, and the first such failure surfaces at stop together with a failed
SIGKILL fallback.
`crash` kills the daemon by SIGKILL and leaves the store as the kill left
it; the next `restart` starts the replacement without a second kill, so a
caller can inspect the store in between.
The run's resource sampler takes a sample when each daemon process is up and
before a fault takes one down; a final sample that cannot be written fails
the arm's finish after the arm is shut down, so the run is not complete
evidence.

The sandbox has its own mount, pid, and System V IPC namespaces. `closeSession`
keeps its host handle until the whole teardown succeeds, so a failed close
can be retried. Each `session_start` launches one host process in the
session's workspace, which must lie below a kept path since the launcher
masks the run root, through the sandbox launcher, and each `session_end`
closes it; when the readiness check fails or Pi
refuses it, or the OpenCode SDK setup or session listing fails after the
launch, `openSession` closes the session it started before it throws. The
control files the hosts write under the arm root (Pi's settings, model list,
and Eidnara config; OpenCode's config, data, and cache directories; the
daemon's runtime and store directories) go through real directories only,
walked one component at a time so a symlinked ancestor is refused before
anything is created below it, and are created fresh and renamed into place, so a symlink an earlier
session left there is refused or replaced, never followed. OpenCode's config
directory and the daemon's runtime directory are regenerated on every start,
so they are removed first. The sandbox runs the host under
root-owned `sudo` and `unshare`, so closing a host walks the launcher's
process tree and signals every process the user owns, with SIGKILL after
10 s; what is left of a launch whose identity was pinned at spawn, including a
launcher still root-owned in its privileged setup, is then killed through the
passwordless `sudo` the launcher runs under, and a process that survives that
stops the run. The launcher root's start time is
taken when it is spawned, so a root pid the kernel has since reused is left
alone, and a launch whose start time could not be read is not signalled. Each pid in that walk is
paired with its start time and checked against it before every signal, so a
pid the kernel reuses during the grace period is left alone. The launcher's
pid namespace ends with its init, so a child forked while the tree stops dies
with the namespace. A Pi close whose tree stop confirms the pinned launcher
gone takes that as the launch's exit and waits at most 1 s more for the
runtime's own `exit` report, which can trail the kernel past the RPC client's
20 s of SIGTERM and SIGKILL waits, or never arrive: the launcher stays an unreaped
`sudo` zombie, so a close that heard no report by then unrefs the launch's handle
and destroys its pipes, and the run process exits once its journal is sealed; a launch the stop cannot confirm, such as
one whose start time was never read, closes through the RPC client's shutdown,
and its failure keeps the handle. `prompt` sends one user turn with the turn deadline and
returns the host's error, if any. Pi emits `agent_end` with `willRetry: true`
before it retries a failed request itself, so a Pi turn ends only at an
`agent_end` Pi will not retry. After that end Pi may compact the session and
continue the run, so a turn is settled only once `get_state` reports Pi
neither streaming nor compacting and a 1 s window passes with no
`agent_start` or `compaction_start`, and no `compaction_end` with
`willRetry: true` waits for its continuation's start; its result is the last
such `agent_end`.
Both waits are bounded by the turn's remaining time (the state check gets at
least 1 s), and a refused `get_state` counts as unsettled, so the turn goes
through the abort and drain below. A prompt Pi refuses in preflight starts no
turn, so its error is returned at once. After a Pi turn fails, the host
aborts it and, alongside the abort, waits up to 30 s for its `agent_end`
(an end the turn's own waiter saw before the failure counts, and the drain
waiter is armed before that check so no end falls between); a turn still
running then stops the run, so a late end cannot finish the next turn. OpenCode turns race the deadline,
abort the session (waiting at most 30 s for the abort call), and wait 30 s for
the call to drain; a call still running then stops the run, and so does an
abort call still pending after 30 s, since it would cancel the next turn,
an OpenCode session setup (listing or creating the session) still pending
after 120 s,
and so does a deadline abort the server does not confirm with `true`. A
scheduled interrupt's abort the server refuses or fails leaves the turn to run
on under its deadline, reported as it ends. A
prompt request that fails before the server answers is aborted the same way,
and an abort that fails stops the run, since the turn's completion cannot be
established. A Pi or OpenCode turn still running after its abort's drain wait
stops the run as `host-abort`, which a resume recovers (`docs/run.md`); the
other stops here are `event-error`. A Pi interrupt sends `abort` and reads the turn's own `agent_end`
within the drain wait, whatever the abort's answer; the turn is `interrupted`
only when the last assistant message stopped with `aborted`. A prompt the host
refused, a prompt request that failed before Pi accepted it or the OpenCode
server answered, and a turn whose deadline the user-sim call or the message
listing spent before the prompt report `undelivered`, and the runner journals
that turn's `UserTurn` as not delivered. The runner passes each turn the part of
its deadline the user-sim call left (`deadline_ms`). A Pi `agent_end` seen before the prompt response fails settles
that turn with its result.
Every deadline timer is cleared once its race settles. An OpenCode prompt that returns before the session's last
assistant step finishes (`finish` other than `stop` or `length`) is a
failed turn, and the session is aborted first (an abort still unanswered
after the abort wait stops the run) so the step runs into no later turn. A
prompt that returns with no assistant message of its own is a failed turn
too. A prompt sent in that state ends its conversation on an
assistant message, which Bedrock refuses as a prefill.
An `apply_diff` event writes its file inside the
workspace and commits that path alone, so the agent's own uncommitted edits
stay uncommitted; content already committed adds no commit, and a path that
resolves outside the workspace through `..` or a symlink stops the run before
any directory is created. The file is written whole and renamed into place,
so a hard link the agent left at the path keeps its other name's content, and
the `git add` and `git commit` run inside the arm's sandbox under the turn
deadline, with the selected workspace and a harness-owned git home
(`<arm>/git-home`) kept and the sibling workspaces, the host's home, and
the daemon's store masked, with the hosts' read-only paths (toolchains, the interposer, the
build clone, the Pi, Node, and OpenCode installs) read-only, a fresh
environment, and the system path alone (`/usr/local/bin:/usr/bin:/bin`) for
resolving `timeout` and `git`, since the sandbox enters the workspace before
it resolves them, and only against a `.git` that is the workspace's own directory, so a hook,
filter, or config the agent planted in the repository acts with the host's
own view of the filesystem and sees none of the harness's variables, and a
hook that hangs stops the run instead of the harness. The run's pid is in
`state.json` before its process starts (the shell waits for a line on stdin
until the record is written, then execs the launcher, so the recorded pid is
the launcher's `sudo` and the deadline's `timeout` runs inside the sandbox),
so a resume stops one the killed harness left behind and removes its
`index.lock` before replaying the event; a launch whose start time the
kernel did not report is ended unreleased and stops the run, since the
record names a process by pid and start; a run that fails removes its own
`index.lock`, `HEAD.lock`, `packed-refs.lock`, and any ref lock, and both
removals leave a `.git` that is a link alone. The commit's author and committer dates are the
event's scenario instant (`baseMs + scenario_ms`), so paired arms and a
resumed delivery produce the same commit. Every session and `apply_diff`
requires the workspace to resolve to the real `<arm>/r/workspaces/<project>`;
a symlink the agent put at it or above it stops the run, since the harness
and the launcher would follow it with their own privileges; the daemon's
`runtime` and data directories get the same check before every daemon start
and restart; the data directory is bound to itself, so it is a mount point
the host cannot rename or replace while a restart writes under it, and the
daemon's harness runtime lives at `<arm>/runtime`, beside the arm and outside
every path the host can write, so a restart executes what the harness
generated.

Each host process starts in the session's workspace, which the launcher
enters after its privilege drop. Pi runs in RPC mode with `--session-id sim-<session>`, its agent directory,
settings, and model list under the arm root, and the Eidnara extension from
the build clone on Eidnara arms. OpenCode runs through the v1 `spawnOpencode`,
with a wrapper script that launches the pinned binary, resolved to its
canonical path so the read-only install covers the file that runs, through the sandbox
launcher, and titles each session `sim-<session>`. The v1 runner starts the
wrapper as the harness's own child and the wrapper execs the launcher, so
`closeSession` stops the one process serving the session's port whose parent
is the harness. The v1 runner executes the
wrapper on the host, outside the sandbox, so it lives at
`<run>/hostbin/<arm>/opencode` beside the launcher: the sandbox masks the run
root, and the arm root the agent can write holds nothing a later session
executes with the user's privileges. Each OpenCode session
denies the `question`, `plan_enter`, and `plan_exit` permissions, as
`opencode run` does for a non-interactive session: in the first live
OpenCode run, the agent asked the user a question and the turn waited until
its 900 s deadline. The harness also preloads `libfaketimeMT.so.1`, the
build that serializes libfaketime's shared state across threads; under the
single-threaded build, OpenCode crashed with `double free detected` after
libfaketime read a torn timestamp line. Both reach Bedrock only through the
proxy, with placeholder AWS credentials.

The launcher binds kept paths read-write and read-only paths read-only, and
refuses a writable kept path under a read-only one, compared through
canonical paths so a symlink alias cannot split them, and any path that
equals or contains a masked root (`/tmp`, the user's home, the run root),
directly or through a symlink, so narrow paths such as
`~/.cargo` stay visible while the home itself stays hidden. Configured paths
must be normalized, since the launcher refuses others. The arm's own
directories are read-write; the scenario clock's directory is read-only
inside the sandbox, since the scheduler writes it from outside. The toolchain paths, the tool
wrappers, the interposer build, the eidnara build clone, and the Node and Pi
installs are read-only, so the agent reads and runs them while later
sessions and arms run the same files; `touch` under `~/.cargo/bin` fails inside
the sandbox with `Read-only file system`.

The agent's build tools come from `config.toolchain`: its `bin` directories,
each under a `keep` path, come first on the host's `PATH`, followed by the
system directories `/usr/local/bin:/usr/bin:/bin`, the same `PATH` the
toolchain probe and both hosts use (the probe runs `cargo`, `rustc`,
`rustdoc`, `bun`, `python3`, which the P12 check scripts need, and `go`,
which the held-out chi checkout builds with; `go` comes from the system
directories and needs no module cache, since chi imports only the standard
library), its `keep` paths (the cargo binaries, registry, and
git cache, rustup, and the bun binary and install cache) stay visible and
read-only inside the sandbox (a mount nested inside a read-only path is
remounted read-only too), and its `env` sets `CARGO_HOME`, `RUSTUP_HOME`,
and `BUN_INSTALL_CACHE_DIR`, the only variables `toolchain.env` accepts, since
a variable that selects an executable would bypass preflight. The hosts replace `HOME`, and Bun resolves its
cache from `HOME` unless that variable names it, so the variable is what points
`bun install` at the kept cache. Preflight requires each of these paths to lie
under a read-only keep path or under a masked root (the home or `/tmp`, which
each sandbox sees as its own empty tmpfs), so no arm writes a tool home or
cache another arm reads. The agent builds and tests against the
dependencies already in those caches; fetching a dependency they lack fails
against those caches. The sandbox keeps the host network namespace, since the
hosts reach the proxy over loopback, so an agent that points a cache at its
writable workspace can fetch, and preflight records the distortion in those
terms.

Every process the host starts inherits the interposer. rustc 1.99 hangs at
startup under libfaketime 0.9.10: in the first two-arm witness run
(`witness-5`, 2026-10-16), the agent's `cargo test` sat in `rustc -vV` until
Pi's 600 s tool timeout, and `LD_PRELOAD=libfaketime.so.1 rustc -vV` hangs
outside the sandbox too. Each
tool in `wall_clock_tools` (rustc and rustdoc, the only accepted names)
therefore runs through a wrapper
in `<run>/toolbin` that drops the preload, and `RUSTC` and `RUSTDOC` point
cargo at the wrappers, since rustup puts its own toolchain directory first on
cargo's `PATH`. Those tools read wall-clock time, and preflight records that
distortion. Preflight writes the wrappers, then runs `cargo --version`,
`"${RUSTC:-rustc}" -vV`, `"${RUSTDOC:-rustdoc}" --version`, and `bun --version` under the interposer through the
launcher, so the rustc check goes through the same wrapper cargo uses (or
`rustc` on `PATH` when no wrapper is configured), and
records each version line, which must name the tool's version (`rustdoc
--version` runs too, through its wrapper); a tool that
fails, prints no version, or runs past 60 s has its tree
stopped and stops the run.

The daemon's store directory `<arm>/s` stays visible inside the sandbox on
Eidnara arms, because the plugin reaches the daemon through the connection
file and socket under it, and a daemon restart recreates them there. The
agent can therefore read the store, as it can on a workstation where the
store sits under the user's home.

## Resume

The driver keeps `<arm>/state.json` current with the model index, the
daemon restarts whose `StoreChecked` entry the journal may still lack (each
with its plugin-log mark), and the
pid and start time of the daemon and of the host while a session is open,
replacing the file whole so a kill mid-write leaves the previous state. Pi's
pid is recorded as soon as its process exists, before the readiness wait, and
the launcher runs only once that record is written (the gating shell waits
on a pipe the driver releases after the write; the record carries the start
time captured at the launch, and a launch whose start the kernel did not
report is killed unreleased and fails the session);
OpenCode's once `spawnOpencode` returns, before the SDK setup; the OpenCode
wrapper also writes its own pid and start time to `<arm>/opencode.launch`
(staged and renamed whole; a record it cannot write ends the wrapper before
the launcher) before it execs the launcher, so a harness killed while the
server starts leaves a record the next resume reaps. A daemon the fixture spawned before
the harness died carries this arm's data directory as its `--state-root`, and
the reaper finds and stops it by that argument. The state
also carries the length and allocated blocks of an active `store_full`
ballast with the fault's id (cleared before the file goes, so a kill in
between leaves a leftover the resume removes, and a ballast whose fault the
journal fired and never observed is removed on resume instead of refilled,
since the run records that fault as interrupted), a `refilling` flag while a resume has removed the ballast
and has yet to fill the store again, so a kill inside that window refills on
the next attempt, and, through `transcripts.json`, a transcript-store gap
already found; a resume stops on a ballast whose length or blocks changed, or
that is a link (a sparse replacement, a punched hole, or a look-alike
elsewhere all count), or on a recorded gap, since neither may heal.
A new harness process calls `reap()` and then `resume(open)` on an arm that
has `StartArm` and no `EndArm`; an arm whose every event is journaled resumes
with `resume(null)`, which restores its daemon, store, and owed store checks
without opening a session, and then finishes, so its final store check reads
the store the killed harness left. `reap` requires the state, stops each recorded process, host first,
and then refuses an arm whose `finish` failed earlier (the state records the
failure, so a resume cannot heal it, while the reap still releases what it
can),
whose start time still matches, then unmounts a store left mounted; every
step runs and the first failure surfaces afterwards (a process that outlives
SIGTERM and SIGKILL stops the resume with `HarnessFailure`),
before the scheduler arms any proxy fault again. `resume` restores the host model index (the daemon keeps the arm's first
model, as it did before the kill) and the owed store checks, mounts the
existing store image (a missing image or `state.json` stops the resume,
since only `reset` formats one and the state names what to stop), starts the daemon against the existing store, and, when
the next event is inside a session, opens that session again. Pi reopens the
same session transcript by its session id, and OpenCode reuses the session
with the same title. `reset` stops recorded processes first (a clone in
flight is recorded like an `apply_diff`'s git), since a daemon the killed
harness left holds the data directory busy, then its own, and unmounts the
store before it deletes anything, so a harness killed during `reset`
leaves no recorded process running into the next attempt, and it removes the
`daemon.log` and `transcripts.json` of an abandoned attempt. A daemon or an
OpenCode server still starting when the harness dies has no pid in
`state.json` yet; the reaper finds the daemon by its `--state-root` argument
and the OpenCode launcher by the wrapper's `opencode.launch` record, so both
stop before the next `reset` or `resume` proceeds.

## Transcript-store check

After an arm's first `session_end`, the driver expands the preflight's
transcript-store paths for the host version with the host's own variables
(`$PI_CODING_AGENT_DIR`, `$XDG_DATA_HOME`) and writes the result to
`<arm>/transcripts.json`. A missing path stops the run (OQ-7); a link at the
store or at any ancestor below the arm root, or a node of the other kind (`TRANSCRIPT_STORES` names `opencode.db` as the one
file, the rest are directories), left where the store should be counts as
missing.

## Infrastructure faults

The scheduler opens an outage window before a daemon fault and closes it at
the next event. The harness owns every daemon restart, through the hermetic
host stack's `crashHost`, which sends SIGKILL, and `restartHost`, which
starts the fixture against the same store (OQ-10); the driver inspects the
store between the two.

| Fault | Mechanism | Evidence |
|---|---|---|
| `daemon_sigkill_mid_fold` | The session's first observed history-summarizer call fires it; SIGKILL and restart | `pid_before`, `pid_after`, `restarted_by: harness`, and the store check between the SIGKILL and the replacement's start (`docs/oracles.md`); the first turn boundary, session end, or finish at which the plugin log shows a pass the replacement served (`served_from=transform` past the log's length at the restart), or a later daemon fault before it kills the daemon, journals a second check as `StoreChecked` |
| `daemon_restart` | At `session_start`, SIGKILL and restart | As above |
| `store_full` | When the scenario schedules `store_full`, each Eidnara arm's store lives on a sparse 2 GiB ext4 loop mount (`nosuid,nodev,noexec`) at `<arm>/s`, room for the daemon to materialize its harness closures twice, with its image outside the sandbox's kept paths; the fault fills it with a `fallocate`d ballast topped up by `dd`, so the sparse image stays small, and `session_end` removes the ballast (the arm's `finish` removes a ballast no `session_end` cleared, under the same checks, before it unmounts the store); a resume that finds the ballast removes it for the daemon's start and fills the store again, whether or not that start succeeds, and requires the store to report no free space afterwards; the store is writable to the host, so `session_end` requires the ballast to be the regular file it created with its length and blocks unchanged, its only name (a second hard link would keep the blocks allocated after the unlink), and the store to still report no free space, and stops the run otherwise; the fault replaces whatever the host left at the ballast's name with a fresh regular file before allocating | `avail_kb: 0`; any other value stops the run |
| `plugin_reload` | The host process and its plugin start afresh at every `session_start` | The reload note |
| `model_switch` | Later sessions use the next configured model; the daemon keeps running with its summarizer model | The new model id |
| `laptop_sleep` | One event-free clock jump (`docs/run.md`) | The `AdvanceClock` entry, and `clock_advanced_ms` |
| `host_upgrade` | Later sessions run the next pinned version of the arm's host, `config.upgrade.pi_install` or `config.upgrade.opencode_binary` (Pi 0.87.1 and OpenCode 1.18.23 in `sim.config.json`); the daemon's harness closures keep the pinned versions; preflight records each configured version and its transcript store paths, refusing a target that resolves to the current version, which the fault's evidence reports and the next `session_end` checks again for the upgraded host, requiring the store to have changed during that session (symlinks in the store are skipped), with `transcripts.json` recording that result so a resume repeats a failed check and accepts only the upgraded host's own fresh check once upgraded, and `state.json` keeping the session's opening mark across a stop, and probes the next OpenCode binary's time interception as `opencode-upgrade`; without a configured version the fault is skipped | `from`, `to`, both `--version` strings, and `takes_effect` |
| `two_hosts_one_daemon` | At its `session_start`, a second host client opens session `<session>-b` in the same workspace on the arm's daemon and runs one fixed turn, with the proxy's scope on `<session>-b` and its tool runs in `tools.jsonl` under turn `<session>-b`; after the turn the proxy's scope is the primary session with no turn; it stays attached while the primary session opens and runs, and closes at the primary's `session_end`, which first requires its host process to be running, so both clients are registered on the daemon together; `state.json` holds its pid for a resumed arm to reap, and keeps it when the close fails; a run stopped inside that session reaps it and attaches a fresh second client when that session next opens on resume (`state.json` names the session, with or without a live pid, and keeps naming it across further stops until the client is attached or the session ends), its fixed turn already run; daemon calls made for the second client after its turn carry the primary session's scope | The second session, its host pid, the daemon pid, the turn's outcome, and `attached_until` |

`daemon_restart`, `plugin_reload`, `model_switch`, `store_full`,
`host_upgrade`, `two_hosts_one_daemon`, and `apply_diff` fire between
sessions, while the host is stopped, so the harness's writes (the ballast
among them) meet no concurrent host process; one fired inside a session stops
the run. A scheduler-layer fault type with no mechanism here stops the run
before `StartRun`, through the driver's `supports`, so a resume cannot heal
it; provider faults belong to the proxy and the sleep to the clock, so
`supports` accepts them. A daemon that exits outside an
outage window stops the run with `HarnessFailure`; the driver checks the
daemon after every turn, including a turn whose prompt rejected (the daemon's
exit is the cause of a lost connection, so it is reported first), and at
every `session_end`.

## Limits

- Closing the host at `session_end` can cut a memory capture still
  streaming; one smoke run recorded it as `stream_cut`.
- A daemon that dies during a turn is detected when the turn ends; one that
  dies after the last `session_end` of an arm is detected by the next arm's
  resume or by its own log.
- `plugin_reload` adds no mechanism beyond the per-session host process.
- On OpenCode, the turn deadline aborts the session through the server, so a
  server that ignores the abort holds the run for the 30 s drain window.
