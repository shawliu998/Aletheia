import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  MAX_UPLOAD_SIZE_BYTES,
  uploadedDocumentValidationError,
} from "../../upload";
import type { BlobStore, WorkspaceBlobDeleteReceipt, WorkspaceBlobLocator } from "../blobStore";
import { WorkspaceApiError } from "../errors";
import {
  documentStorageKey,
  MAX_WORKSPACE_FILENAME_LENGTH,
  type ActiveDocumentDependentJob,
  type CreatePendingDocumentInput,
  type DocumentParseJob,
  type DocumentVersionRow,
  type WorkspaceDocumentsRepository,
} from "../repositories/documents";
import { workspaceBlobStorageKey, type WorkspaceBlobRecord } from "../repositories/blobRecords";
import type { Document, DocumentChunk, DocumentStatus } from "../types";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SupportedExtension = ".pdf" | ".docx" | ".xlsx" | ".txt" | ".md";

export type UploadDocumentInput = {
  filename: string;
  mimetype: string;
  buffer: Buffer;
  projectId?: string | null;
  folderId?: string | null;
};

export type PublicDocumentVersion = Omit<
  DocumentVersionRow,
  "storageKey" | "previewStorageKey" | "deletedAt"
>;

export type DocumentUploadResult = {
  document: Document;
  version: PublicDocumentVersion;
  job: DocumentParseJob;
};

export type DocumentDeleteResult = {
  documentId: string;
  versionIds: string[];
  stagedCount: number;
};

export type WorkspaceBlobCleanupRecorder = {
  record(input: {
    operation: "compensation" | "restore" | "finalize";
    code: "DOCUMENT_BLOB_COMPENSATION_FAILED" | "DOCUMENT_BLOB_RESTORE_FAILED" | "DOCUMENT_BLOB_FINALIZE_FAILED";
    documentId: string;
    versionId: string;
    locator: WorkspaceBlobLocator;
    receipt: WorkspaceBlobDeleteReceipt | null;
  }): void;
};

export interface DocumentResourceLifecyclePort {
  cancelQueued(jobIds: readonly string[], reason: string): void;
  requestAbortRunning(jobIds: readonly string[], reason: string): void;
}

export class WorkspaceBlobCleanupPendingError extends Error {
  readonly code:
    | "DOCUMENT_BLOB_COMPENSATION_FAILED"
    | "DOCUMENT_BLOB_RESTORE_FAILED"
    | "DOCUMENT_BLOB_FINALIZE_FAILED";

  constructor(code: WorkspaceBlobCleanupPendingError["code"]) {
    super("Document blob cleanup is pending a safe retry; the operation is not complete.");
    this.name = "WorkspaceBlobCleanupPendingError";
    this.code = code;
  }
}

export function toDocumentApiError(error: unknown): WorkspaceApiError {
  if (error instanceof WorkspaceApiError) return error;
  if (error instanceof WorkspaceBlobCleanupPendingError) {
    return new WorkspaceApiError(500, "INTERNAL_ERROR", "Document blob cleanup is pending.");
  }
  const message = error instanceof Error ? error.message : "";
  if (/DOCUMENT_RETRY_DOCUMENT_NOT_FOUND|DOCUMENT_RETRY_VERSION_NOT_FOUND/.test(message)) {
    return new WorkspaceApiError(404, "NOT_FOUND", "Document retry resource was not found.");
  }
  if (/DOCUMENT_RETRY_ACTIVE/.test(message)) {
    return new WorkspaceApiError(409, "CONFLICT", "Document already has an active parse job.");
  }
  if (/DOCUMENT_RETRY_EXHAUSTED/.test(message)) {
    return new WorkspaceApiError(409, "CONFLICT", "Document parse retry limit has been reached.");
  }
  if (/DOCUMENT_RETRY_NOT_ALLOWED/.test(message)) {
    return new WorkspaceApiError(409, "CONFLICT", "Document is not eligible for parse retry.");
  }
  if (/DOCUMENT_DELETE_BUSY|DOCUMENT_DELETE_DEPENDENCY_CONFLICT|DOCUMENT_DELETE_ASSISTANT_BUSY|does not belong|not active|already|conflict/i.test(message)) {
    return new WorkspaceApiError(
      409,
      "CONFLICT",
      /DOCUMENT_DELETE_BUSY|DOCUMENT_DELETE_DEPENDENCY_CONFLICT|DOCUMENT_DELETE_ASSISTANT_BUSY/.test(message)
        ? "Document has an active parse job or dependent work."
        : "Document placement conflicts with the requested resource.",
    );
  }
  if (/signature|MIME|mime|too large|exceeds|100 MB|file type|invalid .*file/i.test(message)) {
    return new WorkspaceApiError(400, "VALIDATION_ERROR", "Document request is invalid.");
  }
  if (/unsupported|UNSUPPORTED|DOCUMENT_DOCX_UNAVAILABLE|DOCUMENT_PREVIEW_METADATA_UNAVAILABLE/i.test(message)) {
    return new WorkspaceApiError(409, "CONFLICT", "Document operation is not supported for this resource.");
  }
  if (/not found|was not found|invalid|must be|filename|MIME|UUID|storageKey|extension/i.test(message)) {
    if (/Document version/i.test(message)) return new WorkspaceApiError(404, "NOT_FOUND", "Document version was not found.");
    if (/not found|was not found/i.test(message)) return new WorkspaceApiError(404, "NOT_FOUND", "Document resource was not found.");
    return new WorkspaceApiError(400, "VALIDATION_ERROR", "Document request is invalid.");
  }
  if (/integrity|tamper|hash|cleanup|compensation|blob/i.test(message)) {
    return new WorkspaceApiError(500, "INTERNAL_ERROR", "Document storage integrity or cleanup failed.");
  }
  return new WorkspaceApiError(500, "INTERNAL_ERROR", "Document operation failed.");
}

function assertUuid(value: string | null | undefined, name: string): string | null {
  if (value == null) return null;
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID.`);
  return value;
}

function safeFilename(filename: string) {
  const value = filename.trim();
  if (
    !value ||
    value.length > MAX_WORKSPACE_FILENAME_LENGTH ||
    value === "." ||
    value === ".." ||
    path.isAbsolute(value) ||
    value.includes("/") ||
    value.includes("\\") ||
    [...value].some((character) => character < " " || character === "\u007f")
  ) {
    throw new Error("filename must be a single safe file name, not a client path.");
  }
  return value;
}

function extensionOf(filename: string): SupportedExtension | null {
  const extension = path.extname(filename).toLowerCase();
  return [".pdf", ".docx", ".xlsx", ".txt", ".md"].includes(extension)
    ? (extension as SupportedExtension)
    : null;
}

function mimeMatches(extension: SupportedExtension, mimetype: string) {
  const normalized = mimetype.trim().toLowerCase();
  if (extension === ".pdf") return normalized === "application/pdf";
  if (extension === ".docx") {
    return normalized === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (extension === ".xlsx") {
    return normalized === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return normalized === "text/plain" || normalized === "text/markdown";
}

function titleFromFilename(filename: string) {
  return filename.replace(/\.[^.]+$/, "").trim().slice(0, 500) || filename;
}

function toPublicVersion(version: DocumentVersionRow): PublicDocumentVersion {
  const { storageKey: _storageKey, previewStorageKey: _previewStorageKey, deletedAt: _deletedAt, ...publicVersion } = version;
  return publicVersion;
}

function originalLocator(documentId: string, versionId: string): WorkspaceBlobLocator {
  return { kind: "original", documentId, versionId };
}

function hashBuffer(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export class WorkspaceDocumentsService {
  constructor(
    private readonly repository: WorkspaceDocumentsRepository,
    private readonly blobs: BlobStore,
    private readonly nextId: () => string = randomUUID,
    private readonly cleanupRecorder: WorkspaceBlobCleanupRecorder,
    private readonly resources: DocumentResourceLifecyclePort | null = null,
  ) {
    if (!cleanupRecorder) {
      throw new Error("Workspace document service requires a durable blob cleanup recorder.");
    }
  }

  async upload(input: UploadDocumentInput): Promise<DocumentUploadResult> {
    try {
      return await this.uploadInternal(input);
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  private async uploadInternal(input: UploadDocumentInput): Promise<DocumentUploadResult> {
    const filename = safeFilename(input.filename);
    const extension = extensionOf(filename);
    if (!extension) throw new Error("Unsupported document type. Use PDF, DOCX, XLSX, TXT, or MD.");
    if (!input.mimetype.trim() || !mimeMatches(extension, input.mimetype)) {
      throw new Error("The uploaded MIME type does not match the filename extension.");
    }
    if (!Buffer.isBuffer(input.buffer)) throw new Error("Upload buffer is required.");
    if (input.buffer.length > MAX_UPLOAD_SIZE_BYTES) throw new Error("Uploaded document exceeds the 100 MB limit.");
    const projectId = assertUuid(input.projectId, "projectId");
    const folderId = assertUuid(input.folderId, "folderId");
    const validationError = await uploadedDocumentValidationError({
      fieldname: "file",
      originalname: filename,
      encoding: "7bit",
      mimetype: input.mimetype,
      size: input.buffer.length,
      destination: "",
      filename: "",
      path: "",
      buffer: input.buffer,
      stream: undefined as never,
    } as Express.Multer.File);
    if (validationError) throw new Error(validationError);

    const documentId = this.nextId();
    const versionId = this.nextId();
    const jobId = this.nextId();
    assertUuid(documentId, "documentId");
    assertUuid(versionId, "versionId");
    assertUuid(jobId, "jobId");
    const locator = originalLocator(documentId, versionId);
    const contentSha256 = hashBuffer(input.buffer);
    this.recordCleanup({
      operation: "compensation",
      code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
      documentId,
      versionId,
      locator,
      receipt: null,
    });
    const stored = this.blobs.putSync(locator, input.buffer);
    const blobRecordId = this.nextId();
    try {
      const blobRecords = this.repository.getBlobRecordsRepository();
      if (!blobRecords) throw new Error("Workspace blob records repository is required for document upload.");
      const inputForRepository: CreatePendingDocumentInput = {
        documentId,
        versionId,
        jobId,
        projectId,
        folderId,
        title: titleFromFilename(filename),
        filename,
        mimeType: input.mimetype.trim().toLowerCase(),
        sizeBytes: input.buffer.length,
        contentSha256,
        storageKey: documentStorageKey(documentId, versionId),
        enqueueParseJob: true,
        blobRecord: {
          id: blobRecordId,
          locator,
          contentSha256: stored.sha256,
          sizeBytes: stored.size,
          storedSizeBytes: stored.storedSize,
        },
      };
      const created = this.repository.createPendingDocument(inputForRepository);
      if (!created.job) throw new Error("Document parse job was not created.");
      return {
        document: created.document,
        version: toPublicVersion(created.version),
        job: created.job,
      };
    } catch (error) {
      this.cleanupBlobAfterDatabaseFailure(locator, documentId, versionId);
      throw error;
    }
  }

  async uploadVersion(documentId: string, input: UploadDocumentInput): Promise<DocumentUploadResult> {
    try {
      return await this.uploadVersionInternal(documentId, input);
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  private async uploadVersionInternal(documentId: string, input: UploadDocumentInput): Promise<DocumentUploadResult> {
    const document = this.repository.getDocument(documentId);
    if (!document) throw new Error("Document was not found.");
    const filename = safeFilename(input.filename);
    const extension = extensionOf(filename);
    if (!extension) throw new Error("Unsupported document type. Use PDF, DOCX, XLSX, TXT, or MD.");
    if (!input.mimetype.trim() || !mimeMatches(extension, input.mimetype)) {
      throw new Error("The uploaded MIME type does not match the filename extension.");
    }
    if (!Buffer.isBuffer(input.buffer)) throw new Error("Upload buffer is required.");
    if (input.buffer.length > MAX_UPLOAD_SIZE_BYTES) throw new Error("Uploaded document exceeds the 100 MB limit.");
    const validationError = await uploadedDocumentValidationError({
      fieldname: "file",
      originalname: filename,
      encoding: "7bit",
      mimetype: input.mimetype,
      size: input.buffer.length,
      destination: "",
      filename: "",
      path: "",
      buffer: input.buffer,
      stream: undefined as never,
    } as Express.Multer.File);
    if (validationError) throw new Error(validationError);

    const versionId = this.nextId();
    const jobId = this.nextId();
    assertUuid(versionId, "versionId");
    assertUuid(jobId, "jobId");
    const locator = originalLocator(documentId, versionId);
    this.recordCleanup({
      operation: "compensation",
      code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
      documentId,
      versionId,
      locator,
      receipt: null,
    });
    const stored = this.blobs.putSync(locator, input.buffer);
    try {
      const blobRecords = this.repository.getBlobRecordsRepository();
      if (!blobRecords) throw new Error("Workspace blob records repository is required for document upload.");
      const created = this.repository.createPendingVersion({
        documentId,
        versionId,
        jobId,
        source: "upload",
        filename,
        mimeType: input.mimetype.trim().toLowerCase(),
        sizeBytes: input.buffer.length,
        contentSha256: hashBuffer(input.buffer),
        storageKey: documentStorageKey(documentId, versionId),
        blobRecord: {
          id: this.nextId(),
          locator,
          contentSha256: stored.sha256,
          sizeBytes: stored.size,
          storedSizeBytes: stored.storedSize,
        },
      });
      if (!created.job) throw new Error("Document parse job was not created.");
      return {
        document: created.document,
        version: toPublicVersion(created.version),
        job: created.job,
      };
    } catch (error) {
      this.cleanupBlobAfterDatabaseFailure(locator, documentId, versionId);
      throw error;
    }
  }

  rename(documentId: string, filename: string) {
    try {
      return this.repository.renameDocument(documentId, filename);
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  renameTitle(documentId: string, title: string) {
    try {
      return this.repository.renameDocumentTitle(documentId, title);
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  move(documentId: string, projectId: string | null, folderId: string | null) {
    try {
      return this.repository.moveDocument(documentId, projectId, folderId);
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  attach(documentId: string, projectId: string, folderId: string | null = null) {
    return this.move(documentId, projectId, folderId);
  }

  detach(documentId: string) {
    return this.move(documentId, null, null);
  }

  restore(_documentId: string): never {
    throw new WorkspaceApiError(409, "CONFLICT", "Document restore is not supported.");
  }

  deleteVersion(_documentId: string, _versionId: string): never {
    throw new WorkspaceApiError(409, "CONFLICT", "Document version deletion is not supported.");
  }

  retryParse(documentId: string, versionId?: string) {
    try {
      return this.repository.retryParse(documentId, versionId);
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  search(query: string, options: { documentId?: string; limit?: number } = {}): DocumentChunk[] {
    return this.repository.searchChunks(query, options);
  }

  deleteDocument(documentId: string): DocumentDeleteResult {
    const document = this.repository.getDocument(documentId);
    if (!document) throw new Error("Document was not found.");
    let deletionPlan;
    try {
      deletionPlan = this.repository.documentDeletionPlan(documentId);
    } catch (error) {
      throw toDocumentApiError(error);
    }
    this.settleActiveJobs(deletionPlan.activeJobs);
    try {
      if (this.repository.documentDeletionPlan(documentId).activeJobs.length > 0) {
        throw new Error("DOCUMENT_DELETE_BUSY");
      }
    } catch (error) {
      throw toDocumentApiError(error);
    }
    const versions = this.repository.listVersions(documentId);
    const records = this.repository.listDocumentBlobRecords(documentId);
    this.assertDeleteRecordSet(documentId, versions, records);
    const staged: Array<{
      recordId: string;
      receipt: WorkspaceBlobDeleteReceipt;
      documentId: string;
      versionId: string;
      locator: WorkspaceBlobLocator;
    }> = [];
    try {
      for (const record of records) {
        if (record.state !== "stored") throw new Error("Document delete encountered a non-stored authoritative blob record.");
        const versionId = record.locator.kind === "export" ? document.currentVersionId ?? documentId : record.locator.versionId;
        staged.push({
          recordId: record.id,
          receipt: this.blobs.stageDeleteSync(record.locator),
          documentId,
          versionId,
          locator: record.locator,
        });
      }
    } catch (error) {
      this.restoreStaged(staged);
      throw error;
    }

    try {
      this.repository.deleteDocumentRows(
        documentId,
        staged.map((item) => ({ recordId: item.recordId, quarantineId: item.receipt.quarantineId })),
      );
    } catch (error) {
      this.restoreStaged(staged);
      if (
        error instanceof Error &&
        /DOCUMENT_DELETE_BUSY|DOCUMENT_DELETE_DEPENDENCY_CONFLICT|DOCUMENT_DELETE_ASSISTANT_BUSY/.test(error.message)
      ) {
        throw toDocumentApiError(error);
      }
      throw error;
    }

    const finalizeErrors: unknown[] = [];
    for (const item of staged) {
      try {
        this.blobs.finalizeDeleteSync(item.receipt);
        this.repository.deleteBlobRecord(item.recordId, item.receipt.quarantineId);
      } catch (error) {
        this.recordCleanup({ ...item, operation: "finalize", code: "DOCUMENT_BLOB_FINALIZE_FAILED" });
        finalizeErrors.push(error);
      }
    }
    if (finalizeErrors.length) {
      throw new WorkspaceBlobCleanupPendingError("DOCUMENT_BLOB_FINALIZE_FAILED");
    }
    return { documentId, versionIds: versions.map((version) => version.id), stagedCount: staged.length };
  }

  private cleanupBlobAfterDatabaseFailure(locator: WorkspaceBlobLocator, documentId: string, versionId: string) {
    let stagedReceipt: WorkspaceBlobDeleteReceipt | null = null;
    try {
      stagedReceipt = this.blobs.stageDeleteSync(locator);
      this.blobs.finalizeDeleteSync(stagedReceipt);
    } catch (cleanupError) {
      this.recordCleanup({ operation: "compensation", code: "DOCUMENT_BLOB_COMPENSATION_FAILED", documentId, versionId, locator, receipt: stagedReceipt });
      throw new WorkspaceBlobCleanupPendingError("DOCUMENT_BLOB_COMPENSATION_FAILED");
    }
  }

  private settleActiveJobs(jobs: readonly ActiveDocumentDependentJob[]) {
    if (jobs.length === 0) return;
    if (!this.resources) {
      throw new WorkspaceApiError(409, "CONFLICT", "Document has an active parse job or dependent work.");
    }
    const queued = jobs.filter((job) => job.status === "queued").map((job) => job.id);
    const running = jobs.filter((job) => job.status === "running").map((job) => job.id);
    try {
      if (queued.length) this.resources.cancelQueued(queued, "Document deletion requested.");
      if (running.length) this.resources.requestAbortRunning(running, "Document deletion requested.");
    } catch {
      throw new WorkspaceApiError(409, "CONFLICT", "Document dependencies could not be stopped for deletion.");
    }
  }

  private assertDeleteRecordSet(
    documentId: string,
    versions: readonly DocumentVersionRow[],
    records: readonly WorkspaceBlobRecord[],
  ) {
    const versionIds = new Set(versions.map((version) => version.id));
    const originalByVersion = new Map<string, number>();
    const locatorKeys = new Set<string>();
    for (const record of records) {
      if (record.locator.kind === "export") throw new Error("Document delete authoritative blob record set is invalid.");
      if (record.locator.documentId !== documentId || !versionIds.has(record.locator.versionId)) {
        throw new Error("Document delete authoritative blob record set is invalid.");
      }
      if (record.storageKey !== workspaceBlobStorageKey(record.locator)) {
        throw new Error("Document delete authoritative blob record set is invalid.");
      }
      const locatorKey = `${record.locator.kind}:${record.locator.documentId}:${record.locator.versionId}:${record.locator.kind === "preview" ? record.locator.previewId ?? "default" : ""}`;
      if (locatorKeys.has(locatorKey)) throw new Error("Document delete authoritative blob record set is invalid.");
      locatorKeys.add(locatorKey);
      if (record.locator.kind === "original") {
        originalByVersion.set(record.locator.versionId, (originalByVersion.get(record.locator.versionId) ?? 0) + 1);
      }
    }
    for (const version of versions) {
      if (originalByVersion.get(version.id) !== 1) {
        throw new Error("Document delete authoritative blob record set is incomplete.");
      }
    }
  }

  private restoreStaged(staged: readonly { receipt: WorkspaceBlobDeleteReceipt; documentId: string; versionId: string; locator: WorkspaceBlobLocator }[]) {
    const restoreErrors: unknown[] = [];
    for (const item of [...staged].reverse()) {
      try {
        this.blobs.restoreDeleteSync(item.receipt);
      } catch (error) {
        this.recordCleanup({ ...item, operation: "restore", code: "DOCUMENT_BLOB_RESTORE_FAILED" });
        restoreErrors.push(error);
      }
    }
    if (restoreErrors.length) {
      throw new WorkspaceBlobCleanupPendingError("DOCUMENT_BLOB_RESTORE_FAILED");
    }
  }

  private recordCleanup(input: Parameters<WorkspaceBlobCleanupRecorder["record"]>[0]) {
    try {
      this.cleanupRecorder.record(input);
    } catch {
      throw new WorkspaceBlobCleanupPendingError(input.code);
    }
  }
}

export function documentStatusIsRetryable(status: DocumentStatus) {
  return status === "failed" || status === "ocr_required" || status === "unsupported";
}

export function isDocumentBlobLocator(locator: WorkspaceBlobLocator): boolean {
  return locator.kind === "original" || locator.kind === "extracted_text" || locator.kind === "preview";
}

export function createDocumentStorageKey(documentId: string, versionId: string) {
  return documentStorageKey(documentId, versionId);
}
