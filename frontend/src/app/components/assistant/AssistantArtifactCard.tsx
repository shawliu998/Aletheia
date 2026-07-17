"use client";

import { Check, FilePenLine } from "lucide-react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/app/i18n";

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
      title: string;
      route: string;
    }>;

/** A consistent, route-backed card for every durable Assistant deliverable. */
export function AssistantArtifactCard({ artifact }: { artifact: Artifact }) {
  const router = useRouter();
  const { t } = useI18n();
  const review = artifact.kind === "review";
  const Icon = review ? Check : FilePenLine;
  const action = review
    ? t("assistant.artifacts.openReview")
    : t("assistant.openDraft");

  return (
    <div
      className={`mb-4 flex items-center justify-between gap-3 rounded-xl border p-3 ${
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
      <button
        type="button"
        onClick={() => router.push(artifact.route)}
        className={`flex shrink-0 items-center gap-1 rounded-md bg-white px-2.5 py-1.5 text-xs font-medium shadow-sm ring-1 transition-colors ${
          review
            ? "text-emerald-700 ring-emerald-100 hover:bg-emerald-50"
            : "text-blue-700 ring-blue-100 hover:bg-blue-50"
        }`}
      >
        <Icon className="h-3.5 w-3.5" />
        {action}
      </button>
      <p className="sr-only">
        {review
          ? t("assistant.artifacts.reviewXlsxHint")
          : t("assistant.artifacts.draftDocxHint")}
      </p>
    </div>
  );
}
