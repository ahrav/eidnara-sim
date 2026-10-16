const ABSTAIN =
    /\bUNKNOWN\b|\b(don'?t|do not) (know|have|see)\b|\bnever (settled|decided|discussed|set|mentioned)\b|\bnot (sure|aware)\b|\bno record\b|\bcan(no|')t find\b/i;
const CANDIDATE_VALUE = /\b\d{5}\b|\b[a-z]+-[a-z]+-\d{2}\b/i;
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

export function addedLines(patch: string): string {
    return patch
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .map((l) => l.slice(1))
        .join("\n");
}

export function diffPaths(patch: string): string[] {
    const paths = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1] as string);
    return [...new Set(paths)];
}

export const matchesAny = (text: string, sources: string[]) =>
    sources.some((s) => pattern(s).test(text));
export const matchesAll = (text: string, sources: string[]) =>
    sources.every((s) => pattern(s).test(text));
