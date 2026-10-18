import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Children, SIGTERM_EXIT } from "./children";

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
