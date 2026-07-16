import { z } from "zod";

import {
  LEGAL_PROVIDER_CAPABILITIES_V18,
  LegalProviderCapabilityRecordV18Schema,
  LegalProviderCapabilityV18Schema,
  LegalProviderConnectionTestV18Schema,
  LegalProviderCredentialOrphanCleanupV18Schema,
  LegalProviderCredentialReferenceV18Schema,
  LegalProviderEndpointSetIdV18Schema,
  LegalProviderIdV18Schema,
  LegalProviderProfileIdV18Schema,
  LegalProviderProfileV18Schema,
  LegalProviderTimestampV18Schema,
  legalProviderCredentialReferenceProfileIdV18,
  type LegalProviderCapabilityV18,
  type LegalProviderConnectionTestV18,
  type LegalProviderCredentialOrphanCleanupV18,
  type LegalProviderEndpointSetIdV18,
  type LegalProviderIdV18,
  type LegalProviderProfileV18,
} from "../legalProviderPersistenceContractsV18";
import type { WorkspaceDatabaseAdapter } from "../migrations";

type Row = Record<string, unknown>;

export class WorkspaceLegalProviderRepositoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceLegalProviderRepositoryError";
  }
}

function repositoryError(message: string, cause?: unknown): never {
  throw new WorkspaceLegalProviderRepositoryError(
    message,
    cause instanceof Error ? { cause } : undefined,
  );
}

function booleanColumn(value: unknown, label: string) {
  if (value !== 0 && value !== 1) {
    repositoryError(`Persisted ${label} is invalid.`);
  }
  return value === 1;
}

function integerColumn(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    repositoryError(`Persisted ${label} is invalid.`);
  }
  return parsed;
}

function changes(value: unknown) {
  return value &&
    typeof value === "object" &&
    "changes" in value &&
    Number.isSafeInteger(Number((value as { changes: unknown }).changes))
    ? Number((value as { changes: unknown }).changes)
    : 0;
}

function parseCapability(row: Row) {
  try {
    return LegalProviderCapabilityRecordV18Schema.parse({
      profileId: row.profile_id,
      capability: row.capability,
      enabled: booleanColumn(row.enabled, "Legal Provider capability state"),
      connectionRevision: integerColumn(
        row.connection_revision,
        "Legal Provider capability connection revision",
      ),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (error) {
    if (error instanceof WorkspaceLegalProviderRepositoryError) throw error;
    repositoryError("Persisted Legal Provider capability is invalid.", error);
  }
}

function capabilityMap(input: readonly LegalProviderCapabilityV18[]) {
  const parsed = z
    .array(LegalProviderCapabilityV18Schema)
    .max(LEGAL_PROVIDER_CAPABILITIES_V18.length)
    .parse(input);
  const enabled = new Set(parsed);
  if (enabled.size !== parsed.length) {
    repositoryError("Legal Provider capabilities must be unique.");
  }
  return new Map(
    LEGAL_PROVIDER_CAPABILITIES_V18.map((capability) => [
      capability,
      enabled.has(capability),
    ]),
  );
}

export type CreateLegalProviderProfileV18Input = Readonly<{
  id: string;
  provider: LegalProviderIdV18;
  endpointSetId: LegalProviderEndpointSetIdV18;
  enabled?: boolean;
  credentialReference?: string | null;
  enabledCapabilities: readonly LegalProviderCapabilityV18[];
}>;

export type UpdateLegalProviderProfileV18Input = Readonly<{
  id: string;
  expectedRevision: number;
  endpointSetId?: LegalProviderEndpointSetIdV18;
  enabled?: boolean;
  credentialReference?: string | null;
  enabledCapabilities?: readonly LegalProviderCapabilityV18[];
}>;

/**
 * Active Workspace persistence for provider configuration only. A current
 * passed connection test is deliberately not projected as a `ready` state;
 * licensing, activation, Matter egress, and retention are separate services.
 */
export class WorkspaceLegalProvidersRepository {
  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  createProfile(
    input: CreateLegalProviderProfileV18Input,
  ): LegalProviderProfileV18 {
    const parsed = z
      .object({
        id: LegalProviderProfileIdV18Schema,
        provider: LegalProviderIdV18Schema,
        endpointSetId: LegalProviderEndpointSetIdV18Schema,
        enabled: z.boolean().default(false),
        credentialReference:
          LegalProviderCredentialReferenceV18Schema.nullable().default(null),
      })
      .strict()
      .parse({
        id: input.id,
        provider: input.provider,
        endpointSetId: input.endpointSetId,
        enabled: input.enabled,
        credentialReference: input.credentialReference,
      });
    if (
      parsed.credentialReference !== null &&
      legalProviderCredentialReferenceProfileIdV18(
        parsed.credentialReference,
      ) !== parsed.id
    ) {
      repositoryError(
        "Legal Provider credential reference is not bound to its profile.",
      );
    }
    const capabilities = capabilityMap(input.enabledCapabilities);
    const at = this.timestamp();
    return this.transaction(() => {
      try {
        this.database
          .prepare(
            `INSERT INTO legal_provider_profiles (
               id, provider, endpoint_set_id, enabled, credential_reference,
               revision, connection_revision, credential_revision,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
          )
          .run(
            parsed.id,
            parsed.provider,
            parsed.endpointSetId,
            parsed.enabled ? 1 : 0,
            parsed.credentialReference,
            at,
            at,
          );
        for (const capability of LEGAL_PROVIDER_CAPABILITIES_V18) {
          this.database
            .prepare(
              `INSERT INTO legal_provider_capabilities (
                 profile_id, capability, enabled, connection_revision,
                 created_at, updated_at
               ) VALUES (?, ?, ?, 0, ?, ?)`,
            )
            .run(
              parsed.id,
              capability,
              capabilities.get(capability) ? 1 : 0,
              at,
              at,
            );
        }
      } catch (error) {
        repositoryError("Legal Provider profile could not be created.", error);
      }
      return this.requireProfile(parsed.id);
    });
  }

  getProfile(id: string): LegalProviderProfileV18 | null {
    const parsedId = LegalProviderProfileIdV18Schema.safeParse(id);
    if (!parsedId.success)
      repositoryError("Legal Provider profile id is invalid.");
    const row = this.database
      .prepare("SELECT * FROM legal_provider_profiles WHERE id = ?")
      .get(parsedId.data);
    return row ? this.parseProfile(row) : null;
  }

  listProfiles(): LegalProviderProfileV18[] {
    return this.database
      .prepare("SELECT * FROM legal_provider_profiles ORDER BY provider, id")
      .all()
      .map((row) => this.parseProfile(row));
  }

  updateProfile(
    input: UpdateLegalProviderProfileV18Input,
  ): LegalProviderProfileV18 {
    const id = LegalProviderProfileIdV18Schema.parse(input.id);
    const expectedRevision = z
      .number()
      .int()
      .min(0)
      .max(2_147_483_647)
      .parse(input.expectedRevision);
    return this.transaction(() => {
      const current = this.requireProfile(id);
      if (current.revision !== expectedRevision) {
        repositoryError("Legal Provider profile revision is stale.");
      }
      const endpointSetId =
        input.endpointSetId === undefined
          ? current.endpointSetId
          : LegalProviderEndpointSetIdV18Schema.parse(input.endpointSetId);
      const enabled = input.enabled ?? current.enabled;
      const credentialReference =
        input.credentialReference === undefined
          ? current.credentialReference
          : LegalProviderCredentialReferenceV18Schema.nullable().parse(
              input.credentialReference,
            );
      if (
        credentialReference !== null &&
        legalProviderCredentialReferenceProfileIdV18(credentialReference) !== id
      ) {
        repositoryError(
          "Legal Provider credential reference is not bound to its profile.",
        );
      }
      const nextCapabilities =
        input.enabledCapabilities === undefined
          ? new Map(
              current.capabilities.map((item) => [
                item.capability,
                item.enabled,
              ]),
            )
          : capabilityMap(input.enabledCapabilities);
      const capabilitiesChanged = current.capabilities.some(
        (item) => nextCapabilities.get(item.capability) !== item.enabled,
      );
      const credentialChanged =
        credentialReference !== current.credentialReference;
      const connectionChanged =
        endpointSetId !== current.endpointSetId ||
        credentialChanged ||
        capabilitiesChanged;
      const enabledChanged = enabled !== current.enabled;
      if (!connectionChanged && !enabledChanged) return current;
      if (current.revision >= 2_147_483_647) {
        repositoryError("Legal Provider profile revision is exhausted.");
      }
      if (connectionChanged && current.connectionRevision >= 2_147_483_647) {
        repositoryError("Legal Provider connection revision is exhausted.");
      }
      if (credentialChanged && current.credentialRevision >= 2_147_483_647) {
        repositoryError("Legal Provider credential revision is exhausted.");
      }
      const nextRevision = current.revision + 1;
      const nextConnectionRevision =
        current.connectionRevision + (connectionChanged ? 1 : 0);
      const nextCredentialRevision =
        current.credentialRevision + (credentialChanged ? 1 : 0);
      const at = this.timestamp(current.updatedAt);
      let update: unknown;
      try {
        update = this.database
          .prepare(
            `UPDATE legal_provider_profiles
                SET endpoint_set_id = ?, enabled = ?, credential_reference = ?,
                    revision = ?, connection_revision = ?,
                    credential_revision = ?, updated_at = ?
              WHERE id = ? AND revision = ?`,
          )
          .run(
            endpointSetId,
            enabled ? 1 : 0,
            credentialReference,
            nextRevision,
            nextConnectionRevision,
            nextCredentialRevision,
            at,
            id,
            expectedRevision,
          );
        if (changes(update) !== 1) {
          repositoryError("Legal Provider profile revision is stale.");
        }
        if (connectionChanged) {
          this.database
            .prepare(
              "DELETE FROM legal_provider_connection_tests WHERE profile_id = ?",
            )
            .run(id);
        }
        if (connectionChanged) {
          for (const item of current.capabilities) {
            const nextEnabled = nextCapabilities.get(item.capability) === true;
            const result = this.database
              .prepare(
                `UPDATE legal_provider_capabilities
                    SET enabled = ?, connection_revision = ?, updated_at = ?
                  WHERE profile_id = ? AND capability = ?`,
              )
              .run(
                nextEnabled ? 1 : 0,
                nextConnectionRevision,
                at,
                id,
                item.capability,
              );
            if (changes(result) !== 1) {
              repositoryError("Legal Provider capability update was lost.");
            }
          }
        }
      } catch (error) {
        if (error instanceof WorkspaceLegalProviderRepositoryError) throw error;
        repositoryError("Legal Provider profile could not be updated.", error);
      }
      return this.requireProfile(id);
    });
  }

  getConnectionTest(profileId: string): LegalProviderConnectionTestV18 | null {
    const id = LegalProviderProfileIdV18Schema.parse(profileId);
    const row = this.database
      .prepare(
        `SELECT test.*
           FROM legal_provider_connection_tests test
           JOIN legal_provider_profiles profile
             ON profile.id = test.profile_id
            AND profile.connection_revision = test.connection_revision
          WHERE test.profile_id = ?`,
      )
      .get(id);
    if (!row) return null;
    try {
      return LegalProviderConnectionTestV18Schema.parse({
        profileId: row.profile_id,
        connectionRevision: integerColumn(
          row.connection_revision,
          "Legal Provider connection revision",
        ),
        status: row.status,
        errorCode: row.error_code,
        retryable: booleanColumn(row.retryable, "connection retry state"),
        latencyMs:
          row.latency_ms === null
            ? null
            : integerColumn(row.latency_ms, "connection latency"),
        testedAt: row.tested_at,
      });
    } catch (error) {
      if (error instanceof WorkspaceLegalProviderRepositoryError) throw error;
      repositoryError(
        "Persisted Legal Provider connection test is invalid.",
        error,
      );
    }
  }

  recordConnectionTest(
    input: LegalProviderConnectionTestV18,
  ): LegalProviderConnectionTestV18 {
    const parsed = LegalProviderConnectionTestV18Schema.parse(input);
    return this.transaction(() => {
      const profile = this.requireProfile(parsed.profileId);
      if (profile.connectionRevision !== parsed.connectionRevision) {
        repositoryError("Legal Provider connection test revision is stale.");
      }
      const previous = this.getConnectionTest(parsed.profileId);
      if (previous && parsed.testedAt <= previous.testedAt) {
        repositoryError(
          "Legal Provider connection test time must move forwards.",
        );
      }
      try {
        this.database
          .prepare(
            `INSERT INTO legal_provider_connection_tests (
               profile_id, connection_revision, status, error_code,
               retryable, latency_ms, tested_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(profile_id) DO UPDATE SET
               connection_revision = excluded.connection_revision,
               status = excluded.status,
               error_code = excluded.error_code,
               retryable = excluded.retryable,
               latency_ms = excluded.latency_ms,
               tested_at = excluded.tested_at`,
          )
          .run(
            parsed.profileId,
            parsed.connectionRevision,
            parsed.status,
            parsed.errorCode,
            parsed.retryable ? 1 : 0,
            parsed.latencyMs,
            parsed.testedAt,
          );
      } catch (error) {
        repositoryError(
          "Legal Provider connection test could not be recorded.",
          error,
        );
      }
      return this.getConnectionTest(parsed.profileId)!;
    });
  }

  recordCredentialOrphan(
    input: Omit<
      LegalProviderCredentialOrphanCleanupV18,
      "attemptCount" | "lastErrorCode" | "createdAt" | "updatedAt"
    >,
  ): LegalProviderCredentialOrphanCleanupV18 {
    const at = this.timestamp();
    const candidate = LegalProviderCredentialOrphanCleanupV18Schema.parse({
      ...input,
      attemptCount: 0,
      lastErrorCode: null,
      createdAt: at,
      updatedAt: at,
    });
    return this.transaction(() => {
      const existing = this.database
        .prepare(
          "SELECT * FROM legal_provider_credential_orphan_cleanups WHERE reference = ?",
        )
        .get(candidate.reference);
      if (existing) {
        const persisted = this.parseCredentialOrphan(existing);
        if (
          persisted.profileId !== candidate.profileId ||
          persisted.provider !== candidate.provider ||
          persisted.endpointSetId !== candidate.endpointSetId ||
          persisted.reason !== candidate.reason
        ) {
          repositoryError(
            "Legal Provider credential cleanup binding is immutable.",
          );
        }
      }
      try {
        this.database
          .prepare(
            `INSERT INTO legal_provider_credential_orphan_cleanups (
               reference, profile_id, provider, endpoint_set_id, reason,
               attempt_count, last_error_code, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)
             ON CONFLICT(reference) DO UPDATE SET updated_at = excluded.updated_at
             WHERE profile_id = excluded.profile_id
               AND provider = excluded.provider
               AND endpoint_set_id = excluded.endpoint_set_id
               AND reason = excluded.reason`,
          )
          .run(
            candidate.reference,
            candidate.profileId,
            candidate.provider,
            candidate.endpointSetId,
            candidate.reason,
            candidate.createdAt,
            candidate.updatedAt,
          );
      } catch (error) {
        repositoryError(
          "Legal Provider credential cleanup could not be recorded.",
          error,
        );
      }
      const persisted = this.requireCredentialOrphan(candidate.reference);
      if (
        persisted.profileId !== candidate.profileId ||
        persisted.provider !== candidate.provider ||
        persisted.endpointSetId !== candidate.endpointSetId ||
        persisted.reason !== candidate.reason
      ) {
        repositoryError(
          "Legal Provider credential cleanup binding is immutable.",
        );
      }
      return persisted;
    });
  }

  listCredentialOrphans(): LegalProviderCredentialOrphanCleanupV18[] {
    return this.database
      .prepare(
        `SELECT * FROM legal_provider_credential_orphan_cleanups
          ORDER BY updated_at, reference`,
      )
      .all()
      .map((row) => this.parseCredentialOrphan(row));
  }

  recordCredentialOrphanAttempt(input: {
    reference: string;
    lastErrorCode: string;
  }): LegalProviderCredentialOrphanCleanupV18 {
    const reference = LegalProviderCredentialReferenceV18Schema.parse(
      input.reference,
    );
    const errorCode = z
      .string()
      .regex(/^[a-z0-9_]{1,120}$/)
      .parse(input.lastErrorCode);
    const current = this.requireCredentialOrphan(reference);
    if (current.attemptCount >= 2_147_483_647) {
      repositoryError(
        "Legal Provider credential cleanup attempts are exhausted.",
      );
    }
    const at = this.timestamp(current.updatedAt);
    try {
      const result = this.database
        .prepare(
          `UPDATE legal_provider_credential_orphan_cleanups
              SET attempt_count = ?, last_error_code = ?, updated_at = ?
            WHERE reference = ? AND attempt_count = ?`,
        )
        .run(
          current.attemptCount + 1,
          errorCode,
          at,
          reference,
          current.attemptCount,
        );
      if (changes(result) !== 1) {
        repositoryError("Legal Provider credential cleanup attempt was lost.");
      }
    } catch (error) {
      repositoryError(
        "Legal Provider credential cleanup attempt was lost.",
        error,
      );
    }
    return this.requireCredentialOrphan(reference);
  }

  resolveCredentialOrphan(referenceInput: string): void {
    const reference =
      LegalProviderCredentialReferenceV18Schema.parse(referenceInput);
    this.database
      .prepare(
        "DELETE FROM legal_provider_credential_orphan_cleanups WHERE reference = ?",
      )
      .run(reference);
  }

  private requireProfile(id: string) {
    const profile = this.getProfile(id);
    if (!profile) repositoryError("Legal Provider profile was not found.");
    return profile;
  }

  private parseProfile(row: Row): LegalProviderProfileV18 {
    const id = String(row.id);
    const capabilities = this.database
      .prepare(
        `SELECT * FROM legal_provider_capabilities
          WHERE profile_id = ? ORDER BY capability`,
      )
      .all(id)
      .map(parseCapability);
    try {
      return LegalProviderProfileV18Schema.parse({
        id,
        provider: row.provider,
        endpointSetId: row.endpoint_set_id,
        enabled: booleanColumn(row.enabled, "Legal Provider enabled state"),
        credentialReference: row.credential_reference,
        revision: integerColumn(row.revision, "Legal Provider revision"),
        connectionRevision: integerColumn(
          row.connection_revision,
          "Legal Provider connection revision",
        ),
        credentialRevision: integerColumn(
          row.credential_revision,
          "Legal Provider credential revision",
        ),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        capabilities,
      });
    } catch (error) {
      if (error instanceof WorkspaceLegalProviderRepositoryError) throw error;
      repositoryError("Persisted Legal Provider profile is invalid.", error);
    }
  }

  private requireCredentialOrphan(reference: string) {
    const row = this.database
      .prepare(
        "SELECT * FROM legal_provider_credential_orphan_cleanups WHERE reference = ?",
      )
      .get(reference);
    if (!row)
      repositoryError("Legal Provider credential cleanup was not found.");
    return this.parseCredentialOrphan(row);
  }

  private parseCredentialOrphan(row: Row) {
    try {
      return LegalProviderCredentialOrphanCleanupV18Schema.parse({
        reference: row.reference,
        profileId: row.profile_id,
        provider: row.provider,
        endpointSetId: row.endpoint_set_id,
        reason: row.reason,
        attemptCount: integerColumn(
          row.attempt_count,
          "credential cleanup attempt count",
        ),
        lastErrorCode: row.last_error_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    } catch (error) {
      if (error instanceof WorkspaceLegalProviderRepositoryError) throw error;
      repositoryError(
        "Persisted Legal Provider credential cleanup is invalid.",
        error,
      );
    }
  }

  private timestamp(after?: string) {
    const value = this.now();
    if (!LegalProviderTimestampV18Schema.safeParse(value).success) {
      repositoryError("Legal Provider timestamp is invalid.");
    }
    if (after !== undefined && value <= after) {
      repositoryError("Legal Provider timestamp must move forwards.");
    }
    return value;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the primary failure.
      }
      throw error;
    }
  }
}
