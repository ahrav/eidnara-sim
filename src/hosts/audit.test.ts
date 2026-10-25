import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditEidnara, renderAudit } from "./audit";
import type { VariantRecord } from "./profiles";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): { dir: string; commit: (files: Record<string, string>) => string } {
    const dir = mkdtempSync(join(tmpdir(), "sim-audit-"));
    dirs.push(dir);
    const git = (...args: string[]) => {
        const r = Bun.spawnSync(["git", "-C", dir, ...args], {
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        });
        if (r.exitCode !== 0) throw new Error(r.stderr.toString());
        return r.stdout.toString().trim();
    };
    git("init", "-q");
    return {
        dir,
        commit: (files) => {
            for (const [path, text] of Object.entries(files)) {
                mkdirSync(dirname(join(dir, path)), { recursive: true });
                writeFileSync(join(dir, path), text);
            }
            git("add", "-A");
            git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
            return git("rev-parse", "HEAD");
        },
    };
}

const VARIANT: VariantRecord = {
    search: "legacy-scan",
    embeddings: "deterministic-fixture",
    memory_reviewer: false,
    side_calls: "proxy",
    memory_injection: "always-on",
    source_capture: true,
    evidence: "test",
    sources: ["fixture.rs", "config.rs"],
    probes: [
        {
            capability: "search",
            file: "fixture.rs",
            pattern: "set_query_route_limits",
            present: false,
        },
        {
            capability: "source_capture",
            file: "config.rs",
            pattern: "/source_capture/enabled",
            present: true,
        },
    ],
};

test("a candidate with identical audited sources is unchanged, whatever else it changed", () => {
    const r = repo();
    const audited = r.commit({
        "fixture.rs": "fn main() {}",
        "config.rs": "/source_capture/enabled",
    });
    const candidate = r.commit({ "other.rs": "unrelated" });
    const report = auditEidnara(r.dir, candidate, audited, { fixture: VARIANT });
    expect(report.verdict).toBe("unchanged");
    expect(report.variants[0]?.changed).toEqual([]);
    expect(renderAudit(report)).toContain("verdict: unchanged");
});

test("a changed source whose probes hold asks for a reading of exactly the changed files", () => {
    const r = repo();
    const audited = r.commit({
        "fixture.rs": "fn main() {}",
        "config.rs": "/source_capture/enabled",
    });
    const candidate = r.commit({ "fixture.rs": "fn main() { run(); }", "other.rs": "x" });
    const report = auditEidnara(r.dir, candidate, audited, { fixture: VARIANT });
    expect(report.verdict).toBe("reread");
    expect(report.variants[0]?.changed).toEqual(["fixture.rs"]);
    expect(renderAudit(report)).toContain(`git diff ${audited} ${candidate} -- fixture.rs`);
});

test("a probe that reads differently at the candidate, or a removed file, breaks the table", () => {
    const r = repo();
    const audited = r.commit({
        "fixture.rs": "fn main() {}",
        "config.rs": "/source_capture/enabled",
    });
    const routed = r.commit({ "fixture.rs": "h.set_query_route_limits(x);" });
    const report = auditEidnara(r.dir, routed, audited, { fixture: VARIANT });
    expect(report.verdict).toBe("broken");
    expect(report.variants[0]?.probes.map((p) => p.holds)).toEqual([false, true]);
    expect(renderAudit(report)).toContain(
        "BROKEN search: fixture.rs lacks /set_query_route_limits/",
    );
    Bun.spawnSync(["git", "-C", r.dir, "rm", "-q", "config.rs"]);
    const removed = r.commit({ "fixture.rs": "fn main() {}" });
    const gone = auditEidnara(r.dir, removed, audited, { fixture: VARIANT });
    expect(gone.variants[0]?.probes.map((p) => p.holds)).toEqual([true, false]);
    expect(() => auditEidnara(r.dir, "0".repeat(40), audited, { fixture: VARIANT })).toThrow(
        /has no commit/,
    );
});
