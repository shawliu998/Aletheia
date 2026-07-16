import assert from "node:assert/strict";

import {
  createGuardedYuanDianMcpFetch,
  validateYuanDianMcpEndpoint,
  WorkspaceYuanDianMcpAdapter,
  YUANDIAN_MCP_ENDPOINTS,
  YUANDIAN_MCP_LEGAL_TOOL_ALLOWLIST,
  YUANDIAN_MCP_TIMEOUT_MS,
  YuanDianMcpAdapterError,
  type YuanDianLegalTool,
  type YuanDianMcpClientFactoryInput,
  type YuanDianMcpClientRequestOptions,
  type YuanDianMcpClientSession,
} from "../lib/workspace/providers/yuandianMcp";

const TOKEN = "fixture-only-yuandian-bearer";
const CREDENTIAL_REF = "keychain:workspace:yuandian";
const ARTICLE_ID = "law_264";
const REGULATION_ID = "law";
const CASE_ID = "case_629";

const LAW_SEARCH = {
  structuredContent: {
    data: {
      code: 201,
      extra: {
        fatiao: [
          {
            ftid: ARTICLE_ID,
            fgid: REGULATION_ID,
            fgtitle: "中华人民共和国刑法",
            num: "第二百六十四条",
            content: "盗窃罪法条检索摘要。",
            sxx: "现行有效",
            effect1: "法律",
            location: "中央",
            start: 20240301,
          },
        ],
      },
    },
  },
};

const CASE_SEARCH = {
  content: [
    {
      type: "text",
      text: JSON.stringify({
        code: 201,
        extra: {
          wenshu: [
            {
              scid: CASE_ID,
              title: "吕某盗窃二审刑事判决书",
              content: "本案围绕盗窃罪展开。",
              ah: "（2019）京01刑终629号",
              jbdw: "北京市第一中级人民法院",
              jaDate: 20191223,
              xzqh_p: "北京",
            },
          ],
        },
      }),
    },
  ],
};

const ARTICLE_DETAIL = {
  structuredContent: {
    data: {
      code: 200,
      status: "success",
      data: {
        id: ARTICLE_ID,
        fgid: REGULATION_ID,
        ft_num: "第二百六十四条",
        title: "中华人民共和国刑法第二百六十四条",
        content: "盗窃公私财物，数额较大的，依法追究刑事责任。",
        sxx: "现行有效",
        xljb_1: "法律",
        ssrq: "2024-03-01",
        fbrq: "2023-12-29",
      },
    },
  },
};

const REGULATION_DETAIL = {
  structuredContent: {
    code: 200,
    status: "success",
    data: {
      id: REGULATION_ID,
      fgid: REGULATION_ID,
      title: "中华人民共和国刑法",
      content: "中华人民共和国刑法受控测试正文。",
      sxx: "现行有效",
      xljb_1: "法律",
      ssrq: "2024-03-01",
      fbrq: "2023-12-29",
    },
  },
};

const CASE_DETAIL = {
  structuredContent: {
    data: {
      code: 200,
      status: "success",
      data: [
        {
          id: CASE_ID,
          title: "吕某盗窃二审刑事判决书",
          content: "北京市第一中级人民法院依法作出二审刑事判决。",
          ah: "（2019）京01刑终629号",
          jbdw: "北京市第一中级人民法院",
          cprq: "2019年12月23日",
        },
      ],
    },
  },
};

type RecordedCall = {
  capability: YuanDianMcpClientFactoryInput["capability"];
  endpoint: string;
  authorizationHeader: string;
  name: YuanDianLegalTool;
  arguments: Record<string, unknown>;
  connectSignal: AbortSignal;
  callSignal: AbortSignal;
};

function fixtureFor(name: YuanDianLegalTool): unknown {
  if (name === "yuandian_law_vector_search") return LAW_SEARCH;
  if (name === "yuandian_case_vector_search") return CASE_SEARCH;
  if (name === "yuandian_rh_ft_detail") return ARTICLE_DETAIL;
  if (name === "yuandian_rh_fg_detail") return REGULATION_DETAIL;
  return CASE_DETAIL;
}

function recordingFactory(calls: RecordedCall[]) {
  return (input: YuanDianMcpClientFactoryInput): YuanDianMcpClientSession => {
    let connected: YuanDianMcpClientRequestOptions | undefined;
    return {
      async connect(options) {
        connected = options;
      },
      async callTool(request, options) {
        assert.ok(connected);
        calls.push({
          capability: input.capability,
          endpoint: input.endpoint.toString(),
          authorizationHeader: input.authorizationHeader,
          name: request.name,
          arguments: request.arguments,
          connectSignal: connected.signal,
          callSignal: options.signal,
        });
        return fixtureFor(request.name);
      },
      async close() {},
    };
  };
}

function adapter(
  calls: RecordedCall[],
  overrides: Partial<
    ConstructorParameters<typeof WorkspaceYuanDianMcpAdapter>[1]
  > = {},
) {
  return new WorkspaceYuanDianMcpAdapter(
    {
      credentialRef: CREDENTIAL_REF,
      timeoutMs: 1_000,
      maxResponseBytes: 500_000,
      maxResults: 5,
    },
    {
      async resolveCredential(reference) {
        assert.equal(reference, CREDENTIAL_REF);
        return TOKEN;
      },
      createClient: recordingFactory(calls),
      ...overrides,
    },
  );
}

async function assertFixedEndpointsAndToolSurface() {
  assert.equal(YUANDIAN_MCP_TIMEOUT_MS, 20_000);
  assert.deepEqual(YUANDIAN_MCP_ENDPOINTS, {
    law: "https://open.chineselaw.com/mcp/law/stream",
    case: "https://open.chineselaw.com/mcp/case/stream",
    company: "https://open.chineselaw.com/mcp/company/stream",
  });
  assert.deepEqual(YUANDIAN_MCP_LEGAL_TOOL_ALLOWLIST, {
    law: [
      "yuandian_law_vector_search",
      "yuandian_rh_ft_detail",
      "yuandian_rh_fg_detail",
    ],
    case: ["yuandian_case_vector_search", "yuandian_rh_case_details"],
  });
  for (const [capability, endpoint] of Object.entries(YUANDIAN_MCP_ENDPOINTS)) {
    assert.equal(
      validateYuanDianMcpEndpoint(
        capability as keyof typeof YUANDIAN_MCP_ENDPOINTS,
        endpoint,
      ).toString(),
      endpoint,
    );
  }
  for (const invalid of [
    "http://open.chineselaw.com/mcp/law/stream",
    "https://open.chineselaw.com/mcp/law/stream/",
    "https://open.chineselaw.com:443/mcp/law/stream",
    "https://open.chineselaw.com/mcp/law/stream?token=x",
    "https://user:pass@open.chineselaw.com/mcp/law/stream",
    "https://evil.example/mcp/law/stream",
    YUANDIAN_MCP_ENDPOINTS.company,
  ]) {
    assert.throws(() => validateYuanDianMcpEndpoint("law", invalid));
  }
}

async function assertSearchAndReadsAreBounded() {
  const calls: RecordedCall[] = [];
  const subject = adapter(calls);
  const signal = new AbortController().signal;
  const search = await subject.search({ query: "盗窃罪", limit: 2 }, signal);
  assert.match(search.queryId, /^yuandian:[a-f0-9]{64}$/);
  assert.equal(search.results.length, 2);
  assert.deepEqual(
    search.results.map((item) => item.providerSourceId),
    [`yuandian:ftid:${ARTICLE_ID}`, `yuandian:case:${CASE_ID}`],
  );
  assert.equal(search.results[0]?.sourceType, "statute");
  assert.equal(search.results[1]?.caseNumber, "（2019）京01刑终629号");
  assert.equal(JSON.stringify(search).includes("Bearer"), false);

  const article = await subject.readSource(
    `yuandian:ftid:${ARTICLE_ID}`,
    signal,
  );
  const regulation = await subject.readSource(
    `yuandian:fgid:${REGULATION_ID}`,
    signal,
  );
  const legalCase = await subject.readSource(
    `yuandian:case:${CASE_ID}`,
    signal,
  );
  assert.equal(article.locator.article, "第二百六十四条");
  assert.equal(article.providerSourceId, `yuandian:ftid:${ARTICLE_ID}`);
  assert.equal(regulation.providerSourceId, `yuandian:fgid:${REGULATION_ID}`);
  assert.equal(legalCase.providerSourceId, `yuandian:case:${CASE_ID}`);
  assert.equal(legalCase.metadata.court, "北京市第一中级人民法院");

  assert.deepEqual(
    calls.map((call) => call.name),
    [
      "yuandian_law_vector_search",
      "yuandian_case_vector_search",
      "yuandian_rh_ft_detail",
      "yuandian_rh_fg_detail",
      "yuandian_rh_case_details",
    ],
  );
  assert.equal(
    calls.some((call) => call.endpoint.includes("/company/")),
    false,
  );
  assert.equal(
    calls.some((call) => call.name === ("tools/list" as YuanDianLegalTool)),
    false,
  );
  for (const call of calls) {
    assert.equal(call.authorizationHeader, `Bearer ${TOKEN}`);
    assert.equal(call.connectSignal, call.callSignal);
    assert.equal(call.connectSignal.aborted, false);
  }
  assert.deepEqual(calls[0]?.arguments, {
    query: "盗窃罪",
    rewrite_flag: false,
    return_num: 2,
  });
  assert.deepEqual(calls[1]?.arguments, {
    query: "盗窃罪",
    rewrite_flag: false,
    wenshu_filter: { dianxing: false },
    return_num: 2,
  });
  assert.deepEqual(calls[2]?.arguments, { id: ARTICLE_ID });
  assert.deepEqual(calls[3]?.arguments, { id: REGULATION_ID });
  assert.deepEqual(calls[4]?.arguments, { id: CASE_ID });
}

async function assertLiveIdShapeCompatibility() {
  const subject = adapter([], {
    createClient() {
      return {
        async connect() {},
        async callTool() {
          return {
            structuredContent: {
              data: {
                code: 201,
                extra: {
                  fatiao: [
                    {
                      ftid: "",
                      fgid: 42,
                      fgtitle: "受控法规记录",
                      content: "受控检索摘要。",
                    },
                  ],
                },
              },
            },
          };
        },
        async close() {},
      };
    },
  });
  const result = await subject.search(
    { query: "受控法规", sourceTypes: ["regulation"], limit: 1 },
    new AbortController().signal,
  );
  assert.equal(result.results[0]?.providerSourceId, "yuandian:fgid:42");
}

async function assertFailClosedInputsAndResponses() {
  assert.throws(
    () =>
      new WorkspaceYuanDianMcpAdapter(
        { credentialRef: "Bearer real-secret" },
        {
          async resolveCredential() {
            return TOKEN;
          },
        },
      ),
    /opaque credential reference/i,
  );
  assert.throws(
    () =>
      new WorkspaceYuanDianMcpAdapter(
        { credentialRef: CREDENTIAL_REF, timeoutMs: 30_001 },
        {
          async resolveCredential() {
            return TOKEN;
          },
        },
      ),
    /timeout is invalid/i,
  );

  const calls: RecordedCall[] = [];
  const subject = adapter(calls);
  await assert.rejects(
    subject.readSource(
      "yuandian:case:../other-matter",
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof YuanDianMcpAdapterError &&
      error.code === "policy_violation",
  );
  await assert.rejects(
    subject.search(
      { query: "x", sourceTypes: ["case", "case"], limit: 1 },
      new AbortController().signal,
    ),
    /source types are invalid/i,
  );

  const oversized = adapter([], {
    createClient() {
      return {
        async connect() {},
        async callTool() {
          return {
            structuredContent: {
              data: {
                code: 201,
                extra: {
                  fatiao: Array.from({ length: 3 }, () => ({
                    ...LAW_SEARCH.structuredContent.data.extra.fatiao[0],
                  })),
                },
              },
            },
          };
        },
        async close() {},
      };
    },
  });
  await assert.rejects(
    oversized.search(
      { query: "x", sourceTypes: ["statute"], limit: 2 },
      new AbortController().signal,
    ),
    /too many search results/i,
  );

  const malformed = adapter([], {
    createClient() {
      return {
        async connect() {},
        async callTool() {
          return {
            structuredContent: {
              data: { code: 201, extra: { fatiao: "bad" } },
            },
          };
        },
        async close() {},
      };
    },
  });
  await assert.rejects(
    malformed.search(
      { query: "x", sourceTypes: ["statute"], limit: 1 },
      new AbortController().signal,
    ),
    /search result list is invalid/i,
  );
}

async function assertCancellationAndSecretSafeFailure() {
  const cancelled = new AbortController();
  cancelled.abort();
  let resolverCalled = false;
  const subject = adapter([], {
    async resolveCredential() {
      resolverCalled = true;
      return TOKEN;
    },
  });
  await assert.rejects(
    subject.search({ query: "cancel", limit: 1 }, cancelled.signal),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(resolverCalled, false);

  const secret = "should-never-cross-error";
  const failing = adapter([], {
    createClient() {
      throw new Error(`upstream included ${secret}`);
    },
  });
  await assert.rejects(
    failing.search(
      { query: "secret safety", sourceTypes: ["statute"], limit: 1 },
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof YuanDianMcpAdapterError &&
      error.code === "transport_error" &&
      !error.message.includes(secret),
  );

  const inFlightController = new AbortController();
  const inFlight = adapter([], {
    createClient() {
      return {
        async connect() {},
        async callTool(_request, options) {
          return new Promise<never>((_resolve, reject) => {
            options.signal.addEventListener(
              "abort",
              () => reject(new Error("cancelled by signal")),
              { once: true },
            );
          });
        },
        async close() {},
      };
    },
  }).search(
    { query: "in-flight cancellation", sourceTypes: ["statute"], limit: 1 },
    inFlightController.signal,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  inFlightController.abort();
  await assert.rejects(
    inFlight,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  const timingOut = new WorkspaceYuanDianMcpAdapter(
    { credentialRef: CREDENTIAL_REF, timeoutMs: 5, maxResults: 1 },
    {
      async resolveCredential() {
        return TOKEN;
      },
      createClient() {
        return {
          async connect() {},
          async callTool() {
            return new Promise<never>(() => undefined);
          },
          async close() {},
        };
      },
    },
  );
  await assert.rejects(
    timingOut.search(
      { query: "timeout", sourceTypes: ["statute"], limit: 1 },
      new AbortController().signal,
    ),
    (error: unknown) =>
      error instanceof YuanDianMcpAdapterError &&
      error.code === "transport_error" &&
      /timed out/i.test(error.message),
  );
}

async function assertStructuralLimits() {
  function subjectFor(result: unknown) {
    return adapter([], {
      createClient() {
        return {
          async connect() {},
          async callTool() {
            return result;
          },
          async close() {},
        };
      },
    });
  }

  await assert.rejects(
    subjectFor({
      structuredContent: {
        code: 201,
        extra: {
          fatiao: [
            {
              ...LAW_SEARCH.structuredContent.data.extra.fatiao[0],
              content: "x".repeat(256 * 1_024 + 1),
            },
          ],
        },
      },
    }).search(
      { query: "oversized string", sourceTypes: ["statute"], limit: 1 },
      new AbortController().signal,
    ),
    /oversized string/i,
  );

  let deep: unknown = "leaf";
  for (let index = 0; index < 14; index += 1) deep = { child: deep };
  await assert.rejects(
    subjectFor({ structuredContent: deep }).search(
      { query: "deep structure", sourceTypes: ["statute"], limit: 1 },
      new AbortController().signal,
    ),
    /structure is too complex/i,
  );

  const nodeBomb = Array.from({ length: 101 }, (_unused, outer) =>
    Object.fromEntries(
      Array.from({ length: 100 }, (_entry, inner) => [
        `k${outer}_${inner}`,
        inner,
      ]),
    ),
  );
  await assert.rejects(
    subjectFor({ structuredContent: nodeBomb }).search(
      { query: "node limit", sourceTypes: ["statute"], limit: 1 },
      new AbortController().signal,
    ),
    /structure is too complex/i,
  );
}

async function assertManualRedirectAndExactTransport() {
  const endpoint = validateYuanDianMcpEndpoint(
    "law",
    YUANDIAN_MCP_ENDPOINTS.law,
  );
  let observedRedirect: RequestRedirect | undefined;
  let observedAuthorization: string | null = null;
  const guarded = createGuardedYuanDianMcpFetch({
    endpoint,
    authorizationHeader: `Bearer ${TOKEN}`,
    maxResponseBytes: 100,
    fetch: (async (_request, init) => {
      observedRedirect = init?.redirect;
      observedAuthorization = new Headers(init?.headers).get("authorization");
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  const response = await guarded(endpoint, { method: "POST" });
  assert.equal(await response.text(), "{}");
  assert.equal(observedRedirect, "manual");
  assert.equal(observedAuthorization, `Bearer ${TOKEN}`);
  await assert.rejects(
    guarded("https://open.chineselaw.com/mcp/company/stream"),
    /unapproved URL/i,
  );

  const redirecting = createGuardedYuanDianMcpFetch({
    endpoint,
    authorizationHeader: `Bearer ${TOKEN}`,
    maxResponseBytes: 100,
    fetch: (async () =>
      new Response(null, {
        status: 302,
        headers: { location: YUANDIAN_MCP_ENDPOINTS.company },
      })) as typeof fetch,
  });
  await assert.rejects(redirecting(endpoint), /redirects are prohibited/i);

  const declaredTooLarge = createGuardedYuanDianMcpFetch({
    endpoint,
    authorizationHeader: `Bearer ${TOKEN}`,
    maxResponseBytes: 100,
    fetch: (async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": "101" },
      })) as typeof fetch,
  });
  await assert.rejects(declaredTooLarge(endpoint), /byte limit/i);
}

async function main() {
  await assertFixedEndpointsAndToolSurface();
  await assertSearchAndReadsAreBounded();
  await assertLiveIdShapeCompatibility();
  await assertFailClosedInputsAndResponses();
  await assertCancellationAndSecretSafeFailure();
  await assertStructuralLimits();
  await assertManualRedirectAndExactTransport();
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      suite: "vera-workspace-yuandian-mcp-audit-v1",
      endpoints: 3,
      legalTools: 5,
      companyEligibleAsAuthority: false,
      toolsListExposed: false,
      timeoutMs: YUANDIAN_MCP_TIMEOUT_MS,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : "YuanDian MCP audit failed."}\n`,
  );
  process.exitCode = 1;
});
