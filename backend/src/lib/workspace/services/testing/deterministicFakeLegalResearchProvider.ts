import { createHash } from "node:crypto";

import type { SourceDataUsePolicyV11 } from "../../sourceFoundationContractsV11";
import {
  LegalSearchRequestSchema,
  type LegalProviderContext,
  type LegalResearchProvider,
  type LegalResearchProviderStatus,
  type LegalSearchRequest,
  type LegalSearchResponse,
  type LegalSourceDocument,
  type LegalSourceFetchRequest,
} from "../legalResearchProvider";

export const DETERMINISTIC_FAKE_LEGAL_RESEARCH_PROVIDER_ID =
  "test-deterministic-legal-research" as const;

const TEST_POLICY: SourceDataUsePolicyV11 = Object.freeze({
  basis: "deployment_contract",
  retention: "full_text_permitted",
  export: "reviewed_work_product",
  modelUse: "permitted",
});

const FIXTURES = Object.freeze([
  Object.freeze({
    providerSourceId: "fixture-statute-1",
    sourceVersionId: "fixture-statute-1-v1",
    title: "Deterministic Contract Law Fixture",
    sourceType: "statute" as const,
    content:
      "Article 1. A deterministic legal-source fixture exists only for automated contract tests.",
    metadata: Object.freeze({ jurisdiction: "CN", status: "effective" }),
    locator: Object.freeze({ article: "1" }),
  }),
  Object.freeze({
    providerSourceId: "fixture-case-1",
    sourceVersionId: "fixture-case-1-v1",
    title: "Deterministic Case Fixture",
    sourceType: "case" as const,
    content:
      "The deterministic court fixture is not live legal authority and must never appear in production.",
    metadata: Object.freeze({
      jurisdiction: "CN",
      court: "Test Court",
      caseNumber: "TEST-001",
    }),
    locator: Object.freeze({ paragraph: "1" }),
  }),
]);

function abortIfNeeded(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Deterministic legal research was cancelled.");
  error.name = "AbortError";
  throw error;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The `testingOnly` literal makes every use an explicit test dependency. The
 * production registry independently rejects this provider's `runtime` tag.
 */
export function createDeterministicFakeLegalResearchProvider(input: {
  testingOnly: true;
  state?: "ready" | "configured_unverified" | "authentication_failed";
  onSignal?: (signal: AbortSignal) => void;
}): LegalResearchProvider {
  if (input?.testingOnly !== true) {
    throw new Error("Deterministic legal research provider is test-only.");
  }
  const state = input.state ?? "ready";
  return {
    id: DETERMINISTIC_FAKE_LEGAL_RESEARCH_PROVIDER_ID,
    runtime: "test",
    transport: Object.freeze({ kind: "deterministic_test" }),
    async status(
      _context: LegalProviderContext,
    ): Promise<LegalResearchProviderStatus> {
      const ready = state === "ready";
      return {
        providerId: DETERMINISTIC_FAKE_LEGAL_RESEARCH_PROVIDER_ID,
        state,
        configured: true,
        connectionVerified: ready,
        canSearch: ready,
        canFetchSource: ready,
        toolUseAllowed: ready,
        technicalPoc: {
          enabled: false,
          environment: null,
          connectionPassed: false,
          userAuthorized: false,
          durable: false,
        },
        reason: ready ? null : `Deterministic test state: ${state}.`,
        dataUsePolicy: TEST_POLICY,
      };
    },
    async search(
      rawRequest: LegalSearchRequest,
      signal: AbortSignal,
    ): Promise<LegalSearchResponse> {
      input.onSignal?.(signal);
      abortIfNeeded(signal);
      const request = LegalSearchRequestSchema.parse(rawRequest);
      const query = request.query.toLocaleLowerCase("en-US");
      const matched = FIXTURES.filter((fixture) => {
        if (
          request.sourceTypes &&
          !request.sourceTypes.includes(fixture.sourceType)
        ) {
          return false;
        }
        return `${fixture.title} ${fixture.content}`
          .toLocaleLowerCase("en-US")
          .includes(query);
      });
      const selected = matched.slice(0, request.limit);
      return {
        queryId: `fake-query-${hash(JSON.stringify(request)).slice(0, 24)}`,
        results: selected.map((fixture) => ({
          providerSourceId: fixture.providerSourceId,
          title: fixture.title,
          sourceType: fixture.sourceType,
          jurisdiction: "CN",
          court: fixture.sourceType === "case" ? "Test Court" : undefined,
          caseNumber: fixture.sourceType === "case" ? "TEST-001" : undefined,
          status: "test_fixture_only",
          summary: "Bounded deterministic metadata for automated tests.",
        })),
      };
    },
    async fetchSource(
      request: LegalSourceFetchRequest,
      signal: AbortSignal,
    ): Promise<LegalSourceDocument> {
      input.onSignal?.(signal);
      abortIfNeeded(signal);
      const fixture = FIXTURES.find(
        (candidate) => candidate.providerSourceId === request.providerSourceId,
      );
      if (!fixture) throw new Error("Deterministic legal source not found.");
      return {
        providerSourceId: fixture.providerSourceId,
        sourceVersionId: fixture.sourceVersionId,
        title: fixture.title,
        sourceType: fixture.sourceType,
        content: fixture.content,
        contentSha256: hash(fixture.content),
        retrievedAt: "2026-01-01T00:00:00.000Z",
        retentionExpiresAt: null,
        metadata: fixture.metadata,
        locator: fixture.locator,
      };
    },
  };
}
