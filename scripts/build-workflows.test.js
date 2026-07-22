const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildArtifacts,
  loadLock,
  loadSelectedWorkflows,
  sha256,
  validateLock,
  verifyArtifacts,
} = require("./build-workflows.js");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const GENERATED_PATH = path.join(
  REPOSITORY_ROOT,
  "backend/src/lib/systemWorkflows.ts",
);
const PINNED_COMMIT = "d27064ae8085d3e8ebca99d5a491c9804376cbc7";

function skill(slug, title, type, availability = "system") {
  return `---
name: "${slug}"
description: "${title} description."
license: "MIT"
metadata:
  version: "1.0.0"
  author: "Open Legal Products"
  language: "English"
  mike-display-name: "${title}"
  mike-type: "${type}"
  mike-availability: "${availability}"
  practice: "General"
  jurisdictions: "General"
---
# ${title}

Deterministic instructions.
`;
}

function writeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vera-workflow-test-"));
  const files = new Map([
    [
      "assistant-workflows/core-assistant/SKILL.md",
      skill("core-assistant", "Core Assistant", "assistant"),
    ],
    [
      "tabular-review-workflows/core-tabular/SKILL.md",
      skill("core-tabular", "Core Tabular", "tabular"),
    ],
    [
      "tabular-review-workflows/core-tabular/table-columns.yaml",
      `$schema: "../../workflow-schema/table-columns.schema.yaml"
columns:
  - index: 0
    name: "Finding"
    format: "text"
    prompt: >-
      Extract the supported finding.
`,
    ],
    ["workflow-schema/table-columns.schema.yaml", "type: object\n"],
    [
      "assistant-workflows/unselected/SKILL.md",
      skill("unselected", "Unselected", "assistant"),
    ],
    [
      "assistant-workflows/finnish-law-pack/pack.json",
      '{"id":"finnish-law"}\n',
    ],
    [
      "assistant-workflows/finnish-law-pack/finnish-extra/SKILL.md",
      skill("finnish-extra", "Finnish Extra", "assistant", "add-on"),
    ],
  ]);
  for (const [relativePath, contents] of files) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  }
  return root;
}

function parseGeneratedSystemWorkflows(source) {
  const marker = "export const SYSTEM_WORKFLOWS: SystemWorkflow[] = ";
  const markerIndex = source.indexOf(marker);
  assert.notEqual(markerIndex, -1);
  const start = source.indexOf("[", markerIndex + marker.length);
  const end = source.indexOf("\n];\n\nexport const SYSTEM_WORKFLOW_IDS", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return JSON.parse(source.slice(start, end + 2));
}

test("lock pins the approved 13 assistant and 11 tabular core workflows", () => {
  const lock = loadLock();
  assert.equal(lock.commit, PINNED_COMMIT);
  assert.equal(lock.selection.assistant.length, 13);
  assert.equal(lock.selection.tabular.length, 11);
  assert.equal(lock.expected.workflowCount, 24);
  assert.equal(
    [...lock.selection.assistant, ...lock.selection.tabular].some((slug) =>
      slug.includes("finnish"),
    ),
    false,
  );
});

test("committed artifact has the locked semantics and exact bytes", () => {
  const lock = loadLock();
  const source = fs.readFileSync(GENERATED_PATH, "utf8");
  const workflows = parseGeneratedSystemWorkflows(source);
  const expectedIds = [...lock.selection.assistant, ...lock.selection.tabular]
    .map((slug) => `builtin-${slug}`)
    .sort((a, b) => a.localeCompare(b));

  assert.deepEqual(
    workflows.map((workflow) => workflow.id),
    expectedIds,
  );
  assert.equal(
    workflows.filter((workflow) => workflow.metadata.type === "assistant")
      .length,
    13,
  );
  assert.equal(
    workflows.filter((workflow) => workflow.metadata.type === "tabular").length,
    11,
  );
  assert.equal(sha256(JSON.stringify(workflows)), lock.expected.semanticSha256);
  assert.equal(sha256(source), lock.expected.generatedFileSha256);
});

test("generation reads only explicit direct-child selections", (context) => {
  const sourceRoot = writeFixture();
  context.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const lock = {
    selection: {
      assistant: ["core-assistant"],
      tabular: ["core-tabular"],
    },
  };

  const first = loadSelectedWorkflows(sourceRoot, lock);
  const second = loadSelectedWorkflows(sourceRoot, lock);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((workflow) => workflow.id),
    ["builtin-core-assistant", "builtin-core-tabular"],
  );

  const artifacts = buildArtifacts(first);
  const expected = {
    ...lock,
    expected: {
      workflowCount: 2,
      assistantCount: 1,
      tabularCount: 1,
      semanticSha256: sha256(JSON.stringify(artifacts.systemWorkflows)),
      generatedFileSha256: sha256(artifacts.backendText),
    },
  };
  assert.doesNotThrow(() => verifyArtifacts(artifacts, expected));
  artifacts.systemWorkflows[0].metadata.title = "Drifted";
  assert.throws(
    () => verifyArtifacts(artifacts, expected),
    /semantics changed/,
  );
});

test("lock validation rejects nested pack paths", () => {
  const lock = structuredClone(loadLock());
  lock.selection.assistant[0] = "finnish-law-pack/extra";
  assert.throws(() => validateLock(lock), /Unsafe workflow slug/);
});
