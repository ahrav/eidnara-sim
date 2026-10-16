import { describe, expect, test } from "bun:test";
import { ERROR_CODE_FIELDS, entryProblems, parseJsonl, SAMPLE_FIELDS } from "./entries";

describe("entryProblems", () => {
    const rev = "0123456789abcdef0123456789abcdef01234567";
    const common = { license: "CC-BY-4.0", source_id: `org/ds@${rev}:traj#3`, repo: "o/r" };
    const good = {
        ...common,
        id: "out-0001",
        kind: "grep",
        tool: "execute_bash",
        command: "grep x",
        exit_code: null,
        chars: 12,
        truncated: false,
        content: "x: 1\nx: 2",
    };
    const code = { ...common, id: "err-0000", code: "ValueError", message: "m", context: "c" };

    test("accepts a complete sample and a complete error code", () => {
        expect(entryProblems([good], "samples", SAMPLE_FIELDS)).toEqual([]);
        expect(entryProblems([code], "error_codes", ERROR_CODE_FIELDS)).toEqual([]);
    });

    test("rejects an entry without a license", () => {
        const { license: _license, ...rest } = good;
        expect(entryProblems([rest], "samples", SAMPLE_FIELDS)).toEqual([
            "samples[0] (out-0001): license missing or not permitted",
        ]);
    });

    test("rejects an entry with a license outside the permitted set", () => {
        const bad = { ...good, license: "GPL-3.0" };
        expect(entryProblems([bad], "samples", SAMPLE_FIELDS)).toHaveLength(1);
    });

    test("rejects an entry without a source id or with a blank one", () => {
        const { source_id: _s, ...rest } = good;
        const blank = { ...good, id: "out-0002", source_id: "  " };
        const bare = { ...good, id: "out-0003", source_id: `org/ds@${rev}:` };
        expect(entryProblems([rest, blank, bare], "codes", SAMPLE_FIELDS)).toEqual([
            "codes[0] (out-0001): source_id must be string",
            "codes[1] (out-0002): source_id must be repo@revision:trajectory#index",
            "codes[2] (out-0003): source_id must be repo@revision:trajectory#index",
        ]);
    });

    test("names each missing or mistyped field and a duplicate id", () => {
        const { content: _c, ...noContent } = good;
        const problems = entryProblems(
            [noContent, { ...good, chars: "12" }, { ...good, exit_code: "1" }, good],
            "samples",
            SAMPLE_FIELDS,
        );
        expect(problems).toEqual([
            "samples[0] (out-0001): content must be string",
            "samples[1] (out-0001): chars must be number",
            "samples[1] (out-0001): duplicate id",
            "samples[2] (out-0001): exit_code must be number|null",
            "samples[2] (out-0001): duplicate id",
            "samples[3] (out-0001): duplicate id",
        ]);
    });

    test("reports every field for an empty or null entry", () => {
        const n = Object.keys(ERROR_CODE_FIELDS).length + 1;
        expect(entryProblems([{}, null], "x", ERROR_CODE_FIELDS)).toHaveLength(2 * n);
    });
});

test("parseJsonl skips blank lines", () => {
    expect(parseJsonl('{"a":1}\n\n{"a":2}\n')).toEqual([{ a: 1 }, { a: 2 }]);
});
