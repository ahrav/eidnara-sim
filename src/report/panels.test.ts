import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GradeRecord } from "../grade/probes";
import type { ArmLogs, RunLogs } from "../oracle/logs";
import type { Entry } from "../run/journal";
import { loadPrereg } from "../scenario/inputs";
import { costPanel, V1_PRICE } from "./cost";
import { intrusiveness, percentile } from "./intrusive";
import { soak } from "./soak";

const prereg = loadPrereg("S");
const MB = 1024 * 1024;
const BASE = 1_792_000_000_000;
let seq = 0;
const entry = (kind: string, scenario_ms: number, extra: Record<string, unknown> = {}) =>
    ({ kind, arm: "eidnara", scenario_ms, seq: seq++, wall_ms: scenario_ms, ...extra }) as Entry;

function arm(over: Partial<ArmLogs> = {}): ArmLogs {
    return {
        arm: "eidnara",
        calls: [],
        journal: [],
        pluginLog: [],
        daemonLog: [],
        resources: [],
        tools: [],
        ...over,
    };
}
const run = (
    arms: ArmLogs[],
    dir = "",
    kinds = new Map<string, string>(),
    base_wall_ms = 0,
): RunLogs => ({
    dir,
    tier: "S",
    base_wall_ms,
    prereg,
    kinds,
    arms,
});

function sessions(n: number, rss: (session: number, i: number) => number) {
    seq = 0;
    const kinds = new Map<string, string>();
    const journal: Entry[] = [];
    const resources: ArmLogs["resources"] = [];
    for (let s = 0; s < n; s++) {
        for (let i = 0; i < 5; i++) {
            const ms = s * 1000 + i * 100;
            resources.push({ scenario_ms: ms, wall_ms: ms, rss: rss(s, i), store_bytes: 10 * MB });
        }
        kinds.set(`end-${s}`, "session_end");
        journal.push(entry("Event", s * 1000 + 999, { event: `end-${s}` }));
    }
    return { kinds, journal, resources };
}

describe("soak verdict", () => {
    test("a planted linear RSS growth is a leak with its slope, R squared, and bound", () => {
        const { kinds, journal, resources } = sessions(20, (s) => 100 * MB + s * 30 * MB);
        const v = soak(run([], "", kinds), arm({ journal, resources }), "rss");
        expect(v.verdict).toBe("leak");
        expect(v.slope_per_session).toBeCloseTo(30 * MB, -3);
        expect(v.r2).toBeGreaterThan(0.95);
        expect(v.slope_over_bound).toBe(true);
        expect(v.bound.holds).toBe(false);
        expect(v.returned_to_baseline).toBe(false);
        expect(v.windows).toEqual({ warmup: 10, steady: 80, cooldown: 10 });
        expect(v.max_gap_ms).toBe(600);
    });

    test("each leak trigger alone gives a leak: the slope, the bound, and the missed return", () => {
        const verdict = (f: (s: number, i: number) => number) => {
            const { kinds, journal, resources } = sessions(20, f);
            const v = soak(run([], "", kinds), arm({ journal, resources }), "rss");
            return [v.verdict, v.slope_over_bound, v.bound.holds, v.returned_to_baseline];
        };
        const GB = 1024 * MB;
        expect(verdict((s) => (s < 2 || s > 17 ? GB : GB + s * 12 * MB))).toEqual([
            "leak",
            true,
            true,
            true,
        ]);
        expect(verdict((s, i) => (s === 9 && i === 2 ? 300 * MB : 100 * MB))).toEqual([
            "leak",
            false,
            false,
            true,
        ]);
        expect(verdict((s) => (s >= 18 ? 120 * MB : 100 * MB))).toEqual([
            "leak",
            false,
            true,
            false,
        ]);
    });

    test("flat RSS with noise is no leak, and too few samples decide nothing", () => {
        const { kinds, journal, resources } = sessions(20, (_, i) => 100 * MB + (i % 2) * MB);
        const v = soak(run([], "", kinds), arm({ journal, resources }), "rss");
        expect([v.verdict, v.bound.holds, v.returned_to_baseline]).toEqual(["no leak", true, true]);
        const store = soak(run([], "", kinds), arm({ journal, resources }), "store_bytes");
        expect([store.verdict, store.returned_to_baseline]).toEqual(["no leak", null]);
        const few = soak(
            run([], "", kinds),
            arm({ journal, resources: resources.slice(0, 2) }),
            "rss",
        );
        expect(few.verdict).toBe("insufficient samples");
    });

    test("a broken bound or a missed return is a leak with no fittable slope", () => {
        const { kinds, journal } = sessions(1, () => 0);
        const flat = (rss: number) =>
            Array.from({ length: 10 }, (_, i) => ({
                scenario_ms: i * 100,
                wall_ms: i * 100,
                rss,
                store_bytes: 0,
            }));
        const jump = flat(100 * MB);
        (jump[5] as { rss: number }).rss = 300 * MB;
        const v = soak(run([], "", kinds), arm({ journal, resources: jump }), "rss");
        expect([v.verdict, v.slope_per_session, v.bound.holds, v.returned_to_baseline]).toEqual([
            "leak",
            null,
            false,
            true,
        ]);
        const drift = flat(100 * MB);
        (drift[9] as { rss: number }).rss = 120 * MB;
        const d = soak(run([], "", kinds), arm({ journal, resources: drift }), "rss");
        expect([d.verdict, d.bound.holds, d.returned_to_baseline]).toEqual(["leak", true, false]);
        const steady = soak(run([], "", kinds), arm({ journal, resources: flat(100 * MB) }), "rss");
        expect(steady.verdict).toBe("insufficient samples");
    });

    test("a sample taken while a session end is still closing belongs to the open session", () => {
        seq = 0;
        const kinds = new Map([["end-0", "session_end"]]);
        const journal = [entry("Event", 999, { event: "end-0", wall_ms: 1_500 })];
        const resources = [
            { scenario_ms: 0, wall_ms: 0, rss: 100 * MB, store_bytes: 0 },
            { scenario_ms: 999, wall_ms: 1_000, rss: 300 * MB, store_bytes: 0 },
            { scenario_ms: 999, wall_ms: 2_000, rss: 100 * MB, store_bytes: 0 },
        ];
        const v = soak(run([], "", kinds), arm({ journal, resources }), "rss");
        expect(v.bound.worst).toEqual({
            value: 300 * MB,
            limit: 200 * MB,
            sessions: 0,
        });
    });
});

describe("intrusiveness panel", () => {
    test("the mutant internal-string fixture fires", () => {
        const mutant = JSON.parse(
            readFileSync(
                join(import.meta.dir, "../../tests/fixtures/oracle/F7-mutant.json"),
                "utf8",
            ),
        ) as { arms: ArmLogs[] };
        const hits = intrusiveness(
            run(mutant.arms),
            mutant.arms[0] as ArmLogs,
        ).internal_string_hits;
        expect(hits.map((h) => h.source)).toEqual([
            "agent-response",
            "agent-response",
            "agent-response",
        ]);
    });

    test("a correction counts only when it quotes a note delivered earlier that the user never wrote", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-panel-"));
        mkdirSync(join(dir, "eidnara"));
        const rule = "every commit message must start with [ember_magpie].";
        const notes = [
            {
                id: 1,
                content: `User rule: ${rule}`,
                status: "active",
                deliveries: 2,
                first_delivery_ms: BASE + 100,
            },
            {
                id: 2,
                content: "Observed: the daemon port is 7780 on every host.",
                status: "active",
                deliveries: 1,
                first_delivery_ms: BASE + 100,
            },
            {
                id: 3,
                content: "Observed: the cache lives under /var/cache/sim for builds.",
                status: "active",
                deliveries: 0,
                first_delivery_ms: null,
            },
            {
                id: 4,
                content: "Observed: retries stop after nine attempts in the client.",
                status: "active",
                deliveries: 1,
                first_delivery_ms: BASE + 5_500,
            },
        ];
        writeFileSync(join(dir, "eidnara", "memory.json"), JSON.stringify(notes));
        const replies = [
            ["e-1", "pushback", `You ignored my rule: ${rule}`, []],
            ["e-2", "pushback", "Why did you assume the daemon port is 7780 on this machine?", []],
            ["e-3", "pushback", "Where did the cache lives under /var/cache/sim come from?", []],
            ["e-4", "pushback", "Who said retries stop after nine attempts in the client?", []],
            ["e-5", "task", "Note that the daemon port is 7780 here.", []],
            ["e-6", "pushback", "Is the daemon port is 7780 right?", ["P1"]],
            ["e-7", "pushback", "Who says the daemon port is 7780 on every host?", []],
        ] as const;
        writeFileSync(
            join(dir, "scenario.json"),
            JSON.stringify({
                events: [
                    { id: "e-1", kind: "user_turn", text: `Remember: ${rule}` },
                    { id: "end-1", kind: "session_end" },
                ],
            }),
        );
        const tape = replies.map(([event, label, text]) => ({
            key: event,
            event,
            label,
            digest: "d",
            text,
        }));
        writeFileSync(
            join(dir, "tape.jsonl"),
            `${tape.map((t) => JSON.stringify(t)).join("\n")}\n`,
        );
        const pairing = replies.map(([event, label, , fallback], index) => ({
            kind: "turn",
            arm: "eidnara",
            session: "s-9",
            event,
            index,
            label,
            delivered: true,
            digest: "d",
            prefix_sha256: "p",
            text_sha256: "t",
            source: "live",
            ...(fallback.length ? { fallback } : {}),
        }));
        writeFileSync(
            join(dir, "pairing.jsonl"),
            `${pairing.map((t) => JSON.stringify(t)).join("\n")}\n`,
        );
        seq = 0;
        const turns: [string, number, number][] = [
            ["e-1", 1000, 4000],
            ["e-2", 5000, 15000],
            ["e-3", 5000, 6000],
            ["e-4", 5000, 6000],
            ["e-5", 5000, 6000],
            ["e-6", 5000, 6000],
        ];
        const journal = turns.flatMap(([event, begin, end]) => [
            entry("BeginTurn", begin, { event }),
            entry("EndTurn", end, { event, prompt_ms: (end - begin) / 2 }),
            entry("UserTurn", end, { event }),
        ]);
        const tools = [
            { command: "git restore src/db.rs", exit: 0, scenario_ms: 1, turn: "e-2" },
            { command: "git checkout -- src/lib.rs", exit: 0, scenario_ms: 2, turn: "e-2" },
            { command: "git restore --staged src/lib.rs", exit: 0, scenario_ms: 3, turn: "e-2" },
            {
                command: "git restore --quiet --staged src/lib.rs",
                exit: 0,
                scenario_ms: 3,
                turn: "e-2",
            },
            {
                command: "git restore --source=HEAD -S src/lib.rs",
                exit: 0,
                scenario_ms: 3,
                turn: "e-2",
            },
            {
                command: "git restore --staged --worktree src/lib.rs",
                exit: 0,
                scenario_ms: 3,
                turn: "e-2",
            },
            { command: "git checkout main && echo -- x", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "git restore -Sq src/lib.rs", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "git restore -qS src/lib.rs", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "git restore -SW src/lib.rs", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "git restore missing.rs", exit: 1, scenario_ms: 3, turn: "e-2" },
            { command: "git reset --hard", exit: null, scenario_ms: 3, turn: "e-2" },
            { command: "git reset -q --hard HEAD~1", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "cargo test", exit: 0, scenario_ms: 4, turn: "e-2" },
        ];
        const panel = intrusiveness(run([], dir, new Map(), BASE), arm({ journal, tools }));
        expect(panel.corrections_referencing_injected_text).toEqual([
            { event: "e-2", label: "pushback", quote: "the daemon port is 7780" },
        ]);
        expect(panel.reverted_edits.map((r) => r.command)).toEqual([
            "git restore src/db.rs",
            "git checkout -- src/lib.rs",
            "git restore --staged --worktree src/lib.rs",
            "git restore -SW src/lib.rs",
            "git reset -q --hard HEAD~1",
        ]);
        expect(panel.latency_ms).toEqual({ n: 6, p50: 500, p95: 5000 });
        expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);

        const grades = [
            { arm: "eidnara", verdict: "pass", probe_type: "P3" },
            { arm: "eidnara", verdict: "pass", probe_type: "P13" },
            { arm: "host", verdict: "pass", probe_type: "P3" },
        ] as GradeRecord[];
        const calls = [
            {
                component: "agent",
                input_tokens: 1e6,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
            },
            {
                component: "history_summarizer",
                input_tokens: 0,
                output_tokens: 1e6,
                cache_read_tokens: 2e6,
                cache_write_tokens: 0,
            },
            {
                component: "user-sim",
                input_tokens: 1e6,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
            },
        ] as ArmLogs["calls"];
        const cost = costPanel(run([], dir), arm({ calls }), grades);
        expect(cost.components.map((c) => [c.component, c.usd])).toEqual([
            ["history_summarizer", V1_PRICE.output + 2 * V1_PRICE.cache_read],
            ["agent", V1_PRICE.input],
            ["user-sim", V1_PRICE.input],
        ]);
        expect([cost.usd, cost.harness_usd, cost.passes, cost.usd_per_pass]).toEqual([
            31, 5, 1, 31,
        ]);
        expect([cost.memory_writes, cost.writes_with_zero_reads, cost.price_table]).toEqual([
            4,
            1,
            "v1",
        ]);

        writeFileSync(join(dir, "eidnara", "memory.json"), "null\n");
        const unavailable = intrusiveness(run([], dir, new Map(), BASE), arm({ journal, tools }));
        expect(unavailable.corrections_referencing_injected_text).toBeNull();
    });
});
