import { expect, test } from "bun:test";
import { faultScope } from "./run";
import type { ScenarioEvent } from "./scheduler";

const at: ScenarioEvent = { id: "e-1", kind: "session_start", scenario_ms: 0, session: "s-0001" };
const prior = { session: "s-0000", turn: null };

test("a fault other than the second client keeps the proxy scope it found", () => {
    expect(faultScope(prior, { type: "daemon_restart" }, at)).toEqual({
        during: prior,
        after: prior,
    });
    expect(faultScope(prior, { type: "two_hosts_one_daemon" }, undefined)).toEqual({
        during: prior,
        after: prior,
    });
});

test("the second client runs under its own session and leaves the primary session's scope", () => {
    const { during, after } = faultScope(prior, { type: "two_hosts_one_daemon" }, at);
    expect(during).toEqual({ session: "s-0001-b", turn: null });
    expect(after).toEqual({ session: "s-0001", turn: null });
});
