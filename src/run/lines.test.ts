import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallLog } from "./calllog";
import { eachJsonl, eachLine, readJsonl } from "./journal";

const dir = mkdtempSync(join(tmpdir(), "sim-lines-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (content: string | Buffer): string => {
    const path = join(dir, `f${n++}.jsonl`);
    writeFileSync(path, content);
    return path;
};

const lines = (path: string, chunk: number) => {
    const out: Array<{ text: string; index: number; offset: number }> = [];
    const scan = eachLine(
        path,
        (line, index, offset) => out.push({ text: line.toString("utf8"), index, offset }),
        chunk,
    );
    return { out, scan };
};

const rows = <T>(path: string, chunk: number) => {
    const out: Array<{ row: T; index: number; offset: number; length: number }> = [];
    eachJsonl<T>(
        path,
        (row, index, offset, length) => out.push({ row, index, offset, length }),
        chunk,
    );
    return out;
};

/** `wholeFile` defines the reference semantics for the streaming reader. */
function wholeFile(text: string): unknown[] | string {
    const parts = text.split("\n");
    const out: unknown[] = [];
    for (const [i, line] of parts.entries()) {
        if (i === parts.length - 1) break;
        try {
            out.push(JSON.parse(line));
        } catch {
            if (i < parts.length - 2) return `line ${i + 1} is corrupt`;
        }
    }
    return out;
}

describe("eachLine", () => {
    test("assembles lines that cross chunk boundaries, with their offsets", () => {
        const text = "alpha\nbe\n\ngamma-delta-epsilon\nz\n";
        const path = file(text);
        for (const chunk of [1, 2, 3, 5, 7, 64]) {
            const { out, scan } = lines(path, chunk);
            expect(out.map((l) => l.text)).toEqual(["alpha", "be", "", "gamma-delta-epsilon", "z"]);
            expect(out.map((l) => l.index)).toEqual([0, 1, 2, 3, 4]);
            expect(out.map((l) => l.offset)).toEqual([0, 6, 9, 10, 30]);
            expect(scan).toEqual({ complete: text.length, tail: 0 });
        }
    });

    test("reports an unterminated tail without visiting it", () => {
        const { out, scan } = lines(file('{"a":1}\n{"b":'), 4);
        expect(out.map((l) => l.text)).toEqual(['{"a":1}']);
        expect(scan).toEqual({ complete: 8, tail: 5 });
    });

    test("keeps a multi-byte character split across chunks whole", () => {
        const text = "\u00e9t\u00e9 \u{1F600}\n\u4e2d\u6587\n";
        for (const chunk of [1, 2, 3]) {
            expect(lines(file(text), chunk).out.map((l) => l.text)).toEqual([
                "\u00e9t\u00e9 \u{1F600}",
                "\u4e2d\u6587",
            ]);
        }
    });

    test("reads a file larger than one chunk, lines larger than one chunk included", () => {
        const big = "x".repeat(3000);
        const text = Array.from({ length: 200 }, (_, i) => (i % 50 === 7 ? big : `line-${i}`))
            .map((l) => `${l}\n`)
            .join("");
        const { out, scan } = lines(file(text), 256);
        expect(out.length).toBe(200);
        expect(out[7]?.text).toBe(big);
        expect(out[57]?.text).toBe(big);
        expect(out[199]?.text).toBe("line-199");
        expect(scan.complete).toBe(text.length);
    });
});

describe("eachJsonl", () => {
    test("parses CRLF-terminated lines", () => {
        expect(readJsonl(file('{"a":1}\r\n{"b":2}\r\n'))).toEqual([{ a: 1 }, { b: 2 }]);
    });

    test("drops an unterminated last line, even one that parses", () => {
        expect(readJsonl(file('{"a":1}\n{"b":2}'))).toEqual([{ a: 1 }]);
        expect(readJsonl(file('{"a":1}\n'))).toEqual([{ a: 1 }]);
        expect(readJsonl(file(""))).toEqual([]);
        expect(readJsonl(join(dir, "absent.jsonl"))).toEqual([]);
    });

    test("drops a corrupt last terminated line and refuses an earlier one by its line number", () => {
        expect(readJsonl(file('{"a":1}\n{"b":\n'))).toEqual([{ a: 1 }]);
        const path = file('{"a":1}\n{"b":\n{"c":3}\n');
        expect(() => readJsonl(path)).toThrow(`${path}: line 2 is corrupt`);
        const blank = file('{"a":1}\n\n{"c":3}\n');
        expect(() => readJsonl(blank)).toThrow(`${blank}: line 2 is corrupt`);
    });

    test("hands each row its index, offset, and length across chunks", () => {
        const path = file('{"a":1}\n{"bb":22}\n');
        for (const chunk of [1, 3, 1024]) {
            expect(rows(path, chunk)).toEqual([
                { row: { a: 1 }, index: 0, offset: 0, length: 7 },
                { row: { bb: 22 }, index: 1, offset: 8, length: 9 },
            ]);
        }
    });

    test("matches the whole-file reading on cut, corrupt, and CRLF logs at every chunk size", () => {
        const cases = [
            '{"a":1}\n{"b":[1,2]}\n',
            '{"a":1}\n{"b":[1,2]}',
            '{"a":1}\r\n{"b":"\u00e9"}\r\n{"c"',
            '{"a":1}\nnot json\n',
            '{"a":1}\nnot json\n{"c":3}\n',
            '{"a":1}\nnot json\n{"c"',
            "\n",
            "\n\n",
            '"s"\n1\nnull\n',
        ];
        for (const text of cases) {
            const path = file(text);
            const expected = wholeFile(text);
            for (const chunk of [1, 2, 5, 1 << 20]) {
                let got: unknown[] | string;
                try {
                    got = rows(path, chunk).map((r) => r.row);
                } catch (caught) {
                    got = (caught as Error).message.replace(`${path}: `, "");
                }
                expect([text, chunk, got]).toEqual([text, chunk, expected]);
            }
        }
    });
});

describe("CallLog", () => {
    const sha = "a".repeat(64);
    const ids = ["0".repeat(32), "1".repeat(32)];
    const record = (seq: number, request?: object) => ({
        seq,
        arm: "host",
        ...(request ? { request } : {}),
    });

    test("keeps each request's digest and length and reads its part ids back on demand", () => {
        const path = file(
            [record(0, { sha256: sha, bytes: 5, parts: ids }), record(1)]
                .map((r) => `${JSON.stringify(r)}\n`)
                .join(""),
        );
        const checked: Array<[number, number]> = [];
        const log = new CallLog(path, (r, i) => checked.push([i, r.request?.parts.length ?? 0]));
        expect(checked).toEqual([
            [0, 2],
            [1, 0],
        ]);
        expect(log.calls[0]?.request).toEqual({ sha256: sha, bytes: 5 });
        expect(log.request(0)).toEqual({ sha256: sha, bytes: 5, parts: ids });
        expect(log.request(0)).toEqual({ sha256: sha, bytes: 5, parts: ids });
        expect(log.request(1)).toBeNull();
        expect(() => log.request(5)).toThrow("no call at position 5");
        log.close();
    });

    test("refuses a line that no longer matches the record it kept", () => {
        const line = (bytes: number) =>
            `${JSON.stringify(record(0, { sha256: sha, bytes, parts: ids }))}\n`;
        const path = file(line(5));
        const log = new CallLog(path);
        writeFileSync(path, line(6));
        expect(() => log.request(0)).toThrow("call 0 changed since it was read");
        writeFileSync(path, `${"x".repeat(line(5).length - 1)}\n`);
        expect(() => log.request(0)).toThrow("call 0 changed since it was read");
        writeFileSync(path, line(5).replace(ids[0] as string, "bad".padEnd(32, "-")));
        expect(() => log.request(0)).toThrow("call 0 changed since it was read");
        log.close();
        expect(() => log.request(0)).toThrow("call log read after close");
    });

    test("evicts the part lists read least recently once the cache passes its budget", () => {
        const path = file(
            [0, 1, 2]
                .map(
                    (seq) =>
                        `${JSON.stringify(record(seq, { sha256: sha, bytes: seq, parts: ids }))}\n`,
                )
                .join(""),
        );
        const log = new CallLog(path, undefined, 4);
        log.request(0);
        log.request(1);
        log.request(0);
        log.request(2);
        // Positions 0 and 2 fill the four-id budget, so position 1 is read again from the file.
        writeFileSync(path, "");
        expect(log.request(0)?.parts).toEqual(ids);
        expect(log.request(2)?.parts).toEqual(ids);
        expect(() => log.request(1)).toThrow("call 1 ends past the log's end");
        log.close();
    });
});
