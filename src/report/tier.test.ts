import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GradeRecord } from "../grade/probes";
import type { ArmLogs } from "../oracle/logs";
import type { CallRecord } from "../proxy/records";
import type { Entry } from "../run/journal";
import type { Scenario } from "../scenario/compile";
import type { FaultEpisode } from "../scenario/faults";
import { loadPrereg } from "../scenario/inputs";
import type { GradedRun } from "./observe";
import { renderTier } from "./render";
import { counterfactual, loadGraded, tierReport } from "./tier";

const prereg = loadPrereg("S");
const boundary = readFileSync(join(import.meta.dir, "../../docs/claim-boundary.md"), "utf8");
const SESSIONS = 12;

function armLogs(
    name: string,
    jitter: (i: number) => number,
    status = (_: number) => 200,
): ArmLogs {
    let seq = 0;
    const journal: Entry[] = [];
    const calls: CallRecord[] = [];
    let wall = 1_000;
    for (let s = 0; s < SESSIONS; s++) {
        const at = s * 10_000;
        const push = (kind: string, extra: Record<string, unknown>) => {
            journal.push({
                kind,
                arm: name,
                scenario_ms: at,
                seq: seq++,
                wall_ms: wall,
                ...extra,
            } as Entry);
        };
        wall += 20 + jitter(s);
        push("AdvanceClock", { next_event: `e-${s}`, from_ms: at - 1 });
        push("BeginTurn", { event: `e-${s}` });
        wall += 5_000 + jitter(s) * 10;
        push("EndTurn", { event: `e-${s}`, outcome: "ok" });
        push("Event", { event: `end-${s}` });
        calls.push({
            seq: s,
            arm: name,
            session: `s-${s}`,
            turn: `e-${s}`,
            component: "agent",
            status: status(s),
            input_tokens: 1000,
            output_tokens: 100,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            scenario_ms: at,
            started_wall_ms: wall - 4_000,
            wall_ms: wall,
            response_text: "done",
        } as CallRecord);
    }
    return { arm: name, calls, journal, pluginLog: [], daemonLog: [], resources: [], tools: [] };
}

function fixture(status = (_: number) => 200): GradedRun {
    const dir = mkdtempSync(join(tmpdir(), "sim-report-"));
    const eidnara = armLogs("eidnara", (i) => i % 2);
    eidnara.resources = Array.from({ length: SESSIONS * 4 }, (_, i) => ({
        scenario_ms: i * 2_500,
        wall_ms: i * 10_000,
        rss: 200 * 2 ** 20 + (i % 3) * 2 ** 20,
        heap: 50 * 2 ** 20,
        store_bytes: 300 * 2 ** 20 + i * 1024,
    }));
    const arms = [
        armLogs("host", (i) => (i % 3) - 1),
        armLogs("host~aa", (i) => ((i + 1) % 3) - 1, status),
        eidnara,
    ];
    mkdirSync(join(dir, "eidnara"));
    writeFileSync(
        join(dir, "eidnara", "memory.json"),
        JSON.stringify([
            { id: 1, content: "a", status: "active", deliveries: 1, first_delivery_ms: 1 },
            { id: 2, content: "b", status: "active", deliveries: 0, first_delivery_ms: null },
        ]),
    );
    writeFileSync(
        join(dir, "aa.json"),
        JSON.stringify([{ arm: "host", control: "host~aa", disagreement_rate: 0 }]),
    );
    const pairing = arms.flatMap((a) =>
        Array.from({ length: SESSIONS }, (_, s) =>
            [0, 1, 2].map((index) => ({
                kind: "turn",
                arm: a.arm,
                session: `s-${s}`,
                event: `t-${s}-${index}`,
                index,
                label: index === 1 && s % 2 === 0 ? "pushback" : "task",
                delivered: true,
                digest: "d",
                prefix_sha256: "p",
                text_sha256: "t",
                source: "script",
            })),
        ).flat(),
    );
    writeFileSync(
        join(dir, "pairing.jsonl"),
        pairing.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    const probes = Array.from({ length: 12 }, (_, i) => ({
        id: `q-${i}`,
        type: "P1-control",
        fact: `f-${i % 4}`,
        project: "p",
        session: `s-${i}`,
        text: "x",
        check: {},
        event: `e-${i}`,
    }));
    const grades: GradeRecord[] = arms.flatMap((a, k) =>
        probes.map((p, i) => ({
            item: p.id,
            arm: a.arm,
            probe_type: "P1-control",
            version: 1,
            snapshot: `${a.arm}:${p.id}`,
            inputs: [],
            later_attempts_logged: 0,
            verdict: (i + k) % 4 === 0 ? "fail" : "pass",
            metrics: { "P1-control.pass": (i + k) % 4 !== 0 },
        })),
    );
    const grade = (arm: string, item: string, type: string, metrics: Record<string, boolean>) => ({
        item,
        arm,
        probe_type: type,
        version: 1,
        snapshot: `${arm}:${item}`,
        inputs: [],
        later_attempts_logged: 0,
        verdict: Object.values(metrics)[0] ? ("pass" as const) : ("fail" as const),
        metrics,
    });
    for (let i = 0; i < 8; i++) {
        for (const [k, arm] of ["host", "host~aa"].entries()) {
            grades.push(grade(arm, `q-p1-${i}`, "P1", { "P1.pass": (i + k) % 3 === 0 }));
            grades.push(
                grade(arm, `q-h-${i}`, "P2", { "P2.pass": true, "P2.harm": (i + k) % 4 === 0 }),
            );
        }
    }
    for (let i = 0; i < 10; i++) {
        grades.push(grade("host", `q-p8-${i}`, "P8", { "P8.pass": false }));
        grades.push(grade("eidnara", `q-p8-${i}`, "P8", { "P8.pass": i !== 0 }));
    }
    const kinds = new Map(Array.from({ length: SESSIONS }, (_, s) => [`end-${s}`, "session_end"]));
    const scenario = {
        manifest: { seed: 101 },
        probes,
        faults: [],
        events: [],
    } as unknown as Scenario;
    return { run: { dir, tier: "S", base_wall_ms: 0, prereg, kinds, arms }, scenario, grades };
}

describe("tier report", () => {
    test("an A/A fixture renders every panel with the pre-registration, and its falsification set shows zero effect", () => {
        const g = fixture();
        const report = tierReport(prereg, [g], boundary);
        expect(report.falsification.map((z) => [z.check, z.zero_effect])).toEqual([
            ["in_session_repo_readable_fact_pass", true],
            ["gateway_4xx_rate_without_faults", true],
            ["pre_divergence_pushback_rate", true],
            ["wall_ms_per_scripted_idle_gap", true],
        ]);
        const text = renderTier(report);
        for (const heading of [
            "## Accuracy by probe type",
            "## Gate verdict",
            "### Harm",
            "## Failure-class oracles",
            "## Recovery after infrastructure faults",
            "## Soak",
            "## Intrusiveness",
            "## Cost",
            "## Harness falsification set",
            "## A/A controls",
            "## Claim boundary",
            "## Pre-registration",
        ]) {
            expect([heading, text.includes(heading)]).toEqual([heading, true]);
        }
        expect(text).toContain(JSON.stringify(prereg, null, 2));
        expect(text).toMatch(/\| eidnara \| rss \| no leak \|/);
        expect(text).toMatch(/\| eidnara \| \d+ \| [\d.-]+ \| 2 \| 1 \|/);
        expect(text).toContain('"disagreement_rate": 0');
        const resources = report.verdict.families.find((f) => f.family === "resources");
        expect(resources?.metrics.map((m) => [m.metric, m.n, m.verdict])).toEqual([
            ["daemon_rss_growth_bytes_per_session", 1, "within-bound"],
            ["daemon_heap_growth_bytes_per_session", 1, "within-bound"],
            ["store_growth_bytes_per_session", 1, "within-bound"],
        ]);
        expect(text).toMatch(
            /\| resources \| gate \| store_growth_bytes_per_session \| 1 \| observed [\d.]+ \|/,
        );
        expect(text).toContain("sim-claim-boundary/v1");
        expect(text).toMatch(/Uncovered: F1, F2, F3(, F\d)+\./);
        expect(text.toLowerCase()).not.toContain("parity");
        expect(report.verdict.cusum_unavailable).toEqual([]);
        expect(report.observed["P8.cross_session_pass_rate"]).toEqual([0.9]);
        expect(text).toMatch(
            /\| probe-P8 \| gate \| P8.cross_session_pass_rate \| 10 \| observed 0.90 \|.*within-bound \| pass \|/,
        );
    });

    test("a planted 4xx difference between the A/A arms fails that falsification check", () => {
        const report = tierReport(prereg, [fixture((s) => (s % 2 ? 429 : 200))], boundary);
        const fourxx = report.falsification.find(
            (z) => z.check === "gateway_4xx_rate_without_faults",
        );
        expect([fourxx?.zero_effect, fourxx?.difference]).toEqual([false, 0.5]);
    });
});

describe("counterfactual attribution", () => {
    const arm = (name: string, journal: object[] = []) =>
        ({ arm: name, journal, calls: [], resources: [], tools: [] }) as unknown as ArmLogs;
    const grade = (a: string, item: string, verdict: string) =>
        ({ arm: a, item, verdict }) as unknown as GradeRecord;
    const deletion = (probe: string, extra: object) => ({
        kind: "CounterfactualDeletion",
        probe,
        ...extra,
    });
    const g = {
        run: {
            dir: "/r",
            arms: [
                arm("eidnara"),
                arm("eidnara-cf", [
                    deletion("q-1", { deleted: [4], remaining: 0 }),
                    deletion("q-2", { deleted: [], remaining: 0 }),
                    deletion("q-3", { skipped: "no store yet" }),
                    deletion("q-4", { deleted: [5], remaining: 0 }),
                ]),
            ],
        },
        scenario: {
            cf_deletions: ["q-1", "q-2", "q-3", "q-4"].map((probe) => ({ probe })),
            probes: ["q-1", "q-2", "q-3", "q-4", "q-5", "q-6"].map((id) => ({ id, type: "P1" })),
        },
        grades: [
            ...["q-1", "q-2", "q-3", "q-4", "q-5", "q-6"].map((i) => grade("eidnara", i, "pass")),
            grade("eidnara-cf", "q-1", "fail"),
            grade("eidnara-cf", "q-2", "fail"),
            grade("eidnara-cf", "q-3", "fail"),
            grade("eidnara-cf", "q-4", "pass"),
            grade("eidnara-cf", "q-5", "fail"),
            grade("eidnara-cf", "q-6", "pass"),
        ],
    } as unknown as GradedRun;

    test("only verified deletions count, beside the placebo flip rate on unsampled items", () => {
        expect(counterfactual([g])).toMatchObject({
            attempted: 4,
            verified: 2,
            memory_passes: 2,
            flips: 1,
            attribution_rate: 0.5,
            placebo: { memory_passes: 2, flips: 1, rate: 0.5 },
        });
    });

    test("a deletion verified in one run leaves the same probe unverified in another", () => {
        const failed = deletion("q-1", { skipped: "deletion failed" });
        const other = {
            ...g,
            run: { ...g.run, dir: "/r2", arms: [arm("eidnara"), arm("eidnara-cf", [failed])] },
        } as unknown as GradedRun;
        expect(counterfactual([g, other])).toMatchObject({
            attempted: 5,
            verified: 2,
            memory_passes: 2,
            flips: 1,
        });
    });

    test("runs that hold the counterfactual arm without the memory arm give no panel", () => {
        const alone = { ...g, run: { ...g.run, arms: [g.run.arms[1]] } } as unknown as GradedRun;
        expect(counterfactual([alone])).toBeNull();
    });
});

describe("graded run loading", () => {
    test("a run's fault schedule is the manifest's override when it has one", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-graded-"));
        const fault = (session: string) =>
            ({
                id: "fault-000",
                type: "daemon_restart",
                trigger: { kind: "session_start", session },
            }) as unknown as FaultEpisode;
        const manifest = { tier: "S", order: [], base_wall_ms: 0, fault_override: [fault("s-1")] };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        writeFileSync(
            join(dir, "scenario.json"),
            JSON.stringify({
                manifest: { seed: 101, tier: "S" },
                events: [],
                faults: [fault("s-9")],
            }),
        );
        expect(loadGraded(dir, prereg).scenario.faults).toEqual([fault("s-1")]);
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({ ...manifest, fault_override: null }),
        );
        expect(loadGraded(dir, prereg).scenario.faults).toEqual([fault("s-9")]);
    });
});
