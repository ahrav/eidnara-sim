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
    /** Why the recorder could not take this diff; a grader reading it refuses the item. */
    refused?: string;
}

export interface Command {
    command: string;
    exit: number | null;
    scenario_ms: number;
    /** The host's id for the run, when it reported a start before the end. */
    call?: string;
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
    input_tokens: number;
    output_tokens: number;
    response_text?: string;
    /** The proxy cut `response_text` at its cap; the answer is a prefix and is refused as grade input. */
    response_text_truncated?: boolean;
    /** The call ended in an error status, a recorded error, or a cut stream; it is no completed fold. */
    failed?: boolean;
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
    /** The scenario session the probe turn belongs to. */
    session?: string;
    turn: string;
    turn_outcome: "ok" | "failed";
    artefacts: Artefact[];
}

export class GradeRefused extends Error {}

/** A refusal that concerns one item's evidence as recorded; the grader excludes the item. */
export class EvidenceRefused extends GradeRefused {}

/** A refusal that concerns one item's answer evidence; the grader excludes the item. */
export class AnswerRefused extends EvidenceRefused {}

const ROLES: Record<string, readonly string[]> = {
    diff: ["turn", "prior-session"],
    "command-log": ["turn", "session"],
};

const isString = (v: unknown) => typeof v === "string";
const isRecord = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v);
/** A command-log entry: command text, a 0/1/null exit, a scenario time, and an optional call id. */
const isCommandRun = (v: unknown) =>
    isRecord(v) &&
    isString((v as { command: unknown }).command) &&
    ((v as { exit: unknown }).exit === null || isNumber((v as { exit: unknown }).exit)) &&
    isNumber((v as { scenario_ms: unknown }).scenario_ms) &&
    ((v as { call?: unknown }).call === undefined || isString((v as { call?: unknown }).call));
const isCommandLog = (v: unknown) => Array.isArray(v) && v.every(isCommandRun);
/** The fields each artefact class carries, and the check each must pass. */
const PAYLOADS: Record<ArtefactClass, Array<[string, (v: unknown) => boolean]>> = {
    diff: [["patch", isString]],
    "command-log": [["commands", isCommandLog]],
    "test-result": [
        ["command", isString],
        ["exit", (v) => typeof v === "number"],
        ["summary", Array.isArray],
    ],
    "workspace-state": [["files", isRecord]],
    "proxy-call": [["calls", Array.isArray]],
};

/**
 * Every artefact must be a grade input of a known class with its class's payload in place: a
 * diff carries a string `patch`, a command log an array of commands, a proxy-call artefact an
 * array of calls. A reader would otherwise default a missing payload to empty evidence.
 */
export function assertArtefactsOnly(snapshot: Snapshot): void {
    for (const raw of snapshot.artefacts) {
        const a = raw as unknown as Record<string, unknown>;
        const id = typeof a.id === "string" ? a.id : "?";
        if (
            typeof a.id !== "string" ||
            !(ARTEFACT_CLASSES as readonly string[]).includes(a.class as string)
        ) {
            throw new GradeRefused(
                `artefact ${id} of class ${String(a.class)} is not a grade input`,
            );
        }
        const roles = ROLES[a.class as string];
        if (roles && !roles.includes(a.role as string)) {
            throw new GradeRefused(`artefact ${id} has no ${a.class} role`);
        }
        for (const [field, ok] of PAYLOADS[a.class as ArtefactClass]) {
            if (!ok(a[field])) {
                throw new GradeRefused(`artefact ${id} of class ${a.class} has no ${field}`);
            }
        }
    }
}

export class ArtefactReader {
    readonly read = new Set<string>();

    constructor(private readonly snapshot: Snapshot) {}

    private find<T extends Artefact>(test: (a: Artefact) => a is T): T | undefined {
        const found = this.snapshot.artefacts.find(test);
        if (found) this.read.add(found.id);
        return found;
    }

    diff(role: DiffArtefact["role"] = "turn"): string {
        const d = this.find((a): a is DiffArtefact => a.class === "diff" && a.role === role);
        if (d?.refused) {
            throw new EvidenceRefused(
                `snapshot ${this.snapshot.id}: ${role} diff unrecorded: ${d.refused}`,
            );
        }
        return d?.patch ?? "";
    }

    commands(role: CommandLog["role"] = "turn"): Command[] {
        const log = this.find((a): a is CommandLog => a.class === "command-log" && a.role === role);
        return log?.commands ?? [];
    }

    calls(): CallView[] {
        return this.find((a): a is ProxyCalls => a.class === "proxy-call")?.calls ?? [];
    }

    turnCalls(): CallView[] {
        const turn = this.snapshot.turn;
        return this.calls().filter((c) => c.component === "agent" && c.turn === turn);
    }

    /** The turn's answer: the text of its last agent call. A turn with no agent call has no answer to grade. */
    answer(): string {
        const last = this.turnCalls().at(-1);
        if (!last) {
            throw new GradeRefused(
                `snapshot ${this.snapshot.id} holds no agent call for turn ${String(this.snapshot.turn)}`,
            );
        }
        if (last.response_text_truncated) {
            throw new AnswerRefused(`call ${last.seq}: the proxy truncated the answer at its cap`);
        }
        return last.response_text ?? "";
    }
}
