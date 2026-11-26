import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../config/config";
import { launch, sandboxAvailable, writeLauncher } from "./launcher";
import { FAKETIME_LIB, faketimeEnv, VENDOR, writeOffset } from "./timeinject";
import { sandboxPath, toolbinDir, toolchainEnv, writeToolWrappers } from "./toolchain";

const built = existsSync(FAKETIME_LIB);
const cc = Bun.which("cc");

test("a worktree that holds a built interposer holds the one this tree's patch names", () => {
    const builds = existsSync(VENDOR)
        ? readdirSync(VENDOR).filter((entry) => entry.startsWith("libfaketime-"))
        : [];
    // The tests that run the interposer skip while its library is absent, so a build
    // directory without the current library asks for a build.
    if (builds.length > 0) expect(built, "run: bun scripts/build-faketime.ts").toBe(true);
});

/**
 * EARLY_ALLOCATOR is a C program with its own allocator, which initializes at the first
 * allocation as jemalloc does: it reads a monotonic clock and creates a default condition
 * variable. FIRST_ALLOCATION is a library of the program whose constructor allocates, so that
 * initialization runs ahead of the preload's constructor, as it does in rustc through the C++
 * runtime's constructor; the constructor then reads the wall clock. With EARLY_MODE set, the
 * constructor first creates a condition variable and destroys it (`destroy`) or waits on it
 * with a deadline at the epoch (`wait`). An allocation that arrives during the allocator's
 * initialization ends the process with status 42, the point where jemalloc waits on its own
 * initialization lock. The preload exports FAKETIME_SHARED during its initialization.
 */
const FIRST_ALLOCATION = `
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
long long first_wall;
int first_shared = -1, first_call = -1;
__attribute__((constructor)) static void first(void)
{
    void *volatile p = malloc(1);
    const char *mode = getenv("EARLY_MODE");
    struct timespec wall;
    free(p);
    if (mode != NULL) {
        pthread_cond_t c;
        pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;
        struct timespec epoch = {0, 0};
        pthread_cond_init(&c, NULL);
        if (strcmp(mode, "wait") == 0) {
            pthread_mutex_lock(&m);
            first_call = pthread_cond_timedwait(&c, &m, &epoch);
            pthread_mutex_unlock(&m);
        } else {
            first_call = pthread_cond_destroy(&c);
        }
    }
    first_shared = getenv("FAKETIME_SHARED") != NULL;
    clock_gettime(CLOCK_REALTIME, &wall);
    first_wall = wall.tv_sec;
}
`;
const EARLY_ALLOCATOR = `
#define _GNU_SOURCE
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

extern long long first_wall;
extern int first_shared, first_call;
static _Alignas(16) char heap[1 << 24];
static size_t used;
static int state;
static struct timespec early;
static int early_result = -1, cond_result = -1, shared_early = -1;
static pthread_cond_t cond;

static void *take(size_t n)
{
    if (state == 1) _exit(42);
    if (state == 0) {
        state = 1;
        early_result = clock_gettime(CLOCK_MONOTONIC_COARSE, &early);
        memset(&cond, 0xa5, sizeof cond);
        cond_result = pthread_cond_init(&cond, NULL);
        shared_early = getenv("FAKETIME_SHARED") != NULL;
        state = 2;
    }
    size_t need = (n + 31) & ~(size_t)15;
    if (used + need > sizeof heap) return NULL;
    size_t *p = (size_t *)(heap + used);
    used += need;
    *p = n;
    return (char *)p + 16;
}
void *malloc(size_t n) { return take(n); }
void free(void *p) { (void)p; }
void *calloc(size_t a, size_t b)
{
    void *p = take(a * b);
    if (p) memset(p, 0, a * b);
    return p;
}
void *realloc(void *old, size_t n)
{
    void *p = take(n);
    if (p && old) {
        size_t was = *(size_t *)((char *)old - 16);
        memcpy(p, old, was < n ? was : n);
    }
    return p;
}

int main(void)
{
    struct timespec real, mono, until;
    pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
    clock_gettime(CLOCK_REALTIME, &real);
    clock_gettime(CLOCK_MONOTONIC, &mono);
    until = real;
    until.tv_nsec += 20 * 1000 * 1000;
    if (until.tv_nsec >= 1000000000) { until.tv_sec += 1; until.tv_nsec -= 1000000000; }
    pthread_mutex_lock(&mutex);
    int waited = pthread_cond_timedwait(&cond, &mutex, &until);
    pthread_mutex_unlock(&mutex);
    printf("{\\"earlyResult\\":%d,\\"condResult\\":%d,\\"sharedEarly\\":%d,\\"early\\":%lld,"
           "\\"firstCall\\":%d,\\"sharedFirst\\":%d,\\"firstWall\\":%lld,\\"sharedMain\\":%d,"
           "\\"mono\\":%lld,\\"real\\":%lld,\\"waited\\":%d}\\n",
           early_result, cond_result, shared_early, (long long)early.tv_sec, first_call,
           first_shared, first_wall, getenv("FAKETIME_SHARED") != NULL, (long long)mono.tv_sec,
           (long long)real.tv_sec, waited);
    return 0;
}
`;

const ETIMEDOUT = 110;

interface EarlyReport {
    earlyResult: number;
    condResult: number;
    sharedEarly: number;
    early: number;
    firstCall: number;
    sharedFirst: number;
    firstWall: number;
    sharedMain: number;
    mono: number;
    real: number;
    waited: number;
}

test.skipIf(!built || !cc)(
    "the preload answers an allocator's clock read and condition variable ahead of its own constructor, and fakes the wall clock from the next read on",
    () => {
        const dir = mkdtempSync(join(tmpdir(), "sim-preload-"));
        try {
            const binary = join(dir, "early");
            writeFileSync(join(dir, "first.c"), FIRST_ALLOCATION);
            writeFileSync(join(dir, "early.c"), EARLY_ALLOCATOR);
            const link = ["-L", dir, "-lfirst", `-Wl,-rpath,${dir}`, "-lpthread"];
            for (const argv of [
                ["-O1", "-shared", "-fPIC", "-o", join(dir, "libfirst.so"), join(dir, "first.c")],
                ["-O1", "-rdynamic", "-o", binary, join(dir, "early.c"), ...link],
            ]) {
                const compiled = Bun.spawnSync([cc as string, ...argv], {
                    stdout: "pipe",
                    stderr: "pipe",
                });
                if (compiled.exitCode !== 0) throw new Error(compiled.stderr.toString());
            }
            const offset = join(dir, "offset");
            const days30 = 30 * 86_400;
            writeFileSync(offset, `+${days30}\n`);
            // The program is the first process under the preload, so FAKETIME_SHARED starts unset.
            const run = (env: Record<string, string>): EarlyReport => {
                const r = Bun.spawnSync([binary], {
                    env,
                    stdout: "pipe",
                    stderr: "pipe",
                    timeout: 20_000,
                    killSignal: "SIGKILL",
                });
                if (r.exitCode !== 0) {
                    const how = `exit ${r.exitCode}, signal ${r.signalCode ?? "none"}`;
                    throw new Error(`${binary} under ${JSON.stringify(env)}: ${how}: ${r.stderr}`);
                }
                return JSON.parse(r.stdout.toString()) as EarlyReport;
            };
            const plain = run({});
            const under = run(faketimeEnv(offset));
            // Both calls succeeded, and FAKETIME_SHARED was still unset after them and at the
            // constructor's wall-clock read: the preload's initialization, which exports it,
            // ran from that read on.
            expect([under.earlyResult, under.condResult]).toEqual([0, 0]);
            expect([under.sharedEarly, under.sharedFirst, under.sharedMain]).toEqual([0, 0, 1]);
            // Both reads are the kernel's monotonic clock, the same clock the plain run reads.
            expect(under.mono - under.early).toBeGreaterThanOrEqual(0);
            expect(under.mono - under.early).toBeLessThan(10);
            expect(Math.abs(under.mono - plain.mono)).toBeLessThan(20);
            // A wall-clock read ahead of the constructor takes the upstream path and carries the
            // offset, as does the read in main.
            const wall = Date.now() / 1000;
            expect(Math.abs(plain.firstWall - wall)).toBeLessThan(20);
            expect(Math.abs(under.firstWall - (wall + days30))).toBeLessThan(20);
            expect(Math.abs(under.real - (wall + days30))).toBeLessThan(20);
            // The condition variable created ahead of the constructor serves a timed wait.
            expect(under.waited).toBe(ETIMEDOUT);
            // A destroy or a timed wait ahead of the constructor initializes the preload and
            // reaches the C library's function.
            const destroyed = run({ ...faketimeEnv(offset), EARLY_MODE: "destroy" });
            expect([destroyed.firstCall, destroyed.sharedFirst]).toEqual([0, 1]);
            const waited = run({ ...faketimeEnv(offset), EARLY_MODE: "wait" });
            expect([waited.firstCall, waited.sharedFirst]).toEqual([ETIMEDOUT, 1]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    },
    60_000,
);

const config = loadConfig();
const clippy =
    built &&
    ["cargo", "cargo-clippy", "clippy-driver"].every((tool) =>
        config.toolchain.bin.some((dir) => existsSync(join(dir, tool))),
    ) &&
    sandboxAvailable();

test.skipIf(!clippy)(
    "cargo clippy lints an edited crate in the sandbox under scenario time, at the starting offset and after a clock jump in each direction",
    () => {
        const base = join(process.cwd(), "runs", "test-sandbox");
        mkdirSync(base, { recursive: true });
        const root = mkdtempSync(join(base, "r-"));
        try {
            const launcher = writeLauncher(root);
            writeToolWrappers(config, launcher);
            const { path, env } = toolchainEnv(config, launcher);
            const arm = join(dirname(launcher), "arm");
            const workspace = join(arm, "workspaces", "probe");
            const home = join(arm, "home");
            const offset = join(dirname(launcher), "clock", "offset");
            mkdirSync(join(workspace, "src"), { recursive: true });
            mkdirSync(home, { recursive: true });
            writeFileSync(
                join(workspace, "Cargo.toml"),
                '[package]\nname = "clippy-probe"\nversion = "0.1.0"\nedition = "2021"\n',
            );
            const source = join(workspace, "src", "lib.rs");
            const fn = (name: string, by: number) =>
                `pub fn ${name}(x: i32) -> i32 {\n    return x * ${by};\n}\n`;
            const hour = 3_600_000;
            const baseHours = 8;
            const at = (scenarioMs: number) =>
                writeOffset(offset, Date.now() + baseHours * hour, scenarioMs);
            const ro = [
                ...config.toolchain.keep,
                toolbinDir(launcher),
                dirname(dirname(FAKETIME_LIB)),
                dirname(offset),
            ];
            const vars = { ...faketimeEnv(offset), ...env, HOME: home };
            const run = (script: string) => {
                const argv = launch(
                    launcher,
                    [arm],
                    vars,
                    ["/bin/sh", "-c", script],
                    ro,
                    workspace,
                );
                const r = Bun.spawnSync(["timeout", "-s", "KILL", "120", ...argv], {
                    env: { PATH: sandboxPath(path) },
                    stdout: "pipe",
                    stderr: "pipe",
                });
                return `${r.stdout.toString()}${r.stderr.toString()}\nlaunch=${r.exitCode}\n`;
            };
            const lint = "cargo clippy --offline 2>&1; echo status=$?; echo clock=$(date +%s)";
            // Each run lints a source line the earlier runs lacked, so clippy-driver starts for it.
            const lintedAt = (out: string, line: number, scenarioHours: number) => {
                expect(out).toContain(`src/lib.rs:${line}`);
                expect(out).toContain("clippy::needless_return");
                expect(out).toContain("status=0");
                expect(out).toContain("launch=0");
                const clock = Number(/^clock=(\d+)$/m.exec(out)?.[1]);
                const expected = (Date.now() + (baseHours + scenarioHours) * hour) / 1000;
                expect(Math.abs(clock - expected)).toBeLessThan(120);
            };

            at(0);
            writeFileSync(source, fn("double", 2));
            const first = run(`clippy-driver --version; ${lint}`);
            expect(first).toMatch(/^clippy \d+\.\d+/m);
            lintedAt(first, 2, 0);

            // Four days of scenario time pass.
            at(96 * hour);
            writeFileSync(source, fn("double", 2) + fn("triple", 3));
            lintedAt(run(lint), 5, 96);

            // The clock moves to 30 days before the first run; the lint and a build both finish.
            at(-720 * hour);
            writeFileSync(source, fn("double", 2) + fn("triple", 3) + fn("fourfold", 4));
            const earlier = run(`${lint}; cargo build --offline 2>&1; echo build=$?`);
            lintedAt(earlier, 8, -720);
            expect(earlier).toContain("build=0");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    },
    420_000,
);
