import type { Journal } from "./journal";

/**
 * Scenario time runs at wall speed while any turn or background job is busy and holds still
 * otherwise; `advanceTo` advances scenario time only when `busy` is empty.
 */
export class Clock {
    private readonly busy = new Set<string>();
    private anchor: number | null = null;

    constructor(
        private scenario: number,
        private readonly journal: Journal,
        private readonly wall: () => number = Date.now,
        /** Runs before the jump is journaled; its fields ride on the `AdvanceClock` entry. */
        private readonly onAdvance: (scenarioMs: number) => Record<string, unknown> = () => ({}),
    ) {}

    now(): number {
        return this.anchor === null ? this.scenario : this.scenario + (this.wall() - this.anchor);
    }

    busyIds(): string[] {
        return [...this.busy];
    }

    begin(id: string): void {
        if (this.busy.size === 0) this.anchor = this.wall();
        this.busy.add(id);
    }

    end(id: string): void {
        if (!this.busy.delete(id) || this.busy.size > 0) return;
        this.scenario = this.now();
        this.anchor = null;
    }

    advanceTo(target: number, arm: string, detail: Record<string, unknown> = {}): void {
        if (this.busy.size > 0) {
            throw new Error(`clock: advance while busy with ${[...this.busy].join(", ")}`);
        }
        if (target <= this.scenario) return;
        const from_ms = this.scenario;
        this.scenario = target;
        const extra = this.onAdvance(target);
        this.journal.append({
            ...detail,
            ...extra,
            kind: "AdvanceClock",
            arm,
            scenario_ms: target,
            from_ms,
            busy: [],
        });
    }
}
