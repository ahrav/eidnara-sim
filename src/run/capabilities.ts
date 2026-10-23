import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    openSync,
    readdirSync,
    readSync,
} from "node:fs";
import { join } from "node:path";
import { bodyText, injectedBlocks } from "../evidence/stages";
import {
    type ArmProfile,
    AUDITED_EIDNARA,
    armProfile,
    DAEMON_VARIANTS,
    type DaemonVariant,
    deliveryOf,
} from "../hosts/profiles";
import type { ConverseBody } from "../proxy/classify";
import type { CallRecord } from "../proxy/records";
import { type PartLookup, rebuildRequest } from "../proxy/requests";
import { ORACLE_OPENING } from "./oracle-note";

/** The model-call components only the Eidnara plugin and daemon make. */
export const EIDNARA_COMPONENTS = [
    "history_summarizer",
    "memory_capture",
    "memory_classifier",
    "context_researcher",
] as const;

/** What an arm's run evidence shows it ran. */
export interface ArmObservation {
    arm: string;
    host: "pi" | "opencode";
    /**
     * Plugin boots by outcome; Pi's boot line also names whether the transform registered, and a
     * Pi boot line naming neither mode counts as `transform_unknown`.
     */
    boots: {
        enabled: number;
        transform_on: number;
        transform_off: number;
        transform_unknown: number;
        disabled: string[];
    };
    /** Plugin-log lines for a pass the daemon served through the transform. */
    transform_passes: number;
    /**
     * `eidnara_search` results in the host transcripts: the legacy scan's fallback reasons, the
     * successful results the fused route answered (every success without the fallback note), and
     * the results that reported an error; null where the host's transcripts are not read.
     */
    search: { legacy_scan: string[]; fused: number; errored: number } | null;
    /** Proxy call records of the arm, by component. */
    components: Record<string, number>;
    /** What the arm's agent requests carried; null where the run's arms need no request read. */
    delivery?: DeliveryObservation | null;
}

/** An oracle note the arm owes: the probe turn it goes into and the background it quotes. */
export interface ExpectedNote {
    event: string;
    session: string;
    background: string;
    /** The scripted turn text the delivered prompt ends with, after the note. */
    text: string;
    /**
     * False for a turn a resume recovered from the pairing log: the host may have received it, so
     * its note is placed where it appears, but its delivery is not owed.
     */
    owed: boolean;
}

/**
 * The arm's agent request bodies against its delivery mode: how many were read and could not be
 * rebuilt, how many carry a block the Eidnara plugin writes, which owed oracle notes reached the
 * prompt of their own turn, and which requests carry a note outside its session or before its
 * turn, or an opening that matches no owed note.
 */
export interface DeliveryObservation {
    requests: number;
    unreadable: number;
    injected_blocks: number;
    notes: { expected: number; delivered: number; missing: string[]; misplaced: number[] };
}

/** The text blocks of the body's user messages, where a prompt prefix lands. */
const userTexts = (body: ConverseBody) =>
    (body.messages ?? [])
        .filter((m) => m?.role === "user")
        .map((m) =>
            (Array.isArray(m.content) ? m.content : [])
                .map((b) => (typeof b?.text === "string" ? b.text : ""))
                .join("\n"),
        );

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

export function observeDelivery(
    calls: readonly Pick<CallRecord, "seq" | "component" | "session" | "turn" | "request">[],
    parts: PartLookup,
    notes: readonly ExpectedNote[],
    eventIndex: ReadonlyMap<string, number>,
): DeliveryObservation {
    const out: DeliveryObservation = {
        requests: 0,
        unreadable: 0,
        injected_blocks: 0,
        notes: {
            expected: notes.filter((n) => n.owed).length,
            delivered: 0,
            missing: [],
            misplaced: [],
        },
    };
    const delivered = new Set<string>();
    const index = (event: string | null) => eventIndex.get(event ?? "") ?? -1;
    const backgrounds = [...new Set(notes.map((n) => n.background))];
    for (const call of calls) {
        if (call.component !== "agent" || !call.request) continue;
        const body = rebuildRequest(call.request, parts);
        if (!body) {
            out.unreadable++;
            continue;
        }
        out.requests++;
        const text = bodyText(body);
        if (injectedBlocks(text).length > 0) out.injected_blocks++;
        const users = userTexts(body);
        const prompt = [...users].reverse().find((t) => t.length > 0) ?? "";
        for (const n of notes) {
            const opens = prompt.startsWith(n.background);
            if (n.event === call.turn && opens && prompt.trimEnd().endsWith(n.text.trimEnd())) {
                delivered.add(n.event);
            }
        }
        const carried = backgrounds.filter((b) => text.includes(b));
        const due = (b: string) =>
            notes.filter(
                (n) =>
                    n.background === b &&
                    n.session === call.session &&
                    index(n.event) <= index(call.turn),
            ).length;
        const placed = carried.every((b) => due(b) > 0);
        // The agent's own replies may quote a note, so only system and user text count. User-message
        // occurrences count toward owned, capped per background by the matching notes due in the
        // call's session through its turn.
        const entered = bodyText({
            system: body.system,
            messages: (body.messages ?? []).filter((m) => m?.role === "user"),
        });
        const user = users.join("\n");
        const owned = carried.reduce((sum, b) => sum + Math.min(occurrences(user, b), due(b)), 0);
        if (!placed || occurrences(entered, ORACLE_OPENING) > owned) {
            out.notes.misplaced.push(call.seq);
        }
    }
    out.notes.delivered = delivered.size;
    out.notes.missing = notes.filter((n) => n.owed && !delivered.has(n.event)).map((n) => n.event);
    return out;
}

/** Delivery evidence that contradicts the profile; an arm without the observation passes. */
export function deliveryMismatches(profile: ArmProfile, o: DeliveryObservation | null): string[] {
    if (!o) return [];
    const mode = deliveryOf(profile);
    const out: string[] = [];
    const { notes } = o;
    if (o.unreadable > 0) {
        out.push(
            `${o.unreadable} agent request bodies cannot be rebuilt to check ${mode} delivery`,
        );
    }
    if (mode === "oracle-context") {
        if (notes.expected === 0) {
            out.push("the arm reached no probe turn with sources, so it delivered no oracle note");
        }
        if (notes.missing.length > 0) {
            out.push(
                `${notes.missing.length} oracle notes reached no prompt of their own turn: ${notes.missing.join(", ")}`,
            );
        }
    }
    if (mode === "explicit-search" && o.injected_blocks > 0) {
        out.push(
            `${o.injected_blocks} agent requests carry an Eidnara injected block, but the arm declares explicit search alone`,
        );
    }
    if (notes.misplaced.length > 0) {
        const where =
            mode === "oracle-context"
                ? "before its probe turn, in another session, or matching no owed note"
                : `on a ${profile.role} arm`;
        out.push(`agent requests ${notes.misplaced.join(", ")} carry an oracle note ${where}`);
    }
    return out;
}

const CHUNK = 1 << 20;
/** A line longer than this is skipped unread, so one runaway line cannot hold the whole file. */
const MAX_LINE = 16 << 20;

/**
 * Calls `onLine` for each newline-terminated line, and the unterminated tail, from byte `from` of a
 * regular file the agent may have written: the file opens without following a link or blocking,
 * and an absent file reads as empty.
 */
export function eachLine(path: string, onLine: (line: string) => void, from = 0): void {
    let fd: number;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (caught) {
        if ((caught as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new Error(`${path} cannot be read as evidence: ${(caught as Error).message}`);
    }
    try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1) {
            throw new Error(`${path} is not a single-link regular file`);
        }
        const buf = Buffer.alloc(CHUNK);
        let pending: Buffer[] = [];
        let pendingBytes = 0;
        let skipping = false;
        for (let offset = from; ; ) {
            const n = readSync(fd, buf, 0, CHUNK, offset);
            offset += n;
            if (n === 0) break;
            let chunk = buf.subarray(0, n);
            let at = chunk.indexOf(0x0a);
            while (at !== -1) {
                if (!skipping)
                    onLine(Buffer.concat([...pending, chunk.subarray(0, at)]).toString());
                pending = [];
                pendingBytes = 0;
                skipping = false;
                chunk = chunk.subarray(at + 1);
                at = chunk.indexOf(0x0a);
            }
            if (skipping || chunk.length === 0) continue;
            pendingBytes += chunk.length;
            if (pendingBytes > MAX_LINE) {
                pending = [];
                pendingBytes = 0;
                skipping = true;
            } else {
                pending.push(Buffer.from(chunk));
            }
        }
        if (!skipping && pendingBytes > 0) onLine(Buffer.concat(pending).toString());
    } finally {
        closeSync(fd);
    }
}

/** The plugin log's length, the mark a session's own evidence starts from. */
export function logLength(path: string): number {
    return lstatSync(path, { throwIfNoEntry: false })?.size ?? 0;
}

/** Counts plugin boots by outcome and transform passes in one arm's plugin log, from byte `from`. */
export function readPluginLog(
    path: string,
    from = 0,
): Pick<ArmObservation, "boots" | "transform_passes"> {
    const boots = {
        enabled: 0,
        transform_on: 0,
        transform_off: 0,
        transform_unknown: 0,
        disabled: [] as string[],
    };
    let transform_passes = 0;
    eachLine(
        path,
        (line) => {
            if (line.includes("served_from=transform")) {
                transform_passes++;
                return;
            }
            // Pi logs its tool registration once per process; OpenCode logs its conflict check.
            if (line.includes("[eidnara][pi] registered tools:")) {
                boots.enabled++;
                if (line.includes("compaction-off mode")) boots.transform_off++;
                else if (line.includes("eidnara_reduce")) boots.transform_on++;
                else boots.transform_unknown++;
                return;
            }
            if (
                /\[eidnara\] (no conflicts detected|configuration warning), plugin enabled/.test(
                    line,
                )
            ) {
                boots.enabled++;
                return;
            }
            const disabled =
                /\[eidnara\](?:\[pi\])? (disabled due to conflicts: .*|plugin DISABLED.*)$/.exec(
                    line,
                );
            if (disabled) boots.disabled.push((disabled[1] as string).slice(0, 500));
        },
        from,
    );
    return { boots, transform_passes };
}

const FALLBACK =
    /the fused search route is unavailable \(([^)]*)\); results come from the legacy snapshot scan/;

/**
 * The `eidnara_search` results in Pi's session transcripts under `root/rel`, by answering route.
 * The agent can write below `root`, so every component of `rel` must be a real directory, and the
 * walk enters only real subdirectories; an absent directory holds no results.
 */
export function readPiSearches(root: string, rel: string): NonNullable<ArmObservation["search"]> {
    const search = { legacy_scan: [] as string[], fused: 0, errored: 0 };
    let sessionsDir = root;
    for (const part of rel.split("/")) {
        sessionsDir = join(sessionsDir, part);
        const stat = lstatSync(sessionsDir, { throwIfNoEntry: false });
        if (stat === undefined) return search;
        if (!stat.isDirectory()) {
            throw new Error(
                `${sessionsDir} is a link or not a directory; transcripts need a real one`,
            );
        }
    }
    const walk = (dir: string, depth: number) => {
        let names: string[];
        try {
            names = readdirSync(dir);
        } catch {
            return;
        }
        for (const name of names.sort()) {
            const path = join(dir, name);
            const stat = lstatSync(path, { throwIfNoEntry: false });
            if (stat?.isDirectory() && depth > 0) walk(path, depth - 1);
            if (!stat?.isFile() || !name.endsWith(".jsonl")) continue;
            eachLine(path, (line) => {
                if (!line.includes('"eidnara_search"')) return;
                let entry: {
                    message?: {
                        role?: unknown;
                        toolName?: unknown;
                        content?: unknown;
                        isError?: unknown;
                    };
                };
                try {
                    entry = JSON.parse(line);
                } catch {
                    return;
                }
                const m = entry.message;
                if (m?.role !== "toolResult" || m.toolName !== "eidnara_search") return;
                const text = (Array.isArray(m.content) ? m.content : [])
                    .map((c: { text?: unknown }) => (typeof c?.text === "string" ? c.text : ""))
                    .join("\n");
                // The plugin prepends the fallback note to every legacy-scan answer and to no
                // answer the fused route ranked; a refusal is an error result.
                const fallback = FALLBACK.exec(text);
                if (fallback) search.legacy_scan.push(fallback[1] as string);
                else if (m.isError === true || text.startsWith("Error")) search.errored++;
                else search.fused++;
            });
        }
    };
    walk(sessionsDir, 2);
    return search;
}

/**
 * Reads an arm's evidence after its host and daemon stopped: the plugin log at
 * `<armRoot>/eidnara.log`, Pi's transcripts, and the arm's call counts by component.
 */
export function observeArm(
    arm: string,
    host: "pi" | "opencode",
    armRoot: string,
    components: Record<string, number>,
): ArmObservation {
    return {
        arm,
        host,
        ...readPluginLog(join(armRoot, "eidnara.log")),
        search: host === "pi" ? readPiSearches(armRoot, "home/.pi/agent/sessions") : null,
        components: { ...components },
    };
}

/** Plugin boot evidence that contradicts the profile; checkable after any session ends. */
export function bootMismatches(profile: ArmProfile, o: Pick<ArmObservation, "boots">): string[] {
    const { boots } = o;
    if (!profile.plugin) {
        const booted = boots.enabled + boots.disabled.length;
        return booted > 0
            ? [`the Eidnara plugin booted ${booted} times on a ${profile.role} arm`]
            : [];
    }
    const out = boots.disabled.map((why) => `the Eidnara plugin disabled itself: ${why}`);
    if (boots.enabled === 0) out.push("the Eidnara plugin log records no enabled boot");
    if (profile.eidnara_compaction && boots.transform_off > 0) {
        out.push(
            `${boots.transform_off} Pi boots registered no transform, but the arm declares Eidnara compaction on`,
        );
    }
    if (boots.transform_unknown > 0) {
        out.push(
            `${boots.transform_unknown} Pi boots registered tools in no recognised transform mode`,
        );
    }
    if (!profile.eidnara_compaction && boots.transform_on > 0) {
        out.push(
            `${boots.transform_on} Pi boots registered the transform, but the arm declares Eidnara compaction off`,
        );
    }
    return out;
}

/** Every difference between what the arm's profile declares and what its run evidence shows. */
export function armMismatches(o: ArmObservation): string[] {
    const profile = armProfile(o.arm);
    const out = [...bootMismatches(profile, o), ...deliveryMismatches(profile, o.delivery ?? null)];
    const count = (component: string) => o.components[component] ?? 0;
    if (!profile.plugin) {
        for (const c of EIDNARA_COMPONENTS) {
            if (count(c) > 0) out.push(`${count(c)} ${c} calls on a ${profile.role} arm`);
        }
        if (o.transform_passes > 0)
            out.push(`${o.transform_passes} transform passes on a ${profile.role} arm`);
        return out;
    }
    if (profile.eidnara_compaction && count("agent") > 0 && o.transform_passes === 0) {
        out.push(
            `${count("agent")} agent calls and no transform pass, but the arm declares Eidnara compaction on`,
        );
    }
    if (!profile.eidnara_compaction) {
        if (o.transform_passes > 0) {
            out.push(
                `${o.transform_passes} transform passes, but the arm declares Eidnara compaction off`,
            );
        }
        if (count("history_summarizer") > 0) {
            out.push(
                `${count("history_summarizer")} history_summarizer calls, but the arm declares Eidnara compaction off`,
            );
        }
    }
    if (o.search) {
        if (profile.search !== "legacy-scan" && o.search.legacy_scan.length > 0) {
            const reasons = [...new Set(o.search.legacy_scan)].join(", ");
            out.push(
                `${o.search.legacy_scan.length} eidnara_search results came from the legacy snapshot scan (${reasons}), but the arm declares the ${profile.search} route`,
            );
        }
        if (profile.search !== "fused" && o.search.fused > 0) {
            out.push(
                `${o.search.fused} eidnara_search results came from the fused route, but the arm declares ${profile.search}`,
            );
        }
    }
    return out;
}

/**
 * The build clone's copies of every source that fixes a variant's capabilities match those at
 * `AUDITED_EIDNARA`, for each daemon variant the arms run; otherwise the recorded capabilities may
 * describe another daemon than the one built, and the run stops before it starts one.
 */
export function requireAuditedVariants(
    checkout: string,
    arms: readonly string[],
    audited = AUDITED_EIDNARA,
): void {
    const variants = [
        ...new Set(arms.map((a) => armProfile(a).daemon).filter((v) => v !== null)),
    ] as DaemonVariant[];
    if (variants.length === 0) return;
    const git = (args: string[]) =>
        Bun.spawnSync(["git", "-C", checkout, ...args], { stdout: "pipe", stderr: "pipe" });
    if (git(["cat-file", "-e", `${audited}^{commit}`]).exitCode !== 0) {
        throw new Error(
            `${checkout} lacks commit ${audited}, whose source the daemon capabilities in src/hosts/profiles.ts were read from`,
        );
    }
    for (const variant of variants) {
        const { sources } = DAEMON_VARIANTS[variant];
        // Against the working tree, so an uncommitted edit to a source counts as a change too.
        const diff = git(["diff", "--name-only", audited, "--", ...sources]);
        const changed = diff.stdout.toString().trim();
        if (diff.exitCode !== 0 || changed !== "") {
            throw new Error(
                `${variant} capabilities were read at ${audited}, and ${changed || "the comparison"} ${changed ? "changed" : "failed"} since; read them again in src/hosts/profiles.ts`,
            );
        }
    }
}
