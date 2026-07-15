import type {
  WorkspaceDatabaseAdapter,
  WorkspaceDatabaseCapabilities,
  WorkspaceMigration,
} from "./types";

const CREATED_AT = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

/*
 * Document Studio is an additive projection over the existing Workspace
 * document/version/blob model. A Studio save is still an immutable
 * document_versions row whose original bytes live in the encrypted BlobStore;
 * this schema stores only bounded metadata and Project-scoped citation links.
 */
const DOCUMENT_STUDIO_V12_SCHEMA_SQL = `
ALTER TABLE documents ADD COLUMN document_kind TEXT NOT NULL DEFAULT 'source'
  CHECK (document_kind IN ('source', 'draft', 'template'));

CREATE INDEX idx_documents_project_kind_updated
  ON documents(project_id, document_kind, updated_at DESC, id);

CREATE TABLE document_studio_versions (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'markdown' CHECK (format = 'markdown'),
  summary TEXT CHECK (
    summary IS NULL OR (
      length(summary) <= 500 AND instr(summary, char(0)) = 0
    )
  ),
  operation_id TEXT CHECK (
    operation_id IS NULL OR (
      length(trim(operation_id)) BETWEEN 1 AND 120 AND
      instr(operation_id, char(0)) = 0
    )
  ),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (length(trim(created_at)) > 0),
  PRIMARY KEY (document_id, version_id),
  FOREIGN KEY (document_id, version_id)
    REFERENCES document_versions(document_id, id) ON DELETE CASCADE,
  UNIQUE (document_id, operation_id)
);

CREATE INDEX idx_document_studio_versions_project_document
  ON document_studio_versions(
    project_id,
    document_id,
    created_at DESC,
    version_id
  );

CREATE TABLE document_version_citation_anchors (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  anchor_id TEXT NOT NULL REFERENCES source_citation_anchors(id)
    ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  created_at TEXT NOT NULL DEFAULT ${CREATED_AT}
    CHECK (length(trim(created_at)) > 0),
  FOREIGN KEY (document_id, version_id)
    REFERENCES document_versions(document_id, id) ON DELETE CASCADE,
  UNIQUE (version_id, anchor_id),
  UNIQUE (version_id, ordinal)
);

CREATE INDEX idx_document_version_citation_anchors_project_version
  ON document_version_citation_anchors(
    project_id,
    document_id,
    version_id,
    ordinal,
    anchor_id
  );
`;

const DOCUMENT_STUDIO_V12_TRIGGER_SQL = `
CREATE TRIGGER documents_studio_kind_insert
BEFORE INSERT ON documents BEGIN
  SELECT CASE WHEN
    new.document_kind IN ('draft', 'template') AND new.project_id IS NULL
  THEN RAISE(ABORT, 'Studio documents must belong to a Project') END;
END;

CREATE TRIGGER documents_studio_kind_update
BEFORE UPDATE OF id, project_id, document_kind ON documents BEGIN
  SELECT CASE WHEN
    new.document_kind IN ('draft', 'template') AND new.project_id IS NULL
  THEN RAISE(ABORT, 'Studio documents must belong to a Project') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM document_studio_versions studio
     WHERE studio.document_id = old.id
       AND (
         new.id IS NOT old.id OR
         new.project_id IS NOT studio.project_id OR
         new.document_kind NOT IN ('draft', 'template')
       )
  ) THEN RAISE(
    ABORT,
    'Studio document identity, Project, and kind cannot leave persisted versions'
  ) END;
END;

CREATE TRIGGER document_studio_versions_validate_insert
BEFORE INSERT ON document_studio_versions BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM documents document
      JOIN document_versions version
        ON version.document_id = document.id
       AND version.id = new.version_id
     WHERE document.id = new.document_id
       AND document.project_id = new.project_id
       AND document.document_kind IN ('draft', 'template')
       AND document.deleted_at IS NULL
       AND version.deleted_at IS NULL
  ) THEN RAISE(
    ABORT,
    'Studio version must belong to an active Studio document in the same Project'
  ) END;
END;

CREATE TRIGGER document_studio_versions_immutable
BEFORE UPDATE ON document_studio_versions BEGIN
  SELECT RAISE(ABORT, 'Document Studio version metadata is immutable');
END;

CREATE TRIGGER document_versions_studio_ownership_guard
BEFORE UPDATE OF id, document_id ON document_versions BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
      FROM document_studio_versions studio
     WHERE studio.document_id = old.document_id
       AND studio.version_id = old.id
       AND (
         studio.document_id IS NOT new.document_id OR
         studio.version_id IS NOT new.id
       )
  ) THEN RAISE(
    ABORT,
    'Document Studio version ownership cannot change'
  ) END;
END;

CREATE TRIGGER document_version_citation_anchors_validate_insert
BEFORE INSERT ON document_version_citation_anchors BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM document_studio_versions studio
      JOIN documents document
        ON document.id = studio.document_id
       AND document.project_id = studio.project_id
      JOIN document_versions version
        ON version.document_id = studio.document_id
       AND version.id = studio.version_id
      JOIN source_citation_anchors anchor
        ON anchor.id = new.anchor_id
       AND anchor.project_id = studio.project_id
     WHERE studio.project_id = new.project_id
       AND studio.document_id = new.document_id
       AND studio.version_id = new.version_id
       AND document.document_kind IN ('draft', 'template')
       AND document.deleted_at IS NULL
       AND version.deleted_at IS NULL
  ) THEN RAISE(
    ABORT,
    'Studio citation must bind a version and source anchor in the same Project'
  ) END;
END;

CREATE TRIGGER document_version_citation_anchors_immutable
BEFORE UPDATE ON document_version_citation_anchors BEGIN
  SELECT RAISE(ABORT, 'Document Studio version citations are immutable');
END;
`;

function applyDocumentStudioV12(
  database: WorkspaceDatabaseAdapter,
  _capabilities: WorkspaceDatabaseCapabilities,
) {
  database.exec(DOCUMENT_STUDIO_V12_SCHEMA_SQL);
  database.exec(DOCUMENT_STUDIO_V12_TRIGGER_SQL);
}

export const DOCUMENT_STUDIO_V12_MIGRATION: WorkspaceMigration = {
  version: 12,
  name: "project_document_studio_versions",
  checksumMaterial: [
    "workspace-migration-v12",
    "additive-existing-documents-versions-blobs-and-v11-anchors",
    "current-version-is-the-cas-authority-no-working-copy-table",
    DOCUMENT_STUDIO_V12_SCHEMA_SQL,
    DOCUMENT_STUDIO_V12_TRIGGER_SQL,
  ].join("\n-- checksum boundary --\n"),
  apply: applyDocumentStudioV12,
};
