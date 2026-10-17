import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../src/prereg/canonical";
import { preregistrationHash } from "../src/prereg/validate";
import { scenarioHash } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";
import { behaviourPlan, type Label, realisedRates } from "../src/usersim/plan";
import { tapeKey } from "../src/usersim/usersim";

const ROOT = join(import.meta.dir, "..");
const prereg = loadPrereg("S");
let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

type Row = Record<string, unknown>;
interface Fixture {
    events: Row[];
    journal: Row[];
    pairing: Row[];
    tape: Row[];
    manifest: Row;
}

type Plan = ReturnType<typeof behaviourPlan>;

function scriptedEvents(): Row[] {
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
    return events;
}

const planOf = (events: Row[]): Plan =>
    behaviourPlan(
        events.map((e) => ({
            id: String(e.id),
            session: String(e.session),
            index: Number(e.index),
            role: String(e.role),
        })),
        prereg,
        101,
        new Set(),
    );

const labelOf = (plan: Plan, id: string): Label =>
    plan.skipped.has(id) ? "abandon" : (plan.labels.get(id) ?? "task");

const REACTIVE_LABELS = new Set(["pushback", "redirect", "abandon", "clarify"]);

function fixture(arms: string[] = ["a", "b"], events: Row[] = scriptedEvents()): Fixture {
    const plan = planOf(events);
    const journal: Row[] = [{ kind: "StartRun", arm: null, order: arms }];
    const pairing: Row[] = [];
    const tape: Row[] = [];
    for (const arm of arms) {
        const turns: { session: string; label: Label }[] = [];
        for (const e of events) {
            const id = String(e.id);
            const label = labelOf(plan, id);
            const skipped = plan.skipped.has(id);
            const reactive = REACTIVE_LABELS.has(label);
            const reply = `reply to ${id}`;
            const delivered = skipped
                ? ""
                : reactive
                  ? label === "abandon"
                      ? reply
                      : `${reply}\n\n${String(e.text)}`
                  : String(e.text);
            if (!skipped) turns.push({ session: String(e.session), label });
            if (reactive && !skipped && arm === arms[0]) {
                tape.push({
                    key: tapeKey(101, id, label, "c", String(e.text)),
                    event: id,
                    label,
                    digest: "d",
                    text: reply,
                    stop: "end_turn",
                });
            }
            pairing.push({
                kind: "turn",
                arm,
                session: e.session,
                event: id,
                index: e.index,
                label,
                delivered: !skipped,
                digest: "d",
                context_sha256: "c",
                prefix_sha256: "p",
                text_sha256: sha256Hex(delivered),
                source: reactive && !skipped ? "tape" : "script",
                ...(e.paste ? { paste: e.paste } : {}),
            });
            journal.push({
                kind: "UserTurn",
                arm,
                session: e.session,
                event: id,
                label,
                delivered: !skipped,
                ...(label === "interrupt" ? { interrupted: true } : {}),
            });
            journal.push({ kind: "Event", arm, event: id, outcome: "ok" });
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
        schema: "sim-run-manifest/v2",
        tier: "S",
        seed: 101,
        order: arms,
        events: events.length,
        scenario_hash: scenarioHash(scenarioOf(events)),
        prereg_sha256: preregistrationHash(prereg),
    };
    return { events, journal, pairing, tape, manifest };
}

const CORPUS_MANIFEST_SHA = sha256Hex(readFileSync(join(ROOT, "corpus/manifest.json"), "utf8"));
const scenarioOf = (events: Row[]) => ({
    manifest: { seed: 101, tier: "S", corpus_manifest_sha256: CORPUS_MANIFEST_SHA },
    events,
});

function run(f: Fixture): { exit: number; report: Record<string, unknown>; stderr: string } {
    dir = mkdtempSync(join(tmpdir(), "pairing-check-"));
    const body = scenarioOf(f.events);
    const scenario = { ...body, scenario_hash: scenarioHash(body) };
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
    writeFileSync(join(dir, "tape.jsonl"), f.tape.map((e) => `${JSON.stringify(e)}\n`).join(""));
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
    const failing = Object.entries(r.report).filter(
        ([k, v]) => k !== "rates" && k !== "divergences" && Array.isArray(v) && v.length > 0,
    );
    expect(failing).toEqual([]);
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
    find(f.journal, (r) => r.kind === "UserTurn" && r.arm === "a" && r.event === "e-0-5").label =
        "shout";
    const r = run(f);
    expect(r.report.invalid_labels).toEqual(["a e-0-5"]);
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
    const events = scriptedEvents();
    find(events, (e) => e.id === "e-1-1").role = "conveyance";
    const f = fixture(["a", "b"], events);
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
    find(h.pairing, (r) => r.arm === "b" && r.event === "e-0-1").digest = "d2";
    h.pairing.splice(
        h.pairing.findIndex((r) => r.arm === "b" && r.event === "e-0-1"),
        0,
        { ...diverged("e-0-1", 1, "d2"), reference_digest: "d" },
    );
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

const placeBefore = (f: Fixture, arm: string, event: string, row: Row) =>
    f.pairing.splice(
        f.pairing.findIndex((r) => r.arm === arm && r.event === event),
        0,
        row,
    );

test("a divergence row's digests must be the turn rows' digests at that event", () => {
    const f = fixture();
    find(f.pairing, (r) => r.arm === "b" && r.event === "e-0-1").digest = "d2";
    placeBefore(f, "b", "e-0-1", { ...diverged("e-0-1", 1, "d2"), reference_digest: "d" });
    expect(run(f).report.invalid_divergences).toEqual([]);
    const g = fixture();
    find(g.pairing, (r) => r.arm === "b" && r.event === "e-0-1").digest = "d2";
    placeBefore(g, "b", "e-0-1", { ...diverged("e-0-1", 1, "zz"), reference_digest: "d" });
    expect(run(g).report.invalid_divergences).toEqual(["b e-0-1"]);
    const h = fixture();
    find(h.pairing, (r) => r.arm === "b" && r.event === "e-0-1").digest = "d2";
    placeBefore(h, "b", "e-0-1", { ...diverged("e-0-1", 1, "d2"), reference_digest: "r" });
    expect(run(h).report.invalid_divergences).toEqual(["b e-0-1"]);
});

test("a journal user turn must carry its pairing row's session and label, with the scheduled interrupt as the one relabel", () => {
    const f = fixture();
    find(f.journal, (r) => r.kind === "UserTurn" && r.arm === "a" && r.event === "e-0-0").label =
        "pushback";
    find(f.journal, (r) => r.kind === "UserTurn" && r.arm === "a" && r.event === "e-0-1").label =
        "task";
    const r = run(f);
    expect(r.report.journal_pairing_mismatch).toEqual(["a e-0-0", "a e-0-1"]);
    expect(r.exit).toBe(1);
    const g = fixture();
    const relabelled = find(
        g.journal,
        (r) => r.kind === "UserTurn" && r.arm === "a" && r.event === "e-0-9",
    );
    relabelled.label = "task";
    relabelled.scheduled = "interrupt";
    delete relabelled.interrupted;
    const rates = find(g.journal, (r) => r.kind === "UserSimRates" && r.arm === "a");
    const turns = g.journal
        .filter((r) => r.kind === "UserTurn" && r.arm === "a")
        .map((r) => ({ session: String(r.session), label: r.label as Label }));
    Object.assign(rates, realisedRates(turns, prereg));
    expect(run(g).report.journal_pairing_mismatch).toEqual([]);
});

test("user-turn evidence outside the executed prefix is rejected", () => {
    const f = fixture();
    f.manifest = { ...f.manifest, events: 50 };
    f.journal = drop(
        f.journal,
        (r) => !(r.kind === "Event" && Number(String(r.event).split("-")[1]) >= 5),
    );
    f.journal = drop(
        f.journal,
        (r) => !(r.kind === "UserTurn" && Number(String(r.event).split("-")[1]) >= 5),
    );
    f.pairing = drop(f.pairing, (r) => Number(String(r.event).split("-")[1]) < 5);
    for (const arm of ["a", "b"]) {
        const rates = find(f.journal, (r) => r.kind === "UserSimRates" && r.arm === arm);
        const turns = f.journal
            .filter((r) => r.kind === "UserTurn" && r.arm === arm)
            .map((r) => ({ session: String(r.session), label: r.label as Label }));
        Object.assign(rates, realisedRates(turns, prereg));
    }
    expect(run(f).report.out_of_prefix).toEqual([]);
    f.pairing.push({ ...find(fixture().pairing, (r) => r.arm === "a" && r.event === "e-7-0") });
    f.journal.push({
        kind: "UserTurn",
        arm: "a",
        session: "s-7",
        event: "e-7-0",
        label: "pushback",
        delivered: true,
    });
    const r = run(f);
    expect(r.report.out_of_prefix).toEqual(["a e-7-0"]);
    expect(r.exit).toBe(1);
});

test("every delivered scripted row carries the compiled text's hash", () => {
    const events = scriptedEvents();
    find(events, (e) => e.id === "e-1-9").role = "conveyance";
    const f = fixture(["a", "b"], events);
    for (const arm of ["a", "b"]) {
        find(f.pairing, (r) => r.arm === arm && r.event === "e-1-9").text_sha256 =
            sha256Hex("else");
    }
    const r = run(f);
    expect(r.report.script_text_altered).toEqual(["a e-1-9", "b e-1-9"]);
    expect(r.exit).toBe(1);
});

test("a journal whose discarded tail is a terminated corrupt row is refused", () => {
    const f = fixture();
    dir = mkdtempSync(join(tmpdir(), "pairing-check-"));
    const body = scenarioOf(f.events);
    const scenario = { ...body, scenario_hash: scenarioHash(body) };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(f.manifest));
    writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
    writeFileSync(
        join(dir, "pairing.jsonl"),
        f.pairing.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
    writeFileSync(
        join(dir, "journal.jsonl"),
        `${f.journal.map((e) => `${JSON.stringify(e)}\n`).join("")}not json\n`,
    );
    const r = Bun.spawnSync(["bun", join(ROOT, "scripts/pairing-check.ts"), dir], {
        stdout: "pipe",
        stderr: "pipe",
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("corrupt");
});

test("a manifest without a non-empty distinct arm order is refused", () => {
    const f = fixture([]);
    const r = run(f);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("order");
});

test("a divergence row must precede its turn row", () => {
    const f = fixture();
    find(f.pairing, (r) => r.arm === "b" && r.event === "e-0-1").digest = "d2";
    f.pairing.push({ ...diverged("e-0-1", 1, "d2"), reference_digest: "d" });
    const r = run(f);
    expect(r.report.invalid_divergences).toEqual(["b e-0-1"]);
    expect(r.exit).toBe(1);
});

test("a journal user turn may be delivered only when its pairing row was", () => {
    const f = fixture();
    const row = find(f.pairing, (r) => r.arm === "a" && r.event === "e-0-5");
    row.delivered = false;
    row.label = "abandon";
    row.text_sha256 = sha256Hex("");
    find(f.journal, (r) => r.kind === "UserTurn" && r.arm === "a" && r.event === "e-0-5").label =
        "abandon";
    const rates = find(f.journal, (r) => r.kind === "UserSimRates" && r.arm === "a");
    Object.assign(
        rates,
        realisedRates(
            f.journal
                .filter((r) => r.kind === "UserTurn" && r.arm === "a" && r.delivered === true)
                .map((r) => ({ session: String(r.session), label: r.label as Label })),
            prereg,
        ),
    );
    const r = run(f);
    expect(r.report.journal_pairing_mismatch).toEqual(["a e-0-5"]);
    expect(r.exit).toBe(1);
});

test("the manifest's event count stays within the compiled scenario", () => {
    const f = fixture();
    f.manifest = { ...f.manifest, events: 500 };
    const r = run(f);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("events");
});

test("the manifest's seed and tier must be the compiled scenario's", () => {
    const f = fixture();
    f.manifest = { ...f.manifest, seed: 102 };
    const r = run(f);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("seed");
});

test("paste provenance is checked against the corpus the scenario was compiled from", () => {
    const f = fixture();
    dir = mkdtempSync(join(tmpdir(), "pairing-check-"));
    const base = scenarioOf(f.events);
    const body = {
        ...base,
        manifest: { ...base.manifest, corpus_manifest_sha256: "0".repeat(64) },
    };
    const scenario = { ...body, scenario_hash: scenarioHash(body) };
    writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({ ...f.manifest, scenario_hash: scenario.scenario_hash }),
    );
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
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString()).toContain("corpus");
});

test("a manifest from before the user-sim fields is refused by name", () => {
    const f = fixture();
    f.manifest = { ...f.manifest, schema: "sim-run-manifest/v1" };
    const r = run(f);
    expect(r.exit).not.toBe(0);
    expect(r.stderr).toContain("sim-run-manifest/v2");
});

test("a filler the host never received fails the check even when its pairing row says delivered", () => {
    const f = fixture();
    find(
        f.journal,
        (r) => r.kind === "UserTurn" && r.arm === "b" && r.event === "e-1-1",
    ).delivered = false;
    const rates = find(f.journal, (r) => r.kind === "UserSimRates" && r.arm === "b");
    Object.assign(
        rates,
        realisedRates(
            f.journal
                .filter((r) => r.kind === "UserTurn" && r.arm === "b" && r.delivered === true)
                .map((r) => ({ session: String(r.session), label: r.label as Label })),
            prereg,
        ),
    );
    const r = run(f);
    expect(r.report.undelivered_turns).toEqual(["b e-1-1"]);
    expect(r.exit).toBe(1);
});

test("a divergence row's context must be its turn row's context", () => {
    const f = fixture();
    find(f.pairing, (r) => r.arm === "b" && r.event === "e-0-1").digest = "d2";
    f.pairing.unshift({
        ...diverged("e-0-1", 1, "d2"),
        reference_digest: "d",
        context_sha256: "zz",
    });
    expect(run(f).report.invalid_divergences).toEqual(["b e-0-1"]);
});

test("a delivered row's source matches its label", () => {
    const f = fixture();
    for (const arm of ["a", "b"]) {
        find(f.pairing, (r) => r.arm === arm && r.event === "e-0-1").source = "script";
    }
    const r = run(f);
    expect(r.report.source_label_mismatch).toEqual(["a e-0-1", "b e-0-1"]);
    expect(r.exit).toBe(1);
});

test("an interrupt label in the journal carries the host's interruption", () => {
    const f = fixture();
    const r = run(f);
    expect(r.report.journal_pairing_mismatch).toEqual([]);
    const g = fixture();
    for (const arm of ["a", "b"]) {
        const row = find(
            g.journal,
            (r) => r.kind === "UserTurn" && r.arm === arm && r.event === "e-0-9",
        );
        delete row.interrupted;
    }
    expect(run(g).report.journal_pairing_mismatch).toEqual(["a e-0-9", "b e-0-9"]);
});

test("a sibling arm's live reply before its divergence fails the check", () => {
    const f = fixture();
    find(f.pairing, (r) => r.arm === "b" && r.event === "e-0-1").source = "live";
    const r = run(f);
    expect(r.report.live_before_divergence).toEqual(["b e-0-1"]);
    expect(r.exit).toBe(1);
    const g = fixture();
    find(g.pairing, (r) => r.arm === "b" && r.event === "e-0-2").digest = "d2";
    g.pairing.unshift({ ...diverged("e-0-2", 2, "d2"), reference_digest: "d" });
    find(g.pairing, (r) => r.arm === "b" && r.event === "e-0-3").source = "live";
    expect(run(g).report.live_before_divergence).toEqual([]);
});

test("a tape-backed row needs its reply on the run's own tape", () => {
    const f = fixture();
    const r = run(f);
    expect(r.report.tape_missing).toEqual([]);
    expect(r.exit).toBe(0);
    const g = fixture();
    g.tape = [];
    const gone = run(g);
    expect((gone.report.tape_missing as string[]).length).toBeGreaterThan(0);
    expect(gone.exit).toBe(1);
});

test("a task relabel of a scheduled interrupt cannot also report the interruption", () => {
    const f = fixture();
    const row = find(
        f.journal,
        (r) => r.kind === "UserTurn" && r.arm === "a" && r.event === "e-0-9",
    );
    row.label = "task";
    row.scheduled = "interrupt";
    row.interrupted = true;
    const rates = find(f.journal, (r) => r.kind === "UserSimRates" && r.arm === "a");
    Object.assign(
        rates,
        realisedRates(
            f.journal
                .filter((r) => r.kind === "UserTurn" && r.arm === "a")
                .map((r) => ({ session: String(r.session), label: r.label as Label })),
            prereg,
        ),
    );
    expect(run(f).report.journal_pairing_mismatch).toEqual(["a e-0-9"]);
});

test("a reference divergence needs the reference turn's row ahead of it", () => {
    const f = fixture();
    find(f.pairing, (r) => r.arm === "b" && r.event === "e-0-1").digest = "d2";
    const at = f.pairing.findIndex((r) => r.arm === "a" && r.event === "e-0-1");
    f.pairing.splice(at, 0, { ...diverged("e-0-1", 1, "d2"), reference_digest: "d" });
    expect(run(f).report.invalid_divergences).toEqual(["b e-0-1"]);
});

test("evidence for an arm the manifest never ran fails the check", () => {
    const f = fixture();
    f.pairing.push({ ...find(f.pairing, (r) => r.arm === "a" && r.event === "e-0-0"), arm: "zz" });
    f.journal.push({
        kind: "UserTurn",
        arm: "zz",
        session: "s-0",
        event: "e-0-0",
        label: "pushback",
        delivered: true,
    });
    const r = run(f);
    expect(r.report.unknown_arms).toEqual(["zz"]);
    expect(r.exit).toBe(1);
});

test("a sibling turn whose digest left the reference's needs a divergence row ahead of it", () => {
    const f = fixture();
    find(f.pairing, (r) => r.arm === "b" && r.event === "e-0-1").digest = "d2";
    const r = run(f);
    expect(r.report.missing_divergences).toEqual(["b e-0-1"]);
    expect(r.exit).toBe(1);
    const g = fixture();
    find(g.pairing, (r) => r.arm === "b" && r.event === "e-0-1").digest = "d2";
    placeBefore(g, "b", "e-0-1", { ...diverged("e-0-1", 1, "d2"), reference_digest: "d" });
    expect(run(g).report.missing_divergences).toEqual([]);
});

test("each pairing label is the one the seeded plan assigned", () => {
    const f = fixture();
    const a0 = find(f.pairing, (r) => r.arm === "a" && r.event === "e-0-0");
    const a1 = find(f.pairing, (r) => r.arm === "a" && r.event === "e-0-1");
    [a0.label, a1.label] = [a1.label, a0.label];
    const r = run(f);
    expect(r.report.plan_label_mismatch).toEqual(["a e-0-0", "a e-0-1"]);
    expect(r.exit).toBe(1);
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
    const events = scriptedEvents();
    const event = find(events, (e) => e.id === "e-0-5");
    event.role = "paste";
    event.text = text;
    event.paste = paste;
    const f = fixture(["a", "b"], events);
    const good = run(f);
    expect(good.report.paste_provenance).toEqual([]);
    expect(good.exit).toBe(0);
    find(f.pairing, (r) => r.arm === "b" && r.event === "e-0-5").paste = {
        ...paste,
        bytes: paste.bytes + 1,
    };
    const bad = run(f);
    expect(bad.report.paste_provenance).toEqual(["b e-0-5"]);
    expect(bad.exit).toBe(1);
});
