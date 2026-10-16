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

function parseDiff(patch: string): { added: string[]; paths: string[]; surviving: string[] } {
    const added: string[] = [];
    const paths: string[] = [];
    const surviving: string[] = [];
    let inHunk = false;
    let current: string | null = null;
    let deleted = false;
    const close = () => {
        if (current !== null && !deleted) surviving.push(current);
        current = null;
        deleted = false;
    };
    for (const line of patch.split("\n")) {
        if (line.startsWith("diff --git ")) {
            close();
            inHunk = false;
            const named =
                /^diff --git ("a\/(?:[^"\\]|\\.)*"|a\/\S+) ("b\/(?:[^"\\]|\\.)*"|b\/.+)$/.exec(
                    line,
                );
            if (named) {
                paths.push(gitPath(named[1] as string), gitPath(named[2] as string));
                current = gitPath(named[2] as string);
            }
        } else if (line.startsWith("@@")) inHunk = true;
        else if (inHunk) {
            if (line.startsWith("+")) added.push(line.slice(1));
        } else if (line.startsWith("+++ /dev/null") || line.startsWith("deleted file mode ")) {
            deleted = true;
        } else if (line.startsWith("+++ b/") || line.startsWith('+++ "b/')) {
            const path = gitPath(line.slice("+++ ".length));
            paths.push(path);
            if (current === null) surviving.push(path);
        }
    }
    close();
    return { added, paths: [...new Set(paths)], surviving: [...new Set(surviving)] };
}

/** A non-empty patch must open as a unified diff; an empty patch is a turn that changed nothing. */
export const unifiedDiff = (v: unknown) =>
    typeof v === "string" && (v.length === 0 || /^(diff --git |--- |\+\+\+ |@@ )/m.test(v));

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
