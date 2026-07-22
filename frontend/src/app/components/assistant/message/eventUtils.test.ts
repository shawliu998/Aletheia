import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantEvent } from "../../shared/types";
import {
    hasAssistantWorkInProgress,
    isVisibleAssistantEvent,
    presentAssistantErrorMessage,
} from "./eventUtils";

test("hides internals while preserving completed outputs and authority sources", () => {
    const events: AssistantEvent[] = [
        { type: "reasoning", text: "Internal analysis." },
        { type: "tool_call_start", name: "read_document", isStreaming: true },
        {
            type: "mcp_tool_call",
            connector_id: "connector-1",
            connector_name: "Internal connector",
            tool_name: "search_documents",
            openai_tool_name: "mcp_search_documents",
            status: "ok",
        },
        {
            type: "doc_created",
            filename: "Risk memo.docx",
            download_url: "/documents/risk-memo.docx",
        },
        {
            type: "doc_replicated",
            filename: "Signed agreement.docx",
            count: 1,
        },
        {
            type: "doc_edited",
            document_id: "document-1",
            version_id: "version-1",
            filename: "Contract redline.docx",
            annotations: [],
            download_url: "/documents/contract-redline.docx",
        },
        {
            type: "doc_download",
            filename: "Risk matrix.xlsx",
            download_url: "/documents/risk-matrix.xlsx",
        },
        {
            type: "workflow_applied",
            workflow_id: "workflow-1",
            title: "Contract review",
        },
        {
            type: "courtlistener_verify_citations",
            citation_count: 2,
            match_count: 2,
        },
        { type: "content", text: "The limitation is twelve months." },
    ];

    assert.deepEqual(
        events.map((event) => isVisibleAssistantEvent(event)),
        [false, false, false, true, true, true, true, true, true, true],
    );
    assert.equal(hasAssistantWorkInProgress(events, true), true);
    assert.equal(hasAssistantWorkInProgress(events, false), false);
});

test("preserves the user input request and its answer", () => {
    const events: AssistantEvent[] = [
        {
            type: "ask_inputs",
            items: [
                {
                    id: "governing-law",
                    kind: "choice",
                    question: "Which law applies?",
                    options: [{ value: "New York" }],
                    allow_other: false,
                    other_label: "Other",
                },
            ],
        },
        {
            type: "ask_inputs_response",
            responses: [
                {
                    id: "governing-law",
                    kind: "choice",
                    question: "Which law applies?",
                    answer: "New York",
                },
            ],
        },
    ];

    assert.equal(isVisibleAssistantEvent(events[0]), true);
    assert.equal(isVisibleAssistantEvent(events[1]), false);
});

test("keeps user-facing errors but removes transport diagnostics", () => {
    assert.equal(
        presentAssistantErrorMessage("The document could not be read."),
        "The document could not be read.",
    );
    assert.equal(
        presentAssistantErrorMessage("MCP connector tool_call failed."),
        "Unable to complete this request. Please try again.",
    );
    assert.equal(
        presentAssistantErrorMessage("read_document failed."),
        "Unable to complete this request. Please try again.",
    );
});
