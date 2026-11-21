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
export class AttemptOverdue extends Error {
    override name = "TimeoutError";
}

/** The longest delay a timer takes; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Settles as `call` does, or rejects with `AttemptOverdue` once `ms` pass with it pending. */
function bounded<T>(what: string, ms: number, call: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const overdue = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new AttemptOverdue(`${what} stayed pending past ${ms} ms`)),
            Math.min(ms, MAX_TIMER_MS),
        );
    });
    // The pending call keeps a handler, so its late rejection stays a handled one.
    call.catch(() => undefined);
    return Promise.race([call, overdue]).finally(() => clearTimeout(timer));
}

export const gatewayRetry = (totalMs: number): RetryPolicy => ({
    attempts: 3,
    totalMs,
    backoffMs: [2_000, 8_000],
});

export type Transient = (caught: unknown) => boolean;

/**
 * `call` enforces the `attemptMs` it receives as its own timeout. An attempt still pending
 * `policy.slackMs` past that is ended here and retried as a transient failure, so the whole
 * call settles within `totalMs` plus one slack whatever `call` does. `onRetry` hears each failed
 * attempt's number and error before its backoff or the final `TransportFailure`.
 */
export async function withRetry<T>(
    what: string,
    policy: RetryPolicy,
    transient: Transient,
    call: (attemptMs: number) => Promise<T>,
    sleep: (ms: number) => Promise<void> = Bun.sleep,
    now: () => number = performance.now.bind(performance),
    onRetry?: (attempt: number, error: string) => void,
): Promise<T> {
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
        try {
            return await bounded(what, attemptMs + slackMs, call(attemptMs));
        } catch (caught) {
            if (!(caught instanceof AttemptOverdue) && !transient(caught)) throw caught;
            errors.push(caught instanceof Error ? caught.message : String(caught));
            onRetry?.(attempt, errors.at(-1) as string);
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
