import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";
import { ASSISTANT_ACTION_LEDGER_V19_MIGRATION } from "./v19AssistantActionLedger";

const ACTION_COLUMNS =
  "job_id,action_key,action_type,project_id,input_sha256,status," +
  "reserved_attempt,reserved_lease_owner,completed_attempt,completed_lease_owner," +
  "resource_type,resource_id,created_at,updated_at,completed_at";

const ACTION_TYPE_BEFORE =
  "action_type IN ('create_draft', 'suggest_draft_edit', 'run_workflow', 'run_contract_review')";
const V19_ACTION_TYPE_BEFORE =
  "action_type IN ('create_draft', 'suggest_draft_edit', 'run_workflow')";
const ACTION_TYPE_AFTER =
  "action_type IN ('create_draft', 'suggest_draft_edit', 'run_workflow', 'run_contract_review', 'run_custom_extraction')";
const ACTION_BINDING_BEFORE =
  "(action_type = 'run_contract_review' AND resource_type = 'tabular_review')";
const ACTION_BINDING_AFTER =
  "(action_type = 'run_contract_review' AND resource_type = 'tabular_review') OR\n    (action_type = 'run_custom_extraction' AND resource_type = 'tabular_review')";
const ACTION_BUDGET_BEFORE = "WHEN 'run_contract_review' THEN 1\n  END";
const ACTION_BUDGET_AFTER =
  "WHEN 'run_contract_review' THEN 1\n    WHEN 'run_custom_extraction' THEN 2\n  END";
const V19_RESOURCE_BEFORE =
  "resource_type IN ('draft', 'draft_suggestion', 'workflow_run')";
const V24_RESOURCE_AFTER =
  "resource_type IN ('draft', 'draft_suggestion', 'workflow_run', 'tabular_review')";
const V19_BINDING_BEFORE =
  "(action_type = 'run_workflow' AND resource_type = 'workflow_run')";
const V24_BINDING_AFTER =
  "(action_type = 'run_workflow' AND resource_type = 'workflow_run') OR\n    (action_type = 'run_contract_review' AND resource_type = 'tabular_review')";
const V19_BUDGET_BEFORE = "WHEN 'run_workflow' THEN 2\n  END";
const V24_BUDGET_AFTER =
  "WHEN 'run_workflow' THEN 2\n    WHEN 'run_contract_review' THEN 1\n  END";

function requiredSql(
  database: WorkspaceDatabaseAdapter,
  type: "table" | "index" | "trigger",
  name: string,
) {
  const row = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type=? AND name=?")
    .get(type, name);
  if (typeof row?.sql !== "string" || row.sql.trim().length === 0) {
    throw new Error(`Workspace schema v26 requires the intact ${name}.`);
  }
  return row.sql;
}

function replaceOnce(
  source: string,
  before: string,
  after: string,
  name: string,
) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Workspace schema v26 cannot safely transform ${name}.`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

function normalizedSql(value: string) {
  return value.trim().replace(/;$/, "").trim();
}

function canonicalV19Sql(pattern: RegExp, name: string) {
  const match =
    ASSISTANT_ACTION_LEDGER_V19_MIGRATION.checksumMaterial.match(pattern);
  if (!match?.[0]) {
    throw new Error(`Workspace schema v26 is missing canonical v19 ${name}.`);
  }
  return match[1] ?? match[0];
}

function assertCanonicalLiveSql(
  database: WorkspaceDatabaseAdapter,
  type: "table" | "index" | "trigger",
  name: string,
  canonical: string,
) {
  if (
    normalizedSql(requiredSql(database, type, name)) !==
    normalizedSql(canonical)
  ) {
    throw new Error(
      `Workspace schema v26 refuses non-canonical live definition for ${name}.`,
    );
  }
}

function canonicalV24ActionTable() {
  let table = canonicalV19Sql(
    /CREATE TABLE assistant_action_ledger \([\s\S]*?\) WITHOUT ROWID;/,
    "Assistant action table",
  );
  table = replaceOnce(
    table,
    V19_ACTION_TYPE_BEFORE,
    ACTION_TYPE_BEFORE,
    "v24 action type CHECK",
  );
  table = replaceOnce(
    table,
    V19_RESOURCE_BEFORE,
    V24_RESOURCE_AFTER,
    "v24 action resource CHECK",
  );
  table = replaceOnce(
    table,
    V19_BINDING_BEFORE,
    V24_BINDING_AFTER,
    "v24 action resource binding CHECK",
  );
  // v24 creates a temporary table and renames it. SQLite persists the
  // renamed root table with quoted identifier syntax in sqlite_schema.
  return replaceOnce(
    table,
    "CREATE TABLE assistant_action_ledger",
    'CREATE TABLE "assistant_action_ledger"',
    "v24 renamed Assistant action table",
  );
}

function canonicalV24InsertTrigger() {
  let trigger = canonicalV19Sql(
    /(CREATE TRIGGER assistant_action_ledger_v19_insert_guard[\s\S]*?\nEND;)\n\nCREATE TRIGGER assistant_action_ledger_v19_update_guard/,
    "Assistant action insert trigger",
  );
  trigger = replaceOnce(
    trigger,
    V19_BUDGET_BEFORE,
    V24_BUDGET_AFTER,
    "v24 action budget trigger",
  );
  return trigger;
}

function apply(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  if (!capabilities.jsonTextChecks) {
    throw new Error("Workspace schema v26 requires SQLite JSON1.");
  }
  const actionCount = Number(
    database
      .prepare("SELECT count(*) AS count FROM assistant_action_ledger")
      .get()?.count ?? 0,
  );
  const actionTable = canonicalV24ActionTable();
  const budgetIndex = canonicalV19Sql(
    /CREATE INDEX idx_assistant_action_ledger_budget[\s\S]*?;/,
    "Assistant action budget index",
  );
  const resourceIndex = canonicalV19Sql(
    /CREATE INDEX idx_assistant_action_ledger_resource[\s\S]*?;/,
    "Assistant action resource index",
  );
  const insertTrigger = canonicalV24InsertTrigger();
  const updateTrigger = canonicalV19Sql(
    /(CREATE TRIGGER assistant_action_ledger_v19_update_guard[\s\S]*?\nEND;)(?:\n-- checksum boundary --|\n?$)/,
    "Assistant action update trigger",
  );
  for (const [type, name, canonical] of [
    ["table", "assistant_action_ledger", actionTable],
    ["index", "idx_assistant_action_ledger_budget", budgetIndex],
    ["index", "idx_assistant_action_ledger_resource", resourceIndex],
    ["trigger", "assistant_action_ledger_v19_insert_guard", insertTrigger],
    ["trigger", "assistant_action_ledger_v19_update_guard", updateTrigger],
  ] as const) {
    assertCanonicalLiveSql(database, type, name, canonical);
  }

  let rebuiltTable = replaceOnce(
    actionTable,
    'CREATE TABLE "assistant_action_ledger"',
    "CREATE TABLE assistant_action_ledger_v26",
    "Assistant action table name",
  );
  rebuiltTable = replaceOnce(
    rebuiltTable,
    ACTION_TYPE_BEFORE,
    ACTION_TYPE_AFTER,
    "Assistant action type CHECK",
  );
  rebuiltTable = replaceOnce(
    rebuiltTable,
    ACTION_BINDING_BEFORE,
    ACTION_BINDING_AFTER,
    "Assistant action resource binding CHECK",
  );
  const rebuiltInsertTrigger = replaceOnce(
    insertTrigger,
    ACTION_BUDGET_BEFORE,
    ACTION_BUDGET_AFTER,
    "Assistant action budget trigger",
  );

  database.exec(rebuiltTable);
  database.exec(
    `INSERT INTO assistant_action_ledger_v26 (${ACTION_COLUMNS}) ` +
      `SELECT ${ACTION_COLUMNS} FROM assistant_action_ledger`,
  );
  database.exec("DROP TABLE assistant_action_ledger");
  database.exec(
    "ALTER TABLE assistant_action_ledger_v26 RENAME TO assistant_action_ledger",
  );
  database.exec(budgetIndex);
  database.exec(resourceIndex);
  database.exec(rebuiltInsertTrigger);
  database.exec(updateTrigger);

  const installed = requiredSql(database, "table", "assistant_action_ledger");
  const migratedCount = Number(
    database
      .prepare("SELECT count(*) AS count FROM assistant_action_ledger")
      .get()?.count ?? -1,
  );
  const installedBudget = requiredSql(
    database,
    "trigger",
    "assistant_action_ledger_v19_insert_guard",
  );
  if (
    migratedCount !== actionCount ||
    !installed.includes("'run_custom_extraction'") ||
    !installed.includes(ACTION_BINDING_AFTER) ||
    !installedBudget.includes("WHEN 'run_custom_extraction' THEN 2") ||
    !installed.includes("instr(action_key, char(0)) = 0") ||
    !installed.includes(
      "strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at",
    )
  ) {
    throw new Error(
      "Workspace schema v26 did not preserve strict Assistant action durability constraints.",
    );
  }
}

export const ASSISTANT_CUSTOM_EXTRACTION_V26_MIGRATION: WorkspaceMigration = {
  version: 26,
  name: "assistant_custom_extraction",
  checksumMaterial: [
    "workspace-migration-v26",
    "lossless-v24-assistant-action-ledger-rebuild",
    "add-run-custom-extraction-tabular-review-action-binding",
    "custom-extraction-action-budget-two-matches-runtime-tool-budget",
    "canonical-v24-action-table-and-index-trigger-precondition-derived-from-v19-checksum",
    ASSISTANT_ACTION_LEDGER_V19_MIGRATION.checksumMaterial,
    ACTION_TYPE_BEFORE,
    ACTION_TYPE_AFTER,
    ACTION_BINDING_BEFORE,
    ACTION_BINDING_AFTER,
    ACTION_BUDGET_BEFORE,
    ACTION_BUDGET_AFTER,
  ].join("\n-- checksum boundary --\n"),
  apply,
};
