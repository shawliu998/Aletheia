import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(__dirname, "..");

function source(relativePath: string) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

test("Workflow and Studio share one pinned Mike rich-text editor implementation", () => {
  const shared = source("src/app/components/shared/VeraRichTextEditor.tsx");
  const workflow = source(
    "src/app/components/workflows/VeraWorkflowPromptEditor.tsx",
  );
  const studio = source("src/app/components/projects/DocumentStudioView.tsx");

  assert.match(shared, /e32daad5a4c64a5561e04c53ee12411e3c5e7238/);
  assert.match(shared, /@tiptap\/react/);
  assert.match(shared, /StarterKit/);
  assert.match(shared, /TableKit/);
  assert.match(shared, /onClick=\{\(\) => insertTable\(rows, cols\)\}/);
  assert.match(workflow, /VeraRichTextEditor/);
  assert.match(studio, /VeraRichTextEditor/);
  assert.doesNotMatch(workflow, /@tiptap|useEditor|StarterKit|TableKit/);
  assert.doesNotMatch(studio, /@tiptap|useEditor|StarterKit|TableKit/);
});

test("Studio stays inside Project documents and uses only real capability/API state", () => {
  const documents = source(
    "src/app/components/projects/ProjectDocumentsView.tsx",
  );
  const documentPanel = source(
    "src/app/components/projects/DocumentSidePanel.tsx",
  );
  const studio = source("src/app/components/projects/DocumentStudioView.tsx");
  const route = source(
    "src/app/(pages)/projects/[id]/documents/[documentId]/studio/page.tsx",
  );
  const sidebar = source("src/app/components/vera-shell/VeraSidebar.tsx");

  assert.match(documents, /studio_capability\?\.editable === true/);
  assert.match(
    documents,
    /studio_capability\?\.editable !== true && \([\s\S]*documents\.newVersion/,
  );
  assert.match(
    documentPanel,
    /studio_capability\?\.editable !== true && \([\s\S]*documents\.newVersion/,
  );
  assert.match(documents, /createVeraStudioDocument/);
  assert.match(documents, /documents\/\$\{document\.id\}\/studio/);
  assert.match(route, /DocumentStudioView/);
  for (const helper of [
    "getVeraStudioDocument",
    "saveVeraStudioDocument",
    "listVeraStudioVersions",
    "restoreVeraStudioVersion",
    "importVeraStudioDocx",
    "exportVeraStudioDocx",
  ]) {
    assert.match(studio, new RegExp(`\\b${helper}\\b`));
  }
  assert.match(studio, /expected_version_id: document\.current_version_id/);
  assert.match(studio, /error\.status === 409/);
  assert.match(studio, /error\.code === "CONFLICT"/);
  assert.match(studio, /citation_anchors\.map/);
  assert.match(studio, /displayDocument\.citation_anchors/);
  assert.match(studio, /ariaLabel=\{t\("studio\.editorLabel"\)\}/);
  assert.match(studio, /document\.capabilities\.docx_import === true/);
  assert.match(studio, /document\.capabilities\.docx_export === true/);
  assert.match(studio, /historical === null[\s\S]*!dirty[\s\S]*errorKind !== "conflict"/);
  assert.match(studio, /selectedVersionId = \(historical \?\? document\)\.version\.id/);
  assert.match(studio, /expectedVersionId = document\.current_version_id/);
  assert.match(studio, /setDocxWarnings/);
  assert.match(studio, /studio\.docx\.exportSavedOnly/);
  assert.match(studio, /ConfirmPopup[\s\S]*studio\.docx\.confirm\.title/);
  assert.doesNotMatch(
    studio,
    /setTimeout[\s\S]{0,120}(?:setWorkingContent|setSavedContent|setDocument|setVersions)/,
  );
  assert.doesNotMatch(studio, /mock|fixture|demo|localStorage|sessionStorage/);
  assert.doesNotMatch(sidebar, /Document Studio|studio\.title/);
});

test("Studio wire is strict, Project-scoped, and does not claim fake idempotency", () => {
  const api = source("src/app/lib/veraDocumentStudioApi.ts");
  const transport = source("src/app/lib/veraApi.ts");

  assert.match(api, /\/projects\/\$\{safeId\(projectId/);
  assert.match(api, /expected_version_id/);
  assert.match(api, /expected_current_version_id/);
  assert.match(api, /import-docx/);
  assert.match(api, /export-docx/);
  assert.match(api, /warningCodeAllowlist: VERA_STUDIO_DOCX_WARNING_CODES/);
  assert.match(api, /mime_type: "text\/markdown";/);
  assert.match(api, /exactKeys/);
  assert.match(transport, /"studio_capability"/);
  assert.match(transport, /capability\.editable/);
  assert.match(transport, /!docxImport \|\| !docxExport/);
  assert.match(transport, /capability\.format !== null \|\| docxImport \|\| docxExport/);
  assert.doesNotMatch(api, /operation_id|setTimeout|fetch\s*\(/);
});
