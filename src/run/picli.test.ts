import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config/config";
import { piCli } from "./preflight";

const CLI = "node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

test("the Pi CLI is its canonical file, which must lie inside the Pi install", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "sim-picli-")));
    const install = join(dir, "pi");
    mkdirSync(join(install, CLI, ".."), { recursive: true });
    writeFileSync(join(dir, "outside.js"), "");
    symlinkSync(join(dir, "outside.js"), join(install, CLI));
    const config = { ...loadConfig(), pi_install: install };
    expect(() => piCli(config)).toThrow(`Pi CLI ${join(install, CLI)} resolves outside ${install}`);
    const inside = join(dir, "pi2");
    mkdirSync(join(inside, CLI, ".."), { recursive: true });
    writeFileSync(join(inside, CLI), "");
    expect(piCli({ ...config, pi_install: inside })).toBe(join(inside, CLI));
});
