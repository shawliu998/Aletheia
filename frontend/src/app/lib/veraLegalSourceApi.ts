import { VeraApiError, veraApiRequest } from "@/app/lib/veraApi";

export { VeraApiError as VeraLegalSourceApiError };

export const VERA_LEGAL_PROVIDER_SCHEMA_VERSION =
  "vera-workspace-legal-provider-hub-v1" as const;
export const VERA_LEGAL_PROVIDER = "yuandian" as const;
export const VERA_LEGAL_PROVIDER_ENDPOINT_SET =
  "yuandian-official-mcp-v1" as const;

export type VeraLegalSourceProviderId = typeof VERA_LEGAL_PROVIDER;
export type VeraLegalSourceCapabilityName = "law" | "case" | "company";
export type VeraLegalSourceStatus =
  | "unavailable"
  | "not_configured"
  | "configured_unverified"
  | "ready"
  | "authentication_failed"
  | "license_restricted"
  | "activation_gate_closed"
  | "temporarily_unavailable";
export type VeraLegalSourceConnectionErrorCode =
  | "authentication_failed"
  | "license_restricted"
  | "credential_unavailable"
  | "timeout"
  | "temporarily_unavailable"
  | "transport_error"
  | "protocol_invalid"
  | "response_invalid";

export type VeraLegalSourceCapability = Readonly<{
  capability: VeraLegalSourceCapabilityName;
  enabled: boolean;
}>;

export type VeraLegalSourceConnectionTest = Readonly<{
  status: "passed" | "failed";
  error_code: VeraLegalSourceConnectionErrorCode | null;
  retryable: boolean;
  latency_ms: number | null;
  tested_at: string;
}>;

export type VeraLegalSourceProvider = Readonly<{
  id: string;
  provider: VeraLegalSourceProviderId;
  endpoint_set_id: typeof VERA_LEGAL_PROVIDER_ENDPOINT_SET;
  enabled: boolean;
  credential_configured: boolean;
  usage_policy: Readonly<{
    retention: "not_declared";
    local_processing: "transient_only";
    model_use: "prohibited_pending_authorization";
    export: "prohibited_pending_authorization";
  }>;
  capabilities: readonly VeraLegalSourceCapability[];
  revision: number;
  connection_revision: number;
  credential_revision: number;
  connection_test: VeraLegalSourceConnectionTest | null;
  status: VeraLegalSourceStatus;
}>;

export type VeraLegalSourceProvidersResponse = Readonly<{
  schema_version: typeof VERA_LEGAL_PROVIDER_SCHEMA_VERSION;
  providers: readonly VeraLegalSourceProvider[];
}>;

export type VeraLegalSourceProviderResponse = Readonly<{
  schema_version: typeof VERA_LEGAL_PROVIDER_SCHEMA_VERSION;
  profile: VeraLegalSourceProvider;
}>;

const PROFILE_KEYS = [
  "id",
  "provider",
  "endpoint_set_id",
  "enabled",
  "credential_configured",
  "usage_policy",
  "capabilities",
  "revision",
  "connection_revision",
  "credential_revision",
  "connection_test",
  "status",
] as const;
const CAPABILITY_KEYS = ["capability", "enabled"] as const;
const CONNECTION_TEST_KEYS = [
  "status",
  "error_code",
  "retryable",
  "latency_ms",
  "tested_at",
] as const;
const USAGE_POLICY_KEYS = [
  "retention",
  "local_processing",
  "model_use",
  "export",
] as const;
const CAPABILITIES = ["law", "case", "company"] as const;
const STATUSES = [
  "unavailable",
  "not_configured",
  "configured_unverified",
  "ready",
  "authentication_failed",
  "license_restricted",
  "activation_gate_closed",
  "temporarily_unavailable",
] as const;
const CONNECTION_ERRORS = [
  "authentication_failed",
  "license_restricted",
  "credential_unavailable",
  "timeout",
  "temporarily_unavailable",
  "transport_error",
  "protocol_invalid",
  "response_invalid",
] as const;
const STRICT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STRICT_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function invalidResponse(): never {
  throw new VeraApiError({
    status: 502,
    code: "INVALID_RESPONSE",
    message: "The Vera legal-provider API returned an invalid response.",
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidResponse();
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (
    actual.length !== allowed.length ||
    actual.some((key, index) => key !== allowed[index])
  ) {
    invalidResponse();
  }
}

function member<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    invalidResponse();
  }
  return value as T;
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") invalidResponse();
  return value;
}

function revision(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 2_147_483_647
  ) {
    invalidResponse();
  }
  return value;
}

function parseConnectionTest(
  value: unknown,
): VeraLegalSourceConnectionTest | null {
  if (value === null) return null;
  const raw = record(value);
  exactKeys(raw, CONNECTION_TEST_KEYS);
  const status = member(raw.status, ["passed", "failed"] as const);
  const errorCode =
    raw.error_code === null ? null : member(raw.error_code, CONNECTION_ERRORS);
  const retryable = bool(raw.retryable);
  const latency = raw.latency_ms === null ? null : revision(raw.latency_ms);
  if (latency !== null && latency > 600_000) invalidResponse();
  if (
    typeof raw.tested_at !== "string" ||
    !STRICT_UTC.test(raw.tested_at) ||
    !Number.isFinite(Date.parse(raw.tested_at)) ||
    new Date(raw.tested_at).toISOString() !== raw.tested_at ||
    (status === "passed" && (errorCode !== null || retryable)) ||
    (status === "failed" && errorCode === null)
  ) {
    invalidResponse();
  }
  return {
    status,
    error_code: errorCode,
    retryable,
    latency_ms: latency,
    tested_at: raw.tested_at,
  };
}

export function parseVeraLegalSourceProvider(
  value: unknown,
): VeraLegalSourceProvider {
  const raw = record(value);
  exactKeys(raw, PROFILE_KEYS);
  if (typeof raw.id !== "string" || !STRICT_UUID.test(raw.id)) {
    invalidResponse();
  }
  const provider = member(raw.provider, [VERA_LEGAL_PROVIDER] as const);
  const endpointSetId = member(raw.endpoint_set_id, [
    VERA_LEGAL_PROVIDER_ENDPOINT_SET,
  ] as const);
  const enabled = bool(raw.enabled);
  const credentialConfigured = bool(raw.credential_configured);
  const usagePolicy = record(raw.usage_policy);
  exactKeys(usagePolicy, USAGE_POLICY_KEYS);
  if (
    usagePolicy.retention !== "not_declared" ||
    usagePolicy.local_processing !== "transient_only" ||
    usagePolicy.model_use !== "prohibited_pending_authorization" ||
    usagePolicy.export !== "prohibited_pending_authorization"
  ) {
    invalidResponse();
  }
  const profileRevision = revision(raw.revision);
  const connectionRevision = revision(raw.connection_revision);
  const credentialRevision = revision(raw.credential_revision);
  if (
    connectionRevision > profileRevision ||
    credentialRevision > connectionRevision ||
    !Array.isArray(raw.capabilities)
  ) {
    invalidResponse();
  }
  const capabilities = raw.capabilities.map((value) => {
    const capability = record(value);
    exactKeys(capability, CAPABILITY_KEYS);
    return {
      capability: member(capability.capability, CAPABILITIES),
      enabled: bool(capability.enabled),
    };
  });
  if (
    capabilities.length !== CAPABILITIES.length ||
    new Set(capabilities.map(({ capability }) => capability)).size !==
      CAPABILITIES.length ||
    CAPABILITIES.some(
      (expected) =>
        !capabilities.some(({ capability }) => capability === expected),
    )
  ) {
    invalidResponse();
  }
  const connectionTest = parseConnectionTest(raw.connection_test);
  const status = member(raw.status, STATUSES);

  if (
    (status === "ready" &&
      (!enabled ||
        !credentialConfigured ||
        connectionTest?.status !== "passed")) ||
    (status === "not_configured" &&
      (enabled || credentialConfigured || connectionTest !== null)) ||
    (status === "configured_unverified" &&
      (!credentialConfigured || connectionTest !== null)) ||
    (status === "authentication_failed" &&
      (connectionTest?.status !== "failed" ||
        (connectionTest.error_code !== "authentication_failed" &&
          connectionTest.error_code !== "credential_unavailable"))) ||
    (status === "license_restricted" &&
      (connectionTest?.status !== "failed" ||
        connectionTest.error_code !== "license_restricted")) ||
    (status === "temporarily_unavailable" &&
      connectionTest?.status === "passed")
  ) {
    invalidResponse();
  }

  return {
    id: raw.id,
    provider,
    endpoint_set_id: endpointSetId,
    enabled,
    credential_configured: credentialConfigured,
    usage_policy: {
      retention: "not_declared",
      local_processing: "transient_only",
      model_use: "prohibited_pending_authorization",
      export: "prohibited_pending_authorization",
    },
    capabilities,
    revision: profileRevision,
    connection_revision: connectionRevision,
    credential_revision: credentialRevision,
    connection_test: connectionTest,
    status,
  };
}

export function parseVeraLegalSourceProvidersResponse(
  value: unknown,
): VeraLegalSourceProvidersResponse {
  const raw = record(value);
  exactKeys(raw, ["schema_version", "providers"]);
  if (
    raw.schema_version !== VERA_LEGAL_PROVIDER_SCHEMA_VERSION ||
    !Array.isArray(raw.providers) ||
    raw.providers.length > 1
  ) {
    invalidResponse();
  }
  return {
    schema_version: VERA_LEGAL_PROVIDER_SCHEMA_VERSION,
    providers: raw.providers.map(parseVeraLegalSourceProvider),
  };
}

export function parseVeraLegalSourceProviderResponse(
  value: unknown,
): VeraLegalSourceProviderResponse {
  const raw = record(value);
  exactKeys(raw, ["schema_version", "profile"]);
  if (raw.schema_version !== VERA_LEGAL_PROVIDER_SCHEMA_VERSION) {
    invalidResponse();
  }
  return {
    schema_version: VERA_LEGAL_PROVIDER_SCHEMA_VERSION,
    profile: parseVeraLegalSourceProvider(raw.profile),
  };
}

async function profileMutation(
  path: string,
  options: Parameters<typeof veraApiRequest>[1],
): Promise<VeraLegalSourceProvider> {
  return parseVeraLegalSourceProviderResponse(
    await veraApiRequest<unknown>(path, options),
  ).profile;
}

export async function listVeraLegalSourceProviders(): Promise<VeraLegalSourceProvidersResponse> {
  return parseVeraLegalSourceProvidersResponse(
    await veraApiRequest<unknown>("/legal-providers"),
  );
}

export async function createVeraLegalSourceProvider(): Promise<VeraLegalSourceProvider> {
  return profileMutation("/legal-providers/yuandian", {
    method: "POST",
    json: {},
  });
}

export async function saveVeraLegalSourceSecret(
  id: string,
  expectedRevision: number,
  secret: string,
): Promise<VeraLegalSourceProvider> {
  return profileMutation(
    `/legal-providers/${encodeURIComponent(id)}/credential`,
    {
      method: "PUT",
      json: { expected_revision: expectedRevision, secret },
    },
  );
}

export async function removeVeraLegalSourceSecret(
  id: string,
  expectedRevision: number,
): Promise<VeraLegalSourceProvider> {
  return profileMutation(
    `/legal-providers/${encodeURIComponent(id)}/credential`,
    {
      method: "DELETE",
      json: { expected_revision: expectedRevision },
    },
  );
}

export async function testVeraLegalSourceProvider(
  id: string,
  expectedRevision: number,
): Promise<VeraLegalSourceProvider> {
  return profileMutation(`/legal-providers/${encodeURIComponent(id)}/test`, {
    method: "POST",
    json: { expected_revision: expectedRevision },
  });
}

export async function enableVeraLegalSourceProvider(
  id: string,
  expectedRevision: number,
): Promise<VeraLegalSourceProvider> {
  return profileMutation(`/legal-providers/${encodeURIComponent(id)}/enable`, {
    method: "POST",
    json: { expected_revision: expectedRevision },
  });
}

export async function disableVeraLegalSourceProvider(
  id: string,
  expectedRevision: number,
): Promise<VeraLegalSourceProvider> {
  return profileMutation(`/legal-providers/${encodeURIComponent(id)}/disable`, {
    method: "POST",
    json: { expected_revision: expectedRevision },
  });
}
