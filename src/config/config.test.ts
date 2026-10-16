import { expect, test } from "bun:test";
import { ConfigError, defaultConfigPath, loadConfig, parseConfig } from "./config";

test("the committed config parses and names every path absolutely", () => {
    const config = loadConfig();
    expect(config.eidnara_checkout.startsWith("/")).toBe(true);
    expect(config.bedrock.region).not.toBe("");
});

test("a missing or relative path is refused by field name", () => {
    const base = loadConfig() as any;
    const { daemon_binary: _, ...noDaemon } = base;
    expect(() => parseConfig(noDaemon)).toThrow(new ConfigError("config.daemon_binary: missing"));
    expect(() => parseConfig({ ...base, pi_install: "relative/pi" })).toThrow(
        "config.pi_install: not an absolute path",
    );
    expect(() => parseConfig({ ...base, bedrock: { region: "us-west-2" } })).toThrow(
        "config.bedrock.aws_profile: missing",
    );
    expect(() => parseConfig({ ...base, bedrock: { aws_profile: "x", region: "  " } })).toThrow(
        "config.bedrock.region: missing",
    );
});

test("an empty SIM_CONFIG falls back to the committed file", () => {
    const saved = process.env.SIM_CONFIG;
    process.env.SIM_CONFIG = "";
    try {
        expect(defaultConfigPath().endsWith("/sim.config.json")).toBe(true);
    } finally {
        if (saved === undefined) delete process.env.SIM_CONFIG;
        else process.env.SIM_CONFIG = saved;
    }
});
