import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createVeraMatter,
  createVeraMatterProfile,
  parseVeraMatterPolicyWire,
  parseVeraMatterPageWire,
  parseVeraMatterWire,
  updateVeraMatter,
  updateVeraMatterPolicy,
  updateVeraMatterProfile,
  VERA_WORKSPACE_TYPES,
} from "../src/app/lib/veraMatterApi.ts";

const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const NOW = "2026-07-16T10:00:00.000Z";

function projectWire(status: "active" | "archived" | "deleted" = "active") {
  return {
    id: PROJECT_ID,
    name: "Meridian acquisition",
    description: "",
    cm_number: "M-2026-0042",
    practice: "Corporate",
    status,
    default_model_profile_id: null,
    created_at: NOW,
    updated_at: NOW,
    archived_at: status === "active" ? null : NOW,
    document_count: 3,
    chat_count: 1,
    tabular_review_count: 2,
    workflow_count: 4,
  };
}

function profileWire(workspaceType: string | null = "transaction") {
  return {
    project_id: PROJECT_ID,
    workspace_type: workspaceType,
    client_name: "Meridian Ltd",
    jurisdiction: "PRC",
    represented_role: "Buyer counsel",
    objective: "Complete the acquisition with reviewed closing documents.",
    created_at: NOW,
    updated_at: NOW,
  };
}

function capabilities(
  profile: "create" | "classify" | "edit" | "unavailable",
  inference: "available" | "policy_gate_closed" | "unavailable",
) {
  return {
    matter_profile: profile,
    assistant: inference,
    workflows:
      inference === "policy_gate_closed" ? "non_inference_only" : inference,
    tabular: inference,
    review: "unavailable",
    drafts: inference === "unavailable" ? "unavailable" : "document_scoped",
  };
}

function matterWire(
  kind: "absent" | "classification_required" | "ready",
  status: "active" | "archived" | "deleted" = "active",
) {
  const lifecycleCapabilities =
    status === "active"
      ? null
      : capabilities("unavailable", "unavailable");
  if (kind === "absent") {
    return {
      project: projectWire(status),
      matter_profile: null,
      profile_state: "absent",
      capabilities:
        lifecycleCapabilities ?? capabilities("create", "available"),
    };
  }
  return {
    project: projectWire(status),
    matter_profile: profileWire(
      kind === "classification_required" ? null : "transaction",
    ),
    profile_state: kind,
    capabilities:
      lifecycleCapabilities ??
      capabilities(
        kind === "classification_required" ? "classify" : "edit",
        "policy_gate_closed",
      ),
  };
}

test("Matter wire accepts the three truthful profile states and broad taxonomy", () => {
  assert.deepEqual(VERA_WORKSPACE_TYPES, [
    "general_legal",
    "transaction",
    "dispute",
    "investigation",
    "compliance",
    "research",
  ]);
  for (const state of [
    "absent",
    "classification_required",
    "ready",
  ] as const) {
    const parsed = parseVeraMatterWire(matterWire(state));
    assert.equal(parsed.profile_state, state);
  }
  for (const lifecycle of ["archived", "deleted"] as const) {
    for (const state of [
      "absent",
      "classification_required",
      "ready",
    ] as const) {
      const readOnly = parseVeraMatterWire(matterWire(state, lifecycle));
      assert.equal(readOnly.profile_state, state);
      assert.equal(readOnly.capabilities.matter_profile, "unavailable");
      assert.equal(readOnly.capabilities.assistant, "unavailable");
    }
  }
  assert.equal(
    parseVeraMatterPageWire({
      items: [matterWire("ready")],
      next_cursor: "bmV4dA",
    }).items[0]?.project.tabular_review_count,
    2,
  );
});

test("Matter wire fails closed on old litigation fields and capability drift", () => {
  assert.throws(() =>
    parseVeraMatterWire({
      ...matterWire("ready"),
      matter_profile: {
        ...profileWire(),
        matter_type: "civil_litigation",
      },
    }),
  );
  assert.throws(() =>
    parseVeraMatterWire({
      ...matterWire("ready", "archived"),
      capabilities: capabilities("edit", "policy_gate_closed"),
    }),
  );
  assert.throws(() =>
    parseVeraMatterWire({
      ...matterWire("ready"),
      capabilities: capabilities("unavailable", "unavailable"),
    }),
  );
  assert.throws(() =>
    parseVeraMatterWire({
      ...matterWire("ready"),
      project: {
        ...projectWire(),
        review_count: 2,
      },
    }),
  );
  assert.throws(() =>
    parseVeraMatterWire({
      ...matterWire("ready"),
      capabilities: {
        ...capabilities("edit", "available"),
        assistant: "workspace_compatibility",
      },
    }),
  );
  assert.throws(() =>
    parseVeraMatterWire({
      ...matterWire("classification_required"),
      profile_state: "ready",
    }),
  );
  assert.throws(() =>
    parseVeraMatterPageWire({ items: [], next_cursor: "unsafe/cursor" }),
  );
});

test("Matter mutations reject unbounded, unknown, and unclassified input before transport", async () => {
  await assert.rejects(
    createVeraMatter({
      workspace_type: "general_legal",
    } as never),
  );
  await assert.rejects(
    createVeraMatter({
      name: "Unclassified",
      workspace_type: "legacy" as never,
    }),
  );
  await assert.rejects(
    createVeraMatter({
      name: " padded ",
      workspace_type: "general_legal",
    }),
  );
  await assert.rejects(
    createVeraMatterProfile(
      PROJECT_ID,
      {
        workspace_type: "general_legal",
        objective: `x${"y".repeat(16_384)}`,
      },
    ),
  );
  await assert.rejects(updateVeraMatterProfile(PROJECT_ID, {}));
  await assert.rejects(
    updateVeraMatterProfile(PROJECT_ID, { objective: undefined }),
  );
  await assert.rejects(
    updateVeraMatterProfile(PROJECT_ID, {
      workspace_type: "research",
      unknown: true,
    } as never),
  );
  await assert.rejects(updateVeraMatter(PROJECT_ID, {}));
  await assert.rejects(
    updateVeraMatter(PROJECT_ID, {
      project: { name: " padded " },
    }),
  );
  await assert.rejects(
    updateVeraMatter(PROJECT_ID, {
      matter_profile: { workspace_type: "research" },
    } as never),
  );
  await assert.rejects(
    updateVeraMatterPolicy(PROJECT_ID, {
      external_egress_mode: "allowed_by_policy",
      execution_locations: ["local", "local"],
      allow_external_legal_sources: false,
      allow_word_bridge: false,
    }),
  );
});

test("Matter Policy wire is exact, declared, and fails closed", () => {
  const policy = {
    project_id: PROJECT_ID,
    external_egress_mode: "approval",
    execution_locations: ["local", "firm_private"],
    allow_external_legal_sources: false,
    allow_word_bridge: true,
    created_at: NOW,
    updated_at: NOW,
  };
  assert.equal(parseVeraMatterPolicyWire(policy).external_egress_mode, "approval");
  assert.throws(() =>
    parseVeraMatterPolicyWire({
      ...policy,
      execution_locations: ["localhost"],
    }),
  );
  assert.throws(() =>
    parseVeraMatterPolicyWire({
      ...policy,
      execution_locations: ["local", "local"],
    }),
  );
  assert.throws(() => parseVeraMatterPolicyWire({ ...policy, inferred: true }));
});

test("Gate 1 IA preserves deep links while exposing only truthful Matter surfaces", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const read = (relative: string) =>
    readFile(path.join(root, relative), "utf8");
  const [sidebar, navigation, shell, routes, projectWorkspace, list, detail, modal, settingsSource, api, config, mattersPage, matterLayout, matterSettingsPage, matterWorkflow, workflowList, workflowEditor, workflowRunPanel, tabularReview] =
    await Promise.all([
      read("src/app/components/vera-shell/VeraSidebar.tsx"),
      read("src/features/matter-overview/MatterNavigation.tsx"),
      read("src/features/matter-overview/MatterWorkspaceShell.tsx"),
      read("src/app/components/projects/WorkspaceRouteAdapter.tsx"),
      read("src/app/components/projects/ProjectWorkspace.tsx"),
      read("src/features/matter-overview/MattersOverview.tsx"),
      read("src/features/matter-overview/MatterWorkspaceOverview.tsx"),
      read("src/features/matter-overview/MatterProfileModal.tsx"),
      read("src/features/matter-overview/MatterSettings.tsx"),
      read("src/app/lib/veraMatterApi.ts"),
      read("next.config.ts"),
      read("src/app/(pages)/matters/page.tsx"),
      read("src/app/(pages)/matters/[id]/layout.tsx"),
      read("src/app/(pages)/matters/[id]/settings/page.tsx"),
      read("src/app/(pages)/matters/[id]/workflows/[workflowId]/page.tsx"),
      read("src/app/components/workflows/VeraWorkflowList.tsx"),
      read("src/app/components/workflows/VeraWorkflowEditor.tsx"),
      read("src/app/components/workflows/VeraWorkflowRunPanel.tsx"),
      read("src/app/components/tabular/TabularReviewView.tsx"),
    ]);

  const assistant = sidebar.indexOf('labelKey: "nav.assistant"');
  const matters = sidebar.indexOf('labelKey: "nav.matters"');
  const workflows = sidebar.indexOf('labelKey: "nav.workflows"');
  const review = sidebar.indexOf('labelKey: "nav.review"');
  const settings = sidebar.indexOf('labelKey: "nav.settings"');
  assert.ok(
    assistant < matters && matters < workflows && workflows < review && review < settings,
  );
  assert.match(sidebar, /href: null, labelKey: "nav\.review"/);
  assert.doesNotMatch(sidebar, /labelKey: "nav\.(?:projects|tabular)"/);
  assert.match(sidebar, /pathname\.startsWith\("\/projects\/"\)/);

  assert.match(config, /source: "\/projects"[\s\S]*destination: "\/matters"/);
  assert.match(mattersPage, /<MattersOverview \/>/);
  assert.match(navigation, /const base = `\/matters\/\$\{projectId\}`/);
  assert.doesNotMatch(navigation, /\/projects\//);
  assert.match(navigation, /capabilities\.assistant === "available"/);
  assert.match(navigation, /capabilities\.tabular === "available"/);
  assert.match(navigation, /capabilities\.workflows === "non_inference_only"/);
  assert.match(navigation, /matterCapabilityReasonKey\(capabilities\.assistant\)/);
  assert.match(navigation, /matterCapabilityReasonKey\(capabilities\.tabular\)/);
  assert.match(navigation, /matterCapabilityReasonKey\(capabilities\.workflows\)/);
  assert.match(navigation, /matters\.capabilities\.tabularCompatibilityLabel/);
  assert.match(navigation, /matters\.capabilities\.inferenceStatus/);
  assert.match(shell, /matterCapabilityTitleKey/);
  assert.match(shell, /matterCapabilityReasonKey/);
  assert.match(navigation, /matters\.navigation\.review/);
  assert.match(navigation, /matters\.navigation\.drafts/);
  assert.match(navigation, /matters\.navigation\.settings/);
  assert.match(navigation, /disabled[\s\S]*aria-disabled="true"/);
  assert.match(matterLayout, /<MatterWorkspaceShell params=\{params\}>/);
  assert.match(shell, /WorkspaceRouteProvider adapter=\{MATTER_WORKSPACE_ROUTES\}/);
  assert.match(shell, /<ProjectWorkspaceProvider projectId=\{id\}>/);
  assert.match(projectWorkspace, /routes\.kind === "matter"/);
  assert.match(projectWorkspace, /if \(!actions\) return null/);
  assert.match(projectWorkspace, /\{actions\}/);
  assert.match(shell, /MatterCapabilityBoundary/);
  assert.match(routes, /documentsHref: \(projectId\) => `\/matters\/\$\{projectId\}\/documents`/);
  assert.match(routes, /tabularReviewsHref: \(projectId\) => `\/matters\/\$\{projectId\}\/review`/);
  assert.match(matterWorkflow, /executionConstraint=\{executionConstraint\}/);
  assert.match(workflowEditor, /definition\.steps\.some\(\(step\) => step\.type === "prompt"\)/);
  assert.match(workflowRunPanel, /executionConstraint === "non_inference_only" && hasPromptStep/);
  assert.match(workflowRunPanel, /settingsLoadState !== "ready"/);
  assert.match(workflowRunPanel, /readyModels\.some\(\(model\) => model\.id === selectedModelId\)/);
  assert.match(workflowList, /routes\.workflowHref\(projectId, created\.id\)/);
  assert.match(workflowEditor, /router\.(?:push|replace)\(workflowsHref\)/);
  assert.match(workflowRunPanel, /routes\.documentStudioHref\(draft\.project_id, draft\.document_id\)/);
  assert.match(tabularReview, /routes\.tabularReviewHref\(updated\.project_id, reviewId\)/);
  assert.match(tabularReview, /routes\.tabularReviewsHref\(projectId\)/);
  assert.doesNotMatch(
    `${workflowList}\n${workflowEditor}\n${workflowRunPanel}\n${tabularReview}`,
    /`\/projects\/\$\{[^`]+(?:documents|tabular-reviews)/,
  );
  assert.match(matterSettingsPage, /MatterCapabilityBoundary capability="matter_profile"/);
  assert.match(settingsSource, /await updateVeraMatter\(matter\.project\.id, pendingMatterUpdate\)/);
  assert.match(settingsSource, /setMatter\(saved\)/);
  assert.match(settingsSource, /await updateVeraMatterPolicy\(matter\.project\.id, policyDraft\)/);
  assert.match(settingsSource, /cause instanceof VeraApiError && cause\.status === 404/);
  assert.match(settingsSource, /external_egress_mode: "disabled"/);
  assert.match(settingsSource, /execution_locations: \[\]/);
  assert.match(settingsSource, /setPolicyDraft\(\{ \.\.\.MISSING_POLICY_DRAFT \}\)/);
  assert.match(settingsSource, /policyMissing \|\|/);
  assert.match(settingsSource, /setPolicyMissing\(false\)/);
  assert.match(settingsSource, /matters\.settings\.policyMissing/);
  assert.match(settingsSource, /href="\/settings\/models"/);
  assert.doesNotMatch(settingsSource, /updateVeraMatter[\s\S]*updateVeraMatterPolicy[\s\S]*Promise\.all/);
  assert.match(api, /const MATTER_UPDATE_KEYS = \["project", "profile"\]/);
  assert.doesNotMatch(api, /MATTER_UPDATE_KEYS = [^\n]*matter_profile/);

  assert.match(list, /profile_state: "profiled"/);
  assert.match(list, /profile_state: "absent"/);
  assert.match(list, /profiledCursor/);
  assert.match(list, /genericCursor/);
  assert.match(list, /reconcileMatterStreams/);
  assert.match(list, /incomingProfiled/);
  assert.match(list, /incomingAbsent/);
  assert.match(
    list,
    /mode:\s*action === "create" \? "create-profile" : "edit-profile"/,
  );
  assert.match(detail, /capabilities\.assistant === "policy_gate_closed"/);
  assert.match(detail, /capabilities\.matter_profile !== "unavailable"/);
  assert.match(detail, /capabilities\.assistant === "unavailable"/);
  assert.match(list, /action === "unavailable"/);
  assert.match(detail, /project\.tabular_review_count/);
  assert.match(modal, /workspace_type: form\.workspaceType/);
  assert.match(api, /veraApiRequest<unknown>\("\/matters"/);

  const gateOneSources = `${navigation}\n${list}\n${detail}\n${modal}\n${api}`;
  assert.doesNotMatch(
    gateOneSources,
    /\b(?:matter_type|counterparty|court|case_number|risk_level|opened_at|closed_at|review_count)\b/,
  );
  assert.doesNotMatch(
    gateOneSources,
    /next best action|deadline|research result|unified review count/i,
  );
});
