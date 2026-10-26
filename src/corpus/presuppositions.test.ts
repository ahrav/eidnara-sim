import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    checkPresuppositions,
    type PinnedTree,
    pinnedTrees,
    presuppositionProblems,
    readPinned,
} from "./presuppositions";
import { loadRepos, type RepoSpec } from "./repos";
import { CORPUS_DIR } from "./sources";

const tree = (id: string, lang: PinnedTree["lang"]): PinnedTree => ({
    id,
    lang,
    dir: `/nowhere/${id}`,
    commit: "a".repeat(40),
});
const TREES = [tree("svc", "rust"), tree("svc-twin", "rust"), tree("pkg", "typescript")];
const FILES: Record<string, Record<string, string>> = {
    svc: { "src/server.rs": "const MAX_CONNECTIONS: usize = 250;\nfn run() {}\n" },
    "svc-twin": { "src/server.rs": "fn run() {}\n" },
    pkg: { "src/ws/index.ts": "this.close = raw.close.bind(raw)\n" },
};
const read = (t: PinnedTree, path: string) => FILES[t.id]?.[path] ?? null;
const bank = (rust: unknown[], typescript: unknown[] = []) => ({
    schema: "sim-fact-bank/v4",
    rust: { rejected: rust, filler: ["Tidy the README."] },
    typescript: { rejected: typescript },
    any: { lookup: [{ id: "lookup-port", requires: [{ path: "nowhere", pattern: "x" }] }] },
});
const template = (id: string, ...requires: [string, string][]) => ({
    id,
    requires: requires.map(([path, pattern]) => ({ path, pattern })),
});

describe("template presuppositions", () => {
    test("a requirement every tree of its language holds passes, and other languages are not read", () => {
        const b = bank(
            [template("rs-run", ["src/server.rs", "^fn run\\(\\)"])],
            [template("ts-close", ["src/ws/index.ts", "this\\.close = raw\\.close"])],
        );
        expect(presuppositionProblems(b, TREES, read)).toEqual([]);
    });

    test("a missing file, a pattern miss, and a miss in the twin alone are named per tree", () => {
        const b = bank([
            template("rs-cap", ["src/server.rs", "MAX_CONNECTIONS"]),
            template("rs-db", ["src/db.rs", "Mutex<State>"]),
        ]);
        expect(presuppositionProblems(b, TREES, read)).toEqual([
            "rs-db: svc@aaaaaaa has no src/db.rs",
            "rs-cap: svc-twin@aaaaaaa src/server.rs lacks /MAX_CONNECTIONS/",
            "rs-db: svc-twin@aaaaaaa has no src/db.rs",
        ]);
    });

    test("a template without requirements, or with a malformed one, is refused", () => {
        const b = bank([
            { id: "rs-none" },
            { id: "rs-bad", requires: [{ path: "src/server.rs" }] },
        ]);
        expect(presuppositionProblems(b, [TREES[0] as PinnedTree], read)).toEqual([
            "rs-none: names no requirement",
            "rs-bad: a requirement lacks a path or pattern",
        ]);
    });

    test("a missing checkout refuses a required check and skips an optional one", () => {
        const repos = [
            {
                id: "absent-svc",
                role: "rust-service",
                commit: "b".repeat(40),
                twin: { id: "absent-svc-twin", commit: "c".repeat(40), renames: [] },
            },
        ] as unknown as RepoSpec[];
        const b = bank([template("rs-run", ["src/server.rs", "fn run"])]);
        expect(checkPresuppositions(b, repos, false)).toBe(false);
        expect(() => checkPresuppositions(b, repos, true)).toThrow(
            /absent-svc, absent-svc-twin missing \(run bun run corpus:repos\)/,
        );
    });
});

const repos = loadRepos();
const cloned = pinnedTrees(repos).every((t) => existsSync(join(t.dir, ".git")));

describe("the pinned corpus checkouts", () => {
    test.skipIf(!cloned)("hold every construct the fact bank's templates presuppose", () => {
        const b = JSON.parse(readFileSync(join(CORPUS_DIR, "fact-bank.json"), "utf8"));
        expect(presuppositionProblems(b, pinnedTrees(repos))).toEqual([]);
        expect(checkPresuppositions(b, repos, true)).toBe(true);
    });

    test.skipIf(!cloned)("are read from the object store at the pinned commit", () => {
        const [base] = pinnedTrees(repos);
        const head = readPinned(base as PinnedTree, "Cargo.toml");
        expect(head).toContain("[package]");
        expect(readPinned(base as PinnedTree, "no/such/file.rs")).toBeNull();
        expect(
            readPinned({ ...(base as PinnedTree), commit: "0".repeat(40) }, "Cargo.toml"),
        ).toBeNull();
    });
});
