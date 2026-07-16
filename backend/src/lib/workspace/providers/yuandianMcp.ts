import { createHash } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const YUANDIAN_MCP_ORIGIN = "https://open.chineselaw.com";
export const YUANDIAN_MCP_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_MAX_RESULTS = 20;
const MAX_RESULTS = 20;
const MAX_QUERY_LENGTH = 4_000;
const MAX_REQUEST_BYTES = 64_000;
const MAX_STRUCTURE_DEPTH = 12;
const MAX_STRUCTURE_NODES = 10_000;
const MAX_OBJECT_KEYS = 128;
const MAX_ARRAY_ITEMS = 500;
const MAX_STRING_BYTES = 256 * 1_024;
const MAX_SOURCE_CONTENT_BYTES = 256 * 1_024;
const CREDENTIAL_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,195}$/;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;

/**
 * Code-owned official Streamable HTTP endpoints. Runtime configuration cannot
 * replace these URLs. The company endpoint is recorded solely so an attempted
 * substitution can be rejected; it is never an eligible legal-authority
 * transport.
 */
export const YUANDIAN_MCP_ENDPOINTS = Object.freeze({
  law: `${YUANDIAN_MCP_ORIGIN}/mcp/law/stream`,
  case: `${YUANDIAN_MCP_ORIGIN}/mcp/case/stream`,
  company: `${YUANDIAN_MCP_ORIGIN}/mcp/company/stream`,
} as const);

/** No tools/list response or remote schema can expand this code-owned set. */
export const YUANDIAN_MCP_LEGAL_TOOL_ALLOWLIST = Object.freeze({
  law: Object.freeze([
    "yuandian_law_vector_search",
    "yuandian_rh_ft_detail",
    "yuandian_rh_fg_detail",
  ] as const),
  case: Object.freeze([
    "yuandian_case_vector_search",
    "yuandian_rh_case_details",
  ] as const),
} as const);

type YuanDianMcpCapability = keyof typeof YUANDIAN_MCP_ENDPOINTS;
type YuanDianLegalCapability = Exclude<YuanDianMcpCapability, "company">;
type YuanDianLawTool = (typeof YUANDIAN_MCP_LEGAL_TOOL_ALLOWLIST.law)[number];
type YuanDianCaseTool = (typeof YUANDIAN_MCP_LEGAL_TOOL_ALLOWLIST.case)[number];
export type YuanDianLegalTool = YuanDianLawTool | YuanDianCaseTool;

export type YuanDianMcpAdapterConfig = {
  /** Opaque Keychain/credential-worker reference, never the Bearer value. */
  credentialRef: string;
  /** Test seam only; production remains capped at twelve seconds. */
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxResults?: number;
};

export type YuanDianMcpSearchRequest = {
  query: string;
  sourceTypes?: readonly (
    | "statute"
    | "regulation"
    | "judicial_interpretation"
    | "case"
    | "guidance"
  )[];
  limit?: number;
};

export type YuanDianMcpSearchItem = {
  providerSourceId: string;
  title: string;
  sourceType:
    | "statute"
    | "regulation"
    | "judicial_interpretation"
    | "case"
    | "guidance";
  jurisdiction?: string;
  court?: string;
  caseNumber?: string;
  effectiveDate?: string;
  status?: string;
  summary?: string;
};

export type YuanDianMcpSearchResponse = {
  queryId: string;
  results: YuanDianMcpSearchItem[];
};

export type YuanDianMcpSourceDocument = {
  providerSourceId: string;
  title: string;
  sourceType: YuanDianMcpSearchItem["sourceType"];
  content: string;
  metadata: {
    jurisdiction?: string;
    court?: string;
    caseNumber?: string;
    effectiveDate?: string;
    publicationDate?: string;
    status?: string;
  };
  locator: {
    article?: string;
  };
};

export type YuanDianMcpClientRequestOptions = {
  signal: AbortSignal;
  timeout: number;
  maxTotalTimeout: number;
};

export type YuanDianMcpClientSession = {
  connect(options: YuanDianMcpClientRequestOptions): Promise<void>;
  callTool(
    request: {
      name: YuanDianLegalTool;
      arguments: Record<string, unknown>;
    },
    options: YuanDianMcpClientRequestOptions,
  ): Promise<unknown>;
  close(): Promise<void>;
};

export type YuanDianMcpClientFactoryInput = {
  capability: YuanDianLegalCapability;
  endpoint: URL;
  authorizationHeader: string;
  fetch: typeof globalThis.fetch;
  maxResponseBytes: number;
};

export type YuanDianMcpAdapterDeps = {
  resolveCredential: (
    credentialRef: string,
    signal: AbortSignal,
  ) => Promise<string | null | undefined>;
  fetch?: typeof globalThis.fetch;
  createClient?: (
    input: YuanDianMcpClientFactoryInput,
  ) => YuanDianMcpClientSession | Promise<YuanDianMcpClientSession>;
};

export class YuanDianMcpAdapterError extends Error {
  constructor(
    readonly code:
      | "configuration_error"
      | "credential_unavailable"
      | "policy_violation"
      | "transport_error"
      | "response_invalid",
    message: string,
  ) {
    super(message);
    this.name = "YuanDianMcpAdapterError";
  }
}

type ValidatedConfig = {
  credentialRef: string;
  timeoutMs: number;
  maxResponseBytes: number;
  maxResults: number;
};

function adapterError(code: YuanDianMcpAdapterError["code"], message: string) {
  return new YuanDianMcpAdapterError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  label: string,
  code: YuanDianMcpAdapterError["code"],
): asserts value is Record<string, unknown> {
  if (
    !isPlainObject(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  ) {
    throw adapterError(code, `${label} contains unsupported fields.`);
  }
}

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  label: string,
) {
  const resolved = value ?? fallback;
  if (
    !Number.isInteger(resolved) ||
    Number(resolved) < 1 ||
    Number(resolved) > maximum
  ) {
    throw adapterError("configuration_error", `${label} is invalid.`);
  }
  return Number(resolved);
}

function validateConfig(config: YuanDianMcpAdapterConfig): ValidatedConfig {
  exactObject(
    config,
    ["credentialRef", "timeoutMs", "maxResponseBytes", "maxResults"],
    "YuanDian MCP configuration",
    "configuration_error",
  );
  if (
    typeof config.credentialRef !== "string" ||
    !CREDENTIAL_REF.test(config.credentialRef) ||
    /^(?:bearer|token|secret|password|sk-)/i.test(config.credentialRef)
  ) {
    throw adapterError(
      "configuration_error",
      "YuanDian MCP configuration requires an opaque credential reference.",
    );
  }
  return {
    credentialRef: config.credentialRef,
    timeoutMs: positiveInteger(
      config.timeoutMs,
      YUANDIAN_MCP_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "YuanDian MCP timeout",
    ),
    maxResponseBytes: positiveInteger(
      config.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MAX_RESPONSE_BYTES,
      "YuanDian MCP response byte limit",
    ),
    maxResults: positiveInteger(
      config.maxResults,
      DEFAULT_MAX_RESULTS,
      MAX_RESULTS,
      "YuanDian MCP result limit",
    ),
  };
}

export function validateYuanDianMcpEndpoint(
  capability: YuanDianMcpCapability,
  raw: string,
): URL {
  if (!(capability in YUANDIAN_MCP_ENDPOINTS) || typeof raw !== "string") {
    throw adapterError(
      "configuration_error",
      "YuanDian MCP endpoint configuration is invalid.",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw adapterError(
      "configuration_error",
      "YuanDian MCP endpoint must be a valid HTTPS URL.",
    );
  }
  const expected = YUANDIAN_MCP_ENDPOINTS[capability];
  if (
    raw !== expected ||
    endpoint.toString() !== expected ||
    endpoint.protocol !== "https:" ||
    endpoint.origin !== YUANDIAN_MCP_ORIGIN ||
    endpoint.hostname !== "open.chineselaw.com" ||
    endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw adapterError(
      "policy_violation",
      "YuanDian MCP endpoint is not the code-owned official endpoint.",
    );
  }
  return endpoint;
}

function requestUrl(input: string | URL | Request) {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
}

function boundedResponseBody(
  body: ReadableStream<Uint8Array>,
  maximum: number,
) {
  const reader = body.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          return;
        }
        received += next.value.byteLength;
        if (received > maximum) {
          await reader.cancel();
          controller.error(
            adapterError(
              "response_invalid",
              "YuanDian MCP response exceeded the byte limit.",
            ),
          );
          return;
        }
        controller.enqueue(next.value);
      } catch {
        controller.error(
          adapterError(
            "transport_error",
            "YuanDian MCP response stream failed.",
          ),
        );
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

/** Exported for deterministic transport audits; production uses it internally. */
export function createGuardedYuanDianMcpFetch(input: {
  fetch: typeof globalThis.fetch;
  endpoint: URL;
  authorizationHeader: string;
  maxResponseBytes: number;
}): typeof globalThis.fetch {
  return async (request, init) => {
    let url: URL;
    try {
      url = requestUrl(request);
    } catch {
      throw adapterError(
        "policy_violation",
        "YuanDian MCP request URL is invalid.",
      );
    }
    if (url.toString() !== input.endpoint.toString()) {
      throw adapterError(
        "policy_violation",
        "YuanDian MCP transport attempted an unapproved URL.",
      );
    }
    const requestHeaders = new Headers(
      request instanceof Request ? request.headers : undefined,
    );
    new Headers(init?.headers).forEach((value, key) =>
      requestHeaders.set(key, value),
    );
    requestHeaders.set("Authorization", input.authorizationHeader);
    const response = await input.fetch(request, {
      ...init,
      headers: requestHeaders,
      redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      throw adapterError(
        "policy_violation",
        "YuanDian MCP redirects are prohibited.",
      );
    }
    if (response.url) {
      let responseUrl: URL;
      try {
        responseUrl = new URL(response.url);
      } catch {
        throw adapterError(
          "policy_violation",
          "YuanDian MCP response URL is invalid.",
        );
      }
      if (responseUrl.toString() !== input.endpoint.toString()) {
        throw adapterError(
          "policy_violation",
          "YuanDian MCP response URL changed unexpectedly.",
        );
      }
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > input.maxResponseBytes) {
      throw adapterError(
        "response_invalid",
        "YuanDian MCP response exceeded the byte limit.",
      );
    }
    if (!response.body) return response;
    return new Response(
      boundedResponseBody(response.body, input.maxResponseBytes),
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      },
    );
  };
}

function sdkClientFactory(
  input: YuanDianMcpClientFactoryInput,
): YuanDianMcpClientSession {
  const transport = new StreamableHTTPClientTransport(input.endpoint, {
    fetch: createGuardedYuanDianMcpFetch({
      fetch: input.fetch,
      endpoint: input.endpoint,
      authorizationHeader: input.authorizationHeader,
      maxResponseBytes: input.maxResponseBytes,
    }),
    requestInit: {
      headers: { Authorization: input.authorizationHeader },
      redirect: "manual",
    },
    reconnectionOptions: {
      initialReconnectionDelay: 100,
      maxReconnectionDelay: 100,
      reconnectionDelayGrowFactor: 1,
      maxRetries: 0,
    },
  });
  const client = new Client(
    { name: "vera-yuandian-legal-source", version: "1.0.0" },
    { capabilities: {}, enforceStrictCapabilities: true },
  );
  return {
    connect: (options) => client.connect(transport, options),
    callTool: (request, options) =>
      client.callTool(request, undefined, options),
    close: () => client.close(),
  };
}

async function closeSession(
  session: YuanDianMcpClientSession,
  timeoutMs: number,
) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      session.close().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(timeoutMs, 1_000));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function abortError() {
  const error = new Error("YuanDian MCP request was cancelled.");
  error.name = "AbortError";
  return error;
}

async function withDeadline<T>(
  callerSignal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (callerSignal.aborted) throw abortError();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  callerSignal.addEventListener("abort", onAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(
        adapterError("transport_error", "YuanDian MCP request timed out."),
      );
    }, timeoutMs);
  });
  const cancelled = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        if (!timedOut) reject(abortError());
      },
      { once: true },
    );
  });
  try {
    return await Promise.race([
      operation(controller.signal),
      timeout,
      cancelled,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    callerSignal.removeEventListener("abort", onAbort);
  }
}

function validateBearerToken(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 8_192 ||
    value !== value.trim() ||
    /^Bearer\s/i.test(value) ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw adapterError(
      "credential_unavailable",
      "YuanDian MCP credential is unavailable or invalid.",
    );
  }
  return value;
}

function assertBoundedStructure(value: unknown, maximumBytes: number) {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let bytes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_STRUCTURE_NODES || current.depth > MAX_STRUCTURE_DEPTH) {
      throw adapterError(
        "response_invalid",
        "YuanDian MCP response structure is too complex.",
      );
    }
    if (typeof current.value === "string") {
      const length = Buffer.byteLength(current.value, "utf8");
      if (length > MAX_STRING_BYTES) {
        throw adapterError(
          "response_invalid",
          "YuanDian MCP response contains an oversized string.",
        );
      }
      bytes += length;
    } else if (
      current.value === null ||
      typeof current.value === "number" ||
      typeof current.value === "boolean"
    ) {
      bytes += 16;
    } else if (Array.isArray(current.value)) {
      if (current.value.length > MAX_ARRAY_ITEMS || seen.has(current.value)) {
        throw adapterError(
          "response_invalid",
          "YuanDian MCP response array is invalid.",
        );
      }
      seen.add(current.value);
      for (const child of current.value) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else if (isPlainObject(current.value)) {
      if (seen.has(current.value)) {
        throw adapterError(
          "response_invalid",
          "YuanDian MCP response contains a cycle.",
        );
      }
      seen.add(current.value);
      const entries = Object.entries(current.value);
      if (entries.length > MAX_OBJECT_KEYS) {
        throw adapterError(
          "response_invalid",
          "YuanDian MCP response object has too many fields.",
        );
      }
      for (const [key, child] of entries) {
        bytes += Buffer.byteLength(key, "utf8");
        stack.push({ value: child, depth: current.depth + 1 });
      }
    } else {
      throw adapterError(
        "response_invalid",
        "YuanDian MCP response contains an unsupported value.",
      );
    }
    if (bytes > maximumBytes) {
      throw adapterError(
        "response_invalid",
        "YuanDian MCP response exceeded the byte limit.",
      );
    }
  }
}

function parseJsonText(text: string, maximumBytes: number): unknown {
  if (!text.trim() || Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw adapterError(
      "response_invalid",
      "YuanDian MCP text result is empty or oversized.",
    );
  }
  try {
    const parsed: unknown = JSON.parse(text);
    assertBoundedStructure(parsed, maximumBytes);
    return parsed;
  } catch (error) {
    if (error instanceof YuanDianMcpAdapterError) throw error;
    throw adapterError(
      "response_invalid",
      "YuanDian MCP text result must contain strict JSON.",
    );
  }
}

function toolPayload(result: unknown, maximumBytes: number): unknown {
  assertBoundedStructure(result, maximumBytes);
  if (!isPlainObject(result)) {
    throw adapterError("response_invalid", "YuanDian MCP result is invalid.");
  }
  if (result.isError === true) {
    throw adapterError(
      "transport_error",
      "YuanDian MCP tool reported an unsuccessful result.",
    );
  }
  if (Object.hasOwn(result, "structuredContent")) {
    if (result.structuredContent === undefined) {
      throw adapterError(
        "response_invalid",
        "YuanDian MCP structured result is missing.",
      );
    }
    return result.structuredContent;
  }
  if (!Array.isArray(result.content) || result.content.length !== 1) {
    throw adapterError(
      "response_invalid",
      "YuanDian MCP result requires one structured or JSON text payload.",
    );
  }
  const block = result.content[0];
  if (
    !isPlainObject(block) ||
    block.type !== "text" ||
    typeof block.text !== "string"
  ) {
    throw adapterError(
      "response_invalid",
      "YuanDian MCP returned an unsupported content block.",
    );
  }
  return parseJsonText(block.text, maximumBytes);
}

function businessEnvelope(payload: unknown): Record<string, unknown> {
  if (!isPlainObject(payload)) {
    throw adapterError("response_invalid", "YuanDian MCP payload is invalid.");
  }
  // The live MCP service can wrap the documented REST-shaped envelope in
  // structuredContent.data. In particular, law search has been observed as
  // structuredContent.data.extra.fatiao.
  if (
    isPlainObject(payload.data) &&
    (Object.hasOwn(payload.data, "extra") ||
      Object.hasOwn(payload.data, "code") ||
      Object.hasOwn(payload.data, "status"))
  ) {
    return payload.data;
  }
  return payload;
}

function assertBusinessSuccess(envelope: Record<string, unknown>) {
  const hasCode = Object.hasOwn(envelope, "code");
  const hasStatus = Object.hasOwn(envelope, "status");
  if (!hasCode && !hasStatus) {
    throw adapterError(
      "response_invalid",
      "YuanDian MCP business status is missing.",
    );
  }
  if (hasCode) {
    if (typeof envelope.code !== "number" || !Number.isInteger(envelope.code)) {
      throw adapterError(
        "response_invalid",
        "YuanDian MCP business status is invalid.",
      );
    }
    if (envelope.code !== 200 && envelope.code !== 201) {
      throw adapterError(
        "transport_error",
        "YuanDian MCP returned an unsuccessful business status.",
      );
    }
  }
  if (hasStatus && envelope.status !== "success" && envelope.status !== true) {
    throw adapterError(
      "transport_error",
      "YuanDian MCP returned an unsuccessful business status.",
    );
  }
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw adapterError("response_invalid", `${label} is invalid.`);
  }
  return value.trim();
}

function optionalString(
  value: unknown,
  label: string,
  maximum: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedString(value, label, maximum);
}

function providerId(value: unknown, label: string) {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : value;
  let id: string;
  try {
    id = boundedString(normalized, label, 256);
  } catch {
    const stringValue = typeof value === "string" ? value : null;
    throw adapterError(
      "response_invalid",
      `${label} is invalid (${Array.isArray(value) ? "array" : value === null ? "null" : typeof value}, length=${stringValue?.length ?? -1}, trimmed=${stringValue === null ? false : stringValue !== stringValue.trim()}).`,
    );
  }
  if (!PROVIDER_ID.test(id)) {
    throw adapterError(
      "response_invalid",
      `${label} is invalid (length=${id.length}, dot=${id.includes(".")}, slash=${id.includes("/")}, colon=${id.includes(":")}, whitespace=${/\s/u.test(id)}, nonAscii=${/[^\x20-\x7e]/u.test(id)}).`,
    );
  }
  return id;
}

function optionalProviderId(value: unknown, label: string) {
  if (value === undefined || value === null || value === "") return undefined;
  return providerId(value, label);
}

function sourceId(kind: "ftid" | "fgid" | "case", id: string) {
  return `yuandian:${kind}:${id}`;
}

function parseSourceId(value: unknown) {
  if (typeof value !== "string" || value.length > 280) {
    throw adapterError(
      "policy_violation",
      "YuanDian provider source id is invalid.",
    );
  }
  const match =
    /^yuandian:(ftid|fgid|case):([A-Za-z0-9][A-Za-z0-9_-]{0,255})$/.exec(value);
  if (!match) {
    throw adapterError(
      "policy_violation",
      "YuanDian provider source id is invalid.",
    );
  }
  const kind = match[1];
  const id = match[2]!;
  if (kind === "ftid") return { kind, id } as const;
  if (kind === "fgid") return { kind, id } as const;
  return { kind: "case", id } as const;
}

function validDateParts(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function optionalDate(value: unknown, label: string): string | undefined {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === 99999999 ||
    value === "99999999"
  ) {
    return undefined;
  }
  const raw = typeof value === "number" ? String(value) : value;
  if (typeof raw !== "string") {
    throw adapterError("response_invalid", `${label} is invalid.`);
  }
  const match =
    /^(\d{4})(\d{2})(\d{2})$/.exec(raw.trim()) ??
    /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim()) ??
    /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(raw.trim());
  if (!match) throw adapterError("response_invalid", `${label} is invalid.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!validDateParts(year, month, day)) {
    throw adapterError("response_invalid", `${label} is invalid.`);
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function summary(value: unknown) {
  const content = optionalString(value, "YuanDian search summary", 20_000);
  if (!content) return undefined;
  return content.length <= 2_000 ? content : `${content.slice(0, 1_999)}…`;
}

function lawSourceType(
  authority: unknown,
): YuanDianMcpSearchItem["sourceType"] {
  const value =
    optionalString(authority, "YuanDian authority level", 160) ?? "";
  if (/司法解释/u.test(value)) return "judicial_interpretation";
  if (/指导|规范性文件/u.test(value)) return "guidance";
  if (/法律/u.test(value)) return "statute";
  return "regulation";
}

function resultArray(
  envelope: Record<string, unknown>,
  key: "fatiao" | "wenshu",
  maximum: number,
) {
  assertBusinessSuccess(envelope);
  if (!isPlainObject(envelope.extra) || !Array.isArray(envelope.extra[key])) {
    throw adapterError(
      "response_invalid",
      "YuanDian MCP search result list is invalid.",
    );
  }
  if (envelope.extra[key].length > maximum) {
    throw adapterError(
      "response_invalid",
      "YuanDian MCP returned too many search results.",
    );
  }
  return envelope.extra[key];
}

function parseLawResults(payload: unknown, maximum: number) {
  return resultArray(businessEnvelope(payload), "fatiao", maximum).map(
    (value): YuanDianMcpSearchItem => {
      if (!isPlainObject(value)) {
        throw adapterError(
          "response_invalid",
          "YuanDian MCP law-search item is invalid.",
        );
      }
      const ftid = optionalProviderId(value.ftid, "YuanDian article id");
      const fgid = optionalProviderId(value.fgid, "YuanDian regulation id");
      if (!ftid && !fgid) {
        throw adapterError(
          "response_invalid",
          "YuanDian law-search item has no legal source id.",
        );
      }
      const title = boundedString(value.fgtitle, "YuanDian law title", 500);
      const article = optionalString(value.num, "YuanDian article number", 160);
      return {
        providerSourceId: ftid
          ? sourceId("ftid", ftid)
          : sourceId("fgid", fgid!),
        title: article ? `${title}${article}`.slice(0, 500) : title,
        sourceType: lawSourceType(value.effect1 ?? value.effect2),
        ...(optionalString(
          value.location ?? value.dy,
          "YuanDian jurisdiction",
          160,
        )
          ? {
              jurisdiction: optionalString(
                value.location ?? value.dy,
                "YuanDian jurisdiction",
                160,
              ),
            }
          : {}),
        ...(optionalDate(value.start, "YuanDian effective date")
          ? {
              effectiveDate: optionalDate(
                value.start,
                "YuanDian effective date",
              ),
            }
          : {}),
        ...(optionalString(value.sxx, "YuanDian validity status", 160)
          ? {
              status: optionalString(
                value.sxx,
                "YuanDian validity status",
                160,
              ),
            }
          : {}),
        ...(summary(value.content) ? { summary: summary(value.content) } : {}),
      };
    },
  );
}

function parseCaseResults(payload: unknown, maximum: number) {
  return resultArray(businessEnvelope(payload), "wenshu", maximum).map(
    (value): YuanDianMcpSearchItem => {
      if (!isPlainObject(value)) {
        throw adapterError(
          "response_invalid",
          "YuanDian MCP case-search item is invalid.",
        );
      }
      const id = providerId(value.scid, "YuanDian case id");
      const court = optionalString(value.jbdw, "YuanDian court", 300);
      const caseNumber = optionalString(value.ah, "YuanDian case number", 300);
      const judgmentDate = optionalDate(value.jaDate, "YuanDian judgment date");
      return {
        providerSourceId: sourceId("case", id),
        title: boundedString(value.title, "YuanDian case title", 500),
        sourceType: "case",
        ...(court ? { court } : {}),
        ...(caseNumber ? { caseNumber } : {}),
        ...(judgmentDate ? { effectiveDate: judgmentDate } : {}),
        ...(optionalString(value.xzqh_p, "YuanDian jurisdiction", 160)
          ? {
              jurisdiction: optionalString(
                value.xzqh_p,
                "YuanDian jurisdiction",
                160,
              ),
            }
          : {}),
        ...(summary(value.content) ? { summary: summary(value.content) } : {}),
      };
    },
  );
}

function detailData(payload: unknown): unknown {
  const envelope = businessEnvelope(payload);
  assertBusinessSuccess(envelope);
  if (!Object.hasOwn(envelope, "data")) {
    throw adapterError(
      "response_invalid",
      "YuanDian MCP detail data is missing.",
    );
  }
  return envelope.data;
}

function sourceContent(value: unknown) {
  const content = boundedString(
    value,
    "YuanDian source content",
    MAX_STRING_BYTES,
  );
  if (Buffer.byteLength(content, "utf8") > MAX_SOURCE_CONTENT_BYTES) {
    throw adapterError(
      "response_invalid",
      "YuanDian source content exceeded the byte limit.",
    );
  }
  return content;
}

function parseLawDetail(
  payload: unknown,
  expected: { kind: "ftid" | "fgid"; id: string },
): YuanDianMcpSourceDocument {
  const data = detailData(payload);
  if (!isPlainObject(data)) {
    throw adapterError(
      "response_invalid",
      "YuanDian MCP law detail is invalid.",
    );
  }
  const returnedId = providerId(
    expected.kind === "ftid" ? data.id : (data.fgid ?? data.id),
    "YuanDian law detail id",
  );
  if (returnedId !== expected.id) {
    throw adapterError(
      "response_invalid",
      "YuanDian MCP law detail id does not match.",
    );
  }
  const article = optionalString(data.ft_num, "YuanDian article number", 160);
  const effectiveDate = optionalDate(data.ssrq, "YuanDian effective date");
  const publicationDate = optionalDate(data.fbrq, "YuanDian publication date");
  const status = optionalString(data.sxx, "YuanDian validity status", 160);
  return {
    providerSourceId: sourceId(expected.kind, expected.id),
    title: boundedString(data.title ?? data.fgmc, "YuanDian law title", 500),
    sourceType: lawSourceType(data.xljb_1 ?? data.xljb_2),
    content: sourceContent(data.content),
    metadata: {
      ...(effectiveDate ? { effectiveDate } : {}),
      ...(publicationDate ? { publicationDate } : {}),
      ...(status ? { status } : {}),
    },
    locator: article ? { article } : {},
  };
}

function parseCaseDetail(
  payload: unknown,
  expectedId: string,
): YuanDianMcpSourceDocument {
  const raw = detailData(payload);
  const items = Array.isArray(raw) ? raw : [raw];
  if (items.length < 1 || items.length > 10) {
    throw adapterError(
      "response_invalid",
      "YuanDian MCP case detail is invalid.",
    );
  }
  const matches = items.filter(
    (item) => isPlainObject(item) && item.id === expectedId,
  );
  if (matches.length !== 1 || !isPlainObject(matches[0])) {
    throw adapterError(
      "response_invalid",
      "YuanDian MCP case detail id does not uniquely match.",
    );
  }
  const data = matches[0];
  const court = optionalString(data.jbdw, "YuanDian court", 300);
  const caseNumber = optionalString(data.ah, "YuanDian case number", 300);
  const judgmentDate = optionalDate(data.cprq, "YuanDian judgment date");
  return {
    providerSourceId: sourceId("case", expectedId),
    title: boundedString(data.title, "YuanDian case title", 500),
    sourceType: "case",
    content: sourceContent(data.content),
    metadata: {
      ...(court ? { court } : {}),
      ...(caseNumber ? { caseNumber } : {}),
      ...(judgmentDate ? { effectiveDate: judgmentDate } : {}),
    },
    locator: {},
  };
}

function validateSearchRequest(
  request: YuanDianMcpSearchRequest,
  configuredMaximum: number,
) {
  exactObject(
    request,
    ["query", "sourceTypes", "limit"],
    "YuanDian MCP search request",
    "policy_violation",
  );
  if (
    typeof request.query !== "string" ||
    !request.query.trim() ||
    request.query.length > MAX_QUERY_LENGTH
  ) {
    throw adapterError(
      "policy_violation",
      "YuanDian MCP search query is invalid.",
    );
  }
  const allowedTypes = new Set([
    "statute",
    "regulation",
    "judicial_interpretation",
    "case",
    "guidance",
  ]);
  if (
    request.sourceTypes !== undefined &&
    (!Array.isArray(request.sourceTypes) ||
      request.sourceTypes.length > 5 ||
      new Set(request.sourceTypes).size !== request.sourceTypes.length ||
      request.sourceTypes.some((kind) => !allowedTypes.has(kind)))
  ) {
    throw adapterError(
      "policy_violation",
      "YuanDian MCP source types are invalid.",
    );
  }
  const limit = request.limit ?? Math.min(10, configuredMaximum);
  if (!Number.isInteger(limit) || limit < 1 || limit > configuredMaximum) {
    throw adapterError(
      "policy_violation",
      "YuanDian MCP search limit is invalid.",
    );
  }
  const query = request.query.trim();
  const requestBytes = Buffer.byteLength(
    JSON.stringify({ query, limit }),
    "utf8",
  );
  if (requestBytes > MAX_REQUEST_BYTES) {
    throw adapterError(
      "policy_violation",
      "YuanDian MCP search request exceeded the byte limit.",
    );
  }
  return { query, limit, sourceTypes: request.sourceTypes };
}

function queryId(query: string) {
  return `yuandian:${createHash("sha256").update(query, "utf8").digest("hex")}`;
}

export class WorkspaceYuanDianMcpAdapter {
  private readonly config: ValidatedConfig;
  private readonly fetch: typeof globalThis.fetch;
  private readonly createClient: NonNullable<
    YuanDianMcpAdapterDeps["createClient"]
  >;

  constructor(
    config: YuanDianMcpAdapterConfig,
    private readonly deps: YuanDianMcpAdapterDeps,
  ) {
    this.config = validateConfig(config);
    if (!deps || typeof deps.resolveCredential !== "function") {
      throw adapterError(
        "configuration_error",
        "YuanDian MCP credential resolver is required.",
      );
    }
    this.fetch = deps.fetch ?? globalThis.fetch;
    this.createClient = deps.createClient ?? sdkClientFactory;
  }

  private async callTool(
    capability: YuanDianLegalCapability,
    name: YuanDianLegalTool,
    args: Record<string, unknown>,
    callerSignal: AbortSignal,
  ) {
    const allowed = YUANDIAN_MCP_LEGAL_TOOL_ALLOWLIST[
      capability
    ] as readonly string[];
    if (!allowed.includes(name)) {
      throw adapterError(
        "policy_violation",
        "YuanDian MCP tool is not in the legal-authority allowlist.",
      );
    }
    if (Buffer.byteLength(JSON.stringify(args), "utf8") > MAX_REQUEST_BYTES) {
      throw adapterError(
        "policy_violation",
        "YuanDian MCP tool input exceeded the byte limit.",
      );
    }
    return withDeadline(callerSignal, this.config.timeoutMs, async (signal) => {
      let session: YuanDianMcpClientSession | undefined;
      try {
        const token = validateBearerToken(
          await this.deps.resolveCredential(this.config.credentialRef, signal),
        );
        if (signal.aborted) throw abortError();
        const endpoint = validateYuanDianMcpEndpoint(
          capability,
          YUANDIAN_MCP_ENDPOINTS[capability],
        );
        session = await this.createClient({
          capability,
          endpoint,
          authorizationHeader: `Bearer ${token}`,
          fetch: this.fetch,
          maxResponseBytes: this.config.maxResponseBytes,
        });
        if (signal.aborted) throw abortError();
        const options = {
          signal,
          timeout: this.config.timeoutMs,
          maxTotalTimeout: this.config.timeoutMs,
        };
        await session.connect(options);
        if (signal.aborted) throw abortError();
        const result = await session.callTool(
          { name, arguments: args },
          options,
        );
        return toolPayload(result, this.config.maxResponseBytes);
      } catch (error) {
        if (error instanceof YuanDianMcpAdapterError) throw error;
        if (signal.aborted) throw abortError();
        throw adapterError("transport_error", "YuanDian MCP transport failed.");
      } finally {
        if (session) await closeSession(session, this.config.timeoutMs);
      }
    });
  }

  async search(
    request: YuanDianMcpSearchRequest,
    signal: AbortSignal,
  ): Promise<YuanDianMcpSearchResponse> {
    const validated = validateSearchRequest(request, this.config.maxResults);
    if (signal.aborted) throw abortError();
    const requested = new Set(validated.sourceTypes ?? []);
    const searchLaw =
      requested.size === 0 || [...requested].some((kind) => kind !== "case");
    const searchCase = requested.size === 0 || requested.has("case");
    const operations: Promise<YuanDianMcpSearchItem[]>[] = [];
    if (searchLaw) {
      operations.push(
        this.callTool(
          "law",
          "yuandian_law_vector_search",
          {
            query: validated.query,
            rewrite_flag: false,
            return_num: validated.limit,
          },
          signal,
        ).then((payload) => parseLawResults(payload, validated.limit)),
      );
    }
    if (searchCase) {
      operations.push(
        this.callTool(
          "case",
          "yuandian_case_vector_search",
          {
            query: validated.query,
            rewrite_flag: false,
            wenshu_filter: { dianxing: false },
            return_num: validated.limit,
          },
          signal,
        ).then((payload) => parseCaseResults(payload, validated.limit)),
      );
    }
    const results = (await Promise.all(operations)).flat();
    if (signal.aborted) throw abortError();
    const filtered =
      requested.size === 0
        ? results
        : results.filter((result) => requested.has(result.sourceType));
    return {
      queryId: queryId(validated.query),
      results: filtered.slice(0, validated.limit),
    };
  }

  async readSource(
    providerSourceId: string,
    signal: AbortSignal,
  ): Promise<YuanDianMcpSourceDocument> {
    const parsed = parseSourceId(providerSourceId);
    if (signal.aborted) throw abortError();
    if (parsed.kind === "ftid") {
      return parseLawDetail(
        await this.callTool(
          "law",
          "yuandian_rh_ft_detail",
          { id: parsed.id },
          signal,
        ),
        parsed,
      );
    }
    if (parsed.kind === "fgid") {
      return parseLawDetail(
        await this.callTool(
          "law",
          "yuandian_rh_fg_detail",
          { id: parsed.id },
          signal,
        ),
        parsed,
      );
    }
    return parseCaseDetail(
      await this.callTool(
        "case",
        "yuandian_rh_case_details",
        { id: parsed.id },
        signal,
      ),
      parsed.id,
    );
  }
}
