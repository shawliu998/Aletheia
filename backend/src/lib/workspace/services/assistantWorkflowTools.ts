import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { SafeStructuredValueSchema, WorkspaceIdSchema } from "../contracts";
import { assertMikeSafePayload } from "../mikeCompatibility";
import type { Page, PageRequest } from "../pagination";
import type {
  PreparedWorkflowRun,
  WorkflowRunDetail,
} from "../repositories/workflows";
import type { Workflow, WorkspaceJson } from "../types";
import type {
  AssistantModelToolCall,
  AssistantToolContext,
  AssistantToolDefinition,
} from "./assistantRuntime";
import type { AssistantToolModule } from "./assistantToolRegistry";
import type { WorkspaceAssistantActionLedger } from "./assistantActionLedger";
import {
  DEFAULT_WORKFLOW_MAX_MODEL_CALLS,
  DEFAULT_WORKFLOW_MAX_STEPS,
  type WorkflowExecutionLimits,
} from "./workflows";

export const ASSISTANT_WORKFLOW_TOOL_MODULE_ID = "workspace-workflow-tools";
export const ASSISTANT_WORKFLOW_TOOL_ADAPTER_ID =
  "vera-local-workflow-tools-v1";

const MAX_LIST_RESULTS = 100;
const MAX_LIST_SCAN_PAGES = 20;
const LIST_SCAN_PAGE_SIZE = 100;
const MAX_RUNS_PER_GENERATION = 2;
const MAX_RUN_POLLS_PER_GENERATION = 8;
const MAX_TRACKED_GENERATIONS = 256;
const MAX_RUN_INPUT_JSON_CHARS = 50_000;
const MAX_READ_INSTRUCTION_CHARS = 100_000;
const MAX_COMPLETED_OUTPUT_JSON_CHARS = 100_000;
const MAX_OUTPUT_PREVIEW_CHARS = 20_000;
const MAX_TOOL_RESULT_CHARS = 160_000;

const EmptyInput = z.object({}).strict();
const WorkflowIdInput = z.object({ workflow_id: WorkspaceIdSchema }).strict();
const RunWorkflowInput = z
  .object({
    workflow_id: WorkspaceIdSchema,
    input_binding: z.record(SafeStructuredValueSchema).default({}),
  })
  .strict()
  .superRefine((value, context) => {
    if (JSON.stringify(value.input_binding).length > MAX_RUN_INPUT_JSON_CHARS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["input_binding"],
        message: "Workflow input exceeds the safe Assistant tool budget.",
      });
    }
  });
const GetWorkflowRunInput = z.object({ run_id: WorkspaceIdSchema }).strict();

const LIST_WORKFLOWS_TOOL: AssistantToolDefinition = Object.freeze({
  name: "list_workflows",
  description:
    "List active Assistant workflows available to this Matter: workflows owned by the Matter and explicit workspace-global templates. Archived, tabular, hidden, and other-Matter workflows are excluded.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
});

const READ_WORKFLOW_TOOL: AssistantToolDefinition = Object.freeze({
  name: "read_workflow",
  description:
    "Read the bounded, current definition of one active Assistant workflow available to this Matter. This does not run the workflow.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      workflow_id: Object.freeze({ type: "string", format: "uuid" }),
    }),
    required: Object.freeze(["workflow_id"]),
    additionalProperties: false,
  }),
});

const RUN_WORKFLOW_TOOL: AssistantToolDefinition = Object.freeze({
  name: "run_workflow",
  description:
    "Queue one active Assistant workflow available to this Matter. Returns a durable run id immediately; use get_workflow_run in a later tool round instead of waiting in this call.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      workflow_id: Object.freeze({ type: "string", format: "uuid" }),
      input_binding: Object.freeze({
        type: "object",
        description:
          "Optional bounded JSON values exposed to the immutable workflow execution snapshot.",
        default: Object.freeze({}),
        additionalProperties: true,
      }),
    }),
    required: Object.freeze(["workflow_id"]),
    additionalProperties: false,
  }),
});

const GET_WORKFLOW_RUN_TOOL: AssistantToolDefinition = Object.freeze({
  name: "get_workflow_run",
  description:
    "Read bounded status, step progress, and completed output for a durable workflow run in this Matter. Poll sparingly; at most eight status reads are allowed in one Assistant response.",
  inputSchema: Object.freeze({
    type: "object",
    properties: Object.freeze({
      run_id: Object.freeze({ type: "string", format: "uuid" }),
    }),
    required: Object.freeze(["run_id"]),
    additionalProperties: false,
  }),
});

const WORKFLOW_TOOLS = Object.freeze([
  LIST_WORKFLOWS_TOOL,
  READ_WORKFLOW_TOOL,
  RUN_WORKFLOW_TOOL,
  GET_WORKFLOW_RUN_TOOL,
]);

export interface AssistantWorkflowToolsServicePort {
  list(
    request?: PageRequest & {
      type?: Workflow["type"];
      projectId?: string | null;
      includeArchived?: boolean;
      includeHidden?: boolean;
    },
  ): Page<Workflow>;
  get(id: string): Workflow;
  isHidden(id: string): boolean;
  prepareRun(
    workflowId: string,
    value: unknown,
    limits?: WorkflowExecutionLimits,
  ): PreparedWorkflowRun;
  getRun(id: string): WorkflowRunDetail;
}

type GenerationState = {
  context: AssistantToolContext;
  runCount: number;
  pollCount: number;
};

export class AssistantWorkflowToolError extends Error {
  readonly code = "assistant_tool_failed";
  readonly retryable = false;
  readonly details = null;

  constructor(message = "Assistant workflow tool rejected the operation.") {
    super(message);
    this.name = "AssistantWorkflowToolError";
  }
}

function generationKey(context: AssistantToolContext) {
  return `${context.jobId}\0${context.attempt}`;
}

function abortError() {
  const error = new Error("Assistant workflow operation was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortError();
}

function toolInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AssistantWorkflowToolError();
  return parsed.data;
}

function assertAvailableWorkflow(
  workflow: Workflow,
  projectId: string,
  hidden: boolean,
): Extract<Workflow, { type: "assistant" }> {
  if (
    hidden ||
    workflow.type !== "assistant" ||
    workflow.status !== "active" ||
    (workflow.projectId !== null && workflow.projectId !== projectId)
  ) {
    // Deliberately collapse state, type, and ownership failures so an Agent
    // cannot probe another Matter's workflow metadata by identifier.
    throw new AssistantWorkflowToolError(
      "Workflow is not available to this Matter.",
    );
  }
  return workflow;
}

function boundedText(value: string, remaining: number) {
  if (remaining <= 0) return { text: "", truncated: value.length > 0, used: 0 };
  const text = value.slice(0, remaining);
  return {
    text,
    truncated: text.length !== value.length,
    used: text.length,
  };
}

function workflowSummary(
  workflow: Extract<Workflow, { type: "assistant" }>,
  projectId: string,
) {
  return {
    workflow_id: workflow.id,
    name: workflow.title,
    description: workflow.description,
    scope: workflow.projectId === projectId ? "matter" : "global_template",
    status: workflow.status,
    is_builtin: workflow.isBuiltin,
    step_count:
      workflow.steps.length > 0
        ? workflow.steps.length
        : workflow.skillMarkdown.trim().length > 0
          ? 1
          : 0,
    model_call_count:
      workflow.steps.length > 0
        ? workflow.steps.filter((step) => step.kind === "prompt").length
        : workflow.skillMarkdown.trim().length > 0
          ? 1
          : 0,
    updated_at: workflow.updatedAt,
  };
}

function workflowDefinition(
  workflow: Extract<Workflow, { type: "assistant" }>,
  projectId: string,
) {
  let remaining = MAX_READ_INSTRUCTION_CHARS;
  let truncated = false;
  const skill = boundedText(workflow.skillMarkdown, remaining);
  remaining -= skill.used;
  truncated ||= skill.truncated;
  const steps = workflow.steps.map((step, ordinal) => {
    if (step.kind === "prompt") {
      const prompt = boundedText(step.prompt, remaining);
      remaining -= prompt.used;
      truncated ||= prompt.truncated;
      return {
        ordinal,
        kind: step.kind,
        title: step.title,
        prompt: prompt.text,
        prompt_truncated: prompt.truncated,
      };
    }
    if (step.kind === "document_context") {
      const query = boundedText(step.queryTemplate ?? step.title, remaining);
      remaining -= query.used;
      truncated ||= query.truncated;
      return {
        ordinal,
        kind: step.kind,
        title: step.title,
        query_template: query.text,
        query_truncated: query.truncated,
        max_documents: step.maxDocuments,
        max_chunks_per_document: step.maxChunksPerDocument,
        result_limit: step.resultLimit ?? null,
      };
    }
    return {
      ordinal,
      kind: step.kind,
      title: step.title,
      ...(step.kind === "output" ? { format: step.format } : {}),
    };
  });
  return {
    schema_version: "vera-assistant-workflow-definition-v1",
    workflow: {
      ...workflowSummary(workflow, projectId),
      language: workflow.language,
      practice: workflow.practice,
      jurisdictions: workflow.jurisdictions,
      skill_markdown: skill.text,
      skill_markdown_truncated: skill.truncated,
      steps,
      instructions_truncated: truncated,
    },
  };
}

function boundedCompletedOutput(output: WorkspaceJson | null) {
  if (output === null) {
    return { output: null, output_omitted: false, output_preview: null };
  }
  const serialized = JSON.stringify(output);
  if (serialized.length <= MAX_COMPLETED_OUTPUT_JSON_CHARS) {
    return { output, output_omitted: false, output_preview: null };
  }
  return {
    output: null,
    output_omitted: true,
    output_preview: serialized.slice(0, MAX_OUTPUT_PREVIEW_CHARS),
  };
}

function terminalStatus(status: WorkflowRunDetail["run"]["status"]) {
  return ["complete", "failed", "cancelled", "interrupted"].includes(status);
}

function encodedResult(value: unknown) {
  assertMikeSafePayload(value);
  const content = JSON.stringify(value);
  if (content.length > MAX_TOOL_RESULT_CHARS) {
    throw new AssistantWorkflowToolError(
      "Workflow tool result exceeds the Assistant context boundary.",
    );
  }
  return { content, sourceContext: [] };
}

function canonicalJson(value: WorkspaceJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`)
    .join(",")}}`;
}

function idempotencyKey(
  context: AssistantToolContext,
  workflowId: string,
  inputBinding: WorkspaceJson,
) {
  return `assistant-workflow:${context.jobId}:${createHash("sha256")
    .update(`${workflowId}\0${canonicalJson(inputBinding)}`)
    .digest("hex")}`;
}

function workflowRequiresModel(
  workflow: Extract<Workflow, { type: "assistant" }>,
) {
  return workflow.steps.length > 0
    ? workflow.steps.some((step) => step.kind === "prompt")
    : workflow.skillMarkdown.trim().length > 0;
}

function assertRunMatchesAction(
  detail: WorkflowRunDetail,
  workflow: Extract<Workflow, { type: "assistant" }>,
  context: AssistantToolContext,
  inputBinding: WorkspaceJson,
) {
  const runInput = detail.run.input;
  const persistedInputBinding =
    runInput && typeof runInput === "object" && !Array.isArray(runInput)
      ? runInput.inputBinding
      : undefined;
  const expectedModelProfileId = workflowRequiresModel(workflow)
    ? context.modelProfileId
    : null;
  if (
    detail.run.projectId !== context.projectId ||
    detail.run.workflowId !== workflow.id ||
    detail.run.modelProfileId !== expectedModelProfileId ||
    detail.run.retryOfRunId !== null ||
    persistedInputBinding === undefined ||
    !isDeepStrictEqual(persistedInputBinding, inputBinding)
  ) {
    throw new AssistantWorkflowToolError(
      "Durable workflow run does not match the reserved Assistant action.",
    );
  }
}

/**
 * Assistant-facing adapter over the existing durable WorkflowsService. It
 * owns no scheduler and never executes a step inline: prepareRun writes the
 * immutable snapshot and queued Job transactionally, then this tool returns.
 */
export class WorkspaceAssistantWorkflowToolModule implements AssistantToolModule {
  readonly id = ASSISTANT_WORKFLOW_TOOL_MODULE_ID;
  readonly adapterId = ASSISTANT_WORKFLOW_TOOL_ADAPTER_ID;
  private readonly generations = new Map<string, GenerationState>();
  private readonly highestAttempts = new Map<string, number>();

  constructor(
    private readonly workflows: AssistantWorkflowToolsServicePort,
    private readonly actions: Pick<
      WorkspaceAssistantActionLedger,
      "reserve" | "complete"
    >,
  ) {}

  async registeredTools(context: AssistantToolContext) {
    if (!context.projectId) return [];
    const highest = this.highestAttempts.get(context.jobId);
    if (highest !== undefined && context.attempt < highest) {
      throw new AssistantWorkflowToolError(
        "Workflow tool registration is older than the current job attempt.",
      );
    }
    this.highestAttempts.delete(context.jobId);
    this.highestAttempts.set(context.jobId, context.attempt);
    for (const [key, state] of this.generations) {
      if (state.context.jobId === context.jobId) this.generations.delete(key);
    }
    this.generations.set(generationKey(context), {
      context,
      runCount: 0,
      pollCount: 0,
    });
    while (this.generations.size > MAX_TRACKED_GENERATIONS) {
      const key = this.generations.keys().next().value as string | undefined;
      if (key === undefined) break;
      this.generations.delete(key);
    }
    while (this.highestAttempts.size > MAX_TRACKED_GENERATIONS) {
      const jobId = this.highestAttempts.keys().next().value as
        | string
        | undefined;
      if (jobId === undefined) break;
      this.highestAttempts.delete(jobId);
    }
    return WORKFLOW_TOOLS;
  }

  private generation(context: AssistantToolContext) {
    const state = this.generations.get(generationKey(context));
    if (
      !state ||
      state.context.projectId !== context.projectId ||
      state.context.chatId !== context.chatId ||
      state.context.modelProfileId !== context.modelProfileId
    ) {
      throw new AssistantWorkflowToolError(
        "Workflow tools are not registered for this job attempt.",
      );
    }
    return state;
  }

  private projectId(context: AssistantToolContext) {
    if (!context.projectId) throw new AssistantWorkflowToolError();
    return context.projectId;
  }

  private async listWorkflows(
    context: AssistantToolContext,
    signal: AbortSignal,
  ) {
    toolInput(EmptyInput, {});
    const projectId = this.projectId(context);
    const workflows: Array<Extract<Workflow, { type: "assistant" }>> = [];
    let truncated = false;
    for (const scope of [projectId, null] as const) {
      let cursor: string | null = null;
      for (
        let pageNumber = 0;
        pageNumber < MAX_LIST_SCAN_PAGES;
        pageNumber += 1
      ) {
        throwIfAborted(signal);
        const page = this.workflows.list({
          type: "assistant",
          projectId: scope,
          includeArchived: false,
          includeHidden: false,
          cursor,
          limit: LIST_SCAN_PAGE_SIZE,
        });
        throwIfAborted(signal);
        for (const workflow of page.items) {
          if (workflow.status !== "active" || workflow.type !== "assistant")
            continue;
          if (workflows.length >= MAX_LIST_RESULTS) {
            truncated = true;
            break;
          }
          workflows.push(workflow);
        }
        if (truncated || page.nextCursor === null) break;
        cursor = page.nextCursor;
        if (pageNumber === MAX_LIST_SCAN_PAGES - 1) truncated = true;
      }
      if (truncated) break;
    }
    return encodedResult({
      schema_version: "vera-assistant-workflow-list-v1",
      workflows: workflows.map((workflow) =>
        workflowSummary(workflow, projectId),
      ),
      truncated,
    });
  }

  private async readWorkflow(
    context: AssistantToolContext,
    callInput: unknown,
    signal: AbortSignal,
  ) {
    const input = toolInput(WorkflowIdInput, callInput);
    const projectId = this.projectId(context);
    throwIfAborted(signal);
    const workflow = assertAvailableWorkflow(
      this.workflows.get(input.workflow_id),
      projectId,
      this.workflows.isHidden(input.workflow_id),
    );
    throwIfAborted(signal);
    return encodedResult(workflowDefinition(workflow, projectId));
  }

  private async runWorkflow(
    context: AssistantToolContext,
    callInput: unknown,
    signal: AbortSignal,
  ) {
    const input = toolInput(RunWorkflowInput, callInput);
    const state = this.generation(context);
    if (state.runCount >= MAX_RUNS_PER_GENERATION) {
      throw new AssistantWorkflowToolError(
        "Workflow run budget is exhausted for this Assistant response.",
      );
    }
    const projectId = this.projectId(context);
    throwIfAborted(signal);
    const workflow = assertAvailableWorkflow(
      this.workflows.get(input.workflow_id),
      projectId,
      this.workflows.isHidden(input.workflow_id),
    );
    state.runCount += 1;
    const actionInput = {
      workflowId: workflow.id,
      modelProfileId: context.modelProfileId,
      inputBinding: input.input_binding ?? {},
    };
    const actionKey = idempotencyKey(
      context,
      workflow.id,
      input.input_binding ?? {},
    );
    const reservation = this.actions.reserve({
      jobId: context.jobId,
      attempt: context.attempt,
      leaseOwner: context.leaseOwner,
      projectId,
      actionKey,
      actionType: "run_workflow",
      input: actionInput,
    });
    if (
      reservation.record.status === "complete" &&
      (reservation.record.resourceType !== "workflow_run" ||
        reservation.record.resourceId === null)
    ) {
      throw new AssistantWorkflowToolError(
        "Completed Workflow action has an invalid durable resource.",
      );
    }
    const prepared =
      reservation.record.status === "complete"
        ? {
            detail: this.workflows.getRun(
              reservation.record.resourceId as string,
            ),
            reused: true,
          }
        : this.workflows.prepareRun(
            workflow.id,
            {
              projectId,
              modelProfileId: context.modelProfileId,
              idempotencyKey: actionKey,
              inputBinding: input.input_binding,
            },
            {
              maxSteps: DEFAULT_WORKFLOW_MAX_STEPS,
              maxModelCalls: DEFAULT_WORKFLOW_MAX_MODEL_CALLS,
            },
          );
    throwIfAborted(signal);
    assertRunMatchesAction(
      prepared.detail,
      workflow,
      context,
      input.input_binding ?? {},
    );
    this.actions.complete({
      jobId: context.jobId,
      attempt: context.attempt,
      leaseOwner: context.leaseOwner,
      projectId,
      actionKey,
      actionType: "run_workflow",
      input: actionInput,
      resourceType: "workflow_run",
      resourceId: prepared.detail.run.id,
    });
    return encodedResult({
      schema_version: "vera-assistant-workflow-run-v1",
      run_id: prepared.detail.run.id,
      workflow_id: prepared.detail.run.workflowId,
      project_id: prepared.detail.run.projectId,
      job_id: prepared.detail.run.jobId,
      status: prepared.detail.run.status,
      reused: prepared.reused,
      asynchronous: true,
      instruction:
        "The workflow is durable and queued. Query get_workflow_run in a later tool round; do not wait inside this call.",
    });
  }

  private async getWorkflowRun(
    context: AssistantToolContext,
    callInput: unknown,
    signal: AbortSignal,
  ) {
    const input = toolInput(GetWorkflowRunInput, callInput);
    const state = this.generation(context);
    if (state.pollCount >= MAX_RUN_POLLS_PER_GENERATION) {
      throw new AssistantWorkflowToolError(
        "Workflow status-read budget is exhausted for this Assistant response.",
      );
    }
    state.pollCount += 1;
    const projectId = this.projectId(context);
    throwIfAborted(signal);
    const detail = this.workflows.getRun(input.run_id);
    if (detail.run.projectId !== projectId) {
      throw new AssistantWorkflowToolError(
        "Workflow run is not available to this Matter.",
      );
    }
    // The durable run's project binding is authoritative after enqueue. A
    // workflow may be archived while its queued run is still executing; that
    // lifecycle change must not hide the Matter-owned run or its output.
    throwIfAborted(signal);
    const completedSteps = detail.steps.filter(
      (step) => step.status === "complete" || step.status === "skipped",
    ).length;
    const output =
      detail.run.status === "complete"
        ? boundedCompletedOutput(detail.run.output)
        : { output: null, output_omitted: false, output_preview: null };
    return encodedResult({
      schema_version: "vera-assistant-workflow-run-status-v1",
      run: {
        run_id: detail.run.id,
        workflow_id: detail.run.workflowId,
        project_id: detail.run.projectId,
        status: detail.run.status,
        terminal: terminalStatus(detail.run.status),
        progress: {
          completed_steps: completedSteps,
          total_steps: detail.steps.length,
        },
        ...output,
        error:
          detail.run.error === null
            ? null
            : {
                code: detail.run.error.code,
                message: detail.run.error.message.slice(0, 1_000),
                retryable: detail.run.error.retryable,
              },
        created_at: detail.run.createdAt,
        started_at: detail.run.startedAt,
        completed_at: detail.run.completedAt,
      },
      polling: {
        used: state.pollCount,
        remaining: MAX_RUN_POLLS_PER_GENERATION - state.pollCount,
      },
    });
  }

  async execute(input: {
    context: AssistantToolContext;
    call: AssistantModelToolCall;
    signal: AbortSignal;
  }) {
    this.generation(input.context);
    switch (input.call.name) {
      case "list_workflows":
        toolInput(EmptyInput, input.call.input);
        return this.listWorkflows(input.context, input.signal);
      case "read_workflow":
        return this.readWorkflow(input.context, input.call.input, input.signal);
      case "run_workflow":
        return this.runWorkflow(input.context, input.call.input, input.signal);
      case "get_workflow_run":
        return this.getWorkflowRun(
          input.context,
          input.call.input,
          input.signal,
        );
      default:
        throw new AssistantWorkflowToolError();
    }
  }
}
