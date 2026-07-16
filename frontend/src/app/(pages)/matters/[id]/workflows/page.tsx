"use client";

import ProjectWorkflowsPage from "@/app/(pages)/projects/[id]/workflows/page";
import { MatterCapabilityBoundary } from "@/features/matter-overview/MatterWorkspaceShell";

export default function MatterWorkflowsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <MatterCapabilityBoundary capability="workflows">
      <ProjectWorkflowsPage params={params} />
    </MatterCapabilityBoundary>
  );
}
