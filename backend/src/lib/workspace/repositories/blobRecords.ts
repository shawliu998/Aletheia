import { randomUUID } from "node:crypto";
import type { WorkspaceDatabaseAdapter } from "../migrations/types";
import type {
  WorkspaceBlobKind,
  WorkspaceBlobLocator,
} from "../blobStore";

export type WorkspaceBlobRecordState = "stored" | "quarantined";

export type WorkspaceBlobRecord = {
  id: string;
  locator: WorkspaceBlobLocator;
  storageKey: string;
  contentSha256: string;
  sizeBytes: number;
  storedSizeBytes: number;
  state: WorkspaceBlobRecordState;
  quarantineId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RegisterWorkspaceBlobRecordInput = {
  id?: string;
  locator: WorkspaceBlobLocator;
  contentSha256: string;
  sizeBytes: number;
  storedSizeBytes: number;
};

export type QuarantineWorkspaceBlobRecord = {
  recordId: string;
  quarantineId: string;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function assertUuid(value: string, name: string) {
  if (!UUID.test(value)) throw new Error(`${name} must be a UUID.`);
}

function assertHash(value: string) {
  if (!SHA256.test(value)) throw new Error("contentSha256 must be lowercase SHA-256.");
}

function assertBytes(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer.`);
}

export function workspaceBlobStorageKey(locator: WorkspaceBlobLocator) {
  if (locator.kind === "export") {
    assertUuid(locator.exportId, "exportId");
    return `exports/${locator.exportId}`;
  }
  assertUuid(locator.documentId, "documentId");
  assertUuid(locator.versionId, "versionId");
  if (locator.kind === "original") {
    return `documents/${locator.documentId}/versions/${locator.versionId}/original`;
  }
  if (locator.kind === "extracted_text") {
    return `documents/${locator.documentId}/versions/${locator.versionId}/extracted`;
  }
  if (locator.kind !== "preview") throw new Error("Workspace blob locator kind is invalid.");
  if (locator.previewId !== undefined) assertUuid(locator.previewId, "previewId");
  return `documents/${locator.documentId}/versions/${locator.versionId}/preview/${locator.previewId ?? "default"}`;
}

function locatorColumns(locator: WorkspaceBlobLocator) {
  if (locator.kind === "export") {
    return {
      documentId: null,
      versionId: null,
      previewId: null,
      exportId: locator.exportId,
    };
  }
  return {
    documentId: locator.documentId,
    versionId: locator.versionId,
    previewId: locator.kind === "preview" ? locator.previewId ?? null : null,
    exportId: null,
  };
}

export class WorkspaceBlobRecordsRepository {
  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly nextId: () => string = randomUUID,
  ) {}

  registerStored(input: RegisterWorkspaceBlobRecordInput): WorkspaceBlobRecord {
    return this.transaction(() => this.registerStoredInTransaction(input));
  }

  registerStoredInTransaction(input: RegisterWorkspaceBlobRecordInput): WorkspaceBlobRecord {
    const id = input.id ?? this.nextId();
    assertUuid(id, "blobRecordId");
    assertHash(input.contentSha256);
    assertBytes(input.sizeBytes, "sizeBytes");
    assertBytes(input.storedSizeBytes, "storedSizeBytes");
    const storageKey = workspaceBlobStorageKey(input.locator);
    const columns = locatorColumns(input.locator);
    const now = new Date().toISOString();
    this.database
      .prepare(
        `INSERT INTO workspace_blob_records (
           id, kind, document_id, version_id, preview_id, export_id,
           storage_key, content_sha256, size_bytes, stored_size_bytes,
           state, quarantine_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stored', NULL, ?, ?)`,
      )
      .run(
        id,
        input.locator.kind,
        columns.documentId,
        columns.versionId,
        columns.previewId,
        columns.exportId,
        storageKey,
        input.contentSha256,
        input.sizeBytes,
        input.storedSizeBytes,
        now,
        now,
      );
    const record = this.getById(id);
    if (!record) throw new Error("Workspace blob record could not be reloaded after insert.");
    return record;
  }

  getById(id: string): WorkspaceBlobRecord | null {
    assertUuid(id, "blobRecordId");
    const row = this.database.prepare("SELECT * FROM workspace_blob_records WHERE id = ?").get(id);
    return row ? this.map(row) : null;
  }

  getByLocator(locator: WorkspaceBlobLocator): WorkspaceBlobRecord | null {
    const columns = locatorColumns(locator);
    const row = locator.kind === "export"
      ? this.database.prepare("SELECT * FROM workspace_blob_records WHERE kind = ? AND export_id = ?").get(locator.kind, columns.exportId)
      : locator.kind === "preview"
        ? locator.previewId === undefined
          ? this.database.prepare("SELECT * FROM workspace_blob_records WHERE kind = ? AND document_id = ? AND version_id = ? AND preview_id IS NULL").get(locator.kind, columns.documentId, columns.versionId)
          : this.database.prepare("SELECT * FROM workspace_blob_records WHERE kind = ? AND document_id = ? AND version_id = ? AND preview_id = ?").get(locator.kind, columns.documentId, columns.versionId, columns.previewId)
        : this.database.prepare("SELECT * FROM workspace_blob_records WHERE kind = ? AND document_id = ? AND version_id = ?").get(locator.kind, columns.documentId, columns.versionId);
    return row ? this.map(row) : null;
  }

  listForDocument(documentId: string): WorkspaceBlobRecord[] {
    assertUuid(documentId, "documentId");
    return this.database
      .prepare(
        `SELECT * FROM workspace_blob_records
          WHERE document_id = ? ORDER BY version_id, kind, preview_id`,
      )
      .all(documentId)
      .map((row) => this.map(row));
  }

  listForVersion(documentId: string, versionId: string): WorkspaceBlobRecord[] {
    assertUuid(documentId, "documentId");
    assertUuid(versionId, "versionId");
    return this.database
      .prepare(
        `SELECT * FROM workspace_blob_records
          WHERE document_id = ? AND version_id = ? ORDER BY kind, preview_id`,
      )
      .all(documentId, versionId)
      .map((row) => this.map(row));
  }

  listQuarantined(): WorkspaceBlobRecord[] {
    return this.database
      .prepare("SELECT * FROM workspace_blob_records WHERE state = 'quarantined' ORDER BY updated_at, id")
      .all()
      .map((row) => this.map(row));
  }

  quarantine(recordId: string, quarantineId: string): WorkspaceBlobRecord {
    return this.transaction(() => this.quarantineInTransaction(recordId, quarantineId));
  }

  quarantineInTransaction(recordId: string, quarantineId: string): WorkspaceBlobRecord {
    assertUuid(recordId, "blobRecordId");
    assertUuid(quarantineId, "quarantineId");
    const record = this.require(recordId);
    if (record.state !== "stored") throw new Error("Only stored blob records may be quarantined.");
    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE workspace_blob_records SET state = 'quarantined', quarantine_id = ?, updated_at = ? WHERE id = ? AND state = 'stored'")
      .run(quarantineId, now, recordId);
    return this.require(recordId);
  }

  restore(recordId: string, quarantineId: string): WorkspaceBlobRecord {
    return this.transaction(() => this.restoreInTransaction(recordId, quarantineId));
  }

  restoreInTransaction(recordId: string, quarantineId: string): WorkspaceBlobRecord {
    assertUuid(recordId, "blobRecordId");
    assertUuid(quarantineId, "quarantineId");
    const record = this.require(recordId);
    if (record.state !== "quarantined" || record.quarantineId !== quarantineId) {
      throw new Error("Blob record quarantine receipt does not match its durable state.");
    }
    this.database
      .prepare("UPDATE workspace_blob_records SET state = 'stored', quarantine_id = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), recordId);
    return this.require(recordId);
  }

  deleteQuarantined(recordId: string, quarantineId: string) {
    return this.transaction(() => this.deleteQuarantinedInTransaction(recordId, quarantineId));
  }

  deleteQuarantinedInTransaction(recordId: string, quarantineId: string) {
    assertUuid(recordId, "blobRecordId");
    assertUuid(quarantineId, "quarantineId");
    const record = this.require(recordId);
    if (record.state !== "quarantined" || record.quarantineId !== quarantineId) {
      throw new Error("Only the matching quarantined blob record may be deleted.");
    }
    this.database.prepare("DELETE FROM workspace_blob_records WHERE id = ?").run(recordId);
  }

  private require(id: string) {
    const record = this.getById(id);
    if (!record) throw new Error("Workspace blob record was not found.");
    return record;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the primary failure.
      }
      throw error;
    }
  }

  private map(row: Record<string, unknown>): WorkspaceBlobRecord {
    const kind = String(row.kind) as WorkspaceBlobKind;
    const documentId = row.document_id == null ? null : String(row.document_id);
    const versionId = row.version_id == null ? null : String(row.version_id);
    const previewId = row.preview_id == null ? undefined : String(row.preview_id);
    const exportId = row.export_id == null ? null : String(row.export_id);
    let locator: WorkspaceBlobLocator;
    if (kind === "export") {
      if (!exportId) throw new Error("Workspace export blob record is missing exportId.");
      locator = { kind, exportId };
    } else if (!documentId || !versionId) {
      throw new Error("Workspace document blob record is missing document/version IDs.");
    } else if (kind === "preview") {
      locator = { kind, documentId, versionId, ...(previewId ? { previewId } : {}) };
    } else if (kind === "original" || kind === "extracted_text") {
      locator = { kind, documentId, versionId };
    } else {
      throw new Error("Workspace blob record kind is invalid.");
    }
    const storageKey = String(row.storage_key);
    if (storageKey !== workspaceBlobStorageKey(locator)) {
      throw new Error("Workspace blob record storage key is not deterministic.");
    }
    assertUuid(String(row.id), "blobRecordId");
    assertHash(String(row.content_sha256));
    assertBytes(Number(row.size_bytes), "sizeBytes");
    assertBytes(Number(row.stored_size_bytes), "storedSizeBytes");
    const state = String(row.state);
    if (state !== "stored" && state !== "quarantined") throw new Error("Workspace blob record state is invalid.");
    const quarantineId = row.quarantine_id == null ? null : String(row.quarantine_id);
    if (state === "quarantined") {
      if (!quarantineId) throw new Error("Quarantined blob record has no quarantine ID.");
      assertUuid(quarantineId, "quarantineId");
    } else if (quarantineId) {
      throw new Error("Stored blob record must not have a quarantine ID.");
    }
    return {
      id: String(row.id),
      locator,
      storageKey,
      contentSha256: String(row.content_sha256),
      sizeBytes: Number(row.size_bytes),
      storedSizeBytes: Number(row.stored_size_bytes),
      state,
      quarantineId,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
