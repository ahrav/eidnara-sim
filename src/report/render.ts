import type { GradeRecord } from "../grade/probes";
import type { OracleCount } from "../oracle/oracles";
import type { Recovery } from "../oracle/recovery";
import type { Preregistration } from "../prereg/schema";
import type { TierVerdict, ZeroEffect } from "../stats/gate";
import { type CostPanel, PRICE_TABLE, V1_PRICE } from "./cost";
import type { Intrusiveness } from "./intrusive";
import type { SoakVerdict } from "./soak";

export interface TierReport {
    tier: string;
    treatment: string;
    falsification_pair: [string, string];
    observed: Record<string, number[]>;
    runs: string[];
    arms: string[];
    grades: GradeRecord[];
    verdict: TierVerdict;
    oracles: Record<string, OracleCount>;
    recoveries: (Recovery & { run: string })[];
    soak: SoakVerdict[];
    intrusiveness: Intrusiveness[];
    cost: CostPanel[];
    falsification: ZeroEffect[];
    aa: unknown[];
    prereg: Preregistration;
    claim_boundary: string;
}

const fmt = (x: number | null | undefined, digits = 2) =>
    x === null || x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(digits);
const mb = (x: number | null | undefined) =>
    fmt(x === null || x === undefined ? x : x / 2 ** 20, 1);
const table = (head: string[], rows: (string | number)[][]) => [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
];

function accuracy(r: TierReport): string[] {
    const types = [...new Set(r.grades.map((g) => g.probe_type))].sort();
    const cell = (arm: string, type: string) => {
        const mine = r.grades.filter(
            (g) => g.arm === arm && (type === "ALL" || g.probe_type === type),
        );
        const n = (v: string) => mine.filter((g) => g.verdict === v).length;
        return `${n("pass")}/${mine.length} (f${n("fail")} e${n("excluded")})`;
    };
    return [
        "## Accuracy by probe type (pass/total; f=fail e=excluded)",
        "",
        ...table(
            ["probe type", ...r.arms],
            [...types, "ALL"].map((t) => [t, ...r.arms.map((a) => cell(a, t))]),
        ),
    ];
}

function gates(r: TierReport): string[] {
    const v = r.verdict;
    const rows = v.families.flatMap((f) =>
        f.metrics.map((m) => [
            f.family,
            f.claim,
            m.metric,
            m.n,
            f.direction === "threshold" || f.direction === "zero-tolerance"
                ? `observed ${(r.observed[m.metric] ?? []).map((x) => fmt(x)).join(" ") || "-"}`
                : fmt(m.difference),
            m.interval ? `[${fmt(m.interval[0])}, ${fmt(m.interval[1])}]` : "-",
            fmt(m.p_adjusted ?? m.p, 4),
            fmt(m.detectable),
            fmt(m.resolution_ratio),
            m.verdict,
            m.passed === null ? "-" : m.passed ? "pass" : "fail",
        ]),
    );
    return [
        "## Gate verdict",
        "",
        `Tier ${r.tier}, ${r.treatment} against host: **${v.pass.passed ? "passes" : "does not pass"}**. ${v.pass.rule}.`,
        r.arms.includes(r.treatment)
            ? ""
            : `These runs hold no ${r.treatment} arm, so every paired metric is inconclusive.`,
        `Components and alpha: ${
            Object.entries(v.pass.per_component_alpha)
                .map(([k, a]) => `${k} ${a}`)
                .join(", ") || "none"
        }.`,
        `Pre-registration ${v.prereg_sha256}. Excluded per arm: ${JSON.stringify(v.excluded_per_arm)}. Fault-asymmetric stratum: ${v.asymmetric_stratum.length} pairs.`,
        `CUSUM stops: ${v.stops.map((s) => `${s.kind} on ${s.metric} at ${s.signal_index} (${s.window.join(" ")})`).join("; ") || "none"}${v.cusum_unavailable.length ? `; unavailable: ${v.cusum_unavailable.join("; ")}` : ""}.`,
        "",
        ...table(
            [
                "family",
                "claim",
                "metric",
                "n",
                "diff",
                "interval",
                "p",
                "detectable",
                "resolution",
                "verdict",
                "gate",
            ],
            rows,
        ),
        "### Harm",
        "",
        v.memory_made_it_worse.length === 0
            ? "No harm metric is worse."
            : `Memory made it worse on ${v.memory_made_it_worse.map((w) => `${w.metric} ${w.interval ? `[${fmt(w.interval[0])}, ${fmt(w.interval[1])}]` : ""}`).join(", ")}.`,
        "",
    ];
}

function panels(r: TierReport): string[] {
    const oracleRows = Object.entries(r.oracles).map(([id, o]) => [
        id,
        o.activations,
        o.uncovered ? "uncovered" : "",
        JSON.stringify(o.by_arm),
        JSON.stringify(o.by_component),
    ]);
    return [
        "## Failure-class oracles",
        "",
        ...table(["oracle", "activations", "", "by arm", "by component"], oracleRows),
        `Uncovered: ${
            Object.entries(r.oracles)
                .filter(([, o]) => o.uncovered)
                .map(([id]) => id)
                .join(", ") || "none"
        }.`,
        "",
        "## Recovery after infrastructure faults",
        "",
        ...table(
            ["run", "arm", "fault", "type", "turns to clean", "recovered", "reasons"],
            r.recoveries.map((x) => [
                x.run,
                x.arm,
                x.fault,
                x.type,
                x.turns_to_first_clean ?? "-",
                String(x.recovered),
                x.reasons.join("; "),
            ]),
        ),
        "## Soak",
        "",
        ...table(
            [
                "arm",
                "resource",
                "verdict",
                "samples",
                "sessions",
                "baseline MB",
                "slope MB/session",
                "R2",
                "bound",
                "returned",
                "max gap s",
            ],
            r.soak.map((s) => [
                s.arm,
                s.resource,
                s.verdict,
                s.samples,
                s.sessions,
                mb(s.baseline),
                mb(s.slope_per_session),
                fmt(s.r2),
                s.bound.holds ? "holds" : `broken at ${s.bound.worst?.sessions} sessions`,
                String(s.returned_to_baseline),
                fmt(s.max_gap_ms === null ? null : s.max_gap_ms / 1000, 0),
            ]),
        ),
        "## Intrusiveness",
        "",
        ...table(
            [
                "arm",
                "internal-string hits",
                "corrections citing injected text",
                "reverted edits",
                "turn p50 ms",
                "turn p95 ms",
                "p50 delta ms",
                "p95 delta ms",
            ],
            r.intrusiveness.map((i) => {
                const host = r.intrusiveness.find((x) => x.arm === "host")?.latency_ms;
                const delta = (a: number | null, b: number | null | undefined) =>
                    a === null || b === null || b === undefined ? null : a - b;
                return [
                    i.arm,
                    i.internal_string_hits.length,
                    i.corrections_referencing_injected_text.length,
                    i.reverted_edits.length,
                    fmt(i.latency_ms.p50, 0),
                    fmt(i.latency_ms.p95, 0),
                    fmt(delta(i.latency_ms.p50, host?.p50), 0),
                    fmt(delta(i.latency_ms.p95, host?.p95), 0),
                ];
            }),
        ),
        `## Cost (est $ at price table ${PRICE_TABLE}: USD ${V1_PRICE.input}, ${V1_PRICE.output}, ${V1_PRICE.cache_read}, ${V1_PRICE.cache_write} per million input, output, cache-read, cache-write tokens; arm totals leave out harness calls)`,
        "",
        ...table(
            ["arm", "caller", "calls", "input", "output", "cacheRead", "cacheWrite", "est $"],
            r.cost.flatMap((c) => [
                ...c.components.map((x) => [
                    c.arm,
                    x.component,
                    x.calls,
                    x.input,
                    x.output,
                    x.cache_read,
                    x.cache_write,
                    fmt(x.usd),
                ]),
                [c.arm, "TOTAL", "", "", "", "", "", fmt(c.usd)],
            ]),
        ),
        ...table(
            ["arm", "useful passes", "$ per pass", "memory writes", "writes with zero reads"],
            r.cost.map((c) => [
                c.arm,
                c.passes,
                fmt(c.usd_per_pass),
                c.memory_writes ?? "-",
                c.writes_with_zero_reads ?? "-",
            ]),
        ),
        "## Harness falsification set",
        "",
        `Pair: ${r.falsification_pair.join(" against ")}. On an A/B pair the daemon arm's background work holds the clock, so the idle-gap check measures it; the set is a zero-effect check on an A/A pair.`,
        "",
        ...table(
            ["check", "n", "diff", "interval", "zero effect"],
            r.falsification.map((z) => [
                z.check,
                z.n,
                fmt(z.difference, 4),
                z.interval ? `[${fmt(z.interval[0], 4)}, ${fmt(z.interval[1], 4)}]` : "-",
                z.zero_effect === null ? "-" : String(z.zero_effect),
            ]),
        ),
        "## A/A controls",
        "",
        r.aa.length === 0
            ? r.arms.some((a) => a.includes("~"))
                ? "A/A control arms ran; run scripts/aa-report.ts on the graded run for their report."
                : "No A/A control in these runs."
            : `\`\`\`json\n${JSON.stringify(r.aa, null, 2)}\n\`\`\``,
        "",
    ];
}

export function renderTier(r: TierReport): string {
    const lines = [
        `# Tier ${r.tier} report`,
        "",
        `Runs: ${r.runs.join(", ")}. Arms: ${r.arms.join(", ")}.`,
        "",
        ...accuracy(r),
        ...gates(r),
        ...panels(r),
        "## Claim boundary",
        "",
        r.claim_boundary.trim(),
        "",
        "## Pre-registration",
        "",
        "```json",
        JSON.stringify(r.prereg, null, 2),
        "```",
        "",
    ];
    const text = lines.join("\n");
    const own = text
        .replace(r.claim_boundary.trim(), "")
        .replace(JSON.stringify(r.prereg, null, 2), "");
    if (/parity/i.test(own)) throw new Error("a report may not use the word parity");
    return text;
}
