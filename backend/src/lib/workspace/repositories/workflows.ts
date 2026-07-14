import {
  SafeStructuredValueSchema,
  StructuredErrorSchema,
  WorkflowColumnSchema,
  WorkflowJurisdictionsSchema,
  WorkflowMetadataSchema,
  WorkflowRunSchema,
  WorkflowSchema,
  WorkflowStepRunSchema,
  WorkflowStepSchema,
  WorkspaceIdSchema,
} from "../contracts";
import type { WorkspaceDatabaseAdapter } from "../database";
import { WorkspaceApiError } from "../errors";
import {
  normalizePageRequest,
  type Page,
  type PageRequest,
} from "../pagination";
import type {
  StructuredError,
  Workflow,
  WorkflowColumn,
  WorkflowRun,
  WorkflowStep,
  WorkflowStepRun,
  WorkspaceJson,
} from "../types";

type Row = Record<string, unknown>;

export type WorkflowRunStep = WorkflowStepRun & { attempt: number };
export type WorkflowRunRecord = WorkflowRun & { retryOfRunId: string | null };
export type WorkflowRunDetail = {
  run: WorkflowRunRecord;
  steps: WorkflowRunStep[];
};

export type NewWorkflowRecord = {
  id: string;
  type: Workflow["type"];
  projectId: string | null;
  title: string;
  description: string | null;
  skillMarkdown: string;
  steps: WorkflowStep[];
  columns: WorkflowColumn[];
  language: string;
  practice: string;
  jurisdictions: string[];
  metadata: Record<string, WorkspaceJson>;
  isBuiltin: boolean;
  now: string;
};

export type NewWorkflowRunRecord = {
  id: string;
  workflowId: string;
  projectId: string | null;
  modelProfileId: string;
  jobId: string;
  retryOfRunId: string | null;
  input: WorkspaceJson;
  steps: Array<{
    id: string;
    ordinal: number;
    attempt: number;
    step: WorkflowStep;
    status: WorkflowRunStep["status"];
    input: WorkspaceJson;
    output: WorkspaceJson | null;
    error: StructuredError | null;
    startedAt: string | null;
    completedAt: string | null;
  }>;
  now: string;
};

const encodeCursor = (value: { createdAt: string; id: string }) =>
  Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

function decodeCursor(cursor: string | null) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      typeof value.createdAt !== "string" ||
      !value.createdAt ||
      typeof value.id !== "string" ||
      !value.id
    ) {
      throw new Error("invalid cursor");
    }
    return { createdAt: value.createdAt, id: value.id };
  } catch {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Invalid pagination cursor.",
    );
  }
}

function parseJson<T>(
  value: unknown,
  schema: { parse(input: unknown): T },
  label: string,
): T {
  if (typeof value !== "string") {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      `Invalid persisted ${label}.`,
    );
  }
  try {
    return schema.parse(JSON.parse(value));
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      `Invalid persisted ${label}.`,
    );
  }
}

function optionalJson<T>(
  value: unknown,
  schema: { parse(input: unknown): T },
  label: string,
): T | null {
  return value == null ? null : parseJson(value, schema, label);
}

function mapWorkflow(row: Row): Workflow {
  const type = row.type;
  const common = {
    id: String(row.id),
    projectId: row.project_id == null ? null : String(row.project_id),
    title: String(row.title),
    description: row.description == null ? null : String(row.description),
    status: row.status,
    steps: parseJson(
      row.steps_json,
      WorkflowStepSchema.array().max(100),
      "workflow steps",
    ),
    language: String(row.language),
    practice: String(row.practice),
    jurisdictions: parseJson(
      row.jurisdictions_json,
      WorkflowJurisdictionsSchema,
      "workflow jurisdictions",
    ),
    metadata: parseJson(
      row.metadata_json,
      WorkflowMetadataSchema,
      "workflow metadata",
    ),
    isBuiltin: Number(row.is_builtin) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
  const candidate =
    type === "assistant"
      ? { ...common, type, skillMarkdown: String(row.skill_markdown) }
      : type === "tabular"
        ? {
            ...common,
            type,
            columns: parseJson(
              row.columns_config_json,
              WorkflowColumnSchema.array().max(100),
              "workflow columns",
            ),
          }
        : null;
  if (!candidate) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid persisted workflow type.",
    );
  }
  try {
    return WorkflowSchema.parse(candidate);
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid persisted workflow.",
    );
  }
}

function mapRun(row: Row): WorkflowRunRecord {
  const candidate = {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    projectId: row.project_id == null ? null : String(row.project_id),
    status: row.status,
    modelProfileId:
      row.model_profile_id == null ? null : String(row.model_profile_id),
    jobId: row.job_id == null ? null : String(row.job_id),
    input: parseJson(
      row.input_json,
      SafeStructuredValueSchema,
      "workflow run input",
    ),
    output: optionalJson(
      row.output_json,
      SafeStructuredValueSchema,
      "workflow run output",
    ),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    error: optionalJson(
      row.error_json,
      StructuredErrorSchema,
      "workflow run error",
    ),
    createdAt: String(row.created_at),
  };
  try {
    return {
      ...WorkflowRunSchema.parse(candidate),
      retryOfRunId:
        row.retry_of_run_id == null
          ? null
          : WorkspaceIdSchema.parse(String(row.retry_of_run_id)),
    };
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid persisted workflow run.",
    );
  }
}

function mapStepRun(row: Row): WorkflowRunStep {
  const candidate = {
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    ordinal: Number(row.ordinal),
    step: parseJson(row.step_json, WorkflowStepSchema, "workflow step"),
    status: row.status,
    input: parseJson(
      row.input_json,
      SafeStructuredValueSchema,
      "workflow step input",
    ),
    output: optionalJson(
      row.output_json,
      SafeStructuredValueSchema,
      "workflow step output",
    ),
    error: optionalJson(
      row.error_json,
      StructuredErrorSchema,
      "workflow step error",
    ),
    startedAt: row.started_at == null ? null : String(row.started_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
  };
  try {
    const attempt = Number(row.attempt);
    if (!Number.isInteger(attempt) || attempt < 1)
      throw new Error("invalid attempt");
    return { ...WorkflowStepRunSchema.parse(candidate), attempt };
  } catch {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      "Invalid persisted workflow step run.",
    );
  }
}

function serialize(value: unknown) {
  return JSON.stringify(value);
}

export class WorkflowsRepository {
  constructor(readonly database: WorkspaceDatabaseAdapter) {}

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
  }

  list(
    request: PageRequest & {
      type?: Workflow["type"];
      projectId?: string | null;
      includeArchived?: boolean;
      includeHidden?: boolean;
    } = {},
  ): Page<Workflow> {
    const page = normalizePageRequest(request);
    const cursor = decodeCursor(page.cursor);
    const conditions = [
      request.includeArchived ? "1 = 1" : "w.status = 'active'",
    ];
    const parameters: unknown[] = [];
    if (request.type) {
      conditions.push("w.type = ?");
      parameters.push(request.type);
    }
    if (request.projectId !== undefined) {
      if (request.projectId === null) {
        conditions.push("w.project_id IS NULL");
      } else {
        conditions.push("w.project_id = ?");
        parameters.push(request.projectId);
      }
    }
    if (!request.includeHidden) {
      conditions.push(
        "NOT EXISTS (SELECT 1 FROM hidden_workflows h WHERE h.workflow_id = w.id)",
      );
    }
    if (cursor) {
      conditions.push("(w.updated_at < ? OR (w.updated_at = ? AND w.id < ?))");
      parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }
    parameters.push(page.limit + 1);
    const rows = this.database
      .prepare(
        `SELECT w.* FROM workflows w
         WHERE ${conditions.join(" AND ")}
         ORDER BY w.updated_at DESC, w.id DESC
         LIMIT ?`,
      )
      .all(...parameters);
    const items = rows.slice(0, page.limit).map(mapWorkflow);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > page.limit && last
          ? encodeCursor({ createdAt: last.updatedAt, id: last.id })
          : null,
    };
  }

  get(id: string): Workflow | null {
    const row = this.database
      .prepare("SELECT * FROM workflows WHERE id = ?")
      .get(id);
    return row ? mapWorkflow(row) : null;
  }

  require(id: string): Workflow {
    const workflow = this.get(id);
    if (!workflow)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Workflow not found.");
    return workflow;
  }

  create(input: NewWorkflowRecord): Workflow {
    this.database
      .prepare(
        `INSERT INTO workflows
          (id, type, project_id, title, description, status, skill_markdown,
           steps_json, columns_config_json, language, practice,
           jurisdictions_json, metadata_json, is_builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.type,
        input.projectId,
        input.title,
        input.description,
        input.skillMarkdown,
        serialize(input.steps),
        serialize(input.columns),
        input.language,
        input.practice,
        serialize(input.jurisdictions),
        serialize(input.metadata),
        input.isBuiltin ? 1 : 0,
        input.now,
        input.now,
      );
    return this.require(input.id);
  }

  replace(workflow: Workflow, now: string): Workflow {
    this.require(workflow.id);
    this.database
      .prepare(
        `UPDATE workflows
         SET project_id = ?, title = ?, description = ?, status = ?,
             skill_markdown = ?, steps_json = ?, columns_config_json = ?,
             language = ?, practice = ?, jurisdictions_json = ?,
             metadata_json = ?, is_builtin = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        workflow.projectId,
        workflow.title,
        workflow.description,
        workflow.status,
        workflow.type === "assistant" ? workflow.skillMarkdown : "",
        serialize(workflow.steps),
        serialize(workflow.type === "tabular" ? workflow.columns : []),
        workflow.language,
        workflow.practice,
        serialize(workflow.jurisdictions),
        serialize(workflow.metadata),
        workflow.isBuiltin ? 1 : 0,
        now,
        workflow.id,
      );
    return this.require(workflow.id);
  }

  archive(id: string, now: string) {
    const workflow = this.require(id);
    return this.replace(
      { ...workflow, status: "archived", updatedAt: now },
      now,
    );
  }

  delete(id: string) {
    this.require(id);
    const referenced = Number(
      this.database
        .prepare(
          "SELECT count(*) AS count FROM workflow_runs WHERE workflow_id = ?",
        )
        .get(id)?.count ?? 0,
    );
    if (referenced > 0) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow runs must be retained; archive this workflow instead.",
      );
    }
    this.database.prepare("DELETE FROM workflows WHERE id = ?").run(id);
  }

  hide(workflowId: string, id: string, now: string) {
    this.require(workflowId);
    this.database
      .prepare(
        "INSERT OR IGNORE INTO hidden_workflows (id, workflow_id, created_at) VALUES (?, ?, ?)",
      )
      .run(id, workflowId, now);
  }

  unhide(workflowId: string) {
    this.require(workflowId);
    this.database
      .prepare("DELETE FROM hidden_workflows WHERE workflow_id = ?")
      .run(workflowId);
  }

  isHidden(workflowId: string) {
    return Boolean(
      this.database
        .prepare(
          "SELECT 1 AS present FROM hidden_workflows WHERE workflow_id = ?",
        )
        .get(workflowId),
    );
  }

  requireActiveProject(projectId: string) {
    const row = this.database
      .prepare(
        "SELECT status, default_model_profile_id FROM projects WHERE id = ?",
      )
      .get(projectId);
    if (!row)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Project not found.");
    if (row.status !== "active") {
      throw new WorkspaceApiError(409, "CONFLICT", "Project is not active.");
    }
    return {
      id: projectId,
      defaultModelProfileId:
        row.default_model_profile_id == null
          ? null
          : String(row.default_model_profile_id),
    };
  }

  requireEnabledModelProfile(modelProfileId: string) {
    const row = this.database
      .prepare("SELECT enabled FROM model_profiles WHERE id = ?")
      .get(modelProfileId);
    if (!row)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Model profile not found.");
    if (Number(row.enabled) !== 1) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Model profile is disabled.",
      );
    }
    return { id: modelProfileId };
  }

  workspaceDefaults() {
    const row = this.database
      .prepare(
        `SELECT default_project_id, default_model_profile_id
         FROM workspace_settings WHERE id = 'workspace'`,
      )
      .get();
    if (!row) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workspace settings are unavailable.",
      );
    }
    return {
      defaultProjectId:
        row.default_project_id == null ? null : String(row.default_project_id),
      defaultModelProfileId:
        row.default_model_profile_id == null
          ? null
          : String(row.default_model_profile_id),
    };
  }

  createRun(input: NewWorkflowRunRecord, enqueueJob: () => { id: string }) {
    return this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO workflow_runs
            (id, workflow_id, project_id, model_profile_id, retry_of_run_id,
             status, input_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(
          input.id,
          input.workflowId,
          input.projectId,
          input.modelProfileId,
          input.retryOfRunId,
          serialize(input.input),
          input.now,
          input.now,
        );
      const statement = this.database.prepare(
        `INSERT INTO workflow_step_runs
          (id, workflow_run_id, ordinal, attempt, step_json, status, input_json,
           output_json, error_json, error_code, started_at, completed_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const step of input.steps) {
        statement.run(
          step.id,
          input.id,
          step.ordinal,
          step.attempt,
          serialize(step.step),
          step.status,
          serialize(step.input),
          step.output == null ? null : serialize(step.output),
          step.error == null ? null : serialize(step.error),
          step.error?.code ?? null,
          step.startedAt,
          step.completedAt,
          input.now,
          input.now,
        );
      }
      const job = enqueueJob();
      if (job.id !== input.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Job enqueuer returned an unexpected id.",
        );
      }
      this.database
        .prepare(
          "UPDATE workflow_runs SET job_id = ?, updated_at = ? WHERE id = ?",
        )
        .run(input.jobId, input.now, input.id);
      return this.requireRunDetail(input.id);
    });
  }

  getRun(id: string): WorkflowRunRecord | null {
    const row = this.database
      .prepare("SELECT * FROM workflow_runs WHERE id = ?")
      .get(id);
    return row ? mapRun(row) : null;
  }

  requireRun(id: string) {
    const run = this.getRun(id);
    if (!run)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Workflow run not found.");
    return run;
  }

  getRunDetail(id: string): WorkflowRunDetail | null {
    const run = this.getRun(id);
    if (!run) return null;
    const steps = this.database
      .prepare(
        `SELECT * FROM workflow_step_runs
         WHERE workflow_run_id = ?
         ORDER BY ordinal ASC, attempt ASC`,
      )
      .all(id)
      .map(mapStepRun);
    return { run, steps };
  }

  requireRunDetail(id: string) {
    const detail = this.getRunDetail(id);
    if (!detail)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Workflow run not found.");
    return detail;
  }

  listRuns(workflowId: string, request: PageRequest = {}): Page<WorkflowRun> {
    this.require(workflowId);
    const page = normalizePageRequest(request);
    const cursor = decodeCursor(page.cursor);
    const parameters: unknown[] = [workflowId];
    const cursorSql = cursor
      ? "AND (created_at < ? OR (created_at = ? AND id < ?))"
      : "";
    if (cursor) parameters.push(cursor.createdAt, cursor.createdAt, cursor.id);
    parameters.push(page.limit + 1);
    const rows = this.database
      .prepare(
        `SELECT * FROM workflow_runs
         WHERE workflow_id = ? ${cursorSql}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...parameters);
    const items = rows.slice(0, page.limit).map(mapRun);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > page.limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  startStep(
    runId: string,
    ordinal: number,
    input: WorkspaceJson,
    now: string,
    startJob: () => { id: string },
  ) {
    return this.transaction(() => {
      const detail = this.requireRunDetail(runId);
      if (!["queued", "waiting", "running"].includes(detail.run.status)) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Workflow run is not executable.",
        );
      }
      const stepRow = this.database
        .prepare(
          `SELECT * FROM workflow_step_runs
           WHERE workflow_run_id = ? AND ordinal = ?
           ORDER BY attempt DESC LIMIT 1`,
        )
        .get(runId, ordinal);
      const step = stepRow ? mapStepRun(stepRow) : null;
      if (!step)
        throw new WorkspaceApiError(
          404,
          "NOT_FOUND",
          "Workflow step run not found.",
        );
      if (step.status !== "queued" && step.status !== "waiting") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Workflow step cannot be started.",
        );
      }
      const incompletePredecessors = Number(
        this.database
          .prepare(
            `SELECT count(*) AS count
             FROM workflow_step_runs current
             WHERE current.workflow_run_id = ? AND current.ordinal < ?
               AND current.attempt = (
                 SELECT max(latest.attempt) FROM workflow_step_runs latest
                 WHERE latest.workflow_run_id = current.workflow_run_id
                   AND latest.ordinal = current.ordinal
               )
               AND current.status NOT IN ('complete', 'skipped')`,
          )
          .get(runId, ordinal)?.count ?? 0,
      );
      if (incompletePredecessors > 0) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Workflow steps must start in ordinal order.",
        );
      }
      const job = startJob();
      if (job.id !== detail.run.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Workflow job state mismatch.",
        );
      }
      this.database
        .prepare(
          `UPDATE workflow_step_runs
           SET status = 'running', input_json = ?, started_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(serialize(input), now, now, step.id);
      this.database
        .prepare(
          `UPDATE workflow_runs
           SET status = 'running', started_at = coalesce(started_at, ?), updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, runId);
      return this.requireRunDetail(runId);
    });
  }

  completeStep(
    runId: string,
    ordinal: number,
    output: WorkspaceJson,
    now: string,
  ) {
    return this.transaction(() => {
      this.requireRunDetail(runId);
      const row = this.database
        .prepare(
          `SELECT * FROM workflow_step_runs
           WHERE workflow_run_id = ? AND ordinal = ?
           ORDER BY attempt DESC LIMIT 1`,
        )
        .get(runId, ordinal);
      const step = row ? mapStepRun(row) : null;
      if (!step || step.status !== "running") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Workflow step is not running.",
        );
      }
      this.database
        .prepare(
          `UPDATE workflow_step_runs
           SET status = 'complete', output_json = ?, error_json = NULL,
               error_code = NULL, completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(serialize(output), now, now, step.id);
      return this.requireRunDetail(runId);
    });
  }

  failStep(
    runId: string,
    ordinal: number,
    error: StructuredError,
    now: string,
    failJob: () => { id: string },
  ) {
    return this.transaction(() => {
      const detail = this.requireRunDetail(runId);
      const row = this.database
        .prepare(
          `SELECT * FROM workflow_step_runs
           WHERE workflow_run_id = ? AND ordinal = ?
           ORDER BY attempt DESC LIMIT 1`,
        )
        .get(runId, ordinal);
      const step = row ? mapStepRun(row) : null;
      if (!step || step.status !== "running") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Workflow step is not running.",
        );
      }
      const job = failJob();
      if (job.id !== detail.run.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Workflow job state mismatch.",
        );
      }
      this.database
        .prepare(
          `UPDATE workflow_step_runs
           SET status = 'failed', error_json = ?, error_code = ?,
               completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(serialize(error), error.code, now, now, step.id);
      this.database
        .prepare(
          `UPDATE workflow_step_runs
           SET status = 'skipped', completed_at = ?, updated_at = ?
           WHERE workflow_run_id = ? AND ordinal > ?
             AND status IN ('queued', 'waiting')`,
        )
        .run(now, now, runId, ordinal);
      this.database
        .prepare(
          `UPDATE workflow_runs
           SET status = 'failed', error_json = ?, error_code = ?,
               completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(serialize(error), error.code, now, now, runId);
      return this.requireRunDetail(runId);
    });
  }

  cancelRun(runId: string, now: string, cancelJob: () => { id: string }) {
    return this.transaction(() => {
      const run = this.requireRun(runId);
      if (!["queued", "waiting", "running"].includes(run.status)) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Workflow run cannot be cancelled.",
        );
      }
      const job = cancelJob();
      if (job.id !== run.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Workflow job state mismatch.",
        );
      }
      this.database
        .prepare(
          `UPDATE workflow_step_runs
           SET status = 'cancelled', completed_at = ?, updated_at = ?
           WHERE workflow_run_id = ? AND status IN ('queued', 'waiting', 'running')`,
        )
        .run(now, now, runId);
      this.database
        .prepare(
          `UPDATE workflow_runs
           SET status = 'cancelled', completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, now, runId);
      return this.requireRunDetail(runId);
    });
  }

  completeRun(
    runId: string,
    output: WorkspaceJson,
    now: string,
    completeJob: () => { id: string },
  ) {
    return this.transaction(() => {
      const run = this.requireRun(runId);
      if (!["queued", "waiting", "running"].includes(run.status)) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Workflow run cannot be completed.",
        );
      }
      const unfinished = Number(
        this.database
          .prepare(
            `SELECT count(*) AS count
             FROM workflow_step_runs current
             WHERE current.workflow_run_id = ?
               AND current.attempt = (
                 SELECT max(latest.attempt) FROM workflow_step_runs latest
                 WHERE latest.workflow_run_id = current.workflow_run_id
                   AND latest.ordinal = current.ordinal
               )
               AND current.status NOT IN ('complete', 'skipped')`,
          )
          .get(runId)?.count ?? 0,
      );
      if (unfinished > 0) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Workflow run still has unfinished steps.",
        );
      }
      const job = completeJob();
      if (job.id !== run.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Workflow job state mismatch.",
        );
      }
      this.database
        .prepare(
          `UPDATE workflow_runs
           SET status = 'complete', output_json = ?, error_json = NULL,
               error_code = NULL, completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(serialize(output), now, now, runId);
      return this.requireRunDetail(runId);
    });
  }

  failRun(
    runId: string,
    error: StructuredError,
    now: string,
    failJob: () => { id: string },
  ) {
    return this.transaction(() => {
      const run = this.requireRun(runId);
      if (!["queued", "waiting", "running"].includes(run.status)) {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Workflow run cannot fail.",
        );
      }
      const job = failJob();
      if (job.id !== run.jobId) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Workflow job state mismatch.",
        );
      }
      this.database
        .prepare(
          `UPDATE workflow_step_runs
           SET status = CASE WHEN status = 'running' THEN 'failed' ELSE 'skipped' END,
               error_json = CASE WHEN status = 'running' THEN ? ELSE error_json END,
               error_code = CASE WHEN status = 'running' THEN ? ELSE error_code END,
               completed_at = ?, updated_at = ?
           WHERE workflow_run_id = ? AND status IN ('queued', 'waiting', 'running')`,
        )
        .run(serialize(error), error.code, now, now, runId);
      this.database
        .prepare(
          `UPDATE workflow_runs
           SET status = 'failed', error_json = ?, error_code = ?,
               completed_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(serialize(error), error.code, now, now, runId);
      return this.requireRunDetail(runId);
    });
  }
}
