import { describe, expect, setSystemTime, test } from "bun:test";
import {
    closeSync,
    existsSync,
    ftruncateSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureEvents } from "../../tests/run-fixture";
import { FaultInjector, TARGET } from "../proxy/inject";
import type { CallRecord } from "../proxy/records";
import { Rng } from "../rng";
import type { FaultEpisode } from "../scenario/faults";
import { SEAMS } from "../scenario/faults";
import { Clock } from "./clock";
import {
    bootId,
    directoryIdentity,
    type Entry,
    Journal,
    leaseHost,
    MAX_JOURNAL_BYTES,
    pidNamespace,
    readJournal,
    releaseLease,
    takeLease,
} from "./journal";
import {
    type ArmDriver,
    type ArmHandle,
    HarnessFailure,
    type ScenarioEvent,
    Scheduler,
    scenarioId,
} from "./scheduler";

const ROOT = join(import.meta.dir, "..", "..");
const dir = () => mkdtempSync(join(tmpdir(), "sim-run-"));

type FakeDriver = ArmDriver & { arm: () => ArmHandle };

function fakeDriver(
    log: string[],
    turnMs = 0,
    onTurn?: (e: ScenarioEvent) => Promise<void> | void,
): FakeDriver {
    let handle: ArmHandle | null = null;
    return {
        bind: (h) => {
            handle = h;
        },
        arm: () => {
            if (!handle) throw new Error("driver is not bound to an arm");
            return handle;
        },
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
    const busy = new BusyCount();
    for (const e of entries) {
        if (e.kind === "BeginTurn") expect(busy.open()).toEqual([]);
        busy.apply(e);
        if (e.kind === "AdvanceClock") expect(busy.open()).toEqual([]);
    }
    expect(entries.map((e) => e.seq)).toEqual(entries.map((_, i) => i));
}

/** The busy set a journal implies, counting each key's open registrations. */
class BusyCount {
    private readonly n = new Map<string, number>();
    apply(e: Entry): void {
        const bump = (key: string, d: number) => this.n.set(key, (this.n.get(key) ?? 0) + d);
        if (e.kind === "BeginTurn") bump(`t${e.arm}${e.event}`, 1);
        if (e.kind === "EndTurn") bump(`t${e.arm}${e.event}`, -1);
        if (e.kind === "RegisterJob") bump(`j${e.arm}${e.job}`, 1);
        if (e.kind === "EndJob") bump(`j${e.arm}${e.job}`, -1);
        if (e.kind === "ItemState" && e.state === "failed(interrupted)" && e.event)
            bump(`t${e.arm}${e.event}`, -1);
    }
    open(): string[] {
        return [...this.n].filter(([, c]) => c > 0).map(([k]) => k);
    }
    size(): number {
        return this.open().length;
    }
}

/**
 * Between two consecutive entries of one arm, scenario time holds while the busy set is empty
 * (an `AdvanceClock` is the one exception) and advances by at most the wall time that passed
 * while it is busy, so a change to `scenario_ms` on any entry has a wall-clock cause. A
 * `RegisterJob` is written after its job joined the busy set, so it is read as busy.
 */
function wallRate(entries: Entry[], slackMs = 5): void {
    const busy = new BusyCount();
    const prev = new Map<string | null, Entry>();
    for (const e of entries) {
        const p = prev.get(e.arm);
        if (p) {
            const dScenario = e.scenario_ms - p.scenario_ms;
            const dWall = e.wall_ms - p.wall_ms;
            if (busy.size() === 0 && e.kind !== "RegisterJob") {
                if (e.kind !== "AdvanceClock") expect(dScenario).toBe(0);
            } else {
                expect(dScenario).toBeLessThanOrEqual(dWall + slackMs);
            }
        }
        prev.set(e.arm, e);
        busy.apply(e);
    }
}

describe("Clock", () => {
    test("busy time comes from a monotonic source, so a wall-clock step does not reach scenario time", () => {
        const clock = new Clock(0, new Journal(join(dir(), "j.jsonl")));
        clock.begin("turn");
        try {
            setSystemTime(new Date(Date.now() + 3_600_000));
            expect(clock.now()).toBeLessThan(1_000);
        } finally {
            setSystemTime();
        }
        clock.end("turn");
        expect(clock.now()).toBeLessThan(1_000);
    });
    test("a wall source that steps backward across an idle gap never counts the rollback twice", () => {
        let wall = 100;
        const clock = new Clock(0, new Journal(join(dir(), "j.jsonl")), () => wall);
        clock.begin("turn");
        wall = 200;
        expect(clock.now()).toBe(100);
        wall = 150;
        clock.end("turn");
        clock.begin("turn");
        wall = 210;
        expect(clock.now()).toBe(110);
    });

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
        expect(() => clock.begin("job")).toThrow(/already busy/);
        expect(() => clock.end("nobody")).toThrow(/not busy/);
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

    /** Overwrites the directory's highest lease file, the one `takeLease` reads. */
    const writeTopLease = (d: string, body: string) => {
        const top = readdirSync(d)
            .flatMap((n) => (/^lease\.(\d+)\.json$/.test(n) ? [Number(n.split(".")[1])] : []))
            .sort((a, b) => a - b)
            .at(-1);
        writeFileSync(join(d, `lease.${top ?? 0}.json`), body);
    };

    test("one live process holds the lease; a dead holder's lease is taken over", () => {
        const d = dir();
        const first = takeLease(d);
        expect(() => takeLease(d)).toThrow(/is leased by pid/);
        releaseLease(d, first);
        const dead = Bun.spawnSync(["true"]).pid;
        writeTopLease(
            d,
            JSON.stringify({
                pid: dead,
                host: leaseHost(),
                ns: pidNamespace(),
                started_wall_ms: 0,
            }),
        );
        const second = takeLease(d);
        expect(second.pid).toBe(process.pid);
        releaseLease(d, second);
        writeTopLease(d, "");
        expect(() => takeLease(d)).toThrow(/malformed/);
        writeTopLease(d, JSON.stringify({ pid: dead, host: "elsewhere", started_wall_ms: 0 }));
        expect(() => takeLease(d)).toThrow(/on elsewhere/);
    });

    test("a dead holder whose pid a live process now carries is taken over", () => {
        const d = dir();
        const other = Bun.spawn(["sleep", "30"]);
        try {
            const mine = takeLease(d);
            expect(typeof mine.started_ticks).toBe("number");
            releaseLease(d, mine);
            writeFileSync(
                join(d, "lease.0.json"),
                JSON.stringify({
                    pid: other.pid,
                    host: leaseHost(),
                    ns: pidNamespace(),
                    started_wall_ms: 0,
                    started_ticks: (mine.started_ticks as number) - 1,
                }),
            );
            const retaken = takeLease(d);
            expect(retaken.pid).toBe(process.pid);
            releaseLease(d, retaken);
        } finally {
            other.kill();
        }
    });

    test("a corrupt complete line refuses the journal, wherever it sits", () => {
        const path = join(dir(), "j.jsonl");
        const line = (seq: number) =>
            JSON.stringify({ seq, kind: "StartRun", arm: null, scenario_ms: 0, wall_ms: 1 });
        writeFileSync(path, `${line(0)}\nnot json\n${line(2)}\n`);
        expect(() => new Journal(path)).toThrow(/line 2 is corrupt/);
        writeFileSync(path, `${line(0)}\nnot json\n`);
        expect(() => new Journal(path)).toThrow(/line 2 is corrupt/);
        expect(readFileSync(path, "utf8")).toBe(`${line(0)}\nnot json\n`);
        writeFileSync(path, `${line(0)}\n${line(0)}\n`);
        expect(() => new Journal(path)).toThrow(/line 2 .*seq/);
        writeFileSync(path, '{"seq":0,"kind":"EndRun"}\n');
        expect(() => new Journal(path)).toThrow(/line 1 is not an entry/);
        writeFileSync(path, `${line(0)}\n${line(1).replace("StartRun", "Bogus")}\n`);
        expect(() => new Journal(path)).toThrow(/line 2 is not an entry/);
        writeFileSync(path, `${line(0).replace('"scenario_ms":0', '"scenario_ms":1e999')}\n`);
        expect(() => new Journal(path)).toThrow(/line 1 is not an entry/);
        const at = (seq: number, ms: number) =>
            JSON.stringify({ seq, kind: "Event", arm: "a", scenario_ms: ms, wall_ms: 1 });
        writeFileSync(path, `${at(0, 10)}\n${at(1, 5)}\n`);
        expect(() => new Journal(path)).toThrow(/line 2 .*precedes/);
    });

    test("a released lease keeps its generation, so later takers link a higher number", () => {
        const d = dir();
        const first = takeLease(d);
        releaseLease(d, first);
        const left = readdirSync(d).filter((n) => /^lease\.\d+\.json$/.test(n));
        expect(left).toEqual(["lease.0.json"]);
        expect(JSON.parse(readFileSync(join(d, "lease.0.json"), "utf8")).released).toBe(true);
        const second = takeLease(d);
        expect(readdirSync(d).filter((n) => /^lease\.\d+\.json$/.test(n))).toEqual([
            "lease.1.json",
        ]);
        releaseLease(d, second);
    });

    test("a lease this machine left before a reboot is taken over; one from another machine is refused", () => {
        const d = dir();
        const mine = takeLease(d);
        releaseLease(d, mine);
        expect(typeof mine.boot).toBe("string");
        const stale = {
            ...mine,
            boot: "00000000-0000-4000-8000-000000000000",
            released: undefined,
        };
        writeFileSync(join(d, "lease.0.json"), JSON.stringify(stale));
        const retaken = takeLease(d);
        expect(retaken.pid).toBe(process.pid);
        releaseLease(d, retaken);
        writeFileSync(
            join(d, "lease.1.json"),
            JSON.stringify({
                ...mine,
                host: "another-machine",
                boot: bootId(),
                released: undefined,
            }),
        );
        expect(() => takeLease(d)).toThrow(/on another-machine/);
    });

    test("a released lease is free whatever machine released it", () => {
        const d = dir();
        writeFileSync(
            join(d, "lease.0.json"),
            JSON.stringify({ pid: 1, host: "another-machine", started_wall_ms: 0, released: true }),
        );
        const taken = takeLease(d);
        expect(taken.pid).toBe(process.pid);
        releaseLease(d, taken);
    });

    test("a journal with EndRun but an unfinished arm is refused as corrupt", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        const start = { order: ["a", "b"], scenario: scenarioId(fixtureEvents(1), []) };
        j.append({ kind: "StartRun", arm: null, scenario_ms: 0, ...start });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "EndArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "EndRun", arm: null, scenario_ms: 0 });
        j.close();
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [],
                journal: new Journal(path),
                settleMs: 0,
                order: ["a", "b"],
                drivers: { a: fakeDriver([]), b: fakeDriver([]) },
            }).run(),
        ).rejects.toThrow(/unfinished arms|before its events completed|outside its arm/);
    });

    test("append refuses a non-finite scenario time", () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        expect(() => j.append({ kind: "StartRun", arm: null, scenario_ms: Infinity })).toThrow(
            /not finite/,
        );
        expect(j.entries).toHaveLength(0);
    });

    test("a dead lease from another pid namespace on this machine is refused, since its pid cannot be probed here", () => {
        const d = dir();
        const mine = takeLease(d);
        releaseLease(d, mine);
        expect(typeof mine.ns).toBe("string");
        const dead = Bun.spawnSync(["true"]).pid;
        writeFileSync(
            join(d, "lease.0.json"),
            JSON.stringify({ ...mine, pid: dead, ns: "pid:[1]", released: undefined }),
        );
        expect(() => takeLease(d)).toThrow(/is leased by pid/);
    });

    test("a lease that parses to the wrong shape refuses the directory instead of being trusted", () => {
        const d = dir();
        writeFileSync(
            join(d, "lease.0.json"),
            JSON.stringify({
                pid: process.pid,
                host: leaseHost(),
                started_wall_ms: 0,
                released: "false",
            }),
        );
        expect(() => takeLease(d)).toThrow(/malformed/);
    });

    test("a journal path that is a hard link is refused and the other name left alone", () => {
        const d = dir();
        const other = join(d, "other.txt");
        writeFileSync(other, "bytes with no newline");
        const link = join(d, "journal.jsonl");
        linkSync(other, link);
        expect(() => new Journal(link)).toThrow(/links/);
        expect(readFileSync(other, "utf8")).toBe("bytes with no newline");
    });

    test("a closed journal refuses further appends", () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        j.append({ kind: "StartRun", arm: null, scenario_ms: 0 });
        j.close();
        expect(() => j.append({ kind: "EndRun", arm: null, scenario_ms: 0 })).toThrow(/closed/);
        expect(() => j.close()).toThrow(/closed/);
    });

    test("a lease at the last safe generation refuses the directory rather than rounding the next", () => {
        const d = dir();
        writeFileSync(
            join(d, `lease.${Number.MAX_SAFE_INTEGER}.json`),
            JSON.stringify({ pid: 1, host: "x", started_wall_ms: 0, released: true }),
        );
        expect(() => takeLease(d)).toThrow(/exhausted/);
    });

    test("a lease path that is a fifo is refused without blocking on a read", () => {
        const d = dir();
        const fifo = join(d, "lease.0.json");
        expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
        const child = Bun.spawnSync(
            [
                "bun",
                "-e",
                'import { takeLease } from "./src/run/journal"; takeLease(process.argv[1]);',
                d,
            ],
            { cwd: ROOT, timeout: 5_000 },
        );
        expect(child.signalCode ?? null).toBeNull();
        expect(child.exitCode).not.toBe(0);
        expect(child.stderr.toString()).toMatch(/not a regular file/);
    });

    test("two acquisitions in one millisecond are different tokens", () => {
        const d = dir();
        const first = takeLease(d);
        releaseLease(d, first);
        const second = takeLease(d);
        releaseLease(d, { ...second, token: first.token });
        expect(JSON.parse(readFileSync(join(d, "lease.1.json"), "utf8")).released).toBeUndefined();
        releaseLease(d, second);
        expect(JSON.parse(readFileSync(join(d, "lease.1.json"), "utf8")).released).toBe(true);
    });

    test("a lease name with a non-canonical number refuses the directory", () => {
        const d = dir();
        writeFileSync(
            join(d, "lease.000.json"),
            JSON.stringify({ pid: process.pid, host: leaseHost(), started_wall_ms: 0 }),
        );
        expect(() => takeLease(d)).toThrow(/canonical/);
    });

    test("a lease with negative start ticks is malformed", () => {
        const d = dir();
        writeFileSync(
            join(d, "lease.0.json"),
            JSON.stringify({
                pid: process.pid,
                host: leaseHost(),
                started_wall_ms: 0,
                started_ticks: -1,
            }),
        );
        expect(() => takeLease(d)).toThrow(/malformed/);
    });

    test("a zombie holder is a dead holder", () => {
        const d = dir();
        const child = Bun.spawn(["true"]);
        const deadline = Date.now() + 2_000;
        let state = "";
        while (state !== "Z" && Date.now() < deadline) {
            try {
                const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
                state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] ?? "";
            } catch {}
            if (state !== "Z") Bun.sleepSync(5);
        }
        if (state !== "Z")
            throw new Error(`child never became a zombie (state ${state || "none"})`);
        const mine = takeLease(d);
        releaseLease(d, mine);
        const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
        const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
        writeFileSync(
            join(d, "lease.0.json"),
            JSON.stringify({
                ...mine,
                pid: child.pid,
                started_ticks: ticks,
                released: undefined,
                token: "z",
            }),
        );
        const taken = takeLease(d);
        expect(taken.pid).toBe(process.pid);
        releaseLease(d, taken);
        child.kill();
    });

    test("a journal line with invalid UTF-8 is corrupt, and the complete prefix is measured in bytes", () => {
        const path = join(dir(), "j.jsonl");
        const good = Buffer.from(
            `${JSON.stringify({ seq: 0, kind: "StartRun", arm: null, scenario_ms: 0, wall_ms: 1 })}\n`,
        );
        const bad = Buffer.concat([
            Buffer.from('{"seq":1,"kind":"StartArm","arm":"'),
            Buffer.from([0xff]),
            Buffer.from('","scenario_ms":0,"wall_ms":1}\n'),
        ]);
        writeFileSync(path, Buffer.concat([good, bad]));
        expect(() => new Journal(path)).toThrow(/line 2 is corrupt/);
        const cut = Buffer.concat([good, Buffer.from([0xff, 0x7b])]);
        writeFileSync(path, cut);
        const j = new Journal(path);
        expect(j.entries).toHaveLength(1);
        j.close();
        expect(readFileSync(path).equals(good)).toBe(true);
    });

    test("a lease with a fractional start tick or a malformed boot id is malformed", () => {
        const d = dir();
        const base = { pid: process.pid, host: leaseHost(), started_wall_ms: 0 };
        writeFileSync(join(d, "lease.0.json"), JSON.stringify({ ...base, started_ticks: 1.5 }));
        expect(() => takeLease(d)).toThrow(/malformed/);
        writeFileSync(join(d, "lease.0.json"), JSON.stringify({ ...base, boot: "" }));
        expect(() => takeLease(d)).toThrow(/malformed/);
    });

    test("releaseLease ignores a damaged lower generation and releases the holder", () => {
        const d = dir();
        writeFileSync(join(d, "lease.0.json"), "garbage");
        writeFileSync(
            join(d, "lease.1.json"),
            JSON.stringify({ pid: 1, host: "x", started_wall_ms: 0, released: true }),
        );
        const mine = takeLease(d);
        writeFileSync(join(d, "lease.0.json"), "garbage");
        releaseLease(d, mine);
        expect(JSON.parse(readFileSync(join(d, "lease.2.json"), "utf8")).released).toBe(true);
    });

    test("a lease file whose number is outside the safe integer range refuses the directory", () => {
        const d = dir();
        writeFileSync(join(d, "lease.99999999999999999999.json"), "{}");
        expect(() => takeLease(d)).toThrow(/lease/);
    });

    test("a journal path that is a fifo is refused without blocking on a read", () => {
        const d = dir();
        const fifo = join(d, "journal.jsonl");
        expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
        const child = Bun.spawnSync(
            [
                "bun",
                "-e",
                'import { Journal } from "./src/run/journal"; new Journal(process.argv[1]);',
                fifo,
            ],
            { cwd: ROOT, timeout: 5_000 },
        );
        expect(child.signalCode ?? null).toBeNull();
        expect(child.exitCode).not.toBe(0);
        expect(child.stderr.toString()).toMatch(/not a regular file/);
    });

    test("a journal path that is a symlink is refused and its target left alone", () => {
        const d = dir();
        const target = join(d, "target.txt");
        writeFileSync(target, "precious bytes with no newline");
        const link = join(d, "journal.jsonl");
        symlinkSync(target, link);
        expect(() => new Journal(link)).toThrow();
        expect(readFileSync(target, "utf8")).toBe("precious bytes with no newline");
    });

    test("releaseLease releases only the acquisition it is given", () => {
        const d = dir();
        const mine = takeLease(d);
        releaseLease(d, { ...mine, started_wall_ms: mine.started_wall_ms + 1 });
        expect(JSON.parse(readFileSync(join(d, "lease.0.json"), "utf8")).released).toBeUndefined();
        releaseLease(d, { ...mine, started_ticks: (mine.started_ticks ?? 0) + 1 });
        expect(JSON.parse(readFileSync(join(d, "lease.0.json"), "utf8")).released).toBeUndefined();
        releaseLease(d, mine);
        expect(JSON.parse(readFileSync(join(d, "lease.0.json"), "utf8")).released).toBe(true);
    });

    test("releaseLease leaves a lease held by the same pid on another host", () => {
        const d = dir();
        writeFileSync(
            join(d, "lease.0.json"),
            JSON.stringify({ pid: process.pid, host: "elsewhere", started_wall_ms: 0 }),
        );
        releaseLease(d, { pid: process.pid, host: leaseHost(), started_wall_ms: 0 });
        expect(existsSync(join(d, "lease.0.json"))).toBe(true);
    });

    test("racing resumers of a dead lease produce one holder", async () => {
        const contender = `
            import { appendFileSync, existsSync, readFileSync } from "node:fs";
            import { takeLease } from "./src/run/journal";
            const [dir, out] = process.argv.slice(1);
            const lost = () => existsSync(out + ".lost") ? readFileSync(out + ".lost", "utf8").split("\\n").length - 1 : 0;
            try {
                takeLease(dir);
                appendFileSync(out, process.pid + "\\n");
                const until = Date.now() + 10_000;
                while (lost() < 7 && Date.now() < until) await Bun.sleep(5);
            } catch (e) {
                appendFileSync(out + ".lost", e.message + "\\n");
            }`;
        for (let round = 0; round < 2; round++) {
            const d = dir();
            const dead = Bun.spawnSync(["true"]).pid;
            writeFileSync(
                join(d, "lease.0.json"),
                JSON.stringify({
                    pid: dead,
                    host: leaseHost(),
                    ns: pidNamespace(),
                    started_wall_ms: 0,
                }),
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
        wallRate(j.entries);
        expect(logs.eidnara?.[0]).toBe("reset");
        expect(logs.host).toEqual(logs.eidnara);
        expect(j.entries.filter((e) => e.kind === "StartArm").map((e) => e.arm)).toEqual([
            "eidnara",
            "host",
        ]);
        const jumps = j.entries.filter((e) => e.kind === "AdvanceClock");
        expect(jumps.map((e) => [e.arm, e.scenario_ms])).toEqual(
            ["eidnara", "host"].flatMap((arm) => [60_000, 120_000, 180_000].map((t) => [arm, t])),
        );
        for (const a of jumps) {
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
                setTimeout(() => {
                    driver.arm().jobStart("fold-1");
                    setTimeout(() => driver.arm().jobEnd("fold-1"), 120);
                }, 0);
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
        wallRate(j.entries);
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
        expect(j.entries[at - 1]).toMatchObject({ kind: "Event", event: "e-000002" });
        expect(j.entries[at + 1]).toMatchObject({ kind: "FaultFired", fault: "f-sleep" });
        const opening = j.entries.findIndex((e) => e.kind === "Event" && e.event === "e-100000");
        expect(opening).toBeGreaterThan(at);
        expect(j.entries[opening]?.scenario_ms).toBe(8 * 3_600_000);
        expect((jumps[0] as Entry).from_ms).toBeGreaterThanOrEqual(20);
        expect(j.entries.filter((e) => e.kind === "FaultFired")).toHaveLength(1);
        const started = j.entries.find((e) => e.kind === "Event" && e.event === "e-100001");
        expect(started?.scenario_ms).toBe(8 * 3_600_000);
    });

    test("a proxy fault whose arming fails is not journaled as fired", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        const faults = [
            episode("p1", "provider_429", { kind: "user_turn", session: "s-0000", n: 1 }),
        ];
        const proxy = {
            arm: () => {
                throw new Error("proxy is down");
            },
            disarm: () => undefined,
            reset: () => undefined,
        };
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults,
                journal: j,
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
                proxy,
            }).run(),
        ).rejects.toThrow(/proxy is down/);
        expect(j.entries.filter((e) => e.kind === "FaultFired")).toEqual([]);
    });

    test("each arm draws the same intermittent fault mask from a reset injector", async () => {
        const fault = {
            ...episode("p1", "provider_429", { kind: "user_turn", session: "s-0000", n: 1 }),
            strategy: "intermittent" as const,
            params: { probability: 0.5, calls: 10 },
        };
        const injector = new FaultInjector([fault], new Rng(3), 1_000);
        const masks: Record<string, boolean[]> = { a: [], b: [] };
        const record = (seq: number, fault_ref: string | null): CallRecord => ({
            seq,
            arm: "a",
            session: "s-0000",
            turn: "e-000001",
            component: TARGET,
            componentSource: "asserted",
            model: "m",
            status: fault_ref ? 429 : 200,
            finish_reason: null,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            started_wall_ms: Date.now(),
            wall_ms: Date.now(),
            scenario_ms: 0,
            first_byte_ms: null,
            proxy_retries: 0,
            fault_ref,
            error: null,
        });
        const driver = (arm: string) =>
            fakeDriver([], 0, (e) => {
                if (e.kind === "user_turn") {
                    for (let call = 0; call < 6; call++) {
                        const injected = injector.take(TARGET, call) !== null;
                        masks[arm]?.push(injected);
                        if (arm === "a") {
                            injector.observe(
                                record(call, injected ? "p1" : null),
                                call,
                                performance.now(),
                            );
                        }
                    }
                    if (arm === "a") {
                        expect(injector.report()[0]?.injected_seq.length).toBeGreaterThan(0);
                    }
                }
            });
        await new Scheduler({
            events: fixtureEvents(1),
            faults: [fault],
            journal: new Journal(join(dir(), "j.jsonl")),
            settleMs: 0,
            order: ["a", "b"],
            drivers: { a: driver("a"), b: driver("b") },
            proxy: injector,
        }).run();
        expect(masks.a).toHaveLength(6);
        expect(masks.a).toContain(true);
        expect(masks.b).toEqual(masks.a);
        expect(injector.report().every((w) => w.injected_seq.length === 0)).toBe(true);
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
            reset: () => undefined,
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
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            bind: (h) => {
                handle = h;
            },
            reset: async () => undefined,
            event: async (e) => {
                if (e.kind === "user_turn" && e.index === 2) handle?.observe("history_summarizer");
                return {};
            },
            fault: async () => {
                await Bun.sleep(20);
                handle?.daemonExited({ signal: "SIGKILL" });
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
        expect(() => handle?.daemonExited({ signal: "SIGKILL" })).toThrow(/arm has ended/);
    });

    test("an outage window admits one daemon exit; a second exit of the replacement is fatal", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        let handle: ArmHandle | null = null;
        let second: unknown = "none";
        const kill = episode("k", "daemon_sigkill_mid_fold", {
            kind: "first_summarizer_call",
            session: "s-0000",
        });
        const driver: ArmDriver = {
            ...fakeDriver([]),
            bind: (h) => {
                handle = h;
            },
            event: async (e) => {
                if (e.kind === "user_turn" && e.index === 0) handle?.observe("history_summarizer");
                return {};
            },
            fault: async () => {
                handle?.daemonExited({ signal: "SIGKILL" });
                try {
                    handle?.daemonExited({ signal: "SIGSEGV" });
                    second = "accepted";
                } catch (caught) {
                    second = caught;
                }
                return { restarted_by: "harness" };
            },
        };
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [kill],
                journal: j,
                settleMs: 0,
                order: ["a"],
                drivers: { a: driver },
            }).run(),
        ).rejects.toThrow(HarnessFailure);
        expect(second).toBeInstanceOf(HarnessFailure);
        expect(j.entries.filter((e) => e.kind === "ItemState").map((e) => e.expected)).toEqual([
            true,
            false,
        ]);
    });

    test("an unexpected daemon exit ends a turn the dead daemon never answers", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        const driver = fakeDriver([], 0, async (e) => {
            if (e.kind === "user_turn" && e.index === 0) {
                setTimeout(() => {
                    try {
                        driver.arm().daemonExited({ signal: "SIGKILL" });
                    } catch {}
                }, 30);
                await new Promise(() => undefined);
            }
        });
        await expect(
            new Scheduler({
                events: fixtureEvents(2),
                faults: [],
                journal: j,
                settleMs: 0,
                order: ["a"],
                drivers: { a: driver },
            }).run(),
        ).rejects.toThrow(HarnessFailure);
    }, 3_000);

    test("a laptop sleep whose session the clock already reached is journaled missed, with no jump claimed", async () => {
        const events: ScenarioEvent[] = [
            { id: "e-000000", kind: "session_start", scenario_ms: 0, session: "s-0000" },
            { id: "e-000001", kind: "user_turn", scenario_ms: 0, session: "s-0000", index: 0 },
            { id: "e-000002", kind: "session_end", scenario_ms: 0, session: "s-0000" },
            { id: "e-100000", kind: "session_start", scenario_ms: 50, session: "s-0001" },
            { id: "e-100001", kind: "session_end", scenario_ms: 50, session: "s-0001" },
        ];
        const sleep = {
            ...episode("f-sleep", "laptop_sleep", { kind: "session_start", session: "s-0001" }),
            params: { duration_ms: 50 },
        };
        const j = new Journal(join(dir(), "j.jsonl"));
        const driver = fakeDriver([], 0, (e) => {
            if (e.kind === "user_turn") {
                driver.arm().jobStart("long");
                setTimeout(() => driver.arm().jobEnd("long"), 120);
            }
        });
        await new Scheduler({
            events,
            faults: [sleep],
            journal: j,
            settleMs: 0,
            jobPollMs: 5,
            order: ["a"],
            drivers: { a: driver },
        }).run();
        expect(j.entries.filter((e) => e.kind === "AdvanceClock")).toEqual([]);
        expect(j.entries.filter((e) => e.kind === "FaultFired")).toEqual([]);
        expect(j.entries).toContainEqual(
            expect.objectContaining({ kind: "ItemState", fault: "f-sleep", state: "missed" }),
        );
    });

    test("a resume after a missed sleep neither repeats the miss nor fires the sleep mid-session", async () => {
        const events: ScenarioEvent[] = [
            { id: "e-000000", kind: "session_start", scenario_ms: 0, session: "s-0000" },
            { id: "e-000001", kind: "user_turn", scenario_ms: 0, session: "s-0000", index: 0 },
            { id: "e-000002", kind: "session_end", scenario_ms: 0, session: "s-0000" },
            { id: "e-100000", kind: "session_start", scenario_ms: 50, session: "s-0001" },
            { id: "e-100001", kind: "user_turn", scenario_ms: 5_000, session: "s-0001", index: 0 },
            { id: "e-100002", kind: "session_end", scenario_ms: 5_000, session: "s-0001" },
        ];
        const sleep = {
            ...episode("f-sleep", "laptop_sleep", { kind: "session_start", session: "s-0001" }),
            params: { duration_ms: 50 },
        };
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(events, [sleep]),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        for (const id of ["e-000000", "e-000001", "e-000002"]) {
            if (id === "e-000001") {
                j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: id });
                j.append({ kind: "RegisterJob", arm: "a", scenario_ms: 0, job: "fold" });
                j.append({ kind: "EndTurn", arm: "a", scenario_ms: 0, event: id, outcome: "ok" });
            }
            j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: id, outcome: "ok" });
        }
        j.append({ kind: "EndJob", arm: "a", scenario_ms: 120, job: "fold" });
        j.append({
            kind: "ItemState",
            arm: "a",
            scenario_ms: 120,
            fault: "f-sleep",
            state: "missed",
        });
        j.append({ kind: "Event", arm: "a", scenario_ms: 120, event: "e-100000", outcome: "ok" });
        j.close();
        const resumed = new Journal(path);
        await new Scheduler({
            events,
            faults: [sleep],
            journal: resumed,
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
        const about = resumed.entries.filter((e) => e.fault === "f-sleep");
        expect(about.map((e) => [e.kind, e.state])).toEqual([["ItemState", "missed"]]);
        const jump = resumed.entries.find((e) => e.kind === "AdvanceClock");
        expect(jump).toMatchObject({ next_event: "e-100001", scenario_ms: 5_000 });
    });

    test("a mid-fold fault that rejects while the turn is still pending fails the run at once", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        const kill = episode("k", "daemon_sigkill_mid_fold", {
            kind: "first_summarizer_call",
            session: "s-0000",
        });
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            ...fakeDriver([]),
            bind: (h) => {
                handle = h;
            },
            event: async (e) => {
                if (e.kind === "user_turn") {
                    handle?.observe("history_summarizer");
                    await new Promise(() => undefined);
                }
                return {};
            },
            fault: async () => {
                await Bun.sleep(20);
                throw new Error("restart path broken");
            },
        };
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [kill],
                journal: j,
                settleMs: 0,
                order: ["a"],
                drivers: { a: driver },
            }).run(),
        ).rejects.toThrow(/restart path broken|fault k failed/);
    }, 3_000);

    test("a sleep jump on disk without its FaultFired is completed on resume, never marked missed", async () => {
        const events: ScenarioEvent[] = [
            { id: "e-000000", kind: "session_start", scenario_ms: 0, session: "s-0000" },
            { id: "e-000001", kind: "session_end", scenario_ms: 0, session: "s-0000" },
            { id: "e-100000", kind: "session_start", scenario_ms: 500, session: "s-0001" },
            { id: "e-100001", kind: "session_end", scenario_ms: 500, session: "s-0001" },
        ];
        const sleep = {
            ...episode("f-sleep", "laptop_sleep", { kind: "session_start", session: "s-0001" }),
            params: { duration_ms: 500 },
        };
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(events, [sleep]),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000001", outcome: "ok" });
        j.append({
            kind: "AdvanceClock",
            arm: "a",
            scenario_ms: 500,
            from_ms: 0,
            busy: [],
            fault: "f-sleep",
        });
        j.close();
        const resumed = new Journal(path);
        await new Scheduler({
            events,
            faults: [sleep],
            journal: resumed,
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
        const about = resumed.entries
            .filter((e) => e.fault === "f-sleep")
            .map((e) => [e.kind, e.state]);
        expect(about).toEqual([
            ["AdvanceClock", undefined],
            ["FaultFired", undefined],
        ]);
    });

    test("an arm with EndArm before its events completed is refused on resume", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(1), []),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "EndArm", arm: "a", scenario_ms: 0 });
        j.close();
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [],
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run(),
        ).rejects.toThrow(/EndArm before its events completed/);
    });

    test("a retried run on the same scheduler resets the injector before resuming the arm", async () => {
        const fault = {
            ...episode("p1", "provider_429", { kind: "user_turn", session: "s-0000", n: 1 }),
            strategy: "burst" as const,
            params: { count: 3 },
        };
        const injector = new FaultInjector([fault], new Rng(1), 1_000);
        const taken: boolean[] = [];
        const driver = fakeDriver([], 0, (e) => {
            if (e.kind === "user_turn" && e.index === 1)
                taken.push(injector.take(TARGET, 1) !== null);
        });
        const path = join(dir(), "j.jsonl");
        const cut = new Journal(path);
        cut.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(2), [fault]),
        });
        cut.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        cut.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
        cut.append({
            kind: "FaultFired",
            arm: "a",
            scenario_ms: 0,
            fault: "p1",
            type: "provider_429",
            layer: "proxy-sink",
        });
        cut.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: "e-000001" });
        cut.close();
        injector.arm("p1");
        injector.take(TARGET, 0);
        await new Scheduler({
            events: fixtureEvents(2),
            faults: [fault],
            journal: new Journal(path),
            settleMs: 0,
            order: ["a"],
            drivers: { a: driver },
            proxy: injector,
        }).run();
        expect(taken).toEqual([false]);
    });

    test("a turn recovered as answered on resume still gets its settle window for late jobs", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(2), []),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
        j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: "e-000001" });
        j.append({ kind: "EndTurn", arm: "a", scenario_ms: 10, event: "e-000001", outcome: "ok" });
        j.close();
        const driver = fakeDriver([]);
        const reconnected: ArmDriver = {
            ...driver,
            bind: (h) => {
                driver.bind(h);
                setTimeout(() => {
                    h.jobStart("fold-late");
                    setTimeout(() => h.jobEnd("fold-late"), 60);
                }, 20);
            },
        };
        const resumed = new Journal(path);
        await new Scheduler({
            events: fixtureEvents(2),
            faults: [],
            journal: resumed,
            settleMs: 50,
            jobPollMs: 5,
            order: ["a"],
            drivers: { a: reconnected },
        }).run();
        invariants(resumed.entries);
        const kinds = resumed.entries.map((e) => e.kind);
        expect(kinds.indexOf("RegisterJob")).toBeLessThan(kinds.indexOf("AdvanceClock"));
    });

    test("a resume restores the open session so a late summarizer observation still fires its kill", async () => {
        const path = join(dir(), "j.jsonl");
        const kill = episode("k", "daemon_sigkill_mid_fold", {
            kind: "first_summarizer_call",
            session: "s-0000",
        });
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(2), [kill]),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
        j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: "e-000001" });
        j.append({ kind: "EndTurn", arm: "a", scenario_ms: 10, event: "e-000001", outcome: "ok" });
        j.close();
        const inner = fakeDriver([]);
        const driver: ArmDriver = {
            ...inner,
            bind: (h) => {
                inner.bind(h);
                setTimeout(() => h.observe("history_summarizer"), 10);
            },
            fault: async () => {
                await Bun.sleep(80);
                return { killed: true };
            },
        };
        const resumed = new Journal(path);
        await new Scheduler({
            events: fixtureEvents(2),
            faults: [kill],
            journal: resumed,
            settleMs: 50,
            order: ["a"],
            drivers: { a: driver },
        }).run();
        const kinds = resumed.entries.map((e) => e.kind);
        expect(kinds).toContain("FaultFired");
        const recovered = kinds.indexOf("Event", kinds.indexOf("ResumeRun"));
        expect(kinds.indexOf("FaultObserved")).toBeLessThan(recovered);
    });

    test("a fatal exit during the resume settle window refuses the run before any recovered Event", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(2), []),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
        j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: "e-000001" });
        j.append({ kind: "EndTurn", arm: "a", scenario_ms: 10, event: "e-000001", outcome: "ok" });
        j.close();
        const inner = fakeDriver([]);
        const driver: ArmDriver = {
            ...inner,
            bind: (h) => {
                inner.bind(h);
                setTimeout(() => {
                    try {
                        h.daemonExited({ signal: "SIGSEGV" });
                    } catch {}
                }, 10);
            },
        };
        const resumed = new Journal(path);
        const started = performance.now();
        await expect(
            new Scheduler({
                events: fixtureEvents(2),
                faults: [],
                journal: resumed,
                settleMs: 2_000,
                order: ["a"],
                drivers: { a: driver },
            }).run(),
        ).rejects.toThrow(HarnessFailure);
        expect(performance.now() - started).toBeLessThan(1_000);
        expect(resumed.entries.filter((e) => e.kind === "Event").map((e) => e.event)).toEqual([
            "e-000000",
        ]);
    });

    test("a recovered turn's Event is journaled after its settle window, so a kill inside the window keeps the window", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(2), []),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
        j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: "e-000001" });
        j.append({ kind: "EndTurn", arm: "a", scenario_ms: 10, event: "e-000001", outcome: "ok" });
        j.close();
        const resumed = new Journal(path);
        const run = new Scheduler({
            events: fixtureEvents(2),
            faults: [],
            journal: resumed,
            settleMs: 200,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
        await Bun.sleep(60);
        expect(resumed.entries.filter((e) => e.kind === "Event").map((e) => e.event)).toEqual([
            "e-000000",
        ]);
        await run;
    });

    test("an EndTurn without its BeginTurn, or a second EndTurn for one turn, is refused on resume", async () => {
        const journals: Journal[] = [];
        const make = (lines: Partial<Entry>[]) => {
            const path = join(dir(), "j.jsonl");
            const j = new Journal(path);
            j.append({
                kind: "StartRun",
                arm: null,
                scenario_ms: 0,
                order: ["a"],
                scenario: scenarioId(fixtureEvents(2), []),
            });
            j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
            j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
            for (const l of lines) j.append({ arm: "a", scenario_ms: 0, ...l } as never);
            j.close();
            const journal = new Journal(path);
            journals.push(journal);
            return new Scheduler({
                events: fixtureEvents(2),
                faults: [],
                journal,
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            });
        };
        await expect(
            make([{ kind: "EndTurn", event: "e-000001", outcome: "ok" }]).run(),
        ).rejects.toThrow(/has no BeginTurn/);
        await expect(
            make([
                { kind: "BeginTurn", event: "e-000001" },
                { kind: "EndTurn", event: "e-000001", outcome: "ok" },
                { kind: "EndTurn", event: "e-000001", outcome: "ok" },
            ]).run(),
        ).rejects.toThrow(/EndTurn for e-000001 repeats/);
    });

    test("a resume does not reopen an outage window the daemon exit already closed", async () => {
        const path = join(dir(), "j.jsonl");
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(1), [restart]),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({
            kind: "FaultFired",
            arm: "a",
            scenario_ms: 0,
            fault: "r",
            type: "daemon_restart",
            layer: "scheduler",
        });
        j.append({
            kind: "ItemState",
            arm: "a",
            scenario_ms: 0,
            daemon_exit: { signal: "SIGTERM" },
            expected: true,
            fatal: false,
        });
        j.close();
        const inner = fakeDriver([]);
        let exit: unknown = "none";
        const driver: ArmDriver = {
            ...inner,
            bind: (h) => {
                inner.bind(h);
                try {
                    h.daemonExited({ signal: "SIGSEGV" });
                    exit = "accepted";
                } catch (caught) {
                    exit = caught;
                }
            },
        };
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [restart],
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: driver },
            }).run(),
        ).rejects.toThrow(HarnessFailure);
        expect(exit).toBeInstanceOf(HarnessFailure);
    });

    test("a corrupt arm is refused before ResumeRun is written, and a turn entry must name a user turn", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(1), []),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: "e-000000" });
        j.append({ kind: "EndTurn", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
        j.close();
        const reopened = new Journal(path);
        const n = reopened.entries.length;
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [],
                journal: reopened,
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run(),
        ).rejects.toThrow(/is not a user turn/);
        expect(reopened.entries).toHaveLength(n);
    });

    test("fault evidence closes the live outage window", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        let handle: ArmHandle | null = null;
        let late: unknown = "none";
        const driver: ArmDriver = {
            ...fakeDriver([]),
            bind: (h) => {
                handle = h;
            },
            event: async (e) => {
                if (e.kind === "session_start") {
                    try {
                        handle?.daemonExited({ signal: "SIGSEGV" });
                        late = "accepted";
                    } catch (caught) {
                        late = caught;
                    }
                }
                return {};
            },
            fault: async () => ({ restarted_by: "harness" }),
        };
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [restart],
                journal: j,
                settleMs: 0,
                order: ["a"],
                drivers: { a: driver },
            }).run(),
        ).rejects.toThrow(HarnessFailure);
        expect(late).toBeInstanceOf(HarnessFailure);
    });

    test("an apply_diff before a session does not open it for summarizer observations", async () => {
        const kill = episode("k", "daemon_sigkill_mid_fold", {
            kind: "first_summarizer_call",
            session: "s-0001",
        });
        const events: ScenarioEvent[] = [
            { id: "e-000000", kind: "session_start", scenario_ms: 0, session: "s-0000" },
            { id: "e-000001", kind: "session_end", scenario_ms: 0, session: "s-0000" },
            { id: "e-100000", kind: "apply_diff", scenario_ms: 100, session: "s-0001" },
            { id: "e-100001", kind: "session_start", scenario_ms: 100, session: "s-0001" },
            { id: "e-100002", kind: "session_end", scenario_ms: 100, session: "s-0001" },
        ];
        const j = new Journal(join(dir(), "j.jsonl"));
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            ...fakeDriver([]),
            bind: (h) => {
                handle = h;
            },
            event: async (e) => {
                if (e.kind === "apply_diff") handle?.observe("history_summarizer");
                return {};
            },
        };
        await new Scheduler({
            events,
            faults: [kill],
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: { a: driver },
        }).run();
        expect(j.entries.filter((e) => e.kind === "FaultFired")).toEqual([]);
        expect(j.entries.filter((e) => e.fault === "k").map((e) => [e.kind, e.state])).toEqual([
            ["ItemState", "missed"],
        ]);
        await new Scheduler({
            events,
            faults: [kill],
            journal: new Journal(j.path),
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
    });

    test("a completed journal with a reversed turn lifecycle, or arm entries before StartRun, is refused", async () => {
        const base = (path: string, withStart: boolean) => {
            const j = new Journal(path);
            if (withStart)
                j.append({
                    kind: "StartRun",
                    arm: null,
                    scenario_ms: 0,
                    order: ["a"],
                    scenario: scenarioId(fixtureEvents(1), []),
                });
            j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
            j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
            return j;
        };
        const make = (path: string) =>
            new Scheduler({
                events: fixtureEvents(1),
                faults: [],
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            });
        const reversed = join(dir(), "j.jsonl");
        const j = base(reversed, true);
        j.append({ kind: "EndTurn", arm: "a", scenario_ms: 0, event: "e-000001", outcome: "ok" });
        j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: "e-000001" });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000001", outcome: "ok" });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-999999", outcome: "ok" });
        j.append({ kind: "EndArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "EndRun", arm: null, scenario_ms: 0 });
        j.close();
        await expect(make(reversed).run()).rejects.toThrow(/has no BeginTurn/);
        const headless = join(dir(), "j.jsonl");
        base(headless, false).close();
        await expect(make(headless).run()).rejects.toThrow(/StartRun is not the first entry/);
        const late = join(dir(), "j.jsonl");
        const l = base(late, false);
        l.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(1), []),
        });
        l.close();
        await expect(make(late).run()).rejects.toThrow(/StartRun is not the first entry/);
    });

    test("a lease with a namespace this contender lacks, or vice versa, is treated as alive", () => {
        const d = dir();
        const mine = takeLease(d);
        releaseLease(d, mine);
        const dead = Bun.spawnSync(["true"]).pid;
        writeFileSync(
            join(d, "lease.0.json"),
            JSON.stringify({ ...mine, pid: dead, ns: undefined, released: undefined, token: "x" }),
        );
        expect(() => takeLease(d)).toThrow(/is leased by pid/);
    });

    test("an interrupted outage fault closes the window, so an exit during the resumed arm's first event is unexpected", async () => {
        const path = join(dir(), "j.jsonl");
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(2), [restart]),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({
            kind: "FaultFired",
            arm: "a",
            scenario_ms: 0,
            fault: "r",
            type: "daemon_restart",
            layer: "scheduler",
        });
        j.close();
        const inner = fakeDriver([]);
        const driver: ArmDriver = {
            ...inner,
            bind: (h) => {
                inner.bind(h);
                setTimeout(() => {
                    try {
                        h.daemonExited({ signal: "SIGSEGV" });
                    } catch {}
                }, 10);
            },
            event: async () => {
                await Bun.sleep(40);
                return {};
            },
        };
        const resumed = new Journal(path);
        await expect(
            new Scheduler({
                events: fixtureEvents(2),
                faults: [restart],
                journal: resumed,
                settleMs: 50,
                order: ["a"],
                drivers: { a: driver },
            }).run(),
        ).rejects.toThrow(HarnessFailure);
    });

    test("a fatal exit inside a live turn's settle window refuses the run before its Event", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            ...fakeDriver([]),
            bind: (h) => {
                handle = h;
            },
            event: async (e) => {
                if (e.kind === "user_turn") {
                    setTimeout(() => {
                        try {
                            handle?.daemonExited({ signal: "SIGSEGV" });
                        } catch {}
                    }, 10);
                }
                return {};
            },
        };
        const started = performance.now();
        await expect(
            new Scheduler({
                events: fixtureEvents(2),
                faults: [],
                journal: j,
                settleMs: 2_000,
                order: ["a"],
                drivers: { a: driver },
            }).run(),
        ).rejects.toThrow(HarnessFailure);
        expect(performance.now() - started).toBeLessThan(1_000);
        expect(j.entries.filter((e) => e.kind === "Event").map((e) => e.event)).toEqual([
            "e-000000",
        ]);
    });

    test("an arm whose EndArm precedes its events is refused, completed run or not", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(1), []),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "EndArm", arm: "a", scenario_ms: 0 });
        for (const e of fixtureEvents(1)) {
            j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: e.id, outcome: "ok" });
        }
        j.append({ kind: "EndRun", arm: null, scenario_ms: 0 });
        j.close();
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [],
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run(),
        ).rejects.toThrow(/EndArm before its events completed/);
    });

    test("a resume restores fired faults before binding, so a synchronous observation fires no second kill", async () => {
        const path = join(dir(), "j.jsonl");
        const kill = episode("k", "daemon_sigkill_mid_fold", {
            kind: "first_summarizer_call",
            session: "s-0000",
        });
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(2), [kill]),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
        j.append({
            kind: "FaultFired",
            arm: "a",
            scenario_ms: 0,
            fault: "k",
            type: "daemon_sigkill_mid_fold",
            layer: "scheduler",
        });
        j.append({
            kind: "FaultObserved",
            arm: "a",
            scenario_ms: 0,
            fault: "k",
            type: "daemon_sigkill_mid_fold",
            evidence: {},
        });
        j.close();
        let faults = 0;
        const inner = fakeDriver([]);
        const driver: ArmDriver = {
            ...inner,
            bind: (h) => {
                inner.bind(h);
                h.observe("history_summarizer");
            },
            fault: async () => {
                faults++;
                return {};
            },
        };
        const resumed = new Journal(path);
        await new Scheduler({
            events: fixtureEvents(2),
            faults: [kill],
            journal: resumed,
            settleMs: 0,
            order: ["a"],
            drivers: { a: driver },
        }).run();
        expect(faults).toBe(0);
        expect(resumed.entries.filter((e) => e.kind === "FaultFired")).toHaveLength(1);
    });

    test("a proxy fault is disarmed when its FaultFired cannot be journaled", async () => {
        const calls: string[] = [];
        const proxy = {
            arm: (id: string) => void calls.push(`arm ${id}`),
            disarm: (id: string) => void calls.push(`disarm ${id}`),
            reset: () => undefined,
        };
        const inner = new Journal(join(dir(), "j.jsonl"));
        const journal = new Proxy(inner, {
            get(target, key, receiver) {
                if (key === "append") {
                    return (entry: Entry) => {
                        if (entry.kind === "FaultFired") throw new Error("ENOSPC");
                        return target.append(entry);
                    };
                }
                return Reflect.get(target, key, receiver);
            },
        });
        await expect(
            new Scheduler({
                events: fixtureEvents(2),
                faults: [
                    episode("p1", "provider_429", { kind: "user_turn", session: "s-0000", n: 1 }),
                ],
                journal,
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
                proxy,
            }).run(),
        ).rejects.toThrow("ENOSPC");
        expect(calls).toEqual(["arm p1", "disarm p1", "disarm p1"]);
    });

    test("a journal over the size bound is refused before it is read", () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({ kind: "StartRun", arm: null, scenario_ms: 0, order: ["a"], scenario: "s" });
        j.close();
        const fd = openSync(path, "r+");
        ftruncateSync(fd, MAX_JOURNAL_BYTES + 1);
        closeSync(fd);
        expect(() => new Journal(path)).toThrow(/over the .* limit/);
        expect(() => readJournal(path)).toThrow(/over the .* limit/);
    });

    test("an append that would carry the journal over the size bound is refused and leaves the file whole", () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        j.append({ kind: "StartRun", arm: null, scenario_ms: 0, order: ["a"], scenario: "s" });
        const big = "x".repeat(MAX_JOURNAL_BYTES);
        expect(() => j.append({ kind: "StartArm", arm: "a", scenario_ms: 0, note: big })).toThrow(
            /over the .* limit/,
        );
        expect(j.entries).toHaveLength(1);
        j.close();
        expect(readJournal(j.path)).toHaveLength(1);
    });

    test("a lease fixes the directory identity its journal must open inside", () => {
        const leased = dir();
        const other = dir();
        const link = join(dir(), "run");
        symlinkSync(leased, link);
        const lease = takeLease(link);
        expect(lease.within).toEqual(directoryIdentity(leased));
        rmSync(link);
        symlinkSync(other, link);
        expect(() => new Journal(join(link, "j.jsonl"), lease.within)).toThrow(
            /would open outside its run directory/,
        );
        releaseLease(leased, lease);
    });

    test("lease operations resolve the run directory once, so a link repointed mid-way touches nothing else", () => {
        const leased = dir();
        const other = dir();
        const link = join(dir(), "run");
        symlinkSync(leased, link);
        const lease = takeLease(link);
        rmSync(link);
        symlinkSync(other, link);
        releaseLease(link, lease);
        expect(readdirSync(other)).toEqual([]);
        expect(readdirSync(leased)).toEqual(["lease.0.json"]);
        expect(
            JSON.parse(readFileSync(join(leased, "lease.0.json"), "utf8")).released,
        ).toBeUndefined();
        releaseLease(leased, lease);
        expect(JSON.parse(readFileSync(join(leased, "lease.0.json"), "utf8")).released).toBe(true);
    });

    test("a journal opens only inside the directory its lease named", () => {
        const leased = dir();
        const other = dir();
        const link = join(dir(), "run");
        symlinkSync(leased, link);
        const identity = directoryIdentity(leased);
        const j = new Journal(join(link, "j.jsonl"), identity);
        j.close();
        rmSync(link);
        symlinkSync(other, link);
        expect(() => new Journal(join(link, "j.jsonl"), identity)).toThrow(
            /would open outside its run directory/,
        );
        expect(existsSync(join(other, "j.jsonl"))).toBe(false);
        expect(() => new Journal(join(other, "j.jsonl"), directoryIdentity(other))).not.toThrow();
    });

    test("a lease-shaped file with a noncanonical number is corrupt, whatever its spelling", () => {
        for (const name of ["lease.-1.json", "lease.1e0.json", "lease.01.json"]) {
            const d = dir();
            writeFileSync(join(d, name), "{}");
            expect(() => takeLease(d)).toThrow(/no canonical number/);
        }
    });

    test("journals with evidence after EndRun, a turn Event without EndTurn, out-of-order Events, an orphan EndJob, or a FaultFired away from its trigger are refused", async () => {
        const open = (lines: Partial<Entry>[], faults: FaultEpisode[] = []) => {
            const path = join(dir(), "j.jsonl");
            const j = new Journal(path);
            j.append({
                kind: "StartRun",
                arm: null,
                scenario_ms: 0,
                order: ["a"],
                scenario: scenarioId(fixtureEvents(1), faults),
            });
            j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
            for (const l of lines) j.append({ arm: "a", scenario_ms: 0, ...l } as never);
            j.close();
            return new Scheduler({
                events: fixtureEvents(1),
                faults,
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run();
        };
        const ev = (event: string) => ({ kind: "Event", event, outcome: "ok" }) as const;
        const all = fixtureEvents(1).map((e) => e.id);
        await expect(
            open([
                { kind: "EndRun", arm: null } as never,
                ev(all[0] as string),
                { kind: "BeginTurn", event: all[1] },
                { kind: "EndTurn", event: all[1], outcome: "ok" },
                ev(all[1] as string),
                ev(all[2] as string),
                { kind: "EndArm" },
            ]),
        ).rejects.toThrow(/entries follow EndRun/);
        await expect(open([ev(all[0] as string), ev(all[1] as string)])).rejects.toThrow(
            /has no EndTurn/,
        );
        await expect(open([ev(all[2] as string)])).rejects.toThrow(/out of scenario order/);
        await expect(open([{ kind: "EndJob", job: "j" }])).rejects.toThrow(/has no RegisterJob/);
        await expect(
            open([
                { kind: "EndJob", job: "j" },
                { kind: "RegisterJob", job: "j" },
            ]),
        ).rejects.toThrow(/has no RegisterJob/);
        const late = episode("l", "daemon_restart", { kind: "user_turn", session: "s-0000", n: 1 });
        await expect(
            open(
                [{ kind: "FaultFired", fault: "l", type: "daemon_restart", layer: "scheduler" }],
                [late],
            ),
        ).rejects.toThrow(/away from its trigger/);
    });

    test("a daemon exit whose journal append fails is fatal even when a watcher swallows the throw", async () => {
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        const inner = new Journal(join(dir(), "j.jsonl"));
        const journal = new Proxy(inner, {
            get(target, key, receiver) {
                if (key === "append") {
                    return (entry: Entry) => {
                        if (entry.kind === "ItemState" && entry.daemon_exit !== undefined) {
                            throw new Error("ENOSPC");
                        }
                        return target.append(entry);
                    };
                }
                return Reflect.get(target, key, receiver);
            },
        });
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            ...fakeDriver([]),
            bind: (h) => {
                handle = h;
            },
            fault: async () => {
                try {
                    handle?.daemonExited({ signal: "SIGTERM" });
                } catch {}
                return { restarted_by: "harness" };
            },
        };
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [restart],
                journal,
                settleMs: 0,
                order: ["a"],
                drivers: { a: driver },
            }).run(),
        ).rejects.toThrow(HarnessFailure);
        expect(inner.entries.map((e) => e.kind)).not.toContain("EndRun");
    });

    test("journals with a mis-positioned missed sleep, a stray fault-tagged jump, reversed arms, evidence before StartArm, a stray interruption marker, a repeated BeginTurn, a ResumeRun naming another run, an early Event, an EndArm over an open job, or a daemon exit outside an outage are refused", async () => {
        const sleep = {
            ...episode("z", "laptop_sleep", { kind: "session_start", session: "s-0000" }),
            params: { duration_ms: 50 },
        };
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        const events = fixtureEvents(1);
        const all = events.map((e) => e.id);
        const open = (
            lines: Partial<Entry>[],
            order = ["a"],
            arms = true,
            faults: FaultEpisode[] = [],
        ) => {
            const path = join(dir(), "j.jsonl");
            const j = new Journal(path);
            j.append({
                kind: "StartRun",
                arm: null,
                scenario_ms: 0,
                order,
                scenario: scenarioId(events, faults),
            });
            if (arms) j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
            for (const l of lines) j.append({ arm: "a", scenario_ms: 0, ...l } as never);
            j.close();
            return new Scheduler({
                events,
                faults,
                journal: new Journal(path),
                settleMs: 0,
                order,
                drivers: { a: fakeDriver([]), b: fakeDriver([]) },
            }).run();
        };
        const ev = (event: string, scenario_ms = 0): Partial<Entry> => ({
            kind: "Event",
            event,
            outcome: "ok",
            scenario_ms,
        });
        const turn = (event: string): Partial<Entry>[] => [
            { kind: "BeginTurn", event },
            { kind: "EndTurn", event, outcome: "ok" },
        ];
        const sleepy = [sleep, restart];
        await expect(
            open(
                [ev(all[0] as string), { kind: "ItemState", fault: "z", state: "missed" }],
                ["a"],
                true,
                sleepy,
            ),
        ).rejects.toThrow(/fault z passed its trigger unhandled/);
        await expect(
            open([{ kind: "ItemState", fault: "r", state: "missed" }], ["a"], true, sleepy),
        ).rejects.toThrow(/missed r away from its place/);
        await expect(
            open(
                [{ kind: "AdvanceClock", fault: "r", from_ms: -1, busy: [] }],
                ["a"],
                true,
                sleepy,
            ),
        ).rejects.toThrow(/AdvanceClock for r is away from its sleep/);
        await expect(open([{ kind: "StartArm", arm: "b" }], ["a", "b"], false)).rejects.toThrow(
            /StartArm for b out of arm order/,
        );
        await expect(open([ev(all[0] as string)], ["a"], false)).rejects.toThrow(
            /Event for arm a outside its arm/,
        );
        await expect(
            open([
                ev(all[0] as string),
                { kind: "ItemState", event: all[1], state: "failed(interrupted)" },
                ev(all[1] as string),
            ]),
        ).rejects.toThrow(/interruption of e-000001 closes no open turn/);
        await expect(
            open([
                ev(all[0] as string),
                { kind: "BeginTurn", event: all[1] },
                { kind: "BeginTurn", event: all[1] },
            ]),
        ).rejects.toThrow(/BeginTurn for e-000001 repeats/);
        await expect(
            open([
                {
                    kind: "ResumeRun",
                    arm: null,
                    order: ["b"],
                    scenario: scenarioId(events, []),
                },
            ]),
        ).rejects.toThrow(/run was started with arm order/);
        await expect(
            open([
                ev(all[0] as string),
                ...turn(all[1] as string),
                ev(all[1] as string),
                ev(all[2] as string, 0),
            ]),
        ).rejects.toThrow(/Event for e-999999 precedes its schedule/);
        await expect(
            open([
                ev(all[0] as string),
                ...turn(all[1] as string),
                ev(all[1] as string),
                { kind: "RegisterJob", job: "j" },
                { kind: "Event", event: all[2], outcome: "ok", scenario_ms: 60_000 },
                { kind: "EndArm", scenario_ms: 60_000 },
            ]),
        ).rejects.toThrow(/EndArm with jobs open/);
        await expect(
            open([
                {
                    kind: "ItemState",
                    daemon_exit: { signal: "SIGTERM" },
                    expected: true,
                    fatal: false,
                },
            ]),
        ).rejects.toThrow(/daemon exit outside a replayed outage window/);
    });

    test("a job whose RegisterJob append fails is fatal even when the caller swallows the throw", async () => {
        const inner = new Journal(join(dir(), "j.jsonl"));
        const journal = new Proxy(inner, {
            get(target, key, receiver) {
                if (key === "append") {
                    return (entry: Entry) => {
                        if (entry.kind === "RegisterJob") throw new Error("ENOSPC");
                        return target.append(entry);
                    };
                }
                return Reflect.get(target, key, receiver);
            },
        });
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            ...fakeDriver([]),
            bind: (h) => {
                handle = h;
            },
            event: async (e) => {
                if (e.kind === "user_turn") {
                    try {
                        handle?.jobStart("fold");
                    } catch {
                        return {};
                    }
                }
                return {};
            },
        };
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [],
                journal,
                settleMs: 0,
                order: ["a"],
                drivers: { a: driver },
            }).run(),
        ).rejects.toThrow(HarnessFailure);
        expect(inner.entries.map((e) => e.kind)).not.toContain("EndRun");
    });

    test("journals with a run record in arm scope, an unhandled scheduled fault at EndArm, a jump while busy, a sleep fired without its jump, a missed sleep after its jump, an Event contradicting its EndTurn, or a job registered twice are refused", async () => {
        const turnFault = episode("t", "daemon_restart", {
            kind: "user_turn",
            session: "s-0000",
            n: 1,
        });
        const events = fixtureEvents(1);
        const all = events.map((e) => e.id);
        const open = (lines: Partial<Entry>[], faults: FaultEpisode[] = [], within = events) => {
            const path = join(dir(), "j.jsonl");
            const j = new Journal(path);
            j.append({
                kind: "StartRun",
                arm: null,
                scenario_ms: 0,
                order: ["a"],
                scenario: scenarioId(within, faults),
            });
            j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
            for (const l of lines) j.append({ arm: "a", scenario_ms: 0, ...l } as never);
            j.close();
            return new Scheduler({
                events: within,
                faults,
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run();
        };
        const ev = (event: string, outcome = "ok", scenario_ms = 0): Partial<Entry> => ({
            kind: "Event",
            event,
            outcome,
            scenario_ms,
        });
        const e0 = all[0] as string;
        const e1 = all[1] as string;
        const e2 = all[2] as string;
        const turn = (outcome = "ok"): Partial<Entry>[] => [
            { kind: "BeginTurn", event: e1 },
            { kind: "EndTurn", event: e1, outcome },
        ];
        await expect(
            open([{ kind: "ResumeRun", arm: "a", order: ["a"], scenario: scenarioId(events, []) }]),
        ).rejects.toThrow(/ResumeRun carries an arm scope/);
        await expect(
            open([ev(e0), ...turn(), ev(e1), ev(e2, "ok", 60_000)], [turnFault]),
        ).rejects.toThrow(/BeginTurn for e-000001 before fault t fired/);
        const startFault = episode("s", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        await expect(open([ev(e0)], [startFault])).rejects.toThrow(
            /fault s passed its trigger unhandled/,
        );
        await expect(
            open([
                ev(e0),
                { kind: "RegisterJob", job: "j" },
                { kind: "AdvanceClock", from_ms: 0, scenario_ms: 60_000, next_event: e2, busy: [] },
            ]),
        ).rejects.toThrow(/AdvanceClock while the clock is busy/);
        const later: ScenarioEvent[] = [
            ...events,
            { id: "e-100000", kind: "session_start", scenario_ms: 120_000, session: "s-0001" },
            { id: "e-100001", kind: "session_end", scenario_ms: 120_000, session: "s-0001" },
        ];
        const nap = {
            ...episode("z", "laptop_sleep", { kind: "session_start", session: "s-0001" }),
            params: { duration_ms: 50 },
        };
        const toSecond: Partial<Entry>[] = [
            ev(e0),
            ...turn(),
            ev(e1),
            { kind: "AdvanceClock", from_ms: 0, scenario_ms: 60_000, next_event: e2, busy: [] },
            ev(e2, "ok", 60_000),
        ];
        const jump: Partial<Entry> = {
            kind: "AdvanceClock",
            from_ms: 60_000,
            scenario_ms: 120_000,
            fault: "z",
            busy: [],
        };
        await expect(
            open(
                [
                    ...toSecond,
                    {
                        kind: "FaultFired",
                        fault: "z",
                        type: "laptop_sleep",
                        layer: "clock",
                        scenario_ms: 60_000,
                    },
                ],
                [nap],
                later,
            ),
        ).rejects.toThrow(/FaultFired for sleep z has no jump/);
        await expect(
            open(
                [
                    ...toSecond,
                    jump,
                    { kind: "ItemState", fault: "z", state: "missed", scenario_ms: 120_000 },
                ],
                [nap],
                later,
            ),
        ).rejects.toThrow(/missed z away from its place/);
        await expect(open([ev(e0), ...turn("failed"), ev(e1, "ok")])).rejects.toThrow(
            /Event for e-000001 contradicts its EndTurn outcome/,
        );
        await expect(
            open([ev(e0), { kind: "RegisterJob", job: "j" }, { kind: "RegisterJob", job: "j" }]),
        ).rejects.toThrow(/RegisterJob for j while it is open/);
    });

    test("a job whose EndJob append fails is fatal even when the caller swallows the throw", async () => {
        const inner = new Journal(join(dir(), "j.jsonl"));
        const journal = new Proxy(inner, {
            get(target, key, receiver) {
                if (key === "append") {
                    return (entry: Entry) => {
                        if (entry.kind === "EndJob") throw new Error("ENOSPC");
                        return target.append(entry);
                    };
                }
                return Reflect.get(target, key, receiver);
            },
        });
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            ...fakeDriver([]),
            bind: (h) => {
                handle = h;
            },
            event: async (e) => {
                if (e.kind === "user_turn") {
                    handle?.jobStart("fold");
                    try {
                        handle?.jobEnd("fold");
                    } catch {
                        return {};
                    }
                }
                return {};
            },
        };
        const started = performance.now();
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [],
                journal,
                settleMs: 0,
                order: ["a"],
                drivers: { a: driver },
            }).run(),
        ).rejects.toThrow(HarnessFailure);
        expect(performance.now() - started).toBeLessThan(5_000);
        expect(inner.entries.map((e) => e.kind)).not.toContain("EndRun");
    });

    test("a fresh arm's handle is bound after reset and StartArm, so reset-time work cannot precede the arm", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        const order: string[] = [];
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            ...fakeDriver([]),
            bind: (h) => {
                handle = h;
                order.push(`bind:${j.entries.map((e) => e.kind).join(",")}`);
            },
            reset: async () => {
                order.push(`reset:${handle === null ? "unbound" : "bound"}`);
            },
        };
        await new Scheduler({
            events: fixtureEvents(1),
            faults: [],
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: { a: driver },
        }).run();
        expect(order).toEqual(["reset:unbound", "bind:StartRun,StartArm"]);
        await new Scheduler({
            events: fixtureEvents(1),
            faults: [],
            journal: new Journal(j.path),
            settleMs: 0,
            order: ["a"],
            drivers: { a: driver },
        }).run();
    });

    test("journals with a StartArm past zero, a fired scheduler fault without terminal evidence at EndArm, or a jump starting behind the clock are refused", async () => {
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        const events = fixtureEvents(1);
        const [e0, e1, e2] = events.map((e) => e.id) as [string, string, string];
        const open = (lines: Partial<Entry>[], faults: FaultEpisode[] = [], startMs = 0) => {
            const path = join(dir(), "j.jsonl");
            const j = new Journal(path);
            j.append({
                kind: "StartRun",
                arm: null,
                scenario_ms: 0,
                order: ["a"],
                scenario: scenarioId(events, faults),
            });
            j.append({ kind: "StartArm", arm: "a", scenario_ms: startMs });
            for (const l of lines) j.append({ arm: "a", scenario_ms: startMs, ...l } as never);
            j.close();
            return new Scheduler({
                events,
                faults,
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run();
        };
        const ev = (event: string, scenario_ms = 0): Partial<Entry> => ({
            kind: "Event",
            event,
            outcome: "ok",
            scenario_ms,
        });
        await expect(open([], [], 5)).rejects.toThrow(/StartArm for a starts past zero/);
        await expect(
            open(
                [
                    { kind: "FaultFired", fault: "r", type: "daemon_restart", layer: "scheduler" },
                    ev(e0),
                    { kind: "BeginTurn", event: e1 },
                    { kind: "EndTurn", event: e1, outcome: "ok" },
                    ev(e1),
                    ev(e2, 60_000),
                    { kind: "EndArm", scenario_ms: 60_000 },
                    { kind: "EndRun", arm: null, scenario_ms: 0 } as never,
                ],
                [restart],
            ),
        ).rejects.toThrow(/Event for e-000000 while fault r is unresolved/);
        await expect(
            open([
                ev(e0),
                { kind: "BeginTurn", event: e1 },
                { kind: "EndTurn", event: e1, outcome: "ok", scenario_ms: 500 },
                ev(e1, 500),
                { kind: "AdvanceClock", from_ms: 0, scenario_ms: 60_000, next_event: e2, busy: [] },
            ]),
        ).rejects.toThrow(/AdvanceClock starts away from the clock/);
    });

    test("a resume closes the journal's open jobs before binding, so a bind-time registration of the same id is valid", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(1), []),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
        j.append({ kind: "RegisterJob", arm: "a", scenario_ms: 0, job: "fold" });
        j.close();
        const inner = fakeDriver([]);
        const driver: ArmDriver = {
            ...inner,
            bind: (h) => {
                inner.bind(h);
                h.jobStart("fold");
                h.jobEnd("fold");
            },
        };
        const resumed = new Journal(path);
        await new Scheduler({
            events: fixtureEvents(1),
            faults: [],
            journal: resumed,
            settleMs: 0,
            order: ["a"],
            drivers: { a: driver },
        }).run();
        const jobs = resumed.entries.filter((e) => e.job === "fold").map((e) => e.kind);
        expect(jobs).toEqual(["RegisterJob", "EndJob", "RegisterJob", "EndJob"]);
        await new Scheduler({
            events: fixtureEvents(1),
            faults: [],
            journal: new Journal(path),
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
    });

    test("journals with an EndTurn lacking its outcome or misreporting its probe, a FaultFired or FaultObserved misreporting its episode, or a FaultObserved without evidence are refused; a repeated arm name is refused before StartRun", async () => {
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        const probed: ScenarioEvent[] = fixtureEvents(1).map((e) =>
            e.kind === "user_turn" ? { ...e, probe: "p-1" } : e,
        );
        const [e0, e1] = probed.map((e) => e.id) as [string, string];
        const open = (lines: Partial<Entry>[], faults: FaultEpisode[] = [], events = probed) => {
            const path = join(dir(), "j.jsonl");
            const j = new Journal(path);
            j.append({
                kind: "StartRun",
                arm: null,
                scenario_ms: 0,
                order: ["a"],
                scenario: scenarioId(events, faults),
            });
            j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
            for (const l of lines) j.append({ arm: "a", scenario_ms: 0, ...l } as never);
            j.close();
            return new Scheduler({
                events,
                faults,
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run();
        };
        const ev: Partial<Entry> = { kind: "Event", event: e0, outcome: "ok" };
        await expect(
            open([
                ev,
                { kind: "BeginTurn", event: e1, probe: "p-1" },
                { kind: "EndTurn", event: e1 },
            ]),
        ).rejects.toThrow(/EndTurn for e-000001 has no outcome/);
        await expect(
            open([
                ev,
                { kind: "BeginTurn", event: e1, probe: "p-1" },
                { kind: "EndTurn", event: e1, outcome: "ok", probe: "p-1", state: "failed" },
            ]),
        ).rejects.toThrow(/EndTurn for e-000001 misreports its probe/);
        await expect(
            open(
                [{ kind: "FaultFired", fault: "r", type: "host_upgrade", layer: "scheduler" }],
                [restart],
            ),
        ).rejects.toThrow(/FaultFired for r misreports its episode/);
        await expect(
            open(
                [
                    { kind: "FaultFired", fault: "r", type: "daemon_restart", layer: "scheduler" },
                    { kind: "FaultObserved", fault: "r", type: "daemon_restart" },
                ],
                [restart],
            ),
        ).rejects.toThrow(/FaultObserved for r carries no evidence/);
        await expect(
            open(
                [
                    { kind: "FaultFired", fault: "r", type: "daemon_restart", layer: "scheduler" },
                    { kind: "FaultObserved", fault: "r", type: "host_upgrade", evidence: {} },
                ],
                [restart],
            ),
        ).rejects.toThrow(/FaultObserved for r misreports its type/);
        const j = new Journal(join(dir(), "j.jsonl"));
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [],
                journal: j,
                settleMs: 0,
                order: ["a", "a"],
                drivers: { a: fakeDriver([]) },
            }).run(),
        ).rejects.toThrow(/repeats an arm/);
        expect(j.entries).toHaveLength(0);
    });

    test("journals with a BeginTurn while a job is open or before its schedule are refused, and a driver's non-object fault evidence fails the run", async () => {
        const events = fixtureEvents(1);
        const [e0, e1] = events.map((e) => e.id) as [string, string];
        const open = (lines: Partial<Entry>[]) => {
            const path = join(dir(), "j.jsonl");
            const j = new Journal(path);
            j.append({
                kind: "StartRun",
                arm: null,
                scenario_ms: 0,
                order: ["a"],
                scenario: scenarioId(events, []),
            });
            j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
            for (const l of lines) j.append({ arm: "a", scenario_ms: 0, ...l } as never);
            j.close();
            return new Scheduler({
                events,
                faults: [],
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run();
        };
        const ev: Partial<Entry> = { kind: "Event", event: e0, outcome: "ok" };
        await expect(
            open([ev, { kind: "RegisterJob", job: "j" }, { kind: "BeginTurn", event: e1 }]),
        ).rejects.toThrow(/BeginTurn for e-000001 while job j is open/);
        const late = fixtureEvents(1).map((e) =>
            e.kind === "user_turn" ? { ...e, scenario_ms: 500 } : e,
        );
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(late, []),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: e0, outcome: "ok" });
        j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: e1 });
        j.close();
        await expect(
            new Scheduler({
                events: late,
                faults: [],
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run(),
        ).rejects.toThrow(/BeginTurn for e-000001 precedes its schedule/);
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        const k = new Journal(join(dir(), "j.jsonl"));
        await expect(
            new Scheduler({
                events,
                faults: [restart],
                journal: k,
                settleMs: 0,
                order: ["a"],
                drivers: { a: { ...fakeDriver([]), fault: async () => null as never } },
            }).run(),
        ).rejects.toThrow(/fault evidence is null/);
        expect(k.entries.find((e) => e.kind === "ItemState")).toMatchObject({
            fault: "r",
            state: "failed",
            fatal: true,
        });
        expect(k.entries.map((e) => e.kind)).not.toContain("FaultObserved");
    });

    test("journals whose stamps leave the replayed clock, or that begin a turn before its fault fired or resolved, are refused; a driver outcome off its shape fails the run; recovery resolves a fired kill before the interrupted turn's Event", async () => {
        const events = fixtureEvents(1);
        const [e0, e1, e2] = events.map((e) => e.id) as [string, string, string];
        const turnFault = episode("t", "daemon_restart", {
            kind: "user_turn",
            session: "s-0000",
            n: 1,
        });
        const open = (lines: Partial<Entry>[], faults: FaultEpisode[] = []) => {
            const path = join(dir(), "j.jsonl");
            const j = new Journal(path);
            j.append({
                kind: "StartRun",
                arm: null,
                scenario_ms: 0,
                order: ["a"],
                scenario: scenarioId(events, faults),
            });
            j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
            for (const l of lines) j.append({ arm: "a", scenario_ms: 0, ...l } as never);
            j.close();
            return new Scheduler({
                events,
                faults,
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run();
        };
        const ev = (event: string, scenario_ms = 0): Partial<Entry> => ({
            kind: "Event",
            event,
            outcome: "ok",
            scenario_ms,
        });
        const fired: Partial<Entry> = {
            kind: "FaultFired",
            fault: "t",
            type: "daemon_restart",
            layer: "scheduler",
        };
        await expect(
            open([
                ev(e0),
                { kind: "BeginTurn", event: e1 },
                { kind: "EndTurn", event: e1, outcome: "ok" },
                ev(e1),
                ev(e2, 60_000),
            ]),
        ).rejects.toThrow(/Event is stamped away from the replayed clock/);
        await expect(
            open([ev(e0), { kind: "BeginTurn", event: e1 }, fired], [turnFault]),
        ).rejects.toThrow(/BeginTurn for e-000001 before fault t fired/);
        await expect(
            open([ev(e0), fired, { kind: "BeginTurn", event: e1 }], [turnFault]),
        ).rejects.toThrow(/BeginTurn for e-000001 while fault t is unresolved/);
        for (const got of [{ failed: false }, "ok", [] as never]) {
            const j = new Journal(join(dir(), "j.jsonl"));
            await expect(
                new Scheduler({
                    events,
                    faults: [],
                    journal: j,
                    settleMs: 0,
                    order: ["a"],
                    drivers: { a: { ...fakeDriver([]), event: async () => got as never } },
                }).run(),
            ).rejects.toThrow(/driver outcome is/);
            expect(j.entries.map((e) => e.kind)).not.toContain("EndRun");
        }
        const kill = episode("k", "daemon_sigkill_mid_fold", {
            kind: "first_summarizer_call",
            session: "s-0000",
        });
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(events, [kill]),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: e0, outcome: "ok" });
        j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: e1 });
        j.append({
            kind: "FaultFired",
            arm: "a",
            scenario_ms: 0,
            fault: "k",
            type: "daemon_sigkill_mid_fold",
            layer: "scheduler",
        });
        j.close();
        const resumed = new Journal(path);
        await new Scheduler({
            events,
            faults: [kill],
            journal: resumed,
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
        const kinds = resumed.entries.map((e) => `${e.kind}:${e.fault ?? e.event ?? ""}`);
        expect(kinds.indexOf("ItemState:k")).toBeLessThan(kinds.indexOf(`Event:${e1}`));
        await new Scheduler({
            events,
            faults: [kill],
            journal: new Journal(path),
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
    });

    test("a job's registration and end share one clock sample with their records, so the writer's own journal replays across clock ticks", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            ...fakeDriver([]),
            bind: (h) => {
                handle = h;
            },
            event: async (e) => {
                if (e.kind === "user_turn") {
                    handle?.jobStart("fold");
                    setTimeout(() => handle?.jobEnd("fold"), 20);
                }
                return {};
            },
        };
        const realNow = performance.now.bind(performance);
        let tick = 1_000;
        performance.now = () => ++tick;
        try {
            await new Scheduler({
                events: fixtureEvents(1),
                faults: [],
                journal: j,
                settleMs: 60,
                order: ["a"],
                drivers: { a: driver },
            }).run();
        } finally {
            performance.now = realNow;
        }
        const endJob = j.entries.find((e) => e.kind === "EndJob") as Entry;
        const after = j.entries[j.entries.indexOf(endJob) + 1] as Entry;
        expect(after.scenario_ms).toBe(endJob.scenario_ms);
        await new Scheduler({
            events: fixtureEvents(1),
            faults: [],
            journal: new Journal(path),
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
    });

    test("journals with an Event lacking its outcome, or a FaultObserved after the fault's interruption, are refused; a malformed daemon-exit detail is refused before the window closes", async () => {
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        const events = fixtureEvents(1);
        const e0 = events[0]?.id as string;
        const open = (lines: Partial<Entry>[], faults: FaultEpisode[] = []) => {
            const path = join(dir(), "j.jsonl");
            const j = new Journal(path);
            j.append({
                kind: "StartRun",
                arm: null,
                scenario_ms: 0,
                order: ["a"],
                scenario: scenarioId(events, faults),
            });
            j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
            for (const l of lines) j.append({ arm: "a", scenario_ms: 0, ...l } as never);
            j.close();
            return new Scheduler({
                events,
                faults,
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run();
        };
        await expect(open([{ kind: "Event", event: e0 }])).rejects.toThrow(
            /Event for e-000000 has no outcome/,
        );
        await expect(
            open(
                [
                    { kind: "FaultFired", fault: "r", type: "daemon_restart", layer: "scheduler" },
                    { kind: "ItemState", fault: "r", state: "failed(interrupted)" },
                    { kind: "FaultObserved", fault: "r", type: "daemon_restart", evidence: {} },
                ],
                [restart],
            ),
        ).rejects.toThrow(/FaultObserved for r after its interruption/);
        const j = new Journal(join(dir(), "j.jsonl"));
        let handle: ArmHandle | null = null;
        let refused: unknown = null;
        const driver: ArmDriver = {
            ...fakeDriver([]),
            bind: (h) => {
                handle = h;
            },
            fault: async () => {
                try {
                    handle?.daemonExited(undefined as never);
                } catch (caught) {
                    refused = caught;
                }
                handle?.daemonExited({ signal: "SIGTERM" });
                return { restarted_by: "harness" };
            },
        };
        await new Scheduler({
            events,
            faults: [restart],
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: { a: driver },
        }).run();
        expect(String(refused)).toMatch(/daemon exit detail is undefined/);
        const exits = j.entries.filter((e) => e.kind === "ItemState");
        expect(exits).toHaveLength(1);
        expect(exits[0]).toMatchObject({ expected: true, fatal: false });
    });

    test("a fatal record that cannot be journaled poisons the run directory, so a later process refuses the journal", async () => {
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        const path = join(dir(), "j.jsonl");
        const inner = new Journal(path);
        const journal = new Proxy(inner, {
            get(target, key, receiver) {
                if (key === "append") {
                    return (entry: Entry) => {
                        if (entry.kind === "ItemState" && entry.fatal === true) {
                            throw new Error("ENOSPC");
                        }
                        return target.append(entry);
                    };
                }
                return Reflect.get(target, key, receiver);
            },
        });
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [restart],
                journal,
                settleMs: 0,
                order: ["a"],
                drivers: {
                    a: {
                        ...fakeDriver([]),
                        fault: async () => {
                            throw new Error("daemon never came back");
                        },
                    },
                },
            }).run(),
        ).rejects.toThrow(/daemon never came back/);
        expect(existsSync(`${path}.failed`)).toBe(true);
        expect(() => new Journal(path)).toThrow(HarnessFailure);
        expect(() => new Journal(path)).toThrow(/run failed: fault r failed/);
    });

    test("the driver boundary refuses the success literal as a failure, non-string job ids, and event mutation, and a turn fault that starts a job is quiesced before the turn", async () => {
        const events = fixtureEvents(1);
        const run = (driver: ArmDriver, faults: FaultEpisode[] = []) => {
            const j = new Journal(join(dir(), "j.jsonl"));
            return {
                j,
                done: new Scheduler({
                    events,
                    faults,
                    journal: j,
                    settleMs: 0,
                    order: ["a"],
                    drivers: { a: driver },
                }).run(),
            };
        };
        const okAsFailure = run({ ...fakeDriver([]), event: async () => ({ failed: "ok" }) });
        await expect(okAsFailure.done).rejects.toThrow(/the success literal/);
        let handle: ArmHandle | null = null;
        const badIds: string[] = [];
        const mutating = run({
            ...fakeDriver([]),
            bind: (h) => {
                handle = h;
            },
            event: async (e) => {
                if (e.kind === "user_turn") {
                    for (const id of [undefined, {}, ""]) {
                        try {
                            handle?.jobStart(id as never);
                        } catch (caught) {
                            badIds.push(String(caught));
                        }
                    }
                    (e as { id: string }).id = "e-mutated";
                }
                return {};
            },
        });
        await mutating.done;
        expect(badIds).toHaveLength(3);
        expect(badIds.every((m) => /job id is .* not a name/.test(m))).toBe(true);
        expect(mutating.j.entries.map((e) => e.event)).not.toContain("e-mutated");
        await new Scheduler({
            events,
            faults: [],
            journal: new Journal(mutating.j.path),
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
        const restart = episode("t", "daemon_restart", {
            kind: "user_turn",
            session: "s-0000",
            n: 1,
        });
        let h2: ArmHandle | null = null;
        const jobbing = run(
            {
                ...fakeDriver([]),
                bind: (h) => {
                    h2 = h;
                },
                fault: async () => {
                    h2?.jobStart("warm");
                    setTimeout(() => h2?.jobEnd("warm"), 30);
                    return { restarted_by: "harness" };
                },
            },
            [restart],
        );
        await jobbing.done;
        const kinds = jobbing.j.entries.map((e) => e.kind);
        expect(kinds.indexOf("EndJob")).toBeLessThan(kinds.indexOf("BeginTurn"));
        await new Scheduler({
            events,
            faults: [restart],
            journal: new Journal(jobbing.j.path),
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
    });

    test("replay refuses array evidence, a detail-less daemon exit, a jump naming no cause or both, and nameless jobs; an unjournalable observation poisons the run", async () => {
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        const events = fixtureEvents(1);
        const e0 = events[0]?.id as string;
        const open = (lines: Partial<Entry>[], faults: FaultEpisode[] = []) => {
            const path = join(dir(), "j.jsonl");
            const j = new Journal(path);
            j.append({
                kind: "StartRun",
                arm: null,
                scenario_ms: 0,
                order: ["a"],
                scenario: scenarioId(events, faults),
            });
            j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
            for (const l of lines) j.append({ arm: "a", scenario_ms: 0, ...l } as never);
            j.close();
            return new Scheduler({
                events,
                faults,
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run();
        };
        const fired: Partial<Entry> = {
            kind: "FaultFired",
            fault: "r",
            type: "daemon_restart",
            layer: "scheduler",
        };
        await expect(
            open(
                [
                    fired,
                    { kind: "FaultObserved", fault: "r", type: "daemon_restart", evidence: [] },
                ],
                [restart],
            ),
        ).rejects.toThrow(/FaultObserved for r carries no evidence/);
        await expect(
            open(
                [fired, { kind: "ItemState", daemon_exit: null, expected: true, fatal: false }],
                [restart],
            ),
        ).rejects.toThrow(/daemon exit carries no detail/);
        const toTurn: Partial<Entry>[] = [
            { kind: "Event", event: e0, outcome: "ok" },
            { kind: "BeginTurn", event: "e-000001" },
            { kind: "EndTurn", event: "e-000001", outcome: "ok" },
            { kind: "Event", event: "e-000001", outcome: "ok" },
        ];
        await expect(
            open([...toTurn, { kind: "AdvanceClock", from_ms: 0, scenario_ms: 60_000, busy: [] }]),
        ).rejects.toThrow(/names neither one sleep nor one event/);
        const later: ScenarioEvent[] = [
            ...events,
            { id: "e-100000", kind: "session_start", scenario_ms: 120_000, session: "s-0001" },
            { id: "e-100001", kind: "session_end", scenario_ms: 120_000, session: "s-0001" },
        ];
        const nap = {
            ...episode("z", "laptop_sleep", { kind: "session_start", session: "s-0001" }),
            params: { duration_ms: 50 },
        };
        const both = join(dir(), "j.jsonl");
        const k = new Journal(both);
        k.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(later, [nap]),
        });
        k.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        for (const l of toTurn) k.append({ arm: "a", scenario_ms: 0, ...l } as never);
        k.append({
            kind: "AdvanceClock",
            arm: "a",
            from_ms: 0,
            scenario_ms: 60_000,
            next_event: "e-999999",
            busy: [],
        });
        k.append({
            kind: "Event",
            arm: "a",
            scenario_ms: 60_000,
            event: "e-999999",
            outcome: "ok",
        });
        k.append({
            kind: "AdvanceClock",
            arm: "a",
            from_ms: 60_000,
            scenario_ms: 120_000,
            fault: "z",
            next_event: "e-100000",
            busy: [],
        });
        k.close();
        await expect(
            new Scheduler({
                events: later,
                faults: [nap],
                journal: new Journal(both),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run(),
        ).rejects.toThrow(/names neither one sleep nor one event/);
        await expect(open([{ kind: "RegisterJob" }, { kind: "EndJob" }])).rejects.toThrow(
            /RegisterJob names no job/,
        );
        await expect(open([{ kind: "EndJob", job: "" }])).rejects.toThrow(/EndJob names no job/);
        const path = join(dir(), "j.jsonl");
        const inner = new Journal(path);
        const journal = new Proxy(inner, {
            get(target, key, receiver) {
                if (key === "append") {
                    return (entry: Entry) => {
                        if (entry.kind === "FaultObserved") throw new Error("ENOSPC");
                        return target.append(entry);
                    };
                }
                return Reflect.get(target, key, receiver);
            },
        });
        await expect(
            new Scheduler({
                events,
                faults: [restart],
                journal,
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run(),
        ).rejects.toThrow(/ENOSPC/);
        expect(() => new Journal(path)).toThrow(
            /run failed: fault r evidence could not be journaled/,
        );
    });

    test("a failure marker is read through a validated descriptor and sits beside the file the kernel opened", () => {
        const leased = dir();
        const link = join(dir(), "run");
        symlinkSync(leased, link);
        const j = new Journal(join(link, "j.jsonl"));
        rmSync(link);
        symlinkSync(dir(), link);
        j.poison("marked through the link");
        expect(existsSync(join(leased, "j.jsonl.failed"))).toBe(true);
        expect(() => new Journal(join(leased, "j.jsonl"))).toThrow(/marked through the link/);
        const d = dir();
        const target = join(d, "j.jsonl");
        new Journal(target).close();
        symlinkSync(join(d, "elsewhere"), join(d, "j.jsonl.failed"));
        expect(() => new Journal(target)).toThrow(/failure marker .* cannot be opened/);
        rmSync(join(d, "j.jsonl.failed"));
        writeFileSync(join(d, "j.jsonl.failed"), "x".repeat(5_000));
        expect(() => new Journal(target)).toThrow(/is not a small regular file/);
    });

    test("an arm that aborts disarms every proxy fault, and poison refuses to write through a foreign marker inode", async () => {
        const calls: string[] = [];
        const proxy = {
            arm: (id: string) => void calls.push(`arm ${id}`),
            disarm: (id: string) => void calls.push(`disarm ${id}`),
            reset: () => undefined,
        };
        const slow = episode(
            "slow",
            "slow_stream",
            { kind: "user_turn", session: "s-0000", n: 1 },
            "persistent",
        );
        await expect(
            new Scheduler({
                events: fixtureEvents(2),
                faults: [slow],
                journal: new Journal(join(dir(), "j.jsonl")),
                settleMs: 0,
                order: ["a"],
                drivers: {
                    a: {
                        ...fakeDriver([]),
                        event: async (e) => {
                            if (e.kind === "user_turn" && e.index === 1)
                                throw new Error("driver gave up");
                            return {};
                        },
                    },
                },
                proxy,
            }).run(),
        ).rejects.toThrow(/driver gave up/);
        expect(calls).toEqual(["arm slow", "disarm slow"]);
        const d = dir();
        const path = join(d, "j.jsonl");
        const j = new Journal(path);
        const other = join(d, "unrelated.txt");
        writeFileSync(other, "keep me");
        linkSync(other, `${path}.failed`);
        expect(() => j.poison("boom")).toThrow(/is not this run's file/);
        expect(readFileSync(other, "utf8")).toBe("keep me");
    });

    test("fault evidence and exit details are judged by their serialized shape, and a session that never calls the summarizer records its kill as missed", async () => {
        const events = fixtureEvents(1);
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        const j = new Journal(join(dir(), "j.jsonl"));
        await expect(
            new Scheduler({
                events,
                faults: [restart],
                journal: j,
                settleMs: 0,
                order: ["a"],
                drivers: {
                    a: {
                        ...fakeDriver([]),
                        fault: async () => ({ toJSON: () => "not-object" }) as never,
                    },
                },
            }).run(),
        ).rejects.toThrow(/fault evidence is string/);
        expect(j.entries.map((e) => e.kind)).not.toContain("FaultObserved");
        let handle: ArmHandle | null = null;
        let refused: unknown = null;
        const k = new Journal(join(dir(), "j.jsonl"));
        await new Scheduler({
            events,
            faults: [restart],
            journal: k,
            settleMs: 0,
            order: ["a"],
            drivers: {
                a: {
                    ...fakeDriver([]),
                    bind: (h) => {
                        handle = h;
                    },
                    fault: async () => {
                        try {
                            handle?.daemonExited({ toJSON: () => [1] } as never);
                        } catch (caught) {
                            refused = caught;
                        }
                        handle?.daemonExited({ signal: "SIGTERM" });
                        return { restarted_by: "harness" };
                    },
                },
            },
        }).run();
        expect(String(refused)).toMatch(/daemon exit detail is an array/);
        const kill = episode("k", "daemon_sigkill_mid_fold", {
            kind: "first_summarizer_call",
            session: "s-0000",
        });
        const quiet = join(dir(), "j.jsonl");
        const q = new Journal(quiet);
        q.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(events, [kill]),
        });
        q.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        q.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
        q.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: "e-000001" });
        q.append({ kind: "EndTurn", arm: "a", scenario_ms: 0, event: "e-000001", outcome: "ok" });
        q.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000001", outcome: "ok" });
        q.append({
            kind: "AdvanceClock",
            arm: "a",
            scenario_ms: 60_000,
            from_ms: 0,
            next_event: "e-999999",
            busy: [],
        });
        q.append({
            kind: "Event",
            arm: "a",
            scenario_ms: 60_000,
            event: "e-999999",
            outcome: "ok",
        });
        q.append({ kind: "EndArm", arm: "a", scenario_ms: 60_000 });
        q.append({ kind: "EndRun", arm: null, scenario_ms: 0 });
        q.close();
        await expect(
            new Scheduler({
                events,
                faults: [kill],
                journal: new Journal(quiet),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run(),
        ).rejects.toThrow(/fault k passed its trigger unhandled/);
    });

    test("a turn whose delivery fails or whose EndTurn cannot be journaled leaves a run a later process refuses", async () => {
        const events = fixtureEvents(1);
        const rejecting = join(dir(), "j.jsonl");
        const j = new Journal(rejecting);
        await expect(
            new Scheduler({
                events,
                faults: [],
                journal: j,
                settleMs: 0,
                order: ["a"],
                drivers: {
                    a: {
                        ...fakeDriver([]),
                        event: async (e) => {
                            if (e.kind === "user_turn") throw new Error("driver crashed");
                            return {};
                        },
                    },
                },
            }).run(),
        ).rejects.toThrow(/driver crashed/);
        expect(j.entries.at(-1)).toMatchObject({
            kind: "ItemState",
            event: "e-000001",
            state: "failed",
            fatal: true,
        });
        await expect(
            new Scheduler({
                events,
                faults: [],
                journal: new Journal(rejecting),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run(),
        ).rejects.toThrow(/run failed: event e-000001 failed/);
        const unwritable = join(dir(), "j.jsonl");
        const inner = new Journal(unwritable);
        const journal = new Proxy(inner, {
            get(target, key, receiver) {
                if (key === "append") {
                    return (entry: Entry) => {
                        if (entry.kind === "EndTurn") throw new Error("ENOSPC");
                        return target.append(entry);
                    };
                }
                return Reflect.get(target, key, receiver);
            },
        });
        await expect(
            new Scheduler({
                events,
                faults: [],
                journal,
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run(),
        ).rejects.toThrow(/ENOSPC/);
        expect(() => new Journal(unwritable)).toThrow(
            /turn e-000001 ended but its record could not be journaled/,
        );
        const d = dir();
        const p = new Journal(join(d, "j.jsonl"));
        writeFileSync(join(d, "j.jsonl.failed"), "a much longer earlier reason that must go\n");
        p.poison("short");
        expect(() => new Journal(join(d, "j.jsonl"))).toThrow(/run failed: short$/);
    });

    test("a failed delivery signals the fatal channel so a pending kill cannot hold the run, the marker follows a renamed run directory, and the journal refuses entries with toJSON and reads through one validated descriptor", async () => {
        const events = fixtureEvents(1);
        const kill = episode("k", "daemon_sigkill_mid_fold", {
            kind: "first_summarizer_call",
            session: "s-0000",
        });
        let handle: ArmHandle | null = null;
        let settle: (() => void) | null = null;
        const j = new Journal(join(dir(), "j.jsonl"));
        const run = new Scheduler({
            events,
            faults: [kill],
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: {
                a: {
                    ...fakeDriver([]),
                    bind: (h) => {
                        handle = h;
                    },
                    event: async (e) => {
                        if (e.kind === "user_turn") {
                            handle?.observe("history_summarizer");
                            throw new Error("daemon gone");
                        }
                        return {};
                    },
                    fault: () =>
                        new Promise((resolve) => {
                            settle = () => resolve({ restarted_by: "harness" });
                        }),
                },
            },
        }).run();
        await expect(run).rejects.toThrow(/daemon gone/);
        expect(settle).not.toBeNull();
        expect(j.entries.filter((e) => e.kind === "ItemState" && e.fault === "k")).toHaveLength(1);
        const base = dir();
        const first = join(base, "run-a");
        mkdirSync(first);
        const moved = new Journal(join(first, "j.jsonl"));
        renameSync(first, join(base, "run-b"));
        moved.poison("moved mid-run");
        expect(existsSync(join(base, "run-b", "j.jsonl.failed"))).toBe(true);
        expect(() => new Journal(join(base, "run-b", "j.jsonl"))).toThrow(/moved mid-run/);
        const k = new Journal(join(dir(), "j.jsonl"));
        expect(() =>
            k.append({
                kind: "StartRun",
                arm: null,
                scenario_ms: 0,
                toJSON: () => ({ kind: "EndRun", arm: null, scenario_ms: 0, seq: 0, wall_ms: 0 }),
            } as never),
        ).toThrow(/cannot be stored/);
        expect(k.entries).toHaveLength(0);
        k.close();
        expect(readJournal(k.path)).toHaveLength(0);
        expect(() => readJournal("/dev/zero")).toThrow(/is not a regular file/);
    });

    test("a FaultObserved without its FaultFired is refused on resume", async () => {
        const path = join(dir(), "j.jsonl");
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(1), [restart]),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({
            kind: "FaultObserved",
            arm: "a",
            scenario_ms: 0,
            fault: "r",
            type: "daemon_restart",
            evidence: {},
        });
        j.close();
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [restart],
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run(),
        ).rejects.toThrow(/has no FaultFired/);
    });

    test("a resume interrupts an unobserved outage fault before binding, so a delayed exit is unexpected", async () => {
        const path = join(dir(), "j.jsonl");
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(1), [restart]),
        });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({
            kind: "FaultFired",
            arm: "a",
            scenario_ms: 0,
            fault: "r",
            type: "daemon_restart",
            layer: "scheduler",
        });
        j.close();
        const inner = fakeDriver([]);
        let exit: unknown = "none";
        const driver: ArmDriver = {
            ...inner,
            bind: (h) => {
                inner.bind(h);
                try {
                    h.daemonExited({ signal: "SIGTERM" });
                    exit = "expected";
                } catch (caught) {
                    exit = caught;
                }
            },
        };
        const resumed = new Journal(path);
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [restart],
                journal: resumed,
                settleMs: 0,
                order: ["a"],
                drivers: { a: driver },
            }).run(),
        ).rejects.toThrow(HarnessFailure);
        expect(exit).toBeInstanceOf(HarnessFailure);
        const kinds = resumed.entries.map((e) => e.kind);
        expect(kinds.indexOf("ItemState")).toBeLessThan(kinds.lastIndexOf("ItemState"));
        expect(resumed.entries.find((e) => e.kind === "ItemState")).toMatchObject({
            fault: "r",
            state: "failed(interrupted)",
        });
    });

    test("a journal with EndRun whose arm has orphan markers and no events is refused", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        j.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a"],
            scenario: scenarioId(fixtureEvents(1), []),
        });
        j.append({ kind: "EndArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "EndRun", arm: null, scenario_ms: 0 });
        j.close();
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [],
                journal: new Journal(path),
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run(),
        ).rejects.toThrow(/unfinished arms|before its events completed|outside its arm/);
    });

    test("a proxy fault whose arming failed once fires on the next run of the same scheduler", async () => {
        const path = join(dir(), "j.jsonl");
        const faults = [
            episode("p1", "provider_429", { kind: "user_turn", session: "s-0000", n: 1 }),
        ];
        let failures = 1;
        const proxy = {
            arm: () => {
                if (failures-- > 0) throw new Error("proxy warming up");
            },
            disarm: () => undefined,
            reset: () => undefined,
        };
        const j = new Journal(path);
        const scheduler = new Scheduler({
            events: fixtureEvents(1),
            faults,
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
            proxy,
        });
        await expect(scheduler.run()).rejects.toThrow(/warming up/);
        await scheduler.run();
        expect(j.entries.filter((e) => e.kind === "FaultFired").map((e) => e.fault)).toEqual([
            "p1",
        ]);
    });

    test("an unexpected daemon exit ends an idle wait on a job that never finishes", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        const driver = fakeDriver([], 0, (e) => {
            if (e.kind === "user_turn" && e.index === 0) {
                driver.arm().jobStart("stuck");
                setTimeout(() => {
                    try {
                        driver.arm().daemonExited({ signal: "SIGKILL" });
                    } catch {}
                }, 30);
            }
        });
        await expect(
            new Scheduler({
                events: fixtureEvents(2),
                faults: [],
                journal: j,
                settleMs: 0,
                jobPollMs: 5,
                order: ["a"],
                drivers: { a: driver },
            }).run(),
        ).rejects.toThrow(HarnessFailure);
    }, 3_000);

    test("an unexpected daemon exit fails the run even when the driver swallows the throw, and the journal stays failed", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        let handle: ArmHandle | null = null;
        let swallowed: unknown = null;
        const driver: ArmDriver = {
            ...fakeDriver([]),
            bind: (h) => {
                handle = h;
            },
            event: async (e) => {
                if (e.kind === "user_turn" && e.index === 0) {
                    try {
                        handle?.daemonExited({ signal: "SIGKILL" });
                    } catch (caught) {
                        swallowed = caught;
                    }
                }
                return {};
            },
        };
        const make = (journal: Journal) =>
            new Scheduler({
                events: fixtureEvents(2),
                faults: [],
                journal,
                settleMs: 0,
                order: ["a"],
                drivers: { a: driver },
            });
        await expect(make(j).run()).rejects.toThrow(HarnessFailure);
        expect(swallowed).toBeInstanceOf(HarnessFailure);
        expect(j.entries.map((e) => e.kind)).not.toContain("EndRun");
        expect(j.entries).toContainEqual(
            expect.objectContaining({ kind: "ItemState", fatal: true }),
        );
        j.close();
        await expect(make(new Journal(j.path)).run()).rejects.toThrow(HarnessFailure);
    });

    test("a turn that rejects while a mid-fold kill is in flight cuts the kill with a fatal record", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        let scheduler: Scheduler | null = null;
        const kill = episode("k", "daemon_sigkill_mid_fold", {
            kind: "first_summarizer_call",
            session: "s-0000",
        });
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            bind: (h) => {
                handle = h;
            },
            reset: async () => undefined,
            event: async (e) => {
                if (e.kind === "user_turn") {
                    handle?.observe("history_summarizer");
                    throw new Error("daemon gone");
                }
                return {};
            },
            fault: async () => {
                await Bun.sleep(40);
                return { restarted_by: "harness" };
            },
        };
        scheduler = new Scheduler({
            events: fixtureEvents(1),
            faults: [kill],
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: { a: driver },
        });
        await expect(scheduler.run()).rejects.toThrow(/daemon gone/);
        expect(j.entries.map((e) => e.kind)).not.toContain("FaultObserved");
        expect(j.entries.filter((e) => e.kind === "ItemState" && e.fatal === true)).toHaveLength(2);
        expect(() => handle?.jobStart("after-the-fact")).toThrow(/arm has ended/);
        expect(j.entries.filter((e) => e.kind === "RegisterJob")).toEqual([]);
        j.close();
    });

    test("a kill whose driver call rejects before the turn ends is not an unhandled rejection", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        const kill = episode("k", "daemon_sigkill_mid_fold", {
            kind: "first_summarizer_call",
            session: "s-0000",
        });
        let unhandled = 0;
        const onUnhandled = () => void unhandled++;
        process.on("unhandledRejection", onUnhandled);
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            bind: (h) => {
                handle = h;
            },
            reset: async () => undefined,
            event: async (e) => {
                if (e.kind === "user_turn") {
                    handle?.observe("history_summarizer");
                    await Bun.sleep(40);
                }
                return {};
            },
            fault: async () => {
                throw new Error("no daemon to kill");
            },
        };
        try {
            await expect(
                new Scheduler({
                    events: fixtureEvents(1),
                    faults: [kill],
                    journal: j,
                    settleMs: 0,
                    order: ["a"],
                    drivers: { a: driver },
                }).run(),
            ).rejects.toThrow(/no daemon to kill/);
            await Bun.sleep(10);
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }
        expect(unhandled).toBe(0);
        expect(j.entries).toContainEqual(
            expect.objectContaining({ kind: "ItemState", fault: "k", fatal: true }),
        );
    });

    test("a kill fired by a job during the idle wait keeps its outage window open until it is observed", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        let scheduler: Scheduler | null = null;
        const kill = episode("k", "daemon_sigkill_mid_fold", {
            kind: "first_summarizer_call",
            session: "s-0000",
        });
        let exit: unknown = "pending";
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            bind: (h) => {
                handle = h;
            },
            reset: async () => undefined,
            event: async (e) => {
                if (e.kind === "user_turn" && e.index === 0) {
                    handle?.jobStart("fold-1");
                    setTimeout(() => {
                        handle?.observe("history_summarizer");
                        handle?.jobEnd("fold-1");
                    }, 30);
                    setTimeout(() => {
                        try {
                            handle?.daemonExited({ signal: "SIGKILL" });
                            exit = "expected";
                        } catch (caught) {
                            exit = caught;
                        }
                    }, 60);
                }
                return {};
            },
            fault: async () => {
                await Bun.sleep(80);
                return { restarted_by: "harness" };
            },
        };
        scheduler = new Scheduler({
            events: fixtureEvents(2),
            faults: [kill],
            journal: j,
            settleMs: 0,
            jobPollMs: 5,
            order: ["a"],
            drivers: { a: driver },
        });
        await scheduler.run();
        expect(exit).toBe("expected");
        const kinds = j.entries.map((e) => e.kind);
        expect(kinds.indexOf("FaultObserved")).toBeLessThan(kinds.lastIndexOf("AdvanceClock"));
    });

    test("a callback a finished arm left behind is refused, even while the next arm is resetting", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        let late: unknown = "pending";
        const a = fakeDriver([], 0, (e) => {
            if (e.kind === "session_end") {
                const stale = a.arm();
                setTimeout(() => {
                    try {
                        stale.jobStart("late");
                        late = "accepted";
                    } catch (caught) {
                        late = caught;
                    }
                }, 30);
            }
        });
        const b: ArmDriver = { ...fakeDriver([]), reset: async () => await Bun.sleep(100) };
        await new Scheduler({
            events: fixtureEvents(1),
            faults: [],
            journal: j,
            settleMs: 0,
            order: ["a", "b"],
            drivers: { a, b },
        }).run();
        expect(late).toBeInstanceOf(Error);
        expect(String(late)).toMatch(/arm has ended/);
        expect(j.entries.filter((e) => e.kind === "RegisterJob")).toEqual([]);
        invariants(j.entries);
    });

    test("a driver whose bind throws leaves no live handle behind", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            ...fakeDriver([]),
            bind: (h) => {
                handle = h;
                throw new Error("bind failed");
            },
        };
        await expect(
            new Scheduler({
                events: fixtureEvents(1),
                faults: [],
                journal: j,
                settleMs: 0,
                order: ["a"],
                drivers: { a: driver },
            }).run(),
        ).rejects.toThrow(/bind failed/);
        expect(() => handle?.jobStart("late")).toThrow(/arm has ended/);
        expect(j.entries.map((e) => e.kind)).toEqual(["StartRun", "StartArm"]);
    });

    test("a fault the driver cannot carry out fails the run, and the journal stays failed on reopen", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        const restart = episode("r", "daemon_restart", {
            kind: "session_start",
            session: "s-0000",
        });
        const broken: ArmDriver = {
            ...fakeDriver([]),
            fault: async () => {
                throw new Error("daemon would not come back");
            },
        };
        const make = (journal: Journal, driver: ArmDriver) =>
            new Scheduler({
                events: fixtureEvents(1),
                faults: [restart],
                journal,
                settleMs: 0,
                order: ["a"],
                drivers: { a: driver },
            });
        await expect(make(j, broken).run()).rejects.toThrow(/would not come back/);
        expect(j.entries.at(-1)).toMatchObject({ kind: "ItemState", fault: "r", fatal: true });
        j.close();
        const healthy = fakeDriver([]);
        await expect(make(new Journal(path), healthy).run()).rejects.toThrow(HarnessFailure);
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
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            bind: (h) => {
                handle = h;
            },
            reset: async () => {
                resets++;
            },
            event: async (e) => {
                if (resets === 2 && e.kind === "session_start") {
                    try {
                        handle?.daemonExited({ signal: "SIGKILL" });
                        secondReset = "accepted";
                    } catch (caught) {
                        secondReset = caught;
                    }
                }
                if (e.kind === "user_turn") handle?.observe("history_summarizer");
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
        await expect(scheduler.run()).rejects.toThrow(HarnessFailure);
        expect(secondReset).toBeInstanceOf(HarnessFailure);
        const unexpected = j.entries.filter((e) => e.kind === "ItemState" && e.expected === false);
        expect(unexpected.map((e) => e.arm)).toEqual(["b"]);
    });

    test("the scenario hash ignores property order", () => {
        const events = fixtureEvents(1);
        const reordered = events.map((e) => {
            const { id, ...rest } = e;
            return { ...rest, id } as ScenarioEvent;
        });
        expect(scenarioId(reordered, [])).toBe(scenarioId(events, []));
    });

    test("a proxy fault without proxy control is refused before the run", () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        const faults = [
            episode("p1", "provider_429", { kind: "user_turn", session: "s-0000", n: 1 }),
        ];
        const o = {
            events: fixtureEvents(1),
            faults,
            journal: j,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        };
        expect(() => new Scheduler(o)).toThrow(/proxy/);
        new Scheduler({
            ...o,
            proxy: { arm: () => undefined, disarm: () => undefined, reset: () => undefined },
        });
    });

    test("a finished run is left alone, and a resume with a different arm order is refused", async () => {
        const path = join(dir(), "j.jsonl");
        const make = (journal: Journal, order: string[]) =>
            new Scheduler({
                events: fixtureEvents(1),
                faults: [],
                journal,
                settleMs: 0,
                order,
                drivers: { a: fakeDriver([]), b: fakeDriver([]) },
            });
        const j = new Journal(path);
        await make(j, ["a", "b"]).run();
        j.close();
        const n = j.entries.length;
        const again = new Journal(path);
        await make(again, ["a", "b"]).run();
        expect(again.entries).toHaveLength(n);
        again.close();
        const partial = new Journal(join(dir(), "j.jsonl"));
        partial.append({
            kind: "StartRun",
            arm: null,
            scenario_ms: 0,
            order: ["a", "b"],
            scenario: scenarioId(fixtureEvents(1), []),
        });
        await expect(make(partial, ["a"]).run()).rejects.toThrow(/order/);
    });

    test("a resume with a different scenario is refused, and every unfinished arm needs its driver before anything is journaled", async () => {
        const path = join(dir(), "j.jsonl");
        const make = (
            journal: Journal,
            events: ScenarioEvent[],
            drivers: Record<string, ArmDriver>,
        ) =>
            new Scheduler({ events, faults: [], journal, settleMs: 0, order: ["a", "b"], drivers });
        const j = new Journal(path);
        await expect(make(j, fixtureEvents(1), { a: fakeDriver([]) }).run()).rejects.toThrow(
            /driver for arm b/,
        );
        expect(j.entries).toHaveLength(0);
        const broken = {
            ...fakeDriver([]),
            reset: async () => {
                throw new Error("down");
            },
        };
        await expect(
            make(j, fixtureEvents(1), { a: broken, b: fakeDriver([]) }).run(),
        ).rejects.toThrow(/down/);
        expect(j.entries.map((e) => e.kind)).toEqual(["StartRun"]);
        j.close();
        const reopened = new Journal(path);
        const both = { a: fakeDriver([]), b: fakeDriver([]) };
        await expect(make(reopened, fixtureEvents(2), both).run()).rejects.toThrow(/scenario/);
        await make(reopened, fixtureEvents(1), both).run();
        expect(reopened.entries.at(-1)?.kind).toBe("EndRun");
    });

    test("a kill fired during an idle wait is awaited before the busy set is rechecked", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        let scheduler: Scheduler | null = null;
        const kill = episode("k", "daemon_sigkill_mid_fold", {
            kind: "first_summarizer_call",
            session: "s-0000",
        });
        let handle: ArmHandle | null = null;
        const driver: ArmDriver = {
            bind: (h) => {
                handle = h;
            },
            reset: async () => undefined,
            event: async (e) => {
                if (e.kind === "user_turn" && e.index === 0) {
                    handle?.jobStart("fold-1");
                    setTimeout(() => {
                        handle?.observe("history_summarizer");
                        handle?.jobEnd("fold-1");
                        setTimeout(() => handle?.jobStart("fold-2"), 20);
                        setTimeout(() => handle?.jobEnd("fold-2"), 120);
                    }, 60);
                }
                return {};
            },
            fault: async () => {
                await Bun.sleep(80);
                return { restarted_by: "harness" };
            },
        };
        scheduler = new Scheduler({
            events: fixtureEvents(2),
            faults: [kill],
            journal: j,
            settleMs: 0,
            jobPollMs: 5,
            order: ["a"],
            drivers: { a: driver },
        });
        await scheduler.run();
        invariants(j.entries);
        expect(j.entries.filter((e) => e.kind === "EndJob")).toHaveLength(2);
    });

    test("a job end without a matching start is refused before it is journaled", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        let scheduler: Scheduler | null = null;
        const driver = fakeDriver([], 0, (e) => {
            if (e.kind === "user_turn") {
                expect(() => driver.arm().jobEnd("ghost")).toThrow(/not busy/);
            }
        });
        scheduler = new Scheduler({
            events: fixtureEvents(1),
            faults: [],
            journal: j,
            settleMs: 0,
            order: ["a"],
            drivers: { a: driver },
        });
        await scheduler.run();
        expect(j.entries.filter((e) => e.kind === "EndJob")).toEqual([]);
    });

    test("a job registered during the last event is drained before EndArm", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        let scheduler: Scheduler | null = null;
        const driver = fakeDriver([], 0, (e) => {
            if (e.kind === "session_end") {
                driver.arm().jobStart("late");
                setTimeout(() => driver.arm().jobEnd("late"), 40);
            }
        });
        scheduler = new Scheduler({
            events: fixtureEvents(1),
            faults: [],
            journal: j,
            settleMs: 0,
            jobPollMs: 5,
            order: ["a", "b"],
            drivers: { a: driver, b: driver },
        });
        await scheduler.run();
        await Bun.sleep(100);
        invariants(j.entries);
        const kinds = j.entries.map((e) => `${e.kind}:${e.arm}`);
        expect(kinds.indexOf("EndJob:a")).toBeLessThan(kinds.indexOf("EndArm:a"));
        expect(kinds.indexOf("EndJob:b")).toBeLessThan(kinds.indexOf("EndArm:b"));
    });

    test("a failed turn's Event carries the driver's outcome, and an empty failure string is still a failure", async () => {
        const j = new Journal(join(dir(), "j.jsonl"));
        const driver: ArmDriver = {
            ...fakeDriver([]),
            event: async (e) => (e.kind === "user_turn" && e.index === 1 ? { failed: "boom" } : {}),
        };
        const probed = fixtureEvents(2).map((e) =>
            e.kind === "user_turn" ? { ...e, probe: `probe-${e.index}` } : e,
        );
        const empty: ArmDriver = {
            ...fakeDriver([]),
            event: async (e) => (e.kind === "user_turn" && e.index === 0 ? { failed: "" } : {}),
        };
        const k = new Journal(join(dir(), "j.jsonl"));
        await new Scheduler({
            events: probed,
            faults: [],
            journal: k,
            settleMs: 0,
            order: ["a"],
            drivers: { a: empty },
        }).run();
        expect(k.entries.filter((e) => e.kind === "EndTurn").map((e) => e.state)).toEqual([
            "failed",
            "completed",
        ]);
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
    const killAt = async (
        stop: (entries: Entry[], bills: string[]) => boolean,
        { settle = 0, issue = 0, billed = 2 * 6 } = {},
    ) => {
        const d = dir();
        const journalPath = join(d, "journal.jsonl");
        const spawn = () =>
            Bun.spawn(["bun", "tests/run-fixture.ts", d, "300", String(settle), String(issue)], {
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
        const rawBefore = readFileSync(journalPath);
        const second = spawn();
        expect(await second.exited).toBe(0);
        const after = readJournal(journalPath);
        invariants(after);
        wallRate(after);
        expect(after.slice(0, before.length)).toEqual(before);
        const rawAfter = readFileSync(journalPath);
        expect(rawAfter.subarray(0, rawBefore.length).equals(rawBefore)).toBe(true);
        expect(rawBefore.at(-1)).toBe(0x0a);
        const bills = readFileSync(join(d, "bill.log"), "utf8").trim().split("\n");
        expect(new Set(bills).size).toBe(bills.length);
        expect(bills).toHaveLength(billed);
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
        expect(resumed[0]).toMatchObject({ kind: "ResumeRun", arm: null });
        const terminal = new Set(
            before.filter((e) => e.kind === "Event").map((e) => `${e.arm}/${e.event}`),
        );
        for (const e of resumed.filter((e) => e.kind === "BeginTurn")) {
            expect(terminal.has(`${e.arm}/${e.event}`)).toBe(false);
        }
        expect(resumed[1]?.scenario_ms).toBe(last.scenario_ms);
        return { before, resumed: resumed.slice(1), last };
    };
    test("a second harness started on a live run directory is refused before it writes", async () => {
        const d = dir();
        const spawn = () =>
            Bun.spawn(["bun", "tests/run-fixture.ts", d, "100", "0"], {
                cwd: ROOT,
                stdout: "ignore",
                stderr: "pipe",
            });
        const a = spawn();
        const journalPath = join(d, "journal.jsonl");
        for (;;) {
            await Bun.sleep(5);
            if (existsSync(journalPath) && readJournal(journalPath).length > 0) break;
            if (a.exitCode !== null)
                throw new Error("first fixture exited before taking the lease");
        }
        const b = spawn();
        const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
        const errs = await Promise.all([
            new Response(a.stderr).text(),
            new Response(b.stderr).text(),
        ]);
        expect(codeA).toBe(0);
        expect(codeB).not.toBe(0);
        expect(errs[1]).toMatch(/is leased by pid/);
        const after = readJournal(join(d, "journal.jsonl"));
        invariants(after);
        expect(after.filter((e) => e.kind === "StartRun")).toHaveLength(1);
        expect(after.filter((e) => e.kind === "ResumeRun")).toHaveLength(0);
        expect(after.at(-1)?.kind).toBe("EndRun");
    }, 60_000);

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

    test("a harness killed after a turn is issued but before it is attempted bills nothing for it and fails it once", async () => {
        const { resumed, last } = await killAt(
            (e, b) =>
                e.filter((x) => x.kind === "EndTurn").length >= 2 &&
                e.at(-1)?.kind === "BeginTurn" &&
                !b.includes(`${e.at(-1)?.arm} ${e.at(-1)?.event}`),
            { issue: 300, billed: 2 * 6 - 1 },
        );
        expect(resumed.slice(0, 2).map((e) => [e.kind, e.event, e.state ?? e.outcome])).toEqual([
            ["ItemState", last.event, "failed(interrupted)"],
            ["Event", last.event, "failed(interrupted)"],
        ]);
    }, 60_000);

    test("a harness killed after a turn's answer records the turn once and moves on", async () => {
        const { resumed, last } = await killAt(
            (e) =>
                e.at(-1)?.kind === "EndTurn" && e.filter((x) => x.kind === "EndTurn").length >= 2,
            { settle: 400 },
        );
        expect(resumed[0]).toMatchObject({ kind: "Event", event: last.event, outcome: "ok" });
    }, 60_000);

    test("a harness killed in the second arm leaves the finished arm alone and restores a clock past zero", async () => {
        const { resumed, last } = await killAt(
            (e, b) =>
                e.some((x) => x.kind === "EndArm" && x.arm === "host") &&
                e.filter((x) => x.kind === "EndTurn" && x.arm === "eidnara").length >= 2 &&
                inFlight(e, b),
        );
        expect(resumed.filter((e) => e.arm === "host")).toEqual([]);
        expect(last.arm).toBe("eidnara");
        expect(last.scenario_ms).toBeGreaterThan(0);
    }, 60_000);
});

describe("resume of fired faults", () => {
    test("a persistent proxy fault fired before the kill is armed again, a one-shot one only if its turn has not begun; a scheduler fault without evidence is interrupted", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
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
        const start = { order: ["a"], scenario: scenarioId(fixtureEvents(2), faults) };
        j.append({ kind: "StartRun", arm: null, scenario_ms: 0, ...start });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({
            kind: "FaultFired",
            arm: "a",
            scenario_ms: 0,
            fault: "restart",
            type: "daemon_restart",
            layer: "scheduler",
        });
        j.append({
            kind: "FaultObserved",
            arm: "a",
            scenario_ms: 0,
            fault: "restart",
            type: "daemon_restart",
            evidence: { restarted_by: "harness" },
        });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
        j.append({
            kind: "FaultFired",
            arm: "a",
            scenario_ms: 0,
            fault: "slow",
            type: "slow_stream",
            layer: "proxy-sink",
        });
        j.append({
            kind: "FaultFired",
            arm: "a",
            scenario_ms: 0,
            fault: "begun",
            type: "provider_5xx",
            layer: "proxy-sink",
        });
        j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: "e-000001" });
        j.close();
        const calls: string[] = [];
        const proxy = {
            arm: (id: string) => void calls.push(`arm ${id}`),
            disarm: (id: string) => void calls.push(`disarm ${id}`),
            reset: () => undefined,
        };
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
        expect(resumed.entries.filter((e) => e.kind === "FaultFired")).toHaveLength(4);
        expect(resumed.entries).toContainEqual(
            expect.objectContaining({
                kind: "ItemState",
                fault: "begun",
                state: "failed(interrupted)",
            }),
        );
        const cut = join(dir(), "j.jsonl");
        const k = new Journal(cut);
        k.append({ kind: "StartRun", arm: null, scenario_ms: 0, ...start });
        k.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        k.append({
            kind: "FaultFired",
            arm: "a",
            scenario_ms: 0,
            fault: "restart",
            type: "daemon_restart",
            layer: "scheduler",
        });
        k.close();
        const after = new Journal(cut);
        await new Scheduler({
            events: fixtureEvents(2),
            faults,
            journal: after,
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
            proxy,
        }).run();
        expect(after.entries).toContainEqual(
            expect.objectContaining({
                kind: "ItemState",
                fault: "restart",
                state: "failed(interrupted)",
            }),
        );
    });

    test("a second resume does not repeat an earlier resume's recovery entries", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        const faults = [
            episode("restart", "daemon_restart", { kind: "session_start", session: "s-0000" }),
        ];
        const start = { order: ["a"], scenario: scenarioId(fixtureEvents(3), faults) };
        j.append({ kind: "StartRun", arm: null, scenario_ms: 0, ...start });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({
            kind: "FaultFired",
            arm: "a",
            scenario_ms: 0,
            fault: "restart",
            type: "daemon_restart",
            layer: "scheduler",
        });
        j.append({
            kind: "ItemState",
            arm: "a",
            scenario_ms: 0,
            fault: "restart",
            state: "failed(interrupted)",
        });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
        j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: "e-000001" });
        j.append({
            kind: "ItemState",
            arm: "a",
            scenario_ms: 0,
            event: "e-000001",
            state: "failed(interrupted)",
        });
        j.append({
            kind: "Event",
            arm: "a",
            scenario_ms: 0,
            event: "e-000001",
            outcome: "failed(interrupted)",
        });
        j.append({
            kind: "AdvanceClock",
            arm: "a",
            scenario_ms: 60_000,
            from_ms: 0,
            next_event: "e-000002",
            busy: [],
        });
        j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 60_000, event: "e-000002" });
        j.append({
            kind: "ItemState",
            arm: "a",
            scenario_ms: 60_000,
            event: "e-000002",
            state: "failed(interrupted)",
        });
        j.close();
        const resumed = new Journal(path);
        await new Scheduler({
            events: fixtureEvents(3),
            faults,
            journal: resumed,
            settleMs: 0,
            order: ["a"],
            drivers: { a: fakeDriver([]) },
        }).run();
        invariants(resumed.entries);
        const count = (kind: string, key: string, value: string) =>
            resumed.entries.filter((e) => e.kind === kind && e[key] === value).length;
        expect(count("ItemState", "fault", "restart")).toBe(1);
        expect(count("ItemState", "event", "e-000001")).toBe(1);
        expect(count("Event", "event", "e-000001")).toBe(1);
        expect(count("ItemState", "event", "e-000002")).toBe(1);
        expect(count("Event", "event", "e-000002")).toBe(1);
        expect(count("BeginTurn", "event", "e-000002")).toBe(1);
    });

    test("a journal that recorded an unexpected daemon exit is refused on resume", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        const start = { order: ["a"], scenario: scenarioId(fixtureEvents(2), []) };
        j.append({ kind: "StartRun", arm: null, scenario_ms: 0, ...start });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
        j.append({ kind: "BeginTurn", arm: "a", scenario_ms: 0, event: "e-000001" });
        j.append({
            kind: "ItemState",
            arm: "a",
            scenario_ms: 5,
            daemon_exit: { signal: "SIGKILL" },
            expected: false,
            fatal: true,
        });
        j.close();
        const resumed = new Journal(path);
        const n = resumed.entries.length;
        await expect(
            new Scheduler({
                events: fixtureEvents(2),
                faults: [],
                journal: resumed,
                settleMs: 0,
                order: ["a"],
                drivers: { a: fakeDriver([]) },
            }).run(),
        ).rejects.toThrow(HarnessFailure);
        expect(resumed.entries).toHaveLength(n);
    });

    test("a background job in flight at the kill is closed on resume before the clock moves, even when its id was used before", async () => {
        const path = join(dir(), "j.jsonl");
        const j = new Journal(path);
        const start = { order: ["a"], scenario: scenarioId(fixtureEvents(2), []) };
        j.append({ kind: "StartRun", arm: null, scenario_ms: 0, ...start });
        j.append({ kind: "StartArm", arm: "a", scenario_ms: 0 });
        j.append({ kind: "Event", arm: "a", scenario_ms: 0, event: "e-000000", outcome: "ok" });
        j.append({ kind: "RegisterJob", arm: "a", scenario_ms: 0, job: "fold-1" });
        j.append({ kind: "EndJob", arm: "a", scenario_ms: 0, job: "fold-1" });
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
        const ends = resumed.entries.filter((e) => e.kind === "EndJob" && e.job === "fold-1");
        expect(ends).toHaveLength(2);
        expect(ends[1]).toMatchObject({ scenario_ms: 40, outcome: "failed(interrupted)" });
        const kinds = resumed.entries.map((e) => e.kind);
        expect(kinds.lastIndexOf("EndJob")).toBeLessThan(kinds.indexOf("AdvanceClock"));
    });
});
