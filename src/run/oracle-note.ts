import type { Scenario } from "../scenario/compile";

export const ORACLE_OPENING = "Background from earlier sessions on ";

type Event = Record<string, unknown> & { id: string };

/** The fence keeps backticks in a committed file from closing the quoted block. */
function fenceFor(text: string): string {
    const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
    return "`".repeat(Math.max(3, longest + 1));
}

export function oracleBackground(scenario: Scenario, probeId: string): string | null {
    const probe = scenario.probes.find((p) => p.id === probeId);
    const sources = probe?.ground_truth?.sources ?? [];
    if (sources.length === 0) return null;
    const all = scenario.events as Event[];
    const at = new Map(all.map((e, i) => [String(e.id), i]));
    const sessions = new Map(scenario.sessions.map((s) => [s.id, s.project]));
    const projectOf = (e: Event) =>
        typeof e.project === "string" ? e.project : (sessions.get(String(e.session)) ?? "");
    const parts: string[] = [];
    let project = "";
    const ordered = [...sources].sort((a, b) => (at.get(a) ?? -1) - (at.get(b) ?? -1));
    for (const id of ordered) {
        const e = all[at.get(id) ?? -1];
        if (!e) throw new Error(`${probeId}: source ${id} is not a scenario event`);
        project ||= projectOf(e);
        if (e.kind === "user_turn") {
            const quoted = String(e.text ?? "")
                .split("\n")
                .map((line) => (line === "" ? ">" : `> ${line}`))
                .join("\n");
            parts.push(`Earlier I wrote:\n${quoted}`);
        } else if (e.kind === "apply_diff" && e.remove === true) {
            parts.push(`${String(e.path)} was removed from the repository.`);
        } else if (e.kind === "apply_diff") {
            const content = String(e.content ?? "").replace(/\n$/, "");
            const fence = fenceFor(content);
            parts.push(`Committed then as ${String(e.path)}:\n${fence}\n${content}\n${fence}`);
        } else {
            throw new Error(`${probeId}: source ${id} is a ${String(e.kind)} event`);
        }
    }
    return `${ORACLE_OPENING}${project}, quoted as it came up:\n\n${parts.join("\n\n")}\n\nMy request now:\n`;
}
