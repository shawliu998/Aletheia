import type {
  AgentOpsMatterWorkspace,
  DraftMemo,
  EvalCase,
  GateResult,
  IssueNode,
  ReviewComment,
} from "../../aletheia/agentops/types";
import type { TypedHandoffPersistedGateEvidence } from "../../aletheia/agentops/handoff";

export type EvalMetrics = {
  citation_coverage: number;
  unsupported_claim_count: number;
  unresolved_review_comments: number;
  human_override_count: number;
  gate_failure_count: number;
  issue_coverage?: {
    covered_issue_count: number;
    total_issue_count: number;
    score: number;
  };
};

export type EvalMetricInput = {
  draft_memos: DraftMemo[];
  review_comments: ReviewComment[];
  gate_results: GateResult[];
  eval_cases: EvalCase[];
  issues?: IssueNode[];
};

export type EvalSnapshotProvenance = {
  matterId: string;
  snapshotId: string;
  sourceRunIds: string[];
  sourceReviewCommentIds: string[];
  sourceReviewTagIds: string[];
  sourceGateResultIds: string[];
  sourceCheckpointIds: string[];
  sourceEvidenceItemIds: string[];
  sourceClaimIds: string[];
  sourceAuditEventIds: string[];
  feedbackExportIds: string[];
  candidateSkillIds: string[];
  approvedPlaybookIds: string[];
  metrics: EvalMetrics;
  warnings: string[];
};

export type EvalSnapshotProvenanceOptions = {
  snapshotId?: string;
  feedbackExportIds?: string[];
  candidateSkillIds?: string[];
  approvedPlaybookIds?: string[];
  persistedGateEvidence?: TypedHandoffPersistedGateEvidence;
};

function ratio(numerator: number, denominator: number) {
  if (denominator === 0) return 0;
  return Number((numerator / denominator).toFixed(2));
}

function unique(values: Array<string | undefined | null>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function checkpointIdFromGate(gate: GateResult) {
  return gate.id.startsWith("gate-checkpoint-")
    ? gate.id.replace(/^gate-checkpoint-/, "")
    : undefined;
}

function computeCitationCoverage(draftMemos: DraftMemo[]) {
  let citedSections = 0;
  let totalSections = 0;

  for (const memo of draftMemos) {
    for (const section of memo.sections) {
      totalSections += 1;
      if (section.evidence_reference_ids.length > 0) {
        citedSections += 1;
      }
    }
  }

  return ratio(citedSections, totalSections);
}

function computeUnsupportedClaims(draftMemos: DraftMemo[]) {
  return draftMemos.reduce(
    (total, memo) => total + memo.unsupported_claim_count,
    0,
  );
}

function computeIssueCoverage(issues: IssueNode[] | undefined) {
  if (!issues || issues.length === 0) return undefined;

  const coveredIssues = issues.filter(
    (issue) =>
      issue.related_evidence_ids.length > 0 || issue.open_questions.length > 0,
  );

  return {
    covered_issue_count: coveredIssues.length,
    total_issue_count: issues.length,
    score: ratio(coveredIssues.length, issues.length),
  };
}

export function computeProfessionalEvalMetrics(
  input: EvalMetricInput,
): EvalMetrics {
  const failedGates = input.gate_results.filter(
    (gate) => gate.status === "failed",
  );
  const expertOverrides = input.eval_cases.filter(
    (evalCase) => evalCase.failure_type === "expert_override",
  );

  return {
    citation_coverage: computeCitationCoverage(input.draft_memos),
    unsupported_claim_count: computeUnsupportedClaims(input.draft_memos),
    unresolved_review_comments: input.review_comments.filter(
      (comment) => comment.status === "open",
    ).length,
    human_override_count: expertOverrides.length,
    gate_failure_count: failedGates.length,
    issue_coverage: computeIssueCoverage(input.issues),
  };
}

export function computeWorkspaceEvalMetrics(
  workspace: AgentOpsMatterWorkspace,
): EvalMetrics {
  return computeProfessionalEvalMetrics({
    draft_memos: workspace.draft_memos,
    review_comments: workspace.review_comments,
    gate_results: workspace.gate_results,
    eval_cases: workspace.eval_cases,
    issues: workspace.issues,
  });
}

export function buildEvalSnapshotProvenance(
  workspace: AgentOpsMatterWorkspace,
  options: EvalSnapshotProvenanceOptions = {},
): EvalSnapshotProvenance {
  const persistedGateEvidence = options.persistedGateEvidence;
  const sourceAuditEventIds = unique([
    ...workspace.audit_events.map((event) => event.id),
    ...(persistedGateEvidence?.gate_snapshot_audit_event_ids ?? []),
    ...(persistedGateEvidence?.gate_authorization_audit_event_ids ?? []),
    ...(persistedGateEvidence?.blocked_final_export_audit_event_ids ?? []),
    ...(persistedGateEvidence?.related_gate_audit_event_ids ?? []),
  ]);
  const candidateSkillIds = unique([
    ...workspace.skills
      .filter((skill) => skill.approval_status === "candidate")
      .map((skill) => skill.id),
    ...(options.candidateSkillIds ?? []),
  ]);
  const persistedWarnings =
    persistedGateEvidence?.validation
      ?.filter((item) => item.status !== "passed")
      .map((item) => `${item.name}: ${item.detail}`) ?? [];
  const candidateWarnings = candidateSkillIds.map(
    (skillId) =>
      `${skillId} is a candidate skill and must remain inactive until a human-approved playbook exists.`,
  );

  return {
    matterId: workspace.matter.id,
    snapshotId:
      options.snapshotId ?? `eval-snapshot-${workspace.matter.id}`,
    sourceRunIds: unique([
      ...workspace.runs.map((run) => run.id),
      ...workspace.eval_cases.map((evalCase) => evalCase.source_run_id),
    ]),
    sourceReviewCommentIds: unique(
      workspace.review_comments.map((comment) => comment.id),
    ),
    sourceReviewTagIds: unique(
      workspace.review_comments.map((comment) => comment.tag),
    ),
    sourceGateResultIds: unique([
      ...workspace.gate_results.map((gate) => gate.id),
      ...(persistedGateEvidence?.gate_result_ids ?? []),
    ]),
    sourceCheckpointIds: unique([
      ...workspace.gate_results.map(checkpointIdFromGate),
      ...(persistedGateEvidence?.approval_checkpoint_ids ?? []),
    ]),
    sourceEvidenceItemIds: unique([
      ...workspace.evidence.map((item) => item.id),
      ...workspace.review_comments.map((comment) => comment.evidence_item_id),
      ...workspace.issues.flatMap((issue) => issue.related_evidence_ids),
    ]),
    sourceClaimIds: unique(
      workspace.evidence.flatMap((item) => item.supports_claim_ids),
    ),
    sourceAuditEventIds,
    feedbackExportIds: unique(options.feedbackExportIds ?? []),
    candidateSkillIds,
    approvedPlaybookIds: unique(options.approvedPlaybookIds ?? []),
    metrics: computeWorkspaceEvalMetrics(workspace),
    warnings: unique([...persistedWarnings, ...candidateWarnings]),
  };
}
