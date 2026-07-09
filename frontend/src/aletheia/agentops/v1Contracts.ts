import { computeExportHash } from "./exportPackage";
import {
  calculateCitationCoverage,
  canExportFinal,
  findUnsupportedClaims,
} from "./gates";
import {
  parseBigAtReferences,
  resolveBigAtReference,
  type BigAtParsedReference,
  type BigAtReferenceResolution,
} from "./references";
import {
  computeArtifactId,
  createDefaultAgentRun,
  createDefaultMatter,
  validateArtifactShape,
  type ValidationResult,
} from "./schemas";
import type {
  AgentRun,
  ArtifactType,
  AuditActorType,
  AuditEvent,
  DraftMemo,
  EvalCase,
  EvalFailureType,
  EvidenceItem,
  GateResult,
  GateStatus,
  IssueNode,
  Matter,
  MatterDocument,
  ProfessionalSkill,
  ReviewComment,
  RiskItem,
  RiskLevel,
  ToolCall,
} from "./types";

export {
  calculateCitationCoverage,
  canExportFinal,
  createDefaultAgentRun,
  createDefaultMatter,
  parseBigAtReferences,
  resolveBigAtReference,
};

export const V1_CONTRACT_VERSION = "aletheia-v1-contracts-2026-07-09" as const;

export type {
  AgentRun,
  AuditEvent,
  DraftMemo,
  EvalCase,
  EvidenceItem,
  GateResult,
  IssueNode,
  Matter,
  ProfessionalSkill,
  ReviewComment,
  RiskItem,
  ToolCall,
};

export type V1DocumentStatus =
  | MatterDocument["status"]
  | "needs_ocr"
  | "parsing"
  | "parsed";

export type DocumentRecord = Omit<MatterDocument, "status"> & {
  status: V1DocumentStatus;
  mime_type?: string;
  byte_size?: number;
  page_count?: number;
  sheet_count?: number;
  section_count?: number;
  parser?: "deterministic" | "pdf" | "docx" | "xlsx" | "ocr" | "manual";
  parse_error?: string;
  metadata?: Record<string, unknown>;
};

export type DocumentChunk = {
  id: string;
  matter_id: string;
  document_id: string;
  text: string;
  page?: number;
  section?: string;
  start_offset?: number;
  end_offset?: number;
  token_count?: number;
  hash?: string;
  metadata?: Record<string, unknown>;
};

export type RetrievalMethod = "keyword" | "semantic" | "hybrid" | "manual";

export type RetrievalResult = {
  id: string;
  matter_id: string;
  document_id: string;
  chunk_id: string;
  score: number;
  quote_preview: string;
  method: RetrievalMethod;
  ranking_basis: string;
  page?: number;
  section?: string;
  evidence_item_id?: string;
};

export type Claim = {
  id: string;
  matter_id: string;
  text: string;
  artifact_id?: string;
  artifact_type?: ArtifactType;
  evidence_item_ids: string[];
  unsupported: boolean;
  confidence?: number;
};

export type ObligationItem = {
  id: string;
  matter_id: string;
  title: string;
  description: string;
  source_evidence_ids: string[];
  owner?: string;
  due_date?: string;
  status: "open" | "in_progress" | "satisfied" | "waived" | "blocked";
  risk_level: RiskLevel;
};

export type GateSummary = {
  total: number;
  passed: number;
  failed: number;
  warning: number;
  skipped: number;
  blocking_failures: GateResult[];
  export_ready: boolean;
};

export type V1WorkspaceFixture = {
  contract_version: typeof V1_CONTRACT_VERSION;
  matter: Matter;
  documents: DocumentRecord[];
  chunks: DocumentChunk[];
  retrieval_results: RetrievalResult[];
  evidence: EvidenceItem[];
  claims: Claim[];
  issues: IssueNode[];
  obligations: ObligationItem[];
  risks: RiskItem[];
  draft_memo: DraftMemo;
  gate_results: GateResult[];
};

export type V1EvalCaseFixture = {
  schema_version: "aletheia-v1-eval-case-fixture-v1";
  matter_id: string;
  source_run_id: string;
  eval_cases: EvalCase[];
  source_review_comment_ids: string[];
  source_gate_result_ids: string[];
  local_only_limitations: string[];
};

type GuardedV1Artifact =
  | "document_record"
  | "document_chunk"
  | "retrieval_result"
  | "claim"
  | "obligation_item";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasString(
  value: Record<string, unknown>,
  field: string,
  errors: string[],
) {
  if (typeof value[field] !== "string" || !value[field]) {
    errors.push(`${field} must be a non-empty string`);
  }
}

function hasArray(
  value: Record<string, unknown>,
  field: string,
  errors: string[],
) {
  if (!Array.isArray(value[field])) {
    errors.push(`${field} must be an array`);
  }
}

function hasNumber(
  value: Record<string, unknown>,
  field: string,
  errors: string[],
) {
  if (typeof value[field] !== "number" || !Number.isFinite(value[field])) {
    errors.push(`${field} must be a finite number`);
  }
}

export function validateV1ArtifactShape(
  artifactType: ArtifactType | GuardedV1Artifact,
  artifact: unknown,
): ValidationResult {
  if (
    artifactType !== "document_record" &&
    artifactType !== "document_chunk" &&
    artifactType !== "retrieval_result" &&
    artifactType !== "claim" &&
    artifactType !== "obligation_item"
  ) {
    return validateArtifactShape(artifactType, artifact);
  }

  if (!isRecord(artifact)) {
    return { ok: false, errors: [`${artifactType} must be an object`] };
  }

  const errors: string[] = [];
  hasString(artifact, "id", errors);
  hasString(artifact, "matter_id", errors);

  if (artifactType === "document_record") {
    hasString(artifact, "title", errors);
    hasString(artifact, "document_type", errors);
    hasString(artifact, "status", errors);
    hasString(artifact, "uploaded_at", errors);
  }

  if (artifactType === "document_chunk") {
    hasString(artifact, "document_id", errors);
    hasString(artifact, "text", errors);
  }

  if (artifactType === "retrieval_result") {
    hasString(artifact, "document_id", errors);
    hasString(artifact, "chunk_id", errors);
    hasNumber(artifact, "score", errors);
    hasString(artifact, "quote_preview", errors);
    hasString(artifact, "method", errors);
    hasString(artifact, "ranking_basis", errors);
  }

  if (artifactType === "claim") {
    hasString(artifact, "text", errors);
    hasArray(artifact, "evidence_item_ids", errors);
    if (typeof artifact.unsupported !== "boolean") {
      errors.push("unsupported must be a boolean");
    }
  }

  if (artifactType === "obligation_item") {
    hasString(artifact, "title", errors);
    hasString(artifact, "description", errors);
    hasArray(artifact, "source_evidence_ids", errors);
    hasString(artifact, "status", errors);
    hasString(artifact, "risk_level", errors);
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

export function createAuditEvent(params: {
  matter_id: string;
  actor_type?: AuditActorType;
  actor_id?: string;
  action: string;
  artifact_id?: string;
  artifact_type?: ArtifactType;
  before_hash?: string;
  after_hash?: string;
  timestamp?: string;
  id?: string;
}): AuditEvent {
  const timestamp = params.timestamp ?? new Date().toISOString();
  return {
    id:
      params.id ??
      computeArtifactId(
        "audit_event",
        params.matter_id,
        `${params.action}:${params.artifact_id ?? "matter"}:${timestamp}`,
      ),
    matter_id: params.matter_id,
    actor_type: params.actor_type ?? "system",
    actor_id: params.actor_id ?? "v1-contracts",
    action: params.action,
    artifact_id: params.artifact_id,
    artifact_type: params.artifact_type,
    before_hash: params.before_hash,
    after_hash: params.after_hash,
    timestamp,
  };
}

export function countUnsupportedClaims(
  memo: DraftMemo,
  evidence: EvidenceItem[] = [],
) {
  return findUnsupportedClaims(memo, evidence).reduce(
    (total, item) => total + item.unsupported_claim_count,
    0,
  );
}

export function summarizeGateResults(gateResults: GateResult[]): GateSummary {
  const count = (status: GateStatus) =>
    gateResults.filter((gate) => gate.status === status).length;
  const blockingFailures = gateResults.filter((gate) => gate.status === "failed");

  return {
    total: gateResults.length,
    passed: count("passed"),
    failed: count("failed"),
    warning: count("warning"),
    skipped: count("skipped"),
    blocking_failures: blockingFailures,
    export_ready: canExportFinal(gateResults),
  };
}

function failureTypeForReviewComment(comment: ReviewComment): EvalFailureType {
  const text = `${comment.tag ?? ""} ${comment.comment}`.toLowerCase();
  if (text.includes("citation") || text.includes("source")) {
    return "missing_citation";
  }
  if (text.includes("contradict") || text.includes("conflict")) {
    return "contradiction_missed";
  }
  if (text.includes("missed issue") || text.includes("missing issue")) {
    return "missed_issue";
  }
  if (text.includes("risk level") || text.includes("severity")) {
    return "wrong_risk_level";
  }
  if (text.includes("structure") || text.includes("section")) {
    return "bad_memo_structure";
  }
  if (text.includes("unsupported") || text.includes("overclaim")) {
    return "unsupported_claim";
  }
  return "expert_override";
}

function failureTypeForGateResult(gate: GateResult): EvalFailureType {
  if (gate.gate_type === "citation" || gate.gate_type === "external_source") {
    return "missing_citation";
  }
  if (gate.gate_type === "conflict") {
    return "contradiction_missed";
  }
  if (gate.gate_type === "missing_material" || gate.gate_type === "jurisdiction") {
    return "missed_issue";
  }
  return "expert_override";
}

export function createEvalCaseFromReviewComment(
  comment: ReviewComment,
  sourceRunId = "run-unavailable",
): EvalCase {
  return {
    id: computeArtifactId(
      "eval_case",
      comment.matter_id,
      `review-comment:${comment.id}:${comment.status}`,
    ),
    matter_id: comment.matter_id,
    source_run_id: sourceRunId,
    failure_type: failureTypeForReviewComment(comment),
    input_snapshot: {
      review_comment_id: comment.id,
      artifact_id: comment.artifact_id,
      artifact_type: comment.artifact_type,
      target_type: comment.target_type,
      target_id: comment.target_id,
      severity: comment.severity,
      status: comment.status,
    },
    expected_behavior:
      "Future runs should satisfy this expert review before gate approval or final export.",
    expert_feedback: comment.comment,
    status: "open",
  };
}

export function createEvalCaseFromGateFailure(
  gate: GateResult,
  sourceRunId = "run-unavailable",
): EvalCase {
  return {
    id: computeArtifactId(
      "eval_case",
      gate.matter_id,
      `gate-failure:${gate.id}:${gate.status}`,
    ),
    matter_id: gate.matter_id,
    source_run_id: sourceRunId,
    failure_type: failureTypeForGateResult(gate),
    input_snapshot: {
      gate_id: gate.id,
      gate_type: gate.gate_type,
      gate_status: gate.status,
      affected_artifact_ids: gate.affected_artifact_ids,
      required_action: gate.required_action,
    },
    expected_behavior:
      gate.required_action ??
      "Future runs should clear or explicitly route this gate before final export.",
    expert_feedback: gate.reason,
    status: gate.status === "failed" ? "open" : "triaged",
  };
}

export function createV1EvalCaseFixture(params: {
  matter_id: string;
  source_run_id?: string;
  review_comments?: ReviewComment[];
  gate_results?: GateResult[];
  include_warning_gates?: boolean;
  local_only_limitations?: string[];
}): V1EvalCaseFixture {
  const sourceRunId = params.source_run_id ?? "run-unavailable";
  const reviewComments = (params.review_comments ?? []).filter(
    (comment) => comment.status === "open",
  );
  const gateResults = (params.gate_results ?? []).filter((gate) =>
    params.include_warning_gates
      ? gate.status === "failed" || gate.status === "warning"
      : gate.status === "failed",
  );
  const evalCases = [
    ...reviewComments.map((comment) =>
      createEvalCaseFromReviewComment(comment, sourceRunId),
    ),
    ...gateResults.map((gate) => createEvalCaseFromGateFailure(gate, sourceRunId)),
  ];

  return {
    schema_version: "aletheia-v1-eval-case-fixture-v1",
    matter_id: params.matter_id,
    source_run_id: sourceRunId,
    eval_cases: evalCases,
    source_review_comment_ids: reviewComments.map((comment) => comment.id).sort(),
    source_gate_result_ids: gateResults.map((gate) => gate.id).sort(),
    local_only_limitations: [
      ...(params.local_only_limitations ?? []),
      "V1 eval fixtures are local contract outputs until review, gate, source-index, audit, and run provenance are persisted end to end.",
    ],
  };
}

export function createSkillCandidateFromEvalCases(
  evalCases: EvalCase[],
  options: {
    matter_id?: string;
    name?: string;
    description?: string;
    version?: string;
  } = {},
): ProfessionalSkill {
  const matterId = options.matter_id ?? evalCases[0]?.matter_id ?? "v1-skills";
  const failureCounts = new Map<EvalFailureType, number>();
  for (const evalCase of evalCases) {
    failureCounts.set(
      evalCase.failure_type,
      (failureCounts.get(evalCase.failure_type) ?? 0) + 1,
    );
  }
  const dominantFailure =
    [...failureCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ??
    "expert_override";

  return {
    id: computeArtifactId(
      "professional_skill",
      matterId,
      `candidate:${dominantFailure}:${evalCases.map((item) => item.id).sort().join(",")}`,
    ),
    name: options.name ?? `V1 ${dominantFailure.replace(/_/g, " ")} candidate`,
    description:
      options.description ??
      "Candidate professional skill created from recurring eval feedback. Human approval is required before activation.",
    trigger_conditions: [`failure_type == ${dominantFailure}`],
    required_inputs: ["eval_case", "review_comment"],
    expected_outputs: ["professional_skill", "gate_result"],
    evidence_requirements: [
      "Preserve source eval case IDs, expert feedback, and affected artifact references.",
    ],
    approval_status: "candidate",
    created_from_eval_case_ids: evalCases.map((item) => item.id).sort(),
    version: options.version ?? "0.1.0",
  };
}

export function hashArtifact(artifact: unknown) {
  return computeExportHash(artifact);
}

export function createV1CompactFixture(
  now = "2026-07-09T09:00:00.000Z",
): V1WorkspaceFixture {
  const matter = createDefaultMatter({
    id: "matter-v1-contract-fixture",
    title: "V1 Contract Fixture Matter",
    type: "due_diligence",
    risk_level: "high",
    now,
  });
  const document: DocumentRecord = {
    id: "doc-v1-msa",
    matter_id: matter.id,
    title: "Master Services Agreement",
    filename: "master-services-agreement.pdf",
    document_type: "contract",
    status: "indexed",
    uploaded_at: now,
    hash: "sha256:v1-contract-fixture-msa",
    mime_type: "application/pdf",
    byte_size: 2048,
    page_count: 12,
    parser: "deterministic",
  };
  const chunk: DocumentChunk = {
    id: "chunk-v1-msa-notice",
    matter_id: matter.id,
    document_id: document.id,
    text: "Vendor must notify Customer of a confirmed security incident no later than 48 hours after confirmation.",
    page: 12,
    section: "8.2 Security Incident Notice",
    start_offset: 1200,
    end_offset: 1301,
    hash: "sha256:v1-contract-fixture-chunk",
  };
  const retrieval: RetrievalResult = {
    id: "retrieval-v1-notice",
    matter_id: matter.id,
    document_id: document.id,
    chunk_id: chunk.id,
    score: 0.97,
    quote_preview: chunk.text,
    method: "keyword",
    ranking_basis: "Exact match on security incident notice and 48 hours.",
    page: chunk.page,
    section: chunk.section,
  };
  const evidence: EvidenceItem = {
    id: "evidence-v1-notice-window",
    matter_id: matter.id,
    source_document_id: document.id,
    source_chunk_id: chunk.id,
    page: chunk.page,
    section: chunk.section,
    quote: chunk.text,
    normalized_fact:
      "The agreement requires security incident notice within 48 hours after confirmation.",
    supports_claim_ids: ["claim-v1-notice-window"],
    confidence: 0.94,
    review_status: "pending",
  };
  const claim: Claim = {
    id: "claim-v1-notice-window",
    matter_id: matter.id,
    text: "Notice is due within 48 hours after incident confirmation.",
    evidence_item_ids: [evidence.id],
    unsupported: false,
    confidence: 0.94,
  };
  const issue: IssueNode = {
    id: "issue-v1-notice-timing",
    matter_id: matter.id,
    title: "Whether incident notice was timely",
    description:
      "The fixture issue tests source-linked notice timing from contract text.",
    legal_or_professional_standard: "Contractual incident notice obligation.",
    related_evidence_ids: [evidence.id],
    open_questions: ["Confirm incident confirmation timestamp."],
    risk_level: "high",
    review_status: "pending",
  };
  const obligation: ObligationItem = {
    id: "obligation-v1-notice-window",
    matter_id: matter.id,
    title: "Security incident notice window",
    description:
      "Vendor must notify Customer within the contractually specified incident notice window.",
    source_evidence_ids: [evidence.id],
    status: "open",
    risk_level: "high",
  };
  const risk: RiskItem = {
    id: "risk-v1-late-notice",
    matter_id: matter.id,
    title: "Potential late security incident notice",
    description:
      "Late notice may create contractual and customer escalation risk if confirmation preceded notice by more than 48 hours.",
    severity: "high",
    likelihood: "medium",
    related_issue_ids: [issue.id],
    related_evidence_ids: [evidence.id],
    recommendation: "Confirm the incident timeline before final export.",
    status: "open",
  };
  const draftMemo: DraftMemo = {
    id: "memo-v1-red-flag",
    matter_id: matter.id,
    title: "Draft Red Flag Memo",
    sections: [
      {
        id: "memo-section-v1-notice",
        title: "Notice Timing",
        body: "The contract requires notice within 48 hours after confirmation.",
        evidence_reference_ids: [evidence.id],
        issue_reference_ids: [issue.id],
        unsupported_claim_count: 0,
      },
    ],
    citation_coverage_score: 1,
    unsupported_claim_count: 0,
    review_status: "pending",
    gate_status: "warning",
  };
  const gateResults: GateResult[] = [
    {
      id: "gate-v1-citation",
      matter_id: matter.id,
      gate_type: "citation",
      status: "passed",
      reason: "All memo sections include valid fixture evidence IDs.",
      affected_artifact_ids: [draftMemo.id],
      created_at: now,
    },
    {
      id: "gate-v1-human-approval",
      matter_id: matter.id,
      gate_type: "human_approval",
      status: "warning",
      reason: "Fixture is not approved for final export.",
      affected_artifact_ids: [draftMemo.id],
      required_action: "Collect expert approval before final export.",
      created_at: now,
    },
  ];

  return {
    contract_version: V1_CONTRACT_VERSION,
    matter,
    documents: [document],
    chunks: [chunk],
    retrieval_results: [retrieval],
    evidence: [evidence],
    claims: [claim],
    issues: [issue],
    obligations: [obligation],
    risks: [risk],
    draft_memo: draftMemo,
    gate_results: gateResults,
  };
}

export type V1BigAtReference = BigAtParsedReference;
export type V1BigAtReferenceResolution = BigAtReferenceResolution;
