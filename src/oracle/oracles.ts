import type { CallRecord } from "../proxy/records";
import type { ArmLogs, RunLogs, Sample } from "./logs";

export const ORACLES = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9"] as const;
export type OracleId = (typeof ORACLES)[number];

export interface Activation {
    oracle: OracleId;
    arm: string;
    at: string;
    evidence: string;
    component?: string;
}

/** A model call the context limit refused, in every wording the gateways use. */
export const OVERFLOW =
    /prompt is too long|ContextOverflow|input is too long|too many total text bytes|exceeds? the (model's )?(maximum )?context (window|length)/i;
const ARRAY_SHAPE = [
    /must alternate between user and assistant/i,
    /does not support assistant message prefill/i,
    /conversation must end with a user message/i,
    /thinking[^.]{0,40}blocks? in the latest assistant message cannot be modified/i,
    /Expected `(redacted_)?thinking`/i,
    /content field in the Message object at messages\.\d+ is empty/i,
    /messages\.\d+\.content[^:]*: (Input should be a valid list|must be an array)/i,
];
const RAW_PASS = /served_from=raw/;
const CAPTURE_REFUSED =
    /memory capture output rejected|capture output (does not match the JSON schema|version is unsupported|exceeds (its decision bounds|\d+ bytes)|has no source id|has an unclosed code fence|names an unknown or duplicate source)/;
const DEADLINE = /deadline|Timed out after \d+ ?ms/;
const HARNESS = new Set(["user-sim", "judge", "rejected"]);
export const INTERNAL_TEXT = [
    /<\/?history[_-]segments?\b/i,
    /<\/?eidnara[\w-]*>/i,
    /context[_-]researcher[_-]augmentation/i,
    /\[eidnara\]/i,
    /\b(row_version|served_from|invocation_bytes|emergency_wait)\b/,
    /\bdecision=(SOFT|HARD)/,
];
const NO_HOST_COMPACTION = new Set(["eidnara", "eidnara-cf"]);
/** A proxy record lands after the host's own tool event can, so a tool start this close counts. */
const CLOCK_SLACK_MS = 1_000;
const STAMP = /\d{4}-\d\d-\d\dT[\d:.]+Z/;
const TOKENS = (c: CallRecord) =>
    c.input_tokens + c.output_tokens + c.cache_read_tokens + c.cache_write_tokens;

const errorOf = (c: CallRecord) => `${c.status} ${c.error ?? ""}`;
const at = (c: CallRecord) => c.turn ?? `call ${c.seq}`;

/** F1 and F2 classify request refusals: HTTP 4xx. A 5xx carrying the same text is an infrastructure failure. */
function failedCalls(arm: ArmLogs, pattern: (text: string) => boolean): CallRecord[] {
    return arm.calls.filter((c) => c.status >= 400 && c.status < 500 && pattern(errorOf(c)));
}

function f1(arm: ArmLogs): Activation[] {
    const calls = failedCalls(arm, (t) => OVERFLOW.test(t)).map((c) => ({
        oracle: "F1" as const,
        arm: arm.arm,
        at: at(c),
        evidence: errorOf(c).slice(0, 200),
        component: c.component,
    }));
    const agentAt = new Set(
        arm.calls
            .filter((c) => c.component === "agent" && c.status >= 400 && OVERFLOW.test(errorOf(c)))
            .map(at),
    );
    const turns = arm.journal
        .filter((e) => e.kind === "EndTurn" && OVERFLOW.test(String(e.outcome)))
        .filter((e) => !agentAt.has(String(e.event)))
        .map((e) => ({
            oracle: "F1" as const,
            arm: arm.arm,
            at: String(e.event),
            evidence: String(e.outcome).slice(0, 200),
        }));
    return [...calls, ...turns];
}

function f4(arm: ArmLogs, quietMs: number): Activation[] {
    const out: Activation[] = [];
    for (const e of arm.journal) {
        if (e.kind !== "EndTurn") continue;
        const turn = String(e.event);
        const turnCalls = arm.calls.filter((c) => c.turn === turn);
        const calls = turnCalls.filter((c) => c.component === "agent");
        const tools = arm.tools.filter((t) => t.turn === turn).map((t) => t.scenario_ms);
        const began = arm.journal.find((b) => b.kind === "BeginTurn" && b.event === e.event);
        if (DEADLINE.test(String(e.outcome))) {
            const points = [
                ...(began ? [began.scenario_ms] : []),
                ...turnCalls.flatMap((c) => [
                    c.scenario_ms,
                    c.scenario_ms + (c.wall_ms - c.started_wall_ms),
                ]),
                ...tools,
                e.scenario_ms,
            ].sort((a, b) => a - b);
            const gap = Math.max(0, ...points.slice(1).map((ms, i) => ms - (points[i] as number)));
            if (calls.length === 0 || gap > quietMs) {
                const what =
                    calls.length === 0 ? "with no model call" : `after ${calls.length} model calls`;
                const silent = gap > quietMs ? `, ${Math.round(gap / 1000)} s silent` : "";
                const evidence = `turn deadline ${what}${silent}`;
                out.push({ oracle: "F4", arm: arm.arm, at: turn, evidence });
            }
            continue;
        }
        const windows: string[] = [];
        /** Proxy records and the turn end are on the harness clock; only a tool start gets the slack. */
        const quietAfter = (done: number, recorded: number[]): number => {
            const next = Math.min(
                ...recorded.filter((ms) => ms >= done),
                ...tools.filter((ms) => ms >= done - CLOCK_SLACK_MS),
                Number.POSITIVE_INFINITY,
            );
            return next - done;
        };
        const silence = "with no tool run, call, or turn end";
        if (began) {
            const starts = calls.map((c) => c.scenario_ms);
            const quiet = quietAfter(began.scenario_ms, [...starts, e.scenario_ms]);
            if (quiet > quietMs) windows.push(`turn began, then ${Math.round(quiet / 1000)} s`);
        }
        for (const c of calls) {
            const done = c.scenario_ms + (c.wall_ms - c.started_wall_ms);
            const others = turnCalls.filter((x) => x !== c).map((x) => x.scenario_ms);
            const quiet = quietAfter(done, [...others, e.scenario_ms]);
            if (quiet > quietMs)
                windows.push(`call ${c.seq} completed, then ${Math.round(quiet / 1000)} s`);
        }
        if (windows.length > 0) {
            const evidence = `${windows.join("; ")} ${silence}`;
            out.push({ oracle: "F4", arm: arm.arm, at: turn, evidence });
        }
    }
    return out;
}

export function rssFit(points: { x: number; y: number }[]): { slope: number; r2: number } | null {
    if (points.length < 3) return null;
    const n = points.length;
    const mx = points.reduce((s, p) => s + p.x, 0) / n;
    const my = points.reduce((s, p) => s + p.y, 0) / n;
    const sxx = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
    if (sxx === 0) return null;
    const sxy = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
    const slope = sxy / sxx;
    const ssr = points.reduce((s, p) => s + (p.y - (my + slope * (p.x - mx))) ** 2, 0);
    const sst = points.reduce((s, p) => s + (p.y - my) ** 2, 0);
    return { slope, r2: sst === 0 ? 0 : 1 - ssr / sst };
}

/** Consecutive samples from one daemon process, by pid and start time; a restart starts a new lifetime with its own RSS(0). */
function lifetimes(samples: Sample[]): Sample[][] {
    const out: Sample[][] = [];
    const same = (a: Sample, b: Sample) => a.pid === b.pid && a.start === b.start;
    for (const s of samples) {
        const last = out.at(-1);
        if (last && last[0] && same(last[0], s)) last.push(s);
        else out.push([s]);
    }
    return out;
}

function f5(arm: ArmLogs, run: RunLogs): Activation[] {
    const { c_bytes_per_session: c, r2_threshold } = run.prereg.leak_bound;
    const ends = arm.journal
        .filter((e) => e.kind === "Event" && run.kinds.get(String(e.event)) === "session_end")
        .map((e) => e.scenario_ms);
    const samples = arm.resources.filter((s) => typeof s.rss === "number");
    const out: Activation[] = [];
    const lives = lifetimes(samples);
    for (const life of lives) {
        const first = life[0] as Sample;
        const scope = lives.length > 1 ? `daemon ${first.pid}` : "run";
        const sessionsAt = (ms: number) => ends.filter((end) => end <= ms).length;
        const offset = sessionsAt(first.scenario_ms);
        const points = life.map((s) => ({
            x: sessionsAt(s.scenario_ms) - offset,
            y: s.rss as number,
        }));
        const base = first.rss as number;
        const last = points.at(-1) as { x: number; y: number };
        const over = last.y >= 2 * base + last.x * c ? last : undefined;
        if (over) {
            const at = `session ${over.x + offset}`;
            const evidence = `RSS ${over.y} after ${over.x} sessions exceeds 2 x ${base} + sessions x ${c}`;
            out.push({ oracle: "F5", arm: arm.arm, at, evidence });
        }
        const fit = rssFit(points);
        if (fit && fit.r2 >= Number(r2_threshold) && fit.slope > c) {
            const evidence = `RSS slope ${Math.round(fit.slope)} B/session (r2 ${fit.r2.toFixed(2)}) exceeds ${c}`;
            out.push({ oracle: "F5", arm: arm.arm, at: scope, evidence });
        }
    }
    return out;
}

export interface Ledger {
    tokens: Record<string, number>;
    total: number;
    title_calls: number;
}

export function ledger(arm: ArmLogs): Ledger {
    const tokens: Record<string, number> = {};
    for (const c of arm.calls.filter((x) => !HARNESS.has(x.component))) {
        tokens[c.component] = (tokens[c.component] ?? 0) + TOKENS(c);
    }
    const total = Object.values(tokens).reduce((a, b) => a + b, 0);
    return { tokens, total, title_calls: arm.calls.filter((c) => c.component === "title").length };
}

function f6(arm: ArmLogs, run: RunLogs): Activation[] {
    const host = run.arms.find((a) => a.arm === "host");
    if (!host || arm.arm === "host") return [];
    const [mine, base] = [ledger(arm), ledger(host)];
    const evidence: string[] = [];
    const limit = Number(run.prereg.oracles.cost_ratio_max);
    if (base.total > 0 && mine.total / base.total > limit) {
        const ratio = (mine.total / base.total).toFixed(2);
        evidence.push(`${mine.total} tokens vs host ${base.total} (${ratio}x > ${limit}x)`);
    }
    if (mine.title_calls > base.title_calls) {
        evidence.push(`${mine.title_calls} title calls vs host ${base.title_calls}`);
    }
    if (evidence.length === 0) return [];
    return [{ oracle: "F6", arm: arm.arm, at: "run", evidence: evidence.join("; ") }];
}

function f7(arm: ArmLogs): Activation[] {
    return arm.calls
        .filter((c) => c.component === "agent" && c.response_text)
        .flatMap((c) => {
            const hit = INTERNAL_TEXT.map((re) => re.exec(c.response_text ?? "")).find(Boolean);
            return hit
                ? [{ oracle: "F7" as const, arm: arm.arm, at: at(c), evidence: hit[0] }]
                : [];
        });
}

function logHits(
    arm: ArmLogs,
    oracle: OracleId,
    pattern: RegExp,
    log: string[],
    component: string,
): Activation[] {
    return log
        .filter((l) => pattern.test(l))
        .map((l) => ({
            oracle,
            arm: arm.arm,
            at: STAMP.exec(l)?.[0] ?? "log",
            evidence: l.slice(0, 200),
            component,
        }));
}

export function runOracles(run: RunLogs): Activation[] {
    const quiet = run.prereg.oracles.hang_quiet_ms;
    return run.arms.flatMap((arm) => {
        const overflow = f1(arm);
        const agentOverflow = overflow.filter((a) => (a.component ?? "agent") === "agent");
        const f9 =
            NO_HOST_COMPACTION.has(arm.arm) &&
            agentOverflow.length > 0 &&
            !arm.calls.some((c) => c.component === "native_compaction")
                ? [
                      {
                          oracle: "F9" as const,
                          arm: arm.arm,
                          at: "run",
                          evidence: `${agentOverflow.length} agent overflows with no host compaction`,
                      },
                  ]
                : [];
        return [
            ...overflow,
            ...failedCalls(arm, (t) => ARRAY_SHAPE.some((re) => re.test(t))).map((c) => ({
                oracle: "F2" as const,
                arm: arm.arm,
                at: at(c),
                evidence: errorOf(c).slice(0, 200),
                component: c.component,
            })),
            ...logHits(arm, "F3", RAW_PASS, arm.pluginLog, "transform"),
            ...f4(arm, quiet),
            ...f5(arm, run),
            ...f6(arm, run),
            ...f7(arm),
            ...logHits(
                arm,
                "F8",
                CAPTURE_REFUSED,
                [...arm.pluginLog, ...arm.daemonLog],
                "memory_capture",
            ),
            ...f9,
        ];
    });
}

export interface OracleCount {
    activations: number;
    uncovered: boolean;
    by_arm: Record<string, number>;
    by_component: Record<string, number>;
}

export function oracleReport(runs: RunLogs[]): Record<string, Record<OracleId, OracleCount>> {
    const tiers = new Map<string, Activation[]>();
    for (const run of runs)
        tiers.set(run.tier, [...(tiers.get(run.tier) ?? []), ...runOracles(run)]);
    const report: Record<string, Record<OracleId, OracleCount>> = {};
    for (const [tier, acts] of tiers) {
        report[tier] = Object.fromEntries(
            ORACLES.map((id) => {
                const mine = acts.filter((a) => a.oracle === id);
                const by_arm: Record<string, number> = {};
                const by_component: Record<string, number> = {};
                for (const a of mine) {
                    by_arm[a.arm] = (by_arm[a.arm] ?? 0) + 1;
                    if (a.component)
                        by_component[a.component] = (by_component[a.component] ?? 0) + 1;
                }
                const count = {
                    activations: mine.length,
                    uncovered: mine.length === 0,
                    by_arm,
                    by_component,
                };
                return [id, count];
            }),
        ) as Record<OracleId, OracleCount>;
    }
    return report;
}
