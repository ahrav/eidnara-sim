import { sample } from "../corpus/cdf";
import { type Distributions, table } from "../corpus/distributions";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import type { Preregistration } from "../prereg/schema";
import { Rng } from "../rng";
import { scheduleFaults, validateFault } from "./faults";
import { bm25Ratio, cosine, type Embedder, round4 } from "./similarity";
import { Tokens } from "./tokens";

export const GENERATOR_VERSION = "sim-scenario/v6";

export const MANNER_WEIGHTS = {
    correction: 0.35,
    hand_applied_diff: 0.2,
    tool_error: 0.15,
    rejected_approach: 0.1,
    direct_statement: 0.1,
    stated_then_reversed: 0.1,
} as const;
export type Manner = keyof typeof MANNER_WEIGHTS;

export interface Template {
    id: string;
    statement?: string;
    /** A plan template's unit of work; the compiler composes plan statements from tasks. */
    task?: string;
    probe: string;
    out_probe?: string;
    update?: string;
    /** The conveyance of a later instance in the same project, with `{old_*}` naming the prior values. */
    revise?: string;
    variants?: Record<string, string>[];
    example?: { path: string; content: string };
    authority?: { path: string; content: string };
    form?: "tool_result" | "pasted";
    script?: { path: string; content: string };
    command?: string;
    paste?: string;
    check: Record<string, unknown>;
    out_check?: Record<string, unknown>;
    /** The constructs the template's tasks presuppose in each pinned repository of its language. */
    requires?: { path: string; pattern: string }[];
}
export type Bank = Record<string, Record<string, Template[] | string[]>>;

export interface Project {
    id: string;
    lang: "rust" | "typescript";
    twin_of: string | null;
}

export interface CompileInput {
    seed: number;
    prereg: Preregistration;
    dist: Distributions;
    bank: Bank;
    projects: Project[];
    pastes: { id: string; content: string }[];
    corpusInputsSha256: string;
    embedder: Embedder;
    items?: number;
    /** The qualification registration a campaign compiles under, with the controls it adds. */
    qualification?: { sha256: string; controls: readonly string[] };
}

interface Session {
    id: string;
    project: string;
    forced_p90: boolean;
    start_ms: number;
    turn_ms: number[];
    min_gap_ms: number;
}

interface Turn {
    session: string;
    index: number;
    role: "filler" | "paste" | "conveyance" | "update" | "reversal" | "probe" | "status";
    text: string;
    fact?: string;
    /** Every fact whose commit this opening turn points at. */
    facts?: string[];
    probe?: string;
    paste?: { sample_id: string; bytes: number };
}

/** One commit of an `apply_diff` event: a whole-file write, or the removal of the path. */
interface Diff {
    session: string;
    path: string;
    content?: string;
    remove?: true;
    fact: string;
}
interface Commits {
    adds: { path: string; content: string }[];
    removed: string[];
}

/**
 * Where a fact's ground truth comes from: a user instruction, a convention the agent infers from
 * a repository example, an incidental mention that must not be applied, or an observation (tool
 * output or an authoritative file).
 */
export type Basis = "instruction" | "convention" | "incidental" | "observation";
export type Expect = "apply" | "avoid" | "answer" | "abstain" | "explain" | "resume" | "clarify";

export interface Fact {
    id: string;
    template: string;
    kind: string;
    project: string;
    manner: Manner;
    basis: Basis;
    /** `<project>/<template>`, or `<project>/plan` for P6; later instances of a line supersede earlier ones. */
    line: string;
    revision: number;
    supersedes: string | null;
    statement: string;
    cues: string[];
    form?: "tool_result" | "pasted";
}

/**
 * A probe's expected behaviour and its evidence. `present` lists, per rule pattern, the generated
 * literals of which correct work carries at least one, `absent` those it must not carry, and `stale` the superseded literals; `sources`
 * names every event that exposes the fact, each before the probe.
 */
export interface GroundTruth {
    expect: Expect;
    basis: Basis;
    present: string[][];
    absent: string[];
    stale: string[];
    supersedes: string[];
    sources: string[];
}
type TruthOf = Pick<GroundTruth, "expect" | "present" | "absent" | "stale">;
/** `words` are literals a variant binds, common words the tree and ordering checks leave out. */
type Truth = Omit<GroundTruth, "sources"> & { fact: string; words: string[] };

export interface ProbeItem {
    id: string;
    type: string;
    fact: string | null;
    project: string;
    session: string;
    text: string | null;
    check: unknown;
    event?: string;
    ground_truth?: GroundTruth;
}

export type PlanStatus = "accepted" | "revised" | "completed";
/** One P6 plan: each status change, the event that made it, and the next actions it leaves open. */
export interface PlanRecord {
    fact: string;
    project: string;
    expect: "resume" | "clarify";
    history: { event: string; status: PlanStatus; next: string[] }[];
}

interface Line {
    facts: Fact[];
    vars: Record<string, string>[];
    base: Record<string, unknown>[];
    inherited: Record<string, unknown>;
    outBase: Record<string, unknown>[];
    outInherited: Record<string, unknown>;
    /** Files the line has committed that the scenario-defined tree still holds. */
    artifacts: Map<string, string>;
    literals: string[];
    /** Per instance, the generated literals its check requires. */
    required: string[][];
    words: string[];
}

/** Placeholders the compiler fills with generated values; every other one is template text. */
const GENERATED = ["token", "TOKEN", "alt", "ALT", "Alt", "value", "value2", "codename"];
const NEGATIVE = (k: string) => k.endsWith("must_not");
const IGNORED = new Set(["scope", "side", "turns", "applies"]);

const pascal = (word: string) =>
    word
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join("");

/**
 * The placeholder names of a check's positive (or negative) grading keys, one group per pattern:
 * a pattern holds when any one of its group's values occurs, so the group lists alternatives.
 */
export function placeholderGroups(check: unknown, positive: boolean): string[][] {
    if (!check || typeof check !== "object") return [];
    const out: string[][] = [];
    for (const [k, v] of Object.entries(check)) {
        if (IGNORED.has(k) || NEGATIVE(k) === positive) continue;
        for (const text of [v].flat()) {
            if (typeof text !== "string") continue;
            const names = [...text.matchAll(/\{(\w+)\}/g)].flatMap(([, n]) => (n ? [n] : []));
            if (names.length > 0) out.push([...new Set(names)]);
        }
    }
    return out;
}

const MARKERS = [
    /\bprobes?\b/gi,
    /\bP(?:1[0-4]|[1-9])\b/g,
    /\b(?:grad(?:e|ed|er|ing)|rubric|scor(?:e|ed|ing)|evaluat\w*|recall)\b/gi,
];

export function markerHits(text: string, keys: readonly string[]): string[] {
    const hits = MARKERS.flatMap((re) => text.match(re) ?? []);
    return [...hits, ...keys.filter((k) => text.includes(k))];
}

export function streams(seed: number) {
    return (domain: string) => {
        let h = 0x811c9dc5;
        for (const c of domain) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
        return new Rng((seed ^ h) >>> 0);
    };
}

export function shuffle<T>(items: T[], rng: Rng): T[] {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        [items[i], items[j]] = [items[j] as T, items[i] as T];
    }
    return items;
}

function render(template: string, vars: Record<string, string>): string {
    return template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

function renderDeep<T>(value: T, vars: Record<string, string>): T {
    if (typeof value === "string") return render(value, vars) as T;
    if (Array.isArray(value)) return value.map((v) => renderDeep(v, vars)) as T;
    if (value && typeof value === "object") {
        const entries = Object.entries(value).map(([k, v]) => [k, renderDeep(v, vars)]);
        return Object.fromEntries(entries) as T;
    }
    return value;
}

/** Largest-remainder rounding keeps each manner's count within one of its weight times `total`. */
export function mannerQuota(total: number): Manner[] {
    const entries = Object.entries(MANNER_WEIGHTS) as [Manner, number][];
    const counts = new Map(entries.map(([m, w]) => [m, Math.floor(w * total)]));
    let left = total - [...counts.values()].reduce((a, b) => a + b, 0);
    const byRemainder = [...entries].sort(
        ([, a], [, b]) => b * total - Math.floor(b * total) - (a * total - Math.floor(a * total)),
    );
    for (const [m] of byRemainder) if (left-- > 0) counts.set(m, (counts.get(m) ?? 0) + 1);
    return entries.flatMap(([m]) => Array<Manner>(counts.get(m) ?? 0).fill(m));
}

const FACT_SPECS: { type: string; kind: string; fixed?: Manner; inSession?: boolean }[] = [
    { type: "P13", kind: "session_rule", inSession: true },
    { type: "P6", kind: "plan" },
    { type: "P1", kind: "constraint" },
    { type: "P3", kind: "decision" },
    { type: "P4", kind: "scoped_update" },
    { type: "P5", kind: "rejected", fixed: "rejected_approach" },
    { type: "P7", kind: "rationale" },
    { type: "P8", kind: "lookup", fixed: "direct_statement" },
    { type: "P9", kind: "never_settled" },
    { type: "P10", kind: "anchor" },
    { type: "P12", kind: "tool_error", fixed: "tool_error" },
];

const HOUR = 3_600_000;
const P13_SPAN = 30;
const MANNER_KINDS: Partial<Record<Manner, string[]>> = {
    rejected_approach: ["rejected"],
    tool_error: ["constraint", "decision", "tool_error"],
};
const pad = (prefix: string, n: number, width = 4) => `${prefix}-${String(n).padStart(width, "0")}`;
const lastTurn = (x: Session) => x.turn_ms[x.turn_ms.length - 1] ?? 0;
const range = (lo: number, hi: number) =>
    Array.from({ length: Math.max(0, hi - lo) }, (_, i) => lo + i);

export async function compileScenario(input: CompileInput) {
    const { seed, prereg, dist, bank } = input;
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
        throw new Error(`seed ${seed} is outside the unsigned 32-bit range of the random streams`);
    }
    const s = prereg.scenario;
    const thresholds = s.cue_probe_similarity;
    if (input.embedder.model !== thresholds.embedding_model) {
        throw new Error(
            `embedder ${input.embedder.model} differs from the pre-registered ${thresholds.embedding_model}`,
        );
    }
    const rngFor = streams(seed);
    const tokens = new Tokens(rngFor("tokens"));
    const place = rngFor("placement");

    const sessRng = rngFor("sessions");
    const count = (p: Project) =>
        p.twin_of ? Math.ceil(s.sessions_per_project / 4) : s.sessions_per_project;
    const bases = input.projects.filter((p) => !p.twin_of);
    const plan = shuffle(
        input.projects.flatMap((p) => Array<Project>(count(p)).fill(p)),
        sessRng,
    );
    const extra = new Set(
        shuffle([...bases], sessRng)
            .slice(0, s.forced_p90_sessions % bases.length)
            .map((p) => p.id),
    );
    const forced = new Set(
        bases.flatMap((p) => {
            const own = plan.flatMap((q, i) => (q.id === p.id ? [i] : []));
            const quota =
                Math.floor(s.forced_p90_sessions / bases.length) + (extra.has(p.id) ? 1 : 0);
            if (quota > own.length) {
                throw new Error(
                    `forced_p90_sessions ${s.forced_p90_sessions} exceeds the ${own.length} sessions of ${p.id}`,
                );
            }
            return range(0, quota).map((k) => own[Math.floor(((k + 0.5) * own.length) / quota)]);
        }),
    );
    const [reqTable, idleTable, betweenTable] = [
        table(dist, "requests_per_session"),
        table(dist, "idle_within_session_s"),
        table(dist, "idle_between_sessions_s"),
    ];
    const sessions: Session[] = plan.map((project, i) => {
        const requests = Math.max(1, sample(reqTable, sessRng, forced.has(i) ? 0.9 : 0));
        const turn_ms = [0];
        for (let k = 1; k < requests; k++) {
            turn_ms.push((turn_ms[k - 1] ?? 0) + Math.round(sample(idleTable, sessRng) * 1000));
        }
        return {
            id: pad("s", i),
            project: project.id,
            forced_p90: forced.has(i),
            start_ms: 0,
            turn_ms,
            min_gap_ms: 1,
        };
    });
    const between = sessions.slice(1).map(() => sample(betweenTable, sessRng) * 1000);
    const inSession = () => sessions.reduce((sum, x) => sum + lastTurn(x), 0);
    const betweenSum = Math.max(
        1,
        between.reduce((a, b) => a + b, 0),
    );
    const span = s.simulated_days * 86_400_000;
    const withinScale = Math.min(1, (0.8 * span) / Math.max(1, inSession()));
    for (const x of sessions) x.turn_ms = x.turn_ms.map((t) => Math.round(t * withinScale));

    const perType = Math.ceil(
        (input.items ?? prereg.stopping_rule.paired_items_per_probe_type) /
            (prereg.seeds.length * prereg.hosts.length),
    );
    const p90 = sessions.filter((x) => x.forced_p90);
    for (const x of p90) {
        while (x.turn_ms.length < P13_SPAN * Math.ceil(perType / p90.length))
            x.turn_ms.push(lastTurn(x) + 60_000);
    }
    const gapScale = Math.max(0, span - inSession()) / betweenSum;
    const gaps = between.map((g) => Math.max(1, Math.round(g * gapScale)));
    const schedule = () => {
        let clock = 0;
        sessions.forEach((x, i) => {
            if (i > 0) clock += Math.max(gaps[i - 1] ?? 1, x.min_gap_ms);
            x.start_ms = clock;
            clock += lastTurn(x);
        });
    };
    schedule();

    const turns = new Map<string, Turn>();
    const key = (session: string, index: number) => `${session}#${index}`;
    /**
     * Sessions that end at a plan's latest conveyance, with its index: the conveyance stays the
     * session's last request, so the project's next session opens with the P6 probe.
     */
    const sealed = new Map<string, number>();
    const byProject = (project: string) => sessions.filter((x) => x.project === project);
    const sessionOf = (id: string) => sessions.find((x) => x.id === id) as Session;
    const all = (x: Session) => range(0, x.turn_ms.length);
    const take = (
        candidates: Session[],
        where: (x: Session) => number[],
        turn: Omit<Turn, "session" | "index">,
    ): Turn => {
        if (candidates.length === 0)
            throw new Error(`no session can hold a ${turn.role} turn for ${turn.fact}`);
        const free = candidates.flatMap((x) =>
            where(x)
                .filter((i) => !turns.has(key(x.id, i)))
                .map((i) => [x, i] as const),
        );
        // A session's first turn stays free for a commit's cue; a turn that finds no later slot
        // extends its session instead. In a session a plan's conveyance ends, the new slot goes
        // just before that conveyance, which moves to the session's new last slot.
        const open = free.filter(([, i]) => i > 0);
        const [session, slot] =
            open.length > 0 ? place.pick(open) : [candidates[candidates.length - 1] as Session, -1];
        let index = slot;
        if (index < 0) {
            index = session.turn_ms.length;
            session.turn_ms.push(lastTurn(session) + 60_000);
            const final = sealed.get(session.id);
            if (final !== undefined) {
                const conveyance = turns.get(key(session.id, final)) as Turn;
                turns.delete(key(session.id, final));
                conveyance.index = index;
                turns.set(key(session.id, index), conveyance);
                sealed.set(session.id, index);
                index = final;
            }
        }
        const t = { ...turn, session: session.id, index };
        turns.set(key(session.id, index), t);
        return t;
    };

    const twinOf = (p: string) => input.projects.find((x) => x.twin_of === p)?.id ?? p;
    const controls = new Set(input.qualification?.controls ?? []);
    const facts: Fact[] = [];
    const probes: ProbeItem[] = [];
    const plans: PlanRecord[] = [];
    const keys: string[] = [];
    const diffs: Diff[] = [];
    const framings = (bank.any?.framings ?? []) as string[];
    const exposure = new Map<string, { turns: Turn[]; diffs: Diff[] }>();
    const truths = new Map<string, Truth>();
    const planTurns = new Map<string, { turn: Turn; status: PlanStatus; next: string[] }[]>();
    /** A commit lands before a session, and its cue occupies that session's first turn. */
    const openings = new Map<string, "commits" | "probe">();
    const lines = new Map<string, Line>();
    const probeTexts = new Map<string, string[]>();
    const segments = new Map<Turn, string[]>();
    /**
     * The first turn of a session for `turn`. A probe takes a session opening of its own; a
     * commit's cue joins any other commit cues of that session's opening, so every commit lands
     * immediately before the turn that points at it.
     */
    const takeOpening = (
        candidates: Session[],
        turn: Omit<Turn, "session" | "index">,
        owner: "commits" | "probe",
        wider: Session[] = [],
    ): Turn => {
        const usable = (xs: Session[]) => {
            const free = xs.filter((x) => !turns.has(key(x.id, 0)) && !openings.has(x.id));
            const shared =
                owner === "commits" ? xs.filter((x) => openings.get(x.id) === "commits") : [];
            return free.length > 0 ? free : shared;
        };
        const near = usable(candidates);
        const open = near.length > 0 ? near : usable(wider);
        if (open.length === 0) {
            throw new Error(
                `no session opening is free for the ${turn.role} of ${turn.fact}: a commit lands only before a session, and its cue takes that session's first turn`,
            );
        }
        const session = place.pick(open);
        const existing = turns.get(key(session.id, 0));
        if (existing && openings.get(session.id) === "commits") {
            const parts = segments.get(existing) ?? [existing.text];
            if (!parts.includes(turn.text)) parts.push(turn.text);
            segments.set(existing, parts);
            existing.text = parts.join("\n\n");
            existing.facts = [...new Set([...(existing.facts ?? []), turn.fact as string])];
            return existing;
        }
        openings.set(session.id, owner);
        const t: Turn = {
            ...turn,
            session: session.id,
            index: 0,
            ...(owner === "commits" ? { facts: [turn.fact as string] } : {}),
        };
        turns.set(key(session.id, 0), t);
        return t;
    };
    const expose = (fact: string, t?: Turn, d?: Diff) => {
        const e = exposure.get(fact) ?? { turns: [], diffs: [] };
        if (t) e.turns.push(t);
        if (d) e.diffs.push(d);
        exposure.set(fact, e);
    };
    const distinct = (project: string, fact: string, text: string): string => {
        const k = `${project}\n${text}`;
        const users = probeTexts.get(k) ?? [];
        if (!users.includes(fact)) users.push(fact);
        probeTexts.set(k, users);
        const n = users.indexOf(fact);
        if (n === 0) return text;
        const framing = framings[n - 1];
        if (framing === undefined) {
            throw new Error(
                `${project}: probe text "${text}" repeats for ${users.length} facts and the bank holds ${framings.length} framings`,
            );
        }
        return `${framing} ${text}`;
    };

    const sessionIndex = new Map(sessions.map((x, i) => [x.id, i]));
    /** The project's next session after `x`, when its opening is free for a P6 probe. */
    const resumeTarget = (x: Session, eligible: Session[]): Session | null => {
        const next = sessions
            .slice((sessionIndex.get(x.id) ?? 0) + 1)
            .find((y) => y.project === x.project);
        return next &&
            eligible.includes(next) &&
            !turns.has(key(next.id, 0)) &&
            !openings.has(next.id) &&
            !sealed.has(next.id)
            ? next
            : null;
    };
    /**
     * Places a plan's latest conveyance in the last slot of a session, extending the session when
     * that slot is taken or precedes `after`, and seals the session, so the P6 probe that opens
     * the project's next session follows it with no request of the project between.
     */
    const takeFinal = (
        pools: Session[][],
        turn: Omit<Turn, "session" | "index">,
        eligible: Session[],
        after?: Turn,
    ): Turn => {
        const usable = (x: Session) =>
            !x.forced_p90 &&
            !sealed.has(x.id) &&
            resumeTarget(x, eligible) !== null &&
            (!after || (sessionIndex.get(x.id) ?? 0) >= (sessionIndex.get(after.session) ?? 0));
        const pool = pools.map((xs) => xs.filter(usable)).find((xs) => xs.length > 0);
        if (!pool) {
            throw new Error(
                `no session can end at the plan conveyance of ${turn.fact} with its project's next session free for the probe`,
            );
        }
        const session = place.pick(pool);
        let index = session.turn_ms.length - 1;
        const taken = turns.has(key(session.id, index));
        if (index === 0 || taken || (after?.session === session.id && index <= after.index)) {
            index = session.turn_ms.length;
            session.turn_ms.push(lastTurn(session) + 60_000);
        }
        const t: Turn = { ...turn, session: session.id, index };
        turns.set(key(session.id, index), t);
        sealed.set(session.id, index);
        return t;
    };
    const hostOf = (i: number) => p90[i % p90.length] as Session;
    const allSpecs = FACT_SPECS.flatMap((spec) => range(0, perType).map((i) => ({ ...spec, i })));
    const factSpecs = [
        ...allSpecs
            .filter((f) => f.inSession)
            .sort(
                (a, b) =>
                    (sessionIndex.get(hostOf(a.i).id) ?? 0) -
                        (sessionIndex.get(hostOf(b.i).id) ?? 0) || a.i - b.i,
            ),
        ...allSpecs.filter((f) => !f.inSession),
    ];
    const pool = mannerQuota(factSpecs.length);
    for (const f of factSpecs) {
        if (!f.fixed) continue;
        const at = pool.indexOf(f.fixed);
        if (at < 0) throw new Error(`manner quota too small for ${f.type}`);
        pool.splice(at, 1);
    }
    shuffle(pool, rngFor("manners"));

    type Check = Record<string, unknown>;
    const lists = (c: Check, suffix: string) =>
        Object.entries(c).flatMap(([k, v]) =>
            k.endsWith(suffix) && Array.isArray(v) ? [[k, v as string[]] as const] : [],
        );
    const append = (a: Check, b: Check): Check => {
        const merged = { ...a };
        for (const [k, v] of lists(b, "must_not")) {
            if (v.length === 0) continue;
            const have = (merged[k] as string[] | undefined) ?? [];
            merged[k] = [...have, ...v.filter((p) => !have.includes(p))];
        }
        return merged;
    };
    const negate = (c: Check): Check =>
        Object.fromEntries(lists(c, "must").map(([k, v]) => [`${k}_not`, v]));
    /**
     * A later instance forbids its predecessor's requirements, the values it forbade apart from
     * those requirements, and everything earlier instances forbade.
     */
    const inherit = (
        base: Check,
        prev: Check | undefined,
        prevInherited: Check,
        prevRequired: string[] = [],
    ): Check => {
        if (!prev) return {};
        // A forbid naming the predecessor's own required value is that requirement's complement.
        const complement = (p: string) => prevRequired.some((lit) => p.includes(lit));
        const ownForbids = Object.fromEntries(
            lists(prev, "must_not").map(([k, v]) => [k, v.filter((p) => !complement(p))]),
        );
        const forbidden = append(append(negate(prev), ownForbids), prevInherited);
        const required = (k: string) =>
            (base[k.replace(/_not$/, "")] as string[] | undefined) ?? [];
        return Object.fromEntries(
            lists(forbidden, "must_not").map(([k, v]) => [
                k,
                v.filter((p) => !required(k).includes(p)),
            ]),
        );
    };

    for (const f of factSpecs) {
        const owners = f.inSession ? p90 : bases;
        const slot = Math.floor(f.i / owners.length);
        const host = f.inSession ? hostOf(f.i) : undefined;
        const project = (
            host ? input.projects.find((x) => x.id === host.project) : bases[f.i % bases.length]
        ) as Project;
        const lang = f.kind in (bank[project.lang] ?? {}) ? project.lang : "any";
        const templates = (bank[lang]?.[f.kind] ?? []) as Template[];
        if (templates.length === 0) throw new Error(`fact bank has no ${f.kind} templates`);
        const isPlan = f.kind === "plan";
        const tpl = templates[slot % templates.length] as Template;
        const lineKey = `${project.id}/${isPlan ? "plan" : tpl.id}`;
        const line: Line = lines.get(lineKey) ?? {
            facts: [],
            vars: [],
            base: [],
            inherited: {},
            outBase: [],
            outInherited: {},
            artifacts: new Map(),
            literals: [],
            required: [],
            words: [],
        };
        lines.set(lineKey, line);
        const revision = line.facts.length;
        if (revision > 0 && !isPlan && tpl.revise === undefined) {
            throw new Error(
                `template ${tpl.id} repeats in ${project.id} without a revise wording, so its later instance would be an unrelated duplicate`,
            );
        }
        const own = byProject(project.id);
        const perOwner = Math.ceil((perType - (f.i % owners.length)) / owners.length);
        const windows = f.inSession || isPlan ? perOwner : Math.ceil(perOwner / templates.length);
        const w = f.inSession || isPlan ? slot : Math.floor(slot / templates.length);
        const cut = (n: number, j: number) => Math.floor((j * n) / windows);
        const win = own.slice(cut(own.length, w), cut(own.length, w + 1));
        const winEnd = own[cut(own.length, w + 1)]?.start_ms ?? Number.POSITIVE_INFINITY;
        const inWindow = (p: string) =>
            byProject(p).filter(
                (x) => x.start_ms >= (win[0]?.start_ms ?? 0) && x.start_ms < winEnd,
            );
        const turnLo = host ? cut(host.turn_ms.length, w) : 0;
        const turnHi = host ? cut(host.turn_ms.length, w + 1) : 0;
        const third = Math.max(1, Math.floor((turnHi - turnLo) / 3));

        const word = tokens.word();
        const alt = tokens.word();
        const variant = tpl.variants?.[revision % tpl.variants.length] ?? {};
        const vars: Record<string, string> = {
            token: word,
            TOKEN: word.toUpperCase(),
            alt,
            ALT: alt.toUpperCase(),
            Alt: pascal(alt),
            value: tokens.number(),
            value2: tokens.number(),
            codename: tokens.codename(),
            ...variant,
        };
        const old = Object.fromEntries(
            Object.entries(line.vars[revision - 1] ?? {}).map(([k, v]) => [`old_${k}`, v]),
        );
        const withOld = { ...vars, ...old };
        const statementTemplate = (revision > 0 && tpl.revise) || tpl.statement || "";
        const reversible =
            !f.inSession && !isPlan && /\{(?:token|TOKEN|value|codename)\}/.test(statementTemplate);
        const planExpect: "resume" | "clarify" | undefined = isPlan
            ? (slot + (f.i % owners.length) + seed) % 3 === 2
                ? "clarify"
                : "resume"
            : undefined;
        const planRevised = planExpect === "resume" && slot % 2 === 1;
        const updated = Boolean(tpl.update) || planRevised;
        const allowed = (m: Manner) =>
            !((f.inSession || updated || isPlan) && m === "hand_applied_diff") &&
            (reversible || m !== "stated_then_reversed") &&
            (MANNER_KINDS[m]?.includes(f.kind) ?? true);
        const at = pool.findIndex(allowed);
        const manner: Manner =
            f.fixed ?? (at < 0 ? "correction" : (pool.splice(at, 1)[0] as Manner));
        const id = pad("f", facts.length);
        keys.push(id, tpl.id);

        const second = templates[(slot + 1) % templates.length] as Template;
        const tasks = [
            { tpl, vars },
            { tpl: second, vars: { ...vars, token: alt, TOKEN: vars.ALT as string } },
        ] as const;
        const taskText = (k: 0 | 1) => render(tasks[k].tpl.task ?? "", tasks[k].vars);
        const nextStep = (task: string) => `when we pick this back up, the next step is ${task}`;
        const statement = isPlan
            ? planExpect === "clarify"
                ? `two items are open for next time, ${taskText(0)} and ${taskText(1)}, and I have not decided which comes first`
                : nextStep(taskText(0))
            : render(statementTemplate, withOld);
        const basis: Basis =
            f.kind === "anchor"
                ? "incidental"
                : f.kind === "tool_error" || f.kind === "decision"
                  ? "observation"
                  : manner === "hand_applied_diff" && tpl.example
                    ? "convention"
                    : "instruction";
        const form = f.kind === "tool_error" ? tpl.form : undefined;
        const fact: Fact = {
            id,
            template: tpl.id,
            kind: f.kind,
            project: project.id,
            manner,
            basis,
            line: lineKey,
            revision,
            supersedes: line.facts[revision - 1]?.id ?? null,
            statement,
            cues: [],
            ...(form ? { form } : {}),
        };
        const targets = f.type === "P1" ? [project.id, twinOf(project.id)] : [project.id];
        const deadline = Math.min(...targets.map((t) => inWindow(t).at(-1)?.start_ms ?? 0));
        const open = win.slice(win.length > 2 ? 1 : 0).filter((x) => x.start_ms < deadline);
        const early = host ? [host] : open.slice(0, Math.max(1, Math.ceil(open.length * 0.6)));
        const where = host ? () => range(turnLo, turnLo + third) : all;
        const after = (t: Turn) => (x: Session) =>
            all(x).filter((i) => x.id !== t.session || i > t.index);

        const commits = (adds: { path: string; content: string }[]): Commits => {
            const kept = new Set(adds.map((a) => a.path));
            return { adds, removed: [...line.artifacts.keys()].filter((p) => !kept.has(p)) };
        };
        const land = (session: string, c: Commits) => {
            for (const path of c.removed) {
                diffs.push({ session, path, remove: true, fact: id });
                line.artifacts.delete(path);
            }
            for (const a of c.adds) {
                const d: Diff = { session, path: a.path, content: a.content, fact: id };
                diffs.push(d);
                line.artifacts.set(a.path, a.content);
                expose(id, undefined, d);
            }
        };
        const committing = (c: Commits) => c.adds.length + c.removed.length > 0;
        const cue = (
            text: string,
            c: Commits,
            cueText: string | string[] = text,
            role: Turn["role"] = "conveyance",
        ) => {
            fact.cues.push(...[cueText].flat());
            const t =
                isPlan && !planRevised
                    ? takeFinal(
                          [early, open.slice(0, -1)],
                          { role, text, fact: id },
                          inWindow(project.id),
                      )
                    : committing(c)
                      ? takeOpening(early, { role, text, fact: id }, "commits", open.slice(0, -1))
                      : take(early, where, { role, text, fact: id });
            land(t.session, c);
            expose(id, t);
            return t;
        };

        const decoy = manner === "stated_then_reversed" ? tokens.word() : undefined;
        const swap = decoy
            ? {
                  token: decoy,
                  TOKEN: decoy.toUpperCase(),
                  value: tokens.number(),
                  codename: tokens.codename(),
              }
            : undefined;
        const written = isPlan ? statement : render(tpl.statement ?? "", vars);
        const replaces = revision > 0 ? " This replaces the earlier note on the same subject." : "";
        const note = (text: string) =>
            `# Note\n\n${text.charAt(0).toUpperCase()}${text.slice(1)}.${replaces}\n`;
        let conveyed: Turn;
        if (form === "tool_result") {
            const script = renderDeep(tpl.script ?? { path: "", content: "" }, vars);
            const text = render((revision > 0 && tpl.revise) || tpl.command || "", withOld);
            conveyed = cue(text, commits([script]), [text, script.content]);
        } else if (form === "pasted") {
            const text = render((revision > 0 && tpl.revise) || tpl.paste || "", withOld);
            conveyed = cue(text, commits([]));
        } else if (manner === "hand_applied_diff") {
            const content = tpl.example ? `${render(tpl.example.content, vars)}\n` : note(written);
            const path = tpl.example ? render(tpl.example.path, vars) : `notes/${word}.md`;
            // The turn names the committed file as added, which is how the agent meets it in its tree.
            const verb = line.artifacts.has(path) ? "changed" : "added";
            const pushed =
                revision > 0
                    ? `I ${verb} \`${path}\`; it replaces something we set up earlier. Look it over before we continue.`
                    : `I ${verb} \`${path}\`. Look it over before we continue.`;
            conveyed = cue(pushed, commits([{ path, content }]), content);
        } else if (manner === "tool_error") {
            const path = `scripts/check_${word}.sh`;
            const said = written.replace(/["\\`$]/g, "\\$&");
            const replaced = revision > 0 ? " (this rule replaces the earlier one)" : "";
            const content = `#!/bin/sh\n# Pre-merge check.\necho "error: ${said}${replaced}" >&2\nexit 1\n`;
            const text = `Run \`sh ${path}\` from the repo root before you start and tell me what it reports.`;
            conveyed = cue(text, commits([{ path, content }]), [text, content]);
        } else if (manner === "stated_then_reversed") {
            const first = cue(
                `For the record, ${render(statementTemplate, { ...withOld, ...swap })}.`,
                commits([]),
                undefined,
                "reversal",
            );
            const text = `Scratch what I said earlier: ${statement}.`;
            conveyed = take([sessionOf(first.session)], after(first), {
                role: "conveyance",
                text,
                fact: id,
            });
            fact.cues.push(text);
            expose(id, conveyed);
        } else {
            const said: Partial<Record<Manner, string>> = {
                correction: `Quick correction before you carry on: ${statement}.`,
                rejected_approach: `We went down another road before and undid it: ${statement}.`,
                direct_statement: `For the record, ${statement}.`,
            };
            conveyed = cue(said[manner] ?? "", commits([]));
        }
        const accepted = conveyed;
        const startOf = (t: Turn) => sessionOf(t.session).start_ms;
        const later = (p: string) => inWindow(p).filter((x) => x.start_ms > startOf(conveyed));
        const updateText = planRevised
            ? `Change of plan for next time: drop ${taskText(0)}; the next step is ${taskText(1)} instead.`
            : tpl.update && revision === 0
              ? `One change: ${render(tpl.update, vars)}.`
              : undefined;
        if (updateText) {
            const updatePool = [sessionOf(conveyed.session), ...later(project.id)];
            const half = updatePool.slice(0, Math.max(1, Math.ceil(updatePool.length / 2)));
            const turn = { role: "update" as const, text: updateText, fact: id };
            conveyed = planRevised
                ? takeFinal([half, updatePool.slice(0, -1)], turn, inWindow(project.id), conveyed)
                : take(half, after(conveyed), turn);
            fact.cues.push(updateText);
            expose(id, conveyed);
        }
        facts.push(fact);

        const addProbe = (
            type: string,
            projectId: string,
            text: string,
            check: unknown,
            candidates: Session[],
            truth: TruthOf,
            at = all,
            opens = false,
        ) => {
            const pid = pad("q", probes.length);
            keys.push(pid);
            const shown = distinct(projectId, id, text);
            const turn = {
                role: "probe" as const,
                text: shown,
                fact: id,
                probe: pid,
            };
            const t = opens ? takeOpening(candidates, turn, "probe") : take(candidates, at, turn);
            probes.push({
                id: pid,
                type,
                fact: id,
                project: projectId,
                session: t.session,
                text: shown,
                check,
            });
            truths.set(pid, {
                ...truth,
                basis,
                supersedes: line.facts.map((x) => x.id),
                fact: id,
                words: [...new Set([...words, ...line.words])],
            });
            return t;
        };
        const planCheck = (k: 0 | 1) => renderDeep<Check>(tasks[k].tpl.check, tasks[k].vars);
        const musts = (k: 0 | 1) => (planCheck(k).must as string[] | undefined) ?? [];
        const base: Check = isPlan
            ? planExpect === "clarify"
                ? { clarify: [...musts(0), ...musts(1)], must_not: [...musts(0), ...musts(1)] }
                : planRevised
                  ? append(planCheck(1), negate(planCheck(0)))
                  : planCheck(0)
            : renderDeep<Check>(tpl.check, vars);
        const inherited = inherit(
            base,
            line.base[revision - 1],
            line.inherited,
            line.required[revision - 1],
        );
        const superseded = swap ? renderDeep<Check>(tpl.check, { ...vars, ...swap }) : {};
        const swappedOnly = (pattern: string) => {
            const names = [...pattern.matchAll(/\{(\w+)\}/g)].map(([, k]) => k ?? "");
            return swap !== undefined && names.length > 0 && names.every((k) => k in swap);
        };
        const obsolete: Check = Object.fromEntries(
            lists(tpl.check as Check, "must").flatMap(([k, patterns]) =>
                patterns.every(swappedOnly)
                    ? [[k, patterns.map((x) => render(x, { ...vars, ...swap }))]]
                    : [],
            ),
        );
        const check = append(append(append(base, superseded), negate(obsolete)), inherited);
        const mustNot = append(append(negate(base), negate(superseded)), inherited);
        const outBase = renderDeep<Check>(tpl.out_check ?? tpl.check, vars);
        const outInherited = inherit(
            outBase,
            line.outBase[revision - 1],
            line.outInherited,
            line.required[revision - 1],
        );

        const bound = [...GENERATED, ...Object.keys(variant)];
        const words = Object.values(variant);
        const groupsOf = (c: unknown, v: Record<string, string>) =>
            placeholderGroups(c, true)
                .map((g) => g.filter((k) => bound.includes(k)).map((k) => v[k] as string))
                .filter((g) => g.length > 0);
        const absentOf = (c: unknown, v: Record<string, string>) => [
            ...new Set(
                placeholderGroups(c, false)
                    .flat()
                    .filter((k) => bound.includes(k))
                    .map((k) => v[k] as string),
            ),
        ];
        const taskLits = (k: 0 | 1) => groupsOf(tasks[k].tpl.check, tasks[k].vars);
        const ownPresent = isPlan
            ? planExpect === "clarify"
                ? [...taskLits(0), ...taskLits(1)]
                : taskLits(planRevised ? 1 : 0)
            : groupsOf(tpl.check, vars);
        const ownAbsent = isPlan ? [] : absentOf(tpl.check, vars);
        const replaced = [
            ...line.literals,
            ...[...statementTemplate.matchAll(/\{(\w+)\}/g)].flatMap(([, k]) =>
                swap && k && k in swap ? [swap[k as keyof typeof swap]] : [],
            ),
            ...(planRevised ? taskLits(0).flat() : []),
            ...(f.kind === "decision" ? ownAbsent : []),
        ];
        const stale = [...new Set(replaced)].filter((x) => !ownPresent.flat().includes(x));
        const QUOTES = ["double", "single"];
        const truthFor = (expect: Expect, outSide = false): TruthOf => {
            const present = outSide ? groupsOf(tpl.out_check, vars) : ownPresent;
            const style = renderDeep<Check>(
                (outSide ? tpl.out_check : tpl.check) ?? {},
                vars,
            ).quote_style_must;
            const opposite = QUOTES.filter((q) => typeof style === "string" && q !== style);
            const absent = [...(outSide ? absentOf(tpl.out_check, vars) : ownAbsent), ...opposite];
            if (expect === "avoid") {
                const all = [...new Set([...present.flat(), ...absent])];
                return { expect, present: [], absent: all, stale };
            }
            if (expect === "abstain") return { expect, present: [], absent: [], stale };
            const apart = (xs: string[]) => xs.filter((x) => !present.flat().includes(x));
            return { expect, present, absent: apart(absent), stale: apart(stale) };
        };
        const probeText = render(tpl.probe, vars);
        const outText = render(tpl.out_probe ?? tpl.probe, vars);
        const fromConveyed = later(project.id);
        if (f.type === "P1") {
            addProbe("P1", project.id, probeText, check, fromConveyed, truthFor("apply"));
            addProbe("P2", project.id, outText, mustNot, fromConveyed, truthFor("avoid"));
            const twin = twinOf(project.id);
            addProbe("P11", twin, probeText, mustNot, later(twin), truthFor("avoid"));
        } else if (host) {
            const turns: [number, number] = [conveyed.index + 1, turnHi];
            const ranged = { ...check, turns };
            const placed = addProbe(
                "P13",
                project.id,
                probeText,
                ranged,
                [host],
                truthFor("apply"),
                () => range(turnHi - third, turnHi),
            );
            turns[1] = placed.index + 1;
        } else if (f.type === "P4") {
            const out = (slot + (f.i % owners.length) + (seed % 2)) % 2 === 1;
            const scoped = out ? append(outBase, outInherited) : check;
            // An out item's rules hold outside the narrowed scope, so it names that scope too.
            const scope = (base as { scope?: string }).scope;
            const c = { ...scoped, ...(out && scope ? { scope } : {}), side: out ? "out" : "in" };
            const truth = truthFor("apply", out);
            addProbe("P4", project.id, out ? outText : probeText, c, fromConveyed, truth);
        } else if (f.type === "P6") {
            const target = resumeTarget(sessionOf(conveyed.session), inWindow(project.id));
            const t = addProbe(
                "P6",
                project.id,
                probeText,
                check,
                target ? [target] : [],
                truthFor(planExpect ?? "resume"),
                all,
                true,
            );
            sessionOf(t.session).min_gap_ms = HOUR;
            const next =
                planExpect === "clarify"
                    ? [taskText(0), taskText(1)]
                    : [taskText(planRevised ? 1 : 0)];
            const text =
                planExpect === "clarify"
                    ? `Let's set both of those aside for now; consider ${taskText(0)} and ${taskText(1)} closed.`
                    : `That covers ${next[0]}; consider that plan finished.`;
            const done = take([sessionOf(t.session)], after(t), {
                role: "status",
                text,
                fact: id,
            });
            const history: { turn: Turn; status: PlanStatus; next: string[] }[] = [
                { turn: accepted, status: "accepted", next: planRevised ? [taskText(0)] : next },
            ];
            if (planRevised) history.push({ turn: conveyed, status: "revised", next });
            history.push({ turn: done, status: "completed", next: [] });
            planTurns.set(id, history);
            plans.push({
                fact: id,
                project: project.id,
                expect: planExpect ?? "resume",
                history: [],
            });
        } else if (f.kind === "decision" && tpl.authority) {
            const { path, content } = renderDeep(tpl.authority, vars);
            const text = `I committed ${path}. Its figure replaces the one I gave you before; nothing needs changing yet.`;
            fact.cues.push(text, content);
            const target = takeOpening(
                fromConveyed.slice(0, -1),
                { role: "conveyance", text, fact: id },
                "commits",
            );
            land(target.session, commits([{ path, content }]));
            expose(id, target);
            const rest = fromConveyed.filter(
                (x) => x.start_ms > sessionOf(target.session).start_ms,
            );
            addProbe(f.type, project.id, probeText, check, rest, truthFor("apply"));
        } else if (form === "tool_result") {
            const fix = commits([]);
            const gone = fix.removed.map((path) => `\`${path}\``).join(" and ");
            const text = `I took ${gone} out of the repo now that the fix is in.`;
            const turn = { role: "conveyance" as const, text, fact: id };
            const fixed = takeOpening(fromConveyed.slice(0, -1), turn, "commits");
            land(fixed.session, fix);
            const rest = fromConveyed.filter(
                (x) => x.start_ms >= sessionOf(fixed.session).start_ms,
            );
            addProbe(f.type, project.id, probeText, check, rest, truthFor("apply"), after(fixed));
        } else {
            const expect: Expect =
                f.type === "P5" || f.type === "P10"
                    ? "avoid"
                    : f.type === "P7"
                      ? "explain"
                      : f.type === "P8"
                        ? "answer"
                        : f.type === "P9"
                          ? "abstain"
                          : "apply";
            addProbe(f.type, project.id, probeText, check, fromConveyed, truthFor(expect));
            if (f.type === "P8" && controls.has("wrong-project-lookup")) {
                // The twin asks the same lookup: the value is the base project's, never the twin's.
                const value = (check as { answer: string }).answer;
                const twin = twinOf(project.id);
                const twinCheck = { abstain: true, answer_must_not: [value], owner: project.id };
                const truth: TruthOf = { expect: "abstain", present: [], absent: [value], stale };
                addProbe("P8-twin", twin, probeText, twinCheck, later(twin), truth);
            }
        }
        line.facts.push(fact);
        line.vars.push(vars);
        line.base.push(base);
        line.inherited = inherited;
        line.outBase.push(outBase);
        line.outInherited = outInherited;
        line.literals.push(...ownPresent.flat(), ...ownAbsent);
        line.required.push(ownPresent.flat());
        line.words.push(...words);
    }
    for (const i of range(0, perType)) {
        const session = p90[i % p90.length] as Session;
        const slot = Math.floor(i / p90.length);
        const slots = Math.ceil((perType - (i % p90.length)) / p90.length);
        const turns = session.turn_ms.length;
        const lastThird = Math.floor((2 * turns) / 3);
        const edge = (k: number) => lastThird + Math.floor((k * (turns - lastThird)) / slots);
        const check = { window_from_turn: edge(slot), window_to_turn: edge(slot + 1) };
        const { project, id } = session;
        const pid = pad("q", probes.length);
        keys.push(pid);
        probes.push({
            id: pid,
            type: "P14",
            fact: null,
            project,
            session: id,
            text: null,
            check,
        });
    }

    const pasteRng = rngFor("pastes");
    const pasteable = input.pastes.filter((p) => markerHits(p.content, keys).length === 0);
    for (const session of sessions) {
        const lang = input.projects.find((p) => p.id === session.project)?.lang ?? "rust";
        const fillers = (bank[lang]?.filler ?? []) as string[];
        for (const index of all(session)) {
            if (turns.has(key(session.id, index))) continue;
            const base = { session: session.id, index };
            if (pasteRng.next() < 0.1 && pasteable.length > 0) {
                const p = pasteRng.pick(pasteable);
                const text = `Here's what I'm seeing:\n\`\`\`\n${p.content}\n\`\`\``;
                const paste = { sample_id: p.id, bytes: Buffer.byteLength(p.content) };
                turns.set(key(session.id, index), { ...base, role: "paste", text, paste });
            } else
                turns.set(key(session.id, index), {
                    ...base,
                    role: "filler",
                    text: pasteRng.pick(fillers),
                });
        }
    }

    const withContent = diffs.filter((d) => d.content !== undefined);
    const authorities = withContent.filter(
        (d) => !facts.find((f) => f.id === d.fact)?.cues.includes(d.content as string),
    );
    // A shared opening delivers every joined cue in one turn, so that turn is scored as a cue too.
    const joined = [...turns.values()].filter((t) => (t.facts?.length ?? 0) > 1);
    const joinedOf = (fact: string) =>
        joined.filter((t) => t.facts?.includes(fact)).map((t) => t.text);
    const allCues = [
        ...facts.flatMap((f) => f.cues),
        ...authorities.map((d) => d.content as string),
        ...joined.map((t) => t.text),
    ];
    const pairs = probes.flatMap((p) => {
        const fact = facts.find((f) => f.id === p.fact);
        const text = p.text;
        if (!fact || !text) return [];
        const authority = authorities
            .filter((d) => d.fact === fact.id)
            .map((d) => d.content as string);
        return [...new Set([...fact.cues, ...authority, ...joinedOf(fact.id)])].map((cue) => ({
            probe: p.id,
            fact: fact.id,
            cue,
            text,
        }));
    });
    const texts = [...new Set(pairs.flatMap((x) => [x.cue, x.text]))];
    const vectors = await input.embedder.embed(texts);
    const dims = vectors[0]?.length ?? 0;
    const norm = (v: number[]) => Math.sqrt(v.reduce((sum, x) => sum + x * x, 0));
    const wellFormed = (v: number[]) =>
        v.length === dims && v.every(Number.isFinite) && norm(v) > 0 && Number.isFinite(norm(v));
    if (vectors.length !== texts.length || dims === 0 || !vectors.every(wellFormed)) {
        throw new Error(
            `embedder ${input.embedder.model} returned ${vectors.length} vectors for ${texts.length} texts; each must hold the same positive count of finite numbers with a finite positive norm`,
        );
    }
    const vec = new Map(texts.map((t, i) => [t, vectors[i] ?? []]));
    const scored = pairs.map(({ probe, fact, cue, text }) => ({
        probe,
        fact,
        cue_sha256: sha256Hex(cue),
        bm25: bm25Ratio(text, cue, allCues),
        cosine: cosine(vec.get(text) ?? [], vec.get(cue) ?? []),
    }));
    for (const x of scored) {
        if (!Number.isFinite(x.bm25) || !Number.isFinite(x.cosine)) {
            throw new Error(`${x.probe}: cue/probe similarity is not a finite number`);
        }
        if (x.bm25 > Number(thresholds.bm25_max) || x.cosine > Number(thresholds.cosine_max)) {
            throw new Error(
                `${x.probe}: cue/probe similarity bm25 ${round4(x.bm25)}, cosine ${round4(x.cosine)} exceeds the pre-registered threshold`,
            );
        }
    }
    const similarity = scored.map((x) => ({
        ...x,
        bm25: round4(x.bm25),
        cosine: round4(x.cosine),
    }));
    const delivered = [...turns.values()].map((t) => [`${t.session}#${t.index}`, t.text]);
    for (const d of diffs)
        delivered.push([`${d.session} diff ${d.path}`, `${d.path}\n${d.content ?? ""}`]);
    for (const [where, text] of delivered) {
        const hits = markerHits(text ?? "", keys).join(", ");
        if (hits) throw new Error(`${where}: delivered text carries markers ${hits}`);
    }

    schedule();
    const raw: {
        at: number;
        order: number;
        event: Record<string, unknown>;
        ref?: Turn | Diff;
    }[] = [];
    for (const session of sessions) {
        const { id, project } = session;
        const at = session.start_ms;
        for (const d of diffs.filter((x) => x.session === id)) {
            raw.push({ at, order: 0, event: { kind: "apply_diff", project, ...d }, ref: d });
        }
        const forced_p90 = session.forced_p90;
        raw.push({
            at,
            order: 1,
            event: { kind: "session_start", session: id, project, forced_p90 },
        });
        session.turn_ms.forEach((t, i) => {
            const turn = turns.get(key(id, i));
            raw.push({
                at: at + t,
                order: 2 + i,
                event: { kind: "user_turn", ...turn },
                ref: turn,
            });
        });
        raw.push({
            at: at + lastTurn(session),
            order: 1e9,
            event: { kind: "session_end", session: id },
        });
    }
    raw.sort((a, b) => a.at - b.at || a.order - b.order);
    const events = raw.map((r, i): Record<string, unknown> & { id: string } => ({
        id: pad("e", i, 6),
        scenario_ms: r.at,
        ...r.event,
    }));
    const indexOf = new Map<Turn | Diff, number>();
    raw.forEach((r, i) => {
        if (r.ref) indexOf.set(r.ref, i);
    });
    const probeEvent = new Map(
        events.flatMap((e) =>
            e.kind === "user_turn" && e.probe ? [[e.probe as string, e.id]] : [],
        ),
    );
    for (const p of probes) if (p.text) p.event = probeEvent.get(p.id);
    const lastTurnEvent = new Map<string, string>();
    for (const e of events)
        if (e.kind === "user_turn") lastTurnEvent.set(e.session as string, e.id);
    for (const p of probes) if (p.type === "P14") p.event = lastTurnEvent.get(p.session);
    const lastCue = new Map<unknown, number>();
    events.forEach((e, i) => {
        if (!e.fact || e.role === "probe" || e.role === "status") return;
        for (const fact of [e.fact, ...((e.facts as string[] | undefined) ?? [])]) {
            lastCue.set(fact, i);
        }
    });
    events.forEach((e, i) => {
        if (e.role === "probe" && e.fact && i < (lastCue.get(e.fact) ?? 0)) {
            throw new Error(`${e.id}: probe precedes a conveyance of ${e.fact}`);
        }
    });
    const order = new Map(events.map((e, i) => [e.id, i]));
    const sourcesOf = (fact: string) => {
        const e = exposure.get(fact) ?? { turns: [], diffs: [] };
        return [...e.turns, ...e.diffs].map((ref) => indexOf.get(ref) ?? -1).sort((a, b) => a - b);
    };
    const projectOfSession = new Map(sessions.map((x) => [x.id, x.project]));
    proveExposure({
        probes,
        facts,
        events,
        truths,
        sourcesOf,
        projectOf: (e) =>
            (e.project as string | undefined) ?? projectOfSession.get(e.session as string) ?? "",
    });
    for (const plan of plans) {
        plan.history = (planTurns.get(plan.fact) ?? []).map((h) => ({
            event: events[indexOf.get(h.turn) ?? -1]?.id ?? "",
            status: h.status,
            next: h.next,
        }));
    }
    proveTwoPlansNeverOpen(plans, probes, order);
    proveResumeFollowsPlan(
        plans,
        probes,
        events,
        (e) => (e.project as string | undefined) ?? projectOfSession.get(e.session as string) ?? "",
    );

    const summary = sessions.map(({ turn_ms, ...x }, i) => {
        const prev = sessions[i - 1];
        const gap_before_ms = prev ? x.start_ms - prev.start_ms - lastTurn(prev) : 0;
        return { ...x, requests: turn_ms.length, gap_before_ms };
    });
    const diffSessions = new Set(diffs.map((d) => d.session));
    const guarded = new Map<string, number>();
    const guard = (session: string, n: number) =>
        guarded.set(session, Math.max(guarded.get(session) ?? 0, n));
    for (const p of probes) {
        if (p.type === "P14") {
            guard(p.session, (p.check as { window_to_turn: number }).window_to_turn);
            continue;
        }
        const sources = (p.ground_truth?.sources ?? []).map((id) => events[order.get(id) ?? -1]);
        for (const e of [events[order.get(p.event ?? "") ?? -1], ...sources]) {
            if (e?.kind === "user_turn") guard(e.session as string, (e.index as number) + 1);
        }
    }
    for (const h of plans.flatMap((x) => x.history)) {
        const e = events[order.get(h.event) ?? -1];
        if (e?.kind === "user_turn") guard(e.session as string, (e.index as number) + 1);
    }
    const faults = scheduleFaults(
        prereg.tier,
        summary.map((x) => ({
            ...x,
            has_diff: diffSessions.has(x.id),
            guarded_turns: guarded.get(x.id) ?? 0,
        })),
        rngFor("faults"),
    );
    const turnCounts = new Map(summary.map((x) => [x.id, x.requests]));
    for (const f of faults) validateFault(f, turnCounts);
    const eligible = probes.filter((p) => ["P1", "P3", "P5"].includes(p.type));
    const cf_deletions = prereg.arms.run.includes("eidnara-cf")
        ? shuffle(eligible, rngFor("counterfactual"))
              .slice(0, Math.round(0.2 * eligible.length))
              .map((p) => ({ probe: p.id, fact: p.fact, before_event: p.event }))
              .sort((a, b) => (a.probe < b.probe ? -1 : 1))
        : [];

    const body = {
        schema: GENERATOR_VERSION,
        manifest: {
            generator_version: GENERATOR_VERSION,
            random_schema_version: 1,
            seed,
            tier: prereg.tier,
            corpus_inputs_sha256: input.corpusInputsSha256,
            preregistration_sha256: sha256Hex(canonicalJson(prereg)),
            embedding_model: input.embedder.model,
            cue_probe_similarity: thresholds,
            within_session_gap_scale: Math.round(withinScale * 1e6) / 1e6,
            between_session_gap_scale: Math.round(gapScale * 1e6) / 1e6,
            probes_per_type: perType,
            ...(input.qualification ? { qualification_sha256: input.qualification.sha256 } : {}),
        },
        projects: input.projects,
        sessions: summary,
        facts,
        probes,
        plans,
        similarity,
        events,
        faults,
        cf_deletions,
    };
    return { ...body, scenario_hash: scenarioHash(body) };
}

/** The digest a manifest records for its scenario: the canonical JSON of every field but `scenario_hash`. */
export function scenarioHash(scenario: Record<string, unknown>): string {
    const { scenario_hash: _recorded, ...body } = scenario;
    return sha256Hex(canonicalJson(body));
}

export type Scenario = Awaited<ReturnType<typeof compileScenario>>;

export interface ScenarioInputs {
    preregistration_sha256: string;
    corpus_inputs_sha256: string;
    /** Null for a tier scenario, whose manifest names no qualification. */
    qualification_sha256: string | null;
}

/** A cached scenario is reusable only when the current generator and the named inputs produced it. */
export function scenarioInputMismatch(scenario: Scenario, inputs: ScenarioInputs): string | null {
    const m = scenario.manifest;
    if (scenario.schema !== GENERATOR_VERSION) {
        return `scenario.json has schema ${scenario.schema}, not ${GENERATOR_VERSION}`;
    }
    if (m.generator_version !== GENERATOR_VERSION) {
        return `scenario.json is from generator ${m.generator_version}, not ${GENERATOR_VERSION}`;
    }
    if (m.preregistration_sha256 !== inputs.preregistration_sha256) {
        return `scenario.json was compiled with pre-registration ${m.preregistration_sha256}, not ${inputs.preregistration_sha256}`;
    }
    if (m.corpus_inputs_sha256 !== inputs.corpus_inputs_sha256) {
        return `scenario.json was compiled from corpus ${m.corpus_inputs_sha256}, not ${inputs.corpus_inputs_sha256}`;
    }
    const qualification = (m as { qualification_sha256?: string }).qualification_sha256 ?? null;
    if (qualification !== inputs.qualification_sha256) {
        return `scenario.json was compiled under qualification ${qualification ?? "none"}, not ${inputs.qualification_sha256 ?? "none"}`;
    }
    return null;
}

type ScenarioEvent = Record<string, unknown> & { id: string };

interface Exposure {
    probes: ProbeItem[];
    facts: Fact[];
    events: ScenarioEvent[];
    truths: Map<string, Truth>;
    sourcesOf: (fact: string) => number[];
    projectOf: (e: ScenarioEvent) => string;
}

/** Lower-cased, since a generated word and its upper-case form name one value. */
const eventText = (e: ScenarioEvent) =>
    e.kind === "user_turn" || e.kind === "apply_diff"
        ? String(e.text ?? e.content ?? "").toLowerCase()
        : "";
/** A number occurs as a whole value, with no digit beside it; a generated word occurs anywhere. */
export const holds = (text: string, lit: string) =>
    /^\d+$/.test(lit)
        ? new RegExp(`(?<!\\d)${lit}(?!\\d)`).test(text)
        : text.toLowerCase().includes(lit.toLowerCase());

/**
 * Fills each probe's `ground_truth` and refuses a probe whose ground truth the event sequence
 * does not support: every source precedes the probe in the fact's project, each generated literal
 * the probe turns on appears in a source, the scenario-defined tree at the probe holds no
 * superseded generated literal, none reaches the agent after the last source carrying the item's
 * own literals (an avoid item's forbidden ones included), a P3
 * item's authoritative value is in the tree, a tool-result P12 item's failing check is not, and
 * no project asks one probe text for two facts.
 */
export function proveExposure(o: Exposure): void {
    const order = new Map(o.events.map((e, i) => [e.id, i]));
    const asked = new Map<string, string>();
    for (const p of o.probes) {
        const truth = o.truths.get(p.id);
        if (!p.text || !truth) continue;
        const { fact: factId, words, ...rest } = truth;
        const tracked = truth.stale.filter((x) => !words.includes(x));
        const k = `${p.project}\n${p.text}`;
        const earlier = asked.get(k);
        if (earlier !== undefined && earlier !== factId) {
            throw new Error(`${p.id}: ${p.project} asks this probe text for ${earlier} too`);
        }
        asked.set(k, factId);
        const at = order.get(p.event ?? "");
        const fact = o.facts.find((f) => f.id === factId);
        if (at === undefined || !fact) throw new Error(`${p.id}: probe has no event or fact`);
        const all = o.sourcesOf(fact.id);
        if (all.some((i) => i < 0)) throw new Error(`${p.id}: a source of ${fact.id} has no event`);
        if (all.length === 0) throw new Error(`${p.id}: no event exposes ${fact.id}`);
        const sources = all.map((i) => o.events[i] as ScenarioEvent);
        for (const [n, e] of sources.entries()) {
            if ((all[n] as number) >= at) {
                throw new Error(`${p.id}: source ${e.id} of ${fact.id} does not precede the probe`);
            }
            if (o.projectOf(e) !== fact.project) {
                throw new Error(
                    `${p.id}: source ${e.id} of ${fact.id} lies outside ${fact.project}`,
                );
            }
        }
        const present = truth.present.flat();
        const own = [...present, ...truth.absent].filter((x) => !truth.stale.includes(x));
        for (const lit of own) {
            if (!sources.some((e) => holds(eventText(e), lit))) {
                throw new Error(`${p.id}: no source of ${fact.id} exposes ${lit}`);
            }
        }
        const tree = new Map<string, string>();
        for (const e of o.events.slice(0, at)) {
            if (e.kind !== "apply_diff" || e.project !== p.project) continue;
            if (e.remove) tree.delete(String(e.path));
            else tree.set(String(e.path), String(e.content));
        }
        for (const lit of tracked) {
            for (const [path, content] of tree) {
                if (holds(content, lit)) {
                    throw new Error(
                        `${p.id}: ${path} still holds the superseded ${lit} at the probe`,
                    );
                }
            }
        }
        const carries = all.filter((i) =>
            own.some((lit) => holds(eventText(o.events[i] as ScenarioEvent), lit)),
        );
        if (carries.length > 0) {
            const current = Math.max(...carries);
            for (const e of o.events.slice(current + 1, at)) {
                const lit = tracked.find((x) => holds(eventText(e), x));
                if (lit && o.projectOf(e) === fact.project) {
                    throw new Error(
                        `${p.id}: ${e.id} exposes the superseded ${lit} after the current state`,
                    );
                }
            }
        }
        if (fact.form === "tool_result") {
            const lit = present.find((x) => [...tree.values()].some((c) => holds(c, x)));
            if (lit) throw new Error(`${p.id}: the tree still holds the check that prints ${lit}`);
        }
        if (p.type === "P3") {
            const files = [...tree.values()];
            const missing = truth.present.find(
                (g) => !g.some((x) => files.some((c) => holds(c, x))),
            );
            if (missing) {
                throw new Error(
                    `${p.id}: the authoritative ${missing.join(" or ")} is not in the tree`,
                );
            }
        }
        p.ground_truth = { ...rest, sources: sources.map((e) => e.id) };
    }
}

/**
 * Refuses a P6 item whose project receives a request or a commit between its plan's latest
 * conveyance and the probe: a task or a note there would be another candidate for "what we left
 * unfinished".
 */
export function proveResumeFollowsPlan(
    plans: PlanRecord[],
    probes: ProbeItem[],
    events: ReadonlyArray<Record<string, unknown> & { id: string }>,
    projectOf: (e: Record<string, unknown>) => string,
): void {
    const order = new Map(events.map((e, i) => [e.id, i]));
    for (const p of probes.filter((x) => x.type === "P6")) {
        const at = order.get(p.event ?? "");
        const plan = plans.find((x) => x.fact === p.fact);
        const sources = (plan?.history ?? [])
            .filter((h) => h.status !== "completed")
            .map((h) => order.get(h.event) ?? -1)
            .filter((i) => at !== undefined && i >= 0 && i < at);
        if (at === undefined || sources.length === 0) {
            throw new Error(`${p.id}: its plan has no conveyance before the probe`);
        }
        const from = Math.max(...sources);
        for (const e of events.slice(from + 1, at)) {
            if ((e.kind === "user_turn" || e.kind === "apply_diff") && projectOf(e) === p.project) {
                throw new Error(
                    `${p.id}: ${e.id} reaches ${p.project} between its plan's latest conveyance ${events[from]?.id} and the probe`,
                );
            }
        }
    }
}

/** Refuses a P6 item whose probe finds another plan of its project accepted and not completed. */
export function proveTwoPlansNeverOpen(
    plans: PlanRecord[],
    probes: ProbeItem[],
    order: Map<string, number>,
): void {
    const at = (event: string) => order.get(event) ?? Number.POSITIVE_INFINITY;
    for (const p of probes.filter((x) => x.type === "P6")) {
        const when = at(p.event ?? "");
        for (const plan of plans.filter((x) => x.project === p.project)) {
            const accepted = plan.history.find((h) => h.status === "accepted");
            const completed = plan.history.find((h) => h.status === "completed");
            if (plan.fact === p.fact) {
                if (!accepted || at(accepted.event) >= when) {
                    throw new Error(`${p.id}: its plan ${plan.fact} is not accepted before it`);
                }
                continue;
            }
            const open = accepted && at(accepted.event) < when;
            if (open && (!completed || at(completed.event) >= when)) {
                throw new Error(`${p.id}: plan ${plan.fact} is still open at the probe`);
            }
        }
    }
}
