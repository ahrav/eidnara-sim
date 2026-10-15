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
    if (content.includes("Traceback (most recent call last)")) return "stack_trace";
    if (tool === "execute_bash") {
        if (/\b(pytest|py\.test|unittest|tox|nox)\b/.test(command)) return "test_run";
        if (/\b(grep|rg|ag)\b/.test(command)) return "grep";
        if (/^\s*(cat|head|tail|sed -n)\b/.test(command)) return "file_read";
    }
    const view = content.startsWith("Here's the result of running `cat -n`");
    return tool === "str_replace_editor" && view ? "file_read" : null;
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

function clip(body: string, keepTail: boolean): string {
    if (body.length <= CONTENT_CAP) return body;
    return keepTail ? body.slice(-CONTENT_CAP) : body.slice(0, CONTENT_CAP);
}

type Provenanced = Omit<Provenance, "id">;

function harvestCodes(lines: string[], base: Provenanced, codes: Map<string, ErrorCodeEntry>) {
    for (const [i, line] of lines.entries()) {
        const code = EXCEPTION.exec(line.trim());
        if (code?.[1] === undefined || codes.has(code[1]) || codes.size >= MAX_ERROR_CODES)
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
            harvestCodes(lines, base, codes);

            const body = lines.join("\n").trim();
            const tool = m.name ?? "";
            const command = calls.get(m.tool_call_id ?? "") ?? "";
            const kind = classify(tool, command, body);
            if (kind === null || body.length < MIN_CHARS || taken.has(kind)) continue;
            if ((perKind.get(kind) ?? 0) >= SAMPLES_PER_KIND) continue;
            taken.add(kind);
            perKind.set(kind, (perKind.get(kind) ?? 0) + 1);
            const exit = EXIT.exec(m.content)?.[1];
            samples.push({
                id: `out-${samples.length.toString().padStart(4, "0")}`,
                kind,
                tool,
                command: command.slice(0, 500),
                exit_code: exit === undefined ? null : Number(exit),
                chars: body.length,
                truncated: body.length > CONTENT_CAP,
                content: clip(body, kind === "test_run" || kind === "stack_trace"),
                ...base,
            });
        }
    }
    return { samples, error_codes: [...codes.values()] };
}

export async function extractToolOutputs(dataset: Dataset): Promise<Extraction> {
    const file = await asyncBufferFromFile(cachePath(dataset, "trajectories.parquet"));
    const columns = ["trajectory_id", "repo", "trajectory"];
    const rows = await parquetReadObjects({ file, rowEnd: ROWS_SCANNED, columns, compressors });
    return extractFrom(rows as TrajectoryRow[], dataset);
}
