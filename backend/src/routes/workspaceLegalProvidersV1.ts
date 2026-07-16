import {
  Router,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { ZodError, z } from "zod";

import { WorkspaceApiError } from "../lib/workspace/errors";
import {
  LEGAL_PROVIDER_CAPABILITIES_V18,
  LEGAL_PROVIDER_CONNECTION_ERROR_CODES_V18,
  LegalProviderProfileIdV18Schema,
  LegalProviderTimestampV18Schema,
} from "../lib/workspace/legalProviderPersistenceContractsV18";
import { MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES } from "../lib/workspace/services/credentialStore";

const ProviderId = LegalProviderProfileIdV18Schema;
const ProjectId = LegalProviderProfileIdV18Schema;
const PrincipalId = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/);
const EmptyObject = z.object({}).strict();
const Revision = z.number().int().min(0).max(2_147_483_647);
const ExpectedRevisionBody = z.object({ expected_revision: Revision }).strict();
const CredentialBody = z
  .object({
    expected_revision: Revision,
    secret: z
      .string()
      .min(1)
      .refine((value) => !/[\r\n]/.test(value), "credential is invalid")
      .refine(
        (value) =>
          Buffer.byteLength(value, "utf8") <=
          MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES,
        "credential is too large",
      ),
  })
  .strict();

const CapabilityWireSchema = z
  .object({
    capability: z.enum(LEGAL_PROVIDER_CAPABILITIES_V18),
    enabled: z.boolean(),
  })
  .strict();
const UsagePolicyWireSchema = z
  .object({
    retention: z.literal("not_declared"),
    local_processing: z.literal("transient_only"),
    model_use: z.literal("prohibited_pending_authorization"),
    export: z.literal("prohibited_pending_authorization"),
  })
  .strict();
const ConnectionTestWireSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("passed"),
      error_code: z.null(),
      retryable: z.literal(false),
      latency_ms: z.number().int().min(0).max(600_000).nullable(),
      tested_at: LegalProviderTimestampV18Schema,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      error_code: z.enum(LEGAL_PROVIDER_CONNECTION_ERROR_CODES_V18),
      retryable: z.boolean(),
      latency_ms: z.number().int().min(0).max(600_000).nullable(),
      tested_at: LegalProviderTimestampV18Schema,
    })
    .strict(),
]);
const LegalResearchStateSchema = z.enum([
  "unavailable",
  "not_configured",
  "configured_unverified",
  "ready",
  "authentication_failed",
  "license_restricted",
  "activation_gate_closed",
  "temporarily_unavailable",
]);
const ProviderWireSchema = z
  .object({
    id: ProviderId,
    provider: z.literal("yuandian"),
    endpoint_set_id: z.literal("yuandian-official-mcp-v1"),
    enabled: z.boolean(),
    credential_configured: z.boolean(),
    usage_policy: UsagePolicyWireSchema,
    capabilities: z
      .array(CapabilityWireSchema)
      .length(LEGAL_PROVIDER_CAPABILITIES_V18.length),
    revision: Revision,
    connection_revision: Revision,
    credential_revision: Revision,
    status: LegalResearchStateSchema,
    connection_test: ConnectionTestWireSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === "ready" &&
      (!value.enabled ||
        !value.credential_configured ||
        value.connection_test?.status !== "passed")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "ready provider status is inconsistent",
      });
    }
    const capabilities = value.capabilities.map((item) => item.capability);
    if (
      new Set(capabilities).size !== LEGAL_PROVIDER_CAPABILITIES_V18.length ||
      LEGAL_PROVIDER_CAPABILITIES_V18.some(
        (capability) => !capabilities.includes(capability),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "provider capabilities are incomplete",
      });
    }
  });
const ProviderListWireSchema = z
  .object({
    schema_version: z.literal("vera-workspace-legal-provider-hub-v1"),
    providers: z.array(ProviderWireSchema).max(1),
  })
  .strict();
const ProviderMutationWireSchema = z
  .object({
    schema_version: z.literal("vera-workspace-legal-provider-hub-v1"),
    profile: ProviderWireSchema,
  })
  .strict();
const LegalResearchReasonCodeSchema = z.enum([
  "provider_unavailable",
  "provider_not_configured",
  "provider_disabled",
  "credential_missing",
  "connection_unverified",
  "authentication_failed",
  "license_restricted",
  "activation_gate_closed",
  "temporarily_unavailable",
  "project_not_eligible",
]);
const ProjectLegalResearchStatusWireSchema = z
  .object({
    schema_version: z.literal("vera-workspace-legal-provider-hub-v1"),
    project_id: ProjectId,
    provider_id: ProviderId.nullable(),
    status: LegalResearchStateSchema,
    reason: LegalResearchReasonCodeSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const ready = value.status === "ready";
    if (
      (ready && (value.reason !== null || value.provider_id === null)) ||
      (!ready && value.reason === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "legal research status is inconsistent",
      });
    }
  });

export type WorkspaceLegalProviderHubV1Context = Readonly<{
  principalId: string;
}>;
export type WorkspaceLegalProviderV1Wire = z.infer<typeof ProviderWireSchema>;
export type WorkspaceProjectLegalResearchStatusV1Wire = z.infer<
  typeof ProjectLegalResearchStatusWireSchema
>;

export interface WorkspaceLegalProviderHubV1Port {
  listProviders(
    context: WorkspaceLegalProviderHubV1Context,
  ):
    | Promise<readonly WorkspaceLegalProviderV1Wire[]>
    | readonly WorkspaceLegalProviderV1Wire[];
  createOrGetYuanDian(
    context: WorkspaceLegalProviderHubV1Context,
  ):
    | Promise<{ created: boolean; provider: WorkspaceLegalProviderV1Wire }>
    | { created: boolean; provider: WorkspaceLegalProviderV1Wire };
  putCredential(
    context: WorkspaceLegalProviderHubV1Context,
    providerId: string,
    input: { secret: string; expected_revision: number },
  ): Promise<WorkspaceLegalProviderV1Wire> | WorkspaceLegalProviderV1Wire;
  deleteCredential(
    context: WorkspaceLegalProviderHubV1Context,
    providerId: string,
    input: { expected_revision: number },
  ): Promise<WorkspaceLegalProviderV1Wire> | WorkspaceLegalProviderV1Wire;
  testProvider(
    context: WorkspaceLegalProviderHubV1Context,
    providerId: string,
    input: { expected_revision: number },
  ): Promise<WorkspaceLegalProviderV1Wire> | WorkspaceLegalProviderV1Wire;
  enableProvider(
    context: WorkspaceLegalProviderHubV1Context,
    providerId: string,
    input: { expected_revision: number },
  ): Promise<WorkspaceLegalProviderV1Wire> | WorkspaceLegalProviderV1Wire;
  disableProvider(
    context: WorkspaceLegalProviderHubV1Context,
    providerId: string,
    input: { expected_revision: number },
  ): Promise<WorkspaceLegalProviderV1Wire> | WorkspaceLegalProviderV1Wire;
  getProjectLegalResearchStatus(
    context: WorkspaceLegalProviderHubV1Context,
    projectId: string,
  ):
    | Promise<WorkspaceProjectLegalResearchStatusV1Wire>
    | WorkspaceProjectLegalResearchStatusV1Wire;
}

export type WorkspaceLegalProviderHubV1RouterDependencies = Readonly<{
  hub: WorkspaceLegalProviderHubV1Port;
  /** Production authenticates the parent /api/v1 router first. */
  auth?: RequestHandler;
  context?: (input: {
    locals: Record<string, unknown>;
  }) => WorkspaceLegalProviderHubV1Context;
}>;

function parseInput<T extends z.ZodTypeAny>(schema: T, value: unknown) {
  try {
    return schema.parse(value) as z.infer<T>;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Legal provider request is invalid.",
      );
    }
    throw error;
  }
}

function sensitiveKey(key: string) {
  const normalized = key.replace(
    /[A-Z]/g,
    (match) => `_${match.toLowerCase()}`,
  );
  return (
    normalized === "secret" ||
    normalized === "token" ||
    normalized === "authorization" ||
    normalized === "url" ||
    normalized.endsWith("_url") ||
    normalized === "credential_ref" ||
    normalized === "credential_reference" ||
    normalized.endsWith("_credential_ref") ||
    normalized.endsWith("_credential_reference") ||
    normalized.startsWith("raw_") ||
    normalized.endsWith("_raw")
  );
}

function assertTransportSafe(value: unknown) {
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (
        /(?:https?:\/\/|keychain:\/\/|\bbearer\s+|tools\/list|inputSchema)/i.test(
          candidate,
        )
      ) {
        throw new Error("unsafe legal provider output");
      }
      return;
    }
    if (!candidate || typeof candidate !== "object" || seen.has(candidate))
      return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    for (const [key, nested] of Object.entries(candidate)) {
      if (sensitiveKey(key)) throw new Error("unsafe legal provider output");
      visit(nested);
    }
  };
  visit(value);
}

function parseOutput<T extends z.ZodTypeAny>(schema: T, value: unknown) {
  try {
    assertTransportSafe(value);
    return schema.parse(value) as z.infer<T>;
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Legal provider route emitted an invalid response.",
    );
  }
}

const SAFE_ERROR_MESSAGES = {
  VALIDATION_ERROR: "Legal provider request is invalid.",
  NOT_FOUND: "Legal provider resource was not found.",
  CONFLICT: "Legal provider request conflicts with current state.",
  PRECONDITION_FAILED: "Legal provider precondition failed.",
  UNAUTHORIZED: "Workspace authentication is required.",
  FORBIDDEN: "Legal provider operation is forbidden.",
  RATE_LIMITED: "Legal provider request was rate limited.",
  JOB_FAILED: "Legal provider operation failed.",
  INTERNAL_ERROR: "Legal provider route failed.",
} as const;

function handleRouteError(response: Response, error: unknown) {
  if (error instanceof WorkspaceApiError) {
    response
      .status(error.status)
      .json(
        new WorkspaceApiError(
          error.status,
          error.code,
          SAFE_ERROR_MESSAGES[error.code],
        ).toResponse(),
      );
    return;
  }
  response
    .status(500)
    .json(
      new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        SAFE_ERROR_MESSAGES.INTERNAL_ERROR,
      ).toResponse(),
    );
}

export function createWorkspaceLegalProvidersV1Router(
  dependencies: WorkspaceLegalProviderHubV1RouterDependencies,
) {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Pragma", "no-cache");
    next();
  });
  if (dependencies.auth) router.use(dependencies.auth);
  const hub = dependencies.hub;
  const context =
    dependencies.context ??
    ((input: { locals: Record<string, unknown> }) => {
      const principalId = PrincipalId.safeParse(input.locals.userId);
      if (!principalId.success) {
        throw new WorkspaceApiError(
          401,
          "UNAUTHORIZED",
          SAFE_ERROR_MESSAGES.UNAUTHORIZED,
        );
      }
      return { principalId: principalId.data };
    });
  const requestContext = (response: Response) =>
    context({ locals: response.locals });
  const run =
    (operation: (request: Request, response: Response) => Promise<void>) =>
    (request: Request, response: Response) => {
      void operation(request, response).catch((error) =>
        handleRouteError(response, error),
      );
    };
  const validateEnvelope = (request: Request, body = false) => {
    parseInput(EmptyObject, request.query);
    if (body) parseInput(EmptyObject, request.body ?? {});
  };
  const providerId = (request: Request) =>
    parseInput(ProviderId, request.params.id);

  router.get(
    "/legal-providers",
    run(async (request, response) => {
      validateEnvelope(request);
      response.json(
        parseOutput(ProviderListWireSchema, {
          schema_version: "vera-workspace-legal-provider-hub-v1",
          providers: await hub.listProviders(requestContext(response)),
        }),
      );
    }),
  );
  router.post(
    "/legal-providers/yuandian",
    run(async (request, response) => {
      validateEnvelope(request, true);
      const result = await hub.createOrGetYuanDian(requestContext(response));
      response.status(result.created ? 201 : 200).json(
        parseOutput(ProviderMutationWireSchema, {
          schema_version: "vera-workspace-legal-provider-hub-v1",
          profile: result.provider,
        }),
      );
    }),
  );
  router.put(
    "/legal-providers/:id/credential",
    run(async (request, response) => {
      parseInput(EmptyObject, request.query);
      const input = parseInput(CredentialBody, request.body);
      response.json(
        parseOutput(ProviderMutationWireSchema, {
          schema_version: "vera-workspace-legal-provider-hub-v1",
          profile: await hub.putCredential(
            requestContext(response),
            providerId(request),
            input,
          ),
        }),
      );
    }),
  );
  router.delete(
    "/legal-providers/:id/credential",
    run(async (request, response) => {
      parseInput(EmptyObject, request.query);
      const input = parseInput(ExpectedRevisionBody, request.body);
      response.json(
        parseOutput(ProviderMutationWireSchema, {
          schema_version: "vera-workspace-legal-provider-hub-v1",
          profile: await hub.deleteCredential(
            requestContext(response),
            providerId(request),
            input,
          ),
        }),
      );
    }),
  );
  for (const [action, operation] of [
    ["test", hub.testProvider.bind(hub)],
    ["enable", hub.enableProvider.bind(hub)],
    ["disable", hub.disableProvider.bind(hub)],
  ] as const) {
    router.post(
      `/legal-providers/:id/${action}`,
      run(async (request, response) => {
        parseInput(EmptyObject, request.query);
        const input = parseInput(ExpectedRevisionBody, request.body);
        response.json(
          parseOutput(ProviderMutationWireSchema, {
            schema_version: "vera-workspace-legal-provider-hub-v1",
            profile: await operation(
              requestContext(response),
              providerId(request),
              input,
            ),
          }),
        );
      }),
    );
  }
  router.get(
    "/projects/:projectId/legal-research/status",
    run(async (request, response) => {
      validateEnvelope(request);
      response.json(
        parseOutput(
          ProjectLegalResearchStatusWireSchema,
          await hub.getProjectLegalResearchStatus(
            requestContext(response),
            parseInput(ProjectId, request.params.projectId),
          ),
        ),
      );
    }),
  );

  return router;
}
