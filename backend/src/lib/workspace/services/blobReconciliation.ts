import type {
  BlobStore,
  WorkspaceBlobDeleteReceipt,
  WorkspaceBlobLocator,
} from "../blobStore";
import type { WorkspaceBlobRecordsRepository } from "../repositories/blobRecords";
import type { WorkspaceDocumentsRepository } from "../repositories/documents";
import type {
  WorkspaceBlobCleanupReplay,
  WorkspaceBlobCleanupReplayResult,
} from "./blobCleanup";

export type WorkspaceBlobReconciliationResult = {
  restored: number;
  finalized: number;
  conflicts: number;
};

function locatorKey(locator: WorkspaceBlobLocator) {
  if (locator.kind === "export") return `${locator.kind}:${locator.exportId}`;
  return `${locator.kind}:${locator.documentId}:${locator.versionId}:${locator.kind === "preview" ? (locator.previewId ?? "default") : ""}`;
}

function hasLiveDocumentReference(
  documents: WorkspaceDocumentsRepository,
  locator: WorkspaceBlobLocator,
) {
  if (locator.kind === "export") return false;
  return Boolean(
    documents.getDocument(locator.documentId) ||
    documents.getVersion(locator.documentId, locator.versionId),
  );
}

export class WorkspaceBlobReconciliationError extends Error {
  constructor() {
    super(
      "Workspace blob reconciliation found an unsafe state and stopped without deleting data.",
    );
    this.name = "WorkspaceBlobReconciliationError";
  }
}

export class WorkspaceBlobReconciliation {
  constructor(
    private readonly records: WorkspaceBlobRecordsRepository,
    private readonly blobs: BlobStore,
    private readonly documents: WorkspaceDocumentsRepository,
  ) {}

  reconcile(): WorkspaceBlobReconciliationResult {
    if (!this.blobs.listStagedDeletesSync)
      throw new WorkspaceBlobReconciliationError();
    const staged = this.blobs.listStagedDeletesSync();
    const seen = new Set<string>();
    let restored = 0;
    let finalized = 0;
    let conflicts = 0;
    for (const receipt of staged) {
      const key = locatorKey(receipt.locator);
      seen.add(key);
      const record = this.records.getByLocator(receipt.locator);
      if (!record) {
        conflicts++;
        continue;
      }
      if (record.state === "stored") {
        this.blobs.restoreDeleteSync(receipt);
        restored++;
        continue;
      }
      if (record.quarantineId !== receipt.quarantineId) {
        conflicts++;
        continue;
      }
      if (hasLiveDocumentReference(this.documents, record.locator)) {
        conflicts++;
        continue;
      }
      this.blobs.finalizeDeleteSync(receipt);
      this.records.deleteQuarantined(record.id, receipt.quarantineId);
      finalized++;
    }
    for (const record of this.records.listQuarantined()) {
      if (seen.has(locatorKey(record.locator))) continue;
      if (hasLiveDocumentReference(this.documents, record.locator)) {
        conflicts++;
        continue;
      }
      try {
        this.blobs.finalizeDeleteSync({
          status: "staged",
          locator: record.locator,
          quarantineId: record.quarantineId as string,
        });
        this.records.deleteQuarantined(
          record.id,
          record.quarantineId as string,
        );
        finalized++;
      } catch {
        conflicts++;
      }
    }
    if (conflicts > 0) throw new WorkspaceBlobReconciliationError();
    return { restored, finalized, conflicts };
  }
}

export type WorkspaceBlobStartupRecoveryResult = {
  cleanup: WorkspaceBlobCleanupReplayResult;
  reconciliation: WorkspaceBlobReconciliationResult;
};

/**
 * Startup order is part of the safety contract: the durable cleanup ledger
 * owns orphan staged/original blobs first. Generic reconciliation runs only
 * after every pending intent has been resolved, so it never mistakes a known
 * compensation orphan for an unexplained staged-delete conflict.
 */
export class WorkspaceBlobStartupRecovery {
  constructor(
    private readonly cleanup: Pick<WorkspaceBlobCleanupReplay, "replayPending">,
    private readonly reconciliation: Pick<
      WorkspaceBlobReconciliation,
      "reconcile"
    >,
  ) {}

  recover(): WorkspaceBlobStartupRecoveryResult {
    const cleanup = this.cleanup.replayPending();
    const reconciliation = this.reconciliation.reconcile();
    return { cleanup, reconciliation };
  }
}

export type { WorkspaceBlobDeleteReceipt };
