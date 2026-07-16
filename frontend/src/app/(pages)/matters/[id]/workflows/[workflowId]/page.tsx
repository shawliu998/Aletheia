"use client";

import { use } from "react";
import { VeraWorkflowEditor } from "@/app/components/workflows/VeraWorkflowEditor";
import {
  MatterCapabilityBoundary,
  useMatterWorkspace,
} from "@/features/matter-overview/MatterWorkspaceShell";

export default function MatterWorkflowPage({
  params,
}: {
  params: Promise<{ id: string; workflowId: string }>;
}) {
  const { id, workflowId } = use(params);
  const { matter } = useMatterWorkspace();
  const executionConstraint =
    matter.capabilities.workflows === "non_inference_only"
      ? "non_inference_only"
      : "available";
  return (
    <MatterCapabilityBoundary capability="workflows">
      <VeraWorkflowEditor
        workflowId={workflowId}
        initialProjectId={id}
        executionConstraint={executionConstraint}
      />
    </MatterCapabilityBoundary>
  );
}
