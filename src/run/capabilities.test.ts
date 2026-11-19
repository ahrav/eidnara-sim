import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
    appendFileSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AUDITED_BUILDS,
    type AuditedBuild,
    armProfile,
    auditedBuild,
    capabilitiesOf,
    capabilityGaps,
    DAEMON_VARIANTS,
} from "../hosts/profiles";
import type { ConverseBody } from "../proxy/classify";
import { bodyCachePoints, cachePointsOf, type RequestPart } from "../proxy/requests";
import {
    armMismatches,
    backgroundCachePointsOf,
    bootMismatches,
    type CachingCount,
    CachingTally,
    cachingMismatches,
    capabilityRecord,
    logLength,
    noteRequest,
    observeArm,
    openItemsOf,
    daemonCachePoints as placeFor,
    readDaemonStatus,
    readPluginLog,
    requireAuditedVariants,
} from "./capabilities";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "sim-caps-"));
    dirs.push(d);
    return d;
};

const T = "[2026-10-17T21:30:08.750Z]";
const PI_ON = `${T} [eidnara][pi] registered tools: eidnara_search, eidnara_memory, eidnara_note, todowrite, eidnara_reduce; registered /todos`;
const PI_OFF = `${T} [eidnara][pi] registered tools: eidnara_search, eidnara_memory, eidnara_note, todowrite; registered /todos (eidnara_reduce unavailable in compaction-off mode)`;
const OC_ON = `${T} [eidnara] no conflicts detected, plugin enabled`;
const OC_OFF = `${T} [eidnara] disabled due to conflicts: OpenCode auto-compaction is enabled (compaction.auto=true); OpenCode prune is enabled (compaction.prune=true)`;
const PASS = `${T} [eidnara][sim-s-0000] rust pass: decision=SOFT+ reason=none served_from=transform in=10 out=9`;
const ADDITIVE = `${T} [eidnara][sim-s-0000] rust pass: decision=SOFT+ reason=none served_from=transform in=9 out=9 applied=true`;

function armRoot(log: string[], searches: string[] = []): string {
    const root = join(tmp(), "r");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "eidnara.log"), `${log.join("\n")}\n`);
    const sessions = join(root, "home/.pi/agent/sessions/--ws--");
    mkdirSync(sessions, { recursive: true });
    const lines = searches.map((text) =>
        JSON.stringify({
            type: "message",
            message: {
                role: "toolResult",
                toolName: "eidnara_search",
                content: [{ type: "text", text }],
            },
        }),
    );
    writeFileSync(join(sessions, "2026_sim-s-0000.jsonl"), `${lines.join("\n")}\n`);
    return root;
}

/**
 * Writes the capture evidence a stopped daemon leaves beside an arm root: a final Kernel store
 * whose registry holds one descriptor per class named, and the counters the driver read.
 */
/** The counters a w2 daemon reports: the capture totals and the refused-approval count. */
const COUNTERS = { admitted: 1, completed: 1, units_published: 2, decisions_approval_refused: 0 };

function captured(
    root: string,
    classes: string[] = ["messages"],
    counters: Record<string, number> | null = COUNTERS,
): string {
    const store = join(root, "..", "final-store");
    mkdirSync(store, { recursive: true });
    const db = new Database(join(store, "kernel.sqlite"));
    db.run(
        "create table object_registry(object_id text primary key, object_kind text, source_kind text, created_commit_seq integer, invalidated_commit_seq integer, source_id text default '')",
    );
    db.run("create table commit_log(commit_seq integer primary key)");
    db.run("insert into commit_log values (1), (7)");
    db.run(
        "create table decisions(object_id text, decision_payload blob, created_commit_seq integer)",
    );
    for (const [i, c] of classes.entries()) {
        db.run("insert into object_registry values (?, 'observation', ?, 1, ?, '')", [
            `srcdesc:${c}${i}:1`,
            c,
            i === 0 ? null : 7,
        ]);
    }
    db.run("insert into object_registry values ('decision:x', 'decision', 'memory', 1, null, '')");
    db.close();
    const error = counters ? null : "fixture control timed out";
    writeFileSync(join(root, "..", "source-capture.json"), JSON.stringify({ counters, error }));
    return root;
}

const LEGACY =
    "Memory: the fused search route is unavailable (disabled); results come from the legacy snapshot scan.\n[1] [memory] x";
const FUSED = "[1] [memory] score=0.9 match=fused lanes=dense provenance=unknown\nbody";

test("the OpenCode knowledge-layer arm that disabled itself is a mismatch at the session that shows it", () => {
    const boots = readPluginLog(join(armRoot([OC_OFF]), "eidnara.log"));
    const wrong = bootMismatches(armProfile("eidnara-kl"), boots);
    expect(wrong[0]).toContain(
        "disabled itself: disabled due to conflicts: OpenCode auto-compaction",
    );
    expect(wrong).toContain("the Eidnara plugin log records no enabled boot");
    const ok = readPluginLog(join(armRoot([OC_ON]), "eidnara.log"));
    expect(bootMismatches(armProfile("eidnara-kl"), ok)).toEqual([]);
});

test("a Pi boot whose transform mode differs from the arm's Eidnara compaction is a mismatch", () => {
    const on = readPluginLog(join(armRoot([PI_ON]), "eidnara.log"));
    const off = readPluginLog(join(armRoot([PI_OFF]), "eidnara.log"));
    expect(bootMismatches(armProfile("eidnara"), on)).toEqual([]);
    expect(bootMismatches(armProfile("eidnara-kl"), off)).toEqual([]);
    expect(bootMismatches(armProfile("eidnara-kl"), on)).toEqual([
        "1 Pi boots registered the transform, but the arm declares Eidnara compaction off",
    ]);
    expect(bootMismatches(armProfile("eidnara"), off)).toEqual([
        "1 Pi boots registered no transform, but the arm declares Eidnara compaction on",
    ]);
});

test("a knowledge-only arm whose pass narrowed the host's messages or that called the history summarizer is a mismatch", () => {
    const narrowed = observeArm("eidnara-kl", "pi", captured(armRoot([PI_OFF, PASS]), []), {
        agent: 3,
        history_summarizer: 1,
    });
    expect(narrowed.transform_passes).toBe(1);
    expect(narrowed.narrowing_passes).toBe(1);
    expect(armMismatches(narrowed)).toEqual([
        "1 transform passes served fewer messages than they took, but the arm declares Eidnara compaction off",
        "1 history_summarizer calls, but the arm declares Eidnara compaction off",
    ]);
    const additive = observeArm("eidnara-kl", "pi", captured(armRoot([PI_OFF, ADDITIVE]), []), {
        agent: 3,
        memory_capture: 1,
    });
    expect(additive.narrowing_passes).toBe(0);
    expect(armMismatches(additive)).toEqual([]);
    const cut = observeArm(
        "eidnara-kl",
        "pi",
        captured(armRoot([PI_OFF, ADDITIVE, PASS.split(" in=")[0] as string]), []),
        {
            agent: 3,
        },
    );
    expect(cut.unsized_passes).toBe(1);
    expect(armMismatches(cut)).toEqual([
        "1 transform passes logged no message counts, so the arm's Eidnara compaction off is unverified for them",
    ]);
    const unserved = observeArm("eidnara-kl", "pi", captured(armRoot([PI_OFF]), []), {
        agent: 3,
    });
    expect(armMismatches(unserved)).toEqual([
        "3 agent calls and no transform pass, but the arm loads the Eidnara plugin",
    ]);
});

test("a fallback-search arm that answered agent calls with no transform pass is a mismatch", () => {
    const observed = observeArm("eidnara", "pi", captured(armRoot([PI_ON])), { agent: 2 });
    expect(armMismatches(observed)).toEqual([
        "2 agent calls and no transform pass, but the arm loads the Eidnara plugin",
    ]);
    const served = observeArm("eidnara", "pi", captured(armRoot([PI_ON, PASS])), { agent: 2 });
    expect(armMismatches(served)).toEqual([]);
});

test("search results are checked against the route the arm declares", () => {
    const searched = () =>
        armRoot(
            [PI_ON, PASS],
            [LEGACY, FUSED, "Found 0 results", "Error: the memory search route answered refused"],
        );
    const root = captured(searched());
    const fallback = observeArm("eidnara", "pi", root, { agent: 1 });
    expect(fallback.search).toEqual({
        legacy_scan: ["disabled"],
        fused: 2,
        errored: 1,
        contested: 0,
    });
    expect(armMismatches(fallback)).toEqual([
        "2 eidnara_search results came from the fused route, but the arm declares legacy-scan",
    ]);
    const legacyOnly = observeArm("eidnara", "pi", armRoot([PI_ON, PASS], [LEGACY]), {});
    expect(armMismatches(legacyOnly)).toEqual([]);
    const hybridRoot = captured(searched());
    daemonLog(hybridRoot, [READY, ROUTE]);
    const hybrid = observeArm("eidnara-hybrid", "pi", hybridRoot, { agent: 1 });
    expect(armMismatches(hybrid)).toEqual([
        "1 eidnara_search results came from the legacy snapshot scan (disabled), but the arm declares the fused route",
    ]);
    expect(observeArm("eidnara", "opencode", root, { agent: 1 }).search).toBeNull();
});

const READY = '{"catalog":["context","local_embeddings"],"model_workers":8,"status":"ready"}';
const ROUTE =
    "direct_host_fixture: search route production, embedding model gte-modernbert-base-f32, payload /p/payload-manifest.json, admission from fixture records";
const daemonLog = (root: string, lines: string[]) =>
    writeFileSync(join(root, "..", "daemon.log"), `${lines.join("\n")}\n`);

test("every daemon start of the fused arm logs the production route over its embedding model", () => {
    const root = captured(armRoot([PI_ON, PASS], [FUSED]));
    daemonLog(root, [READY, ROUTE, "eidnara-pass-timing session=sim-s-0000", READY, ROUTE]);
    const hybrid = observeArm("eidnara-hybrid", "pi", root, { agent: 1 });
    expect(hybrid.daemon_routes).toEqual({
        ready: 2,
        production: 2,
        models: ["gte-modernbert-base-f32"],
    });
    expect(armMismatches(hybrid)).toEqual([]);
    daemonLog(root, [READY, ROUTE, READY, ROUTE.replace("gte-modernbert-base-f32", "other-f32")]);
    expect(armMismatches(observeArm("eidnara-hybrid", "pi", root, { agent: 1 }))).toEqual([
        "the production search route ran embedding model other-f32, but the arm requires gte-modernbert-base-f32",
    ]);
    daemonLog(root, [READY, ROUTE, READY]);
    expect(armMismatches(observeArm("eidnara-hybrid", "pi", root, { agent: 1 }))).toEqual([
        "1 of 2 daemon starts logged no production search route",
    ]);
    // Two route lines after one ready record stand for that generation alone.
    daemonLog(root, [READY, ROUTE, ROUTE, READY]);
    expect(armMismatches(observeArm("eidnara-hybrid", "pi", root, { agent: 1 }))).toEqual([
        "1 of 2 daemon starts logged no production search route",
    ]);
    daemonLog(root, []);
    expect(armMismatches(observeArm("eidnara-hybrid", "pi", root, { agent: 1 }))).toEqual([
        "daemon.log records no ready daemon, so the production search route is unverified",
    ]);
    const legacy = captured(armRoot([PI_ON, PASS]));
    daemonLog(legacy, [READY, ROUTE]);
    expect(armMismatches(observeArm("eidnara", "pi", legacy, { agent: 1 }))).toEqual([
        "the daemon logged the production search route (gte-modernbert-base-f32), but the arm declares legacy-scan",
    ]);
    const errored = captured(armRoot([PI_ON, PASS], ["Error: the memory search route refused"]));
    daemonLog(errored, [READY, ROUTE]);
    expect(armMismatches(observeArm("eidnara-hybrid", "pi", errored, { agent: 1 }))).toEqual([
        "1 of 1 eidnara_search results errored on the fused route (answered share 0.000, required above 0.5)",
    ]);
    // The fused route is the arm's search path while it answers more searches than it refuses.
    const share = (results: string[]) => {
        const root = captured(armRoot([PI_ON, PASS], results));
        daemonLog(root, [READY, ROUTE]);
        return armMismatches(observeArm("eidnara-hybrid", "pi", root, { agent: 1 }));
    };
    const refused =
        "Error: Memory results may lag recent changes; the projector has not caught up.";
    expect(share([FUSED, FUSED, refused])).toEqual([]);
    expect(share([FUSED, refused])).toEqual([
        "1 of 2 eidnara_search results errored on the fused route (answered share 0.500, required above 0.5)",
    ]);
    expect(share([FUSED, refused, refused])).toEqual([
        "2 of 3 eidnara_search results errored on the fused route (answered share 0.333, required above 0.5)",
    ]);
});

test("delivery evidence must match the statements the final store holds", () => {
    const root = captured(armRoot([PI_ON, PASS]));
    const db = new Database(join(root, "..", "final-store", "kernel.sqlite"));

    const payload = (session: string) =>
        new TextEncoder().encode(
            JSON.stringify({
                summary: "User stated: Use tabs.",
                rationale: JSON.stringify({ session }),
            }),
        );
    db.run("insert into decisions values ('stm_e', ?, 99)", [payload("sim-s-0002")]);
    db.run(
        "insert into decisions values ('stm_a', ?, 1), ('stm_b', ?, 1), ('stm_c', ?, 7), ('mem_d', ?, 1)",
        [
            payload("sim-s-0001"),
            payload("sim-s-0001"),
            new TextEncoder().encode("not json"),
            payload("sim-s-0009"),
        ],
    );
    // Two captured facts name a lifetime class; the second one's commit is absent from the log.
    const classed = (lifetime: string) =>
        new TextEncoder().encode(
            JSON.stringify({
                summary: "User stated: Ship the parser first.",
                rationale: JSON.stringify({ session: "sim-s-0001", lifetime }),
            }),
        );
    db.run("insert into decisions values ('mem_f', ?, 1), ('mem_g', ?, 99)", [
        classed("current_work"),
        classed("lasting"),
    ]);
    // Two statements quote one user message and a third quotes another; stm_e's commit is absent.
    const message = (digit: string) => `memory_capture_statement:${digit.repeat(32)}`;
    db.run(
        "insert into object_registry values ('stm_a', 'decision', 'user', 1, null, ?), ('stm_b', 'decision', 'user', 1, null, ?), ('stm_c', 'decision', 'user', 7, null, ?), ('stm_e', 'decision', 'user', 99, null, ?)",
        [message("a"), message("a"), message("b"), message("c")],
    );
    db.close();
    const observe = (arm: string, components: Record<string, number>) =>
        observeArm(arm, "pi", root, components);
    // stm_e's commit is absent from the log, so a partial store left it behind. Of the committed
    // facts, mem_d names no lifetime class and mem_f names one.
    expect(observe("eidnara", {}).statements).toEqual({
        count: 3,
        sessions: ["sim-s-0001"],
        unattributed: 1,
        error: null,
        lifetimes: { current_work: 1 },
        lineages: { count: 2, largest: 2, per_message: 3 },
    });
    const delivery = (memory_blocks: number, memory_due = true, due_blocks = memory_blocks) => ({
        requests: 3,
        unreadable: 0,
        injected_blocks: memory_blocks,
        notes: { expected: 0, delivered: 0, missing: [], misplaced: [] },
        memory_blocks,
        sessions: 2,
        memory_due,
        due_blocks,
    });
    const auto = observe("eidnara", { agent: 3, memory_capture: 1 });
    auto.delivery = delivery(0);
    expect(armMismatches(auto)).toEqual([
        "the final store holds 3 user statements captured before later sessions' agent requests, but none of those requests carried a <project-memory> block",
    ]);
    auto.delivery = delivery(1);
    expect(armMismatches(auto)).toEqual([]);
    // A block only before the statement came due proves nothing about its delivery.
    auto.delivery = delivery(1, true, 0);
    expect(armMismatches(auto)).toHaveLength(1);
    auto.delivery = delivery(0, false);
    expect(armMismatches(auto)).toEqual([]);
    // Every session that owes a block must carry one; a block in some sessions leaves the rest owed.
    const sessions = (due: number, uncovered: string[]) => ({
        ...delivery(2),
        due_sessions: due,
        covered_sessions: due - uncovered.length,
        uncovered_sessions: uncovered,
    });
    auto.delivery = sessions(3, []);
    expect(armMismatches(auto)).toEqual([]);
    auto.delivery = sessions(3, ["s-0004"]);
    expect(armMismatches(auto)).toEqual([
        "2 of 3 sessions that owe a <project-memory> block carried one (coverage 0.667, required 1); none in s-0004",
    ]);
    const many = Array.from({ length: 23 }, (_, i) => `s-${String(i + 10).padStart(4, "0")}`);
    auto.delivery = sessions(25, many);
    expect(armMismatches(auto)).toEqual([
        `2 of 25 sessions that owe a <project-memory> block carried one (coverage 0.080, required 1); none in ${many.slice(0, 20).join(", ")} and 3 more`,
    ]);
    // The explicit-search arm owes no block, so its coverage is not judged.
    const searched = observe("eidnara-search", { agent: 3, memory_capture: 1 });
    searched.search = { legacy_scan: ["x"], fused: 0, errored: 0 };
    searched.delivery = { ...sessions(3, ["s-0004"]), injected_blocks: 0 };
    expect(armMismatches(searched)).toEqual([]);
    const explicit = observe("eidnara-search", { agent: 3, memory_capture: 1 });
    explicit.delivery = delivery(0);
    expect(armMismatches(explicit)).toEqual([
        "the final store holds 3 user statements captured before later sessions' agent requests, but the agent never called eidnara_search on an arm that declares explicit search",
    ]);
    const broken = captured(armRoot([PI_ON, PASS]));
    const unreadable = observeArm("eidnara", "pi", broken, { agent: 3, memory_capture: 1 });
    unreadable.statements = { count: 0, sessions: [], unattributed: 0, error: "no such table" };
    unreadable.delivery = delivery(1, false);
    expect(armMismatches(unreadable)).toEqual([
        "the final store's user statements cannot be read: no such table",
    ]);
    const silent = observe("eidnara", { agent: 3 });
    silent.delivery = delivery(1);
    expect(armMismatches(silent)).toEqual([
        "agent requests in 2 sessions and no memory_capture call in the proxy records",
    ]);
});

test("the capability check reads the counter total over an arm's daemon generations", () => {
    const root = captured(armRoot([PI_ON, PASS]), ["messages"]);
    const write = (record: object) =>
        writeFileSync(join(root, "..", "source-capture.json"), JSON.stringify(record));
    const total = { admitted: 4, completed: 4, decisions_approval_refused: 0 };
    write({ counters: total, error: null, unread_generations: 1, generations: [] });
    const read = observeArm("eidnara", "pi", root, { agent: 1 });
    expect(read.source_capture).toMatchObject({
        counters: total,
        counters_error: null,
        unread_generations: 1,
    });
    expect(armMismatches(read)).toEqual([]);
    // A total beside a failed finish read is unread.
    write({ counters: total, error: "the counter read did not finish", unread_generations: 1 });
    const failed = observeArm("eidnara", "pi", root, { agent: 1 });
    expect(failed.source_capture?.unread_generations).toBe(1);
    expect(armMismatches(failed)).toEqual([
        "source capture counters unread: the record also reports the counter read did not finish",
    ]);
    // A count is a non-negative integer; zero is a count, a negative one is none.
    const count = (unread_generations: number) => {
        write({ counters: total, error: null, unread_generations });
        return observeArm("eidnara", "pi", root, { agent: 1 }).source_capture?.unread_generations;
    };
    expect(count(0)).toBe(0);
    expect(count(-1)).toBeNull();
});

test("an arm that consents to source capture must leave message descriptors and counters, and one without it none", () => {
    const ok = observeArm(
        "eidnara",
        "pi",
        captured(armRoot([PI_ON, PASS]), ["messages", "raw_tool_spans"]),
        {
            agent: 2,
        },
    );
    expect(ok.source_capture).toEqual({
        descriptors: { messages: 1, raw_tool_spans: 1 },
        live: 1,
        counters: COUNTERS,
        counters_error: null,
        unread_generations: null,
    });
    expect(armMismatches(ok)).toEqual([]);
    const missing = observeArm("eidnara", "pi", armRoot([PI_ON, PASS]), { agent: 2 });
    expect(armMismatches(missing)).toEqual([
        "the final Kernel store is absent or unreadable, so source capture is unverified",
        "source capture counters unread: source-capture.json was not written",
    ]);
    const toolsOnly = observeArm(
        "eidnara-cf",
        "pi",
        captured(armRoot([PI_ON, PASS]), ["raw_tool_spans"], null),
        { agent: 2 },
    );
    expect(armMismatches(toolsOnly)).toEqual([
        'the final store holds no message source descriptor ({"raw_tool_spans":1}), but the arm declares source capture on',
        "source capture counters unread: fixture control timed out",
    ]);
    const empty = observeArm("eidnara", "pi", captured(armRoot([PI_ON, PASS]), ["messages"], {}), {
        agent: 2,
    });
    expect(armMismatches(empty)).toEqual(["source capture counters unread: malformed counters {}"]);
    const shifted = observeArm(
        "eidnara",
        "pi",
        captured(armRoot([PI_ON, PASS]), ["messages"], { admitted: 1, completed: -1 }),
        { agent: 2 },
    );
    expect(armMismatches(shifted)[0]).toMatch(
        /^source capture counters unread: malformed counters/,
    );
    const nulls = (counters: Record<string, unknown>) =>
        armMismatches(
            observeArm(
                "eidnara",
                "pi",
                captured(armRoot([PI_ON, PASS]), ["messages"], counters as Record<string, number>),
                { agent: 2 },
            ),
        );
    expect(
        nulls({
            admitted: 1,
            completed: 1,
            decisions_approval_refused: 0,
            oldest_deferred_age_ms: null,
        }),
    ).toEqual([]);
    const both = captured(armRoot([PI_ON, PASS]));
    writeFileSync(
        join(both, "..", "source-capture.json"),
        JSON.stringify({ counters: { admitted: 1, completed: 1 }, error: "timed out" }),
    );
    expect(armMismatches(observeArm("eidnara", "pi", both, { agent: 2 }))).toEqual([
        "source capture counters unread: the record also reports timed out",
    ]);
    const deferred = observeArm(
        "eidnara",
        "pi",
        captured(armRoot([PI_ON, PASS]), ["messages"], {
            admitted: 1,
            completed: 1,
            oldest_deferred_age_ms: null,
        } as unknown as Record<string, number>),
        { agent: 2 },
    );
    expect(deferred.source_capture?.counters).toEqual({
        admitted: 1,
        completed: 1,
        oldest_deferred_age_ms: null,
    });
    const orphaned = captured(armRoot([PI_ON, PASS]));
    const db = new Database(join(orphaned, "..", "final-store", "kernel.sqlite"));
    db.run(
        "insert into object_registry values ('srcdesc:z:1', 'observation', 'messages', 9, null, '')",
    );
    db.close();
    expect(armMismatches(observeArm("eidnara", "pi", orphaned, { agent: 2 }))).toEqual([
        "the final Kernel store is absent or unreadable, so source capture is unverified",
    ]);
    expect(nulls({ admitted: 1, completed: 1, units_published: null })[0]).toMatch(/malformed/);
    // An arm that never reached an agent call has nothing for capture to retain.
    expect(armMismatches(observeArm("eidnara", "pi", armRoot([PI_ON]), {}))).toEqual([]);
    const kl = observeArm("eidnara-kl", "pi", captured(armRoot([PI_OFF, ADDITIVE])), { agent: 2 });
    expect(armMismatches(kl)).toEqual([
        "1 source descriptors in the final store, but the arm declares source capture off",
    ]);
    const klUnread = observeArm("eidnara-kl", "pi", armRoot([PI_OFF, ADDITIVE]), { agent: 2 });
    expect(armMismatches(klUnread)).toEqual([
        "the final Kernel store is absent or unreadable, so source capture off is unverified",
    ]);
    const klClean = observeArm("eidnara-kl", "pi", captured(armRoot([PI_OFF, ADDITIVE]), []), {
        agent: 2,
    });
    expect(armMismatches(klClean)).toEqual([]);
});

test("a host-only arm with a plugin boot or Eidnara calls is a mismatch", () => {
    const empty = join(tmp(), "r");
    mkdirSync(empty);
    const clean = observeArm("host", "pi", empty, { agent: 4, "user-sim": 1 });
    expect(armMismatches(clean)).toEqual([]);
    const booted = observeArm("host~aa", "pi", armRoot([PI_ON]), { memory_capture: 2 });
    expect(armMismatches(booted)).toEqual([
        "the Eidnara plugin booted 1 times on a host-only arm",
        "2 memory_capture calls on a host-only arm",
    ]);
});

test("a plugin log the agent replaced with a link is refused rather than read", () => {
    const root = join(tmp(), "r");
    mkdirSync(root);
    writeFileSync(join(root, "elsewhere"), `${PI_ON}\n`);
    symlinkSync(join(root, "elsewhere"), join(root, "eidnara.log"));
    expect(() => readPluginLog(join(root, "eidnara.log"))).toThrow(/cannot be read as evidence/);
});

test("a session's boots are read from the log's length when its host started", () => {
    const root = armRoot([PI_ON]);
    const log = join(root, "eidnara.log");
    const mark = logLength(log);
    appendFileSync(log, `${PASS}\n`);
    const later = readPluginLog(log, mark);
    expect(later.transform_passes).toBe(1);
    expect(bootMismatches(armProfile("eidnara"), later)).toEqual([
        "the Eidnara plugin log records no enabled boot",
    ]);
    expect(bootMismatches(armProfile("eidnara"), readPluginLog(log))).toEqual([]);
});

test("a Pi boot that names neither transform mode is a mismatch on every Eidnara arm", () => {
    const odd = readPluginLog(
        join(
            armRoot([`${T} [eidnara][pi] registered tools: eidnara_search, eidnara_memory`]),
            "eidnara.log",
        ),
    );
    expect(odd.boots.transform_unknown).toBe(1);
    for (const arm of ["eidnara", "eidnara-kl"]) {
        expect(bootMismatches(armProfile(arm), odd)).toEqual([
            "1 Pi boots registered tools in no recognised transform mode",
        ]);
    }
});

describe("audited daemon capabilities", () => {
    const git = (dir: string, ...args: string[]) => {
        const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
        if (r.exitCode !== 0) throw new Error(r.stderr.toString());
        return r.stdout.toString().trim();
    };
    const commit = (dir: string, file: string, text: string) => {
        mkdirSync(join(dir, file, ".."), { recursive: true });
        writeFileSync(join(dir, file), text);
        git(dir, "add", "-A");
        git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", file);
        return git(dir, "rev-parse", "HEAD");
    };

    test("a checkout without the audited commit is refused for every daemon arm", () => {
        const repo = tmp();
        git(repo, "init", "-q");
        commit(repo, "crates/daemon/examples/direct_host_fixture.rs", "fn main() {}\n");
        // Each registered build names why the clone cannot bind it.
        for (const build of AUDITED_BUILDS) {
            expect(() => requireAuditedVariants(repo, ["eidnara"])).toThrow(
                new RegExp(`lacks commit ${build.commit} \\(${build.label}\\)`),
            );
        }
        expect(requireAuditedVariants(repo, ["host"])).toBeNull();
    });

    test("a fixture source that changed since the audited commit is refused; other files pass", () => {
        const repo = tmp();
        git(repo, "init", "-q");
        const head = commit(repo, "crates/daemon/examples/direct_host_fixture.rs", "a\n");
        const audited = [{ commit: head, label: "test", variants: DAEMON_VARIANTS }];
        commit(repo, "README.md", "unrelated\n");
        expect(requireAuditedVariants(repo, ["eidnara", "host"], audited)).toBe(
            audited[0] as AuditedBuild,
        );
        writeFileSync(join(repo, "crates/daemon/examples/direct_host_fixture.rs"), "edited\n");
        expect(() => requireAuditedVariants(repo, ["eidnara"], audited)).toThrow(
            /direct_host_fixture.rs changed since/,
        );
        commit(repo, "crates/daemon/examples/direct_host_fixture.rs", "b\n");
        expect(() => requireAuditedVariants(repo, ["eidnara-kl"], audited)).toThrow(
            /direct-host-fixture capabilities were read at .*crates\/daemon\/examples\/direct_host_fixture.rs changed since/,
        );
    });

    test("a clone binds the registered build its sources match, and a build without the arm's variant is passed over", () => {
        const repo = tmp();
        git(repo, "init", "-q");
        const fixture = "crates/daemon/examples/direct_host_fixture.rs";
        const old = commit(repo, fixture, "old\n");
        const now = commit(repo, fixture, "new\n");
        const legacy = DAEMON_VARIANTS["direct-host-fixture"];
        const builds: AuditedBuild[] = [
            { commit: now, label: "new", variants: DAEMON_VARIANTS },
            { commit: old, label: "old", variants: { "direct-host-fixture": legacy } },
        ];
        expect(requireAuditedVariants(repo, ["eidnara"], builds)?.label).toBe("new");
        git(repo, "checkout", "-q", old);
        expect(requireAuditedVariants(repo, ["eidnara"], builds)?.label).toBe("old");
        // The old build registers the legacy fixture alone, so a fused arm binds neither build.
        mkdirSync(join(repo, "packages/host-linux-x64-gnu"), { recursive: true });
        writeFileSync(join(repo, "packages/host-linux-x64-gnu/payload-manifest.json"), "{}\n");
        expect(() => requireAuditedVariants(repo, ["eidnara-hybrid"], builds)).toThrow(
            /direct_host_fixture.rs changed since; .*old \(.*\) registers no direct-host-fixture-fused variant/,
        );
        expect(capabilityGaps("eidnara-hybrid", builds[1])).toEqual([
            expect.stringContaining("which the audited build old"),
        ]);
        expect(capabilityGaps("eidnara", builds[1])).toEqual([]);
    });
});

test("open-item lines follow the renderer's grammar inside one history block", () => {
    const block = (...segments: string[]) =>
        `<session-history>\n${segments.join("\n")}\n</session-history>`;
    const waiting = "## 1-2 \u00b7 A\n* Waiting on user (scope.next): continue in that order?";
    // A body line that starts with `## ` renders indented, and prose that mentions a form is no status line.
    const prose =
        "## 3-4 \u00b7 B\n ## 9-9 \u00b7 nested\nStill open: Waiting on user (scope.next): same.";
    const lifted = "## 5-6 \u00b7 C\nLifted (bugs.freeze): product fixes are allowed again.";
    expect(openItemsOf(block(waiting, prose))).toEqual({ blocks: 1, waiting: 1, stale: 0 });
    expect(openItemsOf(block(waiting, prose, lifted))).toEqual({ blocks: 1, waiting: 1, stale: 1 });
    expect(openItemsOf(block(lifted, waiting))).toEqual({ blocks: 1, waiting: 1, stale: 0 });
    expect(openItemsOf("<session-history></session-history>")).toEqual({
        blocks: 0,
        waiting: 0,
        stale: 0,
    });
});

test("daemon status readings are totalled from the resource samples", () => {
    const dir = tmp();
    const path = join(dir, "resources.jsonl");
    const memory = (anon: number, releases: number) => ({
        rss_anon_bytes: anon,
        rss_file_bytes: 2048,
        rss_shmem_bytes: null,
        threads: 11,
        c_heap_release_resident_drop_bytes: 0,
        c_heap: { in_use_bytes: 1, free_bytes: 2, mmapped_bytes: 3 },
        c_heap_arena_limit: 4,
        c_heap_releases: releases,
    });
    const progress = (lag: number | null, blocked: string | null = null) => ({
        tip: 5000,
        checkpoint: lag === null ? null : 5000 - lag,
        lag_commits: lag,
        rebuilds: { recorded: 2, completed: 1, renewed: 1 },
        blocked,
    });
    const search = (state: string, admission: string, lag: number | null, blocked?: string) => ({
        state,
        admission,
        progress: progress(lag, blocked),
    });
    const samples = [
        { pid: null, daemon_status: null },
        { pid: 7, daemon_status: null },
        {
            pid: 7,
            daemon_status: {
                process_memory: memory(100, 0),
                search: search("current", "admitted", 0),
            },
        },
        // One commit past the fixture's reader bound, a rebuild in progress, and a refused admission are not served.
        {
            pid: 7,
            daemon_status: {
                process_memory: memory(300, 2),
                search: search("current", "admitted", 1025),
            },
        },
        {
            pid: 7,
            daemon_status: { process_memory: null, search: search("intent", "admitted", 3) },
        },
        {
            pid: 7,
            daemon_status: {
                process_memory: memory(200, 3),
                search: search("current", "refused", 1024, "the database occupies too many bytes"),
            },
        },
        { pid: 7, daemon_status: { process_memory: null, search: null, error: "timed out" } },
        // An array where a block belongs is no block.
        { pid: 7, daemon_status: { process_memory: [], search: { progress: [] } } },
    ];
    writeFileSync(path, `${samples.map((s) => JSON.stringify(s)).join("\n")}\nnot json\n`);
    expect(readDaemonStatus(path)).toEqual({
        samples: 7,
        readings: 5,
        read_errors: 1,
        process_memory: 3,
        max_rss_anon_bytes: 300,
        c_heap_releases: 3,
        search_progress: {
            samples: 4,
            served: 1,
            max_lag_commits: 1025,
            last_lag_commits: 1024,
            rebuilds: { recorded: 2, completed: 1, renewed: 1 },
            blocked: 1,
        },
    });
    // A block counts only in the shape Eidnara writes it: a progress block without a whole
    // rebuild count, and a process_memory block without its release totals, are no evidence.
    const partial = {
        pid: 7,
        daemon_status: {
            process_memory: { rss_anon_bytes: 9_000 },
            search: search("current", "admitted", 0),
        },
    };
    (partial.daemon_status.search.progress.rebuilds as Record<string, unknown>).renewed = null;
    appendFileSync(path, `${JSON.stringify(partial)}\n`);
    expect(readDaemonStatus(path)).toMatchObject({
        readings: 6,
        process_memory: 3,
        max_rss_anon_bytes: 300,
        search_progress: { samples: 4, rebuilds: { recorded: 2, completed: 1, renewed: 1 } },
    });
    expect(readDaemonStatus(join(dir, "absent.jsonl")).samples).toBe(0);
});

test("evidence is read against the capabilities of the build the run bound", () => {
    const current = AUDITED_BUILDS[0];
    const c8 = AUDITED_BUILDS.find((b) => b.label === "eval/c8") as AuditedBuild;
    const root = captured(armRoot([PI_ON, PASS]));
    daemonLog(root, []);
    const base = observeArm("eidnara", "pi", root, { agent: 2, memory_capture: 1 });
    expect(armMismatches(base, current)).toEqual([]);
    // The c8 daemon reports no refused-approval counter, so the current counters contradict it.
    expect(armMismatches(base, c8)).toEqual([
        "the source capture counters hold decisions_approval_refused, which eval/c8 does not declare",
    ]);
    const old = { admitted: 1, completed: 1 };
    const c8Root = captured(armRoot([PI_ON, PASS]), ["messages"], old);
    daemonLog(c8Root, []);
    const reference = observeArm("eidnara", "pi", c8Root, { agent: 2, memory_capture: 1 });
    expect(armMismatches(reference, c8)).toEqual([]);
    expect(armMismatches(reference, current)).toEqual([
        `the source capture counters hold no decisions_approval_refused, which ${current.label} declares with its per-message statement lineage`,
    ]);

    const statements = (per_message: number) => ({
        count: 70,
        sessions: ["sim-s-0001"],
        unattributed: 0,
        error: null,
        lineages: { count: per_message === 0 ? 1 : 9, largest: 64, per_message },
    });
    expect(armMismatches({ ...base, statements: statements(70) }, current)).toEqual([]);
    expect(armMismatches({ ...base, statements: statements(6) }, current)).toEqual([
        `64 of 70 user statements sit on a lineage shared across messages, but ${current.label} declares one lineage per user message`,
    ]);
    expect(armMismatches({ ...reference, statements: statements(0) }, c8)).toEqual([]);
    expect(armMismatches({ ...reference, statements: statements(6) }, c8)).toEqual([
        "6 of 70 user statements sit on a per-message lineage, but eval/c8 declares one shared lineage",
    ]);
    const split = { ...statements(0), lineages: { count: 2, largest: 40, per_message: 0 } };
    expect(armMismatches({ ...reference, statements: split }, c8)).toEqual([
        "70 user statements sit on 2 lineages, but eval/c8 declares one shared lineage",
    ]);
    // A lifetime class in a fact's rationale is the w3 build's; an earlier build writes none.
    const classed = { ...statements(70), lifetimes: { lasting: 3, current_work: 2 } };
    const w2b = auditedBuild("eval/w2b") as AuditedBuild;
    expect(armMismatches({ ...base, statements: classed }, current)).toEqual([]);
    expect(armMismatches({ ...base, statements: { ...classed, lifetimes: {} } }, current)).toEqual(
        [],
    );
    expect(armMismatches({ ...base, statements: classed }, w2b)).toEqual([
        "5 captured facts name a lifetime class in their rationale, which eval/w2b does not declare",
    ]);

    const delivery = (contested_blocks: number, stale: number) => ({
        requests: 3,
        unreadable: 0,
        injected_blocks: 1,
        notes: { expected: 0, delivered: 0, missing: [], misplaced: [] },
        contested_blocks,
        open_items: {
            blocks: 5,
            waiting_blocks: 2,
            stale_waiting_blocks: stale,
            stale_requests: stale > 0 ? [41] : [],
        },
    });
    expect(armMismatches({ ...base, delivery: delivery(2, 0) }, current)).toEqual([]);
    expect(armMismatches({ ...base, delivery: delivery(0, 1) }, current)).toEqual([
        `1 of 5 rendered history blocks hold a waiting line before a later summarized segment (first requests 41), but ${current.label} declares waiting lines in the newest segment alone`,
    ]);
    // The c8 renderer keeps a settled waiting line across segments, and renders no contest.
    expect(armMismatches({ ...reference, delivery: delivery(0, 1) }, c8)).toEqual([]);
    expect(armMismatches({ ...reference, delivery: delivery(2, 0) }, c8)).toEqual([
        "2 agent requests and 0 eidnara_search results render a contested statement, which eval/c8 does not declare",
    ]);

    const status = (process_memory: number, progress: number, readings = 8, read_errors = 0) => ({
        samples: 9,
        readings,
        read_errors,
        process_memory,
        max_rss_anon_bytes: null,
        c_heap_releases: null,
        search_progress: {
            samples: progress,
            served: progress,
            max_lag_commits: null,
            last_lag_commits: null,
            rebuilds: null,
            blocked: 0,
        },
    });
    expect(armMismatches({ ...base, daemon_status: status(8, 0) }, current)).toEqual([]);
    expect(armMismatches({ ...base, daemon_status: status(0, 0) }, current)).toEqual([
        `none of 8 daemon status readings carries the process_memory block, which ${current.label} declares`,
    ]);
    // A read returns after the sample that started it: an arm too short for one owes no block,
    // and an arm whose every read failed leaves the status unverified.
    expect(armMismatches({ ...base, daemon_status: status(0, 0, 0) }, current)).toEqual([]);
    expect(armMismatches({ ...base, daemon_status: status(0, 0, 0, 5) }, current)).toEqual([
        `all 5 daemon status reads failed, so the status ${current.label} declares is unverified`,
    ]);
    expect(armMismatches({ ...reference, daemon_status: status(0, 0) }, c8)).toEqual([]);
    expect(armMismatches({ ...reference, daemon_status: status(8, 0) }, c8)).toEqual([
        "8 daemon status readings carry a process_memory block, which eval/c8 does not declare",
    ]);
    const fused = captured(armRoot([PI_ON, PASS], [FUSED]));
    daemonLog(fused, [READY, ROUTE]);
    const hybrid = observeArm("eidnara-hybrid", "pi", fused, { agent: 1 });
    expect(armMismatches({ ...hybrid, daemon_status: status(8, 8) }, current)).toEqual([]);
    expect(armMismatches({ ...hybrid, daemon_status: status(8, 0) }, current)).toEqual([
        `none of 8 daemon status readings carries a search.lifecycle.status progress block, which ${current.label} declares for the fused route`,
    ]);
});

test("a search result that renders a contest is counted", () => {
    const contested = `Found 1 result\n[1] [memory] id=mem_a\nUser stated: The limit is 300.\nContested by mem_b: "Assistant reported: the file holds 500."`;
    const root = captured(armRoot([PI_ON, PASS], [`${LEGACY}\n${contested}`, LEGACY]));
    expect(observeArm("eidnara", "pi", root, { agent: 1 }).search).toMatchObject({ contested: 1 });
});

test("a transcript directory the agent replaced with a link is refused rather than walked", () => {
    const root = armRoot([PI_ON, PASS], [LEGACY]);
    const outside = join(tmp(), "outside");
    mkdirSync(join(outside, "--ws--"), { recursive: true });
    writeFileSync(join(outside, "--ws--", "x.jsonl"), "");
    rmSync(join(root, "home/.pi/agent/sessions"), { recursive: true });
    symlinkSync(outside, join(root, "home/.pi/agent/sessions"));
    expect(() => observeArm("eidnara", "pi", root, { agent: 1 })).toThrow(
        /link or not a directory/,
    );
});

test("a hard-linked plugin log is refused rather than read", () => {
    const root = armRoot([PI_ON]);
    linkSync(join(root, "eidnara.log"), join(root, "second-name"));
    expect(() => readPluginLog(join(root, "eidnara.log"))).toThrow(/single-link regular file/);
});

const POINT = { cachePoint: { type: "default" } };

test("cache points are counted in a system part, a message, and a tool list", () => {
    expect(cachePointsOf({ field: "system", value: [{ text: "s" }, POINT] })).toBe(1);
    expect(
        cachePointsOf({
            field: "messages",
            value: { role: "user", content: [{ text: "a" }, POINT, { text: "b" }, POINT] },
        }),
    ).toBe(2);
    expect(
        cachePointsOf({
            field: "toolConfig",
            value: { tools: [{ toolSpec: { name: "x" } }, POINT] },
        }),
    ).toBe(1);
    // A text that names a cache point is text.
    expect(
        cachePointsOf({
            field: "messages",
            value: { role: "user", content: [{ text: '{"cachePoint":{"type":"default"}}' }] },
        }),
    ).toBe(0);
    expect(cachePointsOf({ field: "inferenceConfig", value: { maxTokens: 1 } })).toBe(0);
    expect(cachePointsOf({ field: "messages", value: [] })).toBe(0);
});

test("an arm's caching observation counts requests with cache points and the cache tokens by component", () => {
    const parts = new Map<string, RequestPart>([
        ["sys", { field: "system", value: [{ text: "s" }] }],
        ["sys+", { field: "system", value: [{ text: "s" }, POINT] }],
        ["u1", { field: "messages", value: { role: "user", content: [{ text: "a" }] } }],
        ["u1+", { field: "messages", value: { role: "user", content: [{ text: "a" }, POINT] } }],
    ]);
    const tokens = { input_tokens: 4, cache_read_tokens: 100, cache_write_tokens: 10 };
    const request = (ids: string[]) => ({ sha256: "x", bytes: 1, parts: ids });
    const tally = new CachingTally(parts);
    tally.add({ component: "agent", request: request(["sys+", "u1+"]), ...tokens });
    tally.add({ component: "agent", request: request(["sys", "u1+"]), ...tokens });
    tally.add({ component: "agent", ...tokens });
    tally.add({ component: "memory_capture", request: request(["sys", "u1"]), ...tokens });
    tally.add({ component: "other", request: request(["sys", "u1"]), ...tokens });
    tally.add({ component: "user-sim", request: request(["sys+"]), ...tokens });
    tally.add({ component: "rejected", ...tokens });
    const observed = tally.observation();
    expect(observed).toEqual({
        components: {
            agent: {
                requests: 2,
                with_cache_points: 2,
                placed_by_proxy: 0,
                with_message_points: 2,
                input_tokens: 12,
                cache_read_tokens: 300,
                cache_write_tokens: 30,
            },
            memory_capture: {
                requests: 1,
                with_cache_points: 0,
                placed_by_proxy: 0,
                with_message_points: 0,
                input_tokens: 4,
                cache_read_tokens: 100,
                cache_write_tokens: 10,
            },
            other: {
                requests: 1,
                with_cache_points: 0,
                placed_by_proxy: 0,
                with_message_points: 0,
                input_tokens: 4,
                cache_read_tokens: 100,
                cache_write_tokens: 10,
            },
        },
    });
    // A request the proxy could not attribute to a host caller is recorded and held to nothing.
    expect(cachingMismatches("on", observed)).toEqual([
        "1 of 1 memory_capture requests carry no cache point, but the run registers prompt caching on",
    ]);
    // Under `off` the host's own model matching decides, so cache points are recorded and accepted.
    expect(cachingMismatches("off", observed)).toEqual([]);
    expect(cachingMismatches("on", undefined)).toEqual([]);
    const all = new CachingTally(parts);
    all.add({ component: "agent", request: request(["sys+", "u1"]), ...tokens });
    // Pi 0.87 sends its compaction without cache points, so that caller is held to nothing.
    all.add({ component: "native_compaction", request: request(["sys", "u1"]), ...tokens });
    expect(all.observation().components.native_compaction).toMatchObject({
        requests: 1,
        with_cache_points: 0,
    });
    expect(cachingMismatches("on", all.observation())).toEqual([]);
    // A request naming a part the log lacks cannot be rebuilt, so its system point is no evidence.
    const partial = new CachingTally(parts);
    partial.add({ component: "agent", request: request(["sys+", "gone"]), ...tokens });
    expect(cachingMismatches("on", partial.observation())).toEqual([
        "1 of 1 agent requests carry no cache point, but the run registers prompt caching on",
    ]);
});

test("the capability record names the run's caching condition beside what the arm's requests show", () => {
    const observed = observeArm("host", "pi", armRoot([]), { agent: 2 });
    const counts = (with_cache_points: number) => ({
        requests: 2,
        with_cache_points,
        placed_by_proxy: 0,
        input_tokens: 8,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
    });
    observed.prompt_caching = { components: { agent: counts(0) } };
    const off = capabilityRecord(observed, null, undefined, "off");
    expect(off).toMatchObject({
        profile: armProfile("host"),
        eidnara_build: null,
        prompt_caching: "off",
        observed: { prompt_caching: { components: { agent: { with_cache_points: 0 } } } },
        mismatches: [],
    });
    expect(capabilityRecord(observed, null, undefined, "on").mismatches).toEqual([
        "2 of 2 agent requests carry no cache point, but the run registers prompt caching on",
    ]);
    // One request with a cache point leaves the other one outside the condition.
    observed.prompt_caching = { components: { agent: counts(1) } };
    expect(capabilityRecord(observed, null, undefined, "on").mismatches).toEqual([
        "1 of 2 agent requests carry no cache point, but the run registers prompt caching on",
    ]);
    observed.prompt_caching = { components: { agent: counts(2) } };
    expect(capabilityRecord(observed, null, undefined, "on")).toMatchObject({
        prompt_caching: "on",
        mismatches: [],
    });
});

test("requests counted as their calls start hold a session to the caching condition", () => {
    const live: Record<string, CachingCount> = {};
    noteRequest(live, "agent", 2);
    noteRequest(live, "agent", 0);
    noteRequest(live, "history_summarizer", 0);
    noteRequest(live, "user-sim", 0);
    expect(live.agent).toMatchObject({ requests: 2, with_cache_points: 1 });
    expect(live["user-sim"]).toBeUndefined();
    // A later request with cache points leaves an earlier one without them a mismatch.
    noteRequest(live, "history_summarizer", 2);
    expect(cachingMismatches("on", { components: live })).toEqual([
        "1 of 2 agent requests carry no cache point, but the run registers prompt caching on",
        "1 of 2 history_summarizer requests carry no cache point, but the run registers prompt caching on",
    ]);
    const clean: Record<string, CachingCount> = {};
    noteRequest(clean, "agent", 2);
    noteRequest(clean, "memory_capture", 1);
    expect(cachingMismatches("on", { components: clean })).toEqual([]);
    expect(cachingMismatches("on", { components: {} })).toEqual([]);
});

test("a daemon-run call without cache points gets Pi's two, and every other body stays as it is", () => {
    const body = (): ConverseBody => ({
        system: [{ text: "Summarize." }],
        messages: [
            { role: "user", content: [{ text: "<new_messages>" }] },
            { role: "assistant", content: [{ text: "ok" }] },
            { role: "user", content: [{ text: "more" }] },
        ],
    });
    const daemonCachePoints = placeFor("system-and-message");
    const summarizer = body();
    expect(daemonCachePoints(summarizer, "history_summarizer")).toBe(2);
    // One after the system prompt and one at the end of the last user message, as Pi places them.
    expect(summarizer.system).toEqual([{ text: "Summarize." }, POINT]);
    expect(summarizer.messages?.map((m) => m.content)).toEqual([
        [{ text: "<new_messages>" }],
        [{ text: "ok" }],
        [{ text: "more" }, POINT],
    ]);
    // A second pass finds the points and places none.
    expect(daemonCachePoints(summarizer, "history_summarizer")).toBe(0);
    expect(bodyCachePoints(summarizer)).toBe(2);
    for (const component of ["memory_classifier", "context_researcher"]) {
        expect(daemonCachePoints(body(), component)).toBe(2);
    }
    // The host's own callers place their points themselves, and Pi 0.87 sends compaction with none.
    for (const component of ["agent", "memory_capture", "native_compaction", "user-sim", "other"]) {
        const own = body();
        expect(daemonCachePoints(own, component)).toBe(0);
        expect(own).toEqual(body());
    }
    // A body with no system prompt gets the message point, and one ending on an assistant
    // message the system point.
    const bare: ConverseBody = { messages: [{ role: "user", content: [{ text: "hi" }] }] };
    expect(daemonCachePoints(bare, "history_summarizer")).toBe(1);
    expect(bare.messages?.[0]?.content).toEqual([{ text: "hi" }, POINT]);
    const prefilled: ConverseBody = {
        system: [{ text: "s" }],
        messages: [{ role: "assistant", content: [{ text: "a" }] }],
    };
    expect(daemonCachePoints(prefilled, "history_summarizer")).toBe(1);
    expect(prefilled.messages?.[0]?.content).toEqual([{ text: "a" }]);
    // A body that carries a cache point already, as OpenCode's closure sends it, is left alone.
    const cached: ConverseBody = { system: [{ text: "s" }, POINT], messages: bare.messages ?? [] };
    expect(daemonCachePoints(cached, "history_summarizer")).toBe(0);
});

test("on a build whose hook keeps a background call's cache writes to the system prompt, a daemon-run call gets that point alone", () => {
    const body = (): ConverseBody => ({
        system: [{ text: "Summarize." }],
        messages: [{ role: "user", content: [{ text: "<new_messages>" }] }],
    });
    const place = placeFor("system");
    const summarizer = body();
    expect(place(summarizer, "history_summarizer")).toBe(1);
    expect(summarizer.system).toEqual([{ text: "Summarize." }, POINT]);
    expect(summarizer.messages?.[0]?.content).toEqual([{ text: "<new_messages>" }]);
    expect(place(summarizer, "history_summarizer")).toBe(0);
    // The capture call runs in the arm's Pi, where the plugin's own code decides.
    expect(place(body(), "memory_capture")).toBe(0);
    // A body with no system prompt has no place for the point.
    const bare: ConverseBody = { messages: [{ role: "user", content: [{ text: "hi" }] }] };
    expect(place(bare, "history_summarizer")).toBe(0);
    expect(bare.messages?.[0]?.content).toEqual([{ text: "hi" }]);

    // The layout is the bound build's: every variant names one, and a manifest that names none
    // reads as Pi's own two points.
    const w3 = AUDITED_BUILDS[0];
    const w2b = auditedBuild("eval/w2b") as AuditedBuild;
    const bound = (b: AuditedBuild) => ({
        capabilities: Object.fromEntries(
            Object.entries(b.variants).map(([v, r]) => [v, capabilitiesOf(r)]),
        ),
    });
    expect(backgroundCachePointsOf(bound(w3))).toBe("system");
    expect(backgroundCachePointsOf(bound(w2b))).toBe("system-and-message");
    expect(backgroundCachePointsOf(null)).toBe("system-and-message");
    expect(backgroundCachePointsOf({ capabilities: { "direct-host-fixture": {} } })).toBe(
        "system-and-message",
    );
    for (const odd of [undefined, 7, { capabilities: null }, { capabilities: { v: null } }]) {
        expect(backgroundCachePointsOf(odd)).toBe("system-and-message");
    }
});

test("a Pi arm's background requests show the cache-point layout its build declares", () => {
    const parts = new Map<string, RequestPart>([
        ["sys+", { field: "system", value: [{ text: "s" }, POINT] }],
        ["u1", { field: "messages", value: { role: "user", content: [{ text: "a" }] } }],
        ["u1+", { field: "messages", value: { role: "user", content: [{ text: "a" }, POINT] } }],
    ]);
    const tokens = { input_tokens: 4, cache_read_tokens: 100, cache_write_tokens: 10 };
    const request = (ids: string[]) => ({ sha256: "x", bytes: 1, parts: ids });
    const observe = (capture: string[], summarizer: string[], placed = 0) => {
        const tally = new CachingTally(parts);
        tally.add({ component: "agent", request: request(["sys+", "u1+"]), ...tokens });
        tally.add({ component: "memory_capture", request: request(capture), ...tokens });
        tally.add({
            component: "history_summarizer",
            request: request(summarizer),
            ...tokens,
            ...(placed > 0 ? { cache_points_placed: placed } : {}),
        });
        return tally.observation();
    };
    const system = { layout: "system", label: "eval/w3-all" } as const;
    const both = { layout: "system-and-message", label: "eval/w2b" } as const;
    const alone = observe(["sys+", "u1"], ["sys+", "u1"]);
    const paired = observe(["sys+", "u1+"], ["sys+", "u1+"]);
    expect(alone.components.memory_capture?.with_message_points).toBe(0);
    expect(paired.components.history_summarizer?.with_message_points).toBe(1);
    // The agent's last message carries its point on either build.
    expect(cachingMismatches("on", alone, system)).toEqual([]);
    expect(cachingMismatches("on", paired, both)).toEqual([]);
    expect(cachingMismatches("on", paired, system)).toEqual([
        "1 of 1 history_summarizer requests carry a cache point on a message, but eval/w3-all declares the system prompt's cache point alone on a background call",
        "1 of 1 memory_capture requests carry a cache point on a message, but eval/w3-all declares the system prompt's cache point alone on a background call",
    ]);
    expect(cachingMismatches("on", alone, both)).toEqual([
        "1 of 1 history_summarizer requests carry a cache point on the system prompt alone, but eval/w2b declares one on the user message of a background call too",
        "1 of 1 memory_capture requests carry a cache point on the system prompt alone, but eval/w2b declares one on the user message of a background call too",
    ]);
    // Points the proxy placed follow the declared layout by construction, so that component is
    // left out and the capture calls alone are held to it.
    const placed = observe(["sys+", "u1+"], ["sys+", "u1+"], 2);
    expect(cachingMismatches("on", placed, system)).toEqual([
        "1 of 1 memory_capture requests carry a cache point on a message, but eval/w3-all declares the system prompt's cache point alone on a background call",
    ]);
    expect(cachingMismatches("on", observe(["sys+", "u1"], ["sys+", "u1"], 1), both)).toEqual([
        "1 of 1 memory_capture requests carry a cache point on the system prompt alone, but eval/w2b declares one on the user message of a background call too",
    ]);
    // Another host, an arm without a daemon, and a count taken as calls start are held to nothing.
    expect(cachingMismatches("on", paired)).toEqual([]);
    expect(cachingMismatches("off", paired, system)).toEqual([]);
    const live: Record<string, CachingCount> = {};
    noteRequest(live, "memory_capture", 2);
    expect(cachingMismatches("on", { components: live }, system)).toEqual([]);
    // The record reads the layout from the arm's variant on the bound build, for a Pi arm.
    const root = captured(armRoot([PI_ON, PASS]));
    daemonLog(root, []);
    const arm = observeArm("eidnara", "pi", root, { agent: 2, memory_capture: 1 });
    arm.prompt_caching = paired;
    const w3 = AUDITED_BUILDS[0];
    const w2b = auditedBuild("eval/w2b") as AuditedBuild;
    expect(capabilityRecord(arm, null, w2b, "on").mismatches).toEqual([]);
    expect(capabilityRecord(arm, null, w3, "on").mismatches).toEqual(
        cachingMismatches("on", paired, { layout: "system", label: w3.label }),
    );
    expect(capabilityRecord({ ...arm, host: "opencode" }, null, w3, "on").mismatches).toEqual(
        armMismatches({ ...arm, host: "opencode" }, w3),
    );
});

test("the observation counts the requests whose cache points the proxy placed", () => {
    const parts = new Map<string, RequestPart>([
        ["sys+", { field: "system", value: [{ text: "s" }, POINT] }],
        ["u", { field: "messages", value: { role: "user", content: [{ text: "a" }, POINT] } }],
    ]);
    const tokens = { input_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 10 };
    const request = { sha256: "x", bytes: 1, parts: ["sys+", "u"] };
    const tally = new CachingTally(parts);
    tally.add({ component: "history_summarizer", request, ...tokens, cache_points_placed: 2 });
    tally.add({ component: "history_summarizer", request, ...tokens });
    tally.add({ component: "agent", request, ...tokens });
    expect(tally.observation().components).toMatchObject({
        history_summarizer: { requests: 2, with_cache_points: 2, placed_by_proxy: 1 },
        agent: { requests: 1, with_cache_points: 1, placed_by_proxy: 0 },
    });
    expect(cachingMismatches("on", tally.observation())).toEqual([]);
});
