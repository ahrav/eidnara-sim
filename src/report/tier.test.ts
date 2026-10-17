import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GradeRecord } from "../grade/probes";
import type { ArmLogs } from "../oracle/logs";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import { preregistrationHash } from "../prereg/validate";
import type { CallRecord } from "../proxy/records";
import type { Entry } from "../run/journal";
import type { Scenario } from "../scenario/compile";
import type { FaultEpisode } from "../scenario/faults";
import { loadPrereg } from "../scenario/inputs";
import { falsificationPairs } from "./falsify";
import { percentile } from "./intrusive";
import { type GradedRun, tierInput } from "./observe";
import { renderTier } from "./render";
import { aaScale, counterfactual, cusumScale, loadGraded, tierReport } from "./tier";

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
}

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
        manifest: { seed: opts.seed ?? 101 },
        probes,
        faults: [],
        events: [],
    } as unknown as Scenario;
    return {
        run: { dir, tier: "S", base_wall_ms: 0, prereg, kinds, arms },
        scenario,
        grades,
        host: opts.host ?? "pi",
    };
}

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
        const resized = tierReport(prereg, all, boundary, undefined, "", 40).verdict;
        expect(resized.pass.incomplete).toContain("probe-P1: 0 of 40 paired items");
        expect(resized.prereg_sha256).toBe(preregistrationHash(prereg));
    });

    test("a tier whose CUSUM scale comes from another tier's A/A pairs takes that scale", () => {
        const L = loadPrereg("L");
        const g = fixture();
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
        expect(complete.filter((x) => x.includes("EndArm"))).toEqual([]);
        const host = arm(g, "host");
        host.journal = host.journal.filter((e) => e.kind !== "EndArm");
        expect(tierInput(prereg, [g]).incomplete).toContain("run pi/101: host without EndArm");
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
        expect(renderTier(report)).toMatch(/\| judge \| judge \| 1 \| 1000000 \|/);
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
            manifest: { seed: 101 },
            faults: [],
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

    test("probes in a session where a fault fired in one arm alone leave the attribution and placebo counts", () => {
        const observed = { kind: "FaultObserved", fault: "fault-000", type: "daemon_restart" };
        const lonely = {
            ...g,
            host: "pi",
            run: {
                ...g.run,
                arms: [arm("eidnara", [observed]), g.run.arms[1]],
            },
            scenario: {
                ...g.scenario,
                faults: [{ id: "fault-000", trigger: { kind: "session_start", session: "s-9" } }],
                probes: ["q-1", "q-2", "q-3", "q-4", "q-5", "q-6"].map((id) => ({
                    id,
                    type: "P1",
                    session: id === "q-1" || id === "q-5" ? "s-9" : "s-1",
                })),
            },
        } as unknown as GradedRun;
        expect(counterfactual([lonely])).toMatchObject({
            attempted: 4,
            verified: 2,
            memory_passes: 1,
            flips: 0,
            placebo: { memory_passes: 1, flips: 0 },
        });
    });

    test("runs that hold the counterfactual arm without the memory arm give no panel", () => {
        const alone = { ...g, run: { ...g.run, arms: [g.run.arms[1]] } } as unknown as GradedRun;
        expect(counterfactual([alone])).toBeNull();
    });
});

describe("CUSUM scale", () => {
    test("L's rules take M's A/A scale from the invocation, else the scale recorded beside the runs", () => {
        const L = loadPrereg("L");
        const recorded = { harm: 0.5, futility: 0.25 };
        expect(cusumScale(L, new Map(), recorded)).toEqual(recorded);
        expect(cusumScale(L, new Map([["M", { harm: 0.7 }]]), recorded)).toEqual({
            harm: 0.7,
            futility: 0.25,
        });
        expect(cusumScale(L, new Map())).toEqual({ harm: undefined, futility: undefined });
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
        const body = { manifest: { seed: 101, tier: "S" }, events: [], faults: [fault("s-9")] };
        const scenario_hash = sha256Hex(canonicalJson(body));
        const manifest = {
            tier: "S",
            host: "pi",
            order: [],
            base_wall_ms: 0,
            prereg_sha256: preregistrationHash(prereg),
            scenario_hash,
            fault_override: [fault("s-1")],
        };
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        writeFileSync(join(dir, "scenario.json"), canonicalJson({ ...body, scenario_hash }));
        expect(loadGraded(dir, prereg).scenario.faults).toEqual([fault("s-1")]);
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({ ...manifest, fault_override: null }),
        );
        expect(loadGraded(dir, prereg).scenario.faults).toEqual([fault("s-9")]);
    });
});
