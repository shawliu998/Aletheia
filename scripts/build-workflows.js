#!/usr/bin/env node

const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const LOCK_PATH = path.join(__dirname, "mike-workflows.lock.json");
const BACKEND_OUT = path.join(
  REPOSITORY_ROOT,
  "backend/src/lib/systemWorkflows.ts",
);
const COLLECTIONS = [
  { key: "assistant", directory: "assistant-workflows" },
  { key: "tabular", directory: "tabular-review-workflows" },
];

function fail(message) {
  throw new Error(message);
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch (error) {
    fail(`${filePath} is not valid JSON: ${error.message}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }
}

function assertOptionalString(value, label) {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") fail(`${label} must be a string`);
}

function assertOptionalStringArray(value, label) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${label} must be an array of strings`);
  }
}

function parseScalar(value, label) {
  const trimmed = value.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      fail(`${label} is not valid inline JSON: ${error.message}`);
    }
  }
  return trimmed;
}

function parseSimpleYaml(source, label) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const result = {};

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (line.startsWith(" ")) {
      fail(`${label}:${i + 1} has unsupported indentation`);
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/);
    if (!match) fail(`${label}:${i + 1} is not valid frontmatter`);
    const key = match[1];
    const rawValue = match[2].trim();

    if (rawValue) {
      result[key] = parseScalar(rawValue, `${label}.${key}`);
      continue;
    }

    const scalarItems = [];
    const objectItems = [];
    const properties = {};
    let mode = null;
    i += 1;
    for (; i < lines.length; i += 1) {
      const child = lines[i];
      if (!child.trim()) continue;
      if (!child.startsWith("  ")) {
        i -= 1;
        break;
      }

      const listMatch = child.match(/^  -(?:\s+(.*))?$/);
      if (listMatch) {
        const itemText = listMatch[1]?.trim() ?? "";
        if (itemText.includes(":")) {
          mode ??= "objects";
          if (mode !== "objects") {
            fail(`${label}.${key} mixes scalar and object list items`);
          }
          const object = {};
          if (itemText) {
            const itemMatch = itemText.match(
              /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/,
            );
            if (!itemMatch) {
              fail(`${label}:${i + 1} is not a valid object list item`);
            }
            object[itemMatch[1]] = parseScalar(
              itemMatch[2],
              `${label}.${key}.${itemMatch[1]}`,
            );
          }
          objectItems.push(object);
          continue;
        }

        mode ??= "scalars";
        if (mode !== "scalars") {
          fail(`${label}.${key} mixes object and scalar list items`);
        }
        scalarItems.push(parseScalar(itemText, `${label}.${key}`));
        continue;
      }

      const childPropMatch = child.match(/^  ([A-Za-z_][A-Za-z0-9_-]*):(.*)$/);
      if (childPropMatch) {
        mode ??= "properties";
        if (mode !== "properties") {
          fail(`${label}.${key} mixes mapping and list values`);
        }
        properties[childPropMatch[1]] = parseScalar(
          childPropMatch[2],
          `${label}.${key}.${childPropMatch[1]}`,
        );
        continue;
      }

      const propMatch = child.match(/^    ([A-Za-z_][A-Za-z0-9_-]*):(.*)$/);
      if (!propMatch || mode !== "objects" || objectItems.length === 0) {
        fail(`${label}:${i + 1} has unsupported frontmatter structure`);
      }
      objectItems[objectItems.length - 1][propMatch[1]] = parseScalar(
        propMatch[2],
        `${label}.${key}.${propMatch[1]}`,
      );
    }

    result[key] =
      mode === "objects"
        ? objectItems
        : mode === "properties"
          ? properties
          : scalarItems;
  }

  return result;
}

function readSkillFile(filePath, sourceRoot) {
  const relativePath = path.relative(sourceRoot, filePath);
  const text = readText(filePath).replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    fail(`${relativePath} must start with YAML frontmatter`);
  }
  const close = text.indexOf("\n---", 4);
  if (close === -1) {
    fail(`${relativePath} is missing closing YAML frontmatter marker`);
  }
  const afterClose = text.slice(close + 4);
  if (afterClose && !afterClose.startsWith("\n")) {
    fail(`${relativePath} has invalid frontmatter closing marker`);
  }
  return {
    metadata: parseSimpleYaml(text.slice(4, close), relativePath),
    body: afterClose.replace(/^\n/, "").trimEnd(),
  };
}

function parseTableColumnsYaml(filePath, sourceRoot) {
  const relativePath = path.relative(sourceRoot, filePath);
  const lines = readText(filePath).replace(/\r\n/g, "\n").split("\n");
  const result = { columns_config: [] };
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i += 1;
      continue;
    }
    const schemaMatch = line.match(/^\$schema:\s*(.+)$/);
    if (schemaMatch) {
      result.$schema = parseScalar(schemaMatch[1], `${relativePath}.$schema`);
      i += 1;
      continue;
    }
    if (line !== "columns:") {
      fail(`${relativePath}:${i + 1} is not valid table columns YAML`);
    }
    i += 1;
    break;
  }

  let current = null;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;

    const itemMatch = line.match(/^  - index:\s*(.+)$/);
    if (itemMatch) {
      current = {
        index: parseScalar(
          itemMatch[1],
          `${relativePath}.columns_config.index`,
        ),
      };
      result.columns_config.push(current);
      continue;
    }
    if (!current) {
      fail(`${relativePath}:${i + 1} column entry must start with index`);
    }

    const propMatch = line.match(/^    ([A-Za-z_][A-Za-z0-9_-]*):(.*)$/);
    if (!propMatch) {
      fail(`${relativePath}:${i + 1} is not a valid column property`);
    }
    const key = propMatch[1];
    const rawValue = propMatch[2].trim();

    if (key === "tags" && rawValue === "") {
      const tags = [];
      i += 1;
      for (; i < lines.length; i += 1) {
        const tagMatch = lines[i].match(/^      -\s*(.+)$/);
        if (!tagMatch) {
          i -= 1;
          break;
        }
        tags.push(parseScalar(tagMatch[1], `${relativePath}.${key}`));
      }
      current.tags = tags;
      continue;
    }

    if ([">-", ">", "|-", "|"].includes(rawValue)) {
      const parts = [];
      i += 1;
      for (; i < lines.length; i += 1) {
        if (!lines[i].startsWith("      ")) {
          i -= 1;
          break;
        }
        parts.push(lines[i].slice(6));
      }
      current[key] = rawValue.startsWith("|")
        ? parts.join("\n")
        : parts.join(" ").replace(/\s+/g, " ").trim();
      continue;
    }

    current[key] = parseScalar(rawValue, `${relativePath}.${key}`);
  }

  return result;
}

function assertColumnConfig(columns, label) {
  if (!Array.isArray(columns) || columns.length === 0) {
    fail(`${label}.columns_config must be a non-empty array`);
  }
  columns.forEach((column, index) => {
    const columnLabel = `${label}.columns_config[${index}]`;
    if (!column || typeof column !== "object" || Array.isArray(column)) {
      fail(`${columnLabel} must be an object`);
    }
    if (!Number.isInteger(column.index)) {
      fail(`${columnLabel}.index must be an integer`);
    }
    if (column.index !== index) {
      fail(`${columnLabel}.index must equal ${index}`);
    }
    assertString(column.name, `${columnLabel}.name`);
    assertString(column.prompt, `${columnLabel}.prompt`);
    assertOptionalString(column.format, `${columnLabel}.format`);
    assertOptionalStringArray(column.tags, `${columnLabel}.tags`);
  });
}

function validateLock(lock) {
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) {
    fail("Workflow lock must be an object");
  }
  if (lock.schemaVersion !== 1) fail("Unsupported workflow lock schema");
  assertString(lock.repository, "lock.repository");
  if (!/^[a-f0-9]{40}$/.test(lock.commit ?? "")) {
    fail("lock.commit must be a full lowercase 40-character Git commit");
  }
  if (lock.license !== "MIT") fail("lock.license must be MIT");

  for (const collection of COLLECTIONS) {
    const selected = lock.selection?.[collection.key];
    if (!Array.isArray(selected) || selected.length === 0) {
      fail(`lock.selection.${collection.key} must be a non-empty array`);
    }
    for (const slug of selected) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
        fail(
          `Unsafe workflow slug in lock.selection.${collection.key}: ${slug}`,
        );
      }
    }
    const sorted = [...selected].sort((a, b) => a.localeCompare(b));
    if (JSON.stringify(selected) !== JSON.stringify(sorted)) {
      fail(`lock.selection.${collection.key} must be sorted`);
    }
    if (new Set(selected).size !== selected.length) {
      fail(`lock.selection.${collection.key} contains duplicates`);
    }
  }

  const assistantCount = lock.selection.assistant.length;
  const tabularCount = lock.selection.tabular.length;
  if (
    lock.expected?.assistantCount !== assistantCount ||
    lock.expected?.tabularCount !== tabularCount ||
    lock.expected?.workflowCount !== assistantCount + tabularCount
  ) {
    fail("Workflow lock counts do not match the explicit selection");
  }
  for (const field of ["semanticSha256", "generatedFileSha256"]) {
    if (!/^[a-f0-9]{64}$/.test(lock.expected?.[field] ?? "")) {
      fail(`lock.expected.${field} must be a lowercase SHA-256`);
    }
  }
  return lock;
}

function loadLock(filePath = LOCK_PATH) {
  return validateLock(readJson(filePath));
}

function readWorkflow(sourceRoot, category, collectionDirectory, slug) {
  const workflowDir = path.join(sourceRoot, collectionDirectory, slug);
  const skillPath = path.join(workflowDir, "SKILL.md");
  const relativeSkillPath = path.relative(sourceRoot, skillPath);
  if (!fs.existsSync(skillPath)) fail(`${relativeSkillPath} is required`);

  const { metadata: frontmatter, body: skillMd } = readSkillFile(
    skillPath,
    sourceRoot,
  );
  const label = `${relativeSkillPath} frontmatter`;
  const metadata = frontmatter.metadata;

  assertString(frontmatter.name, `${label}.name`);
  if (frontmatter.name !== slug) {
    fail(`${label}.name must match the locked folder name "${slug}"`);
  }
  assertString(frontmatter.description, `${label}.description`);
  if (frontmatter.license !== "MIT") fail(`${label}.license must be MIT`);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail(`${label}.metadata must be a mapping`);
  }
  assertString(metadata.author, `${label}.metadata.author`);
  assertString(metadata.language, `${label}.metadata.language`);
  assertString(metadata.version, `${label}.metadata.version`);
  assertString(
    metadata["mike-display-name"],
    `${label}.metadata.mike-display-name`,
  );
  if (metadata["mike-type"] !== category) {
    fail(`${label}.metadata.mike-type must be "${category}"`);
  }
  if (metadata["mike-availability"] !== "system") {
    fail(`${label}.metadata.mike-availability must be "system"`);
  }
  assertString(metadata.practice, `${label}.metadata.practice`);
  assertString(metadata.jurisdictions, `${label}.metadata.jurisdictions`);

  const normalizedMetadata = {
    title: metadata["mike-display-name"],
    description: frontmatter.description,
    type: category,
    contributors: [
      {
        name: metadata.author.trim(),
        organisation: null,
        role: null,
        linkedin: null,
      },
    ],
    language: metadata.language,
    version: metadata.version,
    practice: metadata.practice,
    jurisdictions: metadata.jurisdictions
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };

  if (category === "assistant") {
    if (!skillMd.trim()) fail(`${relativeSkillPath} must include instructions`);
    if (fs.existsSync(path.join(workflowDir, "table-columns.yaml"))) {
      fail(`${relativeSkillPath} assistant workflow must not define columns`);
    }
    return {
      id: `builtin-${slug}`,
      metadata: normalizedMetadata,
      skill_md: skillMd,
      columns_config: null,
    };
  }

  const tableColumnsPath = path.join(workflowDir, "table-columns.yaml");
  if (!fs.existsSync(tableColumnsPath)) {
    fail(`${path.relative(sourceRoot, tableColumnsPath)} is required`);
  }
  const tableConfig = parseTableColumnsYaml(tableColumnsPath, sourceRoot);
  const expectedSchemaPath = path.join(
    sourceRoot,
    "workflow-schema/table-columns.schema.yaml",
  );
  const actualSchemaPath = path.resolve(workflowDir, tableConfig.$schema ?? "");
  if (actualSchemaPath !== expectedSchemaPath) {
    fail(
      `${path.relative(sourceRoot, tableColumnsPath)}.$schema must point to workflow-schema/table-columns.schema.yaml`,
    );
  }
  assertColumnConfig(
    tableConfig.columns_config,
    path.relative(sourceRoot, tableColumnsPath),
  );
  return {
    id: `builtin-${slug}`,
    metadata: normalizedMetadata,
    skill_md: skillMd || null,
    columns_config: tableConfig.columns_config,
  };
}

function loadSelectedWorkflows(sourceRoot, lock) {
  const workflows = [];
  const seenIds = new Set();
  for (const collection of COLLECTIONS) {
    for (const slug of lock.selection[collection.key]) {
      const workflow = readWorkflow(
        sourceRoot,
        collection.key,
        collection.directory,
        slug,
      );
      if (seenIds.has(workflow.id))
        fail(`Duplicate workflow id: ${workflow.id}`);
      seenIds.add(workflow.id);
      workflows.push(workflow);
    }
  }
  return workflows.sort((a, b) => a.id.localeCompare(b.id));
}

function formatTs(value) {
  return JSON.stringify(value, null, 4);
}

function buildArtifacts(workflows) {
  const systemWorkflows = workflows.map((workflow) => ({
    user_id: null,
    is_system: true,
    created_at: "",
    id: workflow.id,
    metadata: workflow.metadata,
    skill_md: workflow.skill_md,
    columns_config: workflow.columns_config,
  }));
  const systemAssistantWorkflows = workflows
    .filter((workflow) => workflow.metadata.type === "assistant")
    .map((workflow) => ({
      id: workflow.id,
      title: workflow.metadata.title,
      skill_md: workflow.skill_md,
    }));
  const backendText = `// This file is generated by scripts/build-workflows.js. Do not edit it directly.\n\nexport type SystemWorkflowContributor = {\n    name: string;\n    organisation: string | null;\n    role: string | null;\n    linkedin: string | null;\n};\n\nexport type SystemWorkflowMetadata = {\n    title: string;\n    description: string;\n    type: "assistant" | "tabular";\n    contributors: SystemWorkflowContributor[];\n    language: string;\n    version: string;\n    practice: string | null;\n    jurisdictions: string[] | null;\n};\n\nexport type SystemWorkflow = {\n    id: string;\n    user_id: null;\n    is_system: true;\n    created_at: string;\n    metadata: SystemWorkflowMetadata;\n    skill_md: string | null;\n    columns_config: { index: number; name: string; format?: string; prompt: string; tags?: string[] }[] | null;\n};\n\nexport const SYSTEM_WORKFLOWS: SystemWorkflow[] = ${formatTs(systemWorkflows)};\n\nexport const SYSTEM_WORKFLOW_IDS = new Set(SYSTEM_WORKFLOWS.map((wf) => wf.id));\n\nexport const SYSTEM_ASSISTANT_WORKFLOWS: { id: string; title: string; skill_md: string }[] = ${formatTs(systemAssistantWorkflows)};\n`;
  return { backendText, systemWorkflows, systemAssistantWorkflows };
}

function verifyArtifacts(artifacts, lock) {
  const assistantCount = artifacts.systemWorkflows.filter(
    (workflow) => workflow.metadata.type === "assistant",
  ).length;
  const tabularCount = artifacts.systemWorkflows.filter(
    (workflow) => workflow.metadata.type === "tabular",
  ).length;
  if (
    artifacts.systemWorkflows.length !== lock.expected.workflowCount ||
    assistantCount !== lock.expected.assistantCount ||
    tabularCount !== lock.expected.tabularCount
  ) {
    fail(
      `Generated workflow counts changed: ${assistantCount} assistant + ${tabularCount} tabular`,
    );
  }

  const semanticSha256 = sha256(JSON.stringify(artifacts.systemWorkflows));
  const generatedFileSha256 = sha256(artifacts.backendText);
  if (semanticSha256 !== lock.expected.semanticSha256) {
    fail(
      `Generated workflow semantics changed: expected ${lock.expected.semanticSha256}, received ${semanticSha256}`,
    );
  }
  if (generatedFileSha256 !== lock.expected.generatedFileSha256) {
    fail(
      `Generated file changed: expected ${lock.expected.generatedFileSha256}, received ${generatedFileSha256}`,
    );
  }
  return { semanticSha256, generatedFileSha256 };
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const detail = (
      result.stderr ||
      result.stdout ||
      "unknown Git error"
    ).trim();
    fail(`git ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function verifySourceCommit(sourceRoot, lock) {
  const actual = runGit(["rev-parse", "HEAD"], sourceRoot);
  if (actual !== lock.commit) {
    fail(`Workflow source HEAD must be ${lock.commit}; received ${actual}`);
  }
}

function acquireSource(lock, explicitSource) {
  if (explicitSource) {
    const sourceRoot = path.resolve(explicitSource);
    if (!fs.existsSync(sourceRoot))
      fail(`Workflow source not found: ${sourceRoot}`);
    verifySourceCommit(sourceRoot, lock);
    return { sourceRoot, cleanup: () => {} };
  }

  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "vera-mike-workflows-"),
  );
  const sourceRoot = path.join(temporaryRoot, "source");
  fs.mkdirSync(sourceRoot);
  try {
    runGit(["init", "--quiet"], sourceRoot);
    runGit(["remote", "add", "origin", lock.repository], sourceRoot);
    runGit(
      [
        "fetch",
        "--quiet",
        "--depth=1",
        "--filter=blob:none",
        "--no-tags",
        "origin",
        lock.commit,
      ],
      sourceRoot,
    );
    runGit(["checkout", "--quiet", "--detach", "FETCH_HEAD"], sourceRoot);
    verifySourceCommit(sourceRoot, lock);
  } catch (error) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    sourceRoot,
    cleanup: () => fs.rmSync(temporaryRoot, { recursive: true, force: true }),
  };
}

function parseArgs(args) {
  const options = { mode: "check", source: null };
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    if (argument === "--check") {
      options.mode = "check";
    } else if (argument === "--write") {
      options.mode = "write";
    } else if (argument === "--source") {
      i += 1;
      if (!args[i]) fail("--source requires a path");
      options.source = args[i];
    } else if (argument === "--help") {
      options.help = true;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function writeAtomically(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, value);
  fs.renameSync(temporaryPath, filePath);
}

function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.help) {
    console.log(
      "Usage: node scripts/build-workflows.js [--check|--write] [--source PATH]",
    );
    return;
  }

  const lock = loadLock();
  const acquired = acquireSource(lock, options.source);
  try {
    const workflows = loadSelectedWorkflows(acquired.sourceRoot, lock);
    const artifacts = buildArtifacts(workflows);
    const digests = verifyArtifacts(artifacts, lock);
    const current = fs.existsSync(BACKEND_OUT) ? readText(BACKEND_OUT) : null;

    if (options.mode === "check") {
      if (current !== artifacts.backendText) {
        fail(
          "backend/src/lib/systemWorkflows.ts is out of sync; run npm run workflows:sync from backend/",
        );
      }
      console.log(
        `Workflow sync check passed: ${workflows.length} workflows at ${lock.commit}; semantic ${digests.semanticSha256}.`,
      );
      return;
    }

    if (current === artifacts.backendText) {
      console.log(
        `Workflow artifact already current: ${workflows.length} workflows; zero byte drift.`,
      );
      return;
    }
    writeAtomically(BACKEND_OUT, artifacts.backendText);
    console.log(`Generated ${workflows.length} locked system workflows.`);
  } finally {
    acquired.cleanup();
  }
}

module.exports = {
  buildArtifacts,
  loadLock,
  loadSelectedWorkflows,
  parseArgs,
  sha256,
  validateLock,
  verifyArtifacts,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
