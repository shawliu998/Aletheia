import { randomBytes, randomUUID } from "node:crypto";

import { ZodError, z } from "zod";

import {
  LEGAL_PROVIDER_CAPABILITIES_V18,
  LegalProviderCapabilityV18Schema,
  LegalProviderConnectionErrorCodeV18Schema,
  LegalProviderProfileIdV18Schema,
  LegalProviderTimestampV18Schema,
  type LegalProviderCapabilityV18,
  type LegalProviderProfileV18,
} from "../legalProviderPersistenceContractsV18";
import { WorkspaceApiError } from "../errors";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../principal";
import {
  WorkspaceLegalProviderRepositoryError,
  WorkspaceLegalProvidersRepository,
} from "../repositories/legalProviders";
import {
  WorkspaceYuanDianMcpAdapter,
  YuanDianMcpAdapterError,
  type YuanDianMcpAdapterDeps,
} from "../providers/yuandianMcp";
import {
  CredentialStoreCollisionError,
  MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES,
} from "./credentialStore";
import {
  buildLegalProviderCredentialReference,
  type LegalProviderCredentialInput,
  type LegalProviderCredentialStorePort,
  YUANDIAN_OFFICIAL_MCP_ENDPOINT_SET_ID,
} from "./legalProviderCredentialStore";

const MAX_LOCATOR_ALLOCATION_ATTEMPTS = 8;
export const MAX_ORPHAN_CLEANUPS_PER_RUN = 100;
const LocalContextSchema = z
  .object({ principalId: z.literal(WORKSPACE_LOCAL_PRINCIPAL_ID) })
  .strict();
const ExpectedRevisionSchema = z.number().int().min(0).max(2_147_483_647);
const SecretSchema = z
  .string()
  .min(1)
  .refine((value) => !/[\r\n]/.test(value))
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <=
      MAX_MODEL_CREDENTIAL_STORE_SECRET_BYTES,
  );

type LegalProviderConnectionErrorCodeV18 = z.infer<
  typeof LegalProviderConnectionErrorCodeV18Schema
>;

export type LegalProviderHubLocalContext = Readonly<{
  principalId: typeof WORKSPACE_LOCAL_PRINCIPAL_ID;
}>;

export type LegalProviderHubStatus =
  | "unavailable"
  | "not_configured"
  | "configured_unverified"
  | "ready"
  | "authentication_failed"
  | "license_restricted"
  | "activation_gate_closed"
  | "temporarily_unavailable";

export type LegalProviderHubProfileView = Readonly<{
  id: string;
  provider: "yuandian";
  endpointSetId: typeof YUANDIAN_OFFICIAL_MCP_ENDPOINT_SET_ID;
  enabled: boolean;
  revision: number;
  connectionRevision: number;
  credentialRevision: number;
  credentialConfigured: boolean;
  capabilities: readonly Readonly<{
    capability: LegalProviderCapabilityV18;
    enabled: boolean;
  }>[];
  connectionTest: null | Readonly<{
    status: "passed" | "failed";
    errorCode: LegalProviderConnectionErrorCodeV18 | null;
    retryable: boolean;
    latencyMs: number | null;
    testedAt: string;
  }>;
  status: LegalProviderHubStatus;
}>;

type ConnectionProbe = Readonly<{
  verify(signal: AbortSignal): Promise<void>;
}>;

export type WorkspaceLegalProviderHubServiceOptions = Readonly<{
  clock?: () => Date;
  monotonicNowMs?: () => number;
  nextProfileId?: () => string;
  nextCredentialLocatorId?: () => string;
  createConnectionProbe?: (input: {
    credentialReference: string;
    resolveCredential: YuanDianMcpAdapterDeps["resolveCredential"];
    authorityCapabilities: readonly ("law" | "case")[];
  }) => ConnectionProbe;
}>;

function connectionFailure(error: unknown): {
  errorCode: LegalProviderConnectionErrorCodeV18;
  retryable: boolean;
} {
  if (error instanceof YuanDianMcpAdapterError) {
    if (error.code === "credential_unavailable") {
      return { errorCode: "credential_unavailable", retryable: false };
    }
    if (error.code === "policy_violation") {
      return { errorCode: "protocol_invalid", retryable: false };
    }
    if (error.code === "authentication_failed") {
      return { errorCode: "authentication_failed", retryable: false };
    }
    if (error.code === "license_restricted") {
      return { errorCode: "license_restricted", retryable: false };
    }
    if (error.code === "response_invalid") {
      return { errorCode: "response_invalid", retryable: false };
    }
    if (error.code === "configuration_error") {
      return { errorCode: "protocol_invalid", retryable: false };
    }
    return {
      errorCode: /timed out/i.test(error.message)
        ? "timeout"
        : "transport_error",
      retryable: true,
    };
  }
  return { errorCode: "temporarily_unavailable", retryable: true };
}

function stateForFailure(
  code: LegalProviderConnectionErrorCodeV18,
): LegalProviderHubStatus {
  if (code === "authentication_failed" || code === "credential_unavailable") {
    return "authentication_failed";
  }
  if (code === "license_restricted") return "license_restricted";
  return "temporarily_unavailable";
}

export class WorkspaceLegalProviderHubService {
  private readonly clock: () => Date;
  private readonly monotonicNowMs: () => number;
  private readonly nextProfileId: () => string;
  private readonly nextCredentialLocatorId: () => string;
  private readonly createConnectionProbe: NonNullable<
    WorkspaceLegalProviderHubServiceOptions["createConnectionProbe"]
  >;

  constructor(
    private readonly repository: WorkspaceLegalProvidersRepository,
    private readonly credentials: LegalProviderCredentialStorePort,
    options: WorkspaceLegalProviderHubServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
    this.monotonicNowMs = options.monotonicNowMs ?? (() => performance.now());
    this.nextProfileId = options.nextProfileId ?? randomUUID;
    this.nextCredentialLocatorId =
      options.nextCredentialLocatorId ??
      (() => randomBytes(32).toString("hex"));
    this.createConnectionProbe =
      options.createConnectionProbe ??
      ((input) => {
        const adapter = new WorkspaceYuanDianMcpAdapter(
          { credentialRef: input.credentialReference },
          { resolveCredential: input.resolveCredential },
        );
        return {
          verify: async (signal) => {
            for (const capability of input.authorityCapabilities) {
              await adapter.search(
                {
                  query:
                    capability === "law"
                      ? "中华人民共和国 民事法律"
                      : "民事纠纷 裁判案例",
                  sourceTypes: capability === "law" ? ["statute"] : ["case"],
                  limit: 1,
                },
                signal,
              );
            }
          },
        };
      });
  }

  list(context: LegalProviderHubLocalContext): LegalProviderHubProfileView[] {
    return this.publicCall(() => {
      this.assertLocal(context);
      return this.repository
        .listProfiles()
        .map((profile) => this.project(profile));
    });
  }

  get(
    context: LegalProviderHubLocalContext,
    profileId: string,
  ): LegalProviderHubProfileView {
    return this.publicCall(() => {
      this.assertLocal(context);
      return this.project(this.requireProfile(profileId));
    });
  }

  create(
    context: LegalProviderHubLocalContext,
    input: Readonly<{
      enabledCapabilities?: readonly LegalProviderCapabilityV18[];
    }> = {},
  ): LegalProviderHubProfileView {
    return this.publicCall(() => {
      this.assertLocal(context);
      const request = z
        .object({
          enabledCapabilities: z
            .array(LegalProviderCapabilityV18Schema)
            .max(LEGAL_PROVIDER_CAPABILITIES_V18.length)
            .default(["law", "case"]),
        })
        .strict()
        .parse(input);
      const profile = this.repository.createProfile({
        id: LegalProviderProfileIdV18Schema.parse(this.nextProfileId()),
        provider: "yuandian",
        endpointSetId: YUANDIAN_OFFICIAL_MCP_ENDPOINT_SET_ID,
        enabled: false,
        credentialReference: null,
        enabledCapabilities: request.enabledCapabilities,
      });
      return this.project(profile);
    });
  }

  setEnabled(
    context: LegalProviderHubLocalContext,
    input: Readonly<{
      profileId: string;
      expectedRevision: number;
      enabled: boolean;
    }>,
  ): LegalProviderHubProfileView {
    return this.publicCall(() => {
      this.assertLocal(context);
      const request = z
        .object({
          profileId: LegalProviderProfileIdV18Schema,
          expectedRevision: ExpectedRevisionSchema,
          enabled: z.boolean(),
        })
        .strict()
        .parse(input);
      const current = this.requireExpectedRevision(
        request.profileId,
        request.expectedRevision,
      );
      if (request.enabled) {
        if (!current.credentialReference) {
          throw new WorkspaceApiError(
            409,
            "PRECONDITION_FAILED",
            "Legal provider credential is not configured.",
          );
        }
        this.assertCredentialStoreAvailable();
        if (
          this.repository.getConnectionTest(current.id)?.status !== "passed"
        ) {
          throw new WorkspaceApiError(
            409,
            "PRECONDITION_FAILED",
            "Legal provider connection has not passed its current test.",
          );
        }
      }
      return this.project(
        this.repository.updateProfile({
          id: request.profileId,
          expectedRevision: request.expectedRevision,
          enabled: request.enabled,
        }),
      );
    });
  }

  async putCredential(
    context: LegalProviderHubLocalContext,
    input: Readonly<{
      profileId: string;
      expectedRevision: number;
      secret: string;
    }>,
  ): Promise<LegalProviderHubProfileView> {
    return this.publicCallAsync(async () => {
      this.assertLocal(context);
      const request = z
        .object({
          profileId: LegalProviderProfileIdV18Schema,
          expectedRevision: ExpectedRevisionSchema,
          secret: SecretSchema,
        })
        .strict()
        .parse(input);
      const current = this.requireExpectedRevision(
        request.profileId,
        request.expectedRevision,
      );
      this.assertCredentialStoreAvailable();
      let stored: LegalProviderCredentialInput | null = null;
      let lastCollision: unknown;
      for (
        let attempt = 0;
        attempt < MAX_LOCATOR_ALLOCATION_ATTEMPTS;
        attempt += 1
      ) {
        const reference = buildLegalProviderCredentialReference(
          current.id,
          this.nextCredentialLocatorId(),
        );
        const candidate = this.credentialInput(current, reference);
        try {
          this.repository.recordCredentialOrphan({
            reference,
            profileId: current.id,
            provider: current.provider,
            endpointSetId: current.endpointSetId,
            reason: "profile_write_failed",
          });
          await this.credentials.storeLegalProviderCredential({
            ...candidate,
            secret: request.secret,
          });
          stored = candidate;
          break;
        } catch (error) {
          if (error instanceof CredentialStoreCollisionError) {
            this.repository.resolveCredentialOrphan(reference);
            lastCollision = error;
            continue;
          }
          await this.cleanupIndeterminateCredential(
            candidate,
            current,
            "profile_write_failed",
          );
          throw new WorkspaceApiError(
            503,
            "PRECONDITION_FAILED",
            "Legal provider credential store is unavailable.",
          );
        }
      }
      if (!stored) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Legal provider credential locator allocation failed.",
          lastCollision ? undefined : [],
        );
      }
      let updated: LegalProviderProfileV18;
      let oldCredentialReference: string | null = null;
      try {
        const result = this.repository.updateProfileWithCredentialOrphan({
          id: current.id,
          expectedRevision: request.expectedRevision,
          credentialReference: stored.reference,
          orphanReason: "credential_rotated",
          resolveOrphanReference: stored.reference,
        });
        updated = result.profile;
        oldCredentialReference = result.orphan?.reference ?? null;
      } catch (error) {
        await this.cleanupIndeterminateCredential(
          stored,
          current,
          "profile_write_failed",
        );
        throw error;
      }
      if (oldCredentialReference) {
        await this.cleanupRecordedCredential(
          this.credentialInput(current, oldCredentialReference),
        );
      }
      return this.project(updated);
    });
  }

  async deleteCredential(
    context: LegalProviderHubLocalContext,
    input: Readonly<{ profileId: string; expectedRevision: number }>,
  ): Promise<LegalProviderHubProfileView> {
    return this.publicCallAsync(async () => {
      this.assertLocal(context);
      const request = z
        .object({
          profileId: LegalProviderProfileIdV18Schema,
          expectedRevision: ExpectedRevisionSchema,
        })
        .strict()
        .parse(input);
      const current = this.requireExpectedRevision(
        request.profileId,
        request.expectedRevision,
      );
      if (!current.credentialReference) return this.project(current);
      const result = this.repository.updateProfileWithCredentialOrphan({
        id: current.id,
        expectedRevision: current.revision,
        enabled: false,
        credentialReference: null,
        orphanReason: "credential_reconfiguration",
      });
      await this.cleanupRecordedCredential(
        this.credentialInput(current, current.credentialReference),
      );
      return this.project(result.profile);
    });
  }

  async testConnection(
    context: LegalProviderHubLocalContext,
    input: Readonly<{
      profileId: string;
      expectedRevision: number;
      userAuthorized: true;
      signal: AbortSignal;
    }>,
  ): Promise<LegalProviderHubProfileView> {
    return this.publicCallAsync(async () => {
      this.assertLocal(context);
      const request = z
        .object({
          profileId: LegalProviderProfileIdV18Schema,
          expectedRevision: ExpectedRevisionSchema,
          userAuthorized: z.literal(true),
          signal: z.custom<AbortSignal>(
            (value) => value instanceof AbortSignal,
          ),
        })
        .strict()
        .parse(input);
      const current = this.requireExpectedRevision(
        request.profileId,
        request.expectedRevision,
      );
      if (!current.credentialReference) {
        throw new WorkspaceApiError(
          409,
          "PRECONDITION_FAILED",
          "Legal provider credential is not configured.",
        );
      }
      this.assertCredentialStoreAvailable();
      const authorityCapabilities = current.capabilities.filter(
        (capability) =>
          capability.enabled &&
          (capability.capability === "law" || capability.capability === "case"),
      );
      if (authorityCapabilities.length === 0) {
        throw new WorkspaceApiError(
          409,
          "PRECONDITION_FAILED",
          "Legal authority search capability is not enabled.",
        );
      }
      const credentialInput = this.credentialInput(
        current,
        current.credentialReference,
      );
      const probe = this.createConnectionProbe({
        credentialReference: current.credentialReference,
        authorityCapabilities: authorityCapabilities.map(
          (capability) => capability.capability as "law" | "case",
        ),
        resolveCredential: async (reference, signal) => {
          if (reference !== credentialInput.reference || signal.aborted) {
            const error = new Error("Legal provider connection was cancelled.");
            error.name = "AbortError";
            throw error;
          }
          return this.credentials.resolveLegalProviderCredential(
            credentialInput,
          );
        },
      });
      const started = this.monotonicNowMs();
      let failure: ReturnType<typeof connectionFailure> | null = null;
      try {
        await probe.verify(request.signal);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        failure = connectionFailure(error);
      }
      const latest = this.requireProfile(current.id);
      if (
        latest.revision !== current.revision ||
        latest.connectionRevision !== current.connectionRevision
      ) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Legal provider profile changed during connection testing.",
        );
      }
      const latencyMs = Math.max(
        0,
        Math.min(600_000, Math.round(this.monotonicNowMs() - started)),
      );
      this.repository.recordConnectionTest({
        profileId: current.id,
        connectionRevision: current.connectionRevision,
        status: failure ? "failed" : "passed",
        errorCode: failure?.errorCode ?? null,
        retryable: failure?.retryable ?? false,
        latencyMs,
        testedAt: this.nextTestTimestamp(
          this.repository.getConnectionTest(current.id)?.testedAt,
        ),
      });
      return this.project(this.requireProfile(current.id));
    });
  }

  async cleanupCredentialOrphans(
    context: LegalProviderHubLocalContext,
  ): Promise<{ attempted: number; resolved: number }> {
    return this.publicCallAsync(async () => {
      this.assertLocal(context);
      this.assertCredentialStoreAvailable();
      const orphans = this.repository
        .listCredentialOrphans()
        .slice(0, MAX_ORPHAN_CLEANUPS_PER_RUN);
      let resolved = 0;
      for (const orphan of orphans) {
        const current = this.repository.getProfile(orphan.profileId);
        if (current?.credentialReference === orphan.reference) {
          // A pre-store collision intent can survive a process crash. Never
          // delete a reference that is still the profile's active binding.
          this.repository.resolveCredentialOrphan(orphan.reference);
          resolved += 1;
          continue;
        }
        const input: LegalProviderCredentialInput = {
          reference: orphan.reference,
          binding: {
            profileId: orphan.profileId,
            provider: orphan.provider,
            endpointSetId: orphan.endpointSetId,
          },
        };
        try {
          await this.credentials.deleteLegalProviderCredential(input);
          this.repository.resolveCredentialOrphan(orphan.reference);
          resolved += 1;
        } catch {
          this.repository.recordCredentialOrphanAttempt({
            reference: orphan.reference,
            lastErrorCode: "credential_delete_failed",
          });
        }
      }
      return { attempted: orphans.length, resolved };
    });
  }

  private project(
    profile: LegalProviderProfileV18,
  ): LegalProviderHubProfileView {
    const test = this.repository.getConnectionTest(profile.id);
    let state: LegalProviderHubStatus;
    if (!profile.credentialReference) {
      state = "not_configured";
    } else if (!this.credentials.isAvailable()) {
      state = "unavailable";
    } else if (!test) {
      state = "configured_unverified";
    } else if (test.status === "failed") {
      state = stateForFailure(test.errorCode!);
    } else {
      state = "activation_gate_closed";
    }
    return Object.freeze({
      id: profile.id,
      provider: profile.provider,
      endpointSetId: profile.endpointSetId,
      enabled: profile.enabled,
      revision: profile.revision,
      connectionRevision: profile.connectionRevision,
      credentialRevision: profile.credentialRevision,
      credentialConfigured: profile.credentialReference !== null,
      capabilities: Object.freeze(
        profile.capabilities.map((capability) =>
          Object.freeze({
            capability: capability.capability,
            enabled: capability.enabled,
          }),
        ),
      ),
      connectionTest: test
        ? Object.freeze({
            status: test.status,
            errorCode: test.errorCode,
            retryable: test.retryable,
            latencyMs: test.latencyMs,
            testedAt: test.testedAt,
          })
        : null,
      status: state,
    });
  }

  private credentialInput(
    profile: LegalProviderProfileV18,
    reference: string,
  ): LegalProviderCredentialInput {
    return {
      reference,
      binding: {
        profileId: profile.id,
        provider: profile.provider,
        endpointSetId: profile.endpointSetId,
      },
    };
  }

  private async cleanupIndeterminateCredential(
    input: LegalProviderCredentialInput,
    profile: LegalProviderProfileV18,
    reason: "profile_write_failed",
  ) {
    let intentRecorded = false;
    try {
      this.repository.recordCredentialOrphan({
        reference: input.reference,
        profileId: profile.id,
        provider: profile.provider,
        endpointSetId: profile.endpointSetId,
        reason,
      });
      intentRecorded = true;
    } catch {
      // Deletion below is still safe because this candidate was never linked.
    }
    try {
      await this.credentials.deleteLegalProviderCredential(input);
      if (intentRecorded)
        this.repository.resolveCredentialOrphan(input.reference);
    } catch {
      if (!intentRecorded) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Legal provider credential cleanup intent could not be persisted.",
        );
      }
    }
  }

  private async cleanupRecordedCredential(input: LegalProviderCredentialInput) {
    try {
      await this.credentials.deleteLegalProviderCredential(input);
      this.repository.resolveCredentialOrphan(input.reference);
    } catch {
      // Durable cleanup intent remains for startup/manual replay.
    }
  }

  private assertCredentialStoreAvailable() {
    if (!this.credentials.isAvailable()) {
      throw new WorkspaceApiError(
        503,
        "PRECONDITION_FAILED",
        "Legal provider credential store is unavailable.",
      );
    }
  }

  private assertLocal(context: LegalProviderHubLocalContext) {
    LocalContextSchema.parse(context);
  }

  private requireProfile(profileId: string): LegalProviderProfileV18 {
    const id = LegalProviderProfileIdV18Schema.parse(profileId);
    const profile = this.repository.getProfile(id);
    if (!profile) {
      throw new WorkspaceApiError(
        404,
        "NOT_FOUND",
        "Legal provider profile was not found.",
      );
    }
    return profile;
  }

  private requireExpectedRevision(profileId: string, expectedRevision: number) {
    const revision = ExpectedRevisionSchema.parse(expectedRevision);
    const profile = this.requireProfile(profileId);
    if (profile.revision !== revision) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Legal provider profile revision is stale.",
      );
    }
    return profile;
  }

  private nextTestTimestamp(previous?: string) {
    const now = this.clock();
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Legal provider clock is invalid.",
      );
    }
    let milliseconds = now.getTime();
    if (previous && milliseconds <= Date.parse(previous)) {
      milliseconds = Date.parse(previous) + 1;
    }
    const value = new Date(milliseconds).toISOString();
    return LegalProviderTimestampV18Schema.parse(value);
  }

  private normalizePublicError(error: unknown): never {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (error instanceof WorkspaceApiError) throw error;
    if (error instanceof ZodError) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Legal provider request is invalid.",
        error.issues.slice(0, 50).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    if (error instanceof WorkspaceLegalProviderRepositoryError) {
      if (/not found/i.test(error.message)) {
        throw new WorkspaceApiError(
          404,
          "NOT_FOUND",
          "Legal provider profile was not found.",
        );
      }
      if (/stale|lost|revision/i.test(error.message)) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Legal provider profile revision is stale.",
        );
      }
    }
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Legal provider operation failed.",
    );
  }

  private publicCall<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      return this.normalizePublicError(error);
    }
  }

  private async publicCallAsync<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      return this.normalizePublicError(error);
    }
  }
}
