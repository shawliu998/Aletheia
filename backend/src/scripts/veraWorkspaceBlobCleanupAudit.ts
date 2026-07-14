import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  BlobStore,
  WorkspaceBlobCodec,
  WorkspaceBlobDeleteReceipt,
  WorkspaceBlobLocator,
} from "../lib/workspace/blobStore";
import { WorkspaceDatabase } from "../lib/workspace/database";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { WorkspaceBlobCleanupRepository } from "../lib/workspace/repositories/blobCleanup";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import { WorkspaceDocumentsRepository } from "../lib/workspace/repositories/documents";
import {
  WorkspaceBlobCleanupReplay,
  WorkspaceBlobCleanupReplayError,
  type WorkspaceBlobCleanupLedger,
} from "../lib/workspace/services/blobCleanup";
import {
  WorkspaceBlobReconciliation,
  WorkspaceBlobStartupRecovery,
} from "../lib/workspace/services/blobReconciliation";
import type { WorkspaceBlobCleanupRecorder } from "../lib/workspace/services/documents";

class IdentityCodec implements WorkspaceBlobCodec {
  readonly encrypted = false;
  encode(args: Parameters<WorkspaceBlobCodec["encode"]>[0]) {
    return Buffer.from(args.plaintext);
  }
  decode(args: Parameters<WorkspaceBlobCodec["decode"]>[0]) {
    return Buffer.from(args.envelope);
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "vera-blob-cleanup-audit-"));
const originalEnvironment = { ...process.env };

function uuid(value: number) {
  const head = value.toString(16).padStart(8, "0");
  const tail = value.toString(16).padStart(12, "0");
  return `${head}-0000-4000-8000-${tail}`;
}

function original(documentId: string, versionId: string) {
  return { kind: "original", documentId, versionId } as const;
}

function extractedText(documentId: string, versionId: string) {
  return { kind: "extracted_text", documentId, versionId } as const;
}

function seedVersion(
  database: WorkspaceDatabase,
  documentId: string,
  versionId: string,
  deleted = false,
) {
  database
    .prepare(
      `INSERT INTO documents (
         id, title, filename, mime_type, size_bytes, parse_status
       ) VALUES (?, ?, ?, 'text/plain', 7, 'ready')`,
    )
    .run(documentId, `Document ${documentId}`, `${documentId}.txt`);
  database
    .prepare(
      `INSERT INTO document_versions (
         id, document_id, version_number, filename, mime_type, size_bytes,
         content_sha256, storage_key
       ) VALUES (?, ?, 1, ?, 'text/plain', 7, ?, ?)`,
    )
    .run(
      versionId,
      documentId,
      `${documentId}.txt`,
      "a".repeat(64),
      `documents/${documentId}/versions/${versionId}/original`,
    );
  database
    .prepare("UPDATE documents SET current_version_id = ? WHERE id = ?")
    .run(versionId, documentId);
  if (deleted) {
    const at = "2026-07-14T00:00:00.000Z";
    database
      .prepare("UPDATE document_versions SET deleted_at = ? WHERE id = ?")
      .run(at, versionId);
    database
      .prepare(
        "UPDATE documents SET deleted_at = ?, current_version_id = NULL WHERE id = ?",
      )
      .run(at, documentId);
  }
}

function createDatabase(name: string) {
  return new WorkspaceDatabase(path.join(root, `${name}.sqlite`));
}

function createBlobs(name: string) {
  return new LocalWorkspaceBlobStore({
    root: path.join(root, `${name}-blobs`),
    codec: new IdentityCodec(),
    allowUnencryptedCodec: true,
  });
}

function expectReplayError(
  operation: () => unknown,
  code: WorkspaceBlobCleanupReplayError["code"],
) {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof WorkspaceBlobCleanupReplayError);
    assert.equal(error.code, code);
    assert.equal(error.message.includes("/Users/private"), false);
    return true;
  });
}

try {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  const blobs = createBlobs("success");
  let database = createDatabase("success");
  let records = new WorkspaceBlobRecordsRepository(database);
  const fixedIntentId = uuid(900);
  let ledger = new WorkspaceBlobCleanupRepository(
    database,
    () => fixedIntentId,
  );

  const orphanDocumentId = uuid(1);
  const orphanVersionId = uuid(2);
  const orphanLocator = original(orphanDocumentId, orphanVersionId);
  blobs.putSync(orphanLocator, "orphan");
  const firstIntent = ledger.record({
    operation: "compensation",
    code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
    documentId: orphanDocumentId,
    versionId: orphanVersionId,
    locator: orphanLocator,
    receipt: null,
  });
  assert.equal(firstIntent.status, "pending");
  assert.throws(
    () =>
      ledger.record({
        operation: "compensation",
        code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
        documentId: uuid(3),
        versionId: uuid(4),
        locator: original(uuid(3), uuid(4)),
        receipt: null,
      }),
    /unique|constraint/i,
  );
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM workspace_blob_cleanup_intents WHERE id = ?",
      )
      .get(fixedIntentId)?.count,
    1,
  );

  const stagedDocumentId = uuid(5);
  const stagedVersionId = uuid(6);
  const stagedLocator = original(stagedDocumentId, stagedVersionId);
  blobs.putSync(stagedLocator, "staged orphan");
  const stagedReceipt = blobs.stageDeleteSync(stagedLocator);
  ledger = new WorkspaceBlobCleanupRepository(database);
  const stagedIntent = ledger.record({
    operation: "compensation",
    code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
    documentId: stagedDocumentId,
    versionId: stagedVersionId,
    locator: stagedLocator,
    receipt: stagedReceipt,
  });

  // The recorder is directly reusable by document/project lifecycle code; no
  // operation source is part of the durable schema.
  const recorder: WorkspaceBlobCleanupRecorder = ledger;
  assert.equal(typeof recorder.record, "function");

  assert.throws(() =>
    ledger.record({
      operation: "compensation",
      code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
      documentId: uuid(7),
      versionId: uuid(8),
      locator: {
        ...original(uuid(7), uuid(8)),
        path: "/Users/private/client.pdf",
      } as unknown as WorkspaceBlobLocator,
      receipt: null,
    }),
  );
  assert.throws(() =>
    ledger.record({
      operation: "restore",
      code: "DOCUMENT_BLOB_RESTORE_FAILED",
      documentId: uuid(7),
      versionId: uuid(8),
      locator: original(uuid(7), uuid(8)),
      receipt: null,
    }),
  );
  assert.throws(() =>
    ledger.record({
      operation: "finalize",
      code: "DOCUMENT_BLOB_RESTORE_FAILED",
      documentId: uuid(7),
      versionId: uuid(8),
      locator: original(uuid(7), uuid(8)),
      receipt: stagedReceipt,
    }),
  );

  // Closing and reopening proves that both original and already-staged
  // compensation intents survive a process boundary.
  database.close();
  database = createDatabase("success");
  records = new WorkspaceBlobRecordsRepository(database);
  ledger = new WorkspaceBlobCleanupRepository(database);
  let documents = new WorkspaceDocumentsRepository(database, {
    blobRecords: records,
  });
  let replay = new WorkspaceBlobCleanupReplay(ledger, records, blobs);
  let reconciliation = new WorkspaceBlobReconciliation(
    records,
    blobs,
    documents,
  );
  const startup = new WorkspaceBlobStartupRecovery(replay, reconciliation);
  assert.deepEqual(startup.recover(), {
    cleanup: { resolved: 2, restored: 0, finalized: 2, retained: 0 },
    reconciliation: { restored: 0, finalized: 0, conflicts: 0 },
  });
  assert.equal(ledger.getById(firstIntent.id)?.status, "resolved");
  assert.equal(ledger.getById(stagedIntent.id)?.status, "resolved");
  assert.throws(() => blobs.stageDeleteSync(orphanLocator), {
    name: "WorkspaceBlobNotFoundError",
  });
  assert.deepEqual(replay.replayPending(), {
    resolved: 0,
    restored: 0,
    finalized: 0,
    retained: 0,
  });

  const restoreDocumentId = uuid(10);
  const restoreVersionId = uuid(11);
  const restoreLocator = original(restoreDocumentId, restoreVersionId);
  seedVersion(database, restoreDocumentId, restoreVersionId);
  const restoreStored = blobs.putSync(restoreLocator, "restore");
  const restoreRecord = records.registerStored({
    locator: restoreLocator,
    contentSha256: restoreStored.sha256,
    sizeBytes: restoreStored.size,
    storedSizeBytes: restoreStored.storedSize,
  });
  const restoreReceipt = blobs.stageDeleteSync(restoreLocator);
  const restoreIntent = ledger.record({
    operation: "restore",
    code: "DOCUMENT_BLOB_RESTORE_FAILED",
    documentId: restoreDocumentId,
    versionId: restoreVersionId,
    locator: restoreLocator,
    receipt: restoreReceipt,
  });
  assert.deepEqual(replay.replayPending(), {
    resolved: 1,
    restored: 1,
    finalized: 0,
    retained: 0,
  });
  assert.equal(ledger.getById(restoreIntent.id)?.status, "resolved");
  assert.deepEqual(
    blobs.readSync(restoreLocator, {
      sha256: restoreRecord.contentSha256,
      size: restoreRecord.sizeBytes,
    }),
    Buffer.from("restore"),
  );

  const finalizeDocumentId = uuid(20);
  const finalizeVersionId = uuid(21);
  const finalizeLocator = original(finalizeDocumentId, finalizeVersionId);
  seedVersion(database, finalizeDocumentId, finalizeVersionId);
  const finalizeStored = blobs.putSync(finalizeLocator, "finalize");
  const finalizeRecord = records.registerStored({
    locator: finalizeLocator,
    contentSha256: finalizeStored.sha256,
    sizeBytes: finalizeStored.size,
    storedSizeBytes: finalizeStored.storedSize,
  });
  const finalizeReceipt = blobs.stageDeleteSync(finalizeLocator);
  records.quarantine(finalizeRecord.id, finalizeReceipt.quarantineId);
  database
    .prepare("UPDATE document_versions SET deleted_at = ? WHERE id = ?")
    .run("2026-07-14T01:00:00.000Z", finalizeVersionId);
  database
    .prepare(
      "UPDATE documents SET deleted_at = ?, current_version_id = NULL WHERE id = ?",
    )
    .run("2026-07-14T01:00:00.000Z", finalizeDocumentId);
  const finalizeIntent = ledger.record({
    operation: "finalize",
    code: "DOCUMENT_BLOB_FINALIZE_FAILED",
    documentId: finalizeDocumentId,
    versionId: finalizeVersionId,
    locator: finalizeLocator,
    receipt: finalizeReceipt,
  });
  assert.deepEqual(replay.replayPending(), {
    resolved: 1,
    restored: 0,
    finalized: 1,
    retained: 0,
  });
  assert.equal(records.getById(finalizeRecord.id), null);
  assert.equal(ledger.getById(finalizeIntent.id)?.status, "resolved");

  const order: string[] = [];
  const orderedRecovery = new WorkspaceBlobStartupRecovery(
    {
      replayPending() {
        order.push("cleanup");
        return { resolved: 0, restored: 0, finalized: 0, retained: 0 };
      },
    },
    {
      reconcile() {
        order.push("reconciliation");
        return { restored: 0, finalized: 0, conflicts: 0 };
      },
    },
  );
  orderedRecovery.recover();
  assert.deepEqual(order, ["cleanup", "reconciliation"]);
  database.close();

  // A live exact version is a reference even if its authoritative record is
  // missing. Replay fails closed and leaves both the blob and intent intact.
  const ambiguousDatabase = createDatabase("ambiguous");
  const ambiguousBlobs = createBlobs("ambiguous");
  const ambiguousRecords = new WorkspaceBlobRecordsRepository(
    ambiguousDatabase,
  );
  const ambiguousLedger = new WorkspaceBlobCleanupRepository(ambiguousDatabase);
  const ambiguousDocumentId = uuid(30);
  const ambiguousVersionId = uuid(31);
  const ambiguousLocator = original(ambiguousDocumentId, ambiguousVersionId);
  seedVersion(ambiguousDatabase, ambiguousDocumentId, ambiguousVersionId);
  const ambiguousStored = ambiguousBlobs.putSync(
    ambiguousLocator,
    "referenced",
  );
  const ambiguousIntent = ambiguousLedger.record({
    operation: "compensation",
    code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
    documentId: ambiguousDocumentId,
    versionId: ambiguousVersionId,
    locator: ambiguousLocator,
    receipt: null,
  });
  expectReplayError(
    () =>
      new WorkspaceBlobCleanupReplay(
        ambiguousLedger,
        ambiguousRecords,
        ambiguousBlobs,
      ).replayPending(),
    "AMBIGUOUS_AUTHORITY",
  );
  assert.deepEqual(
    ambiguousBlobs.readSync(ambiguousLocator, {
      sha256: ambiguousStored.sha256,
      size: ambiguousStored.size,
    }),
    Buffer.from("referenced"),
  );
  assert.deepEqual(
    {
      status: ambiguousLedger.getById(ambiguousIntent.id)?.status,
      attempt: ambiguousLedger.getById(ambiguousIntent.id)?.attemptCount,
      error: ambiguousLedger.getById(ambiguousIntent.id)?.lastErrorCode,
    },
    { status: "pending", attempt: 1, error: "AMBIGUOUS_AUTHORITY" },
  );
  ambiguousDatabase.close();

  // Extracted text is reproducible from the authoritative original. A
  // pre-put compensation intent therefore identifies an unrecorded candidate
  // left by a crash between physical put and blob-record commit.
  const derivedOrphanDatabase = createDatabase("derived-orphan");
  const derivedOrphanBlobs = createBlobs("derived-orphan");
  const derivedOrphanRecords = new WorkspaceBlobRecordsRepository(
    derivedOrphanDatabase,
  );
  const derivedOrphanLedger = new WorkspaceBlobCleanupRepository(
    derivedOrphanDatabase,
  );
  const derivedOrphanDocumentId = uuid(32);
  const derivedOrphanVersionId = uuid(33);
  const derivedOrphanLocator = extractedText(
    derivedOrphanDocumentId,
    derivedOrphanVersionId,
  );
  seedVersion(
    derivedOrphanDatabase,
    derivedOrphanDocumentId,
    derivedOrphanVersionId,
  );
  derivedOrphanBlobs.putSync(derivedOrphanLocator, "unrecorded extraction");
  const derivedOrphanIntent = derivedOrphanLedger.record({
    operation: "compensation",
    code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
    documentId: derivedOrphanDocumentId,
    versionId: derivedOrphanVersionId,
    locator: derivedOrphanLocator,
    receipt: null,
  });
  assert.deepEqual(
    new WorkspaceBlobCleanupReplay(
      derivedOrphanLedger,
      derivedOrphanRecords,
      derivedOrphanBlobs,
    ).replayPending(),
    { resolved: 1, restored: 0, finalized: 1, retained: 0 },
  );
  assert.equal(
    derivedOrphanLedger.getById(derivedOrphanIntent.id)?.status,
    "resolved",
  );
  assert.throws(() => derivedOrphanBlobs.stageDeleteSync(derivedOrphanLocator), {
    name: "WorkspaceBlobNotFoundError",
  });
  derivedOrphanDatabase.close();

  // If the process died before the derived put, the same pre-put intent is
  // already complete and resolves idempotently without inventing a blob.
  const derivedMissingDatabase = createDatabase("derived-missing");
  const derivedMissingBlobs = createBlobs("derived-missing");
  const derivedMissingRecords = new WorkspaceBlobRecordsRepository(
    derivedMissingDatabase,
  );
  const derivedMissingLedger = new WorkspaceBlobCleanupRepository(
    derivedMissingDatabase,
  );
  const derivedMissingDocumentId = uuid(34);
  const derivedMissingVersionId = uuid(35);
  const derivedMissingLocator = extractedText(
    derivedMissingDocumentId,
    derivedMissingVersionId,
  );
  seedVersion(
    derivedMissingDatabase,
    derivedMissingDocumentId,
    derivedMissingVersionId,
  );
  const derivedMissingIntent = derivedMissingLedger.record({
    operation: "compensation",
    code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
    documentId: derivedMissingDocumentId,
    versionId: derivedMissingVersionId,
    locator: derivedMissingLocator,
    receipt: null,
  });
  assert.deepEqual(
    new WorkspaceBlobCleanupReplay(
      derivedMissingLedger,
      derivedMissingRecords,
      derivedMissingBlobs,
    ).replayPending(),
    { resolved: 1, restored: 0, finalized: 1, retained: 0 },
  );
  assert.equal(
    derivedMissingLedger.getById(derivedMissingIntent.id)?.status,
    "resolved",
  );
  derivedMissingDatabase.close();

  // A stored derived record is durable authority and wins over the earlier
  // pre-put compensation intent after the database commit succeeds.
  const derivedStoredDatabase = createDatabase("derived-stored");
  const derivedStoredBlobs = createBlobs("derived-stored");
  const derivedStoredRecords = new WorkspaceBlobRecordsRepository(
    derivedStoredDatabase,
  );
  const derivedStoredLedger = new WorkspaceBlobCleanupRepository(
    derivedStoredDatabase,
  );
  const derivedStoredDocumentId = uuid(36);
  const derivedStoredVersionId = uuid(37);
  const derivedStoredLocator = extractedText(
    derivedStoredDocumentId,
    derivedStoredVersionId,
  );
  seedVersion(
    derivedStoredDatabase,
    derivedStoredDocumentId,
    derivedStoredVersionId,
  );
  const derivedStoredBlob = derivedStoredBlobs.putSync(
    derivedStoredLocator,
    "committed extraction",
  );
  const derivedStoredRecord = derivedStoredRecords.registerStored({
    locator: derivedStoredLocator,
    contentSha256: derivedStoredBlob.sha256,
    sizeBytes: derivedStoredBlob.size,
    storedSizeBytes: derivedStoredBlob.storedSize,
  });
  const derivedStoredIntent = derivedStoredLedger.record({
    operation: "compensation",
    code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
    documentId: derivedStoredDocumentId,
    versionId: derivedStoredVersionId,
    locator: derivedStoredLocator,
    receipt: null,
  });
  assert.deepEqual(
    new WorkspaceBlobCleanupReplay(
      derivedStoredLedger,
      derivedStoredRecords,
      derivedStoredBlobs,
    ).replayPending(),
    { resolved: 1, restored: 0, finalized: 0, retained: 1 },
  );
  assert.equal(
    derivedStoredLedger.getById(derivedStoredIntent.id)?.status,
    "resolved",
  );
  assert.deepEqual(
    derivedStoredBlobs.readSync(derivedStoredLocator, {
      sha256: derivedStoredRecord.contentSha256,
      size: derivedStoredRecord.sizeBytes,
    }),
    Buffer.from("committed extraction"),
  );
  derivedStoredDatabase.close();

  // Even for a derived locator, a version owned by another document is not
  // exact authority. Replay fails closed and preserves the physical file.
  const wrongOwnerDatabase = createDatabase("derived-wrong-owner");
  const wrongOwnerBlobs = createBlobs("derived-wrong-owner");
  const wrongOwnerRecords = new WorkspaceBlobRecordsRepository(
    wrongOwnerDatabase,
  );
  const wrongOwnerLedger = new WorkspaceBlobCleanupRepository(
    wrongOwnerDatabase,
  );
  const actualDocumentId = uuid(38);
  const claimedDocumentId = uuid(39);
  const wrongOwnerVersionId = uuid(63);
  const claimedDocumentVersionId = uuid(64);
  seedVersion(wrongOwnerDatabase, actualDocumentId, wrongOwnerVersionId);
  seedVersion(
    wrongOwnerDatabase,
    claimedDocumentId,
    claimedDocumentVersionId,
  );
  const wrongOwnerLocator = extractedText(
    claimedDocumentId,
    wrongOwnerVersionId,
  );
  const wrongOwnerStored = wrongOwnerBlobs.putSync(
    wrongOwnerLocator,
    "wrong owner extraction",
  );
  const wrongOwnerIntent = wrongOwnerLedger.record({
    operation: "compensation",
    code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
    documentId: claimedDocumentId,
    versionId: wrongOwnerVersionId,
    locator: wrongOwnerLocator,
    receipt: null,
  });
  expectReplayError(
    () =>
      new WorkspaceBlobCleanupReplay(
        wrongOwnerLedger,
        wrongOwnerRecords,
        wrongOwnerBlobs,
      ).replayPending(),
    "AMBIGUOUS_AUTHORITY",
  );
  assert.deepEqual(
    wrongOwnerBlobs.readSync(wrongOwnerLocator, {
      sha256: wrongOwnerStored.sha256,
      size: wrongOwnerStored.size,
    }),
    Buffer.from("wrong owner extraction"),
  );
  assert.equal(wrongOwnerLedger.getById(wrongOwnerIntent.id)?.status, "pending");
  wrongOwnerDatabase.close();

  // A stored authority whose staged receipt and original are both missing is
  // never interpreted as permission to delete the metadata row.
  const missingDatabase = createDatabase("missing-staged");
  const missingBlobs = createBlobs("missing-staged");
  const missingRecords = new WorkspaceBlobRecordsRepository(missingDatabase);
  const missingLedger = new WorkspaceBlobCleanupRepository(missingDatabase);
  const missingDocumentId = uuid(40);
  const missingVersionId = uuid(41);
  const missingLocator = original(missingDocumentId, missingVersionId);
  seedVersion(missingDatabase, missingDocumentId, missingVersionId);
  const missingStored = missingBlobs.putSync(missingLocator, "missing");
  const missingRecord = missingRecords.registerStored({
    locator: missingLocator,
    contentSha256: missingStored.sha256,
    sizeBytes: missingStored.size,
    storedSizeBytes: missingStored.storedSize,
  });
  const lostReceipt = missingBlobs.stageDeleteSync(missingLocator);
  missingBlobs.finalizeDeleteSync(lostReceipt);
  const missingIntent = missingLedger.record({
    operation: "compensation",
    code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
    documentId: missingDocumentId,
    versionId: missingVersionId,
    locator: missingLocator,
    receipt: null,
  });
  expectReplayError(
    () =>
      new WorkspaceBlobCleanupReplay(
        missingLedger,
        missingRecords,
        missingBlobs,
      ).replayPending(),
    "BLOB_IO_FAILED",
  );
  assert.ok(missingRecords.getById(missingRecord.id));
  assert.equal(missingLedger.getById(missingIntent.id)?.status, "pending");

  const failingLedger: WorkspaceBlobCleanupLedger = {
    listPending: missingLedger.listPending.bind(missingLedger),
    inspectAuthority: missingLedger.inspectAuthority.bind(missingLedger),
    resolve: missingLedger.resolve.bind(missingLedger),
    markAttemptFailed() {
      throw new Error("/Users/private/ledger.sqlite");
    },
  };
  expectReplayError(
    () =>
      new WorkspaceBlobCleanupReplay(
        failingLedger,
        missingRecords,
        missingBlobs,
      ).replayPending(),
    "LEDGER_WRITE_FAILED",
  );
  missingDatabase.close();

  // Blob I/O messages are reduced to a stable code; the physical receipt is
  // retained and a later healthy replay finishes idempotently.
  const ioDatabase = createDatabase("io-failure");
  const ioBlobs = createBlobs("io-failure");
  const ioRecords = new WorkspaceBlobRecordsRepository(ioDatabase);
  const ioLedger = new WorkspaceBlobCleanupRepository(ioDatabase);
  const ioDocumentId = uuid(50);
  const ioVersionId = uuid(51);
  const ioLocator = original(ioDocumentId, ioVersionId);
  ioBlobs.putSync(ioLocator, "io failure");
  const ioReceipt = ioBlobs.stageDeleteSync(ioLocator);
  const ioIntent = ioLedger.record({
    operation: "compensation",
    code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
    documentId: ioDocumentId,
    versionId: ioVersionId,
    locator: ioLocator,
    receipt: ioReceipt,
  });
  const failingBlobs: BlobStore = {
    putSync: ioBlobs.putSync.bind(ioBlobs),
    readSync: ioBlobs.readSync.bind(ioBlobs),
    stageDeleteSync: ioBlobs.stageDeleteSync.bind(ioBlobs),
    restoreDeleteSync: ioBlobs.restoreDeleteSync.bind(ioBlobs),
    finalizeDeleteSync() {
      throw new Error("injected /Users/private/client.pdf");
    },
    listStagedDeletesSync: ioBlobs.listStagedDeletesSync.bind(ioBlobs),
  };
  expectReplayError(
    () =>
      new WorkspaceBlobCleanupReplay(
        ioLedger,
        ioRecords,
        failingBlobs,
      ).replayPending(),
    "BLOB_IO_FAILED",
  );
  assert.deepEqual(
    {
      status: ioLedger.getById(ioIntent.id)?.status,
      attempt: ioLedger.getById(ioIntent.id)?.attemptCount,
      error: ioLedger.getById(ioIntent.id)?.lastErrorCode,
    },
    { status: "pending", attempt: 1, error: "BLOB_IO_FAILED" },
  );
  assert.deepEqual(
    new WorkspaceBlobCleanupReplay(
      ioLedger,
      ioRecords,
      ioBlobs,
    ).replayPending(),
    { resolved: 1, restored: 0, finalized: 1, retained: 0 },
  );
  assert.equal(ioLedger.getById(ioIntent.id)?.status, "resolved");
  ioDatabase.close();
  assert.throws(() =>
    ioLedger.record({
      operation: "compensation",
      code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
      documentId: uuid(52),
      versionId: uuid(53),
      locator: original(uuid(52), uuid(53)),
      receipt: null,
    }),
  );

  // A valid-looking but different receipt is not allowed to authorize the
  // actual staged blob.
  const mismatchDatabase = createDatabase("mismatch");
  const mismatchBlobs = createBlobs("mismatch");
  const mismatchRecords = new WorkspaceBlobRecordsRepository(mismatchDatabase);
  const mismatchLedger = new WorkspaceBlobCleanupRepository(mismatchDatabase);
  const mismatchDocumentId = uuid(60);
  const mismatchVersionId = uuid(61);
  const mismatchLocator = original(mismatchDocumentId, mismatchVersionId);
  mismatchBlobs.putSync(mismatchLocator, "mismatch");
  const actualReceipt = mismatchBlobs.stageDeleteSync(mismatchLocator);
  const forgedReceipt: WorkspaceBlobDeleteReceipt = {
    ...actualReceipt,
    quarantineId: uuid(62),
  };
  const mismatchIntent = mismatchLedger.record({
    operation: "compensation",
    code: "DOCUMENT_BLOB_COMPENSATION_FAILED",
    documentId: mismatchDocumentId,
    versionId: mismatchVersionId,
    locator: mismatchLocator,
    receipt: forgedReceipt,
  });
  expectReplayError(
    () =>
      new WorkspaceBlobCleanupReplay(
        mismatchLedger,
        mismatchRecords,
        mismatchBlobs,
      ).replayPending(),
    "STAGED_RECEIPT_MISMATCH",
  );
  assert.equal(mismatchLedger.getById(mismatchIntent.id)?.attemptCount, 1);
  assert.equal(mismatchBlobs.listStagedDeletesSync().length, 1);
  mismatchDatabase.close();

  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "vera-workspace-blob-cleanup-audit-v3",
        checks: [
          "atomic synchronous durable recording and process restart",
          "strict UUID-only path-free locator and receipt schemas",
          "compensation of orphan original and staged blobs",
          "pre-put derived crash orphans are deleted idempotently",
          "stored derived authority is retained",
          "original and mismatched derived authority remain fail closed",
          "authoritative restore and quarantined finalize",
          "live document/version references are never deleted",
          "stored authority with missing physical receipt fails closed",
          "stable redacted replay errors retain attempt state",
          "ledger write failures propagate without being swallowed",
          "idempotent success-only resolution",
          "cleanup replay precedes generic reconciliation",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  process.env = originalEnvironment;
  rmSync(root, { recursive: true, force: true });
}
