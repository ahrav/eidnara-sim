import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { type CdfTable, fitCdf } from "./cdf";
import { cachePath, type Dataset } from "./sources";

export interface Quantity {
    definition: string;
    unit: string;
    source: string;
    n: number;
    cdf: CdfTable;
}

export interface ToolCategory {
    category: string;
    share: number;
    error_rate: number;
    tools: string[];
}

export interface TraceLabFit {
    quantities: Record<string, Quantity>;
    tool_mix: { source: string; n: number; categories: ToolCategory[] };
}

const CATEGORIES: Record<string, string[]> = {
    shell: ["Bash", "exec_command", "write_stdin", "exec", "shell_command", "shell", "wait"],
    read: ["Read", "view_image"],
    edit: ["Edit", "MultiEdit", "Write", "apply_patch", "NotebookEdit"],
    search: ["Grep", "Glob"],
    web: ["WebFetch", "WebSearch"],
    plan: ["TaskCreate", "TaskUpdate", "TodoWrite", "update_plan"],
    agent: ["Agent", "Task", "wait_agent", "spawn_agent"],
};
const TOOL_CATEGORY = new Map(
    Object.entries(CATEGORIES).flatMap(([category, tools]) => tools.map((t) => [t, category])),
);
export const CATEGORY_NAMES: readonly string[] = [...Object.keys(CATEGORIES), "other"].sort();

export const TABLES = {
    requests_per_session: "rounds",
    tool_steps_per_request: "rounds+timing_events",
    append_tokens_per_step: "rounds",
    idle_within_session_s: "rounds+timing_events",
    idle_between_sessions_s: "rounds+timing_events",
    tool_output_chars: "tool_calls",
} as const;

const DEFINITIONS = {
    requests_per_session:
        "Rounds whose first input event is a user message, per session; includes sessions with zero such rounds.",
    tool_steps_per_request:
        "Rounds (LLM invocations) from one user-message round up to the next, per request.",
    append_tokens_per_step:
        "newly_append_tokens per round: non-cached input tokens appended for the invocation.",
    idle_within_session_s:
        "Seconds before each user-message round after a session's first, from the latest end of all earlier rounds in the session to that round's first timing event; a round that starts before that end counts as zero.",
    idle_between_sessions_s:
        "Seconds from the latest end of all of a user's earlier sessions to the next session's first timing event, positive gaps only.",
    tool_output_chars:
        "result_chars per tool call: characters of the tool result returned to the model.",
};

export const QUANTITIES: readonly string[] = Object.keys(DEFINITIONS).sort();

type Row = Record<string, unknown>;

async function readTable(dataset: Dataset, table: string, columns: string[]): Promise<Row[]> {
    const file = await asyncBufferFromFile(
        cachePath(dataset, `data/v0.0.2/${table}/train.parquet`),
    );
    return (await parquetReadObjects({ file, columns, compressors })) as Row[];
}

export interface Round {
    index: number;
    requestStart: boolean;
    t0: number;
    t1: number;
}

/**
 * A request is a round whose first input event is a user message. idle holds
 * one gap per request after the first, measured from the latest end of all
 * earlier rounds in the session; a request that starts before that end
 * contributes zero.
 */
export function sessionMetrics(rounds: Round[]): { steps: number[]; idle: number[]; end: number } {
    const sorted = [...rounds].sort((a, b) => a.t0 - b.t0 || a.index - b.index);
    const steps: number[] = [];
    const idle: number[] = [];
    let current = 0;
    let end = Number.NEGATIVE_INFINITY;
    for (const round of sorted) {
        if (round.requestStart) {
            if (current > 0) {
                steps.push(current);
                idle.push(Math.max(0, round.t0 - end) / 1000);
            }
            current = 1;
        } else if (current > 0) current++;
        end = Math.max(end, round.t1);
    }
    if (current > 0) steps.push(current);
    return { steps, idle, end };
}

/** A gap opens only when a session starts after every earlier session of the same user has ended. */
export function betweenGaps(spans: [number, number][]): number[] {
    const sorted = [...spans].sort((a, b) => a[0] - b[0]);
    const gaps: number[] = [];
    let end = Number.NEGATIVE_INFINITY;
    for (const [start, stop] of sorted) {
        if (Number.isFinite(end) && start > end) gaps.push((start - end) / 1000);
        end = Math.max(end, stop);
    }
    return gaps;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);
    if (list === undefined) map.set(key, [value]);
    else list.push(value);
}

export async function fitTraceLab(dataset: Dataset): Promise<TraceLabFit> {
    const origin = `${dataset.repo}@${dataset.revision}:`;
    const columns = ["round_pk", "session_id", "user", "round_index", "first_input_event_type"];
    const roundRows = await readTable(dataset, "rounds", [...columns, "newly_append_tokens"]);
    const span = new Map<bigint, [number, number]>();
    for (const e of await readTable(dataset, "timing_events", ["round_pk", "timestamp"])) {
        const t = (e.timestamp as Date).getTime();
        const s = span.get(e.round_pk as bigint);
        span.set(e.round_pk as bigint, s ? [Math.min(s[0], t), Math.max(s[1], t)] : [t, t]);
    }

    const requests = new Map<string, number>();
    const append: number[] = [];
    const bySession = new Map<string, Round[]>();
    const userOf = new Map<string, string>();
    for (const r of roundRows) {
        const session = r.session_id as string;
        const requestStart = r.first_input_event_type === "user_message";
        requests.set(session, (requests.get(session) ?? 0) + (requestStart ? 1 : 0));
        if (r.newly_append_tokens !== null) append.push(Number(r.newly_append_tokens));
        const s = span.get(r.round_pk as bigint);
        if (s === undefined) continue;
        userOf.set(session, r.user as string);
        push(bySession, session, {
            index: Number(r.round_index),
            requestStart,
            t0: s[0],
            t1: s[1],
        });
    }

    const idle: number[] = [];
    const steps: number[] = [];
    const spansByUser = new Map<string, [number, number][]>();
    for (const [session, rounds] of bySession) {
        const m = sessionMetrics(rounds);
        steps.push(...m.steps);
        idle.push(...m.idle);
        const start = rounds.reduce((min, r) => Math.min(min, r.t0), Number.POSITIVE_INFINITY);
        push(spansByUser, userOf.get(session) ?? "", [start, m.end] as [number, number]);
    }
    const between = [...spansByUser.values()].flatMap(betweenGaps);

    const toolColumns = ["tool_name", "is_error", "result_chars"];
    const toolRows = await readTable(dataset, "tool_calls", toolColumns);
    const chars = toolRows.flatMap((t) =>
        t.result_chars === null ? [] : [Number(t.result_chars)],
    );
    const specs: [keyof typeof DEFINITIONS, string, number[], CdfTable["kind"]][] = [
        ["requests_per_session", "requests", [...requests.values()], "discrete"],
        ["tool_steps_per_request", "steps", steps, "discrete"],
        ["append_tokens_per_step", "tokens", append, "continuous"],
        ["idle_within_session_s", "seconds", idle, "continuous"],
        ["idle_between_sessions_s", "seconds", between, "continuous"],
        ["tool_output_chars", "chars", chars, "continuous"],
    ];
    const quantities = specs.map(([name, unit, values, kind]) => {
        const cdf = fitCdf(values, kind);
        const source = `${origin}${TABLES[name]}`;
        return [name, { definition: DEFINITIONS[name], unit, source, n: values.length, cdf }];
    });
    return {
        quantities: Object.fromEntries(quantities),
        tool_mix: toolMix(toolRows, `${origin}tool_calls`),
    };
}

export function toolMix(rows: Row[], source: string): TraceLabFit["tool_mix"] {
    const acc = new Map<string, { count: number; errors: number; tools: Set<string> }>();
    for (const row of rows) {
        const name = row.tool_name as string;
        const category = TOOL_CATEGORY.get(name) ?? "other";
        const entry = acc.get(category) ?? { count: 0, errors: 0, tools: new Set<string>() };
        entry.count++;
        if (row.is_error === true) entry.errors++;
        entry.tools.add(name);
        acc.set(category, entry);
    }
    const categories = [...acc.entries()]
        .map(([category, e]) => ({
            category,
            share: round6(e.count / rows.length),
            error_rate: round6(e.errors / e.count),
            tools: category === "other" ? [] : [...e.tools].sort(),
        }))
        .sort((a, b) => b.share - a.share || (a.category < b.category ? -1 : 1));
    return { source, n: rows.length, categories };
}

function round6(v: number): number {
    return Math.round(v * 1e6) / 1e6;
}
