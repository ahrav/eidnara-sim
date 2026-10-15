import { describe, expect, test } from "bun:test";
import type { Dataset } from "./sources";
import { classify, commandOf, extractFrom, type TrajectoryRow } from "./tool-outputs";

const dataset: Dataset = {
    id: "openhands",
    repo: "org/ds",
    revision: "rev",
    license: "CC-BY-4.0",
    access: "public",
    files: [],
};

const call = (id: string, name: string, args: object) => ({
    role: "assistant",
    content: null,
    tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
});
const result = (id: string, name: string, content: string) => ({
    role: "tool",
    content,
    name,
    tool_call_id: id,
});
const FOOTER = "[The command completed with exit code 1.]\n[Command finished with exit code 1]";
const TRACE = `Traceback (most recent call last):\n  File "a.py", line 1\nValueError: bad input value\n${FOOTER}`;

describe("classify and commandOf", () => {
    test("a traceback wins over the command's kind", () => {
        expect(classify("execute_bash", "pytest -x", "Traceback (most recent call last)")).toBe(
            "stack_trace",
        );
    });
    test("bash commands map to test runs, greps, and file reads", () => {
        expect(classify("execute_bash", "python -m pytest tests", "ok")).toBe("test_run");
        expect(classify("execute_bash", "grep -rn foo .", "x")).toBe("grep");
        expect(classify("execute_bash", "cat setup.py", "x")).toBe("file_read");
        expect(classify("execute_bash", "ls", "x")).toBeNull();
    });
    test("an editor view is a file read only when it shows file contents", () => {
        const view = "Here's the result of running `cat -n` on /a.py:\n1 x";
        expect(classify("str_replace_editor", "view /a.py", view)).toBe("file_read");
        expect(classify("str_replace_editor", "view /", "Here's the files")).toBeNull();
    });
    test("commandOf reads command and path, and falls back to the raw text", () => {
        expect(commandOf('{"command":"view","path":"/a.py"}')).toBe("view /a.py");
        expect(commandOf('{"command":"ls -la"}')).toBe("ls -la");
        expect(commandOf("not json")).toBe("not json");
    });
});

describe("extractFrom", () => {
    const longTrace = `Traceback (most recent call last):\n${"  frame\n".repeat(800)}OSError: disk full`;
    const longRead = `Here's the result of running \`cat -n\` on /a.py:\n${"x".repeat(5000)}`;
    const rows: TrajectoryRow[] = [
        {
            trajectory_id: "t1",
            repo: "o/r",
            trajectory: [
                call("c1", "execute_bash", { command: "python -m pytest tests" }),
                result("c1", "execute_bash", TRACE),
                call("c2", "execute_bash", { command: "python t.py" }),
                result("c2", "execute_bash", `${TRACE}\nKeyError: 'k'`),
                call("c3", "str_replace_editor", { command: "view", path: "/a.py" }),
                result("c3", "str_replace_editor", longRead),
            ],
        },
        {
            trajectory_id: "t2",
            repo: "o/r",
            trajectory: [
                call("c4", "execute_bash", { command: "python run.py" }),
                result("c4", "execute_bash", longTrace),
            ],
        },
    ];
    const out = extractFrom(rows, dataset);

    test("keeps one sample per trajectory and kind, with provenance", () => {
        expect(out.samples.map((s) => s.kind)).toEqual(["stack_trace", "file_read", "stack_trace"]);
        expect(out.samples[0]).toMatchObject({
            id: "out-0000",
            command: "python -m pytest tests",
            exit_code: 1,
            license: "CC-BY-4.0",
            source_id: "org/ds@rev:t1#1",
            repo: "o/r",
        });
    });

    test("strips the OpenHands footer and clips long reads to their head", () => {
        expect(out.samples[0]?.content).not.toContain("[Command finished");
        const read = out.samples[1];
        expect(read?.truncated).toBe(true);
        expect(read?.content.length).toBe(4000);
        expect(read?.content.startsWith("Here's the result")).toBe(true);
    });

    test("clips long stack traces to their tail so the exception line survives", () => {
        const trace = out.samples[2];
        expect(trace?.truncated).toBe(true);
        expect(trace?.content.length).toBe(4000);
        expect(trace?.content.endsWith("OSError: disk full")).toBe(true);
        expect(trace?.content).not.toContain("Traceback");
    });

    test("keeps each error code at its first occurrence", () => {
        expect(out.error_codes.map((e) => [e.code, e.source_id])).toEqual([
            ["ValueError", "org/ds@rev:t1#1"],
            ["KeyError", "org/ds@rev:t1#3"],
            ["OSError", "org/ds@rev:t2#1"],
        ]);
        expect(out.error_codes[0]?.message).toBe("bad input value");
        expect(out.error_codes[0]?.context).toContain("Traceback");
    });
});
