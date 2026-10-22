const SENTINEL = /^\W*UNKNOWN\W*$/i;
const ABSTAIN =
    /\b(don'?t|do not) (know|have|see)\b|\bnever (settled|decided|discussed|set|mentioned)\b|\bnot (sure|aware)\b|\bno record\b|\bcan(no|')t find\b|\b(nobody|no one|no-one|none)\b[^.\n]{0,60}\b(named|assigned|decided|chosen|set|owns|recorded)\b|\b(isn'?t|wasn'?t|hasn'?t been|not been|not) (named|assigned|decided|chosen|recorded)\b|\b(doesn'?t|does not|don'?t|do not) (name|say|record|specify|state)\b/i;
const CANDIDATE_VALUE = /\b\d{5}\b|\b[a-z]+-[a-z]+-\d{2}\b|\b[a-z]{2}-[a-z]+(-[a-z]+)?-\d\b/i;
/** A guess said as one, wherever it sits in the answer. */
const EXPLICIT_GUESS =
    /\b(?:my (?:best )?guess|if I had to (?:guess|pick)|I(?:'d| would) (?:guess|say|bet|go with|pick))\b/i;
/**
 * A sentence that offers a candidate answer under a hedge: a hedged noun for the asked-for thing
 * (`the likely owner`), a hedge right before a highlighted or capitalised value (`probably
 * Ana`, `is probably **Ana**`), or a hedged claim about who or what it is (`I think it's Ana`).
 */
const OFFERS = new RegExp(
    [
        "\\b(?:[Ll]ikely|[Pp]robable|[Pp]ossible)\\s+(?:owner|person|candidate|maintainer|answer|choice|option|location|region|bucket|period|duration|value|name|pick)s?\\b",
        "\\b(?:is|was|would be|'s|are)\\s+(?:probably|likely|presumably|possibly|maybe|perhaps)\\s+(?=[A-Z0-9\"'`*])",
        '\\b(?:[Pp]robably|[Ll]ikely|[Pp]resumably|[Mm]aybe|[Pp]erhaps|[Pp]ossibly)\\s+(?=[`*"]|(?!(?:I|It|Its|The|This|That|These|Those|There|They|We|You|He|She|A|An|If|In|On|At|Some|Any|No|Not)\\b)[A-Z0-9])',
        "\\bI (?:think|believe|suspect|assume|guess)\\s+(?:it'?s|it is|the answer is|that'?s|they|he|she)\\s+(?=[A-Z0-9\"'`*])",
        "\\b(?:[Mm]ight|[Cc]ould) be\\s+(?=[A-Z0-9\"'`*])",
    ].join("|"),
    "g",
);
/** A negation at most two words before an offer, in the same clause, turns the offer down. */
const NEGATED_OFFER = /(?:\b(?:not|no|never|without)\b|n't)(?:[ \t]+[\w-]+){0,2}[ \t]*$/i;

function standalone(token: string): RegExp {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|(?<=[^A-Za-z0-9-]))${escaped}(?=$|[^A-Za-z0-9-])`, "gi");
}

export function carries(text: string, token: string): boolean {
    return standalone(token).test(text);
}

/**
 * Whether a sentence offers a candidate answer under a hedge, an offer the words just before it
 * negate (`not offering a likely candidate`) aside.
 */
const offersGuess = (sentence: string): boolean =>
    [...sentence.matchAll(OFFERS)].some(
        (m) => !NEGATED_OFFER.test(sentence.slice(Math.max(0, m.index - 40), m.index)),
    );

/**
 * The P9 rule (`abstention-without-guess`): the answer abstains, by `UNKNOWN` alone on its first
 * line or by abstention wording, and guesses nothing. A guess is a value-shaped token, one of the
 * item's superseded values, an explicit guess phrase, or a sentence that offers a candidate under a
 * hedge. A hedge that qualifies something other than the answer (`the decision was probably made
 * elsewhere`) is no guess. The subject's own words are left out first, so restating the question
 * is no guess either.
 */
export function abstains(answer: string, subject: string, stale: string[] = []): boolean {
    const rest = subject
        .split(/\s+/)
        .filter((word) => word.length > 0)
        .reduce((text, word) => text.replace(standalone(word), " "), answer);
    const lead = answer.trim().split("\n", 1)[0] ?? "";
    const abstention = SENTINEL.test(lead) || ABSTAIN.test(answer);
    const guess =
        CANDIDATE_VALUE.test(rest) ||
        stale.some((v) => carries(rest, v)) ||
        EXPLICIT_GUESS.test(rest) ||
        sentences(rest).some(offersGuess);
    return abstention && !guess;
}

/** Prose with Markdown emphasis, code marks, headings, bullets, and table bars taken out. */
function plainText(answer: string): string {
    return answer
        .replace(/^\s*```.*$/gm, "\n")
        .replace(/\*\*|__|`/g, "")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
        .replace(/\|/g, " ");
}

/** The answer's sentences: lines, split again after `.`, `!`, or `?` and a space. */
export function sentences(answer: string): string[] {
    return plainText(answer)
        .split(/\n+|(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Tokens of the expected value's shape: letters for letters, the same count of digits for digits. */
const shapeOf = (value: string): RegExp =>
    new RegExp(
        `(?<![A-Za-z0-9-])${value
            .split(/([A-Za-z]+|\d+)/)
            .map((part) =>
                /^[A-Za-z]+$/.test(part)
                    ? "[A-Za-z]+"
                    : /^\d+$/.test(part)
                      ? `\\d{${part.length}}`
                      : escapeRegex(part),
            )
            .join("")}(?![A-Za-z0-9-])`,
        "g",
    );

/** A word that turns down the next value it names within the clause. */
const NEGATOR =
    /\b(?:not|never|no longer|instead of|rather than|other than|except|replac(?:e|es|ed|ing)(?!\s+(?:by|with)\b)|supersed(?:e|es|ed|ing)(?!\s+by\b)|(?:changed|moved|renamed|switched|updated|went)\s+from)\b/gi;
/** A word that marks the value right after it, at most two words on, as superseded. */
const STALE_ADJECTIVE =
    /\b(?:old|older|earlier|previous|previously|prior|former|formerly|originally|retired|outdated|stale|deprecated|obsolete)\b(?=(?:\s+[\w-]+){0,2}?\s+$)/i;
/** What follows a value to say it is wrong or superseded. */
const AFTER =
    /^[^.?!]{0,30}?(?:\b(?:is|was|are|were|'s|is now)\s+(?:not\b|no longer|wrong|invalid|incorrect|stale|outdated|out of date|superseded|retired|obsolete|a typo|impossible)|\b(?:isn'?t|is not|wasn'?t|was not|can'?t be|cannot be|couldn'?t be)\s+(?:a\s+)?(?:valid|right|correct|real|current|usable)\b|\bmarked (?:as )?(?:out of date|stale|superseded|old|obsolete)|^\W*\((?:old|outdated|superseded|retired|stale|previous)\b)/i;
/** A sentence that says the answer cannot be given. */
const DECLINE =
    /\b(?:can(?:no|')t|cannot|couldn'?t|unable to)\s+(?:tell|say|confirm|give|find|determine|know|be sure|pin|verify|recommend)\b|\b(?:don'?t|do not|didn'?t)\s+know\b|\bnot (?:sure|certain)\b|\bunsure\b|\bno record\b|\bunknown\b|\bunclear\b|\bnever (?:settled|recorded|named|given|decided|stated)\b|\b(?:rather not|won'?t|not going to) (?:guess|pick)\b|\bconflict(?:s|ing)?\b|\bcontradict\w*|\bdisagree\b/i;

/** EQUALLY matches wording that signals competition between co-mentioned values. */
const EQUALLY =
    /\b(?:either|conflict\w*|contradict\w*|disagree\w*|two different|which (?:one|of)|both (?:are|were|could|may|might)|equally)\b|\bcan'?t tell which\b/i;

interface Mention {
    token: string;
    at: number;
    expected: boolean;
    negated: boolean;
}

/** Every candidate value a sentence names, in order, with whether the sentence turns it down. */
function mentions(sentence: string, value: string, stale: string[]): Mention[] {
    const found = new Map<number, Mention>();
    const add = (re: RegExp, expected: boolean) => {
        for (const m of sentence.matchAll(re)) {
            const token = m[0];
            const own = token.toLowerCase() === value.toLowerCase();
            if (!found.has(m.index)) {
                found.set(m.index, { token, at: m.index, expected: own, negated: false });
            }
            if (expected && own) (found.get(m.index) as Mention).expected = true;
        }
    };
    add(standalone(value), true);
    add(shapeOf(value), false);
    for (const v of stale) add(standalone(v), false);
    const list = [...found.values()].sort((a, b) => a.at - b.at);
    for (const n of sentence.matchAll(NEGATOR)) {
        const end = n.index + n[0].length;
        const next = list.find((m) => m.at >= end);
        if (next && /^[^.?!,;:()\u2013\u2014]{0,40}$/.test(sentence.slice(end, next.at))) {
            next.negated = true;
        }
    }
    for (const m of list) {
        const before = sentence.slice(0, m.at);
        const after = sentence.slice(m.at + m.token.length);
        if (STALE_ADJECTIVE.test(before) || AFTER.test(after)) m.negated = true;
    }
    return list;
}

/**
 * Why an answer fails to commit to `value` (`committed-whole-word`), or null when it commits. The
 * first sentence naming a candidate value (the expected one, one of its shape, or a superseded
 * one) must assert the expected value as a whole word, not as a question and not turned down
 * (`not X`, `X is wrong`), and no sentence before that point may decline to answer. No sentence
 * that names the value may name a competing value it leaves standing, so an answer that lists the
 * value beside another as equally possible fails; a competitor the sentence marks as replaced or
 * superseded stands aside.
 */
export function uncommitted(answer: string, value: string, stale: string[] = []): string | null {
    if (!carries(answer, value)) return "answer lacks the value";
    const all = sentences(answer).map((s) => ({ s, found: mentions(s, value, stale) }));
    const first = all.findIndex((x) => x.found.length > 0);
    const decisive = all[first];
    if (!decisive) return "answer lacks the value";
    const own = decisive.found.find((m) => m.expected);
    if (!own) return "answer leads with another value";
    const lead = decisive.s.slice(0, own.at);
    if (all.slice(0, first).some((x) => DECLINE.test(x.s)) || DECLINE.test(lead)) {
        return "answer declines before naming the value";
    }
    if (decisive.s.endsWith("?")) return "answer asks instead of answering";
    if (own.negated) return "answer turns the value down";
    const live = (found: Mention[]) => found.some((m) => !m.expected && !m.negated);
    if (live(decisive.found)) return "answer names a competing value beside it";
    for (const { s, found } of all) {
        if (found.some((m) => m.expected && m.negated)) return "answer turns the value down";
        if (found.some((m) => m.expected) && live(found) && EQUALLY.test(s)) {
            return "answer names a competing value beside it";
        }
    }
    return null;
}

/**
 * The heredoc operator at the start of `text`: its length, its delimiter after quote removal, and
 * whether `<<-` strips leading tabs from body lines. The delimiter is one shell word of quoted and
 * unquoted pieces, so `<<'EOF'2`, `<<"$X"`, and `<<\EOF` end at `EOF2`, `$X`, and `EOF`.
 */
export function heredocAt(
    text: string,
): { length: number; delim: string; stripTabs: boolean } | null {
    const m = /^<<(-?)[ \t]*((?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s'"\\<>|&;()])+)/.exec(text);
    if (!m) return null;
    const delim = (m[2] as string).replace(
        /'([^']*)'|"((?:[^"\\]|\\.)*)"|\\(.)/g,
        (_w, single?: string, double?: string, escaped?: string) =>
            single ?? double?.replace(/\\([$`"\\\n])/g, "$1") ?? escaped ?? "",
    );
    return { length: m[0].length, delim, stripTabs: m[1] === "-" };
}

export function pattern(source: string): RegExp {
    return source.startsWith("(?i)") ? new RegExp(source.slice(4), "im") : new RegExp(source, "m");
}

/** Hunk lines and header lines of a unified diff, told apart by position: a header precedes its first `@@`. */
/** A Git header path token with its `a/` or `b/` prefix removed and C-style quoting decoded. */
function gitPath(token: string): string {
    return decodePath(token).replace(/^[ab]\//, "");
}
/** A header path token with C-style quoting decoded; the directories are literal. */
function decodePath(token: string): string {
    const quoted = token.startsWith('"') && token.endsWith('"');
    const raw = quoted ? token.slice(1, -1) : token;
    const bytes: number[] = [];
    const escapes: Record<string, number> = {
        n: 10,
        t: 9,
        r: 13,
        '"': 34,
        "\\": 92,
        a: 7,
        b: 8,
        f: 12,
        v: 11,
    };
    for (let i = 0; i < raw.length; i++) {
        const ch = raw[i] as string;
        if (!quoted || ch !== "\\") {
            bytes.push(...Buffer.from(ch, "utf8"));
            continue;
        }
        const next = raw[i + 1] as string;
        const octal = /^[0-7]{3}/.exec(raw.slice(i + 1));
        if (octal) {
            bytes.push(Number.parseInt(octal[0], 8));
            i += 3;
        } else if (next in escapes) {
            bytes.push(escapes[next] as number);
            i++;
        } else bytes.push(92);
    }
    return Buffer.from(bytes).toString("utf8");
}

const HUNK_HEADER = /^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/;
const FILE_META =
    /^(index |old mode |new mode |deleted file mode |new file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |Binary files |GIT binary patch|literal |delta )/;
/**
 * The two paths of a `diff --git` label read without the file's metadata: quoted, or unquoted and
 * equal (a path with spaces splits at its middle). Unequal unquoted paths wait for the rename, copy,
 * or `---`/`+++` names, which fix the split; whitespace is the last resort.
 */
function labelPaths(rest: string): [string, string] | null {
    const same = /^a\/(.+) b\/\1$/.exec(rest);
    if (same) return [same[1] as string, same[1] as string];
    const quoted = /^("a\/(?:[^"\\]|\\.)*"|a\/\S+) ("b\/(?:[^"\\]|\\.)*"|b\/.+)$/.exec(rest);
    if (!quoted) return null;
    const first = quoted[1] as string;
    const second = quoted[2] as string;
    if (first.startsWith('"') || second.startsWith('"')) return [gitPath(first), gitPath(second)];
    return null;
}
const SPLIT_LABEL = /^a\/(\S+) b\/(.+)$/;
/** `Binary files <old> and <new> differ` names the label's two files, either side `/dev/null` for a creation or deletion. */
function binaryNote(line: string, labelText: string | null): boolean {
    const m = /^Binary files (.+) and (.+) differ$/.exec(line);
    if (!m || labelText === null) return false;
    const a = m[1] as string;
    const b = m[2] as string;
    if (`${a} ${b}` === labelText) return true;
    if (a === "/dev/null") return labelText.startsWith("a/") && labelText.endsWith(` ${b}`);
    if (b === "/dev/null") return labelText.startsWith(`${a} b/`);
    return false;
}

/**
 * A `---`/`+++` header's path: the token before any tab-separated timestamp, decoded, or null for
 * `/dev/null`. Under a `diff --git` label the `a/` and `b/` prefixes are Git's and come off; in a
 * plain patch they are directories.
 */
function headerPath(rest: string, git: boolean): string | null {
    const token = rest.startsWith('"') ? rest : (rest.split("\t")[0] as string);
    if (token === "/dev/null") return null;
    return git ? gitPath(token) : decodePath(token);
}

/** Each metadata line's payload grammar, as `git apply` reads it. */
const META_GRAMMAR: Record<string, RegExp> = {
    index: /^[0-9a-f]{1,64}\.\.[0-9a-f]{1,64}( [0-7]{6})?$/,
    "old mode": /^[0-7]{6}$/,
    "new mode": /^[0-7]{6}$/,
    "deleted file mode": /^[0-7]{6}$/,
    "new file mode": /^[0-7]{6}$/,
    "similarity index": /^(100|[1-9]?\d)%$/,
    "dissimilarity index": /^(100|[1-9]?\d)%$/,
    "rename from": /^.+$/,
    "rename to": /^.+$/,
    "copy from": /^.+$/,
    "copy to": /^.+$/,
    "GIT binary patch": /^$/,
};

/** One file the diff leaves in place: its path, its added lines, and whether the diff creates it. */
export interface DiffFile {
    path: string;
    added: string[];
    created: boolean;
}

interface Scan {
    ok: boolean;
    added: string[];
    paths: string[];
    surviving: string[];
    files: DiffFile[];
}

/**
 * One pass over a unified diff. The scan is strict: every line is a file header, Git file
 * metadata, a hunk header, or a hunk line whose count the header declared, headers come in
 * pairs before their hunks, and each text file carries a hunk. `ok` reports whether the whole
 * payload held to that grammar; the paths and added lines come from the same walk.
 */
function scanDiff(patch: string): Scan {
    const added: string[] = [];
    const paths: string[] = [];
    const surviving: string[] = [];
    const files: DiffFile[] = [];
    let fileAdded: string[] = [];
    let created = false;
    let ok = true;
    let opened = false;
    let pendingNew = false;
    let headersDone = false;
    let oldLeft = 0;
    let newLeft = 0;
    let label: string | null = null;
    /** The unquoted label text awaiting its split, and the names that can fix it. */
    let labelRest: string | null = null;
    let labelText: string | null = null;
    let inFile = false;
    let oldName: string | null = null;
    let operative: string | null = null;
    const from: Record<string, string> = {};
    let deleted = false;
    let hunks = 0;
    /** Where the previous hunk ended in each file, so hunks advance through it. */
    let oldEnd = 0;
    let newEnd = 0;
    const meta = new Set<string>();
    /** Binary payload progress: blocks closed so far and whether a `literal`/`delta` block is open. */
    let binaryBlocks = 0;
    let binaryOpen = false;
    let binaryPayload = false;
    const hunkOpen = () => oldLeft > 0 || newLeft > 0;
    /**
     * A file is complete when it carries a hunk, a `Binary files ... differ` note, two closed
     * binary blocks, a mode pair, a rename or copy pair, or an empty-file creation or deletion
     * with its index line; a file before any header is the empty patch's vacuous start.
     */
    const fileBody = () =>
        !opened ||
        hunks > 0 ||
        meta.has("differ") ||
        (meta.has("binary") && binaryBlocks === 2 && !binaryOpen) ||
        (meta.has("old mode") && meta.has("new mode")) ||
        (meta.has("rename from") && meta.has("rename to")) ||
        (meta.has("copy from") && meta.has("copy to")) ||
        ((meta.has("new file mode") || meta.has("deleted file mode")) && meta.has("index"));
    /** Settles an unquoted label against the file's rename, copy, or header names. */
    const resolveLabel = () => {
        if (labelRest === null) return;
        const candidates: [string | null, string | null][] = [
            [from["rename from"] ?? null, from["rename to"] ?? null],
            [from["copy from"] ?? null, from["copy to"] ?? null],
            [oldName, operative],
        ];
        let pair = candidates.find(
            ([a, b]) => a !== null && b !== null && labelRest === `a/${a} b/${b}`,
        ) as [string, string] | undefined;
        if (!pair) {
            const m = SPLIT_LABEL.exec(labelRest);
            if (m) pair = [m[1] as string, m[2] as string];
        }
        labelRest = null;
        if (!pair) {
            fail();
            return;
        }
        paths.push(pair[0], pair[1]);
        label = pair[1];
    };
    const close = () => {
        resolveLabel();
        const survivor = operative ?? label;
        if (survivor !== null && !deleted) {
            surviving.push(survivor);
            files.push({ path: survivor, added: fileAdded, created });
        }
        fileAdded = [];
        created = false;
        label = null;
        labelText = null;
        inFile = false;
        oldName = null;
        operative = null;
        for (const k of Object.keys(from)) delete from[k];
        deleted = false;
        hunks = 0;
        oldEnd = 0;
        newEnd = 0;
        meta.clear();
        binaryBlocks = 0;
        binaryOpen = false;
        binaryPayload = false;
    };
    const fail = () => {
        ok = false;
    };
    for (const line of patch.replace(/\n$/, "").split("\n")) {
        if (meta.has("binary") && !line.startsWith("diff --git ")) {
            if (binaryOpen) {
                if (line.length === 0) {
                    if (!binaryPayload) fail();
                    binaryOpen = false;
                    binaryBlocks++;
                } else if (/^[A-Za-z][0-9A-Za-z!#$%&()*+\-;<=>?@^_`{|}~]+$/.test(line)) {
                    binaryPayload = true;
                } else fail();
            } else if (/^(literal|delta) \d+$/.test(line) && binaryBlocks < 2) {
                binaryOpen = true;
                binaryPayload = false;
            } else fail();
            if (!ok) break;
            continue;
        }
        if (hunkOpen()) {
            if (line.startsWith("\\")) continue;
            const kind = line[0];
            if (kind === " " || kind === "-") oldLeft--;
            if (kind === " " || kind === "+") newLeft--;
            if (kind === "+") {
                added.push(line.slice(1));
                fileAdded.push(line.slice(1));
            }
            if (!(kind === " " || kind === "+" || kind === "-") || oldLeft < 0 || newLeft < 0) {
                fail();
                break;
            }
            continue;
        }
        if (line.startsWith("\\")) continue;
        if (line.startsWith("diff --git ")) {
            if (!fileBody() || pendingNew) fail();
            const rest = line.slice("diff --git ".length);
            const named = labelPaths(rest);
            close();
            labelText = rest;
            if (named) {
                paths.push(named[0], named[1]);
                label = named[1];
            } else labelRest = rest;
            inFile = true;
            opened = true;
            headersDone = false;
        } else if (line.startsWith("--- ")) {
            if (pendingNew) fail();
            if (headersDone) {
                if (!fileBody()) fail();
                close();
                headersDone = false;
            }
            const old = headerPath(line.slice(4), inFile);
            if (old !== null) paths.push(old);
            else created = true;
            oldName = old;
            opened = true;
            pendingNew = true;
        } else if (line.startsWith("+++ ")) {
            if (!pendingNew) fail();
            const next = headerPath(line.slice(4), inFile);
            if (next === null) deleted = true;
            else {
                paths.push(next);
                operative = next;
            }
            pendingNew = false;
            headersDone = true;
        } else if (HUNK_HEADER.test(line)) {
            if (!opened || pendingNew || !headersDone) fail();
            const m = HUNK_HEADER.exec(line) as RegExpExecArray;
            const oldStart = Number(m[1]);
            const newStart = Number(m[3]);
            oldLeft = m[2] === undefined ? 1 : Number(m[2].slice(1));
            newLeft = m[4] === undefined ? 1 : Number(m[4].slice(1));
            if (oldLeft === 0 && newLeft === 0) fail();
            const oldFrom = oldLeft === 0 ? oldStart + 1 : oldStart;
            const newFrom = newLeft === 0 ? newStart + 1 : newStart;
            if (oldFrom < oldEnd || newFrom < newEnd) fail();
            oldEnd = oldFrom + oldLeft;
            newEnd = newFrom + newLeft;
            hunks++;
        } else if (FILE_META.test(line)) {
            if (pendingNew || headersDone || !inFile) fail();
            const kind = ((FILE_META.exec(line) as RegExpExecArray)[1] as string).trim();
            if (kind === "deleted file mode") deleted = true;
            if (kind === "new file mode") created = true;
            if (kind === "Binary files") {
                if (binaryNote(line, labelText)) meta.add("differ");
                else fail();
            } else if (kind === "literal" || kind === "delta") fail();
            else {
                const payload = line.slice(kind.length).replace(/^ /, "");
                if (!(META_GRAMMAR[kind] as RegExp).test(payload)) fail();
                meta.add(kind === "GIT binary patch" ? "binary" : kind);
                if (/^(rename|copy) (from|to)$/.test(kind)) from[kind] = payload;
            }
        } else {
            fail();
            break;
        }
        if (!ok) break;
    }
    if (hunkOpen() || pendingNew || !fileBody() || !opened) ok = false;
    close();
    return { ok, added, paths: [...new Set(paths)], surviving: [...new Set(surviving)], files };
}

function parseDiff(patch: string): Scan {
    return scanDiff(patch);
}

/** A non-empty patch must scan as a well-formed unified diff; an empty patch is a turn that changed nothing. */
export const unifiedDiff = (v: unknown): boolean =>
    typeof v === "string" && (v.length === 0 || scanDiff(v).ok);

export function addedLines(patch: string): string {
    return parseDiff(patch).added.join("\n");
}

/** Every path a diff names, old and new sides alike. */
export function diffPaths(patch: string): string[] {
    return parseDiff(patch).paths;
}

/** Paths that exist after the diff: the `+++ b/` side of each file, so a deletion names none. */
export function survivingPaths(patch: string): string[] {
    return parseDiff(patch).surviving;
}

/** The files that exist after the diff, each with the lines the diff adds to it. */
export function diffFiles(patch: string): DiffFile[] {
    return parseDiff(patch).files;
}

/**
 * The delimiter of each single- or double-quoted string literal in `lines`. A backtick template
 * is skipped whole, and a `//` comment ends the line's scan.
 */
export function literalQuotes(lines: string[]): ("double" | "single")[] {
    const out: ("double" | "single")[] = [];
    for (const line of lines) {
        for (let i = 0; i < line.length; i++) {
            const ch = line[i] as string;
            if (ch === "/" && line[i + 1] === "/") break;
            if (ch !== '"' && ch !== "'" && ch !== "`") continue;
            let j = i + 1;
            while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
            if (j >= line.length) break;
            if (ch !== "`") out.push(ch === '"' ? "double" : "single");
            i = j;
        }
    }
    return out;
}

export const matchesAny = (text: string, sources: string[]) =>
    sources.some((s) => pattern(s).test(text));
export const matchesAll = (text: string, sources: string[]) =>
    sources.every((s) => pattern(s).test(text));
