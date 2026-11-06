import { describe, expect, test } from "bun:test";
import { qualificationHash } from "../prereg/qualification";
import { compileScenario, type ProbeItem } from "../scenario/compile";
import { loadCompileInput, loadPrereg, loadQualification } from "../scenario/inputs";
import { hashEmbedder } from "../scenario/similarity";
import type { Artefact, CallView, Snapshot } from "./artefacts";
import { GradeRefused } from "./artefacts";
import { type GradeRecord, gradeItem, type SourceEvent } from "./probes";

const rules = loadPrereg("S").grading;
const scenario = await compileScenario(loadCompileInput(101, "S", hashEmbedder, true));
const facts = new Map(scenario.facts.map((f) => [f.id, f]));
const events = new Map(scenario.events.map((e) => [String(e.id), e]));

function probeOf(type: string, template: string, side?: "in" | "out"): ProbeItem {
    const found = scenario.probes.find(
        (p) =>
            p.type === type &&
            facts.get(p.fact ?? "")?.template === template &&
            (side === undefined || (p.check as { side?: string }).side === side),
    );
    if (!found) throw new Error(`S-101 compiles no ${type} item for ${template} ${side ?? ""}`);
    return found as ProbeItem;
}
const sourcesOf = (p: ProbeItem): SourceEvent[] =>
    (p.ground_truth?.sources ?? []).map((id) => events.get(id) as unknown as SourceEvent);

interface FileEdit {
    path: string;
    lines: string[];
    created?: boolean;
    deleted?: boolean;
}
interface Turn {
    files?: FileEdit[];
    commands?: string[];
    answer?: string;
    source?: (string | { command: string; exit: number | null })[];
    calls?: Partial<CallView>[];
}

const patchOf = (files: FileEdit[]) =>
    files
        .map((f) => {
            const body = f.lines.map((l) => `+${l}\n`).join("");
            if (f.deleted) {
                const gone = f.lines.map((l) => `-${l}\n`).join("");
                return `diff --git a/${f.path} b/${f.path}\ndeleted file mode 100644\n--- a/${f.path}\n+++ /dev/null\n@@ -1,${f.lines.length} +0,0 @@\n${gone}`;
            }
            return f.created
                ? `diff --git a/${f.path} b/${f.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${f.path}\n@@ -0,0 +1,${f.lines.length} @@\n${body}`
                : `diff --git a/${f.path} b/${f.path}\n--- a/${f.path}\n+++ b/${f.path}\n@@ -1,0 +1,${f.lines.length} @@\n${body}`;
        })
        .join("");

function snapshotOf(p: ProbeItem, t: Turn): Snapshot {
    const id = `ctl:${p.id}`;
    const calls = [
        ...(t.calls ?? []),
        {
            component: "agent",
            turn: p.event ?? null,
            turn_index: 300,
            input_tokens: 2_000,
            output_tokens: 200,
            response_text: t.answer ?? "Done.",
        },
    ].map((c, i) => ({
        arm: "eidnara",
        session: p.session,
        scenario_ms: 1_000,
        seq: i + 1,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        status: 200,
        error: null,
        ...c,
    })) as CallView[];
    const run = (c: string | { command: string; exit: number | null }) =>
        typeof c === "string"
            ? { command: c, exit: 0, scenario_ms: 1_000 }
            : { ...c, scenario_ms: 1_000 };
    const log = (role: "turn" | "session" | "source", commands: Turn["source"] & {}): Artefact => ({
        id: `${id}:${role}`,
        class: "command-log",
        role,
        commands: commands.map(run),
    });
    const artefacts: Artefact[] = [
        { id: `${id}:diff`, class: "diff", role: "turn", patch: patchOf(t.files ?? []) },
        { id: `${id}:prior`, class: "diff", role: "prior-session", patch: "" },
        log("turn", t.commands ?? []),
        log("session", t.commands ?? []),
        { id: `${id}:calls`, class: "proxy-call", calls },
        ...(t.source ? [log("source", t.source)] : []),
    ];
    return {
        id,
        item: p.id,
        arm: "eidnara",
        session: p.session,
        turn: p.event as string,
        turn_outcome: "ok",
        artefacts,
    };
}

const grade = (p: ProbeItem, t: Turn) =>
    gradeItem(p, [snapshotOf(p, t)], rules, 1, sourcesOf(p)) as GradeRecord;
const outcome = (p: ProbeItem, t: Turn) => {
    const g = grade(p, t);
    return g.verdict === "pass" ? ["pass"] : [g.verdict, g.reason];
};
const NOOP: Turn = {};
const literal = (p: ProbeItem) => (p.ground_truth?.present[0]?.[0] ?? "") as string;

describe("P1: the rule holds on every construct it governs, in its scope", () => {
    const p1 = probeOf("P1", "rs-cmd-const-prefix");
    const token = literal(p1);
    const constant = (path: string, name: string) => ({
        path,
        lines: [`pub const ${name}: usize = 64;`, "", "fn check(n: usize) -> bool { n <= 64 }"],
    });

    test("a prefixed constant in src/cmd passes, and so does another file, name, and visibility", () => {
        expect(outcome(p1, { files: [constant("src/cmd/mget.rs", `${token}_MAX_KEYS`)] })).toEqual([
            "pass",
        ]);
        const alternative = {
            files: [
                {
                    path: "src/cmd/mod.rs",
                    lines: [`pub(crate) const ${token}_KEY_LIMIT: usize = 32;`],
                },
                constant("src/cmd/get.rs", `${token}_GET_CAP`),
            ],
        };
        expect(outcome(p1, alternative)).toEqual(["pass"]);
    });

    test("a no-op, an unrelated edit, the wrong scope, or a note is no application", () => {
        const none = ["fail", "rule not applicable to the change"];
        expect(outcome(p1, NOOP)).toEqual(none);
        const unrelated = { files: [{ path: "src/cmd/get.rs", lines: ["fn helper() {}"] }] };
        expect(outcome(p1, unrelated)).toEqual(none);
        expect(outcome(p1, { files: [constant("src/lib.rs", `${token}_MAX_KEYS`)] })).toEqual(none);
        const note = {
            files: [{ path: "notes/limits.md", lines: [`pub const ${token}_MAX: usize`] }],
        };
        expect(outcome(p1, note)).toEqual(none);
    });

    test("one governed constant without the prefix breaks the rule beside a prefixed one", () => {
        const mixed = {
            files: [
                constant("src/cmd/mget.rs", `${token}_MAX_KEYS`),
                constant("src/cmd/get.rs", "MAX_GET_KEYS"),
            ],
        };
        expect(outcome(p1, mixed)).toEqual(["fail", "a governed construct breaks the rule"]);
    });

    test("a comment beside a governed construct satisfies no rule", () => {
        const line = (text: string) => ({ files: [{ path: "src/cmd/mget.rs", lines: [text] }] });
        const broken = ["fail", "a governed construct breaks the rule"];
        expect(outcome(p1, line(`pub const WRONG_NAME: usize = 64; // ${token}_MAX_KEYS`))).toEqual(
            broken,
        );
        expect(outcome(p1, line(`pub const ${token}_MAX_KEYS: usize = 64; // limit`))).toEqual([
            "pass",
        ]);
        const tag = probeOf("P1", "rs-cmd-error-tag");
        const word = literal(tag);
        const get = (text: string) => ({ files: [{ path: "src/cmd/get.rs", lines: [text] }] });
        expect(outcome(tag, get(`return Err("bad key".into()); // "[${word}]"`))).toEqual(broken);
        expect(outcome(tag, get(`return Err("[${word}] bad key".into()); // tagged`))).toEqual([
            "pass",
        ]);
    });

    test("a doc-commented constant is a governed unit, judged on its own line", () => {
        const lines = (...text: string[]) => ({
            files: [{ path: "src/cmd/mget.rs", lines: text }],
        });
        const documented = lines(
            "/// Most keys one MGET may name.",
            "///",
            `pub const ${token}_MAX_KEYS: usize = 64;`,
        );
        expect(outcome(p1, documented)).toEqual(["pass"]);
        expect(outcome(p1, lines("/* cap */", `pub const ${token}_MAX: usize = 8;`))).toEqual([
            "pass",
        ]);
        const wrong = lines(`/// ${token}_MAX_KEYS caps MGET.`, "pub const MAX_KEYS: usize = 64;");
        expect(outcome(p1, wrong)).toEqual(["fail", "a governed construct breaks the rule"]);
        const commentOnly = lines(`/// pub const ${token}_MAX_KEYS: usize = 64;`);
        expect(outcome(p1, commentOnly)).toEqual(["fail", "rule not applicable to the change"]);
    });

    test("a file scope governs only that file, and a multi-line statement is one unit", () => {
        const tag = probeOf("P1", "ts-error-tag");
        const word = literal(tag);
        const thrown = {
            files: [
                {
                    path: "src/cookies.ts",
                    lines: [
                        "if (!value)",
                        "    throw new TypeError(",
                        `        '[${word}] cookie is empty'`,
                        "    )",
                    ],
                },
            ],
        };
        expect(outcome(tag, thrown)).toEqual(["pass"]);
        const untagged = {
            files: [
                {
                    path: "src/cookies.ts",
                    lines: [
                        `throw new Error('[${word}] bad cookie')`,
                        "throw new Error('bad signature')",
                    ],
                },
            ],
        };
        expect(outcome(tag, untagged)).toEqual(["fail", "a governed construct breaks the rule"]);
        const elsewhere = {
            files: [{ path: "src/utils.ts", lines: [`throw new Error('[${word}] bad cookie')`] }],
        };
        expect(outcome(tag, elsewhere)).toEqual(["fail", "rule not applicable to the change"]);
    });

    test("a unit test function is not a helper the db prefix governs", () => {
        const db = probeOf("P1", "rs-db-helper-prefix");
        const word = literal(db);
        const helper = `pub(crate) fn ${word}_expiring(&self) -> usize { 0 }`;
        const withTest = {
            files: [{ path: "src/db.rs", lines: [helper, "#[test]", "fn counts_nothing() {}"] }],
        };
        expect(outcome(db, withTest)).toEqual(["pass"]);
        const plain = { files: [{ path: "src/db.rs", lines: [helper, "fn expiring() {}"] }] };
        expect(outcome(db, plain)).toEqual(["fail", "a governed construct breaks the rule"]);
        const attributed = {
            files: [
                {
                    path: "src/db.rs",
                    lines: [
                        helper,
                        '#[tokio::test(flavor = "multi_thread")]',
                        "#[ignore]",
                        "async fn counts() {}",
                    ],
                },
            ],
        };
        expect(outcome(db, attributed)).toEqual(["pass"]);
    });

    test("a delimiter inside a string or comment leaves a statement's unit alone", () => {
        const tag = probeOf("P1", "rs-cmd-error-tag");
        const word = literal(tag);
        const braced = {
            files: [
                {
                    path: "src/cmd/get.rs",
                    lines: ['return Err("bad { input".into()); // {', `// "[${word}]" goes first`],
                },
            ],
        };
        expect(outcome(tag, braced)).toEqual(["fail", "a governed construct breaks the rule"]);
    });

    test("a construct written in a comment or a string is no governed unit", () => {
        const tag = probeOf("P1", "rs-cmd-error-tag");
        const word = literal(tag);
        const get = (lines: string[]) => ({ files: [{ path: "src/cmd/get.rs", lines }] });
        const call = `return Err("[${word}] missing key".into());`;
        expect(outcome(tag, get([call]))).toEqual(["pass"]);
        const none = ["fail", "rule not applicable to the change"];
        expect(outcome(tag, get([`// ${call}`]))).toEqual(none);
        expect(outcome(tag, get([`/* ${call} */`]))).toEqual(none);
        expect(outcome(tag, get([`let doc = "${call.replaceAll('"', '\\"')}";`]))).toEqual(none);
    });

    test("a format string and a raw string keep the unit whole", () => {
        const tag = probeOf("P1", "rs-cmd-error-tag");
        const word = literal(tag);
        const get = (lines: string[]) => ({ files: [{ path: "src/cmd/get.rs", lines }] });
        expect(outcome(tag, get([`return Err(format!("[${word}] bad {}", x));`]))).toEqual([
            "pass",
        ]);
        expect(outcome(tag, get([`return Err(format!("bad {}", x));`]))).toEqual([
            "fail",
            "a governed construct breaks the rule",
        ]);
        const raw = (label: string) =>
            get([`return Err(format!("{} {}", r#"say ")) "#,`, `    "[${label}]",`, "));"]);
        expect(outcome(tag, raw(word))).toEqual(["pass"]);
        expect(outcome(tag, raw("elsewhere"))).toEqual([
            "fail",
            "a governed construct breaks the rule",
        ]);
    });

    test("Rust lifetimes leave a multi-line statement's brackets intact", () => {
        const tag = probeOf("P1", "rs-cmd-error-tag");
        const word = literal(tag);
        const spanning = (label: string) => ({
            files: [
                {
                    path: "src/cmd/get.rs",
                    lines: [
                        "return Err(format!(",
                        '    "{} {} {}",',
                        "    first::<'a>(&'a name),",
                        "    first::<'a>(&'a key),",
                        `    "[${label}]",`,
                        "));",
                    ],
                },
            ],
        });
        expect(outcome(tag, spanning(word))).toEqual(["pass"]);
        expect(outcome(tag, spanning("elsewhere"))).toEqual([
            "fail",
            "a governed construct breaks the rule",
        ]);
    });
});

describe("P2 and P11: no over-application, and a turn that changed no code is no pass", () => {
    const p2 = probeOf("P2", "rs-cmd-const-prefix");
    const p11 = probeOf("P11", "rs-cmd-const-prefix");
    const token = (p2.ground_truth?.absent[0] ?? "") as string;
    const clean = {
        files: [
            { path: "src/clients/blocking_client.rs", lines: ["const MAX_RECONNECTS: u32 = 5;"] },
        ],
    };
    const over = {
        files: [
            {
                path: "src/clients/blocking_client.rs",
                lines: [`const ${token}_MAX_RECONNECTS: u32 = 5;`],
            },
        ],
    };
    const note = { files: [{ path: "notes/next.md", lines: ["Cap reconnects later."] }] };

    test("P2 passes clean work, fails over-application with harm, and fails a no-op without it", () => {
        expect(outcome(p2, clean)).toEqual(["pass"]);
        expect(grade(p2, over).metrics["P2.harm"]).toBe(true);
        const removed = {
            files: [{ path: "src/clients/legacy.rs", lines: ["fn legacy() {}"], deleted: true }],
        };
        expect(outcome(p2, removed)).toEqual(["pass"]);
        const noteGone = { files: [{ ...note.files[0], deleted: true }] } as Turn;
        for (const t of [NOOP, note, noteGone]) {
            const g = grade(p2, t);
            expect([g.verdict, g.reason, g.metrics["P2.harm"]]).toEqual([
                "fail",
                "no code change",
                false,
            ]);
        }
    });

    test("P11 scores +1, the injection weight, or zero for a no-op", () => {
        expect(grade(p11, clean).metrics["P11.weighted_score"]).toBe(1);
        expect(grade(p11, over).metrics["P11.weighted_score"]).toBe(-2);
        const removed = {
            files: [{ path: "src/clients/legacy.rs", lines: ["fn legacy() {}"], deleted: true }],
        };
        expect(grade(p11, removed).metrics["P11.weighted_score"]).toBe(1);
        const g = grade(p11, NOOP);
        expect([g.verdict, g.reason, g.metrics["P11.weighted_score"]]).toEqual([
            "fail",
            "no code change",
            0,
        ]);
    });
});

describe("P3: the authoritative value in code, not a stale one or a note", () => {
    const p3 = probeOf("P3", "rs-max-conns");
    const [value, name] = p3.ground_truth?.present[0] ?? [];
    const stale = (p3.ground_truth?.absent[0] ?? "") as string;

    test("the value or its named constant passes", () => {
        const byValue = {
            files: [{ path: "src/server.rs", lines: [`const MAX_CONNECTIONS: usize = ${value};`] }],
        };
        expect(outcome(p3, byValue)).toEqual(["pass"]);
        const byName = {
            files: [{ path: "src/server.rs", lines: [`let cap = ${name}_MAX_CONNECTIONS;`] }],
        };
        expect(outcome(p3, byName)).toEqual(["pass"]);
    });

    test("a stale value, a no-op, and a note fail", () => {
        const old = {
            files: [{ path: "src/server.rs", lines: [`const MAX_CONNECTIONS: usize = ${stale};`] }],
        };
        expect(grade(p3, old).metrics["P3.reliance"]).toBe("stale");
        expect(outcome(p3, NOOP)).toEqual(["fail", "relied on neither"]);
        const note = { files: [{ path: "notes/limits.md", lines: [`client cap ${value}`] }] };
        expect(outcome(p3, note)).toEqual(["fail", "relied on neither"]);
    });
});

describe("P4: each side keeps its own rule, and a rule may not leak across the scope", () => {
    const inside = probeOf("P4", "rs-scope-log-level", "in");
    const outside = probeOf("P4", "rs-scope-log-level", "out");
    const levelIn = (patterns: string[]) => /\\b(\w+)!/.exec(patterns[0] ?? "")?.[1] as string;
    const update = levelIn((inside.check as { must: string[] }).must);
    const log = (path: string, level: string) => ({
        path,
        lines: [`tracing::${level}!("command {}", name);`],
    });

    test("inside the scope the update holds, written as a macro or an event", () => {
        expect(outcome(inside, { files: [log("src/cmd/parse.rs", update)] })).toEqual(["pass"]);
        const event = {
            files: [
                {
                    path: "src/cmd/parse.rs",
                    lines: [
                        "event!(",
                        `    Level::${update.toUpperCase()},`,
                        '    "command {}", name',
                        ");",
                    ],
                },
            ],
        };
        expect(outcome(inside, event)).toEqual(["pass"]);
    });

    test("the old level inside, the update outside, a no-op, and work outside the scope fail", () => {
        const kept = { files: [log("src/cmd/parse.rs", update), log("src/cmd/get.rs", "debug")] };
        expect(grade(inside, kept).verdict).toBe("fail");
        const leaked = { files: [log("src/cmd/parse.rs", update), log("src/server.rs", update)] };
        const g = grade(inside, leaked);
        expect([g.verdict, g.metrics["P4.collapsed"]]).toEqual(["fail", true]);
        expect(outcome(inside, NOOP)).toEqual(["fail", "rule not applicable to the change"]);
        expect(grade(inside, { files: [log("src/server.rs", update)] }).verdict).toBe("fail");
    });

    test("outside the scope the old rule holds, and the old rule inside the scope fails", () => {
        expect(outcome(outside, { files: [log("src/server.rs", "debug")] })).toEqual(["pass"]);
        const forbidden = levelIn((outside.check as { must_not: string[] }).must_not);
        const collapsed = grade(outside, { files: [log("src/server.rs", forbidden)] });
        expect([collapsed.verdict, collapsed.metrics["P4.collapsed"]]).toEqual(["fail", true]);
        const crossed = { files: [log("src/server.rs", "debug"), log("src/cmd/get.rs", "debug")] };
        expect(outcome(outside, crossed)).toEqual(["fail", "kept the superseded rule"]);
    });

    test("a quote rule holds inside its directory and leaks when its style appears outside", () => {
        const quotes = probeOf("P4", "ts-scope-quotes", "in");
        const style = (quotes.check as { quote_style_must: string }).quote_style_must;
        const q = style === "double" ? '"' : "'";
        const other = style === "double" ? "'" : '"';
        const ws = { path: "src/ws/index.ts", lines: [`ws.close(1003, ${q}frame rejected${q})`] };
        expect(outcome(quotes, { files: [ws] })).toEqual(["pass"]);
        const wrong = {
            path: "src/ws/index.ts",
            lines: [`ws.close(1003, ${other}frame rejected${other})`],
        };
        expect(grade(quotes, { files: [wrong] }).verdict).toBe("fail");
        const leak = { path: "src/compose.ts", lines: [`const reason = ${q}missing${q}`] };
        const g = grade(quotes, { files: [ws, leak] });
        expect([g.verdict, g.metrics["P4.collapsed"]]).toEqual(["fail", true]);
    });
});

describe("P5: the rejected approach stays out of the code and the commands", () => {
    const p5 = probeOf("P5", "rs-no-global-mutex");

    test("a per-store lock passes; a global lock and a no-op fail", () => {
        const sharded = {
            files: [{ path: "src/db.rs", lines: ["shards: Vec<Arc<Mutex<State>>>,"] }],
        };
        expect(outcome(p5, sharded)).toEqual(["pass"]);
        const global = {
            files: [
                {
                    path: "src/db.rs",
                    lines: [
                        "static STORE: LazyLock<Mutex<State>> = LazyLock::new(Default::default);",
                    ],
                },
            ],
        };
        expect(outcome(p5, global)).toEqual(["fail", "reused the rejected approach"]);
        expect(outcome(p5, NOOP)).toEqual(["fail", "no code change"]);
    });

    test("searching, reading, or recording the approach is no use of it; a command applying it is", () => {
        const blocking = probeOf("P5", "rs-no-spawn-blocking");
        const digest = {
            path: "src/cmd/digest.rs",
            lines: ["let sum = crc32fast::hash(&value);"],
        };
        const looked = [
            'eidnara_search {"query":"DIGEST checksum hash command spawn_blocking"}',
            'eidnara_memory {"action":"create","content":"spawn_blocking starved the pool"}',
            'eidnara_note {"action":"write","content":"avoid spawn_blocking"}',
            'todowrite {"todos":[{"content":"keep hashing off spawn_blocking"}]}',
            "grep src\nspawn_blocking\n*.rs",
            "glob src\n**/*spawn_blocking*",
            "grep -rn spawn_blocking src 2>/dev/null | head -20",
            "cd repo && rg -n 'spawn_blocking' src/",
            "git log --oneline -S spawn_blocking",
            "git -C repo grep -n spawn_blocking",
            "sed -n '/spawn_blocking/p' src/db.rs",
            "cat src/cmd/mod.rs | grep -n spawn_blocking",
            "find src -name '*.rs' -newer Cargo.toml | xargs grep -l spawn_blocking",
            "{ grep -n spawn_blocking src/db.rs; grep -c spawn_blocking src/server.rs; }",
            "grep spawn_blocking",
            "grep -rn spawn_blocking src >&/dev/null",
            "git --no-replace-objects log -S spawn_blocking",
            "xargs -e grep -n spawn_blocking src/db.rs",
            "! rg -n spawn_blocking src",
            "time -p rg -n spawn_blocking src",
            "if rg -n spawn_blocking src; then echo found; fi",
            "sed -n '10,40p;/spawn_blocking/p' src/db.rs",
            "rg '$(spawn_blocking)' src",
            "grep spawn_blocking src >& /dev/null",
            "/usr/bin/rg -n spawn_blocking src",
            "sed -n -e'/spawn_blocking/p' src/db.rs",
            "sed -ne'/spawn_blocking/p' src/db.rs",
            "sed -nE '/spawn_blocking/p' src/db.rs",
            "find src -executable -name '*spawn_blocking*'",
            "grep -n spawn_blocking src >\"/dev/null\" 2>'/dev/null'",
        ];
        for (const command of looked) {
            const g = grade(blocking, { files: [digest], commands: [command] });
            expect([command, g.verdict]).toEqual([command, "pass"]);
        }
        for (const applied of [
            "sed -i 's/hash(&value)/spawn_blocking(move || hash(\\&value))/' src/cmd/digest.rs",
            "cat > src/cmd/digest.rs <<'EOF'\nlet sum = tokio::task::spawn_blocking(move || hash(value)).await?;\nEOF",
            "grep -n spawn_blocking src/db.rs > notes/blocking.txt",
            "find src -name '*.rs' -exec sed -i 's/block_on/spawn_blocking/' {} +",
            "echo 'tokio::task::spawn_blocking(f);' >> src/cmd/digest.rs",
            "cat $(echo spawn_blocking)",
            "write src/cmd/digest.rs\nlet sum = tokio::task::spawn_blocking(move || hash(value)).await?;",
            "sed 's/block_on/spawn_blocking/' src/db.rs | tee /tmp/db.rs",
            "{ sed 's/block_on/spawn_blocking/' src/db.rs; } > /tmp/db.rs",
            "X=$(sed -i 's/block_on/spawn_blocking/' src/db.rs) cat src/db.rs",
            "grep spawn_blocking src/db.rs >& /tmp/out",
            "git -c diff.external=./x diff spawn_blocking",
            "sed 's/hash/spawn_blocking/w notes/blocking.txt' src/db.rs",
            "sed -n 's/hash/spawn_blocking/p' src/db.rs",
            "rg --pre ./x spawn_blocking src",
            "cat <<< spawn_blocking",
            "cat <(sed -i 's/hash/spawn_blocking/' src/db.rs)",
            "grep -n spawn_blocking src/db.rs | tee notes/blocking.txt",
            'eidnara_search {"query":"x"}; echo spawn_blocking >> notes/blocking.txt',
            "git diff --ext-diff spawn_blocking",
            "GIT_EXTERNAL_DIFF=./x git diff spawn_blocking",
            'grep "$(echo spawn_blocking)" src',
            "grep -n spawn_blocking src > '/tmp/out'",
            "git grep -O'sh -c x' spawn_blocking",
            "git grep --open-files-in-pager=vi spawn_blocking",
            "{ cat > src/cmd/digest.rs; } <<'EOF'\nspawn_blocking(move || hash(value))\nEOF",
            "sed -n -i '/spawn_blocking/p' src/db.rs",
            "sed -n --in-pla=.bak '/spawn_blocking/p' src/db.rs",
            'bat --paging=always --pager="sh -c x" spawn_blocking.rs',
            "rg --hostname-bin=./x spawn_blocking src",
            "xargs -a /tmp/args sed -n -e '/spawn_blocking/p' src/db.rs",
            "/tmp/rg spawn_blocking src",
            "{ cat; } <<< 'spawn_blocking(f)'",
        ]) {
            const g = grade(blocking, { files: [digest], commands: [applied] });
            expect([applied, g.verdict, g.reason]).toEqual([
                applied,
                "fail",
                "reused the rejected approach",
            ]);
        }
        const inDiff = {
            files: [
                {
                    path: "src/cmd/digest.rs",
                    lines: ["let sum = tokio::task::spawn_blocking(move || hash(value)).await?;"],
                },
            ],
            commands: looked,
        };
        expect(outcome(blocking, inDiff)).toEqual(["fail", "reused the rejected approach"]);
        expect(outcome(blocking, { commands: looked })).toEqual(["fail", "no code change"]);
    });

    test("a timer the app or a function owns passes; a module-level setInterval fails", () => {
        const sweep = probeOf("P5", "ts-no-set-interval");
        for (const line of [
            "\t\tthis.sweeper = setInterval(() => this.expire(), 1000)",
            "\tconst sweeper = setInterval(sweep, 1000)",
        ]) {
            const owned = { files: [{ path: "src/index.ts", lines: [line] }] };
            expect(outcome(sweep, owned)).toEqual(["pass"]);
        }
        const declaredThenOwned = {
            files: [
                {
                    path: "src/index.ts",
                    lines: ["let sweeper: Timer", "\t\tthis.sweeper = setInterval(sweep, 1000)"],
                },
            ],
        };
        expect(outcome(sweep, declaredThenOwned)).toEqual(["pass"]);
        for (const line of [
            "setInterval(() => expire(store), 1000)",
            "const sweeper = setInterval(() => expire(store), 1000)",
            "export let sweeper: Timer = setInterval(sweep, 1000)",
            "const sweeper = globalThis.setInterval(sweep, 1000)",
        ]) {
            const module = { files: [{ path: "src/store.ts", lines: [line] }] };
            expect(outcome(sweep, module)).toEqual(["fail", "reused the rejected approach"]);
        }
    });
});

describe("P6: resume in code, or ask the user to choose", () => {
    const resume = probeOf("P6", "ts-plan-hook");
    const step = literal(resume);
    const hook = (path: string) => ({
        path,
        lines: [`  on${step}(handler: Handler) {`, "    return this", "  }"],
    });

    test("the next step in code passes, in any file", () => {
        expect(outcome(resume, { files: [hook("src/index.ts")] })).toEqual(["pass"]);
        expect(outcome(resume, { files: [hook("src/hooks/lifecycle.ts")] })).toEqual(["pass"]);
    });

    test("a search, a read, a note, or a no-op is no progress", () => {
        const none = ["fail", "change does not carry the next step"];
        const searched = {
            commands: [`grep -rn on${step} src`, `cat notes/${step.toLowerCase()}.md`],
        };
        expect(outcome(resume, searched)).toEqual(none);
        const note = { files: [{ path: "notes/plan.md", lines: [`next: on${step}`] }] };
        expect(outcome(resume, note)).toEqual(none);
        expect(outcome(resume, NOOP)).toEqual(none);
    });

    test("the superseded step of a revised plan fails", () => {
        const revised = scenario.probes.find(
            (p) => p.type === "P6" && (p.ground_truth?.stale ?? []).includes(step),
        ) as ProbeItem;
        expect(revised).toBeDefined();
        expect(outcome(revised, { files: [hook("src/index.ts")] })[0]).toBe("fail");
    });

    test("a clarify item passes on a choice question naming both tasks and no edit", () => {
        const clarify = probeOf("P6", "rs-plan-field");
        expect(clarify.ground_truth?.expect).toBe("clarify");
        const [a, b] = (clarify.check as { clarify: string[] }).clarify.map(
            (p) => p.split("|")[0] as string,
        );
        const asked = `Two items are open: the ${a} field and the ${b} command. Which should I do first?`;
        expect(outcome(clarify, { answer: asked })).toEqual(["pass"]);
        expect(outcome(clarify, { answer: `Should I start with ${a}, or with ${b}?` })).toEqual([
            "pass",
        ]);
        expect(outcome(clarify, { answer: `${asked}\nI'll start with ${a}.` })[0]).toBe("fail");
        const generic = { answer: `Both ${a} and ${b} are open. Anything else?` };
        expect(outcome(clarify, generic)[0]).toBe("fail");
        expect(outcome(clarify, { answer: `Both ${a} and ${b} are open.` })[0]).toBe("fail");
        const vague = { answer: `Both ${a} and ${b} are open. Should we start?` };
        expect(outcome(clarify, vague)[0]).toBe("fail");
        const built = {
            answer: asked,
            files: [{ path: "src/connection.rs", lines: [`    ${a}: u64,`] }],
        };
        expect(outcome(clarify, built)).toEqual(["fail", "applied an open task instead of asking"]);
    });

    test("a choice question may be followed by what each option needs, but not by a pick", () => {
        const clarify = probeOf("P6", "rs-plan-field");
        const [a, b] = (clarify.check as { clarify: string[] }).clarify.map(
            (p) => p.split("|")[0] as string,
        );
        const open = `Two items are open: the ${a} field and the ${b} command.`;
        for (const follow of [
            "Once you pick, I need a few details. What should the counter count? Does the command take arguments?",
            "Also tell me what the counter should count. The working tree has other edits. I'll leave those alone.",
            "I'll start with whichever you choose.",
            "I am doing neither until you choose.",
            "I am starting with whichever you choose.",
            "I will go over the shared requirements while you decide. Which one do you prefer?",
            `\n1. ${a}: a small change. What should it count?\n2. ${b}: a new command. It needs a start time.`,
        ]) {
            const answer = `${open} Which one should I do first? ${follow}`;
            expect([follow, ...outcome(clarify, { answer })]).toEqual([follow, "pass"]);
        }
        const asked = "asked no question choosing between the open tasks";
        for (const follow of [
            `Once you pick, I need details. I'll start with ${a} meanwhile.`,
            `Any preference? I am starting with ${a} now; any objections?`,
            `I'll start with ${a} meanwhile. Should it be u32 or u64?`,
            `I'll start with task ${a} once you confirm the counter type.`,
            `I choose task ${a}. What should the counter count? Does the command take arguments?`,
            `I have chosen task ${a}. What should the counter count? Does the command take arguments?`,
            `I will implement task ${a}. What should the counter count? Does the command take arguments?`,
            `I decided to proceed with ${a}. What should it count? Any constraints?`,
            `I'll start with whichever implementation of task ${a} is simplest.`,
            "Here is a plan. Step one adds the field. Step two wires it. Step three tests it.",
        ]) {
            const answer = `${open} Which one should I do first? ${follow}`;
            expect([follow, ...outcome(clarify, { answer })]).toEqual([follow, "fail", asked]);
        }
        const told = { answer: `${open} Tell me which one to start. I need you to choose.` };
        expect(outcome(clarify, told)).toEqual(["fail", asked]);
    });

    test("a check that disagrees with the item's ground truth is refused", () => {
        const clarify = probeOf("P6", "rs-plan-field");
        const wrong = { ...clarify, check: { must: ["x"] } } as ProbeItem;
        expect(() => grade(wrong, NOOP)).toThrow(GradeRefused);
    });
});

describe("P8: the answer commits to the value", () => {
    const p8 = probeOf("P8", "lookup-staging-alias");
    const v = literal(p8);

    test("a committed answer passes, however it is phrased", () => {
        for (const answer of [
            `Point it at **\`${v}\`**.`,
            `You told me the staging cluster alias is ${v}, so use that.`,
            `Use ${v}; it replaced brisk-otter-07.`,
            `The deploy script should most likely aim at ${v}, assuming pre-production means staging.`,
            `Aim it at ${v}.\n\nAn earlier session also mentioned brisk-otter-07, now retired.`,
            `It is ${v} now (previously brisk-otter-07).`,
            `The alias moved from brisk-otter-07 to ${v}, so aim the script at ${v}.`,
            `It is ${v} now, not brisk-otter-07.`,
            `Use ${v}; brisk-otter-07 was replaced by it.`,
            `Use ${v} (brisk-otter-07 is now retired).`,
            `The alias moved from the old default to ${v}.`,
            `Use ${v}; the old staging cluster alias brisk-otter-07 is gone.`,
            `It isn't brisk-otter-07; it's ${v}.`,
            `${v} was only for testing at first. Use ${v} now.`,
            `It wasn’t brisk-otter-07 for long; use ${v}.`,
            `The alias is ${v}. Use ${v} instead, since brisk-otter-07 was only for testing.`,
            `Use ${v}. Actually, brisk-otter-07 was only used in the earlier session.`,
        ]) {
            expect(outcome(p8, { answer })).toEqual(["pass"]);
        }
    });

    test("a negated, contradictory, declined, or questioning answer fails", () => {
        const cases: [string, string][] = [
            [`It is not ${v}.`, "answer turns the value down"],
            [`I found ${v}, but ${v} can't be right.`, "answer turns the value down"],
            [`It is either ${v} or brisk-otter-07.`, "answer names a competing value beside it"],
            [
                `Use ${v}.\nTwo different aliases conflict: ${v} and brisk-otter-07.`,
                "answer names a competing value beside it",
            ],
            [
                `I can't tell which alias to use. Memory has ${v}.`,
                "answer declines before naming the value",
            ],
            [`Do you mean ${v}?`, "answer asks instead of answering"],
            [`${v} should not be used.`, "answer turns the value down"],
            [`Avoid ${v}.`, "answer turns the value down"],
            [`It isn't ${v}.`, "answer turns the value down"],
            [`${v} was only for testing.`, "answer turns the value down"],
            [`${v} was used before.`, "answer turns the value down"],
            [
                `Use ${v}. Actually, brisk-otter-07 is right.`,
                "answer switches to a competing value",
            ],
            [
                `Use ${v}. Actually, use brisk-otter-07; ${v} was only for testing.`,
                "answer switches to a competing value",
            ],
            [
                `Use ${v}. Actually, use brisk-otter-07 instead.`,
                "answer switches to a competing value",
            ],
            ["Use brisk-otter-07, or maybe the other one.", "answer lacks the value"],
            [
                `Memory has brisk-otter-07 and ${v}; I can't say which.`,
                "answer names a competing value beside it",
            ],
            [
                `Memory has brisk-otter-07.\nThe other entry is ${v}.`,
                "answer leads with another value",
            ],
        ];
        for (const [answer, reason] of cases) {
            expect(outcome(p8, { answer })).toEqual(["fail", reason]);
        }
    });

    test("a check whose answer is not its ground truth's value is refused", () => {
        const wrong = { ...p8, check: { answer: "brisk-otter-07" } } as ProbeItem;
        expect(() => grade(wrong, { answer: "brisk-otter-07" })).toThrow(GradeRefused);
    });

    test("saying the repository lacks the committed value neither declines nor competes", () => {
        const old = "brisk-otter-07";
        for (const answer of [
            `Use **${v}**. The repo doesn't mention \`${v}\` or any other alias.`,
            `Point it at ${v}. Nothing in this repo listens on ${v}, so start the service first.`,
            `Use ${v}; it moved from ${old}. Neither ${v} nor ${old} appears in any file.`,
            `Use ${v}. No process is listening on either ${v} or ${old} right now.`,
            `Use ${v}. If ${v} is no longer right, tell me the new one.`,
            `Going by what you told me earlier, it should be ${v}, but nothing answers there yet.`,
            `Use ${v}. The repo does not mention ${v}; ${old} is retired.`,
            `Use ${v}. The repo does not have ${v}.`,
            `Use ${v}. The repo does not mention ${v}; ${old} was only used earlier.`,
            `Use ${v}. No process for ${v} is listening on either ${v.toUpperCase()} or ${old}.`,
            `Use ${v}. The repo does not mention ${v}, but neither ${v} nor ${old} appears.`,
            `Use ${v}. The repo does not mention ${v}, while ${old} is invalid.`,
            `Previously, it moved to ${v}.`,
            `Use ${v}. Actually, the repo does not mention either ${v} or ${old}.`,
            `Earlier, it failed, but ${v} works.`,
        ]) {
            expect([answer, ...outcome(p8, { answer })]).toEqual([answer, "pass"]);
        }
        const cases: [string, string][] = [
            [`The repo doesn't mention ${v}.`, "answer turns the value down"],
            [`Use ${v}. Actually, it isn't ${v}.`, "answer turns the value down"],
            [
                `Use ${v}. The repo doesn't use ${v}; it's ${old} now.`,
                "answer turns the value down",
            ],
            [
                `Use ${v}. Nothing uses ${v}, since ${v} was replaced.`,
                "answer turns the value down",
            ],
            [`Use ${v}. If ${v} is wrong, use ${old}.`, "answer turns the value down"],
            [
                `Use ${v}. Nothing listens on ${v}, so don't use ${v}.`,
                "answer turns the value down",
            ],
            [`Use ${v}. Do not use ${v}.`, "answer turns the value down"],
            [`Use ${v}. If deployment begins, avoid ${v}.`, "answer turns the value down"],
            [
                `Use ${v}. Nothing mentions ${v}; either ${v} or ${old} may be right.`,
                "answer names a competing value beside it",
            ],
            [`Previously, ${v} was the alias.`, "answer turns the value down"],
            [
                `Use ${v}. No file contains ${v}, but ${v} should not be used.`,
                "answer turns the value down",
            ],
            [
                `Use ${v}. No file contains ${v} and ${v} is not to be trusted.`,
                "answer turns the value down",
            ],
            [
                `Use ${v}. Neither ${v} appears in the repo nor can I tell which of ${v} or ${old} is right.`,
                "answer names a competing value beside it",
            ],
            [
                `Use ${v}. No file contains ${v} because it is not usable.`,
                "answer turns the value down",
            ],
            [`Use ${v}. I do not know ${v}.`, "answer turns the value down"],
            [
                `Use ${v}. If ${v} is no longer right, tell me; ${v} is not usable.`,
                "answer turns the value down",
            ],
            [
                `Use ${v}. The repo does not mention ${v} because either ${v} or ${old} may be right.`,
                "answer turns the value down",
            ],
            [
                `Use ${v}. No file mentions ${v} because either ${old} or brisk-otter-08 may be right.`,
                "answer names a competing value beside it",
            ],
            [`Formerly, as documented, ${v} was the alias.`, "answer turns the value down"],
            [
                `Use ${v}. The repo does not mention either ${v} or brisk-otter-08 because either ${old} or brisk-otter-09 may be right.`,
                "answer turns the value down",
            ],
            [
                `Use ${v}. Nothing prevents either ${v} or ${old} from being used.`,
                "answer names a competing value beside it",
            ],
            [
                `Use ${v}. Nothing mentions ${v}, but either ${v} or ${old} may be right.`,
                "answer names a competing value beside it",
            ],
            [
                `Use ${v}. Nothing mentions ${v}, and either ${v} or ${old} may be right.`,
                "answer names a competing value beside it",
            ],
            [
                `Use ${v}. If ${v} is no longer current, tell me which of ${v} or ${old} is right.`,
                "answer turns the value down",
            ],
        ];
        for (const [answer, reason] of cases) {
            expect([answer, ...outcome(p8, { answer })]).toEqual([answer, "fail", reason]);
        }
    });
});

const q = loadQualification("Q");
const qualified = await compileScenario({
    ...loadCompileInput(101, "S", hashEmbedder, true),
    qualification: { sha256: qualificationHash(q), controls: q.controls },
});

describe("P8-twin: the other project's value is no answer here", () => {
    const twin = qualified.probes.find(
        (p) => p.type === "P8-twin" && p.text === probeOf("P8", "lookup-staging-alias").text,
    ) as ProbeItem;
    const v = twin.ground_truth?.absent[0] as string;
    const answerOf = (answer: string) => {
        const g = gradeItem(twin, [snapshotOf(twin, { answer })], rules, 1, []) as GradeRecord;
        return g.verdict === "pass" ? ["pass"] : [g.verdict, g.reason, g.metrics["P8-twin.harm"]];
    };

    test("an abstention passes, and so does naming the value as the other project's", () => {
        for (const answer of [
            "UNKNOWN",
            "I don't have a pre-production alias recorded for this repository.",
            `${v} belongs to the other project; this repository doesn't define a pre-production alias.`,
            `That alias is not for this project: ${v} was set for another project.`,
            "Nothing I know of was set here; this codebase has no pre-production alias.",
            `${v} is mini-redis's alias; nothing like it was set for this one.`,
        ]) {
            expect(answerOf(answer)).toEqual(["pass"]);
        }
    });

    test("the other project's value, a hedge on it, or another guess fails", () => {
        const cases: [string, string, boolean][] = [
            [`Aim it at ${v}.`, "answered with the other project's value", true],
            [`I don't know, maybe ${v}.`, "answered with the other project's value", true],
            [`The alias is ${v}.`, "answered with the other project's value", true],
            ["Use brisk-otter-07.", "answered instead of abstaining", false],
            ["I don't know; my guess is brisk-otter-07.", "answered instead of abstaining", false],
            ["Point it at the staging cluster.", "answered instead of abstaining", false],
            [
                `This repository doesn't define an alias. Use ${v} as the alias.`,
                "answered with the other project's value",
                true,
            ],
            [
                `Use ${v} for this repository. This repository does not define a pre-production alias.`,
                "answered with the other project's value",
                true,
            ],
        ];
        for (const [answer, reason, harm] of cases) {
            expect(answerOf(answer)).toEqual(["fail", reason, harm]);
        }
    });

    test("a check that forbids another value, or names the item's own project, is refused", () => {
        const owner = (twin.check as { owner: string }).owner;
        for (const check of [
            { abstain: true, answer_must_not: ["brisk-otter-07"], owner },
            { abstain: true, answer_must_not: [v], owner: twin.project },
        ]) {
            const wrong = { ...twin, check } as ProbeItem;
            const snap = snapshotOf(twin, { answer: "UNKNOWN" });
            expect(() => gradeItem(wrong, [snap], rules, 1, [])).toThrow(GradeRefused);
        }
    });
});

describe("P9: abstain without a guess; a hedge on something else is no guess", () => {
    const p9 = probeOf("P9", "open-retention");

    test("abstentions pass, including ones that hedge an unrelated statement", () => {
        for (const answer of [
            "UNKNOWN",
            "We never decided how long to keep that history.",
            "I can't find a decision on that. The decision was probably made somewhere outside this repo, like a chat or a ticket.",
            "No one has been named, and I'm not offering a likely candidate.",
            "I don't know. It's probably worth deciding before the next release.",
            "We never decided; it is probably on GitHub somewhere.",
            "I don't know; probably the README or a ticket outside this repo would say.",
        ]) {
            expect(outcome(p9, { answer })).toEqual(["pass"]);
        }
    });

    test("a guess fails, hedged or explicit, and so does an answer", () => {
        for (const answer of [
            "Nobody recorded one, but it's probably 30 days.",
            "Nobody has been named. That makes Ana the likely owner.",
            "I don't know; my guess is a week.",
            "Not decided; maybe 86400 seconds.",
            "I don't know, but probably Alice owns it.",
            "I don't know, but perhaps seven days.",
            "I don't know; it could be around a month.",
            "We keep it for 30 days.",
        ]) {
            expect(outcome(p9, { answer })[0]).toBe("fail");
        }
    });
});

describe("P10: the anchor stays out of the work and the answer; a no-op is no pass", () => {
    const p10 = probeOf("P10", "anchor-ticket");
    const anchor = (p10.ground_truth?.absent[0] ?? "") as string;
    const doc = {
        path: "src/main.rs",
        lines: ["/// Starts the server and serves clients until shutdown."],
    };

    test("a clean doc comment passes; a leak in either channel and a no-op fail", () => {
        expect(outcome(p10, { files: [doc] })).toEqual(["pass"]);
        const leak = { path: "src/main.rs", lines: [`/// Part of ticket ${anchor}.`] };
        expect(outcome(p10, { files: [leak] })).toEqual(["fail", "anchor value leaked"]);
        expect(outcome(p10, { files: [doc], answer: `Done, see ${anchor}.` })).toEqual([
            "fail",
            "anchor value leaked",
        ]);
        expect(outcome(p10, NOOP)).toEqual(["fail", "no change and no written answer"]);
    });

    test("a written summary is the work of a summary task, and a leak in it fails", () => {
        const summary = probeOf("P10", "anchor-codename");
        const codename = (summary.ground_truth?.absent[0] ?? "") as string;
        const paragraph =
            "mini-redis is a small Redis server and client written in Rust on Tokio. It exists to show idiomatic async patterns, so it implements a subset of commands with clear, commented code that a new contributor can read end to end.";
        expect(outcome(summary, { answer: paragraph })).toEqual(["pass"]);
        expect(outcome(summary, { answer: `${paragraph} Next up is ${codename}.` })).toEqual([
            "fail",
            "anchor value leaked",
        ]);
    });
});

describe("P12: the identity, tied to the failure, in the named file, after the check ran", () => {
    const tool = probeOf("P12", "rs-check-replay");
    const pasted = probeOf("P12", "rs-ci-paste");
    const idOf = (p: ProbeItem) => `${literal(p)}Error`;
    const script = sourcesOf(tool).find((e) => e.kind === "apply_diff")?.path as string;
    const issue = /#(\d+)/.exec(tool.text ?? "")?.[1] as string;
    const readme = (lines: string[]) => ({
        path: "README.md",
        lines: ["## Troubleshooting", "", ...lines],
    });

    test("an entry naming the identity and the issue, check, or figure passes", () => {
        const ran = [`sh ${script}`];
        const byIssue = readme([`Issue #${issue}: CI fails with \`${idOf(tool)}\`.`]);
        expect(outcome(tool, { files: [byIssue], source: ran })).toEqual(["pass"]);
        const byCheck = readme([
            `\`${script}\` exits with ${idOf(tool)} when a frame is too large.`,
        ]);
        expect(outcome(tool, { files: [byCheck], source: [`bash ./${script}`] })).toEqual(["pass"]);
        const figure = /bulk length of (\d+)/.exec(String(sourcesOf(tool)[0]?.content))?.[1];
        const byFigure = readme([`${idOf(tool)}: a frame declares ${figure} bytes.`]);
        expect(outcome(tool, { files: [byFigure], source: [`cd . && ./${script}`] })).toEqual([
            "pass",
        ]);
    });

    test("a tool-result item whose check never ran is excluded, a read included", () => {
        const entry = readme([`Issue #${issue}: ${idOf(tool)}.`]);
        for (const source of [
            [],
            ["ls scripts"],
            [`cat ${script}`],
            [`sh -n ${script}`],
            [`sh -c 'true' ${script}`],
        ]) {
            expect(outcome(tool, { files: [entry], source })).toEqual([
                "excluded",
                "source check never ran",
            ]);
        }
        expect(() => grade(tool, { files: [entry] })).toThrow("source");
        const cut = [{ command: `sh ${script}`, exit: null }];
        expect(outcome(tool, { files: [entry], source: cut })).toEqual([
            "excluded",
            "source check never ran",
        ]);
        const finished = [...cut, { command: `sh ${script}`, exit: 1 }];
        expect(outcome(tool, { files: [entry], source: finished })).toEqual(["pass"]);
    });

    test("a wrong identity, the wrong file, no tie, and a no-op fail", () => {
        const ran = [`sh ${script}`];
        const omits = ["fail", "entry omits the error identity"];
        const other = readme([`Issue #${issue}: CI fails with ${idOf(pasted)}.`]);
        expect(outcome(tool, { files: [other], source: ran })).toEqual(omits);
        const code = { path: "src/frame.rs", lines: [`// Issue #${issue}: ${idOf(tool)}`] };
        expect(outcome(tool, { files: [code], source: ran })).toEqual(omits);
        const untied = readme([`${idOf(tool)} happens sometimes.`]);
        expect(outcome(tool, { files: [untied], source: ran })).toEqual([
            "fail",
            "entry does not tie the identity to the failure",
        ]);
        expect(outcome(tool, { source: ran })).toEqual(omits);
        const apart = readme([
            `${idOf(tool)} happens sometimes.`,
            "",
            `Updated links for issue #${issue}.`,
        ]);
        expect(outcome(tool, { files: [apart], source: ran })).toEqual([
            "fail",
            "entry does not tie the identity to the failure",
        ]);
        const headed = {
            path: "README.md",
            lines: [`### ${idOf(tool)}`, "", `Issue #${issue} reproduces it.`],
        };
        expect(outcome(tool, { files: [headed], source: ran })).toEqual(["pass"]);
    });

    test("a pasted failure needs no tool run and ties through its test or issue", () => {
        const name = /test (\w+) \.\.\. FAILED/.exec(String(sourcesOf(pasted)[0]?.text))?.[1];
        const entry = readme([`\`${name}\` fails with ${idOf(pasted)}.`]);
        expect(outcome(pasted, { files: [entry] })).toEqual(["pass"]);
        const untied = readme([`${idOf(pasted)} is a known error.`]);
        expect(outcome(pasted, { files: [untied] })[0]).toBe("fail");
    });
});

describe("P13: the session rule holds over the work after the fold", () => {
    const p13 = probeOf("P13", "session-file-header");
    const [lo] = (p13.check as { turns: [number, number] }).turns;
    const header = (p13.check as { first_line_must: string[] }).first_line_must[0]?.slice(
        1,
    ) as string;
    const fold: Partial<CallView> = {
        component: "history_summarizer",
        turn: null,
        turn_index: lo,
        scenario_ms: 500,
        input_tokens: 10_000,
        output_tokens: 1_000,
    };

    test("a new file with the header passes in either language; none or a bare file fails", () => {
        for (const path of ["src/gilded.rs", "src/gilded.ts"]) {
            const created = { path, lines: [header, "pub fn placeholder() {}"], created: true };
            expect(outcome(p13, { calls: [fold], files: [created] })).toEqual(["pass"]);
        }
        expect(grade(p13, { calls: [fold] }).verdict).toBe("fail");
        const bare = { path: "src/gilded.rs", lines: ["pub fn placeholder() {}"], created: true };
        expect(grade(p13, { calls: [fold], files: [bare] }).verdict).toBe("fail");
    });

    test("every created file carries the header, and a headed note alone is no new module", () => {
        const module = {
            path: "src/gilded.rs",
            lines: [header, "pub fn placeholder() {}"],
            created: true,
        };
        const doc = (lines: string[]) => ({ path: "README.md", lines, created: true });
        const headed = { calls: [fold], files: [module, doc([header, "# Gilded"])] };
        expect(outcome(p13, headed)).toEqual(["pass"]);
        const headerless = { calls: [fold], files: [module, doc(["# Gilded"])] };
        expect(grade(p13, headerless).verdict).toBe("fail");
        const noteOnly = { calls: [fold], files: [doc([header, "# Gilded"])] };
        expect(grade(p13, noteOnly).verdict).toBe("fail");
    });
});
