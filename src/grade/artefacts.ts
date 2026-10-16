import { COMPONENTS } from "../proxy/records";
export const ARTEFACT_CLASSES = [
    "diff",
    "command-log",
    "test-result",
    "workspace-state",
    "proxy-call",
] as const;
export type ArtefactClass = (typeof ARTEFACT_CLASSES)[number];

export interface DiffArtefact {
    id: string;
    class: "diff";
    /** `turn`: the probe turn's changes; `prior-session`: the project's previous session. */
    role: "turn" | "prior-session";
    patch: string;
}

export interface Command {
    command: string;
    exit: number | null;
    scenario_ms: number;
}

export interface CommandLog {
    id: string;
    class: "command-log";
    /** `turn`: the probe turn's commands; `session`: every command of its session so far. */
    role: "turn" | "session";
    commands: Command[];
}

export interface TestResult {
    id: string;
    class: "test-result";
    command: string;
    exit: number;
    summary: string[];
}

export interface WorkspaceState {
    id: string;
    class: "workspace-state";
    files: Record<string, string>;
}

export interface CallView {
    seq: number;
    component: string;
    turn: string | null;
    turn_index?: number;
    scenario_ms: number;
    /** The HTTP status and error the proxy recorded for the call. */
    status: number;
    error: string | null;
    input_tokens: number;
    output_tokens: number;
    response_text?: string;
    label?: string;
}

export interface ProxyCalls {
    id: string;
    class: "proxy-call";
    calls: CallView[];
}

export type Artefact = DiffArtefact | CommandLog | TestResult | WorkspaceState | ProxyCalls;

export interface Snapshot {
    id: string;
    item: string;
    arm: string;
    session: string;
    turn: string;
    turn_outcome: "ok" | "failed";
    artefacts: Artefact[];
}

export class GradeRefused extends Error {}

export const completed = (c: CallView) => c.status >= 200 && c.status < 300 && c.error === null;

export type Field = (v: unknown) => boolean;
export const str: Field = (v) => typeof v === "string";
export const text: Field = (v) => typeof v === "string" && v.length > 0;
export const num: Field = (v) => typeof v === "number" && Number.isFinite(v);
export const bool: Field = (v) => typeof v === "boolean";
export const optional =
    (f: Field): Field =>
    (v) =>
        v === undefined || f(v);
const nullable =
    (f: Field): Field =>
    (v) =>
        v === null || f(v);
export const oneOf =
    (values: readonly string[]): Field =>
    (v) =>
        values.includes(v as string);
const listOf = (shape: Record<string, Field>, path: string, v: unknown): string | null => {
    if (!Array.isArray(v)) return path;
    for (const [i, item] of v.entries()) {
        const bad = badField(shape, item, `${path}[${i}]`);
        if (bad) return bad;
    }
    return null;
};
const mapOf =
    (f: Field): Field =>
    (v) =>
        typeof v === "object" && v !== null && Object.values(v).every(f);

/** The first field of `value` that fails `shape`, as a dotted path, or null when every field holds. */
export function badField(
    shape: Record<string, Field>,
    value: unknown,
    path: string,
): string | null {
    if (typeof value !== "object" || value === null) return path;
    const record = value as Record<string, unknown>;
    for (const [key, f] of Object.entries(shape)) {
        if (!f(record[key])) return `${path}.${key}`;
    }
    return null;
}

const CALL: Record<string, Field> = {
    seq: num,
    component: oneOf(COMPONENTS),
    turn: nullable(str),
    turn_index: optional(num),
    scenario_ms: num,
    status: num,
    error: nullable(str),
    input_tokens: num,
    output_tokens: num,
    response_text: optional(str),
    label: optional(str),
};
const COMMAND: Record<string, Field> = { command: str, exit: nullable(num), scenario_ms: num };

/** The first call whose `seq` fails to exceed its predecessor's, as a path, or null. */
const unordered = (calls: unknown, path: string): string | null => {
    const seqs = (calls as { seq: number }[]).map((c) => c.seq);
    const i = seqs.findIndex((s, k) => k > 0 && s <= (seqs[k - 1] as number));
    return i < 0 ? null : `${path}[${i}].seq`;
};

/** The payload check for each artefact class, run after id and class are known. */
const PAYLOADS: Record<ArtefactClass, (a: Record<string, unknown>, path: string) => string | null> =
    {
        diff: (a, p) => badField({ role: oneOf(["turn", "prior-session"]), patch: str }, a, p),
        "command-log": (a, p) =>
            badField({ role: oneOf(["turn", "session"]) }, a, p) ??
            listOf(COMMAND, `${p}.commands`, a.commands),
        "test-result": (a, p) =>
            badField(
                { command: str, exit: num, summary: (v) => Array.isArray(v) && v.every(str) },
                a,
                p,
            ),
        "workspace-state": (a, p) => badField({ files: mapOf(str) }, a, p),
        "proxy-call": (a, p) =>
            listOf(CALL, `${p}.calls`, a.calls) ?? unordered(a.calls, `${p}.calls`),
    };

const SNAPSHOT: Record<string, Field> = {
    id: text,
    item: text,
    arm: text,
    session: text,
    turn: text,
    turn_outcome: oneOf(["ok", "failed"]),
    artefacts: Array.isArray,
};

/** Refuses a snapshot whose shape or artefacts fall outside the grade-input contract. */
export function assertArtefactsOnly(snapshot: Snapshot): void {
    const top = badField(SNAPSHOT, snapshot, "snapshot");
    if (top) throw new GradeRefused(`${top} is missing or malformed`);
    const ids = new Set<string>();
    for (const [i, raw] of snapshot.artefacts.entries()) {
        // SAFETY: the field checks below establish whether each artefact satisfies the Artefact contract.
        const a = raw as unknown as Record<string, unknown>;
        if (!text(a.id)) {
            throw new GradeRefused(`snapshot ${snapshot.id} has an artefact without an id`);
        }
        const id = a.id as string;
        if (ids.has(id))
            throw new GradeRefused(`snapshot ${snapshot.id} has artefact id ${id} twice`);
        ids.add(id);
        if (!(ARTEFACT_CLASSES as readonly string[]).includes(a.class as string)) {
            throw new GradeRefused(`artefact ${id} of class ${a.class} is not a grade input`);
        }
        const bad = PAYLOADS[a.class as ArtefactClass](a, `artefacts[${i}]`);
        if (bad) throw new GradeRefused(`snapshot ${snapshot.id}: ${bad} is missing or malformed`);
    }
}

export class ArtefactReader {
    readonly read = new Set<string>();

    constructor(private readonly snapshot: Snapshot) {}

    private find<T extends Artefact>(label: string, test: (a: Artefact) => a is T): T {
        const matches = this.snapshot.artefacts.filter(test);
        const found = matches[0];
        if (!found) throw new GradeRefused(`snapshot ${this.snapshot.id} has no ${label} artefact`);
        if (matches.length > 1) {
            throw new GradeRefused(`snapshot ${this.snapshot.id} has two ${label} artefacts`);
        }
        this.read.add(found.id);
        return found;
    }

    diff(role: DiffArtefact["role"] = "turn"): string {
        return this.find(
            `${role} diff`,
            (a): a is DiffArtefact => a.class === "diff" && a.role === role,
        ).patch;
    }

    commands(role: CommandLog["role"] = "turn"): Command[] {
        return this.find(
            `${role} command-log`,
            (a): a is CommandLog => a.class === "command-log" && a.role === role,
        ).commands;
    }

    calls(): CallView[] {
        return this.find("proxy-call", (a): a is ProxyCalls => a.class === "proxy-call").calls;
    }

    turnCalls(): CallView[] {
        const turn = this.snapshot.turn;
        return this.calls().filter(
            (c) => c.component === "agent" && c.turn === turn && completed(c),
        );
    }

    private completedResponses(): string[] {
        const texts = this.turnCalls().flatMap((c) =>
            c.response_text === undefined ? [] : [c.response_text],
        );
        if (texts.length === 0) {
            throw new GradeRefused(
                `snapshot ${this.snapshot.id} has no completed agent response for turn ${this.snapshot.turn}`,
            );
        }
        return texts;
    }

    answer(): string {
        return this.completedResponses().at(-1) as string;
    }

    responses(): string {
        return this.completedResponses().join("\n");
    }
}
