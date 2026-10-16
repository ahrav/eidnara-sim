import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../prereg/canonical";
import { cdfProblems, quantile, tailShare } from "./cdf";
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

const MIN_SAMPLES = 500;
const MIN_ERROR_CODES = 100;
const KINDS = ["stack_trace", "test_run", "grep", "file_read"];
const SHA = /^[0-9a-f]{40}$/;
const REPO_LICENSES = new Set(["MIT", "Apache-2.0"]);
const OUTPUTS = [
    "distributions.json",
    "tool-outputs/error-codes.jsonl",
    "tool-outputs/samples.jsonl",
];
const CDF_KINDS = new Set(["discrete", "continuous"]);

export interface CorpusReport {
    problems: string[];
    percentiles: CheckResult[];
}

export function checkCorpus(): CorpusReport {
    const problems: string[] = [];
    const need = (ok: boolean, problem: string) => ok || problems.push(problem);
    const read = (path: string) => readFileSync(join(CORPUS_DIR, path), "utf8");
    const manifest = JSON.parse(read("manifest.json"));
    const files = manifest.files as Record<string, string>;
    const listed = Object.keys(files).sort().join(",");
    need(listed === OUTPUTS.join(","), `manifest: files ${listed}, need ${OUTPUTS.join(",")}`);
    const configured = loadSources().map((d) => ({
        id: d.id,
        revision: d.revision,
        access: d.access,
    }));
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
    need(samples.length >= MIN_SAMPLES, `samples: ${samples.length} < ${MIN_SAMPLES}`);
    need(codes.length >= MIN_ERROR_CODES, `error codes: ${codes.length} < ${MIN_ERROR_CODES}`);
    problems.push(
        ...entryProblems(samples, "samples", SAMPLE_FIELDS),
        ...entryProblems(codes, "error_codes", ERROR_CODE_FIELDS),
    );
    const kinds = new Set(samples.map((s) => (s as { kind?: string }).kind));
    need(
        KINDS.every((k) => kinds.has(k)),
        `samples: kinds ${[...kinds].join(",")}`,
    );
    const named = codes.filter((c) => (c as { code?: string }).code?.trim());
    need(named.length === codes.length, "error codes: an entry has an empty code");

    const dist = loadDistributions();
    const quantityNames = Object.keys(dist.quantities).sort().join(",");
    need(
        quantityNames === QUANTITIES.join(","),
        `quantities: ${quantityNames}, need ${QUANTITIES.join(",")}`,
    );
    for (const [name, q] of Object.entries(dist.quantities)) {
        need(typeof q.source === "string" && q.source !== "", `${name}: source missing`);
        need(q.n > 0, `${name}: n missing`);
        need(CDF_KINDS.has(q.cdf.kind), `${name}: cdf kind ${q.cdf.kind}`);
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
