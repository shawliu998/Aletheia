import { createHash, randomUUID } from "node:crypto";
import {
  MATTER_DOCUMENT_PDF_PAGE_SPANS_SCHEMA_VERSION,
  chunkMatterDocument,
  documentTypeForFilename,
  extractMatterDocument,
  nativeOcrConfigured,
  normalizeMatterDocumentText,
  type MatterDocumentChunkRegion,
  type ParsedDocumentChunk,
  type MatterDocumentExtraction,
  type MatterDocumentPdfPageSpan,
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
import {
  DOCUMENT_CHUNK_OCR_LOW_CONFIDENCE_THRESHOLD,
  DOCUMENT_CHUNK_OCR_METADATA_SCHEMA_VERSION,
  MAX_DOCUMENT_CHUNK_OCR_PAGE_OFFSET,
  parseDocumentChunkMetadata,
  type DocumentChunkMetadata,
  type DocumentChunkOcrMetadata,
} from "./documentChunkMetadata";

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

function originalLocator(
  documentId: string,
  versionId: string,
): WorkspaceBlobLocator {
  return { kind: "original", documentId, versionId };
}

function extractedLocator(
  documentId: string,
  versionId: string,
): { kind: "extracted_text"; documentId: string; versionId: string } {
  return { kind: "extracted_text", documentId, versionId };
}

function deterministicChunkId(
  versionId: string,
  ordinal: number,
  text: string,
) {
  const digest = createHash("sha256")
    .update(`${versionId}\0${ordinal}\0${text}`, "utf8")
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function extractWithConfiguredOcr(args: {
  filename: string;
  buffer: Buffer;
  signal?: AbortSignal;
}) {
  return extractMatterDocument(args);
}

export function extractionRequiresOcr(extraction: MatterDocumentExtraction) {
  return (
    (extraction.metadata.unresolvedPageCount ?? 0) > 0 ||
    (!extraction.text.trim() &&
      (extraction.metadata.textLayerPageCount === 0 ||
        extraction.metadata.textLayerPageCount === undefined) &&
      !extraction.metadata.ocrPageCount)
  );
}

type NormalizedBoundaryMap = Readonly<{
  text: string;
  sourceBoundaries: readonly number[];
}>;

type ValidatedOcrBlock = Readonly<{
  textStart: number;
  textEnd: number;
  confidence: number;
  boundingBox: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
}>;

type ValidatedOcrPage = Readonly<{
  page: number;
  confidence: number;
  blocks: readonly ValidatedOcrBlock[];
}>;

type NormalizedPdfPageSpan = Readonly<{
  page: number;
  rawContentStart: number;
  rawContentEnd: number;
  textStart: number;
  contentStart: number;
  contentEnd: number;
  textEnd: number;
}>;

function normalizeCrlfWithBoundaries(value: string): NormalizedBoundaryMap {
  const output: string[] = [];
  const sourceBoundaries = new Array<number>(value.length + 1);
  sourceBoundaries[0] = 0;
  let source = 0;
  let target = 0;
  while (source < value.length) {
    if (value[source] === "\r" && value[source + 1] === "\n") {
      output.push("\n");
      target += 1;
      sourceBoundaries[source + 1] = target;
      sourceBoundaries[source + 2] = target;
      source += 2;
      continue;
    }
    output.push(value[source]!);
    source += 1;
    target += 1;
    sourceBoundaries[source] = target;
  }
  return { text: output.join(""), sourceBoundaries };
}

function collapseNewlinesWithBoundaries(value: string): NormalizedBoundaryMap {
  const output: string[] = [];
  const sourceBoundaries = new Array<number>(value.length + 1);
  sourceBoundaries[0] = 0;
  let source = 0;
  let target = 0;
  while (source < value.length) {
    if (value[source] === "\n") {
      let end = source + 1;
      while (value[end] === "\n") end += 1;
      const count = end - source;
      const retained = Math.min(count, 2);
      output.push("\n".repeat(retained));
      for (let index = 1; index <= count; index += 1) {
        sourceBoundaries[source + index] = target + Math.min(index, 2);
      }
      target += retained;
      source = end;
      continue;
    }
    output.push(value[source]!);
    source += 1;
    target += 1;
    sourceBoundaries[source] = target;
  }
  return { text: output.join(""), sourceBoundaries };
}

function normalizedDocumentBoundaryMap(value: string): NormalizedBoundaryMap {
  const crlf = normalizeCrlfWithBoundaries(value);
  const collapsed = collapseNewlinesWithBoundaries(crlf.text);
  const text = collapsed.text.trim();
  if (!text) {
    return {
      text,
      sourceBoundaries: crlf.sourceBoundaries.map(() => 0),
    };
  }
  const leading = collapsed.text.length - collapsed.text.trimStart().length;
  const trailingBoundary = collapsed.text.trimEnd().length;
  const normalizeTrimBoundary = (boundary: number) =>
    Math.max(0, Math.min(boundary, trailingBoundary) - leading);
  const sourceBoundaries = crlf.sourceBoundaries.map((crlfBoundary) =>
    normalizeTrimBoundary(collapsed.sourceBoundaries[crlfBoundary]!),
  );
  if (text !== normalizeMatterDocumentText(value)) {
    throw new Error("Workspace document normalization is inconsistent.");
  }
  return { text, sourceBoundaries };
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function unitNumber(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return Number.isSafeInteger(value) &&
    Number(value) >= minimum &&
    Number(value) <= maximum
    ? Number(value)
    : null;
}

function isUtf16Boundary(value: string, offset: number) {
  if (offset <= 0 || offset >= value.length) return true;
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function validatedPdfPageSpans(
  extraction: MatterDocumentExtraction,
  normalized: NormalizedBoundaryMap,
): readonly NormalizedPdfPageSpan[] {
  const metadata = extraction.metadata as MatterDocumentExtraction["metadata"] &
    Record<string, unknown>;
  if (metadata.parser !== "pdf" && metadata.parser !== "pdf+apple-vision") {
    throw new Error("Workspace PDF page span metadata is invalid.");
  }
  const pageCount = boundedInteger(metadata.pageCount, 1, 500);
  const textLayerPageCount = boundedInteger(
    metadata.textLayerPageCount,
    0,
    500,
  );
  const ocrPageCount = boundedInteger(metadata.ocrPageCount, 0, 500);
  const rawSpans = metadata.pageSpans;
  if (
    pageCount === null ||
    textLayerPageCount === null ||
    ocrPageCount === null ||
    textLayerPageCount + ocrPageCount > pageCount ||
    metadata.pageSpanSchemaVersion !==
      MATTER_DOCUMENT_PDF_PAGE_SPANS_SCHEMA_VERSION ||
    !Array.isArray(rawSpans) ||
    rawSpans.length !== textLayerPageCount + ocrPageCount ||
    rawSpans.length > pageCount ||
    (metadata.parser === "pdf+apple-vision") !== ocrPageCount > 0
  ) {
    throw new Error("Workspace PDF page span metadata is invalid.");
  }
  if (rawSpans.length === 0) {
    if (extraction.text !== "" || normalized.text !== "") {
      throw new Error("Workspace PDF page span metadata is invalid.");
    }
    return [];
  }

  const spans: MatterDocumentPdfPageSpan[] = [];
  let previousPage = 0;
  for (const candidate of rawSpans) {
    const span = plainRecord(candidate);
    if (
      !span ||
      !exactKeys(span, [
        "page",
        "textStart",
        "contentStart",
        "contentEnd",
        "textEnd",
      ])
    ) {
      throw new Error("Workspace PDF page span metadata is invalid.");
    }
    const page = boundedInteger(span.page, 1, pageCount);
    const textStart = boundedInteger(span.textStart, 0, extraction.text.length);
    const contentStart = boundedInteger(
      span.contentStart,
      0,
      extraction.text.length,
    );
    const contentEnd = boundedInteger(
      span.contentEnd,
      0,
      extraction.text.length,
    );
    const textEnd = boundedInteger(span.textEnd, 0, extraction.text.length);
    if (
      page === null ||
      textStart === null ||
      contentStart === null ||
      contentEnd === null ||
      textEnd === null ||
      page <= previousPage ||
      textStart >= contentStart ||
      contentStart >= contentEnd ||
      contentEnd > textEnd ||
      !isUtf16Boundary(extraction.text, textStart) ||
      !isUtf16Boundary(extraction.text, contentStart) ||
      !isUtf16Boundary(extraction.text, contentEnd) ||
      !isUtf16Boundary(extraction.text, textEnd)
    ) {
      throw new Error("Workspace PDF page span metadata is invalid.");
    }
    const marker = `[Page ${page}]\n`;
    if (
      contentStart !== textStart + marker.length ||
      extraction.text.slice(textStart, contentStart) !== marker ||
      extraction.text.slice(contentStart, contentEnd).trim().length === 0
    ) {
      throw new Error("Workspace PDF page span metadata is invalid.");
    }
    spans.push({ page, textStart, contentStart, contentEnd, textEnd });
    previousPage = page;
  }

  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    const next = spans[index + 1];
    if (
      span.textStart !== (index === 0 ? 0 : spans[index - 1]!.textEnd) ||
      span.textEnd !== (next?.textStart ?? extraction.text.length) ||
      extraction.text.slice(span.contentEnd, span.textEnd) !==
        (next ? "\n\n" : "")
    ) {
      throw new Error("Workspace PDF page span metadata is invalid.");
    }
  }

  return spans.map((span) => {
    const textStart = normalized.sourceBoundaries[span.textStart];
    const contentStart = normalized.sourceBoundaries[span.contentStart];
    const contentEnd = normalized.sourceBoundaries[span.contentEnd];
    const textEnd = normalized.sourceBoundaries[span.textEnd];
    if (
      textStart === undefined ||
      contentStart === undefined ||
      contentEnd === undefined ||
      textEnd === undefined ||
      textStart >= contentStart ||
      contentStart >= contentEnd ||
      contentEnd > textEnd
    ) {
      throw new Error("Workspace PDF page span metadata is invalid.");
    }
    return {
      page: span.page,
      rawContentStart: span.contentStart,
      rawContentEnd: span.contentEnd,
      textStart,
      contentStart,
      contentEnd,
      textEnd,
    };
  });
}

function validatedOcrPages(
  extraction: MatterDocumentExtraction,
  pageSpans: readonly NormalizedPdfPageSpan[],
): ReadonlyMap<number, ValidatedOcrPage> {
  const metadata = extraction.metadata as MatterDocumentExtraction["metadata"] &
    Record<string, unknown>;
  const declaredOcrPageCount = boundedInteger(metadata.ocrPageCount, 0, 500);
  if (metadata.ocrPages === undefined) {
    if (declaredOcrPageCount === 0) return new Map();
    throw new Error("Workspace OCR extraction metadata is invalid.");
  }
  if (
    declaredOcrPageCount === null ||
    metadata.ocrEngine !== "apple-vision" ||
    (metadata.ocrCoordinateSpace !== undefined &&
      metadata.ocrCoordinateSpace !== "normalized-top-left") ||
    !Array.isArray(metadata.ocrPages) ||
    metadata.ocrPages.length !== declaredOcrPageCount ||
    metadata.ocrPages.length > 500
  ) {
    throw new Error("Workspace OCR extraction metadata is invalid.");
  }
  const coordinateSpace = metadata.ocrCoordinateSpace ?? null;
  const spanPages = new Set(pageSpans.map((span) => span.page));
  const pages = new Map<number, ValidatedOcrPage>();
  let previousOcrPage = 0;
  for (const candidate of metadata.ocrPages) {
    const page = plainRecord(candidate);
    if (
      !page ||
      !exactKeys(
        page,
        page.blocks === undefined
          ? ["page", "confidence"]
          : ["page", "confidence", "blocks"],
      ) ||
      !Number.isSafeInteger(page.page) ||
      Number(page.page) < 1 ||
      Number(page.page) > 500 ||
      pages.has(Number(page.page)) ||
      !spanPages.has(Number(page.page)) ||
      Number(page.page) <= previousOcrPage
    ) {
      throw new Error("Workspace OCR extraction metadata is invalid.");
    }
    const confidence = unitNumber(page.confidence);
    const rawBlocks = page.blocks ?? [];
    if (
      confidence === null ||
      !Array.isArray(rawBlocks) ||
      rawBlocks.length > 100_000 ||
      (coordinateSpace === null && rawBlocks.length > 0)
    ) {
      throw new Error("Workspace OCR extraction metadata is invalid.");
    }
    const blocks: ValidatedOcrBlock[] = [];
    for (const candidateBlock of rawBlocks) {
      const block = plainRecord(candidateBlock);
      const box = plainRecord(block?.boundingBox);
      const blockConfidence = unitNumber(block?.confidence);
      if (
        !block ||
        !exactKeys(block, [
          "textStart",
          "textEnd",
          "confidence",
          "boundingBox",
        ]) ||
        !box ||
        !exactKeys(box, ["x", "y", "width", "height"]) ||
        !Number.isSafeInteger(block.textStart) ||
        !Number.isSafeInteger(block.textEnd) ||
        Number(block.textStart) < 0 ||
        Number(block.textEnd) < Number(block.textStart) ||
        Number(block.textEnd) > MAX_DOCUMENT_CHUNK_OCR_PAGE_OFFSET ||
        blockConfidence === null
      ) {
        throw new Error("Workspace OCR extraction metadata is invalid.");
      }
      const x = unitNumber(box.x);
      const y = unitNumber(box.y);
      const width = unitNumber(box.width);
      const height = unitNumber(box.height);
      if (
        x === null ||
        y === null ||
        width === null ||
        height === null ||
        x + width > 1.000_001 ||
        y + height > 1.000_001 ||
        (blocks.length > 0 &&
          Number(block.textStart) < blocks[blocks.length - 1]!.textEnd)
      ) {
        throw new Error("Workspace OCR extraction metadata is invalid.");
      }
      blocks.push({
        textStart: Number(block.textStart),
        textEnd: Number(block.textEnd),
        confidence: blockConfidence,
        boundingBox: { x, y, width, height },
      });
    }
    pages.set(Number(page.page), {
      page: Number(page.page),
      confidence,
      blocks,
    });
    previousOcrPage = Number(page.page);
  }
  return pages;
}

function actualChunkTextRange(
  normalizedText: string,
  chunk: ParsedDocumentChunk,
): readonly [number, number] {
  const selected = normalizedText.slice(chunk.quoteStart, chunk.quoteEnd);
  if (selected.trim() !== chunk.text) {
    throw new Error("Workspace document chunk offsets are inconsistent.");
  }
  const leading = selected.length - selected.trimStart().length;
  const trailing = selected.length - selected.trimEnd().length;
  return [chunk.quoteStart + leading, chunk.quoteEnd - trailing];
}

function chunkMetadata(
  extraction: MatterDocumentExtraction,
  chunks: readonly ParsedDocumentChunk[],
  normalized: NormalizedBoundaryMap,
  pageSpans: readonly NormalizedPdfPageSpan[],
): readonly DocumentChunkMetadata[] {
  const pages = validatedOcrPages(extraction, pageSpans);
  if (pages.size === 0) return chunks.map(() => ({}));
  const spansByPage = new Map(pageSpans.map((span) => [span.page, span]));
  const layouts = new Map<
    number,
    Readonly<{
      page: ValidatedOcrPage;
      coordinateSpace: "normalized-top-left" | null;
      normalizedContentStart: number;
      blocks: readonly (ValidatedOcrBlock & {
        globalStart: number;
        globalEnd: number;
      })[];
    }>
  >();
  const coordinateSpace = extraction.metadata.ocrCoordinateSpace ?? null;
  for (const page of pages.values()) {
    const pageSpan = spansByPage.get(page.page);
    if (!pageSpan) {
      throw new Error("Workspace OCR extraction metadata is invalid.");
    }
    const rawContentStart = pageSpan.rawContentStart;
    const normalizedContentStart = pageSpan.contentStart;
    const blocks = page.blocks
      .map((block) => {
        const rawStart = rawContentStart + block.textStart;
        const rawEnd = rawContentStart + block.textEnd;
        if (rawEnd > pageSpan.rawContentEnd) {
          throw new Error("Workspace OCR extraction metadata is invalid.");
        }
        const globalStart = normalized.sourceBoundaries[rawStart];
        const globalEnd = normalized.sourceBoundaries[rawEnd];
        if (globalStart === undefined || globalEnd === undefined) {
          throw new Error("Workspace OCR extraction metadata is invalid.");
        }
        return {
          ...block,
          textStart: globalStart - normalizedContentStart,
          textEnd: globalEnd - normalizedContentStart,
          globalStart,
          globalEnd,
        };
      })
      .filter((block) => block.textEnd > block.textStart);
    layouts.set(page.page, {
      page,
      coordinateSpace,
      normalizedContentStart,
      blocks,
    });
  }
  const chunkPages = new Set(chunks.map((chunk) => chunk.page));
  for (const page of pages.keys()) {
    if (!chunkPages.has(page)) {
      throw new Error("Workspace OCR extraction metadata is invalid.");
    }
  }
  return chunks.map((chunk) => {
    if (chunk.page === null) return {};
    if (!pages.has(chunk.page)) return {};
    const layout = layouts.get(chunk.page);
    if (!layout) {
      throw new Error("Workspace OCR extraction metadata is invalid.");
    }
    const [chunkStart, chunkEnd] = actualChunkTextRange(normalized.text, chunk);
    const metadata: DocumentChunkOcrMetadata = {
      schemaVersion: DOCUMENT_CHUNK_OCR_METADATA_SCHEMA_VERSION,
      engine: "apple-vision",
      coordinateSpace: layout.coordinateSpace,
      page: layout.page.page,
      chunkPageTextStart: chunkStart - layout.normalizedContentStart,
      pageConfidence: layout.page.confidence,
      lowConfidence:
        layout.page.confidence < DOCUMENT_CHUNK_OCR_LOW_CONFIDENCE_THRESHOLD,
      blocks: layout.blocks
        .filter(
          (block) =>
            block.globalEnd > chunkStart && block.globalStart < chunkEnd,
        )
        .map((block) => ({
          textStart: block.textStart,
          textEnd: block.textEnd,
          confidence: block.confidence,
          boundingBox: block.boundingBox,
        })),
    };
    return parseDocumentChunkMetadata(metadata);
  });
}

export function documentExtractionChunks(
  versionId: string,
  extraction: MatterDocumentExtraction,
): ChunkWrite[] {
  const normalized = normalizedDocumentBoundaryMap(extraction.text);
  const isPdf =
    extraction.metadata.parser === "pdf" ||
    extraction.metadata.parser === "pdf+apple-vision";
  const pageSpans = isPdf ? validatedPdfPageSpans(extraction, normalized) : [];
  const structuredRegions: MatterDocumentChunkRegion[] = isPdf
    ? pageSpans.map((span) => ({
        start: span.textStart,
        end: span.textEnd,
        page: span.page,
      }))
    : normalized.text
      ? [{ start: 0, end: normalized.text.length, page: null }]
      : [];
  const parsed = chunkMatterDocument(normalized.text, structuredRegions);
  const metadata = isPdf
    ? chunkMetadata(extraction, parsed, normalized, pageSpans)
    : parsed.map(() => ({}));
  return parsed.map((chunk, index) => ({
    id: deterministicChunkId(versionId, chunk.chunkIndex, chunk.text),
    ordinal: chunk.chunkIndex,
    text: chunk.text,
    startOffset: chunk.quoteStart,
    endOffset: chunk.quoteEnd,
    pageStart: chunk.page,
    pageEnd: chunk.page,
    contentSha256: createHash("sha256")
      .update(chunk.text, "utf8")
      .digest("hex"),
    metadata: metadata[index],
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
    this.extractor = extractor ?? extractWithConfiguredOcr;
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
    if (
      typeof payload.versionId !== "string" ||
      payload.documentId !== context.job.resourceId
    ) {
      throw new Error(
        "Document parse job payload is not bound to its resource.",
      );
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
      {
        documentId: context.job.resourceId,
        versionId: payload.versionId,
        jobId: context.job.id,
      },
      { runtimeManaged: true, signal: context.signal, claim: context.claim },
    );
    if (outcome.status === "failed") {
      const error = new Error("Document parsing failed.") as Error & {
        code?: string;
        retryable?: boolean;
      };
      error.code = "document_parse_failed";
      error.retryable = true;
      throw error;
    }
    return outcome;
  }

  async process(
    job: ParseDocumentJobInput,
    options: {
      runtimeManaged?: boolean;
      signal?: AbortSignal;
      claim?: DocumentParseClaim;
    } = {},
  ): Promise<ParseDocumentOutcome> {
    const runtimeManaged = options.runtimeManaged === true;
    const claim = runtimeManaged ? options.claim : undefined;
    if (runtimeManaged && !claim) throw new DocumentParseClaimLostError();
    let stage = "load";
    const version = this.repository.getVersion(job.documentId, job.versionId);
    if (!version) throw new Error("Document version was not found.");
    if (!runtimeManaged)
      this.repository.markParseStarted(
        job.documentId,
        job.versionId,
        job.jobId,
      );
    try {
      if (options.signal?.aborted) throw new Error("Document parse aborted.");
      const type = documentTypeForFilename(version.filename);
      if (!SUPPORTED_DOCUMENT_TYPES.has(type)) {
        this.repository.commitTerminalParse(
          {
            documentId: job.documentId,
            versionId: job.versionId,
            jobId: job.jobId,
            status: "unsupported",
            result: { status: "unsupported", fileType: type },
          },
          { transitionJob: !runtimeManaged, claim },
        );
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
      const extraction = await this.extractor({
        filename: version.filename,
        buffer: original,
        signal: options.signal,
      });
      const pdfParser =
        extraction.metadata.parser === "pdf" ||
        extraction.metadata.parser === "pdf+apple-vision";
      if (type === "pdf" && !pdfParser) {
        throw new Error("Workspace PDF extraction parser is invalid.");
      }
      if (type === "pdf" && extractionRequiresOcr(extraction)) {
        await this.commitTerminalWithExtractedCompensation(
          job,
          "ocr_required",
          {
            status: "ocr_required",
            pageCount: extraction.metadata.pageCount ?? null,
            ocrEnabledByDefault: false,
            nativeOcrConfigured: nativeOcrConfigured(),
          },
          runtimeManaged,
          claim,
        );
        return {
          status: "ocr_required",
          documentId: job.documentId,
          versionId: job.versionId,
          chunkCount: 0,
          pageCount: extraction.metadata.pageCount ?? null,
        };
      }

      stage = "chunk";
      const chunks = documentExtractionChunks(job.versionId, extraction);
      stage = "persist_extracted";
      await this.writeExtractedAndCommit(
        job,
        extraction,
        chunks,
        runtimeManaged,
        claim,
      );
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
        this.repository.commitParseFailure(
          job.documentId,
          job.versionId,
          job.jobId,
          {
            code: conflict
              ? "document_extracted_blob_conflict"
              : "document_parse_failed",
            message: conflict
              ? "Extracted document content conflicts with existing authority."
              : "Document parsing failed.",
            retryable: !conflict,
            metadata: { stage },
          },
          { transitionJob: !runtimeManaged, claim },
        );
      } catch (commitError) {
        if (
          commitError instanceof DocumentParseClaimLostError ||
          runtimeManaged
        ) {
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
    const expectedSha256 = createHash("sha256")
      .update(extractedText)
      .digest("hex");
    const existing = this.repository
      .listDocumentBlobRecords(job.documentId)
      .filter(
        (candidate) =>
          candidate.locator.kind === "extracted_text" &&
          candidate.locator.versionId === job.versionId,
      );
    if (existing.length > 1) throw new DocumentExtractedBlobConflictError();
    const authoritative = existing[0] ?? null;
    if (authoritative) {
      if (authoritative.state !== "stored")
        throw new DocumentExtractedBlobConflictError();
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
      this.repository.commitParseReady(
        {
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
        },
        { transitionJob: !runtimeManaged, claim },
      );
      return;
    }

    let written = false;
    try {
      if (runtimeManaged) {
        if (!claim) throw new DocumentParseClaimLostError();
        this.repository.assertParseClaim(
          job.documentId,
          job.versionId,
          job.jobId,
          claim,
        );
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
        this.repository.assertParseClaim(
          job.documentId,
          job.versionId,
          job.jobId,
          claim,
        );
      }
      const stored = this.blobs.putSync(locator, extractedText);
      written = true;
      if (
        stored.sha256 !== expectedSha256 ||
        stored.size !== extractedText.byteLength
      ) {
        throw new Error(
          "Extracted blob storage integrity metadata is invalid.",
        );
      }
      this.repository.commitParseReady(
        {
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
        },
        { transitionJob: !runtimeManaged, claim },
      );
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
    this.repository.commitTerminalParse(
      {
        documentId: job.documentId,
        versionId: job.versionId,
        jobId: job.jobId,
        status,
        result,
      },
      { transitionJob: !runtimeManaged, claim },
    );
  }

  private removeWritten(
    locator: WorkspaceBlobLocator,
    job: ParseDocumentJobInput,
  ) {
    try {
      const receipt = this.blobs.stageDeleteSync(locator);
      this.blobs.finalizeDeleteSync(receipt);
    } catch {
      this.recordCleanup({
        operation: "compensation",
        code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
        documentId: job.documentId,
        versionId: job.versionId,
        locator,
        receipt: null,
      });
    }
  }

  private recordCleanup(
    input: Parameters<WorkspaceBlobCleanupRecorder["record"]>[0],
  ) {
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
