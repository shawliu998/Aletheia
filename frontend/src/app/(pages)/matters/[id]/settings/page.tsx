import { MatterSettings } from "@/features/matter-overview/MatterSettings";
import { MatterCapabilityBoundary } from "@/features/matter-overview/MatterWorkspaceShell";

export default function MatterSettingsPage() {
  return (
    <MatterCapabilityBoundary capability="matter_profile">
      <MatterSettings />
    </MatterCapabilityBoundary>
  );
}
