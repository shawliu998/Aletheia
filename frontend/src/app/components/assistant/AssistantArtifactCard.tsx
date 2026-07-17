"use client";

import { Check, Download, FilePenLine, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useWorkspaceRoutes } from "@/app/components/projects/WorkspaceRouteAdapter";
import { useI18n } from "@/app/i18n";
import { saveBlob } from "@/app/lib/downloadBlob";
import { exportVeraStudioDocx } from "@/app/lib/veraDocumentStudioApi";
import { exportVeraTabularReview } from "@/app/lib/veraTabularApi";

type Artifact =
  | Readonly<{
      kind: "review";
      id: string;
      title: string;
      route: string;
      documentCount: number;
    }>
  | Readonly<{
      kind: "draft";
      id: string;
      versionId: string;
      title: string;
      route: string;
    }>;

/** A consistent, route-backed card for every durable Assistant deliverable. */
export function AssistantArtifactCard({
  artifact,
  projectId,
}: {
  artifact: Artifact;
  projectId?: string;
}) {
  const router = useRouter();
  const routes = useWorkspaceRoutes();
  const { t } = useI18n();
  const [exporting, setExporting] = useState(false);
  const [exportFailure, setExportFailure] = useState(false);
  const review = artifact.kind === "review";
  const Icon = review ? Check : FilePenLine;
  const action = review
    ? t("assistant.artifacts.openReview")
    : t("assistant.openDraft");
  const canonicalRoute = projectId
    ? review
      ? routes.tabularReviewHref(projectId, artifact.id)
      : routes.documentStudioHref(projectId, artifact.id)
    : artifact.route;

  function openArtifact() {
    if (!projectId) {
      router.push(artifact.route);
      return;
    }
    router.push(canonicalRoute);
  }

  async function exportArtifact() {
    if (!projectId || exporting) return;
    setExporting(true);
    setExportFailure(false);
    try {
      if (artifact.kind === "review") {
        const result = await exportVeraTabularReview(artifact.id, "xlsx");
        saveBlob(result.blob, result.filename ?? `${artifact.title}.xlsx`);
      } else {
        const result = await exportVeraStudioDocx(
          projectId,
          artifact.id,
          artifact.versionId,
        );
        saveBlob(result.blob, result.filename);
      }
    } catch {
      setExportFailure(true);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div
      className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 ${
        review
          ? "border-emerald-100 bg-emerald-50/70"
          : "border-blue-100 bg-blue-50/70"
      }`}
      data-testid={`assistant-${artifact.kind}-result-${artifact.id}`}
      data-artifact-kind={artifact.kind}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-gray-900">
          {artifact.title}
        </p>
        <p className="mt-0.5 text-xs text-gray-500">
          {review
            ? t("assistant.artifacts.reviewDescription", {
                count: artifact.documentCount,
              })
            : t("assistant.artifacts.draftDescription")}
        </p>
      </div>
      <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
        <button
          type="button"
          disabled={!projectId || exporting}
          onClick={() => void exportArtifact()}
          title={
            review
              ? t("assistant.artifacts.reviewXlsxHint")
              : t("assistant.artifacts.draftDocxHint")
          }
          className={`flex items-center gap-1 rounded-md bg-white px-2.5 py-1.5 text-xs font-medium shadow-sm ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            review
              ? "text-emerald-700 ring-emerald-100 hover:bg-emerald-50"
              : "text-blue-700 ring-blue-100 hover:bg-blue-50"
          }`}
        >
          {exporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          {exporting
            ? t("assistant.artifacts.exporting")
            : review
              ? t("assistant.artifacts.exportXlsx")
              : t("assistant.artifacts.exportDocx")}
        </button>
        <button
          type="button"
          onClick={openArtifact}
          className={`flex items-center gap-1 rounded-md bg-white px-2.5 py-1.5 text-xs font-medium shadow-sm ring-1 transition-colors ${
            review
              ? "text-emerald-700 ring-emerald-100 hover:bg-emerald-50"
              : "text-blue-700 ring-blue-100 hover:bg-blue-50"
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
          {action}
        </button>
      </div>
      {exportFailure && (
        <p role="alert" className="w-full text-xs text-red-600">
          {t("assistant.artifacts.exportFailed")}
        </p>
      )}
      <p className="sr-only">
        {review
          ? t("assistant.artifacts.reviewXlsxHint")
          : t("assistant.artifacts.draftDocxHint")}
      </p>
    </div>
  );
}
