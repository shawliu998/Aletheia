import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import http from "node:http";

import express from "express";

import { MAX_UPLOAD_SIZE_BYTES, UPLOAD_TEMP_ROOT } from "../lib/upload";
import { WorkspaceApiError } from "../lib/workspace/errors";
import {
  createWorkspaceV1Router,
  type WorkspaceV1DocumentMutationScope,
  type WorkspaceV1DocumentUploadInput,
  type WorkspaceV1DocumentVersionUploadInput,
  type WorkspaceV1RuntimePort,
} from "../routes/workspaceV1";

const id = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const folderId = "33333333-3333-4333-8333-333333333333";
const busyId = "44444444-4444-4444-8444-444444444444";
const notRetryableId = "55555555-5555-4555-8555-555555555555";
const createdDocumentId = "66666666-6666-4666-8666-666666666666";
const uploadedVersionId = "77777777-7777-4777-8777-777777777777";
const uploadedJobId = "88888888-8888-4888-8888-888888888888";
const retryJobId = "99999999-9999-4999-8999-999999999999";
const chineseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const badLengthId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const badDispositionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const now = "2026-07-14T00:00:00.000Z";
const token = "1234567890abcdef";
let lastDocumentQuery: unknown;

type UploadCall = {
  input: WorkspaceV1DocumentUploadInput;
};
type VersionUploadCall = {
  documentId: string;
  input: WorkspaceV1DocumentVersionUploadInput;
  scope?: WorkspaceV1DocumentMutationScope;
};
type DeleteCall = {
  documentId: string;
  scope?: WorkspaceV1DocumentMutationScope;
};
type RetryCall = {
  documentId: string;
  scope?: WorkspaceV1DocumentMutationScope;
};

const uploadCalls: UploadCall[] = [];
const versionUploadCalls: VersionUploadCall[] = [];
const deleteCalls: DeleteCall[] = [];
const retryCalls: RetryCall[] = [];

const project = {
  id,
  user_id: "00000000-0000-4000-8000-000000000001",
  name: "Router workspace",
  description: "A Mike-compatible Vera project",
  cm_number: "CM-1",
  practice: "Corporate",
  shared_with: [],
  created_at: now,
  updated_at: now,
  is_owner: true,
  owner_display_name: "Local User",
  owner_email: null,
  documents: [],
  folders: [],
  document_count: 0,
  chat_count: 0,
  review_count: 0,
};

let lastProjectPage: unknown;

type AuditDocumentWire = {
  id: string;
  user_id: string;
  project_id: string | null;
  folder_id: string | null;
  filename: string;
  owner_email: string | null;
  owner_display_name: string | null;
  file_type: string | null;
  storage_path: null;
  pdf_storage_path: "local-preview" | null;
  size_bytes: number | null;
  page_count: number | null;
  structure_tree: null;
  status: "pending" | "processing" | "ready" | "error";
  created_at: string | null;
  updated_at: string | null;
  active_version_number: number | null;
  latest_version_number: number | null;
};

function fileType(filename: string) {
  const extension = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".") + 1).toLowerCase()
    : "txt";
  return ["pdf", "docx", "xlsx", "txt", "md"].includes(extension)
    ? extension
    : "txt";
}

function documentWire(overrides: Partial<AuditDocumentWire> = {}) {
  return {
    ...documentBase,
    ...overrides,
  };
}

function uploadPayload(
  input: WorkspaceV1DocumentUploadInput | WorkspaceV1DocumentVersionUploadInput,
  documentId = createdDocumentId,
  projectId: string | null = null,
  folderId: string | null = "folderId" in input && input.folderId !== undefined
    ? input.folderId
    : null,
) {
  return {
    document: documentWire({
      id: documentId,
      project_id: projectId,
      folder_id: folderId,
      filename: input.filename,
      file_type: fileType(input.filename),
      size_bytes: input.buffer.length,
      status: "pending",
    }),
    version: {
      id: uploadedVersionId,
      version_number: 1,
      source: "upload",
      created_at: now,
      filename: input.filename,
      file_type: fileType(input.filename),
      size_bytes: input.buffer.length,
      page_count: null,
      deleted_at: null,
      deleted_by: null,
    },
    job: {
      id: uploadedJobId,
      type: "document_parse",
      status: "queued",
      resource_id: documentId,
    },
  };
}

const documentBase: AuditDocumentWire = {
  id: otherId,
  user_id: project.user_id,
  project_id: id,
  folder_id: null,
  filename: "source.pdf",
  owner_email: null,
  owner_display_name: "Local User",
  file_type: "pdf",
  storage_path: null,
  pdf_storage_path: "local-preview" as const,
  size_bytes: 4,
  page_count: 1,
  structure_tree: null,
  status: "ready" as const,
  created_at: now,
  updated_at: now,
  active_version_number: 1,
  latest_version_number: 1,
};

const port: WorkspaceV1RuntimePort = {
  async listProjects(_context, page) {
    lastProjectPage = page;
    return page.cursor !== undefined || page.limit !== undefined
      ? { items: [project], next_cursor: null }
      : [project];
  },
  async createProject(_context, input) {
    return { ...project, ...(input as object) };
  },
  async getProject(_context, projectId) {
    if (projectId !== id)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Project not found.");
    return project;
  },
  async updateProject(_context, projectId, input) {
    if (projectId !== id)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Project not found.");
    if ((input as { name?: string }).name === "Conflict") {
      throw new WorkspaceApiError(409, "CONFLICT", "Project is archived.");
    }
    return { ...project, ...(input as object) };
  },
  async archiveProject() {
    return { ...project, archived: true };
  },
  async unarchiveProject() {
    return project;
  },
  async deleteProject(_context, projectId, confirmName) {
    if (projectId !== id)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Project not found.");
    if (confirmName !== project.name) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Confirmation does not match.",
      );
    }
  },
  async listFolders() {
    return [];
  },
  async createFolder(_context, projectId, input) {
    return {
      id: otherId,
      project_id: projectId,
      user_id: project.user_id,
      ...(input as object),
      created_at: now,
      updated_at: now,
    };
  },
  async updateFolder(_context, projectId, folderId, input) {
    return {
      id: folderId,
      project_id: projectId,
      user_id: project.user_id,
      ...(input as object),
      created_at: now,
      updated_at: now,
    };
  },
  async deleteFolder() {},
  async listDocuments(_context, query) {
    lastDocumentQuery = query;
    return [documentWire()];
  },
  async listProjectDocuments(_context, projectId) {
    if (projectId !== id)
      throw new WorkspaceApiError(404, "NOT_FOUND", "Project not found.");
    return [documentWire()];
  },
  async attachProjectDocument(_context, projectId, documentId) {
    if (projectId !== id || documentId !== otherId) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Document not found.");
    }
    return documentWire();
  },
  async uploadDocument(_context, input) {
    uploadCalls.push({ input });
    if (input.filename === "invalid-signature.pdf") {
      throw new WorkspaceApiError(
        400,
        "VALIDATION_ERROR",
        "Document request is invalid.",
      );
    }
    return uploadPayload(
      input,
      createdDocumentId,
      input.projectId,
      input.folderId,
    );
  },
  async uploadDocumentVersion(_context, documentId, input, scope) {
    versionUploadCalls.push({ documentId, input, scope });
    return uploadPayload(input, documentId, scope?.projectId ?? id, null);
  },
  async deleteDocument(_context, documentId, scope) {
    deleteCalls.push({ documentId, scope });
    if (documentId === busyId) {
      throw new WorkspaceApiError(
        409,
        "CONFLICT",
        "Document has an active parse job.",
      );
    }
  },
  async retryDocumentParse(_context, documentId, scope) {
    retryCalls.push({ documentId, scope });
    if (documentId === notRetryableId) return null;
    return {
      job: {
        id: retryJobId,
        type: "document_parse",
        status: "queued",
        resource_id: documentId,
      },
    };
  },
  async renameProjectDocument(_context, projectId, documentId, filename) {
    if (projectId !== id || documentId !== otherId) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Document not found.");
    }
    return documentWire({ filename });
  },
  async moveProjectDocument(_context, projectId, documentId, nextFolderId) {
    if (projectId !== id || documentId !== otherId) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Document not found.");
    }
    return documentWire({ folder_id: nextFolderId });
  },
  async getDocument(_context, documentId) {
    if (documentId === id) throw new Error("unexpected internal failure");
    if (documentId !== otherId) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Document not found.");
    }
    return documentWire();
  },
  async listDocumentVersions() {
    return {
      current_version_id: otherId,
      versions: [
        {
          id: otherId,
          version_number: 1,
          source: "upload",
          created_at: now,
          filename: "source.pdf",
          file_type: "pdf",
          size_bytes: 4,
          page_count: 1,
          deleted_at: null,
          deleted_by: null,
        },
      ],
    };
  },
  async readDocument() {
    return { document_id: otherId, content: "Extracted text" };
  },
  async displayDocument(_context, documentId) {
    if (documentId === chineseId) {
      return {
        filename: "合同(最终).pdf",
        contentType: "application/pdf",
        body: new Uint8Array([4, 5]),
        disposition: "inline",
      };
    }
    if (documentId === badLengthId) {
      return {
        filename: "source.pdf",
        contentType: "application/pdf",
        body: new Uint8Array([4, 5]),
        contentLength: -1,
        disposition: "inline",
      };
    }
    if (documentId === badDispositionId) {
      return {
        filename: "source.pdf",
        contentType: "application/pdf",
        body: new Uint8Array([4, 5]),
        disposition: "inline; unsafe=1" as "inline",
      };
    }
    return {
      filename: "source.pdf",
      contentType: "application/pdf",
      body: new Uint8Array([4, 5]),
      disposition: "inline",
    };
  },
  async getDocumentDownload() {
    return {
      url: `/api/v1/downloads/${token}`,
      download_url: `/api/v1/downloads/${token}`,
      document_id: otherId,
      filename: "source.pdf",
      version_id: otherId,
      has_pdf_rendition: true,
    };
  },
  async getDocumentVersionFile() {
    return {
      url: `/api/v1/downloads/${token}`,
      document_id: otherId,
      filename: "source.pdf",
      version_id: otherId,
      has_pdf_rendition: true,
    };
  },
  async resolveDownload(_context, requestedToken) {
    if (requestedToken !== token) {
      throw new WorkspaceApiError(404, "NOT_FOUND", "Download not found.");
    }
    return {
      filename: "source.pdf",
      contentType: "application/pdf",
      body: new Uint8Array([1, 2, 3]),
      disposition: "attachment",
    };
  },
};

async function withServer(
  app: express.Express,
  run: (base: string) => Promise<void>,
) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function request(base: string, path: string, init?: RequestInit) {
  return fetch(`${base}/api/v1${path}`, init);
}

async function rawMultipart(
  base: string,
  path: string,
  boundary: string,
  body: string,
) {
  return request(base, path, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitForSignal(promise: Promise<void>, label: string) {
  let handle: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        handle = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}.`)),
          2_000,
        );
      }),
    ]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

async function upload(
  base: string,
  path: string,
  options: {
    filename?: string;
    mimeType?: string;
    bytes?: Uint8Array;
    fields?: Record<string, string>;
    extraFiles?: Array<{
      filename: string;
      mimeType: string;
      bytes: Uint8Array;
    }>;
  } = {},
) {
  const form = new FormData();
  for (const [key, value] of Object.entries(options.fields ?? {})) {
    form.append(key, value);
  }
  if (options.bytes) {
    form.append(
      "file",
      new Blob([Buffer.from(options.bytes)], {
        type: options.mimeType ?? "application/pdf",
      }),
      options.filename ?? "upload.pdf",
    );
  }
  for (const extra of options.extraFiles ?? []) {
    form.append(
      "file",
      new Blob([Buffer.from(extra.bytes)], { type: extra.mimeType }),
      extra.filename,
    );
  }
  return request(base, path, { method: "POST", body: form });
}

async function json(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

async function uploadTempNames() {
  try {
    return new Set(await readdir(UPLOAD_TEMP_ROOT));
  } catch {
    return new Set<string>();
  }
}

async function assertNoUploadTempLeak(before: Set<string>, context: string) {
  assert.deepEqual(
    await uploadTempNames(),
    before,
    `${context} leaked temp files`,
  );
}

async function run() {
  const routerSource = readFileSync("src/routes/workspaceV1.ts", "utf8");
  assert.equal(
    routerSource.includes("requirePortMethod"),
    false,
    "document mutations must not retain 501 escape hatches",
  );

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use((_request, response, next) => {
    response.locals.userId = project.user_id;
    next();
  });
  app.use(
    "/api/v1",
    createWorkspaceV1Router(port, { requireAuthentication: true }),
  );

  await withServer(app, async (base) => {
    const list = await request(base, "/projects");
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(
      Array.isArray(listBody),
      true,
      "Mike GET /projects stays Project[]",
    );
    assert.deepEqual(
      Object.keys((listBody as Array<Record<string, unknown>>)[0]).sort(),
      Object.keys(project).sort(),
      "Mike project wire remains snake_case",
    );
    assert.deepEqual(lastProjectPage, {});
    const pagedProjects = await request(base, "/projects?limit=1");
    assert.equal(pagedProjects.status, 200);
    assert.deepEqual(await pagedProjects.json(), {
      items: [project],
      next_cursor: null,
    });
    assert.deepEqual(lastProjectPage, { limit: 1 });

    const filteredDocuments = await request(
      base,
      `/documents?project_id=${id}&folder_id=&status=ready`,
    );
    assert.equal(filteredDocuments.status, 422, "empty folder IDs fail closed");
    assert.equal(
      (await request(base, `/documents?project_id=${id}&status=ready`)).status,
      200,
    );
    assert.deepEqual(lastDocumentQuery, {
      projectId: id,
      folderId: undefined,
      status: "ready",
      standalone: false,
      cursor: undefined,
      limit: undefined,
    });

    const sizeBoundary = new Uint8Array(MAX_UPLOAD_SIZE_BYTES + 1);
    sizeBoundary.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);
    const exactSizeBoundary = new Uint8Array(MAX_UPLOAD_SIZE_BYTES);
    exactSizeBoundary.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0);

    const standaloneTempBefore = await uploadTempNames();
    const standaloneUpload = await upload(base, "/single-documents", {
      filename: "standalone.pdf",
      mimeType: "application/pdf",
      bytes: sizeBoundary.subarray(0, 5),
    });
    await assertNoUploadTempLeak(standaloneTempBefore, "successful upload");
    assert.equal(standaloneUpload.status, 201);
    const standaloneBody = await json(standaloneUpload);
    assert.equal(
      (standaloneBody.job as Record<string, unknown>).status,
      "queued",
    );
    assert.equal(uploadCalls.at(-1)?.input.projectId, null);
    assert.equal(uploadCalls.at(-1)?.input.folderId, null);
    assert.equal(
      uploadCalls.at(-1)?.input.buffer.toString("hex"),
      "255044462d",
      "uploaded bytes reach the runtime port",
    );
    assert.equal("path" in (uploadCalls.at(-1)?.input as object), false);

    const scopedUpload = await upload(base, "/documents", {
      filename: "scoped.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]),
      fields: { project_id: id, folder_id: folderId },
    });
    assert.equal(scopedUpload.status, 201);
    assert.equal(uploadCalls.at(-1)?.input.projectId, id);
    assert.equal(uploadCalls.at(-1)?.input.folderId, folderId);

    const projectUpload = await upload(base, `/projects/${id}/documents`, {
      filename: "project.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x32]),
      fields: { folder_id: folderId },
    });
    assert.equal(projectUpload.status, 201);
    assert.equal(uploadCalls.at(-1)?.input.projectId, id);
    assert.equal(uploadCalls.at(-1)?.input.folderId, folderId);
    assert.notEqual(projectUpload.status, 501, "project upload must be real");

    const missingFile = await upload(base, "/single-documents");
    assert.equal(missingFile.status, 422);
    assert.equal((await json(missingFile)).code, "VALIDATION_ERROR");

    const emptyFile = await upload(base, "/single-documents", {
      filename: "empty.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array(0),
    });
    assert.equal(emptyFile.status, 422);

    const extraFieldTempBefore = await uploadTempNames();
    const extraField = await upload(base, "/single-documents", {
      filename: "wrong.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      fields: { folder_id: folderId },
    });
    await assertNoUploadTempLeak(extraFieldTempBefore, "field validation");
    assert.equal(extraField.status, 422);

    const folderWithoutProject = await upload(base, "/documents", {
      filename: "wrong.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      fields: { folder_id: folderId },
    });
    assert.equal(folderWithoutProject.status, 422);

    const badProjectId = await upload(base, "/documents", {
      filename: "wrong.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      fields: { project_id: "not-a-uuid" },
    });
    assert.equal(badProjectId.status, 422);

    const badFolderId = await upload(base, `/projects/${id}/documents`, {
      filename: "wrong.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      fields: { folder_id: "not-a-uuid" },
    });
    assert.equal(badFolderId.status, 422);

    const multipleTempBefore = await uploadTempNames();
    const multipleFiles = await upload(base, "/single-documents", {
      filename: "first.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
      extraFiles: [
        {
          filename: "second.pdf",
          mimeType: "application/pdf",
          bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
        },
      ],
    });
    await assertNoUploadTempLeak(
      multipleTempBefore,
      "multiple-file validation",
    );
    assert.equal(multipleFiles.status, 422);
    assert.equal((await json(multipleFiles)).code, "VALIDATION_ERROR");

    const partialBoundary = "vera-partial-upload-boundary";
    const partialTempBefore = await uploadTempNames();
    const partialMultipart = await rawMultipart(
      base,
      "/single-documents",
      partialBoundary,
      [
        `--${partialBoundary}`,
        'Content-Disposition: form-data; name="file"; filename="partial.pdf"',
        "Content-Type: application/pdf",
        "",
        "%PDF-partial-without-a-closing-boundary",
      ].join("\r\n"),
    );
    assert.equal(partialMultipart.status, 500);
    assert.equal((await json(partialMultipart)).code, "INTERNAL_ERROR");
    await assertNoUploadTempLeak(
      partialTempBefore,
      "partial malformed multipart",
    );

    const missingNameBoundary = "vera-missing-field-name-boundary";
    const missingNameTempBefore = await uploadTempNames();
    const missingFieldName = await rawMultipart(
      base,
      "/single-documents",
      missingNameBoundary,
      [
        `--${missingNameBoundary}`,
        'Content-Disposition: form-data; name="file"; filename="tracked.pdf"',
        "Content-Type: application/pdf",
        "",
        "%PDF-",
        `--${missingNameBoundary}`,
        "Content-Disposition: form-data",
        "",
        "missing-name",
        `--${missingNameBoundary}--`,
        "",
      ].join("\r\n"),
    );
    assert.equal(missingFieldName.status, 422);
    assert.equal((await json(missingFieldName)).code, "VALIDATION_ERROR");
    await assertNoUploadTempLeak(
      missingNameTempBefore,
      "missing multipart field name",
    );

    const exactLimit = await upload(base, "/single-documents", {
      filename: "limit.pdf",
      mimeType: "application/pdf",
      bytes: exactSizeBoundary,
    });
    assert.equal(exactLimit.status, 201, "exact upload limit remains allowed");

    const oversizeTempBefore = await uploadTempNames();
    const oversize = await upload(base, "/single-documents", {
      filename: "large.pdf",
      mimeType: "application/pdf",
      bytes: sizeBoundary,
    });
    await assertNoUploadTempLeak(oversizeTempBefore, "oversize validation");
    assert.equal(oversize.status, 413);
    assert.equal((await json(oversize)).code, "PAYLOAD_TOO_LARGE");

    const portFailureTempBefore = await uploadTempNames();
    const signatureFailure = await upload(base, "/single-documents", {
      filename: "invalid-signature.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    });
    await assertNoUploadTempLeak(portFailureTempBefore, "port failure");
    assert.equal(signatureFailure.status, 400);
    const signatureFailureBody = await json(signatureFailure);
    assert.equal(signatureFailureBody.code, "VALIDATION_ERROR");
    assert.equal(
      JSON.stringify(signatureFailureBody).includes("invalid-signature.pdf"),
      false,
      "validation errors do not echo uploaded filenames",
    );

    const version = await upload(base, `/documents/${otherId}/versions`, {
      filename: "version.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x33]),
    });
    assert.equal(version.status, 201);
    assert.equal(versionUploadCalls.at(-1)?.documentId, otherId);
    assert.equal("projectId" in versionUploadCalls.at(-1)!.input, false);

    const scopedVersion = await upload(
      base,
      `/projects/${id}/documents/${otherId}/versions`,
      {
        filename: "project-version.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x34]),
      },
    );
    assert.equal(scopedVersion.status, 201);
    assert.equal(versionUploadCalls.at(-1)?.documentId, otherId);
    assert.equal("projectId" in versionUploadCalls.at(-1)!.input, false);
    assert.deepEqual(versionUploadCalls.at(-1)?.scope, { projectId: id });

    const unexpectedVersionField = await upload(
      base,
      `/documents/${otherId}/versions`,
      {
        filename: "project-version.pdf",
        mimeType: "application/pdf",
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x35]),
        fields: { project_id: id },
      },
    );
    assert.equal(unexpectedVersionField.status, 422);

    const projectDelete = await request(
      base,
      `/projects/${id}/documents/${otherId}`,
      { method: "DELETE" },
    );
    assert.equal(projectDelete.status, 204);
    assert.deepEqual(deleteCalls.at(-1), {
      documentId: otherId,
      scope: { projectId: id },
    });

    const standaloneDelete = await request(
      base,
      `/single-documents/${otherId}`,
      { method: "DELETE" },
    );
    assert.equal(standaloneDelete.status, 204);
    assert.deepEqual(deleteCalls.at(-1), {
      documentId: otherId,
      scope: { projectId: null },
    });

    const busyDelete = await request(base, `/documents/${busyId}`, {
      method: "DELETE",
    });
    assert.equal(busyDelete.status, 409);
    assert.equal((await json(busyDelete)).code, "CONFLICT");

    const busyDeleteWithBody = await request(base, `/documents/${busyId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nope: true }),
    });
    assert.equal(busyDeleteWithBody.status, 422);

    const retry = await request(base, `/documents/${otherId}/retry`, {
      method: "POST",
    });
    assert.equal(retry.status, 202);
    assert.equal(
      ((await json(retry)).job as Record<string, unknown>).id,
      retryJobId,
    );

    const standaloneRetry = await request(
      base,
      `/single-documents/${otherId}/retry`,
      { method: "POST" },
    );
    assert.equal(standaloneRetry.status, 202);
    assert.deepEqual(retryCalls.at(-1), {
      documentId: otherId,
      scope: { projectId: null },
    });

    const projectRetry = await request(
      base,
      `/projects/${id}/documents/${otherId}/retry`,
      { method: "POST" },
    );
    assert.equal(projectRetry.status, 202);
    assert.deepEqual(retryCalls.at(-1), {
      documentId: otherId,
      scope: { projectId: id },
    });

    const retryWithBody = await request(base, `/documents/${otherId}/retry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nope: true }),
    });
    assert.equal(retryWithBody.status, 422);

    const noRetry = await request(base, `/documents/${notRetryableId}/retry`, {
      method: "POST",
    });
    assert.equal(noRetry.status, 409);
    assert.equal((await json(noRetry)).code, "CONFLICT");

    const create = await request(base, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Created",
        description: "Created through the Mike project contract",
        cm_number: null,
        practice: null,
        shared_with: [],
      }),
    });
    assert.equal(create.status, 201);
    assert.equal(
      (await json(create)).description,
      "Created through the Mike project contract",
    );

    const invalid = await request(base, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bad", user_id: id }),
    });
    assert.equal(invalid.status, 422);
    assert.deepEqual(Object.keys(await json(invalid)).sort(), [
      "code",
      "detail",
      "error",
    ]);

    const descriptionPatch = await request(base, `/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "Updated through the Mike project contract",
      }),
    });
    assert.equal(descriptionPatch.status, 200);
    assert.equal(
      (await json(descriptionPatch)).description,
      "Updated through the Mike project contract",
    );

    assert.equal(
      (
        await request(base, `/projects/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Conflict" }),
        })
      ).status,
      409,
    );
    assert.equal(
      (await request(base, "/projects/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
        .status,
      404,
    );
    assert.equal(
      (
        await request(base, `/projects/${id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm_name: project.name }),
        })
      ).status,
      204,
    );
    assert.equal(
      (
        await request(base, `/projects/${id}/folders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Folder" }),
        })
      ).status,
      201,
    );

    const alias = await request(base, "/single-documents");
    assert.equal(alias.status, 200);
    assert.equal(
      ((await alias.json()) as Array<Record<string, unknown>>)[0].storage_path,
      null,
    );
    assert.deepEqual(
      lastDocumentQuery,
      {
        standalone: true,
        cursor: undefined,
        limit: undefined,
        status: undefined,
      },
      "single-documents defaults to standalone",
    );
    assert.equal(
      (await request(base, `/projects/${id}/documents`)).status,
      200,
    );
    assert.equal(
      (
        await request(base, `/projects/${id}/documents/${otherId}`, {
          method: "POST",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await request(base, `/projects/${id}/documents/${otherId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: "renamed.pdf" }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(base, `/projects/${id}/documents/${otherId}/folder`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ folder_id: null }),
        })
      ).status,
      200,
    );

    const versions = await request(base, `/documents/${otherId}/versions`);
    assert.equal(versions.status, 200);
    assert.deepEqual(Object.keys(await json(versions)).sort(), [
      "current_version_id",
      "versions",
    ]);

    const versionFile = await request(
      base,
      `/single-documents/${otherId}/versions/${otherId}/file`,
    );
    assert.equal(versionFile.status, 200);
    assert.equal((await json(versionFile)).url, `/api/v1/downloads/${token}`);
    assert.equal(
      (await request(base, `/single-documents/${otherId}/read`)).status,
      200,
    );

    const display = await request(base, `/single-documents/${otherId}/display`);
    assert.equal(display.status, 200);
    assert.equal(display.headers.get("content-type"), "application/pdf");
    assert.equal(
      display.headers.get("content-disposition"),
      "inline; filename=\"source.pdf\"; filename*=UTF-8''source.pdf",
    );
    assert.deepEqual(
      Array.from(new Uint8Array(await display.arrayBuffer())),
      [4, 5],
    );

    const localizedDisplay = await request(
      base,
      `/single-documents/${chineseId}/display`,
    );
    assert.equal(localizedDisplay.status, 200);
    const localizedDisposition =
      localizedDisplay.headers.get("content-disposition") ?? "";
    assert.match(
      localizedDisposition,
      /^inline; filename="[^"]+"; filename\*=UTF-8''/u,
    );
    assert.equal(/[^\x20-\x7E]/.test(localizedDisposition), false);
    assert.equal(localizedDisposition.includes("\r"), false);
    assert.equal(
      localizedDisposition.includes(
        "filename*=UTF-8''%E5%90%88%E5%90%8C%28%E6%9C%80%E7%BB%88%29.pdf",
      ),
      true,
    );

    const invalidLength = await request(
      base,
      `/single-documents/${badLengthId}/display`,
    );
    assert.equal(invalidLength.status, 500);
    assert.equal((await json(invalidLength)).code, "INTERNAL_ERROR");
    assert.equal(invalidLength.headers.get("content-disposition"), null);
    assert.match(
      invalidLength.headers.get("content-type") ?? "",
      /^application\/json\b/,
      "download headers are not written before content length validation",
    );

    const invalidDisposition = await request(
      base,
      `/single-documents/${badDispositionId}/display`,
    );
    assert.equal(invalidDisposition.status, 500);
    assert.equal((await json(invalidDisposition)).code, "INTERNAL_ERROR");
    assert.equal(invalidDisposition.headers.get("content-disposition"), null);
    assert.match(
      invalidDisposition.headers.get("content-type") ?? "",
      /^application\/json\b/,
      "disposition must be validated before any binary headers are written",
    );

    const capability = await request(base, `/documents/${otherId}/url`);
    assert.equal(capability.status, 200);
    const capabilityJson = await json(capability);
    assert.deepEqual(Object.keys(capabilityJson).sort(), [
      "document_id",
      "download_url",
      "filename",
      "has_pdf_rendition",
      "url",
      "version_id",
    ]);
    assert.equal(capabilityJson.url, `/api/v1/downloads/${token}`);
    assert.equal(
      String(capabilityJson.url).startsWith("/"),
      true,
      "capability has no absolute path or URL",
    );
    assert.equal(
      (await request(base, `/single-documents/${otherId}/download`)).status,
      200,
    );

    const download = await request(base, `/downloads/${token}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("cache-control"), "private, no-store");
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.equal(
      download.headers.get("content-disposition"),
      "attachment; filename=\"source.pdf\"; filename*=UTF-8''source.pdf",
    );
    assert.equal(download.headers.get("content-length"), "3");

    const failed = await request(base, `/documents/${id}`);
    assert.equal(failed.status, 500);
    assert.equal((await json(failed)).detail, "Internal server error.");

    const invalidToken = await request(base, "/downloads/short");
    assert.equal(invalidToken.status, 422);
    assert.equal(
      (await invalidToken.text()).includes("short"),
      false,
      "tokens never appear in errors",
    );
  });

  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  let cleanupCandidate: string | null = null;
  const cleanupFailureApp = express();
  cleanupFailureApp.use(express.json({ limit: "64kb" }));
  cleanupFailureApp.use((_request, response, next) => {
    response.locals.userId = project.user_id;
    next();
  });
  cleanupFailureApp.use(
    "/api/v1",
    createWorkspaceV1Router(port, {
      requireAuthentication: true,
      uploadPathRemover: async (candidate) => {
        cleanupCandidate = candidate;
        cleanupStarted.resolve();
        await releaseCleanup.promise;
        throw new Error(`synthetic rm failure for ${candidate}`);
      },
    }),
  );
  await withServer(cleanupFailureApp, async (base) => {
    let responseSettled = false;
    const responsePromise = upload(base, "/single-documents", {
      filename: "cleanup-failure.pdf",
      mimeType: "application/pdf",
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
    });
    void responsePromise.then(
      () => {
        responseSettled = true;
      },
      () => {
        responseSettled = true;
      },
    );
    try {
      await waitForSignal(cleanupStarted.promise, "upload cleanup");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        responseSettled,
        false,
        "the router must not respond while upload cleanup is pending",
      );
      releaseCleanup.resolve();
      const response = await responsePromise;
      assert.equal(response.status, 500);
      const responseText = await response.text();
      assert.equal(responseText.includes("synthetic rm failure"), false);
      assert.equal(
        cleanupCandidate === null
          ? false
          : responseText.includes(cleanupCandidate),
        false,
        "cleanup failures never expose the temporary path",
      );
      assert.equal(
        JSON.parse(responseText).code,
        "INTERNAL_ERROR",
        "cleanup failures use the unified safe error response",
      );
    } finally {
      releaseCleanup.resolve();
      if (cleanupCandidate) await rm(cleanupCandidate, { force: true });
    }
  });

  const unauthenticated = express();
  unauthenticated.use(express.json());
  unauthenticated.use(
    "/api/v1",
    createWorkspaceV1Router(port, { requireAuthentication: true }),
  );
  await withServer(unauthenticated, async (base) => {
    assert.equal((await request(base, "/projects")).status, 401);
  });

  console.log("vera workspace API router audit passed");
}

void run();
