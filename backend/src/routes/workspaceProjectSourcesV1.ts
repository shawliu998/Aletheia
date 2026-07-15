import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z, ZodError } from "zod";

import { WorkspaceApiError } from "../lib/workspace/errors";
import { MIKE_LOCAL_USER_ID } from "../lib/workspace/mikeCompatibility";
import {
  ProjectSourceKindV11Schema,
  TransportSafeSourceMetadataV11Schema,
} from "../lib/workspace/sourceFoundationContractsV11";
import type { WorkspaceV1Context } from "./workspaceV1";

const Id = z.string().uuid();
const IsoDateTime = z.string().datetime({ offset: true });
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const OpaqueTitle = z
  .string()
  .min(1)
  .refine((value) => [...value].length <= 500)
  .refine((value) => !value.includes("\0"));
const OpaqueQuote = z
  .string()
  .refine((value) => value.trim().length > 0)
  .refine((value) => [...value].length <= 8_000)
  .refine((value) => !value.includes("\0"));

const CaptureDocumentSnapshotRequest = z
  .object({
    document_id: Id,
    version_id: Id.optional(),
  })
  .strict();

const SourceListQuery = z
  .object({
    kind: ProjectSourceKindV11Schema.optional(),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

const CreateAnchorRequest = z
  .object({
    chunk_id: Id,
    exact_quote: OpaqueQuote,
    start_offset: z.number().int().nonnegative().optional(),
    end_offset: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasStart = value.start_offset !== undefined;
    const hasEnd = value.end_offset !== undefined;
    if (hasStart !== hasEnd) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasStart ? ["end_offset"] : ["start_offset"],
        message: "Citation offsets must be supplied together.",
      });
    }
    if (
      value.start_offset !== undefined &&
      value.end_offset !== undefined &&
      value.end_offset < value.start_offset
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["end_offset"],
        message: "Citation end offset must not precede its start offset.",
      });
    }
  });

const SourcePolicyResponse = z
  .object({
    basis: z.enum(["not_declared", "deployment_contract", "user_provided"]),
    retention: z.enum([
      "not_declared",
      "no_retention",
      "metadata_only",
      "full_text_ttl",
      "full_text_permitted",
    ]),
    export: z.enum([
      "not_declared",
      "prohibited",
      "exact_quotes_only",
      "reviewed_work_product",
      "permitted",
    ]),
    model_use: z.enum([
      "not_declared",
      "prohibited",
      "local_only",
      "permitted",
    ]),
  })
  .strict();

const SourceSnapshotResponse = z
  .object({
    id: Id,
    project_id: Id,
    kind: ProjectSourceKindV11Schema,
    source_record_id: z.string().min(1).max(500),
    source_version_id: z.string().min(1).max(500).nullable(),
    title: OpaqueTitle,
    content_sha256: Sha256,
    locator: TransportSafeSourceMetadataV11Schema,
    retrieved_at: IsoDateTime,
    license: SourcePolicyResponse,
    retention_policy: z.enum([
      "not_declared",
      "no_retention",
      "metadata_only",
      "full_text_ttl",
      "full_text_permitted",
    ]),
    retention_expires_at: IsoDateTime.nullable(),
    retrieval_metadata: TransportSafeSourceMetadataV11Schema,
    created_at: IsoDateTime,
  })
  .strict();

const CitationAnchorResponse = z
  .object({
    id: Id,
    project_id: Id,
    snapshot_id: Id,
    ordinal: z.number().int().nonnegative(),
    exact_quote: OpaqueQuote,
    quote_sha256: Sha256,
    locator: TransportSafeSourceMetadataV11Schema,
    created_at: IsoDateTime,
  })
  .strict();

const CaptureDocumentSnapshotResponse = z
  .object({
    snapshot: SourceSnapshotResponse,
    reused: z.boolean(),
  })
  .strict();

const SourceListResponse = z
  .object({
    sources: z.array(SourceSnapshotResponse).max(100),
    next_cursor: z.string().min(1).max(512).nullable(),
  })
  .strict();

const SourceDetailResponse = z
  .object({
    snapshot: SourceSnapshotResponse,
    anchors: z.array(CitationAnchorResponse).max(200),
  })
  .strict();

const CreateAnchorResponse = z
  .object({
    anchor: CitationAnchorResponse,
  })
  .strict();

export type WorkspaceProjectSourceListInput = {
  sourceKind?: z.infer<typeof ProjectSourceKindV11Schema>;
  limit?: number;
  cursor?: string;
};

export type WorkspaceProjectSourceAnchorInput = {
  chunkId: string;
  exactQuote: string;
  startOffset: number | null;
  endOffset: number | null;
};

/** Dedicated Project source seam; every implementation must recheck scope. */
export interface WorkspaceProjectSourcesV1Port {
  captureProjectDocumentSource(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    versionId?: string,
  ): Promise<unknown>;
  listProjectSources(
    context: WorkspaceV1Context,
    projectId: string,
    input: WorkspaceProjectSourceListInput,
  ): Promise<unknown>;
  getProjectSource(
    context: WorkspaceV1Context,
    projectId: string,
    snapshotId: string,
  ): Promise<unknown>;
  createProjectSourceAnchor(
    context: WorkspaceV1Context,
    projectId: string,
    snapshotId: string,
    input: WorkspaceProjectSourceAnchorInput,
  ): Promise<unknown>;
}

export type WorkspaceProjectSourcesV1RouterOptions = {
  requireAuthentication?: boolean;
  principal?: (request: Request) => string | undefined;
};

type AsyncHandler = (request: Request, response: Response) => Promise<void>;

function asyncRoute(handler: AsyncHandler) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response).catch(next);
  };
}

function contextFor(
  request: Request,
  options: WorkspaceProjectSourcesV1RouterOptions,
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
  if (typeof candidate === "string" && Id.safeParse(candidate).success) {
    return { principalId: candidate };
  }
  return { principalId: MIKE_LOCAL_USER_ID };
}

function idParam(request: Request, name: string): string {
  return Id.parse(request.params[name]);
}

function safePayload<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Project source response could not be serialized safely.",
    );
  }
  return parsed.data;
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

export function createWorkspaceProjectSourcesV1Router(
  port: WorkspaceProjectSourcesV1Port,
  options: WorkspaceProjectSourcesV1RouterOptions = {},
): Router {
  const router = Router();

  router.post(
    "/projects/:projectId/sources/document-snapshots",
    asyncRoute(async (request, response) => {
      const input = CaptureDocumentSnapshotRequest.parse(request.body);
      const result = safePayload(
        CaptureDocumentSnapshotResponse,
        await port.captureProjectDocumentSource(
          contextFor(request, options),
          idParam(request, "projectId"),
          input.document_id,
          input.version_id,
        ),
      );
      response.status(result.reused ? 200 : 201).json(result);
    }),
  );

  router.get(
    "/projects/:projectId/sources",
    asyncRoute(async (request, response) => {
      const query = SourceListQuery.parse(request.query);
      response.json(
        safePayload(
          SourceListResponse,
          await port.listProjectSources(
            contextFor(request, options),
            idParam(request, "projectId"),
            {
              sourceKind: query.kind,
              limit: query.limit,
              cursor: query.cursor,
            },
          ),
        ),
      );
    }),
  );

  router.get(
    "/projects/:projectId/sources/:snapshotId",
    asyncRoute(async (request, response) => {
      response.json(
        safePayload(
          SourceDetailResponse,
          await port.getProjectSource(
            contextFor(request, options),
            idParam(request, "projectId"),
            idParam(request, "snapshotId"),
          ),
        ),
      );
    }),
  );

  router.post(
    "/projects/:projectId/sources/:snapshotId/anchors",
    asyncRoute(async (request, response) => {
      const input = CreateAnchorRequest.parse(request.body);
      response.status(201).json(
        safePayload(
          CreateAnchorResponse,
          await port.createProjectSourceAnchor(
            contextFor(request, options),
            idParam(request, "projectId"),
            idParam(request, "snapshotId"),
            {
              chunkId: input.chunk_id,
              exactQuote: input.exact_quote,
              startOffset: input.start_offset ?? null,
              endOffset: input.end_offset ?? null,
            },
          ),
        ),
      );
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
