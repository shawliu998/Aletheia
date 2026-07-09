import { readFileSync } from "node:fs";
import path from "node:path";
import { XMLValidator } from "fast-xml-parser";

type Check = { id: string; ok: boolean; detail: string };

function read(root: string, relative: string) {
  return readFileSync(path.join(root, relative), "utf8");
}

function main() {
  const root = path.resolve(process.cwd(), "..");
  const manifest = read(root, "office-addin/word-manifest.xml");
  const page = read(root, "frontend/src/app/office/word/page.tsx");
  const xmlValidation = XMLValidator.validate(manifest);
  const checks: Check[] = [
    {
      id: "manifest-well-formed",
      ok: xmlValidation === true,
      detail: "Word manifest must be well-formed XML.",
    },
    {
      id: "word-taskpane-host",
      ok: manifest.includes('xsi:type="TaskPaneApp"') && manifest.includes('<Host Name="Document"') && manifest.includes('Name="WordApi"'),
      detail: "Manifest must target Word with a task pane and WordApi requirement.",
    },
    {
      id: "https-taskpane-source",
      ok: manifest.includes('SourceLocation DefaultValue="https://localhost:3000/office/word"') && manifest.includes('Taskpane.Url'),
      detail: "Manifest must reference the HTTPS Hermes task pane source.",
    },
    {
      id: "read-only-permission",
      ok: manifest.includes('<Permissions>ReadDocument</Permissions>'),
      detail: "Manifest must request read-only document permission for the review handoff.",
    },
    {
      id: "office-selection-capture",
      ok: page.includes('appsforoffice.microsoft.com/lib/1/hosted/office.js') && page.includes('getSelectedDataAsync') && page.includes('Office.js'),
      detail: "Task pane must load Office.js and capture the active Word selection.",
    },
    {
      id: "no-word-write-api",
      ok: !['setSelectedDataAsync', 'insertText', 'context.sync()', 'trackRevisions'].some((pattern) => page.includes(pattern)),
      detail: "Task pane must not invoke Word content mutation or tracked-change APIs.",
    },
    {
      id: "review-audit-handoff",
      ok: ['createAletheiaWorkProduct', 'addAletheiaReview', 'appendAletheiaAuditEvent', 'wordClientApplied: false', 'needs_review'].every((pattern) => page.includes(pattern)),
      detail: "Task pane must persist a reviewable, audited handoff without applying an edit.",
    },
  ];
  const failed = checks.filter((check) => !check.ok);
  process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, suite: "aletheia-word-addin-manifest-audit-v1", checks }, null, 2)}\n`);
  if (failed.length) process.exitCode = 1;
}

main();
