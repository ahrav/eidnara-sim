import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConverseBody } from "../proxy/classify";
import {
    evidenceNote,
    joinListing,
    originCategory,
    probeTypeCategory,
    projectMemoryBlock,
    splitListing,
    TRANSFORMS,
    type TransformInputs,
    transformDigest,
    transformFor,
} from "./transforms";

const FIXTURES = join(import.meta.dir, "../../tests/fixtures/replay");
const recorded = (): ConverseBody =>
    JSON.parse(readFileSync(join(FIXTURES, "agent-request.json"), "utf8")) as ConverseBody;
const hinted = (): ConverseBody => {
    const body = recorded();
    const message = JSON.parse(readFileSync(join(FIXTURES, "hint-message.json"), "utf8"));
    return { ...body, messages: [message] };
};

const PROBE = "Let's continue with what we left unfinished.";
const inputs = (over: Partial<TransformInputs> = {}): TransformInputs => ({
    probe_text: PROBE,
    ground_truth: { present: [["onYONDER_BADGER"]], stale: [], absent: [] },
    oracle_note:
        "Background from earlier sessions on elysia, quoted as it came up:\n\nMy request now:\n",
    evidence_note:
        "Note from earlier sessions:\n- I wrote: the next step is an onYONDER_BADGER hook.",
    project_memory:
        "<project-memory>\n<USER_DIRECTIVES>\nmem_1: User stated: add an onYONDER_BADGER hook.\n</USER_DIRECTIVES>\n</project-memory>",
    origin_memory:
        "<project-memory>\n<USER_DIRECTIVES>\nmem_2: User stated: add an onYONDER_BADGER hook.\n</USER_DIRECTIVES>\n</project-memory>",
    ...over,
});

type Message = { role: string; content: Array<Record<string, unknown>> };
const messages = (b: ConverseBody) => b.messages as Message[];
const text = (b: ConverseBody, m: number, c = 0) => messages(b)[m]?.content[c]?.text as string;
const result = (b: ConverseBody, c: number) =>
    ((messages(b)[4]?.content[c]?.toolResult as { content: Array<{ text: string }> }).content[0]
        ?.text ?? "") as string;

describe("replay transforms on a recorded agent request", () => {
    test("none forwards the body byte for byte", () => {
        const body = recorded();
        const before = JSON.stringify(body);
        expect(TRANSFORMS.none?.apply(body, inputs()).changed).toBe(false);
        expect(JSON.stringify(body)).toBe(before);
    });

    test("evidence-note appends the note to the probe text and nowhere else", () => {
        const body = recorded();
        const before = recorded();
        const applied = transformFor("b").apply(body, inputs());
        expect(applied.changed).toBe(true);
        expect(text(body, 2)).toBe(`§1§ ${PROBE}\n\n${inputs().evidence_note}`);
        for (const m of [0, 1, 3, 4]) {
            expect(JSON.stringify(messages(body)[m])).toBe(JSON.stringify(messages(before)[m]));
        }
        expect(JSON.stringify(body.system)).toBe(JSON.stringify(before.system));
    });

    test("oracle-note puts the note between the plugin's marker and the probe text", () => {
        const body = recorded();
        transformFor("oracle-note").apply(body, inputs());
        expect(text(body, 2)).toBe(`§1§ ${inputs().oracle_note}${PROBE}`);
    });

    test("a note transform without a probe message or a note changes nothing", () => {
        const body = recorded();
        const before = JSON.stringify(body);
        const other = transformFor("b").apply(body, inputs({ probe_text: "Some other request." }));
        expect(other).toEqual({ changed: false, detail: { reason: "no probe message" } });
        const none = transformFor("e").apply(body, inputs({ oracle_note: null }));
        expect(none).toEqual({ changed: false, detail: { reason: "no sources" } });
        expect(JSON.stringify(body)).toBe(before);
    });

    test("drop-competing keeps only the supporting search hit, renumbered, with its count", () => {
        const body = recorded();
        const applied = transformFor("c").apply(body, inputs());
        expect(applied.changed).toBe(true);
        const search = result(body, 1);
        expect(search).toContain("Found 1 results");
        expect(search.match(/^\[\d+\] \[memory\]/gm)).toEqual(["[1] [memory]"]);
        expect(search).toContain("id=mem_c97b1be92585a58a2869b64b9bb781dd");
        expect(search).not.toContain("ZEPHYR_KOALA_COOKIE_MAX_AGE");
        expect(result(body, 0)).toBe(result(recorded(), 0));
        expect(result(body, 2)).toBe(result(recorded(), 2));
        expect(applied.detail).toEqual({
            slots: [{ slot: "eidnara_search", items: 6, dropped: 5, supporting: true }],
            unparsed: ["eidnara_note"],
        });
        expect(search).not.toMatch(/\n\n\n/);
    });

    test("drop-competing drops only stale hits when no hit supports the ground truth", () => {
        const body = recorded();
        const gt = { present: [["absent-literal"]], stale: ["57766"], absent: [] };
        transformFor("drop-competing").apply(body, inputs({ ground_truth: gt }));
        const search = result(body, 1);
        expect(search).toContain("Found 5 results");
        expect(search.match(/^\[\d+\]/gm)).toEqual(["[1]", "[2]", "[3]", "[4]", "[5]"]);
        expect(search).not.toContain("57766");
        expect(search).toContain("onYONDER_BADGER");
    });

    test("drop-competing trims the plugin's search-hint fragments", () => {
        const body = hinted();
        const gt = { present: [["closed connection"]], stale: [], absent: [] };
        const applied = transformFor("c").apply(body, inputs({ ground_truth: gt }));
        expect(applied.changed).toBe(true);
        const t = text(body, 0);
        expect(t).toContain("Your memory may contain 1 related fragments:");
        expect(t.match(/^- /gm)?.length).toBe(1);
        expect(t).toContain("handles closed connection cleanly");
        expect(t.startsWith("§156§ Check whether the blocking client")).toBe(true);
        expect(t).toContain("you may run eidnara_search");
    });

    test("provenance-off removes trust labels, attributions, and provenance records", () => {
        const body = recorded();
        const applied = transformFor("d").apply(body, inputs());
        expect(applied.detail).toEqual({
            trust: 6,
            attribution: 4,
            records: 4,
            unparsed: ["eidnara_note"],
        });
        const search = result(body, 1);
        expect(search).not.toContain("trust=[");
        expect(search).not.toContain("User stated:");
        expect(search).not.toContain("Assistant reported:");
        expect(search).not.toContain('"citation"');
        expect(search).toContain(
            "match=lexical\nwhen we pick this back up, the next step is adding an onYONDER_BADGER",
        );
        expect(search.match(/^\[\d+\]/gm)?.length).toBe(6);
        expect(result(body, 2)).toBe(result(recorded(), 2));
    });

    test("a variant resolves by name or letter, and an unknown one is refused", () => {
        expect(
            ["a", "b", "c", "c2", "c3", "d", "d2", "e", "f", "f2"].map((v) => transformFor(v).id),
        ).toEqual([
            "none",
            "evidence-note",
            "drop-competing",
            "drop-competing-caution",
            "caution-off",
            "provenance-off",
            "provenance-notices-off",
            "oracle-note",
            "memory-block",
            "memory-block-origin",
        ]);
        expect(() => transformFor("z")).toThrow("unknown replay variant z");
        for (const inherited of ["constructor", "toString", "__proto__"]) {
            expect(() => transformFor(inherited)).toThrow("unknown replay variant");
        }
    });

    test("the digest binds the transform and its inputs", () => {
        const b = transformFor("b");
        expect(transformDigest(b, inputs())).toBe(transformDigest(b, inputs()));
        expect(transformDigest(b, inputs())).not.toBe(transformDigest(transformFor("e"), inputs()));
        const other = inputs({ evidence_note: "Note from earlier sessions:\n- I wrote: x" });
        expect(transformDigest(b, inputs())).not.toBe(transformDigest(b, other));
    });
});

describe("evidenceNote", () => {
    const events = [
        { id: "e-1", kind: "user_turn", text: "The alias is\nyonder-yak-52." },
        { id: "e-2", kind: "apply_diff", path: "notes/a.md", content: "use ```fences```\n" },
        { id: "e-3", kind: "apply_diff", path: "old.md", remove: true },
    ];

    test("projectMemoryBlock renders sources as one category of id-sorted memory lines", () => {
        const block = projectMemoryBlock(
            [...events, { id: "e-4", kind: "user_turn", text: "Keep <T> & U." }],
            ["e-4", "e-2"],
            probeTypeCategory("P8"),
        ) as string;
        const lines = block.split("\n");
        expect(lines[0]).toBe("<project-memory>");
        expect(lines[1]).toBe("<CONFIG_VALUES>");
        expect(lines.slice(-2)).toEqual(["</CONFIG_VALUES>", "</project-memory>"]);
        const rows = lines
            .slice(2, -2)
            .join("\n")
            .split(/\n(?=mem_)/);
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.slice(0, 36))).toEqual(rows.map((r) => r.slice(0, 36)).sort());
        expect(rows).toContainEqual(
            expect.stringMatching(/^mem_[0-9a-f]{32}: User stated: Keep &lt;T&gt; &amp; U\.$/),
        );
        expect(rows).toContainEqual(
            expect.stringMatching(
                /^mem_[0-9a-f]{32}: notes\/a\.md was committed with:\n {2}use ```fences```$/,
            ),
        );
        expect(projectMemoryBlock(events, ["e-1"], probeTypeCategory("P99"))).toContain(
            "<PROJECT_RULES>",
        );
        expect(projectMemoryBlock(events, ["e-9"], probeTypeCategory("P8"))).toBeNull();
    });

    test("quotes each source in scenario order, fencing committed files past their backticks", () => {
        expect(evidenceNote(events, ["e-3", "e-1", "e-2"])).toBe(
            [
                "Note from earlier sessions:",
                "- I wrote: The alias is yonder-yak-52.",
                "- notes/a.md was committed with:",
                "````",
                "use ```fences```",
                "````",
                "- old.md was removed from the repository.",
            ].join("\n"),
        );
    });

    test("is null without a source event", () => {
        expect(evidenceNote(events, [])).toBeNull();
        expect(evidenceNote(events, ["e-9"])).toBeNull();
    });
});

describe("splitListing", () => {
    test("the count line follows when every item goes", () => {
        const body = recorded();
        const tool = messages(body)[4]?.content[1]?.toolResult as { content: { text: string }[] };
        (tool.content[0] as { text: string }).text =
            "Found 1 results:\n\n[1] [memory] id=a\nstale 57766";
        const gt = { present: [["absent-literal"]], stale: ["57766"], absent: [] };
        transformFor("c").apply(body, inputs({ ground_truth: gt }));
        expect(result(body, 1)).toBe("Found 0 results:\n");
    });

    test("provenance-off keeps a remembered JSON line that is not a provenance record", () => {
        const body = recorded();
        const tool = messages(body)[4]?.content[1]?.toolResult as { content: { text: string }[] };
        const listing =
            '[1] [memory] id=a trust=[labeled]\nUser stated: set this config\n{"source":"api"}';
        (tool.content[0] as { text: string }).text = listing;
        transformFor("d").apply(body, inputs());
        expect(result(body, 1)).toBe('[1] [memory] id=a\nset this config\n{"source":"api"}');
    });

    test("keeps every line in place when rejoined", () => {
        const t = "head\n\n[1] [memory] a\nbody\n\n[2] [memory] b\nbody\n\ntrailer";
        const segments = splitListing(t);
        expect(segments.filter((s) => "item" in s)).toEqual([
            { item: ["[1] [memory] a", "body"] },
            { item: ["[2] [memory] b", "body"] },
        ]);
        expect(joinListing(segments)).toBe(t);
    });

    test("keeps lines between bullets in place when a fragment is dropped", () => {
        const body = recorded();
        const hint = [
            "<eidnara-search-hint>",
            "- first fragment about ports",
            "A line between the fragments.",
            "- second fragment naming 31411",
            "Trailing guidance.",
            "</eidnara-search-hint>",
        ].join("\n");
        body.messages = [{ role: "user", content: [{ text: `${PROBE}\n\n${hint}` }] }];
        const gt = { present: [["31411"]], stale: [], absent: [] };
        transformFor("c").apply(body, inputs({ ground_truth: gt }));
        expect(text(body, 0)).toBe(
            [
                PROBE,
                "",
                "<eidnara-search-hint>",
                "A line between the fragments.",
                "- second fragment naming 31411",
                "Trailing guidance.",
                "</eidnara-search-hint>",
            ].join("\n"),
        );
    });

    test("keeps text after a numbered listing when its last item is dropped", () => {
        const body = recorded();
        const listing = [
            "Found 2 results:",
            "",
            "[1] [memory] id=a",
            "port 31411",
            "",
            "[2] [memory] id=b",
            "something else",
            "",
            "Refine the query for more.",
        ].join("\n");
        const tool = messages(body)[4]?.content[1]?.toolResult as { content: { text: string }[] };
        (tool.content[0] as { text: string }).text = listing;
        const gt = { present: [["31411"]], stale: [], absent: [] };
        transformFor("c").apply(body, inputs({ ground_truth: gt }));
        expect(result(body, 1)).toBe(
            [
                "Found 1 results:",
                "",
                "[1] [memory] id=a",
                "port 31411",
                "",
                "Refine the query for more.",
            ].join("\n"),
        );
    });

    test("records a tagged block whose shape holds no listing as unparsed", () => {
        const body = recorded();
        body.system = [
            { text: "<project-memory>\n[conventions]\nmem_1: a rule\n</project-memory>" },
        ];
        const applied = transformFor("c").apply(body, inputs());
        expect(applied.detail.unparsed).toEqual(["project-memory", "eidnara_note"]);
        expect(body.system).toEqual([
            { text: "<project-memory>\n[conventions]\nmem_1: a rule\n</project-memory>" },
        ]);
    });
});

describe("caution, notice, and memory-block variants", () => {
    const withListing = (listing: string) => {
        const body = recorded();
        const tool = messages(body)[4]?.content[1]?.toolResult as { content: { text: string }[] };
        (tool.content[0] as { text: string }).text = listing;
        return body;
    };

    test("drop-competing-caution drops unsupported caution items and keeps user statements", () => {
        const listing = [
            "Found 3 results:",
            "",
            "[1] [memory] id=a",
            "Assistant reported: We are still waiting on the user to pick a limit.",
            "",
            "[2] [memory] id=b",
            "User stated: ask before you change the limit.",
            "",
            "[3] [memory] id=c",
            "Assistant reported: The cache module lives in src/cache.ts.",
        ].join("\n");
        const body = withListing(listing);
        const gt = { present: [["absent-literal"]], stale: [], absent: [] };
        const applied = transformFor("c2").apply(body, inputs({ ground_truth: gt }));
        expect(applied.changed).toBe(true);
        expect(result(body, 1)).toBe(
            [
                "Found 2 results:",
                "",
                "[1] [memory] id=b",
                "User stated: ask before you change the limit.",
                "",
                "[2] [memory] id=c",
                "Assistant reported: The cache module lives in src/cache.ts.",
            ].join("\n"),
        );
        expect((applied.detail.slots as unknown[])[0]).toEqual({
            slot: "eidnara_search",
            items: 3,
            dropped: 1,
            supporting: false,
            caution_dropped: 1,
            caution_sentences: 0,
        });
        const plain = withListing(listing);
        expect(transformFor("c").apply(plain, inputs({ ground_truth: gt })).changed).toBe(false);
    });

    test("drop-competing-caution strips caution sentences that carry no ground-truth literal", () => {
        const record = '{"anchor":"a","citation":"c","quote":"q","source":"memory_capture"}';
        const body = withListing(
            [
                "Found 2 results:",
                "",
                "[1] [memory] id=a",
                "Assistant reported: The limit is 31411. Don't deploy against it yet; it is unconfirmed 31411.",
                record,
                "",
                "[2] [memory] id=b",
                "Assistant reported: an unrelated note.",
            ].join("\n"),
        );
        const gt = { present: [["31411"]], stale: [], absent: [] };
        const applied = transformFor("c2").apply(body, inputs({ ground_truth: gt }));
        expect(result(body, 1)).toBe(
            [
                "Found 1 results:",
                "",
                "[1] [memory] id=a",
                "Assistant reported: The limit is 31411. it is unconfirmed 31411.",
                record,
                "",
            ].join("\n"),
        );
        expect((applied.detail.slots as Record<string, unknown>[])[0]?.caution_sentences).toBe(1);
    });

    test("drop-competing-caution matches caution wording at word boundaries", () => {
        const body = withListing(
            [
                "Found 2 results:",
                "",
                "[1] [memory] id=a",
                "Assistant reported: Mask your API key; complete the task before deployment.",
                "",
                "[2] [memory] id=b",
                "Assistant reported: The limit is still open.",
            ].join("\n"),
        );
        const gt = { present: [["absent-literal"]], stale: [], absent: [] };
        transformFor("c2").apply(body, inputs({ ground_truth: gt }));
        expect(result(body, 1)).toBe(
            [
                "Found 1 results:",
                "",
                "[1] [memory] id=a",
                "Assistant reported: Mask your API key; complete the task before deployment.",
                "",
            ].join("\n"),
        );
    });

    test("provenance-notices-off removes notice lines from a result with no hits", () => {
        const notices = [
            "\u00a79\u00a7 Memory: the fused search route is unavailable (disabled).",
            "Memory: Memory freshness cannot be judged because no consumer is registered.",
            "",
            'Found 0 results for "alias".',
        ].join("\n");
        const body = withListing(notices);
        const applied = transformFor("d2").apply(body, inputs());
        expect(applied.changed).toBe(true);
        expect(result(body, 1)).toBe('\u00a79\u00a7\n\nFound 0 results for "alias".');
        const d = withListing(notices);
        expect(transformFor("d").apply(d, inputs()).changed).toBe(false);
    });

    test("provenance-notices-off also removes the daemon's Memory: notice lines", () => {
        const body = recorded();
        const applied = transformFor("d2").apply(body, inputs());
        expect(applied.detail).toEqual({
            trust: 6,
            attribution: 4,
            records: 4,
            notices: 2,
            unparsed: ["eidnara_note"],
        });
        const search = result(body, 1);
        expect(search.startsWith("§4§\n")).toBe(true);
        expect(search).not.toContain("Memory:");
        const d = recorded();
        transformFor("d").apply(d, inputs());
        expect(result(d, 1)).toContain("Memory: Memory freshness cannot be judged");
    });

    test("provenance-notices-off leaves Memory: lines outside eidnara_search results", () => {
        const body = recorded();
        const note = "<project-note>\n- first\nMemory: a remembered line\n</project-note>";
        (messages(body)[0]?.content[0] as { text: string }).text = note;
        transformFor("d2").apply(body, inputs());
        expect(text(body, 0)).toBe(note);
        expect(result(body, 1)).not.toContain("Memory:");
    });

    test("memory-block appends the block to the m0 region and needs one", () => {
        const body = recorded();
        const applied = transformFor("f").apply(body, inputs());
        expect(applied.changed).toBe(true);
        expect(text(body, 0)).toBe(
            `<session-history></session-history>\n\n${inputs().project_memory as string}`,
        );
        expect(messages(body).slice(1)).toEqual(messages(recorded()).slice(1));
        const again = transformFor("f").apply(body, inputs());
        expect(again).toEqual({
            changed: false,
            detail: { reason: "m0 region holds a project-memory block" },
        });
        const bare = recorded();
        (messages(bare)[0]?.content[0] as { text: string }).text = "hello";
        expect(transformFor("f").apply(bare, inputs())).toEqual({
            changed: false,
            detail: { reason: "no m0 region" },
        });
        expect(transformFor("f").apply(recorded(), inputs({ project_memory: null }))).toEqual({
            changed: false,
            detail: { reason: "no sources" },
        });
    });
});

describe("memory-block-origin", () => {
    test("groups rows by the origin of their source, project rules first", () => {
        const events = [
            { id: "e-1", kind: "user_turn", text: "The alias is yonder-yak-52." },
            { id: "e-2", kind: "apply_diff", path: "a.md", content: "rule\n" },
        ];
        const block = projectMemoryBlock(events, ["e-1", "e-2"], originCategory) as string;
        const tags = block.split("\n").filter((l) => /^<\/?[A-Z_]+>$/.test(l));
        expect(tags).toEqual([
            "<PROJECT_RULES>",
            "</PROJECT_RULES>",
            "<USER_DIRECTIVES>",
            "</USER_DIRECTIVES>",
        ]);
        expect(block).toMatch(
            /<PROJECT_RULES>\nmem_[0-9a-f]{32}: a\.md was committed with:\n {2}rule\n<\/PROJECT_RULES>/,
        );
    });

    test("renders categories in the daemon's order with each category's rows together", () => {
        const events = [
            { id: "e-1", kind: "user_turn", text: "one" },
            { id: "e-2", kind: "user_turn", text: "two" },
            { id: "e-3", kind: "user_turn", text: "three" },
            { id: "e-4", kind: "apply_diff", path: "gone.md", remove: true },
        ];
        const category: Record<string, string> = {
            "e-1": "CONFIG_VALUES",
            "e-2": "CONSTRAINTS",
            "e-3": "CONFIG_VALUES",
            "e-4": "USER_DIRECTIVES",
        };
        const block = projectMemoryBlock(
            events,
            ["e-1", "e-2", "e-3", "e-4"],
            (e) => category[String(e.id)] as string,
        ) as string;
        const lines = block.split("\n");
        expect(lines.filter((l) => /^<\/?[A-Z_]+>$/.test(l))).toEqual([
            "<CONSTRAINTS>",
            "</CONSTRAINTS>",
            "<CONFIG_VALUES>",
            "</CONFIG_VALUES>",
            "<USER_DIRECTIVES>",
            "</USER_DIRECTIVES>",
        ]);
        const config = lines.slice(
            lines.indexOf("<CONFIG_VALUES>") + 1,
            lines.indexOf("</CONFIG_VALUES>"),
        );
        expect(config).toHaveLength(2);
        expect(config).toEqual([...config].sort());
        expect(originCategory(events[3] as Record<string, unknown>)).toBe("PROJECT_RULES");
        expect(originCategory(events[0] as Record<string, unknown>)).toBe("USER_DIRECTIVES");
    });

    test("f2 appends the origin block to the m0 region", () => {
        const body = recorded();
        expect(transformFor("f2").apply(body, inputs()).changed).toBe(true);
        expect(text(body, 0)).toBe(
            `<session-history></session-history>\n\n${inputs().origin_memory as string}`,
        );
    });
});

describe("caution-off", () => {
    const withListing = (listing: string) => {
        const body = recorded();
        const tool = messages(body)[4]?.content[1]?.toolResult as { content: { text: string }[] };
        (tool.content[0] as { text: string }).text = listing;
        return body;
    };
    const record = '{"anchor":"a","citation":"c","quote":"q","source":"memory_capture"}';

    test("strips caution sentences from assistant items, drops emptied ones, keeps user statements", () => {
        const body = withListing(
            [
                "Found 3 results:",
                "",
                "[1] [memory] id=a",
                "Assistant reported: The limit is 31411. Don't deploy against it yet.",
                record,
                "",
                "[2] [memory] id=b",
                "Assistant reported: We are still waiting on the user to pick a limit.",
                "",
                "[3] [memory] id=c",
                "User stated: ask before you change the limit.",
                record,
            ].join("\n"),
        );
        const applied = transformFor("c3").apply(body, inputs());
        expect(applied).toEqual({
            changed: true,
            detail: { items: 2, sentences: 2, dropped: 1, unparsed: ["eidnara_note"] },
        });
        expect(result(body, 1)).toBe(
            [
                "Found 2 results:",
                "",
                "[1] [memory] id=a",
                "Assistant reported: The limit is 31411.",
                "",
                "[2] [memory] id=c",
                "User stated: ask before you change the limit.",
                record,
            ].join("\n"),
        );
    });

    test("splits after closing quotes, keeps the attribution, and reads no ground truth", () => {
        const payload =
            '{"anchor":"north","citation":"manual","quote":"literal config","source":"api"}';
        const body = withListing(
            [
                "Found 1 results:",
                "",
                "[1] [memory] id=a",
                'Assistant reported: Still pending. The warning was "Don\'t deploy." The port is 31411.',
                payload,
                "The limit 31411 is unconfirmed.",
                record,
            ].join("\n"),
        );
        const gt = { present: [["31411"]], stale: [], absent: [] };
        transformFor("c3").apply(body, inputs({ ground_truth: gt }));
        expect(result(body, 1)).toBe(
            [
                "Found 1 results:",
                "",
                "[1] [memory] id=a",
                "Assistant reported: The port is 31411.",
                payload,
            ].join("\n"),
        );
    });

    test("leaves bullet lines of an eidnara_note result alone", () => {
        const body = withListing(
            "\u00a73\u00a7 ## Notes\n\n- Ask before changing production.\n- Port 31411.",
        );
        const before = result(body, 1);
        const applied = transformFor("c3").apply(body, inputs());
        expect(result(body, 1)).toBe(before);
        expect(applied.changed).toBe(false);
    });

    test("trims a search-hint fragment and leaves a listing without caution unchanged", () => {
        const hint = hinted();
        const before = JSON.stringify(hint);
        expect(transformFor("c3").apply(hint, inputs()).changed).toBe(false);
        expect(JSON.stringify(hint)).toBe(before);
        const body = recorded();
        const hintBlock = (lines: string[]) =>
            ["<eidnara-search-hint>", ...lines, "</eidnara-search-hint>"].join("\n");
        (messages(body)[0]?.content[0] as { text: string }).text = hintBlock([
            "Your memory may contain 2 related fragments:",
            "- Still pending. the port is 31411.",
            "- unrelated",
        ]);
        transformFor("c3").apply(body, inputs());
        expect(text(body, 0)).toBe(
            hintBlock([
                "Your memory may contain 2 related fragments:",
                "- the port is 31411.",
                "- unrelated",
            ]),
        );
    });
});
