import { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { GradeRecord } from "../grade/probes";
import { armBase } from "../hosts/arms";
import type { ArmLogs } from "../oracle/logs";
import type { GradedRun } from "./observe";

/** The v1 harness measured cross-session recall of 0 to 3% for host and 99 to 100% for Eidnara. */
export const V1_CONTINUITY: Record<string, [number, number]> = {
    host: [0, 0.03],
    eidnara: [0.99, 1],
};

/** The hosts' transcript stores as the sandboxed agent names them: Pi's sessions directory and OpenCode's data directory. */
const TRANSCRIPT_PATH =
    /\.pi\/agent\/sessions|PI_CODING_AGENT_DIR\}?\/sessions|XDG_DATA_HOME\}?\/opencode|\/opencode\/opencode\.db|\/opencode\/storage|agent\/sessions\/\S*\.jsonl/;
const READERS = new Set([
    "cat",
    "less",
    "more",
    "head",
    "tail",
    "sed",
    "awk",
    "grep",
    "rg",
    "find",
    "ls",
    "jq",
    "sqlite3",
    "strings",
    "bat",
    "view",
    "read",
]);
const SEPARATOR = /&&|\|\||[;|&\n]/;
/** Whether one of the command's simple commands runs a reader on a transcript path. */
const readsTranscripts = (command: string) =>
    command.split(SEPARATOR).some((simple) => {
        const words = simple.trim().split(/\s+/);
        const program = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? "";
        return READERS.has(program.split("/").at(-1) ?? "") && TRANSCRIPT_PATH.test(simple);
    });

export interface TranscriptOrder {
    arm: string;
    /** False for an arm whose transcript check never ran, so nothing below was measured. */
    checked: boolean;
    sessions: number;
    /** Sessions the arm reached whose transcript the store lacks. */
    missing: string[];
    in_order: boolean | null;
    max_lead_ms: number | null;
    max_lag_ms: number | null;
}

export interface RunConditions {
    run: string;
    host: string;
    seed: number;
    events: number;
    events_run: number;
    scenario_events: number;
    interception: { name: string; intercepted: boolean; wall_clock_only: boolean }[];
    /** `missing` is null for an arm that never reached its transcript check. */
    transcripts: { arm: string; paths: string[]; missing: string[] | null }[];
    transcript_order: TranscriptOrder[];
}

export interface Continuity {
    host: string;
    arm: string;
    probe: "P8" | "P9";
    n: number;
    pass: number;
    pass_with_transcript_read: number;
    v1: [number, number] | null;
}

/** Whether `path` resolves to a real location inside `root`. */
function within(path: string, root: string): boolean {
    try {
        const real = realpathSync(path);
        const base = realpathSync(root);
        return real === base || real.startsWith(`${base}/`);
    } catch {
        return false;
    }
}

/** Regular files under `dir`, which must resolve inside `root`; symlinks are left unread. */
function files(dir: string, root: string): string[] {
    if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !within(dir, root)) return [];
    return readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        const stat = lstatSync(p);
        return stat.isDirectory() ? files(p, root) : stat.isFile() ? [p] : [];
    });
}

function transcriptTimes(path: string, armDir: string): Map<string, number> {
    const out = new Map<string, number>();
    if (!within(path, armDir)) return out;
    if (path.endsWith(".db")) {
        const db = new Database(path, { readonly: true });
        try {
            const rows = db.query("select title, time_created from session").all() as {
                title: string;
                time_created: number;
            }[];
            for (const r of rows) {
                if (Number.isFinite(r.time_created)) out.set(r.title, r.time_created);
            }
        } finally {
            db.close();
        }
        return out;
    }
    for (const f of files(path, armDir).filter((p) => p.endsWith(".jsonl"))) {
        try {
            const head = JSON.parse(readFileSync(f, "utf8").split("\n")[0] || "{}");
            const at = Date.parse(head.timestamp);
            if (head.type === "session" && Number.isFinite(at)) out.set(head.id, at);
        } catch {}
    }
    return out;
}

function order(g: GradedRun, arm: ArmLogs, paths: string[]): TranscriptOrder {
    const scheduled = new Map(g.scenario.events.map((e) => [e.id, e]));
    const armDir = join(g.run.dir, arm.arm);
    const times = new Map(paths.flatMap((p) => [...transcriptTimes(p, armDir)]));
    const reached = arm.journal
        .filter((e) => e.kind === "Event" && g.run.kinds.get(String(e.event)) === "session_start")
        .flatMap((e) => {
            const at = scheduled.get(String(e.event));
            return at ? [at] : [];
        });
    const missing = reached
        .filter((at) => !times.has(`sim-${at.session}`))
        .map((at) => String(at.session));
    const pairs = reached.flatMap((at) => {
        const t = times.get(`sim-${at.session}`);
        if (t === undefined) return [];
        return [{ t, d: t - (g.run.base_wall_ms + Number(at.scenario_ms)) }];
    });
    const d = pairs.map((p) => p.d);
    return {
        arm: arm.arm,
        checked: true,
        sessions: pairs.length,
        missing,
        in_order: pairs.length
            ? pairs.every((p, i) => i === 0 || p.t >= (pairs[i - 1]?.t ?? 0))
            : null,
        max_lead_ms: d.length ? Math.max(0, ...d) : null,
        max_lag_ms: d.length ? Math.max(0, ...d.map((x) => -x)) : null,
    };
}

export function runConditions(g: GradedRun): RunConditions {
    const m = join(g.run.dir, "manifest.json");
    const manifest = existsSync(m) ? JSON.parse(readFileSync(m, "utf8")) : {};
    const transcripts = g.run.arms.map((arm) => {
        const p = join(g.run.dir, arm.arm, "transcripts.json");
        // An absent or cut file (the driver writes it in one call a kill can interrupt) is an
        // unchecked arm.
        const unchecked = { paths: [] as string[], missing: null as string[] | null };
        let t = unchecked;
        try {
            if (existsSync(p)) t = JSON.parse(readFileSync(p, "utf8"));
        } catch {
            t = unchecked;
        }
        const strings = (x: unknown) => Array.isArray(x) && x.every((v) => typeof v === "string");
        if (!strings(t.paths) || !(t.missing === null || strings(t.missing))) t = unchecked;
        return { arm: arm.arm, paths: t.paths, missing: t.missing };
    });
    const probes = (manifest.preflight?.time_injection ?? []) as RunConditions["interception"];
    return {
        run: g.run.dir,
        host: manifest.host,
        seed: manifest.seed,
        events: manifest.events ?? g.scenario.events.length,
        events_run: Math.max(
            0,
            ...g.run.arms.map((a) => a.journal.filter((e) => e.kind === "Event").length),
        ),
        scenario_events: g.scenario.events.length,
        interception: probes.map(({ name, intercepted, wall_clock_only }) => ({
            name,
            intercepted,
            wall_clock_only,
        })),
        transcripts,
        transcript_order: g.run.arms.map((arm, i) =>
            transcripts[i]?.missing === null
                ? {
                      arm: arm.arm,
                      checked: false,
                      sessions: 0,
                      missing: [],
                      in_order: null,
                      max_lead_ms: null,
                      max_lag_ms: null,
                  }
                : order(g, arm, transcripts[i]?.paths ?? []),
        ),
    };
}

const turnOf = (r: GradeRecord) => r.snapshot.split(":").at(-1) ?? "";

export function continuity(runs: GradedRun[]): Continuity[] {
    const out = new Map<string, Continuity>();
    for (const g of runs) {
        const m = join(g.run.dir, "manifest.json");
        const host = existsSync(m) ? String(JSON.parse(readFileSync(m, "utf8")).host) : "-";
        for (const r of g.grades) {
            if (r.probe_type !== "P8" && r.probe_type !== "P9") continue;
            if (r.verdict === "excluded") continue;
            const key = `${host}/${r.arm}/${r.probe_type}`;
            const c = out.get(key) ?? {
                host,
                arm: r.arm,
                probe: r.probe_type,
                n: 0,
                pass: 0,
                pass_with_transcript_read: 0,
                v1: V1_CONTINUITY[armBase(r.arm)] ?? null,
            };
            out.set(key, c);
            c.n++;
            if (r.verdict !== "pass") continue;
            c.pass++;
            const tools = g.run.arms.find((a) => a.arm === r.arm)?.tools ?? [];
            const turn = turnOf(r);
            if (tools.some((t) => t.turn === turn && readsTranscripts(t.command))) {
                c.pass_with_transcript_read++;
            }
        }
    }
    return [...out.values()];
}

const pct = (x: number, n: number) => (n === 0 ? "-" : `${((100 * x) / n).toFixed(0)}%`);
const row = (r: (string | number)[]) => `| ${r.join(" | ")} |`;
const head = (h: string[]) => [row(h), row(h.map(() => "---"))];

export function renderConditions(conditions: RunConditions[], recall: Continuity[]): string[] {
    return [
        "## Run conditions",
        "",
        ...head(["run", "host", "seed", "events run", "interception", "transcripts missing"]),
        ...conditions.map((c) =>
            row([
                c.run,
                c.host,
                c.seed,
                `${c.events_run} of ${c.events} planned${
                    c.events < c.scenario_events ? `, a capped prefix of ${c.scenario_events}` : ""
                }`,
                c.interception
                    .map((i) => `${i.name} ${i.intercepted ? "intercepted" : "not intercepted"}`)
                    .join(", "),
                c.transcripts
                    .flatMap((t) => (t.missing === null ? [`${t.arm} unchecked`] : t.missing))
                    .join(", ") || "none",
            ]),
        ),
        "",
        "Transcript creation times, read back from each host's store, against the session's",
        "scenario wall time:",
        "",
        ...head([
            "run",
            "arm",
            "sessions",
            "missing",
            "in scenario order",
            "max lead ms",
            "max lag ms",
        ]),
        ...conditions.flatMap((c) =>
            c.transcript_order.map((o) =>
                row([
                    c.run,
                    o.arm,
                    o.checked ? o.sessions : "unchecked",
                    o.missing.join(", ") || "none",
                    o.in_order === null ? "-" : o.in_order ? "yes" : "no",
                    o.max_lead_ms ?? "-",
                    o.max_lag_ms ?? "-",
                ]),
            ),
        ),
        "",
        "## Continuity against the v1 baseline",
        "",
        ...head([
            "host",
            "arm",
            "probe",
            "n",
            "pass",
            "passes reading transcripts",
            "v1 cross-session",
        ]),
        ...recall.map((c) =>
            row([
                c.host,
                c.arm,
                c.probe,
                c.n,
                pct(c.pass, c.n),
                c.pass_with_transcript_read,
                c.v1 ? `${c.v1[0] * 100}% to ${c.v1[1] * 100}%` : "-",
            ]),
        ),
        "",
    ];
}
