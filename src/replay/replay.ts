import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { SimConfig } from "../config/config";
import type { Artefact, CallView, Command, Snapshot } from "../grade/artefacts";
import { assertArtefactsOnly, GradeRefused } from "../grade/artefacts";
import { type GradeRecord, gradeItem, graderDigest } from "../grade/probes";
import { readToolLedger, sourceEvents, withSourceCommands } from "../grade/source-commands";
import { armProfile, deliveryOf } from "../hosts/profiles";
import { SnapshotRecorder } from "../hosts/snapshot";
import type { ConverseBody } from "../proxy/classify";
import { RequestPartLog, rebuildRequest } from "../proxy/requests";
import { componentCosts } from "../report/cost";
import { type Entry, readJsonl } from "../run/journal";
import { oracleBackground } from "../run/oracle-note";
import { type Preflight, preflight, preflightDrift } from "../run/preflight";
import { armConfigs, MEASUREMENT_PATHS, runIdentity, simIdentity } from "../run/run";
import type { ScenarioEvent } from "../run/scheduler";
import { loadPrereg } from "../scenario/inputs";
import { daemonCutoffMs, loadProbeSource, type ProbeSource } from "./source";
import {
    checkoutTree,
    copyTree,
    type Fidelity,
    probeTree,
    rewindHead,
    rollbackStore,
    truncateSession,
} from "./state";
import { evidenceNote, type TransformInputs, transformDigest, transformFor } from "./transforms";
import type { TurnResult, TurnSpec } from "./turn";

export const REPLAY_SCHEMA = "sim-replay-manifest/v1";
export const REPLAY_MANIFEST = "replay-manifest.json";
const ROOT = resolve(import.meta.dir, "../..");

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
    preflight?: (config: SimConfig, root: string) => Promise<Preflight>;
    identity?: (source: ProbeSource) => Record<string, unknown>;
    turn?: (spec: TurnSpec, specPath: string, mount: Mount | null) => Promise<TurnResult>;
    settleQuietMs?: number;
    settleMaxMs?: number;
}

export interface PrefixComparison {
    identical: boolean;
    source_sha256: string;
    replay_sha256: string;
    fields: Record<string, boolean>;
    messages: { source: number; replay: number };
    differences: string[];
}

export interface RepeatResult {
    repeat: number;
    variant: string;
    verdict: string;
    reason: string;
    grade: GradeRecord | null;
    cost_usd: number;
    cost: ReturnType<typeof componentCosts>;
    prompt_ms: number | null;
    agent_calls: number;
    requests: { seq: number; component: string; sha256: string | null; bytes: number | null }[];
    transformed: number;
    prefix: PrefixComparison | null;
    failures: string[];
    notes: string[];
    clock_lag_ms: number;
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

export function requestPrefix(body: ConverseBody, probeText: string): ConverseBody {
    const messages = body.messages ?? [];
    const holdsProbe = (m: (typeof messages)[number] | undefined) =>
        m?.role === "user" &&
        (m.content ?? []).some(
            (b) => typeof b.text === "string" && (b.text as string).includes(probeText),
        );
    let at = messages.length - 1;
    while (at >= 0 && !holdsProbe(messages[at])) at--;
    return { ...body, messages: messages.slice(0, at + 1) };
}

export function comparePrefix(
    source: ConverseBody,
    replay: ConverseBody,
    probeText: string,
): PrefixComparison {
    const a = requestPrefix(source, probeText);
    const b = requestPrefix(replay, probeText);
    const fields: Record<string, boolean> = {};
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        fields[k] = JSON.stringify(a[k]) === JSON.stringify(b[k]);
    }
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    return {
        identical: sa === sb,
        source_sha256: sha256(sa),
        replay_sha256: sha256(sb),
        fields,
        messages: { source: a.messages?.length ?? 0, replay: b.messages?.length ?? 0 },
        differences: jsonDiff(a, b, "", []),
    };
}

export function currentIdentity(config: SimConfig, source: ProbeSource): Record<string, unknown> {
    const prereg = loadPrereg(source.manifest.tier as never);
    const sideModel = source.manifest.side_model ?? config.agent_model;
    return {
        ...runIdentity(config, prereg, [source.project]),
        arms: armConfigs([source.arm], sideModel),
        agent_model: config.agent_model,
    };
}

function simPathsChanged(from: string, root: string): string[] | null {
    const ancestor = spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", from, "HEAD"]);
    if (ancestor.status !== 0) return null;
    const r = spawnSync("git", ["-C", root, "diff", "--name-only", from, "--", ...REPLAY_PATHS], {
        encoding: "utf8",
    });
    return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : null;
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
    };
}

function deliveredText(source: ProbeSource): string {
    const text = String(source.event.text ?? "");
    if (deliveryOf(armProfile(source.arm)) !== "oracle-context") return text;
    return `${oracleBackground(source.scenario, source.probe.id) ?? ""}${text}`;
}

const corpusCommit = (source: ProbeSource): string =>
    String(
        (source.manifest.corpus as Record<string, { commit?: string }> | undefined)?.[
            source.project
        ]?.commit ?? "",
    );

function modelIndex(source: ProbeSource, journal: Entry[]): number {
    const types = new Map(source.scenario.faults.map((f) => [f.id, f.type]));
    const fired = journal.filter(
        (e) => e.arm === source.arm && e.kind === "FaultFired" && e.seq < source.begin.seq,
    );
    if (fired.some((e) => types.get(String(e.fault)) === "host_upgrade")) {
        throw new Error(`a host_upgrade fired on ${source.arm} before the probe`);
    }
    return fired.filter((e) => types.get(String(e.fault)) === "model_switch").length;
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

function prepareRepeat(o: {
    source: ProbeSource;
    journal: Entry[];
    armDir: string;
    visibleArmDir: string;
    pathMode: PathMode;
    tree: { id: string; fidelity: Fidelity };
}): Record<string, Fidelity> {
    const { source } = o;
    const from = join(source.dir, source.arm);
    mkdirSync(join(o.armDir, "runtime"), { recursive: true });
    mkdirSync(join(o.armDir, "clock"), { recursive: true });
    copyTree(join(from, "snapshot.git"), join(o.armDir, "snapshot.git"));
    for (const f of readdirSync(from).filter((f) => f.endsWith(".gitconfig"))) {
        copyFileSync(join(from, f), join(o.armDir, f));
    }
    const state = json<Record<string, unknown>>(join(from, "snapshot-state.json"));
    const open = { session: source.event.session, ended: null, last: {}, lastGap: {} };
    writeFileSync(join(o.armDir, "snapshot-state.json"), JSON.stringify({ ...state, ...open }));
    const commands = priorCommands(source).map((c) => `${JSON.stringify(c)}\n`);
    writeFileSync(join(o.armDir, "commands.jsonl"), commands.join(""));
    const workspace = join(o.armDir, "r", "workspaces", source.project);
    copyTree(join(from, "r", "workspaces", source.project), workspace);
    const recorder = new SnapshotRecorder(o.armDir, source.arm, () => []);
    const copied = recorder.tree(workspace);
    checkoutTree({
        gitDir: join(o.armDir, "snapshot.git"),
        workspace,
        from: copied,
        to: o.tree.id,
        scratch: join(o.armDir, "replay-restore.index"),
    });
    const restored = recorder.tree(workspace);
    const cutoffS = Math.floor((source.manifest.base_wall_ms + source.begin.scenario_ms) / 1000);
    const home = join(o.armDir, "r", "home");
    copyTree(join(from, "r", "home"), home);
    rmSync(join(home, ".pi", "agent", "sessions"), { recursive: true, force: true });
    const visibleWorkspace = join(o.visibleArmDir, "r", "workspaces", source.project);
    const fidelity: Record<string, Fidelity> = {
        workspace_tree: o.tree.fidelity,
        workspace_files: {
            method: "two-tree-checkout",
            exact: restored === o.tree.id,
            detail: { copied, restored, target: o.tree.id },
        },
        workspace_git: rewindHead(workspace, cutoffS, corpusCommit(source)),
        transcript: truncateSession({
            fromAgentDir: join(from, "r", "home", ".pi", "agent"),
            toAgentDir: join(home, ".pi", "agent"),
            sessionId: `sim-${source.event.session}`,
            probeText: deliveredText(source),
            ...(o.pathMode === "replay" ? { cwd: visibleWorkspace } : {}),
        }).fidelity,
    };
    if (armProfile(source.arm).daemon !== null) {
        copyTree(join(from, "s"), join(o.armDir, "s"));
        const store = rollbackStore({
            dataDir: join(o.armDir, "s", "d"),
            cutoffMs: daemonCutoffMs(source),
            sessions: [source.event.session, ...source.laterSessions].map((s) => `sim-${s}`),
        });
        if (o.pathMode === "replay") store.detail.project_keys = "keyed by the source path";
        fidelity.store = store;
    }
    const armState = {
        model: modelIndex(source, o.journal),
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
): { grade: GradeRecord | null; verdict: string; reason: string } {
    const path = join(armDir, "snapshots.jsonl");
    if (!existsSync(path)) {
        return { grade: null, verdict: "no-snapshot", reason: "the turn left no snapshot" };
    }
    const row = readJsonl<Snapshot>(path).at(-1) as Snapshot;
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
        return { grade, verdict: grade.verdict, reason: failing.join(", ") };
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
    'mount --bind "$1" "$2"',
    "uid=$3; gid=$4; path=$5; user=$6",
    "shift 6",
    'exec /usr/bin/setpriv --reuid "$uid" --regid "$gid" --init-groups -- /usr/bin/env PATH="$path" USER="$user" LOGNAME="$user" "$@"',
].join("\n");

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
    const code = await child.exited;
    const result = join(spec.out, "turn.json");
    if (!existsSync(result)) throw new Error(`the turn process exited ${code} without ${result}`);
    return json<TurnResult>(result);
}

function removeCreated(dir: string, stop: string): void {
    let at = dir;
    while (at !== stop && at.startsWith(`${stop}/`)) {
        try {
            rmdirSync(at);
        } catch {
            return;
        }
        at = dirname(at);
    }
}

function requireOutside(out: string, dirs: string[]): void {
    for (const inside of dirs) {
        const rel = relative(inside, out);
        if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) {
            throw new Error(`--out ${out} lies inside ${inside}`);
        }
    }
}

export async function replayProbe(o: ReplayOptions): Promise<RepeatResult[]> {
    if (!Number.isSafeInteger(o.repeats) || o.repeats < 1) {
        throw new Error(`--repeats must be a positive integer, not ${o.repeats}`);
    }
    const pathMode = o.pathMode ?? "source";
    const source = loadProbeSource(o.run, o.arm, o.item);
    if (source.manifest.host !== "pi") throw new Error("replay runs Pi arms only");
    const out = resolve(o.out);
    requireOutside(out, [source.dir, source.recordedDir, o.config.eidnara_checkout]);
    if (existsSync(out) && readdirSync(out).length > 0) {
        throw new Error(`--out ${out} is not empty`);
    }
    mkdirSync(out, { recursive: true });
    const transform = transformFor(o.variant);
    const inputs = transformInputs(source);
    const current = (o.identity ?? ((s) => currentIdentity(o.config, s)))(source);
    const checks = await (o.preflight ?? preflight)(o.config, out);
    const drift = identityDrift(source, current);
    const recordedPreflight = source.manifest.preflight as Preflight;
    drift.push(...preflightDrift(recordedPreflight, checks).map((d) => `preflight.${d}`));
    const allowed = new Set(o.allowIdentity ?? []);
    const refused = drift.filter(
        (d) => !allowed.has(d) && !allowed.has(d.split(/[.:]/)[0] as string),
    );
    const journal = readJsonl<Entry>(join(source.dir, "journal.jsonl"));
    const sessions = new Map(source.scenario.sessions.map((s) => [s.id, s.project]));
    const projectOf = (e: ScenarioEvent) =>
        typeof e.project === "string" ? e.project : sessions.get(e.session);
    const turnDiff = source.snapshot.artefacts.find(
        (a) => a.class === "diff" && a.role === "turn",
    ) as { patch?: string } | undefined;
    const probeGit = join(out, "probe-tree.git");
    copyTree(join(source.dir, source.arm, "snapshot.git"), probeGit);
    const found = probeTree({
        gitDir: probeGit,
        journal: journal.filter((e) => e.arm === source.arm),
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
    const sim = simIdentity();
    const manifest = {
        schema: REPLAY_SCHEMA,
        kind: "probe-replay",
        created_wall_ms: Date.now(),
        source: {
            dir: source.dir,
            recorded_dir: source.recordedDir,
            manifest_sha256: sha256(readFileSync(join(source.dir, "manifest.json"))),
            tier: source.manifest.tier,
            seed: source.manifest.seed,
            host: source.manifest.host,
            sim_commit: source.manifest.sim_commit,
            eidnara_commit: source.manifest.eidnara_commit,
            grade: source.grade
                ? { verdict: source.grade.verdict, version: source.grade.version }
                : null,
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
    const probeText = String(source.event.text ?? "");
    const results: RepeatResult[] = [];
    for (let k = 1; k <= o.repeats; k++) {
        const repeatDir = join(out, `r${k}`);
        const armDir = join(repeatDir, source.arm);
        const visibleArmDir = pathMode === "source" ? join(source.recordedDir, source.arm) : armDir;
        const fidelity = prepareRepeat({
            source,
            journal,
            armDir,
            visibleArmDir,
            pathMode,
            tree: { id: found.tree, fidelity: found.fidelity },
        });
        writeFileSync(join(repeatDir, "fidelity.json"), `${JSON.stringify(fidelity, null, 2)}\n`);
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
        let created: string | null = null;
        let mount: Mount | null = null;
        if (pathMode === "source") {
            if (!existsSync(visibleArmDir)) {
                mkdirSync(visibleArmDir, { recursive: true });
                created = visibleArmDir;
            }
            mount = { from: realpathSync(armDir), to: visibleArmDir };
        }
        let turn: TurnResult;
        try {
            turn = await (o.turn ?? spawnTurn)(spec, specPath, mount);
        } finally {
            if (created) removeCreated(created, dirname(source.recordedDir));
        }
        const graded = gradeRepeat(source, armDir);
        const cost = componentCosts(turn.records, source.manifest.price_table.rates as never);
        const decided = graded.verdict === "pass" || graded.verdict === "fail";
        const result: RepeatResult = {
            repeat: k,
            variant: transform.id,
            verdict: turn.failures.length > 0 && !decided ? "harness-failed" : graded.verdict,
            reason: [graded.reason, ...turn.failures].filter(Boolean).join(" | "),
            grade: graded.grade,
            cost_usd: cost.reduce((s, c) => s + c.usd, 0),
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
                    ? comparePrefix(sourceFirst, turn.first_request, probeText)
                    : null,
            failures: turn.failures,
            notes: turn.notes ?? [],
            clock_lag_ms: turn.prompt_scenario_ms - source.begin.scenario_ms,
        };
        appendFileSync(join(out, "results.jsonl"), `${JSON.stringify(result)}\n`);
        results.push(result);
        if (!o.keep) {
            for (const heavy of ["r", "s", "snapshot.git", "runtime"]) {
                rmSync(join(armDir, heavy), { recursive: true, force: true });
            }
        }
    }
    return results;
}
