import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SimConfig } from "../config/config";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import { loadScenario } from "./run";
import { HarnessFailure } from "./scheduler";

describe("scenario loading", () => {
    test("an L scenario compiles only with the resized count the tier command records", async () => {
        const out = mkdtempSync(join(tmpdir(), "sim-l-"));
        const config = {} as SimConfig;
        await expect(loadScenario({ config, tier: "L", seed: 301, out })).rejects.toThrow(
            HarnessFailure,
        );
        await expect(loadScenario({ config, tier: "L", seed: 301, out })).rejects.toThrow(
            /resizing/,
        );
    });

    test("a cached scenario compiled for another item count is refused with the resized count", async () => {
        const out = mkdtempSync(join(tmpdir(), "sim-l-"));
        const body = { manifest: { seed: 301, tier: "L", probes_per_type: 25 }, events: [] };
        writeFileSync(
            join(out, "scenario.json"),
            canonicalJson({ ...body, scenario_hash: sha256Hex(canonicalJson(body)) }),
        );
        const config = {} as SimConfig;
        await expect(loadScenario({ config, tier: "L", seed: 301, out }, 300)).rejects.toThrow(
            /probes_per_type 25/,
        );
    });
});
