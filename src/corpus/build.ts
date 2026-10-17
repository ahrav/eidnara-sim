import { sha256Hex } from "../prereg/canonical";
import { loadRates } from "./distributions";
import { fitTraceLab } from "./fit";
import type { Dataset } from "./sources";
import { extractToolOutputs } from "./tool-outputs";

export function renderJson(value: unknown): string {
    return `${render(value, 0)}\n`;
}

function render(value: unknown, depth: number): string {
    const inner = " ".repeat(4 * (depth + 1));
    const outer = " ".repeat(4 * depth);
    if (Array.isArray(value)) {
        if (value.length === 0) return "[]";
        if (value.every((n) => typeof n === "number")) {
            return `[${value.map((n) => JSON.stringify(n)).join(", ")}]`;
        }
        const items = value.map((v) => `${inner}${render(v ?? null, depth + 1)}`);
        return `[\n${items.join(",\n")}\n${outer}]`;
    }
    if (value !== null && typeof value === "object") {
        const entries = Object.entries(value).filter(([, v]) => v !== undefined);
        if (entries.length === 0) return "{}";
        const items = entries.map(
            ([k, v]) => `${inner}${JSON.stringify(k)}: ${render(v, depth + 1)}`,
        );
        return `{\n${items.join(",\n")}\n${outer}}`;
    }
    return JSON.stringify(value);
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
