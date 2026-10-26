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
import { AUDITED_EIDNARA, armProfile } from "../hosts/profiles";
import {
    armMismatches,
    bootMismatches,
    logLength,
    observeArm,
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
function captured(
    root: string,
    classes: string[] = ["messages"],
    counters: Record<string, number> | null = { admitted: 1, completed: 1, units_published: 2 },
): string {
    const store = join(root, "..", "final-store");
    mkdirSync(store, { recursive: true });
    const db = new Database(join(store, "kernel.sqlite"));
    db.run(
        "create table object_registry(object_id text primary key, object_kind text, source_kind text, created_commit_seq integer, invalidated_commit_seq integer)",
    );
    db.run("create table commit_log(commit_seq integer primary key)");
    db.run("insert into commit_log values (1), (7)");
    for (const [i, c] of classes.entries()) {
        db.run("insert into object_registry values (?, 'observation', ?, 1, ?)", [
            `srcdesc:${c}${i}:1`,
            c,
            i === 0 ? null : 7,
        ]);
    }
    db.run("insert into object_registry values ('decision:x', 'decision', 'memory', 1, null)");
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
    expect(fallback.search).toEqual({ legacy_scan: ["disabled"], fused: 2, errored: 1 });
    expect(armMismatches(fallback)).toEqual([
        "2 eidnara_search results came from the fused route, but the arm declares legacy-scan",
    ]);
    const legacyOnly = observeArm("eidnara", "pi", armRoot([PI_ON, PASS], [LEGACY]), {});
    expect(armMismatches(legacyOnly)).toEqual([]);
    const hybrid = observeArm("eidnara-hybrid", "pi", captured(searched(), []), { agent: 1 });
    expect(armMismatches(hybrid)).toEqual([
        "1 eidnara_search results came from the legacy snapshot scan (disabled), but the arm declares the fused route",
    ]);
    expect(observeArm("eidnara", "opencode", root, { agent: 1 }).search).toBeNull();
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
        counters: { admitted: 1, completed: 1, units_published: 2 },
        counters_error: null,
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
    expect(nulls({ admitted: 1, completed: 1, oldest_deferred_age_ms: null })).toEqual([]);
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
        "insert into object_registry values ('srcdesc:z:1', 'observation', 'messages', 9, null)",
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
        expect(() => requireAuditedVariants(repo, ["eidnara"])).toThrow(
            new RegExp(`lacks commit ${AUDITED_EIDNARA}`),
        );
        expect(() => requireAuditedVariants(repo, ["host"])).not.toThrow();
    });

    test("a fixture source that changed since the audited commit is refused; other files pass", () => {
        const repo = tmp();
        git(repo, "init", "-q");
        const audited = commit(repo, "crates/daemon/examples/direct_host_fixture.rs", "a\n");
        commit(repo, "README.md", "unrelated\n");
        expect(() => requireAuditedVariants(repo, ["eidnara", "host"], audited)).not.toThrow();
        writeFileSync(join(repo, "crates/daemon/examples/direct_host_fixture.rs"), "edited\n");
        expect(() => requireAuditedVariants(repo, ["eidnara"], audited)).toThrow(
            /direct_host_fixture.rs changed since/,
        );
        commit(repo, "crates/daemon/examples/direct_host_fixture.rs", "b\n");
        expect(() => requireAuditedVariants(repo, ["eidnara-kl"], audited)).toThrow(
            /direct-host-fixture capabilities were read at .*crates\/daemon\/examples\/direct_host_fixture.rs changed since/,
        );
    });
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
