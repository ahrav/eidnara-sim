import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function run(journal: object[]): { exit: number; report: Record<string, unknown> } {
    dir = mkdtempSync(join(tmpdir(), "pairing-check-"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ order: ["a", "b"] }));
    writeFileSync(join(dir, "scenario.json"), JSON.stringify({ events: [] }));
    writeFileSync(join(dir, "pairing.jsonl"), "");
    writeFileSync(
        join(dir, "journal.jsonl"),
        journal.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
    const r = Bun.spawnSync(["bun", join(ROOT, "scripts/pairing-check.ts"), dir], {
        stdout: "pipe",
        stderr: "pipe",
    });
    return { exit: r.exitCode, report: JSON.parse(r.stdout.toString()) };
}

const rates = (arm: string) => ({ kind: "UserSimRates", arm, outside: [], rates: {} });

test("the pairing check fails a run that lacks an arm's rate summary, and passes one with each arm's", () => {
    const partial = run([rates("a")]);
    expect(partial.report.missing_rates).toEqual(["b"]);
    expect(partial.exit).toBe(1);
    const whole = run([rates("a"), rates("b")]);
    expect(whole.report.missing_rates).toEqual([]);
    expect(whole.exit).toBe(0);
});
