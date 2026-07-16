import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkspaceDatabase } from "../lib/workspace/database";
import { WorkspaceApiError } from "../lib/workspace/errors";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import {
  WorkspaceYuanDianMcpAdapter,
  YuanDianMcpAdapterError,
} from "../lib/workspace/providers/yuandianMcp";
import { WorkspaceLegalProvidersRepository } from "../lib/workspace/repositories/legalProviders";
import {
  type LegalProviderCredentialInput,
  type LegalProviderCredentialStorePort,
} from "../lib/workspace/services/legalProviderCredentialStore";
import {
  type LegalProviderHubProfileView,
  type LegalProviderHubStatus,
  WorkspaceLegalProviderHubService,
} from "../lib/workspace/services/legalProviderHub";

const SECRET_A = "audit-secret-a-never-return";
const SECRET_B = "audit-secret-b-never-return";
const PROFILE_IDS = [
  "0195a5a0-7b1d-7000-8000-000000000101",
  "0195a5a0-7b1d-7000-8000-000000000102",
  "0195a5a0-7b1d-7000-8000-000000000103",
  "0195a5a0-7b1d-7000-8000-000000000104",
  "0195a5a0-7b1d-7000-8000-000000000105",
  "0195a5a0-7b1d-7000-8000-000000000106",
  "0195a5a0-7b1d-7000-8000-000000000107",
  "0195a5a0-7b1d-7000-8000-000000000108",
] as const;
const CONTEXT = { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID } as const;
const STATUS_VOCABULARY = [
  "unavailable",
  "not_configured",
  "configured_unverified",
  "ready",
  "authentication_failed",
  "license_restricted",
  "activation_gate_closed",
  "temporarily_unavailable",
] as const satisfies readonly LegalProviderHubStatus[];

type ProbeMode =
  | "pass"
  | "transport_fail"
  | "license_fail"
  | "abort"
  | "deferred";

class AuditCredentialStore implements LegalProviderCredentialStorePort {
  available = true;
  failDeletes = new Set<string>();
  readonly secrets = new Map<string, string>();
  readonly storeInputs: LegalProviderCredentialInput[] = [];
  readonly resolveInputs: LegalProviderCredentialInput[] = [];
  readonly deleteInputs: LegalProviderCredentialInput[] = [];
  onStore: (() => void) | null = null;

  isAvailable() {
    return this.available;
  }

  async storeLegalProviderCredential(
    input: LegalProviderCredentialInput & { secret: string },
  ) {
    assert.equal(this.secrets.has(input.reference), false);
    this.secrets.set(input.reference, input.secret);
    this.storeInputs.push({
      reference: input.reference,
      binding: input.binding,
    });
    this.onStore?.();
  }

  async resolveLegalProviderCredential(input: LegalProviderCredentialInput) {
    this.resolveInputs.push(input);
    const secret = this.secrets.get(input.reference);
    if (!secret) throw new Error("credential missing");
    return secret;
  }

  async deleteLegalProviderCredential(input: LegalProviderCredentialInput) {
    this.deleteInputs.push(input);
    if (this.failDeletes.has(input.reference)) {
      throw new Error("audit delete failure");
    }
    this.secrets.delete(input.reference);
  }
}

function assertSafeOutput(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(
    serialized,
    /audit-secret|credentialReference|credential_reference/i,
  );
  assert.doesNotMatch(serialized, /keychain:\/\/|https?:\/\//i);
}

function incrementingRepositoryClock() {
  let offset = 0;
  return () => new Date(Date.UTC(2026, 6, 16, 8, 0, 0, offset++)).toISOString();
}

function monotonicClock() {
  let value = 100;
  return () => (value += 11);
}

function abortError() {
  const error = new Error("audit aborted");
  error.name = "AbortError";
  return error;
}

async function expectApiError(
  operation: () => unknown | Promise<unknown>,
  status: number,
  code: WorkspaceApiError["code"],
) {
  await assert.rejects(
    async () => operation(),
    (error: unknown) =>
      error instanceof WorkspaceApiError &&
      error.status === status &&
      error.code === code,
  );
}

const originalEnvironment = { ...process.env };
const root = mkdtempSync(path.join(os.tmpdir(), "vera-provider-hub-audit-"));

async function main() {
  try {
    process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
    const database = new WorkspaceDatabase(path.join(root, "provider-hub.db"));
    const repository = new WorkspaceLegalProvidersRepository(
      database,
      incrementingRepositoryClock(),
    );
    const credentials = new AuditCredentialStore();
    let nextProfile = 0;
    let nextLocator = 0;
    let probeMode: ProbeMode = "pass";
    const deferred = { resolve: null as (() => void) | null };
    let probeCalls = 0;
    let probedCapabilities: readonly ("law" | "case")[] = [];
    const hub = new WorkspaceLegalProviderHubService(repository, credentials, {
      clock: () => new Date("2026-07-16T08:30:00.000Z"),
      monotonicNowMs: monotonicClock(),
      nextProfileId: () => PROFILE_IDS[nextProfile++]!,
      nextCredentialLocatorId: () =>
        `auditlocator${String(nextLocator++).padStart(8, "0")}`,
      createConnectionProbe: (input) => ({
        verify: async (signal) => {
          probeCalls += 1;
          probedCapabilities = input.authorityCapabilities;
          if (probeMode === "abort" || signal.aborted) throw abortError();
          const secret = await input.resolveCredential(
            input.credentialReference,
            signal,
          );
          assert.ok(secret === SECRET_A || secret === SECRET_B);
          if (probeMode === "transport_fail") {
            throw new YuanDianMcpAdapterError(
              "transport_error",
              "audit timed out",
            );
          }
          if (probeMode === "license_fail") {
            throw new YuanDianMcpAdapterError(
              "license_restricted",
              "audit license boundary",
            );
          }
          if (probeMode === "deferred") {
            await new Promise<void>((resolve) => {
              deferred.resolve = resolve;
            });
          }
        },
      }),
    });

    // Create/list/get are deterministic, complete, and never project locators.
    assert.deepEqual(new Set(STATUS_VOCABULARY).size, 8);
    const created = hub.create(CONTEXT);
    assert.equal(created.id, PROFILE_IDS[0]);
    assert.equal(created.status, "not_configured");
    assert.deepEqual(created.capabilities, [
      { capability: "case", enabled: true },
      { capability: "company", enabled: false },
      { capability: "law", enabled: true },
    ]);
    assert.deepEqual(hub.get(CONTEXT, created.id), created);
    assert.deepEqual(hub.list(CONTEXT), [created]);
    assertSafeOutput([created, hub.list(CONTEXT)]);

    // Put, rotate, and delete use opaque one-time locators. Old credentials are
    // deleted and neither the secret nor locator can cross the service boundary.
    let profile = await hub.putCredential(CONTEXT, {
      profileId: created.id,
      expectedRevision: created.revision,
      secret: SECRET_A,
    });
    assert.equal(profile.status, "configured_unverified");
    assert.equal(profile.credentialConfigured, true);
    const firstReference = credentials.storeInputs[0]!.reference;
    assert.equal(credentials.secrets.get(firstReference), SECRET_A);
    assertSafeOutput(profile);

    repository.recordCredentialOrphan({
      reference: firstReference,
      profileId: profile.id,
      provider: "yuandian",
      endpointSetId: "yuandian-official-mcp-v1",
      reason: "profile_write_failed",
    });
    const deletesBeforeActiveGuard = credentials.deleteInputs.length;
    assert.deepEqual(await hub.cleanupCredentialOrphans(CONTEXT), {
      attempted: 1,
      resolved: 1,
    });
    assert.equal(credentials.deleteInputs.length, deletesBeforeActiveGuard);
    assert.equal(credentials.secrets.get(firstReference), SECRET_A);
    assert.equal(repository.listCredentialOrphans().length, 0);

    credentials.failDeletes.add(firstReference);
    profile = await hub.putCredential(CONTEXT, {
      profileId: profile.id,
      expectedRevision: profile.revision,
      secret: SECRET_B,
    });
    const secondReference = credentials.storeInputs[1]!.reference;
    assert.notEqual(firstReference, secondReference);
    assert.equal(credentials.secrets.get(firstReference), SECRET_A);
    assert.equal(credentials.secrets.get(secondReference), SECRET_B);
    assert.equal(
      repository.listCredentialOrphans()[0]?.reason,
      "credential_rotated",
    );
    credentials.failDeletes.delete(firstReference);
    assert.deepEqual(await hub.cleanupCredentialOrphans(CONTEXT), {
      attempted: 1,
      resolved: 1,
    });
    assert.equal(credentials.secrets.has(firstReference), false);
    assert.equal(repository.listCredentialOrphans().length, 0);
    assertSafeOutput(profile);

    const staleRevision = profile.revision - 1;
    await expectApiError(
      () =>
        hub.setEnabled(CONTEXT, {
          profileId: profile.id,
          expectedRevision: staleRevision,
          enabled: true,
        }),
      409,
      "CONFLICT",
    );

    // A passed live probe remains activation-gated and company is never sent to
    // the authority probe even when the capability is persisted as enabled.
    repository.updateProfile({
      id: profile.id,
      expectedRevision: profile.revision,
      enabledCapabilities: ["law", "case", "company"],
    });
    profile = hub.get(CONTEXT, profile.id);
    probeMode = "pass";
    profile = await hub.testConnection(CONTEXT, {
      profileId: profile.id,
      expectedRevision: profile.revision,
      userAuthorized: true,
      signal: new AbortController().signal,
    });
    assert.equal(profile.connectionTest?.status, "passed");
    assert.equal(profile.status, "activation_gate_closed");
    assert.notEqual(profile.status, "ready");
    assert.deepEqual(probedCapabilities, ["case", "law"]);
    assert.equal(credentials.resolveInputs.length, 1);
    assertSafeOutput(profile);

    // Transport and licensing failures map to distinct safe states.
    probeMode = "transport_fail";
    profile = await hub.testConnection(CONTEXT, {
      profileId: profile.id,
      expectedRevision: profile.revision,
      userAuthorized: true,
      signal: new AbortController().signal,
    });
    assert.equal(profile.status, "temporarily_unavailable");
    assert.equal(profile.connectionTest?.errorCode, "timeout");
    assert.equal(profile.connectionTest?.retryable, true);

    probeMode = "license_fail";
    profile = await hub.testConnection(CONTEXT, {
      profileId: profile.id,
      expectedRevision: profile.revision,
      userAuthorized: true,
      signal: new AbortController().signal,
    });
    assert.equal(profile.status, "license_restricted");
    assert.equal(profile.connectionTest?.retryable, false);

    // Abort is propagated and never overwrites the last durable test result.
    const beforeAbort = profile.connectionTest;
    probeMode = "abort";
    await assert.rejects(
      () =>
        hub.testConnection(CONTEXT, {
          profileId: profile.id,
          expectedRevision: profile.revision,
          userAuthorized: true,
          signal: new AbortController().signal,
        }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    assert.deepEqual(hub.get(CONTEXT, profile.id).connectionTest, beforeAbort);

    // The remaining state mappings are persistence-driven and still project no
    // credential material. `ready` is intentionally reserved until activation.
    repository.recordConnectionTest({
      profileId: profile.id,
      connectionRevision: profile.connectionRevision,
      status: "failed",
      errorCode: "authentication_failed",
      retryable: false,
      latencyMs: 9,
      testedAt: "2026-07-16T08:31:00.000Z",
    });
    assert.equal(hub.get(CONTEXT, profile.id).status, "authentication_failed");
    credentials.available = false;
    assert.equal(hub.get(CONTEXT, profile.id).status, "unavailable");
    credentials.available = true;

    // A profile revision changed during an in-flight probe is rejected by CAS.
    probeMode = "deferred";
    const inFlight = hub.testConnection(CONTEXT, {
      profileId: profile.id,
      expectedRevision: profile.revision,
      userAuthorized: true,
      signal: new AbortController().signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const changed = repository.updateProfile({
      id: profile.id,
      expectedRevision: profile.revision,
      enabledCapabilities: ["law"],
    });
    deferred.resolve?.();
    await expectApiError(() => inFlight, 409, "CONFLICT");
    assert.equal(hub.get(CONTEXT, profile.id).revision, changed.revision);

    // Company-only configuration cannot be used as legal authority.
    repository.updateProfile({
      id: profile.id,
      expectedRevision: changed.revision,
      enabledCapabilities: ["company"],
    });
    const companyConfigured = hub.get(CONTEXT, profile.id);
    const callsBeforeCompany = probeCalls;
    await expectApiError(
      () =>
        hub.testConnection(CONTEXT, {
          profileId: companyConfigured.id,
          expectedRevision: companyConfigured.revision,
          userAuthorized: true,
          signal: new AbortController().signal,
        }),
      409,
      "PRECONDITION_FAILED",
    );
    assert.equal(probeCalls, callsBeforeCompany);

    // A credential persisted just before a profile CAS loss is never linked. A
    // failed immediate delete leaves a durable orphan that replay can resolve.
    const raceProfile = companyConfigured;
    let raced = false;
    credentials.onStore = () => {
      if (raced) return;
      raced = true;
      repository.updateProfile({
        id: raceProfile.id,
        expectedRevision: raceProfile.revision,
        enabled: true,
      });
      const candidate = credentials.storeInputs.at(-1)!.reference;
      credentials.failDeletes.add(candidate);
    };
    await expectApiError(
      () =>
        hub.putCredential(CONTEXT, {
          profileId: raceProfile.id,
          expectedRevision: raceProfile.revision,
          secret: SECRET_B,
        }),
      409,
      "CONFLICT",
    );
    credentials.onStore = null;
    const orphan = repository.listCredentialOrphans()[0]!;
    assert.equal(orphan.reason, "profile_write_failed");
    assert.equal(
      repository.getProfile(raceProfile.id)?.credentialReference,
      secondReference,
    );
    credentials.failDeletes.delete(orphan.reference);
    assert.deepEqual(await hub.cleanupCredentialOrphans(CONTEXT), {
      attempted: 1,
      resolved: 1,
    });
    assert.equal(repository.listCredentialOrphans().length, 0);
    assert.equal(credentials.secrets.has(orphan.reference), false);

    const latest = hub.get(CONTEXT, profile.id);
    profile = await hub.deleteCredential(CONTEXT, {
      profileId: profile.id,
      expectedRevision: latest.revision,
    });
    assert.equal(profile.status, "not_configured");
    assert.equal(profile.credentialConfigured, false);
    assertSafeOutput([
      hub.list(CONTEXT),
      credentials.storeInputs.map((item) => item.binding),
    ]);

    database.close();
    console.log(
      JSON.stringify({
        ok: true,
        suite: "vera-workspace-legal-provider-hub-service-v1",
        statusVocabulary: STATUS_VOCABULARY.length,
        passedRemainsActivationGated: true,
        companyAuthorityRejected: true,
        secretsProjected: false,
      }),
    );
  } finally {
    process.env = originalEnvironment;
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
