import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureEvents } from "../../tests/run-fixture";
import type { FaultEpisode } from "../scenario/faults";
import { SEAMS } from "../scenario/faults";
import { Clock } from "./clock";
import {
    type Entry,
    Journal,
    keepCompleteLines,
    readJournal,
    releaseLease,
    takeLease,
} from "./journal";
import { CallIndex, callsOf } from "./run";
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
    for (const list of byArm.values()) {
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
        if (e.kind === "RegisterJob") busy.add(`j${e.job}`);
        if (e.kind === "EndJob") busy.delete(`j${e.job}`);
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
        clock.advanceTo(10_000, "a");
        expect(clock.now()).toBe(10_000);
        clock.advanceTo(9_000, "a");
        expect(clock.now()).toBe(10_000);
        expect(j.entries.map((e) => [e.kind, e.scenario_ms, e.from_ms])).toEqual([
            ["AdvanceClock", 10_000, 500],
        ]);
    });
});

describe("Journal and lease", () => {
    test("keepCompleteLines drops a cut last line and leaves whole lines", () => {
        const path = join(dir(), "log.jsonl");
        expect(keepCompleteLines(path)).toBe(0);
        writeFileSync(path, '{"a":1}\n{"b":2}\n{"c":');
        expect(keepCompleteLines(path)).toBe(16);
        expect(readFileSync(path, "utf8")).toBe('{"a":1}\n{"b":2}\n');
        const whole = `{"big":"${"x".repeat(3 << 20)}"}\n`;
        writeFileSync(path, `${whole}{"cut":"${"y".repeat(2 << 20)}`);
        expect(keepCompleteLines(path)).toBe(Buffer.byteLength(whole));
        expect(readFileSync(path, "utf8")).toBe(whole);
        writeFileSync(path, "no newline at all");
        expect(keepCompleteLines(path)).toBe(0);
        expect(readFileSync(path, "utf8")).toBe("");
    });

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
            join(d, "lease.json"),
            JSON.stringify({ pid: dead, host: require("node:os").hostname(), started_wall_ms: 0 }),
        );
        expect(takeLease(d).pid).toBe(process.pid);
        releaseLease(d);
        writeFileSync(join(d, "lease.json"), "");
        expect(takeLease(d).pid).toBe(process.pid);
        releaseLease(d);
        writeFileSync(
            join(d, "lease.json"),
            JSON.stringify({ pid: dead, host: "elsewhere", started_wall_ms: 0 }),
        );
        expect(() => takeLease(d)).toThrow(/on elsewhere/);
    });

    test("a corrupt line before the last refuses the journal", () => {
        const path = join(dir(), "j.jsonl");
        writeFileSync(path, '{"seq":0}\nnot json\n{"seq":2}\n');
        expect(() => new Journal(path)).toThrow(/line 2 is corrupt/);
    });
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

    test("a laptop sleep is one event-free jump of its duration", async () => {
        const events: ScenarioEvent[] = [
            ...fixtureEvents(1),
            {
                id: "e-100000",
                kind: "session_start",
                scenario_ms: 8 * 3_600_000,
                session: "s-0001",
            },
            {
                id: "e-100001",
                kind: "user_turn",
                scenario_ms: 8 * 3_600_000,
                session: "s-0001",
                index: 0,
            },
            {
                id: "e-100002",
                kind: "session_end",
                scenario_ms: 8 * 3_600_000 + 1,
                session: "s-0001",
            },
        ];
        const sleep = {
            ...episode("f-sleep", "laptop_sleep", { kind: "session_start", session: "s-0001" }),
            params: { duration_ms: 8 * 3_600_000 - 60_000 },
        };
        const j = new Journal(join(dir(), "j.jsonl"));
        await new Scheduler({
            events,
            faults: [sleep],
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
        const jumps = j.entries.filter((e) => e.kind === "AdvanceClock" && e.fault === "f-sleep");
        expect(jumps).toHaveLength(1);
        const at = j.entries.indexOf(jumps[0] as Entry);
        expect(j.entries[at + 1]?.kind).toBe("FaultFired");
        expect(j.entries[at - 1]?.kind).toBe("Event");
        const jump = jumps[0] as Entry;
        expect(jump.scenario_ms - (jump.from_ms as number)).toBe(8 * 3_600_000 - 60_000);
        expect(jump.scenario_ms).toBeGreaterThanOrEqual(8 * 3_600_000);
        const observed = j.entries.find((e) => e.kind === "FaultObserved" && e.fault === "f-sleep");
        expect(observed?.evidence).toEqual({ clock_advanced_ms: 8 * 3_600_000 - 60_000 });
    });

    test("proxy faults arm on their user turn and persistent ones disarm at session end", async () => {
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
        expect(calls).toEqual(["arm p1", "arm p2", "disarm p2"]);
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
                if (e.kind === "user_turn" && e.index === 1)
                    scheduler?.observe("history_summarizer", driver);
                return {};
            },
            fault: async () => {
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
        expect(kinds).toContainEqual(["FaultObserved", "k"]);
        expect(() => scheduler?.daemonExited({ signal: "SIGKILL" })).toThrow(HarnessFailure);
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
    test("a persistent proxy fault fired before the kill is armed again; a scheduler fault without evidence is interrupted", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({ kind: "StartRun", arm: null, scenario_ms: 0 });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000" });
        j.append({ kind: "FaultFired", arm: "a", scenario_ms: 0, fault: "slow" });
        j.append({ kind: "FaultFired", arm: "a", scenario_ms: 0, fault: "restart" });
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
        expect(calls).toEqual(["arm slow", "disarm slow"]);
        expect(resumed.entries).toContainEqual(
            expect.objectContaining({
                kind: "ItemState",
                fault: "restart",
                state: "failed(interrupted)",
            }),
        );
        expect(resumed.entries.filter((e) => e.kind === "FaultFired")).toHaveLength(2);
    });
});

describe("resume of a journaled sleep jump", () => {
    test("a sleep whose jump is journaled but whose firing is not resumes as fired, once", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        const duration = 3_600_000;
        j.append({ kind: "StartRun", arm: null, scenario_ms: 0 });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({
            kind: "AdvanceClock",
            arm: "a",
            scenario_ms: duration,
            from_ms: 0,
            busy: [],
            fault: "f-sleep",
        });
        j.close();
        const sleep = {
            ...episode("f-sleep", "laptop_sleep", { kind: "session_start", session: "s-0000" }),
            params: { duration_ms: duration },
        };
        const resumed = new Journal(path);
        await new Scheduler({
            events: fixtureEvents(1),
            faults: [sleep],
            journal: resumed,
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
        const jumps = resumed.entries.filter(
            (e) => e.kind === "AdvanceClock" && e.fault === "f-sleep",
        );
        expect(jumps).toHaveLength(1);
        const fired = resumed.entries.filter(
            (e) => e.kind === "FaultFired" && e.fault === "f-sleep",
        );
        const observed = resumed.entries.filter(
            (e) => e.kind === "FaultObserved" && e.fault === "f-sleep",
        );
        expect([fired.length, observed.length]).toEqual([1, 1]);
        expect(observed[0]?.evidence).toEqual({ clock_advanced_ms: duration });
        const last = resumed.entries.at(-1) as Entry;
        expect(last.scenario_ms).toBeLessThan(2 * duration);
    });
});

describe("fault schedule validity", () => {
    test("duplicate fault ids and non-positive sleep durations are refused before the run starts", () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        const base = {
            events: fixtureEvents(1),
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        };
        const twice = episode("dup", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        expect(() => new Scheduler({ ...base, faults: [twice, { ...twice }] })).toThrow(
            "fault id dup is scheduled twice",
        );
        const still = {
            ...episode("f-sleep", "laptop_sleep", { kind: "session_start", session: "s-0000" }),
            params: { duration_ms: 0 },
        };
        expect(() => new Scheduler({ ...base, faults: [still] })).toThrow(
            "laptop_sleep f-sleep needs a positive duration_ms",
        );
        const text = { ...still, params: { duration_ms: "1000" as unknown as number } };
        expect(() => new Scheduler({ ...base, faults: [text] })).toThrow(
            "laptop_sleep f-sleep needs a positive duration_ms",
        );
        const numbered = { ...twice, id: 1 as unknown as string };
        expect(() => new Scheduler({ ...base, faults: [numbered] })).toThrow(
            "fault id must be a non-empty string",
        );
        expect(() => new Scheduler({ ...base, faults: [{ ...twice, id: "" }] })).toThrow(
            "fault id must be a non-empty string",
        );
    });
});

describe("two sleeps on one event", () => {
    test("each scheduled sleep jumps the clock by its own duration before it is observed", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        const sleeps = [3_600_000, 7_200_000].map((duration_ms, i) => ({
            ...episode(`f-sleep-${i}`, "laptop_sleep", {
                kind: "session_start",
                session: "s-0000",
            }),
            params: { duration_ms },
        }));
        await new Scheduler({
            events: fixtureEvents(1),
            faults: sleeps,
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
        const jumps = j.entries.filter((e) => e.kind === "AdvanceClock" && e.fault !== undefined);
        expect(jumps.map((e) => [e.fault, e.scenario_ms - Number(e.from_ms)])).toEqual([
            ["f-sleep-0", 3_600_000],
            ["f-sleep-1", 7_200_000],
        ]);
        const observed = j.entries.filter((e) => e.kind === "FaultObserved");
        expect(observed.map((e) => e.evidence)).toEqual([
            { clock_advanced_ms: 3_600_000 },
            { clock_advanced_ms: 7_200_000 },
        ]);
        expect((j.entries.at(-1) as Entry).scenario_ms).toBeGreaterThanOrEqual(10_800_000);
    });
});

describe("store checks already journaled", () => {
    test("a resumed arm's repeated check for a fault already on record is not journaled again", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        const store = { integrity: "ok", segments: 0, overlaps: [], ranges: [] };
        j.append({ kind: "StartRun", arm: null, scenario_ms: 0 });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({
            kind: "StoreChecked",
            arm: "a",
            scenario_ms: 0,
            event: null,
            fault: "r-1",
            store,
        });
        j.close();
        const resumed = new Journal(path);
        const driver: ArmDriver = {
            reset: async () => undefined,
            event: async (e) =>
                e.kind === "user_turn"
                    ? {
                          stores: [
                              { fault: "r-1", store },
                              { fault: "r-2", store },
                          ],
                      }
                    : {},
            fault: async () => ({}),
        };
        await new Scheduler({
            events: fixtureEvents(1),
            faults: [],
            journal: resumed,
            settleMs: 0,
            order: ["a"],
            drivers: { a: driver },
        }).run();
        const checks = resumed.entries.filter((e) => e.kind === "StoreChecked");
        expect(checks.map((e) => e.fault)).toEqual(["r-1", "r-2"]);
    });
});

describe("store checks outside turns", () => {
    test("store checks a session end or finish settles are journaled with their event", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        const store = { integrity: "ok", segments: 0, overlaps: [], ranges: [] };
        const driver: ArmDriver = {
            reset: async () => undefined,
            event: async (e) => {
                if (e.kind === "session_end") return { stores: [{ fault: "r-1", store }] };
                if (e.kind === "user_turn") return { stores: [{ fault: "r-0", store }] };
                return {};
            },
            fault: async () => ({ pid_after: 2, stores: [{ fault: "r-9", store }] }),
            finish: async () => ({ stores: [{ fault: "r-2", store }] }),
        };
        await new Scheduler({
            events: fixtureEvents(1),
            faults: [
                episode("restart", "daemon_restart", { kind: "session_start", session: "s-0000" }),
            ],
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: { a: driver },
        }).run();
        const checks = j.entries.filter((e) => e.kind === "StoreChecked");
        expect(checks.map((e) => [e.fault, e.event])).toEqual([
            ["r-9", null],
            ["r-0", "e-000001"],
            ["r-1", "e-999999"],
            ["r-2", null],
        ]);
        // A check a fault settles precedes its FaultObserved, whose evidence carries no stores.
        const observed = j.entries.find((e) => e.kind === "FaultObserved");
        expect(observed?.evidence).toEqual({ pid_after: 2 });
        expect(j.entries.indexOf(checks[0] as Entry)).toBeLessThan(
            j.entries.indexOf(observed as Entry),
        );
        const kinds = j.entries.map((e) => e.kind);
        // A turn's check precedes its EndTurn, so a kill between the two replays the turn with
        // the check already on record, and the arm's last check precedes EndArm.
        expect(kinds.indexOf("StoreChecked")).toBeLessThan(kinds.indexOf("EndTurn"));
        expect(kinds.lastIndexOf("StoreChecked")).toBeLessThan(kinds.indexOf("EndArm"));
    });
});

describe("driver lifecycle hooks", () => {
    test("a resumed arm gets the open session, its open jobs end, and finish precedes EndArm", async () => {
        const path = join(dir(), "j.jsonl");
        const events = fixtureEvents(3);
        const first = new Journal(path);
        const calls: string[] = [];
        let scheduler: Scheduler | null = null;
        const interrupted: ArmDriver = {
            reset: async () => void calls.push("reset"),
            event: async (e) => {
                if (e.index === 1) {
                    scheduler?.jobStart("memory_capture-0");
                    throw new Error("harness killed");
                }
                return {};
            },
            fault: async () => ({}),
            finish: async () => void calls.push("finish"),
        };
        scheduler = new Scheduler({
            events,
            faults: [],
            journal: first,
            settleMs: 0,
            order: ["a"],
            drivers: { a: interrupted },
        });
        await expect(scheduler.run()).rejects.toThrow("harness killed");
        first.close();

        const second = new Journal(path);
        let finishedAt = -1;
        const resumed: ArmDriver = {
            reset: async () => void calls.push("reset"),
            resume: async (open) => void calls.push(`resume:${open?.id ?? null}`),
            event: async (e) => {
                calls.push(e.id);
                return {};
            },
            fault: async () => ({}),
            finish: async () => {
                calls.push("finish");
                finishedAt = second.entries.length;
                return undefined;
            },
        };
        await new Scheduler({
            events,
            faults: [],
            journal: second,
            settleMs: 0,
            order: ["a"],
            drivers: { a: resumed },
        }).run();
        expect(calls).toEqual(["reset", "resume:e-000000", "e-000003", "e-999999", "finish"]);
        const tail = second.entries.map((e) => [e.kind, e.job ?? e.event ?? null]);
        expect(tail).toContainEqual(["EndJob", "memory_capture-0"]);
        const endArm = second.entries.findIndex((e) => e.kind === "EndArm");
        expect(endArm).toBe(finishedAt);
    });
});

test("a mid-fold kill observed in the arm's last turn is observed before finish and EndArm", async () => {
    const j = new Journal(join(dir(), "j.jsonl"));
    let scheduler: Scheduler | null = null;
    const order: string[] = [];
    const kill = episode("k", "daemon_sigkill_mid_fold", {
        kind: "first_summarizer_call",
        session: "s-0000",
    });
    const events = fixtureEvents(1).filter((e) => e.kind !== "session_end");
    const driver: ArmDriver = {
        reset: async () => undefined,
        event: async (e) => {
            if (e.kind === "user_turn") scheduler?.observe("history_summarizer", driver);
            return {};
        },
        fault: async () => {
            await Bun.sleep(200);
            order.push("fault");
            return {};
        },
        finish: async () => void order.push("finish"),
    };
    scheduler = new Scheduler({
        events,
        faults: [kill],
        journal: j,
        settleMs: 0,
        order: ["a"],
        drivers: { a: driver },
    });
    await scheduler.run();
    expect(order).toEqual(["fault", "finish"]);
    const kinds = j.entries.map((e) => e.kind);
    expect(kinds.indexOf("FaultObserved")).toBeLessThan(kinds.indexOf("EndArm"));
});

test("a busy set that outlives the idle limit stops the run with the held ids", async () => {
    const j = new Journal(join(dir(), "j.jsonl"));
    let scheduler: Scheduler | null = null;
    const driver: ArmDriver = {
        reset: async () => undefined,
        event: async (e) => {
            if (e.kind === "user_turn") scheduler?.jobStart("stuck");
            return {};
        },
        fault: async () => ({}),
    };
    scheduler = new Scheduler({
        events: fixtureEvents(1),
        faults: [],
        journal: j,
        settleMs: 0,
        idleLimitMs: 100,
        order: ["a"],
        drivers: { a: driver },
    });
    await expect(scheduler.run()).rejects.toThrow("job:stuck");
});

test("a probe turn's snapshot is journaled once per item and arm, after its EndTurn", async () => {
    const j = new Journal(join(dir(), "j.jsonl"));
    const events = fixtureEvents(2).map((e) =>
        e.kind === "user_turn" ? { ...e, probe: "q-1" } : e,
    );
    const driver: ArmDriver = {
        reset: async () => undefined,
        event: async (e) => (e.kind === "user_turn" ? { snapshot: `a:q-1:${e.id}` } : {}),
        fault: async () => ({}),
    };
    await new Scheduler({
        events,
        faults: [],
        journal: j,
        settleMs: 0,
        order: ["a"],
        drivers: { a: driver },
    }).run();
    const kinds = j.entries.map((e) => e.kind);
    const snaps = j.entries.filter((e) => e.kind === "SnapshotArtefacts");
    expect(snaps.map((e) => e.snapshot)).toEqual(["a:q-1:e-000001"]);
    expect(kinds.indexOf("SnapshotArtefacts")).toBe(kinds.indexOf("EndTurn") + 1);
});

test("a harness killed between a probe's EndTurn and its SnapshotArtefacts journals the snapshot on resume", async () => {
    const path = join(dir(), "j.jsonl");
    const events = fixtureEvents(1).map((e) =>
        e.kind === "user_turn" ? { ...e, probe: "q-1" } : e,
    );
    const driver: ArmDriver = {
        reset: async () => undefined,
        event: async (e) => (e.kind === "user_turn" ? { snapshot: `a:q-1:${e.id}` } : {}),
        fault: async () => ({}),
    };
    const first = new Journal(path);
    await new Scheduler({
        events,
        faults: [],
        journal: first,
        settleMs: 0,
        order: ["a"],
        drivers: { a: driver },
    }).run();
    first.close();
    const whole = readJournal(path);
    const cut = whole.findIndex((e) => e.kind === "SnapshotArtefacts");
    writeFileSync(
        path,
        whole
            .slice(0, cut)
            .map((e) => `${JSON.stringify(e)}\n`)
            .join(""),
    );

    const second = new Journal(path);
    await new Scheduler({
        events,
        faults: [],
        journal: second,
        settleMs: 0,
        order: ["a"],
        drivers: { a: driver },
    }).run();
    const snaps = second.entries.filter((e) => e.kind === "SnapshotArtefacts");
    expect(snaps.map((e) => [e.item, e.snapshot])).toEqual([["q-1", "a:q-1:e-000001"]]);
    const kinds = second.entries.map((e) => `${e.kind}:${e.event ?? e.item ?? ""}`);
    expect(kinds.indexOf("SnapshotArtefacts:q-1")).toBeLessThan(kinds.indexOf("Event:e-000001"));
});

test("quiescing jobs waits for background jobs while the turn itself stays open", async () => {
    const j = new Journal(join(dir(), "j.jsonl"));
    let scheduler: Scheduler | null = null;
    let settled = false;
    const driver: ArmDriver = {
        reset: async () => undefined,
        event: async (e) => {
            if (e.kind !== "user_turn") return {};
            setTimeout(() => scheduler?.jobStart("history_summarizer-0"), 20);
            setTimeout(() => scheduler?.jobEnd("history_summarizer-0"), 90);
            await scheduler?.quiesceJobs();
            settled = true;
            return {};
        },
        fault: async () => ({}),
    };
    scheduler = new Scheduler({
        events: fixtureEvents(1),
        faults: [],
        journal: j,
        settleMs: 50,
        jobPollMs: 5,
        order: ["a"],
        drivers: { a: driver },
    });
    await scheduler.run();
    expect(settled).toBe(true);
    const kinds = j.entries.map((e) => `${e.kind}:${e.job ?? e.event ?? ""}`);
    expect(kinds.indexOf("EndJob:history_summarizer-0")).toBeLessThan(
        kinds.indexOf("EndTurn:e-000001"),
    );
});

test("a second resume after an interrupted turn adds no second terminal Event", async () => {
    const path = join(dir(), "j.jsonl");
    const events = fixtureEvents(2);
    const first = new Journal(path);
    const killed: ArmDriver = {
        reset: async () => undefined,
        event: async (e) => {
            if (e.index === 0) throw new Error("harness killed");
            return {};
        },
        fault: async () => ({}),
    };
    await expect(
        new Scheduler({
            events,
            faults: [],
            journal: first,
            settleMs: 0,
            order: ["a"],
            drivers: { a: killed },
        }).run(),
    ).rejects.toThrow("harness killed");
    first.close();
    const again = new Journal(path);
    const killedLater: ArmDriver = {
        reset: async () => undefined,
        event: async (e) => {
            if (e.index === 1) throw new Error("harness killed again");
            return {};
        },
        fault: async () => ({}),
    };
    await expect(
        new Scheduler({
            events,
            faults: [],
            journal: again,
            settleMs: 0,
            order: ["a"],
            drivers: { a: killedLater },
        }).run(),
    ).rejects.toThrow("harness killed again");
    again.close();
    const third = new Journal(path);
    const fine: ArmDriver = {
        reset: async () => undefined,
        event: async () => ({}),
        fault: async () => ({}),
    };
    await new Scheduler({
        events,
        faults: [],
        journal: third,
        settleMs: 0,
        order: ["a"],
        drivers: { a: fine },
    }).run();
    const terminal = third.entries.filter((e) => e.kind === "Event").map((e) => e.event);
    expect(terminal).toEqual([...new Set(terminal)]);
    expect(terminal.filter((e) => e === "e-000001")).toHaveLength(1);
});

test("the call index reads one arm and session's records by position, seeded from disk and fed by the writer", () => {
    const path = join(dir(), "calls.jsonl");
    const base = {
        wall_ms: 1,
        scenario_ms: 5,
        turn: "e-1",
        component: "agent",
        componentSource: "asserted",
        model: "m",
        status: 200,
        finish_reason: "end_turn",
        error: null,
        input_tokens: 1,
        output_tokens: 1,
        proxy_retries: 0,
        first_byte_ms: 1,
        total_ms: 2,
        fault_ref: null,
    };
    const rows = [
        { ...base, seq: 0, arm: "host", session: "s-1", response_text: "a" },
        { ...base, seq: 1, arm: "eidnara", session: "s-1", response_text: "b".repeat(5000) },
        { ...base, seq: 2, arm: "host", session: "s-2", response_text: "c" },
    ];
    writeFileSync(path, rows.map((r) => `${JSON.stringify(r)}\n`).join(""));
    const index = new CallIndex(path);
    expect(callsOf(index, "host", "s-1", new Map()).map((c) => c.response_text)).toEqual(["a"]);
    expect(callsOf(index, "eidnara", "s-1", new Map()).map((c) => c.seq)).toEqual([1]);
    expect(callsOf(index, "host", "s-9", new Map())).toEqual([]);
});
