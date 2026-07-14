import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Document, Packer, Paragraph } from "docx";
import { WorkspaceDatabase } from "../lib/workspace/database";
import type { BlobStore, WorkspaceBlobCodec, WorkspaceBlobLocator } from "../lib/workspace/blobStore";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { WorkspaceBlobCleanupRepository } from "../lib/workspace/repositories/blobCleanup";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import {
  DocumentParseClaimLostError,
  WorkspaceDocumentsRepository,
  type DocumentParseClaim,
} from "../lib/workspace/repositories/documents";
import {
  WorkspaceBlobCleanupPendingError,
  WorkspaceDocumentsService,
  type DocumentResourceLifecyclePort,
  type WorkspaceBlobCleanupRecorder,
} from "../lib/workspace/services/documents";
import { WorkspaceDocumentParser } from "../lib/workspace/documentParsing";
import { WorkspaceBlobCleanupReplay } from "../lib/workspace/services/blobCleanup";

class IdentityCodec implements WorkspaceBlobCodec {
  readonly encrypted = false;
  encode(args: Parameters<WorkspaceBlobCodec["encode"]>[0]) {
    return Buffer.from(args.plaintext);
  }
  decode(args: Parameters<WorkspaceBlobCodec["decode"]>[0]) {
    return Buffer.from(args.envelope);
  }
}

type ErrorMatcher = string | RegExp | ((error: unknown) => boolean);

function matchesError(error: unknown, matcher?: ErrorMatcher) {
  if (!matcher) return true;
  if (typeof matcher === "function") return matcher(error);
  const text = error instanceof Error ? error.message : String(error);
  return typeof matcher === "string" ? text.includes(matcher) : matcher.test(text);
}

function expectThrow(fn: () => unknown, message?: ErrorMatcher) {
  assert.throws(fn, (error: unknown) => matchesError(error, message));
}

async function expectReject(fn: () => Promise<unknown>, message?: ErrorMatcher) {
  try {
    await fn();
  } catch (error) {
    assert.equal(matchesError(error, message), true);
    return;
  }
  assert.fail("Expected promise rejection.");
}

async function docxFixture() {
  const document = new Document({
    sections: [{ children: [new Paragraph("DOCX fixture for Vera workspace parsing.")] }],
  });
  return Packer.toBuffer(document);
}

function project(database: WorkspaceDatabase, id: string, name: string) {
  database.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(id, name);
}

function folder(database: WorkspaceDatabase, id: string, projectId: string) {
  database.prepare("INSERT INTO project_subfolders (id, project_id, name) VALUES (?, ?, ?)").run(id, projectId, "Folder");
}

function claimDocumentJob(
  database: WorkspaceDatabase,
  jobId: string,
  leaseOwner = `vera-document-audit-${randomUUID()}`,
): DocumentParseClaim {
  const at = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  database.prepare(
    `UPDATE jobs
        SET status = 'running', attempt = attempt + 1, lease_owner = ?,
            lease_expires_at = ?, locked_at = ?, started_at = coalesce(started_at, ?),
            cancel_requested_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'queued'`,
  ).run(leaseOwner, expiresAt, expiresAt, at, at, jobId);
  const row = database.prepare("SELECT attempt, lease_owner FROM jobs WHERE id = ?").get(jobId);
  assert.equal(row?.lease_owner, leaseOwner);
  return { leaseOwner, attempt: Number(row?.attempt) };
}

function seedQueuedTabularCell(
  database: WorkspaceDatabase,
  documentId: string,
  projectId: string | null,
) {
  const reviewId = randomUUID();
  const columnId = randomUUID();
  const cellId = randomUUID();
  const jobId = randomUUID();
  const at = new Date().toISOString();
  database.prepare(
    `INSERT INTO tabular_reviews
      (id, project_id, title, status, document_ids_json, columns_config_json, created_at, updated_at)
     VALUES (?, ?, 'Delete dependency audit', 'running', ?, '[]', ?, ?)`,
  ).run(reviewId, projectId, JSON.stringify([documentId]), at, at);
  database.prepare(
    "INSERT INTO tabular_review_documents (review_id, document_id, ordinal, created_at) VALUES (?, ?, 0, ?)",
  ).run(reviewId, documentId, at);
  database.prepare(
    `INSERT INTO tabular_review_columns
      (id, review_id, key, title, output_type, prompt, ordinal, created_at, updated_at)
     VALUES (?, ?, 'result', 'Result', 'text', '', 0, ?, ?)`,
  ).run(columnId, reviewId, at, at);
  database.prepare(
    `INSERT INTO jobs
      (id, type, status, resource_type, resource_id, idempotency_key,
       payload_json, scheduled_at, created_at, updated_at)
     VALUES (?, 'tabular_cell', 'queued', 'tabular_cell', ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobId,
    cellId,
    `delete-audit:${jobId}`,
    JSON.stringify({ reviewId, documentId, columnId }),
    at,
    at,
    at,
  );
  database.prepare(
    `INSERT INTO tabular_cells
      (id, review_id, document_id, column_id, output_type, status, job_id, attempt, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'text', 'queued', ?, 1, ?, ?)`,
  ).run(cellId, reviewId, documentId, columnId, jobId, at, at);
  return { reviewId, columnId, cellId, jobId };
}

async function runAudit() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-documents-audit-"));
  const databasePath = path.join(root, "workspace.sqlite");
  const blobRoot = path.join(root, "blobs");
  const projectId = randomUUID();
  const folderId = randomUUID();
  const otherProjectId = randomUUID();
  let database: WorkspaceDatabase | null = null;
  let extractedCrashDatabase: WorkspaceDatabase | null = null;
  let cleanupLedger: WorkspaceBlobCleanupRepository | null = null;
  const cleanupReceipts: unknown[] = [];
  const recorder: WorkspaceBlobCleanupRecorder = {
    record(input) {
      cleanupReceipts.push(input);
      if (!cleanupLedger) throw new Error("cleanup ledger is unavailable");
      cleanupLedger.record(input);
    },
  };

  try {
    database = new WorkspaceDatabase(databasePath);
    cleanupLedger = new WorkspaceBlobCleanupRepository(database);
    project(database, projectId, "Audit project");
    project(database, otherProjectId, "Other project");
    folder(database, folderId, projectId);
    const blobs = new LocalWorkspaceBlobStore({
      root: blobRoot,
      codec: new IdentityCodec(),
      allowUnencryptedCodec: true,
    });
    let blobRecords = new WorkspaceBlobRecordsRepository(database);
    let repository = new WorkspaceDocumentsRepository(database, { blobRecords });
    const service = new WorkspaceDocumentsService(repository, blobs, randomUUID, recorder);

    await expectReject(
      () => service.upload({ filename: "../escape.txt", mimetype: "text/plain", buffer: Buffer.from("x") }),
      /request is invalid/,
    );
    await expectReject(
      () => service.upload({ filename: "bad.pdf", mimetype: "application/pdf", buffer: Buffer.from("not-pdf") }),
      /request is invalid/,
    );
    await expectReject(
      () => service.upload({ filename: "bad.txt", mimetype: "application/pdf", buffer: Buffer.from("text") }),
      /request is invalid/,
    );
    await expectReject(
      () => service.upload({ filename: "wrong-project.txt", mimetype: "text/plain", buffer: Buffer.from("x"), projectId: otherProjectId, folderId }),
      /placement conflicts/,
    );
    await expectReject(
      () => service.upload({ filename: "too-large.txt", mimetype: "text/plain", buffer: Buffer.alloc(100 * 1024 * 1024 + 1) }),
      /request is invalid/,
    );
    const filename240 = `${"a".repeat(236)}.txt`;
    const filename241 = `${"a".repeat(237)}.txt`;
    const maxFilenameUpload = await service.upload({ filename: filename240, mimetype: "text/plain", buffer: Buffer.from("filename boundary") });
    assert.equal(maxFilenameUpload.document.filename.length, 240);
    await expectReject(
      () => service.upload({ filename: filename241, mimetype: "text/plain", buffer: Buffer.from("filename boundary") }),
      /request is invalid/,
    );
    await expectReject(
      () => Promise.resolve(service.rename(maxFilenameUpload.document.id, filename241)),
      /request is invalid/,
    );

    const textBytes = Buffer.from("alpha workspace search\nsecond paragraph");
    const uploaded = await service.upload({
      filename: "notes.txt",
      mimetype: "text/plain",
      buffer: textBytes,
      projectId,
      folderId,
    });
    assert.equal(uploaded.document.currentVersionId, uploaded.version.id);
    assert.equal(uploaded.document.status, "pending");
    assert.equal("storageKey" in uploaded.version, false);
    assert.equal(JSON.stringify(uploaded).includes(root), false);
    assert.equal(JSON.stringify(uploaded).includes("/documents/"), false);
    const storedVersion = repository.getVersion(uploaded.document.id, uploaded.version.id);
    assert.ok(storedVersion);
    assert.equal(storedVersion.storageKey, `documents/${uploaded.document.id}/versions/${uploaded.version.id}/original`);

    const crashUploadIds = [randomUUID(), randomUUID(), randomUUID()];
    const crashDocumentId = crashUploadIds[0];
    const crashVersionId = crashUploadIds[1];
    const crashAfterPut = {
      putSync(locator: WorkspaceBlobLocator, plaintext: Buffer) {
        blobs.putSync(locator, plaintext);
        throw new Error("simulated process crash after blob put");
      },
    } as unknown as BlobStore;
    const crashUploadService = new WorkspaceDocumentsService(
      repository,
      crashAfterPut,
      () => crashUploadIds.shift() ?? randomUUID(),
      recorder,
    );
    await expectReject(
      () => crashUploadService.upload({ filename: "crash-upload.txt", mimetype: "text/plain", buffer: Buffer.from("orphan upload") }),
      /storage integrity or cleanup failed/,
    );
    assert.equal(repository.getDocument(crashDocumentId), null);

    const crashVersionIds = [randomUUID(), randomUUID()];
    const crashNewVersionId = crashVersionIds[0];
    const crashVersionService = new WorkspaceDocumentsService(
      repository,
      crashAfterPut,
      () => crashVersionIds.shift() ?? randomUUID(),
      recorder,
    );
    await expectReject(
      () => crashVersionService.uploadVersion(uploaded.document.id, { filename: "crash-version.txt", mimetype: "text/plain", buffer: Buffer.from("orphan version") }),
      /storage integrity or cleanup failed/,
    );
    assert.equal(repository.getVersion(uploaded.document.id, crashNewVersionId), null);
    assert.ok(cleanupLedger);
    const crashUploadIntent = cleanupLedger.listPending().find((intent) => intent.documentId === crashDocumentId && intent.versionId === crashVersionId);
    const crashVersionIntent = cleanupLedger.listPending().find((intent) => intent.documentId === uploaded.document.id && intent.versionId === crashNewVersionId);
    assert.ok(crashUploadIntent);
    assert.ok(crashVersionIntent);
    const replayedUploads = new WorkspaceBlobCleanupReplay(cleanupLedger, blobRecords, blobs).replayPending();
    assert.ok(replayedUploads.finalized >= 2);
    assert.equal(cleanupLedger.getById(crashUploadIntent.id)?.status, "resolved");
    assert.equal(cleanupLedger.getById(crashVersionIntent.id)?.status, "resolved");
    expectThrow(() => blobs.stageDeleteSync({ kind: "original", documentId: crashDocumentId, versionId: crashVersionId }), (error) => error instanceof Error && error.name === "WorkspaceBlobNotFoundError");
    expectThrow(() => blobs.stageDeleteSync({ kind: "original", documentId: uploaded.document.id, versionId: crashNewVersionId }), (error) => error instanceof Error && error.name === "WorkspaceBlobNotFoundError");

    const extractedCrashDatabasePath = path.join(root, "extracted-crash.sqlite");
    const extractedCrashBlobs = new LocalWorkspaceBlobStore({
      root: path.join(root, "extracted-crash-blobs"),
      codec: new IdentityCodec(),
      allowUnencryptedCodec: true,
    });
    extractedCrashDatabase = new WorkspaceDatabase(extractedCrashDatabasePath);
    let extractedCrashRecords = new WorkspaceBlobRecordsRepository(extractedCrashDatabase);
    let extractedCrashRepository = new WorkspaceDocumentsRepository(extractedCrashDatabase, {
      blobRecords: extractedCrashRecords,
    });
    let extractedCrashLedger = new WorkspaceBlobCleanupRepository(extractedCrashDatabase);
    const extractedCrashRecorder: WorkspaceBlobCleanupRecorder = {
      record(input) {
        extractedCrashLedger.record(input);
      },
    };
    const extractedCrashService = new WorkspaceDocumentsService(
      extractedCrashRepository,
      extractedCrashBlobs,
      randomUUID,
      extractedCrashRecorder,
    );
    const extractedCrashUpload = await extractedCrashService.upload({
      filename: "extracted-crash.txt",
      mimetype: "text/plain",
      buffer: Buffer.from("derived crash boundary"),
    });
    const extractedCrashLocator = {
      kind: "extracted_text",
      documentId: extractedCrashUpload.document.id,
      versionId: extractedCrashUpload.version.id,
    } as const;
    let crashedExtractedSha256 = "";
    let crashedExtractedSize = -1;
    const extractedCrashStore = {
      putSync(locator: WorkspaceBlobLocator, plaintext: Buffer) {
        const stored = extractedCrashBlobs.putSync(locator, plaintext);
        if (locator.kind === "extracted_text") {
          crashedExtractedSha256 = stored.sha256;
          crashedExtractedSize = stored.size;
          throw new Error("simulated process crash after extracted put");
        }
        return stored;
      },
      readSync: extractedCrashBlobs.readSync.bind(extractedCrashBlobs),
      stageDeleteSync: extractedCrashBlobs.stageDeleteSync.bind(extractedCrashBlobs),
      finalizeDeleteSync: extractedCrashBlobs.finalizeDeleteSync.bind(extractedCrashBlobs),
      restoreDeleteSync: extractedCrashBlobs.restoreDeleteSync.bind(extractedCrashBlobs),
    } as unknown as BlobStore;
    const extractedCrashParser = new WorkspaceDocumentParser(
      extractedCrashRepository,
      extractedCrashStore,
      undefined,
      randomUUID,
      extractedCrashRecorder,
    );
    const extractedCrashResult = await extractedCrashParser.process({
      documentId: extractedCrashUpload.document.id,
      versionId: extractedCrashUpload.version.id,
      jobId: extractedCrashUpload.job.id,
    });
    assert.equal(extractedCrashResult.status, "failed");
    assert.equal(extractedCrashRecords.getByLocator(extractedCrashLocator), null);
    assert.deepEqual(
      extractedCrashBlobs.readSync(extractedCrashLocator, {
        sha256: crashedExtractedSha256,
        size: crashedExtractedSize,
      }),
      Buffer.from("derived crash boundary"),
    );
    const extractedCrashIntent = extractedCrashLedger.listPending().find((intent) =>
      intent.operation === "compensation" &&
      intent.locator.kind === "extracted_text" &&
      intent.documentId === extractedCrashUpload.document.id &&
      intent.versionId === extractedCrashUpload.version.id
    );
    assert.ok(extractedCrashIntent);

    extractedCrashDatabase.close();
    extractedCrashDatabase = new WorkspaceDatabase(extractedCrashDatabasePath);
    extractedCrashRecords = new WorkspaceBlobRecordsRepository(extractedCrashDatabase);
    extractedCrashRepository = new WorkspaceDocumentsRepository(extractedCrashDatabase, {
      blobRecords: extractedCrashRecords,
    });
    extractedCrashLedger = new WorkspaceBlobCleanupRepository(extractedCrashDatabase);
    assert.deepEqual(
      new WorkspaceBlobCleanupReplay(
        extractedCrashLedger,
        extractedCrashRecords,
        extractedCrashBlobs,
      ).replayPending(),
      { resolved: 2, restored: 0, finalized: 1, retained: 1 },
    );
    assert.equal(extractedCrashLedger.getById(extractedCrashIntent.id)?.status, "resolved");
    expectThrow(
      () => extractedCrashBlobs.stageDeleteSync(extractedCrashLocator),
      (error) => error instanceof Error && error.name === "WorkspaceBlobNotFoundError",
    );
    assert.ok(
      extractedCrashRepository.getVersion(
        extractedCrashUpload.document.id,
        extractedCrashUpload.version.id,
      ),
    );
    assert.deepEqual(
      extractedCrashBlobs.readSync(
        {
          kind: "original",
          documentId: extractedCrashUpload.document.id,
          versionId: extractedCrashUpload.version.id,
        },
        {
          sha256: extractedCrashUpload.version.contentSha256,
          size: extractedCrashUpload.version.sizeBytes,
        },
      ),
      Buffer.from("derived crash boundary"),
    );
    extractedCrashDatabase.close();
    extractedCrashDatabase = null;

    let failClosedPutCount = 0;
    const failClosedBlobs = {
      putSync(locator: WorkspaceBlobLocator, plaintext: Buffer) {
        failClosedPutCount += 1;
        return blobs.putSync(locator, plaintext);
      },
    } as unknown as BlobStore;
    const failingIntentRecorder: WorkspaceBlobCleanupRecorder = { record() { throw new Error("injected cleanup ledger failure"); } };
    const failClosedService = new WorkspaceDocumentsService(repository, failClosedBlobs, randomUUID, failingIntentRecorder);
    await expectReject(
      () => failClosedService.upload({ filename: "ledger-failure.txt", mimetype: "text/plain", buffer: Buffer.from("never written") }),
      /cleanup is pending/,
    );
    await expectReject(
      () => failClosedService.uploadVersion(uploaded.document.id, { filename: "ledger-failure-v2.txt", mimetype: "text/plain", buffer: Buffer.from("never written") }),
      /cleanup is pending/,
    );
    assert.equal(failClosedPutCount, 0);
    expectThrow(
      () => repository.createPendingDocument({
        documentId: randomUUID(),
        versionId: randomUUID(),
        jobId: randomUUID(),
        projectId,
        folderId,
        title: "invalid",
        filename: "invalid.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        contentSha256: "0".repeat(64),
        storageKey: "arbitrary/path",
      }),
      /deterministic document locator/,
    );

    const parser = new WorkspaceDocumentParser(repository, blobs, undefined, randomUUID, recorder);
    const parsed = await parser.process({ documentId: uploaded.document.id, versionId: uploaded.version.id, jobId: uploaded.job.id });
    assert.equal(parsed.status, "ready");
    assert.ok(parsed.chunkCount >= 1);
    const ready = repository.getDocument(uploaded.document.id);
    assert.equal(ready?.status, "ready");
    assert.ok(repository.searchChunks("workspace", { documentId: uploaded.document.id }).length >= 1);
    assert.equal(repository.lastSearchMode, "fts");
    assert.equal(repository.getJob(uploaded.job.id)?.status, "complete");
    const readyJobResult = database.prepare("SELECT result_json FROM jobs WHERE id = ?").get(uploaded.job.id) as { result_json?: string };
    assert.match(String(readyJobResult.result_json), /extractedBlob/);

    const runtimeUpload = await service.upload({ filename: "runtime-handler.txt", mimetype: "text/plain", buffer: Buffer.from("runtime-managed parse") });
    const runtimeContext = {
      signal: new AbortController().signal,
      job: {
        id: runtimeUpload.job.id,
        resourceId: runtimeUpload.document.id,
        payload: { documentId: runtimeUpload.document.id, versionId: runtimeUpload.version.id },
      },
    };
    await expectReject(
      () => parser.handleJob(runtimeContext),
      (error) => error instanceof DocumentParseClaimLostError,
    );
    assert.equal(repository.getDocument(runtimeUpload.document.id)?.status, "pending");
    const runtimeClaim = claimDocumentJob(database, runtimeUpload.job.id);
    const runtimeParsed = await parser.handleJob({
      ...runtimeContext,
      claim: runtimeClaim,
    });
    assert.equal(runtimeParsed.status, "ready");
    assert.equal(repository.getJob(runtimeUpload.job.id)?.status, "running");
    const firstRuntimeRecord = blobRecords.getByLocator({ kind: "extracted_text", documentId: runtimeUpload.document.id, versionId: runtimeUpload.version.id });
    assert.ok(firstRuntimeRecord);
    const firstRuntimeChunks = repository.searchChunks("runtime", { documentId: runtimeUpload.document.id });
    assert.ok(firstRuntimeChunks.length > 0);

    database.prepare(
      "UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, cancel_requested_at = NULL WHERE id = ?",
    ).run(runtimeUpload.job.id);
    const retryRuntimeClaim = claimDocumentJob(database, runtimeUpload.job.id);
    let retryExtractedPutCount = 0;
    const noOverwriteBlobs = {
      putSync(locator: WorkspaceBlobLocator, plaintext: Buffer) {
        if (locator.kind === "extracted_text") retryExtractedPutCount += 1;
        return blobs.putSync(locator, plaintext);
      },
      readSync: blobs.readSync.bind(blobs),
      stageDeleteSync: blobs.stageDeleteSync.bind(blobs),
      finalizeDeleteSync: blobs.finalizeDeleteSync.bind(blobs),
      restoreDeleteSync: blobs.restoreDeleteSync.bind(blobs),
    } as unknown as BlobStore;
    const idempotentParser = new WorkspaceDocumentParser(repository, noOverwriteBlobs, undefined, randomUUID, recorder);
    const retriedAfterCommit = await idempotentParser.handleJob({ ...runtimeContext, claim: retryRuntimeClaim });
    assert.equal(retriedAfterCommit.status, "ready");
    assert.equal(retryExtractedPutCount, 0);
    assert.equal(
      blobRecords.getByLocator({ kind: "extracted_text", documentId: runtimeUpload.document.id, versionId: runtimeUpload.version.id })?.id,
      firstRuntimeRecord.id,
    );

    database.prepare(
      "UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL, cancel_requested_at = NULL WHERE id = ?",
    ).run(runtimeUpload.job.id);
    const conflictingRuntimeClaim = claimDocumentJob(database, runtimeUpload.job.id);
    const conflictingParser = new WorkspaceDocumentParser(repository, noOverwriteBlobs, async () => ({
      text: "different extracted content",
      metadata: { parser: "deterministic" },
    }), randomUUID, recorder);
    await expectReject(
      () => conflictingParser.handleJob({ ...runtimeContext, claim: conflictingRuntimeClaim }),
      /DOCUMENT_EXTRACTED_BLOB_CONFLICT/,
    );
    assert.equal(retryExtractedPutCount, 0);
    const preservedRuntimeRecord = blobRecords.getByLocator({ kind: "extracted_text", documentId: runtimeUpload.document.id, versionId: runtimeUpload.version.id });
    assert.equal(preservedRuntimeRecord?.id, firstRuntimeRecord.id);
    assert.deepEqual(
      blobs.readSync(firstRuntimeRecord.locator, { sha256: firstRuntimeRecord.contentSha256, size: firstRuntimeRecord.sizeBytes }),
      Buffer.from("runtime-managed parse"),
    );
    assert.deepEqual(
      repository.searchChunks("runtime", { documentId: runtimeUpload.document.id }).map((chunk) => chunk.id),
      firstRuntimeChunks.map((chunk) => chunk.id),
    );
    assert.equal(
      database.prepare("SELECT parse_error_code FROM documents WHERE id = ?").get(runtimeUpload.document.id)?.parse_error_code,
      "document_extracted_blob_conflict",
    );

    const staleUpload = await service.upload({ filename: "stale-worker.txt", mimetype: "text/plain", buffer: Buffer.from("stale worker") });
    const staleClaim = claimDocumentJob(database, staleUpload.job.id, "stale-worker-owner");
    let staleExtractedPutCount = 0;
    let staleIntentObservedBeforePut = false;
    const staleWorkerBlobs = {
      putSync(locator: WorkspaceBlobLocator, plaintext: Buffer) {
        if (locator.kind === "extracted_text") {
          staleIntentObservedBeforePut = Boolean(cleanupLedger?.listPending().some((intent) =>
            intent.locator.kind === "extracted_text" &&
            intent.documentId === locator.documentId &&
            intent.versionId === locator.versionId
          ));
        }
        const stored = blobs.putSync(locator, plaintext);
        if (locator.kind === "extracted_text") {
          staleExtractedPutCount += 1;
          database?.prepare(
            "UPDATE jobs SET lease_owner = ?, attempt = attempt + 1, lease_expires_at = ? WHERE id = ?",
          ).run("replacement-worker-owner", new Date(Date.now() + 60_000).toISOString(), staleUpload.job.id);
        }
        return stored;
      },
      readSync: blobs.readSync.bind(blobs),
      stageDeleteSync: blobs.stageDeleteSync.bind(blobs),
      finalizeDeleteSync: blobs.finalizeDeleteSync.bind(blobs),
      restoreDeleteSync: blobs.restoreDeleteSync.bind(blobs),
    } as unknown as BlobStore;
    const staleParser = new WorkspaceDocumentParser(repository, staleWorkerBlobs, undefined, randomUUID, recorder);
    await expectReject(
      () => staleParser.handleJob({
        signal: new AbortController().signal,
        job: {
          id: staleUpload.job.id,
          resourceId: staleUpload.document.id,
          payload: { documentId: staleUpload.document.id, versionId: staleUpload.version.id },
        },
        claim: staleClaim,
      }),
      (error) => error instanceof DocumentParseClaimLostError,
    );
    assert.equal(staleExtractedPutCount, 1);
    assert.equal(staleIntentObservedBeforePut, true);
    assert.equal(blobRecords.getByLocator({ kind: "extracted_text", documentId: staleUpload.document.id, versionId: staleUpload.version.id }), null);
    assert.equal(repository.searchChunks("stale", { documentId: staleUpload.document.id }).length, 0);
    expectThrow(
      () => blobs.stageDeleteSync({ kind: "extracted_text", documentId: staleUpload.document.id, versionId: staleUpload.version.id }),
      (error) => error instanceof Error && error.name === "WorkspaceBlobNotFoundError",
    );

    const parseIntentFailureUpload = await service.upload({ filename: "parse-intent-failure.txt", mimetype: "text/plain", buffer: Buffer.from("parse intent failure") });
    let parseIntentFailurePutCount = 0;
    const parseIntentFailureBlobs = {
      putSync(locator: WorkspaceBlobLocator, plaintext: Buffer) {
        if (locator.kind === "extracted_text") parseIntentFailurePutCount += 1;
        return blobs.putSync(locator, plaintext);
      },
      readSync: blobs.readSync.bind(blobs),
      stageDeleteSync: blobs.stageDeleteSync.bind(blobs),
      finalizeDeleteSync: blobs.finalizeDeleteSync.bind(blobs),
      restoreDeleteSync: blobs.restoreDeleteSync.bind(blobs),
    } as unknown as BlobStore;
    const parseIntentFailureParser = new WorkspaceDocumentParser(
      repository,
      parseIntentFailureBlobs,
      undefined,
      randomUUID,
      failingIntentRecorder,
    );
    await expectReject(
      () => parseIntentFailureParser.process({
        documentId: parseIntentFailureUpload.document.id,
        versionId: parseIntentFailureUpload.version.id,
        jobId: parseIntentFailureUpload.job.id,
      }),
      (error) => error instanceof WorkspaceBlobCleanupPendingError,
    );
    assert.equal(parseIntentFailurePutCount, 0);

    const compensationIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const compensationDocumentId = compensationIds[0];
    const compensationVersionId = compensationIds[1];
    const compensationRepository = {
      getBlobRecordsRepository() {
        return {};
      },
      createPendingDocument() {
        throw new Error("injected document DB failure");
      },
    } as unknown as WorkspaceDocumentsRepository;
    const compensationService = new WorkspaceDocumentsService(
      compensationRepository,
      blobs,
      () => {
        const value = compensationIds.shift();
        if (!value) throw new Error("audit ID exhaustion");
        return value;
      },
      recorder,
    );
    await expectReject(
      () => compensationService.upload({ filename: "db-failure.txt", mimetype: "text/plain", buffer: Buffer.from("compensate") }),
      /Document operation failed/,
    );
    assert.equal(
      existsSync(path.join(blobRoot, "documents", compensationDocumentId, "versions", compensationVersionId, "original")),
      false,
    );

    const sameName = await service.upload({ filename: "notes.txt", mimetype: "text/plain", buffer: Buffer.from("same name but another UUID") });
    assert.notEqual(sameName.document.id, uploaded.document.id);

    const docx = await docxFixture();
    const docxUpload = await service.upload({
      filename: "fixture.docx",
      mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: docx,
    });
    const docxParsed = await parser.process({ documentId: docxUpload.document.id, versionId: docxUpload.version.id, jobId: docxUpload.job.id });
    assert.equal(docxParsed.status, "ready");
    assert.ok(repository.searchChunks("DOCX fixture", { documentId: docxUpload.document.id }).length >= 1);

    const scanUpload = await service.upload({ filename: "scan.pdf", mimetype: "application/pdf", buffer: Buffer.from("%PDF-1.7\n") });
    const scanParser = new WorkspaceDocumentParser(repository, blobs, async () => ({
      text: "",
      metadata: { parser: "pdf", pageCount: 1, textLayerPageCount: 0 },
    }), randomUUID, recorder);
    const scanResult = await scanParser.process({ documentId: scanUpload.document.id, versionId: scanUpload.version.id, jobId: scanUpload.job.id });
    assert.equal(scanResult.status, "ocr_required");
    assert.equal(repository.getDocument(scanUpload.document.id)?.status, "ocr_required");

    const failedUpload = await service.upload({ filename: "failure.txt", mimetype: "text/plain", buffer: Buffer.from("must retain original") });
    const failingParser = new WorkspaceDocumentParser(repository, blobs, async () => {
      throw new Error("injected parser failure");
    }, randomUUID, recorder);
    const failed = await failingParser.process({ documentId: failedUpload.document.id, versionId: failedUpload.version.id, jobId: failedUpload.job.id });
    assert.equal(failed.status, "failed");
    assert.equal(repository.getDocument(failedUpload.document.id)?.status, "failed");
    const failedJobError = database.prepare("SELECT error_json FROM jobs WHERE id = ?").get(failedUpload.job.id) as { error_json?: string };
    assert.match(String(failedJobError.error_json), /"stage":"extract"/);
    assert.deepEqual(
      blobs.readSync(
        { kind: "original", documentId: failedUpload.document.id, versionId: failedUpload.version.id },
        { sha256: failedUpload.version.contentSha256, size: failedUpload.version.sizeBytes },
      ),
      Buffer.from("must retain original"),
    );
    const retryJob = service.retryParse(failedUpload.document.id, failedUpload.version.id);
    assert.ok(retryJob);
    await expectReject(() => Promise.resolve(service.retryParse(failedUpload.document.id, failedUpload.version.id)), /active parse job/);
    const retried = await parser.process({ documentId: failedUpload.document.id, versionId: failedUpload.version.id, jobId: retryJob.id });
    assert.equal(retried.status, "ready");
    await expectReject(() => Promise.resolve(service.retryParse(failedUpload.document.id, failedUpload.version.id)), /not eligible/);
    await expectReject(() => Promise.resolve(service.retryParse(randomUUID(), randomUUID())), /retry resource was not found/);
    database.prepare("UPDATE documents SET parse_status = 'failed' WHERE id = ?").run(failedUpload.document.id);
    const exhaustedJobId = randomUUID();
    database.prepare("INSERT INTO jobs (id,type,status,resource_type,resource_id,attempt,max_attempts,retryable,payload_json,scheduled_at,created_at,updated_at) VALUES (?, 'document_parse', 'failed', 'document', ?, 1, 3, 1, ?, ?, ?, ?)").run(exhaustedJobId, failedUpload.document.id, JSON.stringify({ documentId: failedUpload.document.id, versionId: failedUpload.version.id }), new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    await expectReject(() => Promise.resolve(service.retryParse(failedUpload.document.id, failedUpload.version.id)), /retry limit/);

    const parseGuardJob = repository.getJob(docxUpload.job.id);
    assert.equal(parseGuardJob?.status, "complete");
    expectThrow(
      () => repository.commitParseReady({ documentId: docxUpload.document.id, versionId: uploaded.version.id, jobId: docxUpload.job.id, chunks: [], pageCount: null }),
      /bound to the requested document\/version/,
    );

    database.close();
    database = new WorkspaceDatabase(databasePath);
    cleanupLedger = new WorkspaceBlobCleanupRepository(database);
    blobRecords = new WorkspaceBlobRecordsRepository(database);
    repository = new WorkspaceDocumentsRepository(database, { blobRecords });
    assert.equal(repository.getDocument(uploaded.document.id)?.status, "ready");
    assert.ok(repository.searchChunks("workspace", { documentId: uploaded.document.id }).length >= 1);

    const lifecycleCancelled: string[] = [];
    const lifecycleAborted: string[] = [];
    const lifecycle: DocumentResourceLifecyclePort = {
      cancelQueued(jobIds) {
        for (const jobId of jobIds) {
          lifecycleCancelled.push(jobId);
          database?.prepare(
            `UPDATE jobs SET status = 'cancelled', retryable = 0,
                completed_at = ?, updated_at = ?
              WHERE id = ? AND status = 'queued'`,
          ).run(new Date().toISOString(), new Date().toISOString(), jobId);
        }
      },
      requestAbortRunning(jobIds) {
        for (const jobId of jobIds) {
          lifecycleAborted.push(jobId);
          database?.prepare(
            `UPDATE jobs SET cancel_requested_at = ?, cancellation_reason = ?, updated_at = ?
              WHERE id = ? AND status = 'running'`,
          ).run(new Date().toISOString(), "Document deletion requested.", new Date().toISOString(), jobId);
        }
      },
    };
    const reopenedService = new WorkspaceDocumentsService(repository, blobs, randomUUID, recorder);
    const blockedByTabular = await reopenedService.upload({ filename: "tabular-blocked.txt", mimetype: "text/plain", buffer: Buffer.from("tabular blocked") });
    database.prepare("UPDATE jobs SET status = 'failed', retryable = 0, completed_at = ? WHERE id = ?").run(new Date().toISOString(), blockedByTabular.job.id);
    const blockedCell = seedQueuedTabularCell(database, blockedByTabular.document.id, null);
    expectThrow(
      () => reopenedService.deleteDocument(blockedByTabular.document.id),
      /active parse job or dependent work/,
    );
    assert.ok(repository.getDocument(blockedByTabular.document.id));
    assert.equal(database.prepare("SELECT status FROM jobs WHERE id = ?").get(blockedCell.jobId)?.status, "queued");

    const cancellable = await reopenedService.upload({ filename: "tabular-cancel.txt", mimetype: "text/plain", buffer: Buffer.from("tabular cancel") });
    database.prepare("UPDATE jobs SET status = 'failed', retryable = 0, completed_at = ? WHERE id = ?").run(new Date().toISOString(), cancellable.job.id);
    const cancellableCell = seedQueuedTabularCell(database, cancellable.document.id, null);
    const coordinatedService = new WorkspaceDocumentsService(repository, blobs, randomUUID, recorder, lifecycle);
    const coordinatedDelete = coordinatedService.deleteDocument(cancellable.document.id);
    assert.equal(coordinatedDelete.documentId, cancellable.document.id);
    assert.ok(lifecycleCancelled.includes(cancellableCell.jobId));
    assert.equal(database.prepare("SELECT id FROM jobs WHERE id = ?").get(cancellableCell.jobId), undefined);
    assert.equal(database.prepare("SELECT id FROM jobs WHERE resource_type = 'document' AND resource_id = ?").get(cancellable.document.id), undefined);
    assert.equal(database.prepare("SELECT id FROM tabular_cells WHERE id = ?").get(cancellableCell.cellId), undefined);
    assert.equal(database.prepare("SELECT document_id FROM tabular_review_documents WHERE review_id = ?").get(cancellableCell.reviewId), undefined);
    assert.equal(database.prepare("SELECT document_ids_json FROM tabular_reviews WHERE id = ?").get(cancellableCell.reviewId)?.document_ids_json, "[]");

    const runningTabular = await reopenedService.upload({ filename: "tabular-running.txt", mimetype: "text/plain", buffer: Buffer.from("tabular running") });
    database.prepare("UPDATE jobs SET status = 'failed', retryable = 0, completed_at = ? WHERE id = ?").run(new Date().toISOString(), runningTabular.job.id);
    const runningCell = seedQueuedTabularCell(database, runningTabular.document.id, null);
    const runningAt = new Date().toISOString();
    database.prepare(
      `UPDATE jobs SET status = 'running', attempt = 1, lease_owner = 'tabular-running-owner',
          lease_expires_at = ?, locked_at = ?, started_at = ?, updated_at = ? WHERE id = ?`,
    ).run(new Date(Date.now() + 60_000).toISOString(), runningAt, runningAt, runningAt, runningCell.jobId);
    database.prepare("UPDATE tabular_cells SET status = 'running', updated_at = ? WHERE id = ?").run(runningAt, runningCell.cellId);
    expectThrow(
      () => coordinatedService.deleteDocument(runningTabular.document.id),
      /active parse job or dependent work/,
    );
    assert.ok(lifecycleAborted.includes(runningCell.jobId));
    assert.ok(database.prepare("SELECT id FROM tabular_cells WHERE id = ?").get(runningCell.cellId));
    assert.ok(repository.getDocument(runningTabular.document.id));
    assert.deepEqual(
      blobs.readSync(
        { kind: "original", documentId: runningTabular.document.id, versionId: runningTabular.version.id },
        { sha256: runningTabular.version.contentSha256, size: runningTabular.version.sizeBytes },
      ),
      Buffer.from("tabular running"),
    );

    const assistantUnrelated = await reopenedService.upload({ filename: "assistant-unrelated.txt", mimetype: "text/plain", buffer: Buffer.from("assistant unrelated") });
    database.prepare("UPDATE jobs SET status = 'failed', retryable = 0, completed_at = ? WHERE id = ?").run(new Date().toISOString(), assistantUnrelated.job.id);
    const assistantChatId = randomUUID();
    const assistantJobId = randomUUID();
    const assistantAt = new Date().toISOString();
    database.prepare("INSERT INTO chats (id,scope,title,status,created_at,updated_at) VALUES (?,'global','Assistant delete guard','active',?,?)").run(assistantChatId, assistantAt, assistantAt);
    database.prepare(
      `INSERT INTO jobs (id,type,status,resource_type,resource_id,payload_json,scheduled_at,created_at,updated_at)
       VALUES (?,'assistant_generate','queued','chat',?,'{}',?,?,?)`,
    ).run(assistantJobId, assistantChatId, assistantAt, assistantAt, assistantAt);
    const unrelatedAssistantDelete = coordinatedService.deleteDocument(assistantUnrelated.document.id);
    assert.equal(unrelatedAssistantDelete.documentId, assistantUnrelated.document.id);
    assert.equal(repository.getDocument(assistantUnrelated.document.id), null);
    assert.equal(
      database.prepare("SELECT status FROM jobs WHERE id = ?").get(assistantJobId)?.status,
      "queued",
      "an unrelated queued assistant job is neither a document dependency nor a deletion target",
    );
    assert.equal(
      lifecycleCancelled.includes(assistantJobId),
      false,
      "document lifecycle cancellation is limited to dependent jobs",
    );

    const rollbackWithCell = await reopenedService.upload({ filename: "tabular-rollback.txt", mimetype: "text/plain", buffer: Buffer.from("tabular rollback") });
    database.prepare("UPDATE jobs SET status = 'failed', retryable = 0, completed_at = ? WHERE id = ?").run(new Date().toISOString(), rollbackWithCell.job.id);
    const rollbackCell = seedQueuedTabularCell(database, rollbackWithCell.document.id, null);
    const rollbackWithCellRepository = {
      getDocument: repository.getDocument.bind(repository),
      documentDeletionPlan: repository.documentDeletionPlan.bind(repository),
      listVersions: repository.listVersions.bind(repository),
      listDocumentBlobRecords: repository.listDocumentBlobRecords.bind(repository),
      getBlobRecordsRepository: repository.getBlobRecordsRepository.bind(repository),
      deleteBlobRecord: repository.deleteBlobRecord.bind(repository),
      deleteDocumentRows() {
        throw new Error("injected tabular delete DB failure");
      },
    } as unknown as WorkspaceDocumentsRepository;
    const rollbackWithCellService = new WorkspaceDocumentsService(rollbackWithCellRepository, blobs, randomUUID, recorder, lifecycle);
    await expectReject(
      () => Promise.resolve().then(() => rollbackWithCellService.deleteDocument(rollbackWithCell.document.id)),
      /injected tabular delete DB failure/,
    );
    assert.ok(repository.getDocument(rollbackWithCell.document.id));
    assert.ok(database.prepare("SELECT id FROM tabular_cells WHERE id = ?").get(rollbackCell.cellId));
    assert.equal(database.prepare("SELECT status FROM jobs WHERE id = ?").get(rollbackCell.jobId)?.status, "cancelled");
    assert.deepEqual(
      blobs.readSync(
        { kind: "original", documentId: rollbackWithCell.document.id, versionId: rollbackWithCell.version.id },
        { sha256: rollbackWithCell.version.contentSha256, size: rollbackWithCell.version.sizeBytes },
      ),
      Buffer.from("tabular rollback"),
    );
    assert.ok(lifecycleAborted.includes(runningCell.jobId));

    const rollbackRepository = {
      getDocument: repository.getDocument.bind(repository),
      documentDeletionPlan: repository.documentDeletionPlan.bind(repository),
      listVersions: repository.listVersions.bind(repository),
      listDocumentBlobRecords: repository.listDocumentBlobRecords.bind(repository),
      getBlobRecordsRepository: repository.getBlobRecordsRepository.bind(repository),
      deleteBlobRecord: repository.deleteBlobRecord.bind(repository),
      deleteDocumentRows() {
        throw new Error("injected DB failure");
      },
    } as unknown as WorkspaceDocumentsRepository;
    const rollbackService = new WorkspaceDocumentsService(rollbackRepository, blobs, randomUUID, recorder);
    await expectReject(() => Promise.resolve().then(() => rollbackService.deleteDocument(uploaded.document.id)), /injected DB failure/);
    assert.ok(repository.getDocument(uploaded.document.id));
    assert.deepEqual(
      blobs.readSync(
        { kind: "original", documentId: uploaded.document.id, versionId: uploaded.version.id },
        { sha256: uploaded.version.contentSha256, size: uploaded.version.sizeBytes },
      ),
      textBytes,
    );

    database.prepare("UPDATE jobs SET status = 'failed', retryable = 0, completed_at = ? WHERE resource_type = 'document' AND resource_id = ?").run(new Date().toISOString(), sameName.document.id);
    const finalizeFailingBlob = {
      putSync: blobs.putSync.bind(blobs),
      readSync: blobs.readSync.bind(blobs),
      stageDeleteSync: blobs.stageDeleteSync.bind(blobs),
      restoreDeleteSync: blobs.restoreDeleteSync.bind(blobs),
      finalizeDeleteSync() {
        throw new Error("injected finalize failure");
      },
    } as unknown as typeof blobs;
    await expectReject(
      () => Promise.resolve().then(() => new WorkspaceDocumentsService(repository, finalizeFailingBlob, randomUUID, recorder).deleteDocument(sameName.document.id)),
      (error: unknown) => error instanceof WorkspaceBlobCleanupPendingError,
    );
    assert.ok(cleanupReceipts.length >= 1);
    assert.equal(repository.getDocument(sameName.document.id), null);

    const previewStored = blobs.putSync({ kind: "preview", documentId: uploaded.document.id, versionId: uploaded.version.id }, Buffer.from("preview"));
    blobRecords.registerStored({
      locator: { kind: "preview", documentId: uploaded.document.id, versionId: uploaded.version.id },
      contentSha256: previewStored.sha256,
      sizeBytes: previewStored.size,
      storedSizeBytes: previewStored.storedSize,
    });
    const deleted = new WorkspaceDocumentsService(repository, blobs, randomUUID, recorder).deleteDocument(uploaded.document.id);
    assert.equal(deleted.documentId, uploaded.document.id);
    assert.equal(repository.getDocument(uploaded.document.id), null);
    assert.ok(cleanupReceipts.length >= 0);

    return {
      ok: true,
      suite: "vera-workspace-documents-audit-v1",
      checks: [
        "temporary SQLite and explicit test codec",
        "TXT upload, UUID IDs, MIME/signature/path validation, and same-name isolation",
        "DOCX fixture and real extractMatterDocument parser",
        "atomic document/version/current-v1/job creation",
        "job binding and deterministic storage key enforcement",
        "deterministic chunks, hash/offset/page metadata, FTS search",
        "scan PDF ocr_required without default OCR",
        "failed parse retains encrypted-original boundary",
        "durable pre-put upload intents survive crash boundaries and fail closed before blob writes",
        "startup cleanup removes an unrecorded extracted blob after a put-before-commit crash while retaining original authority",
        "same-hash extracted retry reuses authority while different hash preserves the old blob and chunks",
        "runtime-managed parser requires a live lease claim and stale-worker commit cannot change blob/chunk authority",
        "document delete coordinates dependent tabular jobs, leaves unrelated assistant jobs queued, removes terminal jobs, and restores blobs on DB failure",
        "retry eligibility and no duplicate queued/complete retry",
        "restart reopen",
        "delete rollback and preview quarantine",
        "transport output has no path/storage-key leakage",
      ],
    };
  } finally {
    extractedCrashDatabase?.close();
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
