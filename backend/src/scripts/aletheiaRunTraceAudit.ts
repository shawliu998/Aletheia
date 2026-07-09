import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

type RunTraceCheck = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  detail: string;
};

const RUNTIME_TABLES = [
  "aletheia_agent_runs",
  "aletheia_agent_steps",
  "aletheia_tool_calls",
  "aletheia_human_checkpoints",
];

function repoRoot() {
  return path.resolve(process.cwd(), "..");
}

function readText(root: string, relativePath: string) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

function fileExists(root: string, relativePath: string) {
  return existsSync(path.join(root, relativePath));
}

function hasAll(source: string, values: string[]) {
  return values.every((value) => source.includes(value));
}

function check(
  id: string,
  ok: boolean,
  detail: string,
  severity: "critical" | "warning" = "critical",
): RunTraceCheck {
  return { id, ok, severity, detail };
}

function main() {
  const root = repoRoot();
  const domain = readText(root, "backend/src/lib/aletheia/domain.ts");
  const localRepository = readText(
    root,
    "backend/src/lib/aletheia/localRepository.ts",
  );
  const supabaseRepository = readText(
    root,
    "backend/src/lib/aletheia/supabaseRepository.ts",
  );
  const runtimeMigration = readText(
    root,
    "backend/migrations/20260708_02_aletheia_agent_runtime.sql",
  );
  const budgetPolicyMigration = readText(
    root,
    "backend/migrations/20260709_01_aletheia_agent_budget_policy.sql",
  );
  const localRegression = readText(
    root,
    "backend/src/scripts/aletheiaLocalRegression.ts",
  );
  const runTraceUi = readText(
    root,
    "frontend/src/aletheia/RemoteMatterRunTrace.tsx",
  );
  const docs = [
    "README.md",
    "docs/status.md",
    "docs/architecture.md",
    "docs/local_first_runtime.md",
    "docs/agent_runtime_roadmap.md",
    "docs/demo_evidence.md",
    "docs/release_notes_local_first_mvp.md",
  ]
    .filter((file) => fileExists(root, file))
    .map((file) => readText(root, file))
    .join("\n");

  const checks: RunTraceCheck[] = [
    check(
      "domain-run-trace-scaffold",
      hasAll(domain, [
        "buildAgentRunTraceScaffold",
        "buildAgentWorkflowGraph",
        "parse_documents",
        "search_evidence",
        "build_issue_map",
        "build_evidence_matrix",
        "draft_memo",
        "human_review",
        "audit_export_gate",
        "final_memo_review",
        "Intake Parser",
        "Evidence Mapper",
        "Memo Drafter",
        "Risk Reviewer",
        "Export Controller",
      ]),
      "Domain runtime scaffold must retain ordered professional steps, bounded specialist roles, and a human review checkpoint.",
    ),
    check(
      "workflow-graph-controls",
      hasAll(domain, [
        'schemaVersion: "aletheia-workflow-graph-v0"',
        'graphType: "directed_runtime_trace"',
        'defaultToolPolicy: "allowlist_per_step"',
        'externalNetworkDefault: "disabled"',
        'destructiveActionsDefault: "disabled"',
        "humanApprovalRequiredFor",
        "final_memo_export",
        "audit_pack_export",
        "feedback_dataset_export",
        "playbook_update",
        "external_source_use",
      ]),
      "Workflow Graph metadata must expose least-privilege tool policy and approval-gated high-risk actions.",
    ),
    check(
      "local-runtime-tables",
      hasAll(localRepository, RUNTIME_TABLES) &&
        hasAll(localRepository, [
          "budget text not null default '{}'",
          "metrics text not null default '{}'",
          "createAgentRun(",
          "resumeAgentRun(",
          "requestApproval(",
          "decideApproval(",
          "workflowGraphWithResumeNode",
          "createAgentRunTraceScaffold",
        ]),
      "Local SQLite repository must persist runs, steps, tool calls, checkpoints, budgets, metrics, approvals, and resume nodes.",
    ),
    check(
      "supabase-runtime-boundary",
      hasAll(supabaseRepository, RUNTIME_TABLES) &&
        hasAll(supabaseRepository, [
          "buildAgentRunTraceScaffold",
          "buildAgentWorkflowGraph",
          "createAgentRun(",
          "resumeAgentRun(",
          "requestApproval(",
          "decideApproval(",
          "createAgentRunTraceScaffold",
          "budget: defaultRunBudget(input.budget)",
          "metrics:",
        ]),
      "Supabase compatibility adapter must expose the same AgentRun, approval, budget, and metrics contract.",
    ),
    check(
      "runtime-migrations",
      hasAll(runtimeMigration, RUNTIME_TABLES) &&
        hasAll(runtimeMigration, [
          "enable row level security",
          "owner_write",
          "visible",
          "metadata jsonb",
          "input jsonb",
          "output jsonb",
        ]) &&
        hasAll(budgetPolicyMigration, [
          "budget",
          "metrics",
          "approved",
          "edited",
          "responded",
        ]),
      "Postgres migrations must create runtime tables with RLS plus budget, metrics, and expanded checkpoint decisions.",
    ),
    check(
      "local-regression-run-trace",
      hasAll(localRegression, [
        "Agent run should include trace steps",
        "Agent run should persist budget",
        "Agent steps should expose metrics",
        "Tool calls should expose metrics",
        "Workflow graph should expose allowlist tool policy",
        "Workflow graph should mark audit export as approval-gated",
        "Resumed run should append a resume step",
        "Resumed workflow graph should include resume node",
        "Resumed workflow graph should return to human review",
      ]),
      "Local regression must exercise trace persistence, budgets, metrics, tool allowlists, workflow graph controls, and resume behavior.",
    ),
    check(
      "run-trace-ui",
      hasAll(runTraceUi, [
        "Run Trace",
        "Workflow Graph",
        "Human checkpoints",
        "Tool calls",
        "budgetValue",
        "metricNumber",
        "workflowGraphFromRun",
        "onResumeAgentRun",
      ]),
      "Remote matter UI must render Run Trace budgets, metrics, workflow graph, tool calls, checkpoints, and resume actions.",
    ),
    check(
      "docs-run-trace-posture",
      hasAll(docs, [
        "Run Trace",
        "Workflow Graph",
        "human checkpoints",
        "tool calls",
        "approval",
        "npm run check:aletheia:run-trace",
      ]),
      "Docs must explain Run Trace posture and list the run-trace audit command.",
    ),
  ];

  const failedCritical = checks.filter(
    (entry) => !entry.ok && entry.severity === "critical",
  );
  const warnings = checks.filter(
    (entry) => !entry.ok && entry.severity === "warning",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: failedCritical.length === 0,
        suite: "aletheia-run-trace-audit-v0",
        checkedAt: new Date().toISOString(),
        runtimeTables: RUNTIME_TABLES,
        runtimeContract: [
          "AgentRun",
          "AgentStep",
          "ToolCall",
          "HumanCheckpoint",
          "WorkflowGraph",
          "approval-gated exports",
          "resumable human checkpoints",
        ],
        warnings: warnings.length,
        checks,
      },
      null,
      2,
    )}\n`,
  );

  if (failedCritical.length > 0) {
    process.exitCode = 1;
  }
}

main();
