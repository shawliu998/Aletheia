import { Readable } from "node:stream";

import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z, ZodError } from "zod";

import {
  cleanupRequestUploadedFiles,
  materializeUploadedFile,
  singleFileUpload,
  type UploadPathRemover,
} from "../lib/upload";
import {
  assertMikeSafePayload,
  MIKE_LOCAL_USER_ID,
  parseMikeProjectCreate,
} from "../lib/workspace/mikeCompatibility";
import { WorkspaceApiError } from "../lib/workspace/errors";

const Id = z.string().uuid();
const Page = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const DocumentList = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    project_id: Id.nullable().optional(),
    folder_id: Id.nullable().optional(),
    status: z.enum(["pending", "processing", "ready", "error"]).optional(),
  })
  .strict();
const SingleDocumentList = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    status: z.enum(["pending", "processing", "ready", "error"]).optional(),
  })
  .strict();
const FolderCreate = z
  .object({
    name: z.string().trim().min(1).max(160),
    parent_folder_id: Id.nullable().optional(),
  })
  .strict();
const FolderUpdate = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    parent_folder_id: Id.nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "A folder update is required.",
  );
const ProjectUpdate = z
  .object({
    name: z.string().trim().min(1).max(240).optional(),
    description: z.string().trim().min(1).max(2_000).nullable().optional(),
    cm_number: z.string().trim().max(120).nullable().optional(),
    practice: z.string().trim().max(160).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "A project update is required.",
  );
const DeleteProject = z
  .object({ confirm_name: z.string().trim().min(1).max(240) })
  .strict();
const DownloadToken = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/);
const DownloadUrl = z
  .string()
  .regex(/^\/api\/v1\/downloads\/[A-Za-z0-9_-]{16,256}$/);
const MultipartNullableId = z
  .union([Id, z.literal("null")])
  .transform((value) => (value === "null" ? null : value));
const MultipartDocumentUpload = z
  .object({
    project_id: MultipartNullableId.optional(),
    folder_id: MultipartNullableId.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.folder_id !== undefined &&
      value.folder_id !== null &&
      value.project_id == null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["project_id"],
        message: "project_id is required when folder_id is set.",
      });
    }
  });
const MultipartProjectDocumentUpload = z
  .object({
    folder_id: MultipartNullableId.optional(),
  })
  .strict();
const EmptyMultipartFields = z.object({}).strict();
const EmptyJsonBody = z.object({}).strict();
const MultipartErrorCodes = new Set([
  "LIMIT_PART_COUNT",
  "LIMIT_FILE_SIZE",
  "LIMIT_FILE_COUNT",
  "LIMIT_FIELD_KEY",
  "LIMIT_FIELD_VALUE",
  "LIMIT_FIELD_COUNT",
  "LIMIT_UNEXPECTED_FILE",
  "MISSING_FIELD_NAME",
]);

function parseEmptyJsonBody(value: unknown) {
  return EmptyJsonBody.parse(value === undefined ? {} : value);
}

export type WorkspaceV1Context = { principalId: string };
export type WorkspaceV1Page = { cursor?: string; limit?: number };
export type WorkspaceV1DocumentList = WorkspaceV1Page & {
  projectId?: string | null;
  folderId?: string | null;
  status?: "pending" | "processing" | "ready" | "error";
  standalone: boolean;
};
export type WorkspaceV1Download = {
  filename: string;
  contentType: string;
  body: Uint8Array | Readable;
  disposition: "inline" | "attachment";
  contentLength?: number;
};
export type WorkspaceV1DocumentCapability = {
  url: string;
  document_id: string;
  filename: string;
  version_id: string | null;
  has_pdf_rendition: boolean;
  download_url?: string;
};
export type WorkspaceV1DocumentUploadInput = {
  filename: string;
  mimetype: string;
  buffer: Buffer;
  projectId: string | null;
  folderId: string | null;
};
export type WorkspaceV1DocumentVersionUploadInput = {
  filename: string;
  mimetype: string;
  buffer: Buffer;
};
export type WorkspaceV1DocumentMutationScope = {
  projectId?: string | null;
};

/**
 * The router's only integration seam. Implementations may delegate to services,
 * but this HTTP adapter never opens a database or repository itself.
 */
export interface WorkspaceV1RuntimePort {
  listProjects(
    context: WorkspaceV1Context,
    page: WorkspaceV1Page,
  ): Promise<unknown>;
  createProject(context: WorkspaceV1Context, input: unknown): Promise<unknown>;
  getProject(context: WorkspaceV1Context, projectId: string): Promise<unknown>;
  updateProject(
    context: WorkspaceV1Context,
    projectId: string,
    input: unknown,
  ): Promise<unknown>;
  archiveProject(
    context: WorkspaceV1Context,
    projectId: string,
  ): Promise<unknown>;
  unarchiveProject(
    context: WorkspaceV1Context,
    projectId: string,
  ): Promise<unknown>;
  deleteProject(
    context: WorkspaceV1Context,
    projectId: string,
    confirmName: string,
  ): Promise<void>;
  listFolders(
    context: WorkspaceV1Context,
    projectId: string,
    page: WorkspaceV1Page,
  ): Promise<unknown>;
  createFolder(
    context: WorkspaceV1Context,
    projectId: string,
    input: unknown,
  ): Promise<unknown>;
  updateFolder(
    context: WorkspaceV1Context,
    projectId: string,
    folderId: string,
    input: unknown,
  ): Promise<unknown>;
  deleteFolder(
    context: WorkspaceV1Context,
    projectId: string,
    folderId: string,
  ): Promise<void>;
  listDocuments(
    context: WorkspaceV1Context,
    query: WorkspaceV1DocumentList,
  ): Promise<unknown>;
  /** Every project-scoped method must re-check project/folder/document ownership. */
  listProjectDocuments(
    context: WorkspaceV1Context,
    projectId: string,
    page: WorkspaceV1Page,
  ): Promise<unknown>;
  attachProjectDocument(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
  ): Promise<unknown>;
  uploadDocument(
    context: WorkspaceV1Context,
    input: WorkspaceV1DocumentUploadInput,
  ): Promise<unknown>;
  uploadDocumentVersion(
    context: WorkspaceV1Context,
    documentId: string,
    input: WorkspaceV1DocumentVersionUploadInput,
    scope?: WorkspaceV1DocumentMutationScope,
  ): Promise<unknown>;
  deleteDocument(
    context: WorkspaceV1Context,
    documentId: string,
    scope?: WorkspaceV1DocumentMutationScope,
  ): Promise<unknown> | Promise<void>;
  retryDocumentParse(
    context: WorkspaceV1Context,
    documentId: string,
    scope?: WorkspaceV1DocumentMutationScope,
  ): Promise<unknown | null>;
  renameProjectDocument(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    filename: string,
  ): Promise<unknown>;
  moveProjectDocument(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    folderId: string | null,
  ): Promise<unknown>;
  getDocument(
    context: WorkspaceV1Context,
    documentId: string,
  ): Promise<unknown>;
  listDocumentVersions(
    context: WorkspaceV1Context,
    documentId: string,
  ): Promise<unknown>;
  readDocument(
    context: WorkspaceV1Context,
    documentId: string,
    versionId?: string,
  ): Promise<unknown>;
  displayDocument(
    context: WorkspaceV1Context,
    documentId: string,
    versionId?: string,
  ): Promise<WorkspaceV1Download>;
  getDocumentDownload(
    context: WorkspaceV1Context,
    documentId: string,
    versionId?: string,
  ): Promise<WorkspaceV1DocumentCapability>;
  getDocumentVersionFile(
    context: WorkspaceV1Context,
    documentId: string,
    versionId: string,
  ): Promise<WorkspaceV1DocumentCapability>;
  resolveDownload(
    context: WorkspaceV1Context,
    token: string,
  ): Promise<WorkspaceV1Download>;
}

export type WorkspaceV1RouterOptions = {
  /** Defaults to the single local principal; production mounts may require middleware-set userId. */
  requireAuthentication?: boolean;
  principal?: (request: Request) => string | undefined;
  /** Injectable for deterministic cleanup failure tests; production uses secure rm. */
  uploadPathRemover?: UploadPathRemover;
};

type AsyncHandler = (request: Request, response: Response) => Promise<void>;
const asyncRoute =
  (handler: AsyncHandler) =>
  (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };

function contextFor(
  request: Request,
  options: WorkspaceV1RouterOptions,
): WorkspaceV1Context {
  const response = request.res as Response | undefined;
  const candidate =
    options.principal?.(request) ??
    response?.locals.userId ??
    (request as Request & { userId?: unknown }).userId;
  if (
    options.requireAuthentication &&
    (typeof candidate !== "string" || !Id.safeParse(candidate).success)
  ) {
    throw new WorkspaceApiError(
      401,
      "UNAUTHORIZED",
      "Authentication is required.",
    );
  }
  if (typeof candidate === "string" && Id.safeParse(candidate).success)
    return { principalId: candidate };
  return { principalId: MIKE_LOCAL_USER_ID };
}

function idParam(request: Request, name: string): string {
  return Id.parse(request.params[name]);
}

function safeJson(response: Response, payload: unknown, status = 200) {
  if (payload instanceof Readable || payload instanceof Uint8Array) {
    throw new WorkspaceV1HttpError(
      500,
      "INTERNAL_ERROR",
      "Document bytes must be sent through the download capability.",
    );
  }
  assertMikeSafePayload(payload);
  response.status(status).json(payload);
}

const Capability = z
  .object({
    url: DownloadUrl,
    document_id: Id,
    filename: z.string().min(1).max(240),
    version_id: Id.nullable(),
    has_pdf_rendition: z.boolean(),
    download_url: DownloadUrl.optional(),
  })
  .strict();

function safeCapability(
  response: Response,
  payload: WorkspaceV1DocumentCapability,
) {
  const parsed = Capability.parse(payload);
  safeFilename(parsed.filename);
  safeJson(response, parsed);
}

function safeFilename(filename: string): string {
  if (!filename || filename.length > 240 || /[\r\n\\/\0]/.test(filename)) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Unsafe download metadata.",
    );
  }
  return filename;
}

function asciiDispositionFilename(filename: string): string {
  const fallback = filename
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .trim()
    .slice(0, 240);
  return fallback && !/^[._ -]+$/.test(fallback) ? fallback : "download";
}

function encodeDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function validationError(message: string): never {
  throw new WorkspaceV1HttpError(422, "VALIDATION_ERROR", message);
}

function multipartFields(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function uploadFilename(value: unknown) {
  if (typeof value !== "string")
    validationError("A document file is required.");
  const filename = value.trim();
  if (
    !filename ||
    filename.length > 240 ||
    filename === "." ||
    filename === ".." ||
    /[\r\n\\/\0]/.test(filename)
  ) {
    validationError("The uploaded file name is invalid.");
  }
  return filename;
}

function uploadMimeType(value: unknown) {
  if (typeof value !== "string")
    validationError("The uploaded MIME type is invalid.");
  const mimetype = value.trim().toLowerCase();
  if (
    !mimetype ||
    mimetype.length > 200 ||
    /[\r\n\0]/.test(mimetype) ||
    !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9!#$&^_.+-]+(?:;\s*charset=[A-Za-z0-9._-]+)?$/i.test(
      mimetype,
    )
  ) {
    validationError("The uploaded MIME type is invalid.");
  }
  return mimetype;
}

function safeContentType(contentType: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9!#$&^_.+-]+(?:;\s*charset=[A-Za-z0-9._-]+)?$/.test(
      contentType,
    )
  ) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Unsafe download metadata.",
    );
  }
  return contentType;
}

function safeContentLength(
  contentLength: number | undefined,
): number | undefined {
  if (contentLength === undefined) return undefined;
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Unsafe download metadata.",
    );
  }
  return contentLength;
}

function safeDisposition(
  disposition: unknown,
): WorkspaceV1Download["disposition"] {
  if (disposition !== "inline" && disposition !== "attachment") {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Unsafe download metadata.",
    );
  }
  return disposition;
}

function sendBinary(
  request: Request,
  response: Response,
  download: WorkspaceV1Download,
) {
  const contentType = safeContentType(download.contentType);
  const filename = safeFilename(download.filename);
  const disposition = safeDisposition(download.disposition);
  const contentDisposition =
    disposition +
    '; filename="' +
    asciiDispositionFilename(filename) +
    "\"; filename*=UTF-8''" +
    encodeDispositionFilename(filename);
  const contentLength = safeContentLength(
    download.contentLength ??
      (download.body instanceof Uint8Array
        ? download.body.byteLength
        : undefined),
  );
  response.set({
    "Content-Type": contentType,
    "Content-Disposition": contentDisposition,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    ...(contentLength === undefined
      ? {}
      : { "Content-Length": String(contentLength) }),
  });
  if (download.body instanceof Readable) {
    const stream = download.body;
    const abort = () => stream.destroy();
    request.once("aborted", abort);
    response.once("close", abort);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
    return;
  }
  response.status(200).send(Buffer.from(download.body));
}

class WorkspaceV1HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function uploadedFile(request: Request): Express.Multer.File {
  const file = request.file;
  if (!file) {
    validationError("A single file field named file is required.");
  }
  return file;
}

async function withUploadedFile<T>(
  request: Request,
  handler: (file: Express.Multer.File) => Promise<T>,
  removePath?: UploadPathRemover,
) {
  const file = uploadedFile(request);
  let materialized: Express.Multer.File | undefined;
  try {
    materialized = await materializeUploadedFile(file);
    if (
      !Buffer.isBuffer(materialized.buffer) ||
      materialized.buffer.length < 1
    ) {
      validationError("A non-empty uploaded file is required.");
    }
    return await handler(materialized);
  } finally {
    await cleanupRequestUploadedFiles(
      request,
      [materialized ?? file],
      removePath,
    );
  }
}

function parseUploadDocumentInput(
  file: Express.Multer.File,
  fields: z.infer<typeof MultipartDocumentUpload>,
): WorkspaceV1DocumentUploadInput {
  if (!Buffer.isBuffer(file.buffer)) {
    validationError("A document buffer is required.");
  }
  return {
    filename: uploadFilename(file.originalname),
    mimetype: uploadMimeType(file.mimetype),
    buffer: file.buffer,
    projectId: fields.project_id ?? null,
    folderId: fields.folder_id ?? null,
  };
}

function parseUploadDocumentVersionInput(
  file: Express.Multer.File,
): WorkspaceV1DocumentVersionUploadInput {
  if (!Buffer.isBuffer(file.buffer)) {
    validationError("A document buffer is required.");
  }
  return {
    filename: uploadFilename(file.originalname),
    mimetype: uploadMimeType(file.mimetype),
    buffer: file.buffer,
  };
}

function errorPayload(error: unknown) {
  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({
      path: issue.path.join(".") || "request",
      message: issue.message,
    }));
    return {
      status: 422,
      body: {
        detail: "Invalid request.",
        code: "VALIDATION_ERROR",
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request.",
          retryable: false,
          details,
        },
      },
    };
  }
  const uploadErrorCode =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    MultipartErrorCodes.has(error.code)
      ? error.code
      : undefined;
  if (uploadErrorCode) {
    const status = uploadErrorCode === "LIMIT_FILE_SIZE" ? 413 : 422;
    const code = status === 413 ? "PAYLOAD_TOO_LARGE" : "VALIDATION_ERROR";
    const message =
      status === 413
        ? "Uploaded file exceeds the maximum size."
        : "Invalid multipart upload.";
    return {
      status,
      body: {
        detail: message,
        code,
        error: { code, message, retryable: false },
      },
    };
  }
  if (error instanceof WorkspaceApiError) {
    return {
      status: error.status,
      body: {
        detail: error.message,
        code: error.code,
        error: { ...error.toResponse().error, retryable: false },
      },
    };
  }
  if (error instanceof WorkspaceV1HttpError) {
    return {
      status: error.status,
      body: {
        detail: error.message,
        code: error.code,
        error: { code: error.code, message: error.message, retryable: false },
      },
    };
  }
  return {
    status: 500,
    body: {
      detail: "Internal server error.",
      code: "INTERNAL_ERROR",
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error.",
        retryable: false,
      },
    },
  };
}

function workspaceSingleFileUpload(
  options: WorkspaceV1RouterOptions,
): RequestHandler {
  return singleFileUpload("file", {
    onError: (error, _request, _response, next) => next(error),
    removePath: options.uploadPathRemover,
  });
}

function installDocuments(
  router: Router,
  prefix: "/documents" | "/single-documents",
  port: WorkspaceV1RuntimePort,
  options: WorkspaceV1RouterOptions,
) {
  router.post(
    prefix,
    workspaceSingleFileUpload(options),
    asyncRoute(async (request, response) => {
      if (prefix === "/single-documents") {
        const result = await withUploadedFile(
          request,
          async (file) => {
            EmptyMultipartFields.parse(multipartFields(request.body));
            return port.uploadDocument(
              contextFor(request, options),
              parseUploadDocumentInput(file, {}),
            );
          },
          options.uploadPathRemover,
        );
        safeJson(response, result, 201);
        return;
      }
      const result = await withUploadedFile(
        request,
        async (file) => {
          const fields = MultipartDocumentUpload.parse(
            multipartFields(request.body),
          );
          return port.uploadDocument(
            contextFor(request, options),
            parseUploadDocumentInput(file, fields),
          );
        },
        options.uploadPathRemover,
      );
      safeJson(response, result, 201);
    }),
  );
  router.get(
    prefix,
    asyncRoute(async (request, response) =>
      safeJson(
        response,
        await port.listDocuments(
          contextFor(request, options),
          prefix === "/single-documents"
            ? (() => {
                const parsed = SingleDocumentList.parse(request.query);
                return {
                  cursor: parsed.cursor,
                  limit: parsed.limit,
                  status: parsed.status,
                  standalone: true,
                };
              })()
            : (() => {
                const parsed = DocumentList.parse(request.query);
                return {
                  cursor: parsed.cursor,
                  limit: parsed.limit,
                  projectId: parsed.project_id,
                  folderId: parsed.folder_id,
                  status: parsed.status,
                  standalone: false,
                };
              })(),
        ),
      ),
    ),
  );
  router.post(
    `${prefix}/:documentId/versions`,
    workspaceSingleFileUpload(options),
    asyncRoute(async (request, response) => {
      const result = await withUploadedFile(
        request,
        async (file) => {
          EmptyMultipartFields.parse(multipartFields(request.body));
          return port.uploadDocumentVersion(
            contextFor(request, options),
            idParam(request, "documentId"),
            parseUploadDocumentVersionInput(file),
            prefix === "/single-documents" ? { projectId: null } : undefined,
          );
        },
        options.uploadPathRemover,
      );
      safeJson(response, result, 201);
    }),
  );
  router.get(
    `${prefix}/:documentId`,
    asyncRoute(async (request, response) =>
      safeJson(
        response,
        await port.getDocument(
          contextFor(request, options),
          idParam(request, "documentId"),
        ),
      ),
    ),
  );
  router.get(
    `${prefix}/:documentId/versions`,
    asyncRoute(async (request, response) =>
      safeJson(
        response,
        await port.listDocumentVersions(
          contextFor(request, options),
          idParam(request, "documentId"),
        ),
      ),
    ),
  );
  router.get(
    `${prefix}/:documentId/versions/:versionId/file`,
    asyncRoute(async (request, response) =>
      safeCapability(
        response,
        await port.getDocumentVersionFile(
          contextFor(request, options),
          idParam(request, "documentId"),
          idParam(request, "versionId"),
        ),
      ),
    ),
  );
  router.get(
    `${prefix}/:documentId/read`,
    asyncRoute(async (request, response) => {
      const versionId =
        request.query.version_id === undefined
          ? undefined
          : Id.parse(request.query.version_id);
      safeJson(
        response,
        await port.readDocument(
          contextFor(request, options),
          idParam(request, "documentId"),
          versionId,
        ),
      );
    }),
  );
  router.post(
    `${prefix}/:documentId/retry`,
    asyncRoute(async (request, response) => {
      parseEmptyJsonBody(request.body);
      const retry = await port.retryDocumentParse(
        contextFor(request, options),
        idParam(request, "documentId"),
        prefix === "/single-documents" ? { projectId: null } : undefined,
      );
      if (!retry) {
        throw new WorkspaceV1HttpError(
          409,
          "CONFLICT",
          "Document parse retry is not available.",
        );
      }
      safeJson(response, retry, 202);
    }),
  );
  router.get(
    `${prefix}/:documentId/display`,
    asyncRoute(async (request, response) => {
      const versionId =
        request.query.version_id === undefined
          ? undefined
          : Id.parse(request.query.version_id);
      sendBinary(
        request,
        response,
        await port.displayDocument(
          contextFor(request, options),
          idParam(request, "documentId"),
          versionId,
        ),
      );
    }),
  );
  router.get(
    `${prefix}/:documentId/url`,
    asyncRoute(async (request, response) => {
      const versionId =
        request.query.version_id === undefined
          ? undefined
          : Id.parse(request.query.version_id);
      safeCapability(
        response,
        await port.getDocumentDownload(
          contextFor(request, options),
          idParam(request, "documentId"),
          versionId,
        ),
      );
    }),
  );
  router.get(
    `${prefix}/:documentId/download`,
    asyncRoute(async (request, response) => {
      const versionId =
        request.query.version_id === undefined
          ? undefined
          : Id.parse(request.query.version_id);
      safeCapability(
        response,
        await port.getDocumentDownload(
          contextFor(request, options),
          idParam(request, "documentId"),
          versionId,
        ),
      );
    }),
  );
  router.delete(
    `${prefix}/:documentId`,
    asyncRoute(async (request, response) => {
      parseEmptyJsonBody(request.body);
      await port.deleteDocument(
        contextFor(request, options),
        idParam(request, "documentId"),
        prefix === "/single-documents" ? { projectId: null } : undefined,
      );
      response.status(204).end();
    }),
  );
}

export function createWorkspaceV1Router(
  port: WorkspaceV1RuntimePort,
  options: WorkspaceV1RouterOptions = {},
): Router {
  const router = Router();
  router.get(
    "/projects",
    asyncRoute(async (request, response) =>
      safeJson(
        response,
        await port.listProjects(
          contextFor(request, options),
          Page.parse(request.query),
        ),
      ),
    ),
  );
  router.post(
    "/projects",
    asyncRoute(async (request, response) =>
      safeJson(
        response,
        await port.createProject(
          contextFor(request, options),
          parseMikeProjectCreate(request.body),
        ),
        201,
      ),
    ),
  );
  router.get(
    "/projects/:projectId",
    asyncRoute(async (request, response) =>
      safeJson(
        response,
        await port.getProject(
          contextFor(request, options),
          idParam(request, "projectId"),
        ),
      ),
    ),
  );
  router.patch(
    "/projects/:projectId",
    asyncRoute(async (request, response) =>
      safeJson(
        response,
        await port.updateProject(
          contextFor(request, options),
          idParam(request, "projectId"),
          ProjectUpdate.parse(request.body),
        ),
      ),
    ),
  );
  router.post(
    "/projects/:projectId/archive",
    asyncRoute(async (request, response) =>
      safeJson(
        response,
        await port.archiveProject(
          contextFor(request, options),
          idParam(request, "projectId"),
        ),
      ),
    ),
  );
  router.post(
    "/projects/:projectId/unarchive",
    asyncRoute(async (request, response) =>
      safeJson(
        response,
        await port.unarchiveProject(
          contextFor(request, options),
          idParam(request, "projectId"),
        ),
      ),
    ),
  );
  router.delete(
    "/projects/:projectId",
    asyncRoute(async (request, response) => {
      const input = DeleteProject.parse(request.body);
      await port.deleteProject(
        contextFor(request, options),
        idParam(request, "projectId"),
        input.confirm_name,
      );
      response.status(204).end();
    }),
  );

  router.get(
    "/projects/:projectId/documents",
    asyncRoute(async (request, response) =>
      safeJson(
        response,
        await port.listProjectDocuments(
          contextFor(request, options),
          idParam(request, "projectId"),
          Page.parse(request.query),
        ),
      ),
    ),
  );
  router.post(
    "/projects/:projectId/documents",
    workspaceSingleFileUpload(options),
    asyncRoute(async (request, response) => {
      const result = await withUploadedFile(
        request,
        async (file) => {
          const projectId = idParam(request, "projectId");
          const fields = MultipartProjectDocumentUpload.parse(
            multipartFields(request.body),
          );
          return port.uploadDocument(contextFor(request, options), {
            ...parseUploadDocumentInput(file, {}),
            projectId,
            folderId: fields.folder_id ?? null,
          });
        },
        options.uploadPathRemover,
      );
      safeJson(response, result, 201);
    }),
  );
  router.post(
    "/projects/:projectId/documents/:documentId",
    asyncRoute(async (request, response) =>
      safeJson(
        response,
        await port.attachProjectDocument(
          contextFor(request, options),
          idParam(request, "projectId"),
          idParam(request, "documentId"),
        ),
        201,
      ),
    ),
  );
  router.patch(
    "/projects/:projectId/documents/:documentId",
    asyncRoute(async (request, response) => {
      const input = z
        .object({ filename: z.string().trim().min(1).max(240) })
        .strict()
        .parse(request.body);
      safeJson(
        response,
        await port.renameProjectDocument(
          contextFor(request, options),
          idParam(request, "projectId"),
          idParam(request, "documentId"),
          input.filename,
        ),
      );
    }),
  );
  router.patch(
    "/projects/:projectId/documents/:documentId/folder",
    asyncRoute(async (request, response) => {
      const input = z
        .object({ folder_id: Id.nullable() })
        .strict()
        .parse(request.body);
      safeJson(
        response,
        await port.moveProjectDocument(
          contextFor(request, options),
          idParam(request, "projectId"),
          idParam(request, "documentId"),
          input.folder_id,
        ),
      );
    }),
  );
  router.post(
    "/projects/:projectId/documents/:documentId/versions",
    workspaceSingleFileUpload(options),
    asyncRoute(async (request, response) => {
      const result = await withUploadedFile(
        request,
        async (file) => {
          EmptyMultipartFields.parse(multipartFields(request.body));
          const projectId = idParam(request, "projectId");
          return port.uploadDocumentVersion(
            contextFor(request, options),
            idParam(request, "documentId"),
            parseUploadDocumentVersionInput(file),
            { projectId },
          );
        },
        options.uploadPathRemover,
      );
      safeJson(response, result, 201);
    }),
  );
  router.post(
    "/projects/:projectId/documents/:documentId/retry",
    asyncRoute(async (request, response) => {
      parseEmptyJsonBody(request.body);
      const retry = await port.retryDocumentParse(
        contextFor(request, options),
        idParam(request, "documentId"),
        { projectId: idParam(request, "projectId") },
      );
      if (!retry) {
        throw new WorkspaceV1HttpError(
          409,
          "CONFLICT",
          "Document parse retry is not available.",
        );
      }
      safeJson(response, retry, 202);
    }),
  );
  router.delete(
    "/projects/:projectId/documents/:documentId",
    asyncRoute(async (request, response) => {
      parseEmptyJsonBody(request.body);
      await port.deleteDocument(
        contextFor(request, options),
        idParam(request, "documentId"),
        { projectId: idParam(request, "projectId") },
      );
      response.status(204).end();
    }),
  );

  router.get(
    "/projects/:projectId/folders",
    asyncRoute(async (request, response) =>
      safeJson(
        response,
        await port.listFolders(
          contextFor(request, options),
          idParam(request, "projectId"),
          Page.parse(request.query),
        ),
      ),
    ),
  );
  router.post(
    "/projects/:projectId/folders",
    asyncRoute(async (request, response) =>
      safeJson(
        response,
        await port.createFolder(
          contextFor(request, options),
          idParam(request, "projectId"),
          FolderCreate.parse(request.body),
        ),
        201,
      ),
    ),
  );
  router.patch(
    "/projects/:projectId/folders/:folderId",
    asyncRoute(async (request, response) =>
      safeJson(
        response,
        await port.updateFolder(
          contextFor(request, options),
          idParam(request, "projectId"),
          idParam(request, "folderId"),
          FolderUpdate.parse(request.body),
        ),
      ),
    ),
  );
  router.delete(
    "/projects/:projectId/folders/:folderId",
    asyncRoute(async (request, response) => {
      await port.deleteFolder(
        contextFor(request, options),
        idParam(request, "projectId"),
        idParam(request, "folderId"),
      );
      response.status(204).end();
    }),
  );

  installDocuments(router, "/documents", port, options);
  installDocuments(router, "/single-documents", port, options);
  router.get(
    "/downloads/:token",
    asyncRoute(async (request, response) => {
      const download = await port.resolveDownload(
        contextFor(request, options),
        DownloadToken.parse(request.params.token),
      );
      sendBinary(request, response, {
        ...download,
        disposition: "attachment",
      });
    }),
  );
  router.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      if (response.headersSent) return next(error);
      const mapped = errorPayload(error);
      response.status(mapped.status).json(mapped.body);
    },
  );
  return router;
}
