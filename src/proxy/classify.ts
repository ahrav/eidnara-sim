import type { Component } from "./records";

export interface ConverseBody {
    system?: Array<Record<string, unknown>>;
    messages?: Array<{ role: string; content: Array<Record<string, unknown>> }>;
    toolConfig?: { tools?: Array<{ toolSpec?: { name: string } }> };
    [field: string]: unknown;
}

export const COMPONENT_HEADER = "x-sim-component";
const ASSERTABLE = new Set<string>(["user-sim", "judge"]);

function blockText(blocks: Array<Record<string, unknown>> | undefined): string {
    return (blocks ?? [])
        .map((block) => (typeof block.text === "string" ? block.text : ""))
        .filter((text) => text.length > 0)
        .join("\n");
}

function infer(body: ConverseBody): Component {
    const system = blockText(body.system);
    const messages = body.messages ?? [];
    const all = messages.map((m) => blockText(m.content)).join("\n");
    const lastUser = blockText([...messages].reverse().find((m) => m.role === "user")?.content);
    const tools = body.toolConfig?.tools ?? [];
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
    if (all.includes("<new_messages>")) return "history_summarizer";
    const summarizes = /summar/i.test(system) && tools.length === 0;
    if (system.includes("context summarization assistant") || summarizes)
        return "native_compaction";
    if (tools.some((tool) => tool.toolSpec?.name === "bash")) return "agent";
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
