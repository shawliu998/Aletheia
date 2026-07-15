import assert from "node:assert/strict";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  MATTER_DOCUMENT_PDF_PAGE_SPANS_SCHEMA_VERSION,
  type MatterDocumentExtraction,
} from "../lib/aletheia/documentParser";
import type { WorkspaceBlobCodec } from "../lib/workspace/blobStore";
import { WorkspaceBlobCleanupRepository } from "../lib/workspace/repositories/blobCleanup";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import { WorkspaceDocumentsRepository } from "../lib/workspace/repositories/documents";
import { WorkspaceDocumentParser } from "../lib/workspace/documentParsing";
import { WorkspaceApiError } from "../lib/workspace/errors";
import { LocalWorkspaceBlobStore } from "../lib/workspace/localWorkspaceBlobStore";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "../lib/workspace/principal";
import { WorkspaceRuntime } from "../lib/workspace/runtime";
import { WorkspaceDocumentsService } from "../lib/workspace/services/documents";

type JsonRecord = Record<string, unknown>;

const root = mkdtempSync(path.join(os.tmpdir(), "vera-p1-convergence-"));
const dataDir = path.join(root, "runtime");
const blobRoot = path.join(root, "workspace-blobs");
const blobKey = randomBytes(32);
const previousDatabaseEncryption = process.env.ALETHEIA_DATABASE_ENCRYPTION;
const context = { principalId: WORKSPACE_LOCAL_PRINCIPAL_ID };

function record(value: unknown, label: string): JsonRecord {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), label);
  return value as JsonRecord;
}

function list(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), label);
  return value;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function encryptedAuditCodec(key: Buffer): WorkspaceBlobCodec {
  return {
    encrypted: true,
    encode({ filePath, plaintext, purpose }) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(`${purpose}\0${filePath}`, "utf8"));
      return Buffer.concat([
        Buffer.from("VPC1", "ascii"),
        nonce,
        cipher.update(plaintext),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
    },
    decode({ filePath, envelope, purpose }) {
      assert.equal(envelope.subarray(0, 4).toString("ascii"), "VPC1");
      const nonce = envelope.subarray(4, 16);
      const tag = envelope.subarray(envelope.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(Buffer.from(`${purpose}\0${filePath}`, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(envelope.subarray(16, envelope.length - 16)),
        decipher.final(),
      ]);
    },
  };
}

function inertPump() {
  let started = false;
  return {
    async start() {
      started = true;
      return {
        alreadyStarted: false,
        recoveredJobs: [],
        capabilities: {
          leaseHeartbeatSupported: true as const,
          leaseTokenFencingSupported: true as const,
          notes: [],
        },
      };
    },
    async stop() {
      started = false;
      return {
        alreadyStopped: false,
        drained: true,
        timedOut: false,
        restartBlocked: false,
      };
    },
    snapshot() {
      return {
        started,
        stopping: false,
        restartBlocked: false,
        activeWorkers: 0,
        idleBackoffMs: 1,
      };
    },
  };
}

function newRuntime(): WorkspaceRuntime {
  return new WorkspaceRuntime({
    dataDir,
    blobs: new LocalWorkspaceBlobStore({
      root: blobRoot,
      codec: encryptedAuditCodec(blobKey),
    }),
    pump: inertPump(),
  });
}

async function expectWorkspaceError(
  operation: Promise<unknown>,
  status: number,
  code: WorkspaceApiError["code"],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof WorkspaceApiError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

function versionCount(runtime: WorkspaceRuntime, documentId: string): number {
  const row = runtime.database
    .prepare(
      "SELECT count(*) AS count FROM document_versions WHERE document_id = ?",
    )
    .get(documentId);
  return Number(row?.count ?? -1);
}

async function main() {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";
  let runtime: WorkspaceRuntime | null = newRuntime();
  try {
    await runtime.start();
    const projectA = randomUUID();
    const projectB = randomUUID();
    runtime.database
      .prepare("INSERT INTO projects (id, name) VALUES (?, 'P1 Project A')")
      .run(projectA);
    runtime.database
      .prepare("INSERT INTO projects (id, name) VALUES (?, 'P1 Project B')")
      .run(projectB);

    // Exercise the real OCR persistence path with an injected, deterministic
    // Apple Vision extraction. The native helper itself remains covered by the
    // existing native and packaged-native OCR audits.
    const pagePrefix = "合同😀前言；";
    const exactQuote = "付款😀义务：甲方应在三十日内支付全部服务费";
    const pageText = `${pagePrefix}${exactQuote}。\n争议由上海法院管辖。`;
    const extractedText = `[Page 1]\n${pageText}`;
    const contentStart = "[Page 1]\n".length;
    const quotePageStart = pageText.indexOf(exactQuote);
    const quotePageEnd = quotePageStart + exactQuote.length;
    assert.equal(quotePageStart, pagePrefix.length);
    assert.notEqual(quotePageStart, [...pagePrefix].length);
    assert.notEqual(exactQuote.length, [...exactQuote].length);

    const extraction: MatterDocumentExtraction = {
      text: extractedText,
      metadata: {
        parser: "pdf+apple-vision",
        pageCount: 1,
        pageSpanSchemaVersion: MATTER_DOCUMENT_PDF_PAGE_SPANS_SCHEMA_VERSION,
        pageSpans: [
          {
            page: 1,
            textStart: 0,
            contentStart,
            contentEnd: extractedText.length,
            textEnd: extractedText.length,
          },
        ],
        textLayerPageCount: 0,
        ocrPageCount: 1,
        ocrEngine: "apple-vision",
        ocrCoordinateSpace: "normalized-top-left",
        ocrPages: [
          {
            page: 1,
            confidence: 0.93,
            blocks: [
              {
                textStart: quotePageStart,
                textEnd: quotePageEnd,
                confidence: 0.94,
                boundingBox: { x: 0.08, y: 0.16, width: 0.84, height: 0.08 },
              },
            ],
          },
        ],
        lowConfidenceOcrPageCount: 0,
        lowConfidenceOcrPages: [],
        unresolvedPageCount: 0,
        unresolvedPages: [],
      },
    };
    const cleanup = new WorkspaceBlobCleanupRepository(runtime.database);
    const cleanupRecorder = {
      record(input: Parameters<WorkspaceBlobCleanupRepository["record"]>[0]) {
        cleanup.record(input);
      },
    };
    const blobRecords = new WorkspaceBlobRecordsRepository(runtime.database);
    const documents = new WorkspaceDocumentsRepository(runtime.database, {
      blobRecords,
    });
    const documentService = new WorkspaceDocumentsService(
      documents,
      runtime.blobs,
      randomUUID,
      cleanupRecorder,
    );
    const originalPdf = Buffer.from(
      "%PDF-1.4\nVera deterministic P1 OCR convergence fixture\n",
      "utf8",
    );
    const uploaded = await documentService.upload({
      filename: "scanned-contract.pdf",
      mimetype: "application/pdf",
      buffer: originalPdf,
      projectId: projectA,
    });
    const parser = new WorkspaceDocumentParser(
      documents,
      runtime.blobs,
      async () => extraction,
      randomUUID,
      cleanupRecorder,
    );
    const parsed = await parser.process({
      documentId: uploaded.document.id,
      versionId: uploaded.version.id,
      jobId: uploaded.job.id,
    });
    assert.equal(parsed.status, "ready");

    const chunk = runtime.database
      .prepare(
        `SELECT id, text, start_offset, end_offset, content_sha256,
                metadata_json, page_start, page_end
           FROM document_chunks
          WHERE document_id = ? AND version_id = ?
          ORDER BY ordinal ASC LIMIT 1`,
      )
      .get(uploaded.document.id, uploaded.version.id);
    assert.ok(chunk);
    const chunkId = String(chunk.id);
    const chunkText = String(chunk.text);
    const chunkHash = sha256(chunkText);
    const quoteChunkStart = chunkText.indexOf(exactQuote);
    const quoteChunkEnd = quoteChunkStart + exactQuote.length;
    assert.ok(quoteChunkStart >= 0);
    assert.equal(
      Number(chunk.end_offset) - Number(chunk.start_offset),
      chunkText.length,
    );
    assert.equal(chunk.content_sha256, chunkHash);
    assert.equal(chunk.page_start, 1);
    assert.equal(chunk.page_end, 1);
    const ocrMetadata = record(
      JSON.parse(String(chunk.metadata_json)) as unknown,
      "OCR chunk metadata",
    );
    assert.equal(ocrMetadata.engine, "apple-vision");
    assert.equal(ocrMetadata.chunkPageTextStart, -"[Page 1]\n".length);
    assert.equal(ocrMetadata.lowConfidence, false);
    assert.equal(list(ocrMetadata.blocks, "OCR blocks").length, 1);

    const captured = record(
      await runtime.captureProjectDocumentSource(
        context,
        projectA,
        uploaded.document.id,
      ),
      "captured source",
    );
    assert.equal(captured.reused, false);
    const snapshot = record(captured.snapshot, "source snapshot");
    const snapshotId = String(snapshot.id);
    assert.equal(snapshot.kind, "project_document");
    assert.equal(snapshot.content_sha256, sha256(originalPdf));
    assert.deepEqual(snapshot.license, {
      basis: "user_provided",
      retention: "full_text_permitted",
      export: "permitted",
      model_use: "permitted",
    });
    await expectWorkspaceError(
      runtime.captureProjectDocumentSource(
        context,
        projectB,
        uploaded.document.id,
      ),
      404,
      "NOT_FOUND",
    );

    const anchored = record(
      await runtime.createProjectSourceAnchor(context, projectA, snapshotId, {
        chunkId,
        exactQuote,
        startOffset: quoteChunkStart,
        endOffset: quoteChunkEnd,
      }),
      "verified source anchor",
    );
    const anchor = record(anchored.anchor, "source anchor");
    const anchorId = String(anchor.id);
    assert.equal(anchor.quote_sha256, sha256(exactQuote));
    const locator = record(anchor.locator, "source anchor locator");
    assert.equal(locator.chunkId, chunkId);
    assert.equal(locator.chunkContentSha256, chunkHash);
    assert.equal(locator.startOffset, quoteChunkStart);
    assert.equal(locator.endOffset, quoteChunkEnd);
    assert.equal(locator.offsetUnit, "utf16_code_unit");
    assert.equal(locator.documentStartOffset, quoteChunkStart);
    assert.equal(locator.documentEndOffset, quoteChunkEnd);
    assert.equal(
      locator.documentOffsetBasis,
      "normalized_matter_document_text_v1",
    );
    const ocrLocator = record(locator.ocr, "OCR anchor locator");
    assert.equal(ocrLocator.engine, "apple-vision");
    assert.equal(ocrLocator.quotePageStart, quotePageStart);
    assert.equal(ocrLocator.quotePageEnd, quotePageEnd);
    assert.equal(ocrLocator.offsetUnit, "utf16_code_unit");
    assert.equal(list(ocrLocator.blocks, "OCR anchor blocks").length, 1);

    await expectWorkspaceError(
      runtime.createProjectSourceAnchor(context, projectB, snapshotId, {
        chunkId,
        exactQuote,
        startOffset: quoteChunkStart,
        endOffset: quoteChunkEnd,
      }),
      404,
      "NOT_FOUND",
    );

    const created = record(
      await runtime.createStudioDocument(context, projectA, {
        title: "OCR 证据审查意见",
        folderId: null,
      }),
      "created Studio document",
    );
    const studioDocumentId = String(created.document_id);
    const initialVersionId = String(created.current_version_id);
    const markdown = [
      "# OCR 证据审查意见",
      "",
      `> 经核验的原文：${exactQuote}。`,
      "",
      "| 项目 | 结果 |",
      "| --- | --- |",
      `| 来源哈希 | ${String(snapshot.content_sha256)} |`,
      "| OCR 引擎 | Apple Vision |",
    ].join("\n");
    const saved = record(
      await runtime.saveStudioDocument(context, projectA, studioDocumentId, {
        expectedVersionId: initialVersionId,
        content: markdown,
        source: "assistant_edit",
        citationAnchorIds: [anchorId],
        summary: "Bind the verified OCR source anchor.",
      }),
      "saved Studio document",
    );
    const savedVersionId = String(saved.current_version_id);
    assert.notEqual(savedVersionId, initialVersionId);
    assert.equal(saved.content, markdown);
    assert.deepEqual(
      list(
        record(saved.version, "saved Studio version").citation_anchor_ids,
        "saved citations",
      ),
      [anchorId],
    );
    assert.equal(list(saved.citation_anchors, "hydrated citations").length, 1);
    const beforeStaleCount = versionCount(runtime, studioDocumentId);
    await expectWorkspaceError(
      runtime.saveStudioDocument(context, projectA, studioDocumentId, {
        expectedVersionId: initialVersionId,
        content: "stale write must never become a version",
        source: "assistant_edit",
        citationAnchorIds: [anchorId],
        summary: null,
      }),
      409,
      "CONFLICT",
    );
    assert.equal(versionCount(runtime, studioDocumentId), beforeStaleCount);
    assert.equal(
      record(
        await runtime.getStudioDocument(context, projectA, studioDocumentId),
        "Studio current after stale CAS",
      ).current_version_id,
      savedVersionId,
    );
    await expectWorkspaceError(
      runtime.getStudioDocument(context, projectB, studioDocumentId),
      404,
      "NOT_FOUND",
    );
    assert.throws(
      () =>
        runtime!.database
          .prepare(
            "UPDATE document_studio_versions SET summary = 'mutated' WHERE version_id = ?",
          )
          .run(savedVersionId),
      /immutable/i,
    );

    const exported = await runtime.exportStudioDocumentDocx(
      context,
      projectA,
      studioDocumentId,
      savedVersionId,
    );
    assert.ok(exported.bytes.byteLength > 0);
    assert.equal(
      exported.contentType,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    assert.ok(exported.warningCodes.includes("MARKDOWN_BLOCKQUOTE_SIMPLIFIED"));
    await expectWorkspaceError(
      runtime.exportStudioDocumentDocx(
        context,
        projectB,
        studioDocumentId,
        savedVersionId,
      ),
      404,
      "NOT_FOUND",
    );
    const imported = await runtime.importStudioDocumentDocx(
      context,
      projectA,
      studioDocumentId,
      {
        expectedVersionId: savedVersionId,
        filename: exported.filename,
        mimeType: exported.contentType,
        buffer: Buffer.from(exported.bytes),
      },
    );
    assert.ok(imported.warningCodes.includes("DOCX_FORMATTING_SIMPLIFIED"));
    const importedDocument = record(
      imported.document,
      "imported Studio document",
    );
    const importedVersionId = String(importedDocument.current_version_id);
    assert.notEqual(importedVersionId, savedVersionId);
    assert.ok(String(importedDocument.content).includes(exactQuote));
    assert.deepEqual(
      list(
        record(importedDocument.version, "imported version")
          .citation_anchor_ids,
        "imported citations",
      ),
      [anchorId],
    );
    assert.equal(versionCount(runtime, studioDocumentId), 3);
    const historical = record(
      await runtime.getStudioDocument(
        context,
        projectA,
        studioDocumentId,
        savedVersionId,
      ),
      "historical Studio version",
    );
    assert.equal(historical.content, markdown);
    assert.equal(historical.current_version_id, importedVersionId);
    assert.equal(
      record(historical.version, "historical version").id,
      savedVersionId,
    );

    await runtime.stop();
    runtime = newRuntime();
    await runtime.start();

    const sourceAfterRestart = record(
      await runtime.getProjectSource(context, projectA, snapshotId),
      "source after restart",
    );
    assert.deepEqual(
      runtime.blobs.readSync(
        {
          kind: "original",
          documentId: uploaded.document.id,
          versionId: uploaded.version.id,
        },
        { sha256: sha256(originalPdf), size: originalPdf.byteLength },
      ),
      originalPdf,
    );
    const ocrChunkAfterRestart = runtime.database
      .prepare(
        `SELECT content_sha256, metadata_json
           FROM document_chunks
          WHERE id = ? AND document_id = ? AND version_id = ?`,
      )
      .get(chunkId, uploaded.document.id, uploaded.version.id);
    assert.ok(ocrChunkAfterRestart);
    assert.equal(ocrChunkAfterRestart.content_sha256, chunkHash);
    assert.deepEqual(
      JSON.parse(String(ocrChunkAfterRestart.metadata_json)) as unknown,
      ocrMetadata,
    );
    assert.equal(
      record(sourceAfterRestart.snapshot, "restarted source snapshot")
        .content_sha256,
      sha256(originalPdf),
    );
    const restartedAnchors = list(
      sourceAfterRestart.anchors,
      "restarted anchors",
    );
    assert.equal(restartedAnchors.length, 1);
    assert.equal(
      record(restartedAnchors[0], "restarted anchor").quote_sha256,
      sha256(exactQuote),
    );
    const repeatedCapture = record(
      await runtime.captureProjectDocumentSource(
        context,
        projectA,
        uploaded.document.id,
      ),
      "restarted source capture",
    );
    assert.equal(repeatedCapture.reused, true);
    assert.equal(
      record(repeatedCapture.snapshot, "reused source").id,
      snapshotId,
    );

    const studioAfterRestart = record(
      await runtime.getStudioDocument(context, projectA, studioDocumentId),
      "Studio document after restart",
    );
    assert.equal(studioAfterRestart.current_version_id, importedVersionId);
    assert.ok(String(studioAfterRestart.content).includes(exactQuote));
    assert.deepEqual(
      list(
        record(studioAfterRestart.version, "restarted current version")
          .citation_anchor_ids,
        "restarted current citations",
      ),
      [anchorId],
    );
    const savedAfterRestart = record(
      await runtime.getStudioDocument(
        context,
        projectA,
        studioDocumentId,
        savedVersionId,
      ),
      "saved version after restart",
    );
    assert.equal(savedAfterRestart.content, markdown);
    const versionsAfterRestart = record(
      await runtime.listStudioDocumentVersions(
        context,
        projectA,
        studioDocumentId,
      ),
      "Studio versions after restart",
    );
    assert.equal(
      list(versionsAfterRestart.versions, "restarted versions").length,
      3,
    );
    const exportedAfterRestart = await runtime.exportStudioDocumentDocx(
      context,
      projectA,
      studioDocumentId,
      savedVersionId,
    );
    assert.ok(exportedAfterRestart.bytes.byteLength > 0);
    await expectWorkspaceError(
      runtime.getProjectSource(context, projectB, snapshotId),
      404,
      "NOT_FOUND",
    );
    await expectWorkspaceError(
      runtime.getStudioDocument(context, projectB, studioDocumentId),
      404,
      "NOT_FOUND",
    );
    assert.equal(
      runtime.database
        .prepare(
          "SELECT count(*) AS count FROM project_source_snapshots WHERE source_kind = 'legal_authority'",
        )
        .get()?.count,
      0,
    );
    assert.equal(
      runtime.database.prepare("PRAGMA foreign_key_check").all().length,
      0,
    );

    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "vera-workspace-p1-convergence-v1",
          checks: [
            "real OCR parse persists bounded Apple Vision provenance",
            "emoji anchors use exact UTF-16 offsets and SHA-256 bindings",
            "Project document snapshot capture and verified anchor are immutable and isolated",
            "Document Studio save is Project-scoped, citation-bound, immutable, and strong-CAS protected",
            "DOCX export/import preserves core text and emits explicit simplification warnings",
            "source, anchor, Studio versions, citations, blobs, and DOCX export survive runtime restart",
            "no legal provider or legal-authority snapshot is enabled by this audit",
            "packaged native OCR and packaged Workspace E2E remain the reused release-layer gates",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previousDatabaseEncryption === undefined) {
      delete process.env.ALETHEIA_DATABASE_ENCRYPTION;
    } else {
      process.env.ALETHEIA_DATABASE_ENCRYPTION = previousDatabaseEncryption;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
