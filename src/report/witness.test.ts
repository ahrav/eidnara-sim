import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArmLogs } from "../oracle/logs";
import type { Entry } from "../run/journal";
import type { Scenario } from "../scenario/compile";
import { loadPrereg } from "../scenario/inputs";
import type { GradedRun } from "./observe";
import { propertyWitness } from "./witness";

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
        digest: "a",
        reference_digest: "b",
        against: "reference",
    };
    const pairing = broken
        ? [
              turn("host", "e-1", "t"),
              turn("eidnara", "e-1", "u"),
              { ...turn("eidnara", "e-2", "v"), index: 1 },
              diverged,
          ]
        : [
              turn("host", "e-1", "t"),
              turn("eidnara", "e-1", "t"),
              diverged,
              { ...turn("eidnara", "e-2", "v"), index: 1 },
          ];
    writeFileSync(join(dir, "pairing.jsonl"), lines(pairing));
    let seq = 0;
    const entry = (kind: string, scenario_ms: number, extra: object = {}) =>
        ({ kind, arm: "eidnara", scenario_ms, seq: seq++, wall_ms: 0, ...extra }) as Entry;
    const journal = [
        entry("UserTurn", 10, { event: "e-1", label: broken ? "nagging" : "task" }),
        entry("SnapshotArtefacts", 20, { item: "q-1" }),
        entry(broken ? "SnapshotArtefacts" : "Event", broken ? 5 : 30, { item: "q-1" }),
    ];
    writeFileSync(join(dir, "journal.jsonl"), lines(journal));
    const arm: ArmLogs = {
        arm: "eidnara",
        calls: [],
        journal,
        pluginLog: [],
        daemonLog: [],
        resources: [],
        tools: [],
    };
    const scenario = { events: [], faults: [], probes: [] } as unknown as Scenario;
    return {
        run: { dir, tier: "S", base_wall_ms: 0, prereg, kinds: new Map(), arms: [arm] },
        scenario,
        grades: [],
    };
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
        expect(Object.values(sound)).toEqual(
            ids.map((n) => (n === "P03" ? "unreached" : "witnessed")),
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
    const jump = at("AdvanceClock", broken ? 150 : 100, { from_ms: 20 });
    const delivered = at("Event", 20, { event: "e-1" });
    const held = [at("RegisterJob", 20, { job: "j" }), jump, at("EndJob", 100, { job: "j" })];
    const journal = [
        begin,
        ...(broken
            ? [jump, end, delivered]
            : busy
              ? [end, delivered, ...held]
              : [end, jump, delivered]),
        at("FaultObserved", 100, { fault: broken ? "f-9" : "f-1" }),
        at("SnapshotArtefacts", 100, { item: "q-1", snapshot: "eidnara:q-1:e-1" }),
    ];
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
    const call = (s: number, wall_ms: number) => ({ seq: s, scenario_ms: 10, wall_ms });
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
