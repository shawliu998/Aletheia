import { spawn } from "node:child_process";
import { lstatSync } from "node:fs";
import path from "node:path";

import {
  OCR_COORDINATE_SPACE,
  OcrProviderError,
  normalizeRequestedOcrPages,
  ocrPageRangeArgument,
  type OcrBoundingBox,
  type OcrPageResult,
  type OcrPdfRequest,
  type OcrProvider,
  type OcrRecognitionResult,
  type OcrTextBlock,
} from "./ocrProvider";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const MAX_PAGE_TEXT_LENGTH = 10_000_000;
const MAX_BLOCKS_PER_PAGE = 100_000;
const MAX_BLOCK_TEXT_LENGTH = 1_000_000;

export type AppleVisionOcrProviderOptions = Readonly<{
  binaryPath: string;
  timeoutMs?: number;
}>;

function finiteUnit(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value
    : null;
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

function boundingBox(value: unknown): OcrBoundingBox | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    !Object.hasOwn(record, "x") ||
    !Object.hasOwn(record, "y") ||
    !Object.hasOwn(record, "width") ||
    !Object.hasOwn(record, "height")
  ) {
    return null;
  }
  const x = finiteUnit(record.x);
  const y = finiteUnit(record.y);
  const width = finiteUnit(record.width);
  const height = finiteUnit(record.height);
  if (
    x === null ||
    y === null ||
    width === null ||
    height === null ||
    x + width > 1.000_001 ||
    y + height > 1.000_001
  ) {
    return null;
  }
  return { x, y, width, height };
}

function textBlock(value: unknown): OcrTextBlock | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ["text", "confidence", "boundingBox"]) ||
    typeof record.text !== "string" ||
    record.text.length > MAX_BLOCK_TEXT_LENGTH
  ) {
    return null;
  }
  const confidence = finiteUnit(record.confidence);
  const box = boundingBox(record.boundingBox);
  if (confidence === null || box === null) return null;
  return { text: record.text, confidence, boundingBox: box };
}

function pageResult(
  value: unknown,
  requested: ReadonlySet<number>,
): OcrPageResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const page = record.page;
  const confidence = finiteUnit(record.confidence);
  if (
    !exactKeys(
      record,
      record.blocks === undefined
        ? ["page", "text", "confidence"]
        : ["page", "text", "confidence", "blocks"],
    ) ||
    typeof page !== "number" ||
    !Number.isSafeInteger(page) ||
    !requested.has(page) ||
    typeof record.text !== "string" ||
    record.text.length > MAX_PAGE_TEXT_LENGTH ||
    confidence === null
  ) {
    return null;
  }
  if (record.blocks === undefined) {
    // Old v1 helpers did not emit layout. Preserve protocol compatibility
    // without inventing coordinates.
    return { page, text: record.text, confidence, blocks: [] };
  }
  if (
    !Array.isArray(record.blocks) ||
    record.blocks.length > MAX_BLOCKS_PER_PAGE
  ) {
    return null;
  }
  const blocks: OcrTextBlock[] = [];
  for (const value of record.blocks) {
    const block = textBlock(value);
    if (!block) return null;
    blocks.push(block);
  }
  if (blocks.map((block) => block.text).join("\n") !== record.text) {
    return null;
  }
  return { page, text: record.text, confidence, blocks };
}

function parseOutput(
  bytes: Buffer,
  requestedPages: readonly number[],
  pageCount: number,
): OcrRecognitionResult {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new OcrProviderError(
      "OCR_OUTPUT_INVALID",
      "Local OCR returned invalid JSON.",
      { cause: error },
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OcrProviderError(
      "OCR_OUTPUT_INVALID",
      "Local OCR returned an invalid schema.",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(
      record,
      record.coordinateSpace === undefined
        ? ["schemaVersion", "engine", "pages"]
        : ["schemaVersion", "engine", "coordinateSpace", "pages"],
    ) ||
    record.schemaVersion !== "aletheia-native-ocr-v1" ||
    record.engine !== "apple-vision" ||
    !Array.isArray(record.pages)
  ) {
    throw new OcrProviderError(
      "OCR_OUTPUT_INVALID",
      "Local OCR returned an invalid schema.",
    );
  }
  const coordinateSpace =
    record.coordinateSpace === undefined
      ? null
      : record.coordinateSpace === OCR_COORDINATE_SPACE
        ? OCR_COORDINATE_SPACE
        : undefined;
  if (coordinateSpace === undefined) {
    throw new OcrProviderError(
      "OCR_OUTPUT_INVALID",
      "Local OCR returned an invalid coordinate space.",
    );
  }
  const requested = new Set(requestedPages);
  const acceptedPages =
    coordinateSpace === null
      ? new Set(Array.from({ length: pageCount }, (_, index) => index + 1))
      : requested;
  const returnedPages: OcrPageResult[] = [];
  const seen = new Set<number>();
  for (const candidate of record.pages) {
    const page = pageResult(candidate, acceptedPages);
    if (!page || seen.has(page.page)) {
      throw new OcrProviderError(
        "OCR_OUTPUT_INVALID",
        "Local OCR returned invalid page data.",
      );
    }
    if (page.blocks.length > 0 && coordinateSpace === null) {
      throw new OcrProviderError(
        "OCR_OUTPUT_INVALID",
        "Local OCR returned blocks without a coordinate space.",
      );
    }
    seen.add(page.page);
    returnedPages.push(page);
  }
  // Historical v1 helpers ignored CLI arguments and returned every page.
  // Validate their full output, then filter it. Coordinate-aware helpers
  // implement the ranged protocol and must return exactly the requested set.
  const pages = returnedPages
    .filter((page) => requested.has(page.page))
    .sort((left, right) => left.page - right.page);
  if (
    (coordinateSpace !== null &&
      returnedPages.length !== requestedPages.length) ||
    pages.length !== requestedPages.length ||
    pages.some((page, index) => page.page !== requestedPages[index])
  ) {
    throw new OcrProviderError(
      "OCR_OUTPUT_INVALID",
      "Local OCR did not return every requested page exactly once.",
    );
  }
  return {
    schemaVersion: "aletheia-native-ocr-v1",
    engine: "apple-vision",
    coordinateSpace,
    pages,
  };
}

function safeRuntimeDetail(stderr: Buffer[]) {
  return Buffer.concat(stderr)
    .toString("utf8")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

export class AppleVisionOcrProvider implements OcrProvider {
  readonly id = "apple-vision";
  readonly local = true;
  readonly binaryPath: string;
  readonly timeoutMs: number;

  constructor(options: AppleVisionOcrProviderOptions) {
    this.binaryPath = options.binaryPath.trim();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!path.isAbsolute(this.binaryPath)) {
      throw new OcrProviderError(
        "OCR_NOT_CONFIGURED",
        "Local OCR helper path must be absolute.",
      );
    }
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > DEFAULT_TIMEOUT_MS
    ) {
      throw new OcrProviderError(
        "OCR_INVALID_REQUEST",
        "Local OCR timeout is invalid.",
      );
    }
  }

  isAvailable() {
    try {
      const info = lstatSync(this.binaryPath);
      return info.isFile() && !info.isSymbolicLink();
    } catch {
      return false;
    }
  }

  async recognizePdf(request: OcrPdfRequest): Promise<OcrRecognitionResult> {
    if (!this.isAvailable()) {
      throw new OcrProviderError(
        "OCR_NOT_CONFIGURED",
        "Local OCR helper is unavailable.",
      );
    }
    if (!Buffer.isBuffer(request.pdf) || request.pdf.length === 0) {
      throw new OcrProviderError(
        "OCR_INVALID_REQUEST",
        "Local OCR requires non-empty PDF bytes.",
      );
    }
    const pages = normalizeRequestedOcrPages(request.pages, request.pageCount);
    if (request.signal?.aborted) {
      throw new OcrProviderError("OCR_ABORTED", "Local OCR was cancelled.", {
        retryable: true,
      });
    }

    return new Promise<OcrRecognitionResult>((resolve, reject) => {
      const child = spawn(
        this.binaryPath,
        ["--pages", ocrPageRangeArgument(pages)],
        {
          stdio: ["pipe", "pipe", "pipe"],
          env: { LANG: "en_US.UTF-8" },
          shell: false,
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error, kill = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (kill) child.kill("SIGKILL");
        reject(error);
      };
      const succeed = (result: OcrRecognitionResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onAbort = () => {
        fail(
          new OcrProviderError("OCR_ABORTED", "Local OCR was cancelled.", {
            retryable: true,
          }),
          true,
        );
      };
      const timeout = setTimeout(() => {
        fail(
          new OcrProviderError("OCR_TIMEOUT", "Local OCR timed out.", {
            retryable: true,
          }),
          true,
        );
      }, this.timeoutMs);
      timeout.unref();
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          fail(
            new OcrProviderError(
              "OCR_OUTPUT_TOO_LARGE",
              "Local OCR output exceeded the safety limit.",
            ),
            true,
          );
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled || stderrBytes >= MAX_STDERR_BYTES) return;
        const remaining = MAX_STDERR_BYTES - stderrBytes;
        const bounded = chunk.subarray(0, remaining);
        stderr.push(bounded);
        stderrBytes += bounded.length;
      });
      child.once("error", (error) => {
        fail(
          new OcrProviderError(
            "OCR_SPAWN_FAILED",
            "Local OCR helper could not be started.",
            { retryable: true, cause: error },
          ),
        );
      });
      child.stdin.once("error", (error: NodeJS.ErrnoException) => {
        fail(
          new OcrProviderError(
            "OCR_INPUT_FAILED",
            `Local OCR failed: input ${error.code || "write_error"}.`,
            { retryable: true, cause: error },
          ),
          true,
        );
      });
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          const detail = safeRuntimeDetail(stderr);
          fail(
            new OcrProviderError(
              "OCR_RUNTIME_FAILED",
              `Local OCR failed: ${detail || `exit ${String(code)}`}.`,
              { retryable: true },
            ),
          );
          return;
        }
        try {
          succeed(parseOutput(Buffer.concat(stdout), pages, request.pageCount));
        } catch (error) {
          fail(
            error instanceof Error
              ? error
              : new OcrProviderError(
                  "OCR_OUTPUT_INVALID",
                  "Local OCR returned invalid output.",
                ),
          );
        }
      });
      request.signal?.addEventListener("abort", onAbort, { once: true });
      // Close the race between the pre-spawn check and listener registration.
      if (request.signal?.aborted) {
        onAbort();
        return;
      }
      child.stdin.end(request.pdf);
    });
  }
}

export function configuredAppleVisionOcrProvider(
  options: { timeoutMs?: number } = {},
): AppleVisionOcrProvider | null {
  if (process.env.ALETHEIA_OCR_ENABLED !== "true") return null;
  const binaryPath = process.env.ALETHEIA_OCR_BINARY?.trim();
  if (!binaryPath || !path.isAbsolute(binaryPath)) return null;
  let provider: AppleVisionOcrProvider;
  try {
    provider = new AppleVisionOcrProvider({
      binaryPath,
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
  } catch {
    return null;
  }
  return provider.isAvailable() ? provider : null;
}
