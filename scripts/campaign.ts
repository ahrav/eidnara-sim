import {
    appendFileSync,
    closeSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadConfig } from "../src/config/config";
import { writeAtomic } from "../src/run/atomic";
import {
    alertKey,
    alerts,
    type CampaignSpec,
    decide,
    finalizeArgv,
    lastErrorIn,
    launchArgv,
    openLog,
    parseCampaign,
    type RunProgress,
    type RunRecord,
    runDir,
    runProgress,
    STALL_LIMIT,
} from "../src/run/campaign";
import { leaseHeld, releaseLease, takeLease } from "../src/run/journal";
import { requireOutsideCheckout, requireOutsideIdentity } from "../src/run/run";

const USAGE = "usage: bun scripts/campaign.ts <campaign.json> [--once]";
const ROOT = resolve(import.meta.dir, "..");

const args = process.argv.slice(2);
const once = args.includes("--once");
const files = args.filter((a) => a !== "--once");
if (files.length !== 1 || files.some((a) => a.startsWith("--"))) {
    console.error(USAGE);
    process.exit(2);
}
const spec: CampaignSpec = parseCampaign(JSON.parse(readFileSync(files[0] as string, "utf8")));
const config = loadConfig();
requireOutsideCheckout(spec.out, config.eidnara_checkout);
requireOutsideCheckout(spec.out, config.pi_install, "the Pi install");
if (config.upgrade?.pi_install) {
    requireOutsideCheckout(spec.out, config.upgrade.pi_install, "the upgrade Pi install");
}
requireOutsideIdentity(spec.out);
mkdirSync(spec.out, { recursive: true });
// One supervisor per campaign: a second one, an overlapping cron pass included, stops here.
let lease: ReturnType<typeof takeLease>;
try {
    lease = takeLease(spec.out);
} catch (caught) {
    // A live holder is another supervisor; any other lease failure is this pass's own error.
    const held = (() => {
        try {
            return leaseHeld(spec.out);
        } catch {
            return false;
        }
    })();
    const why = (caught as Error).message;
    console.error(
        held ? `another supervisor holds ${spec.out}: ${why}` : `lease of ${spec.out}: ${why}`,
    );
    process.exit(held && once ? 0 : 2);
}
const finalizers = new Set<ReturnType<typeof Bun.spawn>>();
// A finalize step outliving this supervisor would race the next one's finalize of the same run,
// so each step's process group dies before the lease is released.
process.on("exit", () => {
    for (const child of finalizers) {
        try {
            process.kill(-child.pid, "SIGKILL");
        } catch {
            child.kill("SIGKILL");
        }
    }
    releaseLease(spec.out, lease);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(130));
const logs = join(spec.out, "logs");
mkdirSync(logs, { recursive: true });
if (
    lstatSync(logs).isSymbolicLink() ||
    realpathSync(logs) !== join(realpathSync(spec.out), "logs")
) {
    console.error(`${logs} must be a plain directory inside ${spec.out}`);
    process.exit(2);
}
const statusPath = join(spec.out, "campaign-status.json");
const campaignLog = join(spec.out, "campaign.log");

const say = (line: string, loud = false) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    try {
        const fd = openLog(campaignLog, false);
        try {
            appendFileSync(fd, `${stamped}\n`);
        } finally {
            closeSync(fd);
        }
    } catch (caught) {
        console.error(`campaign.log: ${(caught as Error).message}`);
    }
    if (loud) {
        const bar = "!".repeat(Math.min(100, stamped.length));
        console.error(`${bar}\n${stamped}\n${bar}`);
    } else console.log(stamped);
};

const fresh = (name: string): RunRecord => ({
    name,
    argv: launchArgv(spec, spec.runs.find((r) => r.name === name) as CampaignSpec["runs"][number]),
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
});
const KEPT: (keyof RunRecord)[] = [
    "state",
    "launches",
    "stalled",
    "progress_at_launch",
    "launched_at",
    "stopped_at",
    "last_error",
    "step_failures",
    "finalize",
    "gave_up_reason",
];
function savedRuns(): Record<string, unknown>[] {
    if (!existsSync(statusPath)) return [];
    const status = JSON.parse(readFileSync(statusPath, "utf8"));
    const runs = status?.runs;
    const plain = (r: unknown) => typeof r === "object" && r !== null && !Array.isArray(r);
    const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
    const stamp = (v: unknown) => v === null || count(v);
    const states = new Set(["pending", "running", "finalizing", "finalized", "gave-up"]);
    const valid = (r: Record<string, unknown>) =>
        typeof r.name === "string" &&
        states.has(r.state as string) &&
        ["launches", "stalled", "step_failures"].every((k) => r[k] === undefined || count(r[k])) &&
        ["progress_at_launch", "launched_at", "stopped_at"].every(
            (k) => r[k] === undefined || stamp(r[k]),
        ) &&
        Array.isArray(r.argv) &&
        (r.finalize === undefined ||
            (Array.isArray(r.finalize) &&
                r.finalize.every(
                    (f: unknown) =>
                        plain(f) &&
                        typeof (f as { command?: unknown }).command === "string" &&
                        ((f as { exit?: unknown }).exit === null ||
                            Number.isInteger((f as { exit?: unknown }).exit)),
                )));
    if (
        status?.schema !== "sim-campaign-status/v1" ||
        !Array.isArray(runs) ||
        !runs.every((r) => plain(r) && valid(r))
    ) {
        throw new Error(
            `${statusPath} is no sim-campaign-status/v1 file; move it aside to start over`,
        );
    }
    return runs;
}
const saved = savedRuns();
const records = new Map(
    spec.runs.map((r) => {
        const record = fresh(r.name);
        const found = saved.find((s) => s.name === r.name);
        const old =
            found && JSON.stringify(found.argv) === JSON.stringify(record.argv) ? found : undefined;
        if (found && !old) {
            // A started run keeps the identity its manifest pins, so its command stays fixed.
            if (existsSync(join(runDir(spec, r.name), "journal.jsonl"))) {
                console.error(
                    `${r.name}: its command line changed after the run started; restore it or give the run a new name`,
                );
                process.exit(2);
            }
            say(`${r.name}: its command line changed, so its record starts over`);
        }
        for (const k of KEPT) {
            if (old && old[k] !== undefined) Object.assign(record, { [k]: old[k] });
        }
        if (record.state === "finalizing") record.state = "pending";
        // A finalized record stands only while its run directory still ends in `EndRun`.
        if (record.state === "finalized") {
            let ended = false;
            try {
                ended = runProgress(runDir(spec, r.name)).ended;
            } catch {
                ended = false;
            }
            if (!ended) {
                say(`${r.name}: recorded finalized, but its journal has no EndRun; it starts over`);
                Object.assign(record, fresh(r.name));
            }
        }
        return [r.name, record];
    }),
);
const children = new Map<string, ReturnType<typeof Bun.spawn>>();
const argv = (command: string[]) =>
    command[0] === "bun" ? [process.execPath, ...command.slice(1)] : command;
const logOf = (name: string) => join(logs, `${name}.log`);

function launch(run: CampaignSpec["runs"][number], record: RunRecord, progress: RunProgress) {
    const log = logOf(run.name);
    if (existsSync(log)) renameSync(log, join(logs, `${run.name}.attempt${record.launches}.log`));
    const fd = openLog(log, true);
    const command = argv(launchArgv(spec, run));
    // A launch that cannot even start counts as an attempt that measured nothing.
    record.launches++;
    record.progress_at_launch = progress.measured_events;
    record.launched_at = Date.now();
    try {
        const child = Bun.spawn(command, {
            cwd: ROOT,
            env: process.env,
            stdin: "ignore",
            stdout: fd,
            stderr: fd,
            detached: true,
        });
        child.unref();
        children.set(run.name, child);
    } catch (caught) {
        record.stalled++;
        record.stopped_at = Date.now();
        throw caught;
    } finally {
        closeSync(fd);
    }
    record.state = "running";
    const what = progress.started ? `resume ${record.launches - 1}` : "launch";
    say(`${run.name} ${what}: ${command.join(" ")}`);
}

async function finalize(name: string, record: RunRecord) {
    record.state = "finalizing";
    record.finalize = [];
    for (const command of finalizeArgv(spec, name)) {
        const tool = basename(command[1] ?? command[0] ?? "step").replace(/\.ts$/, "");
        let exit: number | null = null;
        try {
            const fd = openLog(join(logs, `${name}.${tool}.log`), true);
            try {
                const child = Bun.spawn(argv(command), {
                    cwd: ROOT,
                    env: process.env,
                    stdin: "ignore",
                    stdout: fd,
                    stderr: fd,
                    timeout: spec.finalize_timeout_ms,
                    killSignal: "SIGKILL",
                    detached: true,
                });
                finalizers.add(child);
                try {
                    exit = await child.exited;
                } finally {
                    finalizers.delete(child);
                }
            } finally {
                closeSync(fd);
            }
        } catch (caught) {
            say(`${name} ${tool}: ${(caught as Error).message}`, true);
        }
        record.finalize.push({ command: tool, exit });
    }
    record.state = "finalized";
    const exits = record.finalize.map((f) => `${f.command}=${f.exit}`).join(" ");
    say(
        `${name} finalized: ${exits}`,
        record.finalize.some((f) => f.exit !== 0),
    );
}

const live = (name: string) => {
    const child = children.get(name);
    return child !== undefined && child.exitCode === null && child.signalCode === null;
};
const empty = (now: number) => runProgress(join(spec.out, ".no-run"), now);

function step(run: CampaignSpec["runs"][number], record: RunRecord, now: number): RunProgress {
    const dir = runDir(spec, run.name);
    if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error(`${dir} is a link; a run directory must be a plain directory`);
    }
    const progress = runProgress(dir, now);
    const running = live(run.name) || (existsSync(dir) && leaseHeld(dir));
    if (record.state === "running" && !running) {
        record.last_error = lastErrorIn(logOf(run.name)) ?? record.last_error;
        record.stalled =
            progress.measured_events === record.progress_at_launch ? record.stalled + 1 : 0;
        record.stopped_at = now;
        record.state = "pending";
        if (!progress.ended) say(`${run.name} stopped: ${record.last_error ?? "no error line"}`);
    }
    const decision = decide(
        record,
        progress,
        running,
        spec.max_resumes,
        now,
        spec.relaunch_backoff_ms,
    );
    if (decision.action === "launch") launch(run, record, progress);
    if (decision.action === "finalize") {
        finalize(run.name, record).catch((caught) => {
            record.state = "finalized";
            say(`${run.name} finalize failed: ${(caught as Error).message}`, true);
        });
    }
    if (decision.action === "give-up") {
        record.state = "gave-up";
        record.gave_up_reason = decision.reason;
        say(`${run.name} GAVE UP: ${decision.reason}`, true);
    }
    if (decision.action === "wait" && running) record.state = "running";
    return progress;
}

let raised = new Set<string>();
for (;;) {
    const now = Date.now();
    const rows: { record: RunRecord; progress: RunProgress }[] = [];
    for (const run of spec.runs) {
        const record = records.get(run.name) as RunRecord;
        try {
            rows.push({ record, progress: step(run, record, now) });
            record.step_failures = 0;
        } catch (caught) {
            record.last_error = `supervisor: ${(caught as Error).message}`;
            record.step_failures++;
            say(`ALERT run ${run.name}: supervisor step failed: ${record.last_error}`, true);
            if (record.step_failures >= STALL_LIMIT && !live(run.name)) {
                record.state = "gave-up";
                record.gave_up_reason = `${record.step_failures} supervisor steps in a row failed; last: ${record.last_error}`;
                say(`${run.name} GAVE UP: ${record.gave_up_reason}`, true);
            }
            rows.push({ record, progress: empty(now) });
        }
    }
    const raisedNow = alerts(spec, rows, now);
    for (const a of raisedNow) if (!raised.has(alertKey(a))) say(`ALERT ${a}`, true);
    raised = new Set(raisedNow.map(alertKey));
    let persisted = true;
    try {
        writeAtomic(
            statusPath,
            `${JSON.stringify(
                {
                    schema: "sim-campaign-status/v1",
                    updated_at: new Date(now).toISOString(),
                    alerts: raisedNow,
                    runs: rows.map(({ record, progress }) => ({
                        ...record,
                        ...progress,
                        eta_at:
                            progress.eta_ms === null || record.state !== "running"
                                ? null
                                : new Date(now + progress.eta_ms).toISOString(),
                    })),
                },
                null,
                2,
            )}\n`,
        );
    } catch (caught) {
        persisted = false;
        say(`ALERT campaign-status.json: ${(caught as Error).message}`, true);
    }
    const open = rows.filter((r) => r.record.state !== "finalized" && r.record.state !== "gave-up");
    if (open.length === 0 && persisted) {
        const bad = rows.filter(
            (r) => r.record.state === "gave-up" || r.record.finalize.some((f) => f.exit !== 0),
        );
        say(
            `campaign done: ${rows.length - bad.length} clean, ${bad.length} need attention`,
            bad.length > 0,
        );
        process.exit(bad.length > 0 ? 1 : 0);
    }
    if (once && !rows.some((r) => r.record.state === "finalizing")) {
        const failed = rows.some(
            (r) => r.record.state === "gave-up" || r.record.finalize.some((f) => f.exit !== 0),
        );
        process.exit(failed ? 1 : 0);
    }
    await Bun.sleep(spec.poll_ms);
}
