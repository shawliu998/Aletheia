import assert from "node:assert/strict";

import {
  ApiErrorSchema,
  CreateChatMessageRequestSchema,
  CreateChatRequestSchema,
  CreateDocumentRequestSchema,
  CreateModelProfileRequestSchema,
  CreateProjectRequestSchema,
  CreateTabularReviewRequestSchema,
  CreateWorkflowRequestSchema,
  DocumentChunkSchema,
  DocumentStatusSchema,
  DocumentVersionSchema,
  GenerateTabularCellRequestSchema,
  JobSchema,
  JobStatusSchema,
  JobTypeSchema,
  ModelProviderSchema,
  ModelProfileSchema,
  PageRequestSchema,
  ProjectSchema,
  TabularCellSchema,
  TabularReviewSchema,
  TabularReviewStatusSchema,
  UpdateModelProfileRequestSchema,
  UpdateWorkflowRequestSchema,
  WorkflowSchema,
  WorkflowRunSchema,
  WorkflowStepRunSchema,
  WorkflowStepSchema,
} from "../lib/workspace/contracts";
import {
  MAX_PAGE_SIZE,
  normalizePageRequest,
} from "../lib/workspace/pagination";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-07-14T00:00:00.000Z";

function rejects(
  schema: { safeParse(value: unknown): { success: boolean } },
  value: unknown,
  message: string,
) {
  assert.equal(schema.safeParse(value).success, false, message);
}

function accepts(
  schema: { safeParse(value: unknown): { success: boolean } },
  value: unknown,
  message: string,
) {
  assert.equal(schema.safeParse(value).success, true, message);
}

function run() {
  accepts(
    CreateProjectRequestSchema,
    { name: "Contract workspace" },
    "project create accepts Mike name semantics",
  );
  rejects(
    CreateProjectRequestSchema,
    { title: "Wrong vocabulary" },
    "project create rejects title in place of name",
  );
  rejects(
    CreateProjectRequestSchema,
    { name: "Contract workspace", id },
    "server generates project IDs",
  );
  rejects(
    CreateProjectRequestSchema,
    { name: "Contract workspace", userId: id },
    "requests never accept user IDs",
  );

  accepts(
    ProjectSchema,
    {
      id,
      name: "Contract workspace",
      description: null,
      cmNumber: null,
      practice: null,
      status: "active",
      defaultModelProfileId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    },
    "project response is a path-free public projection",
  );
  rejects(
    ProjectSchema,
    {
      id,
      name: "Contract workspace",
      description: null,
      cmNumber: null,
      practice: null,
      status: "active",
      defaultModelProfileId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
      storagePath: "/private/workspace.db",
    },
    "responses reject accidental storage path exposure",
  );

  accepts(
    DocumentVersionSchema,
    {
      id,
      documentId: otherId,
      versionNumber: 1,
      source: "upload",
      filename: "input.pdf",
      mimeType: "application/pdf",
      sizeBytes: 12,
      contentSha256: "a".repeat(64),
      pageCount: 1,
      createdAt: timestamp,
    },
    "document versions expose page count without a storage location",
  );
  accepts(
    DocumentVersionSchema,
    {
      id,
      documentId: otherId,
      versionNumber: 2,
      source: "user_accept",
      filename: "accepted.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 0,
      contentSha256: "b".repeat(64),
      pageCount: 0,
      createdAt: timestamp,
    },
    "document versions preserve Mike edit sources and zero-page metadata",
  );
  accepts(
    DocumentChunkSchema,
    {
      id,
      documentId: otherId,
      versionId: id,
      ordinal: 0,
      text: "A bounded extracted segment.",
      startOffset: 0,
      endOffset: 28,
      pageStart: 1,
      pageEnd: 1,
      metadata: {},
      createdAt: timestamp,
    },
    "document chunks expose an inclusive page range",
  );

  accepts(
    CreateDocumentRequestSchema,
    {
      projectId: id,
      title: "Input document",
      filename: "input.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    },
    "document metadata accepts opaque parent ID only",
  );
  rejects(
    CreateDocumentRequestSchema,
    {
      title: "Input document",
      filename: "input.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      storagePath: "/tmp/injected",
    },
    "document request rejects storagePath injection",
  );
  rejects(
    CreateDocumentRequestSchema,
    {
      title: "Input document",
      filename: "input.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      absolutePath: "/tmp/injected",
    },
    "document request rejects absolute path injection",
  );

  accepts(
    PageRequestSchema,
    { cursor: "next", limit: MAX_PAGE_SIZE },
    "pagination accepts its documented upper bound",
  );
  rejects(PageRequestSchema, { limit: 0 }, "pagination rejects zero limit");
  rejects(
    PageRequestSchema,
    { limit: MAX_PAGE_SIZE + 1 },
    "pagination rejects oversized limit",
  );
  assert.deepEqual(normalizePageRequest({}), { cursor: null, limit: 50 });
  assert.throws(
    () => normalizePageRequest({ limit: MAX_PAGE_SIZE + 1 }),
    RangeError,
  );

  accepts(
    DocumentStatusSchema,
    "ocr_required",
    "document parse status retains OCR-required state",
  );
  rejects(
    DocumentStatusSchema,
    "completed",
    "document parse status does not use legacy completed state",
  );
  accepts(
    JobTypeSchema,
    "assistant_generate",
    "job type uses Mike Assistant vocabulary",
  );
  rejects(
    JobTypeSchema,
    "chat_generation",
    "job type rejects pre-baseline spelling",
  );
  accepts(JobStatusSchema, "complete", "job completion uses complete");
  rejects(JobStatusSchema, "completed", "job completion rejects completed");
  accepts(
    TabularReviewStatusSchema,
    "cancelled",
    "tabular review retains explicit cancellation state",
  );
  rejects(
    ModelProviderSchema,
    "local",
    "model provider does not advertise a pseudo-provider",
  );

  accepts(
    CreateModelProfileRequestSchema,
    {
      name: "Provider profile",
      provider: "openai",
      model: "example-model",
      baseUrl: "https://api.example.test/v1",
      enabled: true,
    },
    "model profile accepts non-secret configuration",
  );
  rejects(
    CreateModelProfileRequestSchema,
    {
      name: "Provider profile",
      provider: "openai",
      model: "example-model",
      apiKey: "not-allowed",
    },
    "model profile rejects API keys",
  );
  rejects(
    CreateModelProfileRequestSchema,
    {
      name: "Provider profile",
      provider: "openai",
      model: "example-model",
      baseUrl: "file:///tmp/provider",
    },
    "model profile rejects filesystem URLs",
  );
  rejects(
    CreateModelProfileRequestSchema,
    {
      name: "Provider profile",
      provider: "openai",
      model: "example-model",
      baseUrl: "ftp://example.test/provider",
    },
    "model profile rejects dangerous non-HTTP schemes",
  );
  rejects(
    CreateModelProfileRequestSchema,
    {
      name: "Provider profile",
      provider: "openai",
      model: "example-model",
      baseUrl: "http://example.com/v1",
    },
    "model profile rejects non-loopback HTTP",
  );
  rejects(
    CreateModelProfileRequestSchema,
    {
      name: "Provider profile",
      provider: "openai",
      model: "example-model",
      baseUrl: "https://user:password@example.test/v1",
    },
    "model profile rejects URL credentials",
  );
  rejects(
    CreateModelProfileRequestSchema,
    {
      name: "Provider profile",
      provider: "openai",
      model: "example-model",
      baseUrl: "https://api.example.test/v1?api_key=hidden",
    },
    "model profile rejects base URL query parameters",
  );
  rejects(
    CreateModelProfileRequestSchema,
    {
      name: "Provider profile",
      provider: "openai",
      model: "example-model",
      baseUrl: "https://api.example.test/v1#credential",
    },
    "model profile rejects base URL fragments",
  );
  rejects(
    CreateModelProfileRequestSchema,
    {
      name: "Provider profile",
      provider: "openai",
      model: "example-model",
      credentialRef: "not-allowed",
    },
    "model profile rejects credential references from the renderer",
  );
  accepts(
    CreateModelProfileRequestSchema,
    {
      name: "Local development profile",
      provider: "openai_compatible",
      model: "example-model",
      baseUrl: "http://localhost:11434/v1",
      enabled: false,
    },
    "model profile permits loopback HTTP for later explicit dev-mode service checks",
  );
  accepts(
    UpdateModelProfileRequestSchema,
    { enabled: false },
    "model profiles can be explicitly disabled without a credential mutation",
  );
  accepts(
    ModelProfileSchema,
    {
      id,
      name: "Provider profile",
      provider: "openai",
      model: "example-model",
      baseUrl: "https://api.example.test/v1",
      credentialStatus: "configured",
      contextWindowTokens: 1000,
      maxOutputTokens: 500,
      enabled: true,
      capabilities: {
        streaming: true,
        toolCalling: false,
        structuredOutput: true,
        vision: false,
      },
      isDefault: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    "model profiles expose only non-secret capabilities",
  );

  accepts(
    CreateChatRequestSchema,
    { projectId: id, modelProfileId: otherId },
    "chat creates use existing opaque references",
  );
  rejects(
    CreateChatRequestSchema,
    { projectId: id, secret: "not-allowed" },
    "chat request rejects secret injection",
  );
  rejects(
    CreateChatMessageRequestSchema,
    { content: "hello", userId: id },
    "chat message rejects user ID injection",
  );

  accepts(
    WorkflowStepSchema,
    {
      kind: "prompt",
      title: "Summarise",
      prompt: "Summarise selected documents.",
    },
    "prompt workflow step parses",
  );
  accepts(
    WorkflowStepSchema,
    {
      kind: "tabular_column",
      title: "Disposition",
      outputType: "enum",
      prompt: "Classify the record.",
      enumValues: ["yes", "no"],
    },
    "tabular workflow enum step parses",
  );
  rejects(
    WorkflowStepSchema,
    {
      kind: "shell",
      title: "Unsafe",
      command: "rm -rf /",
    },
    "workflow step rejects dynamic execution",
  );
  rejects(
    WorkflowStepSchema,
    {
      kind: "tabular_column",
      title: "Missing enum options",
      outputType: "enum",
      prompt: "Classify.",
    },
    "enum workflow step requires enum values",
  );
  accepts(
    CreateWorkflowRequestSchema,
    {
      type: "assistant",
      title: "Assistant workflow",
      projectId: id,
      language: "English",
      practice: "Corporate",
      jurisdictions: ["England and Wales"],
      metadata: { version: "draft-1", reviewed: false },
    },
    "assistant workflow accepts a project-bound empty Mike draft",
  );
  accepts(
    CreateWorkflowRequestSchema,
    {
      type: "tabular",
      title: "Tabular workflow",
    },
    "tabular workflow accepts an empty Mike draft",
  );
  accepts(
    UpdateWorkflowRequestSchema,
    {
      projectId: null,
      skillMarkdown: "",
      steps: [],
    },
    "workflow update can unbind a project and preserve an empty draft",
  );
  accepts(
    WorkflowSchema,
    {
      id,
      type: "assistant",
      projectId: otherId,
      title: "Assistant workflow",
      description: null,
      status: "active",
      skillMarkdown: "",
      steps: [],
      language: "English",
      practice: "Corporate",
      jurisdictions: ["England and Wales"],
      metadata: { version: "draft-1", reviewed: false },
      isBuiltin: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    "workflow transport round-trips project and safe Mike metadata",
  );
  rejects(
    WorkflowSchema,
    {
      id,
      type: "assistant",
      projectId: null,
      title: "Unsafe workflow",
      description: null,
      status: "active",
      skillMarkdown: "",
      steps: [],
      language: "English",
      practice: "General Transactions",
      jurisdictions: [],
      metadata: { storagePath: "/private/workflow" },
      isBuiltin: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    "workflow metadata rejects path-bearing keys",
  );
  accepts(
    WorkflowRunSchema,
    {
      id,
      workflowId: otherId,
      projectId: null,
      status: "waiting",
      modelProfileId: null,
      jobId: null,
      input: { selectedDocumentCount: 2 },
      output: null,
      startedAt: null,
      completedAt: null,
      error: null,
      createdAt: timestamp,
    },
    "workflow runs persist safe input and waiting state",
  );
  rejects(
    WorkflowStepRunSchema,
    {
      id,
      workflowRunId: otherId,
      ordinal: 0,
      step: { kind: "prompt", title: "Step", prompt: "Do bounded work." },
      status: "failed",
      input: { storagePath: "/private/workspace" },
      output: null,
      error: {
        code: "STEP_FAILED",
        message: "Safe message",
        retryable: true,
        details: null,
      },
      startedAt: timestamp,
      completedAt: timestamp,
    },
    "workflow step runs reject path-bearing structured input",
  );
  rejects(
    WorkflowRunSchema,
    {
      id,
      workflowId: otherId,
      projectId: null,
      status: "failed",
      modelProfileId: null,
      jobId: null,
      input: {},
      output: null,
      startedAt: timestamp,
      completedAt: timestamp,
      error: {
        code: "FAILED",
        message: "Safe message",
        retryable: false,
        details: { apiKey: "not-allowed" },
      },
      createdAt: timestamp,
    },
    "workflow run errors reject secret-bearing detail keys",
  );

  accepts(
    CreateTabularReviewRequestSchema,
    {
      title: "Review",
      documentIds: [id, otherId],
      columns: [
        {
          key: "amount",
          title: "Amount",
          outputType: "number",
          prompt: "Extract amount.",
        },
      ],
    },
    "tabular review accepts typed output columns",
  );
  const emptyReviewRequest = CreateTabularReviewRequestSchema.parse({
    title: "Empty review draft",
  });
  assert.deepEqual(emptyReviewRequest.documentIds, []);
  assert.deepEqual(emptyReviewRequest.columns, []);
  accepts(
    TabularReviewSchema,
    {
      id,
      projectId: null,
      workflowId: null,
      title: "Empty review draft",
      status: "draft",
      documentIds: [],
      modelProfileId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    "tabular review transport accepts an empty persisted draft",
  );
  accepts(
    TabularCellSchema,
    {
      id,
      reviewId: id,
      documentId: otherId,
      columnId: id,
      outputType: "boolean",
      value: true,
      status: "complete",
      error: null,
      jobId: null,
      updatedAt: timestamp,
    },
    "tabular boolean cell parses",
  );
  rejects(
    TabularCellSchema,
    {
      id,
      reviewId: id,
      documentId: otherId,
      columnId: id,
      outputType: "number",
      value: "not a number",
      status: "complete",
      error: null,
      jobId: null,
      updatedAt: timestamp,
    },
    "tabular cell rejects an output value of the wrong type",
  );
  accepts(
    TabularCellSchema,
    {
      id,
      reviewId: id,
      documentId: otherId,
      columnId: id,
      outputType: "text",
      value: null,
      status: "failed",
      error: {
        code: "CELL_RETRY",
        message: "Temporary failure.",
        retryable: true,
        details: null,
      },
      jobId: otherId,
      updatedAt: timestamp,
    },
    "tabular cell exposes a retryable structured error without a path or secret",
  );
  rejects(
    GenerateTabularCellRequestSchema,
    { modelProfileId: id, apiKey: "not-allowed" },
    "tabular generation rejects secret injection",
  );

  accepts(
    JobSchema,
    {
      id,
      type: "tabular_cell",
      status: "complete",
      resourceType: "tabular_cell",
      resourceId: otherId,
      attempt: 1,
      maxAttempts: 3,
      error: null,
      retryable: false,
      createdAt: timestamp,
      startedAt: timestamp,
      completedAt: timestamp,
    },
    "jobs expose attempts, retryability, and structured error projection",
  );
  accepts(
    JobSchema,
    {
      id,
      type: "document_parse",
      status: "queued",
      resourceType: "document",
      resourceId: otherId,
      attempt: 0,
      maxAttempts: 3,
      error: null,
      retryable: false,
      createdAt: timestamp,
      startedAt: null,
      completedAt: null,
    },
    "an unclaimed queued job has attempt zero",
  );

  accepts(
    ApiErrorSchema,
    {
      detail: "Workspace API authentication failed.",
      code: "UNAUTHORIZED",
      error: {
        code: "UNAUTHORIZED",
        message: "Workspace API authentication failed.",
        retryable: false,
      },
    },
    "workspace auth uses the common Mike-compatible API error envelope",
  );
  accepts(
    ApiErrorSchema,
    {
      detail: "Request is invalid.",
      code: "VALIDATION_ERROR",
      error: {
        code: "VALIDATION_ERROR",
        message: "Request is invalid.",
        retryable: false,
        requestId: "request-audit",
        details: [{ path: "name", message: "Required." }],
      },
    },
    "uniform dual-write API error preserves retryability and diagnostics",
  );
  rejects(
    ApiErrorSchema,
    {
      detail: "Request is invalid.",
      code: "VALIDATION_ERROR",
      error: {
        code: "UNKNOWN",
        message: "Request is invalid.",
        retryable: false,
      },
    },
    "uniform API error rejects unknown code",
  );
  rejects(
    ApiErrorSchema,
    {
      error: {
        code: "UNAUTHORIZED",
        message: "Workspace API authentication failed.",
        retryable: false,
      },
    },
    "uniform API error requires Mike-compatible top-level fields",
  );
  rejects(
    ApiErrorSchema,
    {
      detail: "Workspace API authentication failed.",
      code: "UNAUTHORIZED",
      error: {
        code: "FORBIDDEN",
        message: "Workspace API authentication failed.",
        retryable: false,
      },
    },
    "uniform API error rejects divergent dual-write codes",
  );

  console.log(
    "Vera Workspace contract audit passed: strict Mike P0 contracts reject unsafe, cloud, and legacy inputs.",
  );
}

run();
