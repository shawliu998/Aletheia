"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/projects/[id]/page.tsx
import { use } from "react";
import { ProjectDocumentsView } from "@/app/components/projects/ProjectDocumentsView";

interface Props {
    params: Promise<{ id: string }>;
}

export default function ProjectDetailPage({ params }: Props) {
    const { id } = use(params);
    return <ProjectDocumentsView projectId={id} />;
}
