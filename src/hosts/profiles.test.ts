import { expect, test } from "bun:test";
import { ARMS } from "../prereg/schema";
import {
    ARM_PROFILES,
    AUDITED_BUILDS,
    AUDITED_EIDNARA,
    armProfile,
    auditedBuild,
    capabilitiesOf,
    capabilityGaps,
    DAEMON_VARIANTS,
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

test("the c8 comparison arms run without a gap, and a variant that lacks a declared capability is named", () => {
    for (const arm of ["host", "eidnara", "eidnara-hybrid", "eidnara-search"]) {
        expect(capabilityGaps(arm)).toEqual([]);
    }
    expect(armProfile("eidnara-hybrid")).toMatchObject({
        daemon: "direct-host-fixture-fused",
        search: "fused",
        requires: { side_calls: "proxy", embeddings: "gte-modernbert-base-f32" },
    });
    const fixture = DAEMON_VARIANTS["direct-host-fixture"];
    const saved = fixture.memory_injection;
    fixture.memory_injection = "always-on";
    try {
        const gaps = capabilityGaps("eidnara-search");
        expect(gaps).toHaveLength(1);
        expect(gaps[0]).toMatch(
            /^eidnara-search \(explicit-search-only\) needs memory_injection=switchable, but direct-host-fixture provides always-on: crates\/daemon\/src\/transform\.rs .*memory_auto_inject/,
        );
    } finally {
        fixture.memory_injection = saved;
    }
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

test("source capture is consented on every arm the c8 comparison contrasts with eidnara, and every capability has a source probe", () => {
    const capturing = Object.entries(ARM_PROFILES)
        .filter(([, p]) => p.source_capture)
        .map(([arm]) => arm);
    expect(capturing).toEqual(["eidnara", "eidnara-cf", "eidnara-hybrid", "eidnara-search"]);
    for (const arm of capturing) expect(armProfile(arm).requires.source_capture).toBe(true);
    for (const build of AUDITED_BUILDS) {
        for (const [variant, record] of Object.entries(build.variants)) {
            const at = `${build.label} ${variant}`;
            const covered = new Set<string>(record.probes.map((p) => p.capability));
            expect([at, [...covered].sort()]).toEqual([
                at,
                Object.keys(capabilitiesOf(record)).sort(),
            ]);
            for (const p of record.probes)
                expect([at, record.sources]).toEqual([at, expect.arrayContaining([p.file])]);
        }
    }
});

test("the registered builds are the w2 build with every variant and the c8 reference with the legacy fixture", () => {
    expect(AUDITED_BUILDS.map((b) => b.label)).toEqual(["eval/w2", "eval/c8"]);
    expect(new Set(AUDITED_BUILDS.map((b) => b.commit)).size).toBe(2);
    for (const b of AUDITED_BUILDS) expect(b.commit).toMatch(/^[0-9a-f]{40}$/);
    const [w2, c8] = AUDITED_BUILDS;
    expect(AUDITED_EIDNARA).toBe(w2.commit);
    expect(w2.variants).toBe(DAEMON_VARIANTS);
    expect(auditedBuild("eval/c8")).toBe(c8);
    expect(auditedBuild(w2.commit)).toBe(w2);
    expect(auditedBuild("eval/c7")).toBeUndefined();
    expect(Object.keys(c8?.variants ?? {})).toEqual(["direct-host-fixture"]);
    // The focused run's arms: the reworked arms on the w2 build, the reference arm on the c8 build.
    for (const arm of ["host", "eidnara", "eidnara-hybrid"])
        expect(capabilityGaps(arm, w2)).toEqual([]);
    expect(capabilityGaps("eidnara", c8)).toEqual([]);
    expect(capabilityGaps("host", c8)).toEqual([]);
    expect(capabilityGaps("eidnara-hybrid", c8)).toHaveLength(1);
    const rework = (b: typeof w2) => {
        const v = b.variants["direct-host-fixture"];
        return [
            v?.statement_lineage,
            v?.contested_statements,
            v?.keyed_open_items,
            v?.settled_lines_retired,
            v?.process_memory,
            v?.search_progress,
        ];
    };
    expect(rework(w2)).toEqual(["per-message", true, true, false, true, false]);
    expect(rework(c8 as typeof w2)).toEqual(["shared", false, false, true, false, false]);
    expect(w2.variants["direct-host-fixture-fused"]?.search_progress).toBe(true);
});
