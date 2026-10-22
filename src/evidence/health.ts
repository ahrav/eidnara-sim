import type { CallRecord } from "../proxy/records";
import type { RunData } from "./load";

/** A refused or empty compaction, or a prompt over the window, with the call that showed it. */
export interface HealthMark {
    seq: number;
    turn: string | null;
    why: string;
}

export interface SessionHealth {
    schema: "sim-evidence-session/v1";
    arm: string;
    session: string;
    project: string | null;
    compaction_attempts: number;
    compaction_refused: number;
    compaction_failed: number;
    agent_calls: number;
    peak_prompt_tokens: number;
    context_limit: number;
    over_window_calls: number;
    prompt_too_long_errors: number;
    first_refused: HealthMark | null;
    first_overflow: HealthMark | null;
    cause: "compaction-refused" | "context-overflow" | null;
    /** The turn of the mark that set `cause`. */
    flagged_from: string | null;
    /**
     * Whether this forced p90 session holds a `native_compaction` record, on an arm whose host
     * compacts beside the Eidnara plugin; null on every other session.
     */
    p90_native_compaction: boolean | null;
}

const COMPACTION = new Set(["native_compaction", "history_summarizer"]);
const TOO_LONG =
    /prompt is too long|input is too long|too many (?:input )?tokens|context (?:length|window)/i;

export const promptTokens = (c: CallRecord) =>
    c.input_tokens + c.cache_read_tokens + c.cache_write_tokens;

export const refusedCompaction = (c: CallRecord) =>
    COMPACTION.has(c.component) &&
    c.status === 200 &&
    c.error === null &&
    c.finish_reason !== "stream_cut" &&
    (c.finish_reason === "content_filtered" || c.output_tokens === 0);

/** The first turn of the session the arm began at or after `wall`. */
function nextTurn(run: RunData, arm: string, session: string, wall: number): string | null {
    const sessionOf = new Map(run.scenario.events.map((e) => [e.id, e.session]));
    const begin = run.journal.find(
        (e) =>
            e.kind === "BeginTurn" &&
            e.arm === arm &&
            e.wall_ms >= wall &&
            sessionOf.get(String(e.event)) === session,
    );
    return begin ? String(begin.event) : null;
}

/**
 * `cause` is `compaction-refused` when a refused compaction finished before the session's first
 * prompt over the window or prompt-too-long refusal was sent, and `context-overflow` when such a
 * prompt has no refused compaction finished before it.
 */
export function sessionHealth(run: RunData): SessionHealth[] {
    const projectOf = new Map(run.scenario.sessions.map((s) => [s.id, s.project]));
    const p90 = new Map(run.scenario.sessions.map((s) => [s.id, s.forced_p90 === true]));
    const bySession = new Map<string, CallRecord[]>();
    const sessionOf = new Map(run.scenario.events.map((e) => [e.id, e.session]));
    for (const e of run.journal) {
        if (e.kind !== "Event" || typeof e.arm !== "string") continue;
        const session = sessionOf.get(String(e.event));
        if (session) bySession.set(`${e.arm}\u0000${session}`, []);
    }
    for (const c of run.calls) {
        if (c.session === null || c.component === "user-sim" || c.component === "judge") continue;
        const key = `${c.arm}\u0000${c.session}`;
        const list = bySession.get(key) ?? [];
        list.push(c);
        bySession.set(key, list);
    }
    const out: SessionHealth[] = [];
    for (const [key, calls] of bySession) {
        const [arm, session] = key.split("\u0000") as [string, string];
        const profile = run.arms.get(arm)?.profile;
        const sorted = [...calls].sort((a, b) => a.seq - b.seq);
        // A mark between turns covers the session's next turn, the first one it can affect.
        const mark = (c: CallRecord, why: string): HealthMark => ({
            seq: c.seq,
            // A between-turn mark covers the first turn whose request left after it finished.
            turn:
                c.turn ??
                sorted.find((x) => x.started_wall_ms >= c.wall_ms && x.turn !== null)?.turn ??
                nextTurn(run, arm, session, c.wall_ms),
            why,
        });
        let first_refused: HealthMark | null = null;
        let first_overflow: HealthMark | null = null;
        let attempts = 0;
        let refused = 0;
        let failed = 0;
        let agent = 0;
        let peak = 0;
        let over = 0;
        let tooLong = 0;
        let native = false;
        const refusals: CallRecord[] = [];
        let overflowCall: CallRecord | null = null;
        for (const c of sorted) {
            if (COMPACTION.has(c.component)) {
                attempts++;
                if (c.component === "native_compaction") native = true;
                if (refusedCompaction(c)) {
                    refused++;
                    refusals.push(c);
                    first_refused ??= mark(
                        c,
                        `${c.component} ${c.finish_reason ?? "no finish reason"}, ${c.output_tokens} output tokens`,
                    );
                } else if (
                    c.status !== 200 ||
                    c.error !== null ||
                    c.finish_reason === "stream_cut"
                ) {
                    failed++;
                }
            }
            if (c.component !== "agent") continue;
            agent++;
            const tokens = promptTokens(c);
            peak = Math.max(peak, tokens);
            if (tokens > run.contextLimit) {
                over++;
                overflowCall ??= c;
                first_overflow ??= mark(c, `${tokens} prompt tokens over ${run.contextLimit}`);
            }
            if (c.error !== null && TOO_LONG.test(c.error)) {
                tooLong++;
                overflowCall ??= c;
                first_overflow ??= mark(c, c.error.slice(0, 200));
            }
        }
        // Records are numbered as calls finish, so a refusal counts as the overflow's cause only
        // when it finished before the overflowing request was sent.
        const sent = overflowCall?.started_wall_ms;
        const cause_refusal =
            sent === undefined ? undefined : refusals.find((r) => r.wall_ms <= sent);
        const cause = cause_refusal
            ? "compaction-refused"
            : first_overflow
              ? "context-overflow"
              : null;
        const from = cause_refusal
            ? mark(
                  cause_refusal,
                  `${cause_refusal.component} ${cause_refusal.finish_reason ?? "no finish reason"}, ${cause_refusal.output_tokens} output tokens`,
              )
            : first_overflow;
        out.push({
            schema: "sim-evidence-session/v1",
            arm,
            session,
            project: projectOf.get(session) ?? null,
            compaction_attempts: attempts,
            compaction_refused: refused,
            compaction_failed: failed,
            agent_calls: agent,
            peak_prompt_tokens: peak,
            context_limit: run.contextLimit,
            over_window_calls: over,
            prompt_too_long_errors: tooLong,
            first_refused,
            first_overflow,
            cause,
            flagged_from: cause === null ? null : (from?.turn ?? null),
            p90_native_compaction:
                profile?.plugin === true && profile.host_compaction === true && p90.get(session)
                    ? native
                    : null,
        });
    }
    return out.sort((a, b) => (a.arm + a.session < b.arm + b.session ? -1 : 1));
}
