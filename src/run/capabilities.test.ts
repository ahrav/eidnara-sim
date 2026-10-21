import { afterEach, describe, expect, test } from "bun:test";
import {
    appendFileSync,
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

test("a knowledge-only arm with a transform pass or a history summarizer call is a mismatch", () => {
    const root = armRoot([PI_OFF, PASS]);
    const observed = observeArm("eidnara-kl", "pi", root, { agent: 3, history_summarizer: 1 });
    expect(observed.transform_passes).toBe(1);
    expect(armMismatches(observed)).toEqual([
        "1 transform passes, but the arm declares Eidnara compaction off",
        "1 history_summarizer calls, but the arm declares Eidnara compaction off",
    ]);
    const clean = observeArm("eidnara-kl", "pi", armRoot([PI_OFF]), {
        agent: 3,
        memory_capture: 1,
    });
    expect(armMismatches(clean)).toEqual([]);
});

test("a fallback-search arm that answered agent calls with no transform pass is a mismatch", () => {
    const observed = observeArm("eidnara", "pi", armRoot([PI_ON]), { agent: 2 });
    expect(armMismatches(observed)).toEqual([
        "2 agent calls and no transform pass, but the arm declares Eidnara compaction on",
    ]);
    const served = observeArm("eidnara", "pi", armRoot([PI_ON, PASS]), { agent: 2 });
    expect(armMismatches(served)).toEqual([]);
});

test("search results are checked against the route the arm declares", () => {
    const root = armRoot(
        [PI_ON, PASS],
        [LEGACY, FUSED, "Found 0 results", "Error: the memory search route answered refused"],
    );
    const fallback = observeArm("eidnara", "pi", root, { agent: 1 });
    expect(fallback.search).toEqual({ legacy_scan: ["disabled"], fused: 2, errored: 1 });
    expect(armMismatches(fallback)).toEqual([
        "2 eidnara_search results came from the fused route, but the arm declares legacy-scan",
    ]);
    const legacyOnly = observeArm("eidnara", "pi", armRoot([PI_ON, PASS], [LEGACY]), {});
    expect(armMismatches(legacyOnly)).toEqual([]);
    const hybrid = observeArm("eidnara-hybrid", "pi", root, { agent: 1 });
    expect(armMismatches(hybrid)).toEqual([
        "1 eidnara_search results came from the legacy snapshot scan (disabled), but the arm declares the fused route",
    ]);
    expect(observeArm("eidnara", "opencode", root, { agent: 1 }).search).toBeNull();
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
        commit(repo, "crates/daemon/examples/direct_host_fixture.rs", "b\n");
        expect(() => requireAuditedVariants(repo, ["eidnara-kl"], audited)).toThrow(
            /direct-host-fixture capabilities were read at .*crates\/daemon\/examples\/direct_host_fixture.rs changed since/,
        );
    });
});
