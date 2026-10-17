import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import { preregistrationHash } from "../prereg/validate";
import { loadPrereg } from "../scenario/inputs";

const FIXTURE = join(import.meta.dir, "../../tests/fixtures/grade/P1-pass.json");

/** A run directory holding one journaled P1 snapshot for the eidnara arm. */
function runDir(
    prereg_sha256 = preregistrationHash(loadPrereg("S")),
    scenario_hash?: string,
): string {
    const { probe, snapshots } = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const dir = mkdtempSync(join(tmpdir(), "sim-grade-run-"));
    mkdirSync(join(dir, "eidnara"));
    const body = { probes: [probe] };
    const hash = sha256Hex(canonicalJson(body));
    writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({
            tier: "S",
            seed: 101,
            order: ["eidnara"],
            prereg_sha256,
            scenario_hash: scenario_hash ?? hash,
        }),
    );
    writeFileSync(join(dir, "scenario.json"), JSON.stringify({ ...body, scenario_hash: hash }));
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
    const again = grade(dir);
    expect(again.status).toBe(0);
    expect(versions(dir)).toEqual([1]);
    const summary = JSON.parse(again.stdout);
    expect(summary.verdicts).toEqual({ "eidnara/P1": { pass: 1 } });
    expect(summary.skipped).toEqual({ "already graded": 1 });
    expect(grade(dir, "--regrade").status).toBe(0);
    expect(versions(dir)).toEqual([1, 2]);
});

test("a run made under another pre-registration is refused before any grade is written", () => {
    const dir = runDir("0".repeat(64));
    const r = grade(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("pre-registration");
    expect(existsSync(join(dir, "grades.jsonl"))).toBe(false);
});

test("a scenario that no longer hashes to the manifest's scenario_hash is refused before any grade is written", () => {
    const dir = runDir(undefined, "0".repeat(64));
    const r = grade(dir);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("scenario_hash");
    expect(existsSync(join(dir, "grades.jsonl"))).toBe(false);
});
