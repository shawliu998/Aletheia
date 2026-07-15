import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkspaceDatabase } from "../lib/workspace/database";
import {
  PROJECT_SOURCE_FOUNDATION_V11_MIGRATION,
  WORKSPACE_MIGRATIONS,
  workspaceMigrationChecksum,
} from "../lib/workspace/migrations";
import {
  WorkspaceSourceFoundationRepository,
  WorkspaceSourceFoundationRepositoryError,
  sourceCitationQuoteSha256V11,
} from "../lib/workspace/repositories/sourceFoundation";

const originalEnvironment = { ...process.env };
const root = mkdtempSync(
  path.join(os.tmpdir(), "vera-workspace-source-foundation-audit-"),
);
const NOW = "2026-07-15T08:00:00.000Z";
const EXPIRES = "2026-08-14T08:00:00.000Z";
const DOCUMENT_HASH = "a".repeat(64);
const LEGAL_HASH = "b".repeat(64);

type SeededDocument = {
  projectId: string;
  documentId: string;
  versionId: string;
  chunkId: string;
};

function seedProjectDocument(
  database: WorkspaceDatabase,
  prefix: string,
): SeededDocument {
  const projectId = randomUUID();
  const documentId = randomUUID();
  const versionId = randomUUID();
  const chunkId = randomUUID();
  database
    .prepare("INSERT INTO projects (id, name) VALUES (?, ?)")
    .run(projectId, `${prefix} Project`);
  database
    .prepare(
      `INSERT INTO documents (
         id, project_id, title, filename, mime_type, size_bytes, parse_status
       ) VALUES (?, ?, ?, ?, 'text/plain', 22, 'ready')`,
    )
    .run(documentId, projectId, `${prefix} agreement`, `${prefix}.txt`);
  database
    .prepare(
      `INSERT INTO document_versions (
         id, document_id, version_number, source, filename, mime_type,
         size_bytes, content_sha256, storage_key
       ) VALUES (?, ?, 1, 'upload', ?, 'text/plain', 22, ?, ?)`,
    )
    .run(
      versionId,
      documentId,
      `${prefix}.txt`,
      DOCUMENT_HASH,
      `documents/${documentId}/${versionId}/original`,
    );
  database
    .prepare("UPDATE documents SET current_version_id = ? WHERE id = ?")
    .run(versionId, documentId);
  database
    .prepare(
      `INSERT INTO document_chunks (
         id, document_id, version_id, ordinal, text, start_offset,
         end_offset, content_sha256, metadata_json
       ) VALUES (?, ?, ?, 0, 'Payment is due in thirty days.', 0, 30, ?, '{}')`,
    )
    .run(chunkId, documentId, versionId, DOCUMENT_HASH);
  return { projectId, documentId, versionId, chunkId };
}

function projectDocumentSnapshotInput(seed: SeededDocument) {
  return {
    id: randomUUID(),
    projectId: seed.projectId,
    sourceKind: "project_document" as const,
    sourceRecordId: seed.documentId,
    sourceVersionId: seed.versionId,
    titleSnapshot: "Agreement.txt",
    contentSha256: `sha256:${DOCUMENT_HASH}`,
    locator: {
      documentVersionId: seed.versionId,
      chunkId: seed.chunkId,
      page: 1,
      geometry: {
        coordinateSystem: "normalized_top_left",
        bbox: [0.1, 0.2, 0.8, 0.1],
      },
    },
    retrievedAt: NOW,
    license: {
      basis: "user_provided" as const,
      retention: "full_text_permitted" as const,
      export: "permitted" as const,
      modelUse: "local_only" as const,
    },
    retentionPolicy: "full_text_permitted" as const,
    retentionExpiresAt: null,
    retrievalMetadata: { integration: "project_document_version" },
    createdAt: NOW,
  };
}

function legalSnapshotInput(projectId: string) {
  return {
    id: randomUUID(),
    projectId,
    sourceKind: "legal_authority" as const,
    sourceRecordId: "provider-document-2026-001",
    sourceVersionId: "effective-2026-01-01",
    titleSnapshot: "Authorized legal authority",
    contentSha256: `sha256:${LEGAL_HASH}`,
    locator: {
      authorityIdentifier: "AUTH-2026-001",
      section: "12(3)",
    },
    retrievedAt: NOW,
    license: {
      basis: "deployment_contract" as const,
      retention: "full_text_ttl" as const,
      export: "exact_quotes_only" as const,
      modelUse: "local_only" as const,
    },
    retentionPolicy: "full_text_ttl" as const,
    retentionExpiresAt: EXPIRES,
    retrievalMetadata: {
      providerId: "configured-provider",
      integration: "authorized_json_gateway",
      adapterVersion: "1",
      contractVersion: "1",
      providerDocumentId: "provider-document-2026-001",
      rawSha256: LEGAL_HASH,
    },
    createdAt: NOW,
  };
}

type RawSourceSnapshotInput = {
  id: string;
  projectId: string;
  sourceKind: "project_document" | "legal_authority";
  sourceRecordId: string;
  sourceVersionId: string | null;
  titleSnapshot: string;
  contentSha256: string;
  license: {
    basis: "not_declared" | "deployment_contract" | "user_provided";
    retention:
      | "not_declared"
      | "no_retention"
      | "metadata_only"
      | "full_text_ttl"
      | "full_text_permitted";
    export:
      | "not_declared"
      | "prohibited"
      | "exact_quotes_only"
      | "reviewed_work_product"
      | "permitted";
    modelUse: "not_declared" | "prohibited" | "local_only" | "permitted";
  };
  retentionExpiresAt: string | null;
};

function insertRawSourceSnapshot(
  database: WorkspaceDatabase,
  input: RawSourceSnapshotInput,
) {
  database
    .prepare(
      `INSERT INTO project_source_snapshots (
         id, project_id, source_kind, source_record_id, source_version_id,
         title_snapshot, content_sha256, locator_json, retrieved_at,
         license_json, retention_policy, retention_expires_at,
         retrieval_metadata_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, '{}', ?)`,
    )
    .run(
      input.id,
      input.projectId,
      input.sourceKind,
      input.sourceRecordId,
      input.sourceVersionId,
      input.titleSnapshot,
      input.contentSha256,
      NOW,
      JSON.stringify(input.license),
      input.license.retention,
      input.retentionExpiresAt,
      NOW,
    );
}

function seedLegacyCitation(database: WorkspaceDatabase, seed: SeededDocument) {
  const chatId = randomUUID();
  const messageId = randomUUID();
  const sourceId = randomUUID();
  database
    .prepare(
      `INSERT INTO chats (id, project_id, scope, title)
       VALUES (?, ?, 'project', 'Legacy citation chat')`,
    )
    .run(chatId, seed.projectId);
  database
    .prepare(
      `INSERT INTO chat_messages (
         id, chat_id, sequence, role, content, status, completed_at
       ) VALUES (?, ?, 0, 'assistant', 'Legacy answer', 'complete', ?)`,
    )
    .run(messageId, chatId, NOW);
  database
    .prepare(
      `INSERT INTO message_sources (
         id, message_id, document_id, version_id, filename_snapshot,
         chunk_id, quote, start_offset, end_offset, locator_json, rank,
         score, citation_ordinal, citation_metadata_json, created_at
       ) VALUES (?, ?, ?, ?, 'legacy.txt', ?, 'Payment is due', 0, 14,
                 '{"startOffset":0,"endOffset":14}', 0, 1.0, 0,
                 '{"citationNumber":1}', ?)`,
    )
    .run(
      sourceId,
      messageId,
      seed.documentId,
      seed.versionId,
      seed.chunkId,
      NOW,
    );
  return { chatId, messageId, sourceId };
}

try {
  process.env.ALETHEIA_DATABASE_ENCRYPTION = "metadata_plaintext";

  const v10Path = path.join(root, "v10-upgrade.db");
  const v10 = new WorkspaceDatabase(v10Path, {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 10),
  });
  const legacySeed = seedProjectDocument(v10, "legacy");
  const legacyCitation = seedLegacyCitation(v10, legacySeed);
  const legacyChunkBefore = v10
    .prepare("SELECT * FROM document_chunks WHERE id = ?")
    .get(legacySeed.chunkId);
  const legacySourceBefore = v10
    .prepare("SELECT * FROM message_sources WHERE id = ?")
    .get(legacyCitation.sourceId);
  const v11Run = v10.runMigrations(WORKSPACE_MIGRATIONS.slice(0, 11));
  assert.equal(v11Run.currentVersion, 11);
  assert.deepEqual(
    v11Run.applied.map((migration) => migration.version),
    [11],
  );
  assert.equal(
    v10
      .prepare(
        "SELECT checksum FROM workspace_schema_migrations WHERE version = 11",
      )
      .get()?.checksum,
    workspaceMigrationChecksum(PROJECT_SOURCE_FOUNDATION_V11_MIGRATION),
  );
  assert.throws(
    () =>
      v10.runMigrations([
        ...WORKSPACE_MIGRATIONS.slice(0, 10),
        {
          ...PROJECT_SOURCE_FOUNDATION_V11_MIGRATION,
          checksumMaterial: `${PROJECT_SOURCE_FOUNDATION_V11_MIGRATION.checksumMaterial}\nforced drift probe`,
        },
      ]),
    /checksum drift/i,
  );
  assert.deepEqual(
    v10.prepare("SELECT * FROM document_chunks WHERE id = ?").get(legacySeed.chunkId),
    legacyChunkBefore,
  );
  assert.deepEqual(
    v10
      .prepare("SELECT * FROM message_sources WHERE id = ?")
      .get(legacyCitation.sourceId),
    legacySourceBefore,
  );
  assert.equal(v10.prepare("PRAGMA foreign_key_check").all().length, 0);
  v10.close();

  const database = new WorkspaceDatabase(path.join(root, "fresh.db"), {
    migrations: WORKSPACE_MIGRATIONS.slice(0, 11),
  });
  assert.equal(database.migration?.currentVersion, 11);
  const repository = new WorkspaceSourceFoundationRepository(database);
  const seed = seedProjectDocument(database, "fresh");

  const documentSnapshot = repository.createSnapshot(
    projectDocumentSnapshotInput(seed),
  );
  assert.equal(documentSnapshot.contentSha256, DOCUMENT_HASH);
  assert.equal(documentSnapshot.sourceKind, "project_document");
  assert.deepEqual(repository.listSnapshots({ projectId: seed.projectId }), [
    documentSnapshot,
  ]);

  const contradictoryRawSnapshotId = randomUUID();
  assert.throws(
    () =>
      insertRawSourceSnapshot(database, {
        id: contradictoryRawSnapshotId,
        projectId: seed.projectId,
        sourceKind: "legal_authority",
        sourceRecordId: "raw-undeclared-overgrant",
        sourceVersionId: null,
        titleSnapshot: "Undeclared authority with contradictory grants",
        contentSha256: "c".repeat(64),
        license: {
          basis: "not_declared",
          retention: "full_text_permitted",
          export: "permitted",
          modelUse: "permitted",
        },
        retentionExpiresAt: null,
      }),
    /license policy is invalid/i,
  );
  assert.equal(
    database
      .prepare("SELECT id FROM project_source_snapshots WHERE id = ?")
      .get(contradictoryRawSnapshotId),
    undefined,
  );

  const undeclaredRawSnapshotId = randomUUID();
  insertRawSourceSnapshot(database, {
    id: undeclaredRawSnapshotId,
    projectId: seed.projectId,
    sourceKind: "legal_authority",
    sourceRecordId: "raw-undeclared-authority",
    sourceVersionId: null,
    titleSnapshot: "Authority with no declared data-use rights",
    contentSha256: "d".repeat(64),
    license: {
      basis: "not_declared",
      retention: "not_declared",
      export: "not_declared",
      modelUse: "not_declared",
    },
    retentionExpiresAt: null,
  });
  assert.deepEqual(
    repository.getSnapshot(seed.projectId, undeclaredRawSnapshotId)?.license,
    {
      basis: "not_declared",
      retention: "not_declared",
      export: "not_declared",
      modelUse: "not_declared",
    },
  );

  const userProvidedRawSnapshotId = randomUUID();
  insertRawSourceSnapshot(database, {
    id: userProvidedRawSnapshotId,
    projectId: seed.projectId,
    sourceKind: "project_document",
    sourceRecordId: seed.documentId,
    sourceVersionId: seed.versionId,
    titleSnapshot: "User-provided Project document",
    contentSha256: DOCUMENT_HASH,
    license: {
      basis: "user_provided",
      retention: "full_text_permitted",
      export: "permitted",
      modelUse: "local_only",
    },
    retentionExpiresAt: null,
  });
  assert.equal(
    repository.getSnapshot(seed.projectId, userProvidedRawSnapshotId)?.license
      .basis,
    "user_provided",
  );

  const exactQuote = "Payment is due in thirty days.";
  const documentAnchor = repository.createCitationAnchor({
    id: randomUUID(),
    projectId: seed.projectId,
    snapshotId: documentSnapshot.id,
    ordinal: 0,
    exactQuote,
    locator: {
      documentVersionId: seed.versionId,
      chunkId: seed.chunkId,
      page: 1,
      startOffset: 0,
      endOffset: exactQuote.length,
    },
    createdAt: NOW,
  });
  assert.equal(
    documentAnchor.quoteSha256,
    sourceCitationQuoteSha256V11(exactQuote),
  );
  assert.deepEqual(
    repository.listCitationAnchors({
      projectId: seed.projectId,
      snapshotId: documentSnapshot.id,
    }),
    [documentAnchor],
  );

  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE project_source_snapshots SET title_snapshot = 'changed' WHERE id = ?",
        )
        .run(documentSnapshot.id),
    /immutable/i,
  );
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE source_citation_anchors SET exact_quote = 'changed' WHERE id = ?",
        )
        .run(documentAnchor.id),
    /immutable/i,
  );

  assert.throws(
    () =>
      repository.createSnapshot({
        ...projectDocumentSnapshotInput(seed),
        id: randomUUID(),
        contentSha256: "c".repeat(64),
      }),
    WorkspaceSourceFoundationRepositoryError,
  );
  assert.throws(
    () =>
      repository.createSnapshot({
        ...legalSnapshotInput(seed.projectId),
        id: randomUUID(),
        license: {
          basis: "not_declared",
          retention: "full_text_permitted",
          export: "permitted",
          modelUse: "permitted",
        },
        retentionPolicy: "full_text_permitted",
        retentionExpiresAt: null,
      }),
    WorkspaceSourceFoundationRepositoryError,
  );
  assert.throws(
    () =>
      repository.createSnapshot({
        ...legalSnapshotInput(seed.projectId),
        id: randomUUID(),
        retrievalMetadata: {
          detail: "helper failed at /Users/alice/private/source.json",
        },
      }),
    WorkspaceSourceFoundationRepositoryError,
  );
  assert.throws(
    () =>
      repository.createSnapshot({
        ...legalSnapshotInput(seed.projectId),
        id: randomUUID(),
        retrievalMetadata: { filePath: "/tmp/secret" },
      }),
    WorkspaceSourceFoundationRepositoryError,
  );
  assert.throws(
    () =>
      repository.createSnapshot({
        ...legalSnapshotInput(seed.projectId),
        id: randomUUID(),
        retentionExpiresAt: NOW,
      }),
    WorkspaceSourceFoundationRepositoryError,
  );

  const legalSnapshot = repository.createSnapshot(
    legalSnapshotInput(seed.projectId),
  );
  assert.equal(legalSnapshot.contentSha256, LEGAL_HASH);
  const legalAnchor = repository.createCitationAnchor({
    id: randomUUID(),
    projectId: seed.projectId,
    snapshotId: legalSnapshot.id,
    ordinal: 0,
    exactQuote: "The authority applies to this clause.",
    locator: { section: "12(3)", paragraph: 4 },
    createdAt: NOW,
  });

  const wrongHashAnchorId = randomUUID();
  database
    .prepare(
      `INSERT INTO source_citation_anchors (
         id, project_id, snapshot_id, ordinal, exact_quote,
         quote_sha256, locator_json, created_at
       ) VALUES (?, ?, ?, 1, 'Tampered quote', ?, '{}', ?)`,
    )
    .run(
      wrongHashAnchorId,
      seed.projectId,
      legalSnapshot.id,
      "0".repeat(64),
      NOW,
    );
  assert.throws(
    () => repository.getCitationAnchor(seed.projectId, wrongHashAnchorId),
    /no longer matches/i,
  );

  database.prepare("DELETE FROM documents WHERE id = ?").run(seed.documentId);
  assert.ok(repository.getSnapshot(seed.projectId, documentSnapshot.id));
  assert.ok(repository.getCitationAnchor(seed.projectId, documentAnchor.id));

  const deletionProject = seedProjectDocument(database, "delete-snapshot");
  const deletionSnapshot = repository.createSnapshot(
    projectDocumentSnapshotInput(deletionProject),
  );
  const deletionAnchor = repository.createCitationAnchor({
    id: randomUUID(),
    projectId: deletionProject.projectId,
    snapshotId: deletionSnapshot.id,
    ordinal: 0,
    exactQuote: "Retention deletion quote.",
    locator: { page: 1 },
    createdAt: NOW,
  });
  database
    .prepare("DELETE FROM project_source_snapshots WHERE id = ?")
    .run(deletionSnapshot.id);
  assert.equal(
    repository.getCitationAnchor(deletionProject.projectId, deletionAnchor.id),
    null,
  );
  assert.ok(
    database
      .prepare("SELECT id FROM projects WHERE id = ?")
      .get(deletionProject.projectId),
  );

  database.prepare("DELETE FROM projects WHERE id = ?").run(seed.projectId);
  assert.equal(repository.getSnapshot(seed.projectId, documentSnapshot.id), null);
  assert.equal(repository.getSnapshot(seed.projectId, legalSnapshot.id), null);
  assert.equal(
    database
      .prepare(
        "SELECT count(*) AS count FROM source_citation_anchors WHERE id IN (?, ?)",
      )
      .get(documentAnchor.id, legalAnchor.id)?.count,
    0,
  );
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  database.close();

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        suite: "vera-workspace-source-foundation-v11",
        checks: [
          "v10 to v11 is additive and preserves document chunks and message sources",
          "Project document snapshots bind live Project version and content hash",
          "legal adapter sha256 prefix canonicalizes to bare persisted hex",
          "raw SQL rejects undeclared authorization grants but accepts fully undeclared and user-provided policies",
          "license retention policy and ISO expiry are fail-closed",
          "v11 upgrade records the current checksum and rejects checksum drift",
          "transport metadata rejects secret and filesystem-path fields",
          "citation quote hashes are derived and revalidated on read",
          "snapshots and anchors reject updates",
          "document deletion preserves provenance while Project deletion cascades",
          "explicit snapshot retention deletion cascades owned anchors only",
        ],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  process.env = originalEnvironment;
  rmSync(root, { recursive: true, force: true });
}
