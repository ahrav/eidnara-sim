import type { Journal } from "./journal";

/**
 * Scenario time runs at wall speed while any turn or background job is busy and holds still
 * otherwise; `advanceTo` advances scenario time only when `busy` is empty.
 */
export class Clock {
    private readonly busy = new Set<string>();
    private anchor: number | null = null;
    /** The highest wall reading seen, so a source that steps backward never counts twice. */
    private high = Number.NEGATIVE_INFINITY;
    private held = false;

    constructor(
        private scenario: number,
        private readonly journal: Journal,
        private readonly wall: () => number = () => Math.round(performance.now()),
        private readonly onAdvance: (scenarioMs: number) => void = () => undefined,
    ) {}

    now(): number {
        if (this.anchor === null) return this.scenario;
        const wall = this.wall();
        if (wall > this.anchor) {
            this.scenario += wall - this.anchor;
            this.anchor = wall;
            this.high = wall;
        }
        return this.scenario;
    }

    busyIds(): string[] {
        return [...this.busy];
    }

    begin(id: string): void {
        if (this.busy.has(id)) throw new Error(`clock: ${id} is already busy`);
        if (this.busy.size === 0 && !this.held) {
            this.high = Math.max(this.high, this.wall());
            this.anchor = this.high;
        }
        this.busy.add(id);
    }

    /** Scenario time stands still while held, whatever is busy: an arm has no time of its own before it starts. */
    hold(): void {
        this.now();
        this.anchor = null;
        this.held = true;
    }

    release(): void {
        this.held = false;
        if (this.busy.size > 0) {
            this.high = Math.max(this.high, this.wall());
            this.anchor = this.high;
        }
    }

    /**
     * Ends a busy item; when the last one ends the clock stops at `at` when given (the reading
     * an entry just journaled carries, so the stop and the record share one sample) or at the
     * current reading otherwise.
     */
    end(id: string, at?: number): void {
        if (!this.busy.delete(id)) throw new Error(`clock: ${id} is not busy`);
        if (this.busy.size > 0) return;
        if (at === undefined) this.now();
        else this.scenario = at;
        this.anchor = null;
    }

    advanceTo(target: number, arm: string, detail: Record<string, unknown> = {}): void {
        if (this.busy.size > 0) {
            throw new Error(`clock: advance while busy with ${[...this.busy].join(", ")}`);
        }
        if (target <= this.scenario) return;
        const from_ms = this.scenario;
        this.journal.append({
            ...detail,
            kind: "AdvanceClock",
            arm,
            scenario_ms: target,
            from_ms,
            busy: [],
        });
        this.scenario = target;
        this.onAdvance(target);
    }
}
