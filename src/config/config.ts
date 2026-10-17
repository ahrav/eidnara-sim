import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const CONFIG_SCHEMA = "sim-config/v1";

/** Paths the harness reads; the sim tree never writes under any of them. */
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
    }
    const tools = toolchain?.wall_clock_tools;
    if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string" && /^[\w-]+$/.test(t))) {
        throw new ConfigError("config.toolchain.wall_clock_tools: expected command names");
    }
    const env = toolchain?.env;
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
        throw new ConfigError("config.toolchain.env: missing");
    }
    for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string" || ["PATH", "HOME", "LD_PRELOAD"].includes(key)) {
            throw new ConfigError(
                `config.toolchain.env.${key}: expected a string for a tool variable`,
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
