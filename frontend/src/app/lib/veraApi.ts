import {
  buildVeraApiUrl,
  getVeraAuthorizationHeaders,
  veraApiPathFromWireUrl,
  VeraRuntimeConfigurationError,
  type VeraQuery,
} from "./veraRuntime";
import type {
  VeraApiErrorWire,
  VeraDocumentReadWire,
  VeraDocumentVersionsWire,
  VeraDocumentWire,
  VeraDownloadCapabilityWire,
  VeraFolderCreateWire,
  VeraFolderUpdateWire,
  VeraFolderWire,
  VeraProjectCreateWire,
  VeraProjectUpdateWire,
  VeraProjectWire,
} from "./veraWireTypes";

const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;

export class VeraApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryable: boolean;

  constructor(args: {
    message: string;
    status: number;
    code?: string | null;
    retryable?: boolean;
  }) {
    super(args.message);
    this.name = "VeraApiError";
    this.status = args.status;
    this.code = args.code ?? null;
    this.retryable = args.retryable ?? false;
  }
}

export interface VeraApiRequestOptions
  extends Omit<
    RequestInit,
    | "body"
    | "cache"
    | "credentials"
    | "headers"
    | "redirect"
    | "referrerPolicy"
  > {
  query?: VeraQuery;
  headers?: HeadersInit;
  json?: unknown;
  body?: BodyInit | null;
}

export interface VeraBlobResponse {
  blob: Blob;
  filename: string | null;
}

function safeHeaderEntries(input?: HeadersInit): Headers {
  const headers = new Headers(input);
  for (const forbidden of [
    "authorization",
    "cookie",
    "host",
    "origin",
    "proxy-authorization",
  ]) {
    if (headers.has(forbidden)) {
      throw new VeraRuntimeConfigurationError(
        `The ${forbidden} header is managed by Vera.`,
      );
    }
  }
  return headers;
}

function requestBody(
  options: VeraApiRequestOptions,
  headers: Headers,
): BodyInit | null | undefined {
  if (options.json !== undefined && options.body !== undefined) {
    throw new VeraRuntimeConfigurationError(
      "A Vera request cannot include both json and body.",
    );
  }
  if (options.json !== undefined) {
    if (headers.has("content-type")) {
      throw new VeraRuntimeConfigurationError(
        "Vera manages the JSON content type.",
      );
    }
    headers.set("Content-Type", "application/json");
    try {
      const serialized = JSON.stringify(options.json);
      if (serialized === undefined) throw new Error("not serializable");
      return serialized;
    } catch {
      throw new VeraRuntimeConfigurationError(
        "The Vera JSON request body is invalid.",
      );
    }
  }
  return options.body;
}

function nativeRequestInit(options: VeraApiRequestOptions): RequestInit {
  const init = { ...options };
  delete init.query;
  delete init.headers;
  delete init.json;
  delete init.body;
  return init;
}

export async function veraApiFetch(
  path: string,
  options: VeraApiRequestOptions = {},
): Promise<Response> {
  const { query, headers: inputHeaders } = options;
  const init = nativeRequestInit(options);
  const [url, authHeaders] = await Promise.all([
    buildVeraApiUrl(path, query),
    getVeraAuthorizationHeaders(),
  ]);
  const headers = safeHeaderEntries(inputHeaders);
  for (const [name, value] of Object.entries(authHeaders)) {
    headers.set(name, value);
  }
  if (!headers.has("accept")) headers.set("Accept", "application/json");
  const body = requestBody(options, headers);
  const method = (options.method ?? "GET").toUpperCase();
  if ((method === "GET" || method === "HEAD") && body != null) {
    throw new VeraRuntimeConfigurationError(
      `${method} Vera requests cannot include a body.`,
    );
  }

  return fetch(url, {
    ...init,
    method,
    body,
    headers,
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
}

async function readBoundedText(
  response: Response,
  limit: number,
): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let output = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The original decoding/read failure is the useful signal.
    }
    return null;
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

export async function veraApiErrorFromResponse(
  response: Response,
): Promise<VeraApiError> {
  const fallback = `Vera API request failed with status ${response.status}.`;
  const text = await readBoundedText(response, MAX_ERROR_BYTES);
  if (text === null) {
    return new VeraApiError({ status: response.status, message: fallback });
  }

  let payload: VeraApiErrorWire;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    payload = parsed as VeraApiErrorWire;
  } catch {
    return new VeraApiError({ status: response.status, message: fallback });
  }

  const nested =
    typeof payload.error === "object" && payload.error !== null
      ? payload.error
      : undefined;
  const detail = nonEmptyString(payload.detail);
  const nestedMessage = nonEmptyString(nested?.message);
  const topCode = nonEmptyString(payload.code);
  const nestedCode = nonEmptyString(nested?.code);

  return new VeraApiError({
    status: response.status,
    code: topCode ?? nestedCode,
    message: detail ?? nestedMessage ?? fallback,
    retryable: nested?.retryable === true,
  });
}

function responseHasNoBody(response: Response): boolean {
  return (
    response.status === 204 ||
    response.status === 205 ||
    response.headers.get("content-length") === "0"
  );
}

export async function veraApiRequest<T>(
  path: string,
  options: VeraApiRequestOptions = {},
): Promise<T> {
  const response = await veraApiFetch(path, options);
  if (!response.ok) throw await veraApiErrorFromResponse(response);
  if (responseHasNoBody(response)) return undefined as T;

  const contentType = response.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new VeraApiError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: "The Vera API returned an invalid response.",
    });
  }
  const text = await readBoundedText(response, MAX_JSON_BYTES);
  if (text === null || text.length === 0) {
    throw new VeraApiError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: "The Vera API returned an invalid response.",
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new VeraApiError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: "The Vera API returned invalid JSON.",
    });
  }
}

function safeDownloadFilename(response: Response): string | null {
  const disposition = response.headers.get("content-disposition") ?? "";
  const encoded = disposition.match(/(?:^|;)\s*filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = disposition.match(/(?:^|;)\s*filename="([^"]*)"/i)?.[1];
  let value: string | undefined;
  if (encoded) {
    try {
      value = decodeURIComponent(encoded);
    } catch {
      return null;
    }
  } else {
    value = plain;
  }
  if (
    !value ||
    value.length > 500 ||
    /[\u0000-\u001f\u007f\\/]/.test(value) ||
    value === "." ||
    value === ".."
  ) {
    return null;
  }
  return value;
}

export async function veraApiBlobRequest(
  path: string,
  options: VeraApiRequestOptions = {},
): Promise<VeraBlobResponse> {
  const headers = new Headers(options.headers);
  if (!headers.has("accept")) headers.set("Accept", "application/octet-stream");
  const response = await veraApiFetch(path, { ...options, headers });
  if (!response.ok) throw await veraApiErrorFromResponse(response);
  if (responseHasNoBody(response)) {
    throw new VeraApiError({
      status: response.status,
      code: "INVALID_RESPONSE",
      message: "The Vera API returned an empty download.",
    });
  }
  return {
    blob: await response.blob(),
    filename: safeDownloadFilename(response),
  };
}

function safeId(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new VeraRuntimeConfigurationError(`The Vera ${label} is invalid.`);
  }
  return value;
}

export interface VeraPageQuery {
  cursor?: string;
  limit?: number;
}

export interface VeraDocumentListQuery extends VeraPageQuery {
  project_id?: string | null;
  folder_id?: string | null;
  status?: "pending" | "processing" | "ready" | "error";
}

function toPageQuery(page: VeraPageQuery): VeraQuery {
  return { cursor: page.cursor, limit: page.limit };
}

function toDocumentQuery(filters: VeraDocumentListQuery): VeraQuery {
  return {
    ...toPageQuery(filters),
    project_id:
      typeof filters.project_id === "string"
        ? safeId(filters.project_id, "project id")
        : filters.project_id,
    folder_id:
      typeof filters.folder_id === "string"
        ? safeId(filters.folder_id, "folder id")
        : filters.folder_id,
    status: filters.status,
  };
}

// Mike-compatible project/folder/document vertical. Additional product APIs
// build on the same primitives without modifying the legacy Aletheia client.
export function listVeraProjects(
  page: VeraPageQuery = {},
  signal?: AbortSignal,
): Promise<VeraProjectWire[]> {
  return veraApiRequest("/projects", { query: toPageQuery(page), signal });
}

export function createVeraProject(
  input: VeraProjectCreateWire,
  signal?: AbortSignal,
): Promise<VeraProjectWire> {
  return veraApiRequest("/projects", { method: "POST", json: input, signal });
}

export function getVeraProject(
  projectId: string,
  signal?: AbortSignal,
): Promise<VeraProjectWire> {
  return veraApiRequest(`/projects/${safeId(projectId, "project id")}`, {
    signal,
  });
}

export function updateVeraProject(
  projectId: string,
  input: VeraProjectUpdateWire,
  signal?: AbortSignal,
): Promise<VeraProjectWire> {
  return veraApiRequest(`/projects/${safeId(projectId, "project id")}`, {
    method: "PATCH",
    json: input,
    signal,
  });
}

export function archiveVeraProject(
  projectId: string,
  signal?: AbortSignal,
): Promise<VeraProjectWire> {
  return veraApiRequest(
    `/projects/${safeId(projectId, "project id")}/archive`,
    { method: "POST", signal },
  );
}

export function unarchiveVeraProject(
  projectId: string,
  signal?: AbortSignal,
): Promise<VeraProjectWire> {
  return veraApiRequest(
    `/projects/${safeId(projectId, "project id")}/unarchive`,
    { method: "POST", signal },
  );
}

export function deleteVeraProject(
  projectId: string,
  confirmName: string,
  signal?: AbortSignal,
): Promise<void> {
  return veraApiRequest(`/projects/${safeId(projectId, "project id")}`, {
    method: "DELETE",
    json: { confirm_name: confirmName },
    signal,
  });
}

export function listVeraProjectFolders(
  projectId: string,
  page: VeraPageQuery = {},
  signal?: AbortSignal,
): Promise<VeraFolderWire[]> {
  return veraApiRequest(
    `/projects/${safeId(projectId, "project id")}/folders`,
    { query: toPageQuery(page), signal },
  );
}

export function createVeraProjectFolder(
  projectId: string,
  input: VeraFolderCreateWire,
  signal?: AbortSignal,
): Promise<VeraFolderWire> {
  return veraApiRequest(
    `/projects/${safeId(projectId, "project id")}/folders`,
    { method: "POST", json: input, signal },
  );
}

export function updateVeraProjectFolder(
  projectId: string,
  folderId: string,
  input: VeraFolderUpdateWire,
  signal?: AbortSignal,
): Promise<VeraFolderWire> {
  return veraApiRequest(
    `/projects/${safeId(projectId, "project id")}/folders/${safeId(folderId, "folder id")}`,
    { method: "PATCH", json: input, signal },
  );
}

export function deleteVeraProjectFolder(
  projectId: string,
  folderId: string,
  signal?: AbortSignal,
): Promise<void> {
  return veraApiRequest(
    `/projects/${safeId(projectId, "project id")}/folders/${safeId(folderId, "folder id")}`,
    { method: "DELETE", signal },
  );
}

export function listVeraProjectDocuments(
  projectId: string,
  page: VeraPageQuery = {},
  signal?: AbortSignal,
): Promise<VeraDocumentWire[]> {
  return veraApiRequest(
    `/projects/${safeId(projectId, "project id")}/documents`,
    { query: toPageQuery(page), signal },
  );
}

export function attachVeraProjectDocument(
  projectId: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<VeraDocumentWire> {
  return veraApiRequest(
    `/projects/${safeId(projectId, "project id")}/documents/${safeId(documentId, "document id")}`,
    { method: "POST", signal },
  );
}

export function renameVeraProjectDocument(
  projectId: string,
  documentId: string,
  filename: string,
  signal?: AbortSignal,
): Promise<VeraDocumentWire> {
  return veraApiRequest(
    `/projects/${safeId(projectId, "project id")}/documents/${safeId(documentId, "document id")}`,
    { method: "PATCH", json: { filename }, signal },
  );
}

export function moveVeraProjectDocument(
  projectId: string,
  documentId: string,
  folderId: string | null,
  signal?: AbortSignal,
): Promise<VeraDocumentWire> {
  return veraApiRequest(
    `/projects/${safeId(projectId, "project id")}/documents/${safeId(documentId, "document id")}/folder`,
    {
      method: "PATCH",
      json: {
        folder_id:
          folderId === null ? null : safeId(folderId, "folder id"),
      },
      signal,
    },
  );
}

export function listVeraDocuments(
  filters: VeraDocumentListQuery = {},
  signal?: AbortSignal,
): Promise<VeraDocumentWire[]> {
  return veraApiRequest("/documents", {
    query: toDocumentQuery(filters),
    signal,
  });
}

export function listVeraStandaloneDocuments(
  filters: Pick<VeraDocumentListQuery, "cursor" | "limit" | "status"> = {},
  signal?: AbortSignal,
): Promise<VeraDocumentWire[]> {
  return veraApiRequest("/single-documents", {
    query: {
      cursor: filters.cursor,
      limit: filters.limit,
      status: filters.status,
    },
    signal,
  });
}

export function getVeraDocument(
  documentId: string,
  signal?: AbortSignal,
): Promise<VeraDocumentWire> {
  return veraApiRequest(`/documents/${safeId(documentId, "document id")}`, {
    signal,
  });
}

export function listVeraDocumentVersions(
  documentId: string,
  signal?: AbortSignal,
): Promise<VeraDocumentVersionsWire> {
  return veraApiRequest(
    `/documents/${safeId(documentId, "document id")}/versions`,
    { signal },
  );
}

export function readVeraDocument(
  documentId: string,
  versionId?: string,
  signal?: AbortSignal,
): Promise<VeraDocumentReadWire> {
  return veraApiRequest(
    `/documents/${safeId(documentId, "document id")}/read`,
    {
      query: versionId
        ? { version_id: safeId(versionId, "version id") }
        : {},
      signal,
    },
  );
}

export function getVeraDocumentDownloadCapability(
  documentId: string,
  versionId?: string,
  signal?: AbortSignal,
): Promise<VeraDownloadCapabilityWire> {
  return veraApiRequest(
    `/documents/${safeId(documentId, "document id")}/url`,
    {
      query: versionId
        ? { version_id: safeId(versionId, "version id") }
        : {},
      signal,
    },
  );
}

export function getVeraDocumentVersionFileCapability(
  documentId: string,
  versionId: string,
  signal?: AbortSignal,
): Promise<VeraDownloadCapabilityWire> {
  return veraApiRequest(
    `/documents/${safeId(documentId, "document id")}/versions/${safeId(versionId, "version id")}/file`,
    { signal },
  );
}

/** Authenticated inline preview bytes; unlike `/read`, this is never JSON text. */
export function displayVeraDocument(
  documentId: string,
  versionId?: string,
  signal?: AbortSignal,
): Promise<VeraBlobResponse> {
  return veraApiBlobRequest(
    `/documents/${safeId(documentId, "document id")}/display`,
    {
      query: versionId
        ? { version_id: safeId(versionId, "version id") }
        : {},
      signal,
    },
  );
}

export function downloadVeraCapability(
  capability: VeraDownloadCapabilityWire,
  signal?: AbortSignal,
): Promise<VeraBlobResponse> {
  return veraApiBlobRequest(
    veraApiPathFromWireUrl(capability.download_url ?? capability.url),
    { signal },
  );
}
