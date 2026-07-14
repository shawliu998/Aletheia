import {
  veraApiErrorFromResponse,
  veraApiFetch,
  type VeraApiRequestOptions,
} from "./veraApi";
import type {
  VeraDocumentCitationQuoteWire,
  VeraDocumentCitationWire,
  VeraSseEventWire,
} from "./veraWireTypes";

const MAX_FRAME_CHARS = 1_000_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class VeraSseProtocolError extends Error {
  readonly code = "INVALID_SSE";

  constructor(message = "The Vera event stream is invalid.") {
    super(message);
    this.name = "VeraSseProtocolError";
  }
}

function invalid(): never {
  throw new VeraSseProtocolError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isString(value: unknown, max: number, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (allowEmpty || value.trim().length > 0)
  );
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= minimum;
}

function isOneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
): value is T[number] {
  return typeof value === "string" && values.includes(value);
}

function isPage(value: unknown): value is number | string {
  return (
    isIntegerAtLeast(value, 1) ||
    (typeof value === "string" && value.trim().length > 0 && value.length <= 80)
  );
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  max: number,
  allowEmpty = true,
): boolean {
  return (
    !Object.hasOwn(value, key) || isString(value[key], max, allowEmpty)
  );
}

function parseCitationQuote(value: unknown): VeraDocumentCitationQuoteWire {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["page", "quote"], ["sheet", "cell"]) ||
    !isPage(value.page) ||
    !isString(value.quote, 100_000) ||
    !optionalString(value, "sheet", 240) ||
    !optionalString(value, "cell", 80)
  ) {
    return invalid();
  }
  return value as unknown as VeraDocumentCitationQuoteWire;
}

function parseCitation(value: unknown): VeraDocumentCitationWire {
  const required = [
    "type",
    "kind",
    "ref",
    "doc_id",
    "document_id",
    "filename",
    "quote",
    "page",
  ];
  const optional = [
    "version_id",
    "version_number",
    "sheet",
    "cell",
    "quotes",
  ];
  if (
    !isRecord(value) ||
    !exactKeys(value, required, optional) ||
    value.type !== "citation_data" ||
    value.kind !== "document" ||
    !isIntegerAtLeast(value.ref, 1) ||
    !isString(value.doc_id, 20_000) ||
    !isUuid(value.document_id) ||
    !isString(value.filename, 20_000) ||
    !isString(value.quote, 100_000) ||
    !isPage(value.page) ||
    !optionalString(value, "sheet", 240) ||
    !optionalString(value, "cell", 80)
  ) {
    return invalid();
  }
  if (
    Object.hasOwn(value, "version_id") &&
    value.version_id !== null &&
    !isUuid(value.version_id)
  ) {
    return invalid();
  }
  if (
    Object.hasOwn(value, "version_number") &&
    value.version_number !== null &&
    !isIntegerAtLeast(value.version_number, 1)
  ) {
    return invalid();
  }
  if (Object.hasOwn(value, "quotes")) {
    if (!Array.isArray(value.quotes) || value.quotes.length > 3) return invalid();
    value.quotes.forEach(parseCitationQuote);
  }
  return value as unknown as VeraDocumentCitationWire;
}

function parseCellContent(
  value: unknown,
): Extract<VeraSseEventWire, { type: "cell_update" }>["content"] {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !exactKeys(value, ["summary"], ["flag", "reasoning"]) ||
    !isString(value.summary, 100_000, true) ||
    !optionalString(value, "reasoning", 100_000, true) ||
    (Object.hasOwn(value, "flag") &&
      !isOneOf(value.flag, ["green", "grey", "yellow", "red"] as const))
  ) {
    return invalid();
  }
  return value as Extract<
    VeraSseEventWire,
    { type: "cell_update" }
  >["content"];
}

/** Validate and narrow one locked-Mike streaming event. */
export function parseVeraSseEvent(value: unknown): VeraSseEventWire {
  if (!isRecord(value) || typeof value.type !== "string") return invalid();

  switch (value.type) {
    case "chat_id":
      if (!exactKeys(value, ["type", "chatId"]) || !isUuid(value.chatId))
        return invalid();
      break;
    case "content_delta":
    case "reasoning_delta":
      if (
        !exactKeys(value, ["type", "text"]) ||
        !isString(value.text, 200_000, true)
      )
        return invalid();
      break;
    case "content_done":
    case "reasoning_block_end":
      if (!exactKeys(value, ["type"])) return invalid();
      break;
    case "tool_call_start":
      if (
        !exactKeys(value, ["type", "name"]) ||
        !isString(value.name, 20_000)
      )
        return invalid();
      break;
    case "workflow_applied":
      if (
        !exactKeys(value, ["type", "workflow_id", "title"]) ||
        !isUuid(value.workflow_id) ||
        !isString(value.title, 20_000)
      )
        return invalid();
      break;
    case "citations":
      if (
        !exactKeys(value, ["type", "status", "citations"]) ||
        !isOneOf(value.status, ["started", "partial", "final"] as const) ||
        !Array.isArray(value.citations) ||
        value.citations.length > 1_000
      )
        return invalid();
      value.citations.forEach(parseCitation);
      break;
    case "error":
      if (
        !exactKeys(value, ["type", "message"]) ||
        !isString(value.message, 20_000)
      )
        return invalid();
      break;
    case "cell_update":
      if (
        !exactKeys(value, [
          "type",
          "document_id",
          "column_index",
          "content",
          "status",
        ]) ||
        !isUuid(value.document_id) ||
        !isIntegerAtLeast(value.column_index, 0) ||
        !isOneOf(value.status, ["generating", "done", "error"] as const)
      )
        return invalid();
      parseCellContent(value.content);
      break;
    case "chat_title":
      if (
        !exactKeys(value, ["type", "chatId", "title"]) ||
        !isUuid(value.chatId) ||
        !isString(value.title, 20_000)
      )
        return invalid();
      break;
    default:
      return invalid();
  }
  return value as unknown as VeraSseEventWire;
}

function parseFrame(frame: string): VeraSseEventWire | "done" {
  if (!frame.startsWith("data: ") || frame.includes("\n") || frame.includes("\r")) {
    return invalid();
  }
  const data = frame.slice("data: ".length);
  if (data === "[DONE]") return "done";
  if (!data.startsWith("{") || !data.endsWith("}")) return invalid();

  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return invalid();
  }
  return parseVeraSseEvent(value);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

/**
 * Incrementally parses UTF-8 SSE chunks. A stream is valid only when every
 * frame is one `data: <JSON>` record and the terminal `[DONE]` is present.
 */
export async function* parseVeraSseStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<VeraSseEventWire> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let doneSeen = false;
  let aborted: Promise<never> | null = null;
  let onAbort: (() => void) | null = null;

  if (signal) {
    if (signal.aborted) {
      await reader.cancel();
      throw abortReason(signal);
    }
    aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void reader.cancel();
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  try {
    while (true) {
      const result = aborted
        ? await Promise.race([reader.read(), aborted])
        : await reader.read();
      if (result.done) {
        try {
          buffer += decoder.decode();
        } catch {
          return invalid();
        }
        break;
      }
      try {
        buffer += decoder.decode(result.value, { stream: true });
      } catch {
        return invalid();
      }

      while (true) {
        const separator = /\r?\n\r?\n/.exec(buffer);
        if (!separator || separator.index === undefined) break;
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        if (frame.length === 0) continue;
        if (frame.length > MAX_FRAME_CHARS) return invalid();
        if (doneSeen) return invalid();
        const parsed = parseFrame(frame);
        if (parsed === "done") {
          doneSeen = true;
        } else {
          yield parsed;
        }
      }
      if (buffer.length > MAX_FRAME_CHARS) return invalid();
    }

    if (buffer.length !== 0 || !doneSeen) return invalid();
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    try {
      await reader.cancel();
    } catch {
      // Stream validation has already produced the caller-visible outcome.
    }
  }
}

export async function* parseVeraSseResponse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<VeraSseEventWire> {
  if (!response.ok) throw await veraApiErrorFromResponse(response);
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^text\/event-stream(?:\s*;|$)/i.test(contentType) || !response.body) {
    return invalid();
  }
  yield* parseVeraSseStream(response.body, signal);
}

export async function* streamVeraSse(
  path: string,
  options: VeraApiRequestOptions = {},
): AsyncGenerator<VeraSseEventWire> {
  const headers = new Headers(options.headers);
  if (headers.has("accept") && headers.get("accept") !== "text/event-stream") {
    throw new VeraSseProtocolError();
  }
  headers.set("Accept", "text/event-stream");
  const response = await veraApiFetch(path, { ...options, headers });
  yield* parseVeraSseResponse(response, options.signal ?? undefined);
}
