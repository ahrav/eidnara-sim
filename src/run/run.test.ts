import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SimConfig } from "../config/config";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import { GENERATOR_VERSION, type Scenario } from "../scenario/compile";
import { type FaultEpisode, SEAMS } from "../scenario/faults";
import { loadPrereg } from "../scenario/inputs";
import type { Preflight } from "./preflight";
import {
    faultOverride,
    loadManifest,
    loadScenario,
    type RunOptions,
    requireOutsideCheckout,
    runSteps,
} from "./run";

const ROOT = join(import.meta.dir, "..", "..");
const dir = () => mkdtempSync(join(tmpdir(), "sim-run-"));
const config = { eidnara_checkout: ROOT, bedrock: { aws_profile: "", region: "" } } as SimConfig;

function scenarioBody(seed = 101, tier = "S") {
    return {
        schema: "test",
        manifest: {
            seed,
            tier,
            generator_version: GENERATOR_VERSION,
            embedding_model: loadPrereg("S").scenario.cue_probe_similarity.embedding_model,
            corpus_manifest_sha256: sha256Hex(
                readFileSync(join(ROOT, "corpus/manifest.json"), "utf8"),
            ),
        },
        projects: [],
        sessions: [
            { id: "s-0000", requests: 2 },
            { id: "s-0001", requests: 1 },
        ],
        events: [{ id: "e-000000", kind: "session_start", scenario_ms: 0, session: "s-0000" }],
        faults: [],
    };
}

function writeScenario(out: string, body: Record<string, unknown>, hash?: string) {
    const scenario = { ...body, scenario_hash: hash ?? sha256Hex(canonicalJson(body)) };
    writeFileSync(join(out, "scenario.json"), canonicalJson(scenario));
    return scenario as unknown as Scenario;
}

describe("teardown", () => {
    test("every step runs in reverse order and the first failure is rethrown", async () => {
        const ran: string[] = [];
        const steps = [
            () => void ran.push("lease"),
            async () => {
                ran.push("journal");
                throw new Error("journal close failed");
            },
            async () => {
                ran.push("proxy");
                throw new Error("faults.jsonl failed");
            },
            () => void ran.push("driver"),
        ];
        await expect(runSteps(steps)).rejects.toThrow("faults.jsonl failed");
        expect(ran).toEqual(["driver", "proxy", "journal", "lease"]);
        await expect(runSteps([() => undefined])).resolves.toBeUndefined();
    });
});

describe("run inputs", () => {
    test("an output directory inside the Eidnara checkout, directly or via a symlink, is refused", () => {
        const root = dir();
        const checkout = join(root, "eidnara");
        mkdirSync(join(checkout, "target"), { recursive: true });
        symlinkSync(checkout, join(root, "link"));
        expect(() => requireOutsideCheckout(join(checkout, "runs/x"), checkout)).toThrow(
            /inside the Eidnara checkout/,
        );
        expect(() => requireOutsideCheckout(checkout, checkout)).toThrow(/inside/);
        expect(() => requireOutsideCheckout(join(root, "link/runs/x"), checkout)).toThrow(/inside/);
        expect(() => requireOutsideCheckout(join(root, "eidnara-runs/x"), checkout)).not.toThrow();
        expect(() => requireOutsideCheckout(join(root, "runs/x"), checkout)).not.toThrow();
    });

    test("scenario.json is refused when its body no longer hashes to its scenario_hash", async () => {
        const out = dir();
        const good = writeScenario(out, scenarioBody());
        const o = { config, out, seed: 101, tier: "S" as const };
        expect((await loadScenario(o)).scenario_hash).toBe(good.scenario_hash);
        const altered = { ...scenarioBody(), events: [] };
        writeScenario(out, altered, good.scenario_hash);
        await expect(loadScenario(o)).rejects.toThrow(/does not hash to its scenario_hash/);
    });

    test("scenario.json from another generator is refused for reuse", async () => {
        const out = dir();
        const body = scenarioBody();
        writeScenario(out, {
            ...body,
            manifest: { ...body.manifest, generator_version: "sim-scenario/v1" },
        });
        const o = { config, out, seed: 101, tier: "S" as const };
        await expect(loadScenario(o)).rejects.toThrow(/from generator sim-scenario\/v1/);
    });

    test("scenario.json compiled from other inputs than the pre-registration names is refused", async () => {
        for (const manifest of [
            { embedding_model: "local-hash-256/v1" },
            { corpus_manifest_sha256: "0".repeat(64) },
        ]) {
            const out = dir();
            const body = scenarioBody();
            writeScenario(out, { ...body, manifest: { ...body.manifest, ...manifest } });
            const o = { config, out, seed: 101, tier: "S" as const };
            await expect(loadScenario(o)).rejects.toThrow(
                /scenario\.json was compiled (with|from)/,
            );
        }
    });

    test("a fault override must be an array of episodes valid against the compiled scenario", () => {
        const scenario = writeScenario(dir(), scenarioBody());
        const episode: FaultEpisode = {
            id: "f",
            type: "model_switch",
            strategy: "single",
            trigger: { kind: "user_turn", session: "s-0000", n: 2 },
            params: {},
            seam: SEAMS.model_switch,
        };
        expect(faultOverride([episode], scenario)).toEqual([episode]);
        expect(() => faultOverride({}, scenario)).toThrow(/must hold an array/);
        expect(() => faultOverride([{ id: 1 }], scenario)).toThrow(/is malformed/);
        const late = { ...episode, trigger: { kind: "user_turn", session: "s-0001", n: 2 } };
        expect(() => faultOverride([late], scenario)).toThrow(/outside the session's 1 turns/);
        const lost = { ...episode, trigger: { kind: "session_start", session: "s-9999" } };
        expect(() => faultOverride([lost], scenario)).toThrow(/unknown session/);
    });

    test("a resume is refused when the selected host's preflight identity changed", async () => {
        const out = dir();
        const scenario = writeScenario(out, scenarioBody());
        const checks: Preflight = {
            launcher: join(out, "launcher"),
            time_injection: [{ name: "node", intercepted: true }] as never,
            distortions: [],
            hosts: [{ host: "pi", version: "0.80.2", transcript_paths: ["a"] }],
            toolchain: [],
        };
        const o: RunOptions = { config, tier: "S", seed: 101, host: "pi", out };
        const first = await loadManifest(o, scenario, checks);
        expect(first.preflight.hosts[0]?.version).toBe("0.80.2");
        await expect(loadManifest(o, scenario, checks)).resolves.toMatchObject({ seed: 101 });
        const upgraded = {
            ...checks,
            hosts: [{ host: "pi" as const, version: "0.81.0", transcript_paths: ["a"] }],
        };
        await expect(loadManifest(o, scenario, upgraded)).rejects.toThrow(
            /the pi host changed since the run started/,
        );
    });
});
