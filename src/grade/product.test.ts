import { describe, expect, test } from "bun:test";
import { isProductPath, matchesCode, productCode } from "./product";
import { diffFiles } from "./text";

/** One file's patch with the given hunks; a hunk is its header section and its marked lines. */
const patchOf = (path: string, hunks: [section: string, lines: string[]][]) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks
        .map(([section, lines], i) => {
            const side = (mark: string) =>
                lines.filter((l) => l[0] === " " || l[0] === mark).length;
            const at = 100 * (i + 1);
            return `@@ -${at},${side("-")} +${at},${side("+")} @@${section ? ` ${section}` : ""}\n${lines.join("\n")}\n`;
        })
        .join("")}`;
const fileOf = (path: string, hunks: [string, string[]][]) => {
    const [file] = diffFiles(patchOf(path, hunks));
    if (!file) throw new Error("the patch names no file");
    return file;
};
const added = (path: string, lines: string[]) => fileOf(path, [["", lines.map((l) => `+${l}`)]]);
/** The line `productCode` puts between added lines that the file holds apart. */
const GAP = "\u0000";
const matches = (path: string, lines: string[], patterns: string[]) =>
    matchesCode(productCode(added(path, lines)), patterns);

describe("product paths", () => {
    test("library and server sources are product code; tests, benchmarks, examples, scripts, and other files are support", () => {
        for (const path of [
            "src/db.rs",
            "src/bin/server.rs",
            "mux.go",
            "middleware/throttle.go",
            "src/adapter/bun/index.ts",
            "src/latest.rs",
            "src/contest/mod.rs",
        ]) {
            expect([path, isProductPath(path)]).toEqual([path, true]);
        }
        for (const path of [
            "tests/server.rs",
            "test/core/config.test.ts",
            "src/__tests__/a.ts",
            "middleware/throttle_test.go",
            "src/index.spec.ts",
            "src/db_test.rs",
            "src/db_tests.rs",
            "src/tests.rs",
            "src/cmd/tests.rs",
            "src/test.rs",
            "benches/parse.rs",
            "bench/parse.rs",
            "benchmarks/route.ts",
            "benchmark/route.ts",
            "fixtures/big.go",
            "src/generated/api.ts",
            "zz_generated.deepcopy.go",
            "api/types_generated.go",
            "proto/store.pb.go",
            "src/test_support.rs",
            "src/testing/helpers.rs",
            "src/support/test_utils.ts",
            "internal/testutil/server.go",
            "examples/pub.rs",
            "_examples/rest/main.go",
            "example/a.ts",
            "scripts/check.ts",
            "testdata/a.go",
            "README.md",
            "notes/plan.md",
            "Cargo.toml",
            "chi.test",
            "package.json",
        ]) {
            expect([path, isProductPath(path)]).toEqual([path, false]);
        }
    });
});

describe("product code", () => {
    test("a hunk carries its header section and its new-side lines", () => {
        const file = fileOf("src/db.rs", [
            ["impl Db {", [" fn get() {", "-    old();", "+    new();", " }"]],
            ["", ["+fn tail() {}"]],
        ]);
        expect(file.hunks).toEqual([
            { section: "impl Db {", lines: [" fn get() {", "+    new();", " }"] },
            { section: "", lines: ["+fn tail() {}"] },
        ]);
        expect(file.added).toEqual(["    new();", "fn tail() {}"]);
    });

    test("a comment that names the approach matches nothing, and code beside it matches", () => {
        const pattern = ["spawn_blocking"];
        expect(matches("src/a.rs", ["// spawn_blocking starved the pool"], pattern)).toBe(false);
        expect(matches("src/a.rs", ["/// Avoids `spawn_blocking`."], pattern)).toBe(false);
        expect(matches("src/a.ts", ["/* spawn_blocking", " was reverted */"], pattern)).toBe(false);
        expect(matches("src/a.rs", ["spawn_blocking(f); // off the worker"], pattern)).toBe(true);
        expect(matches("src/a.rs", ["run(); // not spawn_blocking"], pattern)).toBe(false);
    });

    test("a block comment that a context line opens covers the added lines inside it", () => {
        const file = fileOf("src/a.ts", [
            ["", [" /*", "+ * setInterval(sweep, 1000) was the old sweeper", " */", "+start()"]],
        ]);
        expect(matchesCode(productCode(file), ["setInterval\\s*\\("])).toBe(false);
        expect(productCode(file).code.split("\n").at(-1)).toBe("start()");
    });

    test("a name inside a string is a mention; a pattern that reaches code or names the literal with its quotes matches", () => {
        expect(
            matches("src/a.rs", ['warn!("spawn_blocking stays out");'], ["spawn_blocking"]),
        ).toBe(false);
        expect(
            matches("src/a.ts", ["it('uses process.nextTick', run)"], ["process\\.nextTick"]),
        ).toBe(false);
        expect(matches("id.go", ['\t"math/rand"'], ['"math/rand(?:/v2)?"'])).toBe(true);
        expect(matches("src/a.ts", ["throw 'route exists'"], ["throw\\s+['\"`]"])).toBe(true);
        expect(
            matches("src/a.ts", ["import merge from 'lodash/merge'"], ["from\\s+['\"]lodash"]),
        ).toBe(true);
        expect(matches("src/a.ts", ["log(\"throw 'x'\")"], ["throw\\s+['\"`]"])).toBe(false);
    });

    test("a line-anchored pattern reads each added line of the comment-free text", () => {
        const anchored = ["^\\s*func\\s+init\\s*\\(\\s*\\)"];
        expect(matches("defaults.go", ["// was:", "func init() {", "}"], anchored)).toBe(true);
        expect(matches("defaults.go", ["// func init() {", "func setup() {", "}"], anchored)).toBe(
            false,
        );
    });

    test("a Rust test module stays out from its attribute to its closing brace, and the code after it stays in", () => {
        const inModule = added("src/db.rs", [
            "fn sweep() {}",
            "#[cfg(test)]",
            "mod tests {",
            "    use super::*;",
            "",
            "    #[tokio::test]",
            "    async fn idle() {",
            "        time::interval(Duration::from_secs(1));",
            "    }",
            "    fn second() { time::interval(D); }",
            "}",
            "fn after() { time::interval(Duration::from_secs(60)); }",
        ]);
        expect(productCode(inModule).code).toBe(
            `fn sweep() {}\n${GAP}\nfn after() { time::interval(Duration::from_secs(60)); }`,
        );
        const oneLine = added("src/db.rs", [
            "#[cfg(test)] mod tests {",
            "    fn a() { thread::sleep(D); }",
            "}",
            "fn live() {}",
        ]);
        expect(productCode(oneLine).code).toBe("fn live() {}");
        // A brace at column zero inside a raw string closes nothing.
        const raw = added("src/db.rs", [
            "mod tests {",
            '    const J: &str = r#"',
            "{",
            "}",
            '"#;',
            "    fn a() { thread::sleep(D); }",
            "}",
            "fn live() {}",
        ]);
        expect(productCode(raw).code).toBe("fn live() {}");
    });

    test("an item under cfg(test) stays out through its header and body, and the item after it stays in", () => {
        const items = added("src/db.rs", [
            "#[cfg(test)]",
            "use std::thread::sleep;",
            "fn mid() {}",
            "#[cfg(test)] use std::time::Instant;",
            "fn mid2() {}",
            "#[cfg(all(test, unix))]",
            "#[allow(dead_code)]",
            "fn pause(",
            "    d: Duration,",
            ") -> u32 {",
            "    std::thread::sleep(d);",
            "    0",
            "}",
            "#[cfg(test)]",
            "static DELAYS: &[u32] = &[",
            "    1,",
            "];",
            "#[cfg(test)]",
            "impl<T> Probe<T>",
            "where",
            "    T: Send,",
            "{",
            "    fn nap(&self) { thread::sleep(D); }",
            "}",
            "#[cfg(test)]",
            "fn open() { setup();",
            "    thread::sleep(D);",
            "}",
            "#[cfg(all(unix, test))]",
            "fn unix_only() { thread::sleep(D); }",
            "#[cfg(all(unix, not(test)))]",
            "fn shipped() { thread::sleep(D); }",
            "#[cfg(not(test))]",
            "fn live() { thread::sleep(D); }",
        ]);
        expect(productCode(items).code).toBe(
            `fn mid() {}\n${GAP}\nfn mid2() {}\n${GAP}\n#[cfg(all(unix, not(test)))]\nfn shipped() { thread::sleep(D); }\n#[cfg(not(test))]\nfn live() { thread::sleep(D); }`,
        );
    });

    test("a one-line item under cfg(test) ends on its line: a function, a field, a match arm", () => {
        const kept = (lines: string[]) =>
            productCode(added("src/db.rs", lines))
                .code.split("\n")
                .filter((l) => l !== GAP);
        expect(
            kept(["#[cfg(test)]", "fn reset() {}", "", "static DB: Mutex<Db> = new();"]),
        ).toEqual(["", "static DB: Mutex<Db> = new();"]);
        expect(
            kept([
                "pub struct Db {",
                "    #[cfg(test)]",
                "    probe: Probe,",
                "    cache: Mutex<HashMap<K, V>>,",
                "}",
            ]),
        ).toEqual(["pub struct Db {", "    cache: Mutex<HashMap<K, V>>,", "}"]);
        expect(
            kept([
                "match cmd {",
                "    #[cfg(test)]",
                "    Cmd::Probe => probe(),",
                "    Cmd::Get => {",
                "        spawn_blocking(f);",
                "    }",
                "}",
            ]),
        ).toEqual(["match cmd {", "    Cmd::Get => {", "        spawn_blocking(f);", "    }", "}"]);
        const context = fileOf("src/db.rs", [
            [
                "",
                [
                    " #[cfg(test)]",
                    " pub fn noop(&self) {}",
                    "+pub fn sweep() { thread::sleep(D); }",
                ],
            ],
        ]);
        expect(productCode(context).code).toBe("pub fn sweep() { thread::sleep(D); }");
    });

    test("a function under a test attribute stays out in a file that holds no test module", () => {
        const standalone = added("src/lib.rs", [
            "#[test]",
            "fn sleeps() {",
            "    std::thread::sleep(D);",
            "}",
            '#[tokio::test(flavor = "multi_thread")]',
            "async fn blocks() {",
            "    tokio::task::spawn_blocking(f).await.unwrap();",
            "}",
            "#[bench]",
            "fn hot(b: &mut Bencher) { b.iter(|| std::thread::sleep(D)); }",
            "#[inline]",
            "fn live() { std::thread::sleep(D); }",
        ]);
        expect(productCode(standalone).code).toBe(
            "#[inline]\nfn live() { std::thread::sleep(D); }",
        );
    });

    test("a pattern that spans lines matches lines that are adjacent in the file alone", () => {
        const pattern = ["const\\s+\\w+\\s*=\\s*new\\s+Map\\("];
        const adjacent = fileOf("src/a.ts", [["", ["+const cache =", "+\tnew Map()"]]]);
        expect(matchesCode(productCode(adjacent), pattern)).toBe(true);
        const apart = fileOf("src/a.ts", [["", ["+const cache =", " \tbuild()", "+new Map()"]]]);
        expect(matchesCode(productCode(apart), pattern)).toBe(false);
        const hunks = fileOf("src/a.ts", [
            ["", ["+const cache ="]],
            ["", ["+new Map()"]],
        ]);
        expect(matchesCode(productCode(hunks), pattern)).toBe(false);
    });

    test("a block comment the hunk opens and that closes below it covers the added lines inside it", () => {
        const open = fileOf("src/a.rs", [
            [
                "",
                [
                    " fn live() {}",
                    " /*",
                    "+ * spawn_blocking starved the pool before.",
                    " * More notes.",
                ],
            ],
        ]);
        expect(matchesCode(productCode(open), ["spawn_blocking"])).toBe(false);
    });

    test("a block comment that closes inside the hunk and opened above it covers the lines down to its closer", () => {
        const tail = fileOf("src/a.ts", [
            [
                "",
                [
                    " * It replaced the old sweeper.",
                    "+ * setInterval(sweep, 1000) kept tests alive.",
                    " */",
                    "+start()",
                ],
            ],
        ]);
        expect(
            productCode(tail)
                .code.split("\n")
                .map((l) => l.trim()),
        ).toEqual(["", GAP, "start()"]);
        expect(matchesCode(productCode(tail), ["setInterval\\s*\\("])).toBe(false);
    });

    test("each hunk is read from its own header: inside a test module, or past one that closed above it", () => {
        const later = fileOf("src/db.rs", [
            ["", [" #[cfg(test)]", " mod tests {", "+    fn a() { thread::sleep(D); }"]],
            [
                "mod tests {",
                ["+    fn b() { thread::sleep(D); }", " }", "+fn c() { thread::sleep(D); }"],
            ],
        ]);
        expect(productCode(later).code).toBe("fn c() { thread::sleep(D); }");
        const named = fileOf("src/db.rs", [
            ["pub(crate) mod parse_tests {", ["+    fn a() { thread::sleep(D); }"]],
        ]);
        expect(productCode(named).code).toBe("");
        // Git names the last column-zero line above the hunk, also when that module has closed.
        const past = fileOf("src/db.rs", [
            [
                "mod tests {",
                [" // a", " // b", " ", "+fn hash_off() {", "+    thread::sleep(D);", "+}"],
            ],
        ]);
        expect(productCode(past).code).toBe("fn hash_off() {\n    thread::sleep(D);\n}");
        // A test item left open at a hunk's end claims nothing in the next hunk.
        const carried = fileOf("src/db.rs", [
            ["", [" #[cfg(test)]", " impl Db {", "+    fn probe(&self) {}"]],
            ["impl Db {", [" pub fn sweep() {", "+    thread::sleep(D);", " }"]],
        ]);
        expect(productCode(carried).code).toBe("    thread::sleep(D);");
    });

    test("a closing delimiter of a literal that opened above the hunk leaves the code after it in the code", () => {
        const template = fileOf("src/compose.ts", [
            ["", ["   WHERE id = $1", " `;", "+const cache = new Map();", " run(q)"]],
        ]);
        expect(matchesCode(productCode(template), ["new\\s+Map\\("])).toBe(true);
        const raw = fileOf("mux.go", [["", ["   id = ?", " `", "+\ttime.Sleep(d)", " }"]]]);
        expect(matchesCode(productCode(raw), ["time\\.Sleep"])).toBe(true);
    });

    test("a test attribute in a comment opens nothing, and other languages keep every added line", () => {
        const commented = added("src/db.rs", [
            "// #[cfg(test)]",
            "fn live() { thread::sleep(D); }",
        ]);
        expect(matchesCode(productCode(commented), ["thread::sleep"])).toBe(true);
        const go = added("mux.go", ["// mod tests {", "func live() { time.Sleep(d) }"]);
        expect(matchesCode(productCode(go), ["time\\.Sleep"])).toBe(true);
    });
});
