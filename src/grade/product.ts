import { codeMask, type DiffFile, type DiffHunk, pattern } from "./text";

/** Source files of the languages whose comments and string literals `codeMask` reads. */
const SOURCE = /\.(?:rs|go|[cm]?[jt]sx?)$/i;
/**
 * Paths of code that checks, measures, or demonstrates the product. A rejected approach a test
 * exercises is named there, and the product is what uses or avoids it (`prereg/G12.json`).
 */
const SUPPORT =
    /(?:^|\/)(?:tests?|__tests__|testdata|benches|bench|benchmarks?|examples?|_examples|fixtures|scripts)\/|_test\.go$|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/|_)tests?\.rs$/i;

export const isProductPath = (path: string): boolean => SOURCE.test(path) && !SUPPORT.test(path);

const TEST_ATTRIBUTE = /^\s*#\[cfg\((?:all\(\s*)?test\b[^\]]*\]\s*/;
const ATTRIBUTE = /^\s*#\[/;
const TEST_MODULE = /^\s*(?:pub(?:\([^)\n]*\))?\s+)?mod\s+(?:tests?|\w+_tests?|tests?_\w+)\s*\{/;
const indentOf = (line: string) => /^\s*/.exec(line)?.[0] ?? "";
const END = "end_of_hunk";

/**
 * A hunk's new-side lines with comments blanked (`bare`) and with string contents blanked too
 * (`masked`). The lines are one stretch of the file, so they are read together. When that
 * reading ends inside a literal or a comment, a delimiter above or below the hunk is unpaired
 * within it, and each line is read on its own, which keeps code after a stray closing delimiter
 * in the code.
 */
function maskHunk(lines: string[], rust: boolean): { bare: string[]; masked: string[] } {
    const text = lines.join("\n");
    const whole = codeMask(`${text}\n${END}`, rust);
    if (whole.endsWith(END)) {
        return {
            bare: codeMask(text, rust, true).split("\n"),
            masked: whole.slice(0, -(END.length + 1)).split("\n"),
        };
    }
    return {
        bare: lines.map((l) => codeMask(l, rust, true)),
        masked: lines.map((l) => codeMask(l, rust)),
    };
}

/**
 * Which lines of a Rust hunk are test code, read from the lines with comments and string
 * contents blanked. A test item is the item under a `#[cfg(test)]` attribute or a module named
 * for tests (`mod tests {`). Its header runs to the line that opens its body (`{`) or ends it
 * (`;`), and its body runs while lines are blank, indented deeper than the header, or the end
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
    /** Reads one line of a test item's header: its body opens, its statement ends, or it goes on. */
    const headerLine = (line: string, indent: string) => {
        header = null;
        if (/\{\s*$/.test(line)) lead = indent;
        else if (!/;\s*$/.test(line)) header = indent;
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
            headerLine(line, header);
            return true;
        }
        const attribute = TEST_ATTRIBUTE.exec(line);
        if (attribute) {
            const item = line.slice(attribute[0].length);
            if (item.trim() === "") pending = true;
            else headerLine(item, indentOf(line));
            return true;
        }
        if (pending && (ATTRIBUTE.test(line) || blank)) return true;
        if (pending || TEST_MODULE.test(line)) {
            pending = false;
            headerLine(line, indentOf(line));
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
 * (`rustTestLines`).
 */
export function productCode(file: DiffFile): ProductCode {
    const rust = file.path.endsWith(".rs");
    const code: string[] = [];
    const mask: string[] = [];
    const read = (hunk: DiffHunk) => {
        const { bare, masked } = maskHunk(
            hunk.lines.map((l) => l.slice(1)),
            rust,
        );
        const test = rust ? rustTestLines(masked, hunk.section) : [];
        for (const [i, line] of hunk.lines.entries()) {
            if (!line.startsWith("+") || test[i]) continue;
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
 * a message or a test title only mentions stays unmatched.
 */
export function matchesCode(product: ProductCode, sources: string[]): boolean {
    return sources.some((source) => {
        const re = pattern(source);
        for (const m of product.code.matchAll(new RegExp(re.source, `${re.flags}g`))) {
            if (/\S/.test(product.mask.slice(m.index, m.index + m[0].length))) return true;
        }
        return false;
    });
}
