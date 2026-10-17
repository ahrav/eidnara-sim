import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryNotes } from "./storecheck";

test("memory notes come with their delivery count and first delivery time", () => {
    const path = join(mkdtempSync(join(tmpdir(), "sim-store-")), "memory.db");
    const db = new Database(path);
    db.run("create table notes (id integer primary key, content text, status text)");
    db.run("create table note_deliveries (note_id integer, created_at_ms integer)");
    db.run(
        "insert into notes values (1, 'User rule: tabs.', 'active'), (2, 'Observed: port 7780.', 'active')",
    );
    db.run("insert into note_deliveries values (1, 5000), (1, 3000)");
    db.close();
    expect(memoryNotes(path)).toEqual([
        {
            id: 1,
            content: "User rule: tabs.",
            status: "active",
            deliveries: 2,
            first_delivery_ms: 3000,
        },
        {
            id: 2,
            content: "Observed: port 7780.",
            status: "active",
            deliveries: 0,
            first_delivery_ms: null,
        },
    ]);
});

test("memory notes are unavailable, with no throw, when the store path cannot be opened", () => {
    expect(memoryNotes(mkdtempSync(join(tmpdir(), "sim-store-")))).toBeNull();
    expect(memoryNotes(join(tmpdir(), "sim-store-absent", "memory.db"))).toBeNull();
});
