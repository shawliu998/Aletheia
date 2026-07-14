"use client";

// Adapted direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/projects/[id]/assistant/page.tsx
import { use } from "react";
import {
    ProjectSectionToolbar,
} from "@/app/components/projects/ProjectWorkspace";
import { UnavailableProjectSection } from "@/app/components/projects/ProjectPageParts";
import { useI18n } from "@/app/i18n";

export default function ProjectAssistantPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    use(params);
    const { t } = useI18n();
    return (
        <UnavailableProjectSection
            title={t("assistant.title")}
            subtitle={t("assistant.subtitle")}
            toolbar={<ProjectSectionToolbar />}
        />
    );
}
