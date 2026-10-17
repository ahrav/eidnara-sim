import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Journal, releaseLease, takeLease } from "../src/run/journal";
import { type ArmDriver, type ScenarioEvent, Scheduler } from "../src/run/scheduler";

export function fixtureEvents(turns = 6): ScenarioEvent[] {
    const events: ScenarioEvent[] = [
        { id: "e-000000", kind: "session_start", scenario_ms: 0, session: "s-0000" },
    ];
    for (let i = 0; i < turns; i++) {
        const id = `e-${String(i + 1).padStart(6, "0")}`;
        events.push({
            id,
            kind: "user_turn",
            scenario_ms: 60_000 * i,
            session: "s-0000",
            index: i,
            text: `turn ${i}`,
        });
    }
    events.push({
        id: "e-999999",
        kind: "session_end",
        scenario_ms: 60_000 * turns,
        session: "s-0000",
    });
    return events;
}

if (import.meta.main) {
    const dir = process.argv[2] as string;
    const turnMs = Number(process.argv[3] ?? 150);
    const issueMs = Number(process.argv[5] ?? 0);
    const lease = takeLease(dir);
    const journal = new Journal(join(dir, "journal.jsonl"), lease.within);
    const driver = (arm: string): ArmDriver => ({
        bind: () => undefined,
        reset: async () => appendFileSync(join(dir, "resets.log"), `${arm}\n`),
        event: async (e) => {
            if (e.kind === "user_turn") {
                if (issueMs) await Bun.sleep(issueMs);
                appendFileSync(join(dir, "bill.log"), `${arm} ${e.id}\n`);
                await Bun.sleep(turnMs);
            }
            return {};
        },
        fault: async () => ({}),
    });
    const scheduler = new Scheduler({
        events: fixtureEvents(),
        faults: [],
        journal,
        settleMs: Number(process.argv[4] ?? 0),
        order: ["host", "eidnara"],
        drivers: { host: driver("host"), eidnara: driver("eidnara") },
    });
    await scheduler.run();
    journal.close();
    releaseLease(dir, lease);
}
