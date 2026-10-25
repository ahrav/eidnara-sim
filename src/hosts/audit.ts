/**
 * A pin move needs two facts about the candidate commit: the audited sources it changed, and
 * whether each recorded source probe still reads the same. Only read-only git commands run here.
 */

import { AUDITED_EIDNARA, DAEMON_VARIANTS, type VariantRecord } from "./profiles";

export interface ProbeResult {
    capability: string;
    file: string;
    pattern: string;
    present: boolean;
    /** True when the candidate's file is readable and matching `pattern` yields `present`. */
    holds: boolean;
}

export interface VariantAudit {
    variant: string;
    changed: string[];
    probes: ProbeResult[];
}

export interface AuditReport {
    checkout: string;
    audited: string;
    candidate: string;
    variants: VariantAudit[];
    /**
     * `unchanged`: every probe holds and the audited sources are identical at both commits, so
     * the pin may stay; `reread`: every probe holds and some audited source differs, so its diff
     * needs a reading before the pin moves; `broken`: a probe fails, so the capability table
     * needs revising.
     */
    verdict: "unchanged" | "reread" | "broken";
}

/**
 * The environment without Git's repository-local variables, so `-C checkout` reads that checkout
 * even when a hook or another repository's command runs the audit.
 */
export function checkoutEnv(
    env: Record<string, string | undefined> = process.env,
): Record<string, string> {
    const local = Bun.spawnSync(["git", "rev-parse", "--local-env-vars"], { stdout: "pipe" })
        .stdout.toString()
        .split("\n")
        .filter((v) => v !== "");
    return Object.fromEntries(
        Object.entries(env).filter(
            (e): e is [string, string] => e[1] !== undefined && !local.includes(e[0]),
        ),
    );
}

function git(checkout: string, args: string[]): { ok: boolean; out: string } {
    const r = Bun.spawnSync(["git", "-C", checkout, ...args], {
        stdout: "pipe",
        stderr: "pipe",
        env: checkoutEnv(),
    });
    return { ok: r.exitCode === 0, out: r.stdout.toString() };
}

function resolve(checkout: string, rev: string): string {
    const r = git(checkout, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
    if (!r.ok) throw new Error(`${checkout} has no commit ${rev}`);
    return r.out.trim();
}

export function auditEidnara(
    checkout: string,
    candidate: string,
    audited = AUDITED_EIDNARA,
    variants: Record<string, VariantRecord> = DAEMON_VARIANTS,
): AuditReport {
    const from = resolve(checkout, audited);
    const to = resolve(checkout, candidate);
    const results = Object.entries(variants).map(([variant, record]): VariantAudit => {
        const diff = git(checkout, ["diff", "--name-only", from, to, "--", ...record.sources]);
        if (!diff.ok) throw new Error(`git diff ${from} ${to} failed in ${checkout}`);
        const contents = new Map<string, string | null>();
        const read = (file: string) => {
            if (!contents.has(file)) {
                const shown = git(checkout, ["show", `${to}:${file}`]);
                contents.set(file, shown.ok ? shown.out : null);
            }
            return contents.get(file) ?? null;
        };
        const probes = record.probes.map((p) => {
            const text = read(p.file);
            const matched = text !== null && new RegExp(p.pattern).test(text);
            return { ...p, holds: text !== null && matched === p.present };
        });
        return { variant, changed: diff.out.split("\n").filter((l) => l !== ""), probes };
    });
    const broken = results.some((v) => v.probes.some((p) => !p.holds));
    const changed = results.some((v) => v.changed.length > 0);
    return {
        checkout,
        audited: from,
        candidate: to,
        variants: results,
        verdict: broken ? "broken" : changed ? "reread" : "unchanged",
    };
}

export function renderAudit(r: AuditReport): string {
    const lines = [`audited:   ${r.audited}`, `candidate: ${r.candidate}`];
    for (const v of r.variants) {
        lines.push("", `${v.variant}:`);
        lines.push(
            v.changed.length === 0
                ? "  changed sources: none"
                : `  changed sources:\n${v.changed.map((f) => `    ${f}`).join("\n")}`,
        );
        for (const p of v.probes) {
            const want = p.present ? "matches" : "lacks";
            lines.push(
                `  ${p.holds ? "holds " : "BROKEN"} ${p.capability}: ${p.file} ${want} /${p.pattern}/`,
            );
        }
    }
    const files = [...new Set(r.variants.flatMap((v) => v.changed))];
    lines.push("", `verdict: ${r.verdict}`);
    if (r.verdict === "unchanged") {
        lines.push(
            "The audited sources are identical; the capability table holds at the candidate.",
        );
    } else if (r.verdict === "reread") {
        lines.push(
            "Every probe holds. Read the changes, then set AUDITED_EIDNARA to the candidate:",
            `  git -C ${r.checkout} diff ${r.audited} ${r.candidate} -- ${files.join(" ")}`,
        );
    } else {
        lines.push(
            "A probe fails: revise DAEMON_VARIANTS in src/hosts/profiles.ts before the pin moves.",
        );
    }
    return lines.join("\n");
}
