import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildCorpus } from "../src/corpus/build";
import { CORPUS_DIR, fetchDataset, loadSources } from "../src/corpus/sources";

const datasets = loadSources();
for (const dataset of datasets) await fetchDataset(dataset);
for (const [path, text] of await buildCorpus(datasets)) {
    const dest = join(CORPUS_DIR, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
    console.log(`wrote corpus/${path}`);
}
