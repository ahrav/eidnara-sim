import { createHash } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    rmSync,
    statSync,
    truncateSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SimConfig } from "../config/config";
import type { ArmName } from "../hosts/arms";
import { HostDriver } from "../hosts/driver";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import type { Tier } from "../prereg/schema";
import { preregistrationHash } from "../prereg/validate";
import { bedrockUpstream, Gateway } from "../proxy/gateway";
import { FaultInjector } from "../proxy/inject";
import { RecordWriter, readRecords } from "../proxy/records";
import { Rng } from "../rng";
import { compileScenario, type Scenario } from "../scenario/compile";
import { type FaultEpisode, type FaultType, SEAMS, validateFault } from "../scenario/faults";
import { loadCompileInput, loadPrereg } from "../scenario/inputs";
import { bedrockEmbedder } from "../scenario/similarity";
import { writeAtomic } from "./atomic";
import { type Entry, Journal, releaseLease, takeLease } from "./journal";
import { plainPath } from "./launcher";
import { type Preflight, piCli, preflight } from "./preflight";
import { running } from "./procs";
import { ResourceSampler } from "./sampler";
import { type ArmDriver, HarnessFailure, type ScenarioEvent, Scheduler } from "./scheduler";
import { FAKETIME_LIB, writeOffset } from "./timeinject";
import { SYSTEM_PATH, TOOLCHAIN_PROBES } from "./toolchain";

export interface RunOptions {
    config: SimConfig;
    tier: Tier;
    seed: number;
    host: "pi" | "opencode";
    out: string;
    arms?: string[];
    events?: number;
    /** Parsed `--faults` JSON, validated against the compiled scenario by `faultOverride`. */
    faults?: unknown;
    contextLimit?: number;
    models?: string[];
}

export interface Manifest {
    schema: "sim-run-manifest/v1";
    tier: Tier;
    seed: number;
    host: "pi" | "opencode";
    order: ArmName[];
    events: number;
    context_limit: number;
    models: string[];
    scenario_hash: string;
    eidnara_commit: string;
    /** Digest of the Eidnara checkout's uncommitted content at the start (`treeIdentity`). */
    eidnara_worktree: string;
    /** Commit and uncommitted-content digest of each corpus checkout the scenario's projects use. */
    corpus: Record<string, { commit: string; worktree: string }>;
    /** The Bedrock region and profile name the proxy forwards to; a resume must present the same. */
    bedrock: { region: string; aws_profile: string };
    /** The configured toolchain and each named tool's content digest. */
    toolchain: { config: SimConfig["toolchain"]; tools: Record<string, string> };
    /** The eidnara-sim revision that started the run; a resume must run the same one. */
    sim_commit: string;
    /** Digest of the eidnara-sim working tree's uncommitted content at the start (`treeIdentity`). */
    sim_worktree: string;
    /** SHA-256 of the daemon, OpenCode, and Pi executables; a resume must present the same. */
    binaries: Record<string, string>;
    fault_override: FaultEpisode[] | null;
    prereg_sha256: string;
    base_wall_ms: number;
    preflight: Preflight;
}

const ROOT = resolve(import.meta.dir, "../..");

export function pinnedBin(config: SimConfig): string {
    return resolve(dirname(config.opencode_binary), "../../.bin");
}

/** The pinned release's `.bin` is the first PATH entry that resolves `opencode`, so a shell lookup picks it. */
export function requirePinnedPath(config: SimConfig): void {
    const bin = pinnedBin(config);
    const entries = (process.env.PATH ?? "").split(":").filter((d) => d !== "");
    if (!entries.includes(bin)) {
        throw new HarnessFailure(
            `PATH lacks the pinned OpenCode release; run with PATH=${bin}:$PATH`,
        );
    }
    const first = entries.find((dir) => existsSync(join(dir, "opencode")));
    if (first !== undefined && first !== bin) {
        throw new HarnessFailure(
            `PATH resolves opencode from ${first} before the pinned release ${bin}`,
        );
    }
}

const realExisting = (path: string): string => {
    let probe = path;
    while (!existsSync(probe)) probe = dirname(probe);
    return join(realpathSync(probe), path.slice(probe.length));
};

const within = (path: string, dir: string) =>
    dir === "/" || path === dir || path.startsWith(`${dir}/`);

const ARTIFACTS = [
    `lease.${process.pid}.tmp`,
    "journal.jsonl",
    "scenario.json",
    `scenario.json.${process.pid}`,
    "manifest.json",
    `manifest.json.${process.pid}`,
    "preflight.jsonl",
    "calls.jsonl",
    "faults.jsonl",
];

/**
 * Every run artifact the harness appends to or replaces is a regular file or absent, so a
 * symlink planted in an accepted output directory cannot redirect a write elsewhere.
 */
export function requirePlainArtifacts(out: string, arms: readonly string[]): void {
    const dirs = [
        "interception",
        "toolbin",
        "hostbin",
        ...arms.flatMap((arm) => [
            arm,
            join(arm, "clock"),
            join(arm, "r"),
            join(arm, "s"),
            join("hostbin", arm),
        ]),
    ];
    const files = arms.flatMap((arm) => [
        join("hostbin", arm, "opencode"),
        join("hostbin", arm, `opencode.${process.pid}`),
        join(arm, "resources.jsonl"),
        join(arm, "daemon.log"),
        join(arm, "store.img"),
        join(arm, "transcripts.json"),
        join(arm, "clock", "offset"),
        join(arm, "clock", `offset.${process.pid}`),
        join(arm, "state.json"),
        join(arm, `state.json.${process.pid}`),
        join(arm, "opencode.launch"),
    ]);
    const entries = existsSync(out) ? readdirSync(out) : [];
    for (const name of entries) {
        const m = /^lease\.(\d+)\.tmp$/.exec(name);
        if (m && Number(m[1]) !== process.pid && !running(Number(m[1]))) {
            rmSync(join(out, name), { force: true });
        }
    }
    const leases = entries.filter((name) => /^lease\.\d+\.json$/.test(name));
    for (const rel of [...dirs, ...ARTIFACTS, ...leases, ...files]) {
        const path = join(out, rel);
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (!stat) continue;
        const refuse = (why: string) => {
            throw new HarnessFailure(`${path} ${why}; run artifacts must be plain files`);
        };
        if (stat.isSymbolicLink()) refuse("is a symlink");
        if (dirs.includes(rel)) {
            if (!stat.isDirectory()) refuse("is not a directory");
            continue;
        }
        if (!stat.isFile()) refuse("is not a regular file");
        if (stat.nlink > 1) refuse(`has ${stat.nlink} links`);
    }
}

/**
 * Run outputs and the Eidnara checkout stay disjoint, by resolved path: arm resets delete output
 * subtrees, and an output directory above the checkout would derive an arm root inside it.
 */
export function requireOutsideCheckout(
    out: string,
    checkout: string,
    what = "the Eidnara checkout",
): void {
    const dir = realExisting(resolve(checkout));
    const target = realExisting(resolve(out));
    if (within(target, dir) || within(dir, target)) {
        throw new HarnessFailure(`--out ${out} overlaps ${what} ${checkout}`);
    }
}

/**
 * Output inside this checkout must be ignored by git, and output may not touch a corpus
 * checkout, since both trees are part of the run identity.
 */
export function requireOutsideIdentity(out: string, root = ROOT): void {
    const target = realExisting(resolve(out));
    const real = realExisting(root);
    const repos = join(real, "corpus/repos");
    if (within(target, repos) || within(repos, target)) {
        throw new HarnessFailure(`--out ${out} overlaps the corpus checkouts under ${repos}`);
    }
    if (within(target, real)) {
        const r = Bun.spawnSync(["git", "-C", real, "check-ignore", "-q", target]);
        if (r.exitCode !== 0) {
            throw new HarnessFailure(`--out ${out} is inside this checkout and not ignored by git`);
        }
    }
}

/**
 * A resumed journal's entries follow the run's state machine: `StartRun` precedes every arm
 * entry, each arm's entries sit between its `StartArm` and at most one `EndArm`, and an `EndTurn`
 * or `EndJob` closes an item that is open. A planted or reordered entry refuses the resume before
 * it drives recovery.
 */
export function requireJournalShape(
    entries: readonly Entry[],
    scheduled?: readonly { id: string; kind: string; scenario_ms?: number }[],
    order?: readonly string[],
): void {
    const scheduledMs = new Map((scheduled ?? []).map((e) => [e.id, e.scenario_ms]));
    let nextArm = 0;
    let ended = false;
    const turns = new Set((scheduled ?? []).filter((e) => e.kind === "user_turn").map((e) => e.id));
    const closedTurns = new Set<string>();
    const position = new Map((scheduled ?? []).map((e, i) => [e.id, i]));
    const cursor = new Map<string, number>();
    const bad = (e: Entry, why: string) =>
        new HarnessFailure(`journal entry ${e.seq} (${e.kind}) ${why}`);
    let started = false;
    const arms = new Map<string, "open" | "ended">();
    const open = new Set<string>();
    for (const e of entries) {
        if (!Number.isFinite(e.scenario_ms))
            throw bad(e, `has scenario_ms ${JSON.stringify(e.scenario_ms)}`);
        if (!Number.isInteger(e.seq)) throw bad(e, `has seq ${JSON.stringify(e.seq)}`);
        if (ended) throw bad(e, "follows EndRun");
        if (e.kind === "Preflight") continue;
        if (e.kind === "StartRun") {
            if (started) throw bad(e, "repeats StartRun");
            started = true;
            continue;
        }
        if (e.kind === "ResumeRun") {
            if (!started) throw bad(e, "precedes StartRun");
            continue;
        }
        if (!started) throw bad(e, "precedes StartRun");
        if (e.kind === "EndRun") {
            const unfinished = [...arms].find(([, st]) => st !== "ended");
            if (unfinished) throw bad(e, `is an EndRun with arm ${unfinished[0]} unfinished`);
            ended = true;
            continue;
        }
        if (e.arm === null) throw bad(e, "names no arm");
        const state = arms.get(e.arm);
        if (e.kind === "StartArm") {
            if (state) throw bad(e, "repeats StartArm");
            const stillOpen = [...arms].find(([, st]) => st === "open");
            if (stillOpen) throw bad(e, `starts arm ${e.arm} while arm ${stillOpen[0]} is open`);
            if (order && order[nextArm] !== e.arm) {
                throw bad(
                    e,
                    `starts arm ${e.arm}; the order expects ${order[nextArm] ?? "no arm"}`,
                );
            }
            nextArm++;
            arms.set(e.arm, "open");
            continue;
        }
        if (state !== "open") throw bad(e, state ? "follows EndArm" : "precedes StartArm");
        if (e.kind === "EndArm") {
            const openHere = [...open].filter((k) => k.startsWith(`${e.arm}/`));
            if (openHere.length > 0) throw bad(e, `ends the arm with ${openHere[0]} open`);
            if (scheduled && (cursor.get(e.arm) ?? 0) !== scheduled.length) {
                throw bad(
                    e,
                    `ends the arm after ${cursor.get(e.arm) ?? 0} of ${scheduled.length} events`,
                );
            }
            arms.set(e.arm, "ended");
        }
        if (e.kind === "BeginTurn" || e.kind === "RegisterJob") {
            const item =
                e.kind === "BeginTurn" ? `turn/${String(e.event)}` : `job/${String(e.job)}`;
            if (open.has(`${e.arm}/${item}`)) throw bad(e, `opens ${item}, which is already open`);
            if (e.kind === "BeginTurn" && closedTurns.has(`${e.arm}/${String(e.event)}`)) {
                throw bad(e, `reopens turn ${String(e.event)}`);
            }
            open.add(`${e.arm}/${item}`);
        }
        if (e.kind === "EndTurn" || e.kind === "EndJob") {
            const item = e.kind === "EndTurn" ? `turn/${String(e.event)}` : `job/${String(e.job)}`;
            if (!open.delete(`${e.arm}/${item}`)) throw bad(e, `closes ${item}, which is not open`);
        }
        if (e.kind === "EndTurn") closedTurns.add(`${e.arm}/${String(e.event)}`);
        if (e.kind === "ItemState" && e.state === "failed(interrupted)" && e.event !== undefined) {
            const turn = `${e.arm}/turn/${String(e.event)}`;
            if (!open.delete(turn))
                throw bad(e, `interrupts turn ${String(e.event)}, which is not open`);
            closedTurns.add(`${e.arm}/${String(e.event)}`);
        }
        if (e.kind === "Event" && scheduled) {
            const id = String(e.event);
            const at = position.get(id);
            const next = cursor.get(e.arm) ?? 0;
            if (at === undefined) throw bad(e, `names unscheduled event ${id}`);
            if (at !== next) throw bad(e, `is not the next scheduled event (${id})`);
            if (turns.has(id) && !closedTurns.has(`${e.arm}/${id}`)) {
                throw bad(e, `completes turn ${id} without an EndTurn or interruption`);
            }
            const due = scheduledMs.get(id);
            if (due !== undefined && (e.scenario_ms as number) < due) {
                throw bad(e, `records ${id} at ${e.scenario_ms}, before its scheduled ${due}`);
            }
            cursor.set(e.arm, at + 1);
        }
    }
}

/** Range and type problems of a persisted manifest's execution fields, before any is inherited. */
function manifestProblems(m: Manifest, compiledEvents: number): string[] {
    const problems: string[] = [];
    if (!Number.isInteger(m.events) || m.events < 1 || m.events > compiledEvents) {
        problems.push(`events ${m.events} outside 1..${compiledEvents}`);
    }
    if (!Number.isInteger(m.context_limit) || m.context_limit < 1) {
        problems.push(`context_limit ${m.context_limit} is not a positive integer`);
    }
    if (!Array.isArray(m.models) || m.models.some((x) => typeof x !== "string" || x === "")) {
        problems.push("models is not a list of names");
    }
    if (!Number.isInteger(m.seed)) problems.push(`seed ${m.seed} is not an integer`);
    if (m.host !== "pi" && m.host !== "opencode") problems.push(`host ${m.host} unknown`);
    if (!Number.isFinite(m.base_wall_ms)) problems.push("base_wall_ms is not a number");
    return problems;
}

/** The manifest's execution fields (everything but the per-invocation preflight), as one digest. */
export function manifestIdentity(manifest: Manifest): string {
    const { preflight: _preflight, ...fields } = manifest;
    return sha256Hex(canonicalJson(fields));
}

/** A run with no journal yet owns no evidence or arm payload; any such existing file is refused. */
export function requireFreshArmRoots(out: string, arms: readonly string[]): void {
    const evidence = [
        "calls.jsonl",
        "faults.jsonl",
        "preflight.jsonl",
        "toolbin",
        "interception",
        "hostbin",
    ];
    const perArm = [
        "r",
        "s",
        "store.img",
        "daemon.log",
        "transcripts.json",
        "resources.jsonl",
        "state.json",
        "opencode.launch",
    ];
    const present = [
        ...evidence.map((f) => join(out, f)),
        ...arms.flatMap((arm) => perArm.map((f) => join(out, arm, f))),
    ].filter((path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined);
    if (present.length > 0) {
        throw new HarnessFailure(
            `${present[0]} exists but ${out} has no journal; a fresh run would delete or extend it`,
        );
    }
}

/** A JSONL artifact's unterminated final line is a cut write; it is removed before appending. */
export function dropCutTail(path: string): void {
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    const complete = text.lastIndexOf("\n") + 1;
    if (complete < text.length) truncateSync(path, Buffer.byteLength(text.slice(0, complete)));
}

/** A run artifact that fails to parse names itself in the failure. */
function readJsonFile<T>(path: string): T {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch (caught) {
        throw new HarnessFailure(`${path} is not valid JSON: ${(caught as Error).message}`);
    }
}

/** The Git executable, resolved once from PATH and bound into the manifest's `binaries`. */
const GIT = realpathSync(Bun.which("git") ?? "git");

function git(dir: string, args: string[]): string {
    const r = Bun.spawnSync([GIT, "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${dir} failed`);
    return r.stdout.toString();
}

function gitHead(dir: string): string {
    return git(dir, ["rev-parse", "HEAD"]).trim();
}

/**
 * The commit a working tree is at plus a digest of its uncommitted content: tracked changes as
 * `git diff HEAD --binary`, and each untracked, unignored file's path and content.
 */
export function treeIdentity(dir: string): { commit: string; worktree: string } {
    const hash = createHash("sha256").update(git(dir, ["diff", "HEAD", "--binary"]));
    const untracked = git(dir, ["ls-files", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter((f) => f !== "")
        .sort();
    for (const file of untracked) {
        const stat = lstatSync(join(dir, file), { throwIfNoEntry: false });
        const content = stat?.isFile()
            ? readFileSync(join(dir, file))
            : stat?.isSymbolicLink()
              ? Buffer.from(`->${readlinkSync(join(dir, file))}`)
              : Buffer.from(stat ? `?${stat.mode}` : "");
        const name = Buffer.from(file);
        hash.update(`${name.length}:`).update(name).update(`${content.length}:`).update(content);
    }
    return { commit: gitHead(dir), worktree: hash.digest("hex") };
}

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Project ids are plain path segments; events have unique string ids, a known kind, finite
 * non-decreasing `scenario_ms`, a session, an index when they are turns, and declared projects.
 */
export function requireDeclaredProjects(scenario: Scenario): void {
    const ids = new Set<string>();
    for (const p of scenario.projects as { id?: unknown }[]) {
        if (typeof p?.id !== "string" || !PROJECT_ID.test(p.id) || p.id === "." || p.id === "..") {
            throw new HarnessFailure(
                `scenario project id ${JSON.stringify(p?.id)} is not a plain name`,
            );
        }
        ids.add(p.id);
    }
    const seen = new Set<string>();
    let last = 0;
    for (const e of scenario.events as Record<string, unknown>[]) {
        if (typeof e.id !== "string" || seen.has(e.id)) {
            throw new HarnessFailure(`event id ${JSON.stringify(e.id)} is missing or repeated`);
        }
        seen.add(e.id);
        const bad = (why: string) => new HarnessFailure(`event ${e.id} ${why}`);
        if (!EVENT_KINDS.has(e.kind as string))
            throw bad(`has unknown kind ${JSON.stringify(e.kind)}`);
        const ms = e.scenario_ms;
        if (typeof ms !== "number" || !Number.isFinite(ms) || ms < last) {
            throw bad(`has scenario_ms ${JSON.stringify(ms)}, below ${last} or not a number`);
        }
        last = ms;
        if (typeof e.session !== "string" || e.session === "") throw bad("names no session");
        if (e.kind === "user_turn" && (!Number.isInteger(e.index) || (e.index as number) < 0)) {
            throw bad(`has index ${JSON.stringify(e.index)}, not a non-negative integer`);
        }
        if (e.project !== undefined && (typeof e.project !== "string" || !ids.has(e.project))) {
            throw bad(`names undeclared project ${JSON.stringify(e.project)}`);
        }
    }
}

const EVENT_KINDS = new Set(["session_start", "user_turn", "apply_diff", "session_end"]);

/** `scenario.json` is accepted only when its body still hashes to its `scenario_hash`. */
export async function loadScenario(o: Pick<RunOptions, "config" | "out" | "seed" | "tier">) {
    const path = join(o.out, "scenario.json");
    if (!existsSync(path)) {
        const { aws_profile, region } = o.config.bedrock;
        const cache = join(ROOT, "runs/scenarios/embeddings.jsonl");
        mkdirSync(dirname(cache), { recursive: true });
        const embedder = bedrockEmbedder(aws_profile, region, cache);
        const compiled = await compileScenario(loadCompileInput(o.seed, o.tier, embedder));
        writeAtomic(path, `${canonicalJson(compiled)}\n`);
    }
    const scenario = readJsonFile<Scenario>(path);
    const { scenario_hash, ...body } = scenario;
    if (sha256Hex(canonicalJson(body)) !== scenario_hash) {
        throw new HarnessFailure(
            `scenario.json does not hash to its scenario_hash ${scenario_hash}`,
        );
    }
    const { seed, tier } = scenario.manifest as { seed: number; tier: string };
    if (seed !== o.seed || tier !== o.tier) {
        throw new HarnessFailure(
            `scenario.json is ${tier} seed ${seed}, not ${o.tier} seed ${o.seed}`,
        );
    }
    requireDeclaredProjects(scenario);
    validateEpisodes(scenario.faults, scenario, "scenario.json");
    return scenario;
}

const STRATEGIES = new Set(["single", "burst", "intermittent", "persistent"]);
/** Faults that run between sessions, so their trigger is the session's start (`HostDriver.fault`). */
const SESSION_START_ONLY = new Set([
    "laptop_sleep",
    "daemon_restart",
    "plugin_reload",
    "model_switch",
    "store_full",
]);
const COUNTS = ["count", "calls", "sessions"];
const DURATIONS = ["duration_ms", "delay_ms", "timeout_ms"];
/** The largest delay a JavaScript timer honors; longer values fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** The parameter each mechanism reads; every other key is refused as misleading. */
const TYPE_PARAMS: Partial<Record<FaultType, string[]>> = {
    provider_timeout: ["timeout_ms"],
    slow_stream: ["delay_ms"],
    laptop_sleep: ["duration_ms"],
    store_full: ["sessions"],
};

/**
 * Strategy rules per mechanism: a scheduler-layer fault fires once (`single`; `store_full` is
 * `persistent` for its sessions); a proxy `single` may carry the compiler's canonical `count: 1`,
 * a `burst` needs `count`, an `intermittent` needs `probability` and `calls`, and no strategy
 * carries another strategy's limit.
 */
function strategyProblems(
    type: FaultType,
    strategy: string,
    params: Record<string, unknown>,
): string[] {
    const problems: string[] = [];
    const typed = TYPE_PARAMS[type] ?? [];
    if (SEAMS[type].layer !== "proxy-sink") {
        const expected = type === "store_full" ? "persistent" : "single";
        if (strategy !== expected) problems.push(`${type} uses the ${expected} strategy`);
        for (const key of Object.keys(params)) {
            if (!typed.includes(key)) problems.push(`${key} does not apply to ${type}`);
        }
        return problems;
    }
    const allowed: Record<string, string[]> = {
        single: ["count"],
        burst: ["count"],
        intermittent: ["probability", "calls"],
        persistent: [],
    };
    for (const key of Object.keys(params)) {
        if (!(allowed[strategy] ?? []).includes(key) && !typed.includes(key)) {
            problems.push(`${key} does not apply to ${type} under the ${strategy} strategy`);
        }
    }
    if (strategy === "single" && "count" in params && params.count !== 1) {
        problems.push(`single fires once; count ${params.count} belongs to a burst`);
    }
    if (strategy === "burst" && typeof params.count !== "number")
        problems.push("burst needs count");
    if (strategy === "intermittent") {
        if (typeof params.probability !== "number") problems.push("intermittent needs probability");
        if (typeof params.calls !== "number") problems.push("intermittent needs calls");
    }
    return problems;
}

/** Range rules per parameter: probabilities in [0, 1], counts positive integers, durations >= 0. */
function paramProblems(params: Record<string, unknown>): string[] {
    const problems: string[] = [];
    for (const [k, v] of Object.entries(params)) {
        if (typeof v !== "number" || !Number.isFinite(v)) continue;
        if (k === "probability" && (v < 0 || v > 1))
            problems.push(`probability ${v} outside [0, 1]`);
        if (COUNTS.includes(k) && (!Number.isInteger(v) || v < 1)) {
            problems.push(`${k} ${v} is not a positive integer`);
        }
        if (DURATIONS.includes(k) && v < 0) problems.push(`${k} ${v} is negative`);
        if (DURATIONS.includes(k) && v > MAX_TIMER_MS) {
            problems.push(`${k} ${v} exceeds the ${MAX_TIMER_MS} ms timer limit`);
        }
    }
    return problems;
}

/** The field problems of one `--faults` episode, before the compiler's trigger and seam checks. */
function episodeProblems(value: unknown): string[] {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return ["not an object"];
    const e = value as Record<string, unknown>;
    const problems: string[] = [];
    if (typeof e.id !== "string" || e.id === "") problems.push("id missing");
    if (typeof e.type !== "string" || !Object.hasOwn(SEAMS, e.type)) {
        problems.push(`type ${e.type} unknown`);
    }
    if (!STRATEGIES.has(e.strategy as string)) problems.push(`strategy ${e.strategy} unknown`);
    const trigger = e.trigger as Record<string, unknown> | null;
    if (typeof trigger !== "object" || trigger === null || typeof trigger.kind !== "string") {
        problems.push("trigger missing");
    } else if (SESSION_START_ONLY.has(e.type as string) && trigger.kind !== "session_start") {
        problems.push(`${e.type} fires at a session_start trigger only`);
    } else if (e.type === "daemon_sigkill_mid_fold" && trigger.kind !== "first_summarizer_call") {
        problems.push("daemon_sigkill_mid_fold fires at a first_summarizer_call trigger only");
    }
    const params = e.params as Record<string, unknown> | null;
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
        problems.push("params missing");
    } else if (Object.values(params).some((v) => typeof v !== "number" || !Number.isFinite(v))) {
        problems.push("params must be finite numbers");
    }
    if (typeof e.seam !== "object" || e.seam === null) problems.push("seam missing");
    if (typeof params === "object" && params !== null) {
        problems.push(...paramProblems(params));
        if (typeof e.type === "string" && Object.hasOwn(SEAMS, e.type)) {
            problems.push(...strategyProblems(e.type as FaultType, e.strategy as string, params));
        }
    }
    return problems;
}

/** A `--faults` override is an array of complete episodes, each valid against the compiled scenario. */
export function faultOverride(raw: unknown, scenario: Scenario): FaultEpisode[] {
    if (!Array.isArray(raw)) throw new HarnessFailure("--faults must hold an array of episodes");
    validateEpisodes(raw, scenario, "--faults");
    return raw as FaultEpisode[];
}

/** Every episode is complete, unique by id, and valid against the scenario's sessions. */
function validateEpisodes(raw: unknown[], scenario: Scenario, source: string): void {
    const turns = new Map(scenario.sessions.map((x) => [x.id, x.requests]));
    const ids = new Set<string>();
    const perSession = new Set<string>();
    raw.forEach((value, i) => {
        const problems = episodeProblems(value);
        if (problems.length > 0) {
            throw new HarnessFailure(`${source} episode ${i} is malformed: ${problems.join(", ")}`);
        }
        const episode = value as FaultEpisode;
        if (ids.has(episode.id)) throw new HarnessFailure(`${source}: duplicate id ${episode.id}`);
        ids.add(episode.id);
        if (episode.type === "daemon_sigkill_mid_fold" || episode.type === "laptop_sleep") {
            const key = `${episode.type}/${episode.trigger.session}`;
            if (perSession.has(key)) {
                throw new HarnessFailure(
                    `${source}: two ${episode.type} episodes target session ${episode.trigger.session}`,
                );
            }
            perSession.add(key);
        }
        if (episode.type === "laptop_sleep") {
            const events = scenario.events.map((e) => ({
                kind: String(e.kind),
                session: String(e.session),
                scenario_ms: Number(e.scenario_ms),
            }));
            const at = events.findIndex((e) => e.session === episode.trigger.session);
            const before = at > 0 ? (events[at - 1]?.scenario_ms ?? null) : null;
            const gap = at >= 0 && before !== null && (events[at]?.scenario_ms ?? 0) > before;
            if (!gap) {
                throw new HarnessFailure(
                    `${source}: laptop_sleep ${episode.id} targets session ${episode.trigger.session}, which has no idle gap before its start`,
                );
            }
        }
        if (episode.type === "store_full" && episode.params.sessions !== 1) {
            throw new HarnessFailure(`${source}: store_full supports sessions: 1 only`);
        }
        try {
            validateFault(episode, turns);
        } catch (caught) {
            throw new HarnessFailure(`${source}: ${(caught as Error).message}`);
        }
    });
}

/** The pre-registered arm order for this seed, which `order_by_seed` may permute. */
function seedOrder(o: RunOptions): readonly string[] {
    const prereg = loadPrereg(o.tier);
    const index = prereg.seeds.indexOf(o.seed);
    if (index < 0) throw new HarnessFailure(`seed ${o.seed} is not pre-registered for ${o.tier}`);
    return prereg.arms.order_by_seed[index] ?? prereg.arms.run;
}

function armOrder(o: RunOptions): ArmName[] {
    const order = seedOrder(o);
    const unknown = (o.arms ?? []).filter((a) => !order.includes(a));
    if (unknown.length > 0) throw new HarnessFailure(`arms not in the ${o.tier} order: ${unknown}`);
    const kept = order.filter((a) => !o.arms || o.arms.includes(a)) as ArmName[];
    if (kept.length === 0) throw new HarnessFailure("no arm to run");
    return kept;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** `--events` may not exceed the compiled schedule, so the manifest never claims unrun events. */
function eventCount(requested: number | undefined, compiled: number): number {
    if (requested === undefined) return compiled;
    if (requested > compiled) {
        throw new HarnessFailure(`--events ${requested} exceeds the ${compiled} compiled events`);
    }
    return requested;
}

/**
 * Every regular file under `dir`, hashed by length-framed relative path and content. A symlink
 * whose target stays inside `dir` contributes its link text (the target is walked in place); one
 * that escapes contributes its link text and the digest of the target's content, so dependency
 * code linked in from elsewhere is bound too. `seen` holds the active ancestor chain, so a cycle
 * through escaping links ends while two links to one target both hash it.
 */
function directoryDigest(dir: string, seen = new Set<string>()): string {
    const root = realpathSync(dir);
    seen.add(root);
    const hash = createHash("sha256");
    const entries: string[] = [];
    const walk = (rel: string) => {
        for (const name of readdirSync(join(dir, rel)).sort()) {
            const child = rel === "" ? name : `${rel}/${name}`;
            const stat = lstatSync(join(dir, child));
            if (stat.isDirectory()) walk(child);
            else entries.push(child);
        }
    };
    walk("");
    for (const rel of entries) {
        const stat = lstatSync(join(dir, rel));
        const content = stat.isSymbolicLink()
            ? Buffer.from(
                  `->${readlinkSync(join(dir, rel))}${linkTarget(join(dir, rel), root, seen)}`,
              )
            : stat.isFile()
              ? readFileSync(join(dir, rel))
              : Buffer.from(`?${stat.mode}`);
        const name = Buffer.from(rel);
        hash.update(`${name.length}:`).update(name).update(`${content.length}:`).update(content);
    }
    return hash.digest("hex");
}

/** The digest suffix of a symlink's target when the target lies outside `root`; empty inside. */
function linkTarget(link: string, root: string, seen: Set<string>): string {
    let target: string;
    try {
        target = realpathSync(link);
    } catch {
        return "=dangling";
    }
    if (target === root || target.startsWith(`${root}/`)) return "";
    if (seen.has(target)) return "=cycle";
    const stat = statSync(target);
    if (stat.isDirectory()) return `=${directoryDigest(target, new Set(seen))}`;
    if (stat.isFile()) return `=${createHash("sha256").update(readFileSync(target)).digest("hex")}`;
    return `=?${stat.mode}`;
}

/** The OpenCode SDK module the host stack imports from the Eidnara checkout (`src/hosts/arms.ts`). */
const OPENCODE_SDK = "packages/e2e-tests/node_modules/@opencode-ai/sdk";

/** Every input the manifest pins besides the scenario hash, recomputed from the live environment. */
export function runIdentity(config: SimConfig, tier: Tier, projects: string[]) {
    return {
        prereg_sha256: preregistrationHash(loadPrereg(tier)),
        ...eidnaraIdentity(config.eidnara_checkout),
        ...simIdentity(),
        binaries: binaryDigests(config),
        corpus: corpusIdentity(projects),
        bedrock: { region: config.bedrock.region, aws_profile: config.bedrock.aws_profile },
        toolchain: toolchainIdentity(config),
    };
}

/** The configured toolchain and the content of each tool it names, resolved as the sandbox will. */
function toolchainIdentity(config: SimConfig): {
    config: SimConfig["toolchain"];
    tools: Record<string, string>;
} {
    const probed = TOOLCHAIN_PROBES.map(([tool]) => tool);
    const names = [...new Set([...probed, ...config.toolchain.wall_clock_tools])];
    const tools: Record<string, string> = {};
    for (const tool of names) {
        const dirs = [...config.toolchain.bin, ...SYSTEM_PATH.split(":")];
        const path = dirs.map((dir) => join(dir, tool)).find((p) => existsSync(p));
        tools[tool] = path
            ? createHash("sha256")
                  .update(readFileSync(realpathSync(path)))
                  .digest("hex")
            : "absent";
    }
    return { config: config.toolchain, tools };
}

const simIdentity = () => {
    const { commit, worktree } = treeIdentity(ROOT);
    return { sim_commit: commit, sim_worktree: worktree };
};

const eidnaraIdentity = (checkout: string) => {
    const { commit, worktree } = treeIdentity(checkout);
    return { eidnara_commit: commit, eidnara_worktree: worktree };
};

/** The commit and uncommitted-content digest of every corpus checkout an arm clones from. */
export function corpusIdentity(
    projects: string[],
    reposDir = join(ROOT, "corpus/repos"),
): Record<string, { commit: string; worktree: string }> {
    return Object.fromEntries(projects.map((id) => [id, treeIdentity(join(reposDir, id))]));
}

/**
 * Runtime artifacts the hosts load, hashed by content; the Pi install is hashed as a whole tree,
 * since Node resolves the CLI's dependencies anywhere under it. The interposer and the OpenCode
 * SDK are `absent` when not yet built or not installed; preflight builds the interposer first.
 */
function binaryDigests(config: SimConfig): Record<string, string> {
    const files = {
        daemon: config.daemon_binary,
        opencode: config.opencode_binary,
        pi: piCli(config),
        pi_install: config.pi_install,
        faketime: FAKETIME_LIB,
        node: realpathSync(Bun.which("node") ?? "node"),
        git: GIT,
        opencode_sdk: join(config.eidnara_checkout, OPENCODE_SDK),
        opencode_sdk_lock: join(config.eidnara_checkout, "packages/e2e-tests/bun.lock"),
    };
    return Object.fromEntries(
        Object.entries(files).map(([name, path]) => {
            const optional = name.startsWith("opencode_sdk") || name === "faketime";
            if (optional && !existsSync(path)) return [name, "absent"];
            if (statSync(path).isDirectory()) return [name, directoryDigest(realpathSync(path))];
            return [name, createHash("sha256").update(readFileSync(path)).digest("hex")];
        }),
    );
}

/** Fault types the host driver has no mechanism for; a schedule that needs one is refused up front. */
const UNIMPLEMENTED = new Set<string>(["host_upgrade", "two_hosts_one_daemon"]);

/** Every scheduled fault has a mechanism, and a `model_switch` has a second distinct model. */
export function requireMechanisms(faults: FaultEpisode[], models: string[]): void {
    const missing = [...new Set(faults.map((f) => f.type).filter((t) => UNIMPLEMENTED.has(t)))];
    if (missing.length > 0) {
        throw new HarnessFailure(
            `scheduled fault types without a mechanism: ${missing.join(", ")}`,
        );
    }
    if (models.some((m) => typeof m !== "string" || m.trim() === "")) {
        throw new HarnessFailure(`--models holds an empty entry: ${JSON.stringify(models)}`);
    }
    if (new Set(models).size !== models.length) {
        throw new HarnessFailure(`--models repeats an entry: ${models.join(",")}`);
    }
    if (faults.some((f) => f.type === "model_switch") && models.length < 2) {
        throw new HarnessFailure("a model_switch fault needs two distinct --models");
    }
}

/** Returns the run's manifest and this invocation's preflight result. */
export async function loadManifest(
    o: RunOptions,
    scenario: Scenario,
    checks?: Preflight,
): Promise<{ manifest: Manifest; checks: Preflight }> {
    const path = join(o.out, "manifest.json");
    const probe = async () => checks ?? (await preflight(o.config, o.out));
    const wanted = {
        tier: o.tier,
        seed: o.seed,
        host: o.host,
        order: armOrder(o),
        events: eventCount(o.events, scenario.events.length),
        context_limit: o.contextLimit ?? 200_000,
        models: o.models ?? [o.config.agent_model],
        fault_override: o.faults === undefined ? null : faultOverride(o.faults, scenario),
    };
    /** Computed once the inputs it hashes exist: before the probe on a resume, after it on a first run. */
    const digests = () => ({
        scenario_hash: scenario.scenario_hash,
        ...runIdentity(
            o.config,
            o.tier,
            scenario.projects.map((p) => p.id),
        ),
    });
    if (existsSync(path)) {
        const manifest = readJsonFile<Manifest>(path);
        if (manifest?.schema !== "sim-run-manifest/v1") {
            throw new HarnessFailure(
                `manifest.json schema ${manifest?.schema} is not sim-run-manifest/v1`,
            );
        }
        const fieldProblems = manifestProblems(manifest, scenario.events.length);
        if (fieldProblems.length > 0) {
            throw new HarnessFailure(`manifest.json is malformed: ${fieldProblems.join(", ")}`);
        }
        const known = seedOrder(o);
        const order = Array.isArray(manifest.order) ? manifest.order : [];
        const positions = order.map((a) => known.indexOf(a));
        const subsequence =
            order.length > 0 &&
            positions.every((p, i) => p >= 0 && (i === 0 || p > (positions[i - 1] as number)));
        if (!subsequence) {
            throw new HarnessFailure(
                `manifest.json order ${JSON.stringify(order)} is not a non-empty subsequence of the ${o.tier} arms for seed ${o.seed}`,
            );
        }
        const given: Record<string, boolean> = {
            order: o.arms !== undefined,
            events: o.events !== undefined,
            context_limit: o.contextLimit !== undefined,
            models: o.models !== undefined,
            fault_override: o.faults !== undefined,
        };
        const differs = Object.entries(wanted).filter(
            ([k, v]) => given[k] !== false && !sameJson(manifest[k as keyof Manifest], v),
        );
        if (differs.length > 0) {
            const names = differs.map(([k]) => k).join(", ");
            throw new HarnessFailure(`resume options differ from the manifest: ${names}`);
        }
        const changed = Object.entries(digests()).filter(
            ([k, v]) => !sameJson(manifest[k as keyof Manifest], v),
        );
        if (changed.length > 0) {
            const names = changed.map(([k]) => k).join(", ");
            throw new HarnessFailure(`inputs changed since the run started: ${names}`);
        }
        checks = await probe();
        const intercepted = (p: Preflight) =>
            p.time_injection.map((t) => [t.name, t.path, t.intercepted, t.wall_clock_only]);
        if (!sameJson(intercepted(manifest.preflight), intercepted(checks))) {
            throw new HarnessFailure("time interception changed since the run started");
        }
        if (!sameJson(manifest.preflight.toolchain, checks.toolchain)) {
            throw new HarnessFailure("the toolchain changed since the run started");
        }
        const hostRow = (p: Preflight) => p.hosts.find((h) => h.host === o.host);
        if (!sameJson(hostRow(manifest.preflight), hostRow(checks))) {
            throw new HarnessFailure(`the ${o.host} host changed since the run started`);
        }
        if (manifest.fault_override !== null) {
            if (!Array.isArray(manifest.fault_override)) {
                throw new HarnessFailure("manifest.json fault_override is not an array");
            }
            validateEpisodes(manifest.fault_override, scenario, "manifest.json fault_override");
        }
        requireMechanisms(manifest.fault_override ?? scenario.faults, manifest.models);
        const preflightLog = join(o.out, "preflight.jsonl");
        dropCutTail(preflightLog);
        appendFileSync(preflightLog, `${JSON.stringify(checks)}\n`);
        return { manifest, checks };
    }
    requireMechanisms(wanted.fault_override ?? scenario.faults, wanted.models);
    checks = await probe();
    const manifest: Manifest = {
        schema: "sim-run-manifest/v1",
        ...wanted,
        ...digests(),
        base_wall_ms: Date.now(),
        preflight: checks,
    };
    writeAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
    return { manifest, checks };
}

interface Stop {
    reason: string | null;
    /** Every driver call in flight; a signal teardown waits for them up to `SIGNAL_GRACE_MS`. */
    active: Set<Promise<unknown>>;
}

const SIGNAL_GRACE_MS = 30_000;
/** Wall time after a turn during which the daemon's CPU is measured before the clock may jump. */
const POST_TURN_SAMPLE_MS = 2_000;

/** Runs every cleanup step in reverse order and rethrows the first failure. */
export async function runSteps(steps: Array<() => Promise<void> | void>): Promise<void> {
    let failure: unknown = null;
    for (const step of steps.reverse()) {
        try {
            await step();
        } catch (caught) {
            console.error(caught);
            failure ??= caught;
        }
    }
    if (failure !== null) throw failure;
}

export async function runTier(o: RunOptions): Promise<void> {
    plainPath(o.out);
    if (resolve(o.out) === "/") throw new HarnessFailure("--out may not be the filesystem root");
    requireOutsideCheckout(o.out, o.config.eidnara_checkout);
    requireOutsideCheckout(o.out, o.config.pi_install, "the Pi install");
    requireOutsideIdentity(o.out);
    requirePinnedPath(o.config);
    mkdirSync(o.out, { recursive: true });
    requirePlainArtifacts(o.out, loadPrereg(o.tier).arms.run);
    takeLease(o.out);
    const cleanup: Array<() => Promise<void> | void> = [() => releaseLease(o.out)];
    let done: Promise<void> | null = null;
    const teardown = () => {
        done ??= runSteps(cleanup.splice(0));
        return done;
    };
    const stop: Stop = { reason: null, active: new Set() };
    const onSignal = (signal: NodeJS.Signals) => {
        if (done) return;
        stop.reason ??= `signal ${signal}`;
        const settled = Promise.allSettled([...stop.active]);
        void Promise.race([settled, Bun.sleep(SIGNAL_GRACE_MS)])
            .then(() => teardown())
            .catch(() => undefined)
            .finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    let failure: unknown = null;
    try {
        await runArms(o, cleanup, stop);
    } catch (caught) {
        failure = caught;
    }
    try {
        await teardown();
    } catch (caught) {
        failure ??= caught;
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (failure !== null) throw failure;
}

async function runArms(
    o: RunOptions,
    cleanup: Array<() => Promise<void> | void>,
    stop: Stop,
): Promise<void> {
    const guard = () => {
        if (stop.reason) throw new HarnessFailure(`run stopping: ${stop.reason}`);
    };
    /** Each driver call runs between two stop checks and is recorded while in flight. */
    const tracked = async <T>(call: () => Promise<T>): Promise<T> => {
        guard();
        const active = call();
        stop.active.add(active);
        try {
            const result = await active;
            guard();
            return result;
        } finally {
            stop.active.delete(active);
        }
    };
    let samplerFailure: unknown = null;
    /**
     * After a turn, a hold job keeps the clock while the sampler measures the daemon's CPU over
     * `POST_TURN_SAMPLE_MS`; a busy reading registers the daemon-cpu job before the hold ends.
     */
    const holds = new Map<ReturnType<typeof setTimeout>, () => void>();
    const holdForCpu = (sampler: ResourceSampler, arm: string) => {
        sampler.sample();
        const hold = `settle-cpu-${arm}-${jobSeq++}`;
        scheduler.jobStart(hold);
        const end = () => {
            try {
                scheduler.jobEnd(hold);
            } catch (caught) {
                samplerFailure ??= caught;
                stop.reason ??= `post-turn hold failed: ${(caught as Error).message}`;
            }
        };
        const timer = setTimeout(() => {
            holds.delete(timer);
            try {
                sampler.sample();
            } catch (caught) {
                samplerFailure ??= caught;
                stop.reason ??= `sampler failed: ${(caught as Error).message}`;
            } finally {
                end();
            }
        }, POST_TURN_SAMPLE_MS);
        holds.set(timer, end);
    };
    const { config, seed } = o;
    const prereg = loadPrereg(o.tier);
    const wallBudgetMs = prereg.liveness_bounds.tier_wall_budget_ms;
    const budget = setTimeout(() => {
        stop.reason ??= `tier wall budget of ${wallBudgetMs} ms exhausted`;
    }, wallBudgetMs);
    budget.unref();
    cleanup.push(() => clearTimeout(budget));
    const journalPath = join(o.out, "journal.jsonl");
    const fresh = !existsSync(journalPath) || readFileSync(journalPath, "utf8").trim() === "";
    if (fresh) {
        if (existsSync(journalPath) && readFileSync(journalPath).length > 0) {
            throw new HarnessFailure(
                `${journalPath} holds no complete entry; refusing to truncate it`,
            );
        }
        requireFreshArmRoots(o.out, loadPrereg(o.tier).arms.run);
    }
    const journal = new Journal(journalPath);
    cleanup.push(() => journal.close());
    cleanup.push(() => {
        for (const [timer, end] of holds) {
            clearTimeout(timer);
            end();
        }
        holds.clear();
    });
    if (journal.entries.some((e) => e.kind === "EndRun")) {
        throw new HarnessFailure(`${o.out} holds a completed run; its journal ends with EndRun`);
    }
    requireJournalShape(journal.entries);
    if (!fresh) rmSync(join(o.out, "toolbin"), { recursive: true, force: true });
    const compiled = await tracked(() => loadScenario(o));
    const { manifest, checks } = await tracked(() => loadManifest(o, compiled));
    requireJournalShape(
        journal.entries,
        compiled.events.slice(0, manifest.events).map((e) => ({
            id: String(e.id),
            kind: String(e.kind),
            scenario_ms: Number(e.scenario_ms),
        })),
        manifest.order,
    );
    const bound = journal.entries
        .filter((e) => e.kind === "Preflight")
        .map((e) => e.manifest_sha256);
    const manifestDigest = manifestIdentity(manifest);
    if (bound.some((digest) => digest !== manifestDigest)) {
        throw new HarnessFailure(
            "manifest.json differs from the manifest this run's journal binds",
        );
    }
    journal.append({
        kind: "Preflight",
        arm: null,
        scenario_ms: 0,
        time_injection: checks.time_injection,
        hosts: checks.hosts,
        manifest_sha256: manifestDigest,
    });
    const scenario = { ...compiled, faults: manifest.fault_override ?? compiled.faults };
    const events: ScenarioEvent[] = scenario.events
        .slice(0, manifest.events)
        .map((e) => ({ ...e, id: String(e.id), session: String(e.session) }) as ScenarioEvent);
    const hostRow = manifest.preflight.hosts.find((h) => h.host === o.host);
    if (!hostRow) throw new Error(`preflight lists no ${o.host} host`);

    const drivers: Partial<Record<ArmName, ArmDriver>> = {};
    const samplers = new Map<string, ResourceSampler>();
    const proxyFaults = scenario.faults.filter((f) => f.seam.layer === "proxy-sink");
    const injector = new FaultInjector(proxyFaults, new Rng((seed ^ 0x5bd1e995) >>> 0), 120_000);
    const callsPath = join(o.out, "calls.jsonl");
    const priorCalls = readRecords(callsPath);
    injector.restore(priorCalls);
    for (const e of journal.entries) {
        if (e.kind === "FaultFired" && e.layer === "proxy-sink" && typeof e.arm === "string") {
            injector.armedBefore(String(e.fault), e.arm);
        }
    }
    /** This invocation's witness report, appended once: before `EndRun`, or at teardown otherwise. */
    const witnessed = { done: false };
    const writeWitnesses = () => {
        if (witnessed.done) return;
        const report = manifest.order.flatMap((arm) => injector.report(arm));
        const path = join(o.out, "faults.jsonl");
        dropCutTail(path);
        appendFileSync(path, `${JSON.stringify(report)}\n`);
        witnessed.done = true;
    };
    const offsetFile = (arm: string) => join(o.out, arm, "clock", "offset");
    const scheduler = new Scheduler({
        events,
        faults: scenario.faults,
        journal,
        order: manifest.order,
        drivers: drivers as Record<string, ArmDriver>,
        proxy: injector,
        idleLimitMs: prereg.liveness_bounds.job_deadline_ms,
        onClock: (arm, ms) => writeOffset(offsetFile(arm), manifest.base_wall_ms, ms),
        stopped: () => stop.reason,
        onArmReady: (arm) => {
            const sampler = samplers.get(arm);
            if (sampler) holdForCpu(sampler, arm);
        },
        verify: async (point) => {
            if (point === "EndRun") await gateway.stop();
            handlersFailed();
            if (samplerFailure !== null) throw samplerFailure;
            if (point === "EndRun") writeWitnesses();
        },
    });
    const now = () => scheduler.clock?.now() ?? 0;
    const scope = { arm: "", session: null as string | null, turn: null as string | null };
    let jobSeq = journal.entries.filter((e) => e.kind === "RegisterJob").length;
    const gateway = new Gateway({
        upstream: bedrockUpstream(config.bedrock.region, config.bedrock.aws_profile),
        records: new RecordWriter(callsPath),
        injector,
        rng: new Rng((seed ^ 0x27d4eb2f) >>> 0),
        clock: { scenarioMs: now },
        scope: () => ({ ...scope }),
        arrival: () => {
            if (scope.arm === "") return;
            const id = `request-${jobSeq++}`;
            scheduler.jobStart(id);
            return () => scheduler.jobEnd(id);
        },
        observe: (e) => {
            const driver = drivers[scope.arm as ArmName];
            if (driver) scheduler.observe(e.component, driver);
            const id = `${e.component}-${jobSeq++}`;
            scheduler.jobStart(id);
            return () => scheduler.jobEnd(id);
        },
        requestDeadlineMs: prereg.liveness_bounds.turn_deadline_ms,
        firstArrival: priorCalls.reduce((n, r) => Math.max(n, (r.arrival ?? r.seq) + 1), 0),
    });
    await gateway.start();
    const handlersFailed = () => {
        const [first] = gateway.failures;
        if (!first) return;
        const n = gateway.failures.length;
        throw new HarnessFailure(`${n} proxy handler failure(s); first: ${first.message}`);
    };
    cleanup.push(async () => {
        await gateway.stop();
        writeWitnesses();
        handlersFailed();
    });

    const projects = Object.fromEntries(
        scenario.projects.map((p) => [p.id, join(ROOT, "corpus/repos", p.id)]),
    );
    const loopStore = scenario.faults.some((f) => f.type === "store_full");
    for (const arm of manifest.order) {
        const armRoot = join(o.out, arm, "r");
        mkdirSync(dirname(offsetFile(arm)), { recursive: true });
        const driver = new HostDriver({
            config,
            arm,
            host: o.host,
            armRoot,
            launcher: checks.launcher,
            offsetFile: offsetFile(arm),
            baseMs: manifest.base_wall_ms,
            keep: [armRoot, dirname(offsetFile(arm))],
            proxyHttp1: gateway.urls[0] as string,
            proxyHttp2: gateway.urls[1] as string,
            projects,
            models: manifest.models,
            contextLimit: manifest.context_limit,
            turnDeadlineMs: prereg.liveness_bounds.turn_deadline_ms,
            transcriptPaths: hostRow.transcript_paths,
            loopStore,
            onDaemonExit: (detail) => scheduler.daemonExited(detail),
        });
        let cpuJob: string | null = null;
        const onBusy = (busy: boolean) => {
            if (busy && cpuJob === null) {
                const id = `daemon-cpu-${arm}-${jobSeq++}`;
                scheduler.jobStart(id);
                cpuJob = id;
            } else if (!busy && cpuJob !== null) {
                scheduler.jobEnd(cpuJob);
                cpuJob = null;
            }
        };
        const sampler = new ResourceSampler({
            path: join(o.out, arm, "resources.jsonl"),
            intervalMs: prereg.leak_bound.sample_interval_ms,
            busyFraction: Number(prereg.liveness_bounds.daemon_busy_cpu_fraction),
            pid: () => driver.daemonPid(),
            storeDir: driver.dataDir,
            scenarioMs: now,
            onBusy,
            onError: (caught) => {
                samplerFailure ??= caught;
                stop.reason ??= `sampler failed: ${(caught as Error).message}`;
            },
        });
        samplers.set(arm, sampler);
        cleanup.push(() => driver.stop());
        cleanup.push(() => sampler.stop());
        drivers[arm] = {
            reset: () =>
                tracked(async () => {
                    scope.arm = arm;
                    await driver.reset();
                    sampler.start();
                }),
            resume: (open) =>
                tracked(async () => {
                    scope.arm = arm;
                    scope.session = open?.session ?? null;
                    await driver.resume(open);
                    sampler.start();
                }),
            event: (e) =>
                tracked(async () => {
                    scope.arm = arm;
                    scope.session = e.session;
                    scope.turn = e.kind === "user_turn" ? e.id : null;
                    try {
                        return await driver.event(e);
                    } finally {
                        scope.turn = null;
                        if (e.kind === "user_turn") holdForCpu(sampler, arm);
                    }
                }),
            fault: (f) => tracked(() => driver.fault(f)),
            reap: () => tracked(() => driver.reap()),
            finish: () =>
                tracked(async () => {
                    try {
                        if (driver.daemon && driver.daemonPid() === null) {
                            scheduler.daemonExited({ after: "last event" });
                        }
                        sampler.stop();
                    } finally {
                        await driver.finish();
                    }
                }),
        };
    }
    await scheduler.run();
    handlersFailed();
    if (samplerFailure !== null) throw samplerFailure;
}
