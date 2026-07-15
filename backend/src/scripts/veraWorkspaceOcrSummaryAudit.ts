import assert from "node:assert/strict";

import type {
  WorkspaceDatabaseAdapter,
  WorkspaceStatement,
} from "../lib/workspace/migrations/types";
import {
  MAX_PUBLIC_OCR_LOW_CONFIDENCE_PAGES,
  serializeWorkspaceDocumentOcrSummary,
  WorkspaceDocumentOcrSummaryService,
} from "../lib/workspace/services/documentOcrSummary";

type Row = Record<string, unknown>;

class ChunkFixtureDatabase implements WorkspaceDatabaseAdapter {
  readonly calls: Array<{ sql: string; parameters: unknown[] }> = [];

  constructor(private readonly rowsByVersion: ReadonlyMap<string, Row[]>) {}

  exec(): void {}

  prepare(sql: string): WorkspaceStatement {
    assert.match(sql, /FROM document_chunks/);
    return {
      run: () => undefined,
      get: () => undefined,
      all: (...parameters: unknown[]) => {
        this.calls.push({ sql, parameters });
        const versionId = String(parameters[1]);
        return this.rowsByVersion.get(versionId) ?? [];
      },
    };
  }
}

function ocrRow(
  page: number,
  confidence: number,
  text = `OCR page ${page}`,
): Row {
  return {
    text,
    page_start: page,
    page_end: page,
    metadata_json: JSON.stringify({
      schemaVersion: "vera-document-chunk-ocr-v1",
      engine: "apple-vision",
      coordinateSpace: null,
      page,
      chunkPageTextStart: 0,
      pageConfidence: confidence,
      lowConfidence: confidence < 0.5,
      blocks: [],
    }),
  };
}

function emptyRow(): Row {
  return {
    text: "native text layer",
    page_start: 1,
    page_end: 1,
    metadata_json: "{}",
  };
}

function summarize(rowsByVersion: ReadonlyMap<string, Row[]>, version: string) {
  const database = new ChunkFixtureDatabase(rowsByVersion);
  const service = new WorkspaceDocumentOcrSummaryService(database);
  const result = service.summarize({
    id: "document-current",
    currentVersionId: version,
  });
  return { database, result };
}

function run() {
  const currentVersion = "version-current";
  const oldVersion = "version-old";

  const currentOnly = summarize(
    new Map([
      [currentVersion, [ocrRow(4, 0.91)]],
      [oldVersion, [ocrRow(1, 0.12)]],
    ]),
    currentVersion,
  );
  assert.deepEqual(currentOnly.database.calls[0]?.parameters, [
    "document-current",
    currentVersion,
  ]);
  assert.deepEqual(currentOnly.result?.lowConfidencePages, []);
  assert.equal(currentOnly.result?.reviewRequired, false);

  const noOcr = summarize(
    new Map([[currentVersion, [emptyRow()]]]),
    currentVersion,
  );
  assert.equal(noOcr.result, null);
  assert.equal(
    new WorkspaceDocumentOcrSummaryService(noOcr.database).summarize({
      id: "document-current",
      currentVersionId: null,
    }),
    null,
  );

  const mixed = summarize(
    new Map([
      [
        currentVersion,
        [
          ocrRow(2, 0.31, "first chunk"),
          ocrRow(2, 0.31, "second chunk"),
          ocrRow(3, 0.94),
        ],
      ],
    ]),
    currentVersion,
  ).result;
  assert.deepEqual(mixed, {
    engine: "apple-vision",
    ocrPageCount: 2,
    lowConfidencePages: [2],
    lowConfidencePageCount: 1,
    lowConfidencePagesTruncated: false,
    reviewRequired: true,
  });

  const bounded = summarize(
    new Map([
      [
        currentVersion,
        Array.from({ length: 55 }, (_, index) => ocrRow(index + 1, 0.2)),
      ],
    ]),
    currentVersion,
  ).result;
  assert.equal(
    bounded?.lowConfidencePages.length,
    MAX_PUBLIC_OCR_LOW_CONFIDENCE_PAGES,
  );
  assert.equal(bounded?.lowConfidencePageCount, 55);
  assert.equal(bounded?.lowConfidencePagesTruncated, true);
  assert.deepEqual(bounded?.lowConfidencePages.slice(-2), [49, 50]);

  assert.throws(
    () =>
      summarize(
        new Map([[currentVersion, [ocrRow(7, 0.2), ocrRow(7, 0.3)]]]),
        currentVersion,
      ),
    /OCR metadata is invalid/,
  );
  assert.throws(
    () =>
      summarize(
        new Map([
          [
            currentVersion,
            [
              {
                ...emptyRow(),
                metadata_json: JSON.stringify({ unknown: true }),
              },
            ],
          ],
        ]),
        currentVersion,
      ),
    /chunk metadata is invalid/,
  );

  const secret = "/Users/alice/private.pdf Bearer local-secret password=hidden";
  const safeSummary = summarize(
    new Map([[currentVersion, [ocrRow(9, 0.19, secret)]]]),
    currentVersion,
  ).result;
  const wire = serializeWorkspaceDocumentOcrSummary(safeSummary);
  assert.deepEqual(Object.keys(wire ?? {}).sort(), [
    "engine",
    "low_confidence_page_count",
    "low_confidence_pages",
    "low_confidence_pages_truncated",
    "ocr_page_count",
    "review_required",
  ]);
  const serialized = JSON.stringify(wire);
  for (const forbidden of [
    "blocks",
    "boundingBox",
    "pageConfidence",
    "/Users/",
    "Bearer",
    "password",
    "local-secret",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      checks: [
        "current-version-only",
        "page-deduplication-and-consistency",
        "bounded-low-confidence-pages",
        "no-ocr-null",
        "high-and-low-confidence",
        "damaged-metadata-fail-closed",
        "transport-safe-summary",
      ],
    })}\n`,
  );
}

run();
