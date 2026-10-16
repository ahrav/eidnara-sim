import { closeSync, constants, openSync, renameSync, writeFileSync } from "node:fs";

/** Creates `path` exclusively without following a link and writes `text` into it. */
export function writeExclusive(path: string, text: string): void {
    const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = constants;
    let fd: number;
    try {
        fd = openSync(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
    } catch (caught) {
        throw new Error(`${path} exists or is a link: ${(caught as Error).message}`);
    }
    try {
        writeFileSync(fd, text);
    } finally {
        closeSync(fd);
    }
}

/** Writes `<path>.<pid>` exclusively, then renames it over `path`. */
export function writeAtomic(path: string, text: string): void {
    const staging = `${path}.${process.pid}`;
    writeExclusive(staging, text);
    renameSync(staging, path);
}
