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
    reviewsMemory,
    runsEidnara,
    sameTreatment,
    W2_VARIANTS,
    W3_VARIANTS,
    W4_VARIANTS,
    W9_VARIANTS,
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
        "eidnara-reviewer": "automatic",
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

test("the reviewer arm is the eidnara arm with the reviewer switch, and runs on a build whose fixture has a reviewer host", () => {
    const { memory_reviewer: reviewer, requires, ...arm } = ARM_PROFILES["eidnara-reviewer"];
    const { requires: base, ...eidnara } = ARM_PROFILES.eidnara;
    expect(reviewer).toBe(true);
    expect(arm).toEqual(eidnara);
    expect(requires).toEqual({ ...base, memory_reviewer: true, memory_review: true });
    // The switch is the reviewer arm's alone; every earlier profile is recorded as it was.
    for (const [name, profile] of Object.entries(ARM_PROFILES)) {
        expect([name, reviewsMemory(profile)]).toEqual([name, name === "eidnara-reviewer"]);
        expect([name, Object.hasOwn(profile, "memory_reviewer")]).toEqual([
            name,
            name === "eidnara-reviewer",
        ]);
    }
    expect(capabilityGaps("eidnara-reviewer", auditedBuild("eval/wM"))).toEqual([]);
    expect(capabilityGaps("eidnara-reviewer", auditedBuild("eval/w9"))).toEqual([]);
    for (const earlier of ["main-ea12bff2a", "eval/w4", "eval/w3-all", "eval/w2b", "eval/c8"]) {
        const gaps = capabilityGaps("eidnara-reviewer", auditedBuild(earlier));
        expect([earlier, gaps.length]).toEqual([earlier, 2]);
        expect(gaps[0]).toMatch(
            /^eidnara-reviewer \(fallback-search\) needs memory_reviewer=true, but direct-host-fixture provides false: /,
        );
        expect(gaps[1]).toMatch(/needs memory_review=true, but direct-host-fixture provides false/);
    }
    // A contrast pairs two treatments: the reviewer switch tells the arm from the eidnara arm.
    expect(sameTreatment(ARM_PROFILES["eidnara-reviewer"], ARM_PROFILES.eidnara)).toBe(false);
    expect(sameTreatment(ARM_PROFILES["eidnara-cf"], ARM_PROFILES.eidnara)).toBe(true);
    expect(sameTreatment(ARM_PROFILES["eidnara-hybrid"], ARM_PROFILES.eidnara)).toBe(false);
    expect(sameTreatment(ARM_PROFILES["eidnara-search"], ARM_PROFILES.eidnara)).toBe(false);
    expect(sameTreatment(ARM_PROFILES.host, ARM_PROFILES["host-oracle"])).toBe(false);
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
    expect(capturing).toEqual([
        "eidnara",
        "eidnara-cf",
        "eidnara-hybrid",
        "eidnara-search",
        "eidnara-reviewer",
    ]);
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

test("the registered builds are the wM and w9 builds, the main commit, the w4 and w3 builds, the two w2 builds, and the c8 reference with the legacy fixture", () => {
    expect(AUDITED_BUILDS.map((b) => b.label)).toEqual([
        "eval/wM",
        "eval/w9",
        "main-ea12bff2a",
        "eval/w4",
        "eval/w3-all",
        "eval/w2b",
        "eval/w2",
        "eval/c8",
    ]);
    expect(new Set(AUDITED_BUILDS.map((b) => b.commit)).size).toBe(8);
    for (const b of AUDITED_BUILDS) expect(b.commit).toMatch(/^[0-9a-f]{40}$/);
    const [wM, w9, main, w4, w3, w2, first, c8] = AUDITED_BUILDS;
    if (!w9 || !main || !w4 || !w3)
        throw new Error("the w9, main, w4, and w3 builds are registered");
    // The current build is the wM build; the w9 build keeps its commit and its own table.
    expect(AUDITED_EIDNARA).toBe(wM.commit);
    expect(wM.commit).toBe("f618ce77e6f0e2a5be96390c2c1375b3809a97c7");
    expect(wM.variants).toBe(DAEMON_VARIANTS);
    expect(auditedBuild("eval/wM")).toBe(wM);
    expect(auditedBuild(wM.commit)).toBe(wM);
    expect(w9.commit).toBe("4c293f1835960b8d60b55756933f196ecd12d007");
    expect(w9.variants).toBe(W9_VARIANTS);
    // The main commit and the w4 build share one table under their own labels.
    expect(main.commit).toBe("ea12bff2adb028d942d3b339de6dc74b605ab1ab");
    expect(main.variants).toBe(W4_VARIANTS);
    expect(w4.variants).toBe(W4_VARIANTS);
    expect(w3.variants).toBe(W3_VARIANTS);
    expect(auditedBuild("eval/w9")).toBe(w9);
    expect(auditedBuild(w9.commit)).toBe(w9);
    expect(auditedBuild("main-ea12bff2a")).toBe(main);
    expect(auditedBuild(main.commit)).toBe(main);
    expect(auditedBuild("eval/w4")).toBe(w4);
    expect(auditedBuild(w4.commit)).toBe(w4);
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
    // The retests' arms: the three arms on the w9, main, w4, and w3 builds, the reference arm on the w2b build.
    for (const arm of ["host", "eidnara", "eidnara-hybrid"]) {
        expect(capabilityGaps(arm, wM)).toEqual([]);
        expect(capabilityGaps(arm, w9)).toEqual([]);
        expect(capabilityGaps(arm, main)).toEqual([]);
        expect(capabilityGaps(arm, w4)).toEqual([]);
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
    expect(rework(w4)).toEqual(rework(w3));
    expect(rework(w9)).toEqual(rework(w3));
    expect(rework(wM)).toEqual(rework(w3));
    expect(rework(w2 as typeof w3)).toEqual(rework(w3));
    expect(rework(c8 as typeof w3)).toEqual(["shared", false, false, true, false, false]);
    expect(w3.variants["direct-host-fixture-fused"]?.search_progress).toBe(true);
    // The w3 build differs from the w2 builds in two capabilities, on every variant, and in
    // nothing else; its probes replace the earlier builds' readings of those two.
    for (const [variant, record] of Object.entries(W2_VARIANTS)) {
        const current = W3_VARIANTS[variant as keyof typeof W3_VARIANTS];
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
    // The w4 build differs from the w3 build in one capability, on every variant, and in nothing
    // else; its probes replace the earlier builds' two readings, and the renderer joins its sources.
    for (const [variant, record] of Object.entries(W3_VARIANTS)) {
        const current = W4_VARIANTS[variant as keyof typeof W4_VARIANTS];
        expect(capabilitiesOf(current)).toEqual({
            ...capabilitiesOf(record),
            current_work_delivery: true,
        });
        expect(record.current_work_delivery).toBe(false);
        const own = (r: typeof record) =>
            r.probes.filter((p) => p.capability === "current_work_delivery").map((p) => p.present);
        expect(own(record)).toEqual([false, false]);
        expect(own(current)).toEqual([true, true, true, true, true, true]);
        expect(own(W2_VARIANTS[variant as keyof typeof W2_VARIANTS])).toEqual([false, false]);
        expect(current.sources).toEqual([...record.sources, "crates/daemon/src/memory_render.rs"]);
        expect(current.probes.length).toBe(record.probes.length + 4);
    }
    // The w9 build differs from the w4 table in five capabilities on every variant and in the
    // reviewer host of the two fixture variants; its probes replace the earlier builds' readings.
    const added = [
        "block_closing_sentence",
        "named_files",
        "replaced_observation_date",
        "failed_command_records",
        "memory_review",
    ] as const;
    const absent = [false, false, false, false, false, false, false];
    for (const [variant, record] of Object.entries(W4_VARIANTS)) {
        const current = W9_VARIANTS[variant as keyof typeof W9_VARIANTS];
        expect(capabilitiesOf(current)).toEqual({
            ...capabilitiesOf(record),
            block_closing_sentence: true,
            named_files: true,
            replaced_observation_date: true,
            failed_command_records: true,
            memory_review: true,
            memory_reviewer: true,
        });
        const own = (r: typeof record) =>
            r.probes
                .filter((p) => (added as readonly string[]).includes(p.capability))
                .map((p) => p.present);
        expect(own(record)).toEqual(absent);
        expect(own(current).length).toBeGreaterThan(absent.length);
        expect(own(current).every(Boolean)).toBe(true);
        for (const capability of added) {
            expect(record[capability]).toBe(false);
            // Each added capability has a reading on both sides and a note naming its source.
            expect(record.probes.some((p) => p.capability === capability)).toBe(true);
            expect(current.probes.some((p) => p.capability === capability)).toBe(true);
            expect(current.notes?.[capability]).toMatch(/^crates\/daemon\/src\//);
        }
        const host = (r: typeof record) =>
            r.probes.filter((p) => p.capability === "memory_reviewer").map((p) => p.present);
        const fixture = variant !== "production-payload";
        expect(record.memory_reviewer).toBe(!fixture);
        expect(host(record)).toEqual(fixture ? [false] : [true]);
        expect(host(current)).toEqual(fixture ? [true, true, true] : [true]);
        expect(current.evidence.includes("without a memory reviewer host")).toBe(false);
        expect(current.sources.slice(0, record.sources.length)).toEqual(record.sources);
        expect(current.sources.slice(record.sources.length)).toEqual([
            "crates/daemon/src/named_files.rs",
            "crates/daemon/src/memory_capture/failures.rs",
            "crates/daemon/src/memory_reviewer/worker.rs",
            "crates/daemon/src/memory_reviewer/review_cycle.rs",
            "crates/daemon/src/memory_reviewer/stage_one.rs",
            "crates/daemon/src/memory_reviewer/coordinator.rs",
        ]);
    }
    // The wM build differs from the w9 table in two capabilities on every variant and in nothing
    // else. Its probes replace the w9 readings whose source text it rewrote (the block's frame,
    // the `enqueued` line) and every earlier reading of the two; every other w9 probe stands.
    const since = ["search_tip_read_while_lagging", "review_selection_by_delivery"] as const;
    const of = (r: { probes: { capability: string; present: boolean }[] }, capability: string) =>
        r.probes.filter((p) => p.capability === capability).map((p) => p.present);
    for (const [variant, record] of Object.entries(W9_VARIANTS)) {
        const current = DAEMON_VARIANTS[variant as keyof typeof DAEMON_VARIANTS];
        expect(capabilitiesOf(current)).toEqual({
            ...capabilitiesOf(record),
            search_tip_read_while_lagging: true,
            review_selection_by_delivery: true,
        });
        expect(since.map((capability) => record[capability])).toEqual([false, false]);
        expect(of(record, "search_tip_read_while_lagging")).toEqual([false]);
        expect(of(record, "review_selection_by_delivery")).toEqual([false, false]);
        for (const capability of since) {
            expect(of(current, capability).length).toBeGreaterThan(3);
            expect(of(current, capability).every(Boolean)).toBe(true);
            expect(current.notes?.[capability]).toMatch(/^crates\/daemon\/src\//);
        }
        const patterns = (r: typeof record) => r.probes.map((p) => `${p.file} ${p.pattern}`);
        const dropped = patterns(record).filter((p) => !patterns(current).includes(p));
        expect(dropped).toEqual([
            "crates/daemon/src/lib.rs claims_feed_search",
            'crates/daemon/src/memory_render.rs format!\\("\\{DELIVERED_OPEN\\}\\{elements\\}\\{PROJECT_MEMORY_NOTE\\}\\\\n\\{DELIVERED_CLOSE\\}"\\)',
            'crates/daemon/src/memory_reviewer/review_cycle.rs "daemon: memory_reviewer enqueued job=\\{\\} trigger=\\{\\} later=\\{\\} source=\\{\\}"',
            "crates/daemon/src/memory_reviewer/review_cycle.rs delivery=",
            "crates/daemon/src/memory_reviewer/review_cycle.rs candidate\\.delivered",
        ]);
        // The two rewritten readings each have a wM reading of their own capability.
        expect(of(current, "block_closing_sentence").length).toBe(
            of(record, "block_closing_sentence").length + 2,
        );
        expect(of(current, "memory_review").length).toBe(of(record, "memory_review").length + 1);
        expect(
            current.probes.every((p) => p.present || !since.includes(p.capability as never)),
        ).toBe(true);
        expect(current.evidence).toBe(record.evidence);
        expect(current.sources.slice(0, record.sources.length)).toEqual(record.sources);
        expect(current.sources.slice(record.sources.length)).toEqual([
            "packages/opencode-plugin/src/tools/eidnara-search/execute.ts",
            "crates/daemon/src/kernel_routes/read.rs",
            "crates/daemon/src/kernel_routes/serving.rs",
            "crates/memory-store/src/lib.rs",
        ]);
    }
    // Every table before w9 reads the two as absent by one probe each: the daemon records no
    // consumer set a search serves from, and it reads no reviewer switch.
    for (const earlier of [W4_VARIANTS, W3_VARIANTS, W2_VARIANTS, c8?.variants ?? {}]) {
        for (const record of Object.values(earlier)) {
            expect(since.map((capability) => record[capability])).toEqual([false, false]);
            expect(of(record, "search_tip_read_while_lagging")).toEqual([false]);
            expect(of(record, "review_selection_by_delivery")).toEqual([false]);
        }
    }
    // Every earlier table reads the five as absent, the c8 reference included.
    for (const earlier of [W3_VARIANTS, W2_VARIANTS, c8?.variants ?? {}]) {
        for (const record of Object.values(earlier)) {
            expect(added.map((capability) => record[capability])).toEqual([
                false,
                false,
                false,
                false,
                false,
            ]);
            expect(
                record.probes
                    .filter((p) => (added as readonly string[]).includes(p.capability))
                    .map((p) => p.present),
            ).toEqual(absent);
        }
    }
    const legacy = c8?.variants["direct-host-fixture"];
    expect([
        legacy?.statement_lifetime,
        legacy?.background_cache_points,
        legacy?.current_work_delivery,
    ]).toEqual([false, "system-and-message", false]);
    expect(
        legacy?.probes
            .filter((p) => p.capability === "current_work_delivery")
            .map((p) => p.present),
    ).toEqual([false, false]);
});
