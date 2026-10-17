import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkStore, type StoreCheck } from "../hosts/storecheck";
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
const SEGMENT: StoreCheck["ranges"][number] = ["s", 1, 0, 9];
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

    test("the recorded mid-fold SIGKILLs recover, the first after the fail-open in the turn it cut", () => {
        const got = recoveries(run(sigkills.arms, sigkills.base_wall_ms));
        const byFault = Object.fromEntries(
            got.map((r) => [r.fault, [r.turns_to_first_clean, r.recovered]]),
        );
        expect(byFault).toEqual(sigkills.expect);
        const passed = { after_restart: "ok", post_crash_pass: "ok", final: "ok" };
        expect(got.map((r) => r.store)).toEqual([passed, passed, passed]);
        const lost = structuredClone(sigkills.arms);
        const arm0 = lost[0] as ArmLogs;
        for (const e of arm0.journal.filter((x) => x.kind === "StoreChecked")) {
            (e.store as StoreCheck).ranges = [];
        }
        const broken = recoveries(run(lost, sigkills.base_wall_ms));
        expect(broken.map((r) => r.recovered)).toEqual([false, false, false]);
        expect(broken[0]?.reasons).toEqual([
            "post-crash pass removed or changed segments sim-s-0003/1/1/4",
        ]);
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
            run([arm(journal(ok, store("ok", 0, [SEGMENT, ["s", 2, 10, 19]])), [], ok)]),
        );
        expect(clean?.recovered).toBe(true);
        expect(clean?.store).toEqual({ after_restart: "ok", post_crash_pass: "ok", final: "ok" });
        expect(verdict(store("*** corrupt"), ok, ok)).toEqual([
            false,
            ["store integrity, after restart: *** corrupt"],
        ]);
        expect(verdict(ok, ok, store("error: file is not a database"))).toEqual([
            false,
            ["store integrity, final: error: file is not a database"],
        ]);
        expect(verdict(ok, store("ok", 1), ok)).toEqual([
            false,
            ["1 overlapping history segments, post crash pass"],
        ]);
        expect(verdict(ok, store("ok", 0, [["s", 1, 0, 12]]), ok)).toEqual([
            false,
            ["post-crash pass removed or changed segments s/1/0/9"],
        ]);
        expect(verdict(undefined, ok, ok)).toEqual([false, ["store unchecked: after restart"]]);
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

    test("a second client whose own turn failed is not a recovered fault, however clean the later turns", () => {
        seq = 0;
        const journal = (outcome: string) => [
            entry("FaultObserved", 0, {
                fault: "b",
                type: "two_hosts_one_daemon",
                evidence: { second_session: "s-1-b", outcome },
            }),
            entry("BeginTurn", 10, { event: "e-1" }),
            entry("EndTurn", 20, { event: "e-1", outcome: "ok" }),
        ];
        const [failed] = recoveries(run([arm(journal("timed out after 600000 ms"))]));
        expect([failed?.recovered, failed?.turns_to_first_clean]).toEqual([false, 1]);
        expect(failed?.reasons).toEqual(["the fault's own turn ended timed out after 600000 ms"]);
        const [ok] = recoveries(run([arm(journal("ok"))]));
        expect([ok?.recovered, ok?.reasons]).toEqual([true, []]);
    });

    test("the store check reports integrity and overlapping history segments", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-store-")), "store.db");
        const db = new Database(path);
        db.run(
            "create table history_segments (session_id text, sequence integer, start_message integer, end_message integer)",
        );
        db.run(
            "insert into history_segments values ('s', 1, 0, 9), ('s', 2, 10, 19), ('t', 1, 0, 5)",
        );
        db.close();
        expect(checkStore(path)).toEqual({
            integrity: "ok",
            segments: 3,
            overlaps: [],
            ranges: [
                ["s", 1, 0, 9],
                ["s", 2, 10, 19],
                ["t", 1, 0, 5],
            ],
        });
        const again = new Database(path);
        again.run("insert into history_segments values ('s', 3, 15, 25)");
        again.close();
        expect(checkStore(path).overlaps).toEqual([{ session: "s", first: 2, second: 3 }]);
        expect(checkStore(join(path, "missing")).integrity).toBe("missing");
        const nested = new Database(path);
        nested.run("delete from history_segments");
        nested.run(
            "insert into history_segments values ('s', 1, 0, 30), ('s', 2, 5, 10), ('s', 3, 15, 20)",
        );
        nested.close();
        expect(checkStore(path).overlaps).toEqual([
            { session: "s", first: 1, second: 2 },
            { session: "s", first: 1, second: 3 },
        ]);
        const junk = join(dirname(path), "junk.db");
        writeFileSync(junk, "not sqlite at all, padded past the header length of a database file");
        expect(checkStore(junk).integrity).toStartWith("error: ");
    });
});
