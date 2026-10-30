import { HarnessFailure, TransportFailure } from "./journal";

/**
 * `totalMs` budgets elapsed time across every attempt and backoff, at most `attempts` attempts,
 * with `backoffMs[i]` before attempt `i + 2` (the last value repeats).
 */
export interface RetryPolicy {
    attempts: number;
    totalMs: number;
    backoffMs: readonly number[];
}

export const gatewayRetry = (totalMs: number): RetryPolicy => ({
    attempts: 3,
    totalMs,
    backoffMs: [2_000, 8_000],
});

export type Transient = (caught: unknown) => boolean;

/** `call` must enforce the `attemptMs` it receives as its own timeout. */
export async function withRetry<T>(
    what: string,
    policy: RetryPolicy,
    transient: Transient,
    call: (attemptMs: number) => Promise<T>,
    sleep: (ms: number) => Promise<void> = Bun.sleep,
    now: () => number = performance.now.bind(performance),
): Promise<T> {
    const started = now();
    const share = Math.max(1, Math.floor(policy.totalMs / policy.attempts));
    const errors: string[] = [];
    for (let attempt = 1; ; attempt++) {
        const left = Math.max(1, Math.floor(policy.totalMs - (now() - started)));
        try {
            return await call(attempt === policy.attempts ? left : Math.min(share, left));
        } catch (caught) {
            if (!transient(caught)) throw caught;
            errors.push(caught instanceof Error ? caught.message : String(caught));
            const pause = policy.backoffMs[Math.min(attempt - 1, policy.backoffMs.length - 1)] ?? 0;
            const remaining = policy.totalMs - (now() - started) - pause;
            if (attempt >= policy.attempts || remaining <= 0) {
                throw new TransportFailure(
                    `${what} failed after ${attempt} attempt(s): ${errors.join("; ")}`,
                );
            }
            await sleep(pause);
        }
    }
}

export const transientUserSim: Transient = (caught) => {
    if (!(caught instanceof HarnessFailure)) return true;
    return /^user-sim call (?:timed out after \d+ ms|failed: (?:429|5\d\d))$/.test(caught.message);
};
