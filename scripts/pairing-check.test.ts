import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../src/prereg/canonical";
import { preregistrationHash } from "../src/prereg/validate";
import { scenarioHash } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";
import { type Label, realisedRates } from "../src/usersim/plan";

const ROOT = join(import.meta.dir, "..");
const prereg = loadPrereg("S");
let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

type Row = Record<string, unknown>;
interface Fixture {
    events: Row[];
    journal: Row[];
    pairing: Row[];
    manifest: Row;
}

const labelAt = (s: number, i: number): Label =>
    i < 5
        ? "pushback"
        : i === 5 && s < 5
          ? "interrupt"
          : i === 6 && s === 0
            ? "redirect"
            : i === 7 && s === 1
              ? "abandon"
              : "task";

function fixture(arms: string[] = ["a", "b"]): Fixture {
    const events: Row[] = [];
    for (let s = 0; s < 10; s++) {
        for (let i = 0; i < 10; i++) {
            events.push({
                id: `e-${s}-${i}`,
                kind: "user_turn",
                session: `s-${s}`,
                index: i,
                role: "filler",
                text: `Go ${s} ${i}.`,
            });
        }
    }
    const journal: Row[] = [{ kind: "StartRun", arm: null, order: arms }];
    const pairing: Row[] = [];
    for (const arm of arms) {
        const turns: { session: string; label: Label }[] = [];
        for (const e of events) {
            const [, s, i] = String(e.id).split("-").map(Number) as [number, number, number];
            const label = labelAt(s, i);
            turns.push({ session: String(e.session), label });
            pairing.push({
                kind: "turn",
                arm,
                session: e.session,
                event: e.id,
                index: e.index,
                label,
                delivered: true,
                digest: "d",
                context_sha256: "c",
                prefix_sha256: "p",
                text_sha256: sha256Hex(String(e.text)),
                source: "script",
            });
            journal.push({
                kind: "UserTurn",
                arm,
                session: e.session,
                event: e.id,
                label,
                delivered: true,
            });
            journal.push({ kind: "Event", arm, event: e.id, outcome: "ok" });
        }
        journal.push({
            kind: "UserSimRates",
            arm,
            seq: 1,
            wall_ms: 1_000,
            scenario_ms: 0,
            ...realisedRates(turns, prereg),
        });
        journal.push({ kind: "EndArm", arm });
    }
    journal.push({ kind: "EndRun", arm: null });
    const manifest = {
        tier: "S",
        order: arms,
        events: events.length,
        scenario_hash: scenarioHash({ events }),
        prereg_sha256: preregistrationHash(prereg),
    };
    return { events, journal, pairing, manifest };
}

function run(f: Fixture): { exit: number; report: Record<string, unknown>; stderr: string } {
    dir = mkdtempSync(join(tmpdir(), "pairing-check-"));
    const scenario = { events: f.events, scenario_hash: scenarioHash({ events: f.events }) };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(f.manifest));
    writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
    writeFileSync(
        join(dir, "pairing.jsonl"),
        f.pairing.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
    writeFileSync(
        join(dir, "journal.jsonl"),
        f.journal.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
    const r = Bun.spawnSync(["bun", join(ROOT, "scripts/pairing-check.ts"), dir], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const stdout = r.stdout.toString();
    return {
        exit: r.exitCode,
        report: stdout.trim() === "" ? {} : JSON.parse(stdout),
        stderr: r.stderr.toString(),
    };
}

const drop = (rows: Row[], keep: (r: Row) => boolean) => rows.filter(keep);
const find = (rows: Row[], match: (r: Row) => boolean) => rows.find(match) as Row;

test("a finished run whose journal and pairing log agree passes", () => {
    const r = run(fixture());
    expect(r.exit).toBe(0);
    expect(r.report.rates_mismatch).toEqual([]);
    expect(r.report.missing_turns).toEqual([]);
});

test("the pairing check fails a run that lacks an arm's rate summary", () => {
    const f = fixture();
    f.journal = drop(f.journal, (r) => !(r.kind === "UserSimRates" && r.arm === "b"));
    const r = run(f);
    expect(r.report.missing_rates).toEqual(["b"]);
    expect(r.exit).toBe(1);
});

test("the pairing check recomputes each arm's rates from its delivered turns", () => {
    const f = fixture();
    const rates = find(f.journal, (r) => r.kind === "UserSimRates" && r.arm === "b");
    rates.rates = { ...(rates.rates as Row), pushback_per_turn: 0.4 };
    const r = run(f);
    expect(r.report.rates_mismatch).toEqual(["b"]);
    expect(r.exit).toBe(1);
    const g = fixture();
    const bare = find(g.journal, (r) => r.kind === "UserSimRates" && r.arm === "b");
    for (const k of ["turns", "sessions"]) delete bare[k];
    bare.rates = {};
    bare.outside = [];
    const thin = run(g);
    expect(thin.report.rates_mismatch).toEqual(["b"]);
    expect(thin.exit).toBe(1);
});

test("a delivered journal row with an unknown label cannot certify the rates", () => {
    const f = fixture();
    find(f.journal, (r) => r.kind === "UserTurn" && r.arm === "a" && r.event === "e-0-9").label =
        "shout";
    const r = run(f);
    expect(r.report.invalid_labels).toEqual(["a e-0-9"]);
    expect(r.exit).toBe(1);
});

test("the pairing check fails a run that never reached EndArm for an arm or EndRun", () => {
    const f = fixture();
    f.journal = drop(f.journal, (r) => !(r.kind === "EndArm" && r.arm === "b"));
    const noEndArm = run(f);
    expect(noEndArm.report.incomplete).toContain("b EndArm");
    expect(noEndArm.exit).toBe(1);
    const g = fixture();
    g.journal = drop(g.journal, (r) => r.kind !== "EndRun");
    const noEndRun = run(g);
    expect(noEndRun.report.incomplete).toContain("EndRun");
    expect(noEndRun.exit).toBe(1);
});

test("a non-filler turn the host never received fails the check even when its pairing row says delivered", () => {
    const f = fixture();
    find(f.events, (e) => e.id === "e-1-1").role = "conveyance";
    f.manifest = { ...f.manifest, scenario_hash: scenarioHash({ events: f.events }) };
    find(
        f.journal,
        (r) => r.kind === "UserTurn" && r.arm === "b" && r.event === "e-1-1",
    ).delivered = false;
    const rates = find(f.journal, (r) => r.kind === "UserSimRates" && r.arm === "b");
    const turns = f.journal
        .filter((r) => r.kind === "UserTurn" && r.arm === "b" && r.delivered === true)
        .map((r) => ({ session: String(r.session), label: r.label as Label }));
    Object.assign(rates, realisedRates(turns, prereg));
    const r = run(f);
    expect(r.report.non_filler_unsent).toEqual(["b e-1-1"]);
    expect(r.exit).toBe(1);
});

test("the journal's events must appear once each, in compiled order, under the journaled arm order", () => {
    const f = fixture();
    expect(run(f).exit).toBe(0);
    const g = fixture();
    g.journal.push({ kind: "Event", arm: "b", event: "e-0-0", outcome: "ok" });
    const dup = run(g);
    expect(dup.exit).toBe(1);
    expect(String(dup.report.incomplete)).toContain("repeated");
    const h = fixture();
    (h.journal[0] as Row).order = ["b", "a"];
    const order = run(h);
    expect(order.exit).toBe(1);
    expect(String(order.report.incomplete)).toContain("order");
});

test("the pairing check requires an Event row for every scheduled event of every arm", () => {
    const f = fixture();
    f.journal = drop(
        f.journal,
        (r) => !(r.kind === "Event" && r.arm === "b" && r.event === "e-3-3"),
    );
    const r = run(f);
    expect(r.report.missing_events).toEqual(["b e-3-3"]);
    expect(r.exit).toBe(1);
});

test("every pairing turn has exactly one journal user turn, and every journal user turn a pairing turn", () => {
    const f = fixture();
    f.journal.push({
        kind: "UserTurn",
        arm: "a",
        session: "s-0",
        event: "e-0-1",
        label: "task",
        delivered: true,
    });
    f.journal = drop(
        f.journal,
        (r) => !(r.kind === "UserTurn" && r.arm === "b" && r.event === "e-2-2"),
    );
    f.journal.push({
        kind: "UserTurn",
        arm: "b",
        session: "s-9",
        event: "e-extra",
        label: "task",
        delivered: false,
    });
    const r = run(f);
    expect(r.report.journal_pairing_mismatch).toEqual(["a e-0-1", "b e-2-2", "b e-extra"]);
    expect(r.exit).toBe(1);
});

test("the pairing check fails a run whose log lacks a scheduled turn for an arm", () => {
    const f = fixture();
    f.pairing = drop(f.pairing, (r) => !(r.arm === "b" && r.event === "e-0-0"));
    f.journal = drop(
        f.journal,
        (r) => !(r.kind === "UserTurn" && r.arm === "b" && r.event === "e-0-0"),
    );
    const r = run(f);
    expect(r.report.missing_turns).toEqual(["b e-0-0"]);
    expect(r.exit).toBe(1);
});

test("a delivered record whose turn the journal marks interrupted fails the check", () => {
    const f = fixture();
    find(f.journal, (r) => r.kind === "Event" && r.arm === "b" && r.event === "e-0-0").outcome =
        "failed(interrupted)";
    const r = run(f);
    expect(r.report.interrupted_turns).toEqual(["b e-0-0"]);
    expect(r.exit).toBe(1);
});

test("a pairing row must sit at its compiled event's session and index, once", () => {
    const f = fixture();
    find(f.pairing, (r) => r.arm === "a" && r.event === "e-0-1").session = "s-9";
    f.pairing.push({ ...find(f.pairing, (r) => r.arm === "b" && r.event === "e-0-0") });
    const r = run(f);
    expect(r.report.misplaced_rows).toEqual(["a e-0-1", "b e-0-0"]);
    expect(r.exit).toBe(1);
});

const diverged = (event: string, index: number, digest: string): Row => ({
    kind: "divergedAt",
    arm: "b",
    session: "s-0",
    event,
    index,
    digest,
    reference_digest: "r",
    context_sha256: "c",
    against: "reference",
});

test("a divergence row counts as a cutoff only at its compiled event with differing digests", () => {
    const f = fixture();
    f.pairing.unshift(diverged("e-0-0", 0, "r"));
    const sameDigest = run(f);
    expect(sameDigest.report.invalid_divergences).toEqual(["b e-0-0"]);
    expect(sameDigest.exit).toBe(1);
    const g = fixture();
    g.pairing.unshift(diverged("e-0-0", 5, "d2"));
    const misplaced = run(g);
    expect(misplaced.report.invalid_divergences).toEqual(["b e-0-0"]);
    expect(misplaced.exit).toBe(1);
    const h = fixture();
    h.pairing.unshift(diverged("e-0-1", 1, "d2"));
    const real = run(h);
    expect(real.report.invalid_divergences).toEqual([]);
    expect(real.exit).toBe(0);
});

test("a recorded divergence is valid when the arm's context left the recorded one", () => {
    const recorded = (recordedContext: string): Row => ({
        ...diverged("e-0-1", 1, "d"),
        arm: "a",
        reference_digest: "d",
        recorded_context_sha256: recordedContext,
        against: "recorded",
    });
    const f = fixture();
    f.pairing.unshift(recorded("other"));
    expect(run(f).report.invalid_divergences).toEqual([]);
    const g = fixture();
    g.pairing.unshift(recorded("c"));
    expect(run(g).report.invalid_divergences).toEqual(["a e-0-1"]);
});

test("the pairing check refuses a pairing row with a wrongly typed field", () => {
    const f = fixture();
    const row = find(f.pairing, (r) => r.arm === "a" && r.event === "e-0-0");
    row.index = "not-an-index";
    row.delivered = "yes";
    row.source = "elsewhere";
    const r = run(f);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("index is not an integer");
});

test("the pairing check refuses a scenario or pre-registration other than the manifest's", () => {
    const f = fixture();
    f.manifest = { ...f.manifest, scenario_hash: "0".repeat(64) };
    const other = run(f);
    expect(other.exit).not.toBe(0);
    expect(other.stderr).toContain("scenario");
    const g = fixture();
    g.manifest = { ...g.manifest, prereg_sha256: "0".repeat(64) };
    const stale = run(g);
    expect(stale.exit).not.toBe(0);
    expect(stale.stderr).toContain("pre-registration");
});

test("a paste turn's record must name the compiled corpus item, whose bytes the compiled text carries", () => {
    const samples = readFileSync(join(ROOT, "corpus/tool-outputs/samples.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { id: string; content: string });
    const sample = samples[0] as { id: string; content: string };
    const text = `Here's what I'm seeing:\n\`\`\`\n${sample.content}\n\`\`\``;
    const paste = { sample_id: sample.id, bytes: Buffer.byteLength(sample.content) };
    const f = fixture();
    const event = find(f.events, (e) => e.id === "e-0-9");
    event.role = "paste";
    event.text = text;
    event.paste = paste;
    f.manifest = { ...f.manifest, scenario_hash: scenarioHash({ events: f.events }) };
    for (const arm of ["a", "b"]) {
        const row = find(f.pairing, (r) => r.arm === arm && r.event === "e-0-9");
        row.label = "paste";
        row.text_sha256 = sha256Hex(text);
        row.paste = paste;
        find(
            f.journal,
            (r) => r.kind === "UserTurn" && r.arm === arm && r.event === "e-0-9",
        ).label = "paste";
        const rates = find(f.journal, (r) => r.kind === "UserSimRates" && r.arm === arm);
        const turns = f.journal
            .filter((r) => r.kind === "UserTurn" && r.arm === arm)
            .map((r) => ({ session: String(r.session), label: r.label as Label }));
        Object.assign(rates, realisedRates(turns, prereg));
    }
    const good = run(f);
    expect(good.report.paste_provenance).toEqual([]);
    expect(good.exit).toBe(0);
    find(f.pairing, (r) => r.arm === "b" && r.event === "e-0-9").paste = {
        ...paste,
        bytes: paste.bytes + 1,
    };
    const bad = run(f);
    expect(bad.report.paste_provenance).toEqual(["b e-0-9"]);
    expect(bad.exit).toBe(1);
});

test("the pairing check refuses a control listed without its arm", () => {
    const dir = mkdtempSync(join(tmpdir(), "pairing-check-"));
    writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({
            tier: "S",
            order: ["host~aa"],
            events: 0,
            scenario_hash: scenarioHash({ events: [] }),
        }),
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
