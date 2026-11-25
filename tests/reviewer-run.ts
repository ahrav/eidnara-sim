import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../src/prereg/canonical";
import type { ConverseBody } from "../src/proxy/classify";
import { partId, requestParts } from "../src/proxy/requests";
import { PRODUCER_CONTEST, PRODUCER_DISPUTE, PRODUCER_SETTLEMENT } from "../src/reviewer/changes";
import type { ReviewScenario } from "../src/reviewer/truth";
import { scenarioHash } from "../src/scenario/compile";

/** The wall time the fixture's journal starts at. */
export const WALL0 = 1_795_000_000_000;
/** The daemon's clock runs this far ahead of the wall clock from `WALL0 + 10 s` on. */
export const JUMP_MS = 100_000;
export const ARM = "eidnara-reviewer";
const TOKEN = "0123456789abcdef";

const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
/** The daemon's reading at `s` seconds of wall time after `WALL0`. */
export const daemonAt = (s: number) => WALL0 + s * 1_000 + (s >= 10 ? JUMP_MS : 0);

const PLAN =
    "two items are open for next time and I have not decided which comes first. One is an alpha_item field. The other is a beta_item command";
const TAG0 = "every commit message starts with [amber_fox]";
const TAG1 = "every commit message starts with [brisk_owl]";

/** The fixture's scenario: a plan the user closes in a sentence that names nothing, and a rule the user replaces. */
export function reviewerScenario() {
    const fact = (id: string, kind: string, line: string, revision: number, statement: string) => ({
        id,
        kind,
        line,
        revision,
        statement,
        project: "elysia",
        manner: "correction",
        basis: "instruction",
        template: line,
        supersedes: revision === 0 ? null : `${id.slice(0, -1)}${revision - 1}`,
        cues: [`Quick correction before you carry on: ${statement}.`],
    });
    const turn = (n: number, role: string, text: string, factId?: string) => ({
        id: `e-${n}`,
        kind: "user_turn",
        role,
        session: "s-1",
        scenario_ms: n * 1_000,
        text,
        ...(factId ? { fact: factId } : {}),
    });
    const truth = (present: string[][], stale: string[]) => ({
        expect: "apply",
        basis: "instruction",
        present,
        absent: [],
        stale,
        supersedes: [],
        sources: [],
    });
    const body = {
        manifest: { seed: 101, tier: "S" },
        sessions: [{ id: "s-1", project: "elysia", start_ms: 0 }],
        facts: [
            fact("f-plan0", "plan", "elysia/plan", 0, PLAN),
            fact("f-tag0", "session_rule", "elysia/commit-tag", 0, TAG0),
            fact("f-tag1", "session_rule", "elysia/commit-tag", 1, TAG1),
        ],
        events: [
            { id: "e-0", kind: "session_start", session: "s-1", scenario_ms: 0 },
            turn(1, "conveyance", `Quick correction before you carry on: ${PLAN}.`, "f-plan0"),
            turn(2, "conveyance", `Quick correction before you carry on: ${TAG0}.`, "f-tag0"),
            { ...turn(3, "probe", "Carry on with the open items."), probe: "q-plan" },
            turn(
                4,
                "status",
                "Let's set both of those open items aside and consider them closed.",
                "f-plan0",
            ),
            turn(5, "conveyance", `Quick correction before you carry on: ${TAG1}.`, "f-tag1"),
            { ...turn(6, "probe", "Commit the change."), probe: "q-tag" },
            { id: "e-7", kind: "session_end", session: "s-1", scenario_ms: 7_000 },
        ],
        probes: [
            {
                id: "q-plan",
                type: "P6",
                fact: "f-plan0",
                project: "elysia",
                session: "s-1",
                text: "Carry on with the open items.",
                check: {},
                event: "e-3",
                ground_truth: truth([["alpha_item"], ["beta_item"]], []),
            },
            {
                id: "q-tag",
                type: "P13",
                fact: "f-tag1",
                project: "elysia",
                session: "s-1",
                text: "Commit the change.",
                check: {},
                event: "e-6",
                ground_truth: truth([["brisk_owl"]], ["amber_fox"]),
            },
        ],
        plans: [
            {
                fact: "f-plan0",
                project: "elysia",
                expect: "clarify",
                history: [
                    {
                        event: "e-1",
                        status: "accepted",
                        next: ["an alpha_item field", "a beta_item command"],
                    },
                    { event: "e-4", status: "completed", next: [] },
                ],
            },
        ],
    };
    // SAFETY: the literals above are a `Fact`, a `ProbeItem`, and a `PlanRecord` each; the cast names their unions.
    return { ...body, scenario_hash: scenarioHash(body) } as unknown as ReviewScenario & {
        scenario_hash: string;
    };
}

/** The rows the fixture's reviewer changed, by the name the tests use. */
export const ROWS = {
    plan: {
        id: "mem_plan",
        job: "aaaaaaaaaaaaaaa1",
        text: `User stated: Quick correction before you carry on: ${PLAN}.`,
        producer: "memory_capture",
        rationale: { source: "memory_capture", speaker: "user", lifetime: "lasting" },
        before: "automatic",
        cited: "Let's set both of those open items aside and consider them closed.",
        citedBy: "user",
    },
    question: {
        id: "mem_question",
        job: "aaaaaaaaaaaaaaa2",
        text: "Assistant reported: Should I commit it as `[brisk_owl] Add the cap`?",
        producer: "memory_capture",
        rationale: { source: "memory_capture" },
        before: "explicit_labeled",
        cited: "[main 7e66a10] [brisk_owl] Add the cap\n 1 file changed",
        citedBy: "tool",
    },
    note: {
        id: "mem_note",
        job: "aaaaaaaaaaaaaaa3",
        text: `User stated: ${TAG1}. (Replaces the earlier [amber_fox].)`,
        producer: "plugin",
        rationale: {},
        before: "explicit_labeled",
        cited: `Quick correction before you carry on: ${TAG1}.`,
        citedBy: "user",
    },
    tag: {
        id: "mem_tag0",
        job: "aaaaaaaaaaaaaaa4",
        text: `User stated: Quick correction before you carry on: ${TAG0}.`,
        producer: "memory_capture",
        rationale: { source: "memory_capture", speaker: "user", lifetime: "lasting" },
        before: "automatic",
        cited: `Quick correction before you carry on: ${TAG1}.`,
        citedBy: "user",
    },
} as const;
export type RowName = keyof typeof ROWS;

/**
 * A finished run directory with one reviewer arm: the scenario above, a journal with a clock
 * jump, a Kernel store and a daemon store that hold four disputes, a contest mark left standing,
 * and an unchanged settlement, the gateway record of each dispute's stage-2 request, and a Pi
 * transcript. Seconds are wall seconds after `WALL0`.
 */
export function reviewerRun(): string {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-run-"));
    const scenario = reviewerScenario();
    writeFileSync(join(dir, "scenario.json"), `${canonicalJson(scenario)}\n`);
    writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({
            schema: "sim-run-manifest/v3",
            tier: "S",
            seed: 101,
            host: "pi",
            order: [ARM],
            models: ["global.anthropic.claude-opus-5-5"],
            scenario_hash: scenario.scenario_hash,
            base_wall_ms: WALL0,
        }),
    );
    // Wall seconds at which the arm received each turn: the plan, the first tag, the probe, the
    // closing sentence, the second tag.
    const turns: [string, number][] = [
        ["e-1", 20],
        ["e-2", 30],
        ["e-3", 40],
        ["e-4", 50],
        ["e-5", 70],
    ];
    const journal = [
        { kind: "ClockOffset", arm: ARM, offset_s: 0, scenario_ms: 0, wall_ms: WALL0 },
        {
            kind: "ClockOffset",
            arm: ARM,
            offset_s: JUMP_MS / 1_000,
            scenario_ms: 110_000,
            wall_ms: WALL0 + 10_000,
        },
        ...turns.map(([event, s]) => ({
            kind: "BeginTurn",
            arm: ARM,
            event,
            probe: null,
            scenario_ms: 100_000 + s * 1_000,
            wall_ms: WALL0 + s * 1_000,
        })),
    ].map((e, seq) => ({ ...e, seq }));
    writeFileSync(
        join(dir, "journal.jsonl"),
        journal.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );

    const store = join(dir, ARM, "final-store");
    mkdirSync(store, { recursive: true });
    const kernel = new Database(join(store, "kernel.sqlite"));
    kernel.run(
        "create table commit_log(commit_seq integer primary key, recorded_at integer, operation_key text, producer text)",
    );
    kernel.run(
        "create table operation_receipts(producer text, operation_key text, commit_seq integer, result_payload blob, created_at integer)",
    );
    kernel.run(
        "create table decisions(object_id text primary key, decision_payload blob, created_commit_seq integer, invalidated_commit_seq integer, superseded_by text)",
    );
    kernel.run(
        "create table admission_decisions(admission_decision_id text primary key, subject_object_id text, event_kind text, visibility text, commit_seq integer, decided_at integer)",
    );
    kernel.run(
        "create table candidates(candidate_id text primary key, candidate_kind text, payload blob)",
    );
    const daemon = new Database(join(store, "store.db"));
    daemon.run(
        "create table memory_reviewer_receipts(causal_identity text, selected_candidate_id text)",
    );
    daemon.run("create table memory_reviewer_jobs(causal_identity text, project text)");
    const commit = (seq: number, s: number, producer: string, key = `op-${seq}`) =>
        kernel.run("insert into commit_log values (?, ?, ?, ?)", [seq, daemonAt(s), key, producer]);
    const admit = (seq: number, id: string, event: string, visibility: string) =>
        kernel.run("insert into admission_decisions values (?, ?, ?, ?, ?, ?)", [
            `adm-${seq}-${id}`,
            id,
            event,
            visibility,
            seq,
            seq,
        ]);
    const calls: Record<string, unknown>[] = [];
    const parts: string[] = [];
    // Each row is stored at `stored` and disputed at `changed` wall seconds.
    const schedule: Record<
        RowName,
        { stored: number; changed: number; source: number | null; citedAt: number }
    > = {
        plan: { stored: 21, changed: 52, source: 20, citedAt: 50 },
        question: { stored: 45, changed: 62, source: 44, citedAt: 60 },
        note: { stored: 72, changed: 76, source: null, citedAt: 70 },
        tag: { stored: 31, changed: 78, source: 30, citedAt: 70 },
    };
    let seq = 0;
    for (const name of Object.keys(ROWS) as RowName[]) {
        const row = ROWS[name];
        const at = schedule[name];
        const created = ++seq;
        commit(created, at.stored, row.producer);
        kernel.run("insert into decisions values (?, ?, ?, null, null)", [
            row.id,
            JSON.stringify({ summary: row.text, rationale: JSON.stringify(row.rationale) }),
            created,
        ]);
        admit(created, row.id, row.before === "automatic" ? "approve" : "other", row.before);
        const disputed = ++seq;
        const identity = `${row.job}${"0".repeat(48)}`;
        commit(disputed, at.changed, PRODUCER_DISPUTE);
        kernel.run("insert into operation_receipts values (?, ?, ?, ?, ?)", [
            PRODUCER_DISPUTE,
            `project#${identity}`,
            disputed,
            "disputed",
            daemonAt(at.changed),
        ]);
        admit(disputed, row.id, "mark_disputed", "explicit_labeled");
        const cited = Buffer.byteLength(row.cited);
        kernel.run("insert into candidates values (?, 'review_proposal', ?)", [
            `cand-${name}`,
            JSON.stringify({
                version: 2,
                body: {
                    kind: "review_proposal",
                    action: "retire",
                    contradictions: [
                        { evidence_id: "srcev:x", span: { alias: "ref-3", start: 0, end: cited } },
                    ],
                    support: [],
                },
            }),
        ]);
        daemon.run("insert into memory_reviewer_receipts values (?, ?)", [
            identity,
            `cand-${name}`,
        ]);
        daemon.run("insert into memory_reviewer_jobs values (?, ?)", [
            identity,
            "/runs/x/r/workspaces/elysia",
        ]);
        const label =
            row.citedBy === "tool"
                ? "a message a tool wrote"
                : `a message the ${row.citedBy} wrote at ${iso(daemonAt(at.citedAt))}`;
        const sourceLine =
            at.source === null
                ? []
                : [
                      `ref-2: a message the ${name === "question" ? "assistant" : "user"} wrote at ${iso(daemonAt(at.source))}; the memory cites it as its source`,
                  ];
        const user = [
            `[ref-1 ${TOKEN}]\n${row.text}\n[/ref-1 ${TOKEN}]`,
            [
                "linked references:",
                ...sourceLine,
                `ref-3: ${label}; written after the memory's source`,
            ].join("\n"),
            ...(at.source === null
                ? []
                : [`[ref-2 ${TOKEN}]\nthe source message\n[/ref-2 ${TOKEN}]`]),
            `[ref-3 ${TOKEN}]\n${row.cited}\n[/ref-3 ${TOKEN}]`,
        ].join("\n\n");
        const body: ConverseBody = { messages: [{ role: "user", content: [{ text: user }] }] };
        const pieces = requestParts(body);
        for (const part of pieces) parts.push(JSON.stringify({ id: partId(part), part }));
        const json = JSON.stringify(body);
        calls.push({
            seq: calls.length,
            arm: ARM,
            session: "s-1",
            turn: null,
            component: "memory_reviewer_stage2",
            componentSource: "inferred",
            model: "global.anthropic.claude-opus-5-5",
            status: 200,
            started_wall_ms: WALL0 + at.changed * 1_000 - 900,
            wall_ms: WALL0 + at.changed * 1_000 - 100,
            scenario_ms: 0,
            request: {
                sha256: sha256Hex(json),
                bytes: Buffer.byteLength(json),
                parts: pieces.map(partId),
            },
        });
    }
    // A statement left standing and an unchanged settlement: receipts that write no change.
    commit(++seq, 80, PRODUCER_CONTEST);
    kernel.run("insert into operation_receipts values (?, ?, ?, ?, ?)", [
        PRODUCER_CONTEST,
        `project#${"b".repeat(64)}`,
        seq,
        "",
        daemonAt(80),
    ]);
    commit(++seq, 81, PRODUCER_SETTLEMENT);
    kernel.run("insert into operation_receipts values (?, ?, ?, ?, ?)", [
        PRODUCER_SETTLEMENT,
        "settlement-v1",
        seq,
        JSON.stringify({ target: { object_id: "mem_plan" }, effect: { kind: "unchanged" } }),
        daemonAt(81),
    ]);
    kernel.close();
    daemon.close();
    writeFileSync(join(dir, "calls.jsonl"), calls.map((c) => `${JSON.stringify(c)}\n`).join(""));
    writeFileSync(join(dir, "requests.jsonl"), [...new Set(parts)].map((p) => `${p}\n`).join(""));

    const sessions = join(dir, ARM, "r", "home", ".pi", "agent", "sessions", "--elysia--");
    mkdirSync(sessions, { recursive: true });
    const message = (
        s: number,
        role: string,
        content: unknown[],
        more: Record<string, unknown> = {},
    ) =>
        JSON.stringify({
            type: "message",
            timestamp: new Date(daemonAt(s)).toISOString(),
            message: { role, content, ...more },
        });
    const text = (t: string) => [{ type: "text", text: t }];
    writeFileSync(
        join(sessions, "2026-11-18T00-00-00-000Z_sim-s-1.jsonl"),
        `${[
            JSON.stringify({
                type: "session",
                id: "sim-s-1",
                cwd: `${dir}/${ARM}/r/workspaces/elysia`,
            }),
            message(20, "user", text(`Quick correction before you carry on: ${PLAN}.`)),
            message(22, "assistant", text("Noted both open items.")),
            message(30, "user", text(`Quick correction before you carry on: ${TAG0}.`)),
            message(44, "assistant", text("Should I commit it as `[brisk_owl] Add the cap`?")),
            message(
                50,
                "user",
                text("Let's set both of those open items aside and consider them closed."),
            ),
            message(59, "assistant", [
                {
                    type: "toolCall",
                    id: "t1",
                    name: "bash",
                    arguments: { command: "git commit -m '[brisk_owl] Add the cap'" },
                },
            ]),
            message(
                60,
                "toolResult",
                text(
                    `[main 7e66a10] [brisk_owl] Add the cap\n 1 file changed in ${dir}/${ARM}/r/workspaces/elysia/src`,
                ),
                {
                    toolCallId: "t1",
                    toolName: "bash",
                },
            ),
            message(70, "user", text(`Quick correction before you carry on: ${TAG1}.`)),
            message(90, "user", text("A message written after every change.")),
        ].join("\n")}\n`,
    );
    return dir;
}
