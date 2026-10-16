import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../prereg/canonical";
import { loadRates } from "./distributions";
import { fitTraceLab } from "./fit";
import { CORPUS_DIR, type Dataset } from "./sources";
import { extractToolOutputs } from "./tool-outputs";

export function renderJson(value: unknown): string {
    return `${JSON.stringify(value, null, 4).replace(
        /\[\s+([-\d.e,\s]+?)\s+\]/g,
        (_m, body: string) => `[${body.split(/,\s+/).join(", ")}]`,
    )}\n`;
}

/** Hand-authored corpus inputs the scenario compiler reads; the manifest digests them beside the derived files. */
const AUTHORED_FILES = ["fact-bank.json", "repos.json"] as const;

const jsonl = (entries: readonly unknown[]) =>
    entries.map((e) => `${JSON.stringify(e)}\n`).join("");

function byId(datasets: Dataset[], id: string): Dataset {
    const dataset = datasets.find((d) => d.id === id);
    if (dataset === undefined) throw new Error(`sources.json: dataset ${id} missing`);
    return dataset;
}

export async function buildCorpus(datasets: Dataset[]): Promise<Map<string, string>> {
    const fit = await fitTraceLab(byId(datasets, "tracelab"));
    const rates = loadRates();
    const extraction = await extractToolOutputs(byId(datasets, "openhands"));

    const files = new Map<string, string>();
    files.set(
        "distributions.json",
        renderJson({
            schema: "sim-corpus-distributions/v1",
            quantities: fit.quantities,
            tool_mix: fit.tool_mix,
            rates: { source: rates.source, note: rates.note, ...rates.rates },
        }),
    );
    files.set("tool-outputs/samples.jsonl", jsonl(extraction.samples));
    files.set("tool-outputs/error-codes.jsonl", jsonl(extraction.error_codes));
    const digests = Object.fromEntries([...files].map(([path, text]) => [path, sha256Hex(text)]));
    for (const authored of AUTHORED_FILES) {
        digests[authored] = sha256Hex(readFileSync(join(CORPUS_DIR, authored), "utf8"));
    }
    files.set(
        "manifest.json",
        renderJson({
            schema: "sim-corpus-manifest/v1",
            datasets: datasets.map((d) => ({ id: d.id, revision: d.revision, access: d.access })),
            files: digests,
        }),
    );
    return files;
}
