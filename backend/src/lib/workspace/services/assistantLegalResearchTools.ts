import type { MatterPolicy } from "../../../matter/profile/contracts";
import type { AssistantModelToolCall, AssistantToolContext } from "./assistantRuntime";
import type { AssistantToolModule } from "./assistantToolRegistry";
import {
  LEGAL_RESEARCH_TOOL_ADAPTER_ID,
  LEGAL_RESEARCH_TOOL_MODULE_ID,
  type LegalResearchToolContext,
  type LegalResearchToolName,
  WorkspaceLegalResearchTools,
} from "./legalResearchTools";

const MAX_LEGAL_TOOL_RESULT_CHARS = 180 * 1_024;

export interface AssistantLegalResearchMatterPolicyPort {
  get(projectId: string): MatterPolicy | null;
}

export class AssistantLegalResearchPolicyError extends Error {
  readonly code = "assistant_tool_failed";
  readonly retryable = false;
  readonly details = null;

  constructor(message = "External legal research is not allowed for this Matter.") {
    super(message);
    this.name = "AssistantLegalResearchPolicyError";
  }
}

function legalContext(context: AssistantToolContext): LegalResearchToolContext {
  if (!context.projectId) throw new AssistantLegalResearchPolicyError();
  return {
    projectId: context.projectId,
    researchSessionId: `${context.jobId}:${context.attempt}`,
    // The Workspace Assistant does not yet carry a trustworthy local-model
    // attestation. Treat execution as remote; a production-ready provider must
    // therefore declare remote model-use rights. Technical PoC grants remain
    // an explicit, non-durable exception in the provider status contract.
    modelExecution: "remote",
  };
}

function policyAllowsExternalLegalResearch(
  context: AssistantToolContext,
  policies: AssistantLegalResearchMatterPolicyPort,
) {
  if (!context.projectId) return false;
  const policy = policies.get(context.projectId);
  return (
    policy?.projectId === context.projectId &&
    policy?.allowExternalLegalSources === true &&
    policy.externalEgressMode === "allowed_by_policy"
  );
}

/**
 * Assistant-facing legal research module. It deliberately emits no document
 * sourceContext because technical PoC legal content is transient and cannot be
 * represented by the current durable document-only citation schema.
 */
export class WorkspaceAssistantLegalResearchToolModule implements AssistantToolModule {
  readonly id = LEGAL_RESEARCH_TOOL_MODULE_ID;
  readonly adapterId = LEGAL_RESEARCH_TOOL_ADAPTER_ID;

  constructor(
    private readonly delegate: WorkspaceLegalResearchTools,
    private readonly policies: AssistantLegalResearchMatterPolicyPort,
  ) {}

  private assertMatterPolicy(context: AssistantToolContext) {
    if (!policyAllowsExternalLegalResearch(context, this.policies)) {
      throw new AssistantLegalResearchPolicyError();
    }
  }

  async registeredTools(context: AssistantToolContext) {
    if (!policyAllowsExternalLegalResearch(context, this.policies)) return [];
    return this.delegate.registeredTools(legalContext(context));
  }

  async assertModelUse(context: AssistantToolContext) {
    this.assertMatterPolicy(context);
    const status = await this.delegate.status(legalContext(context));
    if (!status.toolUseAllowed) throw new AssistantLegalResearchPolicyError();
  }

  async execute(input: {
    context: AssistantToolContext;
    call: AssistantModelToolCall;
    signal: AbortSignal;
  }) {
    this.assertMatterPolicy(input.context);
    const value = await this.delegate.execute({
      context: legalContext(input.context),
      call: {
        name: input.call.name as LegalResearchToolName,
        input: input.call.input,
      },
      signal: input.signal,
    });
    const content = JSON.stringify(value);
    if (content.length > MAX_LEGAL_TOOL_RESULT_CHARS) {
      throw new AssistantLegalResearchPolicyError(
        "Legal research tool result exceeds the Assistant context boundary.",
      );
    }
    return { content, sourceContext: [] };
  }
}
