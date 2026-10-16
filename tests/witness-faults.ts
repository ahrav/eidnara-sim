import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config/config";
import { checkJournal, type Schedule } from "../src/run/journal-check";
import { pinnedBin } from "../src/run/run";
import type { Scenario } from "../src/scenario/compile";
import { type FaultEpisode, type FaultType, SEAMS, type Trigger } from "../src/scenario/faults";
import { loadPrereg } from "../src/scenario/inputs";

const ROOT = resolve(import.meta.dir, "..");
const out = resolve(process.argv[2] ?? "runs/witness-faults");
const only = process.argv.includes("--summarize")
    ? []
    : (process.argv[3]?.split(",") ?? ["scheduled", "rogue", "resume"]);
const config = loadConfig();
const env = { ...process.env, PATH: `${pinnedBin(config)}:${process.env.PATH ?? ""}` };

const fault = (
    id: string,
    type: FaultType,
    trigger: Trigger,
    params: Record<string, number> = {},
): FaultEpisode => ({
    id,
    type,
    strategy: type === "store_full" ? "persistent" : "single",
    trigger,
    params,
    seam: SEAMS[type],
});
const start = (session: string): Trigger => ({ kind: "session_start", session });
const fold = (session: string): Trigger => ({ kind: "first_summarizer_call", session });
const FAULTS = [
    fault("w-sleep", "laptop_sleep", start("s-0003"), { duration_ms: 120_000 }),
    fault("w-restart", "daemon_restart", start("s-0002")),
    fault("w-reload", "plugin_reload", start("s-0003")),
    fault("w-model", "model_switch", start("s-0004")),
    fault("w-full", "store_full", start("s-0004"), { sessions: 1 }),
    ...["s-0000", "s-0001", "s-0003", "s-0004", "s-0005"].map((s) =>
        fault(`w-kill-${s}`, "daemon_sigkill_mid_fold", fold(s)),
    ),
];

/**
 * JSONL rows. While a run is live, only an unterminated final fragment is tolerated; a final
 * artifact (`strict`) must parse on every complete line, so a corrupt row fails the witness.
 */
function lines(path: string, strict = false): Record<string, unknown>[] {
    if (!existsSync(path)) return [];
    const text = readFileSync(path, "utf8");
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    const rows = complete.split("\n").filter((l) => l !== "");
    return rows.flatMap((l, i) => {
        try {
            return [JSON.parse(l) as Record<string, unknown>];
        } catch {
            if (strict) throw new Error(`${path} line ${i + 1} is corrupt`);
            return [];
        }
    });
}

const RESUME_FAULTS = [
    fault("r-model", "model_switch", start("s-0002")),
    fault("r-full", "store_full", start("s-0003"), { sessions: 1 }),
];
const FAULT_SETS: Record<string, FaultEpisode[]> = {
    scheduled: FAULTS,
    rogue: [],
    resume: RESUME_FAULTS,
};

function launch(dir: string, args: string[]) {
    mkdirSync(out, { recursive: true });
    const faults = `${dir}.faults.json`;
    writeFileSync(faults, JSON.stringify(FAULT_SETS[dir.split("/").at(-1) ?? ""] ?? []));
    const argv = ["bun", "scripts/run-tier.ts", "--tier", "S", "--seed", "101", "--out", dir];
    argv.push("--faults", faults, "--context-limit", "24000", ...args);
    return Bun.spawn(argv, { cwd: ROOT, env, stdout: "inherit", stderr: "pipe" });
}

const WAIT_MS = 20 * 60_000;

/** Polls `test` until it holds; a child exit or the deadline ends the wait with a failure. */
async function waitFor(child: ReturnType<typeof launch>, test: () => boolean): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    let exited = false;
    void child.exited.then(() => {
        exited = true;
    });
    while (!test()) {
        if (exited) {
            const { code, stderr } = await finished(child);
            throw new Error(`run exited with ${code} before the awaited state:\n${stderr}`);
        }
        if (Date.now() > deadline) {
            child.kill("SIGKILL");
            throw new Error(`run reached no awaited state within ${WAIT_MS} ms`);
        }
        await Bun.sleep(200);
    }
}
const begun = (dir: string, event: string) => () =>
    lines(join(dir, "journal.jsonl")).some((e) => e.kind === "BeginTurn" && e.event === event);
const called = (dir: string, turn: string) => () =>
    lines(join(dir, "calls.jsonl")).some((c) => c.turn === turn);
const callsByTurn = (dir: string) =>
    lines(join(dir, "calls.jsonl")).reduce<Record<string, number>>((acc, c) => {
        acc[String(c.turn)] = (acc[String(c.turn)] ?? 0) + 1;
        return acc;
    }, {});

/** A run gets the S wall budget plus the signal grace and teardown; past that it is killed. */
const RUN_LIMIT_MS = loadPrereg("S").liveness_bounds.tier_wall_budget_ms + 5 * 60_000;

async function finished(child: ReturnType<typeof launch>) {
    const limit = { hit: false };
    const timer = setTimeout(() => {
        limit.hit = true;
        child.kill("SIGKILL");
    }, RUN_LIMIT_MS);
    const code = await child.exited;
    clearTimeout(timer);
    const stderr = (await new Response(child.stderr).text()).slice(-2000);
    return { code, stderr, timed_out: limit.hit };
}

const dirs = {
    scheduled: join(out, "scheduled"),
    rogue: join(out, "rogue"),
    resume: join(out, "resume"),
};
const outcome: Record<string, unknown> = existsSync(join(out, "outcome.json"))
    ? JSON.parse(readFileSync(join(out, "outcome.json"), "utf8"))
    : {};
for (const name of only) rmSync(dirs[name as keyof typeof dirs], { recursive: true, force: true });

const models = `${config.agent_model},us.anthropic.claude-haiku-4-5-20251001-v1:0`;
if (only.includes("scheduled")) {
    const child = launch(dirs.scheduled, [
        "--arms",
        "host,eidnara",
        "--events",
        "23",
        "--models",
        models,
    ]);
    outcome.scheduled = await finished(child);
}
if (only.includes("rogue")) {
    const child = launch(dirs.rogue, ["--arms", "eidnara", "--events", "6"]);
    await waitFor(child, begun(dirs.rogue, "e-000004"));
    const state = JSON.parse(readFileSync(join(dirs.rogue, "eidnara/state.json"), "utf8"));
    const pid: unknown = state?.daemon?.pid;
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 1) {
        try {
            process.kill(pid, "SIGKILL");
        } catch (caught) {
            outcome.rogue_kill_error = String(caught);
        }
    } else {
        outcome.rogue_kill_error = `state.json names no daemon pid: ${JSON.stringify(pid)}`;
    }
    outcome.rogue = await finished(child);
}
if (only.includes("resume")) {
    const args = ["--arms", "eidnara", "--events", "13", "--models", models];
    const first = launch(dirs.resume, args);
    await waitFor(first, called(dirs.resume, "e-000007"));
    first.kill("SIGKILL");
    const killed = await finished(first);
    const journal = lines(join(dirs.resume, "journal.jsonl"));
    const has = (kind: string) => journal.some((e) => e.kind === kind && e.event === "e-000007");
    const mid_turn = has("BeginTurn") && !has("EndTurn");
    const before = callsByTurn(dirs.resume);
    const second = await finished(launch(dirs.resume, args));
    const after = callsByTurn(dirs.resume);
    const rebilled = Object.keys(before).filter((t) => t !== "null" && after[t] !== before[t]);
    outcome.resume = {
        killed,
        mid_turn,
        second,
        calls_before: before,
        calls_after: after,
        rebilled,
    };
}
writeFileSync(join(out, "outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`);

/** The run's event prefix (`manifest.events`) with each event's scheduled time. */
function schedule(dir: string): Schedule {
    const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as {
        events: number;
    };
    const events = scenario.events.slice(0, manifest.events);
    return { events: new Map(events.map((e) => [String(e.id), Number(e.scenario_ms)])) };
}

function summarize(dir: string) {
    const journal = lines(join(dir, "journal.jsonl"), true);
    const calls = lines(join(dir, "calls.jsonl"), true);
    const perArm = (arm: string, kind: string) =>
        journal.filter((e) => e.arm === arm && e.kind === kind);
    const arms = [
        ...new Set(journal.map((e) => e.arm).filter((a) => typeof a === "string")),
    ] as string[];
    return {
        ended: journal.at(-1)?.kind,
        arms: Object.fromEntries(
            arms.map((arm) => [
                arm,
                {
                    fired: perArm(arm, "FaultFired").map((e) => e.fault),
                    observed: perArm(arm, "FaultObserved").map((e) => ({
                        fault: e.fault,
                        evidence: e.evidence,
                    })),
                    turns: perArm(arm, "EndTurn").map((e) => `${e.event}:${e.outcome}`),
                    interrupted: perArm(arm, "ItemState").filter(
                        (e) => e.state === "failed(interrupted)",
                    ),
                    interrupted_events: perArm(arm, "Event")
                        .filter((e) => e.outcome === "failed(interrupted)")
                        .map((e) => e.event),
                    daemon_exits: perArm(arm, "ItemState").filter(
                        (e) => e.daemon_exit !== undefined,
                    ),
                    duplicate_events:
                        perArm(arm, "Event").length -
                        new Set(perArm(arm, "Event").map((e) => e.event)).size,
                    models: [
                        ...new Set(
                            calls
                                .filter((c) => c.arm === arm && c.component === "agent")
                                .map((c) => c.model),
                        ),
                    ],
                },
            ]),
        ),
        call_seq_unique: calls.every((c, i) => c.seq === i),
        agent_calls_by_turn: calls.reduce<Record<string, number>>((acc, c) => {
            if (c.component === "agent")
                acc[`${c.arm}/${c.turn}`] = (acc[`${c.arm}/${c.turn}`] ?? 0) + 1;
            return acc;
        }, {}),
        invariants: checkJournal(journal as never, schedule(dir)),
        full_store_enospc_log_lines: existsSync(join(dir, "eidnara/r/eidnara.log"))
            ? readFileSync(join(dir, "eidnara/r/eidnara.log"), "utf8")
                  .split("\n")
                  .filter((l) => l.includes("disk is full")).length
            : 0,
    };
}

const summary = {
    outcome,
    scheduled: existsSync(dirs.scheduled) ? summarize(dirs.scheduled) : null,
    rogue: existsSync(dirs.rogue) ? summarize(dirs.rogue) : null,
    resume: existsSync(dirs.resume) ? summarize(dirs.resume) : null,
};
writeFileSync(join(out, "witness.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

type Run = { code: number } | undefined;
const failures: string[] = [];
const check = (held: boolean, what: string) => {
    if (!held) failures.push(what);
};
const run = (name: string) => outcome[name] as Run;
const invariantsClean = (name: "scheduled" | "rogue" | "resume") => {
    const s = summary[name];
    if (!s) return false;
    const v = s.invariants;
    const violations = [
        v.decreasing_scenario_ms,
        v.advance_while_busy,
        v.off_schedule_jumps,
        v.events_inside_sleep,
        v.repeated_sleeps,
        v.missing_events,
        v.out_of_order_events,
    ];
    return s.ended === "EndRun" && s.call_seq_unique && violations.every((x) => x.length === 0);
};
for (const name of ["scheduled", "rogue"]) {
    const r = outcome[name] as { timed_out?: boolean } | undefined;
    if (r) check(!r.timed_out, `${name}: finished within the run limit`);
}
type ArmSummary = {
    fired: unknown[];
    observed: { fault: unknown }[];
    models: unknown[];
    duplicate_events: number;
};
/** Each listed arm fired every expected fault, observed those with a mechanism, and saw both models. */
const armEvidence = (
    name: "scheduled" | "resume",
    arms: string[],
    expected: FaultEpisode[],
    bothModels: boolean,
) => {
    const s = summary[name];
    if (!s) return check(false, `${name}: no summary`);
    const observable = expected.filter((f) => f.type !== "laptop_sleep").map((f) => f.id);
    for (const arm of arms) {
        const a = s.arms[arm] as ArmSummary | undefined;
        if (!a) {
            check(false, `${name}: arm ${arm} has no journal entries`);
            continue;
        }
        const fired = new Set(a.fired);
        const observed = new Set(a.observed.map((x) => x.fault));
        check(
            expected.every((f) => fired.has(f.id)),
            `${name}/${arm}: fired ${expected.map((f) => f.id).join(", ")}`,
        );
        check(
            observable.every((id) => observed.has(id)),
            `${name}/${arm}: observed ${observable.join(", ")}`,
        );
        if (bothModels) {
            check(
                models.split(",").every((m) => a.models.includes(m)),
                `${name}/${arm}: agent calls used both configured models`,
            );
        }
        check(a.duplicate_events === 0, `${name}/${arm}: no duplicate Event entry`);
    }
};
const deterministic = FAULTS.filter((f) => f.trigger.kind !== "first_summarizer_call");
if (run("scheduled")) {
    check(run("scheduled")?.code === 0, "scheduled: exit 0");
    check(invariantsClean("scheduled"), "scheduled: EndRun, unique seq, clean invariants");
    armEvidence("scheduled", ["host", "eidnara"], deterministic, true);
}
if (summary.rogue) {
    const rogueArm = summary.rogue.arms.eidnara as ArmSummary | undefined;
    check(rogueArm?.duplicate_events === 0, "rogue/eidnara: no duplicate Event entry");
}
if (run("rogue")) {
    const rogue = outcome.rogue as { code: number; stderr: string };
    check(rogue.code !== 0, "rogue: nonzero exit");
    check(rogue.stderr.includes("outside a scheduled outage window"), "rogue: daemon exit refused");
}
if (outcome.resume) {
    const resume = outcome.resume as { killed: Run; mid_turn: boolean; second: Run; rebilled: [] };
    check(resume.killed?.code === 137, "resume: first run killed with 137");
    check(resume.mid_turn, "resume: kill landed with e-000007 open");
    check(resume.second?.code === 0, "resume: second run exit 0");
    check(
        !(resume.second as { timed_out?: boolean } | undefined)?.timed_out,
        "resume: second run within the run limit",
    );
    check(resume.rebilled.length === 0, "resume: no turn rebilled");
    check(invariantsClean("resume"), "resume: EndRun, unique seq, clean invariants");
    armEvidence("resume", ["eidnara"], RESUME_FAULTS, true);
    const arm = summary.resume?.arms.eidnara as
        | { interrupted: { event?: unknown }[]; interrupted_events: unknown[] }
        | undefined;
    check(
        arm?.interrupted.map((e) => e.event).join() === "e-000007",
        "resume/eidnara: exactly one ItemState failed(interrupted), for e-000007",
    );
    check(
        arm?.interrupted_events.join() === "e-000007",
        "resume/eidnara: exactly one Event failed(interrupted), for e-000007",
    );
}
if (failures.length > 0) {
    console.error(`witness failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
}
