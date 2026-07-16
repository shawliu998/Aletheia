import assert from "node:assert/strict";
import test from "node:test";

import {
  VeraLegalSourceApiError,
  createVeraLegalSourceProvider,
  disableVeraLegalSourceProvider,
  enableVeraLegalSourceProvider,
  listVeraLegalSourceProviders,
  parseVeraLegalSourceProvider,
  parseVeraLegalSourceProviderResponse,
  parseVeraLegalSourceProvidersResponse,
  removeVeraLegalSourceSecret,
  saveVeraLegalSourceSecret,
  testVeraLegalSourceProvider,
} from "../src/app/lib/veraLegalSourceApi.ts";

const TOKEN = "legal-source-client-audit-token-0123456789";
const API_BASE = "http://127.0.0.1:43123/api/v1";
const ID = "018f3b20-7788-7abc-8def-0123456789ab";
const SCHEMA = "vera-workspace-legal-provider-hub-v1";

function capabilities() {
  return [
    { capability: "law", enabled: true },
    { capability: "case", enabled: true },
    { capability: "company", enabled: false },
  ];
}

function passedTest() {
  return {
    status: "passed",
    error_code: null,
    retryable: false,
    latency_ms: 42,
    tested_at: "2026-07-16T01:02:03.004Z",
  };
}

function failedTest(error_code = "authentication_failed") {
  return {
    status: "failed",
    error_code,
    retryable: false,
    latency_ms: null,
    tested_at: "2026-07-16T01:02:03.004Z",
  };
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    provider: "yuandian",
    endpoint_set_id: "yuandian-official-mcp-v1",
    enabled: true,
    credential_configured: true,
    usage_policy: {
      retention: "not_declared",
      local_processing: "transient_only",
      model_use: "prohibited_pending_authorization",
      export: "prohibited_pending_authorization",
    },
    capabilities: capabilities(),
    revision: 4,
    connection_revision: 3,
    credential_revision: 2,
    connection_test: passedTest(),
    status: "activation_gate_closed",
    ...overrides,
  };
}

const invalidResponse = (error: unknown) =>
  error instanceof VeraLegalSourceApiError &&
  error.status === 502 &&
  error.code === "INVALID_RESPONSE";

test("active legal-provider parser accepts the single YuanDian profile and all eight truthful states", () => {
  const parsed = parseVeraLegalSourceProvidersResponse({
    schema_version: SCHEMA,
    providers: [profile()],
  });
  assert.equal(parsed.schema_version, SCHEMA);
  assert.equal(parsed.providers.length, 1);
  assert.equal(parsed.providers[0]?.provider, "yuandian");
  assert.equal(parsed.providers[0]?.status, "activation_gate_closed");
  assert.equal(parsed.providers[0]?.connection_test?.status, "passed");

  const fixtures = [
    profile({ status: "unavailable" }),
    profile({
      status: "not_configured",
      enabled: false,
      credential_configured: false,
      connection_test: null,
    }),
    profile({
      status: "configured_unverified",
      enabled: false,
      connection_test: null,
    }),
    profile({ status: "ready" }),
    profile({
      status: "authentication_failed",
      connection_test: failedTest("authentication_failed"),
    }),
    profile({
      status: "license_restricted",
      connection_test: failedTest("license_restricted"),
    }),
    profile({ status: "activation_gate_closed" }),
    profile({
      status: "temporarily_unavailable",
      connection_test: failedTest("timeout"),
    }),
  ];
  assert.deepEqual(
    fixtures.map((fixture) => parseVeraLegalSourceProvider(fixture).status),
    [
      "unavailable",
      "not_configured",
      "configured_unverified",
      "ready",
      "authentication_failed",
      "license_restricted",
      "activation_gate_closed",
      "temporarily_unavailable",
    ],
  );

  assert.equal(
    parseVeraLegalSourceProviderResponse({
      schema_version: SCHEMA,
      profile: profile(),
    }).profile.status,
    "activation_gate_closed",
  );
});

test("passed test remains activation_gate_closed and is never promoted by the client", () => {
  const closed = parseVeraLegalSourceProvider(profile());
  assert.equal(closed.connection_test?.status, "passed");
  assert.equal(closed.status, "activation_gate_closed");
  assert.notEqual(closed.status, "ready");

  assert.throws(
    () =>
      parseVeraLegalSourceProvider(
        profile({ status: "ready", enabled: false }),
      ),
    invalidResponse,
  );
  assert.throws(
    () =>
      parseVeraLegalSourceProvider(
        profile({ status: "ready", connection_test: null }),
      ),
    invalidResponse,
  );
});

test("parser rejects fake providers, incomplete capability sets, contradictions, and sensitive or raw transport fields", () => {
  for (const sensitiveField of [
    "secret",
    "credential_reference",
    "credentialRef",
    "endpoint",
    "endpoint_url",
    "raw_url",
    "mcp_schema",
  ]) {
    assert.throws(
      () =>
        parseVeraLegalSourceProvider({
          ...profile(),
          [sensitiveField]: "must-not-cross-wire",
        }),
      invalidResponse,
      sensitiveField,
    );
  }

  for (const invalid of [
    profile({ provider: "pkulaw" }),
    profile({ endpoint_set_id: "https://raw.vendor.example/mcp" }),
    profile({ capabilities: capabilities().slice(0, 2) }),
    profile({
      capabilities: [capabilities()[0], capabilities()[0], capabilities()[2]],
    }),
    profile({ connection_revision: 5 }),
    profile({ credential_revision: 4 }),
    profile({
      usage_policy: {
        retention: "no_retention",
        local_processing: "transient_only",
        model_use: "permitted",
        export: "permitted",
      },
    }),
    profile({
      connection_test: {
        ...passedTest(),
        error_code: "transport_error",
      },
    }),
    profile({
      connection_test: {
        ...failedTest(),
        error_code: null,
      },
    }),
    profile({
      status: "configured_unverified",
      connection_test: passedTest(),
    }),
  ]) {
    assert.throws(() => parseVeraLegalSourceProvider(invalid), invalidResponse);
  }

  assert.throws(
    () =>
      parseVeraLegalSourceProvidersResponse({
        schema_version: SCHEMA,
        providers: [
          profile(),
          { ...profile(), id: "118f3b20-7788-7abc-8def-0123456789ab" },
        ],
      }),
    invalidResponse,
  );
  assert.throws(
    () =>
      parseVeraLegalSourceProviderResponse({
        schema_version: SCHEMA,
        profile: { ...profile(), credential_reference: "keychain://leak" },
      }),
    invalidResponse,
  );
});

function installDesktop() {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      aletheiaDesktop: {
        async getInfo() {
          return { workspaceApiUrl: API_BASE };
        },
        async getAuthToken() {
          return TOKEN;
        },
      },
    },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

test("API uses authenticated Active routes and every mutation parses the strict profile envelope", async () => {
  const restoreWindow = installDesktop();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const profileEnvelope = { schema_version: SCHEMA, profile: profile() };
  const queue = [
    { schema_version: SCHEMA, providers: [profile()] },
    profileEnvelope,
    profileEnvelope,
    profileEnvelope,
    profileEnvelope,
    profileEnvelope,
    profileEnvelope,
  ];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), init });
    const body = queue.shift();
    assert(body);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await listVeraLegalSourceProviders();
    await createVeraLegalSourceProvider();
    const secret = "submitted-only-once";
    await saveVeraLegalSourceSecret(ID, 7, secret);
    await removeVeraLegalSourceSecret(ID, 7);
    await testVeraLegalSourceProvider(ID, 7);
    await enableVeraLegalSourceProvider(ID, 7);
    await disableVeraLegalSourceProvider(ID, 7);

    assert.deepEqual(
      calls.map(({ url }) => url),
      [
        `${API_BASE}/legal-providers`,
        `${API_BASE}/legal-providers/yuandian`,
        `${API_BASE}/legal-providers/${ID}/credential`,
        `${API_BASE}/legal-providers/${ID}/credential`,
        `${API_BASE}/legal-providers/${ID}/test`,
        `${API_BASE}/legal-providers/${ID}/enable`,
        `${API_BASE}/legal-providers/${ID}/disable`,
      ],
    );
    assert.deepEqual(
      calls.map(({ init }) => init?.method ?? "GET"),
      ["GET", "POST", "PUT", "DELETE", "POST", "POST", "POST"],
    );
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {});
    assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), {
      expected_revision: 7,
      secret,
    });
    for (const call of calls.slice(3)) {
      assert.deepEqual(JSON.parse(String(call.init?.body)), {
        expected_revision: 7,
      });
    }
    for (const { init } of calls) {
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Bearer ${TOKEN}`,
      );
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreWindow();
  }
});
