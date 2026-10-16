import { expect, test } from "bun:test";
import { join } from "node:path";
import { CACHE_DIR, cachePath, type Dataset, under } from "./sources";

const dataset: Dataset = {
    id: "d",
    repo: "r",
    revision: "v",
    license: "CC-BY-4.0",
    access: "public",
    files: [],
};

test("under resolves inside its root and rejects parent, absolute, and root-equal paths", () => {
    expect(under("/root", "a/../b")).toBe("/root/b");
    for (const path of ["../sib.rs", "/etc/passwd", ".", "a/../.."]) {
        expect(() => under("/root", path)).toThrow("escapes /root");
    }
});

test("cachePath nests files under the dataset revision and rejects paths that leave corpus/cache", () => {
    expect(cachePath(dataset, "data/x.parquet")).toBe(join(CACHE_DIR, "d", "v", "data/x.parquet"));
    expect(() => cachePath(dataset, "../../../escape")).toThrow("escapes");
    expect(() => cachePath({ ...dataset, id: ".." }, "f")).toThrow("escapes");
    expect(() => cachePath(dataset, "/etc/passwd")).toThrow("escapes");
});
