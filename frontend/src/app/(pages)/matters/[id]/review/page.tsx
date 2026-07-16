"use client";

import ProjectTabularReviewsPage from "@/app/(pages)/projects/[id]/tabular-reviews/page";
import { MatterCapabilityBoundary } from "@/features/matter-overview/MatterWorkspaceShell";

export default function MatterTabularReviewsPage() {
  return (
    <MatterCapabilityBoundary capability="tabular">
      <ProjectTabularReviewsPage />
    </MatterCapabilityBoundary>
  );
}
