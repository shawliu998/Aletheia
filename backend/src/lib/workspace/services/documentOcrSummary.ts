import {
  assertDocumentChunkMetadataPageBinding,
  parseDocumentChunkMetadataJson,
} from "../documentChunkMetadata";
import type { WorkspaceDatabaseAdapter } from "../migrations/types";
import type { Document } from "../types";

export const MAX_PUBLIC_OCR_LOW_CONFIDENCE_PAGES = 50;

export type WorkspaceDocumentOcrSummary = Readonly<{
  engine: "apple-vision";
  ocrPageCount: number;
  lowConfidencePages: readonly number[];
  lowConfidencePageCount: number;
  lowConfidencePagesTruncated: boolean;
  reviewRequired: boolean;
}>;

export type WorkspaceDocumentOcrSummaryWire = Readonly<{
  engine: "apple-vision";
  ocr_page_count: number;
  low_confidence_pages: readonly number[];
  low_confidence_page_count: number;
  low_confidence_pages_truncated: boolean;
  review_required: boolean;
}>;

export function serializeWorkspaceDocumentOcrSummary(
  summary: WorkspaceDocumentOcrSummary | null,
): WorkspaceDocumentOcrSummaryWire | null {
  if (!summary) return null;
  return {
    engine: summary.engine,
    ocr_page_count: summary.ocrPageCount,
    low_confidence_pages: summary.lowConfidencePages,
    low_confidence_page_count: summary.lowConfidencePageCount,
    low_confidence_pages_truncated: summary.lowConfidencePagesTruncated,
    review_required: summary.reviewRequired,
  };
}

type ChunkMetadataRow = {
  text: unknown;
  page_start: unknown;
  page_end: unknown;
  metadata_json: unknown;
};

type OcrPage = {
  engine: WorkspaceDocumentOcrSummary["engine"];
  confidence: number;
  lowConfidence: boolean;
};

function invalidPersistedMetadata(): never {
  throw new Error("Workspace document OCR metadata is invalid.");
}

function nullablePage(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    return invalidPersistedMetadata();
  }
  return Number(value);
}

/**
 * Produces a bounded, transport-safe review signal for the document's current
 * version. OCR block geometry and extracted text never leave this service.
 */
export class WorkspaceDocumentOcrSummaryService {
  constructor(private readonly database: WorkspaceDatabaseAdapter) {}

  summarize(
    document: Pick<Document, "id" | "currentVersionId">,
  ): WorkspaceDocumentOcrSummary | null {
    if (document.currentVersionId === null) return null;

    const rows = this.database
      .prepare(
        `SELECT text, page_start, page_end, metadata_json
           FROM document_chunks
          WHERE document_id = ? AND version_id = ?
          ORDER BY ordinal ASC`,
      )
      .all(document.id, document.currentVersionId) as ChunkMetadataRow[];
    const pages = new Map<number, OcrPage>();

    for (const row of rows) {
      const metadata = parseDocumentChunkMetadataJson(row.metadata_json);
      if (!("schemaVersion" in metadata)) continue;

      const text =
        typeof row.text === "string" ? row.text : invalidPersistedMetadata();
      const pageStart = nullablePage(row.page_start);
      const pageEnd = nullablePage(row.page_end);
      assertDocumentChunkMetadataPageBinding(
        metadata,
        pageStart,
        pageEnd,
        text,
      );

      const existing = pages.get(metadata.page);
      if (existing) {
        if (
          existing.engine !== metadata.engine ||
          existing.confidence !== metadata.pageConfidence ||
          existing.lowConfidence !== metadata.lowConfidence
        ) {
          invalidPersistedMetadata();
        }
        continue;
      }
      pages.set(metadata.page, {
        engine: metadata.engine,
        confidence: metadata.pageConfidence,
        lowConfidence: metadata.lowConfidence,
      });
    }

    if (pages.size === 0) return null;
    const orderedPages = [...pages.entries()].sort(
      ([left], [right]) => left - right,
    );
    const engine = orderedPages[0]![1].engine;
    if (orderedPages.some(([, page]) => page.engine !== engine)) {
      invalidPersistedMetadata();
    }
    const allLowConfidencePages = orderedPages
      .filter(([, page]) => page.lowConfidence)
      .map(([page]) => page);
    const lowConfidencePages = allLowConfidencePages.slice(
      0,
      MAX_PUBLIC_OCR_LOW_CONFIDENCE_PAGES,
    );

    return {
      engine,
      ocrPageCount: orderedPages.length,
      lowConfidencePages,
      lowConfidencePageCount: allLowConfidencePages.length,
      lowConfidencePagesTruncated:
        allLowConfidencePages.length > lowConfidencePages.length,
      reviewRequired: allLowConfidencePages.length > 0,
    };
  }
}
