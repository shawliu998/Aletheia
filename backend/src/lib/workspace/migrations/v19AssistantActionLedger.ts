import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const MAX_ATTEMPTS = 100;
const MAX_EVENT_CHARACTERS = 250_000;
const MAX_EVENT_SEQUENCE = 2_147_483_647;

const ASSISTANT_DRAFT_EVENT_V19_SQL = `
DROP TRIGGER assistant_generation_events_immutable;
ALTER TABLE assistant_generation_events
  RENAME TO assistant_generation_events_v10;

CREATE TABLE assistant_generation_events (
  job_id TEXT NOT NULL
    CHECK (typeof(job_id) = 'text' AND length(trim(job_id)) >= 1)
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
      event_type IN (
        'chat_id', 'status', 'content_delta', 'content_done',
        'reasoning_delta', 'reasoning_block_end', 'tool_call_start',
        'doc_read_start', 'doc_read', 'doc_find_start', 'doc_find',
        'workflow_applied', 'citation_data', 'draft_created', 'complete', 'error'
      )
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
  created_at TEXT NOT NULL
    CHECK (
      typeof(created_at) = 'text' AND
      length(created_at) = 24 AND
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

INSERT INTO assistant_generation_events
  (job_id,sequence,attempt,event_type,event_json,terminal,created_at)
SELECT job_id,sequence,attempt,event_type,event_json,terminal,created_at
  FROM assistant_generation_events_v10;

DROP TABLE assistant_generation_events_v10;

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

const ASSISTANT_ACTION_LEDGER_V19_SQL = `
CREATE TABLE assistant_action_ledger (
  job_id TEXT NOT NULL
    CHECK (
      typeof(job_id) = 'text' AND length(trim(job_id)) BETWEEN 1 AND 200 AND
      instr(job_id, char(0)) = 0
    )
    REFERENCES assistant_generation_snapshots(job_id) ON DELETE CASCADE,
  action_key TEXT NOT NULL
    CHECK (
      typeof(action_key) = 'text' AND
      length(action_key) BETWEEN 1 AND 240 AND
      action_key = trim(action_key) AND
      instr(action_key, char(0)) = 0
    ),
  action_type TEXT NOT NULL
    CHECK (
      typeof(action_type) = 'text' AND
      action_type IN ('create_draft', 'suggest_draft_edit', 'run_workflow')
    ),
  project_id TEXT NOT NULL
    CHECK (
      typeof(project_id) = 'text' AND
      length(trim(project_id)) BETWEEN 1 AND 200 AND
      instr(project_id, char(0)) = 0
    )
    REFERENCES projects(id),
  input_sha256 TEXT NOT NULL
    CHECK (
      typeof(input_sha256) = 'text' AND
      length(input_sha256) = 64 AND
      input_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (typeof(status) = 'text' AND status IN ('reserved', 'complete')),
  reserved_attempt INTEGER NOT NULL
    CHECK (
      typeof(reserved_attempt) = 'integer' AND
      reserved_attempt BETWEEN 1 AND ${MAX_ATTEMPTS}
    ),
  reserved_lease_owner TEXT NOT NULL
    CHECK (
      typeof(reserved_lease_owner) = 'text' AND
      length(trim(reserved_lease_owner)) BETWEEN 1 AND 240 AND
      reserved_lease_owner = trim(reserved_lease_owner) AND
      instr(reserved_lease_owner, char(0)) = 0
    ),
  completed_attempt INTEGER
    CHECK (
      completed_attempt IS NULL OR (
        typeof(completed_attempt) = 'integer' AND
        completed_attempt BETWEEN reserved_attempt AND ${MAX_ATTEMPTS}
      )
    ),
  completed_lease_owner TEXT
    CHECK (
      completed_lease_owner IS NULL OR (
        typeof(completed_lease_owner) = 'text' AND
        length(trim(completed_lease_owner)) BETWEEN 1 AND 240 AND
        completed_lease_owner = trim(completed_lease_owner) AND
        instr(completed_lease_owner, char(0)) = 0
      )
    ),
  resource_type TEXT
    CHECK (
      resource_type IS NULL OR (
        typeof(resource_type) = 'text' AND
        resource_type IN ('draft', 'draft_suggestion', 'workflow_run')
      )
    ),
  resource_id TEXT
    CHECK (
      resource_id IS NULL OR (
        typeof(resource_id) = 'text' AND
        length(resource_id) BETWEEN 1 AND 240 AND
        resource_id = trim(resource_id) AND
        instr(resource_id, char(0)) = 0
      )
    ),
  created_at TEXT NOT NULL CHECK (
    typeof(created_at) = 'text' AND length(created_at) = 24 AND
    created_at GLOB
      '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
  ),
  updated_at TEXT NOT NULL CHECK (
    typeof(updated_at) = 'text' AND length(updated_at) = 24 AND
    updated_at GLOB
      '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z' AND
    strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
  ),
  completed_at TEXT CHECK (
    completed_at IS NULL OR (
      typeof(completed_at) = 'text' AND length(completed_at) = 24 AND
      completed_at GLOB
        '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9].[0-9][0-9][0-9]Z' AND
      strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
    )
  ),
  PRIMARY KEY (job_id, action_key),
  CHECK (updated_at >= created_at),
  CHECK (
    (status = 'reserved' AND completed_attempt IS NULL AND
      completed_lease_owner IS NULL AND
      resource_type IS NULL AND resource_id IS NULL AND completed_at IS NULL)
    OR
    (status = 'complete' AND completed_attempt IS NOT NULL AND
      completed_lease_owner IS NOT NULL AND
      resource_type IS NOT NULL AND resource_id IS NOT NULL AND
      completed_at IS NOT NULL AND updated_at >= completed_at)
  ),
  CHECK (
    resource_type IS NULL OR
    (action_type = 'create_draft' AND resource_type = 'draft') OR
    (action_type = 'suggest_draft_edit' AND resource_type = 'draft_suggestion') OR
    (action_type = 'run_workflow' AND resource_type = 'workflow_run')
  )
) WITHOUT ROWID;

CREATE INDEX idx_assistant_action_ledger_budget
  ON assistant_action_ledger(job_id, action_type, action_key);

CREATE INDEX idx_assistant_action_ledger_resource
  ON assistant_action_ledger(resource_type, resource_id)
  WHERE status = 'complete';

CREATE TRIGGER assistant_action_ledger_v19_insert_guard
BEFORE INSERT ON assistant_action_ledger BEGIN
  SELECT CASE WHEN new.status <> 'reserved'
    THEN RAISE(ABORT, 'assistant action must be inserted as reserved')
  END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM jobs job
      JOIN assistant_generation_snapshots snapshot
        ON snapshot.job_id = job.id
      JOIN chats chat
        ON chat.id = snapshot.chat_id
      JOIN projects project
        ON project.id = chat.project_id
     WHERE job.id = new.job_id
       AND job.type = 'assistant_generate'
       AND job.status = 'running'
       AND job.attempt = new.reserved_attempt
       AND job.lease_owner = new.reserved_lease_owner
       AND job.lease_expires_at IS NOT NULL
       AND julianday(job.lease_expires_at) > julianday('now')
       AND julianday(job.lease_expires_at) > julianday(new.created_at)
       AND job.cancel_requested_at IS NULL
       AND json_type(job.payload_json, '$.projectId') = 'text'
       AND json_extract(job.payload_json, '$.projectId') = new.project_id
       AND chat.scope = 'project'
       AND chat.project_id = new.project_id
       AND project.status = 'active'
  ) THEN RAISE(ABORT, 'assistant action reservation is outside the current running Matter attempt') END;

  SELECT CASE WHEN (
    SELECT count(*)
      FROM assistant_action_ledger existing
     WHERE existing.job_id = new.job_id
       AND existing.action_type = new.action_type
  ) >= CASE new.action_type
    WHEN 'create_draft' THEN 1
    WHEN 'suggest_draft_edit' THEN 5
    WHEN 'run_workflow' THEN 2
  END THEN RAISE(ABORT, 'assistant action budget exhausted') END;
END;

CREATE TRIGGER assistant_action_ledger_v19_update_guard
BEFORE UPDATE ON assistant_action_ledger BEGIN
  SELECT CASE WHEN
    old.status <> 'reserved' OR new.status <> 'complete'
  THEN RAISE(ABORT, 'assistant action may only transition reserved to complete') END;

  SELECT CASE WHEN
    new.job_id IS NOT old.job_id OR
    new.action_key IS NOT old.action_key OR
    new.action_type IS NOT old.action_type OR
    new.project_id IS NOT old.project_id OR
    new.input_sha256 IS NOT old.input_sha256 OR
    new.reserved_attempt IS NOT old.reserved_attempt OR
    new.reserved_lease_owner IS NOT old.reserved_lease_owner OR
    new.created_at IS NOT old.created_at
  THEN RAISE(ABORT, 'assistant action reservation binding is immutable') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM jobs job
      JOIN assistant_generation_snapshots snapshot
        ON snapshot.job_id = job.id
      JOIN chats chat
        ON chat.id = snapshot.chat_id
      JOIN projects project
        ON project.id = chat.project_id
     WHERE job.id = new.job_id
       AND job.type = 'assistant_generate'
       AND job.status = 'running'
       AND job.attempt = new.completed_attempt
       AND job.lease_owner = new.completed_lease_owner
       AND job.lease_expires_at IS NOT NULL
       AND julianday(job.lease_expires_at) > julianday('now')
       AND julianday(job.lease_expires_at) > julianday(new.completed_at)
       AND job.cancel_requested_at IS NULL
       AND json_type(job.payload_json, '$.projectId') = 'text'
       AND json_extract(job.payload_json, '$.projectId') = new.project_id
       AND chat.scope = 'project'
       AND chat.project_id = new.project_id
       AND project.status = 'active'
  ) THEN RAISE(ABORT, 'assistant action completion is outside the current running Matter attempt') END;
END;
`;

function applyAssistantActionLedgerV19(
  database: WorkspaceDatabaseAdapter,
  _capabilities: WorkspaceDatabaseCapabilities,
) {
  const eventCountBefore = Number(
    database
      .prepare("SELECT count(*) AS count FROM assistant_generation_events")
      .get()?.count ?? 0,
  );
  database.exec(ASSISTANT_DRAFT_EVENT_V19_SQL);
  const eventCountAfter = Number(
    database
      .prepare("SELECT count(*) AS count FROM assistant_generation_events")
      .get()?.count ?? -1,
  );
  if (eventCountAfter !== eventCountBefore) {
    throw new Error(
      "Assistant generation event v19 rebuild did not preserve every v10 row.",
    );
  }
  const eventTable = database
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type='table' AND name='assistant_generation_events'",
    )
    .get();
  if (
    typeof eventTable?.sql !== "string" ||
    !eventTable.sql.includes("'draft_created'")
  ) {
    throw new Error(
      "Assistant generation event v19 rebuild did not install draft_created.",
    );
  }
  for (const [type, name] of [
    ["index", "idx_assistant_generation_events_attempt"],
    ["index", "idx_assistant_generation_events_terminal"],
    ["trigger", "assistant_generation_events_immutable"],
  ] as const) {
    if (
      !database
        .prepare(
          "SELECT 1 AS present FROM sqlite_schema WHERE type=? AND name=?",
        )
        .get(type, name)
    ) {
      throw new Error(
        `Assistant generation event v19 rebuild is missing ${name}.`,
      );
    }
  }
  database.exec(ASSISTANT_ACTION_LEDGER_V19_SQL);
}

export const ASSISTANT_ACTION_LEDGER_V19_MIGRATION: WorkspaceMigration = {
  version: 19,
  name: "assistant_action_ledger",
  checksumMaterial: [
    "workspace-migration-v19",
    "lossless-v10-event-table-rebuild-adds-nonterminal-draft-created",
    "preserve-v10-event-columns-indexes-foreign-key-immutability-and-terminal-uniqueness",
    "durable-idempotent-assistant-side-effect-reservations",
    "current-running-attempt-and-active-matter-fence",
    "current-lease-owner-unexpired-claim-and-no-cancellation-fence",
    "per-job-action-budgets-create-1-suggest-5-workflow-2",
    "reserved-to-complete-only-with-immutable-resource-binding",
    ASSISTANT_DRAFT_EVENT_V19_SQL,
    ASSISTANT_ACTION_LEDGER_V19_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applyAssistantActionLedgerV19,
};
