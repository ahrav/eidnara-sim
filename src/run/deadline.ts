/** The largest delay a JavaScript timer honors; longer values fire at once. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Resolves as `promise` does, or with null once `ms` (at most `MAX_TIMER_MS`) pass with it
 * pending. Clearing the deadline timer lets the runtime exit once `promise` settles.
 */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), Math.min(ms, MAX_TIMER_MS));
    });
    return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}
