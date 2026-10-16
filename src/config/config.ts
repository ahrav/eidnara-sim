import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const CONFIG_SCHEMA = "sim-config/v1";

/** Paths the harness reads; the sim tree never writes under any of them. */
export interface SimConfig {
    schema: typeof CONFIG_SCHEMA;
    eidnara_checkout: string;
    opencode_plugin_dist: string;
    pi_plugin_dist: string;
    daemon_binary: string;
    pi_install: string;
    opencode_binary: string;
    bedrock: { aws_profile: string; region: string };
}

const PATH_FIELDS = [
    "eidnara_checkout",
    "opencode_plugin_dist",
    "pi_plugin_dist",
    "daemon_binary",
    "pi_install",
    "opencode_binary",
] as const;

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
