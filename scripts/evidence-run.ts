import { mkdirSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { sessionHealth } from "../src/evidence/health";
import { loadRun } from "../src/evidence/load";
import { type RunEvidence, renderEvidence } from "../src/evidence/report";
import { runEvidence } from "../src/evidence/stages";
import { writeAtomic } from "../src/run/atomic";

const USAGE = "usage: bun scripts/evidence-run.ts <run dir>... [--out <dir>]";

export function evidenceRun(dirs: string[], out: string | null): string {
    const runs: RunEvidence[] = [];
    const names = dirs.map((d) => basename(d));
    if (out && new Set(names).size !== names.length) {
        throw new Error("--out: two run directories share a name");
    }
    for (const dir of dirs) {
        const run = loadRun(dir);
        const sessions = sessionHealth(run);
        const probes = runEvidence(run, sessions);
        const name = basename(dir);
        const target = out ? join(out, name) : dir;
        mkdirSync(target, { recursive: true });
        writeAtomic(
            join(target, "evidence.jsonl"),
            probes.map((p) => `${JSON.stringify(p)}\n`).join(""),
        );
        writeAtomic(
            join(target, "evidence-sessions.jsonl"),
            sessions.map((s) => `${JSON.stringify(s)}\n`).join(""),
        );
        runs.push({ name, run, probes, sessions });
    }
    const report = renderEvidence(runs);
    const reportDir = out ?? (dirs.length === 1 ? (dirs[0] as string) : null);
    if (reportDir) writeAtomic(join(reportDir, "evidence.md"), report);
    return report;
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    const at = args.indexOf("--out");
    const out = at >= 0 ? (args[at + 1] ?? null) : null;
    if (at >= 0 && (out === null || out.startsWith("--"))) {
        console.error(USAGE);
        process.exit(2);
    }
    const dirs = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1)).map((d) => resolve(d));
    if (dirs.length === 0) {
        console.error(USAGE);
        process.exit(2);
    }
    const outDir = out ? resolve(out) : null;
    if (outDir && dirs.some((d) => outDir === realpathSync(d))) {
        console.error("--out names a run directory; leave it out to write there");
        process.exit(2);
    }
    process.stdout.write(evidenceRun(dirs, outDir));
}
