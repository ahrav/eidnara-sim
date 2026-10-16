import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config/config";
import { checkJournal, type Schedule } from "../src/run/journal-check";
import { pinnedBin } from "../src/run/run";
import type { Scenario } from "../src/scenario/compile";
import { type FaultEpisode, type FaultType, SEAMS, type Trigger } from "../src/scenario/faults";

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

function lines(path: string): Record<string, unknown>[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
        .split("\n")
        .flatMap((l) => {
            try {
                return [JSON.parse(l) as Record<string, unknown>];
            } catch {
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
    const faults = `${dir}.faults.json`;
    writeFileSync(faults, JSON.stringify(FAULT_SETS[dir.split("/").at(-1) ?? ""] ?? []));
    const argv = ["bun", "scripts/run-tier.ts", "--tier", "S", "--seed", "101", "--out", dir];
    argv.push("--faults", faults, "--context-limit", "24000", ...args);
    return Bun.spawn(argv, { cwd: ROOT, env, stdout: "inherit", stderr: "pipe" });
}

async function waitFor(test: () => boolean): Promise<void> {
    while (!test()) await Bun.sleep(500);
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

async function finished(child: ReturnType<typeof launch>) {
    const code = await child.exited;
    return { code, stderr: (await new Response(child.stderr).text()).slice(-2000) };
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
    await waitFor(begun(dirs.rogue, "e-000004"));
    const state = JSON.parse(readFileSync(join(dirs.rogue, "eidnara/state.json"), "utf8"));
    try {
        process.kill(state.daemon.pid, "SIGKILL");
    } catch (caught) {
        outcome.rogue_kill_error = String(caught);
    }
    outcome.rogue = await finished(child);
}
if (only.includes("resume")) {
    const args = ["--arms", "eidnara", "--events", "13", "--models", models];
    const first = launch(dirs.resume, args);
    await waitFor(called(dirs.resume, "e-000007"));
    first.kill("SIGKILL");
    const killed = await finished(first);
    const before = callsByTurn(dirs.resume);
    const second = await finished(launch(dirs.resume, args));
    const after = callsByTurn(dirs.resume);
    const rebilled = Object.keys(before).filter((t) => t !== "null" && after[t] !== before[t]);
    outcome.resume = { killed, second, calls_before: before, calls_after: after, rebilled };
}
writeFileSync(join(out, "outcome.json"), `${JSON.stringify(outcome, null, 2)}\n`);

function schedule(dir: string): Schedule {
    const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
    const events = new Map(scenario.events.map((e) => [String(e.id), Number(e.scenario_ms)]));
    const sleeps = new Map(FAULTS.map((f) => [f.id, Number(f.params.duration_ms)]));
    return { events, sleeps };
}

function summarize(dir: string) {
    const journal = lines(join(dir, "journal.jsonl"));
    const calls = lines(join(dir, "calls.jsonl"));
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
        call_seq_unique: new Set(calls.map((c) => c.seq)).size === calls.length,
        agent_calls_by_turn: calls.reduce<Record<string, number>>((acc, c) => {
            if (c.component === "agent")
                acc[`${c.arm}/${c.turn}`] = (acc[`${c.arm}/${c.turn}`] ?? 0) + 1;
            return acc;
        }, {}),
        invariants: checkJournal(journal as never, schedule(dir)),
        fail_open_on_full_store: existsSync(join(dir, "eidnara/r/eidnara.log"))
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
