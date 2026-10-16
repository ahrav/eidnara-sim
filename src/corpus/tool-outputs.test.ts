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
const TRACE_BODY =
    'Traceback (most recent call last):\n  File "a.py", line 1\nValueError: bad input value';
const TRACE = `${TRACE_BODY}\n${FOOTER}`;

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
    test("a viewed file that quotes a traceback is still a file read", () => {
        const view =
            "Here's the result of running `cat -n` on /README.md:\n1 Traceback (most recent call last):";
        expect(classify("str_replace_editor", "view /README.md", view)).toBe("file_read");
        expect(
            classify("str_replace_editor", "view /", "Traceback (most recent call last)"),
        ).toBeNull();
    });
    test("a runner counts only in executable position", () => {
        expect(
            classify("execute_bash", 'cd /w && find . -name "tox.ini" | head', "./tox.ini"),
        ).toBeNull();
        expect(
            classify("execute_bash", 'grep -r "[unittest]" nose2/tests/', "a.cfg:[unittest]"),
        ).toBe("grep");
        expect(classify("execute_bash", 'python -c "import pytest; print(1)"', "1")).toBeNull();
        expect(
            classify("execute_bash", "cd /w && SKIP=1 python -m unittest tests.t -v", "ok"),
        ).toBe("test_run");
        expect(classify("execute_bash", "cd /w && pytest -x", "ok")).toBe("test_run");
    });
    test("a shell parse failure or missing command is no sample of any kind", () => {
        const err = "bash: syntax error near unexpected token `|'";
        expect(classify("execute_bash", 'grep -l "a\\|b" .', err)).toBeNull();
        expect(
            classify("execute_bash", "pytest tests", "bash: pytest: command not found"),
        ).toBeNull();
        expect(
            classify("execute_bash", "cat a.py", "bash: line 1: cat: command not found"),
        ).toBeNull();
        expect(classify("execute_bash", "grep -rn foo .", "a.py:1: foo")).toBe("grep");
    });
    test("a search tool named only inside quotes is not a grep", () => {
        expect(classify("execute_bash", 'echo "run rg next"', "run rg next")).toBeNull();
        expect(
            classify("execute_bash", 'find . -name "*.py" -exec grep -l "x" {} \\;', "a.py"),
        ).toBe("grep");
        expect(classify("execute_bash", "ls | grep test", "test_a.py")).toBe("grep");
        expect(
            classify("execute_bash", "echo rg followed by an unquoted message", "rg ..."),
        ).toBeNull();
        expect(classify("execute_bash", "find . -name '*.py' | xargs grep -l foo", "a.py")).toBe(
            "grep",
        );
        expect(
            classify("execute_bash", "echo -exec rg followed by a long message here", "x"),
        ).toBeNull();
    });
    test("a runner name inside a quoted pattern is not a pipeline segment", () => {
        const cmd =
            'cd /w && find . -name "*.py" -exec grep -l "pytest\\|unittest" {} \\; | head -5';
        expect(classify("execute_bash", cmd, "a.py:1: import pytest")).toBe("grep");
        expect(classify("execute_bash", 'echo "x | pytest"', "x | pytest")).toBeNull();
    });
    test("a test runner's help text is no test run", () => {
        expect(
            classify("execute_bash", "python -m pytest --help | head -20", "usage: pytest"),
        ).toBeNull();
        expect(classify("execute_bash", "pytest -h", "usage: pytest")).toBeNull();
        expect(classify("execute_bash", "python -m pytest --version", "pytest 8.0")).toBeNull();
        expect(classify("execute_bash", "pytest --collect-only -q tests", "t.py::a")).toBeNull();
        expect(classify("execute_bash", "pytest --co tests", "t.py::a")).toBeNull();
        expect(classify("execute_bash", "python --version && pytest tests", "1 passed")).toBe(
            "test_run",
        );
        expect(classify("execute_bash", "pytest tests && python tool.py --help", "ok")).toBe(
            "test_run",
        );
        expect(classify("execute_bash", "pytest tests/test_h.py", "ok")).toBe("test_run");
    });
    test("commandOf reads command and path, and falls back to the raw text", () => {
        expect(commandOf('{"command":"view","path":"/a.py"}')).toBe("view /a.py");
        expect(commandOf('{"command":"ls -la"}')).toBe("ls -la");
        expect(commandOf("not json")).toBe("not json");
    });
});

describe("extractFrom", () => {
    const longTrace = `Traceback (most recent call last):\n${"  frame\n".repeat(800)}OSError: disk full\n${FOOTER}`;
    const longRead = `Here's the result of running \`cat -n\` on /a.py:\n${"x".repeat(5000)}`;
    const rows: TrajectoryRow[] = [
        {
            trajectory_id: "t1",
            repo: "o/r",
            trajectory: [
                call("c1", "execute_bash", { command: "python -m pytest tests" }),
                result("c1", "execute_bash", TRACE),
                call("c2", "execute_bash", { command: "python t.py" }),
                result("c2", "execute_bash", `${TRACE_BODY}\nKeyError: 'k'\n${FOOTER}`),
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

    test("harvests codes from command output only, and bare names only below a File frame", () => {
        const listing = extractFrom(
            [
                {
                    trajectory_id: "t3",
                    repo: "o/r",
                    trajectory: [
                        call("c5", "str_replace_editor", { command: "view", path: "/a.py" }),
                        result(
                            "c5",
                            "str_replace_editor",
                            "Here's the result of running `cat -n` on /a.py:\nRaises\n------\nGMTCLibError: when the C API fails",
                        ),
                        call("c6", "execute_bash", { command: "python -c 'print(dir(m))'" }),
                        result(
                            "c6",
                            "execute_bash",
                            "Exception-related attributes:\n  HTTPException\n  NotFoundException",
                        ),
                        call("c7", "execute_bash", { command: "python t.py" }),
                        result(
                            "c7",
                            "execute_bash",
                            'Traceback (most recent call last):\n  File "t.py", line 1, in <module>\n    input()\nKeyboardInterrupt\n[Command finished with exit code 130]',
                        ),
                        call("c8", "execute_bash", { command: "python u.py" }),
                        result(
                            "c8",
                            "execute_bash",
                            "some log line\nValueError: bad value\n[Command finished with exit code 1]",
                        ),
                    ],
                },
            ],
            dataset,
        );
        expect(listing.error_codes.map((e) => e.code)).toEqual(["KeyboardInterrupt", "ValueError"]);
    });

    test("a long stack trace keeps its traceback when unrelated output follows it", () => {
        const noisy = `${TRACE_BODY}\n${"pip install output\n".repeat(400)}${FOOTER}`;
        const out2 = extractFrom(
            [
                {
                    trajectory_id: "t4",
                    repo: "o/r",
                    trajectory: [
                        call("c9", "execute_bash", { command: "pip install x && python t.py" }),
                        result("c9", "execute_bash", noisy),
                    ],
                },
            ],
            dataset,
        );
        const trace = out2.samples[0];
        expect(trace?.kind).toBe("stack_trace");
        expect(trace?.truncated).toBe(true);
        expect(trace?.content.startsWith("Traceback (most recent call last)")).toBe(true);
        expect(trace?.content).toContain("ValueError: bad input value");
    });

    test("a command result without a completion footer yields no sample", () => {
        const pending = extractFrom(
            [
                {
                    trajectory_id: "t6",
                    repo: "o/r",
                    trajectory: [
                        call("c12", "execute_bash", { command: "python -m pytest tests" }),
                        result(
                            "c12",
                            "execute_bash",
                            `${"=".repeat(60)}\n[The command is still running. Send keys to interrupt it.]`,
                        ),
                    ],
                },
            ],
            dataset,
        );
        expect(pending.samples).toEqual([]);
    });

    test("a traceback in a result without a completion footer is not harvested", () => {
        const pending = extractFrom(
            [
                {
                    trajectory_id: "t7",
                    repo: "o/r",
                    trajectory: [
                        call("c13", "execute_bash", { command: "python t.py" }),
                        result(
                            "c13",
                            "execute_bash",
                            'Traceback (most recent call last):\n  File "t.py", line 1\nValueError: x\n[The command is still running.]',
                        ),
                    ],
                },
            ],
            dataset,
        );
        expect(pending.error_codes).toEqual([]);
    });

    test("harvests codes only from completed commands that exited nonzero or printed a traceback", () => {
        const ok = extractFrom(
            [
                {
                    trajectory_id: "t5",
                    repo: "o/r",
                    trajectory: [
                        call("c10", "execute_bash", { command: "cat doc.py" }),
                        result(
                            "c10",
                            "execute_bash",
                            "    Raises:\n        ArgumentError: when parsing fails\n[Command finished with exit code 0]",
                        ),
                        call("c11", "execute_bash", { command: "python t.py" }),
                        result(
                            "c11",
                            "execute_bash",
                            "ArgumentError: bad\n[Command finished with exit code 1]",
                        ),
                    ],
                },
            ],
            dataset,
        );
        expect(ok.error_codes.map((e) => [e.code, e.source_id])).toEqual([
            ["ArgumentError", "org/ds@rev:t5#3"],
        ]);
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
