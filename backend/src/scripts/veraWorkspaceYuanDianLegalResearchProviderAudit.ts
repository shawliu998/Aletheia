import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  LegalResearchProviderStatusSchema,
  LegalResearchProviderTransportSchema,
  WorkspaceLegalResearchProviderRegistry,
} from "../lib/workspace/services/legalResearchProvider";
import {
  WorkspaceYuanDianLegalResearchProvider,
  YUANDIAN_LEGAL_RESEARCH_PROVIDER_ID,
} from "../lib/workspace/providers/yuandianLegalResearchProvider";
import type {
  YuanDianLegalTool,
  YuanDianMcpClientFactoryInput,
  YuanDianMcpClientRequestOptions,
  YuanDianMcpClientSession,
} from "../lib/workspace/providers/yuandianMcp";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const ARTICLE_ID = "article_264";
const CREDENTIAL_REF =
  "keychain://vera/legal-provider/99999999-9999-4999-8999-999999999999/fixturelocator0001";
const TOKEN = "fixture-only-yuandian-token";
const FIXED_NOW = "2026-07-16T08:00:00.000Z";

type Call = {
  input: YuanDianMcpClientFactoryInput;
  request: { name: YuanDianLegalTool; arguments: Record<string, unknown> };
  options: YuanDianMcpClientRequestOptions;
};

function resultFor(name: YuanDianLegalTool) {
  if (name === "yuandian_law_vector_search") {
    return {
      structuredContent: {
        data: {
          code: 201,
          extra: {
            fatiao: [
              {
                ftid: ARTICLE_ID,
                fgid: "criminal_law",
                fgtitle: "中华人民共和国刑法",
                num: "第二百六十四条",
                content: "盗窃罪检索摘要。",
                effect1: "法律",
                sxx: "现行有效",
                location: "中央",
                start: 20240301,
              },
            ],
          },
        },
      },
    };
  }
  if (name === "yuandian_case_vector_search") {
    return {
      structuredContent: {
        code: 201,
        extra: { wenshu: [] },
      },
    };
  }
  if (name === "yuandian_rh_ft_detail") {
    return {
      structuredContent: {
        code: 200,
        status: "success",
        data: {
          id: ARTICLE_ID,
          fgid: "criminal_law",
          title: "中华人民共和国刑法第二百六十四条",
          ft_num: "第二百六十四条",
          content: "盗窃公私财物，数额较大的，依法追究刑事责任。",
          xljb_1: "法律",
          sxx: "现行有效",
          ssrq: "2024-03-01",
          fbrq: "2023-12-29",
        },
      },
    };
  }
  throw new Error("Unexpected YuanDian tool in provider audit.");
}

function provider(calls: Call[]) {
  return new WorkspaceYuanDianLegalResearchProvider(
    {
      credentialRef: CREDENTIAL_REF,
      technicalPoc: {
        enabled: true,
        environment: "development",
        userAuthorized: true,
      },
      timeoutMs: 1_000,
      maxResults: 5,
    },
    {
      async resolveCredential(reference) {
        assert.equal(reference, CREDENTIAL_REF);
        return TOKEN;
      },
      createClient(input): YuanDianMcpClientSession {
        let connected: YuanDianMcpClientRequestOptions | undefined;
        return {
          async connect(options) {
            connected = options;
          },
          async callTool(request, options) {
            assert.ok(connected);
            assert.equal(connected.signal, options.signal);
            calls.push({ input, request, options });
            return resultFor(request.name);
          },
          async close() {},
        };
      },
      now: () => new Date(FIXED_NOW),
    },
  );
}

function context() {
  return {
    projectId: PROJECT_ID,
    researchSessionId: "technical-poc-session",
  };
}

async function assertTruthfulStatusAndOpaqueTransport() {
  const subject = provider([]);
  assert.equal(subject.id, YUANDIAN_LEGAL_RESEARCH_PROVIDER_ID);
  assert.equal(subject.runtime, "production");
  const transport = LegalResearchProviderTransportSchema.parse(
    subject.transport,
  );
  assert.equal(transport.kind, "mcp_https_stream");
  if (transport.kind !== "mcp_https_stream") assert.fail("wrong transport");
  assert.deepEqual(transport.endpointRefs, [
    { capability: "law", endpointRef: "code:yuandian:mcp:law" },
    { capability: "case", endpointRef: "code:yuandian:mcp:case" },
  ]);
  assert.equal(transport.credentialRef, CREDENTIAL_REF);
  assert.equal(JSON.stringify(transport).includes("https://"), false);
  assert.equal(JSON.stringify(transport).includes(TOKEN), false);

  const status = LegalResearchProviderStatusSchema.parse(
    await subject.status(context()),
  );
  assert.equal(status.providerId, "yuandian");
  assert.equal(status.state, "activation_gate_closed");
  assert.equal(status.configured, true);
  assert.equal(status.connectionVerified, false);
  assert.equal(status.canSearch, false);
  assert.equal(status.canFetchSource, false);
  assert.equal(status.toolUseAllowed, false);
  assert.deepEqual(status.technicalPoc, {
    enabled: true,
    environment: "development",
    connectionPassed: false,
    userAuthorized: true,
    durable: false,
  });
  assert.deepEqual(status.dataUsePolicy, {
    basis: "not_declared",
    retention: "not_declared",
    export: "not_declared",
    modelUse: "not_declared",
  });
  assert.match(status.reason ?? "", /production activation/i);

  await subject.verifyTechnicalPocConnection(new AbortController().signal);
  const registry = WorkspaceLegalResearchProviderRegistry.production([subject]);
  assert.deepEqual(registry.providerIds(), ["yuandian"]);
  assert.equal(
    (await registry.status("yuandian", context())).toolUseAllowed,
    true,
  );
}

async function assertExplicitGrantOnly() {
  const base = {
    credentialRef: CREDENTIAL_REF,
    technicalPoc: {
      enabled: true,
      environment: "development",
      userAuthorized: true,
    },
  } as const;
  for (const technicalPoc of [
    { ...base.technicalPoc, enabled: false },
    { ...base.technicalPoc, environment: "production" },
    { ...base.technicalPoc, connectionPassed: true },
    { ...base.technicalPoc, userAuthorized: false },
  ]) {
    assert.throws(
      () =>
        new WorkspaceYuanDianLegalResearchProvider(
          { ...base, technicalPoc } as never,
          {
            async resolveCredential() {
              return TOKEN;
            },
          },
        ),
      /explicit user-authorized/i,
    );
  }
  assert.throws(
    () =>
      new WorkspaceYuanDianLegalResearchProvider(
        { ...base, unexpected: true } as never,
        {
          async resolveCredential() {
            return TOKEN;
          },
        },
      ),
    /explicit user-authorized/i,
  );
}

async function assertRegistrySearchAndTransientFetch() {
  const calls: Call[] = [];
  const subject = provider(calls);
  await subject.verifyTechnicalPocConnection(new AbortController().signal);
  calls.length = 0;
  const registry = WorkspaceLegalResearchProviderRegistry.production([subject]);
  const signal = new AbortController().signal;
  const searched = await registry.search({
    providerId: "yuandian",
    context: context(),
    request: {
      query: "盗窃罪",
      jurisdiction: "中央",
      sourceTypes: ["statute"],
      dateFrom: "2024-01-01",
      dateTo: "2024-12-31",
      limit: 2,
    },
    signal,
  });
  assert.equal(searched.status.state, "activation_gate_closed");
  assert.equal(searched.status.toolUseAllowed, true);
  assert.equal(searched.response.results.length, 1);
  assert.deepEqual(searched.response.results[0], {
    providerSourceId: `yuandian:ftid:${ARTICLE_ID}`,
    title: "中华人民共和国刑法第二百六十四条",
    sourceType: "statute",
    jurisdiction: "中央",
    effectiveDate: "2024-03-01",
    status: "现行有效",
    summary: "盗窃罪检索摘要。",
  });

  const fetched = await registry.fetchSource({
    providerId: "yuandian",
    context: context(),
    request: { providerSourceId: `yuandian:ftid:${ARTICLE_ID}` },
    signal,
  });
  const document = fetched.document;
  assert.equal(document.sourceVersionId, null);
  assert.equal(document.retentionExpiresAt, null);
  assert.equal(document.retrievedAt, FIXED_NOW);
  assert.equal(
    document.contentSha256,
    createHash("sha256").update(document.content, "utf8").digest("hex"),
  );
  assert.deepEqual(document.metadata, {
    provider: "yuandian",
    technicalPoc: true,
    transient: true,
    effectiveDate: "2024-03-01",
    publicationDate: "2023-12-29",
    status: "现行有效",
  });
  assert.deepEqual(document.locator, { article: "第二百六十四条" });
  assert.equal(JSON.stringify(document).includes(TOKEN), false);
  assert.equal(JSON.stringify(document).includes("https://"), false);
  assert.deepEqual(
    calls.map((call) => call.request.name),
    ["yuandian_law_vector_search", "yuandian_rh_ft_detail"],
  );
  assert.ok(calls.every((call) => call.options.signal instanceof AbortSignal));
}

async function assertNoFalseFilterMatchesAndCancellation() {
  const subject = provider([]);
  const noMatch = await subject.search(
    {
      query: "盗窃罪",
      jurisdiction: "上海",
      limit: 1,
    },
    new AbortController().signal,
  );
  assert.deepEqual(noMatch.results, []);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    subject.search({ query: "cancel", limit: 1 }, cancelled.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
}

async function main() {
  await assertTruthfulStatusAndOpaqueTransport();
  await assertExplicitGrantOnly();
  await assertRegistrySearchAndTransientFetch();
  await assertNoFalseFilterMatchesAndCancellation();
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      suite: "vera-workspace-yuandian-legal-research-provider-audit-v1",
      providerId: YUANDIAN_LEGAL_RESEARCH_PROVIDER_ID,
      runtime: "production",
      state: "activation_gate_closed",
      technicalPocToolUse: true,
      durable: false,
      rightsDeclared: false,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : "YuanDian provider audit failed."}\n`,
  );
  process.exitCode = 1;
});
