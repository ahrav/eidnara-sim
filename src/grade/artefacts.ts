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
    turn: string;
    turn_outcome: "ok" | "failed";
    artefacts: Artefact[];
}

export class GradeRefused extends Error {}

export const completed = (c: CallView) => c.status >= 200 && c.status < 300 && c.error === null;

export function assertArtefactsOnly(snapshot: Snapshot): void {
    for (const a of snapshot.artefacts as Array<{ id?: unknown; class: string }>) {
        if (typeof a.id !== "string" || a.id.length === 0) {
            throw new GradeRefused(`snapshot ${snapshot.id} has an artefact without an id`);
        }
        if (!(ARTEFACT_CLASSES as readonly string[]).includes(a.class)) {
            throw new GradeRefused(`artefact ${a.id} of class ${a.class} is not a grade input`);
        }
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
