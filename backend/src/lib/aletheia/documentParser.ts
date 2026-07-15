import path from "node:path";
import { pathToFileURL } from "node:url";
import { normalizeDocxZipPaths } from "../convert";
import { configuredAppleVisionOcrProvider } from "./appleVisionOcrProvider";
import type {
  OcrBoundingBox,
  OcrCoordinateSpace,
  OcrProvider,
  OcrRecognitionResult,
} from "./ocrProvider";
import {
  readProtectedLocalFileSync,
  writeProtectedLocalFileSync,
} from "./localEnvelopeCrypto";

export type ParsedDocumentChunk = {
  chunkIndex: number;
  page: number | null;
  section: string | null;
  text: string;
  quoteStart: number;
  quoteEnd: number;
};

export type ParsedMatterDocument = {
  text: string;
  chunks: ParsedDocumentChunk[];
};

export const MATTER_DOCUMENT_PDF_PAGE_SPANS_SCHEMA_VERSION =
  "vera-pdf-page-spans-v1" as const;

/**
 * UTF-16 offsets into the exact, un-normalized extraction text. `textStart`
 * includes Vera's structural page label, while the content range contains
 * only text returned by the PDF text layer or OCR provider.
 */
export type MatterDocumentPdfPageSpan = Readonly<{
  page: number;
  textStart: number;
  contentStart: number;
  contentEnd: number;
  textEnd: number;
}>;

export type MatterDocumentChunkRegion = Readonly<{
  start: number;
  end: number;
  page: number | null;
}>;

export type MatterDocumentExtraction = {
  text: string;
  metadata: {
    parser: "pdf" | "pdf+apple-vision" | "docx" | "xlsx" | "deterministic";
    pageCount?: number;
    pageSpanSchemaVersion?: typeof MATTER_DOCUMENT_PDF_PAGE_SPANS_SCHEMA_VERSION;
    pageSpans?: MatterDocumentPdfPageSpan[];
    textLayerPageCount?: number;
    ocrPageCount?: number;
    ocrAttemptedPageCount?: number;
    ocrAttemptedPages?: number[];
    ocrEngine?: string;
    ocrCoordinateSpace?: OcrCoordinateSpace;
    averageOcrConfidence?: number;
    ocrPages?: Array<{
      page: number;
      confidence: number;
      blocks?: Array<{
        textStart: number;
        textEnd: number;
        confidence: number;
        boundingBox: OcrBoundingBox;
      }>;
    }>;
    ocrEmptyPageCount?: number;
    ocrEmptyPages?: number[];
    lowConfidenceOcrPageCount?: number;
    lowConfidenceOcrPages?: Array<{ page: number; confidence: number }>;
    unresolvedPageCount?: number;
    unresolvedPages?: number[];
    sheetCount?: number;
    sectionCount?: number;
  };
};

const MAX_CHUNK_LENGTH = 1200;
const CHUNK_OVERLAP = 160;
const OCR_REVIEW_CONFIDENCE_THRESHOLD = 0.5;

function extension(filename: string) {
  return path.extname(filename).replace(".", "").toLowerCase();
}

export function documentTypeForFilename(filename: string) {
  const ext = extension(filename);
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "doc") return "doc";
  if (ext === "xlsx") return "xlsx";
  if (ext === "txt" || ext === "md") return "text";
  return "other";
}

export function sensitiveMaterialFlagsForText(args: {
  filename?: string;
  text?: string;
}) {
  const value = `${args.filename ?? ""}\n${args.text ?? ""}`.toLowerCase();
  const flags: string[] = [];
  const checks: Array<[string, RegExp]> = [
    ["privileged", /\b(privileged|attorney[- ]client|legal advice)\b/],
    ["confidential", /\b(confidential|non[- ]disclosure|nda|trade secret)\b/],
    [
      "personal_data",
      /\b(ssn|passport|date of birth|personal data|personally identifiable|pii)\b/,
    ],
    [
      "financial",
      /\b(bank account|wire transfer|tax return|payroll|financial statement)\b/,
    ],
    ["health", /\b(health record|medical|hipaa|diagnosis|patient)\b/],
    ["minor", /\b(minor child|under 18|juvenile)\b/],
  ];

  for (const [flag, pattern] of checks) {
    if (pattern.test(value)) flags.push(flag);
  }
  return flags;
}

export async function extractMatterDocumentText(args: {
  filename: string;
  buffer: Buffer;
  signal?: AbortSignal;
  ocrProvider?: OcrProvider | null;
}) {
  return (await extractMatterDocument(args)).text;
}

export async function extractMatterDocument(args: {
  filename: string;
  buffer: Buffer;
  signal?: AbortSignal;
  /** `null` explicitly disables OCR; `undefined` uses the local configuration. */
  ocrProvider?: OcrProvider | null;
}): Promise<MatterDocumentExtraction> {
  assertNotAborted(args.signal);
  const ext = extension(args.filename);
  if (ext === "pdf") {
    return extractPdfDocument(args.buffer, {
      signal: args.signal,
      ocrProvider:
        args.ocrProvider === undefined
          ? configuredAppleVisionOcrProvider()
          : args.ocrProvider,
    });
  }
  if (ext === "docx" || ext === "doc") {
    return {
      text: await extractDocxText(args.buffer),
      metadata: { parser: "docx" },
    };
  }
  if (ext === "xlsx") return extractXlsxDocument(args.buffer);
  if (ext === "txt" || ext === "md") {
    return {
      text: args.buffer.toString("utf8"),
      metadata: { parser: "deterministic" },
    };
  }
  return {
    text: args.buffer.toString("utf8"),
    metadata: { parser: "deterministic" },
  };
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new Error("Document extraction was cancelled.");
}

async function extractPdfDocument(
  buffer: Buffer,
  options: {
    signal?: AbortSignal;
    ocrProvider: OcrProvider | null;
  },
): Promise<MatterDocumentExtraction> {
  assertNotAborted(options.signal);
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
  const pdfjsRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const workerOptions = (
    pdfjsLib as unknown as { GlobalWorkerOptions?: { workerSrc: string } }
  ).GlobalWorkerOptions;
  if (workerOptions && !workerOptions.workerSrc) {
    workerOptions.workerSrc = pathToFileURL(
      require.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
    ).href;
  }
  const pdf = await (
    pdfjsLib as unknown as {
      getDocument: (opts: unknown) => {
        promise: Promise<{
          numPages: number;
          getPage: (n: number) => Promise<{
            getTextContent: () => Promise<{
              items: { str?: string }[];
            }>;
          }>;
        }>;
      };
    }
  ).getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: path.join(pdfjsRoot, "standard_fonts") + path.sep,
  }).promise;
  const pages = new Map<number, string>();
  const missingPages: number[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    assertNotAborted(options.signal);
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => item.str ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) pages.set(i, text);
    else missingPages.push(i);
  }
  let recognition: OcrRecognitionResult | null = null;
  let ocrPages: OcrRecognitionResult["pages"] = [];
  if (missingPages.length > 0 && options.ocrProvider?.isAvailable() === true) {
    recognition = await options.ocrProvider.recognizePdf({
      pdf: buffer,
      pageCount: pdf.numPages,
      pages: missingPages,
      signal: options.signal,
    });
    ocrPages = recognition.pages;
    for (const item of ocrPages) {
      if (missingPages.includes(item.page) && item.text.trim()) {
        pages.set(item.page, item.text);
      }
    }
  }
  const serializedPages = serializePdfPages(pages);
  const usedOcr = ocrPages.filter(
    (item) => missingPages.includes(item.page) && item.text.trim(),
  );
  const returnedOcrPages = new Set(
    ocrPages
      .filter((item) => missingPages.includes(item.page))
      .map((item) => item.page),
  );
  const unresolvedPages = missingPages.filter(
    (page) => !returnedOcrPages.has(page),
  );
  const emptyOcrPages = ocrPages
    .filter((item) => missingPages.includes(item.page) && !item.text.trim())
    .map((item) => item.page);
  const lowConfidenceOcrPages = ocrPages
    .filter(
      (item) =>
        missingPages.includes(item.page) &&
        item.confidence < OCR_REVIEW_CONFIDENCE_THRESHOLD,
    )
    .map((item) => ({ page: item.page, confidence: item.confidence }));
  return {
    text: serializedPages.text,
    metadata: {
      parser: usedOcr.length > 0 ? "pdf+apple-vision" : "pdf",
      pageCount: pdf.numPages,
      pageSpanSchemaVersion: MATTER_DOCUMENT_PDF_PAGE_SPANS_SCHEMA_VERSION,
      pageSpans: serializedPages.pageSpans,
      textLayerPageCount: pdf.numPages - missingPages.length,
      ocrPageCount: usedOcr.length,
      ocrAttemptedPageCount: recognition ? missingPages.length : 0,
      ocrAttemptedPages: recognition ? missingPages : [],
      ocrEmptyPageCount: emptyOcrPages.length,
      ocrEmptyPages: emptyOcrPages,
      lowConfidenceOcrPageCount: lowConfidenceOcrPages.length,
      lowConfidenceOcrPages,
      unresolvedPageCount: unresolvedPages.length,
      unresolvedPages,
      ...(recognition
        ? {
            ocrEngine: recognition.engine,
            ...(recognition.coordinateSpace
              ? { ocrCoordinateSpace: recognition.coordinateSpace }
              : {}),
            ...(ocrPages.length > 0
              ? {
                  averageOcrConfidence:
                    ocrPages.reduce((sum, item) => sum + item.confidence, 0) /
                    ocrPages.length,
                }
              : {}),
            ...(usedOcr.length > 0
              ? {
                  ocrPages: usedOcr.map((item) => {
                    let textOffset = 0;
                    const blocks = item.blocks.map((block) => {
                      const textStart = textOffset;
                      const textEnd = textStart + block.text.length;
                      textOffset = textEnd + 1;
                      return {
                        textStart,
                        textEnd,
                        confidence: block.confidence,
                        boundingBox: block.boundingBox,
                      };
                    });
                    return {
                      page: item.page,
                      confidence: item.confidence,
                      ...(blocks.length > 0 ? { blocks } : {}),
                    };
                  }),
                }
              : {}),
          }
        : {}),
    },
  };
}

function serializePdfPages(pages: ReadonlyMap<number, string>): Readonly<{
  text: string;
  pageSpans: MatterDocumentPdfPageSpan[];
}> {
  let text = "";
  const partialSpans: Array<Omit<MatterDocumentPdfPageSpan, "textEnd">> = [];
  for (const [page, content] of [...pages.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    if (text) text += "\n\n";
    const textStart = text.length;
    text += `[Page ${page}]\n`;
    const contentStart = text.length;
    text += content;
    partialSpans.push({
      page,
      textStart,
      contentStart,
      contentEnd: text.length,
    });
  }
  const pageSpans = partialSpans.map((span, index) => ({
    ...span,
    textEnd: partialSpans[index + 1]?.textStart ?? text.length,
  }));
  return { text, pageSpans };
}

export function nativeOcrConfigured() {
  return configuredAppleVisionOcrProvider() !== null;
}

async function extractDocxText(buffer: Buffer) {
  const mammoth = await import("mammoth");
  const normalized = await normalizeDocxZipPaths(buffer);
  const result = await mammoth.extractRawText({ buffer: normalized });
  return result.value.trim();
}

async function extractXlsxDocument(
  buffer: Buffer,
): Promise<MatterDocumentExtraction> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(
    buffer as unknown as Parameters<typeof workbook.xlsx.load>[0],
  );
  const sections: string[] = [];
  workbook.eachSheet((worksheet) => {
    const rows: string[] = [];
    worksheet.eachRow((row, rowNumber) => {
      const cells = Array.isArray(row.values) ? row.values.slice(1) : [];
      const text = cells
        .map((cell) => cellText(cell))
        .filter(Boolean)
        .join(" | ");
      if (text) rows.push(`Row ${rowNumber}: ${text}`);
    });
    if (rows.length) {
      sections.push(`[Sheet ${worksheet.name}]\n${rows.join("\n")}`);
    }
  });
  return {
    text: sections.join("\n\n"),
    metadata: {
      parser: "xlsx",
      sheetCount: workbook.worksheets.length,
      sectionCount: sections.length,
    },
  };
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value).trim();
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text.trim();
    if (
      typeof record.result === "string" ||
      typeof record.result === "number"
    ) {
      return String(record.result).trim();
    }
    if (
      typeof record.hyperlink === "string" &&
      typeof record.text === "string"
    ) {
      return record.text.trim();
    }
    if (Array.isArray(record.richText)) {
      return record.richText
        .map((item) =>
          item && typeof item === "object" && "text" in item
            ? String((item as { text?: unknown }).text ?? "")
            : "",
        )
        .join("")
        .trim();
    }
  }
  return "";
}

export function chunkMatterDocument(
  text: string,
  structuredRegions?: readonly MatterDocumentChunkRegion[],
): ParsedDocumentChunk[] {
  const normalized = normalizeMatterDocumentText(text);
  if (!normalized) return [];

  const chunks: ParsedDocumentChunk[] = [];
  const regions =
    structuredRegions === undefined
      ? pageRegions(normalized)
      : validatedStructuredRegions(normalized, structuredRegions);
  for (const region of regions) {
    let cursor = region.start;
    while (cursor < region.end) {
      const end = Math.min(region.end, cursor + MAX_CHUNK_LENGTH);
      const window = normalized.slice(cursor, end);
      const breakAt = findChunkBreak(window);
      let actualEnd = end === region.end ? end : cursor + breakAt;
      if (
        actualEnd < region.end &&
        isHighSurrogate(normalized.charCodeAt(actualEnd - 1)) &&
        isLowSurrogate(normalized.charCodeAt(actualEnd))
      ) {
        actualEnd -= 1;
      }
      const selected = normalized.slice(cursor, actualEnd);
      const chunkText = selected.trim();
      if (chunkText) {
        const leadingWhitespace = selected.length - selected.trimStart().length;
        const trailingWhitespace = selected.length - selected.trimEnd().length;
        const quoteStart = cursor + leadingWhitespace;
        const quoteEnd = actualEnd - trailingWhitespace;
        chunks.push({
          chunkIndex: chunks.length,
          page: region.page,
          section: null,
          text: chunkText,
          quoteStart,
          quoteEnd,
        });
      }
      if (actualEnd >= region.end) break;
      let nextCursor = Math.max(actualEnd - CHUNK_OVERLAP, cursor + 1);
      if (
        isLowSurrogate(normalized.charCodeAt(nextCursor)) &&
        isHighSurrogate(normalized.charCodeAt(nextCursor - 1))
      ) {
        nextCursor = nextCursor - 1 > cursor ? nextCursor - 1 : nextCursor + 1;
      }
      cursor = nextCursor;
    }
  }
  return chunks;
}

function validatedStructuredRegions(
  text: string,
  regions: readonly MatterDocumentChunkRegion[],
): readonly MatterDocumentChunkRegion[] {
  if (!Array.isArray(regions) || regions.length < 1 || regions.length > 500) {
    throw new Error("Structured document page regions are invalid.");
  }
  let previousEnd = 0;
  let previousPage = 0;
  for (const region of regions) {
    if (
      !region ||
      typeof region !== "object" ||
      !Number.isSafeInteger(region.start) ||
      !Number.isSafeInteger(region.end) ||
      region.start !== previousEnd ||
      region.end <= region.start ||
      region.end > text.length ||
      (region.page !== null &&
        (!Number.isSafeInteger(region.page) ||
          region.page < 1 ||
          region.page > 500 ||
          region.page <= previousPage))
    ) {
      throw new Error("Structured document page regions are invalid.");
    }
    if (region.page !== null) previousPage = region.page;
    previousEnd = region.end;
  }
  if (previousEnd !== text.length) {
    throw new Error("Structured document page regions are invalid.");
  }
  return regions;
}

function isHighSurrogate(value: number) {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number) {
  return value >= 0xdc00 && value <= 0xdfff;
}

export function normalizeMatterDocumentText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageRegions(text: string) {
  const matches = [...text.matchAll(/\[Page (\d+)\]/g)];
  if (matches.length === 0) {
    return [{ start: 0, end: text.length, page: null as number | null }];
  }
  const regions: Array<{ start: number; end: number; page: number | null }> =
    [];
  const firstStart = matches[0].index ?? 0;
  if (firstStart > 0) {
    regions.push({ start: 0, end: firstStart, page: null });
  }
  matches.forEach((match, index) => {
    regions.push({
      start: match.index ?? 0,
      end: matches[index + 1]?.index ?? text.length,
      page: Number(match[1]),
    });
  });
  return regions;
}

function findChunkBreak(value: string) {
  if (value.length < MAX_CHUNK_LENGTH) return value.length;
  const paragraph = value.lastIndexOf("\n\n");
  if (paragraph > 400) return paragraph;
  const sentence = Math.max(
    value.lastIndexOf(". "),
    value.lastIndexOf("? "),
    value.lastIndexOf("! "),
  );
  if (sentence > 400) return sentence + 1;
  return value.length;
}

export async function writeMatterDocumentFile(args: {
  documentsDir: string;
  documentId: string;
  filename: string;
  buffer: Buffer;
}) {
  const ext = extension(args.filename);
  const safeExt = ext ? `.${ext}` : "";
  const filePath = path.join(args.documentsDir, `${args.documentId}${safeExt}`);
  writeProtectedLocalFileSync({
    filePath,
    plaintext: args.buffer,
    purpose: "source_document",
  });
  return filePath;
}

export function readMatterDocumentFile(filePath: string) {
  return readProtectedLocalFileSync({
    filePath,
    purpose: "source_document",
  });
}
