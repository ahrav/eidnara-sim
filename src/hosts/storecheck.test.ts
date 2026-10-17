import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryNotes } from "./storecheck";

test("memory notes are unavailable, with no throw, when the store path cannot be opened", () => {
    expect(memoryNotes(mkdtempSync(join(tmpdir(), "sim-store-")))).toBeNull();
    expect(memoryNotes(join(tmpdir(), "sim-store-absent", "memory.db"))).toBeNull();
});
