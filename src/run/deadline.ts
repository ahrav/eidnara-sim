/** Clearing the deadline timer lets the runtime exit once `promise` settles. */
export function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
    });
    return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}
