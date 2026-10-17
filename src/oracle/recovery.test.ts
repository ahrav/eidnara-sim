import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SEGMENTS_DDL } from "../../tests/segments";
import { checkStore, parseStoreCheck, type StoreCheck } from "../hosts/storecheck";
import type { Entry } from "../run/journal";
import { loadPrereg } from "../scenario/inputs";
import type { ArmLogs, RunLogs } from "./logs";
import { recoveries } from "./recovery";

const prereg = loadPrereg("S");
const recorded = JSON.parse(
    readFileSync(
        join(import.meta.dir, "../../tests/fixtures/recovery/witness-8-eidnara.json"),
        "utf8",
    ),
) as {
    base_wall_ms: number;
    arms: ArmLogs[];
    expect: Record<string, [number, boolean]>;
    expect_reasons: Record<string, string[]>;
};
const run = (arms: ArmLogs[], base = 0): RunLogs => ({
    dir: "",
    tier: "S",
    base_wall_ms: base,
    prereg,
    kinds: new Map(),
    arms,
});

let seq = 0;
const entry = (kind: string, scenario_ms: number, extra: Record<string, unknown> = {}): Entry =>
    ({ kind, arm: "eidnara", scenario_ms, seq: seq++, wall_ms: 0, ...extra }) as Entry;
const stamp = (ms: number) => `[${new Date(ms).toISOString()}]`;

function arm(journal: Entry[], pluginLog: string[] = [], finalStore?: StoreCheck): ArmLogs {
    return {
        arm: "eidnara",
        calls: [],
        journal,
        pluginLog,
        daemonLog: [],
        resources: [],
        tools: [],
        finalStore,
    };
}
const SEGMENT: StoreCheck["ranges"][number] = ["s", 1, 0, 9, "d1"];
const store = (integrity: string, overlaps = 0, ranges = [SEGMENT]): StoreCheck => ({
    integrity,
    segments: ranges.length,
    overlaps: Array.from({ length: overlaps }, () => ({ session: "s", first: 1, second: 2 })),
    ranges,
});

const sigkills = JSON.parse(
    readFileSync(
        join(import.meta.dir, "../../tests/fixtures/recovery/recovery-3-eidnara.json"),
        "utf8",
    ),
) as typeof recorded;

describe("recovery oracles", () => {
    test("the recorded witness recovers at a clean turn after each fault, and its restart lacks a store check", () => {
        const got = recoveries(run(recorded.arms, recorded.base_wall_ms));
        const byFault = Object.fromEntries(
            got.map((r) => [r.fault, [r.turns_to_first_clean, r.recovered]]),
        );
        expect(byFault).toEqual(recorded.expect);
        const full = got.find((r) => r.fault === "w-full");
        expect(full?.reasons).toEqual([]);
        const restart = got.find((r) => r.fault === "w-restart");
        expect(restart?.reasons).toEqual(recorded.expect_reasons["w-restart"]);
    });

    test("the recorded mid-fold SIGKILLs reach a clean turn, the first after the fail-open in the turn it cut, and their digest-free store checks withhold recovery", () => {
        const got = recoveries(run(sigkills.arms, sigkills.base_wall_ms));
        const byFault = Object.fromEntries(
            got.map((r) => [r.fault, [r.turns_to_first_clean, r.recovered]]),
        );
        expect(byFault).toEqual(sigkills.expect);
        const passed = { after_crash: "ok", post_crash_pass: "ok", final: "ok" };
        expect(got.map((r) => r.store)).toEqual([passed, passed, passed]);
        // Recorded before the store check digested segment contents: bounds compare, contents cannot.
        for (const r of got) expect(r.reasons).toEqual(["store ranges lack content digests"]);
        const lost = structuredClone(sigkills.arms);
        const arm0 = lost[0] as ArmLogs;
        for (const e of arm0.journal.filter((x) => x.kind === "StoreChecked")) {
            (e.store as StoreCheck).ranges = [];
            (e.store as StoreCheck).segments = 0;
        }
        const broken = recoveries(run(lost, sigkills.base_wall_ms));
        expect(broken.map((r) => r.recovered)).toEqual([false, false, false]);
        expect(broken[0]?.reasons).toEqual([
            "store ranges lack content digests",
            "post-crash pass removed or changed segments sim-s-0003/1/1/4",
        ]);
    });

    test("every overflow wording the F1 oracle knows dirties a turn", () => {
        seq = 0;
        const journal = [
            entry("FaultObserved", 0, { fault: "f", type: "plugin_reload", evidence: {} }),
            entry("BeginTurn", 10, { event: "e-1" }),
            entry("EndTurn", 20, { event: "e-1", outcome: "ok" }),
        ];
        const call = (error: string) =>
            ({
                turn: "e-1",
                status: 500,
                error,
                started_wall_ms: 12,
                wall_ms: 14,
                scenario_ms: 12,
            }) as unknown as ArmLogs["calls"][number];
        for (const error of [
            "too many total text bytes",
            "input length exceeds the model's maximum context length",
        ]) {
            const a = arm(journal);
            a.calls = [call(error)];
            const [r] = recoveries(run([a]));
            expect([error, r?.reasons]).toEqual([error, ["e-1: overflow"]]);
        }
    });

    test("a store check of the wrong shape refuses the run instead of certifying it", () => {
        seq = 0;
        const journal = (after: unknown, pass: unknown) => [
            entry("FaultObserved", 0, {
                fault: "k",
                type: "daemon_restart",
                evidence: { store: after },
            }),
            entry("BeginTurn", 10, { event: "e-1" }),
            entry("EndTurn", 20, { event: "e-1", outcome: "ok" }),
            entry("StoreChecked", 20, { event: "e-1", fault: "k", store: pass }),
        ];
        const ok = store("ok");
        const bogus = { integrity: "ok", overlaps: "", ranges: [] };
        expect(() =>
            recoveries(run([arm(journal(ok, ok), [], bogus as unknown as StoreCheck)])),
        ).toThrow("store check");
        expect(() => recoveries(run([arm(journal(bogus, ok), [], ok)]))).toThrow("store check");
        expect(() => recoveries(run([arm(journal(ok, bogus), [], ok)]))).toThrow("store check");
        const badRange = { ...ok, ranges: [["s", 1, 0]] };
        expect(() => recoveries(run([arm(journal(ok, badRange), [], ok)]))).toThrow("store check");
        const miscounted = { ...ok, segments: 2 };
        expect(() => recoveries(run([arm(journal(ok, miscounted), [], ok)]))).toThrow(
            "store check",
        );
        expect(parseStoreCheck(ok, "x")).toEqual(ok);
        const legacy = { ...ok, ranges: [["s", 1, 0, 9]] };
        expect(parseStoreCheck(legacy, "x").ranges as unknown[]).toEqual([["s", 1, 0, 9]]);
    });

    test("a failed pass's warning and its decision record count as one publication", () => {
        seq = 0;
        const journal = [
            entry("FaultObserved", 0, { fault: "f", type: "plugin_reload", evidence: {} }),
            entry("BeginTurn", 10, { event: "e-1" }),
            entry("EndTurn", 20, { event: "e-1", outcome: "ok" }),
        ];
        const log = [
            `${stamp(15)} [eidnara][s-1] rust transform failed; serving the input unchanged: x`,
            `${stamp(15)} [eidnara][s-1] rust pass: decision=error reason=none served_from=raw`,
        ];
        const [r] = recoveries(run([arm(journal, log)]));
        expect(r?.reasons).toEqual(["e-1: 1 fail-open publications"]);
        const [warned] = recoveries(run([arm(journal, [log[0] as string])]));
        expect(warned?.reasons).toEqual(["e-1: 1 fail-open publications"]);
    });

    test("a fail-open publication in every later turn prevents a recovered verdict", () => {
        seq = 0;
        const journal = [
            entry("FaultObserved", 0, { fault: "f", type: "plugin_reload", evidence: {} }),
            entry("BeginTurn", 10, { event: "e-1" }),
            entry("EndTurn", 20, { event: "e-1", outcome: "ok" }),
            entry("BeginTurn", 30, { event: "e-2" }),
            entry("EndTurn", 40, { event: "e-2", outcome: "ok" }),
        ];
        const log = [
            `${stamp(15)} [eidnara][s-1] rust transform failed; serving the input unchanged: x`,
            `${stamp(35)} [eidnara][s-1] rust pass: decision=error reason=none served_from=raw`,
        ];
        const [r] = recoveries(run([arm(journal, log)]));
        expect([r?.recovered, r?.turns_to_first_clean]).toEqual([false, null]);
        expect(r?.reasons).toEqual([
            "e-1: 1 fail-open publications",
            "e-2: 1 fail-open publications",
        ]);
        const [clean] = recoveries(run([arm(journal, [log[0] as string])]));
        expect([clean?.recovered, clean?.turns_to_first_clean]).toEqual([true, 2]);
    });

    test("after a daemon SIGKILL, every store check must pass and the post-crash pass keeps the surviving segments", () => {
        const journal = (after?: StoreCheck, pass?: StoreCheck) => {
            seq = 0;
            return [
                entry("FaultObserved", 0, {
                    fault: "k",
                    type: "daemon_sigkill_mid_fold",
                    evidence: after ? { store: after } : {},
                }),
                entry("BeginTurn", 10, { event: "e-1" }),
                entry("EndTurn", 20, { event: "e-1", outcome: "ok" }),
                ...(pass
                    ? [entry("StoreChecked", 20, { event: "e-1", fault: "k", store: pass })]
                    : []),
            ];
        };
        const ok = store("ok");
        const verdict = (after?: StoreCheck, pass?: StoreCheck, final?: StoreCheck) => {
            const r = recoveries(run([arm(journal(after, pass), [], final)]))[0];
            return [r?.recovered, r?.reasons];
        };
        const [clean] = recoveries(
            run([arm(journal(ok, store("ok", 0, [SEGMENT, ["s", 2, 10, 19, "d2"]])), [], ok)]),
        );
        expect(clean?.recovered).toBe(true);
        expect(clean?.store).toEqual({ after_crash: "ok", post_crash_pass: "ok", final: "ok" });
        expect(verdict(store("*** corrupt"), ok, ok)).toEqual([
            false,
            ["store integrity, after crash: *** corrupt"],
        ]);
        expect(verdict(ok, ok, store("error: file is not a database"))).toEqual([
            false,
            ["store integrity, final: error: file is not a database"],
        ]);
        expect(verdict(ok, store("ok", 1), ok)).toEqual([
            false,
            ["1 overlapping history segments, post crash pass"],
        ]);
        expect(verdict(ok, store("ok", 0, [["s", 1, 0, 12, "d1"]]), ok)).toEqual([
            false,
            ["post-crash pass removed or changed segments s/1/0/9/d1"],
        ]);
        expect(verdict(ok, store("ok", 0, [["s", 1, 0, 9, "d9"]]), ok)).toEqual([
            false,
            ["post-crash pass removed or changed segments s/1/0/9/d1"],
        ]);
        expect(verdict(undefined, ok, ok)).toEqual([false, ["store unchecked: after crash"]]);
        expect(verdict(ok, undefined, ok)).toEqual([false, ["store unchecked: post crash pass"]]);
        expect(verdict(ok, ok, undefined)).toEqual([false, ["store unchecked: final"]]);
    });

    test("a skipped fault has no verdict, and a laptop sleep is an infrastructure fault", () => {
        seq = 0;
        const skipped = { skipped: "arm runs no daemon" };
        const journal = [
            entry("FaultObserved", 0, { fault: "k", type: "daemon_restart", evidence: skipped }),
            entry("FaultObserved", 1, { fault: "z", type: "laptop_sleep", evidence: {} }),
            entry("BeginTurn", 10, { event: "e-1" }),
            entry("EndTurn", 20, { event: "e-1", outcome: "ok" }),
        ];
        const got = recoveries(run([arm(journal)])).map((r) => [r.fault, r.recovered, r.reasons]);
        expect(got).toEqual([
            ["k", null, ["skipped: arm runs no daemon"]],
            ["z", true, []],
        ]);
    });

    test("the store check reports integrity and overlapping history segments", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-store-")), "store.db");
        const db = new Database(path);
        db.run(SEGMENTS_DDL);
        db.run(
            "insert into history_segments (session_id, sequence, start_message, end_message, content) values ('s', 1, 0, 9, 'first'), ('s', 2, 10, 19, 'second'), ('t', 1, 0, 5, 'other')",
        );
        db.close();
        const checked = checkStore(path);
        expect(checked).toMatchObject({ integrity: "ok", segments: 3, overlaps: [] });
        expect(checked.ranges.map((r) => r.slice(0, 4))).toEqual([
            ["s", 1, 0, 9],
            ["s", 2, 10, 19],
            ["t", 1, 0, 5],
        ]);
        const digests = checked.ranges.map((r) => r[4]);
        expect(digests.every((d) => /^[0-9a-f]{16}$/.test(d))).toBe(true);
        expect(new Set(digests).size).toBe(3);
        const rewritten = new Database(path);
        rewritten.run(
            "update history_segments set content = 'rewritten' where session_id = 's' and sequence = 1",
        );
        rewritten.close();
        const after = checkStore(path).ranges;
        expect(after[0]?.slice(0, 4)).toEqual(["s", 1, 0, 9]);
        expect(after[0]?.[4]).not.toBe(digests[0]);
        expect(after.slice(1)).toEqual(checked.ranges.slice(1));
        const again = new Database(path);
        again.run(
            "insert into history_segments (session_id, sequence, start_message, end_message) values ('s', 3, 15, 25)",
        );
        again.close();
        expect(checkStore(path).overlaps).toEqual([{ session: "s", first: 2, second: 3 }]);
        expect(checkStore(join(path, "missing")).integrity).toBe("missing");
        const nested = new Database(path);
        nested.run("delete from history_segments");
        nested.run(
            "insert into history_segments (session_id, sequence, start_message, end_message) values ('s', 1, 0, 30), ('s', 2, 5, 10), ('s', 3, 15, 20)",
        );
        nested.close();
        expect(checkStore(path).overlaps).toEqual([
            { session: "s", first: 1, second: 2 },
            { session: "s", first: 1, second: 3 },
        ]);
        const nul = new Database(path);
        nul.run("delete from history_segments");
        nul.run(
            "insert into history_segments (session_id, sequence, start_message, end_message, title, content) values ('n', 1, 0, 1, 'a', 'b' || char(0) || 'c'), ('n', 2, 2, 3, 'a' || char(0) || 'b', 'c')",
        );
        nul.close();
        const [first, second] = checkStore(path).ranges;
        expect(first?.[4]).not.toBe(second?.[4]);
        const inverted = new Database(path);
        inverted.run(
            "insert into history_segments (session_id, sequence, start_message, end_message) values ('u', 1, 9, 2)",
        );
        inverted.close();
        expect(checkStore(path).integrity).toBe("ok; inverted range u/1");
        const junk = join(dirname(path), "junk.db");
        writeFileSync(junk, "not sqlite at all, padded past the header length of a database file");
        expect(checkStore(junk).integrity).toStartWith("error: ");
    });
});

describe("recovery anchors", () => {
    test("a mid-fold kill observed after the turn it cut ended still counts that turn", () => {
        seq = 0;
        const journal = [
            entry("BeginTurn", 10, { event: "e-1" }),
            entry("FaultFired", 12, { fault: "k", type: "daemon_sigkill_mid_fold" }),
            entry("EndTurn", 20, { event: "e-1", outcome: "ok" }),
            entry("FaultObserved", 25, {
                fault: "k",
                type: "daemon_sigkill_mid_fold",
                evidence: { store: store("ok") },
            }),
            entry("StoreChecked", 25, { event: "e-1", fault: "k", store: store("ok") }),
            entry("BeginTurn", 30, { event: "e-2" }),
            entry("EndTurn", 40, { event: "e-2", outcome: "ok" }),
        ];
        const log = [
            `${stamp(13)} [eidnara][s-1] rust pass: decision=error reason=none served_from=raw`,
        ];
        const [r] = recoveries(run([arm(journal, log, store("ok"))]));
        expect([r?.recovered, r?.turns_to_first_clean]).toEqual([true, 2]);
        expect(r?.reasons).toEqual([]);
        const last = journal.slice(0, 5);
        const [cut] = recoveries(run([arm(last, [], store("ok"))]));
        expect([cut?.recovered, cut?.turns_to_first_clean, cut?.reasons]).toEqual([true, 1, []]);
    });
});

describe("recovery windows", () => {
    test("a call that completed before a mid-turn fault does not dirty the turn it cut", () => {
        seq = 0;
        const journal = [
            entry("BeginTurn", 10, { event: "e-1" }),
            entry("FaultFired", 20, { fault: "k", type: "daemon_sigkill_mid_fold" }),
            entry("FaultObserved", 21, {
                fault: "k",
                type: "daemon_sigkill_mid_fold",
                evidence: { store: store("ok") },
            }),
            entry("EndTurn", 30, { event: "e-1", outcome: "ok" }),
            entry("StoreChecked", 30, { event: "e-1", fault: "k", store: store("ok") }),
        ];
        const call = (scenario_ms: number, status: number) =>
            ({
                turn: "e-1",
                status,
                error: null,
                started_wall_ms: scenario_ms,
                wall_ms: scenario_ms + 2,
                scenario_ms,
            }) as unknown as ArmLogs["calls"][number];
        const before = arm(journal, [], store("ok"));
        before.calls = [call(12, 400), call(25, 200)];
        const [r] = recoveries(run([before]));
        expect([r?.recovered, r?.turns_to_first_clean, r?.reasons]).toEqual([true, 1, []]);
        const after = arm(journal, [], store("ok"));
        after.calls = [call(12, 200), call(25, 400)];
        const [dirty] = recoveries(run([after]));
        expect([dirty?.recovered, dirty?.reasons]).toEqual([false, ["e-1: gateway 4xx"]]);
    });

    test("a clean turn's window closes when the next turn begins, even if that turn never ends", () => {
        seq = 0;
        const journal = [
            entry("FaultObserved", 0, { fault: "f", type: "plugin_reload", evidence: {} }),
            entry("BeginTurn", 10, { event: "e-1" }),
            entry("EndTurn", 20, { event: "e-1", outcome: "ok" }),
            entry("BeginTurn", 30, { event: "e-2" }),
        ];
        const log = [
            `${stamp(35)} [eidnara][s-1] rust pass: decision=error reason=none served_from=raw`,
        ];
        const [r] = recoveries(run([arm(journal, log)]));
        expect([r?.recovered, r?.turns_to_first_clean, r?.reasons]).toEqual([true, 1, []]);
    });
});

describe("resumed journals", () => {
    test("a turn a harness kill interrupted counts as the dirty first turn", () => {
        seq = 0;
        const journal = [
            entry("FaultObserved", 0, { fault: "f", type: "plugin_reload", evidence: {} }),
            entry("BeginTurn", 10, { event: "e-1" }),
            entry("ItemState", 10, { event: "e-1", state: "failed(interrupted)" }),
            entry("Event", 10, { event: "e-1", outcome: "failed(interrupted)" }),
            entry("BeginTurn", 30, { event: "e-2" }),
            entry("EndTurn", 40, { event: "e-2", outcome: "ok" }),
            entry("Event", 40, { event: "e-2", outcome: "ok" }),
        ];
        const [r] = recoveries(run([arm(journal)]));
        expect([r?.recovered, r?.turns_to_first_clean]).toEqual([true, 2]);
        const [only] = recoveries(run([arm(journal.slice(0, 4))]));
        expect([only?.recovered, only?.reasons]).toEqual([
            false,
            ["e-1: turn ended failed(interrupted)"],
        ]);
    });

    test("a fault fired but never observed is reported, unrecovered", () => {
        seq = 0;
        const journal = [
            entry("FaultFired", 0, { fault: "k", type: "daemon_restart", layer: "scheduler" }),
            entry("ItemState", 0, { fault: "k", state: "failed(interrupted)" }),
            entry("BeginTurn", 10, { event: "e-1" }),
            entry("EndTurn", 20, { event: "e-1", outcome: "ok" }),
        ];
        const got = recoveries(run([arm(journal, [], store("ok"))]));
        expect(got.map((r) => [r.fault, r.recovered, r.turns_to_first_clean])).toEqual([
            ["k", false, 1],
        ]);
        expect(got[0]?.reasons).toContain("fault not observed: harness interrupted");
        expect(got[0]?.store).toEqual({
            after_crash: "unchecked",
            post_crash_pass: "unchecked",
            final: "ok",
        });
    });
});

describe("plugin log attribution", () => {
    const wall = (ms: number, extra: Record<string, unknown>) => ({ ...extra, wall_ms: ms });

    test("a fail-open stamped by the harness's rounded clock offset is read back through that offset", () => {
        seq = 0;
        const base = 1_000_000_000;
        // Written when the wall clock read 600: (base - 600) / 1000 rounds down to base - 1000.
        const offset = base - 1_000;
        const journal = [
            entry("ClockOffset", 0, wall(600, { offset_s: offset / 1000 })),
            entry(
                "FaultObserved",
                0,
                wall(620, { fault: "f", type: "plugin_reload", evidence: {} }),
            ),
            entry("BeginTurn", 0, wall(650, { event: "e-1" })),
            entry("EndTurn", 9_000, wall(9_650, { event: "e-1", outcome: "ok" })),
            entry("BeginTurn", 9_000, wall(10_650, { event: "e-2" })),
            entry("EndTurn", 10_000, wall(11_650, { event: "e-2", outcome: "ok" })),
        ];
        // Published 50 ms into e-1 (wall 700): the plugin stamps it 300 ms before base + scenario.
        const log = [
            `${stamp(700 + offset)} [eidnara][s-1] rust pass: decision=error reason=none served_from=raw`,
        ];
        const [r] = recoveries(run([arm(journal, log)], base));
        expect([r?.recovered, r?.turns_to_first_clean]).toEqual([true, 2]);
        const [both] = recoveries(run([arm(journal.slice(0, 4), log)], base));
        expect(both?.reasons).toEqual(["e-1: 1 fail-open publications"]);
    });

    test("a journal without clock offsets needs a finite manifest base to place stamps", () => {
        seq = 0;
        const journal = [
            entry("FaultObserved", 0, { fault: "f", type: "plugin_reload", evidence: {} }),
            entry("BeginTurn", 10, { event: "e-1" }),
            entry("EndTurn", 20, { event: "e-1", outcome: "ok" }),
        ];
        const log = [`${stamp(15)} [eidnara][s-1] rust pass: decision=error served_from=raw`];
        expect(() => recoveries(run([arm(journal, log)], Number.NaN))).toThrow(
            "base_wall_ms is not a finite number",
        );
        const unset = { ...run([arm(journal, log)]), base_wall_ms: undefined as unknown as number };
        expect(() => recoveries(unset)).toThrow("base_wall_ms is not a finite number");
    });

    test("a legacy crash check and a digest-bearing post-crash check compare by bounds", () => {
        seq = 0;
        const legacy = { ...store("ok"), ranges: [["s", 1, 0, 9]] } as unknown as StoreCheck;
        const journal = [
            entry("FaultObserved", 0, {
                fault: "k",
                type: "daemon_restart",
                evidence: { store: legacy },
            }),
            entry("BeginTurn", 10, { event: "e-1" }),
            entry("EndTurn", 20, { event: "e-1", outcome: "ok" }),
            entry("StoreChecked", 20, { event: "e-1", fault: "k", store: store("ok") }),
        ];
        const [r] = recoveries(run([arm(journal, [], store("ok"))]));
        expect(r?.reasons).toEqual(["store ranges lack content digests"]);
    });

    test("a journal entry without a finite wall time cannot anchor a window", () => {
        seq = 0;
        const base = 1_000_000_000;
        const journal = [
            entry("ClockOffset", 0, { wall_ms: 600, offset_s: (base - 1_000) / 1000 }),
            entry("FaultObserved", 0, {
                wall_ms: 620,
                fault: "f",
                type: "plugin_reload",
                evidence: {},
            }),
            entry("BeginTurn", 0, { wall_ms: undefined, event: "e-1" }),
            entry("EndTurn", 9_000, { wall_ms: 9_650, event: "e-1", outcome: "ok" }),
        ];
        expect(() => recoveries(run([arm(journal)], base))).toThrow("wall_ms");
    });

    test("a journal whose turns began before its first clock offset is refused", () => {
        seq = 0;
        const base = 1_000_000_000;
        const journal = [
            entry(
                "FaultObserved",
                0,
                wall(100, { fault: "f", type: "plugin_reload", evidence: {} }),
            ),
            entry("BeginTurn", 0, wall(200, { event: "e-1" })),
            entry("EndTurn", 1_000, wall(1_200, { event: "e-1", outcome: "ok" })),
            entry("ClockOffset", 1_000, wall(5_000, { offset_s: (base - 4_000) / 1000 })),
            entry("BeginTurn", 1_000, wall(5_100, { event: "e-2" })),
            entry("EndTurn", 2_000, wall(6_100, { event: "e-2", outcome: "ok" })),
        ];
        const log = [
            `${stamp(base + 500)} [eidnara][s-1] rust pass: decision=error served_from=raw`,
        ];
        expect(() => recoveries(run([arm(journal, log)], base))).toThrow(
            "eidnara: clock journal mixes",
        );
    });
});
