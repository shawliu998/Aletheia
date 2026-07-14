import { randomUUID } from "node:crypto";
import {
  CreateChatMessageRequestSchema,
  CreateChatRequestSchema,
  UpdateChatRequestSchema,
} from "../contracts";
import { WorkspaceApiError } from "../errors";
import { ChatsRepository } from "../repositories/chats";
import { ProjectsRepository } from "../repositories/projects";
import { ModelProfilesRepository } from "../repositories/modelProfiles";
export class ChatsService {
  constructor(
    private readonly chats: ChatsRepository,
    private readonly projects: ProjectsRepository,
    private readonly profiles: ModelProfilesRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  private now() {
    return this.clock().toISOString();
  }
  list(input?: {
    projectId?: string | null;
    status?: "active" | "archived";
    cursor?: string | null;
    limit?: number;
  }) {
    return this.chats.list(input);
  }
  get(id: string) {
    return this.chats.require(id);
  }
  create(value: unknown) {
    const v = CreateChatRequestSchema.parse(value);
    const projectId = v.projectId ?? null;
    if (projectId) this.projects.requireActive(projectId);
    if (v.modelProfileId) this.profiles.requireEnabled(v.modelProfileId);
    return this.chats.create({
      id: randomUUID(),
      projectId,
      title: v.title ?? "新对话",
      modelProfileId: v.modelProfileId ?? null,
      now: this.now(),
    });
  }
  update(id: string, value: unknown) {
    const v = UpdateChatRequestSchema.parse(value);
    if (v.modelProfileId) this.profiles.requireEnabled(v.modelProfileId);
    return this.chats.update(id, { ...v, now: this.now() });
  }
  archive(id: string) {
    return this.chats.update(id, { status: "archived", now: this.now() });
  }
  delete(id: string) {
    this.chats.delete(id);
  }
  addMessage(
    chatId: string,
    role: "system" | "user" | "assistant" | "tool",
    value: unknown,
  ) {
    const v = CreateChatMessageRequestSchema.parse(value);
    if (v.modelProfileId) this.profiles.requireEnabled(v.modelProfileId);
    return this.chats.createMessage({
      id: randomUUID(),
      chatId,
      role,
      content: v.content,
      modelProfileId: v.modelProfileId ?? null,
      now: this.now(),
    });
  }
  updateMessage(
    id: string,
    status:
      | "pending"
      | "streaming"
      | "complete"
      | "failed"
      | "cancelled"
      | "interrupted",
    content?: string,
  ) {
    return this.chats.updateMessage(id, { status, content, now: this.now() });
  }
  messages(chatId: string) {
    return this.chats.messages(chatId);
  }
  sources(messageId: string) {
    return this.chats.sources(messageId);
  }
  addSource(
    messageId: string,
    input: {
      documentId: string;
      versionId: string;
      chunkId?: string | null;
      quote?: string | null;
      startOffset?: number | null;
      endOffset?: number | null;
    },
  ) {
    return this.chats.addSource({
      id: randomUUID(),
      messageId,
      ...input,
      chunkId: input.chunkId ?? null,
      quote: input.quote ?? null,
      startOffset: input.startOffset ?? null,
      endOffset: input.endOffset ?? null,
      now: this.now(),
    });
  }
}
