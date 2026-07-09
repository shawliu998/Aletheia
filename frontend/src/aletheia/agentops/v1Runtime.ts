import {
  createAuditEvent,
  createDefaultAgentRun,
  hashArtifact,
  validateV1ArtifactShape,
} from "./v1Contracts";
import type {
  AgentRun,
  AgentRunStatus,
  ArtifactRef,
  ArtifactType,
  AuditEvent,
  ToolCall,
  TraceEvent,
} from "./types";

export const V1_RUNTIME_VERSION = "aletheia-v1-llm-runtime-2026-07-09" as const;

export const V1_MODEL_PROVIDERS = [
  "deterministic",
  "openai",
  "deepseek",
  "anthropic",
  "local",
  "custom",
] as const;

export type V1ModelProvider = (typeof V1_MODEL_PROVIDERS)[number];
export type V1PrivacyMode = "public" | "private" | "sensitive";
export type V1CyclePhase =
  | "observe"
  | "plan"
  | "act"
  | "persist"
  | "gate"
  | "report";
export type V1StructuredArtifactType = Parameters<
  typeof validateV1ArtifactShape
>[0];

export type V1ModelBudget = {
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
  repairAttempts?: number;
};

export type V1ModelProviderConfig = {
  provider: V1ModelProvider;
  model: string;
  enabled: boolean;
  external: boolean;
  allowSensitiveExternal: boolean;
  endpoint?: string;
};

export type V1ProviderPolicyDecision = {
  allowed: boolean;
  reason: string;
  externalCall: boolean;
  provider: V1ModelProvider;
  model: string;
  privacyMode: V1PrivacyMode;
};

export type V1ProviderCallInput = {
  provider: V1ModelProviderConfig;
  prompt: string;
  privacyMode: V1PrivacyMode;
  budget: V1ModelBudget;
};

export type V1StructuredModelCycleInput = {
  matter_id: string;
  agent_id: string;
  prompt: string;
  output_artifact_type: V1StructuredArtifactType;
  provider?: Partial<V1ModelProviderConfig> & { provider?: V1ModelProvider };
  privacyMode?: V1PrivacyMode;
  budget?: V1ModelBudget;
  deterministicOutput?: unknown;
  providerCall?: (input: V1ProviderCallInput) => Promise<unknown> | unknown;
  repairOutput?: (input: {
    output: unknown;
    errors: string[];
    attempt: number;
  }) => Promise<unknown> | unknown;
  now?: string;
  run_id?: string;
};

export type V1StructuredModelCycleResult = {
  run: AgentRun;
  audit_events: AuditEvent[];
  output?: unknown;
  validation: ReturnType<typeof validateV1ArtifactShape>;
  provider_decision: V1ProviderPolicyDecision;
};

export type V1SchedulerJob = V1StructuredModelCycleInput & {
  scheduler_job_id: string;
  status?: AgentRunStatus;
  priority?: number;
  created_at?: string;
};

export type V1SchedulerDecision = {
  selected_job_id?: string;
  skipped_job_ids: string[];
  considered_jobs: number;
  blocked_reason?: string;
  next_action?: string;
};

export type V1SchedulerCycleInput = {
  matter_id: string;
  scheduler_id?: string;
  jobs: V1SchedulerJob[];
  maxRunsPerCycle?: number;
  now?: string;
  run_id?: string;
};

export type V1SchedulerCycleResult = {
  scheduler_run: AgentRun;
  decision: V1SchedulerDecision;
  dispatched_result?: V1StructuredModelCycleResult;
  audit_events: AuditEvent[];
};

const EXTERNAL_PROVIDERS = new Set<V1ModelProvider>([
  "openai",
  "deepseek",
  "anthropic",
]);

const P0_ARTIFACT_TYPES = new Set<ArtifactType>([
  "matter",
  "document",
  "evidence_item",
  "issue_node",
  "risk_item",
  "draft_memo",
  "review_comment",
  "gate_result",
  "audit_event",
  "eval_case",
  "professional_skill",
  "agent_run",
  "audit_pack",
  "export",
]);

function estimatedTokens(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.max(1, Math.ceil(text.length / 4));
}

function createToolCall(params: {
  id: string;
  name: string;
  now: string;
  status: ToolCall["status"];
  input?: unknown;
  output?: unknown;
  error?: string;
}): ToolCall {
  return {
    id: params.id,
    name: params.name,
    started_at: params.now,
    ended_at: params.status === "started" ? undefined : params.now,
    status: params.status,
    input: params.input,
    output: params.output,
    error: params.error,
  };
}

function traceEvent(
  runId: string,
  now: string,
  phase: V1CyclePhase,
  message: string,
  metadata: Record<string, unknown> = {},
): TraceEvent {
  return {
    id: `${runId}-${phase}`,
    timestamp: now,
    level: metadata.error ? "error" : "info",
    message,
    metadata: { phase, ...metadata },
  };
}

function artifactRefForOutput(
  artifactType: V1StructuredArtifactType,
  output: unknown,
): ArtifactRef | null {
  if (!P0_ARTIFACT_TYPES.has(artifactType as ArtifactType)) return null;
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const id = (output as Record<string, unknown>).id;
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    type: artifactType as ArtifactType,
    hash: hashArtifact(output),
  };
}

function rankedQueuedJobs(jobs: V1SchedulerJob[]) {
  return jobs
    .filter((job) => (job.status ?? "queued") === "queued")
    .sort((left, right) => {
      const priorityDelta = (right.priority ?? 0) - (left.priority ?? 0);
      if (priorityDelta !== 0) return priorityDelta;
      const leftCreated = left.created_at ?? "";
      const rightCreated = right.created_at ?? "";
      const createdDelta = leftCreated.localeCompare(rightCreated);
      if (createdDelta !== 0) return createdDelta;
      return left.scheduler_job_id.localeCompare(right.scheduler_job_id);
    });
}

export function planV1SchedulerCycle(
  input: Pick<V1SchedulerCycleInput, "jobs" | "maxRunsPerCycle">,
): V1SchedulerDecision {
  const maxRunsPerCycle = input.maxRunsPerCycle ?? 1;
  const queuedJobs = rankedQueuedJobs(input.jobs);
  const skippedJobIds = input.jobs
    .filter((job) => (job.status ?? "queued") !== "queued")
    .map((job) => job.scheduler_job_id);

  if (maxRunsPerCycle < 1) {
    return {
      skipped_job_ids: input.jobs.map((job) => job.scheduler_job_id),
      considered_jobs: input.jobs.length,
      blocked_reason: "scheduler maxRunsPerCycle budget is exhausted",
      next_action: "Increase maxRunsPerCycle or wait for the next bounded cycle.",
    };
  }

  if (queuedJobs.length === 0) {
    return {
      skipped_job_ids: skippedJobIds,
      considered_jobs: input.jobs.length,
      blocked_reason: "no queued V1 scheduler jobs are eligible",
      next_action: "Queue a deterministic or explicitly approved provider job.",
    };
  }

  const selected = queuedJobs[0];
  return {
    selected_job_id: selected.scheduler_job_id,
    skipped_job_ids: [
      ...skippedJobIds,
      ...queuedJobs.slice(1).map((job) => job.scheduler_job_id),
    ],
    considered_jobs: input.jobs.length,
  };
}

export function createV1ModelProviderConfig(
  input: Partial<V1ModelProviderConfig> & { provider?: V1ModelProvider } = {},
): V1ModelProviderConfig {
  const provider = input.provider ?? "deterministic";
  const external = input.external ?? EXTERNAL_PROVIDERS.has(provider);
  const model =
    input.model ??
    (provider === "deterministic" ? "deterministic-v1" : `${provider}-configured`);

  return {
    provider,
    model,
    external,
    enabled: input.enabled ?? (provider === "deterministic" || provider === "local"),
    allowSensitiveExternal: input.allowSensitiveExternal ?? false,
    endpoint: input.endpoint,
  };
}

export function evaluateV1ProviderPolicy(params: {
  provider: V1ModelProviderConfig;
  privacyMode: V1PrivacyMode;
}): V1ProviderPolicyDecision {
  const { provider, privacyMode } = params;
  if (!provider.enabled) {
    return {
      allowed: false,
      reason: `${provider.provider} provider is disabled`,
      externalCall: provider.external,
      provider: provider.provider,
      model: provider.model,
      privacyMode,
    };
  }

  if (
    provider.external &&
    (privacyMode === "private" || privacyMode === "sensitive") &&
    !provider.allowSensitiveExternal
  ) {
    return {
      allowed: false,
      reason:
        "external model calls for private or sensitive data require explicit approval",
      externalCall: true,
      provider: provider.provider,
      model: provider.model,
      privacyMode,
    };
  }

  return {
    allowed: true,
    reason: provider.external
      ? "external provider explicitly enabled for this privacy mode"
      : "local or deterministic provider",
    externalCall: provider.external,
    provider: provider.provider,
    model: provider.model,
    privacyMode,
  };
}

export async function runV1StructuredModelCycle(
  input: V1StructuredModelCycleInput,
): Promise<V1StructuredModelCycleResult> {
  const now = input.now ?? new Date().toISOString();
  const provider = createV1ModelProviderConfig(input.provider);
  const privacyMode = input.privacyMode ?? "private";
  const budget = input.budget ?? {};
  const run = createDefaultAgentRun({
    matter_id: input.matter_id,
    agent_id: input.agent_id,
    id: input.run_id,
    started_at: now,
    status: "working",
    model: `${provider.provider}:${provider.model}`,
  });
  const auditEvents: AuditEvent[] = [
    createAuditEvent({
      matter_id: input.matter_id,
      actor_type: "system",
      actor_id: "v1-llm-runtime",
      action: "v1_agent_run_started",
      artifact_id: run.id,
      artifact_type: "agent_run",
      timestamp: now,
    }),
  ];

  run.trace_events.push(
    traceEvent(run.id, now, "observe", "Observed V1 model cycle inputs.", {
      privacyMode,
      outputArtifactType: input.output_artifact_type,
      promptCharacters: input.prompt.length,
    }),
    traceEvent(run.id, now, "plan", "Selected provider policy and budget.", {
      provider: provider.provider,
      model: provider.model,
      external: provider.external,
      budget,
    }),
  );

  const policy = evaluateV1ProviderPolicy({ provider, privacyMode });
  run.tool_calls.push(
    createToolCall({
      id: `${run.id}-provider-policy`,
      name: "v1_provider_policy",
      now,
      status: policy.allowed ? "succeeded" : "failed",
      input: {
        provider: provider.provider,
        model: provider.model,
        external: provider.external,
        privacyMode,
      },
      output: policy,
      error: policy.allowed ? undefined : policy.reason,
    }),
  );

  if (!policy.allowed) {
    run.status = "blocked";
    run.ended_at = now;
    run.errors.push(policy.reason);
    run.trace_events.push(
      traceEvent(run.id, now, "gate", "Provider policy blocked the model call.", {
        error: policy.reason,
        provider: provider.provider,
        external: provider.external,
      }),
      traceEvent(run.id, now, "report", "Run blocked before model execution.", {
        status: run.status,
      }),
    );
    auditEvents.push(
      createAuditEvent({
        matter_id: input.matter_id,
        actor_type: "system",
        actor_id: "v1-llm-runtime",
        action: "v1_external_model_call_blocked",
        artifact_id: run.id,
        artifact_type: "agent_run",
        timestamp: now,
        after_hash: hashArtifact(policy),
      }),
    );
    return {
      run,
      audit_events: auditEvents,
      validation: { ok: false, errors: [policy.reason] },
      provider_decision: policy,
    };
  }

  const modelInput = {
    provider: provider.provider,
    model: provider.model,
    privacyMode,
    promptCharacters: input.prompt.length,
    promptRedacted: privacyMode !== "public",
    budget,
  };
  let output =
    provider.provider === "deterministic" || !input.providerCall
      ? input.deterministicOutput
      : await input.providerCall({ provider, prompt: input.prompt, privacyMode, budget });
  run.tool_calls.push(
    createToolCall({
      id: `${run.id}-model-call`,
      name: "v1_model_call",
      now,
      status: "succeeded",
      input: modelInput,
      output: {
        outputHash: hashArtifact(output),
        outputArtifactType: input.output_artifact_type,
      },
    }),
  );
  run.trace_events.push(
    traceEvent(run.id, now, "act", "Model provider returned structured output.", {
      outputHash: hashArtifact(output),
    }),
  );

  let validation = validateV1ArtifactShape(input.output_artifact_type, output);
  const repairAttempts = Math.max(0, budget.repairAttempts ?? 0);
  for (
    let attempt = 1;
    !validation.ok && attempt <= repairAttempts && input.repairOutput;
    attempt += 1
  ) {
    output = await input.repairOutput({
      output,
      errors: validation.errors,
      attempt,
    });
    validation = validateV1ArtifactShape(input.output_artifact_type, output);
    run.tool_calls.push(
      createToolCall({
        id: `${run.id}-repair-${attempt}`,
        name: "v1_structured_output_repair",
        now,
        status: validation.ok ? "succeeded" : "failed",
        input: { attempt, errors: validation.ok ? [] : validation.errors },
        output: { outputHash: hashArtifact(output), validation },
        error: validation.ok ? undefined : validation.errors.join("; "),
      }),
    );
  }

  run.tool_calls.push(
    createToolCall({
      id: `${run.id}-schema-guard`,
      name: "v1_structured_output_guard",
      now,
      status: validation.ok ? "succeeded" : "failed",
      input: { outputArtifactType: input.output_artifact_type },
      output: validation,
      error: validation.ok ? undefined : validation.errors.join("; "),
    }),
  );

  run.token_usage = {
    input_tokens: estimatedTokens(input.prompt),
    output_tokens: estimatedTokens(output),
    total_tokens: estimatedTokens(input.prompt) + estimatedTokens(output),
  };

  if (!validation.ok) {
    run.status = "failed";
    run.ended_at = now;
    run.errors.push(...validation.errors);
    run.trace_events.push(
      traceEvent(run.id, now, "gate", "Structured output failed schema guard.", {
        error: validation.errors.join("; "),
      }),
      traceEvent(run.id, now, "report", "Run failed with rejected output.", {
        status: run.status,
        tokenUsage: run.token_usage,
      }),
    );
    auditEvents.push(
      createAuditEvent({
        matter_id: input.matter_id,
        actor_type: "system",
        actor_id: "v1-llm-runtime",
        action: "v1_structured_output_rejected",
        artifact_id: run.id,
        artifact_type: "agent_run",
        timestamp: now,
        after_hash: hashArtifact({ validation, output }),
      }),
    );
    return { run, audit_events: auditEvents, validation, provider_decision: policy };
  }

  const outputRef = artifactRefForOutput(input.output_artifact_type, output);
  if (outputRef) run.output_artifacts.push(outputRef);
  run.status = "done";
  run.ended_at = now;
  run.trace_events.push(
    traceEvent(run.id, now, "persist", "Validated output is ready to persist.", {
      outputArtifactRef: outputRef,
      outputHash: hashArtifact(output),
    }),
    traceEvent(run.id, now, "gate", "Structured output passed schema guard.", {
      validation,
    }),
    traceEvent(run.id, now, "report", "Run completed successfully.", {
      status: run.status,
      tokenUsage: run.token_usage,
    }),
  );
  auditEvents.push(
    createAuditEvent({
      matter_id: input.matter_id,
      actor_type: "system",
      actor_id: "v1-llm-runtime",
      action: "v1_structured_output_accepted",
      artifact_id: outputRef?.id ?? run.id,
      artifact_type: outputRef?.type ?? "agent_run",
      timestamp: now,
      after_hash: hashArtifact(output),
    }),
  );

  return {
    run,
    audit_events: auditEvents,
    output,
    validation,
    provider_decision: policy,
  };
}

export async function runV1SchedulerCycle(
  input: V1SchedulerCycleInput,
): Promise<V1SchedulerCycleResult> {
  const now = input.now ?? new Date().toISOString();
  const schedulerRun = createDefaultAgentRun({
    matter_id: input.matter_id,
    agent_id: input.scheduler_id ?? "v1-agent-scheduler",
    id: input.run_id,
    started_at: now,
    status: "working",
    model: "scheduler:bounded-v1",
  });
  const auditEvents: AuditEvent[] = [
    createAuditEvent({
      matter_id: input.matter_id,
      actor_type: "system",
      actor_id: "v1-agent-scheduler",
      action: "v1_scheduler_cycle_started",
      artifact_id: schedulerRun.id,
      artifact_type: "agent_run",
      timestamp: now,
    }),
  ];
  const decision = planV1SchedulerCycle(input);

  schedulerRun.trace_events.push(
    traceEvent(
      schedulerRun.id,
      now,
      "observe",
      "Observed bounded V1 scheduler queue.",
      {
        consideredJobs: decision.considered_jobs,
        queuedJobs: rankedQueuedJobs(input.jobs).length,
      },
    ),
    traceEvent(schedulerRun.id, now, "plan", "Planned at most one V1 job.", {
      decision,
      maxRunsPerCycle: input.maxRunsPerCycle ?? 1,
    }),
  );

  if (!decision.selected_job_id) {
    schedulerRun.status = decision.blocked_reason ? "blocked" : "done";
    schedulerRun.ended_at = now;
    if (decision.blocked_reason) schedulerRun.errors.push(decision.blocked_reason);
    schedulerRun.tool_calls.push(
      createToolCall({
        id: `${schedulerRun.id}-scheduler-decision`,
        name: "v1_scheduler_decision",
        now,
        status: decision.blocked_reason ? "skipped" : "succeeded",
        input: {
          jobIds: input.jobs.map((job) => job.scheduler_job_id),
          maxRunsPerCycle: input.maxRunsPerCycle ?? 1,
        },
        output: decision,
        error: decision.blocked_reason,
      }),
    );
    schedulerRun.trace_events.push(
      traceEvent(schedulerRun.id, now, "gate", "Scheduler did not dispatch.", {
        error: decision.blocked_reason,
        nextAction: decision.next_action,
      }),
      traceEvent(schedulerRun.id, now, "report", "Scheduler cycle ended.", {
        status: schedulerRun.status,
      }),
    );
    auditEvents.push(
      createAuditEvent({
        matter_id: input.matter_id,
        actor_type: "system",
        actor_id: "v1-agent-scheduler",
        action: "v1_scheduler_cycle_blocked",
        artifact_id: schedulerRun.id,
        artifact_type: "agent_run",
        timestamp: now,
        after_hash: hashArtifact(decision),
      }),
    );
    return { scheduler_run: schedulerRun, decision, audit_events: auditEvents };
  }

  const selectedJob = input.jobs.find(
    (job) => job.scheduler_job_id === decision.selected_job_id,
  );
  if (!selectedJob) {
    throw new Error("Selected scheduler job was not found");
  }

  schedulerRun.tool_calls.push(
    createToolCall({
      id: `${schedulerRun.id}-scheduler-dispatch`,
      name: "v1_scheduler_dispatch",
      now,
      status: "succeeded",
      input: {
        selectedJobId: selectedJob.scheduler_job_id,
        outputArtifactType: selectedJob.output_artifact_type,
        provider: selectedJob.provider,
        privacyMode: selectedJob.privacyMode ?? "private",
      },
      output: decision,
    }),
  );
  const dispatchedResult = await runV1StructuredModelCycle({
    ...selectedJob,
    now,
  });
  schedulerRun.status =
    dispatchedResult.run.status === "done"
      ? "done"
      : dispatchedResult.run.status === "blocked"
        ? "blocked"
        : "failed";
  schedulerRun.ended_at = now;
  schedulerRun.output_artifacts.push({
    id: dispatchedResult.run.id,
    type: "agent_run",
    hash: hashArtifact(dispatchedResult.run),
  });
  if (schedulerRun.status !== "done") {
    schedulerRun.errors.push(...dispatchedResult.run.errors);
  }
  schedulerRun.token_usage = dispatchedResult.run.token_usage;
  schedulerRun.trace_events.push(
    traceEvent(schedulerRun.id, now, "persist", "Captured dispatched run trace.", {
      dispatchedRunId: dispatchedResult.run.id,
      dispatchedRunStatus: dispatchedResult.run.status,
    }),
    traceEvent(schedulerRun.id, now, "gate", "Mapped dispatched run terminal status.", {
      status: schedulerRun.status,
      providerDecision: dispatchedResult.provider_decision,
    }),
    traceEvent(schedulerRun.id, now, "report", "Scheduler cycle ended.", {
      status: schedulerRun.status,
      tokenUsage: schedulerRun.token_usage,
    }),
  );
  auditEvents.push(...dispatchedResult.audit_events);
  auditEvents.push(
    createAuditEvent({
      matter_id: input.matter_id,
      actor_type: "system",
      actor_id: "v1-agent-scheduler",
      action: "v1_scheduler_cycle_dispatched",
      artifact_id: dispatchedResult.run.id,
      artifact_type: "agent_run",
      timestamp: now,
      after_hash: hashArtifact({
        decision,
        dispatchedRunId: dispatchedResult.run.id,
        dispatchedRunStatus: dispatchedResult.run.status,
      }),
    }),
  );

  return {
    scheduler_run: schedulerRun,
    decision,
    dispatched_result: dispatchedResult,
    audit_events: auditEvents,
  };
}
