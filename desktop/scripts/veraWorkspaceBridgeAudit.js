const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const preload = fs.readFileSync(path.join(desktopRoot, "preload.js"), "utf8");
const main = fs.readFileSync(path.join(desktopRoot, "main.js"), "utf8");
const runtime = fs.readFileSync(
  path.join(repositoryRoot, "frontend/src/app/lib/veraRuntime.ts"),
  "utf8",
);
const globals = fs.readFileSync(
  path.join(repositoryRoot, "frontend/src/global.d.ts"),
  "utf8",
);
const getInfoStart = main.indexOf('ipcMain.handle("aletheia:get-info"');
const getInfoEnd = main.indexOf(
  'ipcMain.handle("aletheia:get-auth-token"',
  getInfoStart,
);
assert.ok(getInfoStart >= 0 && getInfoEnd > getInfoStart);
const getInfoHandler = main.slice(getInfoStart, getInfoEnd);
const forkUtilityStart = main.indexOf("function forkUtility");
const forkUtilityEnd = main.indexOf(
  "\nasync function waitForCredentialPortReady",
  forkUtilityStart,
);
assert.ok(forkUtilityStart >= 0 && forkUtilityEnd > forkUtilityStart);
const forkUtility = main.slice(forkUtilityStart, forkUtilityEnd);
const utilityOutputFrameStart = main.indexOf(
  "const MAX_UTILITY_OUTPUT_BYTES",
);
const runUtilityOnceStart = main.indexOf("function runUtilityOnce");
assert.ok(
  utilityOutputFrameStart >= 0 && runUtilityOnceStart > utilityOutputFrameStart,
);
const utilityOutputFrame = main.slice(
  utilityOutputFrameStart,
  runUtilityOnceStart,
);
const runUtilityOnceEnd = main.indexOf(
  "\nfunction assertPackagedResources",
  runUtilityOnceStart,
);
assert.ok(
  runUtilityOnceStart >= 0 && runUtilityOnceEnd > runUtilityOnceStart,
);
const runUtilityOnce = main.slice(runUtilityOnceStart, runUtilityOnceEnd);

assert.match(
  preload,
  /exposeInMainWorld\("aletheiaDesktop"/,
  "the existing hardened desktop bridge remains the single IPC surface",
);
assert.doesNotMatch(
  preload,
  /exposeInMainWorld\("veraDesktop"/,
  "a second desktop bridge would duplicate token authority",
);
assert.ok(
  main.includes(
    'workspaceApiUrl: `${BACKEND_URL.replace(/\\\/$/, "")}/api/v1`',
  ),
  "desktop runtime info exposes the actual workspace API port",
);
assert.match(
  runtime,
  /window\.aletheiaDesktop/,
  "Vera transport consumes the packaged bridge",
);
assert.doesNotMatch(
  runtime,
  /window\.veraDesktop/,
  "Vera transport must not depend on a bridge that preload never exposes",
);
assert.match(
  globals,
  /workspaceApiUrl:\s*string/,
  "the packaged bridge contract includes the workspace API URL",
);
assert.doesNotMatch(
  getInfoHandler,
  /(?:dataDir|logsDir):\s*(?:localDataDir\(\)|app\.getPath\("logs"\))/,
  "runtime info must not disclose local filesystem paths to the renderer",
);
assert.doesNotMatch(
  globals,
  /^\s*(?:dataDir|logsDir):\s*string;/m,
  "the renderer bridge type must not advertise local filesystem paths",
);
assert.match(
  forkUtility,
  /utilityProcess\.fork\([\s\S]*?execArgv: \[\],[\s\S]*?env: \{[\s\S]*?selectedProcessEnvironment\(CHILD_RUNTIME_ENV_KEYS\)/u,
  "long-lived utility services must not inherit inspector or host exec arguments",
);
assert.match(
  utilityOutputFrame,
  /const MAX_UTILITY_OUTPUT_BYTES = 32_768;[\s\S]*?Buffer\.byteLength\(output\) > MAX_UTILITY_OUTPUT_BYTES[\s\S]*?output\.indexOf\("\\n"\)[\s\S]*?newline === output\.length - 1/u,
  "one-shot utility output must be one bounded newline-terminated frame",
);
assert.match(
  utilityOutputFrame,
  /async function waitForUtilityOutputFrame\([\s\S]*?timeoutMs = 10_000[\s\S]*?if \(outputFailed\(\)\) return false;[\s\S]*?if \(hasCompleteUtilityOutputFrame\(readOutput\(\)\)\) return true;[\s\S]*?await wait\(10\);[\s\S]*?return false;/u,
  "one-shot utility frame recovery must observe late pipe data and fail on error or timeout",
);
assert.match(
  runUtilityOnce,
  /utilityProcess\.fork\([\s\S]*?execArgv: \[\],[\s\S]*?stdoutStream\?\.on\("error", markStdoutStreamFailed\);[\s\S]*?stderrStream\?\.on\("error", markStderrStreamFailed\);[\s\S]*?stdoutBytes \+= chunk\.length;[\s\S]*?child\.once\("exit", async \(code\) => \{[\s\S]*?code === 0[\s\S]*?await waitForUtilityOutputFrame\([\s\S]*?stdoutStreamFailed[\s\S]*?stderrStreamFailed[\s\S]*?stdoutBytes > MAX_UTILITY_OUTPUT_BYTES[\s\S]*?!outputComplete[\s\S]*?reject\(new Error\(`\$\{label\} returned an incomplete output frame\.`\)\);[\s\S]*?if \(code === 0\)/u,
  "one-shot utility output must track errors and require a complete bounded frame before success",
);

console.log("vera workspace packaged bridge audit passed");
