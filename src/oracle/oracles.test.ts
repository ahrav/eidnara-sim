import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrereg } from "../scenario/inputs";
import { type ArmLogs, loadRun, type RunLogs } from "./logs";
import { ORACLES, oracleReport, rssFit, runOracles } from "./oracles";

const DIR = join(import.meta.dir, "../../tests/fixtures/oracle");
const prereg = loadPrereg("S");

interface Fixture {
    kinds: Record<string, string>;
    arms: ArmLogs[];
    expect: Record<string, number>;
}
const fixtures = readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [f, JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture] as const);
const runOf = (f: Fixture, tier = "S"): RunLogs => ({
    dir: "",
    tier,
    base_wall_ms: 0,
    prereg,
    kinds: new Map(Object.entries(f.kinds)),
    arms: f.arms,
});
const counts = (f: Fixture) => {
    const out: Record<string, number> = {};
    for (const a of runOracles(runOf(f))) out[a.oracle] = (out[a.oracle] ?? 0) + 1;
    return out;
};

describe("oracle fixtures", () => {
    test("each of F1 to F9 has a known-bad fixture that fires it and a known-good one that stays quiet", () => {
        for (const id of ORACLES) {
            const bad = fixtures.find(([f]) => f === `${id}-bad.json`)?.[1] as Fixture;
            const good = fixtures.find(([f]) => f === `${id}-good.json`)?.[1] as Fixture;
            expect([id, (counts(bad)[id] ?? 0) > 0]).toEqual([id, true]);
            expect([id, counts(good)[id] ?? 0]).toEqual([id, 0]);
        }
    });

    for (const [file, f] of fixtures) {
        test(`${file} activates each oracle the recorded number of times`, () => {
            const nonzero = Object.fromEntries(Object.entries(f.expect).filter(([, n]) => n > 0));
            expect(counts(f)).toEqual(nonzero);
        });
    }
});

describe("oracle report", () => {
    test("each tier lists an activation count per oracle and marks zero-activation oracles uncovered", () => {
        const bad = fixtures.find(([f]) => f === "F1-bad.json")?.[1] as Fixture;
        const good = fixtures.find(([f]) => f === "F3-good.json")?.[1] as Fixture;
        const report = oracleReport([runOf(bad, "S"), runOf(good, "S"), runOf(good, "M")]);
        expect(Object.keys(report).sort()).toEqual(["M", "S"]);
        expect(report.S?.F1).toEqual({
            activations: 1,
            uncovered: false,
            by_arm: { eidnara: 1 },
            by_component: { agent: 1 },
        });
        expect(report.S?.F7).toEqual({
            activations: 0,
            uncovered: true,
            by_arm: {},
            by_component: {},
        });
        expect(Object.values(report.M ?? {}).every((o) => o.uncovered)).toBe(true);
    });

    test("the RSS fit recovers a linear slope and reports its fit quality", () => {
        const fit = rssFit([0, 1, 2, 3].map((x) => ({ x, y: 100 + 10 * x })));
        expect(fit?.slope).toBeCloseTo(10);
        expect(fit?.r2).toBeCloseTo(1);
        expect(rssFit([{ x: 1, y: 2 }])).toBeNull();
    });

    test("a run directory loads into per-arm logs", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-oracle-"));
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({ tier: "S", order: ["host", "eidnara"] }),
        );
        writeFileSync(
            join(dir, "scenario.json"),
            JSON.stringify({ events: [{ id: "e-1", kind: "session_end" }] }),
        );
        writeFileSync(
            join(dir, "calls.jsonl"),
            line({ arm: "eidnara", seq: 0 }) + line({ arm: "host", seq: 1 }),
        );
        writeFileSync(join(dir, "journal.jsonl"), line({ kind: "StartArm", arm: "host", seq: 0 }));
        mkdirSync(join(dir, "eidnara", "r"), { recursive: true });
        writeFileSync(join(dir, "eidnara", "r", "eidnara.log"), "a\nb\n");
        writeFileSync(join(dir, "eidnara", "daemon.log"), "c\n");
        const run = loadRun(dir, prereg);
        const eidnara = run.arms.find((a) => a.arm === "eidnara");
        expect(run.kinds.get("e-1")).toBe("session_end");
        expect([eidnara?.calls.length, eidnara?.pluginLog, eidnara?.daemonLog]).toEqual([
            1,
            ["a", "b"],
            ["c"],
        ]);
        expect(run.arms.find((a) => a.arm === "host")?.journal).toHaveLength(1);
    });
});
