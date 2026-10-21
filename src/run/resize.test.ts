import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { deleteFactNotes, factMatcher } from "../hosts/storecheck";
import type { Scenario } from "../scenario/compile";
import { loadPrereg } from "../scenario/inputs";
import type { ItemPair, TierInput } from "../stats/gate";
import { gradedMainRuns, icc, resizeFromM } from "./resize";
import { profileJobs } from "./tier";

const pairs = (n: number, discordant: number, facts: number): ItemPair[] =>
    Array.from({ length: n }, (_, i) => ({
        item: `q-${i}`,
        cluster: `f-${i % facts}`,
        control: 0,
        treatment: i < discordant ? 1 : 0,
        order: i,
    }));

/** The tier input fields every resizing reads beside its observations. */
const base = (p: { arms: { default: string } }) => ({
    arms: { control: "host", treatment: p.arms.default },
    journal_seq_at_eval: {},
});

describe("L resizing from M", () => {
    test("the intraclass correlation is zero for scattered differences and one for fact-aligned ones", () => {
        expect(
            icc([
                [1, 0],
                [0, 1],
                [1, 0],
            ]),
        ).toBe(0);
        expect(
            icc([
                [1, 1],
                [0, 0],
                [1, 1],
            ]),
        ).toBe(1);
        expect(icc([[1]])).toBe(0);
    });

    test("each type's n follows the pre-registered rule, and L takes the largest", () => {
        const L = loadPrereg("L");
        const input: TierInput = {
            observations: [
                {
                    metric: "P1.pass",
                    unit: "item",
                    cluster_key: "ledger_fact_id",
                    items: pairs(100, 30, 100),
                },
                {
                    metric: "P2.harm",
                    unit: "item",
                    cluster_key: "ledger_fact_id",
                    items: pairs(100, 10, 100),
                },
            ],
            excluded: [],
            asymmetric: [],
            arms: { control: "host", treatment: L.arms.default },
            journal_seq_at_eval: {},
        };
        const r = resizeFromM(L, input);
        const p1 = r.per_type.find((t) => t.metric === "P1.pass");
        const z = (q: number) =>
            ({
                0.975: 1.959963984540054,
                0.99: 2.3263478740408408,
                0.8: 0.8416212335729143,
                0.54: 0.10043372051146988,
            })[q] as number;
        const want1 = Math.ceil(
            ((z(0.975) * Math.sqrt(0.3) + z(0.8) * Math.sqrt(0.3 - 0.12 ** 2)) / 0.12) ** 2,
        );
        expect([p1?.discordance, p1?.design_effect, p1?.n]).toEqual([0.3, 1, want1]);
        const harm = r.per_type.find((t) => t.metric === "P2.harm");
        const want2 = Math.ceil(((z(0.99) * Math.sqrt(0.1) + z(0.54) * Math.sqrt(0.1)) / 0.1) ** 2);
        expect(harm?.n).toBe(want2);
        expect(r.per_type.find((t) => t.metric === "P5.pass")?.n).toBeNull();
        expect(r.paired_items_per_probe_type).toBe(Math.max(want1, want2));
        const clustered = resizeFromM(L, {
            ...input,
            observations: [
                {
                    ...input.observations[0],
                    items: pairs(100, 30, 10).map((x, i) => ({
                        ...x,
                        cluster: i < 30 ? "f-a" : `f-${i % 7}`,
                    })),
                } as TierInput["observations"][number],
            ],
        });
        expect(clustered.per_type[0]?.design_effect).toBeGreaterThan(1);
    });

    test("only main runs with a recorded zero grade exit in a finished tier count as graded", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-m-"));
        const [a, b, c] = [`${dir}/M-201-pi`, `${dir}/M-202-pi`, `${dir}/M-201-pi-side-haiku`];
        const plan = [
            { group: "main", dir: a, host: "pi", seed: 201 },
            { group: "main", dir: b, host: "pi", seed: 202 },
            { group: "side-haiku", dir: c, host: "pi", seed: 201 },
        ];
        writeFileSync(join(dir, "tier-plan.json"), JSON.stringify({ tier: "M", plan }));
        for (const j of plan) {
            mkdirSync(j.dir);
            writeFileSync(join(j.dir, "grades.jsonl"), "");
        }
        expect(() => gradedMainRuns(dir)).toThrow(/tier-result\.json/);
        const results = [
            { dir: a, run_exit: 0, grade_exit: 0 },
            { dir: b, run_exit: 0, grade_exit: 1 },
            { dir: c, run_exit: 0, grade_exit: 0 },
        ];
        writeFileSync(join(dir, "tier-result.json"), JSON.stringify({ results }));
        expect(() => gradedMainRuns(dir)).toThrow(/main report exit of none/);
        const reports = { main: 1 };
        writeFileSync(join(dir, "tier-result.json"), JSON.stringify({ reports, results }));
        expect(() => gradedMainRuns(dir)).toThrow(/main report exit of 1/);
        writeFileSync(
            join(dir, "tier-result.json"),
            JSON.stringify({ reports: { main: 0 }, results }),
        );
        expect(gradedMainRuns(dir)).toEqual({ main: [a, b], ungraded: [b] });
    });

    test("a planned run that leaves the campaign through `..` or a symlink is refused", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-m-"));
        const other = mkdtempSync(join(tmpdir(), "sim-other-"));
        symlinkSync(other, join(dir, "M-202-pi"));
        for (const leaving of [`${dir}/../${basename(other)}`, `${dir}/M-202-pi`]) {
            const plan = [{ group: "main", dir: leaving, host: "pi", seed: 202 }];
            writeFileSync(join(dir, "tier-plan.json"), JSON.stringify({ tier: "M", plan }));
            expect(() => gradedMainRuns(dir)).toThrow(/plans runs outside itself/);
        }
    });

    test("a main run that exited non-zero stays ungraded even when its grader exited zero", () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-m-"));
        const a = `${dir}/M-201-pi`;
        const plan = [{ group: "main", dir: a, host: "pi", seed: 201 }];
        writeFileSync(join(dir, "tier-plan.json"), JSON.stringify({ tier: "M", plan }));
        const results = [{ dir: a, run_exit: 1, grade_exit: 0 }];
        writeFileSync(
            join(dir, "tier-result.json"),
            JSON.stringify({ reports: { main: 0 }, results }),
        );
        expect(gradedMainRuns(dir).ungraded).toEqual([a]);
    });

    test("resizing refuses a directory of another tier or one missing a registered host or seed", () => {
        const M = loadPrereg("M");
        const dir = mkdtempSync(join(tmpdir(), "sim-m-"));
        const job = (host: string, seed: number) => ({
            group: "main",
            dir: `${dir}/M-${seed}-${host}`,
            host,
            seed,
        });
        const full = M.hosts.flatMap((h) => M.seeds.map((s) => job(h, s)));
        const results = full.map((j) => ({ dir: j.dir, run_exit: 0, grade_exit: 0 }));
        writeFileSync(
            join(dir, "tier-result.json"),
            JSON.stringify({ reports: { main: 0 }, results }),
        );
        writeFileSync(join(dir, "tier-plan.json"), JSON.stringify({ tier: "S", plan: full }));
        expect(() => gradedMainRuns(dir, M)).toThrow(/S tier plan/);
        const pi = full.filter((j) => j.host === "pi");
        writeFileSync(join(dir, "tier-plan.json"), JSON.stringify({ tier: "M", plan: pi }));
        expect(() => gradedMainRuns(dir, M)).toThrow(/opencode/);
        writeFileSync(join(dir, "tier-plan.json"), JSON.stringify({ tier: "M", plan: full }));
        expect(gradedMainRuns(dir, M).ungraded).toEqual([]);
    });

    test("fault-asymmetric pairs leave the discordance and the design effect, as they leave the gates", () => {
        const L = loadPrereg("L");
        const items = pairs(100, 30, 100);
        const observations: TierInput["observations"] = [
            { metric: "P1.pass", unit: "item", cluster_key: "ledger_fact_id", items },
        ];
        const all = resizeFromM(L, { ...base(L), observations, excluded: [], asymmetric: [] });
        const dropped = resizeFromM(L, {
            ...base(L),
            observations,
            excluded: [],
            asymmetric: items.slice(0, 30).map((x) => x.item),
        });
        expect(all.per_type[0]?.discordance).toBe(0.3);
        expect(dropped.per_type[0]).toMatchObject({ pairs: 70, discordance: 0, n: null });
    });

    test("a type M never saw discordant keeps the planning count, so L's count never falls below it", () => {
        const L = loadPrereg("L");
        const r = resizeFromM(L, {
            ...base(L),
            observations: [
                {
                    metric: "P1.pass",
                    unit: "item",
                    cluster_key: "ledger_fact_id",
                    items: pairs(100, 10, 100),
                },
            ],
            excluded: [],
            asymmetric: [],
        });
        expect(r.per_type.find((t) => t.metric === "P1.pass")?.n).toBeLessThan(r.planning);
        expect(r.per_type.some((t) => t.n === null)).toBe(true);
        expect(r.paired_items_per_probe_type).toBe(r.planning);
    });
});

describe("tier profiles", () => {
    const scenario = {
        events: [
            { id: "e-0", kind: "user_turn" },
            { id: "e-1", kind: "session_end" },
        ],
    } as unknown as Scenario;
    test("M adds per-host model-factor runs and one Pi user-sim variant; L runs each arm alone, together", () => {
        const M = loadPrereg("M");
        const all = (p: { seeds: number[] }) => new Map(p.seeds.map((seed) => [seed, scenario]));
        const m = profileJobs(M, all(M), ["pi", "opencode"], "/o", 1000);
        const side = (h: string) =>
            `--side-model ${M.user_sim.model} --tapes /o/M-201-${h}/tape.jsonl`;
        expect(m.map((j) => [j.group, j.host, j.arms.join(","), j.extra.join(" ")])).toEqual([
            ["side-haiku", "pi", "host,eidnara", side("pi")],
            ["side-haiku", "opencode", "host,eidnara", side("opencode")],
            ["usersim-luna", "pi", "host,eidnara", `--user-sim-model ${M.grading.judge.model}`],
        ]);
        const L = loadPrereg("L");
        const l = profileJobs(L, all(L), ["pi"], "/o", 1000);
        expect(l.map((j) => [j.group, j.dir])).toEqual(
            (L.arms.order_by_seed[0] ?? L.arms.run).map((a) => [
                "concurrent",
                `/o/L-301-pi-concurrent/${a}`,
            ]),
        );
        expect(profileJobs(loadPrereg("S"), all(loadPrereg("S")), ["pi"], "/o", 1000)).toEqual([]);
    });
});

const STORE = `
create table notes (id integer primary key, project_path text not null, content text);
create table note_deliveries (delivery_id integer, note_id integer);
create table changefeed (op text, row integer);
CREATE TRIGGER notes_ownership_delete
        BEFORE DELETE ON notes
        WHEN note_caller_project() IS NOT OLD.project_path
        BEGIN
            SELECT RAISE(ABORT, 'note ownership delete is outside the row project');
        END;
CREATE TRIGGER notes_facade_authority_delete
        BEFORE DELETE ON notes
        WHEN facade_authority_domain() = 'notes' AND facade_authority_route() = 'x'
        BEGIN
            SELECT RAISE(ABORT, 'facade');
        END;
CREATE TRIGGER notes_feed_delete AFTER DELETE ON notes BEGIN
        INSERT INTO changefeed VALUES ('tombstone', OLD.id);
        END;
`;

function store(notes: [number, string, string][]): string {
    const path = join(mkdtempSync(join(tmpdir(), "sim-cf-")), "store.db");
    const db = new Database(path);
    db.exec(STORE);
    for (const n of notes) db.run("insert into notes values (?, ?, ?)", n);
    db.run("insert into note_deliveries values (10, 1), (11, 2)");
    db.close();
    return path;
}

describe("counterfactual deletion", () => {
    test("a delete through the store's ownership triggers removes the fact's notes in each project", async () => {
        const path = store([
            [1, "/p/a", "User rule: every commit message must start with [ember_magpie]."],
            [2, "/p/a", "Prefer tabs."],
            [3, "/p/b", "Codename is ember_magpie."],
            [4, "/p/b", "Deploy target is port 18080 on staging."],
        ]);
        const r = await deleteFactNotes(
            path,
            "for the rest of this session, the release codename is [ember_magpie] and the api listens on 8080",
            ["for the rest of this session, use pnpm"],
        );
        expect(r).toEqual({ deleted: [1, 3], remaining: 0 });
        const after = new Database(path);
        expect(after.query("select id from notes").all()).toEqual([{ id: 2 }, { id: 4 }]);
        expect(after.query("select note_id from note_deliveries").all()).toEqual([{ note_id: 2 }]);
        expect(after.query("select row from changefeed").all()).toEqual([{ row: 1 }, { row: 3 }]);
        after.close();
    });

    test("the chosen ids reach the caller before the delete, and planned ids repeat it without matching", async () => {
        const path = store([
            [1, "/p/a", "Codename is ember_magpie."],
            [2, "/p/a", "Prefer tabs."],
        ]);
        const planned: number[][] = [];
        const first = await deleteFactNotes(
            path,
            "codename is ember_magpie",
            [],
            undefined,
            undefined,
            {
                onPlanned: (ids) => planned.push([...ids]),
            },
        );
        expect(planned).toEqual([[1]]);
        expect(first).toEqual({ deleted: [1], remaining: 0 });
        const again = await deleteFactNotes(
            path,
            "codename is ember_magpie",
            [],
            undefined,
            undefined,
            {
                planned: [1],
                onPlanned: (ids) => planned.push([...ids]),
            },
        );
        expect(again).toEqual({ deleted: [1], remaining: 0 });
        expect(planned).toEqual([[1]]);
    });

    test("a store path that is a symlink is refused before any read or delete", async () => {
        const real = store([[1, "/p/a", "Codename is ember_magpie."]]);
        const moved = `${real}.real`;
        renameSync(real, moved);
        symlinkSync(moved, real);
        await expect(deleteFactNotes(real, "codename is ember_magpie", [])).rejects.toThrow(
            /symlink/,
        );
        const after = new Database(moved);
        expect(after.query("select id from notes").all()).toEqual([{ id: 1 }]);
        after.close();
        const root = mkdtempSync(join(tmpdir(), "sim-cf-root-"));
        const target = store([[1, "/p/a", "Codename is ember_magpie."]]);
        symlinkSync(dirname(target), join(root, "context"));
        const viaLink = join(root, "context", "store.db");
        await expect(
            deleteFactNotes(viaLink, "codename is ember_magpie", [], () => undefined, root),
        ).rejects.toThrow(/resolves outside/);
        const kept = new Database(target);
        expect(kept.query("select id from notes").all()).toEqual([{ id: 1 }]);
        kept.close();
    });

    test("a four-word run unique to the fact deletes; one shared with another fact, or three words, does not", () => {
        const fact = "the next step is adding a lark_count field to the cache";
        const carries = factMatcher(fact, ["the next step is adding a ember_count field"], 4);
        expect(carries("we keep adding a lark_count column")).toBe(true);
        expect(carries("Plan: a lark_count field to the cache layer")).toBe(true);
        expect(carries("the next step is adding retries")).toBe(false);
        const bracketed = "the release codename is [ember_magpie]";
        expect(factMatcher(bracketed, [], 4)("codename ember_magpie noted")).toBe(true);
        expect(
            factMatcher(
                bracketed,
                ["the ember_magpie service restarts nightly"],
                4,
            )("codename ember_magpie noted"),
        ).toBe(false);
        const plain = factMatcher("page size for the listing view is fifty", [], 4);
        expect(plain("the listing view is fifty rows")).toBe(true);
        expect(plain("the listing view has paging")).toBe(false);
    });
});
