import { describe, expect, test } from "bun:test";
import { entryProblems, parseJsonl } from "./entries";

describe("entryProblems", () => {
    const good = { id: "out-0001", license: "CC-BY-4.0", source_id: "ds@rev:traj#3" };

    test("accepts an entry with a permitted license and a source id", () => {
        expect(entryProblems([good], "samples")).toEqual([]);
    });

    test("rejects an entry without a license", () => {
        const { license: _license, ...rest } = good;
        expect(entryProblems([rest], "samples")).toEqual([
            "samples[0] (out-0001): license missing or not permitted",
        ]);
    });

    test("rejects an entry with a license outside the permitted set", () => {
        expect(entryProblems([{ ...good, license: "GPL-3.0" }], "samples")).toHaveLength(1);
    });

    test("rejects an entry without a source id or with a blank one", () => {
        const { source_id: _s, ...rest } = good;
        expect(entryProblems([rest, { ...good, source_id: "  " }], "codes")).toEqual([
            "codes[0] (out-0001): source_id missing",
            "codes[1] (out-0001): source_id missing",
        ]);
    });

    test("reports both problems for an entry missing both fields", () => {
        expect(entryProblems([{}, null], "x")).toHaveLength(4);
    });
});

test("parseJsonl skips blank lines", () => {
    expect(parseJsonl('{"a":1}\n\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
});
