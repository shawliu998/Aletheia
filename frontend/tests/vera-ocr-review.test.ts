import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  listVeraDocuments,
  VeraApiError,
} from "../src/app/lib/veraApi.ts";

const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";
const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "vdt_1234567890abcdefghijklmnopqrstuvwxyz";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    engine: "apple-vision",
    ocr_page_count: 4,
    low_confidence_pages: [2, 4],
    low_confidence_page_count: 2,
    low_confidence_pages_truncated: false,
    review_required: true,
    ...overrides,
  };
}

function documentWire(ocrSummary: unknown) {
  return {
    id: DOCUMENT_ID,
    user_id: LOCAL_USER_ID,
    project_id: PROJECT_ID,
    folder_id: null,
    filename: "scanned-evidence.pdf",
    owner_email: null,
    owner_display_name: "Local User",
    file_type: "pdf",
    storage_path: null,
    pdf_storage_path: "local-preview",
    size_bytes: 1024,
    page_count: 4,
    structure_tree: null,
    status: "ready",
    created_at: "2026-07-15T00:00:00.000Z",
    updated_at: "2026-07-15T00:00:00.000Z",
    active_version_number: 1,
    latest_version_number: 1,
    ocr_summary: ocrSummary,
  };
}

test("Workspace document OCR wire accepts a bounded summary and rejects contradictions", async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      aletheiaDesktop: {
        async getInfo() {
          return { workspaceApiUrl: "http://127.0.0.1:43123/api/v1" };
        },
        async getAuthToken() {
          return TOKEN;
        },
      },
    },
  });
  const originalFetch = globalThis.fetch;
  let responseSummary: unknown = summary();
  globalThis.fetch = async () =>
    new Response(JSON.stringify([documentWire(responseSummary)]), {
      headers: { "Content-Type": "application/json" },
    });

  try {
    const [document] = await listVeraDocuments();
    assert.deepEqual(document?.ocr_summary, summary());

    for (const contradictory of [
      summary({ review_required: false }),
      summary({
        low_confidence_pages: [],
        low_confidence_pages_truncated: false,
      }),
      summary({ low_confidence_pages_truncated: true }),
      summary({ low_confidence_pages: [4, 2] }),
      summary({ blocks: [{ text: "must not enter the wire" }] }),
      summary({ engine: "unknown-engine" }),
    ]) {
      responseSummary = contradictory;
      await assert.rejects(
        listVeraDocuments(),
        (error: unknown) =>
          error instanceof VeraApiError && error.code === "INVALID_RESPONSE",
      );
    }

    responseSummary = summary({
      ocr_page_count: 3,
      low_confidence_pages: [],
      low_confidence_page_count: 0,
      review_required: false,
    });
    assert.equal(
      (await listVeraDocuments())[0]?.ocr_summary?.review_required,
      false,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("Project OCR UI uses Mike-style badges and names the review action", () => {
  const project = source(
    "src/app/components/projects/ProjectDocumentsView.tsx",
  );
  const sidePanel = source(
    "src/app/components/projects/DocumentSidePanel.tsx",
  );
  const messages = source("src/app/i18n/messages.ts");
  const transport = source("src/app/lib/veraApi.ts");

  assert.match(project, /OcrStatusBadges/);
  assert.match(project, /bg-gray-100[\s\S]*documents\.ocr\.used/);
  assert.match(project, /review_required[\s\S]*AlertCircle/);
  assert.match(project, /documents\.ocr\.reviewRequired/);
  assert.match(sidePanel, /isCurrent && doc\.ocr_summary/);
  assert.match(sidePanel, /low_confidence_pages_truncated/);
  assert.match(messages, /reviewRequired: "需要复核"/);
  assert.match(messages, /reviewRequired: "Review required"/);
  assert.match(transport, /lowConfidencePageCount > ocrPageCount/);
  assert.match(transport, /lowConfidencePages\.length !== 50/);
  assert.doesNotMatch(
    `${project}\n${sidePanel}`,
    /boundingBox|pageConfidence|metadata_json|local-secret|password=/,
  );
});
