import { createHash } from "node:crypto";
import type { BlobStore, WorkspaceBlobLocator } from "../blobStore";
import { WorkspaceApiError } from "../errors";
import {
  InMemoryDownloadCapabilityStore,
  type DownloadCapabilityPurpose,
  type IssuedDownloadCapability,
} from "../downloadCapabilities";
import type { WorkspaceBlobRecord } from "../repositories/blobRecords";
import type {
  DocumentVersionRow,
  WorkspaceDocumentsRepository,
} from "../repositories/documents";
import type { Document } from "../types";
import {
  WorkspaceDocumentsService,
  toDocumentApiError,
  type DocumentDeleteResult,
  type DocumentUploadResult,
  type PublicDocumentVersion,
  type UploadDocumentInput,
} from "./documents";

export type DocumentDetail = {
  document: Document;
  versions: PublicDocumentVersion[];
};

export type DocumentReadKind = "original" | "preview";

export type DocumentReadResult = {
  documentId: string;
  versionId: string;
  kind: DocumentReadKind;
  filename: string;
  mimeType: string;
  contentLength: number;
  sha256: string;
  buffer: Buffer;
};

export type DocumentCatalogListOptions = {
  projectId?: string | null;
  folderId?: string | null;
  status?: Document["status"];
  limit?: number;
};

const PUBLIC_PURPOSES = new Set<DownloadCapabilityPurpose>([
  "display",
  "download",
  "docx",
]);

function publicVersion(version: DocumentVersionRow): PublicDocumentVersion {
  const {
    storageKey: _storageKey,
    previewStorageKey: _previewStorageKey,
    deletedAt: _deletedAt,
    ...value
  } = version;
  return value;
}

function originalLocator(documentId: string, versionId: string): WorkspaceBlobLocator {
  return { kind: "original", documentId, versionId };
}

function previewLocator(documentId: string, versionId: string): WorkspaceBlobLocator {
  return { kind: "preview", documentId, versionId };
}

export class WorkspaceDocumentCatalogService {
  constructor(
    private readonly repository: WorkspaceDocumentsRepository,
    private readonly documents: WorkspaceDocumentsService,
    private readonly blobs: BlobStore,
    private readonly capabilities: InMemoryDownloadCapabilityStore,
  ) {}

  list(options: DocumentCatalogListOptions = {}): Document[] {
    try {
      return this.repository.listDocuments(options);
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  get(documentId: string): DocumentDetail {
    try {
      const document = this.repository.getDocument(documentId);
      if (!document) throw new Error("Document was not found.");
      return { document, versions: this.repository.listVersions(documentId).map(publicVersion) };
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  listVersions(documentId: string): PublicDocumentVersion[] {
    try {
      if (!this.repository.getDocument(documentId)) throw new Error("Document was not found.");
      return this.repository.listVersions(documentId).map(publicVersion);
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  getVersion(documentId: string, versionId: string): PublicDocumentVersion {
    try {
      if (!this.repository.getDocument(documentId)) throw new Error("Document was not found.");
      const version = this.repository.getVersion(documentId, versionId);
      if (!version) throw new Error("Document version was not found.");
      return publicVersion(version);
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  rename(documentId: string, filename: string) {
    return this.documents.rename(documentId, filename);
  }

  renameTitle(documentId: string, title: string) {
    return this.documents.renameTitle(documentId, title);
  }

  move(documentId: string, projectId: string | null, folderId: string | null) {
    return this.documents.move(documentId, projectId, folderId);
  }

  attach(documentId: string, projectId: string, folderId: string | null = null) {
    return this.documents.attach(documentId, projectId, folderId);
  }

  detach(documentId: string) {
    return this.documents.detach(documentId);
  }

  uploadVersion(documentId: string, input: UploadDocumentInput): Promise<DocumentUploadResult> {
    return this.documents.uploadVersion(documentId, input);
  }

  retryParse(documentId: string, versionId?: string) {
    return this.documents.retryParse(documentId, versionId);
  }

  delete(documentId: string): DocumentDeleteResult {
    try {
      return this.documents.deleteDocument(documentId);
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  restore(documentId: string): never {
    return this.documents.restore(documentId);
  }

  deleteVersion(documentId: string, versionId: string): never {
    return this.documents.deleteVersion(documentId, versionId);
  }

  readOriginal(documentId: string, versionId: string): DocumentReadResult {
    try {
      const version = this.requireVersion(documentId, versionId);
      return this.readStored(version, originalLocator(documentId, versionId), "original", version.filename, version.mimeType);
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  readPreview(documentId: string, versionId: string): DocumentReadResult {
    try {
      const version = this.requireVersion(documentId, versionId);
      const record = this.repository.getBlobRecordsRepository()?.getByLocator(previewLocator(documentId, versionId));
      if (!record) throw new WorkspaceApiError(404, "NOT_FOUND", "Document preview was not found.");
      throw new WorkspaceApiError(409, "CONFLICT", "Document preview metadata is unavailable.");
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  issueCapability(
    documentId: string,
    versionId: string,
    purpose: DownloadCapabilityPurpose,
    ttlMs?: number,
  ): IssuedDownloadCapability {
    try {
      if (!PUBLIC_PURPOSES.has(purpose)) throw new Error("DOWNLOAD_PURPOSE_UNSUPPORTED");
      const version = this.requireVersion(documentId, versionId);
      if (purpose === "docx" && version.mimeType !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        throw new Error("DOCUMENT_DOCX_UNAVAILABLE");
      }
      this.requireStoredRecord(this.locatorForPurpose(documentId, versionId, purpose));
      return this.capabilities.issue({ documentId, versionId, purpose }, ttlMs);
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  resolveCapability(token: string, purpose?: DownloadCapabilityPurpose) {
    const resolved = this.capabilities.resolve(token);
    if (!resolved || (purpose !== undefined && resolved.purpose !== purpose)) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Download capability was not found or has expired.");
    }
    return resolved;
  }

  readCapability(token: string): DocumentReadResult {
    try {
      const binding = this.resolveCapability(token);
      const version = this.requireVersion(binding.documentId, binding.versionId);
      const locator = this.locatorForPurpose(binding.documentId, binding.versionId, binding.purpose);
      return this.readStored(version, locator, "original", version.filename, version.mimeType);
    } catch (error) {
      throw toDocumentApiError(error);
    }
  }

  private requireVersion(documentId: string, versionId: string): DocumentVersionRow {
    const document = this.repository.getDocument(documentId);
    const version = document ? this.repository.getVersion(documentId, versionId) : null;
    if (!document || !version) throw new WorkspaceApiError(404, "NOT_FOUND", "Document version was not found.");
    return version;
  }

  private locatorForPurpose(documentId: string, versionId: string, purpose: DownloadCapabilityPurpose): WorkspaceBlobLocator {
    if (purpose === "display") {
      // v2 blob records do not carry preview filename/MIME metadata. Display therefore
      // falls back to the authoritative original instead of inventing preview headers.
    }
    return originalLocator(documentId, versionId);
  }

  private requireStoredRecord(locator: WorkspaceBlobLocator): WorkspaceBlobRecord {
    const record = this.repository.getBlobRecordsRepository()?.getByLocator(locator);
    if (!record || record.state !== "stored") throw new WorkspaceApiError(404, "NOT_FOUND", "Document blob was not found.");
    return record;
  }

  private readStored(
    version: DocumentVersionRow,
    locator: WorkspaceBlobLocator,
    kind: DocumentReadKind,
    filename: string,
    mimeType: string,
  ): DocumentReadResult {
    const record = this.requireStoredRecord(locator);
    const buffer = this.blobs.readSync(locator, {
      sha256: record.contentSha256,
      size: record.sizeBytes,
    });
    const actualHash = createHash("sha256").update(buffer).digest("hex");
    if (buffer.length !== record.sizeBytes || actualHash !== record.contentSha256) {
      throw new Error("Document blob integrity check failed.");
    }
    return {
      documentId: version.documentId,
      versionId: version.id,
      kind,
      filename,
      mimeType,
      contentLength: buffer.length,
      sha256: record.contentSha256,
      buffer,
    };
  }
}
