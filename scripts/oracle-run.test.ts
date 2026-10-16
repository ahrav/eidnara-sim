import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preregistrationHash } from "../src/prereg/validate";
import { scenarioHash } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";
import { oracleRun, runDirs } from "./oracle-run";

test("a run directory named twice, directly or through a symlink, is one run", () => {
    const root = mkdtempSync(join(tmpdir(), "sim-oracle-run-"));
    const run = join(root, "run");
    const alias = join(root, "alias");
    mkdirSync(run);
    symlinkSync(run, alias);
    expect(runDirs([run, `${run}/`, alias])).toEqual([run]);
});

function completeRun(root: string, tier: string, prereg_sha256: string): string {
    const dir = join(root, "run");
    mkdirSync(dir);
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    const scenario = { events: [{ id: "e-1", kind: "user_turn" }] };
    const scenario_hash = scenarioHash(scenario);
    const manifest = { tier, order: ["eidnara"], events: 1, scenario_hash, prereg_sha256 };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "scenario.json"), JSON.stringify({ ...scenario, scenario_hash }));
    const journal = [
        { kind: "StartRun", arm: null, order: ["eidnara"] },
        { kind: "Event", arm: "eidnara", event: "e-1" },
        { kind: "EndArm", arm: "eidnara" },
        { kind: "EndRun", arm: null },
    ];
    writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
    const overflow = {
        seq: 0,
        arm: "eidnara",
        session: "s-1",
        turn: "e-1",
        component: "agent",
        componentSource: "inferred",
        model: "m",
        status: 400,
        finish_reason: null,
        input_tokens: 5,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        started_wall_ms: 0,
        wall_ms: 100,
        scenario_ms: 0,
        first_byte_ms: null,
        proxy_retries: 0,
        fault_ref: null,
        error: "ValidationException: prompt is too long",
    };
    writeFileSync(join(dir, "calls.jsonl"), line(overflow));
    mkdirSync(join(dir, "eidnara"));
    writeFileSync(join(dir, "eidnara", "resources.jsonl"), line({ scenario_ms: 0, rss: 100 }));
    return dir;
}

test("oracleRun writes each run's activations, ledgers, and digest, and reports the tier", () => {
    const root = mkdtempSync(join(tmpdir(), "sim-oracle-run-"));
    const digest = preregistrationHash(loadPrereg("S"));
    const dir = completeRun(root, "S", digest);
    const report = oracleRun([dir]);
    const written = JSON.parse(readFileSync(join(dir, "oracles.json"), "utf8"));
    expect(written.prereg_sha256).toBe(digest);
    expect(written.activations.map((a: { oracle: string }) => a.oracle)).toEqual(["F1", "F9"]);
    expect(written.ledgers.eidnara.total).toBe(5);
    expect(report.S?.F1.activations).toBe(1);
    expect(report.S?.F2.uncovered).toBe(true);
});

test("oracleRun refuses a run whose manifest names an unknown tier", () => {
    const root = mkdtempSync(join(tmpdir(), "sim-oracle-run-"));
    const dir = completeRun(root, "XXL", "x");
    expect(() => oracleRun([dir])).toThrow("unknown tier XXL");
});
