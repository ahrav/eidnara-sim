import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config/config";
import { type PathMode, replayProbe } from "../src/replay/replay";
import { runTurn, type TurnSpec } from "../src/replay/turn";

const USAGE = `usage: bun scripts/replay-probe.ts --run <dir> --arm <arm> --item <id> --variant <v> \\
    --repeats N --out <dir> [--allow-identity a,b] [--path-mode source|replay] [--keep]`;

function parse(argv: string[]): Record<string, string | true> {
    const out: Record<string, string | true> = {};
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i] as string;
        if (!key.startsWith("--")) throw new Error(`unexpected argument ${key}\n${USAGE}`);
        const name = key.slice(2);
        if (name === "keep") {
            out.keep = true;
            continue;
        }
        const value = argv[++i];
        if (value === undefined || value.startsWith("--")) {
            throw new Error(`${key} needs a value\n${USAGE}`);
        }
        out[name] = value;
    }
    return out;
}

if (import.meta.main) {
    const args = parse(process.argv.slice(2));
    if (typeof args.turn === "string") {
        const spec = JSON.parse(readFileSync(args.turn, "utf8")) as TurnSpec;
        const result = await runTurn(spec);
        process.exit(result.failures.length > 0 ? 1 : 0);
    }
    const known = new Set([
        "run",
        "arm",
        "item",
        "variant",
        "repeats",
        "out",
        "allow-identity",
        "path-mode",
        "keep",
    ]);
    const unknown = Object.keys(args).filter((k) => !known.has(k));
    if (unknown.length > 0) throw new Error(`unknown option --${unknown[0]}\n${USAGE}`);
    for (const k of ["run", "arm", "item", "variant", "repeats", "out"]) {
        if (typeof args[k] !== "string") throw new Error(`--${k} is required\n${USAGE}`);
    }
    const mode = (args["path-mode"] ?? "source") as string;
    if (mode !== "source" && mode !== "replay") throw new Error(`--path-mode ${mode}\n${USAGE}`);
    const results = await replayProbe({
        config: loadConfig(),
        run: args.run as string,
        arm: args.arm as string,
        item: args.item as string,
        variant: args.variant as string,
        repeats: Number(args.repeats),
        out: args.out as string,
        allowIdentity:
            typeof args["allow-identity"] === "string" ? args["allow-identity"].split(",") : [],
        pathMode: mode as PathMode,
        keep: args.keep === true,
    });
    for (const r of results) {
        const prefix = r.prefix ? (r.prefix.identical ? "identical" : "differs") : "n/a";
        console.log(
            `repeat ${r.repeat}: ${r.verdict} $${r.cost_usd.toFixed(4)} ${r.prompt_ms ?? "-"} ms prefix ${prefix}${r.reason ? ` (${r.reason})` : ""}`,
        );
    }
    process.exit(0);
}
