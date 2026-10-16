import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureEvents } from "../../tests/run-fixture";
import { FaultInjector, TARGET } from "../proxy/inject";
import { Rng } from "../rng";
import type { FaultEpisode } from "../scenario/faults";
import { SEAMS } from "../scenario/faults";
import { Clock } from "./clock";
import { type Entry, Journal, readJournal, releaseLease, takeLease } from "./journal";
import { type ArmDriver, HarnessFailure, type ScenarioEvent, Scheduler } from "./scheduler";

const ROOT = join(import.meta.dir, "..", "..");
const dir = () => mkdtempSync(join(tmpdir(), "sim-run-"));

function fakeDriver(
    log: string[],
    turnMs = 0,
    onTurn?: (e: ScenarioEvent) => Promise<void> | void,
): ArmDriver {
    return {
        reset: async () => void log.push("reset"),
        event: async (e) => {
            log.push(`${e.kind}:${e.id}`);
            await onTurn?.(e);
            if (turnMs) await Bun.sleep(turnMs);
            return {};
        },
        fault: async (f) => {
            log.push(`fault:${f.id}`);
            return { pid_before: 1, pid_after: 2 };
        },
    };
}

const episode = (
    id: string,
    type: FaultEpisode["type"],
    trigger: FaultEpisode["trigger"],
    strategy: FaultEpisode["strategy"] = "single",
): FaultEpisode => ({
    id,
    type,
    strategy,
    trigger,
    params: {},
    seam: SEAMS[type],
});

function invariants(entries: Entry[]): void {
    const byArm = new Map<string | null, Entry[]>();
    for (const e of entries) byArm.set(e.arm, [...(byArm.get(e.arm) ?? []), e]);
    for (const [arm, list] of byArm) {
        if (arm !== null) expect(list[0]?.scenario_ms).toBe(0);
        for (let i = 1; i < list.length; i++) {
            expect((list[i] as Entry).scenario_ms).toBeGreaterThanOrEqual(
                (list[i - 1] as Entry).scenario_ms,
            );
        }
    }
    const busy = new Set<unknown>();
    for (const e of entries) {
        if (e.kind === "BeginTurn") busy.add(`t${e.arm}${e.event}`);
        if (e.kind === "EndTurn") busy.delete(`t${e.arm}${e.event}`);
        if (e.kind === "RegisterJob") busy.add(`j${e.arm}${e.job}`);
        if (e.kind === "EndJob") busy.delete(`j${e.arm}${e.job}`);
        if (e.kind === "ItemState" && e.state === "failed(interrupted)")
            busy.delete(`t${e.arm}${e.event}`);
        if (e.kind === "AdvanceClock") expect([...busy]).toEqual([]);
    }
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i));
}

describe("Clock", () => {
    test("runs at wall speed while busy, holds while idle, and refuses to jump while busy", () => {
        let wall = 1_000;
        const j = new Journal(join(dir(), "j.jsonl"));
        const clock = new Clock(0, j, () => wall);
        wall += 500;
        expect(clock.now()).toBe(0);
        clock.begin("turn");
        wall += 300;
        expect(clock.now()).toBe(300);
        expect(() => clock.advanceTo(10_000, "a")).toThrow(/advance while busy/);
        clock.begin("job");
        clock.end("turn");
        wall += 200;
        expect(clock.now()).toBe(500);
        clock.end("job");
        wall += 1_000;
        expect(clock.now()).toBe(500);
        clock.begin("turn");
        wall += 300;
        expect(clock.now()).toBe(800);
        wall -= 100;
        expect(clock.now()).toBe(800);
        wall += 150;
        clock.end("turn");
        expect(clock.now()).toBe(850);
        clock.advanceTo(10_000, "a");
        expect(clock.now()).toBe(10_000);
        clock.advanceTo(9_000, "a");
        expect(clock.now()).toBe(10_000);
        expect(j.entries.map((e) => [e.kind, e.scenario_ms, e.from_ms])).toEqual([
            ["AdvanceClock", 10_000, 850],
        ]);
    });
});

describe("Journal and lease", () => {
    test("a cut last line is dropped, and scenario time may not decrease within an arm", () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({ kind: "StartRun", arm: null, scenario_ms: 0 });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 5 });
        expect(() => j.append({ kind: "Event", arm: "a", scenario_ms: 4 })).toThrow(/precedes/);
        j.append({ kind: "StartArm", arm: "b", scenario_ms: 0 });
        j.close();
        writeFileSync(path, `${readFileSync(path, "utf8")}{"seq":3,"kind":"Ev`);
        expect(readJournal(path).map((e) => e.seq)).toEqual([0, 1, 2]);
        const again = new Journal(path);
        again.append({ kind: "EndArm", arm: "b", scenario_ms: 1 });
        expect(readJournal(path).map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    });

    test("one live process holds the lease; a dead holder's lease is taken over", () => {
        const d = dir();
        takeLease(d);
        expect(() => takeLease(d)).toThrow(/is leased by pid/);
        releaseLease(d);
        const dead = Bun.spawnSync(["true"]).pid;
        writeFileSync(
            join(d, "lease.0.json"),
            JSON.stringify({ pid: dead, host: hostname(), started_wall_ms: 0 }),
        );
        expect(takeLease(d).pid).toBe(process.pid);
        releaseLease(d);
        writeFileSync(join(d, "lease.0.json"), "");
        expect(takeLease(d).pid).toBe(process.pid);
        releaseLease(d);
        writeFileSync(
            join(d, "lease.0.json"),
            JSON.stringify({ pid: dead, host: "elsewhere", started_wall_ms: 0 }),
        );
        expect(() => takeLease(d)).toThrow(/on elsewhere/);
    });

    test("a corrupt complete line refuses the journal, wherever it sits", () => {
        const path = join(dir(), "j.jsonl");
        writeFileSync(path, '{"seq":0}\nnot json\n{"seq":2}\n');
        expect(() => new Journal(path)).toThrow(/line 2 is corrupt/);
        writeFileSync(path, '{"seq":0}\nnot json\n');
        expect(() => new Journal(path)).toThrow(/line 2 is corrupt/);
        expect(readFileSync(path, "utf8")).toBe('{"seq":0}\nnot json\n');
    });

    test("racing resumers of a dead lease produce one holder", async () => {
        const contender = `
            import { appendFileSync } from "node:fs";
            import { takeLease } from "./src/run/journal";
            const [dir, out] = process.argv.slice(1);
            try {
                takeLease(dir);
                appendFileSync(out, process.pid + "\\n");
                await Bun.sleep(200);
            } catch (e) {
                appendFileSync(out + ".lost", e.message + "\\n");
            }`;
        for (let round = 0; round < 2; round++) {
            const d = dir();
            const dead = Bun.spawnSync(["true"]).pid;
            writeFileSync(
                join(d, "lease.0.json"),
                JSON.stringify({ pid: dead, host: hostname(), started_wall_ms: 0 }),
            );
            const out = join(d, "winners");
            const kids = Array.from({ length: 8 }, () =>
                Bun.spawn(["bun", "-e", contender, d, out], {
                    cwd: ROOT,
                    stdout: "ignore",
                    stderr: "inherit",
                }),
            );
            await Promise.all(kids.map((k) => k.exited));
            expect(readFileSync(out, "utf8").trim().split("\n")).toHaveLength(1);
            const lost = readFileSync(`${out}.lost`, "utf8").trim().split("\n");
            expect(lost).toHaveLength(7);
            for (const l of lost) expect(l).toMatch(/is leased by pid/);
        }
    }, 30_000);
});

describe("Scheduler", () => {
    test("arms run in order from one event list, each reset first, with every jump landing on the next event", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        const logs: Record<string, string[]> = { host: [], eidnara: [] };
        const events = fixtureEvents(3);
        await new Scheduler({
            events,
            faults: [],
            journal: j,
            settleMs: 0,
            order: ["eidnara", "host"],
            drivers: {
                host: fakeDriver(logs.host as string[]),
                eidnara: fakeDriver(logs.eidnara as string[]),
            },
        }).run();
        invariants(j.entries);
        expect(logs.eidnara?.[0]).toBe("reset");
        expect(logs.host).toEqual(logs.eidnara);
        expect(j.entries.filter((e) => e.kind === "StartArm").map((e) => e.arm)).toEqual([
            "eidnara",
            "host",
        ]);
        for (const a of j.entries.filter((e) => e.kind === "AdvanceClock")) {
            const next = events.find((e) => e.id === a.next_event);
            expect(a.scenario_ms).toBe(next?.scenario_ms ?? -1);
            const later = events.filter((e) => e.scenario_ms > (a.from_ms as number));
            expect(a.scenario_ms).toBe(Math.min(...later.map((e) => e.scenario_ms)));
        }
    });

    test("a background job registered after a turn ends holds the clock until it ends", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        let scheduler: Scheduler | null = null;
        const driver = fakeDriver([], 0, (e) => {
            if (e.kind === "user_turn" && e.index === 0) {
                setTimeout(() => scheduler?.jobStart("fold-1"), 0);
                setTimeout(() => scheduler?.jobEnd("fold-1"), 120);
            }
        });
        scheduler = new Scheduler({
            events: fixtureEvents(2),
            faults: [],
            journal: j,
            order: ["a"],
            drivers: { a: driver },
            jobPollMs: 10,
            settleMs: 30,
        });
        await scheduler.run();
        invariants(j.entries);
        const kinds = j.entries.map((e) => e.kind);
        const reg = kinds.indexOf("RegisterJob");
        const end = kinds.indexOf("EndJob");
        expect(kinds.indexOf("EndTurn")).toBeLessThan(reg);
        expect(kinds.slice(reg, end)).not.toContain("AdvanceClock");
        expect(kinds.slice(reg, end)).not.toContain("BeginTurn");
        const register = j.entries[reg] as Entry;
        const ended = j.entries[end] as Entry;
        expect(ended.scenario_ms - register.scenario_ms).toBeGreaterThanOrEqual(100);
    });

    test("a laptop sleep is one event-free jump across the gap that lands on the session's first event", async () => {
        const events: ScenarioEvent[] = [
            { id: "e-000000", kind: "session_start", scenario_ms: 0, session: "s-0000" },
            { id: "e-000001", kind: "user_turn", scenario_ms: 0, session: "s-0000", index: 0 },
            { id: "e-000002", kind: "session_end", scenario_ms: 0, session: "s-0000" },
            {
                id: "e-100000",
                kind: "apply_diff",
                scenario_ms: 8 * 3_600_000,
                session: "s-0001",
            },
            {
                id: "e-100001",
                kind: "session_start",
                scenario_ms: 8 * 3_600_000,
                session: "s-0001",
            },
            {
                id: "e-100002",
                kind: "user_turn",
                scenario_ms: 8 * 3_600_000 + 5_000,
                session: "s-0001",
                index: 0,
            },
            {
                id: "e-100003",
                kind: "session_end",
                scenario_ms: 8 * 3_600_000 + 5_000,
                session: "s-0001",
            },
        ];
        const sleep = {
            ...episode("f-sleep", "laptop_sleep", { kind: "session_start", session: "s-0001" }),
            params: { duration_ms: 8 * 3_600_000 },
        };
        const j = new Journal(join(dir(), "j.jsonl"));
        await new Scheduler({
            events,
            faults: [sleep],
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([], 20) },
        }).run();
        invariants(j.entries);
        const jumps = j.entries.filter((e) => e.kind === "AdvanceClock");
        expect(jumps.map((e) => [e.fault ?? e.next_event, e.scenario_ms])).toEqual([
            ["f-sleep", 8 * 3_600_000],
            ["e-100002", 8 * 3_600_000 + 5_000],
        ]);
        const at = j.entries.indexOf(jumps[0] as Entry);
        expect(j.entries[at - 1]?.kind).toBe("Event");
        expect(j.entries[at + 1]).toMatchObject({ kind: "FaultFired", fault: "f-sleep" });
        expect((jumps[0] as Entry).from_ms).toBeGreaterThanOrEqual(20);
        expect(j.entries.filter((e) => e.kind === "FaultFired")).toHaveLength(1);
        const started = j.entries.find((e) => e.kind === "Event" && e.event === "e-100001");
        expect(started?.scenario_ms).toBe(8 * 3_600_000);
    });

    test("every proxy fault of a session is disarmed at its end, exhausted or not", async () => {
        const faults = [
            {
                ...episode("p1", "provider_429", { kind: "user_turn", session: "s-0000", n: 3 }),
                params: { count: 3 },
                strategy: "burst" as const,
            },
        ];
        const injector = new FaultInjector(faults, new Rng(1), 1_000);
        const j = new Journal(join(dir(), "j.jsonl"));
        let faulted = 0;
        const scheduler = new Scheduler({
            events: [
                ...fixtureEvents(3),
                ...fixtureEvents(1).map((e) => ({
                    ...e,
                    id: `${e.id}-b`,
                    session: "s-0001",
                    scenario_ms: e.scenario_ms + 7_200_000,
                })),
            ],
            faults,
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: {
                a: fakeDriver([], 0, (e) => {
                    if (e.kind === "user_turn" && e.session === "s-0001") {
                        if (injector.take(TARGET, 1)) faulted++;
                    }
                }),
            },
            proxy: injector,
        });
        await scheduler.run();
        expect(faulted).toBe(0);
    });

    test("proxy faults arm on their user turn and every one disarms at session end", async () => {
        const calls: string[] = [];
        const proxy = {
            arm: (id: string) => void calls.push(`arm ${id}`),
            disarm: (id: string) => void calls.push(`disarm ${id}`),
        };
        const faults = [
            episode("p1", "provider_429", { kind: "user_turn", session: "s-0000", n: 2 }),
            episode(
                "p2",
                "slow_stream",
                { kind: "user_turn", session: "s-0000", n: 3 },
                "persistent",
            ),
        ];
        const log: string[] = [];
        const j = new Journal(join(dir(), "j.jsonl"));
        await new Scheduler({
            events: fixtureEvents(3),
            faults,
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver(log, 0, () => void log.push(calls.join("|"))) },
            proxy,
        }).run();
        expect(calls).toEqual(["arm p1", "arm p2", "disarm p1", "disarm p2"]);
        const turns = log.filter((_, i) => log[i - 1]?.startsWith("user_turn"));
        expect(turns).toEqual(["", "arm p1", "arm p1|arm p2"]);
    });

    test("a daemon death inside the mid-fold kill's outage is expected; outside one it fails the run", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        let scheduler: Scheduler | null = null;
        const kill = episode("k", "daemon_sigkill_mid_fold", {
            kind: "first_summarizer_call",
            session: "s-0000",
        });
        const driver: ArmDriver = {
            reset: async () => undefined,
            event: async (e) => {
                if (e.kind === "user_turn" && e.index === 2)
                    scheduler?.observe("history_summarizer", driver);
                return {};
            },
            fault: async () => {
                await Bun.sleep(20);
                scheduler?.daemonExited({ signal: "SIGKILL" });
                return { restarted_by: "harness" };
            },
        };
        scheduler = new Scheduler({
            events: fixtureEvents(3),
            faults: [kill],
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: { a: driver },
        });
        await scheduler.run();
        const kinds = j.entries.map((e) => [e.kind, e.fault ?? e.expected ?? null]);
        expect(kinds).toContainEqual(["FaultFired", "k"]);
        expect(kinds).toContainEqual(["ItemState", true]);
        const observed = j.entries.findIndex((e) => e.kind === "FaultObserved" && e.fault === "k");
        const turnDone = j.entries.findIndex((e) => e.kind === "Event" && e.event === "e-000003");
        expect(observed).toBeGreaterThan(-1);
        expect(observed).toBeLessThan(turnDone);
        expect(j.entries[observed]?.arm).toBe("a");
        expect(() => scheduler?.daemonExited({ signal: "SIGKILL" })).toThrow(HarnessFailure);
    });

    test("an outage window opened on an arm's final event is closed before the next arm resets", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        let scheduler: Scheduler | null = null;
        const kill = episode("k", "daemon_sigkill_mid_fold", {
            kind: "first_summarizer_call",
            session: "s-0000",
        });
        let resets = 0;
        let secondReset: unknown = null;
        const driver: ArmDriver = {
            reset: async () => {
                resets++;
                if (resets === 2) {
                    try {
                        scheduler?.daemonExited({ signal: "SIGKILL" });
                        secondReset = "accepted";
                    } catch (caught) {
                        secondReset = caught;
                    }
                }
            },
            event: async (e) => {
                if (e.kind === "user_turn") scheduler?.observe("history_summarizer", driver);
                return {};
            },
            fault: async () => ({ restarted_by: "harness" }),
        };
        scheduler = new Scheduler({
            events: fixtureEvents(1).filter((e) => e.kind !== "session_end"),
            faults: [kill],
            journal: j,
            settleMs: 0,
            order: ["a", "b"],
            drivers: { a: driver, b: driver },
        });
        await scheduler.run();
        expect(secondReset).toBeInstanceOf(HarnessFailure);
        const unexpected = j.entries.filter((e) => e.kind === "ItemState" && e.expected === false);
        expect(unexpected.map((e) => e.arm)).toEqual(["b"]);
    });

    test("a failed turn's Event carries the driver's outcome", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        const driver: ArmDriver = {
            ...fakeDriver([]),
            event: async (e) => (e.kind === "user_turn" && e.index === 1 ? { failed: "boom" } : {}),
        };
        await new Scheduler({
            events: fixtureEvents(2),
            faults: [],
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: { a: driver },
        }).run();
        const of = (kind: string) =>
            j.entries.filter((e) => e.kind === kind).map((e) => [e.event, e.outcome]);
        expect(of("Event").filter((x) => x[0] === "e-000002")).toEqual([["e-000002", "boom"]]);
        expect(of("EndTurn")).toEqual([
            ["e-000001", "ok"],
            ["e-000002", "boom"],
        ]);
    });
});

describe("resume", () => {
    const killAt = async (stop: (entries: Entry[], bills: string[]) => boolean, settle = 0) => {
        const d = dir();
        const journalPath = join(d, "journal.jsonl");
        const spawn = () =>
            Bun.spawn(["bun", "tests/run-fixture.ts", d, "300", String(settle)], {
                cwd: ROOT,
                stdout: "ignore",
                stderr: "inherit",
            });
        const first = spawn();
        for (;;) {
            await Bun.sleep(5);
            const entries = existsSync(journalPath) ? readJournal(journalPath) : [];
            const billPath = join(d, "bill.log");
            const bills = existsSync(billPath)
                ? readFileSync(billPath, "utf8").trim().split("\n")
                : [];
            if (stop(entries, bills)) break;
            if (first.exitCode !== null) {
                throw new Error(`fixture exited with ${first.exitCode} before the kill point`);
            }
        }
        first.kill("SIGKILL");
        await first.exited;
        const before = readJournal(journalPath);
        const second = spawn();
        expect(await second.exited).toBe(0);
        const after = readJournal(journalPath);
        invariants(after);
        expect(after.slice(0, before.length)).toEqual(before);
        const bills = readFileSync(join(d, "bill.log"), "utf8").trim().split("\n");
        expect(new Set(bills).size).toBe(bills.length);
        expect(bills).toHaveLength(2 * 6);
        expect(readFileSync(join(d, "resets.log"), "utf8").trim().split("\n")).toEqual([
            "host",
            "eidnara",
        ]);
        for (const arm of ["host", "eidnara"]) {
            const events = after
                .filter((e) => e.arm === arm && e.kind === "Event")
                .map((e) => e.event);
            expect(events).toEqual(fixtureEvents().map((e) => e.id));
        }
        const resumed = after.slice(before.length);
        const last = before.at(-1) as Entry;
        expect(resumed[0]?.scenario_ms).toBe(last.scenario_ms);
        return { before, resumed, last };
    };
    const inFlight = (entries: Entry[], bills: string[]) => {
        const last = entries.at(-1);
        return last?.kind === "BeginTurn" && bills.at(-1) === `${last.arm} ${last.event}`;
    };

    test("a harness killed mid-turn resumes at the same next event with nothing run or billed twice", async () => {
        const { resumed, last } = await killAt(
            (e, b) => e.filter((x) => x.kind === "EndTurn").length >= 3 && inFlight(e, b),
        );
        expect(resumed.slice(0, 2).map((e) => [e.kind, e.event, e.state ?? e.outcome])).toEqual([
            ["ItemState", last.event, "failed(interrupted)"],
            ["Event", last.event, "failed(interrupted)"],
        ]);
        const events = fixtureEvents();
        const next = events[events.findIndex((e) => e.id === last.event) + 1]?.id;
        expect(resumed.find((e) => e.kind === "BeginTurn")?.event).toBe(next ?? "");
    }, 60_000);

    test("a harness killed after a turn's answer records the turn once and moves on", async () => {
        const { resumed, last } = await killAt(
            (e) =>
                e.at(-1)?.kind === "EndTurn" && e.filter((x) => x.kind === "EndTurn").length >= 2,
            400,
        );
        expect(resumed[0]).toMatchObject({ kind: "Event", event: last.event, outcome: "ok" });
    }, 60_000);

    test("a harness killed in the second arm leaves the finished arm alone", async () => {
        const { resumed } = await killAt(
            (e, b) => e.some((x) => x.kind === "EndArm" && x.arm === "host") && inFlight(e, b),
        );
        expect(resumed.filter((e) => e.arm === "host")).toEqual([]);
    }, 60_000);
});

describe("resume of fired faults", () => {
    test("a persistent proxy fault fired before the kill is armed again, a one-shot one only if its turn has not begun; a scheduler fault without evidence is interrupted", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({ kind: "StartRun", arm: null, scenario_ms: 0 });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000" });
        j.append({ kind: "FaultFired", arm: "a", scenario_ms: 0, fault: "slow" });
        j.append({ kind: "FaultFired", arm: "a", scenario_ms: 0, fault: "restart" });
        j.append({ kind: "FaultFired", arm: "a", scenario_ms: 0, fault: "later" });
        j.append({ kind: "FaultFired", arm: "a", scenario_ms: 0, fault: "begun" });
        j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: "e-000001" });
        j.close();
        const calls: string[] = [];
        const proxy = {
            arm: (id: string) => void calls.push(`arm ${id}`),
            disarm: (id: string) => void calls.push(`disarm ${id}`),
        };
        const faults = [
            episode(
                "slow",
                "slow_stream",
                { kind: "user_turn", session: "s-0000", n: 1 },
                "persistent",
            ),
            episode("restart", "daemon_restart", { kind: "session_start", session: "s-0000" }),
            episode("later", "provider_429", { kind: "user_turn", session: "s-0000", n: 2 }),
            episode("begun", "provider_5xx", { kind: "user_turn", session: "s-0000", n: 1 }),
        ];
        const resumed = new Journal(path);
        await new Scheduler({
            events: fixtureEvents(2),
            faults,
            journal: resumed,
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
            proxy,
        }).run();
        expect(calls).toEqual([
            "arm slow",
            "arm later",
            "disarm slow",
            "disarm later",
            "disarm begun",
        ]);
        expect(resumed.entries).toContainEqual(
            expect.objectContaining({
                kind: "ItemState",
                fault: "restart",
                state: "failed(interrupted)",
            }),
        );
        expect(resumed.entries.filter((e) => e.kind === "FaultFired")).toHaveLength(4);
    });

    test("a background job in flight at the kill is closed on resume before the clock moves", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({ kind: "StartRun", arm: null, scenario_ms: 0 });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000" });
        j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: "e-000001" });
        j.append({ kind: "EndTurn", arm: "a", scenario_ms: 40, event: "e-000001", outcome: "ok" });
        j.append({ kind: "RegisterJob", arm: "a", scenario_ms: 40, job: "fold-1" });
        j.close();
        const resumed = new Journal(path);
        await new Scheduler({
            events: fixtureEvents(2),
            faults: [],
            journal: resumed,
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
        invariants(resumed.entries);
        const closed = resumed.entries.find((e) => e.kind === "EndJob" && e.job === "fold-1");
        expect(closed).toMatchObject({ scenario_ms: 40, outcome: "failed(interrupted)" });
        const kinds = resumed.entries.map((e) => e.kind);
        expect(kinds.indexOf("EndJob")).toBeLessThan(kinds.indexOf("AdvanceClock"));
    });
});
