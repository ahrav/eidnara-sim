import type { CallView } from "../grade/artefacts";
import type { CallRecord } from "../proxy/records";

/**
 * A call record as a snapshot's `proxy-call` artefact holds it. A capture and a grader that
 * builds a session view both project through these functions.
 */
export function projectCall(r: CallRecord): Omit<CallView, "turn_index"> {
    return {
        seq: r.seq,
        arm: r.arm,
        session: r.session ?? "",
        component: r.component,
        turn: r.turn,
        scenario_ms: r.scenario_ms,
        status: r.status,
        error: r.error,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_write_tokens: r.cache_write_tokens,
        ...(r.response_text !== undefined ? { response_text: r.response_text } : {}),
        ...(r.response_text_truncated ? { response_text_truncated: true } : {}),
        ...(r.status >= 400 || r.error !== null || r.finish_reason === "stream_cut"
            ? { failed: true }
            : {}),
    };
}

/**
 * A session's proxy calls with its delivered user turns placed among them. A user turn's message
 * opens its turn, so it sits just before the turn's first call, or after the last call recorded
 * by its scenario time when the turn made none. Its `seq` is fractional between the two proxy
 * sequence numbers around it, so the list stays in one increasing order the graders compare.
 */
export function withUserTurns(
    calls: CallView[],
    turns: { event: string; scenario_ms: number; label: string; turn_index?: number }[],
    arm: string,
    session: string,
): CallView[] {
    const placed = turns.map((t) => {
        const first = calls.find((c) => c.turn === t.event);
        const before = calls.filter((c) => c.scenario_ms <= t.scenario_ms).at(-1);
        const after = first ? first.seq - 1 : (before?.seq ?? 0);
        return { t, after };
    });
    const views = placed.map(({ t, after }, i) => {
        const peers = placed.filter((p) => p.after === after);
        const rank = peers.findIndex((p) => p === placed[i]);
        return {
            seq: after + (rank + 1) / (peers.length + 1),
            arm,
            session,
            component: "user-sim",
            turn: t.event,
            ...(t.turn_index === undefined ? {} : { turn_index: t.turn_index }),
            scenario_ms: t.scenario_ms,
            status: 200,
            error: null,
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            label: t.label,
            // The entry comes from the journal, not from a proxy call record.
            journal: true,
        } satisfies CallView;
    });
    return [...calls, ...views].sort((a, b) => a.seq - b.seq);
}

/**
 * The returned projector takes one session's records in log order. Each call takes the turn
 * index of the turn it names, else the running index of the session's preceding calls.
 */
export function sessionViews(turnIndex: Map<string, number>): (r: CallRecord) => CallView {
    let turn: number | undefined;
    return (r) => {
        const own = r.origin_turn ?? r.turn;
        const at = own ? turnIndex.get(own) : undefined;
        // A background call credited to an earlier turn takes that turn's index without moving
        // the running index later calls without a turn take.
        if (r.origin_turn !== undefined && at !== undefined) {
            const view = projectCall(r);
            return { ...view, turn_index: at };
        }
        turn = at ?? turn;
        const view = projectCall(r);
        return turn === undefined ? view : { ...view, turn_index: turn };
    };
}
