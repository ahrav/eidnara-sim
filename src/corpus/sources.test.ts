import { expect, test } from "bun:test";
import { join } from "node:path";
import { CACHE_DIR, cachePath, type Dataset } from "./sources";

const dataset: Dataset = {
    id: "d",
    repo: "r",
    revision: "v",
    license: "CC-BY-4.0",
    access: "public",
    files: [],
};

test("cachePath nests files under the dataset revision and rejects paths that leave corpus/cache", () => {
    expect(cachePath(dataset, "data/x.parquet")).toBe(join(CACHE_DIR, "d", "v", "data/x.parquet"));
    expect(() => cachePath(dataset, "../../../escape")).toThrow("escapes corpus/cache");
    expect(() => cachePath({ ...dataset, id: ".." }, "f")).toThrow("escapes corpus/cache");
    expect(() => cachePath(dataset, "/etc/passwd")).toThrow("escapes corpus/cache");
});
