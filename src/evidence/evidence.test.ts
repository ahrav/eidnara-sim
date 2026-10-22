import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceRun } from "../../scripts/evidence-run";
import type { GradeRecord } from "../grade/probes";
import type { ConverseBody } from "../proxy/classify";
import type { CallRecord, Component } from "../proxy/records";
import { partId, type RequestPart, requestParts } from "../proxy/requests";
import type { Entry } from "../run/journal";
import { sessionHealth } from "./health";
import {
    type ArmData,
    type EvidenceScenario,
    loadRun,
    type RunData,
    type StoreObject,
} from "./load";
import { armComparison } from "./report";
import { bodyText, injectedBlocks, type ProbeEvidence, probeEvidence, searchRoute } from "./stages";

const user = (text: string) => ({ role: "user", content: [{ text }] });
const toolUse = (id: string, name: string, input: unknown) => ({
    role: "assistant",
    content: [{ toolUse: { toolUseId: id, name, input } }],
});
const toolResult = (id: string, text: string) => ({
    role: "user",
    content: [{ toolResult: { toolUseId: id, content: [{ text }], status: "success" } }],
});

const SCENARIO: EvidenceScenario = {
    sessions: [
        { id: "s-1", project: "alpha" },
        { id: "s-2", project: "alpha" },
        { id: "s-3", project: "beta" },
    ],
    events: [
        { id: "e-0", kind: "apply_diff", session: "s-1", path: "notes/n.md", content: "use TAG_X" },
        { id: "e-1", kind: "session_start", session: "s-1" },
        { id: "e-2", kind: "user_turn", session: "s-1", text: "Read notes/n.md" },
        { id: "e-3", kind: "session_end", session: "s-1" },
        { id: "e-4", kind: "session_start", session: "s-2" },
        { id: "e-5", kind: "user_turn", session: "s-2", text: "Add the error path.", probe: "q-1" },
        { id: "e-6", kind: "session_end", session: "s-2" },
    ],
    probes: [
        {
            id: "q-1",
            type: "P1",
            event: "e-5",
            session: "s-2",
            project: "alpha",
            text: "Add the error path.",
            ground_truth: {
                expect: "apply",
                present: [["TAG_X"]],
                stale: ["TAG_OLD"],
                sources: ["e-0"],
            },
        },
    ],
};

interface Spec {
    arm?: string;
    memory?: boolean;
    calls?: Array<Partial<CallRecord> & { body?: ConverseBody }>;
    objects?: StoreObject[] | null;
    transcripts?: ArmData["transcripts"];
    tools?: ArmData["tools"];
    journal?: Array<Partial<Entry>>;
    verdict?: string;
    scenario?: EvidenceScenario;
    parts?: boolean;
    limit?: number;
}

const BEGIN_WALL = 10_000;

function build(spec: Spec): RunData {
    const arm = spec.arm ?? "eidnara";
    const parts = new Map<string, RequestPart>();
    const calls: CallRecord[] = (spec.calls ?? []).map((c, seq) => {
        const { body, ...rest } = c;
        const record: CallRecord = {
            seq,
            arm,
            session: "s-2",
            turn: "e-5",
            component: "agent",
            componentSource: "inferred",
            model: "m",
            status: 200,
            finish_reason: "end_turn",
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            started_wall_ms: 0,
            wall_ms: 0,
            scenario_ms: 0,
            first_byte_ms: 1,
            proxy_retries: 0,
            fault_ref: null,
            error: null,
            ...rest,
        };
        if (body && spec.parts !== false) {
            const split = requestParts(body);
            for (const p of split) parts.set(partId(p), p);
            record.request = { sha256: "0".repeat(64), bytes: 1, parts: split.map(partId) };
        }
        return record;
    });
    const journal: Entry[] = (
        spec.journal ?? [
            { kind: "Event", event: "e-0", outcome: "ok" },
            { kind: "Event", event: "e-2", outcome: "ok" },
            { kind: "BeginTurn", event: "e-5", wall_ms: BEGIN_WALL },
            { kind: "EndTurn", event: "e-5", outcome: "ok", prompt_ms: 900 },
        ]
    ).map((e, seq) => ({ arm, scenario_ms: 0, wall_ms: 0, ...e, seq }) as Entry);
    const grade: GradeRecord = {
        item: "q-1",
        arm,
        probe_type: "P1",
        version: 1,
        snapshot: `${arm}:q-1:e-5`,
        inputs: [],
        later_attempts_logged: 0,
        verdict: (spec.verdict ?? "fail") as GradeRecord["verdict"],
        metrics: {},
    };
    return {
        dir: "/run",
        host: "pi",
        contextLimit: spec.limit ?? 200_000,
        scenario: spec.scenario ?? SCENARIO,
        journal,
        calls,
        parts: spec.parts === false ? null : parts,
        grades: [grade],
        arms: new Map([
            [
                arm,
                {
                    arm,
                    profile: { plugin: spec.memory ?? arm !== "host" },
                    tools: spec.tools ?? [],
                    transcripts: spec.transcripts ?? new Map(),
                    pluginLog: [],
                    objects: spec.objects === undefined ? [] : spec.objects,
                    captures: [
                        {
                            session: "s-1",
                            project: "KEY_A",
                            created_ms: 1,
                            committed_ms: 2,
                            abandoned_ms: null,
                        },
                    ],
                },
            ],
        ]),
    };
}

const evidence = (r: RunData): ProbeEvidence => {
    const [g] = r.grades;
    return probeEvidence(r, g?.arm as string, g as GradeRecord, sessionHealth(r));
};
const stage = (p: ProbeEvidence, name: string) => p.stages.find((s) => s.stage === name);

const SOURCE_READ = {
    session: "s-1",
    turn: "e-2",
    body: {
        messages: [
            user("Read notes/n.md"),
            toolUse("t0", "bash", {}),
            toolResult("t0", "use TAG_X"),
        ],
    },
};
const CAPTURED = {
    session: "s-1",
    turn: "e-2",
    component: "memory_capture" as Component,
    body: {
        system: [{ text: "Extract durable project memory" }],
        messages: [user("note says use TAG_X")],
    },
};
const STORED: StoreObject = {
    store: "kernel",
    id: "decision:1",
    text: '{"summary":"error strings use TAG_X"}',
    scope: "project:KEY_A",
    created_ms: 5_000,
    retired_ms: null,
    superseded_by: null,
};
const searchTurn = (result: string) => ({
    body: {
        messages: [
            user("Add the error path."),
            toolUse("t1", "eidnara_search", { query: "error tag" }),
            toolResult("t1", result),
        ],
    },
});

describe("evidence stages on a memory arm", () => {
    test("every stage holds and the grade failed: the item is an application failure", () => {
        const p = evidence(
            build({
                calls: [SOURCE_READ, CAPTURED, searchTurn("1. error strings use TAG_X")],
                objects: [STORED],
            }),
        );
        expect(p.stages.map((s) => `${s.stage}:${s.status}`)).toEqual([
            "source:ok",
            "persisted:ok",
            "eligibility:ok",
            "retrieval:ok",
            "delivery:ok",
            "application:failed",
        ]);
        expect(p.attributed.cause).toBe("application");
        expect(stage(p, "retrieval")?.detail?.ranks).toEqual([
            { source: "eidnara_search", line: 1 },
        ]);
        expect(stage(p, "persisted")?.pointers[0]).toEqual({
            path: "eidnara/final-store/kernel.sqlite",
            at: "decision:1",
        });
    });

    test("a passing grade attributes nothing", () => {
        const p = evidence(build({ calls: [SOURCE_READ], verdict: "pass" }));
        expect(p.attributed).toEqual({ cause: "none", status: "ok", reason: "passed" });
    });

    test("a source event the arm never delivered is unavailable evidence", () => {
        const p = evidence(
            build({
                calls: [searchTurn("nothing")],
                journal: [{ kind: "BeginTurn", event: "e-5", wall_ms: BEGIN_WALL }],
            }),
        );
        expect(p.attributed).toMatchObject({ cause: "source", status: "unavailable" });
        expect(p.attributed.reason).toContain("e-0");
    });

    test("a source the model never read fails the source stage", () => {
        const unread = { ...SOURCE_READ, body: { messages: [user("Read notes/n.md")] } };
        const p = evidence(build({ calls: [unread, searchTurn("nothing")] }));
        expect(p.attributed).toMatchObject({ cause: "source", status: "failed" });
    });

    test("observed but neither captured nor stored fails the source stage", () => {
        const p = evidence(build({ calls: [SOURCE_READ, searchTurn("nothing")] }));
        expect(p.attributed.cause).toBe("source");
        expect(p.attributed.reason).toContain("no capture");
    });

    test("a memory written only after the probe began fails persistence", () => {
        const late = { ...STORED, created_ms: BEGIN_WALL + 1 };
        const p = evidence(
            build({ calls: [SOURCE_READ, CAPTURED, searchTurn("nothing")], objects: [late] }),
        );
        expect(p.attributed).toMatchObject({ cause: "persisted", status: "failed" });
        expect(p.attributed.reason).toContain("after the probe turn began");
    });

    test("the daemon clock offset moves the probe time before comparing store times", () => {
        const late = { ...STORED, created_ms: BEGIN_WALL + 1 };
        const r = build({
            calls: [SOURCE_READ, CAPTURED, searchTurn("TAG_X")],
            objects: [late],
            journal: [
                { kind: "Event", event: "e-0", outcome: "ok" },
                { kind: "ClockOffset", offset_s: 5, offset_settled_ms: 1 },
                { kind: "BeginTurn", event: "e-5", wall_ms: BEGIN_WALL },
            ],
        });
        expect(stage(evidence(r), "persisted")?.status).toBe("ok");
    });

    test("a memory scoped to another project fails eligibility", () => {
        const other = { ...STORED, scope: "project:KEY_B" };
        const p = evidence(
            build({ calls: [SOURCE_READ, CAPTURED, searchTurn("nothing")], objects: [other] }),
        );
        expect(p.attributed).toMatchObject({ cause: "eligibility", status: "failed" });
        expect(p.attributed.reason).toContain("another project");
    });

    test("a superseded memory fails eligibility", () => {
        const old = { ...STORED, superseded_by: "decision:2" };
        const next = { ...STORED, id: "decision:2", text: "unrelated", created_ms: 6_000 };
        const p = evidence(
            build({ calls: [SOURCE_READ, CAPTURED, searchTurn("nothing")], objects: [old, next] }),
        );
        expect(p.attributed.cause).toBe("eligibility");
    });

    test("a successor written after the probe began leaves the memory eligible", () => {
        const old = { ...STORED, superseded_by: "decision:2", retired_ms: BEGIN_WALL + 5 };
        const next = { ...STORED, id: "decision:2", created_ms: BEGIN_WALL + 5 };
        const p = evidence(
            build({ calls: [SOURCE_READ, CAPTURED, searchTurn("nothing")], objects: [old, next] }),
        );
        expect(stage(p, "eligibility")?.status).toBe("ok");
        expect(p.attributed.cause).toBe("retrieval");
    });

    test("a search whose results miss the literal fails retrieval and records its route", () => {
        const legacy =
            "the fused search route is unavailable (query route disabled); results come from the legacy snapshot scan\n1. unrelated";
        const p = evidence(
            build({ calls: [SOURCE_READ, CAPTURED, searchTurn(legacy)], objects: [STORED] }),
        );
        expect(p.attributed).toMatchObject({ cause: "retrieval", status: "failed" });
        expect(p.probe_time.searches).toEqual([
            expect.objectContaining({
                tool: "eidnara_search",
                route: "legacy-scan",
                fallback: "query route disabled",
                delivered: true,
            }),
        ]);
    });

    test("a result the tool returned but the request never carried fails delivery", () => {
        const transcripts = new Map([
            [
                "t1",
                {
                    file: "/t.jsonl",
                    toolCallId: "t1",
                    toolName: "eidnara_search",
                    text: "1. TAG_X",
                    isError: false,
                },
            ],
        ]);
        const p = evidence(
            build({
                calls: [SOURCE_READ, CAPTURED, searchTurn("[folded]")],
                objects: [STORED],
                transcripts,
            }),
        );
        expect(stage(p, "retrieval")?.status).toBe("ok");
        expect(p.attributed).toMatchObject({ cause: "delivery", status: "failed" });
    });

    test("memory the plugin injected counts as retrieved and delivered", () => {
        const injected = {
            body: {
                system: [
                    {
                        text: "base\n<project-memory>\n- error strings use TAG_X\n</project-memory>",
                    },
                ],
                messages: [user("Add the error path.")],
            },
        };
        const p = evidence(build({ calls: [SOURCE_READ, CAPTURED, injected], objects: [STORED] }));
        expect(stage(p, "retrieval")?.detail?.ranks).toEqual([
            { source: "<project-memory>", line: 2 },
        ]);
        expect(p.attributed.cause).toBe("application");
    });

    test("a literal in the probe context skips upstream stages and blames application", () => {
        const p = evidence(
            build({ calls: [searchTurn("TAG_X")], journal: [{ kind: "BeginTurn", event: "e-5" }] }),
        );
        expect(stage(p, "source")?.status).toBe("unavailable");
        expect(p.attributed.cause).toBe("application");
    });

    test("a superseded value alone in the probe context is an eligibility failure", () => {
        const p = evidence(
            build({ calls: [SOURCE_READ, CAPTURED, searchTurn("1. TAG_OLD")], objects: [STORED] }),
        );
        expect(p.attributed.cause).toBe("eligibility");
        expect(stage(p, "delivery")?.detail?.stale_in_context).toEqual(["TAG_OLD"]);
    });

    test("the agent's own output in the probe turn is no delivery", () => {
        const wrote = {
            body: {
                messages: [
                    user("Add the error path."),
                    toolUse("t9", "write", { content: 'throw new Error("TAG_X")' }),
                    toolResult("t9", "ok"),
                ],
            },
        };
        const p = evidence(build({ calls: [SOURCE_READ, CAPTURED, wrote], objects: [STORED] }));
        expect(stage(p, "delivery")?.status).toBe("failed");
        expect(p.attributed.cause).toBe("retrieval");
    });

    test("an abstain item with only its unsettled values in context is an application failure", () => {
        const scenario: EvidenceScenario = {
            ...SCENARIO,
            probes: SCENARIO.probes.map((p) => ({
                ...p,
                type: "P9",
                ground_truth: {
                    expect: "abstain",
                    present: [],
                    stale: ["TAG_OLD"],
                    sources: ["e-0"],
                },
            })),
        };
        const p = evidence(build({ scenario, calls: [SOURCE_READ, searchTurn("TAG_OLD")] }));
        expect(p.attributed.cause).toBe("application");
    });

    test("a clock jump's own offset moves the probe onto the daemon clock", () => {
        const late = { ...STORED, created_ms: BEGIN_WALL + 1 };
        const r = build({
            calls: [SOURCE_READ, CAPTURED, searchTurn("TAG_X")],
            objects: [late],
            journal: [
                { kind: "Event", event: "e-0", outcome: "ok" },
                { kind: "AdvanceClock", offset_s: 5, offset_wall_ms: 1 },
                { kind: "BeginTurn", event: "e-5", wall_ms: BEGIN_WALL },
            ],
        });
        expect(stage(evidence(r), "persisted")?.status).toBe("ok");
    });

    test("a memory under a key another project owns fails eligibility in a project with no captures", () => {
        const scenario: EvidenceScenario = {
            ...SCENARIO,
            probes: SCENARIO.probes.map((p) => ({ ...p, project: "gamma" })),
            sessions: [...SCENARIO.sessions, { id: "s-9", project: "gamma" }],
        };
        const p = evidence(
            build({
                scenario,
                calls: [SOURCE_READ, CAPTURED, searchTurn("nothing")],
                objects: [STORED],
            }),
        );
        expect(stage(p, "eligibility")?.status).toBe("failed");
    });

    test("a run without request bodies reports the stages it cannot decide as unobserved", () => {
        const p = evidence(
            build({ calls: [SOURCE_READ, searchTurn("TAG_X")], parts: false, transcripts: null }),
        );
        expect(stage(p, "source")?.status).toBe("unobserved");
        expect(stage(p, "delivery")?.status).toBe("unobserved");
        expect(p.attributed.status).toBe("unobserved");
    });
});

describe("evidence stages on the host arm", () => {
    test("host stages are source, context, and application", () => {
        const host = { arm: "host", memory: false };
        const missed = evidence(build({ ...host, calls: [SOURCE_READ, searchTurn("nothing")] }));
        expect(missed.stages.map((s) => s.stage)).toEqual(["source", "context", "application"]);
        expect(missed.attributed).toMatchObject({ cause: "context", status: "failed" });
        const seen = evidence(build({ ...host, calls: [SOURCE_READ, searchTurn("TAG_X")] }));
        expect(seen.attributed.cause).toBe("application");
    });

    test("a tool-result source whose check never ran with an exit is unavailable", () => {
        const scenario: EvidenceScenario = {
            ...SCENARIO,
            events: SCENARIO.events.map((e) =>
                e.id === "e-0"
                    ? { ...e, path: "scripts/check.sh", content: "#!/bin/sh\necho TAG_X" }
                    : e,
            ),
            probes: SCENARIO.probes.map((p) => ({
                ...p,
                type: "P12",
                ground_truth: { ...p.ground_truth, sources: ["e-0", "e-2"] },
            })),
        };
        const base = {
            arm: "host",
            memory: false,
            scenario,
            calls: [SOURCE_READ, searchTurn("x")],
        };
        const cut = [{ line: 1, turn: "e-2", command: "sh scripts/check.sh", exit: null }];
        expect(evidence(build({ ...base, tools: cut })).attributed).toMatchObject({
            cause: "source",
            status: "unavailable",
        });
        const read = [{ line: 1, turn: "e-2", command: "cat scripts/check.sh", exit: 0 }];
        expect(evidence(build({ ...base, tools: read })).attributed.status).toBe("unavailable");
        expect(
            evidence(build({ ...base, tools: cut, verdict: "excluded" })).attributed,
        ).toMatchObject({
            cause: "source",
            status: "unavailable",
        });
        const ran = [{ line: 1, turn: "e-2", command: "sh scripts/check.sh", exit: 1 }];
        const p = evidence(build({ ...base, tools: ran }));
        expect(stage(p, "source")?.status).toBe("ok");
        expect(stage(p, "source")?.pointers).toContainEqual({
            path: "host/tools.jsonl",
            at: "line 1",
        });
    });
});

describe("control items", () => {
    const control: EvidenceScenario = {
        ...SCENARIO,
        probes: SCENARIO.probes.map((p) => ({
            ...p,
            type: "P1-control",
            ground_truth: { expect: "baseline", present: [["TAG_X"]], sources: [] },
        })),
    };
    test("a control that leaves the rule unapplied holds", () => {
        const p = evidence(build({ scenario: control, calls: [searchTurn("nothing")] }));
        expect(p.attributed.cause).toBe("none");
        expect(stage(p, "application")?.status).toBe("ok");
    });
    test("a control that applies a rule its context carried blames eligibility", () => {
        const p = evidence(
            build({ scenario: control, calls: [searchTurn("TAG_X")], verdict: "pass" }),
        );
        expect(p.attributed).toMatchObject({ cause: "eligibility", status: "failed" });
        expect(stage(p, "retrieval")?.status).toBe("failed");
    });
    test("an excluded control is neither held nor lost at a stage", () => {
        const p = evidence(
            build({ scenario: control, calls: [searchTurn("nothing")], verdict: "excluded" }),
        );
        expect(p.attributed).toMatchObject({ cause: "application", status: "excluded" });
    });
    test("a control that applies the rule unprompted blames application", () => {
        const p = evidence(
            build({ scenario: control, calls: [searchTurn("nothing")], verdict: "pass" }),
        );
        expect(p.attributed.cause).toBe("application");
    });
});

describe("context health", () => {
    const compaction = (output: number, finish: string) => ({
        session: "s-2",
        turn: null,
        component: "native_compaction" as Component,
        output_tokens: output,
        finish_reason: finish,
    });
    const big = { session: "s-2", turn: "e-5", input_tokens: 250_000 };

    test("a refused compaction before an over-window prompt flags the session", () => {
        const r = build({ arm: "host", calls: [compaction(0, "content_filtered"), big] });
        const h = sessionHealth(r).find((x) => x.session === "s-2");
        expect(h).toMatchObject({
            cause: "compaction-refused",
            compaction_refused: 1,
            over_window_calls: 1,
            flagged_from: "e-5",
        });
        expect(evidence(r).attributed).toMatchObject({
            cause: "compaction-refused",
            status: "flagged",
        });
    });

    test("a prompt-too-long refusal alone is a context overflow", () => {
        const refused = {
            session: "s-2",
            turn: "e-5",
            status: 400,
            input_tokens: 0,
            error: "ValidationException: prompt is too long: 1000229 tokens > 1000000 maximum",
        };
        const h = sessionHealth(
            build({ arm: "host", calls: [compaction(900, "end_turn"), refused] }),
        ).find((x) => x.session === "s-2");
        expect(h).toMatchObject({
            cause: "context-overflow",
            prompt_too_long_errors: 1,
            compaction_refused: 0,
        });
    });

    test("a refused compaction with every prompt inside the window flags nothing", () => {
        const h = sessionHealth(
            build({ arm: "host", calls: [compaction(0, "content_filtered"), { session: "s-2" }] }),
        ).find((x) => x.session === "s-2");
        expect(h?.compaction_refused).toBe(1);
        expect(h?.cause).toBeNull();
    });

    test("a refusal after the session's last call flags the next turn the journal began", () => {
        const r = build({
            arm: "host",
            calls: [
                compaction(0, "content_filtered"),
                { session: "s-2", turn: null, input_tokens: 300_000 },
            ],
            journal: [{ kind: "BeginTurn", event: "e-5", wall_ms: 5 }],
        });
        const h = sessionHealth(r).find((x) => x.session === "s-2");
        expect(h?.flagged_from).toBe("e-5");
    });

    test("a session the arm ran with no calls still gets a row", () => {
        const scenario = {
            ...SCENARIO,
            sessions: [{ id: "s-1", project: "alpha", forced_p90: true }],
        };
        const r = build({ scenario, calls: [] });
        (r.arms.get("eidnara") as ArmData).profile = { plugin: true, host_compaction: true };
        expect(sessionHealth(r).find((x) => x.session === "s-1")?.p90_native_compaction).toBe(
            false,
        );
    });

    test("the comparison keeps flagged turns apart", () => {
        const r = build({ arm: "host", calls: [compaction(0, "end_turn"), big] });
        const sessions = sessionHealth(r);
        const [g] = r.grades;
        const probes = [probeEvidence(r, "host", g as GradeRecord, sessions)];
        const sides = armComparison({ name: "r", run: r, probes, sessions }).get("host");
        expect(sides?.flagged.agent_calls).toBe(1);
        expect(sides?.flagged.turns).toBe(1);
        expect(sides?.healthy.turns).toBe(0);
    });

    test("a forced p90 session on a host-compaction memory arm reports its native compaction", () => {
        const scenario = {
            ...SCENARIO,
            sessions: [{ id: "s-2", project: "alpha", forced_p90: true }],
        };
        const r = build({ scenario, calls: [compaction(900, "end_turn")] });
        (r.arms.get("eidnara") as ArmData).profile = { plugin: true, host_compaction: true };
        expect(sessionHealth(r).find((x) => x.session === "s-2")?.p90_native_compaction).toBe(true);
    });
});

test("request text, injected blocks, and search routes read as documented", () => {
    const text = bodyText({
        system: [{ text: "sys" }],
        messages: [toolUse("t", "bash", { command: "ls" }), toolResult("t", "out")],
    });
    expect(text.split("\n")).toEqual(["sys", "bash", "ls", "out"]);
    expect(injectedBlocks("a <memory-updates>x</memory-updates> b")).toEqual([
        { tag: "memory-updates", body: "x" },
    ]);
    expect(searchRoute("Error: no store", true)).toEqual({ route: "errored" });
    expect(searchRoute("1. hit", false)).toEqual({ route: "fused" });
});

test("evidence-run reads a run directory and writes only under --out", () => {
    const root = mkdtempSync(join(tmpdir(), "sim-evidence-"));
    const dir = join(root, "run");
    mkdirSync(join(dir, "eidnara", "final-store"), { recursive: true });
    const r = build({ calls: [SOURCE_READ, CAPTURED, searchTurn("1. TAG_X")] });
    writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({
            host: "pi",
            context_limit: 200_000,
            order: ["eidnara"],
            arms: { eidnara: { profile: { plugin: true } } },
        }),
    );
    writeFileSync(join(dir, "scenario.json"), JSON.stringify(SCENARIO));
    const journal = r.journal.map((e) => ({ ...e, wall_ms: e.wall_ms || 1 }));
    writeFileSync(
        join(dir, "journal.jsonl"),
        journal.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
    writeFileSync(join(dir, "calls.jsonl"), r.calls.map((c) => `${JSON.stringify(c)}\n`).join(""));
    writeFileSync(
        join(dir, "requests.jsonl"),
        [...(r.parts ?? [])].map(([id, part]) => `${JSON.stringify({ id, part })}\n`).join(""),
    );
    writeFileSync(
        join(dir, "grades.jsonl"),
        `${JSON.stringify({ ...r.grades[0], verdict: "fail" })}\n`,
    );
    writeFileSync(join(dir, "eidnara", "tools.jsonl"), "");
    const kernel = new Database(join(dir, "eidnara", "final-store", "kernel.sqlite"));
    kernel.run("create table commit_log(commit_seq integer primary key, recorded_at integer)");
    kernel.run(
        "create table object_registry(object_id text primary key, created_commit_seq integer, invalidated_commit_seq integer, superseded_by text)",
    );
    kernel.run("create table decisions(object_id text, decision_payload blob, scope_id text)");
    kernel.run("create table propositions(object_id text, value blob, scope_id text)");
    kernel.run("insert into commit_log values (1, 5000)");
    kernel.run("insert into object_registry values ('decision:1', 1, null, null)");
    kernel.run("insert into decisions values ('decision:1', ?, 'project:KEY_A')", [
        Buffer.from("error strings use TAG_X"),
    ]);
    kernel.close();
    const store = new Database(join(dir, "eidnara", "final-store", "store.db"));
    store.run(
        "create table memory_capture_jobs(session_id text, project text, created_at_ms integer, commit_seq integer, abandoned_at_ms integer)",
    );
    store.run("insert into memory_capture_jobs values ('sim-s-1', 'KEY_A', 1, 1, null)");
    store.close();
    expect(() => evidenceRun([dir, dir], join(root, "dup"))).toThrow(/share a name/);
    expect(() => evidenceRun([dir], root)).toThrow(/inside a run directory/);
    expect(() => evidenceRun([dir], join(dir, "ev"))).toThrow(/inside a run directory/);
    const before = readdirSync(dir).sort();
    const out = join(root, "out");
    const report = evidenceRun([dir], out);
    expect(readdirSync(dir).sort()).toEqual(before);
    const rows = readFileSync(join(out, "run", "evidence.jsonl"), "utf8")
        .trim()
        .split("\n");
    const row = JSON.parse(rows[0] as string) as ProbeEvidence;
    expect(row.stages.map((s) => s.status)).toEqual(["ok", "ok", "ok", "ok", "ok", "failed"]);
    expect(existsSync(join(out, "run", "evidence-sessions.jsonl"))).toBe(true);
    expect(readFileSync(join(out, "evidence.md"), "utf8")).toBe(report);
    expect(report).toContain("| run | eidnara | q-1 | P1 | fail |");
    expect(loadRun(dir).arms.get("eidnara")?.objects?.[0]?.created_ms).toBe(5000);
    writeFileSync(join(dir, "eidnara", "final-store", "kernel.sqlite"), "not a database");
    rmSync(join(dir, "eidnara", "final-store", "store.db"));
    expect(loadRun(dir).arms.get("eidnara")?.objects).toBeNull();
});
