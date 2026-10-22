import { expect, test } from "bun:test";
import { ARMS } from "../prereg/schema";
import {
    ARM_PROFILES,
    armProfile,
    capabilityGaps,
    deliveryOf,
    isArmName,
    runsEidnara,
} from "./profiles";

test("every pre-registered arm has a profile its daemon variant satisfies", () => {
    for (const arm of ARMS) {
        expect(isArmName(arm)).toBe(true);
        expect(capabilityGaps(arm)).toEqual([]);
    }
    expect(capabilityGaps("eidnara~aa")).toEqual([]);
});

test("production-hybrid is refused for its side calls alone, naming the production source", () => {
    const gaps = capabilityGaps("eidnara-hybrid");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatch(
        /^eidnara-hybrid \(production-hybrid\) needs side_calls=proxy, but production-payload provides direct-bedrock: .*QUALIFIED_HARNESS_CLOSURES/,
    );
});

test("the four roles map onto the arms the spec defines", () => {
    expect(armProfile("host").role).toBe("host-only");
    expect(armProfile("eidnara").role).toBe("fallback-search");
    expect(armProfile("eidnara-cf").role).toBe("fallback-search");
    expect(ARM_PROFILES["eidnara-kl"]).toMatchObject({
        role: "knowledge-only",
        plugin: true,
        host_compaction: true,
        eidnara_compaction: false,
    });
    expect(armProfile("eidnara-hybrid").search).toBe("fused");
    expect(() => armProfile("eidnara-x")).toThrow(/no profile/);
});

test("explicit-search-only is refused for its memory injection alone, naming the daemon source", () => {
    const gaps = capabilityGaps("eidnara-search");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatch(
        /^eidnara-search \(explicit-search-only\) needs memory_injection=switchable, but direct-host-fixture provides always-on: crates\/daemon\/src\/m0_compose\.rs .*memory\.enabled=false disables/,
    );
});

test("each delivery mode has its arm, and the oracle control runs no Eidnara", () => {
    const modes = Object.fromEntries(
        Object.entries(ARM_PROFILES).map(([arm, profile]) => [arm, deliveryOf(profile)]),
    );
    expect(modes).toEqual({
        host: "none",
        eidnara: "automatic",
        "eidnara-kl": "automatic",
        "eidnara-cf": "automatic",
        "eidnara-hybrid": "automatic",
        "eidnara-search": "explicit-search",
        "host-oracle": "oracle-context",
    });
    expect(ARM_PROFILES["host-oracle"]).toMatchObject({
        role: "oracle-context",
        daemon: null,
        plugin: false,
        host_compaction: true,
    });
    expect(capabilityGaps("host-oracle")).toEqual([]);
    for (const arm of ["host", "eidnara", "eidnara-kl", "eidnara-cf", "eidnara-hybrid"] as const) {
        expect(Object.hasOwn(ARM_PROFILES[arm], "delivery")).toBe(false);
    }
});

test("the oracle control is exempt from daemon and plugin evidence as the host arm is", () => {
    for (const label of ["host", "host~aa", "host-oracle"]) expect(runsEidnara(label)).toBe(false);
    for (const label of ["eidnara", "eidnara~aa", "eidnara-kl", "eidnara-x"]) {
        expect(runsEidnara(label)).toBe(true);
    }
});
