"use client";

// Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/(pages)/projects/[id]/layout.tsx
import type { ReactNode } from "react";
import { ProjectWorkspaceLayout } from "@/app/components/projects/ProjectWorkspace";

export default function ProjectLayout({
    params,
    children,
}: {
    params: Promise<{ id: string }>;
    children: ReactNode;
}) {
    return (
        <ProjectWorkspaceLayout params={params}>
            {children}
        </ProjectWorkspaceLayout>
    );
}
