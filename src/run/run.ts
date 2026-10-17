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
import type { ArmName } from "../hosts/arms";
import { HostDriver } from "../hosts/driver";
import { canonicalJson } from "../prereg/canonical";
import type { Tier } from "../prereg/schema";
import { preregistrationHash } from "../prereg/validate";
import { bedrockUpstream, Gateway } from "../proxy/gateway";
import { FaultInjector } from "../proxy/inject";
import { type CallRecord, type Component, RecordWriter } from "../proxy/records";
import { Rng } from "../rng";
import { compileScenario, type Scenario } from "../scenario/compile";
import type { FaultEpisode } from "../scenario/faults";
import { loadCompileInput, loadPrereg } from "../scenario/inputs";
import { bedrockEmbedder } from "../scenario/similarity";
import { behaviourPlan, type Label, realisedRates } from "../usersim/plan";
import {
    type AgentReply,
    normaliser,
    Pairing,
    proxyUserSim,
    Tape,
    tapeDigests,
    UserSim,
} from "../usersim/usersim";
import { Journal, readJournal, releaseLease, takeLease } from "./journal";
import { plainPath } from "./launcher";
import { type Preflight, preflight } from "./preflight";
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
}

interface Manifest {
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
    fault_override: FaultEpisode[] | null;
    tapes: string[];
    /** One digest per entry of `tapes`, over the tape and the pairing log beside it. */
    tape_sha256: string[];
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

function writeAtomic(path: string, text: string): void {
    writeFileSync(`${path}.${process.pid}`, text);
    renameSync(`${path}.${process.pid}`, path);
}

function gitHead(dir: string): string {
    const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "HEAD"], { stdout: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git rev-parse HEAD in ${dir} failed`);
    return r.stdout.toString().trim();
}

async function loadScenario(o: RunOptions): Promise<Scenario> {
    const path = join(o.out, "scenario.json");
    if (!existsSync(path)) {
        const { aws_profile, region } = o.config.bedrock;
        const cache = join(ROOT, "runs/scenarios/embeddings.jsonl");
        const embedder = bedrockEmbedder(aws_profile, region, cache);
        const compiled = await compileScenario(loadCompileInput(o.seed, o.tier, embedder));
        writeAtomic(path, `${canonicalJson(compiled)}\n`);
    }
    const scenario = JSON.parse(readFileSync(path, "utf8")) as Scenario;
    const { seed, tier } = scenario.manifest as { seed: number; tier: string };
    if (seed !== o.seed || tier !== o.tier) {
        throw new HarnessFailure(
            `scenario.json is ${tier} seed ${seed}, not ${o.tier} seed ${o.seed}`,
        );
    }
    return scenario;
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
    };
    if (existsSync(path)) {
        const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
        const given: Record<string, boolean> = {
            order: o.arms !== undefined,
            events: o.events !== undefined,
            context_limit: o.contextLimit !== undefined,
            models: o.models !== undefined,
            fault_override: o.faults !== undefined,
            tapes: o.tapes !== undefined,
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
            tape_sha256: tapeDigests(manifest.tapes),
        };
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
        appendFileSync(join(o.out, "preflight.jsonl"), `${JSON.stringify(checks)}\n`);
        return manifest;
    }
    const manifest: Manifest = {
        schema: "sim-run-manifest/v1",
        ...wanted,
        scenario_hash: scenario.scenario_hash,
        eidnara_commit: gitHead(o.config.eidnara_checkout),
        prereg_sha256: preregistrationHash(loadPrereg(o.tier)),
        tape_sha256: tapeDigests(wanted.tapes),
        base_wall_ms: Date.now(),
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

function callsOf(
    path: string,
    arm: string,
    session: string,
    turnIndex: Map<string, number>,
): CallView[] {
    if (!existsSync(path)) return [];
    let index: number | undefined;
    return readJournal(path)
        .map((r) => r as unknown as CallRecord)
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
                ...(r.response_text_truncated ? { response_text_truncated: true } : {}),
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
    const events = scenario.events.slice(0, manifest.events) as unknown as ScenarioEvent[];
    const hostRow = manifest.preflight.hosts.find((h) => h.host === o.host);
    if (!hostRow) throw new Error(`preflight lists no ${o.host} host`);

    const drivers: Partial<Record<ArmName, ArmDriver>> = {};
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
    const agentText = new Map<string, AgentReply>();
    const noteAgent = (r: CallRecord) => {
        if (r.component === "agent" && r.response_text) {
            agentText.set(`${r.arm}/${r.session}`, {
                text: r.response_text,
                ...(r.response_sha256 ? { sha256: r.response_sha256 } : {}),
                ...(r.response_tail ? { tail: r.response_tail } : {}),
            });
        }
    };
    for (const r of readJournal(join(o.out, "calls.jsonl"))) noteAgent(r as unknown as CallRecord);
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
        observe: (e) => {
            const driver = drivers[scope.arm as ArmName];
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
    const scripted = scenario.events.filter((e) => e.kind === "user_turn") as unknown as {
        id: string;
        session: string;
        index: number;
        role: string;
        text: string;
    }[];
    const pinned = new Set(
        scenario.faults.flatMap((f) => {
            const t = f.trigger;
            if (t.kind !== "user_turn") return [];
            const hit = events.find((e) => e.session === t.session && e.index === t.n - 1);
            return hit ? [hit.id] : [];
        }),
    );
    const userSim = new UserSim({
        seed,
        plan: behaviourPlan(scripted, prereg, seed, pinned),
        tape: new Tape(join(o.out, "tape.jsonl"), manifest.tapes),
        pairing: new Pairing(
            join(o.out, "pairing.jsonl"),
            () => manifest.order[0] as string,
            manifest.tapes.map((t) => join(dirname(t), "pairing.jsonl")),
        ),
        llm: proxyUserSim(
            gateway.urls[0] as string,
            prereg.user_sim.model,
            prereg.user_sim.max_tokens,
        ),
        normalise: normaliser(prereg.divergence_policy.normalisation),
        keys: [
            ...scenario.facts.flatMap((f) => [f.id, f.template]),
            ...scenario.probes.map((p) => p.id),
        ],
    });
    const scriptedById = new Map(scripted.map((t) => [t.id, t]));
    const userTurns = (arm: string, session?: string) =>
        journal.entries.filter(
            (e) =>
                e.kind === "UserTurn" &&
                e.arm === arm &&
                e.delivered === true &&
                (session === undefined || e.session === session),
        );
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
            launcher: manifest.preflight.launcher,
            offsetFile: offsetFile(arm),
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
            sampleDaemon: () => sampler.observe(),
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
            settle: () => scheduler.quiesceJobs(),
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
            try {
                sampler.stop();
            } finally {
                await driver.stop();
            }
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
                    if (e.kind !== "user_turn") return await driver.event(e);
                    const turn = scriptedById.get(e.id);
                    if (!turn) throw new HarnessFailure(`${e.id}: no scripted user turn`);
                    const d = await userSim.deliver(arm, turn, lastAgent(arm, e.session));
                    const user = { session: e.session, label: d.label, delivered: d.delivered };
                    if (!d.delivered) return { user };
                    const out = await driver.event({
                        ...e,
                        text: d.text,
                        interrupt_ms: d.interruptMs,
                    });
                    const cut = d.label !== "interrupt" || out.user?.interrupted === true;
                    const label = cut ? d.label : "task";
                    const scheduled = cut ? {} : { scheduled: "interrupt" };
                    return { ...out, user: { ...user, ...out.user, label, ...scheduled } };
                } finally {
                    scope.turn = null;
                }
            },
            fault: (f) => {
                guard();
                return driver.fault(f);
            },
            finish: async () => {
                // The sampler's stop can fail the run; the arm still finishes and its checks land.
                let stopped: unknown = null;
                try {
                    sampler.stop();
                } catch (caught) {
                    stopped = caught;
                }
                const last = await driver.finish();
                if (stopped) throw stopped;
                return last;
            },
        };
    }
    await scheduler.run();
}
