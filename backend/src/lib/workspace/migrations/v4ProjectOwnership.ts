import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

/*
 * Project is the durable ownership boundary for project-scoped workflows and
 * runs. The existing v1/v2 foreign keys use ON DELETE SET NULL, so a raw
 * project DELETE would otherwise convert owned legal work into global data.
 *
 * This migration intentionally does not delete historical workflow/run rows
 * whose project_id was already cleared before v4: once both sides were set to
 * NULL there is no reliable provenance left, and recovery must not guess.
 */
const PROJECT_WORKFLOW_DELETE_GUARD_SQL = `
CREATE TRIGGER projects_workflow_ownership_delete_guard
BEFORE DELETE ON projects BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
        FROM workflow_runs run
       WHERE run.project_id = old.id
          OR run.workflow_id IN (
            SELECT workflow.id
              FROM workflows workflow
             WHERE workflow.project_id = old.id
          )
    )
    THEN RAISE(ABORT, 'project workflow runs must be purged before project deletion')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM workflows workflow WHERE workflow.project_id = old.id
    )
    THEN RAISE(ABORT, 'project workflows must be purged before project deletion')
  END;
END;
`;

function applyProjectOwnershipGuard(
  database: WorkspaceDatabaseAdapter,
  _capabilities: WorkspaceDatabaseCapabilities,
) {
  database.exec(PROJECT_WORKFLOW_DELETE_GUARD_SQL);
}

export const PROJECT_OWNERSHIP_MIGRATION: WorkspaceMigration = {
  version: 4,
  name: "project_workflow_ownership_delete_guard",
  checksumMaterial: [
    "workspace-migration-v4",
    "historical-null-project-provenance-is-preserved-not-guessed",
    PROJECT_WORKFLOW_DELETE_GUARD_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applyProjectOwnershipGuard,
};
