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
import { sha256Hex } from "../prereg/canonical";
import { loadPrereg } from "../scenario/inputs";
import {
    beganAt,
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
    CLARIFY_REPLIES,
    checkTapeSources,
    clarifyContexts,
    factMatcher,
    identityStatements,
    type Llm,
    normaliser,
    Pairing,
    type PairingRecord,
    type Prompt,
    pairingMismatches,
    proxyUserSim,
    REACTIVE_PUSHBACK,
    type ScriptTurn,
    sessionRules,
    Tape,
    tapeDigests,
    tapeKey,
    tapeMismatches,
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

    test("a snapshot's user-sim entries carry the time the turn began", () => {
        const entries = [
            { kind: "BeginTurn", arm: "a", event: "e-1", scenario_ms: 10 },
            {
                kind: "UserTurn",
                arm: "a",
                event: "e-1",
                scenario_ms: 90,
                label: "pushback",
                delivered: true,
            },
            { kind: "BeginTurn", arm: "b", event: "e-1", scenario_ms: 20 },
        ];
        expect(beganAt(entries, "a").get("e-1")).toBe(10);
        const labelled = withUserLabels(
            [],
            [entries[1] as Record<string, unknown>],
            new Map(),
            beganAt(entries, "a"),
        );
        expect(labelled[0]).toMatchObject({ scenario_ms: 10, label: "pushback" });
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

interface RecordedClarify {
    run: string;
    seq: number;
    turn: ScriptTurn;
    request: string;
    facts: string[];
    agent: string;
    old_reply: string;
    classified: string;
}
const clarifyCalls = (
    JSON.parse(
        readFileSync(join(import.meta.dir, "../../tests/fixtures/usersim/c7-clarify.json"), "utf8"),
    ) as { calls: RecordedClarify[] }
).calls;

describe("clarify replies on recorded c7 calls", () => {
    const clarifySim = (c: RecordedClarify, prompts: Prompt[], answer = c.classified) => {
        const root = dir();
        const pairing = new Pairing(join(root, "pairing.jsonl"), () => "a");
        const user = new UserSim({
            seed: 101,
            plan: { labels: new Map(), skipped: new Set(), interruptMs: new Map() } as Plan,
            tape: new Tape(join(root, "tape.jsonl")),
            pairing,
            llm: async (p) => {
                prompts.push(p);
                return { text: answer, stop: "end_turn" };
            },
            normalise: normaliser(prereg.divergence_policy.normalisation),
            keys: ["f-0000"],
            clarifyContext: () => ({ request: c.request, facts: c.facts }),
        });
        return { user, pairing };
    };

    test("the recorded calls cover both answers across the host, eidnara, and oracle arms, and every recorded reply was free text", () => {
        const word = (c: RecordedClarify) => c.classified.split(/\s+/)[0];
        expect(new Set(clarifyCalls.map((c) => `${c.run.split("-").at(-1)} ${word(c)}`))).toEqual(
            new Set(["eidnara SETTLED", "eidnara OPEN", "host SETTLED", "oracle OPEN"]),
        );
        for (const c of clarifyCalls) {
            expect(Object.values(CLARIFY_REPLIES)).not.toContain(c.old_reply);
        }
    });

    test("each recorded question gets the fixed reply for its classification and none of the recorded specifics", async () => {
        for (const c of clarifyCalls) {
            const prompts: Prompt[] = [];
            const { user, pairing } = clarifySim(c, prompts);
            const d = await user.deliver("a", c.turn, c.agent);
            const fixed = c.classified.startsWith("SETTLED")
                ? CLARIFY_REPLIES.settled
                : CLARIFY_REPLIES.open;
            expect([c.seq, d.label, d.text]).toEqual([
                c.seq,
                "clarify",
                `${fixed}\n\n${c.turn.text}`,
            ]);
            expect(pairing.records.at(-1)).not.toHaveProperty("fallback");
            const prompt = prompts[0] as Prompt;
            expect(prompt.system).toContain("Output exactly one word, SETTLED or OPEN.");
            expect(prompt.user).toContain(c.request);
            for (const f of c.facts) expect(prompt.user).toContain(f);
            expect(prompt.user).toContain(c.agent.slice(-200));
        }
    });

    test("a recorded tape replays each classification and an unread one; a pre-classification reply passes only its own run's check", async () => {
        const c = clarifyCalls[0] as RecordedClarify;
        const scripted = new Map([[c.turn.id, c.turn.text]]);
        for (const answer of ["SETTLED", "OPEN", "Rename the three tests."]) {
            const root = dir();
            const { user, pairing } = (() => {
                const pairing = new Pairing(join(root, "pairing.jsonl"), () => "a");
                const user = new UserSim({
                    seed: 101,
                    plan: { labels: new Map(), skipped: new Set(), interruptMs: new Map() } as Plan,
                    tape: new Tape(join(root, "tape.jsonl")),
                    pairing,
                    llm: async () => ({ text: answer, stop: "end_turn" }),
                    normalise: normaliser(prereg.divergence_policy.normalisation),
                    keys: ["f-0000"],
                    clarifyContext: () => ({ request: c.request, facts: c.facts }),
                });
                return { user, pairing };
            })();
            await user.deliver("a", c.turn, c.agent);
            const rows = pairing.records;
            const tape = join(root, "tape.jsonl");
            expect([answer, tapeMismatches(tape, rows, 101, scripted)]).toEqual([answer, []]);
            const entry = JSON.parse(readFileSync(tape, "utf8").trim());
            writeFileSync(
                tape,
                `${JSON.stringify({ ...entry, text: answer === "OPEN" ? "SETTLED" : "OPEN" })}\n`,
            );
            expect(tapeMismatches(tape, rows, 101, scripted)).toEqual([
                "a e-recorded".replace("e-recorded", c.turn.id),
            ]);
        }
        const root = dir();
        const tape = join(root, "tape.jsonl");
        const free = "Open the config file and rename those three tests to match.";
        const row = {
            kind: "turn",
            arm: "a",
            session: c.turn.session,
            event: c.turn.id,
            index: c.turn.index,
            label: "clarify",
            delivered: true,
            digest: "d",
            context_sha256: "ctx",
            prefix_sha256: "p",
            text_sha256: sha256Hex(`${free}\n\n${c.turn.text}`),
            source: "live",
        } as PairingRecord;
        const key = tapeKey(101, c.turn.id, "clarify", "ctx", c.turn.text);
        writeFileSync(
            tape,
            `${JSON.stringify({ key, event: c.turn.id, label: "clarify", digest: "d", text: free, stop: "end_turn" })}\n`,
        );
        expect(tapeMismatches(tape, [row], 101, scripted, undefined, true)).toEqual([]);
        expect(tapeMismatches(tape, [row], 101, scripted)).toEqual([`a ${c.turn.id}`]);
    });

    test("a classification whose rationale repeats a fact still delivers its fixed reply", async () => {
        const c = clarifyCalls.find((x) => x.facts.length > 0) as RecordedClarify;
        const fact = c.facts[0] as string;
        const root = dir();
        const pairing = new Pairing(join(root, "pairing.jsonl"), () => "a");
        const user = new UserSim({
            seed: 101,
            plan: { labels: new Map(), skipped: new Set(), interruptMs: new Map() } as Plan,
            tape: new Tape(join(root, "tape.jsonl")),
            pairing,
            llm: async () => ({ text: `SETTLED - ${fact}`, stop: "end_turn" }),
            normalise: normaliser(prereg.divergence_policy.normalisation),
            keys: ["f-0000"],
            facts: [fact],
            statements: [fact],
            clarifyContext: () => ({ request: c.request, facts: c.facts }),
        });
        const d = await user.deliver("a", c.turn, c.agent);
        expect(d.text).toStartWith(CLARIFY_REPLIES.settled);
        expect(pairing.records.at(-1)).not.toHaveProperty("fallback");
        const scripted = new Map([[c.turn.id, c.turn.text]]);
        const named = factMatcher([fact], [fact]);
        expect(
            tapeMismatches(join(root, "tape.jsonl"), pairing.records, 101, scripted, named),
        ).toEqual([]);
        const stale = pairing.records.map((r) =>
            r.kind === "turn"
                ? {
                      ...r,
                      fallback: ["fact"],
                      text_sha256: sha256Hex(`Use your best judgement on that.\n\n${c.turn.text}`),
                  }
                : r,
        );
        expect(tapeMismatches(join(root, "tape.jsonl"), stale, 101, scripted, named)).toEqual([
            `a ${c.turn.id}`,
        ]);
    });

    test("a classification that is neither word gets the clarify fallback line and records why", async () => {
        const c = clarifyCalls[0] as RecordedClarify;
        const { user, pairing } = clarifySim(c, [], "Rename the three tests to match the script.");
        const d = await user.deliver("a", c.turn, c.agent);
        expect(d.text).toStartWith("Use your best judgement on that.");
        expect((pairing.records.at(-1) as { fallback?: string[] }).fallback).toEqual(["unread"]);
    });
});

describe("clarify context", () => {
    const events = [
        { id: "e-0", kind: "session_start", session: "s-1", project: "svc" },
        {
            id: "e-1",
            kind: "user_turn",
            session: "s-1",
            index: 0,
            role: "reversal",
            fact: "f-1",
            text: "For the record, the metrics port is 11111.",
        },
        {
            id: "e-2",
            kind: "apply_diff",
            session: "s-1",
            project: "svc",
            fact: "f-2",
            path: "notes/a.md",
        },
        {
            id: "e-3",
            kind: "user_turn",
            session: "s-1",
            index: 1,
            role: "filler",
            text: "Add a ping test.",
        },
        {
            id: "e-4",
            kind: "user_turn",
            session: "s-1",
            index: 2,
            role: "conveyance",
            fact: "f-1",
            text: "Scratch what I said earlier: the metrics port is 41234.",
        },
        {
            id: "e-5",
            kind: "user_turn",
            session: "s-1",
            index: 3,
            role: "filler",
            text: "Tidy the README.",
        },
        {
            id: "e-6",
            kind: "user_turn",
            session: "s-1",
            index: 4,
            role: "update",
            fact: "f-3",
            text: "Change of plan for next time: drop A; the next step is B instead.",
        },
        {
            id: "e-7",
            kind: "user_turn",
            session: "s-1",
            index: 5,
            role: "probe",
            fact: "f-2",
            probe: "q-1",
            text: "Who owns the checklist?",
        },
        {
            id: "e-8",
            kind: "user_turn",
            session: "s-1",
            index: 6,
            role: "status",
            fact: "f-3",
            text: "That covers B; consider that plan finished.",
        },
        { id: "e-9", kind: "session_start", session: "s-2", project: "pkg" },
        {
            id: "e-10",
            kind: "user_turn",
            session: "s-2",
            index: 0,
            role: "conveyance",
            fact: "f-4",
            text: "x",
        },
        {
            id: "e-11",
            kind: "user_turn",
            session: "s-1",
            index: 7,
            role: "conveyance",
            fact: "f-5",
            text: "y",
        },
        {
            id: "e-12",
            kind: "user_turn",
            session: "s-1",
            index: 8,
            role: "filler",
            text: "Run it.",
        },
    ];
    const facts = [
        { id: "f-1", statement: "the metrics port is 41234", supersedes: null },
        { id: "f-2", statement: "nobody owns the release checklist", supersedes: null },
        { id: "f-3", statement: "when we pick this back up, the next step is A", supersedes: null },
        { id: "f-4", statement: "the other project's rule", supersedes: null },
        { id: "f-5", statement: "the metrics port moved from 41234 to 51234", supersedes: "f-1" },
    ];
    const ctx = clarifyContexts(events, facts);
    const turn = (id: string) => {
        const e = events.find((x) => x.id === id) as unknown as ScriptTurn;
        return { ...e, text: String(e.text) };
    };

    test("a reversal reads as said until the true conveyance replaces it", () => {
        expect(ctx(turn("e-3"))).toEqual({
            request: "For the record, the metrics port is 11111.",
            facts: [
                "For the record, the metrics port is 11111.",
                "nobody owns the release checklist",
            ],
        });
        expect(ctx(turn("e-5")).facts).toEqual([
            "the metrics port is 41234",
            "nobody owns the release checklist",
        ]);
    });

    test("an update and a status turn add what they said, a probe adds nothing, and a revision supersedes", () => {
        expect(ctx(turn("e-12"))).toEqual({
            request: "y",
            facts: [
                "nobody owns the release checklist",
                "Change of plan for next time: drop A; the next step is B instead.",
                "That covers B; consider that plan finished.",
                "the metrics port moved from 41234 to 51234",
            ],
        });
        expect(ctx(turn("e-1"))).toEqual({ request: "", facts: [] });
    });
});

describe("reactive pushback in a P14 window", () => {
    test("inside a window the pushback follows the agent's last turn; outside it the plan stands", async () => {
        const prompts: Prompt[] = [];
        const llm: Llm = async (p) => {
            prompts.push(p);
            return { text: "Why that change?", stop: "end_turn" };
        };
        const root = dir();
        const pairing = new Pairing(join(root, "pairing.jsonl"), () => "a");
        const broke: Record<string, boolean> = { "e-2": false, "e-4": true, "e-5": true };
        const user = new UserSim({
            seed: 101,
            plan,
            tape: new Tape(join(root, "tape.jsonl")),
            pairing,
            llm,
            normalise: normaliser(prereg.divergence_policy.normalisation),
            keys: ["f-0000"],
            brokeRule: (_arm, t) => broke[t.id] ?? null,
        });
        const got: [string, boolean][] = [];
        for (const t of script) {
            const d = await user.deliver("a", t, "I read the parser.");
            got.push([d.label, d.reactive === true]);
            if (t.id === "e-4") expect(d.text).toBe(`${REACTIVE_PUSHBACK}\n\n${t.text}`);
        }
        expect(got).toEqual([
            ["task", false],
            ["task", true],
            ["pushback", false],
            ["pushback", true],
            ["interrupt", false],
        ]);
        expect(prompts.length).toBe(1);
        const rows = pairing.records.filter((r) => r.kind === "turn") as { reactive?: true }[];
        expect(rows.map((r) => r.reactive === true)).toEqual([false, true, false, true, false]);
    });

    test("the realised pushback rate leaves reactive turns out", () => {
        const turns = [
            { session: "s-1", label: "pushback" as Label },
            { session: "s-1", label: "task" as Label },
            { session: "s-1", label: "pushback" as Label, reactive: true },
            { session: "s-1", label: "task" as Label, reactive: true },
        ];
        expect(realisedRates(turns, prereg).rates.pushback_per_turn).toBe(0.5);
    });
});

describe("session rules in force", () => {
    const events = [
        { id: "e-0", kind: "session_start", session: "s-1", project: "svc" },
        {
            id: "e-1",
            kind: "user_turn",
            session: "s-1",
            index: 0,
            role: "conveyance",
            fact: "f-1",
            text: "tag",
        },
        { id: "e-2", kind: "user_turn", session: "s-1", index: 1, role: "filler", text: "x" },
        {
            id: "e-3",
            kind: "user_turn",
            session: "s-1",
            index: 2,
            role: "conveyance",
            fact: "f-2",
            text: "retag",
        },
        { id: "e-4", kind: "user_turn", session: "s-1", index: 3, role: "filler", text: "y" },
        { id: "e-5", kind: "user_turn", session: "s-1", index: 4, role: "filler", text: "z" },
        {
            id: "e-6",
            kind: "user_turn",
            session: "s-1",
            index: 5,
            role: "conveyance",
            fact: "f-3",
            text: "lookup",
        },
        { id: "e-7", kind: "user_turn", session: "s-1", index: 6, role: "filler", text: "w" },
    ];
    const facts = [
        { id: "f-1", kind: "session_rule", supersedes: null },
        { id: "f-2", kind: "session_rule", supersedes: "f-1" },
        { id: "f-3", kind: "lookup", supersedes: null },
    ];
    const probes = [
        {
            type: "P13",
            fact: "f-1",
            session: "s-1",
            check: { commands_must: ["old"], turns: [1, 3] },
        },
        {
            type: "P13",
            fact: "f-2",
            session: "s-1",
            check: { commands_must: ["new"], turns: [3, 6] },
        },
        { type: "P8", fact: "f-3", session: "s-1", check: { answer: "v" } },
        {
            type: "P14",
            fact: null,
            session: "s-1",
            check: { window_from_turn: 1, window_to_turn: 2 },
        },
        {
            type: "P14",
            fact: null,
            session: "s-1",
            check: { window_from_turn: 3, window_to_turn: 7 },
        },
    ];
    const rules = sessionRules(events, facts, probes);
    const turn = (id: string) => events.find((e) => e.id === id) as unknown as ScriptTurn;

    test("outside every window the plan decides; inside, the latest revision's check stands", () => {
        expect(rules(turn("e-1"))).toBeNull();
        expect(rules(turn("e-3"))).toBeNull();
        expect(rules(turn("e-2"))).toEqual([{ commands_must: ["old"] }]);
        expect(rules(turn("e-4"))).toEqual([{ commands_must: ["new"] }]);
        expect(rules(turn("e-7"))).toEqual([{ commands_must: ["new"] }]);
    });
});

describe("fact identities", () => {
    test("a plan's repository code stays open to replies while its generated token stays a fact", () => {
        const facts = [
            {
                kind: "plan",
                statement:
                    "when we pick this back up, the next step is adding a brisk_otter_count field in src/connection.rs that counts the frames read_frame has returned",
            },
            { kind: "rejected", statement: "we ruled out spawn_blocking for the snapshot write" },
        ];
        const named = factMatcher(
            identityStatements(facts),
            facts.map((f) => f.statement),
        );
        expect(named("Your read_frame change drops buffered bytes.")).toBe(false);
        expect(named("Drop the brisk_otter_count field.")).toBe(true);
        expect(named("Is BRISK_OTTER really needed?")).toBe(true);
        expect(named("Why not spawn_blocking here?")).toBe(true);
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

    test("each proxied user-sim call opens its own connection to the gateway", async () => {
        const ports: number[] = [];
        const server = Bun.serve({
            port: 0,
            fetch: (req, srv) => {
                ports.push(srv.requestIP(req)?.port ?? -1);
                return Response.json({
                    output: { message: { content: [{ text: "ok" }] } },
                    stopReason: "end_turn",
                });
            },
        });
        try {
            const llm = proxyUserSim(`http://127.0.0.1:${server.port}`, "m", 100, 5_000);
            await llm({ system: "s", user: "one" });
            await llm({ system: "s", user: "two" });
            expect(ports).toHaveLength(2);
            expect(ports[0]).not.toBe(ports[1]);
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
        writeFileSync(
            join(root, "journal.jsonl"),
            '{"seq":0,"wall_ms":0,"kind":"StartRun","arm":null,"scenario_ms":0}\n',
        );
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).toThrow("EndRun");
        writeFileSync(
            join(root, "journal.jsonl"),
            '{"seq":0,"wall_ms":0,"kind":"StartRun","arm":null,"scenario_ms":0}\n{"seq":1,"wall_ms":0,"kind":"EndRun","arm":null,"scenario_ms":0}\n',
        );
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

    test("a replay source run under another turn scheduling rule is refused", () => {
        const root = dir();
        writeFileSync(join(root, "tape.jsonl"), "");
        writeFileSync(join(root, "pairing.jsonl"), "");
        const source = (m: object) =>
            writeFileSync(
                join(root, "manifest.json"),
                JSON.stringify({ seed: 101, scenario_hash: "abc", ...m }),
            );
        const run = { seed: 101, scenario_hash: "abc", turns_await_jobs: false };
        source({ turns_await_jobs: true });
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).toThrow("turns_await_jobs");
        source({});
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).toThrow("turns_await_jobs");
        expect(() =>
            checkTapeSources([join(root, "tape.jsonl")], { ...run, turns_await_jobs: true }),
        ).not.toThrow();
        source({ turns_await_jobs: false });
        expect(() => checkTapeSources([join(root, "tape.jsonl")], run)).not.toThrow();
        // Only a missing field reads as the earlier rule; an explicit non-boolean matches neither.
        source({ turns_await_jobs: null });
        expect(() =>
            checkTapeSources([join(root, "tape.jsonl")], { ...run, turns_await_jobs: true }),
        ).toThrow("turns_await_jobs null");
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
        writeFileSync(
            join(first, "journal.jsonl"),
            '{"seq":0,"wall_ms":0,"kind":"EndRun","arm":null,"scenario_ms":0}\n',
        );
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
        writeFileSync(
            join(first, "journal.jsonl"),
            '{"seq":0,"wall_ms":0,"kind":"EndRun","arm":null,"scenario_ms":0}\n',
        );
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

    test("a live pushback that names a ledger fact's identity falls back, and the prompt holds conveyed facts settled", async () => {
        const withdrawal =
            "I'd like to see the evidence behind that rejected-approach memory before it stays in the project record. Can you point me to the commit, issue, or benchmark where the blocking pool starvation was actually observed? Without that, I'd rather not have a memory entry that steers future work away from `spawn_blocking` on hearsay.";
        const replies: [string, boolean][] = [
            [withdrawal, true],
            ["Why did the test skip the empty-frame case?", false],
            ["Just move it onto SPAWN_BLOCKING.", true],
            ["Did you check ticket 55174 first?", true],
            ["Name it SABLE_URCHIN_MAX_KEYS?", true],
            ["Is the SABLE_URCHIN prefix right here?", true],
            ["Rerun it with RUST_BACKTRACE=1 and check key_len.", false],
            ["Why does pewter_gecko_roundtrip still fail?", true],
            ["Is that a TawnyEgretError again?", true],
            ["Drop the quiet_hare tag from the errors.", true],
            ["Rename ping_echo_quiet_vole first.", true],
            ["Is tawny-egret-14 the right alias?", true],
            ["Does respawn_blocking_ok still pass?", false],
            ["The quiet hare test is flaky; check 155174 bytes.", false],
        ];
        const queue = replies.map(([text]) => ({ text, stop: "end_turn" }));
        const prompts: Prompt[] = [];
        const llm: Llm = async (p) => {
            prompts.push(p);
            return queue.shift() ?? { text: "Fine.", stop: "end_turn" };
        };
        const pushback = (n: number): ScriptTurn => ({
            ...(script[1] as ScriptTurn),
            id: `e-p${n}`,
            index: n,
        });
        const root = dir();
        const pairing = new Pairing(join(root, "pairing.jsonl"), () => "a");
        const turns = replies.map((_r, i) => i + 1);
        const labels = new Map(turns.map((n) => [`e-p${n}`, "pushback" as Label]));
        const statements = [
            "moving command execution onto spawn_blocking was tried and reverted because it starved the runtime's blocking pool",
            "the internal ticket for the cache rewrite is 55174",
            "every new public constant under src/cmd carries the SABLE_URCHIN_ prefix, for example SABLE_URCHIN_MAX_ARGS",
            "error strings returned from src/cmd start with the tag [quiet_hare]",
            "test functions you add end their names with _quiet_vole",
        ];
        const paste =
            "CI went red:\n```\ntest pewter_gecko_roundtrip ... FAILED\nTawnyEgretError { key_len: 57585 }\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace\n```";
        const user = new UserSim({
            seed: 101,
            plan: { ...plan, labels },
            tape: new Tape(join(root, "tape.jsonl")),
            pairing,
            llm,
            normalise: normaliser(prereg.divergence_policy.normalisation),
            keys: ["f-0032"],
            facts: [...statements, paste],
            statements,
        });
        const agent =
            "I saved that as a rejected approach in project memory. I'm relying on what you've told me here.";
        const seen: [string, boolean][] = [];
        for (const n of turns) {
            const d = await user.deliver("a", pushback(n), `${agent} (${n})`);
            const record = pairing.records.at(-1) as { fallback?: string[] };
            const [text] = replies[n - 1] as [string, boolean];
            const fell = record.fallback !== undefined;
            expect(record.fallback ?? ["fact-token"]).toEqual(["fact-token"]);
            expect(d.text.startsWith(fell ? "I'm not convinced by that." : text)).toBe(true);
            seen.push([text, fell]);
        }
        expect(seen).toEqual(replies);
        const system = prompts[0]?.system ?? "";
        expect(system).toContain("says it saved to memory or notes, is true and settled");
        expect(system).toContain("never ask for its source or evidence");
        expect(system).toContain("change, archive, forget, or delete it");
    });

    test("a replay source's fact-token causes must match the run's identity check", async () => {
        const first = dir();
        const statements = ["the internal ticket for the cache rewrite is 55174"];
        const user = new UserSim({
            seed: 101,
            plan,
            tape: new Tape(join(first, "tape.jsonl")),
            pairing: new Pairing(join(first, "pairing.jsonl"), () => "a"),
            llm: async () => ({ text: "Check ticket 55174 first.", stop: "end_turn" }),
            normalise: normaliser(prereg.divergence_policy.normalisation),
            keys: ["f-0000", "q-0001"],
            facts: statements,
            statements,
        });
        await play(user, "a", outputs);
        writeFileSync(
            join(first, "manifest.json"),
            JSON.stringify({ seed: 101, scenario_hash: "abc", order: ["a"], events: 5 }),
        );
        writeFileSync(
            join(first, "journal.jsonl"),
            '{"seq":0,"wall_ms":0,"kind":"EndRun","arm":null,"scenario_ms":0}\n',
        );
        const run = {
            seed: 101,
            scenario_hash: "abc",
            order: ["a"],
            events: 5,
            turns: script.map((t) => t.id),
            scripted: new Map(script.map((t) => [t.id, t.text])),
        };
        const tape = [join(first, "tape.jsonl")];
        const same = { ...run, namesFact: factMatcher(statements, statements) };
        expect(() => checkTapeSources(tape, same)).not.toThrow();
        expect(() => checkTapeSources(tape, run)).not.toThrow();
        expect(() => checkTapeSources(tape, { ...run, namesFact: () => false })).toThrow("a e-2");
        const plain = dir();
        await play(sim(plain, counting()).user, "a", outputs);
        writeFileSync(join(plain, "manifest.json"), readFileSync(join(first, "manifest.json")));
        writeFileSync(join(plain, "journal.jsonl"), readFileSync(join(first, "journal.jsonl")));
        const older = [join(plain, "tape.jsonl")];
        expect(() => checkTapeSources(older, run)).not.toThrow();
        expect(() => checkTapeSources(older, { ...run, namesFact: () => true })).toThrow("a e-2");
    });

    test("a replay source's taped reply must be the one its pairing row delivered", async () => {
        const first = dir();
        await play(sim(first, counting()).user, "a", outputs);
        writeFileSync(
            join(first, "manifest.json"),
            JSON.stringify({ seed: 101, scenario_hash: "abc", order: ["a"], events: 5 }),
        );
        writeFileSync(
            join(first, "journal.jsonl"),
            '{"seq":0,"wall_ms":0,"kind":"EndRun","arm":null,"scenario_ms":0}\n',
        );
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
        const edited = rows.map((l, i) =>
            i === 0 ? JSON.stringify({ ...JSON.parse(l), text: "something else" }) : l,
        );
        writeFileSync(join(first, "tape.jsonl"), `${edited.join("\n")}\n`);
        expect(() => checkTapeSources([join(first, "tape.jsonl")], run)).toThrow("a e-2");
    });

    test("a replay source's taped reply must still classify as its pairing row did", async () => {
        const first = dir();
        await play(sim(first, counting()).user, "a", outputs);
        writeFileSync(
            join(first, "manifest.json"),
            JSON.stringify({ seed: 101, scenario_hash: "abc", order: ["a"], events: 5 }),
        );
        writeFileSync(
            join(first, "journal.jsonl"),
            '{"seq":0,"wall_ms":0,"kind":"EndRun","arm":null,"scenario_ms":0}\n',
        );
        const run = {
            seed: 101,
            scenario_hash: "abc",
            order: ["a"],
            events: 5,
            turns: script.map((t) => t.id),
            scripted: new Map(script.map((t) => [t.id, t.text])),
        };
        const rows = readFileSync(join(first, "tape.jsonl"), "utf8").trim().split("\n");
        const edited = rows.map((l, i) =>
            i === 0 ? JSON.stringify({ ...JSON.parse(l), stop: "max_tokens" }) : l,
        );
        writeFileSync(join(first, "tape.jsonl"), `${edited.join("\n")}\n`);
        expect(() => checkTapeSources([join(first, "tape.jsonl")], run)).toThrow("a e-2");
    });

    test("a replay source artefact that is not a regular file is refused", () => {
        const root = dir();
        mkdirSync(join(root, "tape.jsonl"));
        writeFileSync(join(root, "pairing.jsonl"), "");
        expect(() => new Tape(join(dir(), "tape.jsonl"), [join(root, "tape.jsonl")])).toThrow(
            "regular file",
        );
    });

    test("a replay source's manifest or journal that is not a regular file is refused", () => {
        const root = dir();
        writeFileSync(join(root, "tape.jsonl"), "");
        writeFileSync(join(root, "pairing.jsonl"), "");
        mkdirSync(join(root, "manifest.json"));
        expect(() =>
            checkTapeSources([join(root, "tape.jsonl")], { seed: 101, scenario_hash: "abc" }),
        ).toThrow("regular file");
    });

    test("a pairing row's fallback, when present, names at least one cause", () => {
        const root = dir();
        const row = {
            kind: "turn",
            arm: "a",
            session: "s",
            event: "e",
            index: 0,
            label: "pushback",
            delivered: true,
            digest: "d",
            context_sha256: "c",
            prefix_sha256: "p",
            text_sha256: "t",
            source: "tape",
            fallback: [],
        };
        writeFileSync(join(root, "pairing.jsonl"), `${JSON.stringify(row)}\n`);
        expect(
            () =>
                new Pairing(join(dir(), "pairing.jsonl"), () => "a", [join(root, "pairing.jsonl")]),
        ).toThrow("fallback");
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
