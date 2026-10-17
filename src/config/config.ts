import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ENV_KEY, PLAIN_PATH } from "../run/launcher";

export const CONFIG_SCHEMA = "sim-config/v2";

/** Paths the runtime reads; `scripts/eidnara-build.sh` is the one writer of the build clone. */
export interface SimConfig {
    schema: typeof CONFIG_SCHEMA;
    eidnara_checkout: string;
    daemon_binary: string;
    pi_install: string;
    opencode_binary: string;
    /** The next pinned host versions a `host_upgrade` fault moves later sessions to. */
    upgrade?: { pi_install?: string; opencode_binary?: string };
    agent_model: string;
    /** Build tools the agent runs inside the sandbox: `bin` joins PATH, `keep` stays visible. */
    toolchain: {
        bin: string[];
        keep: string[];
        env: Record<string, string>;
        wall_clock_tools: string[];
    };
    bedrock: { aws_profile: string; region: string };
}

const PATH_FIELDS = ["eidnara_checkout", "daemon_binary", "pi_install", "opencode_binary"] as const;

export class ConfigError extends Error {}

/** Variables that name tool homes and caches; a variable that selects an executable would bypass preflight. */
const TOOLCHAIN_ENV = ["CARGO_HOME", "RUSTUP_HOME", "BUN_INSTALL_CACHE_DIR"];

/** The default config file at the sim tree root, overridable by a non-empty `SIM_CONFIG`. */
export function defaultConfigPath(): string {
    return process.env.SIM_CONFIG || resolve(import.meta.dir, "../../sim.config.json");
}

/** Parses and shape-checks a config value; every path must be absolute. */
export function parseConfig(value: unknown): SimConfig {
    if (typeof value !== "object" || value === null) throw new ConfigError("config: not an object");
    const v = value as Record<string, unknown>;
    if (v.schema !== CONFIG_SCHEMA)
        throw new ConfigError(`config.schema: expected ${CONFIG_SCHEMA}`);
    for (const field of PATH_FIELDS) {
        const path = v[field];
        if (typeof path !== "string" || path === "") {
            throw new ConfigError(`config.${field}: missing`);
        }
        if (!isAbsolute(path)) throw new ConfigError(`config.${field}: not an absolute path`);
        if (resolve(path) !== path) {
            throw new ConfigError(`config.${field}: not a normalized absolute path`);
        }
        if (!PLAIN_PATH.test(path)) {
            throw new ConfigError(
                `config.${field}: not a plain path the sandbox launcher can pass`,
            );
        }
    }
    const upgrade = (v.upgrade ?? {}) as Record<string, unknown>;
    for (const field of ["pi_install", "opencode_binary"] as const) {
        const path = upgrade[field];
        if (path !== undefined && (typeof path !== "string" || !isAbsolute(path))) {
            throw new ConfigError(`config.upgrade.${field}: not an absolute path`);
        }
    }
    if (typeof v.agent_model !== "string" || v.agent_model === "") {
        throw new ConfigError("config.agent_model: missing");
    }
    const toolchain = v.toolchain as Record<string, unknown> | undefined;
    for (const field of ["bin", "keep"] as const) {
        const paths = toolchain?.[field];
        if (!Array.isArray(paths) || !paths.every((x) => typeof x === "string" && isAbsolute(x))) {
            throw new ConfigError(`config.toolchain.${field}: expected absolute paths`);
        }
        if (!paths.every((x) => resolve(x) === x)) {
            throw new ConfigError(`config.toolchain.${field}: expected normalized absolute paths`);
        }
        if (!paths.every((x) => PLAIN_PATH.test(x))) {
            throw new ConfigError(
                `config.toolchain.${field}: expected plain paths the sandbox launcher can pass`,
            );
        }
    }
    const keep = toolchain?.keep as string[];
    for (const dir of toolchain?.bin as string[]) {
        if (!keep.some((k) => dir === k || dir.startsWith(k.endsWith("/") ? k : `${k}/`))) {
            throw new ConfigError(
                `config.toolchain.bin: ${dir} is not under a toolchain.keep path`,
            );
        }
    }
    const tools = toolchain?.wall_clock_tools;
    if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string" && /^[\w-]+$/.test(t))) {
        throw new ConfigError("config.toolchain.wall_clock_tools: expected command names");
    }
    // cargo is pointed only at rustc and rustdoc wrappers, and preflight probes both.
    for (const tool of tools as string[]) {
        if (!["rustc", "rustdoc"].includes(tool)) {
            throw new ConfigError(
                `config.toolchain.wall_clock_tools: ${tool} is not one of rustc, rustdoc`,
            );
        }
    }
    const env = toolchain?.env;
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
        throw new ConfigError("config.toolchain.env: missing");
    }
    for (const required of ["CARGO_HOME", "RUSTUP_HOME"]) {
        if (!(required in env)) throw new ConfigError(`config.toolchain.env.${required}: missing`);
    }
    for (const [key, value] of Object.entries(env)) {
        if (!ENV_KEY.test(key) || ["PATH", "HOME", "LD_PRELOAD"].includes(key)) {
            throw new ConfigError(
                `config.toolchain.env.${key}: expected a plain word the sandbox launcher can pass`,
            );
        }
        if (!TOOLCHAIN_ENV.includes(key)) {
            throw new ConfigError(
                `config.toolchain.env.${key}: not a supported toolchain variable (${TOOLCHAIN_ENV.join(", ")})`,
            );
        }
        if (
            typeof value !== "string" ||
            !isAbsolute(value) ||
            resolve(value) !== value ||
            !PLAIN_PATH.test(value)
        ) {
            throw new ConfigError(
                `config.toolchain.env.${key}: expected a normalized absolute path the sandbox launcher can pass`,
            );
        }
    }
    const bedrock = v.bedrock as Record<string, unknown> | undefined;
    for (const field of ["aws_profile", "region"] as const) {
        if (typeof bedrock?.[field] !== "string" || bedrock[field].trim() === "") {
            throw new ConfigError(`config.bedrock.${field}: missing`);
        }
    }
    return value as SimConfig;
}

export function loadConfig(path = defaultConfigPath()): SimConfig {
    return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}
