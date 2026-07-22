import type {
    AssistantEvent,
    Citation,
    Message,
} from "@/app/components/shared/types";

export interface ChatMessageWire {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    files?: { filename: string; document_id?: string }[] | null;
    workflow?: { id: string; title: string } | null;
    citations?: Citation[] | null;
    created_at: string;
}

export function mapChatMessages(messages: ChatMessageWire[]): Message[] {
    return messages.map((message) => {
        if (message.role === "user") {
            return {
                id: message.id,
                role: "user",
                content:
                    typeof message.content === "string"
                        ? message.content
                        : "",
                files: message.files ?? undefined,
                workflow: message.workflow ?? undefined,
            };
        }

        const events = Array.isArray(message.content)
            ? (message.content as AssistantEvent[])
            : undefined;
        const eventContent =
            events
                ?.filter((event) => event.type === "content")
                .map((event) =>
                    (event as { type: "content"; text: string }).text,
                )
                .join("") ?? "";
        return {
            id: message.id,
            role: "assistant",
            content:
                typeof message.content === "string"
                    ? message.content
                    : eventContent,
            citations: message.citations ?? undefined,
            events,
        };
    });
}
