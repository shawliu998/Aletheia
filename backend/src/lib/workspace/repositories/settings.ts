import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import type { WorkspaceSettings } from "../types";
type Row = Record<string, unknown>;
const map = (r: Row): WorkspaceSettings => ({
  id: "workspace",
  locale: r.locale as WorkspaceSettings["locale"],
  theme: r.theme as WorkspaceSettings["theme"],
  defaultModelProfileId:
    r.default_model_profile_id == null
      ? null
      : String(r.default_model_profile_id),
  defaultProjectId:
    r.default_project_id == null ? null : String(r.default_project_id),
  updatedAt: String(r.updated_at),
});
export class SettingsRepository {
  constructor(readonly database: WorkspaceDatabaseAdapter) {}
  private connectionReadinessGateEnabled() {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 AS present
             FROM sqlite_schema
            WHERE type = 'table'
              AND name = 'model_profile_connection_tests' COLLATE NOCASE`,
        )
        .get(),
    );
  }
  get() {
    const r = this.database
      .prepare("SELECT * FROM workspace_settings WHERE id='workspace'")
      .get();
    if (!r)
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workspace settings sentinel is missing.",
      );
    return map(r);
  }
  update(
    input: Partial<Omit<WorkspaceSettings, "id" | "updatedAt">> & {
      now: string;
    },
  ) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.get();
      if (
        input.defaultProjectId !== undefined &&
        input.defaultProjectId !== null
      ) {
        const project = this.database
          .prepare("SELECT id FROM projects WHERE id=? AND status='active'")
          .get(input.defaultProjectId);
        if (!project)
          throw new WorkspaceApiError(
            409,
            "CONFLICT",
            "Default project must be active.",
          );
      }
      if (
        input.defaultModelProfileId !== undefined &&
        input.defaultModelProfileId !== null
      ) {
        const profile = this.connectionReadinessGateEnabled()
          ? this.database
              .prepare(
                `SELECT profile.id
                   FROM model_profiles profile
                   JOIN model_profile_connection_tests test
                     ON test.profile_id = profile.id
                  WHERE profile.id = ?
                    AND profile.enabled = 1
                    AND test.connection_revision = profile.connection_revision
                    AND test.status = 'passed'
                    AND test.error_code IS NULL
                    AND test.retryable = 0`,
              )
              .get(input.defaultModelProfileId)
          : this.database
              .prepare("SELECT id FROM model_profiles WHERE id=? AND enabled=1")
              .get(input.defaultModelProfileId);
        if (!profile)
          throw new WorkspaceApiError(
            409,
            "CONFLICT",
            "Default model profile must be enabled with a current passed connection test.",
          );
      }
      if (input.defaultModelProfileId !== undefined) {
        this.database
          .prepare("UPDATE model_profiles SET is_default=0 WHERE is_default=1")
          .run();
        if (input.defaultModelProfileId !== null) {
          this.database
            .prepare(
              "UPDATE model_profiles SET is_default=1,updated_at=? WHERE id=?",
            )
            .run(input.now, input.defaultModelProfileId);
        }
      }
      this.database
        .prepare(
          "UPDATE workspace_settings SET locale=?,theme=?,default_model_profile_id=?,default_project_id=?,updated_at=? WHERE id='workspace'",
        )
        .run(
          input.locale ?? current.locale,
          input.theme ?? current.theme,
          input.defaultModelProfileId === undefined
            ? current.defaultModelProfileId
            : input.defaultModelProfileId,
          input.defaultProjectId === undefined
            ? current.defaultProjectId
            : input.defaultProjectId,
          input.now,
        );
      this.database.exec("COMMIT");
      return this.get();
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
}
