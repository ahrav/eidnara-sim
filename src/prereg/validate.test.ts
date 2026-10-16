import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAIM_BOUNDARY, checkReport, type FamilyVerdict, type TierReport } from "./report";
import { type Preregistration, REQUIRED_FAMILIES, TIERS } from "./schema";
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

    test("refuses an unknown field whose name is an Object.prototype key", () => {
        const prereg = load("M") as any;
        prereg.toString = 1;
        prereg.families[3].constructor = "x";
        const errors = validatePreregistration(prereg);
        expect(errors).toContain("toString: unknown field");
        expect(errors).toContain("families[probe-P4].constructor: unknown field");
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
                "aa_controls.pairs: expected host/host and eidnara/eidnara",
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
                "arms.order_by_seed: every arm runs first for exactly one seed",
                "arms.order_by_seed: every arm runs once in every position",
            ].sort(),
        );
    });

    test("requires both hosts, three forced p90 sessions, and the five harm metrics", () => {
        const prereg = load("S") as any;
        prereg.hosts = ["pi"];
        prereg.scenario.forced_p90_sessions = 2;
        expect(validatePreregistration(prereg).sort()).toEqual([
            "hosts: expected pi and opencode",
            "scenario.forced_p90_sessions: at least 3",
        ]);
        const m = load("M") as any;
        m.families.find((f: any) => f.id === "harm").metrics[4] = "P12.harm";
        expect(validatePreregistration(m)).toEqual([
            "families[harm]: the harm family is Holm-corrected over exactly P2.harm, P3.harm, P4.harm, P10.harm, P11.harm",
        ]);
    });

    test("compares sets element by element, never by a joined string", () => {
        const s = load("S") as any;
        s.hosts = ["opencode,pi"];
        expect(validatePreregistration(s)).toEqual(["hosts: expected pi and opencode"]);
        const m = load("M") as any;
        m.families.find((f: any) => f.id === "harm").metrics = [
            "P2.harm",
            "P3.harm",
            "P4.harm",
            "P10.harm,P11.harm",
        ];
        expect(validatePreregistration(m)).toEqual([
            "families[harm]: the harm family is Holm-corrected over exactly P2.harm, P3.harm, P4.harm, P10.harm, P11.harm",
        ]);
    });

    test("binds the harm CUSUM to the harm family, zero-tolerance gates to counts, and the normaliser set", () => {
        const m = load("M") as any;
        m.stopping_rule.cusum[0].metric = "cost";
        const intr = m.families.find((f: any) => f.id === "intrusiveness");
        intr.margin.scale = "ms";
        intr.mde.scale = "ms";
        expect(validatePreregistration(m).sort()).toEqual(
            [
                "stopping_rule.cusum[0].metric: a harm CUSUM monitors the harm family",
                "families[intrusiveness].margin.scale: a zero-tolerance gate counts events",
            ].sort(),
        );
        const s = load("S") as any;
        s.divergence_policy.normalisation = ["run-ids"];
        expect(validatePreregistration(s)).toEqual([
            "divergence_policy.normalisation: expected iso-8601-timestamps, durations, pids, temp-paths, run-ids",
        ]);
    });

    test("requires eidnara-kl at S, M, and L and eidnara-cf exactly at L", () => {
        const m = load("M") as any;
        m.arms.run = ["host", "eidnara"];
        m.arms.order_by_seed = [
            ["host", "eidnara"],
            ["eidnara", "host"],
            ["host", "eidnara"],
        ];
        expect(validatePreregistration(m)).toContain(
            "arms.run: tier M runs exactly host, eidnara, eidnara-kl",
        );
        const l = load("L") as any;
        l.arms.run = ["host", "eidnara", "eidnara-kl"];
        l.arms.order_by_seed = l.arms.order_by_seed.map((o: string[]) =>
            o.filter((a) => a !== "eidnara-cf"),
        );
        expect(validatePreregistration(l)).toContain(
            "arms.run: tier L runs exactly host, eidnara, eidnara-kl, eidnara-cf",
        );
        const s = load("S") as any;
        s.arms.run.push("eidnara-cf");
        s.arms.order_by_seed = s.arms.order_by_seed.map((o: string[]) => [...o, "eidnara-cf"]);
        expect(validatePreregistration(s)).toEqual([
            "arms.run: tier S runs exactly host, eidnara, eidnara-kl",
        ]);
        const xl = load("XL") as any;
        xl.arms.run.push("eidnara-kl");
        xl.arms.order_by_seed = [["host", "eidnara", "eidnara-kl"]];
        expect(validatePreregistration(xl)).toEqual([
            "arms.run: tier XL runs exactly host, eidnara",
        ]);
    });

    test("requires distinct seed orders and, when seeds cover the arms, a balanced first position", () => {
        const m = load("M") as any;
        m.arms.order_by_seed = [
            m.arms.order_by_seed[0],
            m.arms.order_by_seed[0],
            m.arms.order_by_seed[0],
        ];
        expect(validatePreregistration(m).sort()).toEqual(
            [
                "arms.order_by_seed: seeds share an arm order",
                "arms.order_by_seed: every arm runs first for exactly one seed",
                "arms.order_by_seed: every arm runs once in every position",
            ].sort(),
        );
        m.arms.order_by_seed = [
            ["host", "eidnara", "eidnara-kl"],
            ["host", "eidnara-kl", "eidnara"],
            ["eidnara-kl", "host", "eidnara"],
        ];
        expect(validatePreregistration(m)).toEqual([
            "arms.order_by_seed: every arm runs first for exactly one seed",
            "arms.order_by_seed: every arm runs once in every position",
        ]);
        m.arms.order_by_seed = [
            ["host", "eidnara", "eidnara-kl"],
            ["eidnara", "host", "eidnara-kl"],
            ["eidnara-kl", "host", "eidnara"],
        ];
        expect(validatePreregistration(m)).toEqual([
            "arms.order_by_seed: every arm runs once in every position",
        ]);
    });

    test("refuses incompatible margin and MDE scales, a nonzero zero-tolerance margin, and a non-positive CUSUM threshold", () => {
        const m = load("M") as any;
        const fam = (id: string) => m.families.find((f: any) => f.id === id);
        fam("latency").mde.scale = "bytes";
        fam("intrusiveness").margin.value = "5";
        fam("probe-P8").mde.scale = "ratio";
        expect(validatePreregistration(m).sort()).toEqual(
            [
                "families[latency].mde.scale: bytes is not comparable with the ms margin",
                "families[intrusiveness].margin.value: a zero-tolerance gate has a margin of 0",
            ].sort(),
        );
        const l = load("L") as any;
        l.stopping_rule.cusum[0].h = "0";
        expect(validatePreregistration(l)).toEqual([
            "stopping_rule.cusum[0].h: expected a positive canonical decimal",
        ]);
    });

    test("requires bootstrap replicates inside eval-core's 40 to 10000", () => {
        const s = load("S") as any;
        s.bootstrap.replicates = 39;
        expect(validatePreregistration(s)).toEqual(["bootstrap.replicates: expected 40 to 10000"]);
        s.bootstrap.replicates = 10001;
        expect(validatePreregistration(s)).toEqual(["bootstrap.replicates: expected 40 to 10000"]);
    });

    test("ties the interval method to the outcome, a superiority MDE to a positive value, and the resources margin to c", () => {
        const m = load("M") as any;
        const fam = (id: string) => m.families.find((f: any) => f.id === id);
        fam("probe-P1").outcome = "slope";
        fam("probe-P5").mde.value = "0";
        fam("latency").cluster_key = "ledger_fact_id";
        m.leak_bound.c_bytes_per_session = 1;
        const l = load("L") as any;
        const res = l.families.find((f: any) => f.id === "resources");
        res.margin.scale = "count";
        res.mde.scale = "count";
        expect(validatePreregistration(l)).toEqual([
            "families[resources].margin: the resources margin is leak_bound.c_bytes_per_session in bytes",
        ]);
        expect(validatePreregistration(m).sort()).toEqual(
            [
                "families[probe-P1].interval_method: exact-mcnemar-newcombe-cluster-bootstrap does not analyse a slope outcome",
                "families[probe-P5].mde.value: a superiority family detects a positive effect",
                "families[latency].cluster_key: a run-level family clusters by run",
                "families[resources].margin: the resources margin is leak_bound.c_bytes_per_session in bytes",
            ].sort(),
        );
    });

    test("keeps the forced p90 sessions within one project's sessions", () => {
        const s = load("S") as any;
        s.scenario.forced_p90_sessions = s.scenario.sessions_per_project + 1;
        expect(validatePreregistration(s)).toEqual([
            `scenario.forced_p90_sessions: exceeds the ${s.scenario.sessions_per_project} sessions a project holds`,
        ]);
    });

    test("requires both A/A control pairs and five M repeats", () => {
        const prereg = load("M") as any;
        prereg.aa_controls.pairs = [["host", "host"]];
        prereg.aa_controls.repeats = 1;
        expect(validatePreregistration(prereg).sort()).toEqual([
            "aa_controls.pairs: expected host/host and eidnara/eidnara",
            "aa_controls.repeats: M repeats each A/A pair at least 5 times",
        ]);
        const s = load("S") as any;
        s.aa_controls.pairs.push(["eidnara-kl", "eidnara-kl"]);
        expect(validatePreregistration(s)).toEqual([
            "aa_controls.pairs: expected host/host and eidnara/eidnara",
        ]);
    });

    test("refuses a P11 false-positive weight other than two", () => {
        const prereg = load("S") as any;
        prereg.scoring.p11_false_positive_weight = "0";
        expect(validatePreregistration(prereg)).toEqual([
            'scoring.p11_false_positive_weight: expected "2"',
        ]);
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

/** A report every check accepts: each family carries a verdict its claim and direction allow. */
function acceptedReport(prereg: Preregistration): TierReport {
    const verdict = (f: Preregistration["families"][number]) =>
        f.claim === "descriptive"
            ? "descriptive"
            : f.direction === "superiority-two-sided"
              ? "better"
              : "passed-gate";
    return {
        tier: prereg.tier,
        claim_boundary: CLAIM_BOUNDARY,
        prereg_hash: preregistrationHash(prereg),
        families: prereg.families.map((f) => ({
            family: f.id,
            verdict: verdict(f),
            n: f.analysis_unit === "run" ? prereg.seeds.length * prereg.hosts.length : 24,
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

    test("requires a resolution ratio exactly on a null verdict", () => {
        const r = acceptedReport(m);
        at(r, "probe-P1").verdict = "no-difference-above-x-pp-detectable-at-n";
        at(r, "probe-P2").resolution_ratio = "0.5";
        expect(checkReport(r, m)).toEqual([
            "families[probe-P1].resolution_ratio: a null verdict carries its resolution ratio as a positive canonical decimal; other verdicts omit it",
            "families[probe-P2].resolution_ratio: a null verdict carries its resolution ratio as a positive canonical decimal; other verdicts omit it",
        ]);
        at(r, "probe-P1").resolution_ratio = "0.5";
        delete at(r, "probe-P2").resolution_ratio;
        expect(checkReport(r, m)).toEqual([]);
    });

    test("a superiority family never reports failed-gate", () => {
        const r = acceptedReport(m);
        Object.assign(at(r, "probe-P1"), {
            verdict: "failed-gate",
            failed_metric: m.families.find((f) => f.id === "probe-P1")!.metrics[0],
            failed_items: ["P1-01"],
        });
        expect(checkReport(r, m)).toEqual([
            "families[probe-P1].verdict: a superiority-two-sided family reports better, worse, no-difference-above-x-pp-detectable-at-n, inconclusive, or insufficient-runs",
        ]);
    });

    test("refuses an unknown field on the report or a verdict by name", () => {
        const r = acceptedReport(m) as any;
        r.conclusion = "equivalent";
        (at(r, "probe-P1") as any).note = "x";
        expect(checkReport(r, m)).toEqual([
            "conclusion: unknown field",
            "families[probe-P1].note: unknown field",
        ]);
    });

    test("a margin gate fails as failed-gate naming its metric, never as worse", () => {
        const r = acceptedReport(m);
        at(r, "dependability").verdict = "worse";
        at(r, "harm").verdict = "no-difference-above-x-pp-detectable-at-n";
        at(r, "harm").resolution_ratio = "0.5";
        expect(checkReport(r, m)).toEqual([
            "families[harm].verdict: a noninferiority gate reports passed-gate, failed-gate, inconclusive, or insufficient-runs",
            "families[dependability].verdict: a at-most gate reports passed-gate, failed-gate, inconclusive, or insufficient-runs",
        ]);
    });

    test("a claim-bearing verdict needs at least one observation", () => {
        const r = acceptedReport(m);
        at(r, "probe-P1").n = 0;
        at(r, "resources").n = 0;
        at(r, "cost").n = 0;
        expect(checkReport(r, m)).toEqual([
            "families[probe-P1].n: a better verdict rests on at least one observation",
            "families[resources].n: a passed-gate verdict rests on at least one observation",
        ]);
    });

    test("caps n at the paired items or paired runs the pre-registration produces", () => {
        const r = acceptedReport(m);
        at(r, "probe-P1").n = 121;
        at(r, "harm").n = 120;
        at(r, "dependability").n = 7;
        expect(checkReport(r, m)).toEqual([
            "families[probe-P1].n: exceeds the 120 paired items the tier issues",
            "families[dependability].n: exceeds the 6 paired runs the tier produces",
        ]);
    });

    test("requires a positive detectable effect and resolution ratio on a null verdict", () => {
        const r = acceptedReport(m);
        Object.assign(at(r, "probe-P1"), {
            verdict: "no-difference-above-x-pp-detectable-at-n",
            mde: "0",
            resolution_ratio: "0",
        });
        expect(checkReport(r, m)).toEqual([
            "families[probe-P1].mde: a null verdict states a positive detectable effect",
            "families[probe-P1].resolution_ratio: a null verdict carries its resolution ratio as a positive canonical decimal; other verdicts omit it",
        ]);
    });

    test("refuses a verdict without n or without an MDE by name", () => {
        const r = acceptedReport(m);
        delete (at(r, "probe-P1") as Partial<FamilyVerdict>).n;
        delete (at(r, "harm") as Partial<FamilyVerdict>).mde;
        expect(checkReport(r, m)).toEqual([
            "families[probe-P1].n: missing",
            "families[harm].mde: expected a canonical decimal string",
        ]);
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

    test("refuses a report without the claim-boundary version", () => {
        const { claim_boundary: _, ...r } = acceptedReport(s);
        expect(checkReport(r, s)).toEqual(['claim_boundary: expected "sim-claim-boundary/v1"']);
        expect(checkReport({ ...r, claim_boundary: "sim-claim-boundary/v2" }, s)).toEqual([
            'claim_boundary: expected "sim-claim-boundary/v1"',
        ]);
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
            "families[latency].verdict: a at-most gate reports passed-gate, failed-gate, inconclusive, or insufficient-runs",
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
        at(r, "latency").verdict = "passed-gate";
        expect(checkReport(r, m)).toEqual([]);
    });

    test("a bound gate takes its verdict at any n and never reports insufficient-runs", () => {
        const r = acceptedReport(s);
        at(r, "dependability").n = 1;
        expect(checkReport(r, s)).toEqual([]);
        at(r, "dependability").verdict = "insufficient-runs";
        expect(checkReport(r, s)).toEqual([
            "families[dependability].verdict: a zero-tolerance gate compares each run to a bound and reports passed-gate or failed-gate",
            "families[dependability].verdict: insufficient-runs is the verdict exactly when n is below 2",
        ]);
    });

    test("passed-gate belongs to bound and margin gates; better to superiority alone", () => {
        const r = acceptedReport(m);
        at(r, "intrusiveness").verdict = "better";
        at(r, "resources").verdict = "no-difference-above-x-pp-detectable-at-n";
        at(r, "probe-P1").verdict = "passed-gate";
        at(r, "dependability").verdict = "better";
        at(r, "harm").verdict = "better";
        expect(checkReport(r, m)).toEqual([
            "families[probe-P1].verdict: a superiority-two-sided family reports better, worse, no-difference-above-x-pp-detectable-at-n, inconclusive, or insufficient-runs",
            "families[harm].verdict: a noninferiority gate reports passed-gate, failed-gate, inconclusive, or insufficient-runs",
            "families[dependability].verdict: a at-most gate reports passed-gate, failed-gate, inconclusive, or insufficient-runs",
            "families[resources].verdict: a threshold gate compares each run to a bound and reports passed-gate or failed-gate",
            "families[resources].resolution_ratio: a null verdict carries its resolution ratio as a positive canonical decimal; other verdicts omit it",
            "families[intrusiveness].verdict: a zero-tolerance gate compares each run to a bound and reports passed-gate or failed-gate",
        ]);
        Object.assign(at(r, "intrusiveness"), {
            verdict: "failed-gate",
            failed_metric: m.families.find((f) => f.id === "intrusiveness")!.metrics[0],
            failed_items: ["run-1"],
        });
        at(r, "resources").verdict = "passed-gate";
        at(r, "probe-P1").verdict = "better";
        at(r, "dependability").verdict = "inconclusive";
        at(r, "harm").verdict = "passed-gate";
        expect(checkReport(r, m)).toEqual([]);
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
        for (const items of [[], [""], ["  "]]) {
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
        at(r, "probe-P1").verdict = JSON.parse('{"toString":null,"valueOf":null}');
        const errors = checkReport(r, s);
        expect(errors).toContain("families[probe-P1].verdict: expected a verdict kind");
        const odd = JSON.parse('{"tier":{"toString":null,"valueOf":null},"families":[]}');
        expect(checkReport(odd, s)).toContain("tier: expected a tier name");
        const m0 = acceptedReport(m) as any;
        at(m0, "dependability").n = JSON.parse('{"toString":null,"valueOf":null}');
        expect(checkReport(m0, m)).toContain("families[dependability].n: missing");
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
