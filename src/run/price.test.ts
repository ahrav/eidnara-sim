import { expect, test } from "bun:test";
import { componentCosts } from "../report/cost";
import { CACHED_PRICE_TABLE, callUsd, isPriceTable, PRICE_TABLE, priceTableFor } from "./price";

const call = {
    input_tokens: 1_000,
    output_tokens: 2_000,
    cache_read_tokens: 500_000,
    cache_write_tokens: 40_000,
};

test("a caching-off run keeps the v1 table and a caching-on run takes the Opus 5.5 rates", () => {
    expect(priceTableFor("off")).toEqual({
        version: "v1",
        rates: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    });
    expect(priceTableFor("off")).toBe(PRICE_TABLE);
    expect(priceTableFor("on")).toBe(CACHED_PRICE_TABLE);
    expect(CACHED_PRICE_TABLE.rates).toEqual({
        input: 4,
        output: 20,
        cache_read: 0.2,
        cache_write: 5,
        cache_write_1h: 8,
    });
});

test("each token class of a call takes its own rate", () => {
    // 1,000 * 4 + 2,000 * 20 + 500,000 * 0.2 + 40,000 * 5, per million.
    expect(callUsd(call, CACHED_PRICE_TABLE.rates)).toBeCloseTo(0.344, 12);
    // 1,000 * 5 + 2,000 * 25 + 500,000 * 0.5 + 40,000 * 6.25, per million.
    expect(callUsd(call, PRICE_TABLE.rates)).toBeCloseTo(0.555, 12);
    const uncached = { ...call, cache_read_tokens: 0, cache_write_tokens: 0 };
    expect(callUsd(uncached, PRICE_TABLE.rates)).toBeCloseTo(0.055, 12);
});

test("1-hour cache writes take the 1-hour rate, and the 5-minute rate in a table without one", () => {
    const hour = { ...call, cache_write_1h_tokens: 10_000 };
    // 30,000 five-minute writes at 5 and 10,000 one-hour writes at 8.
    expect(
        callUsd(hour, CACHED_PRICE_TABLE.rates) - callUsd(call, CACHED_PRICE_TABLE.rates),
    ).toBeCloseTo(0.03, 12);
    expect(callUsd(hour, PRICE_TABLE.rates)).toBe(callUsd(call, PRICE_TABLE.rates));
});

test("a component's cost sums its calls' cache reads and writes at the table's rates", () => {
    const calls = [
        { component: "agent" as const, ...call },
        { component: "agent" as const, ...call, cache_write_1h_tokens: 40_000 },
        { component: "memory_capture" as const, ...call, cache_read_tokens: 0 },
    ];
    const [agent, capture] = componentCosts(calls, CACHED_PRICE_TABLE.rates);
    expect(agent).toMatchObject({ component: "agent", calls: 2, cache_read: 1_000_000 });
    // Two calls at 0.344, the second with its 40,000 writes at 8 in place of 5.
    expect(agent?.usd).toBeCloseTo(0.344 * 2 + 0.12, 12);
    expect(capture?.usd).toBeCloseTo(0.244, 12);
});

test("a price table names the four rates, and the 1-hour write rate at most", () => {
    expect(isPriceTable(PRICE_TABLE)).toBe(true);
    expect(isPriceTable(CACHED_PRICE_TABLE)).toBe(true);
    const rates = PRICE_TABLE.rates;
    for (const bad of [
        undefined,
        null,
        { version: "", rates },
        { version: "v", rates: { ...rates, cache_read: -1 } },
        { version: "v", rates: { ...rates, cache_write_1h: Number.NaN } },
        { version: "v", rates: { input: 1, output: 1, cache_read: 1 } },
        { version: "v", rates: { ...rates, batch: 1 } },
    ]) {
        expect(isPriceTable(bad)).toBe(false);
    }
});
