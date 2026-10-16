import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "../grade/artefacts";
import type { Preregistration } from "../prereg/schema";
import type { CallRecord } from "../proxy/records";
import { type Entry, readJournal } from "../run/journal";
import type { Sample as ResourceSample } from "../run/sampler";
import type { Scenario } from "../scenario/compile";

export type Sample = Pick<ResourceSample, "scenario_ms" | "rss">;

export interface ArmLogs {
    arm: string;
    calls: CallRecord[];
    journal: Entry[];
    pluginLog: string[];
    daemonLog: string[];
    resources: Sample[];
    tools: (Command & { turn: string | null })[];
}

export interface RunLogs {
    dir: string;
    tier: string;
    prereg: Preregistration;
    kinds: Map<string, string>;
    arms: ArmLogs[];
}

function jsonl<T>(path: string): T[] {
    return existsSync(path) ? (readJournal(path) as unknown as T[]) : [];
}

const lines = (path: string) =>
    existsSync(path)
        ? readFileSync(path, "utf8")
              .split("\n")
              .filter((l) => l !== "")
        : [];

export function loadRun(dir: string, prereg: Preregistration): RunLogs {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const scenario = JSON.parse(readFileSync(join(dir, "scenario.json"), "utf8")) as Scenario;
    const kinds = new Map(scenario.events.map((e) => [String(e.id), String(e.kind)]));
    const calls = jsonl<CallRecord>(join(dir, "calls.jsonl"));
    const journal = readJournal(join(dir, "journal.jsonl"));
    const arms = (manifest.order as string[]).map((arm) => ({
        arm,
        calls: calls.filter((c) => c.arm === arm),
        journal: journal.filter((e) => e.arm === arm),
        pluginLog: lines(join(dir, arm, "r", "eidnara.log")),
        daemonLog: lines(join(dir, arm, "daemon.log")),
        resources: jsonl<Sample>(join(dir, arm, "resources.jsonl")),
        tools: jsonl<Command & { turn: string | null }>(join(dir, arm, "tools.jsonl")),
    }));
    return { dir, tier: manifest.tier, prereg, kinds, arms };
}
