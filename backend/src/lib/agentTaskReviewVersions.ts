import type { AgentArtifactLinkInput } from "./agentTasks";
import {
  findDeliverableArtifact,
  requiredTaskDeliverables,
  taskDeliverablePurpose,
} from "./agentTaskDeliverables";
import type {
  AgentReviewStatus,
  ApprovedArtifactSnapshot,
} from "./agentTaskReviews";
import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

type TaskSnapshot = {
  task: {
    status: string;
    deliverables: Array<{
      key?: string;
      artifact_id?: string;
      title?: string;
      purpose?: string;
      required?: boolean;
      artifact_type?: string;
    }>;
  };
  artifacts: AgentArtifactLinkInput[];
  review?: {
    decisions?: Array<{
      id: string;
      status: AgentReviewStatus;
      artifact_snapshot: unknown[];
      created_at: string;
    }>;
  };
};

export type CurrentArtifactVersion = {
  artifact_type: "draft" | "tabular_review";
  artifact_id: string;
  purpose: string;
  current_version_id: string | null;
  current_version_number: number | null;
  current_filename: string | null;
  current_file_type: string | null;
  current_version_available: boolean;
  approved_version_id: string | null;
  approved_version_number: number | null;
  edited_after_approval: boolean;
  review_current_required: boolean;
};

export type AgentReviewVersionState = {
  latest_approved_decision_id: string | null;
  latest_approved_at: string | null;
  has_previous_approval: boolean;
  has_unapproved_changes: boolean;
  current_artifacts: CurrentArtifactVersion[];
};

export function controlledAgentReviewArtifactLinks(snapshot: TaskSnapshot) {
  const generatedLinks = snapshot.artifacts.filter(
    (
      artifact,
    ): artifact is AgentArtifactLinkInput & {
      artifact_type: "draft" | "tabular_review";
    } =>
      artifact.artifact_type === "draft" ||
      artifact.artifact_type === "tabular_review",
  );
  return requiredTaskDeliverables(snapshot.task).flatMap((deliverable) => {
    if (
      !["draft", "tabular_review"].includes(deliverable.artifact_type ?? "")
    ) {
      return [];
    }
    const found = findDeliverableArtifact(deliverable, generatedLinks);
    return found
      ? [
          {
            ...found,
            artifact_type: found.artifact_type as "draft" | "tabular_review",
            purpose: taskDeliverablePurpose(deliverable),
          },
        ]
      : [];
  });
}

export function buildAgentReviewVersionState(
  links: ReturnType<typeof controlledAgentReviewArtifactLinks>,
  documents: Array<{ id: string; current_version_id: string | null }>,
  versions: Array<{
    id: string;
    document_id: string;
    version_number: number | null;
    filename: string | null;
    file_type: string | null;
    deleted_at: string | null;
  }>,
  latestApproved: {
    id: string;
    created_at: string;
    artifact_snapshot: unknown[];
  } | null,
): AgentReviewVersionState {
  const documentById = new Map(
    documents.map((document) => [document.id, document]),
  );
  const versionById = new Map(versions.map((version) => [version.id, version]));
  const approvedArtifacts = Array.isArray(latestApproved?.artifact_snapshot)
    ? (latestApproved.artifact_snapshot as ApprovedArtifactSnapshot[])
    : [];
  const currentArtifacts = links.map((link) => {
    const currentVersionId =
      documentById.get(link.artifact_id)?.current_version_id ?? null;
    const currentVersion = currentVersionId
      ? (versionById.get(currentVersionId) ?? null)
      : null;
    const approved =
      approvedArtifacts.find(
        (artifact) => artifact.artifact_id === link.artifact_id,
      ) ?? null;
    const currentVersionAvailable = Boolean(
      currentVersion && !currentVersion.deleted_at,
    );
    const differs = Boolean(
      approved && currentVersionId !== approved.version_id,
    );
    const unavailableAfterApproval = Boolean(
      approved && !currentVersionAvailable,
    );
    return {
      artifact_type: link.artifact_type,
      artifact_id: link.artifact_id,
      purpose: link.purpose,
      current_version_id: currentVersionId,
      current_version_number: currentVersion?.version_number ?? null,
      current_filename: currentVersion?.filename?.trim() || null,
      current_file_type: currentVersion?.file_type ?? null,
      current_version_available: currentVersionAvailable,
      approved_version_id: approved?.version_id ?? null,
      approved_version_number: approved?.version_number ?? null,
      edited_after_approval: Boolean(currentVersionId && differs),
      review_current_required: differs || unavailableAfterApproval,
    } satisfies CurrentArtifactVersion;
  });
  return {
    latest_approved_decision_id: latestApproved?.id ?? null,
    latest_approved_at: latestApproved?.created_at ?? null,
    has_previous_approval: Boolean(latestApproved),
    has_unapproved_changes: currentArtifacts.some(
      (artifact) => artifact.review_current_required,
    ),
    current_artifacts: currentArtifacts,
  };
}

export function deriveAgentReviewStatus(
  taskStatus: string,
  latestStatus: AgentReviewStatus | null,
  versionState: AgentReviewVersionState,
): AgentReviewStatus | null {
  const status =
    latestStatus ?? (taskStatus === "completed" ? "review_required" : null);
  return status === "approved" && versionState.has_unapproved_changes
    ? "review_required"
    : status;
}

export async function getAgentReviewVersionState(
  db: Db,
  snapshot: TaskSnapshot,
): Promise<AgentReviewVersionState> {
  const links = controlledAgentReviewArtifactLinks(snapshot);
  const latestApproved =
    [...(snapshot.review?.decisions ?? [])]
      .reverse()
      .find((decision) => decision.status === "approved") ?? null;
  if (!links.length) {
    return buildAgentReviewVersionState([], [], [], latestApproved);
  }
  const documentIds = Array.from(
    new Set(links.map((artifact) => artifact.artifact_id)),
  );
  const { data: documents, error: documentError } = await db
    .from("documents")
    .select("id,current_version_id")
    .in("id", documentIds);
  if (documentError) throw new Error(documentError.message);
  const versionIds = (documents ?? [])
    .map((document) => document.current_version_id as string | null)
    .filter((id): id is string => Boolean(id));
  const { data: versions, error: versionError } = versionIds.length
    ? await db
        .from("document_versions")
        .select("id,document_id,version_number,filename,file_type,deleted_at")
        .in("id", versionIds)
    : { data: [], error: null };
  if (versionError) throw new Error(versionError.message);
  return buildAgentReviewVersionState(
    links,
    (documents ?? []) as Array<{
      id: string;
      current_version_id: string | null;
    }>,
    (versions ?? []) as Array<{
      id: string;
      document_id: string;
      version_number: number | null;
      filename: string | null;
      file_type: string | null;
      deleted_at: string | null;
    }>,
    latestApproved,
  );
}
