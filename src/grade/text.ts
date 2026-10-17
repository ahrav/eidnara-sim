const SENTINEL = /^\W*UNKNOWN\W*$/i;
const ABSTAIN =
    /\b(don'?t|do not) (know|have|see)\b|\bnever (settled|decided|discussed|set|mentioned)\b|\bnot (sure|aware)\b|\bno record\b|\bcan(no|')t find\b/i;
const CANDIDATE_VALUE = /\b\d{5}\b|\b[a-z]+-[a-z]+-\d{2}\b|\b[a-z]{2}-[a-z]+(-[a-z]+)?-\d\b/i;
const HEDGED_GUESS =
    /\b(probably|maybe|perhaps|likely|possibly|presumably|my (best )?guess|if I had to guess|I('d| would) (guess|say)|I (think|guess|believe|suspect|assume)|might be|could be)\b/i;

function standalone(token: string): RegExp {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|(?<=[^A-Za-z0-9-]))${escaped}(?=$|[^A-Za-z0-9-])`, "gi");
}

export function carries(text: string, token: string): boolean {
    return standalone(token).test(text);
}

export function abstains(answer: string, subject: string): boolean {
    const rest = subject
        .split(/\s+/)
        .filter((word) => word.length > 0)
        .reduce((text, word) => text.replace(standalone(word), " "), answer);
    const lead = answer.trim().split("\n", 1)[0] ?? "";
    const abstention = SENTINEL.test(lead) || ABSTAIN.test(answer);
    return abstention && !CANDIDATE_VALUE.test(rest) && !HEDGED_GUESS.test(rest);
}

export function pattern(source: string): RegExp {
    return source.startsWith("(?i)") ? new RegExp(source.slice(4), "im") : new RegExp(source, "m");
}

/** Hunk lines and header lines of a unified diff, told apart by position: a header precedes its first `@@`. */
/** A Git header path token with its `a/` or `b/` prefix removed and C-style quoting decoded. */
function gitPath(token: string): string {
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
    return Buffer.from(bytes)
        .toString("utf8")
        .replace(/^[ab]\//, "");
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

/** A `---`/`+++` header's path: the token before any tab-separated timestamp, decoded, or null for `/dev/null`. */
function headerPath(rest: string): string | null {
    const token = rest.startsWith('"') ? rest : (rest.split("\t")[0] as string);
    if (token === "/dev/null") return null;
    return gitPath(token);
}

interface Scan {
    ok: boolean;
    added: string[];
    paths: string[];
    surviving: string[];
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
        if (survivor !== null && !deleted) surviving.push(survivor);
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
            if (kind === "+") added.push(line.slice(1));
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
            const old = headerPath(line.slice(4));
            if (old !== null) paths.push(old);
            oldName = old;
            opened = true;
            pendingNew = true;
        } else if (line.startsWith("+++ ")) {
            if (!pendingNew) fail();
            const next = headerPath(line.slice(4));
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
            if (kind === "Binary files") {
                if (binaryNote(line, labelText)) meta.add("differ");
                else fail();
            } else if (kind === "GIT binary patch") meta.add("binary");
            else if (kind === "literal" || kind === "delta") fail();
            else {
                meta.add(kind);
                if (/^(rename|copy) (from|to)$/.test(kind))
                    from[kind] = line.slice(kind.length + 1);
            }
        } else {
            fail();
            break;
        }
        if (!ok) break;
    }
    if (hunkOpen() || pendingNew || !fileBody() || !opened) ok = false;
    close();
    return { ok, added, paths: [...new Set(paths)], surviving: [...new Set(surviving)] };
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

export const matchesAny = (text: string, sources: string[]) =>
    sources.some((s) => pattern(s).test(text));
export const matchesAll = (text: string, sources: string[]) =>
    sources.every((s) => pattern(s).test(text));
