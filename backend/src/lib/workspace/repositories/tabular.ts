import { z } from "zod";

import {
  StructuredErrorSchema,
  IsoDateTimeSchema,
  NullableWorkspaceIdSchema,
  TabularCellSchema,
  TabularCellValueSchema,
  TabularColumnSchema,
  TabularReviewStatusSchema,
  WorkspaceIdSchema,
} from "../contracts";
import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import {
  normalizePageRequest,
  type Page,
  type PageRequest,
} from "../pagination";
import type {
  StructuredError,
  TabularCell,
  TabularCellStatus,
  TabularCellValue,
  TabularColumn,
  TabularReview,
} from "../types";

type Row = Record<string, unknown>;

export const TabularSourceRefSchema = z
  .object({
    documentId: WorkspaceIdSchema,
    versionId: WorkspaceIdSchema.nullable().optional(),
    chunkId: WorkspaceIdSchema.nullable().optional(),
    quote: z.string().min(1).max(8_000).nullable().optional(),
    startOffset: z.number().int().nonnegative().nullable().optional(),
    endOffset: z.number().int().nonnegative().nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.startOffset == null) !== (value.endOffset == null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [value.startOffset == null ? "startOffset" : "endOffset"],
        message: "source offsets must be provided together",
      });
    }
    if (
      value.startOffset != null &&
      value.endOffset != null &&
      value.endOffset < value.startOffset
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endOffset"],
        message: "endOffset must not precede startOffset",
      });
    }
    if (value.chunkId != null && value.versionId == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["versionId"],
        message: "chunk sources require a versionId",
      });
    }
    if (value.startOffset != null && value.versionId == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["versionId"],
        message: "offset sources require a versionId",
      });
    }
  });

export type TabularSourceRef = z.infer<typeof TabularSourceRefSchema>;
export type TabularCellRecord = TabularCell & {
  attempt: number;
  sourceRefs: TabularSourceRef[];
  completedAt: string | null;
};
export type TabularReviewDetail = {
  review: TabularReview;
  columns: TabularColumn[];
  cells: TabularCellRecord[];
};
export type TabularExportRow = {
  documentId: string;
  documentTitle: string;
  cells: TabularCellRecord[];
};
export type TabularExportData = {
  review: TabularReview;
  columns: TabularColumn[];
  rows: TabularExportRow[];
};

export type NewTabularReviewRecord = {
  id: string;
  projectId: string | null;
  workflowId: string | null;
  modelProfileId: string | null;
  title: string;
  documentIds: string[];
  columns: TabularColumn[];
  cells: Array<{
    id: string;
    documentId: string;
    columnId: string;
    outputType: TabularColumn["outputType"];
  }>;
  now: string;
};

const encodeCursor = (value: { updatedAt: string; id: string }) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

function decodeCursor(cursor: string | null) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof value.updatedAt !== "string" ||
      !value.updatedAt ||
      typeof value.id !== "string" ||
      !value.id
    ) {
      throw new Error("invalid cursor");
    }
    return { updatedAt: value.updatedAt, id: value.id };
  } catch {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Invalid pagination cursor.",
    );
  }
}

function parseJson<T>(
  value: unknown,
  schema: { parse(input: unknown): T },
  label: string,
): T {
  if (typeof value !== "string") {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      `Invalid persisted ${label}.`,
    );
  }
  try {
    return schema.parse(JSON.parse(value));
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      `Invalid persisted ${label}.`,
    );
  }
}

function optionalJson<T>(
  value: unknown,
  schema: { parse(input: unknown): T },
  label: string,
) {
  return value == null ? null : parseJson(value, schema, label);
}

function mapReview(
  row: Row,
  authoritativeDocumentIds: string[],
): TabularReview {
  const persistedReviewSchema = z
    .object({
      id: WorkspaceIdSchema,
      projectId: NullableWorkspaceIdSchema,
      workflowId: NullableWorkspaceIdSchema,
      title: z.string().min(1).max(240),
      status: TabularReviewStatusSchema,
      documentIds: WorkspaceIdSchema.array().max(1_000),
      modelProfileId: NullableWorkspaceIdSchema,
      createdAt: IsoDateTimeSchema,
      updatedAt: IsoDateTimeSchema,
    })
    .strict();
  const candidate = {
    id: String(row.id),
    projectId: row.project_id == null ? null : String(row.project_id),
    workflowId: row.workflow_id == null ? null : String(row.workflow_id),
    title: String(row.title),
    status: row.status,
    documentIds: WorkspaceIdSchema.array()
      .max(1_000)
      .parse(authoritativeDocumentIds),
    modelProfileId:
      row.model_profile_id == null ? null : String(row.model_profile_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  try {
    return persistedReviewSchema.parse(candidate);
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid persisted tabular review.",
    );
  }
}

function mapColumn(row: Row): TabularColumn {
  const candidate = {
    id: String(row.id),
    reviewId: String(row.review_id),
    key: String(row.key),
    title: String(row.title),
    outputType: row.output_type,
    prompt: String(row.prompt),
    enumValues: optionalJson(
      row.enum_values_json,
      z.array(z.string().min(1).max(160)).min(1).max(100),
      "tabular enum values",
    ),
    ordinal: Number(row.ordinal),
  };
  try {
    return TabularColumnSchema.parse(candidate);
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid persisted tabular column.",
    );
  }
}

function mapCell(row: Row): TabularCellRecord {
  const candidate = {
    id: String(row.id),
    reviewId: String(row.review_id),
    documentId: String(row.document_id),
    columnId: String(row.column_id),
    outputType: row.output_type,
    value: optionalJson(
      row.value_json,
      TabularCellValueSchema,
      "tabular cell value",
    ),
    status: row.status,
    error: optionalJson(
      row.error_json,
      StructuredErrorSchema,
      "tabular cell error",
    ),
    jobId: row.job_id == null ? null : String(row.job_id),
    updatedAt: String(row.updated_at),
  };
  try {
    return {
      ...TabularCellSchema.parse(candidate),
      attempt: Number(row.attempt),
      sourceRefs: parseJson(
        row.citations_json,
        TabularSourceRefSchema.array().max(1_000),
        "tabular cell source references",
      ),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
    };
  } catch (error) {
    if (error instanceof WorkspaceApiError) throw error;
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid persisted tabular cell.",
    );
  }
}

const serialize = (value: unknown) => JSON.stringify(value);

export class TabularRepository {
  constructor(readonly database: WorkspaceDatabaseAdapter) {}

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  private assertSourceRefs(
    documentId: string,
    sourceRefs: TabularSourceRef[],
    persisted = false,
  ) {
    const invalid = (): never => {
      throw new WorkspaceApiError(
        persisted ? 500 : 409,
        persisted ? "INTERNAL_ERROR" : "CONFLICT",
        persisted
          ? "Persisted tabular cell source references are invalid."
          : "Tabular cell source references are invalid.",
      );
    };
    const document = this.database
      .prepare("SELECT id FROM documents WHERE id = ? AND deleted_at IS NULL")
      .get(documentId);
    if (!document) invalid();
    for (const source of sourceRefs) {
      if (source.documentId !== documentId) invalid();
      if (source.versionId == null) continue;
      const version = this.database
        .prepare(
          `SELECT id FROM document_versions
            WHERE id = ? AND document_id = ? AND deleted_at IS NULL`,
        )
        .get(source.versionId, documentId);
      if (!version) invalid();
      if (source.chunkId == null) {
        if (source.startOffset != null) {
          const bounds = this.database
            .prepare(
              `SELECT min(start_offset) AS start_offset,
                      max(end_offset) AS end_offset
                 FROM document_chunks
                WHERE document_id = ? AND version_id = ?`,
            )
            .get(documentId, source.versionId);
          if (
            bounds?.start_offset == null ||
            bounds?.end_offset == null ||
            source.startOffset < Number(bounds.start_offset) ||
            source.endOffset! > Number(bounds.end_offset)
          ) {
            invalid();
          }
        }
        continue;
      }
      const chunk = this.database
        .prepare(
          `SELECT start_offset, end_offset FROM document_chunks
            WHERE id = ? AND document_id = ? AND version_id = ?`,
        )
        .get(source.chunkId, documentId, source.versionId);
      if (!chunk) invalid();
      const confirmedChunk = chunk!;
      if (
        source.startOffset != null &&
        (source.startOffset < Number(confirmedChunk.start_offset) ||
          source.endOffset! > Number(confirmedChunk.end_offset))
      ) {
        invalid();
      }
    }
  }

  list(
    request: PageRequest & {
      projectId?: string;
      includeArchived?: boolean;
    } = {},
  ): Page<TabularReview> {
    const page = normalizePageRequest(request);
    const cursor = decodeCursor(page.cursor);
    const conditions = [
      request.includeArchived ? "1 = 1" : "status <> 'archived'",
    ];
    const parameters: unknown[] = [];
    if (request.projectId) {
      conditions.push("project_id = ?");
      parameters.push(request.projectId);
    }
    if (cursor) {
      conditions.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
      parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    parameters.push(page.limit + 1);
    const rows = this.database
      .prepare(
        `SELECT * FROM tabular_reviews
         WHERE ${conditions.join(" AND ")}
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters);
    const items = rows
      .slice(0, page.limit)
      .map((row) => mapReview(row, this.documentIds(String(row.id))));
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > page.limit && last
          ? encodeCursor({ updatedAt: last.updatedAt, id: last.id })
          : null,
    };
  }

  get(id: string): TabularReview | null {
    const row = this.database
      .prepare("SELECT * FROM tabular_reviews WHERE id = ?")
      .get(id);
    return row ? mapReview(row, this.documentIds(id)) : null;
  }

  private documentIds(reviewId: string) {
    return this.database
      .prepare(
        `SELECT document_id FROM tabular_review_documents
         WHERE review_id = ? ORDER BY ordinal ASC, document_id ASC`,
      )
      .all(reviewId)
      .map((row) => String(row.document_id));
  }

  require(id: string) {
    const review = this.get(id);
    if (!review)
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Tabular review not found.",
      );
    return review;
  }

  getDetail(id: string): TabularReviewDetail | null {
    const review = this.get(id);
    if (!review) return null;
    const columns = this.database
      .prepare(
        "SELECT * FROM tabular_review_columns WHERE review_id = ? ORDER BY ordinal ASC, id ASC",
      )
      .all(id)
      .map(mapColumn);
    const cellRows = this.database
      .prepare("SELECT * FROM tabular_cells WHERE review_id = ?")
      .all(id)
      .map(mapCell);
    const documentOrder = new Map(
      review.documentIds.map((documentId, ordinal) => [documentId, ordinal]),
    );
    const columnOrder = new Map(
      columns.map((column) => [column.id, column.ordinal]),
    );
    cellRows.sort(
      (left, right) =>
        (documentOrder.get(left.documentId) ?? Number.MAX_SAFE_INTEGER) -
          (documentOrder.get(right.documentId) ?? Number.MAX_SAFE_INTEGER) ||
        (columnOrder.get(left.columnId) ?? Number.MAX_SAFE_INTEGER) -
          (columnOrder.get(right.columnId) ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id),
    );
    if (cellRows.length !== columns.length * review.documentIds.length) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Persisted tabular matrix is incomplete.",
      );
    }
    const columnsById = new Map(columns.map((column) => [column.id, column]));
    const documentIds = new Set(review.documentIds);
    for (const cell of cellRows) {
      const column = columnsById.get(cell.columnId);
      const validEnum =
        column?.outputType !== "enum" ||
        cell.value === null ||
        (typeof cell.value === "string" &&
          Boolean(column.enumValues?.includes(cell.value)));
      const validCompletion =
        cell.status !== "complete" ||
        (cell.value !== null &&
          cell.completedAt !== null &&
          cell.error === null);
      const validFailure = cell.status !== "failed" || cell.error !== null;
      let validSources = true;
      try {
        this.assertSourceRefs(cell.documentId, cell.sourceRefs, true);
      } catch {
        validSources = false;
      }
      if (
        !column ||
        column.outputType !== cell.outputType ||
        !documentIds.has(cell.documentId) ||
        !validEnum ||
        !validCompletion ||
        !validFailure ||
        !validSources
      ) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Persisted tabular cell violates its review configuration.",
        );
      }
    }
    return { review, columns, cells: cellRows };
  }

  requireDetail(id: string) {
    const detail = this.getDetail(id);
    if (!detail)
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Tabular review not found.",
      );
    return detail;
  }

  workspaceDefaults() {
    const row = this.database
      .prepare(
        `SELECT default_project_id, default_model_profile_id
         FROM workspace_settings WHERE id = 'workspace'`,
      )
      .get();
    if (!row) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workspace settings are unavailable.",
      );
    }
    return {
      defaultProjectId:
        row.default_project_id == null ? null : String(row.default_project_id),
      defaultModelProfileId:
        row.default_model_profile_id == null
          ? null
          : String(row.default_model_profile_id),
    };
  }

  requireActiveProject(projectId: string) {
    const row = this.database
      .prepare(
        "SELECT status, default_model_profile_id FROM projects WHERE id = ?",
      )
      .get(projectId);
    if (!row)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Project not found.");
    if (row.status !== "active") {
      throw new WorkspaceApiError(409, "CONFLICT", "Project is not active.");
    }
    return {
      id: projectId,
      defaultModelProfileId:
        row.default_model_profile_id == null
          ? null
          : String(row.default_model_profile_id),
    };
  }

  requireEnabledModelProfile(modelProfileId: string) {
    const row = this.database
      .prepare("SELECT enabled FROM model_profiles WHERE id = ?")
      .get(modelProfileId);
    if (!row)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Model profile not found.");
    if (Number(row.enabled) !== 1) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Model profile is disabled.",
      );
    }
    return { id: modelProfileId };
  }

  requireActiveTabularWorkflow(workflowId: string) {
    const row = this.database
      .prepare("SELECT type, status FROM workflows WHERE id = ?")
      .get(workflowId);
    if (!row)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Workflow not found.");
    if (row.type !== "tabular" || row.status !== "active") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Tabular workflow is not active.",
      );
    }
    return { id: workflowId };
  }

  requireReadyDocuments(projectId: string, documentIds: string[]) {
    if (documentIds.length === 0) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Documents are required.",
      );
    }
    const placeholders = documentIds.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT id, project_id, parse_status, deleted_at FROM documents
         WHERE id IN (${placeholders})`,
      )
      .all(...documentIds);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    for (const id of documentIds) {
      const row = byId.get(id);
      if (!row || row.deleted_at != null) {
        throw new WorkspaceApiError(404, "NOT_FOUND", "Document not found.");
      }
      if (row.project_id == null || String(row.project_id) !== projectId) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Every review document must belong to the selected project.",
        );
      }
      if (row.parse_status !== "ready") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Every review document must be ready.",
        );
      }
    }
  }

  documentProjectForDraft(documentIds: string[]) {
    if (documentIds.length === 0) return null;
    const placeholders = documentIds.map(() => "?").join(", ");
    const rows = this.database
      .prepare(
        `SELECT id, project_id, deleted_at FROM documents
         WHERE id IN (${placeholders})`,
      )
      .all(...documentIds);
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    let projectId: string | null = null;
    for (const id of documentIds) {
      const row = byId.get(id);
      if (!row || row.deleted_at != null) {
        throw new WorkspaceApiError(404, "NOT_FOUND", "Document not found.");
      }
      if (row.project_id == null) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular review documents require a project.",
        );
      }
      const candidate = String(row.project_id);
      if (projectId !== null && projectId !== candidate) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Every review document must belong to the same project.",
        );
      }
      projectId = candidate;
    }
    return projectId;
  }

  create(input: NewTabularReviewRecord) {
    return this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO tabular_reviews
            (id, project_id, workflow_id, model_profile_id, title, status,
             document_ids_json, columns_config_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.projectId,
          input.workflowId,
          input.modelProfileId,
          input.title,
          serialize(input.documentIds),
          serialize(input.columns),
          input.now,
          input.now,
        );
      const membershipStatement = this.database.prepare(
        `INSERT INTO tabular_review_documents
          (review_id, document_id, ordinal, created_at)
         VALUES (?, ?, ?, ?)`,
      );
      input.documentIds.forEach((documentId, ordinal) => {
        membershipStatement.run(input.id, documentId, ordinal, input.now);
      });
      const columnStatement = this.database.prepare(
        `INSERT INTO tabular_review_columns
          (id, review_id, key, title, output_type, prompt, enum_values_json,
           ordinal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const column of input.columns) {
        columnStatement.run(
          column.id,
          input.id,
          column.key,
          column.title,
          column.outputType,
          column.prompt,
          column.enumValues == null ? null : serialize(column.enumValues),
          column.ordinal,
          input.now,
          input.now,
        );
      }
      const cellStatement = this.database.prepare(
        `INSERT INTO tabular_cells
          (id, review_id, document_id, column_id, output_type, status,
           citations_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'empty', '[]', ?, ?)`,
      );
      for (const cell of input.cells) {
        cellStatement.run(
          cell.id,
          input.id,
          cell.documentId,
          cell.columnId,
          cell.outputType,
          input.now,
          input.now,
        );
      }
      return this.requireDetail(input.id);
    });
  }

  replaceDraftMatrix(input: NewTabularReviewRecord) {
    return this.transaction(() => {
      const existing = this.require(input.id);
      if (existing.status !== "draft" && existing.status !== "ready") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Only a draft review matrix can be replaced.",
        );
      }
      this.database
        .prepare("DELETE FROM tabular_cells WHERE review_id = ?")
        .run(input.id);
      this.database
        .prepare("DELETE FROM tabular_review_columns WHERE review_id = ?")
        .run(input.id);
      this.database
        .prepare("DELETE FROM tabular_review_documents WHERE review_id = ?")
        .run(input.id);
      this.database
        .prepare(
          `UPDATE tabular_reviews
           SET project_id = ?, model_profile_id = ?, workflow_id = ?,
               document_ids_json = ?, columns_config_json = ?, status = 'draft',
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.projectId,
          input.modelProfileId,
          input.workflowId,
          serialize(input.documentIds),
          serialize(input.columns),
          input.now,
          input.id,
        );
      const membershipStatement = this.database.prepare(
        `INSERT INTO tabular_review_documents
          (review_id, document_id, ordinal, created_at)
         VALUES (?, ?, ?, ?)`,
      );
      input.documentIds.forEach((documentId, ordinal) => {
        membershipStatement.run(input.id, documentId, ordinal, input.now);
      });
      const columnStatement = this.database.prepare(
        `INSERT INTO tabular_review_columns
          (id, review_id, key, title, output_type, prompt, enum_values_json,
           ordinal, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const column of input.columns) {
        columnStatement.run(
          column.id,
          input.id,
          column.key,
          column.title,
          column.outputType,
          column.prompt,
          column.enumValues == null ? null : serialize(column.enumValues),
          column.ordinal,
          input.now,
          input.now,
        );
      }
      const cellStatement = this.database.prepare(
        `INSERT INTO tabular_cells
          (id, review_id, document_id, column_id, output_type, status,
           citations_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'empty', '[]', ?, ?)`,
      );
      for (const cell of input.cells) {
        cellStatement.run(
          cell.id,
          input.id,
          cell.documentId,
          cell.columnId,
          cell.outputType,
          input.now,
          input.now,
        );
      }
      return this.requireDetail(input.id);
    });
  }

  update(
    id: string,
    input: {
      title?: string;
      status?: "draft" | "ready" | "archived" | "cancelled";
      modelProfileId?: string | null;
      now: string;
    },
  ) {
    const existing = this.require(id);
    this.database
      .prepare(
        `UPDATE tabular_reviews
         SET title = ?, status = ?, model_profile_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.title ?? existing.title,
        input.status ?? existing.status,
        input.modelProfileId === undefined
          ? existing.modelProfileId
          : input.modelProfileId,
        input.now,
        id,
      );
    return this.requireDetail(id);
  }

  archive(id: string, now: string) {
    return this.update(id, { status: "archived", now });
  }

  delete(id: string) {
    const review = this.require(id);
    if (review.status === "running") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Cancel the running review first.",
      );
    }
    this.database.prepare("DELETE FROM tabular_reviews WHERE id = ?").run(id);
  }

  queueCell(
    input: {
      cellId: string;
      jobId: string;
      nextAttempt: number;
      now: string;
    },
    enqueueJob: () => { id: string },
  ) {
    return this.transaction(() => {
      const cell = this.requireCell(input.cellId);
      if (cell.status !== "empty" && cell.status !== "failed") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular cell cannot be queued.",
        );
      }
      const job = enqueueJob();
      if (job.id !== input.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Tabular job state mismatch.",
        );
      }
      this.database
        .prepare(
          `UPDATE tabular_cells
           SET status = 'queued', job_id = ?, attempt = ?, value_json = NULL,
               content = NULL, citations_json = '[]', error_json = NULL,
               error_code = NULL, completed_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.jobId, input.nextAttempt, input.now, input.cellId);
      this.database
        .prepare(
          "UPDATE tabular_reviews SET status = 'running', updated_at = ? WHERE id = ?",
        )
        .run(input.now, cell.reviewId);
      return this.requireCell(input.cellId);
    });
  }

  getCell(id: string): TabularCellRecord | null {
    const row = this.database
      .prepare("SELECT * FROM tabular_cells WHERE id = ?")
      .get(id);
    return row ? mapCell(row) : null;
  }

  requireCell(id: string) {
    const cell = this.getCell(id);
    if (!cell)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Tabular cell not found.");
    return cell;
  }

  startCell(cellId: string, now: string, startJob: () => { id: string }) {
    return this.transaction(() => {
      const cell = this.requireCell(cellId);
      if (cell.status !== "queued" || !cell.jobId) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular cell is not queued.",
        );
      }
      const job = startJob();
      if (job.id !== cell.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Tabular job state mismatch.",
        );
      }
      this.database
        .prepare(
          "UPDATE tabular_cells SET status = 'running', updated_at = ? WHERE id = ?",
        )
        .run(now, cellId);
      return this.requireCell(cellId);
    });
  }

  completeCell(
    cellId: string,
    value: TabularCellValue,
    sourceRefs: TabularSourceRef[],
    now: string,
    completeJob: () => { id: string },
  ) {
    return this.transaction(() => {
      const cell = this.requireCell(cellId);
      if (cell.status !== "running" || !cell.jobId) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular cell is not running.",
        );
      }
      this.assertSourceRefs(cell.documentId, sourceRefs);
      const job = completeJob();
      if (job.id !== cell.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Tabular job state mismatch.",
        );
      }
      this.database
        .prepare(
          `UPDATE tabular_cells
           SET status = 'complete', value_json = ?, content = ?, citations_json = ?,
               error_json = NULL, error_code = NULL, completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          serialize(value),
          typeof value === "string" ? value : String(value),
          serialize(sourceRefs),
          now,
          now,
          cellId,
        );
      this.refreshStatus(cell.reviewId, now);
      return this.requireCell(cellId);
    });
  }

  failCell(
    cellId: string,
    error: StructuredError,
    now: string,
    failJob: () => { id: string },
  ) {
    return this.transaction(() => {
      const cell = this.requireCell(cellId);
      if (cell.status !== "running" || !cell.jobId) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular cell is not running.",
        );
      }
      const job = failJob();
      if (job.id !== cell.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Tabular job state mismatch.",
        );
      }
      this.database
        .prepare(
          `UPDATE tabular_cells
           SET status = 'failed', value_json = NULL, content = NULL,
               citations_json = '[]', error_json = ?, error_code = ?,
               completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(serialize(error), error.code, now, now, cellId);
      this.refreshStatus(cell.reviewId, now);
      return this.requireCell(cellId);
    });
  }

  cancelReview(
    reviewId: string,
    now: string,
    cancelJobs: (jobIds: string[]) => void,
  ) {
    return this.transaction(() => {
      const detail = this.requireDetail(reviewId);
      if (
        ["complete", "cancelled", "archived"].includes(detail.review.status)
      ) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Tabular review cannot be cancelled.",
        );
      }
      const jobIds = detail.cells
        .filter(
          (cell) => ["queued", "running"].includes(cell.status) && cell.jobId,
        )
        .map((cell) => cell.jobId!);
      cancelJobs(jobIds);
      this.database
        .prepare(
          `UPDATE tabular_cells
           SET status = 'cancelled', completed_at = ?, updated_at = ?
           WHERE review_id = ? AND status IN ('empty', 'queued', 'running')`,
        )
        .run(now, now, reviewId);
      this.database
        .prepare(
          "UPDATE tabular_reviews SET status = 'cancelled', updated_at = ? WHERE id = ?",
        )
        .run(now, reviewId);
      return this.requireDetail(reviewId);
    });
  }

  getExportData(reviewId: string): TabularExportData {
    const detail = this.requireDetail(reviewId);
    if (detail.review.documentIds.length === 0 || detail.columns.length === 0) {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        "A tabular export requires persisted documents and columns.",
      );
    }
    const placeholders = detail.review.documentIds.map(() => "?").join(", ");
    const documents = this.database
      .prepare(`SELECT id, title FROM documents WHERE id IN (${placeholders})`)
      .all(...detail.review.documentIds);
    const titles = new Map(
      documents.map((document) => [
        String(document.id),
        String(document.title),
      ]),
    );
    const rows = detail.review.documentIds.map((documentId) => {
      const documentTitle = titles.get(documentId);
      if (documentTitle == null) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Review document is unavailable.",
        );
      }
      return {
        documentId,
        documentTitle,
        cells: detail.cells.filter((cell) => cell.documentId === documentId),
      };
    });
    return { review: detail.review, columns: detail.columns, rows };
  }

  private refreshStatus(reviewId: string, now: string) {
    const rows = this.database
      .prepare(
        "SELECT status, count(*) AS count FROM tabular_cells WHERE review_id = ? GROUP BY status",
      )
      .all(reviewId);
    const counts = new Map<TabularCellStatus, number>(
      rows.map((row) => [row.status as TabularCellStatus, Number(row.count)]),
    );
    const active =
      (counts.get("empty") ?? 0) +
      (counts.get("queued") ?? 0) +
      (counts.get("running") ?? 0);
    const status =
      active > 0
        ? "running"
        : (counts.get("failed") ?? 0) > 0
          ? "failed"
          : (counts.get("cancelled") ?? 0) > 0
            ? "cancelled"
            : "complete";
    this.database
      .prepare(
        "UPDATE tabular_reviews SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, now, reviewId);
  }
}
