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

const DEFINITIONS: Record<string, string> = {
    requests_per_session:
        "Rounds whose first input event is a user message, per session; includes sessions with zero such rounds.",
    tool_steps_per_request:
        "Rounds (LLM invocations) from one user-message round up to the next, per request.",
    append_tokens_per_step:
        "newly_append_tokens per round: non-cached input tokens appended for the invocation.",
    idle_within_session_s:
        "Seconds from the previous round's last timing event to a user-message round's first timing event, same session, non-negative gaps only.",
    idle_between_sessions_s:
        "Seconds from one session's last timing event to the same user's next session's first timing event, positive gaps only.",
    tool_output_chars:
        "result_chars per tool call: characters of the tool result returned to the model.",
};

type Row = Record<string, unknown>;

async function readTable(dataset: Dataset, table: string, columns: string[]): Promise<Row[]> {
    const file = await asyncBufferFromFile(
        cachePath(dataset, `data/v0.0.2/${table}/train.parquet`),
    );
    return (await parquetReadObjects({ file, columns, compressors })) as Row[];
}

interface Round {
    user: string;
    index: number;
    requestStart: boolean;
    t0: number;
    t1: number;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
    const list = map.get(key);
    if (list === undefined) map.set(key, [value]);
    else list.push(value);
}

/**
 * A request is a round whose first input event is a user message. The idle
 * gap before a request runs from the previous round's last event to the
 * request's first event.
 */
export async function fitTraceLab(dataset: Dataset): Promise<TraceLabFit> {
    const source = (table: string) => `${dataset.repo}@${dataset.revision}:${table}`;
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
    for (const r of roundRows) {
        const session = r.session_id as string;
        const requestStart = r.first_input_event_type === "user_message";
        requests.set(session, (requests.get(session) ?? 0) + (requestStart ? 1 : 0));
        if (r.newly_append_tokens !== null) append.push(Number(r.newly_append_tokens));
        const s = span.get(r.round_pk as bigint);
        if (s === undefined) continue;
        const user = r.user as string;
        push(bySession, session, {
            user,
            index: Number(r.round_index),
            requestStart,
            t0: s[0],
            t1: s[1],
        });
    }

    const idle: number[] = [];
    const steps: number[] = [];
    const sessionSpans = new Map<string, [number, number][]>();
    for (const rounds of bySession.values()) {
        rounds.sort((a, b) => a.t0 - b.t0 || a.index - b.index);
        let current = 0;
        let end = Number.NEGATIVE_INFINITY;
        rounds.forEach((round, i) => {
            const prev = rounds[i - 1];
            if (round.requestStart) {
                if (current > 0) steps.push(current);
                current = 1;
                if (prev && round.t0 >= prev.t1) idle.push((round.t0 - prev.t1) / 1000);
            } else if (current > 0) current++;
            end = Math.max(end, round.t1);
        });
        if (current > 0) steps.push(current);
        const first = rounds[0];
        if (first) push(sessionSpans, first.user, [first.t0, end] as [number, number]);
    }
    const between: number[] = [];
    for (const list of sessionSpans.values()) {
        list.sort((a, b) => a[0] - b[0]);
        list.forEach(([start], i) => {
            const prev = list[i - 1];
            if (prev && start > prev[1]) between.push((start - prev[1]) / 1000);
        });
    }

    const toolRows = await readTable(dataset, "tool_calls", [
        "tool_name",
        "is_error",
        "result_chars",
    ]);
    const chars = toolRows.flatMap((t) =>
        t.result_chars === null ? [] : [Number(t.result_chars)],
    );
    const timed = "rounds+timing_events";
    const specs: [string, string, string, number[], CdfTable["kind"]][] = [
        ["requests_per_session", "requests", "rounds", [...requests.values()], "discrete"],
        ["tool_steps_per_request", "steps", timed, steps, "discrete"],
        ["append_tokens_per_step", "tokens", "rounds", append, "continuous"],
        ["idle_within_session_s", "seconds", timed, idle, "continuous"],
        ["idle_between_sessions_s", "seconds", timed, between, "continuous"],
        ["tool_output_chars", "chars", "tool_calls", chars, "continuous"],
    ];
    const quantities = specs.map(([name, unit, table, values, kind]) => {
        const definition = DEFINITIONS[name] ?? "";
        const cdf = fitCdf(values, kind);
        return [name, { definition, unit, source: source(table), n: values.length, cdf }];
    });
    return {
        quantities: Object.fromEntries(quantities),
        tool_mix: toolMix(toolRows, source("tool_calls")),
    };
}

function toolMix(rows: Row[], source: string): TraceLabFit["tool_mix"] {
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
