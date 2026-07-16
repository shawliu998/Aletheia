"use client";

import { use } from "react";
import { TabularReviewView } from "@/app/components/tabular/TabularReviewView";
import { MatterCapabilityBoundary } from "@/features/matter-overview/MatterWorkspaceShell";

export default function MatterTabularReviewPage({
  params,
}: {
  params: Promise<{ id: string; reviewId: string }>;
}) {
  const { id, reviewId } = use(params);
  return (
    <MatterCapabilityBoundary capability="tabular">
      <TabularReviewView reviewId={reviewId} projectId={id} />
    </MatterCapabilityBoundary>
  );
}
