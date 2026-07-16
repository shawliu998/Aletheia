import { createHash } from "node:crypto";
import { z } from "zod";

import {
  SourceDataUsePolicyV11Schema,
  TransportSafeSourceMetadataV11Schema,
  type SourceDataUsePolicyV11,
} from "../sourceFoundationContractsV11";

export const LEGAL_RESEARCH_PROVIDER_CONTRACT_VERSION =
  "vera-workspace-legal-research-provider-v1" as const;
export const UNAVAILABLE_LEGAL_RESEARCH_PROVIDER_ID =
  "authorized-legal-research" as const;

export const LEGAL_PROVIDER_STATES = [
  "unavailable",
  "not_configured",
  "configured_unverified",
  "ready",
  "authentication_failed",
  "license_restricted",
  "activation_gate_closed",
  "temporarily_unavailable",
] as const;

export const LEGAL_SOURCE_TYPES = [
  "statute",
  "regulation",
  "judicial_interpretation",
  "case",
  "guidance",
] as const;
export const LEGAL_MCP_ENDPOINT_CAPABILITIES = [
  "law",
  "case",
  "company",
] as const;

/** Fixed vendor tool allowlist; tools/list output is never model-visible. */
export const LEGAL_MCP_TOOL_ALLOWLIST = Object.freeze({
  law: Object.freeze({
    search: "yuandian_law_vector_search",
    read: Object.freeze([
      "yuandian_rh_ft_detail",
      "yuandian_rh_fg_detail",
    ] as const),
  }),
  case: Object.freeze({
    search: "yuandian_case_vector_search",
    read: Object.freeze(["yuandian_rh_case_details"] as const),
  }),
} as const);

const ProviderIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/);
const BoundedIdSchema = z.string().trim().min(1).max(500);
const IsoDateTimeSchema = z.string().datetime({ offset: true });
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ConfigurationRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
  .refine(
    (value) =>
      !value.includes("://") &&
      !value.startsWith("/") &&
      !/^(?:bearer|sk-|token|secret|password)/i.test(value),
    "must be an opaque configuration reference, not an endpoint or credential",
  );
const LegalProviderCredentialRefSchema = z
  .string()
  .regex(
    /^keychain:\/\/vera\/legal-provider\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[a-z0-9]{16,128}$/,
  );
const SafeStatusReasonSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      !/(?:\bbearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|(?:api[_-]?key|token|secret|credential|password)\s*[:=]\s*\S+|https?:\/\/|file:|\/(?:Users|home|tmp|private|etc)\/)/i.test(
        value,
      ),
    "must not contain credentials, endpoints, or filesystem paths",
  );

export const LegalProviderStateSchema = z.enum(LEGAL_PROVIDER_STATES);
export const LegalSourceTypeSchema = z.enum(LEGAL_SOURCE_TYPES);
export const LegalMcpEndpointCapabilitySchema = z.enum(
  LEGAL_MCP_ENDPOINT_CAPABILITIES,
);

/**
 * Runtime configuration stores references only. Endpoint URLs and Bearer
 * values are resolved inside the trusted provider transport and must never be
 * returned through status, tool output, logs, or persistence metadata.
 */
export const LegalResearchProviderTransportSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("unavailable") }).strict(),
    z
      .object({
        kind: z.literal("mcp_https_stream"),
        endpointRefs: z
          .array(
            z
              .object({
                capability: LegalMcpEndpointCapabilitySchema,
                endpointRef: ConfigurationRefSchema,
              })
              .strict(),
          )
          .min(1)
          .max(3)
          .superRefine((entries, context) => {
            const capabilities = new Set<string>();
            for (const [index, entry] of entries.entries()) {
              if (capabilities.has(entry.capability)) {
                context.addIssue({
                  code: z.ZodIssueCode.custom,
                  path: [index, "capability"],
                  message: "MCP endpoint capabilities must be unique",
                });
              }
              capabilities.add(entry.capability);
            }
          }),
        credentialRef: LegalProviderCredentialRefSchema,
      })
      .strict(),
    z.object({ kind: z.literal("deterministic_test") }).strict(),
  ],
);

export type LegalResearchProviderTransport = z.infer<
  typeof LegalResearchProviderTransportSchema
>;

export interface LegalResearchProviderConfigurationResolver {
  resolveHttpsEndpoint(
    endpointRef: string,
    signal: AbortSignal,
  ): Promise<string | null>;
  resolveBearerCredential(
    credentialRef: string,
    signal: AbortSignal,
  ): Promise<string | null>;
}

export const LegalProviderContextSchema = z
  .object({
    projectId: z.string().uuid(),
    researchSessionId: z.string().trim().min(1).max(160),
  })
  .strict();

export const LegalSearchRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(4_000),
    jurisdiction: z.string().trim().min(1).max(160).optional(),
    sourceTypes: z
      .array(LegalSourceTypeSchema)
      .max(5)
      .refine((value) => new Set(value).size === value.length, {
        message: "sourceTypes must be unique",
      })
      .optional(),
    dateFrom: DateSchema.optional(),
    dateTo: DateSchema.optional(),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.dateFrom !== undefined &&
      value.dateTo !== undefined &&
      value.dateFrom > value.dateTo
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dateTo"],
        message: "dateTo must not precede dateFrom",
      });
    }
  });

export const LegalProviderSearchItemSchema = z
  .object({
    providerSourceId: BoundedIdSchema,
    title: z.string().trim().min(1).max(500),
    sourceType: LegalSourceTypeSchema,
    jurisdiction: z.string().trim().min(1).max(160).optional(),
    court: z.string().trim().min(1).max(300).optional(),
    caseNumber: z.string().trim().min(1).max(300).optional(),
    effectiveDate: DateSchema.optional(),
    status: z.string().trim().min(1).max(160).optional(),
    summary: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

export const LegalSearchResponseSchema = z
  .object({
    queryId: BoundedIdSchema,
    results: z.array(LegalProviderSearchItemSchema).max(20),
  })
  .strict();

export const LegalSourceFetchRequestSchema = z
  .object({ providerSourceId: BoundedIdSchema })
  .strict();

export const LegalSourceLocatorSchema = z
  .object({
    article: z.string().trim().min(1).max(160).optional(),
    section: z.string().trim().min(1).max(300).optional(),
    paragraph: z.string().trim().min(1).max(160).optional(),
    page: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();

export const LegalSourceDocumentSchema = z
  .object({
    providerSourceId: BoundedIdSchema,
    sourceVersionId: BoundedIdSchema.nullable().default(null),
    title: z.string().trim().min(1).max(500),
    sourceType: LegalSourceTypeSchema,
    content: z
      .string()
      .min(1)
      .refine((value) => Buffer.byteLength(value, "utf8") <= 256 * 1_024, {
        message: "legal source content exceeds the byte limit",
      }),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
    retrievedAt: IsoDateTimeSchema,
    retentionExpiresAt: IsoDateTimeSchema.nullable().default(null),
    metadata: TransportSafeSourceMetadataV11Schema,
    locator: LegalSourceLocatorSchema.default({}),
  })
  .strict();

export const LegalResearchProviderStatusSchema = z
  .object({
    providerId: ProviderIdSchema,
    state: LegalProviderStateSchema,
    configured: z.boolean(),
    connectionVerified: z.boolean(),
    canSearch: z.boolean(),
    canFetchSource: z.boolean(),
    toolUseAllowed: z.boolean(),
    technicalPoc: z
      .object({
        enabled: z.boolean(),
        environment: z.enum(["development", "test"]).nullable(),
        connectionPassed: z.boolean(),
        userAuthorized: z.boolean(),
        durable: z.literal(false),
      })
      .strict(),
    reason: SafeStatusReasonSchema.nullable(),
    dataUsePolicy: SourceDataUsePolicyV11Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const ready = value.state === "ready";
    const pocAllowed =
      value.technicalPoc.enabled &&
      value.technicalPoc.environment !== null &&
      value.technicalPoc.connectionPassed &&
      value.technicalPoc.userAuthorized;
    if (
      ready !==
      (value.configured &&
        value.connectionVerified &&
        value.canSearch &&
        value.canFetchSource)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message:
          "ready requires configured, verified search and source-fetch capability; non-ready states must remain unusable",
      });
    }
    if (
      value.state === "configured_unverified" &&
      (!value.configured || value.connectionVerified)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["connectionVerified"],
        message: "configured_unverified must remain unverified",
      });
    }
    if (
      value.state === "not_configured" &&
      (value.configured || value.connectionVerified)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["configured"],
        message: "not_configured cannot report configuration or verification",
      });
    }
    if ((value.reason === null) !== ready) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "ready has no failure reason and non-ready states require one",
      });
    }
    if (!ready && (value.canSearch || value.canFetchSource)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canSearch"],
        message: "non-ready provider states cannot expose usable capabilities",
      });
    }
    if (value.toolUseAllowed !== (ready || pocAllowed)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["toolUseAllowed"],
        message:
          "tool use requires ready status or an explicit connected and user-authorized development/test PoC",
      });
    }
    if (
      value.technicalPoc.enabled &&
      (ready ||
        ![
          "configured_unverified",
          "license_restricted",
          "activation_gate_closed",
        ].includes(value.state))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["technicalPoc", "enabled"],
        message:
          "technical PoC mode remains non-ready and is limited to explicit non-production provider states",
      });
    }
    if (
      !value.technicalPoc.enabled &&
      (value.technicalPoc.environment !== null ||
        value.technicalPoc.connectionPassed ||
        value.technicalPoc.userAuthorized)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["technicalPoc"],
        message: "disabled technical PoC state cannot retain active grants",
      });
    }
    if (
      ready &&
      (value.dataUsePolicy.basis !== "deployment_contract" ||
        !["full_text_ttl", "full_text_permitted"].includes(
          value.dataUsePolicy.retention,
        ) ||
        !["local_only", "permitted"].includes(value.dataUsePolicy.modelUse) ||
        !["exact_quotes_only", "reviewed_work_product", "permitted"].includes(
          value.dataUsePolicy.export,
        ))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dataUsePolicy"],
        message:
          "ready requires declared full-text retention and model-use rights",
      });
    }
  });

export type LegalProviderState = z.infer<typeof LegalProviderStateSchema>;
export type LegalProviderContext = z.infer<typeof LegalProviderContextSchema>;
export type LegalSearchRequest = z.infer<typeof LegalSearchRequestSchema>;
export type LegalProviderSearchItem = z.infer<
  typeof LegalProviderSearchItemSchema
>;
export type LegalSearchResponse = z.infer<typeof LegalSearchResponseSchema>;
export type LegalSourceFetchRequest = z.infer<
  typeof LegalSourceFetchRequestSchema
>;
export type LegalSourceDocument = z.infer<typeof LegalSourceDocumentSchema>;
export type LegalResearchProviderStatus = z.infer<
  typeof LegalResearchProviderStatusSchema
>;

export interface LegalResearchProvider {
  readonly id: string;
  readonly runtime: "production" | "test";
  readonly transport: LegalResearchProviderTransport;
  status(context: LegalProviderContext): Promise<LegalResearchProviderStatus>;
  search(
    request: LegalSearchRequest,
    signal: AbortSignal,
  ): Promise<LegalSearchResponse>;
  fetchSource(
    request: LegalSourceFetchRequest,
    signal: AbortSignal,
  ): Promise<LegalSourceDocument>;
}

export class LegalResearchProviderError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code:
      | "provider_not_registered"
      | "provider_not_ready"
      | "provider_response_invalid"
      | "test_provider_rejected",
    message: string,
    options: Readonly<{ retryable?: boolean; cause?: unknown }> = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LegalResearchProviderError";
    this.retryable = options.retryable ?? false;
  }
}

function abortError(): Error {
  const error = new Error("Legal research request was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function parseProviderStatus(
  provider: LegalResearchProvider,
  value: unknown,
): LegalResearchProviderStatus {
  const parsed = LegalResearchProviderStatusSchema.safeParse(value);
  if (!parsed.success || parsed.data.providerId !== provider.id) {
    throw new LegalResearchProviderError(
      "provider_response_invalid",
      "Legal research provider returned an invalid status.",
      { cause: parsed.success ? undefined : parsed.error },
    );
  }
  return parsed.data;
}

export class WorkspaceLegalResearchProviderRegistry {
  private readonly providers: ReadonlyMap<string, LegalResearchProvider>;

  private constructor(
    providers: readonly LegalResearchProvider[],
    allowTestProviders: boolean,
  ) {
    if (providers.length === 0) {
      throw new LegalResearchProviderError(
        "provider_not_registered",
        "At least one legal research provider is required.",
      );
    }
    const byId = new Map<string, LegalResearchProvider>();
    for (const provider of providers) {
      const id = ProviderIdSchema.safeParse(provider?.id);
      if (!id.success) {
        throw new LegalResearchProviderError(
          "provider_response_invalid",
          "Legal research provider id is invalid.",
        );
      }
      if (provider.runtime === "test" && !allowTestProviders) {
        throw new LegalResearchProviderError(
          "test_provider_rejected",
          "Test legal research providers require an explicit test registry.",
        );
      }
      if (provider.runtime !== "production" && provider.runtime !== "test") {
        throw new LegalResearchProviderError(
          "provider_response_invalid",
          "Legal research provider runtime is invalid.",
        );
      }
      const transport = LegalResearchProviderTransportSchema.safeParse(
        provider.transport,
      );
      if (
        !transport.success ||
        (provider.runtime === "test") !==
          (transport.success && transport.data.kind === "deterministic_test")
      ) {
        throw new LegalResearchProviderError(
          "provider_response_invalid",
          "Legal research provider runtime and transport are inconsistent.",
          { cause: transport.success ? undefined : transport.error },
        );
      }
      if (byId.has(id.data)) {
        throw new LegalResearchProviderError(
          "provider_response_invalid",
          "Legal research provider ids must be unique.",
        );
      }
      byId.set(id.data, provider);
    }
    this.providers = byId;
  }

  static production(
    providers: readonly LegalResearchProvider[] = [
      new WorkspaceUnavailableLegalResearchProvider(),
    ],
  ): WorkspaceLegalResearchProviderRegistry {
    return new WorkspaceLegalResearchProviderRegistry(providers, false);
  }

  /** Test providers cannot enter a registry without this explicit call site. */
  static forTesting(
    providers: readonly LegalResearchProvider[],
  ): WorkspaceLegalResearchProviderRegistry {
    return new WorkspaceLegalResearchProviderRegistry(providers, true);
  }

  providerIds(): readonly string[] {
    return Object.freeze([...this.providers.keys()]);
  }

  private provider(providerId: string): LegalResearchProvider {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new LegalResearchProviderError(
        "provider_not_registered",
        "Legal research provider is not registered.",
      );
    }
    return provider;
  }

  async status(
    providerId: string,
    context: LegalProviderContext,
  ): Promise<LegalResearchProviderStatus> {
    const provider = this.provider(providerId);
    const parsedContext = LegalProviderContextSchema.parse(context);
    return parseProviderStatus(provider, await provider.status(parsedContext));
  }

  private async usableProvider(
    providerId: string,
    context: LegalProviderContext,
  ): Promise<{
    provider: LegalResearchProvider;
    status: LegalResearchProviderStatus;
  }> {
    const provider = this.provider(providerId);
    const status = await this.status(providerId, context);
    if (!status.toolUseAllowed) {
      throw new LegalResearchProviderError(
        "provider_not_ready",
        `Legal research provider tool use is unavailable (${status.state}).`,
        { retryable: status.state === "temporarily_unavailable" },
      );
    }
    return { provider, status };
  }

  async search(input: {
    providerId: string;
    context: LegalProviderContext;
    request: LegalSearchRequest;
    signal: AbortSignal;
  }): Promise<{
    status: LegalResearchProviderStatus;
    response: LegalSearchResponse;
  }> {
    throwIfAborted(input.signal);
    const { provider, status } = await this.usableProvider(
      input.providerId,
      input.context,
    );
    const request = LegalSearchRequestSchema.parse(input.request);
    const raw = await provider.search(request, input.signal);
    throwIfAborted(input.signal);
    const parsed = LegalSearchResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.results.length > request.limit) {
      throw new LegalResearchProviderError(
        "provider_response_invalid",
        "Legal research provider returned an invalid or oversized search response.",
        { cause: parsed.success ? undefined : parsed.error },
      );
    }
    return { status, response: parsed.data };
  }

  async fetchSource(input: {
    providerId: string;
    context: LegalProviderContext;
    request: LegalSourceFetchRequest;
    signal: AbortSignal;
  }): Promise<{
    status: LegalResearchProviderStatus;
    document: LegalSourceDocument;
  }> {
    throwIfAborted(input.signal);
    const { provider, status } = await this.usableProvider(
      input.providerId,
      input.context,
    );
    const request = LegalSourceFetchRequestSchema.parse(input.request);
    const raw = await provider.fetchSource(request, input.signal);
    throwIfAborted(input.signal);
    const parsed = LegalSourceDocumentSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.providerSourceId !== request.providerSourceId ||
      createHash("sha256").update(parsed.data.content, "utf8").digest("hex") !==
        parsed.data.contentSha256
    ) {
      throw new LegalResearchProviderError(
        "provider_response_invalid",
        "Legal research provider returned an invalid source document.",
        { cause: parsed.success ? undefined : parsed.error },
      );
    }
    return { status, document: parsed.data };
  }
}

const CLOSED_POLICY: SourceDataUsePolicyV11 = Object.freeze({
  basis: "not_declared",
  retention: "not_declared",
  export: "not_declared",
  modelUse: "not_declared",
});

export class WorkspaceUnavailableLegalResearchProvider implements LegalResearchProvider {
  readonly id = UNAVAILABLE_LEGAL_RESEARCH_PROVIDER_ID;
  readonly runtime = "production" as const;
  readonly transport = Object.freeze({ kind: "unavailable" as const });

  async status(
    _context: LegalProviderContext,
  ): Promise<LegalResearchProviderStatus> {
    return {
      providerId: this.id,
      state: "activation_gate_closed",
      configured: false,
      connectionVerified: false,
      canSearch: false,
      canFetchSource: false,
      toolUseAllowed: false,
      technicalPoc: {
        enabled: false,
        environment: null,
        connectionPassed: false,
        userAuthorized: false,
        durable: false,
      },
      reason:
        "No authorized legal provider has completed endpoint, credential, rights, and live acceptance.",
      dataUsePolicy: CLOSED_POLICY,
    };
  }

  async search(
    _request: LegalSearchRequest,
    signal: AbortSignal,
  ): Promise<LegalSearchResponse> {
    throwIfAborted(signal);
    throw new LegalResearchProviderError(
      "provider_not_ready",
      "Authorized legal research is not available.",
    );
  }

  async fetchSource(
    _request: LegalSourceFetchRequest,
    signal: AbortSignal,
  ): Promise<LegalSourceDocument> {
    throwIfAborted(signal);
    throw new LegalResearchProviderError(
      "provider_not_ready",
      "Authorized legal source retrieval is not available.",
    );
  }
}
