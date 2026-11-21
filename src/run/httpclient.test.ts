import { afterEach, expect, test } from "bun:test";
import { warmHttpClient } from "./httpclient";
import { HarnessFailure } from "./journal";

const realFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = realFetch;
});

test("the warm-up completes one request on the HTTP client and leaves fetch working", async () => {
    await warmHttpClient();
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    try {
        expect(await (await fetch(server.url, { keepalive: false })).text()).toBe("ok");
    } finally {
        await server.stop(true);
    }
});

test("a warm-up whose request stays pending fails the start at its deadline", async () => {
    globalThis.fetch = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const started = performance.now();
    const failure = warmHttpClient(50);
    await expect(failure).rejects.toBeInstanceOf(HarnessFailure);
    await expect(failure).rejects.toThrow("first request ended pending past 50 ms");
    expect(performance.now() - started).toBeLessThan(2_000);
});

test("a warm-up answered with another status fails the start", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 502 })) as unknown as typeof fetch;
    await expect(warmHttpClient(50)).rejects.toThrow("first request ended 502");
});
