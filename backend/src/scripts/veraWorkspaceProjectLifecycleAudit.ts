import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  BlobIntegrity,
  BlobStore,
  StoredWorkspaceBlob,
  WorkspaceBlobDeleteReceipt,
  WorkspaceBlobLocator,
} from "../lib/workspace/blobStore";
import { WorkspaceDatabase } from "../lib/workspace/database";
import { WorkspaceApiError } from "../lib/workspace/errors";
import { WorkspaceBlobRecordsRepository } from "../lib/workspace/repositories/blobRecords";
import { ProjectsRepository } from "../lib/workspace/repositories/projects";
import {
  ProjectLifecycleCleanupPendingError,
  ProjectsService,
  type ProjectLifecycleCleanupRecord,
  type ResourceLifecyclePort,
} from "../lib/workspace/services/projects";

const NOW = "2026-07-14T10:00:00.000Z";

function locatorKey(locator: WorkspaceBlobLocator) {
  return JSON.stringify(locator);
}

class AuditBlobStore implements BlobStore {
  readonly stored = new Map<string, Buffer>();
  readonly staged = new Map<
    string,
    { key: string; value: Buffer; receipt: WorkspaceBlobDeleteReceipt }
  >();
  readonly restored: WorkspaceBlobDeleteReceipt[] = [];
  readonly finalized: WorkspaceBlobDeleteReceipt[] = [];
  readonly failFinalizeKeys = new Set<string>();
  onStage: ((locator: WorkspaceBlobLocator) => void) | null = null;

  putSync(
    locator: WorkspaceBlobLocator,
    plaintext: Buffer | string,
  ): StoredWorkspaceBlob {
    const value = Buffer.isBuffer(plaintext)
      ? Buffer.from(plaintext)
      : Buffer.from(plaintext, "utf8");
    const key = locatorKey(locator);
    this.stored.set(key, value);
    return {
      locator,
      sha256: createHash("sha256").update(value).digest("hex"),
      size: value.length,
      storedSize: value.length,
    };
  }

  readSync(locator: WorkspaceBlobLocator, expected: BlobIntegrity): Buffer {
    const value = this.stored.get(locatorKey(locator));
    if (!value) throw new Error("Audit blob is missing.");
    assert.equal(value.length, expected.size);
    assert.equal(
      createHash("sha256").update(value).digest("hex"),
      expected.sha256,
    );
    return Buffer.from(value);
  }

  stageDeleteSync(locator: WorkspaceBlobLocator): WorkspaceBlobDeleteReceipt {
    const key = locatorKey(locator);
    const value = this.stored.get(key);
    if (!value) {
      throw new Error("Injected /private/audit/blob path must not escape.");
    }
    this.onStage?.(locator);
    const receipt: WorkspaceBlobDeleteReceipt = {
      status: "staged",
      locator,
      quarantineId: randomUUID(),
    };
    this.stored.delete(key);
    this.staged.set(receipt.quarantineId, { key, value, receipt });
    return receipt;
  }

  restoreDeleteSync(receipt: WorkspaceBlobDeleteReceipt): void {
    const pending = this.staged.get(receipt.quarantineId);
    if (!pending) throw new Error("Audit staged blob is missing.");
    this.staged.delete(receipt.quarantineId);
    this.stored.set(pending.key, pending.value);
    this.restored.push(receipt);
  }

  finalizeDeleteSync(receipt: WorkspaceBlobDeleteReceipt): void {
    const key = locatorKey(receipt.locator);
    if (this.failFinalizeKeys.has(key)) {
      throw new Error("Injected /private/audit/finalize path must not escape.");
    }
    if (!this.staged.delete(receipt.quarantineId)) {
      throw new Error("Audit staged blob is missing.");
    }
    this.finalized.push(receipt);
  }
}

class AuditResourceLifecycle implements ResourceLifecyclePort {
  readonly cancelled: string[] = [];
  readonly aborted: string[] = [];
  failCancel = false;
  failAbort = false;

  constructor(private readonly database: WorkspaceDatabase) {}

  cancelQueued(jobIds: readonly string[], reason: string): void {
    if (this.failCancel) throw new Error("injected cancel failure");
    for (const id of jobIds) {
      const row = this.database
        .prepare("SELECT status FROM jobs WHERE id = ?")
        .get(id);
      if (row?.status !== "queued") throw new Error("job is not queued");
      this.database
        .prepare(
          `UPDATE jobs
              SET status = 'cancelled', retryable = 0,
                  cancel_requested_at = ?, cancellation_reason = ?,
                  completed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'queued'`,
        )
        .run(NOW, reason, NOW, NOW, id);
      this.cancelled.push(id);
    }
  }

  requestAbortRunning(jobIds: readonly string[], reason: string): void {
    if (this.failAbort) throw new Error("injected abort failure");
    for (const id of jobIds) {
      const row = this.database
        .prepare("SELECT status FROM jobs WHERE id = ?")
        .get(id);
      if (row?.status !== "running") throw new Error("job is not running");
      // The fake represents WorkspaceJobsService plus runtime abort acknowledgement.
      this.database
        .prepare(
          `UPDATE jobs
              SET status = 'cancelled', retryable = 0,
                  cancel_requested_at = ?, cancellation_reason = ?,
                  completed_at = ?, updated_at = ?
            WHERE id = ? AND status = 'running'`,
        )
        .run(NOW, reason, NOW, NOW, id);
      this.aborted.push(id);
    }
  }
}

function insertJob(
  database: WorkspaceDatabase,
  input: {
    id?: string;
    status: "queued" | "running" | "complete";
    resourceType:
      | "document"
      | "chat"
      | "workflow_run"
      | "tabular_cell"
      | "tabular_review"
      | "project";
    resourceId: string;
    type?:
      | "document_parse"
      | "assistant_generate"
      | "workflow_run"
      | "tabular_cell";
  },
) {
  const id = input.id ?? randomUUID();
  database
    .prepare(
      `INSERT INTO jobs
        (id, type, status, resource_type, resource_id, attempt, max_attempts,
         retryable, payload_json, scheduled_at, queued_at, started_at,
         completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 3, 0, '{}', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.type ??
        (input.resourceType === "document"
          ? "document_parse"
          : input.resourceType === "tabular_cell"
            ? "tabular_cell"
            : input.resourceType === "workflow_run"
              ? "workflow_run"
              : "assistant_generate"),
      input.status,
      input.resourceType,
      input.resourceId,
      input.status === "queued" ? 0 : 1,
      NOW,
      NOW,
      input.status === "running" ? NOW : null,
      input.status === "complete" ? NOW : null,
      NOW,
      NOW,
    );
  return id;
}

function insertDocument(
  database: WorkspaceDatabase,
  records: WorkspaceBlobRecordsRepository,
  blobs: AuditBlobStore,
  input: {
    projectId: string;
    folderId?: string | null;
    kinds?: Array<"original" | "extracted_text" | "preview">;
  },
) {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const value = Buffer.from(`document:${documentId}`, "utf8");
  const sha256 = createHash("sha256").update(value).digest("hex");
  database
    .prepare(
      `INSERT INTO documents
        (id, project_id, folder_id, title, filename, mime_type, size_bytes,
         parse_status, created_at, updated_at)
       VALUES (?, ?, ?, 'Lifecycle document', 'lifecycle.txt', 'text/plain', ?, 'ready', ?, ?)`,
    )
    .run(
      documentId,
      input.projectId,
      input.folderId ?? null,
      value.length,
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO document_versions
        (id, document_id, version_number, source, filename, mime_type,
         size_bytes, content_sha256, storage_key, created_at)
       VALUES (?, ?, 1, 'upload', 'lifecycle.txt', 'text/plain', ?, ?, ?, ?)`,
    )
    .run(
      versionId,
      documentId,
      value.length,
      sha256,
      `documents/${documentId}/versions/${versionId}/original`,
      NOW,
    );
  database
    .prepare("UPDATE documents SET current_version_id = ? WHERE id = ?")
    .run(versionId, documentId);

  for (const kind of input.kinds ?? ["original"]) {
    const locator: WorkspaceBlobLocator =
      kind === "preview"
        ? { kind, documentId, versionId }
        : { kind, documentId, versionId };
    const stored = blobs.putSync(locator, Buffer.from(`${kind}:${documentId}`));
    records.registerStored({
      locator,
      contentSha256: stored.sha256,
      sizeBytes: stored.size,
      storedSizeBytes: stored.storedSize,
    });
  }
  return { documentId, versionId };
}

function createProject(repository: ProjectsRepository, name: string) {
  return repository.create({
    id: randomUUID(),
    name,
    description: null,
    cmNumber: null,
    practice: null,
    now: NOW,
  });
}

function createService(
  repository: ProjectsRepository,
  blobs: AuditBlobStore,
  resources: AuditResourceLifecycle,
  cleanup: ProjectLifecycleCleanupRecord[],
) {
  return new ProjectsService(repository, blobs, {
    resources,
    cleanupRecorder: {
      record(input) {
        cleanup.push(input);
      },
    },
    clock: () => new Date(NOW),
  });
}

function run() {
  const root = mkdtempSync(path.join(os.tmpdir(), "vera-project-lifecycle-"));
  const databasePath = path.join(root, "workspace.sqlite");
  const database = new WorkspaceDatabase(databasePath);
  const blobs = new AuditBlobStore();
  const repository = new ProjectsRepository(database);
  const records = new WorkspaceBlobRecordsRepository(database);
  const resources = new AuditResourceLifecycle(database);
  const cleanup: ProjectLifecycleCleanupRecord[] = [];
  const service = createService(repository, blobs, resources, cleanup);

  try {
    assert.throws(
      () => service.create({ name: "" }),
      (error: unknown) =>
        error instanceof WorkspaceApiError && error.code === "VALIDATION_ERROR",
    );

    const counted = createProject(repository, "Counted container");
    const countedFolder = repository.createFolder({
      id: randomUUID(),
      projectId: counted.id,
      parentFolderId: null,
      name: "Counted folder",
      now: NOW,
    });
    insertDocument(database, records, blobs, {
      projectId: counted.id,
      folderId: countedFolder.id,
    });
    database
      .prepare(
        "INSERT INTO chats (id, project_id, scope, title, created_at, updated_at) VALUES (?, ?, 'project', 'Counted chat', ?, ?)",
      )
      .run(randomUUID(), counted.id, NOW, NOW);
    database
      .prepare(
        "INSERT INTO tabular_reviews (id, project_id, title, created_at, updated_at) VALUES (?, ?, 'Counted review', ?, ?)",
      )
      .run(randomUUID(), counted.id, NOW, NOW);
    database
      .prepare(
        "INSERT INTO workflows (id, type, project_id, title, created_at, updated_at) VALUES (?, 'assistant', ?, 'Counted workflow', ?, ?)",
      )
      .run(randomUUID(), counted.id, NOW, NOW);
    const listed = service
      .list({ limit: 100 })
      .items.find((item) => item.id === counted.id);
    assert.deepEqual(
      listed && {
        documents: listed.documentCount,
        chats: listed.chatCount,
        reviews: listed.reviewCount,
        workflows: listed.workflowCount,
      },
      { documents: 1, chats: 1, reviews: 1, workflows: 1 },
    );
    const countedOverview = service.overview(counted.id);
    assert.equal(countedOverview.folders.length, 1);
    assert.equal(service.listFolders(counted.id)[0].id, countedFolder.id);
    assert.equal(service.getFolder(countedFolder.id).projectId, counted.id);

    const project = createProject(repository, "Authoritative delete");
    const projectFolder = repository.createFolder({
      id: randomUUID(),
      projectId: project.id,
      parentFolderId: null,
      name: "Project folder",
      now: NOW,
    });
    const projectDocument = insertDocument(database, records, blobs, {
      projectId: project.id,
      folderId: projectFolder.id,
      kinds: ["original", "extracted_text", "preview"],
    });
    const projectChatId = randomUUID();
    database
      .prepare(
        "INSERT INTO chats (id, project_id, scope, title, created_at, updated_at) VALUES (?, ?, 'project', 'Delete chat', ?, ?)",
      )
      .run(projectChatId, project.id, NOW, NOW);
    const workflowId = randomUUID();
    const globalWorkflowId = randomUUID();
    const survivorProject = createProject(
      repository,
      "Surviving workflow project",
    );
    const survivorWorkflowId = randomUUID();
    database
      .prepare(
        `INSERT INTO workflows
          (id, type, project_id, title, created_at, updated_at)
         VALUES
          (?, 'assistant', ?, 'Delete workflow', ?, ?),
          (?, 'assistant', NULL, 'Global workflow', ?, ?),
          (?, 'assistant', ?, 'Surviving workflow', ?, ?)`,
      )
      .run(
        workflowId,
        project.id,
        NOW,
        NOW,
        globalWorkflowId,
        NOW,
        NOW,
        survivorWorkflowId,
        survivorProject.id,
        NOW,
        NOW,
      );
    const workflowRunId = randomUUID();
    const workflowJobId = insertJob(database, {
      status: "running",
      resourceType: "workflow_run",
      resourceId: workflowRunId,
      type: "workflow_run",
    });
    const anomalousWorkflowRunId = randomUUID();
    const anomalousWorkflowJobId = insertJob(database, {
      status: "queued",
      resourceType: "workflow_run",
      resourceId: anomalousWorkflowRunId,
      type: "workflow_run",
    });
    const projectGlobalWorkflowRunId = randomUUID();
    const projectGlobalWorkflowJobId = insertJob(database, {
      status: "complete",
      resourceType: "workflow_run",
      resourceId: projectGlobalWorkflowRunId,
      type: "workflow_run",
    });
    const globalWorkflowRunId = randomUUID();
    const globalWorkflowJobId = insertJob(database, {
      status: "complete",
      resourceType: "workflow_run",
      resourceId: globalWorkflowRunId,
      type: "workflow_run",
    });
    const survivorWorkflowRunId = randomUUID();
    const survivorWorkflowJobId = insertJob(database, {
      status: "complete",
      resourceType: "workflow_run",
      resourceId: survivorWorkflowRunId,
      type: "workflow_run",
    });
    database
      .prepare(
        `INSERT INTO workflow_runs
          (id, workflow_id, project_id, job_id, status, input_json,
           started_at, created_at, updated_at)
         VALUES
          (?, ?, ?, ?, 'running', '{"owner":"project"}', ?, ?, ?),
          (?, ?, NULL, ?, 'queued', '{"owner":"project-workflow"}', NULL, ?, ?),
          (?, ?, ?, ?, 'complete', '{"owner":"project-run"}', ?, ?, ?),
          (?, ?, NULL, ?, 'complete', '{"owner":"global"}', ?, ?, ?),
          (?, ?, ?, ?, 'complete', '{"owner":"survivor"}', ?, ?, ?)`,
      )
      .run(
        workflowRunId,
        workflowId,
        project.id,
        workflowJobId,
        NOW,
        NOW,
        NOW,
        anomalousWorkflowRunId,
        workflowId,
        anomalousWorkflowJobId,
        NOW,
        NOW,
        projectGlobalWorkflowRunId,
        globalWorkflowId,
        project.id,
        projectGlobalWorkflowJobId,
        NOW,
        NOW,
        NOW,
        globalWorkflowRunId,
        globalWorkflowId,
        globalWorkflowJobId,
        NOW,
        NOW,
        NOW,
        survivorWorkflowRunId,
        survivorWorkflowId,
        survivorProject.id,
        survivorWorkflowJobId,
        NOW,
        NOW,
        NOW,
      );
    const targetStepIds = [randomUUID(), randomUUID(), randomUUID()];
    const globalWorkflowStepId = randomUUID();
    const survivorWorkflowStepId = randomUUID();
    database
      .prepare(
        `INSERT INTO workflow_step_runs
          (id, workflow_run_id, ordinal, step_json, status, input_json,
           output_json, created_at, updated_at)
         VALUES
          (?, ?, 0, '{"kind":"prompt"}', 'running', '{}', NULL, ?, ?),
          (?, ?, 0, '{"kind":"prompt"}', 'queued', '{}', NULL, ?, ?),
          (?, ?, 0, '{"kind":"prompt"}', 'complete', '{}', '{"secret":true}', ?, ?),
          (?, ?, 0, '{"kind":"prompt"}', 'complete', '{}', '{"global":true}', ?, ?),
          (?, ?, 0, '{"kind":"prompt"}', 'complete', '{}', '{"survivor":true}', ?, ?)`,
      )
      .run(
        targetStepIds[0],
        workflowRunId,
        NOW,
        NOW,
        targetStepIds[1],
        anomalousWorkflowRunId,
        NOW,
        NOW,
        targetStepIds[2],
        projectGlobalWorkflowRunId,
        NOW,
        NOW,
        globalWorkflowStepId,
        globalWorkflowRunId,
        NOW,
        NOW,
        survivorWorkflowStepId,
        survivorWorkflowRunId,
        NOW,
        NOW,
      );
    const queuedDocumentJob = insertJob(database, {
      status: "queued",
      resourceType: "document",
      resourceId: projectDocument.documentId,
    });
    const runningProjectJob = insertJob(database, {
      status: "running",
      resourceType: "project",
      resourceId: project.id,
    });
    const terminalChatJob = insertJob(database, {
      status: "complete",
      resourceType: "chat",
      resourceId: projectChatId,
    });

    const sideEffectsBeforeMismatch = {
      cancelled: resources.cancelled.length,
      aborted: resources.aborted.length,
      staged: blobs.staged.size,
    };
    assert.throws(
      () => service.permanentlyDelete(project.id, "wrong name"),
      (error: unknown) =>
        error instanceof WorkspaceApiError &&
        error.code === "PRECONDITION_FAILED",
    );
    assert.deepEqual(
      {
        cancelled: resources.cancelled.length,
        aborted: resources.aborted.length,
        staged: blobs.staged.size,
      },
      sideEffectsBeforeMismatch,
    );

    const finalizedBeforeProject = blobs.finalized.length;
    service.permanentlyDelete(project.id, project.name);
    assert.equal(repository.get(project.id), null);
    assert.equal(blobs.finalized.length - finalizedBeforeProject, 3);
    assert.ok(resources.cancelled.includes(queuedDocumentJob));
    assert.ok(resources.cancelled.includes(anomalousWorkflowJobId));
    assert.ok(resources.aborted.includes(runningProjectJob));
    assert.ok(resources.aborted.includes(workflowJobId));
    assert.equal(
      database.prepare("SELECT id FROM jobs WHERE id = ?").get(terminalChatJob),
      undefined,
    );
    assert.equal(
      database.prepare("SELECT id FROM jobs WHERE id = ?").get(workflowJobId),
      undefined,
    );
    for (const id of [anomalousWorkflowJobId, projectGlobalWorkflowJobId]) {
      assert.equal(
        database.prepare("SELECT id FROM jobs WHERE id = ?").get(id),
        undefined,
      );
    }
    for (const id of [
      workflowRunId,
      anomalousWorkflowRunId,
      projectGlobalWorkflowRunId,
    ]) {
      assert.equal(
        database.prepare("SELECT id FROM workflow_runs WHERE id = ?").get(id),
        undefined,
      );
    }
    for (const id of targetStepIds) {
      assert.equal(
        database
          .prepare("SELECT id FROM workflow_step_runs WHERE id = ?")
          .get(id),
        undefined,
      );
    }
    assert.equal(
      database.prepare("SELECT id FROM workflows WHERE id = ?").get(workflowId),
      undefined,
    );
    assert.ok(
      database
        .prepare("SELECT id FROM workflows WHERE id = ?")
        .get(globalWorkflowId),
    );
    assert.ok(
      database
        .prepare("SELECT id FROM workflow_runs WHERE id = ?")
        .get(globalWorkflowRunId),
    );
    assert.ok(
      database
        .prepare("SELECT id FROM workflow_step_runs WHERE id = ?")
        .get(globalWorkflowStepId),
    );
    assert.ok(
      database
        .prepare("SELECT id FROM jobs WHERE id = ?")
        .get(globalWorkflowJobId),
    );
    assert.ok(repository.get(survivorProject.id));
    assert.ok(
      database
        .prepare("SELECT id FROM workflows WHERE id = ?")
        .get(survivorWorkflowId),
    );
    assert.ok(
      database
        .prepare("SELECT id FROM workflow_runs WHERE id = ?")
        .get(survivorWorkflowRunId),
    );
    assert.ok(
      database
        .prepare("SELECT id FROM workflow_step_runs WHERE id = ?")
        .get(survivorWorkflowStepId),
    );
    assert.ok(
      database
        .prepare("SELECT id FROM jobs WHERE id = ?")
        .get(survivorWorkflowJobId),
    );

    const databaseFailure = createProject(repository, "Database rollback");
    const databaseFailureDocument = insertDocument(database, records, blobs, {
      projectId: databaseFailure.id,
    });
    database.exec(`
      CREATE TRIGGER fail_project_delete
      BEFORE DELETE ON projects
      WHEN OLD.id = '${databaseFailure.id}'
      BEGIN
        SELECT RAISE(ABORT, 'injected database failure');
      END;
    `);
    const restoredBeforeDatabaseFailure = blobs.restored.length;
    assert.throws(
      () => service.permanentlyDelete(databaseFailure.id, databaseFailure.name),
      (error: unknown) => error instanceof WorkspaceApiError,
    );
    assert.ok(repository.get(databaseFailure.id));
    assert.equal(blobs.restored.length - restoredBeforeDatabaseFailure, 1);
    assert.ok(
      blobs.stored.has(
        locatorKey({
          kind: "original",
          documentId: databaseFailureDocument.documentId,
          versionId: databaseFailureDocument.versionId,
        }),
      ),
    );
    assert.equal(
      records.listForDocument(databaseFailureDocument.documentId)[0].state,
      "stored",
    );
    database.exec("DROP TRIGGER fail_project_delete");

    const raced = createProject(repository, "Job race");
    const racedDocument = insertDocument(database, records, blobs, {
      projectId: raced.id,
    });
    let racedJobId: string | null = null;
    blobs.onStage = () => {
      if (racedJobId) return;
      racedJobId = insertJob(database, {
        status: "queued",
        resourceType: "document",
        resourceId: racedDocument.documentId,
      });
    };
    const restoredBeforeRace = blobs.restored.length;
    assert.throws(
      () => service.permanentlyDelete(raced.id, raced.name),
      (error: unknown) =>
        error instanceof WorkspaceApiError && error.code === "CONFLICT",
    );
    blobs.onStage = null;
    assert.ok(repository.get(raced.id));
    assert.equal(blobs.restored.length - restoredBeforeRace, 1);
    assert.ok(racedJobId);
    database.prepare("DELETE FROM jobs WHERE id = ?").run(racedJobId);

    const folderProject = createProject(repository, "Folder tree");
    const rootFolder = repository.createFolder({
      id: randomUUID(),
      projectId: folderProject.id,
      parentFolderId: null,
      name: "Root",
      now: NOW,
    });
    const childFolder = repository.createFolder({
      id: randomUUID(),
      projectId: folderProject.id,
      parentFolderId: rootFolder.id,
      name: "Child",
      now: NOW,
    });
    const siblingFolder = repository.createFolder({
      id: randomUUID(),
      projectId: folderProject.id,
      parentFolderId: null,
      name: "Sibling",
      now: NOW,
    });
    const rootDocument = insertDocument(database, records, blobs, {
      projectId: folderProject.id,
      folderId: rootFolder.id,
    });
    const childDocument = insertDocument(database, records, blobs, {
      projectId: folderProject.id,
      folderId: childFolder.id,
    });
    const siblingDocument = insertDocument(database, records, blobs, {
      projectId: folderProject.id,
      folderId: siblingFolder.id,
    });
    const rootJob = insertJob(database, {
      status: "queued",
      resourceType: "document",
      resourceId: rootDocument.documentId,
    });
    const childJob = insertJob(database, {
      status: "running",
      resourceType: "document",
      resourceId: childDocument.documentId,
    });
    const terminalChildJob = insertJob(database, {
      status: "complete",
      resourceType: "document",
      resourceId: childDocument.documentId,
    });
    const finalizedBeforeFolder = blobs.finalized.length;
    service.deleteFolder(rootFolder.id);
    assert.equal(repository.getFolder(rootFolder.id), null);
    assert.equal(repository.getFolder(childFolder.id), null);
    assert.ok(repository.getFolder(siblingFolder.id));
    assert.equal(
      database
        .prepare("SELECT id FROM documents WHERE id = ?")
        .get(rootDocument.documentId),
      undefined,
    );
    assert.equal(
      database
        .prepare("SELECT id FROM documents WHERE id = ?")
        .get(childDocument.documentId),
      undefined,
    );
    assert.ok(
      database
        .prepare("SELECT id FROM documents WHERE id = ?")
        .get(siblingDocument.documentId),
    );
    assert.equal(blobs.finalized.length - finalizedBeforeFolder, 2);
    assert.ok(resources.cancelled.includes(rootJob));
    assert.ok(resources.aborted.includes(childJob));
    assert.equal(
      database
        .prepare("SELECT id FROM jobs WHERE id = ?")
        .get(terminalChildJob),
      undefined,
    );

    const racedFolder = repository.createFolder({
      id: randomUUID(),
      projectId: folderProject.id,
      parentFolderId: null,
      name: "Raced folder",
      now: NOW,
    });
    const racedFolderDocument = insertDocument(database, records, blobs, {
      projectId: folderProject.id,
      folderId: racedFolder.id,
    });
    let racedFolderJobId: string | null = null;
    blobs.onStage = () => {
      if (racedFolderJobId) return;
      racedFolderJobId = insertJob(database, {
        status: "queued",
        resourceType: "document",
        resourceId: racedFolderDocument.documentId,
      });
    };
    const restoredBeforeFolderRace = blobs.restored.length;
    assert.throws(
      () => service.deleteFolder(racedFolder.id),
      (error: unknown) =>
        error instanceof WorkspaceApiError && error.code === "CONFLICT",
    );
    blobs.onStage = null;
    assert.ok(repository.getFolder(racedFolder.id));
    assert.equal(blobs.restored.length - restoredBeforeFolderRace, 1);
    assert.ok(racedFolderJobId);
    database.prepare("DELETE FROM jobs WHERE id = ?").run(racedFolderJobId);

    const finalizeProject = createProject(repository, "Finalize pending");
    const finalizeDocument = insertDocument(database, records, blobs, {
      projectId: finalizeProject.id,
    });
    const finalizeLocator: WorkspaceBlobLocator = {
      kind: "original",
      documentId: finalizeDocument.documentId,
      versionId: finalizeDocument.versionId,
    };
    blobs.failFinalizeKeys.add(locatorKey(finalizeLocator));
    assert.throws(
      () => service.permanentlyDelete(finalizeProject.id, finalizeProject.name),
      (error: unknown) =>
        error instanceof ProjectLifecycleCleanupPendingError &&
        error.cleanupCode === "PROJECT_BLOB_FINALIZE_FAILED",
    );
    assert.equal(repository.get(finalizeProject.id), null);
    assert.ok(
      cleanup.some(
        (record) =>
          record.operation === "finalize" &&
          record.resourceId === finalizeProject.id &&
          record.locator.kind === "original",
      ),
    );

    const missingAuthority = createProject(repository, "Missing authority");
    const missingDocumentId = randomUUID();
    const missingVersionId = randomUUID();
    database
      .prepare(
        `INSERT INTO documents
          (id, project_id, title, filename, mime_type, parse_status, created_at, updated_at)
         VALUES (?, ?, 'Missing', 'missing.txt', 'text/plain', 'ready', ?, ?)`,
      )
      .run(missingDocumentId, missingAuthority.id, NOW, NOW);
    database
      .prepare(
        `INSERT INTO document_versions
          (id, document_id, version_number, filename, mime_type, size_bytes,
           content_sha256, storage_key, created_at)
         VALUES (?, ?, 1, 'missing.txt', 'text/plain', 1, ?, ?, ?)`,
      )
      .run(
        missingVersionId,
        missingDocumentId,
        "f".repeat(64),
        `documents/${missingDocumentId}/versions/${missingVersionId}/original`,
        NOW,
      );
    assert.throws(
      () =>
        service.permanentlyDelete(missingAuthority.id, missingAuthority.name),
      (error: unknown) =>
        error instanceof WorkspaceApiError &&
        error.code === "PRECONDITION_FAILED" &&
        /authoritative blob records/.test(error.message),
    );
    assert.ok(repository.get(missingAuthority.id));

    console.log(
      JSON.stringify(
        {
          ok: true,
          suite: "vera-workspace-project-lifecycle-audit-v1",
          checks: [
            "real project counts and folder read model",
            "exact confirmation with zero side effects",
            "authoritative original/extracted/preview blob lifecycle",
            "queued cancellation and running abort acknowledgement",
            "BEGIN IMMEDIATE active-job race rejection and blob restore",
            "folder-level active-job race rejection and blob restore",
            "database rollback restores staged authoritative blobs",
            "recursive folder document/version/blob cascade",
            "terminal resource job cleanup without payload remnants",
            "project-owned workflow/run/step purge without implicit globalization",
            "null-project runs referencing project workflows remain in project job scope",
            "global and other-project workflow/run/job isolation",
            "durable finalize-pending cleanup record",
            "missing authoritative original fails closed without locator guessing",
          ],
        },
        null,
        2,
      ),
    );
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

run();
