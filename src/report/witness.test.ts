import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArmLogs } from "../oracle/logs";
import type { Entry } from "../run/journal";
import type { Scenario } from "../scenario/compile";
import { loadPrereg } from "../scenario/inputs";
import type { GradedRun } from "./observe";
import { type PropertyWitness, propertyWitness } from "./witness";

const prereg = loadPrereg("S");
const CATALOG = ["P02", "P03", "P11", "P25", "P41", "P42", "P99"]
    .map((n) => `| SIM-${n} | [sim-${n.toLowerCase()}-x](#x) | safety |`)
    .join("\n");
const lines = (rows: object[]) => `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

function run(broken: boolean): GradedRun {
    const dir = mkdtempSync(join(tmpdir(), "sim-witness-"));
    writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({ order: ["host", "eidnara"], events: 4 }),
    );
    const turn = (arm: string, event: string, text: string) => ({
        kind: "turn",
        arm,
        session: "s-1",
        event,
        index: 0,
        label: "task",
        delivered: true,
        digest: "d",
        prefix_sha256: "p",
        text_sha256: text,
        source: "script",
    });
    const diverged = {
        kind: "divergedAt",
        arm: "eidnara",
        session: "s-1",
        event: "e-2",
        index: 1,
        digest: "d",
        reference_digest: "b",
        against: "reference",
    };
    const hostLater = { ...turn("host", "e-2", "w"), index: 1, digest: "b" };
    const pairing = broken
        ? [
              turn("host", "e-1", "t"),
              turn("eidnara", "e-1", "u"),
              hostLater,
              { ...turn("eidnara", "e-2", "v"), index: 1 },
              diverged,
          ]
        : [
              turn("host", "e-1", "t"),
              turn("eidnara", "e-1", "t"),
              hostLater,
              diverged,
              { ...turn("eidnara", "e-2", "v"), index: 1 },
          ];
    writeFileSync(join(dir, "pairing.jsonl"), lines(pairing));
    let seq = 0;
    const entry = (kind: string, scenario_ms: number, extra: object = {}) =>
        ({ kind, arm: "eidnara", scenario_ms, seq: seq++, wall_ms: 0, ...extra }) as Entry;
    const journal = [
        entry("UserTurn", 10, { event: "e-1", label: "task", arm: "host", delivered: true }),
        entry("UserTurn", 10, {
            event: "e-1",
            label: broken ? "nagging" : "task",
            delivered: true,
        }),
        entry("EndTurn", 15, { event: "e-1", outcome: "ok", probe: "q-1" }),
        entry("SnapshotArtefacts", 20, { item: "q-1" }),
        entry(broken ? "SnapshotArtefacts" : "Event", broken ? 5 : 30, { item: "q-1" }),
    ];
    writeFileSync(join(dir, "journal.jsonl"), lines(journal));
    const armOf = (name: string): ArmLogs => ({
        arm: name,
        calls: [],
        journal: journal.filter((e) => e.arm === name),
        pluginLog: [],
        daemonLog: [],
        resources: [],
        tools: [],
    });
    const scenario = { events: [], faults: [], probes: [] } as unknown as Scenario;
    // The witness reads the run, scenario, and grades; the rest of a GradedRun is left out.
    return {
        run: {
            dir,
            tier: "S",
            base_wall_ms: 0,
            prereg,
            kinds: new Map(),
            arms: [armOf("host"), armOf("eidnara")],
        },
        scenario,
        grades: [],
        host: "pi",
    } as unknown as GradedRun;
}

describe("property witness", () => {
    test("checked records are witnessed on a sound run and violated on a broken one; the rest are unreached", () => {
        const status = (runs: GradedRun[]) =>
            Object.fromEntries(propertyWitness(CATALOG, runs).map((w) => [w.id, w.status]));
        expect(status([run(false)])).toEqual({
            "SIM-P02": "witnessed",
            "SIM-P03": "witnessed",
            "SIM-P11": "witnessed",
            "SIM-P25": "witnessed",
            "SIM-P41": "witnessed",
            "SIM-P42": "unreached",
            "SIM-P99": "unchecked",
        });
        expect(status([run(true)])).toEqual({
            "SIM-P02": "violated",
            "SIM-P03": "violated",
            "SIM-P11": "violated",
            "SIM-P25": "violated",
            "SIM-P41": "violated",
            "SIM-P42": "unreached",
            "SIM-P99": "unchecked",
        });
    });

    test("clock, call-time, fault, snapshot, grade, and hidden-divergence checks catch their breaks", () => {
        const ids = ["P03", "P12", "P14", "P15", "P30", "P41", "P42"];
        const catalog = ids.map((n) => `| SIM-${n} | [x](#x) | safety |`).join("\n");
        const status = (broken: boolean) =>
            Object.fromEntries(
                propertyWitness(catalog, [second(broken)]).map((w) => [w.id, w.status]),
            );
        const sound = status(false);
        // P30 is reached by injected calls; an observed infrastructure fault alone is none.
        expect(Object.values(sound)).toEqual(
            ids.map((n) => (n === "P03" || n === "P30" ? "unreached" : "witnessed")),
        );
        expect(Object.values(status(true))).toEqual(ids.map(() => "violated"));
        const busy = propertyWitness(catalog, [second(false, true)]);
        expect(
            busy.filter((w) => ["SIM-P12", "SIM-P14"].includes(w.id)).map((w) => w.status),
        ).toEqual(["violated", "witnessed"]);
    });
});

function second(broken: boolean, busy = false): GradedRun {
    const dir = mkdtempSync(join(tmpdir(), "sim-witness-"));
    writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({ order: ["host", "eidnara"], events: 3 }),
    );
    const turn = (arm: string, digest: string, event = "e-1", delivered = true) => ({
        kind: "turn",
        arm,
        session: "s-1",
        event,
        index: event === "e-1" ? 0 : 1,
        delivered,
        digest,
        text_sha256: "t",
    });
    writeFileSync(
        join(dir, "pairing.jsonl"),
        lines([
            turn("host", "a"),
            turn("eidnara", broken ? "b" : "a"),
            turn("host", "x", "e-2", false),
            turn("eidnara", "y", "e-2", false),
        ]),
    );
    let seq = 0;
    const at = (kind: string, scenario_ms: number, extra: object = {}) =>
        ({ kind, arm: "eidnara", scenario_ms, seq: seq++, wall_ms: 0, ...extra }) as Entry;
    const begin = at("BeginTurn", 10, { event: "e-1" });
    const end = at("EndTurn", 20, { event: "e-1", outcome: "ok" });
    const jump = at("AdvanceClock", broken ? 150 : 100, { from_ms: broken || busy ? 10 : 20 });
    // seq follows the journal's order, which is what the checks read.
    const journal = [
        begin,
        ...(broken || busy ? [jump, end] : [end, jump]),
        at("Event", 20, { event: "e-1" }),
        at("FaultObserved", 100, { fault: broken ? "f-9" : "f-1" }),
        at("EndTurn", 100, { event: "e-2", outcome: "ok", probe: "q-1" }),
        at("SnapshotArtefacts", 100, { item: "q-1", snapshot: "eidnara:q-1:e-1" }),
    ].map((e, i) => ({ ...e, seq: i }));
    writeFileSync(join(dir, "journal.jsonl"), lines(journal));
    const grade = (version: number, snapshot: string) => ({
        item: "q-1",
        arm: "eidnara",
        version,
        snapshot,
        verdict: "pass",
    });
    const cited = broken ? "eidnara:q-1:e-2" : "eidnara:q-1:e-1";
    const grades = broken ? [grade(1, cited), grade(1, cited)] : [grade(1, cited)];
    writeFileSync(join(dir, "grades.jsonl"), lines(grades));
    const call = (s: number, wall_ms: number) => ({
        seq: s,
        scenario_ms: 10,
        wall_ms,
        started_wall_ms: wall_ms,
    });
    const arm = {
        arm: "eidnara",
        journal,
        calls: broken ? [call(0, 5), call(1, 3)] : [call(0, 3), call(1, 5)],
        resources: [],
        tools: [],
    } as unknown as ArmLogs;
    const scenario = {
        events: [
            { id: "e-1", scenario_ms: 10 },
            { id: "e-2", scenario_ms: 100 },
        ],
        faults: [{ id: "f-1", type: "daemon_restart", params: {} }],
        probes: [],
    } as unknown as Scenario;
    return {
        run: { dir, tier: "S", base_wall_ms: 0, prereg, kinds: new Map(), arms: [arm] },
        scenario,
        grades: [grade(1, cited)],
    } as unknown as GradedRun;
}

interface Parts {
    arms?: string[];
    capped?: boolean;
    fault_override?: object[];
    tapes?: string[];
    events?: object[];
    pairing?: object[];
    journal?: object[];
    grades?: object[];
    used?: object[];
    calls?: object[];
    faults?: object[];
}

/** A run from its parts alone; every omitted artefact is empty. */
function made(p: Parts): GradedRun {
    const dir = mkdtempSync(join(tmpdir(), "sim-witness-"));
    writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({
            order: ["host", "eidnara"],
            events: p.capped ? 0 : 3,
            tapes: p.tapes ?? [],
            fault_override: p.fault_override ?? null,
        }),
    );
    writeFileSync(join(dir, "pairing.jsonl"), lines(p.pairing ?? []));
    const journal = (p.journal ?? []).map(
        (e, i) => ({ arm: "eidnara", wall_ms: i, seq: i, ...e }) as Entry,
    );
    writeFileSync(join(dir, "journal.jsonl"), lines(journal));
    writeFileSync(join(dir, "grades.jsonl"), lines(p.grades ?? []));
    const arms = (p.arms ?? ["eidnara"]).map(
        (name) =>
            ({
                arm: name,
                journal: journal.filter((e) => e.arm === name),
                calls: name === "eidnara" ? (p.calls ?? []) : [],
                tools: [],
            }) as unknown as ArmLogs,
    );
    const events = [{ id: "e-1", scenario_ms: 10 }, ...(p.events ?? [])];
    const scenario = { events, faults: p.faults ?? [], probes: [] } as unknown as Scenario;
    return {
        run: { dir, tier: "S", base_wall_ms: 0, prereg, kinds: new Map(), arms },
        scenario,
        grades: p.used ?? p.grades ?? [],
    } as unknown as GradedRun;
}

const one = (id: string, run: GradedRun) =>
    propertyWitness(`| SIM-${id} | [x](#x) | safety |`, [run])[0] as PropertyWitness;

describe("property witness evidence", () => {
    const turn = (arm: string, digest: string, extra: object = {}) => ({
        kind: "turn",
        arm,
        session: "s-1",
        event: "e-1",
        index: 0,
        delivered: true,
        digest,
        text_sha256: "t",
        ...extra,
    });

    test("SIM-P02 needs a reference turn and its counterpart; reference turns alone are unreached", () => {
        expect(one("P02", made({ pairing: [turn("host", "a")] }))).toMatchObject({
            status: "unreached",
        });
        const sent = ["host", "eidnara"].map((arm) => ({
            kind: "UserTurn",
            arm,
            scenario_ms: 1,
            event: "e-1",
            delivered: true,
        }));
        const both = { journal: sent, arms: ["host", "eidnara"] };
        expect(
            one("P02", made({ ...both, pairing: [turn("host", "a"), turn("eidnara", "a")] })),
        ).toMatchObject({ status: "witnessed", detail: "1 paired user turns" });
        const diverged = {
            kind: "divergedAt",
            arm: "eidnara",
            session: "s-1",
            event: "e-1",
            index: 0,
            digest: "b",
            reference_digest: "a",
            against: "reference",
        };
        expect(
            one("P02", made({ pairing: [turn("host", "a"), diverged, turn("eidnara", "b")] })),
        ).toMatchObject({ status: "unreached" });
        const skipped = turn("eidnara", "a", { delivered: false });
        expect(one("P02", made({ pairing: [turn("host", "a"), skipped] }))).toMatchObject({
            status: "violated",
            detail: expect.stringContaining("delivered"),
        });
        // A pairing record is written before the prompt; a pair counts once both arms journaled
        // the turn.
        const journaled = [
            { kind: "UserTurn", arm: "host", scenario_ms: 1, event: "e-1", delivered: true },
        ];
        expect(
            one(
                "P02",
                made({
                    pairing: [turn("host", "a"), turn("eidnara", "a")],
                    journal: journaled,
                    arms: ["host", "eidnara"],
                }),
            ),
        ).toMatchObject({ status: "unreached" });
    });

    test("SIM-P03 needs the divergence record's hashes to be the turns' digests", () => {
        const diverged = (digest: string, reference_digest: string) => ({
            kind: "divergedAt",
            arm: "eidnara",
            session: "s-1",
            event: "e-1",
            index: 0,
            digest,
            reference_digest,
            against: "reference",
        });
        const run = (d: string, r: string) =>
            made({ pairing: [turn("host", "a"), diverged(d, r), turn("eidnara", "b")] });
        expect(one("P03", run("b", "a")).status).toBe("witnessed");
        expect(one("P03", run("a", "b")).status).toBe("violated");
        expect(one("P03", run("b", "x")).status).toBe("violated");
    });

    test("SIM-P03 compares a replayed run's divergence against the digest its source tape recorded", () => {
        const source = mkdtempSync(join(tmpdir(), "sim-witness-tape-"));
        writeFileSync(join(source, "pairing.jsonl"), lines([turn("eidnara", "r")]));
        const diverged = (reference_digest: string) => ({
            kind: "divergedAt",
            arm: "eidnara",
            session: "s-1",
            event: "e-1",
            index: 0,
            digest: "b",
            reference_digest,
            against: "recorded",
        });
        const run = (r: string) =>
            made({
                tapes: [join(source, "tape.jsonl")],
                pairing: [turn("host", "b"), diverged(r), turn("eidnara", "b")],
            });
        expect(one("P03", run("r")).status).toBe("witnessed");
        expect(one("P03", run("x")).status).toBe("violated");
        rmSync(join(source, "pairing.jsonl"));
        expect(one("P03", run("r"))).toMatchObject({
            status: "violated",
            detail: expect.stringContaining("source digest"),
        });
    });

    test("SIM-P03 counts a divergence only once both turns it describes are on the log", () => {
        const diverged = {
            kind: "divergedAt",
            arm: "eidnara",
            session: "s-1",
            event: "e-1",
            index: 0,
            digest: "b",
            reference_digest: "a",
            against: "reference",
        };
        expect(one("P03", made({ pairing: [turn("host", "a"), diverged] }))).toMatchObject({
            status: "unreached",
        });
        expect(one("P03", made({ pairing: [diverged, turn("eidnara", "b")] }))).toMatchObject({
            status: "unreached",
        });
    });

    test("SIM-P10 recomputes the rates from the turn labels and holds the journaled summary to them", () => {
        // 40 turns over 10 sessions: 18 pushbacks, 2 interrupts, 1 redirect, 1 abandon sit in band.
        const turns = (extra: string) =>
            Array.from({ length: 40 }, (_, i) => ({
                kind: "UserTurn",
                scenario_ms: i,
                event: `e-${i}`,
                session: `s-${i % 10}`,
                label:
                    i < 18
                        ? "pushback"
                        : i < 20
                          ? "interrupt"
                          : i === 20
                            ? "redirect"
                            : i === 21
                              ? "abandon"
                              : extra,
                delivered: true,
            }));
        const summary = {
            turns: 40,
            sessions: 10,
            rates: {
                pushback_per_turn: 0.45,
                interrupt_per_turn: 0.05,
                redirect_per_session: 0.1,
                abandon_per_session: 0.1,
            },
        };
        const rates = (outside: string[], extra: object = summary) => ({
            kind: "UserSimRates",
            scenario_ms: 99,
            outside,
            ...extra,
        });
        const inBand = { journal: [...turns("task"), rates([])] };
        expect(one("P10", made(inBand))).toMatchObject({ status: "witnessed" });
        const nagging = { journal: [...turns("pushback"), rates([])] };
        expect(one("P10", made(nagging))).toMatchObject({ status: "violated" });
        const disagree = { journal: [...turns("task"), rates(["pushback_per_turn"])] };
        expect(one("P10", made(disagree))).toMatchObject({ status: "violated" });
        const capped = made({ capped: true, journal: [...turns("task"), rates([])] });
        expect(one("P10", capped)).toMatchObject({ status: "unreached" });
        const stopped = made({ journal: turns("pushback") });
        expect(one("P10", stopped)).toMatchObject({ status: "unreached" });
        const miscounted = { journal: [...turns("task"), rates([], { ...summary, turns: 39 })] };
        expect(one("P10", made(miscounted))).toMatchObject({
            status: "violated",
            detail: expect.stringContaining("journaled summary"),
        });
        const mixed = propertyWitness("| SIM-P10 | [x](#x) | safety |", [capped, made(nagging)]);
        expect(mixed[0]).toMatchObject({ status: "violated" });
    });

    test("SIM-L03 holds a run's wall span from StartRun to EndRun to the tier's budget", () => {
        const budget = prereg.liveness_bounds.tier_wall_budget_ms;
        const span = (end: number) => [
            { kind: "StartRun", scenario_ms: 0, wall_ms: 1_000 },
            { kind: "EndRun", scenario_ms: 0, wall_ms: 1_000 + end },
        ];
        expect(one("L03", made({ journal: span(budget) }))).toMatchObject({ status: "witnessed" });
        expect(one("L03", made({ journal: span(budget + 1) }))).toMatchObject({
            status: "violated",
        });
        expect(one("L03", made({ journal: span(1).slice(0, 1) }))).toMatchObject({
            status: "unreached",
        });
        const odd = (end: unknown) => [
            { kind: "StartRun", scenario_ms: 0, wall_ms: 1_000 },
            { kind: "EndRun", scenario_ms: 0, wall_ms: end },
        ];
        expect(one("L03", made({ journal: odd("later") }))).toMatchObject({ status: "violated" });
        expect(one("L03", made({ journal: odd(500) }))).toMatchObject({ status: "violated" });
    });

    test("SIM-P30 checks every injected call against a fault fired before it", () => {
        const fired = { kind: "FaultFired", scenario_ms: 5, wall_ms: 50, fault: "f-1" };
        const call = (fault_ref: string, started_wall_ms: number) => ({
            seq: 1,
            arm: "eidnara",
            fault_ref,
            started_wall_ms,
            wall_ms: started_wall_ms + 1,
            scenario_ms: 5,
        });
        const faults = [
            {
                id: "f-1",
                type: "proxy_timeout",
                strategy: "persistent",
                params: {},
                trigger: { kind: "user_turn", session: "s-1", n: 1 },
            },
        ];
        expect(
            one("P30", made({ faults, journal: [fired], calls: [call("f-1", 60)] })),
        ).toMatchObject({ status: "witnessed" });
        expect(
            one("P30", made({ faults, journal: [fired], calls: [call("f-1", 40)] })),
        ).toMatchObject({ status: "violated" });
        expect(one("P30", made({ faults, journal: [], calls: [call("f-9", 60)] }))).toMatchObject({
            status: "violated",
        });
        const observed = { kind: "FaultObserved", scenario_ms: 5, wall_ms: 50, fault: "f-1" };
        expect(one("P30", made({ faults, journal: [observed] }))).toMatchObject({
            status: "unreached",
        });
        expect(
            one("P30", made({ faults, journal: [{ ...observed, fault: "f-9" }] })),
        ).toMatchObject({ status: "violated" });
        const overridden = made({
            faults: [],
            fault_override: faults,
            journal: [fired],
            calls: [call("f-1", 60)],
        });
        expect(one("P30", overridden)).toMatchObject({ status: "witnessed" });
    });

    test("SIM-P30 holds each injected call inside its fault's window: the trigger session, and the count of a bounded fault", () => {
        const faults = [
            {
                id: "f-1",
                type: "proxy_timeout",
                strategy: "burst",
                params: { count: 2 },
                trigger: { kind: "user_turn", session: "s-1", n: 1 },
            },
        ];
        const events = [{ id: "e-end", kind: "session_end", session: "s-1" }];
        const journal = [
            { kind: "FaultFired", scenario_ms: 5, wall_ms: 50, fault: "f-1" },
            { kind: "Event", scenario_ms: 9, wall_ms: 100, event: "e-end" },
        ];
        const call = (seq: number, started_wall_ms: number) => ({
            seq,
            component: "agent",
            fault_ref: "f-1",
            started_wall_ms,
            wall_ms: started_wall_ms + 1,
            scenario_ms: 5,
        });
        const run = (calls: object[]) => made({ faults, events, journal, calls });
        expect(one("P30", run([call(1, 60), call(2, 70)]))).toMatchObject({ status: "witnessed" });
        expect(one("P30", run([call(1, 60), call(2, 120)]))).toMatchObject({
            status: "violated",
            detail: expect.stringContaining("after its session ended"),
        });
        expect(one("P30", run([call(1, 60), call(2, 70), call(3, 80)]))).toMatchObject({
            status: "violated",
            detail: expect.stringContaining("beyond its count"),
        });
        // An intermittent fault spends its count on every eligible agent call, injected or not.
        const intermittent = [{ ...(faults[0] as object), strategy: "intermittent" }];
        const plain = (seq: number, started_wall_ms: number) => ({
            seq,
            component: "agent",
            fault_ref: null,
            started_wall_ms,
            wall_ms: started_wall_ms + 1,
            scenario_ms: 5,
        });
        expect(
            one(
                "P30",
                made({
                    faults: intermittent,
                    events,
                    journal,
                    calls: [plain(1, 60), plain(2, 65), call(3, 70)],
                }),
            ),
        ).toMatchObject({
            status: "violated",
            detail: expect.stringContaining("beyond its count"),
        });
    });

    test("SIM-P41 treats a grade without a journaled snapshot as a violation", () => {
        const probe = {
            kind: "EndTurn",
            scenario_ms: 0,
            event: "e-1",
            outcome: "ok",
            probe: "q-1",
        };
        const snap = { kind: "SnapshotArtefacts", scenario_ms: 1, item: "q-1", snapshot: "s1" };
        const grade = (item: string) => ({ item, arm: "eidnara", version: 1, snapshot: "s1" });
        expect(one("P41", made({ journal: [probe, snap], grades: [grade("q-1")] })).status).toBe(
            "witnessed",
        );
        expect(
            one("P41", made({ journal: [probe, snap], grades: [grade("q-1"), grade("q-2")] })),
        ).toMatchObject({ status: "violated", detail: expect.stringContaining("q-2") });
        const stale = { ...grade("q-1"), snapshot: "s0" };
        const regraded = { ...grade("q-1"), version: 2 };
        expect(
            one(
                "P41",
                made({ journal: [probe, snap], grades: [stale, regraded], used: [regraded] }),
            ),
        ).toMatchObject({ status: "violated", detail: expect.stringContaining("v1") });
    });

    test("SIM-P11 reads the journal in seq order and refuses a repeated seq", () => {
        const entry = (seq: number, scenario_ms: number) => ({
            kind: "Event",
            seq,
            scenario_ms,
            event: `e-${seq}`,
        });
        expect(one("P11", made({ journal: [entry(1, 0), entry(0, 10)] }))).toMatchObject({
            status: "violated",
        });
        expect(one("P11", made({ journal: [entry(0, 0), entry(0, 10)] }))).toMatchObject({
            status: "violated",
            detail: expect.stringContaining("seq 0 twice"),
        });
        expect(one("P11", made({ journal: [entry(0, 0), entry(1, 10)] }))).toMatchObject({
            status: "witnessed",
        });
    });

    test("SIM-P41 wants a snapshot right after the first EndTurn of every reached probe", () => {
        const end = (probe: string, event: string) => ({
            kind: "EndTurn",
            scenario_ms: 1,
            event,
            outcome: "ok",
            probe,
            state: "completed",
        });
        const snap = (item: string) => ({
            kind: "SnapshotArtefacts",
            scenario_ms: 1,
            item,
            snapshot: `s-${item}`,
        });
        const grade = (item: string) => ({
            item,
            arm: "eidnara",
            version: 1,
            snapshot: `s-${item}`,
        });
        const status = (journal: object[], grades: object[] = [grade("q-1")]) =>
            one("P41", made({ journal, grades })).status;
        expect(status([end("q-1", "e-1"), snap("q-1")])).toBe("witnessed");
        expect(status([end("q-1", "e-1"), snap("q-1"), end("q-2", "e-2")])).toBe("violated");
        expect(status([end("q-1", "e-1"), end("q-2", "e-2"), snap("q-1"), snap("q-2")])).toBe(
            "violated",
        );
        expect(status([snap("q-1"), end("q-1", "e-1")])).toBe("violated");
        expect(status([end("q-1", "e-1"), snap("q-1"), snap("q-9")], [grade("q-1")])).toBe(
            "violated",
        );
    });

    test("SIM-P42 requires the report to grade at the latest version and names the versions it used", () => {
        const grade = (version: number) => ({
            item: "q-1",
            arm: "eidnara",
            version,
            snapshot: "s1",
        });
        const grades = [grade(1), grade(2)];
        expect(one("P42", made({ grades, used: [grade(2)] }))).toMatchObject({
            status: "witnessed",
            detail: expect.stringContaining("v2"),
        });
        expect(one("P42", made({ grades, used: [grade(1)] })).status).toBe("violated");
        const unversioned = { ...grade(1), version: "bad" };
        expect(one("P42", made({ grades: [unversioned], used: [] }))).toMatchObject({
            status: "violated",
            detail: expect.stringContaining("version"),
        });
        // Two memory arms judge the same P7 item against the host, each judgment writing its own
        // host row; the report's host row follows the judgment it reports, by its inputs.
        const p7 = (arm: string, version: number, inputs: string[]) => ({
            item: "q-7",
            arm,
            probe_type: "P7",
            version,
            snapshot: `s-${arm}`,
            inputs,
        });
        const log = [
            p7("eidnara", 1, ["a", "h"]),
            p7("host", 1, ["a", "h"]),
            p7("eidnara-kl", 1, ["k", "h"]),
            p7("host", 2, ["k", "h"]),
        ];
        expect(
            one(
                "P42",
                made({
                    grades: log,
                    used: [p7("eidnara", 1, ["a", "h"]), p7("host", 1, ["a", "h"])],
                }),
            ),
        ).toMatchObject({ status: "witnessed" });
    });

    test("SIM-P15 holds each call's scenario time to the clock the journal implies at its start", () => {
        // Busy from wall 1000 (scenario 100) to wall 1500 (scenario 600); idle after.
        const journal = [
            { kind: "BeginTurn", seq: 0, scenario_ms: 100, wall_ms: 1_000, event: "e-1" },
            {
                kind: "EndTurn",
                seq: 1,
                scenario_ms: 600,
                wall_ms: 1_500,
                event: "e-1",
                outcome: "ok",
            },
        ];
        const call = (scenario_ms: number, started_wall_ms: number) => ({
            seq: 1,
            scenario_ms,
            started_wall_ms,
            wall_ms: started_wall_ms + 10,
            fault_ref: null,
        });
        expect(one("P15", made({ journal, calls: [call(300, 1_200)] }))).toMatchObject({
            status: "witnessed",
        });
        expect(one("P15", made({ journal, calls: [call(600, 1_700)] }))).toMatchObject({
            status: "witnessed",
        });
        expect(one("P15", made({ journal, calls: [call(99_000, 1_200)] }))).toMatchObject({
            status: "violated",
            detail: expect.stringContaining("clock"),
        });
        // A turn a kill cut is closed on resume by its interrupted ItemState, so the clock holds.
        const interrupted = [
            { kind: "BeginTurn", seq: 0, scenario_ms: 100, wall_ms: 1_000, event: "e-1" },
            {
                kind: "ItemState",
                seq: 1,
                scenario_ms: 100,
                wall_ms: 9_000,
                event: "e-1",
                state: "failed(interrupted)",
            },
        ];
        expect(
            one("P15", made({ journal: interrupted, calls: [call(100, 20_000)] })),
        ).toMatchObject({
            status: "witnessed",
        });
        expect(one("P15", made({ journal, calls: [call(100, 10)] }))).toMatchObject({
            status: "violated",
            detail: expect.stringContaining("before the journal"),
        });
        expect(
            one("P15", made({ journal, calls: [{ ...call(100, 1_200), started_wall_ms: "x" }] })),
        ).toMatchObject({
            status: "violated",
        });
    });

    test("liveness records appear in the panel, unchecked", () => {
        const catalog = "| SIM-P02 | [x](#x) | safety |\n| SIM-L01 | [x](#x) | liveness |";
        expect(propertyWitness(catalog, [made({})]).map((w) => [w.id, w.status])).toEqual([
            ["SIM-P02", "unreached"],
            ["SIM-L01", "unchecked"],
        ]);
    });
});
