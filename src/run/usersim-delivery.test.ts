import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureEvents } from "../../tests/run-fixture";
import { SEAMS } from "../scenario/faults";
import type { Plan } from "../usersim/plan";
import {
    normaliser,
    Pairing,
    type PairingRecord,
    type ScriptTurn,
    Tape,
    UserSim,
} from "../usersim/usersim";
import { interruptions } from "./interruptions";
import { type Entry, Journal } from "./journal";
import type { RetryPolicy } from "./retry";
import { awaitsDelivery, userSimCall } from "./run";
import { type ArmDriver, Scheduler, scenarioId, TransportFailure } from "./scheduler";

const EVENTS = fixtureEvents(3);
const SCRIPT: ScriptTurn[] = EVENTS.filter((e) => e.kind === "user_turn").map((e) => ({
    id: e.id,
    session: e.session,
    index: e.index ?? 0,
    role: "filler",
    text: String(e.text),
}));
/** The last turn's label asks the model for a reply; the turns before it are scripted text. */
const ASKED = SCRIPT[2] as ScriptTurn;
const PLAN: Plan = {
    labels: new Map([[ASKED.id, "pushback"]]),
    skipped: new Set(),
    interruptMs: new Map(),
};
const REPLY = "Why did you pick that approach?";
/** A 200 ms share per attempt; the last attempt starts with about 170 ms of the budget left. */
const QUICK: RetryPolicy = { attempts: 3, totalMs: 600, backoffMs: [1], slackMs: 10 };

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

/**
 * Replaces `fetch` with a gateway whose call `n` stays pending for good when `pending(n)`, its
 * abort signal included, as Bun's `fetch` does once its client thread is silenced; every other
 * call answers with one Converse reply. Returns the request bodies in call order.
 */
function gateway(pending: (n: number) => boolean): string[] {
    const bodies: string[] = [];
    globalThis.fetch = ((_url: unknown, init?: { body?: unknown }) => {
        bodies.push(String(init?.body));
        if (pending(bodies.length)) return new Promise<Response>(() => undefined);
        const body = {
            output: { message: { content: [{ text: REPLY }] } },
            stopReason: "end_turn",
        };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as typeof fetch;
    return bodies;
}

/** One harness process over the run directory `root`: its journal, user-sim, and driver. */
function harness(root: string, policy: RetryPolicy = QUICK, turnsAwaitJobs = false) {
    const journal = new Journal(join(root, "journal.jsonl"));
    const pairing = new Pairing(join(root, "pairing.jsonl"), () => "a");
    const retries: [number, string][] = [];
    const user = new UserSim({
        seed: 101,
        plan: PLAN,
        tape: new Tape(join(root, "tape.jsonl")),
        pairing,
        llm: userSimCall({
            gatewayUrl: "http://127.0.0.1:9",
            model: "m",
            maxTokens: 64,
            policy,
            onRetry: (attempt, error) => retries.push([attempt, error]),
        }),
        normalise: normaliser([]),
        keys: [],
    });
    /** The text the host received, by turn. */
    const sent = new Map<string, string>();
    /** What held the clock, and the markers journaled, while the driver restored the arm. */
    const heldAtResume: string[] = [];
    const markedAtResume: Entry[] = [];
    const driver: ArmDriver = {
        reset: async () => undefined,
        resume: async () => {
            heldAtResume.push(...(scheduler.clock?.busyIds() ?? []));
            markedAtResume.push(...journal.entries.filter((e) => e.state === "undelivered"));
        },
        fault: async () => ({}),
        event: async (e) => {
            if (e.kind !== "user_turn") return {};
            const turn = SCRIPT.find((t) => t.id === e.id) as ScriptTurn;
            const d = await user.deliver("a", turn, "done");
            sent.set(e.id, d.text);
            return { user: { session: e.session, label: d.label, delivered: d.delivered } };
        },
    };
    const scheduler: Scheduler = new Scheduler({
        events: EVENTS,
        faults: [],
        journal,
        settleMs: 0,
        order: ["a"],
        drivers: { a: driver },
        turnsAwaitJobs,
        undelivered: (event) => awaitsDelivery(pairing.records, "a", event, false),
    });
    return { journal, pairing, retries, sent, heldAtResume, markedAtResume, scheduler };
}

const dir = () => mkdtempSync(join(tmpdir(), "sim-delivery-"));
const of = (entries: readonly Entry[], kind: string, event = ASKED.id) =>
    entries.filter((e) => e.kind === kind && e.event === event);
const textSha = (pairing: Pairing) =>
    pairing.records.flatMap((r) => (r.kind === "turn" ? [[r.event, r.text_sha256]] : []));

/** The run with a gateway that answers every call: the message each turn delivers. */
async function answered() {
    gateway(() => false);
    const h = harness(dir());
    await h.scheduler.run();
    h.journal.close();
    return { sent: h.sent, pairing: textSha(h.pairing) };
}

/** Asserts the resumed run `h` delivered every turn, the asked one once, as `control` did. */
function expectReplayed(
    h: ReturnType<typeof harness>,
    control: Awaited<ReturnType<typeof answered>>,
    cause: string,
) {
    const entries = h.journal.entries;
    expect(h.sent.get(ASKED.id)).toBe(control.sent.get(ASKED.id) as string);
    expect(textSha(h.pairing)).toEqual(control.pairing);
    expect(of(entries, "ItemState").filter((e) => e.fatal !== true)).toMatchObject([
        { state: "undelivered", cause },
    ]);
    expect(of(entries, "BeginTurn")).toHaveLength(1);
    expect(of(entries, "UserTurn")).toMatchObject([{ label: "pushback", delivered: true }]);
    expect(of(entries, "EndTurn")).toMatchObject([{ outcome: "ok" }]);
    const events = entries.filter((e) => e.kind === "Event");
    expect(events.map((e) => [e.event, e.outcome])).toEqual(EVENTS.map((e) => [e.id, "ok"]));
    expect(interruptions(entries).a?.interrupted_turns).toBe(0);
    expect(entries.at(-1)?.kind).toBe("EndRun");
    // The open turn held the clock while the driver restored the arm, as the journal reads it,
    // and its marker stands after the restore, where the delivery started again.
    expect(h.heldAtResume).toEqual([`turn:${ASKED.id}`]);
    expect(h.markedAtResume).toEqual([]);
}

describe("a user-sim model call that never answers", () => {
    test("is ended at its bound and sent again, and the turn delivers the answered run's message", async () => {
        const control = await answered();
        const bodies = gateway((n) => n === 1);
        const h = harness(dir());
        await h.scheduler.run();
        // The first attempt stayed pending past its 200 ms share and 10 ms slack; the second
        // carried the same request and its reply is the one delivered.
        expect(h.retries).toHaveLength(1);
        expect(h.retries[0]?.[0]).toBe(1);
        expect(h.retries[0]?.[1]).toBe("user-sim call stayed pending past 210 ms");
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toBe(bodies[0] as string);
        expect(h.sent).toEqual(control.sent);
        expect(h.sent.get(ASKED.id)).toBe(`${REPLY}\n\n${ASKED.text}`);
        expect(textSha(h.pairing)).toEqual(control.pairing);
        const entries = h.journal.entries;
        const events = entries.filter((e) => e.kind === "Event");
        expect(events.map((e) => [e.event, e.outcome])).toEqual(EVENTS.map((e) => [e.id, "ok"]));
        expect(entries.filter((e) => e.kind === "ItemState")).toEqual([]);
    });

    test("on every attempt stops the run on a transport record, and the resume delivers that turn", async () => {
        const control = await answered();
        const root = dir();
        const bodies = gateway(() => true);
        const first = harness(root);
        const started = performance.now();
        await expect(first.scheduler.run()).rejects.toBeInstanceOf(TransportFailure);
        // At most three attempts and two backoffs inside the 600 ms budget, plus one slack each.
        expect(performance.now() - started).toBeLessThan(5_000);
        // Every attempt the budget admitted stayed pending and was ended and reported.
        expect(bodies.length).toBeGreaterThanOrEqual(1);
        expect(first.retries.map(([n]) => n)).toEqual(bodies.map((_, i) => i + 1));
        expect(of(first.journal.entries, "ItemState")).toMatchObject([
            { state: "failed", fatal: true, cause: "harness-transport" },
        ]);
        expect(String(of(first.journal.entries, "ItemState")[0]?.error)).toMatch(
            /^user-sim call failed after \d attempt\(s\): user-sim call stayed pending past/,
        );
        // The stop left the turn open, undecided, and unsent.
        expect(first.sent.has(ASKED.id)).toBe(false);
        expect(textSha(first.pairing).map(([event]) => event)).not.toContain(ASKED.id);
        expect(of(first.journal.entries, "Event")).toEqual([]);
        first.journal.close();

        gateway(() => false);
        const second = harness(root);
        await second.scheduler.run();
        expect(of(second.journal.entries, "Recovered")).toMatchObject([
            { cause: "harness-transport" },
        ]);
        expectReplayed(second, control, "harness-transport");
        // The turns before the stop keep the one delivery the first process gave them.
        expect([...second.sent.keys()]).toEqual([ASKED.id]);
    });
});

describe("a run stopped inside the user-sim's delivery", () => {
    /** Runs until the asked turn's model call is pending, then drops the process as a kill does. */
    async function killedInDelivery(root: string) {
        const bodies = gateway(() => true);
        // One attempt long enough to outlast the test: the harness sits in the call.
        const h = harness(root, { attempts: 1, totalMs: 5_000, backoffMs: [0], slackMs: 10 });
        h.scheduler.run().catch(() => undefined);
        while (bodies.length === 0) await Bun.sleep(5);
        expect(of(h.journal.entries, "BeginTurn")).toHaveLength(1);
        h.journal.close();
    }

    // With `turnsAwaitJobs` the step waits for a quiet busy set before the turn, so the open
    // turn's own hold has to be given back first.
    for (const turnsAwaitJobs of [false, true]) {
        test(`replays that turn on resume with the answered run's message, and loses no turn (turnsAwaitJobs ${turnsAwaitJobs})`, async () => {
            const control = await answered();
            const root = dir();
            await killedInDelivery(root);
            gateway(() => false);
            const second = harness(root, QUICK, turnsAwaitJobs);
            await second.scheduler.run();
            expect(of(second.journal.entries, "Recovered")).toEqual([]);
            expectReplayed(second, control, "harness-exit");
        });
    }

    test("is replayed again when the resume itself stops inside the delivery", async () => {
        const control = await answered();
        const root = dir();
        await killedInDelivery(root);
        await killedInDelivery(root);
        gateway(() => false);
        const third = harness(root);
        await third.scheduler.run();
        const marks = of(third.journal.entries, "ItemState");
        expect(marks.map((e) => e.state)).toEqual(["undelivered", "undelivered"]);
        expect(third.sent.get(ASKED.id)).toBe(control.sent.get(ASKED.id) as string);
        expect(of(third.journal.entries, "BeginTurn")).toHaveLength(1);
        expect(interruptions(third.journal.entries).a?.interrupted_turns).toBe(0);
    });

    test("after the user-sim decided the turn is marked interrupted, as a turn the host may hold", async () => {
        const root = dir();
        gateway(() => false);
        const first = harness(root);
        // The host's prompt hangs after the delivery wrote its pairing record.
        const hung = new Scheduler({
            events: EVENTS,
            faults: [],
            journal: first.journal,
            settleMs: 0,
            order: ["a"],
            drivers: {
                a: {
                    reset: async () => undefined,
                    fault: async () => ({}),
                    event: async (e) => {
                        if (e.kind !== "user_turn") return {};
                        const turn = SCRIPT.find((t) => t.id === e.id) as ScriptTurn;
                        first.pairing.append({
                            kind: "turn",
                            arm: "a",
                            session: e.session,
                            event: e.id,
                            index: turn.index,
                            digest: "d",
                            label: "task",
                            delivered: true,
                            context_sha256: "c",
                            prefix_sha256: "p",
                            text_sha256: "t",
                            source: "script",
                        });
                        return e.id === ASKED.id ? new Promise(() => undefined) : {};
                    },
                },
            },
        });
        hung.run().catch(() => undefined);
        while (of(first.journal.entries, "BeginTurn").length === 0) await Bun.sleep(5);
        first.journal.close();

        const second = harness(root);
        await second.scheduler.run();
        expect(of(second.journal.entries, "ItemState")).toMatchObject([
            { state: "failed(interrupted)", cause: "harness-exit" },
        ]);
        expect(of(second.journal.entries, "Event")).toMatchObject([
            { outcome: "failed(interrupted)" },
        ]);
        expect(second.sent.has(ASKED.id)).toBe(false);
    });

    test("with a fault keyed to the turn takes the interruption, the fault's place being lost", async () => {
        const root = dir();
        const fault = {
            id: "fault-000",
            type: "provider_429" as const,
            strategy: "single" as const,
            trigger: { kind: "user_turn" as const, session: ASKED.session, n: ASKED.index + 1 },
            params: {},
            seam: SEAMS.provider_429,
        };
        const run = (journal: Journal, event: ArmDriver["event"]) =>
            new Scheduler({
                events: EVENTS,
                faults: [fault],
                journal,
                settleMs: 0,
                order: ["a"],
                drivers: { a: { reset: async () => undefined, fault: async () => ({}), event } },
                proxy: { arm: () => undefined, disarm: () => undefined, reset: () => undefined },
                undelivered: () => true,
            }).run();
        const first = new Journal(join(root, "journal.jsonl"));
        run(first, async (e) => (e.id === ASKED.id ? new Promise(() => undefined) : {})).catch(
            () => undefined,
        );
        while (of(first.entries, "BeginTurn").length === 0) await Bun.sleep(5);
        first.close();

        const second = new Journal(join(root, "journal.jsonl"));
        const delivered: string[] = [];
        await run(second, async (e) => {
            delivered.push(e.id);
            return {};
        });
        expect(delivered).not.toContain(ASKED.id);
        expect(of(second.entries, "Event")).toMatchObject([{ outcome: "failed(interrupted)" }]);
    });
});

describe("the pairing log decides which open turn awaits delivery", () => {
    const record = (arm: string, event: string) =>
        ({ kind: "turn", arm, event }) as unknown as PairingRecord;

    test("a turn with its own arm's record was sent, and another arm's record leaves it awaiting", () => {
        expect(awaitsDelivery([], "a", "e-1", false)).toBe(true);
        expect(awaitsDelivery([record("a", "e-1")], "a", "e-1", false)).toBe(false);
        expect(awaitsDelivery([record("b", "e-1")], "a", "e-1", false)).toBe(true);
        expect(awaitsDelivery([record("a", "e-2")], "a", "e-1", false)).toBe(true);
        const diverged = { kind: "divergedAt", arm: "a", event: "e-1" } as unknown as PairingRecord;
        expect(awaitsDelivery([diverged], "a", "e-1", false)).toBe(true);
    });

    test("a turn inside a P14 window takes the interruption whatever the log holds", () => {
        expect(awaitsDelivery([], "a", "e-1", true)).toBe(false);
    });
});

test("a turn an earlier resume marked interrupted stays interrupted", async () => {
    const root = dir();
    const journal = new Journal(join(root, "journal.jsonl"));
    const stamp = { arm: "a", scenario_ms: 0 };
    const scenario = scenarioId(EVENTS, []);
    const [start, turn] = EVENTS as [(typeof EVENTS)[0], (typeof EVENTS)[0]];
    journal.append({ kind: "StartRun", arm: null, scenario_ms: 0, order: ["a"], scenario });
    journal.append({ kind: "StartArm", ...stamp });
    journal.append({ kind: "Event", ...stamp, event: start.id, outcome: "ok" });
    journal.append({ kind: "BeginTurn", ...stamp, event: turn.id, probe: null });
    // The resume that wrote the marker stopped before the turn's Event.
    journal.append({ kind: "ResumeRun", arm: null, scenario_ms: 0, order: ["a"], scenario });
    const cut = { state: "failed(interrupted)", cause: "harness-exit" };
    journal.append({ kind: "ItemState", ...stamp, event: turn.id, ...cut });
    const delivered: string[] = [];
    await new Scheduler({
        events: EVENTS,
        faults: [],
        journal,
        settleMs: 0,
        order: ["a"],
        drivers: {
            a: {
                reset: async () => undefined,
                fault: async () => ({}),
                event: async (e) => {
                    delivered.push(e.id);
                    return {};
                },
            },
        },
        undelivered: () => true,
    }).run();
    expect(delivered).not.toContain(turn.id);
    expect(of(journal.entries, "ItemState", turn.id)).toHaveLength(1);
    expect(of(journal.entries, "Event", turn.id)).toMatchObject([
        { outcome: "failed(interrupted)" },
    ]);
});

test("a journal whose undelivered marker names a turn with a user record is refused", async () => {
    const root = dir();
    const journal = new Journal(join(root, "journal.jsonl"));
    const stamp = { arm: "a", scenario_ms: 0 };
    const scenario = scenarioId(EVENTS, []);
    journal.append({ kind: "StartRun", arm: null, scenario_ms: 0, order: ["a"], scenario });
    journal.append({ kind: "StartArm", ...stamp });
    const [start, turn] = EVENTS as [(typeof EVENTS)[0], (typeof EVENTS)[0]];
    journal.append({ kind: "Event", ...stamp, event: start.id, outcome: "ok" });
    journal.append({ kind: "BeginTurn", ...stamp, event: turn.id, probe: null });
    journal.append({ kind: "UserTurn", ...stamp, event: turn.id, label: "task", delivered: true });
    journal.append({ kind: "ItemState", ...stamp, event: turn.id, state: "undelivered" });
    const scheduler = new Scheduler({
        events: EVENTS,
        faults: [],
        journal,
        settleMs: 0,
        order: ["a"],
        drivers: {
            a: { reset: async () => undefined, fault: async () => ({}), event: async () => ({}) },
        },
    });
    await expect(scheduler.run()).rejects.toThrow(
        `undelivered ${turn.id} names no turn awaiting delivery`,
    );
});

test("a journal whose undelivered marker names a turn yet to begin, or an ended one, is refused", async () => {
    const [start, turn] = EVENTS as [(typeof EVENTS)[0], (typeof EVENTS)[0]];
    const stamp = { arm: "a", scenario_ms: 0 };
    const refused = async (before: Record<string, unknown>[]) => {
        const journal = new Journal(join(dir(), "journal.jsonl"));
        const scenario = scenarioId(EVENTS, []);
        journal.append({ kind: "StartRun", arm: null, scenario_ms: 0, order: ["a"], scenario });
        journal.append({ kind: "StartArm", ...stamp });
        journal.append({ kind: "Event", ...stamp, event: start.id, outcome: "ok" });
        for (const e of before) journal.append({ ...stamp, event: turn.id, ...e } as never);
        journal.append({ kind: "ItemState", ...stamp, event: turn.id, state: "undelivered" });
        const scheduler = new Scheduler({
            events: EVENTS,
            faults: [],
            journal,
            settleMs: 0,
            order: ["a"],
            drivers: {
                a: {
                    reset: async () => undefined,
                    fault: async () => ({}),
                    event: async () => ({}),
                },
            },
        });
        await expect(scheduler.run()).rejects.toThrow(
            `undelivered ${turn.id} names no turn awaiting delivery`,
        );
    };
    await refused([]);
    await refused([
        { kind: "BeginTurn", probe: null },
        { kind: "EndTurn", outcome: "ok", prompt_ms: null },
    ]);
});
