import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { alerts, decide, parseCampaign, type RunRecord, runProgress } from "../src/run/campaign";
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
    expect(bad).toMatchObject({ state: "gave-up", launches: 2, stalled: 2 });
    expect(bad.last_error).toBe("error: run failed: fault f failed");
    expect(stderr).toContain("bad GAVE UP: two attempts in a row made no progress");
    expect(status.alerts).toContain(
        "run bad GAVE UP: two attempts in a row made no progress; last error: error: run failed: fault f failed",
    );
    const log = readFileSync(join(out, "campaign.log"), "utf8");
    expect(log).toContain("good resume 1");
    expect(log).toContain(
        "good stopped: error: run failed: user-sim call failed after 3 attempt(s)",
    );
    expect(readFileSync(join(out, "logs", "good.attempt1.log"), "utf8")).toContain("user-sim call");
});

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
    name: "r",
    state: "pending",
    launches: 0,
    stalled: 0,
    progress_at_launch: null,
    last_error: null,
    finalize: [],
    gave_up_reason: null,
    ...over,
});

test("decide waits on a live run, bounds relaunches, and finalizes once", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-campaign-"));
    const progress = runProgress(dir);
    expect(decide(record(), progress, true, 2)).toBe("wait");
    expect(decide(record(), progress, false, 2)).toBe("launch");
    expect(decide(record({ launches: 3 }), progress, false, 2)).toBe("give-up");
    expect(decide(record({ stalled: 2 }), progress, false, 2)).toBe("give-up");
    expect(decide(record({ state: "finalized" }), progress, false, 2)).toBe("none");
    expect(decide(record(), { ...progress, ended: true }, false, 2)).toBe("finalize");
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
        [{ record: record({ state: "running" }), progress }],
        last + 5 * 60_000,
        (path) => (path === "/tmp" ? 0.85 : 0.5),
    );
    expect(got).toEqual(["run r journaled nothing for 5 min", "/tmp inode use 85.0% passes 80%"]);
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
});
