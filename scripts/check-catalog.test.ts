import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCatalog, methodFields, SIM_IDS } from "./check-catalog";

const ROOT = join(import.meta.dir, "..");
const METHOD = join(ROOT, "docs/properties/METHOD.md");
const IDS = SIM_IDS;

let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

function copy(): string {
    dir = mkdtempSync(join(tmpdir(), "catalog-"));
    cpSync(join(ROOT, "docs/properties/sim-v2"), dir, { recursive: true });
    return join(dir, "catalog.md");
}

function edit(path: string, from: string | RegExp, to: string): void {
    const text = readFileSync(path, "utf8");
    const next = text.replace(from, to);
    if (next === text) throw new Error(`edit found no ${from}`);
    writeFileSync(path, next);
}

describe("catalog checker", () => {
    test("reads the record field order from METHOD.md", () => {
        expect(methodFields(readFileSync(METHOD, "utf8")).map((f) => f.name)).toEqual([
            "Type",
            "Reachability",
            "Status",
            "Exercised",
            "Guarantee",
            "Check",
            "Fault/timing angle",
            "Required faults and enabling state",
            "Confidence",
            "Existing check",
            "Impact",
            "Open questions",
        ]);
    });

    test("accepts the sim-v2 catalog with 77 proposed records and 3 liveness records", () => {
        expect(checkCatalog(copy(), METHOD, IDS)).toEqual([]);
    });

    test("refuses a record whose fields are out of METHOD order", () => {
        const path = copy();
        edit(
            path,
            "Type: safety\nReachability: default-production\n",
            "Reachability: default-production\nType: safety\n",
        );
        expect(checkCatalog(path, METHOD, IDS)[0]).toContain("differ from METHOD order");
    });

    test("refuses an unknown check semantics and a value outside the METHOD set", () => {
        const path = copy();
        edit(path, "Check: `always` - two", "Check: `eventually` - two");
        edit(path, "Type: reachability", "Type: coverage");
        const errors = checkCatalog(path, METHOD, IDS);
        expect(errors.some((e) => e.includes("Check semantics eventually"))).toBe(true);
        expect(errors.some((e) => e.includes("Type value coverage"))).toBe(true);
    });

    test("refuses an Exercised or Confidence value outside the METHOD set", () => {
        const path = copy();
        edit(
            path,
            "Exercised: not yet - the harness surface lands in M2",
            "Exercised: maybe - the harness surface lands in M2",
        );
        edit(path, "Confidence: low - [evidence]", "Confidence: unknown - [evidence]");
        const errors = checkCatalog(path, METHOD, IDS);
        expect(errors.some((e) => e.includes("Exercised value maybe not in METHOD set"))).toBe(
            true,
        );
        expect(errors.some((e) => e.includes("Confidence value unknown not in METHOD set"))).toBe(
            true,
        );
    });

    test("refuses a record whose Guarantee carries another record's id", () => {
        const path = copy();
        edit(path, "Guarantee: SIM-P02:", "Guarantee: SIM-P03:");
        expect(checkCatalog(path, METHOD, IDS)).toContain(
            "catalog: SIM-P02 absent from its Guarantee",
        );
    });

    test("refuses an index row whose displayed id is not the slug's prefix", () => {
        const path = copy();
        edit(path, "| SIM-P01 | [sim-p01-", "| SIM-P77 | [sim-p01-");
        expect(checkCatalog(path, METHOD, IDS)).toContain(
            "catalog: index row SIM-P77 links sim-p01-scenario-compile-is-deterministic",
        );
    });

    test("refuses a blank Open questions field", () => {
        const path = copy();
        edit(path, "Open questions: None.", "Open questions:");
        expect(checkCatalog(path, METHOD, IDS)).toContain(
            "sim-p01-scenario-compile-is-deterministic: Open questions is neither None. nor a list",
        );
    });

    test("refuses an index row whose type, check, or reachability differs from its record", () => {
        const path = copy();
        edit(
            path,
            "| SIM-P01 | [sim-p01-scenario-compile-is-deterministic](#sim-p01-scenario-compile-is-deterministic) | safety | `always` | default-production |",
            "| SIM-P01 | [sim-p01-scenario-compile-is-deterministic](#sim-p01-scenario-compile-is-deterministic) | liveness | `unreachable` | test-only |",
        );
        expect(checkCatalog(path, METHOD, IDS)).toContain(
            "catalog: index row SIM-P01 reads liveness, `unreachable`, test-only; the record reads safety, `always`, default-production",
        );
    });

    test("refuses an index row whose link is malformed", () => {
        const path = copy();
        edit(
            path,
            "| SIM-P02 | [sim-p02-",
            "| SIM-P99 | [sim-p99-extra](#sim-p99-other) | safety | `always` | test-only | M0 |\n| SIM-P02 | [sim-p02-",
        );
        expect(checkCatalog(path, METHOD, IDS)).toContain(
            "catalog: index row malformed: | SIM-P99 | [sim-p99-extra](#sim-p99-other) | safety | `always` | test-only | M0 |",
        );
    });

    test("refuses a blank free-text field", () => {
        const path = copy();
        edit(path, /Impact: [^\n]*\n(?:[^\n]+\n)*?(?=Open questions:)/, "Impact:\n");
        expect(checkCatalog(path, METHOD, IDS)).toContain(
            "sim-p01-scenario-compile-is-deterministic: Impact is blank",
        );
    });

    test("refuses an empty open-question list entry", () => {
        const path = copy();
        edit(path, "Open questions: None.", "Open questions:\n- ");
        expect(checkCatalog(path, METHOD, IDS)).toContain(
            "sim-p01-scenario-compile-is-deterministic: Open questions has an empty entry",
        );
    });

    test("refuses a Guarantee that carries its id and no claim", () => {
        const path = copy();
        edit(path, /Guarantee: SIM-P01:[^\n]*\n(?:[^\n]+\n)*?(?=Check:)/, "Guarantee: SIM-P01:\n");
        expect(checkCatalog(path, METHOD, IDS)).toContain(
            "catalog: SIM-P01 Guarantee states no claim",
        );
    });

    test("refuses a record without its evidence file and an id that is missing", () => {
        const path = copy();
        unlinkSync(join(dir, "evidence/sim-p05-scheduled-events-identical-across-arms.md"));
        edit(path, /### sim-p77-two-hosts-one-store-attributed[\s\S]*?(?=\n## Liveness)/, "");
        const errors = checkCatalog(path, METHOD, IDS);
        expect(errors).toContain(
            "sim-p05-scheduled-events-identical-across-arms: evidence/sim-p05-scheduled-events-identical-across-arms.md missing",
        );
        expect(errors).toContain("catalog: id SIM-P77 appears 0 times");
        expect(errors).toContain("catalog: index rows differ from records");
    });
});
