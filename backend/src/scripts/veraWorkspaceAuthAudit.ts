import { strict as assert } from "node:assert";
import type { NextFunction, Request, Response } from "express";

import {
  WORKSPACE_API_ROUTE_PREFIX,
  WORKSPACE_AUTH_KIND,
  WORKSPACE_LOCAL_PRINCIPAL_ID,
  authenticateWorkspaceRequest,
  constantTimeTokenEqual,
  createWorkspaceAuthMiddleware,
  isLoopbackRemoteAddress,
  parseWorkspaceBearerToken,
  resolveWorkspaceAuthConfiguration,
  workspaceRequestRemoteAddress,
  workspaceRouteAllowed,
} from "../middleware/workspaceAuth";

const VALID_TOKEN = "vera-workspace-bootstrap-token-0123456789";
const WRONG_TOKEN = "wrong-workspace-bootstrap-token-012345";

type FakeResponse = Response & {
  statusCode: number;
  body: unknown | null;
  locals: Record<string, unknown>;
};

function fakeRequest(
  overrides: Partial<Request> & {
    authorization?: string | string[];
    rawHeaders?: string[];
    remoteAddress?: string | undefined;
    connectionRemoteAddress?: string | undefined;
    forwardedFor?: string | undefined;
    origin?: string | undefined;
  } = {},
): Request {
  return {
    originalUrl:
      overrides.originalUrl ?? `${WORKSPACE_API_ROUTE_PREFIX}/projects`,
    headers: {
      authorization: overrides.authorization,
      ...(overrides.forwardedFor === undefined
        ? {}
        : { "x-forwarded-for": overrides.forwardedFor }),
      ...(overrides.origin === undefined ? {} : { origin: overrides.origin }),
    },
    rawHeaders: overrides.rawHeaders ?? [],
    socket:
      overrides.remoteAddress === undefined
        ? undefined
        : { remoteAddress: overrides.remoteAddress },
    connection:
      overrides.connectionRemoteAddress === undefined
        ? undefined
        : { remoteAddress: overrides.connectionRemoteAddress },
    query: overrides.query ?? {},
    cookies:
      (overrides as Request & { cookies?: Record<string, string> }).cookies ??
      {},
    body: overrides.body ?? {},
  } as unknown as Request;
}

function fakeResponse(): FakeResponse {
  const response = {
    statusCode: 200,
    body: null as unknown | null,
    locals: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return response as unknown as FakeResponse;
}

function invokeMiddleware(
  middleware: ReturnType<typeof createWorkspaceAuthMiddleware>,
  request: Request,
) {
  const response = fakeResponse();
  let nextCalled = false;
  const next: NextFunction = () => {
    nextCalled = true;
  };
  middleware(request, response, next);
  return { response, nextCalled };
}

function assertNoSecret(value: unknown, secret: string) {
  assert.equal(JSON.stringify(value).includes(secret), false);
}

function assertErrorEnvelope(
  value: unknown,
  expected: {
    code: "UNAUTHORIZED" | "NOT_FOUND" | "INTERNAL_ERROR";
    message: string;
  },
) {
  assert.deepEqual(value, {
    detail: expected.message,
    code: expected.code,
    error: {
      code: expected.code,
      message: expected.message,
      retryable: false,
    },
  });
}

function assertConfigurationAndHelpers() {
  assert.equal(constantTimeTokenEqual(VALID_TOKEN, VALID_TOKEN), true);
  assert.equal(constantTimeTokenEqual(VALID_TOKEN, WRONG_TOKEN), false);
  assert.doesNotThrow(() =>
    constantTimeTokenEqual("short", "a-token-with-different-length"),
  );

  assert.equal(
    workspaceRouteAllowed(fakeRequest({ originalUrl: "/api/v1" })),
    true,
  );
  assert.equal(
    workspaceRouteAllowed(fakeRequest({ originalUrl: "/api/v1/projects?x=1" })),
    true,
  );
  assert.equal(
    workspaceRouteAllowed(fakeRequest({ originalUrl: "/api/v1evil" })),
    false,
  );
  assert.equal(
    workspaceRouteAllowed(fakeRequest({ originalUrl: "/api/v10/projects" })),
    false,
  );

  for (const address of [
    "127.0.0.1",
    "127.12.34.56",
    "127.255.255.255",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::FFFF:127.255.255.255",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
  ]) {
    assert.equal(isLoopbackRemoteAddress(address), true, address);
  }
  for (const address of [
    "0.0.0.0",
    "127.0.0.256",
    "127.00.0.1",
    "127.0.0.1:3001",
    " 127.0.0.1",
    "127.0.0.1 ",
    "192.168.1.10",
    "::",
    "::2",
    "::ffff:0.0.0.0",
    "::ffff:10.0.0.7",
    "::127.0.0.1",
    "[::1]",
    "::1%lo0",
    "localhost",
    "",
  ]) {
    assert.equal(isLoopbackRemoteAddress(address), false, address);
  }

  assert.equal(
    workspaceRequestRemoteAddress(fakeRequest({ remoteAddress: "127.0.0.1" })),
    "127.0.0.1",
  );
  assert.equal(workspaceRequestRemoteAddress(fakeRequest()), null);
  assert.equal(
    workspaceRequestRemoteAddress(
      fakeRequest({ connectionRemoteAddress: "127.0.0.1" }),
    ),
    null,
  );

  const defaultConfiguration = resolveWorkspaceAuthConfiguration({
    ALETHEIA_PRIVATE_AUTH_TOKEN: VALID_TOKEN,
  });
  assert.equal(
    "kind" in defaultConfiguration && defaultConfiguration.kind,
    "private_token",
  );

  const devSingleUser = resolveWorkspaceAuthConfiguration({
    ALETHEIA_AUTH_MODE: "single_user",
    NODE_ENV: "development",
    VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV: "true",
  });
  assert.equal(
    "kind" in devSingleUser && devSingleUser.kind,
    "single_user_dev",
  );

  for (const configuration of [
    resolveWorkspaceAuthConfiguration({
      ALETHEIA_AUTH_MODE: "single_user",
      NODE_ENV: "development",
    }),
    resolveWorkspaceAuthConfiguration({
      ALETHEIA_AUTH_MODE: "single_user",
      NODE_ENV: "production",
      VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV: "true",
    }),
    resolveWorkspaceAuthConfiguration({
      ALETHEIA_AUTH_MODE: "single_user",
      NODE_ENV: " Production ",
      VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV: "true",
    }),
    resolveWorkspaceAuthConfiguration({
      ALETHEIA_AUTH_MODE: "unexpected_mode",
      ALETHEIA_PRIVATE_AUTH_TOKEN: VALID_TOKEN,
    }),
    resolveWorkspaceAuthConfiguration({
      ALETHEIA_PRIVATE_AUTH_TOKEN: "short-token",
    }),
    resolveWorkspaceAuthConfiguration({
      ALETHEIA_PRIVATE_AUTH_TOKEN: "x".repeat(31),
    }),
  ]) {
    assert.equal("ok" in configuration && configuration.ok, false);
    if ("ok" in configuration && configuration.ok === false) {
      assert.equal(configuration.code, "INTERNAL_ERROR");
      assert.equal(
        configuration.message,
        "Workspace API authentication is not configured.",
      );
    }
  }
}

function assertBearerParsingAndFailures() {
  const parsed = parseWorkspaceBearerToken(
    fakeRequest({ authorization: `Bearer ${VALID_TOKEN}` }),
  );
  assert.deepEqual(parsed, { ok: true, token: VALID_TOKEN });

  for (const request of [
    fakeRequest(),
    fakeRequest({ authorization: "Basic abc123" }),
    fakeRequest({ authorization: "Bearer " }),
    fakeRequest({ authorization: "Bearer token with spaces" }),
    fakeRequest({ authorization: `Bearer ${VALID_TOKEN},extra` }),
    fakeRequest({ authorization: `Bearer  ${VALID_TOKEN}` }),
    fakeRequest({
      rawHeaders: [
        "Authorization",
        `Bearer ${VALID_TOKEN}`,
        "Authorization",
        `Bearer ${VALID_TOKEN}`,
      ],
    }),
    fakeRequest({
      rawHeaders: [
        "Authorization",
        `Bearer ${VALID_TOKEN}`,
        "Authorization",
        `Bearer ${WRONG_TOKEN}`,
      ],
    }),
    fakeRequest({
      authorization: [`Bearer ${VALID_TOKEN}`, `Bearer ${WRONG_TOKEN}`],
    }),
  ]) {
    const result = parseWorkspaceBearerToken(request);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assert.equal(result.code, "UNAUTHORIZED");
      assert.equal(result.message, "Workspace API authentication failed.");
      assertNoSecret(result, VALID_TOKEN);
    }
  }
}

function assertAuthenticationHelper() {
  const tokenConfiguration = resolveWorkspaceAuthConfiguration({
    ALETHEIA_PRIVATE_AUTH_TOKEN: VALID_TOKEN,
  });
  assert.equal("kind" in tokenConfiguration, true);
  if (!("kind" in tokenConfiguration)) throw new Error("missing config");

  const success = authenticateWorkspaceRequest(
    fakeRequest({
      authorization: `Bearer ${VALID_TOKEN}`,
      remoteAddress: "127.0.0.1",
    }),
    tokenConfiguration,
  );
  assert.deepEqual(success, { ok: true, authKind: WORKSPACE_AUTH_KIND });

  for (const request of [
    fakeRequest({
      authorization: `Bearer ${WRONG_TOKEN}`,
      remoteAddress: "127.0.0.1",
    }),
    fakeRequest({
      originalUrl: "/api/v1evil",
      authorization: `Bearer ${VALID_TOKEN}`,
      remoteAddress: "127.0.0.1",
    }),
    fakeRequest({
      originalUrl: "/api/v10/projects",
      authorization: `Bearer ${VALID_TOKEN}`,
      remoteAddress: "127.0.0.1",
    }),
  ]) {
    const result = authenticateWorkspaceRequest(request, tokenConfiguration);
    assert.equal(result.ok, false);
  }

  const devConfiguration = resolveWorkspaceAuthConfiguration({
    ALETHEIA_AUTH_MODE: "single_user",
    NODE_ENV: "development",
    VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV: "true",
  });
  assert.equal("kind" in devConfiguration, true);
  if (!("kind" in devConfiguration))
    throw new Error("missing single user config");

  for (const request of [
    fakeRequest({ remoteAddress: "127.0.0.1" }),
    fakeRequest({ remoteAddress: "::1" }),
    fakeRequest({ remoteAddress: "::ffff:127.0.0.1" }),
  ]) {
    assert.deepEqual(authenticateWorkspaceRequest(request, devConfiguration), {
      ok: true,
      authKind: WORKSPACE_AUTH_KIND,
    });
  }

  for (const request of [
    fakeRequest({ remoteAddress: "10.0.0.5" }),
    fakeRequest({ remoteAddress: "203.0.113.9" }),
    fakeRequest(),
  ]) {
    const result = authenticateWorkspaceRequest(request, devConfiguration);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 401);
      assert.equal(result.code, "UNAUTHORIZED");
    }
  }
}

function assertMiddlewarePrivateTokenMode() {
  const middleware = createWorkspaceAuthMiddleware({
    ALETHEIA_AUTH_MODE: "private_token",
    ALETHEIA_PRIVATE_AUTH_TOKEN: VALID_TOKEN,
  });
  const success = invokeMiddleware(
    middleware,
    fakeRequest({
      authorization: `Bearer ${VALID_TOKEN}`,
      remoteAddress: "127.0.0.1",
    }),
  );
  assert.equal(success.nextCalled, true);
  assert.equal(success.response.statusCode, 200);
  assert.equal(success.response.locals.userId, WORKSPACE_LOCAL_PRINCIPAL_ID);
  assert.equal(success.response.locals.authKind, WORKSPACE_AUTH_KIND);
  assertNoSecret(success.response.locals, VALID_TOKEN);

  const requestFailures = [
    fakeRequest({ remoteAddress: "127.0.0.1" }),
    fakeRequest({ authorization: "Basic abc123", remoteAddress: "127.0.0.1" }),
    fakeRequest({
      authorization: `Bearer ${WRONG_TOKEN}`,
      remoteAddress: "127.0.0.1",
    }),
    fakeRequest({
      remoteAddress: "127.0.0.1",
      rawHeaders: [
        "Authorization",
        `Bearer ${VALID_TOKEN}`,
        "Authorization",
        `Bearer ${WRONG_TOKEN}`,
      ],
    }),
    fakeRequest({
      remoteAddress: "127.0.0.1",
      query: { token: VALID_TOKEN },
      cookies: { token: VALID_TOKEN },
      body: { token: VALID_TOKEN },
    }),
  ];

  for (const request of requestFailures) {
    const result = invokeMiddleware(middleware, request);
    assert.equal(result.nextCalled, false);
    assert.equal(result.response.statusCode, 401);
    assertErrorEnvelope(result.response.body, {
      code: "UNAUTHORIZED",
      message: "Workspace API authentication failed.",
    });
    assertNoSecret(result.response.body, VALID_TOKEN);
  }
}

function assertPrivateTokenLoopbackGate() {
  const middleware = createWorkspaceAuthMiddleware({
    ALETHEIA_AUTH_MODE: "private_token",
    ALETHEIA_PRIVATE_AUTH_TOKEN: VALID_TOKEN,
  });

  for (const request of [
    fakeRequest({
      authorization: `Bearer ${VALID_TOKEN}`,
      remoteAddress: "0.0.0.0",
    }),
    fakeRequest({
      authorization: `Bearer ${VALID_TOKEN}`,
      remoteAddress: "198.51.100.7",
    }),
    fakeRequest({
      authorization: `Bearer ${VALID_TOKEN}`,
      remoteAddress: "198.51.100.7",
      forwardedFor: "127.0.0.1",
      origin: "http://localhost:3000",
    }),
    fakeRequest({
      authorization: `Bearer ${VALID_TOKEN}`,
      connectionRemoteAddress: "127.0.0.1",
      forwardedFor: "127.0.0.1",
    }),
  ]) {
    const result = invokeMiddleware(middleware, request);
    assert.equal(result.nextCalled, false);
    assert.equal(result.response.statusCode, 401);
    assertErrorEnvelope(result.response.body, {
      code: "UNAUTHORIZED",
      message: "Workspace API authentication failed.",
    });
    assertNoSecret(result.response.body, VALID_TOKEN);
  }

  const spoofedRemoteHeadersAreIgnored = invokeMiddleware(
    middleware,
    fakeRequest({
      authorization: `Bearer ${VALID_TOKEN}`,
      remoteAddress: "::1",
      forwardedFor: "203.0.113.8",
      origin: "https://attacker.invalid",
    }),
  );
  assert.equal(spoofedRemoteHeadersAreIgnored.nextCalled, true);
}

function assertMiddlewareConfigurationFailures() {
  for (const middleware of [
    createWorkspaceAuthMiddleware({
      ALETHEIA_PRIVATE_AUTH_TOKEN: "short-token",
    }),
    createWorkspaceAuthMiddleware({
      ALETHEIA_AUTH_MODE: "single_user",
      NODE_ENV: "production",
      VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV: "true",
    }),
    createWorkspaceAuthMiddleware({
      ALETHEIA_AUTH_MODE: "unexpected_mode",
      ALETHEIA_PRIVATE_AUTH_TOKEN: VALID_TOKEN,
    }),
  ]) {
    const result = invokeMiddleware(
      middleware,
      fakeRequest({
        authorization: `Bearer ${VALID_TOKEN}`,
        remoteAddress: "127.0.0.1",
      }),
    );
    assert.equal(result.nextCalled, false);
    assert.equal(result.response.statusCode, 500);
    assertErrorEnvelope(result.response.body, {
      code: "INTERNAL_ERROR",
      message: "Workspace API authentication is not configured.",
    });
    assertNoSecret(result.response.body, VALID_TOKEN);
  }
}

function assertSingleUserDevLoopbackGate() {
  const middleware = createWorkspaceAuthMiddleware({
    ALETHEIA_AUTH_MODE: "single_user",
    NODE_ENV: "development",
    VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV: "true",
  });

  for (const request of [
    fakeRequest({ remoteAddress: "127.0.0.1" }),
    fakeRequest({ remoteAddress: "::1" }),
    fakeRequest({ remoteAddress: "::ffff:127.0.0.1" }),
  ]) {
    const result = invokeMiddleware(middleware, request);
    assert.equal(result.nextCalled, true);
    assert.equal(result.response.locals.authKind, WORKSPACE_AUTH_KIND);
  }

  for (const request of [
    fakeRequest({ remoteAddress: "10.0.0.2" }),
    fakeRequest({ remoteAddress: "198.51.100.2" }),
    fakeRequest(),
  ]) {
    const result = invokeMiddleware(middleware, request);
    assert.equal(result.nextCalled, false);
    assert.equal(result.response.statusCode, 401);
    assertErrorEnvelope(result.response.body, {
      code: "UNAUTHORIZED",
      message: "Workspace API authentication failed.",
    });
  }
}

function assertRouteBoundaryAndSerialization() {
  const middleware = createWorkspaceAuthMiddleware({
    ALETHEIA_PRIVATE_AUTH_TOKEN: VALID_TOKEN,
  });

  const notFoundRequests = [
    fakeRequest({
      originalUrl: "/health",
      authorization: `Bearer ${VALID_TOKEN}`,
    }),
    fakeRequest({
      originalUrl: "/api/v1evil",
      authorization: `Bearer ${VALID_TOKEN}`,
      remoteAddress: "127.0.0.1",
    }),
    fakeRequest({
      originalUrl: "/api/v10/projects",
      authorization: `Bearer ${VALID_TOKEN}`,
      remoteAddress: "127.0.0.1",
    }),
  ];

  for (const request of notFoundRequests) {
    const result = invokeMiddleware(middleware, request);
    assert.equal(result.nextCalled, false);
    assert.equal(result.response.statusCode, 404);
    assertErrorEnvelope(result.response.body, {
      code: "NOT_FOUND",
      message: "Workspace API route not found.",
    });
    assertNoSecret(result.response.body, VALID_TOKEN);
  }

  const queryAllowed = invokeMiddleware(
    middleware,
    fakeRequest({
      originalUrl: "/api/v1/projects?x=1",
      authorization: `Bearer ${VALID_TOKEN}`,
      remoteAddress: "127.0.0.1",
    }),
  );
  assert.equal(queryAllowed.nextCalled, true);
  assert.equal(queryAllowed.response.statusCode, 200);
}

assertConfigurationAndHelpers();
assertBearerParsingAndFailures();
assertAuthenticationHelper();
assertMiddlewarePrivateTokenMode();
assertPrivateTokenLoopbackGate();
assertMiddlewareConfigurationFailures();
assertSingleUserDevLoopbackGate();
assertRouteBoundaryAndSerialization();

console.log(
  JSON.stringify(
    {
      ok: true,
      suite: "vera-workspace-auth-v1",
      checks: [
        "private_token enforces exact /api/v1 route boundary and constant-time bearer validation",
        "every auth mode derives locality only from socket.remoteAddress and rejects remote peers",
        "forwarded address and Origin headers cannot grant or revoke Workspace authentication",
        "IPv4 IPv6 and IPv4-mapped loopback literals are accepted while malformed literals fail closed",
        "single_user_dev requires explicit non-production opt-in and loopback remote address",
        "public remote addresses and missing remote addresses fail closed",
        "duplicate malformed missing and wrong authorization headers are rejected",
        "prefix bypass paths like /api/v1evil and /api/v10/projects are rejected",
        "configuration errors fail closed with a uniform INTERNAL_ERROR envelope",
        "error responses dual-write Mike detail/code and the public nested envelope without secret leakage",
      ],
    },
    null,
    2,
  ),
);
