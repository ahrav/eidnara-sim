import { expect, test } from "bun:test";
import { HarnessFailure, TransportFailure } from "./journal";
import { gatewayRetry, transientUserSim, withRetry } from "./retry";

function fakeTime() {
    let t = 0;
    return {
        now: () => t,
        sleep: async (ms: number) => {
            t += ms;
        },
        spend: (ms: number) => {
            t += ms;
        },
    };
}

test("a transient failure is retried with the same request, and the success is returned", async () => {
    const time = fakeTime();
    const deadlines: number[] = [];
    let calls = 0;
    const got = await withRetry(
        "user-sim call",
        gatewayRetry(900_000),
        transientUserSim,
        async (ms) => {
            deadlines.push(ms);
            if (++calls < 3) throw new HarnessFailure("user-sim call timed out after 300000 ms");
            return "reply";
        },
        time.sleep,
        time.now,
    );
    expect(got).toBe("reply");
    expect(deadlines).toEqual([300_000, 300_000, 900_000 - 2_000 - 8_000]);
    expect(time.now()).toBe(10_000);
});

test("the attempts and backoffs together stay inside the total budget", async () => {
    const time = fakeTime();
    let calls = 0;
    const failure = withRetry(
        "user-sim call",
        gatewayRetry(900_000),
        transientUserSim,
        async (ms) => {
            calls++;
            // Each attempt runs to its own deadline and times out.
            time.spend(ms);
            throw new TypeError("The socket connection was closed unexpectedly");
        },
        time.sleep,
        time.now,
    );
    await expect(failure).rejects.toBeInstanceOf(TransportFailure);
    await expect(failure).rejects.toThrow(/failed after 3 attempt\(s\)/);
    expect(calls).toBe(3);
    expect(time.now()).toBeLessThanOrEqual(900_000);
});

test("an error outside transport is rethrown at once, unwrapped", async () => {
    const time = fakeTime();
    let calls = 0;
    const refusal = new HarnessFailure("user-sim call failed: 400");
    await expect(
        withRetry(
            "user-sim call",
            gatewayRetry(900_000),
            transientUserSim,
            async () => {
                calls++;
                throw refusal;
            },
            time.sleep,
            time.now,
        ),
    ).rejects.toBe(refusal);
    expect(calls).toBe(1);
});

test("transientUserSim accepts timeouts, 429 and 5xx, and transport errors, and nothing else", () => {
    expect(transientUserSim(new HarnessFailure("user-sim call timed out after 5 ms"))).toBe(true);
    expect(transientUserSim(new HarnessFailure("user-sim call failed: 503"))).toBe(true);
    expect(transientUserSim(new HarnessFailure("user-sim call failed: 429"))).toBe(true);
    expect(transientUserSim(new TypeError("fetch failed"))).toBe(true);
    expect(transientUserSim(new HarnessFailure("user-sim call failed: 403"))).toBe(false);
    expect(transientUserSim(new HarnessFailure("e-1: delivered text carries markers K"))).toBe(
        false,
    );
});
