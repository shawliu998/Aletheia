import type {
  BlobStore,
  WorkspaceBlobDeleteReceipt,
  WorkspaceBlobLocator,
} from "../blobStore";
import type { WorkspaceBlobRecordsRepository } from "../repositories/blobRecords";
import {
  type WorkspaceBlobCleanupIntent,
  type WorkspaceBlobCleanupReplayErrorCode,
  type WorkspaceDocumentBlobLocator,
  type WorkspaceBlobCleanupRepository,
} from "../repositories/blobCleanup";

export type WorkspaceBlobCleanupReplayResult = {
  resolved: number;
  restored: number;
  finalized: number;
  retained: number;
};

type ReplayDisposition = "restored" | "finalized" | "retained";

export type WorkspaceBlobCleanupLedger = Pick<
  WorkspaceBlobCleanupRepository,
  "listPending" | "resolve" | "markAttemptFailed" | "inspectAuthority"
>;

class CleanupDecisionError extends Error {
  constructor(readonly code: WorkspaceBlobCleanupReplayErrorCode) {
    super(code);
    this.name = "CleanupDecisionError";
  }
}

export class WorkspaceBlobCleanupReplayError extends Error {
  constructor(readonly code: WorkspaceBlobCleanupReplayErrorCode) {
    super(`Workspace blob cleanup replay stopped safely (${code}).`);
    this.name = "WorkspaceBlobCleanupReplayError";
  }
}

function locatorKey(locator: WorkspaceBlobLocator) {
  if (locator.kind === "export") return `export:${locator.exportId}`;
  return [
    locator.kind,
    locator.documentId,
    locator.versionId,
    locator.kind === "preview" ? (locator.previewId ?? "default") : "",
  ].join(":");
}

function sameLocator(left: WorkspaceBlobLocator, right: WorkspaceBlobLocator) {
  return locatorKey(left) === locatorKey(right);
}

function isBlobNotFound(error: unknown) {
  return error instanceof Error && error.name === "WorkspaceBlobNotFoundError";
}

function isRegenerableDerivedBlob(locator: WorkspaceBlobLocator) {
  return locator.kind === "extracted_text" || locator.kind === "preview";
}

/**
 * Replays durable cleanup intents before generic blob reconciliation. The
 * database's blob record and live document-version row always win over the
 * originally requested compensation operation.
 */
export class WorkspaceBlobCleanupReplay {
  constructor(
    private readonly ledger: WorkspaceBlobCleanupLedger,
    private readonly records: WorkspaceBlobRecordsRepository,
    private readonly blobs: BlobStore,
  ) {}

  replayPending(): WorkspaceBlobCleanupReplayResult {
    const result: WorkspaceBlobCleanupReplayResult = {
      resolved: 0,
      restored: 0,
      finalized: 0,
      retained: 0,
    };
    while (true) {
      const pending = this.ledger.listPending(1000);
      if (pending.length === 0) return result;
      for (const intent of pending) {
        let disposition: ReplayDisposition;
        try {
          disposition = this.replayOne(intent);
        } catch (error) {
          const code =
            error instanceof CleanupDecisionError
              ? error.code
              : "BLOB_IO_FAILED";
          this.persistFailureOrThrow(intent.id, code);
          throw new WorkspaceBlobCleanupReplayError(code);
        }
        try {
          this.ledger.resolve(intent.id);
        } catch {
          this.persistFailureOrThrow(intent.id, "LEDGER_WRITE_FAILED");
          throw new WorkspaceBlobCleanupReplayError("LEDGER_WRITE_FAILED");
        }
        result.resolved += 1;
        result[disposition] += 1;
      }
    }
  }

  private replayOne(intent: WorkspaceBlobCleanupIntent): ReplayDisposition {
    if (!this.blobs.listStagedDeletesSync) {
      throw new CleanupDecisionError("BLOB_STORE_UNSUPPORTED");
    }
    const staged = this.blobs.listStagedDeletesSync();
    const sameLocatorReceipts = staged.filter((receipt) =>
      sameLocator(receipt.locator, intent.locator),
    );
    if (sameLocatorReceipts.length > 1) {
      throw new CleanupDecisionError("STAGED_RECEIPT_MISMATCH");
    }
    const stagedReceipt = sameLocatorReceipts[0] ?? null;
    const receiptWithSameId = intent.receipt
      ? (staged.find(
          (receipt) => receipt.quarantineId === intent.receipt?.quarantineId,
        ) ?? null)
      : null;
    if (
      intent.receipt &&
      ((stagedReceipt &&
        stagedReceipt.quarantineId !== intent.receipt.quarantineId) ||
        (receiptWithSameId &&
          !sameLocator(receiptWithSameId.locator, intent.locator)))
    ) {
      throw new CleanupDecisionError("STAGED_RECEIPT_MISMATCH");
    }

    const authority = this.ledger.inspectAuthority(
      intent.documentId,
      intent.versionId,
    );
    if (authority.versionExists && !authority.versionBelongsToDocument) {
      throw new CleanupDecisionError("AMBIGUOUS_AUTHORITY");
    }
    if (authority.versionExists && !authority.documentExists) {
      throw new CleanupDecisionError("AMBIGUOUS_AUTHORITY");
    }

    const record = this.records.getByLocator(intent.locator);
    if (record?.state === "stored") {
      // A stored record whose owning version was deleted is contradictory. It
      // is preserved for operator review; replay never guesses that deletion
      // was intended.
      if (
        !authority.versionExists ||
        authority.versionDeleted ||
        authority.documentDeleted
      ) {
        throw new CleanupDecisionError("AMBIGUOUS_AUTHORITY");
      }
      if (stagedReceipt) {
        this.blobs.restoreDeleteSync(stagedReceipt);
        this.verifyAuthoritativeBlob(intent.locator, record);
        return "restored";
      }
      this.verifyAuthoritativeBlob(intent.locator, record);
      return "retained";
    }

    if (record?.state === "quarantined") {
      if (
        !record.quarantineId ||
        (intent.receipt &&
          intent.receipt.quarantineId !== record.quarantineId) ||
        (stagedReceipt && stagedReceipt.quarantineId !== record.quarantineId)
      ) {
        throw new CleanupDecisionError("STAGED_RECEIPT_MISMATCH");
      }
      // Quarantine is only authoritative after the exact version is no
      // longer live. A live version is still a durable blob reference.
      if (
        authority.versionExists &&
        !authority.versionDeleted &&
        !authority.documentDeleted
      ) {
        throw new CleanupDecisionError("AMBIGUOUS_AUTHORITY");
      }
      const receipt: WorkspaceBlobDeleteReceipt = stagedReceipt ?? {
        status: "staged",
        locator: intent.locator,
        quarantineId: record.quarantineId,
      };
      this.blobs.finalizeDeleteSync(receipt);
      this.records.deleteQuarantined(record.id, record.quarantineId);
      return "finalized";
    }

    const exactVersionIsLive =
      authority.documentExists &&
      !authority.documentDeleted &&
      authority.versionExists &&
      !authority.versionDeleted &&
      authority.versionBelongsToDocument;

    if (
      intent.operation === "compensation" &&
      isRegenerableDerivedBlob(intent.locator) &&
      exactVersionIsLive
    ) {
      // A pre-put compensation intent is written before a derived blob is
      // materialized. If the process dies after the put but before its blob
      // record commits, the durable original remains authoritative and this
      // unrecorded extracted text/preview can be rebuilt. This exception must
      // never include user originals, restore/finalize intents, or a derived
      // blob that already has a durable record.
      return this.finalizeUnrecorded(
        intent.locator,
        stagedReceipt ?? intent.receipt,
      );
    }

    // A live exact version without a blob record is an ambiguous legacy or
    // damaged state. It must not be deleted. An absent version is the normal
    // upload/uploadVersion database-failure orphan; a soft-deleted version is
    // no longer live and is also safe to finish removing.
    if (authority.versionExists && !authority.versionDeleted) {
      throw new CleanupDecisionError("AMBIGUOUS_AUTHORITY");
    }

    return this.finalizeUnrecorded(
      intent.locator,
      stagedReceipt ?? intent.receipt,
    );
  }

  private finalizeUnrecorded(
    locator: WorkspaceDocumentBlobLocator,
    receipt: WorkspaceBlobDeleteReceipt | null,
  ): ReplayDisposition {
    if (receipt) {
      this.blobs.finalizeDeleteSync(receipt);
      return "finalized";
    }

    try {
      const newlyStaged = this.blobs.stageDeleteSync(locator);
      this.blobs.finalizeDeleteSync(newlyStaged);
    } catch (error) {
      // No record + no staged receipt + no physical blob is the
      // already-complete form of this idempotent compensation.
      if (!isBlobNotFound(error)) throw error;
    }
    return "finalized";
  }

  private verifyAuthoritativeBlob(
    locator: WorkspaceDocumentBlobLocator,
    record: {
      contentSha256: string;
      sizeBytes: number;
    },
  ) {
    this.blobs.readSync(locator, {
      sha256: record.contentSha256,
      size: record.sizeBytes,
    });
  }

  private persistFailureOrThrow(
    intentId: string,
    code: WorkspaceBlobCleanupReplayErrorCode,
  ) {
    try {
      this.ledger.markAttemptFailed(intentId, code);
    } catch {
      // Never expose or persist the underlying database/blob exception. The
      // stable code is the only startup diagnostic crossing this boundary.
      throw new WorkspaceBlobCleanupReplayError("LEDGER_WRITE_FAILED");
    }
  }
}
