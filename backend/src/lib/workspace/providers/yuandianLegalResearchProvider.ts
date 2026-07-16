import { createHash } from "node:crypto";

import { z } from "zod";

import type { SourceDataUsePolicyV11 } from "../sourceFoundationContractsV11";
import {
  LegalResearchProviderStatusSchema,
  LegalResearchProviderTransportSchema,
  LegalSearchRequestSchema,
  LegalSearchResponseSchema,
  LegalSourceDocumentSchema,
  LegalSourceFetchRequestSchema,
  type LegalProviderContext,
  type LegalResearchProvider,
  type LegalResearchProviderStatus,
  type LegalResearchProviderTransport,
  type LegalSearchRequest,
  type LegalSearchResponse,
  type LegalSourceDocument,
  type LegalSourceFetchRequest,
} from "../services/legalResearchProvider";
import {
  WorkspaceYuanDianMcpAdapter,
  type YuanDianMcpAdapterConfig,
  type YuanDianMcpAdapterDeps,
  type YuanDianMcpSearchItem,
} from "./yuandianMcp";

export const YUANDIAN_LEGAL_RESEARCH_PROVIDER_ID = "yuandian" as const;

const YUANDIAN_MCP_ENDPOINT_REFS = Object.freeze([
  Object.freeze({
    capability: "law" as const,
    endpointRef: "code:yuandian:mcp:law",
  }),
  Object.freeze({
    capability: "case" as const,
    endpointRef: "code:yuandian:mcp:case",
  }),
]);

const CLOSED_POLICY: SourceDataUsePolicyV11 = Object.freeze({
  basis: "not_declared",
  retention: "not_declared",
  export: "not_declared",
  modelUse: "not_declared",
});

const TechnicalPocGrantSchema = z
  .object({
    enabled: z.literal(true),
    environment: z.enum(["development", "test"]),
    userAuthorized: z.literal(true),
  })
  .strict();

const ProviderConfigSchema = z
  .object({
    credentialRef: z.string().min(1).max(196),
    technicalPoc: TechnicalPocGrantSchema,
    timeoutMs: z.number().int().positive().max(30_000).optional(),
    maxResponseBytes: z.number().int().positive().max(2_000_000).optional(),
    maxResults: z.number().int().min(1).max(20).optional(),
  })
  .strict();

export type YuanDianTechnicalPocGrant = z.infer<typeof TechnicalPocGrantSchema>;

export type YuanDianLegalResearchProviderConfig = {
  credentialRef: string;
  technicalPoc: YuanDianTechnicalPocGrant;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxResults?: number;
};

export type YuanDianLegalResearchProviderDeps = YuanDianMcpAdapterDeps & {
  now?: () => Date;
};

function safeParseConfig(
  input: YuanDianLegalResearchProviderConfig,
): z.infer<typeof ProviderConfigSchema> {
  const parsed = ProviderConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      "YuanDian legal research requires an explicit user-authorized development/test technical PoC grant.",
    );
  }
  return parsed.data;
}

function createTransport(
  credentialRef: string,
): LegalResearchProviderTransport {
  return LegalResearchProviderTransportSchema.parse({
    kind: "mcp_https_stream",
    endpointRefs: YUANDIAN_MCP_ENDPOINT_REFS,
    credentialRef,
  });
}

function abortIfNeeded(signal: AbortSignal) {
  if (!signal.aborted) return;
  const error = new Error("YuanDian legal research was cancelled.");
  error.name = "AbortError";
  throw error;
}

function currentTimestamp(now: () => Date) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("YuanDian legal research clock is invalid.");
  }
  return value.toISOString();
}

function matchesRequestedFilters(
  result: YuanDianMcpSearchItem,
  request: LegalSearchRequest,
) {
  if (
    request.jurisdiction !== undefined &&
    result.jurisdiction !== request.jurisdiction
  ) {
    return false;
  }
  if (
    request.dateFrom !== undefined &&
    (result.effectiveDate === undefined ||
      result.effectiveDate < request.dateFrom)
  ) {
    return false;
  }
  if (
    request.dateTo !== undefined &&
    (result.effectiveDate === undefined ||
      result.effectiveDate > request.dateTo)
  ) {
    return false;
  }
  return true;
}

/**
 * Production-shaped provider wrapper for an explicitly authorized technical
 * PoC. Its public status remains activation-gate-closed: a successful
 * development/test connection is not evidence of retention, export, model-use
 * rights, durable capture, or production acceptance.
 */
export class WorkspaceYuanDianLegalResearchProvider implements LegalResearchProvider {
  readonly id = YUANDIAN_LEGAL_RESEARCH_PROVIDER_ID;
  readonly runtime = "production" as const;
  readonly transport: LegalResearchProviderTransport;

  private readonly technicalPoc: YuanDianTechnicalPocGrant;
  private readonly adapter: WorkspaceYuanDianMcpAdapter;
  private readonly now: () => Date;
  private connectionPassed = false;

  constructor(
    rawConfig: YuanDianLegalResearchProviderConfig,
    deps: YuanDianLegalResearchProviderDeps,
  ) {
    const config = safeParseConfig(rawConfig);
    this.technicalPoc = Object.freeze({ ...config.technicalPoc });
    this.transport = createTransport(config.credentialRef);
    const adapterConfig: YuanDianMcpAdapterConfig = {
      credentialRef: config.credentialRef,
      ...(config.timeoutMs === undefined
        ? {}
        : { timeoutMs: config.timeoutMs }),
      ...(config.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: config.maxResponseBytes }),
      ...(config.maxResults === undefined
        ? {}
        : { maxResults: config.maxResults }),
    };
    this.adapter = new WorkspaceYuanDianMcpAdapter(adapterConfig, deps);
    this.now = deps.now ?? (() => new Date());
  }

  async status(
    _context: LegalProviderContext,
  ): Promise<LegalResearchProviderStatus> {
    return LegalResearchProviderStatusSchema.parse({
      providerId: this.id,
      state: "activation_gate_closed",
      configured: true,
      connectionVerified: false,
      canSearch: false,
      canFetchSource: false,
      toolUseAllowed: this.connectionPassed,
      technicalPoc: {
        enabled: true,
        environment: this.technicalPoc.environment,
        connectionPassed: this.connectionPassed,
        userAuthorized: true,
        durable: false,
      },
      reason:
        "Technical PoC only; production activation, durable capture, retention, export, and model-use rights remain closed.",
      dataUsePolicy: CLOSED_POLICY,
    });
  }

  /** Complete one real bounded MCP request before advertising PoC tools. */
  async verifyTechnicalPocConnection(signal: AbortSignal): Promise<void> {
    abortIfNeeded(signal);
    if (this.connectionPassed) return;
    await this.adapter.search(
      {
        query: "中华人民共和国民法典",
        sourceTypes: [
          "statute",
          "regulation",
          "judicial_interpretation",
          "guidance",
        ],
        limit: 1,
      },
      signal,
    );
    abortIfNeeded(signal);
    this.connectionPassed = true;
  }

  async search(
    rawRequest: LegalSearchRequest,
    signal: AbortSignal,
  ): Promise<LegalSearchResponse> {
    abortIfNeeded(signal);
    const request = LegalSearchRequestSchema.parse(rawRequest);
    const response = await this.adapter.search(
      {
        query: request.query,
        ...(request.sourceTypes === undefined
          ? {}
          : { sourceTypes: request.sourceTypes }),
        limit: request.limit,
      },
      signal,
    );
    abortIfNeeded(signal);
    return LegalSearchResponseSchema.parse({
      queryId: response.queryId,
      results: response.results
        .filter((result) => matchesRequestedFilters(result, request))
        .slice(0, request.limit),
    });
  }

  async fetchSource(
    rawRequest: LegalSourceFetchRequest,
    signal: AbortSignal,
  ): Promise<LegalSourceDocument> {
    abortIfNeeded(signal);
    const request = LegalSourceFetchRequestSchema.parse(rawRequest);
    const source = await this.adapter.readSource(
      request.providerSourceId,
      signal,
    );
    abortIfNeeded(signal);
    return LegalSourceDocumentSchema.parse({
      providerSourceId: source.providerSourceId,
      sourceVersionId: null,
      title: source.title,
      sourceType: source.sourceType,
      content: source.content,
      contentSha256: createHash("sha256")
        .update(source.content, "utf8")
        .digest("hex"),
      retrievedAt: currentTimestamp(this.now),
      retentionExpiresAt: null,
      metadata: {
        ...source.metadata,
        provider: YUANDIAN_LEGAL_RESEARCH_PROVIDER_ID,
        technicalPoc: true,
        transient: true,
      },
      locator: source.locator,
    });
  }
}
