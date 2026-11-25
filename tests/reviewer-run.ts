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

/** The rows the `extra` option adds: a contested statement, a revised report, and a created row. */
export const EXTRA = {
    contest: {
        id: "mem_quote",
        marked: "mem_quote_marked",
        job: "aaaaaaaaaaaaaaa5",
        text: "User stated: string literals you add use single quotes.",
        later: "User stated: string literals you add use double quotes.",
    },
    revised: {
        id: "mem_count",
        successor: "mem_count_v2",
        job: "aaaaaaaaaaaaaaa6",
        proposal: "review-result:revised",
        text: "Assistant reported: 21 cookie tests fail.",
        revised: "Assistant reported: 20 cookie tests fail.",
        cited: "I counted again: 20 cookie tests fail, not 21.",
    },
    created: {
        id: "mem_made",
        job: "aaaaaaaaaaaaaaa7",
        proposal: "review-result:created",
        text: "User stated: release notes go in CHANGES.md.",
        cited: "Put release notes in CHANGES.md from now on.",
    },
} as const;

/** What a test changes in the fixture run. */
export interface RunOptions {
    /** Adds a contest mark with a marked row, a settlement that revised a row, and one that created a row. */
    extra?: boolean;
    /** Adds a reviewer receipt that names a commit the log lacks. */
    orphan?: boolean;
    /** The wall second at which the arm's clock offset shrinks by 30 s. */
    shrinkAt?: number;
    /** Adds a second arm whose journal entries and stage-2 call the reviewer arm's readings leave out. */
    otherArm?: boolean;
    /** The wall second at which the arm received the replacing tag statement (e-5). */
    tagAt?: number;
    /** The model the gateway recorded for the reviewer's calls. */
    reviewerModel?: string;
}
export const OTHER_ARM = "eidnara";

/**
 * A finished run directory with one reviewer arm: the scenario above, a complete journal with a
 * clock jump, a Kernel store and a daemon store that hold four disputes, a contest mark left
 * standing, and an unchanged settlement, the gateway record of each dispute's stage-2 request,
 * and a Pi transcript. Seconds are wall seconds after `WALL0`.
 */
export function reviewerRun(o: RunOptions = {}): string {
    const dir = mkdtempSync(join(tmpdir(), "reviewer-run-"));
    const scenario = reviewerScenario();
    const arms = o.otherArm ? [OTHER_ARM, ARM] : [ARM];
    writeFileSync(join(dir, "scenario.json"), `${canonicalJson(scenario)}\n`);
    writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({
            schema: "sim-run-manifest/v3",
            tier: "S",
            seed: 101,
            host: "pi",
            order: arms,
            events: scenario.events.length,
            models: ["global.anthropic.claude-opus-5-5"],
            scenario_hash: scenario.scenario_hash,
            base_wall_ms: WALL0,
        }),
    );
    // Wall seconds at which the reviewer arm received each event: the plan, the first tag, a
    // probe, the closing sentence, the second tag, a probe.
    const at: Record<string, number> = {
        "e-0": 15,
        "e-1": 20,
        "e-2": 30,
        "e-3": 40,
        "e-4": 50,
        "e-5": o.tagAt ?? 70,
        "e-6": 95,
        "e-7": 99,
    };
    const journal: Record<string, unknown>[] = [
        { kind: "StartRun", arm: null, order: arms, scenario_ms: 0, wall_ms: WALL0 - 400_000 },
    ];
    const armEntries = (arm: string, shift: number, offsets: [number, number, number][]) => {
        for (const [s, offset, scenarioMs] of offsets) {
            journal.push({
                kind: "ClockOffset",
                arm,
                offset_s: offset,
                scenario_ms: scenarioMs,
                wall_ms: WALL0 + s * 1_000,
            });
        }
        for (const e of scenario.events) {
            const wall = WALL0 + ((at[e.id] as number) + shift) * 1_000;
            const entry = { arm, event: e.id, scenario_ms: 100_000 + (at[e.id] as number) * 1_000 };
            if (e.kind === "user_turn") {
                journal.push({ kind: "BeginTurn", probe: null, ...entry, wall_ms: wall });
            }
            journal.push({ kind: "Event", outcome: "ok", ...entry, wall_ms: wall + 500 });
        }
        journal.push({
            kind: "EndArm",
            arm,
            scenario_ms: 200_000,
            wall_ms: WALL0 + (100 + shift) * 1_000,
        });
    };
    // The other arm runs first, a day ahead on its own clock, and receives every event earlier.
    if (o.otherArm) armEntries(OTHER_ARM, -200, [[-300, 86_400, 0]]);
    armEntries(ARM, 0, [
        [0, 0, 0],
        [10, JUMP_MS / 1_000, 110_000],
        ...(o.shrinkAt === undefined
            ? []
            : ([[o.shrinkAt, JUMP_MS / 1_000 - 30, 100_000 + o.shrinkAt * 1_000]] as [
                  number,
                  number,
                  number,
              ][])),
    ]);
    journal.push({ kind: "EndRun", arm: null, scenario_ms: 0, wall_ms: WALL0 + 200_000 });
    journal.sort((a, b) => (a.wall_ms as number) - (b.wall_ms as number));
    writeFileSync(
        join(dir, "journal.jsonl"),
        journal.map((e, seq) => `${JSON.stringify({ ...e, seq })}\n`).join(""),
    );
    if (o.otherArm) mkdirSync(join(dir, OTHER_ARM));

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
    // One transaction per store: a row per commit would cost a disk sync each.
    kernel.run("begin");
    daemon.run("begin");
    daemon.run(
        "create table memory_reviewer_attempts(causal_identity text, attempt_index integer, committed_at_ms integer, terminal_at_ms integer)",
    );
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
    const decide = (
        id: string,
        text: string,
        rationale: object,
        created: number,
        ended?: [number, string],
    ) =>
        kernel.run("insert into decisions values (?, ?, ?, ?, ?)", [
            id,
            JSON.stringify({ summary: text, rationale: JSON.stringify(rationale) }),
            created,
            ended?.[0] ?? null,
            ended?.[1] ?? null,
        ]);
    const receipt = (producer: string, key: string, seq: number, result: string, s: number) =>
        kernel.run("insert into operation_receipts values (?, ?, ?, ?, ?)", [
            producer,
            key,
            seq,
            result,
            daemonAt(s),
        ]);
    const calls: Record<string, unknown>[] = [];
    const parts: string[] = [];
    /** The job's proposal in both stores and the stage-2 request the gateway recorded for it. */
    const review = (r: {
        arm?: string;
        job: string;
        candidate: string;
        text: string;
        body: object;
        cited: string;
        citedBy: string;
        citedAt: number;
        source: [string, number] | null;
        endedAt: number;
    }) => {
        const identity = `${r.job}${"0".repeat(48)}`;
        if (r.arm === undefined) {
            kernel.run("insert into candidates values (?, 'review_proposal', ?)", [
                r.candidate,
                JSON.stringify({
                    version: 2,
                    body: { kind: "review_proposal", support: [], ...r.body },
                }),
            ]);
            daemon.run("insert into memory_reviewer_receipts values (?, ?)", [
                identity,
                r.candidate,
            ]);
            daemon.run("insert into memory_reviewer_jobs values (?, ?)", [
                identity,
                "/runs/x/r/workspaces/elysia",
            ]);
            // The job's two attempts, on the daemon's clock: stage 1, then the stage-2 attempt
            // whose request the gateway recorded between its commit and its end.
            const end = daemonAt(r.endedAt);
            daemon.run("insert into memory_reviewer_attempts values (?, 0, ?, ?)", [
                identity,
                end - 6_000,
                end - 2_000,
            ]);
            daemon.run("insert into memory_reviewer_attempts values (?, 1, ?, ?)", [
                identity,
                end - 1_900,
                end - 50,
            ]);
        }
        const label =
            r.citedBy === "tool"
                ? "a message a tool wrote"
                : `a message the ${r.citedBy} wrote at ${iso(daemonAt(r.citedAt))}`;
        const user = [
            `[ref-1 ${TOKEN}]\n${r.text}\n[/ref-1 ${TOKEN}]`,
            [
                "linked references:",
                ...(r.source
                    ? [
                          `ref-2: a message the ${r.source[0]} wrote at ${iso(daemonAt(r.source[1]))}; the memory cites it as its source`,
                      ]
                    : []),
                `ref-3: ${label}; written after the memory's source`,
            ].join("\n"),
            ...(r.source ? [`[ref-2 ${TOKEN}]\nthe source message\n[/ref-2 ${TOKEN}]`] : []),
            `[ref-3 ${TOKEN}]\n${r.cited}\n[/ref-3 ${TOKEN}]`,
        ].join("\n\n");
        const body: ConverseBody = { messages: [{ role: "user", content: [{ text: user }] }] };
        const pieces = requestParts(body);
        for (const part of pieces) parts.push(JSON.stringify({ id: partId(part), part }));
        const json = JSON.stringify(body);
        calls.push({
            arm: r.arm ?? ARM,
            session: "s-1",
            turn: null,
            component: "memory_reviewer_stage2",
            componentSource: "inferred",
            model: o.reviewerModel ?? "global.anthropic.claude-opus-5-5",
            status: 200,
            error: null,
            finish_reason: "end_turn",
            started_wall_ms: WALL0 + r.endedAt * 1_000 - 900,
            wall_ms: WALL0 + r.endedAt * 1_000 - 100,
            scenario_ms: 0,
            request: {
                sha256: sha256Hex(json),
                bytes: Buffer.byteLength(json),
                parts: pieces.map(partId),
            },
        });
    };
    const cite = (text: string) => [
        {
            evidence_id: "srcev:x",
            span: { alias: "ref-3", start: 0, end: Buffer.byteLength(text) },
        },
    ];
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
    // The other arm reviewed the plan row's text too, later than the reviewer arm's change.
    if (o.otherArm) {
        review({
            arm: OTHER_ARM,
            job: "ffffffffffffffff",
            candidate: "cand-other",
            text: ROWS.plan.text,
            body: {},
            cited: "a message of the other arm",
            citedBy: "user",
            citedAt: 51,
            source: null,
            endedAt: 51,
        });
    }
    for (const name of Object.keys(ROWS) as RowName[]) {
        const row = ROWS[name];
        const when = schedule[name];
        const created = ++seq;
        commit(created, when.stored, row.producer);
        decide(row.id, row.text, row.rationale, created);
        admit(created, row.id, row.before === "automatic" ? "approve" : "other", row.before);
        const disputed = ++seq;
        commit(disputed, when.changed, PRODUCER_DISPUTE);
        receipt(
            PRODUCER_DISPUTE,
            `project#${row.job}${"0".repeat(48)}`,
            disputed,
            "disputed",
            when.changed,
        );
        admit(disputed, row.id, "mark_disputed", "explicit_labeled");
        review({
            job: row.job,
            candidate: `cand-${name}`,
            text: row.text,
            body: { action: "retire", contradictions: cite(row.cited) },
            cited: row.cited,
            citedBy: row.citedBy,
            citedAt: when.citedAt,
            source:
                when.source === null
                    ? null
                    : [name === "question" ? "assistant" : "user", when.source],
            endedAt: when.changed,
        });
    }
    // A statement left standing and an unchanged settlement: receipts that write no change.
    commit(++seq, 80, PRODUCER_CONTEST);
    receipt(PRODUCER_CONTEST, `project#${"b".repeat(64)}`, seq, "", 80);
    commit(++seq, 81, "eidnara-daemon/review-accept");
    receipt(
        PRODUCER_SETTLEMENT,
        "memory-reviewer-settlement-v1:64#digest:78#review-result:unchanged",
        seq,
        JSON.stringify({
            version: 1,
            proposal_id: "review-result:unchanged",
            target: { kind: "memory", object_id: "mem_plan" },
            effect: { kind: "unchanged" },
        }),
        81,
    );
    if (o.orphan) receipt(PRODUCER_DISPUTE, `project#${"c".repeat(64)}`, 9_999, "disputed", 82);
    if (o.extra) {
        // A contest mark: the statement is superseded by a marked row that stays delivered and
        // names the later statement.
        const quote = EXTRA.contest;
        commit(++seq, 83, "memory_capture");
        decide("mem_later", quote.later, { source: "memory_capture", speaker: "user" }, seq);
        const stated = ++seq;
        commit(stated, 84, "memory_capture");
        admit(stated, quote.id, "approve", "automatic");
        const marked = ++seq;
        decide(quote.id, quote.text, { source: "memory_capture", speaker: "user" }, stated, [
            marked,
            quote.marked,
        ]);
        commit(marked, 86, PRODUCER_CONTEST);
        decide(quote.marked, quote.text, { contested_by: { memory: "mem_later" } }, marked);
        admit(marked, quote.marked, "approve", "automatic");
        receipt(
            PRODUCER_CONTEST,
            `project#${quote.job}${"0".repeat(48)}`,
            marked,
            quote.marked,
            86,
        );
        review({
            job: quote.job,
            candidate: "cand-contest",
            text: quote.text,
            body: { action: "revise", new_text: quote.later, contradictions: cite(quote.later) },
            cited: quote.later,
            citedBy: "user",
            citedAt: 85,
            source: null,
            endedAt: 86,
        });
        // A settlement that revised a row: the job is the one whose receipt selected the proposal,
        // and the commit admits the successor row the effect names.
        const report = EXTRA.revised;
        commit(++seq, 87, "memory_capture");
        admit(seq, report.id, "other", "explicit_labeled");
        const settled = ++seq;
        decide(report.id, report.text, { source: "memory_capture" }, settled - 1, [
            settled,
            report.successor,
        ]);
        decide(report.successor, report.revised, { source: "memory_capture" }, settled);
        commit(
            settled,
            89,
            "eidnara-daemon/review-accept",
            `project#${report.job}${"0".repeat(48)}#digest`,
        );
        const settlement = (proposal: string, target: object, effect: object) =>
            JSON.stringify({ version: 1, proposal_id: proposal, target, commit_seq: seq, effect });
        receipt(
            PRODUCER_SETTLEMENT,
            `memory-reviewer-settlement-v1:64#${"d".repeat(64)}:78#${report.proposal}`,
            settled,
            settlement(
                report.proposal,
                { kind: "memory", object_id: report.id },
                { kind: "revised", object_id: report.successor },
            ),
            89,
        );
        admit(settled, report.successor, "other", "explicit_labeled");
        review({
            job: report.job,
            candidate: report.proposal,
            text: report.text,
            body: {
                action: "revise",
                new_text: report.revised,
                contradictions: cite(report.cited),
            },
            cited: report.cited,
            citedBy: "assistant",
            citedAt: 88,
            source: null,
            endedAt: 89,
        });
        // A settlement that created a row: its target is a staged candidate, and the effect names the row.
        const made = EXTRA.created;
        const creating = ++seq;
        commit(
            creating,
            91,
            "eidnara-daemon/review-accept",
            `project#${made.job}${"0".repeat(48)}#digest`,
        );
        decide(made.id, made.text, {}, creating);
        admit(creating, made.id, "other", "explicit_labeled");
        receipt(
            PRODUCER_SETTLEMENT,
            `memory-reviewer-settlement-v1:64#${"d".repeat(64)}:78#${made.proposal}`,
            creating,
            settlement(
                made.proposal,
                { kind: "candidate" },
                { kind: "created", object_id: made.id },
            ),
            91,
        );
        review({
            job: made.job,
            candidate: made.proposal,
            text: made.text,
            body: { action: "revise", contradictions: cite(made.cited) },
            cited: made.cited,
            citedBy: "user",
            citedAt: 90,
            source: null,
            endedAt: 91,
        });
    }
    kernel.run("commit");
    daemon.run("commit");
    kernel.close();
    daemon.close();
    calls.sort((a, b) => (a.wall_ms as number) - (b.wall_ms as number));
    writeFileSync(
        join(dir, "calls.jsonl"),
        calls.map((c, n) => `${JSON.stringify({ seq: n, ...c })}\n`).join(""),
    );
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
