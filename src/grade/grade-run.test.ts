import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "../../tests/fixtures/grade/P1-pass.json");

/** A run directory holding one journaled P1 snapshot for the eidnara arm. */
function runDir(): string {
    const { probe, snapshots } = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "sim-grade-run-"));
    mkdirSync(join(dir, "eidnara"));
    writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({ tier: "S", seed: 101, order: ["eidnara"] }),
    );
    writeFileSync(join(dir, "scenario.json"), JSON.stringify({ probes: [probe] }));
    writeFileSync(
        join(dir, "journal.jsonl"),
        `${JSON.stringify({ kind: "SnapshotArtefacts", arm: "eidnara", item: probe.id, snapshot: snapshots[0].id, seq: 0, scenario_ms: 0, wall_ms: 0 })}\n`,
    );
    writeFileSync(join(dir, "eidnara/snapshots.jsonl"), `${JSON.stringify(snapshots[0])}\n`);
    return dir;
}

const grade = (dir: string, ...flags: string[]) =>
    spawnSync("bun", ["scripts/grade-run.ts", dir, ...flags], { encoding: "utf8" });
const versions = (dir: string) =>
    readFileSync(join(dir, "grades.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l).version);

test("grading a run again leaves the grades that already cite their snapshot; --regrade appends new versions", () => {
    const dir = runDir();
    expect(grade(dir).status).toBe(0);
    expect(versions(dir)).toEqual([1]);
    expect(grade(dir).status).toBe(0);
    expect(versions(dir)).toEqual([1]);
    expect(grade(dir, "--regrade").status).toBe(0);
    expect(versions(dir)).toEqual([1, 2]);
});
