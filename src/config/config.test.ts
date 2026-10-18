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

test("a config in the pre-toolchain sim-config/v1 shape is refused by its schema", () => {
    const base = loadConfig() as any;
    expect(base.schema).toBe("sim-config/v2");
    expect(() => parseConfig({ ...base, schema: "sim-config/v1" })).toThrow(
        "config.schema: expected sim-config/v2",
    );
});

test("toolchain env entries must be words the sandbox launcher can pass", () => {
    const base = loadConfig() as any;
    const env = (extra: Record<string, unknown>) => ({
        ...base,
        toolchain: { ...base.toolchain, env: { ...base.toolchain.env, ...extra } },
    });
    expect(() => parseConfig(env({ "rust-flags": "x" }))).toThrow(
        "config.toolchain.env.rust-flags",
    );
    expect(() => parseConfig(env({ RUSTFLAGS: "-C debuginfo=0" }))).toThrow(
        "config.toolchain.env.RUSTFLAGS",
    );
});

test("every toolchain bin directory must be kept read-only", () => {
    const base = loadConfig() as any;
    const toolchain = { ...base.toolchain, bin: [...base.toolchain.bin, "/opt/tools/bin"] };
    expect(() => parseConfig({ ...base, toolchain })).toThrow(
        "config.toolchain.bin: /opt/tools/bin is not under a toolchain.keep path",
    );
});

test("configured paths must be normalized, since the sandbox launcher refuses others", () => {
    const base = loadConfig() as any;
    expect(() => parseConfig({ ...base, eidnara_checkout: `${base.eidnara_checkout}/` })).toThrow(
        "config.eidnara_checkout: not a normalized absolute path",
    );
    const toolchain = { ...base.toolchain, keep: [...base.toolchain.keep, "/opt/x/../y"] };
    expect(() => parseConfig({ ...base, toolchain })).toThrow(
        "config.toolchain.keep: expected normalized absolute paths",
    );
});

test("configured paths must use the sandbox launcher's plain-path grammar", () => {
    const base = loadConfig() as any;
    expect(() => parseConfig({ ...base, eidnara_checkout: "/srv/eidnara builds" })).toThrow(
        "config.eidnara_checkout: not a plain path the sandbox launcher can pass",
    );
    const toolchain = { ...base.toolchain, keep: [...base.toolchain.keep, "/opt/a b"] };
    expect(() => parseConfig({ ...base, toolchain })).toThrow(
        "config.toolchain.keep: expected plain paths the sandbox launcher can pass",
    );
});

test("toolchain env accepts only the cache and home variables the hosts support", () => {
    const base = loadConfig() as any;
    const env = (extra: Record<string, unknown>) => ({
        ...base,
        toolchain: { ...base.toolchain, env: { ...base.toolchain.env, ...extra } },
    });
    expect(() => parseConfig(env({ RUSTC_WRAPPER: "/writable/wrapper" }))).toThrow(
        "config.toolchain.env.RUSTC_WRAPPER: not a supported toolchain variable",
    );
    expect(() => parseConfig(env({ CARGO_HOME: "/c" }))).not.toThrow();
});

test("wall-clock tools are limited to the wrappers cargo is pointed at and preflight probes", () => {
    const base = loadConfig() as any;
    const toolchain = { ...base.toolchain, wall_clock_tools: ["rustc", "clang"] };
    expect(() => parseConfig({ ...base, toolchain })).toThrow(
        "config.toolchain.wall_clock_tools: clang is not one of rustc, rustdoc",
    );
});

test("the tool homes the hosts need must be configured", () => {
    const base = loadConfig() as any;
    const { RUSTUP_HOME: _, ...env } = base.toolchain.env;
    expect(() => parseConfig({ ...base, toolchain: { ...base.toolchain, env } })).toThrow(
        "config.toolchain.env.RUSTUP_HOME: missing",
    );
});

test("toolchain homes and caches must be normalized absolute paths", () => {
    const base = loadConfig() as any;
    const env = (extra: Record<string, unknown>) => ({
        ...base,
        toolchain: { ...base.toolchain, env: { ...base.toolchain.env, ...extra } },
    });
    for (const value of ["cache", "/opt/../cache", "/opt/cache/"]) {
        expect(() => parseConfig(env({ CARGO_HOME: value }))).toThrow(
            "config.toolchain.env.CARGO_HOME: expected a normalized absolute path",
        );
    }
});
