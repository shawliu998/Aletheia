import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { WorkspaceChatsV1Port } from "../../routes/workspaceChatsV1";
import type {
  WorkspaceDocumentStudioCreateInput,
  WorkspaceDocumentStudioExportResult,
  WorkspaceDocumentStudioImportInput,
  WorkspaceDocumentStudioImportResult,
  WorkspaceDocumentStudioRestoreInput,
  WorkspaceDocumentStudioSaveInput,
  WorkspaceDocumentStudioDocxWarningCode,
  WorkspaceDocumentStudioV1Port,
} from "../../routes/workspaceDocumentStudioV1";
import type {
  WorkspaceProjectSourceAnchorInput,
  WorkspaceProjectSourceListInput,
  WorkspaceProjectSourcesV1Port,
} from "../../routes/workspaceProjectSourcesV1";
import type { WorkspaceTabularV1RuntimePort } from "../../routes/workspaceTabularV1";
import type {
  WorkspaceV1Context,
  WorkspaceV1DocumentCapability,
  WorkspaceV1DocumentList,
  WorkspaceV1DocumentMutationScope,
  WorkspaceV1DocumentUploadInput,
  WorkspaceV1DocumentVersionUploadInput,
  WorkspaceV1Download,
  WorkspaceV1Page,
  WorkspaceV1RuntimePort,
} from "../../routes/workspaceV1";
import { LocalWorkspaceBlobStore } from "./localWorkspaceBlobStore";
import { WorkspaceDatabase } from "./database";
import {
  exportDocumentStudioMarkdownToDocx,
  importDocumentStudioDocxToMarkdown,
  type DocumentStudioDocxWarning,
} from "./documentStudioDocx";
import { InMemoryDownloadCapabilityStore } from "./downloadCapabilities";
import { WorkspaceApiError } from "./errors";
import { WorkspaceJobPump } from "./jobs/pump";
import {
  MIKE_LOCAL_USER_ID,
  serializeMikeDocument,
  serializeMikeDocumentVersion,
  serializeMikeProject,
  type MikeDocumentVersionWire,
  type MikeDocumentWire,
  type MikeProjectWire,
} from "./mikeCompatibility";
import { WORKSPACE_LOCAL_PRINCIPAL_ID } from "./principal";
import { WorkspaceBlobCleanupRepository } from "./repositories/blobCleanup";
import { WorkspaceBlobRecordsRepository } from "./repositories/blobRecords";
import { WorkspaceDocumentStudioRepository } from "./repositories/documentStudio";
import { WorkspaceSourceFoundationRepository } from "./repositories/sourceFoundation";
import { AssistantRetrievalRepository } from "./repositories/assistantRetrieval";
import { ChatsRepository } from "./repositories/chats";
import {
  type DocumentParseJob,
  WorkspaceDocumentsRepository,
} from "./repositories/documents";
import { WorkspaceJobsRepository } from "./repositories/jobs";
import { ModelConnectionTestsRepository } from "./repositories/modelConnectionTests";
import { ModelProfilesRepository } from "./repositories/modelProfiles";
import {
  type ProjectOverview,
  type ProjectSummary,
  ProjectsRepository,
} from "./repositories/projects";
import { SettingsRepository } from "./repositories/settings";
import { TabularRepository } from "./repositories/tabular";
import {
  WorkspaceBlobReconciliation,
  WorkspaceBlobStartupRecovery,
} from "./services/blobReconciliation";
import { WorkspaceBlobCleanupReplay } from "./services/blobCleanup";
import { WorkspaceDocumentCatalogService } from "./services/documentCatalog";
import {
  serializeWorkspaceDocumentOcrSummary,
  WorkspaceDocumentOcrSummaryService,
  type WorkspaceDocumentOcrSummaryWire,
} from "./services/documentOcrSummary";
import {
  type DocumentStudioDocument,
  type DocumentStudioVersion,
  type DocumentStudioVersionList,
  WorkspaceDocumentStudioService,
  type WorkspaceDocumentStudioRepositoryPort,
} from "./services/documentStudio";
import { WorkspaceDocumentStudioRepositoryAdapter } from "./services/documentStudioRepositoryAdapter";
import {
  WorkspaceProjectSourcesService,
  type CaptureProjectDocumentSourceResult,
  type ProjectSourceDetail,
  type ProjectSourcePage,
} from "./services/projectSources";
import {
  type DocumentUploadResult,
  type PublicDocumentVersion,
  WorkspaceDocumentsService,
} from "./services/documents";
import { WorkspaceDocumentParser } from "./documentParsing";
import {
  WorkspaceJobAbortRegistry,
  WorkspaceJobsService,
} from "./services/jobs";
import { WorkspaceJobEnqueuerAdapter } from "./services/jobEnqueuer";
import { ProjectsService } from "./services/projects";
import type { CredentialStorePort } from "./services/credentialStore";
import { ModelProfilesService } from "./services/modelProfiles";
import { SettingsService } from "./services/settings";
import { AuthoritativeExtractedTextReader } from "./services/authoritativeExtractedText";
import { WorkspaceTabularModelAdapter } from "./services/tabularModelAdapter";
import { TabularService } from "./services/tabular";
import { createTabularCellJobHandler } from "./services/tabularRuntime";
import { WorkspaceTabularV1RuntimeAdapter } from "./services/tabularV1RuntimeAdapter";
import { WorkflowsService } from "./services/workflows";
import type { ProjectLifecycleCleanupRecord } from "./services/projects";
import type { Document, ProjectFolder } from "./types";
import { WorkflowsRepository } from "./repositories/workflows";
import { WorkflowDocumentContextRepository } from "./repositories/workflowDocumentContext";
import {
  MikeWorkflowCrudPortAdapter,
  seedPinnedMikeSystemWorkflows,
} from "./workflowCompatibility";
import {
  WorkspaceModelProviderRegistry,
  type WorkspaceModelProviderRegistryOptions,
} from "./modelProviderRegistry";
import { RotatingModelCallDiagnostics } from "./modelCallDiagnostics";
import { WorkspaceModelSettingsRuntime } from "./modelSettingsRuntime";
import {
  AssistantRuntimeService,
  type AssistantModelPort,
  type AssistantToolPort,
} from "./services/assistantRuntime";
import { WorkspaceAssistantModelAdapter } from "./services/assistantModelAdapter";
import {
  WorkspaceAssistantCapabilityHydrator,
  WorkspaceAssistantDocumentTools,
} from "./services/assistantDocumentTools";
import { WorkspaceChatsRuntimePort } from "./services/assistantChatsPort";
import { ChatsService } from "./services/chats";
import {
  WorkspaceWorkflowRuntime,
  type WorkflowStepExecutor,
} from "./services/workflowRuntime";
import { WorkspaceWorkflowStepExecutor } from "./services/workflowExecutor";

type CleanupRecorder = ConstructorParameters<
  typeof WorkspaceDocumentsService
>[3];

type WorkspaceProjectWire = MikeProjectWire & {
  description: string | null;
  workflow_count: number;
  status: "active" | "archived" | "deleted";
  archived_at: string | null;
  default_model_profile_id: string | null;
};
type WorkspaceDocumentJobWire = {
  id: string;
  type: "document_parse";
  status: DocumentParseJob["status"];
  attempt: number;
  max_attempts: number;
  retryable: boolean;
  created_at: string;
  scheduled_at: string;
  started_at: string | null;
  completed_at: string | null;
};
type WorkspaceDocumentMutationWire = {
  document: WorkspaceMikeDocumentWire;
  version: MikeDocumentVersionWire;
  job: WorkspaceDocumentJobWire;
};

type WorkspaceDocumentStudioCapabilityWire = {
  editable: boolean;
  format: "markdown" | null;
  docx_import: boolean;
  docx_export: boolean;
};

type WorkspaceMikeDocumentWire = MikeDocumentWire & {
  studio_capability: WorkspaceDocumentStudioCapabilityWire;
  ocr_summary: WorkspaceDocumentOcrSummaryWire | null;
};

type ProjectRequest = {
  name?: unknown;
  description?: unknown;
  cm_number?: unknown;
  practice?: unknown;
};
type FolderRequest = { name?: unknown; parent_folder_id?: unknown };

export type WorkspaceRuntimeHealth = {
  started: boolean;
  draining: boolean;
  worker: {
    documentParse: boolean;
    assistantGenerate: boolean;
    tabularCell: boolean;
  };
};

export type WorkspaceRuntimeDependencies = {
  dataDir?: string;
  database?: WorkspaceDatabase;
  blobs?: LocalWorkspaceBlobStore;
  capabilities?: InMemoryDownloadCapabilityStore;
  abortRegistry?: WorkspaceJobAbortRegistry;
  jobs?: WorkspaceJobsService;
  pump?: Pick<WorkspaceJobPump, "start" | "stop" | "snapshot">;
  projects?: ProjectsService;
  projectRepository?: ProjectsRepository;
  documents?: WorkspaceDocumentCatalogService;
  documentService?: WorkspaceDocumentsService;
  documentRepository?: WorkspaceDocumentsRepository;
  documentStudioService?: WorkspaceDocumentStudioService;
  documentStudioRepository?: WorkspaceDocumentStudioRepositoryPort;
  projectSourcesService?: WorkspaceProjectSourcesService;
  workflows?: WorkflowsService;
  workflowCrud?: MikeWorkflowCrudPortAdapter;
  seedWorkflows?: (workflows: WorkflowsService) => readonly unknown[];
  credentialStore?: CredentialStorePort;
  modelProviderRegistry?: WorkspaceModelProviderRegistry;
  modelSettings?: WorkspaceModelSettingsRuntime;
  modelProviderOptions?: WorkspaceModelProviderRegistryOptions;
  allowLocalDevelopmentModelBaseUrl?: boolean;
  assistantModel?: AssistantModelPort;
  assistantTools?: AssistantToolPort;
  workflowExecutor?: WorkflowStepExecutor;
  /** Read-only authority for derived blob metadata.  This is injectable solely
   * for runtime integration tests; production shares the repository instance. */
  blobRecords?: WorkspaceBlobRecordsRepository;
  runMigrations?: (database: WorkspaceDatabase) => void;
  /** Test seams for the existing startup-recovery coordinator. Production
   * always uses the durable cleanup replay followed by reconciliation. */
  cleanupReplay?: Pick<WorkspaceBlobCleanupReplay, "replayPending">;
  blobReconciliation?: Pick<WorkspaceBlobReconciliation, "reconcile">;
  startupRecovery?: Pick<WorkspaceBlobStartupRecovery, "recover">;
};

function defaultDataDir() {
  return process.env.ALETHEIA_DATA_DIR ?? path.join(process.cwd(), ".aletheia");
}

function requireLocal(context: WorkspaceV1Context) {
  if (context.principalId !== WORKSPACE_LOCAL_PRINCIPAL_ID) {
    throw new WorkspaceApiError(403, "FORBIDDEN", "Workspace is local-only.");
  }
}

function requestRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceApiError(
      400,
      "VALIDATION_ERROR",
      `${label} is invalid.`,
    );
  }
  return value as Record<string, unknown>;
}

function projectRequest(value: unknown): ProjectRequest {
  const input = requestRecord(value, "Project request");
  return {
    name: input.name,
    description: input.description,
    cm_number: input.cm_number,
    practice: input.practice,
  };
}

function folderRequest(value: unknown): FolderRequest {
  const input = requestRecord(value, "Folder request");
  return { name: input.name, parent_folder_id: input.parent_folder_id };
}

function studioDocxWarningCodes(
  warnings: readonly DocumentStudioDocxWarning[],
): WorkspaceDocumentStudioDocxWarningCode[] {
  return [...new Set(warnings.map((warning) => warning.code))];
}

function studioDocxFilename(markdownFilename: string): string {
  const stem = markdownFilename.replace(/\.md$/i, "").trim();
  const boundedStem = [...(stem || "Untitled")].slice(0, 235).join("").trim();
  return `${boundedStem || "Untitled"}.docx`;
}

/**
 * The one workspace composition root. It owns exactly one WorkspaceDatabase
 * handle and is the only place that wires durable cleanup, blobs, jobs, and
 * the HTTP facade together.
 */
export class WorkspaceRuntime
  implements
    WorkspaceV1RuntimePort,
    WorkspaceDocumentStudioV1Port,
    WorkspaceProjectSourcesV1Port
{
  readonly database: WorkspaceDatabase;
  readonly blobs: LocalWorkspaceBlobStore;
  readonly capabilities: InMemoryDownloadCapabilityStore;
  readonly abortRegistry: WorkspaceJobAbortRegistry;
  readonly jobs: WorkspaceJobsService;
  readonly pump: Pick<WorkspaceJobPump, "start" | "stop" | "snapshot">;
  readonly projects: ProjectsService;
  readonly documents: WorkspaceDocumentCatalogService;
  readonly workflows: WorkflowsService;
  readonly workflowCrud: MikeWorkflowCrudPortAdapter;
  readonly modelSettings: WorkspaceModelSettingsRuntime;
  readonly chats: WorkspaceChatsV1Port;
  readonly tabular: WorkspaceTabularV1RuntimePort;
  private readonly documentService: WorkspaceDocumentsService;
  private readonly documentRepository: WorkspaceDocumentsRepository;
  private readonly documentOcrSummary: WorkspaceDocumentOcrSummaryService;
  private readonly documentStudioService: WorkspaceDocumentStudioService;
  private readonly documentStudioRepository: WorkspaceDocumentStudioRepositoryPort;
  private readonly projectSourcesService: WorkspaceProjectSourcesService;
  private readonly blobRecords: WorkspaceBlobRecordsRepository;
  private readonly startMigrations: () => void;
  private readonly startupRecovery: Pick<
    WorkspaceBlobStartupRecovery,
    "recover"
  >;
  private readonly seedWorkflows: () => void;
  private readonly tabularService: TabularService;
  private readonly assistantGenerationEnabled: boolean;
  private readonly workflowExecutionEnabled: boolean;
  private readonly tabularGenerationEnabled: boolean;
  private started = false;
  private draining = false;
  private closed = false;

  constructor(dependencies: WorkspaceRuntimeDependencies = {}) {
    const dataDir = dependencies.dataDir ?? defaultDataDir();
    // Fully injected test seams do not need (and must not create) a default
    // application directory. Production, or any partially injected runtime,
    // still creates its locally controlled directory before opening storage.
    if (!dependencies.database || !dependencies.blobs) {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      chmodSync(dataDir, 0o700);
    }
    this.database =
      dependencies.database ??
      new WorkspaceDatabase(path.join(dataDir, "aletheia.db"), {
        migrate: false,
      });
    this.blobs =
      dependencies.blobs ??
      new LocalWorkspaceBlobStore({
        root: path.join(dataDir, "workspace-blobs"),
      });
    this.capabilities =
      dependencies.capabilities ?? new InMemoryDownloadCapabilityStore();
    this.abortRegistry =
      dependencies.abortRegistry ?? new WorkspaceJobAbortRegistry();

    const blobRecords =
      dependencies.blobRecords ??
      new WorkspaceBlobRecordsRepository(this.database);
    this.blobRecords = blobRecords;
    const cleanupLedger = new WorkspaceBlobCleanupRepository(this.database);
    this.documentRepository =
      dependencies.documentRepository ??
      new WorkspaceDocumentsRepository(this.database, { blobRecords });
    this.documentOcrSummary = new WorkspaceDocumentOcrSummaryService(
      this.database,
    );
    const jobsRepository = new WorkspaceJobsRepository(this.database);
    this.jobs =
      dependencies.jobs ??
      new WorkspaceJobsService(jobsRepository, {
        abortRegistry: this.abortRegistry,
      });
    this.workflows =
      dependencies.workflows ??
      new WorkflowsService(
        new WorkflowsRepository(this.database),
        new WorkspaceJobEnqueuerAdapter(this.jobs),
      );
    const cleanupRecorder: CleanupRecorder = {
      record: (input) => cleanupLedger.record(input),
    };
    const lifecycle = {
      cancelQueued: (ids: readonly string[], reason: string) => {
        for (const id of ids) this.requestJobCancellation(id, reason);
      },
      requestAbortRunning: (ids: readonly string[], reason: string) => {
        for (const id of ids) {
          this.requestJobCancellation(id, reason);
        }
      },
    };
    const projectCleanupRecorder = {
      record: (input: ProjectLifecycleCleanupRecord) => {
        if (input.locator.kind === "export") {
          throw new Error("Project cleanup cannot record an export blob.");
        }
        cleanupLedger.record({
          operation: input.operation,
          code:
            input.operation === "restore"
              ? "DOCUMENT_BLOB_RESTORE_FAILED"
              : "DOCUMENT_BLOB_FINALIZE_FAILED",
          documentId: input.locator.documentId,
          versionId: input.locator.versionId,
          locator: input.locator,
          receipt: input.receipt,
        });
      },
    };
    const projectsRepository =
      dependencies.projectRepository ?? new ProjectsRepository(this.database);
    this.projects =
      dependencies.projects ??
      new ProjectsService(projectsRepository, this.blobs, {
        resources: lifecycle,
        cleanupRecorder: projectCleanupRecorder,
      });
    const modelProfilesRepository = new ModelProfilesRepository(this.database);
    const providerRegistry =
      dependencies.modelProviderRegistry ??
      (dependencies.credentialStore
        ? new WorkspaceModelProviderRegistry(dependencies.credentialStore, {
            ...dependencies.modelProviderOptions,
            allowLocalDevelopmentBaseUrl:
              dependencies.allowLocalDevelopmentModelBaseUrl ?? false,
          })
        : null);
    const modelProfiles = new ModelProfilesService(modelProfilesRepository, {
      allowLocalDevelopmentBaseUrl:
        dependencies.allowLocalDevelopmentModelBaseUrl ?? false,
      runtimeWired: providerRegistry?.runtimeWired() === true,
      resources: lifecycle,
      credentialStore: dependencies.credentialStore,
      adapterRegistry: providerRegistry ?? undefined,
    });
    const settings = new SettingsService(
      new SettingsRepository(this.database),
      projectsRepository,
      modelProfilesRepository,
      undefined,
      { runtimeWired: providerRegistry?.runtimeWired() === true },
    );
    this.modelSettings =
      dependencies.modelSettings ??
      new WorkspaceModelSettingsRuntime({
        profiles: modelProfiles,
        profileRepository: modelProfilesRepository,
        connectionTests: new ModelConnectionTestsRepository(this.database),
        settings,
        providerRegistry,
        allowLocalDevelopmentBaseUrl:
          dependencies.allowLocalDevelopmentModelBaseUrl ?? false,
      });
    const sourceFoundation = new WorkspaceSourceFoundationRepository(
      this.database,
    );
    this.documentStudioRepository =
      dependencies.documentStudioRepository ??
      new WorkspaceDocumentStudioRepositoryAdapter(
        new WorkspaceDocumentStudioRepository(this.database, { blobRecords }),
        sourceFoundation,
      );
    this.documentStudioService =
      dependencies.documentStudioService ??
      new WorkspaceDocumentStudioService(
        this.documentStudioRepository,
        this.blobs,
        blobRecords,
        { cleanupRecorder },
      );
    this.projectSourcesService =
      dependencies.projectSourcesService ??
      new WorkspaceProjectSourcesService(this.database, sourceFoundation);
    this.documentService =
      dependencies.documentService ??
      new WorkspaceDocumentsService(
        this.documentRepository,
        this.blobs,
        undefined,
        cleanupRecorder,
        lifecycle,
      );
    this.documents =
      dependencies.documents ??
      new WorkspaceDocumentCatalogService(
        this.documentRepository,
        this.documentService,
        this.blobs,
        this.capabilities,
      );
    const chatsRepository = new ChatsRepository(this.database);
    const assistantModel =
      dependencies.assistantModel ??
      (providerRegistry
        ? new WorkspaceAssistantModelAdapter(
            modelProfilesRepository,
            providerRegistry,
            {
              allowLocalDevelopmentBaseUrl:
                dependencies.allowLocalDevelopmentModelBaseUrl ?? false,
            },
          )
        : null);
    const assistantTools =
      dependencies.assistantTools ??
      new WorkspaceAssistantDocumentTools(
        this.database,
        chatsRepository,
        new AssistantRetrievalRepository(this.database),
      );
    const assistantRuntime = assistantModel
      ? new AssistantRuntimeService(
          chatsRepository,
          jobsRepository,
          assistantModel,
          { tools: assistantTools },
        )
      : null;
    this.assistantGenerationEnabled = assistantRuntime !== null;
    const workflowExecutor =
      dependencies.workflowExecutor ??
      (assistantModel
        ? new WorkspaceWorkflowStepExecutor(
            assistantModel,
            new WorkflowDocumentContextRepository(this.database),
          )
        : null);
    const workflowRuntime = workflowExecutor
      ? new WorkspaceWorkflowRuntime(
          this.workflows,
          this.jobs.repository,
          workflowExecutor,
        )
      : null;
    this.workflowExecutionEnabled = workflowRuntime !== null;
    this.workflowCrud =
      dependencies.workflowCrud ??
      new MikeWorkflowCrudPortAdapter(this.workflows, {
        executionAvailable: () => this.workflowExecutionEnabled,
      });
    const chatLifecycle = {
      cancelQueued: (ids: readonly string[]) => {
        for (const id of ids) {
          this.jobs.requestCancellation(id, "Chat deletion requested.");
        }
      },
      requestAbortRunning: (ids: readonly string[]) => {
        for (const id of ids) {
          this.jobs.requestCancellation(id, "Chat deletion requested.");
        }
      },
    };
    this.chats = new WorkspaceChatsRuntimePort(
      new ChatsService(
        chatsRepository,
        projectsRepository,
        modelProfilesRepository,
        undefined,
        {
          jobs: this.jobs,
          generationControl: this.jobs,
          capabilities: new WorkspaceAssistantCapabilityHydrator(
            this.database,
            this.documentRepository,
          ),
          lifecycle: chatLifecycle,
        },
      ),
    );
    const tabularRepository = new TabularRepository(this.database);
    const tabularSnapshots = new AuthoritativeExtractedTextReader(
      this.database,
      this.blobs,
    );
    const tabularModel =
      providerRegistry?.runtimeWired() === true
        ? new WorkspaceTabularModelAdapter(
            modelProfilesRepository,
            providerRegistry,
            tabularSnapshots,
            {
              allowLocalDevelopmentBaseUrl:
                dependencies.allowLocalDevelopmentModelBaseUrl ?? false,
            },
          )
        : null;
    this.tabularGenerationEnabled = tabularModel !== null;
    this.tabularService = new TabularService(
      tabularRepository,
      new WorkspaceJobEnqueuerAdapter(this.jobs),
      undefined,
      undefined,
      tabularModel
        ? {
            snapshots: tabularSnapshots,
            profiles: modelProfilesRepository,
          }
        : undefined,
    );
    this.tabular = new WorkspaceTabularV1RuntimeAdapter(
      this.database,
      tabularRepository,
      this.tabularService,
    );
    const tabularCellHandler = tabularModel
      ? createTabularCellJobHandler({
          database: this.database,
          tabular: tabularRepository,
          jobs: this.jobs.repository,
          model: tabularModel,
          snapshots: tabularSnapshots,
        })
      : null;
    const parser = new WorkspaceDocumentParser(
      this.documentRepository,
      this.blobs,
      undefined,
      undefined,
      cleanupRecorder,
    );
    this.pump =
      dependencies.pump ??
      new WorkspaceJobPump({
        jobs: this.jobs,
        abortRegistry: this.abortRegistry,
        concurrency:
          assistantRuntime || workflowRuntime || tabularCellHandler ? 2 : 1,
        handlers: {
          document_parse: (context) => parser.handleJob(context),
          ...(assistantRuntime
            ? {
                assistant_generate: (context) => {
                  if (!context.claim) {
                    throw new WorkspaceApiError(
                      500,
                      "INTERNAL_ERROR",
                      "Assistant generation requires a fenced job claim.",
                    );
                  }
                  return assistantRuntime.execute({
                    jobId: context.job.id,
                    leaseOwner: context.claim.leaseOwner,
                    attempt: context.claim.attempt,
                    signal: context.signal,
                  });
                },
              }
            : {}),
          ...(workflowRuntime
            ? {
                workflow_run: (context) => workflowRuntime.handle(context),
              }
            : {}),
          ...(tabularCellHandler
            ? {
                tabular_cell: tabularCellHandler,
              }
            : {}),
        },
      });
    const cleanupReplay =
      dependencies.cleanupReplay ??
      new WorkspaceBlobCleanupReplay(cleanupLedger, blobRecords, this.blobs);
    const blobReconciliation =
      dependencies.blobReconciliation ??
      new WorkspaceBlobReconciliation(
        blobRecords,
        this.blobs,
        this.documentRepository,
      );
    this.startMigrations = () => {
      if (dependencies.runMigrations) dependencies.runMigrations(this.database);
      else this.database.runMigrations();
    };
    this.startupRecovery =
      dependencies.startupRecovery ??
      new WorkspaceBlobStartupRecovery(cleanupReplay, blobReconciliation);
    this.seedWorkflows = () => {
      const seeded = dependencies.seedWorkflows
        ? dependencies.seedWorkflows(this.workflows)
        : seedPinnedMikeSystemWorkflows(this.workflows);
      if (seeded.length !== 21) {
        throw new Error(
          "Pinned Mike workflow seeding did not produce 21 templates.",
        );
      }
    };
  }

  async start() {
    if (this.started) return;
    if (this.closed) throw new Error("Workspace runtime is closed.");
    try {
      this.startMigrations();
      await this.modelSettings.reconcileCredentialOrphans();
      this.seedWorkflows();
      this.startupRecovery.recover();
      await this.pump.start();
      this.tabularService.reconcileGenerationJobs();
      this.workflows.reconcileTerminalJobs();
      this.started = true;
    } catch (error) {
      try {
        await this.pump.stop();
      } catch {
        /* startup failure wins */
      } finally {
        this.abortRegistry.abortAll();
        this.capabilities.clear();
      }
      this.database.close();
      this.closed = true;
      throw error;
    }
  }

  async stop() {
    if (this.closed) return;
    this.draining = true;
    let drainTimedOut = false;
    try {
      const result = await this.pump.stop();
      drainTimedOut = result.drained === false;
    } finally {
      this.abortRegistry.abortAll();
      this.capabilities.clear();
      this.database.close();
      this.started = false;
      this.closed = true;
      this.draining = false;
    }
    if (drainTimedOut) {
      throw new Error("Workspace jobs did not drain before shutdown.");
    }
  }

  health(): WorkspaceRuntimeHealth {
    const pump = this.pump.snapshot();
    return {
      started: this.started,
      draining: this.draining,
      worker: {
        documentParse: pump.started && !pump.stopping,
        assistantGenerate:
          this.assistantGenerationEnabled && pump.started && !pump.stopping,
        tabularCell:
          this.tabularGenerationEnabled && pump.started && !pump.stopping,
      },
    };
  }

  assistantGenerationAvailable() {
    return this.assistantGenerationEnabled;
  }

  workflowExecutionAvailable() {
    return this.workflowExecutionEnabled;
  }

  tabularGenerationAvailable() {
    return this.tabularGenerationEnabled;
  }

  async listProjects(context: WorkspaceV1Context, page: WorkspaceV1Page) {
    this.requireAccess(context);
    const explicitlyPaged =
      page.cursor !== undefined || page.limit !== undefined;
    if (explicitlyPaged) {
      const result = this.projects.list({
        cursor: page.cursor ?? null,
        limit: page.limit,
      });
      if (Array.isArray(result)) {
        return {
          items: result.map((project) => this.projectSummaryWire(project)),
          next_cursor: null,
        };
      }
      return {
        items: result.items.map((project) => this.projectSummaryWire(project)),
        next_cursor: result.nextCursor,
      };
    }

    // Locked Mike e32daad clients expect GET /projects to return Project[],
    // not a pagination envelope. Walk the bounded repository pages internally
    // so the direct UI port remains byte-shape compatible while local callers
    // can opt into cursor pagination explicitly.
    const items: WorkspaceProjectWire[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const result = this.projects.list({ cursor, limit: 100 });
      if (Array.isArray(result)) {
        items.push(
          ...result.map((project) => this.projectSummaryWire(project)),
        );
        cursor = null;
        continue;
      }
      items.push(
        ...result.items.map((project) => this.projectSummaryWire(project)),
      );
      cursor = result.nextCursor;
      if (cursor && seenCursors.has(cursor)) {
        throw new WorkspaceApiError(
          500,
          "INTERNAL_ERROR",
          "Project pagination did not advance.",
        );
      }
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return items;
  }
  async createProject(context: WorkspaceV1Context, input: unknown) {
    this.requireAccess(context);
    const request = projectRequest(input);
    const p = this.projects.create({
      name: request.name,
      description: request.description,
      cmNumber: request.cm_number,
      practice: request.practice,
    });
    return this.projectWire(this.projects.overview(p.id));
  }
  async getProject(context: WorkspaceV1Context, id: string) {
    this.requireAccess(context);
    return this.projectWire(this.projects.overview(id));
  }
  async updateProject(context: WorkspaceV1Context, id: string, input: unknown) {
    this.requireAccess(context);
    const request = projectRequest(input);
    this.projects.update(id, {
      name: request.name,
      description: request.description,
      cmNumber: request.cm_number,
      practice: request.practice,
    });
    return this.projectWire(this.projects.overview(id));
  }
  async archiveProject(context: WorkspaceV1Context, id: string) {
    this.requireAccess(context);
    this.projects.archive(id);
    return this.projectWire(this.projects.overview(id));
  }
  async unarchiveProject(context: WorkspaceV1Context, id: string) {
    this.requireAccess(context);
    this.projects.unarchive(id);
    return this.projectWire(this.projects.overview(id));
  }
  async deleteProject(
    context: WorkspaceV1Context,
    id: string,
    confirmName: string,
  ) {
    this.requireAccess(context);
    this.projects.permanentlyDelete(id, confirmName);
  }
  async listFolders(context: WorkspaceV1Context, projectId: string) {
    this.requireAccess(context);
    this.projects.get(projectId);
    return this.projects
      .listFolders(projectId)
      .map((folder) => this.folderWire(folder));
  }
  async createFolder(
    context: WorkspaceV1Context,
    projectId: string,
    input: unknown,
  ) {
    this.requireAccess(context);
    this.projects.get(projectId);
    const request = folderRequest(input);
    return this.folderWire(
      this.projects.createFolder(projectId, {
        name: request.name,
        parentFolderId: request.parent_folder_id,
      }),
    );
  }
  async updateFolder(
    context: WorkspaceV1Context,
    projectId: string,
    folderId: string,
    input: unknown,
  ) {
    this.requireAccess(context);
    const request = folderRequest(input);
    const folder = this.projects.getFolder(folderId);
    if (folder.projectId !== projectId)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Folder not found.");
    return this.folderWire(
      this.projects.updateFolder(folderId, {
        name: request.name,
        parentFolderId: request.parent_folder_id,
      }),
    );
  }
  async deleteFolder(
    context: WorkspaceV1Context,
    projectId: string,
    folderId: string,
  ) {
    this.requireAccess(context);
    const folder = this.projects.getFolder(folderId);
    if (folder.projectId !== projectId)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Folder not found.");
    this.projects.deleteFolder(folderId);
  }
  async listDocuments(
    context: WorkspaceV1Context,
    query: WorkspaceV1DocumentList,
  ) {
    this.requireAccess(context);
    this.assertDocumentCursorUnsupported(query.cursor);
    return this.documents
      .list({
        projectId: query.standalone ? null : query.projectId,
        folderId: query.folderId,
        status: query.status === "error" ? "failed" : query.status,
        limit: query.limit,
      })
      .map((document) => this.documentWire(document));
  }
  async listProjectDocuments(
    context: WorkspaceV1Context,
    projectId: string,
    page: WorkspaceV1Page,
  ) {
    this.requireAccess(context);
    this.assertDocumentCursorUnsupported(page.cursor);
    this.projects.get(projectId);
    return this.documents
      .list({ projectId, limit: page.limit })
      .map((document) => this.documentWire(document));
  }
  async attachProjectDocument(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
  ) {
    this.requireAccess(context);
    this.projects.get(projectId);
    const document = this.documents.get(documentId).document;
    if (document.projectId !== null && document.projectId !== projectId) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "A document in another project cannot be attached here.",
      );
    }
    return this.documentWire(this.documents.attach(documentId, projectId));
  }
  async uploadDocument(
    context: WorkspaceV1Context,
    input: WorkspaceV1DocumentUploadInput,
  ) {
    this.requireAccess(context);
    this.assertUploadPlacement(input.projectId, input.folderId);
    const result = await this.documentService.upload(input);
    return this.documentMutationWire(result);
  }
  async uploadDocumentVersion(
    context: WorkspaceV1Context,
    documentId: string,
    input: WorkspaceV1DocumentVersionUploadInput,
    scope?: WorkspaceV1DocumentMutationScope,
  ) {
    this.requireAccess(context);
    this.assertDocumentScope(documentId, scope?.projectId);
    this.assertGenericMutationAllowed(documentId);
    const result = await this.documents.uploadVersion(documentId, input);
    return this.documentMutationWire(result);
  }
  async deleteDocument(
    context: WorkspaceV1Context,
    documentId: string,
    scope?: WorkspaceV1DocumentMutationScope,
  ) {
    this.requireAccess(context);
    this.assertDocumentScope(documentId, scope?.projectId);
    this.documents.delete(documentId);
  }
  async retryDocumentParse(
    context: WorkspaceV1Context,
    documentId: string,
    scope?: WorkspaceV1DocumentMutationScope,
  ) {
    this.requireAccess(context);
    this.assertDocumentScope(documentId, scope?.projectId);
    const job = this.documents.retryParse(documentId);
    return job ? { job: this.documentJobWire(job) } : null;
  }
  async renameProjectDocument(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    filename: string,
  ) {
    this.requireAccess(context);
    this.assertDocumentProject(documentId, projectId);
    return this.documentWire(this.documents.rename(documentId, filename));
  }
  async moveProjectDocument(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    folderId: string | null,
  ) {
    this.requireAccess(context);
    this.assertDocumentProject(documentId, projectId);
    if (folderId) {
      const folder = this.projects.getFolder(folderId);
      if (folder.projectId !== projectId)
        throw new WorkspaceApiError(404, "NOT_FOUND", "Folder not found.");
    }
    return this.documentWire(
      this.documents.move(documentId, projectId, folderId),
    );
  }
  async createStudioDocument(
    context: WorkspaceV1Context,
    projectId: string,
    input: WorkspaceDocumentStudioCreateInput,
  ) {
    this.requireAccess(context);
    this.assertUploadPlacement(projectId, input.folderId);
    return this.studioDocumentWire(
      await this.documentStudioService.createDraft({
        projectId,
        folderId: input.folderId,
        title: input.title,
      }),
    );
  }
  async getStudioDocument(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    versionId?: string,
  ) {
    this.requireAccess(context);
    this.projects.get(projectId);
    return this.studioDocumentWire(
      await this.documentStudioService.getDocument(
        projectId,
        documentId,
        versionId,
      ),
    );
  }
  async saveStudioDocument(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    input: WorkspaceDocumentStudioSaveInput,
  ) {
    this.requireAccess(context);
    this.projects.get(projectId);
    return this.studioDocumentWire(
      await this.documentStudioService.save({
        projectId,
        documentId,
        expectedVersionId: input.expectedVersionId,
        content: input.content,
        source: input.source,
        citationAnchorIds: input.citationAnchorIds,
        summary: input.summary,
      }),
    );
  }
  async listStudioDocumentVersions(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
  ) {
    this.requireAccess(context);
    this.projects.get(projectId);
    return this.studioVersionListWire(
      await this.documentStudioService.listVersions(projectId, documentId),
    );
  }
  async restoreStudioDocumentVersion(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    versionId: string,
    input: WorkspaceDocumentStudioRestoreInput,
  ) {
    this.requireAccess(context);
    this.projects.get(projectId);
    return this.studioDocumentWire(
      await this.documentStudioService.restore({
        projectId,
        documentId,
        targetVersionId: versionId,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
      }),
    );
  }
  async importStudioDocumentDocx(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    input: WorkspaceDocumentStudioImportInput,
  ): Promise<WorkspaceDocumentStudioImportResult> {
    this.requireAccess(context);
    this.projects.get(projectId);
    const current = await this.documentStudioService.getDocument(
      projectId,
      documentId,
    );
    if (current.document.currentVersionId !== input.expectedVersionId) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Studio document changed before DOCX import.",
      );
    }
    const imported = await importDocumentStudioDocxToMarkdown({
      bytes: input.buffer,
    });
    const saved = await this.documentStudioService.save({
      projectId,
      documentId,
      expectedVersionId: input.expectedVersionId,
      content: imported.markdown,
      source: "user_upload",
      citationAnchorIds: current.version.citationAnchorIds,
      summary: null,
    });
    return {
      document: this.studioDocumentWire(saved),
      warningCodes: studioDocxWarningCodes(imported.warnings),
    };
  }
  async exportStudioDocumentDocx(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    versionId?: string,
  ): Promise<WorkspaceDocumentStudioExportResult> {
    this.requireAccess(context);
    this.projects.get(projectId);
    const selected = await this.documentStudioService.getDocument(
      projectId,
      documentId,
      versionId,
    );
    const exported = await exportDocumentStudioMarkdownToDocx({
      title: selected.document.title,
      markdown: selected.content,
    });
    return {
      filename: studioDocxFilename(selected.version.filename),
      contentType: exported.mimeType,
      bytes: exported.bytes,
      warningCodes: studioDocxWarningCodes(exported.warnings),
    };
  }
  async captureProjectDocumentSource(
    context: WorkspaceV1Context,
    projectId: string,
    documentId: string,
    versionId?: string,
  ) {
    this.requireAccess(context);
    return this.projectSourceCaptureWire(
      this.projectSourcesService.captureProjectDocumentSnapshot({
        projectId,
        documentId,
        versionId,
      }),
    );
  }
  async listProjectSources(
    context: WorkspaceV1Context,
    projectId: string,
    input: WorkspaceProjectSourceListInput,
  ) {
    this.requireAccess(context);
    return this.projectSourcePageWire(
      this.projectSourcesService.listSnapshots({
        projectId,
        sourceKind: input.sourceKind,
        limit: input.limit,
        cursor: input.cursor,
      }),
    );
  }
  async getProjectSource(
    context: WorkspaceV1Context,
    projectId: string,
    snapshotId: string,
  ) {
    this.requireAccess(context);
    return this.projectSourceDetailWire(
      this.projectSourcesService.getSnapshot(projectId, snapshotId),
    );
  }
  async createProjectSourceAnchor(
    context: WorkspaceV1Context,
    projectId: string,
    snapshotId: string,
    input: WorkspaceProjectSourceAnchorInput,
  ) {
    this.requireAccess(context);
    return {
      anchor: this.projectSourceAnchorWire(
        this.projectSourcesService.createProjectDocumentAnchor({
          projectId,
          snapshotId,
          chunkId: input.chunkId,
          exactQuote: input.exactQuote,
          startOffset: input.startOffset,
          endOffset: input.endOffset,
        }),
      ),
    };
  }
  async getDocument(context: WorkspaceV1Context, documentId: string) {
    this.requireAccess(context);
    return this.documentWire(this.documents.get(documentId).document);
  }
  async listDocumentVersions(context: WorkspaceV1Context, documentId: string) {
    this.requireAccess(context);
    const detail = this.documents.get(documentId);
    return {
      current_version_id: detail.document.currentVersionId,
      versions: this.documents
        .listVersions(documentId)
        .map((version) => this.documentVersionWire(version)),
    };
  }
  async readDocument(
    context: WorkspaceV1Context,
    documentId: string,
    versionId?: string,
  ) {
    this.requireAccess(context);
    const detail = this.documents.get(documentId);
    const id = versionId ?? detail.document.currentVersionId;
    if (!id)
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Document has no active version.",
      );
    const version = this.documentRepository.getVersion(documentId, id);
    const locator = {
      kind: "extracted_text" as const,
      documentId,
      versionId: id,
    };
    const record = this.blobRecords.getByLocator(locator);
    if (!version || !record || record.state !== "stored") {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Extracted text is not available for this document.",
      );
    }
    const buffer = this.blobs.readSync(locator, {
      sha256: record.contentSha256,
      size: record.sizeBytes,
    });
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    if (
      buffer.byteLength !== record.sizeBytes ||
      sha256 !== record.contentSha256
    ) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Extracted text integrity check failed.",
      );
    }
    return {
      document_id: documentId,
      version_id: id,
      content: buffer.toString("utf8"),
    };
  }
  async displayDocument(
    context: WorkspaceV1Context,
    documentId: string,
    versionId?: string,
  ): Promise<WorkspaceV1Download> {
    this.requireAccess(context);
    const id =
      versionId ?? this.documents.get(documentId).document.currentVersionId;
    if (!id)
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Document has no active version.",
      );
    const result = this.documents.readOriginal(documentId, id);
    return {
      filename: result.filename,
      contentType: result.mimeType,
      body: result.buffer,
      contentLength: result.contentLength,
      disposition: "inline",
    };
  }
  async getDocumentDownload(
    context: WorkspaceV1Context,
    documentId: string,
    versionId?: string,
  ): Promise<WorkspaceV1DocumentCapability> {
    return this.capability(context, documentId, versionId, "download");
  }
  async getDocumentVersionFile(
    context: WorkspaceV1Context,
    documentId: string,
    versionId: string,
  ): Promise<WorkspaceV1DocumentCapability> {
    return this.capability(context, documentId, versionId, "display");
  }
  async resolveDownload(
    context: WorkspaceV1Context,
    token: string,
  ): Promise<WorkspaceV1Download> {
    this.requireAccess(context);
    const result = this.documents.readCapability(token);
    return {
      filename: result.filename,
      contentType: result.mimeType,
      body: result.buffer,
      contentLength: result.contentLength,
      disposition: "attachment",
    };
  }

  private capability(
    context: WorkspaceV1Context,
    documentId: string,
    versionId: string | undefined,
    purpose: "display" | "download",
  ): WorkspaceV1DocumentCapability {
    this.requireAccess(context);
    const detail = this.documents.get(documentId);
    const id = versionId ?? detail.document.currentVersionId;
    if (!id)
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Document has no active version.",
      );
    const issued = this.documents.issueCapability(documentId, id, purpose);
    return {
      url: issued.url,
      download_url: issued.url,
      document_id: documentId,
      filename: this.documents.getVersion(documentId, id).filename,
      version_id: id,
      has_pdf_rendition: this.hasPreview(documentId, id),
    };
  }
  private assertDocumentProject(documentId: string, projectId: string) {
    const doc = this.documents.get(documentId).document;
    if (doc.projectId !== projectId)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Document not found.");
  }
  private assertGenericMutationAllowed(documentId: string) {
    const document = this.documents.get(documentId).document;
    if (
      document.projectId !== null &&
      this.documentStudioRepository.getProjectDocument(
        document.projectId,
        document.id,
      ) !== null
    ) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Studio documents must be changed through Document Studio.",
      );
    }
  }
  private requireAccess(context: WorkspaceV1Context) {
    requireLocal(context);
    if (!this.started || this.draining || this.closed) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Workspace runtime is not accepting requests.",
      );
    }
  }
  private assertDocumentScope(
    documentId: string,
    projectId: string | null | undefined,
  ) {
    if (projectId === undefined) return;
    const document = this.documents.get(documentId).document;
    if (document.projectId !== projectId) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Document not found.");
    }
  }
  private assertUploadPlacement(
    projectId: string | null,
    folderId: string | null,
  ) {
    if (projectId === null) {
      if (folderId !== null) {
        throw new WorkspaceApiError(
          422,
          "VALIDATION_ERROR",
          "A folder requires a project.",
        );
      }
      return;
    }
    this.projects.get(projectId);
    if (folderId !== null) {
      const folder = this.projects.getFolder(folderId);
      if (folder.projectId !== projectId) {
        throw new WorkspaceApiError(404, "NOT_FOUND", "Folder not found.");
      }
    }
  }
  private requestJobCancellation(id: string, reason: string) {
    this.jobs.requestCancellation(id, reason);
  }
  private assertDocumentCursorUnsupported(cursor: string | undefined) {
    if (cursor !== undefined) {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Document cursor pagination is not available in this runtime.",
      );
    }
  }
  private hasPreview(documentId: string, versionId: string) {
    return (
      this.blobRecords.getByLocator({
        kind: "preview",
        documentId,
        versionId,
      })?.state === "stored"
    );
  }
  private projectSummaryWire(project: ProjectSummary): WorkspaceProjectWire {
    const wire = serializeMikeProject({
      id: project.id,
      name: project.name,
      cmNumber: project.cmNumber,
      practice: project.practice,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      documentCount: project.documentCount ?? 0,
      chatCount: project.chatCount ?? 0,
      reviewCount: project.reviewCount ?? 0,
    });
    return {
      ...wire,
      description: project.description,
      workflow_count: project.workflowCount ?? 0,
      status: project.status,
      archived_at: project.archivedAt,
      default_model_profile_id: project.defaultModelProfileId,
    };
  }
  private projectWire(project: ProjectOverview): WorkspaceProjectWire {
    return {
      ...this.projectSummaryWire(project),
      documents: this.documents
        .list({ projectId: project.id, limit: 100 })
        .map((document) => this.documentWire(document)),
      folders: project.folders.map((folder) => this.folderWire(folder)),
    };
  }
  private folderWire(folder: ProjectFolder) {
    return {
      id: folder.id,
      project_id: folder.projectId,
      user_id: MIKE_LOCAL_USER_ID,
      name: folder.name,
      parent_folder_id: folder.parentFolderId,
      created_at: folder.createdAt,
      updated_at: folder.updatedAt,
    };
  }
  private documentWire(document: Document): WorkspaceMikeDocumentWire {
    const versions = this.documents.listVersions(document.id);
    const active = document.currentVersionId
      ? (versions.find((version) => version.id === document.currentVersionId) ??
        null)
      : null;
    const latest = versions.reduce(
      (current: PublicDocumentVersion | null, version) =>
        !current || version.versionNumber > current.versionNumber
          ? version
          : current,
      null as PublicDocumentVersion | null,
    );
    const hasPreview = Boolean(
      active && this.hasPreview(document.id, active.id),
    );
    const wire = serializeMikeDocument({
      id: document.id,
      projectId: document.projectId,
      folderId: document.folderId,
      filename: document.filename,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      pageCount: active?.pageCount ?? null,
      status: document.status,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      activeVersionNumber: active?.versionNumber ?? null,
      latestVersionNumber: latest?.versionNumber ?? null,
      hasPreview,
    });
    const editable =
      document.projectId !== null &&
      this.documentStudioRepository.getProjectDocument(
        document.projectId,
        document.id,
      ) !== null;
    const ocrSummary = this.documentOcrSummary.summarize(document);
    return {
      ...wire,
      ocr_summary: serializeWorkspaceDocumentOcrSummary(ocrSummary),
      studio_capability: {
        editable,
        format: editable ? "markdown" : null,
        docx_import: editable,
        docx_export: editable,
      },
    };
  }
  private studioVersionWire(version: DocumentStudioVersion) {
    if (
      version.source !== "user_upload" &&
      version.source !== "assistant_edit"
    ) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Persisted Studio version source is invalid.",
      );
    }
    return {
      id: version.id,
      version_number: version.versionNumber,
      source: version.source,
      filename: version.filename,
      mime_type: version.mimeType,
      size_bytes: version.sizeBytes,
      content_sha256: version.contentSha256,
      created_at: version.createdAt,
      citation_anchor_ids: [...version.citationAnchorIds],
    };
  }
  private studioDocumentWire(result: DocumentStudioDocument) {
    const projectId = result.document.projectId;
    const currentVersionId = result.document.currentVersionId;
    if (!projectId || !currentVersionId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Persisted Studio document scope is invalid.",
      );
    }
    return {
      document_id: result.document.id,
      project_id: projectId,
      title: result.document.title,
      filename: result.document.filename,
      format: "markdown" as const,
      current_version_id: currentVersionId,
      version: this.studioVersionWire(result.version),
      content: result.content,
      citation_anchors: result.citationAnchors.map((anchor) => ({
        id: anchor.id,
        snapshot_id: anchor.snapshotId,
        ordinal: anchor.ordinal,
        exact_quote: anchor.exactQuote,
        quote_sha256: anchor.quoteSha256,
        locator: anchor.locator,
      })),
      capabilities: {
        docx_import: true as const,
        docx_export: true as const,
      },
    };
  }
  private studioVersionListWire(result: DocumentStudioVersionList) {
    const currentVersionId = result.document.currentVersionId;
    if (!currentVersionId) {
      throw new WorkspaceApiError(
        500,
        "INTERNAL_ERROR",
        "Persisted Studio document has no current version.",
      );
    }
    return {
      current_version_id: currentVersionId,
      versions: result.versions.map((version) =>
        this.studioVersionWire(version),
      ),
    };
  }
  private projectSourceSnapshotWire(
    snapshot: ProjectSourceDetail["snapshot"],
  ) {
    return {
      id: snapshot.id,
      project_id: snapshot.projectId,
      kind: snapshot.sourceKind,
      source_record_id: snapshot.sourceRecordId,
      source_version_id: snapshot.sourceVersionId,
      title: snapshot.titleSnapshot,
      content_sha256: snapshot.contentSha256,
      locator: snapshot.locator,
      retrieved_at: snapshot.retrievedAt,
      license: {
        basis: snapshot.license.basis,
        retention: snapshot.license.retention,
        export: snapshot.license.export,
        model_use: snapshot.license.modelUse,
      },
      retention_policy: snapshot.retentionPolicy,
      retention_expires_at: snapshot.retentionExpiresAt,
      retrieval_metadata: snapshot.retrievalMetadata,
      created_at: snapshot.createdAt,
    };
  }
  private projectSourceAnchorWire(
    anchor: ProjectSourceDetail["anchors"][number],
  ) {
    return {
      id: anchor.id,
      project_id: anchor.projectId,
      snapshot_id: anchor.snapshotId,
      ordinal: anchor.ordinal,
      exact_quote: anchor.exactQuote,
      quote_sha256: anchor.quoteSha256,
      locator: anchor.locator,
      created_at: anchor.createdAt,
    };
  }
  private projectSourceCaptureWire(
    result: CaptureProjectDocumentSourceResult,
  ) {
    return {
      snapshot: this.projectSourceSnapshotWire(result.snapshot),
      reused: result.reused,
    };
  }
  private projectSourcePageWire(result: ProjectSourcePage) {
    return {
      sources: result.sources.map((snapshot) =>
        this.projectSourceSnapshotWire(snapshot),
      ),
      next_cursor: result.nextCursor,
    };
  }
  private projectSourceDetailWire(result: ProjectSourceDetail) {
    return {
      snapshot: this.projectSourceSnapshotWire(result.snapshot),
      anchors: result.anchors.map((anchor) =>
        this.projectSourceAnchorWire(anchor),
      ),
    };
  }
  private documentVersionWire(version: PublicDocumentVersion) {
    return serializeMikeDocumentVersion({
      id: version.id,
      versionNumber: version.versionNumber,
      source: version.source,
      filename: version.filename,
      mimeType: version.mimeType,
      sizeBytes: version.sizeBytes,
      pageCount: version.pageCount,
      createdAt: version.createdAt,
      deletedAt: null,
      deletedBy: null,
    });
  }
  private documentJobWire(job: DocumentParseJob): WorkspaceDocumentJobWire {
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      attempt: job.attempt,
      max_attempts: job.maxAttempts,
      retryable: job.retryable,
      created_at: job.createdAt,
      scheduled_at: job.scheduledAt,
      started_at: job.startedAt,
      completed_at: job.completedAt,
    };
  }
  private documentMutationWire(
    result: DocumentUploadResult,
  ): WorkspaceDocumentMutationWire {
    return {
      document: this.documentWire(result.document),
      version: this.documentVersionWire(result.version),
      job: this.documentJobWire(result.job),
    };
  }
}

export function createWorkspaceRuntime(
  dependencies: WorkspaceRuntimeDependencies = {},
) {
  const allowLocalDevelopmentModelBaseUrl =
    dependencies.allowLocalDevelopmentModelBaseUrl ??
    process.env.ALETHEIA_MODEL_PROVIDER_ALLOW_LOOPBACK_HTTP === "true";
  const modelProviderOptions = { ...(dependencies.modelProviderOptions ?? {}) };
  const modelCallLogDirectory = process.env.ALETHEIA_MODEL_CALL_LOG_DIR;
  if (!modelProviderOptions.modelCallDiagnostics && modelCallLogDirectory) {
    if (!path.isAbsolute(modelCallLogDirectory)) {
      throw new Error("The model call log directory must be absolute.");
    }
    modelProviderOptions.modelCallDiagnostics =
      new RotatingModelCallDiagnostics(modelCallLogDirectory);
  }
  return new WorkspaceRuntime({
    ...dependencies,
    allowLocalDevelopmentModelBaseUrl,
    modelProviderOptions,
  });
}
