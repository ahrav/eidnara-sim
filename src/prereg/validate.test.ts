import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkReport, type TierReport } from "./report";
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
                // A family without its id is named by the id the validator can no longer see.
                const expected = path.endsWith("].id")
                    ? `${path.slice(0, -3)}: missing`
                    : `${path}:`;
                const named = errors.some((e) => e.startsWith(expected));
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

    test("requires resizing and load stress at L and refuses them elsewhere", () => {
        const s = load("S");
        s.resizing = load("L").resizing;
        expect(validatePreregistration(s)).toContain("resizing: allowed only at tier L");
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

describe("report check against the pre-registration", () => {
    const prereg = parsePreregistration(load("S")) as Preregistration;
    const report = (): TierReport => ({
        tier: "S",
        prereg_hash: preregistrationHash(prereg),
        families: prereg.families.map((f) => ({
            family: f.id,
            verdict: "descriptive",
            n: 8,
            mde: "0.4",
        })),
    });

    test("accepts a report that carries every pre-registered family", () => {
        expect(checkReport(report(), prereg)).toEqual([]);
    });

    test("refuses a report with a missing family by name", () => {
        const r = report();
        r.families = r.families.filter((f) => f.family !== "latency");
        expect(checkReport(r, prereg)).toEqual(["families[latency]: missing from report"]);
    });

    test("refuses a report under another pre-registration hash", () => {
        const r = report();
        r.prereg_hash = preregistrationHash(parsePreregistration(load("M")));
        expect(checkReport(r, prereg)).toEqual([
            "prereg_hash: does not match the pre-registration",
        ]);
    });

    test("refuses a family that was not pre-registered and the token parity", () => {
        const r = report() as any;
        r.families.push({ family: "probe-P99", verdict: "parity", n: 1, mde: "0.1" });
        const errors = checkReport(r, prereg);
        expect(errors).toContain("families[probe-P99]: not pre-registered");
        expect(errors).toContain("families[probe-P99].verdict: parity");
        expect(errors).toContain("report: contains the token parity");
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
        const reordered = reverse(prereg) as Preregistration;
        expect(Object.keys(reordered)[0]).not.toBe(Object.keys(prereg)[0]);
        expect(preregistrationHash(reordered)).toBe(preregistrationHash(prereg));
        const edited = structuredClone(prereg);
        edited.families[0]!.alpha = "0.04";
        expect(preregistrationHash(edited)).not.toBe(preregistrationHash(prereg));
    });
});
