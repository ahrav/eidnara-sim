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

The command reads the source run and writes only under `--out`, which must be
empty and must lie outside the source run, the directory the run was recorded
in, and the Eidnara checkout. It serves Pi arms. P7 (judged across two arms)
and P14 (no probe turn) items are refused, as is a probe turn that did not end
`ok` or a run whose journal holds no `EndRun`.

## Variants

The transform runs in the proxy, on each `agent` call whose scope is the probe
turn, after `stripUnsupported` and before the body is stored and forwarded,
so `requests.jsonl` holds exactly what the model received. Background calls
(memory capture, summarizers) pass unchanged. `TRANSFORMS` in
`src/replay/transforms.ts` is the registry; a new variant is one entry there.
Campaign runs construct their gateway with no transform, and a test checks
every campaign `Gateway` construction for that.

| Letter | Variant | Rewrite |
|---|---|---|
| a | `none` | forwards each request unchanged: the replay-noise baseline |
| b | `evidence-note` | appends, after the probe text, a note quoting the probe's `ground_truth.sources` events: `Note from earlier sessions:` then `- I wrote: <text>` per user turn and the fenced content of each committed file |
| c | `drop-competing` | in Eidnara-delivered memory (an `eidnara_*` tool result, or a `<project-memory>`, `<memory-updates>`, `<project-note>`, `<eidnara-search-auto>`, or `<eidnara-search-hint>` block), drops each item carrying a `stale` or `absent` literal and, in a listing that holds an item carrying a literal of every `present` group, every item that does not; numbered items are renumbered and the listing's count follows |
| d | `provenance-off` | removes Eidnara's provenance wording from delivered memory items: the `trust=[...]` header label, the opening attribution (`User stated:`, `Assistant reported:`), and the JSON provenance record line |
| e | `oracle-note` | puts the `host-oracle` arm's note (`src/run/oracle-note.ts`) ahead of the probe text, after any marker the plugin put in front of it |

Literals match case-insensitively, a number as a whole value, as the
scenario's exposure checks compare them. The variant digest in the manifest
is the SHA-256 of the transform id, the content of `transforms.ts`, and the
transform inputs (probe text, ground truth, and both notes), so two replays
with one digest applied one rewrite.

## Probe-time state

Each repeat rebuilds the arm directory from the source run. `fidelity.json`
in the repeat directory records how each piece was rebuilt and whether it is
exact.

| Piece | Reconstruction | Fidelity |
|---|---|---|
| Workspace tree | The arm's `snapshot.git` keeps every tree the recorder wrote as a loose object whose modification time is its last write, and a `write-tree` over an unchanged index returns the tree its previous write left newest. The root tree the journal places in a session of the probe's project (the first `Event` or `EndTurn` at or after the write) and written last before the probe turn's first call is the probe's start tree. The probe's recorded turn diff must apply to it; when it does not, the project's other root trees are tried nearest in time first. | `latest-write+patch-check` is exact when the turn diff is non-empty; `latest-write` with an empty diff rests on the write-time rule; `patch-search` marks a tree the time rule did not pick |
| Workspace files | The source workspace is copied with reflinks, the recorder writes its tree, and a two-tree `read-tree -m -u` moves the files to the start tree; ignored files (build outputs) stay as copied. The recorder then writes the tree again, and `exact` holds when it equals the start tree. | exact for tracked files; ignored files come from the end of the run |
| Workspace git | The branch moves to the last first-parent commit of the final head committed at or before the probe's scenario instant (the harness dates each `apply_diff` commit with its event's instant, and the agent's git reads the injected clock), and the index resets to it. | `other_refs` lists refs outside `refs/heads` (a stash), which keep their final values; `agent_commits_kept` counts agent commits before the probe |
| Pi transcript | Every session entry before the first user message carrying the probe text, unchanged, at the same path under the agent directory. | exact in `source` path mode |
| Eidnara store | The arm's data directory is copied and rolled back to the probe. The Kernel versions its rows by commit: rows a commit after the last one recorded before `BeginTurn` (on the daemon's clock) created are deleted, a later invalidation or supersession is undone, and projection and consumer cursors move back to that commit; the append-only and immutability triggers are dropped for the rollback and recreated from their recorded SQL, so the schema digest the daemon checks is unchanged. A commit column without a rule refuses the replay. The memory store keeps session working state without history, so rows of the probe's session and of every later session go, rows created after the probe go, and a capture job committed or abandoned after the probe is pending again. | not exact: the daemon rebuilds the probe session's working state from the transcript the host sends, and memory-store rows without a session or creation time keep their final values |
| Clock | The arm's clock offset targets the scenario time of the source turn's `BeginTurn` when the daemon starts. | `clock_lag_ms` in each result is how far the clock had run when the prompt went to the host |
| Arm configuration | The driver derives the profile, `eidnara.jsonc`, and daemon config from the arm label, and the identity check compares them with the manifest's `arms` entry. | exact when the check passes |

The model index is the count of `model_switch` faults fired before the probe;
a `host_upgrade` before the probe refuses the replay.

### Path mode

Eidnara keys project memory by the SHA-256 of the workspace's absolute path,
and Pi puts the working directory into the system prompt. In `source` mode
(the default) the turn runs in a private mount namespace
(`sudo unshare --mount`) where the prepared arm directory is bind-mounted at
the source arm's recorded path, so the host and daemon see the paths the
source run saw; the bind mount exists only inside that namespace. A missing
mount point is created and removed afterwards. `replay` mode runs at the
repeat directory's own path: the transcript header moves to that path, the
system prompt differs in its paths, and the store's project keys name the
source path, so memory scoped to the project is unreachable. The fixture
tests use `replay` mode.

## Identity

Before any repeat, the command runs preflight in `--out` and compares the
source manifest with this environment: `eidnara_commit`, `eidnara_worktree`,
`prereg_sha256`, `toolchain`, every `binaries` digest, `bedrock.region`, the
probe project's corpus checkout, the arm's `arms` entry, the agent model, the
preflight's interception results and host versions, and the sim paths. The sim
check lists each path in `REPLAY_PATHS` (`MEASUREMENT_PATHS` without the
scenario compiler, corpus, user-sim, oracles, clock, and sampler, which a
replay reads as compiled output) that differs between the source run's
`sim_commit` and this working tree, or `sim_commit` when that commit is no
ancestor of this checkout. Any difference refuses the replay after the
manifest is written. `--allow-identity` takes field names (`binaries`
covers every `binaries.*` entry, `sim` every `sim:*` path) and the manifest
records the drift, the allowed fields, and the refused ones.

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
digest, tier, seed, host, sim and Eidnara commits, and its grade of the item),
the arm, item, probe type, event, session, and project, the variant with its
digest and inputs, the repeat count, the path mode, this checkout's sim commit
and working-tree digest, the Eidnara commit and working-tree digest, the
grader digest, the identity check, the chosen workspace tree, the clock
targets, and the preflight.

Each result holds the verdict (`pass`, `fail`, `refused` with the grader's
reason, `turn-failed`, `no-snapshot`, or `harness-failed` when the turn
failed before a grade), the reason (the grade's false metrics, then any turn
failure), the grade record, the cost priced at the source run's price table
in total and per component, the prompt latency, the agent call count, each
call's request digest and size, the count of rewritten requests, the request
prefix comparison, failures, notes, and the clock lag. The prefix comparison
sets the first agent request the host sent in the replay, before the
transform, against the source turn's first agent request, through the probe
message: `identical` when the bytes match, otherwise the fields and the first
differing paths with their text around the first differing character.

The graded snapshot is the driver's capture of the replayed turn with the
source snapshot's prior-session diff added and, for a P12 item that reads it,
the `source` command log built from the source arm's `tools.jsonl`
(`src/grade/source-commands.ts`, shared with `grade-run`). Its calls are the
source session's calls before the probe turn followed by the replay's own.
Background calls still running when the settle window (5 s quiet, 30 s at
most) closes are noted, and the driver's stop ends them. Without `--keep`,
each repeat's workspace, home, store, and snapshot repository are removed
after grading.

A replay directory holds no `manifest.json`, `journal.jsonl`, or
`grades.jsonl`, so `grade-run`, `report`, `evidence-run`, `aa-report`,
`pairing-check`, and `oracle-run` refuse it, and no campaign report pools a
replay.
