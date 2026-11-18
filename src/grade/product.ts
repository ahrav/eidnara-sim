import { codeMask, type DiffFile, pattern } from "./text";

/** Source files of the languages whose comments and string literals `codeMask` reads. */
const SOURCE = /\.(?:rs|go|[cm]?[jt]sx?)$/i;
/**
 * Paths of code that checks, measures, or demonstrates the product. A rejected approach a test
 * exercises is named there, and the product is what uses or avoids it (`prereg/G12.json`).
 */
const SUPPORT =
    /(?:^|\/)(?:tests?|__tests__|testdata|benches|bench|benchmarks?|examples?|_examples|fixtures|scripts)\/|_test\.go$|\.(?:test|spec)\.[cm]?[jt]sx?$|_tests?\.rs$/i;

export const isProductPath = (path: string): boolean => SOURCE.test(path) && !SUPPORT.test(path);

const TEST_ATTRIBUTE = /^\s*#\[cfg\((?:all\(\s*)?test\b/;
const ATTRIBUTE = /^\s*#\[/;
const TEST_MODULE = /^\s*(?:pub(?:\([^)\n]*\))?\s+)?mod\s+(?:tests?|\w+_tests?|tests?_\w+)\s*\{/;

/** The added lines of a product file that are product code, as two texts of equal length. */
export interface ProductCode {
    /** The lines with comments blanked. */
    code: string;
    /** The lines with comments and string-literal contents blanked; literal delimiters stay. */
    mask: string;
}

/**
 * The product code a file's hunks add. Each hunk's new-side lines are one stretch of the file,
 * so comments and literals are read over the whole stretch and the added lines are taken from
 * the result. In a Rust file the lines of a test item stay out: the item under a `#[cfg(test)]`
 * attribute and a module named for tests (`mod tests {`), from its first line to the closing
 * brace at the same indentation, across hunks when the brace lies in a later one; a hunk whose
 * header names such a module starts inside it.
 */
export function productCode(file: DiffFile): ProductCode {
    const rust = file.path.endsWith(".rs");
    const code: string[] = [];
    const mask: string[] = [];
    /** The indentation of the open test item, or null outside one. */
    let lead: string | null = null;
    for (const hunk of file.hunks) {
        const text = hunk.lines.map((l) => l.slice(1)).join("\n");
        const bare = codeMask(text, rust, true).split("\n");
        const masked = codeMask(text, rust).split("\n");
        if (rust && lead === null && TEST_MODULE.test(hunk.section)) lead = "";
        let pending = false;
        for (const [i, line] of hunk.lines.entries()) {
            const read = bare[i] ?? "";
            if (rust) {
                if (lead !== null) {
                    if (read.startsWith(`${lead}}`)) lead = null;
                    continue;
                }
                const opens = /\{\s*$/.test(read);
                if (TEST_ATTRIBUTE.test(read)) {
                    pending = true;
                    continue;
                }
                if (pending && (ATTRIBUTE.test(read) || read.trim() === "")) continue;
                if (pending || TEST_MODULE.test(read)) {
                    pending = false;
                    if (opens) lead = /^\s*/.exec(read)?.[0] ?? "";
                    continue;
                }
            }
            if (line.startsWith("+")) {
                code.push(read);
                mask.push(masked[i] ?? "");
            }
        }
    }
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
