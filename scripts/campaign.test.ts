import { expect, test } from "bun:test";
import {
    appendFileSync,
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
    admitted,
    alertKey,
    alerts,
    C7_PRICES,
    callUsd,
    decide,
    groupKey,
    noSpend,
    openLog,
    parseCampaign,
    type RunRecord,
    readSpend,
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
    // A restarted supervisor keeps finished records, refuses a changed command for a run that
    // started, and starts over the record of one that has not.
    const restart = (runs: unknown[]) => {
        writeFileSync(join(dir, "campaign.json"), JSON.stringify({ ...spec, runs }));
        return Bun.spawnSync(
            [process.execPath, "scripts/campaign.ts", join(dir, "campaign.json")],
            {
                cwd: ROOT,
                timeout: 60_000,
            },
        );
    };
    const changed = restart([spec.runs[0], { name: "bad", args: ["--mode", "ok"] }]);
    expect(changed.exitCode).toBe(2);
    expect(changed.stderr.toString()).toContain(
        "bad: its command line changed after the run started",
    );
    const added = restart([spec.runs[0], spec.runs[1], { name: "new", args: ["--mode", "ok"] }]);
    const after = JSON.parse(readFileSync(join(out, "campaign-status.json"), "utf8"));
    expect(after.runs.find((x: { name: string }) => x.name === "good")).toMatchObject({
        state: "finalized",
        launches: 2,
    });
    expect(after.runs.find((x: { name: string }) => x.name === "bad")).toMatchObject({
        state: "gave-up",
    });
    expect(after.runs.find((x: { name: string }) => x.name === "new")).toMatchObject({
        state: "finalized",
    });
    expect(added.exitCode).toBe(1);
});

test("a campaign's sim_upgrade rides on resumes only, keeps restored records, and needs this checkout at it", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-campaign-"));
    const fake = join(dir, "fake-run.ts");
    const marker = "mkdirSync(out, { recursive: true });";
    writeFileSync(
        fake,
        FAKE_RUN.replace(
            marker,
            `${marker}\nappendFileSync(join(out, "argv.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");`,
        ),
    );
    const head = Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "HEAD"]).stdout.toString().trim();
    const out = join(dir, "runs");
    const spec = {
        schema: "sim-campaign/v1",
        out,
        poll_ms: 50,
        relaunch_backoff_ms: 20,
        inode_paths: [],
        run_command: ["bun", fake],
        finalize_commands: [["bun", "-e", "process.exit(0)"]],
        runs: [
            { name: "good", args: ["--mode", "ok"] },
            { name: "bad", args: ["--mode", "refuse"] },
        ],
    };
    const supervise = (over: Record<string, unknown>) => {
        writeFileSync(join(dir, "campaign.json"), JSON.stringify({ ...spec, ...over }));
        return Bun.spawnSync(
            [process.execPath, "scripts/campaign.ts", join(dir, "campaign.json")],
            {
                cwd: ROOT,
                timeout: 60_000,
            },
        );
    };
    const other = "0".repeat(40);
    const refused = supervise({ sim_upgrade: other });
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr.toString()).toContain(`sim_upgrade names ${other}; this checkout runs`);
    expect(existsSync(out)).toBe(false);
    expect(supervise({ sim_upgrade: head }).exitCode).toBe(1);
    const argvs = (name: string) =>
        readFileSync(join(out, name, "argv.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l));
    const base = (name: string, mode: string) => ["--mode", mode, "--out", join(out, name)];
    const good = base("good", "ok");
    expect(argvs("good")).toEqual([good, [...good, "--sim-upgrade", head]]);
    // A run that stopped before `StartRun` left a manifest, so its relaunch is a resume too.
    const bad = base("bad", "refuse");
    const upgraded = [...bad, "--sim-upgrade", head];
    expect(argvs("bad")).toEqual([bad, upgraded, upgraded]);
    const status = JSON.parse(readFileSync(join(out, "campaign-status.json"), "utf8"));
    expect(status.runs[0]).toMatchObject({ state: "finalized", argv: ["bun", fake, ...good] });
    // Dropping the field leaves every started run's record standing.
    expect(supervise({}).exitCode).toBe(1);
    const after = JSON.parse(readFileSync(join(out, "campaign-status.json"), "utf8"));
    expect(after.runs.map((r: { state: string }) => r.state)).toEqual(["finalized", "gave-up"]);
    expect(() => parseCampaign({ ...spec, sim_upgrade: "abc123" })).toThrow(
        "sim_upgrade is not a full commit hash",
    );
    // The supervisor owns the flag, so a campaign's own arguments may not name it.
    const flagged = { ...spec, sim_upgrade: head };
    expect(() => parseCampaign({ ...flagged, args: ["--sim-upgrade", head] })).toThrow(
        "shared args name --sim-upgrade",
    );
    expect(() =>
        parseCampaign({ ...flagged, runs: [{ name: "r", args: ["--sim-upgrade", head] }] }),
    ).toThrow("run r names its own --sim-upgrade");
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

const SLOW_RUN = `
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "${ROOT}/src/run/journal";
const out = process.argv[process.argv.indexOf("--out") + 1];
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "manifest.json"), JSON.stringify({ events: 1, order: ["a"] }));
const started = Date.now();
const call = { component: "agent", input_tokens: 1_000_000, output_tokens: 40_000, cache_read_tokens: 0, cache_write_tokens: 0 };
appendFileSync(join(out, "calls.jsonl"), JSON.stringify(call) + "\\n");
await Bun.sleep(400);
const j = new Journal(join(out, "journal.jsonl"));
j.append({ kind: "StartRun", arm: null, scenario_ms: 0 });
j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-0", outcome: "ok" });
j.append({ kind: "EndRun", arm: null, scenario_ms: 0 });
writeFileSync(join(out, "times.json"), JSON.stringify({ started, ended: Date.now() }));
`;

test("max_concurrent starts each group whole, in campaign order, and the status sums each run's spend", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-campaign-"));
    const fake = join(dir, "slow-run.ts");
    writeFileSync(fake, SLOW_RUN);
    const out = join(dir, "runs");
    const spec = {
        schema: "sim-campaign/v1",
        out,
        poll_ms: 50,
        inode_paths: [],
        run_command: ["bun", fake],
        finalize_commands: [["bun", "-e", "process.exit(0)"]],
        max_concurrent: 2,
        spend_cap_usd: 10,
        runs: [
            { name: "a1", args: [], group: "a" },
            { name: "a2", args: [], group: "a" },
            { name: "b1", args: [], group: "b" },
            { name: "c1", args: [], group: "c" },
            { name: "c2", args: [], group: "c" },
        ],
    };
    writeFileSync(join(dir, "campaign.json"), JSON.stringify(spec));
    const r = Bun.spawnSync([process.execPath, "scripts/campaign.ts", join(dir, "campaign.json")], {
        cwd: ROOT,
        timeout: 60_000,
    });
    expect(r.exitCode).toBe(0);
    const times = Object.fromEntries(
        spec.runs.map(({ name }) => [
            name,
            JSON.parse(readFileSync(join(out, name, "times.json"), "utf8")) as {
                started: number;
                ended: number;
            },
        ]),
    );
    const t = (n: string) => times[n] as { started: number; ended: number };
    // A group's runs launch in one poll, and a later group waits for the slots it needs.
    expect(Math.abs(t("a1").started - t("a2").started)).toBeLessThan(300);
    expect(Math.abs(t("c1").started - t("c2").started)).toBeLessThan(300);
    expect(t("b1").started).toBeGreaterThanOrEqual(Math.min(t("a1").ended, t("a2").ended));
    expect(t("c1").started).toBeGreaterThanOrEqual(t("b1").ended);
    const status = JSON.parse(readFileSync(join(out, "campaign-status.json"), "utf8"));
    // Each run spent 1M input and 40k output tokens: $5 + $1 at c7's prices.
    expect(status.spend_usd).toBe(30);
    expect(status.max_concurrent).toBe(2);
    expect(status.runs.find((x: { name: string }) => x.name === "b1")).toMatchObject({
        group: "b",
        spend_usd: 6,
        spend_calls: 1,
        spend_by_component: { agent: 6 },
    });
    expect(status.alerts).toContain("campaign spend $30.00 passes the $10 cap");
});

test("admission holds a group back until all its runs fit, and never splits one", () => {
    const slot = (name: string, group: string, begun = false, holding = begun) => ({
        name,
        group,
        begun,
        holding,
    });
    const fresh = [slot("a1", "a"), slot("a2", "a"), slot("b1", "b"), slot("c1", "c")];
    expect([...admitted(null, fresh)]).toEqual(["a1", "a2", "b1", "c1"]);
    expect([...admitted(3, fresh)]).toEqual(["a1", "a2", "b1"]);
    expect([...admitted(2, fresh)]).toEqual(["a1", "a2"]);
    // A begun group keeps all its runs, and its open runs fill the slots a later group needs.
    const running = [
        slot("a1", "a", true),
        slot("a2", "a", true),
        slot("b1", "b"),
        slot("c1", "c"),
    ];
    expect([...admitted(3, running)]).toEqual(["a1", "a2", "b1"]);
    // A run that ended holds no slot, and the first group that does not fit holds back the rest.
    const ended = [
        slot("a1", "a", true, false),
        slot("a2", "a", true, true),
        slot("b1", "b"),
        slot("b2", "b"),
        slot("c1", "c"),
    ];
    expect([...admitted(2, ended)]).toEqual(["a1", "a2"]);
    expect([...admitted(3, ended)]).toEqual(["a1", "a2", "b1", "b2"]);
    // A group that began only in part reserves a slot for each of its runs still to launch.
    const partial = [slot("a1", "a", true), slot("a2", "a"), slot("b1", "b")];
    expect([...admitted(2, partial)]).toEqual(["a1", "a2"]);
    expect([...admitted(3, partial)]).toEqual(["a1", "a2", "b1"]);
});

test("spend reads only complete call records, and starts over on a shrunk or replaced file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-campaign-"));
    const path = join(dir, "calls.jsonl");
    const rec = (component: string, input: number, output: number, cr = 0, cw = 0) =>
        JSON.stringify({
            component,
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cr,
            cache_write_tokens: cw,
        });
    expect(readSpend(path, noSpend(), C7_PRICES)).toEqual(noSpend());
    writeFileSync(path, `${rec("agent", 2_000_000, 0)}\n${rec("user-sim", 0, 0, 1_000_000, 0)}`);
    const first = readSpend(path, noSpend(), C7_PRICES);
    expect(first).toMatchObject({ usd: 10, calls: 1, by_component: { agent: 10 } });
    appendFileSync(path, `\n${rec("memory_capture", 0, 0, 0, 1_000_000)}\nnot json\n`);
    const second = readSpend(path, first, C7_PRICES);
    expect(second.usd).toBeCloseTo(10 + 0.5 + 6.25, 9);
    expect(second.calls).toBe(3);
    expect(second.by_component).toEqual({ agent: 10, "user-sim": 0.5, memory_capture: 6.25 });
    expect(readSpend(path, second, C7_PRICES)).toEqual(second);
    writeFileSync(path, `${rec("agent", 0, 40_000)}\n`);
    expect(readSpend(path, second, C7_PRICES)).toMatchObject({ usd: 1, calls: 1 });
    expect(callUsd({ input_tokens: -5, output_tokens: "x" }, C7_PRICES)).toBe(0);
    // A complete line that is JSON but not an object is passed over, and later records count.
    writeFileSync(path, `null\n[1]\n${rec("agent", 0, 40_000)}\n`);
    expect(readSpend(path, noSpend(), C7_PRICES)).toMatchObject({ usd: 1, calls: 1 });
    // Only an absent file has spent nothing; a file that cannot be opened is an error.
    const linked = join(dir, "linked.jsonl");
    symlinkSync(path, linked);
    expect(() => readSpend(linked, noSpend(), C7_PRICES)).toThrow();
});

test("a campaign file with a group larger than max_concurrent, bad prices, or a bad cap is refused", () => {
    const base = { schema: "sim-campaign/v1", out: "/x" };
    const runs = [
        { name: "r1", args: [], group: "g" },
        { name: "r2", args: [], group: "g" },
    ];
    expect(() => parseCampaign({ ...base, runs, max_concurrent: 1 })).toThrow(
        "group g has 2 runs, more than max_concurrent 1",
    );
    expect(() => parseCampaign({ ...base, runs, max_concurrent: 0 })).toThrow(
        "max_concurrent is not a positive integer",
    );
    expect(() => parseCampaign({ ...base, runs, prices: { input: 5 } })).toThrow("prices needs");
    expect(() => parseCampaign({ ...base, runs, spend_cap_usd: -1 })).toThrow(
        "spend_cap_usd is not a positive number",
    );
    expect(() =>
        parseCampaign({ ...base, runs: [{ name: "r", args: [], group: "../g" }] }),
    ).toThrow("group is not a plain name");
    // A run without a group is its own group, even when another run's group shares its name.
    const shared = [
        { name: "foo", args: [] },
        { name: "bar", args: [], group: "foo" },
    ];
    expect(parseCampaign({ ...base, runs: shared, max_concurrent: 1 }).max_concurrent).toBe(1);
    expect(groupKey({ name: "foo" })).not.toBe(groupKey({ name: "bar", group: "foo" }));
    expect(parseCampaign({ ...base, runs })).toMatchObject({
        max_concurrent: null,
        prices: C7_PRICES,
        spend_cap_usd: null,
    });
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
            existsSync(out) && readdirSync(out).some((name) => /^lease\.\d+\.json$/.test(name));
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

test("a signal to the supervisor kills its finalize steps and their helpers before the lease is released", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-campaign-"));
    const out = join(dir, "runs");
    const fake = join(dir, "fake-run.ts");
    writeFileSync(fake, FAKE_RUN);
    const pid = join(dir, "finalizer.pid");
    const slow = join(dir, "slow.ts");
    // The step starts a helper of its own, which must die with it.
    writeFileSync(
        slow,
        `const helper = Bun.spawn(["sleep", "60"]);\nrequire("node:fs").writeFileSync(${JSON.stringify(pid)}, String(helper.pid));\nawait Bun.sleep(60_000);\n`,
    );
    const spec = {
        schema: "sim-campaign/v1",
        out,
        poll_ms: 50,
        inode_paths: [],
        relaunch_backoff_ms: 20,
        run_command: ["bun", fake],
        finalize_commands: [["bun", slow]],
        runs: [{ name: "good", args: ["--mode", "ok"] }],
    };
    writeFileSync(join(dir, "campaign.json"), JSON.stringify(spec));
    const supervisor = Bun.spawn(
        [process.execPath, "scripts/campaign.ts", join(dir, "campaign.json")],
        { cwd: ROOT, stdout: "ignore", stderr: "ignore" },
    );
    const deadline = Date.now() + 30_000;
    while (!existsSync(pid)) {
        if (Date.now() > deadline) throw new Error("the finalize step never started");
        await Bun.sleep(50);
    }
    const finalizer = Number(readFileSync(pid, "utf8"));
    supervisor.kill("SIGTERM");
    await supervisor.exited;
    await Bun.sleep(200);
    const alive = (() => {
        try {
            process.kill(finalizer, 0);
            return true;
        } catch {
            return false;
        }
    })();
    expect(alive).toBe(false);
});

test("runProgress counts an interrupted turn as failed and an interrupted session_end as no turn", () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-campaign-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ events: 3, order: ["a"] }));
    const j = new Journal(join(dir, "journal.jsonl"));
    j.append({ kind: "StartRun", arm: null, scenario_ms: 0 });
    j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
    j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: "e-1" });
    const cut = { outcome: "failed(interrupted)", cause: "host-teardown" };
    j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-1", ...cut });
    j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-2", ...cut });
    j.close();
    expect(runProgress(dir).failed_turns).toBe(1);
});
