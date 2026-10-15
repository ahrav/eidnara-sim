import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../prereg/canonical";
import { quantile } from "./cdf";
import {
    type CheckResult,
    compareCited,
    failedChecks,
    loadCited,
    loadDistributions,
    table,
} from "./distributions";
import { entryProblems, parseJsonl } from "./entries";
import { loadRepos, REPOS_DIR } from "./repos";
import { CORPUS_DIR } from "./sources";

const MIN_SAMPLES = 500;
const MIN_ERROR_CODES = 100;
const KINDS = ["stack_trace", "test_run", "grep", "file_read"];
const SHA = /^[0-9a-f]{40}$/;
const REPO_LICENSES = new Set(["MIT", "Apache-2.0"]);

export interface CorpusReport {
    problems: string[];
    percentiles: CheckResult[];
}

export function checkCorpus(): CorpusReport {
    const problems: string[] = [];
    const need = (ok: boolean, problem: string) => ok || problems.push(problem);
    const read = (path: string) => readFileSync(join(CORPUS_DIR, path), "utf8");
    const manifest = JSON.parse(read("manifest.json"));
    for (const [path, digest] of Object.entries(manifest.files as Record<string, string>)) {
        const actual = sha256Hex(read(path));
        need(actual === digest, `${path}: sha256 ${actual}, manifest ${digest}`);
    }

    const samples = parseJsonl(read("tool-outputs/samples.jsonl"));
    const codes = parseJsonl(read("tool-outputs/error-codes.jsonl"));
    need(samples.length >= MIN_SAMPLES, `samples: ${samples.length} < ${MIN_SAMPLES}`);
    need(codes.length >= MIN_ERROR_CODES, `error codes: ${codes.length} < ${MIN_ERROR_CODES}`);
    problems.push(...entryProblems(samples, "samples"), ...entryProblems(codes, "error_codes"));
    const kinds = new Set(samples.map((s) => (s as { kind?: string }).kind));
    need(
        KINDS.every((k) => kinds.has(k)),
        `samples: kinds ${[...kinds].join(",")}`,
    );
    const named = codes.filter((c) => (c as { code?: string }).code?.trim());
    need(named.length === codes.length, "error codes: an entry has an empty code");

    const dist = loadDistributions();
    for (const [name, q] of Object.entries(dist.quantities)) {
        need(typeof q.source === "string" && q.source !== "", `${name}: source missing`);
        need(q.n > 0 && q.cdf.p.length === q.cdf.x.length, `${name}: n or cdf missing`);
    }
    const cited = loadCited();
    const percentiles = compareCited(cited, (name, q) => quantile(table(dist, name), q));
    for (const r of failedChecks(percentiles)) {
        const why = r.within ? "is in band but carries a deviation" : "out of band";
        problems.push(
            `${r.quantity} p${r.q * 100}: measured ${r.measured}, cited ${r.cited} ${why}`,
        );
    }
    for (const tail of cited.tail_checks) {
        const { p, x } = table(dist, tail.quantity);
        const share = 1 - (p[x.findIndex((v) => v >= tail.threshold)] ?? 1);
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
