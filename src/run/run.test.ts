import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SimConfig } from "../config/config";
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
});
