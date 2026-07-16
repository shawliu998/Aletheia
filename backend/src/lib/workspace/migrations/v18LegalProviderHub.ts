import {
  LEGAL_PROVIDER_CAPABILITIES_V18,
  LEGAL_PROVIDER_CONNECTION_ERROR_CODES_V18,
  LEGAL_PROVIDER_CREDENTIAL_ORPHAN_REASONS_V18,
  LEGAL_PROVIDER_ENDPOINT_SET_IDS_V18,
  LEGAL_PROVIDER_IDS_V18,
} from "../legalProviderPersistenceContractsV18";
import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const CREATED_AT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
const MAX_REVISION = 2_147_483_647;

const sqlList = (values: readonly string[]) =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");

const strictUuid = (column: string) => `
  typeof(${column}) = 'text' AND length(${column}) = 36 AND
  ${column} GLOB
    '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[1-8][0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
`;
const strictUtc = (column: string) => `
  typeof(${column}) = 'text' AND length(${column}) = 24 AND
  ${column} GLOB
    '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z' AND
  strftime('%Y-%m-%dT%H:%M:%fZ', ${column}) = ${column}
`;
const revision = (column: string) => `
  typeof(${column}) = 'integer' AND ${column} BETWEEN 0 AND ${MAX_REVISION}
`;

const LEGAL_PROVIDER_HUB_V18_SQL = `
CREATE TABLE legal_provider_profiles (
  id TEXT PRIMARY KEY CHECK (${strictUuid("id")}),
  provider TEXT NOT NULL
    CHECK (typeof(provider) = 'text' AND provider IN (${sqlList(LEGAL_PROVIDER_IDS_V18)})),
  endpoint_set_id TEXT NOT NULL
    CHECK (typeof(endpoint_set_id) = 'text' AND endpoint_set_id IN (${sqlList(LEGAL_PROVIDER_ENDPOINT_SET_IDS_V18)})),
  enabled INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(enabled) = 'integer' AND enabled IN (0, 1)),
  credential_reference TEXT CHECK (
    credential_reference IS NULL OR (
      typeof(credential_reference) = 'text' AND
      length(credential_reference) BETWEEN 84 AND 196 AND
      substr(credential_reference, 1, 68) =
        'keychain://vera/legal-provider/' || id || '/' AND
      length(substr(credential_reference, 69)) BETWEEN 16 AND 128 AND
      substr(credential_reference, 69) NOT GLOB '*[^a-z0-9]*'
    )
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (${revision("revision")}),
  connection_revision INTEGER NOT NULL DEFAULT 0
    CHECK (${revision("connection_revision")}),
  credential_revision INTEGER NOT NULL DEFAULT 0
    CHECK (${revision("credential_revision")}),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (${strictUtc("created_at")}),
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (${strictUtc("updated_at")}),
  UNIQUE(provider, endpoint_set_id),
  CHECK (connection_revision <= revision),
  CHECK (credential_revision <= connection_revision),
  CHECK (updated_at >= created_at)
) WITHOUT ROWID;

CREATE INDEX idx_legal_provider_profiles_enabled
  ON legal_provider_profiles(enabled, provider, id);

CREATE TRIGGER legal_provider_profiles_v18_update_guard
BEFORE UPDATE ON legal_provider_profiles BEGIN
  SELECT CASE WHEN
    new.id IS NOT old.id OR new.provider IS NOT old.provider OR
    new.created_at IS NOT old.created_at
  THEN RAISE(ABORT, 'Legal Provider profile ownership is immutable') END;
  SELECT CASE WHEN
    new.revision <> old.revision + 1 OR
    new.connection_revision < old.connection_revision OR
    new.connection_revision > old.connection_revision + 1 OR
    new.credential_revision < old.credential_revision OR
    new.credential_revision > old.credential_revision + 1 OR
    new.updated_at <= old.updated_at
  THEN RAISE(ABORT, 'Legal Provider profile CAS revision is invalid') END;
  SELECT CASE WHEN
    new.credential_reference IS NOT old.credential_reference AND (
      new.credential_revision <> old.credential_revision + 1 OR
      new.connection_revision <> old.connection_revision + 1
    )
  THEN RAISE(ABORT, 'Legal Provider credential change requires new revisions') END;
  SELECT CASE WHEN
    new.credential_reference IS old.credential_reference AND
    new.credential_revision <> old.credential_revision
  THEN RAISE(ABORT, 'Legal Provider credential revision changed without a credential change') END;
  SELECT CASE WHEN
    new.endpoint_set_id IS NOT old.endpoint_set_id AND
    new.connection_revision <> old.connection_revision + 1
  THEN RAISE(ABORT, 'Legal Provider endpoint change requires a connection revision') END;
END;

CREATE TABLE legal_provider_capabilities (
  profile_id TEXT NOT NULL
    REFERENCES legal_provider_profiles(id) ON DELETE CASCADE,
  capability TEXT NOT NULL
    CHECK (typeof(capability) = 'text' AND capability IN (${sqlList(LEGAL_PROVIDER_CAPABILITIES_V18)})),
  enabled INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(enabled) = 'integer' AND enabled IN (0, 1)),
  connection_revision INTEGER NOT NULL DEFAULT 0
    CHECK (${revision("connection_revision")}),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (${strictUtc("created_at")}),
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (${strictUtc("updated_at")}),
  PRIMARY KEY(profile_id, capability),
  CHECK (updated_at >= created_at)
) WITHOUT ROWID;

CREATE INDEX idx_legal_provider_capabilities_enabled
  ON legal_provider_capabilities(capability, profile_id)
  WHERE enabled = 1;

CREATE TRIGGER legal_provider_capabilities_v18_update_guard
BEFORE UPDATE ON legal_provider_capabilities BEGIN
  SELECT CASE WHEN
    new.profile_id IS NOT old.profile_id OR
    new.capability IS NOT old.capability OR
    new.created_at IS NOT old.created_at OR
    new.updated_at <= old.updated_at OR
    new.connection_revision <> old.connection_revision + 1
  THEN RAISE(ABORT, 'Legal Provider capability ownership is immutable') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM legal_provider_profiles profile
     WHERE profile.id = new.profile_id
       AND profile.updated_at = new.updated_at
       AND profile.connection_revision = new.connection_revision
  ) THEN RAISE(ABORT, 'Legal Provider capability change requires a profile connection revision') END;
END;

CREATE TABLE legal_provider_connection_tests (
  profile_id TEXT PRIMARY KEY
    REFERENCES legal_provider_profiles(id) ON DELETE CASCADE,
  connection_revision INTEGER NOT NULL
    CHECK (${revision("connection_revision")}),
  status TEXT NOT NULL
    CHECK (typeof(status) = 'text' AND status IN ('passed', 'failed')),
  error_code TEXT CHECK (
    error_code IS NULL OR (
      typeof(error_code) = 'text' AND
      error_code IN (${sqlList(LEGAL_PROVIDER_CONNECTION_ERROR_CODES_V18)})
    )
  ),
  retryable INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(retryable) = 'integer' AND retryable IN (0, 1)),
  latency_ms INTEGER CHECK (
    latency_ms IS NULL OR (
      typeof(latency_ms) = 'integer' AND latency_ms BETWEEN 0 AND 600000
    )
  ),
  tested_at TEXT NOT NULL CHECK (${strictUtc("tested_at")}),
  CHECK (
    (status = 'passed' AND error_code IS NULL AND retryable = 0) OR
    (status = 'failed' AND error_code IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE TRIGGER legal_provider_connection_tests_v18_revision_guard
BEFORE INSERT ON legal_provider_connection_tests BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM legal_provider_profiles profile
     WHERE profile.id = new.profile_id
       AND profile.connection_revision = new.connection_revision
  ) THEN RAISE(ABORT, 'Legal Provider connection test revision is stale') END;
END;

CREATE TRIGGER legal_provider_connection_tests_v18_update_guard
BEFORE UPDATE ON legal_provider_connection_tests BEGIN
  SELECT CASE WHEN new.profile_id IS NOT old.profile_id
    THEN RAISE(ABORT, 'Legal Provider connection test ownership is immutable')
  END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM legal_provider_profiles profile
     WHERE profile.id = new.profile_id
       AND profile.connection_revision = new.connection_revision
  ) THEN RAISE(ABORT, 'Legal Provider connection test revision is stale') END;
  SELECT CASE WHEN new.tested_at <= old.tested_at
    THEN RAISE(ABORT, 'Legal Provider connection test time must move forwards')
  END;
END;

CREATE TABLE legal_provider_credential_orphan_cleanups (
  reference TEXT PRIMARY KEY CHECK (
    typeof(reference) = 'text' AND
    length(reference) BETWEEN 84 AND 196 AND
    substr(reference, 1, 31) = 'keychain://vera/legal-provider/' AND
    length(substr(reference, 69)) BETWEEN 16 AND 128 AND
    substr(reference, 69) NOT GLOB '*[^a-z0-9]*'
  ),
  profile_id TEXT NOT NULL CHECK (${strictUuid("profile_id")}),
  provider TEXT NOT NULL
    CHECK (typeof(provider) = 'text' AND provider IN (${sqlList(LEGAL_PROVIDER_IDS_V18)})),
  endpoint_set_id TEXT NOT NULL
    CHECK (typeof(endpoint_set_id) = 'text' AND endpoint_set_id IN (${sqlList(LEGAL_PROVIDER_ENDPOINT_SET_IDS_V18)})),
  reason TEXT NOT NULL
    CHECK (typeof(reason) = 'text' AND reason IN (${sqlList(LEGAL_PROVIDER_CREDENTIAL_ORPHAN_REASONS_V18)})),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (${revision("attempt_count")}),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR (
      typeof(last_error_code) = 'text' AND
      length(last_error_code) BETWEEN 1 AND 120 AND
      last_error_code GLOB '[a-z0-9_]*' AND
      last_error_code NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (${strictUtc("created_at")}),
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (${strictUtc("updated_at")}),
  CHECK (
    substr(reference, 1, 68) =
      'keychain://vera/legal-provider/' || profile_id || '/'
  ),
  CHECK (updated_at >= created_at)
) WITHOUT ROWID;

CREATE INDEX idx_legal_provider_credential_orphans_updated
  ON legal_provider_credential_orphan_cleanups(updated_at, reference);

CREATE TRIGGER legal_provider_credential_orphans_v18_update_guard
BEFORE UPDATE ON legal_provider_credential_orphan_cleanups BEGIN
  SELECT CASE WHEN
    new.reference IS NOT old.reference OR
    new.profile_id IS NOT old.profile_id OR
    new.provider IS NOT old.provider OR
    new.endpoint_set_id IS NOT old.endpoint_set_id OR
    new.reason IS NOT old.reason OR
    new.created_at IS NOT old.created_at OR
    new.attempt_count < old.attempt_count OR
    new.updated_at < old.updated_at
  THEN RAISE(ABORT, 'Legal Provider credential cleanup binding is immutable') END;
END;
`;

function applyLegalProviderHubV18(
  database: WorkspaceDatabaseAdapter,
  _capabilities: WorkspaceDatabaseCapabilities,
) {
  database.exec(LEGAL_PROVIDER_HUB_V18_SQL);
}

export const LEGAL_PROVIDER_HUB_V18_MIGRATION: WorkspaceMigration = {
  version: 18,
  name: "active_legal_provider_hub",
  checksumMaterial: [
    "workspace-migration-v18",
    "additive-no-provider-seed-no-endpoint-url-no-secret-persistence",
    "one-yuandian-profile-per-code-owned-endpoint-set",
    "three-explicit-capabilities-and-current-revision-connection-tests",
    "keychain-reference-only-cas-revisions-and-durable-orphan-cleanup",
    "connection-test-pass-never-implies-provider-ready-or-licensed",
    LEGAL_PROVIDER_HUB_V18_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applyLegalProviderHubV18,
};
