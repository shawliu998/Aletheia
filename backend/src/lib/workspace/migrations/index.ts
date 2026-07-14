import { INITIAL_WORKSPACE_MIGRATION } from "./v1InitialWorkspace";
import { WORKSPACE_INTEGRITY_MIGRATION } from "./v2WorkspaceIntegrity";
import { WORKSPACE_RUNTIME_MIGRATION } from "./v3WorkspaceRuntime";
import { PROJECT_OWNERSHIP_MIGRATION } from "./v4ProjectOwnership";

export {
  detectWorkspaceDatabaseCapabilities,
  runWorkspaceMigrations,
  workspaceMigrationChecksum,
  WorkspaceMigrationError,
} from "./runner";
export type {
  AppliedWorkspaceMigration,
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
  WorkspaceMigrationRun,
  WorkspaceStatement,
} from "./types";
export { INITIAL_WORKSPACE_MIGRATION } from "./v1InitialWorkspace";
export { WORKSPACE_INTEGRITY_MIGRATION } from "./v2WorkspaceIntegrity";
export { WORKSPACE_RUNTIME_MIGRATION } from "./v3WorkspaceRuntime";
export { PROJECT_OWNERSHIP_MIGRATION } from "./v4ProjectOwnership";

export const WORKSPACE_MIGRATIONS = [
  INITIAL_WORKSPACE_MIGRATION,
  WORKSPACE_INTEGRITY_MIGRATION,
  WORKSPACE_RUNTIME_MIGRATION,
  PROJECT_OWNERSHIP_MIGRATION,
] as const;
