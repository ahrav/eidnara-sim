import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { git } from "../git";
import { type RepoSpec, repoDir } from "./repos";

/** A construct a template's tasks presuppose: `path` at the pinned commit matches `pattern`. */
export interface Requirement {
    path: string;
    pattern: string;
}

export interface PinnedTree {
    id: string;
    lang: "rust" | "typescript";
    dir: string;
    commit: string;
}

/** The text of `path` in `tree` at its pinned commit, or null when the commit holds no such file. */
export type ReadAt = (tree: PinnedTree, path: string) => string | null;

export const LANG_OF_ROLE: Record<RepoSpec["role"], PinnedTree["lang"]> = {
    "rust-service": "rust",
    "typescript-package": "typescript",
};

export function pinnedTrees(repos: RepoSpec[]): PinnedTree[] {
    return repos.flatMap((r) => [
        { id: r.id, lang: LANG_OF_ROLE[r.role], dir: repoDir(r.id), commit: r.commit },
        {
            id: r.twin.id,
            lang: LANG_OF_ROLE[r.role],
            dir: repoDir(r.twin.id),
            commit: r.twin.commit,
        },
    ]);
}

/** A path the pinned commit lacks reads as null; a checkout or commit git cannot read throws. */
export const readPinned: ReadAt = (tree, path) => {
    const listed = git(tree.dir, ["ls-tree", "--name-only", tree.commit, "--", path]).trim();
    if (listed !== path) return null;
    return git(tree.dir, ["cat-file", "blob", `${tree.commit}:${path}`]);
};

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
    typeof v === "object" && v !== null && !Array.isArray(v);

function templatesOf(bank: unknown, lang: string): { id: string; requires: unknown }[] {
    const kinds = isObject(bank) ? bank[lang] : undefined;
    if (!isObject(kinds)) return [];
    return Object.values(kinds).flatMap((list) =>
        Array.isArray(list)
            ? list.filter(isObject).map((t) => ({ id: String(t.id), requires: t.requires }))
            : [],
    );
}

/** Invalid regular-expression syntax counts as a pattern mismatch. */
const matches = (pattern: string, text: string) => {
    try {
        return new RegExp(pattern, "m").test(text);
    } catch {
        return false;
    }
};

/** Patterns match with the `m` flag, so `^` and `$` anchor lines. */
export function presuppositionProblems(
    bank: unknown,
    trees: PinnedTree[],
    read: ReadAt = readPinned,
): string[] {
    const problems: string[] = [];
    for (const tree of trees) {
        const at = `${tree.id}@${tree.commit.slice(0, 7)}`;
        const files = new Map<string, string | null>();
        for (const t of templatesOf(bank, tree.lang)) {
            const list = Array.isArray(t.requires) ? t.requires : [];
            if (list.length === 0) problems.push(`${t.id}: names no requirement`);
            for (const r of list) {
                if (!isObject(r) || typeof r.path !== "string" || typeof r.pattern !== "string") {
                    problems.push(`${t.id}: a requirement lacks a path or pattern`);
                    continue;
                }
                if (!files.has(r.path)) files.set(r.path, read(tree, r.path));
                const text = files.get(r.path);
                if (text === null || text === undefined) {
                    problems.push(`${t.id}: ${at} has no ${r.path}`);
                } else if (!matches(r.pattern, text)) {
                    problems.push(`${t.id}: ${at} ${r.path} lacks /${r.pattern}/`);
                }
            }
        }
    }
    return [...new Set(problems)];
}

const checked = new Set<string>();

export function checkPresuppositions(
    bank: unknown,
    repos: RepoSpec[],
    required: boolean,
    read: ReadAt = readPinned,
): boolean {
    const trees = pinnedTrees(repos);
    const absent = trees.filter((t) => !existsSync(join(t.dir, ".git")));
    if (absent.length > 0) {
        if (!required) return false;
        throw new Error(
            `fact-bank requirements need the pinned corpus checkouts; ${absent.map((t) => t.id).join(", ")} missing (run bun run corpus:repos)`,
        );
    }
    const key = createHash("sha256")
        .update(JSON.stringify([bank, trees]))
        .digest("hex");
    if (read === readPinned && checked.has(key)) return true;
    const problems = presuppositionProblems(bank, trees, read);
    if (problems.length > 0) {
        throw new Error(
            `fact-bank templates presuppose constructs a pinned tree lacks:\n${problems.join("\n")}`,
        );
    }
    if (read === readPinned) checked.add(key);
    return true;
}
