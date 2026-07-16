import assert from "node:assert/strict";

import type { Page } from "../lib/workspace/pagination";
import type {
  PreparedWorkflowRun,
  WorkflowRunDetail,
} from "../lib/workspace/repositories/workflows";
import {
  AssistantWorkflowToolError,
  WorkspaceAssistantWorkflowToolModule,
  type AssistantWorkflowToolsServicePort,
} from "../lib/workspace/services/assistantWorkflowTools";
import type {
  AssistantModelToolCall,
  AssistantToolContext,
} from "../lib/workspace/services/assistantRuntime";
import {
  DEFAULT_WORKFLOW_MAX_MODEL_CALLS,
  DEFAULT_WORKFLOW_MAX_STEPS,
  type WorkflowExecutionLimits,
} from "../lib/workspace/services/workflows";
import type { Workflow, WorkspaceJson } from "../lib/workspace/types";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const MODEL_ID = "33333333-3333-4333-8333-333333333333";
const MATTER_WORKFLOW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GLOBAL_WORKFLOW_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER_WORKFLOW_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ARCHIVED_WORKFLOW_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TABULAR_WORKFLOW_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const RUN_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const JOB_ID = "66666666-6666-4666-8666-666666666666";
const SNAPSHOT_ID = "77777777-7777-4777-8777-777777777777";
const STEP_ID = "88888888-8888-4888-8888-888888888888";
const STEP_RUN_ID = "99999999-9999-4999-8999-999999999999";
const NOW = "2026-07-16T08:00:00.000Z";

function assistantWorkflow(input: {
  id: string;
  projectId: string | null;
  status?: "active" | "archived";
  isBuiltin?: boolean;
  skillMarkdown?: string;
}): Extract<Workflow, { type: "assistant" }> {
  return {
    id: input.id,
    type: "assistant",
    projectId: input.projectId,
    title: `Workflow ${input.id.slice(0, 4)}`,
    description: "Bounded workflow description.",
    status: input.status ?? "active",
    skillMarkdown: input.skillMarkdown ?? "Review the Matter documents.",
    steps: [
      {
        id: STEP_ID,
        kind: "prompt",
        title: "Review",
        prompt: "Review the supplied Matter context.",
      },
    ],
    language: "English",
    practice: "General Transactions",
    jurisdictions: ["General"],
    metadata: {},
    isBuiltin: input.isBuiltin ?? false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const matterWorkflow = assistantWorkflow({
  id: MATTER_WORKFLOW_ID,
  projectId: PROJECT_ID,
});
const globalWorkflow = assistantWorkflow({
  id: GLOBAL_WORKFLOW_ID,
  projectId: null,
  isBuiltin: true,
});
const otherWorkflow = assistantWorkflow({
  id: OTHER_WORKFLOW_ID,
  projectId: OTHER_PROJECT_ID,
});
const archivedWorkflow = assistantWorkflow({
  id: ARCHIVED_WORKFLOW_ID,
  projectId: PROJECT_ID,
  status: "archived",
});
const tabularWorkflow: Extract<Workflow, { type: "tabular" }> = {
  id: TABULAR_WORKFLOW_ID,
  type: "tabular",
  projectId: PROJECT_ID,
  title: "Tabular only",
  description: null,
  status: "active",
  steps: [],
  columns: [],
  language: "English",
  practice: "General Transactions",
  jurisdictions: ["General"],
  metadata: {},
  isBuiltin: false,
  createdAt: NOW,
  updatedAt: NOW,
};

function runDetail(
  status: WorkflowRunDetail["run"]["status"],
  workflowId = MATTER_WORKFLOW_ID,
  inputBinding: WorkspaceJson = {},
): WorkflowRunDetail {
  return {
    run: {
      id: RUN_ID,
      workflowId,
      projectId: PROJECT_ID,
      status,
      modelProfileId: MODEL_ID,
      jobId: JOB_ID,
      retryOfRunId: null,
      input: {
        schemaVersion: 1,
        execution: {
          maxSteps: DEFAULT_WORKFLOW_MAX_STEPS,
          maxModelCalls: DEFAULT_WORKFLOW_MAX_MODEL_CALLS,
          snapshotSha256: "a".repeat(64),
        },
        inputBinding,
        retryOfRunId: null,
      },
      output:
        status === "complete"
          ? { schema: "vera-workflow-run-result-v1", content: "Complete." }
          : null,
      startedAt: status === "queued" ? null : NOW,
      completedAt: status === "complete" ? NOW : null,
      error: null,
      createdAt: NOW,
    },
    steps: [
      {
        id: STEP_RUN_ID,
        workflowRunId: RUN_ID,
        ordinal: 0,
        attempt: 1,
        step: matterWorkflow.steps[0]!,
        status: status === "complete" ? "complete" : "queued",
        input: {},
        output: status === "complete" ? { content: "Complete." } : null,
        error: null,
        startedAt: status === "complete" ? NOW : null,
        completedAt: status === "complete" ? NOW : null,
      },
    ],
  };
}

function preparedRun(
  workflowId = MATTER_WORKFLOW_ID,
  inputBinding: WorkspaceJson = {},
): PreparedWorkflowRun {
  const workflow =
    workflowId === GLOBAL_WORKFLOW_ID ? globalWorkflow : matterWorkflow;
  return {
    detail: runDetail("queued", workflowId, inputBinding),
    reused: false,
    snapshot: {
      id: SNAPSHOT_ID,
      workflowRunId: RUN_ID,
      workflowId,
      schemaVersion: 1,
      workflowVersion: NOW,
      projectId: PROJECT_ID,
      modelProfileId: MODEL_ID,
      config: {
        execution: {
          maxSteps: DEFAULT_WORKFLOW_MAX_STEPS,
          maxModelCalls: DEFAULT_WORKFLOW_MAX_MODEL_CALLS,
        },
      },
      steps: workflow.steps,
      skillMarkdown: workflow.skillMarkdown,
      columns: [],
      inputBinding,
      snapshotSha256: "a".repeat(64),
      createdAt: NOW,
    },
  };
}

class FakeWorkflows implements AssistantWorkflowToolsServicePort {
  readonly values = new Map<string, Workflow>([
    [MATTER_WORKFLOW_ID, matterWorkflow],
    [GLOBAL_WORKFLOW_ID, globalWorkflow],
    [OTHER_WORKFLOW_ID, otherWorkflow],
    [ARCHIVED_WORKFLOW_ID, archivedWorkflow],
    [TABULAR_WORKFLOW_ID, tabularWorkflow],
  ]);
  detail = runDetail("complete");
  prepareInputs: Array<{
    workflowId: string;
    value: Record<string, unknown>;
    limits: WorkflowExecutionLimits;
  }> = [];
  listInputs: unknown[] = [];
  readonly hidden = new Set<string>();

  list(
    request: Parameters<AssistantWorkflowToolsServicePort["list"]>[0] = {},
  ): Page<Workflow> {
    this.listInputs.push(request);
    const items = [...this.values.values()].filter(
      (workflow) =>
        workflow.type === request.type &&
        workflow.projectId === request.projectId &&
        (request.includeArchived || workflow.status === "active"),
    );
    return { items, nextCursor: null };
  }

  get(id: string) {
    const value = this.values.get(id);
    if (!value) throw new Error("missing fake workflow");
    return value;
  }

  isHidden(id: string) {
    return this.hidden.has(id);
  }

  prepareRun(
    workflowId: string,
    value: unknown,
    limits: WorkflowExecutionLimits = {},
  ) {
    this.prepareInputs.push({
      workflowId,
      value: value as Record<string, unknown>,
      limits,
    });
    return preparedRun(
      workflowId,
      ((value as Record<string, unknown>).inputBinding ?? {}) as WorkspaceJson,
    );
  }

  getRun(id: string) {
    assert.equal(id, RUN_ID);
    return this.detail;
  }
}

function context(
  attempt = 1,
  projectId: string | null = PROJECT_ID,
): AssistantToolContext {
  return {
    jobId: "44444444-4444-4444-8444-444444444444",
    attempt,
    leaseOwner: `workflow-tools-audit-${attempt}`,
    chatId: "55555555-5555-4555-8555-555555555555",
    projectId,
    modelProfileId: MODEL_ID,
    documents: [],
  };
}

function call(
  name: AssistantModelToolCall["name"],
  input: Record<string, unknown>,
  suffix = "1",
): AssistantModelToolCall {
  return { id: `call-${name}-${suffix}`, name, input };
}

function parse(result: { content: string }) {
  assert.ok(result.content.length < 160_000);
  return JSON.parse(result.content) as Record<string, any>;
}

function fakeActionLedger(completedResourceId?: string) {
  const records = new Map<string, any>();
  return {
    reserve(input: any) {
      const key = `${input.jobId}\0${input.actionKey}`;
      if (completedResourceId) {
        return {
          created: false,
          record: {
            jobId: input.jobId,
            actionKey: input.actionKey,
            actionType: input.actionType,
            projectId: input.projectId,
            inputSha256: "0".repeat(64),
            status: "complete",
            reservedAttempt: input.attempt,
            completedAttempt: input.attempt,
            resourceType: "workflow_run",
            resourceId: completedResourceId,
            createdAt: NOW,
            updatedAt: NOW,
            completedAt: NOW,
          },
        };
      }
      const record = records.get(key) ?? {
        jobId: input.jobId,
        actionKey: input.actionKey,
        actionType: input.actionType,
        projectId: input.projectId,
        inputSha256: "0".repeat(64),
        status: "reserved",
        reservedAttempt: input.attempt,
        completedAttempt: null,
        resourceType: null,
        resourceId: null,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
      };
      records.set(key, record);
      return { record, created: record.status === "reserved" };
    },
    complete(input: any) {
      const key = `${input.jobId}\0${input.actionKey}`;
      const record = {
        ...records.get(key),
        status: "complete",
        completedAttempt: input.attempt,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        updatedAt: NOW,
        completedAt: NOW,
      };
      records.set(key, record);
      return { record, completed: true };
    },
  };
}

async function run() {
  const fake = new FakeWorkflows();
  const module = new WorkspaceAssistantWorkflowToolModule(
    fake,
    fakeActionLedger(),
  );
  assert.deepEqual(await module.registeredTools(context(1, null)), []);

  const activeContext = context();
  const definitions = await module.registeredTools(activeContext);
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    ["list_workflows", "read_workflow", "run_workflow", "get_workflow_run"],
  );
  for (const definition of definitions) {
    assert.equal(definition.inputSchema.additionalProperties, false);
  }

  const signal = new AbortController().signal;
  const listed = parse(
    await module.execute({
      context: activeContext,
      call: call("list_workflows", {}),
      signal,
    }),
  );
  assert.deepEqual(
    listed.workflows.map(
      (workflow: { workflow_id: string }) => workflow.workflow_id,
    ),
    [MATTER_WORKFLOW_ID, GLOBAL_WORKFLOW_ID],
  );
  assert.deepEqual(
    listed.workflows.map((workflow: { scope: string }) => workflow.scope),
    ["matter", "global_template"],
  );
  assert.equal(fake.listInputs.length, 2);

  await assert.rejects(
    module.execute({
      context: activeContext,
      call: call("list_workflows", { unexpected: true }),
      signal,
    }),
    AssistantWorkflowToolError,
  );
  for (const unavailableId of [
    OTHER_WORKFLOW_ID,
    ARCHIVED_WORKFLOW_ID,
    TABULAR_WORKFLOW_ID,
  ]) {
    await assert.rejects(
      module.execute({
        context: activeContext,
        call: call(
          "read_workflow",
          { workflow_id: unavailableId },
          unavailableId,
        ),
        signal,
      }),
      /not available to this Matter/i,
    );
  }
  fake.hidden.add(GLOBAL_WORKFLOW_ID);
  await assert.rejects(
    module.execute({
      context: activeContext,
      call: call(
        "read_workflow",
        { workflow_id: GLOBAL_WORKFLOW_ID },
        "hidden-read",
      ),
      signal,
    }),
    /not available to this Matter/i,
  );
  await assert.rejects(
    module.execute({
      context: activeContext,
      call: call(
        "run_workflow",
        { workflow_id: GLOBAL_WORKFLOW_ID },
        "hidden-run",
      ),
      signal,
    }),
    /not available to this Matter/i,
  );
  fake.hidden.delete(GLOBAL_WORKFLOW_ID);

  const mismatchedModelFake = new FakeWorkflows();
  mismatchedModelFake.detail = runDetail("complete", MATTER_WORKFLOW_ID, {
    issue: "termination",
  });
  mismatchedModelFake.detail.run.modelProfileId = OTHER_PROJECT_ID;
  const mismatchedModelModule = new WorkspaceAssistantWorkflowToolModule(
    mismatchedModelFake,
    fakeActionLedger(RUN_ID),
  );
  await mismatchedModelModule.registeredTools(activeContext);
  await assert.rejects(
    mismatchedModelModule.execute({
      context: activeContext,
      call: call(
        "run_workflow",
        {
          workflow_id: MATTER_WORKFLOW_ID,
          input_binding: { issue: "termination" },
        },
        "corrupt-model",
      ),
      signal,
    }),
    /does not match the reserved Assistant action/i,
  );

  const mismatchedInputFake = new FakeWorkflows();
  mismatchedInputFake.detail = runDetail("complete", MATTER_WORKFLOW_ID, {
    issue: "damages",
  });
  const mismatchedInputModule = new WorkspaceAssistantWorkflowToolModule(
    mismatchedInputFake,
    fakeActionLedger(RUN_ID),
  );
  await mismatchedInputModule.registeredTools(activeContext);
  await assert.rejects(
    mismatchedInputModule.execute({
      context: activeContext,
      call: call(
        "run_workflow",
        {
          workflow_id: MATTER_WORKFLOW_ID,
          input_binding: { issue: "termination" },
        },
        "corrupt-input",
      ),
      signal,
    }),
    /does not match the reserved Assistant action/i,
  );

  const read = parse(
    await module.execute({
      context: activeContext,
      call: call("read_workflow", { workflow_id: MATTER_WORKFLOW_ID }),
      signal,
    }),
  );
  assert.equal(read.workflow.workflow_id, MATTER_WORKFLOW_ID);
  assert.equal(
    read.workflow.steps[0].prompt,
    "Review the supplied Matter context.",
  );

  const huge = assistantWorkflow({
    id: "abababab-abab-4bab-8bab-abababababab",
    projectId: PROJECT_ID,
    skillMarkdown: "x".repeat(120_000),
  });
  fake.values.set(huge.id, huge);
  const bounded = parse(
    await module.execute({
      context: activeContext,
      call: call("read_workflow", { workflow_id: huge.id }),
      signal,
    }),
  );
  assert.equal(bounded.workflow.instructions_truncated, true);
  assert.equal(bounded.workflow.skill_markdown.length, 100_000);

  const started = parse(
    await module.execute({
      context: activeContext,
      call: call("run_workflow", {
        workflow_id: MATTER_WORKFLOW_ID,
        input_binding: { issue: "termination" },
      }),
      signal,
    }),
  );
  assert.equal(started.run_id, RUN_ID);
  assert.equal(started.status, "queued");
  assert.equal(started.asynchronous, true);
  assert.equal(fake.prepareInputs[0]?.workflowId, MATTER_WORKFLOW_ID);
  assert.deepEqual(fake.prepareInputs[0]?.limits, {
    maxSteps: DEFAULT_WORKFLOW_MAX_STEPS,
    maxModelCalls: DEFAULT_WORKFLOW_MAX_MODEL_CALLS,
  });
  assert.equal(fake.prepareInputs[0]?.value.projectId, PROJECT_ID);
  assert.equal(fake.prepareInputs[0]?.value.modelProfileId, MODEL_ID);
  assert.match(
    String(fake.prepareInputs[0]?.value.idempotencyKey),
    /^assistant-workflow:[0-9a-f-]{36}:[a-f0-9]{64}$/,
  );

  await module.execute({
    context: activeContext,
    call: call("run_workflow", { workflow_id: GLOBAL_WORKFLOW_ID }, "2"),
    signal,
  });
  await assert.rejects(
    module.execute({
      context: activeContext,
      call: call("run_workflow", { workflow_id: MATTER_WORKFLOW_ID }, "3"),
      signal,
    }),
    /run budget is exhausted/i,
  );

  const status = parse(
    await module.execute({
      context: activeContext,
      call: call("get_workflow_run", { run_id: RUN_ID }),
      signal,
    }),
  );
  assert.equal(status.run.status, "complete");
  assert.equal(status.run.output.content, "Complete.");
  assert.equal(status.run.progress.completed_steps, 1);
  assert.deepEqual(status.polling, { used: 1, remaining: 7 });
  for (let index = 2; index <= 8; index += 1) {
    await module.execute({
      context: activeContext,
      call: call("get_workflow_run", { run_id: RUN_ID }, String(index)),
      signal,
    });
  }
  await assert.rejects(
    module.execute({
      context: activeContext,
      call: call("get_workflow_run", { run_id: RUN_ID }, "9"),
      signal,
    }),
    /status-read budget is exhausted/i,
  );

  const otherRun = runDetail("complete");
  otherRun.run.projectId = OTHER_PROJECT_ID;
  fake.detail = otherRun;
  const nextContext = context(2);
  await module.registeredTools(nextContext);
  await assert.rejects(
    module.execute({
      context: nextContext,
      call: call("get_workflow_run", { run_id: RUN_ID }),
      signal,
    }),
    /not available to this Matter/i,
  );
  await assert.rejects(
    module.registeredTools(context(1)),
    /older than the current job attempt/i,
  );

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    module.execute({
      context: nextContext,
      call: call("list_workflows", {}),
      signal: aborted.signal,
    }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );

  console.log(
    "veraWorkspaceAssistantWorkflowToolsAudit passed: strict Matter ownership, durable async runs, bounded workflow definitions, and per-generation run/poll budgets are enforced.",
  );
}

void run();
