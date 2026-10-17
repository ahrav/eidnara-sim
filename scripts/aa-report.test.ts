import { describe, expect, test } from "bun:test";
import {
    appendFileSync,
    lstatSync,
    mkdtempSync,
    readFileSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GradeRecord } from "../src/grade/probes";
import { preregistrationHash } from "../src/prereg/validate";
import { scenarioHash } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";
import { aaReport } from "./aa-report";

const grade = (arm: string, item: string, type: string, metric: string, value: number) => ({
    item,
    arm,
    probe_type: type,
    version: 1,
    snapshot: `${arm}:${item}`,
    inputs: [],
    later_attempts_logged: 0,
    verdict: "pass",
    metrics: { [`${type}.pass`]: true, [metric]: value },
});

function gradedRun(
    tier: string,
    prereg_sha256: string,
    items = [1, 2, 3, 4, 5, 6],
    scenario_hash?: string,
): string {
    const dir = mkdtempSync(join(tmpdir(), "sim-aa-report-"));
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    const probes = items.flatMap((i) => [
        { id: `p-${i}`, type: "P3", fact: `fact-${i}` },
        { id: `q-${i}`, type: "P13", fact: `fact-${i}` },
    ]);
    const grades = items.flatMap((i) =>
        ["host", "host~aa"].flatMap((arm) => [
            grade(arm, `p-${i}`, "P3", "P3.delta_mem", arm === "host" ? 0 : i),
            grade(arm, `q-${i}`, "P13", "P13.fold_fidelity_score", i % 2),
        ]),
    ) as GradeRecord[];
    const scenario = { probes };
    const manifest = {
        tier,
        order: ["host", "host~aa"],
        prereg_sha256,
        scenario_hash: scenario_hash ?? scenarioHash(scenario),
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
    writeFileSync(join(dir, "grades.jsonl"), grades.map(line).join(""));
    writeFileSync(join(dir, "pairing.jsonl"), "");
    return dir;
}

describe("aa-report", () => {
    test("refuses a run graded under another pre-registration", () => {
        const dir = gradedRun("S", "0000");
        expect(() => aaReport(dir)).toThrow(/pre-registration/);
    });

    test("refuses a run whose scenario no longer hashes to the manifest's digest", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")), undefined, "0000");
        expect(() => aaReport(dir)).toThrow(/scenario_hash/);
    });

    test("a grading run cut short converges on its rerun: the latest grade per side pairs", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const cut = grade("host", "p-7", "P3", "P3.delta_mem", 0);
        const rerun = [{ ...cut, version: 2 }, grade("host~aa", "p-7", "P3", "P3.delta_mem", 7)];
        appendFileSync(join(dir, "grades.jsonl"), [cut, ...rerun].map(line).join(""));
        writeFileSync(
            join(dir, "scenario.json"),
            JSON.stringify({
                probes: [
                    ...JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")).probes,
                    { id: "p-7", type: "P3", fact: "fact-7" },
                ],
            }),
        );
        const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
        manifest.scenario_hash = scenarioHash(scenario);
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        const [report] = aaReport(dir);
        expect(report?.metrics.find((m) => m.metric === "P3.delta_mem")?.n).toBe(7);
    });

    test("refuses a grade whose probe type, arm, or version contradicts the run", () => {
        const base = grade("host", "p-1", "P3", "P3.delta_mem", 0);
        const bad = [
            { ...base, version: 2, probe_type: "P9" },
            { ...base, arm: "eidnara" },
            { ...base, version: "2" },
            { ...base, item: "p-99" },
        ];
        for (const record of bad) {
            const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
            appendFileSync(join(dir, "grades.jsonl"), `${JSON.stringify(record)}\n`);
            expect(() => aaReport(dir)).toThrow(/grades\.jsonl/);
        }
    });

    test("refuses a pairing log whose terminated last line is corrupt", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const turn = { kind: "turn", arm: "host~aa", session: "s-1", index: 0 };
        writeFileSync(join(dir, "pairing.jsonl"), `${JSON.stringify(turn)}\n{corrupt\n`);
        expect(() => aaReport(dir)).toThrow(/last line is corrupt/);
    });

    test("a staging file left as a symlink is refused, never written through", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const target = join(dir, "elsewhere.json");
        writeFileSync(target, "keep me\n");
        symlinkSync(target, join(dir, `aa.json.${process.pid}.tmp`));
        expect(() => aaReport(dir)).toThrow(/EEXIST/);
        expect(readFileSync(target, "utf8")).toBe("keep me\n");
    });

    test("with no informative metric the report draws no interval conclusion", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")), [1, 2]);
        const [report] = aaReport(dir);
        expect(report?.uninformative.length).toBe(report?.metrics.length);
        expect(report?.every_interval_covers_zero).toBeNull();
    });

    test("refuses a pairing record whose shape or arm is wrong", () => {
        const bad = [
            '{"kind":"divergedAt","arm":"host~aa","session":"s-1","index":"1"}',
            '{"kind":"turn","arm":"eidnara","session":"s-1","index":1}',
            '{"kind":"other","arm":"host~aa","session":"s-1","index":1}',
        ];
        for (const record of bad) {
            const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
            writeFileSync(join(dir, "pairing.jsonl"), `${record}\n`);
            expect(() => aaReport(dir)).toThrow(/pairing\.jsonl: line 1/);
        }
    });

    test("aa.json replaces a symlink left in the run directory instead of writing through it", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const target = join(dir, "elsewhere.json");
        writeFileSync(target, "keep me\n");
        symlinkSync(target, join(dir, "aa.json"));
        aaReport(dir);
        expect(readFileSync(target, "utf8")).toBe("keep me\n");
        expect(lstatSync(join(dir, "aa.json")).isSymbolicLink()).toBe(false);
    });

    test("refuses a manifest order the run command would refuse", () => {
        for (const order of [
            ["host", "host~aa", "host~bb"],
            ["host~aa"],
            ["host", "host~x/../../outside"],
            ["host", "eidnara-kl", "eidnara-kl~aa"],
        ]) {
            const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
            const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
            writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, order }));
            expect(() => aaReport(dir)).toThrow(/manifest/);
        }
    });

    test("refuses a control whose delivered text differed from its arm's before any divergence", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const turn = (arm: string, text_sha256: string) => ({
            kind: "turn",
            arm,
            session: "s-1",
            event: "e-1",
            index: 0,
            text_sha256,
        });
        const records = [turn("host", "aaaa"), turn("host~aa", "bbbb")];
        writeFileSync(
            join(dir, "pairing.jsonl"),
            records.map((r) => `${JSON.stringify(r)}\n`).join(""),
        );
        expect(() => aaReport(dir)).toThrow(/host~aa s-1 #0/);
    });

    test("a run-level family forms one cluster per run, so one run leaves it uninformative", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const [report] = aaReport(dir);
        const by = new Map(report?.metrics.map((m) => [m.metric, m]));
        expect(by.get("P3.delta_mem")?.clusters).toBe(6);
        expect(by.get("P13.fold_fidelity_score")?.clusters).toBe(1);
        expect(by.get("P13.pass")?.clusters).toBe(1);
        expect(report?.uninformative).toEqual(["P13.pass", "P13.fold_fidelity_score"]);
        expect(report?.prereg_sha256).toBe(preregistrationHash(loadPrereg("S")));
    });

    test("one run's report carries no claim, whatever the tier plans to repeat", () => {
        const dir = gradedRun("M", preregistrationHash(loadPrereg("M")));
        const [report] = aaReport(dir);
        expect(report).not.toHaveProperty("descriptive");
    });
});
