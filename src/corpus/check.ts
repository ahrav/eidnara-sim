import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../prereg/canonical";
import { cdfProblems, countProblems, GRID, quantile, tailShare } from "./cdf";
import {
    type CheckResult,
    compareCited,
    failedChecks,
    loadCited,
    loadDistributions,
    table,
} from "./distributions";
import { ERROR_CODE_FIELDS, entryProblems, parseJsonl, SAMPLE_FIELDS } from "./entries";
import { CATEGORY_NAMES, KINDS, QUANTITIES, TABLES, TRACELAB_FILES } from "./fit";
import { loadRepos, REPOS_DIR } from "./repos";
import { CORPUS_DIR, loadSources, parseJson } from "./sources";
import { OPENHANDS_FILE } from "./tool-outputs";

const SAMPLES_PER_KIND = 150;
const ERROR_CODES = 200;
const SAMPLE_KINDS = ["stack_trace", "test_run", "grep", "file_read"];
const SHA = /^[0-9a-f]{40}$/;
const REPO_LICENSES = new Set(["MIT", "Apache-2.0"]);
const OUTPUTS = [
    "distributions.json",
    "tool-outputs/error-codes.jsonl",
    "tool-outputs/samples.jsonl",
];
const BUILD_INPUTS: [string, readonly string[]][] = [
    ["tracelab", TRACELAB_FILES],
    ["openhands", [OPENHANDS_FILE]],
];
const CONTENT_CAP = 4000;
const CITED_CHECKS = [
    "append_tokens_per_step@0.5",
    "append_tokens_per_step@0.9",
    "idle_within_session_s@0.5",
    "idle_within_session_s@0.9",
    "idle_within_session_s@0.99",
    "requests_per_session@0.5",
    "requests_per_session@0.9",
    "requests_per_session@0.99",
];
const TAIL_CHECKS = ["append_tokens_per_step@10000"];

export interface CorpusReport {
    problems: string[];
    percentiles: CheckResult[];
}

export function checkCorpus(): CorpusReport {
    const problems: string[] = [];
    const need = (ok: boolean, problem: string) => ok || problems.push(problem);
    const read = (path: string) => readFileSync(join(CORPUS_DIR, path), "utf8");
    const manifest = parseJson<{
        schema?: string;
        files: Record<string, string>;
        datasets: unknown;
    }>(read("manifest.json"), "manifest.json");
    need(manifest.schema === "sim-corpus-manifest/v1", `manifest: schema ${manifest.schema}`);
    const files = manifest.files;
    const listed = Object.keys(files).sort().join(",");
    need(listed === OUTPUTS.join(","), `manifest: files ${listed}, need ${OUTPUTS.join(",")}`);
    const sources = loadSources();
    for (const [id, paths] of BUILD_INPUTS) {
        const dataset = sources.find((d) => d.id === id);
        need(dataset?.access === "public", `sources.json: build input ${id} must be public`);
        for (const path of paths) {
            const listed = dataset?.files.some((f) => f.path === path) ?? false;
            need(listed, `sources.json: ${id} must list ${path}`);
        }
    }
    const configured = sources.map((d) => ({ id: d.id, revision: d.revision, access: d.access }));
    need(
        JSON.stringify(manifest.datasets) === JSON.stringify(configured),
        "manifest: datasets differ from sources.json",
    );
    for (const [path, digest] of Object.entries(files)) {
        const actual = sha256Hex(read(path));
        need(actual === digest, `${path}: sha256 ${actual}, manifest ${digest}`);
    }

    const samples = parseJsonl(read("tool-outputs/samples.jsonl"));
    const codes = parseJsonl(read("tool-outputs/error-codes.jsonl"));
    need(codes.length === ERROR_CODES, `error codes: ${codes.length}, need ${ERROR_CODES}`);
    const codeNames = new Set(codes.map((c) => (c as { code?: string }).code?.trim()));
    need(codeNames.size === codes.length, "error codes: a name repeats");
    problems.push(
        ...entryProblems(samples, "samples", SAMPLE_FIELDS),
        ...entryProblems(codes, "error_codes", ERROR_CODE_FIELDS),
    );
    const byKind = new Map<string, number>();
    for (const s of samples) {
        const kind = String((s as { kind?: string }).kind);
        byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
    }
    need(
        [...byKind.keys()].every((k) => SAMPLE_KINDS.includes(k)),
        `samples: kinds ${[...byKind.keys()]}`,
    );
    for (const kind of SAMPLE_KINDS) {
        const n = byKind.get(kind) ?? 0;
        need(n === SAMPLES_PER_KIND, `samples: ${kind} has ${n}, need ${SAMPLES_PER_KIND}`);
    }
    const perTrajectory = samples.map((s) => {
        const e = s as { kind?: string; source_id?: string };
        return `${e.kind} ${e.source_id?.replace(/#\d+$/, "")}`;
    });
    need(new Set(perTrajectory).size === samples.length, "samples: a trajectory repeats a kind");
    for (const s of samples) {
        const e = s as { id?: string; content?: string; chars?: number; truncated?: boolean };
        const content = e.content ?? "";
        const sized = e.truncated
            ? content.length <= CONTENT_CAP && (e.chars ?? 0) > CONTENT_CAP
            : content.length === e.chars && content.length <= CONTENT_CAP;
        need(
            content.trim() !== "" && sized,
            `samples ${e.id}: content, chars, and truncated disagree`,
        );
    }
    for (const [label, entries] of [
        ["samples", samples],
        ["error_codes", codes],
    ] as const) {
        for (const entry of entries) {
            const e = entry as { id?: string; source_id?: string; license?: string };
            const dataset = sources.find((d) =>
                e.source_id?.startsWith(`${d.repo}@${d.revision}:`),
            );
            need(
                dataset?.id === "openhands" && dataset.license === e.license,
                `${label} ${e.id}: license ${e.license} for source ${e.source_id}`,
            );
        }
    }
    const named = codes.filter((c) => (c as { code?: string }).code?.trim());
    need(named.length === codes.length, "error codes: an entry has an empty code");

    const dist = loadDistributions();
    const quantityNames = Object.keys(dist.quantities).sort().join(",");
    need(
        quantityNames === QUANTITIES.join(","),
        `quantities: ${quantityNames}, need ${QUANTITIES.join(",")}`,
    );
    const tracelab = sources.find((d) => d.id === "tracelab");
    const origin = `${tracelab?.repo}@${tracelab?.revision}:`;
    for (const [name, q] of Object.entries(dist.quantities)) {
        const table = TABLES[name as keyof typeof TABLES];
        need(q.source === `${origin}${table}`, `${name}: source ${q.source}`);
        need(q.n > 0, `${name}: n missing`);
        const kind = KINDS[name as keyof typeof KINDS];
        need(q.cdf.kind === kind, `${name}: cdf kind ${q.cdf.kind}, need ${kind}`);
        const floor = name === "tool_steps_per_request" ? 1 : 0;
        need(
            q.cdf.x.every((v) => v >= floor),
            `${name}: values must be at least ${floor}`,
        );
        if (q.cdf.kind === "discrete") {
            need(q.cdf.x.every(Number.isSafeInteger), `${name}: discrete values must be integers`);
            problems.push(...countProblems(q.cdf, q.n).map((why) => `${name}: ${why}`));
        } else {
            need(q.cdf.p.join(",") === GRID.join(","), `${name}: p must be the fit grid`);
        }
        problems.push(...cdfProblems(q.cdf).map((why) => `${name}: ${why}`));
    }
    const mix = dist.tool_mix;
    need(mix?.source === `${origin}tool_calls`, `tool_mix: source ${mix?.source}`);
    need(mix?.n > 0, "tool_mix: n missing");
    const names = (mix?.categories ?? []).map((c) => c.category).sort();
    need(names.join(",") === CATEGORY_NAMES.join(","), `tool_mix: categories ${names}`);
    const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
    let counted = 0;
    for (const c of mix?.categories ?? []) {
        const count = Math.round(c.share * mix.n);
        const errors = Math.round(c.error_rate * count);
        counted += count;
        need(
            count > 0 &&
                round6(count / mix.n) === c.share &&
                round6(errors / count) === c.error_rate,
            `tool_mix: ${c.category} share or error_rate is not a count over n`,
        );
        need(Array.isArray(c.tools), `tool_mix: ${c.category} tools`);
    }
    need(counted === mix?.n, `tool_mix: category counts total ${counted}, n is ${mix?.n}`);
    const tools = (mix?.categories ?? []).flatMap((c) => c.tools);
    need(new Set(tools).size === tools.length, "tool_mix: a tool appears in two categories");
    const cited = loadCited();
    const citedKeys = cited.checks
        .map((c) => `${c.quantity}@${c.q}`)
        .sort()
        .join(",");
    need(citedKeys === CITED_CHECKS.join(","), `cited checks: ${citedKeys}`);
    const tailKeys = cited.tail_checks
        .map((t) => `${t.quantity}@${t.threshold}`)
        .sort()
        .join(",");
    need(tailKeys === TAIL_CHECKS.join(","), `tail checks: ${tailKeys}`);
    const percentiles = compareCited(cited, (name, q) => quantile(table(dist, name), q));
    for (const r of failedChecks(percentiles)) {
        const why = r.within ? "is in band but carries a deviation" : "out of band";
        problems.push(
            `${r.quantity} p${r.q * 100}: measured ${r.measured}, cited ${r.cited} ${why}`,
        );
    }
    for (const tail of cited.tail_checks) {
        const share = tailShare(table(dist, tail.quantity), tail.threshold);
        need(share >= tail.min_share, `${tail.quantity}: share >= ${tail.threshold} is ${share}`);
    }

    const repos = loadRepos();
    need(repos.length >= 2 && repos.length <= 3, `repos: ${repos.length}, need 2 to 3`);
    for (const repo of repos) {
        need(SHA.test(repo.commit), `${repo.id}: commit not a SHA`);
        need(SHA.test(repo.twin.commit), `${repo.twin.id}: commit not a SHA`);
        need(REPO_LICENSES.has(repo.license), `${repo.id}: license ${repo.license}`);
        need(existsSync(join(REPOS_DIR, `${repo.id}.LICENSE`)), `${repo.id}: license copy missing`);
    }
    const roles = new Set(repos.map((r) => r.role));
    need(
        roles.has("rust-service") && roles.has("typescript-package"),
        "repos: need one rust-service and one typescript-package",
    );
    return { problems, percentiles };
}
