import { canonicalJson } from "../prereg/canonical";
import type { Rng } from "../rng";

export type Trigger =
    | { kind: "session_start"; session: string }
    | { kind: "user_turn"; session: string; n: number }
    | { kind: "first_summarizer_call"; session: string };

export interface Seam {
    layer: "proxy-sink" | "scheduler" | "clock";
    legal_outcomes: string[];
    in_flight_fate: string;
    surviving_state: string;
    oracle: string;
}

export interface FaultEpisode {
    id: string;
    type: FaultType;
    strategy: "single" | "burst" | "intermittent" | "persistent";
    trigger: Trigger;
    params: Record<string, number>;
    seam: Seam;
}

const PROVIDER: Seam = {
    layer: "proxy-sink",
    legal_outcomes: [
        "host retries and the turn completes",
        "turn ends failed with the error surfaced",
    ],
    in_flight_fate:
        "the faulted response replaces the provider response after the proxy's own retry",
    surviving_state: "host session and daemon store unchanged by the fault",
    oracle: "call record with fault_ref observed by the host component (SIM-P31)",
};

const scheduler = (in_flight: string, surviving: string, oracle: string): Seam => ({
    layer: "scheduler",
    legal_outcomes: ["named owner restores service and later turns complete", "turn ends failed"],
    in_flight_fate: in_flight,
    surviving_state: surviving,
    oracle,
});

const BETWEEN = "none: fires between sessions";

export const SEAMS = {
    provider_429: PROVIDER,
    provider_5xx: PROVIDER,
    provider_timeout: PROVIDER,
    truncated_length: PROVIDER,
    truncated_no_length: PROVIDER,
    empty_content: PROVIDER,
    schema_wrong_tool_call: PROVIDER,
    slow_stream: PROVIDER,
    daemon_sigkill_mid_fold: scheduler(
        "the fold in progress is lost and retried after restart",
        "store passes its integrity check; fold boundary obeys the post-crash rule",
        "daemon exit by SIGKILL during an observed summarizer call, then restart (SIM-P47)",
    ),
    daemon_restart: scheduler(BETWEEN, "store reopened", "daemon pid change"),
    store_full: scheduler(
        "writes fail with ENOSPC",
        "store readable; host fails open",
        "daemon error log ENOSPC and fail-open publication",
    ),
    plugin_reload: scheduler(BETWEEN, "plugin re-registers", "plugin start record"),
    model_switch: scheduler(BETWEEN, "host uses the new model", "call record model id"),
    laptop_sleep: {
        layer: "clock",
        legal_outcomes: ["one event-free clock jump of the scheduled duration (SIM-P18)"],
        in_flight_fate: "none: fires while idle",
        surviving_state: "all processes kept",
        oracle: "AdvanceClock entry with busy_set empty",
    },
    host_upgrade: scheduler(BETWEEN, "host restarted on the new version", "host version record"),
    two_hosts_one_daemon: scheduler(
        "both hosts share one daemon for the session",
        "store consistent for both clients",
        "two client registrations on one daemon (SIM-P77)",
    ),
} satisfies Record<string, Seam>;
export type FaultType = keyof typeof SEAMS;

const PROVIDER_FAULTS: FaultType[] = [
    "provider_429",
    "provider_5xx",
    "provider_timeout",
    "truncated_length",
    "truncated_no_length",
    "empty_content",
    "schema_wrong_tool_call",
    "slow_stream",
];
export const INFRA_FAULTS: FaultType[] = [
    "daemon_sigkill_mid_fold",
    "daemon_restart",
    "store_full",
    "plugin_reload",
    "model_switch",
    "laptop_sleep",
];

const TIER_FAULTS: Record<string, FaultType[]> = {
    S: ["provider_429"],
    M: PROVIDER_FAULTS,
    L: [...PROVIDER_FAULTS, ...INFRA_FAULTS],
    XL: [...PROVIDER_FAULTS, ...INFRA_FAULTS, "host_upgrade", "two_hosts_one_daemon"],
};

const COMPILER_EVENTS = new Set(["session_start", "user_turn", "first_summarizer_call"]);

export function validateFault(episode: FaultEpisode, sessions: Map<string, number>): void {
    const trigger = episode.trigger as { kind: string; session?: string; n?: number };
    if (!COMPILER_EVENTS.has(trigger.kind)) {
        throw new Error(`${episode.id}: trigger ${trigger.kind} is not a compiler-owned event`);
    }
    const requests = sessions.get(trigger.session ?? "");
    if (requests === undefined)
        throw new Error(`${episode.id}: unknown session ${trigger.session}`);
    const n = trigger.n ?? 0;
    if (trigger.kind === "user_turn" && !(Number.isInteger(n) && n >= 1 && n <= requests)) {
        throw new Error(`${episode.id}: user turn ${n} outside the session's ${requests} turns`);
    }
    const seam = Object.hasOwn(SEAMS, episode.type) ? SEAMS[episode.type] : undefined;
    if (!seam || canonicalJson(seam) !== canonicalJson(episode.seam)) {
        throw new Error(`${episode.id}: seam entry missing or altered`);
    }
}

export interface FaultSession {
    id: string;
    requests: number;
    forced_p90: boolean;
    has_diff: boolean;
    gap_before_ms: number;
}

export function scheduleFaults(tier: string, sessions: FaultSession[], rng: Rng): FaultEpisode[] {
    const types = TIER_FAULTS[tier] ?? [];
    const providerSessions = sessions.filter((x) => x.requests >= 2);
    const providerCount = types.filter((t) => SEAMS[t].layer === "proxy-sink").length;
    if (providerSessions.length < providerCount) {
        throw new Error(
            `tier ${tier}: ${providerCount} provider faults need ${providerCount} sessions with two or more turns; ${providerSessions.length} available`,
        );
    }
    for (let i = providerSessions.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        [providerSessions[i], providerSessions[j]] = [
            providerSessions[j] as FaultSession,
            providerSessions[i] as FaultSession,
        ];
    }
    const later = sessions.slice(1);
    const pick = (candidates: FaultSession[], what: string): FaultSession => {
        if (candidates.length === 0) throw new Error(`tier ${tier}: no ${what}`);
        return rng.pick(candidates);
    };
    const quiet = later.filter((x) => !x.has_diff);
    const widest = quiet.reduce<FaultSession | undefined>(
        (a, b) => (a && a.gap_before_ms >= b.gap_before_ms ? a : b),
        undefined,
    );
    return types.map((type, i): FaultEpisode => {
        const id = `fault-${String(i).padStart(3, "0")}`;
        const seam = SEAMS[type];
        if (type === "daemon_sigkill_mid_fold") {
            const s = pick(
                sessions.filter((x) => x.forced_p90),
                "forced p90 session",
            );
            const trigger = { kind: "first_summarizer_call", session: s.id } as const;
            return { id, type, strategy: "single", trigger, params: {}, seam };
        }
        if (type === "laptop_sleep") {
            if (!widest)
                throw new Error(`tier ${tier}: no session starts without a hand-applied diff`);
            const trigger = { kind: "session_start", session: widest.id } as const;
            return {
                id,
                type,
                strategy: "single",
                trigger,
                params: { duration_ms: widest.gap_before_ms },
                seam,
            };
        }
        if (seam.layer !== "proxy-sink") {
            const s = pick(later, "session after the first");
            const trigger = { kind: "session_start", session: s.id } as const;
            const store = type === "store_full";
            const params: Record<string, number> = store ? { sessions: 1 } : {};
            return { id, type, strategy: store ? "persistent" : "single", trigger, params, seam };
        }
        const s = providerSessions[i % providerSessions.length] as FaultSession;
        const trigger = {
            kind: "user_turn",
            session: s.id,
            n: 1 + Math.floor(rng.next() * s.requests),
        } as const;
        const strategy = rng.pick(["single", "burst", "intermittent", "persistent"] as const);
        const params: Record<string, number> = {
            single: { count: 1 },
            burst: { count: 3 },
            intermittent: { probability: 0.3, calls: 10 },
            persistent: {},
        }[strategy];
        return { id, type, strategy, trigger, params, seam };
    });
}
