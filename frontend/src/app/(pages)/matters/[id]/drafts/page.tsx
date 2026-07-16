"use client";

import Link from "next/link";
import { use } from "react";
import { FileText } from "lucide-react";
import { MatterCapabilityBoundary } from "@/features/matter-overview/MatterWorkspaceShell";
import { useI18n } from "@/app/i18n";

export default function MatterDraftsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { t } = useI18n();
  return (
    <MatterCapabilityBoundary capability="drafts">
      <main className="flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="max-w-md rounded-2xl border border-white/70 bg-white/65 p-8 text-center shadow-lg backdrop-blur-xl">
          <FileText className="mx-auto h-7 w-7 text-gray-400" />
          <h1 className="mt-3 font-serif text-xl text-gray-900">
            {t("matters.navigation.drafts")}
          </h1>
          <p className="mt-2 text-sm text-gray-500">
            {t("matters.capabilities.draftsDocumentScoped")}
          </p>
          <Link
            href={`/matters/${id}/documents`}
            className="mt-5 inline-flex rounded-full bg-gray-900 px-4 py-1.5 text-xs font-medium text-white"
          >
            {t("matters.navigation.documents")}
          </Link>
        </div>
      </main>
    </MatterCapabilityBoundary>
  );
}
