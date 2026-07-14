import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceDatabase } from "../lib/workspace/database";
import type { BlobStore, WorkspaceBlobCodec } from "../lib/workspace/blobStore";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import { WorkspaceDocumentsRepository } from "../lib/workspace/repositories/documents";
import { InMemoryDownloadCapabilityStore } from "../lib/workspace/downloadCapabilities";
import { WorkspaceDocumentsService, type WorkspaceBlobCleanupRecorder } from "../lib/workspace/services/documents";
import { WorkspaceDocumentCatalogService } from "../lib/workspace/services/documentCatalog";

class IdentityCodec implements WorkspaceBlobCodec {
  readonly encrypted = false;
  encode(args: Parameters<WorkspaceBlobCodec["encode"]>[0]) { return Buffer.from(args.plaintext); }
  decode(args: Parameters<WorkspaceBlobCodec["decode"]>[0]) { return Buffer.from(args.envelope); }
}

function expectThrow(fn: () => unknown, matcher: RegExp) {
  assert.throws(fn, (error: unknown) => matcher.test(error instanceof Error ? error.message : String(error)));
}

async function runAudit() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-document-catalog-audit-"));
  const databasePath = path.join(root, "workspace.sqlite");
  const blobRoot = path.join(root, "blobs");
  let database: WorkspaceDatabase | null = null;
  let now = 1_000;
  const receipts: unknown[] = [];
  const recorder: WorkspaceBlobCleanupRecorder = { record(input) { receipts.push(input); } };
  try {
    database = new WorkspaceDatabase(databasePath);
    const projectOne = randomUUID();
    const projectTwo = randomUUID();
    const folderOne = randomUUID();
    const folderTwo = randomUUID();
    database.prepare("INSERT INTO projects (id,name,status) VALUES (?,?,?)").run(projectOne, "Project One", "active");
    database.prepare("INSERT INTO projects (id,name,status) VALUES (?,?,?)").run(projectTwo, "Project Two", "active");
    database.prepare("INSERT INTO project_subfolders (id,project_id,name) VALUES (?,?,?)").run(folderOne, projectOne, "Folder One");
    database.prepare("INSERT INTO project_subfolders (id,project_id,name) VALUES (?,?,?)").run(folderTwo, projectTwo, "Folder Two");

    const blobs = new LocalWorkspaceBlobStore({ root: blobRoot, codec: new IdentityCodec(), allowUnencryptedCodec: true });
    const records = new WorkspaceBlobRecordsRepository(database);
    const repository = new WorkspaceDocumentsRepository(database, { blobRecords: records });
    const documents = new WorkspaceDocumentsService(repository, blobs, randomUUID, recorder);
    const capabilities = new InMemoryDownloadCapabilityStore({ clock: () => now, defaultTtlMs: 100, maxTtlMs: 1_000 });
    const catalog = new WorkspaceDocumentCatalogService(repository, documents, blobs, capabilities);

    const standalone = await documents.upload({ filename: "catalog.txt", mimetype: "text/plain", buffer: Buffer.from("catalog original") });
    assert.equal(catalog.list({ projectId: null }).length, 1);
    assert.equal(catalog.get(standalone.document.id)?.versions.length, 1);
    expectThrow(() => catalog.getVersion(standalone.document.id, randomUUID()), /Document version was not found/);
    assert.deepEqual(catalog.readOriginal(standalone.document.id, standalone.version.id).buffer, Buffer.from("catalog original"));
    assert.equal(JSON.stringify(catalog.get(standalone.document.id)).includes("storageKey"), false);
    assert.equal(JSON.stringify(catalog.get(standalone.document.id)).includes(blobRoot), false);

    catalog.attach(standalone.document.id, projectOne, folderOne);
    assert.equal(catalog.list({ projectId: projectOne, folderId: folderOne }).length, 1);
    expectThrow(() => catalog.move(standalone.document.id, projectTwo, folderOne), /placement conflicts/);
    catalog.move(standalone.document.id, projectTwo, folderTwo);
    catalog.detach(standalone.document.id);
    catalog.rename(standalone.document.id, "Renamed catalog");
    assert.equal(catalog.get(standalone.document.id)?.document.title, "Renamed catalog");
    assert.equal(catalog.get(standalone.document.id)?.document.filename, "Renamed catalog.txt");
    assert.equal(catalog.getVersion(standalone.document.id, standalone.version.id).filename, "Renamed catalog.txt");
    const filename240 = `${"b".repeat(236)}.txt`;
    const filename241 = `${"b".repeat(237)}.txt`;
    catalog.rename(standalone.document.id, filename240);
    assert.equal(catalog.get(standalone.document.id)?.document.filename.length, 240);
    expectThrow(() => catalog.rename(standalone.document.id, filename241), /request is invalid/);
    catalog.rename(standalone.document.id, "Renamed catalog");
    database.prepare("UPDATE projects SET status = 'archived' WHERE id = ?").run(projectOne);
    expectThrow(() => catalog.attach(standalone.document.id, projectOne, null), /placement conflicts/);

    const next = await catalog.uploadVersion(standalone.document.id, { filename: "catalog-v2.txt", mimetype: "text/plain", buffer: Buffer.from("catalog version two") });
    assert.equal(catalog.listVersions(standalone.document.id).length, 2);
    assert.deepEqual(catalog.readOriginal(standalone.document.id, standalone.version.id).buffer, Buffer.from("catalog original"));
    assert.deepEqual(catalog.readOriginal(standalone.document.id, next.version.id).buffer, Buffer.from("catalog version two"));
    expectThrow(() => catalog.readOriginal(standalone.document.id, randomUUID()), /version was not found/);

    const oldExtracted = blobs.putSync({ kind: "extracted_text", documentId: standalone.document.id, versionId: standalone.version.id }, Buffer.from("old version extracted"));
    repository.markParseStarted(standalone.document.id, standalone.version.id, standalone.job.id);
    repository.commitParseReady({
      documentId: standalone.document.id,
      versionId: standalone.version.id,
      jobId: standalone.job.id,
      chunks: [{ id: randomUUID(), ordinal: 0, text: "old version extracted", startOffset: 0, endOffset: 21, pageStart: null, pageEnd: null }],
      pageCount: null,
      extractedBlob: {
        recordId: randomUUID(),
        storageKey: `documents/${standalone.document.id}/versions/${standalone.version.id}/extracted`,
        sha256: oldExtracted.sha256,
        size: oldExtracted.size,
        storedSize: oldExtracted.storedSize,
        locator: { kind: "extracted_text", documentId: standalone.document.id, versionId: standalone.version.id },
      },
    });
    assert.equal(repository.getDocument(standalone.document.id)?.status, "pending");
    assert.equal(repository.getDocument(standalone.document.id)?.currentVersionId, next.version.id);
    const newExtracted = blobs.putSync({ kind: "extracted_text", documentId: standalone.document.id, versionId: next.version.id }, Buffer.from("new version extracted"));
    repository.markParseStarted(standalone.document.id, next.version.id, next.job.id);
    repository.commitParseReady({
      documentId: standalone.document.id,
      versionId: next.version.id,
      jobId: next.job.id,
      chunks: [{ id: randomUUID(), ordinal: 0, text: "new version extracted", startOffset: 0, endOffset: 21, pageStart: null, pageEnd: null }],
      pageCount: null,
      extractedBlob: {
        recordId: randomUUID(),
        storageKey: `documents/${standalone.document.id}/versions/${next.version.id}/extracted`,
        sha256: newExtracted.sha256,
        size: newExtracted.size,
        storedSize: newExtracted.storedSize,
        locator: { kind: "extracted_text", documentId: standalone.document.id, versionId: next.version.id },
      },
    });
    assert.equal(repository.getDocument(standalone.document.id)?.status, "ready");
    assert.equal(repository.getDocument(standalone.document.id)?.currentVersionId, next.version.id);
    expectThrow(() => catalog.deleteVersion(standalone.document.id, standalone.version.id), /version deletion is not supported/);
    expectThrow(() => catalog.restore(standalone.document.id), /restore is not supported/);

    const previewBytes = Buffer.from("preview bytes");
    const previewStored = blobs.putSync({ kind: "preview", documentId: standalone.document.id, versionId: next.version.id }, previewBytes);
    records.registerStored({
      locator: { kind: "preview", documentId: standalone.document.id, versionId: next.version.id },
      contentSha256: previewStored.sha256,
      sizeBytes: previewStored.size,
      storedSizeBytes: previewStored.storedSize,
    });
    expectThrow(() => catalog.readPreview(standalone.document.id, next.version.id), /metadata is unavailable/);
    const display = catalog.issueCapability(standalone.document.id, next.version.id, "display");
    const download = catalog.issueCapability(standalone.document.id, next.version.id, "download");
    expectThrow(() => catalog.issueCapability(standalone.document.id, next.version.id, "zip"), /not supported/);
    expectThrow(() => catalog.issueCapability(standalone.document.id, next.version.id, "docx"), /not supported/);
    assert.equal(catalog.readCapability(display.token).kind, "original");
    assert.equal(catalog.readCapability(download.token).kind, "original");
    assert.equal(catalog.resolveCapability(display.token, "display").purpose, "display");
    expectThrow(() => catalog.resolveCapability(display.token, "download"), /not found or has expired/);
    now += 101;
    expectThrow(() => catalog.readCapability(download.token), /not found or has expired/);
    const restartedCapabilities = new InMemoryDownloadCapabilityStore({ clock: () => now });
    assert.equal(restartedCapabilities.resolve(display.token), null);

    const tamperedBlobs = {
      putSync: blobs.putSync.bind(blobs),
      readSync() { return Buffer.from("tampered"); },
      stageDeleteSync: blobs.stageDeleteSync.bind(blobs),
      finalizeDeleteSync: blobs.finalizeDeleteSync.bind(blobs),
      restoreDeleteSync: blobs.restoreDeleteSync.bind(blobs),
    } as unknown as BlobStore;
    const tamperedCatalog = new WorkspaceDocumentCatalogService(repository, documents, tamperedBlobs, capabilities);
    expectThrow(() => tamperedCatalog.readOriginal(standalone.document.id, next.version.id), /storage integrity/);

    const failedVersionIds = [randomUUID(), randomUUID(), randomUUID()];
    const failedVersion = failedVersionIds[0];
    const failingRepository = {
      getDocument: repository.getDocument.bind(repository),
      getBlobRecordsRepository: repository.getBlobRecordsRepository.bind(repository),
      createPendingVersion() { throw new Error("injected version DB failure"); },
    } as unknown as WorkspaceDocumentsRepository;
    const failingService = new WorkspaceDocumentsService(
      failingRepository,
      blobs,
      () => failedVersionIds.shift() ?? randomUUID(),
      recorder,
    );
    const receiptsBeforeFailedVersion = receipts.length;
    await assert.rejects(() => failingService.uploadVersion(standalone.document.id, { filename: "failed.txt", mimetype: "text/plain", buffer: Buffer.from("compensate") }), /Document operation failed/);
    expectThrow(() => blobs.readSync({ kind: "original", documentId: standalone.document.id, versionId: failedVersion }, { sha256: "0".repeat(64), size: 10 }), /not found/);
    assert.equal(receipts.length, receiptsBeforeFailedVersion + 1);

    const broken = await documents.upload({ filename: "broken.txt", mimetype: "text/plain", buffer: Buffer.from("broken one") });
    const brokenV2 = await catalog.uploadVersion(broken.document.id, { filename: "broken-v2.txt", mimetype: "text/plain", buffer: Buffer.from("broken two") });
    database.prepare("UPDATE jobs SET status = 'failed', retryable = 0, completed_at = ? WHERE resource_type = 'document' AND resource_id = ?").run(new Date().toISOString(), broken.document.id);
    const missingRecord = records.getByLocator({ kind: "original", documentId: broken.document.id, versionId: broken.version.id });
    assert.ok(missingRecord);
    database.prepare("DELETE FROM workspace_blob_records WHERE id = ?").run(missingRecord.id);
    let stageCalls = 0;
    const countingBlobs = {
      putSync: blobs.putSync.bind(blobs),
      readSync: blobs.readSync.bind(blobs),
      stageDeleteSync(locator: Parameters<BlobStore["stageDeleteSync"]>[0]) { stageCalls += 1; return blobs.stageDeleteSync(locator); },
      finalizeDeleteSync: blobs.finalizeDeleteSync.bind(blobs),
      restoreDeleteSync: blobs.restoreDeleteSync.bind(blobs),
    } as unknown as BlobStore;
    const brokenCatalog = new WorkspaceDocumentCatalogService(repository, new WorkspaceDocumentsService(repository, countingBlobs, randomUUID, recorder), countingBlobs, capabilities);
    expectThrow(() => brokenCatalog.delete(broken.document.id), /storage integrity or cleanup failed/);
    assert.equal(stageCalls, 0);
    assert.equal(records.getById(missingRecord.id), null);
    assert.ok(brokenV2.version.id);

    database.prepare("UPDATE jobs SET status = 'queued', retryable = 1, completed_at = NULL WHERE id = ?").run(next.job.id);
    expectThrow(() => catalog.delete(standalone.document.id), /active parse job/);
    database.prepare("UPDATE jobs SET status = 'failed', retryable = 0, completed_at = ? WHERE resource_type = 'document' AND resource_id = ?").run(new Date().toISOString(), standalone.document.id);
    const deleted = catalog.delete(standalone.document.id);
    assert.equal(deleted.versionIds.length, 2);
    expectThrow(() => catalog.get(standalone.document.id), /resource was not found/);
    assert.deepEqual(catalog.list({ projectId: null }).map((item) => item.id), [broken.document.id]);
    expectThrow(() => catalog.readOriginal(standalone.document.id, next.version.id), /version was not found/);

    return {
      ok: true,
      suite: "vera-workspace-document-catalog-audit-v1m-c",
      checks: [
        "stable catalog list/detail/version projections without storage paths",
        "cross-project folder validation, standalone attach/detach, extension-preserving filename rename, and archived project rejection",
        "new version original/blob-record/job transaction and read isolation",
        "older parse completion cannot overwrite the newer current-version pending/ready state",
        "authoritative preview/original integrity verification and tamper rejection",
        "preview without explicit metadata is 409 and display falls back to original",
        "display/download/docx-purpose capability binding, expiry, and restart invalidation",
        "version delete/restore explicit unsupported errors",
        "soft delete visibility and version upload compensation",
      ],
    };
  } finally {
    database?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

runAudit()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
