import { expect, test } from "bun:test";
import {
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
    alertKey,
    alerts,
    decide,
    openLog,
    parseCampaign,
    type RunRecord,
    runProgress,
} from "../src/run/campaign";
import { Journal } from "../src/run/journal";

const ROOT = resolve(import.meta.dir, "..");

const FAKE_RUN = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "${ROOT}/src/run/journal";
const out = process.argv[process.argv.indexOf("--out") + 1];
const mode = process.argv[process.argv.indexOf("--mode") + 1];
mkdirSync(out, { recursive: true });
const count = join(out, "attempts");
const n = existsSync(count) ? Number(readFileSync(count, "utf8")) + 1 : 1;
writeFileSync(count, String(n));
writeFileSync(join(out, "manifest.json"), JSON.stringify({ events: 2, order: ["a"] }));
const j = new Journal(join(out, "journal.jsonl"));
j.append({ kind: "Preflight", arm: null, scenario_ms: 0 });
if (mode === "refuse") {
    console.error("error: run failed: fault f failed");
    process.exit(1);
}
if (n === 1) {
    j.append({ kind: "StartRun", arm: null, scenario_ms: 0 });
    j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
    j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-0", outcome: "ok" });
    console.error("error: run failed: user-sim call failed after 3 attempt(s)");
    process.exit(1);
}
j.append({ kind: "ResumeRun", arm: null, scenario_ms: 0 });
j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-1", outcome: "ok" });
j.append({ kind: "EndArm", arm: "a", scenario_ms: 0 });
j.append({ kind: "EndRun", arm: null, scenario_ms: 0 });
`;

test("the supervisor resumes a stopped run, finalizes it at EndRun, and gives up loudly on a repeating refusal", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-campaign-"));
    const fake = join(dir, "fake-run.ts");
    writeFileSync(fake, FAKE_RUN);
    const out = join(dir, "runs");
    const spec = {
        schema: "sim-campaign/v1",
        out,
        poll_ms: 50,
        max_resumes: 3,
        relaunch_backoff_ms: 20,
        inode_paths: [],
        run_command: ["bun", fake],
        finalize_commands: [
            ["bun", "-e", "process.exit(0)"],
            ["bun", "-e", "process.exit(3)"],
        ],
        runs: [
            { name: "good", args: ["--mode", "ok"] },
            { name: "bad", args: ["--mode", "refuse"] },
        ],
    };
    writeFileSync(join(dir, "campaign.json"), JSON.stringify(spec));
    const r = Bun.spawnSync([process.execPath, "scripts/campaign.ts", join(dir, "campaign.json")], {
        cwd: ROOT,
        timeout: 60_000,
    });
    const stderr = r.stderr.toString();
    expect(r.exitCode).toBe(1);
    const status = JSON.parse(readFileSync(join(out, "campaign-status.json"), "utf8"));
    const good = status.runs.find((x: { name: string }) => x.name === "good");
    const bad = status.runs.find((x: { name: string }) => x.name === "bad");
    expect(good).toMatchObject({
        state: "finalized",
        launches: 2,
        events_done: 2,
        events_total: 2,
        journal_resumes: 1,
        eta_ms: 0,
        finalize: [
            { command: "-e", exit: 0 },
            { command: "-e", exit: 3 },
        ],
    });
    expect(bad).toMatchObject({ state: "gave-up", launches: 3, stalled: 3 });
    expect(bad.last_error).toBe("error: run failed: fault f failed");
    expect(stderr).toContain("bad GAVE UP: 3 attempts in a row measured no event");
    expect(status.alerts).toContain(
        "run bad GAVE UP: 3 attempts in a row measured no event; last error: error: run failed: fault f failed",
    );
    const log = readFileSync(join(out, "campaign.log"), "utf8");
    expect(log).toContain("good resume 1");
    expect(log).toContain(
        "good stopped: error: run failed: user-sim call failed after 3 attempt(s)",
    );
    expect(readFileSync(join(out, "logs", "good.attempt1.log"), "utf8")).toContain("user-sim call");
    // A restarted supervisor keeps finished records, and starts over a run whose command changed.
    writeFileSync(
        join(dir, "campaign.json"),
        JSON.stringify({ ...spec, runs: [spec.runs[0], { name: "bad", args: ["--mode", "ok"] }] }),
    );
    const again = Bun.spawnSync(
        [process.execPath, "scripts/campaign.ts", join(dir, "campaign.json")],
        { cwd: ROOT, timeout: 60_000 },
    );
    const after = JSON.parse(readFileSync(join(out, "campaign-status.json"), "utf8"));
    expect(after.runs.find((x: { name: string }) => x.name === "good")).toMatchObject({
        state: "finalized",
        launches: 2,
    });
    expect(after.runs.find((x: { name: string }) => x.name === "bad")).toMatchObject({
        state: "finalized",
    });
    expect(readFileSync(join(out, "campaign.log"), "utf8")).toContain(
        "bad: its command line changed, so its record starts over",
    );
    expect(again.exitCode).toBe(1);
});

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
    name: "r",
    argv: [],
    state: "pending",
    launches: 0,
    stalled: 0,
    progress_at_launch: null,
    launched_at: null,
    stopped_at: null,
    last_error: null,
    step_failures: 0,
    finalize: [],
    gave_up_reason: null,
    ...over,
});

test("decide waits on a live run, bounds relaunches, and finalizes once", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-campaign-"));
    const progress = runProgress(dir);
    const act = (r: RunRecord, p = progress, running = false, now = 0) =>
        decide(r, p, running, 2, now, 1_000).action;
    expect(act(record(), progress, true)).toBe("wait");
    expect(act(record())).toBe("launch");
    expect(act(record({ launches: 3 }))).toBe("give-up");
    expect(act(record({ stalled: 3 }))).toBe("give-up");
    expect(act(record({ state: "finalized" }))).toBe("none");
    expect(act(record({ state: "finalizing" }))).toBe("wait");
    expect(act(record(), { ...progress, ended: true })).toBe("finalize");
    // A run that stopped without measuring an event waits 1x, then 4x the backoff.
    expect(act(record({ stalled: 1, stopped_at: 0 }), progress, false, 999)).toBe("wait");
    expect(act(record({ stalled: 1, stopped_at: 0 }), progress, false, 1_000)).toBe("launch");
    expect(act(record({ stalled: 2, stopped_at: 0 }), progress, false, 3_999)).toBe("wait");
});

test("alerts name a silent running run and a filesystem past 80% inode use", () => {
    const spec = parseCampaign({
        schema: "sim-campaign/v1",
        out: "/x",
        runs: [{ name: "r", args: [] }],
        stale_ms: 60_000,
        inode_paths: ["/tmp", "/data"],
    });
    const dir = mkdtempSync(join(tmpdir(), "sim-campaign-"));
    const j = new Journal(join(dir, "journal.jsonl"));
    j.append({ kind: "StartRun", arm: null, scenario_ms: 0 });
    const progress = runProgress(dir);
    const last = progress.last_entry_wall_ms as number;
    const got = alerts(
        spec,
        [{ record: record({ state: "running", launched_at: last - 60_000 }), progress }],
        last + 5 * 60_000,
        (path) => (path === "/tmp" ? 0.85 : 0.5),
    );
    expect(got).toEqual(["run r journaled nothing for 5 min", "/tmp inode use 85.0% passes 80%"]);
    // A relaunch counts from its launch, so a quiet journal from before it raises nothing yet.
    const relaunched = record({ state: "running", launched_at: last + 4 * 60_000 });
    expect(alerts(spec, [{ record: relaunched, progress }], last + 5 * 60_000, () => null)).toEqual(
        [],
    );
    expect(alertKey("run r journaled nothing for 5 min")).toBe(
        alertKey("run r journaled nothing for 7 min"),
    );
    expect(alertKey("run s101 GAVE UP: x")).not.toBe(alertKey("run s102 GAVE UP: x"));
});

test("a campaign file that lets a run pick its own --out, or repeats a name, is refused", () => {
    const base = { schema: "sim-campaign/v1", out: "/x" };
    expect(() => parseCampaign({ ...base, runs: [{ name: "r", args: ["--out", "/y"] }] })).toThrow(
        "names its own --out",
    );
    expect(() =>
        parseCampaign({
            ...base,
            runs: [
                { name: "r", args: [] },
                { name: "r", args: [] },
            ],
        }),
    ).toThrow("unique plain name");
    expect(() => parseCampaign({ ...base, runs: [{ name: "logs", args: [] }] })).toThrow(
        "unique plain name",
    );
    expect(() =>
        parseCampaign({ ...base, runs: [{ name: "r", args: [] }], run_command: "bun" }),
    ).toThrow("run_command is not a non-empty list of strings");
    expect(() =>
        parseCampaign({ ...base, runs: [{ name: "r", args: [] }], finalize_commands: [[]] }),
    ).toThrow("finalize_commands is not a list of non-empty string lists");
});

test("a supervisor log is opened only as a plain file, never through a link", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-campaign-"));
    const target = join(dir, "victim");
    writeFileSync(target, "keep\n");
    symlinkSync(target, join(dir, "link.log"));
    expect(() => openLog(join(dir, "link.log"), true)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("keep\n");
    linkSync(target, join(dir, "hard.log"));
    expect(() => openLog(join(dir, "hard.log"), true)).toThrow("is not a plain file");
    expect(readFileSync(target, "utf8")).toBe("keep\n");
});

test("a second supervisor on a campaign another one holds stops before it acts", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-campaign-"));
    const out = join(dir, "runs");
    const sleeper = join(dir, "sleep.ts");
    writeFileSync(
        sleeper,
        `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "pid"))}, String(process.pid));\nawait Bun.sleep(30_000);\n`,
    );
    const spec = {
        schema: "sim-campaign/v1",
        out,
        poll_ms: 50,
        inode_paths: [],
        run_command: ["bun", sleeper],
        runs: [{ name: "r", args: [] }],
    };
    writeFileSync(join(dir, "campaign.json"), JSON.stringify(spec));
    const first = Bun.spawn([process.execPath, "scripts/campaign.ts", join(dir, "campaign.json")], {
        cwd: ROOT,
        stdout: "ignore",
        stderr: "ignore",
    });
    try {
        const deadline = Date.now() + 20_000;
        const leased = () =>
            existsSync(out) && readdirSync(out).some((name) => name.startsWith("lease."));
        while (!leased()) {
            if (Date.now() > deadline) throw new Error("the first supervisor never took its lease");
            Bun.sleepSync(50);
        }
        const second = Bun.spawnSync(
            [process.execPath, "scripts/campaign.ts", join(dir, "campaign.json"), "--once"],
            { cwd: ROOT, timeout: 30_000 },
        );
        expect(second.exitCode).toBe(0);
        expect(second.stderr.toString()).toContain("another supervisor holds");
    } finally {
        first.kill("SIGKILL");
        const pid = join(dir, "pid");
        for (let i = 0; i < 100 && !existsSync(pid); i++) Bun.sleepSync(50);
        if (existsSync(pid)) process.kill(Number(readFileSync(pid, "utf8")), "SIGKILL");
    }
});

test("a linked run directory is never launched or finalized, and raises an alert", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-campaign-"));
    const out = join(dir, "runs");
    const elsewhere = join(dir, "elsewhere");
    mkdirSync(out, { recursive: true });
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(out, "r"));
    const spec = {
        schema: "sim-campaign/v1",
        out,
        inode_paths: [],
        run_command: ["bun", "-e", "process.exit(0)"],
        runs: [{ name: "r", args: [] }],
    };
    writeFileSync(join(dir, "campaign.json"), JSON.stringify(spec));
    const r = Bun.spawnSync(
        [process.execPath, "scripts/campaign.ts", join(dir, "campaign.json"), "--once"],
        { cwd: ROOT, timeout: 30_000 },
    );
    expect(r.stderr.toString()).toContain("is a link; a run directory must be a plain directory");
    const status = JSON.parse(readFileSync(join(out, "campaign-status.json"), "utf8"));
    expect(status.runs[0]).toMatchObject({ launches: 0, step_failures: 1 });
});

test("a status file whose records carry impossible counters is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-campaign-"));
    const out = join(dir, "runs");
    mkdirSync(out, { recursive: true });
    const spec = {
        schema: "sim-campaign/v1",
        out,
        inode_paths: [],
        run_command: ["bun", "-e", "process.exit(0)"],
        runs: [{ name: "r", args: [] }],
    };
    writeFileSync(join(dir, "campaign.json"), JSON.stringify(spec));
    const argv = ["bun", "-e", "process.exit(0)", "--out", join(out, "r")];
    writeFileSync(
        join(out, "campaign-status.json"),
        JSON.stringify({
            schema: "sim-campaign-status/v1",
            runs: [{ name: "r", argv, state: "pending", launches: -5, stalled: 0 }],
        }),
    );
    const r = Bun.spawnSync(
        [process.execPath, "scripts/campaign.ts", join(dir, "campaign.json"), "--once"],
        { cwd: ROOT, timeout: 30_000 },
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("is no sim-campaign-status/v1 file");
});
