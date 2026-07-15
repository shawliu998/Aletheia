import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import {
  assertDocumentChunkMetadataPageBinding,
  parseDocumentChunkMetadataJson,
  type DocumentChunkMetadata,
} from "../documentChunkMetadata";
import { WorkspaceApiError } from "../errors";
import type { WorkspaceDatabaseAdapter } from "../migrations";
import {
  ProjectSourceKindV11Schema,
  SourceDataUsePolicyV11Schema,
  TransportSafeSourceMetadataV11Schema,
  type ProjectSourceKindV11,
  type ProjectSourceSnapshotV11,
  type SourceCitationAnchorV11,
} from "../sourceFoundationContractsV11";
import type { WorkspaceSourceFoundationRepository } from "../repositories/sourceFoundation";

const Id = z.string().uuid();
const IsoDateTime = z.string().datetime({ offset: true });
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_PAGE_SIZE = 100;
const MAX_ANCHORS_PER_SOURCE = 200;
const MAX_OCR_BLOCKS_IN_LOCATOR = 32;

const CursorPayload = z
  .object({
    retrievedAt: IsoDateTime,
    id: Id,
  })
  .strict();

export type ProjectSourcePage = {
  sources: ProjectSourceSnapshotV11[];
  nextCursor: string | null;
};

export type CaptureProjectDocumentSourceResult = {
  snapshot: ProjectSourceSnapshotV11;
  reused: boolean;
};

export type ProjectSourceDetail = {
  snapshot: ProjectSourceSnapshotV11;
  anchors: SourceCitationAnchorV11[];
};

export type CreateProjectDocumentAnchorInput = {
  projectId: string;
  snapshotId: string;
  chunkId: string;
  exactQuote: string;
  startOffset: number | null;
  endOffset: number | null;
};

/**
 * Trusted integration seam for a future authorized legal provider. It is not
 * exposed by the Project sources HTTP router: callers must provide the full,
 * explicit data-use policy and already-redacted provider metadata.
 */
export type CaptureLegalAuthoritySnapshotInput = {
  projectId: string;
  sourceRecordId: string;
  sourceVersionId: string | null;
  titleSnapshot: string;
  contentSha256: string;
  locator: Record<string, unknown>;
  retrievedAt: string;
  policy: z.input<typeof SourceDataUsePolicyV11Schema>;
  retentionExpiresAt: string | null;
  retrievalMetadata: Record<string, unknown>;
};

function notFound(message = "Source not found."): never {
  throw new WorkspaceApiError(404, "NOT_FOUND", message);
}

function invalid(message: string): never {
  throw new WorkspaceApiError(422, "VALIDATION_ERROR", message);
}

function conflict(message: string): never {
  throw new WorkspaceApiError(409, "CONFLICT", message);
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      `Persisted ${label} is invalid.`,
    );
  }
  return value;
}

function asNonnegativeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new WorkspaceApiError(
      500,
      "INTERNAL_ERROR",
      `Persisted ${label} is invalid.`,
    );
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function encodeCursor(snapshot: ProjectSourceSnapshotV11): string {
  return Buffer.from(
    JSON.stringify({ retrievedAt: snapshot.retrievedAt, id: snapshot.id }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(value: string | undefined) {
  if (value === undefined) return null;
  if (
    value.length < 1 ||
    value.length > 512 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    invalid("Source cursor is invalid.");
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") > 1_024) {
      invalid("Source cursor is invalid.");
    }
    return CursorPayload.parse(JSON.parse(decoded) as unknown);
  } catch (error) {
    if (error instanceof WorkspaceApiError) throw error;
    invalid("Source cursor is invalid.");
  }
}

function safeOcrProjection(
  metadataJson: unknown,
  pageStart: number | null,
  pageEnd: number | null,
  chunkText: string,
  quoteStart: number,
  quoteEnd: number,
): Record<string, unknown> | null {
  let metadata: DocumentChunkMetadata;
  try {
    metadata = parseDocumentChunkMetadataJson(metadataJson);
    assertDocumentChunkMetadataPageBinding(
      metadata,
      pageStart,
      pageEnd,
      chunkText,
    );
  } catch {
    conflict("Document chunk OCR metadata failed integrity validation.");
  }
  if (!("schemaVersion" in metadata)) return null;
  const quotePageStart = metadata.chunkPageTextStart + quoteStart;
  const quotePageEnd = metadata.chunkPageTextStart + quoteEnd;
  // The synthetic `[Page n]` marker precedes page text in the first OCR
  // chunk. Never label marker offsets as page-text coordinates.
  if (quotePageStart < 0 || quotePageEnd <= quotePageStart) return null;
  const matchingBlocks = metadata.blocks.filter(
    (block) => block.textEnd > quotePageStart && block.textStart < quotePageEnd,
  );
  const blocks = matchingBlocks.slice(0, MAX_OCR_BLOCKS_IN_LOCATOR);
  return {
    schemaVersion: metadata.schemaVersion,
    engine: metadata.engine,
    coordinateSpace: metadata.coordinateSpace,
    page: metadata.page,
    chunkPageTextStart: metadata.chunkPageTextStart,
    quotePageStart,
    quotePageEnd,
    pageConfidence: metadata.pageConfidence,
    lowConfidence: metadata.lowConfidence,
    offsetScope: "page_text",
    offsetUnit: "utf16_code_unit",
    blocks,
    blocksTruncated: blocks.length !== matchingBlocks.length,
  };
}

function findOccurrences(text: string, quote: string): number[] {
  const offsets: number[] = [];
  let from = 0;
  while (from <= text.length - quote.length) {
    const match = text.indexOf(quote, from);
    if (match < 0) break;
    offsets.push(match);
    if (offsets.length > 1) break;
    // Advance by one UTF-16 code unit so overlapping matches are also
    // detected (for example, `aa` occurs twice in `aaa`). Automatic anchor
    // resolution must fail closed whenever a quote is not unique; callers can
    // still disambiguate with explicit, slice-verified offsets.
    from = match + 1;
  }
  return offsets;
}

/**
 * Application service for the v11 immutable provenance foundation. It derives
 * every public-write policy, hash, locator, and ordinal on the server.
 */
export class WorkspaceProjectSourcesService {
  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly sources: WorkspaceSourceFoundationRepository,
    private readonly options: {
      now?: () => string;
      nextId?: () => string;
    } = {},
  ) {}

  captureProjectDocumentSnapshot(input: {
    projectId: string;
    documentId: string;
    versionId?: string;
  }): CaptureProjectDocumentSourceResult {
    const parsed = z
      .object({ projectId: Id, documentId: Id, versionId: Id.optional() })
      .strict()
      .safeParse(input);
    if (!parsed.success) invalid("Project document source request is invalid.");

    return this.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT document.id AS document_id,
                document.title AS title,
                version.id AS version_id,
                version.content_sha256 AS content_sha256
           FROM documents document
           JOIN projects project
             ON project.id = document.project_id
            AND project.status <> 'deleted'
           JOIN document_versions version
             ON version.document_id = document.id
            AND version.id = COALESCE(?, document.current_version_id)
            AND version.deleted_at IS NULL
          WHERE document.id = ?
            AND document.project_id = ?
            AND document.deleted_at IS NULL`,
        )
        .get(input.versionId ?? null, input.documentId, input.projectId);
      if (!row) notFound("Project document version not found.");

      const documentId = asString(row.document_id, "document id");
      const versionId = asString(row.version_id, "document version id");
      const title = asString(row.title, "document title");
      const contentSha256 = Sha256.parse(
        asString(row.content_sha256, "document content hash"),
      );
      const now = this.now();

      const existing = this.database
        .prepare(
          `SELECT id
             FROM project_source_snapshots
            WHERE project_id = ?
              AND source_kind = 'project_document'
              AND source_record_id = ?
              AND source_version_id = ?
              AND content_sha256 = ?
            ORDER BY created_at ASC, id ASC
            LIMIT 1`,
        )
        .get(input.projectId, documentId, versionId, contentSha256);
      if (existing) {
        const snapshot = this.sources.getSnapshot(
          input.projectId,
          asString(existing.id, "source snapshot id"),
        );
        if (!snapshot) {
          throw new WorkspaceApiError(
            500,
            "INTERNAL_ERROR",
            "Source snapshot could not be reloaded.",
          );
        }
        return { snapshot, reused: true };
      }
      const snapshot = this.sources.createSnapshot({
        id: this.nextId(),
        projectId: input.projectId,
        sourceKind: "project_document",
        sourceRecordId: documentId,
        sourceVersionId: versionId,
        titleSnapshot: title,
        contentSha256,
        locator: {
          documentVersionId: versionId,
        },
        retrievedAt: now,
        license: {
          basis: "user_provided",
          retention: "full_text_permitted",
          export: "permitted",
          modelUse: "permitted",
        },
        retentionPolicy: "full_text_permitted",
        retentionExpiresAt: null,
        retrievalMetadata: {
          integration: "project_document_version",
          snapshotSchemaVersion: "vera-project-document-source-v1",
        },
        createdAt: now,
      });
      return { snapshot, reused: false };
    });
  }

  listSnapshots(input: {
    projectId: string;
    sourceKind?: ProjectSourceKindV11;
    limit?: number;
    cursor?: string;
  }): ProjectSourcePage {
    if (!Id.safeParse(input.projectId).success)
      invalid("Project id is invalid.");
    let sourceKind: ProjectSourceKindV11 | undefined;
    if (input.sourceKind !== undefined) {
      const parsedKind = ProjectSourceKindV11Schema.safeParse(input.sourceKind);
      if (!parsedKind.success) invalid("Source kind is invalid.");
      sourceKind = parsedKind.data;
    }
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      invalid(`Source page size must be between 1 and ${MAX_PAGE_SIZE}.`);
    }
    this.assertProjectExists(input.projectId);
    const cursor = decodeCursor(input.cursor);
    const predicates = ["project_id = ?"];
    const parameters: unknown[] = [input.projectId];
    if (sourceKind !== undefined) {
      predicates.push("source_kind = ?");
      parameters.push(sourceKind);
    }
    if (cursor) {
      predicates.push("(retrieved_at < ? OR (retrieved_at = ? AND id > ?))");
      parameters.push(cursor.retrievedAt, cursor.retrievedAt, cursor.id);
    }
    parameters.push(limit + 1);
    const rows = this.database
      .prepare(
        `SELECT id
           FROM project_source_snapshots
          WHERE ${predicates.join(" AND ")}
          ORDER BY retrieved_at DESC, id ASC
          LIMIT ?`,
      )
      .all(...parameters);
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    const snapshots = selected.map((row) => {
      const snapshot = this.sources.getSnapshot(
        input.projectId,
        asString(row.id, "source snapshot id"),
      );
      if (!snapshot) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Source snapshot could not be reloaded.",
        );
      }
      return snapshot;
    });
    return {
      sources: snapshots,
      nextCursor:
        hasMore && snapshots.length > 0
          ? encodeCursor(snapshots[snapshots.length - 1])
          : null,
    };
  }

  getSnapshot(projectId: string, snapshotId: string): ProjectSourceDetail {
    if (!Id.safeParse(projectId).success || !Id.safeParse(snapshotId).success) {
      invalid("Source identifiers are invalid.");
    }
    this.assertProjectExists(projectId);
    const snapshot = this.sources.getSnapshot(projectId, snapshotId);
    if (!snapshot) notFound();
    return {
      snapshot,
      anchors: this.sources.listCitationAnchors({
        projectId,
        snapshotId,
        limit: MAX_ANCHORS_PER_SOURCE,
      }),
    };
  }

  createProjectDocumentAnchor(
    input: CreateProjectDocumentAnchorInput,
  ): SourceCitationAnchorV11 {
    const identifiers = z
      .object({
        projectId: Id,
        snapshotId: Id,
        chunkId: Id,
      })
      .strict()
      .safeParse({
        projectId: input.projectId,
        snapshotId: input.snapshotId,
        chunkId: input.chunkId,
      });
    if (!identifiers.success)
      invalid("Citation anchor identifiers are invalid.");
    if (
      typeof input.exactQuote !== "string" ||
      input.exactQuote.trim().length < 1 ||
      [...input.exactQuote].length > 8_000 ||
      input.exactQuote.includes("\0")
    ) {
      invalid("Citation quote is invalid.");
    }
    const suppliedOffsets =
      input.startOffset !== null || input.endOffset !== null;
    if (
      suppliedOffsets &&
      (input.startOffset === null || input.endOffset === null)
    ) {
      invalid("Citation start and end offsets must be supplied together.");
    }

    return this.transaction(() => {
      const snapshot = this.sources.getSnapshot(
        input.projectId,
        input.snapshotId,
      );
      if (!snapshot) notFound();
      if (snapshot.sourceKind !== "project_document") {
        invalid("Public anchors can only target Project document sources.");
      }
      if (!snapshot.sourceVersionId) {
        conflict("Project document source version is unavailable.");
      }

      const chunk = this.database
        .prepare(
          `SELECT chunk.id,
                chunk.document_id,
                chunk.version_id,
                chunk.ordinal,
                chunk.text,
                chunk.start_offset,
                chunk.end_offset,
                chunk.page_start,
                chunk.page_end,
                chunk.content_sha256,
                chunk.metadata_json,
                version.content_sha256 AS version_content_sha256
           FROM document_chunks chunk
           JOIN document_versions version
             ON version.document_id = chunk.document_id
            AND version.id = chunk.version_id
            AND version.deleted_at IS NULL
           JOIN documents document
             ON document.id = chunk.document_id
            AND document.deleted_at IS NULL
           JOIN projects project
             ON project.id = document.project_id
            AND project.status <> 'deleted'
          WHERE chunk.id = ?
            AND document.project_id = ?
            AND chunk.document_id = ?
            AND chunk.version_id = ?`,
        )
        .get(
          input.chunkId,
          input.projectId,
          snapshot.sourceRecordId,
          snapshot.sourceVersionId,
        );
      if (!chunk) notFound("Project document chunk not found.");

      const chunkText = asString(chunk.text, "document chunk text");
      const chunkHash = Sha256.parse(
        asString(chunk.content_sha256, "document chunk hash"),
      );
      const versionHash = Sha256.parse(
        asString(chunk.version_content_sha256, "document version hash"),
      );
      if (versionHash !== snapshot.contentSha256) {
        conflict(
          "Source snapshot no longer matches the live document version.",
        );
      }
      if (sha256(chunkText) !== chunkHash) {
        conflict("Document chunk integrity check failed.");
      }

      let quoteStart: number;
      let quoteEnd: number;
      if (suppliedOffsets) {
        quoteStart = input.startOffset as number;
        quoteEnd = input.endOffset as number;
        if (
          !Number.isSafeInteger(quoteStart) ||
          !Number.isSafeInteger(quoteEnd) ||
          quoteStart < 0 ||
          quoteEnd < quoteStart ||
          quoteEnd > chunkText.length ||
          chunkText.slice(quoteStart, quoteEnd) !== input.exactQuote
        ) {
          invalid(
            "Citation offsets do not identify the exact quote in the chunk.",
          );
        }
      } else {
        const occurrences = findOccurrences(chunkText, input.exactQuote);
        if (occurrences.length === 0) {
          invalid("Citation quote was not found in the selected chunk.");
        }
        if (occurrences.length > 1) {
          conflict("Citation quote is ambiguous; exact offsets are required.");
        }
        quoteStart = occurrences[0];
        quoteEnd = quoteStart + input.exactQuote.length;
      }

      const chunkStart = asNonnegativeInteger(
        chunk.start_offset,
        "document chunk start offset",
      );
      const chunkEnd = asNonnegativeInteger(
        chunk.end_offset,
        "document chunk end offset",
      );
      if (chunkEnd < chunkStart || chunkEnd - chunkStart < chunkText.length) {
        conflict("Document chunk offsets failed integrity validation.");
      }
      const ordinal = asNonnegativeInteger(
        chunk.ordinal,
        "document chunk ordinal",
      );
      const pageStart =
        chunk.page_start === null
          ? null
          : asNonnegativeInteger(chunk.page_start, "chunk page start");
      const pageEnd =
        chunk.page_end === null
          ? null
          : asNonnegativeInteger(chunk.page_end, "chunk page end");
      const locator: Record<string, unknown> = {
        documentVersionId: snapshot.sourceVersionId,
        chunkId: input.chunkId,
        chunkOrdinal: ordinal,
        chunkContentSha256: chunkHash,
        startOffset: quoteStart,
        endOffset: quoteEnd,
        offsetScope: "chunk_text",
        offsetUnit: "utf16_code_unit",
        pageStart,
        pageEnd,
      };
      // Historical chunks may have trimmed text but pre-trim persisted bounds.
      // Their chunk-local and OCR page-local offsets remain authoritative, but
      // the leading/trailing split is unknowable without guessing. Only expose
      // document offsets when the persisted span proves an exact UTF-16 basis.
      if (chunkEnd - chunkStart === chunkText.length) {
        locator.documentStartOffset = chunkStart + quoteStart;
        locator.documentEndOffset = chunkStart + quoteEnd;
        locator.documentOffsetBasis = "normalized_matter_document_text_v1";
        locator.documentOffsetUnit = "utf16_code_unit";
      }
      const ocr = safeOcrProjection(
        chunk.metadata_json,
        pageStart,
        pageEnd,
        chunkText,
        quoteStart,
        quoteEnd,
      );
      if (ocr) locator.ocr = ocr;
      TransportSafeSourceMetadataV11Schema.parse(locator);

      const count = this.database
        .prepare(
          `SELECT count(*) AS count
             FROM source_citation_anchors
            WHERE project_id = ? AND snapshot_id = ?`,
        )
        .get(input.projectId, input.snapshotId);
      const anchorCount = asNonnegativeInteger(
        count?.count ?? 0,
        "citation anchor count",
      );
      if (anchorCount >= MAX_ANCHORS_PER_SOURCE) {
        conflict("Source citation anchor limit has been reached.");
      }
      const next = this.database
        .prepare(
          `SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
             FROM source_citation_anchors
            WHERE project_id = ? AND snapshot_id = ?`,
        )
        .get(input.projectId, input.snapshotId);
      const anchorOrdinal = asNonnegativeInteger(
        next?.ordinal,
        "citation anchor ordinal",
      );
      return this.sources.createCitationAnchor({
        id: this.nextId(),
        projectId: input.projectId,
        snapshotId: input.snapshotId,
        ordinal: anchorOrdinal,
        exactQuote: input.exactQuote,
        locator,
        createdAt: this.now(),
      });
    });
  }

  captureLegalAuthoritySnapshot(
    input: CaptureLegalAuthoritySnapshotInput,
  ): ProjectSourceSnapshotV11 {
    this.assertProjectExists(input.projectId);
    const policy = SourceDataUsePolicyV11Schema.parse(input.policy);
    return this.sources.createSnapshot({
      id: this.nextId(),
      projectId: input.projectId,
      sourceKind: "legal_authority",
      sourceRecordId: input.sourceRecordId,
      sourceVersionId: input.sourceVersionId,
      titleSnapshot: input.titleSnapshot,
      contentSha256: input.contentSha256,
      locator: input.locator,
      retrievedAt: input.retrievedAt,
      license: policy,
      retentionPolicy: policy.retention,
      retentionExpiresAt: input.retentionExpiresAt,
      retrievalMetadata: input.retrievalMetadata,
      createdAt: this.now(),
    });
  }

  private now() {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }

  private nextId() {
    return (this.options.nextId ?? randomUUID)();
  }

  private assertProjectExists(projectId: string) {
    const project = this.database
      .prepare("SELECT id FROM projects WHERE id = ? AND status <> 'deleted'")
      .get(projectId);
    if (!project) notFound("Project not found.");
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the primary failure.
      }
      throw error;
    }
  }
}
