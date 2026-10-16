import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { cachePath, type Dataset } from "./sources";

export type SampleKind = "stack_trace" | "test_run" | "grep" | "file_read";

interface Provenance {
    id: string;
    repo: string;
    license: string;
    source_id: string;
}

export interface ToolOutputSample extends Provenance {
    kind: SampleKind;
    tool: string;
    command: string;
    exit_code: number | null;
    chars: number;
    truncated: boolean;
    content: string;
}

export interface ErrorCodeEntry extends Provenance {
    code: string;
    message: string;
    context: string;
}

export interface Extraction {
    samples: ToolOutputSample[];
    error_codes: ErrorCodeEntry[];
}

const SAMPLES_PER_KIND = 150;
const MAX_ERROR_CODES = 200;
const CONTENT_CAP = 4000;
const MIN_CHARS = 40;
const ROWS_SCANNED = 4096;

const FOOTER =
    /^\[(The command completed|Current working directory|Python interpreter|Command finished)/;
const EXIT = /\[Command finished with exit code (-?\d+)\]/;
const EXCEPTION =
    /^((?:[A-Za-z_]\w*\.)*[A-Z]\w*(?:Error|Exception|Failure|Exit|Interrupt|Warning))(?::\s?(.*))?$/;

interface Message {
    role: string;
    content: string | null;
    name?: string | null;
    tool_call_id?: string | null;
    tool_calls?: { id: string; function: { name: string; arguments: string } }[] | null;
}

export function classify(tool: string, command: string, content: string): SampleKind | null {
    if (tool === "str_replace_editor") {
        return content.startsWith("Here's the result of running `cat -n`") ? "file_read" : null;
    }
    if (content.includes(TRACEBACK)) return "stack_trace";
    if (tool !== "execute_bash" || SHELL_ERROR.test(content)) return null;
    const bare = command.replace(QUOTED, '""');
    if (RUNNER.test(bare)) return NO_RUN.test(command) ? null : "test_run";
    if (/\b(grep|rg|ag)\b/.test(bare)) return "grep";
    if (/^\s*(cat|head|tail|sed -n)\b/.test(command)) return "file_read";
    return null;
}

export function commandOf(args: string): string {
    try {
        const parsed = JSON.parse(args) as { command?: string; path?: string };
        return parsed.path === undefined
            ? String(parsed.command ?? "")
            : `${parsed.command} ${parsed.path}`;
    } catch {
        return args;
    }
}

function clip(body: string, kind: SampleKind): string {
    if (body.length <= CONTENT_CAP) return body;
    if (kind === "stack_trace") {
        const start = Math.max(0, body.lastIndexOf(TRACEBACK));
        const lines = body.slice(start).split("\n");
        const last = lines.findIndex((l, i) => i > 0 && TRACE_END.test(l));
        const end =
            last < 0 ? start + CONTENT_CAP : start + lines.slice(0, last + 1).join("\n").length;
        if (end - start <= CONTENT_CAP) return body.slice(start, start + CONTENT_CAP);
        return body.slice(end - CONTENT_CAP, end);
    }
    return kind === "test_run" ? body.slice(-CONTENT_CAP) : body.slice(0, CONTENT_CAP);
}

type Provenanced = Omit<Provenance, "id">;

const FRAME = /^\s*File "/;
const RUNNER =
    /(^|&&|;|\|)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:python3?\s+-m\s+)?(?:pytest|py\.test|tox|nox|unittest)\b/;
const QUOTED = /"(?:\\.|[^"\\])*"|'[^']*'/g;
const NO_RUN = /(^|\s)(--help|-h|--version|--co|--collect-only|--fixtures|--markers)(\s|$)/;
const SHELL_ERROR = /^(?:bash|sh): (?:line \d+: )?(?:syntax error|.*: command not found)/;
const TRACEBACK = "Traceback (most recent call last)";
const TRACE_END = /^(?:E\s+)?\s*[\w.]*(?:Error|Exception|Failure|Exit|Interrupt|Warning)\b/;

function harvestCodes(lines: string[], base: Provenanced, codes: Map<string, ErrorCodeEntry>) {
    for (const [i, line] of lines.entries()) {
        const code = EXCEPTION.exec(line.trim());
        if (code?.[1] === undefined || codes.has(code[1]) || codes.size >= MAX_ERROR_CODES)
            continue;
        if (code[2] === undefined && !lines.slice(Math.max(0, i - 2), i).some((l) => FRAME.test(l)))
            continue;
        codes.set(code[1], {
            id: `err-${codes.size.toString().padStart(4, "0")}`,
            code: code[1],
            message: (code[2] ?? "").slice(0, 300),
            context: lines.slice(Math.max(0, i - 8), i + 1).join("\n"),
            ...base,
        });
    }
}

export interface TrajectoryRow {
    trajectory_id: string;
    repo: string;
    trajectory: Message[];
}

/**
 * extractFrom limits each trajectory to one sample per kind to spread
 * samples across trajectories. Each error code keeps its first occurrence.
 */
export function extractFrom(rows: TrajectoryRow[], dataset: Dataset): Extraction {
    const samples: ToolOutputSample[] = [];
    const perKind = new Map<SampleKind, number>();
    const codes = new Map<string, ErrorCodeEntry>();
    for (const row of rows) {
        const calls = new Map<string, string>();
        const taken = new Set<SampleKind>();
        for (const [index, m] of row.trajectory.entries()) {
            for (const call of m.tool_calls ?? []) {
                calls.set(call.id, commandOf(call.function.arguments));
            }
            if (m.role !== "tool" || !m.content) continue;
            const source_id = `${dataset.repo}@${dataset.revision}:${row.trajectory_id}#${index}`;
            const base = { repo: row.repo, license: dataset.license, source_id };
            const lines = m.content.split("\n").filter((l) => !FOOTER.test(l));
            const tool = m.name ?? "";
            const exit = EXIT.exec(m.content)?.[1];
            const failed = m.content.includes(TRACEBACK) || (exit !== undefined && exit !== "0");
            if (tool === "execute_bash" && failed) harvestCodes(lines, base, codes);

            const body = lines.join("\n").trim();
            const command = calls.get(m.tool_call_id ?? "") ?? "";
            const kind = classify(tool, command, body);
            if (kind === null || body.length < MIN_CHARS || taken.has(kind)) continue;
            if (tool === "execute_bash" && exit === undefined) continue;
            if ((perKind.get(kind) ?? 0) >= SAMPLES_PER_KIND) continue;
            taken.add(kind);
            perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
            samples.push({
                id: `out-${samples.length.toString().padStart(4, "0")}`,
                kind,
                tool,
                command: command.slice(0, 500),
                exit_code: exit === undefined ? null : Number(exit),
                chars: body.length,
                truncated: body.length > CONTENT_CAP,
                content: clip(body, kind),
                ...base,
            });
        }
    }
    return { samples, error_codes: [...codes.values()] };
}

export const OPENHANDS_FILE = "trajectories.parquet";

export async function extractToolOutputs(dataset: Dataset): Promise<Extraction> {
    const file = await asyncBufferFromFile(cachePath(dataset, OPENHANDS_FILE));
    const columns = ["trajectory_id", "repo", "trajectory"];
    const rows = await parquetReadObjects({ file, rowEnd: ROWS_SCANNED, columns, compressors });
    return extractFrom(rows as TrajectoryRow[], dataset);
}
