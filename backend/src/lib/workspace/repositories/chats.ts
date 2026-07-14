import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import {
  normalizePageRequest,
  type Page,
  type PageRequest,
} from "../pagination";
import type { Chat, ChatMessage, MessageSource } from "../types";
type Row = Record<string, unknown>;
const chat = (r: Row): Chat => ({
  id: String(r.id),
  projectId: r.project_id == null ? null : String(r.project_id),
  scope: r.scope as Chat["scope"],
  title: String(r.title),
  status: r.status as Chat["status"],
  modelProfileId:
    r.model_profile_id == null ? null : String(r.model_profile_id),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});
const message = (r: Row): ChatMessage => ({
  id: String(r.id),
  chatId: String(r.chat_id),
  role: r.role as ChatMessage["role"],
  content: String(r.content),
  status: r.status as ChatMessage["status"],
  modelProfileId:
    r.model_profile_id == null ? null : String(r.model_profile_id),
  jobId: r.job_id == null ? null : String(r.job_id),
  createdAt: String(r.created_at),
  completedAt: r.completed_at == null ? null : String(r.completed_at),
});
const source = (r: Row): MessageSource => ({
  id: String(r.id),
  messageId: String(r.message_id),
  documentId: String(r.document_id),
  versionId: String(r.version_id),
  chunkId: r.chunk_id == null ? null : String(r.chunk_id),
  quote: r.quote == null ? null : String(r.quote),
  startOffset: r.start_offset == null ? null : Number(r.start_offset),
  endOffset: r.end_offset == null ? null : Number(r.end_offset),
  createdAt: String(r.created_at),
});
export class ChatsRepository {
  constructor(readonly database: WorkspaceDatabaseAdapter) {}
  private tx<T>(fn: () => T) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      this.database.exec("COMMIT");
      return v;
    } catch (e) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }
  get(id: string) {
    const r = this.database.prepare("SELECT * FROM chats WHERE id=?").get(id);
    return r ? chat(r) : null;
  }
  require(id: string) {
    const v = this.get(id);
    if (!v) throw new WorkspaceApiError(404, "NOT_FOUND", "Chat not found.");
    return v;
  }
  list(
    input: PageRequest & {
      projectId?: string | null;
      status?: Chat["status"];
    } = {},
  ): Page<Chat> {
    const page = normalizePageRequest(input);
    let cursor: { updatedAt: string; id: string } | null = null;
    if (page.cursor) {
      try {
        const parsed = JSON.parse(
          Buffer.from(page.cursor, "base64url").toString("utf8"),
        );
        if (
          typeof parsed.updatedAt !== "string" ||
          typeof parsed.id !== "string"
        )
          throw new Error();
        cursor = parsed;
      } catch {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "Invalid pagination cursor.",
        );
      }
    }
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (input.projectId !== undefined) {
      clauses.push("project_id IS ?");
      params.push(input.projectId);
    }
    if (input.status) {
      clauses.push("status=?");
      params.push(input.status);
    }
    if (cursor) {
      clauses.push("(updated_at < ? OR (updated_at=? AND id<?))");
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM chats ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY updated_at DESC,id DESC LIMIT ?`,
      )
      .all(...params, page.limit + 1);
    const items = rows.slice(0, page.limit).map(chat);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > page.limit && last
          ? Buffer.from(
              JSON.stringify({ updatedAt: last.updatedAt, id: last.id }),
            ).toString("base64url")
          : null,
    };
  }
  create(input: {
    id: string;
    projectId: string | null;
    title: string;
    modelProfileId: string | null;
    now: string;
  }) {
    const scope = input.projectId ? "project" : "global";
    this.database
      .prepare(
        "INSERT INTO chats (id,project_id,scope,title,model_profile_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        input.id,
        input.projectId,
        scope,
        input.title,
        input.modelProfileId,
        input.now,
        input.now,
      );
    return this.require(input.id);
  }
  update(
    id: string,
    input: {
      title?: string;
      status?: Chat["status"];
      modelProfileId?: string | null;
      now: string;
    },
  ) {
    const c = this.require(id);
    this.database
      .prepare(
        "UPDATE chats SET title=?,status=?,model_profile_id=?,updated_at=? WHERE id=?",
      )
      .run(
        input.title ?? c.title,
        input.status ?? c.status,
        input.modelProfileId === undefined
          ? c.modelProfileId
          : input.modelProfileId,
        input.now,
        id,
      );
    return this.require(id);
  }
  delete(id: string) {
    this.require(id);
    this.database.prepare("DELETE FROM chats WHERE id=?").run(id);
  }
  createMessage(input: {
    id: string;
    chatId: string;
    role: ChatMessage["role"];
    content: string;
    modelProfileId: string | null;
    now: string;
  }) {
    return this.tx(() => {
      this.require(input.chatId);
      const row = this.database
        .prepare(
          "SELECT coalesce(max(sequence),-1)+1 AS sequence FROM chat_messages WHERE chat_id=?",
        )
        .get(input.chatId)!;
      const sequence = Number(row.sequence);
      this.database
        .prepare(
          "INSERT INTO chat_messages (id,chat_id,sequence,role,content,model_profile_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          input.id,
          input.chatId,
          sequence,
          input.role,
          input.content,
          input.modelProfileId,
          input.now,
          input.now,
        );
      this.database
        .prepare("UPDATE chats SET updated_at=? WHERE id=?")
        .run(input.now, input.chatId);
      return message(
        this.database
          .prepare("SELECT * FROM chat_messages WHERE id=?")
          .get(input.id)!,
      );
    });
  }
  updateMessage(
    id: string,
    input: { status: ChatMessage["status"]; content?: string; now: string },
  ) {
    const row = this.database
      .prepare("SELECT * FROM chat_messages WHERE id=?")
      .get(id);
    if (!row)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Message not found.");
    const prior = row.status as ChatMessage["status"];
    const allowed: Record<ChatMessage["status"], ChatMessage["status"][]> = {
      pending: ["streaming", "complete", "failed", "cancelled", "interrupted"],
      streaming: ["complete", "failed", "cancelled", "interrupted"],
      complete: [],
      failed: [],
      cancelled: [],
      interrupted: [],
    };
    if (!allowed[prior].includes(input.status))
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Message status transition is not allowed.",
      );
    const completed = [
      "complete",
      "failed",
      "cancelled",
      "interrupted",
    ].includes(input.status)
      ? input.now
      : null;
    this.database
      .prepare(
        "UPDATE chat_messages SET status=?,content=?,updated_at=?,completed_at=? WHERE id=?",
      )
      .run(
        input.status,
        input.content ?? String(row.content),
        input.now,
        completed,
        id,
      );
    return message(
      this.database.prepare("SELECT * FROM chat_messages WHERE id=?").get(id)!,
    );
  }
  messages(chatId: string) {
    this.require(chatId);
    return this.database
      .prepare(
        "SELECT * FROM chat_messages WHERE chat_id=? ORDER BY sequence ASC",
      )
      .all(chatId)
      .map(message);
  }
  addSource(input: {
    id: string;
    messageId: string;
    documentId: string;
    versionId: string;
    chunkId: string | null;
    quote: string | null;
    startOffset: number | null;
    endOffset: number | null;
    now: string;
  }) {
    const context = this.database
      .prepare(
        `SELECT c.project_id chat_project_id,d.project_id document_project_id
           FROM chat_messages m
           JOIN chats c ON c.id=m.chat_id
           JOIN documents d ON d.id=? AND d.deleted_at IS NULL
           JOIN document_versions v
             ON v.id=? AND v.document_id=d.id AND v.deleted_at IS NULL
          WHERE m.id=?`,
      )
      .get(input.documentId, input.versionId, input.messageId);
    if (!context)
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Source document/version/message relationship is invalid.",
      );
    if (context.chat_project_id == null && context.document_project_id != null)
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Global chat sources must be standalone documents.",
      );
    if (
      context.chat_project_id != null &&
      String(context.chat_project_id) !== String(context.document_project_id)
    )
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Project chat sources must belong to its project.",
      );
    if (input.chunkId) {
      const chunk = this.database
        .prepare(
          "SELECT id FROM document_chunks WHERE id=? AND document_id=? AND version_id=?",
        )
        .get(input.chunkId, input.documentId, input.versionId);
      if (!chunk)
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Source chunk relationship is invalid.",
        );
    }
    this.database
      .prepare(
        "INSERT INTO message_sources (id,message_id,document_id,version_id,chunk_id,quote,start_offset,end_offset,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        input.id,
        input.messageId,
        input.documentId,
        input.versionId,
        input.chunkId,
        input.quote,
        input.startOffset,
        input.endOffset,
        input.now,
      );
    return source(
      this.database
        .prepare("SELECT * FROM message_sources WHERE id=?")
        .get(input.id)!,
    );
  }
  sources(messageId: string) {
    const row = this.database
      .prepare("SELECT id FROM chat_messages WHERE id=?")
      .get(messageId);
    if (!row)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Message not found.");
    return this.database
      .prepare(
        "SELECT * FROM message_sources WHERE message_id=? ORDER BY rank ASC,id ASC",
      )
      .all(messageId)
      .map(source);
  }
}
