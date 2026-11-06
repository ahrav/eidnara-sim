import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gradeRun } from "../../scripts/grade-run";
import { loadConfig } from "../config/config";
import type { CallView, Snapshot } from "../grade/artefacts";
import { gradeItem } from "../grade/probes";
import type { HostContext, PromptResult, SimHost } from "../hosts/arms";
import { armProfile } from "../hosts/profiles";
import type { ConverseBody } from "../proxy/classify";
import type { Upstream } from "../proxy/gateway";
import { RecordWriter } from "../proxy/records";
import { RequestStore } from "../proxy/requests";
import { projectCall } from "../run/callviews";
import { PRICE_TABLE } from "../run/price";
import { scenarioHash } from "../scenario/compile";
import { loadPrereg } from "../scenario/inputs";
import { projectSources, REPLAY_MANIFEST, replayProbe } from "./replay";
import type { ProbeSource } from "./source";
import { piSessionDir } from "./state";
import { TRANSFORMS } from "./transforms";
import { runTurn } from "./turn";

const CLEAN = new Bun.CryptoHasher("sha256").digest("hex");

const ROOT = resolve(import.meta.dir, "../..");
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "sim-replay-")));
const BASE_MS = 1_793_000_000_000;
const MODEL = "global.anthropic.claude-opus-5-5";
const ARM = "host";

function git(cwd: string, args: string[], env: Record<string, string> = {}) {
    const r = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
            PATH: process.env.PATH ?? "",
            HOME: cwd,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            ...env,
        },
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
}

const PORT = "For the record, the local metrics port is 31411.";
const ALIAS = "The pre-production alias is yonder-yak-52.";
const PASSING = "Where do I point my scraper to read numbers from my dev machine?";
const FAILING = "Which alias should the deploy script aim at for pre-production?";

function request(cwd: string, history: ConverseBody["messages"], text: string): ConverseBody {
    return {
        system: [{ text: `Current working directory: ${cwd}` }],
        messages: [...(history ?? []), { role: "user", content: [{ text }] }],
        toolConfig: { tools: [{ toolSpec: { name: "bash", inputSchema: { json: {} } } }] },
    };
}

class TranscriptHost {
    cwd = "";
    history: NonNullable<ConverseBody["messages"]> = [];
    constructor(readonly ctx: HostContext) {}
    async openSession(cwd: string, session: string) {
        this.cwd = cwd;
        const dir = join(this.ctx.root, "home/.pi/agent/sessions", piSessionDir(cwd));
        const file = readdirSync(dir).find((f) => f.endsWith(`_sim-${session}.jsonl`));
        const lines = readFileSync(join(dir, file as string), "utf8")
            .split("\n")
            .filter(Boolean);
        this.history = lines
            .map((l) => JSON.parse(l))
            .filter((e) => e.type === "message")
            .map((e) => ({
                role: e.message.role,
                content: e.message.content.map((c: { text: string }) => ({ text: c.text })),
            }));
    }
    async prompt(text: string): Promise<PromptResult> {
        const body = request(this.cwd, this.history, text);
        const r = await fetch(`${this.ctx.proxyHttp1}/model/${MODEL}/converse`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
        });
        const answer = (await r.json()) as {
            output: { message: { content: { text: string }[] } };
        };
        this.history.push(
            { role: "user", content: [{ text }] },
            {
                role: "assistant",
                content: [{ text: answer.output.message.content[0]?.text ?? "" }],
            },
        );
        return {};
    }
    async closeSession() {}
    transcriptEnv() {
        return { PI_CODING_AGENT_DIR: join(this.ctx.root, "home/.pi/agent") };
    }
    hostPid() {
        return null;
    }
    hostIdentity() {
        return null;
    }
    drainTools() {
        return [];
    }
}

function recordedModel(recorded: Map<string, string>): Upstream & { bodies: ConverseBody[] } {
    const bodies: ConverseBody[] = [];
    return {
        bodies,
        async converse(_model, body) {
            bodies.push(structuredClone(body));
            const all = JSON.stringify(body.messages);
            const text =
                recorded.get(all) ??
                (all.includes("yonder-yak-52")
                    ? "Aim it at yonder-yak-52."
                    : all.includes("31411")
                      ? "Use port 31411."
                      : "I don't know.");
            const usage = { inputTokens: 100, outputTokens: 10 };
            const message = { role: "assistant", content: [{ text }] };
            return { json: { output: { message }, stopReason: "end_turn", usage } };
        },
    };
}

interface Fixture {
    run: string;
    answers: Map<string, string>;
    sourceSnapshots: Snapshot[];
}

async function sourceRun(over: Record<string, unknown> = {}): Promise<Fixture> {
    const root = tmp();
    const run = join(root, "run");
    const recorded = join(root, "recorded");
    const armDir = join(run, ARM);
    const workspace = join(armDir, "r", "workspaces", "p");
    const recordedWorkspace = join(recorded, ARM, "r", "workspaces", "p");
    mkdirSync(workspace, { recursive: true });
    git(workspace, ["init", "-q", "-b", "main"]);
    writeFileSync(join(workspace, "README.md"), "project p\n");
    git(workspace, ["add", "-A"]);
    const date = `@${Math.floor(BASE_MS / 1000)} +0000`;
    const identity = ["-c", "user.email=sim-user@users.noreply.github.com", "-c", "user.name=s"];
    git(workspace, [...identity, "commit", "-qm", "init"], {
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
    });
    const corpus = git(workspace, ["rev-parse", "HEAD"]);
    copyFileSync(join(workspace, ".git", "config"), join(armDir, "p.gitconfig"));
    const gitDir = join(armDir, "snapshot.git");
    git(root, ["init", "-q", "--bare", gitDir]);
    const env = {
        GIT_DIR: gitDir,
        GIT_WORK_TREE: workspace,
        GIT_INDEX_FILE: join(armDir, "p.index"),
    };
    git(workspace, ["add", "-A"], env);
    const tree = git(workspace, ["write-tree"], env);
    const wall = (ms: number) => BASE_MS + ms;
    const object = join(gitDir, "objects", tree.slice(0, 2), tree.slice(2));
    utimesSync(object, wall(900) / 1000, wall(900) / 1000);
    writeFileSync(
        join(armDir, "snapshot-state.json"),
        JSON.stringify({ session: null, ended: "s-1", starts: { p: tree }, last: {} }),
    );
    writeFileSync(join(armDir, "tools.jsonl"), "");
    const turn = (id: string, ms: number, session: string, index: number, text: string) => ({
        id,
        kind: "user_turn",
        scenario_ms: ms,
        session,
        index,
        text,
    });
    const events: Record<string, unknown>[] = [
        { id: "e-000000", kind: "session_start", scenario_ms: 0, session: "s-0", project: "p" },
        turn("e-000001", 100, "s-0", 0, PORT),
        turn("e-000002", 200, "s-0", 1, ALIAS),
        { id: "e-000003", kind: "session_end", scenario_ms: 300, session: "s-0" },
        { id: "e-000004", kind: "session_start", scenario_ms: 1000, session: "s-1", project: "p" },
        turn("e-000005", 1100, "s-1", 2, "Hello again."),
        { ...turn("e-000006", 2000, "s-1", 3, PASSING), probe: "q-a" },
        { ...turn("e-000007", 3000, "s-1", 4, FAILING), probe: "q-b" },
        { id: "e-000008", kind: "session_end", scenario_ms: 4000, session: "s-1" },
    ];
    const probe = (id: string, event: string, answer: string, source: string) => ({
        id,
        type: "P8",
        fact: null,
        project: "p",
        session: "s-1",
        event,
        text: events.find((e) => e.id === event)?.text,
        check: { answer },
        ground_truth: {
            expect: "answer",
            basis: "instruction",
            present: [[answer]],
            absent: [],
            stale: [],
            supersedes: [],
            sources: [source],
        },
    });
    const scenario = {
        schema: "fixture",
        manifest: { tier: "S", seed: 101 },
        events,
        probes: [
            probe("q-a", "e-000006", "31411", "e-000001"),
            probe("q-b", "e-000007", "yonder-yak-52", "e-000002"),
        ],
        sessions: [
            { id: "s-0", project: "p" },
            { id: "s-1", project: "p" },
        ],
        projects: [{ id: "p" }],
        faults: [],
    };
    const scenarioWithHash = { ...scenario, scenario_hash: scenarioHash(scenario) };
    writeFileSync(join(run, "scenario.json"), JSON.stringify(scenarioWithHash));
    const sessionDir = join(armDir, "r/home/.pi/agent/sessions", piSessionDir(recordedWorkspace));
    mkdirSync(sessionDir, { recursive: true });
    const msg = (role: string, text: string) => ({
        type: "message",
        message: { role, content: [{ type: "text", text }] },
    });
    const transcript = [
        { type: "session", id: "sim-s-1", cwd: recordedWorkspace },
        msg("user", "Hello again."),
        msg("assistant", "Hi."),
        msg("user", PASSING),
        msg("assistant", "Use port 31411."),
        msg("user", FAILING),
        msg("assistant", "I don't know."),
    ];
    const lines = transcript.map((l) => `${JSON.stringify(l)}\n`).join("");
    writeFileSync(join(sessionDir, "t_sim-s-1.jsonl"), lines);
    const records = new RecordWriter(join(run, "calls.jsonl"), { retain: true });
    const requests = new RequestStore(join(run, "requests.jsonl"));
    const answers = new Map<string, string>();
    const history: NonNullable<ConverseBody["messages"]> = [
        { role: "user", content: [{ text: "Hello again." }] },
        { role: "assistant", content: [{ text: "Hi." }] },
    ];
    const journal: Record<string, unknown>[] = [];
    let seq = 0;
    const entry = (kind: string, ms: number, extra: Record<string, unknown> = {}) =>
        journal.push({ kind, arm: ARM, scenario_ms: ms, seq: seq++, wall_ms: wall(ms), ...extra });
    journal.push({
        kind: "StartRun",
        arm: null,
        order: [ARM],
        scenario_ms: 0,
        seq: seq++,
        wall_ms: wall(0),
    });
    entry("StartArm", 0);
    entry("ClockOffset", 0, { offset_s: 0 });
    entry("Event", 1000, { event: "e-000004", outcome: "ok" });
    const snapshots: Snapshot[] = [];
    const held: CallView[] = [];
    for (const [event, text, answer, item, index] of [
        ["e-000006", PASSING, "Use port 31411.", "q-a", 3],
        ["e-000007", FAILING, "I don't know.", "q-b", 4],
    ] as const) {
        const at = events.find((e) => e.id === event)?.scenario_ms as number;
        const body = request(recordedWorkspace, history, text);
        answers.set(JSON.stringify(body.messages), answer);
        entry("BeginTurn", at, { event, probe: item });
        const record = records.write({
            arm: ARM,
            session: "s-1",
            turn: event,
            started_wall_ms: wall(at + 10),
            scenario_ms: at + 10,
            input_tokens: 100,
            output_tokens: 10,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            first_byte_ms: 5,
            proxy_retries: 0,
            fault_ref: null,
            finish_reason: "end_turn",
            error: null,
            component: "agent",
            componentSource: "inferred",
            model: MODEL,
            status: 200,
            request: requests.store(body),
            response_text: answer,
        });
        held.push({ ...projectCall(record), turn_index: index });
        const id = `${ARM}:${item}:${event}`;
        snapshots.push({
            id,
            item,
            arm: ARM,
            session: "s-1",
            turn: event,
            turn_outcome: "ok",
            artefacts: [
                { id: `${id}:diff`, class: "diff", role: "turn", patch: "" },
                { id: `${id}:turn-commands`, class: "command-log", role: "turn", commands: [] },
                {
                    id: `${id}:session-commands`,
                    class: "command-log",
                    role: "session",
                    commands: [],
                },
                { id: `${id}:calls`, class: "proxy-call", calls: [...held] },
            ],
        });
        const ended = { event, outcome: "ok", probe: item, snapshot: id, prompt_ms: 400 };
        entry("EndTurn", at + 500, ended);
        entry("SnapshotArtefacts", at + 501, { item, snapshot: id });
        entry("Event", at + 502, { event, outcome: "ok" });
        history.push(
            { role: "user", content: [{ text }] },
            { role: "assistant", content: [{ text: answer }] },
        );
    }
    records.close();
    requests.close();
    entry("EndArm", 5000);
    journal.push({ kind: "EndRun", arm: null, scenario_ms: 5000, seq: seq++, wall_ms: wall(5000) });
    writeFileSync(
        join(run, "journal.jsonl"),
        journal.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
    const rows = snapshots.map((s) => `${JSON.stringify(s)}\n`).join("");
    writeFileSync(join(armDir, "snapshots.jsonl"), rows);
    const preflight = {
        launcher: join(recorded, "sandbox.sh"),
        time_injection: [],
        distortions: [],
        hosts: [
            {
                host: "pi",
                version: "0.80.2",
                path: "/pi",
                transcript_paths: ["$PI_CODING_AGENT_DIR/sessions"],
            },
        ],
        upgrade: [],
        toolchain: [],
    };
    const manifest = {
        schema: "sim-run-manifest/v3",
        tier: "S",
        seed: 101,
        host: "pi",
        order: [ARM],
        events: events.length,
        context_limit: 200_000,
        models: [MODEL],
        side_model: null,
        base_wall_ms: BASE_MS,
        price_table: PRICE_TABLE,
        sim_commit: git(ROOT, ["rev-parse", "HEAD"]),
        sim_worktree: CLEAN,
        scenario_hash: scenarioWithHash.scenario_hash,
        eidnara_commit: "e".repeat(40),
        corpus: { p: { commit: corpus, worktree: "w" } },
        arms: { [ARM]: { profile: armProfile(ARM) } },
        preflight,
        ...over,
    };
    writeFileSync(join(run, "manifest.json"), JSON.stringify(manifest));
    const capabilities = { profile: armProfile(ARM), observed: { arm: ARM }, mismatches: [] };
    writeFileSync(join(armDir, "capabilities.json"), JSON.stringify(capabilities));
    return { run, answers, sourceSnapshots: snapshots };
}

const matching = (run: string) => () => {
    const m = JSON.parse(readFileSync(join(run, "manifest.json"), "utf8"));
    return { eidnara_commit: m.eidnara_commit, agent_model: MODEL, corpus: m.corpus };
};

const ALLOWED = ["prereg_sha256", "toolchain", "binaries", "bedrock", "arms", "sim"];

async function replay(
    f: Fixture,
    item: string,
    variant: string,
    extra: Record<string, unknown> = {},
) {
    const upstream = recordedModel(f.answers);
    const out = join(tmp(), "out");
    const manifest = JSON.parse(readFileSync(join(f.run, "manifest.json"), "utf8"));
    const results = await replayProbe({
        config: loadConfig(),
        run: f.run,
        arm: ARM,
        item,
        variant,
        repeats: 3,
        out,
        pathMode: "replay",
        allowIdentity: ALLOWED,
        preflight: async () => manifest.preflight,
        identity: matching(f.run),
        settleQuietMs: 0,
        settleMaxMs: 1_000,
        turn: (spec) =>
            runTurn(spec, {
                upstream,
                hostFactory: (ctx) => new TranscriptHost(ctx) as unknown as SimHost,
            }),
        ...extra,
    });
    return { results, out, upstream };
}

describe("replayProbe on a fixture run", () => {
    test("variant a replays a passing item as a pass and a failing item as a fail", async () => {
        const f = await sourceRun();
        const rules = loadPrereg("S").grading;
        const scenario = JSON.parse(readFileSync(join(f.run, "scenario.json"), "utf8"));
        const probeOf = (id: string) => scenario.probes.find((p: { id: string }) => p.id === id);
        const source = f.sourceSnapshots.map((s) => gradeItem(probeOf(s.item), [s], rules));
        expect(source.map((g) => g?.verdict)).toEqual(["pass", "fail"]);
        for (const [item, verdict] of [
            ["q-a", "pass"],
            ["q-b", "fail"],
        ] as const) {
            const { results, upstream } = await replay(f, item, "a");
            expect(results.map((r) => r.verdict)).toEqual([verdict, verdict, verdict]);
            for (const r of results) {
                expect(r.transformed).toBe(0);
                expect(r.agent_calls).toBe(1);
                expect(r.prefix?.fields).toEqual({
                    system: false,
                    messages: true,
                    toolConfig: true,
                });
                expect(r.prefix?.differences[0]).toContain("system[0].text");
            }
            expect(upstream.bodies.length).toBe(3);
        }
    });

    test("variant b puts the ground truth into the forwarded request and flips the failing item", async () => {
        const f = await sourceRun();
        const { results, out, upstream } = await replay(f, "q-b", "b");
        expect(results.map((r) => r.verdict)).toEqual(["pass", "pass", "pass"]);
        expect(results.every((r) => r.transformed === 1)).toBe(true);
        const last = upstream.bodies.at(-1)?.messages?.at(-1)?.content[0]?.text;
        expect(last).toBe(`${FAILING}\n\nNote from earlier sessions:\n- I wrote: ${ALIAS}`);
        const stored = readFileSync(join(out, "r1", "requests.jsonl"), "utf8");
        expect(stored).toContain("Note from earlier sessions");
        const manifest = JSON.parse(readFileSync(join(out, REPLAY_MANIFEST), "utf8"));
        expect(manifest).toMatchObject({
            schema: "sim-replay-manifest/v1",
            kind: "probe-replay",
            arm: ARM,
            item: "q-b",
            variant: { id: "evidence-note", alias: "b" },
            path_mode: "replay",
        });
        expect(manifest.variant.digest).toMatch(/^[0-9a-f]{64}$/);
        expect(manifest.source.dir).toBe(f.run);
        expect(results[0]?.requests[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(results[0]?.cost_usd).toBeCloseTo((100 * 5 + 10 * 25) / 1e6, 9);
        const fidelity = JSON.parse(readFileSync(join(out, "r1", "fidelity.json"), "utf8"));
        expect(fidelity.workspace_files.exact).toBe(true);
        expect(fidelity.transcript.detail).toMatchObject({ kept_entries: 5, dropped_entries: 2 });
        expect(existsSync(join(out, "r1", ARM, "r"))).toBe(false);
    });

    test("a source identity this environment lacks refuses the replay unless overridden", async () => {
        const f = await sourceRun();
        const differ = () => ({ ...matching(f.run)(), eidnara_commit: "f".repeat(40) });
        await expect(replay(f, "q-a", "a", { identity: differ })).rejects.toThrow("eidnara_commit");
        const { results, out } = await replay(f, "q-a", "a", {
            identity: differ,
            allowIdentity: [...ALLOWED, "eidnara_commit"],
        });
        expect(results.length).toBe(3);
        const manifest = JSON.parse(readFileSync(join(out, REPLAY_MANIFEST), "utf8"));
        expect(manifest.identity.drift).toContain("eidnara_commit");
        expect(manifest.identity.refused).toEqual([]);
    });

    test("campaign readers refuse a replay directory", async () => {
        const f = await sourceRun();
        const { out } = await replay(f, "q-a", "a");
        await expect(gradeRun(out, null)).rejects.toThrow("manifest.json");
    });

    test("a transform that throws leaves the host's body and fails the repeat whatever the grade", async () => {
        const f = await sourceRun();
        TRANSFORMS.boom = {
            id: "boom",
            alias: "x",
            summary: "throws after a partial rewrite",
            apply(body) {
                body.system = [{ text: "partly rewritten" }];
                throw new Error("boom");
            },
        };
        try {
            const { results, upstream } = await replay(f, "q-a", "boom");
            expect(results.map((r) => r.verdict)).toEqual([
                "harness-failed",
                "harness-failed",
                "harness-failed",
            ]);
            expect(results[0]?.grade?.verdict).toBe("pass");
            expect(results[0]?.reason).toContain("transform boom: boom");
            expect(upstream.bodies.every((b) => b.system?.[0]?.text !== "partly rewritten")).toBe(
                true,
            );
        } finally {
            delete TRANSFORMS.boom;
        }
    });

    test("a source run recorded from a dirty sim tree is refused unless sim_worktree is allowed", async () => {
        const f = await sourceRun({ sim_worktree: "d".repeat(64) });
        await expect(replay(f, "q-a", "a")).rejects.toThrow("sim_worktree");
        const { results } = await replay(f, "q-a", "a", {
            allowIdentity: [...ALLOWED, "sim_worktree"],
        });
        expect(results.map((r) => r.verdict)).toEqual(["pass", "pass", "pass"]);
    });

    test("an arm label outside the arm and control-label grammar is refused", async () => {
        const f = await sourceRun();
        for (const arm of ["host~/../../x", "../host", "nobody"]) {
            await expect(replay(f, "q-a", "a", { arm })).rejects.toThrow(
                "is not an arm or control label",
            );
        }
    });

    test("campaign gateways carry no transform", () => {
        for (const file of ["src/run/run.ts", "scripts/grade-run.ts"]) {
            const text = readFileSync(join(ROOT, file), "utf8");
            const calls = text.split("new Gateway({").slice(1);
            expect(calls.length).toBeGreaterThan(0);
            for (const call of calls) {
                expect(call.slice(0, call.indexOf("});"))).not.toContain("transform");
            }
        }
    });
});

describe("projectSources", () => {
    test("keeps the sources recorded in the probe's project", () => {
        const source = {
            project: "base-twin",
            probe: { ground_truth: { sources: ["e-1", "e-2", "e-3", "e-9"] } },
            scenario: {
                sessions: [
                    { id: "s-1", project: "base" },
                    { id: "s-2", project: "base-twin" },
                ],
                events: [
                    { id: "e-1", kind: "user_turn", session: "s-1" },
                    { id: "e-2", kind: "user_turn", session: "s-2" },
                    { id: "e-3", kind: "apply_diff", project: "base-twin" },
                ],
            },
        } as unknown as ProbeSource;
        expect(projectSources(source)).toEqual(["e-2", "e-3"]);
    });
});
