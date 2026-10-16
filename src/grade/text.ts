const ABSTAIN =
    /\bUNKNOWN\b|\b(don'?t|do not) (know|have|see)\b|\bnever (settled|decided|discussed|set|mentioned)\b|\bnot (sure|aware)\b|\bno record\b|\bcan(no|')t find\b/i;
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
    return ABSTAIN.test(answer) && !CANDIDATE_VALUE.test(rest) && !HEDGED_GUESS.test(rest);
}

export function pattern(source: string): RegExp {
    return source.startsWith("(?i)") ? new RegExp(source.slice(4), "im") : new RegExp(source, "m");
}

/** Hunk lines and header lines of a unified diff, told apart by position: a header precedes its first `@@`. */
function parseDiff(patch: string): { added: string[]; paths: string[] } {
    const added: string[] = [];
    const paths: string[] = [];
    let inHunk = false;
    for (const line of patch.split("\n")) {
        if (line.startsWith("diff --git ")) {
            inHunk = false;
            const named = / b\/(.+)$/.exec(line);
            if (named) paths.push(named[1] as string);
        } else if (line.startsWith("@@")) inHunk = true;
        else if (inHunk) {
            if (line.startsWith("+")) added.push(line.slice(1));
        } else if (line.startsWith("+++ b/")) paths.push(line.slice("+++ b/".length));
    }
    return { added, paths: [...new Set(paths)] };
}

export function addedLines(patch: string): string {
    return parseDiff(patch).added.join("\n");
}

export function diffPaths(patch: string): string[] {
    return parseDiff(patch).paths;
}

export const matchesAny = (text: string, sources: string[]) =>
    sources.some((s) => pattern(s).test(text));
export const matchesAll = (text: string, sources: string[]) =>
    sources.every((s) => pattern(s).test(text));
