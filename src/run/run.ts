import { createHash } from "node:crypto";
import {
    appendFileSync,
    closeSync,
    existsSync,
    constants as fsConstants,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    readSync,
    realpathSync,
    rmSync,
    statSync,
    truncateSync,
    writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SimConfig } from "../config/config";
import type { CallView } from "../grade/artefacts";
import { armBase, CONTROL_LABEL, eidnaraUserConfig, fixtureDaemonConfig } from "../hosts/arms";
import { driverSupports, HostDriver } from "../hosts/driver";
import {
    type ArmProfile,
    armProfile,
    capabilityGaps,
    deliveryOf,
    isArmName,
} from "../hosts/profiles";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import { type Qualification, qualificationHash } from "../prereg/qualification";
import type { Preregistration, Tier } from "../prereg/schema";
import { preregistrationHash } from "../prereg/validate";
import { bedrockUpstream, Gateway } from "../proxy/gateway";
import { FaultInjector, restoreOrder } from "../proxy/inject";
import { type CallRecord, RecordWriter, recordProblems } from "../proxy/records";
import { RequestPartLog, RequestStore } from "../proxy/requests";
import { Rng } from "../rng";
import {
    compileScenario,
    markerHits,
    type Scenario,
    scenarioInputMismatch,
} from "../scenario/compile";
import { type FaultEpisode, type FaultType, SEAMS, validateFault } from "../scenario/faults";
import {
    corpusInputsSha256,
    loadCompileInput,
    loadPrereg,
    loadQualification,
} from "../scenario/inputs";
import { bedrockEmbedder } from "../scenario/similarity";
import {
    beganAt,
    behaviourPlan,
    deliveredTurns,
    type Label,
    pinnedTurns,
    realisedRates,
} from "../usersim/plan";
import {
    type AgentReply,
    agentReplyOf,
    checkTapeSources,
    normaliser,
    Pairing,
    proxyUserSim,
    Tape,
    tapeDigests,
    UserSim,
} from "../usersim/usersim";
import { writeAtomic } from "./atomic";
import {
    armMismatches,
    bootMismatches,
    type ExpectedNote,
    logLength,
    observeArm,
    observeDelivery,
    readPluginLog,
    requireAuditedVariants,
} from "./capabilities";
import {
    type Entry,
    Journal,
    readJsonl,
    releaseLease,
    requireAppendable,
    takeLease,
} from "./journal";
import { plainPath } from "./launcher";
import { ORACLE_OPENING, oracleBackground } from "./oracle-note";
import { contains, realExisting } from "./paths";
import { type Preflight, piCli, preflight, preflightDrift } from "./preflight";
import { PRICE_TABLE, type PriceTable } from "./price";
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
    tapes?: string[];
    sideModel?: string;
    userSimModel?: string;
    /** Every user turn waits for background work to finish, as runs before turns ran on schedule did. */
    turnsAwaitJobs?: boolean;
    /** The qualification registration (`prereg/<id>.json`) whose arms and controls the run takes. */
    qualification?: string;
}

export interface Manifest {
    schema: "sim-run-manifest/v3";
    tier: Tier;
    seed: number;
    host: "pi" | "opencode";
    order: string[];
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
    /**
     * SHA-256 of the daemon, OpenCode, and Pi executables and of the plugin builds the hosts
     * load; a resume must present the same.
     */
    binaries: Record<string, string>;
    /** Each ordered arm's profile and the Eidnara and daemon configuration it writes. */
    arms: Record<string, ArmConfig>;
    fault_override: FaultEpisode[] | null;
    tapes: string[];
    /** One digest per entry of `tapes`, over the tape and the pairing log beside it. */
    tape_sha256: string[];
    side_model: string | null;
    user_sim_model: string;
    turns_await_jobs: boolean;
    prereg_sha256: string;
    /** The qualification the run took its arms and controls from; null for a tier run. */
    qualification?: { id: string; sha256: string } | null;
    base_wall_ms: number;
    /** The rates the cost panel prices this run's calls at, fixed when the run starts. */
    price_table: PriceTable;
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

const within = (path: string, dir: string) => contains(dir, path);

const ARTIFACTS = [
    `lease.${process.pid}.tmp`,
    "journal.jsonl",
    "scenario.json",
    `scenario.json.${process.pid}`,
    "manifest.json",
    `manifest.json.${process.pid}`,
    "preflight.jsonl",
    "calls.jsonl",
    "requests.jsonl",
    "faults.jsonl",
    "tape.jsonl",
    "pairing.jsonl",
    "downstream.jsonl",
    "attempt.json",
    `attempt.json.${process.pid}`,
];

const ARM_EVIDENCE = [
    "capabilities.json",
    "snapshots.jsonl",
    "tools.jsonl",
    "commands.jsonl",
    "store-check.json",
    "memory.json",
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
        ...ARM_EVIDENCE.map((f) => join(arm, f)),
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
        const r = Bun.spawnSync([GIT, "-C", real, "check-ignore", "-q", target]);
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
        if (e.kind === "Preflight" || e.kind === "CounterfactualSample") continue;
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
    if (!Array.isArray(m.tapes) || m.tapes.some((x) => typeof x !== "string" || x === "")) {
        problems.push("tapes is not a list of paths");
    }
    if (
        !Array.isArray(m.tape_sha256) ||
        m.tape_sha256.some((x) => typeof x !== "string") ||
        m.tape_sha256.length !== (Array.isArray(m.tapes) ? m.tapes.length : -1)
    ) {
        problems.push("tape_sha256 is not one digest per tape");
    }
    if (m.side_model !== null && (typeof m.side_model !== "string" || m.side_model === "")) {
        problems.push("side_model is neither null nor a name");
    }
    if (typeof m.turns_await_jobs !== "boolean") problems.push("turns_await_jobs is not a boolean");
    if (typeof m.user_sim_model !== "string" || m.user_sim_model === "") {
        problems.push("user_sim_model is not a name");
    }
    const price = m.price_table as Partial<PriceTable> | undefined;
    const rates = price?.rates as Record<string, unknown> | undefined;
    if (
        typeof price?.version !== "string" ||
        price.version === "" ||
        typeof rates !== "object" ||
        rates === null ||
        ["input", "output", "cache_read", "cache_write"].some(
            (k) => typeof rates[k] !== "number" || !Number.isFinite(rates[k]) || rates[k] < 0,
        )
    ) {
        problems.push("price_table is not a versioned table of non-negative rates");
    }
    return problems;
}

/** The manifest's execution fields (everything but the per-invocation preflight), as one digest. */
export function manifestIdentity(manifest: Manifest): string {
    const { preflight: _preflight, ...fields } = manifest;
    return sha256Hex(canonicalJson(fields));
}

/** Written before a fresh run's preflight; names the scratch directories that preflight creates. */
const ATTEMPT = "attempt.json";
const PREFLIGHT_SCRATCH = ["toolbin", "interception", "hostbin"];

/**
 * A run with no journal yet owns no evidence or arm payload; any such existing file is refused.
 * Preflight scratch left by an earlier fresh attempt of this harness (recorded in `attempt.json`
 * before preflight ran) is this harness's own and is removed, so a failed first preflight leaves
 * a directory the next invocation can use.
 */
export function requireFreshArmRoots(out: string, arms: readonly string[]): void {
    const attempt = lstatSync(join(out, ATTEMPT), { throwIfNoEntry: false });
    if (attempt?.isFile()) {
        for (const scratch of PREFLIGHT_SCRATCH)
            rmSync(join(out, scratch), { recursive: true, force: true });
    }
    const evidence = [
        "calls.jsonl",
        "requests.jsonl",
        "faults.jsonl",
        "preflight.jsonl",
        "tape.jsonl",
        "pairing.jsonl",
        "downstream.jsonl",
        ...PREFLIGHT_SCRATCH,
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
        "snapshot.git",
        "snapshot-state.json",
        ...ARM_EVIDENCE,
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

/**
 * The shared embedding cache, its staging file, and its directory are plain entries that resolve
 * inside this tree's `runs/`, so the embedder's append and the CLI's write reach no other file.
 */
export function requirePlainCache(cache: string, checkout: string): void {
    const runs = realpathSync(join(ROOT, "runs"));
    const dir = realpathSync(dirname(cache));
    if (dir !== runs && !dir.startsWith(`${runs}/`)) {
        throw new HarnessFailure(`${dirname(cache)} resolves to ${dir}, outside ${runs}`);
    }
    const real = realpathSync(checkout);
    if (dir === real || dir.startsWith(`${real}/`)) {
        throw new HarnessFailure(`${dirname(cache)} resolves inside the Eidnara checkout`);
    }
    for (const path of [cache, `${cache}.${process.pid}.tmp`]) {
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (!stat) continue;
        if (stat.isSymbolicLink()) throw new HarnessFailure(`${path} is a symlink`);
        if (!stat.isFile()) throw new HarnessFailure(`${path} is not a regular file`);
        if (stat.nlink > 1) throw new HarnessFailure(`${path} has ${stat.nlink} links`);
        if (path !== cache) rmSync(path, { force: true });
    }
}

/** `scenario.json` is accepted only when its body still hashes to its `scenario_hash`. */
/** One parsed pre-registration per run options object, so every startup step reads the same revision. */
const preregs = new WeakMap<object, Preregistration>();
function preregOf(o: Pick<RunOptions, "tier">): Preregistration {
    const cached = preregs.get(o);
    if (cached) return cached;
    const loaded = loadPrereg(o.tier);
    preregs.set(o, loaded);
    return loaded;
}

const qualifications = new WeakMap<object, Qualification | null>();
/** The run's qualification registration, which must bind the run's tier; null for a tier run. */
function qualificationOf(o: Pick<RunOptions, "tier" | "qualification">): Qualification | null {
    if (qualifications.has(o)) return qualifications.get(o) ?? null;
    let loaded: Qualification | null = null;
    if (o.qualification !== undefined) {
        try {
            loaded = loadQualification(o.qualification);
        } catch (caught) {
            throw new HarnessFailure((caught as Error).message);
        }
        if (loaded.tier !== o.tier) {
            throw new HarnessFailure(
                `qualification ${loaded.id} runs over tier ${loaded.tier}, not ${o.tier}`,
            );
        }
    }
    qualifications.set(o, loaded);
    return loaded;
}

/** What the manifest and the scenario record for the qualification; null for a tier run. */
const qualificationRef = (o: Pick<RunOptions, "tier" | "qualification">) => {
    const q = qualificationOf(o);
    return q ? { id: q.id, sha256: qualificationHash(q) } : null;
};

/** The arms the run's registration lists: the qualification's, or the tier's. */
const registeredArms = (o: Pick<RunOptions, "tier" | "qualification">) =>
    (qualificationOf(o) ?? preregOf(o)).arms.run;

/**
 * `items` supplies L's resized paired-item count per probe type. A tier that pre-registers
 * resizing compiles only with that count.
 */
export async function loadScenario(
    o: Pick<RunOptions, "config" | "out" | "seed" | "tier" | "qualification">,
    items?: number,
): Promise<Scenario> {
    const path = join(o.out, "scenario.json");
    if (!existsSync(path)) {
        if (items === undefined && loadPrereg(o.tier).resizing) {
            throw new HarnessFailure(
                `${o.tier} compiles only with the resizing scripts/tier.ts --resize-from records`,
            );
        }
        const { aws_profile, region } = o.config.bedrock;
        const cache = join(ROOT, "runs/scenarios/embeddings.jsonl");
        mkdirSync(dirname(cache), { recursive: true });
        requirePlainCache(cache, o.config.eidnara_checkout);
        const embedder = bedrockEmbedder(aws_profile, region, cache);
        const q = qualificationOf(o);
        const input = {
            ...loadCompileInput(o.seed, o.tier, embedder),
            ...(items === undefined ? {} : { items }),
            ...(q ? { qualification: { sha256: qualificationHash(q), controls: q.controls } } : {}),
        };
        const compiled = await compileScenario(input);
        writeAtomic(path, `${canonicalJson(compiled)}\n`);
    }
    const scenario = readJsonFile<Scenario>(path);
    const { scenario_hash, ...body } = scenario;
    if (sha256Hex(canonicalJson(body)) !== scenario_hash) {
        throw new HarnessFailure(
            `scenario.json does not hash to its scenario_hash ${scenario_hash}`,
        );
    }
    if (items !== undefined) {
        const { seeds, hosts } = loadPrereg(o.tier);
        const want = Math.ceil(items / (seeds.length * hosts.length));
        const { probes_per_type } = scenario.manifest as { probes_per_type: number };
        if (probes_per_type !== want) {
            throw new HarnessFailure(
                `${path} has probes_per_type ${probes_per_type}; the recorded resizing needs ${want}`,
            );
        }
    }
    // A resized compile takes its count as an input, so the scenario records the registered
    // pre-registration's hash.
    const stale = scenarioInputMismatch(scenario, {
        preregistration_sha256: preregistrationHash(preregOf(o)),
        corpus_inputs_sha256: corpusInputsSha256(),
        qualification_sha256: qualificationRef(o)?.sha256 ?? null,
    });
    if (stale) throw new HarnessFailure(stale);
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
    "host_upgrade",
    "two_hosts_one_daemon",
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
    const eventIds = new Set(scenario.events.map((e) => String(e.id)));
    raw.forEach((value, i) => {
        const problems = episodeProblems(value);
        if (problems.length > 0) {
            throw new HarnessFailure(`${source} episode ${i} is malformed: ${problems.join(", ")}`);
        }
        const episode = value as FaultEpisode;
        if (ids.has(episode.id)) throw new HarnessFailure(`${source}: duplicate id ${episode.id}`);
        if (eventIds.has(episode.id)) {
            throw new HarnessFailure(`${source}: id ${episode.id} is also a scenario event id`);
        }
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

/**
 * The oracle note of each probe turn whose ground truth names sources, keyed by event. A scenario
 * whose own text holds the note's opening would make notes unattributable, and a note carrying a
 * marker would show the agent what is measured, so both refuse the run.
 */
export function oracleBackgrounds(
    scenario: Scenario,
    keys: readonly string[],
): Map<string, string> {
    const notes = new Map<string, string>();
    for (const e of scenario.events as Record<string, unknown>[]) {
        const text = String(e.text ?? e.content ?? "");
        if (text.includes(ORACLE_OPENING)) {
            throw new HarnessFailure(`${String(e.id)} holds the oracle note's opening`);
        }
        if (e.kind !== "user_turn" || typeof e.probe !== "string") continue;
        const note = oracleBackground(scenario, e.probe);
        if (note === null) continue;
        const hits = markerHits(note, keys);
        if (hits.length > 0) {
            throw new HarnessFailure(
                `${String(e.id)}: oracle note carries markers ${hits.join(", ")}`,
            );
        }
        notes.set(String(e.id), note);
    }
    return notes;
}

/** Arm startup requires a daemon variant that supplies every capability the arm's profile declares. */
function refuseCapabilityGaps(arms: readonly string[]): void {
    const gaps = arms.filter((a) => isArmName(armBase(a))).flatMap((a) => capabilityGaps(a));
    if (gaps.length > 0) throw new HarnessFailure(`arm capability refused: ${gaps.join("; ")}`);
}

/**
 * An A/A control label `<arm>~<tag>` runs right after its arm when the tier pre-registers the
 * `[arm, arm]` pair. Under a qualification the seed, its arm order, and the host come from the
 * qualification, which registers no A/A pair.
 */
export function armOrder(
    o: Pick<RunOptions, "tier" | "seed" | "arms" | "qualification"> & { host?: string },
): string[] {
    refuseCapabilityGaps(o.arms ?? []);
    const prereg = preregOf(o);
    const q = qualificationOf(o);
    const registry = q ?? prereg;
    const name = q ? `qualification ${q.id}` : o.tier;
    const index = registry.seeds.indexOf(o.seed);
    if (index < 0) throw new HarnessFailure(`seed ${o.seed} is not pre-registered for ${name}`);
    if (q && o.host !== undefined && !q.hosts.includes(o.host)) {
        throw new HarnessFailure(`qualification ${q.id} runs no ${o.host} host`);
    }
    const order: string[] = registry.arms.order_by_seed[index] ?? registry.arms.run;
    const pairs = q ? [] : (prereg.aa_controls?.pairs ?? []);
    const control = (a: string) =>
        CONTROL_LABEL.test(a) && pairs.some(([x, y]) => x === armBase(a) && y === armBase(a));
    if (new Set(o.arms).size !== (o.arms ?? []).length) {
        throw new HarnessFailure("--arms lists an arm twice");
    }
    const unknown = (o.arms ?? []).filter((a) => !order.includes(a) && !control(a));
    if (unknown.length > 0) throw new HarnessFailure(`arms not in the ${name} order: ${unknown}`);
    const kept = order
        .filter((a) => !o.arms || o.arms.includes(a))
        .flatMap((a) => [a, ...(o.arms ?? []).filter((c) => control(c) && armBase(c) === a)]);
    if ((o.arms ?? []).some((a) => control(a) && !kept.includes(armBase(a)))) {
        throw new HarnessFailure("an A/A control arm runs only beside its arm");
    }
    const controls = (o.arms ?? []).filter(control).map(armBase);
    if (new Set(controls).size !== controls.length) {
        throw new HarnessFailure("an arm runs one A/A control");
    }
    if (kept.length === 0) throw new HarnessFailure("no arm to run");
    refuseCapabilityGaps(kept);
    return kept;
}

/**
 * A persisted order is one `armOrder` would schedule for the tier and seed: pre-registered arms
 * in the seed's relative order, each control right after its arm, once, for a registered pair.
 */
export function requireAdmittedOrder(
    o: Pick<RunOptions, "tier" | "seed" | "qualification">,
    order: readonly string[],
): void {
    if (!sameJson(armOrder({ ...o, arms: [...order] }), order)) {
        throw new HarnessFailure(
            `manifest order ${order.join(",")} is not an order ${o.tier} seed ${o.seed} admits`,
        );
    }
}

const PARTNER: Partial<Record<string, string>> = { eidnara: "eidnara-cf", "eidnara-cf": "eidnara" };

/**
 * The arm a user-sim divergence is measured against: an A/A control's own arm; the
 * `eidnara`/`eidnara-cf` partner when it appears earlier in `order`; else the first arm.
 */
export const referenceArm = (order: string[]) => (arm: string) => {
    if (arm.includes("~")) return armBase(arm);
    const partner = PARTNER[arm];
    const at = (a: string) => order.indexOf(a);
    return partner && at(partner) >= 0 && at(partner) < at(arm) ? partner : (order[0] as string);
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface ProxyScope {
    session: string | null;
    turn: string | null;
}

/**
 * The proxy scope while a fault runs and after it: a second client's calls belong to its own
 * session, and the primary's session is current again once the fault returns.
 */
export function faultScope(
    prior: ProxyScope,
    f: Pick<FaultEpisode, "type">,
    at: ScenarioEvent | undefined,
): { during: ProxyScope; after: ProxyScope } {
    if (f.type !== "two_hosts_one_daemon" || at === undefined)
        return { during: prior, after: prior };
    return {
        during: { session: `${at.session}-b`, turn: null },
        after: { session: at.session, turn: null },
    };
}

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
export function runIdentity(config: SimConfig, prereg: Preregistration, projects: string[]) {
    return {
        prereg_sha256: preregistrationHash(prereg),
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

/** The eidnara-sim revision and uncommitted-content digest this process runs from. */
export const simIdentity = () => {
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
 * since Node resolves the CLI's dependencies anywhere under it. The interposer, the OpenCode
 * SDK, and the plugin builds are `absent` when not yet built or not installed; preflight builds
 * the interposer first, and a completed build clone holds both plugin builds.
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
        // The plugin builds are ignored outputs, so the checkout's worktree digest omits them.
        pi_plugin: join(config.eidnara_checkout, "packages/pi-plugin/dist"),
        opencode_plugin: join(config.eidnara_checkout, "packages/opencode-plugin/dist"),
        ...(config.upgrade?.opencode_binary
            ? { opencode_upgrade: config.upgrade.opencode_binary }
            : {}),
        ...(config.upgrade?.pi_install ? { pi_upgrade_install: config.upgrade.pi_install } : {}),
    };
    return Object.fromEntries(
        Object.entries(files).map(([name, path]) => {
            const optional =
                name.startsWith("opencode_sdk") || name.endsWith("_plugin") || name === "faketime";
            if (optional && !existsSync(path)) return [name, "absent"];
            if (statSync(path).isDirectory()) return [name, directoryDigest(realpathSync(path))];
            return [name, createHash("sha256").update(readFileSync(path)).digest("hex")];
        }),
    );
}

export interface ArmConfig {
    profile: ArmProfile;
    /** The user-tier `eidnara.jsonc` the arm's host loads, its connection path elided; null without the plugin. */
    eidnara_config: Record<string, unknown> | null;
    /** The configuration the arm's daemon starts with; null without a daemon. */
    daemon_config: Record<string, unknown> | null;
}

/**
 * The configuration each arm runs, as the host stack writes it for the side model the first
 * session uses; a `model_switch` moves later sessions' side model when no side model is fixed.
 */
export function armConfigs(order: readonly string[], sideModel: string): Record<string, ArmConfig> {
    return Object.fromEntries(
        order.map((label) => {
            const profile = armProfile(label);
            const arm = armBase(label);
            return [
                label,
                {
                    profile,
                    eidnara_config: profile.plugin
                        ? eidnaraUserConfig("<connection file>", sideModel, arm)
                        : null,
                    daemon_config: profile.daemon ? fixtureDaemonConfig(sideModel) : null,
                },
            ];
        }),
    );
}

/** Every scheduled fault has a mechanism, and a `model_switch` has a second distinct model. */
export function requireMechanisms(
    faults: FaultEpisode[],
    models: string[],
    supported: (f: FaultEpisode) => boolean = driverSupports,
): void {
    const missing = [...new Set(faults.filter((f) => !supported(f)).map((f) => f.type))];
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
    /** Preflight probes the environment once the build is known to match the audited daemon capabilities. */
    const probe = async (order: readonly string[]) => {
        if (checks) return checks;
        try {
            requireAuditedVariants(o.config.eidnara_checkout, order);
        } catch (caught) {
            throw new HarnessFailure((caught as Error).message);
        }
        return await preflight(o.config, o.out);
    };
    const wanted = {
        tier: o.tier,
        seed: o.seed,
        host: o.host,
        order: armOrder(o),
        events: eventCount(o.events, scenario.events.length),
        context_limit: o.contextLimit ?? 200_000,
        models: o.models ?? [o.config.agent_model],
        fault_override: o.faults === undefined ? null : faultOverride(o.faults, scenario),
        tapes: o.tapes ?? [],
        side_model: o.sideModel ?? null,
        user_sim_model: o.userSimModel ?? preregOf(o).user_sim.model,
        turns_await_jobs: o.turnsAwaitJobs ?? false,
        qualification: qualificationRef(o),
    };
    /** Computed once the inputs it hashes exist: before the probe on a resume, after it on a first run. */
    const digests = () => ({
        scenario_hash: scenario.scenario_hash,
        ...runIdentity(
            o.config,
            preregOf(o),
            scenario.projects.map((p) => p.id),
        ),
    });
    /** Each replay source is a finished run of this seed, scenario, and order, holding every turn. */
    const sources = (
        tapes: string[],
        events: number,
        order: readonly string[],
        faultOverride: FaultEpisode[] | null,
        turnsAwaitJobs: boolean,
    ) =>
        checkTapeSources(tapes, {
            turns_await_jobs: turnsAwaitJobs,
            seed: o.seed,
            scenario_hash: scenario.scenario_hash,
            prereg_sha256: preregistrationHash(preregOf(o)),
            events,
            order,
            fault_override: faultOverride,
            turns: scenario.events
                .slice(0, events)
                .filter((e) => e.kind === "user_turn")
                .map((e) => String(e.id)),
            scripted: new Map(
                scenario.events
                    .filter((e) => e.kind === "user_turn")
                    .map((e) => [String(e.id), String((e as { text?: unknown }).text ?? "")]),
            ),
        });
    if (existsSync(path)) {
        const manifest = readJsonFile<Manifest>(path);
        if (manifest?.schema !== "sim-run-manifest/v3") {
            throw new HarnessFailure(
                `manifest.json schema ${manifest?.schema} is not sim-run-manifest/v3`,
            );
        }
        const fieldProblems = manifestProblems(manifest, scenario.events.length);
        if (fieldProblems.length > 0) {
            throw new HarnessFailure(`manifest.json is malformed: ${fieldProblems.join(", ")}`);
        }
        const order = Array.isArray(manifest.order) ? manifest.order : [];
        const canonical = (() => {
            try {
                return armOrder({
                    tier: o.tier,
                    seed: o.seed,
                    arms: order,
                    qualification: o.qualification,
                });
            } catch {
                return null;
            }
        })();
        if (order.length === 0 || !sameJson(canonical, order)) {
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
            tapes: o.tapes !== undefined,
            side_model: o.sideModel !== undefined,
            user_sim_model: o.userSimModel !== undefined,
            turns_await_jobs: o.turnsAwaitJobs !== undefined,
        };
        // A manifest from before qualifications names none.
        const recorded = { ...manifest, qualification: manifest.qualification ?? null };
        const differs = Object.entries(wanted).filter(
            ([k, v]) => given[k] !== false && !sameJson(recorded[k as keyof Manifest], v),
        );
        if (differs.length > 0) {
            const names = differs.map(([k]) => k).join(", ");
            throw new HarnessFailure(`resume options differ from the manifest: ${names}`);
        }
        const changed = Object.entries({
            ...digests(),
            tape_sha256: tapeDigests(manifest.tapes),
            arms: armConfigs(manifest.order, manifest.side_model ?? manifest.models[0] ?? ""),
        }).filter(([k, v]) => !sameJson(manifest[k as keyof Manifest], v));
        if (changed.length > 0) {
            const names = changed.map(([k]) => k).join(", ");
            throw new HarnessFailure(`inputs changed since the run started: ${names}`);
        }
        checks = await probe(manifest.order);
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
        const upgradeRow = (p: Preflight) => (p.upgrade ?? []).find((h) => h.host === o.host);
        if (!sameJson(upgradeRow(manifest.preflight), upgradeRow(checks))) {
            throw new HarnessFailure(`the ${o.host} upgrade host changed since the run started`);
        }
        // Every host version and install path, the other host's and its upgrade included.
        const drift = preflightDrift(manifest.preflight, checks);
        if (drift.length > 0) {
            throw new HarnessFailure(`${drift.join(", ")} changed since the run started`);
        }
        if (manifest.fault_override !== null) {
            if (!Array.isArray(manifest.fault_override)) {
                throw new HarnessFailure("manifest.json fault_override is not an array");
            }
            validateEpisodes(manifest.fault_override, scenario, "manifest.json fault_override");
        }
        requireMechanisms(manifest.fault_override ?? scenario.faults, manifest.models);
        // A resume checks the sources against the run it continues, whose event count and arm
        // order the manifest holds whether or not this invocation restates them.
        sources(
            manifest.tapes,
            manifest.events,
            manifest.order,
            manifest.fault_override,
            manifest.turns_await_jobs,
        );
        const preflightLog = join(o.out, "preflight.jsonl");
        dropCutTail(preflightLog);
        appendFileSync(preflightLog, `${JSON.stringify(checks)}\n`);
        return { manifest, checks };
    }
    requireMechanisms(wanted.fault_override ?? scenario.faults, wanted.models);
    sources(
        wanted.tapes,
        wanted.events,
        wanted.order,
        wanted.fault_override,
        wanted.turns_await_jobs,
    );
    checks = await probe(wanted.order);
    const manifest: Manifest = {
        schema: "sim-run-manifest/v3",
        ...wanted,
        ...digests(),
        arms: armConfigs(wanted.order, wanted.side_model ?? wanted.models[0] ?? ""),
        tape_sha256: tapeDigests(wanted.tapes),
        base_wall_ms: Date.now(),
        price_table: PRICE_TABLE,
        preflight: checks,
    };
    writeAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
    return { manifest, checks };
}

interface Stop {
    reason: string | null;
    /** Every driver call in flight; a signal teardown waits for them up to `SIGNAL_GRACE_MS`. */
    active: Set<Promise<unknown>>;
    /** Resolves once `reason` is set, so a blocked driver call stops waiting after the grace. */
    raised: Promise<void>;
    raise: () => void;
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
    if (o.config.upgrade?.pi_install) {
        requireOutsideCheckout(o.out, o.config.upgrade.pi_install, "the upgrade Pi install");
    }
    requireOutsideIdentity(o.out);
    requirePinnedPath(o.config);
    mkdirSync(o.out, { recursive: true });
    requirePlainArtifacts(o.out, [...registeredArms(o), ...(o.arms ?? [])]);
    const lease = takeLease(o.out);
    const cleanup: Array<() => Promise<void> | void> = [() => releaseLease(o.out, lease)];
    let done: Promise<void> | null = null;
    const teardown = () => {
        done ??= runSteps(cleanup.splice(0));
        return done;
    };
    let raise = () => undefined as void;
    const raised = new Promise<void>((done) => {
        raise = done;
    });
    const stop: Stop = { reason: null, active: new Set(), raised, raise };
    const onSignal = (signal: NodeJS.Signals) => {
        if (done) return;
        stop.reason ??= `signal ${signal}`;
        stop.raise();
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

export class CallIndex {
    private readonly places = new Map<string, Array<[number, number]>>();

    /**
     * `onRecord` receives each complete record already in the log, in log order. `strict` also
     * refuses a record with missing fields or a seq other than its line position.
     */
    constructor(
        private readonly path: string,
        onRecord?: (record: CallRecord) => void,
        strict = false,
    ) {
        requireAppendable(path);
        if (!existsSync(path)) return;
        let position = 0;
        const parse = (line: Buffer): CallRecord => {
            const corrupt = (why: string) =>
                new HarnessFailure(`${path} line ${position + 1} is corrupt: ${why}`);
            let value: unknown;
            try {
                value = JSON.parse(line.toString("utf8"));
            } catch {
                throw corrupt("not JSON");
            }
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
                throw corrupt("not an object");
            }
            const record = value as CallRecord;
            if (strict) {
                const problems = recordProblems(record);
                if (problems.length > 0) throw corrupt(problems.join(", "));
                if (record.seq !== position) {
                    throw corrupt(`seq ${record.seq} at position ${position}`);
                }
            }
            position++;
            return record;
        };
        const fd = openSync(path, "r");
        try {
            const size = fstatSync(fd).size;
            const chunk = Buffer.alloc(1 << 20);
            let offset = 0;
            let lineStart = 0;
            let carry = Buffer.alloc(0);
            while (offset < size) {
                const read = readSync(fd, chunk, 0, chunk.length, offset);
                let buf =
                    carry.length > 0
                        ? Buffer.concat([carry, chunk.subarray(0, read)])
                        : chunk.subarray(0, read);
                let base = lineStart;
                let at = buf.indexOf(0x0a);
                while (at !== -1) {
                    const record = parse(buf.subarray(0, at));
                    this.remember(record, base, at + 1);
                    onRecord?.(record);
                    base += at + 1;
                    buf = buf.subarray(at + 1);
                    at = buf.indexOf(0x0a);
                }
                carry = Buffer.from(buf);
                lineStart = base;
                offset += read;
            }
        } finally {
            closeSync(fd);
        }
    }

    private remember(record: CallRecord, offset: number, length: number): void {
        const key = `${record.arm}/${record.session}`;
        const list = this.places.get(key);
        if (list) list.push([offset, length]);
        else this.places.set(key, [[offset, length]]);
    }

    add(record: CallRecord, offset: number, length: number): void {
        this.remember(record, offset, length);
    }

    records(arm: string, session: string): CallRecord[] {
        const places = this.places.get(`${arm}/${session}`) ?? [];
        if (places.length === 0) return [];
        const fd = openSync(this.path, "r");
        try {
            return places.map(([offset, length]) => {
                const buf = Buffer.alloc(length);
                readSync(fd, buf, 0, length, offset);
                return JSON.parse(buf.toString("utf8").trimEnd()) as CallRecord;
            });
        } finally {
            closeSync(fd);
        }
    }
}

export function projectCall(r: CallRecord): Omit<CallView, "turn_index"> {
    return {
        seq: r.seq,
        arm: r.arm,
        session: r.session ?? "",
        component: r.component,
        turn: r.turn,
        scenario_ms: r.scenario_ms,
        status: r.status,
        error: r.error,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_write_tokens,
        ...(r.response_text !== undefined ? { response_text: r.response_text } : {}),
        ...(r.response_text_truncated ? { response_text_truncated: true } : {}),
        ...(r.status >= 400 || r.error !== null || r.finish_reason === "stream_cut"
            ? { failed: true }
            : {}),
    };
}

/**
 * A session's proxy calls with its delivered user turns placed among them. A user turn's message
 * opens its turn, so it sits just before the turn's first call, or after the last call recorded
 * by its scenario time when the turn made none. Its `seq` is fractional between the two proxy
 * sequence numbers around it, so the list stays in one increasing order the graders compare.
 */
export function withUserTurns(
    calls: CallView[],
    turns: { event: string; scenario_ms: number; label: string; turn_index?: number }[],
    arm: string,
    session: string,
): CallView[] {
    const placed = turns.map((t) => {
        const first = calls.find((c) => c.turn === t.event);
        const before = calls.filter((c) => c.scenario_ms <= t.scenario_ms).at(-1);
        const after = first ? first.seq - 1 : (before?.seq ?? 0);
        return { t, after };
    });
    const views = placed.map(({ t, after }, i) => {
        const peers = placed.filter((p) => p.after === after);
        const rank = peers.findIndex((p) => p === placed[i]);
        return {
            seq: after + (rank + 1) / (peers.length + 1),
            arm,
            session,
            component: "user-sim",
            turn: t.event,
            ...(t.turn_index === undefined ? {} : { turn_index: t.turn_index }),
            scenario_ms: t.scenario_ms,
            status: 200,
            error: null,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            label: t.label,
            // The entry comes from the journal, not from a proxy call record.
            journal: true,
        } satisfies CallView;
    });
    return [...calls, ...views].sort((a, b) => a.seq - b.seq);
}

export function callsOf(
    index: CallIndex,
    arm: string,
    session: string,
    turnIndex: Map<string, number>,
): CallView[] {
    let turn: number | undefined;
    return index.records(arm, session).map((r) => {
        const own = r.origin_turn ?? r.turn;
        const at = own ? turnIndex.get(own) : undefined;
        // A background call credited to an earlier turn takes that turn's index without moving
        // the running index later calls without a turn take.
        if (r.origin_turn !== undefined && at !== undefined) {
            const view = projectCall(r);
            return { ...view, turn_index: at };
        }
        turn = at ?? turn;
        const view = projectCall(r);
        return turn === undefined ? view : { ...view, turn_index: turn };
    });
}

async function runArms(
    o: RunOptions,
    cleanup: Array<() => Promise<void> | void>,
    stop: Stop,
): Promise<void> {
    const guard = () => {
        if (stop.reason) throw new HarnessFailure(`run stopping: ${stop.reason}`);
    };
    /**
     * Each driver call runs between two stop checks and is recorded while in flight. A call still
     * blocked `SIGNAL_GRACE_MS` after a stop is raised is abandoned: the failure reaches teardown,
     * which stops the drivers and their process trees, so the tier budget ends the run.
     */
    const tracked = async <T>(call: () => Promise<T>): Promise<T> => {
        guard();
        const active = call();
        stop.active.add(active);
        const abandoned = stop.raised
            .then(() => Bun.sleep(SIGNAL_GRACE_MS))
            .then(() => {
                throw new HarnessFailure(
                    `run stopping: ${stop.reason}; a driver call is still blocked`,
                );
            });
        try {
            const result = await Promise.race([active, abandoned]);
            guard();
            return result;
        } finally {
            stop.active.delete(active);
            active.catch(() => undefined);
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
                stop.raise();
            }
        };
        const timer = setTimeout(() => {
            holds.delete(timer);
            try {
                sampler.sample();
            } catch (caught) {
                samplerFailure ??= caught;
                stop.reason ??= `sampler failed: ${(caught as Error).message}`;
                stop.raise();
            } finally {
                end();
            }
        }, POST_TURN_SAMPLE_MS);
        holds.set(timer, end);
    };
    const { config, seed } = o;
    const prereg = preregOf(o);
    const wallBudgetMs = prereg.liveness_bounds.tier_wall_budget_ms;
    const budget = setTimeout(() => {
        stop.reason ??= `tier wall budget of ${wallBudgetMs} ms exhausted`;
        stop.raise();
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
        requireFreshArmRoots(o.out, [...registeredArms(o), ...(o.arms ?? [])]);
        writeAtomic(
            join(o.out, ATTEMPT),
            `${JSON.stringify({ pid: process.pid, started_wall_ms: Date.now() })}\n`,
        );
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
    requirePlainArtifacts(o.out, manifest.order);
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
    const allEvents: ScenarioEvent[] = scenario.events.map(
        (e) => ({ ...e, id: String(e.id), session: String(e.session) }) as ScenarioEvent,
    );
    const events = allEvents.slice(0, manifest.events);
    const hostRow = manifest.preflight.hosts.find((h) => h.host === o.host);
    if (!hostRow) throw new Error(`preflight lists no ${o.host} host`);
    const upgradeRow = manifest.preflight.upgrade?.find((h) => h.host === o.host);

    const drivers: Record<string, ArmDriver> = {};
    const samplers = new Map<string, ResourceSampler>();
    const proxyFaults = scenario.faults.filter((f) => f.seam.layer === "proxy-sink");
    const injector = new FaultInjector(proxyFaults, new Rng((seed ^ 0x5bd1e995) >>> 0), 120_000);
    const callsPath = join(o.out, "calls.jsonl");
    const agentText = new Map<string, AgentReply>();
    /** Each arm's call records by component, for the capability check at its finish. */
    const components = new Map<string, Record<string, number>>();
    // A background call received after a turn began and before that turn's first agent answer
    // came from the turn before it, so the record names that turn as its origin. A resume reads
    // both from the call log and the journal.
    const answered = new Set<string>();
    const precedingTurn = new Map<string, string>();
    const eventSession = new Map(allEvents.map((e) => [e.id, String(e.session)]));
    for (const e of journal.entries) {
        if (e.kind !== "EndTurn" || typeof e.arm !== "string") continue;
        const session = eventSession.get(String(e.event));
        if (session !== undefined) precedingTurn.set(`${e.arm}/${session}`, String(e.event));
    }
    const noteAgent = (r: CallRecord) => {
        const replied = r.status === 200 && r.error === null && r.finish_reason !== "stream_cut";
        if (r.component === "agent" && r.turn !== null && replied) {
            answered.add(`${r.arm}/${r.turn}`);
        }
        const reply = agentReplyOf(r);
        if (reply) agentText.set(`${r.arm}/${r.session}`, reply);
        const counts = components.get(r.arm) ?? {};
        counts[r.component] = (counts[r.component] ?? 0) + 1;
        components.set(r.arm, counts);
    };
    const prior: Pick<
        CallRecord,
        "arm" | "component" | "fault_ref" | "proxy_retries" | "seq" | "started_wall_ms" | "arrival"
    >[] = [];
    let firstArrival = 0;
    const callIndex = new CallIndex(
        callsPath,
        (r) => {
            noteAgent(r);
            firstArrival = Math.max(firstArrival, (r.arrival ?? r.seq) + 1);
            const { arm, component, fault_ref, proxy_retries, seq, started_wall_ms, arrival } = r;
            prior.push({ arm, component, fault_ref, proxy_retries, seq, started_wall_ms, arrival });
        },
        true,
    );
    for (const r of prior.sort(restoreOrder)) injector.restoreRecord(r as CallRecord);
    prior.length = 0;
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
    for (const log of ["downstream.jsonl", "tape.jsonl", "pairing.jsonl"]) {
        dropCutTail(join(o.out, log));
    }
    const pairing = new Pairing(
        join(o.out, "pairing.jsonl"),
        referenceArm(manifest.order),
        manifest.tapes.map((t) => join(dirname(t), "pairing.jsonl")),
    );
    const scheduler = new Scheduler({
        events,
        faults: scenario.faults,
        journal,
        order: manifest.order,
        turnsAwaitJobs: manifest.turns_await_jobs,
        drivers: drivers as Record<string, ArmDriver>,
        proxy: injector,
        idleLimitMs: prereg.liveness_bounds.job_deadline_ms,
        onClock: (arm, ms) => writeOffset(offsetFile(arm), manifest.base_wall_ms, ms),
        armSummary: (arm) => {
            const turns = userTurns(arm).map((e) => ({
                session: String(e.session),
                label: e.label as Label,
            }));
            return realisedRates(turns, prereg);
        },
        // The pairing log holds the turn's user record ahead of the prompt, so a turn a kill
        // interrupted mid-prompt keeps its label and delivery in the journal.
        recoverTurn: (event: string): Record<string, unknown> | undefined => {
            const arm: string | null = scheduler.currentArm;
            const r = pairing.records.find(
                (x) => x.kind === "turn" && x.arm === arm && x.event === event,
            );
            return r?.kind === "turn"
                ? { session: r.session, label: r.label, delivered: r.delivered }
                : undefined;
        },
        stopped: () => stop.reason,
        onArmReady: (arm) => {
            const sampler = samplers.get(arm);
            if (sampler) holdForCpu(sampler, arm);
        },
        verify: async (point) => {
            const ending = scheduler.currentArm;
            if (point === "EndArm" && ending !== null) verifyArm(ending, join(o.out, ending, "r"));
            if (point === "EndRun") await gateway.stop();
            handlersFailed();
            if (samplerFailure !== null) throw samplerFailure;
            if (point === "EndRun") writeWitnesses();
        },
    });
    const now = () => scheduler.clock?.now() ?? 0;
    const scope = { arm: "", session: null as string | null, turn: null as string | null };
    const origin = (): string | null => {
        if (scope.turn !== null && answered.has(`${scope.arm}/${scope.turn}`)) return scope.turn;
        return precedingTurn.get(`${scope.arm}/${scope.session}`) ?? scope.turn;
    };
    let jobSeq = journal.entries.filter((e) => e.kind === "RegisterJob").length;
    class RunRecords extends RecordWriter {
        override write(partial: Omit<CallRecord, "seq" | "wall_ms">): CallRecord {
            const record = super.write(partial);
            noteAgent(record);
            return record;
        }

        protected override placed(record: CallRecord, offset: number, length: number): void {
            callIndex.add(record, offset, length);
        }
    }
    // The diagnostics file is opened once without following symlinks, like a child's log.
    const downstreamFd = openSync(
        join(o.out, "downstream.jsonl"),
        fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW,
    );
    const requests = new RequestStore(join(o.out, "requests.jsonl"));
    const gateway = new Gateway({
        upstream: bedrockUpstream(config.bedrock.region, config.bedrock.aws_profile),
        records: new RunRecords(callsPath, { resume: true, retain: false }),
        injector,
        rng: new Rng((seed ^ 0x27d4eb2f) >>> 0),
        clock: { scenarioMs: now },
        scope: () => ({ ...scope, origin: origin() }),
        requests,
        downstream: (e) => {
            // The sink runs inside an HTTP/2 event listener; a failed write ends the run through
            // its signal path rather than escaping as an uncaught exception.
            try {
                writeSync(downstreamFd, `${JSON.stringify(e)}\n`);
            } catch (caught) {
                console.error(`downstream.jsonl: ${(caught as Error).message}`);
                process.kill(process.pid, "SIGTERM");
            }
        },
        arrival: () => {
            if (scope.arm === "" || scheduler.runningArm() !== scope.arm) return;
            const id = `request-${jobSeq++}`;
            scheduler.jobStart(id);
            return () => scheduler.jobEnd(id);
        },
        observe: (e) => {
            if (scheduler.runningArm() !== scope.arm) return;
            scheduler.observe(e.component);
            const id = `${e.component}-${jobSeq++}`;
            scheduler.jobStart(id);
            return () => scheduler.jobEnd(id);
        },
        requestDeadlineMs: prereg.liveness_bounds.turn_deadline_ms,
        firstArrival,
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
        requests.close();
        writeWitnesses();
        handlersFailed();
    });

    const projects = Object.fromEntries(
        scenario.projects.map((p) => [p.id, join(ROOT, "corpus/repos", p.id)]),
    );
    const loopStore = scenario.faults.some((f) => f.type === "store_full");
    const turnIndex = new Map(
        events.filter((e) => e.index !== undefined).map((e) => [e.id, e.index as number]),
    );
    const scripted = scenario.events.filter((e) => e.kind === "user_turn") as {
        id: string;
        session: string;
        index: number;
        role: string;
        text: string;
        paste?: { sample_id: string; bytes: number };
    }[];
    // Pinning reads the whole scenario, so a shorter `--events` run labels its prefix the way
    // a full run of the seed does.
    const pinned = pinnedTurns(allEvents, scenario.faults);
    const tape = new Tape(join(o.out, "tape.jsonl"), manifest.tapes);
    // Both loaders have read the sources; the bytes they read must be the ones the manifest
    // attests.
    if (!sameJson(tapeDigests(manifest.tapes), manifest.tape_sha256)) {
        throw new HarnessFailure("replay sources changed since the manifest hashed them");
    }
    const userSim = new UserSim({
        seed,
        plan: behaviourPlan(scripted, prereg, seed, pinned),
        tape,
        pairing,
        llm: proxyUserSim(
            gateway.urls[0] as string,
            manifest.user_sim_model ?? prereg.user_sim.model,
            prereg.user_sim.max_tokens,
            prereg.liveness_bounds.turn_deadline_ms,
        ),
        normalise: normaliser(prereg.divergence_policy.normalisation),
        keys: [
            ...scenario.facts.flatMap((f) => [f.id, f.template]),
            ...scenario.probes.map((p) => p.id),
        ],
        facts: scenario.facts.flatMap((f) => [f.statement, ...f.cues]),
    });
    const scriptedById = new Map(scripted.map((t) => [t.id, t]));
    const eventOrder = new Map(allEvents.map((e, i) => [e.id, i]));
    const oracle = (arm: string) => deliveryOf(armProfile(arm)) === "oracle-context";
    const backgrounds = manifest.order.some(oracle)
        ? oracleBackgrounds(scenario, [
              ...scenario.facts.flatMap((f) => [f.id, f.template]),
              ...scenario.probes.map((p) => p.id),
          ])
        : new Map<string, string>();
    const startOf = new Map(
        scenario.events
            .filter((e) => e.kind === "session_start")
            .map((e) => [String(e.session), e.id]),
    );
    const sessionOf = new Map(scenario.events.map((e) => [e.id, String(e.session)]));
    const deletions = new Map<string, { probe: string; fact: string; statement: string }[]>();
    for (const c of scenario.cf_deletions ?? []) {
        const before = String(c.before_event);
        const at = startOf.get(sessionOf.get(before) ?? "") ?? before;
        const fact = String(c.fact);
        const statement = scenario.facts.find((f) => f.id === fact)?.statement ?? "";
        deletions.set(at, [...(deletions.get(at) ?? []), { probe: c.probe, fact, statement }]);
    }
    const othersOf = (fact: string) =>
        scenario.facts.filter((f) => f.id !== fact).map((f) => f.statement);
    if (manifest.order.some((a) => armBase(a) === "eidnara-cf") && !Bun.which("python3")) {
        throw new HarnessFailure(
            "the eidnara-cf arm deletes through python3, which is not on PATH",
        );
    }
    const journaled = (kind: string) => journal.entries.some((e) => e.kind === kind);
    if (deletions.size > 0 && journaled("StartRun") && !journaled("CounterfactualSample")) {
        throw new HarnessFailure(
            "this run started before its counterfactual sample was journaled; start it afresh",
        );
    }
    if (deletions.size > 0 && !journaled("StartRun")) {
        journal.append({
            kind: "CounterfactualSample",
            arm: null,
            scenario_ms: 0,
            sample: (scenario.cf_deletions ?? []).map((c) => ({
                probe: c.probe,
                fact: String(c.fact),
                before_event: String(c.before_event),
            })),
        });
    }
    const userTurns = (arm: string, session?: string) =>
        deliveredTurns(journal.entries, arm, session);
    // Each session's own plugin boots, read from the log's length when its host started: a
    // plugin that disabled itself, booted in another mode than the arm declares, or left no boot
    // stops the run at the session that shows it.
    // A session still open when the arm ends (an `--events` prefix can stop inside one) is checked
    // before `EndArm`.
    const sessionMark = new Map<string, number>();
    const unchecked = new Set<string>();
    const markSession = (arm: string, armRoot: string) => {
        sessionMark.set(arm, logLength(join(armRoot, "eidnara.log")));
        unchecked.add(arm);
    };
    const requireBoots = (arm: string, armRoot: string) => {
        unchecked.delete(arm);
        const boots = readPluginLog(join(armRoot, "eidnara.log"), sessionMark.get(arm) ?? 0);
        const wrong = bootMismatches(armProfile(arm), boots);
        if (wrong.length > 0) {
            throw new HarnessFailure(`arm ${arm} capability mismatch: ${wrong.join("; ")}`);
        }
    };
    // The arm's evidence against its profile, written whole once its finish and every job it
    // started have ended, before `EndArm`; a mismatch leaves the arm open, so the run is not
    // complete evidence and a resume checks the same evidence again.
    const verifyArm = (arm: string, armRoot: string) => {
        if (unchecked.has(arm)) requireBoots(arm, armRoot);
        const observed = observeArm(arm, o.host, armRoot, components.get(arm) ?? {});
        const mode = deliveryOf(armProfile(arm));
        if (manifest.order.some(oracle) || mode === "explicit-search") {
            // A recovered row says what the user-sim decided; the host may or may not have the turn.
            const turns = journal.entries.filter(
                (t) => t.kind === "UserTurn" && t.arm === arm && t.delivered === true,
            );
            const notes: ExpectedNote[] = oracle(arm)
                ? turns.flatMap((t) => {
                      const event = String(t.event);
                      const background = backgrounds.get(event);
                      const text = scriptedById.get(event)?.text;
                      if (!background || text === undefined) return [];
                      const owed = t.recovered !== true;
                      return [{ event, session: String(t.session), background, text, owed }];
                  })
                : [];
            const parts = new RequestPartLog(join(o.out, "requests.jsonl"));
            try {
                observed.delivery = observeDelivery(
                    readJsonl<CallRecord>(callsPath).filter((c) => c.arm === arm),
                    parts,
                    notes,
                    eventOrder,
                );
            } finally {
                parts.close();
            }
        }
        const mismatches = armMismatches(observed);
        const record = { profile: armProfile(arm), observed, mismatches };
        writeAtomic(join(o.out, arm, "capabilities.json"), `${JSON.stringify(record, null, 2)}\n`);
        if (mismatches.length > 0) {
            throw new HarnessFailure(`arm ${arm} capability mismatch: ${mismatches.join("; ")}`);
        }
    };
    // The call index replays every record through `noteAgent` when it opens, so a resume holds
    // each session's last agent reply.
    const lastAgent = (arm: string, session: string): AgentReply =>
        agentText.get(`${arm}/${session}`) ?? { text: "" };
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
            ...(manifest.side_model ? { sideModel: manifest.side_model } : {}),
            turnDeadlineMs: prereg.liveness_bounds.turn_deadline_ms,
            transcriptPaths: hostRow.transcript_paths,
            hostVersions: {
                from: hostRow.version,
                to: upgradeRow?.version ?? null,
                ...(upgradeRow ? { upgradeTranscriptPaths: upgradeRow.transcript_paths } : {}),
            },
            loopStore,
            onDaemonExit: (detail) => scheduler.daemonExited(detail),
            sampleDaemon: () => sampler.observe(),
            callsFor: (session) => {
                handlersFailed();
                const calls = callsOf(callIndex, arm, session, turnIndex).filter(
                    (c) => c.component !== "user-sim",
                );
                const began = beganAt(journal.entries, arm);
                const turns = userTurns(arm, session).map((e) => {
                    const index = turnIndex.get(String(e.event));
                    return {
                        event: String(e.event),
                        // The user's text reached the agent when the turn began; the journal
                        // row that carries the label is appended after the turn ends.
                        scenario_ms: began.get(String(e.event)) ?? e.scenario_ms,
                        label: String(e.label),
                        ...(index === undefined ? {} : { turn_index: index }),
                    };
                });
                return withUserTurns(calls, turns, arm, session);
            },
            settle: () => scheduler.quiesceJobs(),
            now,
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
                stop.raise();
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
            resume: (open, interrupted) =>
                tracked(async () => {
                    scope.arm = arm;
                    scope.session = open?.session ?? null;
                    if (open) markSession(arm, armRoot);
                    await driver.resume(open, interrupted);
                    sampler.start();
                }),
            event: (e) =>
                tracked(async () => {
                    scope.arm = arm;
                    scope.session = e.session;
                    scope.turn = e.kind === "user_turn" ? e.id : null;
                    try {
                        if (e.kind === "session_start") markSession(arm, armRoot);
                        if (e.kind === "session_end") {
                            agentText.delete(`${arm}/${e.session}`);
                            const out = await driver.event(e);
                            requireBoots(arm, armRoot);
                            return out;
                        }
                        if (e.kind !== "user_turn") return await driver.event(e);
                        const turn = scriptedById.get(e.id);
                        if (!turn) throw new HarnessFailure(`${e.id}: no scripted user turn`);
                        // The turn's deadline opened at BeginTurn; the user-sim call and the
                        // host prompt share it.
                        const opened = Date.now();
                        const d = await userSim.deliver(arm, turn, lastAgent(arm, e.session));
                        guard();
                        const user = { session: e.session, label: d.label, delivered: d.delivered };
                        if (!d.delivered) return { user };
                        // An oracle arm's probe turn carries its sources ahead of the user's text;
                        // the pairing log already holds the text the user-sim delivered.
                        const note = oracle(arm) ? backgrounds.get(e.id) : undefined;
                        const out = await driver.event({
                            ...e,
                            text: note && d.label !== "abandon" ? `${note}${d.text}` : d.text,
                            interrupt_ms: d.interruptMs,
                            deadline_ms:
                                prereg.liveness_bounds.turn_deadline_ms - (Date.now() - opened),
                        });
                        guard();
                        const cut = d.label !== "interrupt" || out.user?.interrupted === true;
                        const label = cut ? d.label : "task";
                        const scheduled = cut ? {} : { scheduled: "interrupt" };
                        // A turn the host never received counts as undelivered, whatever the
                        // user-sim decided.
                        const delivered = d.delivered && !out.undelivered;
                        return {
                            ...out,
                            user: { ...user, ...out.user, label, delivered, ...scheduled },
                        };
                    } finally {
                        scope.turn = null;
                        if (e.kind === "user_turn") precedingTurn.set(`${arm}/${e.session}`, e.id);
                        if (e.kind === "user_turn") holdForCpu(sampler, arm);
                    }
                }),
            prepare: (e, log, done) =>
                tracked(async () => {
                    if (armBase(arm) !== "eidnara-cf") return;
                    for (const c of deletions.get(e.id) ?? []) {
                        if (done(c.probe)) continue;
                        // The note ids a deletion targets are journaled before it runs, so a
                        // resumed run deletes the same notes rather than planning anew.
                        const planned = journal.entries
                            .filter(
                                (x) =>
                                    x.kind === "DeleteMemoryObject" &&
                                    x.arm === arm &&
                                    x.target_item_id === c.probe,
                            )
                            .map((x) => Number(x.object_id));
                        const result = await driver.deleteFact(c.statement, othersOf(c.fact), {
                            ...(planned.length ? { planned } : {}),
                            onPlanned: (ids) => {
                                for (const id of ids) {
                                    journal.append({
                                        kind: "DeleteMemoryObject",
                                        arm,
                                        scenario_ms: now(),
                                        object_id: id,
                                        object_kind: "note",
                                        target_item_id: c.probe,
                                        fact: c.fact,
                                        event: e.id,
                                    });
                                }
                            },
                        });
                        // A stop that landed during the deletion leaves its result unjournaled,
                        // so the resumed run completes the planned deletion.
                        guard();
                        log({ probe: c.probe, fact: c.fact, ...result });
                    }
                }),
            fault: (f, at) =>
                tracked(async () => {
                    const prior = { session: scope.session, turn: scope.turn };
                    const scopes = faultScope(prior, f, at);
                    Object.assign(scope, scopes.during);
                    try {
                        return await driver.fault(f, at);
                    } finally {
                        Object.assign(scope, scopes.after);
                    }
                }),
            supports: (f) => driver.supports(f),
            reap: () => tracked(() => driver.reap()),
            finish: () =>
                tracked(async () => {
                    // The sampler's stop can fail the run; the arm still finishes and its checks land.
                    let stopped: unknown = null;
                    try {
                        if (driver.daemon && driver.daemonPid() === null) {
                            scheduler.daemonExited({ after: "last event" });
                        }
                        sampler.stop();
                    } catch (caught) {
                        stopped = caught;
                    }
                    const last = await driver.finish();
                    if (stopped) throw stopped;
                    return last;
                }),
        };
    }
    await scheduler.run();
    handlersFailed();
    if (samplerFailure !== null) throw samplerFailure;
}
