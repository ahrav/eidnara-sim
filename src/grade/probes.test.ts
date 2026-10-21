import { describe, expect, test } from "bun:test";
import {
    appendFileSync,
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    truncateSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileScenario, type ProbeItem } from "../scenario/compile";
import { loadCompileInput, loadPrereg } from "../scenario/inputs";
import { hashEmbedder } from "../scenario/similarity";
import { type CallView, type Command, GradeRefused, type Snapshot } from "./artefacts";
import { deltaMem, GradeLog, type GradeRecord, gradeItem, graderDigest, graderFor } from "./probes";

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
/** A copy of the snapshot moved to another session, its proxy calls included. */
const retagged = (snapshot: Snapshot, session: string): Snapshot => {
    const copy = structuredClone(snapshot);
    copy.session = session;
    for (const a of copy.artefacts)
        if (a.class === "proxy-call") for (const c of a.calls) c.session = session;
    return copy;
};
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
            "P12 item P12-a names no rule to hold",
        );
        const p13 = fixture("P13-pass");
        const bare = { ...p13.probe, check: { turns: [0, 30] } };
        expect(() => gradeItem(bare, p13.snapshots, rules)).toThrow("names no rule to hold");
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
        expect(() => gradeItem(f.probe, [bare], rules)).toThrow(
            "lacks the diff (turn) artefact P2 reads",
        );
        const p10 = fixture("P10-pass");
        const noCalls = {
            ...(p10.snapshots[0] as Snapshot),
            artefacts: (p10.snapshots[0] as Snapshot).artefacts.filter(
                (a) => a.class !== "proxy-call",
            ),
        };
        expect(() => gradeItem(p10.probe, [noCalls], rules)).toThrow(
            "lacks the proxy-call artefact P10 reads",
        );
    });

    test("P10 grades a literal anchor case-insensitively", () => {
        const f = fixture("P10-pass");
        const probe = {
            ...f.probe,
            check: { must_not: ["xeric-magpie-81"], answer_must_not: "xeric-magpie-81" },
        };
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

    test("P9 passes an answer that says nobody was named, and fails one that names a value", () => {
        const f = fixture("P9-pass-wording");
        const graded = (answer: string) => {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const calls = snap.artefacts.find((a) => a.class === "proxy-call");
            if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
            (calls.calls[0] as { response_text: string }).response_text = answer;
            return gradeItem(f.probe, [snap], rules)?.verdict;
        };
        for (const answer of [
            "Nobody has been named owner of the release checklist yet.",
            "No one is named as the owner of these steps anywhere in this repo.",
            "The repo doesn't name an owner for these steps.",
        ]) {
            expect(graded(answer)).toBe("pass");
        }
        expect(graded("Nobody was named, so it is nimble-quokka-44.")).toBe("fail");
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

    test("the answer is the last completed agent call of the turn", () => {
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
        const leak = { ...structuredClone(first), id: `${first.id}-retry` };
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

    test("a proxy call with a component outside the protocol's set is refused", () => {
        const f = fixture("P14-fail");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        const sim = calls.calls.find((c) => c.component === "user-sim") as CallView;
        sim.component = "usersim";
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("component");
    });

    test("a shell operator inside quotes does not split a segment", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push(
            { command: 'echo "nothing && cargo test"', exit: 0, scenario_ms: 10 },
            { command: "echo 'a; cat src/connection.rs'", exit: 0, scenario_ms: 20 },
        );
        const g = gradeItem(f.probe, [snap], rules) as GradeRecord;
        expect([g.metrics["P6.ran_tests"], g.metrics["P6.reread_files"]]).toEqual([false, 0]);
    });

    test("a grade record with malformed metrics or attempt count is refused", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const log = new GradeLog(path);
        const g = grade("P2-pass");
        const { later_attempts_logged: _n, ...noCount } = g;
        for (const bad of [{ ...g, metrics: [] }, { ...g, metrics: { x: {} } }, noCount]) {
            appendFileSync(path, `${JSON.stringify(bad)}\n`);
            expect(() => log.all()).toThrow("is not a grade record");
            appendFileSync(path, "");
            truncateSync(path, 0);
        }
    });

    test("a check with an empty pattern or answer is refused before grading", () => {
        const p1 = fixture("P1-fail");
        expect(() =>
            gradeItem({ ...p1.probe, check: { must: [""] } }, p1.snapshots, rules),
        ).toThrow("check.must");
        const p8 = fixture("P8-fail");
        expect(() =>
            gradeItem({ ...p8.probe, check: { answer: "" } }, p8.snapshots, rules),
        ).toThrow("check.answer");
        const p14 = fixture("P14-pass");
        expect(() =>
            gradeItem({ ...p14.probe, check: { window_from_turn: "4" } }, p14.snapshots, rules),
        ).toThrow("check.window_from_turn");
    });

    test("a snapshot from another session than the probe's is refused", () => {
        const f = fixture("P14-pass");
        const other = retagged(f.snapshots[0] as Snapshot, "s-9");
        expect(() => gradeItem(f.probe, [other], rules)).toThrow("session s-9");
        const failed = { ...other, turn_outcome: "failed" as const };
        expect(() => gradeItem(f.probe, [failed], rules)).toThrow("session s-9");
        const p8 = fixture("P8-pass");
        const wrongTurn = {
            ...(p8.snapshots[0] as Snapshot),
            turn: "e-2",
            turn_outcome: "failed" as const,
        };
        expect(() => gradeItem(p8.probe, [wrongTurn], rules)).toThrow("turn e-2");
    });

    test("an && segment counts as executed only when the exit code is its own", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "false && cargo test; true", exit: 0, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(false);
        log.commands.push({ command: "true; cd crate && cargo test", exit: 0, scenario_ms: 20 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(true);
    });

    test("P10 applies answer_must_not to the final response only", () => {
        const f = fixture("P10-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        const final = calls.calls[0] as CallView;
        calls.calls.unshift({ ...final, seq: final.seq - 1, response_text: "Draft: port 80095." });
        expect(gradeItem(f.probe, [snap], rules)?.verdict).toBe("pass");
    });

    test("a numeric heredoc delimiter suppresses its body", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "cat <<123\ncargo test\n123", exit: 0, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(false);
    });

    test("an HTTP status is an integer", () => {
        const f = fixture("P8-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        (calls.calls[0] as CallView).status = 200.5;
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("calls[0].status");
    });

    test("a grade log behind a link is refused before any write", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-grades-"));
        const target = join(dir, "elsewhere.jsonl");
        writeFileSync(target, "");
        const linked = join(dir, "grades.jsonl");
        symlinkSync(target, linked);
        expect(() => new GradeLog(linked).append(grade("P2-pass"))).toThrow("is a link");
        expect(readFileSync(target, "utf8")).toBe("");
    });

    test("scenario timestamps are non-negative", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        (calls.calls[0] as CallView).scenario_ms = -1;
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("calls[0].scenario_ms");
        const log = structuredClone(f.snapshots[0]) as Snapshot;
        const cl = log.artefacts.find((a) => a.class === "command-log");
        if (cl?.class !== "command-log") throw new Error("fixture lacks command-log");
        (cl.commands[0] as Command).scenario_ms = -5;
        expect(() => gradeItem(f.probe, [log], rules)).toThrow("commands[0].scenario_ms");
    });

    test("a here-string is a redirection, not a heredoc", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "cat <<<foo\ncargo test", exit: 0, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(true);
    });

    test("a regrade keeps the item's snapshot, probe type, and pair", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const log = new GradeLog(path);
        const g = grade("P1-pass");
        log.append(g);
        expect(() => log.append({ ...g, version: 2, snapshot: "other-snapshot" })).toThrow(
            "snapshot",
        );
        appendFileSync(path, `${JSON.stringify({ ...g, version: 2, pair: "f-9999" })}\n`);
        expect(() => log.all()).toThrow("line 2 changes pair");
    });

    test("a positive diff check matches surviving paths only", () => {
        const f = fixture("P1-pass");
        const probe = { ...f.probe, check: { must: ["\\.drowsy-egret-12\\.test\\.ts"] } };
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff" && a.role === "turn");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        diff.patch =
            "diff --git a/src/get.drowsy-egret-12.test.ts b/src/get.drowsy-egret-12.test.ts\ndeleted file mode 100644\n--- a/src/get.drowsy-egret-12.test.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-test('x', () => {});\n";
        expect(gradeItem(probe, [snap], rules)?.verdict).toBe("fail");
    });

    test("a path in grep's pattern position is not a re-read", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({
            command: "grep src/connection.rs /dev/null",
            exit: 1,
            scenario_ms: 10,
        });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(0);
        log.commands.push({ command: "grep -n fn src/connection.rs", exit: 0, scenario_ms: 20 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
    });

    test("a repeated package install is quiet", () => {
        const f = fixture("P13-pass");
        for (const cmd of ["npm install", "pnpm install", "npm ci", "bun i"]) {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const log = snap.artefacts.find((a) => a.class === "command-log");
            if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
            log.commands.unshift({ command: cmd, exit: 0, scenario_ms: 100 });
            log.commands.push({ command: cmd, exit: 0, scenario_ms: 900 });
            expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.repeated_action"]).toBe(false);
        }
    });

    test("a guarded pipeline is skipped as a whole", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "false && echo x | cargo test", exit: 1, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(false);
        log.commands.push({ command: "echo x | cargo test", exit: 0, scenario_ms: 20 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(true);
    });

    test("a grep pattern given by option leaves the file operand in place", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        for (const cmd of [
            "grep -efoo src/connection.rs",
            "grep --regexp=foo src/connection.rs",
            "grep -e foo src/connection.rs",
            "rg -f patterns.txt src/connection.rs",
        ]) {
            log.commands.length = 1;
            log.commands.push({ command: cmd, exit: 0, scenario_ms: 10 });
            expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
        }
    });

    test("a P13 command rule matches at the start of the segment, not at an inner line", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        const commit = log.commands.find((c) => c.command.startsWith("git commit")) as Command;
        commit.command = `printf 'note\n${commit.command}'`;
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.rule_kept"]).toBe(false);
    });

    test("leading shell assignments do not hide the command word", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.unshift({ command: "CI=1 bun test", exit: 0, scenario_ms: 100 });
        log.commands.push({ command: "CI=1 bun test", exit: 0, scenario_ms: 900 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.repeated_action"]).toBe(false);
        const p6 = fixture("P6-pass");
        const s6 = structuredClone(p6.snapshots[0]) as Snapshot;
        const l6 = s6.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (l6?.class !== "command-log") throw new Error("fixture lacks command-log");
        l6.commands.push({ command: "RUST_BACKTRACE=1 cargo test", exit: 0, scenario_ms: 10 });
        expect(gradeItem(p6.probe, [s6], rules)?.metrics["P6.ran_tests"]).toBe(true);
    });

    test("a header-only rename keeps its new path among the surviving paths", () => {
        const f = fixture("P1-pass");
        const probe = { ...f.probe, check: { must: ["\\.drowsy-egret-12\\.test\\.ts"] } };
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff" && a.role === "turn");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        diff.patch =
            "diff --git a/src/get.test.ts b/src/get.drowsy-egret-12.test.ts\nsimilarity index 100%\nrename from src/get.test.ts\nrename to src/get.drowsy-egret-12.test.ts\n";
        expect(gradeItem(probe, [snap], rules)?.verdict).toBe("pass");
    });

    test("turn bounds are non-negative integers with an increasing range", () => {
        const p13 = fixture("P13-pass");
        const check = p13.probe.check as { commands_must: string[] };
        for (const turns of [
            [30, 0],
            [0, 0],
            [-1, 30],
            [0.5, 30],
        ]) {
            expect(() =>
                gradeItem({ ...p13.probe, check: { ...check, turns } }, p13.snapshots, rules),
            ).toThrow("check.turns");
        }
        const p14 = fixture("P14-pass");
        expect(() =>
            gradeItem({ ...p14.probe, check: { window_from_turn: 4.5 } }, p14.snapshots, rules),
        ).toThrow("check.window_from_turn");
    });

    test("a command exit status is an integer or null", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        (log.commands[0] as Command).exit = 0.5;
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("commands[0].exit");
    });

    test("a command without an exit status credits only its first list", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        const commit = log.commands.find((c) => c.command.startsWith("git commit")) as Command;
        commit.command = `sleep 100; ${commit.command}`;
        commit.exit = null;
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.rule_kept"]).toBe(false);
    });

    test("a null artefact entry is refused as malformed evidence", () => {
        const f = fixture("P2-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        (snap.artefacts as unknown[]).push(null);
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow(GradeRefused);
    });

    test("every proxy call belongs to the snapshot's arm and session", () => {
        const f = fixture("P8-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        (calls.calls[0] as CallView).arm = "host";
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("calls[0].arm");
    });

    test("a backslash-quoted heredoc delimiter is matched after quote removal", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({
            command: "cat <<\\EOF\ntext\nEOF\ncargo test",
            exit: 0,
            scenario_ms: 10,
        });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(true);
    });

    test("a grep option with its own operand does not shift the pattern position", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({
            command: "grep -m 1 src/connection.rs /dev/null",
            exit: 1,
            scenario_ms: 10,
        });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(0);
        log.commands.push({ command: "grep -A 2 fn src/connection.rs", exit: 0, scenario_ms: 20 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
    });

    test("P6 refuses a turn with no agent call to sum tokens over", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        calls.calls = calls.calls.filter((c) => c.component !== "agent");
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("no agent call");
    });

    test("a null later snapshot is refused as malformed evidence", () => {
        const f = fixture("P8-pass");
        const first = f.snapshots[0] as Snapshot;
        expect(() => gradeItem(f.probe, [first, null as unknown as Snapshot], rules)).toThrow(
            GradeRefused,
        );
    });

    test("a P9 check requires abstain to be true", () => {
        const f = fixture("P9-pass");
        expect(() =>
            gradeItem({ ...f.probe, check: { abstain: false } }, f.snapshots, rules),
        ).toThrow("check.abstain");
    });

    test("shell edge cases: spaced heredoc delimiter, output redirection, line continuation", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push(
            { command: "cat <<'END MARK'\ncargo test\nEND MARK", exit: 0, scenario_ms: 10 },
            { command: "head -n 1 /dev/null > src/connection.rs", exit: 0, scenario_ms: 20 },
        );
        let g = gradeItem(f.probe, [snap], rules) as GradeRecord;
        expect([g.metrics["P6.ran_tests"], g.metrics["P6.reread_files"]]).toEqual([false, 0]);
        log.commands.push(
            { command: "cargo \\\ntest", exit: 0, scenario_ms: 30 },
            { command: "cat < src/connection.rs", exit: 0, scenario_ms: 40 },
        );
        g = gradeItem(f.probe, [snap], rules) as GradeRecord;
        expect([g.metrics["P6.ran_tests"], g.metrics["P6.reread_files"]]).toEqual([true, 1]);
    });

    test("a git-quoted path is decoded before matching", () => {
        const f = fixture("P1-pass");
        const probe = {
            ...f.probe,
            check: { must: ["^src/caf\u00e9\\.drowsy-egret-12\\.test\\.ts$"] },
        };
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff" && a.role === "turn");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        diff.patch =
            'diff --git "a/src/caf\\303\\251.drowsy-egret-12.test.ts" "b/src/caf\\303\\251.drowsy-egret-12.test.ts"\n--- /dev/null\n+++ "b/src/caf\\303\\251.drowsy-egret-12.test.ts"\n@@ -0,0 +1,1 @@\n+test(\'x\', () => {});\n';
        expect(gradeItem(probe, [snap], rules)?.verdict).toBe("pass");
    });

    test("a persisted record has non-empty identities and a known probe type", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const log = new GradeLog(path);
        const g = grade("P2-pass");
        for (const bad of [
            { ...g, item: "" },
            { ...g, arm: "" },
            { ...g, snapshot: "" },
            { ...g, probe_type: "P99", metrics: { "P99.pass": true } },
        ]) {
            expect(() => log.append(bad as GradeRecord)).toThrow(GradeRefused);
        }
    });

    test("a counter beyond the safe integer range is refused", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        (calls.calls[0] as CallView).input_tokens = Number.MAX_VALUE;
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("calls[0].input_tokens");
    });

    test("the grade log is written through a no-follow descriptor", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-grades-"));
        const target = join(dir, "elsewhere.jsonl");
        writeFileSync(target, "");
        const linked = join(dir, "grades.jsonl");
        symlinkSync(target, linked);
        expect(() => new GradeLog(linked).append(grade("P2-pass"))).toThrow(GradeRefused);
        expect(readFileSync(target, "utf8")).toBe("");
        const plain = join(dir, "plain.jsonl");
        const log = new GradeLog(plain);
        log.append(grade("P2-pass"));
        expect(log.all().length).toBe(1);
    });

    test("a repeated package build is quiet", () => {
        const f = fixture("P13-pass");
        for (const cmd of ["npm run build", "pnpm run build", "bun run build"]) {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const log = snap.artefacts.find((a) => a.class === "command-log");
            if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
            log.commands.unshift({ command: cmd, exit: 0, scenario_ms: 100 });
            log.commands.push({ command: cmd, exit: 0, scenario_ms: 900 });
            expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.repeated_action"]).toBe(false);
        }
    });

    test("a quoted multiword grep pattern is one operand", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({
            command: "rg 'mentions src/connection.rs' README.md",
            exit: 1,
            scenario_ms: 10,
        });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(0);
    });

    test("a header-only deletion names no surviving path", () => {
        const f = fixture("P1-pass");
        const probe = { ...f.probe, check: { must: ["\\.drowsy-egret-12\\.test\\.ts"] } };
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff" && a.role === "turn");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        diff.patch =
            "diff --git a/src/get.drowsy-egret-12.test.ts b/src/get.drowsy-egret-12.test.ts\ndeleted file mode 100644\nindex e69de29..0000000\n";
        expect(gradeItem(probe, [snap], rules)?.verdict).toBe("fail");
    });

    test("a non-empty diff payload without unified-diff structure is refused", () => {
        const f = fixture("P2-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        diff.patch = "fatal: not a git repository";
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("patch");
        diff.patch = "";
        expect(gradeItem(f.probe, [snap], rules)?.verdict).toBe("pass");
    });

    test("an inherited object property is not a probe type", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const log = new GradeLog(path);
        const g = grade("P2-pass");
        expect(() =>
            log.append({ ...g, probe_type: "toString", metrics: { "toString.pass": true } }),
        ).toThrow(GradeRefused);
    });

    test("segments after a top-level exit are unreachable", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        const commit = log.commands.find((c) => c.command.startsWith("git commit")) as Command;
        commit.command = `exit 0; ${commit.command}`;
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.rule_kept"]).toBe(false);
    });

    test("a diff payload must be structurally a unified diff", () => {
        const f = fixture("P2-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        for (const bad of [
            "fatal: capture failed\n@@ nonsense\n",
            "diff --git a/x b/x\n+++ b/x\n@@ -1 +1 @@\n+ok\ngarbage line\n",
            "+stray added line\n",
        ]) {
            diff.patch = bad;
            expect(() => gradeItem(f.probe, [snap], rules)).toThrow("patch");
        }
        diff.patch =
            "diff --git a/x.rs b/x.rs\nindex 1..2 100644\n--- a/x.rs\n+++ b/x.rs\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n\\ No newline at end of file\n";
        expect(gradeItem(f.probe, [snap], rules)?.verdict).toBe("pass");
    });

    test("a compact input redirection is a read operand", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "cat <src/connection.rs", exit: 0, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
    });

    test("an alternation in a command rule is anchored as a whole", () => {
        const f = fixture("P13-pass");
        const check = f.probe.check as { turns: [number, number] };
        const probe = { ...f.probe, check: { ...check, commands_must: ["git commit|hg commit"] } };
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        const commit = log.commands.find((c) => c.command.startsWith("git commit")) as Command;
        commit.command = "echo hg commit";
        expect(gradeItem(probe, [snap], rules)?.metrics["P13.rule_kept"]).toBe(false);
    });

    test("a diff header has grammar and a hunk line that begins +++ is content", () => {
        const f = fixture("P2-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        diff.patch = "diff --git garbage\n";
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("patch");
        diff.patch = "diff --git a/x b/x\n";
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("patch");
        diff.patch =
            "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,0 +1,2 @@\n+++ count;\n+console.log(count);\n";
        const probe = { ...f.probe, check: { must_not: ["^\\+\\+ count;"] } };
        const g = gradeItem(probe, [snap], rules) as GradeRecord;
        expect([g.verdict, g.metrics["P2.harm"]]).toEqual(["fail", true]);
    });

    test("cargo aliases and assignment-prefixed exits are classified", () => {
        const f = fixture("P13-pass");
        for (const cmd of ["cargo t", "cargo b", "cargo c"]) {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const log = snap.artefacts.find((a) => a.class === "command-log");
            if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
            log.commands.unshift({ command: cmd, exit: 0, scenario_ms: 100 });
            log.commands.push({ command: cmd, exit: 0, scenario_ms: 900 });
            expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.repeated_action"]).toBe(false);
        }
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        const commit = log.commands.find((c) => c.command.startsWith("git commit")) as Command;
        commit.command = `X=1 exit 0; ${commit.command}`;
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.rule_kept"]).toBe(false);
        const p6 = fixture("P6-pass");
        const s6 = structuredClone(p6.snapshots[0]) as Snapshot;
        const l6 = s6.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (l6?.class !== "command-log") throw new Error("fixture lacks command-log");
        l6.commands.push({ command: "cargo t", exit: 0, scenario_ms: 10 });
        expect(gradeItem(p6.probe, [s6], rules)?.metrics["P6.ran_tests"]).toBe(true);
    });

    test("a persisted record's primary metric agrees with its verdict", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const log = new GradeLog(path);
        const g = grade("P2-pass");
        expect(() => log.append({ ...g, metrics: { "P2.harm": false } })).toThrow(GradeRefused);
        expect(() => log.append({ ...g, metrics: { ...g.metrics, "P2.pass": false } })).toThrow(
            GradeRefused,
        );
        const p13 = grade("P13-pass");
        expect(() =>
            log.append({ ...p13, metrics: { ...p13.metrics, "P13.fold_fidelity_score": 0.5 } }),
        ).toThrow(GradeRefused);
        const p14 = grade("P14-pass");
        expect(() =>
            log.append({ ...p14, metrics: { "P14.post_compaction_correction_count": 2 } }),
        ).toThrow(GradeRefused);
        log.append(g);
        expect(log.all().length).toBe(1);
    });

    test("a fold ratio counts cached input tokens", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        const fold = calls.calls.find((c) => c.component === "history_summarizer") as CallView;
        fold.input_tokens = 500;
        fold.cache_read_tokens = 19_500;
        fold.output_tokens = 2000;
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.ratio_in_bounds"]).toBe(true);
    });

    test("a quoted redirection target is one word", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const prior = snap.artefacts.find((a) => a.class === "diff" && a.role === "prior-session");
        if (prior?.class !== "diff") throw new Error("fixture lacks prior diff");
        prior.patch = "diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-a\n+b\n";
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: 'cat /dev/null > "out file"', exit: 0, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(0);
    });

    test("a plain unified-diff deletion names its old path for re-read accounting", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const prior = snap.artefacts.find((a) => a.class === "diff" && a.role === "prior-session");
        if (prior?.class !== "diff") throw new Error("fixture lacks prior diff");
        prior.patch = "--- src/old.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n";
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "cat src/old.ts", exit: 1, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
    });

    test("test-result exit codes are integers and workspace files form a map", () => {
        const f = fixture("P2-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        (snap.artefacts as unknown[]).push({
            id: "t1",
            class: "test-result",
            command: "x",
            exit: 0.5,
            summary: [],
        });
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("artefacts[1].exit");
        const ws = structuredClone(f.snapshots[0]) as Snapshot;
        (ws.artefacts as unknown[]).push({
            id: "w1",
            class: "workspace-state",
            files: ["content"],
        });
        expect(() => gradeItem(f.probe, [ws], rules)).toThrow("artefacts[1].files");
    });

    test("a git binary patch is a well-formed diff", () => {
        const f = fixture("P2-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        diff.patch =
            "diff --git a/img.png b/img.png\nindex 1111111..2222222 100644\nGIT binary patch\nliteral 12\nTcmZQzU|?i`;\n\nliteral 10\nRcmZQzU|?i`\n\n";
        expect(gradeItem(f.probe, [snap], rules)?.verdict).toBe("pass");
    });

    test("a P10 item requires its answer channel", () => {
        const f = fixture("P10-pass");
        const check = f.probe.check as { must_not: string[] };
        expect(() =>
            gradeItem({ ...f.probe, check: { must_not: check.must_not } }, f.snapshots, rules),
        ).toThrow("check.answer_must_not");
    });

    test("a hunk must carry the line counts its header declares", () => {
        const f = fixture("P2-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        diff.patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n context\n";
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("patch");
        diff.patch = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n context\n+added\n";
        expect(gradeItem(f.probe, [snap], rules)?.verdict).toBe("pass");
    });

    test("an inherited object property is not a grader", () => {
        const f = fixture("P2-pass");
        expect(() => gradeItem({ ...f.probe, type: "toString" }, f.snapshots, rules)).toThrow(
            "no programmatic grader",
        );
    });

    test("escaped spaces stay inside a shell word and sed scripts are not operands", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const prior = snap.artefacts.find((a) => a.class === "diff" && a.role === "prior-session");
        if (prior?.class !== "diff") throw new Error("fixture lacks prior diff");
        prior.patch =
            'diff --git "a/src/my file.rs" "b/src/my file.rs"\n--- "a/src/my file.rs"\n+++ "b/src/my file.rs"\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/src/connection.rs b/src/connection.rs\n--- a/src/connection.rs\n+++ b/src/connection.rs\n@@ -1 +1 @@\n-a\n+b\n';
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "cat src/my\\ file.rs", exit: 0, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
        log.commands.pop();
        log.commands.push({
            command: "sed -e 's src/connection.rs replacement' README.md",
            exit: 0,
            scenario_ms: 20,
        });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(0);
        log.commands.push({ command: "sed -n 1p src/connection.rs", exit: 0, scenario_ms: 30 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
    });

    test("a plain unified diff needs its paired header and a hunk", () => {
        const f = fixture("P2-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        for (const bad of ["--- a/x\n", "--- a/x\n+++ b/x\n", "diff --git a/x b/x\n--- a/x\n"]) {
            diff.patch = bad;
            expect(() => gradeItem(f.probe, [snap], rules)).toThrow("patch");
        }
    });

    test("a command-bearing exec ends the segment list", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        const commit = log.commands.find((c) => c.command.startsWith("git commit")) as Command;
        const original = commit.command;
        commit.command = `exec true; ${original}`;
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.rule_kept"]).toBe(false);
        commit.command = `exec >/dev/null; ${original}`;
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.rule_kept"]).toBe(true);
    });

    test("a redirection attached to an operand is split from it", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "cat src/connection.rs>/dev/null", exit: 0, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
    });

    test("a final completed call without response text refuses the grade", () => {
        const f = fixture("P10-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        const last = calls.calls.at(-1) as CallView;
        calls.calls.push({ ...last, seq: last.seq + 1, response_text: undefined });
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("no response text");
    });

    test("file metadata between paired headers or after a hunk is refused", () => {
        const f = fixture("P2-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        for (const bad of [
            "diff --git a/x b/x\n--- a/x\nindex 1..2 100644\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
            "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\nnew mode 100755\n",
        ]) {
            diff.patch = bad;
            expect(() => gradeItem(f.probe, [snap], rules)).toThrow("patch");
        }
    });

    test("read operands are compared word by word", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const prior = snap.artefacts.find((a) => a.class === "diff" && a.role === "prior-session");
        if (prior?.class !== "diff") throw new Error("fixture lacks prior diff");
        prior.patch =
            'diff --git "a/src/my file.rs" "b/src/my file.rs"\n--- "a/src/my file.rs"\n+++ "b/src/my file.rs"\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/src/my b/src/my\n--- a/src/my\n+++ b/src/my\n@@ -1 +1 @@\n-a\n+b\n';
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "cat src/my file.rs", exit: 1, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
        log.commands.pop();
        log.commands.push({ command: 'cat "src/my file.rs"', exit: 0, scenario_ms: 20 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
    });

    test("an unknown check key is refused", () => {
        const f = fixture("P13-pass");
        const check = f.probe.check as Record<string, unknown>;
        expect(() =>
            gradeItem({ ...f.probe, check: { ...check, command_must: ["x"] } }, f.snapshots, rules),
        ).toThrow("check.command_must");
    });

    test("an assignment prefix with an escaped space is one word, and NAME= stays in a file operand", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        const cmd = "RUSTFLAGS=-C\\ opt-level=3 cargo build";
        log.commands.unshift({ command: cmd, exit: 0, scenario_ms: 100 });
        log.commands.push({ command: cmd, exit: 0, scenario_ms: 900 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.repeated_action"]).toBe(false);
        const p6 = fixture("P6-pass");
        const s6 = structuredClone(p6.snapshots[0]) as Snapshot;
        const l6 = s6.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (l6?.class !== "command-log") throw new Error("fixture lacks command-log");
        l6.commands.push({ command: "cat FILE=src/connection.rs", exit: 1, scenario_ms: 10 });
        expect(gradeItem(p6.probe, [s6], rules)?.metrics["P6.reread_files"]).toBe(0);
        l6.commands.push({
            command: 'LC_ALL="en US" cat src/connection.rs',
            exit: 0,
            scenario_ms: 20,
        });
        expect(gradeItem(p6.probe, [s6], rules)?.metrics["P6.reread_files"]).toBe(1);
    });

    test("a hunk needs its paired text headers", () => {
        const f = fixture("P2-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        diff.patch = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n";
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("patch");
    });

    test("a plain multi-file diff with timestamps yields every path", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const prior = snap.artefacts.find((a) => a.class === "diff" && a.role === "prior-session");
        if (prior?.class !== "diff") throw new Error("fixture lacks prior diff");
        prior.patch =
            "--- src/old.ts\t2026-01-01 00:00:00\n+++ src/old.ts\t2026-01-02 00:00:00\n@@ -1 +1 @@\n-a\n+b\n--- src/second.ts\n+++ src/second.ts\n@@ -1 +1 @@\n-c\n+d\n";
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push(
            { command: "cat src/old.ts", exit: 0, scenario_ms: 10 },
            { command: "cat src/second.ts", exit: 0, scenario_ms: 20 },
        );
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(2);
    });

    test("a blank hunk line needs its space prefix, and operative headers win over the diff label", () => {
        const f = fixture("P2-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = snap.artefacts.find((a) => a.class === "diff");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        diff.patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n\n";
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("patch");
        const p1 = fixture("P1-pass");
        const probe = { ...p1.probe, check: { must: ["^src/expected\\.ts$"] } };
        const s1 = structuredClone(p1.snapshots[0]) as Snapshot;
        const d1 = s1.artefacts.find((a) => a.class === "diff" && a.role === "turn");
        if (d1?.class !== "diff") throw new Error("fixture lacks diff");
        d1.patch =
            "diff --git a/src/expected.ts b/src/expected.ts\n--- a/src/unrelated.ts\n+++ b/src/unrelated.ts\n@@ -1 +1 @@\n-a\n+b\n";
        expect(gradeItem(probe, [s1], rules)?.verdict).toBe("fail");
    });

    test("an exit inside a pipeline does not end the list, and rg replacements are not files", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        const commit = log.commands.find((c) => c.command.startsWith("git commit")) as Command;
        commit.command = `exit 0 | cat; ${commit.command}`;
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.rule_kept"]).toBe(true);
        const p6 = fixture("P6-pass");
        const s6 = structuredClone(p6.snapshots[0]) as Snapshot;
        const l6 = s6.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (l6?.class !== "command-log") throw new Error("fixture lacks command-log");
        l6.commands.push({
            command: "rg needle -r src/connection.rs README.md",
            exit: 1,
            scenario_ms: 10,
        });
        expect(gradeItem(p6.probe, [s6], rules)?.metrics["P6.reread_files"]).toBe(0);
    });

    test("cargo global options and toolchain selectors precede the subcommand", () => {
        const f = fixture("P13-pass");
        for (const cmd of ["cargo --quiet test", "cargo +nightly test", "cargo --locked build"]) {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const log = snap.artefacts.find((a) => a.class === "command-log");
            if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
            log.commands.unshift({ command: cmd, exit: 0, scenario_ms: 100 });
            log.commands.push({ command: cmd, exit: 0, scenario_ms: 900 });
            expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.repeated_action"]).toBe(false);
        }
        const p6 = fixture("P6-pass");
        const s6 = structuredClone(p6.snapshots[0]) as Snapshot;
        const l6 = s6.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (l6?.class !== "command-log") throw new Error("fixture lacks command-log");
        l6.commands.push({ command: "cargo --quiet test", exit: 0, scenario_ms: 10 });
        expect(gradeItem(p6.probe, [s6], rules)?.metrics["P6.ran_tests"]).toBe(true);
    });

    test("the grade log is read through a no-follow descriptor", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-grades-"));
        const target = join(dir, "elsewhere.jsonl");
        writeFileSync(target, `${JSON.stringify(grade("P2-pass"))}\n`);
        const linked = join(dir, "grades.jsonl");
        symlinkSync(target, linked);
        expect(() => new GradeLog(linked).all()).toThrow("is a link");
    });

    test("a metadata-only or binary file must be a complete operation", () => {
        const f = fixture("P2-pass");
        const run = (patch: string) => {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const diff = snap.artefacts.find((a) => a.class === "diff");
            if (diff?.class !== "diff") throw new Error("fixture lacks diff");
            diff.patch = patch;
            return () =>
                gradeItem(f.probe, [snap], rules) as NonNullable<ReturnType<typeof gradeItem>>;
        };
        expect(run("diff --git a/x b/x\nindex 2e65efe..7898192 100644\n")).toThrow("patch");
        expect(run("diff --git a/x b/x\nGIT binary patch\n")).toThrow("patch");
        expect(run("diff --git a/x b/x\nGIT binary patch\nliteral 5\nMcmYex\n\n")).toThrow("patch");
        expect(run("diff --git a/x b/x\nold mode 100644\n")).toThrow("patch");
        expect(run("diff --git a/x b/x\nsimilarity index 100%\nrename from x\n")).toThrow("patch");
        expect(run("diff --git a/x b/x\nold mode 100644\nnew mode 100755\n")().verdict).toBe(
            "pass",
        );
        expect(
            run("diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n")()
                .verdict,
        ).toBe("pass");
        expect(
            run("diff --git a/x b/x\nnew file mode 100644\nindex 0000000..e69de29\n")().verdict,
        ).toBe("pass");
        expect(run("diff --git a/x b/x\nBinary files a/x and b/x differ\n")().verdict).toBe("pass");
        expect(
            run(
                "diff --git a/x b/x\nGIT binary patch\nliteral 5\nMcmYex\n\nliteral 0\nHcmV?d00001\n\n",
            )().verdict,
        ).toBe("pass");
    });

    test("heredoc delimiters and here-strings are not file operands", () => {
        const f = fixture("P6-pass");
        for (const cmd of [
            "cat << src/connection.rs\nbody\nsrc/connection.rs",
            "cat <<< src/connection.rs",
            "cat <<src/connection.rs\nsrc/connection.rs",
            "cat <<<src/connection.rs",
        ]) {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
            if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
            log.commands.push({ command: cmd, exit: 0, scenario_ms: 10 });
            expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(0);
        }
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "cat < src/connection.rs", exit: 0, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
    });

    test("a top-level return does not end the list, and grep -E is a flag", () => {
        const f = fixture("P6-pass");
        for (const cmd of ["return; cat src/connection.rs", "grep -E needle src/connection.rs"]) {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
            if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
            log.commands.push({ command: cmd, exit: 0, scenario_ms: 10 });
            expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
        }
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "rg -E utf8 src/connection.rs", exit: 1, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(0);
    });

    test("a persisted grade carries every registered metric in agreement with its verdict", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const log = new GradeLog(path);
        const p11 = grade("P11-fail");
        const bad = [
            { ...p11, metrics: { "P11.pass": false, "P11.harm": false, "P11.weighted_score": -2 } },
            { ...p11, metrics: { "P11.pass": false, "P11.harm": true, "P11.weighted_score": 1 } },
            { ...p11, metrics: { "P11.pass": false } },
            { ...p11, metrics: { ...p11.metrics, "P11.extra": 1 } },
            {
                ...grade("P4-pass"),
                metrics: { "P4.pass": true, "P4.harm": true, "P4.collapsed": true },
            },
            {
                ...grade("P3-pass"),
                metrics: { "P3.pass": true, "P3.reliance": "stale", "P3.harm": false },
            },
            { ...grade("P6-pass"), metrics: { "P6.pass": true, "P6.reread_files": -1 } },
            { ...grade("P13-pass"), metrics: { "P13.fold_fidelity_score": 1, "P13.folds": 1 } },
        ];
        for (const g of bad) {
            expect(() => log.append(g as unknown as GradeRecord)).toThrow(GradeRefused);
        }
        for (const name of ["P11-fail", "P4-pass", "P3-pass", "P6-pass", "P13-pass", "P14-pass"]) {
            log.append(grade(name));
        }
        expect(log.all()).toHaveLength(6);
    });

    test("a Git label with spaces is read with its headers, and hunks advance with lines", () => {
        const f = fixture("P1-pass");
        const probe = { ...f.probe, check: { must: ["^src/a b\\.ts$"] } };
        const run = (patch: string) => {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const diff = snap.artefacts.find((a) => a.class === "diff" && a.role === "turn");
            if (diff?.class !== "diff") throw new Error("fixture lacks diff");
            diff.patch = patch;
            return () =>
                gradeItem(probe, [snap], rules) as NonNullable<ReturnType<typeof gradeItem>>;
        };
        expect(
            run(
                "diff --git a/src/a b.ts b/src/a b.ts\n--- a/src/a b.ts\t\n+++ b/src/a b.ts\t\n@@ -1 +1 @@\n-a\n+b\n",
            )().verdict,
        ).toBe("pass");
        expect(run("--- a/x\n+++ b/x\n@@ -1,0 +1,0 @@\n")).toThrow("patch");
        expect(run("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -1 +1 @@\n-a\n+c\n")).toThrow(
            "patch",
        );
        expect(run("--- a/x\n+++ b/x\n@@ -3 +3 @@\n-a\n+b\n@@ -1 +1 @@\n-a\n+c\n")).toThrow(
            "patch",
        );
        expect(
            run("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -5,2 +5,3 @@\n c\n+d\n e\n")(),
        ).toBeDefined();
    });

    test("the read builtin reads its redirection target only", () => {
        const f = fixture("P6-pass");
        const run = (cmd: string) => {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
            if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
            log.commands.push({ command: cmd, exit: 0, scenario_ms: 10 });
            return gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"];
        };
        expect(run("read src/connection.rs < /dev/null")).toBe(0);
        expect(run("read line < src/connection.rs")).toBe(1);
    });

    test("a snapshot with two artefacts of one role is refused before grader selection", () => {
        const f = fixture("P8-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const diff = fixture("P2-pass").snapshots[0]?.artefacts.find((a) => a.class === "diff");
        if (diff?.class !== "diff") throw new Error("fixture lacks diff");
        snap.artefacts.push({ ...diff, id: "d-1" }, { ...diff, id: "d-2" });
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("two turn diff artefacts");
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        snap.artefacts.splice(-2, 2);
        snap.artefacts.push({ ...calls, id: `${calls.id}-again` });
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("two proxy-call artefacts");
    });

    test("an append holds the grade log's lock and a held lock is refused", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const log = new GradeLog(path);
        writeFileSync(`${path}.lock`, "held");
        expect(() => log.append(grade("P2-pass"))).toThrow("locked");
        rmSync(`${path}.lock`);
        log.append(grade("P2-pass"));
        expect(existsSync(`${path}.lock`)).toBe(false);
        expect(log.all()).toHaveLength(1);
    });

    test("command evidence comes from reachable segments", () => {
        const f = fixture("P5-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "false && echo lazy_static", exit: 1, scenario_ms: 10 });
        log.commands.push({ command: "exit 0; echo lazy_static", exit: 0, scenario_ms: 11 });
        expect(gradeItem(f.probe, [snap], rules)?.verdict).toBe("pass");
        log.commands.push({ command: "echo lazy_static", exit: 0, scenario_ms: 12 });
        expect(gradeItem(f.probe, [snap], rules)?.verdict).toBe("fail");
    });

    test("package-manager global flags precede the test subcommand", () => {
        const f = fixture("P6-pass");
        for (const cmd of [
            "bun --silent test",
            "npm --silent test",
            "pnpm -s test",
            "bun --cwd pkg test",
        ]) {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
            if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
            log.commands.push({ command: cmd, exit: 0, scenario_ms: 10 });
            expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(true);
        }
        const p13 = fixture("P13-pass");
        const snap = structuredClone(p13.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.unshift({ command: "bun --silent test", exit: 0, scenario_ms: 100 });
        log.commands.push({ command: "bun --silent test", exit: 0, scenario_ms: 900 });
        expect(gradeItem(p13.probe, [snap], rules)?.metrics["P13.repeated_action"]).toBe(false);
    });

    test("a rename label with spaced names is read from its metadata, and a binary note names its files", () => {
        const f = fixture("P1-pass");
        const probe = { ...f.probe, check: { must: ["^src/new name\\.ts$"] } };
        const run = (patch: string) => {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const diff = snap.artefacts.find((a) => a.class === "diff" && a.role === "turn");
            if (diff?.class !== "diff") throw new Error("fixture lacks diff");
            diff.patch = patch;
            return () =>
                gradeItem(probe, [snap], rules) as NonNullable<ReturnType<typeof gradeItem>>;
        };
        expect(
            run(
                "diff --git a/src/old name.ts b/src/new name.ts\nsimilarity index 100%\nrename from src/old name.ts\nrename to src/new name.ts\n",
            )().verdict,
        ).toBe("pass");
        expect(
            run(
                "diff --git a/src/old name.ts b/src/new name.ts\n--- a/src/old name.ts\t\n+++ b/src/new name.ts\t\n@@ -1 +1 @@\n-a\n+b\n",
            )().verdict,
        ).toBe("pass");
        expect(run("diff --git a/x b/x\nBinary files nonsense\n")).toThrow("patch");
        expect(run("diff --git a/x b/x\nBinary files a/y and b/y differ\n")).toThrow("patch");
        expect(run("diff --git a/x b/x\nBinary files a/x and b/x differ\n")().verdict).toBe("fail");
        expect(run("diff --git a/x b/x\nBinary files /dev/null and b/x differ\n")().verdict).toBe(
            "fail",
        );
    });

    test("an exit inside a brace group ends the list, a subshell's does not", () => {
        const f = fixture("P6-pass");
        const run = (cmd: string) => {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
            if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
            log.commands.push({ command: cmd, exit: 0, scenario_ms: 10 });
            return gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"];
        };
        expect(run("{ exit 0; }; cat src/connection.rs")).toBe(0);
        expect(run("{ true; { exit 0; }; }; cat src/connection.rs")).toBe(0);
        expect(run("( exit 0 ); cat src/connection.rs")).toBe(1);
        expect(run("{ false && exit 0; }; cat src/connection.rs")).toBe(1);
        expect(run("{ exit 0; } | cat; cat src/connection.rs")).toBe(1);
    });

    test("plain headers keep their directories; Git labels strip a/ and b/", () => {
        const f = fixture("P6-pass");
        const run = (patch: string, cmd: string) => {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const prior = snap.artefacts.find(
                (a) => a.class === "diff" && a.role === "prior-session",
            );
            if (prior?.class !== "diff") throw new Error("fixture lacks prior diff");
            prior.patch = patch;
            const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
            if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
            log.commands.push({ command: cmd, exit: 0, scenario_ms: 10 });
            return gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"];
        };
        const plain = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
        expect(run(plain, "cat b/x")).toBe(1);
        expect(run(plain, "cat x")).toBe(0);
        const git = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n";
        expect(run(git, "cat x")).toBe(1);
        expect(run(git, "cat b/x")).toBe(0);
    });

    test("metadata lines carry their full grammar", () => {
        const f = fixture("P2-pass");
        const run = (patch: string) => {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const diff = snap.artefacts.find((a) => a.class === "diff");
            if (diff?.class !== "diff") throw new Error("fixture lacks diff");
            diff.patch = patch;
            return () =>
                gradeItem(f.probe, [snap], rules) as NonNullable<ReturnType<typeof gradeItem>>;
        };
        expect(run("diff --git a/x b/x\nold mode nonsense\nnew mode nonsense\n")).toThrow("patch");
        expect(run("diff --git a/x b/x\nnew file mode 100644\nindex nonsense\n")).toThrow("patch");
        expect(
            run("diff --git a/x b/y\nsimilarity index lots\nrename from x\nrename to y\n"),
        ).toThrow("patch");
        expect(
            run("diff --git a/x b/y\nsimilarity index 90%\nrename from \nrename to y\n"),
        ).toThrow("patch");
        expect(
            run("diff --git a/x b/x\nnew file mode 100644\nindex 0000000..e69de29 100644\n")()
                .verdict,
        ).toBe("pass");
        expect(
            run("diff --git a/x b/x\nold mode 100644\nnew mode 100755\nindex e69de29..e69de29\n")()
                .verdict,
        ).toBe("pass");
    });

    test("a guarded exit after a sure success ends the list, and grouped commands are classified", () => {
        const f = fixture("P6-pass");
        const run = (cmd: string, metric = "P6.reread_files") => {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
            if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
            log.commands.push({ command: cmd, exit: 0, scenario_ms: 10 });
            return gradeItem(f.probe, [snap], rules)?.metrics[metric];
        };
        expect(run("true && exit 0; cat src/connection.rs")).toBe(0);
        expect(run(": && exit 0; cat src/connection.rs")).toBe(0);
        expect(run("test -f x && exit 0; cat src/connection.rs")).toBe(1);
        expect(run("false || exit 0; cat src/connection.rs")).toBe(0);
        expect(run("test -f x || exit 0; cat src/connection.rs")).toBe(1);
        expect(run("false || cargo test", "P6.ran_tests")).toBe(true);
        expect(run("{ cat src/connection.rs; }")).toBe(1);
        expect(run("(cat src/connection.rs)")).toBe(1);
        expect(run("( cargo test )", "P6.ran_tests")).toBe(true);
        expect(run("{ true; { cat src/connection.rs; }; }")).toBe(1);
        expect(run("(exit 0; cat src/connection.rs)")).toBe(0);
        expect(run("A=$(printf x) cat src/connection.rs")).toBe(1);
        expect(run("A=${B:-y z} cat src/connection.rs")).toBe(1);
        expect(run("A=`printf x` cat src/connection.rs")).toBe(1);
    });

    test("a check pattern that is empty after its prefix or fails to compile is refused", () => {
        const f = fixture("P1-fail");
        for (const bad of ["(?i)", "["]) {
            expect(() =>
                gradeItem({ ...f.probe, check: { must: [bad] } }, f.snapshots, rules),
            ).toThrow("check.must");
        }
    });

    test("a heredoc body is not an executed shell segment", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({
            command: "cat > notes <<'EOF'\ncargo test\ncat src/connection.rs\nEOF",
            exit: 0,
            scenario_ms: 10,
        });
        const g = gradeItem(f.probe, [snap], rules) as GradeRecord;
        expect([g.metrics["P6.ran_tests"], g.metrics["P6.reread_files"]]).toEqual([false, 0]);
        log.commands.push({
            command: "cat <<EOF > x\nhi\nEOF\ncargo test",
            exit: 0,
            scenario_ms: 20,
        });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(true);
    });

    test("P9 treats UNKNOWN as abstention only when it is the whole first line", () => {
        const f = fixture("P9-pass");
        for (const [answer, verdict] of [
            ["The status should not be UNKNOWN.", "fail"],
            ["UNKNOWN", "pass"],
            ["**UNKNOWN**\nWe never decided that.", "pass"],
        ] as const) {
            const snap = structuredClone(f.snapshots[0]) as Snapshot;
            const calls = snap.artefacts.find((a) => a.class === "proxy-call");
            if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
            (calls.calls[0] as { response_text: string }).response_text = answer;
            expect(gradeItem(f.probe, [snap], rules)?.verdict).toBe(verdict);
        }
    });

    test("a multiline command repeated across the fold is not quiet", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        const cmd = "git status\nsed -i 's/a/b/' src/x.rs";
        log.commands.unshift({ command: cmd, exit: 0, scenario_ms: 100 });
        log.commands.push({ command: cmd, exit: 0, scenario_ms: 900 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P13.repeated_action"]).toBe(true);
    });

    test("P6 rediscovery tokens include failed agent calls of the turn", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        const last = calls.calls.at(-1) as CallView;
        calls.calls.push({
            ...last,
            seq: last.seq + 1,
            status: 502,
            error: "cut",
            input_tokens: 700,
            output_tokens: 0,
        });
        const before = grade("P6-pass").metrics["P6.rediscovery_tokens"] as number;
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.rediscovery_tokens"]).toBe(
            before + 700,
        );
    });

    test("a grade record is validated before it is written", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const log = new GradeLog(path);
        const g = grade("P2-pass");
        expect(() => log.append({ ...g, metrics: { ...g.metrics, "P2.x": Number.NaN } })).toThrow(
            GradeRefused,
        );
        expect(log.all()).toEqual([]);
    });

    test("two completed user-sim calls for one turn index are refused as ambiguous", () => {
        const f = fixture("P14-fail");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        const sim = calls.calls.find((c) => c.component === "user-sim") as CallView;
        calls.calls.push({ ...sim, seq: sim.seq + 1, label: "task" });
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("two user-sim calls for turn");
    });

    test("shell comments, mixed chains, and spaced heredoc terminators do not fabricate executed segments", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push(
            { command: "echo ok # && cargo test", exit: 0, scenario_ms: 10 },
            { command: "false && cargo test || true", exit: 0, scenario_ms: 20 },
            { command: "cat <<EOF\n EOF \ncargo test\nEOF", exit: 0, scenario_ms: 30 },
            { command: "cat <<-EOF\n\tbody\n\tEOF\necho done", exit: 0, scenario_ms: 40 },
            { command: "cat <<'EOF'2\nEOF\ncargo test\nEOF2", exit: 0, scenario_ms: 41 },
            { command: 'cat <<"$END"\ncargo test\n$END', exit: 0, scenario_ms: 42 },
            { command: "cat <<\\EOF\ncargo test\nEOF", exit: 0, scenario_ms: 43 },
        );
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(false);
        log.commands.push({
            command: "cat <<-EOF\n\tbody\n\tEOF\ncargo test",
            exit: 0,
            scenario_ms: 50,
        });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(true);
    });

    test("token counters are non-negative integers", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        (calls.calls[0] as CallView).input_tokens = -999999;
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("calls[0].input_tokens");
    });

    test("a renamed file counts under both of its paths", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const prior = snap.artefacts.find((a) => a.class === "diff" && a.role === "prior-session");
        if (prior?.class !== "diff") throw new Error("fixture lacks prior diff");
        prior.patch =
            "diff --git a/src/old.rs b/src/new.rs\nsimilarity index 90%\nrename from src/old.rs\nrename to src/new.rs\n--- a/src/old.rs\n+++ b/src/new.rs\n@@ -1,1 +1,1 @@\n-fn a() {}\n+fn b() {}\n";
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "cat src/old.rs", exit: 1, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.reread_files"]).toBe(1);
    });

    test("a grade record names at least one distinct input artefact", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const log = new GradeLog(path);
        const g = grade("P2-pass");
        expect(() => log.append({ ...g, inputs: [] })).toThrow(GradeRefused);
        expect(() => log.append({ ...g, inputs: ["d1", "d1"] })).toThrow(GradeRefused);
    });

    test("a snapshot listed twice is refused rather than counted as a later attempt", () => {
        const f = fixture("P8-pass");
        const first = f.snapshots[0] as Snapshot;
        expect(() => gradeItem(f.probe, [first, first], rules)).toThrow("snapshot s-P8-a twice");
    });

    test("a P13 fold without a turn index refuses the grade", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        const fold = calls.calls.find((c) => c.component === "history_summarizer") as CallView;
        calls.calls.push({
            ...fold,
            seq: fold.seq + 1,
            turn_index: undefined,
            output_tokens: 19000,
        });
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("fold call without a turn index");
    });

    test("a # inside a word is not a comment", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push({ command: "echo foo#bar && cargo test", exit: 0, scenario_ms: 10 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(true);
    });

    test("subshells, multiple heredocs, and background lists follow shell execution", () => {
        const f = fixture("P6-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const log = snap.artefacts.find((a) => a.class === "command-log" && a.role === "turn");
        if (log?.class !== "command-log") throw new Error("fixture lacks command-log");
        log.commands.push(
            { command: "false && (echo x; cargo test); true", exit: 0, scenario_ms: 10 },
            { command: "cat <<A <<B\nA\ncargo test\nB", exit: 0, scenario_ms: 20 },
        );
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(false);
        log.commands.push({
            command: "cat <<EOF >/dev/null; cargo test\nbody\nEOF",
            exit: 0,
            scenario_ms: 30,
        });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(true);
        log.commands.pop();
        log.commands.push({ command: "echo ok 2>&1 & cargo test", exit: 0, scenario_ms: 40 });
        expect(gradeItem(f.probe, [snap], rules)?.metrics["P6.ran_tests"]).toBe(true);
    });

    test("a turn index is a non-negative integer", () => {
        const f = fixture("P13-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        (calls.calls[0] as CallView).turn_index = 29.5;
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("calls[0].turn_index");
    });

    test("a persisted P1 record carries its pair, a graded record its probe's metrics, and versions run consecutively", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const log = new GradeLog(path);
        const p1 = grade("P1-pass");
        const { pair: _pair, ...unpaired } = p1;
        expect(() => log.append(unpaired as GradeRecord)).toThrow(GradeRefused);
        const p2 = grade("P2-pass");
        expect(() => log.append({ ...p2, metrics: {} })).toThrow(GradeRefused);
        appendFileSync(path, `${JSON.stringify(p2)}\n${JSON.stringify({ ...p2, version: 3 })}\n`);
        expect(() => log.all()).toThrow("line 2 has version 3 after version 1");
    });

    test("every counted snapshot is bound to the probe's session and event", () => {
        const f = fixture("P8-pass");
        const first = f.snapshots[0] as Snapshot;
        const stray = { ...retagged(first, "s-9"), id: "other" };
        expect(() => gradeItem(f.probe, [first, stray], rules)).toThrow("session s-9");
    });

    test("P10 applies must_not to the diff and answer_must_not to the response", () => {
        const f = fixture("P10-pass");
        const check = f.probe.check as { must_not: string[]; answer_must_not: string };
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        (calls.calls[0] as { response_text: string }).response_text = "The port is 80095.";
        expect(gradeItem(f.probe, [snap], rules)?.verdict).toBe("fail");
        const clean = { ...f.probe, check: { ...check, answer_must_not: "never-present-\\d{9}" } };
        expect(gradeItem(clean, [snap], rules)?.verdict).toBe("pass");
    });

    test("proxy calls must carry strictly increasing sequence numbers", () => {
        const f = fixture("P8-pass");
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        const calls = snap.artefacts.find((a) => a.class === "proxy-call");
        if (calls?.class !== "proxy-call") throw new Error("fixture lacks proxy-call");
        const last = calls.calls.at(-1) as CallView;
        calls.calls.push({
            ...last,
            seq: last.seq - 1,
            response_text: "stale draft without the value",
        });
        expect(() => gradeItem(f.probe, [snap], rules)).toThrow("calls[1].seq");
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
        appendFileSync(path, `${JSON.stringify(g)}\n${JSON.stringify({ ...g, inputs: ["d1"] })}\n`);
        expect(() => log.all()).toThrow("line 2 has version 1 after version 1");
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
        expect(() => gradeItem(p8.probe, [s8], rules)).toThrow("has no response text");
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
        snap.artefacts.push({
            ...diff,
            id: "d2",
            patch: "diff --git a/x b/x\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+use crate::ALPHA_RULE;\n",
        });
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
        const at = calls.calls.findIndex((c) => c.component === "history_summarizer");
        const fold = calls.calls[at] as CallView;
        calls.calls.splice(at, 0, {
            ...fold,
            component: "user-sim",
            seq: fold.seq - 1,
            label: "pushback",
            turn_index: 4,
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
        log.append({ ...g, version: log.nextVersion(g) });
        expect(log.all().map((x) => x.version)).toEqual([1, 2]);
        expect(log.latest().map((x) => x.version)).toEqual([2]);
    });

    test("a grade log reopened over a cut last line drops the cut and allocates the next version", () => {
        const path = join(mkdtempSync(join(tmpdir(), "sim-grades-")), "grades.jsonl");
        const g = grade("P2-pass");
        new GradeLog(path).append(g);
        appendFileSync(path, '{"item":"P2-a","arm":"eidnara","ver');
        const reopened = new GradeLog(path);
        expect(reopened.nextVersion(g)).toBe(2);
        reopened.append({ ...g, version: 2 });
        expect(reopened.all().map((x) => x.version)).toEqual([1, 2]);
        expect(new GradeLog(path).all().map((x) => x.version)).toEqual([1, 2]);
    });
});

test("an answer the proxy cut at its cap is refused rather than graded on its prefix", () => {
    const f = fixture("P8-pass");
    const snap = structuredClone(f.snapshots[0]) as Snapshot;
    const calls = snap.artefacts.find((a) => a.class === "proxy-call") as unknown as {
        calls: Record<string, unknown>[];
    };
    const last = calls.calls.at(-1) as Record<string, unknown>;
    last.response_text_truncated = true;
    expect(() => gradeItem(f.probe, [snap], rules)).toThrow("truncated");
});

test("a snapshot without the artefact its grader reads is refused rather than graded on a default", () => {
    const f = fixture("P2-pass");
    const snap = structuredClone(f.snapshots[0]) as Snapshot;
    snap.artefacts = [{ id: "c", class: "command-log", role: "turn", commands: [] }];
    expect(() => gradeItem(f.probe, [snap], rules)).toThrow("lacks the diff (turn) artefact");
    const p13 = fixture("P13-pass");
    const only = structuredClone(p13.snapshots[0]) as Snapshot;
    only.artefacts = only.artefacts.filter((a) => a.class !== "proxy-call");
    expect(() => gradeItem(p13.probe, [only], rules)).toThrow("lacks the proxy-call artefact");
});

test("a fold call that failed is no fold for P13", () => {
    const f = fixture("P13-pass");
    const snap = structuredClone(f.snapshots[0]) as Snapshot;
    const calls = snap.artefacts.find((a) => a.class === "proxy-call") as unknown as {
        calls: Record<string, unknown>[];
    };
    for (const c of calls.calls) if (c.component === "history_summarizer") c.failed = true;
    const grade = gradeItem(f.probe, [snap], rules);
    expect(grade?.verdict).toBe("excluded");
    expect(grade?.reason).toBe("no fold in the item's range");
});

test("P6 without its prior-session diff, P5 without its command log, and P10 without calls are refused", () => {
    const without = (name: string, drop: (a: { class: string; role?: string }) => boolean) => {
        const f = fixture(name);
        const snap = structuredClone(f.snapshots[0]) as Snapshot;
        snap.artefacts = snap.artefacts.filter((a) => !drop(a as { class: string; role?: string }));
        return () => gradeItem(f.probe, [snap], rules);
    };
    expect(without("P6-pass", (a) => a.role === "prior-session")).toThrow("diff (prior-session)");
    expect(without("P5-pass", (a) => a.class === "command-log")).toThrow("command-log (turn)");
    expect(without("P10-pass", (a) => a.class === "proxy-call")).toThrow("proxy-call");
});

test("an artefact without its class's payload is refused rather than read as empty evidence", () => {
    const f = fixture("P2-pass");
    const snap = structuredClone(f.snapshots[0]) as Snapshot;
    snap.artefacts = [
        { id: "d", class: "diff", role: "turn" } as unknown as Snapshot["artefacts"][number],
    ];
    expect(() => gradeItem(f.probe, [snap], rules)).toThrow("patch is missing or malformed");
    const p13 = fixture("P13-pass");
    const calls = structuredClone(p13.snapshots[0]) as Snapshot;
    calls.artefacts = calls.artefacts.map((a) =>
        a.class === "proxy-call"
            ? ({ id: a.id, class: "proxy-call" } as unknown as Snapshot["artefacts"][number])
            : a,
    );
    expect(() => gradeItem(p13.probe, [calls], rules)).toThrow("calls is missing or malformed");
});

test("test-result and workspace-state artefacts are accepted with their own payloads", () => {
    const f = fixture("P2-pass");
    const snap = structuredClone(f.snapshots[0]) as Snapshot;
    snap.artefacts.push(
        { id: "t", class: "test-result", command: "cargo test", exit: 0, summary: ["ok"] },
        { id: "w", class: "workspace-state", files: { "a.rs": "abc" } },
    );
    expect(gradeItem(f.probe, [snap], rules)?.verdict).toBe("pass");
    snap.artefacts.pop();
    snap.artefacts.push({
        id: "w2",
        class: "workspace-state",
    } as unknown as Snapshot["artefacts"][number]);
    expect(() => gradeItem(f.probe, [snap], rules)).toThrow("files is missing or malformed");
});

test("a command log whose entries lack command text or a time is refused", () => {
    const p5 = fixture("P5-pass");
    const snap = structuredClone(p5.snapshots[0]) as Snapshot;
    snap.artefacts = snap.artefacts.map((a) =>
        a.class === "command-log" ? { ...a, commands: [{}] } : a,
    ) as Snapshot["artefacts"];
    expect(() => gradeItem(p5.probe, [snap], rules)).toThrow(
        "commands[0].command is missing or malformed",
    );
});

describe("check channels", () => {
    const created = (path: string, lines: string[]) =>
        `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}\n`).join("")}`;
    const item = (type: string, check: Record<string, unknown>): ProbeItem =>
        ({ ...fixture("P1-pass").probe, type, check }) as ProbeItem;
    const snapshotOf = (patch: string, commands: Command[] = []): Snapshot => {
        const base = fixture("P1-pass").snapshots[0] as Snapshot;
        return {
            ...base,
            artefacts: [
                { id: "d", class: "diff", role: "turn", patch },
                { id: "c", class: "command-log", role: "turn", commands },
            ],
        };
    };
    const verdict = (type: string, check: Record<string, unknown>, s: Snapshot) =>
        gradeItem(item(type, check), [s], rules)?.verdict;

    test("paths_must reads the diff's surviving paths", () => {
        const s = snapshotOf(created("test/get.tok.test.ts", ["it();"]));
        expect(verdict("P1", { paths_must: ["\\.tok\\.test\\.ts$"] }, s)).toBe("pass");
        expect(verdict("P1", { paths_must: ["\\.other\\.test\\.ts$"] }, s)).toBe("fail");
        expect(verdict("P2", { paths_must_not: ["\\.tok\\.test\\.ts$"] }, s)).toBe("fail");
    });

    test("first_line_must holds on every created file and needs one", () => {
        const header = { first_line_must: ["^// tok"] };
        const both = `${created("a.ts", ["// tok", "x"])}${created("b.ts", ["// tok"])}`;
        expect(verdict("P1", header, snapshotOf(both))).toBe("pass");
        const one = `${created("a.ts", ["// tok"])}${created("b.ts", ["x"])}`;
        expect(verdict("P1", header, snapshotOf(one))).toBe("fail");
        const edit = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +2,1 @@\n+// tok\n";
        expect(verdict("P1", header, snapshotOf(edit))).toBe("fail");
    });

    test("quote_style_must reads every string literal under the check's scope", () => {
        const check = { scope: "src/ws/", quote_style_must: "double", side: "in" };
        const inside = created("src/ws/close.ts", ['const r = "bad frame";', "// don't"]);
        const outside = created("src/route.ts", ["const m = 'missing';"]);
        expect(verdict("P4", check, snapshotOf(`${inside}${outside}`))).toBe("pass");
        const single = created("src/ws/close.ts", ["const r = 'bad frame';"]);
        expect(verdict("P4", check, snapshotOf(single))).toBe("fail");
        expect(verdict("P4", check, snapshotOf(outside))).toBe("fail");
    });

    test("commands_must_not refuses an executed segment that starts with the pattern", () => {
        const check = {
            commands_must: ["git commit .*\\[tok\\]"],
            commands_must_not: ["git push"],
        };
        const run = (command: string) => ({ command, exit: 0, scenario_ms: 0 });
        const tagged = run("git add . && git commit -m '[tok] x'");
        expect(verdict("P1", check, snapshotOf("", [tagged]))).toBe("pass");
        const pushed = [tagged, run("git push")];
        expect(verdict("P1", check, snapshotOf("", pushed))).toBe("fail");
    });

    test("an unknown check key and a check with no rule to hold are refused", () => {
        const s = snapshotOf(created("a.ts", ["x"]));
        expect(() => gradeItem(item("P1", { must: ["x"], musts: ["x"] }), [s], rules)).toThrow(
            "unknown check.musts",
        );
        expect(() => gradeItem(item("P1", { must_not: ["x"] }), [s], rules)).toThrow(
            "names no rule to hold",
        );
        expect(() =>
            gradeItem(item("P4", { must: ["x"], scope: "src", side: "in" }), [s], rules),
        ).toThrow("malformed check.scope");
    });
});

test("P14 counts only the user-sim turns before its window's end", () => {
    const f = fixture("P14-fail");
    const at = (window_to_turn: number) =>
        gradeItem(
            { ...f.probe, check: { window_from_turn: 4, window_to_turn } },
            f.snapshots,
            rules,
        ) as GradeRecord;
    expect(at(6).verdict).toBe("fail");
    expect([at(5).verdict, at(5).reason]).toEqual([
        "excluded",
        "no user-sim turn after compaction in the window",
    ]);
    expect(() => at(4)).toThrow("empty P14 window");
});

test("every programmatic probe the compiler emits carries a check its grader accepts", async () => {
    const scenario = await compileScenario(loadCompileInput(101, "S", hashEmbedder, true));
    const graded = scenario.probes.filter((p) => p.type !== "P7");
    expect(graded.length).toBeGreaterThan(0);
    for (const p of graded) expect(() => graderFor(p as ProbeItem)).not.toThrow();
});

test("appendAll writes a batch whose versions follow each key in order, and refuses a malformed grader digest", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sim-grade-log-")), "grades.jsonl");
    const log = new GradeLog(path);
    const g = grade("P2-pass");
    const grader = graderDigest();
    log.appendAll([
        { ...g, grader },
        { ...g, version: 2, grader },
    ]);
    expect(log.all().map((x) => [x.version, x.grader])).toEqual([
        [1, grader],
        [2, grader],
    ]);
    expect(() => log.appendAll([{ ...g, version: 4 }])).toThrow(/expected v3/);
    expect(() => log.append({ ...g, version: 3, grader: "not a digest" })).toThrow(
        /not a grade record/,
    );
    expect(log.all()).toHaveLength(2);
});
