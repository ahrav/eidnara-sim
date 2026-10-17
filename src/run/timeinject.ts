import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const FAKETIME_VERSION = "0.9.10";
export const FAKETIME_SHA256 = "729ad33b9c750a50d9c68e97b90499680a74afd1568d859c574c0fe56fe7947f";
export const VENDOR = resolve(import.meta.dir, "../../vendor/build");
export const FAKETIME_LIB = join(
    VENDOR,
    `libfaketime-${FAKETIME_VERSION}`,
    "src",
    "libfaketimeMT.so.1",
);

export async function buildFaketime(): Promise<string> {
    if (existsSync(FAKETIME_LIB)) return FAKETIME_LIB;
    mkdirSync(VENDOR, { recursive: true });
    const url = `https://github.com/wolfcw/libfaketime/archive/refs/tags/v${FAKETIME_VERSION}.tar.gz`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const tarball = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(tarball).digest("hex");
    if (digest !== FAKETIME_SHA256) {
        throw new Error(`libfaketime tarball sha256 ${digest}, pinned ${FAKETIME_SHA256}`);
    }
    const archive = join(VENDOR, `libfaketime-${FAKETIME_VERSION}.tar.gz`);
    writeFileSync(archive, tarball);
    const src = join(VENDOR, `libfaketime-${FAKETIME_VERSION}`, "src");
    for (const argv of [
        ["tar", "xzf", archive, "-C", VENDOR],
        ["make", "-C", src, "libfaketimeMT.so.1"],
    ]) {
        const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
        if (r.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${r.stderr.toString()}`);
    }
    return FAKETIME_LIB;
}

/**
 * Processes read scenario time from `file` on every call: libfaketime applies the offset it
 * holds to the wall clock, and the monotonic clock stays real, so in-process timers keep wall
 * pace while dates jump.
 */
export function faketimeEnv(file: string): Record<string, string> {
    return {
        LD_PRELOAD: FAKETIME_LIB,
        FAKETIME_TIMESTAMP_FILE: file,
        FAKETIME_NO_CACHE: "1",
        FAKETIME_DONT_FAKE_MONOTONIC: "1",
    };
}

/** The offset targets `baseMs + scenarioMs` at wall time `wallMs`, with up to 500 ms of rounding error. */
export function writeOffset(file: string, baseMs: number, scenarioMs: number, wallMs = Date.now()) {
    const seconds = Math.round((baseMs + scenarioMs - wallMs) / 1000);
    mkdirSync(dirname(file), { recursive: true });
    const staged = `${file}.${process.pid}`;
    writeFileSync(staged, `${seconds >= 0 ? "+" : ""}${seconds}\n`);
    renameSync(staged, file);
}

export function readOffsetSeconds(file: string): number {
    return Number(readFileSync(file, "utf8").trim());
}
