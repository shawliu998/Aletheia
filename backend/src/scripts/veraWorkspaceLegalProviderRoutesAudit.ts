import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";

import express, { type Express, type RequestHandler } from "express";

import { WorkspaceApiError } from "../lib/workspace/errors";
import {
  createWorkspaceLegalProvidersV1Router,
  type WorkspaceLegalProviderHubV1Context,
  type WorkspaceLegalProviderHubV1Port,
  type WorkspaceLegalProviderV1Wire,
} from "../routes/workspaceLegalProvidersV1";

const TOKEN = "legal-provider-route-audit-token-0000000000000000";
const SECRET = "legal-provider-route-secret-must-never-return";
const PROFILE_ID = "0195a5a0-7b1d-7000-8000-000000000018";
const PROJECT_ID = "0195a5a0-7b1d-7000-8000-000000000019";

function clone<T>(value: T): T {
  return structuredClone(value);
}

function baseProfile(): WorkspaceLegalProviderV1Wire {
  return {
    id: PROFILE_ID,
    provider: "yuandian",
    endpoint_set_id: "yuandian-official-mcp-v1",
    enabled: false,
    credential_configured: false,
    usage_policy: {
      retention: "not_declared",
      local_processing: "transient_only",
      model_use: "prohibited_pending_authorization",
      export: "prohibited_pending_authorization",
    },
    capabilities: [
      { capability: "law", enabled: true },
      { capability: "case", enabled: true },
      { capability: "company", enabled: false },
    ],
    revision: 0,
    connection_revision: 0,
    credential_revision: 0,
    status: "not_configured",
    connection_test: null,
  };
}

class AuditHub implements WorkspaceLegalProviderHubV1Port {
  profile = baseProfile();
  calls: Array<{ operation: string; context: string; id?: string }> = [];
  failWithSecret = false;
  unsafeOutput = false;

  private record(
    operation: string,
    context: WorkspaceLegalProviderHubV1Context,
    id?: string,
  ) {
    this.calls.push({ operation, context: context.principalId, id });
    if (this.failWithSecret) {
      throw new WorkspaceApiError(409, "CONFLICT", `unsafe ${SECRET}`);
    }
  }

  listProviders(context: WorkspaceLegalProviderHubV1Context) {
    this.record("list", context);
    const profile = clone(this.profile) as WorkspaceLegalProviderV1Wire & {
      credential_reference?: string;
    };
    if (this.unsafeOutput) {
      profile.credential_reference =
        `keychain://vera/legal-provider/${PROFILE_ID}/` + "a".repeat(16);
    }
    return [profile];
  }

  createOrGetYuanDian(context: WorkspaceLegalProviderHubV1Context) {
    this.record("create_or_get", context);
    return { created: true, provider: clone(this.profile) };
  }

  putCredential(
    context: WorkspaceLegalProviderHubV1Context,
    id: string,
    input: { secret: string; expected_revision: number },
  ) {
    this.record("put_credential", context, id);
    assert.equal(input.secret, SECRET);
    assert.equal(input.expected_revision, 0);
    this.profile = {
      ...this.profile,
      credential_configured: true,
      credential_revision: 1,
      connection_revision: 1,
      revision: 1,
      status: "configured_unverified",
      connection_test: null,
    };
    return clone(this.profile);
  }

  deleteCredential(
    context: WorkspaceLegalProviderHubV1Context,
    id: string,
    input: { expected_revision: number },
  ) {
    this.record("delete_credential", context, id);
    assert.equal(input.expected_revision, 3);
    this.profile = {
      ...this.profile,
      credential_configured: false,
      credential_revision: this.profile.credential_revision + 1,
      connection_revision: this.profile.connection_revision + 1,
      revision: this.profile.revision + 1,
      status: "not_configured",
      connection_test: null,
    };
    return clone(this.profile);
  }

  testProvider(
    context: WorkspaceLegalProviderHubV1Context,
    id: string,
    input: { expected_revision: number },
  ) {
    this.record("test", context, id);
    assert.equal(input.expected_revision, 1);
    this.profile = {
      ...this.profile,
      status: "activation_gate_closed",
      connection_test: {
        status: "passed",
        error_code: null,
        retryable: false,
        latency_ms: 24,
        tested_at: "2026-07-16T09:00:00.000Z",
      },
    };
    return clone(this.profile);
  }

  enableProvider(
    context: WorkspaceLegalProviderHubV1Context,
    id: string,
    input: { expected_revision: number },
  ) {
    this.record("enable", context, id);
    assert.equal(input.expected_revision, 1);
    this.profile = {
      ...this.profile,
      enabled: true,
      revision: this.profile.revision + 1,
      status: "ready",
    };
    return clone(this.profile);
  }

  disableProvider(
    context: WorkspaceLegalProviderHubV1Context,
    id: string,
    input: { expected_revision: number },
  ) {
    this.record("disable", context, id);
    assert.equal(input.expected_revision, 2);
    this.profile = {
      ...this.profile,
      enabled: false,
      revision: this.profile.revision + 1,
      status: "activation_gate_closed",
    };
    return clone(this.profile);
  }

  getProjectLegalResearchStatus(
    context: WorkspaceLegalProviderHubV1Context,
    projectId: string,
  ) {
    this.record("project_status", context, projectId);
    return {
      schema_version: "vera-workspace-legal-provider-hub-v1" as const,
      project_id: projectId,
      provider_id: PROFILE_ID,
      status: "ready" as const,
      reason: null,
    };
  }
}

async function withServer<T>(
  app: Express,
  operation: (origin: string) => Promise<T>,
) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bind failed");
  try {
    return await operation(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function auth(): RequestHandler {
  return (request, response, next) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      response.status(401).json({
        error: {
          code: "UNAUTHORIZED",
          message: "Workspace authentication is required.",
        },
      });
      return;
    }
    response.locals.userId = "local-route-audit";
    next();
  };
}

function requestHeaders(token = TOKEN) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

async function requestJson(
  origin: string,
  route: string,
  init: RequestInit = {},
) {
  const response = await fetch(`${origin}/api/v1${route}`, {
    ...init,
    headers: { ...requestHeaders(), ...init.headers },
  });
  const text = await response.text();
  const value = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("pragma"), "no-cache");
  return { response, text, value };
}

function assertTransportSafe(text: string) {
  for (const marker of [
    SECRET,
    "credential_reference",
    "credential_ref",
    "keychain://",
    "https://",
    "http://",
    "tools/list",
    "inputSchema",
  ]) {
    assert.equal(text.includes(marker), false, `response leaked ${marker}`);
  }
}

async function main() {
  const hub = new AuditHub();
  const app = express();
  app.use(express.json({ limit: "4kb" }));
  app.use(
    "/api/v1",
    createWorkspaceLegalProvidersV1Router({ hub, auth: auth() }),
  );

  await withServer(app, async (origin) => {
    const unauthenticated = await fetch(`${origin}/api/v1/legal-providers`);
    assert.equal(unauthenticated.status, 401);
    assert.equal(
      unauthenticated.headers.get("cache-control"),
      "private, no-store",
    );
    assertTransportSafe(await unauthenticated.text());

    const listed = await requestJson(origin, "/legal-providers");
    assert.equal(listed.response.status, 200);
    assert.deepEqual(Object.keys(listed.value).sort(), [
      "providers",
      "schema_version",
    ]);
    assert.equal(
      (listed.value.providers as Array<Record<string, unknown>>)[0]
        ?.connection_test,
      null,
    );
    assertTransportSafe(listed.text);

    const created = await requestJson(origin, "/legal-providers/yuandian", {
      method: "POST",
      body: "{}",
    });
    assert.equal(created.response.status, 201);
    assert.deepEqual(Object.keys(created.value).sort(), [
      "profile",
      "schema_version",
    ]);
    assert.equal("created" in created.value, false);
    assertTransportSafe(created.text);

    const credential = await requestJson(
      origin,
      `/legal-providers/${PROFILE_ID}/credential`,
      {
        method: "PUT",
        body: JSON.stringify({ expected_revision: 0, secret: SECRET }),
      },
    );
    assert.equal(credential.response.status, 200);
    assert.equal(
      (credential.value.profile as Record<string, unknown>)
        .credential_configured,
      true,
    );
    assertTransportSafe(credential.text);

    const tested = await requestJson(
      origin,
      `/legal-providers/${PROFILE_ID}/test`,
      { method: "POST", body: JSON.stringify({ expected_revision: 1 }) },
    );
    assert.equal(
      (
        (tested.value.profile as Record<string, unknown>)
          .connection_test as Record<string, unknown>
      ).status,
      "passed",
    );
    assert.equal(
      (tested.value.profile as Record<string, unknown>).status,
      "activation_gate_closed",
      "a passed connection test is not automatically ready",
    );
    assertTransportSafe(tested.text);

    for (const [action, expectedRevision] of [
      ["enable", 1],
      ["disable", 2],
    ] as const) {
      const result = await requestJson(
        origin,
        `/legal-providers/${PROFILE_ID}/${action}`,
        {
          method: "POST",
          body: JSON.stringify({ expected_revision: expectedRevision }),
        },
      );
      assert.equal(result.response.status, 200);
      assertTransportSafe(result.text);
    }

    const projectStatus = await requestJson(
      origin,
      `/projects/${PROJECT_ID}/legal-research/status`,
    );
    assert.equal(projectStatus.response.status, 200);
    assert.deepEqual(Object.keys(projectStatus.value).sort(), [
      "project_id",
      "provider_id",
      "reason",
      "schema_version",
      "status",
    ]);
    assert.equal(projectStatus.value.status, "ready");
    assertTransportSafe(projectStatus.text);

    const deleted = await requestJson(
      origin,
      `/legal-providers/${PROFILE_ID}/credential`,
      { method: "DELETE", body: JSON.stringify({ expected_revision: 3 }) },
    );
    assert.equal(
      (deleted.value.profile as Record<string, unknown>).credential_configured,
      false,
    );

    for (const [route, init] of [
      ["/legal-providers?unexpected=true", {}],
      ["/legal-providers/yuandian", { method: "POST", body: '{"extra":1}' }],
      [
        `/legal-providers/${PROFILE_ID}/credential`,
        { method: "PUT", body: '{"secret":"bad\\nvalue"}' },
      ],
      ["/legal-providers/not-a-uuid/test", { method: "POST", body: "{}" }],
    ] as const) {
      const invalid = await requestJson(origin, route, init);
      assert.equal(invalid.response.status, 400);
      assertTransportSafe(invalid.text);
    }

    hub.unsafeOutput = true;
    const unsafeOutput = await requestJson(origin, "/legal-providers");
    assert.equal(unsafeOutput.response.status, 500);
    assertTransportSafe(unsafeOutput.text);
    hub.unsafeOutput = false;

    hub.failWithSecret = true;
    const unsafeError = await requestJson(origin, "/legal-providers");
    assert.equal(unsafeError.response.status, 409);
    assertTransportSafe(unsafeError.text);
    hub.failWithSecret = false;

    assert.deepEqual(
      new Set(hub.calls.map((call) => call.context)),
      new Set(["local-route-audit"]),
    );
  });

  const source = readFileSync(
    path.join(process.cwd(), "src/routes/workspaceLegalProvidersV1.ts"),
    "utf8",
  );
  assert.equal(source.includes('router.get("/api/v1'), false);
  assert.equal(source.includes('router.post("/api/v1'), false);
  assert.equal(source.includes('router.put("/api/v1'), false);
  assert.equal(source.includes('router.delete("/api/v1'), false);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      suite: "vera-workspace-legal-provider-routes-v1",
      checks: [
        "authenticated relative /api/v1 routes",
        "strict list, profile mutation, and Project status envelopes",
        "bounded write-only credential request",
        "no-store responses",
        "connection pass does not imply ready",
        "secret, credential reference, URL, and raw MCP schema redaction",
        "safe validation, service, and output failures",
      ],
    })}\n`,
  );
}

void main();
