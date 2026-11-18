import { codeMask, type DiffFile, type DiffHunk, pattern } from "./text";

/** Source files of the languages whose comments and string literals `codeMask` reads. */
const SOURCE = /\.(?:rs|go|[cm]?[jt]sx?)$/i;
/** Whether the path is a source file of a language where `//` opens a comment. */
export const isSourcePath = (path: string): boolean => SOURCE.test(path);
/**
 * Paths of code that checks, measures, or demonstrates the product, and of generated source. A
 * rejected approach a test exercises is named there, and the product is what uses or avoids it
 * (`prereg/G12.json`).
 */
const SUPPORT =
    /(?:^|\/)(?:tests?|__tests__|testdata|benches|bench|benchmarks?|examples?|_examples|fixtures|scripts|generated|testing|test_support|test_utils?|test_helpers?|testutils?)\/|(?:^|\/)(?:test_support|test_utils?|test_helpers?|testutils?)\.[a-z]+$|_test\.go$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/|_)tests?\.rs$|(?:^|\/)zz_generated\.|[._]generated\.|\.pb\.go$/i;

export const isProductPath = (path: string): boolean => SOURCE.test(path) && !SUPPORT.test(path);

const OUTER_ATTRIBUTE = /^\s*#\[([^\]]*)\]\s*/;
/** The operands of a `cfg(all(...))` predicate, split at its top-level commas. */
const operands = (list: string): string[] => {
    const out: string[] = [];
    let depth = 0;
    let from = 0;
    for (const [i, ch] of [...list].entries()) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        else if (ch === "," && depth === 0) {
            out.push(list.slice(from, i).trim());
            from = i + 1;
        }
    }
    return [...out, list.slice(from).trim()];
};
/**
 * The length of the test attribute a line opens with, or 0: `#[cfg(test)]`, `#[cfg(all(...))]`
 * with `test` among its operands, `#[test]`, a runtime's test macro (`#[tokio::test]`), and
 * `#[bench]`.
 */
const testAttribute = (line: string): number => {
    const m = OUTER_ATTRIBUTE.exec(line);
    const inner = m?.[1]?.trim() ?? "";
    const all = /^cfg\(\s*all\((.*)\)\s*\)$/.exec(inner);
    const marks =
        /^cfg\(\s*test\s*\)$/.test(inner) ||
        (all !== null && operands(all[1] ?? "").includes("test")) ||
        /^(?:\w+::)*test(?:\(.*\))?$/.test(inner) ||
        inner === "bench";
    return m && marks ? m[0].length : 0;
};
const ATTRIBUTE = /^\s*#\[/;
const TEST_MODULE = /^\s*(?:pub(?:\([^)\n]*\))?\s+)?mod\s+(?:tests?|\w+_tests?|tests?_\w+)\s*\{/;
const indentOf = (line: string) => /^\s*/.exec(line)?.[0] ?? "";
const END = "end_of_hunk";
/** The line between two stretches of added code that the file holds apart; each stretch is matched on its own. */
const GAP = "\u0000";

/**
 * A hunk's new-side lines with comments blanked (`bare`) and with string contents blanked too
 * (`masked`). The lines are one stretch of the file, so they are read together. A reading that
 * ends inside a block comment the hunk opens stands: the comment closes below the hunk. A
 * reading that ends inside a string holds a quote that is unpaired within the hunk, the opener
 * of a literal that closes below it or the closer of one that opened above it; each line is
 * then read on its own, which keeps code after a stray closing delimiter in the code.
 */
function maskHunk(lines: string[], rust: boolean): { bare: string[]; masked: string[] } {
    const text = lines.join("\n");
    const closes = (suffix: string) => codeMask(`${text}\n${suffix}${END}`, rust).endsWith(END);
    const together = closes("") || closes("*/\n");
    const bare = together
        ? codeMask(text, rust, true).split("\n")
        : lines.map((l) => codeMask(l, rust, true));
    const masked = together
        ? codeMask(text, rust).split("\n")
        : lines.map((l) => codeMask(l, rust));
    // A line that opens with `*/` closes a block comment that opened above the hunk: the lines
    // down to it are comment text.
    const closer = masked.findIndex((l) => /^\s*\*\//.test(l));
    for (let i = 0; i <= closer; i++) {
        const blank = (line: string) =>
            i < closer ? line.replace(/\S/g, " ") : line.replace(/^(\s*)\*\//, "$1  ");
        bare[i] = blank(bare[i] ?? "");
        masked[i] = blank(masked[i] ?? "");
    }
    return { bare, masked };
}

/**
 * Which lines of a Rust hunk are test code, read from the lines with comments and string
 * contents blanked. A test item is the item under a `#[cfg(test)]` attribute or a module named
 * for tests (`mod tests {`). Its header runs to the line that opens its body (a brace left
 * open) or ends it (`;`, or a closed one-line body), and its body runs while lines are blank, indented deeper than the header, or the end
 * of a multi-line literal, through the closing brace at the header's indentation. A hunk whose header section names a test module
 * starts inside one, at column zero. Each hunk is read on its own.
 */
function rustTestLines(lines: string[], section: string): boolean[] {
    /** The indentation of the open test item's header, or null outside a body. */
    let lead: string | null = TEST_MODULE.test(section) ? "" : null;
    /** The indentation of a test item whose header is still open, or null. */
    let header: string | null = null;
    /** A `#[cfg(test)]` attribute awaits its item. */
    let pending = false;
    /**
     * Reads one line of a test item's header. A brace the line leaves open opens the body. A
     * line that ends its statement (`;`) or closes every brace it opens (`fn f() { g() }`) ends
     * the item, and so does a first line that ends a field, a variant, or a match arm (`,`).
     * Any other line continues the header.
     */
    const headerLine = (line: string, indent: string, first: boolean) => {
        header = null;
        const open = (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
        if (open > 0) lead = indent;
        else if (!/[;}]\s*$/.test(line) && !(first && /,\s*$/.test(line))) header = indent;
    };
    return lines.map((line) => {
        const blank = line.trim() === "";
        if (lead !== null) {
            const inner = line.slice(lead.length);
            // A line that opens with a quote ends a multi-line literal of the body.
            if (blank || (line.startsWith(lead) && /^[\s"]/.test(inner))) return true;
            const closes = line.startsWith(lead) && inner.startsWith("}");
            lead = null;
            if (closes) return true;
        }
        if (header !== null) {
            headerLine(line, header, false);
            return true;
        }
        const attribute = testAttribute(line);
        if (attribute > 0) {
            const item = line.slice(attribute);
            pending = item.trim() === "";
            if (!pending) headerLine(item, indentOf(line), true);
            return true;
        }
        if (pending && (ATTRIBUTE.test(line) || blank)) return true;
        if (pending || TEST_MODULE.test(line)) {
            pending = false;
            headerLine(line, indentOf(line), true);
            return true;
        }
        return false;
    });
}

/** The added lines of a product file that are product code, as two texts of equal length. */
export interface ProductCode {
    /** The lines with comments blanked. */
    code: string;
    /** The lines with comments and string-literal contents blanked; literal delimiters stay. */
    mask: string;
}

/**
 * The product code a file's hunks add: its added lines, with comments and literals read over
 * each hunk's new-side lines (`maskHunk`), and in a Rust file without the lines of test items
 * (`rustTestLines`). Added lines that the file holds apart (a context line, a test line, or
 * another hunk lies between them) are joined across a `GAP` line, and `matchesCode` reads each
 * stretch on its own, so a pattern that spans lines matches only lines adjacent in the file.
 */
export function productCode(file: DiffFile): ProductCode {
    return addedCode(file, true);
}

/**
 * The code a file's hunks add, read as `productCode` reads it, with the lines of Rust test items
 * left out when `withoutTests` holds and kept otherwise: a support file's test functions are
 * the code it adds.
 */
export function addedCode(file: DiffFile, withoutTests = false): ProductCode {
    const rust = file.path.endsWith(".rs");
    const code: string[] = [];
    const mask: string[] = [];
    const read = (hunk: DiffHunk) => {
        const { bare, masked } = maskHunk(
            hunk.lines.map((l) => l.slice(1)),
            rust,
        );
        const test = rust && withoutTests ? rustTestLines(masked, hunk.section) : [];
        let adjacent = false;
        for (const [i, line] of hunk.lines.entries()) {
            const product = line.startsWith("+") && !test[i];
            if (product && !adjacent && code.length > 0) {
                code.push(GAP);
                mask.push(GAP);
            }
            adjacent = product;
            if (!product) continue;
            code.push(bare[i] ?? "");
            mask.push(masked[i] ?? "");
        }
    };
    for (const hunk of file.hunks) read(hunk);
    return { code: code.join("\n"), mask: mask.join("\n") };
}

/**
 * Whether some pattern matches product code: a match in the comment-free text that covers at
 * least one character outside string-literal contents. A pattern that names a literal with its
 * quotes (`"math/rand"`) or a keyword before one (`throw '`) therefore matches, and a name that
 * a message or a test title only mentions stays unmatched. Each stretch of adjacent added lines
 * is matched on its own.
 */
export function matchesCode(product: ProductCode, sources: string[]): boolean {
    const masks = product.mask.split(`\n${GAP}\n`);
    const stretches = product.code.split(`\n${GAP}\n`).map((code, i) => [code, masks[i] ?? ""]);
    return sources.some((source) => {
        const re = pattern(source);
        const global = new RegExp(re.source, `${re.flags}g`);
        return stretches.some(([code = "", mask = ""]) => {
            for (const m of code.matchAll(global)) {
                if (/\S/.test(mask.slice(m.index, m.index + m[0].length))) return true;
            }
            return false;
        });
    });
}
