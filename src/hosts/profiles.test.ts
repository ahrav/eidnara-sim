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
    W2_VARIANTS,
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

test("the registered builds are the w3 build, the two w2 builds, and the c8 reference with the legacy fixture", () => {
    expect(AUDITED_BUILDS.map((b) => b.label)).toEqual([
        "eval/w3-all",
        "eval/w2b",
        "eval/w2",
        "eval/c8",
    ]);
    expect(new Set(AUDITED_BUILDS.map((b) => b.commit)).size).toBe(4);
    for (const b of AUDITED_BUILDS) expect(b.commit).toMatch(/^[0-9a-f]{40}$/);
    const [w3, w2, first, c8] = AUDITED_BUILDS;
    expect(AUDITED_EIDNARA).toBe(w3.commit);
    expect(w3.variants).toBe(DAEMON_VARIANTS);
    // The two w2 builds stay registered under their own labels with one table.
    expect(w2?.variants).toBe(W2_VARIANTS);
    expect(first?.variants).toBe(W2_VARIANTS);
    expect(auditedBuild("eval/w3-all")).toBe(w3);
    expect(auditedBuild("eval/w2")).toBe(first);
    expect(auditedBuild("eval/w2b")).toBe(w2);
    expect(auditedBuild("eval/c8")).toBe(c8);
    expect(auditedBuild(w3.commit)).toBe(w3);
    expect(auditedBuild("eval/c7")).toBeUndefined();
    expect(Object.keys(c8?.variants ?? {})).toEqual(["direct-host-fixture"]);
    // The retest's arms: the three arms on the w3 build, the reference arm on the w2b build.
    for (const arm of ["host", "eidnara", "eidnara-hybrid"]) {
        expect(capabilityGaps(arm, w3)).toEqual([]);
        expect(capabilityGaps(arm, w2)).toEqual([]);
    }
    expect(capabilityGaps("eidnara", c8)).toEqual([]);
    expect(capabilityGaps("host", c8)).toEqual([]);
    expect(capabilityGaps("eidnara-hybrid", c8)).toHaveLength(1);
    const rework = (b: typeof w3) => {
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
    expect(rework(w3)).toEqual(["per-message", true, true, false, true, false]);
    expect(rework(w2 as typeof w3)).toEqual(rework(w3));
    expect(rework(c8 as typeof w3)).toEqual(["shared", false, false, true, false, false]);
    expect(w3.variants["direct-host-fixture-fused"]?.search_progress).toBe(true);
    // The w3 build differs from the w2 builds in two capabilities, on every variant, and in
    // nothing else; its probes replace the earlier builds' readings of those two.
    for (const [variant, record] of Object.entries(W2_VARIANTS)) {
        const current = DAEMON_VARIANTS[variant as keyof typeof DAEMON_VARIANTS];
        expect(capabilitiesOf(current)).toEqual({
            ...capabilitiesOf(record),
            statement_lifetime: true,
            background_cache_points: "system",
        });
        expect([record.statement_lifetime, record.background_cache_points]).toEqual([
            false,
            "system-and-message",
        ]);
        const own = (r: typeof record) =>
            r.probes
                .filter((p) =>
                    ["statement_lifetime", "background_cache_points"].includes(p.capability),
                )
                .map((p) => p.present);
        expect(own(record)).toEqual([false, false, false]);
        expect(own(current)).toEqual([true, true, true, true]);
        expect(current.sources).toEqual(record.sources);
    }
    const legacy = c8?.variants["direct-host-fixture"];
    expect([legacy?.statement_lifetime, legacy?.background_cache_points]).toEqual([
        false,
        "system-and-message",
    ]);
});
