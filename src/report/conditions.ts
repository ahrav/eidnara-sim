import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GradeRecord } from "../grade/probes";
import { armBase } from "../hosts/arms";
import type { ArmLogs } from "../oracle/logs";
import { clopperPearson } from "../stats/tests";
import type { GradedRun } from "./observe";

/** The v1 harness measured cross-session recall of 0 to 3% for host and 99 to 100% for Eidnara. */
export const V1_CONTINUITY: Record<string, [number, number]> = {
    host: [0, 0.03],
    eidnara: [0.99, 1],
};

const TRANSCRIPT_READ =
    /\.pi\/agent\/sessions|PI_CODING_AGENT_DIR\}?\/sessions|XDG_DATA_HOME\}?\/opencode|opencode\.db|opencode\/storage|\/sessions\/\S*\.jsonl/;

export interface TranscriptOrder {
    arm: string;
    sessions: number;
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
    transcripts: { arm: string; paths: string[]; missing: string[] }[];
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

const count = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;

export function parseContinuity(value: unknown): Continuity[] {
    if (!Array.isArray(value)) throw new Error("continuity: expected an array of rows");
    const seen = new Set<string>();
    return value.map((raw, i) => {
        const at = `continuity[${i}]`;
        if (typeof raw !== "object" || raw === null) throw new Error(`${at}: expected an object`);
        const r = raw as Record<string, unknown>;
        for (const field of ["host", "arm"]) {
            if (typeof r[field] !== "string") throw new Error(`${at}.${field}: expected a string`);
        }
        if (r.probe !== "P8" && r.probe !== "P9") throw new Error(`${at}.probe: expected P8 or P9`);
        if (!count(r.n)) throw new Error(`${at}.n: expected a count`);
        if (!count(r.pass) || r.pass > r.n) throw new Error(`${at}.pass: expected a count up to n`);
        if (!count(r.pass_with_transcript_read) || r.pass_with_transcript_read > r.pass) {
            throw new Error(`${at}.pass_with_transcript_read: expected a count up to pass`);
        }
        const key = `${r.host}/${r.arm}/${r.probe}`;
        if (seen.has(key)) throw new Error(`${at}: duplicates ${key}`);
        seen.add(key);
        const v1 = Array.isArray(r.v1) ? (r.v1 as [number, number]) : null;
        return {
            host: r.host as string,
            arm: r.arm as string,
            probe: r.probe,
            n: r.n,
            pass: r.pass,
            pass_with_transcript_read: r.pass_with_transcript_read,
            v1,
        };
    });
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
        try {
            const head = JSON.parse(readFileSync(f, "utf8").split("\n")[0] || "{}");
            if (head.type === "session") out.set(head.id, Date.parse(head.timestamp));
        } catch {}
    }
    return out;
}

function order(g: GradedRun, arm: ArmLogs, paths: string[]): TranscriptOrder {
    const scheduled = new Map(g.scenario.events.map((e) => [e.id, e]));
    const times = new Map(paths.flatMap((p) => [...transcriptTimes(p)]));
    const pairs = arm.journal
        .filter((e) => e.kind === "Event" && g.run.kinds.get(String(e.event)) === "session_start")
        .flatMap((e) => {
            const at = scheduled.get(String(e.event));
            const t = times.get(`sim-${at?.session}`);
            if (t === undefined || !at) return [];
            return [{ t, d: t - (g.run.base_wall_ms + Number(at.scenario_ms)) }];
        });
    const d = pairs.map((p) => p.d);
    return {
        arm: arm.arm,
        sessions: pairs.length,
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
        const t = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { paths: [], missing: [] };
        return { arm: arm.arm, paths: t.paths as string[], missing: t.missing as string[] };
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
        transcript_order: g.run.arms.map((arm, i) => order(g, arm, transcripts[i]?.paths ?? [])),
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
                `${c.events_run} of ${c.events} planned${
                    c.events < c.scenario_events ? `, a capped prefix of ${c.scenario_events}` : ""
                }`,
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

export interface RecallDrift {
    host: string;
    arm: string;
    probe: "P8" | "P9";
    rate: number | null;
    reference: [number, number] | null;
    drift: boolean | null;
}

/**
 * Each host, arm, and probe's pass rate against the reference tier's 95% Clopper-Pearson
 * interval for the same row; a rate outside it is drift, and a row either side lacks is null.
 */
export function recallDrift(current: Continuity[], reference: Continuity[]): RecallDrift[] {
    return current.map((c) => {
        const r = reference.find(
            (x) => x.host === c.host && x.arm === c.arm && x.probe === c.probe,
        );
        const rate = c.n ? c.pass / c.n : null;
        const interval = r?.n ? clopperPearson(r.pass, r.n) : null;
        const drift =
            rate === null || interval === null ? null : rate < interval[0] || rate > interval[1];
        return { host: c.host, arm: c.arm, probe: c.probe, rate, reference: interval, drift };
    });
}

export function renderDrift(rows: RecallDrift[] | null, source: string | null): string[] {
    if (rows === null) return [];
    const f = (x: number | null | undefined) =>
        x === null || x === undefined ? "-" : x.toFixed(2);
    return [
        "## Recall against the reference tier",
        "",
        `Reference: ${source ?? "-"}.`,
        "",
        ...head(["host", "arm", "probe", "rate", "reference interval", "drift"]),
        ...rows.map((d) =>
            row([
                d.host,
                d.arm,
                d.probe,
                f(d.rate),
                d.reference ? `[${f(d.reference[0])}, ${f(d.reference[1])}]` : "-",
                d.drift === null ? "-" : d.drift ? "drift" : "within",
            ]),
        ),
        "",
    ];
}
