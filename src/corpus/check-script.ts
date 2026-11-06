/** A Python source with its comments and string literals blanked to spaces, line breaks kept. */
export function pythonCode(source: string): string {
    const out = source.split("");
    const wipe = (from: number, to: number) => {
        for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
    };
    let i = 0;
    while (i < source.length) {
        const ch = source[i] as string;
        if (ch === "#") {
            const end = source.indexOf("\n", i);
            const stop = end < 0 ? source.length : end;
            wipe(i, stop);
            i = stop;
        } else if (ch === '"' || ch === "'") {
            const triple = source.startsWith(ch.repeat(3), i);
            const close = triple ? ch.repeat(3) : ch;
            let j = i + close.length;
            while (j < source.length && !source.startsWith(close, j)) {
                if (!triple && source[j] === "\n") break;
                j += source[j] === "\\" ? 2 : 1;
            }
            const stop = Math.min(j, source.length);
            wipe(i, Math.min(stop + close.length, source.length));
            i = stop + close.length;
        } else i++;
    }
    return out.join("");
}

/**
 * Whether a Python check script defines a class the pattern `named` matches and raises it, read
 * from its code with comments and string literals blanked, each at the start of a statement.
 */
export function definesAndRaises(script: string, named: string): boolean {
    const code = pythonCode(script);
    const defined = new RegExp(`^[ \\t]*class\\s+(?:${named})\\s*[(:]`, "m").test(code);
    const raised = new RegExp(`^[ \\t]*raise\\s+(?:${named})\\s*\\(`, "m").test(code);
    return defined && raised;
}
