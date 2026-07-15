import { z } from "zod";

import type { WorkspaceDatabaseAdapter } from "../migrations";
import {
  CommitMarkdownVersionCasV12Schema,
  CreateMarkdownDraftV12Schema,
  RestoreMarkdownVersionCasV12Schema,
  StudioCitationBindingV12Schema,
  StudioDocumentV12Schema,
  StudioDocumentVersionV12Schema,
  type CommitMarkdownVersionCasV12,
  type CreateMarkdownDraftV12,
  type RestoreMarkdownVersionCasV12,
  type StudioCitationBindingV12,
  type StudioDocumentV12,
  type StudioDocumentVersionV12,
  type StudioProjectDocumentV12,
  type StudioVersionCommitV12,
} from "../documentStudioContractsV12";
import {
  workspaceBlobStorageKey,
  WorkspaceBlobRecordsRepository,
  type WorkspaceBlobRecordsRepository as WorkspaceBlobRecordsRepositoryType,
} from "./blobRecords";

type Row = Record<string, unknown>;

export type WorkspaceDocumentStudioRepositoryErrorCode =
  | "DOCUMENT_STUDIO_INVALID_INPUT"
  | "DOCUMENT_STUDIO_NOT_FOUND"
  | "DOCUMENT_STUDIO_VERSION_CONFLICT"
  | "DOCUMENT_STUDIO_OPERATION_CONFLICT"
  | "DOCUMENT_STUDIO_SCOPE_VIOLATION"
  | "DOCUMENT_STUDIO_PERSISTENCE_FAILED";

export class WorkspaceDocumentStudioRepositoryError extends Error {
  constructor(
    readonly code: WorkspaceDocumentStudioRepositoryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceDocumentStudioRepositoryError";
  }
}

function studioError(
  code: WorkspaceDocumentStudioRepositoryErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new WorkspaceDocumentStudioRepositoryError(
    code,
    message,
    cause instanceof Error ? { cause } : undefined,
  );
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    studioError(
      "DOCUMENT_STUDIO_INVALID_INPUT",
      `${label} is invalid.`,
      error,
    );
  }
}

function parseId(value: string, label: string) {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) {
    studioError("DOCUMENT_STUDIO_INVALID_INPUT", `${label} is invalid.`);
  }
  return parsed.data;
}

const VERSION_SELECT = `
  version.id AS version_id,
  studio.project_id AS project_id,
  version.document_id AS document_id,
  version.version_number AS version_number,
  version.source AS version_source,
  version.filename AS version_filename,
  version.mime_type AS version_mime_type,
  version.size_bytes AS version_size_bytes,
  version.content_sha256 AS version_content_sha256,
  version.storage_key AS version_storage_key,
  version.page_count AS version_page_count,
  studio.format AS studio_format,
  studio.summary AS studio_summary,
  studio.operation_id AS studio_operation_id,
  studio.created_at AS studio_created_at
`;

export class WorkspaceDocumentStudioRepository {
  private readonly blobRecords: WorkspaceBlobRecordsRepositoryType;
  private readonly now: () => string;

  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    options: {
      blobRecords?: WorkspaceBlobRecordsRepositoryType;
      now?: () => string;
    } = {},
  ) {
    this.blobRecords =
      options.blobRecords ?? new WorkspaceBlobRecordsRepository(database);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  getProjectDocument(
    projectId: string,
    documentId: string,
  ): StudioProjectDocumentV12 | null {
    parseId(projectId, "projectId");
    parseId(documentId, "documentId");
    try {
      const row = this.database
        .prepare(
          `SELECT
             document.id AS document_id,
             document.project_id AS document_project_id,
             document.folder_id AS document_folder_id,
             document.document_kind AS document_kind,
             document.title AS document_title,
             document.filename AS document_filename,
             document.mime_type AS document_mime_type,
             document.size_bytes AS document_size_bytes,
             document.parse_status AS document_parse_status,
             document.current_version_id AS document_current_version_id,
             document.created_at AS document_created_at,
             document.updated_at AS document_updated_at,
             ${VERSION_SELECT}
           FROM documents document
           JOIN document_versions version
             ON version.document_id = document.id
            AND version.id = document.current_version_id
            AND version.deleted_at IS NULL
           JOIN document_studio_versions studio
             ON studio.document_id = document.id
            AND studio.version_id = version.id
            AND studio.project_id = document.project_id
          WHERE document.project_id = ?
            AND document.id = ?
            AND document.document_kind IN ('draft', 'template')
            AND document.deleted_at IS NULL`,
        )
        .get(projectId, documentId);
      if (!row) return null;
      return {
        document: this.mapDocument(row),
        currentVersion: this.mapVersion(row),
      };
    } catch (error) {
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Studio document could not be read.",
        error,
      );
    }
  }

  getVersion(
    projectId: string,
    documentId: string,
    versionId: string,
  ): StudioDocumentVersionV12 | null {
    parseId(projectId, "projectId");
    parseId(documentId, "documentId");
    parseId(versionId, "versionId");
    try {
      const row = this.selectVersion(projectId, documentId, versionId);
      return row ? this.mapVersion(row) : null;
    } catch (error) {
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Studio document version could not be read.",
        error,
      );
    }
  }

  listVersions(
    projectId: string,
    documentId: string,
  ): StudioDocumentVersionV12[] {
    parseId(projectId, "projectId");
    parseId(documentId, "documentId");
    try {
      return this.database
        .prepare(
          `SELECT ${VERSION_SELECT}
             FROM document_studio_versions studio
             JOIN documents document
               ON document.id = studio.document_id
              AND document.project_id = studio.project_id
             JOIN document_versions version
               ON version.document_id = studio.document_id
              AND version.id = studio.version_id
            WHERE studio.project_id = ?
              AND studio.document_id = ?
              AND document.deleted_at IS NULL
              AND version.deleted_at IS NULL
            ORDER BY version.version_number ASC, version.id ASC`,
        )
        .all(projectId, documentId)
        .map((row) => this.mapVersion(row));
    } catch (error) {
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Studio document versions could not be listed.",
        error,
      );
    }
  }

  listVersionCitationAnchors(
    projectId: string,
    documentId: string,
    versionId: string,
  ): StudioCitationBindingV12[] {
    parseId(projectId, "projectId");
    parseId(documentId, "documentId");
    parseId(versionId, "versionId");
    try {
      return this.database
        .prepare(
          `SELECT project_id, document_id, version_id, anchor_id, ordinal,
                  created_at
             FROM document_version_citation_anchors
            WHERE project_id = ? AND document_id = ? AND version_id = ?
            ORDER BY ordinal ASC, anchor_id ASC`,
        )
        .all(projectId, documentId, versionId)
        .map((row) =>
          StudioCitationBindingV12Schema.parse({
            projectId: row.project_id,
            documentId: row.document_id,
            versionId: row.version_id,
            anchorId: row.anchor_id,
            ordinal: Number(row.ordinal),
            createdAt: row.created_at,
          }),
        );
    } catch (error) {
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Studio version citations could not be listed.",
        error,
      );
    }
  }

  createMarkdownDraft(input: CreateMarkdownDraftV12): StudioVersionCommitV12 {
    const parsed = parseInput(
      CreateMarkdownDraftV12Schema,
      input,
      "Studio draft input",
    );
    return this.persist(() => {
      const project = this.database
        .prepare("SELECT id FROM projects WHERE id = ? AND status = 'active'")
        .get(parsed.projectId);
      if (!project) {
        studioError(
          "DOCUMENT_STUDIO_NOT_FOUND",
          "Project was not found.",
        );
      }
      if (parsed.folderId !== null) {
        const folder = this.database
          .prepare(
            "SELECT project_id FROM project_subfolders WHERE id = ?",
          )
          .get(parsed.folderId);
        if (!folder || folder.project_id !== parsed.projectId) {
          studioError("DOCUMENT_STUDIO_NOT_FOUND", "Folder was not found.");
        }
      }
      this.assertCitationScope(parsed.projectId, parsed.citationAnchorIds);
      const storageKey = workspaceBlobStorageKey({
        kind: "original",
        documentId: parsed.documentId,
        versionId: parsed.versionId,
      });
      this.database
        .prepare(
          `INSERT INTO documents (
             id, project_id, folder_id, title, filename, mime_type, size_bytes,
             parse_status, current_version_id, deleted_at, created_at,
             updated_at, document_kind
           ) VALUES (?, ?, ?, ?, ?, 'text/markdown', ?, 'pending', NULL, NULL,
                     ?, ?, ?)`,
        )
        .run(
          parsed.documentId,
          parsed.projectId,
          parsed.folderId,
          parsed.title,
          parsed.filename,
          parsed.sizeBytes,
          parsed.createdAt,
          parsed.createdAt,
          parsed.documentKind,
        );
      this.database
        .prepare(
          `INSERT INTO document_versions (
             id, document_id, version_number, source, filename, mime_type,
             size_bytes, content_sha256, storage_key, created_at
           ) VALUES (?, ?, 1, 'user_upload', ?, 'text/markdown', ?, ?, ?, ?)`,
        )
        .run(
          parsed.versionId,
          parsed.documentId,
          parsed.filename,
          parsed.sizeBytes,
          parsed.contentSha256,
          storageKey,
          parsed.createdAt,
        );
      this.insertStudioMetadata({
        projectId: parsed.projectId,
        documentId: parsed.documentId,
        versionId: parsed.versionId,
        summary: parsed.summary,
        operationId: parsed.operationId,
        createdAt: parsed.createdAt,
      });
      this.insertCitationBindings(
        parsed.projectId,
        parsed.documentId,
        parsed.versionId,
        parsed.citationAnchorIds,
        parsed.createdAt,
      );
      this.database
        .prepare(
          `UPDATE documents
              SET current_version_id = ?, updated_at = ?
            WHERE id = ? AND project_id = ? AND current_version_id IS NULL`,
        )
        .run(
          parsed.versionId,
          parsed.createdAt,
          parsed.documentId,
          parsed.projectId,
        );
      this.insertParseJob(
        parsed.jobId,
        parsed.documentId,
        parsed.versionId,
        parsed.createdAt,
      );
      this.blobRecords.registerStoredInTransaction({
        id: parsed.blobRecordId,
        locator: {
          kind: "original",
          documentId: parsed.documentId,
          versionId: parsed.versionId,
        },
        contentSha256: parsed.contentSha256,
        sizeBytes: parsed.sizeBytes,
        storedSizeBytes: parsed.storedSizeBytes,
      });
      return this.commitProjection(
        parsed.projectId,
        parsed.documentId,
        parsed.versionId,
        parsed.jobId,
      );
    });
  }

  commitMarkdownVersionCas(
    input: CommitMarkdownVersionCasV12,
  ): StudioVersionCommitV12 {
    const parsed = parseInput(
      CommitMarkdownVersionCasV12Schema,
      input,
      "Studio version commit",
    );
    return this.persist(() => this.commitMarkdownVersionInTransaction(parsed));
  }

  restoreVersionCas(
    input: RestoreMarkdownVersionCasV12,
  ): StudioVersionCommitV12 {
    const parsed = parseInput(
      RestoreMarkdownVersionCasV12Schema,
      input,
      "Studio version restore",
    );
    return this.persist(() => {
      const restored = this.selectVersion(
        parsed.projectId,
        parsed.documentId,
        parsed.restoreFromVersionId,
      );
      if (!restored) {
        studioError(
          "DOCUMENT_STUDIO_NOT_FOUND",
          "The Studio version selected for restore was not found.",
        );
      }
      const target = this.mapVersion(restored);
      if (
        parsed.contentSha256 !== target.contentSha256 ||
        parsed.sizeBytes !== target.sizeBytes
      ) {
        studioError(
          "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
          "Prepared restore bytes do not match the immutable target version.",
        );
      }
      const citationAnchorIds = this.listCitationAnchorIdsRaw(
        parsed.projectId,
        parsed.documentId,
        parsed.restoreFromVersionId,
      );
      return this.commitMarkdownVersionInTransaction({
        projectId: parsed.projectId,
        documentId: parsed.documentId,
        expectedCurrentVersionId: parsed.expectedCurrentVersionId,
        versionId: parsed.versionId,
        jobId: parsed.jobId,
        source: "user_upload",
        filename: target.filename,
        summary: parsed.summary,
        operationId: parsed.operationId,
        citationAnchorIds,
        createdAt: parsed.createdAt,
        blobRecordId: parsed.blobRecordId,
        contentSha256: parsed.contentSha256,
        sizeBytes: parsed.sizeBytes,
        storedSizeBytes: parsed.storedSizeBytes,
      });
    });
  }

  private commitMarkdownVersionInTransaction(
    input: z.output<typeof CommitMarkdownVersionCasV12Schema>,
  ): StudioVersionCommitV12 {
    const document = this.database
      .prepare(
        `SELECT document.current_version_id
           FROM documents document
           JOIN projects project
             ON project.id = document.project_id AND project.status = 'active'
          WHERE document.project_id = ? AND document.id = ?
            AND document.document_kind IN ('draft', 'template')
            AND document.deleted_at IS NULL`,
      )
      .get(input.projectId, input.documentId);
    if (!document) {
      studioError(
        "DOCUMENT_STUDIO_NOT_FOUND",
        "Studio document was not found.",
      );
    }
    if (document.current_version_id !== input.expectedCurrentVersionId) {
      studioError(
        "DOCUMENT_STUDIO_VERSION_CONFLICT",
        "Studio document changed since it was opened.",
      );
    }
    if (
      !this.selectVersion(
        input.projectId,
        input.documentId,
        input.expectedCurrentVersionId,
      )
    ) {
      studioError(
        "DOCUMENT_STUDIO_NOT_FOUND",
        "Expected Studio base version was not found.",
      );
    }
    if (input.operationId !== null) {
      const existing = this.database
        .prepare(
          `SELECT version_id FROM document_studio_versions
            WHERE document_id = ? AND operation_id = ?`,
        )
        .get(input.documentId, input.operationId);
      if (existing) {
        studioError(
          "DOCUMENT_STUDIO_OPERATION_CONFLICT",
          "Studio operation id has already been used for this document.",
        );
      }
    }
    this.assertCitationScope(input.projectId, input.citationAnchorIds);
    const versionNumber =
      Number(
        this.database
          .prepare(
            `SELECT coalesce(max(version_number), 0) AS version_number
               FROM document_versions WHERE document_id = ?`,
          )
          .get(input.documentId)?.version_number ?? 0,
      ) + 1;
    const storageKey = workspaceBlobStorageKey({
      kind: "original",
      documentId: input.documentId,
      versionId: input.versionId,
    });
    this.database
      .prepare(
        `INSERT INTO document_versions (
           id, document_id, version_number, source, filename, mime_type,
           size_bytes, content_sha256, storage_key, created_at
         ) VALUES (?, ?, ?, ?, ?, 'text/markdown', ?, ?, ?, ?)`,
      )
      .run(
        input.versionId,
        input.documentId,
        versionNumber,
        input.source,
        input.filename,
        input.sizeBytes,
        input.contentSha256,
        storageKey,
        input.createdAt,
      );
    this.insertStudioMetadata(input);
    this.insertCitationBindings(
      input.projectId,
      input.documentId,
      input.versionId,
      input.citationAnchorIds,
      input.createdAt,
    );
    this.database
      .prepare(
        `UPDATE documents
            SET current_version_id = ?, filename = ?, mime_type = 'text/markdown',
                size_bytes = ?, parse_status = 'pending',
                parse_error_code = NULL, parse_error_json = NULL,
                updated_at = ?
          WHERE project_id = ? AND id = ? AND current_version_id = ?
            AND document_kind IN ('draft', 'template')
            AND deleted_at IS NULL`,
      )
      .run(
        input.versionId,
        input.filename,
        input.sizeBytes,
        input.createdAt,
        input.projectId,
        input.documentId,
        input.expectedCurrentVersionId,
      );
    const current = this.database
      .prepare(
        "SELECT current_version_id FROM documents WHERE project_id = ? AND id = ?",
      )
      .get(input.projectId, input.documentId);
    if (current?.current_version_id !== input.versionId) {
      studioError(
        "DOCUMENT_STUDIO_VERSION_CONFLICT",
        "Studio document changed while the version was being committed.",
      );
    }
    this.insertParseJob(
      input.jobId,
      input.documentId,
      input.versionId,
      input.createdAt,
    );
    this.blobRecords.registerStoredInTransaction({
      id: input.blobRecordId,
      locator: {
        kind: "original",
        documentId: input.documentId,
        versionId: input.versionId,
      },
      contentSha256: input.contentSha256,
      sizeBytes: input.sizeBytes,
      storedSizeBytes: input.storedSizeBytes,
    });
    return this.commitProjection(
      input.projectId,
      input.documentId,
      input.versionId,
      input.jobId,
    );
  }

  private selectVersion(
    projectId: string,
    documentId: string,
    versionId: string,
  ): Row | undefined {
    return this.database
      .prepare(
        `SELECT ${VERSION_SELECT}
           FROM document_studio_versions studio
           JOIN documents document
             ON document.id = studio.document_id
            AND document.project_id = studio.project_id
           JOIN document_versions version
             ON version.document_id = studio.document_id
            AND version.id = studio.version_id
          WHERE studio.project_id = ?
            AND studio.document_id = ?
            AND studio.version_id = ?
            AND document.document_kind IN ('draft', 'template')
            AND document.deleted_at IS NULL
            AND version.deleted_at IS NULL`,
      )
      .get(projectId, documentId, versionId);
  }

  private mapDocument(row: Row): StudioDocumentV12 {
    try {
      return StudioDocumentV12Schema.parse({
        id: row.document_id,
        projectId: row.document_project_id,
        folderId: row.document_folder_id,
        documentKind: row.document_kind,
        title: row.document_title,
        filename: row.document_filename,
        mimeType: row.document_mime_type,
        sizeBytes: Number(row.document_size_bytes),
        parseStatus: row.document_parse_status,
        currentVersionId: row.document_current_version_id,
        createdAt: row.document_created_at,
        updatedAt: row.document_updated_at,
      });
    } catch (error) {
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Persisted Studio document is invalid.",
        error,
      );
    }
  }

  private mapVersion(row: Row): StudioDocumentVersionV12 {
    const projectId = String(row.project_id);
    const documentId = String(row.document_id);
    const versionId = String(row.version_id);
    const expectedStorageKey = workspaceBlobStorageKey({
      kind: "original",
      documentId,
      versionId,
    });
    if (row.version_storage_key !== expectedStorageKey) {
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Persisted Studio version storage key is not deterministic.",
      );
    }
    try {
      return StudioDocumentVersionV12Schema.parse({
        id: versionId,
        projectId,
        documentId,
        versionNumber: Number(row.version_number),
        source: row.version_source,
        filename: row.version_filename,
        mimeType: row.version_mime_type,
        sizeBytes: Number(row.version_size_bytes),
        contentSha256: row.version_content_sha256,
        storageKey: row.version_storage_key,
        pageCount:
          row.version_page_count == null
            ? null
            : Number(row.version_page_count),
        format: row.studio_format,
        summary: row.studio_summary,
        operationId: row.studio_operation_id,
        createdAt: row.studio_created_at,
        citationAnchorIds: this.listCitationAnchorIdsRaw(
          projectId,
          documentId,
          versionId,
        ),
      });
    } catch (error) {
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Persisted Studio document version is invalid.",
        error,
      );
    }
  }

  private listCitationAnchorIdsRaw(
    projectId: string,
    documentId: string,
    versionId: string,
  ) {
    return this.database
      .prepare(
        `SELECT anchor_id FROM document_version_citation_anchors
          WHERE project_id = ? AND document_id = ? AND version_id = ?
          ORDER BY ordinal ASC, anchor_id ASC`,
      )
      .all(projectId, documentId, versionId)
      .map((row) => String(row.anchor_id));
  }

  private assertCitationScope(projectId: string, anchorIds: readonly string[]) {
    for (const anchorId of anchorIds) {
      const anchor = this.database
        .prepare(
          "SELECT id FROM source_citation_anchors WHERE project_id = ? AND id = ?",
        )
        .get(projectId, anchorId);
      if (!anchor) {
        studioError(
          "DOCUMENT_STUDIO_NOT_FOUND",
          "Citation anchor was not found.",
        );
      }
    }
  }

  private insertStudioMetadata(input: {
    projectId: string;
    documentId: string;
    versionId: string;
    summary: string | null;
    operationId: string | null;
    createdAt: string;
  }) {
    this.database
      .prepare(
        `INSERT INTO document_studio_versions (
           project_id, document_id, version_id, format, summary, operation_id,
           created_at
         ) VALUES (?, ?, ?, 'markdown', ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.documentId,
        input.versionId,
        input.summary,
        input.operationId,
        input.createdAt,
      );
  }

  private insertCitationBindings(
    projectId: string,
    documentId: string,
    versionId: string,
    anchorIds: readonly string[],
    createdAt: string,
  ) {
    anchorIds.forEach((anchorId, ordinal) => {
      this.database
        .prepare(
          `INSERT INTO document_version_citation_anchors (
             project_id, document_id, version_id, anchor_id, ordinal,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          documentId,
          versionId,
          anchorId,
          ordinal,
          createdAt,
        );
    });
  }

  private insertParseJob(
    jobId: string,
    documentId: string,
    versionId: string,
    at: string,
  ) {
    this.database
      .prepare(
        `INSERT INTO jobs (
           id, type, status, resource_type, resource_id, attempt, max_attempts,
           retryable, payload_json, scheduled_at, created_at, updated_at
         ) VALUES (?, 'document_parse', 'queued', 'document', ?, 0, 3, 1,
                   ?, ?, ?, ?)`,
      )
      .run(
        jobId,
        documentId,
        JSON.stringify({ documentId, versionId }),
        at,
        at,
        at,
      );
  }

  private commitProjection(
    projectId: string,
    documentId: string,
    versionId: string,
    jobId: string,
  ): StudioVersionCommitV12 {
    const document = this.getProjectDocument(projectId, documentId);
    const version = this.getVersion(projectId, documentId, versionId);
    if (!document || !version) {
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Studio commit could not be reloaded.",
      );
    }
    return {
      ...document,
      version,
      jobId,
      citationAnchorIds: [...version.citationAnchorIds],
      replayed: false,
    };
  }

  private persist<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the primary failure.
      }
      if (error instanceof WorkspaceDocumentStudioRepositoryError) throw error;
      studioError(
        "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
        "Document Studio data could not be persisted.",
        error,
      );
    }
  }
}
