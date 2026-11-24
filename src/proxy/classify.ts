import type { Component } from "./records";

export interface ConverseBody {
    system?: Array<Record<string, unknown>>;
    messages?: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    toolConfig?: {
        tools?: Array<{ toolSpec?: { name: string; inputSchema?: { json?: unknown } } }>;
    };
    [field: string]: unknown;
}

export const COMPONENT_HEADER = "x-sim-component";
/**
 * How the system text of a stage-1 request of Eidnara's memory reviewer starts
 * (`crates/daemon/src/memory_reviewer/stage_one.rs`, `system_text`); its user message is the
 * review state, one JSON object whose first member is `memory`.
 */
const REVIEWER_STAGE1_SYSTEM = "You screen one stored memory of a coding project.";
/**
 * The opening of the step instructions every stage-2 request of the reviewer carries in its system
 * text (`crates/daemon/src/memory_reviewer/coordinator.rs`, `STEP_INSTRUCTIONS`); its user message
 * starts with the marker of the reviewed memory, `[ref-1 <run token>]`.
 */
const REVIEWER_STAGE2_STEP = 'Answer with exactly one JSON object {"v":1,"step":{...}}';
const ASSERTABLE = new Set<string>(["user-sim", "judge"]);

function blockText(blocks: unknown): string {
    return (Array.isArray(blocks) ? blocks : [])
        .map((block) => (typeof block?.text === "string" ? block.text : ""))
        .filter((text) => text.length > 0)
        .join("\n");
}

function infer(body: ConverseBody): Component {
    const system = blockText(body.system);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const all = messages.map((m) => blockText(m?.content)).join("\n");
    const lastUser = blockText([...messages].reverse().find((m) => m?.role === "user")?.content);
    const listed = body.toolConfig?.tools;
    const tools = Array.isArray(listed) ? listed : [];
    if (tools.some((tool) => tool?.toolSpec?.name === "bash")) return "agent";
    if (system.includes("title generator")) return "title";
    if (
        system.includes("Extract durable project memory") &&
        lastUser.includes('"existing_memories"')
    ) {
        return "memory_capture";
    }
    if (system.includes("You are a memory classifier") && lastUser.includes("<pool>")) {
        return "memory_classifier";
    }
    if (system.includes("You are ContextResearcher")) return "context_researcher";
    // The reviewer's requests quote stored memories and conversation messages, so their rules
    // come before the two that read message text or a summarizing system prompt.
    if (system.startsWith(REVIEWER_STAGE1_SYSTEM) && lastUser.startsWith('{"memory":')) {
        return "memory_reviewer_stage1";
    }
    if (system.includes(REVIEWER_STAGE2_STEP) && lastUser.startsWith("[ref-1 ")) {
        return "memory_reviewer_stage2";
    }
    if (all.includes("<new_messages>")) return "history_summarizer";
    const summarizes = /summar/i.test(system) && tools.length === 0;
    if (system.includes("context summarization assistant") || summarizes)
        return "native_compaction";
    return "other";
}

export function classify(
    body: ConverseBody,
    header: string | undefined,
): { component: Component; componentSource: "asserted" | "inferred" } {
    if (header !== undefined && ASSERTABLE.has(header)) {
        return { component: header as Component, componentSource: "asserted" };
    }
    return { component: infer(body), componentSource: "inferred" };
}
