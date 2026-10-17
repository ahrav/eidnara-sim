import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { launch } from "./launcher";
import { FAKETIME_LIB, faketimeEnv, writeOffset } from "./timeinject";

export interface BinaryProbe {
    name: "pi" | "opencode" | "opencode-upgrade" | "daemon";
    path: string;
    keep: string[];
    argv: string[];
    env?: Record<string, string>;
    mode: "prints-time" | "binds-clock";
}

export interface Interception {
    name: string;
    path: string;
    intercepted: boolean;
    wall_clock_only: boolean;
    evidence: Record<string, unknown>;
}

export const DISTORTIONS = [
    "the monotonic clock is real, so in-process idle timers see wall time, not scenario gaps",
    "provider-side time, cache warmth, and rate limits follow wall time",
    "between clock jumps host clocks run at wall pace while scenario time holds, so they lead scenario time by the idle wall time since the last jump",
];

export function assess(results: Interception[]): { distortions: string[] } {
    const byName = new Map(results.map((t) => [t.name, t]));
    if (!byName.get("pi")?.intercepted && !byName.get("daemon")?.intercepted) {
        throw new Error("neither Pi nor the daemon reads the interposed clock; escalate before M8");
    }
    const wallOnly = results
        .filter((t) => t.wall_clock_only)
        .map((t) => `${t.name} runs wall-clock-only`);
    return { distortions: [...DISTORTIONS, ...wallOnly] };
}

const JUMP_MS = 8 * 3_600_000;
const PRINT_TIME =
    "const t=performance.now();setTimeout(()=>console.log(JSON.stringify({now:Date.now(),timer:performance.now()-t})),100)";

export function probes(paths: { node: string; opencode: string; daemon: string }): BinaryProbe[] {
    // The kept directory and the path the loader reports in its binding lines are the
    // binary's canonical location, so a symlinked configured path resolves before use.
    const node = realpathSync(paths.node);
    const opencode = realpathSync(paths.opencode);
    const daemon = realpathSync(paths.daemon);
    const nodeRoot = resolve(node, "../..");
    return [
        {
            name: "pi",
            path: node,
            keep: [nodeRoot],
            argv: [node, "-e", PRINT_TIME],
            mode: "prints-time",
        },
        {
            name: "opencode",
            path: opencode,
            keep: [dirname(opencode)],
            argv: [opencode, "-e", PRINT_TIME],
            env: { BUN_BE_BUN: "1" },
            mode: "prints-time",
        },
        {
            name: "daemon",
            path: paths.daemon,
            keep: [dirname(paths.daemon)],
            argv: [paths.daemon, "--help"],
            env: { LD_DEBUG: "bindings" },
            mode: "binds-clock",
        },
    ];
}

export function interceptionTest(
    launcher: string,
    workDir: string,
    binaries: BinaryProbe[],
    timeoutSeconds = 30,
): Interception[] {
    const clockDir = join(workDir, "interception");
    mkdirSync(clockDir, { recursive: true });
    const offset = join(clockDir, "offset");
    return binaries.map((b) => {
        writeOffset(offset, Date.now() + JUMP_MS, 0);
        const keep = [dirname(dirname(FAKETIME_LIB)), clockDir, ...b.keep];
        const env = { ...faketimeEnv(offset), ...b.env };
        const wallBefore = Date.now();
        // GNU timeout signals its own process group, so a KILL on expiry reaches sudo, the
        // unshare parent (which ignores TERM while it waits), namespace PID 1, and the probe.
        const r = Bun.spawnSync(
            [
                "timeout",
                "-s",
                "KILL",
                String(timeoutSeconds),
                ...launch(launcher, keep, env, b.argv),
            ],
            { stdout: "pipe", stderr: "pipe" },
        );
        const wall = Date.now() - wallBefore;
        let evidence: Record<string, unknown> = {
            exit: r.exitCode,
            signal: r.signalCode ?? null,
            wall_ms: wall,
        };
        let intercepted = false;
        if (b.mode === "prints-time") {
            try {
                const seen = JSON.parse(r.stdout.toString().trim().split("\n").at(-1) ?? "");
                const skew = seen.now - (wallBefore + JUMP_MS);
                evidence = { ...evidence, skew_ms: skew, timer_ms: Math.round(seen.timer) };
                const timer = seen.timer >= 90 && seen.timer < 1_000;
                intercepted = Math.abs(skew) < 5_000 + wall && timer;
            } catch {
                evidence = { ...evidence, stdout: r.stdout.toString().slice(0, 300) };
            }
        } else {
            const line = r.stderr
                .toString()
                .split("\n")
                .find(
                    (l) =>
                        l.includes(`binding file ${realpathSync(b.path)} [0] to `) &&
                        /libfaketimeMT\.so\.1 \[0\]: normal symbol `clock_gettime'/.test(l),
                );
            evidence = { ...evidence, binding: line?.trim() ?? null };
            intercepted = line !== undefined;
        }
        // Interception requires a successful exit under the interposer as well as a read clock.
        intercepted &&= r.exitCode === 0;
        return { name: b.name, path: b.path, intercepted, wall_clock_only: !intercepted, evidence };
    });
}
