import { describe, expect, test } from "bun:test";
import type { Scenario } from "../scenario/compile";
import { loadPrereg } from "../scenario/inputs";
import { capEvents, tierPlan } from "./tier";

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
