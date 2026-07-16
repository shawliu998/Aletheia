import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "@playwright/test";
import {
  deleteVeraDocument,
  listVeraProjects,
  retryVeraDocumentParse,
  uploadVeraDocument,
  uploadVeraDocumentVersion,
} from "../src/app/lib/veraApi.ts";

const LOCKED_MIKE_SHA = "e32daad5a4c64a5561e04c53ee12411e3c5e7238";
const FRONTEND_ROOT = path.resolve(__dirname, "..");
const LOCK_MANIFEST_PATH = path.join(
  FRONTEND_ROOT,
  "tests/fixtures/mike/e32daad5a4c64a5561e04c53ee12411e3c5e7238/manifest.json",
);

const SOURCES = {
  page: "frontend/src/app/(pages)/projects/page.tsx",
  overview: "frontend/src/app/components/projects/ProjectsOverview.tsx",
  create: "frontend/src/app/components/projects/NewProjectModal.tsx",
  details: "frontend/src/app/components/projects/ProjectDetailsModal.tsx",
  api: "frontend/src/app/lib/mikeApi.ts",
} as const;

type MikeSourceLock = {
  sourcePath: string;
  sha256: string;
};

type MikeSourceManifest = {
  schema: string;
  repository: string;
  commit: string;
  files: MikeSourceLock[];
};

const LOCK_MANIFEST = JSON.parse(
  readFileSync(LOCK_MANIFEST_PATH, "utf8"),
) as MikeSourceManifest;

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function sourceLock(sourcePath: string): MikeSourceLock {
  const lock = LOCK_MANIFEST.files.find(
    (candidate) => candidate.sourcePath === sourcePath,
  );
  assert(lock, `missing locked Mike source: ${sourcePath}`);
  assert.match(lock.sha256, /^[a-f0-9]{64}$/);
  return lock;
}

function assertLockedSource(sourcePath: string, source: string): void {
  assert.equal(
    sha256(source),
    sourceLock(sourcePath).sha256,
    `Mike source bytes changed: ${sourcePath}`,
  );
}

function current(relativePath: string): string {
  return readFileSync(path.join(FRONTEND_ROOT, relativePath), "utf8");
}

function withoutPortHeader(source: string): string {
  return source.replace(
    /\n?\/\/ Direct port of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:\n\/\/ frontend\/src\/app\/[^\n]+\n/,
    "\n",
  );
}

function mikePageSourceFromPort(): string {
  return withoutPortHeader(current("src/app/(pages)/projects/page.tsx"))
    .replace('"use client";\n\n\nimport', '"use client";\n\nimport')
    .replace(
      "  return <ProjectsOverview />;",
      "    return <ProjectsOverview />;",
    );
}

function assertInOrder(source: string, fragments: readonly string[]) {
  let cursor = 0;
  for (const fragment of fragments) {
    const next = source.indexOf(fragment, cursor);
    assert.notEqual(next, -1, `missing ordered Mike fragment: ${fragment}`);
    cursor = next + fragment.length;
  }
}

function classTokens(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/className="([^"]+)"/g)].flatMap((match) =>
      match[1].split(/\s+/).filter(Boolean),
    ),
  );
}

test("all Project overview ports identify the exact locked Mike source", () => {
  assert.equal(LOCK_MANIFEST.schema, "vera-mike-source-lock-v1");
  assert.equal(
    LOCK_MANIFEST.repository,
    "https://github.com/Open-Legal-Products/mike.git",
  );
  assert.equal(LOCK_MANIFEST.commit, LOCKED_MIKE_SHA);
  assert.equal(
    new Set(LOCK_MANIFEST.files.map((entry) => entry.sourcePath)).size,
    LOCK_MANIFEST.files.length,
    "Mike source lock paths are unique",
  );
  for (const sourcePath of Object.values(SOURCES)) {
    sourceLock(sourcePath);
  }

  for (const [file, sourcePath] of [
    ["src/app/(pages)/projects/page.tsx", SOURCES.page],
    ["src/app/components/projects/ProjectsOverview.tsx", SOURCES.overview],
    ["src/app/components/projects/NewProjectModal.tsx", SOURCES.create],
    ["src/app/components/projects/ProjectDetailsModal.tsx", SOURCES.details],
  ] as const) {
    const source = current(file);
    assert.match(source, new RegExp(LOCKED_MIKE_SHA));
    assert.ok(source.includes(sourcePath));
  }
});

test("the route page is syntax-equivalent after provenance and formatting", () => {
  assertLockedSource(SOURCES.page, mikePageSourceFromPort());
});

test("ProjectsOverview preserves Mike state, table, row, and modal ordering", () => {
  const source = current("src/app/components/projects/ProjectsOverview.tsx");
  assertInOrder(source, [
    "useEffect, useRef, useState",
    "useRouter",
    "NewProjectModal",
    "ProjectDetailsModal",
    "TableToolbar",
    "RowActionMenuItems",
    "RowActions",
    "PageHeader",
    "TableScrollArea",
    "const [projects",
    "const [loading",
    "const [loadError",
    "const [modalOpen",
    "const [detailsProject",
    "const [activeFilter",
    "const [selectedIds",
    "const [search",
    "const filtered",
    "const allSelected",
    "const someSelected",
    "function toggleAll",
    "function toggleOne",
    "const filters",
    "const toolbarActions",
    "<PageHeader",
    "<TableToolbar",
    "<TableScrollArea>",
    "<TableHeaderRow>",
    "loading ?",
    "loadError ?",
    "filtered.length === 0",
    "filtered.map",
    "<TableRow",
    "<TablePrimaryCell",
    "<RowActions",
    "<NewProjectModal",
    "<ProjectDetailsModal",
  ]);

  const portClasses = classTokens(source);
  sourceLock(SOURCES.overview);
  for (const token of [
    "absolute",
    "bg-gray-900",
    "bg-white",
    "border",
    "border-gray-100",
    "flex",
    "flex-1",
    "flex-col",
    "font-medium",
    "font-serif",
    "gap-1",
    "h-3.5",
    "h-8",
    "h-full",
    "hover:bg-gray-700",
    "hover:text-gray-900",
    "inline-flex",
    "items-center",
    "justify-end",
    "max-w-xs",
    "min-h-0",
    "ml-auto",
    "overflow-hidden",
    "px-3",
    "py-1.5",
    "relative",
    "right-0",
    "rounded-full",
    "rounded-lg",
    "shadow-lg",
    "shrink-0",
    "text-2xl",
    "text-gray-300",
    "text-gray-700",
    "text-gray-900",
    "text-left",
    "text-red-600",
    "text-white",
    "text-xs",
    "top-full",
    "transition-colors",
    "w-20",
    "w-24",
    "w-3.5",
    "w-32",
    "w-48",
    "w-8",
    "w-full",
    "z-50",
  ]) {
    assert(portClasses.has(token), `missing locked Mike class token: ${token}`);
  }
});

test("new and details modals preserve Mike's interaction skeleton", () => {
  const create = current("src/app/components/projects/NewProjectModal.tsx");
  assertInOrder(create, [
    'useState<"details" | "documents">',
    "const [name",
    "const [pendingFiles",
    "const [loading",
    "const [error",
    "fileInputRef",
    "handleFileChange",
    "handleSubmit",
    "resetForm",
    "<Modal",
    'type="file"',
    "<form",
    'step === "details"',
  ]);
  assert.match(create, /createVeraProject/);
  assert.match(create, /uploadVeraDocument/);
  assert.match(create, /Promise\.allSettled/);

  const details = current(
    "src/app/components/projects/ProjectDetailsModal.tsx",
  );
  assertInOrder(details, [
    "useEffect",
    "useMemo",
    "useState",
    "nameDraft",
    "descriptionDraft",
    "saving",
    "saved",
    "error",
    "hasChanges",
    "handleSave",
    "<Modal",
  ]);
  assert.match(details, /confirmName !== project(?:\?|)\.name/);
  assert.match(details, /projects\.deleteConfirm\.namePrompt/);
  assert.match(details, /projects\.deleteConfirm\.action/);
  assert.match(details, /onArchive/);
  assert.match(details, /onUnarchive/);
});

test("local adaptations remove cloud UI and keep translated, cancellable actions", () => {
  const source = [
    current("src/app/components/projects/ProjectsOverview.tsx"),
    current("src/app/components/projects/NewProjectModal.tsx"),
    current("src/app/components/projects/ProjectDetailsModal.tsx"),
  ].join("\n");

  assert.doesNotMatch(
    source,
    /AuthContext|useAuth|OwnerOnly|AddUserInput|PeopleModal|UserLookupResult|onShareProject|sharedUsers|shared-with-me|Supabase/i,
  );
  assert.doesNotMatch(source, /window\.(?:confirm|prompt|alert)/);
  assert.doesNotMatch(source, /fixture|mockData|fallbackProject/i);
  assert.doesNotMatch(source, /aletheiaApi|mikeApi/);
  assert.match(source, /useI18n/);
  assert.match(source, /AbortController/);
  assert.match(source, /data-project-modal-autofocus/);
  assert.match(
    current("src/app/components/projects/useProjectModalA11y.ts"),
    /event\.key === "Escape"[\s\S]*event\.key !== "Tab"/,
  );
});

test("Vera project and document API methods retain Mike lineage behind one strict local boundary", () => {
  sourceLock(SOURCES.api);
  const api = current("src/app/lib/veraApi.ts");
  const lockedMikeToVeraMethods = {
    listProjects: "listVeraProjects",
    createProject: "createVeraProject",
    updateProject: "updateVeraProject",
    deleteProject: "deleteVeraProject",
    uploadProjectDocument: "uploadVeraDocument",
    uploadDocumentVersion: "uploadVeraDocumentVersion",
    deleteDocument: "deleteVeraDocument",
  } as const;
  assert.deepEqual(Object.keys(lockedMikeToVeraMethods), [
    "listProjects",
    "createProject",
    "updateProject",
    "deleteProject",
    "uploadProjectDocument",
    "uploadDocumentVersion",
    "deleteDocument",
  ]);
  for (const method of Object.values(lockedMikeToVeraMethods)) {
    assert.match(api, new RegExp(`export (?:async )?function ${method}`));
  }
  assert.match(api, /export (?:async )?function retryVeraDocumentParse/);
  assert.match(api, /json: \{ confirm_name: confirmName \}/);
  assert.match(api, /form\.append\("file", upload\.file, upload\.filename\)/);
  assert.doesNotMatch(api, /Content-Type[^\n]*multipart/i);
  assert.match(api, /parseVeraDocumentMutationWire/);
  assert.match(api, /parseVeraDocumentVersionsWire/);
  assert.match(api, /wire\.shared_with\.length !== 0/);
  assert.match(api, /VERA_LOCAL_USER_ID/);
  assert.doesNotMatch(api, /storage_path:\s*string|authorization:\s*["'`]/i);
});

test("document mutations use scoped multipart routes and accept only safe local wire data", async () => {
  const localUserId = "00000000-0000-4000-8000-000000000001";
  const projectId = "11111111-1111-4111-8111-111111111111";
  const documentId = "22222222-2222-4222-8222-222222222222";
  const versionId = "33333333-3333-4333-8333-333333333333";
  const jobId = "44444444-4444-4444-8444-444444444444";
  const token = "vdt_1234567890abcdefghijklmnopqrstuvwxyz";
  const timestamp = "2026-07-14T00:00:00.000Z";
  const document = {
    id: documentId,
    user_id: localUserId,
    project_id: projectId,
    folder_id: null,
    filename: "evidence.pdf",
    owner_email: null,
    owner_display_name: "Local User",
    file_type: "pdf",
    storage_path: null,
    pdf_storage_path: "local-preview",
    size_bytes: 8,
    page_count: 1,
    structure_tree: null,
    status: "processing",
    created_at: timestamp,
    updated_at: timestamp,
    active_version_number: 1,
    latest_version_number: 1,
  } as const;
  const version = {
    id: versionId,
    version_number: 1,
    source: "upload",
    created_at: timestamp,
    filename: "evidence.pdf",
    file_type: "pdf",
    size_bytes: 8,
    page_count: 1,
    deleted_at: null,
    deleted_by: null,
  } as const;
  const job = {
    id: jobId,
    type: "document_parse",
    status: "queued",
    attempt: 0,
    max_attempts: 3,
    retryable: true,
    created_at: timestamp,
    scheduled_at: timestamp,
    started_at: null,
    completed_at: null,
  } as const;
  const project = {
    id: projectId,
    user_id: localUserId,
    name: "Evidence review",
    description: "Local project",
    cm_number: null,
    practice: null,
    shared_with: [],
    created_at: timestamp,
    updated_at: timestamp,
    is_owner: true,
    owner_display_name: "Local User",
    owner_email: null,
    documents: [],
    folders: [],
    document_count: 0,
    chat_count: 0,
    review_count: 0,
    workflow_count: 0,
    status: "active",
    archived_at: null,
    default_model_profile_id: null,
  } as const;

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
          return token;
        },
      },
    },
  });
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const payload = url.pathname.endsWith("/retry")
      ? { job }
      : url.pathname.endsWith("/projects")
        ? [project]
        : { document, version, job };
    return new Response(JSON.stringify(payload), {
      status: url.pathname.endsWith("/retry") ? 202 : 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    assert.deepEqual(await listVeraProjects(), [project]);
    const file = new File([new Uint8Array([1, 2, 3])], "evidence.pdf", {
      type: "application/pdf",
    });
    await uploadVeraDocument({ file, projectId });
    await uploadVeraDocumentVersion(documentId, file, { projectId });
    await retryVeraDocumentParse(documentId, { projectId });
    await deleteVeraDocument(documentId, { projectId });

    assert.equal(calls[0].url.search, "");
    assert.equal(
      calls[1].url.pathname,
      `/api/v1/projects/${projectId}/documents`,
    );
    assert.equal(
      calls[2].url.pathname,
      `/api/v1/projects/${projectId}/documents/${documentId}/versions`,
    );
    assert.equal(
      calls[3].url.pathname,
      `/api/v1/projects/${projectId}/documents/${documentId}/retry`,
    );
    assert.equal(calls[4].init?.method, "DELETE");
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      assert.equal(headers.get("authorization"), `Bearer ${token}`);
      assert.equal(call.url.href.includes(token), false);
    }
    for (const call of [calls[1], calls[2]]) {
      assert.ok(call.init?.body instanceof FormData);
      assert.equal(new Headers(call.init?.headers).has("content-type"), false);
      assert.ok(call.init?.body.get("file") instanceof File);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (priorWindow) {
      Object.defineProperty(globalThis, "window", priorWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});
