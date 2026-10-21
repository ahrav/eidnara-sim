import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeExclusive } from "./atomic";

export const FAKETIME_VERSION = "0.9.10";
export const FAKETIME_SHA256 = "729ad33b9c750a50d9c68e97b90499680a74afd1568d859c574c0fe56fe7947f";
export const VENDOR = resolve(import.meta.dir, "../../vendor/build");
export const FAKETIME_LIB = join(
    VENDOR,
    `libfaketime-${FAKETIME_VERSION}`,
    "src",
    "libfaketimeMT.so.1",
);

/** Each download, extraction, and build step of the vendored libfaketime ends within this. */
const BUILD_STEP_MS = 600_000;

/**
 * Builds the vendored libfaketime in a staging directory of its own and renames the library
 * into place, so concurrent builders each publish a complete build at `FAKETIME_LIB` and a
 * reader sees either no library or a complete one.
 */
export async function buildFaketime(): Promise<string> {
    if (existsSync(FAKETIME_LIB)) return FAKETIME_LIB;
    mkdirSync(VENDOR, { recursive: true });
    const url = `https://github.com/wolfcw/libfaketime/archive/refs/tags/v${FAKETIME_VERSION}.tar.gz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(BUILD_STEP_MS) });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const tarball = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(tarball).digest("hex");
    if (digest !== FAKETIME_SHA256) {
        throw new Error(`libfaketime tarball sha256 ${digest}, pinned ${FAKETIME_SHA256}`);
    }
    const staging = mkdtempSync(join(VENDOR, "staging-"));
    try {
        const archive = join(staging, `libfaketime-${FAKETIME_VERSION}.tar.gz`);
        writeFileSync(archive, tarball);
        const src = join(staging, `libfaketime-${FAKETIME_VERSION}`, "src");
        for (const argv of [
            ["tar", "xzf", archive, "-C", staging],
            ["make", "-C", src, "libfaketimeMT.so.1"],
        ]) {
            // Async with a timeout, so a signal to the caller is handled and a stalled step ends.
            const child = Bun.spawn(argv, {
                stdout: "pipe",
                stderr: "pipe",
                timeout: BUILD_STEP_MS,
            });
            const [code, stderr] = await Promise.all([
                child.exited,
                new Response(child.stderr).text(),
            ]);
            if (code !== 0) throw new Error(`${argv.join(" ")}: ${stderr || `exit ${code}`}`);
        }
        mkdirSync(dirname(FAKETIME_LIB), { recursive: true });
        renameSync(join(src, "libfaketimeMT.so.1"), FAKETIME_LIB);
    } finally {
        rmSync(staging, { recursive: true, force: true });
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

/**
 * What an offset write left for the journal: the whole seconds and the wall bounds of the rename
 * that put them in effect. A process reads the new offset from no earlier than `offset_wall_ms`
 * and the old one from no later than `offset_settled_ms`.
 */
export interface OffsetWrite {
    offset_s: number;
    offset_wall_ms: number;
    offset_settled_ms: number;
}

/**
 * The offset targets `baseMs + scenarioMs` at wall time `wallMs`, with up to 500 ms of rounding
 * error. The returned record names the whole seconds the processes read from the rename on and
 * the wall instants around that rename, so the journal can place log stamps by the offset in
 * effect, placing a stamp from inside the rename through both offsets.
 */
export function writeOffset(
    file: string,
    baseMs: number,
    scenarioMs: number,
    wallMs = Date.now(),
): OffsetWrite {
    const seconds = Math.round((baseMs + scenarioMs - wallMs) / 1000);
    mkdirSync(dirname(file), { recursive: true });
    const staged = `${file}.${process.pid}`;
    writeExclusive(staged, `${seconds >= 0 ? "+" : ""}${seconds}\n`);
    const before = Date.now();
    renameSync(staged, file);
    return { offset_s: seconds, offset_wall_ms: before, offset_settled_ms: Date.now() };
}

export function readOffsetSeconds(file: string): number {
    return Number(readFileSync(file, "utf8").trim());
}
