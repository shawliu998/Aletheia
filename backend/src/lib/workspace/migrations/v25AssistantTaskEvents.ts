import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const MAX_ATTEMPTS = 100;
const MAX_EVENT_CHARACTERS = 250_000;
const MAX_EVENT_SEQUENCE = 2_147_483_647;

const EVENT_TYPES = [
  "chat_id",
  "status",
  "content_delta",
  "content_done",
  "reasoning_delta",
  "reasoning_block_end",
  "task_plan",
  "task_step_update",
  "tool_call_start",
  "doc_read_start",
  "doc_read",
  "doc_find_start",
  "doc_find",
  "workflow_applied",
  "citation_data",
  "draft_created",
  "tabular_review_created",
  "complete",
  "error",
] as const;

const sqlStrings = (values: readonly string[]) =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");

const CREATE_EVENT_TABLE = `
CREATE TABLE assistant_generation_events_v25 (
  job_id TEXT NOT NULL
    CHECK (
      typeof(job_id) = 'text' AND length(trim(job_id)) BETWEEN 1 AND 200 AND
      instr(job_id, char(0)) = 0
    )
    REFERENCES assistant_generation_snapshots(job_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL
    CHECK (
      typeof(sequence) = 'integer' AND
      sequence BETWEEN 1 AND ${MAX_EVENT_SEQUENCE}
    ),
  attempt INTEGER NOT NULL
    CHECK (
      typeof(attempt) = 'integer' AND
      attempt BETWEEN 1 AND ${MAX_ATTEMPTS}
    ),
  event_type TEXT NOT NULL
    CHECK (
      typeof(event_type) = 'text' AND
      event_type IN (${sqlStrings(EVENT_TYPES)})
    ),
  event_json TEXT NOT NULL
    CHECK (
      typeof(event_json) = 'text' AND
      length(event_json) BETWEEN 2 AND ${MAX_EVENT_CHARACTERS} AND
      json_valid(event_json) AND
      json_type(event_json) = 'object' AND
      json_type(event_json, '$.type') = 'text' AND
      json_extract(event_json, '$.type') = event_type
    ),
  terminal INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(terminal) = 'integer' AND terminal IN (0, 1)),
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text' AND length(created_at) = 24 AND
    created_at GLOB
      '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  PRIMARY KEY (job_id, sequence),
  CHECK (
    (terminal = 0 AND event_type NOT IN ('complete', 'error')) OR
    (terminal = 1 AND event_type IN ('complete', 'error'))
  )
) WITHOUT ROWID;
`;

const EVENT_INDEXES_AND_TRIGGER = `
CREATE INDEX idx_assistant_generation_events_attempt
  ON assistant_generation_events(job_id, attempt, sequence);

CREATE UNIQUE INDEX idx_assistant_generation_events_terminal
  ON assistant_generation_events(job_id, attempt)
  WHERE terminal = 1;

CREATE TRIGGER assistant_generation_events_immutable
BEFORE UPDATE ON assistant_generation_events
BEGIN
  SELECT RAISE(ABORT, 'assistant generation events are immutable');
END;
`;

function requiredSql(
  database: WorkspaceDatabaseAdapter,
  type: "table" | "index" | "trigger",
  name: string,
) {
  const row = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type=? AND name=?")
    .get(type, name);
  if (typeof row?.sql !== "string" || row.sql.trim().length === 0) {
    throw new Error(`Workspace schema v25 requires the intact ${name}.`);
  }
  return row.sql;
}

function apply(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  if (!capabilities.jsonTextChecks) {
    throw new Error("Workspace schema v25 requires SQLite JSON1.");
  }
  const currentSql = requiredSql(
    database,
    "table",
    "assistant_generation_events",
  );
  for (const requiredType of ["'draft_created'", "'tabular_review_created'"]) {
    if (!currentSql.includes(requiredType)) {
      throw new Error(
        "Workspace schema v25 refuses a non-v24 Assistant event table.",
      );
    }
  }
  for (const requiredObject of [
    ["index", "idx_assistant_generation_events_attempt"],
    ["index", "idx_assistant_generation_events_terminal"],
    ["trigger", "assistant_generation_events_immutable"],
  ] as const) {
    requiredSql(database, requiredObject[0], requiredObject[1]);
  }

  const eventCount = Number(
    database
      .prepare("SELECT count(*) AS count FROM assistant_generation_events")
      .get()?.count ?? 0,
  );
  database.exec(CREATE_EVENT_TABLE);
  database.exec(
    `INSERT INTO assistant_generation_events_v25
       (job_id,sequence,attempt,event_type,event_json,terminal,created_at)
     SELECT job_id,sequence,attempt,event_type,event_json,terminal,created_at
       FROM assistant_generation_events`,
  );
  database.exec("DROP TABLE assistant_generation_events");
  database.exec(
    "ALTER TABLE assistant_generation_events_v25 RENAME TO assistant_generation_events",
  );
  database.exec(EVENT_INDEXES_AND_TRIGGER);

  const installedSql = requiredSql(
    database,
    "table",
    "assistant_generation_events",
  );
  const migratedCount = Number(
    database
      .prepare("SELECT count(*) AS count FROM assistant_generation_events")
      .get()?.count ?? -1,
  );
  if (
    migratedCount !== eventCount ||
    !installedSql.includes("'task_plan'") ||
    !installedSql.includes("'task_step_update'") ||
    !installedSql.includes("json_extract(event_json, '$.type') = event_type") ||
    !installedSql.includes("instr(job_id, char(0)) = 0") ||
    !installedSql.includes(
      "strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at",
    )
  ) {
    throw new Error(
      "Workspace schema v25 did not preserve strict Assistant event durability constraints.",
    );
  }
}

export const ASSISTANT_TASK_EVENTS_V25_MIGRATION: WorkspaceMigration = {
  version: 25,
  name: "assistant_task_events",
  checksumMaterial: [
    "workspace-migration-v25",
    "lossless-assistant-generation-events-only-rebuild",
    "add-only-task-plan-and-task-step-update-event-types",
    CREATE_EVENT_TABLE,
    EVENT_INDEXES_AND_TRIGGER,
  ].join("\n-- checksum boundary --\n"),
  apply,
};
