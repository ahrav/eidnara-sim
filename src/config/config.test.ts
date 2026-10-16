import { expect, test } from "bun:test";
import { ConfigError, loadConfig, parseConfig } from "./config";

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
    expect(() => parseConfig({ ...base, agent_model: "" })).toThrow("config.agent_model: missing");
    expect(() => parseConfig({ ...base, upgrade: { pi_install: "next/pi" } })).toThrow(
        "config.upgrade.pi_install: not an absolute path",
    );
    expect(parseConfig({ ...base, upgrade: { opencode_binary: "/next/oc" } }).upgrade).toEqual({
        opencode_binary: "/next/oc",
    });
    expect(() => parseConfig({ ...base, toolchain: { ...base.toolchain, bin: ["bin"] } })).toThrow(
        "config.toolchain.bin: expected absolute paths",
    );
    expect(() =>
        parseConfig({ ...base, toolchain: { ...base.toolchain, wall_clock_tools: ["a b"] } }),
    ).toThrow("config.toolchain.wall_clock_tools: expected command names");
    expect(() =>
        parseConfig({ ...base, toolchain: { bin: [], keep: [], wall_clock_tools: [] } }),
    ).toThrow("config.toolchain.env: missing");
    const env = (extra: Record<string, unknown>) => ({
        ...base,
        toolchain: { ...base.toolchain, env: { ...base.toolchain.env, ...extra } },
    });
    expect(() => parseConfig(env({ LD_PRELOAD: "/x.so" }))).toThrow(
        "config.toolchain.env.LD_PRELOAD",
    );
    expect(() => parseConfig(env({ CARGO_HOME: 1 }))).toThrow("config.toolchain.env.CARGO_HOME");
});
