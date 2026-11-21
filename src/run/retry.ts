import { withDeadline } from "./deadline";
import { HarnessFailure, TransportFailure } from "./journal";

/**
 * `totalMs` budgets elapsed time across every attempt and backoff, at most `attempts` attempts,
 * with `backoffMs[i]` before attempt `i + 2` (the last value repeats). `slackMs` is how long
 * past its `attemptMs` an attempt may stay pending before `withRetry` ends it
 * (`ATTEMPT_SLACK_MS` when absent).
 */
export interface RetryPolicy {
    attempts: number;
    totalMs: number;
    backoffMs: readonly number[];
    slackMs?: number;
}

/** The default `RetryPolicy.slackMs`: a call's own timeout reports first, with its own text. */
export const ATTEMPT_SLACK_MS = 1_000;

/**
 * An attempt `withRetry` ended because its call was still pending `slackMs` past the
 * `attemptMs` it was given. Bun's `fetch` can stay pending for good, its `AbortSignal` included
 * (`docs/run.md`, Undelivered turns), so the call's own timeout is one bound and this timer is
 * the other.
 */
class AttemptOverdue extends Error {}

export const gatewayRetry = (totalMs: number): RetryPolicy => ({
    attempts: 3,
    totalMs,
    backoffMs: [2_000, 8_000],
});

export type Transient = (caught: unknown) => boolean;

/** `sleep` and `now` replace the backoff wait and the budget's clock; `onRetry` hears each failed attempt's number and error before its backoff or the final `TransportFailure`. */
export interface RetrySeams {
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    onRetry?: (attempt: number, error: string) => void;
}

/**
 * `call` enforces the `attemptMs` it receives as its own timeout. An attempt still pending
 * `policy.slackMs` past that is ended here and retried as a transient failure, so the whole
 * call settles within `totalMs` plus one slack whatever `call` does.
 */
export async function withRetry<T>(
    what: string,
    policy: RetryPolicy,
    transient: Transient,
    call: (attemptMs: number) => Promise<T>,
    seams: RetrySeams = {},
): Promise<T> {
    const sleep = seams.sleep ?? Bun.sleep;
    const now = seams.now ?? performance.now.bind(performance);
    const started = now();
    const share = Math.max(1, Math.floor(policy.totalMs / policy.attempts));
    const slackMs = policy.slackMs ?? ATTEMPT_SLACK_MS;
    const errors: string[] = [];
    const exhausted = (attempts: number) =>
        new TransportFailure(`${what} failed after ${attempts} attempt(s): ${errors.join("; ")}`);
    for (let attempt = 1; ; attempt++) {
        const left = Math.floor(policy.totalMs - (now() - started));
        // A backoff that woke past the budget starts no further attempt.
        if (attempt > 1 && left <= 0) throw exhausted(attempt - 1);
        const attemptMs = Math.max(1, attempt === policy.attempts ? left : Math.min(share, left));
        const boundMs = attemptMs + slackMs;
        try {
            const settled = await withDeadline(
                call(attemptMs).then((value) => ({ value })),
                boundMs,
            );
            if (settled === null) {
                throw new AttemptOverdue(`${what} stayed pending past ${boundMs} ms`);
            }
            return settled.value;
        } catch (caught) {
            if (!(caught instanceof AttemptOverdue) && !transient(caught)) throw caught;
            errors.push(caught instanceof Error ? caught.message : String(caught));
            seams.onRetry?.(attempt, errors.at(-1) as string);
            const pause = policy.backoffMs[Math.min(attempt - 1, policy.backoffMs.length - 1)] ?? 0;
            const remaining = policy.totalMs - (now() - started) - pause;
            if (attempt >= policy.attempts || remaining <= 0) throw exhausted(attempt);
            await sleep(pause);
        }
    }
}

/** Errno codes and `fetch` messages of a connection that failed, reset, or closed mid-reply. */
const NETWORK_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EPIPE",
    "ETIMEDOUT",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ConnectionClosed",
    "ConnectionRefused",
    "FailedToOpenSocket",
]);
const NETWORK_TEXT =
    /socket connection was closed|fetch failed|Unable to connect|ECONN(?:RESET|REFUSED)/;

export const transientNetwork: Transient = (caught) => {
    const e = caught as { code?: unknown; message?: unknown; name?: unknown } | null;
    if (e?.name === "TimeoutError") return true;
    if (typeof e?.code === "string" && NETWORK_CODES.has(e.code)) return true;
    return typeof e?.message === "string" && NETWORK_TEXT.test(e.message);
};

export const transientUserSim: Transient = (caught) => {
    if (caught instanceof HarnessFailure) {
        return /^user-sim call (?:timed out after \d+ ms|failed: (?:429|5\d\d))$/.test(
            caught.message,
        );
    }
    return transientNetwork(caught);
};
