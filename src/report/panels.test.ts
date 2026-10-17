import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GradeRecord } from "../grade/probes";
import type { ArmLogs, RunLogs } from "../oracle/logs";
import type { Entry } from "../run/journal";
import { PRICE_TABLE } from "../run/price";
import { loadPrereg } from "../scenario/inputs";
import { costPanel, judgeCost } from "./cost";
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
    price: PRICE_TABLE,
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
        if (v === null) throw new Error("rss is sampled");
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
            return [v?.verdict, v?.slope_over_bound, v?.bound.holds, v?.returned_to_baseline];
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
        expect([v?.verdict, v?.bound.holds, v?.returned_to_baseline]).toEqual([
            "no leak",
            true,
            true,
        ]);
        const store = soak(run([], "", kinds), arm({ journal, resources }), "store_bytes");
        expect([store?.verdict, store?.returned_to_baseline]).toEqual(["no leak", null]);
        const few = soak(
            run([], "", kinds),
            arm({ journal, resources: resources.slice(0, 2) }),
            "rss",
        );
        expect(few?.verdict).toBe("insufficient samples");
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
        expect([v?.verdict, v?.slope_per_session, v?.bound.holds, v?.returned_to_baseline]).toEqual(
            ["leak", null, false, true],
        );
        const drift = flat(100 * MB);
        (drift[9] as { rss: number }).rss = 120 * MB;
        const d = soak(run([], "", kinds), arm({ journal, resources: drift }), "rss");
        expect([d?.verdict, d?.bound.holds, d?.returned_to_baseline]).toEqual([
            "leak",
            true,
            false,
        ]);
        const steady = soak(run([], "", kinds), arm({ journal, resources: flat(100 * MB) }), "rss");
        expect(steady?.verdict).toBe("insufficient samples");
    });

    test("the bound counts sessions completed after the baseline sample", () => {
        seq = 0;
        const kinds = new Map([
            ["end-0", "session_end"],
            ["end-1", "session_end"],
        ]);
        const journal = [
            entry("Event", 100, { event: "end-0", wall_ms: 100 }),
            entry("Event", 200, { event: "end-1", wall_ms: 200 }),
        ];
        const resources = [
            { scenario_ms: 300, wall_ms: 300, rss: 100 * MB, store_bytes: 0 },
            { scenario_ms: 400, wall_ms: 400, rss: 210 * MB, store_bytes: 0 },
            { scenario_ms: 500, wall_ms: 500, rss: 100 * MB, store_bytes: 0 },
        ];
        const v = soak(run([], "", kinds), arm({ journal, resources }), "rss");
        expect([v?.sessions, v?.bound.holds, v?.bound.c, v?.bound.worst]).toEqual([
            2,
            false,
            8 * MB,
            { value: 210 * MB, limit: 200 * MB, sessions: 0 },
        ]);
    });

    test("each daemon process is its own memory trajectory, so a replaced leaking daemon still leaks", () => {
        const { kinds, journal } = sessions(20, () => 0);
        const resources = Array.from({ length: 20 }, (_, s) =>
            Array.from({ length: 5 }, (_, i) => ({
                scenario_ms: s * 1000 + i * 100,
                wall_ms: s * 1000 + i * 100,
                pid: s < 10 ? 100 : 200,
                rss: s < 10 ? 100 * MB + s * 12 * MB : 100 * MB,
                store_bytes: 10 * MB,
            })),
        ).flat();
        const v = soak(run([], "", kinds), arm({ journal, resources }), "rss");
        if (v === null) throw new Error("rss is sampled");
        expect([v.verdict, v.slope_over_bound, v.generations, v.generation]).toEqual([
            "leak",
            true,
            2,
            1,
        ]);
        expect(v.slope_per_session).toBeCloseTo(12 * MB, -3);
        const store = soak(run([], "", kinds), arm({ journal, resources }), "store_bytes");
        expect([store?.verdict, store?.generations]).toEqual(["no leak", 1]);
        const reused: ArmLogs["resources"] = resources.map((r) => ({ ...r, pid: 100 }));
        reused.splice(50, 0, {
            scenario_ms: 9950,
            wall_ms: 9950,
            pid: null,
            rss: null,
            store_bytes: 10 * MB,
        });
        const again = soak(run([], "", kinds), arm({ journal, resources: reused }), "rss");
        expect([again?.verdict, again?.generations, again?.generation]).toEqual(["leak", 2, 1]);
        const restarted = resources.map((r, i) => ({
            ...r,
            pid: 100,
            pid_started: i < 50 ? 1000 : 5000,
        }));
        const resumed = soak(run([], "", kinds), arm({ journal, resources: restarted }), "rss");
        expect([resumed?.verdict, resumed?.generations, resumed?.generation]).toEqual([
            "leak",
            2,
            1,
        ]);
    });

    test("the sampling cadence counts every sampler row, including those taken with the daemon down", () => {
        seq = 0;
        const kinds = new Map<string, string>();
        const resources = [
            { scenario_ms: 0, wall_ms: 0, pid: 1, rss: 100 * MB, store_bytes: 0 },
            { scenario_ms: 10_000, wall_ms: 10_000, pid: null, rss: null, store_bytes: 0 },
            { scenario_ms: 20_000, wall_ms: 20_000, pid: 2, rss: 100 * MB, store_bytes: 0 },
        ];
        expect(soak(run([], "", kinds), arm({ resources }), "rss")?.max_gap_ms).toBe(10_000);
    });

    test("heap evidence is unavailable when samples from before the field remain", () => {
        const { kinds, journal, resources } = sessions(20, () => 100 * MB);
        const withHeap = resources.map((r) => ({ ...r, heap: 50 * MB }));
        expect(
            soak(run([], "", kinds), arm({ journal, resources: withHeap }), "heap")?.verdict,
        ).toBe("no leak");
        const mixed = [...resources.slice(0, 3), ...withHeap.slice(3)];
        expect(soak(run([], "", kinds), arm({ journal, resources: mixed }), "heap")).toBeNull();
    });

    test("an arm with no daemon samples gets the insufficient-samples shape", () => {
        const { kinds, journal } = sessions(2, () => 0);
        const resources = [
            { scenario_ms: 0, wall_ms: 0, pid: null, rss: null, store_bytes: 5 * MB },
        ];
        const v = soak(run([], "", kinds), arm({ journal, resources }), "rss");
        if (v === null) throw new Error("rss is sampled");
        expect([v.verdict, v.samples, v.baseline, v.generations, v.generation]).toEqual([
            "insufficient samples",
            0,
            null,
            0,
            1,
        ]);
        expect(v.bound).toEqual({ c: 8 * MB, holds: true, worst: null });
        expect(v.windows).toEqual({ warmup: 0, steady: 0, cooldown: 0 });
    });

    test("a sample taken while a session end is still closing belongs to the open session", () => {
        seq = 0;
        const kinds = new Map([["end-0", "session_end"]]);
        const journal = [entry("Event", 999, { event: "end-0", wall_ms: 1_500 })];
        const resources = [
            { scenario_ms: 0, wall_ms: 0, rss: 100 * MB, store_bytes: 0 },
            { scenario_ms: 999, wall_ms: 1_500, rss: 300 * MB, store_bytes: 0 },
            { scenario_ms: 999, wall_ms: 2_000, rss: 100 * MB, store_bytes: 0 },
        ];
        const v = soak(run([], "", kinds), arm({ journal, resources }), "rss");
        expect(v?.bound.worst).toEqual({
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
        expect(hits?.map((h) => h.evidence)).toEqual([
            "<history-segments",
            "</history-segments",
            "<Eidnara-Search-Hint>",
            "</Eidnara-Search-Hint>",
            "context-researcher-augmentation",
        ]);
        expect(new Set(hits?.map((h) => h.source))).toEqual(new Set(["agent-response"]));
        const first = mutant.arms[0] as ArmLogs;
        const twice = {
            ...first,
            calls: [
                {
                    ...(first.calls[0] as ArmLogs["calls"][number]),
                    seq: 900,
                    turn: "t-9",
                    response_text: "Done. <history-segments> were folded [eidnara] says so.",
                },
            ],
        };
        expect(intrusiveness(run([twice]), twice).internal_string_hits).toEqual([
            { source: "agent-response", at: "t-9", evidence: "<history-segments" },
            { source: "agent-response", at: "t-9", evidence: "[eidnara]" },
        ]);
        const truncated = {
            ...first,
            calls: [
                ...first.calls,
                {
                    ...(first.calls[0] as ArmLogs["calls"][number]),
                    response_text: "x".repeat(32_768),
                },
            ],
        };
        expect(intrusiveness(run([truncated]), truncated).internal_string_hits).toBeNull();
        seq = 0;
        const interrupted = {
            ...first,
            journal: [
                entry("BeginTurn", 0, { event: "e-1" }),
                entry("ItemState", 1, { event: "e-1", state: "failed(interrupted)" }),
            ],
        };
        expect(intrusiveness(run([interrupted]), interrupted).internal_string_hits).toBeNull();
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
                first_delivery_ms: BASE + 4_600,
            },
            {
                id: 5,
                content: "Observed: alpha 中文 beta gamma delta epsilon zeta.",
                status: "active",
                deliveries: 1,
                first_delivery_ms: BASE + 100,
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
            ["e-8", "pushback", "Is it alpha beta gamma delta epsilon now?", []],
            ["e-10", "pushback", "Again: the daemon port is 7780 on every host?", []],
        ] as const;
        writeFileSync(
            join(dir, "scenario.json"),
            JSON.stringify({
                events: [
                    { id: "e-1", kind: "user_turn", text: `Remember: ${rule}` },
                    ...replies.slice(1).map(([id]) => ({ id, kind: "user_turn", text: "Go on." })),
                    { id: "e-9", kind: "user_turn", text: "Keep the daemon port is 7780 as is." },
                    { id: "end-1", kind: "session_end" },
                ],
            }),
        );
        const tape = [
            { key: "e-2/other-arm", event: "e-2", label: "pushback", digest: "d", text: "Fine." },
            ...replies.map(([event, label, text]) => ({
                key: event,
                event,
                label,
                digest: "d",
                text,
            })),
        ];
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
            tape_key: event,
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
            ["e-8", 5000, 6000],
        ];
        const journal = turns.flatMap(([event, begin, end]) => [
            entry("BeginTurn", begin, { event }),
            entry("EndTurn", end, { event, outcome: "ok", prompt_ms: (end - begin) / 2 }),
            entry("UserTurn", end, { event, delivered: true }),
        ]);
        journal.push(
            entry("BeginTurn", 5000, { event: "e-10" }),
            entry("BeginTurn", 7000, { event: "e-9" }),
            entry("EndTurn", 907_000, {
                event: "e-9",
                outcome: "Timed out after 900000 ms",
                prompt_ms: 900_000,
            }),
        );
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
            { command: "echo 'git restore src/x.rs'", exit: 0, scenario_ms: 3, turn: "e-2" },
            {
                command: "cat > notes.md <<'EOF'\nRun git reset --hard to start over.\nEOF",
                exit: 0,
                scenario_ms: 3,
                turn: "e-2",
            },
            { command: 'git checkout -- "my file.rs"', exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: 'git -C "/tmp/my repo" restore a.rs', exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "git restore missing.rs || true", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "git restore b.rs; false", exit: 1, scenario_ms: 3, turn: "e-2" },
            { command: "git restore c.rs && cargo test", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "git restore d.rs | tee log", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "git checkout main\necho -- file", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "git checkout main --", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "git restore -- --staged", exit: 0, scenario_ms: 3, turn: "e-2" },
            {
                command: 'git commit -m "fix <<EOF"\nbody\nEOF\ngit restore h.rs',
                exit: 0,
                scenario_ms: 3,
                turn: "e-2",
            },
            { command: "echo git restore x", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "rg git restore README", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "echo ok # git reset --hard", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "sudo git restore e.rs", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "FOO=1 git restore f.rs", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "(git restore g.rs)", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "sudo -n git restore j.rs", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "env FOO=1 git reset --hard", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "git restore k.rs 2>&1", exit: 0, scenario_ms: 3, turn: "e-2" },
            {
                command: "git restore l.rs >/dev/null 2>&1 && echo ok",
                exit: 0,
                scenario_ms: 3,
                turn: "e-2",
            },
            { command: "echo $(git restore nonexistent)", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: 'git restore "-S" p.rs', exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "true || git restore q.rs", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "git restore r.rs\n", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "git restore s.rs\n\n# done\n", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: "false || git restore t.rs", exit: 0, scenario_ms: 3, turn: "e-2" },
            { command: 'git reset "--hard"', exit: 0, scenario_ms: 3, turn: "e-2" },
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
            'git checkout -- "my file.rs"',
            'git -C "/tmp/my repo" restore a.rs',
            "git restore c.rs && cargo test",
            "git restore -- --staged",
            'git commit -m "fix <<EOF"\nbody\nEOF\ngit restore h.rs',
            "sudo git restore e.rs",
            "FOO=1 git restore f.rs",
            "(git restore g.rs)",
            "sudo -n git restore j.rs",
            "env FOO=1 git reset --hard",
            "git restore k.rs 2>&1",
            "git restore l.rs >/dev/null 2>&1 && echo ok",
            "git restore r.rs\n",
            "git restore s.rs\n\n# done\n",
            'git reset "--hard"',
        ]);
        expect(panel.latency_ms).toEqual({ n: 7, p50: 500, p95: 5000 });
        expect(panel.tool_output_hits).toBeNull();
        const skipped = intrusiveness(
            run([], dir, new Map(), BASE),
            arm({
                journal: [
                    ...journal,
                    entry("BeginTurn", 8000, { event: "e-11" }),
                    entry("EndTurn", 8000, { event: "e-11", outcome: "ok", prompt_ms: null }),
                    entry("UserTurn", 8000, { event: "e-11", label: "abandon", delivered: false }),
                ],
            }),
        );
        expect(skipped.latency_ms).toEqual({ n: 7, p50: 500, p95: 5000 });
        const crashWindow = intrusiveness(
            run([], dir, new Map(), BASE),
            arm({
                journal: [
                    ...journal,
                    entry("BeginTurn", 8000, { event: "e-13" }),
                    entry("EndTurn", 9000, { event: "e-13", outcome: "ok", prompt_ms: 700 }),
                ],
            }),
        );
        expect(crashWindow.latency_ms).toEqual({ n: 8, p50: 500, p95: 5000 });
        const ambiguous = intrusiveness(
            run([], dir, new Map(), BASE),
            arm({
                journal: [
                    ...journal,
                    entry("EndTurn", 9000, { event: "e-14", outcome: "ok", prompt_ms: null }),
                ],
            }),
        );
        expect(ambiguous.latency_ms).toBeNull();
        const partial = intrusiveness(
            run([], dir, new Map(), BASE),
            arm({
                journal: [
                    ...journal,
                    entry("EndTurn", 8000, { event: "e-12", outcome: "ok" }),
                    entry("UserTurn", 8000, { event: "e-12", delivered: true }),
                ],
            }),
        );
        expect(partial.latency_ms).toBeNull();
        expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);

        const grades = [
            { arm: "eidnara", item: "i-1", version: 1, verdict: "pass", probe_type: "P3" },
            { arm: "eidnara", item: "i-13", version: 1, verdict: "pass", probe_type: "P13" },
            { arm: "host", item: "i-1", version: 1, verdict: "pass", probe_type: "P3" },
            { arm: "eidnara", item: "i-4", version: 1, verdict: "pass", probe_type: "P4" },
            { arm: "eidnara", item: "i-4", version: 2, verdict: "fail", probe_type: "P4" },
            { arm: "eidnara", item: "i-5", version: 1, verdict: "fail", probe_type: "P5" },
            { arm: "eidnara", item: "i-5", version: 3, verdict: "pass", probe_type: "P5" },
            { arm: "eidnara", item: "i-5", version: 2, verdict: "pass", probe_type: "P5" },
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
        writeFileSync(
            join(dir, "judge-calls.jsonl"),
            `${JSON.stringify({
                component: "judge",
                arm: "judge",
                input_tokens: 2e6,
                output_tokens: 1e6,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
            })}\n`,
        );
        const ungraded = costPanel(run([], dir), arm({ calls }), grades);
        expect([ungraded?.passes, ungraded?.usd_per_pass, ungraded?.usd]).toEqual([null, null, 31]);
        writeFileSync(join(dir, "grade-summary.json"), JSON.stringify({ judge_errors: 1 }));
        expect(costPanel(run([], dir), arm({ calls }), grades)?.passes).toBeNull();
        writeFileSync(join(dir, "grade-summary.json"), JSON.stringify({ judge_errors: 0 }));
        const cost = costPanel(run([], dir), arm({ calls }), grades);
        if (cost === null) throw new Error("the run records a price table");
        expect(cost.tokens).toEqual({ input: 2e6, output: 1e6, cache_read: 2e6, cache_write: 0 });
        expect(judgeCost(run([], dir))).toEqual({
            component: "judge",
            calls: 1,
            input: 2e6,
            output: 1e6,
            cache_read: 0,
            cache_write: 0,
            usd: 2 * PRICE_TABLE.rates.input + PRICE_TABLE.rates.output,
        });
        expect(judgeCost(run([], mkdtempSync(join(tmpdir(), "sim-panel-"))))).toBeNull();
        const unpriced = { ...run([], dir), price: null };
        expect(costPanel(unpriced, arm({ calls }), grades)).toBeNull();
        expect(judgeCost(unpriced)).toBeNull();
        expect(cost.components.map((c) => [c.component, c.usd])).toEqual([
            ["history_summarizer", PRICE_TABLE.rates.output + 2 * PRICE_TABLE.rates.cache_read],
            ["agent", PRICE_TABLE.rates.input],
            ["user-sim", PRICE_TABLE.rates.input],
        ]);
        expect([cost.usd, cost.harness_usd, cost.passes, cost.usd_per_pass]).toEqual([
            31, 5, 2, 15.5,
        ]);
        expect([cost.memory_writes, cost.writes_with_zero_reads, cost.price_table]).toEqual([
            5,
            1,
            "v1",
        ]);

        const hostArm = intrusiveness(run([], dir, new Map(), BASE), {
            ...arm({ journal, tools }),
            arm: "host",
        });
        expect(hostArm.corrections_referencing_injected_text).toEqual([]);
        const legacy = pairing.map(({ tape_key, ...r }, i) => (i === 1 ? r : { ...r, tape_key }));
        writeFileSync(
            join(dir, "pairing.jsonl"),
            `${legacy.map((t) => JSON.stringify(t)).join("\n")}\n`,
        );
        const unkeyed = intrusiveness(run([], dir, new Map(), BASE), arm({ journal, tools }));
        expect(unkeyed.corrections_referencing_injected_text).toBeNull();
        writeFileSync(join(dir, "eidnara", "memory.json"), "null\n");
        const unavailable = intrusiveness(run([], dir, new Map(), BASE), arm({ journal, tools }));
        expect(unavailable.corrections_referencing_injected_text).toBeNull();
    });
});
