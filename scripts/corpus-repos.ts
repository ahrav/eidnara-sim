import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderJson } from "../src/corpus/build";
import {
    buildTwin,
    cloneAt,
    copyLicense,
    loadRepos,
    prepare,
    REPOS_DIR,
    runOffline,
} from "../src/corpus/repos";
import { CORPUS_DIR } from "../src/corpus/sources";

// Usage: bun scripts/corpus-repos.ts [--record]
const record = process.argv.includes("--record");
const repos = loadRepos();
const failures: string[] = [];

for (const repo of repos) {
    const base = join(REPOS_DIR, repo.id);
    const twinDir = join(REPOS_DIR, repo.twin.id);
    cloneAt(repo.url, repo.commit, base);
    copyLicense(repo);
    const twinCommit = buildTwin(base, twinDir, repo.twin);
    if (record) repo.twin.commit = twinCommit;
    else if (twinCommit !== repo.twin.commit) {
        failures.push(`${repo.twin.id}: commit ${twinCommit}, recorded ${repo.twin.commit}`);
    }
    for (const [label, dir] of [
        [repo.id, base],
        [repo.twin.id, twinDir],
    ] as const) {
        prepare(dir, repo.prepare);
        const outcome = runOffline(dir, repo.test);
        console.log(`${label}: exit ${outcome.exit_code}\n  ${outcome.summary.join("\n  ")}`);
        if (record && label === repo.id) repo.expected = outcome;
        else if (JSON.stringify(outcome) !== JSON.stringify(repo.expected)) {
            failures.push(`${label}: offline test outcome differs from repos.json`);
        }
    }
}

if (record) {
    const path = join(CORPUS_DIR, "repos.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, renderJson({ ...raw, repos }));
}
for (const failure of failures) console.log(`FAIL ${failure}`);
if (failures.length > 0) process.exit(1);
