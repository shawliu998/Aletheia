import assert from "node:assert/strict";
import { test } from "node:test";

import {
  anduParityContractsPass,
  buildExternalSourceWorkpaperFixture,
  buildShareholderPenetrationFixture,
  validateAnduParityContracts,
  validateExternalSourceWorkpaperFixture,
  validateShareholderPenetrationFixture,
  type AnduParityContractBundle,
} from "../../src/aletheia/agentops";

const sourceRef = {
  id: "evidence-source-1",
  type: "evidence_item" as const,
  hash: "sha256:source",
};

test("validateAnduParityContracts accepts source-backed sensitive Hermes parity records", () => {
  const bundle: AnduParityContractBundle = {
    legalQaArtifacts: [
      {
        id: "qa-cited-answer",
        matter_id: "matter-1",
        question: "What approval is required before final export?",
        answer: "Final export requires approved checkpoint and persisted gates.",
        status: "approved",
        source_refs: [sourceRef],
        review_comment_ids: ["review-qa-1"],
        audit_event_ids: ["audit-qa-approved"],
        professional_caveat: "Expert review controls final reliance.",
      },
    ],
    externalChecks: [
      {
        id: "external-network-check",
        matter_id: "matter-1",
        check_type: "network_check",
        query: "issuer litigation public-source check",
        connector_id: "external-source-workpaper",
        external_access_opt_in: true,
        status: "approved",
        source_refs: [
          {
            id: "snapshot-company-page",
            type: "external_snapshot",
            url: "https://example.test/company",
            captured_at: "2026-07-10T01:55:00.000Z",
            hash: "sha256:snapshot",
          },
        ],
        workpaper_ids: ["workpaper-network-check"],
        review_comment_ids: ["review-network-check"],
        audit_event_ids: ["audit-network-check"],
      },
    ],
    entityGraphNodes: [
      {
        id: "entity-issuer",
        matter_id: "matter-1",
        kind: "company",
        name: "Issuer Co.",
        source_refs: [sourceRef],
      },
      {
        id: "entity-shareholder",
        matter_id: "matter-1",
        kind: "shareholder",
        name: "Shareholder A",
        source_refs: [sourceRef],
      },
    ],
    entityGraphEdges: [
      {
        id: "edge-shareholder-issuer",
        matter_id: "matter-1",
        from_node_id: "entity-shareholder",
        to_node_id: "entity-issuer",
        relationship: "owns",
        evidence_status: "confirmed",
        confidence: 0.93,
        source_refs: [sourceRef],
        review_comment_ids: ["review-graph-edge"],
        audit_event_ids: ["audit-graph-edge"],
      },
    ],
    wordAddinHandoffs: [
      {
        id: "word-handoff-1",
        matter_id: "matter-1",
        document_id: "doc-1",
        operation: "clause_suggestion",
        status: "approved",
        selected_text_hash: "sha256:selected",
        tracked_change_ids: ["tc-1"],
        source_refs: [sourceRef],
        review_comment_ids: ["review-word"],
        audit_event_ids: ["audit-word"],
      },
    ],
    preferenceLearningProposals: [
      {
        id: "preference-learning-1",
        scope_type: "matter",
        scope_id: "matter-1",
        opt_in: true,
        revocable: true,
        status: "approved",
        proposed_change: "Prefer stricter notice-window clause review.",
        source_review_comment_ids: ["review-word"],
        source_eval_case_ids: ["eval-notice-window"],
        source_playbook_ids: ["playbook-notice-window"],
        approved_by: "reviewer-legal",
        approved_at: "2026-07-10T01:55:00.000Z",
        audit_event_ids: ["audit-preference-approved"],
      },
    ],
  };
  const validation = validateAnduParityContracts(bundle);

  assert.equal(anduParityContractsPass(validation), true);
  assert.equal(validation.every((item) => item.status === "passed"), true);
});

test("validateAnduParityContracts fails closed for uncited, unapproved, or unscoped parity records", () => {
  const validation = validateAnduParityContracts({
    legalQaArtifacts: [
      {
        id: "qa-uncited",
        matter_id: "matter-1",
        question: "Can we rely on this?",
        answer: "Yes.",
        status: "approved",
        source_refs: [],
        review_comment_ids: [],
        audit_event_ids: [],
        professional_caveat: "",
      },
    ],
    externalChecks: [
      {
        id: "external-no-opt-in",
        matter_id: "matter-1",
        check_type: "whole_web",
        query: "public web",
        connector_id: "web",
        external_access_opt_in: false,
        status: "approved",
        source_refs: [],
        workpaper_ids: [],
        review_comment_ids: [],
        audit_event_ids: [],
      },
    ],
    entityGraphNodes: [
      {
        id: "entity-issuer",
        matter_id: "matter-1",
        kind: "company",
        name: "Issuer Co.",
        source_refs: [],
      },
    ],
    entityGraphEdges: [
      {
        id: "edge-missing-source",
        matter_id: "matter-1",
        from_node_id: "entity-missing",
        to_node_id: "entity-issuer",
        relationship: "owns",
        evidence_status: "missing",
        confidence: 1.2,
        source_refs: [],
        review_comment_ids: [],
        audit_event_ids: [],
      },
    ],
    wordAddinHandoffs: [
      {
        id: "word-bypass",
        matter_id: "matter-1",
        document_id: "doc-1",
        operation: "tracked_change",
        status: "approved",
        tracked_change_ids: ["tc-1"],
        source_refs: [],
        review_comment_ids: [],
        audit_event_ids: [],
      },
    ],
    preferenceLearningProposals: [
      {
        id: "global-silent-learning",
        scope_type: "organization",
        scope_id: "org-1",
        opt_in: false,
        revocable: false,
        status: "approved",
        proposed_change: "Silently learn all behavior.",
        source_review_comment_ids: [],
        source_eval_case_ids: [],
        source_playbook_ids: [],
        audit_event_ids: [],
      },
    ],
  });
  const failedNames = validation
    .filter((item) => item.status === "failed")
    .map((item) => item.name);

  assert.equal(anduParityContractsPass(validation), false);
  assert.ok(failedNames.includes("legal_qa_sources:qa-uncited"));
  assert.ok(failedNames.includes("legal_qa_review_audit:qa-uncited"));
  assert.ok(failedNames.includes("external_check_opt_in:external-no-opt-in"));
  assert.ok(failedNames.includes("external_check_workpapers:external-no-opt-in"));
  assert.ok(failedNames.includes("entity_edge_endpoints:edge-missing-source"));
  assert.ok(failedNames.includes("entity_edge_sources:edge-missing-source"));
  assert.ok(failedNames.includes("word_addin_review_gate:word-bypass"));
  assert.ok(failedNames.includes("preference_learning_scope:global-silent-learning"));
  assert.ok(
    failedNames.includes("preference_learning_approval:global-silent-learning"),
  );
});

test("validateAnduParityContracts rejects incomplete active external-source checks", () => {
  const validation = validateAnduParityContracts({
    externalChecks: [
      {
        id: "external-review-missing-retention",
        matter_id: "matter-1",
        check_type: "whole_web",
        query: "public-source check",
        connector_id: "manual-source-capture",
        external_access_opt_in: true,
        status: "needs_review",
        source_refs: [
          {
            id: "external-snapshot",
            type: "external_snapshot",
            url: "https://example.test/source",
          },
        ],
        workpaper_ids: [],
        review_comment_ids: [],
        audit_event_ids: [],
      },
    ],
  });
  const failedNames = validation
    .filter((item) => item.status === "failed")
    .map((item) => item.name);

  assert.ok(
    failedNames.includes(
      "external_check_workpapers:external-review-missing-retention",
    ),
  );
  assert.ok(
    failedNames.includes(
      "external_check_source_retention:external-review-missing-retention",
    ),
  );
});

test("validateAnduParityContracts rejects graph relationships without review provenance", () => {
  const validation = validateAnduParityContracts({
    entityGraphNodes: [
      {
        id: "issuer",
        matter_id: "matter-1",
        kind: "company",
        name: "Issuer Co.",
        source_refs: [sourceRef],
      },
      {
        id: "shareholder",
        matter_id: "matter-1",
        kind: "shareholder",
        name: "Holding Co.",
        source_refs: [sourceRef],
      },
    ],
    entityGraphEdges: [
      {
        id: "ownership-edge",
        matter_id: "matter-1",
        from_node_id: "shareholder",
        to_node_id: "issuer",
        relationship: "owns",
        evidence_status: "confirmed",
        confidence: 0.9,
        source_refs: [sourceRef],
        review_comment_ids: [],
        audit_event_ids: ["audit-ownership"],
      },
    ],
  });
  assert.ok(
    validation.some(
      (item) =>
        item.name === "entity_edge_sources:ownership-edge" &&
        item.status === "warning",
    ),
  );
});

test("validateAnduParityContracts rejects invalid ownership percentages and unexplained conflicts", () => {
  const validation = validateAnduParityContracts({
    entityGraphNodes: [
      { id: "issuer", matter_id: "matter-1", kind: "company", name: "Issuer Co.", source_refs: [sourceRef] },
      { id: "owner", matter_id: "matter-1", kind: "beneficial_owner", name: "Owner A", source_refs: [sourceRef] },
    ],
    entityGraphEdges: [
      {
        id: "invalid-ownership-edge", matter_id: "matter-1", from_node_id: "owner", to_node_id: "issuer",
        relationship: "beneficially_owns", evidence_status: "conflicting", confidence: 0.6,
        ownership_percentage: 120, source_refs: [sourceRef], review_comment_ids: ["review-1"], audit_event_ids: ["audit-1"],
      },
    ],
  });
  const failedNames = validation.filter((item) => item.status === "failed").map((item) => item.name);
  assert.ok(failedNames.includes("entity_edge_ownership_percentage:invalid-ownership-edge"));
  assert.ok(failedNames.includes("entity_edge_conflict_note:invalid-ownership-edge"));
});

test("buildShareholderPenetrationFixture creates a source-backed ownership path", () => {
  const fixture = buildShareholderPenetrationFixture({
    matterId: "matter-shareholder-penetration",
    issuerName: "Issuer Co.",
    directShareholderName: "Holding Co.",
    beneficialOwnerName: "Controller A",
    workpaperId: "workpaper-shareholder-register",
    auditEventId: "audit-shareholder-penetration",
    reviewCommentId: "review-shareholder-penetration",
  });
  const validation = validateShareholderPenetrationFixture(fixture);

  assert.deepEqual(fixture.penetration_path_node_ids, [
    "entity-beneficial-owner",
    "entity-direct-shareholder",
    "entity-issuer",
  ]);
  assert.deepEqual(fixture.penetration_path_edge_ids, [
    "edge-owner-controls-shareholder",
    "edge-shareholder-owns-issuer",
  ]);
  assert.equal(fixture.bundle.entityGraphNodes?.length, 3);
  assert.equal(fixture.bundle.entityGraphEdges?.length, 2);
  assert.equal(fixture.bundle.externalChecks?.[0]?.status, "blocked");
  assert.equal(
    fixture.bundle.externalChecks?.[0]?.external_access_opt_in,
    false,
  );
  assert.equal(anduParityContractsPass(validation), true);
  assert.equal(validation.every((item) => item.status === "passed"), true);
});

test("buildExternalSourceWorkpaperFixture creates an opt-in retained-source workpaper", () => {
  const fixture = buildExternalSourceWorkpaperFixture({
    matterId: "matter-external-source",
    checkType: "whole_web",
    query: "issuer litigation public-source check",
    connectorId: "external-source-workpaper",
    snapshotUrl: "https://example.test/company",
    capturedAt: "2026-07-10T02:00:00.000Z",
    workpaperId: "workpaper-external-source",
    auditEventId: "audit-external-source",
    reviewCommentId: "review-external-source",
  });
  const validation = validateExternalSourceWorkpaperFixture(fixture);
  const externalCheck = fixture.bundle.externalChecks?.[0];

  assert.equal(externalCheck?.external_access_opt_in, true);
  assert.equal(externalCheck?.status, "approved");
  assert.deepEqual(fixture.retained_source_ids, [
    "workpaper-external-source:external-url",
    "workpaper-external-source:external-snapshot",
  ]);
  assert.equal(
    externalCheck?.source_refs.some(
      (source) =>
        source.type === "external_snapshot" &&
        Boolean(source.hash) &&
        Boolean(source.url) &&
        Boolean(source.captured_at),
    ),
    true,
  );
  assert.equal(anduParityContractsPass(validation), true);
  assert.equal(validation.every((item) => item.status === "passed"), true);
});

test("validateExternalSourceWorkpaperFixture fails closed on weak retained-source evidence", () => {
  const fixture = buildExternalSourceWorkpaperFixture({
    matterId: "matter-external-source",
    checkType: "whole_web",
    query: "issuer litigation public-source check",
    connectorId: "external-source-workpaper",
    snapshotUrl: "https://example.test/company",
    capturedAt: "2026-07-10T02:00:00.000Z",
    workpaperId: "workpaper-external-source",
    auditEventId: "audit-external-source",
    reviewCommentId: "review-external-source",
  });
  const weakFixture = {
    ...fixture,
    bundle: {
      ...fixture.bundle,
      externalChecks: fixture.bundle.externalChecks?.map((check) => ({
        ...check,
        external_access_opt_in: false,
        source_refs: check.source_refs.map((source) =>
          source.type === "external_snapshot"
            ? {
                ...source,
                hash: undefined,
                captured_at: undefined,
              }
            : source,
        ),
        review_comment_ids: [],
      })),
    },
  };
  const failedNames = validateExternalSourceWorkpaperFixture(weakFixture)
    .filter((item) => item.status === "failed")
    .map((item) => item.name);

  assert.ok(
    failedNames.includes(
      "external_check_opt_in:external-source-workpaper-check",
    ),
  );
  assert.ok(
    failedNames.includes(
      "external_check_source_retention:external-source-workpaper-check",
    ),
  );
  assert.ok(failedNames.includes("external_source_fixture_workpapers"));
  assert.ok(failedNames.includes("external_source_fixture_approved_checks"));
});

test("validateShareholderPenetrationFixture fails closed on weak path evidence", () => {
  const fixture = buildShareholderPenetrationFixture({
    matterId: "matter-shareholder-penetration",
    issuerName: "Issuer Co.",
    directShareholderName: "Holding Co.",
    beneficialOwnerName: "Controller A",
    workpaperId: "workpaper-shareholder-register",
    auditEventId: "audit-shareholder-penetration",
    reviewCommentId: "review-shareholder-penetration",
  });
  const weakFixture = {
    ...fixture,
    bundle: {
      ...fixture.bundle,
      entityGraphEdges: fixture.bundle.entityGraphEdges?.map((edge) =>
        edge.id === "edge-owner-controls-shareholder"
          ? {
              ...edge,
              evidence_status: "missing" as const,
              source_refs: [],
              review_comment_ids: [],
              audit_event_ids: [],
            }
          : edge,
      ),
    },
  };
  const failedNames = validateShareholderPenetrationFixture(weakFixture)
    .filter((item) => item.status === "failed")
    .map((item) => item.name);

  assert.ok(
    failedNames.includes("entity_edge_sources:edge-owner-controls-shareholder"),
  );
  assert.ok(failedNames.includes("shareholder_penetration_path_edges"));
});
