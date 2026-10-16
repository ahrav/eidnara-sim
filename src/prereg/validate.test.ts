import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkReport, type TierReport } from "./report";
import { needsPairedRuns, type Preregistration, REQUIRED_FAMILIES, TIERS } from "./schema";
import { parsePreregistration, preregistrationHash, validatePreregistration } from "./validate";

const PREREG_DIR = join(import.meta.dir, "../../prereg");

function load(tier: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(PREREG_DIR, `${tier}.json`), "utf8"));
}

/** Every field path in the file, with families named by id and other array items by index. */
function fieldPaths(value: unknown, path = ""): string[] {
    if (Array.isArray(value)) {
        return value.flatMap((item, i) => {
            const id = (item as { id?: unknown })?.id;
            const at = `${path}[${typeof id === "string" ? id : i}]`;
            return typeof item === "object" && item !== null ? fieldPaths(item, at) : [];
        });
    }
    if (typeof value !== "object" || value === null) return [];
    return Object.entries(value).flatMap(([key, child]) => {
        const at = path === "" ? key : `${path}.${key}`;
        return [at, ...fieldPaths(child, at)];
    });
}

function without(root: Record<string, unknown>, path: string): Record<string, unknown> {
    const copy = structuredClone(root);
    const parts = path.match(/[^.[\]]+/g) ?? [];
    let node: any = copy;
    for (const part of parts.slice(0, -1)) {
        node = Array.isArray(node)
            ? (node.find((x: any) => x.id === part) ?? node[Number(part)])
            : node[part];
    }
    const last = parts.at(-1) as string;
    if (Array.isArray(node)) {
        const index = node.findIndex((x: any) => x.id === last);
        node.splice(index >= 0 ? index : Number(last), 1);
    } else delete node[last];
    return copy;
}

describe("pre-registration validator", () => {
    for (const tier of TIERS) {
        test(`accepts the frozen ${tier} pre-registration`, () => {
            const prereg = load(tier);
            expect(validatePreregistration(prereg)).toEqual([]);
            expect(prereg.tier).toBe(tier);
        });

        test(`refuses the ${tier} file by field name when any required field is removed`, () => {
            const prereg = load(tier);
            const paths = fieldPaths(prereg).filter(
                (p) => !/^stopping_rule\.cusum\[\d+\]$/.test(p),
            );
            expect(paths.length).toBeGreaterThan(100);
            for (const path of paths) {
                const errors = validatePreregistration(without(prereg, path));
                // The validator identifies a family by its array index when its id is missing.
                const named = path.endsWith("].id")
                    ? errors.some((e) => /^families\[\d+\]\.id: missing$/.test(e))
                    : errors.some((e) => e.startsWith(`${path}:`));
                if (!named) throw new Error(`removing ${path} gave ${JSON.stringify(errors)}`);
            }
        });
    }

    test("refuses a missing family by name", () => {
        const errors = validatePreregistration(without(load("M"), "families[harm]"));
        expect(errors).toContain("families[harm]: missing");
    });

    test("refuses a seed outside the unsigned 32-bit range of the random streams", () => {
        const prereg = load("S") as any;
        prereg.seeds[0] = 2 ** 32;
        prereg.arms.order_by_seed.length = prereg.seeds.length;
        expect(validatePreregistration(prereg)).toContain(
            "seeds: expected an integer in [0, 4294967295]",
        );
    });

    test("refuses a pooled item count the seed-host runs cannot split evenly", () => {
        const prereg = load("S") as any;
        prereg.stopping_rule.paired_items_per_probe_type = 25;
        expect(validatePreregistration(prereg)).toContain(
            "stopping_rule.paired_items_per_probe_type: 25 is not a multiple of the 4 seed-host runs",
        );
    });

    test("refuses an embedding model the compiler cannot construct", () => {
        const prereg = load("S") as any;
        prereg.scenario.cue_probe_similarity.embedding_model = "amazon.titan-embed-text-v1";
        expect(validatePreregistration(prereg)).toContain(
            "scenario.cue_probe_similarity.embedding_model: expected one of amazon.titan-embed-text-v2:0",
        );
    });

    test("refuses fewer than three forced p90 sessions", () => {
        const prereg = load("S") as any;
        prereg.scenario.forced_p90_sessions = 2;
        expect(validatePreregistration(prereg)).toContain(
            "scenario.forced_p90_sessions: expected an integer of at least 3",
        );
    });

    test("refuses a similarity ceiling whose decimal exceeds 1 by less than double precision", () => {
        const prereg = load("S") as any;
        prereg.scenario.cue_probe_similarity.cosine_max = "1.0000000000000000001";
        expect(validatePreregistration(prereg)).toContain(
            "scenario.cue_probe_similarity.cosine_max: expected a canonical decimal in [0, 1]",
        );
    });

    test("accepts the boundary similarity ceilings 0 and 1", () => {
        const prereg = load("S") as any;
        prereg.scenario.cue_probe_similarity.bm25_max = "0";
        prereg.scenario.cue_probe_similarity.cosine_max = "1";
        expect(validatePreregistration(prereg)).toEqual([]);
    });

    test("refuses a run-level statistical gate below six paired runs", () => {
        const prereg = load("M") as any;
        prereg.families.find((f: any) => f.id === "dependability").min_paired_runs = 5;
        expect(validatePreregistration(prereg)).toContain(
            "families[dependability].min_paired_runs: a run-level gate needs at least 6",
        );
    });

    test("refuses a harm family that is not Holm-corrected over five metrics", () => {
        const prereg = load("L") as any;
        prereg.families.find((f: any) => f.id === "harm").multiplicity = "none";
        expect(validatePreregistration(prereg).some((e) => e.startsWith("families[harm]:"))).toBe(
            true,
        );
    });

    test("requires each tier-scoped section at its tiers and refuses it elsewhere", () => {
        const s = load("S");
        s.resizing = load("L").resizing;
        expect(validatePreregistration(s)).toContain("resizing: allowed only at tier L");
        const l = load("L");
        l.aa_controls = load("M").aa_controls;
        expect(validatePreregistration(l)).toContain("aa_controls: allowed only at tier S, M");
    });

    test("refuses an unknown field at any depth by name", () => {
        const prereg = load("M") as any;
        prereg.extra = 1;
        prereg.families[3].alpah = "0.05";
        const errors = validatePreregistration(prereg);
        expect(errors).toContain("extra: unknown field");
        expect(errors).toContain("families[probe-P4].alpah: unknown field");
    });

    test("refuses a claim, direction, and interval that contradict each other", () => {
        const prereg = load("M") as any;
        const fam = (id: string) => prereg.families.find((f: any) => f.id === id);
        fam("probe-P1").interval_method = "none";
        fam("cost").claim = "gate";
        fam("probe-P2").direction = "noninferiority";
        prereg.aa_controls.pairs[0] = ["host", "eidnara"];
        prereg.aa_controls.pairs[1] = ["eidnara-cf", "eidnara-cf"];
        expect(validatePreregistration(prereg).sort()).toEqual(
            [
                "families[probe-P1].interval_method: a superiority-two-sided family needs a paired interval",
                "families[cost].claim: a descriptive claim and a descriptive direction go together",
                "families[probe-P2].claim: a descriptive claim and a descriptive direction go together",
                "aa_controls.pairs[0]: expected one run arm twice",
                "aa_controls.pairs[1]: expected one run arm twice",
            ].sort(),
        );
    });

    test("refuses cross-field contradictions by name", () => {
        const prereg = load("M") as any;
        prereg.stopping_rule.cusum[0].metric = "harms";
        prereg.families.find((f: any) => f.id === "cost").min_paired_runs = 7;
        prereg.families.find((f: any) => f.id === "intrusiveness").interval_method =
            "paired-sign-test";
        prereg.arms.order_by_seed[1] = ["host", "eidnara"];
        expect(validatePreregistration(prereg).sort()).toEqual(
            [
                "stopping_rule.cusum[0].metric: names no family",
                "families[cost].min_paired_runs: exceeds the 6 paired runs the tier produces",
                "families[intrusiveness].interval_method: a zero-tolerance gate compares each run to a bound and takes none",
                "arms.order_by_seed[1]: is not a permutation of arms.run",
            ].sort(),
        );
    });

    test("refuses a non-canonical decimal and an alpha outside (0, 1)", () => {
        const prereg = load("S") as any;
        prereg.families[0].alpha = "0.050";
        prereg.families[1].margin.value = 0.1;
        const errors = validatePreregistration(prereg);
        expect(errors).toContain(
            "families[probe-P1].alpha: expected a canonical decimal in (0, 1)",
        );
        expect(errors).toContain(
            "families[probe-P2].margin.value: expected a canonical decimal string",
        );
    });

    test("every tier names every required family", () => {
        for (const tier of TIERS) {
            const ids = (parsePreregistration(load(tier)).families ?? []).map((f) => f.id);
            expect(ids.sort()).toEqual([...REQUIRED_FAMILIES].sort());
        }
    });
});

/** A report every check accepts: each family carries a verdict its claim allows. */
function acceptedReport(prereg: Preregistration): TierReport {
    return {
        tier: prereg.tier,
        prereg_hash: preregistrationHash(prereg),
        families: prereg.families.map((f) => ({
            family: f.id,
            verdict: f.claim === "descriptive" ? "descriptive" : "better",
            n: needsPairedRuns(f) ? f.min_paired_runs : 24,
            mde: "1",
        })),
    };
}

describe("report check against the pre-registration", () => {
    const s = parsePreregistration(load("S"));
    const m = parsePreregistration(load("M"));
    const at = (r: TierReport, id: string) => r.families.find((f) => f.family === id)!;

    test("accepts a report that carries every pre-registered family with an allowed verdict", () => {
        expect(checkReport(acceptedReport(s), s)).toEqual([]);
        expect(checkReport(acceptedReport(m), m)).toEqual([]);
    });

    test("refuses a report with a missing family by name", () => {
        const r = acceptedReport(s);
        r.families = r.families.filter((f) => f.family !== "latency");
        expect(checkReport(r, s)).toEqual(["families[latency]: missing from report"]);
    });

    test("refuses a report under another pre-registration hash", () => {
        const r = acceptedReport(s);
        r.prereg_hash = preregistrationHash(m);
        expect(checkReport(r, s)).toEqual(["prereg_hash: does not match the pre-registration"]);
    });

    test("refuses a family that was not pre-registered and a repeated family", () => {
        const r = acceptedReport(s) as any;
        r.families.push({ family: "probe-P99", verdict: "descriptive", n: 1, mde: "0.1" });
        r.families.push({ ...r.families[0] });
        expect(checkReport(r, s)).toEqual([
            "families[probe-P99]: not pre-registered",
            "families[probe-P1]: duplicate",
        ]);
    });

    test("refuses the token parity anywhere in the report, in any case", () => {
        const r = acceptedReport(s) as any;
        r.families[0].mde = "Parity";
        expect(checkReport(r, s)).toContain("report: contains the token parity");
    });

    test("refuses a gate reported as descriptive and a descriptive family reported as a gate", () => {
        const r = acceptedReport(m);
        at(r, "latency").verdict = "descriptive";
        at(r, "cost").verdict = "better";
        expect(checkReport(r, m)).toEqual([
            "families[latency].verdict: a gate family cannot report descriptive",
            "families[cost].verdict: a descriptive family cannot report better",
        ]);
    });

    test("requires insufficient-runs exactly when a paired run gate is below its floor", () => {
        const r = acceptedReport(m);
        at(r, "dependability").n = 5;
        at(r, "latency").verdict = "insufficient-runs";
        expect(checkReport(r, m)).toEqual([
            "families[dependability].verdict: insufficient-runs is the verdict exactly when n is below 6",
            "families[latency].verdict: insufficient-runs is the verdict exactly when n is below 6",
        ]);
        at(r, "dependability").verdict = "insufficient-runs";
        at(r, "latency").verdict = "better";
        expect(checkReport(r, m)).toEqual([]);
    });

    test("a bound gate takes its verdict at any n and never reports insufficient-runs", () => {
        const r = acceptedReport(s);
        at(r, "dependability").n = 1;
        expect(checkReport(r, s)).toEqual([]);
        at(r, "dependability").verdict = "insufficient-runs";
        expect(checkReport(r, s)).toEqual([
            "families[dependability].verdict: insufficient-runs is the verdict exactly when n is below 2",
        ]);
    });

    test("requires a failed gate to name one of its metrics and its failing items", () => {
        const r = acceptedReport(m);
        Object.assign(at(r, "harm"), {
            verdict: "failed-gate",
            failed_metric: "P99.harm",
            failed_items: ["P3-07"],
        });
        Object.assign(at(r, "probe-P1"), { failed_items: [] });
        at(r, "probe-P5").mde = "0.10";
        expect(checkReport(r, m)).toEqual([
            "families[probe-P1]: failed-gate names one of the family's metrics and its failing items; other verdicts neither",
            "families[probe-P5].mde: expected a canonical decimal string",
            "families[harm]: failed-gate names one of the family's metrics and its failing items; other verdicts neither",
        ]);
        at(r, "harm").failed_metric = "P3.harm";
        delete at(r, "probe-P1").failed_items;
        for (const items of [[], [""]]) {
            at(r, "harm").failed_items = items;
            at(r, "probe-P5").mde = "0.1";
            expect(checkReport(r, m)).toEqual([
                "families[harm]: failed-gate names one of the family's metrics and its failing items; other verdicts neither",
            ]);
        }
        at(r, "harm").failed_items = ["P3-07"];
        at(r, "probe-P5").mde = "0.1";
        expect(checkReport(r, m)).toEqual([]);
    });

    test("refuses malformed report shapes with named errors, never a throw", () => {
        expect(checkReport({ tier: "S", prereg_hash: "x" }, s)).toEqual([
            "families: expected an array",
        ]);
        const r = acceptedReport(s) as any;
        r.families.push(null, {});
        const errors = checkReport(r, s);
        expect(errors).toContain(
            `families[${s.families.length}]: expected a verdict object with a family`,
        );
        expect(errors).toContain(
            `families[${s.families.length + 1}]: expected a verdict object with a family`,
        );
    });

    test("the hash is stable under key order and changes with any value", () => {
        const reverse = (v: unknown): unknown =>
            Array.isArray(v)
                ? v.map(reverse)
                : v && typeof v === "object"
                  ? Object.fromEntries(
                        Object.entries(v)
                            .reverse()
                            .map(([k, c]) => [k, reverse(c)]),
                    )
                  : v;
        const reordered = reverse(s) as Preregistration;
        expect(Object.keys(reordered)[0]).not.toBe(Object.keys(s)[0]);
        expect(preregistrationHash(reordered)).toBe(preregistrationHash(s));
        const edited = structuredClone(s);
        edited.families[0]!.alpha = "0.04";
        expect(preregistrationHash(edited)).not.toBe(preregistrationHash(s));
    });
});
