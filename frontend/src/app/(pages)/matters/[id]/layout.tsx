import type { ReactNode } from "react";
import { MatterWorkspaceShell } from "@/features/matter-overview/MatterWorkspaceShell";

export default function MatterLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: ReactNode;
}) {
  return <MatterWorkspaceShell params={params}>{children}</MatterWorkspaceShell>;
}
