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
        private readonly wall: () => number = () => Math.round(performance.now()),
    ) {}

    now(): number {
        if (this.anchor === null) return this.scenario;
        const wall = this.wall();
        if (wall > this.anchor) {
            this.scenario += wall - this.anchor;
            this.anchor = wall;
        }
        return this.scenario;
    }

    busyIds(): string[] {
        return [...this.busy];
    }

    begin(id: string): void {
        if (this.busy.has(id)) throw new Error(`clock: ${id} is already busy`);
        if (this.busy.size === 0) this.anchor = this.wall();
        this.busy.add(id);
    }

    end(id: string): void {
        if (!this.busy.delete(id)) throw new Error(`clock: ${id} is not busy`);
        if (this.busy.size > 0) return;
        this.now();
        this.anchor = null;
    }

    advanceTo(target: number, arm: string, detail: Record<string, unknown> = {}): void {
        if (this.busy.size > 0) {
            throw new Error(`clock: advance while busy with ${[...this.busy].join(", ")}`);
        }
        if (target <= this.scenario) return;
        const from_ms = this.scenario;
        this.scenario = target;
        this.journal.append({
            ...detail,
            kind: "AdvanceClock",
            arm,
            scenario_ms: target,
            from_ms,
            busy: [],
        });
    }
}
