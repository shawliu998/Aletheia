import { randomUUID } from "node:crypto";
import { ZodError } from "zod";

import type {
  BlobStore,
  WorkspaceBlobDeleteReceipt,
  WorkspaceBlobLocator,
} from "../blobStore";
import {
  CreateProjectFolderRequestSchema,
  CreateProjectRequestSchema,
  UpdateProjectFolderRequestSchema,
  UpdateProjectRequestSchema,
} from "../contracts";
import { WorkspaceApiError } from "../errors";
import {
  ProjectsRepository,
  type ActiveProjectResourceJob,
  type AuthoritativeProjectBlob,
  type StagedProjectBlob,
} from "../repositories/projects";

/** Kept only as a source-compatible marker for pre-authority callers. */
export type ProjectDerivedBlobMetadata = {
  hasExtractedText(documentId: string, versionId: string): boolean;
};

export interface ResourceLifecyclePort {
  cancelQueued(jobIds: readonly string[], reason: string): void;
  requestAbortRunning(jobIds: readonly string[], reason: string): void;
}

export type ProjectLifecycleCleanupRecord = {
  scope: "project" | "folder";
  resourceId: string;
  operation: "restore" | "finalize";
  code: "PROJECT_BLOB_RESTORE_FAILED" | "PROJECT_BLOB_FINALIZE_FAILED";
  recordId: string;
  locator: WorkspaceBlobLocator;
  receipt: WorkspaceBlobDeleteReceipt;
};

export interface ProjectLifecycleCleanupRecorder {
  record(input: ProjectLifecycleCleanupRecord): void;
}

export type ProjectsServiceOptions = {
  resources: ResourceLifecyclePort;
  cleanupRecorder: ProjectLifecycleCleanupRecorder;
  clock?: () => Date;
  nextId?: () => string;
};

export class ProjectLifecycleCleanupPendingError extends WorkspaceApiError {
  readonly cleanupCode:
    | "PROJECT_BLOB_RESTORE_FAILED"
    | "PROJECT_BLOB_FINALIZE_FAILED";

  constructor(cleanupCode: ProjectLifecycleCleanupPendingError["cleanupCode"]) {
    super(
      500,
      "INTERNAL_ERROR",
      "Project blob cleanup is pending a safe retry; deletion is not complete.",
    );
    this.name = "ProjectLifecycleCleanupPendingError";
    this.cleanupCode = cleanupCode;
  }
}

type StagedBlob = {
  recordId: string;
  locator: AuthoritativeProjectBlob["locator"];
  receipt: WorkspaceBlobDeleteReceipt;
};

function isLifecycleOptions(
  value: ProjectsServiceOptions | ProjectDerivedBlobMetadata | undefined,
): value is ProjectsServiceOptions {
  return Boolean(
    value &&
    typeof value === "object" &&
    "resources" in value &&
    "cleanupRecorder" in value,
  );
}

export class ProjectsService {
  private readonly resources: ResourceLifecyclePort | null;
  private readonly cleanupRecorder: ProjectLifecycleCleanupRecorder | null;
  private readonly clock: () => Date;
  private readonly nextId: () => string;

  constructor(
    private readonly repository: ProjectsRepository,
    private readonly blobs: BlobStore,
    optionsOrLegacy?: ProjectsServiceOptions | ProjectDerivedBlobMetadata,
    legacyClock: () => Date = () => new Date(),
  ) {
    if (isLifecycleOptions(optionsOrLegacy)) {
      this.resources = optionsOrLegacy.resources;
      this.cleanupRecorder = optionsOrLegacy.cleanupRecorder;
      this.clock = optionsOrLegacy.clock ?? (() => new Date());
      this.nextId = optionsOrLegacy.nextId ?? randomUUID;
    } else {
      this.resources = null;
      this.cleanupRecorder = null;
      this.clock = legacyClock;
      this.nextId = randomUUID;
    }
  }

  private now() {
    return this.clock().toISOString();
  }

  private publicCall<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof WorkspaceApiError) throw error;
      if (error instanceof ZodError) {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "Project request is invalid.",
          error.issues.slice(0, 100).map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        );
      }
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Project operation failed.",
      );
    }
  }

  list(input?: {
    status?: "active" | "archived";
    cursor?: string | null;
    limit?: number;
  }) {
    return this.publicCall(() => this.repository.list(input));
  }

  get(id: string) {
    return this.publicCall(() => this.repository.require(id));
  }

  overview(id: string) {
    return this.publicCall(() => this.repository.overview(id));
  }

  listFolders(projectId: string) {
    return this.publicCall(() => this.repository.listFolders(projectId));
  }

  getFolder(id: string) {
    return this.publicCall(() => this.repository.requireFolder(id));
  }

  create(value: unknown) {
    return this.publicCall(() => {
      const input = CreateProjectRequestSchema.parse(value);
      return this.repository.create({
        id: this.nextId(),
        name: input.name,
        description: input.description ?? null,
        cmNumber: input.cmNumber ?? null,
        practice: input.practice ?? null,
        now: this.now(),
      });
    });
  }

  update(id: string, value: unknown) {
    return this.publicCall(() => {
      const input = UpdateProjectRequestSchema.parse(value);
      return this.repository.update(id, { ...input, now: this.now() });
    });
  }

  archive(id: string) {
    return this.publicCall(() => this.repository.archive(id, this.now()));
  }

  unarchive(id: string) {
    return this.publicCall(() => this.repository.unarchive(id, this.now()));
  }

  createFolder(projectId: string, value: unknown) {
    return this.publicCall(() => {
      const input = CreateProjectFolderRequestSchema.parse(value);
      return this.repository.createFolder({
        id: this.nextId(),
        projectId,
        parentFolderId: input.parentFolderId ?? null,
        name: input.name,
        now: this.now(),
      });
    });
  }

  updateFolder(id: string, value: unknown) {
    return this.publicCall(() => {
      const input = UpdateProjectFolderRequestSchema.parse(value);
      return this.repository.updateFolder(id, {
        ...input,
        now: this.now(),
      });
    });
  }

  deleteFolder(id: string) {
    return this.publicCall(() => {
      this.repository.requireFolder(id);
      this.lifecycleInfrastructure();
      const plan = this.repository.folderDeletionPlan(id);
      this.settleActiveJobs(
        plan.activeJobs,
        "Folder subtree deletion requested.",
      );
      return this.executeDeletion("folder", id, plan.blobs, (staged) =>
        this.repository.deleteFolderSubtreeCascade(id, staged, this.now()),
      );
    });
  }

  permanentlyDelete(id: string, confirmName: string) {
    return this.publicCall(() => {
      if (typeof confirmName !== "string") {
        throw new WorkspaceApiError(
          400,
          "VALIDATION_ERROR",
          "Project confirmation must be a string.",
        );
      }
      this.repository.assertPermanentDelete(id, confirmName);
      this.lifecycleInfrastructure();
      const plan = this.repository.projectDeletionPlan(id);
      this.settleActiveJobs(
        plan.activeJobs,
        "Project permanent deletion requested.",
      );
      return this.executeDeletion("project", id, plan.blobs, (staged) =>
        this.repository.deleteProjectCascade(
          id,
          confirmName,
          staged,
          this.now(),
        ),
      );
    });
  }

  private lifecycleInfrastructure(): {
    resources: ResourceLifecyclePort;
    cleanupRecorder: ProjectLifecycleCleanupRecorder;
  } {
    if (!this.resources || !this.cleanupRecorder) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Project deletion lifecycle is unavailable.",
      );
    }
    return {
      resources: this.resources,
      cleanupRecorder: this.cleanupRecorder,
    };
  }

  private settleActiveJobs(
    jobs: readonly ActiveProjectResourceJob[],
    reason: string,
  ) {
    const { resources } = this.lifecycleInfrastructure();
    const queued = jobs
      .filter((job) => job.status === "queued")
      .map((job) => job.id);
    const running = jobs
      .filter((job) => job.status === "running")
      .map((job) => job.id);
    try {
      if (queued.length) resources.cancelQueued(queued, reason);
      if (running.length) resources.requestAbortRunning(running, reason);
    } catch {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Project resources could not be stopped for deletion.",
      );
    }
  }

  private executeDeletion<T>(
    scope: "project" | "folder",
    resourceId: string,
    records: readonly AuthoritativeProjectBlob[],
    deleteRows: (staged: readonly StagedProjectBlob[]) => T,
  ): T {
    this.lifecycleInfrastructure();
    const staged: StagedBlob[] = [];
    try {
      for (const record of records) {
        staged.push({
          recordId: record.recordId,
          locator: record.locator,
          receipt: this.blobs.stageDeleteSync(record.locator),
        });
      }
    } catch {
      this.restoreStaged(scope, resourceId, staged);
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Project blobs could not be staged for deletion.",
      );
    }

    // The project/folder cascade removes the authoritative blob rows. Persist
    // one authority-driven cleanup intent for every staged blob *before* that
    // transaction is allowed to commit. On restart, a still-live row causes
    // replay to restore the blob; an absent row causes replay to finalize it.
    // This closes the crash window between the database cascade and physical
    // finalize. Successful finalization may leave an idempotent pending intent
    // until the next startup replay, which is safer than an unjournaled delete.
    try {
      for (const item of staged) {
        this.recordCleanup({
          scope,
          resourceId,
          operation: "finalize",
          code: "PROJECT_BLOB_FINALIZE_FAILED",
          recordId: item.recordId,
          locator: item.locator,
          receipt: item.receipt,
        });
      }
    } catch (error) {
      this.restoreStaged(scope, resourceId, staged);
      throw error;
    }

    let result: T;
    try {
      result = deleteRows(
        staged.map((item) => ({
          recordId: item.recordId,
          quarantineId: item.receipt.quarantineId,
        })),
      );
    } catch (error) {
      this.restoreStaged(scope, resourceId, staged);
      throw error;
    }

    let finalizeFailed = false;
    for (const item of staged) {
      try {
        this.blobs.finalizeDeleteSync(item.receipt);
      } catch {
        finalizeFailed = true;
      }
    }
    if (finalizeFailed) {
      throw new ProjectLifecycleCleanupPendingError(
        "PROJECT_BLOB_FINALIZE_FAILED",
      );
    }
    return result;
  }

  private restoreStaged(
    scope: "project" | "folder",
    resourceId: string,
    staged: readonly StagedBlob[],
  ) {
    let restoreFailed = false;
    for (const item of [...staged].reverse()) {
      try {
        this.blobs.restoreDeleteSync(item.receipt);
      } catch {
        restoreFailed = true;
        this.recordCleanup({
          scope,
          resourceId,
          operation: "restore",
          code: "PROJECT_BLOB_RESTORE_FAILED",
          recordId: item.recordId,
          locator: item.locator,
          receipt: item.receipt,
        });
      }
    }
    if (restoreFailed) {
      throw new ProjectLifecycleCleanupPendingError(
        "PROJECT_BLOB_RESTORE_FAILED",
      );
    }
  }

  private recordCleanup(input: ProjectLifecycleCleanupRecord) {
    const { cleanupRecorder } = this.lifecycleInfrastructure();
    try {
      cleanupRecorder.record(input);
    } catch {
      throw new ProjectLifecycleCleanupPendingError(input.code);
    }
  }
}
