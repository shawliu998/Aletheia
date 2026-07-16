"use client";

import ProjectAssistantChatPage from "@/app/(pages)/projects/[id]/assistant/chat/[chatId]/page";
import { MatterCapabilityBoundary } from "@/features/matter-overview/MatterWorkspaceShell";

export default function MatterAssistantChatPage({
  params,
}: {
  params: Promise<{ id: string; chatId: string }>;
}) {
  return (
    <MatterCapabilityBoundary capability="assistant">
      <ProjectAssistantChatPage params={params} />
    </MatterCapabilityBoundary>
  );
}
