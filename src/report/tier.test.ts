import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GradeRecord } from "../grade/probes";
import type { ArmLogs } from "../oracle/logs";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import type { Preregistration } from "../prereg/schema";
import { preregistrationHash } from "../prereg/validate";
import type { CallRecord } from "../proxy/records";
import type { Entry } from "../run/journal";
import { PRICE_TABLE } from "../run/price";
import type { Scenario } from "../scenario/compile";
import { loadPrereg } from "../scenario/inputs";
import { falsificationPairs } from "./falsify";
import { percentile } from "./intrusive";
import { type GradedRun, tierInput } from "./observe";
import { renderTier } from "./render";
import * as tier from "./tier";
import { aaScale, loadGraded, tierReport } from "./tier";

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
        push("EndTurn", { event: `e-${s}`, outcome: "ok", prompt_ms: 5_000 + jitter(s) * 10 });
        push("UserTurn", { event: `e-${s}`, delivered: true });
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
    journal.push({
        kind: "EndArm",
        arm: name,
        scenario_ms: SESSIONS * 10_000,
        seq: seq++,
        wall_ms: wall,
    } as Entry);
    return { arm: name, calls, journal, pluginLog: [], daemonLog: [], resources: [], tools: [] };
}

interface FixtureOptions {
    host?: "pi" | "opencode";
    seed?: number;
    hostJitter?: (i: number) => number;
    commit?: string;
}
const identity = (commit = "abc") => ({
    eidnara_commit: commit,
    models: ["m"],
    context_limit: 1,
    events: 36,
    distortions: [] as string[],
    host_versions: ["pi@1", "opencode@1"],
    scenario_provenance: "gen1/1/abc",
    fault_override: null as string | null,
    tapes: [] as string[],
});

function fixture(status = (_: number) => 200, opts: FixtureOptions = {}): GradedRun {
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
        armLogs("host", opts.hostJitter ?? ((i) => (i % 3) - 1)),
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
    writeFileSync(
        join(dir, "grade-summary.json"),
        JSON.stringify({ judge_errors: 0, journal_seq: 0 }),
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
    const extra = [...new Set(grades.map((r) => r.item))]
        .filter((item) => !probes.some((p) => p.id === item))
        .map((id) => ({
            id,
            type: grades.find((r) => r.item === id)?.probe_type ?? "P1",
            fact: `f-${id}`,
            project: "p",
            session: `s-${id}`,
            text: "x",
            check: {},
            event: `e-${id}`,
        }));
    probes.push(...extra);
    const scenario = {
        manifest: { seed: opts.seed ?? 101 },
        probes,
        faults: [],
        events: [],
    } as unknown as Scenario;
    return {
        run: {
            dir,
            tier: "S",
            base_wall_ms: 0,
            prereg,
            kinds,
            arms,
            price: PRICE_TABLE,
            journal_seq: 0,
        } as GradedRun["run"],
        scenario,
        grades,
        host: opts.host ?? "pi",
        judged: [],
        witnesses: [] as GradedRun["witnesses"],
        pairing: [] as GradedRun["pairing"],
        captured: true,
        tape: true,
        tooled: new Set(["host", "host~aa", "eidnara"]),
        identity: identity(opts.commit),
    };
}

const judgment = (
    item: string,
    arm: string,
    pass: boolean,
    inputs: string[],
    eligible = true,
): GradeRecord => ({
    item,
    arm,
    probe_type: "P7",
    version: 1,
    snapshot: `${arm}:${item}`,
    inputs,
    later_attempts_logged: 0,
    verdict: pass ? "pass" : "fail",
    metrics: { "P7.pass": pass, gate_eligible: eligible },
});

declare const cusumScaleShape: (
    p: Preregistration,
    scales: Map<string, { scale: Record<string, number | undefined>; complete: boolean }>,
) => Record<string, number | undefined>;

const loadPairing = (g: GradedRun): GradedRun => ({
    ...g,
    pairing: readFileSync(join(g.run.dir, "pairing.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as NonNullable<GradedRun["pairing"]>[number]),
});

const probe = (g: GradedRun, id: string, type = "P13") =>
    g.scenario.probes.push({
        id,
        type,
        fact: `f-${id}`,
        project: "p",
        session: `s-${id}`,
        text: "x",
        check: {},
        event: `e-${id}`,
    } as unknown as Scenario["probes"][number]);

const arm = (g: GradedRun, name: string) => g.run.arms.find((a) => a.arm === name) as ArmLogs;
const observation = (g: GradedRun[], metric: string) =>
    tierInput(prereg, g).observations.find((o) => o.metric === metric);
function asymmetricFixture(record: (host: ArmLogs) => void): GradedRun {
    const g = fixture();
    g.scenario.probes.push({
        id: "q-p8-0",
        type: "P8",
        fact: "f-8",
        project: "p",
        session: "s-0",
        text: "x",
        check: {},
        event: "e-0",
    } as unknown as Scenario["probes"][number]);
    g.scenario.faults.push({
        id: "f1",
        type: "provider_500",
        strategy: "single",
        trigger: { kind: "user_turn", session: "s-0", n: 1 },
        params: {},
        seam: { layer: "proxy-sink", legal_outcomes: [] },
    } as unknown as Scenario["faults"][number]);
    record(arm(g, "host"));
    return g;
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

    test("loadGraded refuses a run recorded under another pre-registration or scenario", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-report-"));
        const body = { manifest: { seed: 101 }, events: [], probes: [], faults: [] };
        const scenario_hash = sha256Hex(canonicalJson(body));
        const manifest = {
            tier: "S",
            seed: 101,
            host: "pi",
            order: [],
            base_wall_ms: 0,
            prereg_sha256: "0".repeat(64),
            scenario_hash,
        };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        writeFileSync(join(dir, "scenario.json"), canonicalJson({ ...body, scenario_hash }));
        expect(() => loadGraded(dir, prereg)).toThrow(/pre-registration/);
        manifest.prereg_sha256 = preregistrationHash(prereg);
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        expect(loadGraded(dir, prereg).host).toBe("pi");
        writeFileSync(
            join(dir, "scenario.json"),
            canonicalJson({ ...body, probes: [{ id: "q" }], scenario_hash }),
        );
        expect(() => loadGraded(dir, prereg)).toThrow(/scenario/);
    });

    test("the verdict records each run's journal boundary", () => {
        const g = fixture();
        const last = Math.max(...g.run.arms.flatMap((a) => a.journal.map((e) => e.seq)));
        expect(tierReport(prereg, [g], boundary).verdict.journal_seq_at_eval).toEqual({
            "S-pi-101": last,
        });
    });

    test("the paired-item order is the same whatever order the runs arrive in", () => {
        const a = fixture(undefined, { host: "pi" });
        const b = fixture(undefined, { host: "opencode" });
        const order = (runs: GradedRun[]) =>
            observation(runs, "P8.cross_session_pass_rate")?.items?.map((x) => x.item);
        expect(order([b, a])).toEqual(order([a, b]));
    });

    test("the A/A scale pools every control pair, whatever their order", () => {
        const g = fixture();
        const control = armLogs("eidnara~aa", (i) => i % 2);
        g.run.arms.push(control);
        for (let i = 0; i < 8; i++) {
            for (const [k, name] of ["eidnara", "eidnara~aa"].entries()) {
                g.grades.push({
                    ...(g.grades.find(
                        (r) => r.item === "q-p1-0" && r.arm === "host",
                    ) as GradeRecord),
                    arm: name,
                    item: `q-p1-${i}`,
                    metrics: { "P1.pass": (i * (k + 1)) % 5 === 0 },
                });
            }
        }
        const pooled = aaScale(prereg, [g]);
        g.run.arms.unshift(g.run.arms.pop() as ArmLogs);
        expect(pooled?.futility).toBeGreaterThan(0);
        expect(aaScale(prereg, [g])).toEqual(pooled);
    });

    test("P13 and P14 leave fault-asymmetric items out before reducing to the run", () => {
        const g = asymmetricFixture((host) => {
            (host.calls[0] as CallRecord).fault_ref = "f1";
        });
        probe(g, "q-13-x");
        for (const name of ["host", "eidnara"]) {
            for (const [item, score] of [
                ["q-0", 0],
                ["q-13-x", 1],
            ] as const) {
                g.grades.push({
                    ...(g.grades.find((r) => r.item === "q-0" && r.arm === name) as GradeRecord),
                    item,
                    probe_type: "P13",
                    metrics: { "P13.fold_fidelity_score": score },
                });
            }
        }
        expect(observation([g], "P13.fold_fidelity_score")?.runs).toEqual([
            { run: "S-pi-101", control: 100, treatment: 100 },
        ]);
    });

    test("the same seed on two hosts keeps every paired item, exclusion, and run apart", () => {
        const pi = fixture(undefined, { host: "pi" });
        const opencode = fixture(undefined, { host: "opencode" });
        opencode.grades.push({
            ...(opencode.grades.find(
                (r) => r.item === "q-p8-1" && r.arm === "host",
            ) as GradeRecord),
            item: "q-p8-x",
            verdict: "excluded",
            reason: "failed turn",
        });
        const input = tierInput(prereg, [pi, opencode]);
        const items = input.observations.find((o) => o.metric === "P8.cross_session_pass_rate")
            ?.items as { item: string }[];
        expect([items.length, new Set(items.map((x) => x.item)).size]).toEqual([20, 20]);
        expect(input.excluded.map((e) => e.id)).toEqual(["opencode/101/q-p8-x"]);
        const runs = input.observations.find((o) => o.metric === "failed_turns")?.runs ?? [];
        expect(new Set(runs.map((r) => r.run)).size).toBe(2);
    });

    test("a revert both arms made is held against memory as the difference from the host", () => {
        const g = fixture();
        for (const name of ["host", "eidnara"])
            arm(g, name).tools.push({ command: "git reset --hard", turn: "e-1" } as never);
        const report = tierReport(prereg, [g], boundary);
        const metric = report.verdict.families
            .find((f) => f.family === "intrusiveness")
            ?.metrics.find((m) => m.metric === "reverted_memory_edits");
        expect([metric?.verdict, metric?.passed]).toEqual(["within-bound", true]);
        expect(report.observed.reverted_memory_edits).toEqual([0]);
    });

    test("the rendered observed rate comes from the pairs the verdict kept", () => {
        const g = asymmetricFixture((host) =>
            host.journal.push({
                kind: "FaultObserved",
                arm: "host",
                fault: "f1",
                type: "provider_500",
                evidence: {},
                scenario_ms: 0,
                seq: 9_000,
                wall_ms: 0,
            } as Entry),
        );
        const report = tierReport(prereg, [g], boundary);
        expect(report.verdict.asymmetric_stratum).toEqual(["pi/101/q-0", "pi/101/q-p8-0"]);
        expect(report.observed["P8.cross_session_pass_rate"]).toEqual([1]);
    });

    test("a proxy fault that landed in one arm's calls alone puts its session's probes in the asymmetric stratum", () => {
        const g = asymmetricFixture((host) => {
            (host.calls[0] as CallRecord).fault_ref = "f1";
        });
        expect(tierInput(prereg, [g]).asymmetric).toEqual(["pi/101/q-0", "pi/101/q-p8-0"]);
    });

    test("a subset of the pre-registered campaign cannot pass the tier", () => {
        const one = tierReport(prereg, [fixture()], boundary).verdict.pass;
        expect(one.passed).toBe(false);
        expect(one.incomplete).toEqual(
            expect.arrayContaining(["missing run opencode/101", "missing run pi/102"]),
        );
        const all = (
            [
                ["pi", 101],
                ["pi", 102],
                ["opencode", 101],
                ["opencode", 102],
            ] as const
        ).map(([host, seed]) => fixture(undefined, { host, seed }));
        const full = tierReport(prereg, all, boundary).verdict.pass.incomplete;
        expect(full.filter((x) => x.startsWith("missing run"))).toEqual([]);
        expect(full).toContain("probe-P1: 0 of 24 paired items");
        expect(full).toContain("probe-P13: 0 of 24 paired items");
        expect(full).toContain("probe-P14: 0 of 24 paired items");
        expect(full.find((x) => x.startsWith("probe-P8"))).toBeUndefined();
    });

    test("a tier whose CUSUM scale comes from another tier's A/A pairs takes that scale", () => {
        const L = loadPrereg("L");
        const g = fixture(undefined, { seed: 301 });
        g.run.arms = g.run.arms.filter((a) => a.arm !== "host~aa");
        g.grades = g.grades.filter((r) => r.arm !== "host~aa");
        expect(tierReport(L, [g], boundary).verdict.cusum_unavailable).toHaveLength(2);
        const scaled = tierReport(L, [g], boundary, { harm: 0.5, futility: 0.5 });
        expect(scaled.verdict.cusum_unavailable).toEqual([]);
    });

    test("a turn interrupted by a kill counts as a failed turn", () => {
        const g = fixture();
        const push = (extra: Record<string, unknown>) =>
            arm(g, "eidnara").journal.push({
                arm: "eidnara",
                scenario_ms: 0,
                seq: 9_000,
                wall_ms: 0,
                ...extra,
            } as Entry);
        push({ kind: "BeginTurn", event: "e-cut" });
        push({ kind: "ItemState", event: "e-cut", state: "failed(interrupted)" });
        push({ kind: "Event", event: "e-cut", outcome: "failed(interrupted)" });
        expect(observation([g], "failed_turns")?.runs?.map((r) => r.treatment)).toEqual([1]);
    });

    test("a host arm without turn latencies leaves the latency gate inconclusive", () => {
        const g = fixture();
        const host = arm(g, "host");
        host.journal = host.journal.filter((e) => e.kind !== "BeginTurn" && e.kind !== "EndTurn");
        expect(observation([g], "turn_latency_p95_delta_ms")?.runs).toEqual([]);
        expect(observation([g], "daemon_rss_growth_bytes_per_session")?.runs).toHaveLength(1);
    });

    test("each run's latency delta is against its own host arm", () => {
        const a = fixture();
        const b = fixture(undefined, { seed: 102, hostJitter: (i) => (i % 3) - 1 + 100 });
        const text = renderTier(tierReport(prereg, [a, b], boundary));
        const p50 = (g: GradedRun, name: string) =>
            percentile(
                arm(g, name)
                    .journal.filter((e) => e.kind === "EndTurn")
                    .map((e) => e.prompt_ms as number),
                0.5,
            ) as number;
        const delta = Math.round(p50(b, "eidnara") - p50(b, "host"));
        expect(delta).toBeLessThan(0);
        expect(text).toMatch(
            new RegExp(`\\| eidnara \\| 0 \\| 0 \\| 0 \\| \\d+ \\| \\d+ \\| ${delta} \\|`),
        );
    });

    test("the idle-gap check measures from the preceding scripted event's completion", () => {
        const g = fixture();
        const journal = arm(g, "eidnara").journal;
        const at = journal.findIndex((e, i) => i > 0 && e.kind === "AdvanceClock");
        for (const e of journal.slice(at)) e.wall_ms += 10_000;
        const jump = journal[at] as Entry;
        journal.splice(at, 0, {
            kind: "EndJob",
            arm: "eidnara",
            job: "j",
            scenario_ms: jump.scenario_ms,
            seq: jump.seq,
            wall_ms: jump.wall_ms - 1,
        } as Entry);
        const gaps = falsificationPairs(g, "host", "eidnara").wall_ms_per_scripted_idle_gap;
        expect(gaps.filter((p) => p.treatment > 10_000)).toHaveLength(1);
    });

    test("P13 and P14 reduce over the items both arms kept", () => {
        const g = fixture();
        const grade = (a: string, item: string, score: number, verdict = "pass") =>
            g.grades.push({
                item,
                arm: a,
                probe_type: "P13",
                version: 1,
                snapshot: `${a}:${item}`,
                inputs: [],
                later_attempts_logged: 0,
                verdict,
                metrics: { "P13.fold_fidelity_score": score },
            } as GradeRecord);
        probe(g, "q-13-a");
        probe(g, "q-13-b");
        grade("host", "q-13-a", 0.5);
        grade("host", "q-13-b", 1);
        grade("eidnara", "q-13-a", 0.5);
        grade("eidnara", "q-13-b", 1, "excluded");
        expect(observation([g], "P13.fold_fidelity_score")?.runs).toEqual([
            { run: "S-pi-101", control: 50, treatment: 50 },
        ]);
    });

    test("a run whose analysed arm has no EndArm leaves the campaign incomplete", () => {
        const g = fixture();
        const complete = tierInput(prereg, [g]).incomplete ?? [];
        expect(complete.filter((x) => x.includes("EndArm"))).toEqual([
            "run pi/101: eidnara-kl without EndArm",
        ]);
        const host = arm(g, "host");
        host.journal = host.journal.filter((e) => e.kind !== "EndArm");
        expect(tierInput(prereg, [g]).incomplete).toContain(
            "run pi/101: host, eidnara-kl without EndArm",
        );
    });

    test("the fixed-N count is the population the verdict analyses", () => {
        const g = asymmetricFixture((host) => {
            (host.calls[0] as CallRecord).fault_ref = "f1";
        });
        expect(tierInput(prereg, [g]).incomplete).toContain("probe-P8: 9 of 24 paired items");
    });

    test("the A/A scale leaves fault-asymmetric control items out", () => {
        const clean = aaScale(prereg, [fixture()]);
        const g = fixture();
        g.scenario.probes.push({
            id: "q-p1-0",
            type: "P1",
            fact: "f-p1",
            project: "p",
            session: "s-0",
            text: "x",
            check: {},
            event: "e-0",
        } as unknown as Scenario["probes"][number]);
        g.scenario.faults.push({
            id: "f1",
            type: "provider_500",
            strategy: "single",
            trigger: { kind: "user_turn", session: "s-0", n: 1 },
            params: {},
            seam: { layer: "proxy-sink", legal_outcomes: [] },
        } as unknown as Scenario["faults"][number]);
        (arm(g, "host~aa").calls[0] as CallRecord).fault_ref = "f1";
        const without = fixture();
        without.grades = without.grades.filter((r) => r.item !== "q-p1-0");
        const scaled = aaScale(prereg, [g]);
        expect(scaled?.futility).not.toEqual(clean?.futility);
        expect(scaled).toEqual(aaScale(prereg, [without]));
    });

    test("two runs with one host and seed are refused", () => {
        expect(() => tierInput(prereg, [fixture(), fixture()])).toThrow(/pi\/101/);
    });

    test("each run's own A/A control feeds the falsification set", () => {
        const a = fixture();
        const b = fixture(undefined, { seed: 102 });
        const control = arm(b, "host~aa");
        control.arm = "eidnara~aa";
        for (const r of b.grades) if (r.arm === "host~aa") r.arm = "eidnara~aa";
        const report = tierReport(prereg, [a, b], boundary);
        const facts = report.falsification.find(
            (z) => z.check === "in_session_repo_readable_fact_pass",
        );
        expect(facts?.n).toBe(24);
    });

    test("the report prices the grader's judge calls once per run", () => {
        const g = fixture();
        writeFileSync(
            join(g.run.dir, "judge-calls.jsonl"),
            `${JSON.stringify({
                component: "judge",
                input_tokens: 1_000_000,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
            })}\n`,
        );
        const report = tierReport(prereg, [g], boundary);
        expect(report.judge.map((j) => [j.run, j.cost?.usd])).toEqual([[g.run.dir, 5]]);
        expect(renderTier(report)).toContain(`| ${g.run.dir} | judge | 1 | 1000000 |`);
    });

    test("the report script refuses --out without a destination", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-report-"));
        writeFileSync(join(dir, "manifest.json"), JSON.stringify({ tier: "S" }));
        const r = Bun.spawnSync(["bun", "scripts/report.ts", dir, "--out"], {
            cwd: join(import.meta.dir, "../.."),
            stderr: "pipe",
            stdout: "pipe",
        });
        expect([r.exitCode, r.stderr.toString().includes("usage:")]).toEqual([2, true]);
    });

    test("a P7 judgment outside the gate's eligibility leaves its pair out", () => {
        const g = fixture();
        probe(g, "q-7", "P7");
        g.judged.push(judgment("q-7", "host", false, ["h", "e"], false));
        g.judged.push(judgment("q-7", "eidnara", true, ["h", "e"], false));
        expect(observation([g], "P7.pass")?.items).toEqual([]);
        for (const r of g.judged) r.metrics.gate_eligible = true;
        expect(observation([g], "P7.pass")?.items).toHaveLength(1);
    });

    test("a P7 pair takes the host grade from the same judgment", () => {
        const g = fixture();
        probe(g, "q-7", "P7");
        g.judged.push(judgment("q-7", "host", true, ["e", "h"]));
        g.judged.push(judgment("q-7", "eidnara", true, ["e", "h"]));
        g.judged.push(judgment("q-7", "host", false, ["h", "kl"]));
        g.judged.push(judgment("q-7", "eidnara-kl", true, ["h", "kl"]));
        expect(observation([g], "P7.pass")?.items?.map((x) => [x.control, x.treatment])).toEqual([
            [1, 1],
        ]);
    });

    test("a run without a gate metric's value keeps the campaign incomplete", () => {
        const g = fixture();
        const host = arm(g, "host");
        host.journal = host.journal.filter((e) => e.kind !== "EndTurn");
        expect(tierInput(prereg, [g]).incomplete).toContain(
            "turn_latency_p95_delta_ms: run S-pi-101 unavailable",
        );
    });

    test("loadGraded applies the manifest's fault override", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-report-"));
        const body = { manifest: { seed: 101 }, events: [], probes: [], faults: [] };
        const scenario_hash = sha256Hex(canonicalJson(body));
        const fault = {
            id: "f-x",
            trigger: { session: "s-0" },
        } as unknown as Scenario["faults"][number];
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({
                tier: "S",
                seed: 101,
                host: "pi",
                order: [],
                base_wall_ms: 0,
                prereg_sha256: preregistrationHash(prereg),
                scenario_hash,
                fault_override: [fault],
            }),
        );
        writeFileSync(join(dir, "scenario.json"), canonicalJson({ ...body, scenario_hash }));
        writeFileSync(
            join(dir, "faults.jsonl"),
            `${JSON.stringify([{ fault: "f-x", status: "untriggered" }])}\n`,
        );
        const loaded = loadGraded(dir, prereg);
        expect(loaded.scenario.faults).toEqual([fault]);
        expect(loaded.witnesses?.map((w) => [w.fault, w.status])).toEqual([["f-x", "untriggered"]]);
    });

    test("runs of one tier with different live settings keep the campaign incomplete", () => {
        const a = fixture(undefined, { host: "pi" });
        const b = fixture(undefined, { host: "opencode", commit: "def" });
        expect(tierInput(prereg, [a, b]).incomplete).toContain(
            "runs differ in eidnara_commit: abc, def",
        );
    });

    test("soak rows name their run", () => {
        const g = fixture();
        const report = tierReport(prereg, [g], boundary);
        expect(new Set(report.soak.map((s) => s.run))).toEqual(new Set([g.run.dir]));
        expect(renderTier(report)).toContain(`| ${g.run.dir} | eidnara | rss | no leak |`);
    });

    test("a run that stopped before the scenario's last event keeps the campaign incomplete", () => {
        const g = fixture();
        g.scenario.events = Array.from({ length: 36 }, (_, i) => ({ id: `e-${i}` })) as never;
        expect(tierInput(prereg, [g]).incomplete?.filter((x) => x.includes("events"))).toEqual([]);
        g.identity.events = 30;
        expect(tierInput(prereg, [g]).incomplete).toContain("run pi/101: 30 of 36 events");
    });

    test("the registered A/A pairs and repeats are part of completeness", () => {
        const g = fixture();
        expect(tierInput(prereg, [g]).incomplete).toContain("A/A eidnara: 0 of 1 control runs");
        expect(
            tierInput(prereg, [g]).incomplete?.find((x) => x.startsWith("A/A host")),
        ).toBeUndefined();
    });

    test("judge cost rows name their run", () => {
        const g = fixture();
        writeFileSync(
            join(g.run.dir, "judge-calls.jsonl"),
            `${JSON.stringify({
                component: "judge",
                input_tokens: 1_000_000,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
            })}\n`,
        );
        expect(renderTier(tierReport(prereg, [g], boundary))).toContain(
            `| ${g.run.dir} | judge | 1 | 1000000 |`,
        );
    });

    test("a run outside the pre-registered hosts and seeds is refused", () => {
        expect(() => tierInput(prereg, [fixture(undefined, { seed: 999 })])).toThrow(/pi\/999/);
    });

    test("every pre-registered arm needs its EndArm for the campaign to be complete", () => {
        const g = fixture();
        expect(tierInput(prereg, [g]).incomplete).toContain(
            "run pi/101: eidnara-kl without EndArm",
        );
        g.run.arms.push(armLogs("eidnara-kl", () => 0));
        expect(tierInput(prereg, [g]).incomplete?.filter((x) => x.includes("EndArm"))).toEqual([]);
    });

    test("cost and intrusiveness rows name their run", () => {
        const g = fixture();
        const report = tierReport(prereg, [g], boundary);
        expect(new Set(report.cost.map((c) => c.run))).toEqual(new Set([g.run.dir]));
        const text = renderTier(report);
        expect(text).toContain(`| ${g.run.dir} | eidnara | v1 | agent | 12 |`);
        expect(text).toContain(`| ${g.run.dir} | eidnara | 0 | 0 | 0 |`);
    });

    test("the pushback check stops at the first divergence in either arm", () => {
        const g = fixture();
        const path = join(g.run.dir, "pairing.jsonl");
        const rows = readFileSync(path, "utf8")
            .split("\n")
            .filter(Boolean)
            .map(
                (l) =>
                    JSON.parse(l) as { arm: string; session: string; index: number; label: string },
            );
        for (const r of rows)
            if (r.arm === "host~aa" && r.session === "s-0" && r.index === 2) r.label = "pushback";
        const cut = { kind: "divergedAt", arm: "host", session: "s-0", index: 1 };
        writeFileSync(path, `${[...rows, cut].map((r) => JSON.stringify(r)).join("\n")}\n`);
        const rates = falsificationPairs(g, "host", "host~aa").pre_divergence_pushback_rate;
        expect(rates).toHaveLength(SESSIONS);
        expect(rates.filter((r) => r.control !== r.treatment)).toEqual([]);
    });

    test("seeds with scenarios of different lengths share one campaign", () => {
        const a = fixture(undefined, { seed: 101 });
        const b = fixture(undefined, { seed: 102 });
        b.identity.events = 40;
        b.scenario.events = Array.from({ length: 40 }, (_, i) => ({ id: `e-${i}` })) as never;
        a.scenario.events = Array.from({ length: 36 }, (_, i) => ({ id: `e-${i}` })) as never;
        const open = tierInput(prereg, [a, b]).incomplete ?? [];
        expect(open.filter((x) => x.includes("events"))).toEqual([]);
    });

    test("an A/A control counts toward the registered repeats once it has its EndArm", () => {
        const g = fixture();
        const control = arm(g, "host~aa");
        control.journal = control.journal.filter((e) => e.kind !== "EndArm");
        expect(tierInput(prereg, [g]).incomplete).toContain("A/A host: 0 of 1 control runs");
    });

    test("a run whose scheduled fault never fired leaves the fault metrics", () => {
        const g = fixture();
        g.witnesses?.push({
            fault: "f-miss",
            type: "provider_5xx",
            armed: true,
            injected_seq: [],
            host_observed_seq: [],
            proxy_retried: false,
            status: "untriggered",
        });
        const report = tierReport(prereg, [g], boundary);
        expect(report.missed_faults).toEqual([{ run: g.run.dir, faults: ["f-miss"] }]);
        expect(renderTier(report)).toContain(`${g.run.dir}: f-miss`);
    });

    test("the cost TOTAL row conserves calls and tokens over every component", () => {
        const g = fixture();
        arm(g, "eidnara").calls.push({
            ...(arm(g, "eidnara").calls[0] as CallRecord),
            component: "user-sim",
            input_tokens: 7,
            output_tokens: 3,
        });
        const text = renderTier(tierReport(prereg, [g], boundary));
        expect(text).toContain(
            `| ${g.run.dir} | eidnara | v1 | TOTAL | 13 | 12007 | 1203 | 0 | 0 |`,
        );
    });

    test("more A/A controls than registered repeats keep the campaign incomplete", () => {
        const g = fixture();
        g.run.arms.push(armLogs("host~bb", () => 0));
        expect(tierInput(prereg, [g]).incomplete).toContain("A/A host: 2 of 1 control runs");
    });

    test("fault witnesses merge across resumed attempts, a fired fault staying fired", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-report-"));
        const body = { manifest: { seed: 101 }, events: [], probes: [], faults: [] };
        const scenario_hash = sha256Hex(canonicalJson(body));
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({
                tier: "S",
                seed: 101,
                host: "pi",
                order: [],
                base_wall_ms: 0,
                prereg_sha256: preregistrationHash(prereg),
                scenario_hash,
                preflight: { distortions: ["x reads wall-clock time"] },
            }),
        );
        writeFileSync(join(dir, "scenario.json"), canonicalJson({ ...body, scenario_hash }));
        const line = (status: string) => JSON.stringify([{ fault: "f-1", status }]);
        writeFileSync(join(dir, "faults.jsonl"), `${line("fired")}\n${line("untriggered")}\n`);
        const loaded = loadGraded(dir, prereg);
        expect(loaded.witnesses?.map((w) => [w.fault, w.status])).toEqual([["f-1", "fired"]]);
        expect(loaded.identity.distortions).toEqual(["x reads wall-clock time"]);
    });

    test("each run's clock distortions are rendered and must agree across the campaign", () => {
        const a = fixture(undefined, { host: "pi" });
        const b = fixture(undefined, { host: "opencode" });
        b.identity.distortions = ["opencode reads wall-clock time"];
        const report = tierReport(prereg, [a, b], boundary);
        expect(report.verdict.pass.incomplete).toContain(
            "runs differ in distortions: , opencode reads wall-clock time",
        );
        expect(renderTier(report)).toContain(`${b.run.dir}: opencode reads wall-clock time`);
    });

    test("runs made with different host releases keep the campaign incomplete", () => {
        const a = fixture(undefined, { host: "pi" });
        const b = fixture(undefined, { host: "opencode" });
        b.identity.host_versions = ["pi@2", "opencode@1"];
        expect(tierInput(prereg, [a, b]).incomplete).toContain(
            "runs differ in host_versions: pi@1,opencode@1, pi@2,opencode@1",
        );
    });

    test("the A/A scale takes only controls that reached EndArm", () => {
        const g = fixture();
        const complete = aaScale(prereg, [g]);
        const extra = armLogs("host~bb", (i) => i * 3);
        extra.journal = extra.journal.filter((e) => e.kind !== "EndArm");
        g.run.arms.push(extra);
        for (let i = 0; i < 8; i++) {
            g.grades.push({
                ...(g.grades.find(
                    (r) => r.item === `q-p1-${i}` && r.arm === "host~aa",
                ) as GradeRecord),
                arm: "host~bb",
                metrics: { "P1.pass": i % 7 === 0 },
            });
        }
        expect(aaScale(prereg, [g])).toEqual(complete);
    });

    test("a run with scheduled proxy faults and no witness file is incomplete", () => {
        const g = fixture();
        g.scenario.faults.push({
            id: "f1",
            type: "provider_5xx",
            strategy: "single",
            trigger: { kind: "user_turn", session: "s-0", n: 1 },
            params: {},
            seam: { layer: "proxy-sink", legal_outcomes: [] },
        } as unknown as Scenario["faults"][number]);
        g.witnesses = null;
        expect(tierInput(prereg, [g]).incomplete).toContain("run pi/101: fault witnesses missing");
    });

    test("the host's P7 row comes from its judgment against the default arm", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-report-"));
        const body = { manifest: { seed: 101 }, events: [], probes: [], faults: [] };
        const scenario_hash = sha256Hex(canonicalJson(body));
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({
                tier: "S",
                seed: 101,
                host: "pi",
                order: [],
                base_wall_ms: 0,
                prereg_sha256: preregistrationHash(prereg),
                scenario_hash,
            }),
        );
        writeFileSync(join(dir, "scenario.json"), canonicalJson({ ...body, scenario_hash }));
        const rows = [
            judgment("q-7", "host", true, ["e", "h"]),
            judgment("q-7", "eidnara", true, ["e", "h"]),
            { ...judgment("q-7", "host", false, ["h", "kl"]), version: 2 },
            judgment("q-7", "eidnara-kl", true, ["h", "kl"]),
        ];
        writeFileSync(
            join(dir, "grades.jsonl"),
            `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
        );
        const loaded = loadGraded(dir, prereg);
        expect(loaded.grades.filter((r) => r.arm === "host").map((r) => r.verdict)).toEqual([
            "pass",
        ]);
        expect(loaded.judged).toHaveLength(4);
    });

    test("a P7 exclusion counts only against its own judgment", () => {
        const g = fixture();
        probe(g, "q-7", "P7");
        g.judged.push(judgment("q-7", "host", true, ["e", "h"]));
        g.judged.push(judgment("q-7", "eidnara", true, ["e", "h"]));
        g.judged.push({ ...judgment("q-7", "host", false, ["h", "kl"]), verdict: "excluded" });
        g.judged.push({
            ...judgment("q-7", "eidnara-kl", false, ["h", "kl"]),
            verdict: "excluded",
        });
        g.grades.push({ ...judgment("q-7", "host", false, ["h", "kl"]), verdict: "excluded" });
        const input = tierInput(prereg, [g]);
        expect(input.excluded.filter((e) => e.id.endsWith("/q-7"))).toEqual([]);
        expect(input.observations.find((o) => o.metric === "P7.pass")?.items).toHaveLength(1);
    });

    test("a source tier lends its CUSUM scale only when its own campaign is complete", () => {
        const L = loadPrereg("L");
        const g = fixture();
        const scale = { harm: 0.5, futility: 0.5 };
        const cusumScale =
            (tier as { cusumScale?: typeof cusumScaleShape }).cusumScale ?? (() => undefined);
        expect(cusumScale(L, new Map([["M", { scale, complete: false }]]))).toEqual({});
        expect(cusumScale(L, new Map([["M", { scale, complete: true }]]))).toEqual(scale);
        expect(cusumScale(prereg, new Map([["S", { scale, complete: true }]]))).toEqual(scale);
        expect(g.host).toBe("pi");
    });

    test("A/A reports name their run", () => {
        const g = fixture();
        const report = tierReport(prereg, [g], boundary);
        expect(report.aa).toEqual([
            { run: g.run.dir, stale: false, arm: "host", control: "host~aa", disagreement_rate: 0 },
        ]);
    });

    test("grades for items outside the scenario's probes pair nothing and are named", () => {
        const g = fixture();
        for (const name of ["host", "eidnara"]) {
            g.grades.push({
                ...(g.grades.find((r) => r.item === "q-p8-1" && r.arm === name) as GradeRecord),
                item: "q-zzz",
            });
        }
        const input = tierInput(prereg, [g]);
        expect(
            input.observations.find((o) => o.metric === "P8.cross_session_pass_rate")?.items,
        ).toHaveLength(10);
        expect(input.incomplete).toContain("run pi/101: grades for unknown items q-zzz");
    });

    test("a daemon arm without memory.json has no corrections count", () => {
        const g = fixture();
        rmSync(join(g.run.dir, "eidnara", "memory.json"));
        expect(observation([g], "user_corrections_referencing_injected_text")?.runs).toEqual([]);
    });

    test("the falsification set is the same whatever order the runs arrive in", () => {
        const a = fixture(undefined, { host: "pi" });
        const b = fixture(undefined, { host: "opencode", hostJitter: (i) => (i * 37) % 23 });
        const set = (runs: GradedRun[]) =>
            tierReport(prereg, runs, boundary).falsification.map((z) => [z.check, z.interval]);
        expect(set([b, a])).toEqual(set([a, b]));
    });

    test("a P7 pair needs both sides of one judgment attempt", () => {
        const g = fixture();
        probe(g, "q-7", "P7");
        g.judged.push(judgment("q-7", "host", true, ["e", "h"]));
        g.judged.push({
            ...judgment("q-7", "eidnara", true, ["e", "h"]),
            version: 2,
            metrics: { "P7.pass": true, gate_eligible: true, verdict_a_then_b: "b" },
        });
        expect(observation([g], "P7.pass")?.items).toEqual([]);
    });

    test("pairing failures and user-sim rates outside their band keep the campaign incomplete", () => {
        const g = fixture();
        const path = join(g.run.dir, "pairing.jsonl");
        const rows = readFileSync(path, "utf8")
            .split("\n")
            .filter(Boolean)
            .map(
                (l) =>
                    JSON.parse(l) as {
                        arm: string;
                        session: string;
                        index: number;
                        text_sha256: string;
                    },
            );
        for (const r of rows)
            if (r.arm === "eidnara" && r.session === "s-0" && r.index === 1)
                r.text_sha256 = "other";
        writeFileSync(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
        arm(g, "eidnara").journal.push({
            kind: "UserSimRates",
            arm: "eidnara",
            outside: ["pushback_per_turn"],
            scenario_ms: 0,
            seq: 9_500,
            wall_ms: 0,
        } as Entry);
        const open = tierInput(prereg, [loadPairing(g)]).incomplete ?? [];
        expect(open).toContain("run pi/101: mismatches before divergence: eidnara s-0 #1");
        expect(open).toContain(
            "run pi/101: eidnara user-sim rates outside band: pushback_per_turn",
        );
    });

    test("an at-most count gate shows the rate-ratio bound it decides on", () => {
        const report = tierReport(prereg, [fixture()], boundary);
        const metric = report.verdict.families
            .find((f) => f.family === "probe-P14")
            ?.metrics.find((m) => m.metric === "P14.post_compaction_correction_count");
        if (metric) {
            metric.interval = null;
            metric.rate_ratio_upper = 1.25;
        }
        expect(renderTier(report)).toMatch(
            /\| P14\.post_compaction_correction_count \| \d+ \| [\d.-]+ \| ratio ≤ 1\.25 \|/,
        );
    });

    test("a run without pairing records or call capture leaves the affected evidence out", () => {
        const g = fixture();
        g.pairing = null;
        g.captured = false;
        const input = tierInput(prereg, [g]);
        expect(input.incomplete).toContain("run pi/101: pairing records missing");
        expect(input.observations.find((o) => o.metric === "internal_string_hits")?.runs).toEqual(
            [],
        );
    });

    test("runs compiled by different generators or corpora keep the campaign incomplete", () => {
        const a = fixture(undefined, { host: "pi" });
        const b = fixture(undefined, { host: "opencode" });
        b.identity.scenario_provenance = "gen2/1/abc";
        expect(
            tierInput(prereg, [a, b]).incomplete?.find((x) =>
                x.startsWith("runs differ in scenario_provenance"),
            ),
        ).toBeDefined();
    });

    test("an L run whose arms ran one after another lacks the registered load profile", () => {
        const L = loadPrereg("L");
        const g = fixture(undefined, { seed: 301 });
        for (const a of g.run.arms) {
            a.journal.unshift({
                kind: "StartArm",
                arm: a.arm,
                scenario_ms: 0,
                seq: 0,
                wall_ms: 0,
            } as Entry);
        }
        let seq = 0;
        for (const a of g.run.arms) for (const e of a.journal) e.seq = seq++;
        expect(tierInput(L, [g]).incomplete).toContain(
            "run pi/301: arms ran one at a time; load_stress requires concurrent arms",
        );
        const [host, aa] = g.run.arms as [ArmLogs, ArmLogs];
        (host.journal[0] as Entry).seq = 0;
        (aa.journal[0] as Entry).seq = 1;
        expect(tierInput(L, [g]).incomplete?.filter((x) => x.includes("load_stress"))).toEqual([]);
        expect(
            tierInput(prereg, [fixture()]).incomplete?.filter((x) => x.includes("load_stress")),
        ).toEqual([]);
    });

    test("every item-unit family metric counts toward the fixed-N completeness", () => {
        const open = tierInput(prereg, [fixture()]).incomplete ?? [];
        expect(open).toContain("harm/P2.harm: 0 of 24 paired items");
    });

    test("an empty or cut faults.jsonl is a missing witness file", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-report-"));
        const body = { manifest: { seed: 101 }, events: [], probes: [], faults: [] };
        const scenario_hash = sha256Hex(canonicalJson(body));
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({
                tier: "S",
                seed: 101,
                host: "pi",
                order: [],
                base_wall_ms: 0,
                prereg_sha256: preregistrationHash(prereg),
                scenario_hash,
            }),
        );
        writeFileSync(join(dir, "scenario.json"), canonicalJson({ ...body, scenario_hash }));
        writeFileSync(join(dir, "faults.jsonl"), '[{"fault":"f-1","status":"fir');
        expect(loadGraded(dir, prereg).witnesses).toBeNull();
    });

    test("a failed turn counts once when a resume repeats its outcome as an Event", () => {
        const g = fixture();
        const push = (extra: Record<string, unknown>) =>
            arm(g, "eidnara").journal.push({
                arm: "eidnara",
                scenario_ms: 0,
                seq: 9_000,
                wall_ms: 0,
                ...extra,
            } as Entry);
        push({ kind: "BeginTurn", event: "e-bad" });
        push({ kind: "EndTurn", event: "e-bad", outcome: "failed(interrupted)" });
        push({ kind: "Event", event: "e-bad", outcome: "failed(interrupted)" });
        expect(observation([g], "failed_turns")?.runs?.map((r) => r.treatment)).toEqual([1]);
    });

    test("a run made with a fault override is outside the registered campaign", () => {
        const g = fixture();
        g.identity.fault_override = "abc";
        expect(tierInput(prereg, [g]).incomplete).toContain(
            "run pi/101: fault schedule overridden",
        );
    });

    test("an A/A report older than the grades it summarises is marked stale", () => {
        const g = fixture();
        const future = new Date(Date.now() + 60_000);
        writeFileSync(join(g.run.dir, "grades.jsonl"), "");
        utimesSync(join(g.run.dir, "grades.jsonl"), future, future);
        const report = tierReport(prereg, [g], boundary);
        expect(report.aa[0]).toMatchObject({ run: g.run.dir, stale: true });
        expect(renderTier(report)).toContain("older than grades.jsonl");
    });

    test("a binary grade metric that is not a boolean pairs nothing and is named", () => {
        const g = fixture();
        for (const r of g.grades)
            if (r.item === "q-p8-2" && r.arm === "eidnara") r.metrics["P8.pass"] = 1 as never;
        const input = tierInput(prereg, [g]);
        expect(
            input.observations.find((o) => o.metric === "P8.cross_session_pass_rate")?.items,
        ).toHaveLength(9);
        expect(input.incomplete).toContain(
            "run pi/101: P8.pass is not a boolean for eidnara q-p8-2",
        );
    });

    test("the scenario provenance includes the embedding model", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-report-"));
        const body = {
            manifest: {
                seed: 101,
                generator_version: "g",
                random_schema_version: 1,
                corpus_manifest_sha256: "c",
                embedding_model: "emb",
            },
            events: [],
            probes: [],
            faults: [],
        };
        const scenario_hash = sha256Hex(canonicalJson(body));
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({
                tier: "S",
                seed: 101,
                host: "pi",
                order: [],
                base_wall_ms: 0,
                prereg_sha256: preregistrationHash(prereg),
                scenario_hash,
            }),
        );
        writeFileSync(join(dir, "scenario.json"), canonicalJson({ ...body, scenario_hash }));
        expect(loadGraded(dir, prereg).identity.scenario_provenance).toBe("g/1/c/emb");
    });

    test("every scripted user turn needs a pairing record in each analysed arm", () => {
        const g = loadPairing(fixture());
        g.scenario.events = [
            { id: "t-0-0", kind: "user_turn" },
            { id: "t-99", kind: "user_turn" },
        ] as never;
        expect(tierInput(prereg, [g]).incomplete).toContain(
            "run pi/101: pairing records missing for host: t-99; eidnara: t-99; host~aa: t-99",
        );
    });

    test("an A/A control counts and lends its scale only with full probe coverage", () => {
        const g = fixture();
        g.grades = g.grades.filter((r) => !(r.arm === "host~aa" && r.item === "q-p1-3"));
        expect(tierInput(prereg, [g]).incomplete).toContain(
            "run pi/101: control host~aa covers 7 of 8 P1 probes",
        );
    });

    test("call capture must cover every completed turn for the F7 count to stand", () => {
        const g = fixture();
        arm(g, "eidnara").calls.splice(0, 1);
        expect(observation([g], "internal_string_hits")?.runs).toEqual([]);
    });

    test("a P7 judgment pairs only with gate_eligible recorded true", () => {
        const g = fixture();
        probe(g, "q-7", "P7");
        g.judged.push({
            ...judgment("q-7", "host", true, ["e", "h"]),
            metrics: { "P7.pass": true },
        });
        g.judged.push({
            ...judgment("q-7", "eidnara", true, ["e", "h"]),
            metrics: { "P7.pass": true },
        });
        expect(observation([g], "P7.pass")?.items).toEqual([]);
    });

    test("tape sources are part of the compared identity", () => {
        const a = fixture(undefined, { host: "pi" });
        const b = fixture(undefined, { host: "opencode" });
        b.identity.tapes = ["sha:abc"];
        expect(
            tierInput(prereg, [a, b]).incomplete?.find((x) => x.startsWith("runs differ in tapes")),
        ).toBeDefined();
    });

    test("a grade metric pairs only on an item of its own probe type", () => {
        const g = fixture();
        for (const name of ["host", "eidnara"]) {
            g.grades.push({
                ...(g.grades.find((r) => r.item === "q-p8-1" && r.arm === name) as GradeRecord),
                item: "q-h-0",
            });
        }
        const input = tierInput(prereg, [g]);
        expect(
            input.observations.find((o) => o.metric === "P8.cross_session_pass_rate")?.items,
        ).toHaveLength(10);
        expect(input.incomplete).toContain(
            "run pi/101: P8.pass recorded for host q-h-0, a P2 probe",
        );
    });

    test("P13 and P14 values outside their domain pair nothing and are named", () => {
        const g = fixture();
        probe(g, "q-13-a");
        probe(g, "q-14-a", "P14");
        const grade = (a: string, item: string, type: string, metrics: Record<string, number>) =>
            g.grades.push({
                item,
                arm: a,
                probe_type: type,
                version: 1,
                snapshot: `${a}:${item}`,
                inputs: [],
                later_attempts_logged: 0,
                verdict: "pass",
                metrics,
            });
        for (const a of ["host", "eidnara"]) {
            grade(a, "q-13-a", "P13", { "P13.fold_fidelity_score": 1.5 });
            grade(a, "q-14-a", "P14", { "P14.post_compaction_correction_count": -1 });
        }
        const input = tierInput(prereg, [g]);
        expect(
            input.observations.find((o) => o.metric === "P13.fold_fidelity_score")?.runs,
        ).toEqual([]);
        expect(
            input.observations.find((o) => o.metric === "P14.post_compaction_correction_count")
                ?.runs,
        ).toEqual([]);
        expect(input.incomplete).toContain(
            "run pi/101: P13.fold_fidelity_score out of range for host q-13-a",
        );
        expect(input.incomplete).toContain(
            "run pi/101: P14.post_compaction_correction_count out of range for host q-14-a",
        );
    });

    test("corrections and reverts are unavailable without their tape or tool capture", () => {
        const g = loadPairing(fixture());
        g.tape = false;
        g.tooled = new Set(["host", "host~aa"]);
        for (const r of g.pairing ?? [])
            if (r.kind === "turn" && r.arm === "eidnara") r.tape_key = "k";
        expect(observation([g], "user_corrections_referencing_injected_text")?.runs).toEqual([]);
        expect(observation([g], "reverted_memory_edits")?.runs).toEqual([]);
    });

    test("a host control's coverage leaves P7 out, which the judge grades for memory arms alone", () => {
        const g = fixture();
        probe(g, "q-7", "P7");
        expect(tierInput(prereg, [g]).incomplete?.filter((x) => x.includes("P7 probes"))).toEqual(
            [],
        );
    });

    test("call capture covers a turn only with a scannable agent response", () => {
        const g = fixture();
        const first = arm(g, "eidnara").calls[0] as CallRecord;
        (first as { response_text?: string }).response_text = undefined;
        expect(observation([g], "internal_string_hits")?.runs).toEqual([]);
    });

    test("a P7 item pairs the two sides of one judgment, the newest complete one", () => {
        const g = fixture();
        probe(g, "q-7", "P7");
        g.judged.push(judgment("q-7", "host", false, ["e", "h"]));
        g.judged.push(judgment("q-7", "eidnara", false, ["e", "h"]));
        g.judged.push({ ...judgment("q-7", "eidnara", true, ["e2", "h2"]), version: 2 });
        expect(observation([g], "P7.pass")?.items?.map((x) => [x.control, x.treatment])).toEqual([
            [0, 0],
        ]);
    });

    test("the report script refuses an --out inside the eidnara checkout", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-report-"));
        writeFileSync(join(dir, "manifest.json"), JSON.stringify({ tier: "S" }));
        const checkout = mkdtempSync(join(tmpdir(), "sim-checkout-"));
        const config = join(dir, "sim.config.json");
        writeFileSync(config, JSON.stringify({ eidnara_checkout: checkout }));
        const r = Bun.spawnSync(["bun", "scripts/report.ts", dir, "--out", join(checkout, "out")], {
            cwd: join(import.meta.dir, "../.."),
            env: { ...process.env, SIM_CONFIG: config },
            stderr: "pipe",
            stdout: "pipe",
        });
        expect([r.exitCode, r.stderr.toString().includes("eidnara checkout")]).toEqual([2, true]);
    });

    test("a control's coverage needs every registered metric of the probe type", () => {
        const g = fixture();
        for (const r of g.grades)
            if (r.arm === "host~aa" && r.item === "q-h-0") delete r.metrics["P2.harm"];
        expect(tierInput(prereg, [g]).incomplete).toContain(
            "run pi/101: control host~aa covers 7 of 8 P2 probes",
        );
    });

    test("A/A arms need their pairing records too", () => {
        const g = loadPairing(fixture());
        g.scenario.events = [{ id: "t-0-0", kind: "user_turn" }] as never;
        g.pairing = (g.pairing ?? []).filter(
            (r) => !(r.kind === "turn" && r.arm === "host~aa" && r.event === "t-0-0"),
        );
        expect(tierInput(prereg, [g]).incomplete).toContain(
            "run pi/101: pairing records missing for host~aa: t-0-0",
        );
    });

    test("a soak leak verdict holds the pass even when the slope is within the margin", () => {
        const g = fixture();
        const eidnara = arm(g, "eidnara");
        eidnara.resources = eidnara.resources.map((r, i) => ({
            ...r,
            rss: i === 20 ? (r.rss as number) + 400 * 2 ** 20 : r.rss,
        }));
        const report = tierReport(prereg, [g], boundary);
        const rss = report.soak.find((x) => x.arm === "eidnara" && x.resource === "rss");
        expect(rss?.verdict).toBe("leak");
        expect(report.verdict.pass.incomplete).toContain(
            "run pi/101: eidnara rss soak verdict leak",
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
