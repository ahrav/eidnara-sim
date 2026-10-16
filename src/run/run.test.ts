import { describe, expect, test } from "bun:test";
import {
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SimConfig } from "../config/config";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import type { Scenario } from "../scenario/compile";
import { type FaultEpisode, SEAMS } from "../scenario/faults";
import type { Preflight } from "./preflight";
import {
    corpusIdentity,
    faultOverride,
    loadManifest,
    loadScenario,
    type RunOptions,
    requireDeclaredProjects,
    requireMechanisms,
    requireOutsideCheckout,
    requirePlainArtifacts,
    runSteps,
    treeIdentity,
} from "./run";

const ROOT = join(import.meta.dir, "..", "..");
const dir = () => mkdtempSync(join(tmpdir(), "sim-run-"));
const bins = dir();
const piInstall = join(bins, "pi");
mkdirSync(join(piInstall, "node_modules/@earendil-works/pi-coding-agent/dist"), {
    recursive: true,
});
writeFileSync(join(piInstall, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), "pi 1");
writeFileSync(join(bins, "daemon"), "daemon 1");
writeFileSync(join(bins, "opencode"), "opencode 1");
const config = {
    eidnara_checkout: ROOT,
    daemon_binary: join(bins, "daemon"),
    opencode_binary: join(bins, "opencode"),
    pi_install: piInstall,
    agent_model: "m",
    bedrock: { aws_profile: "", region: "" },
} as SimConfig;

function scenarioBody(seed = 101, tier = "S") {
    return {
        schema: "test",
        manifest: { seed, tier },
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
            /overlaps the Eidnara checkout/,
        );
        expect(() => requireOutsideCheckout(checkout, checkout)).toThrow(/overlaps/);
        expect(() => requireOutsideCheckout(join(root, "link/runs/x"), checkout)).toThrow(
            /overlaps/,
        );
        expect(() => requireOutsideCheckout(root, checkout)).toThrow(/overlaps/);
        expect(() => requireOutsideCheckout(join(root, "eidnara-runs/x"), checkout)).not.toThrow();
        expect(() => requireOutsideCheckout(join(root, "runs/x"), checkout)).not.toThrow();
    });

    test("a symlinked run artifact in an accepted output directory is refused", () => {
        const root = dir();
        const out = join(root, "run");
        mkdirSync(join(out, "eidnara"), { recursive: true });
        writeFileSync(join(root, "elsewhere.jsonl"), "");
        expect(() => requirePlainArtifacts(out, ["host", "eidnara"])).not.toThrow();
        symlinkSync(join(root, "elsewhere.jsonl"), join(out, "journal.jsonl"));
        expect(() => requirePlainArtifacts(out, ["host", "eidnara"])).toThrow(
            /journal.jsonl is a symlink/,
        );
        rmSync(join(out, "journal.jsonl"));
        symlinkSync(join(root, "missing"), join(out, "eidnara", "resources.jsonl"));
        expect(() => requirePlainArtifacts(out, ["host", "eidnara"])).toThrow(
            /resources.jsonl is a symlink/,
        );
        rmSync(join(out, "eidnara", "resources.jsonl"));
        symlinkSync(join(root, "elsewhere-dir"), join(out, "host"));
        expect(() => requirePlainArtifacts(out, ["host", "eidnara"])).toThrow(/host is a symlink/);
        rmSync(join(out, "host"));
        linkSync(join(root, "elsewhere.jsonl"), join(out, "calls.jsonl"));
        expect(() => requirePlainArtifacts(out, ["host", "eidnara"])).toThrow(/has 2 links/);
        rmSync(join(out, "calls.jsonl"));
        writeFileSync(join(out, `lease.${process.pid}.tmp`), "");
        linkSync(join(out, `lease.${process.pid}.tmp`), join(root, "twin"));
        expect(() => requirePlainArtifacts(out, ["host", "eidnara"])).toThrow(/has 2 links/);
        rmSync(join(root, "twin"));
        mkdirSync(join(out, "eidnara", "state.json"));
        expect(() => requirePlainArtifacts(out, ["host", "eidnara"])).toThrow(
            /state.json is not a regular file/,
        );
    });

    test("a scenario's project ids are plain names and every event project is declared", () => {
        const base = writeScenario(dir(), { ...scenarioBody(), projects: [{ id: "mini-redis" }] });
        expect(() => requireDeclaredProjects(base)).not.toThrow();
        const traversal = { ...base, projects: [{ id: "../eidnara" }] };
        expect(() => requireDeclaredProjects(traversal as never)).toThrow(/not a plain name/);
        const repeated = {
            ...base,
            events: [
                { id: "e-000001", kind: "session_start", scenario_ms: 0, session: "s" },
                { id: "e-000001", kind: "session_end", scenario_ms: 0, session: "s" },
            ],
        };
        expect(() => requireDeclaredProjects(repeated as never)).toThrow(/is missing or repeated/);
        const shapes = [
            [
                { id: "e-1", kind: "user-turn", scenario_ms: 0, session: "s" },
                /unknown kind "user-turn"/,
            ],
            [{ id: "e-1", kind: "session_start", scenario_ms: "0", session: "s" }, /not a number/],
            [{ id: "e-1", kind: "session_start", scenario_ms: 0 }, /names no session/],
            [{ id: "e-1", kind: "user_turn", scenario_ms: 0, session: "s" }, /index undefined/],
            [
                [
                    { id: "e-1", kind: "session_start", scenario_ms: 5, session: "s" },
                    { id: "e-2", kind: "session_end", scenario_ms: 4, session: "s" },
                ],
                /below 5/,
            ],
        ] as const;
        for (const [events, message] of shapes) {
            const bad = { ...base, events: Array.isArray(events) ? events : [events] };
            expect(() => requireDeclaredProjects(bad as never)).toThrow(message);
        }
        const undeclared = {
            ...base,
            events: [
                {
                    id: "e-000001",
                    kind: "apply_diff",
                    scenario_ms: 0,
                    session: "s",
                    project: "elsewhere",
                },
            ],
        };
        expect(() => requireDeclaredProjects(undeclared as never)).toThrow(
            /event e-000001 names undeclared project "elsewhere"/,
        );
    });

    test("the corpus identity covers each project checkout's commit and content", () => {
        const repos = dir();
        const init = (id: string) => {
            const r = (...args: string[]) => {
                const x = Bun.spawnSync(["git", "-C", join(repos, id), ...args], {
                    stderr: "pipe",
                });
                if (x.exitCode !== 0) throw new Error(x.stderr.toString());
            };
            mkdirSync(join(repos, id));
            writeFileSync(join(repos, id, "f"), id);
            r("init", "-q");
            r("config", "user.email", "t@example.com");
            r("config", "user.name", "t");
            r("add", "f");
            r("commit", "-q", "-m", id);
        };
        init("p1");
        init("p2");
        const first = corpusIdentity(["p1", "p2"], repos);
        expect(Object.keys(first).sort()).toEqual(["p1", "p2"]);
        writeFileSync(join(repos, "p2", "f"), "edited");
        const second = corpusIdentity(["p1", "p2"], repos);
        expect(second.p1).toEqual(first.p1);
        expect(second.p2?.worktree).not.toBe(first.p2?.worktree);
        expect(() => corpusIdentity(["p3"], repos)).toThrow();
    });

    test("the harness identity covers the commit, tracked edits, and untracked files", () => {
        const repo = dir();
        const run = (...args: string[]) => {
            const r = Bun.spawnSync(["git", "-C", repo, ...args], {
                stdout: "pipe",
                stderr: "pipe",
            });
            if (r.exitCode !== 0) throw new Error(r.stderr.toString());
        };
        run("init", "-q");
        run("config", "user.email", "t@example.com");
        run("config", "user.name", "t");
        writeFileSync(join(repo, "a.txt"), "one\n");
        run("add", "a.txt");
        run("commit", "-q", "-m", "one");
        const clean = treeIdentity(repo);
        expect(clean.commit).toMatch(/^[0-9a-f]{40}$/);
        expect(treeIdentity(repo)).toEqual(clean);
        writeFileSync(join(repo, "a.txt"), "two\n");
        const edited = treeIdentity(repo);
        expect(edited.commit).toBe(clean.commit);
        expect(edited.worktree).not.toBe(clean.worktree);
        writeFileSync(join(repo, "a.txt"), "one\n");
        writeFileSync(join(repo, "b.txt"), "new\n");
        const added = treeIdentity(repo);
        expect(added.worktree).not.toBe(clean.worktree);
        writeFileSync(join(repo, "b.txt"), "changed\n");
        expect(treeIdentity(repo).worktree).not.toBe(added.worktree);
        rmSync(join(repo, "b.txt"));
        symlinkSync("a.txt", join(repo, "b.txt"));
        const linked = treeIdentity(repo).worktree;
        rmSync(join(repo, "b.txt"));
        symlinkSync("missing", join(repo, "b.txt"));
        expect(treeIdentity(repo).worktree).not.toBe(linked);
        writeFileSync(join(repo, ".gitignore"), "b.txt\n");
        rmSync(join(repo, "b.txt"));
        run("add", ".gitignore");
        run("commit", "-q", "-m", "ignore");
        expect(treeIdentity(repo).worktree).toBe(clean.worktree);
    });

    test("a schedule needs a mechanism for every fault and two models for a model switch", () => {
        const at = (type: FaultEpisode["type"]): FaultEpisode => ({
            id: `f-${type}`,
            type,
            strategy: "single",
            trigger: { kind: "session_start", session: "s-0000" },
            params: {},
            seam: SEAMS[type],
        });
        expect(() => requireMechanisms([at("provider_429")], ["m"])).not.toThrow();
        expect(() => requireMechanisms([at("model_switch")], ["m", "n"])).not.toThrow();
        expect(() => requireMechanisms([at("model_switch")], ["m"])).toThrow(
            /two distinct --models/,
        );
        expect(() => requireMechanisms([at("model_switch")], ["m", "m"])).toThrow(/repeats/);
        expect(() => requireMechanisms([at("provider_429")], ["a", ""])).toThrow(/empty entry/);
        expect(() => requireMechanisms([at("provider_429")], ["a", "a", "b"])).toThrow(
            /--models repeats an entry: a,a,b/,
        );
        expect(() => requireMechanisms([at("host_upgrade"), at("provider_429")], ["m"])).toThrow(
            /without a mechanism: host_upgrade/,
        );
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

    test("a fault override must be an array of episodes valid against the compiled scenario", () => {
        const scenario = writeScenario(dir(), scenarioBody());
        const episode: FaultEpisode = {
            id: "f",
            type: "provider_429",
            strategy: "single",
            trigger: { kind: "user_turn", session: "s-0000", n: 2 },
            params: {},
            seam: SEAMS.provider_429,
        };
        expect(faultOverride([episode], scenario)).toEqual([episode]);
        expect(() => faultOverride({}, scenario)).toThrow(/must hold an array/);
        expect(() => faultOverride([{ id: 1 }], scenario)).toThrow(/is malformed: id missing/);
        const noSeam = { ...episode, type: "quantum_flip", seam: undefined };
        expect(() => faultOverride([noSeam], scenario)).toThrow(
            /type quantum_flip unknown, seam missing/,
        );
        expect(() => faultOverride([{ ...episode, strategy: "often" }], scenario)).toThrow(
            /strategy often unknown/,
        );
        expect(() => faultOverride([{ ...episode, params: { n: "3" } }], scenario)).toThrow(
            /params must be finite numbers/,
        );
        expect(() => faultOverride([episode, episode], scenario)).toThrow(/duplicate id f/);
        const sleepOnTurn = { ...episode, type: "laptop_sleep", seam: SEAMS.laptop_sleep };
        expect(() => faultOverride([sleepOnTurn], scenario)).toThrow(/session_start trigger only/);
        const killOnStart = {
            ...episode,
            type: "daemon_sigkill_mid_fold",
            seam: SEAMS.daemon_sigkill_mid_fold,
            trigger: { kind: "session_start", session: "s-0000" },
        };
        expect(() => faultOverride([killOnStart], scenario)).toThrow(/first_summarizer_call/);
        const switchOnTurn = { ...episode, type: "model_switch", seam: SEAMS.model_switch };
        expect(() => faultOverride([switchOnTurn], scenario)).toThrow(
            /model_switch fires at a session_start trigger only/,
        );
        const proto = { ...episode, type: "__proto__", seam: {} };
        expect(() => faultOverride([proto], scenario)).toThrow(/type __proto__ unknown/);
        const ranges = {
            ...episode,
            params: { probability: 2, calls: -1, count: 0, delay_ms: -5 },
        };
        expect(() => faultOverride([ranges], scenario)).toThrow(
            /probability 2 outside \[0, 1\], calls -1 is not a positive integer, count 0 is not a positive integer, delay_ms -5 is negative/,
        );
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
        expect(first.manifest.preflight.hosts[0]?.version).toBe("0.80.2");
        await expect(loadManifest(o, scenario, checks)).resolves.toMatchObject({
            manifest: { seed: 101 },
        });
        const upgraded = {
            ...checks,
            hosts: [{ host: "pi" as const, version: "0.81.0", transcript_paths: ["a"] }],
        };
        await expect(loadManifest(o, scenario, upgraded)).rejects.toThrow(
            /the pi host changed since the run started/,
        );
    });

    test("a resume is refused when the harness revision or the manifest's arm names are off", async () => {
        const out = dir();
        const scenario = writeScenario(out, scenarioBody());
        const checks: Preflight = {
            launcher: join(out, "launcher"),
            time_injection: [],
            distortions: [],
            hosts: [{ host: "pi", version: "0.80.2", transcript_paths: [] }],
            toolchain: [],
        };
        const o: RunOptions = { config, tier: "S", seed: 101, host: "pi", out };
        const { manifest } = await loadManifest(o, scenario, checks);
        expect(manifest.sim_commit).toMatch(/^[0-9a-f]{40}$/);
        const path = join(out, "manifest.json");
        writeFileSync(path, JSON.stringify({ ...manifest, sim_commit: "0".repeat(40) }));
        await expect(loadManifest(o, scenario, checks)).rejects.toThrow(
            /inputs changed since the run started: sim_commit/,
        );
        writeFileSync(path, JSON.stringify({ ...manifest, order: ["../../elsewhere"] }));
        await expect(loadManifest(o, scenario, checks)).rejects.toThrow(
            /names arms outside the S order/,
        );
    });

    test("a staging file that is a link is refused instead of followed", async () => {
        const out = dir();
        const scenario = writeScenario(out, scenarioBody());
        const target = join(out, "elsewhere.json");
        writeFileSync(target, "keep");
        symlinkSync(target, join(out, `manifest.json.${process.pid}`));
        const checks: Preflight = {
            launcher: "",
            time_injection: [],
            distortions: [],
            hosts: [{ host: "pi", version: "0.80.2", transcript_paths: [] }],
            toolchain: [],
        };
        const o: RunOptions = { config, tier: "S", seed: 101, host: "pi", out };
        await expect(loadManifest(o, scenario, checks)).rejects.toThrow(/exists or is a link/);
        expect(readFileSync(target, "utf8")).toBe("keep");
    });

    test("a manifest with another schema is refused before any field is read", async () => {
        const out = dir();
        const scenario = writeScenario(out, scenarioBody());
        const checks: Preflight = {
            launcher: "",
            time_injection: [],
            distortions: [],
            hosts: [{ host: "pi", version: "0.80.2", transcript_paths: [] }],
            toolchain: [],
        };
        const o: RunOptions = { config, tier: "S", seed: 101, host: "pi", out };
        const { manifest } = await loadManifest(o, scenario, checks);
        writeFileSync(
            join(out, "manifest.json"),
            JSON.stringify({ ...manifest, schema: "sim-run-manifest/v2" }),
        );
        await expect(loadManifest(o, scenario, checks)).rejects.toThrow(
            /schema sim-run-manifest\/v2 is not sim-run-manifest\/v1/,
        );
    });

    test("a resume validates mechanisms against the saved manifest, not the CLI defaults", async () => {
        const out = dir();
        const body = scenarioBody();
        const scenario = writeScenario(out, {
            ...body,
            faults: [
                {
                    id: "f",
                    type: "model_switch",
                    strategy: "single",
                    trigger: { kind: "session_start", session: "s-0000" },
                    params: {},
                    seam: SEAMS.model_switch,
                },
            ],
        });
        const checks: Preflight = {
            launcher: "",
            time_injection: [],
            distortions: [],
            hosts: [{ host: "pi", version: "0.80.2", transcript_paths: [] }],
            toolchain: [],
        };
        const o: RunOptions = { config, tier: "S", seed: 101, host: "pi", out };
        await expect(loadManifest(o, scenario, checks)).rejects.toThrow(/two distinct --models/);
        await loadManifest({ ...o, models: ["a", "b"] }, scenario, checks);
        await expect(loadManifest(o, scenario, checks)).resolves.toMatchObject({
            manifest: { models: ["a", "b"] },
        });
    });

    test("a resume is refused when an executable's content changed, whatever its version", async () => {
        const out = dir();
        const scenario = writeScenario(out, scenarioBody());
        const checks: Preflight = {
            launcher: join(out, "launcher"),
            time_injection: [],
            distortions: [],
            hosts: [{ host: "pi", version: "0.80.2", transcript_paths: [] }],
            toolchain: [],
        };
        const o: RunOptions = { config, tier: "S", seed: 101, host: "pi", out };
        const { manifest } = await loadManifest(o, scenario, checks);
        expect(Object.keys(manifest.binaries).sort()).toEqual([
            "daemon",
            "faketime",
            "opencode",
            "opencode_sdk",
            "pi",
        ]);
        const swapped = { ...config, daemon_binary: join(out, "daemon") };
        writeFileSync(swapped.daemon_binary, "daemon 2");
        await expect(loadManifest({ ...o, config: swapped }, scenario, checks)).rejects.toThrow(
            /inputs changed since the run started: binaries/,
        );
        writeFileSync(swapped.daemon_binary, "daemon 1");
        await expect(
            loadManifest({ ...o, config: swapped }, scenario, checks),
        ).resolves.toMatchObject({ manifest: { seed: 101 } });
    });
});
