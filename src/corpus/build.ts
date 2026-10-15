import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../prereg/canonical";
import { fitTraceLab } from "./fit";
import { CORPUS_DIR, type Dataset } from "./sources";
import { extractToolOutputs } from "./tool-outputs";

export const DISTRIBUTIONS_SCHEMA = "sim-corpus-distributions/v1";
export const MANIFEST_SCHEMA = "sim-corpus-manifest/v1";

export function renderJson(value: unknown): string {
    return `${JSON.stringify(value, null, 4).replace(
        /\[\s+([-\d.e,\s]+?)\s+\]/g,
        (_m, body: string) => `[${body.split(/,\s+/).join(", ")}]`,
    )}\n`;
}

function jsonl(entries: readonly unknown[]): string {
    return entries.map((e) => `${JSON.stringify(e)}\n`).join("");
}

function byId(datasets: Dataset[], id: string): Dataset {
    const dataset = datasets.find((d) => d.id === id);
    if (dataset === undefined) throw new Error(`sources.json: dataset ${id} missing`);
    return dataset;
}

export async function buildCorpus(datasets: Dataset[]): Promise<Map<string, string>> {
    const tracelab = byId(datasets, "tracelab");
    const openhands = byId(datasets, "openhands");
    const fit = await fitTraceLab(tracelab);
    const rates = JSON.parse(readFileSync(join(CORPUS_DIR, "published-rates.json"), "utf8"));
    const extraction = await extractToolOutputs(openhands);

    const files = new Map<string, string>();
    files.set(
        "distributions.json",
        renderJson({
            schema: DISTRIBUTIONS_SCHEMA,
            quantities: fit.quantities,
            tool_mix: fit.tool_mix,
            rates: { source: rates.source, note: rates.note, ...rates.rates },
        }),
    );
    files.set("tool-outputs/samples.jsonl", jsonl(extraction.samples));
    files.set("tool-outputs/error-codes.jsonl", jsonl(extraction.error_codes));
    const digests = Object.fromEntries([...files].map(([path, text]) => [path, sha256Hex(text)]));
    files.set(
        "manifest.json",
        renderJson({
            schema: MANIFEST_SCHEMA,
            datasets: datasets.map((d) => ({ id: d.id, revision: d.revision, access: d.access })),
            files: digests,
        }),
    );
    return files;
}
