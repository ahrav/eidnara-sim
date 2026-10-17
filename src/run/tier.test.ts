import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Scenario } from "../scenario/compile";
import type { FaultEpisode } from "../scenario/faults";
import { loadPrereg } from "../scenario/inputs";
import {
    capEvents,
    compressFaults,
    planConflicts,
    restartConflicts,
    restartCut,
    restartFraction,
    runSpan,
    type TierJob,
    tierPlan,
    uncuttableRuns,
} from "./tier";

const event = (kind: string, i: number) => ({
    id: `e-${i}`,
    kind,
    scenario_ms: i,
    session: `s-${i}`,
});
const scenario = (sessions: number[]): Scenario => {
    const events: ReturnType<typeof event>[] = [];
    for (const turns of sessions) {
        events.push(event("session_start", events.length));
        for (let t = 0; t < turns; t++) events.push(event("user_turn", events.length));
        events.push(event("session_end", events.length));
    }
    return { events } as unknown as Scenario;
};

describe("tier plan", () => {
    test("the cap is the longest prefix ending on a session end whose turns fit the budget", () => {
        const s = scenario([3, 4, 10, 2]);
        expect(capEvents(s, 2, 20_000, 1_000)).toEqual({ events: 11, user_turns: 7 });
        expect(capEvents(s, 1, 20_000, 1_000)).toEqual({ events: 23, user_turns: 17 });
        expect(capEvents(s, 10, 1_000, 1_000)).toEqual({ events: 0, user_turns: 0 });
    });

    test("every host and seed gets its pre-registered order plus the A/A controls", () => {
        const prereg = loadPrereg("S");
        const scenarios = new Map(prereg.seeds.map((seed) => [seed, scenario([5, 5, 5])]));
        const plan = tierPlan(prereg, scenarios, ["pi", "opencode"], "/out", 60_000);
        expect(plan.map((j) => [j.host, j.seed, j.arms.join(","), j.dir])).toEqual([
            ["pi", 101, "host,eidnara,eidnara-kl,host~aa,eidnara~aa", "/out/S-101-pi"],
            ["pi", 102, "eidnara-kl,eidnara,host,host~aa,eidnara~aa", "/out/S-102-pi"],
            ["opencode", 101, "host,eidnara,eidnara-kl,host~aa,eidnara~aa", "/out/S-101-opencode"],
            ["opencode", 102, "eidnara-kl,eidnara,host,host~aa,eidnara~aa", "/out/S-102-opencode"],
        ]);
        expect(plan[0]?.user_turns).toBe(15);
        const xl = loadPrereg("XL");
        const one = tierPlan(xl, new Map([[401, scenario([5])]]), ["pi"], "/out", 60_000);
        expect(one[0]?.arms).toEqual(xl.arms.order_by_seed[0] ?? xl.arms.run);
    });

    test("faults past the prefix move into it, by order, onto a session that can host them, never a session start onto the first session", () => {
        const events = [
            ...["s-1", "s-2", "s-3"].flatMap((session, k) => [
                { id: `${session}-start`, kind: "session_start", session },
                ...Array.from({ length: [2, 5, 1][k] as number }, (_, t) => ({
                    id: `${session}-${t}`,
                    kind: "user_turn",
                    session,
                })),
                { id: `${session}-end`, kind: "session_end", session },
            ]),
        ];
        const fault = (id: string, kind: string, n?: number) =>
            ({
                id,
                type: "daemon_restart",
                trigger: { kind, session: "s-far", ...(n ? { n } : {}) },
            }) as unknown as FaultEpisode;
        const s = {
            events,
            sessions: [{ id: "s-3", forced_p90: true }],
            faults: [
                fault("a", "user_turn", 4),
                fault("b", "session_start"),
                fault("c", "user_turn", 9),
                fault("d", "first_summarizer_call"),
            ],
        } as unknown as Scenario;
        const moved = compressFaults(s, events.length).map((f) => f.trigger.session);
        expect(moved).toEqual(["s-2", "s-2", "s-far", "s-3"]);
        expect(compressFaults(s, 5).map((f) => f.trigger.session)).toEqual([
            "s-far",
            "s-far",
            "s-far",
            "s-1",
        ]);
    });

    test("two moved turn-triggered faults never share a session and turn", () => {
        const events = ["s-1", "s-2", "s-3"].flatMap((session, k) => [
            { id: `${session}-start`, kind: "session_start", session },
            ...Array.from({ length: [2, 5, 1][k] as number }, (_, t) => ({
                id: `${session}-${t}`,
                kind: "user_turn",
                session,
            })),
            { id: `${session}-end`, kind: "session_end", session },
        ]);
        const fault = (id: string) =>
            ({
                id,
                type: "provider_429",
                trigger: { kind: "user_turn", session: "s-far", n: 4 },
            }) as unknown as FaultEpisode;
        const s = { events, sessions: [], faults: [fault("a"), fault("b")] } as unknown as Scenario;
        expect(compressFaults(s, events.length).map((f) => f.trigger.session)).toEqual([
            "s-2",
            "s-far",
        ]);
    });

    test("a moved laptop sleep lasts the idle gap before the session it lands on", () => {
        const at = { "s-1": 0, "s-2": 50_000, "s-3": 400_000 };
        const events = Object.entries(at).flatMap(([session, start]) => [
            { id: `${session}-start`, kind: "session_start", session, scenario_ms: start },
            { id: `${session}-0`, kind: "user_turn", session, scenario_ms: start + 1_000 },
            { id: `${session}-end`, kind: "session_end", session, scenario_ms: start + 2_000 },
        ]);
        const sleep = {
            id: "sleep",
            type: "laptop_sleep",
            trigger: { kind: "session_start", session: "s-far" },
            params: { duration_ms: 9_999_999 },
        } as unknown as FaultEpisode;
        const s = { events, sessions: [], faults: [sleep] } as unknown as Scenario;
        const [moved] = compressFaults(s, events.length);
        expect(moved?.trigger.session).toBe("s-2");
        expect(moved?.params.duration_ms).toBe(50_000 - 2_000);
    });
});

test("the tier command refuses an unknown flag before it plans anything", () => {
    const out = mkdtempSync(join(tmpdir(), "sim-tier-"));
    const r = spawnSync(
        "bun",
        ["scripts/tier.ts", "--tier", "S", "--out", out, "--host", "pi", "--plan-only"],
        { encoding: "utf8" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--host");
    expect(existsSync(join(out, "tier-plan.json"))).toBe(false);
});

describe("restartFraction", () => {
    test("the flag wins; without a flag or prior plan, XL stops at 0.4 and other tiers never", () => {
        expect(restartFraction("0.7", null, "XL")).toBe(0.7);
        expect(restartFraction(undefined, null, "XL")).toBe(0.4);
        expect(restartFraction(undefined, null, "L")).toBe(0);
    });

    test("a rerun without the flag reuses the prior plan's fraction", () => {
        expect(restartFraction(undefined, { restart_at: 0 }, "XL")).toBe(0);
        expect(restartFraction(undefined, { restart_at: 0.7 }, "XL")).toBe(0.7);
        expect(restartFraction("0.2", { restart_at: 0.7 }, "XL")).toBe(0.2);
    });
});

describe("restartFraction syntax", () => {
    test("an empty or non-numeric flag is not a fraction", () => {
        expect(restartFraction("", null, "XL")).toBeNaN();
        expect(restartFraction("abc", null, "XL")).toBeNaN();
        expect(restartFraction(" ", { restart_at: 0.3 }, "XL")).toBeNaN();
        expect(restartFraction("0.25", null, "XL")).toBe(0.25);
        expect(restartFraction("0", null, "XL")).toBe(0);
    });
});

describe("restartCut", () => {
    test("the cut is the first event count at or past the fraction, and none when that is the last event", () => {
        expect(restartCut(0.4, 50, 2)).toBe(40);
        expect(restartCut(0.405, 50, 2)).toBe(41);
        expect(restartCut(0, 50, 2)).toBeNull();
        expect(restartCut(0.995, 50, 2)).toBeNull();
        expect(restartCut(0.99, 50, 2)).toBe(99);
    });
});

test("the tier command refuses an output directory another invocation holds", () => {
    const out = mkdtempSync(join(tmpdir(), "sim-tier-"));
    writeFileSync(
        join(out, "lease.json"),
        JSON.stringify({ pid: process.pid, host: hostname(), started_wall_ms: Date.now() }),
    );
    const r = spawnSync("bun", ["scripts/tier.ts", "--tier", "S", "--out", out, "--plan-only"], {
        encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("leased");
    expect(existsSync(join(out, "tier-plan.json"))).toBe(false);
});

describe("tier resume", () => {
    test("a run's span is its journaled StartRun and EndRun, so a resumed run keeps its wall budget and a completed one is left alone", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-tier-"));
        expect(runSpan(dir, 5_000)).toEqual({ started: 5_000 });
        const entry = (kind: string, wall_ms: number) =>
            JSON.stringify({ kind, arm: null, seq: 0, scenario_ms: 0, wall_ms });
        writeFileSync(join(dir, "journal.jsonl"), `${entry("StartRun", 1_000)}\n`);
        expect(runSpan(dir, 5_000)).toEqual({ started: 1_000 });
        writeFileSync(
            join(dir, "journal.jsonl"),
            `${entry("StartRun", 1_000)}\n${entry("EndRun", 4_000)}\n`,
        );
        expect(runSpan(dir, 5_000)).toEqual({ started: 1_000, ended: 4_000 });
    });

    test("a plan whose prefix differs from an existing manifest's is a conflict", () => {
        const out = mkdtempSync(join(tmpdir(), "sim-tier-"));
        const job = { dir: join(out, "S-101-pi"), events: 7 } as TierJob;
        expect(planConflicts([job])).toEqual([]);
        mkdirSync(job.dir);
        writeFileSync(join(job.dir, "manifest.json"), JSON.stringify({ events: 7 }));
        expect(planConflicts([job])).toEqual([]);
        writeFileSync(join(job.dir, "manifest.json"), JSON.stringify({ events: 5 }));
        expect(planConflicts([job])).toEqual([`${job.dir} ran 5 events, the plan says 7`]);
    });
});

describe("uncuttableRuns", () => {
    test("names the paired runs whose first reachable cut is their last event", () => {
        const job = (dir: string, events: number, group = "main") =>
            ({ dir, events, arms: ["host", "eidnara"], group }) as TierJob;
        const plan = [job("/r/a", 50), job("/r/b", 2), job("/r/p", 2, "profile")];
        expect(uncuttableRuns(plan, 0.4)).toEqual([]);
        expect(uncuttableRuns(plan, 0.9)).toEqual(["/r/b"]);
        expect(uncuttableRuns(plan, 0)).toEqual([]);
    });
});

describe("restartConflicts", () => {
    test("a changed fraction is a conflict once a paired run has begun", () => {
        const out = mkdtempSync(join(tmpdir(), "sim-tier-"));
        const job = { dir: join(out, "XL-101-pi"), group: "main" } as TierJob;
        expect(restartConflicts([job], 0.4, 0.7)).toEqual([]);
        mkdirSync(job.dir);
        writeFileSync(join(job.dir, "journal.jsonl"), "");
        expect(restartConflicts([job], 0.4, 0.7)).toEqual([
            `${job.dir} began under --restart-at 0.4; the plan now says 0.7`,
        ]);
        expect(restartConflicts([job], 0.7, 0.7)).toEqual([]);
        expect(restartConflicts([job], undefined, 0.7)).toEqual([]);
    });
});
