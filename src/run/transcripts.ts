export interface TranscriptStore {
    host: "pi" | "opencode";
    versions: RegExp;
    paths: string[];
}

export const TRANSCRIPT_STORES: TranscriptStore[] = [
    { host: "pi", versions: /^0\.80\./, paths: ["$PI_CODING_AGENT_DIR/sessions"] },
    {
        host: "opencode",
        versions: /^1\.1[89]\./,
        paths: ["$XDG_DATA_HOME/opencode/opencode.db", "$XDG_DATA_HOME/opencode/storage"],
    },
];

export function transcriptPaths(host: "pi" | "opencode", version: string): string[] {
    const row = TRANSCRIPT_STORES.find((t) => t.host === host && t.versions.test(version));
    if (!row) {
        throw new Error(
            `no transcript-store paths for ${host} ${version}; extend TRANSCRIPT_STORES`,
        );
    }
    return row.paths;
}

export function hostVersion(argv: string[]): string {
    const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    const text = `${r.stdout}${r.stderr}`;
    const version = /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1];
    if (r.exitCode !== 0 || !version)
        throw new Error(`${argv.join(" ")}: no version in ${text.slice(0, 200)}`);
    return version;
}
