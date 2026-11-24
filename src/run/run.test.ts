import { beforeAll, describe, expect, test } from "bun:test";
import {
    existsSync,
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
import { type ArmProfile, DAEMON_VARIANTS, W2_VARIANTS } from "../hosts/profiles";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import { preregistrationHash } from "../prereg/validate";
import { Rng } from "../rng";
import { GENERATOR_VERSION, type Scenario } from "../scenario/compile";
import { type FaultEpisode, SEAMS, scheduleFaults } from "../scenario/faults";
import { corpusInputsSha256, loadPrereg } from "../scenario/inputs";
import { withUserTurns } from "./callviews";
import { backgroundCachePointsOf } from "./capabilities";
import type { Entry } from "./journal";
import type { Preflight } from "./preflight";
import {
    armConfigs,
    armOrder,
    bindEidnaraBuild,
    corpusIdentity,
    faultOverride,
    loadManifest,
    loadScenario,
    type Manifest,
    manifestIdentity,
    type RunOptions,
    readCallLog,
    requireDeclaredProjects,
    requireFreshArmRoots,
    requireJournalShape,
    requireMechanisms,
    requireOutsideCheckout,
    requireOutsideIdentity,
    requirePinnedPath,
    requirePlainArtifacts,
    runIdentity,
    runPriceTable,
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
    toolchain: {
        bin: [bins],
        keep: [] as string[],
        env: {} as Record<string, string>,
        wall_clock_tools: ["daemon"],
    },
} as SimConfig;

function scenarioBody(seed = 101, tier = "S") {
    return {
        schema: GENERATOR_VERSION,
        manifest: {
            seed,
            tier,
            generator_version: GENERATOR_VERSION,
            preregistration_sha256: preregistrationHash(loadPrereg("S")),
            corpus_inputs_sha256: corpusInputsSha256(),
        },
        projects: [],
        sessions: [
            { id: "s-0000", requests: 2 },
            { id: "s-0001", requests: 1 },
        ],
        events: [
            { id: "e-000000", kind: "session_start", scenario_ms: 0, session: "s-0000" },
            { id: "e-000001", kind: "session_end", scenario_ms: 5, session: "s-0000" },
            { id: "e-000002", kind: "session_start", scenario_ms: 10, session: "s-0001" },
        ],
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
    // The run identity hashes the node and git binaries, over 100 MB, so the first one a fresh
    // CI runner computes reads them from a cold page cache and takes seconds. Computing it once
    // here leaves each manifest test only the warm cost its own timeout is sized for.
    beforeAll(() => void runIdentity(config, loadPrereg("S"), []), { timeout: 60_000 });

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
        rmSync(join(out, `lease.${process.pid}.tmp`));
        symlinkSync(join(root, "elsewhere.jsonl"), join(out, "lease.0.json"));
        expect(() => requirePlainArtifacts(out, ["host", "eidnara"])).toThrow(
            /lease.0.json is a symlink/,
        );
        rmSync(join(out, "lease.0.json"));
        mkdirSync(join(out, "eidnara", "state.json"));
        expect(() => requirePlainArtifacts(out, ["host", "eidnara"])).toThrow(
            /state.json is not a regular file/,
        );
    });

    test("a fresh run refuses an output directory that already holds arm payloads", () => {
        const out = dir();
        expect(() => requireFreshArmRoots(out, ["host", "eidnara"])).not.toThrow();
        mkdirSync(join(out, "eidnara", "r"), { recursive: true });
        expect(() => requireFreshArmRoots(out, ["host", "eidnara"])).toThrow(/has no journal/);
    });

    test("preflight scratch from an earlier recorded fresh attempt is removed, other evidence refused", () => {
        const out = dir();
        mkdirSync(join(out, "toolbin"));
        expect(() => requireFreshArmRoots(out, ["host"])).toThrow(/toolbin exists/);
        writeFileSync(join(out, "attempt.json"), "{}\n");
        expect(() => requireFreshArmRoots(out, ["host"])).not.toThrow();
        expect(existsSync(join(out, "toolbin"))).toBe(false);
        writeFileSync(join(out, "calls.jsonl"), "");
        expect(() => requireFreshArmRoots(out, ["host"])).toThrow(/calls.jsonl exists/);
    });

    test("the pinned OpenCode release must be the first PATH entry that resolves opencode", () => {
        const saved = process.env.PATH;
        const other = dir();
        writeFileSync(join(other, "opencode"), "");
        const pinned = join(bins, "node_modules", ".bin");
        mkdirSync(pinned, { recursive: true });
        writeFileSync(join(pinned, "opencode"), "");
        const cfg = {
            ...config,
            opencode_binary: join(bins, "node_modules/opencode-ai/bin/opencode"),
        };
        try {
            process.env.PATH = `${pinned}:${other}`;
            expect(() => requirePinnedPath(cfg)).not.toThrow();
            process.env.PATH = `${other}:${pinned}`;
            expect(() => requirePinnedPath(cfg)).toThrow(
                /resolves opencode from .* before the pinned release/,
            );
            process.env.PATH = other;
            expect(() => requirePinnedPath(cfg)).toThrow(/PATH lacks the pinned OpenCode release/);
        } finally {
            process.env.PATH = saved;
        }
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

    test("output inside this checkout must be ignored, and never inside a corpus checkout", () => {
        expect(() => requireOutsideIdentity(join(ROOT, "runs/x"))).not.toThrow();
        expect(() => requireOutsideIdentity(join(ROOT, "src/x"))).toThrow(/not ignored by git/);
        expect(() => requireOutsideIdentity(join(ROOT, "corpus/repos/mini-redis/x"))).toThrow(
            /overlaps the corpus checkouts/,
        );
        expect(() => requireOutsideIdentity(dir())).not.toThrow();
    });

    test("the compiler's own fault schedules pass the override validation", () => {
        const id = (i: number) => `s-${String(i).padStart(4, "0")}`;
        const sessions = Array.from({ length: 9 }, (_, i) => ({
            id: id(i),
            requests: 2 + (i % 2),
            forced_p90: i % 3 !== 1,
            gap_before_ms: i === 0 ? 0 : 3_600_000 * i,
            has_diff: false,
        }));
        let at = 0;
        const events = sessions.flatMap((x, i) => {
            at += x.gap_before_ms;
            const start = { id: `e-${String(2 * i).padStart(6, "0")}`, kind: "session_start" };
            const end = { id: `e-${String(2 * i + 1).padStart(6, "0")}`, kind: "session_end" };
            const span = [
                { ...start, scenario_ms: at, session: x.id },
                { ...end, scenario_ms: at + 60_000, session: x.id },
            ];
            at += 60_000;
            return span;
        });
        for (const tier of ["S", "M", "L", "XL"]) {
            for (let seed = 1; seed <= 20; seed++) {
                const faults = scheduleFaults(tier, sessions, new Rng(seed));
                const scenario = {
                    ...scenarioBody(),
                    sessions,
                    events,
                    faults,
                } as unknown as Scenario;
                expect(() => faultOverride(faults, scenario)).not.toThrow();
            }
        }
    });

    test("a resumed journal must follow the run's state machine", () => {
        const e = (kind: Entry["kind"], arm: string | null, extra: Record<string, unknown> = {}) =>
            ({ kind, arm, scenario_ms: 0, seq: 0, wall_ms: 0, ...extra }) as Entry;
        const start = [e("Preflight", null), e("StartRun", null), e("StartArm", "a")];
        expect(() =>
            requireJournalShape([...start, e("Event", "a", { event: "x" }), e("EndArm", "a")]),
        ).not.toThrow();
        expect(() => requireJournalShape([e("StartArm", "a")])).toThrow(/precedes StartRun/);
        expect(() => requireJournalShape([e("StartRun", null), e("EndArm", "a")])).toThrow(
            /precedes StartArm/,
        );
        expect(() =>
            requireJournalShape([...start, e("EndArm", "a"), e("Event", "a", { event: "x" })]),
        ).toThrow(/follows EndArm/);
        expect(() => requireJournalShape([...start, e("StartArm", "a")])).toThrow(
            /repeats StartArm/,
        );
        expect(() =>
            requireJournalShape([
                ...start,
                e("BeginTurn", "a", { event: "t" }),
                e("EndTurn", "a", { event: "t" }),
                e("EndTurn", "a", { event: "t" }),
            ]),
        ).toThrow(/closes turn\/t, which is not open/);
        expect(() => requireJournalShape([...start, e("EndTurn", "a", { event: "t" })])).toThrow(
            /closes turn\/t, which is not open/,
        );
        expect(() => requireJournalShape([...start, e("EndJob", "a", { job: "j" })])).toThrow(
            /closes job\/j, which is not open/,
        );
        expect(() => requireJournalShape([e("ResumeRun", null)])).toThrow(/precedes StartRun/);
        expect(() =>
            requireJournalShape([
                ...start,
                e("EndArm", "a"),
                e("EndRun", null),
                e("ResumeRun", null),
            ]),
        ).toThrow(/follows EndRun/);
        expect(() =>
            requireJournalShape([
                ...start,
                e("BeginTurn", "a", { event: "t" }),
                e("BeginTurn", "a", { event: "t" }),
            ]),
        ).toThrow(/opens turn\/t, which is already open/);
        expect(() =>
            requireJournalShape([e("StartRun", null), e("StartArm", "b")], undefined, ["a", "b"]),
        ).toThrow(/starts arm b; the order expects a/);
        expect(() =>
            requireJournalShape([
                ...start,
                { ...e("Event", "a", { event: "x" }), scenario_ms: "10" as never },
            ]),
        ).toThrow(/has scenario_ms "10"/);
        expect(() =>
            requireJournalShape([...start, e("EndArm", "a"), e("EndRun", null)]),
        ).not.toThrow();
        expect(() => requireJournalShape([...start, e("EndRun", null)])).toThrow(
            /EndRun with arm a unfinished/,
        );
        expect(() =>
            requireJournalShape([
                ...start,
                e("BeginTurn", "a", { event: "t" }),
                e("ItemState", "a", { event: "t", state: "failed(interrupted)" }),
                e("Event", "a", { event: "t" }),
                e("EndArm", "a"),
            ]),
        ).not.toThrow();
        const ids = [
            { id: "e-1", kind: "session_start" },
            { id: "e-2", kind: "user_turn" },
        ];
        const turn = [e("BeginTurn", "a", { event: "e-2" }), e("EndTurn", "a", { event: "e-2" })];
        const ev = (id: string) => e("Event", "a", { event: id });
        expect(() =>
            requireJournalShape([...start, ev("e-1"), ...turn, ev("e-2")], ids),
        ).not.toThrow();
        const late = [{ id: "e-1", kind: "session_start", scenario_ms: 500 }];
        expect(() => requireJournalShape([...start, ev("e-1")], late)).toThrow(
            /records e-1 at 0, before its scheduled 500/,
        );
        expect(() => requireJournalShape([...start, ev("e-1"), ev("e-2")], ids)).toThrow(
            /completes turn e-2 without an EndTurn or interruption/,
        );
        const interrupted = [
            e("BeginTurn", "a", { event: "e-2" }),
            e("ItemState", "a", { event: "e-2", state: "failed(interrupted)" }),
        ];
        expect(() =>
            requireJournalShape([...start, ev("e-1"), ...interrupted, ev("e-2")], ids),
        ).not.toThrow();
        expect(() => requireJournalShape([...start, ev("e-9")], ids)).toThrow(
            /unscheduled event e-9/,
        );
        expect(() => requireJournalShape([...start, ev("e-2"), ev("e-1")], ids)).toThrow(
            /is not the next scheduled event \(e-2\)/,
        );
        expect(() => requireJournalShape([...start, ev("e-1"), ev("e-1")], ids)).toThrow(
            /is not the next scheduled event \(e-1\)/,
        );
        expect(() => requireJournalShape([...start, ev("e-2")], ids)).toThrow(
            /is not the next scheduled event \(e-2\)/,
        );
    });

    test("a schedule needs a mechanism for every fault, including the XL host faults, and two models for a model switch", () => {
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
        const xl = [at("host_upgrade"), at("two_hosts_one_daemon"), at("provider_429")];
        expect(() => requireMechanisms(xl, ["m"])).not.toThrow();
        const hostOnly = (f: FaultEpisode) => f.seam.layer !== "scheduler";
        expect(() => requireMechanisms(xl, ["m"], hostOnly)).toThrow(
            /without a mechanism: host_upgrade, two_hosts_one_daemon/,
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
            { preregistration_sha256: "0".repeat(64) },
            { corpus_inputs_sha256: "0".repeat(64) },
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
        const kill = (id: string) => ({
            ...episode,
            id,
            type: "daemon_sigkill_mid_fold",
            seam: SEAMS.daemon_sigkill_mid_fold,
            trigger: { kind: "first_summarizer_call", session: "s-0000" },
        });
        expect(() => faultOverride([kill("k1"), kill("k2")], scenario)).toThrow(
            /two daemon_sigkill_mid_fold episodes target session s-0000/,
        );
        const sleep = (id: string, session = "s-0001") => ({
            ...episode,
            id,
            type: "laptop_sleep",
            seam: SEAMS.laptop_sleep,
            trigger: { kind: "session_start", session },
        });
        expect(() => faultOverride([sleep("z1"), sleep("z2")], scenario)).toThrow(
            /two laptop_sleep episodes target session s-0001/,
        );
        expect(() => faultOverride([sleep("z0", "s-0000")], scenario)).toThrow(
            /no idle gap before its start/,
        );
        expect(faultOverride([sleep("z1")], scenario)).toHaveLength(1);
        const longFull = {
            ...episode,
            type: "store_full",
            seam: SEAMS.store_full,
            strategy: "persistent",
            trigger: { kind: "session_start", session: "s-0000" },
            params: { sessions: 2 },
        };
        expect(() => faultOverride([longFull], scenario)).toThrow(
            /store_full supports sessions: 1 only/,
        );
        const switchOnTurn = { ...episode, type: "model_switch", seam: SEAMS.model_switch };
        expect(() => faultOverride([switchOnTurn], scenario)).toThrow(
            /model_switch fires at a session_start trigger only/,
        );
        const wrongKnob = {
            ...episode,
            type: "provider_timeout",
            seam: SEAMS.provider_timeout,
            params: { delay_ms: 5 },
        };
        expect(() => faultOverride([wrongKnob], scenario)).toThrow(
            /delay_ms does not apply to provider_timeout/,
        );
        const singleWithCount = { ...episode, params: { count: 3 } };
        expect(() => faultOverride([singleWithCount], scenario)).toThrow(
            /single fires once; count 3 belongs to a burst/,
        );
        const burstNoCount = { ...episode, strategy: "burst" };
        expect(() => faultOverride([burstNoCount], scenario)).toThrow(/burst needs count/);
        const intermittentBare = { ...episode, strategy: "intermittent" };
        expect(() => faultOverride([intermittentBare], scenario)).toThrow(
            /intermittent needs probability, intermittent needs calls/,
        );
        const restartBurst = {
            ...episode,
            type: "daemon_restart",
            seam: SEAMS.daemon_restart,
            strategy: "burst",
            trigger: { kind: "session_start", session: "s-0000" },
            params: { count: 2 },
        };
        expect(() => faultOverride([restartBurst], scenario)).toThrow(
            /daemon_restart uses the single strategy/,
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
            upgrade: [],
            toolchain: [],
        };
        const o: RunOptions = { config, tier: "S", seed: 101, host: "pi", out };
        await expect(loadManifest({ ...o, events: 9 }, scenario, checks)).rejects.toThrow(
            /--events 9 exceeds the 3 compiled events/,
        );
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
            upgrade: [],
            toolchain: [],
        };
        const o: RunOptions = { config, tier: "S", seed: 101, host: "pi", out };
        const { manifest } = await loadManifest(o, scenario, checks);
        expect(manifest.sim_commit).toMatch(/^[0-9a-f]{40}$/);
        expect(manifestIdentity(manifest)).toMatch(/^[0-9a-f]{64}$/);
        expect(manifestIdentity({ ...manifest, preflight: checks })).toBe(
            manifestIdentity(manifest),
        );
        expect(manifestIdentity({ ...manifest, models: ["x"] })).not.toBe(
            manifestIdentity(manifest),
        );
        const path = join(out, "manifest.json");
        writeFileSync(path, JSON.stringify({ ...manifest, sim_commit: "0".repeat(40) }));
        await expect(loadManifest(o, scenario, checks)).rejects.toThrow(
            /inputs changed since the run started: sim_commit/,
        );
        const out102 = dir();
        const scenario102 = writeScenario(out102, scenarioBody(102));
        const o102: RunOptions = { ...o, seed: 102, out: out102 };
        const seed102 = await loadManifest(o102, scenario102, checks);
        expect(seed102.manifest.order).toEqual(["eidnara-kl", "eidnara", "host"]);
        await expect(loadManifest(o102, scenario102, checks)).resolves.toMatchObject({
            manifest: { seed: 102 },
        });
        for (const order of [["../../elsewhere"], [], ["host", "host"], ["eidnara", "host"]]) {
            writeFileSync(path, JSON.stringify({ ...manifest, order }));
            await expect(loadManifest(o, scenario, checks)).rejects.toThrow(
                /is not a non-empty subsequence of the S arms/,
            );
        }
    });

    test("a run's own wall budget is recorded, inherited on resume, and refused when changed", async () => {
        const out = dir();
        const scenario = writeScenario(out, scenarioBody());
        const checks: Preflight = {
            launcher: join(out, "launcher"),
            time_injection: [],
            distortions: [],
            hosts: [{ host: "pi", version: "0.80.2", transcript_paths: [] }],
            upgrade: [],
            toolchain: [],
        };
        const o: RunOptions = {
            config,
            tier: "S",
            seed: 101,
            host: "pi",
            out,
            wallBudgetMs: 9_000,
        };
        const { manifest } = await loadManifest(o, scenario, checks);
        expect(manifest.wall_budget_ms).toBe(9_000);
        await expect(
            loadManifest({ ...o, wallBudgetMs: undefined }, scenario, checks),
        ).resolves.toMatchObject({ manifest: { wall_budget_ms: 9_000 } });
        await expect(loadManifest({ ...o, wallBudgetMs: 8_000 }, scenario, checks)).rejects.toThrow(
            /resume options differ from the manifest: wall_budget_ms/,
        );
        const path = join(out, "manifest.json");
        writeFileSync(path, JSON.stringify({ ...manifest, wall_budget_ms: 0 }));
        await expect(loadManifest(o, scenario, checks)).rejects.toThrow(
            /wall_budget_ms 0 is not a positive integer timer length/,
        );
        const tierRun = dir();
        const tierScenario = writeScenario(tierRun, scenarioBody());
        const registered = await loadManifest(
            { ...o, out: tierRun, wallBudgetMs: undefined },
            tierScenario,
            checks,
        );
        expect(registered.manifest.wall_budget_ms).toBeNull();
        for (const wallBudgetMs of [0, Number.NaN, 2 ** 31]) {
            await expect(
                loadManifest({ ...o, out: dir(), wallBudgetMs }, tierScenario, checks),
            ).rejects.toThrow(/is not a positive integer of at most 2147483647 ms/);
        }
        await expect(loadManifest({ ...o, out: tierRun }, tierScenario, checks)).rejects.toThrow(
            /resume options differ from the manifest: wall_budget_ms/,
        );
    });

    test("a run records its registration's prompt-caching condition and the price table it selects", async () => {
        const checks: Preflight = {
            launcher: "/launcher",
            time_injection: [],
            distortions: [],
            hosts: [{ host: "pi", version: "0.80.2", transcript_paths: [] }],
            upgrade: [],
            toolchain: [],
        };
        const tierRun = dir();
        const tier: RunOptions = { config, tier: "S", seed: 101, host: "pi", out: tierRun };
        const tierScenario = writeScenario(tierRun, scenarioBody());
        const off = await loadManifest(tier, tierScenario, checks);
        expect(off.manifest.prompt_caching).toBe("off");
        expect(off.manifest.price_table).toEqual({
            version: "v1",
            rates: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        });
        // A manifest written before the field resumes as a caching-off run and stays as written.
        const path = join(tierRun, "manifest.json");
        const { prompt_caching: _condition, ...before } = off.manifest;
        writeFileSync(path, JSON.stringify(before));
        const resumed = await loadManifest(tier, tierScenario, checks);
        expect(resumed.manifest.prompt_caching).toBeUndefined();
        expect(resumed.manifest.price_table.version).toBe("v1");
        writeFileSync(path, JSON.stringify({ ...before, prompt_caching: "on" }));
        await expect(loadManifest(tier, tierScenario, checks)).rejects.toThrow(
            /resume options differ from the manifest: prompt_caching/,
        );
        writeFileSync(path, JSON.stringify({ ...before, prompt_caching: "1h" }));
        await expect(loadManifest(tier, tierScenario, checks)).rejects.toThrow(
            /prompt_caching 1h is neither on nor off/,
        );

        const out = dir();
        const opus = "global.anthropic.claude-opus-5-5";
        const o: RunOptions = {
            config: { ...config, agent_model: opus },
            tier: "M",
            seed: 605,
            host: "pi",
            out,
            qualification: "PCH",
        };
        const scenario = writeScenario(out, scenarioBody(605, "M"));
        // The cached table holds one model's rates, so a run of any other model is refused unwritten.
        const haiku = "global.anthropic.claude-haiku-5-5";
        const others: [Partial<RunOptions>, string][] = [
            [{ config }, "m"],
            [{ models: [opus, "us.anthropic.claude-opus-5-5"] }, "us.anthropic.claude-opus-5-5"],
            [{ sideModel: haiku }, haiku],
        ];
        for (const [other, named] of others) {
            await expect(loadManifest({ ...o, ...other }, scenario, checks)).rejects.toThrow(
                `which holds no rates for ${named}`,
            );
        }
        expect(existsSync(join(out, "manifest.json"))).toBe(false);
        const on = await loadManifest(o, scenario, checks);
        expect(on.manifest.qualification?.id).toBe("PCH");
        expect(on.manifest.order).toEqual(["host", "eidnara"]);
        expect(on.manifest.prompt_caching).toBe("on");
        expect(on.manifest.price_table).toEqual({
            version: "v2-opus-5-5-global-2026-11",
            rates: { input: 4, output: 20, cache_read: 0.2, cache_write: 5, cache_write_1h: 8 },
        });
        await expect(loadManifest(o, scenario, checks)).resolves.toMatchObject({
            manifest: {
                prompt_caching: "on",
                price_table: { version: "v2-opus-5-5-global-2026-11" },
            },
        });
        // The condition is part of the execution digest the journal's Preflight entries bind.
        expect(manifestIdentity(on.manifest)).not.toBe(
            manifestIdentity({ ...on.manifest, prompt_caching: "off" }),
        );
    });

    test("a run records its registration's side models, and a resume holds the manifest to them", async () => {
        const checks: Preflight = {
            launcher: "/launcher",
            time_injection: [],
            distortions: [],
            hosts: [{ host: "pi", version: "0.80.2", transcript_paths: [] }],
            upgrade: [],
            toolchain: [],
        };
        const out = dir();
        const opus = "global.anthropic.claude-opus-5-5";
        const haiku = "global.anthropic.claude-haiku-5-5";
        const o: RunOptions = {
            config: { ...config, agent_model: opus },
            tier: "M",
            seed: 605,
            host: "pi",
            out,
            qualification: "PCH",
        };
        const scenario = writeScenario(out, scenarioBody(605, "M"));
        // A registration that names no side model records none and keeps the v2 table.
        const { manifest } = await loadManifest(o, scenario, checks);
        expect(manifest.side_models).toBeNull();
        expect(JSON.stringify(manifest.price_table)).toBe(
            '{"version":"v2-opus-5-5-global-2026-11","rates":{"input":4,"output":20,"cache_read":0.2,"cache_write":5,"cache_write_1h":8}}',
        );
        // A manifest written before the field resumes and stays as written.
        const path = join(out, "manifest.json");
        const { side_models: _none, ...before } = manifest;
        writeFileSync(path, JSON.stringify(before));
        const resumed = await loadManifest(o, scenario, checks);
        expect("side_models" in resumed.manifest).toBe(false);
        expect(manifestIdentity(resumed.manifest)).toBe(manifestIdentity(before as Manifest));
        // A manifest that names a side model its registration lacks is another run's.
        const stage1 = { memory_reviewer_stage1: haiku };
        writeFileSync(path, JSON.stringify({ ...before, side_models: stage1 }));
        await expect(loadManifest(o, scenario, checks)).rejects.toThrow(
            /resume options differ from the manifest: side_models/,
        );
        for (const bad of [
            {},
            { memory_reviewer_stage1: "" },
            [haiku],
            { ...stage1, other: haiku },
        ]) {
            writeFileSync(path, JSON.stringify({ ...before, side_models: bad }));
            await expect(loadManifest(o, scenario, checks)).rejects.toThrow(
                /side_models is not a model name per registered role/,
            );
        }
        // The side models are part of the execution digest the journal's Preflight entries bind.
        expect(manifestIdentity(manifest)).not.toBe(
            manifestIdentity({ ...manifest, side_models: stage1 }),
        );
    });

    test("a W5P run records the registered stage-1 model, its rates, and the reviewer arm's switch", async () => {
        const checks: Preflight = {
            launcher: "/launcher",
            time_injection: [],
            distortions: [],
            hosts: [{ host: "pi", version: "0.80.2", transcript_paths: [] }],
            upgrade: [],
            toolchain: [],
        };
        const out = dir();
        const opus = "global.anthropic.claude-opus-5-5";
        const haiku = "global.anthropic.claude-haiku-5-5";
        const o: RunOptions = {
            config: { ...config, agent_model: opus },
            tier: "M",
            seed: 605,
            host: "pi",
            out,
            qualification: "W5P",
        };
        const scenario = writeScenario(out, scenarioBody(605, "M"));
        // The table holds the agent model's rates and Haiku's, so any other model is refused unwritten.
        const sonnet = "global.anthropic.claude-sonnet-5-5";
        await expect(
            loadManifest({ ...o, models: [opus, sonnet] }, scenario, checks),
        ).rejects.toThrow(
            `prices calls at v3-opus-5-5-haiku-5-5-global-2026-11, which holds no rates for ${sonnet}`,
        );
        expect(existsSync(join(out, "manifest.json"))).toBe(false);
        const { manifest } = await loadManifest(o, scenario, checks);
        expect(manifest.qualification?.id).toBe("W5P");
        expect(manifest.order).toEqual(["host", "eidnara", "eidnara-reviewer"]);
        expect(manifest.prompt_caching).toBe("on");
        expect(manifest.side_models).toEqual({ memory_reviewer_stage1: haiku });
        expect(manifest.price_table).toEqual({
            version: "v3-opus-5-5-haiku-5-5-global-2026-11",
            rates: { input: 4, output: 20, cache_read: 0.2, cache_write: 5, cache_write_1h: 8 },
            models: {
                [haiku]: {
                    input: 0.1,
                    output: 0.5,
                    cache_read: 0.01,
                    cache_write: 0.125,
                    cache_write_1h: 0.2,
                },
            },
        });
        // The reviewer arm's two user tiers hold the switch: contest mode, the arm's side model
        // as the review model, and the registered stage-1 model.
        const reviewer = {
            enabled: true,
            apply: "contest",
            model: `amazon-bedrock/${opus}`,
            stage1_model: `amazon-bedrock/${haiku}`,
        };
        const { arms } = manifest;
        expect(arms["eidnara-reviewer"]?.eidnara_config?.memory_reviewer).toEqual(reviewer);
        expect(arms["eidnara-reviewer"]?.daemon_config?.memory_reviewer).toEqual(reviewer);
        // The eidnara arm's configuration is the one a registration without side models records.
        const side = { model: `amazon-bedrock/${opus}` };
        expect(arms.eidnara).toEqual({
            profile: {
                role: "fallback-search",
                daemon: "direct-host-fixture",
                plugin: true,
                eidnara_compaction: true,
                host_compaction: false,
                search: "legacy-scan",
                source_capture: true,
                requires: {
                    side_calls: "proxy",
                    user_statement_delivery: true,
                    source_capture: true,
                },
            },
            eidnara_config: {
                enabled: true,
                host: { connection_file: "<connection file>" },
                compaction: { enabled: true },
                execute_threshold_percentage: 65,
                protected_tags: 20,
                history_budget_percentage: 0.15,
                history_summarizer: side,
                context_researcher: side,
                memory: {
                    enabled: true,
                    auto_promote: true,
                    auto_capture: true,
                    auto_search: { enabled: true },
                    auto_inject: { enabled: true },
                    git_commit_indexing: { enabled: false },
                },
                source_capture: { enabled: true },
            },
            daemon_config: {
                history_summarizer: { module_model: side.model },
                memory: { auto_inject: { enabled: true } },
                source_capture: { enabled: true },
            },
        });
        // The reviewer arm is the eidnara arm plus the switch, in the profile and in both tiers.
        expect(arms["eidnara-reviewer"]?.profile).toEqual({
            ...arms.eidnara?.profile,
            memory_reviewer: true,
            requires: {
                ...arms.eidnara?.profile.requires,
                memory_reviewer: true,
                memory_review: true,
            },
        } as ArmProfile);
        for (const tier of ["eidnara_config", "daemon_config"] as const) {
            expect(arms["eidnara-reviewer"]?.[tier]).toEqual({
                ...arms.eidnara?.[tier],
                memory_reviewer: reviewer,
            });
        }
        expect(arms.host).toEqual(armConfigs(["host"], opus).host as (typeof arms)[string]);
        // A resume recomputes the arms from the registration and finds the manifest's.
        await expect(loadManifest(o, scenario, checks)).resolves.toMatchObject({
            manifest: { side_models: { memory_reviewer_stage1: haiku } },
        });
        // A manifest whose reviewer arm names another stage-1 model is a changed configuration.
        const path = join(out, "manifest.json");
        const other = structuredClone(manifest);
        const tier = other.arms["eidnara-reviewer"]?.daemon_config as Record<string, unknown>;
        tier.memory_reviewer = { ...reviewer, stage1_model: `amazon-bedrock/${opus}` };
        writeFileSync(path, JSON.stringify(other));
        await expect(loadManifest(o, scenario, checks)).rejects.toThrow(
            /inputs changed since the run started: arms/,
        );
    });

    test("a caching-on run names only models its price table holds rates for", () => {
        const opus = "global.anthropic.claude-opus-5-5";
        const haiku = "global.anthropic.claude-haiku-5-5";
        const stage1 = { memory_reviewer_stage1: haiku };
        const run = { prompt_caching: "on" as const, models: [opus], side_model: null };
        expect(runPriceTable({ ...run, side_models: null }).version).toBe(
            "v2-opus-5-5-global-2026-11",
        );
        // The registered Haiku side model selects the table that holds its rates.
        const v3 = runPriceTable({ ...run, side_models: stage1 });
        expect(v3.version).toBe("v3-opus-5-5-haiku-5-5-global-2026-11");
        expect(v3.models?.[haiku]).toEqual({
            input: 0.1,
            output: 0.5,
            cache_read: 0.01,
            cache_write: 0.125,
            cache_write_1h: 0.2,
        });
        expect(runPriceTable({ ...run, side_model: haiku, side_models: stage1 })).toBe(v3);
        // Without the registration Haiku has no rates, as an agent model or as the side model.
        expect(() => runPriceTable({ ...run, side_model: haiku, side_models: null })).toThrow(
            `prices calls at v2-opus-5-5-global-2026-11, which holds no rates for ${haiku}`,
        );
        // A registered side model outside the tables, or another agent model beside a
        // registered one, is refused by name.
        const sonnet = "global.anthropic.claude-sonnet-5-5";
        expect(() =>
            runPriceTable({ ...run, side_models: { memory_reviewer_stage1: sonnet } }),
        ).toThrow(`which holds no rates for ${sonnet}`);
        expect(() =>
            runPriceTable({ ...run, models: [opus, sonnet], side_models: stage1 }),
        ).toThrow(
            `prices calls at v3-opus-5-5-haiku-5-5-global-2026-11, which holds no rates for ${sonnet}`,
        );
        // A caching-off run records the v1 table for any models.
        expect(
            runPriceTable({
                prompt_caching: "off",
                models: ["m"],
                side_model: sonnet,
                side_models: stage1,
            }).version,
        ).toBe("v1");
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
            upgrade: [],
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
            upgrade: [],
            toolchain: [],
        };
        const o: RunOptions = { config, tier: "S", seed: 101, host: "pi", out };
        const { manifest } = await loadManifest(o, scenario, checks);
        writeFileSync(
            join(out, "manifest.json"),
            JSON.stringify({ ...manifest, schema: "sim-run-manifest/v1" }),
        );
        await expect(loadManifest(o, scenario, checks)).rejects.toThrow(
            /schema sim-run-manifest\/v1 is not sim-run-manifest\/v3/,
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
            upgrade: [],
            toolchain: [],
        };
        const o: RunOptions = { config, tier: "S", seed: 101, host: "pi", out };
        await expect(loadManifest(o, scenario, checks)).rejects.toThrow(/two distinct --models/);
        await loadManifest({ ...o, models: ["a", "b"] }, scenario, checks);
        await expect(loadManifest(o, scenario, checks)).resolves.toMatchObject({
            manifest: { models: ["a", "b"] },
        });
    });

    test("the manifest pins each arm's profile and configuration, and a resume refuses a changed one", async () => {
        const out = dir();
        const scenario = writeScenario(out, scenarioBody());
        const checks: Preflight = {
            launcher: join(out, "launcher"),
            time_injection: [],
            distortions: [],
            hosts: [{ host: "pi", version: "0.80.2", transcript_paths: [] }],
            upgrade: [],
            toolchain: [],
        };
        const o: RunOptions = { config, tier: "S", seed: 101, host: "pi", out };
        const { manifest } = await loadManifest(o, scenario, checks);
        expect(manifest.schema).toBe("sim-run-manifest/v3");
        expect(Object.keys(manifest.arms)).toEqual(manifest.order);
        expect(manifest.arms.host).toMatchObject({
            profile: { role: "host-only", plugin: false, host_compaction: true },
            eidnara_config: null,
            daemon_config: null,
        });
        expect(manifest.arms.eidnara).toMatchObject({
            profile: {
                role: "fallback-search",
                daemon: "direct-host-fixture",
                search: "legacy-scan",
            },
            eidnara_config: { compaction: { enabled: true }, source_capture: { enabled: true } },
            daemon_config: {
                history_summarizer: { module_model: `amazon-bedrock/${config.agent_model}` },
                source_capture: { enabled: true },
            },
        });
        expect(manifest.arms["eidnara-kl"]).toMatchObject({
            profile: { role: "knowledge-only", host_compaction: true, eidnara_compaction: false },
            eidnara_config: {
                compaction: { enabled: false },
                memory: { enabled: true },
                source_capture: { enabled: false },
            },
            daemon_config: { source_capture: { enabled: false } },
        });
        const kl = manifest.arms["eidnara-kl"] as { eidnara_config: Record<string, unknown> };
        kl.eidnara_config.compaction = { enabled: true };
        writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest));
        await expect(loadManifest(o, scenario, checks)).rejects.toThrow(
            /inputs changed since the run started: arms/,
        );
    });

    test("an arm whose daemon cannot provide its declared capabilities is refused before preflight", () => {
        const fused = DAEMON_VARIANTS["direct-host-fixture-fused"];
        fused.side_calls = "direct-bedrock";
        try {
            expect(() =>
                armOrder({ tier: "S", seed: 101, arms: ["host", "eidnara-hybrid"] }),
            ).toThrow(
                /arm capability refused: eidnara-hybrid \(production-hybrid\) needs side_calls=proxy, but direct-host-fixture-fused provides direct-bedrock/,
            );
        } finally {
            fused.side_calls = "proxy";
        }
        expect(armOrder({ tier: "S", seed: 101, arms: ["eidnara-kl", "host"] })).toEqual([
            "host",
            "eidnara-kl",
        ]);
    });

    test("a run binds the audited build its clone holds and records the capabilities its arms' variants have there", () => {
        const repo = dir();
        const git = (...args: string[]) => {
            const r = Bun.spawnSync(["git", "-C", repo, ...args], { stderr: "pipe" });
            if (r.exitCode !== 0) throw new Error(r.stderr.toString());
            return r.stdout.toString().trim();
        };
        git("init", "-q");
        writeFileSync(join(repo, "README.md"), "a build clone\n");
        git("add", "-A");
        git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c");
        const head = git("rev-parse", "HEAD");
        const legacy = DAEMON_VARIANTS["direct-host-fixture"];
        const reference = {
            ...legacy,
            statement_lineage: "shared" as const,
            process_memory: false,
        };
        const builds = [
            { commit: "0".repeat(40), label: "new", variants: DAEMON_VARIANTS },
            { commit: head, label: "ref", variants: { "direct-host-fixture": reference } },
        ];
        // The clone lacks the first build's commit, so it binds the second.
        const bound = bindEidnaraBuild(repo, ["host", "eidnara"], builds);
        expect(bound).toMatchObject({ commit: head, label: "ref" });
        expect(Object.keys(bound?.capabilities ?? {})).toEqual(["direct-host-fixture"]);
        expect(bound?.capabilities["direct-host-fixture"]).toMatchObject({
            search: "legacy-scan",
            statement_lineage: "shared",
            process_memory: false,
        });
        expect(bound?.capabilities["direct-host-fixture"]).not.toHaveProperty("probes");
        // The proxy reads the layout of a daemon-run call's cache points from this record.
        expect(bound?.capabilities["direct-host-fixture"]?.background_cache_points).toBe("system");
        expect(backgroundCachePointsOf(bound)).toBe("system");
        const earlier = [{ commit: head, label: "earlier", variants: W2_VARIANTS }];
        expect(backgroundCachePointsOf(bindEidnaraBuild(repo, ["host", "eidnara"], earlier))).toBe(
            "system-and-message",
        );
        expect(bindEidnaraBuild(repo, ["host"], builds)).toBeNull();
        // A variant on the bound build that lacks what the arm declares refuses the run.
        const gapped = [
            {
                commit: head,
                label: "ref",
                variants: {
                    "direct-host-fixture": { ...legacy, user_statement_delivery: false },
                },
            },
        ];
        expect(() => bindEidnaraBuild(repo, ["eidnara"], gapped)).toThrow(
            /arm capability refused: eidnara \(fallback-search\) needs user_statement_delivery=true/,
        );
        expect(() => bindEidnaraBuild(repo, ["eidnara-hybrid"], builds)).toThrow(
            /ref \(.*\) registers no direct-host-fixture-fused variant/,
        );
    });

    test("a resume is refused when an executable's content changed, whatever its version", async () => {
        const out = dir();
        const scenario = writeScenario(out, scenarioBody());
        const checks: Preflight = {
            launcher: join(out, "launcher"),
            time_injection: [],
            distortions: [],
            hosts: [{ host: "pi", version: "0.80.2", transcript_paths: [] }],
            upgrade: [],
            toolchain: [],
        };
        const o: RunOptions = { config, tier: "S", seed: 101, host: "pi", out };
        const { manifest } = await loadManifest(o, scenario, checks);
        expect(Object.keys(manifest.binaries).sort()).toEqual([
            "daemon",
            "faketime",
            "git",
            "node",
            "opencode",
            "opencode_plugin",
            "opencode_sdk",
            "opencode_sdk_lock",
            "payload_manifest",
            "pi",
            "pi_install",
            "pi_plugin",
        ]);
        // The test checkout has no plugin builds; a build clone's are hashed as trees.
        expect(manifest.binaries.pi_plugin).toBe("absent");
        expect(manifest.binaries.payload_manifest).toBe("absent");
        expect(manifest.toolchain.tools.daemon).toMatch(/^[0-9a-f]{64}$/);
        expect(manifest.toolchain.tools.cargo).toBe("absent");
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

    test("a resume is refused when a dependency linked from outside the Pi install changed", async () => {
        const out = dir();
        const scenario = writeScenario(out, scenarioBody());
        const checks: Preflight = {
            launcher: join(out, "launcher"),
            time_injection: [],
            distortions: [],
            hosts: [{ host: "pi", version: "0.80.2", transcript_paths: [] }],
            upgrade: [],
            toolchain: [],
        };
        const install = join(out, "pi");
        const store = join(out, "store/dep");
        mkdirSync(join(install, "node_modules/@earendil-works/pi-coding-agent/dist"), {
            recursive: true,
        });
        writeFileSync(
            join(install, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
            "pi",
        );
        mkdirSync(store, { recursive: true });
        writeFileSync(join(store, "index.js"), "dep 1");
        symlinkSync(store, join(install, "node_modules/dep"));
        symlinkSync("..", join(store, "loop"));
        const linked = { ...config, pi_install: install };
        const o: RunOptions = { config: linked, tier: "S", seed: 101, host: "pi", out };
        await loadManifest(o, scenario, checks);
        writeFileSync(join(store, "index.js"), "dep 2");
        await expect(loadManifest(o, scenario, checks)).rejects.toThrow(
            /inputs changed since the run started: binaries/,
        );
    });

    test("a resumed call log with a malformed or out-of-sequence complete line is refused", () => {
        const path = join(dir(), "calls.jsonl");
        const record = (seq: number) => ({
            seq,
            wall_ms: 1,
            arm: "a",
            session: null,
            turn: null,
            component: "agent",
            componentSource: "inferred",
            model: "m",
            status: 200,
            finish_reason: "end_turn",
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            started_wall_ms: 1,
            scenario_ms: 0,
            first_byte_ms: null,
            proxy_retries: 0,
            fault_ref: null,
            error: null,
        });
        const line = (r: unknown) => `${JSON.stringify(r)}\n`;
        writeFileSync(path, line(record(0)) + line(record(1)));
        expect(() => readCallLog(path, () => {}, true)).not.toThrow();
        writeFileSync(path, line(record(0)) + line(record(1)) + line({}));
        expect(() => readCallLog(path, () => {}, true)).toThrow(/line 3 is corrupt: seq missing/);
        writeFileSync(path, line(record(1)) + line(record(0)));
        expect(() => readCallLog(path, () => {}, true)).toThrow(
            /line 1 is corrupt: seq 1 at position 0/,
        );
        writeFileSync(path, `${line(record(0))}{"seq":1,\n`);
        expect(() => readCallLog(path, () => {})).toThrow(/line 2 is corrupt: not JSON/);
        // An unterminated last line, which a kill mid-append leaves, is skipped.
        writeFileSync(path, `${line(record(0))}${line(record(1))}{"seq":2,`);
        const seen: number[] = [];
        readCallLog(path, (r) => seen.push(r.seq), true);
        expect(seen).toEqual([0, 1]);
    });
});

test("a delivered user turn sits just before its turn's first proxy call, in one increasing order", () => {
    const call = (seq: number, turn: string, scenario_ms: number) => ({
        seq,
        arm: "a",
        session: "s-1",
        component: "agent",
        turn,
        scenario_ms,
        status: 200,
        error: null,
        input_tokens: 1,
        output_tokens: 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
    });
    const calls = [call(3, "e-1", 10), call(4, "e-1", 10), call(9, "e-2", 20)];
    const merged = withUserTurns(
        calls,
        [
            { event: "e-2", scenario_ms: 20, label: "pushback", turn_index: 1 },
            { event: "e-3", scenario_ms: 25, label: "task", turn_index: 2 },
            { event: "e-4", scenario_ms: 25, label: "task", turn_index: 3 },
        ],
        "a",
        "s-1",
    );
    expect(merged.map((c) => `${c.component}:${c.turn}`)).toEqual([
        "agent:e-1",
        "agent:e-1",
        "user-sim:e-2",
        "agent:e-2",
        "user-sim:e-3",
        "user-sim:e-4",
    ]);
    const seqs = merged.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(merged[2]?.seq).toBeGreaterThan(4);
    expect(merged[2]?.seq).toBeLessThan(9);
    // A turn with no call of its own, before any call by scenario time, opens the session even
    // when its first call is the log's seq 0.
    const opening = withUserTurns(
        [call(0, "e-2", 20)],
        [{ event: "e-1", scenario_ms: 5, label: "pushback", turn_index: 0 }],
        "a",
        "s-1",
    );
    expect(opening.map((c) => `${c.component}:${c.turn}`)).toEqual(["user-sim:e-1", "agent:e-2"]);
    expect(opening[0]?.seq).toBeLessThan(0);
});

describe("scenario loading", () => {
    test("an L scenario compiles only with the resized count the tier command records", async () => {
        const out = mkdtempSync(join(tmpdir(), "sim-l-"));
        const config = {} as SimConfig;
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
