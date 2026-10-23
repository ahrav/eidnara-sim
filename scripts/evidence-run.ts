import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { defaultConfigPath } from "../src/config/config";
import { sessionHealth } from "../src/evidence/health";
import { loadRun } from "../src/evidence/load";
import { type RunEvidence, renderEvidence } from "../src/evidence/report";
import { runEvidence } from "../src/evidence/stages";
import { RequestPartLog } from "../src/proxy/requests";
import { writeAtomic } from "../src/run/atomic";
import { contains, realExisting } from "../src/run/paths";

const USAGE = "usage: bun scripts/evidence-run.ts <run dir>... [--out <dir>]";

/** `checkout` is the configured eidnara checkout, which this tree never writes. */
export function evidenceRun(dirs: string[], out: string | null, checkout: string | null): string {
    const runs: RunEvidence[] = [];
    const names = dirs.map((d) => basename(resolve(d)));
    if (new Set(names).size !== names.length) {
        throw new Error("two run directories share a name, so report rows would collide");
    }
    const targets = out ? [out, ...names.map((n) => join(out, n))] : dirs;
    if (checkout && targets.some((t) => contains(realExisting(checkout), realExisting(t)))) {
        throw new Error(`an output lies inside the eidnara checkout ${checkout}`);
    }
    // A target inside a run directory would put the files into the run it only reads.
    if (out) {
        const runs = dirs.map((d) => realpathSync(d));
        if (targets.some((t) => runs.some((r) => contains(r, realExisting(t))))) {
            throw new Error("--out lies inside a run directory; leave --out off to write there");
        }
    }
    // Every run is analysed before any file is written, so a refused run leaves no partial batch.
    for (const dir of dirs) {
        const run = loadRun(dir);
        try {
            const sessions = sessionHealth(run);
            runs.push({
                name: basename(resolve(dir)),
                run,
                probes: runEvidence(run, sessions),
                sessions,
            });
        } finally {
            // The report reads the stages and sessions, so the log closes once its run is analysed.
            if (run.parts instanceof RequestPartLog) run.parts.close();
        }
    }
    for (const [i, r] of runs.entries()) {
        const target = out ? join(out, r.name) : (dirs[i] as string);
        mkdirSync(target, { recursive: true });
        // A linked output directory would route the files somewhere else.
        if (out && lstatSync(target).isSymbolicLink()) {
            throw new Error(`${target} resolves through a link`);
        }
        writeAtomic(
            join(target, "evidence.jsonl"),
            r.probes.map((p) => `${JSON.stringify(p)}\n`).join(""),
        );
        writeAtomic(
            join(target, "evidence-sessions.jsonl"),
            r.sessions.map((s) => `${JSON.stringify(s)}\n`).join(""),
        );
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
    for (const d of dirs) {
        if (!existsSync(join(d, "manifest.json"))) {
            console.error(`${d}: no manifest.json\n${USAGE}`);
            process.exit(2);
        }
    }
    const outDir = out ? resolve(out) : null;
    const configPath = defaultConfigPath();
    const config = existsSync(configPath)
        ? (JSON.parse(readFileSync(configPath, "utf8")) as { eidnara_checkout?: string })
        : {};
    const checkout = config.eidnara_checkout ? resolve(config.eidnara_checkout) : null;
    process.stdout.write(evidenceRun(dirs, outDir, checkout));
}
