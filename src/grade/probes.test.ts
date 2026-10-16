import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProbeItem } from "../scenario/compile";
import { loadPrereg } from "../scenario/inputs";
import { type CallView, GradeRefused, type Snapshot } from "./artefacts";
import { deltaMem, GradeLog, type GradeRecord, gradeItem } from "./probes";

const DIR = join(import.meta.dir, "../../tests/fixtures/grade");
const rules = loadPrereg("S").grading;

interface Fixture {
    probe: ProbeItem;
    snapshots: Snapshot[];
    expect: {
        verdict: string;
        reason?: string;
        metrics: GradeRecord["metrics"];
        inputs: string[];
    };
}
const fixtures = readdirSync(DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("P7-"))
    .map((f) => [f, JSON.parse(readFileSync(join(DIR, f), "utf8")) as Fixture] as const);
const fixture = (name: string) => fixtures.find(([f]) => f === `${name}.json`)?.[1] as Fixture;
const grade = (name: string, r = rules) =>
    gradeItem(fixture(name).probe, fixture(name).snapshots, r) as GradeRecord;

describe("recorded fixtures", () => {
    test("every programmatic probe type has a known pass and a known fail", () => {
        const names = new Set(fixtures.map(([f]) => f.replace(".json", "")));
        for (const n of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14]) {
            expect([names.has(`P${n}-pass`), names.has(`P${n}-fail`)]).toEqual([true, true]);
        }
    });

    for (const [file, f] of fixtures) {
        test(`${file} grades as recorded and lists the artefacts it read`, () => {
            const g = gradeItem(f.probe, f.snapshots, rules) as GradeRecord;
            expect(g.verdict).toBe(f.expect.verdict as GradeRecord["verdict"]);
            expect(g.reason).toBe(f.expect.reason);
            expect(g.metrics).toEqual(f.expect.metrics);
            expect(f.expect.inputs.length).toBeGreaterThan(0);
            expect(g.inputs).toEqual(f.expect.inputs);
            const ids = new Set((f.snapshots[0] as Snapshot).artefacts.map((a) => a.id));
            for (const id of g.inputs) expect(ids.has(id)).toBe(true);
            expect(g.snapshot).toBe((f.snapshots[0] as Snapshot).id);
        });
    }
});

describe("grading harness", () => {
    test("a snapshot carrying a transcript artefact is refused", () => {
        const f = fixture("P8-pass");
        const leak = structuredClone(f.snapshots[0]) as Snapshot;
        (leak.artefacts as unknown[]).push({ id: "t1", class: "transcript", messages: [] });
        expect(() => gradeItem(f.probe, [leak], rules)).toThrow(GradeRefused);
        expect(() => gradeItem(f.probe, [leak], rules)).toThrow(
            "class transcript is not a grade input",
        );
    });

    test("only the first attempt is graded; later snapshots are counted", () => {
        const pass = fixture("P8-pass");
        const later = { ...(fixture("P8-fail").snapshots[0] as Snapshot), item: pass.probe.id };
        const first = pass.snapshots[0] as Snapshot;
        const g = gradeItem(pass.probe, [first, later], rules) as GradeRecord;
        expect([g.verdict, g.later_attempts_logged]).toEqual(["pass", 1]);
        expect(gradeItem(pass.probe, [later, first], rules)?.verdict).toBe("fail");
    });

    test("a probe turn that failed has no grade", () => {
        const f = fixture("P12-pass");
        const failed = { ...(f.snapshots[0] as Snapshot), turn_outcome: "failed" as const };
        expect(gradeItem(f.probe, [failed], rules)).toBeNull();
    });

    test("each grade lists exactly the artefacts its grader read", () => {
        expect(grade("P8-pass").inputs).toEqual(["p1"]);
        expect(grade("P6-fail").inputs).toEqual(["c1", "d1", "p1", "prior"]);
        expect(grade("P2-pass").inputs).toEqual(["d1"]);
    });

    test("an item whose check lacks a key its grader needs is refused", () => {
        const f = fixture("P12-pass");
        expect(() => gradeItem({ ...f.probe, check: {} }, f.snapshots, rules)).toThrow(
            "has no check.must",
        );
        const p13 = fixture("P13-pass");
        const bare = { ...p13.probe, check: { turns: [0, 30] } };
        expect(() => gradeItem(bare, p13.snapshots, rules)).toThrow("neither check.must");
    });

    test("P11 scores a hit +1 and a false-positive injection minus the pre-registered weight", () => {
        expect(rules.p11_false_positive_weight).toBe("2");
        expect(grade("P11-fail").metrics["P11.weighted_score"]).toBe(-2);
        expect(grade("P11-fail").metrics["P11.harm"]).toBe(true);
        expect(grade("P11-pass").metrics["P11.weighted_score"]).toBe(1);
        const heavier = { ...rules, p11_false_positive_weight: "3" };
        expect(grade("P11-fail", heavier).metrics["P11.weighted_score"]).toBe(-3);
    });

    test("P1 and its control are paired by fact under separate metrics", () => {
        const a = grade("P1-pass");
        const b = grade("P1-control-fail");
        expect([a.pair, b.pair]).toEqual(["f-0012", "f-0012"]);
        expect(b.metrics["P1-control.pass"]).toBe(false);
        expect(b.metrics["P1.pass"]).toBeUndefined();
    });

    test("delta-mem is the paired P3 pass-rate difference over items both arms graded", () => {
        const pass = grade("P3-pass");
        const fail = grade("P3-fail");
        const host = (g: GradeRecord, item: string) => ({ ...g, item, arm: "host" });
        const grades = [
            { ...pass, item: "i1" },
            host(fail, "i1"),
            { ...pass, item: "i2" },
            host(pass, "i2"),
            { ...pass, item: "only-eidnara" },
        ];
        expect(deltaMem(grades)).toEqual({ delta: 0.5, n: 2 });
        expect(deltaMem([pass])).toBeNull();
    });

    test("a snapshot lacking an artefact its grader needs is refused, not graded as empty evidence", () => {
        const f = fixture("P2-pass");
        const bare = { ...(f.snapshots[0] as Snapshot), artefacts: [] };
        expect(() => gradeItem(f.probe, [bare], rules)).toThrow(GradeRefused);
        expect(() => gradeItem(f.probe, [bare], rules)).toThrow("has no turn diff artefact");
        const p10 = fixture("P10-pass");
        const noCalls = {
            ...(p10.snapshots[0] as Snapshot),
            artefacts: (p10.snapshots[0] as Snapshot).artefacts.filter(
                (a) => a.class !== "proxy-call",
            ),
        };
        expect(() => gradeItem(p10.probe, [noCalls], rules)).toThrow("has no proxy-call artefact");
    });

    test("P10 grades a literal anchor case-insensitively", () => {
        const f = fixture("P10-pass");
        const probe = { ...f.probe, check: { must_not: ["xeric-magpie-81"] } };
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        (calls.calls[0] as { response_text: string }).response_text =
            "The quarter is code-named XERIC-MAGPIE-81.";
        const g = gradeItem(probe, [snap], rules) as GradeRecord;
        expect([g.verdict, g.metrics["P10.harm"]]).toEqual(["fail", true]);
    });

    test("P14 excludes a snapshot whose user-sim label is outside the fixed set", () => {
        const f = fixture("P14-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        const sim = calls.calls.find((c) => c.component === "user-sim" && c.label === "pushback");
        (sim as { label: string }).label = "pushbak";
        const g = gradeItem(f.probe, [snap], rules) as GradeRecord;
        expect([g.verdict, g.reason]).toEqual(["excluded", "unknown user-sim label pushbak"]);
    });

    test("P13 counts a compound command as repeated even when it opens with a quiet read", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        const cmd = "git status && sed -i 's/a/b/' src/x.rs";
        log.commands.unshift({ command: cmd, exit: 0, scenario_ms: 100 });
        log.commands.push({ command: cmd, exit: 0, scenario_ms: 900 });
        const g = gradeItem(f.probe, [snap], rules) as GradeRecord;
        expect([g.verdict, g.metrics["P13.repeated_action"]]).toEqual(["fail", true]);
    });

    test("P13 fails the ratio part when a fold's input tokens are unmeasured", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        for (const c of calls.calls) if (c.component === "history_summarizer") c.input_tokens = 0;
        const g = gradeItem(f.probe, [snap], rules) as GradeRecord;
        expect([g.verdict, g.metrics["P13.ratio_in_bounds"]]).toEqual(["fail", false]);
    });

    test("a fold call that did not complete establishes no compaction boundary", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        for (const c of calls.calls) {
            if (c.component === "history_summarizer")
                Object.assign(c, { status: 502, error: "upstream" });
        }
        const g = gradeItem(f.probe, [snap], rules) as GradeRecord;
        expect([g.verdict, g.reason]).toEqual(["excluded", "no fold in the item's range"]);
        const p14 = fixture("P14-fail");
        const s14 = structuredClone(p14.snapshots[0]) as Snapshot;
        const c14 = s14.artefacts.find((a) => a.class === "proxy-call");
        if (c14?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        for (const c of c14.calls) {
            if (c.component === "history_summarizer")
                Object.assign(c, { status: 502, error: "upstream" });
        }
        expect(gradeItem(p14.probe, [s14], rules)?.verdict).toBe("excluded");
    });

    test("a check pattern can match a changed file's path, not only its added lines", () => {
        const f = fixture("P1-pass");
        const probe = { ...f.probe, check: { must: ["\\.drowsy-egret-12\\.test\\.ts"] } };
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff" && a.role === "turn");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        diff.patch =
            "diff --git a/src/get.drowsy-egret-12.test.ts b/src/get.drowsy-egret-12.test.ts\n--- /dev/null\n+++ b/src/get.drowsy-egret-12.test.ts\n@@ -0,0 +1,1 @@\n+test('echoes body', () => {});\n";
        expect(gradeItem(probe, [snap], rules)?.verdict).toBe("pass");
    });

    test("P9 fails an abstention that hedges a guess without a value-shaped token", () => {
        const f = fixture("P9-pass-wording");
        for (const guess of [
            "I do not know, but probably Alice owns it.",
            "We never decided; probably us-east-1.",
            "I do not know. Use us-east-1.",
            "UNKNOWN\nI think eu-west-2 is the one.",
        ]) {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const calls = snap.artefacts.find((a) => a.class === "proxy-call");
            if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
            (calls.calls[0] as { response_text: string }).response_text = guess;
            expect(gradeItem(f.probe, [snap], rules)?.verdict).toBe("fail");
        }
    });

    test("a cut final grade line is dropped on read and overwritten by the next append", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const log = new GradeLog(path);
        const g = grade("P2-pass");
        log.append(g);
        appendFileSync(path, '{"item":"torn');
        expect(log.all().map((x) => x.version)).toEqual([1]);
        log.append({ ...g, version: 2 });
        expect(log.all().map((x) => x.version)).toEqual([1, 2]);
    });

    test("P9 applies the guess checks after a leading UNKNOWN line", () => {
        const f = fixture("P9-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        (calls.calls[0] as { response_text: string }).response_text =
            "UNKNOWN\nProbably Alice owns it.";
        expect(gradeItem(f.probe, [snap], rules)?.verdict).toBe("fail");
    });

    test("P14 counts only completed user-sim calls", () => {
        const f = fixture("P14-fail");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        for (const c of calls.calls) {
            if (c.component === "user-sim") Object.assign(c, { status: 503, error: "upstream" });
        }
        expect(gradeItem(f.probe, [snap], rules)?.verdict).toBe("excluded");
    });

    test("P6 recognises a package-script test command", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "bun run test", exit: 0, scenario_ms: 50 });
        const g = gradeItem(f.probe, [snap], rules) as GradeRecord;
        expect(g.metrics["P6.ran_tests"]).toBe(true);
    });

    test("every pre-registered probe family metric is emitted by its grader", () => {
        const emitted = new Set(
            fixtures
                .map(([, f]) => gradeItem(f.probe, f.snapshots, rules))
                .flatMap((g) => (g && g.verdict !== "excluded" ? Object.keys(g.metrics) : [])),
        );
        const registered = loadPrereg("S")
            .families.filter((fam) => /^probe-P(?!7$)\d+$/.test(fam.id))
            .flatMap((fam) => fam.metrics);
        expect(registered.length).toBeGreaterThan(10);
        expect(registered.filter((m) => !emitted.has(m))).toEqual([]);
    });

    test("delta-mem reads the newest version of each item and arm before filtering", () => {
        const pass = grade("P3-pass");
        const host = { ...pass, arm: "host" };
        const excluded = { ...pass, version: 2, verdict: "excluded" as const };
        expect(deltaMem([pass, excluded, host])).toBeNull();
    });

    test("a failed turn yields no grade before any grader is selected", () => {
        const f = fixture("P8-pass");
        const failed = { ...(f.snapshots[0] as Snapshot), turn_outcome: "failed" as const };
        expect(gradeItem({ ...f.probe, type: "P7" }, [failed], rules)).toBeNull();
    });

    test("the answer is the last completed agent call, and P10 reads every completed response of the turn", () => {
        const p8 = fixture("P8-pass");
        const s8 = structuredClone(p8.snapshots[0]) as Snapshot;
        const c8 = s8.artefacts.find((a) => a.class === "proxy-call");
        if (c8?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        const last = c8.calls.at(-1) as CallView;
        c8.calls.push({
            ...last,
            seq: last.seq + 1,
            status: 502,
            error: "upstream",
            response_text: undefined,
        });
        expect(gradeItem(p8.probe, [s8], rules)?.verdict).toBe("pass");

        const p10 = fixture("P10-pass");
        const s10 = structuredClone(p10.snapshots[0]) as Snapshot;
        const c10 = s10.artefacts.find((a) => a.class === "proxy-call");
        if (c10?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        const final = c10.calls[0] as CallView;
        c10.calls.unshift({
            ...final,
            seq: 0,
            response_text: "Draft: the port is 80095, let me check.",
        });
        const g = gradeItem(p10.probe, [s10], rules) as GradeRecord;
        expect([g.verdict, g.metrics["P10.harm"]]).toEqual(["fail", true]);
    });

    test("P4 refuses a scope outside in/out and names both halves of a double failure", () => {
        const f = fixture("P4-fail-in-scope");
        const check = f.probe.check as { must: string[]; must_not: string[]; scope: string };
        expect(() =>
            gradeItem({ ...f.probe, check: { ...check, scope: "sideways" } }, f.snapshots, rules),
        ).toThrow("check.scope");
        const both = { ...f.probe, check: { ...check, must: ["never-present-\\d{9}"] } };
        expect(gradeItem(both, f.snapshots, rules)?.reason).toBe(
            "missing the expected rule; kept the superseded rule",
        );
    });

    test("P6 counts a re-read only when a read segment names the prior-session path as a whole", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push(
            { command: "cat README.md; git diff src/connection.rs", exit: 0, scenario_ms: 10 },
            { command: "cat src/connection.rs.bak", exit: 0, scenario_ms: 20 },
        );
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(0);
        log.commands.push({
            command: "cargo build && cat src/connection.rs",
            exit: 0,
            scenario_ms: 30,
        });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
    });

    test("every snapshot is artefacts-only, and a turn outcome outside the contract is refused", () => {
        const f = fixture("P8-pass");
        const first = f.snapshots[0] as Snapshot;
        const leak = structuredClone(first);
        (leak.artefacts as unknown[]).push({ id: "t1", class: "transcript", messages: [] });
        expect(() => gradeItem(f.probe, [first, leak], rules)).toThrow("class transcript");
        const odd = { ...first, turn_outcome: "failed(interrupted)" as never };
        expect(() => gradeItem(f.probe, [odd], rules)).toThrow("turn_outcome");
    });

    test("a grade log line that parses but is not a grade record is refused", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const log = new GradeLog(path);
        log.append(grade("P2-pass"));
        appendFileSync(path, '{"item":"x","arm":"host"}\n');
        expect(() => log.all()).toThrow(GradeRefused);
        expect(() => log.all()).toThrow("line 2 is not a grade record");
        appendFileSync(path, "null\n");
        expect(() => log.all()).toThrow("line 2 is not a grade record");
    });

    test("a P13 item with an empty rule list is refused", () => {
        const f = fixture("P13-pass");
        const check = f.probe.check as { turns: [number, number] };
        for (const empty of [{ commands_must: [] }, { must: [] }]) {
            const probe = { ...f.probe, check: { turns: check.turns, ...empty } };
            expect(() => gradeItem(probe, f.snapshots, rules)).toThrow(GradeRefused);
        }
    });

    test("a snapshot with a malformed artefact payload or no id is refused", () => {
        const p5 = fixture("P5-fail-in-commands");
        const s5 = structuredClone(p5.snapshots[0]) as Snapshot;
        const log = s5.artefacts.find((a) => a.class === "command-log");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        delete (log.commands[1] as { command?: string }).command;
        expect(() => gradeItem(p5.probe, [s5], rules)).toThrow("commands[1].command");
        const p14 = fixture("P14-pass");
        const s14 = structuredClone(p14.snapshots[0]) as Snapshot;
        const calls = s14.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        (calls.calls[0] as { status: unknown }).status = "200";
        expect(() => gradeItem(p14.probe, [s14], rules)).toThrow("calls[0].status");
        const p8 = fixture("P8-pass");
        const noId = { ...(p8.snapshots[0] as Snapshot), id: "" };
        expect(() => gradeItem(p8.probe, [noId], rules)).toThrow(
            "snapshot.id is missing or malformed",
        );
    });

    test("a P13 command rule keeps its case-insensitive prefix when anchored", () => {
        const f = fixture("P13-pass");
        const check = f.probe.check as { turns: [number, number]; commands_must: string[] };
        const upper = check.commands_must.map((p) => `(?i)${p.toUpperCase()}`);
        const probe = { ...f.probe, check: { ...check, commands_must: upper } };
        expect(gradeItem(probe, f.snapshots, rules)?.metrics["P13.rule_kept"]).toBe(true);
    });

    test("a shell segment on an unestablished conditional branch does not count as executed", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push(
            { command: "true || npm run test", exit: 0, scenario_ms: 10 },
            { command: "false && cargo test", exit: 1, scenario_ms: 20 },
            { command: "cd crate && cargo test", exit: 101, scenario_ms: 30 },
        );
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(false);
        log.commands.push({ command: "cd crate && cargo test", exit: 0, scenario_ms: 40 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(true);
    });

    test("a file the prior session deleted counts among its changed paths", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const prior = snap.artefacts.find((a) => a.class === "diff" && a.role === "prior-session");
        if (prior?.class !== "diff") throw new Error("fixture lacks prior diff");
        prior.patch =
            "diff --git a/src/old.rs b/src/old.rs\ndeleted file mode 100644\n--- a/src/old.rs\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-fn old() {}\n";
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "cat src/old.rs", exit: 1, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
    });

    test("two artefacts sharing an id are refused", () => {
        const f = fixture("P5-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        for (const a of snap.artefacts) a.id = "same";
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("artefact id same twice");
    });

    test("a P13 command rule matches the invoked command, not a quoted mention", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        const commit = log.commands.find((c) => c.command.startsWith("git commit"));
        if (!commit) throw new Error("fixture lacks the commit");
        commit.command = `echo "${commit.command}"`;
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.rule_kept"]).toBe(false);
        commit.command = `cd repo && ${commit.command.slice(6, -1)}`;
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.rule_kept"]).toBe(true);
    });

    test("P6 counts a re-read only when the read command is the segment's command", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "echo 'cat ./src/connection.rs'", exit: 0, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(0);
        log.commands.push({ command: "cat src/connection.rs | head", exit: 0, scenario_ms: 20 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
    });

    test("a grade record without its inputs list is refused", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const log = new GradeLog(path);
        const { inputs: _inputs, ...bare } = grade("P2-pass");
        appendFileSync(path, `${JSON.stringify(bare)}\n`);
        expect(() => log.all()).toThrow("line 1 is not a grade record");
    });

    test("an artefact without a nonempty string id is refused", () => {
        const f = fixture("P2-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        delete (snap.artefacts[0] as { id?: string }).id;
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("artefact without an id");
    });

    test("P6 recognises a ./-prefixed spelling of a prior-session path", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "cat ./src/connection.rs", exit: 0, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
    });

    test("an added source line that begins with two plus signs is graded content, and headers are not", () => {
        const f = fixture("P2-pass");
        const probe = { ...f.probe, check: { must_not: ["^\\+\\+counter;"] } };
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        diff.patch =
            "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,0 +1,1 @@\n+++counter;\n";
        const g = gradeItem(probe, [snap], rules) as GradeRecord;
        expect([g.verdict, g.metrics["P2.harm"]]).toEqual(["fail", true]);
        const header = { ...f.probe, check: { must_not: ["^b/src/x\\.ts$", "^\\+\\+ b/"] } };
        expect(gradeItem(header, [snap], rules)?.verdict).toBe("pass");
    });

    test("two grade records with one item, arm, and version are refused on read", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const log = new GradeLog(path);
        const g = grade("P2-pass");
        appendFileSync(
            path,
            `${JSON.stringify(g)}\n${JSON.stringify({ ...g, verdict: "fail" })}\n`,
        );
        expect(() => log.all()).toThrow("line 2 repeats version 1");
    });

    test("P6 counts a test run only when a shell segment starts with the test command", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push(
            { command: 'echo "cargo test"', exit: 0, scenario_ms: 10 },
            { command: "rg 'bun test' package.json", exit: 0, scenario_ms: 20 },
        );
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(false);
        log.commands.push({ command: "cd crate && cargo test --lib", exit: 0, scenario_ms: 30 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(true);
    });

    test("an answer grader refuses a turn with no completed agent response", () => {
        const f = fixture("P10-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        for (const c of calls.calls) Object.assign(c, { status: 502, error: "upstream" });
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("no completed agent response");
        const p8 = fixture("P8-pass");
        const s8 = structuredClone(p8.snapshots[0]) as Snapshot;
        const c8 = s8.artefacts.find((a) => a.class === "proxy-call");
        if (c8?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        for (const c of c8.calls) delete c.response_text;
        expect(() => gradeItem(p8.probe, [s8], rules)).toThrow("no completed agent response");
    });

    test("a snapshot of another turn than the probe's event is refused", () => {
        const f = fixture("P8-pass");
        const other = { ...(f.snapshots[0] as Snapshot), turn: "e-2" };
        expect(() => gradeItem(f.probe, [other], rules)).toThrow("turn e-2");
    });

    test("two artefacts of one class and role are refused as ambiguous", () => {
        const f = fixture("P2-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        snap.artefacts.push({ ...diff, id: "d2", patch: "+++ b/x\n@@\n+use crate::ALPHA_RULE;\n" });
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("two turn diff artefacts");
    });

    test("P13 treats a repeated test command as quiet, in every package-script form", () => {
        const f = fixture("P13-pass");
        for (const cmd of ["bun run test", "npm test", "pnpm run test", "cargo test"]) {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const log = snap.artefacts.find((a) => a.class === "command-log");
            if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
            log.commands.unshift({ command: cmd, exit: 0, scenario_ms: 100 });
            log.commands.push({ command: cmd, exit: 0, scenario_ms: 900 });
            expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.repeated_action"]).toBe(false);
        }
    });

    test("P14 orders a pushback against the fold by call sequence, not by equal millisecond", () => {
        const f = fixture("P14-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        const fold = calls.calls.find((c) => c.component === "history_summarizer") as CallView;
        calls.calls.push({
            ...fold,
            component: "user-sim",
            seq: fold.seq - 1,
            label: "pushback",
            turn_index: 5,
        });
        expect(gradeItem(f.probe, [snap], rules)?.verdict).toBe("pass");
    });

    test("P14 is excluded when no completed labelled user-sim turn follows the fold inside the window", () => {
        const f = fixture("P14-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        for (const c of calls.calls) {
            if (c.component === "user-sim" && c.scenario_ms > 500)
                Object.assign(c, { status: 503, error: "upstream" });
        }
        const g = gradeItem(f.probe, [snap], rules) as GradeRecord;
        expect([g.verdict, g.reason]).toEqual([
            "excluded",
            "no user-sim turn after compaction in the window",
        ]);
    });

    test("grade versions for one item and arm strictly increase; an out-of-order version is refused", () => {
        const log = new GradeLog(join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl"));
        const g = grade("P2-pass");
        log.append(g);
        expect(() => log.append(g)).toThrow("expected v2");
        log.append({ ...g, version: log.nextVersion(g.item, g.arm) });
        expect(log.all().map((x) => x.version)).toEqual([1, 2]);
        expect(log.latest().map((x) => x.version)).toEqual([2]);
    });
});
