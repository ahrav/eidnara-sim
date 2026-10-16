import { canonicalJson, sha256Hex } from "../prereg/canonical";
import { COMPONENT_HEADER } from "../proxy/classify";
import type { Rng } from "../rng";
import type { ProbeItem } from "../scenario/compile";
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

const ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
};

const codePoint = (value: number) => (value <= 0x10ffff ? String.fromCodePoint(value) : "");

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

const MARKUP = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^<>]*>/g;

export function normalise(text: string): string {
    return text
        .replace(/^[ \t]*```[^`\n]*$/gm, "")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^\s*[-*+]\s+/gm, "")
        .replace(/^[ \t]*\[[^\]]+\]:[ \t]+\S.*$/gm, "")
        .replace(MARKUP, " ")
        .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number(dec)))
        .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => ENTITIES[name] ?? "")
        .replace(/&[A-Za-z][A-Za-z0-9]*;/g, " ")
        .replace(MARKUP, " ")
        .replace(INVISIBLE, "")
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
    return {
        pair: pair.id,
        order,
        reference: normalise(reference),
        first: normalise(first),
        second: normalise(second),
    };
}

export const RUBRIC = `You compare two answers to one question against a reference reason.
An answer recalls the reason when it states the same cause; wording, length, and formatting do not count.
Reply with exactly one word: first, second, both, or neither, naming the answers that recall the reason.`;

export function judgePrompt(p: BlindedPrompt): string {
    return `${RUBRIC}\n\nReference reason:\n${p.reference}\n\nFirst answer:\n${p.first}\n\nSecond answer:\n${p.second}`;
}

const sha = sha256Hex;

export const pairDigests = (pair: Pair) => ({ a: sha(pair.a), b: sha(pair.b) });
export const referenceDigest = (reference: string) => sha(reference);

const isIdentity = (value: unknown): value is JudgeIdentity =>
    typeof value === "object" &&
    value !== null &&
    ["model", "prompt_digest", "rubric_digest"].every(
        (key) => typeof (value as Record<string, unknown>)[key] === "string",
    );

const isPair = (value: unknown, kind: "string" | "number") =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).a === kind &&
    typeof (value as Record<string, unknown>).b === kind;

export interface JudgeIdentity {
    model: string;
    prompt_digest: string;
    rubric_digest: string;
}

export function judgeIdentity(model: string): JudgeIdentity {
    return {
        model,
        prompt_digest: sha(`${PREPROCESSING_VERSION}\n${judgePrompt(EMPTY_PROMPT)}`),
        rubric_digest: sha(RUBRIC),
    };
}

export const EMPTY_PROMPT: BlindedPrompt = {
    pair: "",
    order: "a_then_b",
    reference: "",
    first: "",
    second: "",
};

/** `PREPROCESSING_VERSION` changes whenever `normalise`, `foldWords`, `ARM_TOKENS`, or `INVISIBLE` change what the judge sees. */
export const PREPROCESSING_VERSION = "sim-judge-preprocessing/v2";

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
        .replace(/[.!]+$/, "");
    if (VERDICTS.includes(word)) return word as RawVerdict;
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
            let body: { output?: { message?: { content?: unknown } }; stopReason?: unknown };
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
                        redirect: "error",
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
            if (body?.stopReason !== "end_turn") {
                throw new GradeRefused(`judge reply stopped for ${String(body?.stopReason)}`);
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
    if (typeof orders !== "object" || orders === null) {
        throw new GradeRefused("judgment carries no order verdicts");
    }
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
    const lengths = answerLengths(pair);
    return {
        pair: pair.id,
        answers: pairDigests(pair),
        reference: referenceDigest(reference),
        judge: client.identity,
        orders,
        recall,
        lengths,
        longer_recalled_alone: longerRecalledAlone(recall, lengths),
    };
}

export const answerLengths = (pair: Pair) => ({
    a: normalise(pair.a).length,
    b: normalise(pair.b).length,
});

function longerRecalledAlone(
    recall: Recall | "Inconsistent",
    lengths: { a: number; b: number },
): boolean | null {
    if (recall === "Inconsistent" || recall.a === recall.b || lengths.a === lengths.b) return null;
    return recall[lengths.a > lengths.b ? "a" : "b"];
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
    if (Object.keys(set.labels).some((id) => foldWords(id).trim() === "")) {
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
    lengths: { a: number; b: number };
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
        if (foldWords(normalise(text)).trim() === "")
            throw new GradeRefused(`P7 item ${item}: answer ${side} is empty`);
    }
    return {
        pair,
        answers: pairDigests(pair),
        lengths: answerLengths(pair),
        snapshots: { a: a.id, b: b.id },
        arms: { a: a.arm, b: b.arm },
        inputs: [...ra.read, ...rb.read].sort(),
    };
}

export interface P7Context {
    probe: ProbeItem;
    /** Each arm's snapshots in attempt order; the first is graded and the rest are counted. */
    snapshots: { a: Snapshot[]; b: Snapshot[] };
    calibration: CalibrationSet | null;
    permutation: { trials: number; correct: number; judge: JudgeIdentity } | null;
    /** `cross_judge` binds the pre-registered cross-judge identity to the calibration set through `calibration_digest`. */
    cross_judge: { judge: JudgeIdentity; calibration_digest: string } | null;
}

export function gradeP7(j: Judgment, c: P7Context, rules: Rules, version = 1): GradeRecord[] {
    if (typeof j !== "object" || j === null) throw new GradeRefused("judgment is not a record");
    if (!isIdentity(j.judge)) throw new GradeRefused(`judgment for ${j.pair} names no judge`);
    const item = c.probe.id;
    const reason = (c.probe.check as { judge?: unknown } | null)?.judge;
    if (c.probe.type !== "P7" || typeof reason !== "string" || reason.trim() === "") {
        throw new GradeRefused(`item ${item} is not a P7 probe with a reference reason`);
    }
    if (j.pair !== item) {
        throw new GradeRefused(`judgment for ${j.pair} cannot grade item ${item}`);
    }
    const first = (side: "a" | "b"): Snapshot => {
        const list = c.snapshots[side];
        if (!Array.isArray(list) || list.length === 0) {
            throw new GradeRefused(`P7 item ${item}: side ${side} has no snapshot`);
        }
        const head = list[0] as Snapshot;
        if (list.some((s) => s.item !== head.item || s.arm !== head.arm)) {
            throw new GradeRefused(`snapshots for ${item} side ${side} mix items or arms`);
        }
        for (const s of list) {
            const session = (s as { session?: unknown }).session;
            if (session !== c.probe.session) {
                throw new GradeRefused(
                    `snapshot ${s.id} is from session ${String(session)}, not the probe's ${c.probe.session}`,
                );
            }
            if (c.probe.event && s.turn !== c.probe.event) {
                throw new GradeRefused(
                    `snapshot ${s.id} is of turn ${s.turn}, not the probe's event ${c.probe.event}`,
                );
            }
        }
        return head;
    };
    const built = p7Pair(item, first("a"), first("b"));
    if (!built) throw new GradeRefused(`P7 item ${item}: a probe turn failed; nothing to grade`);
    if (!isPair(j.answers, "string") || !isPair(j.lengths, "number")) {
        throw new GradeRefused(`judgment for ${j.pair} carries malformed answer evidence`);
    }
    if (j.answers.a !== built.answers.a || j.answers.b !== built.answers.b) {
        throw new GradeRefused(`judgment for ${j.pair} was made on other answers`);
    }
    if (j.reference !== referenceDigest(reason)) {
        throw new GradeRefused(`judgment for ${j.pair} was made against another reference`);
    }
    if (canonicalJson(recallFrom(j.orders)) !== canonicalJson(j.recall)) {
        throw new GradeRefused(`judgment for ${j.pair} records a recall its order verdicts deny`);
    }
    if (j.lengths.a !== built.lengths.a || j.lengths.b !== built.lengths.b) {
        throw new GradeRefused(`judgment for ${j.pair} records other answer lengths`);
    }
    if (j.longer_recalled_alone !== longerRecalledAlone(j.recall, j.lengths)) {
        throw new GradeRefused(
            `judgment for ${j.pair} records a verbosity audit its recall denies`,
        );
    }
    const requireJudge = (source: string, identity: JudgeIdentity, model = rules.judge.model) => {
        if (!isIdentity(identity)) {
            throw new GradeRefused(`${source} judge identity is incomplete`);
        }
        if (canonicalJson(identity) !== canonicalJson(judgeIdentity(model))) {
            throw new GradeRefused(
                `${source} judge ${identity.model} is not the pre-registered judge ${model}`,
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
    let crossJudge = "none";
    if (c.cross_judge) {
        try {
            requireJudge("cross-judge", c.cross_judge.judge, rules.judge.cross_judge);
            if (digest === null || c.cross_judge.calibration_digest !== digest) {
                throw new GradeRefused("cross-judge labelled another calibration set");
            }
            crossJudge = "valid";
        } catch (caught) {
            crossJudge = `refused: ${(caught as Error).message}`;
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
        cross_judge: crossJudge,
        gate_eligible:
            digest !== null &&
            permutation === "pass" &&
            crossJudge === "valid" &&
            j.recall !== "Inconsistent",
        verdict_a_then_b: j.orders.a_then_b,
        verdict_b_then_a: j.orders.b_then_a,
        length_a: j.lengths.a,
        length_b: j.lengths.b,
        longer_recalled_alone: j.longer_recalled_alone ?? "n/a",
    };
    return (["a", "b"] as const).map((side) => {
        const common = {
            item,
            arm: built.arms[side],
            probe_type: "P7",
            version,
            snapshot: built.snapshots[side],
            inputs: built.inputs,
            later_attempts_logged: c.snapshots[side].length - 1,
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
