import type { Entry } from "../run/journal";
import type { Fact, PlanRecord, ProbeItem } from "../scenario/compile";

/** The scenario fields the reviewer readings use. */
export interface ReviewScenario {
    facts: Fact[];
    events: {
        id: string;
        kind: string;
        role?: string;
        session?: string;
        project?: string;
        scenario_ms?: number;
        text?: string;
        content?: string;
        fact?: string | null;
        facts?: string[];
    }[];
    probes: ProbeItem[];
    sessions: { id: string; project?: string; start_ms?: number }[];
    plans?: PlanRecord[];
}
export type ScenarioEvent = ReviewScenario["events"][number];

const flat = (value: unknown): string[] =>
    typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(flat) : [];
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** An event's text: a user turn's words and a committed file's content. */
export const eventText = (e: ScenarioEvent) => [e.text, e.content].filter((x) => x).join("\n");
/** The facts an event names: its own and the ones it carries beside it. */
export const factsOf = (e: ScenarioEvent): string[] => [
    ...(e.fact ? [e.fact] : []),
    ...(e.facts ?? []).filter((x) => typeof x === "string"),
];

/** One fact line's value literals, the events that carry them, and the ground truth of its probes. */
interface LineValues {
    literals: string[];
    events: { ms: number; event: string; carried: string[] }[];
    probes: { ms: number; probe: string; present: Set<string>; stale: Set<string> }[];
}

/**
 * The value statements of each fact line over scenario time, as the registered R1 reader builds
 * them. A line's value literals are the `present`, `stale` and `absent` literals of the ground
 * truth of the probes on its facts. Its value events are the events of its facts, probe turns
 * aside, whose text carries one of the literals as a substring; a literal none of them carries
 * is dated by the first event of the project that carries it.
 */
export function factTimeline(scenario: ReviewScenario): Map<string, LineValues> {
    const facts = new Map(scenario.facts.map((f) => [f.id, f]));
    const lineOf = (id: string | null | undefined) => (id ? facts.get(id)?.line : undefined);
    const ms = new Map(scenario.events.map((e) => [e.id, e.scenario_ms ?? 0]));
    const lines = new Map<string, LineValues & { found: Set<string>; project?: string }>();
    for (const p of scenario.probes) {
        const line = lineOf(p.fact);
        if (line === undefined) continue;
        const truth = p.ground_truth;
        const present = new Set(flat(truth?.present).filter((x) => x));
        const stale = new Set(flat(truth?.stale).filter((x) => x));
        let g = lines.get(line);
        if (!g) {
            const project = facts.get(p.fact as string)?.project;
            g = { literals: [], events: [], probes: [], found: new Set(), project };
            lines.set(line, g);
        }
        for (const x of [...present, ...stale, ...flat(truth?.absent).filter((x) => x)]) {
            g.found.add(x);
        }
        const at = p.event === undefined ? undefined : ms.get(p.event);
        if (at !== undefined) g.probes.push({ ms: at, probe: p.id, present, stale });
    }
    const sessionProject = new Map(scenario.sessions.map((s) => [s.id, s.project]));
    type Dated = { ms: number; event: string; text: string };
    const byLine = new Map<string, Dated[]>();
    const byProject = new Map<string | undefined, Dated[]>();
    const push = <K>(map: Map<K, Dated[]>, key: K, row: Dated) => {
        const list = map.get(key);
        if (list) list.push(row);
        else map.set(key, [row]);
    };
    for (const e of scenario.events) {
        if (e.kind === "user_turn" && e.role === "probe") continue;
        const text = eventText(e);
        if (!text) continue;
        const row = { ms: ms.get(e.id) ?? 0, event: e.id, text };
        for (const line of new Set(factsOf(e).flatMap((id) => lineOf(id) ?? []))) {
            push(byLine, line, row);
        }
        push(byProject, e.project ?? sessionProject.get(e.session ?? ""), row);
    }
    const inOrder = (a: Dated, b: Dated) => a.ms - b.ms || byCodeUnit(a.event, b.event);
    for (const [line, g] of lines) {
        g.literals = [...g.found].sort(byCodeUnit);
        const found = new Map<string, { ms: number; event: string; carried: string[] }>();
        for (const row of (byLine.get(line) ?? []).sort(inOrder)) {
            const carried = g.literals.filter((x) => row.text.includes(x));
            if (carried.length > 0) found.set(row.event, { ms: row.ms, event: row.event, carried });
        }
        const dated = new Set([...found.values()].flatMap((f) => f.carried));
        const project = (byProject.get(g.project) ?? []).sort(inOrder);
        for (const literal of g.literals.filter((x) => !dated.has(x))) {
            const hit = project.find((row) => row.text.includes(literal));
            if (!hit) continue;
            const carried = [...new Set([...(found.get(hit.event)?.carried ?? []), literal])];
            found.set(hit.event, {
                ms: hit.ms,
                event: hit.event,
                carried: carried.sort(byCodeUnit),
            });
        }
        g.events = [...found.values()].sort((a, b) => a.ms - b.ms || byCodeUnit(a.event, b.event));
        g.probes.sort((a, b) => a.ms - b.ms || byCodeUnit(a.probe, b.probe));
    }
    return lines;
}

/** The index of a line's last value event at or before `atMs`; -1 before the first. */
const epoch = (g: LineValues, atMs: number): number =>
    g.events.reduce((k, e, i) => (e.ms <= atMs ? i : k), -1);

/**
 * A literal's status at a time. The ground truth of a probe of the line that lies between the
 * same two value events decides: `in force` when it lists the literal as present, `superseded`
 * as stale, `both` when two probes disagree. With no such probe the value events decide: `in
 * force` when only the last one carries the literal, `superseded` when an earlier one carries it
 * and the last one leaves it out, `unclear` when both do, `not stated` when none does.
 */
function literalStatus(g: LineValues, literal: string, atMs: number): [string, string] {
    const k = epoch(g, atMs);
    const said = new Set<string>();
    for (const p of g.probes) {
        if (epoch(g, p.ms) !== k) continue;
        if (p.present.has(literal)) said.add("in force");
        if (p.stale.has(literal)) said.add("superseded");
    }
    if (said.size > 0)
        return [said.size === 2 ? "both" : ([...said][0] ?? ""), "probe ground truth"];
    const carriers = g.events
        .slice(0, k + 1)
        .flatMap((e, i) => (e.carried.includes(literal) ? [i] : []));
    const status =
        carriers.length === 0
            ? "not stated"
            : carriers.at(-1) !== k
              ? "superseded"
              : carriers.length === 1
                ? "in force"
                : "unclear";
    return [status, "value events"];
}

export type LiteralVerdict = "right" | "wrong" | "no truth";
export interface LiteralReading {
    verdict: LiteralVerdict;
    lines: {
        line: string;
        in_force: string[];
        superseded: string[];
        other: string[];
        basis: string[];
        verdict: LiteralVerdict;
    }[];
}

/**
 * The registered R1 rule (`target-literal-status`): a change is read by the value literals of
 * the scenario's fact lines that stand in its target's text as substrings. Per line, superseded
 * literals alone read `right`, in-force literals alone `wrong`, anything else `no truth`. The
 * change is `wrong` when any line reads wrong, else `right` when any reads right, else `no
 * truth`.
 */
export function literalReading(
    text: string,
    atMs: number | null,
    timeline: Map<string, LineValues>,
): LiteralReading {
    if (atMs === null) return { verdict: "no truth", lines: [] };
    const lines: LiteralReading["lines"] = [];
    for (const [line, g] of [...timeline].sort(([a], [b]) => byCodeUnit(a, b))) {
        const hit = { in_force: [] as string[], superseded: [] as string[], other: [] as string[] };
        const basis = new Set<string>();
        for (const literal of g.literals) {
            if (!text.includes(literal)) continue;
            const [status, from] = literalStatus(g, literal, atMs);
            if (status === "in force" || status === "both") hit.in_force.push(literal);
            if (status === "superseded" || status === "both") hit.superseded.push(literal);
            if (status === "unclear" || status === "not stated")
                hit.other.push(`${literal} (${status})`);
            basis.add(from);
        }
        if (hit.in_force.length + hit.superseded.length + hit.other.length === 0) continue;
        const verdict: LiteralVerdict =
            hit.superseded.length > 0 && hit.in_force.length === 0
                ? "right"
                : hit.in_force.length > 0 && hit.superseded.length === 0
                  ? "wrong"
                  : "no truth";
        lines.push({ line, ...hit, basis: [...basis].sort(byCodeUnit), verdict });
    }
    const verdicts = new Set(lines.map((l) => l.verdict));
    return {
        verdict: verdicts.has("wrong") ? "wrong" : verdicts.has("right") ? "right" : "no truth",
        lines,
    };
}

const squeeze = (text: string) => text.replace(/\s+/g, " ").trim();
const paragraphs = (text: string) =>
    text
        .split(/\n\s*\n/)
        .map(squeeze)
        .filter((p) => p !== "");

/** A memory's statement: its text without the `User stated` opening and a closing recorded minute. */
export const statementOf = (text: string): string =>
    squeeze(
        text
            .replace(/^(?:User stated|Assistant reported)(?: \([^)]*\))?:\s*/, "")
            .replace(/\s*\[\d{4}-\d\d-\d\dT[\d:]+Z\]\s*$/, ""),
    );

/**
 * The wall time each scenario event reached the arm, from its journal: a user turn at its
 * `BeginTurn`, any other event at its `Event` entry with outcome `ok`.
 */
export function deliveredAt(entries: readonly Entry[], arm: string): Map<string, number> {
    const out = new Map<string, number>();
    for (const e of entries) {
        if (e.arm !== arm || typeof e.event !== "string" || out.has(e.event)) continue;
        if (e.kind === "BeginTurn" || (e.kind === "Event" && e.outcome === "ok")) {
            out.set(e.event, e.wall_ms);
        }
    }
    return out;
}

/** One scenario statement a memory restates, and what the scenario's records say ended it. */
export interface ScenarioStatement {
    event: string;
    role: string;
    fact: string;
    line: string;
    /** Whether the matched text states the fact or a value of its line; a request that only carries the fact's file states none. */
    states: boolean;
    /** The scenario records that ended the statement by the time of the change. */
    ended: { by: "superseded" | "plan revised" | "plan completed" | "restated"; event: string }[];
}

export type InForce = "in force" | "ended" | "states no fact" | "no scenario statement";

/**
 * The scenario records that ended the statement event `e` makes of `fact`, among the events the
 * arm had received (`reached`): a fact of the same line with a higher revision, a later step of
 * the fact's plan record with status `revised` or `completed`, and a later statement or committed
 * file of the same fact, a scoped update aside.
 */
function endedBy(
    fact: Fact,
    e: ScenarioEvent,
    scenario: ReviewScenario,
    delivered: Map<string, number>,
    reached: (event: string) => boolean,
): ScenarioStatement["ended"] {
    const ended: ScenarioStatement["ended"] = [];
    for (const later of scenario.facts) {
        if (later.line !== fact.line || later.revision <= fact.revision) continue;
        const by = scenario.events.find(
            (x) => factsOf(x).includes(later.id) && x.role !== "probe" && reached(x.id),
        );
        if (by) ended.push({ by: "superseded", event: by.id });
    }
    const history = scenario.plans?.find((p) => p.fact === fact.id)?.history ?? [];
    const step = history.findIndex((h) => h.event === e.id);
    for (const h of history.slice(step + 1)) {
        if (h.status !== "accepted" && reached(h.event)) {
            ended.push({ by: `plan ${h.status}`, event: h.event });
        }
    }
    if (fact.kind === "scoped_update") return ended;
    const from = delivered.get(e.id) ?? 0;
    for (const x of scenario.events) {
        const restates = x.kind === "apply_diff" || x.role === "conveyance" || x.role === "update";
        if (
            x.id !== e.id &&
            restates &&
            factsOf(x).includes(fact.id) &&
            reached(x.id) &&
            (delivered.get(x.id) ?? 0) > from
        ) {
            ended.push({ by: "restated", event: x.id });
        }
    }
    return ended;
}

/**
 * Whether the scenario holds a memory's statement in force at wall time `atWallMs`, by the
 * scenario's own records. The memory restates a scenario statement when a paragraph of a user
 * turn that conveys, updates, or first states a fact contains the memory's statement or is
 * contained in it, or when the memory's statement contains the fact's statement. The statement is
 * ended once the arm received (`delivered`) one of: an event of a fact of the same line with a
 * higher revision (the supersession record); a later step of the fact's plan record with status
 * `revised` or `completed` (a closing turn names no value); or a later statement or committed
 * file of the same fact, a scoped update aside, which adds an exception and leaves the rule in
 * force. A matched turn that only asks for a file to be read or a script to be run states no
 * fact.
 */
export function inForceReading(
    text: string,
    atWallMs: number,
    scenario: ReviewScenario,
    delivered: Map<string, number>,
): { reading: InForce; statements: ScenarioStatement[] } {
    const statement = statementOf(text);
    const lower = statement.toLowerCase();
    const facts = new Map(scenario.facts.map((f) => [f.id, f]));
    const reached = (event: string) => (delivered.get(event) ?? Infinity) <= atWallMs;
    const statements: ScenarioStatement[] = [];
    for (const e of scenario.events) {
        const role = e.role ?? "";
        if (e.kind !== "user_turn" || !["conveyance", "update", "reversal"].includes(role))
            continue;
        if (!reached(e.id)) continue;
        const parts = paragraphs(e.text ?? "");
        for (const id of factsOf(e)) {
            const fact = facts.get(id);
            if (!fact) continue;
            const stated = squeeze(fact.statement).toLowerCase();
            const cues = fact.cues.flatMap(paragraphs);
            const quoted = parts.filter((p) => p.includes(statement) || statement.includes(p));
            // A paragraph belongs to the fact whose cue it is or whose statement it holds.
            const mine = quoted.filter((p) => cues.includes(p) || p.toLowerCase().includes(stated));
            const restated =
                lower.includes(stated) && parts.some((p) => p.toLowerCase().includes(stated));
            if (mine.length === 0 && !restated) continue;
            const states =
                restated ||
                mine.some((p) => p.toLowerCase().includes(stated)) ||
                role === "update" ||
                role === "reversal";
            const ended = endedBy(fact, e, scenario, delivered, reached);
            statements.push({ event: e.id, role, fact: fact.id, line: fact.line, states, ended });
        }
    }
    const stating = statements.filter((s) => s.states);
    const reading: InForce =
        statements.length === 0
            ? "no scenario statement"
            : stating.length === 0
              ? "states no fact"
              : stating.some((s) => s.ended.length === 0)
                ? "in force"
                : "ended";
    return { reading, statements };
}
