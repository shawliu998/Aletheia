import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import {
  isModelConnectionTestErrorCode,
  MAX_MODEL_CONNECTION_REVISION,
  MAX_MODEL_CONNECTION_TEST_LATENCY_MS,
  type ModelConnectionTestErrorCode,
  type StoredModelConnectionTest,
} from "../modelConnectionReadiness";

type Row = Record<string, unknown>;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRICT_UTC_ISO_MILLISECONDS_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STORE_INPUT_KEYS = new Set([
  "profileId",
  "expectedConnectionRevision",
  "status",
  "errorCode",
  "retryable",
  "latencyMs",
  "testedAt",
]);

function isBoundedInteger(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isStrictUtcIsoMilliseconds(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !STRICT_UTC_ISO_MILLISECONDS_PATTERN.test(value)
  ) {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function corruptReadinessState(): never {
  throw new WorkspaceApiError(
    500,
    "INTERNAL_ERROR",
    "Model connection readiness state is corrupt.",
  );
}

function mapStored(row: Row): StoredModelConnectionTest {
  const profileId = row.profile_id;
  const connectionRevision = row.connection_revision;
  const status = row.status;
  const errorCode = row.error_code;
  const retryable = row.retryable;
  const latencyMs = row.latency_ms;
  const testedAt = row.tested_at;
  if (
    !isUuid(profileId) ||
    !isBoundedInteger(connectionRevision, MAX_MODEL_CONNECTION_REVISION) ||
    (status !== "passed" && status !== "failed") ||
    (retryable !== 0 && retryable !== 1) ||
    (latencyMs !== null &&
      !isBoundedInteger(latencyMs, MAX_MODEL_CONNECTION_TEST_LATENCY_MS)) ||
    !isStrictUtcIsoMilliseconds(testedAt) ||
    (errorCode !== null && !isModelConnectionTestErrorCode(errorCode)) ||
    (status === "passed" && (errorCode !== null || retryable !== 0)) ||
    (status === "failed" && errorCode === null)
  ) {
    return corruptReadinessState();
  }
  const base = {
    profileId,
    connectionRevision,
    latencyMs,
    testedAt,
  };
  if (status === "passed") {
    return {
      ...base,
      status,
      errorCode: null,
      retryable: false,
    };
  }
  if (!isModelConnectionTestErrorCode(errorCode)) {
    return corruptReadinessState();
  }
  return {
    ...base,
    status,
    errorCode,
    retryable: retryable === 1,
  };
}

type StoreModelConnectionTestBase = {
  profileId: string;
  expectedConnectionRevision: number;
  latencyMs: number | null;
  testedAt: string;
};

export type StoreModelConnectionTestInput =
  | (StoreModelConnectionTestBase & {
      status: "passed";
      errorCode: null;
      retryable: false;
    })
  | (StoreModelConnectionTestBase & {
      status: "failed";
      errorCode: ModelConnectionTestErrorCode;
      retryable: boolean;
    });

export type StoreModelConnectionTestResult =
  | { stored: true; result: StoredModelConnectionTest }
  | { stored: false; currentConnectionRevision: number };

function assertStoreInput(
  input: StoreModelConnectionTestInput,
): asserts input is StoreModelConnectionTestInput {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== STORE_INPUT_KEYS.size ||
    Object.keys(input).some((key) => !STORE_INPUT_KEYS.has(key)) ||
    !isUuid(input.profileId) ||
    !isBoundedInteger(
      input.expectedConnectionRevision,
      MAX_MODEL_CONNECTION_REVISION,
    ) ||
    (input.status !== "passed" && input.status !== "failed") ||
    typeof input.retryable !== "boolean" ||
    (input.latencyMs !== null &&
      !isBoundedInteger(
        input.latencyMs,
        MAX_MODEL_CONNECTION_TEST_LATENCY_MS,
      )) ||
    !isStrictUtcIsoMilliseconds(input.testedAt) ||
    (input.errorCode !== null &&
      !isModelConnectionTestErrorCode(input.errorCode)) ||
    (input.status === "passed" &&
      (input.errorCode !== null || input.retryable)) ||
    (input.status === "failed" && input.errorCode === null)
  ) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Model connection readiness result is invalid.",
    );
  }
}

export class ModelConnectionTestsRepository {
  constructor(private readonly database: WorkspaceDatabaseAdapter) {}

  private tx<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the authoritative operation failure.
      }
      throw error;
    }
  }

  get(profileId: string): StoredModelConnectionTest | null {
    if (!isUuid(profileId)) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Model connection readiness lookup is invalid.",
      );
    }
    const row = this.database
      .prepare(
        `SELECT profile_id, connection_revision, status, error_code,
                retryable, latency_ms, tested_at
           FROM model_profile_connection_tests
          WHERE profile_id = ?`,
      )
      .get(profileId);
    return row ? mapStored(row) : null;
  }

  list(): StoredModelConnectionTest[] {
    return this.database
      .prepare(
        `SELECT profile_id, connection_revision, status, error_code,
                retryable, latency_ms, tested_at
           FROM model_profile_connection_tests
          ORDER BY profile_id ASC`,
      )
      .all()
      .map(mapStored);
  }

  hasCurrentPassed(profileId: string): boolean {
    if (!isUuid(profileId)) return false;
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 AS present
             FROM model_profiles profile
             JOIN model_profile_connection_tests test
               ON test.profile_id = profile.id
            WHERE profile.id = ?
              AND test.status = 'passed'
              AND test.error_code IS NULL
              AND test.retryable = 0
              AND test.connection_revision = profile.connection_revision
            LIMIT 1`,
        )
        .get(profileId),
    );
  }

  private disableForFailedTest(
    profileId: string,
    enabled: boolean,
    executionRevision: number,
    now: string,
  ) {
    if (
      !Number.isSafeInteger(executionRevision) ||
      executionRevision < 0 ||
      (enabled && executionRevision >= Number.MAX_SAFE_INTEGER)
    ) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Model profile execution revision is corrupt.",
      );
    }
    this.database
      .prepare(
        `UPDATE model_profiles
            SET enabled = 0,
                is_default = 0,
                execution_revision = execution_revision + ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(enabled ? 1 : 0, now, profileId);
    this.database
      .prepare(
        `UPDATE workspace_settings
            SET default_model_profile_id = NULL,
                updated_at = ?
          WHERE id = 'workspace'
            AND default_model_profile_id = ?`,
      )
      .run(now, profileId);
    this.database
      .prepare(
        `UPDATE projects
            SET default_model_profile_id = NULL,
                updated_at = ?
          WHERE default_model_profile_id = ?`,
      )
      .run(now, profileId);
  }

  storeIfCurrent(
    input: StoreModelConnectionTestInput,
  ): StoreModelConnectionTestResult {
    assertStoreInput(input);
    return this.tx(() => {
      const profile = this.database
        .prepare(
          `SELECT connection_revision, execution_revision, enabled
             FROM model_profiles
            WHERE id = ?`,
        )
        .get(input.profileId);
      if (!profile) {
        throw new WorkspaceApiError(
          404,
          "NOT_FOUND",
          "Model profile was not found.",
        );
      }
      const currentConnectionRevision = profile.connection_revision;
      const currentExecutionRevision = profile.execution_revision;
      const enabled = profile.enabled;
      if (
        !isBoundedInteger(
          currentConnectionRevision,
          MAX_MODEL_CONNECTION_REVISION,
        ) ||
        typeof currentExecutionRevision !== "number" ||
        !Number.isSafeInteger(currentExecutionRevision) ||
        currentExecutionRevision < 0 ||
        (enabled !== 0 && enabled !== 1)
      ) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Model profile connection revision is corrupt.",
        );
      }
      if (currentConnectionRevision !== input.expectedConnectionRevision) {
        return {
          stored: false,
          currentConnectionRevision,
        };
      }
      if (input.status === "failed") {
        this.disableForFailedTest(
          input.profileId,
          enabled === 1,
          currentExecutionRevision,
          input.testedAt,
        );
      }
      this.database
        .prepare(
          `INSERT INTO model_profile_connection_tests
            (profile_id, connection_revision, status, error_code, retryable,
             latency_ms, tested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id) DO UPDATE SET
             connection_revision = excluded.connection_revision,
             status = excluded.status,
             error_code = excluded.error_code,
             retryable = excluded.retryable,
             latency_ms = excluded.latency_ms,
             tested_at = excluded.tested_at`,
        )
        .run(
          input.profileId,
          input.expectedConnectionRevision,
          input.status,
          input.errorCode,
          input.retryable ? 1 : 0,
          input.latencyMs,
          input.testedAt,
        );
      const stored = this.get(input.profileId);
      if (!stored) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Model connection readiness result was not persisted.",
        );
      }
      return { stored: true, result: stored };
    });
  }
}
