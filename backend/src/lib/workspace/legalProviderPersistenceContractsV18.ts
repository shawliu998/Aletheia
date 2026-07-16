import { z } from "zod";

import {
  IsoDateTimeSchema,
  WorkspaceIdSchema,
} from "./workspacePersistencePrimitivesV1";

export const LEGAL_PROVIDER_IDS_V18 = ["yuandian"] as const;
export const LEGAL_PROVIDER_ENDPOINT_SET_IDS_V18 = [
  "yuandian-official-mcp-v1",
] as const;
export const LEGAL_PROVIDER_CAPABILITIES_V18 = [
  "law",
  "case",
  "company",
] as const;
export const LEGAL_PROVIDER_CONNECTION_TEST_STATUSES_V18 = [
  "passed",
  "failed",
] as const;
export const LEGAL_PROVIDER_CONNECTION_ERROR_CODES_V18 = [
  "authentication_failed",
  "license_restricted",
  "credential_unavailable",
  "timeout",
  "temporarily_unavailable",
  "transport_error",
  "protocol_invalid",
  "response_invalid",
] as const;
export const LEGAL_PROVIDER_CREDENTIAL_ORPHAN_REASONS_V18 = [
  "profile_write_failed",
  "credential_rotated",
  "profile_deleted",
  "credential_reconfiguration",
] as const;

export const LegalProviderIdV18Schema = z.enum(LEGAL_PROVIDER_IDS_V18);
export const LegalProviderEndpointSetIdV18Schema = z.enum(
  LEGAL_PROVIDER_ENDPOINT_SET_IDS_V18,
);
export const LegalProviderCapabilityV18Schema = z.enum(
  LEGAL_PROVIDER_CAPABILITIES_V18,
);
export const LegalProviderConnectionTestStatusV18Schema = z.enum(
  LEGAL_PROVIDER_CONNECTION_TEST_STATUSES_V18,
);
export const LegalProviderConnectionErrorCodeV18Schema = z.enum(
  LEGAL_PROVIDER_CONNECTION_ERROR_CODES_V18,
);
export const LegalProviderCredentialOrphanReasonV18Schema = z.enum(
  LEGAL_PROVIDER_CREDENTIAL_ORPHAN_REASONS_V18,
);

export const LegalProviderProfileIdV18Schema = WorkspaceIdSchema.regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
export const LegalProviderTimestampV18Schema = IsoDateTimeSchema.regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
);

export const LegalProviderCredentialReferenceV18Schema = z
  .string()
  .regex(
    /^keychain:\/\/vera\/legal-provider\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([a-z0-9]{16,128})$/,
  );

export function legalProviderCredentialReferenceProfileIdV18(
  reference: string,
): string | null {
  const parsed = LegalProviderCredentialReferenceV18Schema.safeParse(reference);
  if (!parsed.success) return null;
  return parsed.data.split("/")[4] ?? null;
}

const RevisionSchema = z.number().int().min(0).max(2_147_483_647);

export const LegalProviderCapabilityRecordV18Schema = z
  .object({
    profileId: LegalProviderProfileIdV18Schema,
    capability: LegalProviderCapabilityV18Schema,
    enabled: z.boolean(),
    connectionRevision: RevisionSchema,
    createdAt: LegalProviderTimestampV18Schema,
    updatedAt: LegalProviderTimestampV18Schema,
  })
  .strict();

export const LegalProviderProfileV18Schema = z
  .object({
    id: LegalProviderProfileIdV18Schema,
    provider: LegalProviderIdV18Schema,
    endpointSetId: LegalProviderEndpointSetIdV18Schema,
    enabled: z.boolean(),
    credentialReference: LegalProviderCredentialReferenceV18Schema.nullable(),
    revision: RevisionSchema,
    connectionRevision: RevisionSchema,
    credentialRevision: RevisionSchema,
    createdAt: LegalProviderTimestampV18Schema,
    updatedAt: LegalProviderTimestampV18Schema,
    capabilities: z
      .array(LegalProviderCapabilityRecordV18Schema)
      .length(LEGAL_PROVIDER_CAPABILITIES_V18.length),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.credentialReference !== null &&
      legalProviderCredentialReferenceProfileIdV18(
        value.credentialReference,
      ) !== value.id
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credentialReference"],
        message: "credential reference is not bound to its provider profile",
      });
    }
    const names = value.capabilities.map((item) => item.capability).sort();
    const expected = [...LEGAL_PROVIDER_CAPABILITIES_V18].sort();
    if (
      names.some((name, index) => name !== expected[index]) ||
      value.capabilities.some((item) => item.profileId !== value.id)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "provider capability set is incomplete or misbound",
      });
    }
    if (
      value.capabilities.some(
        (item) => item.connectionRevision !== value.connectionRevision,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["capabilities"],
        message: "provider capabilities are stale for the connection revision",
      });
    }
  });

export const LegalProviderConnectionTestV18Schema = z
  .object({
    profileId: LegalProviderProfileIdV18Schema,
    connectionRevision: RevisionSchema,
    status: LegalProviderConnectionTestStatusV18Schema,
    errorCode: LegalProviderConnectionErrorCodeV18Schema.nullable(),
    retryable: z.boolean(),
    latencyMs: z.number().int().min(0).max(600_000).nullable(),
    testedAt: LegalProviderTimestampV18Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.status === "passed" &&
        (value.errorCode !== null || value.retryable)) ||
      (value.status === "failed" && value.errorCode === null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: "connection test result is internally inconsistent",
      });
    }
  });

export const LegalProviderCredentialOrphanCleanupV18Schema = z
  .object({
    reference: LegalProviderCredentialReferenceV18Schema,
    profileId: LegalProviderProfileIdV18Schema,
    provider: LegalProviderIdV18Schema,
    endpointSetId: LegalProviderEndpointSetIdV18Schema,
    reason: LegalProviderCredentialOrphanReasonV18Schema,
    attemptCount: RevisionSchema,
    lastErrorCode: z
      .string()
      .regex(/^[a-z0-9_]{1,120}$/)
      .nullable(),
    createdAt: LegalProviderTimestampV18Schema,
    updatedAt: LegalProviderTimestampV18Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      legalProviderCredentialReferenceProfileIdV18(value.reference) !==
      value.profileId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reference"],
        message: "credential cleanup reference is not bound to its profile",
      });
    }
  });

export type LegalProviderIdV18 = z.infer<typeof LegalProviderIdV18Schema>;
export type LegalProviderEndpointSetIdV18 = z.infer<
  typeof LegalProviderEndpointSetIdV18Schema
>;
export type LegalProviderCapabilityV18 = z.infer<
  typeof LegalProviderCapabilityV18Schema
>;
export type LegalProviderProfileV18 = z.infer<
  typeof LegalProviderProfileV18Schema
>;
export type LegalProviderConnectionTestV18 = z.infer<
  typeof LegalProviderConnectionTestV18Schema
>;
export type LegalProviderCredentialOrphanCleanupV18 = z.infer<
  typeof LegalProviderCredentialOrphanCleanupV18Schema
>;
