import type { AssistantEvent } from "../../shared/types";

export function eventErrorMessage(event: AssistantEvent): string | null {
    if (event.type === "error") return event.message;
    if ("error" in event && typeof event.error === "string" && event.error) {
        return event.error;
    }
    return null;
}

/**
 * The normal Assistant transcript is a work-product surface, not an agent
 * console.  Keep transport events in the persisted event stream so a chat can
 * resume cleanly, but render only prose, user interactions, final outcomes,
 * and source results.
 */
export function isVisibleAssistantEvent(event: AssistantEvent): boolean {
    if (event.type === "content") return true;
    if (event.type === "ask_inputs") return true;

    // Final outcome and authority-source events are useful work-product
    // context. Their streaming counterparts remain folded into Working… .
    if (
        (event.type === "doc_created" ||
            event.type === "doc_edited" ||
            event.type === "doc_replicated" ||
            event.type === "courtlistener_search_case_law" ||
            event.type === "courtlistener_get_cases" ||
            event.type === "courtlistener_find_in_case" ||
            event.type === "courtlistener_read_case" ||
            event.type === "courtlistener_verify_citations") &&
        !event.isStreaming
    ) {
        return true;
    }
    if (event.type === "doc_download" || event.type === "workflow_applied") {
        return true;
    }

    return false;
}

/** True when persisted internal activity warrants one concise live status. */
export function hasAssistantWorkInProgress(
    events: AssistantEvent[] | undefined,
    isStreaming: boolean,
): boolean {
    if (!isStreaming || !events) return false;
    return events.some(
        (event) =>
            event.type !== "content" &&
            event.type !== "error" &&
            event.type !== "ask_inputs" &&
            event.type !== "ask_inputs_response" &&
            event.type !== "case_citation" &&
            event.type !== "case_opinions",
    );
}

/**
 * Errors are useful blockers, but provider/MCP diagnostics are not useful in
 * the ordinary legal workflow and can reveal implementation detail.
 */
export function presentAssistantErrorMessage(message: string): string {
    if (
        /\b(mcp|connector|tool(?:[_\s-]?call)?|function call|(?:read|find|generate|edit|fetch|replicate|list|search)_[a-z_]+)\b/i.test(
            message,
        )
    ) {
        return "Unable to complete this request. Please try again.";
    }
    return message;
}

export function toolCallLabel(name: string): string {
    if (name === "ask_inputs") return "Asking for input...";
    if (name === "generate_docx") return "Creating document...";
    if (name === "generate_excel") return "Creating spreadsheet...";
    if (name === "generate_ppt") return "Creating presentation...";
    if (name === "edit_document") return "Editing document...";
    if (name === "read_document") return "Reading document...";
    if (name === "fetch_documents") return "Reading documents...";
    if (name === "find_in_document") return "Searching document...";
    if (name === "replicate_document") return "Copying document...";
    if (name === "read_workflow") return "Loading workflow...";
    if (name === "list_workflows") return "Loading workflows...";
    if (name === "list_documents") return "Loading documents...";
    if (name === "courtlistener_search_case_law")
        return "Searching case law...";
    if (name === "courtlistener_get_cases") return "Fetching cases...";
    if (name === "courtlistener_find_in_case") return "Searching case...";
    if (name === "courtlistener_read_case") return "Reading case...";
    if (name === "courtlistener_verify_citations")
        return "Verifying citations...";
    if (name.startsWith("mcp_")) return "Using connector...";
    return name ? `Running ${name}...` : "Working...";
}
