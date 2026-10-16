import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

const TRANSCRIPT_READ =
    /\.pi\/agent\/sessions|opencode\.db|opencode\/storage|\/sessions\/\S*\.jsonl/;

export interface TranscriptOrder {
    arm: string;
    sessions: number;
    in_order: boolean;
    max_lead_ms: number | null;
    max_lag_ms: number | null;
}

export interface RunConditions {
    run: string;
    host: string;
    seed: number;
    events: number;
    scenario_events: number;
    interception: { name: string; intercepted: boolean; wall_clock_only: boolean }[];
    transcripts: { arm: string; paths: string[]; missing: string[] }[];
    transcript_order: TranscriptOrder[];
}

export interface Continuity {
    arm: string;
    probe: "P8" | "P9";
    n: number;
    pass: number;
    pass_with_transcript_read: number;
    v1: [number, number] | null;
}

function files(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? files(p) : [p];
    });
}

function transcriptTimes(path: string): Map<string, number> {
    const out = new Map<string, number>();
    if (path.endsWith(".db")) {
        if (!existsSync(path)) return out;
        const db = new Database(path, { readonly: true });
        try {
            const rows = db.query("select title, time_created from session").all() as {
                title: string;
                time_created: number;
            }[];
            for (const r of rows) out.set(r.title, r.time_created);
        } finally {
            db.close();
        }
        return out;
    }
    for (const f of files(path).filter((p) => p.endsWith(".jsonl"))) {
        const head = JSON.parse(readFileSync(f, "utf8").split("\n")[0] || "{}");
        if (head.type === "session") out.set(head.id, Date.parse(head.timestamp));
    }
    return out;
}

function order(g: GradedRun, arm: ArmLogs, paths: string[]): TranscriptOrder {
    const session = new Map(g.scenario.events.map((e) => [e.id, String(e.session)]));
    const times = new Map(paths.flatMap((p) => [...transcriptTimes(p)]));
    const pairs = arm.journal
        .filter((e) => e.kind === "Event" && g.run.kinds.get(String(e.event)) === "session_start")
        .flatMap((e) => {
            const t = times.get(`sim-${session.get(String(e.event))}`);
            return t === undefined ? [] : [{ t, d: t - (g.run.base_wall_ms + e.scenario_ms) }];
        });
    const d = pairs.map((p) => p.d);
    return {
        arm: arm.arm,
        sessions: pairs.length,
        in_order: pairs.every((p, i) => i === 0 || p.t >= (pairs[i - 1]?.t ?? 0)),
        max_lead_ms: d.length ? Math.max(0, ...d) : null,
        max_lag_ms: d.length ? Math.max(0, ...d.map((x) => -x)) : null,
    };
}

export function runConditions(g: GradedRun): RunConditions {
    const m = join(g.run.dir, "manifest.json");
    const manifest = existsSync(m) ? JSON.parse(readFileSync(m, "utf8")) : {};
    const transcripts = g.run.arms.map((arm) => {
        const p = join(g.run.dir, arm.arm, "transcripts.json");
        const t = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { paths: [], missing: [] };
        return { arm: arm.arm, paths: t.paths as string[], missing: t.missing as string[] };
    });
    const probes = (manifest.preflight?.time_injection ?? []) as RunConditions["interception"];
    return {
        run: g.run.dir,
        host: manifest.host,
        seed: manifest.seed,
        events: manifest.events ?? g.scenario.events.length,
        scenario_events: g.scenario.events.length,
        interception: probes.map(({ name, intercepted, wall_clock_only }) => ({
            name,
            intercepted,
            wall_clock_only,
        })),
        transcripts,
        transcript_order: g.run.arms.map((arm, i) => order(g, arm, transcripts[i]?.paths ?? [])),
    };
}

const turnOf = (r: GradeRecord) => r.snapshot.split(":").at(-1) ?? "";

export function continuity(runs: GradedRun[]): Continuity[] {
    const out = new Map<string, Continuity>();
    for (const g of runs) {
        for (const r of g.grades) {
            if (r.probe_type !== "P8" && r.probe_type !== "P9") continue;
            const key = `${r.arm}/${r.probe_type}`;
            const c = out.get(key) ?? {
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
            if (tools.some((t) => t.turn === turn && TRANSCRIPT_READ.test(t.command))) {
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
                c.events < c.scenario_events
                    ? `${c.events} of ${c.scenario_events} (capped prefix)`
                    : c.events,
                c.interception
                    .map((i) => `${i.name} ${i.intercepted ? "intercepted" : "not intercepted"}`)
                    .join(", "),
                c.transcripts.flatMap((t) => t.missing).join(", ") || "none",
            ]),
        ),
        "",
        "Transcript creation times, read back from each host's store, against the session's",
        "scenario wall time:",
        "",
        ...head(["run", "arm", "sessions", "in scenario order", "max lead ms", "max lag ms"]),
        ...conditions.flatMap((c) =>
            c.transcript_order.map((o) =>
                row([
                    c.run,
                    o.arm,
                    o.sessions,
                    o.in_order ? "yes" : "no",
                    o.max_lead_ms ?? "-",
                    o.max_lag_ms ?? "-",
                ]),
            ),
        ),
        "",
        "## Continuity against the v1 baseline",
        "",
        ...head(["arm", "probe", "n", "pass", "passes reading transcripts", "v1 cross-session"]),
        ...recall.map((c) =>
            row([
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
