import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

type DoctorCheck = {
  id: string;
  ok: boolean;
  severity: "critical" | "warning";
  detail: string;
};

const MODEL_KEY_NAMES = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "COURTLISTENER_API_TOKEN",
];

function env(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function repoRoot() {
  return path.resolve(process.cwd(), "..");
}

function resolveDataDir() {
  const configured =
    env("ALETHEIA_DATA_DIR") ?? env("ALET_HEIA_DATA_DIR") ?? ".data/aletheia";
  return path.resolve(process.cwd(), configured);
}

function storageDriver() {
  return env("ALETHEIA_STORAGE_DRIVER") ?? env("ALET_HEIA_STORAGE_MODE") ?? "local";
}

function authMode() {
  return env("ALETHEIA_AUTH_MODE") ?? env("ALET_HEIA_AUTH_MODE") ?? "single_user";
}

function semanticEnabled() {
  return (env("ALETHEIA_SEMANTIC_INDEX_ENABLED") ?? "false").toLowerCase() ===
    "true";
}

function check(
  id: string,
  ok: boolean,
  detail: string,
  severity: "critical" | "warning" = "critical",
): DoctorCheck {
  return { id, ok, severity, detail };
}

async function sqliteAvailable() {
  try {
    await import("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function assertWritableDataDirs(dataDir: string) {
  const requiredDirs = [
    dataDir,
    path.join(dataDir, "documents"),
    path.join(dataDir, "exports"),
    path.join(dataDir, "index"),
  ];
  for (const dir of requiredDirs) {
    mkdirSync(dir, { recursive: true });
  }

  const probePath = path.join(dataDir, ".aletheia-doctor-write-test");
  writeFileSync(probePath, new Date().toISOString());
  rmSync(probePath, { force: true });
  return requiredDirs;
}

function isSubpath(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function main() {
  const root = repoRoot();
  const dataDir = resolveDataDir();
  const actualStorageDriver = storageDriver();
  const actualAuthMode = authMode();
  const retrievalMode = env("ALETHEIA_RETRIEVAL_MODE") ?? "keyword";
  const semanticDriver = env("ALETHEIA_SEMANTIC_INDEX_DRIVER") ?? "disabled";
  const semanticIndexDir = path.resolve(
    process.cwd(),
    env("ALETHEIA_SEMANTIC_INDEX_DIR") ??
      path.join(dataDir, "index", "semantic-local"),
  );
  const nodeMajor = Number(process.versions.node.split(".")[0] ?? "0");
  const modelKeysPresent = MODEL_KEY_NAMES.filter((name) => Boolean(env(name)));

  let writableDirs: string[] = [];
  let writable = false;
  let writableError: string | null = null;
  try {
    writableDirs = assertWritableDataDirs(dataDir);
    writable = true;
  } catch (error) {
    writableError = error instanceof Error ? error.message : String(error);
  }

  const sqliteOk = await sqliteAvailable();
  const privateToken = env("ALETHEIA_PRIVATE_AUTH_TOKEN");
  const privateTokenOk =
    actualAuthMode !== "private_token" ||
    Boolean(privateToken && privateToken.length >= 24);

  const checks: DoctorCheck[] = [
    check(
      "node-runtime",
      nodeMajor >= 22,
      `Node ${process.versions.node} detected; Aletheia local SQLite runtime expects Node 22 or newer.`,
    ),
    check(
      "node-sqlite",
      sqliteOk,
      "node:sqlite must be importable for the default local repository.",
    ),
    check(
      "local-storage-driver",
      actualStorageDriver === "local",
      `ALETHEIA_STORAGE_DRIVER resolved to ${actualStorageDriver}; local professional workflows should run with local storage.`,
    ),
    check(
      "local-auth-mode",
      actualAuthMode === "single_user" || actualAuthMode === "private_token",
      `ALETHEIA_AUTH_MODE resolved to ${actualAuthMode}; expected single_user or private_token for local/private deployment.`,
    ),
    check(
      "private-token",
      privateTokenOk,
      "private_token mode requires ALETHEIA_PRIVATE_AUTH_TOKEN with at least 24 characters.",
    ),
    check(
      "data-directory",
      writable,
      writable
        ? `Local data directories are writable under ${dataDir}.`
        : `Local data directory is not writable: ${writableError ?? "unknown error"}`,
    ),
    check(
      "retrieval-default",
      retrievalMode === "keyword" || retrievalMode === "hybrid" || retrievalMode === "semantic",
      `ALETHEIA_RETRIEVAL_MODE resolved to ${retrievalMode}; expected keyword, hybrid, or semantic.`,
    ),
    check(
      "semantic-fail-closed",
      !semanticEnabled() || semanticDriver === "local-json",
      `Semantic retrieval is ${semanticEnabled() ? "enabled" : "disabled"} with driver ${semanticDriver}; only local-json is currently supported.`,
    ),
    check(
      "semantic-index-boundary",
      isSubpath(dataDir, semanticIndexDir),
      `Semantic index directory must stay under ALETHEIA_DATA_DIR. Resolved path: ${semanticIndexDir}`,
    ),
    check(
      "model-provider-keys",
      modelKeysPresent.length === 0,
      modelKeysPresent.length
        ? `Cloud or external model/source keys are present: ${modelKeysPresent.join(", ")}. Keep cloud fallback disabled unless explicitly approved.`
        : "No cloud/external model keys detected in this process environment.",
      "warning",
    ),
    check(
      "browser-token-exposure",
      actualAuthMode !== "private_token" ||
        env("NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN") === privateToken,
      "If private_token mode is used from a local browser, NEXT_PUBLIC_ALETHEIA_PRIVATE_AUTH_TOKEN should match the backend token; broader deployments should inject it server-side.",
      "warning",
    ),
  ];

  const failedCritical = checks.filter(
    (entry) => !entry.ok && entry.severity === "critical",
  );
  const warnings = checks.filter(
    (entry) => !entry.ok && entry.severity === "warning",
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: failedCritical.length === 0,
        suite: "aletheia-local-doctor-v0",
        checkedAt: new Date().toISOString(),
        repositoryRoot: root,
        dataDir,
        writableDirs,
        warnings: warnings.length,
        checks,
      },
      null,
      2,
    )}\n`,
  );

  if (failedCritical.length > 0) {
    process.exitCode = 1;
  }
}

main();
