import {
  veraApiBlobRequest,
  veraApiRequest,
  VeraApiError,
} from "./veraApi";
import { VeraRuntimeConfigurationError } from "./veraRuntime";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_STUDIO_CONTENT_LENGTH = 2_000_000;
const MAX_STUDIO_CONTENT_BYTES = 4_000_000;
const MAX_CITATION_ANCHORS = 200;
const MAX_STUDIO_DOCX_BYTES = 10 * 1024 * 1024;
export const VERA_STUDIO_DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const VERA_STUDIO_DOCX_WARNING_CODES = [
  "DOCX_IMAGES_IGNORED",
  "DOCX_FORMATTING_SIMPLIFIED",
  "DOCX_CONVERTER_WARNING",
  "MARKDOWN_IMAGES_OMITTED",
  "MARKDOWN_HTML_AS_TEXT",
  "MARKDOWN_BLOCKQUOTE_SIMPLIFIED",
] as const;
export type VeraStudioDocxWarningCode =
  (typeof VERA_STUDIO_DOCX_WARNING_CODES)[number];
const STUDIO_DOCX_WARNING_CODE_SET = new Set<string>(
  VERA_STUDIO_DOCX_WARNING_CODES,
);
const STUDIO_VERSION_SOURCES = new Set([
  "user_upload",
  "assistant_edit",
] as const);

export type VeraStudioVersionSourceWire =
  | "user_upload"
  | "assistant_edit";

export interface VeraStudioVersionWire {
  id: string;
  version_number: number;
  source: VeraStudioVersionSourceWire;
  filename: string;
  mime_type: "text/markdown";
  size_bytes: number;
  content_sha256: string;
  created_at: string;
  citation_anchor_ids: string[];
}

export interface VeraStudioCitationAnchorWire {
  id: string;
  snapshot_id: string;
  ordinal: number;
  exact_quote: string;
  quote_sha256: string;
  locator: Readonly<Record<string, unknown>>;
}

export interface VeraStudioCapabilitiesWire {
  docx_import: true;
  docx_export: true;
}

export interface VeraStudioDocumentWire {
  document_id: string;
  project_id: string;
  title: string;
  filename: string;
  format: "markdown";
  current_version_id: string;
  version: VeraStudioVersionWire;
  content: string;
  citation_anchors: VeraStudioCitationAnchorWire[];
  capabilities: VeraStudioCapabilitiesWire;
}

export interface VeraStudioVersionListItemWire {
  id: string;
  version_number: number;
  source: VeraStudioVersionSourceWire;
  filename: string;
  mime_type: string;
  size_bytes: number;
  content_sha256: string;
  created_at: string;
  citation_anchor_ids: string[];
}

export interface VeraStudioVersionsWire {
  current_version_id: string;
  versions: VeraStudioVersionListItemWire[];
}

export interface CreateVeraStudioDocumentInput {
  title: string;
  folder_id?: string | null;
}

export interface SaveVeraStudioDocumentInput {
  expected_version_id: string;
  content: string;
  source: "user_upload" | "assistant_edit";
  citation_anchor_ids?: string[];
  summary?: string | null;
}

export interface RestoreVeraStudioVersionInput {
  expected_current_version_id: string;
}

export interface VeraStudioDocxImportWire {
  document: VeraStudioDocumentWire;
  warnings: VeraStudioDocxWarningCode[];
}

export interface VeraStudioDocxDownload {
  blob: Blob;
  filename: string;
  warningCodes: VeraStudioDocxWarningCode[];
}

function invalidWire(label: string): never {
  throw new VeraApiError({
    status: 200,
    code: "INVALID_RESPONSE",
    message: `The Vera API returned an invalid ${label}.`,
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidWire(label);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) invalidWire(label);
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    (!allowEmpty && value.length === 0) ||
    value.includes("\0")
  ) {
    return invalidWire(label);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  const id = boundedString(value, label, 36);
  if (!UUID_PATTERN.test(id)) invalidWire(label);
  return id;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalidWire(label);
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalidWire(label);
  return Number(value);
}

function trueCapability(value: unknown, label: string): true {
  if (value !== true) invalidWire(label);
  return true;
}

function docxWarningCodes(
  value: unknown,
  label: string,
): VeraStudioDocxWarningCode[] {
  if (
    !Array.isArray(value) ||
    value.length > VERA_STUDIO_DOCX_WARNING_CODES.length
  ) {
    invalidWire(label);
  }
  const codes = value.map((code) => {
    if (typeof code !== "string" || !STUDIO_DOCX_WARNING_CODE_SET.has(code)) {
      invalidWire(label);
    }
    return code as VeraStudioDocxWarningCode;
  });
  if (new Set(codes).size !== codes.length) invalidWire(label);
  return codes;
}

function sha256(value: unknown, label: string): string {
  const hash = boundedString(value, label, 64);
  if (!SHA256_PATTERN.test(hash)) invalidWire(label);
  return hash;
}

function versionSource(value: unknown): VeraStudioVersionSourceWire {
  const source = boundedString(value, "Studio version source", 80);
  if (!STUDIO_VERSION_SOURCES.has(source as VeraStudioVersionSourceWire)) {
    invalidWire("Studio version source");
  }
  return source as VeraStudioVersionSourceWire;
}

function studioMimeType(value: unknown): "text/markdown" {
  if (value !== "text/markdown") {
    invalidWire("Studio version MIME type");
  }
  return value;
}

function boundedStudioSize(value: unknown): number {
  const size = nonNegativeInteger(value, "Studio version size");
  if (size > MAX_STUDIO_CONTENT_BYTES) invalidWire("Studio version size");
  return size;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = boundedString(value, label, 80);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      timestamp,
    ) ||
    !Number.isFinite(Date.parse(timestamp))
  ) {
    invalidWire(label);
  }
  return timestamp;
}

function studioContent(value: unknown): string {
  const content = boundedString(
    value,
    "Studio content",
    MAX_STUDIO_CONTENT_LENGTH,
    true,
  );
  if (
    new TextEncoder().encode(content).byteLength > MAX_STUDIO_CONTENT_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(
      content,
    )
  ) {
    invalidWire("Studio content");
  }
  return content;
}

function studioTitle(value: unknown): string {
  const title = boundedString(value, "Studio title", 480).trim();
  if (
    [...title].length < 1 ||
    [...title].length > 240 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(title)
  ) {
    invalidWire("Studio title");
  }
  return title;
}

function studioQuote(value: unknown): string {
  const quote = boundedString(value, "Studio citation quote", 8_000);
  if (
    !quote.trim() ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(quote)
  ) {
    invalidWire("Studio citation quote");
  }
  return quote;
}

function uuidArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_CITATION_ANCHORS) {
    return invalidWire(label);
  }
  const ids = value.map((item) => uuid(item, label));
  if (new Set(ids).size !== ids.length) invalidWire(label);
  return ids;
}

function locator(value: unknown): Readonly<Record<string, unknown>> {
  const root = record(value, "Studio citation locator");
  let nodes = 0;
  const visit = (child: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 512 || depth > 8) invalidWire("Studio citation locator");
    if (
      child === null ||
      typeof child === "boolean" ||
      (typeof child === "number" && Number.isFinite(child))
    ) {
      return;
    }
    if (typeof child === "string") {
      if (child.length > 4_000 || child.includes("\0")) {
        invalidWire("Studio citation locator");
      }
      return;
    }
    if (Array.isArray(child)) {
      if (child.length > 100) invalidWire("Studio citation locator");
      child.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!child || typeof child !== "object") {
      invalidWire("Studio citation locator");
    }
    const entries = Object.entries(child as Record<string, unknown>);
    if (entries.length > 128) invalidWire("Studio citation locator");
    for (const [key, item] of entries) {
      if (!key || key.length > 120 || key.includes("\0")) {
        invalidWire("Studio citation locator");
      }
      visit(item, depth + 1);
    }
  };
  visit(root, 0);
  return root;
}

function parseVersion(value: unknown): VeraStudioVersionWire {
  const wire = record(value, "Studio document version");
  exactKeys(
    wire,
    [
      "id",
      "version_number",
      "source",
      "filename",
      "mime_type",
      "size_bytes",
      "content_sha256",
      "created_at",
      "citation_anchor_ids",
    ],
    "Studio document version",
  );
  return {
    id: uuid(wire.id, "Studio version id"),
    version_number: positiveInteger(
      wire.version_number,
      "Studio version number",
    ),
    source: versionSource(wire.source),
    filename: boundedString(wire.filename, "Studio version filename", 240),
    mime_type: studioMimeType(wire.mime_type),
    size_bytes: boundedStudioSize(wire.size_bytes),
    content_sha256: sha256(wire.content_sha256, "Studio content digest"),
    created_at: isoTimestamp(wire.created_at, "Studio version timestamp"),
    citation_anchor_ids: uuidArray(
      wire.citation_anchor_ids,
      "Studio version citation ids",
    ),
  };
}

function parseCitationAnchor(value: unknown): VeraStudioCitationAnchorWire {
  const wire = record(value, "Studio citation anchor");
  exactKeys(
    wire,
    [
      "id",
      "snapshot_id",
      "ordinal",
      "exact_quote",
      "quote_sha256",
      "locator",
    ],
    "Studio citation anchor",
  );
  return {
    id: uuid(wire.id, "Studio citation anchor id"),
    snapshot_id: uuid(wire.snapshot_id, "Studio citation snapshot id"),
    ordinal: nonNegativeInteger(wire.ordinal, "Studio citation ordinal"),
    exact_quote: studioQuote(wire.exact_quote),
    quote_sha256: sha256(wire.quote_sha256, "Studio citation quote digest"),
    locator: locator(wire.locator),
  };
}

export function parseVeraStudioDocument(
  value: unknown,
): VeraStudioDocumentWire {
  const wire = record(value, "Studio document");
  exactKeys(
    wire,
    [
      "document_id",
      "project_id",
      "title",
      "filename",
      "format",
      "current_version_id",
      "version",
      "content",
      "citation_anchors",
      "capabilities",
    ],
    "Studio document",
  );
  if (wire.format !== "markdown") invalidWire("Studio document format");
  if (
    !Array.isArray(wire.citation_anchors) ||
    wire.citation_anchors.length > MAX_CITATION_ANCHORS
  ) {
    invalidWire("Studio citation list");
  }
  const capabilities = record(wire.capabilities, "Studio capabilities");
  exactKeys(
    capabilities,
    ["docx_import", "docx_export"],
    "Studio capabilities",
  );
  const version = parseVersion(wire.version);
  const currentVersionId = uuid(
    wire.current_version_id,
    "Studio current version id",
  );
  return {
    document_id: uuid(wire.document_id, "Studio document id"),
    project_id: uuid(wire.project_id, "Studio project id"),
    title: studioTitle(wire.title),
    filename: boundedString(wire.filename, "Studio filename", 240),
    format: "markdown",
    current_version_id: currentVersionId,
    version,
    content: studioContent(wire.content),
    citation_anchors: wire.citation_anchors.map(parseCitationAnchor),
    capabilities: {
      docx_import: trueCapability(
        capabilities.docx_import,
        "Studio DOCX import capability",
      ),
      docx_export: trueCapability(
        capabilities.docx_export,
        "Studio DOCX export capability",
      ),
    },
  };
}

function parseVersionListItem(value: unknown): VeraStudioVersionListItemWire {
  const wire = record(value, "Studio version list item");
  exactKeys(
    wire,
    [
      "id",
      "version_number",
      "source",
      "filename",
      "mime_type",
      "size_bytes",
      "content_sha256",
      "created_at",
      "citation_anchor_ids",
    ],
    "Studio version list item",
  );
  return {
    id: uuid(wire.id, "Studio version id"),
    version_number: positiveInteger(
      wire.version_number,
      "Studio version number",
    ),
    source: versionSource(wire.source),
    filename: boundedString(wire.filename, "Studio version filename", 240),
    mime_type: studioMimeType(wire.mime_type),
    size_bytes: boundedStudioSize(wire.size_bytes),
    content_sha256: sha256(wire.content_sha256, "Studio content digest"),
    created_at: isoTimestamp(wire.created_at, "Studio version timestamp"),
    citation_anchor_ids: uuidArray(
      wire.citation_anchor_ids,
      "Studio version citation ids",
    ),
  };
}

function parseCurrentVeraStudioDocument(
  value: unknown,
): VeraStudioDocumentWire {
  const document = parseVeraStudioDocument(value);
  if (document.version.id !== document.current_version_id) {
    invalidWire("Studio current version");
  }
  return document;
}

export function parseVeraStudioVersions(value: unknown): VeraStudioVersionsWire {
  const wire = record(value, "Studio version list");
  exactKeys(
    wire,
    ["current_version_id", "versions"],
    "Studio version list",
  );
  if (!Array.isArray(wire.versions) || wire.versions.length > 10_000) {
    invalidWire("Studio version list");
  }
  const currentVersionId = uuid(
    wire.current_version_id,
    "Studio current version id",
  );
  const versions = wire.versions.map(parseVersionListItem);
  if (!versions.some((version) => version.id === currentVersionId)) {
    invalidWire("Studio current version list entry");
  }
  return { current_version_id: currentVersionId, versions };
}

function safeId(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new VeraRuntimeConfigurationError(`The Vera ${label} is invalid.`);
  }
  return value;
}

function studioDocumentPath(projectId: string, documentId?: string): string {
  const root = `/projects/${safeId(projectId, "project id")}/studio/documents`;
  return documentId
    ? `${root}/${safeId(documentId, "Studio document id")}`
    : root;
}

function safeTitle(value: string): string {
  const title = value.trim();
  if (
    !title ||
    [...title].length > 240 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(title)
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Studio document title is invalid.",
    );
  }
  return title;
}

function safeSummary(value: string | null): string | null {
  if (value === null) return null;
  const summary = value.trim();
  if (
    !summary ||
    [...summary].length > 500 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(summary)
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Studio version summary is invalid.",
    );
  }
  return summary;
}

function safeDocxFile(file: File): File {
  const filename = file.name.trim();
  const mimeType = file.type.trim().toLowerCase();
  if (
    !filename ||
    filename.length > 240 ||
    filename === "." ||
    filename === ".." ||
    /[\u0000-\u001f\u007f-\u009f\\/]/u.test(filename) ||
    !filename.toLowerCase().endsWith(".docx") ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > MAX_STUDIO_DOCX_BYTES ||
    (mimeType !== "" &&
      mimeType !== "application/octet-stream" &&
      mimeType !== VERA_STUDIO_DOCX_MIME_TYPE)
  ) {
    throw new VeraRuntimeConfigurationError(
      "The Vera Studio DOCX file is invalid.",
    );
  }
  return file;
}

function safeDocxFilename(value: string | null): string {
  if (
    value === null ||
    !value ||
    value.length > 240 ||
    /[\u0000-\u001f\u007f-\u009f\\/]/u.test(value) ||
    !value.toLowerCase().endsWith(".docx")
  ) {
    return invalidWire("Studio DOCX filename");
  }
  return value;
}

export function parseVeraStudioDocxImport(
  value: unknown,
): VeraStudioDocxImportWire {
  const wire = record(value, "Studio DOCX import");
  exactKeys(wire, ["document", "warnings"], "Studio DOCX import");
  return {
    document: parseCurrentVeraStudioDocument(wire.document),
    warnings: docxWarningCodes(wire.warnings, "Studio DOCX import warnings"),
  };
}

export async function createVeraStudioDocument(
  projectId: string,
  input: CreateVeraStudioDocumentInput,
  signal?: AbortSignal,
): Promise<VeraStudioDocumentWire> {
  return parseCurrentVeraStudioDocument(
    await veraApiRequest<unknown>(studioDocumentPath(projectId), {
      method: "POST",
      json: {
        title: safeTitle(input.title),
        ...(input.folder_id === undefined
          ? {}
          : {
              folder_id:
                input.folder_id === null
                  ? null
                  : safeId(input.folder_id, "folder id"),
            }),
      },
      signal,
    }),
  );
}

export async function getVeraStudioDocument(
  projectId: string,
  documentId: string,
  versionId?: string,
  signal?: AbortSignal,
): Promise<VeraStudioDocumentWire> {
  const response = await veraApiRequest<unknown>(
    studioDocumentPath(projectId, documentId),
    {
      query: versionId
        ? { version_id: safeId(versionId, "Studio version id") }
        : {},
      signal,
    },
  );
  return versionId
    ? parseVeraStudioDocument(response)
    : parseCurrentVeraStudioDocument(response);
}

export async function saveVeraStudioDocument(
  projectId: string,
  documentId: string,
  input: SaveVeraStudioDocumentInput,
  signal?: AbortSignal,
): Promise<VeraStudioDocumentWire> {
  let content: string;
  try {
    content = studioContent(input.content);
  } catch {
    throw new VeraRuntimeConfigurationError(
      "The Vera Studio document content is invalid.",
    );
  }
  return parseCurrentVeraStudioDocument(
    await veraApiRequest<unknown>(studioDocumentPath(projectId, documentId), {
      method: "PUT",
      json: {
        expected_version_id: safeId(
          input.expected_version_id,
          "expected Studio version id",
        ),
        content,
        source: input.source,
        ...(input.citation_anchor_ids === undefined
          ? {}
          : {
              citation_anchor_ids: uuidArray(
                input.citation_anchor_ids,
                "Studio citation ids",
              ),
            }),
        ...(input.summary === undefined
          ? {}
          : { summary: safeSummary(input.summary) }),
      },
      signal,
    }),
  );
}

export async function listVeraStudioVersions(
  projectId: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<VeraStudioVersionsWire> {
  return parseVeraStudioVersions(
    await veraApiRequest<unknown>(
      `${studioDocumentPath(projectId, documentId)}/versions`,
      { signal },
    ),
  );
}

export async function restoreVeraStudioVersion(
  projectId: string,
  documentId: string,
  versionId: string,
  input: RestoreVeraStudioVersionInput,
  signal?: AbortSignal,
): Promise<VeraStudioDocumentWire> {
  return parseCurrentVeraStudioDocument(
    await veraApiRequest<unknown>(
      `${studioDocumentPath(projectId, documentId)}/versions/${safeId(versionId, "Studio version id")}/restore`,
      {
        method: "POST",
        json: {
          expected_current_version_id: safeId(
            input.expected_current_version_id,
            "expected Studio version id",
          ),
        },
        signal,
      },
    ),
  );
}

export async function importVeraStudioDocx(
  projectId: string,
  documentId: string,
  expectedVersionId: string,
  file: File,
  signal?: AbortSignal,
): Promise<VeraStudioDocxImportWire> {
  const checkedFile = safeDocxFile(file);
  const form = new FormData();
  form.append(
    "expected_version_id",
    safeId(expectedVersionId, "expected Studio version id"),
  );
  form.append("file", checkedFile, checkedFile.name);
  return parseVeraStudioDocxImport(
    await veraApiRequest<unknown>(
      `${studioDocumentPath(projectId, documentId)}/import-docx`,
      { method: "POST", body: form, signal },
    ),
  );
}

export async function exportVeraStudioDocx(
  projectId: string,
  documentId: string,
  versionId?: string,
  signal?: AbortSignal,
): Promise<VeraStudioDocxDownload> {
  const response = await veraApiBlobRequest(
    `${studioDocumentPath(projectId, documentId)}/export-docx`,
    {
      query: versionId
        ? { version_id: safeId(versionId, "Studio version id") }
        : {},
      signal,
    },
    { warningCodeAllowlist: VERA_STUDIO_DOCX_WARNING_CODES },
  );
  if (
    response.blob.size < 1 ||
    response.blob.size > MAX_STUDIO_DOCX_BYTES ||
    response.blob.type.toLowerCase() !== VERA_STUDIO_DOCX_MIME_TYPE
  ) {
    invalidWire("Studio DOCX download");
  }
  return {
    blob: response.blob,
    filename: safeDocxFilename(response.filename),
    warningCodes: docxWarningCodes(
      response.warningCodes ?? [],
      "Studio DOCX download warnings",
    ),
  };
}
