import { randomUUID } from "node:crypto";
import type {
  WorkspaceBlobDeleteReceipt,
  WorkspaceBlobLocator,
} from "../blobStore";
import type { WorkspaceDatabaseAdapter } from "../migrations/types";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WorkspaceDocumentBlobLocator = Exclude<
  WorkspaceBlobLocator,
  { kind: "export" }
>;

export type WorkspaceBlobCleanupOperation =
  | "compensation"
  | "restore"
  | "finalize";

export type WorkspaceBlobCleanupCode =
  | "DOCUMENT_BLOB_COMPENSATION_FAILED"
  | "DOCUMENT_BLOB_RESTORE_FAILED"
  | "DOCUMENT_BLOB_FINALIZE_FAILED";

export type WorkspaceBlobCleanupReplayErrorCode =
  | "AMBIGUOUS_AUTHORITY"
  | "STAGED_RECEIPT_MISMATCH"
  | "BLOB_STORE_UNSUPPORTED"
  | "BLOB_IO_FAILED"
  | "LEDGER_WRITE_FAILED";

export type WorkspaceBlobCleanupIntentStatus = "pending" | "resolved";

export type WorkspaceBlobCleanupIntentInput = {
  operation: WorkspaceBlobCleanupOperation;
  code: WorkspaceBlobCleanupCode;
  documentId: string;
  versionId: string;
  locator: WorkspaceBlobLocator;
  receipt: WorkspaceBlobDeleteReceipt | null;
};

export type WorkspaceBlobCleanupIntent = {
  id: string;
  operation: WorkspaceBlobCleanupOperation;
  code: WorkspaceBlobCleanupCode;
  documentId: string;
  versionId: string;
  locator: WorkspaceDocumentBlobLocator;
  receipt: WorkspaceBlobDeleteReceipt | null;
  status: WorkspaceBlobCleanupIntentStatus;
  attemptCount: number;
  lastErrorCode: WorkspaceBlobCleanupReplayErrorCode | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type WorkspaceBlobCleanupAuthority = {
  documentExists: boolean;
  documentDeleted: boolean;
  versionExists: boolean;
  versionDeleted: boolean;
  versionBelongsToDocument: boolean;
};

const OPERATIONS = new Set<WorkspaceBlobCleanupOperation>([
  "compensation",
  "restore",
  "finalize",
]);
const CODES = new Set<WorkspaceBlobCleanupCode>([
  "DOCUMENT_BLOB_COMPENSATION_FAILED",
  "DOCUMENT_BLOB_RESTORE_FAILED",
  "DOCUMENT_BLOB_FINALIZE_FAILED",
]);
const REPLAY_ERROR_CODES = new Set<WorkspaceBlobCleanupReplayErrorCode>([
  "AMBIGUOUS_AUTHORITY",
  "STAGED_RECEIPT_MISMATCH",
  "BLOB_STORE_UNSUPPORTED",
  "BLOB_IO_FAILED",
  "LEDGER_WRITE_FAILED",
]);

function assertUuid(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`${name} must be an RFC 4122 UUID.`);
  }
}

function assertPlainObject(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${name} must be a plain object.`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${name} has an invalid schema.`);
  }
}

function normalizeLocator(locator: unknown): WorkspaceDocumentBlobLocator {
  assertPlainObject(locator, "locator");
  const kind = locator.kind;
  if (kind !== "original" && kind !== "extracted_text" && kind !== "preview") {
    throw new Error("Cleanup locator must identify a document blob.");
  }
  const expectedKeys =
    kind === "preview" && Object.hasOwn(locator, "previewId")
      ? ["kind", "documentId", "versionId", "previewId"]
      : ["kind", "documentId", "versionId"];
  assertExactKeys(locator, expectedKeys, "locator");
  assertUuid(locator.documentId, "locator.documentId");
  assertUuid(locator.versionId, "locator.versionId");
  if (kind === "preview" && Object.hasOwn(locator, "previewId")) {
    assertUuid(locator.previewId, "locator.previewId");
    return {
      kind,
      documentId: locator.documentId,
      versionId: locator.versionId,
      previewId: locator.previewId,
    };
  }
  return { kind, documentId: locator.documentId, versionId: locator.versionId };
}

function locatorJson(locator: WorkspaceDocumentBlobLocator) {
  return JSON.stringify(locator);
}

function normalizeReceipt(
  receipt: unknown,
  expectedLocator: WorkspaceDocumentBlobLocator,
): WorkspaceBlobDeleteReceipt | null {
  if (receipt == null) return null;
  assertPlainObject(receipt, "receipt");
  assertExactKeys(receipt, ["status", "locator", "quarantineId"], "receipt");
  if (receipt.status !== "staged") {
    throw new Error("Cleanup receipt status must be staged.");
  }
  assertUuid(receipt.quarantineId, "receipt.quarantineId");
  const nestedLocator = normalizeLocator(receipt.locator);
  if (locatorJson(nestedLocator) !== locatorJson(expectedLocator)) {
    throw new Error(
      "Cleanup receipt locator does not match the intent locator.",
    );
  }
  return {
    status: "staged",
    locator: nestedLocator,
    quarantineId: receipt.quarantineId,
  };
}

function assertOperationCode(
  operation: WorkspaceBlobCleanupOperation,
  code: WorkspaceBlobCleanupCode,
) {
  const expected: Record<
    WorkspaceBlobCleanupOperation,
    WorkspaceBlobCleanupCode
  > = {
    compensation: "DOCUMENT_BLOB_COMPENSATION_FAILED",
    restore: "DOCUMENT_BLOB_RESTORE_FAILED",
    finalize: "DOCUMENT_BLOB_FINALIZE_FAILED",
  };
  if (code !== expected[operation]) {
    throw new Error("Cleanup operation and code do not match.");
  }
}

function parseJson(value: unknown, name: string): unknown {
  if (typeof value !== "string") throw new Error(`${name} is not JSON text.`);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} is malformed.`);
  }
}

export class WorkspaceBlobCleanupRepository {
  constructor(
    private readonly database: WorkspaceDatabaseAdapter,
    private readonly nextId: () => string = randomUUID,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** A synchronous transaction is required because callers are compensating a failed write. */
  record(input: WorkspaceBlobCleanupIntentInput): WorkspaceBlobCleanupIntent {
    return this.transaction(() => {
      if (!OPERATIONS.has(input.operation)) {
        throw new Error("Cleanup operation is invalid.");
      }
      if (!CODES.has(input.code)) throw new Error("Cleanup code is invalid.");
      assertOperationCode(input.operation, input.code);
      assertUuid(input.documentId, "documentId");
      assertUuid(input.versionId, "versionId");
      const locator = normalizeLocator(input.locator);
      if (
        locator.documentId !== input.documentId ||
        locator.versionId !== input.versionId
      ) {
        throw new Error(
          "Cleanup locator is not bound to its document/version.",
        );
      }
      const receipt = normalizeReceipt(input.receipt, locator);
      if (input.operation !== "compensation" && !receipt) {
        throw new Error(
          "Restore and finalize cleanup intents require a receipt.",
        );
      }
      const id = this.nextId();
      assertUuid(id, "cleanupIntentId");
      const at = this.now();
      if (!at.trim()) throw new Error("Cleanup timestamp is invalid.");
      this.database
        .prepare(
          `INSERT INTO workspace_blob_cleanup_intents (
             id, operation, code, document_id, version_id, locator_json,
             receipt_json, status, attempt_count, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(
          id,
          input.operation,
          input.code,
          input.documentId,
          input.versionId,
          locatorJson(locator),
          receipt ? JSON.stringify(receipt) : null,
          at,
          at,
        );
      return this.require(id);
    });
  }

  getById(id: string): WorkspaceBlobCleanupIntent | null {
    assertUuid(id, "cleanupIntentId");
    const row = this.database
      .prepare("SELECT * FROM workspace_blob_cleanup_intents WHERE id = ?")
      .get(id);
    return row ? this.map(row) : null;
  }

  listPending(limit = 1000): WorkspaceBlobCleanupIntent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error("Cleanup replay limit is invalid.");
    }
    return this.database
      .prepare(
        `SELECT * FROM workspace_blob_cleanup_intents
          WHERE status = 'pending'
          ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(limit)
      .map((row) => this.map(row));
  }

  markAttemptFailed(
    id: string,
    errorCode: WorkspaceBlobCleanupReplayErrorCode,
  ): WorkspaceBlobCleanupIntent {
    assertUuid(id, "cleanupIntentId");
    if (!REPLAY_ERROR_CODES.has(errorCode)) {
      throw new Error("Cleanup replay error code is invalid.");
    }
    return this.transaction(() => {
      const current = this.require(id);
      if (current.status !== "pending") {
        throw new Error("Resolved cleanup intents cannot record failures.");
      }
      this.database
        .prepare(
          `UPDATE workspace_blob_cleanup_intents
              SET attempt_count = attempt_count + 1,
                  last_error_code = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(errorCode, this.now(), id);
      const updated = this.require(id);
      if (updated.attemptCount !== current.attemptCount + 1) {
        throw new Error("Cleanup replay attempt was not durably recorded.");
      }
      return updated;
    });
  }

  resolve(id: string): WorkspaceBlobCleanupIntent {
    assertUuid(id, "cleanupIntentId");
    return this.transaction(() => {
      const current = this.require(id);
      if (current.status === "resolved") return current;
      const at = this.now();
      this.database
        .prepare(
          `UPDATE workspace_blob_cleanup_intents
              SET status = 'resolved', resolved_at = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'`,
        )
        .run(at, at, id);
      const updated = this.require(id);
      if (updated.status !== "resolved" || !updated.resolvedAt) {
        throw new Error("Cleanup intent resolution was not durably recorded.");
      }
      return updated;
    });
  }

  inspectAuthority(
    documentId: string,
    versionId: string,
  ): WorkspaceBlobCleanupAuthority {
    assertUuid(documentId, "documentId");
    assertUuid(versionId, "versionId");
    const document = this.database
      .prepare("SELECT deleted_at FROM documents WHERE id = ?")
      .get(documentId);
    const version = this.database
      .prepare(
        "SELECT document_id, deleted_at FROM document_versions WHERE id = ?",
      )
      .get(versionId);
    return {
      documentExists: Boolean(document),
      documentDeleted: Boolean(document && document.deleted_at != null),
      versionExists: Boolean(version),
      versionDeleted: Boolean(version && version.deleted_at != null),
      versionBelongsToDocument: Boolean(
        version && String(version.document_id) === documentId,
      ),
    };
  }

  private require(id: string) {
    const intent = this.getById(id);
    if (!intent)
      throw new Error("Workspace blob cleanup intent was not found.");
    return intent;
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
        // Preserve the primary durable-ledger failure.
      }
      throw error;
    }
  }

  private map(row: Record<string, unknown>): WorkspaceBlobCleanupIntent {
    const id = String(row.id);
    const documentId = String(row.document_id);
    const versionId = String(row.version_id);
    assertUuid(id, "cleanupIntentId");
    assertUuid(documentId, "documentId");
    assertUuid(versionId, "versionId");
    const operation = String(row.operation) as WorkspaceBlobCleanupOperation;
    const code = String(row.code) as WorkspaceBlobCleanupCode;
    if (!OPERATIONS.has(operation) || !CODES.has(code)) {
      throw new Error("Workspace blob cleanup row has an invalid operation.");
    }
    assertOperationCode(operation, code);
    const locator = normalizeLocator(
      parseJson(row.locator_json, "locator_json"),
    );
    if (locator.documentId !== documentId || locator.versionId !== versionId) {
      throw new Error(
        "Workspace blob cleanup row has mismatched authority IDs.",
      );
    }
    const receipt =
      row.receipt_json == null
        ? null
        : normalizeReceipt(
            parseJson(row.receipt_json, "receipt_json"),
            locator,
          );
    if (operation !== "compensation" && !receipt) {
      throw new Error("Workspace blob cleanup row is missing its receipt.");
    }
    const status = String(row.status) as WorkspaceBlobCleanupIntentStatus;
    if (status !== "pending" && status !== "resolved") {
      throw new Error("Workspace blob cleanup row has an invalid status.");
    }
    const attemptCount = Number(row.attempt_count);
    if (!Number.isSafeInteger(attemptCount) || attemptCount < 0) {
      throw new Error(
        "Workspace blob cleanup row has an invalid attempt count.",
      );
    }
    const lastErrorCode =
      row.last_error_code == null
        ? null
        : (String(row.last_error_code) as WorkspaceBlobCleanupReplayErrorCode);
    if (lastErrorCode && !REPLAY_ERROR_CODES.has(lastErrorCode)) {
      throw new Error(
        "Workspace blob cleanup row has an invalid replay error.",
      );
    }
    const resolvedAt = row.resolved_at == null ? null : String(row.resolved_at);
    if ((status === "resolved") !== Boolean(resolvedAt)) {
      throw new Error("Workspace blob cleanup row has an invalid resolution.");
    }
    return {
      id,
      operation,
      code,
      documentId,
      versionId,
      locator,
      receipt,
      status,
      attemptCount,
      lastErrorCode,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      resolvedAt,
    };
  }
}
