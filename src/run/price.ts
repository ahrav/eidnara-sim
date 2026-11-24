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
    /** The rates of every call whose model `models` leaves out. */
    rates: Price;
    /** Rates by model id; a call whose record names a listed model takes that model's rates. */
    models?: Record<string, Price>;
}

/** The part of a price table that prices a call: the default rates and the rates by model. */
export type Rates = Pick<PriceTable, "rates" | "models">;

/** The rates `table` holds for a call of `model`: the model's own when listed, else `rates`. */
export function ratesFor(table: Rates, model: string | undefined): Price {
    const listed = table.models;
    return model !== undefined && listed && Object.hasOwn(listed, model)
        ? (listed[model] as Price)
        : table.rates;
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

/**
 * The table a run with prompt caching on records when its registration names a side model with
 * rates of its own (`side_models`, `docs/run-command.md`): the `CACHED_PRICE_TABLE` rates for
 * every model it leaves out, and the rates of Claude Haiku 5.5 through the global inference
 * profile at standard context, from the AWS price list bulk file
 * `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/us-west-2/index.json`
 * published 2026-11-23T09:58:41Z (`docs/report.md`, Cost). The model's long-context rates are
 * a separate entry of that file, five times these; a stage-1 request of the memory reviewer
 * sends about 1,500 to 4,300 prompt tokens and is priced at the standard-context rates.
 */
export const CACHED_SIDE_PRICE_TABLE = {
    version: "v3-opus-5-5-haiku-5-5-global-2026-11",
    rates: CACHED_PRICE_TABLE.rates,
    models: {
        "global.anthropic.claude-haiku-5-5": {
            input: 0.1,
            output: 0.5,
            cache_read: 0.01,
            cache_write: 0.125,
            cache_write_1h: 0.2,
        },
    },
} satisfies PriceTable;

const RATES = ["input", "output", "cache_read", "cache_write"] as const;
const KNOWN_RATES: readonly string[] = [...RATES, "cache_write_1h"];

/** Whether `price` names the four required rates, and the 1-hour write rate at most, each finite and non-negative. */
function isPrice(price: unknown): price is Price {
    if (typeof price !== "object" || price === null || Array.isArray(price)) return false;
    const rates = price as Record<string, unknown>;
    const rate = (k: string) =>
        typeof rates[k] === "number" && Number.isFinite(rates[k]) && (rates[k] as number) >= 0;
    return RATES.every(rate) && Object.keys(rates).every((k) => KNOWN_RATES.includes(k) && rate(k));
}

/** Whether `models` maps model ids to rates: an object whose every key is a name and every value a `Price`. */
export function isModelPrices(models: unknown): models is Record<string, Price> {
    if (typeof models !== "object" || models === null || Array.isArray(models)) return false;
    return Object.entries(models).every(([model, price]) => model !== "" && isPrice(price));
}

/**
 * Whether `table` is a versioned table whose default rates are the four required ones, and the
 * 1-hour write rate when named, each finite and non-negative, and whose `models`, when present,
 * hold such rates per model id.
 */
export function isPriceTable(table: unknown): table is PriceTable {
    const t = table as Partial<PriceTable> | null | undefined;
    if (typeof t?.version !== "string" || t.version === "") return false;
    return isPrice(t.rates) && (t.models === undefined || isModelPrices(t.models));
}

/** A registration's side models, by the role each serves (`side_models`); null or absent for none. */
export type SideModelIds = Readonly<Record<string, string>> | null | undefined;

/**
 * The table a run records when it starts. A caching-off run takes `PRICE_TABLE`, which holds one
 * set of rates for every model. A caching-on run takes `CACHED_PRICE_TABLE`, or
 * `CACHED_SIDE_PRICE_TABLE` when a registered side model has rates of its own there.
 */
export function priceTableFor(caching: PromptCaching, sideModels?: SideModelIds): PriceTable {
    if (caching !== "on") return PRICE_TABLE;
    const own = Object.values(sideModels ?? {}).some((model) =>
        Object.hasOwn(CACHED_SIDE_PRICE_TABLE.models, model),
    );
    return own ? CACHED_SIDE_PRICE_TABLE : CACHED_PRICE_TABLE;
}

/**
 * Whether the table of a caching-on run with `sideModels` holds `model`'s rates. The default
 * rates are those of Claude Opus 5.5 through the global inference profile; the in-Region
 * profiles cost 10% more, and every other model has rates of its own, which the table holds for
 * a registered side model it lists (`priceTableFor`).
 */
export const pricedByCachedTable = (model: string, sideModels?: SideModelIds): boolean =>
    /^global\.anthropic\.claude-opus-5-5(-v\d+(:\d+)?)?$/.test(model) ||
    Object.hasOwn(priceTableFor("on", sideModels).models ?? {}, model);

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
