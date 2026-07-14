import { MODEL_CONNECTION_TEST_ERROR_CODES } from "../modelConnectionReadiness";
import { WorkspaceMigrationError } from "./runner";
import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const V9_TABLE = "model_profile_connection_tests";
const MAX_CONNECTION_REVISION = 2_147_483_647;
const MAX_CONNECTION_TEST_LATENCY_MS = 600_000;
const V9_UNRECORDED_SCHEMA_MARKER_ERROR =
  "Workspace schema v9 markers exist without a recorded v9 migration; restore from backup or rebuild the model connection-readiness migration atomically.";
const V9_MISSING_V8_PREREQUISITE_ERROR =
  "Workspace schema v9 requires the complete model credential schema from v8.";

const sqlStringList = (values: readonly string[]) =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");

const ADD_CONNECTION_REVISION_SQL = `ALTER TABLE model_profiles
  ADD COLUMN connection_revision INTEGER NOT NULL DEFAULT 0
  CHECK (
    typeof(connection_revision) = 'integer'
    AND connection_revision BETWEEN 0 AND ${MAX_CONNECTION_REVISION}
  )`;

const V9_CONNECTION_TEST_TABLE_SQL = `
CREATE TABLE ${V9_TABLE} (
  profile_id TEXT NOT NULL PRIMARY KEY
    CHECK (typeof(profile_id) = 'text' AND length(trim(profile_id)) >= 1)
    REFERENCES model_profiles(id) ON DELETE CASCADE,
  connection_revision INTEGER NOT NULL
    CHECK (
      typeof(connection_revision) = 'integer'
      AND connection_revision BETWEEN 0 AND ${MAX_CONNECTION_REVISION}
    ),
  status TEXT NOT NULL
    CHECK (typeof(status) = 'text' AND status IN ('passed', 'failed')),
  error_code TEXT
    CHECK (
      error_code IS NULL OR (
        typeof(error_code) = 'text'
        AND error_code IN (${sqlStringList(MODEL_CONNECTION_TEST_ERROR_CODES)})
      )
    ),
  retryable INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(retryable) = 'integer' AND retryable IN (0, 1)),
  latency_ms INTEGER
    CHECK (
      latency_ms IS NULL OR (
        typeof(latency_ms) = 'integer'
        AND latency_ms BETWEEN 0 AND ${MAX_CONNECTION_TEST_LATENCY_MS}
      )
    ),
  tested_at TEXT NOT NULL
    CHECK (
      typeof(tested_at) = 'text'
      AND length(tested_at) = 24
      AND tested_at GLOB
        '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z'
      AND strftime('%Y-%m-%dT%H:%M:%fZ', tested_at) = tested_at
    ),
  CHECK (
    (status = 'passed' AND error_code IS NULL AND retryable = 0)
    OR
    (status = 'failed' AND error_code IS NOT NULL)
  )
) WITHOUT ROWID;
`;

const FORCE_PROFILES_DORMANT_SQL = `UPDATE model_profiles
  SET enabled = 0,
      is_default = 0
  WHERE enabled <> 0 OR is_default <> 0`;
const CLEAR_WORKSPACE_DEFAULT_SQL = `UPDATE workspace_settings
  SET default_model_profile_id = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE default_model_profile_id IS NOT NULL`;
const CLEAR_PROJECT_DEFAULTS_SQL = `UPDATE projects
  SET default_model_profile_id = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE default_model_profile_id IS NOT NULL`;

const V9_SCHEMA_POLICY = JSON.stringify({
  table: V9_TABLE,
  cardinality: "one_latest_result_per_profile",
  connectionRevision: {
    profileColumn: "model_profiles.connection_revision",
    distinctFromExecutionRevision: true,
    type: "integer",
    minimum: 0,
    maximum: MAX_CONNECTION_REVISION,
  },
  currentResult:
    "status=passed AND connection.connection_revision=model_profiles.connection_revision",
  staleResult:
    "connection.connection_revision<>model_profiles.connection_revision",
  disabledProfilesMayBeTested: true,
  enableDoesNotChangeConnectionRevision: true,
  enableRequiresCurrentPassedResult: true,
  defaultRequiresEnabledCurrentPassedResult: true,
  upgradeBehavior: {
    profiles: "force all pre-v9 enabled/default model profiles dormant",
    workspaceDefault: "clear",
    projectDefaults: "clear",
    otherProfileCredentialAndOrphanData: "preserve",
  },
  providerResponseBodiesPersisted: false,
  secretMaterialPersisted: false,
  deleteBehavior: "profile delete cascades readiness result",
  maximumLatencyMs: MAX_CONNECTION_TEST_LATENCY_MS,
  testedAt: "strict UTC ISO-8601 with millisecond precision",
  errorCodes: MODEL_CONNECTION_TEST_ERROR_CODES,
});

function normalizeSql(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function hasTable(database: WorkspaceDatabaseAdapter, name: string) {
  return Boolean(
    database
      .prepare(
        `SELECT 1 AS present
           FROM main.sqlite_schema
          WHERE type = 'table' AND name = ? COLLATE NOCASE`,
      )
      .get(name),
  );
}

function columns(database: WorkspaceDatabaseAdapter, table: string) {
  return database
    .prepare(`PRAGMA main.table_info("${table.replaceAll('"', '""')}")`)
    .all();
}

function columnNameSet(database: WorkspaceDatabaseAdapter, table: string) {
  return new Set(
    columns(database, table).map((row) => String(row.name).toLowerCase()),
  );
}

function schemaSql(
  database: WorkspaceDatabaseAdapter,
  type: "table" | "view" | "index",
  name: string,
) {
  const row = database
    .prepare(
      `SELECT sql
         FROM main.sqlite_schema
        WHERE type = ? AND name = ? COLLATE NOCASE`,
    )
    .get(type, name);
  return typeof row?.sql === "string" ? row.sql : null;
}

function assertV8Prerequisites(database: WorkspaceDatabaseAdapter) {
  for (const table of [
    "model_profiles",
    "model_profile_credential_orphan_cleanups",
    "workspace_settings",
    "projects",
  ]) {
    if (!hasTable(database, table)) {
      throw new WorkspaceMigrationError(V9_MISSING_V8_PREREQUISITE_ERROR);
    }
  }
  const requiredColumns: Record<string, string[]> = {
    model_profiles: [
      "credential_origin",
      "credential_state",
      "migration_issue_code",
      "execution_revision",
      "enabled",
      "is_default",
    ],
    workspace_settings: ["default_model_profile_id", "updated_at"],
    projects: ["default_model_profile_id", "updated_at"],
  };
  for (const [table, expected] of Object.entries(requiredColumns)) {
    const actual = columnNameSet(database, table);
    if (expected.some((name) => !actual.has(name))) {
      throw new WorkspaceMigrationError(V9_MISSING_V8_PREREQUISITE_ERROR);
    }
  }
}

function unrecordedV9Markers(database: WorkspaceDatabaseAdapter) {
  const markers: string[] = [];
  if (columnNameSet(database, "model_profiles").has("connection_revision")) {
    markers.push("column:model_profiles.connection_revision");
  }
  const objects = database
    .prepare(
      `SELECT type, name
         FROM main.sqlite_schema
        WHERE type IN ('table', 'view', 'index')
          AND name = ? COLLATE NOCASE
        ORDER BY type, name`,
    )
    .all(V9_TABLE);
  for (const object of objects) {
    markers.push(`${String(object.type)}:${String(object.name)}`);
  }
  return markers;
}

function assertNoUnrecordedV9Markers(database: WorkspaceDatabaseAdapter) {
  const markers = unrecordedV9Markers(database);
  if (markers.length > 0) {
    throw new WorkspaceMigrationError(
      `${V9_UNRECORDED_SCHEMA_MARKER_ERROR} Found: ${markers.join(", ")}.`,
    );
  }
}

type ExpectedColumn = {
  name: string;
  type: string;
  notNull: number;
  defaultValue: string | null;
  primaryKey: number;
};

function assertColumns(
  database: WorkspaceDatabaseAdapter,
  table: string,
  expected: ExpectedColumn[],
) {
  const actual = columns(database, table);
  const valid =
    actual.length === expected.length &&
    actual.every((column, index) => {
      const wanted = expected[index];
      return (
        String(column.name) === wanted.name &&
        String(column.type).toUpperCase() === wanted.type &&
        Number(column.notnull) === wanted.notNull &&
        (column.dflt_value === null ? null : String(column.dflt_value)) ===
          wanted.defaultValue &&
        Number(column.pk) === wanted.primaryKey
      );
    });
  if (!valid) {
    throw new WorkspaceMigrationError(
      "Workspace schema v9 connection-readiness columns are incomplete.",
    );
  }
}

function assertV9Postconditions(database: WorkspaceDatabaseAdapter) {
  const profileColumns = columns(database, "model_profiles");
  const connectionRevision = profileColumns.find(
    (column) => String(column.name) === "connection_revision",
  );
  if (
    !connectionRevision ||
    String(connectionRevision.type).toUpperCase() !== "INTEGER" ||
    Number(connectionRevision.notnull) !== 1 ||
    String(connectionRevision.dflt_value) !== "0" ||
    Number(connectionRevision.pk) !== 0
  ) {
    throw new WorkspaceMigrationError(
      "Workspace schema v9 model connection revision is incomplete.",
    );
  }

  const profileSql = schemaSql(database, "table", "model_profiles");
  const normalizedProfileSql = profileSql ? normalizeSql(profileSql) : "";
  for (const fragment of [
    "connection_revision integer not null default 0",
    "typeof(connection_revision) = 'integer'",
    `connection_revision between 0 and ${MAX_CONNECTION_REVISION}`,
  ]) {
    if (!normalizedProfileSql.includes(normalizeSql(fragment))) {
      throw new WorkspaceMigrationError(
        "Workspace schema v9 model connection revision checks are incomplete.",
      );
    }
  }

  assertColumns(database, V9_TABLE, [
    {
      name: "profile_id",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKey: 1,
    },
    {
      name: "connection_revision",
      type: "INTEGER",
      notNull: 1,
      defaultValue: null,
      primaryKey: 0,
    },
    {
      name: "status",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKey: 0,
    },
    {
      name: "error_code",
      type: "TEXT",
      notNull: 0,
      defaultValue: null,
      primaryKey: 0,
    },
    {
      name: "retryable",
      type: "INTEGER",
      notNull: 1,
      defaultValue: "0",
      primaryKey: 0,
    },
    {
      name: "latency_ms",
      type: "INTEGER",
      notNull: 0,
      defaultValue: null,
      primaryKey: 0,
    },
    {
      name: "tested_at",
      type: "TEXT",
      notNull: 1,
      defaultValue: null,
      primaryKey: 0,
    },
  ]);

  const tableSql = schemaSql(database, "table", V9_TABLE);
  const normalizedTableSql = tableSql ? normalizeSql(tableSql) : "";
  const requiredSqlFragments = [
    "without rowid",
    "typeof(profile_id) = 'text'",
    "length(trim(profile_id)) >= 1",
    "typeof(connection_revision) = 'integer'",
    `connection_revision between 0 and ${MAX_CONNECTION_REVISION}`,
    "typeof(status) = 'text'",
    "status in ('passed', 'failed')",
    "typeof(error_code) = 'text'",
    "typeof(retryable) = 'integer'",
    "retryable in (0, 1)",
    "typeof(latency_ms) = 'integer'",
    `latency_ms between 0 and ${MAX_CONNECTION_TEST_LATENCY_MS}`,
    "typeof(tested_at) = 'text'",
    "length(tested_at) = 24",
    `tested_at glob
        '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]t[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]z'`,
    "strftime('%Y-%m-%dT%H:%M:%fZ', tested_at) = tested_at",
    "status = 'passed' and error_code is null and retryable = 0",
    "status = 'failed' and error_code is not null",
  ];
  for (const code of MODEL_CONNECTION_TEST_ERROR_CODES) {
    requiredSqlFragments.push(`'${code}'`);
  }
  if (
    !normalizedTableSql.endsWith("without rowid") ||
    requiredSqlFragments.some(
      (fragment) => !normalizedTableSql.includes(normalizeSql(fragment)),
    )
  ) {
    throw new WorkspaceMigrationError(
      "Workspace schema v9 connection-readiness checks are incomplete.",
    );
  }

  const foreignKeys = database
    .prepare(`PRAGMA main.foreign_key_list("${V9_TABLE}")`)
    .all();
  if (
    foreignKeys.length !== 1 ||
    String(foreignKeys[0]?.table) !== "model_profiles" ||
    String(foreignKeys[0]?.from) !== "profile_id" ||
    String(foreignKeys[0]?.to) !== "id" ||
    String(foreignKeys[0]?.on_update).toUpperCase() !== "NO ACTION" ||
    String(foreignKeys[0]?.on_delete).toUpperCase() !== "CASCADE"
  ) {
    throw new WorkspaceMigrationError(
      "Workspace schema v9 connection-readiness ownership is incomplete.",
    );
  }

  if (
    database
      .prepare(
        `SELECT 1 AS invalid
           FROM model_profiles
          WHERE enabled <> 0 OR is_default <> 0
          LIMIT 1`,
      )
      .get() ||
    database
      .prepare(
        `SELECT 1 AS invalid
           FROM workspace_settings
          WHERE default_model_profile_id IS NOT NULL
          LIMIT 1`,
      )
      .get() ||
    database
      .prepare(
        `SELECT 1 AS invalid
           FROM projects
          WHERE default_model_profile_id IS NOT NULL
          LIMIT 1`,
      )
      .get() ||
    database.prepare(`SELECT 1 AS invalid FROM ${V9_TABLE} LIMIT 1`).get()
  ) {
    throw new WorkspaceMigrationError(
      "Workspace schema v9 connection-readiness dormant upgrade is incomplete.",
    );
  }
}

function applyModelConnectionReadinessV9(
  database: WorkspaceDatabaseAdapter,
  _capabilities: WorkspaceDatabaseCapabilities,
) {
  assertV8Prerequisites(database);
  assertNoUnrecordedV9Markers(database);
  database.exec(ADD_CONNECTION_REVISION_SQL);
  database.exec(V9_CONNECTION_TEST_TABLE_SQL);
  database.prepare(FORCE_PROFILES_DORMANT_SQL).run();
  database.prepare(CLEAR_WORKSPACE_DEFAULT_SQL).run();
  database.prepare(CLEAR_PROJECT_DEFAULTS_SQL).run();
  assertV9Postconditions(database);
}

export const MODEL_CONNECTION_READINESS_V9_MIGRATION: WorkspaceMigration = {
  version: 9,
  name: "workspace_model_connection_readiness",
  checksumMaterial: [
    V9_UNRECORDED_SCHEMA_MARKER_ERROR,
    V9_MISSING_V8_PREREQUISITE_ERROR,
    ADD_CONNECTION_REVISION_SQL,
    V9_CONNECTION_TEST_TABLE_SQL,
    FORCE_PROFILES_DORMANT_SQL,
    CLEAR_WORKSPACE_DEFAULT_SQL,
    CLEAR_PROJECT_DEFAULTS_SQL,
    V9_SCHEMA_POLICY,
  ].join("\n-- checksum boundary --\n"),
  apply: applyModelConnectionReadinessV9,
};
