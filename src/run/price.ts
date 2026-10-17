/** USD per million tokens. */
export interface Price {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
}

export interface PriceTable {
    version: string;
    rates: Price;
}

/** The table a run records in its manifest; one set of rates for every model. */
export const PRICE_TABLE: PriceTable = {
    version: "v1",
    rates: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
};
