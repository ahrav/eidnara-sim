import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import { preregistrationHash } from "../prereg/validate";
import { GENERATOR_VERSION } from "../scenario/compile";
import { compileInputsHash, corpusManifestHash, loadPrereg } from "../scenario/inputs";
import { loadScenario } from "./run";

const stale = (manifest: object) => {
    const out = mkdtempSync(join(tmpdir(), "sim-scenario-cache-"));
    const body = { manifest: { seed: 101, tier: "S", ...manifest }, events: [] };
    writeFileSync(
        join(out, "scenario.json"),
        JSON.stringify({ ...body, scenario_hash: sha256Hex(canonicalJson(body)) }),
    );
    return out;
};

test("a cached scenario compiled from other inputs is refused for a new run", async () => {
    const config = loadConfig();
    const out = stale({
        generator_version: GENERATOR_VERSION,
        corpus_manifest_sha256: "0".repeat(64),
        compile_inputs_sha256: "0".repeat(64),
        prereg_sha256: "0".repeat(64),
    });
    await expect(loadScenario({ config, tier: "S", seed: 101, out })).rejects.toThrow(
        /corpus_manifest_sha256, compile_inputs_sha256, prereg_sha256/,
    );
    const facts = stale({
        generator_version: GENERATOR_VERSION,
        corpus_manifest_sha256: corpusManifestHash(),
        compile_inputs_sha256: "0".repeat(64),
        prereg_sha256: preregistrationHash(loadPrereg("S")),
    });
    await expect(loadScenario({ config, tier: "S", seed: 101, out: facts })).rejects.toThrow(
        /\(compile_inputs_sha256\)/,
    );
    writeFileSync(join(out, "manifest.json"), "{}");
    await expect(loadScenario({ config, tier: "S", seed: 101, out })).resolves.toMatchObject({
        events: [],
    });
});

test("a cached scenario whose body no longer hashes to its own scenario_hash is refused", async () => {
    const config = loadConfig();
    const out = mkdtempSync(join(tmpdir(), "sim-scenario-cache-"));
    const body = {
        manifest: {
            seed: 101,
            tier: "S",
            generator_version: GENERATOR_VERSION,
            corpus_manifest_sha256: corpusManifestHash(),
            compile_inputs_sha256: compileInputsHash(),
            prereg_sha256: preregistrationHash(loadPrereg("S")),
        },
        events: [],
    };
    const hash = sha256Hex(canonicalJson(body));
    writeFileSync(join(out, "scenario.json"), JSON.stringify({ ...body, scenario_hash: hash }));
    await expect(loadScenario({ config, tier: "S", seed: 101, out })).resolves.toMatchObject({
        events: [],
    });
    writeFileSync(
        join(out, "scenario.json"),
        JSON.stringify({ ...body, events: [{ id: "e-1" }], scenario_hash: hash }),
    );
    await expect(loadScenario({ config, tier: "S", seed: 101, out })).rejects.toThrow(
        /scenario_hash/,
    );
});
