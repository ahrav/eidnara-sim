import { sample } from "../corpus/cdf";
import { type Distributions, table } from "../corpus/distributions";
import { canonicalJson, sha256Hex } from "../prereg/canonical";
import type { Preregistration } from "../prereg/schema";
import { Rng } from "../rng";
import { bm25Ratio, cosine, type Embedder } from "./similarity";
import { Tokens } from "./tokens";

export const GENERATOR_VERSION = "sim-scenario/v1";

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
    statement: string;
    probe: string;
    out_probe?: string;
    update?: string;
    example?: string;
    authority?: { path: string; content: string };
    check: Record<string, unknown>;
    out_check?: Record<string, unknown>;
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
    errorCodes: { id: string; code: string; context: string }[];
    corpusManifestSha256: string;
    embedder: Embedder;
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
    role: "filler" | "paste" | "conveyance" | "update" | "reversal" | "probe";
    text: string;
    fact?: string;
    probe?: string;
    paste?: { sample_id: string; bytes: number };
}

export interface Fact {
    id: string;
    template: string;
    kind: string;
    project: string;
    manner: Manner;
    statement: string;
    cues: string[];
}

export interface ProbeItem {
    id: string;
    type: string;
    fact: string | null;
    project: string;
    session: string;
    text: string | null;
    check: unknown;
    event?: string;
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

function streams(seed: number) {
    return (domain: string) => {
        let h = 0x811c9dc5;
        for (const c of domain) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
        return new Rng((seed ^ h) >>> 0);
    };
}

function shuffle<T>(items: T[], rng: Rng): T[] {
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
    const plan = shuffle(
        input.projects.flatMap((p) => Array<Project>(count(p)).fill(p)),
        sessRng,
    );
    const baseIdx = plan.flatMap((p, i) => (p.twin_of ? [] : [i]));
    const forced = new Set(
        range(0, s.forced_p90_sessions).map(
            (k) => baseIdx[Math.floor(((k + 0.5) * baseIdx.length) / s.forced_p90_sessions)],
        ),
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
    const inSession = sessions.reduce((sum, x) => sum + lastTurn(x), 0);
    const betweenSum = Math.max(
        1,
        between.reduce((a, b) => a + b, 0),
    );
    const span = s.simulated_days * 86_400_000;
    const withinScale = Math.min(1, (0.8 * span) / Math.max(1, inSession));
    for (const x of sessions) x.turn_ms = x.turn_ms.map((t) => Math.round(t * withinScale));
    const gapScale = (span - inSession * withinScale) / betweenSum;
    let clock = 0;
    sessions.forEach((x, i) => {
        if (i > 0) clock += Math.round((between[i - 1] ?? 0) * gapScale);
        x.start_ms = clock;
        clock += lastTurn(x);
    });

    const perType = Math.ceil(
        prereg.stopping_rule.paired_items_per_probe_type /
            (prereg.seeds.length * prereg.hosts.length),
    );
    const p90 = sessions.filter((x) => x.forced_p90);
    for (const x of p90) {
        while (x.turn_ms.length < P13_SPAN * Math.ceil(perType / p90.length))
            x.turn_ms.push(lastTurn(x) + 60_000);
    }

    const turns = new Map<string, Turn>();
    const key = (session: string, index: number) => `${session}#${index}`;
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
        const open = candidates.flatMap((x) =>
            where(x)
                .filter((i) => !turns.has(key(x.id, i)))
                .map((i) => [x, i] as const),
        );
        const [session, slot] =
            open.length > 0 ? place.pick(open) : [candidates[candidates.length - 1] as Session, -1];
        let index = slot;
        if (index < 0) {
            index = session.turn_ms.length;
            session.turn_ms.push(lastTurn(session) + 60_000);
        }
        const t = { ...turn, session: session.id, index };
        turns.set(key(session.id, index), t);
        return t;
    };

    const bases = input.projects.filter((p) => !p.twin_of);
    const twinOf = (p: string) => input.projects.find((x) => x.twin_of === p)?.id ?? p;
    const facts: Fact[] = [];
    const probes: ProbeItem[] = [];
    const keys: string[] = [];
    const diffs: { session: string; path: string; content: string; fact: string }[] = [];
    const factSpecs = FACT_SPECS.flatMap((spec) => range(0, perType).map((i) => ({ ...spec, i })));
    const pool = mannerQuota(factSpecs.length);
    for (const f of factSpecs) {
        if (!f.fixed) continue;
        const at = pool.indexOf(f.fixed);
        if (at < 0) throw new Error(`manner quota too small for ${f.type}`);
        pool.splice(at, 1);
    }
    shuffle(pool, rngFor("manners"));

    for (const f of factSpecs) {
        const owners = f.inSession ? p90 : bases;
        const slot = Math.floor(f.i / owners.length);
        const host = f.inSession ? (p90[f.i % p90.length] as Session) : undefined;
        const project = (
            host ? input.projects.find((x) => x.id === host.project) : bases[f.i % bases.length]
        ) as Project;
        const lang = f.kind in (bank[project.lang] ?? {}) ? project.lang : "any";
        const templates = (bank[lang]?.[f.kind] ?? []) as Template[];
        if (templates.length === 0) throw new Error(`fact bank has no ${f.kind} templates`);
        const tpl = templates[slot % templates.length] as Template;
        const own = byProject(project.id);
        const perOwner = Math.ceil((perType - (f.i % owners.length)) / owners.length);
        const windows = f.inSession ? perOwner : Math.ceil(perOwner / templates.length);
        const w = f.inSession ? slot : Math.floor(slot / templates.length);
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
        const err = f.kind === "tool_error" ? place.pick(input.errorCodes) : undefined;
        const vars: Record<string, string> = {
            token: word,
            TOKEN: word.toUpperCase(),
            value: tokens.number(),
            value2: tokens.number(),
            codename: tokens.codename(),
            code: err?.code ?? "",
            context: err?.context ?? "",
            code_re: (err?.code ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        };
        const reversible = !f.inSession && /\{(?:token|TOKEN|value|codename)\}/.test(tpl.statement);
        const allowed = (m: Manner) =>
            !(f.inSession && m === "hand_applied_diff") &&
            (reversible || m !== "stated_then_reversed") &&
            (MANNER_KINDS[m]?.includes(f.kind) ?? true);
        const at = pool.findIndex(allowed);
        const manner: Manner =
            f.fixed ?? (at < 0 ? "correction" : (pool.splice(at, 1)[0] as Manner));
        const id = pad("f", facts.length);
        keys.push(id, tpl.id);
        const statement = render(tpl.statement, vars);
        const targets = f.type === "P1" ? [project.id, twinOf(project.id)] : [project.id];
        const deadline = Math.min(...targets.map((t) => inWindow(t).at(-1)?.start_ms ?? 0));
        const open = win.slice(win.length > 2 ? 1 : 0).filter((x) => x.start_ms < deadline);
        const early = host ? [host] : open.slice(0, Math.max(1, Math.ceil(open.length * 0.6)));
        const where = host ? () => range(turnLo, turnLo + third) : all;
        const fact: Fact = {
            id,
            template: tpl.id,
            kind: f.kind,
            project: project.id,
            manner,
            statement,
            cues: [],
        };
        const cue = (text: string, cueText = text, role: Turn["role"] = "conveyance") => {
            fact.cues.push(cueText);
            return take(early, where, { role, text, fact: id });
        };
        const after = (t: Turn) => (x: Session) =>
            all(x).filter((i) => x.id !== t.session || i > t.index);

        let conveyed: Turn;
        if (manner === "hand_applied_diff") {
            const content = tpl.example
                ? `${render(tpl.example, vars)}\n`
                : `# Note\n\n${statement.charAt(0).toUpperCase()}${statement.slice(1)}.\n`;
            const ext = project.lang === "rust" ? `_example.rs` : `-example.ts`;
            const path = tpl.example ? `src/${word}${ext}` : `notes/${word}.md`;
            conveyed = cue(
                "I pushed a small change to the repo. Look over the latest commit before we continue.",
                content,
            );
            diffs.push({ session: conveyed.session, path, content, fact: id });
        } else if (manner === "stated_then_reversed") {
            const decoy = tokens.word();
            const swap = {
                token: decoy,
                TOKEN: decoy.toUpperCase(),
                value: tokens.number(),
                codename: tokens.codename(),
            };
            const first = cue(
                `For the record, ${render(tpl.statement, { ...vars, ...swap })}.`,
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
        } else {
            const block = `The check failed with this:\n\`\`\`\nerror: ${statement}\n\`\`\``;
            conveyed = cue(
                {
                    correction: `Quick correction before you carry on: ${statement}.`,
                    tool_error: f.kind === "tool_error" ? `Heads up, ${statement}` : block,
                    rejected_approach: `We went down another road before and undid it: ${statement}.`,
                    direct_statement: `For the record, ${statement}.`,
                }[manner],
            );
        }
        const startOf = (t: Turn) => sessionOf(t.session).start_ms;
        const opened = startOf(conveyed);
        const later = (p: string) => inWindow(p).filter((x) => x.start_ms > startOf(conveyed));
        if (tpl.update) {
            const text = `One change: ${render(tpl.update, vars)}.`;
            const updatePool = [sessionOf(conveyed.session), ...later(project.id)];
            conveyed = take(
                updatePool.slice(0, Math.max(1, Math.ceil(updatePool.length / 2))),
                after(conveyed),
                { role: "update", text, fact: id },
            );
            fact.cues.push(text);
        }
        facts.push(fact);

        const addProbe = (
            type: string,
            projectId: string,
            text: string,
            check: unknown,
            candidates: Session[],
            at = all,
            factOf: string | null = id,
        ) => {
            const pid = pad("q", probes.length);
            keys.push(pid);
            const t = take(candidates, at, {
                role: "probe",
                text,
                ...(factOf ? { fact: factOf } : {}),
                probe: pid,
            });
            probes.push({
                id: pid,
                type,
                fact: id,
                project: projectId,
                session: t.session,
                text,
                check,
            });
            return t;
        };
        const check = renderDeep(tpl.check, vars);
        const mustNot = { must_not: (check as { must?: string[] }).must ?? [] };
        const probeText = render(tpl.probe, vars);
        const outText = render(tpl.out_probe ?? tpl.probe, vars);
        const fromConveyed = later(project.id);
        if (f.type === "P1") {
            const before = win.filter((x) => x.start_ms < opened);
            addProbe("P1-control", project.id, probeText, check, before, all, null);
            addProbe("P1", project.id, probeText, check, fromConveyed);
            addProbe("P2", project.id, outText, mustNot, fromConveyed);
            addProbe("P11", twinOf(project.id), probeText, mustNot, later(twinOf(project.id)));
        } else if (host) {
            addProbe("P13", project.id, probeText, check, [host], () =>
                range(turnHi - third, turnHi),
            );
        } else if (f.type === "P4") {
            const out = slot % 2 === 1;
            const c = out ? renderDeep(tpl.out_check ?? tpl.check, vars) : check;
            addProbe("P4", project.id, out ? outText : probeText, c, fromConveyed);
        } else if (f.type === "P6") {
            const opening = fromConveyed.filter((x) => !turns.has(key(x.id, 0)));
            const t = addProbe("P6", project.id, probeText, check, opening, () => [0]);
            sessionOf(t.session).min_gap_ms = HOUR;
        } else if (tpl.authority) {
            const [target, ...rest] = fromConveyed;
            const { path, content } = renderDeep(tpl.authority, vars);
            if (target) diffs.push({ session: target.id, path, content, fact: id });
            addProbe(f.type, project.id, probeText, check, rest);
        } else addProbe(f.type, project.id, probeText, check, fromConveyed);
    }
    for (const i of range(0, perType)) {
        const session = p90[i % p90.length] as Session;
        const check = { window_from_turn: Math.floor((2 * session.turn_ms.length) / 3) };
        const { project, id } = session;
        probes.push({
            id: pad("q", probes.length),
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

    const allCues = facts.flatMap((f) => f.cues);
    const pairs = probes.flatMap((p) => {
        const fact = facts.find((f) => f.id === p.fact);
        const text = p.text;
        return fact && text
            ? fact.cues.map((cue) => ({ probe: p.id, fact: fact.id, cue, text }))
            : [];
    });
    const texts = [...new Set(pairs.flatMap((x) => [x.cue, x.text]))];
    const vectors = await input.embedder.embed(texts);
    const vec = new Map(texts.map((t, i) => [t, vectors[i] ?? []]));
    const similarity = pairs.map(({ probe, fact, cue, text }) => ({
        probe,
        fact,
        bm25: bm25Ratio(text, cue, allCues),
        cosine: cosine(vec.get(text) ?? [], vec.get(cue) ?? []),
    }));
    for (const x of similarity) {
        if (x.bm25 > Number(thresholds.bm25_max) || x.cosine > Number(thresholds.cosine_max)) {
            throw new Error(
                `${x.probe}: cue/probe similarity bm25 ${x.bm25}, cosine ${x.cosine} exceeds the pre-registered threshold`,
            );
        }
    }
    const delivered = [...turns.values()].map((t) => [`${t.session}#${t.index}`, t.text]);
    for (const d of diffs)
        delivered.push([`${d.session} diff ${d.path}`, `${d.path}\n${d.content}`]);
    for (const [where, text] of delivered) {
        const hits = markerHits(text ?? "", keys).join(", ");
        if (hits) throw new Error(`${where}: delivered text carries markers ${hits}`);
    }

    sessions.forEach((x, i) => {
        const prev = sessions[i - 1];
        if (prev) x.start_ms = Math.max(x.start_ms, prev.start_ms + lastTurn(prev) + x.min_gap_ms);
    });
    const raw: { at: number; order: number; event: Record<string, unknown> }[] = [];
    for (const session of sessions) {
        const { id, project } = session;
        const at = session.start_ms;
        for (const d of diffs.filter((x) => x.session === id)) {
            raw.push({ at, order: 0, event: { kind: "apply_diff", project, ...d } });
        }
        const forced_p90 = session.forced_p90;
        raw.push({
            at,
            order: 1,
            event: { kind: "session_start", session: id, project, forced_p90 },
        });
        session.turn_ms.forEach((t, i) => {
            raw.push({
                at: at + t,
                order: 2 + i,
                event: { kind: "user_turn", ...turns.get(key(id, i)) },
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
    const probeEvent = new Map(
        events.flatMap((e) =>
            e.kind === "user_turn" && e.probe ? [[e.probe as string, e.id]] : [],
        ),
    );
    for (const p of probes) if (p.text) p.event = probeEvent.get(p.id);
    const lastCue = new Map<unknown, number>();
    events.forEach((e, i) => {
        if (e.fact && e.role !== "probe") lastCue.set(e.fact, i);
    });
    events.forEach((e, i) => {
        if (e.role === "probe" && e.fact && i < (lastCue.get(e.fact) ?? 0)) {
            throw new Error(`${e.id}: probe precedes a conveyance of ${e.fact}`);
        }
    });

    const body = {
        schema: GENERATOR_VERSION,
        manifest: {
            generator_version: GENERATOR_VERSION,
            random_schema_version: 1,
            seed,
            tier: prereg.tier,
            corpus_manifest_sha256: input.corpusManifestSha256,
            embedding_model: input.embedder.model,
            cue_probe_similarity: thresholds,
            within_session_gap_scale: Math.round(withinScale * 1e6) / 1e6,
            between_session_gap_scale: Math.round(gapScale * 1e6) / 1e6,
            probes_per_type: perType,
        },
        projects: input.projects,
        sessions: sessions.map(({ turn_ms, ...x }) => ({ ...x, requests: turn_ms.length })),
        facts,
        probes,
        similarity,
        events,
    };
    return { ...body, scenario_hash: sha256Hex(canonicalJson(body)) };
}

export type Scenario = Awaited<ReturnType<typeof compileScenario>>;
