import assert from "node:assert/strict";

import {
  assertMikeSafePayload,
  MIKE_LOCAL_USER_ID,
  MIKE_SSE_HEADERS,
  MikeChatDetailSchema,
  MikeAssistantEventSchema,
  MikeDocumentInputSchema,
  MikeDocumentVersionSchema,
  MikeErrorSchema,
  MikeCompatibilityError,
  MikeProjectCreateSchema,
  MikeSseEventSchema,
  MikeTabularCellSchema,
  MikeTabularCreateSchema,
  MikeWorkflowCreateSchema,
  MikeWorkflowSchema,
  mikeError,
  mikeSseDone,
  mikeSseFrame,
  fromMikeTabularFormat,
  fromMikeTabularStatus,
  mikeFileTypeFor,
  parseMikeAssistantEvent,
  parseMikeChatDetail,
  parseMikeSseEvent,
  parseMikeProjectCreate,
  serializeMikeDocument,
  serializeMikeDocumentVersion,
  serializeMikeProject,
  serializeMikeTabularCell,
  serializeMikeWorkflow,
  toMikeTabularFormat,
  toMikeTabularStatus,
} from "../lib/workspace/mikeCompatibility";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const now = "2026-07-14T00:00:00.000Z";

function accepts(
  schema: { safeParse(value: unknown): { success: boolean } },
  value: unknown,
  detail: string,
) {
  assert.equal(schema.safeParse(value).success, true, detail);
}

function rejects(
  schema: { safeParse(value: unknown): { success: boolean } },
  value: unknown,
  detail: string,
) {
  assert.equal(schema.safeParse(value).success, false, detail);
}

function run() {
  const legacySentinel = Object.freeze({ legacy_marker: "must-not-change" });
  const project = serializeMikeProject({
    id,
    name: "Compatibility workspace",
    cmNumber: "CM-42",
    practice: "Corporate",
    createdAt: now,
    updatedAt: now,
    documentCount: 1,
    chatCount: 2,
    reviewCount: 3,
  });
  assert.deepEqual(Object.keys(project).sort(), [
    "chat_count",
    "cm_number",
    "created_at",
    "document_count",
    "documents",
    "folders",
    "id",
    "is_owner",
    "name",
    "owner_display_name",
    "owner_email",
    "practice",
    "review_count",
    "shared_with",
    "updated_at",
    "user_id",
  ]);
  assert.equal(project.user_id, MIKE_LOCAL_USER_ID);
  assert.equal(
    /^\w{8}-(?:\w{4}-){3}\w{12}$/.test(project.user_id),
    true,
    "local principal is a UUID",
  );
  assert.equal(project.cm_number, "CM-42");
  assert.equal(project.practice, "Corporate");
  assert.equal(project.is_owner, true);
  assert.deepEqual(project.shared_with, []);
  assert.equal(legacySentinel.legacy_marker, "must-not-change");
  accepts(
    MikeProjectCreateSchema,
    {
      name: "A local project",
      description: "A reusable local workspace",
      shared_with: [],
    },
    "empty sharing and the Vera local description extension are accepted",
  );
  rejects(
    MikeProjectCreateSchema,
    { name: "A local project", shared_with: ["other@example.test"] },
    "sharing is unsupported",
  );
  assert.throws(
    () =>
      parseMikeProjectCreate({
        name: "A local project",
        shared_with: ["other@example.test"],
      }),
    (error: unknown) =>
      error instanceof MikeCompatibilityError && error.code === "UNSUPPORTED",
  );
  rejects(
    MikeProjectCreateSchema,
    { name: "A local project", user_id: id },
    "project input is strict",
  );

  const document = serializeMikeDocument({
    id,
    projectId: otherId,
    folderId: null,
    filename: "source.pdf",
    mimeType: "application/pdf",
    sizeBytes: 42,
    pageCount: 4,
    status: "ocr_required",
    createdAt: now,
    updatedAt: now,
    activeVersionNumber: 1,
    latestVersionNumber: 2,
    hasPreview: true,
  });
  assert.equal(document.status, "error");
  assert.equal(document.storage_path, null);
  assert.equal(document.pdf_storage_path, "local-preview");
  assert.equal(document.file_type, "pdf");
  assert.equal(document.page_count, 4);
  assert.equal(document.latest_version_number, 2);
  assert.equal(mikeFileTypeFor("source.pdf", "application/pdf"), "pdf");
  assert.equal(mikeFileTypeFor("notes.md", "text/markdown"), "md");
  assert.equal(
    mikeFileTypeFor("misleading.doc", "application/pdf"),
    null,
    "conflicting filename/MIME is not guessed",
  );
  assert.equal(mikeFileTypeFor("no-extension", "application/pdf"), "pdf");
  const version = serializeMikeDocumentVersion({
    id: otherId,
    versionNumber: 2,
    source: "upload",
    filename: "source.pdf",
    mimeType: "application/pdf",
    sizeBytes: 42,
    pageCount: 4,
    createdAt: now,
    deletedAt: null,
    deletedBy: null,
  });
  accepts(MikeDocumentVersionSchema, version, "version is path-free Mike wire");
  assert.deepEqual(Object.keys(version).sort(), [
    "created_at",
    "deleted_at",
    "deleted_by",
    "file_type",
    "filename",
    "id",
    "page_count",
    "size_bytes",
    "source",
    "version_number",
  ]);
  rejects(
    MikeDocumentVersionSchema,
    { ...version, storage_path: "/private/file" },
    "version wire never accepts a storage path",
  );
  rejects(
    MikeDocumentInputSchema,
    { filename: "source.pdf", storage_path: "/tmp/source.pdf" },
    "path input is rejected",
  );
  rejects(
    MikeDocumentInputSchema,
    { filename: "source.pdf", api_key: "secret" },
    "secret input is rejected",
  );

  const validDetail = {
    chat: {
      id,
      project_id: null,
      user_id: MIKE_LOCAL_USER_ID,
      title: "New chat",
      created_at: now,
    },
    messages: [
      {
        id: otherId,
        chat_id: id,
        role: "assistant",
        content: [{ type: "content", text: "Answer" }],
        files: [{ filename: "source.pdf", document_id: id }],
        citations: [
          {
            type: "citation_data",
            kind: "document",
            ref: 1,
            doc_id: "source.pdf",
            document_id: id,
            filename: "source.pdf",
            quote: "Relevant excerpt",
            page: 1,
          },
        ],
        created_at: now,
      },
    ],
  };
  accepts(
    MikeChatDetailSchema,
    validDetail,
    "assistant events and files/citations are supported",
  );
  rejects(
    MikeChatDetailSchema,
    {
      ...validDetail,
      messages: [
        {
          ...validDetail.messages[0],
          citations: [
            { ...validDetail.messages[0].citations[0], ref: 0 },
          ],
        },
      ],
    },
    "citation refs are one-based",
  );
  rejects(
    MikeChatDetailSchema,
    {
      ...validDetail,
      messages: [
        {
          ...validDetail.messages[0],
          content: [{ type: "mcp_tool_call", text: "no" }],
        },
      ],
    },
    "MCP event is rejected",
  );
  rejects(
    MikeChatDetailSchema,
    {
      ...validDetail,
      messages: [
        {
          ...validDetail.messages[0],
          content: [{ type: "content", text: "no", court_listener: true }],
        },
      ],
    },
    "CourtListener field is rejected",
  );
  rejects(
    MikeChatDetailSchema,
    { ...validDetail, extra: true },
    "chat payload is strict",
  );
  rejects(
    MikeChatDetailSchema,
    {
      ...validDetail,
      messages: [
        {
          ...validDetail.messages[0],
          citations: [
            {
              ...validDetail.messages[0].citations[0],
              secret: "sk-abcdefghijklmnopqrstuvwxyz",
            },
          ],
        },
      ],
    },
    "citations have a strict safe shape",
  );
  rejects(
    MikeChatDetailSchema,
    {
      ...validDetail,
      messages: [
        {
          ...validDetail.messages[0],
          citations: [
            {
              ...validDetail.messages[0].citations[0],
              doc_id: undefined,
            },
          ],
        },
      ],
    },
    "document citations require doc_id and page",
  );
  assert.throws(
    () =>
      parseMikeChatDetail({
        ...validDetail,
        messages: [
          {
            ...validDetail.messages[0],
            citations: [
              {
                ...validDetail.messages[0].citations[0],
                quote: "/tmp/private-quote",
              },
            ],
          },
        ],
      }),
    /Unsafe/,
  );
  assert.throws(
    () =>
      parseMikeAssistantEvent({
        type: "doc_edited",
        filename: "source.pdf",
        document_id: id,
        version_id: otherId,
        download_url: "/api/v1/downloads/1234567890abcdef",
        annotations: [
          {
            edit_id: id,
            document_id: id,
            version_id: otherId,
            change_id: otherId,
            del_w_id: "d",
            ins_w_id: "i",
            deleted_text: "Bearer secret",
            inserted_text: "replacement",
            status: "pending",
          },
        ],
      }),
    /Unsafe/,
  );
  accepts(
    MikeAssistantEventSchema,
    {
      type: "doc_download",
      filename: "source.pdf",
      download_url: "/api/v1/downloads/1234567890abcdef",
    },
    "download URLs use opaque loopback tokens",
  );
  rejects(
    MikeAssistantEventSchema,
    {
      type: "doc_download",
      filename: "source.pdf",
      download_url: "file:///tmp/source.pdf",
    },
    "file URLs are rejected",
  );
  rejects(
    MikeAssistantEventSchema,
    {
      type: "doc_download",
      filename: "source.pdf",
      download_url: "/api/v1/download",
    },
    "fixed download URLs without a token are rejected",
  );
  assert.throws(
    () =>
      parseMikeAssistantEvent({
        type: "doc_download",
        filename: "source.pdf",
        download_url: "https://example.test/download",
      }),
    /Invalid|invalid/i,
  );

  const event = {
    type: "content_delta",
    text: "Answer",
  } as const;
  accepts(
    MikeSseEventSchema,
    event,
    "SSE events are separate from persisted assistant events",
  );
  rejects(MikeSseEventSchema, { type: "mcp_tool_call" }, "MCP SSE is rejected");
  rejects(
    MikeSseEventSchema,
    { type: "courtlistener_search_case_law" },
    "CourtListener SSE is rejected",
  );
  for (const sse of [
    { type: "chat_id", chatId: id },
    { type: "content_done" },
    { type: "reasoning_delta", text: "Think" },
    { type: "reasoning_block_end" },
    { type: "tool_call_start", name: "read_document" },
    {
      type: "workflow_applied",
      workflow_id: otherId,
      title: "Extract",
    },
    {
      type: "citations",
      status: "final",
      citations: validDetail.messages[0].citations,
    },
    { type: "error", message: "Failed" },
    {
      type: "cell_update",
      document_id: id,
      column_index: 0,
      content: { summary: "Done", flag: "green", reasoning: "Reviewed" },
      status: "done",
    },
    { type: "chat_title", chatId: id, title: "New title" },
  ])
    accepts(MikeSseEventSchema, sse, `SSE ${sse.type} is supported`);
  rejects(
    MikeSseEventSchema,
    { type: "content_delta", text: "legacy", chat_id: id },
    "per-frame chat_id is rejected",
  );
  rejects(
    MikeSseEventSchema,
    { type: "content_delta", content_delta: "legacy" },
    "legacy content_delta field is rejected",
  );
  rejects(
    MikeSseEventSchema,
    { type: "error", detail: "legacy" },
    "error.detail is rejected",
  );
  rejects(
    MikeSseEventSchema,
    {
      type: "cell_update",
      review_id: otherId,
      document_id: id,
      column_index: 0,
      content: null,
      status: "done",
    },
    "cell review_id is rejected",
  );
  assert.throws(
    () =>
      parseMikeSseEvent({
        type: "content_delta",
        text: "sk-abcdefghijklmnopqrstuvwxyz",
      }),
    /Unsafe/,
  );
  assert.deepEqual(
    Buffer.from(mikeSseFrame(event)),
    Buffer.from('data: {"type":"content_delta","text":"Answer"}\n\n'),
  );
  assert.deepEqual(Buffer.from(mikeSseDone()), Buffer.from("data: [DONE]\n\n"));
  assert.deepEqual(MIKE_SSE_HEADERS, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const workflow = serializeMikeWorkflow({
    id,
    title: "Extract",
    type: "tabular",
    createdAt: now,
    isSystem: true,
  });
  accepts(
    MikeWorkflowSchema,
    workflow,
    "workflow preserves nested Mike metadata",
  );
  assert.equal(workflow.is_owner, false);
  assert.equal(workflow.is_system, true);
  assert.equal(workflow.user_id, null);
  accepts(
    MikeWorkflowCreateSchema,
    {
      metadata: { title: "Blank", type: "tabular" },
      skill_md: "",
      columns_config: [],
    },
    "empty workflow skill and columns are allowed",
  );
  rejects(
    MikeWorkflowCreateSchema,
    {
      metadata: { title: "Blank", type: "tabular" },
      columns_config: [],
      unknown: true,
    },
    "workflow creation is strict",
  );

  const cell = serializeMikeTabularCell({
    id,
    reviewId: otherId,
    documentId: id,
    columnIndex: 0,
    summary: "No issue",
    status: "cancelled",
    createdAt: now,
  });
  accepts(
    MikeTabularCellSchema,
    cell,
    "tabular cell uses Mike content projection",
  );
  assert.equal(cell.status, "error");
  const completedCell = serializeMikeTabularCell({
    id,
    reviewId: otherId,
    documentId: id,
    columnIndex: 0,
    summary: "Done",
    flag: "green",
    status: "ready",
    createdAt: now,
  });
  assert.equal(completedCell.status, "done");
  assert.equal(completedCell.content?.flag, "green");
  for (const format of [
    "text",
    "bulleted_list",
    "number",
    "percentage",
    "monetary_amount",
    "currency",
    "yes_no",
    "date",
    "tag",
  ] as const) {
    assert.equal(
      fromMikeTabularFormat(toMikeTabularFormat(format)),
      format,
      `format ${format} round-trips`,
    );
  }
  const statusMap = {
    pending: "pending",
    processing: "generating",
    ready: "done",
    failed: "error",
    cancelled: "error",
  } as const;
  for (const [workspace, mike] of Object.entries(statusMap) as Array<
    [keyof typeof statusMap, (typeof statusMap)[keyof typeof statusMap]]
  >) {
    assert.equal(
      toMikeTabularStatus(workspace),
      mike,
      `status ${workspace} maps to Mike`,
    );
  }
  assert.equal(fromMikeTabularStatus("generating"), "processing");
  assert.equal(fromMikeTabularStatus("done"), "ready");
  assert.equal(fromMikeTabularStatus("error"), "failed");
  assert.equal(fromMikeTabularStatus("pending"), "pending");
  accepts(
    MikeTabularCreateSchema,
    { document_ids: [], columns_config: [] },
    "empty tabular create is allowed",
  );
  rejects(
    MikeTabularCreateSchema,
    {
      document_ids: [],
      columns_config: [],
      shared_with: ["other@example.test"],
    },
    "tabular sharing is unsupported",
  );
  rejects(
    MikeTabularCreateSchema,
    {
      document_ids: [],
      columns_config: [{ index: 0, name: "X", prompt: "Y", format: "unsafe" }],
    },
    "column format is constrained",
  );

  const error = mikeError("Not available", "UNSUPPORTED", {
    error: { code: "UNSUPPORTED", message: "Not available" },
  });
  accepts(
    MikeErrorSchema,
    error,
    "Mike top-level error remains compatible with standard error envelope",
  );
  assert.deepEqual(Object.keys(error).sort(), ["code", "detail", "error"]);
  assert.throws(
    () =>
      assertMikeSafePayload({ nested: [{ storage_path: "/private/file" }] }),
    /Unsafe/,
  );
  assert.throws(
    () => assertMikeSafePayload({ credentialRef: "secret" }),
    /Unsafe/,
  );
  assert.doesNotThrow(() =>
    assertMikeSafePayload({
      storage_path: null,
      pdf_storage_path: "local-preview",
    }),
  );
  assert.throws(
    () => assertMikeSafePayload({ nested: { quote: "/tmp/private-note" } }),
    /Unsafe/,
  );
  assert.throws(
    () => assertMikeSafePayload({ nested: { annotation: "Bearer secret" } }),
    /Unsafe/,
  );

  console.log("vera Mike compatibility audit passed");
}

run();
