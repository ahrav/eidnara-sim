import { expect, test } from "bun:test";
import { join } from "node:path";
import { CACHE_DIR, cachePath, type Dataset, fetchDataset, under } from "./sources";

const dataset: Dataset = {
    id: "d",
    repo: "r",
    revision: "v",
    license: "CC-BY-4.0",
    access: "public",
    files: [
        { path: "data/x.parquet", sha256: "0".repeat(64) },
        { path: "../../../escape", sha256: "" },
    ],
};

test("under resolves inside its root and rejects parent, absolute, and root-equal paths", () => {
    expect(under("/root", "a/../b")).toBe("/root/b");
    for (const path of ["../sib.rs", "/etc/passwd", ".", "a/../.."]) {
        expect(() => under("/root", path)).toThrow("escapes /root");
    }
});

test("fetchDataset skips a gated dataset and refuses an unknown access mode", async () => {
    const logs: string[] = [];
    await fetchDataset({ ...dataset, access: "gated" }, (line) => logs.push(line));
    expect(logs).toEqual(["d: gated, skipped"]);
    await expect(fetchDataset({ ...dataset, access: "publci" as never }, () => {})).rejects.toThrow(
        'access "publci"',
    );
});

test("cachePath nests files under the dataset revision and rejects paths that leave corpus/cache", () => {
    expect(cachePath(dataset, "data/x.parquet")).toBe(join(CACHE_DIR, "d", "v", "data/x.parquet"));
    expect(() => cachePath(dataset, "../../../escape")).toThrow("escapes");
    expect(() => cachePath({ ...dataset, id: ".." }, "data/x.parquet")).toThrow("escapes");
    expect(() => cachePath(dataset, "/etc/passwd")).toThrow("does not list");
    expect(() => cachePath(dataset, "data/other.parquet")).toThrow("does not list");
});
