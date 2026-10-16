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
    const ascii = text.normalize("NFKD").replace(/\p{M}/gu, "").replace(INVISIBLE, "");
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
const VERDICTS: readonly string[] = ["first", "second", "both", "neither"];

export interface BlindedPrompt {
    pair: string;
    order: Order;
    reference: string;
    first: string;
    second: string;
}

export function normalise(text: string): string {
    return text
        .replace(/^[ \t]*```[^`\n]*$/gm, "")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/^[ \t]*\[[^\]]+\]:[ \t]+\S.*$/gm, "")
        .replace(/!?\[([^\]]*)\]\[[^\]]*\]/g, "$1")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\*{2,3}|_{2,3}|`/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

export function blind(
    pair: Pair,
    order: Order,
    reference: string,
    canaries: string[],
): BlindedPrompt {
    for (const [label, text] of [
        ["answer a", pair.a],
        ["answer b", pair.b],
        ["reference", reference],
    ] as const) {
        const variants = [text, normalise(text)].flatMap((t) => [t, t.replace(INVISIBLE, " ")]);
        const folds = variants.map(foldWords);
        const joined = folds.map((f) => f.replaceAll(" ", ""));
        const canary = canaries.find(
            (c) =>
                c !== "" &&
                (variants.some((v) => v.includes(c)) ||
                    folds.some((f) => f.includes(foldWords(c))) ||
                    joined.some((j) => j.includes(foldWords(c).replaceAll(" ", "")))),
        );
        if (canary) throw new BlindingRefused(`pair ${pair.id} ${label} carries canary ${canary}`);
        const token = ARM_TOKENS.find(
            (t) =>
                folds.some((f) => f.includes(` ${t} `)) ||
                (!t.includes(" ") && joined.some((j) => j.includes(t))),
        );
        if (token) throw new BlindingRefused(`pair ${pair.id} ${label} names an arm: ${token}`);
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

export const pairDigests = (pair: Pair) => ({ a: sha(pair.a), b: sha(pair.b) });
export const referenceDigest = (reference: string) => sha(reference);

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

export interface ProxyJudgeOptions {
    /** Wall-clock bound on one verdict request, after which the call is refused. */
    deadlineMs?: number;
}

export function parseVerdict(text: string): RawVerdict {
    const word = text
        .trim()
        .toLowerCase()
        .replace(/[^a-z]/g, "");
    if (word === "first" || word === "second" || word === "both" || word === "neither") return word;
    throw new GradeRefused(`judge reply ${JSON.stringify(text.slice(0, 80))} is not a verdict`);
}

const PROVIDERS = new Set(["anthropic", "openai", "amazon", "meta", "mistral"]);

/** `family` extracts the provider from a model id of the form `provider.model` or `region.provider.model`. */
function family(model: string): string {
    const [first = "", second = ""] = model.split(".");
    const provider = [first, second].find((segment) => PROVIDERS.has(segment));
    if (!provider) throw new GradeRefused(`model ${model} has no known family`);
    return provider;
}

export function proxyJudge(
    gatewayUrl: string,
    model: string,
    agentModel: string,
    options: ProxyJudgeOptions = {},
): JudgeClient {
    if (family(model) === family(agentModel)) {
        throw new GradeRefused(`judge ${model} shares the agent model's family`);
    }
    const deadlineMs = options.deadlineMs ?? 900_000;
    return {
        identity: judgeIdentity(model),
        async verdict(prompt) {
            let body: { output?: { message?: { content?: unknown } } };
            try {
                const response = await fetch(
                    `${gatewayUrl}/model/${encodeURIComponent(model)}/converse`,
                    {
                        method: "POST",
                        headers: {
                            [COMPONENT_HEADER]: "judge",
                            "content-type": "application/json",
                        },
                        body: JSON.stringify({
                            messages: [{ role: "user", content: [{ text: prompt }] }],
                            inferenceConfig: { maxTokens: 256 },
                        }),
                        signal: AbortSignal.timeout(deadlineMs),
                    },
                );
                if (!response.ok) throw new GradeRefused(`judge call failed: ${response.status}`);
                body = (await response.json()) as typeof body;
            } catch (caught) {
                if ((caught as Error).name === "TimeoutError") {
                    throw new GradeRefused(`judge call timed out after ${deadlineMs} ms`);
                }
                if (caught instanceof SyntaxError)
                    throw new GradeRefused("judge reply is not JSON");
                if (caught instanceof GradeRefused) throw caught;
                throw new GradeRefused(`judge call failed: ${(caught as Error).message}`);
            }
            const content = body?.output?.message?.content;
            const texts = Array.isArray(content)
                ? content.flatMap((block: unknown) => {
                      const text = (block as { text?: unknown } | null)?.text;
                      return typeof text === "string" ? [text] : [];
                  })
                : [];
            if (texts.length === 0) throw new GradeRefused("judge reply carries no text");
            return parseVerdict(texts.join("\n"));
        },
    };
}

export interface Recall {
    a: boolean;
    b: boolean;
}

export interface Judgment {
    pair: string;
    answers: { a: string; b: string };
    reference: string;
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

function recallFrom(orders: Record<Order, RawVerdict>): Recall | "Inconsistent" {
    for (const order of ORDERS) {
        if (!VERDICTS.includes(orders[order])) {
            throw new GradeRefused(
                `order ${order} verdict ${JSON.stringify(orders[order])} is not a verdict`,
            );
        }
    }
    const x = unswap("a_then_b", orders.a_then_b);
    const y = unswap("b_then_a", orders.b_then_a);
    return x.a === y.a && x.b === y.b ? x : "Inconsistent";
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
    const recall = recallFrom(orders);
    const lengths = { a: normalise(pair.a).length, b: normalise(pair.b).length };
    let longer: boolean | null = null;
    if (recall !== "Inconsistent" && recall.a !== recall.b && lengths.a !== lengths.b) {
        longer = recall[lengths.a > lengths.b ? "a" : "b"];
    }
    return {
        pair: pair.id,
        answers: pairDigests(pair),
        reference: referenceDigest(reference),
        judge: client.identity,
        orders,
        recall,
        lengths,
        longer_recalled_alone: longer,
    };
}

export function permutationCheck(trials: number, correct: number, rules: Rules): void {
    if (!Number.isSafeInteger(trials) || !Number.isSafeInteger(correct) || correct < 0) {
        throw new GradeRefused(`permutation counts ${correct}/${trials} are not whole numbers`);
    }
    if (trials === 0) throw new GradeRefused("permutation check ran no trials");
    if (correct > trials)
        throw new GradeRefused("permutation check counts more correct than trials");
    const identified = Math.max(correct, trials - correct);
    const ceiling = BigInt(rules.judge.arm_identification_ceiling_percent);
    if (BigInt(identified) * 100n > BigInt(trials) * ceiling) {
        throw new GradeRefused(`judge identified the arms in ${identified} of ${trials} trials`);
    }
}

export const CALIBRATION_SCHEMA = "sim-judge-calibration/v1";

export interface CalibrationSet {
    schema: typeof CALIBRATION_SCHEMA;
    judge: JudgeIdentity;
    labels: Record<string, "a" | "b" | "both" | "neither">;
    human: string[];
}

export function calibrationDigest(set: CalibrationSet | null, rules: Rules): string | null {
    if (!set) return null;
    if (set.schema !== CALIBRATION_SCHEMA)
        throw new GradeRefused(`calibration schema ${set.schema}`);
    if (typeof set.labels !== "object" || set.labels === null || Array.isArray(set.labels)) {
        throw new GradeRefused("calibration labels are not an object keyed by pair id");
    }
    if (!Array.isArray(set.human)) throw new GradeRefused("calibration human ids are not a list");
    if (set.human.some((id) => typeof id !== "string")) {
        throw new GradeRefused("a human label id is not a string");
    }
    const pairs = Object.keys(set.labels).length;
    const { calibration_min_pairs: min, human_sample_percent: percent } = rules.judge;
    const floor = Math.max(Math.ceil((pairs * percent) / 100), min);
    if (pairs < min) throw new GradeRefused(`calibration has ${pairs} pairs; needs ${min}`);
    if (set.human.length < floor || set.human.length > pairs) {
        throw new GradeRefused(`calibration has ${set.human.length} human labels; needs ${floor}`);
    }
    if (Object.keys(set.labels).some((id) => id.replace(INVISIBLE, "").trim() === "")) {
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
    return sha(`${CALIBRATION_SCHEMA}\n${canonicalJson(set)}`);
}

export interface P7Inputs {
    pair: Pair;
    answers: { a: string; b: string };
    snapshots: { a: string; b: string };
    arms: { a: string; b: string };
    inputs: string[];
}

export function p7Pair(item: string, a: Snapshot, b: Snapshot): P7Inputs | null {
    if (a.item !== item || b.item !== item) {
        throw new GradeRefused(`snapshots for ${item} mix items`);
    }
    if (a.id === b.id) throw new GradeRefused(`P7 item ${item}: both sides are the same snapshot`);
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
        if (normalise(text) === "")
            throw new GradeRefused(`P7 item ${item}: answer ${side} is empty`);
    }
    return {
        pair,
        answers: pairDigests(pair),
        snapshots: { a: a.id, b: b.id },
        arms: { a: a.arm, b: b.arm },
        inputs: [...ra.read, ...rb.read].sort(),
    };
}

export interface P7Context {
    item: string;
    answers: { a: string; b: string };
    reference: string;
    snapshots: { a: string; b: string };
    arms: { a: string; b: string };
    inputs: string[];
    later_attempts: { a: number; b: number };
    calibration: CalibrationSet | null;
    permutation: { trials: number; correct: number; judge: JudgeIdentity } | null;
}

export function gradeP7(j: Judgment, c: P7Context, rules: Rules, version = 1): GradeRecord[] {
    if (j.pair !== c.item) {
        throw new GradeRefused(`judgment for ${j.pair} cannot grade item ${c.item}`);
    }
    if (j.answers.a !== c.answers.a || j.answers.b !== c.answers.b) {
        throw new GradeRefused(`judgment for ${j.pair} was made on other answers`);
    }
    if (j.reference !== c.reference) {
        throw new GradeRefused(`judgment for ${j.pair} was made against another reference`);
    }
    if (canonicalJson(recallFrom(j.orders)) !== canonicalJson(j.recall)) {
        throw new GradeRefused(`judgment for ${j.pair} records a recall its order verdicts deny`);
    }
    const expected = canonicalJson(judgeIdentity(rules.judge.model));
    const requireJudge = (source: string, identity: JudgeIdentity) => {
        if (canonicalJson(identity) !== expected) {
            throw new GradeRefused(
                `${source} judge ${identity.model} is not the pre-registered judge ${rules.judge.model}`,
            );
        }
    };
    let digest: string | null = null;
    let calibration = "none";
    try {
        if (c.calibration) {
            requireJudge("judgment", j.judge);
            requireJudge("calibration", c.calibration.judge);
        }
        digest = calibrationDigest(c.calibration, rules);
        if (digest) calibration = "valid";
    } catch (caught) {
        calibration = `refused: ${(caught as Error).message}`;
    }
    let permutation = "none";
    if (c.permutation) {
        try {
            requireJudge("permutation", c.permutation.judge);
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
