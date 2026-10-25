import { type GradeRecord, runsScript, type SourceEvent } from "../grade/probes";
import type { ConverseBody } from "../proxy/classify";
import type { CallRecord } from "../proxy/records";
import { type RequestPart, rebuildRequest } from "../proxy/requests";
import type { Entry } from "../run/journal";
import { holds } from "../scenario/compile";
import type { SessionHealth } from "./health";
import {
    type ArmData,
    type EvidenceScenario,
    type RunData,
    requestOf,
    type SourceDescriptor,
    type StoreObject,
} from "./load";

export const STAGES_EIDNARA = [
    "source",
    "persisted",
    "eligibility",
    "retrieval",
    "delivery",
    "application",
] as const;
export const STAGES_HOST = ["source", "context", "application"] as const;
export type StageName = (typeof STAGES_EIDNARA)[number] | (typeof STAGES_HOST)[number];

/**
 * `unavailable`: the evidence never existed for the agent. `failed`: it existed and this stage
 * lost it. `unobserved`: the artefact that decides the stage is absent. `excluded`: the grader
 * set the item aside.
 */
export type StageStatus = "ok" | "failed" | "unavailable" | "unobserved" | "excluded" | "n/a";

export interface Pointer {
    path: string;
    at?: string;
}

export interface Stage {
    stage: StageName;
    status: StageStatus;
    reason?: string;
    pointers: Pointer[];
    detail?: Record<string, unknown>;
}

export type Cause = StageName | "compaction-refused" | "context-overflow" | "none";

export interface ProbeEvidence {
    schema: "sim-evidence/v1";
    arm: string;
    memory: boolean;
    item: string;
    probe_type: string;
    session: string | null;
    event: string | null;
    project: string | null;
    verdict: string;
    grade_reason: string | null;
    grade: Pointer;
    expect: string | null;
    present: string[][];
    stale: string[];
    sources: string[];
    stages: Stage[];
    attributed: {
        cause: Cause;
        status: StageStatus | "flagged";
        reason: string;
        pointers?: Pointer[];
    };
    probe_time: Record<string, unknown>;
}

const SKIP_KEYS = new Set([
    "toolUseId",
    "signature",
    "toolConfig",
    "inferenceConfig",
    "cachePoint",
    "role",
    "status",
]);

/** Appends every string `v` carries under `key` to `out`, skipping the keys no model reads as text. */
function collectStrings(v: unknown, key: string, out: string[]): void {
    if (SKIP_KEYS.has(key)) return;
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) for (const x of v) collectStrings(x, key, out);
    else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) collectStrings(x, k, out);
    }
}

/** Every string a body's system blocks and messages carry, one per line. */
export function bodyText(body: ConverseBody): string {
    const out: string[] = [];
    collectStrings(body.system, "system", out);
    collectStrings(body.messages, "messages", out);
    return out.join("\n");
}

/**
 * The strings one stored part contributes to `bodyText`, one per line: a `system` part's, or one
 * message's; every other field adds none.
 */
export function partText(part: RequestPart): string {
    if (part.field !== "system" && part.field !== "messages") return "";
    const out: string[] = [];
    collectStrings(part.value, part.field, out);
    return out.join("\n");
}

/**
 * The text a request put before the model: everything but the assistant messages after the
 * last user prompt, which are the agent's own output in the turn the request continues.
 */
export function contextText(body: ConverseBody): string {
    const messages = body.messages ?? [];
    let prompt = -1;
    messages.forEach((m, i) => {
        const blocks = Array.isArray(m?.content) ? m.content : [];
        if (m?.role === "user" && blocks.some((b) => typeof b?.text === "string")) prompt = i;
    });
    return bodyText({
        ...body,
        messages: messages.filter((m, i) => i <= prompt || m?.role !== "assistant"),
    });
}

interface ToolUse {
    id: string;
    name: string;
    input: unknown;
}

/** The tool uses and tool results a body's messages carry, keyed by tool-use id. */
export function toolTraffic(body: ConverseBody): {
    uses: Map<string, ToolUse>;
    results: Map<string, { text: string; error: boolean }>;
} {
    const uses = new Map<string, ToolUse>();
    const results = new Map<string, { text: string; error: boolean }>();
    for (const m of body.messages ?? []) {
        for (const block of Array.isArray(m?.content) ? m.content : []) {
            const use = block?.toolUse as Partial<ToolUse> & { toolUseId?: string };
            if (use && typeof use.toolUseId === "string") {
                uses.set(use.toolUseId, {
                    id: use.toolUseId,
                    name: String(use.name ?? ""),
                    input: use.input,
                });
            }
            const result = block?.toolResult as
                | { toolUseId?: string; content?: unknown[]; status?: string }
                | undefined;
            if (result && typeof result.toolUseId === "string") {
                results.set(result.toolUseId, {
                    text: bodyText({ messages: [{ role: "user", content: result.content as [] }] }),
                    error: result.status === "error",
                });
            }
        }
    }
    return { uses, results };
}

const FALLBACK =
    /the fused search route is unavailable \(([^)]*)\); results come from the legacy snapshot scan/;

/** The route an `eidnara_search` result reports, with the legacy scan's fallback reason. */
export function searchRoute(text: string, isError: boolean): { route: string; fallback?: string } {
    const fallback = FALLBACK.exec(text);
    if (fallback) return { route: "legacy-scan", fallback: fallback[1] as string };
    if (isError || text.startsWith("Error")) return { route: "errored" };
    return { route: "fused" };
}

const INJECTED =
    /<(project-memory|memory-updates|project-note|eidnara-search-auto|eidnara-search-hint)\b[^>]*>([\s\S]*?)<\/\1>/g;

/** The blocks the Eidnara plugin writes into a request: recalled memory, notes, and auto-search results. */
export function injectedBlocks(text: string): Array<{ tag: string; body: string }> {
    return [...text.matchAll(INJECTED)].map((m) => ({ tag: m[1] as string, body: m[2] as string }));
}

/** The first group alternative each group finds in `text`, or null per group it misses. */
export function findGroups(groups: string[][], text: string): Array<string | null> {
    return groups.map((g) => g.find((alt) => alt.length > 0 && holds(text, alt)) ?? null);
}

/** The 1-based line of `text` where the first found alternative first appears. */
function rankOf(text: string, alts: string[]): number | null {
    const lines = text.split("\n");
    const i = lines.findIndex((l) => alts.some((a) => a.length > 0 && holds(l, a)));
    return i < 0 ? null : i + 1;
}

const callPointer = (c: CallRecord): Pointer => ({ path: "calls.jsonl", at: `seq ${c.seq}` });
const journalPointer = (e: Entry): Pointer => ({ path: "journal.jsonl", at: `seq ${e.seq}` });

interface Context {
    run: RunData;
    arm: ArmData;
    order: Map<string, number>;
    journal: Entry[];
    health: SessionHealth[];
    intact: Map<number, boolean>;
    partTexts: PartTexts;
    useIds: Map<number, string[]>;
    bodies: Map<number, ConverseBody | null>;
}

/** Characters of part text a run keeps between searches. */
const PART_TEXT_CHARS = 256 << 20;

/** The part texts searched last, so the overlapping source windows of a run's probes reuse them. */
class PartTexts {
    private readonly texts = new Map<string, string>();
    private chars = 0;

    get(id: string, part: () => RequestPart | undefined): string | null {
        const hit = this.texts.get(id);
        if (hit !== undefined) {
            this.texts.delete(id);
            this.texts.set(id, hit);
            return hit;
        }
        const found = part();
        if (!found) return null;
        const text = partText(found);
        this.texts.set(id, text);
        this.chars += text.length;
        for (const [old, t] of this.texts) {
            if (this.chars <= PART_TEXT_CHARS || old === id) break;
            this.texts.delete(old);
            this.chars -= t.length;
        }
        return text;
    }
}

interface RunCache {
    intact: Map<number, boolean>;
    partTexts: PartTexts;
    /** Each call's tool-use ids, which every later probe of its session reads. */
    useIds: Map<number, string[]>;
    order: Map<string, number>;
    journal: (arm: string) => Entry[];
    calls: (arm: string) => CallRecord[];
}

const caches = new WeakMap<RunData, RunCache>();

/** Per-run indexes every probe of the run shares, built on first use. */
function cacheOf(run: RunData): RunCache {
    const known = caches.get(run);
    if (known) return known;
    const journals = new Map<string, Entry[]>();
    const calls = new Map<string, CallRecord[]>();
    // An injected fault answered the host locally, so its request reached no model; a slow
    // stream forwarded the request and counts.
    const faultType = new Map(run.faults.map((f) => [f.id, f.type]));
    const reachedModel = (c: CallRecord) =>
        c.fault_ref === null || faultType.get(c.fault_ref) === "slow_stream";
    const cache: RunCache = {
        intact: new Map(),
        partTexts: new PartTexts(),
        useIds: new Map(),
        order: new Map(run.scenario.events.map((e, i) => [e.id, i])),
        journal: (arm) => {
            let mine = journals.get(arm);
            if (!mine) journals.set(arm, (mine = run.journal.filter((e) => e.arm === arm)));
            return mine;
        },
        calls: (arm) => {
            let mine = calls.get(arm);
            if (!mine) {
                mine = run.calls.filter((c) => c.arm === arm && reachedModel(c));
                calls.set(arm, mine);
            }
            return mine;
        },
    };
    caches.set(run, cache);
    return cache;
}

function body(ctx: Context, c: CallRecord): ConverseBody | null {
    if (!ctx.bodies.has(c.seq)) ctx.bodies.set(c.seq, requestOf(ctx.run, c));
    return ctx.bodies.get(c.seq) ?? null;
}

/**
 * Whether the call's recorded body carries one of the group's alternatives, as `findGroups` over
 * its `bodyText` finds it. The body is rebuilt once to check its digest; the search then runs over
 * each part's text in turn, since the lines `bodyText` joins never let a single-line alternative
 * span two parts, so no whole-body text is held. An alternative with a newline is searched in the
 * rebuilt body's text.
 */
function carries(ctx: Context, c: CallRecord, group: string[]): boolean {
    const { parts } = ctx.run;
    const ref = c.request;
    if (!parts || !ref) return false;
    let intact = ctx.intact.get(c.seq);
    if (intact === undefined) {
        intact = rebuildRequest(ref, parts) !== null;
        ctx.intact.set(c.seq, intact);
    }
    if (!intact) return false;
    return group.some((alt) => {
        if (alt.length === 0) return false;
        if (alt.includes("\n")) {
            const b = rebuildRequest(ref, parts);
            return b !== null && holds(bodyText(b), alt);
        }
        return ref.parts.some((id) => {
            const t = ctx.partTexts.get(id, () => parts.get(id));
            return t !== null && t.length > 0 && holds(t, alt);
        });
    });
}

/** Converts a harness wall time to the daemon's clock through the arm's journaled clock offsets. */
function daemonMs(journal: Entry[], wall: number): number {
    let offset = 0;
    for (const e of journal) {
        if (e.offset_s === undefined) continue;
        const settled = Number(e.offset_settled_ms ?? e.offset_wall_ms ?? e.wall_ms);
        if (settled <= wall) offset = Number(e.offset_s ?? 0);
    }
    return wall + offset * 1000;
}

const turnOf = (c: CallRecord) => c.origin_turn ?? c.turn;

/** Each project's daemon scope keys, from the capture jobs' sessions. */
function projectScopes(run: RunData, arm: ArmData): Map<string, Set<string>> {
    const projectOf = new Map(run.scenario.sessions.map((s) => [s.id, s.project]));
    const out = new Map<string, Set<string>>();
    for (const j of arm.captures ?? []) {
        const project = projectOf.get(j.session);
        if (!project) continue;
        const keys = out.get(project) ?? new Set<string>();
        keys.add(j.project);
        out.set(project, keys);
    }
    return out;
}

function inScope(
    o: StoreObject,
    project: string,
    scopes: Map<string, Set<string>>,
): boolean | null {
    if (o.store === "kernel") {
        if (o.scope === null) return null;
        const key = o.scope.replace(/^project:/, "");
        const mine = scopes.get(project);
        if (mine) return mine.has(key);
        for (const keys of scopes.values()) if (keys.has(key)) return false;
        return null;
    }
    if (o.store === "notes") return o.scope?.replace(/\/+$/, "").endsWith(`/${project}`) ?? null;
    return true;
}

type Probe = EvidenceScenario["probes"][number];

function sourceEvents(scenario: EvidenceScenario, probe: Probe): SourceEvent[] {
    const byId = new Map(scenario.events.map((e) => [e.id, e]));
    return (probe.ground_truth?.sources ?? []).map((id) => {
        const e = byId.get(id);
        if (!e) throw new Error(`probe ${probe.id} names source ${id}, which the scenario lacks`);
        return { ...e, session: e.session };
    });
}

/** The evidence path of one graded probe on one arm. */
export function probeEvidence(
    run: RunData,
    armName: string,
    grade: GradeRecord,
    health: SessionHealth[],
): ProbeEvidence {
    const arm = run.arms.get(armName) as ArmData;
    const memory = arm.profile?.plugin === true;
    const probe = run.scenario.probes.find((p) => p.id === grade.item) as Probe;
    const cached = cacheOf(run);
    const { order } = cached;
    const journal = cached.journal(armName);
    const ctx: Context = {
        run,
        arm,
        order,
        journal,
        health,
        intact: cached.intact,
        partTexts: cached.partTexts,
        useIds: cached.useIds,
        // A probe reads its own turn's bodies, and a rebuilt body holds its parts, so the bodies
        // stay with the probe and leave with it.
        bodies: new Map(),
    };
    const gt = probe.ground_truth ?? {};
    const present = (gt.present ?? []).filter((g) => g.length > 0);
    const stale = gt.stale ?? [];
    const sources = sourceEvents(run.scenario, probe);
    // A control or baseline item has no source: the rule's literal must stay out of its context.
    const control = probe.ground_truth !== undefined && sources.length === 0 && present.length > 0;
    const event = probe.event ?? null;
    const session = probe.session ?? null;
    const project = probe.project ?? null;
    const begin = [...journal].reverse().find((e) => e.kind === "BeginTurn" && e.event === event);
    const end = [...journal].reverse().find((e) => e.kind === "EndTurn" && e.event === event);
    const probeOrder = event ? (order.get(event) ?? Infinity) : Infinity;
    const probeText = probe.text ?? "";
    const scrub = (t: string) => (probeText ? t.split(probeText).join("") : t);

    // An injected fault answered the host locally, so its request reached no model; a slow
    // stream forwarded the request and counts.
    const armCalls = cached.calls(armName);
    const turnCalls = armCalls.filter((c) => c.component === "agent" && c.turn === event);
    const projectSessions = new Set(
        run.scenario.sessions.filter((s) => s.project === project).map((s) => s.id),
    );
    // Every probe-turn body must rebuild for a negative answer; one missing leaves it unobserved.
    const bodiesKept =
        run.parts !== null && turnCalls.length > 0 && turnCalls.every((c) => body(ctx, c) !== null);

    // Probe-turn context: what every agent request of the turn carried, the probe text aside.
    const turnTexts = turnCalls.map((c) => {
        const b = body(ctx, c);
        return { c, t: b ? contextText(b) : null };
    });
    // Delivery needs one model request that carried every group at once.
    const whole = turnTexts.find(
        ({ t }) => t !== null && findGroups(present, scrub(t)).every((h) => h !== null),
    );
    const contextHits = present.map((g) => {
        const pick = whole ? [whole] : turnTexts;
        for (const { c, t } of pick) {
            if (t === null) continue;
            const alt = findGroups([g], scrub(t))[0];
            if (alt) return { alt, c };
        }
        return null;
    });
    const absent = (gt.absent ?? []).filter((a) => a.length > 0);
    const forbiddenInContext = absent.filter((a) =>
        turnTexts.some(({ t }) => t !== null && holds(scrub(t), a)),
    );
    const staleInContext = stale.filter((s) =>
        turnTexts.some(({ t }) => t !== null && holds(scrub(t), s)),
    );
    const delivered = bodiesKept && present.length > 0 && whole !== undefined;
    const deliveryStage = (name: "delivery" | "context"): Stage => {
        if (!bodiesKept && present.length > 0) {
            return {
                stage: name,
                status: "unobserved",
                reason: "no recorded request body for the probe turn",
                pointers: turnCalls.map(callPointer),
            };
        }
        if (present.length === 0) {
            return {
                stage: name,
                status: "n/a",
                reason: "the probe names no literal to deliver",
                pointers: [],
                detail: {
                    stale_in_context: staleInContext,
                    forbidden_in_context: forbiddenInContext,
                },
            };
        }
        if (control) {
            const leaked = contextHits.flatMap((h) => (h ? [h] : []));
            return leaked.length > 0
                ? {
                      stage: name,
                      status: "failed",
                      reason: `the rule's literal ${leaked[0]?.alt} reached the probe context, which has no source for it`,
                      pointers: leaked.map((h) => callPointer(h.c)),
                  }
                : {
                      stage: name,
                      status: "ok",
                      reason: "the rule's literal stayed out of the probe context",
                      pointers: turnCalls.map(callPointer),
                  };
        }
        return delivered
            ? {
                  stage: name,
                  status: "ok",
                  pointers: contextHits.map((h) => ({
                      ...callPointer(h?.c as CallRecord),
                      at: `seq ${h?.c.seq} carries ${h?.alt}`,
                  })),
                  detail: {
                      stale_in_context: staleInContext,
                      forbidden_in_context: forbiddenInContext,
                  },
              }
            : {
                  stage: name,
                  status: "failed",
                  reason: contextHits.every((h) => h !== null)
                      ? "each literal reached the probe context, in no single request together"
                      : `no probe-turn request carried ${present
                            .filter((_, i) => contextHits[i] === null)
                            .map((g) => g.join(" | "))
                            .join(", ")}`,
                  pointers: turnCalls.map(callPointer),
                  detail: {
                      stale_in_context: staleInContext,
                      forbidden_in_context: forbiddenInContext,
                  },
              };
    };

    // Source: delivered before the probe, then seen by the model in the project's sessions.
    const sourceStage = (): Stage => {
        // A scenario some of whose probes carry ground truth leaves it off the probe types that
        // trace no literal; one with none predates ground truth.
        if (probe.ground_truth === undefined) {
            const traced = run.scenario.probes.some((p) => p.ground_truth !== undefined);
            return {
                stage: "source",
                status: traced ? "n/a" : "unobserved",
                reason: traced
                    ? "the probe type traces no literal"
                    : "the scenario records no ground truth",
                pointers: [{ path: "scenario.json", at: probe.id }],
            };
        }
        if (sources.length === 0) {
            return {
                stage: "source",
                status: "n/a",
                reason: "control or baseline item; no source by construction",
                pointers: [],
            };
        }
        const beginSeq = begin?.seq ?? Infinity;
        const missing = sources.filter(
            (s) =>
                !journal.some(
                    (e) =>
                        e.kind === "Event" &&
                        e.event === s.id &&
                        e.outcome === "ok" &&
                        e.seq < beginSeq,
                ),
        );
        if (missing.length > 0) {
            return {
                stage: "source",
                status: "unavailable",
                reason: `source event ${missing.map((s) => s.id).join(", ")} not delivered before the probe`,
                pointers: [{ path: "journal.jsonl", at: `Event ${missing[0]?.id}` }],
            };
        }
        const pointers: Pointer[] = sources.map((s) => {
            const e = journal.find((x) => x.kind === "Event" && x.event === s.id);
            return e ? journalPointer(e) : { path: "journal.jsonl" };
        });
        const scripts = sources.filter(
            (e) => e.kind === "apply_diff" && !e.remove && /^#!/.test(e.content ?? ""),
        );
        if (probe.type === "P12" && scripts.length > 0) {
            // The grader's window: user turns of a source turn's session, from the first
            // source turn up to the probe.
            const sourceTurns = sources.filter((s) => s.kind === "user_turn");
            const from = Math.min(...sourceTurns.map((s) => order.get(s.id) ?? Infinity));
            const turns = new Set(
                run.scenario.events
                    .filter((e) => {
                        const at = order.get(e.id) ?? -1;
                        return (
                            e.kind === "user_turn" &&
                            sourceTurns.some((s) => s.session === e.session) &&
                            at >= from &&
                            at < probeOrder
                        );
                    })
                    .map((e) => e.id),
            );
            if (arm.tools === null) {
                return {
                    stage: "source",
                    status: "unobserved",
                    reason: "no tools.jsonl for the arm",
                    pointers,
                };
            }
            const ran = arm.tools.filter(
                (r) =>
                    r.turn !== null &&
                    turns.has(r.turn) &&
                    r.exit !== null &&
                    scripts.some((s) => runsScript(String(s.path))({ ...r, scenario_ms: 0 })),
            );
            if (ran.length === 0) {
                return {
                    stage: "source",
                    status: "unavailable",
                    reason: `check ${scripts.map((s) => s.path).join(", ")} never ran with an exit in its source session`,
                    pointers: [...pointers, { path: `${armName}/tools.jsonl` }],
                };
            }
            pointers.push(
                ...ran.map((r) => ({ path: `${armName}/tools.jsonl`, at: `line ${r.line}` })),
            );
        }
        if (present.length === 0) return { stage: "source", status: "ok", pointers };
        if (run.parts === null) {
            return {
                stage: "source",
                status: "unobserved",
                reason: "the run kept no request bodies",
                pointers,
            };
        }
        const first = Math.min(...sources.map((s) => order.get(s.id) ?? Infinity));
        // Each group's window opens at the earliest source that carries it, so a value seen
        // before the source that conveys it does not count as observed.
        const startOf = (g: string[]) => {
            const carrying = sources.filter(
                (s) => findGroups([g], `${s.text ?? ""}\n${s.content ?? ""}`)[0] !== null,
            );
            return carrying.length === 0
                ? first
                : Math.min(...carrying.map((s) => order.get(s.id) ?? Infinity));
        };
        const inWindow = (c: CallRecord, from: number) => {
            const t = turnOf(c);
            const at = t ? (order.get(t) ?? -1) : -1;
            return (
                c.session !== null &&
                projectSessions.has(c.session) &&
                at >= from &&
                at < probeOrder
            );
        };
        const windowCalls = armCalls.filter((c) => inWindow(c, first));
        const seen = present.map((g) => {
            const from = startOf(g);
            for (const c of windowCalls) {
                if (c.component !== "agent" || !inWindow(c, from)) continue;
                if (carries(ctx, c, g)) return c;
            }
            return null;
        });
        if (present.length > 0 && !seen.every(Boolean)) {
            return {
                stage: "source",
                status: "failed",
                reason: "no model request in the source window carried the literal",
                pointers,
                detail: { window_calls: windowCalls.length },
            };
        }
        pointers.push(...seen.flatMap((c) => (c ? [callPointer(c)] : [])));
        if (!memory) return { stage: "source", status: "ok", pointers };
        const captured = present.map((g) => {
            for (const c of windowCalls) {
                if (
                    !["memory_capture", "history_summarizer", "memory_classifier"].includes(
                        c.component,
                    )
                )
                    continue;
                if (carries(ctx, c, g)) return c;
            }
            return null;
        });
        const stored = persistedHits().map((h) => h.some(existsAt));
        if (!captured.every((c, i) => c !== null || stored[i]) && arm.objects === null) {
            return {
                stage: "source",
                status: "unobserved",
                reason: "no capture request carried the literal, and the store is unreadable",
                pointers,
            };
        }
        if (!captured.every((c, i) => c !== null || stored[i])) {
            return {
                stage: "source",
                status: "failed",
                reason: "observed, and no capture or summarizer request carried the literal",
                pointers,
                detail: {
                    capture_calls: windowCalls.filter((c) => c.component === "memory_capture")
                        .length,
                    ...(arm.profile?.source_capture
                        ? { source_descriptors: sourceDescriptors() }
                        : {}),
                },
            };
        }
        pointers.push(...captured.flatMap((c) => (c ? [callPointer(c)] : [])));
        const descriptors = sourceDescriptors();
        return {
            stage: "source",
            status: "ok",
            pointers,
            ...(descriptors && arm.profile?.source_capture
                ? { detail: { source_descriptors: descriptors } }
                : {}),
        };
    };

    const probeDaemon = begin ? daemonMs(journal, begin.wall_ms) : null;
    /**
     * The source descriptors live at the probe, and those published from the first source event
     * on, by class, on the daemon's clock; null without a readable Kernel store or a probe turn.
     */
    const sourceDescriptors = () => {
        if (arm.descriptors === null || probeDaemon === null) return null;
        const firstWall = Math.min(
            ...sources.flatMap((x) => {
                const e = journal.find((j) => j.kind === "Event" && j.event === x.id);
                return e ? [e.wall_ms] : [];
            }),
        );
        const from = Number.isFinite(firstWall) ? daemonMs(journal, firstWall) : null;
        const byClass = (keep: (d: SourceDescriptor) => boolean) => {
            const out: Record<string, number> = {};
            for (const d of arm.descriptors ?? [])
                if (keep(d)) out[d.class] = (out[d.class] ?? 0) + 1;
            return out;
        };
        const live = (d: SourceDescriptor) =>
            d.created_ms <= probeDaemon && (d.retired_ms === null || d.retired_ms > probeDaemon);
        return {
            at_probe: byClass(live),
            since_source:
                from === null
                    ? null
                    : byClass((d) => d.created_ms >= from && d.created_ms <= probeDaemon),
        };
    };
    const persistedHits = (): StoreObject[][] =>
        present.map((g) => (arm.objects ?? []).filter((o) => findGroups([g], o.text)[0] !== null));
    const existsAt = (o: StoreObject) =>
        probeDaemon !== null && o.created_ms !== null && o.created_ms <= probeDaemon;
    const storePath = (o: StoreObject) =>
        `${armName}/final-store/${o.store === "kernel" ? "kernel.sqlite" : "store.db"}`;
    const objectPointer = (o: StoreObject): Pointer => ({ path: storePath(o), at: o.id });

    const persistedStage = (): Stage => {
        if (present.length === 0) return { stage: "persisted", status: "n/a", pointers: [] };
        if (arm.objects === null || probeDaemon === null) {
            return {
                stage: "persisted",
                status: "unobserved",
                reason:
                    arm.objects === null
                        ? "no final store for the arm"
                        : "the journal has no BeginTurn for the probe",
                pointers: [],
            };
        }
        if (present.length === 0 || control) {
            return {
                stage: "persisted",
                status: "n/a",
                pointers: [],
                detail: { objects: persistedHits().map((h) => h.length) },
            };
        }
        const hits = persistedHits();
        const before = hits.map((h) => h.filter(existsAt));
        if (before.every((h) => h.length > 0)) {
            return {
                stage: "persisted",
                status: "ok",
                pointers: before.map((h) => objectPointer(h[0] as StoreObject)),
                detail: { objects: before.map((h) => h.length) },
            };
        }
        const late = hits.some((h) => h.length > 0);
        return {
            stage: "persisted",
            status: "failed",
            reason: late
                ? "the literal reached the store only after the probe turn began"
                : "no stored memory object carries the literal",
            pointers: hits.flat().slice(0, 5).map(objectPointer),
        };
    };

    const scopes = projectScopes(run, arm);
    const eligibilityStage = (): Stage => {
        if (present.length === 0) return { stage: "eligibility", status: "n/a", pointers: [] };
        if (arm.objects === null || probeDaemon === null) {
            return { stage: "eligibility", status: "unobserved", pointers: [] };
        }
        const created = new Map((arm.objects ?? []).map((o) => [o.id, o.created_ms]));
        // A successor written after the probe began had not yet replaced the object then.
        const replaced = (o: StoreObject) => {
            if (o.superseded_by === null || probeDaemon === null) return false;
            const at = created.get(o.superseded_by);
            if (at === undefined || at === null) {
                return o.retired_ms !== null && o.retired_ms <= probeDaemon;
            }
            return at <= probeDaemon;
        };
        const live = (o: StoreObject) =>
            probeDaemon !== null &&
            (o.retired_ms === null || o.retired_ms > probeDaemon) &&
            !replaced(o);
        const per = persistedHits().map((h) => h.filter(existsAt));
        const eligible = per.map((h) =>
            h.filter((o) => live(o) && inScope(o, project ?? "", scopes) === true),
        );
        const staleEligible = (arm.objects ?? [])
            .filter(
                (o) =>
                    existsAt(o) &&
                    live(o) &&
                    inScope(o, project ?? "", scopes) === true &&
                    stale.some((s) => holds(o.text, s)),
            )
            .map((o) => o.id);
        if (control) {
            const leaked = eligible.flat();
            return leaked.length > 0
                ? {
                      stage: "eligibility",
                      status: "failed",
                      reason: `${leaked[0]?.id} carries the rule's literal and is eligible in ${project}, which has no source for it`,
                      pointers: leaked.slice(0, 5).map(objectPointer),
                  }
                : { stage: "eligibility", status: "ok", pointers: [] };
        }
        if (eligible.every((h) => h.length > 0)) {
            return {
                stage: "eligibility",
                status: "ok",
                pointers: eligible.map((h) => objectPointer(h[0] as StoreObject)),
                detail: { stale_eligible: staleEligible },
            };
        }
        const unknown = per.flat().some((o) => inScope(o, project ?? "", scopes) === null);
        const reasons = per
            .flat()
            .map((o) =>
                !live(o)
                    ? `${o.id} retired or superseded`
                    : inScope(o, project ?? "", scopes) === false
                      ? `${o.id} scoped to another project`
                      : `${o.id} scope unknown`,
            );
        return {
            stage: "eligibility",
            status:
                unknown && reasons.every((r) => r.endsWith("unknown")) ? "unobserved" : "failed",
            reason: reasons.slice(0, 3).join("; "),
            pointers: per.flat().slice(0, 5).map(objectPointer),
            detail: { stale_eligible: staleEligible },
        };
    };

    // Retrieval: what Eidnara's tools returned in the turn and what the plugin wrote into it.
    const searches: Array<Record<string, unknown>> = [];
    const retrievalStage = (): Stage => {
        const before = new Set<string>();
        for (const c of armCalls) {
            if (c.component !== "agent" || c.session !== session) continue;
            if ((order.get(c.turn ?? "") ?? -1) >= probeOrder) continue;
            let ids = ctx.useIds.get(c.seq);
            if (!ids) {
                const b = body(ctx, c);
                ids = b ? [...toolTraffic(b).uses.keys()] : [];
                ctx.useIds.set(c.seq, ids);
            }
            for (const id of ids) before.add(id);
        }
        const uses = new Map<string, ToolUse>();
        const results = new Map<string, { text: string; error: boolean }>();
        for (const { c } of turnTexts) {
            const b = body(ctx, c);
            if (!b) continue;
            const traffic = toolTraffic(b);
            for (const [id, u] of traffic.uses) if (!before.has(id)) uses.set(id, u);
            for (const [id, r] of traffic.results) results.set(id, r);
        }
        const candidates: Array<{ source: string; text: string; pointer: Pointer }> = [];
        for (const u of uses.values()) {
            if (!u.name.startsWith("eidnara_")) continue;
            const t = arm.transcripts?.get(u.id);
            const returned = t ? { text: t.text, error: t.isError } : results.get(u.id);
            const route =
                u.name === "eidnara_search" && returned
                    ? searchRoute(returned.text, returned.error)
                    : null;
            searches.push({
                tool: u.name,
                id: u.id,
                input: u.input,
                ...(route ?? {}),
                returned_from: t ? "transcript" : returned ? "request" : null,
                delivered: results.has(u.id),
            });
            // An errored result can echo the query, which is no evidence the search found.
            if (returned && !returned.error && route?.route !== "errored") {
                candidates.push({
                    source: u.name,
                    text: returned.text,
                    pointer: t
                        ? { path: t.file, at: `toolCallId ${u.id}` }
                        : { path: "requests.jsonl", at: `toolResult ${u.id}` },
                });
            }
        }
        for (const { c, t } of turnTexts) {
            if (t === null) continue;
            for (const block of injectedBlocks(t)) {
                candidates.push({
                    source: `<${block.tag}>`,
                    text: block.body,
                    pointer: { ...callPointer(c), at: `seq ${c.seq} <${block.tag}>` },
                });
            }
        }
        // The probe turn's tool uses come from its request bodies; without them no transcript
        // result can be tied to the turn.
        if (present.length === 0) {
            return { stage: "retrieval", status: "n/a", pointers: [], detail: { searches } };
        }
        if (!bodiesKept) {
            return {
                stage: "retrieval",
                status: "unobserved",
                reason: "no recorded request body for the probe turn",
                pointers: [],
            };
        }
        const hits = present.map((g) => {
            for (const cand of candidates) {
                const rank = rankOf(cand.text, g);
                if (rank !== null) return { cand, rank };
            }
            return null;
        });
        if (control) {
            const leaked = hits.flatMap((h) => (h ? [h] : []));
            return leaked.length > 0
                ? {
                      stage: "retrieval",
                      status: "failed",
                      reason: `${leaked[0]?.cand.source} returned the rule's literal in a turn with no source for it`,
                      pointers: leaked.map((h) => h.cand.pointer),
                      detail: { searches },
                  }
                : { stage: "retrieval", status: "ok", pointers: [], detail: { searches } };
        }
        if (hits.every(Boolean)) {
            return {
                stage: "retrieval",
                status: "ok",
                pointers: hits.map((h) => h?.cand.pointer as Pointer),
                detail: {
                    searches,
                    ranks: hits.map((h) => ({ source: h?.cand.source, line: h?.rank })),
                },
            };
        }
        return {
            stage: "retrieval",
            status: "failed",
            reason:
                candidates.length === 0
                    ? "no Eidnara search result or injected memory in the probe turn"
                    : `${candidates.length} Eidnara result(s) in the probe turn, none with the literal`,
            pointers: candidates.slice(0, 5).map((c) => c.pointer),
            detail: { searches },
        };
    };

    const gradePointer: Pointer = {
        path: "grades.jsonl",
        at: `${grade.item}/${grade.arm} v${grade.version}`,
    };
    const held = control ? grade.verdict === "fail" : grade.verdict === "pass";
    const applicationStage: Stage = {
        stage: "application",
        status: grade.verdict === "excluded" ? "excluded" : held ? "ok" : "failed",
        ...(grade.reason ? { reason: control ? `control: ${grade.reason}` : grade.reason } : {}),
        pointers: [gradePointer, { path: `${armName}/snapshots.jsonl`, at: grade.snapshot }],
    };

    const stages: Stage[] = memory
        ? [
              sourceStage(),
              persistedStage(),
              eligibilityStage(),
              retrievalStage(),
              deliveryStage("delivery"),
              applicationStage,
          ]
        : [sourceStage(), deliveryStage("context"), applicationStage];

    const sessionRow = health.find((h) => h.arm === armName && h.session === session);
    const flagged =
        sessionRow?.cause && sessionRow.flagged_from !== null
            ? (order.get(sessionRow.flagged_from) ?? Infinity) <= probeOrder
            : false;
    const attributed = attribute(stages, {
        verdict: grade.verdict,
        memory,
        controls: control,
        delivered,
        staleOnly: present.length > 0 && staleInContext.length > 0 && !delivered,
        flagged: flagged ? (sessionRow as SessionHealth) : null,
    });

    const openJobs = new Map<string, Entry>();
    for (const e of journal) {
        if (begin && e.seq >= begin.seq) break;
        if (e.kind === "RegisterJob") openJobs.set(String(e.job), e);
        if (e.kind === "EndJob") openJobs.delete(String(e.job));
    }
    const pendingCaptures =
        probeDaemon === null || arm.captures === null
            ? null
            : arm.captures.filter(
                  (j) =>
                      j.created_ms <= probeDaemon &&
                      (j.committed_ms === null || j.committed_ms > probeDaemon) &&
                      (j.abandoned_ms === null || j.abandoned_ms > probeDaemon),
              );
    const sessionTag = session ? `[sim-${session}]` : null;
    const passes =
        arm.pluginLog && sessionTag
            ? arm.pluginLog.filter((l) => l.includes(sessionTag) && l.includes("rust pass:")).length
            : null;
    const background = armCalls.filter(
        (c) => c.component !== "agent" && c.component !== "user-sim" && turnOf(c) === event,
    );
    const probe_time = {
        begin: begin ? journalPointer(begin) : null,
        begin_wall_ms: begin?.wall_ms ?? null,
        end: end ? journalPointer(end) : null,
        turn_outcome: end?.outcome ?? null,
        prompt_ms: end?.prompt_ms ?? null,
        agent_calls: turnCalls.map((c) => c.seq),
        tool_runs: (arm.tools ?? [])
            .filter((r) => r.turn === event && r.exit !== null)
            .map((r) => ({ line: r.line, command: r.command.slice(0, 200), exit: r.exit })),
        searches,
        open_jobs: [...openJobs.keys()],
        pending_captures:
            pendingCaptures === null
                ? null
                : {
                      all: pendingCaptures.length,
                      project: pendingCaptures.filter((j) =>
                          (scopes.get(project ?? "") ?? new Set()).has(j.project),
                      ).length,
                  },
        store_objects: arm.objects === null ? null : arm.objects.filter(existsAt).length,
        source_descriptors: memory ? sourceDescriptors() : null,
        transform_passes_in_session: passes,
        background_calls: background.map((c) => ({ seq: c.seq, component: c.component })),
        session_health: sessionRow
            ? { cause: sessionRow.cause, flagged_from: sessionRow.flagged_from }
            : null,
    };

    return {
        schema: "sim-evidence/v1",
        arm: armName,
        memory,
        item: grade.item,
        probe_type: grade.probe_type,
        session,
        event,
        project,
        verdict: grade.verdict,
        grade_reason: grade.reason ?? null,
        grade: gradePointer,
        expect: gt.expect ?? null,
        present,
        stale,
        sources: sources.map((s) => s.id),
        stages,
        attributed,
        probe_time,
    };
}

/**
 * One cause per item. A flagged session wins over every stage; a literal in the probe context
 * makes the item an application failure; otherwise the first stage that did not hold.
 */
export function attribute(
    stages: Stage[],
    o: {
        verdict: string;
        memory: boolean;
        controls: boolean;
        delivered: boolean;
        staleOnly: boolean;
        flagged: SessionHealth | null;
    },
): ProbeEvidence["attributed"] {
    const reach: StageName = o.memory ? "delivery" : "context";
    const at = (name: StageName) => stages.find((s) => s.stage === name);
    if (o.verdict === "excluded") {
        // An item set aside because its evidence never existed (a P12 check that never ran)
        // names that stage; any other exclusion stays the grader's.
        const missing = stages.find((s) => s.status === "unavailable");
        if (missing)
            return { cause: missing.stage, status: "unavailable", reason: missing.reason ?? "" };
        const app = at("application") as Stage;
        return { cause: "application", status: "excluded", reason: app.reason ?? "excluded" };
    }
    if (o.controls) {
        // A control's grade passes when the agent applied the rule with no source for it.
        if (o.verdict !== "pass") {
            return {
                cause: "none",
                status: "ok",
                reason: "control: the rule stays unapplied without its source",
            };
        }
        const ctx = at(reach);
        if (ctx?.status === "unobserved") {
            return { cause: reach, status: "unobserved", reason: ctx.reason ?? "unobserved" };
        }
        if (ctx?.status === "failed") {
            return {
                cause: o.memory ? "eligibility" : "context",
                status: "failed",
                reason: ctx.reason ?? "the rule reached the probe context with no source in scope",
            };
        }
        return {
            cause: "application",
            status: "failed",
            reason: "control: the rule was applied with no source in the probe context",
        };
    }
    if (o.verdict === "pass") return { cause: "none", status: "ok", reason: "passed" };
    if (o.flagged?.cause) {
        const mark =
            o.flagged.cause === "compaction-refused"
                ? o.flagged.first_refused
                : o.flagged.first_overflow;
        return {
            cause: o.flagged.cause,
            status: "flagged",
            reason: `session ${o.flagged.session} from ${o.flagged.flagged_from}: ${mark?.why ?? ""} (calls.jsonl seq ${mark?.seq})`,
            pointers: [
                ...(mark ? [{ path: "calls.jsonl", at: `seq ${mark.seq}` }] : []),
                { path: "evidence-sessions.jsonl", at: `${o.flagged.arm}/${o.flagged.session}` },
            ],
        };
    }
    if (o.staleOnly) {
        return {
            cause: o.memory ? "eligibility" : "context",
            status: "failed",
            reason: "a superseded value reached the probe context and the current one did not",
        };
    }
    if (o.delivered) {
        const app = at("application") as Stage;
        return { cause: "application", status: app.status, reason: app.reason ?? o.verdict };
    }
    for (const s of stages) {
        if (s.status === "ok" || s.status === "n/a") continue;
        return { cause: s.stage, status: s.status, reason: s.reason ?? s.status };
    }
    const app = at("application") as Stage;
    return { cause: "application", status: app.status, reason: app.reason ?? o.verdict };
}

/** Every graded probe of every arm, P7 pairwise grades aside. */
export function runEvidence(run: RunData, health: SessionHealth[]): ProbeEvidence[] {
    const probes = new Set(run.scenario.probes.map((p) => p.id));
    return run.grades
        .filter((g) => g.against === undefined && probes.has(g.item) && run.arms.has(g.arm))
        .sort((a, b) => (a.arm + a.item < b.arm + b.item ? -1 : 1))
        .map((g) => probeEvidence(run, g.arm, g, health));
}
