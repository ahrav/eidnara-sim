import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export function realExisting(path: string): string {
    const rest: string[] = [];
    let existing = resolve(path);
    while (!existsSync(existing) && dirname(existing) !== existing) {
        rest.unshift(basename(existing));
        existing = dirname(existing);
    }
    return join(realpathSync(existing), ...rest);
}

/**
 * `contains` checks containment by path component: `/a/b` is within `/a`, `/ab` is outside it,
 * and equal paths qualify only when `strict` is `false`.
 */
export function contains(root: string, path: string, strict = false): boolean {
    const rel = relative(root, path);
    if (rel === "") return !strict;
    return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}
