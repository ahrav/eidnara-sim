import { createHash } from "node:crypto";
import {
    appendFileSync,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { requireCapabilities } from "../../scripts/grade-run";
import type { SimConfig } from "../config/config";
import { git } from "../git";
import type { Artefact, CallView, Command, Snapshot } from "../grade/artefacts";
import { assertArtefactsOnly, GradeRefused } from "../grade/artefacts";
import { type GradeRecord, gradeItem, graderDigest } from "../grade/probes";
import { readToolLedger, sourceEvents, withSourceCommands } from "../grade/source-commands";
import { armProfile, deliveryOf } from "../hosts/profiles";
import { SnapshotRecorder } from "../hosts/snapshot";
import type { ConverseBody } from "../proxy/classify";
import type { CallRecord } from "../proxy/records";
import { RequestPartLog, rebuildRequest } from "../proxy/requests";
import { componentCosts } from "../report/cost";
import { readJsonl } from "../run/journal";
import { oracleBackground } from "../run/oracle-note";
import { type Preflight, preflight, preflightDrift } from "../run/preflight";
import { armConfigs, MEASUREMENT_PATHS, runIdentity, simIdentity } from "../run/run";
import type { ScenarioEvent } from "../run/scheduler";
import { loadPrereg } from "../scenario/inputs";
import { daemonCutoffMs, loadProbeSource, type ProbeSource } from "./source";
import {
    type Commit,
    checkoutTree,
    copyTree,
    type Fidelity,
    probeTree,
    requireInside,
    rewindHead,
    rollbackStore,
    truncateSession,
} from "./state";
import {
    evidenceNote,
    probeBlock,
    projectMemoryBlock,
    type TransformInputs,
    transformDigest,
    transformFor,
} from "./transforms";
import type { TurnResult, TurnSpec } from "./turn";

export const REPLAY_SCHEMA = "sim-replay-manifest/v1";
export const REPLAY_MANIFEST = "replay-manifest.json";
const ROOT = resolve(import.meta.dir, "../..");
const CLEAN_WORKTREE = createHash("sha256").digest("hex");
const NOTE_VARIANTS = new Set(["evidence-note", "oracle-note", "memory-block"]);

/**
 * Replay consumes the run's compiled scenario and delivered probe text; its identity check
 * covers replay-executed measurement paths.
 */
const UNEXECUTED = new Set([
    "src/scenario",
    "src/corpus",
    "corpus",
    "src/usersim",
    "src/oracle",
    "src/run/clock.ts",
    "src/run/sampler.ts",
]);
export const REPLAY_PATHS = MEASUREMENT_PATHS.filter((p) => !UNEXECUTED.has(p));

export type PathMode = "source" | "replay";
export type Verdict =
    | "pass"
    | "fail"
    | "excluded"
    | "refused"
    | "turn-failed"
    | "no-snapshot"
    | "harness-failed";

export interface Mount {
    from: string;
    to: string;
}

export interface ReplayOptions {
    config: SimConfig;
    run: string;
    arm: string;
    item: string;
    variant: string;
    repeats: number;
    out: string;
    allowIdentity?: string[];
    pathMode?: PathMode;
    keep?: boolean;
    preflight?: (config: SimConfig, root: string, masked: string[]) => Promise<Preflight>;
    identity?: (source: ProbeSource) => Record<string, unknown>;
    turn?: (spec: TurnSpec, specPath: string, mount: Mount | null) => Promise<TurnResult>;
    settleQuietMs?: number;
    settleMaxMs?: number;
}

export interface PrefixComparison {
    identical: boolean;
    probe_found: { source: boolean; replay: boolean };
    source_sha256: string;
    replay_sha256: string;
    fields: Record<string, boolean>;
    messages: { source: number; replay: number };
    differences: string[];
}

export interface RepeatResult {
    repeat: number;
    variant: string;
    verdict: Verdict;
    reason: string;
    grade: GradeRecord | null;
    cost_usd: number;
    cost_turn_usd: number;
    cost: ReturnType<typeof componentCosts>;
    prompt_ms: number | null;
    agent_calls: number;
    requests: { seq: number; component: string; sha256: string | null; bytes: number | null }[];
    transformed: number | null;
    prefix: PrefixComparison | null;
    failures: string[];
    notes: string[];
    clock_lag_ms: number | null;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

function jsonDiff(a: unknown, b: unknown, path: string, out: string[], limit = 12): string[] {
    if (out.length >= limit || JSON.stringify(a) === JSON.stringify(b)) return out;
    if (typeof a === "string" && typeof b === "string") {
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) i++;
        const ctx = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 80));
        out.push(`${path || "."} at char ${i}: source ${ctx(a)} replay ${ctx(b)}`);
        return out;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) {
            out.push(`${path}: ${a.length} items in source, ${b.length} in replay`);
        }
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            jsonDiff(a[i], b[i], `${path}[${i}]`, out, limit);
        }
        return out;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
        const x = a as Record<string, unknown>;
        const y = b as Record<string, unknown>;
        for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
            jsonDiff(x[k], y[k], `${path}.${k}`, out, limit);
        }
        return out;
    }
    const show = (v: unknown) => JSON.stringify(v)?.slice(0, 80);
    out.push(`${path}: source ${show(a)} replay ${show(b)}`);
    return out;
}

export function requestPrefix(
    body: ConverseBody,
    probeText: string,
): { prefix: ConverseBody; found: boolean } {
    const at = probeBlock(body, probeText);
    const messages = body.messages ?? [];
    return {
        prefix: { ...body, messages: messages.slice(0, at ? at.message + 1 : 0) },
        found: at !== null,
    };
}

export function comparePrefix(
    source: ConverseBody,
    replay: ConverseBody,
    probeText: string,
): PrefixComparison {
    const a = requestPrefix(source, probeText);
    const b = requestPrefix(replay, probeText);
    const fields: Record<string, boolean> = {};
    for (const k of new Set([...Object.keys(a.prefix), ...Object.keys(b.prefix)])) {
        fields[k] = JSON.stringify(a.prefix[k]) === JSON.stringify(b.prefix[k]);
    }
    const sa = JSON.stringify(a.prefix);
    const sb = JSON.stringify(b.prefix);
    return {
        identical: a.found && b.found && sa === sb,
        probe_found: { source: a.found, replay: b.found },
        source_sha256: sha256(sa),
        replay_sha256: sha256(sb),
        fields,
        messages: {
            source: a.prefix.messages?.length ?? 0,
            replay: b.prefix.messages?.length ?? 0,
        },
        differences: jsonDiff(a.prefix, b.prefix, "", []),
    };
}

export function currentIdentity(config: SimConfig, source: ProbeSource): Record<string, unknown> {
    const prereg = loadPrereg(source.manifest.tier as never);
    const sideModel = source.manifest.side_model ?? (source.manifest.models[0] as string);
    return {
        ...runIdentity(config, prereg, [source.project]),
        arms: armConfigs([source.arm], sideModel),
        agent_model: config.agent_model,
    };
}

function simPathsChanged(from: string, root: string): string[] | null {
    try {
        git(root, ["merge-base", "--is-ancestor", from, "HEAD"]);
        return git(root, ["diff", "--name-only", from, "--", ...REPLAY_PATHS])
            .split("\n")
            .filter(Boolean);
    } catch {
        return null;
    }
}

export function identityDrift(
    source: ProbeSource,
    current: Record<string, unknown>,
    root = ROOT,
): string[] {
    const m = source.manifest as Record<string, unknown>;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const drift: string[] = [];
    for (const k of ["eidnara_commit", "eidnara_worktree", "prereg_sha256", "toolchain"]) {
        if (!same(m[k], current[k])) drift.push(k);
    }
    const binaries = (current.binaries ?? {}) as Record<string, string>;
    const recorded = (m.binaries ?? {}) as Record<string, string>;
    for (const k of new Set([...Object.keys(binaries), ...Object.keys(recorded)])) {
        if (recorded[k] !== binaries[k]) drift.push(`binaries.${k}`);
    }
    const region = (x: unknown) => (x as { region?: string } | undefined)?.region;
    if (region(m.bedrock) !== region(current.bedrock)) drift.push("bedrock.region");
    const corpus = (x: unknown) => (x as Record<string, unknown> | undefined)?.[source.project];
    if (!same(corpus(m.corpus), corpus(current.corpus))) drift.push(`corpus.${source.project}`);
    const arms = (x: unknown) => (x as Record<string, unknown> | undefined)?.[source.arm];
    if (!same(arms(m.arms), arms(current.arms))) drift.push(`arms.${source.arm}`);
    if (!source.manifest.models.includes(String(current.agent_model))) drift.push("agent_model");
    if (m.sim_worktree !== CLEAN_WORKTREE) drift.push("sim_worktree");
    if (current.sim_worktree !== undefined && current.sim_worktree !== CLEAN_WORKTREE) {
        drift.push("sim:worktree");
    }
    const changed = simPathsChanged(String(m.sim_commit), root);
    if (changed === null) drift.push("sim_commit");
    else drift.push(...changed.map((p) => `sim:${p}`));
    return drift;
}

function transformInputs(source: ProbeSource): TransformInputs {
    const gt = source.probe.ground_truth;
    return {
        probe_text: String(source.event.text ?? ""),
        ground_truth: {
            present: gt?.present ?? [],
            stale: gt?.stale ?? [],
            absent: gt?.absent ?? [],
        },
        oracle_note: oracleBackground(source.scenario, source.probe.id),
        evidence_note: evidenceNote(
            source.scenario.events as unknown as Record<string, unknown>[],
            gt?.sources ?? [],
        ),
        project_memory: projectMemoryBlock(
            source.scenario.events as unknown as Record<string, unknown>[],
            gt?.sources ?? [],
            source.probe.type,
        ),
    };
}

const oracleArm = (source: ProbeSource) => deliveryOf(armProfile(source.arm)) === "oracle-context";

function deliveredText(source: ProbeSource): string {
    const text = String(source.event.text ?? "");
    if (!oracleArm(source)) return text;
    return `${oracleBackground(source.scenario, source.probe.id) ?? ""}${text}`;
}

const corpusCommit = (source: ProbeSource): string =>
    String(
        (source.manifest.corpus as Record<string, { commit?: string }> | undefined)?.[
            source.project
        ]?.commit ?? "",
    );

function sourceFaults(source: ProbeSource): { id: string; type: string }[] {
    const override = source.manifest.fault_override as { id: string; type: string }[] | null;
    return override ?? (source.scenario.faults as unknown as { id: string; type: string }[]);
}

function modelIndex(source: ProbeSource): number {
    const types = new Map(sourceFaults(source).map((f) => [f.id, f.type]));
    const unknown = source.journal.filter(
        (e) => e.arm === source.arm && e.kind === "FaultFired" && !types.has(String(e.fault)),
    );
    if (unknown.length > 0) {
        const ids = unknown.map((e) => String(e.fault)).join(", ");
        throw new Error(`the journal fires faults its fault schedule lacks: ${ids}`);
    }
    const fired = source.journal.filter(
        (e) => e.arm === source.arm && e.kind === "FaultFired" && e.seq < source.begin.seq,
    );
    if (fired.some((e) => types.get(String(e.fault)) === "host_upgrade")) {
        throw new Error(`a host_upgrade fired on ${source.arm} before the probe`);
    }
    const observed = new Set(
        source.journal
            .filter(
                (e) =>
                    e.arm === source.arm && e.kind === "FaultObserved" && e.seq < source.begin.seq,
            )
            .map((e) => String(e.fault)),
    );
    return fired.filter(
        (e) => types.get(String(e.fault)) === "model_switch" && observed.has(String(e.fault)),
    ).length;
}

function sessionFaults(source: ProbeSource): Record<string, unknown>[] {
    const types = new Map(sourceFaults(source).map((f) => [f.id, f.type]));
    const start = source.journal.find(
        (e) => e.arm === source.arm && e.kind === "Event" && e.event === source.sessionStart.id,
    );
    return source.journal
        .filter(
            (e) =>
                e.arm === source.arm &&
                e.kind === "FaultFired" &&
                e.seq <= source.end.seq &&
                (start === undefined || e.seq >= start.seq - 1),
        )
        .map((e) => ({ fault: e.fault, type: types.get(String(e.fault)) ?? null, seq: e.seq }));
}

function keepCommit(source: ProbeSource): (c: Commit) => boolean {
    const events = source.scenario.events as unknown as ScenarioEvent[];
    const at = events.indexOf(source.event);
    const base = source.manifest.base_wall_ms;
    const key = (e: ScenarioEvent) =>
        `${Math.floor((base + e.scenario_ms) / 1000)} ${e.remove === true ? "Remove" : "Add"} ${String(e.path)}`;
    const applies = events
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.kind === "apply_diff" && e.project === source.project);
    const before = new Set(applies.filter(({ i }) => i < at).map(({ e }) => key(e)));
    const after = new Set(applies.filter(({ i }) => i > at).map(({ e }) => key(e)));
    const cutoffS = Math.floor((base + source.begin.scenario_ms) / 1000);
    return (c) => {
        if (c.email.startsWith("sim-user@")) {
            const k = `${c.ct} ${c.subject}`;
            if (before.has(k)) return true;
            if (after.has(k)) return false;
        }
        return c.ct <= cutoffS;
    };
}

function commandLog(source: ProbeSource, role: string): Command[] {
    const log = source.snapshot.artefacts.find(
        (a): a is Extract<Artefact, { class: "command-log" }> =>
            a.class === "command-log" && a.role === role,
    );
    return log?.commands ?? [];
}

function priorCommands(source: ProbeSource): Command[] {
    const turn = new Set(commandLog(source, "turn").map((c) => c.call));
    return commandLog(source, "session").filter((c) =>
        c.call ? !turn.has(c.call) : c.scenario_ms < source.begin.scenario_ms,
    );
}

function priorCalls(source: ProbeSource): CallView[] {
    const calls =
        source.snapshot.artefacts.find(
            (a): a is Extract<Artefact, { class: "proxy-call" }> => a.class === "proxy-call",
        )?.calls ?? [];
    return calls.filter(
        (c) => c.turn !== source.event.id || (c.component === "user-sim" && c.journal === true),
    );
}

const SNAPSHOT_CONFIG =
    "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n\thooksPath = /dev/null\n";

function trustSnapshotGit(gitDir: string): void {
    const linked = readdirSync(gitDir, { recursive: true, withFileTypes: true }).find(
        (d) => !d.isDirectory() && !d.isFile(),
    );
    if (linked) {
        throw new Error(
            `${gitDir} holds a link or special file at ${join(linked.parentPath, linked.name)}`,
        );
    }
    if (existsSync(join(gitDir, "objects", "info", "alternates"))) {
        throw new Error(`${gitDir} borrows objects through alternates`);
    }
    rmSync(join(gitDir, "config"), { force: true });
    rmSync(join(gitDir, "hooks"), { recursive: true, force: true });
    writeFileSync(join(gitDir, "config"), SNAPSHOT_CONFIG, { flag: "wx" });
}

function requireRealDir(path: string, root: string): void {
    if (!lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`${path} is not a real directory`);
    }
    requireInside(path, root);
}

function prepareRepeat(o: {
    source: ProbeSource;
    armDir: string;
    visibleArmDir: string;
    pathMode: PathMode;
    tree: { id: string; fidelity: Fidelity };
    model: number;
    gitTimeoutMs: number;
}): Record<string, Fidelity> {
    const { source } = o;
    const from = join(source.dir, source.arm);
    mkdirSync(join(o.armDir, "runtime"), { recursive: true });
    mkdirSync(join(o.armDir, "clock"), { recursive: true });
    copyTree(join(from, "snapshot.git"), join(o.armDir, "snapshot.git"));
    requireRealDir(join(o.armDir, "snapshot.git"), o.armDir);
    trustSnapshotGit(join(o.armDir, "snapshot.git"));
    for (const f of readdirSync(from).filter((f) => f.endsWith(".gitconfig"))) {
        if (!lstatSync(join(from, f)).isFile())
            throw new Error(`${join(from, f)} is not a regular file`);
        copyFileSync(join(from, f), join(o.armDir, f));
    }
    const state = json<Record<string, unknown>>(join(from, "snapshot-state.json"));
    const open = { session: source.event.session, ended: null, last: {}, lastGap: {} };
    writeFileSync(join(o.armDir, "snapshot-state.json"), JSON.stringify({ ...state, ...open }));
    const commands = priorCommands(source).map((c) => `${JSON.stringify(c)}\n`);
    writeFileSync(join(o.armDir, "commands.jsonl"), commands.join(""));
    const workspace = join(o.armDir, "r", "workspaces", source.project);
    copyTree(join(from, "r", "workspaces", source.project), workspace);
    requireInside(workspace, o.armDir);
    const recorder = new SnapshotRecorder(o.armDir, source.arm, () => [], o.gitTimeoutMs);
    const copied = recorder.tree(workspace);
    checkoutTree({
        gitDir: join(o.armDir, "snapshot.git"),
        workspace,
        from: copied,
        to: o.tree.id,
        scratch: join(o.armDir, "replay-restore.index"),
    });
    const restored = recorder.tree(workspace);
    const home = join(o.armDir, "r", "home");
    copyTree(join(from, "r", "home"), home);
    const agentDir = join(home, ".pi", "agent");
    requireInside(agentDir, o.armDir);
    rmSync(join(agentDir, "sessions"), { recursive: true, force: true });
    const visibleWorkspace = join(o.visibleArmDir, "r", "workspaces", source.project);
    const fidelity: Record<string, Fidelity> = {
        workspace_tree: o.tree.fidelity,
        workspace_files: {
            method: "two-tree-checkout",
            exact: restored === o.tree.id,
            detail: { copied, restored, target: o.tree.id },
        },
        workspace_git: rewindHead({
            workspace,
            gitconfig: join(o.armDir, `${source.project}.gitconfig`),
            keep: keepCommit(source),
            base: corpusCommit(source),
        }),
        transcript: truncateSession({
            fromAgentDir: join(from, "r", "home", ".pi", "agent"),
            toAgentDir: agentDir,
            sessionId: `sim-${source.event.session}`,
            probeText: deliveredText(source),
            sentFrom: daemonCutoffMs(source) - 2_000,
            ...(o.pathMode === "replay" ? { cwd: visibleWorkspace } : {}),
        }).fidelity,
    };
    if (armProfile(source.arm).daemon !== null) {
        const dataDir = join(o.armDir, "s", "d");
        copyTree(join(from, "s"), join(o.armDir, "s"));
        requireInside(dataDir, o.armDir);
        const store = rollbackStore({
            dataDir,
            cutoffMs: daemonCutoffMs(source),
            sessions: [source.event.session, ...source.laterSessions].map((s) => `sim-${s}`),
        });
        if (o.pathMode === "replay") store.detail.project_keys = "keyed by the source path";
        fidelity.store = store;
    }
    const armState = {
        model: o.model,
        upgraded: false,
        second: null,
        second_owed: null,
        transcript_mark: null,
        second_exited: null,
        daemon: null,
        switched: null,
        host: null,
        ballast: null,
        refilling: false,
        git: null,
        failed: null,
        store_faults: {},
    };
    writeFileSync(join(o.armDir, "state.json"), JSON.stringify(armState));
    return fidelity;
}

function gradeRepeat(
    source: ProbeSource,
    armDir: string,
): { grade: GradeRecord | null; verdict: Verdict; reason: string } {
    const path = join(armDir, "snapshots.jsonl");
    if (!existsSync(path)) {
        return { grade: null, verdict: "no-snapshot", reason: "the turn left no snapshot" };
    }
    const rows = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const row = JSON.parse(rows.at(-1) as string) as Snapshot;
    const prior = source.snapshot.artefacts.filter(
        (a) => a.class === "diff" && a.role === "prior-session",
    );
    const events = source.scenario.events as unknown as Record<string, unknown>[];
    const sources = sourceEvents(source.probe, events);
    const snap = withSourceCommands(
        { ...row, artefacts: [...row.artefacts, ...prior] },
        source.probe,
        sources,
        events,
        () => readToolLedger(join(source.dir, source.arm, "tools.jsonl"), source.arm),
    );
    writeFileSync(join(armDir, "graded-snapshot.json"), `${JSON.stringify(snap)}\n`);
    const rules = loadPrereg(source.manifest.tier as never).grading;
    try {
        assertArtefactsOnly(snap);
        const grade = gradeItem(source.probe, [snap], rules, 1, sources);
        if (!grade) return { grade: null, verdict: "turn-failed", reason: "the probe turn failed" };
        const failing = Object.entries(grade.metrics)
            .filter(([, v]) => v === false)
            .map(([k]) => k);
        return { grade, verdict: grade.verdict, reason: grade.reason ?? failing.join(", ") };
    } catch (caught) {
        if (!(caught instanceof GradeRefused)) throw caught;
        return { grade: null, verdict: "refused", reason: caught.message };
    }
}

function sourceFirstRequest(source: ProbeSource): ConverseBody | null {
    const first = source.calls.find((c) => c.component === "agent" && c.request);
    if (!first?.request) return null;
    const parts = new RequestPartLog(join(source.dir, "requests.jsonl"));
    try {
        return rebuildRequest(first.request, parts);
    } finally {
        parts.close();
    }
}

const NAMESPACE = [
    "set -e",
    "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    "cd /",
    '/usr/bin/mount --bind "$1" "$2"',
    "uid=$3; gid=$4; path=$5; user=$6",
    "shift 6",
    'exec /usr/bin/setpriv --reuid "$uid" --regid "$gid" --init-groups -- /usr/bin/env PATH="$path" USER="$user" LOGNAME="$user" "$@"',
].join("\n");

export class ReplayInterrupted extends Error {}

export async function spawnTurn(
    spec: TurnSpec,
    specPath: string,
    mount: Mount | null,
): Promise<TurnResult> {
    const script = join(ROOT, "scripts", "replay-probe.ts");
    const self = [process.execPath, script, "--turn", specPath];
    const argv = mount
        ? [
              "sudo",
              "-n",
              "--preserve-env",
              "unshare",
              "--mount",
              "--pid",
              "--fork",
              "--kill-child",
              "--mount-proc",
              "--propagation",
              "private",
              "--",
              "/bin/sh",
              "-c",
              NAMESPACE,
              "sh",
              mount.from,
              mount.to,
              String(process.getuid?.()),
              String(process.getgid?.()),
              process.env.PATH ?? "",
              process.env.USER ?? "",
              ...self,
          ]
        : self;
    const child = Bun.spawn(argv, { stdio: ["ignore", "inherit", "inherit"], cwd: ROOT });
    let signalled: NodeJS.Signals | null = null;
    const forward = (signal: NodeJS.Signals) => {
        signalled = signal;
        child.kill(signal);
    };
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const s of signals) process.on(s, forward);
    let code: number;
    try {
        code = await child.exited;
    } finally {
        for (const s of signals) process.off(s, forward);
    }
    if (signalled) {
        throw new ReplayInterrupted(
            `replay interrupted by ${signalled}; the turn process exited ${code}`,
        );
    }
    const result = join(spec.out, "turn.json");
    if (!existsSync(result)) throw new Error(`the turn process exited ${code} without ${result}`);
    return json<TurnResult>(result);
}

function canonical(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        const parent = dirname(path);
        return parent === path ? path : join(canonical(parent), basename(path));
    }
}

const contains = (dir: string, path: string) => path === dir || path.startsWith(`${dir}/`);

function requireOutside(out: string, dirs: string[]): void {
    const real = canonical(out);
    for (const dir of dirs) {
        if (contains(canonical(dir), real)) throw new Error(`--out ${out} lies inside ${dir}`);
    }
}

function claimMountPoint(path: string): { release: () => void } {
    if (resolve(path) !== path) throw new Error(`recorded arm path ${path} is not normalized`);
    let existing = path;
    const missing: string[] = [];
    while (!existsSync(existing)) {
        missing.push(existing);
        existing = dirname(existing);
    }
    const owner = statSync(existing);
    if (!owner.isDirectory() || owner.uid !== process.getuid?.() || existing === "/") {
        throw new Error(`recorded arm path ${path} lies under ${existing}, owned by another user`);
    }
    const lockDir = join(tmpdir(), `sim-replay-${process.getuid?.()}`);
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const dir = lstatSync(lockDir);
    if (!dir.isDirectory() || dir.uid !== process.getuid?.() || (dir.mode & 0o077) !== 0) {
        throw new Error(`${lockDir} is not a private directory of this user`);
    }
    const lock = join(lockDir, `${sha256(path).slice(0, 16)}.lock`);
    for (let attempt = 0; ; attempt++) {
        try {
            writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
            break;
        } catch (caught) {
            if ((caught as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw caught;
            const holder = Number(readFileSync(lock, "utf8"));
            let alive = false;
            try {
                process.kill(holder, 0);
                alive = true;
            } catch {
                alive = false;
            }
            if (alive) throw new Error(`replay ${holder} holds ${path} (${lock})`);
            rmSync(lock, { force: true });
        }
    }
    mkdirSync(path, { recursive: true });
    return {
        release: () => {
            for (const dir of missing) {
                try {
                    rmdirSync(dir);
                } catch {
                    break;
                }
            }
            rmSync(lock, { force: true });
        },
    };
}

function refuseUnreplayable(source: ProbeSource, variant: string): void {
    if (source.manifest.host !== "pi") throw new Error("replay runs Pi arms only");
    if (source.arm.split("~")[0] === "eidnara-cf") {
        throw new Error("eidnara-cf grades depend on run-level deletion checks");
    }
    if (existsSync(join(source.dir, source.arm, "store.img"))) {
        throw new Error(`${source.arm} kept its store on a loop image, which replay cannot mount`);
    }
    if (variant === "oracle-note" && oracleArm(source)) {
        throw new Error(`${source.arm} already delivers the oracle note`);
    }
    const faulted = source.calls.filter((c) => c.fault_ref !== null && c.fault_ref !== undefined);
    if (faulted.length > 0) {
        const refs = [...new Set(faulted.map((c) => c.fault_ref))].join(", ");
        throw new Error(`the probe turn ran under proxy faults (${refs}), and replay runs none`);
    }
    const SESSION_BOUND = new Set(["two_hosts_one_daemon", "store_full"]);
    const types = new Map(sourceFaults(source).map((f) => [f.id, f.type]));
    const bound = sessionFaults(source).filter((f) =>
        SESSION_BOUND.has(String(types.get(String(f.fault)))),
    );
    if (bound.length > 0) {
        const ids = bound.map((f) => String(f.fault)).join(", ");
        throw new Error(`the probe session ran under ${ids}, whose state replay does not rebuild`);
    }
    const inTurn = source.journal.filter(
        (e) =>
            e.arm === source.arm &&
            e.kind === "FaultFired" &&
            e.seq > source.begin.seq &&
            e.seq < source.end.seq,
    );
    if (inTurn.length > 0) {
        const ids = inTurn.map((e) => String(e.fault)).join(", ");
        throw new Error(`faults fired during the probe turn (${ids}), and replay runs none`);
    }
    requireCapabilities(
        source.dir,
        source.manifest as Parameters<typeof requireCapabilities>[1],
        [source.arm],
        source.journal,
    );
}

function repeatResult(
    k: number,
    variant: string,
    source: ProbeSource,
    turn: TurnResult,
    graded: { grade: GradeRecord | null; verdict: Verdict; reason: string },
    sourceFirst: ConverseBody | null,
): RepeatResult {
    const failures = [...turn.failures];
    if (NOTE_VARIANTS.has(variant) && !turn.applications.some((a) => a.changed)) {
        failures.push(`${variant} changed no agent request`);
    }
    const rates = source.manifest.price_table.rates as never;
    const cost = componentCosts(turn.records, rates);
    const own = componentCosts(
        turn.records.filter((r) => r.turn === source.event.id),
        rates,
    );
    return {
        repeat: k,
        variant,
        verdict: failures.length > 0 ? "harness-failed" : graded.verdict,
        reason: [graded.reason, ...failures].filter(Boolean).join(" | "),
        grade: graded.grade,
        cost_usd: cost.reduce((s, c) => s + c.usd, 0),
        cost_turn_usd: own.reduce((s, c) => s + c.usd, 0),
        cost,
        prompt_ms: typeof turn.outcome.prompt_ms === "number" ? turn.outcome.prompt_ms : null,
        agent_calls: turn.records.filter((r) => r.component === "agent").length,
        requests: turn.records.map((r) => ({
            seq: r.seq,
            component: r.component,
            sha256: r.request?.sha256 ?? null,
            bytes: r.request?.bytes ?? null,
        })),
        transformed: turn.applications.filter((a) => a.changed).length,
        prefix:
            sourceFirst && turn.first_request
                ? comparePrefix(sourceFirst, turn.first_request, String(source.event.text ?? ""))
                : null,
        failures,
        notes: turn.notes ?? [],
        clock_lag_ms: (() => {
            const first = turn.records.find(
                (r) => r.component === "agent" && r.turn === source.event.id,
            );
            return first ? first.scenario_ms - source.begin.scenario_ms : null;
        })(),
    };
}

function failedRepeat(
    k: number,
    variant: string,
    caught: unknown,
    source: ProbeSource,
    repeatDir: string,
): RepeatResult {
    const reason = caught instanceof Error ? caught.message : String(caught);
    const logged = join(repeatDir, "calls.jsonl");
    const records = existsSync(logged) ? readJsonl<CallRecord>(logged) : [];
    const rates = source.manifest.price_table.rates as never;
    const cost = componentCosts(records, rates);
    const own = componentCosts(
        records.filter((r) => r.turn === source.event.id),
        rates,
    );
    return {
        repeat: k,
        variant,
        verdict: "harness-failed",
        reason,
        grade: null,
        cost_usd: cost.reduce((s, c) => s + c.usd, 0),
        cost_turn_usd: own.reduce((s, c) => s + c.usd, 0),
        cost,
        prompt_ms: null,
        agent_calls: records.filter((r) => r.component === "agent").length,
        requests: records.map((r) => ({
            seq: r.seq,
            component: r.component,
            sha256: r.request?.sha256 ?? null,
            bytes: r.request?.bytes ?? null,
        })),
        transformed: null,
        prefix: null,
        failures: [reason],
        notes: [],
        clock_lag_ms: null,
    };
}

export async function replayProbe(o: ReplayOptions): Promise<RepeatResult[]> {
    if (!Number.isSafeInteger(o.repeats) || o.repeats < 1) {
        throw new Error(`--repeats must be a positive integer, not ${o.repeats}`);
    }
    const pathMode = o.pathMode ?? "source";
    const source = loadProbeSource(o.run, o.arm, o.item);
    refuseUnreplayable(source, transformFor(o.variant).id);
    const events = source.scenario.events as unknown as ScenarioEvent[];
    const probeAt = events.indexOf(source.event);
    const late = (source.probe.ground_truth?.sources ?? []).filter((id) => {
        const at = events.findIndex((e) => e.id === id);
        return at < 0 || at >= probeAt;
    });
    if (late.length > 0) {
        throw new Error(
            `probe ${source.probe.id} names sources at or after it: ${late.join(", ")}`,
        );
    }
    const out = resolve(o.out);
    requireOutside(out, [source.dir, source.recordedDir, o.config.eidnara_checkout]);
    const recorded = canonical(source.recordedDir);
    const checkout = canonical(o.config.eidnara_checkout);
    if (
        recorded === "/" ||
        contains(checkout, recorded) ||
        contains(recorded, checkout) ||
        contains(recorded, canonical(ROOT))
    ) {
        throw new Error(
            `the recorded run directory ${source.recordedDir} overlaps the Eidnara checkout or holds this checkout`,
        );
    }
    if (existsSync(out) && readdirSync(out).length > 0) {
        throw new Error(`--out ${out} is not empty`);
    }
    mkdirSync(out, { recursive: true });
    const owner = lstatSync(out);
    if (!owner.isDirectory() || owner.uid !== process.getuid?.() || (owner.mode & 0o002) !== 0) {
        throw new Error(`--out ${out} is not a directory this user owns and others cannot write`);
    }
    const claim = join(out, "replay.lock");
    writeFileSync(claim, `${process.pid}\n`, { flag: "wx" });
    try {
        return await replayInto(o, source, out, pathMode);
    } finally {
        rmSync(claim, { force: true });
    }
}

async function replayInto(
    o: ReplayOptions,
    source: ProbeSource,
    out: string,
    pathMode: PathMode,
): Promise<RepeatResult[]> {
    const transform = transformFor(o.variant);
    const inputs = transformInputs(source);
    const masked = [source.dir, source.recordedDir].filter((d) => existsSync(d));
    const checks = await (o.preflight ?? preflight)(o.config, out, masked);
    const current = (o.identity ?? ((s) => currentIdentity(o.config, s)))(source);
    const drift = identityDrift(source, current);
    const recordedPreflight = source.manifest.preflight as Preflight;
    drift.push(...preflightDrift(recordedPreflight, checks).map((d) => `preflight.${d}`));
    const allowed = new Set(o.allowIdentity ?? []);
    const refused = drift.filter(
        (d) => !allowed.has(d) && !allowed.has(d.split(/[.:]/)[0] as string),
    );
    const sessions = new Map(source.scenario.sessions.map((s) => [s.id, s.project]));
    const projectOf = (e: ScenarioEvent) =>
        typeof e.project === "string" ? e.project : sessions.get(e.session);
    const turnDiff = source.snapshot.artefacts.find(
        (a) => a.class === "diff" && a.role === "turn",
    ) as { patch?: string } | undefined;
    const probeGit = join(out, "probe-tree.git");
    copyTree(join(source.dir, source.arm, "snapshot.git"), probeGit);
    requireRealDir(probeGit, out);
    trustSnapshotGit(probeGit);
    const found = probeTree({
        gitDir: probeGit,
        journal: source.journal.filter((e) => e.arm === source.arm),
        events: source.scenario.events as unknown as ScenarioEvent[],
        projectOf,
        project: source.project,
        cutoffWall: source.firstCallWall,
        patch: turnDiff?.patch ?? "",
        scratch: join(out, "probe-tree.index"),
    });
    rmSync(probeGit, { recursive: true, force: true });
    const hostRow = checks.hosts.find((h) => h.host === "pi");
    if (!hostRow) throw new Error("preflight reports no Pi host");
    const model = modelIndex(source);
    const sim = simIdentity();
    const manifest = {
        schema: REPLAY_SCHEMA,
        kind: "probe-replay",
        created_wall_ms: Date.now(),
        source: {
            dir: source.dir,
            recorded_dir: source.recordedDir,
            manifest_sha256: sha256(readFileSync(join(source.dir, "manifest.json"))),
            scenario_hash: source.manifest.scenario_hash,
            tier: source.manifest.tier,
            seed: source.manifest.seed,
            host: source.manifest.host,
            sim_commit: source.manifest.sim_commit,
            sim_worktree: source.manifest.sim_worktree,
            eidnara_commit: source.manifest.eidnara_commit,
            grade: source.grade
                ? {
                      verdict: source.grade.verdict,
                      version: source.grade.version,
                      grader: source.grade.grader ?? null,
                  }
                : null,
            grade_error: source.gradeError,
        },
        arm: source.arm,
        item: source.probe.id,
        probe_type: source.probe.type,
        event: source.event.id,
        session: source.event.session,
        project: source.project,
        variant: {
            id: transform.id,
            alias: transform.alias,
            summary: transform.summary,
            digest: transformDigest(transform, inputs),
        },
        transform_inputs: inputs,
        repeats: o.repeats,
        path_mode: pathMode,
        sim_commit: sim.sim_commit,
        sim_worktree: sim.sim_worktree,
        eidnara_commit: current.eidnara_commit,
        eidnara_worktree: current.eidnara_worktree,
        grader: graderDigest(),
        identity: { drift, allowed: [...allowed], refused },
        workspace_tree: found,
        model_index: model,
        session_faults: sessionFaults(source),
        clock: {
            base_wall_ms: source.manifest.base_wall_ms,
            begin_scenario_ms: source.begin.scenario_ms,
            daemon_cutoff_ms: daemonCutoffMs(source),
        },
        preflight: checks,
    };
    writeFileSync(join(out, REPLAY_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    if (refused.length > 0) {
        throw new Error(
            `the source run's identities differ from this environment: ${refused.join(", ")} (--allow-identity overrides)`,
        );
    }
    const sourceFirst = sourceFirstRequest(source);
    const prereg = loadPrereg(source.manifest.tier as never);
    const results: RepeatResult[] = [];
    for (let k = 1; k <= o.repeats; k++) {
        const repeatDir = join(out, `r${k}`);
        const armDir = join(repeatDir, source.arm);
        const visibleArmDir = pathMode === "source" ? join(source.recordedDir, source.arm) : armDir;
        let result: RepeatResult;
        try {
            const fidelity = prepareRepeat({
                source,
                armDir,
                visibleArmDir,
                pathMode,
                tree: { id: found.tree, fidelity: found.fidelity },
                model,
                gitTimeoutMs: prereg.liveness_bounds.turn_deadline_ms,
            });
            const record = `${JSON.stringify(fidelity, null, 2)}\n`;
            writeFileSync(join(repeatDir, "fidelity.json"), record);
            const spec: TurnSpec = {
                config: o.config,
                out: repeatDir,
                armDir: visibleArmDir,
                arm: source.arm,
                host: "pi",
                launcher: checks.launcher,
                hostVersion: hostRow.version,
                transcriptPaths: hostRow.transcript_paths,
                baseMs: source.manifest.base_wall_ms,
                models: source.manifest.models,
                contextLimit: source.manifest.context_limit,
                sideModel: source.manifest.side_model,
                turnDeadlineMs: prereg.liveness_bounds.turn_deadline_ms,
                project: source.project,
                corpus: join(ROOT, "corpus", "repos", source.project),
                sessionStart: source.sessionStart,
                probe: { ...source.event, text: deliveredText(source) },
                beginMs: source.begin.scenario_ms,
                priorCalls: priorCalls(source),
                variant: transform.id,
                inputs,
                settleQuietMs: o.settleQuietMs ?? 5_000,
                settleMaxMs: o.settleMaxMs ?? 30_000,
            };
            const specPath = join(repeatDir, "turn-spec.json");
            writeFileSync(specPath, `${JSON.stringify(spec)}\n`);
            const claim = pathMode === "source" ? claimMountPoint(visibleArmDir) : null;
            let turn: TurnResult;
            try {
                const mount = claim ? { from: realpathSync(armDir), to: visibleArmDir } : null;
                turn = await (o.turn ?? spawnTurn)(spec, specPath, mount);
            } finally {
                claim?.release();
            }
            const graded = gradeRepeat(source, armDir);
            result = repeatResult(k, transform.id, source, turn, graded, sourceFirst);
        } catch (caught) {
            result = failedRepeat(k, transform.id, caught, source, repeatDir);
            if (caught instanceof ReplayInterrupted) {
                appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(result)}\n`);
                if (!o.keep) clearRepeat(armDir);
                throw caught;
            }
        }
        appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(result)}\n`);
        results.push(result);
        if (!o.keep) clearRepeat(armDir);
    }
    return results;
}

function clearRepeat(armDir: string): void {
    for (const heavy of ["r", "s", "snapshot.git", "runtime"]) {
        rmSync(join(armDir, heavy), { recursive: true, force: true });
    }
}
