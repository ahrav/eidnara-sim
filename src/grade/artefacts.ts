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
    input_tokens: number;
    output_tokens: number;
    response_text?: string;
    /** The proxy cut `response_text` at its cap; the answer is a prefix and is refused as grade input. */
    response_text_truncated?: boolean;
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

export function assertArtefactsOnly(snapshot: Snapshot): void {
    for (const a of snapshot.artefacts as Array<{ id: string; class: string }>) {
        if (!(ARTEFACT_CLASSES as readonly string[]).includes(a.class)) {
            throw new GradeRefused(`artefact ${a.id} of class ${a.class} is not a grade input`);
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

    answer(): string {
        const last = this.turnCalls().at(-1);
        if (last?.response_text_truncated) {
            throw new GradeRefused(`call ${last.seq}: the proxy truncated the answer at its cap`);
        }
        return last?.response_text ?? "";
    }
}
