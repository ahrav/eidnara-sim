import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `scripts/eidnara-build.sh` writes the record after its last build step and removes it before the next. */
export function checkBuildMarker(checkout: string): string {
    let recorded: string;
    try {
        recorded = readFileSync(join(checkout, ".sim-build-commit"), "utf8").trim();
    } catch {
        throw new Error(`${checkout}: no completed build recorded; run scripts/eidnara-build.sh`);
    }
    const head = Bun.spawnSync(["git", "-C", checkout, "rev-parse", "HEAD"], { stdout: "pipe" })
        .stdout.toString()
        .trim();
    if (recorded !== head) {
        throw new Error(`${checkout}: recorded build ${recorded} differs from HEAD ${head}`);
    }
    return recorded;
}
