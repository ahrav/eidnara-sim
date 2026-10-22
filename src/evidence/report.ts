import type { SessionHealth } from "./health";
import type { RunData } from "./load";
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

export function flaggedTurn(
    run: RunData,
    sessions: SessionHealth[],
    arm: string,
    session: string | null,
    turn: string,
): boolean {
    const h = sessions.find((s) => s.arm === arm && s.session === session);
    if (!h?.cause || h.flagged_from === null) return false;
    const order = new Map(run.scenario.events.map((e, i) => [e.id, i]));
    return (order.get(turn) ?? -1) >= (order.get(h.flagged_from) ?? Infinity);
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
    for (const e of r.run.journal) {
        if (e.kind !== "EndTurn" || e.arm === null) continue;
        const turn = String(e.event);
        const s = side(
            e.arm,
            flaggedTurn(r.run, r.sessions, e.arm, sessionOf.get(turn) ?? null, turn),
        );
        s.turns++;
        if (typeof e.prompt_ms === "number") s.prompt_ms.push(e.prompt_ms);
    }
    for (const c of r.run.calls) {
        if (c.component !== "agent" || c.turn === null) continue;
        const s = side(c.arm, flaggedTurn(r.run, r.sessions, c.arm, c.session, c.turn));
        s.agent_calls++;
        s.prompt_tokens += c.input_tokens + c.cache_read_tokens + c.cache_write_tokens;
        s.output_tokens += c.output_tokens;
    }
    for (const p of r.probes) {
        if (p.verdict === "excluded" || p.event === null) continue;
        const s = side(p.arm, flaggedTurn(r.run, r.sessions, p.arm, p.session, p.event));
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
            const pointers = p.stages
                .filter((s) => s.stage === p.attributed.cause)
                .flatMap((s) => s.pointers)
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
            "peak prompt",
            "limit",
            "over window",
            "too long",
            "cause",
            "flagged from",
        ]),
        row(["---", "---", "---", "---", "---", "---", "---", "---", "---", "---", "---"]),
    );
    let any = false;
    for (const r of runs) {
        for (const s of r.sessions) {
            if (!s.cause && s.compaction_refused === 0 && s.over_window_calls === 0) continue;
            any = true;
            out.push(
                row([
                    r.name,
                    s.arm,
                    s.session,
                    s.compaction_attempts,
                    s.compaction_refused,
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
    if (!any) out.push(row(["none", "", "", "", "", "", "", "", "", "", ""]));
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
