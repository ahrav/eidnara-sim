import { withDeadline } from "./deadline";
import { HarnessFailure } from "./journal";

/**
 * Starts Bun's HTTP client thread and returns once one `fetch` has completed on it. Bun creates
 * the thread at a process's first `fetch`; its event loop then holds an epoll descriptor, a
 * timer, and the wakeup eventfd through which every later `fetch` and every abort reaches the
 * thread, for the life of the process.
 *
 * Bun 1.3.14 closes the descriptor number of a child's extra stdio pipe a second time when the
 * GC finalizes the child (oven-sh/bun#47561), and the Pi launch gate is such a pipe
 * (`PiSimHost.openSession`). A loop created after the first launch can take the freed gate
 * number for its eventfd; the second close then silences the thread, and every `fetch` after it
 * stays pending with its `AbortSignal` (`docs/run.md`, Undelivered turns). Called before the
 * first host launch, this gives the loop numbers that are held before any gate pipe exists, so
 * a gate number always names some other descriptor.
 */
export async function warmHttpClient(deadlineMs = 10_000): Promise<void> {
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(null, { status: 204 }),
    });
    try {
        const call = fetch(server.url, { keepalive: false }).then((r) => r.status);
        call.catch(() => undefined);
        const status = await withDeadline(call, deadlineMs);
        if (status !== 204) {
            throw new HarnessFailure(
                `the HTTP client's first request ended ${status ?? `pending past ${deadlineMs} ms`}`,
            );
        }
    } finally {
        await server.stop(true);
    }
}
