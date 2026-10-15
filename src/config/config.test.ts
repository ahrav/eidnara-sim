import { expect, test } from "bun:test";
import { ConfigError, loadConfig, missingPaths, parseConfig } from "./config";

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
});

test("missingPaths names fields whose path does not exist", () => {
    const config = { ...loadConfig(), opencode_binary: "/nonexistent/opencode" };
    expect(missingPaths(config)).toContain("opencode_binary");
});
