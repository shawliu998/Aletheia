import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

/*
 * Workflow execution must retain the exact, non-secret configuration that was
 * accepted by a run.  It deliberately lives beside (rather than inside)
 * workflow_runs so existing v1 data remains readable and the snapshot can be
 * immutable by trigger.
 */
const WORKFLOW_RUNTIME_V6_SQL = `
CREATE TABLE workflow_system_templates (
  workflow_id TEXT NOT NULL UNIQUE REFERENCES workflows(id) ON DELETE CASCADE,
  upstream_id TEXT NOT NULL UNIQUE
    CHECK (length(trim(upstream_id)) BETWEEN 1 AND 240),
  upstream_version TEXT NOT NULL
    CHECK (length(trim(upstream_version)) BETWEEN 1 AND 160),
  source_sha256 TEXT NOT NULL
    CHECK (length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id)
);

CREATE TABLE workflow_execution_snapshots (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  workflow_version TEXT NOT NULL CHECK (length(trim(workflow_version)) BETWEEN 1 AND 160),
  -- These are historical execution bindings, not live foreign keys.  A later
  -- project/profile deletion must not rewrite immutable execution evidence.
  project_id TEXT,
  model_profile_id TEXT,
  config_json TEXT NOT NULL
    CHECK (json_valid(config_json) AND json_type(config_json) = 'object'),
  steps_json TEXT NOT NULL
    CHECK (json_valid(steps_json) AND json_type(steps_json) = 'array'),
  skill_markdown TEXT NOT NULL,
  columns_config_json TEXT NOT NULL
    CHECK (json_valid(columns_config_json) AND json_type(columns_config_json) = 'array'),
  input_binding_json TEXT NOT NULL
    CHECK (json_valid(input_binding_json) AND json_type(input_binding_json) = 'object'),
  snapshot_sha256 TEXT NOT NULL
    CHECK (length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_workflow_execution_snapshots_workflow
  ON workflow_execution_snapshots(workflow_id, created_at DESC);

CREATE TABLE workflow_run_idempotency (
  idempotency_key TEXT PRIMARY KEY
    CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 240),
  workflow_run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  project_id TEXT,
  retry_of_run_id TEXT,
  snapshot_sha256 TEXT NOT NULL
    CHECK (length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  input_sha256 TEXT NOT NULL
    CHECK (length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
);

CREATE INDEX idx_workflow_run_idempotency_workflow
  ON workflow_run_idempotency(workflow_id, created_at DESC);

CREATE TRIGGER workflow_execution_snapshots_validate_insert
BEFORE INSERT ON workflow_execution_snapshots BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM workflow_runs run
      JOIN workflows workflow ON workflow.id = run.workflow_id
      LEFT JOIN projects project ON project.id = new.project_id
      LEFT JOIN model_profiles profile ON profile.id = new.model_profile_id
     WHERE run.id = new.workflow_run_id
       AND run.workflow_id IS new.workflow_id
       AND run.project_id IS new.project_id
       AND run.model_profile_id IS new.model_profile_id
       AND (workflow.project_id IS NULL OR workflow.project_id IS run.project_id)
       AND (new.project_id IS NULL OR project.id IS NOT NULL)
       AND (new.model_profile_id IS NULL OR profile.id IS NOT NULL)
  ) THEN RAISE(ABORT, 'workflow snapshot binding does not match its run') END;
END;

CREATE TRIGGER workflow_run_idempotency_validate_insert
BEFORE INSERT ON workflow_run_idempotency BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM workflow_runs run
      JOIN workflow_execution_snapshots snapshot
        ON snapshot.workflow_run_id = run.id
     WHERE run.id = new.workflow_run_id
       AND run.workflow_id IS new.workflow_id
       AND run.project_id IS new.project_id
       AND run.retry_of_run_id IS new.retry_of_run_id
       AND snapshot.workflow_id IS new.workflow_id
       AND snapshot.project_id IS new.project_id
       AND snapshot.snapshot_sha256 = new.snapshot_sha256
  ) THEN RAISE(ABORT, 'workflow idempotency binding does not match run snapshot') END;
END;

CREATE TRIGGER workflow_execution_snapshots_immutable_update
BEFORE UPDATE ON workflow_execution_snapshots BEGIN
  SELECT RAISE(ABORT, 'workflow execution snapshots are immutable');
END;

CREATE TRIGGER workflow_run_idempotency_immutable_update
BEFORE UPDATE ON workflow_run_idempotency BEGIN
  SELECT RAISE(ABORT, 'workflow run idempotency records are immutable');
END;
`;

/*
 * v1-v5 runs predate immutable snapshots.  They cannot be safely claimed by
 * the P1 runtime, so leave completed history readable and explicitly interrupt
 * only executable work.  The error code is stable for UI/audit handling.
 */
const WORKFLOW_RUNTIME_V6_RECONCILIATION_SQL = `
UPDATE jobs
   SET status = 'interrupted',
       retryable = 0,
       error_json = '{"code":"workflow_snapshot_migration_required","message":"Workflow execution was interrupted because it predates immutable snapshots.","retryable":false,"details":null}',
       error_code = 'workflow_snapshot_migration_required',
       locked_at = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE type = 'workflow_run'
   AND status IN ('queued', 'running')
   AND id IN (
     SELECT run.job_id
       FROM workflow_runs run
      WHERE run.status IN ('queued', 'waiting', 'running')
        AND run.job_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM workflow_execution_snapshots snapshot
           WHERE snapshot.workflow_run_id = run.id
        )
   );

UPDATE workflow_step_runs
   SET status = 'interrupted',
       error_json = '{"code":"workflow_snapshot_migration_required","message":"Workflow execution was interrupted because it predates immutable snapshots.","retryable":false,"details":null}',
       error_code = 'workflow_snapshot_migration_required',
       completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status IN ('queued', 'waiting', 'running')
   AND workflow_run_id IN (
     SELECT run.id
       FROM workflow_runs run
      WHERE run.status IN ('queued', 'waiting', 'running')
        AND NOT EXISTS (
          SELECT 1 FROM workflow_execution_snapshots snapshot
           WHERE snapshot.workflow_run_id = run.id
        )
   );

UPDATE workflow_runs
   SET status = 'interrupted',
       error_json = '{"code":"workflow_snapshot_migration_required","message":"Workflow execution was interrupted because it predates immutable snapshots.","retryable":false,"details":null}',
       error_code = 'workflow_snapshot_migration_required',
       completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status IN ('queued', 'waiting', 'running')
   AND NOT EXISTS (
     SELECT 1 FROM workflow_execution_snapshots snapshot
      WHERE snapshot.workflow_run_id = workflow_runs.id
   );
`;

function applyWorkflowRuntimeV6(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  if (!capabilities.jsonTextChecks) {
    throw new Error(
      "Workspace schema v6 requires SQLite JSON1 for immutable workflow snapshots.",
    );
  }
  database.exec(WORKFLOW_RUNTIME_V6_SQL);
  database.exec(WORKFLOW_RUNTIME_V6_RECONCILIATION_SQL);
}

export const WORKFLOW_RUNTIME_V6_MIGRATION: WorkspaceMigration = {
  version: 6,
  name: "workflow_runtime_snapshots_and_builtin_mapping",
  checksumMaterial: [
    "workspace-migration-v6",
    "immutable-versioned-non-secret-workflow-snapshot",
    WORKFLOW_RUNTIME_V6_SQL,
    WORKFLOW_RUNTIME_V6_RECONCILIATION_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applyWorkflowRuntimeV6,
};
