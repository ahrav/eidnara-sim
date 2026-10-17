import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function run(
    journal: object[],
    events: object[] = [],
    pairing: object[] = [],
): { exit: number; report: Record<string, unknown> } {
    dir = mkdtempSync(join(tmpdir(), "pairing-check-"));
    const manifest = { order: ["a", "b"], events: events.length };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "scenario.json"), JSON.stringify({ events }));
    writeFileSync(
        join(dir, "pairing.jsonl"),
        pairing.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
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

test("the pairing check fails a run whose log lacks a scheduled turn for an arm", () => {
    const events = [
        { id: "e-1", kind: "user_turn", session: "s-1", index: 0, role: "filler", text: "Go." },
        { id: "e-2", kind: "session_end", session: "s-1" },
    ];
    const turn = (arm: string) => ({
        kind: "turn",
        arm,
        session: "s-1",
        event: "e-1",
        index: 0,
        label: "task",
        delivered: true,
        digest: "d",
        prefix_sha256: "p",
        text_sha256: "t",
        source: "script",
    });
    const partial = run([rates("a"), rates("b")], events, [turn("a")]);
    expect(partial.report.missing_turns).toEqual(["b e-1"]);
    expect(partial.exit).toBe(1);
    const whole = run([rates("a"), rates("b")], events, [turn("a"), turn("b")]);
    expect(whole.report.missing_turns).toEqual([]);
    expect(whole.exit).toBe(0);
    const cut = { kind: "Event", arm: "b", event: "e-1", outcome: "failed(interrupted)" };
    const interrupted = run([rates("a"), rates("b"), cut], events, [turn("a"), turn("b")]);
    expect(interrupted.report.interrupted_turns).toEqual(["b e-1"]);
    expect(interrupted.exit).toBe(1);
});
