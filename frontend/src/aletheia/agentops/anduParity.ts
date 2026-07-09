export type AnduParitySourceType =
  | "matter_document"
  | "source_chunk"
  | "evidence_item"
  | "external_url"
  | "external_snapshot"
  | "workpaper"
  | "review_comment"
  | "audit_event"
  | "agent_run"
  | "playbook";

export type AnduParitySourceRef = {
  id: string;
  type: AnduParitySourceType;
  captured_at?: string;
  url?: string;
  hash?: string;
  evidence_item_id?: string;
  audit_event_id?: string;
};

export type LegalQaArtifact = {
  id: string;
  matter_id: string;
  question: string;
  answer: string;
  status: "draft" | "needs_review" | "approved" | "blocked";
  source_refs: AnduParitySourceRef[];
  review_comment_ids: string[];
  audit_event_ids: string[];
  professional_caveat: string;
};

export type ExternalCheckArtifact = {
  id: string;
  matter_id: string;
  check_type:
    | "whole_web"
    | "network_check"
    | "related_party"
    | "customer_supplier"
    | "shareholder_penetration";
  query: string;
  connector_id: string;
  external_access_opt_in: boolean;
  status: "queued" | "running" | "needs_review" | "approved" | "blocked";
  source_refs: AnduParitySourceRef[];
  workpaper_ids: string[];
  review_comment_ids: string[];
  audit_event_ids: string[];
};

export type EntityGraphNode = {
  id: string;
  matter_id: string;
  kind:
    | "company"
    | "individual"
    | "shareholder"
    | "beneficial_owner"
    | "controller"
    | "related_party"
    | "customer"
    | "supplier"
    | "investment_vehicle";
  name: string;
  source_refs: AnduParitySourceRef[];
};

export type EntityGraphEdge = {
  id: string;
  matter_id: string;
  from_node_id: string;
  to_node_id: string;
  relationship:
    | "owns"
    | "controls"
    | "beneficially_owns"
    | "related_to"
    | "customer_of"
    | "supplier_of"
    | "invested_in";
  evidence_status: "confirmed" | "inferred" | "conflicting" | "missing";
  confidence: number;
  ownership_percentage?: number;
  conflict_note?: string;
  source_refs: AnduParitySourceRef[];
  review_comment_ids: string[];
  audit_event_ids: string[];
};

export type WordAddinHandoffArtifact = {
  id: string;
  matter_id: string;
  document_id: string;
  operation:
    | "selected_text_qa"
    | "clause_suggestion"
    | "insert_review_comment"
    | "tracked_change"
    | "sync_work_product";
  status: "draft" | "needs_review" | "approved" | "blocked";
  selected_text_hash?: string;
  tracked_change_ids: string[];
  source_refs: AnduParitySourceRef[];
  review_comment_ids: string[];
  audit_event_ids: string[];
};

export type PreferenceLearningProposal = {
  id: string;
  scope_type: "user" | "organization" | "matter";
  scope_id: string;
  opt_in: boolean;
  revocable: boolean;
  status: "candidate" | "approved" | "rejected" | "blocked";
  proposed_change: string;
  source_review_comment_ids: string[];
  source_eval_case_ids: string[];
  source_playbook_ids: string[];
  approved_by?: string;
  approved_at?: string;
  audit_event_ids: string[];
};

export type AnduParityContractBundle = {
  legalQaArtifacts?: LegalQaArtifact[];
  externalChecks?: ExternalCheckArtifact[];
  entityGraphNodes?: EntityGraphNode[];
  entityGraphEdges?: EntityGraphEdge[];
  wordAddinHandoffs?: WordAddinHandoffArtifact[];
  preferenceLearningProposals?: PreferenceLearningProposal[];
};

export type ShareholderPenetrationFixture = {
  bundle: Pick<
    AnduParityContractBundle,
    "externalChecks" | "entityGraphNodes" | "entityGraphEdges"
  >;
  penetration_path_node_ids: string[];
  penetration_path_edge_ids: string[];
};

export type ExternalSourceWorkpaperFixture = {
  bundle: Pick<AnduParityContractBundle, "externalChecks">;
  retained_source_ids: string[];
  workpaper_ids: string[];
  review_comment_ids: string[];
  audit_event_ids: string[];
};

export type AnduParityValidationItem = {
  name: string;
  status: "passed" | "warning" | "failed";
  detail: string;
};

function hasSources(sourceRefs: AnduParitySourceRef[]) {
  return sourceRefs.length > 0;
}

function hasAudit(auditEventIds: string[]) {
  return auditEventIds.length > 0;
}

function hasReview(reviewCommentIds: string[]) {
  return reviewCommentIds.length > 0;
}

function validConfidence(confidence: number) {
  return Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
}

function retainedExternalSource(source: AnduParitySourceRef) {
  if (!source.hash) {
    return false;
  }
  if (source.type === "external_snapshot") {
    return Boolean(source.url) && Boolean(source.captured_at);
  }
  if (source.type === "external_url") {
    return Boolean(source.url);
  }
  return true;
}

function sourceRef(params: {
  id: string;
  type: AnduParitySourceType;
  hash: string;
  auditEventId?: string;
}): AnduParitySourceRef {
  return {
    id: params.id,
    type: params.type,
    hash: params.hash,
    audit_event_id: params.auditEventId,
  };
}

export function buildExternalSourceWorkpaperFixture(params: {
  matterId: string;
  checkType: ExternalCheckArtifact["check_type"];
  query: string;
  connectorId: string;
  snapshotUrl: string;
  capturedAt: string;
  workpaperId: string;
  auditEventId: string;
  reviewCommentId: string;
}): ExternalSourceWorkpaperFixture {
  const urlSource: AnduParitySourceRef = {
    id: `${params.workpaperId}:external-url`,
    type: "external_url",
    url: params.snapshotUrl,
    hash: "sha256:external-url",
    audit_event_id: params.auditEventId,
  };
  const snapshotSource: AnduParitySourceRef = {
    id: `${params.workpaperId}:external-snapshot`,
    type: "external_snapshot",
    url: params.snapshotUrl,
    captured_at: params.capturedAt,
    hash: "sha256:external-snapshot",
    audit_event_id: params.auditEventId,
  };

  return {
    bundle: {
      externalChecks: [
        {
          id: "external-source-workpaper-check",
          matter_id: params.matterId,
          check_type: params.checkType,
          query: params.query,
          connector_id: params.connectorId,
          external_access_opt_in: true,
          status: "approved",
          source_refs: [urlSource, snapshotSource],
          workpaper_ids: [params.workpaperId],
          review_comment_ids: [params.reviewCommentId],
          audit_event_ids: [params.auditEventId],
        },
      ],
    },
    retained_source_ids: [urlSource.id, snapshotSource.id],
    workpaper_ids: [params.workpaperId],
    review_comment_ids: [params.reviewCommentId],
    audit_event_ids: [params.auditEventId],
  };
}

export function buildShareholderPenetrationFixture(params: {
  matterId: string;
  issuerName: string;
  directShareholderName: string;
  beneficialOwnerName: string;
  workpaperId: string;
  auditEventId: string;
  reviewCommentId: string;
}): ShareholderPenetrationFixture {
  const registerSource = sourceRef({
    id: `${params.workpaperId}:share-register`,
    type: "workpaper",
    hash: "sha256:share-register-workpaper",
    auditEventId: params.auditEventId,
  });
  const beneficialOwnerSource = sourceRef({
    id: `${params.workpaperId}:beneficial-owner-confirmation`,
    type: "workpaper",
    hash: "sha256:beneficial-owner-confirmation",
    auditEventId: params.auditEventId,
  });
  const issuerId = "entity-issuer";
  const shareholderId = "entity-direct-shareholder";
  const ownerId = "entity-beneficial-owner";
  const shareholderEdgeId = "edge-shareholder-owns-issuer";
  const ownerEdgeId = "edge-owner-controls-shareholder";

  return {
    bundle: {
      externalChecks: [
        {
          id: "external-check-shareholder-penetration",
          matter_id: params.matterId,
          check_type: "shareholder_penetration",
          query: `${params.issuerName} shareholder penetration review`,
          connector_id: "local-workpaper-fixture",
          external_access_opt_in: false,
          status: "blocked",
          source_refs: [registerSource, beneficialOwnerSource],
          workpaper_ids: [params.workpaperId],
          review_comment_ids: [params.reviewCommentId],
          audit_event_ids: [params.auditEventId],
        },
      ],
      entityGraphNodes: [
        {
          id: issuerId,
          matter_id: params.matterId,
          kind: "company",
          name: params.issuerName,
          source_refs: [registerSource],
        },
        {
          id: shareholderId,
          matter_id: params.matterId,
          kind: "shareholder",
          name: params.directShareholderName,
          source_refs: [registerSource],
        },
        {
          id: ownerId,
          matter_id: params.matterId,
          kind: "beneficial_owner",
          name: params.beneficialOwnerName,
          source_refs: [beneficialOwnerSource],
        },
      ],
      entityGraphEdges: [
        {
          id: shareholderEdgeId,
          matter_id: params.matterId,
          from_node_id: shareholderId,
          to_node_id: issuerId,
          relationship: "owns",
          evidence_status: "confirmed",
          confidence: 0.94,
          source_refs: [registerSource],
          review_comment_ids: [params.reviewCommentId],
          audit_event_ids: [params.auditEventId],
        },
        {
          id: ownerEdgeId,
          matter_id: params.matterId,
          from_node_id: ownerId,
          to_node_id: shareholderId,
          relationship: "beneficially_owns",
          evidence_status: "confirmed",
          confidence: 0.88,
          source_refs: [beneficialOwnerSource],
          review_comment_ids: [params.reviewCommentId],
          audit_event_ids: [params.auditEventId],
        },
      ],
    },
    penetration_path_node_ids: [ownerId, shareholderId, issuerId],
    penetration_path_edge_ids: [ownerEdgeId, shareholderEdgeId],
  };
}

export function validateAnduParityContracts(
  bundle: AnduParityContractBundle,
): AnduParityValidationItem[] {
  const validation: AnduParityValidationItem[] = [];

  for (const item of bundle.legalQaArtifacts ?? []) {
    const approved = item.status === "approved";
    validation.push({
      name: `legal_qa_sources:${item.id}`,
      status: hasSources(item.source_refs)
        ? "passed"
        : approved
          ? "failed"
          : "warning",
      detail: hasSources(item.source_refs)
        ? "Legal Q&A answer includes cited source references."
        : "Legal Q&A answer has no source references and must remain review-only.",
    });
    validation.push({
      name: `legal_qa_review_audit:${item.id}`,
      status: approved && hasReview(item.review_comment_ids) && hasAudit(item.audit_event_ids)
        ? "passed"
        : approved
          ? "failed"
          : "warning",
      detail:
        approved && hasReview(item.review_comment_ids) && hasAudit(item.audit_event_ids)
          ? "Approved Legal Q&A answer has review and audit provenance."
          : "Legal Q&A answer is not approved with both review and audit provenance.",
    });
  }

  for (const item of bundle.externalChecks ?? []) {
    const activeCheck = !["queued", "running", "blocked"].includes(
      item.status,
    );
    validation.push({
      name: `external_check_opt_in:${item.id}`,
      status: item.external_access_opt_in || item.status === "blocked"
        ? "passed"
        : "failed",
      detail: item.external_access_opt_in
        ? "External-source access is explicitly enabled for this check."
        : "External-source access is not opt-in; the check must stay blocked.",
    });
    validation.push({
      name: `external_check_workpapers:${item.id}`,
      status:
        hasSources(item.source_refs) &&
        item.workpaper_ids.length > 0 &&
        hasAudit(item.audit_event_ids)
          ? "passed"
          : activeCheck
            ? "failed"
            : "warning",
      detail:
        "External checks need retained source records, workpapers, and audit events before approval.",
    });
    validation.push({
      name: `external_check_source_retention:${item.id}`,
      status: item.source_refs.every(retainedExternalSource)
        ? "passed"
        : activeCheck
          ? "failed"
          : "warning",
      detail:
        "External checks must retain source hashes, URLs, and snapshot capture timestamps where applicable.",
    });
  }

  const nodeIds = new Set((bundle.entityGraphNodes ?? []).map((node) => node.id));
  for (const node of bundle.entityGraphNodes ?? []) {
    validation.push({
      name: `entity_node_sources:${node.id}`,
      status: hasSources(node.source_refs) ? "passed" : "warning",
      detail: hasSources(node.source_refs)
        ? "Entity graph node is source-backed."
        : "Entity graph node lacks source references.",
    });
  }
  for (const edge of bundle.entityGraphEdges ?? []) {
    const endpointsExist =
      nodeIds.has(edge.from_node_id) && nodeIds.has(edge.to_node_id);
    validation.push({
      name: `entity_edge_endpoints:${edge.id}`,
      status: endpointsExist ? "passed" : "failed",
      detail: endpointsExist
        ? "Entity graph edge endpoints exist in the graph."
        : "Entity graph edge references a missing node.",
    });
    validation.push({
      name: `entity_edge_sources:${edge.id}`,
      status:
        hasSources(edge.source_refs) &&
        edge.evidence_status !== "missing" &&
        validConfidence(edge.confidence) &&
        hasReview(edge.review_comment_ids) &&
        hasAudit(edge.audit_event_ids)
          ? "passed"
          : edge.evidence_status === "missing"
            ? "failed"
            : "warning",
      detail:
        "Entity graph edges must preserve source refs, evidence status, confidence, review, and audit provenance.",
    });
    const percentageValid = edge.ownership_percentage === undefined || (Number.isFinite(edge.ownership_percentage) && edge.ownership_percentage >= 0 && edge.ownership_percentage <= 100);
    validation.push({
      name: `entity_edge_ownership_percentage:${edge.id}`,
      status: percentageValid ? "passed" : "failed",
      detail: "Ownership percentage, when supplied, must be between 0 and 100.",
    });
    validation.push({
      name: `entity_edge_conflict_note:${edge.id}`,
      status: edge.evidence_status !== "conflicting" || Boolean(edge.conflict_note?.trim()) ? "passed" : "failed",
      detail: "Conflicting ownership evidence requires a retained conflict note for reviewer resolution.",
    });
  }

  for (const item of bundle.wordAddinHandoffs ?? []) {
    const approved = item.status === "approved";
    validation.push({
      name: `word_addin_review_gate:${item.id}`,
      status:
        approved && hasSources(item.source_refs) && hasReview(item.review_comment_ids) && hasAudit(item.audit_event_ids)
          ? "passed"
          : approved
            ? "failed"
            : "warning",
      detail:
        "Word Add-in handoff must sync source, review, and audit provenance before approval.",
    });
  }

  for (const item of bundle.preferenceLearningProposals ?? []) {
    const approved = item.status === "approved";
    validation.push({
      name: `preference_learning_scope:${item.id}`,
      status: item.opt_in && item.revocable ? "passed" : approved ? "failed" : "warning",
      detail:
        "Preference learning must be opt-in, scoped, and revocable in sensitive workflows.",
    });
    validation.push({
      name: `preference_learning_approval:${item.id}`,
      status:
        approved &&
        Boolean(item.approved_by) &&
        Boolean(item.approved_at) &&
        hasAudit(item.audit_event_ids)
          ? "passed"
          : approved
            ? "failed"
            : "warning",
      detail:
        "Approved preference learning must have human approval and audit provenance.",
    });
  }

  return validation;
}

export function validateExternalSourceWorkpaperFixture(
  fixture: ExternalSourceWorkpaperFixture,
): AnduParityValidationItem[] {
  const validation = validateAnduParityContracts(fixture.bundle);
  const checks = fixture.bundle.externalChecks ?? [];
  const sourceIds = new Set(
    checks.flatMap((check) => check.source_refs.map((source) => source.id)),
  );
  const workpaperIds = new Set(checks.flatMap((check) => check.workpaper_ids));
  const reviewIds = new Set(
    checks.flatMap((check) => check.review_comment_ids),
  );
  const auditIds = new Set(checks.flatMap((check) => check.audit_event_ids));
  const missingSources = fixture.retained_source_ids.filter(
    (sourceId) => !sourceIds.has(sourceId),
  );
  const missingWorkpapers = fixture.workpaper_ids.filter(
    (workpaperId) => !workpaperIds.has(workpaperId),
  );
  const missingReviews = fixture.review_comment_ids.filter(
    (reviewId) => !reviewIds.has(reviewId),
  );
  const missingAudits = fixture.audit_event_ids.filter(
    (auditId) => !auditIds.has(auditId),
  );
  const weakApprovedChecks = checks.filter(
    (check) =>
      check.status === "approved" &&
      (!check.external_access_opt_in ||
        !hasSources(check.source_refs) ||
        check.workpaper_ids.length === 0 ||
        !hasReview(check.review_comment_ids) ||
        !hasAudit(check.audit_event_ids) ||
        !check.source_refs.every(retainedExternalSource)),
  );

  validation.push({
    name: "external_source_fixture_retained_sources",
    status: missingSources.length ? "failed" : "passed",
    detail: missingSources.length
      ? `${missingSources.length} retained source(s) are missing from the external check.`
      : "External source fixture retained source IDs are present.",
  });
  validation.push({
    name: "external_source_fixture_workpapers",
    status:
      missingWorkpapers.length || missingReviews.length || missingAudits.length
        ? "failed"
        : "passed",
    detail:
      missingWorkpapers.length || missingReviews.length || missingAudits.length
        ? "External source fixture must preserve workpaper, review, and audit IDs."
        : "External source fixture preserves workpaper, review, and audit IDs.",
  });
  validation.push({
    name: "external_source_fixture_approved_checks",
    status: weakApprovedChecks.length ? "failed" : "passed",
    detail: weakApprovedChecks.length
      ? "Approved external checks must be opt-in and retain source, workpaper, review, and audit provenance."
      : "Approved external checks are opt-in with retained provenance.",
  });

  return validation;
}

export function validateShareholderPenetrationFixture(
  fixture: ShareholderPenetrationFixture,
): AnduParityValidationItem[] {
  const validation = validateAnduParityContracts(fixture.bundle);
  const nodes = new Set(
    (fixture.bundle.entityGraphNodes ?? []).map((node) => node.id),
  );
  const edges = new Map(
    (fixture.bundle.entityGraphEdges ?? []).map((edge) => [edge.id, edge]),
  );
  const missingPathNodes = fixture.penetration_path_node_ids.filter(
    (nodeId) => !nodes.has(nodeId),
  );
  const missingPathEdges = fixture.penetration_path_edge_ids.filter(
    (edgeId) => !edges.has(edgeId),
  );
  const weakPathEdges = fixture.penetration_path_edge_ids.filter((edgeId) => {
    const edge = edges.get(edgeId);
    return (
      !edge ||
      edge.evidence_status !== "confirmed" ||
      edge.source_refs.length === 0 ||
      edge.audit_event_ids.length === 0 ||
      edge.review_comment_ids.length === 0
    );
  });

  validation.push({
    name: "shareholder_penetration_path_nodes",
    status: missingPathNodes.length ? "failed" : "passed",
    detail: missingPathNodes.length
      ? `${missingPathNodes.length} penetration path node(s) are missing.`
      : "Shareholder penetration path nodes are present.",
  });
  validation.push({
    name: "shareholder_penetration_path_edges",
    status: missingPathEdges.length || weakPathEdges.length ? "failed" : "passed",
    detail:
      missingPathEdges.length || weakPathEdges.length
        ? "Shareholder penetration path edges must exist and preserve confirmed source, review, and audit provenance."
        : "Shareholder penetration path edges are source-backed, reviewed, audited, and confirmed.",
  });

  return validation;
}

export function anduParityContractsPass(
  validation: AnduParityValidationItem[],
) {
  return validation.every((item) => item.status !== "failed");
}
