import assert from "node:assert/strict";
import test from "node:test";
import { mapChatMessages, type ChatMessageWire } from "./chatMessageMapping";

function wire(
    overrides: Partial<ChatMessageWire>,
): ChatMessageWire {
    return {
        id: "message-1",
        chat_id: "chat-1",
        role: "assistant",
        content: null,
        created_at: "2026-07-22T12:00:00.000Z",
        ...overrides,
    };
}

test("keeps a string assistant response when mapping a saved chat", () => {
    const [message] = mapChatMessages([
        wire({ role: "assistant", content: "Saved Word replacement." }),
    ]);
    assert.equal(message.content, "Saved Word replacement.");
    assert.equal(message.events, undefined);
});

test("joins persisted assistant content events", () => {
    const [message] = mapChatMessages([
        wire({
            role: "assistant",
            content: [
                { type: "reasoning", text: "Internal analysis." },
                { type: "content", text: "First part. " },
                { type: "content", text: "Second part." },
            ],
        }),
    ]);
    assert.equal(message.content, "First part. Second part.");
    assert.equal(message.events?.length, 3);
});

test("keeps user files and workflow metadata", () => {
    const [message] = mapChatMessages([
        wire({
            role: "user",
            content: "Review this.",
            files: [{ filename: "contract.docx", document_id: "doc-1" }],
            workflow: { id: "workflow-1", title: "Contract review" },
        }),
    ]);
    assert.equal(message.content, "Review this.");
    assert.equal(message.files?.[0].document_id, "doc-1");
    assert.equal(message.workflow?.title, "Contract review");
});
