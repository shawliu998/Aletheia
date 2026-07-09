import type { GateResult } from "./types";

export type FinalMemoGateSnapshotContent = {
  matterTitle: string;
  workProductKind: "final_memo";
  sourceDraftMemoId: string;
  gateSummary: Record<string, unknown>;
  gateResults: GateResult[];
  gateProvenance: unknown[];
};

export function buildFinalMemoGateSnapshotContent(args: {
  matterTitle: string;
  sourceDraftMemoId: string;
  gateSummary: Record<string, unknown>;
  gateResults: GateResult[];
  gateProvenance: unknown[];
}): FinalMemoGateSnapshotContent {
  return {
    matterTitle: args.matterTitle,
    workProductKind: "final_memo",
    sourceDraftMemoId: args.sourceDraftMemoId,
    gateSummary: args.gateSummary,
    gateResults: args.gateResults,
    gateProvenance: args.gateProvenance,
  };
}

export function buildFinalMemoApprovalRequestedPayload(args: {
  gateSnapshotContent: FinalMemoGateSnapshotContent;
  gateSnapshotAuditEventId: string;
}) {
  return {
    ...args.gateSnapshotContent,
    gateSnapshotAuditEventId: args.gateSnapshotAuditEventId,
  };
}
