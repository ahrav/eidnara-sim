import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("stop reasons", () => {
    test("a stop names its cause: the limit, the stopWhen check, or nothing for an outside signal", async () => {
        const reasons: string[] = [];
        const onStop = (reason: string) => void reasons.push(reason);
        const children = new Children(process.env, 300, 50);
        expect(await children.run(IDLE, log(), 200, undefined, onStop)).toBe(SIGTERM_EXIT);
        expect(reasons).toEqual(["limit"]);
        expect(await children.run(IDLE, log(), undefined, () => true, onStop)).toBe(SIGTERM_EXIT);
        expect(reasons).toEqual(["limit", "stopWhen"]);
        const outside = children.run(IDLE, log(), undefined, () => false, onStop);
        await Bun.sleep(150);
        await children.stopAll("SIGTERM");
        expect(await outside).toBe(SIGTERM_EXIT);
        expect(reasons).toEqual(["limit", "stopWhen"]);
    });
});

test("the stopWhen check runs often enough to catch a cut a second before the run ends", async () => {
    const children = new Children(process.env, 300);
    const started = Date.now();
    expect(await children.run(IDLE, log(), undefined, () => true)).toBe(SIGTERM_EXIT);
    expect(Date.now() - started).toBeLessThan(2_500);
});

test("a stop this run issued settles only once the child's process group is gone", async () => {
    const children = new Children(process.env, 300);
    const path = log();
    const code = await children.run(
        [
            "-e",
            "const p = Bun.spawn(['sleep', '60']); console.log(p.pid); process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000)",
        ],
        path,
        300,
    );
    expect(code).toBe(SIGTERM_EXIT);
    const grandchild = Number(readFileSync(path, "utf8").trim());
    expect(running(grandchild)).toBe(false);
});

test("stopAll settles a run whose leader exited while a descendant kept the group alive", async () => {
    const children = new Children(process.env, 300);
    const path = log();
    const run = children.run(
        ["-e", "const p = Bun.spawn(['sleep', '60']); console.log(p.pid)"],
        path,
    );
    await Bun.sleep(150);
    const stopped = children.stopAll("SIGTERM");
    expect(
        await Promise.race([stopped.then(() => "settled"), Bun.sleep(2_000).then(() => "hung")]),
    ).toBe("settled");
    expect([0, SIGTERM_EXIT]).toContain(await run);
    const grandchild = Number(readFileSync(path, "utf8").trim());
    expect(running(grandchild)).toBe(false);
});

test("a child that exits on SIGTERM leaving a descendant still has that descendant killed", async () => {
    const children = new Children(process.env, 300);
    const path = log();
    const code = await children.run(
        [
            "-e",
            "const p = Bun.spawn(['sleep', '60']); console.log(p.pid); process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000)",
        ],
        path,
        300,
    );
    expect(code).toBe(SIGTERM_EXIT);
    const grandchild = Number(readFileSync(path, "utf8").trim());
    await Bun.sleep(100);
    expect(running(grandchild)).toBe(false);
});

test("a log that cannot be written ends the child and settles the run with a failure code", async () => {
    const children = new Children(process.env, 300);
    const code = await children.run(
        ["-e", "console.log('x'); setInterval(() => {}, 1000)"],
        "/nonexistent/dir/log",
    );
    expect(code).toBe(127);
});

test("a spawn that fails while its log cannot be written still settles the run", async () => {
    const children = new Children({ PATH: "/nonexistent" }, 300);
    expect(await children.run(["-e", "1"], "/nonexistent/dir/log")).toBe(127);
});

test("a stop callback that throws still stops the child and settles the run", async () => {
    const children = new Children(process.env, 300);
    const code = await children.run(IDLE, log(), 100, undefined, () => {
        throw new Error("marker: ENOSPC");
    });
    expect(code).toBe(SIGTERM_EXIT);
});

test("a log path that is a symlink is refused before the child starts, and its target stays untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-children-"));
    const target = join(dir, "target");
    writeFileSync(target, "kept\n");
    const link = join(dir, "log");
    symlinkSync(target, link);
    const children = new Children(process.env, 300);
    expect(await children.run(["-e", "console.log('x')"], link)).toBe(127);
    expect(readFileSync(target, "utf8")).toBe("kept\n");
});

test("an outside stop disables the scheduled check, so a slow teardown writes no restart reason", async () => {
    const reasons: string[] = [];
    const children = new Children(process.env, 1_000, 50);
    let due = false;
    const slow = [
        "-e",
        "process.on('SIGTERM', () => setTimeout(() => process.exit(143), 400)); setInterval(() => {}, 1000)",
    ];
    const run = children.run(
        slow,
        log(),
        undefined,
        () => due,
        (r) => void reasons.push(r),
    );
    await Bun.sleep(150);
    const stopped = children.stopAll("SIGTERM");
    due = true;
    await stopped;
    expect(await run).toBe(SIGTERM_EXIT);
    expect(reasons).toEqual([]);
});

test("a log replaced by a symlink while the child runs keeps writing to the file the run opened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sim-children-"));
    const target = join(dir, "target");
    writeFileSync(target, "kept\n");
    const log = join(dir, "log");
    const children = new Children(process.env, 300);
    const run = children.run(
        [
            "-e",
            "let i = 0; const t = setInterval(() => { console.log('tick', i++); if (i > 6) { clearInterval(t); } }, 50)",
        ],
        log,
    );
    await Bun.sleep(120);
    rmSync(log);
    symlinkSync(target, log);
    expect(await run).toBe(0);
    expect(readFileSync(target, "utf8")).toBe("kept\n");
});
