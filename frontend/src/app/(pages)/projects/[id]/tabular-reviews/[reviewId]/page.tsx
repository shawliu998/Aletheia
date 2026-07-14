"use client";

// Disabled local adaptation of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/projects/[id]/tabular-reviews/[reviewId]/page.tsx
import { use } from "react";
import { ProjectSectionToolbar } from "@/app/components/projects/ProjectWorkspace";
import { UnavailableProjectSection } from "@/app/components/projects/ProjectPageParts";
import { useI18n } from "@/app/i18n";

export default function ProjectTabularReviewPage({
    params,
}: {
    params: Promise<{ id: string; reviewId: string }>;
}) {
    use(params);
    const { t } = useI18n();
    return (
        <UnavailableProjectSection
            title={t("tabular.title")}
            subtitle={t("tabular.subtitle")}
            toolbar={<ProjectSectionToolbar />}
        />
    );
}
