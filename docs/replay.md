# Probe replay

`scripts/replay-probe.ts` replays one probe turn of a finished run, under a
declared delivery transform, for delivery-ablation experiments. It rebuilds
the state the probe turn started from, runs that one turn live through the
capture proxy with the variant's transform applied to the turn's agent
requests, grades the turn with the normal grader, and records one result per
repeat. `src/replay/` owns the command.

```sh
bun scripts/replay-probe.ts --run <finished run> --arm <arm> --item <probe id> \
    --variant <a|b|c|d|e or name> --repeats N --out <empty dir> \
    [--allow-identity <field,...>] [--path-mode source|replay] [--keep]
```

The command reads the source run and writes its records under `--out`, which
must be empty and must resolve outside the source run, the directory the run
was recorded in, and the Eidnara checkout; `replay.lock` claims it for the
invocation. In `source` path mode it also creates the recorded arm path when
that path is missing and removes the directories it created afterwards (see
[Path mode](#path-mode)). `--turn <spec>` is the entry point the command
starts for each prepared turn.

The replay serves Pi arms. It refuses a P7 item (judged across two arms), a
P14 item (no probe turn), a probe turn that did not end `ok`, a run whose
journal holds no `EndRun`, a manifest that is not `sim-run-manifest/v3`, a
`scenario.json` that does not hash to the manifest's `scenario_hash` or names
another tier or seed, a journal with no `ClockOffset` before the probe, an
arm whose `capabilities.json` fails grade-run's capability check, an
`eidnara-cf` arm (its grades depend on run-level deletion checks), an arm
that kept its store on `store.img`, a probe turn whose calls carry a proxy
fault, a `host_upgrade` fired on the arm before the probe, and variant `e`
on the `host-oracle` arm, which already delivers the note.

## Variants

The transform runs in the proxy, on each `agent` call whose scope is the probe
turn, after `stripUnsupported` and before the body is stored and forwarded,
so `requests.jsonl` holds exactly what the model received. It rewrites a copy
of the body and the gateway forwards the copy only when the transform
returns; a throw leaves the host's body as sent and fails the repeat.
Background calls (memory capture, summarizers) pass unchanged.
`TRANSFORMS` in `src/replay/transforms.ts` is the registry; a new variant is
one entry there. Campaign runs construct their gateway with no transform, and
a test checks every campaign `Gateway` construction for that.

| Letter | Variant | Rewrite |
|---|---|---|
| a | `none` | forwards each request unchanged: the replay-noise baseline |
| b | `evidence-note` | appends, after the probe text, a note quoting the probe's `ground_truth.sources` events: `Note from earlier sessions:` then `- I wrote: <text>` per user turn, `- <path> was committed with:` and the fenced content per committed file, and `- <path> was removed from the repository.` per removal |
| c | `drop-competing` | in Eidnara-delivered memory listings, drops each item carrying a `stale` or `absent` literal and, in a listing that holds an item carrying a literal of every `present` group, every item that does not; numbered items are renumbered and the listing's count follows |
| d | `provenance-off` | removes Eidnara's provenance wording from delivered memory items: the `trust=[...]` header label, the opening attribution (`User stated:`, `Assistant reported:`), and the JSON provenance record line |
| e | `oracle-note` | puts the `host-oracle` arm's note (`src/run/oracle-note.ts`) ahead of the probe text, after any marker the plugin put in front of it |

Variants c and d read two listing shapes: the numbered search results of an
`eidnara_*` tool (`[1] [memory] score=... id=...`, each item running to its
first blank line) and the `- ` fragments of `<eidnara-search-hint>`. They
also visit `<project-memory>`, `<memory-updates>`, `<project-note>`, and
`<eidnara-search-auto>` blocks; a block or tool result with no listing in
those shapes passes unchanged and is named under `unparsed` in the
application detail. Literals match case-insensitively as substrings, and a
numeric literal matches only as a whole number. A note variant (b or e) that
changes no agent request of a repeat fails that repeat.

The variant digest in the manifest is the SHA-256 of the transform id, the
content of `transforms.ts`, and the transform inputs (probe text, ground
truth, and both notes), so two replays with one digest applied one rewrite.

## Probe-time state

Each repeat rebuilds the arm directory from the source run. `fidelity.json`
in the repeat directory records how each piece was rebuilt and whether it is
exact. Copied trees are checked to resolve inside the repeat's arm directory
before the replay deletes or rewrites anything beneath them.

| Piece | Reconstruction | Fidelity |
|---|---|---|
| Workspace tree | The arm's `snapshot.git` keeps every tree the recorder wrote as a loose object whose modification time is its last write, and a `write-tree` over an unchanged index returns the tree its previous write left newest. The root tree the journal places in a session of the probe's project (the first `Event` or `EndTurn` at or after the write) and written last before the probe turn's first agent call is the probe's start tree. The probe's recorded turn diff must apply to it; when it does not, up to 200 of the project's other root trees are tried nearest in time first. | never `exact`: `latest-write+patch-check` names a tree the turn diff applies to, `latest-write` (empty turn diff) rests on the write-time rule alone, and `patch-search` names a tree the time rule did not pick |
| Workspace files | The source workspace is copied with reflinks, the recorder writes its tree, and a two-tree `read-tree -m -u` moves the files to the start tree; ignored files (build outputs) stay as copied. The recorder then writes the tree again, and `exact` holds when it equals the start tree. | exact for tracked files; ignored files come from the end of the run |
| Workspace git | The branch moves to the newest first-parent commit of the final head from before the probe, and the index resets to it. A harness commit (`sim-user`) whose date and message match an `apply_diff` event of the project counts by that event's place in the scenario; every other commit counts by its commit time against the probe's scenario instant. Git runs with the arm's baseline `<project>.gitconfig` in place of the repository config, hooks and fsmonitor off, and replace refs ignored, and refuses a `.git` that is a link or carries `commondir`, `gitdir`, or alternates. The reflogs and `ORIG_HEAD` are removed, so only refs reach later commits. | `exact` when no ref outside `refs/heads` and `refs/remotes` exists (a stash keeps its final value, listed under `other_refs`); `agent_commits_kept` counts agent commits before the probe |
| Pi transcript | Every session entry before the probe's user message, unchanged, at the same path under the agent directory: the first user message that carries the probe text and was sent no earlier than two seconds before `BeginTurn` on the daemon's clock. | exact in `source` path mode |
| Eidnara store | The arm's data directory is copied and rolled back to the probe. The Kernel versions its rows by commit: rows a commit after the last one recorded before `BeginTurn` (on the daemon's clock) created are deleted, a later invalidation or supersession is undone, and projection and consumer cursors move back to that commit. The guard triggers (the `BEFORE` triggers that raise) are dropped for the rollback and recreated from their recorded SQL, so the schema digest the daemon checks is unchanged, while the maintenance triggers keep firing for each delete. A commit column without a rule refuses the replay. The memory store keeps session working state without history, so rows of the probe's session and of every later session go and rows created after the probe go; a commit column there other than the capture job's refuses the replay. Rows `foreign_key_check` then reports in either database are deleted until it reports none. | not exact. The daemon rebuilds the probe session's working state from the transcript the host sends, so on an arm with Eidnara compaction a mid-session probe's request carries a fresh fold of the history. A capture job committed after the probe stays terminal, since Eidnara clears a job's text when it commits, and its memories are gone with the rollback (`capture_jobs_committed_after_probe`). Memory-store rows without a session or creation time keep their final values, and any other SQLite file under the data directory is listed under `untouched` |
| Clock | The arm's clock offset targets the scenario time of the source turn's `BeginTurn` when the daemon starts. | `clock_lag_ms` in each result is how far the clock had run when the prompt went to the host |
| Arm configuration | The driver derives the profile, `eidnara.jsonc`, and daemon config from the arm label, and the identity check compares them with the manifest's `arms` entry. | exact when the check passes |

The model index is the count of `model_switch` faults fired before the probe,
read from the manifest's `fault_override` when it has one and from the
scenario otherwise. The manifest lists the faults fired on the arm from the
probe's session start to the end of its turn under `session_faults`; the
replay runs with no fault armed.

Measured on S-102-eidnara: probe-session state at its final value folds the
probe message itself away, and the session's rows pruned by creation time
leave a fold the daemon cannot place; dropping the session's rows is the
choice that keeps the probe message and a coherent history.

### Path mode

Eidnara keys project memory by the SHA-256 of the workspace's absolute path,
and Pi puts the working directory into the system prompt. In `source` mode
(the default) each turn runs in its own mount and PID namespace (`sudo -n
unshare --mount --pid --fork --kill-child --mount-proc`) where the prepared
arm directory is bind-mounted at the source arm's recorded path; the
privileged shell pins its `PATH`, runs from `/`, and drops to the invoking
user with `setpriv` before the turn starts. The host and daemon therefore see
the paths the source run saw, the driver's process scans see only the turn's
own processes, and the bind mount ends with the namespace. The recorded arm
path must be normalized and lie under a directory the invoking user owns; a
lock under the system temporary directory named after that path admits one
replay at a time. `source` mode needs passwordless `sudo` for `unshare`, plus
`setpriv` and `mount` in `/usr/bin`.

`replay` mode runs the turn as a child process at the repeat directory's own
path: the transcript header moves to that path, the system prompt differs in
its paths, and the store's project keys name the source path, so memory
scoped to the project is unreachable. The fixture tests use `replay` mode.

## Identity

Before any repeat, the command runs preflight in `--out`, with the source run
and its recorded directory added to the sandbox's masked roots, and compares
the source manifest with this environment: `eidnara_commit`,
`eidnara_worktree`, `prereg_sha256`, `toolchain`, every `binaries` digest,
`bedrock.region`, the probe project's corpus checkout, the arm's `arms`
entry, the agent model, the preflight's interception results and host
versions, and the sim tree. The sim check names `sim_worktree` when the
source run was recorded from a tree with uncommitted content, and lists each
path in `REPLAY_PATHS` that differs between the source run's `sim_commit`
and this working tree, or `sim_commit` when that commit is no ancestor of
this checkout. `REPLAY_PATHS` is `MEASUREMENT_PATHS` without the scenario
compiler, corpus, user-sim, and oracle checks, whose compiled output a
replay reads, and without the scenario clock and resource sampler, which
the replay does not run. Any difference refuses the replay after the
manifest is written. `--allow-identity` takes field names (`binaries` covers
every `binaries.*` entry, `sim` every `sim:*` path) and the manifest records
the drift, the allowed fields, and the refused ones.

## Outputs

```text
<out>/
  replay-manifest.json   schema sim-replay-manifest/v1, kind probe-replay
  results.jsonl          one line per repeat
  sandbox.sh, interception/, toolbin/   preflight
  r<k>/
    turn-spec.json  turn.json  fidelity.json
    calls.jsonl  requests.jsonl          the repeat's proxy records
    <arm>/snapshots.jsonl  graded-snapshot.json  tools.jsonl  commands.jsonl  daemon.log
```

The manifest records the source run (directory, recorded directory, manifest
digest, scenario hash, tier, seed, host, sim commit and working-tree digest,
Eidnara commit, and its grade of the item with that grade's grader digest),
the arm, item, probe type, event, session, and project, the variant with its
digest and inputs, the repeat count, the path mode, this checkout's sim
commit and working-tree digest, the Eidnara commit and working-tree digest,
the grader digest, the identity check, the chosen workspace tree, the model
index, the session's fault firings, the clock targets, and the preflight.

Each result holds the verdict, the reason (the grade's false metrics, then
any failure), the grade record, the cost priced at the source run's price
table in total (`cost_usd`, every call the repeat's proxy saw, session open
included), for the probe turn's own calls (`cost_turn_usd`), and per
component, the prompt latency, the agent call count, each call's request
digest and size, the count of rewritten requests, the request prefix
comparison, failures, notes, and the clock lag. The verdict is the grade's
(`pass`, `fail`, or `excluded`), `refused` with the grader's reason,
`turn-failed` when the probe turn failed, `no-snapshot`, or `harness-failed`
whenever the repeat recorded a failure: a transform that threw, a note
variant that changed nothing, a daemon exit, a proxy failure, or an error
before the turn ran. A harness failure takes precedence over a decided
grade, which stays in the record. The prefix comparison sets the first agent
request the host sent in the replay, before the transform, against the
source turn's first agent request, through the probe message: `identical`
when both hold the probe message and the bytes match, otherwise the fields
and the first differing paths with their text around the first differing
character.

The graded snapshot is the driver's capture of the replayed turn with the
source snapshot's prior-session diff added and, for a P12 item that reads it,
the `source` command log built from the source arm's `tools.jsonl`
(`src/grade/source-commands.ts`, shared with `grade-run` and part of the
grader digest). Its calls are the source session's calls before the probe
turn followed by the replay's own. Background calls still running when the
settle window (5 s quiet, 30 s at most) closes are noted, and the driver's
stop ends them. Without `--keep`, each repeat's workspace, home, store, and
snapshot repository are removed after grading.

A replay directory holds no `manifest.json`, `journal.jsonl`, or
`grades.jsonl`, so `grade-run`, `report`, `evidence-run`, `aa-report`,
`pairing-check`, and `oracle-run` refuse it, and no campaign report pools a
replay.
