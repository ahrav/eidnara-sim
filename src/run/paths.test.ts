import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contains, realExisting } from "./paths";

test("containment is by path component, and the root directory contains every path", () => {
    expect(contains("/", "/a/b")).toBe(true);
    expect(contains("/", "/")).toBe(true);
    expect(contains("/", "/", true)).toBe(false);
    expect(contains("/a", "/a/b")).toBe(true);
    expect(contains("/a", "/ab")).toBe(false);
    expect(contains("/a", "/a/../b")).toBe(false);
    expect(contains("/a", "/a", true)).toBe(false);
    expect(contains("/a/b", "/a")).toBe(false);
});

test("a path resolves through symlinks to where it is, or would be, created", () => {
    const root = mkdtempSync(join(tmpdir(), "sim-paths-"));
    const other = mkdtempSync(join(tmpdir(), "sim-paths-"));
    mkdirSync(join(root, "campaign"));
    symlinkSync(other, join(root, "campaign", "alias"));
    const campaign = realExisting(join(root, "campaign"));
    expect(contains(campaign, realExisting(join(root, "campaign", "run")), true)).toBe(true);
    expect(contains(campaign, realExisting(join(root, "campaign", "alias", "run")), true)).toBe(
        false,
    );
    expect(realExisting(join(root, "campaign", "alias", "run"))).toBe(
        join(realExisting(other), "run"),
    );
});
