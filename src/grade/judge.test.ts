import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rng } from "../rng";
import { loadPrereg } from "../scenario/inputs";
import { GradeRefused, type Snapshot } from "./artefacts";
import {
    BlindingRefused,
    blind,
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
    parseVerdict,
    permutationCheck,
    proxyJudge,
    type RawVerdict,
} from "./judge";
import { GradeLog, type GradeRecord, verdictCounts } from "./probes";

const rules = loadPrereg("S").grading;
const DIR = join(import.meta.dir, "../../tests/fixtures/grade");
const load = (name: string) =>
    JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as {
        probe: { id: string; check: { judge: string } };
        pair: Pair;
        judge_verdicts: Record<string, RawVerdict>;
        expect: { a: string; b: string };
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
        schema: "eval-judge/v1",
        judge: judgeIdentity(rules.judge.model),
        labels,
        human: Object.keys(labels).slice(0, human),
    };
};

const context = (item: string, extra: Partial<Parameters<typeof gradeP7>[1]> = {}) => ({
    item,
    snapshots: { a: "snap-eidnara", b: "snap-host" },
    arms: { a: "eidnara", b: "host" },
    inputs: ["snap-eidnara:calls", "snap-host:calls"],
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
            const grades = gradeP7(judgment, context(f.probe.id), rules);
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
                    calls: [
                        {
                            seq: 1,
                            component: "agent",
                            turn: "e-1",
                            scenario_ms: 0,
                            input_tokens: 1,
                            output_tokens: 1,
                            response_text: text,
                        },
                    ],
                },
            ],
        });
        const { pair, inputs } = p7Pair(
            "q-1",
            snap("eidnara", "because A"),
            snap("host", "no idea"),
        );
        expect([pair.a, pair.b, inputs]).toEqual([
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

    test("a host answer judged against two memory arms keeps one grade per pairing", async () => {
        const f = load("P7-pass");
        const log = new GradeLog(join(mkdtempSync(join(tmpdir(), "sim-p7-")), "grades.jsonl"));
        const graded: GradeRecord[] = [];
        for (const arm of ["eidnara", "eidnara-kl"]) {
            const client = scripted(f.judge_verdicts);
            const judgment = await judgePair(client, f.pair, f.probe.check.judge, []);
            const pairing = context(f.probe.id, {
                arms: { a: arm, b: "host" },
                snapshots: { a: `snap-${arm}`, b: "snap-host" },
            });
            for (const g of gradeP7(judgment, pairing, rules)) {
                const record = { ...g, version: log.nextVersion(g) };
                log.append(record);
                graded.push(record);
            }
        }
        const latest = log.latest().map((g) => `${g.arm} vs ${g.against} v${g.version}`);
        expect(latest.sort()).toEqual([
            "eidnara vs host v1",
            "eidnara-kl vs host v1",
            "host vs eidnara v1",
            "host vs eidnara-kl v1",
        ]);
        expect(verdictCounts(graded)).toEqual({
            "eidnara/P7 vs host": { [f.expect.a]: 1 },
            "eidnara-kl/P7 vs host": { [f.expect.a]: 1 },
            "host/P7 vs eidnara": { [f.expect.b]: 1 },
            "host/P7 vs eidnara-kl": { [f.expect.b]: 1 },
        });
    });

    test("a grade is gate-eligible only with a valid calibration set and a passing permutation check", async () => {
        const f = load("P7-pass");
        const judgment = await judgePair(
            scripted(f.judge_verdicts),
            f.pair,
            f.probe.check.judge,
            [],
        );
        const ok = gradeP7(judgment, context(f.probe.id, { calibration: calibration() }), rules);
        expect(ok[0]?.metrics.gate_eligible).toBe(true);
        expect(ok[0]?.metrics.calibration_digest).toMatch(/^[0-9a-f]{64}$/);
        const identified = context(f.probe.id, {
            calibration: calibration(),
            permutation: { trials: 20, correct: 13 },
        });
        const refused = gradeP7(judgment, identified, rules)[0];
        expect(refused?.metrics.gate_eligible).toBe(false);
        expect(String(refused?.metrics.permutation)).toContain("refused");
        const bad = context(f.probe.id, { calibration: calibration(25, 19) });
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
        const [a] = gradeP7(judgment, context(f.probe.id), rules);
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
        const other = { ...calibration(), schema: "eval-judge/v0" } as unknown as CalibrationSet;
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
});
