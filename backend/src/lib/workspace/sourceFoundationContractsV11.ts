import { z } from "zod";

import {
  BLOCKED_STRUCTURED_KEYS_V1,
  IsoDateTimeSchema,
  UnicodeCodePointStringSchemaV1,
  WorkspaceIdSchema,
} from "./workspacePersistencePrimitivesV1";

export const PROJECT_SOURCE_KINDS_V11 = [
  "project_document",
  "legal_authority",
] as const;
export const SOURCE_RETENTION_POLICIES_V11 = [
  "not_declared",
  "no_retention",
  "metadata_only",
  "full_text_ttl",
  "full_text_permitted",
] as const;

export const ProjectSourceKindV11Schema = z.enum(PROJECT_SOURCE_KINDS_V11);
export const SourceRetentionPolicyV11Schema = z.enum(
  SOURCE_RETENTION_POLICIES_V11,
);

const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_NODES = 512;
const MAX_METADATA_KEYS = 128;
const MAX_METADATA_ARRAY_ITEMS = 100;
const MAX_METADATA_KEY_LENGTH = 120;
const MAX_METADATA_STRING_LENGTH = 4_000;
const SENSITIVE_METADATA_VALUE =
  /(?:\bbearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}\b|(?:api[_-]?key|token|secret|credential|password)=[^&\s]+|(?:https?|wss?):\/\/[^/\s:@]+:[^@\s/]+@|(?:^|[\s=:'"(])(?:file:|[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|private|etc|opt|mnt|Volumes)(?:\/|$)))/i;

type ValidationContext = z.RefinementCtx;

function validateTransportSafeValue(
  value: unknown,
  context: ValidationContext,
  path: (string | number)[],
  depth: number,
  state: { nodes: number },
): void {
  state.nodes += 1;
  if (state.nodes > MAX_METADATA_NODES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "metadata contains too many values",
    });
    return;
  }
  if (depth > MAX_METADATA_DEPTH) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "metadata nesting is too deep",
    });
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: "metadata numbers must be finite",
      });
    }
    return;
  }
  if (typeof value === "string") {
    if (
      value.length > MAX_METADATA_STRING_LENGTH ||
      value.includes("\0") ||
      SENSITIVE_METADATA_VALUE.test(value)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message:
          "metadata strings must be bounded and must not contain secrets or filesystem paths",
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_METADATA_ARRAY_ITEMS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path,
        message: "metadata arrays contain too many values",
      });
      return;
    }
    value.forEach((child, index) =>
      validateTransportSafeValue(
        child,
        context,
        [...path, index],
        depth + 1,
        state,
      ),
    );
    return;
  }
  if (typeof value !== "object" || value === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "metadata must contain JSON values only",
    });
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "metadata objects must be plain objects",
    });
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_METADATA_KEYS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: "metadata objects contain too many keys",
    });
    return;
  }
  for (const [key, child] of entries) {
    const childPath = [...path, key];
    if (
      key.length < 1 ||
      key.length > MAX_METADATA_KEY_LENGTH ||
      key.includes("\0") ||
      BLOCKED_STRUCTURED_KEYS_V1.test(key)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: childPath,
        message: "unsafe metadata key is not allowed",
      });
      continue;
    }
    validateTransportSafeValue(
      child,
      context,
      childPath,
      depth + 1,
      state,
    );
  }
}

export const TransportSafeSourceMetadataV11Schema = z
  .record(z.unknown())
  .superRefine((value, context) => {
    validateTransportSafeValue(value, context, [], 0, { nodes: 0 });
  });

export const SourceDataUsePolicyV11Schema = z
  .object({
    basis: z.enum([
      "not_declared",
      "deployment_contract",
      "user_provided",
    ]),
    retention: SourceRetentionPolicyV11Schema,
    export: z.enum([
      "not_declared",
      "prohibited",
      "exact_quotes_only",
      "reviewed_work_product",
      "permitted",
    ]),
    modelUse: z.enum([
      "not_declared",
      "prohibited",
      "local_only",
      "permitted",
    ]),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.basis === "not_declared" &&
      (value.retention !== "not_declared" ||
        value.export !== "not_declared" ||
        value.modelUse !== "not_declared")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["basis"],
        message:
          "an undeclared authorization basis cannot grant retention, export, or model-use rights",
      });
    }
  });

/**
 * The database stores a bare lower-case SHA-256 hex string. Existing legal
 * adapters may supply the explicit `sha256:<hex>` form; parsing canonicalizes
 * both accepted wire forms to the one persisted representation.
 */
export const CanonicalSourceSha256V11Schema = z
  .string()
  .regex(/^(?:sha256:)?[a-f0-9]{64}$/)
  .transform((value) =>
    value.startsWith("sha256:") ? value.slice("sha256:".length) : value,
  );

const SourceRecordIdSchema = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: 500,
  trimForMin: true,
});
const SourceTitleSchema = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: 500,
  trimForMin: true,
});
const ExactQuoteSchema = UnicodeCodePointStringSchemaV1({
  min: 1,
  max: 8_000,
  trimForMin: true,
});

export const CreateProjectSourceSnapshotV11Schema = z
  .object({
    id: WorkspaceIdSchema,
    projectId: WorkspaceIdSchema,
    sourceKind: ProjectSourceKindV11Schema,
    sourceRecordId: SourceRecordIdSchema,
    sourceVersionId: SourceRecordIdSchema.nullable(),
    titleSnapshot: SourceTitleSchema,
    contentSha256: CanonicalSourceSha256V11Schema,
    locator: TransportSafeSourceMetadataV11Schema,
    retrievedAt: IsoDateTimeSchema,
    license: SourceDataUsePolicyV11Schema,
    retentionPolicy: SourceRetentionPolicyV11Schema,
    retentionExpiresAt: IsoDateTimeSchema.nullable(),
    retrievalMetadata: TransportSafeSourceMetadataV11Schema,
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.sourceKind === "project_document" &&
      value.sourceVersionId === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sourceVersionId"],
        message: "Project document snapshots require a document version id",
      });
    }
    if (value.license.retention !== value.retentionPolicy) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retentionPolicy"],
        message: "retentionPolicy must match license.retention",
      });
    }
    const ttl = value.retentionPolicy === "full_text_ttl";
    if (ttl !== (value.retentionExpiresAt !== null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retentionExpiresAt"],
        message:
          "full_text_ttl requires an expiry and other policies must not carry one",
      });
    }
    if (
      value.retentionExpiresAt !== null &&
      Date.parse(value.retentionExpiresAt) <= Date.parse(value.retrievedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retentionExpiresAt"],
        message: "retention expiry must be later than retrieval time",
      });
    }
  });

export const ProjectSourceSnapshotV11Schema =
  CreateProjectSourceSnapshotV11Schema;

export const CreateSourceCitationAnchorV11Schema = z
  .object({
    id: WorkspaceIdSchema,
    projectId: WorkspaceIdSchema,
    snapshotId: WorkspaceIdSchema,
    ordinal: z.number().int().nonnegative(),
    exactQuote: ExactQuoteSchema,
    locator: TransportSafeSourceMetadataV11Schema,
    createdAt: IsoDateTimeSchema,
  })
  .strict();

export const SourceCitationAnchorV11Schema =
  CreateSourceCitationAnchorV11Schema.extend({
    quoteSha256: CanonicalSourceSha256V11Schema,
  }).strict();

export type ProjectSourceKindV11 = z.infer<
  typeof ProjectSourceKindV11Schema
>;
export type SourceRetentionPolicyV11 = z.infer<
  typeof SourceRetentionPolicyV11Schema
>;
export type SourceDataUsePolicyV11 = z.infer<
  typeof SourceDataUsePolicyV11Schema
>;
export type CreateProjectSourceSnapshotV11 = z.input<
  typeof CreateProjectSourceSnapshotV11Schema
>;
export type ProjectSourceSnapshotV11 = z.output<
  typeof ProjectSourceSnapshotV11Schema
>;
export type CreateSourceCitationAnchorV11 = z.input<
  typeof CreateSourceCitationAnchorV11Schema
>;
export type SourceCitationAnchorV11 = z.output<
  typeof SourceCitationAnchorV11Schema
>;
