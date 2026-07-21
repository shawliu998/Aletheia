import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Document, Packer, Paragraph, TextRun } from "docx";
import {
  applyTrackedEdits,
  extractDocxBodyText,
  extractTrackedChangeIds,
  resolveTrackedChange,
} from "../src/lib/docxTrackedChanges";
import {
  commitResolvedDocumentEditVersion,
  type DocumentEditResolutionStatus,
  type ResolvedDocumentEditVersionInsert,
} from "../src/lib/documentEditResolutionVersions";
import {
  buildAgentReviewVersionState,
  deriveAgentReviewStatus,
} from "../src/lib/agentTaskReviewVersions";
import { approvedArtifactBytesMatch } from "../src/lib/agentTaskReviews";
import { applyResolvedEditVersionToTabs } from "../../frontend/src/app/components/assistant/editResolutionTabs";

type Version = {
  id: string;
  document_id: string;
  version_number: number | null;
  storage_path: string;
  filename: string | null;
  file_type: string | null;
  source: string | null;
  deleted_at: string | null;
};

const document = {
  id: "doc_roundtrip",
  current_version_id: "version_2",
};
const versions: Version[] = [];
const storedBytes = new Map<string, Buffer>();
const editStatuses = new Map<string, "pending" | "accepted" | "rejected">();

function sha256(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function addVersion(input: Version, bytes: Buffer) {
  versions.push(input);
  storedBytes.set(input.storage_path, Buffer.from(bytes));
}

function makeApproval(version: Version, bytes: Buffer) {
  return {
    id: "approval_locked_v2",
    created_at: "2026-07-21T08:00:00.000Z",
    artifact_snapshot: [
      {
        artifact_type: "draft",
        artifact_id: document.id,
        document_id: document.id,
        purpose: "Roundtrip memo",
        version_id: version.id,
        version_number: version.version_number,
        filename: version.filename ?? "Roundtrip.docx",
        file_type: version.file_type,
        size_bytes: bytes.byteLength,
        sha256: sha256(bytes),
      },
    ],
  };
}

function makeDeps() {
  return {
    claimPendingEditResolution: async (input: {
      editId: string;
      status: DocumentEditResolutionStatus;
    }) => {
      if (editStatuses.get(input.editId) !== "pending") return false;
      editStatuses.set(input.editId, input.status);
      return true;
    },
    getNextVersionNumber: async (documentId: string) =>
      Math.max(
        ...versions
          .filter((version) => version.document_id === documentId)
          .map((version) => version.version_number ?? 0),
      ) + 1,
    uploadVersionBytes: async (input: {
      storagePath: string;
      bytes: Buffer;
    }) => {
      storedBytes.set(input.storagePath, Buffer.from(input.bytes));
    },
    insertDocumentVersion: async (input: ResolvedDocumentEditVersionInsert) => {
      const version: Version = {
        id: `version_${input.version_number}`,
        document_id: input.document_id,
        version_number: input.version_number,
        storage_path: input.storage_path,
        filename: input.filename,
        file_type: input.file_type,
        source: input.source,
        deleted_at: null,
      };
      versions.push(version);
      return version;
    },
    updateDocumentCurrentVersion: async (input: {
      documentId: string;
      versionId: string;
    }) => {
      assert.equal(input.documentId, document.id);
      document.current_version_id = input.versionId;
    },
    countRemainingPendingEdits: async () =>
      [...editStatuses.values()].filter((status) => status === "pending")
        .length,
    rollbackEditResolution: async (input: {
      editId: string;
      status: DocumentEditResolutionStatus;
    }) => {
      if (editStatuses.get(input.editId) === input.status) {
        editStatuses.set(input.editId, "pending");
      }
    },
    cleanupVersion: async (input: {
      versionId: string | null;
      storagePath: string;
    }) => {
      storedBytes.delete(input.storagePath);
      if (!input.versionId) return;
      const index = versions.findIndex(
        (version) => version.id === input.versionId,
      );
      if (index >= 0) versions.splice(index, 1);
    },
  };
}

async function createBaseDocx() {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            children: [
              new TextRun(
                "Alpha clause must stay. Beta clause must stay. Gamma clause remains unchanged.",
              ),
            ],
          }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

async function commitResolvedChange(input: {
  editId: string;
  wIds: string[];
  mode: "accept" | "reject";
  storagePath: string;
}) {
  const current = versions.find(
    (version) => version.id === document.current_version_id,
  );
  assert.ok(current, "current version exists before resolution");
  const currentBytes = storedBytes.get(current.storage_path);
  assert.ok(currentBytes, "current version bytes exist before resolution");
  const resolved = await resolveTrackedChange(
    currentBytes,
    input.wIds,
    input.mode,
  );
  assert.equal(resolved.found, true);
  const result = await commitResolvedDocumentEditVersion(
    {
      documentId: document.id,
      editId: input.editId,
      status: input.mode === "accept" ? "accepted" : "rejected",
      resolvedAt: "2026-07-21T09:00:00.000Z",
      filename: current.filename,
      storagePath: input.storagePath,
      bytes: resolved.bytes,
    },
    makeDeps(),
  );
  assert.equal(result.committed, true);
  return result;
}

function assertReviewRequiredAfterCurrentChange(
  latestApproval: ReturnType<typeof makeApproval>,
) {
  const state = buildAgentReviewVersionState(
    [
      {
        artifact_type: "draft",
        artifact_id: document.id,
        purpose: "Roundtrip memo",
      },
    ],
    [document],
    versions,
    latestApproval,
  );
  assert.equal(state.has_unapproved_changes, true);
  assert.equal(
    deriveAgentReviewStatus("completed", "approved", state),
    "review_required",
  );
}

function assertTabsSwitchToResolvedVersion() {
  const tabs = [
    {
      kind: "document" as const,
      id: "doc-tab",
      documentId: document.id,
      filename: "Roundtrip.docx",
      versionId: "version_2",
      versionNumber: 2,
      refetchKey: 7,
    },
    {
      kind: "edit" as const,
      id: "edit-tab",
      documentId: document.id,
      filename: "Roundtrip.docx",
      versionId: "version_2",
      versionNumber: 2,
      edit: { edit_id: "edit_alpha", status: "pending" as const },
    },
    {
      kind: "case" as const,
      id: "case:1",
      caseName: "Example",
    },
  ];
  const next = applyResolvedEditVersionToTabs(tabs, {
    editId: "edit_alpha",
    documentId: document.id,
    status: "accepted",
    versionId: "version_3",
    versionNumber: 3,
    downloadUrl: "/downloads/locked",
  });
  assert.notEqual(next, tabs);
  assert.equal(next[0]!.versionId, "version_3");
  assert.equal(next[0]!.versionNumber, 3);
  assert.equal(next[0]!.refetchKey, 8);
  assert.equal(next[1]!.versionId, "version_3");
  assert.equal(next[1]!.versionNumber, 3);
  assert.equal(next[1]!.edit?.status, "accepted");
  assert.equal(next[2], tabs[2]);
}

function findSoffice() {
  const candidates = [
    process.env.SOFFICE_BIN,
    "soffice",
    "libreoffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const probe =
      candidate.includes("/") || candidate === process.env.SOFFICE_BIN
        ? spawnSync(candidate, ["--version"], {
            encoding: "utf8",
            timeout: 10_000,
          })
        : spawnSync("sh", ["-lc", `command -v ${candidate}`], {
            encoding: "utf8",
            timeout: 10_000,
          });
    if (probe.status === 0) {
      return candidate.includes("/") || candidate === process.env.SOFFICE_BIN
        ? candidate
        : probe.stdout.trim().split(/\s+/)[0]!;
    }
  }
  return null;
}

function assertLibreOfficeCanOpen(paths: string[]) {
  const soffice = findSoffice();
  assert.ok(soffice, "soffice or libreoffice must be available");
  const outDir = join(paths[0]!, "..", "pdf");
  mkdirSync(outDir, { recursive: true });
  for (const path of paths) {
    const result: import("node:child_process").SpawnSyncReturns<string> =
      spawnSync(
        soffice,
        ["--headless", "--convert-to", "pdf", "--outdir", outDir, path],
        { encoding: "utf8", timeout: 60_000 },
      );
    assert.equal(
      result.status,
      0,
      `LibreOffice failed to open ${path}: ${result.stderr || result.stdout}`,
    );
    const pdfPath = join(
      outDir,
      path
        .split("/")
        .pop()!
        .replace(/\.docx$/i, ".pdf"),
    );
    assert.equal(existsSync(pdfPath), true, `expected PDF ${pdfPath}`);
  }
  return { soffice, outDir };
}

async function main() {
  const tmpRoot = mkdtempSync(join(tmpdir(), "vera-docx-roundtrip-"));
  const baseBytes = await createBaseDocx();
  addVersion(
    {
      id: "version_1",
      document_id: document.id,
      version_number: 1,
      storage_path: "roundtrip/v1.docx",
      filename: "Roundtrip.docx",
      file_type: "docx",
      source: "upload",
      deleted_at: null,
    },
    baseBytes,
  );

  const proposed = await applyTrackedEdits(
    baseBytes,
    [
      {
        find: "Alpha clause must stay",
        replace: "Alpha clause must be updated",
        context_before: "",
        context_after: ". Beta clause",
      },
      {
        find: "Beta clause must stay",
        replace: "Beta clause must be updated",
        context_before: ". ",
        context_after: ". Gamma",
      },
    ],
    { author: "Mike" },
  );
  assert.equal(proposed.errors.length, 0);
  assert.equal(proposed.changes.length, 2);
  addVersion(
    {
      id: "version_2",
      document_id: document.id,
      version_number: 2,
      storage_path: "roundtrip/v2-proposed.docx",
      filename: "Roundtrip.docx",
      file_type: "docx",
      source: "assistant_edit",
      deleted_at: null,
    },
    proposed.bytes,
  );
  for (const change of proposed.changes) {
    editStatuses.set(change.id, "pending");
  }

  const trackedIds = await extractTrackedChangeIds(proposed.bytes);
  assert.equal(trackedIds.length, 4);
  const approvedV2 = versions[1]!;
  const approvedBytes = storedBytes.get(approvedV2.storage_path)!;
  const approval = makeApproval(approvedV2, approvedBytes);

  const alpha = proposed.changes[0]!;
  const beta = proposed.changes[1]!;
  const acceptAlpha = await commitResolvedChange({
    editId: alpha.id,
    wIds: [alpha.delId, alpha.insId].filter(
      (id): id is string => typeof id === "string",
    ),
    mode: "accept",
    storagePath: "roundtrip/v3-alpha-accepted.docx",
  });
  assert.equal(acceptAlpha.version.version_number, 3);
  assert.equal(document.current_version_id, "version_3");
  assert.equal(editStatuses.get(alpha.id), "accepted");
  assert.equal(
    (
      await extractTrackedChangeIds(
        storedBytes.get("roundtrip/v3-alpha-accepted.docx")!,
      )
    ).length,
    2,
  );
  assertReviewRequiredAfterCurrentChange(approval);
  assert.equal(storedBytes.get(approvedV2.storage_path), approvedBytes);
  assert.equal(
    approvedArtifactBytesMatch(approval.artifact_snapshot[0]!, approvedBytes),
    true,
  );
  assert.equal(
    approvedArtifactBytesMatch(
      approval.artifact_snapshot[0]!,
      storedBytes.get("roundtrip/v3-alpha-accepted.docx")!,
    ),
    false,
  );

  const duplicateAlpha = await commitResolvedDocumentEditVersion(
    {
      documentId: document.id,
      editId: alpha.id,
      status: "accepted",
      resolvedAt: "2026-07-21T09:01:00.000Z",
      filename: "Roundtrip.docx",
      storagePath: "roundtrip/duplicate-alpha.docx",
      bytes: Buffer.from("duplicate"),
    },
    makeDeps(),
  );
  assert.equal(duplicateAlpha.committed, false);
  assert.equal(versions.length, 3);

  const rejectBeta = await commitResolvedChange({
    editId: beta.id,
    wIds: [beta.delId, beta.insId].filter(
      (id): id is string => typeof id === "string",
    ),
    mode: "reject",
    storagePath: "roundtrip/v4-beta-rejected.docx",
  });
  assert.equal(rejectBeta.version.version_number, 4);
  assert.equal(document.current_version_id, "version_4");
  assert.equal(editStatuses.get(beta.id), "rejected");
  assert.equal(
    (
      await extractTrackedChangeIds(
        storedBytes.get("roundtrip/v4-beta-rejected.docx")!,
      )
    ).length,
    0,
  );
  const finalText = await extractDocxBodyText(
    storedBytes.get("roundtrip/v4-beta-rejected.docx")!,
  );
  assert.match(finalText, /Alpha clause must be updated/);
  assert.match(finalText, /Beta clause must stay/);
  assert.doesNotMatch(finalText, /Beta clause must be updated/);
  assertReviewRequiredAfterCurrentChange(approval);
  assertTabsSwitchToResolvedVersion();

  const outputFiles = {
    approvedLockedV2: join(tmpRoot, "approved-locked-v2.docx"),
    afterAcceptV3: join(tmpRoot, "after-accept-v3.docx"),
    finalV4: join(tmpRoot, "final-v4.docx"),
  };
  writeFileSync(outputFiles.approvedLockedV2, approvedBytes);
  writeFileSync(
    outputFiles.afterAcceptV3,
    storedBytes.get("roundtrip/v3-alpha-accepted.docx")!,
  );
  writeFileSync(
    outputFiles.finalV4,
    storedBytes.get("roundtrip/v4-beta-rejected.docx")!,
  );
  const libreOffice = assertLibreOfficeCanOpen(Object.values(outputFiles));

  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "document-edit-resolution-integration-smoke-v1",
        versions: versions.map((version) => ({
          id: version.id,
          version_number: version.version_number,
          storage_path: version.storage_path,
          status:
            version.id === "version_2"
              ? "approved_locked"
              : version.id === document.current_version_id
                ? "current"
                : "historical",
        })),
        current_version_id: document.current_version_id,
        edit_statuses: Object.fromEntries(editStatuses.entries()),
        files: outputFiles,
        libreoffice: libreOffice,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
