import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launch, sandboxAvailable, writeLauncher } from "./launcher";
import { ownedProcesses, processStart, running, stopOwnedTree } from "./procs";

const dirs: string[] = [];
afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const root = () => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "sim-procs-")));
    dirs.push(d);
    return d;
};

async function sandboxed(script: string) {
    const r = root();
    const argv = launch(writeLauncher(r), [r], {}, ["/bin/sh", "-c", script]);
    const child = spawn(argv[0] as string, argv.slice(1), { stdio: "ignore" });
    const pid = child.pid as number;
    let inner: number | undefined;
    for (let i = 0; i < 100 && inner === undefined; i++) {
        await Bun.sleep(50);
        inner = ownedProcesses(pid).find((p) => p !== pid);
    }
    return { pid, inner: inner as number };
}

test.skipIf(!sandboxAvailable())(
    "stopping the launcher's tree ends the user process inside the sandbox",
    async () => {
        const { pid, inner } = await sandboxed("exec /bin/sleep 300");
        expect(running(inner)).toBe(true);
        expect(await stopOwnedTree(pid, 2_000)).toBe(true);
        expect(running(inner)).toBe(false);
    },
);

test.skipIf(!sandboxAvailable())(
    "a process that ignores SIGTERM is stopped by SIGKILL after the grace period",
    async () => {
        const { pid, inner } = await sandboxed("trap '' TERM; while :; do sleep 1; done");
        const started = Date.now();
        expect(await stopOwnedTree(pid, 500)).toBe(true);
        expect(Date.now() - started).toBeGreaterThanOrEqual(500);
        expect(running(inner)).toBe(false);
    },
);

test.skipIf(!sandboxAvailable())("a read-only kept path refuses writes inside the sandbox", () => {
    const r = root();
    const ro = join(r, "ro");
    mkdirSync(ro);
    const argv = launch(
        writeLauncher(r),
        [r],
        {},
        ["/bin/sh", "-c", `touch ${ro}/x && touch ${r}/y`],
        [ro],
    );
    const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("Read-only file system");
});

test.skipIf(!sandboxAvailable())(
    "a child forked while the tree stops dies with the sandbox's pid namespace",
    async () => {
        const { pid } = await sandboxed(
            "trap 'sleep 3137 & exit 0' TERM; while :; do sleep 1; done",
        );
        expect(await stopOwnedTree(pid, 5_000)).toBe(true);
        const uid = String(process.getuid?.() ?? 0);
        const left = Bun.spawnSync(["pgrep", "-u", uid, "-x", "-f", "sleep 3137"]);
        expect(left.stdout.toString().trim()).toBe("");
    },
);

test("a process start time identifies one process across pid reuse", () => {
    expect(processStart(process.pid)).toBe(processStart(process.pid));
    expect(processStart(2 ** 22 + 7)).toBeNull();
});

test("a pid whose start time changed is another process, so it is neither running nor signalled", () => {
    const start = processStart(process.pid) as string;
    expect(running(process.pid, start)).toBe(true);
    expect(running(process.pid, "1")).toBe(false);
});
