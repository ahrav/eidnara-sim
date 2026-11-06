import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SimConfig } from "../config/config";
import type { CallView } from "../grade/artefacts";
import type { HostContext, SimHost } from "../hosts/arms";
import { HostDriver } from "../hosts/driver";
import type { ConverseBody } from "../proxy/classify";
import { bedrockUpstream, Gateway, type Upstream } from "../proxy/gateway";
import { FaultInjector } from "../proxy/inject";
import { type CallRecord, RecordWriter } from "../proxy/records";
import { RequestStore } from "../proxy/requests";
import { Rng } from "../rng";
import { projectCall } from "../run/run";
import type { ScenarioEvent } from "../run/scheduler";
import { writeOffset } from "../run/timeinject";
import { type Applied, TRANSFORMED, type TransformInputs, transformFor } from "./transforms";

export interface TurnSpec {
    config: SimConfig;
    out: string;
    armDir: string;
    arm: string;
    host: "pi";
    launcher: string;
    hostVersion: string;
    transcriptPaths: string[];
    baseMs: number;
    models: string[];
    contextLimit: number;
    sideModel: string | null;
    turnDeadlineMs: number;
    project: string;
    corpus: string;
    sessionStart: ScenarioEvent;
    probe: ScenarioEvent;
    beginMs: number;
    priorCalls: CallView[];
    variant: string;
    inputs: TransformInputs;
    settleQuietMs: number;
    settleMaxMs: number;
}

export interface Application extends Applied {
    index: number;
    before_sha256: string;
}

export interface TurnResult {
    outcome: Record<string, unknown>;
    records: CallRecord[];
    applications: Application[];
    first_request: ConverseBody | null;
    failures: string[];
    notes: string[];
    prompt_scenario_ms: number | null;
}

export interface TurnSeams {
    upstream?: Upstream;
    hostFactory?: (ctx: HostContext) => SimHost;
}

const sha = (body: unknown) =>
    new Bun.CryptoHasher("sha256").update(JSON.stringify(body)).digest("hex");

function sameDir(a: string, b: string): boolean {
    const x = statSync(a, { throwIfNoEntry: false });
    const y = statSync(b, { throwIfNoEntry: false });
    return !!x?.isDirectory() && !!y && x.dev === y.dev && x.ino === y.ino;
}

export async function runTurn(spec: TurnSpec, seams: TurnSeams = {}): Promise<TurnResult> {
    const prepared = join(spec.out, spec.arm);
    if (!sameDir(spec.armDir, prepared)) {
        throw new Error(`${spec.armDir} is not the prepared arm directory ${prepared}`);
    }
    const transform = transformFor(spec.variant);
    const scope = {
        arm: spec.arm,
        session: spec.sessionStart.session,
        turn: null as string | null,
    };
    const applications: Application[] = [];
    const failures: string[] = [];
    const notes: string[] = [];
    const thrown = new Set<unknown>();
    let first: ConverseBody | null = null;
    let active = 0;
    let quietSince = Date.now();
    const hold = () => {
        active++;
        return () => {
            active--;
            quietSince = Date.now();
        };
    };
    const records = new RecordWriter(join(spec.out, "calls.jsonl"), { retain: true });
    const requests = new RequestStore(join(spec.out, "requests.jsonl"));
    const started = Date.now();
    const now = () => spec.beginMs + (Date.now() - started);
    const gateway = new Gateway({
        upstream:
            seams.upstream ??
            bedrockUpstream(spec.config.bedrock.region, spec.config.bedrock.aws_profile),
        records,
        injector: new FaultInjector([], new Rng(1), 1_000),
        rng: new Rng(2),
        clock: { scenarioMs: now },
        scope: () => ({ ...scope }),
        requests,
        arrival: hold,
        observe: hold,
        transform: (body, component, at) => {
            if (component !== TRANSFORMED || at.turn !== spec.probe.id) return;
            const index = applications.length;
            const before = sha(body);
            if (first === null) first = structuredClone(body);
            const copy = structuredClone(body);
            try {
                const applied = transform.apply(copy, spec.inputs);
                for (const key of Object.keys(body)) delete body[key];
                Object.assign(body, copy);
                applications.push({ index, before_sha256: before, ...applied });
            } catch (caught) {
                thrown.add(caught);
                applications.push({ index, before_sha256: before, changed: false, detail: {} });
                failures.push(`transform ${transform.id}: ${(caught as Error).message}`);
                throw caught;
            }
        },
    });
    await gateway.start();
    const turnIndex = typeof spec.probe.index === "number" ? spec.probe.index : undefined;
    const base = Math.floor(Math.max(0, ...spec.priorCalls.map((c) => c.seq)));
    const callsFor = (): CallView[] => {
        const own = records.records.map((r) => ({
            ...projectCall(r),
            seq: base + 1 + r.seq,
            ...(turnIndex === undefined ? {} : { turn_index: turnIndex }),
        }));
        return [...spec.priorCalls, ...own];
    };
    const settle = async () => {
        const until = Date.now() + spec.settleMaxMs;
        while (Date.now() < until) {
            if (active === 0 && Date.now() - quietSince >= spec.settleQuietMs) return;
            await Bun.sleep(200);
        }
        notes.push(
            `background calls still active at the snapshot, ${spec.settleMaxMs} ms after the turn`,
        );
    };
    const armRoot = join(spec.armDir, "r");
    const clockDir = join(spec.armDir, "clock");
    const offsetFile = join(clockDir, "offset");
    mkdirSync(clockDir, { recursive: true });
    writeOffset(offsetFile, spec.baseMs, spec.beginMs);
    const driver = new HostDriver({
        config: spec.config,
        arm: spec.arm,
        host: spec.host,
        armRoot,
        launcher: spec.launcher,
        offsetFile,
        baseMs: spec.baseMs,
        keep: [armRoot, clockDir],
        proxyHttp1: gateway.urls[0] as string,
        proxyHttp2: gateway.urls[1] as string,
        projects: { [spec.project]: spec.corpus },
        models: spec.models,
        contextLimit: spec.contextLimit,
        ...(spec.sideModel ? { sideModel: spec.sideModel } : {}),
        turnDeadlineMs: spec.turnDeadlineMs,
        transcriptPaths: spec.transcriptPaths,
        hostVersions: { from: spec.hostVersion, to: null },
        loopStore: false,
        onDaemonExit: (detail) => failures.push(`daemon exited: ${JSON.stringify(detail)}`),
        callsFor,
        settle,
        now,
        ...(seams.hostFactory ? { hostFactory: seams.hostFactory } : {}),
    });
    let outcome: Record<string, unknown> = {};
    let promptMs: number | null = null;
    try {
        await driver.resume(spec.sessionStart);
        scope.turn = spec.probe.id;
        promptMs = now();
        try {
            outcome = { ...(await driver.event(spec.probe)) };
        } finally {
            scope.turn = null;
        }
        if (typeof outcome.failed === "string") notes.push(`turn failed: ${outcome.failed}`);
    } catch (caught) {
        failures.push(`turn: ${(caught as Error).message}`);
    } finally {
        try {
            await driver.stop();
        } catch (caught) {
            failures.push(`stop: ${(caught as Error).message}`);
        }
        await gateway.stop();
        records.close();
        requests.close();
    }
    for (const f of gateway.failures) if (!thrown.has(f)) failures.push(`proxy: ${f.message}`);
    const result: TurnResult = {
        outcome,
        records: records.records,
        applications,
        first_request: first,
        failures,
        notes,
        prompt_scenario_ms: promptMs,
    };
    writeFileSync(join(spec.out, "turn.json"), `${JSON.stringify(result)}\n`);
    return result;
}
