import { expect, test } from "bun:test";
import { ARMS } from "../prereg/schema";
import { ARM_PROFILES, armProfile, capabilityGaps, isArmName } from "./profiles";

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
