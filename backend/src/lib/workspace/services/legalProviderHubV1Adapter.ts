import type {
  WorkspaceLegalProviderHubV1Context,
  WorkspaceLegalProviderHubV1Port,
  WorkspaceLegalProviderV1Wire,
  WorkspaceProjectLegalResearchStatusV1Wire,
} from "../../../routes/workspaceLegalProvidersV1";
import type { ProjectsService } from "./projects";
import { WorkspaceApiError } from "../errors";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../principal";
import {
  type LegalProviderHubLocalContext,
  type LegalProviderHubProfileView,
  WorkspaceLegalProviderHubService,
} from "./legalProviderHub";

const SCHEMA_VERSION = "vera-workspace-legal-provider-hub-v1" as const;
const CONNECTION_TEST_TIMEOUT_MS = 30_000;

function serializeProfile(
  profile: LegalProviderHubProfileView,
): WorkspaceLegalProviderV1Wire {
  const connectionTest =
    profile.connectionTest?.status === "passed"
      ? {
          status: "passed" as const,
          error_code: null,
          retryable: false as const,
          latency_ms: profile.connectionTest.latencyMs,
          tested_at: profile.connectionTest.testedAt,
        }
      : profile.connectionTest
        ? {
            status: "failed" as const,
            error_code: profile.connectionTest.errorCode!,
            retryable: profile.connectionTest.retryable,
            latency_ms: profile.connectionTest.latencyMs,
            tested_at: profile.connectionTest.testedAt,
          }
        : null;
  return {
    id: profile.id,
    provider: profile.provider,
    endpoint_set_id: profile.endpointSetId,
    enabled: profile.enabled,
    credential_configured: profile.credentialConfigured,
    usage_policy: {
      retention: "not_declared",
      local_processing: "transient_only",
      model_use: "prohibited_pending_authorization",
      export: "prohibited_pending_authorization",
    },
    capabilities: profile.capabilities.map((capability) => ({
      capability: capability.capability,
      enabled: capability.enabled,
    })),
    revision: profile.revision,
    connection_revision: profile.connectionRevision,
    credential_revision: profile.credentialRevision,
    connection_test: connectionTest,
    status: profile.status,
  };
}

/**
 * Converts the domain service into the narrow HTTP route port. Credential
 * references and fixed endpoint URLs never cross this boundary.
 */
export class WorkspaceLegalProviderHubV1Adapter implements WorkspaceLegalProviderHubV1Port {
  constructor(
    private readonly service: WorkspaceLegalProviderHubService,
    private readonly projects: Pick<ProjectsService, "get">,
  ) {}

  private localContext(
    context: WorkspaceLegalProviderHubV1Context,
  ): LegalProviderHubLocalContext {
    if (context.principalId !== WORKSPACE_LOCAL_PRINCIPAL_ID) {
      throw new WorkspaceApiError(403, "FORBIDDEN", "Workspace is local-only.");
    }
    return { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID };
  }

  listProviders(context: WorkspaceLegalProviderHubV1Context) {
    return this.service.list(this.localContext(context)).map(serializeProfile);
  }

  createOrGetYuanDian(context: WorkspaceLegalProviderHubV1Context) {
    const local = this.localContext(context);
    const existing = this.service.list(local)[0];
    if (existing)
      return { created: false, provider: serializeProfile(existing) };
    return {
      created: true,
      provider: serializeProfile(this.service.create(local)),
    };
  }

  async putCredential(
    context: WorkspaceLegalProviderHubV1Context,
    providerId: string,
    input: { secret: string; expected_revision: number },
  ) {
    const local = this.localContext(context);
    return serializeProfile(
      await this.service.putCredential(local, {
        profileId: providerId,
        expectedRevision: input.expected_revision,
        secret: input.secret,
      }),
    );
  }

  async deleteCredential(
    context: WorkspaceLegalProviderHubV1Context,
    providerId: string,
    input: { expected_revision: number },
  ) {
    const local = this.localContext(context);
    return serializeProfile(
      await this.service.deleteCredential(local, {
        profileId: providerId,
        expectedRevision: input.expected_revision,
      }),
    );
  }

  async testProvider(
    context: WorkspaceLegalProviderHubV1Context,
    providerId: string,
    input: { expected_revision: number },
  ) {
    const local = this.localContext(context);
    return serializeProfile(
      await this.service.testConnection(local, {
        profileId: providerId,
        expectedRevision: input.expected_revision,
        userAuthorized: true,
        signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS),
      }),
    );
  }

  enableProvider(
    context: WorkspaceLegalProviderHubV1Context,
    providerId: string,
    input: { expected_revision: number },
  ) {
    const local = this.localContext(context);
    return serializeProfile(
      this.service.setEnabled(local, {
        profileId: providerId,
        expectedRevision: input.expected_revision,
        enabled: true,
      }),
    );
  }

  disableProvider(
    context: WorkspaceLegalProviderHubV1Context,
    providerId: string,
    input: { expected_revision: number },
  ) {
    const local = this.localContext(context);
    return serializeProfile(
      this.service.setEnabled(local, {
        profileId: providerId,
        expectedRevision: input.expected_revision,
        enabled: false,
      }),
    );
  }

  getProjectLegalResearchStatus(
    context: WorkspaceLegalProviderHubV1Context,
    projectId: string,
  ): WorkspaceProjectLegalResearchStatusV1Wire {
    const project = this.projects.get(projectId);
    if (project.status !== "active") {
      return {
        schema_version: SCHEMA_VERSION,
        project_id: projectId,
        provider_id: null,
        status: "unavailable",
        reason: "project_not_eligible",
      };
    }
    const profile = this.service.list(this.localContext(context))[0];
    if (!profile) {
      return {
        schema_version: SCHEMA_VERSION,
        project_id: projectId,
        provider_id: null,
        status: "not_configured",
        reason: "provider_not_configured",
      };
    }

    if (profile.status === "ready" && profile.enabled) {
      return {
        schema_version: SCHEMA_VERSION,
        project_id: projectId,
        provider_id: profile.id,
        status: "ready",
        reason: null,
      };
    }

    const reason =
      !profile.enabled && profile.status !== "not_configured"
        ? "provider_disabled"
        : profile.status === "not_configured"
          ? "credential_missing"
          : profile.status === "configured_unverified"
            ? "connection_unverified"
            : profile.status === "authentication_failed"
              ? "authentication_failed"
              : profile.status === "license_restricted"
                ? "license_restricted"
                : profile.status === "temporarily_unavailable"
                  ? "temporarily_unavailable"
                  : profile.status === "unavailable"
                    ? "provider_unavailable"
                    : "activation_gate_closed";

    return {
      schema_version: SCHEMA_VERSION,
      project_id: projectId,
      provider_id: profile.id,
      status:
        profile.status === "ready" ? "activation_gate_closed" : profile.status,
      reason,
    };
  }
}
