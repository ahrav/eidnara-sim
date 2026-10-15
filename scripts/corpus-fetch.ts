import { fetchDataset, loadSources } from "../src/corpus/sources";

for (const dataset of loadSources()) await fetchDataset(dataset);
