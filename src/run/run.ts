import { createHash } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    writeFileSync,
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
import { type Component, RecordWriter, readRecords } from "../proxy/records";
import { Rng } from "../rng";
import { compileScenario, type Scenario } from "../scenario/compile";
import { type FaultEpisode, SEAMS, validateFault } from "../scenario/faults";
import { loadCompileInput, loadPrereg } from "../scenario/inputs";
import { bedrockEmbedder } from "../scenario/similarity";
import { Journal, releaseLease, takeLease } from "./journal";
import { plainPath } from "./launcher";
import { type Preflight, piCli, preflight } from "./preflight";
import { ResourceSampler } from "./sampler";
import { type ArmDriver, HarnessFailure, type ScenarioEvent, Scheduler } from "./scheduler";
import { writeOffset } from "./timeinject";

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

const BACKGROUND = new Set<Component>([
    "history_summarizer",
    "memory_capture",
    "memory_classifier",
    "context_researcher",
    "title",
    "native_compaction",
]);

const ROOT = resolve(import.meta.dir, "../..");

export function pinnedBin(config: SimConfig): string {
    return resolve(dirname(config.opencode_binary), "../../.bin");
}

export function requirePinnedPath(config: SimConfig): void {
    const bin = pinnedBin(config);
    if (!(process.env.PATH ?? "").split(":").includes(bin)) {
        throw new HarnessFailure(
            `PATH lacks the pinned OpenCode release; run with PATH=${bin}:$PATH`,
        );
    }
}

const realExisting = (path: string): string => {
    let probe = path;
    while (!existsSync(probe)) probe = dirname(probe);
    return join(realpathSync(probe), path.slice(probe.length));
};

const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

const ARTIFACTS = [
    "lease.json",
    "journal.jsonl",
    "scenario.json",
    "manifest.json",
    "preflight.jsonl",
    "calls.jsonl",
    "faults.jsonl",
];

/**
 * Every run artifact the harness appends to or replaces is a regular file or absent, so a
 * symlink planted in an accepted output directory cannot redirect a write elsewhere.
 */
export function requirePlainArtifacts(out: string, arms: readonly string[]): void {
    const perArm = arms.flatMap((arm) => [
        arm,
        join(arm, "resources.jsonl"),
        join(arm, "clock"),
        join(arm, "clock", "offset"),
        join(arm, "state.json"),
    ]);
    for (const rel of [...ARTIFACTS, ...perArm]) {
        const path = join(out, rel);
        if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
            throw new HarnessFailure(`${path} is a symlink; run artifacts must be regular files`);
        }
    }
}

/**
 * Run outputs and the Eidnara checkout stay disjoint, by resolved path: arm resets delete output
 * subtrees, and an output directory above the checkout would derive an arm root inside it.
 */
export function requireOutsideCheckout(out: string, checkout: string): void {
    const dir = realExisting(resolve(checkout));
    const target = realExisting(resolve(out));
    if (within(target, dir) || within(dir, target)) {
        throw new HarnessFailure(`--out ${out} overlaps the Eidnara checkout ${checkout}`);
    }
}

function writeAtomic(path: string, text: string): void {
    writeFileSync(`${path}.${process.pid}`, text);
    renameSync(`${path}.${process.pid}`, path);
}

function git(dir: string, args: string[]): string {
    const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
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
        hash.update(`\0${file}\0`);
        const stat = lstatSync(join(dir, file), { throwIfNoEntry: false });
        if (stat?.isFile()) hash.update(readFileSync(join(dir, file)));
    }
    return { commit: gitHead(dir), worktree: hash.digest("hex") };
}

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
    const scenario = JSON.parse(readFileSync(path, "utf8")) as Scenario;
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
    return scenario;
}

const STRATEGIES = new Set(["single", "burst", "intermittent", "persistent"]);

/** The field problems of one `--faults` episode, before the compiler's trigger and seam checks. */
function episodeProblems(value: unknown): string[] {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return ["not an object"];
    const e = value as Record<string, unknown>;
    const problems: string[] = [];
    if (typeof e.id !== "string" || e.id === "") problems.push("id missing");
    if (typeof e.type !== "string" || !(e.type in SEAMS)) problems.push(`type ${e.type} unknown`);
    if (!STRATEGIES.has(e.strategy as string)) problems.push(`strategy ${e.strategy} unknown`);
    const trigger = e.trigger as Record<string, unknown> | null;
    if (typeof trigger !== "object" || trigger === null || typeof trigger.kind !== "string") {
        problems.push("trigger missing");
    }
    const params = e.params as Record<string, unknown> | null;
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
        problems.push("params missing");
    } else if (Object.values(params).some((v) => typeof v !== "number" || !Number.isFinite(v))) {
        problems.push("params must be finite numbers");
    }
    if (typeof e.seam !== "object" || e.seam === null) problems.push("seam missing");
    return problems;
}

/** A `--faults` override is an array of complete episodes, each valid against the compiled scenario. */
export function faultOverride(raw: unknown, scenario: Scenario): FaultEpisode[] {
    if (!Array.isArray(raw)) throw new HarnessFailure("--faults must hold an array of episodes");
    const turns = new Map(scenario.sessions.map((x) => [x.id, x.requests]));
    const ids = new Set<string>();
    raw.forEach((value, i) => {
        const problems = episodeProblems(value);
        if (problems.length > 0) {
            throw new HarnessFailure(`--faults episode ${i} is malformed: ${problems.join(", ")}`);
        }
        const episode = value as FaultEpisode;
        if (ids.has(episode.id)) throw new HarnessFailure(`--faults: duplicate id ${episode.id}`);
        ids.add(episode.id);
        try {
            validateFault(episode, turns);
        } catch (caught) {
            throw new HarnessFailure(`--faults: ${(caught as Error).message}`);
        }
    });
    return raw as FaultEpisode[];
}

function armOrder(o: RunOptions): ArmName[] {
    const prereg = loadPrereg(o.tier);
    const index = prereg.seeds.indexOf(o.seed);
    if (index < 0) throw new HarnessFailure(`seed ${o.seed} is not pre-registered for ${o.tier}`);
    const order = prereg.arms.order_by_seed[index] ?? prereg.arms.run;
    const unknown = (o.arms ?? []).filter((a) => !order.includes(a));
    if (unknown.length > 0) throw new HarnessFailure(`arms not in the ${o.tier} order: ${unknown}`);
    const kept = order.filter((a) => !o.arms || o.arms.includes(a)) as ArmName[];
    if (kept.length === 0) throw new HarnessFailure("no arm to run");
    return kept;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const simIdentity = () => {
    const { commit, worktree } = treeIdentity(ROOT);
    return { sim_commit: commit, sim_worktree: worktree };
};

function binaryDigests(config: SimConfig): Record<string, string> {
    const files = {
        daemon: config.daemon_binary,
        opencode: config.opencode_binary,
        pi: piCli(config),
    };
    return Object.fromEntries(
        Object.entries(files).map(([name, path]) => [
            name,
            createHash("sha256").update(readFileSync(path)).digest("hex"),
        ]),
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
    checks ??= await preflight(o.config, o.out);
    const wanted = {
        tier: o.tier,
        seed: o.seed,
        host: o.host,
        order: armOrder(o),
        events: o.events ?? scenario.events.length,
        context_limit: o.contextLimit ?? 200_000,
        models: o.models ?? [o.config.agent_model],
        fault_override: o.faults === undefined ? null : faultOverride(o.faults, scenario),
    };
    requireMechanisms(wanted.fault_override ?? scenario.faults, wanted.models);
    const digests = {
        scenario_hash: scenario.scenario_hash,
        prereg_sha256: preregistrationHash(loadPrereg(o.tier)),
        eidnara_commit: gitHead(o.config.eidnara_checkout),
        ...simIdentity(),
        binaries: binaryDigests(o.config),
    };
    if (existsSync(path)) {
        const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
        const known = new Set<string>(loadPrereg(o.tier).arms.run);
        const foreign = (Array.isArray(manifest.order) ? manifest.order : []).filter(
            (a) => typeof a !== "string" || !known.has(a),
        );
        if (!Array.isArray(manifest.order) || foreign.length > 0) {
            throw new HarnessFailure(`manifest.json names arms outside the ${o.tier} order`);
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
        const changed = Object.entries(digests).filter(
            ([k, v]) => !sameJson(manifest[k as keyof Manifest], v),
        );
        if (changed.length > 0) {
            const names = changed.map(([k]) => k).join(", ");
            throw new HarnessFailure(`inputs changed since the run started: ${names}`);
        }
        const intercepted = (p: Preflight) => p.time_injection.map((t) => [t.name, t.intercepted]);
        if (!sameJson(intercepted(manifest.preflight), intercepted(checks))) {
            throw new HarnessFailure("time interception changed since the run started");
        }
        const hostRow = (p: Preflight) => p.hosts.find((h) => h.host === o.host);
        if (!sameJson(hostRow(manifest.preflight), hostRow(checks))) {
            throw new HarnessFailure(`the ${o.host} host changed since the run started`);
        }
        appendFileSync(join(o.out, "preflight.jsonl"), `${JSON.stringify(checks)}\n`);
        return { manifest, checks };
    }
    const manifest: Manifest = {
        schema: "sim-run-manifest/v1",
        ...wanted,
        ...digests,
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
    requireOutsideCheckout(o.out, o.config.eidnara_checkout);
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
    const { config, seed } = o;
    const prereg = loadPrereg(o.tier);
    const wallBudgetMs = prereg.liveness_bounds.tier_wall_budget_ms;
    const budget = setTimeout(() => {
        stop.reason ??= `tier wall budget of ${wallBudgetMs} ms exhausted`;
    }, wallBudgetMs);
    budget.unref();
    cleanup.push(() => clearTimeout(budget));
    const journal = new Journal(join(o.out, "journal.jsonl"));
    cleanup.push(() => journal.close());
    const compiled = await loadScenario(o);
    const { manifest, checks } = await loadManifest(o, compiled);
    if (journal.entries.some((e) => e.kind === "EndRun")) {
        throw new HarnessFailure(`${o.out} holds a completed run; its journal ends with EndRun`);
    }
    journal.append({
        kind: "Preflight",
        arm: null,
        scenario_ms: 0,
        time_injection: checks.time_injection,
        hosts: checks.hosts,
    });
    const scenario = { ...compiled, faults: manifest.fault_override ?? compiled.faults };
    const events = scenario.events.slice(0, manifest.events) as unknown as ScenarioEvent[];
    const hostRow = manifest.preflight.hosts.find((h) => h.host === o.host);
    if (!hostRow) throw new Error(`preflight lists no ${o.host} host`);

    const drivers: Partial<Record<ArmName, ArmDriver>> = {};
    const proxyFaults = scenario.faults.filter((f) => f.seam.layer === "proxy-sink");
    const injector = new FaultInjector(proxyFaults, new Rng((seed ^ 0x5bd1e995) >>> 0), 120_000);
    const callsPath = join(o.out, "calls.jsonl");
    injector.restore(readRecords(callsPath));
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
        verify: () => {
            handlersFailed();
            if (samplerFailure !== null) throw samplerFailure;
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
            if (scope.turn !== null || scope.arm === "") return;
            const id = `request-${jobSeq++}`;
            scheduler.jobStart(id);
            return () => scheduler.jobEnd(id);
        },
        observe: (e) => {
            const driver = drivers[scope.arm as ArmName];
            if (driver) scheduler.observe(e.component, driver);
            if (!BACKGROUND.has(e.component)) return;
            const id = `${e.component}-${jobSeq++}`;
            scheduler.jobStart(id);
            return () => scheduler.jobEnd(id);
        },
        requestDeadlineMs: prereg.liveness_bounds.turn_deadline_ms,
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
        const report = manifest.order.flatMap((arm) => injector.report(arm));
        appendFileSync(join(o.out, "faults.jsonl"), `${JSON.stringify(report)}\n`);
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
            launcher: manifest.preflight.launcher,
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
                cpuJob = `daemon-cpu-${arm}-${jobSeq++}`;
                scheduler.jobStart(cpuJob);
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
                        if (e.kind === "user_turn") sampler.sample();
                    }
                }),
            fault: (f) => tracked(() => driver.fault(f)),
            finish: async () => {
                try {
                    if (driver.daemon && driver.daemonPid() === null) {
                        scheduler.daemonExited({ after: "last event" });
                    }
                    sampler.stop();
                } finally {
                    await driver.finish();
                }
            },
        };
    }
    await scheduler.run();
    handlersFailed();
    if (samplerFailure !== null) throw samplerFailure;
}
