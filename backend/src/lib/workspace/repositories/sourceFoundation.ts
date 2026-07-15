import { createHash } from "node:crypto";
import { z } from "zod";

import type { WorkspaceDatabaseAdapter } from "../migrations";
import {
  CreateProjectSourceSnapshotV11Schema,
  CreateSourceCitationAnchorV11Schema,
  ProjectSourceKindV11Schema,
  ProjectSourceSnapshotV11Schema,
  SourceCitationAnchorV11Schema,
  type CreateProjectSourceSnapshotV11,
  type CreateSourceCitationAnchorV11,
  type ProjectSourceKindV11,
  type ProjectSourceSnapshotV11,
  type SourceCitationAnchorV11,
} from "../sourceFoundationContractsV11";

type Row = Record<string, unknown>;

const SNAPSHOT_COLUMNS = `
  id,
  project_id,
  source_kind,
  source_record_id,
  source_version_id,
  title_snapshot,
  content_sha256,
  locator_json,
  retrieved_at,
  license_json,
  retention_policy,
  retention_expires_at,
  retrieval_metadata_json,
  created_at
`;

const ANCHOR_COLUMNS = `
  id,
  project_id,
  snapshot_id,
  ordinal,
  exact_quote,
  quote_sha256,
  locator_json,
  created_at
`;

export class WorkspaceSourceFoundationRepositoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceSourceFoundationRepositoryError";
  }
}

function repositoryError(message: string, cause?: unknown): never {
  throw new WorkspaceSourceFoundationRepositoryError(
    message,
    cause instanceof Error ? { cause } : undefined,
  );
}

function parseJsonObject(value: unknown, label: string) {
  if (typeof value !== "string") {
    repositoryError(`Persisted ${label} must be JSON text.`);
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      repositoryError(`Persisted ${label} must be a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof WorkspaceSourceFoundationRepositoryError) throw error;
    repositoryError(`Persisted ${label} is invalid JSON.`, error);
  }
}

function parseSnapshotRow(row: Row): ProjectSourceSnapshotV11 {
  try {
    return ProjectSourceSnapshotV11Schema.parse({
      id: row.id,
      projectId: row.project_id,
      sourceKind: row.source_kind,
      sourceRecordId: row.source_record_id,
      sourceVersionId: row.source_version_id,
      titleSnapshot: row.title_snapshot,
      contentSha256: row.content_sha256,
      locator: parseJsonObject(row.locator_json, "source locator"),
      retrievedAt: row.retrieved_at,
      license: parseJsonObject(row.license_json, "source license policy"),
      retentionPolicy: row.retention_policy,
      retentionExpiresAt: row.retention_expires_at,
      retrievalMetadata: parseJsonObject(
        row.retrieval_metadata_json,
        "source retrieval metadata",
      ),
      createdAt: row.created_at,
    });
  } catch (error) {
    if (error instanceof WorkspaceSourceFoundationRepositoryError) throw error;
    repositoryError("Persisted Project source snapshot is invalid.", error);
  }
}

export function sourceCitationQuoteSha256V11(exactQuote: string): string {
  return createHash("sha256").update(exactQuote, "utf8").digest("hex");
}

function parseAnchorRow(row: Row): SourceCitationAnchorV11 {
  try {
    const anchor = SourceCitationAnchorV11Schema.parse({
      id: row.id,
      projectId: row.project_id,
      snapshotId: row.snapshot_id,
      ordinal: Number(row.ordinal),
      exactQuote: row.exact_quote,
      quoteSha256: row.quote_sha256,
      locator: parseJsonObject(row.locator_json, "citation locator"),
      createdAt: row.created_at,
    });
    if (
      sourceCitationQuoteSha256V11(anchor.exactQuote) !== anchor.quoteSha256
    ) {
      repositoryError(
        "Persisted citation quote no longer matches its immutable SHA-256 hash.",
      );
    }
    return anchor;
  } catch (error) {
    if (error instanceof WorkspaceSourceFoundationRepositoryError) throw error;
    repositoryError("Persisted source citation anchor is invalid.", error);
  }
}

function parseLimit(value: number | undefined) {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    repositoryError("Source list limit must be an integer between 1 and 200.");
  }
  return limit;
}

function stringifyObject(value: Record<string, unknown>) {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== "string") {
    repositoryError("Source metadata could not be encoded as JSON.");
  }
  return encoded;
}

/**
 * The repository exposes create/read operations only. SQL DELETE remains a
 * deliberate retention/project-lifecycle operation and cascades a snapshot's
 * anchors; ordinary product code cannot mutate immutable provenance through
 * this repository.
 */
export class WorkspaceSourceFoundationRepository {
  constructor(private readonly database: WorkspaceDatabaseAdapter) {}

  createSnapshot(
    input: CreateProjectSourceSnapshotV11,
  ): ProjectSourceSnapshotV11 {
    let snapshot: ProjectSourceSnapshotV11;
    try {
      snapshot = CreateProjectSourceSnapshotV11Schema.parse(input);
    } catch (error) {
      repositoryError("Project source snapshot input is invalid.", error);
    }
    try {
      this.database
        .prepare(
          `INSERT INTO project_source_snapshots (
             id,
             project_id,
             source_kind,
             source_record_id,
             source_version_id,
             title_snapshot,
             content_sha256,
             locator_json,
             retrieved_at,
             license_json,
             retention_policy,
             retention_expires_at,
             retrieval_metadata_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.id,
          snapshot.projectId,
          snapshot.sourceKind,
          snapshot.sourceRecordId,
          snapshot.sourceVersionId,
          snapshot.titleSnapshot,
          snapshot.contentSha256,
          stringifyObject(snapshot.locator),
          snapshot.retrievedAt,
          stringifyObject(snapshot.license),
          snapshot.retentionPolicy,
          snapshot.retentionExpiresAt,
          stringifyObject(snapshot.retrievalMetadata),
          snapshot.createdAt,
        );
    } catch (error) {
      repositoryError("Project source snapshot could not be persisted.", error);
    }
    const persisted = this.getSnapshot(snapshot.projectId, snapshot.id);
    if (!persisted) {
      repositoryError("Project source snapshot disappeared after insertion.");
    }
    return persisted;
  }

  getSnapshot(
    projectId: string,
    snapshotId: string,
  ): ProjectSourceSnapshotV11 | null {
    const identifiers = z
      .object({ projectId: z.string().uuid(), snapshotId: z.string().uuid() })
      .strict()
      .safeParse({ projectId, snapshotId });
    if (!identifiers.success) {
      repositoryError("Project source snapshot identifiers are invalid.");
    }
    const row = this.database
      .prepare(
        `SELECT ${SNAPSHOT_COLUMNS}
           FROM project_source_snapshots
          WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, snapshotId);
    return row ? parseSnapshotRow(row) : null;
  }

  listSnapshots(input: {
    projectId: string;
    sourceKind?: ProjectSourceKindV11;
    limit?: number;
  }): ProjectSourceSnapshotV11[] {
    const project = z.string().uuid().safeParse(input.projectId);
    if (!project.success) repositoryError("Project id is invalid.");
    const sourceKind =
      input.sourceKind === undefined
        ? null
        : ProjectSourceKindV11Schema.parse(input.sourceKind);
    const limit = parseLimit(input.limit);
    const rows = sourceKind
      ? this.database
          .prepare(
            `SELECT ${SNAPSHOT_COLUMNS}
               FROM project_source_snapshots
              WHERE project_id = ? AND source_kind = ?
              ORDER BY retrieved_at DESC, id ASC
              LIMIT ?`,
          )
          .all(input.projectId, sourceKind, limit)
      : this.database
          .prepare(
            `SELECT ${SNAPSHOT_COLUMNS}
               FROM project_source_snapshots
              WHERE project_id = ?
              ORDER BY retrieved_at DESC, id ASC
              LIMIT ?`,
          )
          .all(input.projectId, limit);
    return rows.map(parseSnapshotRow);
  }

  createCitationAnchor(
    input: CreateSourceCitationAnchorV11,
  ): SourceCitationAnchorV11 {
    let anchor: z.output<typeof CreateSourceCitationAnchorV11Schema>;
    try {
      anchor = CreateSourceCitationAnchorV11Schema.parse(input);
    } catch (error) {
      repositoryError("Source citation anchor input is invalid.", error);
    }
    const quoteSha256 = sourceCitationQuoteSha256V11(anchor.exactQuote);
    try {
      this.database
        .prepare(
          `INSERT INTO source_citation_anchors (
             id,
             project_id,
             snapshot_id,
             ordinal,
             exact_quote,
             quote_sha256,
             locator_json,
             created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          anchor.id,
          anchor.projectId,
          anchor.snapshotId,
          anchor.ordinal,
          anchor.exactQuote,
          quoteSha256,
          stringifyObject(anchor.locator),
          anchor.createdAt,
        );
    } catch (error) {
      repositoryError("Source citation anchor could not be persisted.", error);
    }
    const persisted = this.getCitationAnchor(
      anchor.projectId,
      anchor.id,
    );
    if (!persisted) {
      repositoryError("Source citation anchor disappeared after insertion.");
    }
    return persisted;
  }

  getCitationAnchor(
    projectId: string,
    anchorId: string,
  ): SourceCitationAnchorV11 | null {
    const identifiers = z
      .object({ projectId: z.string().uuid(), anchorId: z.string().uuid() })
      .strict()
      .safeParse({ projectId, anchorId });
    if (!identifiers.success) {
      repositoryError("Source citation anchor identifiers are invalid.");
    }
    const row = this.database
      .prepare(
        `SELECT ${ANCHOR_COLUMNS}
           FROM source_citation_anchors
          WHERE project_id = ? AND id = ?`,
      )
      .get(projectId, anchorId);
    return row ? parseAnchorRow(row) : null;
  }

  listCitationAnchors(input: {
    projectId: string;
    snapshotId: string;
    limit?: number;
  }): SourceCitationAnchorV11[] {
    const identifiers = z
      .object({
        projectId: z.string().uuid(),
        snapshotId: z.string().uuid(),
      })
      .strict()
      .safeParse({
        projectId: input.projectId,
        snapshotId: input.snapshotId,
      });
    if (!identifiers.success) {
      repositoryError("Source citation anchor scope is invalid.");
    }
    const rows = this.database
      .prepare(
        `SELECT ${ANCHOR_COLUMNS}
           FROM source_citation_anchors
          WHERE project_id = ? AND snapshot_id = ?
          ORDER BY ordinal ASC, id ASC
          LIMIT ?`,
      )
      .all(input.projectId, input.snapshotId, parseLimit(input.limit));
    return rows.map(parseAnchorRow);
  }
}
