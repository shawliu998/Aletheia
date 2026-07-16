"use client";

import ProjectAssistantPage from "@/app/(pages)/projects/[id]/assistant/page";
import { MatterCapabilityBoundary } from "@/features/matter-overview/MatterWorkspaceShell";

export default function MatterAssistantPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <MatterCapabilityBoundary capability="assistant">
      <ProjectAssistantPage params={params} />
    </MatterCapabilityBoundary>
  );
}
