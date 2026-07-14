import { createHash, randomUUID } from "node:crypto";
import {
  chunkMatterDocument,
  documentTypeForFilename,
  extractMatterDocument,
  nativeOcrConfigured,
  type MatterDocumentExtraction,
} from "../aletheia/documentParser";
import type { BlobStore, WorkspaceBlobLocator } from "./blobStore";
import type {
  ChunkWrite,
  DocumentParseClaim,
  WorkspaceDocumentsRepository,
} from "./repositories/documents";
import { DocumentParseClaimLostError } from "./repositories/documents";
import {
  WorkspaceBlobCleanupPendingError,
  type WorkspaceBlobCleanupRecorder,
} from "./services/documents";

export type DocumentExtractor = (args: {
  filename: string;
  buffer: Buffer;
  signal?: AbortSignal;
}) => Promise<MatterDocumentExtraction>;

export type ParseDocumentJobInput = {
  documentId: string;
  versionId: string;
  jobId: string;
};

export type ParseDocumentOutcome = {
  status: "ready" | "unsupported" | "ocr_required" | "failed";
  documentId: string;
  versionId: string;
  chunkCount: number;
  pageCount: number | null;
};

export class DocumentExtractedBlobConflictError extends Error {
  readonly code = "DOCUMENT_EXTRACTED_BLOB_CONFLICT";
  readonly retryable = false;

  constructor() {
    super("DOCUMENT_EXTRACTED_BLOB_CONFLICT");
    this.name = "DocumentExtractedBlobConflictError";
  }
}

const SUPPORTED_DOCUMENT_TYPES = new Set(["pdf", "docx", "xlsx", "text"]);

function originalLocator(documentId: string, versionId: string): WorkspaceBlobLocator {
  return { kind: "original", documentId, versionId };
}

function extractedLocator(documentId: string, versionId: string): { kind: "extracted_text"; documentId: string; versionId: string } {
  return { kind: "extracted_text", documentId, versionId };
}

function deterministicChunkId(versionId: string, ordinal: number, text: string) {
  const digest = createHash("sha256")
    .update(`${versionId}\0${ordinal}\0${text}`, "utf8")
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function extractWithoutOcr(args: { filename: string; buffer: Buffer }) {
  return extractMatterDocument(args);
}

function scanPdfNeedsOcr(extraction: MatterDocumentExtraction) {
  return (
    !extraction.text.trim() &&
    (extraction.metadata.textLayerPageCount === 0 ||
      extraction.metadata.textLayerPageCount === undefined) &&
    !extraction.metadata.ocrPageCount
  );
}

function toChunks(versionId: string, extraction: MatterDocumentExtraction): ChunkWrite[] {
  return chunkMatterDocument(extraction.text).map((chunk) => ({
    id: deterministicChunkId(versionId, chunk.chunkIndex, chunk.text),
    ordinal: chunk.chunkIndex,
    text: chunk.text,
    startOffset: chunk.quoteStart,
    endOffset: chunk.quoteEnd,
    pageStart: chunk.page,
    pageEnd: chunk.page,
    contentSha256: createHash("sha256").update(chunk.text, "utf8").digest("hex"),
  }));
}

export class WorkspaceDocumentParser {
  private readonly extractor: DocumentExtractor;
  private readonly nextId: () => string;
  private readonly cleanupRecorder: WorkspaceBlobCleanupRecorder;

  constructor(
    private readonly repository: WorkspaceDocumentsRepository,
    private readonly blobs: BlobStore,
    extractor: DocumentExtractor | undefined,
    nextId: (() => string) | undefined,
    cleanupRecorder: WorkspaceBlobCleanupRecorder,
  ) {
    this.extractor = extractor ?? extractWithoutOcr;
    this.nextId = nextId ?? randomUUID;
    this.cleanupRecorder = cleanupRecorder;
  }

  async handleJob(context: {
    signal: AbortSignal;
    job: { id: string; resourceId: string; payload: unknown };
    claim?: DocumentParseClaim;
  }): Promise<ParseDocumentOutcome> {
    if (!context.job.payload || typeof context.job.payload !== "object") {
      throw new Error("Document parse job payload is invalid.");
    }
    const payload = context.job.payload as Record<string, unknown>;
    if (typeof payload.versionId !== "string" || payload.documentId !== context.job.resourceId) {
      throw new Error("Document parse job payload is not bound to its resource.");
    }
    if (!context.claim) throw new DocumentParseClaimLostError();
    this.repository.setParseStatusForClaim(
      context.job.resourceId,
      payload.versionId,
      context.job.id,
      "processing",
      context.claim,
    );
    const outcome = await this.process(
      { documentId: context.job.resourceId, versionId: payload.versionId, jobId: context.job.id },
      { runtimeManaged: true, signal: context.signal, claim: context.claim },
    );
    if (outcome.status === "failed") {
      const error = new Error("Document parsing failed.") as Error & { code?: string; retryable?: boolean };
      error.code = "document_parse_failed";
      error.retryable = true;
      throw error;
    }
    return outcome;
  }

  async process(
    job: ParseDocumentJobInput,
    options: { runtimeManaged?: boolean; signal?: AbortSignal; claim?: DocumentParseClaim } = {},
  ): Promise<ParseDocumentOutcome> {
    const runtimeManaged = options.runtimeManaged === true;
    const claim = runtimeManaged ? options.claim : undefined;
    if (runtimeManaged && !claim) throw new DocumentParseClaimLostError();
    let stage = "load";
    const version = this.repository.getVersion(job.documentId, job.versionId);
    if (!version) throw new Error("Document version was not found.");
    if (!runtimeManaged) this.repository.markParseStarted(job.documentId, job.versionId, job.jobId);
    try {
      if (options.signal?.aborted) throw new Error("Document parse aborted.");
      const type = documentTypeForFilename(version.filename);
      if (!SUPPORTED_DOCUMENT_TYPES.has(type)) {
        this.repository.commitTerminalParse({
          documentId: job.documentId,
          versionId: job.versionId,
          jobId: job.jobId,
          status: "unsupported",
          result: { status: "unsupported", fileType: type },
        }, { transitionJob: !runtimeManaged, claim });
        return {
          status: "unsupported",
          documentId: job.documentId,
          versionId: job.versionId,
          chunkCount: 0,
          pageCount: null,
        };
      }

      stage = "read_original";
      const original = this.blobs.readSync(
        originalLocator(job.documentId, job.versionId),
        { sha256: version.contentSha256, size: version.sizeBytes },
      );
      stage = "extract";
      const extraction = await this.extractor({ filename: version.filename, buffer: original, signal: options.signal });
      if (type === "pdf" && scanPdfNeedsOcr(extraction)) {
        await this.commitTerminalWithExtractedCompensation(job, "ocr_required", {
          status: "ocr_required",
          pageCount: extraction.metadata.pageCount ?? null,
          ocrEnabledByDefault: false,
          nativeOcrConfigured: nativeOcrConfigured(),
        }, runtimeManaged, claim);
        return {
          status: "ocr_required",
          documentId: job.documentId,
          versionId: job.versionId,
          chunkCount: 0,
          pageCount: extraction.metadata.pageCount ?? null,
        };
      }

      stage = "persist_extracted";
      const chunks = toChunks(job.versionId, extraction);
      await this.writeExtractedAndCommit(job, extraction, chunks, runtimeManaged, claim);
      return {
        status: "ready",
        documentId: job.documentId,
        versionId: job.versionId,
        chunkCount: chunks.length,
        pageCount: extraction.metadata.pageCount ?? null,
      };
    } catch (error) {
      if (runtimeManaged && options.signal?.aborted) throw error;
      if (error instanceof DocumentParseClaimLostError) throw error;
      if (error instanceof WorkspaceBlobCleanupPendingError) throw error;
      const conflict = error instanceof DocumentExtractedBlobConflictError;
      try {
        this.repository.commitParseFailure(job.documentId, job.versionId, job.jobId, {
          code: conflict ? "document_extracted_blob_conflict" : "document_parse_failed",
          message: conflict ? "Extracted document content conflicts with existing authority." : "Document parsing failed.",
          retryable: !conflict,
          metadata: { stage },
        }, { transitionJob: !runtimeManaged, claim });
      } catch (commitError) {
        if (commitError instanceof DocumentParseClaimLostError || runtimeManaged) {
          throw commitError;
        }
      }
      if (runtimeManaged && conflict) throw error;
      return {
        status: "failed",
        documentId: job.documentId,
        versionId: job.versionId,
        chunkCount: 0,
        pageCount: null,
      };
    }
  }

  private async writeExtractedAndCommit(
    job: ParseDocumentJobInput,
    extraction: MatterDocumentExtraction,
    chunks: readonly ChunkWrite[],
    runtimeManaged: boolean,
    claim: DocumentParseClaim | undefined,
  ) {
    const locator = extractedLocator(job.documentId, job.versionId);
    const extractedText = Buffer.from(extraction.text, "utf8");
    const expectedSha256 = createHash("sha256").update(extractedText).digest("hex");
    const existing = this.repository
      .listDocumentBlobRecords(job.documentId)
      .filter((candidate) =>
        candidate.locator.kind === "extracted_text" &&
        candidate.locator.versionId === job.versionId
      );
    if (existing.length > 1) throw new DocumentExtractedBlobConflictError();
    const authoritative = existing[0] ?? null;
    if (authoritative) {
      if (authoritative.state !== "stored") throw new DocumentExtractedBlobConflictError();
      this.blobs.readSync(authoritative.locator, {
        sha256: authoritative.contentSha256,
        size: authoritative.sizeBytes,
      });
      if (
        authoritative.contentSha256 !== expectedSha256 ||
        authoritative.sizeBytes !== extractedText.byteLength
      ) {
        throw new DocumentExtractedBlobConflictError();
      }
      this.repository.commitParseReady({
        documentId: job.documentId,
        versionId: job.versionId,
        jobId: job.jobId,
        chunks,
        pageCount: extraction.metadata.pageCount ?? null,
        result: {
          status: "ready",
          parser: extraction.metadata.parser,
          chunkCount: chunks.length,
          reusedExtractedAuthority: true,
        },
        extractedBlob: {
          recordId: authoritative.id,
          storageKey: authoritative.storageKey,
          sha256: authoritative.contentSha256,
          size: authoritative.sizeBytes,
          storedSize: authoritative.storedSizeBytes,
          locator: authoritative.locator,
        },
        reuseExistingExtractedRecord: true,
      }, { transitionJob: !runtimeManaged, claim });
      return;
    }

    let written = false;
    try {
      if (runtimeManaged) {
        if (!claim) throw new DocumentParseClaimLostError();
        this.repository.assertParseClaim(job.documentId, job.versionId, job.jobId, claim);
      }
      this.recordCleanup({
        operation: "compensation",
        code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
        documentId: job.documentId,
        versionId: job.versionId,
        locator,
        receipt: null,
      });
      if (runtimeManaged) {
        if (!claim) throw new DocumentParseClaimLostError();
        this.repository.assertParseClaim(job.documentId, job.versionId, job.jobId, claim);
      }
      const stored = this.blobs.putSync(locator, extractedText);
      written = true;
      if (stored.sha256 !== expectedSha256 || stored.size !== extractedText.byteLength) {
        throw new Error("Extracted blob storage integrity metadata is invalid.");
      }
      this.repository.commitParseReady({
        documentId: job.documentId,
        versionId: job.versionId,
        jobId: job.jobId,
        chunks,
        pageCount: extraction.metadata.pageCount ?? null,
        result: {
          status: "ready",
          parser: extraction.metadata.parser,
          chunkCount: chunks.length,
        },
        extractedBlob: {
          recordId: this.nextId(),
          storageKey: `documents/${job.documentId}/versions/${job.versionId}/extracted`,
          sha256: stored.sha256,
          size: stored.size,
          storedSize: stored.storedSize,
          locator,
        },
      }, { transitionJob: !runtimeManaged, claim });
    } catch (error) {
      if (written) this.removeWritten(locator, job);
      throw error;
    }
  }

  private async commitTerminalWithExtractedCompensation(
    job: ParseDocumentJobInput,
    status: "unsupported" | "ocr_required",
    result: Record<string, unknown>,
    runtimeManaged: boolean,
    claim: DocumentParseClaim | undefined,
  ) {
    this.repository.commitTerminalParse({
      documentId: job.documentId,
      versionId: job.versionId,
      jobId: job.jobId,
      status,
      result,
    }, { transitionJob: !runtimeManaged, claim });
  }

  private removeWritten(locator: WorkspaceBlobLocator, job: ParseDocumentJobInput) {
    try {
      const receipt = this.blobs.stageDeleteSync(locator);
      this.blobs.finalizeDeleteSync(receipt);
    } catch {
      this.recordCleanup({ operation: "compensation", code: "DOCUMENT_BLOB_COMPENSATION_FAILED", documentId: job.documentId, versionId: job.versionId, locator, receipt: null });
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

export function defaultDocumentExtractorUsesNoOcr() {
  return process.env.ALETHEIA_OCR_ENABLED !== "true";
}
