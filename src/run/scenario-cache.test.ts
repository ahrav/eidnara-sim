import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { GENERATOR_VERSION } from "../scenario/compile";
import { loadScenario } from "./run";

const stale = (manifest: object) => {
    const out = mkdtempSync(join(tmpdir(), "sim-scenario-cache-"));
    writeFileSync(
        join(out, "scenario.json"),
        JSON.stringify({ manifest: { seed: 101, tier: "S", ...manifest }, events: [] }),
    );
    return out;
};

test("a cached scenario compiled from other inputs is refused for a new run", async () => {
    const config = loadConfig();
    const out = stale({
        generator_version: GENERATOR_VERSION,
        corpus_manifest_sha256: "0".repeat(64),
        prereg_sha256: "0".repeat(64),
    });
    await expect(loadScenario({ config, tier: "S", seed: 101, out })).rejects.toThrow(
        /corpus_manifest_sha256|prereg_sha256/,
    );
    writeFileSync(join(out, "manifest.json"), "{}");
    await expect(loadScenario({ config, tier: "S", seed: 101, out })).resolves.toMatchObject({
        events: [],
    });
});
