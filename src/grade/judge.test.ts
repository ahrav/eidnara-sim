import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Rng } from "../rng";
import { loadPrereg } from "../scenario/inputs";
import { type CallView, GradeRefused, type Snapshot } from "./artefacts";
import {
    BlindingRefused,
    blind,
    CALIBRATION_SCHEMA,
    type CalibrationSet,
    calibrationDigest,
    gradeP7,
    humanCheckSample,
    type JudgeClient,
    judgeIdentity,
    judgePair,
    normalise,
    type Pair,
    p7Pair,
    pairDigests,
    parseVerdict,
    permutationCheck,
    proxyJudge,
    type RawVerdict,
} from "./judge";

const rules = loadPrereg("S").grading;
const DIR = join(import.meta.dir, "../../tests/fixtures/grade");
const load = (name: string) =>
    JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as {
        probe: { id: string; check: { judge: string } };
        pair: Pair;
        judge_verdicts: Record<string, RawVerdict>;
        expect: { a: string; b: string };
    };

const agentCall = (response_text: string): CallView => {
    const view = {
        seq: 1,
        component: "agent",
        turn: "e-1",
        scenario_ms: 0,
        status: 200,
        error: null,
        input_tokens: 1,
        output_tokens: 1,
        response_text,
    };
    return view;
};

function scripted(verdicts: Record<string, RawVerdict>): JudgeClient & { prompts: string[] } {
    const prompts: string[] = [];
    return {
        prompts,
        identity: judgeIdentity(rules.judge.model),
        async verdict(prompt) {
            prompts.push(prompt);
            return verdicts[prompts.length === 1 ? "a_then_b" : "b_then_a"] as RawVerdict;
        },
    };
}

const calibration = (pairs = 25, human = 20): CalibrationSet => {
    const labels = Object.fromEntries(
        Array.from({ length: pairs }, (_, i) => [`p${i}`, "a" as const]),
    );
    return {
        schema: CALIBRATION_SCHEMA,
        judge: judgeIdentity(rules.judge.model),
        labels,
        human: Object.keys(labels).slice(0, human),
    };
};

const context = (item: string, pair: Pair, extra: Partial<Parameters<typeof gradeP7>[1]> = {}) => ({
    item,
    answers: pairDigests(pair),
    snapshots: { a: "snap-eidnara", b: "snap-host" },
    arms: { a: "eidnara", b: "host" },
    inputs: ["snap-eidnara:calls", "snap-host:calls"],
    later_attempts: { a: 0, b: 0 },
    calibration: null,
    permutation: { trials: 20, correct: 11 },
    ...extra,
});

describe("P7 judge path", () => {
    for (const name of ["P7-pass", "P7-fail", "P7-inconsistent"]) {
        test(`${name} grades both arms as recorded, judged in both orders`, async () => {
            const f = load(name);
            const client = scripted(f.judge_verdicts);
            const judgment = await judgePair(client, f.pair, f.probe.check.judge, ["CANARY-7f3"]);
            expect(client.prompts).toHaveLength(2);
            expect(client.prompts[0]).toContain(`First answer:\n${normalise(f.pair.a)}`);
            expect(client.prompts[1]).toContain(`First answer:\n${normalise(f.pair.b)}`);
            for (const prompt of client.prompts) expect(prompt).not.toMatch(/eidnara|host/i);
            const grades = gradeP7(judgment, context(f.probe.id, f.pair), rules);
            expect(grades.map((g) => g.verdict)).toEqual([f.expect.a, f.expect.b] as never);
            for (const g of grades) {
                expect(g.metrics.judge_model).toBe("global.openai.gpt-5.6-luna");
                expect(g.metrics.verdict_a_then_b).toBe(f.judge_verdicts.a_then_b as RawVerdict);
                expect(g.metrics.verdict_b_then_a).toBe(f.judge_verdicts.b_then_a as RawVerdict);
                expect([g.metrics.permutation, g.metrics.permutation_counts]).toEqual([
                    "pass",
                    "11/20",
                ]);
                expect([g.metrics.calibration_digest, g.metrics.gate_eligible]).toEqual([
                    "none",
                    false,
                ]);
                expect(g.inputs).toEqual(["snap-eidnara:calls", "snap-host:calls"]);
                if (name === "P7-inconsistent") {
                    expect([g.reason, g.metrics["P7.pass"]]).toEqual(["Inconsistent", undefined]);
                }
            }
        });
    }

    test("a pair is built from the two snapshots' answers, and a transcript artefact is refused", () => {
        const snap = (id: string, text: string): Snapshot => ({
            id,
            item: "q-1",
            arm: id,
            turn: "e-1",
            turn_outcome: "ok",
            artefacts: [
                {
                    id: `${id}:calls`,
                    class: "proxy-call",
                    calls: [agentCall(text)],
                },
            ],
        });
        const built = p7Pair("q-1", snap("eidnara", "because A"), snap("host", "no idea"));
        expect([built?.pair.a, built?.pair.b, built?.inputs]).toEqual([
            "because A",
            "no idea",
            ["eidnara:calls", "host:calls"],
        ]);
        const leak = snap("host", "x");
        (leak.artefacts as unknown[]).push({ id: "t", class: "transcript" });
        expect(() => p7Pair("q-1", snap("eidnara", "a"), leak)).toThrow(GradeRefused);
        expect(() => p7Pair("q-1", snap("eidnara", "a"), snap("host", " "))).toThrow(
            "answer b is empty",
        );
    });

    test("a grade is gate-eligible only with a valid calibration set and a passing permutation check", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const ok = gradeP7(
            judgment,
            context(f.probe.id, f.pair, { calibration: calibration() }),
            rules,
        );
        expect(ok[0]?.metrics.gate_eligible).toBe(true);
        expect(ok[0]?.metrics.calibration_digest).toMatch(/^[0-9a-f]{64}$/);
        const identified = context(f.probe.id, f.pair, {
            calibration: calibration(),
            permutation: { trials: 20, correct: 13 },
        });
        const refused = gradeP7(judgment, identified, rules)[0];
        expect(refused?.metrics.gate_eligible).toBe(false);
        expect(String(refused?.metrics.permutation)).toContain("refused");
        const bad = context(f.probe.id, f.pair, { calibration: calibration(25, 19) });
        const badSet = gradeP7(judgment, bad, rules)[0];
        expect([badSet?.metrics.gate_eligible, String(badSet?.metrics.calibration)]).toEqual([
            false,
            "refused: calibration has 19 human labels; needs 20",
        ]);
    });

    test("blinding refuses a canary and an arm name, however it is disguised", () => {
        const base = { id: "p", a: "fine", b: "fine" };
        expect(() =>
            blind({ ...base, a: "uses CANARY-7f3 here" }, "a_then_b", "r", ["CANARY-7f3"]),
        ).toThrow(BlindingRefused);
        const leaks = [
            "the Eidnara search found it",
            "the fresh-arm answer",
            "arm\u200b a",
            "ｅｉｄｎａｒａ",
        ];
        for (const leak of leaks) {
            expect(() => blind({ ...base, b: leak }, "a_then_b", "r", [])).toThrow("names an arm");
        }
        expect(() =>
            blind({ ...base, a: "the harm bound held" }, "a_then_b", "r", []),
        ).not.toThrow();
    });

    test("the verbosity audit reaches the grade", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const [a] = gradeP7(judgment, context(f.probe.id, f.pair), rules);
        expect((a?.metrics.length_a as number) > (a?.metrics.length_b as number)).toBe(true);
        expect(a?.metrics.longer_recalled_alone).toBe(true);
    });

    test("the permutation check refuses arm identification above the ceiling in either direction", () => {
        expect(() => permutationCheck(20, 12, rules)).not.toThrow();
        expect(() => permutationCheck(20, 13, rules)).toThrow("identified the arms in 13 of 20");
        expect(() => permutationCheck(20, 7, rules)).toThrow("identified the arms in 13 of 20");
        expect(() => permutationCheck(0, 0, rules)).toThrow("no trials");
    });

    test("a calibration set has a digest only above the floors and with consistent labels", () => {
        expect(calibrationDigest(calibration(), rules)).toMatch(/^[0-9a-f]{64}$/);
        expect(calibrationDigest(null, rules)).toBeNull();
        expect(() => calibrationDigest(calibration(25, 19), rules)).toThrow("needs 20");
        expect(() => calibrationDigest(calibration(19, 19), rules)).toThrow("19 pairs");
        const other = { ...calibration(), schema: "eval-judge/v1" } as unknown as CalibrationSet;
        expect(() => calibrationDigest(other, rules)).toThrow("calibration schema");
        expect(() =>
            calibrationDigest({ ...calibration(), human: ["nope", ...calibration().human] }, rules),
        ).toThrow("names no calibration pair");
        const twice = { ...calibration(), human: Array.from({ length: 20 }, () => "p0") };
        expect(() => calibrationDigest(twice, rules)).toThrow("twice");
        const odd = calibration();
        (odd.labels as Record<string, string>).p1 = "Inconsistent";
        expect(() => calibrationDigest(odd, rules)).toThrow("not a, b, both, or neither");
        const blank = calibration();
        blank.labels[" "] = "a";
        expect(() => calibrationDigest(blank, rules)).toThrow("blank");
    });

    test("a calibration set from another judge identity is refused and keeps the grade out of gates", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const foreign = {
            ...calibration(),
            judge: judgeIdentity("global.anthropic.claude-haiku-5-5"),
        };
        const [g] = gradeP7(judgment, context(f.probe.id, f.pair, { calibration: foreign }), rules);
        expect([g?.metrics.gate_eligible, g?.metrics.calibration_digest]).toEqual([false, "none"]);
        expect(String(g?.metrics.calibration)).toContain("refused: calibration judge");
        const stale = {
            ...calibration(),
            judge: { ...judgeIdentity(rules.judge.model), rubric_digest: "0" },
        };
        expect(
            gradeP7(judgment, context(f.probe.id, f.pair, { calibration: stale }), rules)[0]
                ?.metrics.gate_eligible,
        ).toBe(false);
    });

    test("a human label names an own calibration pair, not an inherited property", () => {
        const set = calibration(25, 19);
        set.human.push("toString");
        expect(() => calibrationDigest(set, rules)).toThrow("names no calibration pair");
    });

    test("the permutation check refuses counts that are not whole numbers", () => {
        expect(() => permutationCheck(1.5, 0.75, rules)).toThrow(GradeRefused);
        expect(() => permutationCheck(20, -1, rules)).toThrow(GradeRefused);
        expect(() => permutationCheck(Number.NaN, 0, rules)).toThrow(GradeRefused);
    });

    test("an invisible mark used as a word separator still exposes an arm name", () => {
        const base = { id: "p", a: "fine", b: "fine" };
        for (const leak of [
            "arm\u200ba",
            "the fresh\u200barm answer",
            "host\u00adarm",
            "eid\u200bnara",
        ]) {
            expect(() => blind({ ...base, b: leak }, "a_then_b", "r", [])).toThrow("names an arm");
        }
    });

    test("normalisation keeps content between inline triple backticks and drops fence lines", () => {
        expect(normalise("The reason is ```allocation dominated p99```.")).toBe(
            "The reason is allocation dominated p99.",
        );
        expect(normalise("```allocation dominated p99```")).toBe("allocation dominated p99");
        expect(normalise("before\n```ts\nconst x = 1;\n```\nafter")).toBe(
            "before const x = 1; after",
        );
    });

    test("the pair takes its item, arms, and outcome from the snapshots", () => {
        const snap = (
            arm: string,
            item = "q-1",
            outcome: Snapshot["turn_outcome"] = "ok",
        ): Snapshot => ({
            id: `snap-${arm}`,
            item,
            arm,
            turn: "e-1",
            turn_outcome: outcome,
            artefacts: [
                {
                    id: `${arm}:calls`,
                    class: "proxy-call",
                    calls: [agentCall("because")],
                },
            ],
        });
        const built = p7Pair("q-1", snap("eidnara"), snap("host"));
        expect([built?.snapshots, built?.arms]).toEqual([
            { a: "snap-eidnara", b: "snap-host" },
            { a: "eidnara", b: "host" },
        ]);
        expect(() => p7Pair("q-1", snap("eidnara", "q-2"), snap("host"))).toThrow("mix items");
        expect(() => p7Pair("q-1", snap("eidnara"), snap("eidnara"))).toThrow("one arm");
        expect(p7Pair("q-1", snap("eidnara"), snap("host", "q-1", "failed"))).toBeNull();
    });

    test("each P7 grade counts its own arm's later attempts", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const grades = gradeP7(
            judgment,
            context(f.probe.id, f.pair, { later_attempts: { a: 2, b: 0 } }),
            rules,
        );
        expect(grades.map((g) => g.later_attempts_logged)).toEqual([2, 0]);
    });

    test("a judgment from a judge other than the pre-registered one stays out of gates", async () => {
        const f = load("P7-pass");
        const other = scripted(f.judge_verdicts);
        other.identity = judgeIdentity("global.meta.llama-4-maverick");
        const judgment = await judgePair(other, f.pair, f.probe.check.judge, []);
        const matching = { ...calibration(), judge: other.identity };
        const [g] = gradeP7(
            judgment,
            context(f.probe.id, f.pair, { calibration: matching }),
            rules,
        );
        expect(g?.metrics.gate_eligible).toBe(false);
        expect(String(g?.metrics.calibration)).toContain("refused: judgment judge");
    });

    test("calibration labels decoded as an array are refused", () => {
        const arrayed = {
            ...calibration(),
            labels: Array.from({ length: 25 }, () => "a"),
            human: Array.from({ length: 20 }, (_, i) => String(i)),
        } as unknown as CalibrationSet;
        expect(() => calibrationDigest(arrayed, rules)).toThrow(GradeRefused);
    });

    test("an arm name or canary split by emphasis marks is caught after normalisation", () => {
        const base = { id: "p", a: "fine", b: "fine" };
        expect(() => blind({ ...base, b: "Ei**dnara found it" }, "a_then_b", "r", [])).toThrow(
            "names an arm",
        );
        expect(() => blind({ ...base, b: "the `host`**arm**" }, "a_then_b", "r", [])).toThrow(
            "names an arm",
        );
        expect(() =>
            blind({ ...base, a: "uses CAN**ARY-7f3 here" }, "a_then_b", "r", ["CANARY-7f3"]),
        ).toThrow(BlindingRefused);
    });

    test("human sample ids must be strings, so numeric twins cannot pad the sample", () => {
        const numericKeys = Object.fromEntries(
            Array.from({ length: 25 }, (_, i) => [String(i), "a" as const]),
        );
        const twins = {
            ...calibration(),
            labels: numericKeys,
            human: Array.from({ length: 10 }, (_, i) => [i, String(i)]).flat(),
        } as unknown as CalibrationSet;
        expect(() => calibrationDigest(twins, rules)).toThrow(GradeRefused);
        const mixed = { ...calibration(), human: [0, ...calibration().human.slice(1)] };
        expect(() => calibrationDigest(mixed as unknown as CalibrationSet, rules)).toThrow(
            "not a string",
        );
    });

    test("an arm name or canary split by visible punctuation is caught in its joined form", () => {
        const base = { id: "p", a: "fine", b: "fine" };
        for (const leak of ["eid-nara", "e.i.d.n.a.r.a", "the eid nara index"]) {
            expect(() => blind({ ...base, b: leak }, "a_then_b", "r", [])).toThrow("names an arm");
        }
        expect(() =>
            blind({ ...base, a: "uses CAN-ARY-7f3 here" }, "a_then_b", "r", ["CANARY-7f3"]),
        ).toThrow(BlindingRefused);
        expect(() =>
            blind({ ...base, a: "refresh armour and pharmacy" }, "a_then_b", "r", []),
        ).not.toThrow();
    });

    test("a judgment grades only the item its context names", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        expect(() => gradeP7(judgment, context("q-other", f.pair), rules)).toThrow(GradeRefused);
    });

    test("the reference reason is blinded like the answers", () => {
        const pair = { id: "p", a: "fine", b: "fine" };
        expect(() => blind(pair, "a_then_b", "the host arm said so", [])).toThrow("names an arm");
        expect(() => blind(pair, "a_then_b", "see CANARY-7f3", ["CANARY-7f3"])).toThrow(
            BlindingRefused,
        );
        expect(blind(pair, "a_then_b", "allocation dominated", []).reference).toBe(
            "allocation dominated",
        );
    });

    test("an answer that is only formatting is refused as empty", () => {
        const snap = (arm: string, text: string): Snapshot => ({
            id: `snap-${arm}`,
            item: "q-1",
            arm,
            turn: "e-1",
            turn_outcome: "ok",
            artefacts: [{ id: `${arm}:calls`, class: "proxy-call", calls: [agentCall(text)] }],
        });
        for (const blank of ["**", "```\n```", "__ ** `"]) {
            expect(() => p7Pair("q-1", snap("eidnara", "because"), snap("host", blank))).toThrow(
                "answer b is empty",
            );
        }
    });

    test("the permutation check refuses counts beyond the safe-integer range", () => {
        expect(() => permutationCheck(1e307, 1e307, rules)).toThrow(GradeRefused);
        expect(() => permutationCheck(Number.MAX_SAFE_INTEGER + 2, 1, rules)).toThrow(GradeRefused);
    });

    test("a calibration pair id made of invisible characters is blank", () => {
        const ghost = calibration();
        ghost.labels["\u200b\u200b"] = "a";
        expect(() => calibrationDigest(ghost, rules)).toThrow("blank");
    });

    test("a judgment grades only the answers it judged", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        expect(judgment.answers).toEqual(pairDigests(f.pair));
        const other = { ...f.pair, b: `${f.pair.b} and more` };
        expect(() => gradeP7(judgment, context(f.probe.id, other), rules)).toThrow(GradeRefused);
    });

    test("compatibility spellings of an arm name are folded before blinding", () => {
        const base = { id: "p", a: "fine", b: "fine" };
        for (const leak of [
            "\u{1d556}\u{1d55a}\u{1d555}\u{1d55f}\u{1d552}\u{1d563}\u{1d552}",
            "ⓔⓘⓓⓝⓐⓡⓐ",
            "ｅｉｄｎａｒａ",
        ]) {
            expect(() => blind({ ...base, b: leak }, "a_then_b", "r", [])).toThrow("names an arm");
        }
    });

    test("a fence opener with spaced metadata is dropped whole", () => {
        expect(normalise('```ts title="allocation dominated"\nconst x = 1;\n```')).toBe(
            "const x = 1;",
        );
        expect(normalise("   ``` rust ignore\nfn f() {}\n```")).toBe("fn f() {}");
    });

    test("the human-check sample is ten percent of P7 items, rounded up, from a seeded draw", () => {
        const items = Array.from({ length: 24 }, (_, i) => `q-${i}`);
        const a = humanCheckSample(items, rules, new Rng(9));
        expect(a).toHaveLength(3);
        expect(humanCheckSample(items, rules, new Rng(9))).toEqual(a);
    });
});

describe("proxy judge", () => {
    let server: ReturnType<typeof Bun.serve> | null = null;
    afterEach(() => server?.stop(true));

    test("each verdict request goes through the proxy as component judge, from another model family", async () => {
        const seen: { path: string; header: string | null; body: unknown }[] = [];
        server = Bun.serve({
            port: 0,
            async fetch(req) {
                const path = new URL(req.url).pathname;
                seen.push({
                    path,
                    header: req.headers.get("x-sim-component"),
                    body: await req.json(),
                });
                const content = [{ reasoningContent: {} }, { text: "Second." }];
                return Response.json({ output: { message: { content } } });
            },
        });
        const url = `http://127.0.0.1:${server.port}`;
        expect(() =>
            proxyJudge(
                url,
                "global.anthropic.claude-haiku-5-5",
                "global.anthropic.claude-opus-5-5",
            ),
        ).toThrow(GradeRefused);
        expect(() => proxyJudge(url, "global.cohere.command-a", "global.cohere.command-r")).toThrow(
            "no known family",
        );
        const judge = proxyJudge(url, rules.judge.model, "global.anthropic.claude-opus-5-5");
        expect(await judge.verdict("prompt")).toBe("second");
        expect(seen[0]?.path).toBe(`/model/${encodeURIComponent(rules.judge.model)}/converse`);
        expect(seen[0]?.header).toBe("judge");
        expect(parseVerdict(" Second.\n")).toBe("second");
        expect(() => parseVerdict("the first one")).toThrow("is not a verdict");
    });

    test("a failed judge call is refused before its body is read", async () => {
        server = Bun.serve({ port: 0, fetch: () => new Response("not json", { status: 502 }) });
        const judge = proxyJudge(
            `http://127.0.0.1:${server.port}`,
            rules.judge.model,
            "anthropic.x",
        );
        await expect(judge.verdict("prompt")).rejects.toThrow("judge call failed: 502");
    });

    test("a judge call that never completes is refused at its deadline", async () => {
        server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
        const judge = proxyJudge(
            `http://127.0.0.1:${server.port}`,
            rules.judge.model,
            "anthropic.x",
            { deadlineMs: 50 },
        );
        await expect(judge.verdict("prompt")).rejects.toThrow("judge call timed out");
    });

    test("a well-formed status with a malformed body is a judge refusal, not a crash", async () => {
        const bodies = [
            { output: { message: { content: { text: "first" } } } },
            { output: { message: { content: [{ text: 7 }] } } },
            "first",
        ];
        let i = 0;
        server = Bun.serve({ port: 0, fetch: () => Response.json(bodies[i++ % bodies.length]) });
        const judge = proxyJudge(
            `http://127.0.0.1:${server.port}`,
            rules.judge.model,
            "anthropic.x",
        );
        for (const _ of bodies) await expect(judge.verdict("prompt")).rejects.toThrow(GradeRefused);
    });
});
