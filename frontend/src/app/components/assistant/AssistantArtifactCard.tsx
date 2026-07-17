"use client";

import { Check, Download, FilePenLine, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useWorkspaceRoutes } from "@/app/components/projects/WorkspaceRouteAdapter";
import { useI18n } from "@/app/i18n";
import { isSaveDialogCancellation, saveBlob } from "@/app/lib/downloadBlob";
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

type ExportState = "idle" | "exporting" | "success" | "failed";

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
  const [exportState, setExportState] = useState<ExportState>("idle");
  const exporting = exportState === "exporting";
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

  useEffect(() => {
    if (exportState !== "success") return;
    const timeout = window.setTimeout(() => setExportState("idle"), 3_000);
    return () => window.clearTimeout(timeout);
  }, [exportState]);

  function openArtifact() {
    if (!projectId) {
      router.push(artifact.route);
      return;
    }
    router.push(canonicalRoute);
  }

  async function exportArtifact() {
    if (!projectId || exporting) return;
    setExportState("exporting");
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
      setExportState("success");
    } catch (error) {
      // The current browser download path cannot observe the OS save picker.
      // Keep this branch for a compatible desktop bridge, whose cancelled
      // picker must not be presented as a failed export.
      setExportState(isSaveDialogCancellation(error) ? "idle" : "failed");
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
      <div className="min-w-0 flex-1">
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
      <div className="flex w-full min-w-0 flex-wrap items-center gap-1.5 sm:w-auto sm:justify-end">
        <button
          type="button"
          disabled={!projectId || exporting}
          onClick={() => void exportArtifact()}
          title={
            review
              ? t("assistant.artifacts.reviewXlsxHint")
              : t("assistant.artifacts.draftDocxHint")
          }
          className={`flex min-w-0 items-center gap-1 rounded-md bg-white px-2.5 py-1.5 text-xs font-medium shadow-sm ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
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
          className={`flex min-w-0 items-center gap-1 rounded-md bg-white px-2.5 py-1.5 text-xs font-medium shadow-sm ring-1 transition-colors ${
            review
              ? "text-emerald-700 ring-emerald-100 hover:bg-emerald-50"
              : "text-blue-700 ring-blue-100 hover:bg-blue-50"
          }`}
        >
          <Icon className="h-3.5 w-3.5" />
          {action}
        </button>
      </div>
      {exportState === "success" && (
        <p role="status" aria-live="polite" className="w-full text-xs text-emerald-700">
          {t("assistant.artifacts.exported")}
        </p>
      )}
      {exportState === "failed" && (
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
