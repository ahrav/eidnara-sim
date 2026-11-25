import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    ARM,
    daemonAt,
    JUMP_MS,
    ROWS,
    reviewerRun,
    reviewerScenario,
    WALL0,
} from "../../tests/reviewer-run";
import { RequestPartLog, rebuildRequest } from "../proxy/requests";
import { CallLog } from "../run/calllog";
import { type Entry, readJsonl } from "../run/journal";
import { daemonClock, leftAutomatic, readChanges } from "./changes";
import { deliveredAt, factTimeline, inForceReading, literalReading, statementOf } from "./truth";
import {
    blindText,
    changeView,
    clip,
    parseReferences,
    readConversation,
    requestOf,
    reviewRequests,
    scenarioRecord,
    VIEW_LIMITS,
} from "./view";

const dir = reviewerRun();
const scenario = reviewerScenario();
const entries = readJsonl<Entry>(join(dir, "journal.jsonl"));
const clock = daemonClock(entries, ARM, WALL0);
const delivered = deliveredAt(entries, ARM);
const changes = readChanges(join(dir, ARM, "final-store")) ?? [];
const byRow = (name: keyof typeof ROWS) => {
    const change = changes.find((c) => c.target === ROWS[name].id);
    if (!change) throw new Error(`no change for ${name}`);
    return change;
};

describe("the reviewer's changes in the final store", () => {
    test("each dispute names its target, job, writer kind, and the passages its proposal cites; a standing statement and an unchanged settlement are no change", () => {
        expect(changes.map((c) => [c.kind, c.target, c.job, c.target_kind])).toEqual([
            ["disputed", "mem_plan", ROWS.plan.job, "user statement"],
            ["disputed", "mem_question", ROWS.question.job, "assistant report"],
            ["disputed", "mem_note", ROWS.note.job, "agent note"],
            ["disputed", "mem_tag0", ROWS.tag.job, "user statement"],
        ]);
        const plan = byRow("plan");
        expect(plan.text).toBe(ROWS.plan.text);
        expect(plan.project).toBe("elysia");
        expect(plan.proposal).toEqual({
            action: "retire",
            new_text: null,
            contradictions: [{ alias: "ref-3", start: 0, end: Buffer.byteLength(ROWS.plan.cited) }],
        });
        expect(plan.recorded_ms).toBe(daemonAt(52));
        expect(plan.stored_ms).toBe(daemonAt(21));
    });

    test("delivery is read from the admission decisions: a dispute of an automatic row takes it out, a dispute of a search-only row changes nothing", () => {
        expect(byRow("plan").delivery).toEqual({ before: "automatic", after: "explicit_labeled" });
        expect(leftAutomatic(byRow("plan"))).toBe(true);
        expect(byRow("question").delivery).toEqual({
            before: "explicit_labeled",
            after: "explicit_labeled",
        });
        expect(leftAutomatic(byRow("question"))).toBe(false);
        // An agent note of a user's rule is a user statement that was never delivered automatically.
        expect(byRow("note").user_statement).toBe(true);
        expect(leftAutomatic(byRow("note"))).toBe(false);
    });

    test("an absent store reads as null", () => {
        expect(readChanges(join(dir, "nowhere"))).toBeNull();
    });

    test("the daemon's clock maps through the journal's offsets in both directions", () => {
        expect(clock.real(daemonAt(52))).toBe(WALL0 + 52_000);
        expect(clock.daemon(WALL0 + 52_000)).toBe(WALL0 + 52_000 + JUMP_MS);
        expect(clock.daemon(WALL0 + 5_000)).toBe(WALL0 + 5_000);
        expect(clock.scenario(daemonAt(52))).toBe(152_000);
        expect(daemonClock([], ARM, WALL0).scenario(WALL0 + 7)).toBe(7);
        expect(daemonClock([], ARM, null).scenario(WALL0 + 7)).toBeNull();
    });
});

describe("the registered literal rule (R1.v1)", () => {
    const timeline = factTimeline(scenario);
    const reading = (name: keyof typeof ROWS) => {
        const change = byRow(name);
        return literalReading(change.text, clock.scenario(change.recorded_ms), timeline).verdict;
    };

    test("a superseded value alone reads right, and a value in force reads wrong whatever the row claims", () => {
        expect(reading("tag")).toBe("right");
        // The row is a question the commit answered; its tag is in force, so the rule reads wrong.
        expect(reading("question")).toBe("wrong");
        // The user closed the plan in a sentence without a literal, so the rule keeps the probe's truth.
        expect(reading("plan")).toBe("wrong");
    });

    test("a row with the value in force and the value it replaced has no truth, and so has a row without a literal or a time", () => {
        expect(reading("note")).toBe("no truth");
        expect(
            literalReading("Assistant reported: the build passes.", 152_000, timeline).verdict,
        ).toBe("no truth");
        expect(literalReading(ROWS.tag.text, null, timeline).verdict).toBe("no truth");
    });

    test("wrong wins over right across lines, and a literal matches inside a longer word", () => {
        const both = literalReading("uses [amber_fox] and the alpha_item field", 152_000, timeline);
        expect(both.lines.map((l) => [l.line, l.verdict])).toEqual([
            ["elysia/commit-tag", "right"],
            ["elysia/plan", "wrong"],
        ]);
        expect(both.verdict).toBe("wrong");
        expect(literalReading("the alpha_items table", 152_000, timeline).verdict).toBe("wrong");
    });

    test("before the replacing statement the first value is in force", () => {
        expect(literalReading(ROWS.tag.text, 3_500, timeline).verdict).toBe("wrong");
    });
});

describe("whether the scenario holds a user statement in force", () => {
    const at = (s: number) => WALL0 + s * 1_000;
    const read = (text: string, s: number) => inForceReading(text, at(s), scenario, delivered);

    test("a plan is in force until the user closes it in a sentence that names none of its items", () => {
        expect(read(ROWS.plan.text, 49).reading).toBe("in force");
        const closed = read(ROWS.plan.text, 52);
        expect(closed.reading).toBe("ended");
        expect(closed.statements[0]?.ended).toEqual([{ by: "plan completed", event: "e-4" }]);
    });

    test("a statement ends when the arm receives a later fact of its line, by the journal and not by the scheduled time", () => {
        // The replacing statement is scheduled at scenario second 5 and reached the arm at wall second 70.
        expect(read(ROWS.tag.text, 69).reading).toBe("in force");
        expect(read(ROWS.tag.text, 78).statements[0]?.ended).toEqual([
            { by: "superseded", event: "e-5" },
        ]);
    });

    test("a note that restates the statement in force is in force, and names the value it replaced", () => {
        const note = read(ROWS.note.text, 76);
        expect(note.reading).toBe("in force");
        expect(note.statements.map((s) => [s.event, s.fact, s.states])).toEqual([
            ["e-5", "f-tag1", true],
        ]);
    });

    test("a row the scenario scripts no statement for reads so", () => {
        expect(read("User stated: Drop the error-path tracing for now.", 78).reading).toBe(
            "no scenario statement",
        );
    });

    test("a request that carries a fact's file states no fact, a scoped update leaves its rule in force, and a later statement of the same fact ends a first value", () => {
        const base = {
            project: "p",
            manner: "correction",
            basis: "instruction",
            template: "t",
            supersedes: null,
            revision: 0,
        } as const;
        const custom = {
            ...scenario,
            facts: [
                {
                    ...base,
                    id: "f-err",
                    kind: "tool_error",
                    line: "p/err",
                    statement: "the replay check fails with AmberError",
                    cues: ["Run `sh check.sh` and tell me what it reports."],
                },
                {
                    ...base,
                    id: "f-scope",
                    kind: "scoped_update",
                    line: "p/quotes",
                    statement: "string literals use single quotes",
                    cues: [
                        "For the record, string literals use single quotes.",
                        "One change: inside src/ws only, use double quotes.",
                    ],
                },
                {
                    ...base,
                    id: "f-limit",
                    kind: "decision",
                    line: "p/limit",
                    statement: "the limit is 200 bytes",
                    cues: [
                        "For the record, the limit is 100 bytes.",
                        "Scratch what I said earlier: the limit is 200 bytes.",
                    ],
                },
            ],
            events: [
                {
                    id: "x-1",
                    kind: "user_turn",
                    role: "conveyance",
                    text: "I added notes.md.\n\nRun `sh check.sh` and tell me what it reports.",
                    facts: ["f-err"],
                },
                {
                    id: "x-2",
                    kind: "user_turn",
                    role: "conveyance",
                    text: "For the record, string literals use single quotes.",
                    fact: "f-scope",
                },
                {
                    id: "x-3",
                    kind: "user_turn",
                    role: "update",
                    text: "One change: inside src/ws only, use double quotes.",
                    fact: "f-scope",
                },
                {
                    id: "x-4",
                    kind: "user_turn",
                    role: "reversal",
                    text: "For the record, the limit is 100 bytes.",
                    fact: "f-limit",
                },
                {
                    id: "x-5",
                    kind: "user_turn",
                    role: "conveyance",
                    text: "Scratch what I said earlier: the limit is 200 bytes.",
                    fact: "f-limit",
                },
            ],
            plans: [],
        };
        const when = new Map(custom.events.map((e, i) => [e.id, at(i)]));
        const custom_read = (text: string) => inForceReading(text, at(60), custom, when).reading;
        expect(custom_read("User stated: Run `sh check.sh` and tell me what it reports.")).toBe(
            "states no fact",
        );
        expect(custom_read("User stated: For the record, string literals use single quotes.")).toBe(
            "in force",
        );
        expect(custom_read("User stated: One change: inside src/ws only, use double quotes.")).toBe(
            "in force",
        );
        expect(custom_read("User stated: For the record, the limit is 100 bytes.")).toBe("ended");
        expect(
            custom_read("User stated: Scratch what I said earlier: the limit is 200 bytes."),
        ).toBe("in force");
    });

    test("a statement is the row's text without its opening and its recorded minute", () => {
        expect(
            statementOf("User stated (2026-11-25): Plan for next time. [2026-11-25T10:00Z]"),
        ).toBe("Plan for next time.");
    });
});

describe("the labeller's view", () => {
    const calls = new CallLog(join(dir, "calls.jsonl"));
    const parts = new RequestPartLog(join(dir, "requests.jsonl"));
    const requests = reviewRequests(
        calls.calls,
        (p) => {
            const ref = calls.request(p);
            return ref && rebuildRequest(ref, parts);
        },
        ARM,
    );
    const conversation = readConversation(
        join(dir, ARM, "r", "home", ".pi", "agent", "sessions"),
        join(dir, ARM),
    );
    const runName = dir.split("/").at(-1) as string;
    const view = (name: keyof typeof ROWS) => {
        const change = byRow(name);
        return changeView({
            change,
            request: requestOf(change, requests, clock),
            conversation,
            scenario,
            delivered,
            clock,
            runName,
        });
    };

    test("a stage-2 request yields each reference with its writer, time, and relation", () => {
        expect(requests).toHaveLength(4);
        const plan = requestOf(byRow("plan"), requests, clock);
        expect(plan?.memory).toBe(ROWS.plan.text);
        expect(plan?.references.get("ref-2")).toMatchObject({
            writer: "user",
            relation: "source",
            at_ms: daemonAt(20),
        });
        expect(plan?.references.get("ref-3")).toMatchObject({
            writer: "user",
            relation: "later",
            at_ms: daemonAt(50),
            text: ROWS.plan.cited,
        });
        expect(
            requestOf(byRow("question"), requests, clock)?.references.get("ref-3"),
        ).toMatchObject({ writer: "tool", at_ms: null });
        expect(parseReferences("no markers")).toBeNull();
    });

    test("a change takes the last request for its memory that ended by its commit and holds its cited aliases", () => {
        const change = byRow("plan");
        const first = requests.find((r) => r.memory === change.text);
        if (!first) throw new Error("no request");
        const later = { ...first, seq: 99, ended_wall_ms: first.ended_wall_ms + 60_000 };
        const other = { ...first, seq: 98, references: new Map() };
        expect(requestOf(change, [first, later, other], clock)?.seq).toBe(first.seq);
        expect(requestOf({ ...change, text: "another row" }, requests, clock)).toBeNull();
    });

    test("the view states the row with its writer and times, the change, the cited source, the conversation up to the change, and the scenario's record", () => {
        const text = view("plan");
        expect(text).toContain("Writer kind: user statement");
        expect(text).toContain(
            `Captured from: a message the user wrote at ${new Date(daemonAt(20)).toISOString().slice(0, 19)}Z`,
        );
        expect(text).toContain("Kind: dispute (the whole row is marked disputed)");
        expect(text).toContain("CITED LATER SOURCE 1 of 1\nWriter: user message");
        expect(text).toContain(`<<<\n${ROWS.plan.cited}\n>>>`);
        expect(text).toContain(
            "USER: Let's set both of those open items aside and consider them closed.",
        );
        expect(text).toContain(
            "the user closed the plan (plan completed): Let's set both of those open items aside",
        );
        // Nothing written after the change reaches the view.
        expect(text).not.toContain("consider them closed.\n[");
        expect(text).not.toContain("A message written after every change.");
        expect(text).not.toContain("[main 7e66a10]");
    });

    test("an uncited note's conversation starts before the note, so the message it was written from shows, and the scenario record marks the replacement", () => {
        const text = view("note");
        expect(text).toContain("Writer kind: agent note\nCaptured from: no source recorded");
        expect(text).toContain(
            `USER: Quick correction before you carry on: every commit message starts with [brisk_owl].`,
        );
        expect(text).toContain("the user stated (replaces the earlier statement on this subject)");
        expect(view("question")).toContain("Time: the host records none for a tool output");
    });

    test("the view names no run, arm, or run path", () => {
        const all = (Object.keys(ROWS) as (keyof typeof ROWS)[]).map(view).join("\n");
        expect(all).not.toContain(runName);
        expect(all).not.toContain("eidnara");
        expect(all).toContain("1 file changed in /workspaces/elysia/src");
        expect(
            blindText(
                `cd /a/b/${runName}/eidnara-reviewer/r/workspaces/x; eidnara_search <<<<`,
                runName,
            ),
        ).toBe("cd /workspaces/x; memtool_search < < < <");
    });

    test("a long text keeps its start and end around a marked cut, and a long conversation keeps its ends and the user's messages between", () => {
        const cut = clip("a".repeat(70) + "b".repeat(30), 10);
        expect(cut).toBe(`${"a".repeat(7)} [... 90 characters cut ...] ${"b".repeat(3)}`);
        const long = Array.from({ length: 60 }, (_, i) => ({
            at_ms: daemonAt(22) + i,
            session: "s-1",
            speaker: i === 30 ? ("user" as const) : ("assistant" as const),
            text: i === 30 ? "the user's word in the middle" : `report ${i} ${"x".repeat(1_700)}`,
        }));
        const change = byRow("plan");
        const text = changeView({
            change,
            request: requestOf(change, requests, clock),
            conversation: long,
            scenario,
            delivered,
            clock,
            runName,
        });
        expect(text).toContain("report 0 ");
        expect(text).toContain("report 59 ");
        expect(text).toContain("USER: the user's word in the middle");
        expect(text).toMatch(
            /\[\.\.\. \d+ entries cut; the user's messages among them follow, shortened \.\.\.\]/,
        );
        expect(text.length).toBeLessThan(VIEW_LIMITS.conversation + 12_000);
    });

    test("the scenario record of a row without a scripted subject says so, and a host without transcripts reads as not recorded", () => {
        expect(
            scenarioRecord(
                "Assistant reported: the build passes.",
                WALL0 + 90_000,
                scenario,
                delivered,
                clock,
            ),
        ).toStartWith("none");
        const change = byRow("plan");
        const text = changeView({
            change,
            request: null,
            conversation: null,
            scenario,
            delivered,
            clock,
            runName,
        });
        expect(text).toContain("CITED LATER SOURCE\nnone recorded for this change");
        expect(text).toContain("not recorded for this host");
        expect(readConversation(join(dir, ARM, "absent"), join(dir, ARM))).toBeNull();
    });

    test("the fixture's transcript is read in time order with tool calls and outputs", () => {
        expect(conversation?.map((e) => e.speaker)).toEqual([
            "user",
            "assistant",
            "user",
            "assistant",
            "user",
            "tool call",
            "tool output",
            "user",
            "user",
        ]);
        expect(readFileSync(join(dir, "calls.jsonl"), "utf8")).toContain("memory_reviewer_stage2");
    });
});
