import type { HeldCall } from "../run/calllog";
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
    /**
     * Turns whose final agent reply the proxy streamed with text (`calls.jsonl` `response_text`,
     * the text graders read and the user simulator receives), and of those the ones holding an
     * Eidnara marker (`EIDNARA_MARKER`).
     */
    answers_streamed: number;
    marker_answers_streamed: number;
    /**
     * The same over each turn's final assistant text as the host transcript persists it, what
     * the user keeps; null on a host whose transcript this harness does not read.
     */
    answers_persisted: number | null;
    marker_answers_persisted: number | null;
    /** Calls the provider ended `content_filtered`, and the turns of agent calls so ended. */
    content_filtered_calls: number;
    content_filtered_turns: number;
}

/**
 * Eidnara's block tag (`§<n>§`, the transform's `tag_prefix`) and the tags of the context blocks
 * it injects, any of which in an answer is text the agent copied from Eidnara's own framing.
 */
export const EIDNARA_MARKER =
    /§\d+§|<\/?(?:project-memory|session-history|session-history-since|eidnara-search-hint|eidnara-search-auto|packed-context|memory-updates|new-notes|covered-system-messages|project-docs|new-history_segments)(?=[\s>/])/;

const COMPACTION = new Set(["native_compaction", "history_summarizer"]);
const TOO_LONG =
    /prompt is too long|input is too long|too many (?:input )?tokens|context (?:length|window)/i;

export const promptTokens = (c: HeldCall) =>
    c.input_tokens + c.cache_read_tokens + c.cache_write_tokens;

export const refusedCompaction = (c: HeldCall) =>
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
    const bySession = new Map<string, HeldCall[]>();
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
        // A compaction mark covers the first turn whose agent request left after the
        // compaction finished; an agent call's own mark covers its turn.
        const mark = (c: HeldCall, why: string): HealthMark => ({
            seq: c.seq,
            turn:
                (c.component === "agent" ? c.turn : null) ??
                sorted.find(
                    (x) =>
                        x.component === "agent" &&
                        x.started_wall_ms >= c.wall_ms &&
                        x.turn !== null,
                )?.turn ??
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
        let filtered = 0;
        const filteredTurns = new Set<string>();
        const finalReply = new Map<string, string>();
        const refusals: HeldCall[] = [];
        let overflowCall: HeldCall | null = null;
        for (const c of sorted) {
            if (c.finish_reason === "content_filtered") {
                filtered++;
                if (c.component === "agent" && c.turn !== null) filteredTurns.add(c.turn);
            }
            if (c.component === "agent" && c.turn !== null && c.response_text?.trim()) {
                finalReply.set(c.turn, c.response_text);
            }
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
        const streamed = [...finalReply.values()];
        // A session the scenario does not declare (a second client's) has no streamed answers to
        // set beside its transcript; a declared session without a transcript file is unread.
        const persisted = run.arms.get(arm)?.answers;
        const transcript = projectOf.has(session) ? persisted?.get(session) : [];
        const kept = transcript ? transcript.filter((a) => a.trim()) : null;
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
            answers_streamed: streamed.length,
            marker_answers_streamed: streamed.filter((a) => EIDNARA_MARKER.test(a)).length,
            answers_persisted: kept?.length ?? null,
            marker_answers_persisted: kept
                ? kept.filter((a) => EIDNARA_MARKER.test(a)).length
                : null,
            content_filtered_calls: filtered,
            content_filtered_turns: filteredTurns.size,
        });
    }
    return out.sort((a, b) => (a.arm + a.session < b.arm + b.session ? -1 : 1));
}
