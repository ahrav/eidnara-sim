import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Children, SIGTERM_EXIT } from "./children";
import { running } from "./procs";

const log = () => join(mkdtempSync(join(tmpdir(), "sim-children-")), "log");
const IDLE = ["-e", "setInterval(() => {}, 1000)"];
const STUBBORN = ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"];

describe("tier children", () => {
    test("a child past its limit stops with SIGTERM, and one that ignores it with SIGKILL", async () => {
        const children = new Children(process.env, 300);
        expect(await children.run(IDLE, log(), 200)).toBe(SIGTERM_EXIT);
        expect(await children.run(STUBBORN, log(), 200)).toBe(137);
    });

    test("stopAll signals live children, kills stubborn ones, and starts no new child", async () => {
        const children = new Children(process.env, 300);
        const idle = children.run(IDLE, log());
        const stubborn = children.run(STUBBORN, log());
        await Bun.sleep(300);
        await children.stopAll("SIGTERM");
        expect(await idle).toBe(SIGTERM_EXIT);
        expect(await stubborn).toBe(137);
        const started = Date.now();
        expect(await children.run(IDLE, log())).toBe(SIGTERM_EXIT);
        expect(Date.now() - started).toBeLessThan(100);
    });
});

test("a hangup stops children with SIGTERM, the signal every run tears down on", async () => {
    const children = new Children(process.env, 300);
    const handled = children.run(
        ["-e", "process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000)"],
        log(),
    );
    await Bun.sleep(300);
    await children.stopAll("SIGHUP");
    expect(await handled).toBe(SIGTERM_EXIT);
});

test("a stalled teardown's SIGKILL reaches the child's descendants", async () => {
    const children = new Children(process.env, 300);
    const path = log();
    const code = await children.run(
        [
            "-e",
            "const p = Bun.spawn(['sleep', '60']); console.log(p.pid); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
        ],
        path,
        300,
    );
    expect(code).toBe(137);
    const grandchild = Number(readFileSync(path, "utf8").trim());
    await Bun.sleep(100);
    expect(running(grandchild)).toBe(false);
});

test("stopAll settles when a child's spawn failed", async () => {
    const children = new Children({ PATH: "/nonexistent" }, 300);
    const failed = children.run(["-e", "1"], log());
    const stopped = children.stopAll("SIGTERM");
    expect(
        await Promise.race([stopped.then(() => "settled"), Bun.sleep(2_000).then(() => "hung")]),
    ).toBe("settled");
    expect(await failed).toBe(127);
});
