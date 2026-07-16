import { WorkspaceApiError } from "../errors";

export const LEGAL_PROVIDER_CREDENTIAL_REFERENCE_PATTERN =
  /^keychain:\/\/vera\/legal-provider\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([a-z0-9]{16,128})$/;

export const YUANDIAN_OFFICIAL_MCP_ENDPOINT_SET_ID =
  "yuandian-official-mcp-v1" as const;

export type LegalProviderCredentialBinding = Readonly<{
  profileId: string;
  provider: "yuandian";
  endpointSetId: typeof YUANDIAN_OFFICIAL_MCP_ENDPOINT_SET_ID;
}>;

export type LegalProviderCredentialInput = Readonly<{
  reference: string;
  binding: LegalProviderCredentialBinding;
}>;

export interface LegalProviderCredentialStorePort {
  isAvailable(): boolean;
  storeLegalProviderCredential(
    input: LegalProviderCredentialInput & { secret: string },
  ): Promise<void>;
  resolveLegalProviderCredential(
    input: LegalProviderCredentialInput,
  ): Promise<string>;
  deleteLegalProviderCredential(
    input: LegalProviderCredentialInput,
  ): Promise<void>;
}

export function buildLegalProviderCredentialReference(
  profileId: string,
  locatorId: string,
) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      profileId,
    )
  ) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Legal provider credential reference is invalid.",
    );
  }
  if (!/^[a-z0-9]{16,128}$/.test(locatorId)) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      "Legal provider credential reference is invalid.",
    );
  }
  return `keychain://vera/legal-provider/${profileId.toLowerCase()}/${locatorId.toLowerCase()}`;
}

export function parseLegalProviderCredentialReference(
  value: unknown,
  expectedProfileId?: string,
) {
  if (typeof value !== "string") return null;
  const match = value.match(LEGAL_PROVIDER_CREDENTIAL_REFERENCE_PATTERN);
  if (!match) return null;
  const profileId = match[1]!.toLowerCase();
  if (
    expectedProfileId !== undefined &&
    profileId !== expectedProfileId.toLowerCase()
  ) {
    return null;
  }
  return { profileId, locatorId: match[2]!.toLowerCase() };
}

export function redactLegalProviderCredentialReference(value: unknown) {
  const parsed = parseLegalProviderCredentialReference(value);
  return parsed
    ? `keychain://vera/legal-provider/${parsed.profileId}/[redacted]`
    : "[redacted]";
}
