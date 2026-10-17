import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import type { Scenario } from "../scenario/compile";
import { loadPrereg } from "../scenario/inputs";
import { capEvents, planConflicts, runStartedMs, type TierJob, tierPlan } from "./tier";

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
    test("a run's start is its journaled StartRun, so a resumed run keeps its wall budget", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-tier-"));
        expect(runStartedMs(dir, 5_000)).toBe(5_000);
        writeFileSync(
            join(dir, "journal.jsonl"),
            `${JSON.stringify({ kind: "StartRun", arm: null, seq: 0, scenario_ms: 0, wall_ms: 1_000 })}\n`,
        );
        expect(runStartedMs(dir, 5_000)).toBe(1_000);
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
