import { afterEach, describe, expect, test } from "bun:test";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SimConfig } from "../src/config/config";
import type { Snapshot } from "../src/grade/artefacts";
import { canonicalJson, sha256Hex } from "../src/prereg/canonical";
import { preregistrationHash } from "../src/prereg/validate";
import { releaseLease, takeLease } from "../src/run/journal";
import { loadPrereg } from "../src/scenario/inputs";
import { gradeRun } from "./grade-run";

const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
    probe: Record<string, unknown> & { id: string; type: string };
    snapshots: Snapshot[];
}

const fixture = (name: string): Fixture =>
    JSON.parse(readFileSync(join(ROOT, "tests/fixtures/grade", `${name}.json`), "utf8"));

interface RunOptions {
    probes: Fixture["probe"][];
    events?: number;
    models?: string[];
    prereg_sha256?: string;
    scenario_hash?: string;
    /** Arms whose journal stops before `EndArm`, with the number of events they ended. */
    interrupted?: Record<string, number>;
}

function run(o: RunOptions): string {
    const dir = mkdtempSync(join(tmpdir(), "grade-run-"));
    dirs.push(dir);
    const events: Record<string, unknown>[] = [
        { id: "e-0", kind: "session_start", scenario_ms: 0, session: "s-1" },
        ...o.probes.map((p, i) => ({
            id: `e-${i + 1}`,
            kind: "user_turn",
            scenario_ms: 1_000 * (i + 1),
            session: "s-1",
            index: i,
            probe: p.id,
            text: p.text,
        })),
        {
            id: "e-end",
            kind: "session_end",
            scenario_ms: 1_000 * (o.probes.length + 1),
            session: "s-1",
        },
    ];
    const body = {
        manifest: { seed: 1, tier: "S" },
        probes: o.probes.map((p, i) => ({ ...p, session: "s-1", event: `e-${i + 1}` })),
        events,
    };
    const scenario = { ...body, scenario_hash: sha256Hex(canonicalJson(body)) };
    writeFileSync(join(dir, "scenario.json"), `${canonicalJson(scenario)}\n`);
    const manifest = {
        schema: "sim-run-manifest/v1",
        tier: "S",
        seed: 1,
        host: "pi",
        order: ["host", "eidnara"],
        events: o.events ?? events.length,
        models: o.models ?? ["global.anthropic.claude-opus-5-5"],
        scenario_hash: o.scenario_hash ?? scenario.scenario_hash,
        prereg_sha256: o.prereg_sha256 ?? preregistrationHash(loadPrereg("S")),
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    const ran = events.slice(0, manifest.events);
    const journal: Record<string, unknown>[] = [
        { kind: "StartRun", arm: null, order: manifest.order },
    ];
    for (const arm of manifest.order) {
        const ended = o.interrupted?.[arm] ?? ran.length;
        journal.push({ kind: "StartArm", arm });
        for (const e of ran.slice(0, ended)) journal.push({ kind: "Event", arm, event: e.id });
        if (ended === ran.length && !(arm in (o.interrupted ?? {}))) {
            journal.push({ kind: "EndArm", arm });
        }
    }
    if (!o.interrupted) journal.push({ kind: "EndRun", arm: null });
    writeFileSync(
        join(dir, "journal.jsonl"),
        journal
            .map((e, i) => `${JSON.stringify({ seq: i, wall_ms: i, scenario_ms: 0, ...e })}\n`)
            .join(""),
    );
    return dir;
}

let seq = 0;
/** Appends a snapshot row and, for its agent calls, the `calls.jsonl` records the proxy would have written. */
function snapshot(dir: string, arm: string, s: Snapshot, journaled = true): void {
    const row = {
        ...s,
        session: s.session ?? "s-1",
        arm,
        id: `${arm}:${s.item}:${s.turn}:${seq++}`,
    };
    mkdirSync(join(dir, arm), { recursive: true });
    appendFileSync(join(dir, arm, "snapshots.jsonl"), `${JSON.stringify(row)}\n`);
    if (journaled) {
        const end = {
            seq,
            wall_ms: seq,
            kind: "EndTurn",
            arm,
            scenario_ms: 0,
            event: s.turn,
            outcome: s.turn_outcome === "ok" ? "ok" : "boom",
            probe: s.item,
            snapshot: row.id,
        };
        appendFileSync(join(dir, "journal.jsonl"), `${JSON.stringify(end)}\n`);
    }
    const calls = s.artefacts.find((a) => a.class === "proxy-call");
    if (calls?.class === "proxy-call" && journaled) {
        for (const c of calls.calls) {
            const record = {
                seq: c.seq,
                wall_ms: 0,
                scenario_ms: c.scenario_ms,
                arm,
                turn: c.turn,
                component: c.component,
                model: "global.anthropic.claude-opus-5-5",
                status: 200,
                error: null,
                finish_reason: "end_turn",
                input_tokens: c.input_tokens,
                output_tokens: c.output_tokens,
                ...(c.response_text ? { response_text: c.response_text } : {}),
                ...(c.response_text_truncated ? { response_text_truncated: true } : {}),
            };
            appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(record)}\n`);
        }
    }
    if (!journaled) return;
    const entry = {
        seq,
        wall_ms: seq,
        kind: "SnapshotArtefacts",
        arm,
        scenario_ms: 0,
        item: s.item,
        snapshot: row.id,
    };
    appendFileSync(join(dir, "journal.jsonl"), `${JSON.stringify(entry)}\n`);
}

const p5 = fixture("P5-pass");
const snap = p5.snapshots[0] as Snapshot;

const p7snapshot = (item: string, turn = "e-1"): Snapshot => ({
    id: "x",
    item,
    arm: "x",
    session: "s-1",
    turn,
    turn_outcome: "ok",
    artefacts: [
        {
            id: "calls",
            class: "proxy-call",
            calls: [
                {
                    seq: 1,
                    component: "agent",
                    turn: "e-1",
                    scenario_ms: 0,
                    input_tokens: 1,
                    output_tokens: 1,
                    response_text: "because",
                },
            ],
        },
    ],
});

describe("grade-run", () => {
    test("a journal-backed user-sim entry in a snapshot is not reconciled against calls.jsonl", async () => {
        const p8 = fixture("P8-pass");
        const dir = run({ probes: [p8.probe] });
        const base = p8.snapshots[0] as Snapshot;
        const withUser: Snapshot = {
            ...base,
            artefacts: base.artefacts.map((a) =>
                a.class === "proxy-call"
                    ? {
                          ...a,
                          calls: [
                              ...a.calls,
                              {
                                  seq: 999,
                                  component: "user-sim",
                                  turn: base.turn,
                                  scenario_ms: 0,
                                  input_tokens: 0,
                                  output_tokens: 0,
                                  label: "task",
                                  journal: true,
                              },
                          ],
                      }
                    : a,
            ),
        };
        snapshot(dir, "eidnara", withUser);
        const calls = readFileSync(join(dir, "calls.jsonl"), "utf8")
            .trim()
            .split("\n")
            .filter((l) => !l.includes('"seq":999'));
        writeFileSync(join(dir, "calls.jsonl"), `${calls.join("\n")}\n`);
        expect((await gradeRun(dir, null)).verdicts).toEqual({ "eidnara/P8": { pass: 1 } });
    });

    test("grades a journaled snapshot and keys skipped items by arm and reason", async () => {
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", snap);
        const summary = await gradeRun(dir, null);
        expect(summary.verdicts).toEqual({ "eidnara/P5": { pass: 1 } });
        expect(summary.skipped).toEqual({ host: { "no journaled snapshot": 1 } });
    });

    test("the journaled first attempt is graded; the arm's later snapshots of the item are counted", async () => {
        const failing = { ...(fixture("P5-fail").snapshots[0] as Snapshot), item: snap.item };
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", { ...failing, turn: "e-1-interrupted" }, false);
        snapshot(dir, "eidnara", snap);
        snapshot(dir, "eidnara", { ...failing, turn: "e-1-retry" }, false);
        snapshot(dir, "eidnara", { ...failing, turn: "e-1-retry-2" }, false);
        const summary = await gradeRun(dir, null);
        expect(summary.verdicts).toEqual({ "eidnara/P5": { pass: 1 } });
        const [grade] = readFileSync(join(dir, "grades.jsonl"), "utf8").trim().split("\n");
        expect(JSON.parse(grade as string).later_attempts_logged).toBe(2);
    });

    test("a P7 pair that cannot be judged is charged to both arms, naming the side that failed", async () => {
        const p7 = fixture("P7-pass");
        const dir = run({ probes: [p7.probe] });
        snapshot(dir, "eidnara", { ...p7snapshot(p7.probe.id), turn_outcome: "ok" });
        snapshot(dir, "host", { ...p7snapshot(p7.probe.id), turn_outcome: "failed" });
        const summary = await gradeRun(dir, null);
        expect(summary.skipped).toEqual({
            host: { "P7 probe turn failed": 1 },
            eidnara: { "P7 pairing lost": 1 },
        });
    });

    test("a P7 snapshot without its proxy-call artefact aborts grading instead of reading as a refusal", async () => {
        const p7 = fixture("P7-pass");
        const dir = run({ probes: [p7.probe] });
        snapshot(dir, "eidnara", p7snapshot(p7.probe.id));
        snapshot(dir, "host", {
            ...p7snapshot(p7.probe.id),
            artefacts: [{ id: "d", class: "diff", role: "turn", patch: "" }],
        });
        await expect(gradeRun(dir, null)).rejects.toThrow("lacks the proxy-call artefact P7 reads");
        expect(existsSync(join(dir, "grades.jsonl"))).toBe(false);
    });

    test("a judge output that is a symlink is refused before the judge gateway starts", async () => {
        const p7 = fixture("P7-pass");
        const dir = run({ probes: [p7.probe] });
        snapshot(dir, "eidnara", p7snapshot(p7.probe.id));
        snapshot(dir, "host", { ...p7snapshot(p7.probe.id), id: "y" });
        const outside = join(mkdtempSync(join(tmpdir(), "grade-run-out-")), "victim");
        writeFileSync(outside, "keep me\n");
        symlinkSync(outside, join(dir, "judgments.jsonl"));
        const config = { bedrock: { region: "us-east-1", aws_profile: "none" } } as SimConfig;
        await expect(gradeRun(dir, config)).rejects.toThrow("not a regular file");
        expect(existsSync(join(dir, "judge-calls.jsonl"))).toBe(false);
        expect(readFileSync(outside, "utf8")).toBe("keep me\n");
    });

    test("a journaled snapshot for an item the scenario does not compile aborts grading", async () => {
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", snap);
        snapshot(dir, "host", { ...snap, item: "P5-typo" });
        await expect(gradeRun(dir, null)).rejects.toThrow("which the scenario does not compile");
        expect(existsSync(join(dir, "grades.jsonl"))).toBe(false);
    });

    test("a scenario whose seed or tier differs from the manifest is refused despite a matching digest", async () => {
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", snap);
        const path = join(dir, "scenario.json");
        const { scenario_hash: _old, ...body } = JSON.parse(readFileSync(path, "utf8"));
        body.manifest.seed = 2;
        writeFileSync(
            path,
            canonicalJson({ ...body, scenario_hash: sha256Hex(canonicalJson(body)) }),
        );
        const manifestPath = join(dir, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        manifest.scenario_hash = sha256Hex(canonicalJson(body));
        writeFileSync(manifestPath, JSON.stringify(manifest));
        await expect(gradeRun(dir, null)).rejects.toThrow("seed 2, not the manifest's S seed 1");
    });

    test("probes whose turn lies past the run's event prefix are reported as outside the run, for every arm", async () => {
        const second = { ...p5.probe, id: "P5-b" };
        const p7 = fixture("P7-pass").probe;
        const dir = run({ probes: [p5.probe, second, p7], events: 2 });
        snapshot(dir, "eidnara", snap);
        snapshot(dir, "host", snap);
        const summary = await gradeRun(dir, null);
        expect(summary.skipped).toEqual({
            host: { "probe turn outside the run's 2 events": 2 },
            eidnara: { "probe turn outside the run's 2 events": 2 },
        });
    });

    test("refuses a run whose pre-registration or scenario digest differs from its manifest", async () => {
        const stale = run({ probes: [p5.probe], prereg_sha256: "0".repeat(64) });
        await expect(gradeRun(stale, null)).rejects.toThrow("prereg_sha256");
        const edited = run({ probes: [p5.probe] });
        const path = join(edited, "scenario.json");
        const scenario = JSON.parse(readFileSync(path, "utf8"));
        scenario.probes[0].check.must_not = [];
        writeFileSync(path, canonicalJson(scenario));
        await expect(gradeRun(edited, null)).rejects.toThrow("scenario_hash");
    });

    test("the summary names the grade versions it aggregates", async () => {
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", snap);
        expect((await gradeRun(dir, null)).versions).toEqual({ "1": 1 });
        expect((await gradeRun(dir, null)).versions).toEqual({ "2": 1 });
    });

    test("a journal whose events are complete but reordered is refused", async () => {
        const dir = run({ probes: [p5.probe, { ...p5.probe, id: "P5-b" }] });
        snapshot(dir, "host", snap);
        snapshot(dir, "eidnara", snap);
        const path = join(dir, "journal.jsonl");
        const lines = readFileSync(path, "utf8").trim().split("\n");
        const idx = (id: string) =>
            lines.findIndex((l) => {
                const e = JSON.parse(l);
                return e.kind === "Event" && e.arm === "eidnara" && e.event === id;
            });
        const [a, b] = [idx("e-1"), idx("e-2")];
        [lines[a], lines[b]] = [lines[b] as string, lines[a] as string];
        writeFileSync(path, `${lines.join("\n")}\n`);
        await expect(gradeRun(dir, null)).rejects.toThrow("out of order from e-2");
    });

    test("a journaled snapshot's fold calls must be recorded in calls.jsonl too", async () => {
        const p13 = fixture("P13-pass");
        const dir = run({ probes: [p13.probe] });
        snapshot(dir, "host", p13.snapshots[0] as Snapshot);
        snapshot(dir, "eidnara", p13.snapshots[0] as Snapshot);
        const path = join(dir, "calls.jsonl");
        const kept = readFileSync(path, "utf8")
            .trim()
            .split("\n")
            .filter((l) => JSON.parse(l).arm !== "eidnara");
        writeFileSync(path, `${kept.join("\n")}\n`);
        await expect(gradeRun(dir, null)).rejects.toThrow(
            "holds call 5, which calls.jsonl does not record",
        );
    });

    test("an interrupted run is refused, naming the arm and its event counts", async () => {
        const dir = run({ probes: [p5.probe], interrupted: { eidnara: 1 } });
        snapshot(dir, "host", snap);
        await expect(gradeRun(dir, null)).rejects.toThrow(/arm eidnara .*1 of 3 events/);
        expect(() => readFileSync(join(dir, "grades.jsonl"))).toThrow();
    });

    test("a journal whose terminal events name an unscheduled or repeated id is refused", async () => {
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", snap);
        const path = join(dir, "journal.jsonl");
        const lines = readFileSync(path, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l));
        const swapped = lines.map((e) =>
            e.kind === "Event" && e.arm === "host" && e.event === "e-1"
                ? { ...e, event: "e-9" }
                : e,
        );
        writeFileSync(path, swapped.map((e) => `${JSON.stringify(e)}\n`).join(""));
        await expect(gradeRun(dir, null)).rejects.toThrow(/arm host .*2 of 3 events .*e-9/);
        expect(() => readFileSync(join(dir, "grades.jsonl"))).toThrow();
    });

    test("a P7 snapshot carrying a transcript artefact aborts grading instead of reading as a refusal", async () => {
        const p7 = fixture("P7-pass");
        const dir = run({ probes: [p7.probe] });
        const leaky = p7snapshot(p7.probe.id);
        (leaky.artefacts as unknown[]).push({ id: "t", class: "transcript" });
        snapshot(dir, "host", p7snapshot(p7.probe.id));
        snapshot(dir, "eidnara", leaky);
        await expect(gradeRun(dir, null)).rejects.toThrow("is not a grade input");
    });

    test("a manifest whose arm order differs from the journaled StartRun is refused", async () => {
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", snap);
        const path = join(dir, "manifest.json");
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        writeFileSync(path, JSON.stringify({ ...manifest, order: ["host"] }));
        await expect(gradeRun(dir, null)).rejects.toThrow(/order .*host.*eidnara/);
        writeFileSync(path, JSON.stringify({ ...manifest, order: ["host", "host"] }));
        await expect(gradeRun(dir, null)).rejects.toThrow(/order/);
        expect(() => readFileSync(join(dir, "grades.jsonl"))).toThrow();
    });

    test("an answer the proxy truncated excludes its item, and grades are appended only once every item is graded", async () => {
        const p8 = fixture("P8-pass");
        const cut = { ...structuredClone(p8.snapshots[0]), turn: "e-2" } as Snapshot;
        const calls = cut.artefacts.find((a) => a.class === "proxy-call") as unknown as {
            calls: Record<string, unknown>[];
        };
        for (const c of calls.calls) if (c.turn === "e-1") c.turn = "e-2";
        (calls.calls.at(-1) as Record<string, unknown>).response_text_truncated = true;
        const dir = run({ probes: [p5.probe, p8.probe] });
        snapshot(dir, "eidnara", snap);
        snapshot(dir, "eidnara", cut);
        const summary = await gradeRun(dir, null);
        expect(summary.verdicts).toEqual({ "eidnara/P5": { pass: 1 } });
        expect(summary.skipped.eidnara).toEqual({ "answer refused": 1 });
        const leaky = structuredClone(cut);
        (leaky.artefacts as unknown[]).push({ id: "t", class: "transcript" });
        const broken = run({ probes: [p5.probe, p8.probe] });
        snapshot(broken, "eidnara", snap);
        snapshot(broken, "eidnara", leaky);
        await expect(gradeRun(broken, null)).rejects.toThrow("is not a grade input");
        expect(() => readFileSync(join(broken, "grades.jsonl"))).toThrow();
    });

    test("a journaled snapshot row whose arm or item differs from its journal entry is refused", async () => {
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", snap);
        const path = join(dir, "eidnara", "snapshots.jsonl");
        const row = JSON.parse(readFileSync(path, "utf8").trim());
        writeFileSync(path, `${JSON.stringify({ ...row, item: "P5-other" })}\n`);
        await expect(gradeRun(dir, null)).rejects.toThrow("does not match its journal entry");
        writeFileSync(path, `${JSON.stringify({ ...row, artefacts: [] })}\n`);
        await expect(gradeRun(dir, null)).rejects.toThrow("has no artefacts");
        const retry = { ...row, id: "retry", artefacts: [{ id: "t", class: "transcript" }] };
        writeFileSync(path, `${JSON.stringify(row)}\n${JSON.stringify(retry)}\n`);
        await expect(gradeRun(dir, null)).rejects.toThrow("is not a grade input");
        expect(() => readFileSync(join(dir, "grades.jsonl"))).toThrow();
    });

    test("a journaled snapshot id with no row in snapshots.jsonl is refused", async () => {
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", snap);
        writeFileSync(join(dir, "eidnara", "snapshots.jsonl"), "");
        await expect(gradeRun(dir, null)).rejects.toThrow("have no row in snapshots.jsonl");
    });

    test("a journaled snapshot's agent calls must be recorded in calls.jsonl under its arm", async () => {
        const p8 = fixture("P8-pass");
        const dir = run({ probes: [p8.probe] });
        snapshot(dir, "eidnara", p8.snapshots[0] as Snapshot);
        expect((await gradeRun(dir, null)).verdicts).toEqual({ "eidnara/P8": { pass: 1 } });
        const missing = run({ probes: [p8.probe] });
        snapshot(missing, "eidnara", p8.snapshots[0] as Snapshot);
        writeFileSync(join(missing, "calls.jsonl"), "");
        await expect(gradeRun(missing, null)).rejects.toThrow("which calls.jsonl does not record");
        const edited = run({ probes: [p8.probe] });
        snapshot(edited, "eidnara", p8.snapshots[0] as Snapshot);
        const path = join(edited, "eidnara", "snapshots.jsonl");
        const row = JSON.parse(readFileSync(path, "utf8").trim());
        for (const a of row.artefacts) {
            if (a.class !== "proxy-call") continue;
            for (const c of a.calls) if (c.component === "agent") c.response_text = "";
        }
        writeFileSync(path, `${JSON.stringify(row)}\n`);
        await expect(gradeRun(edited, null)).rejects.toThrow(
            "with content that differs from calls.jsonl",
        );
        const earlier = run({ probes: [p8.probe, { ...p8.probe, id: "P8-b" }] });
        const base = p8.snapshots[0] as Snapshot;
        snapshot(earlier, "eidnara", base);
        snapshot(earlier, "eidnara", { ...base, item: "P8-b", turn: "e-2" });
        const log = join(earlier, "eidnara", "snapshots.jsonl");
        const [first, second] = readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l));
        for (const a of first.artefacts) {
            if (a.class !== "proxy-call") continue;
            for (const c of a.calls) if (c.component === "agent") c.response_text = "";
        }
        writeFileSync(log, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);
        await expect(gradeRun(earlier, null)).rejects.toThrow(
            "with content that differs from calls.jsonl",
        );
    });

    test("agent calls whose model the manifest does not record are refused before judging", async () => {
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", snap);
        const call = {
            seq: 0,
            wall_ms: 0,
            scenario_ms: 0,
            arm: "eidnara",
            component: "agent",
            model: "global.openai.gpt-5.6-luna",
            status: 200,
        };
        appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(call)}\n`);
        await expect(gradeRun(dir, null)).rejects.toThrow("models the manifest does not record");
        expect(() => readFileSync(join(dir, "grades.jsonl"))).toThrow();
    });

    test("a journaled row without a session, or whose outcome disagrees with its EndTurn, is refused", async () => {
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", snap);
        const path = join(dir, "eidnara", "snapshots.jsonl");
        const row = JSON.parse(readFileSync(path, "utf8").trim());
        const { session: _s, ...unbound } = row;
        writeFileSync(path, `${JSON.stringify(unbound)}\n`);
        await expect(gradeRun(dir, null)).rejects.toThrow("in session undefined");
        writeFileSync(path, `${JSON.stringify({ ...row, turn_outcome: "failed" })}\n`);
        await expect(gradeRun(dir, null)).rejects.toThrow("but its EndTurn ended ok");
        writeFileSync(path, `${JSON.stringify({ ...row, turn_outcome: "fine" })}\n`);
        await expect(gradeRun(dir, null)).rejects.toThrow("records turn_outcome fine");
    });

    test("a journaled row whose turn differs from the probe's event is refused", async () => {
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", { ...snap, turn: "e-9" });
        await expect(gradeRun(dir, null)).rejects.toThrow("not the probe's event e-1");
    });

    test("two snapshot rows carrying one journaled id are refused", async () => {
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", snap);
        const path = join(dir, "eidnara", "snapshots.jsonl");
        const row = readFileSync(path, "utf8");
        appendFileSync(path, row);
        await expect(gradeRun(dir, null)).rejects.toThrow("more than one row in snapshots.jsonl");
    });

    test("a journal naming two first snapshots for one arm and item is refused", async () => {
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", snap);
        snapshot(dir, "eidnara", { ...snap, turn: "e-1-again" });
        await expect(gradeRun(dir, null)).rejects.toThrow("more than one first snapshot");
    });

    test("a grading output that is a symlink is refused before anything is written", async () => {
        const dir = run({ probes: [p5.probe] });
        snapshot(dir, "eidnara", snap);
        const outside = join(mkdtempSync(join(tmpdir(), "grade-run-out-")), "victim");
        writeFileSync(outside, "keep me\n");
        symlinkSync(outside, join(dir, "grades.jsonl"));
        await expect(gradeRun(dir, null)).rejects.toThrow("not a regular file");
        expect(readFileSync(outside, "utf8")).toBe("keep me\n");
    });

    test("a run directory leased by a live process is refused", async () => {
        const dir = run({ probes: [p5.probe] });
        takeLease(dir);
        try {
            await expect(gradeRun(dir, null)).rejects.toThrow(/is leased by pid/);
        } finally {
            releaseLease(dir);
        }
    });

    test("the judge firewall is checked against every model the manifest records, before any grade is appended", async () => {
        const p7 = fixture("P7-pass");
        const p7snap = p7snapshot(p7.probe.id, "e-2");
        const dir = run({
            probes: [p5.probe, p7.probe],
            models: ["global.anthropic.claude-opus-5-5", "global.openai.gpt-5.6-luna"],
        });
        snapshot(dir, "eidnara", snap);
        snapshot(dir, "host", p7snap);
        snapshot(dir, "eidnara", p7snap);
        await expect(gradeRun(dir, null)).rejects.toThrow("shares the agent model's family");
        expect(() => readFileSync(join(dir, "grades.jsonl"))).toThrow();
    });
});
