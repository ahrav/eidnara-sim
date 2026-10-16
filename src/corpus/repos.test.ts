import { expect, test } from "bun:test";
import { join } from "node:path";
import { REPOS_DIR, repoDir, summarize } from "./repos";

test("repoDir accepts a plain name and rejects ids that leave corpus/repos", () => {
    expect(repoDir("mini-redis")).toBe(join(REPOS_DIR, "mini-redis"));
    for (const id of ["../eidnara", "a/b", "", ".", "..", ".hidden"]) {
        expect(() => repoDir(id)).toThrow("not a plain directory name");
    }
});

test("summarize keeps cargo result lines without timings", () => {
    const out = [
        "running 11 tests",
        "test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s",
        "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.20s",
    ].join("\n");
    expect(summarize(out)).toEqual([
        "test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
        "test result: ok. 11 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out",
    ]);
});

test("summarize keeps bun counts and failing names once, without timings", () => {
    const out = [
        "(pass) a > b [0.20ms]",
        "(fail) Stop > shuts down [9.04ms]",
        "(fail) Stop > shuts down [5.81ms]",
        " 1610 pass",
        " 2 skip",
        " 4 fail",
        "Ran 1616 tests across 134 files. [5.01s]",
    ].join("\n");
    expect(summarize(out)).toEqual(["(fail) Stop > shuts down", "1610 pass", "2 skip", "4 fail"]);
});

test("summarize keeps one result line per cargo target, including identical ones", () => {
    const line = "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out";
    expect(summarize(`${line}; finished in 0.00s\n${line}; finished in 0.01s`)).toEqual([
        line,
        line,
    ]);
});

test("summarize changes when the fail count changes with the same failing names", () => {
    const run = (fails: number) =>
        summarize(["(fail) a > b [1.00ms]", ` ${10 - fails} pass`, ` ${fails} fail`].join("\n"));
    expect(run(1)).not.toEqual(run(2));
});
