import { createHash, randomUUID } from "node:crypto";

import type { BlobStore } from "../blobStore";
import { WorkspaceApiError } from "../errors";
import { documentStorageKey } from "../repositories/documents";
import type {
  WorkspaceBlobRecord,
  WorkspaceBlobRecordsRepository,
} from "../repositories/blobRecords";
import type {
  Document,
  DocumentVersion,
  DocumentVersionSource,
} from "../types";
import type { WorkspaceBlobCleanupRecorder } from "./documents";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MARKDOWN_MIME_TYPE = "text/markdown";
const MAX_TITLE_CODE_POINTS = 240;
const MAX_CONTENT_CHARACTERS = 2_000_000;
const MAX_CONTENT_BYTES = 4_000_000;
const MAX_SUMMARY_CODE_POINTS = 500;
const MAX_CITATION_ANCHORS = 200;

export type DocumentStudioSaveSource = Extract<
  DocumentVersionSource,
  "user_upload" | "assistant_edit"
>;

export type DocumentStudioCitationAnchor = {
  id: string;
  projectId: string;
  snapshotId: string;
  ordinal: number;
  exactQuote: string;
  quoteSha256: string;
  locator: Record<string, unknown>;
  createdAt: string;
};

export type DocumentStudioVersion = DocumentVersion & {
  citationAnchorIds: string[];
};

export type DocumentStudioDocument = {
  document: Document;
  version: DocumentStudioVersion;
  content: string;
  citationAnchors: DocumentStudioCitationAnchor[];
};

export type DocumentStudioVersionList = {
  document: Document;
  versions: DocumentStudioVersion[];
};

export type DocumentStudioOriginalBlobLocator = {
  kind: "original";
  documentId: string;
  versionId: string;
};

export type DocumentStudioStoredBlobInput = {
  id: string;
  locator: DocumentStudioOriginalBlobLocator;
  contentSha256: string;
  sizeBytes: number;
  storedSizeBytes: number;
};

export type DocumentStudioCreatePersistenceInput = {
  documentId: string;
  versionId: string;
  jobId: string;
  projectId: string;
  folderId: string | null;
  title: string;
  filename: string;
  mimeType: typeof MARKDOWN_MIME_TYPE;
  sizeBytes: number;
  contentSha256: string;
  storageKey: string;
  source: "user_upload";
  blobRecord: DocumentStudioStoredBlobInput;
};

export type DocumentStudioCommitPersistenceInput = {
  documentId: string;
  versionId: string;
  jobId: string;
  projectId: string;
  expectedCurrentVersionId: string;
  source: DocumentStudioSaveSource;
  filename: string;
  mimeType: typeof MARKDOWN_MIME_TYPE;
  sizeBytes: number;
  contentSha256: string;
  storageKey: string;
  citationAnchorIds: string[];
  summary: string | null;
  blobRecord: DocumentStudioStoredBlobInput;
};

export type DocumentStudioRestorePersistenceInput = Omit<
  DocumentStudioCommitPersistenceInput,
  "source" | "summary"
> & {
  targetVersionId: string;
  source: "user_upload";
  summary: null;
};

export type DocumentStudioPersistenceResult = {
  document: Document;
  version: DocumentVersion;
  job?: unknown;
};

/**
 * Persistence seam for v12. The service owns validation, encrypted blob I/O,
 * compensation and transport-safe errors; the repository owns one atomic CAS
 * transaction over existing documents/document_versions plus citations.
 */
export interface WorkspaceDocumentStudioRepositoryPort {
  getProjectDocument(projectId: string, documentId: string): Document | null;
  getVersion(
    projectId: string,
    documentId: string,
    versionId: string,
  ): DocumentVersion | null;
  listVersions(projectId: string, documentId: string): DocumentVersion[];
  createMarkdownDraft(
    input: DocumentStudioCreatePersistenceInput,
  ): DocumentStudioPersistenceResult;
  commitMarkdownVersionCas(
    input: DocumentStudioCommitPersistenceInput,
  ): DocumentStudioPersistenceResult;
  restoreVersionCas(
    input: DocumentStudioRestorePersistenceInput,
  ): DocumentStudioPersistenceResult;
  listVersionCitationAnchors(
    projectId: string,
    documentId: string,
    versionId: string,
  ): DocumentStudioCitationAnchor[];
}

export type CreateDocumentStudioDraftInput = {
  projectId: string;
  folderId?: string | null;
  title: string;
};

export type SaveDocumentStudioDocumentInput = {
  projectId: string;
  documentId: string;
  expectedVersionId: string;
  content: string;
  source: DocumentStudioSaveSource;
  citationAnchorIds?: readonly string[];
  summary?: string | null;
};

export type RestoreDocumentStudioVersionInput = {
  projectId: string;
  documentId: string;
  targetVersionId: string;
  expectedCurrentVersionId: string;
};

export type WorkspaceDocumentStudioServiceOptions = {
  nextId?: () => string;
  cleanupRecorder: WorkspaceBlobCleanupRecorder;
};

type BlobRecordReader = Pick<WorkspaceBlobRecordsRepository, "getByLocator">;

class DocumentStudioCleanupPendingError extends Error {
  constructor() {
    super("Document Studio blob cleanup is pending.");
    this.name = "DocumentStudioCleanupPendingError";
  }
}

function codedError(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export function toDocumentStudioApiError(error: unknown): WorkspaceApiError {
  if (error instanceof WorkspaceApiError) return error;
  const code = codedError(error);
  if (code === "DOCUMENT_STUDIO_NOT_FOUND") {
    return new WorkspaceApiError(
      404,
      "NOT_FOUND",
      "Studio document was not found.",
    );
  }
  if (code === "DOCUMENT_STUDIO_VERSION_CONFLICT") {
    return new WorkspaceApiError(
      409,
      "CONFLICT",
      "The document changed before this version could be saved.",
    );
  }
  if (code === "DOCUMENT_STUDIO_SCOPE_VIOLATION") {
    return new WorkspaceApiError(
      404,
      "NOT_FOUND",
      "Studio document resource was not found.",
    );
  }
  if (code === "DOCUMENT_STUDIO_OPERATION_CONFLICT") {
    return new WorkspaceApiError(
      409,
      "CONFLICT",
      "Studio document operation conflicts with existing history.",
    );
  }
  if (code === "DOCUMENT_STUDIO_INVALID_INPUT") {
    return new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "Studio document request is invalid.",
    );
  }
  if (
    code === "DOCUMENT_STUDIO_PERSISTENCE_FAILED" ||
    error instanceof DocumentStudioCleanupPendingError
  ) {
    return new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Studio document could not be persisted safely.",
    );
  }
  return new WorkspaceApiError(
    500,
    "INTERNAL_ERROR",
    "Studio document operation failed.",
  );
}

function assertUuid(value: string, name: string): string {
  if (!UUID.test(value)) {
    throw new WorkspaceApiError(422, "VALIDATION_ERROR", `${name} is invalid.`);
  }
  return value;
}

function normalizeTitle(value: string): string {
  if (typeof value !== "string") {
    throw new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "Document title is invalid.",
    );
  }
  const title = value.trim().normalize("NFC");
  if (!title || [...title].length > MAX_TITLE_CODE_POINTS) {
    throw new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "Document title is invalid.",
    );
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(title)) {
    throw new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "Document title is invalid.",
    );
  }
  return title;
}

function markdownFilename(title: string): string {
  const withoutExtension = title.replace(/\.md$/i, "").trim();
  const cleaned = withoutExtension
    .replace(/[\\/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const base =
    cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "Untitled";
  const points: string[] = [];
  let utf16Length = 0;
  for (const point of base) {
    if (utf16Length + point.length > 237) break;
    points.push(point);
    utf16Length += point.length;
  }
  return `${points.join("").trim() || "Untitled"}.md`;
}

function contentBuffer(value: string): Buffer {
  if (typeof value !== "string" || value.length > MAX_CONTENT_CHARACTERS) {
    throw new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "Document content is too large.",
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    throw new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "Document content contains unsupported control characters.",
    );
  }
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength > MAX_CONTENT_BYTES) {
    throw new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "Document content is too large.",
    );
  }
  return buffer;
}

function normalizeSummary(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "Edit summary is invalid.",
    );
  }
  const summary = value.trim();
  if (
    !summary ||
    [...summary].length > MAX_SUMMARY_CODE_POINTS ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(summary)
  ) {
    throw new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "Edit summary is invalid.",
    );
  }
  return summary;
}

function normalizeCitationIds(values: readonly string[] | undefined): string[] {
  const result = values ? [...values] : [];
  if (result.length > MAX_CITATION_ANCHORS) {
    throw new WorkspaceApiError(
      422,
      "VALIDATION_ERROR",
      "Too many citation anchors were supplied.",
    );
  }
  const unique = new Set<string>();
  for (const value of result) {
    assertUuid(value, "Citation anchor");
    if (unique.has(value)) {
      throw new WorkspaceApiError(
        422,
        "VALIDATION_ERROR",
        "Citation anchors must be unique.",
      );
    }
    unique.add(value);
  }
  return result;
}

function isMarkdownVersion(
  version: Pick<DocumentVersion, "filename" | "mimeType">,
): boolean {
  return (
    version.filename.toLowerCase().endsWith(".md") &&
    (version.mimeType.toLowerCase() === "text/markdown" ||
      version.mimeType.toLowerCase() === "text/plain")
  );
}

function originalLocator(documentId: string, versionId: string) {
  return { kind: "original" as const, documentId, versionId };
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertStoredRecord(
  record: WorkspaceBlobRecord | null,
  version: DocumentVersion,
): WorkspaceBlobRecord {
  if (
    !record ||
    record.state !== "stored" ||
    record.contentSha256 !== version.contentSha256 ||
    record.sizeBytes !== version.sizeBytes ||
    !SHA256.test(record.contentSha256)
  ) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Studio document storage integrity check failed.",
    );
  }
  return record;
}

export class WorkspaceDocumentStudioService {
  private readonly nextId: () => string;
  private readonly cleanupRecorder: WorkspaceBlobCleanupRecorder;

  constructor(
    private readonly repository: WorkspaceDocumentStudioRepositoryPort,
    private readonly blobs: BlobStore,
    private readonly blobRecords: BlobRecordReader,
    options: WorkspaceDocumentStudioServiceOptions,
  ) {
    if (!options.cleanupRecorder) {
      throw new Error(
        "Document Studio requires a durable blob cleanup recorder.",
      );
    }
    this.nextId = options.nextId ?? randomUUID;
    this.cleanupRecorder = options.cleanupRecorder;
  }

  async createDraft(
    input: CreateDocumentStudioDraftInput,
  ): Promise<DocumentStudioDocument> {
    try {
      const projectId = assertUuid(input.projectId, "Project");
      const folderId =
        input.folderId == null ? null : assertUuid(input.folderId, "Folder");
      const title = normalizeTitle(input.title);
      const filename = markdownFilename(title);
      const buffer = contentBuffer("");
      const ids = this.newWriteIds();
      const stored = this.store(ids.documentId, ids.versionId, buffer);
      let result: DocumentStudioPersistenceResult;
      try {
        result = this.repository.createMarkdownDraft({
          ...ids,
          projectId,
          folderId,
          title,
          filename,
          mimeType: MARKDOWN_MIME_TYPE,
          sizeBytes: buffer.byteLength,
          contentSha256: sha256(buffer),
          storageKey: documentStorageKey(ids.documentId, ids.versionId),
          source: "user_upload",
          blobRecord: stored,
        });
      } catch (error) {
        this.compensate(stored.locator);
        throw error;
      }
      return this.hydrate(projectId, result.document, result.version, "");
    } catch (error) {
      throw toDocumentStudioApiError(error);
    }
  }

  async getDocument(
    projectIdInput: string,
    documentIdInput: string,
    versionIdInput?: string,
  ): Promise<DocumentStudioDocument> {
    try {
      const projectId = assertUuid(projectIdInput, "Project");
      const documentId = assertUuid(documentIdInput, "Document");
      const document = this.requireDocument(projectId, documentId);
      const selectedVersionId = versionIdInput
        ? assertUuid(versionIdInput, "Document version")
        : document.currentVersionId;
      if (!selectedVersionId) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Studio document has no current version.",
        );
      }
      const version = this.requireVersion(
        projectId,
        documentId,
        selectedVersionId,
      );
      const content = this.readContent(version);
      return this.hydrate(projectId, document, version, content);
    } catch (error) {
      throw toDocumentStudioApiError(error);
    }
  }

  async listVersions(
    projectIdInput: string,
    documentIdInput: string,
  ): Promise<DocumentStudioVersionList> {
    try {
      const projectId = assertUuid(projectIdInput, "Project");
      const documentId = assertUuid(documentIdInput, "Document");
      const document = this.requireDocument(projectId, documentId);
      return {
        document,
        versions: this.repository
          .listVersions(projectId, documentId)
          .map((version) => {
            if (!isMarkdownVersion(version)) {
              throw new WorkspaceApiError(
                409,
                "CONFLICT",
                "Document is not editable in Document Studio.",
              );
            }
            return this.versionWithCitations(projectId, documentId, version);
          }),
      };
    } catch (error) {
      throw toDocumentStudioApiError(error);
    }
  }

  async save(
    input: SaveDocumentStudioDocumentInput,
  ): Promise<DocumentStudioDocument> {
    try {
      const projectId = assertUuid(input.projectId, "Project");
      const documentId = assertUuid(input.documentId, "Document");
      const expectedVersionId = assertUuid(
        input.expectedVersionId,
        "Expected document version",
      );
      const citationAnchorIds = normalizeCitationIds(input.citationAnchorIds);
      const summary = normalizeSummary(input.summary);
      if (input.source !== "user_upload" && input.source !== "assistant_edit") {
        throw new WorkspaceApiError(
          422,
          "VALIDATION_ERROR",
          "Document version source is invalid.",
        );
      }
      const document = this.requireDocument(projectId, documentId);
      const buffer = contentBuffer(input.content);
      const ids = this.newWriteIds(documentId);
      const stored = this.store(documentId, ids.versionId, buffer);
      let result: DocumentStudioPersistenceResult;
      try {
        result = this.repository.commitMarkdownVersionCas({
          ...ids,
          documentId,
          projectId,
          expectedCurrentVersionId: expectedVersionId,
          source: input.source,
          filename: document.filename,
          mimeType: MARKDOWN_MIME_TYPE,
          sizeBytes: buffer.byteLength,
          contentSha256: sha256(buffer),
          storageKey: documentStorageKey(documentId, ids.versionId),
          citationAnchorIds,
          summary,
          blobRecord: stored,
        });
      } catch (error) {
        this.compensate(stored.locator);
        throw error;
      }
      return this.hydrate(
        projectId,
        result.document,
        result.version,
        input.content,
      );
    } catch (error) {
      throw toDocumentStudioApiError(error);
    }
  }

  async restore(
    input: RestoreDocumentStudioVersionInput,
  ): Promise<DocumentStudioDocument> {
    try {
      const projectId = assertUuid(input.projectId, "Project");
      const documentId = assertUuid(input.documentId, "Document");
      const targetVersionId = assertUuid(
        input.targetVersionId,
        "Target document version",
      );
      const expectedCurrentVersionId = assertUuid(
        input.expectedCurrentVersionId,
        "Expected current version",
      );
      const document = this.requireDocument(projectId, documentId);
      const target = this.requireVersion(
        projectId,
        documentId,
        targetVersionId,
      );
      const content = this.readContent(target);
      const buffer = contentBuffer(content);
      const citationAnchorIds = this.repository
        .listVersionCitationAnchors(projectId, documentId, targetVersionId)
        .map((anchor) => anchor.id);
      const ids = this.newWriteIds(documentId);
      const stored = this.store(documentId, ids.versionId, buffer);
      let result: DocumentStudioPersistenceResult;
      try {
        result = this.repository.restoreVersionCas({
          ...ids,
          documentId,
          projectId,
          targetVersionId,
          expectedCurrentVersionId,
          source: "user_upload",
          filename: target.filename,
          mimeType: MARKDOWN_MIME_TYPE,
          sizeBytes: buffer.byteLength,
          contentSha256: sha256(buffer),
          storageKey: documentStorageKey(documentId, ids.versionId),
          citationAnchorIds,
          summary: null,
          blobRecord: stored,
        });
      } catch (error) {
        this.compensate(stored.locator);
        throw error;
      }
      return this.hydrate(projectId, result.document, result.version, content);
    } catch (error) {
      throw toDocumentStudioApiError(error);
    }
  }

  private requireDocument(projectId: string, documentId: string): Document {
    const document = this.repository.getProjectDocument(projectId, documentId);
    if (!document) {
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Studio document was not found.",
      );
    }
    if (!document.currentVersionId) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Studio document has no current version.",
      );
    }
    const current = this.repository.getVersion(
      projectId,
      documentId,
      document.currentVersionId,
    );
    if (!current || !isMarkdownVersion(current)) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Document is not editable in Document Studio.",
      );
    }
    return document;
  }

  private requireVersion(
    projectId: string,
    documentId: string,
    versionId: string,
  ): DocumentVersion {
    const version = this.repository.getVersion(
      projectId,
      documentId,
      versionId,
    );
    if (!version) {
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Studio document version was not found.",
      );
    }
    if (!isMarkdownVersion(version)) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Document version is not editable in Document Studio.",
      );
    }
    return version;
  }

  private readContent(version: DocumentVersion): string {
    const locator = originalLocator(version.documentId, version.id);
    const record = assertStoredRecord(
      this.blobRecords.getByLocator(locator),
      version,
    );
    const buffer = this.blobs.readSync(locator, {
      sha256: record.contentSha256,
      size: record.sizeBytes,
    });
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buffer,
      );
    } catch {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Document content is not valid UTF-8 text.",
      );
    }
  }

  private hydrate(
    projectId: string,
    document: Document,
    version: DocumentVersion,
    content: string,
  ): DocumentStudioDocument {
    const withCitations = this.versionWithCitations(
      projectId,
      document.id,
      version,
    );
    return {
      document,
      version: withCitations,
      content,
      citationAnchors: this.repository.listVersionCitationAnchors(
        projectId,
        document.id,
        version.id,
      ),
    };
  }

  private versionWithCitations(
    projectId: string,
    documentId: string,
    version: DocumentVersion,
  ): DocumentStudioVersion {
    return {
      ...version,
      citationAnchorIds: this.repository
        .listVersionCitationAnchors(projectId, documentId, version.id)
        .map((anchor) => anchor.id),
    };
  }

  private newWriteIds(documentId = this.nextId()) {
    const ids = {
      documentId,
      versionId: this.nextId(),
      jobId: this.nextId(),
    };
    assertUuid(ids.documentId, "Generated document");
    assertUuid(ids.versionId, "Generated document version");
    assertUuid(ids.jobId, "Generated parse job");
    return ids;
  }

  private store(
    documentId: string,
    versionId: string,
    buffer: Buffer,
  ): DocumentStudioStoredBlobInput {
    const locator = originalLocator(documentId, versionId);
    this.recordCleanup(documentId, versionId, locator, null);
    const stored = this.blobs.putSync(locator, buffer);
    return {
      id: assertUuid(this.nextId(), "Generated blob record"),
      locator,
      contentSha256: stored.sha256,
      sizeBytes: stored.size,
      storedSizeBytes: stored.storedSize,
    };
  }

  private compensate(locator: DocumentStudioOriginalBlobLocator) {
    let receipt = null;
    try {
      receipt = this.blobs.stageDeleteSync(locator);
      this.blobs.finalizeDeleteSync(receipt);
    } catch {
      this.recordCleanup(
        locator.documentId,
        locator.versionId,
        locator,
        receipt,
      );
      throw new DocumentStudioCleanupPendingError();
    }
  }

  private recordCleanup(
    documentId: string,
    versionId: string,
    locator: DocumentStudioOriginalBlobLocator,
    receipt: ReturnType<BlobStore["stageDeleteSync"]> | null,
  ) {
    try {
      this.cleanupRecorder.record({
        operation: "compensation",
        code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
        documentId,
        versionId,
        locator,
        receipt,
      });
    } catch {
      throw new DocumentStudioCleanupPendingError();
    }
  }
}
