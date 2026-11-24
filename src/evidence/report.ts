import { reviewLines, searchFallback } from "../run/capabilities";
import type { SessionHealth } from "./health";
import type { ReviewerEvidence, RunData } from "./load";
import type { ProbeEvidence } from "./stages";

export interface RunEvidence {
    name: string;
    run: RunData;
    probes: ProbeEvidence[];
    sessions: SessionHealth[];
}

const cell = (v: unknown) =>
    String(v ?? "")
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ");
const row = (cells: unknown[]) => `| ${cells.map(cell).join(" | ")} |`;

const share = (n: number, of: number) =>
    of === 0 ? `${n}` : `${n} (${((100 * n) / of).toFixed(1)}%)`;

type AnswerTotals = Pick<
    SessionHealth,
    | "answers_streamed"
    | "marker_answers_streamed"
    | "answers_persisted"
    | "marker_answers_persisted"
    | "content_filtered_calls"
    | "content_filtered_turns"
>;

export function armAnswers(sessions: readonly SessionHealth[]): Map<string, AnswerTotals> {
    const out = new Map<string, AnswerTotals>();
    const add = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);
    for (const s of sessions) {
        const t = out.get(s.arm) ?? {
            answers_streamed: 0,
            marker_answers_streamed: 0,
            answers_persisted: 0,
            marker_answers_persisted: 0,
            content_filtered_calls: 0,
            content_filtered_turns: 0,
        };
        out.set(s.arm, {
            answers_streamed: add(t.answers_streamed, s.answers_streamed),
            marker_answers_streamed: add(t.marker_answers_streamed, s.marker_answers_streamed),
            answers_persisted: add(t.answers_persisted, s.answers_persisted),
            marker_answers_persisted: add(t.marker_answers_persisted, s.marker_answers_persisted),
            content_filtered_calls: t.content_filtered_calls + s.content_filtered_calls,
            content_filtered_turns: t.content_filtered_turns + s.content_filtered_turns,
        });
    }
    return out;
}

/** Answers whether a turn falls in a flagged stretch, from indexes built once per run. */
export function flaggedTurns(
    run: RunData,
    sessions: SessionHealth[],
): (arm: string, session: string | null, turn: string) => boolean {
    const order = new Map(run.scenario.events.map((e, i) => [e.id, i]));
    const from = new Map<string, number>();
    for (const h of sessions) {
        if (!h.cause || h.flagged_from === null) continue;
        from.set(`${h.arm}\u0000${h.session}`, order.get(h.flagged_from) ?? Infinity);
    }
    return (arm, session, turn) => {
        const start = from.get(`${arm}\u0000${session}`);
        return start !== undefined && (order.get(turn) ?? -1) >= start;
    };
}

interface Side {
    turns: number;
    agent_calls: number;
    prompt_tokens: number;
    output_tokens: number;
    prompt_ms: number[];
    probes: number;
    passed: number;
}

const empty = (): Side => ({
    turns: 0,
    agent_calls: 0,
    prompt_tokens: 0,
    output_tokens: 0,
    prompt_ms: [],
    probes: 0,
    passed: 0,
});

export function armComparison(r: RunEvidence): Map<string, { healthy: Side; flagged: Side }> {
    const out = new Map<string, { healthy: Side; flagged: Side }>();
    const side = (arm: string, flagged: boolean) => {
        const sides = out.get(arm) ?? { healthy: empty(), flagged: empty() };
        out.set(arm, sides);
        return flagged ? sides.flagged : sides.healthy;
    };
    const sessionOf = new Map(r.run.scenario.events.map((e) => [e.id, e.session ?? null]));
    const flaggedTurn = flaggedTurns(r.run, r.sessions);
    for (const e of r.run.journal) {
        if (e.kind !== "EndTurn" || e.arm === null) continue;
        const turn = String(e.event);
        const s = side(e.arm, flaggedTurn(e.arm, sessionOf.get(turn) ?? null, turn));
        s.turns++;
        if (typeof e.prompt_ms === "number") s.prompt_ms.push(e.prompt_ms);
    }
    for (const c of r.run.calls) {
        if (c.component !== "agent" || c.turn === null) continue;
        const s = side(c.arm, flaggedTurn(c.arm, c.session, c.turn));
        s.agent_calls++;
        s.prompt_tokens += c.input_tokens + c.cache_read_tokens + c.cache_write_tokens;
        s.output_tokens += c.output_tokens;
    }
    for (const p of r.probes) {
        if (p.verdict === "excluded" || p.event === null) continue;
        const s = side(p.arm, flaggedTurn(p.arm, p.session, p.event));
        s.probes++;
        if (p.attributed.cause === "none") s.passed++;
    }
    return out;
}

const median = (xs: number[]) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/**
 * The fused-route arms' `eidnara_search` results by route, one row per run and arm: a degraded
 * answer is a legacy-scan answer on a transient reason, counted with its share of the answered
 * results beside the bound the run registered (`docs/hosts.md`).
 */
function searchRoutes(runs: RunEvidence[]): string[] {
    const out = [
        "",
        "### Search route answers",
        "",
        "Per arm that declares the fused route, from its capability record: the `eidnara_search` results the fused route ranked, the degraded answers (the legacy snapshot scan answered one call the route ended on a transient reason), their share of the answered results beside the registered bound, the legacy-scan answers on any other reason, and the errored results.",
        "",
        row([
            "run",
            "arm",
            "answered",
            "fused",
            "degraded",
            "degraded share",
            "registered bound",
            "other fallback reasons",
            "errored",
        ]),
        row(["---", "---", "---", "---", "---", "---", "---", "---", "---"]),
    ];
    let any = false;
    for (const r of runs) {
        for (const [arm, data] of r.run.arms) {
            if (!data.search) continue;
            any = true;
            const { results, bound } = data.search;
            const f = searchFallback(results);
            out.push(
                row([
                    r.name,
                    arm,
                    f.answered,
                    results.fused,
                    f.degraded === 0 ? 0 : `${f.degraded} (${f.degraded_reasons.join(", ")})`,
                    f.degraded_share === null ? "" : `${(100 * f.degraded_share).toFixed(1)}%`,
                    bound?.max_degraded_share ?? "none: every fallback refuses",
                    f.persistent_reasons.join(", ") || "none",
                    results.errored,
                ]),
            );
        }
    }
    if (!any) out.push(row(["none", "", "", "", "", "", "", "", ""]));
    return out;
}

/** The non-zero counts of a tally as `name n`, in the tally's order, or `0` with none. */
const counts = (tally: Readonly<Record<string, number>>): string =>
    Object.entries(tally)
        .filter(([, n]) => n > 0)
        .map(([name, n]) => `${name} ${n}`)
        .join(", ") || "0";

/** One arm's reviewer evidence as the cells of its row in the report. */
function reviewerCells(r: ReviewerEvidence): string[] {
    const { log, drains, status } = r;
    const stage1 = Object.entries(log.stage1)
        .filter(([, c]) => c.keep + c.flagged + c.other > 0)
        .map(([decider, c]) => {
            const other = c.other > 0 ? `, ${c.other} other` : "";
            return `${decider}: ${c.keep} keep, ${c.flagged} flagged${other} (${c.models.join(", ")})`;
        });
    const failed =
        log.stage1_default_failed > 0
            ? `${log.stage1_failed}; default failed ${log.stage1_default_failed}`
            : String(log.stage1_failed);
    const seconds = (ms: number) => (ms / 1000).toFixed(1);
    const pair = (c: { live: number; retired: number } | null) =>
        c === null ? "unread" : `${c.live} live, ${c.retired} retired`;
    return [
        r.switch === null ? "" : r.switch ? "on" : "off",
        counts(log.enqueued),
        String(log.selections),
        stage1.join("; ") || "0",
        failed,
        String(log.unread_later),
        counts(log.applied),
        `${log.left_for_reader} left for a reader, ${log.unapplied} unapplied`,
        counts(log.waits),
        drains.calls + drains.unreadable === 0
            ? "none"
            : `${drains.calls} steps, ${drains.settled_runs} runs settled, ${seconds(drains.total_wall_ms)} s in all, ${seconds(drains.max_wall_ms)} s the longest, ${drains.errors} with an error${drains.unreadable > 0 ? `, ${drains.unreadable} unreadable lines` : ""}`,
        counts(r.calls),
        status === null || status.readings === 0
            ? "no reading"
            : `open in ${status.open} of ${status.readings} readings, last ${status.last}`,
        pair(r.failed_commands),
        pair(r.disputed),
    ];
}

/**
 * The memory reviewer by run and arm, for every arm whose directory the run holds: the arm's
 * switch beside what its daemon log, its settle steps, the gateway's records, the daemon's
 * status readings, and its final store show.
 */
function memoryReviewer(runs: RunEvidence[]): string[] {
    const head = [
        "run",
        "arm",
        "switch",
        "reviews enqueued",
        "selection passes",
        "stage-1 decisions",
        "failed stage-1 requests",
        "ended on an unread reference",
        "proposals applied",
        "proposals left",
        "waits",
        "settle steps",
        "gateway calls",
        "status",
        "failed-command records",
        "disputed objects",
    ];
    const out = [
        "",
        "### Memory reviewer",
        "",
        "Per arm, read by one rule: the reviewer's lines in `daemon.log` over every daemon generation (review jobs enqueued by trigger, selection passes, stage-1 decisions by decider with the models named, failed stage-1 requests, reviews ended on a later reference the model was not shown, proposals applied by kind, proposals left for a reader or left unapplied, and the lines that report reviews waiting), the settle steps of `review-drain.jsonl`, the gateway's calls of the reviewer's two components, the reviewer's activation state in the daemon's status readings, and the final store's failed-command records and disputed objects (`docs/hosts.md`). An arm with the switch off shows no review; a disputed object there comes from the agent's own `eidnara_memory` dispute.",
        "",
        row(head),
        row(head.map(() => "---")),
    ];
    let any = false;
    for (const r of runs) {
        for (const [arm, data] of r.run.arms) {
            if (!data.reviewer) continue;
            // An arm without a daemon holds no log, no status, and no store: its row would be empty.
            const shown =
                data.reviewer.switch === true ||
                data.profile?.plugin === true ||
                reviewLines(data.reviewer.log) > 0 ||
                Object.values(data.reviewer.calls).some((n) => n > 0);
            if (!shown) continue;
            any = true;
            out.push(row([r.name, arm, ...reviewerCells(data.reviewer)]));
        }
    }
    if (!any) out.push(row(["none", ...head.slice(1).map(() => "")]));
    return out;
}

export function renderEvidence(runs: RunEvidence[]): string {
    const out: string[] = ["## Evidence path", ""];
    out.push(
        "Each graded probe carries per-stage observations and one attributed cause: the first stage that did not hold, `application` when the literal reached the probe context, or the session's context-health cause when the probe ran in a flagged session (`docs/evidence.md`).",
        "",
        "### Attribution by cause",
        "",
        row(["run", "arm", "graded", "pass", "fail", "excluded", "held", "causes"]),
        row(["---", "---", "---", "---", "---", "---", "---", "---"]),
    );
    for (const r of runs) {
        const arms = [...new Set(r.probes.map((p) => p.arm))];
        for (const arm of arms) {
            const mine = r.probes.filter((p) => p.arm === arm);
            const causes = new Map<string, number>();
            for (const p of mine) {
                if (p.attributed.cause === "none") continue;
                const k = `${p.attributed.cause}/${p.attributed.status}`;
                causes.set(k, (causes.get(k) ?? 0) + 1);
            }
            out.push(
                row([
                    r.name,
                    arm,
                    mine.length,
                    mine.filter((p) => p.verdict === "pass").length,
                    mine.filter((p) => p.verdict === "fail").length,
                    mine.filter((p) => p.verdict === "excluded").length,
                    mine.filter((p) => p.attributed.cause === "none").length,
                    [...causes].map(([k, n]) => `${k} ${n}`).join(", ") || "none",
                ]),
            );
        }
    }
    out.push(
        "",
        "### Per probe",
        "",
        row(["run", "arm", "item", "type", "verdict", "stages", "cause", "reason", "evidence"]),
        row(["---", "---", "---", "---", "---", "---", "---", "---", "---"]),
    );
    for (const r of runs) {
        for (const p of r.probes) {
            const pointers = (
                p.attributed.pointers ??
                p.stages.filter((s) => s.stage === p.attributed.cause).flatMap((s) => s.pointers)
            )
                .slice(0, 2)
                .map((x) => `${x.path}${x.at ? ` ${x.at}` : ""}`);
            out.push(
                row([
                    r.name,
                    p.arm,
                    p.item,
                    p.probe_type,
                    p.verdict,
                    p.stages.map((s) => `${s.stage}:${s.status}`).join(" "),
                    `${p.attributed.cause} (${p.attributed.status})`,
                    p.attributed.reason.slice(0, 160),
                    pointers.join("; ") || p.grade.path,
                ]),
            );
        }
    }
    out.push(...searchRoutes(runs));
    out.push(...memoryReviewer(runs));
    out.push(
        "",
        "### Context health",
        "",
        "Sessions with a refused or empty compaction, a prompt over the configured context window, or a prompt-too-long refusal. Their turns from `flagged from` on stay out of the healthy comparison rows below.",
        "",
        row([
            "run",
            "arm",
            "session",
            "compactions",
            "refused",
            "failed",
            "peak prompt",
            "limit",
            "over window",
            "too long",
            "cause",
            "flagged from",
        ]),
        row(["---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---"]),
    );
    let any = false;
    for (const r of runs) {
        for (const s of r.sessions) {
            const quiet =
                !s.cause &&
                s.compaction_refused === 0 &&
                s.compaction_failed === 0 &&
                s.over_window_calls === 0;
            if (quiet) continue;
            any = true;
            out.push(
                row([
                    r.name,
                    s.arm,
                    s.session,
                    s.compaction_attempts,
                    s.compaction_refused,
                    s.compaction_failed,
                    s.peak_prompt_tokens,
                    s.context_limit,
                    s.over_window_calls,
                    s.prompt_too_long_errors,
                    s.cause ?? "",
                    s.flagged_from ?? "",
                ]),
            );
        }
    }
    if (!any) out.push(row(["none", "", "", "", "", "", "", "", "", "", "", ""]));
    const p76 = runs.flatMap((r) =>
        r.sessions.filter((s) => s.p90_native_compaction !== null).map((s) => ({ r, s })),
    );
    out.push("");
    if (p76.length === 0) {
        out.push(
            "SIM-P76: no forced p90 session ran on an arm whose host compacts beside Eidnara.",
        );
    } else {
        const missing = p76.filter((x) => x.s.p90_native_compaction === false);
        out.push(
            `SIM-P76: ${p76.length - missing.length} of ${p76.length} forced p90 sessions on host-compaction Eidnara arms hold a native_compaction record${missing.length ? `; missing in ${missing.map((x) => `${x.r.name}/${x.s.arm}/${x.s.session}`).join(", ")}` : ""}.`,
        );
    }
    out.push(
        "",
        "### Answer markers and provider content filtering",
        "",
        "Per arm, the turns whose final answer holds an Eidnara marker (a `§<n>§` block tag or an injected block tag): streamed is the provider stream the proxy relayed (`calls.jsonl` `response_text`, which graders read and a live UI may show while streaming); persisted is the final assistant text the host transcript keeps, what the user keeps (Pi only). Content-filtered counts the calls and agent turns the provider ended `content_filtered`.",
        "",
        row([
            "run",
            "arm",
            "streamed answers",
            "with marker",
            "persisted answers",
            "with marker",
            "content_filtered calls",
            "content_filtered turns",
        ]),
        row(["---", "---", "---", "---", "---", "---", "---", "---"]),
    );
    for (const r of runs) {
        for (const [arm, t] of armAnswers(r.sessions)) {
            out.push(
                row([
                    r.name,
                    arm,
                    t.answers_streamed ?? "not recorded",
                    t.answers_streamed === null
                        ? ""
                        : share(t.marker_answers_streamed ?? 0, t.answers_streamed),
                    t.answers_persisted ?? "not read",
                    t.answers_persisted === null
                        ? ""
                        : share(t.marker_answers_persisted ?? 0, t.answers_persisted),
                    t.content_filtered_calls,
                    t.content_filtered_turns,
                ]),
            );
        }
    }
    out.push(
        "",
        "### Arm comparison, flagged sessions apart",
        "",
        row([
            "run",
            "arm",
            "sessions",
            "turns",
            "agent calls",
            "prompt tokens",
            "output tokens",
            "median prompt ms",
            "probes held/graded",
        ]),
        row(["---", "---", "---", "---", "---", "---", "---", "---", "---"]),
    );
    for (const r of runs) {
        for (const [arm, sides] of armComparison(r)) {
            for (const [label, s] of [
                ["healthy", sides.healthy],
                ["flagged", sides.flagged],
            ] as const) {
                if (label === "flagged" && s.turns === 0 && s.agent_calls === 0) continue;
                out.push(
                    row([
                        r.name,
                        arm,
                        label,
                        s.turns,
                        s.agent_calls,
                        s.prompt_tokens,
                        s.output_tokens,
                        median(s.prompt_ms) ?? "",
                        `${s.passed}/${s.probes}`,
                    ]),
                );
            }
        }
    }
    out.push("");
    return out.join("\n");
}
