import assert from "node:assert/strict";
import test from "node:test";

import {
  listVeraProjectDocuments,
  VeraApiError,
} from "../src/app/lib/veraApi.ts";
import {
  createVeraStudioDocument,
  exportVeraStudioDocx,
  getVeraStudioDocument,
  importVeraStudioDocx,
  listVeraStudioVersions,
  parseVeraStudioDocument,
  parseVeraStudioDocxImport,
  parseVeraStudioVersions,
  restoreVeraStudioVersion,
  saveVeraStudioDocument,
  VERA_STUDIO_DOCX_MIME_TYPE,
} from "../src/app/lib/veraDocumentStudioApi.ts";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "22222222-2222-4222-8222-222222222222";
const CURRENT_VERSION_ID = "33333333-3333-4333-8333-333333333333";
const HISTORY_VERSION_ID = "44444444-4444-4444-8444-444444444444";
const IMPORT_VERSION_ID = "77777777-7777-4777-8777-777777777777";
const ANCHOR_ID = "55555555-5555-4555-8555-555555555555";
const SNAPSHOT_ID = "66666666-6666-4666-8666-666666666666";
const TOKEN = "vdt_1234567890abcdefghijklmnopqrstuvwxyz";
const HASH = "a".repeat(64);

function studioDocument(overrides: Record<string, unknown> = {}) {
  return {
    document_id: DOCUMENT_ID,
    project_id: PROJECT_ID,
    title: "Contract review memo",
    filename: "contract-review-memo.md",
    format: "markdown",
    current_version_id: CURRENT_VERSION_ID,
    version: {
      id: CURRENT_VERSION_ID,
      version_number: 2,
      source: "user_upload",
      filename: "contract-review-memo.md",
      mime_type: "text/markdown",
      size_bytes: 120,
      content_sha256: HASH,
      created_at: "2026-07-15T10:00:00.000Z",
      citation_anchor_ids: [ANCHOR_ID],
    },
    content: "# Contract review\n\nCurrent draft.",
    citation_anchors: [
      {
        id: ANCHOR_ID,
        snapshot_id: SNAPSHOT_ID,
        ordinal: 0,
        exact_quote: "Payment is due on 1 September 2026.",
        quote_sha256: HASH,
        locator: {
          page: 2,
          boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.08 },
        },
      },
    ],
    capabilities: { docx_import: true, docx_export: true },
    ...overrides,
  };
}

function versions() {
  return {
    current_version_id: CURRENT_VERSION_ID,
    versions: [
      {
        id: CURRENT_VERSION_ID,
        version_number: 2,
        source: "user_upload",
        filename: "contract-review-memo.md",
        mime_type: "text/markdown",
        size_bytes: 120,
        content_sha256: HASH,
        created_at: "2026-07-15T10:00:00.000Z",
        citation_anchor_ids: [ANCHOR_ID],
      },
      {
        id: HISTORY_VERSION_ID,
        version_number: 1,
        source: "assistant_edit",
        filename: "contract-review-memo.md",
        mime_type: "text/markdown",
        size_bytes: 80,
        content_sha256: "b".repeat(64),
        created_at: "2026-07-15T09:00:00.000Z",
        citation_anchor_ids: [],
      },
    ],
  };
}

function installDesktop() {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window");
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
  return () => {
    if (prior) Object.defineProperty(globalThis, "window", prior);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

test("Studio parser accepts current and historical immutable versions with real citations", () => {
  const current = parseVeraStudioDocument(studioDocument());
  assert.equal(current.version.id, current.current_version_id);
  assert.equal(current.citation_anchors[0]?.locator.page, 2);
  assert.deepEqual(current.capabilities, {
    docx_import: true,
    docx_export: true,
  });

  const historical = parseVeraStudioDocument(
    studioDocument({
      version: {
        id: HISTORY_VERSION_ID,
        version_number: 1,
        source: "assistant_edit",
        filename: "contract-review-memo.md",
        mime_type: "text/markdown",
        size_bytes: 80,
        content_sha256: "b".repeat(64),
        created_at: "2026-07-15T09:00:00.000Z",
        citation_anchor_ids: [],
      },
      content: "# Historical draft",
      citation_anchors: [],
    }),
  );
  assert.equal(historical.current_version_id, CURRENT_VERSION_ID);
  assert.equal(historical.version.id, HISTORY_VERSION_ID);
  assert.equal(parseVeraStudioVersions(versions()).versions.length, 2);
});

test("Studio parser fails closed on extra fields, invalid provenance, and unsafe locator depth", () => {
  assert.throws(
    () => parseVeraStudioDocument(studioDocument({ storage_path: "/private" })),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraStudioDocument(
        studioDocument({
          version: {
            ...studioDocument().version,
            source: "unknown_source",
          },
        }),
      ),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraStudioDocument(
        studioDocument({
          version: {
            ...studioDocument().version,
            mime_type: "text/plain",
          },
        }),
      ),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraStudioDocument(
        studioDocument({
          capabilities: { docx_import: false, docx_export: true },
        }),
      ),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraStudioDocument(
        studioDocument({
          citation_anchors: [
            {
              ...studioDocument().citation_anchors[0],
              quote_sha256: HASH.toUpperCase(),
            },
          ],
        }),
      ),
    VeraApiError,
  );
  let nested: Record<string, unknown> = { page: 1 };
  for (let index = 0; index < 10; index += 1) nested = { child: nested };
  assert.throws(
    () =>
      parseVeraStudioDocument(
        studioDocument({
          citation_anchors: [
            { ...studioDocument().citation_anchors[0], locator: nested },
          ],
        }),
      ),
    VeraApiError,
  );
});

test("Studio transport uses only Project-scoped create, load, CAS save, list, and restore routes", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: URL; init?: RequestInit; body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    const value = url.pathname.endsWith("/versions")
      ? versions()
      : url.searchParams.get("version_id") === HISTORY_VERSION_ID
        ? studioDocument({
            version: {
              id: HISTORY_VERSION_ID,
              version_number: 1,
              source: "assistant_edit",
              filename: "contract-review-memo.md",
              mime_type: "text/markdown",
              size_bytes: 80,
              content_sha256: "b".repeat(64),
              created_at: "2026-07-15T09:00:00.000Z",
              citation_anchor_ids: [],
            },
            content: "# Historical draft",
            citation_anchors: [],
          })
        : studioDocument();
    return new Response(JSON.stringify(value), {
      status: init?.method === "POST" ? 201 : 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await createVeraStudioDocument(PROJECT_ID, {
      title: "  Contract review memo  ",
      folder_id: null,
    });
    await getVeraStudioDocument(PROJECT_ID, DOCUMENT_ID);
    const history = await getVeraStudioDocument(
      PROJECT_ID,
      DOCUMENT_ID,
      HISTORY_VERSION_ID,
    );
    assert.equal(history.version.id, HISTORY_VERSION_ID);
    await saveVeraStudioDocument(PROJECT_ID, DOCUMENT_ID, {
      expected_version_id: CURRENT_VERSION_ID,
      content: "# Updated contract review",
      source: "user_upload",
      citation_anchor_ids: [ANCHOR_ID],
      summary: "Counsel edit",
    });
    await listVeraStudioVersions(PROJECT_ID, DOCUMENT_ID);
    await restoreVeraStudioVersion(
      PROJECT_ID,
      DOCUMENT_ID,
      HISTORY_VERSION_ID,
      { expected_current_version_id: CURRENT_VERSION_ID },
    );

    assert.equal(calls.length, 6);
    const root = `/api/v1/projects/${PROJECT_ID}/studio/documents`;
    assert.equal(calls[0]?.url.pathname, root);
    assert.equal(calls[0]?.init?.method, "POST");
    assert.deepEqual(calls[0]?.body, {
      title: "Contract review memo",
      folder_id: null,
    });
    assert.equal(calls[1]?.url.pathname, `${root}/${DOCUMENT_ID}`);
    assert.equal(calls[1]?.url.search, "");
    assert.equal(
      calls[2]?.url.searchParams.get("version_id"),
      HISTORY_VERSION_ID,
    );
    assert.equal(calls[3]?.init?.method, "PUT");
    assert.deepEqual(calls[3]?.body, {
      expected_version_id: CURRENT_VERSION_ID,
      content: "# Updated contract review",
      source: "user_upload",
      citation_anchor_ids: [ANCHOR_ID],
      summary: "Counsel edit",
    });
    assert.equal(calls[4]?.url.pathname, `${root}/${DOCUMENT_ID}/versions`);
    assert.equal(
      calls[5]?.url.pathname,
      `${root}/${DOCUMENT_ID}/versions/${HISTORY_VERSION_ID}/restore`,
    );
    assert.deepEqual(calls[5]?.body, {
      expected_current_version_id: CURRENT_VERSION_ID,
    });
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get("Authorization"), `Bearer ${TOKEN}`);
      assert.equal(call.url.hostname, "127.0.0.1");
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Studio current load rejects a historical version as the editable CAS baseline", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify(
        studioDocument({
          version: {
            ...studioDocument().version,
            id: HISTORY_VERSION_ID,
            version_number: 1,
          },
          content: "# Historical response presented as current",
        }),
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  try {
    await assert.rejects(
      getVeraStudioDocument(PROJECT_ID, DOCUMENT_ID),
      VeraApiError,
    );
    const historical = await getVeraStudioDocument(
      PROJECT_ID,
      DOCUMENT_ID,
      HISTORY_VERSION_ID,
    );
    assert.equal(historical.version.id, HISTORY_VERSION_ID);
    assert.equal(historical.current_version_id, CURRENT_VERSION_ID);
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Studio CAS conflict remains an explicit 409 and invalid citation writes never reach fetch", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        code: "CONFLICT",
        detail: "Document has changed since the expected version.",
      }),
      {
        status: 409,
        headers: { "Content-Type": "application/json" },
      },
    );
  };
  try {
    await assert.rejects(
      saveVeraStudioDocument(PROJECT_ID, DOCUMENT_ID, {
        expected_version_id: CURRENT_VERSION_ID,
        content: "local edits",
        source: "user_upload",
      }),
      (error) =>
        error instanceof VeraApiError &&
        error.status === 409 &&
        error.code === "CONFLICT",
    );
    assert.equal(calls, 1);
    await assert.rejects(
      saveVeraStudioDocument(PROJECT_ID, DOCUMENT_ID, {
        expected_version_id: CURRENT_VERSION_ID,
        content: "local edits",
        source: "user_upload",
        citation_anchor_ids: [ANCHOR_ID, ANCHOR_ID],
      }),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Studio DOCX transport sends strict multipart CAS input and exports the exact immutable version", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname.endsWith("/import-docx")) {
      return new Response(
        JSON.stringify({
          document: studioDocument({
            current_version_id: IMPORT_VERSION_ID,
            version: {
              ...studioDocument().version,
              id: IMPORT_VERSION_ID,
              version_number: 3,
              source: "user_upload",
            },
            content: "# Imported DOCX",
          }),
          warnings: ["DOCX_FORMATTING_SIMPLIFIED"],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(new Uint8Array([80, 75, 3, 4]), {
      status: 200,
      headers: {
        "Content-Type": VERA_STUDIO_DOCX_MIME_TYPE,
        "Content-Disposition": 'attachment; filename="route-audit.docx"',
        "X-Vera-Warning-Codes":
          "MARKDOWN_HTML_AS_TEXT,MARKDOWN_BLOCKQUOTE_SIMPLIFIED",
      },
    });
  };

  try {
    const file = new File([new Uint8Array([80, 75, 3, 4])], "motion.docx", {
      type: VERA_STUDIO_DOCX_MIME_TYPE,
    });
    const imported = await importVeraStudioDocx(
      PROJECT_ID,
      DOCUMENT_ID,
      CURRENT_VERSION_ID,
      file,
    );
    assert.equal(imported.document.current_version_id, IMPORT_VERSION_ID);
    assert.deepEqual(imported.warnings, ["DOCX_FORMATTING_SIMPLIFIED"]);

    const downloaded = await exportVeraStudioDocx(
      PROJECT_ID,
      DOCUMENT_ID,
      HISTORY_VERSION_ID,
    );
    assert.equal(downloaded.filename, "route-audit.docx");
    assert.equal(downloaded.blob.type, VERA_STUDIO_DOCX_MIME_TYPE);
    assert.deepEqual(downloaded.warningCodes, [
      "MARKDOWN_HTML_AS_TEXT",
      "MARKDOWN_BLOCKQUOTE_SIMPLIFIED",
    ]);

    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.init?.method, "POST");
    assert.equal(
      calls[0]?.url.pathname,
      `/api/v1/projects/${PROJECT_ID}/studio/documents/${DOCUMENT_ID}/import-docx`,
    );
    const form = calls[0]?.init?.body;
    assert.ok(form instanceof FormData);
    assert.deepEqual([...form.keys()], ["expected_version_id", "file"]);
    assert.equal(form.get("expected_version_id"), CURRENT_VERSION_ID);
    const uploaded = form.get("file");
    assert.ok(uploaded instanceof File);
    assert.equal(uploaded.name, "motion.docx");
    assert.equal(
      new Headers(calls[0]?.init?.headers).has("content-type"),
      false,
    );
    assert.equal(
      calls[1]?.url.pathname,
      `/api/v1/projects/${PROJECT_ID}/studio/documents/${DOCUMENT_ID}/export-docx`,
    );
    assert.equal(
      calls[1]?.url.searchParams.get("version_id"),
      HISTORY_VERSION_ID,
    );
    for (const call of calls) {
      assert.equal(
        new Headers(call.init?.headers).get("Authorization"),
        `Bearer ${TOKEN}`,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Studio DOCX client fails closed on poisoned import bodies, files, and warning headers", async () => {
  assert.throws(
    () =>
      parseVeraStudioDocxImport({
        document: studioDocument(),
        warnings: ["UNKNOWN_WARNING"],
      }),
    VeraApiError,
  );
  assert.throws(
    () =>
      parseVeraStudioDocxImport({
        document: studioDocument(),
        warnings: [],
        storage_path: "/private/secret",
      }),
    VeraApiError,
  );

  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(new Uint8Array([80, 75, 3, 4]), {
      status: 200,
      headers: {
        "Content-Type": VERA_STUDIO_DOCX_MIME_TYPE,
        "Content-Disposition": 'attachment; filename="safe.docx"',
        "X-Vera-Warning-Codes":
          "MARKDOWN_HTML_AS_TEXT,MARKDOWN_HTML_AS_TEXT",
      },
    });
  };
  try {
    await assert.rejects(
      exportVeraStudioDocx(PROJECT_ID, DOCUMENT_ID, CURRENT_VERSION_ID),
      (error) =>
        error instanceof VeraApiError && error.code === "INVALID_RESPONSE",
    );
    assert.equal(calls, 1);
    await assert.rejects(
      importVeraStudioDocx(
        PROJECT_ID,
        DOCUMENT_ID,
        CURRENT_VERSION_ID,
        new File([], "empty.docx", { type: VERA_STUDIO_DOCX_MIME_TYPE }),
      ),
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});

test("Project document parser accepts only coherent real Studio capability combinations", async () => {
  const restoreDesktop = installDesktop();
  const originalFetch = globalThis.fetch;
  let capability: Record<string, unknown> = {
    editable: true,
    format: "markdown",
    docx_import: true,
    docx_export: true,
  };
  const projectedDocument = () => ({
    id: DOCUMENT_ID,
    user_id: "00000000-0000-4000-8000-000000000001",
    project_id: PROJECT_ID,
    folder_id: null,
    filename: "contract-review-memo.md",
    owner_email: null,
    owner_display_name: "Local User",
    file_type: "md",
    storage_path: null,
    pdf_storage_path: null,
    size_bytes: 120,
    page_count: null,
    structure_tree: null,
    status: "ready",
    created_at: "2026-07-15T10:00:00.000Z",
    updated_at: "2026-07-15T10:00:00.000Z",
    active_version_number: 2,
    latest_version_number: 2,
    ocr_summary: null,
    studio_capability: capability,
  });
  globalThis.fetch = async () =>
    new Response(JSON.stringify([projectedDocument()]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  try {
    assert.equal((await listVeraProjectDocuments(PROJECT_ID)).length, 1);
    capability = {
      editable: false,
      format: null,
      docx_import: false,
      docx_export: false,
    };
    assert.equal((await listVeraProjectDocuments(PROJECT_ID)).length, 1);
    for (const poisoned of [
      {
        editable: true,
        format: "markdown",
        docx_import: false,
        docx_export: true,
      },
      {
        editable: false,
        format: "markdown",
        docx_import: false,
        docx_export: false,
      },
      {
        editable: false,
        format: null,
        docx_import: true,
        docx_export: false,
      },
    ]) {
      capability = poisoned;
      await assert.rejects(
        listVeraProjectDocuments(PROJECT_ID),
        VeraApiError,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreDesktop();
  }
});
