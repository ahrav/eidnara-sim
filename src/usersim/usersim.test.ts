import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrereg } from "../scenario/inputs";
import { behaviourPlan, type Label, type Plan, type PlanTurn, realisedRates } from "./plan";
import {
    type Llm,
    normaliser,
    Pairing,
    type PairingRecord,
    pairingMismatches,
    type ScriptTurn,
    Tape,
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
    const llm = (async (prompt: string) => {
        llm.calls++;
        llm.prompts.push(prompt);
        return { text: `reply ${llm.calls} to ${prompt.length}`, stop: "end_turn" };
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
    test("a replay against the recorded agent outputs repeats the user text with no live call", async () => {
        const first = dir();
        const live = counting();
        const recordedTexts = await play(sim(first, live).user, "a", outputs);
        expect(live.calls).toBe(3);
        expect(recordedTexts[1]).toStartWith("reply 1 to");
        expect(recordedTexts[1]).toEndWith("\n\nNow add a test.");
        expect(recordedTexts[0]).toBe("Look at the parser.");

        const replay = counting();
        const second = dir();
        const again = sim(second, replay, "a", [join(first, "tape.jsonl")]);
        expect(await play(again.user, "a", outputs)).toEqual(recordedTexts);
        expect(replay.calls).toBe(0);
        const sources = again.pairing.records.map((r) => (r.kind === "turn" ? r.source : r.kind));
        expect(sources).toEqual(["script", "tape", "tape", "tape", "script"]);
        const keys = (root: string) =>
            readFileSync(join(root, "tape.jsonl"), "utf8")
                .trim()
                .split("\n")
                .map((l) => (JSON.parse(l) as { key: string }).key);
        expect(keys(second)).toEqual(keys(first));
        const taped = again.pairing.records.filter((r) => r.kind === "turn" && r.source === "tape");
        expect(taped.map((r) => (r.kind === "turn" ? r.tape_key : undefined))).toEqual(keys(first));
    });

    test("one changed agent output gives one divergence record, written before the turn, and live replies after it", async () => {
        const root = dir();
        const llm = counting();
        const { user, pairing } = sim(root, llm);
        const reference = await play(user, "a", outputs);
        const before = llm.calls;
        const changed = [...outputs];
        changed[2] = "Added parser_test.rs and fixed a typo.";
        const texts: string[] = [];
        for (const [i, t] of script.entries()) {
            texts.push((await user.deliver("b", t, changed[i] ?? "")).text);
            const onDisk = readFileSync(join(root, "pairing.jsonl"), "utf8").trim().split("\n");
            const last = JSON.parse(onDisk.at(-1) ?? "{}") as PairingRecord;
            expect([last.kind, last.event]).toEqual(["turn", t.id]);
        }
        const divergences = pairing.records.filter((r) => r.kind === "divergedAt");
        expect(divergences).toHaveLength(1);
        expect(divergences[0]).toMatchObject({ arm: "b", session: "s-1", event: "e-3", index: 2 });
        expect(llm.calls - before).toBe(2);
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
});
