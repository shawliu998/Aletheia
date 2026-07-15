import type {
  StudioDocumentV12,
  StudioDocumentVersionV12,
  StudioVersionCommitV12,
} from "../documentStudioContractsV12";
import { workspaceBlobStorageKey } from "../repositories/blobRecords";
import {
  WorkspaceDocumentStudioRepositoryError,
  type WorkspaceDocumentStudioRepository,
} from "../repositories/documentStudio";
import type { WorkspaceSourceFoundationRepository } from "../repositories/sourceFoundation";
import type { Document, DocumentVersion } from "../types";
import type {
  DocumentStudioCitationAnchor,
  DocumentStudioCommitPersistenceInput,
  DocumentStudioCreatePersistenceInput,
  DocumentStudioPersistenceResult,
  DocumentStudioRestorePersistenceInput,
  WorkspaceDocumentStudioRepositoryPort,
} from "./documentStudio";

function invalid(message: string): never {
  throw new WorkspaceDocumentStudioRepositoryError(
    "DOCUMENT_STUDIO_INVALID_INPUT",
    message,
  );
}

function persistenceFailed(message: string): never {
  throw new WorkspaceDocumentStudioRepositoryError(
    "DOCUMENT_STUDIO_PERSISTENCE_FAILED",
    message,
  );
}

function mapDocument(value: StudioDocumentV12): Document {
  return {
    id: value.id,
    projectId: value.projectId,
    folderId: value.folderId,
    title: value.title,
    filename: value.filename,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    status: value.parseStatus,
    currentVersionId: value.currentVersionId,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function mapVersion(value: StudioDocumentVersionV12): DocumentVersion {
  return {
    id: value.id,
    documentId: value.documentId,
    versionNumber: value.versionNumber,
    source: value.source,
    filename: value.filename,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    contentSha256: value.contentSha256,
    pageCount: value.pageCount,
    createdAt: value.createdAt,
  };
}

function mapCommit(
  value: StudioVersionCommitV12,
): DocumentStudioPersistenceResult {
  return {
    document: mapDocument(value.document),
    version: mapVersion(value.version),
    job: { id: value.jobId },
  };
}

function assertPreparedBlob(
  input: Pick<
    DocumentStudioCommitPersistenceInput,
    | "documentId"
    | "versionId"
    | "mimeType"
    | "sizeBytes"
    | "contentSha256"
    | "storageKey"
    | "blobRecord"
  >,
) {
  const locator = {
    kind: "original" as const,
    documentId: input.documentId,
    versionId: input.versionId,
  };
  const expectedStorageKey = workspaceBlobStorageKey(locator);
  if (
    input.mimeType !== "text/markdown" ||
    input.storageKey !== expectedStorageKey ||
    input.blobRecord.locator.kind !== "original" ||
    input.blobRecord.locator.documentId !== input.documentId ||
    input.blobRecord.locator.versionId !== input.versionId ||
    input.blobRecord.contentSha256 !== input.contentSha256 ||
    input.blobRecord.sizeBytes !== input.sizeBytes
  ) {
    invalid("Prepared Studio blob metadata is inconsistent.");
  }
}

/**
 * Adapts the v12 repository projection to the service's narrow persistence
 * port. No SQL crosses this boundary; full citation anchors are resolved only
 * through the immutable v11 source repository.
 */
export class WorkspaceDocumentStudioRepositoryAdapter implements WorkspaceDocumentStudioRepositoryPort {
  constructor(
    private readonly studio: WorkspaceDocumentStudioRepository,
    private readonly sources: Pick<
      WorkspaceSourceFoundationRepository,
      "getCitationAnchor"
    >,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getProjectDocument(projectId: string, documentId: string): Document | null {
    const result = this.studio.getProjectDocument(projectId, documentId);
    return result ? mapDocument(result.document) : null;
  }

  getVersion(
    projectId: string,
    documentId: string,
    versionId: string,
  ): DocumentVersion | null {
    const result = this.studio.getVersion(projectId, documentId, versionId);
    return result ? mapVersion(result) : null;
  }

  listVersions(projectId: string, documentId: string): DocumentVersion[] {
    return this.studio
      .listVersions(projectId, documentId)
      .map((version) => mapVersion(version));
  }

  createMarkdownDraft(
    input: DocumentStudioCreatePersistenceInput,
  ): DocumentStudioPersistenceResult {
    assertPreparedBlob(input);
    if (input.source !== "user_upload") {
      invalid("A Studio draft must start with a user_upload version.");
    }
    return mapCommit(
      this.studio.createMarkdownDraft({
        projectId: input.projectId,
        documentId: input.documentId,
        versionId: input.versionId,
        jobId: input.jobId,
        folderId: input.folderId,
        documentKind: "draft",
        title: input.title,
        filename: input.filename,
        summary: null,
        operationId: null,
        citationAnchorIds: [],
        createdAt: this.now(),
        blobRecordId: input.blobRecord.id,
        contentSha256: input.contentSha256,
        sizeBytes: input.sizeBytes,
        storedSizeBytes: input.blobRecord.storedSizeBytes,
      }),
    );
  }

  commitMarkdownVersionCas(
    input: DocumentStudioCommitPersistenceInput,
  ): DocumentStudioPersistenceResult {
    assertPreparedBlob(input);
    return mapCommit(
      this.studio.commitMarkdownVersionCas({
        projectId: input.projectId,
        documentId: input.documentId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        versionId: input.versionId,
        jobId: input.jobId,
        source: input.source,
        filename: input.filename,
        summary: input.summary,
        operationId: null,
        citationAnchorIds: input.citationAnchorIds,
        createdAt: this.now(),
        blobRecordId: input.blobRecord.id,
        contentSha256: input.contentSha256,
        sizeBytes: input.sizeBytes,
        storedSizeBytes: input.blobRecord.storedSizeBytes,
      }),
    );
  }

  restoreVersionCas(
    input: DocumentStudioRestorePersistenceInput,
  ): DocumentStudioPersistenceResult {
    assertPreparedBlob(input);
    const target = this.studio.getVersion(
      input.projectId,
      input.documentId,
      input.targetVersionId,
    );
    if (!target) {
      throw new WorkspaceDocumentStudioRepositoryError(
        "DOCUMENT_STUDIO_NOT_FOUND",
        "The Studio version selected for restore was not found.",
      );
    }
    if (
      target.contentSha256 !== input.contentSha256 ||
      target.sizeBytes !== input.sizeBytes
    ) {
      persistenceFailed(
        "Prepared restore bytes do not match the immutable target version.",
      );
    }
    const inheritedCitationIds = target.citationAnchorIds;
    if (
      inheritedCitationIds.length !== input.citationAnchorIds.length ||
      inheritedCitationIds.some(
        (anchorId, index) => anchorId !== input.citationAnchorIds[index],
      )
    ) {
      persistenceFailed(
        "Prepared restore citations do not match the immutable target version.",
      );
    }
    return mapCommit(
      this.studio.restoreVersionCas({
        projectId: input.projectId,
        documentId: input.documentId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        restoreFromVersionId: input.targetVersionId,
        versionId: input.versionId,
        jobId: input.jobId,
        blobRecordId: input.blobRecord.id,
        contentSha256: input.contentSha256,
        sizeBytes: input.sizeBytes,
        storedSizeBytes: input.blobRecord.storedSizeBytes,
        summary: null,
        operationId: null,
        createdAt: this.now(),
      }),
    );
  }

  listVersionCitationAnchors(
    projectId: string,
    documentId: string,
    versionId: string,
  ): DocumentStudioCitationAnchor[] {
    return this.studio
      .listVersionCitationAnchors(projectId, documentId, versionId)
      .map((binding) => {
        const anchor = this.sources.getCitationAnchor(
          projectId,
          binding.anchorId,
        );
        if (!anchor) {
          persistenceFailed(
            "A persisted Studio citation binding has no source anchor.",
          );
        }
        return {
          id: anchor.id,
          projectId: anchor.projectId,
          snapshotId: anchor.snapshotId,
          ordinal: binding.ordinal,
          exactQuote: anchor.exactQuote,
          quoteSha256: anchor.quoteSha256,
          locator: anchor.locator,
          createdAt: binding.createdAt,
        };
      });
  }
}
