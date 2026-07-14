import type { HandlerSignalContext } from "./jobs";
import {
  WorkspaceJobLeaseLostError,
  type WorkspaceJobsRepository,
} from "../repositories/jobs";
import { WorkspaceApiError } from "../errors";
import type { StructuredError, WorkflowStep, WorkspaceJson } from "../types";
import type { WorkflowExecutionSnapshot } from "../repositories/workflows";
import { type WorkflowClaimCallbacks, WorkflowsService } from "./workflows";

/**
 * Fixed Mike e32daad semantics treat workflows as Assistant-consumed
 * skill_md/columns_config metadata. Vera P1 does not ship a Mike-compatible
 * workflow planner, so this capability is deliberately not mountable.
 */
export const WORKSPACE_WORKFLOW_EXECUTION_CAPABILITY = Object.freeze({
  enabled: false as const,
  reason:
    "Mike workflow execution is Assistant-owned; Vera P1 has no compatible planner.",
});

export function workflowExecutionUnsupportedError(): WorkspaceApiError {
  return new WorkspaceApiError(
    501,
    "PRECONDITION_FAILED",
    `Workflow execution is unsupported (capability=false). ${WORKSPACE_WORKFLOW_EXECUTION_CAPABILITY.reason}`,
    [{ path: "capability", message: "false" }],
  );
}

/**
 * The Jobs repository owns lease predicates and final state transitions.  This
 * port is the shared repository's public same-transaction claim API.  There
 * is deliberately no cancellation extension: Jobs control-plane/recovery owns
 * cancellation and ordinary fenced finish correctly rejects cancelled claims.
 */
export type FencedWorkflowJobsPort = Pick<
  WorkspaceJobsRepository,
  "assertClaimInCurrentTransaction" | "finishClaimInCurrentTransaction"
>;

export type WorkflowStepExecutionResult =
  | { status: "complete"; output: WorkspaceJson }
  | { status: "unsupported"; message: string };

export interface WorkflowStepExecutor {
  executeStep(input: {
    snapshot: WorkflowExecutionSnapshot;
    step: WorkflowStep;
    ordinal: number;
    signal: AbortSignal;
  }): Promise<WorkflowStepExecutionResult> | WorkflowStepExecutionResult;
}

export class UnsupportedWorkflowStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedWorkflowStepError";
  }
}

function toStructuredError(error: unknown): StructuredError {
  if (error instanceof UnsupportedWorkflowStepError) {
    return {
      code: "workflow_step_unsupported",
      message: error.message,
      retryable: false,
      details: null,
    };
  }
  if (error instanceof WorkspaceApiError) {
    return {
      code: error.code.toLowerCase(),
      message: error.message,
      retryable: error.status >= 500,
      details: null,
    };
  }
  return {
    code: "workflow_execution_failed",
    message:
      error instanceof Error && error.message.trim()
        ? error.message
        : "Workflow execution failed.",
    retryable: true,
    details: null,
  };
}

type WorkflowRunJobPayload = {
  runId: string;
  workflowId: string;
  snapshotId: string;
  snapshotSha256: string;
  retryOfRunId: string | null;
};

function workflowPayloadFromJob(
  payload: unknown,
): WorkflowRunJobPayload | null {
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const value = payload as Record<string, unknown>;
  const runId = value.runId;
  const workflowId = value.workflowId;
  const snapshotId = value.snapshotId;
  const snapshotSha256 = value.snapshotSha256;
  const retryOfRunId = value.retryOfRunId;
  if (
    typeof runId !== "string" ||
    !runId.trim() ||
    typeof workflowId !== "string" ||
    !workflowId.trim() ||
    typeof snapshotId !== "string" ||
    !snapshotId.trim() ||
    typeof snapshotSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(snapshotSha256) ||
    (retryOfRunId !== null &&
      (typeof retryOfRunId !== "string" || !retryOfRunId.trim()))
  ) {
    return null;
  }
  return { runId, workflowId, snapshotId, snapshotSha256, retryOfRunId };
}

function throwAbortError(): never {
  const error = new Error("Workflow execution aborted.");
  error.name = "AbortError";
  throw error;
}

/**
 * Quarantined generic runtime adapter. It is intentionally disabled for Vera
 * P1: production composition must not register it with the Jobs pump because
 * Mike's workflow execution is owned by Assistant tooling, not generic steps.
 */
export class WorkspaceWorkflowRuntime {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly jobs: FencedWorkflowJobsPort,
    private readonly executor: WorkflowStepExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private claimCallbacks(
    context: HandlerSignalContext,
    runId: string,
  ): WorkflowClaimCallbacks {
    if (!context.claim) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow execution requires a fenced job claim.",
      );
    }
    const base = {
      id: context.job.id,
      type: "workflow_run" as const,
      resourceType: "workflow_run" as const,
      resourceId: runId,
      leaseOwner: context.claim.leaseOwner,
      attempt: context.claim.attempt,
      payload: context.job.payload,
    };
    const at = () => this.now().toISOString();
    return {
      assert: () =>
        this.jobs.assertClaimInCurrentTransaction({ ...base, at: at() }),
      finishComplete: (result) =>
        this.jobs.finishClaimInCurrentTransaction({
          ...base,
          event: { type: "complete", at: at(), result },
        }),
      finishFailure: (error) =>
        this.jobs.finishClaimInCurrentTransaction({
          ...base,
          event: { type: "fail", at: at(), error },
        }),
    };
  }

  async handle(context: HandlerSignalContext): Promise<void> {
    if (
      context.job.type !== "workflow_run" ||
      context.job.resourceType !== "workflow_run"
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow runtime received a non-workflow job.",
      );
    }
    const payload = workflowPayloadFromJob(context.job.payload);
    if (!payload || payload.runId !== context.job.resourceId) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow job payload does not match its resource identity.",
      );
    }
    const callbacks = this.claimCallbacks(context, payload.runId);
    const snapshot = this.workflows.getExecutionSnapshot(payload.runId);
    const detail = this.workflows.getRun(payload.runId);
    if (
      snapshot.workflowRunId !== payload.runId ||
      snapshot.id !== payload.snapshotId ||
      snapshot.snapshotSha256 !== payload.snapshotSha256 ||
      snapshot.workflowId !== payload.workflowId ||
      snapshot.workflowId !== detail.run.workflowId ||
      detail.run.retryOfRunId !== payload.retryOfRunId
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workflow job payload does not match its immutable execution snapshot.",
      );
    }
    try {
      if (snapshot.steps.length === 0) {
        // Mike's skill_md and columns_config require a real planner/executor.
        // This adapter only runs explicit domain steps, so completing a zero
        // step snapshot would fabricate work.  Fail closed until composition
        // supplies that Mike execution port.
        throw new UnsupportedWorkflowStepError(
          "Workflow requires a Mike skill or tabular execution planner; no executable steps are available.",
        );
      }
      for (const [ordinal, step] of snapshot.steps.entries()) {
        if (context.signal.aborted) {
          throwAbortError();
        }
        const current = this.workflows.getRun(payload.runId);
        const attempts = current.steps.filter(
          (candidate) => candidate.ordinal === ordinal,
        );
        const latest = attempts.at(-1);
        if (!latest) {
          throw new WorkspaceApiError(
            500,
            "INTERNAL_ERROR",
            "Workflow snapshot and step-run records do not match.",
          );
        }
        if (latest.status === "complete" || latest.status === "skipped")
          continue;
        this.workflows.startClaimedStep(payload.runId, ordinal, {}, callbacks);
        const result = await this.executor.executeStep({
          snapshot,
          step,
          ordinal,
          signal: context.signal,
        });
        if (result.status === "unsupported") {
          throw new UnsupportedWorkflowStepError(result.message);
        }
        if (context.signal.aborted) throwAbortError();
        this.workflows.completeClaimedStep(
          payload.runId,
          ordinal,
          result.output,
          callbacks,
        );
      }
      this.workflows.completeClaimedRun(
        payload.runId,
        { executedStepCount: snapshot.steps.length },
        callbacks,
      );
    } catch (error) {
      if (error instanceof WorkspaceJobLeaseLostError) throw error;
      if (context.signal.aborted) throwAbortError();
      this.workflows.failClaimedRun(
        payload.runId,
        toStructuredError(error),
        callbacks,
      );
    }
  }
}
