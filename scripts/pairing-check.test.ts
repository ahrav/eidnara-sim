import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../src/prereg/canonical";
import { loadPrereg } from "../src/scenario/inputs";
import { type Label, realisedRates } from "../src/usersim/plan";

const ROOT = join(import.meta.dir, "..");
let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function run(
    journal: object[],
    events: object[] = [],
    pairing: object[] = [],
): { exit: number; report: Record<string, unknown> } {
    dir = mkdtempSync(join(tmpdir(), "pairing-check-"));
    const manifest = { tier: "S", order: ["a", "b"], events: events.length };
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

const prereg = loadPrereg("S");
// Ten sessions of ten delivered turns whose labels sit inside every pre-registered band.
const turnsOf = (arm: string) => {
    const rows: object[] = [];
    for (let s = 0; s < 10; s++) {
        for (let i = 0; i < 10; i++) {
            const label =
                i < 5
                    ? "pushback"
                    : i === 5 && s < 5
                      ? "interrupt"
                      : i === 6 && s === 0
                        ? "redirect"
                        : i === 7 && s === 1
                          ? "abandon"
                          : "task";
            rows.push({
                kind: "UserTurn",
                arm,
                session: `s-${s}`,
                event: `t-${s}-${i}`,
                label,
                delivered: true,
            });
        }
    }
    return rows;
};
const summary = (arm: string) =>
    realisedRates(
        (turnsOf(arm) as { session: string; label: Label }[]).map((t) => ({
            session: t.session,
            label: t.label,
        })),
        prereg,
    );
const rates = (arm: string) => ({ kind: "UserSimRates", arm, ...summary(arm) });
const endArm = (arm: string) => ({ kind: "EndArm", arm });
const endRun = { kind: "EndRun", arm: null };
const complete = (...arms: string[]) => [
    ...arms.flatMap((a) => [...turnsOf(a), rates(a), endArm(a)]),
    endRun,
];

test("the pairing check fails a run that lacks an arm's rate summary, and passes one with each arm's", () => {
    const partial = run([rates("a"), endArm("a"), endArm("b"), endRun]);
    expect(partial.report.missing_rates).toEqual(["b"]);
    expect(partial.exit).toBe(1);
    const whole = run(complete("a", "b"));
    expect(whole.report.missing_rates).toEqual([]);
    expect(whole.exit).toBe(0);
});

test("the pairing check refuses a pairing row with a wrongly typed field", () => {
    const events = [
        { id: "e-1", kind: "user_turn", session: "s-1", index: 0, role: "filler", text: "Go." },
    ];
    const bad = {
        kind: "turn",
        arm: "a",
        session: "s-1",
        event: "e-1",
        index: "not-an-index",
        label: "task",
        delivered: "yes",
        digest: "d",
        context_sha256: "c",
        prefix_sha256: "p",
        text_sha256: "t",
        source: "elsewhere",
    };
    dir = mkdtempSync(join(tmpdir(), "pairing-check-"));
    writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({ tier: "S", order: ["a"], events: 1 }),
    );
    writeFileSync(join(dir, "scenario.json"), JSON.stringify({ events }));
    writeFileSync(join(dir, "pairing.jsonl"), `${JSON.stringify(bad)}\n`);
    writeFileSync(
        join(dir, "journal.jsonl"),
        complete("a")
            .map((e) => `${JSON.stringify(e)}\n`)
            .join(""),
    );
    const r = Bun.spawnSync(["bun", join(ROOT, "scripts/pairing-check.ts"), dir], {
        stdout: "pipe",
        stderr: "pipe",
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("index is not an integer");
});

test("the pairing check recomputes each arm's rates from its delivered turns", () => {
    const stale = { ...rates("b"), rates: { ...summary("b").rates, pushback_per_turn: 0.4 } };
    const r = run([
        ...turnsOf("a"),
        rates("a"),
        endArm("a"),
        ...turnsOf("b"),
        stale,
        endArm("b"),
        endRun,
    ]);
    expect(r.report.rates_mismatch).toEqual(["b"]);
    expect(r.exit).toBe(1);
    const bare = { kind: "UserSimRates", arm: "b", outside: [], rates: {} };
    const thin = run([
        ...turnsOf("a"),
        rates("a"),
        endArm("a"),
        ...turnsOf("b"),
        bare,
        endArm("b"),
        endRun,
    ]);
    expect(thin.report.rates_mismatch).toEqual(["b"]);
    expect(thin.exit).toBe(1);
});

test("a pairing row must sit at its compiled event's session and index, once", () => {
    const events = [
        { id: "e-1", kind: "user_turn", session: "s-1", index: 0, role: "filler", text: "Go." },
        { id: "e-2", kind: "user_turn", session: "s-1", index: 1, role: "filler", text: "On." },
    ];
    const row = (arm: string, event: string, session: string, index: number) => ({
        kind: "turn",
        arm,
        session,
        event,
        index,
        label: "task",
        delivered: true,
        digest: "d",
        context_sha256: "c",
        prefix_sha256: "p",
        text_sha256: "t",
        source: "script",
    });
    const good = run(complete("a", "b"), events, [
        row("a", "e-1", "s-1", 0),
        row("a", "e-2", "s-1", 1),
        row("b", "e-1", "s-1", 0),
        row("b", "e-2", "s-1", 1),
    ]);
    expect(good.report.misplaced_rows).toEqual([]);
    expect(good.exit).toBe(0);
    const bad = run(complete("a", "b"), events, [
        row("a", "e-1", "s-1", 0),
        row("a", "e-2", "s-9", 1),
        row("b", "e-1", "s-1", 0),
        row("b", "e-1", "s-1", 0),
        row("b", "e-2", "s-1", 1),
    ]);
    expect(bad.report.misplaced_rows).toEqual(["a e-2", "b e-1"]);
    expect(bad.exit).toBe(1);
});

test("the pairing check fails a run that never reached EndArm for an arm or EndRun", () => {
    const noEndArm = run([rates("a"), rates("b"), endArm("a"), endRun]);
    expect(noEndArm.report.incomplete).toEqual(["b EndArm"]);
    expect(noEndArm.exit).toBe(1);
    const noEndRun = run([rates("a"), rates("b"), endArm("a"), endArm("b")]);
    expect(noEndRun.report.incomplete).toEqual(["EndRun"]);
    expect(noEndRun.exit).toBe(1);
});

test("a paste turn's record must name the compiled corpus item, whose bytes the compiled text carries", () => {
    const samples = readFileSync(join(ROOT, "corpus/tool-outputs/samples.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { id: string; content: string });
    const sample = samples[0] as { id: string; content: string };
    const text = `Here's what I'm seeing:\n\`\`\`\n${sample.content}\n\`\`\``;
    const paste = { sample_id: sample.id, bytes: Buffer.byteLength(sample.content) };
    const events = [
        { id: "e-1", kind: "user_turn", session: "s-1", index: 0, role: "paste", text, paste },
    ];
    const turn = (arm: string, p: object) => ({
        kind: "turn",
        arm,
        session: "s-1",
        event: "e-1",
        index: 0,
        label: "paste",
        delivered: true,
        digest: "d",
        context_sha256: "c",
        prefix_sha256: "p",
        text_sha256: sha256Hex(text),
        source: "script",
        paste: p,
    });
    const good = run(complete("a", "b"), events, [turn("a", paste), turn("b", paste)]);
    expect(good.report.paste_provenance).toEqual([]);
    expect(good.exit).toBe(0);
    const wrong = { ...paste, bytes: paste.bytes + 1 };
    const bad = run(complete("a", "b"), events, [turn("a", paste), turn("b", wrong)]);
    expect(bad.report.paste_provenance).toEqual(["b e-1"]);
    expect(bad.exit).toBe(1);
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
        context_sha256: "c",
        prefix_sha256: "p",
        text_sha256: "t",
        source: "script",
    });
    const partial = run(complete("a", "b"), events, [turn("a")]);
    expect(partial.report.missing_turns).toEqual(["b e-1"]);
    expect(partial.exit).toBe(1);
    const whole = run(complete("a", "b"), events, [turn("a"), turn("b")]);
    expect(whole.report.missing_turns).toEqual([]);
    expect(whole.exit).toBe(0);
    const cut = { kind: "Event", arm: "b", event: "e-1", outcome: "failed(interrupted)" };
    const interrupted = run([...complete("a", "b"), cut], events, [turn("a"), turn("b")]);
    expect(interrupted.report.interrupted_turns).toEqual(["b e-1"]);
    expect(interrupted.exit).toBe(1);
});

test("the pairing check refuses a control listed without its arm", () => {
    const dir = mkdtempSync(join(tmpdir(), "pairing-check-"));
    writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({ tier: "S", order: ["host~aa"], events: 0 }),
    );
    writeFileSync(join(dir, "scenario.json"), JSON.stringify({ events: [] }));
    writeFileSync(join(dir, "pairing.jsonl"), "");
    writeFileSync(join(dir, "journal.jsonl"), "");
    const r = Bun.spawnSync(["bun", join(ROOT, "scripts/pairing-check.ts"), dir], {
        stdout: "pipe",
        stderr: "pipe",
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("host~aa runs without host");
});
