import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const CREATED_AT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

const INTEGRITY_SCHEMA_SQL = `
CREATE TABLE workspace_schema_capabilities (
  capability TEXT PRIMARY KEY
    CHECK (capability IN ('json1', 'fts5')),
  available INTEGER NOT NULL CHECK (available = 1),
  verified_at TEXT NOT NULL DEFAULT ${CREATED_AT}
);

INSERT INTO workspace_schema_capabilities (capability, available)
VALUES ('json1', 1), ('fts5', 1);

CREATE TABLE workspace_blob_records (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) BETWEEN 1 AND 120),
  kind TEXT NOT NULL
    CHECK (kind IN ('original', 'extracted_text', 'preview', 'export')),
  document_id TEXT,
  version_id TEXT,
  preview_id TEXT CHECK (
    preview_id IS NULL OR length(trim(preview_id)) BETWEEN 1 AND 120
  ),
  export_id TEXT CHECK (
    export_id IS NULL OR length(trim(export_id)) BETWEEN 1 AND 120
  ),
  storage_key TEXT NOT NULL CHECK (
    length(trim(storage_key)) BETWEEN 1 AND 1024 AND
    instr(storage_key, char(0)) = 0 AND
    substr(storage_key, 1, 1) <> '/' AND
    storage_key NOT GLOB '[A-Za-z]:*' AND
    instr(storage_key, char(92)) = 0 AND
    storage_key NOT LIKE '../%' AND
    storage_key NOT LIKE '%/../%' AND
    storage_key NOT LIKE '%/..'
  ),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND
    content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  stored_size_bytes INTEGER NOT NULL CHECK (stored_size_bytes >= 0),
  state TEXT NOT NULL DEFAULT 'stored'
    CHECK (state IN ('stored', 'quarantined')),
  quarantine_id TEXT CHECK (
    quarantine_id IS NULL OR length(trim(quarantine_id)) BETWEEN 1 AND 120
  ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  FOREIGN KEY (document_id, version_id)
    REFERENCES document_versions(document_id, id) ON DELETE CASCADE,
  CHECK (
    (kind IN ('original', 'extracted_text') AND
      document_id IS NOT NULL AND version_id IS NOT NULL AND
      preview_id IS NULL AND export_id IS NULL) OR
    (kind = 'preview' AND
      document_id IS NOT NULL AND version_id IS NOT NULL AND
      export_id IS NULL) OR
    (kind = 'export' AND
      document_id IS NULL AND version_id IS NULL AND
      preview_id IS NULL AND export_id IS NOT NULL)
  ),
  CHECK (
    (state = 'stored' AND quarantine_id IS NULL) OR
    (state = 'quarantined' AND quarantine_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_workspace_blob_records_storage_key
  ON workspace_blob_records(storage_key);
CREATE UNIQUE INDEX uq_workspace_blob_records_document_locator
  ON workspace_blob_records(kind, document_id, version_id)
  WHERE kind IN ('original', 'extracted_text');
CREATE UNIQUE INDEX uq_workspace_blob_records_preview_locator
  ON workspace_blob_records(
    kind,
    document_id,
    version_id,
    ifnull(preview_id, '')
  ) WHERE kind = 'preview';
CREATE UNIQUE INDEX uq_workspace_blob_records_export_locator
  ON workspace_blob_records(kind, export_id)
  WHERE kind = 'export';
CREATE UNIQUE INDEX uq_workspace_blob_records_quarantine
  ON workspace_blob_records(quarantine_id)
  WHERE quarantine_id IS NOT NULL;
CREATE INDEX idx_workspace_blob_records_document
  ON workspace_blob_records(document_id, version_id, kind)
  WHERE document_id IS NOT NULL;
CREATE INDEX idx_workspace_blob_records_state
  ON workspace_blob_records(state, updated_at);

ALTER TABLE jobs ADD COLUMN queued_at TEXT;
ALTER TABLE jobs ADD COLUMN cancellation_reason TEXT
  CHECK (
    cancellation_reason IS NULL OR
    length(trim(cancellation_reason)) BETWEEN 1 AND 1000
  );
ALTER TABLE jobs ADD COLUMN lease_owner TEXT
  CHECK (lease_owner IS NULL OR length(trim(lease_owner)) BETWEEN 1 AND 240);
ALTER TABLE jobs ADD COLUMN lease_expires_at TEXT;
UPDATE jobs SET queued_at = coalesce(scheduled_at, created_at)
 WHERE queued_at IS NULL;
CREATE INDEX idx_jobs_lease_expiry
  ON jobs(status, lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

ALTER TABLE workflows ADD COLUMN project_id TEXT
  REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX idx_workflows_project_updated
  ON workflows(project_id, updated_at DESC)
  WHERE project_id IS NOT NULL;

ALTER TABLE workflow_runs ADD COLUMN retry_of_run_id TEXT
  REFERENCES workflow_runs(id) ON DELETE SET NULL;
CREATE INDEX idx_workflow_runs_retry_of
  ON workflow_runs(retry_of_run_id)
  WHERE retry_of_run_id IS NOT NULL;

ALTER TABLE documents ADD COLUMN parse_error_code TEXT
  CHECK (
    parse_error_code IS NULL OR
    length(trim(parse_error_code)) BETWEEN 1 AND 120
  );
ALTER TABLE documents ADD COLUMN parse_error_json TEXT
  CHECK (parse_error_json IS NULL OR json_valid(parse_error_json));

CREATE TABLE tabular_review_documents (
  review_id TEXT NOT NULL REFERENCES tabular_reviews(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT},
  PRIMARY KEY (review_id, document_id),
  UNIQUE (review_id, ordinal)
);

CREATE INDEX idx_tabular_review_documents_document
  ON tabular_review_documents(document_id, review_id);
`;

const INTEGRITY_TRIGGER_SQL = `
CREATE TRIGGER jobs_integrity_insert
BEFORE INSERT ON jobs BEGIN
  SELECT CASE
    WHEN new.queued_at IS NOT NULL AND length(trim(new.queued_at)) = 0
    THEN RAISE(ABORT, 'jobs queued_at cannot be empty')
  END;
  SELECT CASE
    WHEN (new.lease_owner IS NULL) <> (new.lease_expires_at IS NULL)
    THEN RAISE(ABORT, 'jobs lease owner and expiry must be paired')
  END;
END;

CREATE TRIGGER jobs_integrity_update
BEFORE UPDATE OF queued_at, lease_owner, lease_expires_at ON jobs BEGIN
  SELECT CASE
    WHEN new.queued_at IS NULL OR length(trim(new.queued_at)) = 0
    THEN RAISE(ABORT, 'jobs queued_at is required')
  END;
  SELECT CASE
    WHEN (new.lease_owner IS NULL) <> (new.lease_expires_at IS NULL)
    THEN RAISE(ABORT, 'jobs lease owner and expiry must be paired')
  END;
END;

CREATE TRIGGER jobs_queued_at_default
AFTER INSERT ON jobs
WHEN new.queued_at IS NULL BEGIN
  UPDATE jobs
     SET queued_at = coalesce(new.scheduled_at, new.created_at)
   WHERE id = new.id;
END;

CREATE TRIGGER project_subfolders_integrity_insert
BEFORE INSERT ON project_subfolders BEGIN
  SELECT CASE
    WHEN new.parent_folder_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM project_subfolders parent
       WHERE parent.id = new.parent_folder_id
         AND parent.project_id = new.project_id
    )
    THEN RAISE(ABORT, 'folder parent must belong to the same project')
  END;
  SELECT CASE
    WHEN new.parent_folder_id IS NOT NULL AND EXISTS (
      WITH RECURSIVE ancestors(id, parent_folder_id) AS (
        SELECT id, parent_folder_id
          FROM project_subfolders
         WHERE id = new.parent_folder_id
        UNION
        SELECT parent.id, parent.parent_folder_id
          FROM project_subfolders parent
          JOIN ancestors child ON parent.id = child.parent_folder_id
      )
      SELECT 1 FROM ancestors WHERE id = new.id
    )
    THEN RAISE(ABORT, 'folder hierarchy cannot contain a cycle')
  END;
END;

CREATE TRIGGER project_subfolders_integrity_update
BEFORE UPDATE OF id, project_id, parent_folder_id ON project_subfolders BEGIN
  SELECT CASE
    WHEN new.parent_folder_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
        FROM project_subfolders parent
       WHERE parent.id = new.parent_folder_id
         AND parent.project_id = new.project_id
    )
    THEN RAISE(ABORT, 'folder parent must belong to the same project')
  END;
  SELECT CASE
    WHEN new.parent_folder_id IS NOT NULL AND EXISTS (
      WITH RECURSIVE ancestors(id, parent_folder_id) AS (
        SELECT id, parent_folder_id
          FROM project_subfolders
         WHERE id = new.parent_folder_id
        UNION
        SELECT parent.id, parent.parent_folder_id
          FROM project_subfolders parent
          JOIN ancestors child ON parent.id = child.parent_folder_id
      )
      SELECT 1 FROM ancestors WHERE id = new.id
    )
    THEN RAISE(ABORT, 'folder hierarchy cannot contain a cycle')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM project_subfolders child
       WHERE child.parent_folder_id = old.id
         AND child.id <> old.id
         AND child.project_id <> new.project_id
    )
    THEN RAISE(ABORT, 'folder children must remain in the same project')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM documents document
       WHERE document.folder_id = old.id
         AND document.project_id IS NOT new.project_id
    )
    THEN RAISE(ABORT, 'folder documents must remain in the same project')
  END;
END;

CREATE TRIGGER documents_integrity_insert
BEFORE INSERT ON documents BEGIN
  SELECT CASE
    WHEN new.folder_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM project_subfolders folder
       WHERE folder.id = new.folder_id
         AND folder.project_id IS new.project_id
    )
    THEN RAISE(ABORT, 'document folder must belong to its project')
  END;
  SELECT CASE
    WHEN new.current_version_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM document_versions version
       WHERE version.id = new.current_version_id
         AND version.document_id = new.id
    )
    THEN RAISE(ABORT, 'current document version must be owned by the document')
  END;
END;

CREATE TRIGGER documents_integrity_update
BEFORE UPDATE OF id, project_id, folder_id, current_version_id ON documents BEGIN
  SELECT CASE
    WHEN new.folder_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM project_subfolders folder
       WHERE folder.id = new.folder_id
         AND folder.project_id IS new.project_id
    )
    THEN RAISE(ABORT, 'document folder must belong to its project')
  END;
  SELECT CASE
    WHEN new.current_version_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM document_versions version
       WHERE version.id = new.current_version_id
         AND version.document_id = new.id
    )
    THEN RAISE(ABORT, 'current document version must be owned by the document')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
        FROM tabular_review_documents membership
        JOIN tabular_reviews review ON review.id = membership.review_id
       WHERE membership.document_id = old.id
         AND review.project_id IS NOT new.project_id
    )
    THEN RAISE(ABORT, 'document project must match every tabular review')
  END;
END;

CREATE TRIGGER document_versions_integrity_update
BEFORE UPDATE OF id, document_id ON document_versions BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM documents document
       WHERE document.current_version_id = old.id
         AND document.id <> new.document_id
    )
    THEN RAISE(ABORT, 'current document version ownership cannot change')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM message_sources source
       WHERE source.version_id = old.id
         AND source.document_id <> new.document_id
    )
    THEN RAISE(ABORT, 'message source version ownership cannot change')
  END;
END;

CREATE TRIGGER message_sources_integrity_insert
BEFORE INSERT ON message_sources BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM document_versions version
       WHERE version.id = new.version_id
         AND version.document_id = new.document_id
    )
    THEN RAISE(ABORT, 'message source version must belong to its document')
  END;
  SELECT CASE
    WHEN new.chunk_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM document_chunks chunk
       WHERE chunk.id = new.chunk_id
         AND chunk.document_id = new.document_id
         AND chunk.version_id = new.version_id
    )
    THEN RAISE(ABORT, 'message source chunk must belong to its version')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
        FROM chat_messages message
        JOIN chats chat ON chat.id = message.chat_id
        JOIN documents document ON document.id = new.document_id
       WHERE message.id = new.message_id
         AND document.project_id IS NOT chat.project_id
    )
    THEN RAISE(ABORT, 'project chat source must belong to the same project')
  END;
END;

CREATE TRIGGER message_sources_integrity_update
BEFORE UPDATE OF document_id, version_id, chunk_id ON message_sources BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM document_versions version
       WHERE version.id = new.version_id
         AND version.document_id = new.document_id
    )
    THEN RAISE(ABORT, 'message source version must belong to its document')
  END;
  SELECT CASE
    WHEN new.chunk_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM document_chunks chunk
       WHERE chunk.id = new.chunk_id
         AND chunk.document_id = new.document_id
         AND chunk.version_id = new.version_id
    )
    THEN RAISE(ABORT, 'message source chunk must belong to its version')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
        FROM chat_messages message
        JOIN chats chat ON chat.id = message.chat_id
        JOIN documents document ON document.id = new.document_id
       WHERE message.id = new.message_id
         AND document.project_id IS NOT chat.project_id
    )
    THEN RAISE(ABORT, 'project chat source must belong to the same project')
  END;
END;

CREATE TRIGGER chats_source_scope_update
BEFORE UPDATE OF project_id, scope ON chats BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
        FROM chat_messages message
        JOIN message_sources source ON source.message_id = message.id
        JOIN documents document ON document.id = source.document_id
       WHERE message.chat_id = old.id
         AND document.project_id IS NOT new.project_id
    )
    THEN RAISE(ABORT, 'project chat sources must remain in the same project')
  END;
END;

CREATE TRIGGER document_chunks_integrity_update
BEFORE UPDATE OF id, document_id, version_id ON document_chunks BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM message_sources source
       WHERE source.chunk_id = old.id
         AND (
           source.document_id <> new.document_id OR
           source.version_id <> new.version_id
         )
    )
    THEN RAISE(ABORT, 'message source chunk ownership cannot change')
  END;
END;

CREATE TRIGGER tabular_reviews_integrity_insert
BEFORE INSERT ON tabular_reviews BEGIN
  SELECT CASE
    WHEN new.workflow_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM workflows workflow
       WHERE workflow.id = new.workflow_id
         AND workflow.type = 'tabular'
    )
    THEN RAISE(ABORT, 'tabular review requires a tabular workflow')
  END;
END;

CREATE TRIGGER tabular_reviews_integrity_update
BEFORE UPDATE OF project_id, workflow_id ON tabular_reviews BEGIN
  SELECT CASE
    WHEN new.workflow_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM workflows workflow
       WHERE workflow.id = new.workflow_id
         AND workflow.type = 'tabular'
    )
    THEN RAISE(ABORT, 'tabular review requires a tabular workflow')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
        FROM tabular_review_documents membership
        JOIN documents document ON document.id = membership.document_id
       WHERE membership.review_id = old.id
         AND document.project_id IS NOT new.project_id
    )
    THEN RAISE(ABORT, 'tabular review documents must belong to its project')
  END;
END;

CREATE TRIGGER workflows_tabular_type_guard
BEFORE UPDATE OF type ON workflows
WHEN old.type = 'tabular' AND new.type <> 'tabular' BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM tabular_reviews review
       WHERE review.workflow_id = old.id
    )
    THEN RAISE(ABORT, 'workflow type is referenced by a tabular review')
  END;
END;

CREATE TRIGGER tabular_review_documents_integrity_insert
BEFORE INSERT ON tabular_review_documents BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
        FROM tabular_reviews review
        JOIN documents document ON document.id = new.document_id
       WHERE review.id = new.review_id
         AND document.project_id IS review.project_id
    )
    THEN RAISE(ABORT, 'tabular review document must belong to the review project')
  END;
END;

CREATE TRIGGER tabular_review_documents_integrity_update
BEFORE UPDATE OF review_id, document_id ON tabular_review_documents BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
        FROM tabular_reviews review
        JOIN documents document ON document.id = new.document_id
       WHERE review.id = new.review_id
         AND document.project_id IS review.project_id
    )
    THEN RAISE(ABORT, 'tabular review document must belong to the review project')
  END;
END;

CREATE TRIGGER tabular_review_documents_delete_guard
BEFORE DELETE ON tabular_review_documents BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM tabular_cells cell
       WHERE cell.review_id = old.review_id
         AND cell.document_id = old.document_id
    )
    AND EXISTS (
      SELECT 1 FROM tabular_reviews review WHERE review.id = old.review_id
    )
    AND EXISTS (
      SELECT 1 FROM documents document WHERE document.id = old.document_id
    )
    THEN RAISE(ABORT, 'tabular review document still has cells')
  END;
END;

CREATE TRIGGER tabular_cells_integrity_insert
BEFORE INSERT ON tabular_cells BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM tabular_review_columns column
       WHERE column.id = new.column_id
         AND column.review_id = new.review_id
         AND column.output_type = new.output_type
    )
    THEN RAISE(ABORT, 'tabular cell column and output must match its review')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM tabular_review_documents membership
       WHERE membership.review_id = new.review_id
         AND membership.document_id = new.document_id
    )
    THEN RAISE(ABORT, 'tabular cell document must belong to its review')
  END;
END;

CREATE TRIGGER tabular_cells_integrity_update
BEFORE UPDATE OF review_id, document_id, column_id, output_type ON tabular_cells BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM tabular_review_columns column
       WHERE column.id = new.column_id
         AND column.review_id = new.review_id
         AND column.output_type = new.output_type
    )
    THEN RAISE(ABORT, 'tabular cell column and output must match its review')
  END;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM tabular_review_documents membership
       WHERE membership.review_id = new.review_id
         AND membership.document_id = new.document_id
    )
    THEN RAISE(ABORT, 'tabular cell document must belong to its review')
  END;
END;

CREATE TRIGGER tabular_review_columns_integrity_update
BEFORE UPDATE OF id, review_id, output_type ON tabular_review_columns BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM tabular_cells cell
       WHERE cell.column_id = old.id
         AND (
           cell.review_id <> new.review_id OR
           cell.output_type <> new.output_type
         )
    )
    THEN RAISE(ABORT, 'tabular column is incompatible with existing cells')
  END;
END;
`;

const DOCUMENT_CHUNKS_FTS_V2_SQL = `
DROP TRIGGER IF EXISTS document_chunks_fts_insert;
DROP TRIGGER IF EXISTS document_chunks_fts_delete;
DROP TRIGGER IF EXISTS document_chunks_fts_update;
DROP TABLE IF EXISTS document_chunks_fts;

CREATE VIRTUAL TABLE document_chunks_fts USING fts5(
  text,
  document_id UNINDEXED,
  version_id UNINDEXED,
  content = 'document_chunks',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER document_chunks_fts_insert
AFTER INSERT ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(rowid, text, document_id, version_id)
  VALUES (new.rowid, new.text, new.document_id, new.version_id);
END;

CREATE TRIGGER document_chunks_fts_delete
AFTER DELETE ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(
    document_chunks_fts, rowid, text, document_id, version_id
  ) VALUES ('delete', old.rowid, old.text, old.document_id, old.version_id);
END;

CREATE TRIGGER document_chunks_fts_update
AFTER UPDATE ON document_chunks BEGIN
  INSERT INTO document_chunks_fts(
    document_chunks_fts, rowid, text, document_id, version_id
  ) VALUES ('delete', old.rowid, old.text, old.document_id, old.version_id);
  INSERT INTO document_chunks_fts(rowid, text, document_id, version_id)
  VALUES (new.rowid, new.text, new.document_id, new.version_id);
END;

INSERT INTO document_chunks_fts(document_chunks_fts) VALUES ('rebuild');
`;

const TABULAR_REVIEW_DOCUMENT_BACKFILL_SQL = `
INSERT INTO tabular_review_documents (review_id, document_id, ordinal)
SELECT review.id, json_each.value, CAST(json_each.key AS INTEGER)
  FROM tabular_reviews review,
       json_each(review.document_ids_json)
 ORDER BY review.id, CAST(json_each.key AS INTEGER);
`;

function requireV2Capabilities(capabilities: WorkspaceDatabaseCapabilities) {
  if (!capabilities.jsonTextChecks || !capabilities.fts5) {
    throw new Error(
      "Workspace schema v2 requires SQLite JSON1 and FTS5 capabilities.",
    );
  }
}

function assertLegacyTabularJson(database: WorkspaceDatabaseAdapter) {
  const invalid = Number(
    database
      .prepare(
        `SELECT count(*) AS count
           FROM tabular_reviews review
          WHERE json_type(review.document_ids_json) <> 'array'
             OR EXISTS (
               SELECT 1 FROM json_each(review.document_ids_json) item
                WHERE item.type <> 'text'
             )`,
      )
      .get()?.count ?? 0,
  );
  if (invalid !== 0) {
    throw new Error(
      "Workspace schema v2 cannot normalize malformed tabular document identifiers.",
    );
  }
}

function applyWorkspaceIntegritySchema(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  requireV2Capabilities(capabilities);
  assertLegacyTabularJson(database);
  database.exec(INTEGRITY_SCHEMA_SQL);
  database.exec(INTEGRITY_TRIGGER_SQL);
  database.exec(TABULAR_REVIEW_DOCUMENT_BACKFILL_SQL);
  database.exec(DOCUMENT_CHUNKS_FTS_V2_SQL);
}

export const WORKSPACE_INTEGRITY_MIGRATION: WorkspaceMigration = {
  version: 2,
  name: "workspace_integrity_and_blob_metadata",
  checksumMaterial: [
    "workspace-migration-v2",
    "requires-json1-and-fts5",
    INTEGRITY_SCHEMA_SQL,
    INTEGRITY_TRIGGER_SQL,
    TABULAR_REVIEW_DOCUMENT_BACKFILL_SQL,
    DOCUMENT_CHUNKS_FTS_V2_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applyWorkspaceIntegritySchema,
};
