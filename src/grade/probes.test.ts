import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProbeItem } from "../scenario/compile";
import { loadPrereg } from "../scenario/inputs";
import { GradeRefused, type Snapshot } from "./artefacts";
import { deltaMem, GradeLog, type GradeRecord, gradeItem } from "./probes";

const DIR = join(import.meta.dir, "../../tests/fixtures/grade");
const rules = loadPrereg("S").grading;

interface Fixture {
    probe: ProbeItem;
    snapshots: Snapshot[];
    expect: { verdict: string; reason?: string; metrics?: Record<string, unknown> };
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
            if (f.expect.reason) expect(g.reason).toBe(f.expect.reason);
            for (const [k, v] of Object.entries(f.expect.metrics ?? {})) {
                if (typeof v === "number") expect(g.metrics[k] as number).toBeCloseTo(v);
                else expect(g.metrics[k]).toBe(v as never);
            }
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
