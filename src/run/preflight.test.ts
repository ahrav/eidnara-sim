import { expect, test } from "bun:test";
import { type Preflight, preflightDrift } from "./preflight";

const probe = (name: string, intercepted: boolean) => ({
    name,
    path: `/bin/${name}`,
    intercepted,
    wall_clock_only: false,
    evidence: {},
});
const host = (host: "pi" | "opencode", version: string) => ({
    host,
    version,
    transcript_paths: [],
});
const before: Preflight = {
    launcher: "/l",
    time_injection: [probe("node", true), probe("opencode", true)],
    distortions: [],
    hosts: [host("pi", "0.80.2"), host("opencode", "1.14.0")],
    upgrade: [host("pi", "0.87.1"), host("opencode", "1.18.23")],
    toolchain: [],
};

test("a resume is admitted when interception and host versions match the manifest", () => {
    expect(
        preflightDrift(before, { ...before, launcher: "/elsewhere", distortions: ["x"] }),
    ).toEqual([]);
});

test("a changed interception result names time interception", () => {
    const now = { ...before, time_injection: [probe("node", true), probe("opencode", false)] };
    expect(preflightDrift(before, now)).toEqual(["time interception"]);
});

test("a changed current or next host version names host versions", () => {
    const current = { ...before, hosts: [host("pi", "0.81.0"), host("opencode", "1.14.0")] };
    expect(preflightDrift(before, current)).toEqual(["host versions"]);
    const next = { ...before, upgrade: [host("pi", "0.88.0"), host("opencode", "1.18.23")] };
    expect(preflightDrift(before, next)).toEqual(["host versions"]);
    const dropped = { ...before, upgrade: [] };
    expect(preflightDrift(before, dropped)).toEqual(["host versions"]);
});
