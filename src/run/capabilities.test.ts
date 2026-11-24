import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
    appendFileSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewerBlock } from "../hosts/arms";
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
    exceedsShare,
    logLength,
    noteRequest,
    observeArm,
    observeReviewer,
    openItemsOf,
    daemonCachePoints as placeFor,
    type ReviewerStatusObservation,
    readDaemonStatus,
    readPluginLog,
    readReviewDrains,
    readReviewerLog,
    requireAuditedVariants,
    reviewLines,
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
        "create table decisions(object_id text, decision_payload blob, created_commit_seq integer, decision_kind text not null default 'CONSTRAINTS')",
    );
    db.run(
        "create table admission_decisions(admission_decision_id text primary key, subject_object_id text, event_kind text, disposition text, commit_seq integer, approval_object_id text)",
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

test("a fused arm's fallback on a transient reason is a degraded answer under a registered bound", () => {
    const note = (reason: string) =>
        `Memory: the fused search route is unavailable (${reason}); results come from the legacy snapshot scan.\n[1] [memory] x`;
    const bound = { max_degraded_share: "0.1" };
    // The shape of the run this rule was written for, read from disk: one `no_lane` answer
    // among 43 results.
    const root = captured(
        armRoot([PI_ON, PASS], [...Array<string>(42).fill(FUSED), note("no_lane")]),
    );
    daemonLog(root, [READY, ROUTE]);
    const observed = observeArm("eidnara-hybrid", "pi", root, { agent: 1 });
    expect(observed.search).toEqual({
        legacy_scan: ["no_lane"],
        fused: 42,
        errored: 0,
        contested: 0,
    });
    const record = (
        registered: typeof bound | null,
        search: { legacy_scan: string[]; fused: number; errored?: number } = {
            legacy_scan: ["no_lane"],
            fused: 42,
        },
    ) =>
        capabilityRecord(
            { ...observed, search: { errored: 0, contested: 0, ...search } },
            null,
            AUDITED_BUILDS[0],
            "off",
            registered,
            undefined,
        );
    const one = record(bound);
    expect(one.mismatches).toEqual([]);
    expect(one.search_fallback).toEqual({
        max_degraded_share: "0.1",
        answered: 43,
        degraded: 1,
        degraded_reasons: ["no_lane"],
        degraded_share: 1 / 43,
        persistent: 0,
        persistent_reasons: [],
    });
    expect(one.observed.search?.legacy_scan).toEqual(["no_lane"]);
    // The same evidence under a registration that names no bound is refused, with the count kept.
    const unregistered = record(null);
    expect(unregistered.mismatches).toEqual([
        "1 eidnara_search results came from the legacy snapshot scan (no_lane), but the arm declares the fused route",
    ]);
    expect(unregistered.search_fallback).toMatchObject({
        max_degraded_share: null,
        degraded: 1,
        degraded_share: 1 / 43,
    });
    // A reason that outlasts the call refuses under the bound, whatever its share.
    const lasting = ["disabled", "no_manifest", "no_family", "lane_not_ready", "projection_read"];
    for (const reason of [...lasting, "family_refused", "other"]) {
        const refused = record(bound, { legacy_scan: [reason], fused: 42 });
        expect(refused.mismatches).toEqual([
            `1 eidnara_search results came from the legacy snapshot scan for a persistent reason (${reason}), but the arm declares the fused route`,
        ]);
        expect(refused.search_fallback).toMatchObject({
            degraded: 0,
            persistent: 1,
            persistent_reasons: [reason],
        });
    }
    // The share is read against the bound: 2 of 20 answers is the bound, 3 of 20 exceeds it.
    const mixed = ["snapshot_changed", "no_lane"];
    expect(record(bound, { legacy_scan: mixed, fused: 18 }).mismatches).toEqual([]);
    const over = record(bound, { legacy_scan: [...mixed, "no_lane"], fused: 17 });
    expect(over.mismatches).toEqual([
        "3 of 20 answered eidnara_search results came from the legacy snapshot scan on a transient reason (no_lane, snapshot_changed), a share above the registered bound 0.1",
    ]);
    expect(over.search_fallback).toMatchObject({ degraded: 3, degraded_share: 0.15 });
    // The bound is compared at its registered digits: a bound a hair under one tenth, which a
    // double rounds to one tenth, refuses 2 of 20.
    expect(exceedsShare(2, 20, "0.1")).toBe(false);
    expect(exceedsShare(2, 20, "0.099999999999999999999")).toBe(true);
    expect(exceedsShare(1, 3, "0.333")).toBe(true);
    expect(exceedsShare(1, 3, "0.334")).toBe(false);
    expect(exceedsShare(0, 0, "0.1")).toBe(false);
    const hair = { max_degraded_share: "0.099999999999999999999" };
    expect(record(hair, { legacy_scan: mixed, fused: 18 }).mismatches).toEqual([
        "2 of 20 answered eidnara_search results came from the legacy snapshot scan on a transient reason (no_lane, snapshot_changed), a share above the registered bound 0.099999999999999999999",
    ]);
    // An errored result is no answer, so it stays out of the share's denominator.
    expect(record(bound, { legacy_scan: ["no_lane"], fused: 8, errored: 6 }).mismatches).toEqual([
        "1 of 9 answered eidnara_search results came from the legacy snapshot scan on a transient reason (no_lane), a share above the registered bound 0.1",
    ]);
    // A degraded answer is a result the fused route left unranked, so it counts with the errored
    // ones against the share of its results the route must rank: 9 of 18 is one half.
    expect(record(bound, { legacy_scan: ["no_lane"], fused: 9, errored: 8 }).mismatches).toEqual([
        "8 of 18 eidnara_search results errored on the fused route and 1 came from the legacy snapshot scan (answered share 0.500, required above 0.5)",
    ]);
    expect(record(bound, { legacy_scan: ["no_lane"], fused: 10, errored: 8 }).mismatches).toEqual(
        [],
    );
    // A run that names no bound keeps the share it ran under, over the ranked and errored results.
    expect(record(null, { legacy_scan: ["no_lane"], fused: 9, errored: 8 }).mismatches).toEqual([
        "1 eidnara_search results came from the legacy snapshot scan (no_lane), but the arm declares the fused route",
    ]);
    // An arm with no answered search has no share, and the bound refuses nothing there.
    const unanswered = record(bound, { legacy_scan: [], fused: 0 });
    expect(unanswered.search_fallback).toMatchObject({ answered: 0, degraded_share: null });
    expect(unanswered.mismatches.filter((m) => m.includes("legacy snapshot scan"))).toEqual([]);
    // Both refusals are reported when a run shows both.
    const both = record(bound, { legacy_scan: ["no_lane", "disabled", "disabled"], fused: 1 });
    expect(both.mismatches).toEqual([
        "0 of 4 eidnara_search results errored on the fused route and 3 came from the legacy snapshot scan (answered share 0.250, required above 0.5)",
        "2 eidnara_search results came from the legacy snapshot scan for a persistent reason (disabled), but the arm declares the fused route",
        "1 of 4 answered eidnara_search results came from the legacy snapshot scan on a transient reason (no_lane), a share above the registered bound 0.1",
    ]);
    // The bound belongs to the fused route: an arm on the legacy scan carries no fallback section.
    const legacy = observeArm("eidnara", "pi", captured(armRoot([PI_ON, PASS], [LEGACY])), {
        agent: 1,
    });
    const plain = capabilityRecord(legacy, null, AUDITED_BUILDS[0], "off", bound, undefined);
    expect(plain.mismatches).toEqual([]);
    expect("search_fallback" in plain).toBe(false);
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
    db.run(
        "insert into decisions (object_id, decision_payload, created_commit_seq) values ('stm_e', ?, 99)",
        [payload("sim-s-0002")],
    );
    db.run(
        "insert into decisions (object_id, decision_payload, created_commit_seq) values ('stm_a', ?, 1), ('stm_b', ?, 1), ('stm_c', ?, 7), ('mem_d', ?, 1)",
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
    db.run(
        "insert into decisions (object_id, decision_payload, created_commit_seq) values ('mem_f', ?, 1), ('mem_g', ?, 99), ('mem_h', ?, 1)",
        [
            classed("current_work"),
            classed("lasting"),
            // A class is counted under the name the store holds, whatever an object inherits.
            classed("constructor"),
        ],
    );
    // The row that supersedes ended work records the statement that ended it; mem_j's commit is
    // absent, the ends of mem_k, mem_m, and mem_n are no record, and mem_l is another class.
    const ended = (lifetime: string, ended_by: unknown) =>
        new TextEncoder().encode(
            JSON.stringify({
                summary: "User stated: Next, move the retry budget.",
                rationale: JSON.stringify({ session: "sim-s-0001", lifetime, ended_by }),
            }),
        );
    const end = { memory: "mem_f", session: "sim-s-0002" };
    db.run(
        "insert into decisions (object_id, decision_payload, created_commit_seq) values ('mem_i', ?, 1), ('mem_j', ?, 99), ('mem_k', ?, 1), ('mem_l', ?, 1), ('mem_m', ?, 1), ('mem_n', ?, 1)",
        [
            ended("current_work", end),
            ended("current_work", end),
            ended("current_work", "mem_f"),
            ended("request", end),
            ended("current_work", null),
            ended("current_work", [end]),
        ],
    );
    // Two statements quote one user message and a third quotes another; stm_e's commit is absent.
    const message = (digit: string) => `memory_capture_statement:${digit.repeat(32)}`;
    db.run(
        "insert into object_registry values ('stm_a', 'decision', 'user', 1, null, ?), ('stm_b', 'decision', 'user', 1, null, ?), ('stm_c', 'decision', 'user', 7, null, ?), ('stm_e', 'decision', 'user', 99, null, ?)",
        [message("a"), message("a"), message("b"), message("c")],
    );
    // A later commit retired stm_r, the record of work in progress a statement ended, so its
    // session is no capture session of a live statement. The Kernel serves by the invalidation
    // alone, so stm_s, whose invalidating commit the log lacks, is retired too, and so is stm_t,
    // whose payload names no session.
    db.run(
        "insert into decisions (object_id, decision_payload, created_commit_seq) values ('stm_r', ?, 1), ('stm_s', ?, 1), ('stm_t', ?, 1)",
        [payload("sim-s-0007"), payload("sim-s-0003"), new TextEncoder().encode("not json")],
    );
    db.run(
        "insert into object_registry values ('stm_r', 'decision', 'user', 1, 7, ?), ('stm_s', 'decision', 'user', 1, 99, ?), ('stm_t', 'decision', 'user', 1, 7, ?)",
        [message("d"), message("e"), message("f")],
    );
    db.close();
    const observe = (arm: string, components: Record<string, number>) =>
        observeArm(arm, "pi", root, components);
    // stm_e's commit is absent from the log, so a partial store left it behind. Of the committed
    // facts, mem_d names no lifetime class, and the others name one each; mem_i alone is ended work.
    expect(observe("eidnara", {}).statements).toEqual({
        count: 6,
        sessions: ["sim-s-0001"],
        unattributed: 1,
        retired: 3,
        disputed_statements: 0,
        error: null,
        lifetimes: { current_work: 5, constructor: 1, request: 1 },
        ended_work: 1,
        lineages: { count: 5, largest: 2, per_message: 6 },
        failed_commands: { live: 0, retired: 0 },
        disputed: { live: 0, retired: 0 },
    });
    // The class outside the build's five is a mismatch of its own; the delivery cases below run without it.
    expect(armMismatches(observe("eidnara", {}))).toEqual([
        "1 captured facts name a lifetime class outside lasting, current_work, status, unsettled, request: constructor",
    ]);
    const store = new Database(join(root, "..", "final-store", "kernel.sqlite"));
    store.run("delete from decisions where object_id = 'mem_h'");
    store.close();
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
        memory_reviewer: { readings: 0, open: 0, states: {}, last: null, last_after_open: false },
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

test("the memory reviewer's activation state is read from each daemon process's status readings", () => {
    const path = join(tmp(), "resources.jsonl");
    const reading = (pid: number, state: unknown) => ({
        pid,
        daemon_status: {
            pid,
            start: "100",
            process_memory: null,
            memory_reviewer: state === undefined ? undefined : { activation_state: state },
            search: null,
            error: null,
        },
    });
    const write = (samples: unknown[]) =>
        writeFileSync(path, `${samples.map((s) => JSON.stringify(s)).join("\n")}\n`);
    const read = () => readDaemonStatus(path).memory_reviewer;
    // The worker reads `unknown` before its first pass and `open` while a switched project is reviewed.
    write([reading(7, "unknown"), reading(7, "open"), reading(7, "open")]);
    expect(read()).toEqual({
        readings: 3,
        open: 2,
        states: { unknown: 1, open: 2 },
        last: "open",
        last_after_open: true,
    });
    // The same process closing after it was open is told apart from a replacement that binds no project.
    write([reading(7, "open"), reading(7, "unavailable")]);
    expect(read()).toMatchObject({ open: 1, last: "unavailable", last_after_open: true });
    write([reading(7, "open"), reading(8, "missing")]);
    expect(read()).toMatchObject({ open: 1, last: "missing", last_after_open: false });
    write([reading(7, "open"), reading(8, "missing"), reading(8, "open"), reading(8, "stale")]);
    expect(read()).toMatchObject({ open: 2, last: "stale", last_after_open: true });
    // A reading without the block, or with a state of another shape, carries none.
    write([reading(7, undefined), reading(7, 5), reading(7, "Open now"), { pid: 7 }]);
    expect(read()).toEqual({
        readings: 0,
        open: 0,
        states: {},
        last: null,
        last_after_open: false,
    });
    // A state is a name read from the file, so the tally has no inherited keys.
    write([reading(7, "constructor")]);
    expect(read()?.states).toEqual({ constructor: 1 });
    expect(reviewerBlock({ activation_state: "open", memory_reviewer_state: "ready" })).toEqual({
        activation_state: "open",
    });
    expect(reviewerBlock(["open"])).toBeNull();
});

/** The daemon's own lines, as its format strings write them (Eidnara eval/w9 `memory_reviewer/`). */
const REVIEW_LOG = [
    "daemon: memory_reviewer activation gate closed: no activation record",
    "daemon: memory_reviewer enqueued job=1e272ec4862b8c69 trigger=later_statement later=1 source=1",
    "daemon: memory_reviewer enqueued job=27db22ce85452690 trigger=later_statement later=1 source=1",
    "daemon: memory_reviewer enqueued job=171284c95cbd3587 trigger=current_work later=2 source=1",
    "daemon: memory_reviewer enqueued job=88e03198394a9259 trigger=later_message later=1 source=1",
    'daemon: memory_reviewer selected 4 of 11 memories for review: {"contested": 0, "current_work": 1, "later_message": 1, "later_statement": 2}; 0 wait for a pending proposal',
    "daemon: memory_reviewer stage 1 job=1e272ec4862b8c69 decider=chat_model model=amazon-bedrock/global.anthropic.claude-haiku-5-5 request=80f14b8005030580 decision=keep changes=no relation=restates work_ended=no strongest=ref-3 later=1",
    "daemon: memory_reviewer stage 1 job=27db22ce85452690 decider=chat_model model=amazon-bedrock/global.anthropic.claude-haiku-5-5 request=ab69b4cd529e6093 decision=flagged changes=yes relation=replaces work_ended=no strongest=ref-3 later=1",
    "daemon: memory_reviewer stage 1 job=171284c95cbd3587 decider=none model=none request=none decision=keep changes=none relation=none work_ended=none strongest=none later=0",
    "daemon: memory_reviewer stage 1 job=c68559ec1ea0e11b decider=classifier model=typesafe/jev-latest request=b010570b1fc04e4a decision=flagged changes=0.52 relation=replaces work_ended=0.02 strongest=ref-3 later=1",
    "daemon: memory_reviewer stage 1 request ended without an answer: job=88e03198394a9259 decider=chat_model model=amazon-bedrock/global.anthropic.claude-haiku-5-5 send deadline",
    "daemon: memory_reviewer review ended on a later reference the model was not shown: job=88e03198394a9259 refusal=source_unavailable",
    "daemon: memory_reviewer applied a proposal: job=27db22ce85452690 contested",
    "daemon: memory_reviewer applied a proposal: job=c68559ec1ea0e11b disputed",
    "daemon: memory_reviewer applied a proposal: job=d7b3f227d1213b52 dropped",
    "daemon: memory_reviewer applied a proposal: job=d7b3f227d1213b53 standing",
    "daemon: memory_reviewer left a change proposal for a reader: job=d7b3f227d1213b54",
    "daemon: memory_reviewer left a published proposal unapplied: job=d7b3f227d1213b55 the store is busy",
    "daemon: memory_reviewer stage-1 default amazon-bedrock/global.anthropic.claude-haiku-5-5 failed its first request; stage 1 uses the review model until the daemon restarts. Set memory_reviewer.stage1_model to a small model the host serves.",
    "daemon: memory_reviewer reviews of a project wait: 64 of its pending proposals and 64 on the host hold every review hold left; reviews resume when one is settled or its review window ends",
    "daemon: memory_reviewer kept the review hold of a settled proposal: the store is busy",
    "daemon: memory_reviewer selection examines 4096 claim descriptors a pass and the store holds more; each pass continues where the last one ended",
    "daemon: memory_reviewer run ended without settlement: fenced",
    "daemon: memory_reviewer run ended without settlement: fenced",
    "daemon: memory_reviewer run ended without settlement: store database is locked",
    "daemon: memory_reviewer selection for a switched project failed: kernel kernel operation exceeded its deadline",
];

test("the memory reviewer's log lines are counted by the form the daemon writes each in", () => {
    const dir = tmp();
    const path = join(dir, "daemon.log");
    // Two daemon generations share the one log, each opening with its ready record.
    const other = [
        '{"status":"ready","pid":7}',
        "daemon: history_summarizer claims session=sim-s-0001 outcome=accepted kept=3",
        "direct_host_fixture: search route production, embedding model gte",
        // A reviewer line counts from its line's start alone.
        "note: daemon: memory_reviewer applied a proposal: job=aa disputed",
    ];
    writeFileSync(path, `${[...other, ...REVIEW_LOG, ...other, REVIEW_LOG[1]].join("\n")}\n`);
    const haiku = "amazon-bedrock/global.anthropic.claude-haiku-5-5";
    const log = readReviewerLog(path);
    expect(log).toEqual({
        enqueued: { contested: 0, current_work: 1, later_statement: 3, later_message: 1 },
        selections: 1,
        stage1: {
            chat_model: { keep: 1, flagged: 1, other: 0, models: [haiku] },
            classifier: { keep: 0, flagged: 1, other: 0, models: ["typesafe/jev-latest"] },
            none: { keep: 1, flagged: 0, other: 0, models: ["none"] },
        },
        stage1_failed: 1,
        unread_later: 1,
        applied: {
            disputed: 1,
            contested: 1,
            standing: 1,
            dropped: 1,
            retired: 0,
            revised: 0,
            created: 0,
        },
        left_for_reader: 1,
        unapplied: 1,
        stage1_default_failed: 1,
        waits: { hold_bound: 1, kept_hold: 1, selection_resumed: 1 },
        // A run that ended without settlement is counted by its reason's first word.
        unsettled: {
            fenced: 2,
            unavailable: 0,
            refused: 0,
            supervisor: 0,
            store: 1,
            kernel: 0,
            conflicting_content: 0,
            binding_mismatch: 0,
        },
        gate_closed: 1,
        other: 1,
    });
    // Every counted form but the gate line and the unclassed one shows a review ran.
    expect(reviewLines(log)).toBe(REVIEW_LOG.length + 1 - 2);
    // A name the daemon adds later is counted under itself, and a decider's models stay bounded.
    const models = Array.from({ length: 10 }, (_, i) => `p/m${i}`);
    writeFileSync(
        path,
        [
            "daemon: memory_reviewer enqueued job=aa trigger=constructor later=1 source=1",
            "daemon: memory_reviewer applied a proposal: job=aa merged",
            "daemon: memory_reviewer run ended without settlement: constructor",
            "daemon: memory_reviewer stage 1 job=aa decider=panel model=p/m request=bb decision=deferred later=1",
            ...models.map(
                (m) =>
                    `daemon: memory_reviewer stage 1 job=aa decider=chat_model model=${m} request=bb decision=keep changes=no later=1`,
            ),
        ].join("\n"),
    );
    const later = readReviewerLog(path);
    expect(Object.entries(later.enqueued).filter(([, n]) => n > 0)).toEqual([["constructor", 1]]);
    expect(later.applied.merged).toBe(1);
    expect(Object.entries(later.unsettled ?? {}).filter(([, n]) => n > 0)).toEqual([
        ["constructor", 1],
    ]);
    expect(later.stage1.panel).toEqual({ keep: 0, flagged: 0, other: 1, models: ["p/m"] });
    expect(later.stage1.chat_model).toEqual({
        keep: 10,
        flagged: 0,
        other: 0,
        models: models.slice(0, 8),
    });
    // An absent log counts nothing.
    expect(reviewLines(readReviewerLog(join(dir, "absent.log")))).toBe(0);
});

test("the settle steps are totalled from review-drain.jsonl", () => {
    const dir = tmp();
    const path = join(dir, "review-drain.jsonl");
    const lines = [
        { session: "s-1", started_wall_ms: 1_000, wall_ms: 4_500, settled: 3, error: null },
        { session: "s-2", started_wall_ms: 9_000, wall_ms: 9_200, settled: 0, error: null },
        {
            session: "s-3",
            started_wall_ms: 20_000,
            wall_ms: 325_000,
            settled: null,
            error: "review drain unanswered after 300000 ms",
        },
        {
            session: "s-4",
            started_wall_ms: 400_000,
            wall_ms: 431_000,
            settled: 2,
            error: "source capture did not settle: Error: source capture never settled",
        },
        // The answer of the drain that s-3 recorded as unanswered: the drain ran 500 s.
        {
            session: "s-3",
            started_wall_ms: 20_000,
            wall_ms: 520_000,
            settled: 7,
            error: null,
            late: true,
        },
    ].map((l) => JSON.stringify(l));
    // A line of another shape is counted apart: an end before its start, a count that is no integer.
    const odd = [
        "not json",
        JSON.stringify({ session: "s-5", started_wall_ms: 9, wall_ms: 3, settled: 1, error: null }),
        JSON.stringify({
            session: "s-6",
            started_wall_ms: 1,
            wall_ms: 3,
            settled: 1.5,
            error: null,
        }),
        JSON.stringify({ session: "s-7", started_wall_ms: 1, wall_ms: 3, settled: 1 }),
        JSON.stringify({
            session: "s-8",
            started_wall_ms: 1,
            wall_ms: 3,
            settled: 1,
            error: null,
            late: "yes",
        }),
    ];
    writeFileSync(path, `${[...lines, ...odd].join("\n")}\n`);
    // A late line adds its runs and its duration and is no step of its own.
    expect(readReviewDrains(path)).toEqual({
        calls: 4,
        late_answers: 1,
        unreadable: 5,
        settled_runs: 12,
        total_wall_ms: 3_500 + 200 + 305_000 + 31_000,
        max_wall_ms: 500_000,
        errors: 2,
        first_errors: [
            "review drain unanswered after 300000 ms",
            "source capture did not settle: Error: source capture never settled",
        ],
    });
    expect(readReviewDrains(join(dir, "absent.jsonl"))).toMatchObject({ calls: 0, unreadable: 0 });
    // The arm's observation joins the log, the settle steps, and the gateway's reviewer calls.
    writeFileSync(join(dir, "daemon.log"), `${REVIEW_LOG.join("\n")}\n`);
    const seen = observeReviewer(dir, {
        agent: 9,
        memory_reviewer_stage1: 4,
        memory_reviewer_stage2: 1,
    });
    expect(seen.calls).toEqual({ memory_reviewer_stage1: 4, memory_reviewer_stage2: 1 });
    expect(seen.drains.calls).toBe(4);
    expect(seen.log.selections).toBe(1);
    expect(observeReviewer(tmp(), { agent: 9 }).calls).toEqual({
        memory_reviewer_stage1: 0,
        memory_reviewer_stage2: 0,
    });
});

test("a statement whose memory is disputed owes no later session a block", () => {
    // The statement record stm_a approves the memory mem_a, as capture writes them (Eidnara
    // `memory_capture.rs` `record_statement`): the record is a decision of its own, and the
    // memory's `approve` admission decision names it as `approval_object_id`. A dispute is a
    // `mark_disputed` admission decision on the memory and leaves the record live.
    const build = (rows: (db: Database) => void) => {
        const root = captured(armRoot([PI_ON, PASS]));
        const db = new Database(join(root, "..", "final-store", "kernel.sqlite"));
        db.run("insert into commit_log values (3), (5)");
        rows(db);
        db.close();
        return root;
    };
    const statement = (db: Database, id: string, session: string, created = 1) => {
        const payload = new TextEncoder().encode(
            JSON.stringify({
                summary: "User stated: Use tabs.",
                rationale: JSON.stringify({ session, memory: `mem_${id}` }),
            }),
        );
        db.run(
            "insert into decisions (object_id, decision_payload, created_commit_seq) values (?, ?, ?)",
            [`stm_${id}`, payload, created],
        );
        db.run("insert into object_registry values (?, 'decision', 'user', ?, null, ?)", [
            `stm_${id}`,
            created,
            // Each statement sits on its own message's lineage; the ids here are hex digits.
            `memory_capture_statement:${id.repeat(32)}`,
        ]);
    };
    const memory = (
        db: Database,
        id: string,
        approval: string,
        created = 1,
        invalidated: number | null = null,
    ) => {
        db.run("insert into object_registry values (?, 'decision', 'assistant', ?, ?, '')", [
            id,
            created,
            invalidated,
        ]);
        db.run("insert into admission_decisions values (?, ?, 'approve', 'active', ?, ?)", [
            `${created}:approve:${id}`,
            id,
            created,
            approval,
        ]);
    };
    const dispute = (db: Database, id: string, commit: number) =>
        db.run(
            "insert into admission_decisions values (?, ?, 'mark_disputed', 'disputed', ?, null)",
            [`${commit}:dispute:${id}`, id, commit],
        );
    const read = (root: string) => observeArm("eidnara", "pi", root, {}).statements;

    // One statement, disputed: mem_a was replaced by mem_a2 under the same approval (a contested
    // mark rewrites the memory), and the reviewer disputed the live one.
    const alone = build((db) => {
        statement(db, "a", "sim-s-0001");
        memory(db, "mem_a", "stm_a", 1, 3);
        memory(db, "mem_a2", "stm_a", 3);
        dispute(db, "mem_a2", 5);
    });
    expect(read(alone)).toMatchObject({
        count: 1,
        sessions: [],
        unattributed: 0,
        retired: 0,
        disputed_statements: 1,
        disputed: { live: 1, retired: 0 },
        error: null,
    });
    // A disputed statement beside a live one: later sessions owe for the live one alone.
    const beside = build((db) => {
        statement(db, "a", "sim-s-0001");
        memory(db, "mem_a", "stm_a");
        dispute(db, "mem_a", 3);
        statement(db, "b", "sim-s-0004");
        memory(db, "mem_b", "stm_b");
    });
    expect(read(beside)).toMatchObject({
        count: 2,
        sessions: ["sim-s-0004"],
        unattributed: 0,
        disputed_statements: 1,
    });
    // A statement stays owed while a live memory it approves stands: stm_a's dispute was followed
    // by an approval, stm_b's dispute names a commit the log lacks, stm_c approves a second live
    // memory, stm_d's disputed memory is retired with another live one beside it, and stm_e
    // approves no memory.
    const standing = build((db) => {
        statement(db, "a", "sim-s-0001");
        memory(db, "mem_a", "stm_a");
        dispute(db, "mem_a", 3);
        db.run(
            "insert into admission_decisions values ('5:approve:mem_a', 'mem_a', 'approve', 'active', 5, 'stm_a')",
        );
        statement(db, "b", "sim-s-0002");
        memory(db, "mem_b", "stm_b");
        dispute(db, "mem_b", 99);
        statement(db, "c", "sim-s-0003");
        memory(db, "mem_c", "stm_c");
        dispute(db, "mem_c", 3);
        memory(db, "mem_c2", "stm_c", 3);
        statement(db, "d", "sim-s-0004");
        memory(db, "mem_d", "stm_d", 1, 5);
        dispute(db, "mem_d", 3);
        memory(db, "mem_d2", "stm_d", 5);
        statement(db, "e", "sim-s-0005");
    });
    expect(read(standing)).toMatchObject({
        count: 5,
        sessions: ["sim-s-0001", "sim-s-0002", "sim-s-0003", "sim-s-0004", "sim-s-0005"],
        disputed_statements: 0,
    });
    // The mismatch counts the statements that owe a block: the live one, without the disputed one.
    const seen = observeArm("eidnara", "pi", beside, { agent: 3, memory_capture: 1 });
    seen.delivery = {
        requests: 3,
        unreadable: 0,
        injected_blocks: 0,
        notes: { expected: 0, delivered: 0, missing: [], misplaced: [] },
        memory_blocks: 0,
        sessions: 2,
        memory_due: true,
        due_blocks: 0,
    };
    expect(armMismatches(seen)).toEqual([
        "the final store holds 1 user statements captured before later sessions' agent requests, but none of those requests carried a <project-memory> block",
    ]);
});

test("failed-command records and disputed objects are counted in the final store, live and retired", () => {
    const root = captured(armRoot([PI_ON, PASS]));
    const db = new Database(join(root, "..", "final-store", "kernel.sqlite"));
    db.run("insert into commit_log values (3), (5)");
    const row = new TextEncoder().encode(JSON.stringify({ summary: "Command: make test" }));
    // One command line's records share a lineage: a later failure superseded tf_a, and tf_b is live.
    // tf_c sits on the bare lineage name; tf_d's commit the log lacks; tf_e is a memory of another
    // category on the lineage; tf_f is a TOOL_FAILURE row of another lineage; tf_g's lineage only
    // opens with the name.
    const failures: Array<[string, string, string, number, number | null]> = [
        ["tf_a", "TOOL_FAILURE", "tool_failure:0f3a", 1, 3],
        ["tf_b", "TOOL_FAILURE", "tool_failure:0f3a", 3, null],
        ["tf_c", "TOOL_FAILURE", "tool_failure", 5, null],
        ["tf_d", "TOOL_FAILURE", "tool_failure:0f3a", 99, null],
        ["tf_e", "CONSTRAINTS", "tool_failure:0f3a", 1, null],
        ["tf_f", "TOOL_FAILURE", "memory_capture", 1, null],
        ["tf_g", "TOOL_FAILURE", "tool_failures", 1, null],
    ];
    for (const [id, kind, lineage, created, invalidated] of failures) {
        db.run(
            "insert into decisions (object_id, decision_payload, created_commit_seq, decision_kind) values (?, ?, ?, ?)",
            [id, row, created, kind],
        );
        db.run("insert into object_registry values (?, 'decision', 'memory', ?, ?, ?)", [
            id,
            created,
            invalidated,
            lineage,
        ]);
    }
    // An object's standing is its newest committed admission decision from its creation on:
    // mem_p is disputed and live, mem_q was disputed and later retired, mem_r's dispute was
    // followed by an approval, mem_s's dispute names a commit the log lacks, and mem_t's
    // dispute predates the object.
    for (const [id, created, invalidated] of [
        ["mem_p", 1, null],
        ["mem_q", 1, 5],
        ["mem_r", 1, null],
        ["mem_s", 1, null],
        ["mem_t", 5, null],
    ] as const) {
        db.run("insert into object_registry values (?, 'decision', 'memory', ?, ?, '')", [
            id,
            created,
            invalidated,
        ]);
    }
    db.run(
        `insert into admission_decisions
            (admission_decision_id, subject_object_id, event_kind, disposition, commit_seq) values
            ('a1', 'mem_p', 'approve', 'approved', 1), ('a2', 'mem_p', 'mark_disputed', 'disputed', 3),
            ('a3', 'mem_q', 'mark_disputed', 'disputed', 3),
            ('a4', 'mem_r', 'mark_disputed', 'disputed', 3), ('a5', 'mem_r', 'approve', 'approved', 5),
            ('a6', 'mem_s', 'approve', 'approved', 1), ('a7', 'mem_s', 'mark_disputed', 'disputed', 99),
            ('a8', 'mem_t', 'mark_disputed', 'disputed', 3),
            ('a9', null, 'mark_disputed', 'disputed', 5)`,
    );
    db.close();
    const seen = observeArm("eidnara", "pi", root, { agent: 2, memory_capture: 1 });
    expect(seen.statements).toMatchObject({
        error: null,
        failed_commands: { live: 2, retired: 1 },
        disputed: { live: 1, retired: 1 },
    });
    // A failed-command record is the w9 build's; a disputed object is a count on every build,
    // since the agent's memory tool files the mark on each.
    const w9 = auditedBuild("eval/w9") as AuditedBuild;
    expect(armMismatches(seen, w9)).toEqual([]);
    for (const label of ["main-ea12bff2a", "eval/w4", "eval/w2b"]) {
        expect(armMismatches(seen, auditedBuild(label) as AuditedBuild)).toEqual([
            `the final store holds 3 failed-command records (2 live), which ${label} does not declare`,
        ]);
    }
    const none = {
        ...seen,
        statements: { ...seen.statements, failed_commands: { live: 0, retired: 0 } },
    };
    expect(armMismatches(none as typeof seen, auditedBuild("eval/w4") as AuditedBuild)).toEqual([]);
    expect(
        armMismatches(
            { ...seen, arm: "eidnara-reviewer" },
            w9,
            null,
            "global.anthropic.claude-haiku-5-5",
        ),
    ).toEqual([]);
});

test("reviewer evidence is held to the arm's switch, the daemon's status, and the registered stage-1 model", () => {
    const w9 = auditedBuild("eval/w9") as AuditedBuild;
    const root = captured(armRoot([PI_ON, PASS]));
    daemonLog(root, []);
    const quiet = observeArm("eidnara", "pi", root, { agent: 2, memory_capture: 1 });
    expect(armMismatches(quiet, w9)).toEqual([]);
    // The gate line and the worker's unclassed lines are no review: a daemon with a reviewer
    // host writes them with the switch off.
    appendFileSync(
        join(root, "..", "daemon.log"),
        `${REVIEW_LOG[0]}\n${REVIEW_LOG[REVIEW_LOG.length - 1]}\n`,
    );
    const idle = observeArm("eidnara", "pi", root, { agent: 2, memory_capture: 1 });
    expect(idle.reviewer?.log).toMatchObject({ gate_closed: 1, other: 1 });
    expect(armMismatches(idle, w9)).toEqual([]);
    // On an arm without the switch, each sign of a review contradicts the profile.
    appendFileSync(join(root, "..", "daemon.log"), `${REVIEW_LOG.slice(1, 8).join("\n")}\n`);
    writeFileSync(
        join(root, "..", "review-drain.jsonl"),
        `${JSON.stringify({ session: "s-1", started_wall_ms: 1, wall_ms: 2, settled: 0, error: null })}\n`,
    );
    const components = {
        agent: 2,
        memory_capture: 1,
        memory_reviewer_stage1: 3,
        memory_reviewer_stage2: 1,
    };
    const reviewed = observeArm("eidnara", "pi", root, components);
    const status = (memory_reviewer: ReviewerStatusObservation) => ({
        ...(reviewed.daemon_status as NonNullable<typeof reviewed.daemon_status>),
        readings: 8,
        process_memory: 8,
        memory_reviewer,
    });
    const open = { readings: 8, open: 8, states: { open: 8 }, last: "open", last_after_open: true };
    const off = {
        "daemon.log holds 7 memory reviewer lines of a review, but the arm leaves the reviewer switch off": true,
    };
    expect(armMismatches({ ...reviewed, daemon_status: status(open) }, w9)).toEqual([
        ...Object.keys(off),
        "4 memory_reviewer_stage1 and memory_reviewer_stage2 calls in the proxy records, but the arm leaves the reviewer switch off",
        "review-drain.jsonl holds 1 settle steps, which only an arm with the reviewer switch runs",
        "8 daemon status readings report the memory reviewer open, but the arm leaves the reviewer switch off",
    ]);
    // A host arm's reviewer call is reported once, with its other Eidnara calls.
    const host = observeArm("host", "pi", armRoot([]), { agent: 2, memory_reviewer_stage1: 1 });
    expect(armMismatches(host, w9)).toEqual(["1 memory_reviewer_stage1 calls on a host-only arm"]);
    // The same evidence is the reviewer arm's own.
    const arm = { ...reviewed, arm: "eidnara-reviewer" };
    const haiku = "global.anthropic.claude-haiku-5-5";
    const held = (o: typeof arm) => armMismatches(o, w9, null, haiku);
    expect(held({ ...arm, daemon_status: status(open) })).toEqual([]);
    // The check holds no model of its own: a reviewer arm of a run that registers none is a mismatch.
    expect(armMismatches({ ...arm, daemon_status: status(open) }, w9)).toEqual([
        "the arm sets the reviewer switch, and the run registers no stage-1 model",
    ]);
    // The status must carry the block and report open, and a process that was open must still be.
    const closed = (last: string, last_after_open: boolean, opened = 3) => ({
        readings: 8,
        open: opened,
        states: { open: opened, [last]: 8 - opened },
        last,
        last_after_open,
    });
    const none = { readings: 0, open: 0, states: {}, last: null, last_after_open: false };
    expect(held({ ...arm, daemon_status: status(none) })).toEqual([
        "none of 8 daemon status readings carries the memory_reviewer block, which eval/w9 declares with its memory review",
    ]);
    expect(held({ ...arm, daemon_status: status(closed("missing", false, 0)) })).toEqual([
        "none of 8 daemon status readings reports the memory reviewer open (last state missing), but the arm sets the reviewer switch",
    ]);
    expect(held({ ...arm, daemon_status: status(closed("unavailable", true)) })).toEqual([
        "the last daemon status reading reports the memory reviewer unavailable, after the same daemon process reported it open",
    ]);
    // A replacement daemon that bound no project reads missing; its reading stands.
    expect(held({ ...arm, daemon_status: status(closed("missing", false)) })).toEqual([]);
    // An arm whose status returned no reading, and an observation recorded before the state was read, are held to nothing.
    const unread = { ...status(none), readings: 0 };
    expect(held({ ...arm, daemon_status: unread })).toEqual([]);
    const { memory_reviewer: _state, ...before } = status(none);
    expect(held({ ...arm, daemon_status: before })).toEqual([]);
    // A stage-1 decision of the chat model names the registered model.
    const wanted = (model: string) =>
        armMismatches({ ...arm, daemon_status: status(open) }, w9, null, model);
    expect(wanted(haiku)).toEqual([]);
    expect(wanted("global.anthropic.claude-sonnet-5-5")).toEqual([
        "stage-1 decisions by the chat model name amazon-bedrock/global.anthropic.claude-haiku-5-5, but the run registers amazon-bedrock/global.anthropic.claude-sonnet-5-5 as the reviewer's stage-1 model",
    ]);
    // The capability record carries the reviewer observation and the same mismatches.
    const record = capabilityRecord(
        { ...arm, daemon_status: status(open) },
        null,
        w9,
        "off",
        null,
        "global.anthropic.claude-sonnet-5-5",
    );
    expect(record.observed.reviewer?.calls).toEqual({
        memory_reviewer_stage1: 3,
        memory_reviewer_stage2: 1,
    });
    expect(record.mismatches).toEqual(wanted("global.anthropic.claude-sonnet-5-5"));
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
    // The build's classes are five names; any other name in a rationale is a defect of the store.
    const odd = { ...classed, lifetimes: { lasting: 3, currnt_work: 2, constructor: 1 } };
    expect(armMismatches({ ...base, statements: odd }, current)).toEqual([
        "3 captured facts name a lifetime class outside lasting, current_work, status, unsettled, request: currnt_work, constructor",
    ]);
    // `request` and the record of ended work are the w4 build's; the w3 build names four classes
    // and stores work in progress labeled.
    const w3 = auditedBuild("eval/w3-all") as AuditedBuild;
    const work = { ...classed, lifetimes: { lasting: 3, request: 2 }, ended_work: 1 };
    expect(armMismatches({ ...base, statements: work }, current)).toEqual([]);
    expect(armMismatches({ ...base, statements: work }, w3)).toEqual([
        "2 captured facts name a lifetime class outside lasting, current_work, status, unsettled: request",
        "0 agent requests carry a <CURRENT_WORK> element in <project-memory> and 1 captured facts record the statement that ended them, which eval/w3-all does not declare",
    ]);
    expect(armMismatches({ ...base, statements: classed }, w3)).toEqual([]);

    const delivery = (contested_blocks: number, stale: number, work_blocks = 0) => ({
        requests: 3,
        unreadable: 0,
        injected_blocks: 1,
        notes: { expected: 0, delivered: 0, missing: [], misplaced: [] },
        contested_blocks,
        work_blocks,
        open_items: {
            blocks: 5,
            waiting_blocks: 2,
            stale_waiting_blocks: stale,
            stale_requests: stale > 0 ? [41] : [],
        },
    });
    expect(armMismatches({ ...base, delivery: delivery(2, 0) }, current)).toEqual([]);
    // The element of work in progress is the w4 build's; every earlier build renders none.
    expect(armMismatches({ ...base, delivery: delivery(0, 0, 2) }, current)).toEqual([]);
    for (const earlier of [w3, w2b]) {
        expect(armMismatches({ ...base, delivery: delivery(0, 0, 2) }, earlier)).toEqual([
            `2 agent requests carry a <CURRENT_WORK> element in <project-memory> and 0 captured facts record the statement that ended them, which ${earlier.label} does not declare`,
        ]);
    }
    expect(armMismatches({ ...base, delivery: delivery(0, 1) }, current)).toEqual([
        `1 of 5 rendered history blocks hold a waiting line before a later summarized segment (first requests 41), but ${current.label} declares waiting lines in the newest segment alone`,
    ]);
    // The closing sentence, the named files, and the dated replacement mark are the w9 build's.
    const marked = (
        closing_blocks: number,
        named_file_blocks: number,
        replaced_blocks: number,
    ) => ({
        ...delivery(0, 0),
        memory_blocks: 4,
        closing_blocks,
        named_file_blocks,
        replaced_blocks,
    });
    expect(armMismatches({ ...base, delivery: marked(4, 2, 1) }, current)).toEqual([]);
    // A build with the sentence may show no named file and no replacement; it ends every block with the sentence.
    expect(armMismatches({ ...base, delivery: marked(4, 0, 0) }, current)).toEqual([]);
    expect(armMismatches({ ...base, delivery: marked(1, 0, 0) }, current)).toEqual([]);
    expect(armMismatches({ ...base, delivery: marked(0, 2, 1) }, current)).toEqual([
        `none of 4 agent requests with a <project-memory> block carries the closing sentence, which ${current.label} declares for every delivered block`,
    ]);
    expect(
        armMismatches({ ...base, delivery: { ...marked(0, 0, 0), memory_blocks: 0 } }, current),
    ).toEqual([]);
    // An observation recorded before the sentence was counted is held to nothing.
    const { closing_blocks: _uncounted, ...before } = marked(0, 0, 0);
    expect(armMismatches({ ...base, delivery: before }, current)).toEqual([]);
    const main = auditedBuild("main-ea12bff2a") as AuditedBuild;
    const w4 = auditedBuild("eval/w4") as AuditedBuild;
    for (const earlier of [main, w4, w3, w2b]) {
        expect(armMismatches({ ...base, delivery: marked(0, 0, 0) }, earlier)).toEqual([]);
        expect(armMismatches({ ...base, delivery: marked(4, 2, 1) }, earlier)).toEqual([
            `4 agent requests carry a <project-memory> block that ends with the closing sentence, which ${earlier.label} does not declare`,
            `2 agent requests carry a <NAMED_FILES> element in <project-memory>, which ${earlier.label} does not declare`,
            `1 agent requests render a statement dated as the replacement of an observation, which ${earlier.label} does not declare`,
        ]);
        expect(armMismatches({ ...base, delivery: marked(0, 0, 3) }, earlier)).toEqual([
            `3 agent requests render a statement dated as the replacement of an observation, which ${earlier.label} does not declare`,
        ]);
    }
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

test("the fallback note is read where the plugin writes it, at the start of the result", () => {
    // The quoted note stands at the start of a line inside the result, after its first line.
    const quoted =
        "Found 1 results\n\n[1] [memory] score=0.9 match=fused\nUser stated: the reply was\nMemory: the fused search route is unavailable (no_lane); results come from the legacy snapshot scan.";
    const root = armRoot([PI_ON, PASS], [quoted, LEGACY]);
    expect(observeArm("eidnara", "pi", root, {}).search).toMatchObject({
        legacy_scan: ["disabled"],
        fused: 1,
    });
});

test("a complete search result at a transcript's end is counted without its final newline", () => {
    const root = armRoot([PI_ON, PASS], [FUSED, LEGACY]);
    const file = join(root, "home/.pi/agent/sessions/--ws--/2026_sim-s-0000.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").trimEnd());
    expect(observeArm("eidnara", "pi", root, {}).search).toMatchObject({
        legacy_scan: ["disabled"],
        fused: 1,
    });
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
                with_system_points: 1,
                with_other_points: 0,
                input_tokens: 12,
                cache_read_tokens: 300,
                cache_write_tokens: 30,
            },
            memory_capture: {
                requests: 1,
                with_cache_points: 0,
                placed_by_proxy: 0,
                with_message_points: 0,
                with_system_points: 0,
                with_other_points: 0,
                input_tokens: 4,
                cache_read_tokens: 100,
                cache_write_tokens: 10,
            },
            other: {
                requests: 1,
                with_cache_points: 0,
                placed_by_proxy: 0,
                with_message_points: 0,
                with_system_points: 0,
                with_other_points: 0,
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
    const off = capabilityRecord(observed, null, undefined, "off", null, undefined);
    expect(off).toMatchObject({
        profile: armProfile("host"),
        eidnara_build: null,
        prompt_caching: "off",
        observed: { prompt_caching: { components: { agent: { with_cache_points: 0 } } } },
        mismatches: [],
    });
    expect(capabilityRecord(observed, null, undefined, "on", null, undefined).mismatches).toEqual([
        "2 of 2 agent requests carry no cache point, but the run registers prompt caching on",
    ]);
    // One request with a cache point leaves the other one outside the condition.
    observed.prompt_caching = { components: { agent: counts(1) } };
    expect(capabilityRecord(observed, null, undefined, "on", null, undefined).mismatches).toEqual([
        "1 of 2 agent requests carry no cache point, but the run registers prompt caching on",
    ]);
    observed.prompt_caching = { components: { agent: counts(2) } };
    expect(capabilityRecord(observed, null, undefined, "on", null, undefined)).toMatchObject({
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
    // A replayed turn spec from before the layout existed names none and gets Pi's two points.
    const legacy = body();
    expect(placeFor(undefined as never)(legacy, "history_summarizer")).toBe(2);
    expect(legacy.messages?.at(-1)?.content).toEqual([{ text: "more" }, POINT]);
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
    const w3 = auditedBuild("eval/w3-all") as AuditedBuild;
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

test("a reviewer request gets the system prompt's cache point by the build's layout, and each stage is held to carry one", () => {
    const sent = JSON.parse(
        readFileSync(join(import.meta.dir, "../../tests/fixtures/reviewer/requests.json"), "utf8"),
    ) as Record<"stage1" | "stage2", ConverseBody>;
    const stages = [
        ["memory_reviewer_stage1", sent.stage1],
        ["memory_reviewer_stage2", sent.stage2],
    ] as const;
    for (const [component, host] of stages) {
        // The daemon's child Pi sends the request with no cache point (`eval/w9` is a `system`
        // build): the proxy places the one after the system text and leaves the message as sent.
        const body = structuredClone(host);
        expect(bodyCachePoints(body)).toBe(0);
        expect(placeFor("system")(body, component)).toBe(1);
        expect(body).toEqual({ ...host, system: [...(host.system ?? []), POINT] });
        expect(placeFor("system")(body, component)).toBe(0);
        // Under Pi's own layout the same request carries the message's point too.
        const both = structuredClone(host);
        expect(placeFor("system-and-message")(both, component)).toBe(2);
        expect(both.messages?.[0]?.content.at(-1)).toEqual(POINT);
    }
    // The session-end count holds each stage to a cache point on every request.
    const live: Record<string, CachingCount> = {};
    noteRequest(live, "memory_reviewer_stage1", 1, 1);
    noteRequest(live, "memory_reviewer_stage1", 0);
    noteRequest(live, "memory_reviewer_stage2", 0);
    expect(cachingMismatches("on", { components: live })).toEqual([
        "1 of 2 memory_reviewer_stage1 requests carry no cache point, but the run registers prompt caching on",
        "1 of 1 memory_reviewer_stage2 requests carry no cache point, but the run registers prompt caching on",
    ]);
    expect(cachingMismatches("off", { components: live })).toEqual([]);
    // The arm-end tally reads the stored bodies: a point the proxy placed is counted as placed
    // and stays out of the layout check, which reads the points a host sent itself.
    const parts = new Map<string, RequestPart>([
        ["sys+", { field: "system", value: [...(sent.stage1.system ?? []), POINT] }],
        ["sys", { field: "system", value: sent.stage1.system }],
        ["u", { field: "messages", value: sent.stage1.messages?.[0] }],
    ]);
    const tokens = { input_tokens: 458, cache_read_tokens: 1_042, cache_write_tokens: 0 };
    const placed = { sha256: "x", bytes: 1, parts: ["sys+", "u"] };
    const tally = new CachingTally(parts);
    for (const [component] of stages) {
        tally.add({ component, request: placed, ...tokens, cache_points_placed: 1 });
    }
    const layout = { layout: "system" as const, label: "eval/w9" };
    expect(tally.observation().components).toMatchObject({
        memory_reviewer_stage1: {
            requests: 1,
            with_cache_points: 1,
            placed_by_proxy: 1,
            cache_read_tokens: 1_042,
        },
        memory_reviewer_stage2: { requests: 1, with_cache_points: 1, placed_by_proxy: 1 },
    });
    expect(cachingMismatches("on", tally.observation(), layout)).toEqual([]);
    const bare = { sha256: "y", bytes: 1, parts: ["sys", "u"] };
    tally.add({ component: "memory_reviewer_stage2", request: bare, ...tokens });
    expect(cachingMismatches("on", tally.observation(), layout)).toEqual([
        "1 of 2 memory_reviewer_stage2 requests carry no cache point, but the run registers prompt caching on",
    ]);
});

test("a reviewer call on an arm without the plugin is a mismatch, as every Eidnara component is", () => {
    const empty = join(tmp(), "r");
    mkdirSync(empty);
    const calls = { agent: 4, memory_reviewer_stage1: 3, memory_reviewer_stage2: 1 };
    const mismatches = armMismatches(observeArm("host", "pi", empty, calls));
    expect(mismatches).toContain("3 memory_reviewer_stage1 calls on a host-only arm");
    expect(mismatches).toContain("1 memory_reviewer_stage2 calls on a host-only arm");
});

test("a Pi arm's background requests show the cache-point layout its build declares", () => {
    const parts = new Map<string, RequestPart>([
        ["sys", { field: "system", value: [{ text: "s" }] }],
        ["sys+", { field: "system", value: [{ text: "s" }, POINT] }],
        ["u1", { field: "messages", value: { role: "user", content: [{ text: "a" }] } }],
        ["u1+", { field: "messages", value: { role: "user", content: [{ text: "a" }, POINT] } }],
        ["tools+", { field: "toolConfig", value: { tools: [{ toolSpec: { name: "t" } }, POINT] } }],
    ]);
    const tokens = { input_tokens: 4, cache_read_tokens: 100, cache_write_tokens: 10 };
    const request = (ids: string[]) => ({ sha256: "x", bytes: 1, parts: ids });
    const ALONE = ["sys+", "u1"];
    const PAIRED = ["sys+", "u1+"];
    /** One agent request, one capture request, and summarizer requests as `[parts, points the proxy placed]`. */
    const observe = (capture: string[], summarizer: [string[], number][]) => {
        const tally = new CachingTally(parts);
        tally.add({ component: "agent", request: request(PAIRED), ...tokens });
        tally.add({ component: "memory_capture", request: request(capture), ...tokens });
        for (const [ids, placed] of summarizer) {
            tally.add({
                component: "history_summarizer",
                request: request(ids),
                ...tokens,
                ...(placed > 0 ? { cache_points_placed: placed } : {}),
            });
        }
        return tally.observation();
    };
    const system = { layout: "system", label: "eval/w3-all" } as const;
    const both = { layout: "system-and-message", label: "eval/w2b" } as const;
    const alone = observe(ALONE, [[ALONE, 0]]);
    const paired = observe(PAIRED, [[PAIRED, 0]]);
    expect(alone.components.memory_capture?.with_message_points).toBe(0);
    expect(paired.components.history_summarizer?.with_message_points).toBe(1);
    // The agent's last message carries its point on either build.
    expect(cachingMismatches("on", alone, system)).toEqual([]);
    expect(cachingMismatches("on", paired, both)).toEqual([]);
    expect(cachingMismatches("on", paired, system)).toEqual([
        "1 of 1 history_summarizer requests with cache points of their own carry one on a message, but eval/w3-all declares the system prompt's cache point alone on a background call",
        "1 of 1 memory_capture requests with cache points of their own carry one on a message, but eval/w3-all declares the system prompt's cache point alone on a background call",
    ]);
    expect(cachingMismatches("on", alone, both)).toEqual([
        "1 of 1 history_summarizer requests with cache points of their own carry one on the system prompt alone, but eval/w2b declares one on the user message of a background call too",
        "1 of 1 memory_capture requests with cache points of their own carry one on the system prompt alone, but eval/w2b declares one on the user message of a background call too",
    ]);
    // Points the proxy placed follow the declared layout by construction, so each such request
    // stays outside the counts: a daemon-run component the proxy served whole shows nothing.
    const placed = observe(ALONE, [
        [PAIRED, 2],
        [PAIRED, 2],
    ]);
    expect(placed.components.history_summarizer).toMatchObject({
        with_cache_points: 2,
        placed_by_proxy: 2,
        with_message_points: 0,
        with_system_points: 0,
    });
    expect(cachingMismatches("on", placed, system)).toEqual([]);
    expect(cachingMismatches("on", observe(PAIRED, [[ALONE, 1]]), both)).toEqual([]);
    // A request that arrived with its own points beside proxy-served ones is still held to the layout.
    const mixed = observe(ALONE, [
        [ALONE, 1],
        [PAIRED, 0],
        [ALONE, 0],
    ]);
    expect(cachingMismatches("on", mixed, system)).toEqual([
        "1 of 2 history_summarizer requests with cache points of their own carry one on a message, but eval/w3-all declares the system prompt's cache point alone on a background call",
    ]);
    const mixedBoth = observe(PAIRED, [
        [PAIRED, 2],
        [ALONE, 0],
        [PAIRED, 0],
    ]);
    expect(cachingMismatches("on", mixedBoth, both)).toEqual([
        "1 of 2 history_summarizer requests with cache points of their own carry one on the system prompt alone, but eval/w2b declares one on the user message of a background call too",
    ]);
    // Both layouts place a point after the system prompt, so a request marked elsewhere alone
    // contradicts either one.
    const MESSAGE_ONLY = ["sys", "u1+"];
    expect(cachingMismatches("on", observe(MESSAGE_ONLY, [[PAIRED, 0]]), both)).toEqual([
        "1 of 1 memory_capture requests with cache points of their own carry none after the system prompt, where eval/w2b and every other build place one on a background call",
    ]);
    expect(cachingMismatches("on", observe(MESSAGE_ONLY, [[ALONE, 0]]), system)).toEqual([
        "1 of 1 memory_capture requests with cache points of their own carry none after the system prompt, where eval/w3-all and every other build place one on a background call",
        "1 of 1 memory_capture requests with cache points of their own carry one on a message, but eval/w3-all declares the system prompt's cache point alone on a background call",
    ]);
    // A point in the tool list belongs to neither layout, whatever the other parts carry.
    expect(cachingMismatches("on", observe([...ALONE, "tools+"], [[ALONE, 0]]), system)).toEqual([
        "1 of 1 memory_capture requests with cache points of their own carry one outside the system prompt and the messages, where eval/w3-all and every other build place none on a background call",
    ]);
    expect(
        cachingMismatches("on", observe([...PAIRED, "tools+"], [[PAIRED, 0]]), both),
    ).toHaveLength(1);
    const partly = observe(PAIRED, [
        [MESSAGE_ONLY, 0],
        [PAIRED, 0],
    ]);
    expect(cachingMismatches("on", partly, both)).toEqual([
        "1 of 2 history_summarizer requests with cache points of their own carry none after the system prompt, where eval/w2b and every other build place one on a background call",
    ]);
    // Another host, an arm without a daemon, and a count taken as calls start are held to nothing.
    expect(cachingMismatches("on", paired)).toEqual([]);
    expect(cachingMismatches("off", paired, system)).toEqual([]);
    const live: Record<string, CachingCount> = {};
    noteRequest(live, "memory_capture", 2);
    expect(cachingMismatches("on", { components: live }, system)).toEqual([]);
    expect(cachingMismatches("on", { components: live }, both)).toEqual([]);
    // The record reads the layout from the arm's variant on the bound build, for a Pi arm.
    const root = captured(armRoot([PI_ON, PASS]));
    daemonLog(root, []);
    const arm = observeArm("eidnara", "pi", root, { agent: 2, memory_capture: 1 });
    arm.prompt_caching = paired;
    const w3 = auditedBuild("eval/w3-all") as AuditedBuild;
    const w2b = auditedBuild("eval/w2b") as AuditedBuild;
    expect(capabilityRecord(arm, null, w2b, "on", null, undefined).mismatches).toEqual([]);
    expect(capabilityRecord(arm, null, w3, "on", null, undefined).mismatches).toEqual(
        cachingMismatches("on", paired, { layout: "system", label: w3.label }),
    );
    expect(
        capabilityRecord({ ...arm, host: "opencode" }, null, w3, "on", null, undefined).mismatches,
    ).toEqual(armMismatches({ ...arm, host: "opencode" }, w3));
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
