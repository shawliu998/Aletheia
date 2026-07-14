import { createHash, randomUUID } from "node:crypto";

import {
  CreateWorkflowRequestSchema,
  CreateWorkflowRunRequestSchema,
  SafeStructuredValueSchema,
  StructuredErrorSchema,
  UpdateWorkflowRequestSchema,
  WorkflowSchema,
} from "../contracts";
import { WorkspaceApiError } from "../errors";
import type { PageRequest } from "../pagination";
import {
  WorkflowsRepository,
  type NewWorkflowRunRecord,
  type WorkflowRunDetail,
} from "../repositories/workflows";
import type {
  JobStatus,
  StructuredError,
  Workflow,
  WorkflowColumn,
  WorkflowStep,
  WorkspaceJson,
} from "../types";

export const DEFAULT_WORKFLOW_MAX_STEPS = 25;
export const HARD_WORKFLOW_MAX_STEPS = 100;
export const DEFAULT_WORKFLOW_MAX_MODEL_CALLS = 20;
export const HARD_WORKFLOW_MAX_MODEL_CALLS = 100;
export const MAX_WORKFLOW_STEP_ATTEMPTS = 3;
const DEFAULT_WORKFLOW_LANGUAGE = "English";
const DEFAULT_WORKFLOW_PRACTICE = "General Transactions";
const DEFAULT_WORKFLOW_JURISDICTIONS = ["General"] as const;

export type JobResourceType =
  | "document"
  | "chat"
  | "workflow_run"
  | "tabular_cell"
  | "tabular_review"
  | "project";

export type EnqueueWorkspaceJobInput = {
  id: string;
  type: "workflow_run" | "tabular_cell";
  resourceType: JobResourceType;
  resourceId: string;
  idempotencyKey: string;
  payload: WorkspaceJson;
  maxAttempts: number;
  now: string;
};

export type WorkspaceJobSnapshot = {
  id: string;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
};

export type WorkspaceJobPortEvent =
  | { type: "start"; at: string }
  | { type: "complete"; at: string; result: WorkspaceJson }
  | { type: "fail"; at: string; error: StructuredError }
  | { type: "cancel"; at: string; reason: string };

/**
 * Minimal same-adapter job port. These mutation methods MUST NOT open their own
 * transaction: callers invoke them inside a repository-owned transaction.
 */
export interface JobEnqueuer {
  enqueueInCurrentTransaction(
    input: EnqueueWorkspaceJobInput,
  ): WorkspaceJobSnapshot;
  get(id: string): WorkspaceJobSnapshot | null;
  transitionInCurrentTransaction(
    id: string,
    event: WorkspaceJobPortEvent,
  ): WorkspaceJobSnapshot;
}

export type WorkflowExecutionLimits = {
  maxSteps?: number;
  maxModelCalls?: number;
};

const sensitiveToken =
  /(?:bearer\s+)[a-z0-9._~+\/-]+|\b(?:sk|key)-[a-z0-9_-]{8,}\b/gi;
const localPath = /(?:\/[Uu]sers\/|\/home\/|[A-Za-z]:\\)[^\s"']+/g;

function redactText(value: string) {
  return value
    .replace(sensitiveToken, "[redacted]")
    .replace(localPath, "[redacted-path]");
}

function sanitizeJson(value: unknown): WorkspaceJson {
  const parsed = SafeStructuredValueSchema.parse(value);
  const walk = (item: WorkspaceJson): WorkspaceJson => {
    if (typeof item === "string") return redactText(item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [key, walk(child)]),
      );
    }
    return item;
  };
  return walk(parsed);
}

function sanitizeError(value: unknown): StructuredError {
  const parsed = StructuredErrorSchema.parse(value);
  return StructuredErrorSchema.parse({
    ...parsed,
    message: redactText(parsed.message),
    details:
      parsed.details == null
        ? null
        : Object.fromEntries(
            Object.entries(parsed.details).map(([key, item]) => [
              key,
              typeof item === "string" ? redactText(item) : item,
            ]),
          ),
  });
}

function requirePositiveLimit(
  value: number | undefined,
  fallback: number,
  hardLimit: number,
  label: string,
) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1 || resolved > hardLimit) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      `${label} must be an integer between 1 and ${hardLimit}.`,
    );
  }
  return resolved;
}

function assertStepSemantics(type: Workflow["type"], steps: WorkflowStep[]) {
  if (steps.length > HARD_WORKFLOW_MAX_STEPS) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "A workflow cannot exceed 100 steps.",
    );
  }
  if (
    type === "assistant" &&
    steps.some((step) => step.kind === "tabular_column")
  ) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Assistant workflows cannot contain tabular-column steps.",
    );
  }
}

function modelCallCount(workflow: Workflow) {
  const stepCalls = workflow.steps.filter(
    (step) => step.kind === "prompt" || step.kind === "tabular_column",
  ).length;
  if (workflow.type === "assistant") return Math.max(1, stepCalls);
  return workflow.columns.length + stepCalls;
}

function assertExecutableWorkflow(workflow: Workflow) {
  const executable =
    workflow.type === "assistant"
      ? workflow.skillMarkdown.trim().length > 0 || workflow.steps.length > 0
      : workflow.columns.length > 0 || workflow.steps.length > 0;
  if (!executable) {
    throw new WorkspaceApiError(
      412,
      "PRECONDITION_FAILED",
      "Workflow draft has no executable skill, columns, or steps.",
    );
  }
}

function workflowConfigHash(workflow: Workflow) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: workflow.id,
        type: workflow.type,
        projectId: workflow.projectId,
        updatedAt: workflow.updatedAt,
        language: workflow.language,
        practice: workflow.practice,
        jurisdictions: workflow.jurisdictions,
        metadata: workflow.metadata,
        skillMarkdown:
          workflow.type === "assistant" ? workflow.skillMarkdown : null,
        steps: workflow.steps,
        columns: workflow.type === "tabular" ? workflow.columns : null,
      }),
    )
    .digest("hex");
}

export class WorkflowsService {
  constructor(
    private readonly repository: WorkflowsRepository,
    private readonly jobs: JobEnqueuer,
    private readonly clock: () => Date = () => new Date(),
    private readonly idFactory: () => string = randomUUID,
  ) {}

  private now() {
    return this.clock().toISOString();
  }

  list(
    request: PageRequest & {
      type?: Workflow["type"];
      projectId?: string | null;
      includeArchived?: boolean;
      includeHidden?: boolean;
    } = {},
  ) {
    return this.repository.list(request);
  }

  get(id: string) {
    return this.repository.require(id);
  }

  create(value: unknown) {
    const input = CreateWorkflowRequestSchema.parse(value);
    assertStepSemantics(input.type, input.steps);
    if (input.projectId) this.repository.requireActiveProject(input.projectId);
    const now = this.now();
    const id = this.idFactory();
    const columns: WorkflowColumn[] =
      input.type === "tabular"
        ? input.columns.map((column, ordinal) => ({
            id: this.idFactory(),
            workflowId: id,
            key: column.key,
            title: column.title,
            outputType: column.outputType,
            prompt: column.prompt,
            enumValues: column.enumValues ?? null,
            ordinal,
          }))
        : [];
    return this.repository.create({
      id,
      type: input.type,
      projectId: input.projectId ?? null,
      title: input.title,
      description: input.description ?? null,
      skillMarkdown: input.type === "assistant" ? input.skillMarkdown : "",
      steps: input.steps,
      columns,
      language: input.language ?? DEFAULT_WORKFLOW_LANGUAGE,
      practice: input.practice ?? DEFAULT_WORKFLOW_PRACTICE,
      jurisdictions: input.jurisdictions ?? [...DEFAULT_WORKFLOW_JURISDICTIONS],
      metadata: input.metadata ?? {},
      isBuiltin: false,
      now,
    });
  }

  update(id: string, value: unknown) {
    const input = UpdateWorkflowRequestSchema.parse(value);
    const existing = this.repository.require(id);
    if (existing.type === "assistant" && input.columns !== undefined) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Assistant workflows do not define tabular columns.",
      );
    }
    if (existing.type === "tabular" && input.skillMarkdown !== undefined) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Tabular workflows do not define assistant skill markdown.",
      );
    }
    const steps = input.steps ?? existing.steps;
    assertStepSemantics(existing.type, steps);
    const projectId =
      input.projectId === undefined ? existing.projectId : input.projectId;
    if (projectId) this.repository.requireActiveProject(projectId);
    const now = this.now();
    let candidate: Workflow;
    if (existing.type === "assistant") {
      candidate = {
        ...existing,
        projectId,
        title: input.title ?? existing.title,
        description:
          input.description === undefined
            ? existing.description
            : input.description,
        status: input.status ?? existing.status,
        skillMarkdown: input.skillMarkdown ?? existing.skillMarkdown,
        steps,
        language: input.language ?? existing.language,
        practice: input.practice ?? existing.practice,
        jurisdictions: input.jurisdictions ?? existing.jurisdictions,
        metadata: input.metadata ?? existing.metadata,
        updatedAt: now,
      };
    } else {
      const existingIds = new Map(
        existing.columns.map((column) => [column.key, column.id]),
      );
      const columns = input.columns
        ? input.columns.map((column, ordinal) => ({
            id: existingIds.get(column.key) ?? this.idFactory(),
            workflowId: existing.id,
            key: column.key,
            title: column.title,
            outputType: column.outputType,
            prompt: column.prompt,
            enumValues: column.enumValues ?? null,
            ordinal,
          }))
        : existing.columns;
      candidate = {
        ...existing,
        projectId,
        title: input.title ?? existing.title,
        description:
          input.description === undefined
            ? existing.description
            : input.description,
        status: input.status ?? existing.status,
        columns,
        steps,
        language: input.language ?? existing.language,
        practice: input.practice ?? existing.practice,
        jurisdictions: input.jurisdictions ?? existing.jurisdictions,
        metadata: input.metadata ?? existing.metadata,
        updatedAt: now,
      };
    }
    return this.repository.replace(WorkflowSchema.parse(candidate), now);
  }

  archive(id: string) {
    return this.repository.archive(id, this.now());
  }

  delete(id: string) {
    this.repository.delete(id);
  }

  hide(id: string) {
    this.repository.hide(id, this.idFactory(), this.now());
  }

  unhide(id: string) {
    this.repository.unhide(id);
  }

  isHidden(id: string) {
    this.repository.require(id);
    return this.repository.isHidden(id);
  }

  listRuns(workflowId: string, request: PageRequest = {}) {
    return this.repository.listRuns(workflowId, request);
  }

  getRun(id: string) {
    return this.repository.requireRunDetail(id);
  }

  startRun(
    workflowId: string,
    value: unknown,
    limits: WorkflowExecutionLimits = {},
  ) {
    const request = CreateWorkflowRunRequestSchema.parse(value);
    const workflow = this.repository.require(workflowId);
    if (workflow.status !== "active") {
      throw new WorkspaceApiError(409, "CONFLICT", "Workflow is not active.");
    }
    assertExecutableWorkflow(workflow);
    const defaults = this.repository.workspaceDefaults();
    if (
      workflow.projectId !== null &&
      request.projectId !== undefined &&
      request.projectId !== workflow.projectId
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "A project-bound workflow must run in its bound project.",
      );
    }
    const projectId =
      workflow.projectId ??
      (request.projectId !== undefined
        ? request.projectId
        : defaults.defaultProjectId);
    const project = projectId
      ? this.repository.requireActiveProject(projectId)
      : null;
    const modelProfileId =
      request.modelProfileId ??
      project?.defaultModelProfileId ??
      defaults.defaultModelProfileId;
    if (!modelProfileId) {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        "Configure an enabled project or workspace default model profile before running a workflow.",
      );
    }
    this.repository.requireEnabledModelProfile(modelProfileId);
    const maxSteps = requirePositiveLimit(
      limits.maxSteps,
      DEFAULT_WORKFLOW_MAX_STEPS,
      HARD_WORKFLOW_MAX_STEPS,
      "maxSteps",
    );
    const maxModelCalls = requirePositiveLimit(
      limits.maxModelCalls,
      DEFAULT_WORKFLOW_MAX_MODEL_CALLS,
      HARD_WORKFLOW_MAX_MODEL_CALLS,
      "maxModelCalls",
    );
    if (workflow.steps.length > maxSteps) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        `Workflow has ${workflow.steps.length} steps but maxSteps is ${maxSteps}.`,
      );
    }
    const requiredCalls = modelCallCount(workflow);
    if (requiredCalls > maxModelCalls) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        `Workflow requires up to ${requiredCalls} model calls but maxModelCalls is ${maxModelCalls}.`,
      );
    }
    const now = this.now();
    return this.persistRun({
      workflow,
      projectId,
      modelProfileId,
      maxSteps,
      maxModelCalls,
      now,
      retryOfRunId: null,
      workflowConfigSha256: workflowConfigHash(workflow),
      steps: workflow.steps.map((step, ordinal) => ({
        step,
        ordinal,
        attempt: 1,
        status: "queued" as const,
        input: {} as WorkspaceJson,
        output: null,
        error: null,
        startedAt: null,
        completedAt: null,
      })),
    });
  }

  private persistRun(input: {
    workflow: Workflow;
    projectId: string | null;
    modelProfileId: string;
    maxSteps: number;
    maxModelCalls: number;
    now: string;
    retryOfRunId: string | null;
    workflowConfigSha256: string;
    steps: Array<Omit<NewWorkflowRunRecord["steps"][number], "id">>;
  }) {
    const runId = this.idFactory();
    const jobId = this.idFactory();
    const runInput = sanitizeJson({
      schemaVersion: 1,
      execution: {
        maxSteps: input.maxSteps,
        maxModelCalls: input.maxModelCalls,
        workflowConfigSha256: input.workflowConfigSha256,
      },
      retryAttempt:
        input.retryOfRunId === null
          ? 1
          : Math.max(...input.steps.map((step) => step.attempt), 1),
    });
    const record: NewWorkflowRunRecord = {
      id: runId,
      workflowId: input.workflow.id,
      projectId: input.projectId,
      modelProfileId: input.modelProfileId,
      jobId,
      retryOfRunId: input.retryOfRunId,
      input: runInput,
      steps: input.steps.map((step) => ({ ...step, id: this.idFactory() })),
      now: input.now,
    };
    const payload = sanitizeJson({
      runId,
      workflowId: input.workflow.id,
      projectId: input.projectId,
      modelProfileId: input.modelProfileId,
      execution: (runInput as { execution: WorkspaceJson }).execution,
      retryOfRunId: input.retryOfRunId,
    });
    return this.repository.createRun(record, () =>
      this.jobs.enqueueInCurrentTransaction({
        id: jobId,
        type: "workflow_run",
        resourceType: "workflow_run",
        resourceId: runId,
        idempotencyKey: `workflow_run:v1:${runId}`,
        payload,
        maxAttempts: 1,
        now: input.now,
      }),
    );
  }

  startStep(runId: string, ordinal: number, input: unknown = {}) {
    const detail = this.repository.requireRunDetail(runId);
    if (!detail.run.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow run job is unavailable.",
      );
    }
    const now = this.now();
    return this.repository.startStep(
      runId,
      ordinal,
      sanitizeJson(input),
      now,
      () => {
        const job = this.jobs.get(detail.run.jobId!);
        if (!job)
          throw new WorkspaceApiError(
            500,
            "INTERNAL_ERROR",
            "Workflow job not found.",
          );
        const runningJob =
          job.status === "queued"
            ? this.jobs.transitionInCurrentTransaction(detail.run.jobId!, {
                type: "start",
                at: now,
              })
            : job;
        if (runningJob.status !== "running") {
          throw new WorkspaceApiError(
            409,
            "CONFLICT",
            "Workflow job did not enter running state.",
          );
        }
        return runningJob;
      },
    );
  }

  completeStep(runId: string, ordinal: number, output: unknown) {
    return this.repository.completeStep(
      runId,
      ordinal,
      sanitizeJson(output),
      this.now(),
    );
  }

  failStep(runId: string, ordinal: number, error: unknown) {
    const detail = this.repository.requireRunDetail(runId);
    if (!detail.run.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow run job is unavailable.",
      );
    }
    const safeError = sanitizeError(error);
    const now = this.now();
    return this.repository.failStep(runId, ordinal, safeError, now, () =>
      this.jobs.transitionInCurrentTransaction(detail.run.jobId!, {
        type: "fail",
        at: now,
        error: safeError,
      }),
    );
  }

  retryFailedStep(runId: string, ordinal: number) {
    const parent = this.repository.requireRunDetail(runId);
    if (parent.run.status !== "failed") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Only failed workflow runs can be retried.",
      );
    }
    const failed = parent.steps.find((step) => step.ordinal === ordinal);
    if (!failed || failed.status !== "failed" || !failed.error?.retryable) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "The selected workflow step is not retryable.",
      );
    }
    if (failed.attempt >= MAX_WORKFLOW_STEP_ATTEMPTS) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow step retry limit reached.",
      );
    }
    const workflow = this.repository.require(parent.run.workflowId);
    if (workflow.status !== "active") {
      throw new WorkspaceApiError(409, "CONFLICT", "Workflow is not active.");
    }
    const defaults = this.repository.workspaceDefaults();
    const projectId = parent.run.projectId;
    const project = projectId
      ? this.repository.requireActiveProject(projectId)
      : null;
    const modelProfileId =
      parent.run.modelProfileId ??
      project?.defaultModelProfileId ??
      defaults.defaultModelProfileId;
    if (!modelProfileId) {
      throw new WorkspaceApiError(
        412,
        "PRECONDITION_FAILED",
        "Retry model profile is unavailable.",
      );
    }
    this.repository.requireEnabledModelProfile(modelProfileId);
    const execution =
      parent.run.input &&
      typeof parent.run.input === "object" &&
      !Array.isArray(parent.run.input) &&
      parent.run.input.execution &&
      typeof parent.run.input.execution === "object" &&
      !Array.isArray(parent.run.input.execution)
        ? parent.run.input.execution
        : null;
    const maxSteps = requirePositiveLimit(
      typeof execution?.maxSteps === "number" ? execution.maxSteps : undefined,
      DEFAULT_WORKFLOW_MAX_STEPS,
      HARD_WORKFLOW_MAX_STEPS,
      "maxSteps",
    );
    const maxModelCalls = requirePositiveLimit(
      typeof execution?.maxModelCalls === "number"
        ? execution.maxModelCalls
        : undefined,
      DEFAULT_WORKFLOW_MAX_MODEL_CALLS,
      HARD_WORKFLOW_MAX_MODEL_CALLS,
      "maxModelCalls",
    );
    const workflowConfigSha256 =
      typeof execution?.workflowConfigSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(execution.workflowConfigSha256)
        ? execution.workflowConfigSha256
        : null;
    if (!workflowConfigSha256) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Parent workflow run has no valid configuration snapshot hash.",
      );
    }
    const now = this.now();
    return this.persistRun({
      workflow,
      projectId,
      modelProfileId,
      maxSteps,
      maxModelCalls,
      now,
      retryOfRunId: parent.run.id,
      workflowConfigSha256,
      steps: parent.steps.map((step) => ({
        step: step.step,
        ordinal: step.ordinal,
        attempt: step.ordinal === ordinal ? step.attempt + 1 : step.attempt,
        status:
          step.ordinal < ordinal ? ("skipped" as const) : ("queued" as const),
        input: step.ordinal < ordinal ? step.input : {},
        output: step.ordinal < ordinal ? step.output : null,
        error: null,
        startedAt: step.ordinal < ordinal ? step.startedAt : null,
        completedAt: step.ordinal < ordinal ? now : null,
      })),
    });
  }

  cancelRun(runId: string) {
    const detail = this.repository.requireRunDetail(runId);
    if (!detail.run.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow run job is unavailable.",
      );
    }
    const job = this.jobs.get(detail.run.jobId);
    if (!job)
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow job not found.",
      );
    if (job.status !== "queued" && job.status !== "running") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow job is already terminal.",
      );
    }
    const now = this.now();
    return this.repository.cancelRun(runId, now, () =>
      this.jobs.transitionInCurrentTransaction(job.id, {
        type: "cancel",
        at: now,
        reason: "Workflow run cancelled by user.",
      }),
    );
  }

  completeRun(runId: string, output: unknown) {
    const detail = this.repository.requireRunDetail(runId);
    if (!detail.run.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow run job is unavailable.",
      );
    }
    const safeOutput = sanitizeJson(output);
    const now = this.now();
    return this.repository.completeRun(runId, safeOutput, now, () =>
      this.jobs.transitionInCurrentTransaction(detail.run.jobId!, {
        type: "complete",
        at: now,
        result: safeOutput,
      }),
    );
  }

  failRun(runId: string, error: unknown) {
    const detail = this.repository.requireRunDetail(runId);
    if (!detail.run.jobId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow run job is unavailable.",
      );
    }
    const job = this.jobs.get(detail.run.jobId);
    if (!job) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Workflow job not found.",
      );
    }
    const safeError = sanitizeError(error);
    const now = this.now();
    return this.repository.failRun(runId, safeError, now, () => {
      const runningJob =
        job.status === "queued"
          ? this.jobs.transitionInCurrentTransaction(job.id, {
              type: "start",
              at: now,
            })
          : job;
      if (runningJob.status !== "running") {
        throw new WorkspaceApiError(
          409,
          "CONFLICT",
          "Workflow job cannot transition to failed.",
        );
      }
      return this.jobs.transitionInCurrentTransaction(job.id, {
        type: "fail",
        at: now,
        error: safeError,
      });
    });
  }
}
