import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const CREATED_AT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

/*
 * Source snapshots are deliberately additive. Existing message_sources and
 * Tabular citation JSON remain readable and can be projected into this shared
 * contract by adapters without rewriting historical rows.
 *
 * Only Project ownership is a live foreign key on a snapshot. Source record
 * identifiers are historical provenance: retaining them without a live FK
 * allows an immutable snapshot to survive a later document/version purge.
 * Project-document snapshots are nevertheless checked against the live
 * document/version/hash at insert time.
 */
const PROJECT_SOURCE_FOUNDATION_V11_SQL = `
CREATE TABLE project_source_snapshots (
  id TEXT PRIMARY KEY CHECK (
    length(trim(id)) BETWEEN 1 AND 120 AND instr(id, char(0)) = 0
  ),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('project_document', 'legal_authority')),
  source_record_id TEXT NOT NULL CHECK (
    length(trim(source_record_id)) BETWEEN 1 AND 500 AND
    instr(source_record_id, char(0)) = 0
  ),
  source_version_id TEXT CHECK (
    source_version_id IS NULL OR (
      length(trim(source_version_id)) BETWEEN 1 AND 500 AND
      instr(source_version_id, char(0)) = 0
    )
  ),
  title_snapshot TEXT NOT NULL CHECK (
    length(trim(title_snapshot)) BETWEEN 1 AND 500 AND
    instr(title_snapshot, char(0)) = 0
  ),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64 AND
    content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  locator_json TEXT NOT NULL CHECK (
    length(locator_json) BETWEEN 2 AND 32768 AND
    json_valid(locator_json) AND
    json_type(locator_json) = 'object'
  ),
  retrieved_at TEXT NOT NULL CHECK (length(trim(retrieved_at)) > 0),
  license_json TEXT NOT NULL CHECK (
    length(license_json) BETWEEN 2 AND 16384 AND
    json_valid(license_json) AND
    json_type(license_json) = 'object'
  ),
  retention_policy TEXT NOT NULL CHECK (
    retention_policy IN (
      'not_declared',
      'no_retention',
      'metadata_only',
      'full_text_ttl',
      'full_text_permitted'
    )
  ),
  retention_expires_at TEXT CHECK (
    retention_expires_at IS NULL OR length(trim(retention_expires_at)) > 0
  ),
  retrieval_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (
    length(retrieval_metadata_json) BETWEEN 2 AND 32768 AND
    json_valid(retrieval_metadata_json) AND
    json_type(retrieval_metadata_json) = 'object'
  ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (length(trim(created_at)) > 0),
  UNIQUE(project_id, id),
  CHECK (
    source_kind <> 'project_document' OR source_version_id IS NOT NULL
  ),
  CHECK (
    (retention_policy = 'full_text_ttl' AND
      retention_expires_at IS NOT NULL) OR
    (retention_policy <> 'full_text_ttl' AND
      retention_expires_at IS NULL)
  )
);

CREATE INDEX idx_project_source_snapshots_project_kind
  ON project_source_snapshots(
    project_id,
    source_kind,
    retrieved_at DESC,
    id
  );
CREATE INDEX idx_project_source_snapshots_source_identity
  ON project_source_snapshots(
    project_id,
    source_kind,
    source_record_id,
    source_version_id
  );
CREATE INDEX idx_project_source_snapshots_content_hash
  ON project_source_snapshots(project_id, content_sha256);
CREATE INDEX idx_project_source_snapshots_retention_expiry
  ON project_source_snapshots(retention_expires_at, project_id)
  WHERE retention_expires_at IS NOT NULL;

CREATE TABLE source_citation_anchors (
  id TEXT PRIMARY KEY CHECK (
    length(trim(id)) BETWEEN 1 AND 120 AND instr(id, char(0)) = 0
  ),
  project_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  exact_quote TEXT NOT NULL CHECK (
    length(trim(exact_quote)) BETWEEN 1 AND 8000 AND
    instr(exact_quote, char(0)) = 0
  ),
  quote_sha256 TEXT NOT NULL CHECK (
    length(quote_sha256) = 64 AND
    quote_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  locator_json TEXT NOT NULL CHECK (
    length(locator_json) BETWEEN 2 AND 32768 AND
    json_valid(locator_json) AND
    json_type(locator_json) = 'object'
  ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (length(trim(created_at)) > 0),
  FOREIGN KEY (project_id, snapshot_id)
    REFERENCES project_source_snapshots(project_id, id) ON DELETE CASCADE,
  UNIQUE(snapshot_id, ordinal)
);

CREATE INDEX idx_source_citation_anchors_project_snapshot
  ON source_citation_anchors(project_id, snapshot_id, ordinal, id);
CREATE INDEX idx_source_citation_anchors_quote_hash
  ON source_citation_anchors(project_id, quote_sha256);
`;

const PROJECT_SOURCE_FOUNDATION_V11_TRIGGER_SQL = `
CREATE TRIGGER project_source_snapshots_validate_insert
BEFORE INSERT ON project_source_snapshots BEGIN
  SELECT CASE WHEN (
    (SELECT count(*) FROM json_each(new.locator_json)) <>
      (SELECT count(DISTINCT key) FROM json_each(new.locator_json)) OR
    (SELECT count(*) FROM json_each(new.retrieval_metadata_json)) <>
      (SELECT count(DISTINCT key) FROM json_each(new.retrieval_metadata_json))
  ) THEN RAISE(ABORT, 'source snapshot metadata contains duplicate keys') END;

  SELECT CASE WHEN
    (SELECT count(*) FROM json_each(new.license_json)) <> 4 OR
    (SELECT count(*) FROM json_each(new.license_json)) <>
      (SELECT count(DISTINCT key) FROM json_each(new.license_json)) OR
    EXISTS (
      SELECT 1 FROM json_each(new.license_json)
       WHERE key NOT IN ('basis', 'retention', 'export', 'modelUse')
    ) OR
    json_type(new.license_json, '$.basis') IS NOT 'text' OR
    json_extract(new.license_json, '$.basis') NOT IN (
      'not_declared', 'deployment_contract', 'user_provided'
    ) OR
    json_type(new.license_json, '$.retention') IS NOT 'text' OR
    json_extract(new.license_json, '$.retention') IS NOT new.retention_policy OR
    json_type(new.license_json, '$.export') IS NOT 'text' OR
    json_extract(new.license_json, '$.export') NOT IN (
      'not_declared',
      'prohibited',
      'exact_quotes_only',
      'reviewed_work_product',
      'permitted'
    ) OR
    json_type(new.license_json, '$.modelUse') IS NOT 'text' OR
    json_extract(new.license_json, '$.modelUse') NOT IN (
      'not_declared', 'prohibited', 'local_only', 'permitted'
    ) OR
    (
      json_extract(new.license_json, '$.basis') IS 'not_declared' AND (
        json_extract(new.license_json, '$.retention') IS NOT 'not_declared' OR
        json_extract(new.license_json, '$.export') IS NOT 'not_declared' OR
        json_extract(new.license_json, '$.modelUse') IS NOT 'not_declared'
      )
    )
  THEN RAISE(ABORT, 'source snapshot license policy is invalid') END;

  SELECT CASE WHEN new.source_kind = 'project_document' AND NOT EXISTS (
    SELECT 1
      FROM documents document
      JOIN document_versions version
        ON version.document_id = document.id
       AND version.id = new.source_version_id
     WHERE document.id = new.source_record_id
       AND document.project_id = new.project_id
       AND document.deleted_at IS NULL
       AND version.deleted_at IS NULL
       AND version.content_sha256 = new.content_sha256
  ) THEN RAISE(
    ABORT,
    'project document snapshot must match a live Project version and hash'
  ) END;
END;

CREATE TRIGGER project_source_snapshots_immutable
BEFORE UPDATE ON project_source_snapshots BEGIN
  SELECT RAISE(ABORT, 'Project source snapshots are immutable');
END;

CREATE TRIGGER source_citation_anchors_validate_insert
BEFORE INSERT ON source_citation_anchors BEGIN
  SELECT CASE WHEN
    (SELECT count(*) FROM json_each(new.locator_json)) <>
      (SELECT count(DISTINCT key) FROM json_each(new.locator_json))
  THEN RAISE(ABORT, 'citation anchor locator contains duplicate keys') END;
END;

CREATE TRIGGER source_citation_anchors_immutable
BEFORE UPDATE ON source_citation_anchors BEGIN
  SELECT RAISE(ABORT, 'source citation anchors are immutable');
END;
`;

function applyProjectSourceFoundationV11(
  database: WorkspaceDatabaseAdapter,
  capabilities: WorkspaceDatabaseCapabilities,
) {
  if (!capabilities.jsonTextChecks) {
    throw new Error(
      "Workspace schema v11 requires SQLite JSON1 for transport-safe source metadata.",
    );
  }
  database.exec(PROJECT_SOURCE_FOUNDATION_V11_SQL);
  database.exec(PROJECT_SOURCE_FOUNDATION_V11_TRIGGER_SQL);
}

export const PROJECT_SOURCE_FOUNDATION_V11_MIGRATION: WorkspaceMigration = {
  version: 11,
  name: "project_source_snapshots_and_citation_anchors",
  checksumMaterial: [
    "workspace-migration-v11",
    "additive-no-rewrite-existing-message-or-tabular-citations",
    "project-owned-immutable-provider-neutral-provenance",
    PROJECT_SOURCE_FOUNDATION_V11_SQL,
    PROJECT_SOURCE_FOUNDATION_V11_TRIGGER_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applyProjectSourceFoundationV11,
};
