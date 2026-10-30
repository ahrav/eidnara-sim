import {
    appendFileSync,
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { writeAtomic } from "../src/run/atomic";
import {
    alerts,
    type CampaignSpec,
    decide,
    finalizeArgv,
    lastError,
    launchArgv,
    parseCampaign,
    type RunProgress,
    type RunRecord,
    runDir,
    runProgress,
} from "../src/run/campaign";
import { leaseHeld } from "../src/run/journal";

const USAGE = "usage: bun scripts/campaign.ts <campaign.json> [--once]";
const ROOT = resolve(import.meta.dir, "..");

const args = process.argv.slice(2);
const once = args.includes("--once");
const files = args.filter((a) => a !== "--once");
if (files.length !== 1 || args.some((a) => a.startsWith("--") && a !== "--once")) {
    console.error(USAGE);
    process.exit(2);
}
const spec: CampaignSpec = parseCampaign(JSON.parse(readFileSync(files[0] as string, "utf8")));
const logs = join(spec.out, "logs");
mkdirSync(logs, { recursive: true });
const statusPath = join(spec.out, "campaign-status.json");
const campaignLog = join(spec.out, "campaign.log");

const say = (line: string, loud = false) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    appendFileSync(campaignLog, `${stamped}\n`);
    if (loud) {
        const bar = "!".repeat(Math.min(100, stamped.length));
        console.error(`${bar}\n${stamped}\n${bar}`);
    } else console.log(stamped);
};

const fresh = (name: string): RunRecord => ({
    name,
    state: "pending",
    launches: 0,
    stalled: 0,
    progress_at_launch: null,
    last_error: null,
    finalize: [],
    gave_up_reason: null,
});
const saved = existsSync(statusPath)
    ? (JSON.parse(readFileSync(statusPath, "utf8")).runs as RunRecord[])
    : [];
const records = new Map(
    spec.runs.map((r) => {
        const old = saved.find((s) => s.name === r.name);
        return [r.name, old ? { ...fresh(r.name), ...pick(old) } : fresh(r.name)];
    }),
);
function pick(r: RunRecord): RunRecord {
    const {
        name,
        state,
        launches,
        stalled,
        progress_at_launch,
        last_error,
        finalize,
        gave_up_reason,
    } = r;
    return {
        name,
        state,
        launches,
        stalled,
        progress_at_launch,
        last_error,
        finalize,
        gave_up_reason,
    };
}
const children = new Map<string, ReturnType<typeof Bun.spawn>>();
const argv = (command: string[]) =>
    command[0] === "bun" ? [process.execPath, ...command.slice(1)] : command;
const logOf = (name: string) => join(logs, `${name}.log`);

function launch(run: CampaignSpec["runs"][number], record: RunRecord, progress: RunProgress) {
    const log = logOf(run.name);
    if (existsSync(log)) renameSync(log, join(logs, `${run.name}.attempt${record.launches}.log`));
    const fd = openSync(log, "a");
    const command = argv(launchArgv(spec, run));
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
    } finally {
        closeSync(fd);
    }
    record.launches++;
    record.progress_at_launch = progress.lifecycle_entries;
    record.state = "running";
    const what = progress.started ? `resume ${record.launches - 1}` : "launch";
    say(`${run.name} ${what}: ${command.join(" ")}`);
}

function finalize(name: string, record: RunRecord) {
    record.finalize = [];
    for (const command of finalizeArgv(spec, name)) {
        const tool = basename(command[1] ?? command[0] ?? "step").replace(/\.ts$/, "");
        const fd = openSync(join(logs, `${name}.${tool}.log`), "w");
        try {
            const r = Bun.spawnSync(argv(command), {
                cwd: ROOT,
                env: process.env,
                stdout: fd,
                stderr: fd,
            });
            record.finalize.push({ command: tool, exit: r.exitCode });
        } finally {
            closeSync(fd);
        }
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

let raised = new Set<string>();
for (;;) {
    const now = Date.now();
    const rows: { record: RunRecord; progress: RunProgress }[] = [];
    for (const run of spec.runs) {
        const record = records.get(run.name) as RunRecord;
        const dir = runDir(spec, run.name);
        let progress: RunProgress;
        try {
            progress = runProgress(dir, now);
        } catch (caught) {
            record.last_error = `journal unreadable: ${(caught as Error).message}`;
            progress = runProgress("/nonexistent", now);
        }
        const running = live(run.name) || (existsSync(dir) && leaseHeld(dir));
        if (record.state === "running" && !running) {
            const log = existsSync(logOf(run.name)) ? readFileSync(logOf(run.name), "utf8") : "";
            record.last_error = lastError(log) ?? record.last_error;
            record.stalled =
                progress.lifecycle_entries === record.progress_at_launch ? record.stalled + 1 : 0;
            record.state = "pending";
            if (!progress.ended)
                say(`${run.name} stopped: ${record.last_error ?? "no error line"}`);
        }
        switch (decide(record, progress, running, spec.max_resumes)) {
            case "launch":
                launch(run, record, progress);
                break;
            case "finalize":
                finalize(run.name, record);
                break;
            case "give-up":
                record.state = "gave-up";
                record.gave_up_reason =
                    record.stalled >= 2
                        ? `two attempts in a row made no progress; last error: ${record.last_error}`
                        : `stopped after ${record.launches - 1} resumes; last error: ${record.last_error}`;
                say(`${run.name} GAVE UP: ${record.gave_up_reason}`, true);
                break;
            default:
                if (running) record.state = "running";
        }
        rows.push({ record, progress });
    }
    const raisedNow = alerts(spec, rows, now);
    for (const a of raisedNow) if (!raised.has(a)) say(`ALERT ${a}`, true);
    raised = new Set(raisedNow);
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
    const open = rows.filter((r) => r.record.state === "pending" || r.record.state === "running");
    if (open.length === 0) {
        const bad = rows.filter(
            (r) => r.record.state === "gave-up" || r.record.finalize.some((f) => f.exit !== 0),
        );
        say(
            `campaign done: ${rows.length - bad.length} clean, ${bad.length} need attention`,
            bad.length > 0,
        );
        process.exit(bad.length > 0 ? 1 : 0);
    }
    if (once) process.exit(0);
    await Bun.sleep(spec.poll_ms);
}
