import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const CREATED_AT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

/*
 * Cleanup intents deliberately contain logical identifiers only. Filesystem
 * paths, filenames, exception messages, and arbitrary JSON metadata have no
 * place in this journal: recovery must be able to make its decision from the
 * authoritative database rows and the BlobStore's validated receipt.
 */
const BLOB_CLEANUP_SCHEMA_SQL = `
CREATE TABLE workspace_blob_cleanup_intents (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 36 AND
    substr(id, 9, 1) = '-' AND substr(id, 14, 1) = '-' AND
    substr(id, 19, 1) = '-' AND substr(id, 24, 1) = '-' AND
    lower(substr(id, 15, 1)) GLOB '[1-8]' AND
    lower(substr(id, 20, 1)) GLOB '[89ab]' AND
    length(replace(id, '-', '')) = 32 AND
    replace(lower(id), '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  operation TEXT NOT NULL
    CHECK (operation IN ('compensation', 'restore', 'finalize')),
  code TEXT NOT NULL CHECK (
    code IN (
      'DOCUMENT_BLOB_COMPENSATION_FAILED',
      'DOCUMENT_BLOB_RESTORE_FAILED',
      'DOCUMENT_BLOB_FINALIZE_FAILED'
    )
  ),
  document_id TEXT NOT NULL CHECK (
    length(document_id) = 36 AND
    substr(document_id, 9, 1) = '-' AND substr(document_id, 14, 1) = '-' AND
    substr(document_id, 19, 1) = '-' AND substr(document_id, 24, 1) = '-' AND
    lower(substr(document_id, 15, 1)) GLOB '[1-8]' AND
    lower(substr(document_id, 20, 1)) GLOB '[89ab]' AND
    length(replace(document_id, '-', '')) = 32 AND
    replace(lower(document_id), '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  version_id TEXT NOT NULL CHECK (
    length(version_id) = 36 AND
    substr(version_id, 9, 1) = '-' AND substr(version_id, 14, 1) = '-' AND
    substr(version_id, 19, 1) = '-' AND substr(version_id, 24, 1) = '-' AND
    lower(substr(version_id, 15, 1)) GLOB '[1-8]' AND
    lower(substr(version_id, 20, 1)) GLOB '[89ab]' AND
    length(replace(version_id, '-', '')) = 32 AND
    replace(lower(version_id), '-', '') NOT GLOB '*[^0-9a-f]*'
  ),
  locator_json TEXT NOT NULL CHECK (json_valid(locator_json)),
  receipt_json TEXT CHECK (receipt_json IS NULL OR json_valid(receipt_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resolved')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code IN (
      'AMBIGUOUS_AUTHORITY',
      'STAGED_RECEIPT_MISMATCH',
      'BLOB_STORE_UNSUPPORTED',
      'BLOB_IO_FAILED',
      'LEDGER_WRITE_FAILED'
    )
  ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (length(trim(created_at)) > 0),
  updated_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (length(trim(updated_at)) > 0),
  resolved_at TEXT,
  CHECK (
    (operation = 'compensation' AND
      code = 'DOCUMENT_BLOB_COMPENSATION_FAILED') OR
    (operation = 'restore' AND code = 'DOCUMENT_BLOB_RESTORE_FAILED') OR
    (operation = 'finalize' AND code = 'DOCUMENT_BLOB_FINALIZE_FAILED')
  ),
  CHECK (operation = 'compensation' OR receipt_json IS NOT NULL),
  CHECK (
    (status = 'pending' AND resolved_at IS NULL) OR
    (status = 'resolved' AND resolved_at IS NOT NULL AND
      length(trim(resolved_at)) > 0)
  )
);

CREATE INDEX idx_workspace_blob_cleanup_pending
  ON workspace_blob_cleanup_intents(status, created_at, id)
  WHERE status = 'pending';
CREATE INDEX idx_workspace_blob_cleanup_document
  ON workspace_blob_cleanup_intents(document_id, version_id, status);
`;

const LOCATOR_VALIDATION_SQL = `
  SELECT CASE WHEN
    json_type(new.locator_json) IS NOT 'object' OR
    json_type(new.locator_json, '$.kind') IS NOT 'text' OR
    json_extract(new.locator_json, '$.kind') NOT IN
      ('original', 'extracted_text', 'preview') OR
    json_type(new.locator_json, '$.documentId') IS NOT 'text' OR
    json_type(new.locator_json, '$.versionId') IS NOT 'text' OR
    json_extract(new.locator_json, '$.documentId') IS NOT new.document_id OR
    json_extract(new.locator_json, '$.versionId') IS NOT new.version_id OR
    length(json_extract(new.locator_json, '$.documentId')) <> 36 OR
    substr(json_extract(new.locator_json, '$.documentId'), 9, 1) <> '-' OR
    substr(json_extract(new.locator_json, '$.documentId'), 14, 1) <> '-' OR
    substr(json_extract(new.locator_json, '$.documentId'), 19, 1) <> '-' OR
    substr(json_extract(new.locator_json, '$.documentId'), 24, 1) <> '-' OR
    lower(substr(json_extract(new.locator_json, '$.documentId'), 15, 1))
      NOT GLOB '[1-8]' OR
    lower(substr(json_extract(new.locator_json, '$.documentId'), 20, 1))
      NOT GLOB '[89ab]' OR
    length(replace(json_extract(new.locator_json, '$.documentId'), '-', ''))
      <> 32 OR
    replace(lower(json_extract(new.locator_json, '$.documentId')), '-', '')
      GLOB '*[^0-9a-f]*' OR
    length(json_extract(new.locator_json, '$.versionId')) <> 36 OR
    substr(json_extract(new.locator_json, '$.versionId'), 9, 1) <> '-' OR
    substr(json_extract(new.locator_json, '$.versionId'), 14, 1) <> '-' OR
    substr(json_extract(new.locator_json, '$.versionId'), 19, 1) <> '-' OR
    substr(json_extract(new.locator_json, '$.versionId'), 24, 1) <> '-' OR
    lower(substr(json_extract(new.locator_json, '$.versionId'), 15, 1))
      NOT GLOB '[1-8]' OR
    lower(substr(json_extract(new.locator_json, '$.versionId'), 20, 1))
      NOT GLOB '[89ab]' OR
    length(replace(json_extract(new.locator_json, '$.versionId'), '-', ''))
      <> 32 OR
    replace(lower(json_extract(new.locator_json, '$.versionId')), '-', '')
      GLOB '*[^0-9a-f]*' OR
    EXISTS (
      SELECT 1 FROM json_each(new.locator_json)
       WHERE key NOT IN ('kind', 'documentId', 'versionId', 'previewId')
    ) OR
    (json_extract(new.locator_json, '$.kind') IN
       ('original', 'extracted_text') AND
      (SELECT count(*) FROM json_each(new.locator_json)) <> 3) OR
    (json_extract(new.locator_json, '$.kind') = 'preview' AND
      (SELECT count(*) FROM json_each(new.locator_json)) NOT IN (3, 4)) OR
    (json_type(new.locator_json, '$.previewId') IS NOT NULL AND (
      json_extract(new.locator_json, '$.kind') <> 'preview' OR
      json_type(new.locator_json, '$.previewId') IS NOT 'text' OR
      length(json_extract(new.locator_json, '$.previewId')) <> 36 OR
      substr(json_extract(new.locator_json, '$.previewId'), 9, 1) <> '-' OR
      substr(json_extract(new.locator_json, '$.previewId'), 14, 1) <> '-' OR
      substr(json_extract(new.locator_json, '$.previewId'), 19, 1) <> '-' OR
      substr(json_extract(new.locator_json, '$.previewId'), 24, 1) <> '-' OR
      lower(substr(json_extract(new.locator_json, '$.previewId'), 15, 1))
        NOT GLOB '[1-8]' OR
      lower(substr(json_extract(new.locator_json, '$.previewId'), 20, 1))
        NOT GLOB '[89ab]' OR
      length(replace(json_extract(new.locator_json, '$.previewId'), '-', ''))
        <> 32 OR
      replace(lower(json_extract(new.locator_json, '$.previewId')), '-', '')
        GLOB '*[^0-9a-f]*'
    ))
    THEN RAISE(ABORT, 'workspace blob cleanup locator is invalid')
  END;
`;

const RECEIPT_VALIDATION_SQL = `
  SELECT CASE WHEN new.receipt_json IS NOT NULL AND (
    json_type(new.receipt_json) IS NOT 'object' OR
    (SELECT count(*) FROM json_each(new.receipt_json)) <> 3 OR
    EXISTS (
      SELECT 1 FROM json_each(new.receipt_json)
       WHERE key NOT IN ('status', 'locator', 'quarantineId')
    ) OR
    json_type(new.receipt_json, '$.status') IS NOT 'text' OR
    json_extract(new.receipt_json, '$.status') <> 'staged' OR
    json_type(new.receipt_json, '$.locator') IS NOT 'object' OR
    json(json_extract(new.receipt_json, '$.locator')) <>
      json(new.locator_json) OR
    json_type(new.receipt_json, '$.quarantineId') IS NOT 'text' OR
    length(json_extract(new.receipt_json, '$.quarantineId')) <> 36 OR
    substr(json_extract(new.receipt_json, '$.quarantineId'), 9, 1) <> '-' OR
    substr(json_extract(new.receipt_json, '$.quarantineId'), 14, 1) <> '-' OR
    substr(json_extract(new.receipt_json, '$.quarantineId'), 19, 1) <> '-' OR
    substr(json_extract(new.receipt_json, '$.quarantineId'), 24, 1) <> '-' OR
    lower(substr(json_extract(new.receipt_json, '$.quarantineId'), 15, 1))
      NOT GLOB '[1-8]' OR
    lower(substr(json_extract(new.receipt_json, '$.quarantineId'), 20, 1))
      NOT GLOB '[89ab]' OR
    length(replace(json_extract(new.receipt_json, '$.quarantineId'), '-', ''))
      <> 32 OR
    replace(lower(json_extract(new.receipt_json, '$.quarantineId')), '-', '')
      GLOB '*[^0-9a-f]*'
  ) THEN RAISE(ABORT, 'workspace blob cleanup receipt is invalid') END;
`;

const BLOB_CLEANUP_TRIGGER_SQL = `
CREATE TRIGGER workspace_blob_cleanup_intents_validate_insert
BEFORE INSERT ON workspace_blob_cleanup_intents BEGIN
${LOCATOR_VALIDATION_SQL}
${RECEIPT_VALIDATION_SQL}
END;

CREATE TRIGGER workspace_blob_cleanup_intents_validate_update
BEFORE UPDATE ON workspace_blob_cleanup_intents BEGIN
  SELECT CASE WHEN
    new.id IS NOT old.id OR
    new.operation IS NOT old.operation OR
    new.code IS NOT old.code OR
    new.document_id IS NOT old.document_id OR
    new.version_id IS NOT old.version_id OR
    new.locator_json IS NOT old.locator_json OR
    new.receipt_json IS NOT old.receipt_json OR
    new.created_at IS NOT old.created_at OR
    new.attempt_count < old.attempt_count OR
    (old.status = 'resolved' AND new.status <> 'resolved')
    THEN RAISE(ABORT, 'workspace blob cleanup immutable state changed')
  END;
${LOCATOR_VALIDATION_SQL}
${RECEIPT_VALIDATION_SQL}
END;
`;

function applyWorkspaceRuntimeSchema(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  if (!capabilities.jsonTextChecks) {
    throw new Error(
      "Workspace schema v3 requires SQLite JSON1 for strict cleanup receipt validation.",
    );
  }
  database.exec(BLOB_CLEANUP_SCHEMA_SQL);
  database.exec(BLOB_CLEANUP_TRIGGER_SQL);
}

export const WORKSPACE_RUNTIME_MIGRATION: WorkspaceMigration = {
  version: 3,
  name: "workspace_runtime_blob_cleanup_ledger",
  checksumMaterial: [
    "workspace-migration-v3",
    "requires-json1",
    BLOB_CLEANUP_SCHEMA_SQL,
    BLOB_CLEANUP_TRIGGER_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applyWorkspaceRuntimeSchema,
};
