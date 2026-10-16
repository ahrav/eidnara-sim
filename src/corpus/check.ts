import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../prereg/canonical";
import { cdfProblems, GRID, quantile, tailShare } from "./cdf";
import {
    type CheckResult,
    compareCited,
    failedChecks,
    loadCited,
    loadDistributions,
    table,
} from "./distributions";
import { ERROR_CODE_FIELDS, entryProblems, parseJsonl, SAMPLE_FIELDS } from "./entries";
import { QUANTITIES } from "./fit";
import { loadRepos, REPOS_DIR } from "./repos";
import { CORPUS_DIR, loadSources } from "./sources";

const SAMPLES_PER_KIND = 150;
const ERROR_CODES = 200;
const KINDS = ["stack_trace", "test_run", "grep", "file_read"];
const SHA = /^[0-9a-f]{40}$/;
const REPO_LICENSES = new Set(["MIT", "Apache-2.0"]);
const OUTPUTS = [
    "distributions.json",
    "fact-bank.json",
    "repos.json",
    "tool-outputs/error-codes.jsonl",
    "tool-outputs/samples.jsonl",
];
const CDF_KINDS = new Set(["discrete", "continuous"]);
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
    const manifest = JSON.parse(read("manifest.json"));
    need(manifest.schema === "sim-corpus-manifest/v1", `manifest: schema ${manifest.schema}`);
    const files = manifest.files as Record<string, string>;
    const listed = Object.keys(files).sort().join(",");
    need(listed === OUTPUTS.join(","), `manifest: files ${listed}, need ${OUTPUTS.join(",")}`);
    const sources = loadSources();
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
        [...byKind.keys()].every((k) => KINDS.includes(k)),
        `samples: kinds ${[...byKind.keys()]}`,
    );
    for (const kind of KINDS) {
        const n = byKind.get(kind) ?? 0;
        need(n === SAMPLES_PER_KIND, `samples: ${kind} has ${n}, need ${SAMPLES_PER_KIND}`);
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
                dataset !== undefined && dataset.license === e.license,
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
        need(
            typeof q.source === "string" && q.source.startsWith(origin),
            `${name}: source ${q.source}`,
        );
        need(q.n > 0, `${name}: n missing`);
        need(CDF_KINDS.has(q.cdf.kind), `${name}: cdf kind ${q.cdf.kind}`);
        if (q.cdf.kind === "discrete") {
            const counts = q.cdf.x.every((v) => Number.isSafeInteger(v) && v >= 0);
            need(counts, `${name}: discrete values must be non-negative integers`);
        } else {
            need(q.cdf.p.join(",") === GRID.join(","), `${name}: p must be the fit grid`);
        }
        problems.push(...cdfProblems(q.cdf).map((why) => `${name}: ${why}`));
    }
    const mix = dist.tool_mix;
    need(typeof mix?.source === "string" && mix.source !== "", "tool_mix: source missing");
    need(mix?.n > 0, "tool_mix: n missing");
    const names = (mix?.categories ?? []).map((c) => c.category);
    need(names.length > 0 && new Set(names).size === names.length, "tool_mix: categories");
    const shareSum = (mix?.categories ?? []).reduce((sum, c) => sum + c.share, 0);
    need(Math.abs(shareSum - 1) < 1e-5, `tool_mix: shares sum to ${shareSum}`);
    for (const c of mix?.categories ?? []) {
        const unit = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;
        need(unit(c.share) && unit(c.error_rate), `tool_mix: ${c.category} share or error_rate`);
        need(Array.isArray(c.tools), `tool_mix: ${c.category} tools`);
    }
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
