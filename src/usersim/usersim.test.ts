import { describe, expect, test } from "bun:test";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrereg } from "../scenario/inputs";
import {
    behaviourPlan,
    deliveredTurns,
    type Label,
    type Plan,
    type PlanTurn,
    pinnedTurns,
    realisedRates,
    withUserLabels,
} from "./plan";
import {
    agentReplyOf,
    checkTapeSources,
    type Llm,
    normaliser,
    Pairing,
    type PairingRecord,
    type Prompt,
    pairingMismatches,
    proxyUserSim,
    type ScriptTurn,
    Tape,
    tapeDigests,
    UserSim,
} from "./usersim";

const prereg = loadPrereg("S");
const recorded = JSON.parse(
    readFileSync(join(import.meta.dir, "../../tests/fixtures/usersim/S-101-turns.json"), "utf8"),
) as { turns: PlanTurn[] };
const dir = () => mkdtempSync(join(tmpdir(), "sim-usersim-"));
const delivered = (turns: PlanTurn[], plan: Plan) =>
    turns
        .filter((t) => !plan.skipped.has(t.id))
        .map((t) => ({ session: t.session, label: plan.labels.get(t.id) ?? ("task" as Label) }));

describe("behaviour plan", () => {
    test("the S seed 101 plan is seeded, its rates sit inside every band, and probes stay tasks", () => {
        const plan = behaviourPlan(recorded.turns, prereg, 101);
        expect(behaviourPlan(recorded.turns, prereg, 101)).toEqual(plan);
        expect(behaviourPlan(recorded.turns, prereg, 102).labels).not.toEqual(plan.labels);
        const r = realisedRates(delivered(recorded.turns, plan), prereg);
        expect(r.outside).toEqual([]);
        expect(r.sessions).toBe(50);
        expect(r.rates.abandon_per_session).toBe(0.06);
        expect(r.rates.redirect_per_session).toBe(0.06);
        for (const t of recorded.turns.filter((x) => x.role === "probe")) {
            expect([t.id, plan.labels.get(t.id) ?? "task"]).toEqual([t.id, "task"]);
            expect(plan.skipped.has(t.id)).toBe(false);
        }
        for (const t of recorded.turns.filter((x) => x.role === "paste")) {
            expect(plan.labels.get(t.id)).toBe("paste");
        }
        const interrupts = [...plan.interruptMs.values()];
        expect(interrupts.length).toBe(25);
        const { min, max } = prereg.user_sim.interrupt_after_ms;
        expect(interrupts.every((ms) => ms >= min && ms <= max)).toBe(true);
    });

    test("an abandoned session skips only the trailing filler turns after the abandon", () => {
        const plan = behaviourPlan(recorded.turns, prereg, 101);
        for (const t of recorded.turns.filter((x) => plan.labels.get(x.id) === "abandon")) {
            const session = recorded.turns.filter((x) => x.session === t.session);
            const after = session.filter((x) => x.index > t.index);
            expect(after.every((x) => x.role === "filler" && plan.skipped.has(x.id))).toBe(true);
            expect(t.role).toBe("filler");
        }
        const skippedSessions = new Set(
            recorded.turns.filter((t) => plan.skipped.has(t.id)).map((t) => t.session),
        );
        const abandoned = new Set(
            recorded.turns.filter((t) => plan.labels.get(t.id) === "abandon").map((t) => t.session),
        );
        expect([...skippedSessions].every((s) => abandoned.has(s))).toBe(true);
    });

    test("pinned turns cover each fault's trigger turn, and a proxy fault's session from its trigger on", () => {
        const events = [
            { id: "e-1", kind: "user_turn", session: "s-1", index: 0 },
            { id: "e-2", kind: "user_turn", session: "s-1", index: 1 },
            { id: "e-3", kind: "user_turn", session: "s-1", index: 2 },
            { id: "e-4", kind: "user_turn", session: "s-2", index: 0 },
            { id: "e-5", kind: "user_turn", session: "s-2", index: 1 },
        ];
        const faults = [
            { trigger: { kind: "user_turn", session: "s-1", n: 2 }, seam: { layer: "proxy-sink" } },
            { trigger: { kind: "user_turn", session: "s-2", n: 1 }, seam: { layer: "daemon" } },
        ];
        expect([...pinnedTurns(events, faults)].sort()).toEqual(["e-2", "e-3", "e-4"]);
        const dynamic = [
            {
                trigger: { kind: "first_summarizer_call", session: "s-2" },
                seam: { layer: "daemon" },
            },
        ];
        expect([...pinnedTurns(events, dynamic)].sort()).toEqual(["e-4", "e-5"]);
        const atStart = [
            { trigger: { kind: "session_start", session: "s-1" }, seam: { layer: "proxy-sink" } },
        ];
        expect([...pinnedTurns(events, atStart)].sort()).toEqual(["e-1", "e-2", "e-3"]);
    });

    test("delivered turns leave out a record recovered after a kill, whose delivery is unknown", () => {
        const entries = [
            {
                kind: "UserTurn",
                arm: "a",
                session: "s",
                event: "e-1",
                label: "task",
                delivered: true,
            },
            {
                kind: "UserTurn",
                arm: "a",
                session: "s",
                event: "e-2",
                label: "pushback",
                delivered: true,
                recovered: true,
            },
            {
                kind: "UserTurn",
                arm: "a",
                session: "s",
                event: "e-3",
                label: "abandon",
                delivered: false,
            },
            {
                kind: "UserTurn",
                arm: "b",
                session: "s",
                event: "e-1",
                label: "task",
                delivered: true,
            },
            { kind: "EndTurn", arm: "a", event: "e-1" },
        ];
        expect(deliveredTurns(entries, "a").map((e) => e.event)).toEqual(["e-1"]);
        expect(deliveredTurns(entries, "a", "other")).toEqual([]);
    });

    test("a snapshot's calls carry the journaled user labels in place of the raw user-sim records", () => {
        const calls = [
            {
                seq: 1,
                component: "agent",
                turn: "e-1",
                scenario_ms: 5,
                input_tokens: 1,
                output_tokens: 1,
            },
            {
                seq: 2,
                component: "user-sim",
                turn: "e-2",
                scenario_ms: 6,
                input_tokens: 1,
                output_tokens: 1,
            },
        ];
        const turns = [{ seq: 9, event: "e-2", scenario_ms: 6, label: "pushback" }];
        const labelled = withUserLabels(calls, turns, new Map([["e-2", 1]]));
        expect(labelled.map((c) => [c.component, (c as { label?: string }).label ?? null])).toEqual(
            [
                ["agent", null],
                ["user-sim", "pushback"],
            ],
        );
        expect(labelled[1]).toMatchObject({ turn: "e-2", turn_index: 1, input_tokens: 0 });
    });

    test("a fault's trigger turn is never interrupted", () => {
        const turns: PlanTurn[] = [];
        for (let s = 0; s < 40; s++) {
            for (let i = 0; i < 4; i++) {
                turns.push({ id: `e-${s}-${i}`, session: `s-${s}`, index: i, role: "filler" });
            }
        }
        const pinned = new Set(turns.filter((t) => t.index === 1).map((t) => t.id));
        const free = behaviourPlan(turns, prereg, 102);
        expect([...free.labels].some(([id, l]) => l === "interrupt" && pinned.has(id))).toBe(true);
        const plan = behaviourPlan(turns, prereg, 102, pinned);
        expect([...plan.labels].filter(([id, l]) => l === "interrupt" && pinned.has(id))).toEqual(
            [],
        );
        expect([...plan.labels.values()].filter((l) => l === "interrupt").length).toBeGreaterThan(
            0,
        );
    });

    test("a fault's trigger turn is never skipped by an abandon", () => {
        const turns: PlanTurn[] = [];
        for (let s = 0; s < 10; s++) {
            for (let i = 0; i < 3; i++) {
                turns.push({ id: `e-${s}-${i}`, session: `s-${s}`, index: i, role: "filler" });
            }
        }
        const free = behaviourPlan(turns, prereg, 101);
        expect(free.skipped.size).toBeGreaterThan(0);
        const pinned = new Set(turns.filter((t) => t.index === 2).map((t) => t.id));
        const plan = behaviourPlan(turns, prereg, 101, pinned);
        expect([...plan.skipped].filter((id) => pinned.has(id))).toEqual([]);
        for (const t of turns.filter((x) => plan.labels.get(x.id) === "abandon")) {
            expect(t.index).toBe(2);
        }
    });

    test("a run cut short of its scenario is flagged when a rate leaves its band", () => {
        const plan = behaviourPlan(recorded.turns, prereg, 101);
        const first = delivered(recorded.turns.slice(0, 12), plan);
        const r = realisedRates(first, prereg);
        expect(r.outside.length).toBeGreaterThan(0);
    });
});

describe("digest normalisation", () => {
    test("each pre-registered rule removes its run-specific text, and an unknown rule is refused", () => {
        const n = normaliser(prereg.divergence_policy.normalisation);
        const a = n(
            "built at 2026-10-16T12:48:47.806Z in 3.2s (pid 4123), wrote /tmp/sim-x1/out.log for run 0f8fad5b-d9cb-469f-a165-70867728950e",
        );
        const b = n(
            "built at 2026-10-17T01:02:03Z in 41 ms (pid 77), wrote /tmp/sim-y2/out.log for run 7c9e6679-7425-40de-944b-e07fc1f90ae7",
        );
        expect(a).toBe(b);
        expect(n("no change here")).toBe("no change here");
        expect(n("Use /tmp/a?")).toBe("Use <tmp>?");
        expect(n("Wrote /tmp/x/out.log.")).toBe("Wrote <tmp>.");
        expect(() => normaliser(["iso-8601-timestamps", "colours"])).toThrow(
            "unknown rule colours",
        );
    });
});

const plan: Plan = {
    labels: new Map<string, Label>([
        ["e-2", "pushback"],
        ["e-3", "pushback"],
        ["e-4", "pushback"],
        ["e-5", "interrupt"],
        ["e-9", "abandon"],
    ]),
    skipped: new Set(["e-10"]),
    interruptMs: new Map([["e-5", 7_000]]),
};
const script: ScriptTurn[] = [
    { id: "e-1", session: "s-1", index: 0, role: "filler", text: "Look at the parser." },
    { id: "e-2", session: "s-1", index: 1, role: "filler", text: "Now add a test." },
    { id: "e-3", session: "s-1", index: 2, role: "conveyance", text: "Logs use the debug level." },
    { id: "e-4", session: "s-1", index: 3, role: "filler", text: "Tidy the error type." },
    { id: "e-5", session: "s-1", index: 4, role: "filler", text: "Run the suite." },
];
const outputs = [
    "",
    "I read the parser.",
    "Added parser_test.rs.",
    "Switched logs to debug.",
    "Done.",
];

function counting(): Llm & { calls: number; prompts: string[] } {
    const llm = (async (prompt: Prompt) => {
        llm.calls++;
        llm.prompts.push(`${prompt.system}\n${prompt.user}`);
        return { text: `reply ${llm.calls} to ${prompt.user.length}`, stop: "end_turn" };
    }) as Llm & { calls: number; prompts: string[] };
    llm.calls = 0;
    llm.prompts = [];
    return llm;
}

function sim(
    root: string,
    llm: Llm,
    reference: string | ((arm: string) => string) = "a",
    sources: string[] = [],
) {
    const ref = typeof reference === "string" ? () => reference : reference;
    const pairings = sources.map((t) => join(t, "..", "pairing.jsonl"));
    const pairing = new Pairing(join(root, "pairing.jsonl"), ref, pairings);
    const user = new UserSim({
        seed: 101,
        plan,
        tape: new Tape(join(root, "tape.jsonl"), sources),
        pairing,
        llm,
        normalise: normaliser(prereg.divergence_policy.normalisation),
        keys: ["f-0000", "q-0001"],
    });
    return { user, pairing };
}

async function play(user: UserSim, arm: string, agent: string[]) {
    const texts: string[] = [];
    for (const [i, t] of script.entries())
        texts.push((await user.deliver(arm, t, agent[i] ?? "")).text);
    return texts;
}

describe("tape and pairing", () => {
    test("a named replay source must exist, with its pairing log beside it", () => {
        const root = dir();
        const missing = join(root, "gone", "tape.jsonl");
        const own = dir();
        expect(() => new Tape(join(own, "tape.jsonl"), [missing])).toThrow("gone");
        expect(() => new Pairing(join(own, "pairing.jsonl"), () => "a", [missing])).toThrow("gone");
        expect(() => tapeDigests([missing])).toThrow("gone");
        writeFileSync(missing.replace("gone/tape.jsonl", "tape.jsonl"), "");
        expect(() => tapeDigests([join(root, "tape.jsonl")])).toThrow("pairing.jsonl");
        writeFileSync(join(root, "pairing.jsonl"), "");
        const [before] = tapeDigests([join(root, "tape.jsonl")]);
        appendFileSync(join(root, "pairing.jsonl"), '{"kind":"turn"}\n');
        expect(tapeDigests([join(root, "tape.jsonl")])[0]).not.toBe(before);
    });

    test("a cut last line in a tape or pairing log is dropped, and the next append lands on a whole line", async () => {
        const root = dir();
        const first = sim(root, counting());
        await play(first.user, "a", outputs);
        const tapePath = join(root, "tape.jsonl");
        const pairPath = join(root, "pairing.jsonl");
        const whole = {
            tape: readFileSync(tapePath, "utf8"),
            pairing: readFileSync(pairPath, "utf8"),
        };
        appendFileSync(tapePath, '{"key":"cut');
        appendFileSync(pairPath, '{"kind":"turn","arm":"a"');
        const again = sim(root, counting());
        expect(again.pairing.records).toHaveLength(whole.pairing.trim().split("\n").length);
        const t: ScriptTurn = { id: "e-7", session: "s-2", index: 1, role: "filler", text: "Go." };
        await again.user.deliver("a", t, "Hmm?");
        for (const p of [tapePath, pairPath]) {
            for (const line of readFileSync(p, "utf8").trim().split("\n")) JSON.parse(line);
        }
        expect(readFileSync(tapePath, "utf8")).toStartWith(whole.tape);
        expect(readFileSync(pairPath, "utf8")).toStartWith(whole.pairing);
    });

    test("a reply found on a source tape is copied into the run's own tape", async () => {
        const first = dir();
        await play(sim(first, counting()).user, "a", outputs);
        const second = dir();
        const again = sim(second, counting(), "a", [join(first, "tape.jsonl")]);
        await play(again.user, "a", outputs);
        expect(readFileSync(join(second, "tape.jsonl"), "utf8")).toBe(
            readFileSync(join(first, "tape.jsonl"), "utf8"),
        );
    });

    test("an arm replayed on its own keeps the tape ownership its recorded divergence gave it", async () => {
        const first = dir();
        const changed = outputs.map((o, i) => (i === 2 ? `${o} Also fixed a typo.` : o));
        const recordedRun = sim(first, counting());
        await play(recordedRun.user, "a", outputs);
        const b = await play(recordedRun.user, "b", changed);
        const replay = counting();
        const alone = sim(dir(), replay, "b", [join(first, "tape.jsonl")]);
        expect(await play(alone.user, "b", changed)).toEqual(b);
        expect(replay.calls).toBe(0);
    });

    test("a digest matching any replay source is paired with that source, not the last one named", async () => {
        const first = dir();
        await play(sim(first, counting()).user, "a", outputs);
        const second = dir();
        const changed = outputs.map((o, i) => (i === 2 ? `${o} Also fixed a typo.` : o));
        await play(sim(second, counting()).user, "a", changed);
        const replay = counting();
        const both = [join(first, "tape.jsonl"), join(second, "tape.jsonl")];
        const again = sim(dir(), replay, "a", both);
        await play(again.user, "a", outputs);
        expect(replay.calls).toBe(0);
        expect(again.pairing.records.filter((r) => r.kind === "divergedAt")).toEqual([]);
    });

    test("a call record's response fields reach the user-sim only as strings", () => {
        expect(agentReplyOf({ component: "agent", response_text: "hi" })).toEqual({ text: "hi" });
        expect(
            agentReplyOf({
                component: "agent",
                response_text: "hi",
                response_sha256: "s",
                response_tail: "t",
            }),
        ).toEqual({ text: "hi", sha256: "s", tail: "t" });
        expect(agentReplyOf({ component: "agent", response_text: 123 })).toBeUndefined();
        expect(
            agentReplyOf({ component: "agent", response_text: "hi", response_sha256: 5 }),
        ).toEqual({ text: "hi" });
        expect(agentReplyOf({ component: "judge", response_text: "hi" })).toBeUndefined();
    });

    test("a divergence record carries the arm's session context beside both digests", async () => {
        const { user, pairing } = sim(dir(), counting());
        await play(user, "a", outputs);
        const changed = outputs.map((o, i) => (i === 2 ? `${o} Also fixed a typo.` : o));
        await play(user, "b", changed);
        const d = pairing.records.find((r) => r.kind === "divergedAt");
        expect(typeof (d as { context_sha256?: unknown }).context_sha256).toBe("string");
        const turn = pairing.records.find(
            (r) => r.kind === "turn" && r.arm === "b" && r.event === "e-3",
        );
        expect((d as { context_sha256?: unknown }).context_sha256).toBe(
            (turn as { context_sha256: string }).context_sha256,
        );
    });

    test("a reply the proxy cut is paired by its whole text and read from its real tail", async () => {
        const llm = counting();
        const { user, pairing } = sim(dir(), llm);
        const head = "x".repeat(40);
        const t = script[1] as ScriptTurn;
        await user.deliver("a", t, { text: head, sha256: "a".repeat(64), tail: "so far." });
        await user.deliver("b", t, { text: head, sha256: "b".repeat(64), tail: "so far." });
        const digests = pairing.records
            .filter((r): r is Extract<PairingRecord, { kind: "turn" }> => r.kind === "turn")
            .map((r) => r.digest);
        expect(digests[0]).not.toBe(digests[1]);
        expect(pairing.records.filter((r) => r.kind === "divergedAt")).toHaveLength(1);
        const q: ScriptTurn = { id: "e-7", session: "s-2", index: 1, role: "filler", text: "Go." };
        const d = await user.deliver("a", q, {
            text: head,
            sha256: "c".repeat(64),
            tail: "Which?",
        });
        expect(d.label).toBe("clarify");
        expect(llm.prompts.at(-1)).toContain("Which?");
    });

    test("a replay against the recorded agent outputs repeats the user text with no live call", async () => {
        const first = dir();
        const live = counting();
        const recordedTexts = await play(sim(first, live).user, "a", outputs);
        expect(live.calls).toBe(3);
        expect(recordedTexts[1]).toStartWith("reply 1 to");
        expect(recordedTexts[1]).toEndWith("\n\nNow add a test.");
        expect(recordedTexts[0]).toBe("Look at the parser.");

        const replay = counting();
        const again = sim(dir(), replay, "a", [join(first, "tape.jsonl")]);
        expect(await play(again.user, "a", outputs)).toEqual(recordedTexts);
        expect(replay.calls).toBe(0);
        const sources = again.pairing.records.map((r) => (r.kind === "turn" ? r.source : r.kind));
        expect(sources).toEqual(["script", "tape", "tape", "tape", "script"]);
    });

    test("one changed agent output gives one divergence record, written before the turn, and live replies after it", async () => {
        const root = dir();
        const inner = counting();
        const onDisk = () =>
            readFileSync(join(root, "pairing.jsonl"), "utf8")
                .trim()
                .split("\n")
                .map((l) => JSON.parse(l) as PairingRecord);
        const seenAtCall: PairingRecord[][] = [];
        const llm: Llm & { calls: number } = Object.assign(
            async (prompt: Prompt) => {
                seenAtCall.push(onDisk());
                return inner(prompt);
            },
            { calls: 0 },
        );
        const { user, pairing } = sim(root, llm);
        const reference = await play(user, "a", outputs);
        const before = inner.calls;
        const changed = [...outputs];
        changed[2] = "Added parser_test.rs and fixed a typo.";
        const texts: string[] = [];
        for (const [i, t] of script.entries()) {
            texts.push((await user.deliver("b", t, changed[i] ?? "")).text);
            const last = onDisk().at(-1) as PairingRecord;
            expect([last.kind, last.event]).toEqual(["turn", t.id]);
        }
        const divergences = pairing.records.filter((r) => r.kind === "divergedAt");
        expect(divergences).toHaveLength(1);
        expect(divergences[0]).toMatchObject({ arm: "b", session: "s-1", event: "e-3", index: 2 });
        // The live call for e-3 found the divergence on disk, and no turn record for e-3 yet.
        const atLiveCall = seenAtCall[before] ?? [];
        expect(atLiveCall.at(-1)).toMatchObject({ kind: "divergedAt", arm: "b", event: "e-3" });
        expect(
            atLiveCall.some((r) => r.kind === "turn" && r.arm === "b" && r.event === "e-3"),
        ).toBe(false);
        const order = pairing.records.map((r) => `${r.kind}:${r.arm}:${r.event}`);
        expect(order.indexOf("divergedAt:b:e-3")).toBeLessThan(order.indexOf("turn:b:e-3"));
        const llmCalls = inner.calls;
        expect(llmCalls - before).toBe(2);
        expect(texts.slice(0, 2)).toEqual(reference.slice(0, 2));
        expect(texts[2]).not.toBe(reference[2]);
        expect(pairingMismatches(pairing.records, () => "a")).toEqual([]);
        const tampered = pairing.records.map((r) =>
            r.kind === "turn" && r.arm === "b" && r.index === 1 ? { ...r, text_sha256: "x" } : r,
        );
        expect(pairingMismatches(tampered, () => "a")).toEqual(["b s-1 #1"]);
    });

    test("a two-arm run replayed against its recorded outputs makes no live call", async () => {
        const first = dir();
        const changed = outputs.map((o, i) => (i === 2 ? `${o} Also fixed a typo.` : o));
        const recordedRun = sim(first, counting());
        const a = await play(recordedRun.user, "a", outputs);
        const b = await play(recordedRun.user, "b", changed);
        const replay = counting();
        const again = sim(dir(), replay, "a", [join(first, "tape.jsonl")]);
        expect(await play(again.user, "a", outputs)).toEqual(a);
        expect(await play(again.user, "b", changed)).toEqual(b);
        expect(replay.calls).toBe(0);
        expect(again.pairing.records.filter((r) => r.kind === "divergedAt")).toHaveLength(1);
    });

    test("a replay with one changed agent output records one divergence from the recorded run, then goes live", async () => {
        const first = dir();
        await play(sim(first, counting()).user, "a", outputs);
        const changed = outputs.map((o, i) => (i === 2 ? `${o} Also fixed a typo.` : o));
        const replay = counting();
        const again = sim(dir(), replay, "a", [join(first, "tape.jsonl")]);
        await play(again.user, "a", changed);
        const divergences = again.pairing.records.filter((r) => r.kind === "divergedAt");
        expect(divergences).toHaveLength(1);
        expect(divergences[0]).toMatchObject({ arm: "a", index: 2, against: "recorded" });
        expect(replay.calls).toBe(2);
        const sources = again.pairing.records.map((r) => (r.kind === "turn" ? r.source : r.kind));
        expect(sources).toEqual(["script", "tape", "divergedAt", "live", "live", "script"]);
    });

    test("an A/A control whose arm diverged from the first arm reuses that arm's replies", async () => {
        const reference = (arm: string) => (arm === "eidnara~aa" ? "eidnara" : "host");
        const llm = counting();
        const { user, pairing } = sim(dir(), llm, reference);
        await play(user, "host", outputs);
        const changed = outputs.map((o, i) => (i === 2 ? `${o} Also fixed a typo.` : o));
        const base = await play(user, "eidnara", changed);
        const before = llm.calls;
        expect(await play(user, "eidnara~aa", changed)).toEqual(base);
        expect(llm.calls).toBe(before);
        const control = pairing.records.filter((r) => r.arm === "eidnara~aa");
        expect(control.filter((r) => r.kind === "divergedAt")).toEqual([]);
        expect(pairingMismatches(pairing.records, reference)).toEqual([]);
    });

    test("the prefix hash continues across a resumed user-sim, and fact-bearing scripts stay out of the prompt", async () => {
        const whole = sim(dir(), counting());
        await play(whole.user, "a", outputs);
        const root = dir();
        const llm = counting();
        const before = sim(root, llm).user;
        for (const [i, t] of script.slice(0, 2).entries())
            await before.deliver("a", t, outputs[i] ?? "");
        const after = sim(root, llm);
        for (const [i, t] of script.slice(2).entries())
            await after.user.deliver("a", t, outputs[i + 2] ?? "");
        const hashes = (r: PairingRecord[]) =>
            r.map((x) => (x.kind === "turn" ? x.prefix_sha256 : ""));
        expect(hashes(after.pairing.records)).toEqual(hashes(whole.pairing.records));
        expect(llm.prompts[0]).toContain("Now add a test.");
        expect(llm.prompts[1]).not.toContain("Logs use the debug level.");
    });

    test("a reply carrying a marker or nothing falls back to a fixed line, and the interrupt delay reaches the turn", async () => {
        const replies = [
            { text: "Did you run the probe on P1?", stop: "end_turn" },
            { text: "", stop: "end_turn" },
            { text: "You missed the blocking-pool starv", stop: "max_tokens" },
        ];
        const llm: Llm = async () => replies.shift() ?? { text: "", stop: "end_turn" };
        const { user, pairing } = sim(dir(), llm);
        const texts = await play(user, "a", outputs);
        expect(texts[1]).toStartWith("I'm not convinced by that.");
        expect(texts[2]).toStartWith("I'm not convinced by that.");
        expect(texts[3]).toStartWith("I'm not convinced by that.");
        const fallbacks = pairing.records.map((r) => (r.kind === "turn" ? r.fallback : undefined));
        expect(fallbacks.slice(1, 4)).toEqual([["probe", "P1"], ["empty"], ["max_tokens"]]);
        const d = await user.deliver("a", script[4] as ScriptTurn, "Done.");
        expect([d.label, d.interruptMs]).toEqual(["interrupt", 7_000]);
    });

    test("an agent question turns a plain task into a clarify reply, and a skipped turn is never sent", async () => {
        const llm = counting();
        const { user, pairing } = sim(dir(), llm);
        const t: ScriptTurn = {
            id: "e-7",
            session: "s-2",
            index: 1,
            role: "filler",
            text: "Go on.",
        };
        const d = await user.deliver("a", t, "Should the cache be per connection?");
        expect(d.label).toBe("clarify");
        expect(d.text).toEndWith("\n\nGo on.");
        const skip = { id: "e-10", session: "s-2", index: 3, role: "filler", text: "More." };
        expect(await user.deliver("a", skip, "")).toEqual({
            label: "abandon",
            text: "",
            delivered: false,
        });
        const abandon = { id: "e-9", session: "s-2", index: 2, role: "filler", text: "Next." };
        const sent = await user.deliver("a", abandon, "ok");
        expect(sent.text).not.toContain("Next.");
        expect(pairing.records.at(-2)).toMatchObject({ event: "e-10", delivered: false });
    });

    test("a taped reply is not reused for the same event once its scripted text differs", async () => {
        const first = dir();
        await play(sim(first, counting()).user, "a", outputs);
        const replay = counting();
        const again = sim(dir(), replay, "a", [join(first, "tape.jsonl")]);
        const edited = script.map((t) =>
            t.id === "e-2" ? { ...t, text: "Now add two tests." } : t,
        );
        for (const [i, t] of edited.entries()) await again.user.deliver("a", t, outputs[i] ?? "");
        expect(replay.calls).toBe(1);
        expect(replay.prompts[0]).toContain("Now add two tests.");
    });

    test("a proxied user-sim call that never answers fails the run at its deadline", async () => {
        const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
        try {
            const llm = proxyUserSim(`http://127.0.0.1:${server.port}`, "m", 100, 200);
            await expect(llm({ system: "s", user: "hi" })).rejects.toThrow(
                "user-sim call timed out after 200 ms",
            );
        } finally {
            server.stop(true);
        }
    });

    test("a replay source from another seed or scenario is refused", () => {
        const root = dir();
        writeFileSync(join(root, "tape.jsonl"), "");
        writeFileSync(join(root, "pairing.jsonl"), "");
        const run = { seed: 101, scenario_hash: "abc" };
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).toThrow("manifest.json");
        writeFileSync(
            join(root, "manifest.json"),
            JSON.stringify({ seed: 102, scenario_hash: "abc" }),
        );
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).toThrow("seed 102");
        writeFileSync(
            join(root, "manifest.json"),
            JSON.stringify({ seed: 101, scenario_hash: "zzz" }),
        );
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).toThrow("scenario");
        writeFileSync(
            join(root, "manifest.json"),
            JSON.stringify({ seed: 101, scenario_hash: "abc" }),
        );
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).not.toThrow();
    });

    test("a proxied user-sim reply joins every text block of the response", async () => {
        const server = Bun.serve({
            port: 0,
            fetch: async () =>
                Response.json({
                    output: {
                        message: {
                            content: [{ text: "First." }, { toolUse: {} }, { text: "Second?" }],
                        },
                    },
                    stopReason: "end_turn",
                }),
        });
        try {
            const llm = proxyUserSim(`http://127.0.0.1:${server.port}`, "m", 100, 5_000);
            expect(await llm({ system: "s", user: "hi" })).toEqual({
                text: "First.\nSecond?",
                stop: "end_turn",
            });
        } finally {
            server.stop(true);
        }
    });

    test("a digest matching one source replays from it even when another source diverged there", async () => {
        const first = dir();
        await play(sim(first, counting()).user, "a", outputs);
        const second = dir();
        const changed = outputs.map((o, i) => (i === 2 ? `${o} Also fixed a typo.` : o));
        const diverging = sim(second, counting(), "a", [join(first, "tape.jsonl")]);
        await play(diverging.user, "a", changed);
        expect(diverging.pairing.records.filter((r) => r.kind === "divergedAt")).toHaveLength(1);
        const replay = counting();
        const both = [join(first, "tape.jsonl"), join(second, "tape.jsonl")];
        const again = sim(dir(), replay, "a", both);
        await play(again.user, "a", outputs);
        expect(replay.calls).toBe(0);
    });

    test("two non-reference arms with the same agent outputs share replies after both left the reference", async () => {
        const llm = counting();
        const { user, pairing } = sim(dir(), llm);
        await play(user, "a", outputs);
        const changed = outputs.map((o, i) => (i === 2 ? `${o} Also fixed a typo.` : o));
        const b = await play(user, "b", changed);
        const before = llm.calls;
        expect(await play(user, "c", changed)).toEqual(b);
        expect(llm.calls).toBe(before);
        const diverged = pairing.records.filter((r) => r.kind === "divergedAt").map((r) => r.arm);
        expect(diverged).toEqual(["b", "c"]);
    });

    test("a replay source row missing a field is refused", () => {
        const root = dir();
        writeFileSync(
            join(root, "tape.jsonl"),
            '{"key":"k","event":"e","label":"task","digest":"d","stop":"end_turn"}\n',
        );
        writeFileSync(join(root, "pairing.jsonl"), "");
        expect(() => new Tape(join(dir(), "tape.jsonl"), [join(root, "tape.jsonl")])).toThrow(
            "text",
        );
        writeFileSync(
            join(root, "pairing.jsonl"),
            '{"kind":"turn","arm":"a","session":"s","event":"e","index":0}\n',
        );
        expect(
            () =>
                new Pairing(join(dir(), "pairing.jsonl"), () => "a", [join(root, "pairing.jsonl")]),
        ).toThrow("digest");
    });

    test("a replay source row with a wrongly typed field is refused", () => {
        const root = dir();
        writeFileSync(
            join(root, "tape.jsonl"),
            '{"key":123,"event":"e","label":"task","digest":"d","text":"t","stop":"end_turn"}\n',
        );
        writeFileSync(join(root, "pairing.jsonl"), "");
        expect(() => new Tape(join(dir(), "tape.jsonl"), [join(root, "tape.jsonl")])).toThrow(
            "key",
        );
        const row = {
            kind: "turn",
            arm: "a",
            session: "s",
            event: "e",
            index: "0",
            label: "task",
            delivered: true,
            digest: "d",
            context_sha256: "c",
            prefix_sha256: "p",
            text_sha256: "t",
            source: "script",
        };
        writeFileSync(join(root, "pairing.jsonl"), `${JSON.stringify(row)}\n`);
        expect(
            () =>
                new Pairing(join(dir(), "pairing.jsonl"), () => "a", [join(root, "pairing.jsonl")]),
        ).toThrow("index");
        writeFileSync(
            join(root, "pairing.jsonl"),
            `${JSON.stringify({ ...row, index: 0, label: "shout" })}\n`,
        );
        expect(
            () =>
                new Pairing(join(dir(), "pairing.jsonl"), () => "a", [join(root, "pairing.jsonl")]),
        ).toThrow("label");
    });

    test("a replay source that stopped short of this run is refused", () => {
        const root = dir();
        writeFileSync(join(root, "tape.jsonl"), "");
        writeFileSync(join(root, "pairing.jsonl"), "");
        const run = { seed: 101, scenario_hash: "abc", events: 10 };
        const manifest = (events: number) =>
            writeFileSync(
                join(root, "manifest.json"),
                JSON.stringify({ seed: 101, scenario_hash: "abc", events }),
            );
        manifest(10);
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).toThrow("journal.jsonl");
        writeFileSync(join(root, "journal.jsonl"), '{"kind":"StartRun"}\n');
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).toThrow("EndRun");
        writeFileSync(join(root, "journal.jsonl"), '{"kind":"StartRun"}\n{"kind":"EndRun"}\n');
        manifest(5);
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).toThrow("5 events");
        manifest(10);
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).not.toThrow();
    });

    test("a paste turn's record names its corpus item and byte length", async () => {
        const { user, pairing } = sim(dir(), counting());
        const paste: ScriptTurn = {
            id: "e-12",
            session: "s-3",
            index: 0,
            role: "paste",
            text: "Here's what I'm seeing:\n```\nabc\n```",
            paste: { sample_id: "out-0001", bytes: 3 },
        };
        await user.deliver("a", paste, "");
        expect(pairing.records.at(-1)).toMatchObject({
            kind: "turn",
            event: "e-12",
            paste: { sample_id: "out-0001", bytes: 3 },
        });
    });

    test("a replay source must have run every arm of this run", () => {
        const root = dir();
        writeFileSync(join(root, "tape.jsonl"), "");
        writeFileSync(join(root, "pairing.jsonl"), "");
        writeFileSync(
            join(root, "manifest.json"),
            JSON.stringify({ seed: 101, scenario_hash: "abc", order: ["eidnara"] }),
        );
        const run = { seed: 101, scenario_hash: "abc", order: ["host", "eidnara"] };
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).toThrow("host");
        expect(() =>
            checkTapeSources([join(root, "tape.jsonl")], { ...run, order: ["eidnara"] }),
        ).not.toThrow();
    });

    test("a replay source under another fault override is refused", () => {
        const root = dir();
        writeFileSync(join(root, "tape.jsonl"), "");
        writeFileSync(join(root, "pairing.jsonl"), "");
        writeFileSync(
            join(root, "manifest.json"),
            JSON.stringify({ seed: 101, scenario_hash: "abc", fault_override: [{ id: "f" }] }),
        );
        const run = { seed: 101, scenario_hash: "abc", fault_override: null };
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).toThrow("fault");
        expect(() =>
            checkTapeSources([join(root, "tape.jsonl")], { ...run, fault_override: [{ id: "f" }] }),
        ).not.toThrow();
    });

    test("a replay source must hold a turn record for every arm and event of this run", () => {
        const first = dir();
        const recordedRun = sim(first, counting());
        const a = script.slice(0, 4);
        for (const [i, t] of a.entries()) recordedRun.user.deliver("a", t, outputs[i] ?? "");
        writeFileSync(
            join(first, "manifest.json"),
            JSON.stringify({ seed: 101, scenario_hash: "abc", order: ["a"], events: 5 }),
        );
        writeFileSync(join(first, "journal.jsonl"), '{"kind":"EndRun"}\n');
        const run = {
            seed: 101,
            scenario_hash: "abc",
            order: ["a"],
            events: 5,
            turns: script.map((t) => t.id),
        };
        expect(() => checkTapeSources([join(first, "tape.jsonl")], run)).toThrow("a e-5");
    });

    test("a replay source must hold the taped reply for every recorded reactive turn", async () => {
        const first = dir();
        const recordedRun = sim(first, counting());
        await play(recordedRun.user, "a", outputs);
        writeFileSync(
            join(first, "manifest.json"),
            JSON.stringify({ seed: 101, scenario_hash: "abc", order: ["a"], events: 5 }),
        );
        writeFileSync(join(first, "journal.jsonl"), '{"kind":"EndRun"}\n');
        const run = {
            seed: 101,
            scenario_hash: "abc",
            order: ["a"],
            events: 5,
            turns: script.map((t) => t.id),
            scripted: new Map(script.map((t) => [t.id, t.text])),
        };
        expect(() => checkTapeSources([join(first, "tape.jsonl")], run)).not.toThrow();
        const rows = readFileSync(join(first, "tape.jsonl"), "utf8").trim().split("\n");
        writeFileSync(join(first, "tape.jsonl"), `${rows.slice(1).join("\n")}\n`);
        expect(() => checkTapeSources([join(first, "tape.jsonl")], run)).toThrow("a e-2");
    });

    test("a run's own logs are created as empty regular files, and any other object there is refused", () => {
        const root = dir();
        new Tape(join(root, "tape.jsonl"));
        new Pairing(join(root, "pairing.jsonl"), () => "a");
        expect(existsSync(join(root, "tape.jsonl"))).toBe(true);
        expect(existsSync(join(root, "pairing.jsonl"))).toBe(true);
        const other = dir();
        mkdirSync(join(other, "tape.jsonl"));
        expect(() => new Tape(join(other, "tape.jsonl"))).toThrow("regular file");
    });

    test("a generated reply that repeats a rendered ledger fact falls back", async () => {
        const replies = [
            { text: "The API key is in config/secrets.toml, as you said.", stop: "end_turn" },
        ];
        const llm: Llm = async () => replies.shift() ?? { text: "Fine.", stop: "end_turn" };
        const root = dir();
        const pairing = new Pairing(join(root, "pairing.jsonl"), () => "a");
        const user = new UserSim({
            seed: 101,
            plan,
            tape: new Tape(join(root, "tape.jsonl")),
            pairing,
            llm,
            normalise: normaliser(prereg.divergence_policy.normalisation),
            keys: ["f-0000"],
            facts: ["The API key is in config/secrets.toml"],
        });
        const d = await user.deliver("a", script[1] as ScriptTurn, "I read the parser.");
        expect(d.text).toStartWith("I'm not convinced by that.");
        const last = pairing.records.at(-1) as { fallback?: string[] };
        expect(last.fallback).toEqual(["fact"]);
    });

    test("a replay source from another pre-registration is refused", () => {
        const root = dir();
        writeFileSync(join(root, "tape.jsonl"), "");
        writeFileSync(join(root, "pairing.jsonl"), "");
        const run = { seed: 101, scenario_hash: "abc", prereg_sha256: "p1" };
        writeFileSync(
            join(root, "manifest.json"),
            JSON.stringify({ seed: 101, scenario_hash: "abc", prereg_sha256: "p2" }),
        );
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).toThrow("pre-registration");
    });

    test("a session that matches one source's digests at each event but neither source's history is a recorded divergence", async () => {
        const first = dir();
        await play(sim(first, counting()).user, "a", outputs);
        const second = dir();
        const changed = outputs.map((o, i) => (i >= 2 ? `${o} Also fixed a typo.` : o));
        await play(sim(second, counting()).user, "a", changed);
        const replay = counting();
        const both = [join(first, "tape.jsonl"), join(second, "tape.jsonl")];
        const again = sim(dir(), replay, "a", both);
        const mixed = outputs.map((o, i) => (i === 3 ? (changed[3] as string) : o));
        await play(again.user, "a", mixed);
        const diverged = again.pairing.records.filter((r) => r.kind === "divergedAt");
        expect(diverged).toHaveLength(1);
        expect(diverged[0]).toMatchObject({ index: 3, against: "recorded" });
        expect(replay.calls).toBe(1);
    });

    test("a skipped turn whose agent output differs from the reference's records the divergence", async () => {
        const { user, pairing } = sim(dir(), counting());
        const skip: ScriptTurn = {
            id: "e-10",
            session: "s-2",
            index: 3,
            role: "filler",
            text: "More.",
        };
        await user.deliver("a", skip, "Done it.");
        await user.deliver("b", skip, "Did something else.");
        const diverged = pairing.records.filter((r) => r.kind === "divergedAt");
        expect(diverged).toHaveLength(1);
        expect(diverged[0]).toMatchObject({ arm: "b", event: "e-10", index: 3 });
        expect(pairing.records.at(-1)).toMatchObject({ kind: "turn", arm: "b", delivered: false });
    });

    test("a corrupt terminated last line is refused however many bytes the earlier rows hold", () => {
        const root = dir();
        const wide = {
            key: "k",
            event: "e",
            label: "task",
            digest: "d",
            text: "ß".repeat(400),
            stop: "end_turn",
        };
        writeFileSync(join(root, "tape.jsonl"), `${JSON.stringify(wide)}\nnot json\n`);
        writeFileSync(join(root, "pairing.jsonl"), "");
        expect(() => new Tape(join(dir(), "tape.jsonl"), [join(root, "tape.jsonl")])).toThrow(
            "corrupt",
        );
    });

    test("a run's own tape or pairing log that is a symlink is refused", () => {
        const root = dir();
        const target = join(root, "elsewhere.jsonl");
        writeFileSync(target, "");
        symlinkSync(target, join(root, "tape.jsonl"));
        expect(() => new Tape(join(root, "tape.jsonl"))).toThrow("regular file");
        symlinkSync(target, join(root, "pairing.jsonl"));
        expect(() => new Pairing(join(root, "pairing.jsonl"), () => "a")).toThrow("regular file");
    });

    test("a complete but corrupt last line in a replay source is refused", () => {
        const root = dir();
        writeFileSync(
            join(root, "tape.jsonl"),
            '{"key":"k","text":"t","stop":"end_turn"}\nnot json\n',
        );
        writeFileSync(join(root, "pairing.jsonl"), "");
        expect(() => new Tape(join(dir(), "tape.jsonl"), [join(root, "tape.jsonl")])).toThrow(
            "corrupt",
        );
    });

    test("a reply that stopped for any reason other than a normal end falls back", async () => {
        const replies = [
            { text: "Blocked by policy.", stop: "guardrail_intervened" },
            { text: "Partial", stop: "model_context_window_exceeded" },
            { text: "Fine.", stop: "stop_sequence" },
        ];
        const llm: Llm = async () => replies.shift() ?? { text: "", stop: "end_turn" };
        const { user, pairing } = sim(dir(), llm);
        const texts = await play(user, "a", outputs);
        expect(texts[1]).toStartWith("I'm not convinced by that.");
        expect(texts[2]).toStartWith("I'm not convinced by that.");
        expect(texts[3]).toStartWith("Fine.");
        const fallbacks = pairing.records.map((r) => (r.kind === "turn" ? r.fallback : undefined));
        expect(fallbacks.slice(1, 4)).toEqual([
            ["guardrail_intervened"],
            ["model_context_window_exceeded"],
            undefined,
        ]);
    });

    test("a delivered text that carries a ledger key or probe id stops the run", async () => {
        const { user } = sim(dir(), counting());
        const leak: ScriptTurn = {
            id: "e-8",
            session: "s-2",
            index: 2,
            role: "filler",
            text: "Check f-0000 again.",
        };
        await expect(user.deliver("a", leak, "ok")).rejects.toThrow(
            "e-8: delivered text carries markers f-0000",
        );
    });
});
