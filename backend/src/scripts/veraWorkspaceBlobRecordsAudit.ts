import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceDatabase } from "../lib/workspace/database";
import type { WorkspaceBlobCodec } from "../lib/workspace/blobStore";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import { WorkspaceDocumentsRepository } from "../lib/workspace/repositories/documents";
import { WorkspaceDocumentParser } from "../lib/workspace/documentParsing";
import {
  WorkspaceDocumentsService,
  type WorkspaceBlobCleanupRecorder,
} from "../lib/workspace/services/documents";
import { WorkspaceBlobReconciliation } from "../lib/workspace/services/blobReconciliation";

class IdentityCodec implements WorkspaceBlobCodec {
  readonly encrypted = false;
  encode(args: Parameters<WorkspaceBlobCodec["encode"]>[0]) { return Buffer.from(args.plaintext); }
  decode(args: Parameters<WorkspaceBlobCodec["decode"]>[0]) { return Buffer.from(args.envelope); }
}

async function audit() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-blob-records-audit-"));
  const databasePath = path.join(root, "workspace.sqlite");
  const blobRoot = path.join(root, "blobs");
  const cleanup: unknown[] = [];
  const recorder: WorkspaceBlobCleanupRecorder = { record(input) { cleanup.push(input); } };
  let database: WorkspaceDatabase | null = null;
  try {
    database = new WorkspaceDatabase(databasePath);
    const blobs = new LocalWorkspaceBlobStore({ root: blobRoot, codec: new IdentityCodec(), allowUnencryptedCodec: true });
    let records = new WorkspaceBlobRecordsRepository(database);
    let repository = new WorkspaceDocumentsRepository(database, { blobRecords: records });
    const service = new WorkspaceDocumentsService(repository, blobs, undefined, recorder);

    const created = await service.upload({ filename: "authoritative.txt", mimetype: "text/plain", buffer: Buffer.from("authoritative text") });
      const original = records.getByLocator({ kind: "original", documentId: created.document.id, versionId: created.version.id });
      assert.ok(original);
      assert.equal(original.storageKey, `documents/${created.document.id}/versions/${created.version.id}/original`);
      assert.equal(original.sizeBytes, created.version.sizeBytes);
      assert.deepEqual(blobs.readSync(original.locator, { sha256: original.contentSha256, size: original.sizeBytes }), Buffer.from("authoritative text"));

      const parser = new WorkspaceDocumentParser(repository, blobs, undefined, undefined, recorder);
      const parsed = await parser.process({ documentId: created.document.id, versionId: created.version.id, jobId: created.job.id });
      assert.equal(parsed.status, "ready");
      const extracted = records.getByLocator({ kind: "extracted_text", documentId: created.document.id, versionId: created.version.id });
      assert.ok(extracted);
      assert.deepEqual(blobs.readSync(extracted.locator, { sha256: extracted.contentSha256, size: extracted.sizeBytes }), Buffer.from("authoritative text"));

      const preview = blobs.putSync({ kind: "preview", documentId: created.document.id, versionId: created.version.id }, Buffer.from("preview"));
      records.registerStored({ locator: { kind: "preview", documentId: created.document.id, versionId: created.version.id }, contentSha256: preview.sha256, sizeBytes: preview.size, storedSizeBytes: preview.storedSize });
      assert.equal(records.listForDocument(created.document.id).filter((record) => record.locator.kind === "preview").length, 1);

      const stagedBeforeRestart = blobs.stageDeleteSync(original.locator);
      database?.close();
      database = new WorkspaceDatabase(databasePath);
      records = new WorkspaceBlobRecordsRepository(database);
      repository = new WorkspaceDocumentsRepository(database, { blobRecords: records });
      const reconciliation = new WorkspaceBlobReconciliation(records, blobs, repository);
      assert.deepEqual(reconciliation.reconcile(), { restored: 1, finalized: 0, conflicts: 0 });
      assert.deepEqual(blobs.readSync(original.locator, { sha256: original.contentSha256, size: original.sizeBytes }), Buffer.from("authoritative text"));

      const stagedForDelete = blobs.stageDeleteSync(original.locator);
      records.quarantine(original.id, stagedForDelete.quarantineId);
      database.prepare("UPDATE document_versions SET deleted_at = ? WHERE document_id = ?").run(new Date().toISOString(), created.document.id);
      database.prepare("UPDATE documents SET deleted_at = ?, current_version_id = NULL WHERE id = ?").run(new Date().toISOString(), created.document.id);
      database.close();
      database = new WorkspaceDatabase(databasePath);
      records = new WorkspaceBlobRecordsRepository(database);
      repository = new WorkspaceDocumentsRepository(database, { blobRecords: records });
      const restartedReconciliation = new WorkspaceBlobReconciliation(records, blobs, repository);
      assert.deepEqual(restartedReconciliation.reconcile(), { restored: 0, finalized: 1, conflicts: 0 });
      assert.equal(records.getById(original.id), null);

      const reopenedService = new WorkspaceDocumentsService(repository, blobs, undefined, recorder);
      const failure = await reopenedService.upload({ filename: "failure-delete.txt", mimetype: "text/plain", buffer: Buffer.from("retain record") });
      const failingBlobStore = {
        putSync: blobs.putSync.bind(blobs),
        readSync: blobs.readSync.bind(blobs),
        stageDeleteSync: blobs.stageDeleteSync.bind(blobs),
        restoreDeleteSync: blobs.restoreDeleteSync.bind(blobs),
        finalizeDeleteSync() { throw new Error("injected finalize failure"); },
      } as unknown as typeof blobs;
      database.prepare("UPDATE jobs SET status = 'failed', retryable = 0, completed_at = ? WHERE resource_type = 'document' AND resource_id = ?").run(new Date().toISOString(), failure.document.id);
      assert.throws(() => new WorkspaceDocumentsService(repository, failingBlobStore, undefined, recorder).deleteDocument(failure.document.id), /cleanup is pending/);
      assert.ok(records.listQuarantined().some((record) => record.locator.kind === "original" && record.locator.documentId === failure.document.id));
      assert.ok(cleanup.length > 0);

      const legacy = await reopenedService.upload({ filename: "legacy.txt", mimetype: "text/plain", buffer: Buffer.from("legacy") });
      const legacyPreview = blobs.putSync({ kind: "preview", documentId: legacy.document.id, versionId: legacy.version.id }, Buffer.from("legacy sentinel"));
      database.prepare("UPDATE document_versions SET preview_storage_key = ? WHERE id = ?").run(`documents/${legacy.document.id}/versions/${legacy.version.id}/preview`, legacy.version.id);
      assert.ok(legacyPreview.size > 0);
      database.prepare("UPDATE jobs SET status = 'failed', retryable = 0, completed_at = ? WHERE resource_type = 'document' AND resource_id = ?").run(new Date().toISOString(), legacy.document.id);
      reopenedService.deleteDocument(legacy.document.id);
      assert.deepEqual(blobs.readSync({ kind: "preview", documentId: legacy.document.id, versionId: legacy.version.id }, { sha256: legacyPreview.sha256, size: legacyPreview.size }), Buffer.from("legacy sentinel"));

      return {
        ok: true,
        suite: "vera-workspace-blob-records-audit-v2",
        checks: [
          "v2 authoritative original/extracted/preview records with deterministic locators",
          "stored hash/size integrity reads",
          "staged restore and quarantined finalize across database restart",
          "finalize failure retains quarantined record and durable cleanup receipt",
          "legacy preview sentinel is not silently treated as authoritative",
        ],
      };
  } finally {
    // The promise path owns async assertions; this cleanup is intentionally best effort for the audit process.
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

audit()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
