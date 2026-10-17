import { describe, expect, test } from "bun:test";
import {
    appendFileSync,
    existsSync,
    linkSync,
    lstatSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { GradeRecord } from "../src/grade/probes";
import { sha256Hex } from "../src/prereg/canonical";
import { preregistrationHash } from "../src/prereg/validate";
import { type Scenario, scenarioHash } from "../src/scenario/compile";
import { loadPrereg } from "../src/scenario/inputs";
import { deliveredTurns, type Label, realisedRates } from "../src/usersim/plan";
import { tapeDigests } from "../src/usersim/usersim";
import { aaReport } from "./aa-report";

const grade = (arm: string, item: string, type: string, metric: string, value: number) => ({
    item,
    arm,
    probe_type: type,
    version: 1,
    snapshot: `${arm}:${item}`,
    inputs: [],
    later_attempts_logged: 0,
    verdict: "pass",
    metrics: { [`${type}.pass`]: true, [metric]: value },
});

const SCRIPT_TEXT = "go";
/** A delivered turn; `text` other than the compiled script marks a live reply in front of it. */
const turn = (arm: string, event: string, text: string, index = 0) => ({
    kind: "turn",
    arm,
    session: "s-1",
    event,
    index,
    digest: "d",
    context_sha256: "c",
    prefix_sha256: "p",
    text_sha256: sha256Hex(text === "same" ? SCRIPT_TEXT : text),
    label: text === "same" ? "task" : "pushback",
    delivered: true,
    source: text === "same" ? "script" : "live",
});

const journal = (order: string[], events: number): Record<string, unknown>[] => [
    { kind: "StartRun", arm: null, order, scenario_ms: 0 },
    ...order.flatMap((arm) => [
        ...Array.from({ length: events }, (_, i) => {
            const event = `e-${i + 1}`;
            const probe = PROBE_EVENTS[i];
            const snapshot = probe ? `${arm}:${probe}` : undefined;
            return [
                ...(probe
                    ? [
                          {
                              kind: "UserTurn",
                              arm,
                              event,
                              session: "s-1",
                              label: "task",
                              delivered: true,
                              scenario_ms: 0,
                          },
                          { kind: "SnapshotArtefacts", arm, item: probe, snapshot, scenario_ms: 0 },
                          { kind: "EndTurn", arm, event, outcome: "ok", snapshot, scenario_ms: 0 },
                      ]
                    : []),
                { kind: "Event", arm, event, scenario_ms: 0 },
            ];
        }).flat(),
        {
            kind: "UserSimRates",
            arm,
            scenario_ms: 0,
            ...realisedRates(
                PROBE_EVENTS.map(() => ({ session: "s-1", label: "task" as const })),
                loadPrereg("S"),
            ),
        },
        { kind: "EndArm", arm, scenario_ms: 0 },
    ]),
    { kind: "EndRun", arm: null, scenario_ms: 0 },
];

const PROBE_EVENTS = [1, 2, 3, 4, 5, 6].flatMap((i) => [`p-${i}`, `q-${i}`]);
const N_EVENTS = PROBE_EVENTS.length + 1;
/** Every scheduled turn of an arm, each delivering `text`. */
const allTurns = (arm: string, text = "same") =>
    PROBE_EVENTS.map((_, i) => turn(arm, `e-${i + 1}`, text, i));

/** Rows with each divergence placed before the turn it describes, as the runner writes them. */
const ordered = (rows: Record<string, unknown>[]) => {
    const turns = rows.filter((r) => r.kind === "turn");
    const out: Record<string, unknown>[] = [];
    for (const t of turns) {
        out.push(
            ...rows.filter(
                (d) => d.kind === "divergedAt" && d.arm === t.arm && d.event === t.event,
            ),
        );
        out.push(t);
    }
    return out;
};

/**
 * Gives one scenario event `role`, appends `more` events, and re-pins the manifest to the new
 * scenario: its hash and its event count.
 */
function withRole(dir: string, id: string, role: string, more: Record<string, unknown>[] = []) {
    const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as {
        events: Record<string, unknown>[];
    };
    scenario.events = [...scenario.events.map((e) => (e.id === id ? { ...e, role } : e)), ...more];
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<
        string,
        unknown
    >;
    manifest.scenario_hash = scenarioHash(scenario as unknown as Scenario);
    manifest.events = scenario.events.length;
    writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}

/** The journal with each arm's UserSimRates recomputed from its delivered UserTurn rows. */
function rerated(entries: Record<string, unknown>[]): Record<string, unknown>[] {
    return entries.map((e) =>
        e.kind === "UserSimRates"
            ? {
                  kind: "UserSimRates",
                  arm: e.arm,
                  scenario_ms: 0,
                  ...realisedRates(
                      deliveredTurns(entries, e.arm as string).map((t) => ({
                          session: String(t.session),
                          label: t.label as Label,
                      })),
                      loadPrereg("S"),
                  ),
              }
            : e,
    );
}

function gradedRun(
    tier: string,
    prereg_sha256: string,
    items = [1, 2, 3, 4, 5, 6],
    scenario_hash?: string,
): string {
    const seed = loadPrereg(tier as "S" | "M").seeds[0] as number;
    const dir = mkdtempSync(join(tmpdir(), "sim-aa-report-"));
    const line = (o: unknown) => `${JSON.stringify(o)}\n`;
    const probes: Record<string, unknown>[] = items.flatMap((i) => [
        { id: `p-${i}`, type: "P3", fact: `fact-${i}` },
        { id: `q-${i}`, type: "P13", fact: `fact-${i}` },
    ]);
    const grades = items.flatMap((i) =>
        ["host", "host~aa"].flatMap((arm) => [
            grade(arm, `p-${i}`, "P3", "P3.delta_mem", arm === "host" ? 0 : i),
            grade(arm, `q-${i}`, "P13", "P13.fold_fidelity_score", i % 2),
        ]),
    ) as GradeRecord[];
    const events = [
        ...PROBE_EVENTS.map((probe, i) => ({
            id: `e-${i + 1}`,
            kind: "user_turn",
            session: "s-1",
            index: i,
            probe,
            role: "task",
            text: SCRIPT_TEXT,
        })),
        { id: `e-${N_EVENTS}`, kind: "session_end", session: "s-1" },
    ];
    probes.push(
        { id: "j-1", type: "P7", fact: "fact-1" },
        { id: "k-1", type: "P14", session: "s-1" },
    );
    const scenario = { manifest: { tier, seed }, probes, events };
    const manifest = {
        tier,
        seed,
        order: ["host", "host~aa"],
        events: N_EVENTS,
        prereg_sha256,
        scenario_hash: scenario_hash ?? scenarioHash(scenario),
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
    writeFileSync(join(dir, "grades.jsonl"), grades.map(line).join(""));
    const turns = ["host", "host~aa"].flatMap((arm) => allTurns(arm));
    writeFileSync(join(dir, "pairing.jsonl"), turns.map(line).join(""));
    writeFileSync(
        join(dir, "journal.jsonl"),
        journal(manifest.order, manifest.events).map(line).join(""),
    );
    return dir;
}

describe("aa-report", () => {
    test("a scheduled interrupt the host finished first is journaled task and still reports", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        // With e-1 the scenario's one filler, the seeded plan draws its interrupt there.
        withRole(dir, "e-1", "filler");
        const rows = readFileSync(join(dir, "pairing.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as Record<string, unknown>);
        for (const r of rows) {
            if (r.event === "e-1") r.label = "interrupt";
        }
        writeFileSync(join(dir, "pairing.jsonl"), rows.map(line).join(""));
        const journal = readFileSync(join(dir, "journal.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as Record<string, unknown>);
        for (const e of journal) {
            if (e.kind !== "UserTurn" || e.event !== "e-1") continue;
            if (e.arm === "host") Object.assign(e, { label: "task", scheduled: "interrupt" });
            else e.label = "interrupt";
        }
        writeFileSync(join(dir, "journal.jsonl"), rerated(journal).map(line).join(""));
        expect(aaReport(dir)).toHaveLength(1);
    });

    test("a reference divergence placed ahead of the reference turn is refused", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const rows = readFileSync(join(dir, "pairing.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as Record<string, unknown>);
        for (const r of rows) if (r.arm === "host~aa" && r.event === "e-2") r.digest = "d2";
        const divergence = {
            kind: "divergedAt",
            arm: "host~aa",
            session: "s-1",
            event: "e-2",
            index: 1,
            digest: "d2",
            reference_digest: "d",
            context_sha256: "c",
            against: "reference",
        };
        const reordered = [divergence, ...rows];
        writeFileSync(join(dir, "pairing.jsonl"), reordered.map(line).join(""));
        expect(() => aaReport(dir)).toThrow(/divergence at e-2/);
    });

    test("a label the seeded plan did not assign, or a rate summary that disagrees, blocks the report", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const rows = readFileSync(join(dir, "pairing.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as Record<string, unknown>);
        for (const r of rows) {
            if (r.arm === "host" && r.event === "e-1") {
                r.label = "pushback";
                r.source = "live";
            }
        }
        writeFileSync(join(dir, "pairing.jsonl"), rows.map(line).join(""));
        const journal = readFileSync(join(dir, "journal.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as Record<string, unknown>);
        for (const e of journal) {
            if (e.kind === "UserTurn" && e.arm === "host" && e.event === "e-1")
                e.label = "pushback";
        }
        writeFileSync(join(dir, "journal.jsonl"), journal.map(line).join(""));
        expect(() => aaReport(dir)).toThrow(/plan/);
        const other = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const entries = readFileSync(join(other, "journal.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as Record<string, unknown>)
            .filter((e) => e.kind !== "UserSimRates");
        writeFileSync(join(other, "journal.jsonl"), entries.map(line).join(""));
        expect(() => aaReport(other)).toThrow(/UserSimRates/);
    });

    test("refuses a run graded under another pre-registration", () => {
        const dir = gradedRun("S", "0000");
        expect(() => aaReport(dir)).toThrow(/pre-registration/);
    });

    test("refuses a run whose scenario no longer hashes to the manifest's digest", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")), undefined, "0000");
        expect(() => aaReport(dir)).toThrow(/scenario_hash/);
    });

    test("a grading run cut short converges on its rerun: the latest grade per side pairs", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const cut = { ...grade("host", "p-1", "P3", "P3.delta_mem", 0), version: 2 };
        const rerun = [
            { ...cut, version: 3 },
            { ...grade("host~aa", "p-1", "P3", "P3.delta_mem", 9), version: 2 },
        ];
        appendFileSync(join(dir, "grades.jsonl"), [cut, ...rerun].map(line).join(""));
        const [report] = aaReport(dir);
        const m = report?.metrics.find((x) => x.metric === "P3.delta_mem");
        expect(m?.n).toBe(6);
        expect(m?.mean).toBeCloseTo((9 + 2 + 3 + 4 + 5 + 6) / 6);
    });

    test("refuses a grade whose probe type, arm, or version contradicts the run", () => {
        const base = grade("host", "p-1", "P3", "P3.delta_mem", 0);
        const bad = [
            { ...base, version: 2, probe_type: "P9" },
            { ...base, arm: "eidnara" },
            { ...base, version: "2" },
            { ...base, item: "p-99" },
        ];
        for (const record of bad) {
            const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
            appendFileSync(join(dir, "grades.jsonl"), `${JSON.stringify(record)}\n`);
            expect(() => aaReport(dir)).toThrow(/grades\.jsonl/);
        }
    });

    test("refuses a pairing log whose terminated last line is corrupt", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const first = turn("host~aa", "e-1", "same");
        writeFileSync(join(dir, "pairing.jsonl"), `${JSON.stringify(first)}\n{corrupt\n`);
        expect(() => aaReport(dir)).toThrow(/last line is corrupt/);
    });

    test("a staging file left by a killed report does not block the next one", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        writeFileSync(join(dir, `aa.json.${process.pid}.tmp`), "{");
        expect(aaReport(dir)).toHaveLength(1);
        expect(JSON.parse(readFileSync(join(dir, "aa.json"), "utf8"))).toHaveLength(1);
    });

    test("refuses a manifest whose tier or seed differs from the compiled scenario's", () => {
        const relabeled = gradedRun("S", preregistrationHash(loadPrereg("M")));
        const manifest = JSON.parse(readFileSync(join(relabeled, "manifest.json"), "utf8"));
        writeFileSync(join(relabeled, "manifest.json"), JSON.stringify({ ...manifest, tier: "M" }));
        expect(() => aaReport(relabeled)).toThrow(/scenario.json is S seed 101/);
        const reseeded = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const m2 = JSON.parse(readFileSync(join(reseeded, "manifest.json"), "utf8"));
        writeFileSync(join(reseeded, "manifest.json"), JSON.stringify({ ...m2, seed: 102 }));
        expect(() => aaReport(reseeded)).toThrow(/scenario.json is S seed 101/);
    });

    test("a grade excluded on one side is reported per arm with its item, and pairs nothing", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const excluded = {
            ...grade("host", "p-1", "P3", "P3.delta_mem", 0),
            version: 2,
            verdict: "excluded",
        };
        appendFileSync(join(dir, "grades.jsonl"), `${JSON.stringify(excluded)}\n`);
        const [report] = aaReport(dir);
        expect(report?.excluded).toEqual({ host: 1, "host~aa": 0 });
        expect(report?.unpaired_items).toEqual(["p-1"]);
        expect(report?.metrics.find((m) => m.metric === "P3.delta_mem")?.n).toBe(5);
    });

    test("with no informative metric the report draws no interval conclusion", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")), [1, 2]);
        const [report] = aaReport(dir);
        expect(report?.uninformative.length).toBe(report?.metrics.length);
        expect(report?.every_interval_covers_zero).toBeNull();
    });

    test("refuses a pairing record whose shape or arm is wrong", () => {
        const bad = [
            '{"kind":"divergedAt","arm":"host~aa","session":"s-1","index":"1"}',
            '{"kind":"turn","arm":"eidnara","session":"s-1","index":1}',
            '{"kind":"other","arm":"host~aa","session":"s-1","index":1}',
            '{"kind":"turn","arm":"host~aa","session":"s-1","event":"e-1","index":0,"digest":"d"}',
            '{"kind":"divergedAt","arm":"host~aa","session":"s-1","event":"e-1","index":0,"digest":"d"}',
        ];
        for (const record of bad) {
            const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
            writeFileSync(join(dir, "pairing.jsonl"), `${record}\n`);
            expect(() => aaReport(dir)).toThrow(/pairing\.jsonl: line 1/);
        }
    });

    test("aa.json replaces a symlink left in the run directory instead of writing through it", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const target = join(dir, "elsewhere.json");
        writeFileSync(target, "keep me\n");
        symlinkSync(target, join(dir, "aa.json"));
        aaReport(dir);
        expect(readFileSync(target, "utf8")).toBe("keep me\n");
        expect(lstatSync(join(dir, "aa.json")).isSymbolicLink()).toBe(false);
    });

    test("refuses a manifest order the run command would refuse", () => {
        for (const order of [
            ["host", "host~aa", "host~bb"],
            ["host~aa"],
            ["host~aa", "host"],
            ["host", "eidnara", "host~aa"],
            ["host", "host~x/../../outside"],
            ["host", "eidnara-kl", "eidnara-kl~aa"],
        ]) {
            const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
            const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
            writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...manifest, order }));
            expect(() => aaReport(dir)).toThrow(/manifest/);
        }
    });

    test("refuses a control whose delivered text differed from its arm's before any divergence", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const records = [
            turn("host", "e-1", "aaaa", 0),
            ...allTurns("host").slice(1),
            turn("host~aa", "e-1", "bbbb", 0),
            ...allTurns("host~aa").slice(1),
        ];
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        writeFileSync(join(dir, "pairing.jsonl"), records.map(line).join(""));
        const entries = journal(["host", "host~aa"], N_EVENTS).map((e) =>
            e.kind === "UserTurn" && e.event === "e-1" ? { ...e, label: "pushback" } : e,
        );
        writeFileSync(join(dir, "journal.jsonl"), entries.map(line).join(""));
        expect(() => aaReport(dir)).toThrow(/host~aa s-1 #0/);
    });

    test("refuses a run whose pairing log lacks a turn on either side", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const empty = gradedRun("S", preregistrationHash(loadPrereg("S")));
        writeFileSync(join(empty, "pairing.jsonl"), "");
        expect(() => aaReport(empty)).toThrow(/host has no pairing record for e-1, e-2, e-3/);
        const lost = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const kept = [...allTurns("host~aa"), ...allTurns("host").filter((t) => t.event !== "e-2")];
        writeFileSync(join(lost, "pairing.jsonl"), kept.map(line).join(""));
        expect(() => aaReport(lost)).toThrow(/host has no pairing record for e-2/);
    });

    test("refuses a run whose journal is missing, incomplete, or ordered otherwise", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const gone = gradedRun("S", preregistrationHash(loadPrereg("S")));
        rmSync(join(gone, "journal.jsonl"));
        expect(() => aaReport(gone)).toThrow(/journaled order/);
        const cut = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const entries = journal(["host", "host~aa"], N_EVENTS).filter((e) => e.kind !== "EndRun");
        writeFileSync(join(cut, "journal.jsonl"), entries.map(line).join(""));
        expect(() => aaReport(cut)).toThrow(/no EndRun/);
        const swapped = gradedRun("S", preregistrationHash(loadPrereg("S")));
        writeFileSync(
            join(swapped, "journal.jsonl"),
            journal(["host~aa", "host"], N_EVENTS).map(line).join(""),
        );
        expect(() => aaReport(swapped)).toThrow(/journaled order/);
    });

    test("a symlinked grade log is refused before GradeLog could repair its target", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const target = join(dir, "elsewhere.jsonl");
        const body = readFileSync(join(dir, "grades.jsonl"), "utf8").trimEnd();
        writeFileSync(target, body);
        rmSync(join(dir, "grades.jsonl"));
        symlinkSync(target, join(dir, "grades.jsonl"));
        expect(() => aaReport(dir)).toThrow(/grades\.jsonl is not a regular file/);
        expect(readFileSync(target, "utf8")).toBe(body);
    });

    test("a run path that is a symlink is refused before any file is written", () => {
        const real = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const link = `${real}-link`;
        symlinkSync(real, link);
        expect(() => aaReport(link)).toThrow(/is not a directory/);
        expect(existsSync(join(real, "lease.json"))).toBe(false);
        expect(existsSync(join(real, "aa.json"))).toBe(false);
    });

    test("refuses a pairing log missing a scheduled turn on both sides", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const kept = ["host", "host~aa"].map((a) => turn(a, "e-1", "same", 0));
        writeFileSync(join(dir, "pairing.jsonl"), kept.map(line).join(""));
        expect(() => aaReport(dir)).toThrow(/e-2, e-3/);
    });

    test("refuses a grade whose verdict is outside pass, fail, excluded", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const bogus = {
            ...grade("host", "p-1", "P3", "P3.delta_mem", 0),
            version: 2,
            verdict: "bogus",
        };
        appendFileSync(join(dir, "grades.jsonl"), `${JSON.stringify(bogus)}\n`);
        expect(() => aaReport(dir)).toThrow(/grades\.jsonl/);
    });

    test("probes the run reached but neither arm graded are counted as missing per arm", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const kept = readFileSync(join(dir, "grades.jsonl"), "utf8")
            .split("\n")
            .filter((l) => l !== "" && !l.includes('"item":"p-1"'));
        writeFileSync(join(dir, "grades.jsonl"), `${kept.join("\n")}\n`);
        const [report] = aaReport(dir);
        expect(report?.missing).toEqual({ host: 2, "host~aa": 2 });
        expect(report?.unpaired_items).toEqual([]);
    });

    test("P7 grades, judged against the host arm, stay out of the missingness diagnostics", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const judged = { ...grade("host", "j-1", "P7", "P7.score", 1), against: "eidnara" };
        appendFileSync(join(dir, "grades.jsonl"), `${JSON.stringify(judged)}\n`);
        const [report] = aaReport(dir);
        expect(report?.unpaired_items).toEqual([]);
        expect(report?.excluded).toEqual({ host: 0, "host~aa": 0 });
    });

    test("a P14 item whose session completed in the prefix counts as missing until graded", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const [report] = aaReport(dir);
        expect(report?.missing).toEqual({ host: 1, "host~aa": 1 });
    });

    test("refuses a turn whose session or index differs from its scheduled event's", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const moved = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const rows = [
            ...allTurns("host"),
            ...allTurns("host~aa").map((t) => (t.event === "e-2" ? { ...t, index: 7 } : t)),
        ];
        writeFileSync(join(moved, "pairing.jsonl"), rows.map(line).join(""));
        expect(() => aaReport(moved)).toThrow(/e-2.*index 7/);
        const strayed = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const other = [
            ...allTurns("host"),
            ...allTurns("host~aa"),
            turn("host~aa", "e-99", "same", 0),
        ];
        writeFileSync(join(strayed, "pairing.jsonl"), other.map(line).join(""));
        expect(() => aaReport(strayed)).toThrow(/e-99/);
    });

    test("refuses a grade for a probe the run's scheduled prefix never reached", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
        scenario.probes.push({ id: "z-1", type: "P3", fact: "fact-z" });
        writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
        const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        manifest.scenario_hash = scenarioHash(scenario);
        writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
        const stale = ["host", "host~aa"].map((a) => grade(a, "z-1", "P3", "P3.delta_mem", 0));
        appendFileSync(
            join(dir, "grades.jsonl"),
            stale.map((g) => `${JSON.stringify(g)}\n`).join(""),
        );
        expect(() => aaReport(dir)).toThrow(/z-1/);
    });

    test("refuses a second turn for an arm's event and a second divergence for an arm's session", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const twice = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const rows = [...allTurns("host"), ...allTurns("host~aa"), turn("host", "e-1", "same", 0)];
        writeFileSync(join(twice, "pairing.jsonl"), rows.map(line).join(""));
        expect(() => aaReport(twice)).toThrow(/host.*e-1.*twice/);
        const diverged = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const d = (index: number) => ({
            kind: "divergedAt",
            arm: "host~aa",
            session: "s-1",
            event: `e-${index + 1}`,
            index,
            digest: "d",
            context_sha256: "c",
            reference_digest: "r",
            against: "reference",
        });
        const twoD = [...allTurns("host"), ...allTurns("host~aa"), d(3), d(5)];
        writeFileSync(join(diverged, "pairing.jsonl"), twoD.map(line).join(""));
        expect(() => aaReport(diverged)).toThrow(/host~aa.*s-1.*twice/);
    });

    test("refuses an arm outside the tier's run and a manifest event count outside the scenario", () => {
        const foreign = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const m1 = JSON.parse(readFileSync(join(foreign, "manifest.json"), "utf8"));
        writeFileSync(
            join(foreign, "manifest.json"),
            JSON.stringify({ ...m1, order: ["host", "host~aa", "eidnara-cf"] }),
        );
        expect(() => aaReport(foreign)).toThrow(/eidnara-cf/);
        for (const events of [999, 0, 1.5, "3"]) {
            const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
            const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
            writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m, events }));
            expect(() => aaReport(dir)).toThrow(/manifest events/);
        }
    });

    test("a hard-linked grade log is refused before GradeLog could repair the shared inode", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const target = join(dir, "elsewhere.jsonl");
        const body = readFileSync(join(dir, "grades.jsonl"), "utf8").trimEnd();
        writeFileSync(target, body);
        rmSync(join(dir, "grades.jsonl"));
        linkSync(target, join(dir, "grades.jsonl"));
        expect(() => aaReport(dir)).toThrow(/grades\.jsonl/);
        expect(readFileSync(target, "utf8")).toBe(body);
    });

    test("each entry names the claim boundary that governs it", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const [report] = aaReport(dir);
        expect(report?.claim_boundary).toBe("sim-claim-boundary/v1");
    });

    test("a divergence row must carry the control turn's digest and a differing reference digest", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const d = (over: Record<string, unknown>) => ({
            kind: "divergedAt",
            arm: "host~aa",
            session: "s-1",
            event: "e-2",
            index: 1,
            digest: "d",
            context_sha256: "c",
            reference_digest: "r",
            against: "reference",
            ...over,
        });
        const base = [...allTurns("host"), ...allTurns("host~aa")];
        for (const bad of [
            d({ digest: "other" }),
            d({ reference_digest: "d" }),
            d({ reference_digest: "x" }),
        ]) {
            const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
            writeFileSync(
                join(dir, "pairing.jsonl"),
                ordered([...base, bad])
                    .map(line)
                    .join(""),
            );
            expect(() => aaReport(dir)).toThrow(/divergence/);
        }
        const sound = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const rows = [
            ...allTurns("host"),
            ...allTurns("host~aa").map((t) => (t.event === "e-2" ? { ...t, digest: "d2" } : t)),
            d({ digest: "d2", reference_digest: "d" }),
        ];
        writeFileSync(join(sound, "pairing.jsonl"), ordered(rows).map(line).join(""));
        expect(aaReport(sound)[0]?.sessions_diverged).toBe(1);
    });

    test("refuses a grade metric that is not a finite number", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const huge = { ...grade("host", "p-1", "P3", "P3.delta_mem", 0), version: 2 };
        const text = JSON.stringify(huge).replace('"P3.delta_mem":0', '"P3.delta_mem":1e400');
        appendFileSync(join(dir, "grades.jsonl"), `${text}\n`);
        expect(() => aaReport(dir)).toThrow(/P3\.delta_mem/);
    });

    test("a probe or paste turn whose text differs from the compiled script is refused on both arms", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
        scenario.events[0] = { ...scenario.events[0], role: "probe", text: "Where is the config?" };
        writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
        const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({ ...manifest, scenario_hash: scenarioHash(scenario) }),
        );
        const rows = ["host", "host~aa"].flatMap((a) =>
            allTurns(a).map((t) =>
                t.event === "e-1" ? { ...t, text_sha256: sha256Hex("altered") } : t,
            ),
        );
        writeFileSync(join(dir, "pairing.jsonl"), rows.map(line).join(""));
        expect(() => aaReport(dir)).toThrow(/e-1.*compiled/);
    });

    test("a divergence against a recorded run must cite a turn in a manifest tape's pairing log", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const recorded = (reference_digest: string) => ({
            kind: "divergedAt",
            arm: "host~aa",
            session: "s-1",
            event: "e-2",
            index: 1,
            digest: "d",
            context_sha256: "c",
            reference_digest,
            recorded_context_sha256: "c-src",
            against: "recorded",
        });
        const base = [...allTurns("host"), ...allTurns("host~aa")];
        const noTape = gradedRun("S", preregistrationHash(loadPrereg("S")));
        writeFileSync(
            join(noTape, "pairing.jsonl"),
            ordered([...base, recorded("old")])
                .map(line)
                .join(""),
        );
        expect(() => aaReport(noTape)).toThrow(/divergence at e-2/);
        const taped = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const source = mkdtempSync(join(tmpdir(), "sim-aa-source-"));
        writeFileSync(join(source, "tape.jsonl"), "");
        writeFileSync(
            join(source, "pairing.jsonl"),
            line({ ...turn("host~aa", "e-2", "same", 1), digest: "old", context_sha256: "c-src" }),
        );
        const m = JSON.parse(readFileSync(join(taped, "manifest.json"), "utf8"));
        const tapes = [join(source, "tape.jsonl")];
        writeFileSync(
            join(taped, "manifest.json"),
            JSON.stringify({ ...m, tapes, tape_sha256: tapeDigests(tapes) }),
        );
        writeFileSync(
            join(taped, "pairing.jsonl"),
            ordered([...base, recorded("other")])
                .map(line)
                .join(""),
        );
        expect(() => aaReport(taped)).toThrow(/divergence at e-2/);
        writeFileSync(
            join(taped, "pairing.jsonl"),
            ordered([...base, recorded("old")])
                .map(line)
                .join(""),
        );
        expect(aaReport(taped)[0]?.sessions_diverged).toBe(1);
    });

    test("refuses a grade log whose identities or version sequences are malformed", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const vs = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const stray = { ...grade("host", "p-1", "P3", "P3.delta_mem", 0), against: "eidnara" };
        appendFileSync(join(vs, "grades.jsonl"), line(stray));
        expect(() => aaReport(vs)).toThrow(/against/);
        const gap = gradedRun("S", preregistrationHash(loadPrereg("S")));
        appendFileSync(
            join(gap, "grades.jsonl"),
            line({ ...grade("host", "p-1", "P3", "P3.delta_mem", 0), version: 3 }),
        );
        expect(() => aaReport(gap)).toThrow(/version/);
        const dup = gradedRun("S", preregistrationHash(loadPrereg("S")));
        appendFileSync(
            join(dup, "grades.jsonl"),
            line(grade("host", "p-1", "P3", "P3.delta_mem", 5)),
        );
        expect(() => aaReport(dup)).toThrow(/version/);
    });

    test("a run path reached through a symlinked ancestor is refused before any write", () => {
        const real = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const parentLink = `${real}-parent`;
        symlinkSync(dirname(real), parentLink);
        const viaLink = join(parentLink, basename(real));
        expect(lstatSync(viaLink).isDirectory()).toBe(true);
        expect(() => aaReport(viaLink)).toThrow(/real path/);
        expect(existsSync(join(real, "lease.json"))).toBe(false);
    });

    test("a divergence may cite any manifest tape's recorded digest, in source order", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const sources = ["first", "second"].map((digest) => {
            const src = mkdtempSync(join(tmpdir(), `sim-aa-${digest}-`));
            writeFileSync(join(src, "tape.jsonl"), "");
            writeFileSync(
                join(src, "pairing.jsonl"),
                line({
                    ...turn("host~aa", "e-2", "same", 1),
                    digest,
                    context_sha256: `c-${digest}`,
                }),
            );
            return join(src, "tape.jsonl");
        });
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({ ...m, tapes: sources, tape_sha256: tapeDigests(sources) }),
        );
        const d = {
            kind: "divergedAt",
            arm: "host~aa",
            session: "s-1",
            event: "e-2",
            index: 1,
            digest: "d",
            context_sha256: "c",
            reference_digest: "first",
            recorded_context_sha256: "c-first",
            against: "recorded",
        };
        writeFileSync(
            join(dir, "pairing.jsonl"),
            ordered([...allTurns("host"), ...allTurns("host~aa"), d])
                .map(line)
                .join(""),
        );
        expect(aaReport(dir)[0]?.sessions_diverged).toBe(1);
    });

    test("refuses a metric whose paired differences or interval overflow", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const wide = [
            { ...grade("host", "p-1", "P3", "P3.delta_mem", -1e308), version: 2 },
            { ...grade("host~aa", "p-1", "P3", "P3.delta_mem", 1e308), version: 2 },
        ];
        appendFileSync(
            join(dir, "grades.jsonl"),
            wide.map((g) => `${JSON.stringify(g)}\n`).join(""),
        );
        expect(() => aaReport(dir)).toThrow(/P3\.delta_mem.*finite/);
    });

    test("replay sources must still hash to the manifest's tape digests", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const src = mkdtempSync(join(tmpdir(), "sim-aa-tape-"));
        writeFileSync(join(src, "tape.jsonl"), "");
        writeFileSync(
            join(src, "pairing.jsonl"),
            line({ ...turn("host~aa", "e-2", "same", 1), digest: "old" }),
        );
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        const tapes = [join(src, "tape.jsonl")];
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({ ...m, tapes, tape_sha256: ["0000"] }),
        );
        expect(() => aaReport(dir)).toThrow(/replay sources/);
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({ ...m, tapes, tape_sha256: tapeDigests(tapes) }),
        );
        expect(aaReport(dir)).toHaveLength(1);
    });

    test("refuses a paired item whose two grades carry different metric keys", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const narrow = { ...grade("host~aa", "p-1", "P3", "P3.delta_mem", 1), version: 2 };
        delete (narrow.metrics as Record<string, unknown>)["P3.delta_mem"];
        appendFileSync(join(dir, "grades.jsonl"), `${JSON.stringify(narrow)}\n`);
        expect(() => aaReport(dir)).toThrow(/p-1.*P3\.delta_mem/);
    });

    test("a run without an A/A control yields no report", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m, order: ["host"] }));
        writeFileSync(join(dir, "journal.jsonl"), journal(["host"], N_EVENTS).map(line).join(""));
        writeFileSync(join(dir, "pairing.jsonl"), allTurns("host").map(line).join(""));
        const kept = readFileSync(join(dir, "grades.jsonl"), "utf8")
            .split("\n")
            .filter((l) => l.includes('"arm":"host"'));
        writeFileSync(join(dir, "grades.jsonl"), `${kept.join("\n")}\n`);
        expect(() => aaReport(dir)).toThrow(/no A\/A control/);
        expect(existsSync(join(dir, "aa.json"))).toBe(false);
    });

    test("refuses a journal whose terminated last line is corrupt", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        appendFileSync(join(dir, "journal.jsonl"), "not-json\n");
        expect(() => aaReport(dir)).toThrow(/journal\.jsonl.*corrupt/);
    });

    test("refuses a paired item whose shared metric holds different value types", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const bad = { ...grade("host~aa", "p-1", "P3", "P3.delta_mem", 1), version: 2 };
        (bad.metrics as Record<string, unknown>)["P3.delta_mem"] = "bad";
        appendFileSync(join(dir, "grades.jsonl"), `${JSON.stringify(bad)}\n`);
        expect(() => aaReport(dir)).toThrow(/p-1.*P3\.delta_mem/);
    });

    test("a grade must name the arm's journaled first snapshot of its item, from a turn that ended ok", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const stale = gradedRun("S", preregistrationHash(loadPrereg("S")));
        appendFileSync(
            join(stale, "grades.jsonl"),
            line({
                ...grade("host", "p-1", "P3", "P3.delta_mem", 0),
                version: 2,
                snapshot: "host:p-1:old",
            }),
        );
        expect(() => aaReport(stale)).toThrow(/p-1.*snapshot/);
        const failed = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const entries = journal(["host", "host~aa"], N_EVENTS).map((e) =>
            e.kind === "EndTurn" && e.arm === "host~aa" && e.event === "e-1"
                ? { ...e, outcome: "error" }
                : e,
        );
        writeFileSync(join(failed, "journal.jsonl"), entries.map(line).join(""));
        expect(() => aaReport(failed)).toThrow(/p-1.*snapshot/);
    });

    test("every paired turn has exactly one journaled UserTurn with the same delivery", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const lost = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const entries = journal(["host", "host~aa"], N_EVENTS).filter(
            (e) => !(e.kind === "UserTurn" && e.arm === "host~aa" && e.event === "e-2"),
        );
        writeFileSync(join(lost, "journal.jsonl"), entries.map(line).join(""));
        expect(() => aaReport(lost)).toThrow(/host~aa.*e-2.*UserTurn/);
        const undelivered = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const flipped = journal(["host", "host~aa"], N_EVENTS).map((e) =>
            e.kind === "UserTurn" && e.arm === "host~aa" && e.event === "e-2"
                ? { ...e, delivered: false }
                : e,
        );
        writeFileSync(join(undelivered, "journal.jsonl"), flipped.map(line).join(""));
        expect(() => aaReport(undelivered)).toThrow(/host~aa.*e-2.*UserTurn/);
    });

    test("a recorded divergence is a context no source holds; its digest may equal the control's", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const src = mkdtempSync(join(tmpdir(), "sim-aa-src-"));
        writeFileSync(join(src, "tape.jsonl"), "");
        writeFileSync(
            join(src, "pairing.jsonl"),
            line({ ...turn("host~aa", "e-2", "same", 1), digest: "d", context_sha256: "c-src" }),
        );
        const tapes = [join(src, "tape.jsonl")];
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({ ...m, tapes, tape_sha256: tapeDigests(tapes) }),
        );
        const d = (over: Record<string, unknown>) => ({
            kind: "divergedAt",
            arm: "host~aa",
            session: "s-1",
            event: "e-2",
            index: 1,
            digest: "d",
            context_sha256: "c",
            reference_digest: "d",
            recorded_context_sha256: "c-src",
            against: "recorded",
            ...over,
        });
        const base = [...allTurns("host"), ...allTurns("host~aa")];
        writeFileSync(
            join(dir, "pairing.jsonl"),
            ordered([...base, d({})])
                .map(line)
                .join(""),
        );
        expect(aaReport(dir)[0]?.sessions_diverged).toBe(1);
        for (const bad of [
            d({ recorded_context_sha256: "c-other" }),
            d({ context_sha256: "c-src" }),
        ]) {
            const rows = base.map((t) =>
                bad.context_sha256 === "c-src" && t.arm === "host~aa" && t.event === "e-2"
                    ? { ...t, context_sha256: "c-src" }
                    : t,
            );
            writeFileSync(
                join(dir, "pairing.jsonl"),
                ordered([...rows, bad])
                    .map(line)
                    .join(""),
            );
            expect(() => aaReport(dir)).toThrow(/divergence at e-2/);
        }
    });

    test("a recovered UserTurn is no delivery evidence", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const entries = journal(["host", "host~aa"], N_EVENTS).map((e) =>
            e.kind === "UserTurn" && e.arm === "host~aa" && e.event === "e-2"
                ? { ...e, recovered: true }
                : e,
        );
        writeFileSync(join(dir, "journal.jsonl"), entries.map(line).join(""));
        expect(() => aaReport(dir)).toThrow(/host~aa.*e-2.*UserTurn/);
    });

    test("a snapshot counts as ok only through its own arm's EndTurn at the probe's event", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const entries = journal(["host", "host~aa"], N_EVENTS).map((e) =>
            e.kind === "EndTurn" && e.arm === "host~aa" && e.event === "e-1"
                ? { ...e, outcome: "error", snapshot: "host~aa:p-1:failed" }
                : e.kind === "EndTurn" && e.arm === "host~aa" && e.event === "e-3"
                  ? { ...e, snapshot: "host~aa:p-1" }
                  : e,
        );
        writeFileSync(join(dir, "journal.jsonl"), entries.map(line).join(""));
        expect(() => aaReport(dir)).toThrow(/host~aa\/p-1.*snapshot/);
    });

    test("the run arms follow the seed's pre-registered relative order", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        const order = ["eidnara", "host", "host~aa"];
        writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...m, order }));
        writeFileSync(join(dir, "journal.jsonl"), journal(order, N_EVENTS).map(line).join(""));
        expect(() => aaReport(dir)).toThrow(/seed 101/);
    });

    test("a script-sourced turn of any role must carry the compiled text", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const rows = ["host", "host~aa"].flatMap((a) =>
            allTurns(a).map((t) =>
                t.event === "e-2" ? { ...t, text_sha256: sha256Hex("edited") } : t,
            ),
        );
        writeFileSync(join(dir, "pairing.jsonl"), rows.map(line).join(""));
        expect(() => aaReport(dir)).toThrow(/e-2.*compiled/);
    });

    test("a metric value is a boolean or a finite number, and <type>.pass is the verdict", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const text = { ...grade("host", "p-1", "P3", "P3.delta_mem", 0), version: 2 };
        (text.metrics as Record<string, unknown>)["P3.delta_mem"] = "7";
        appendFileSync(join(dir, "grades.jsonl"), `${JSON.stringify(text)}\n`);
        expect(() => aaReport(dir)).toThrow(/P3\.delta_mem/);
        const lying = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const g = { ...grade("host", "p-1", "P3", "P3.delta_mem", 0), version: 2, verdict: "fail" };
        appendFileSync(join(lying, "grades.jsonl"), `${JSON.stringify(g)}\n`);
        expect(() => aaReport(lying)).toThrow(/P3\.pass/);
    });

    test("a seed the tier does not pre-register is refused", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
        const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8"));
        scenario.manifest.seed = 999;
        writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
        writeFileSync(
            join(dir, "manifest.json"),
            JSON.stringify({ ...m, seed: 999, scenario_hash: scenarioHash(scenario) }),
        );
        expect(() => aaReport(dir)).toThrow(/seed 999/);
    });

    test("digests that differ at a control turn require a divergence row at or before it", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const rows = [
            ...allTurns("host"),
            ...allTurns("host~aa").map((t) => (t.event === "e-3" ? { ...t, digest: "d3" } : t)),
        ];
        writeFileSync(join(dir, "pairing.jsonl"), rows.map(line).join(""));
        expect(() => aaReport(dir)).toThrow(/e-3.*divergence/);
    });

    test("the grader's categorical P3.reliance is admitted and left out of the pairing", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const rows = ["host", "host~aa"].map((a) => {
            const g = { ...grade(a, "p-1", "P3", "P3.delta_mem", 0), version: 2 };
            (g.metrics as Record<string, unknown>)["P3.reliance"] = "stale";
            return g;
        });
        appendFileSync(
            join(dir, "grades.jsonl"),
            rows.map((g) => `${JSON.stringify(g)}\n`).join(""),
        );
        const [report] = aaReport(dir);
        expect(report?.metrics.map((m) => m.metric)).not.toContain("P3.reliance");
        expect(report?.metrics.find((m) => m.metric === "P3.delta_mem")?.n).toBe(6);
    });

    test("a grade without a snapshot, for an item with no ok snapshot, is refused", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const entries = journal(["host", "host~aa"], N_EVENTS).filter(
            (e) => !(e.kind === "SnapshotArtefacts" && e.arm === "host~aa" && e.item === "p-1"),
        );
        writeFileSync(join(dir, "journal.jsonl"), entries.map(line).join(""));
        const bare = { ...grade("host~aa", "p-1", "P3", "P3.delta_mem", 1), version: 2 } as Record<
            string,
            unknown
        >;
        delete bare.snapshot;
        appendFileSync(join(dir, "grades.jsonl"), line(bare));
        expect(() => aaReport(dir)).toThrow(/host~aa\/p-1.*snapshot/);
    });

    test("a divergence row precedes the turn it describes", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const d = {
            kind: "divergedAt",
            arm: "host~aa",
            session: "s-1",
            event: "e-2",
            index: 1,
            digest: "d2",
            context_sha256: "c",
            reference_digest: "d",
            against: "reference",
        };
        const control = allTurns("host~aa").map((t) =>
            t.event === "e-2" ? { ...t, digest: "d2" } : t,
        );
        const late = [...allTurns("host"), ...control, d];
        writeFileSync(join(dir, "pairing.jsonl"), late.map(line).join(""));
        expect(() => aaReport(dir)).toThrow(/divergence at e-2.*after/);
        const early = [...allTurns("host"), ...control.slice(0, 1), d, ...control.slice(1)];
        writeFileSync(join(dir, "pairing.jsonl"), early.map(line).join(""));
        expect(aaReport(dir)[0]?.sessions_diverged).toBe(1);
    });

    test("an undelivered trailing filler carries the empty text, as the runner records it", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        // Eight single-turn task sessions after s-1 give the plan an abandon quota of one; s-1,
        // whose trailing filler e-12 makes it the one abandonable session, receives it.
        const extra = [2, 3, 4, 5, 6, 7, 8, 9];
        withRole(dir, "e-12", "filler", [
            ...extra.flatMap((k) => [
                {
                    id: `x-${k}`,
                    kind: "user_turn",
                    session: `s-${k}`,
                    index: 0,
                    role: "task",
                    text: SCRIPT_TEXT,
                },
                { id: `y-${k}`, kind: "session_end", session: `s-${k}` },
            ]),
        ]);
        const skip = (t: ReturnType<typeof turn>) =>
            t.event === "e-12"
                ? { ...t, label: "abandon", delivered: false, text_sha256: sha256Hex("") }
                : t;
        const extraTurns = (arm: string) =>
            extra.map((k) => ({ ...turn(arm, `x-${k}`, "same", 0), session: `s-${k}` }));
        const rows = ["host", "host~aa"].flatMap((arm) => [
            ...allTurns(arm).map(skip),
            ...extraTurns(arm),
        ]);
        writeFileSync(join(dir, "pairing.jsonl"), rows.map(line).join(""));
        const entries = journal(["host", "host~aa"], N_EVENTS).flatMap((e) => {
            if (e.kind === "UserTurn" && e.event === "e-12") {
                return [{ ...e, label: "abandon", delivered: false }];
            }
            if (e.kind !== "EndArm") return [e];
            return [
                ...extra.flatMap((k) => [
                    {
                        kind: "UserTurn",
                        arm: e.arm,
                        event: `x-${k}`,
                        session: `s-${k}`,
                        label: "task",
                        delivered: true,
                        scenario_ms: 0,
                    },
                    { kind: "Event", arm: e.arm, event: `x-${k}`, scenario_ms: 0 },
                    { kind: "Event", arm: e.arm, event: `y-${k}`, scenario_ms: 0 },
                ]),
                e,
            ];
        });
        writeFileSync(join(dir, "journal.jsonl"), rerated(entries).map(line).join(""));
        expect(aaReport(dir)).toHaveLength(1);
    });

    test("a pairing turn's label matches its journaled UserTurn and agrees with its source", () => {
        const line = (o: unknown) => `${JSON.stringify(o)}\n`;
        const relabeled = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const rows = ["host", "host~aa"].flatMap((a) =>
            allTurns(a).map((t) => (t.event === "e-2" ? turn(a, "e-2", "edited", 1) : t)),
        );
        writeFileSync(join(relabeled, "pairing.jsonl"), rows.map(line).join(""));
        expect(() => aaReport(relabeled)).toThrow(/e-2.*label/);
        const inconsistent = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const odd = ["host", "host~aa"].flatMap((a) =>
            allTurns(a).map((t) => (t.event === "e-2" ? { ...t, source: "live" } : t)),
        );
        writeFileSync(join(inconsistent, "pairing.jsonl"), odd.map(line).join(""));
        expect(() => aaReport(inconsistent)).toThrow(/e-2.*source/);
    });

    test("a run-level family forms one cluster per run, so one run leaves it uninformative", () => {
        const dir = gradedRun("S", preregistrationHash(loadPrereg("S")));
        const [report] = aaReport(dir);
        const by = new Map(report?.metrics.map((m) => [m.metric, m]));
        expect(by.get("P3.delta_mem")?.clusters).toBe(6);
        expect(by.get("P13.fold_fidelity_score")?.clusters).toBe(1);
        expect(by.get("P13.pass")?.clusters).toBe(1);
        expect(report?.uninformative).toEqual(["P13.pass", "P13.fold_fidelity_score"]);
        expect(report?.prereg_sha256).toBe(preregistrationHash(loadPrereg("S")));
    });

    test("one run's report carries no claim, whatever the tier plans to repeat", () => {
        const dir = gradedRun("M", preregistrationHash(loadPrereg("M")));
        const [report] = aaReport(dir);
        expect(report).not.toHaveProperty("descriptive");
    });
});
