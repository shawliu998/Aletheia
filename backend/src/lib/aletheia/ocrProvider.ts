export const OCR_COORDINATE_SPACE = "normalized-top-left" as const;

export type OcrCoordinateSpace = typeof OCR_COORDINATE_SPACE;

export type OcrBoundingBox = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type OcrTextBlock = Readonly<{
  text: string;
  confidence: number;
  boundingBox: OcrBoundingBox;
}>;

export type OcrPageResult = Readonly<{
  page: number;
  text: string;
  confidence: number;
  blocks: readonly OcrTextBlock[];
}>;

export type OcrRecognitionResult = Readonly<{
  schemaVersion: "aletheia-native-ocr-v1";
  engine: string;
  coordinateSpace: OcrCoordinateSpace | null;
  pages: readonly OcrPageResult[];
}>;

export type OcrPdfRequest = Readonly<{
  pdf: Buffer;
  pageCount: number;
  pages: readonly number[];
  signal?: AbortSignal;
}>;

export interface OcrProvider {
  readonly id: string;
  readonly local: boolean;
  isAvailable(): boolean;
  recognizePdf(request: OcrPdfRequest): Promise<OcrRecognitionResult>;
}

export type OcrProviderErrorCode =
  | "OCR_NOT_CONFIGURED"
  | "OCR_INVALID_REQUEST"
  | "OCR_SPAWN_FAILED"
  | "OCR_INPUT_FAILED"
  | "OCR_TIMEOUT"
  | "OCR_ABORTED"
  | "OCR_OUTPUT_TOO_LARGE"
  | "OCR_RUNTIME_FAILED"
  | "OCR_OUTPUT_INVALID";

export class OcrProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: OcrProviderErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OcrProviderError";
    this.retryable = options.retryable ?? false;
  }
}

export function normalizeRequestedOcrPages(
  pages: readonly number[],
  pageCount: number,
): number[] {
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 500) {
    throw new OcrProviderError(
      "OCR_INVALID_REQUEST",
      "Local OCR requires a PDF containing between 1 and 500 pages.",
    );
  }
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > pageCount) {
    throw new OcrProviderError(
      "OCR_INVALID_REQUEST",
      "Local OCR requires one or more bounded PDF pages.",
    );
  }
  const normalized = [...pages].sort((left, right) => left - right);
  for (let index = 0; index < normalized.length; index += 1) {
    const page = normalized[index];
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > pageCount ||
      (index > 0 && normalized[index - 1] === page)
    ) {
      throw new OcrProviderError(
        "OCR_INVALID_REQUEST",
        "Local OCR page selection is invalid.",
      );
    }
  }
  return normalized;
}

/** Serializes a validated page set without exposing a caller-controlled CLI token. */
export function ocrPageRangeArgument(pages: readonly number[]): string {
  if (pages.length === 0) {
    throw new OcrProviderError(
      "OCR_INVALID_REQUEST",
      "Local OCR page selection is empty.",
    );
  }
  const ranges: string[] = [];
  let start = pages[0];
  let end = start;
  for (const page of pages.slice(1)) {
    if (page === end + 1) {
      end = page;
      continue;
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);
    start = page;
    end = page;
  }
  ranges.push(start === end ? String(start) : `${start}-${end}`);
  return ranges.join(",");
}
