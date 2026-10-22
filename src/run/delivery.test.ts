import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armProfile } from "../hosts/profiles";
import { qualificationHash } from "../prereg/qualification";
import type { ConverseBody } from "../proxy/classify";
import type { CallRecord } from "../proxy/records";
import { RequestStore, readRequestParts } from "../proxy/requests";
import { compileScenario, type Scenario, scenarioInputMismatch } from "../scenario/compile";
import { admittedArms, loadCompileInput, loadQualification } from "../scenario/inputs";
import { hashEmbedder } from "../scenario/similarity";
import { deliveryMismatches, type ExpectedNote, observeDelivery } from "./capabilities";
import { ORACLE_OPENING, oracleBackground } from "./oracle-note";
import { armOrder, oracleBackgrounds } from "./run";

const Q = loadQualification("Q");
const qualified = await compileScenario({
    ...loadCompileInput(101, "S", hashEmbedder, true),
    qualification: { sha256: qualificationHash(Q), controls: Q.controls },
});
const tier = await compileScenario(loadCompileInput(101, "S", hashEmbedder, true));
const keys = [
    ...qualified.facts.flatMap((f) => [f.id, f.template]),
    ...qualified.probes.map((p) => p.id),
];

describe("wrong-project lookup control", () => {
    test("Q asks every P8 lookup again in its twin, with the base project's value forbidden", () => {
        const p8 = qualified.probes.filter((p) => p.type === "P8");
        const twins = qualified.probes.filter((p) => p.type === "P8-twin");
        expect(twins).toHaveLength(p8.length);
        for (const twin of twins) {
            const base = p8.find((p) => p.fact === twin.fact);
            const value = (base?.check as { answer: string }).answer;
            expect(twin.project).toBe(`${base?.project}-twin`);
            expect(twin.check).toEqual({
                abstain: true,
                answer_must_not: [value],
                owner: base?.project,
            });
            expect(twin.ground_truth).toMatchObject({ expect: "abstain", absent: [value] });
            expect(twin.ground_truth?.sources).toEqual(base?.ground_truth?.sources);
        }
    });

    test("a tier compile adds no control and names no qualification", () => {
        expect(tier.probes.some((p) => p.type === "P8-twin")).toBe(false);
        expect(Object.hasOwn(tier.manifest, "qualification_sha256")).toBe(false);
        const inputs = {
            preregistration_sha256: tier.manifest.preregistration_sha256,
            corpus_inputs_sha256: tier.manifest.corpus_inputs_sha256,
        };
        const sha = qualificationHash(Q);
        expect(scenarioInputMismatch(tier, { ...inputs, qualification_sha256: null })).toBeNull();
        expect(scenarioInputMismatch(tier, { ...inputs, qualification_sha256: sha })).toMatch(
            /under qualification none/,
        );
        expect(
            scenarioInputMismatch(qualified, { ...inputs, qualification_sha256: sha }),
        ).toBeNull();
        expect(scenarioInputMismatch(qualified, { ...inputs, qualification_sha256: null })).toMatch(
            new RegExp(`under qualification ${sha}`),
        );
    });
});

describe("oracle note", () => {
    test("quotes a user-turn source under its own project and ends where the turn follows", () => {
        const twin = qualified.probes.find((p) => p.type === "P8-twin");
        const source = qualified.events.find((e) => e.id === twin?.ground_truth?.sources[0]);
        expect(oracleBackground(qualified, twin?.id as string)).toBe(
            `Background from earlier sessions on mini-redis, quoted as it came up:\n\nEarlier I wrote:\n> ${String(source?.text)}\n\nMy request now:\n`,
        );
    });

    test("quotes a committed file in a fence its content cannot close, and a removal by path", () => {
        const fake = {
            probes: [{ id: "q-1", ground_truth: { sources: ["e-2", "e-1", "e-3"] } }],
            sessions: [{ id: "s-1", project: "elysia" }],
            events: [
                { id: "e-1", kind: "user_turn", session: "s-1", text: "One.\n\nTwo." },
                {
                    id: "e-2",
                    kind: "apply_diff",
                    project: "elysia",
                    path: "a.md",
                    content: "x ``` y\n",
                },
                { id: "e-3", kind: "apply_diff", project: "elysia", path: "a.md", remove: true },
            ],
        } as unknown as Scenario;
        expect(oracleBackground(fake, "q-1")).toBe(
            "Background from earlier sessions on elysia, quoted as it came up:\n\nEarlier I wrote:\n> One.\n>\n> Two.\n\nCommitted then as a.md:\n````\nx ``` y\n````\n\na.md was removed from the repository.\n\nMy request now:\n",
        );
    });

    test("every probe turn with sources gets a marker-free note; a control gets none", () => {
        const notes = oracleBackgrounds(qualified, keys);
        const sourced = qualified.probes.filter((p) => (p.ground_truth?.sources ?? []).length > 0);
        expect([...notes.keys()].sort()).toEqual(sourced.map((p) => p.event as string).sort());
        const control = qualified.probes.find((p) => p.type === "P1-control");
        expect(notes.has(control?.event as string)).toBe(false);
        expect(oracleBackground(qualified, control?.id as string)).toBeNull();
    });

    test("a scenario whose own text holds the opening, or a note with a marker, refuses the run", () => {
        const events = [...qualified.events];
        const at = events.findIndex((e) => e.kind === "user_turn");
        events[at] = { ...events[at], text: `${ORACLE_OPENING}somewhere` } as (typeof events)[0];
        expect(() => oracleBackgrounds({ ...qualified, events }, keys)).toThrow(/opening/);
        expect(() => oracleBackgrounds(qualified, [...keys, "mini-redis"])).toThrow(
            /: oracle note carries markers mini-redis$/,
        );
    });
});

describe("delivery check", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sim-delivery-")));
    const store = new RequestStore(join(dir, "requests.jsonl"));
    let seq = 0;
    const call = (session: string, turn: string, user: string, system = "") => {
        const body: ConverseBody = {
            system: [{ text: system || "You are a coding agent." }],
            messages: [{ role: "user", content: [{ text: user }] }],
        };
        seq += 1;
        return { seq, component: "agent", session, turn, request: store.store(body) } as Pick<
            CallRecord,
            "seq" | "component" | "session" | "turn" | "request"
        >;
    };
    const order = new Map(["e-1", "e-2", "e-3", "e-4"].map((e, i) => [e, i]));
    const note: ExpectedNote = {
        event: "e-2",
        session: "s-1",
        background: `${ORACLE_OPENING}mini-redis, quoted as it came up:\n\nEarlier I wrote:\n> The alias is gilded-marmot-53.\n\nMy request now:\n`,
        text: "Which alias?",
        owed: true,
    };
    const parts = () => readRequestParts(join(dir, "requests.jsonl"));
    const check = (arm: string, calls: ReturnType<typeof call>[], notes: ExpectedNote[]) =>
        deliveryMismatches(armProfile(arm), observeDelivery(calls, parts(), notes, order));

    test("an oracle note in its turn and later in its session passes", () => {
        const calls = [
            call("s-1", "e-1", "First task."),
            call("s-1", "e-2", `${note.background}Which alias?`),
            call("s-1", "e-3", `${note.background}Which alias?\n\nNext task.`),
        ];
        expect(check("host-oracle", calls, [note])).toEqual([]);
        const seen = observeDelivery(calls, parts(), [note], order);
        expect(seen.notes).toEqual({ expected: 1, delivered: 1, missing: [], misplaced: [] });
    });

    test("a run with no owed note, or a note that reached no request of its turn, is invalid", () => {
        expect(check("host-oracle", [call("s-1", "e-1", "First task.")], [])).toEqual([
            "the arm reached no probe turn with sources, so it delivered no oracle note",
        ]);
        expect(check("host-oracle", [call("s-1", "e-2", "Which alias?")], [note])).toEqual([
            "1 oracle notes reached no prompt of their own turn: e-2",
        ]);
    });

    test("probes sharing sources share a note, and history alone does not deliver a turn's note", () => {
        const twin: ExpectedNote = { ...note, event: "e-3", text: "Again?" };
        const history = (turn: string, prompt: string): ReturnType<typeof call> => {
            const body: ConverseBody = {
                messages: [
                    { role: "user", content: [{ text: `${note.background}Which alias?` }] },
                    { role: "assistant", content: [{ text: "gilded-marmot-53" }] },
                    { role: "user", content: [{ text: prompt }] },
                ],
            };
            seq += 1;
            return { seq, component: "agent", session: "s-1", turn, request: store.store(body) };
        };
        const first = call("s-1", "e-2", `${note.background}Which alias?`);
        expect(
            check("host-oracle", [first, history("e-3", `${note.background}Again?`)], [note, twin]),
        ).toEqual([]);
        expect(check("host-oracle", [first, history("e-3", "Again?")], [note, twin])).toEqual([
            "1 oracle notes reached no prompt of their own turn: e-3",
        ]);
    });

    test("a note after the question, or one that replaced it, delivers nothing", () => {
        for (const prompt of [`Which alias?\n${note.background}`, note.background]) {
            expect(check("host-oracle", [call("s-1", "e-2", prompt)], [note])).toContain(
                "1 oracle notes reached no prompt of their own turn: e-2",
            );
        }
    });

    test("a recovered turn's note is placed where it appears and owes no delivery", () => {
        const recovered = { ...note, owed: false };
        const own = call("s-1", "e-2", `${note.background}Which alias?`);
        expect(check("host-oracle", [own], [recovered, { ...note, event: "e-3" }])).toEqual([
            "1 oracle notes reached no prompt of their own turn: e-3",
        ]);
        expect(check("host-oracle", [call("s-1", "e-2", "Which alias?")], [recovered])).toEqual([
            "the arm reached no probe turn with sources, so it delivered no oracle note",
        ]);
    });

    test("an owed note also in a system block, or prefixed twice, is misplaced", () => {
        const doubled = call("s-1", "e-2", `${note.background}${note.background}Which alias?`);
        const system = call("s-1", "e-2", `${note.background}Which alias?`, note.background);
        expect(check("host-oracle", [doubled, system], [note])).toEqual([
            `agent requests ${doubled.seq}, ${system.seq} carry an oracle note before its probe turn, in another session, or matching no owed note`,
        ]);
    });

    test("a note before its turn, in another session, or matching no owed note is misplaced", () => {
        const early = call("s-1", "e-1", `${note.background}First task.`);
        const elsewhere = call("s-2", "e-4", `${note.background}Other task.`);
        const stray = call("s-1", "e-3", `${ORACLE_OPENING}elysia, quoted as it came up:\n\nX`);
        const own = call("s-1", "e-2", `${note.background}Which alias?`);
        expect(check("host-oracle", [early, own, elsewhere, stray], [note])).toEqual([
            `agent requests ${early.seq}, ${elsewhere.seq}, ${stray.seq} carry an oracle note before its probe turn, in another session, or matching no owed note`,
        ]);
    });

    test("a note on another arm, and an injected block on the explicit-search arm, are mismatches", () => {
        const leaked = call("s-1", "e-2", `${note.background}Which alias?`);
        expect(check("host", [leaked], [])).toEqual([
            `agent requests ${leaked.seq} carry an oracle note on a host-only arm`,
        ]);
        const system = call("s-1", "e-2", "Which alias?", `${note.background}`);
        expect(check("host", [system], [])).toEqual([
            `agent requests ${system.seq} carry an oracle note on a host-only arm`,
        ]);
        const injected = call(
            "s-1",
            "e-2",
            "Which alias?",
            "<project-memory>\n- the alias is gilded-marmot-53\n</project-memory>",
        );
        expect(check("eidnara-search", [injected], [])).toEqual([
            "1 agent requests carry an Eidnara injected block, but the arm declares explicit search alone",
        ]);
        expect(check("eidnara", [injected], [])).toEqual([]);
    });

    test("a body that cannot be rebuilt leaves oracle and explicit-search delivery unproven", () => {
        const broken = { ...call("s-1", "e-2", "Which alias?") };
        broken.request = { ...(broken.request as NonNullable<typeof broken.request>), bytes: 1 };
        expect(check("host-oracle", [broken], [note])).toContain(
            "1 agent request bodies cannot be rebuilt to check oracle-context delivery",
        );
        expect(check("eidnara-search", [broken], [])).toEqual([
            "1 agent request bodies cannot be rebuilt to check explicit-search delivery",
        ]);
        expect(check("host", [broken], [])).toEqual([
            "1 agent request bodies cannot be rebuilt to check none delivery",
        ]);
    });
});

describe("arm order under a qualification", () => {
    const at = (seed: number, arms?: string[], host?: string) =>
        armOrder({ tier: "S", seed, arms, qualification: "Q", host });

    test("each seed runs its registered order, and a subset keeps it", () => {
        expect(at(101)).toEqual(["host", "eidnara", "host-oracle"]);
        expect(at(102)).toEqual(["host-oracle", "eidnara", "host"]);
        expect(at(102, ["host", "host-oracle"])).toEqual(["host-oracle", "host"]);
        expect(armOrder({ tier: "S", seed: 101 })).toEqual(["host", "eidnara", "eidnara-kl"]);
    });

    test("an unregistered arm, a refused arm, a foreign host, and a tier mismatch are refused", () => {
        expect(() => at(101, ["eidnara-kl"])).toThrow(/arms not in the qualification Q order/);
        expect(() => at(101, ["eidnara-search"])).toThrow(
            /arm capability refused: eidnara-search \(explicit-search-only\) needs memory_injection=switchable/,
        );
        expect(() => at(101, ["host~aa"])).toThrow(/arms not in the qualification Q order/);
        expect(() => at(101, undefined, "opencode")).toThrow(/qualification Q runs no opencode/);
        expect(() => armOrder({ tier: "M", seed: 201, qualification: "Q" })).toThrow(
            /qualification Q runs over tier S, not M/,
        );
        expect(() => armOrder({ tier: "S", seed: 101, qualification: "Z" })).toThrow(/Z\.json/);
    });
});

describe("persisted runs under a qualification", () => {
    const ref = { id: "Q", sha256: qualificationHash(Q) };

    test("the manifest, the scenario, and the registration name one qualification and host", () => {
        const at101 = { tier: "S" as const, host: "pi", seed: 101, order: ["host"] };
        expect(admittedArms({ ...at101, qualification: ref }, qualified)).toEqual({
            run: ["host", "eidnara", "host-oracle"],
            pairs: [],
        });
        expect(admittedArms({ tier: "S", host: "pi", qualification: null }, tier).run).toEqual([
            "host",
            "eidnara",
            "eidnara-kl",
        ]);
        expect(() => admittedArms({ tier: "S", host: "pi", qualification: ref }, tier)).toThrow(
            /compiled under qualification none, but the manifest names/,
        );
        expect(() => admittedArms({ tier: "S", host: "pi" }, qualified)).toThrow(
            /but the manifest names none/,
        );
        expect(() =>
            admittedArms({ ...at101, host: "opencode", qualification: ref }, qualified),
        ).toThrow(/qualification Q runs no opencode host/);
        expect(() =>
            admittedArms({ tier: "S", host: "pi", qualification: ref }, qualified),
        ).toThrow(/qualification Q runs no seed undefined/);
        const run = (seed: number, order: string[]) =>
            admittedArms({ tier: "S", host: "pi", seed, order, qualification: ref }, qualified);
        expect(run(102, ["host-oracle", "host"]).run).toContain("host-oracle");
        expect(() => run(102, ["host", "host-oracle"])).toThrow(/is not a subsequence/);
        expect(() => run(201, ["host"])).toThrow(/qualification Q runs no seed 201/);
        const stale = { ...ref, sha256: "0".repeat(64) };
        const scenario = {
            manifest: { ...qualified.manifest, qualification_sha256: stale.sha256 },
        };
        expect(() => admittedArms({ tier: "S", qualification: stale }, scenario)).toThrow(
            /prereg\/Q.json changed since the run recorded/,
        );
    });
});
