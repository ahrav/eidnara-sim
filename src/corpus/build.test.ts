import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderJson } from "./build";
import { CORPUS_DIR } from "./sources";

test("renderJson compacts numeric arrays and leaves bracketed prose alone", () => {
    const out = renderJson({ a: "keep [ 1, 2 ] exact", b: [1, 2.5, -3e-7], c: [], d: ["x"] });
    expect(out).toContain('"a": "keep [ 1, 2 ] exact"');
    expect(out).toContain('"b": [1, 2.5, -3e-7]');
    expect(out).toContain('"c": []');
    expect(out).toContain('"d": [\n        "x"\n    ]');
});

test("renderJson reproduces the committed corpus files byte for byte", () => {
    for (const file of ["distributions.json", "manifest.json", "repos.json"]) {
        const text = readFileSync(join(CORPUS_DIR, file), "utf8");
        expect(renderJson(JSON.parse(text))).toBe(text);
    }
});
