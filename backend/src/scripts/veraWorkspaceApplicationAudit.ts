import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { resolve } from "node:path";
import type { Express } from "express";

import {
  bootstrapVeraApplication,
  createVeraApplication,
  resolveVeraBindConfiguration,
  VeraStartupError,
  type VeraBootstrapDependencies,
  type VeraListeningServer,
  type VeraWorkspaceRuntime,
} from "../veraApplication";

type EventLog = string[];

function fakeRuntime(
  options: {
    events?: EventLog;
    startError?: Error;
    health?: ReturnType<VeraWorkspaceRuntime["health"]>;
    onListProjects?: () => void;
  } = {},
): VeraWorkspaceRuntime {
  const base = {
    async start() {
      options.events?.push("runtime.start");
      if (options.startError) throw options.startError;
    },
    async stop() {
      options.events?.push("runtime.stop");
    },
    health() {
      return (
        options.health ?? {
          started: true,
          draining: false,
          worker: { documentParse: true },
        }
      );
    },
    async listProjects() {
      options.onListProjects?.();
      return { items: [], nextCursor: null };
    },
  };
  return new Proxy(base, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      return async () => {
        throw new Error(`Unexpected fake runtime call: ${String(property)}`);
      };
    },
  }) as unknown as VeraWorkspaceRuntime;
}

function fakeServer(
  events: EventLog,
  options: { hangOnClose?: boolean } = {},
): VeraListeningServer {
  const server = {
    listening: true,
    close(callback?: (error?: Error) => void) {
      events.push("server.close");
      if (!options.hangOnClose) callback?.();
      return server;
    },
    closeAllConnections() {
      events.push("server.closeAllConnections");
    },
    address() {
      return { address: "127.0.0.1", family: "IPv4", port: 43210 };
    },
  };
  return server as unknown as VeraListeningServer;
}

function fakeDependencies(
  events: EventLog,
  options: {
    runtime?: VeraWorkspaceRuntime;
    server?: VeraListeningServer;
    listenError?: Error;
    authFailure?: boolean;
    demo?: () => Promise<unknown>;
  } = {},
): VeraBootstrapDependencies {
  const runtime = options.runtime ?? fakeRuntime({ events });
  const server = options.server ?? fakeServer(events);
  return {
    assertCompliancePolicy() {
      events.push("compliance");
    },
    assertEncryptionPolicy() {
      events.push("encryption");
    },
    resolveAuthConfiguration() {
      events.push("auth.preflight");
      return options.authFailure
        ? {
            ok: false as const,
            status: 500 as const,
            code: "INTERNAL_ERROR" as const,
            message: "sensitive auth configuration detail",
          }
        : { kind: "single_user_dev" as const };
    },
    startAuditAnchor() {
      events.push("audit.start");
      return {
        close: () => {
          events.push("audit.close");
        },
      };
    },
    auditAnchorStatus() {
      return {
        enabled: true,
        healthy: true,
        protection_active: true,
        key_id: "must-not-leak",
        last_error: "/private/database/path",
      };
    },
    auditWriteBlocked() {
      return false;
    },
    createRuntime() {
      events.push("runtime.create");
      return runtime;
    },
    configureDurableRuntime() {
      events.push("durable.start");
      return {
        close: () => {
          events.push("durable.close");
        },
      };
    },
    async closeLocalModelRuntime() {
      events.push("model.close");
    },
    async closeLocalVoiceRuntime() {
      events.push("voice.close");
    },
    runDemoSeed:
      options.demo ??
      (async () => {
        events.push("demo.seed");
      }),
    listen(_app, port, host) {
      events.push(`listen:${host}:${port}`);
      return {
        server,
        ready: options.listenError
          ? Promise.reject(options.listenError)
          : Promise.resolve(),
      };
    },
  };
}

async function withHttpServer(
  app: Express,
  callback: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = await new Promise<Server>((resolveListening, reject) => {
    const listening = app.listen(0, "127.0.0.1", () =>
      resolveListening(listening),
    );
    listening.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
  }
}

function testEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ALETHEIA_AUTH_MODE: "single_user",
    VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV: "true",
    RATE_LIMIT_GENERAL_MAX: "1000",
    TRUST_PROXY_HOPS: "0",
    FRONTEND_URL: "http://127.0.0.1:3000",
    ...overrides,
  };
}

async function auditApplicationSurface(): Promise<void> {
  let listProjectCalls = 0;
  const runtime = fakeRuntime({
    onListProjects: () => {
      listProjectCalls += 1;
    },
  });
  const app = createVeraApplication({
    runtime,
    env: testEnvironment(),
    auditAnchorStatus: () => ({
      enabled: true,
      healthy: true,
      protection_active: true,
      key_id: "secret-key-id",
      last_error: "/Users/private/workspace.db",
      token: "secret-token",
    }),
  });

  await withHttpServer(app, async (baseUrl) => {
    const projects = await fetch(`${baseUrl}/api/v1/projects`, {
      headers: { origin: "http://127.0.0.1:3000" },
    });
    assert.equal(projects.status, 200);
    assert.equal(listProjectCalls, 1, "/api/v1 must dispatch exactly once");
    assert.equal(
      projects.headers.get("access-control-allow-origin"),
      "http://127.0.0.1:3000",
    );

    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const healthText = await health.text();
    assert(!healthText.includes("secret-key-id"));
    assert(!healthText.includes("workspace.db"));
    assert(!healthText.includes("secret-token"));
    const healthBody = JSON.parse(healthText) as {
      vera: { workspace: { pump: { documentParse: boolean } } };
    };
    assert.equal(healthBody.vera.workspace.pump.documentParse, true);

    const malformed = await fetch(`${baseUrl}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(malformed.status, 400);
    assert.deepEqual(await malformed.json(), {
      detail: "The request body is not valid JSON.",
      code: "VALIDATION_ERROR",
      error: {
        code: "VALIDATION_ERROR",
        message: "The request body is not valid JSON.",
        retryable: false,
      },
    });
  });

  const blockedApp = createVeraApplication({
    runtime,
    env: testEnvironment(),
    auditAnchorStatus: () => ({ enabled: true, healthy: false }),
    auditWriteBlocked: () => true,
  });
  await withHttpServer(blockedApp, async (baseUrl) => {
    for (const path of ["/api/v1/projects", "/aletheia/guard-audit"]) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(response.status, 503, `${path} mutation must fail closed`);
      const body = (await response.json()) as {
        detail: string;
        code: string;
        error: { code: string; message: string; retryable: boolean };
      };
      assert.equal(body.code, "INTERNAL_ERROR");
      assert.equal(body.detail, body.error.message);
      assert.equal(body.error.retryable, false);
    }
    const read = await fetch(`${baseUrl}/api/v1/projects`);
    assert.equal(read.status, 200, "read-only requests remain available");
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 503);
  });

  const drainingApp = createVeraApplication({
    runtime,
    env: testEnvironment(),
    auditAnchorStatus: () => ({ enabled: false, healthy: true }),
    isDraining: () => true,
  });
  await withHttpServer(drainingApp, async (baseUrl) => {
    const request = await fetch(`${baseUrl}/api/v1/projects`);
    assert.equal(request.status, 503);
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 503);
    const body = (await health.json()) as {
      vera: { workspace: { draining: boolean } };
    };
    assert.equal(body.vera.workspace.draining, true);
  });

  const id = "00000000-0000-4000-8000-000000000001";
  for (const uploadPath of [
    `/api/v1/documents`,
    `/api/v1/single-documents`,
    `/api/v1/documents/${id}/versions`,
    `/api/v1/projects/${id}/documents`,
    `/api/v1/projects/${id}/documents/${id}/versions`,
  ]) {
    const uploadLimitedApp = createVeraApplication({
      runtime,
      env: testEnvironment({ RATE_LIMIT_UPLOAD_MAX: "1" }),
      auditAnchorStatus: () => ({ enabled: false, healthy: true }),
    });
    await withHttpServer(uploadLimitedApp, async (baseUrl) => {
      const uploadUrl = `${baseUrl}${uploadPath}`;
      const first = await fetch(uploadUrl, { method: "POST" });
      assert.notEqual(first.status, 429);
      const second = await fetch(uploadUrl, { method: "POST" });
      assert.equal(second.status, 429, uploadPath);
      const body = (await second.json()) as { code: string };
      assert.equal(body.code, "RATE_LIMITED");
    });
  }

  assert.throws(
    () =>
      createVeraApplication({
        runtime,
        env: testEnvironment({ TRUST_PROXY_HOPS: "1" }),
      }),
    /TRUST_PROXY_HOPS must be 0/,
  );
}

async function auditBootstrapFailures(): Promise<void> {
  const authEvents: EventLog = [];
  await assert.rejects(
    bootstrapVeraApplication({
      env: testEnvironment(),
      dependencies: fakeDependencies(authEvents, { authFailure: true }),
    }),
    (error: unknown) =>
      error instanceof VeraStartupError &&
      !error.message.includes("sensitive auth configuration detail"),
  );
  assert.deepEqual(authEvents, ["compliance", "encryption", "auth.preflight"]);
  assert(!authEvents.some((event) => event.startsWith("listen:")));

  for (const hostOverride of [
    { HOST: "0.0.0.0" },
    { ALETHEIA_BACKEND_HOST: "::1" },
    { ALETHEIA_BACKEND_HOST: "127.0.0.1", HOST: "localhost" },
  ]) {
    const hostEvents: EventLog = [];
    await assert.rejects(
      bootstrapVeraApplication({
        env: testEnvironment(hostOverride),
        dependencies: fakeDependencies(hostEvents),
      }),
      VeraStartupError,
    );
    assert.equal(hostEvents.length, 0);
  }
  for (const invalidPort of ["NaN", "1.5", "-1", "65536", "0"]) {
    assert.throws(
      () =>
        resolveVeraBindConfiguration(testEnvironment({ PORT: invalidPort })),
      VeraStartupError,
    );
  }
  assert.deepEqual(
    resolveVeraBindConfiguration(testEnvironment(), {
      port: 0,
      allowPortZero: true,
    }),
    { host: "127.0.0.1", port: 0 },
  );
  assert.equal(
    resolveVeraBindConfiguration(testEnvironment({ PORT: "65535" })).port,
    65_535,
  );
  const proxyEvents: EventLog = [];
  await assert.rejects(
    bootstrapVeraApplication({
      env: testEnvironment({ TRUST_PROXY_HOPS: "1" }),
      dependencies: fakeDependencies(proxyEvents),
    }),
    /TRUST_PROXY_HOPS must be 0/,
  );
  assert.equal(proxyEvents.length, 0);

  const runtimeEvents: EventLog = [];
  const failedRuntime = fakeRuntime({
    events: runtimeEvents,
    startError: new Error("/private/workspace.db failed"),
  });
  await assert.rejects(
    bootstrapVeraApplication({
      env: testEnvironment(),
      dependencies: fakeDependencies(runtimeEvents, {
        runtime: failedRuntime,
      }),
    }),
  );
  assert.deepEqual(runtimeEvents, [
    "compliance",
    "encryption",
    "auth.preflight",
    "audit.start",
    "runtime.create",
    "runtime.start",
    "runtime.stop",
    "audit.close",
  ]);
  assert(!runtimeEvents.some((event) => event.startsWith("listen:")));

  const listenEvents: EventLog = [];
  await assert.rejects(
    bootstrapVeraApplication({
      env: testEnvironment(),
      dependencies: fakeDependencies(listenEvents, {
        listenError: new Error("EADDRINUSE /private/path"),
      }),
    }),
  );
  assert.deepEqual(listenEvents.slice(-6), [
    "server.close",
    "runtime.stop",
    "durable.close",
    "model.close",
    "voice.close",
    "audit.close",
  ]);
}

async function auditShutdownAndDemo(): Promise<void> {
  const events: EventLog = [];
  const server = fakeServer(events, { hangOnClose: true });
  const application = await bootstrapVeraApplication({
    env: testEnvironment(),
    closeTimeoutMs: 10,
    dependencies: fakeDependencies(events, { server }),
  });
  assert.deepEqual(events.slice(0, 8), [
    "compliance",
    "encryption",
    "auth.preflight",
    "audit.start",
    "runtime.create",
    "runtime.start",
    "durable.start",
    "listen:127.0.0.1:3001",
  ]);
  assert(!events.includes("demo.seed"), "demo seed must be off by default");

  const firstShutdown = application.shutdown();
  const secondShutdown = application.shutdown();
  assert.strictEqual(firstShutdown, secondShutdown, "shutdown is idempotent");
  await firstShutdown;
  assert.deepEqual(events.slice(-7), [
    "server.close",
    "server.closeAllConnections",
    "runtime.stop",
    "durable.close",
    "model.close",
    "voice.close",
    "audit.close",
  ]);

  const demoEvents: EventLog = [];
  const demoApplication = await bootstrapVeraApplication({
    env: testEnvironment({ ALETHEIA_ENABLE_DEMO_SEED: "true" }),
    dependencies: fakeDependencies(demoEvents),
  });
  assert(demoEvents.includes("demo.seed"));
  assert(
    demoEvents.indexOf("demo.seed") <
      demoEvents.findIndex((event) => event.startsWith("listen:")),
    "explicit demo seeding must finish before listen",
  );
  await demoApplication.shutdown();

  const failedDemoEvents: EventLog = [];
  await assert.rejects(
    bootstrapVeraApplication({
      env: testEnvironment({ ALETHEIA_ENABLE_DEMO_SEED: "true" }),
      dependencies: fakeDependencies(failedDemoEvents, {
        demo: async () => {
          failedDemoEvents.push("demo.seed");
          throw new Error("/private/demo-seed.db");
        },
      }),
    }),
  );
  assert(!failedDemoEvents.some((event) => event.startsWith("listen:")));
  assert.deepEqual(failedDemoEvents.slice(-5), [
    "runtime.stop",
    "durable.close",
    "model.close",
    "voice.close",
    "audit.close",
  ]);

  const productionEvents: EventLog = [];
  const productionApplication = await bootstrapVeraApplication({
    env: testEnvironment({
      NODE_ENV: "production",
      ALETHEIA_ENABLE_DEMO_SEED: "true",
    }),
    dependencies: fakeDependencies(productionEvents),
  });
  assert(!productionEvents.includes("demo.seed"));
  await productionApplication.shutdown();
}

async function auditStaticOwnership(): Promise<void> {
  const sourceRoot = resolve(__dirname, "..");
  const applicationSource = readFileSync(
    resolve(sourceRoot, "veraApplication.ts"),
    "utf8",
  );
  const indexSource = readFileSync(resolve(sourceRoot, "index.ts"), "utf8");

  assert(!/process\.(?:on|once)\s*\(/.test(applicationSource));
  assert(!applicationSource.includes("createWorkspaceRuntime()"));
  assert.equal((indexSource.match(/process\.once\(/g) ?? []).length, 2);
  assert(indexSource.includes('process.once("SIGINT"'));
  assert(indexSource.includes('process.once("SIGTERM"'));
  assert(indexSource.includes("if (require.main === module)"));
  assert(!indexSource.includes("Aletheia backend"));
  assert.equal(
    (applicationSource.match(/createWorkspaceV1Router\(/g) ?? []).length,
    1,
    "Workspace router must be constructed exactly once",
  );
  assert.equal(
    (applicationSource.match(/app\.use\(\s*"\/api\/v1"/g) ?? []).length,
    1,
    "Workspace API prefix must be mounted exactly once",
  );
  const healthSource = applicationSource.slice(
    applicationSource.indexOf('app.get("/health"'),
    applicationSource.indexOf("app.use(safeApplicationErrorHandler"),
  );
  assert.equal((healthSource.match(/\btry\s*\{/g) ?? []).length, 1);
  assert.equal((healthSource.match(/\bcatch\s*\{/g) ?? []).length, 1);

  const signalCountsBefore = {
    sigint: process.listenerCount("SIGINT"),
    sigterm: process.listenerCount("SIGTERM"),
  };
  await import("../index");
  assert.deepEqual(
    {
      sigint: process.listenerCount("SIGINT"),
      sigterm: process.listenerCount("SIGTERM"),
    },
    signalCountsBefore,
    "importing the process entry point must not register signals or bootstrap",
  );
  for (const legacyRouter of [
    "aletheiaRouter",
    "legalResearchRouter",
    "legalResearchIssuesRouter",
    "legalOpinionsRouter",
    "litigationRouter",
    "durableAgentRunsRouter",
    "localGovernanceRouter",
    "localModelsRouter",
    "createLocalVoiceRouter()",
    "createAletheiaLocalControlRouter()",
  ]) {
    assert(
      applicationSource.includes(`app.use(\"/aletheia\", ${legacyRouter})`),
      `legacy router missing: ${legacyRouter}`,
    );
  }
}

async function main(): Promise<void> {
  await auditApplicationSurface();
  await auditBootstrapFailures();
  await auditShutdownAndDemo();
  await auditStaticOwnership();
  console.log("Vera workspace application audit passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
