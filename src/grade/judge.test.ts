import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../prereg/canonical";
import { Rng } from "../rng";
import type { ProbeItem } from "../scenario/compile";
import { loadPrereg } from "../scenario/inputs";
import { type CallView, GradeRefused, type Snapshot } from "./artefacts";
import {
    BlindingRefused,
    blind,
    CALIBRATION_SCHEMA,
    type CalibrationSet,
    calibrationDigest,
    EMPTY_PROMPT,
    gradeP7,
    humanCheckSample,
    type JudgeClient,
    type Judgment,
    judgeIdentity,
    judgePair,
    judgePrompt,
    normalise,
    type Pair,
    PREPROCESSING_VERSION,
    p7Pair,
    pairDigests,
    parseVerdict,
    permutationCheck,
    proxyJudge,
    type RawVerdict,
    referenceDigest,
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

const agentCall = (response_text: string, arm = "eidnara", session = "s-1"): CallView => {
    const view = {
        seq: 1,
        arm,
        session,
        component: "agent",
        turn: "e-1",
        scenario_ms: 0,
        status: 200,
        error: null,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        response_text,
    };
    return view;
};

const snapshotOf = (
    id: string,
    arm: string,
    text: string,
    item = "q-1",
    outcome: Snapshot["turn_outcome"] = "ok",
): Snapshot => {
    const view = {
        id,
        item,
        arm,
        session: "s-1",
        turn: "e-1",
        turn_outcome: outcome,
        artefacts: [
            { id: `${id}:calls`, class: "proxy-call" as const, calls: [agentCall(text, arm)] },
        ],
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

const crossJudged = (set: CalibrationSet) => ({
    judge: judgeIdentity(rules.judge.cross_judge),
    calibration_digest: calibrationDigest(set, rules) as string,
});

const probeOf = (id: string, judge: string): ProbeItem => ({
    id,
    type: "P7",
    fact: null,
    project: "mini-redis",
    session: "s-1",
    text: null,
    check: { judge },
});

const context = (
    item: string,
    pair: Pair,
    reference: string,
    extra: Partial<Parameters<typeof gradeP7>[1]> = {},
) => ({
    probe: probeOf(item, reference),
    snapshots: {
        a: [snapshotOf("snap-eidnara", "eidnara", pair.a, item)],
        b: [snapshotOf("snap-host", "host", pair.b, item)],
    },
    calibration: null,
    permutation: { trials: 20, correct: 11, judge: judgeIdentity(rules.judge.model) },
    cross_judge: null,
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
            const grades = gradeP7(
                judgment,
                context(f.probe.id, f.pair, f.probe.check.judge),
                rules,
            );
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
        const snap = (id: string, text: string) => snapshotOf(id, id, text);
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
        const set = calibration();
        const ok = gradeP7(
            judgment,
            context(f.probe.id, f.pair, f.probe.check.judge, {
                calibration: set,
                cross_judge: crossJudged(set),
            }),
            rules,
        );
        expect(ok[0]?.metrics.gate_eligible).toBe(true);
        const unchecked = gradeP7(
            judgment,
            context(f.probe.id, f.pair, f.probe.check.judge, { calibration: set }),
            rules,
        )[0];
        expect([unchecked?.metrics.cross_judge, unchecked?.metrics.gate_eligible]).toEqual([
            "none",
            false,
        ]);
        const otherJudge = gradeP7(
            judgment,
            context(f.probe.id, f.pair, f.probe.check.judge, {
                calibration: set,
                cross_judge: { ...crossJudged(set), judge: judgeIdentity(rules.judge.model) },
            }),
            rules,
        )[0];
        expect(String(otherJudge?.metrics.cross_judge)).toContain("refused: cross-judge judge");
        const otherSet = gradeP7(
            judgment,
            context(f.probe.id, f.pair, f.probe.check.judge, {
                calibration: set,
                cross_judge: { ...crossJudged(set), calibration_digest: "0" },
            }),
            rules,
        )[0];
        expect(String(otherSet?.metrics.cross_judge)).toContain(
            "refused: cross-judge labelled another",
        );
        expect(ok[0]?.metrics.calibration_digest).toMatch(/^[0-9a-f]{64}$/);
        const identified = context(f.probe.id, f.pair, f.probe.check.judge, {
            calibration: calibration(),
            permutation: { trials: 20, correct: 13, judge: judgeIdentity(rules.judge.model) },
        });
        const refused = gradeP7(judgment, identified, rules)[0];
        expect(refused?.metrics.gate_eligible).toBe(false);
        expect(String(refused?.metrics.permutation)).toContain("refused");
        const bad = context(f.probe.id, f.pair, f.probe.check.judge, {
            calibration: calibration(25, 19),
        });
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
        const [a] = gradeP7(judgment, context(f.probe.id, f.pair, f.probe.check.judge), rules);
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
        const [g] = gradeP7(
            judgment,
            context(f.probe.id, f.pair, f.probe.check.judge, { calibration: foreign }),
            rules,
        );
        expect([g?.metrics.gate_eligible, g?.metrics.calibration_digest]).toEqual([false, "none"]);
        expect(String(g?.metrics.calibration)).toContain("refused: calibration judge");
        const stale = {
            ...calibration(),
            judge: { ...judgeIdentity(rules.judge.model), rubric_digest: "0" },
        };
        expect(
            gradeP7(
                judgment,
                context(f.probe.id, f.pair, f.probe.check.judge, { calibration: stale }),
                rules,
            )[0]?.metrics.gate_eligible,
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
        const snap = (arm: string, item = "q-1", outcome: Snapshot["turn_outcome"] = "ok") =>
            snapshotOf(`snap-${arm}`, arm, "because", item, outcome);
        const built = p7Pair("q-1", snap("eidnara"), snap("host"));
        expect([built?.snapshots, built?.arms]).toEqual([
            { a: "snap-eidnara", b: "snap-host" },
            { a: "eidnara", b: "host" },
        ]);
        expect(() => p7Pair("q-1", snap("eidnara", "q-2"), snap("host"))).toThrow("mix items");
        expect(() => p7Pair("q-1", snap("eidnara"), snap("eidnara"))).toThrow("same snapshot");
        const twin = { ...snap("host"), id: "snap-host-run2" };
        expect(p7Pair("q-1", snap("host"), twin)?.arms).toEqual({ a: "host", b: "host" });
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
        const retry = (n: number) =>
            snapshotOf(`snap-eidnara-${n}`, "eidnara", "later", f.probe.id);
        const grades = gradeP7(
            judgment,
            context(f.probe.id, f.pair, f.probe.check.judge, {
                snapshots: {
                    a: [
                        snapshotOf("snap-eidnara", "eidnara", f.pair.a, f.probe.id),
                        retry(2),
                        retry(3),
                    ],
                    b: [snapshotOf("snap-host", "host", f.pair.b, f.probe.id)],
                },
            }),
            rules,
        );
        expect(grades.map((g) => g.later_attempts_logged)).toEqual([2, 0]);
        expect(grades[0]?.snapshot).toBe("snap-eidnara");
        const mixed = context(f.probe.id, f.pair, f.probe.check.judge, {
            snapshots: {
                a: [
                    snapshotOf("snap-eidnara", "eidnara", f.pair.a, f.probe.id),
                    snapshotOf("x", "host", "later", f.probe.id),
                ],
                b: [snapshotOf("snap-host", "host", f.pair.b, f.probe.id)],
            },
        });
        expect(() => gradeP7(judgment, mixed, rules)).toThrow("mix items or arms");
        const empty = context(f.probe.id, f.pair, f.probe.check.judge, {
            snapshots: { a: [], b: [snapshotOf("snap-host", "host", f.pair.b, f.probe.id)] },
        });
        expect(() => gradeP7(judgment, empty, rules)).toThrow("has no snapshot");
    });

    test("a judgment from a judge other than the pre-registered one stays out of gates", async () => {
        const f = load("P7-pass");
        const other = scripted(f.judge_verdicts);
        other.identity = judgeIdentity("global.meta.llama-4-maverick");
        const judgment = await judgePair(other, f.pair, f.probe.check.judge, []);
        const matching = { ...calibration(), judge: other.identity };
        const [g] = gradeP7(
            judgment,
            context(f.probe.id, f.pair, f.probe.check.judge, { calibration: matching }),
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
        expect(() =>
            gradeP7(judgment, context("q-other", f.pair, f.probe.check.judge), rules),
        ).toThrow(GradeRefused);
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
        const snap = (arm: string, text: string) => snapshotOf(`snap-${arm}`, arm, text);
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
        expect(() =>
            gradeP7(judgment, context(f.probe.id, other, f.probe.check.judge), rules),
        ).toThrow(GradeRefused);
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

    test("a judgment grades only under the reference it was judged against", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        expect(judgment.reference).toBe(referenceDigest(f.probe.check.judge));
        const stale = context(f.probe.id, f.pair, "another reason entirely");
        expect(() => gradeP7(judgment, stale, rules)).toThrow(GradeRefused);
    });

    test("the permutation ceiling is compared exactly at large safe counts", () => {
        expect(() => permutationCheck(9007199254740981, 5404319552844589, rules)).toThrow(
            "identified the arms",
        );
    });

    test("triple emphasis marks and link destinations are formatting", () => {
        for (const blank of ["***", "___", "*** ___"]) expect(normalise(blank)).toBe("");
        expect(normalise("see [the docs](https://example.test/x) now")).toBe("see the docs now");
        expect(normalise("![alt text](img.png)")).toBe("alt text");
        const base = { id: "p", a: "fine", b: "fine" };
        expect(() =>
            blind({ ...base, b: "[Eid](https://example.test)nara found it" }, "a_then_b", "r", []),
        ).toThrow("names an arm");
    });

    test("the model family is the provider segment of the model id", () => {
        const url = "http://127.0.0.1:1";
        expect(() =>
            proxyJudge(url, "global.cohere.openai-command", "global.cohere.anthropic-command"),
        ).toThrow("no known family");
        expect(() => proxyJudge(url, "us.openai.gpt-5.6-luna", "anthropic.x")).not.toThrow();
        expect(() => proxyJudge(url, "openai.gpt-5.6-luna", "us.anthropic.x")).not.toThrow();
    });

    test("a judgment whose recall disagrees with its order verdicts is refused", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const flipped = { ...judgment, recall: { a: false, b: true } };
        expect(() =>
            gradeP7(flipped, context(f.probe.id, f.pair, f.probe.check.judge), rules),
        ).toThrow(GradeRefused);
    });

    test("permutation evidence from another judge keeps the grade out of gates", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const foreign = {
            calibration: calibration(),
            permutation: { trials: 20, correct: 11, judge: judgeIdentity("global.meta.llama-4") },
        };
        const [g] = gradeP7(
            judgment,
            context(f.probe.id, f.pair, f.probe.check.judge, foreign),
            rules,
        );
        expect(g?.metrics.gate_eligible).toBe(false);
        expect(String(g?.metrics.permutation)).toContain("refused: permutation judge");
    });

    test("a judgment with order verdicts outside the four words is refused", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const garbage = {
            ...judgment,
            orders: {
                a_then_b: "garbage",
                b_then_a: "garbage",
            } as unknown as typeof judgment.orders,
            recall: { a: false, b: false },
        };
        expect(() =>
            gradeP7(garbage, context(f.probe.id, f.pair, f.probe.check.judge), rules),
        ).toThrow("is not a verdict");
    });

    test("reference-style links keep their label and lose identifier and definition", () => {
        expect(normalise("see [the docs][x] now\n\n[x]: https://example.test/x")).toBe(
            "see the docs now",
        );
        const base = { id: "p", a: "fine", b: "fine" };
        expect(() =>
            blind(
                { ...base, b: "[Eid][x]nara found it\n[x]: https://example.test" },
                "a_then_b",
                "r",
                [],
            ),
        ).toThrow("names an arm");
    });

    test("HTML markup and entities are folded before blinding", () => {
        const base = { id: "p", a: "fine", b: "fine" };
        for (const leak of [
            "<span>Eid</span>nara found it",
            "E&#105;dnara found it",
            "Eidnar&#x61; found it",
        ]) {
            expect(() => blind({ ...base, b: leak }, "a_then_b", "r", [])).toThrow("names an arm");
        }
        expect(normalise("a &lt; b &amp; c<br/>d")).toBe("a < b & c d");
    });

    test("a judgment's verbosity fields must match the bound answers", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const ctx = context(f.probe.id, f.pair, f.probe.check.judge);
        const padded = { ...judgment, lengths: { a: 1, b: 2 } };
        expect(() => gradeP7(padded, ctx, rules)).toThrow(GradeRefused);
        const flipped = { ...judgment, longer_recalled_alone: !judgment.longer_recalled_alone };
        expect(() => gradeP7(flipped, ctx, rules)).toThrow(GradeRefused);
    });

    test("the judge identity names the preprocessing version", () => {
        const id = judgeIdentity(rules.judge.model);
        expect(id.prompt_digest).toBe(
            "65c06cfd918d48dccecb428c26c9b0ae1a40ddd1126ba7eb67dfc785ea5da360",
        );
        expect(id.prompt_digest).toBe(
            sha256Hex(`${PREPROCESSING_VERSION}\n${judgePrompt(EMPTY_PROMPT)}`),
        );
    });

    test("an inconsistent judgment is never gate-eligible", async () => {
        const f = load("P7-inconsistent");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const set = calibration();
        const [g] = gradeP7(
            judgment,
            context(f.probe.id, f.pair, f.probe.check.judge, {
                calibration: set,
                cross_judge: crossJudged(set),
            }),
            rules,
        );
        expect([
            g?.verdict,
            g?.metrics.calibration,
            g?.metrics.permutation,
            g?.metrics.cross_judge,
            g?.metrics.gate_eligible,
        ]).toEqual(["excluded", "valid", "pass", "valid", false]);
    });

    test("HTML comments and out-of-range entities are handled before blinding", () => {
        const base = { id: "p", a: "fine", b: "fine" };
        expect(() =>
            blind({ ...base, b: "Eid<!-- separator -->nara found it" }, "a_then_b", "r", []),
        ).toThrow("names an arm");
        expect(normalise("a &#x110000; b &#99999999; c")).toBe("a b c");
    });

    test("a judgment without a complete judge identity is refused", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const ctx = context(f.probe.id, f.pair, f.probe.check.judge);
        for (const judge of [null, {}, { model: 1, prompt_digest: "x", rubric_digest: "y" }]) {
            const broken = { ...judgment, judge: judge as unknown as typeof judgment.judge };
            expect(() => gradeP7(broken, ctx, rules)).toThrow(GradeRefused);
        }
    });

    test("a judgment without an orders object is refused", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const ctx = context(f.probe.id, f.pair, f.probe.check.judge);
        for (const orders of [null, undefined, "first"]) {
            const broken = { ...judgment, orders: orders as unknown as typeof judgment.orders };
            expect(() => gradeP7(broken, ctx, rules)).toThrow(GradeRefused);
        }
    });

    test("encoded markup is stripped after entity decoding", () => {
        const base = { id: "p", a: "fine", b: "fine" };
        expect(() =>
            blind({ ...base, b: "Eid&lt;span&gt;&lt;/span&gt;nara found it" }, "a_then_b", "r", []),
        ).toThrow("names an arm");
        expect(normalise("Eid&lt;!-- x --&gt;nara")).toBe("Eid nara");
    });

    test("a judgment without answer or length containers is refused", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const ctx = context(f.probe.id, f.pair, f.probe.check.judge);
        for (const broken of [
            { ...judgment, answers: null },
            { ...judgment, answers: { a: 1, b: "x" } },
            { ...judgment, lengths: undefined },
            { ...judgment, lengths: { a: "3", b: 4 } },
        ]) {
            expect(() => gradeP7(broken as unknown as typeof judgment, ctx, rules)).toThrow(
                GradeRefused,
            );
        }
    });

    test("a verdict is one word with trailing punctuation at most", () => {
        expect(parseVerdict(" Second.\n")).toBe("second");
        expect(parseVerdict("both!")).toBe("both");
        for (const bad of ["fi\nrst", "f-i-r-s-t", "first second", "the first"]) {
            expect(() => parseVerdict(bad)).toThrow("is not a verdict");
        }
    });

    test("unknown named entities and invisible-only answers are handled", () => {
        const base = { id: "p", a: "fine", b: "fine" };
        expect(() =>
            blind({ ...base, b: "Eid&NoBreak;nara found it" }, "a_then_b", "r", []),
        ).toThrow("names an arm");
        expect(normalise("AT&T; rocks")).toBe("AT rocks");
        expect(normalise("\u200b\u00ad")).toBe("");
        const snap = (arm: string, text: string) => snapshotOf(`snap-${arm}`, arm, text);
        expect(() => p7Pair("q-1", snap("eidnara", "because"), snap("host", "\u200b"))).toThrow(
            "answer b is empty",
        );
    });

    test("a grade's arm, snapshot, and inputs come from the snapshots that produced the answers", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const ctx = context(f.probe.id, f.pair, f.probe.check.judge, {
            snapshots: {
                a: [snapshotOf("snap-kl", "eidnara-kl", f.pair.a, f.probe.id)],
                b: [snapshotOf("snap-host-2", "host", f.pair.b, f.probe.id)],
            },
        });
        const grades = gradeP7(judgment, ctx, rules);
        expect(grades.map((g) => [g.arm, g.snapshot])).toEqual([
            ["eidnara-kl", "snap-kl"],
            ["host", "snap-host-2"],
        ]);
        expect(grades[0]?.inputs).toEqual(["snap-host-2:calls", "snap-kl:calls"]);
        const swapped = context(f.probe.id, f.pair, f.probe.check.judge, {
            snapshots: {
                a: [snapshotOf("snap-x", "eidnara", f.pair.b, f.probe.id)],
                b: [snapshotOf("snap-y", "host", f.pair.a, f.probe.id)],
            },
        });
        expect(() => gradeP7(judgment, swapped, rules)).toThrow("other answers");
    });

    test("a null judgment and a mark-only answer are refused", async () => {
        const f = load("P7-pass");
        const ctx = context(f.probe.id, f.pair, f.probe.check.judge);
        expect(() => gradeP7(null as unknown as Judgment, ctx, rules)).toThrow(GradeRefused);
        const snap = (arm: string, text: string) => snapshotOf(`snap-${arm}`, arm, text);
        for (const blank of ["\u034f", "...", "\u034f \u034f"]) {
            expect(() => p7Pair("q-1", snap("eidnara", "because"), snap("host", blank))).toThrow(
                "answer b is empty",
            );
        }
    });

    test("the preprocessing version moved with the normaliser", () => {
        expect(PREPROCESSING_VERSION).toBe("sim-judge-preprocessing/v2");
    });

    test("a calibration pair id made of combining marks is blank", () => {
        const marks = calibration();
        marks.labels["\u0300\u0301"] = "a";
        expect(() => calibrationDigest(marks, rules)).toThrow("blank");
    });

    test("the reference comes from the compiled probe, which must be a P7 item with a reason", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const ctx = context(f.probe.id, f.pair, f.probe.check.judge);
        expect(() =>
            gradeP7(judgment, { ...ctx, probe: { ...ctx.probe, type: "P8" } }, rules),
        ).toThrow("not a P7 probe");
        expect(() =>
            gradeP7(judgment, { ...ctx, probe: { ...ctx.probe, check: {} } }, rules),
        ).toThrow("not a P7 probe");
        expect(gradeP7(judgment, ctx, rules)).toHaveLength(2);
    });

    test("a snapshot from another session than the probe's is refused", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const ctx = context(f.probe.id, f.pair, f.probe.check.judge);
        const other = { ...snapshotOf("snap-host", "host", f.pair.b, f.probe.id), session: "s-9" };
        expect(() =>
            gradeP7(judgment, { ...ctx, snapshots: { ...ctx.snapshots, b: [other] } }, rules),
        ).toThrow("session s-9");
    });

    test("uppercase hexadecimal entities decode before blinding", () => {
        const base = { id: "p", a: "fine", b: "fine" };
        expect(() => blind({ ...base, b: "Eid&#X6E;ara found it" }, "a_then_b", "r", [])).toThrow(
            "names an arm",
        );
    });

    test("a snapshot of another turn than the probe's event is refused", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const ctx = context(f.probe.id, f.pair, f.probe.check.judge);
        const pinned = { ...ctx, probe: { ...ctx.probe, event: "e-1" } };
        expect(gradeP7(judgment, pinned, rules)).toHaveLength(2);
        const other = { ...snapshotOf("snap-host", "host", f.pair.b, f.probe.id), turn: "e-2" };
        expect(() =>
            gradeP7(judgment, { ...pinned, snapshots: { ...ctx.snapshots, b: [other] } }, rules),
        ).toThrow("not the probe's event e-1");
    });

    test("the judge sees the reference reason normalised like the answers", () => {
        const pair = { id: "p", a: "fine", b: "fine" };
        expect(blind(pair, "a_then_b", "**allocation** dominated\n`p99`", []).reference).toBe(
            "allocation dominated p99",
        );
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
                return Response.json({ output: { message: { content } }, stopReason: "end_turn" });
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
        let release: (() => void) | undefined;
        server = Bun.serve({
            port: 0,
            fetch: () =>
                new Promise<Response>((resolve) => {
                    release = () => resolve(new Response("late"));
                }),
        });
        const judge = proxyJudge(
            `http://127.0.0.1:${server.port}`,
            rules.judge.model,
            "anthropic.x",
            { deadlineMs: 50 },
        );
        await expect(judge.verdict("prompt")).rejects.toThrow("judge call timed out");
        release?.();
    });

    test("a body that stalls after the headers is refused at the deadline", async () => {
        server = Bun.serve({
            port: 0,
            fetch: () =>
                new Response(new ReadableStream({ start: (c) => c.enqueue('{"output":') }), {
                    headers: { "content-type": "application/json" },
                }),
        });
        const judge = proxyJudge(
            `http://127.0.0.1:${server.port}`,
            rules.judge.model,
            "anthropic.x",
            {
                deadlineMs: 50,
            },
        );
        await expect(judge.verdict("prompt")).rejects.toThrow("judge call timed out");
    });

    test("invalid JSON, null blocks, and several text blocks are judge refusals or joined", async () => {
        const replies: Array<() => Response> = [
            () => new Response("not json", { status: 200 }),
            () =>
                Response.json({
                    output: { message: { content: [null, { text: "first" }] } },
                    stopReason: "end_turn",
                }),
            () =>
                Response.json({
                    output: { message: { content: [{ text: "first" }, { text: "second" }] } },
                    stopReason: "end_turn",
                }),
        ];
        let i = 0;
        server = Bun.serve({ port: 0, fetch: () => (replies[i++] as () => Response)() });
        const judge = proxyJudge(
            `http://127.0.0.1:${server.port}`,
            rules.judge.model,
            "anthropic.x",
        );
        await expect(judge.verdict("prompt")).rejects.toThrow("judge reply is not JSON");
        expect(await judge.verdict("prompt")).toBe("first");
        await expect(judge.verdict("prompt")).rejects.toThrow("is not a verdict");
    });

    test("an unreachable gateway is a judge refusal", async () => {
        const judge = proxyJudge("http://127.0.0.1:1", rules.judge.model, "anthropic.x");
        await expect(judge.verdict("prompt")).rejects.toThrow(GradeRefused);
    });

    test("a truncated judge generation is refused before its text is parsed", async () => {
        const bodies = [
            { output: { message: { content: [{ text: "first" }] } }, stopReason: "max_tokens" },
            { output: { message: { content: [{ text: "first" }] } } },
        ];
        let i = 0;
        server = Bun.serve({ port: 0, fetch: () => Response.json(bodies[i++ % bodies.length]) });
        const judge = proxyJudge(
            `http://127.0.0.1:${server.port}`,
            rules.judge.model,
            "anthropic.x",
        );
        await expect(judge.verdict("prompt")).rejects.toThrow("stopped for max_tokens");
        await expect(judge.verdict("prompt")).rejects.toThrow("stopped for");
    });

    test("a redirecting gateway is refused rather than followed", async () => {
        const target = Bun.serve({
            port: 0,
            fetch: () =>
                Response.json({
                    output: { message: { content: [{ text: "first" }] } },
                    stopReason: "end_turn",
                }),
        });
        try {
            server = Bun.serve({
                port: 0,
                fetch: (req) =>
                    Response.redirect(
                        `http://127.0.0.1:${target.port}${new URL(req.url).pathname}`,
                        307,
                    ),
            });
            const judge = proxyJudge(
                `http://127.0.0.1:${server.port}`,
                rules.judge.model,
                "anthropic.x",
            );
            await expect(judge.verdict("prompt")).rejects.toThrow(GradeRefused);
        } finally {
            target.stop(true);
        }
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
