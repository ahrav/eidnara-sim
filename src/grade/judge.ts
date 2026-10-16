import { createHash } from "node:crypto";
import { canonicalJson } from "../prereg/canonical";
import { COMPONENT_HEADER } from "../proxy/classify";
import type { Rng } from "../rng";
import { ArtefactReader, assertArtefactsOnly, GradeRefused, type Snapshot } from "./artefacts";
import type { GradeRecord, Rules } from "./probes";

export const ARM_TOKENS = [
    "aged arm",
    "fresh arm",
    "arm a",
    "arm b",
    "baseline arm",
    "control arm",
    "eidnara",
    "host arm",
    "memory arm",
];

const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;

export function foldWords(text: string): string {
    const ascii = text
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .replace(INVISIBLE, "")
        .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode((c.codePointAt(0) ?? 0) - 0xfee0));
    return ` ${ascii
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()} `;
}

export class BlindingRefused extends Error {}

export interface Pair {
    id: string;
    a: string;
    b: string;
}

export type Order = "a_then_b" | "b_then_a";
export const ORDERS: Order[] = ["a_then_b", "b_then_a"];
export type RawVerdict = "first" | "second" | "both" | "neither";

export interface BlindedPrompt {
    pair: string;
    order: Order;
    reference: string;
    first: string;
    second: string;
}

export function normalise(text: string): string {
    return text
        .replace(/^[ \t]*```[^\s`]*[ \t]*$/gm, "")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/\*\*|__|`/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

export function blind(
    pair: Pair,
    order: Order,
    reference: string,
    canaries: string[],
): BlindedPrompt {
    for (const text of [pair.a, pair.b]) {
        const folds = [text, text.replace(INVISIBLE, " ")].map(foldWords);
        const canary = canaries.find(
            (c) => c !== "" && (text.includes(c) || folds.some((f) => f.includes(foldWords(c)))),
        );
        if (canary) throw new BlindingRefused(`pair ${pair.id} carries canary ${canary}`);
        const token = ARM_TOKENS.find((t) => folds.some((f) => f.includes(` ${t} `)));
        if (token) throw new BlindingRefused(`pair ${pair.id} names an arm: ${token}`);
    }
    const [first, second] = order === "a_then_b" ? [pair.a, pair.b] : [pair.b, pair.a];
    return { pair: pair.id, order, reference, first: normalise(first), second: normalise(second) };
}

export const RUBRIC = `You compare two answers to one question against a reference reason.
An answer recalls the reason when it states the same cause; wording, length, and formatting do not count.
Reply with exactly one word: first, second, both, or neither, naming the answers that recall the reason.`;

export function judgePrompt(p: BlindedPrompt): string {
    return `${RUBRIC}\n\nReference reason:\n${p.reference}\n\nFirst answer:\n${p.first}\n\nSecond answer:\n${p.second}`;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export interface JudgeIdentity {
    model: string;
    prompt_digest: string;
    rubric_digest: string;
}

export function judgeIdentity(model: string): JudgeIdentity {
    const empty = { pair: "", order: "a_then_b" as const, reference: "", first: "", second: "" };
    return { model, prompt_digest: sha(judgePrompt(empty)), rubric_digest: sha(RUBRIC) };
}

export interface JudgeClient {
    identity: JudgeIdentity;
    verdict(prompt: string): Promise<RawVerdict>;
}

export function parseVerdict(text: string): RawVerdict {
    const word = text
        .trim()
        .toLowerCase()
        .replace(/[^a-z]/g, "");
    if (word === "first" || word === "second" || word === "both" || word === "neither") return word;
    throw new GradeRefused(`judge reply ${JSON.stringify(text.slice(0, 80))} is not a verdict`);
}

function family(model: string): string {
    const found = /(anthropic|openai|amazon|meta|mistral)/.exec(model)?.[1];
    if (!found) throw new GradeRefused(`model ${model} has no known family`);
    return found;
}

export function proxyJudge(gatewayUrl: string, model: string, agentModel: string): JudgeClient {
    if (family(model) === family(agentModel)) {
        throw new GradeRefused(`judge ${model} shares the agent model's family`);
    }
    return {
        identity: judgeIdentity(model),
        async verdict(prompt) {
            const response = await fetch(
                `${gatewayUrl}/model/${encodeURIComponent(model)}/converse`,
                {
                    method: "POST",
                    headers: { [COMPONENT_HEADER]: "judge", "content-type": "application/json" },
                    body: JSON.stringify({
                        messages: [{ role: "user", content: [{ text: prompt }] }],
                        inferenceConfig: { maxTokens: 256 },
                    }),
                },
            );
            if (!response.ok) throw new GradeRefused(`judge call failed: ${response.status}`);
            const body = (await response.json()) as {
                output?: { message?: { content?: Array<{ text?: string }> } };
            };
            const text = body.output?.message?.content?.find((b) => b.text !== undefined)?.text;
            return parseVerdict(text ?? "");
        },
    };
}

export interface Recall {
    a: boolean;
    b: boolean;
}

export interface Judgment {
    pair: string;
    judge: JudgeIdentity;
    orders: Record<Order, RawVerdict>;
    recall: Recall | "Inconsistent";
    lengths: { a: number; b: number };
    longer_recalled_alone: boolean | null;
}

function unswap(order: Order, verdict: RawVerdict): Recall {
    const firstOk = verdict === "first" || verdict === "both";
    const secondOk = verdict === "second" || verdict === "both";
    return order === "a_then_b" ? { a: firstOk, b: secondOk } : { a: secondOk, b: firstOk };
}

export async function judgePair(
    client: JudgeClient,
    pair: Pair,
    reference: string,
    canaries: string[],
): Promise<Judgment> {
    const prompts = ORDERS.map((order) => judgePrompt(blind(pair, order, reference, canaries)));
    const verdicts: RawVerdict[] = [];
    for (const prompt of prompts) verdicts.push(await client.verdict(prompt));
    const orders = { a_then_b: verdicts[0], b_then_a: verdicts[1] } as Record<Order, RawVerdict>;
    const x = unswap("a_then_b", orders.a_then_b);
    const y = unswap("b_then_a", orders.b_then_a);
    const recall = x.a === y.a && x.b === y.b ? x : "Inconsistent";
    const lengths = { a: normalise(pair.a).length, b: normalise(pair.b).length };
    let longer: boolean | null = null;
    if (recall !== "Inconsistent" && recall.a !== recall.b && lengths.a !== lengths.b) {
        longer = recall[lengths.a > lengths.b ? "a" : "b"];
    }
    return {
        pair: pair.id,
        judge: client.identity,
        orders,
        recall,
        lengths,
        longer_recalled_alone: longer,
    };
}

export function permutationCheck(trials: number, correct: number, rules: Rules): void {
    if (!Number.isInteger(trials) || !Number.isInteger(correct) || correct < 0) {
        throw new GradeRefused(`permutation counts ${correct}/${trials} are not whole numbers`);
    }
    if (trials === 0) throw new GradeRefused("permutation check ran no trials");
    if (correct > trials)
        throw new GradeRefused("permutation check counts more correct than trials");
    const identified = Math.max(correct, trials - correct);
    if (identified * 100 > trials * rules.judge.arm_identification_ceiling_percent) {
        throw new GradeRefused(`judge identified the arms in ${identified} of ${trials} trials`);
    }
}

export interface CalibrationSet {
    schema: "eval-judge/v1";
    judge: JudgeIdentity;
    labels: Record<string, "a" | "b" | "both" | "neither">;
    human: string[];
}

export function calibrationDigest(set: CalibrationSet | null, rules: Rules): string | null {
    if (!set) return null;
    const pairs = Object.keys(set.labels).length;
    const { calibration_min_pairs: min, human_sample_percent: percent } = rules.judge;
    const floor = Math.max(Math.ceil((pairs * percent) / 100), min);
    if (set.schema !== "eval-judge/v1") throw new GradeRefused(`calibration schema ${set.schema}`);
    if (pairs < min) throw new GradeRefused(`calibration has ${pairs} pairs; needs ${min}`);
    if (set.human.length < floor || set.human.length > pairs) {
        throw new GradeRefused(`calibration has ${set.human.length} human labels; needs ${floor}`);
    }
    if (Object.keys(set.labels).some((id) => id.trim() === "")) {
        throw new GradeRefused("a calibration pair id is blank");
    }
    if (new Set(set.human).size !== set.human.length) {
        throw new GradeRefused("a human label names a calibration pair twice");
    }
    const verdicts = ["a", "b", "both", "neither"];
    if (Object.values(set.labels).some((v) => !verdicts.includes(v))) {
        throw new GradeRefused("a calibration label is not a, b, both, or neither");
    }
    if (set.human.some((id) => !Object.hasOwn(set.labels, id))) {
        throw new GradeRefused("a human label names no calibration pair");
    }
    return sha(`eval-judge-calibration/v1\n${canonicalJson(set)}`);
}

export interface P7Inputs {
    pair: Pair;
    snapshots: { a: string; b: string };
    arms: { a: string; b: string };
    inputs: string[];
}

export function p7Pair(item: string, a: Snapshot, b: Snapshot): P7Inputs | null {
    if (a.item !== item || b.item !== item) {
        throw new GradeRefused(`snapshots for ${item} mix items`);
    }
    if (a.arm === b.arm) throw new GradeRefused(`P7 item ${item}: both snapshots are one arm`);
    const readers = [a, b].map((snapshot) => {
        assertArtefactsOnly(snapshot);
        return new ArtefactReader(snapshot);
    });
    if (a.turn_outcome === "failed" || b.turn_outcome === "failed") return null;
    const [ra, rb] = readers as [ArtefactReader, ArtefactReader];
    const pair = { id: item, a: ra.answer(), b: rb.answer() };
    for (const [side, text] of [
        ["a", pair.a],
        ["b", pair.b],
    ] as const) {
        if (text.trim() === "") throw new GradeRefused(`P7 item ${item}: answer ${side} is empty`);
    }
    return {
        pair,
        snapshots: { a: a.id, b: b.id },
        arms: { a: a.arm, b: b.arm },
        inputs: [...ra.read, ...rb.read].sort(),
    };
}

export interface P7Context {
    item: string;
    snapshots: { a: string; b: string };
    arms: { a: string; b: string };
    inputs: string[];
    later_attempts: { a: number; b: number };
    calibration: CalibrationSet | null;
    permutation: { trials: number; correct: number } | null;
}

export function gradeP7(j: Judgment, c: P7Context, rules: Rules, version = 1): GradeRecord[] {
    let digest: string | null = null;
    let calibration = "none";
    try {
        if (c.calibration && canonicalJson(c.calibration.judge) !== canonicalJson(j.judge)) {
            throw new GradeRefused(
                `calibration judge ${c.calibration.judge.model} differs from ${j.judge.model}`,
            );
        }
        digest = calibrationDigest(c.calibration, rules);
        if (digest) calibration = "valid";
    } catch (caught) {
        calibration = `refused: ${(caught as Error).message}`;
    }
    let permutation = "none";
    if (c.permutation) {
        try {
            permutationCheck(c.permutation.trials, c.permutation.correct, rules);
            permutation = "pass";
        } catch (caught) {
            permutation = `refused: ${(caught as Error).message}`;
        }
    }
    const metrics: GradeRecord["metrics"] = {
        judge_model: j.judge.model,
        judge_prompt_digest: j.judge.prompt_digest,
        judge_rubric_digest: j.judge.rubric_digest,
        calibration_digest: digest ?? "none",
        calibration,
        permutation,
        permutation_counts: c.permutation
            ? `${c.permutation.correct}/${c.permutation.trials}`
            : "none",
        gate_eligible: digest !== null && permutation === "pass",
        verdict_a_then_b: j.orders.a_then_b,
        verdict_b_then_a: j.orders.b_then_a,
        length_a: j.lengths.a,
        length_b: j.lengths.b,
        longer_recalled_alone: j.longer_recalled_alone ?? "n/a",
    };
    return (["a", "b"] as const).map((side) => {
        const common = {
            item: c.item,
            arm: c.arms[side],
            probe_type: "P7",
            version,
            snapshot: c.snapshots[side],
            inputs: c.inputs,
            later_attempts_logged: c.later_attempts[side],
        };
        if (j.recall === "Inconsistent") {
            return { ...common, verdict: "excluded", reason: "Inconsistent", metrics };
        }
        const pass = j.recall[side];
        return {
            ...common,
            verdict: pass ? "pass" : "fail",
            metrics: { ...metrics, "P7.pass": pass },
        };
    });
}

export function humanCheckSample(items: string[], rules: Rules, rng: Rng): string[] {
    const count = Math.ceil((items.length * rules.judge.human_sample_percent) / 100);
    const pool = [...items].sort();
    const picked: string[] = [];
    while (picked.length < count && pool.length > 0) {
        picked.push(pool.splice(Math.floor(rng.next() * pool.length), 1)[0] as string);
    }
    return picked.sort();
}
