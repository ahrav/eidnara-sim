import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GradeRecord } from "../src/grade/probes";
import { preregistrationHash } from "../src/prereg/validate";
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

function gradedRun(tier: string, prereg_sha256: string): string {
    const dir = mkdtempSync(join(tmpdir(), "sim-aa-report-"));
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    const items = [1, 2, 3, 4, 5, 6];
    const probes = items.flatMap((i) => [
        { id: `p-${i}`, type: "P3", fact: `fact-${i}` },
        { id: `q-${i}`, type: "P14", fact: null },
    ]);
    const grades = items.flatMap((i) =>
        ["host", "host~aa"].flatMap((arm) => [
            grade(arm, `p-${i}`, "P3", "P3.delta_mem", arm === "host" ? 0 : i),
            grade(arm, `q-${i}`, "P14", "P14.post_compaction_correction_count", i % 2),
        ]),
    ) as GradeRecord[];
    writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({ tier, order: ["host", "host~aa"], prereg_sha256 }),
    );
    writeFileSync(join(dir, "scenario.json"), JSON.stringify({ probes }));
    writeFileSync(join(dir, "grades.jsonl"), grades.map(line).join(""));
    writeFileSync(join(dir, "pairing.jsonl"), "");
    return dir;
}

describe("aa-report", () => {
    test("refuses a run graded under another pre-registration", () => {
        const dir = gradedRun("S", "0000");
        expect(() => aaReport(dir)).toThrow(/pre-registration/);
    });

    test("a run-level family forms one cluster per run, so one run leaves it uninformative", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const [report] = aaReport(dir);
        const by = new Map(report?.metrics.map((m) => [m.metric, m]));
        expect(by.get("P3.delta_mem")?.clusters).toBe(6);
        expect(by.get("P14.post_compaction_correction_count")?.clusters).toBe(1);
        expect(by.get("P14.pass")?.clusters).toBe(1);
        expect(report?.uninformative).toEqual(["P14.pass", "P14.post_compaction_correction_count"]);
        expect(report?.prereg_sha256).toBe(preregistrationHash(loadPrereg("S")));
    });

    test("one run's report carries no claim, whatever the tier plans to repeat", () => {
        const dir = gradedRun("M", preregistrationHash(loadPrereg("M")));
        const [report] = aaReport(dir);
        expect(report).not.toHaveProperty("descriptive");
    });
});
