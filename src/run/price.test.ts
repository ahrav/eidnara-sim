import { expect, test } from "bun:test";
import { componentCosts } from "../report/cost";
import {
    CACHED_PRICE_TABLE,
    CACHED_SIDE_PRICE_TABLE,
    callUsd,
    isModelPrices,
    isPriceTable,
    PRICE_TABLE,
    pricedByCachedTable,
    priceTableFor,
    ratesFor,
} from "./price";

const OPUS = "global.anthropic.claude-opus-5-5";
const HAIKU = "global.anthropic.claude-haiku-5-5";
const STAGE1 = { memory_reviewer_stage1: HAIKU };

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

test("the cached table prices Claude Opus 5.5 through the global profile and no other model", () => {
    expect(pricedByCachedTable("global.anthropic.claude-opus-5-5")).toBe(true);
    expect(pricedByCachedTable("global.anthropic.claude-opus-5-5-v1:0")).toBe(true);
    for (const other of [
        "us.anthropic.claude-opus-5-5",
        "anthropic.claude-opus-5-5",
        "global.anthropic.claude-opus-5-50",
        "global.anthropic.claude-opus-5-5x",
        "global.anthropic.claude-opus-5-5-fast",
        "global.anthropic.claude-opus-5",
        "global.anthropic.claude-haiku-5-5",
    ]) {
        expect(pricedByCachedTable(other)).toBe(false);
    }
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
    const [agent, capture] = componentCosts(calls, CACHED_PRICE_TABLE);
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

test("a caching-on run without a priced side model keeps the v2 table byte for byte", () => {
    const v2 =
        '{"version":"v2-opus-5-5-global-2026-11","rates":{"input":4,"output":20,"cache_read":0.2,"cache_write":5,"cache_write_1h":8}}';
    for (const none of [undefined, null, {}]) {
        expect(priceTableFor("on", none)).toBe(CACHED_PRICE_TABLE);
        expect(JSON.stringify(priceTableFor("on", none))).toBe(v2);
    }
    // An Opus 5.5 side model takes the default rates, so the run needs no rates by model.
    expect(priceTableFor("on", { memory_reviewer_stage1: OPUS })).toBe(CACHED_PRICE_TABLE);
    // The caching-off table holds one set of rates for every model, with or without side models.
    expect(priceTableFor("off", STAGE1)).toBe(PRICE_TABLE);
    expect(JSON.stringify(PRICE_TABLE)).toBe(
        '{"version":"v1","rates":{"input":5,"output":25,"cache_read":0.5,"cache_write":6.25}}',
    );
});

test("a caching-on run with the registered Haiku side model takes the v3 table", () => {
    expect(priceTableFor("on", STAGE1)).toEqual({
        version: "v3-opus-5-5-haiku-5-5-global-2026-11",
        rates: { input: 4, output: 20, cache_read: 0.2, cache_write: 5, cache_write_1h: 8 },
        models: {
            "global.anthropic.claude-haiku-5-5": {
                input: 0.1,
                output: 0.5,
                cache_read: 0.01,
                cache_write: 0.125,
                cache_write_1h: 0.2,
            },
        },
    });
    expect(priceTableFor("on", STAGE1)).toBe(CACHED_SIDE_PRICE_TABLE);
    expect(CACHED_SIDE_PRICE_TABLE.rates).toEqual(CACHED_PRICE_TABLE.rates);
    expect(isPriceTable(CACHED_SIDE_PRICE_TABLE)).toBe(true);
});

test("the cached table admits the main model as before and a registered side model it lists", () => {
    expect(pricedByCachedTable(HAIKU)).toBe(false);
    expect(pricedByCachedTable(HAIKU, null)).toBe(false);
    expect(pricedByCachedTable(HAIKU, {})).toBe(false);
    expect(pricedByCachedTable(HAIKU, STAGE1)).toBe(true);
    expect(pricedByCachedTable(OPUS, STAGE1)).toBe(true);
    expect(pricedByCachedTable(`${OPUS}-v1:0`, STAGE1)).toBe(true);
    // A registered side model the table lists no rates for stays refused, with or without Haiku.
    const sonnet = "global.anthropic.claude-sonnet-5-5";
    expect(pricedByCachedTable(sonnet, { memory_reviewer_stage1: sonnet })).toBe(false);
    for (const other of ["us.anthropic.claude-haiku-5-5", `${HAIKU}-v1:0`, sonnet, "toString"]) {
        expect(pricedByCachedTable(other, STAGE1)).toBe(false);
    }
    // Registering Opus as the side model lists no rate for Haiku.
    expect(pricedByCachedTable(HAIKU, { memory_reviewer_stage1: OPUS })).toBe(false);
});

test("a call takes its model's rates when the table lists them and the default rates otherwise", () => {
    const v3 = CACHED_SIDE_PRICE_TABLE;
    expect(ratesFor(v3, HAIKU)).toBe(v3.models[HAIKU]);
    for (const model of [OPUS, "global.openai.gpt-5.6-luna", "", "constructor", undefined]) {
        expect(ratesFor(v3, model)).toBe(v3.rates);
    }
    for (const table of [PRICE_TABLE, CACHED_PRICE_TABLE]) {
        expect(ratesFor(table, HAIKU)).toBe(table.rates);
        expect(ratesFor({ ...table, models: {} }, HAIKU)).toBe(table.rates);
    }
});

const record = (component: "agent" | "memory_reviewer_stage1" | "user-sim", model?: string) => ({
    component,
    ...(model === undefined ? {} : { model }),
    ...call,
    cache_write_1h_tokens: 10_000,
});

test("a v1 or v2 table prices every record at its one set of rates, whatever model it names", () => {
    const calls = [
        record("agent", OPUS),
        record("memory_reviewer_stage1", HAIKU),
        record("user-sim", HAIKU),
        record("user-sim", "global.openai.gpt-5.6-luna"),
        record("agent"),
    ];
    for (const table of [PRICE_TABLE, CACHED_PRICE_TABLE]) {
        const rows = componentCosts(calls, table);
        // Each record costs what `callUsd` gives it at the table's rates, the dollars a table
        // without `models` produced before rates by model existed.
        const each = callUsd(calls[0] as (typeof calls)[number], table.rates);
        // 0.555 at v1; at v2 0.344 plus 10,000 of the writes at 8 in place of 5.
        expect(each).toBeCloseTo(table === PRICE_TABLE ? 0.555 : 0.374, 12);
        expect(Object.fromEntries(rows.map((r) => [r.component, r.usd]))).toEqual({
            agent: each + each,
            "user-sim": each + each,
            memory_reviewer_stage1: each,
        });
        expect(rows.reduce((n, r) => n + r.calls, 0)).toBe(5);
    }
});

test("the v3 table prices a Haiku record at Haiku's rates and every other record at the v2 rates", () => {
    const stage1 = {
        component: "memory_reviewer_stage1" as const,
        model: HAIKU,
        input_tokens: 458,
        output_tokens: 250,
        cache_read_tokens: 1_042,
        cache_write_tokens: 0,
    };
    const stage2 = { ...stage1, component: "memory_reviewer_stage2" as const, model: OPUS };
    const rows = componentCosts([stage1, stage2], CACHED_SIDE_PRICE_TABLE);
    const usd = Object.fromEntries(rows.map((r) => [r.component, r.usd]));
    expect(usd.memory_reviewer_stage1).toBeCloseTo(
        (458 * 0.1 + 1_042 * 0.01 + 250 * 0.5) / 1e6,
        15,
    );
    expect(usd.memory_reviewer_stage1).toBeCloseTo(0.00018122, 12);
    // The same tokens on Opus 5.5 take the default rates, as under v2.
    expect(usd.memory_reviewer_stage2).toBe(callUsd(stage2, CACHED_PRICE_TABLE.rates));
    expect(usd.memory_reviewer_stage2).toBeCloseTo((458 * 4 + 1_042 * 0.2 + 250 * 20) / 1e6, 15);
    // Each reviewer stage is a row of its own, with its calls and tokens.
    expect(rows.map((r) => [r.component, r.calls, r.input, r.output, r.cache_read])).toEqual([
        ["memory_reviewer_stage2", 1, 458, 250, 1_042],
        ["memory_reviewer_stage1", 1, 458, 250, 1_042],
    ]);
    // Haiku's 1-hour cache writes take its own 1-hour rate.
    const hour = { ...stage1, cache_write_tokens: 1_000, cache_write_1h_tokens: 400 };
    const [written] = componentCosts([hour], CACHED_SIDE_PRICE_TABLE);
    expect((written?.usd ?? 0) - (usd.memory_reviewer_stage1 ?? 0)).toBeCloseTo(
        (600 * 0.125 + 400 * 0.2) / 1e6,
        15,
    );
});

test("a table's rates by model are held to the shape of its default rates", () => {
    const rates = PRICE_TABLE.rates;
    expect(isPriceTable({ version: "v", rates, models: {} })).toBe(true);
    expect(isPriceTable({ version: "v", rates, models: { m: rates } })).toBe(true);
    expect(isModelPrices({ m: rates, n: { ...rates, cache_write_1h: 9 } })).toBe(true);
    for (const models of [
        null,
        [],
        [rates],
        "m",
        { m: null },
        { m: { input: 1, output: 1, cache_read: 1 } },
        { m: { ...rates, output: -1 } },
        { m: { ...rates, batch: 1 } },
        { m: [rates] },
        { "": rates },
    ]) {
        expect(isModelPrices(models)).toBe(false);
        expect(isPriceTable({ version: "v", rates, models })).toBe(false);
    }
    expect(isPriceTable({ version: "v", rates: [rates] })).toBe(false);
});
