import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { releaseLease, takeLease } from "./journal";

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
 * Builds the vendored libfaketime once for the repository. Invocations serialise on a lease over
 * the vendor directory, and the finished tree is renamed into place, so a reader sees either no
 * library or a complete one.
 */
export async function buildFaketime(): Promise<string> {
    if (existsSync(FAKETIME_LIB)) return FAKETIME_LIB;
    mkdirSync(VENDOR, { recursive: true });
    const deadline = Date.now() + BUILD_STEP_MS;
    for (;;) {
        try {
            takeLease(VENDOR);
            break;
        } catch (caught) {
            if (Date.now() >= deadline) throw caught;
            await Bun.sleep(1_000);
        }
    }
    try {
        if (existsSync(FAKETIME_LIB)) return FAKETIME_LIB;
        const url = `https://github.com/wolfcw/libfaketime/archive/refs/tags/v${FAKETIME_VERSION}.tar.gz`;
        const response = await fetch(url, { signal: AbortSignal.timeout(BUILD_STEP_MS) });
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        const tarball = Buffer.from(await response.arrayBuffer());
        const digest = createHash("sha256").update(tarball).digest("hex");
        if (digest !== FAKETIME_SHA256) {
            throw new Error(`libfaketime tarball sha256 ${digest}, pinned ${FAKETIME_SHA256}`);
        }
        const archive = join(VENDOR, `libfaketime-${FAKETIME_VERSION}.tar.gz`);
        writeFileSync(archive, tarball);
        const tree = `libfaketime-${FAKETIME_VERSION}`;
        const stage = join(VENDOR, `stage.${process.pid}`);
        rmSync(stage, { recursive: true, force: true });
        mkdirSync(stage);
        for (const argv of [
            ["tar", "xzf", archive, "-C", stage],
            ["make", "-C", join(stage, tree, "src"), "libfaketimeMT.so.1"],
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
        // An earlier build that stopped short leaves the target without its library; the lease
        // held here makes removing it safe.
        rmSync(join(VENDOR, tree), { recursive: true, force: true });
        renameSync(join(stage, tree), join(VENDOR, tree));
        rmSync(stage, { recursive: true, force: true });
        return FAKETIME_LIB;
    } finally {
        releaseLease(VENDOR);
    }
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
