import { sha256Hex } from "../prereg/canonical";
import { loadRates } from "./distributions";
import { fitTraceLab } from "./fit";
import type { Dataset } from "./sources";
import { extractToolOutputs } from "./tool-outputs";

const MARK = /"@@numbers:(\d+)@@"/g;

export function renderJson(value: unknown): string {
    const compact: string[] = [];
    const text = JSON.stringify(
        value,
        (_key, v: unknown) => {
            const numeric =
                Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "number");
            if (!numeric) return v;
            compact.push(`[${(v as number[]).map((n) => JSON.stringify(n)).join(", ")}]`);
            return `@@numbers:${compact.length - 1}@@`;
        },
        4,
    );
    return `${text.replace(MARK, (_m, i: string) => compact[Number(i)] ?? "[]")}\n`;
}

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
