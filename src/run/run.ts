import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SimConfig } from "../config/config";
import type { CallView } from "../grade/artefacts";
import { armBase } from "../hosts/arms";
import { HostDriver } from "../hosts/driver";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import type { Tier } from "../prereg/schema";
import { preregistrationHash } from "../prereg/validate";
import { bedrockUpstream, Gateway } from "../proxy/gateway";
import { FaultInjector } from "../proxy/inject";
import { type CallRecord, type Component, RecordWriter } from "../proxy/records";
import { Rng } from "../rng";
import { compileScenario, GENERATOR_VERSION, type Scenario } from "../scenario/compile";
import type { FaultEpisode } from "../scenario/faults";
import {
    compileInputsHash,
    corpusManifestHash,
    loadCompileInput,
    loadPrereg,
} from "../scenario/inputs";
import { bedrockEmbedder } from "../scenario/similarity";
import { behaviourPlan, type Label, realisedRates } from "../usersim/plan";
import { normaliser, Pairing, proxyUserSim, Tape, UserSim } from "../usersim/usersim";
import { Journal, releaseLease, takeLease } from "./journal";
import { plainPath } from "./launcher";
import { type Preflight, preflight, preflightDrift } from "./preflight";
import { PRICE_TABLE, type PriceTable } from "./price";
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
    faults?: FaultEpisode[];
    contextLimit?: number;
    models?: string[];
    /** Earlier runs' user-sim tapes to replay from. */
    tapes?: string[];
    /** Eidnara's side-call model, for a model-factor run. */
    sideModel?: string;
    /** The user-sim model in place of the pre-registered one, for a user-sim variant run. */
    userSimModel?: string;
}

interface Manifest {
    schema: "sim-run-manifest/v1";
    tier: Tier;
    seed: number;
    host: "pi" | "opencode";
    order: string[];
    events: number;
    context_limit: number;
    models: string[];
    scenario_hash: string;
    eidnara_commit: string;
    fault_override: FaultEpisode[] | null;
    tapes: string[];
    side_model: string | null;
    user_sim_model: string;
    /** By tape path, the sha256 of the sibling pairing log as the run began. */
    tape_pairing_sha256: Record<string, string>;
    prereg_sha256: string;
    base_wall_ms: number;
    /** The rates the cost panel prices this run's calls at, fixed when the run starts. */
    price_table: PriceTable;
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

/** Writes `text` beside `path` and renames it in, so a reader sees the whole file or none. */
export function writeAtomic(path: string, text: string): void {
    writeFileSync(`${path}.${process.pid}`, text);
    renameSync(`${path}.${process.pid}`, path);
}

function gitHead(dir: string): string {
    const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"], { stdout: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git rev-parse HEAD in ${dir} failed`);
    return r.stdout.toString().trim();
}

/**
 * `items` supplies L's resized paired-item count per probe type. A tier that pre-registers
 * resizing compiles only with that count.
 */
export async function loadScenario(
    o: Pick<RunOptions, "config" | "tier" | "seed" | "out">,
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
        const embedder = bedrockEmbedder(aws_profile, region, cache);
        const input = loadCompileInput(o.seed, o.tier, embedder);
        const compiled = await compileScenario(items === undefined ? input : { ...input, items });
        writeAtomic(path, `${canonicalJson(compiled)}\n`);
    }
    const scenario = JSON.parse(readFileSync(path, "utf8")) as Scenario;
    const { scenario_hash, ...body } = scenario;
    if (sha256Hex(canonicalJson(body)) !== scenario_hash) {
        throw new HarnessFailure(`${path} hashes to other than its scenario_hash`);
    }
    const { seed, tier } = scenario.manifest as { seed: number; tier: string };
    if (seed !== o.seed || tier !== o.tier) {
        throw new HarnessFailure(
            `scenario.json is ${tier} seed ${seed}, not ${o.tier} seed ${o.seed}`,
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
    // A run with a manifest keeps the scenario it ran; a new run takes only a scenario compiled
    // from the current generator, corpus, and pre-registration.
    if (!existsSync(join(o.out, "manifest.json"))) {
        const current: Record<string, string> = {
            generator_version: GENERATOR_VERSION,
            corpus_manifest_sha256: corpusManifestHash(),
            compile_inputs_sha256: compileInputsHash(),
            prereg_sha256: preregistrationHash(loadPrereg(o.tier)),
        };
        const manifest = scenario.manifest as Record<string, unknown>;
        const stale = Object.keys(current).filter((k) => manifest[k] !== current[k]);
        if (stale.length > 0) {
            throw new HarnessFailure(
                `${path} was compiled from other inputs (${stale.join(", ")}); remove it to recompile`,
            );
        }
    }
    return scenario;
}

/**
 * The seed's pre-registered order, kept to `--arms`. An A/A control label `<arm>~<tag>` runs
 * right after its arm when the tier pre-registers the `[arm, arm]` pair.
 */
export function armOrder(o: Pick<RunOptions, "tier" | "seed" | "arms">): string[] {
    const prereg = loadPrereg(o.tier);
    const index = prereg.seeds.indexOf(o.seed);
    if (index < 0) throw new HarnessFailure(`seed ${o.seed} is not pre-registered for ${o.tier}`);
    const order: string[] = prereg.arms.order_by_seed[index] ?? prereg.arms.run;
    const pairs = prereg.aa_controls?.pairs ?? [];
    const control = (a: string) =>
        /^[a-z-]+~[a-z0-9]+$/.test(a) &&
        pairs.some(([x, y]) => x === armBase(a) && y === armBase(a));
    if (new Set(o.arms).size !== (o.arms ?? []).length) {
        throw new HarnessFailure("--arms lists an arm twice");
    }
    const unknown = (o.arms ?? []).filter((a) => !order.includes(a) && !control(a));
    if (unknown.length > 0) throw new HarnessFailure(`arms not in the ${o.tier} order: ${unknown}`);
    const kept = order
        .filter((a) => !o.arms || o.arms.includes(a))
        .flatMap((a) => [a, ...(o.arms ?? []).filter((c) => control(c) && armBase(c) === a)]);
    if ((o.arms ?? []).some((a) => control(a) && !kept.includes(armBase(a)))) {
        throw new HarnessFailure("an A/A control arm runs only beside its arm");
    }
    if (kept.length === 0) throw new HarnessFailure("no arm to run");
    return kept;
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

async function loadManifest(o: RunOptions, scenario: Scenario): Promise<Manifest> {
    const path = join(o.out, "manifest.json");
    const checks = await preflight(o.config, o.out);
    const wanted = {
        tier: o.tier,
        seed: o.seed,
        host: o.host,
        order: armOrder(o),
        events: o.events ?? scenario.events.length,
        context_limit: o.contextLimit ?? 200_000,
        models: o.models ?? [o.config.agent_model],
        fault_override: o.faults ?? null,
        tapes: o.tapes ?? [],
        side_model: o.sideModel ?? null,
        user_sim_model: o.userSimModel ?? loadPrereg(o.tier).user_sim.model,
    };
    // The sibling pairing log of each replayed tape, as it stood when the run began, so the
    // report can tell a source that changed afterwards.
    const tapePairing = Object.fromEntries(
        (o.tapes ?? []).flatMap((t) => {
            const log = join(dirname(t), "pairing.jsonl");
            return existsSync(log) ? [[t, sha256Hex(readFileSync(log, "utf8"))]] : [];
        }),
    );
    if (existsSync(path)) {
        const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
        const given: Record<string, boolean> = {
            order: o.arms !== undefined,
            events: o.events !== undefined,
            context_limit: o.contextLimit !== undefined,
            models: o.models !== undefined,
            fault_override: o.faults !== undefined,
            tapes: o.tapes !== undefined,
            side_model: o.sideModel !== undefined,
            user_sim_model: o.userSimModel !== undefined,
        };
        const differs = Object.entries(wanted).filter(
            ([k, v]) => given[k] !== false && !sameJson(manifest[k as keyof Manifest], v),
        );
        if (differs.length > 0) {
            const names = differs.map(([k]) => k).join(", ");
            throw new HarnessFailure(`resume options differ from the manifest: ${names}`);
        }
        const digests = {
            scenario_hash: scenario.scenario_hash,
            prereg_sha256: preregistrationHash(loadPrereg(o.tier)),
            eidnara_commit: gitHead(o.config.eidnara_checkout),
        };
        const changed = Object.entries(digests).filter(
            ([k, v]) => manifest[k as keyof Manifest] !== v,
        );
        if (changed.length > 0) {
            const names = changed.map(([k]) => k).join(", ");
            throw new HarnessFailure(`inputs changed since the run started: ${names}`);
        }
        const drift = preflightDrift(manifest.preflight, checks);
        if (drift.length > 0) {
            throw new HarnessFailure(`${drift.join(", ")} changed since the run started`);
        }
        appendFileSync(join(o.out, "preflight.jsonl"), `${JSON.stringify(checks)}\n`);
        return manifest;
    }
    const manifest: Manifest = {
        schema: "sim-run-manifest/v1",
        ...wanted,
        scenario_hash: scenario.scenario_hash,
        eidnara_commit: gitHead(o.config.eidnara_checkout),
        prereg_sha256: preregistrationHash(loadPrereg(o.tier)),
        tape_pairing_sha256: tapePairing,
        base_wall_ms: Date.now(),
        price_table: PRICE_TABLE,
        preflight: checks,
    };
    writeAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
}

export async function runTier(o: RunOptions): Promise<void> {
    plainPath(o.out);
    requirePinnedPath(o.config);
    mkdirSync(o.out, { recursive: true });
    takeLease(o.out);
    const cleanup: Array<() => Promise<void> | void> = [() => releaseLease(o.out)];
    let done: Promise<void> | null = null;
    const teardown = () => {
        done ??= (async () => {
            for (const step of cleanup.splice(0).reverse()) {
                try {
                    await step();
                } catch (caught) {
                    console.error(caught);
                }
            }
        })();
        return done;
    };
    const stop = { signal: null as NodeJS.Signals | null };
    const onSignal = (signal: NodeJS.Signals) => {
        if (stop.signal) return;
        stop.signal = signal;
        void teardown().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    try {
        await runArms(o, cleanup, stop);
    } finally {
        await teardown();
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
    }
}

/** Complete lines of calls.jsonl; a cut final line, with no newline after it, is left out. */
const callRecords = (path: string): CallRecord[] =>
    existsSync(path)
        ? readFileSync(path, "utf8")
              .split("\n")
              .slice(0, -1)
              .filter(Boolean)
              .map((line) => JSON.parse(line) as CallRecord)
        : [];

function callsOf(
    path: string,
    arm: string,
    session: string,
    turnIndex: Map<string, number>,
): CallView[] {
    if (!existsSync(path)) return [];
    let index: number | undefined;
    return callRecords(path)
        .filter((r) => r.arm === arm && r.session === session)
        .map((r) => {
            index = (r.turn ? turnIndex.get(r.turn) : undefined) ?? index;
            return {
                seq: r.seq,
                component: r.component,
                turn: r.turn,
                ...(index === undefined ? {} : { turn_index: index }),
                scenario_ms: r.scenario_ms,
                input_tokens: r.input_tokens,
                output_tokens: r.output_tokens,
                ...(r.response_text ? { response_text: r.response_text } : {}),
            };
        });
}

async function runArms(
    o: RunOptions,
    cleanup: Array<() => Promise<void> | void>,
    stop: { signal: NodeJS.Signals | null },
): Promise<void> {
    const guard = () => {
        if (stop.signal) throw new HarnessFailure(`run stopping on ${stop.signal}`);
    };
    const { config, seed } = o;
    const prereg = loadPrereg(o.tier);
    const journal = new Journal(join(o.out, "journal.jsonl"));
    cleanup.push(() => journal.close());
    const compiled = await loadScenario(o);
    const manifest = await loadManifest(o, compiled);
    const scenario = { ...compiled, faults: manifest.fault_override ?? compiled.faults };
    const events = scenario.events.slice(0, manifest.events) as ScenarioEvent[];
    const hostRow = manifest.preflight.hosts.find((h) => h.host === o.host);
    if (!hostRow) throw new Error(`preflight lists no ${o.host} host`);
    const upgradeRow = manifest.preflight.upgrade?.find((h) => h.host === o.host);

    const drivers: Record<string, ArmDriver> = {};
    const proxyFaults = scenario.faults.filter((f) => f.seam.layer === "proxy-sink");
    const injector = new FaultInjector(proxyFaults, new Rng((seed ^ 0x5bd1e995) >>> 0), 120_000);
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
        armSummary: (arm) => {
            const turns = userTurns(arm).map((e) => ({
                session: String(e.session),
                label: e.label as Label,
            }));
            return realisedRates(turns, prereg);
        },
    });
    const now = () => scheduler.clock?.now() ?? 0;
    const scope = { arm: "", session: null as string | null, turn: null as string | null };
    const jobs = new Map<string, string[]>();
    let jobSeq = journal.entries.filter((e) => e.kind === "RegisterJob").length;
    const agentText = new Map<string, string>();
    const noteAgent = (r: CallRecord) => {
        if (r.component === "agent" && r.response_text) {
            agentText.set(`${r.arm}/${r.session}`, r.response_text);
        }
    };
    for (const r of callRecords(join(o.out, "calls.jsonl"))) noteAgent(r);
    class RunRecords extends RecordWriter {
        override write(partial: Omit<CallRecord, "seq" | "wall_ms">): CallRecord {
            const record = super.write(partial);
            noteAgent(record);
            const id = jobs.get(`${record.arm}/${record.component}`)?.shift();
            if (id) scheduler.jobEnd(id);
            return record;
        }
    }
    const gateway = new Gateway({
        upstream: bedrockUpstream(config.bedrock.region, config.bedrock.aws_profile),
        records: new RunRecords(join(o.out, "calls.jsonl")),
        injector,
        rng: new Rng((seed ^ 0x27d4eb2f) >>> 0),
        clock: { scenarioMs: now },
        scope: () => ({ ...scope }),
        downstream: (e) => {
            // The sink runs inside an HTTP/2 event listener; a failed write ends the run through
            // its signal path rather than escaping as an uncaught exception.
            try {
                appendFileSync(join(o.out, "downstream.jsonl"), `${JSON.stringify(e)}\n`);
            } catch (caught) {
                console.error(`downstream.jsonl: ${(caught as Error).message}`);
                process.kill(process.pid, "SIGTERM");
            }
        },
        observe: (e) => {
            const driver = drivers[scope.arm];
            if (driver) scheduler.observe(e.component, driver);
            if (!BACKGROUND.has(e.component)) return;
            const id = `${e.component}-${jobSeq++}`;
            const key = `${scope.arm}/${e.component}`;
            jobs.set(key, [...(jobs.get(key) ?? []), id]);
            scheduler.jobStart(id);
        },
        requestDeadlineMs: prereg.liveness_bounds.turn_deadline_ms,
    });
    await gateway.start();
    cleanup.push(async () => {
        await gateway.stop();
        appendFileSync(join(o.out, "faults.jsonl"), `${JSON.stringify(injector.report())}\n`);
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
    }[];
    const userSim = new UserSim({
        seed,
        plan: behaviourPlan(scripted, prereg, seed),
        tape: new Tape(join(o.out, "tape.jsonl"), manifest.tapes),
        pairing: new Pairing(
            join(o.out, "pairing.jsonl"),
            referenceArm(manifest.order),
            manifest.tapes.map((t) => join(dirname(t), "pairing.jsonl")),
        ),
        llm: proxyUserSim(
            gateway.urls[0] as string,
            manifest.user_sim_model ?? prereg.user_sim.model,
            prereg.user_sim.max_tokens,
        ),
        normalise: normaliser(prereg.divergence_policy.normalisation),
        keys: [
            ...scenario.facts.flatMap((f) => [f.id, f.template]),
            ...scenario.probes.map((p) => p.id),
        ],
    });
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
        journal.entries.filter(
            (e) =>
                e.kind === "UserTurn" &&
                e.arm === arm &&
                e.delivered === true &&
                (session === undefined || e.session === session),
        );
    const lastAgent = (arm: string, session: string) => agentText.get(`${arm}/${session}`) ?? "";
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
            callsFor: (session) => [
                ...callsOf(join(o.out, "calls.jsonl"), arm, session, turnIndex).filter(
                    (c) => c.component !== "user-sim",
                ),
                ...userTurns(arm, session).map((e) => ({
                    seq: e.seq,
                    component: "user-sim",
                    turn: String(e.event),
                    turn_index: turnIndex.get(String(e.event)),
                    scenario_ms: e.scenario_ms,
                    input_tokens: 0,
                    output_tokens: 0,
                    label: String(e.label),
                })),
            ],
            now,
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
        });
        cleanup.push(async () => {
            sampler.stop();
            await driver.stop();
        });
        drivers[arm] = {
            reset: async () => {
                guard();
                scope.arm = arm;
                await driver.reset();
                sampler.start();
            },
            resume: async (open) => {
                guard();
                scope.arm = arm;
                scope.session = open?.session ?? null;
                await driver.resume(open);
                sampler.start();
            },
            event: async (e) => {
                guard();
                scope.arm = arm;
                scope.session = e.session;
                scope.turn = e.kind === "user_turn" ? e.id : null;
                try {
                    if (e.kind !== "user_turn") {
                        const out = await driver.event(e);
                        guard();
                        return out;
                    }
                    const turn = scripted.find((t) => t.id === e.id);
                    if (!turn) throw new HarnessFailure(`${e.id}: no scripted user turn`);
                    const d = await userSim.deliver(arm, turn, lastAgent(arm, e.session));
                    const user = { session: e.session, label: d.label, delivered: d.delivered };
                    if (!d.delivered) return { user };
                    const out = await driver.event({
                        ...e,
                        text: d.text,
                        interrupt_ms: d.interruptMs,
                    });
                    guard();
                    const cut = d.label !== "interrupt" || out.user?.interrupted === true;
                    const label = cut ? d.label : "task";
                    const scheduled = cut ? {} : { scheduled: "interrupt" };
                    return {
                        ...out,
                        user: { ...user, ...out.user, label, ...scheduled },
                    };
                } finally {
                    scope.turn = null;
                }
            },
            prepare: async (e, log, done) => {
                guard();
                if (armBase(arm) !== "eidnara-cf") return;
                for (const c of deletions.get(e.id) ?? []) {
                    if (done(c.probe)) continue;
                    const result = await driver.deleteFact(c.statement, othersOf(c.fact));
                    // A stop that landed during the deletion leaves it unjournaled, so the
                    // resumed run performs it again instead of recording a killed attempt.
                    guard();
                    for (const id of "deleted" in result ? result.deleted : []) {
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
                    log({ probe: c.probe, fact: c.fact, ...result });
                }
            },
            fault: async (f, at) => {
                guard();
                const prior = { session: scope.session, turn: scope.turn };
                const scopes = faultScope(prior, f, at);
                Object.assign(scope, scopes.during);
                try {
                    const evidence = await driver.fault(f, at);
                    guard();
                    return evidence;
                } finally {
                    Object.assign(scope, scopes.after);
                }
            },
            finish: async () => {
                sampler.stop();
                await driver.finish();
            },
        };
    }
    await scheduler.run();
}
