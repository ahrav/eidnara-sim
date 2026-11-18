import type { PromptCaching } from "../hosts/profiles";

/** USD per million tokens. */
export interface Price {
    input: number;
    output: number;
    cache_read: number;
    /** A cache write with the default 5-minute lifetime. */
    cache_write: number;
    /** A cache write with the 1-hour lifetime; `cache_write` prices it in a table without the rate. */
    cache_write_1h?: number;
}

export interface PriceTable {
    version: string;
    rates: Price;
}

/**
 * The table a run with prompt caching off records in its manifest; one set of rates for every
 * model. The rates are the list prices of Claude Opus 5 and 4.8, which every campaign through
 * W2S2 was priced at, so a caching-off run stays comparable with them.
 */
export const PRICE_TABLE: PriceTable = {
    version: "v1",
    rates: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
};

/**
 * The table a run with prompt caching on records: Claude Opus 5.5 on Bedrock through the global
 * inference profile, from the AWS price list of 2026-11-09 (`docs/report.md`, Cost). A cache read
 * costs 0.05 of the input rate here and 0.1 in `PRICE_TABLE`, so the two tables rank arms
 * differently once requests carry cache points.
 */
export const CACHED_PRICE_TABLE: PriceTable = {
    version: "v2-opus-5-5-global-2026-11",
    rates: { input: 4, output: 20, cache_read: 0.2, cache_write: 5, cache_write_1h: 8 },
};

const RATES = ["input", "output", "cache_read", "cache_write"] as const;

/** Whether `table` is a versioned table whose rates are the four required ones, and the 1-hour write rate when named, each finite and non-negative. */
export function isPriceTable(table: unknown): table is PriceTable {
    const t = table as Partial<PriceTable> | null | undefined;
    const rates = t?.rates as Record<string, unknown> | null | undefined;
    if (typeof t?.version !== "string" || t.version === "") return false;
    if (typeof rates !== "object" || rates === null) return false;
    const rate = (k: string) =>
        typeof rates[k] === "number" && Number.isFinite(rates[k]) && (rates[k] as number) >= 0;
    const known: readonly string[] = [...RATES, "cache_write_1h"];
    return RATES.every(rate) && Object.keys(rates).every((k) => known.includes(k) && rate(k));
}

export const priceTableFor = (caching: PromptCaching): PriceTable =>
    caching === "on" ? CACHED_PRICE_TABLE : PRICE_TABLE;

/** The token counts of one call record that a price applies to. */
export interface CallTokens {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    /** Every token the call wrote to the cache, the 1-hour writes included. */
    cache_write_tokens: number;
    /** Of `cache_write_tokens`, the tokens written with the 1-hour lifetime. */
    cache_write_1h_tokens?: number;
}

/**
 * The USD cost of one call at `price`. The provider reports `input_tokens` without the tokens it
 * read from or wrote to the cache, so the four counts are disjoint and each takes its own rate.
 */
export function callUsd(c: CallTokens, price: Price): number {
    const hour = c.cache_write_1h_tokens ?? 0;
    return (
        (c.input_tokens * price.input +
            c.output_tokens * price.output +
            c.cache_read_tokens * price.cache_read +
            (c.cache_write_tokens - hour) * price.cache_write +
            hour * (price.cache_write_1h ?? price.cache_write)) /
        1e6
    );
}
