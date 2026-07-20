#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  isExternalBrowserUrl,
  isSameConnectedOrigin,
  normalizeConnectedAppUrl,
} = require("../connectedConfig");
const {
  connectionFilePath,
  readStoredConnection,
  writeStoredConnection,
} = require("../connectedConnectionStore");

const desktopRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(
  path.join(desktopRoot, "connectedMain.js"),
  "utf8",
);
const packageDocument = JSON.parse(
  fs.readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
);

assert.equal(
  normalizeConnectedAppUrl("https://vera.example").toString(),
  "https://vera.example/assistant",
);
assert.equal(
  normalizeConnectedAppUrl("http://127.0.0.1:3002/assistant").origin,
  "http://127.0.0.1:3002",
);
assert.throws(() => normalizeConnectedAppUrl("http://vera.example"), /HTTPS/);
assert.throws(
  () => normalizeConnectedAppUrl("file:///tmp/index.html"),
  /HTTPS/,
);
assert.throws(
  () => normalizeConnectedAppUrl("https://user:secret@vera.example"),
  /credentials/,
);
assert.equal(
  isSameConnectedOrigin(
    "https://vera.example/projects/1",
    new URL("https://vera.example/assistant"),
  ),
  true,
);
assert.equal(
  isSameConnectedOrigin(
    "https://attacker.example",
    new URL("https://vera.example"),
  ),
  false,
);
assert.equal(isExternalBrowserUrl("mailto:support@vera.example"), true);
assert.equal(isExternalBrowserUrl("javascript:alert(1)"), false);

const connectionProfile = fs.mkdtempSync(
  path.join(os.tmpdir(), "vera-connection-audit-"),
);
try {
  assert.equal(readStoredConnection(connectionProfile), null);
  const stored = writeStoredConnection(
    connectionProfile,
    "https://vera.example",
  );
  assert.equal(stored.toString(), "https://vera.example/assistant");
  assert.equal(
    readStoredConnection(connectionProfile).toString(),
    "https://vera.example/assistant",
  );
  assert.equal(
    fs.statSync(connectionFilePath(connectionProfile)).mode & 0o777,
    0o600,
  );
  assert.equal(fs.statSync(connectionProfile).mode & 0o777, 0o700);
  fs.chmodSync(connectionFilePath(connectionProfile), 0o644);
  assert.throws(() => readStoredConnection(connectionProfile), /invalid/);
  fs.rmSync(connectionFilePath(connectionProfile));
  fs.symlinkSync("missing-connection.json", connectionFilePath(connectionProfile));
  assert.throws(
    () => writeStoredConnection(connectionProfile, "https://vera.example"),
    /unsafe/,
  );
} finally {
  fs.rmSync(connectionProfile, { recursive: true, force: true });
}

assert.match(source, /contextIsolation: true/);
assert.match(source, /nodeIntegration: false/);
assert.match(source, /sandbox: true/);
assert.match(source, /webSecurity: true/);
assert.match(source, /navigateOnDragDrop: false/);
assert.match(source, /setPermissionCheckHandler\(\(\) => false\)/);
assert.match(source, /setPermissionRequestHandler/);
assert.match(source, /setWindowOpenHandler/);
assert.match(source, /will-navigate/);
assert.match(source, /will-attach-webview/);
assert.match(source, /path\.isAbsolute\(explicitProfile\)/);
assert.match(source, /profileInfo\.isSymbolicLink\(\)/);
assert.match(source, /app\.setPath\("userData", explicitProfile\)/);
assert.match(source, /isTrustedSetupSender\(event\)/);
assert.match(source, /writeStoredConnection\(app\.getPath\("userData"\)/);
assert.match(source, /Connection settings are available only from Vera setup/);
assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE|API_KEY|AUTH_TOKEN/);
assert.equal(packageDocument.main, "connectedMain.js");
assert.equal(packageDocument.build.productName, "Vera");
assert.equal(packageDocument.build.appId, "ai.vera.desktop");
assert.deepEqual(packageDocument.build.extraResources ?? [], []);
for (const setupFile of [
  "connectedConnectionStore.js",
  "connectedSetup.html",
  "connectedSetup.css",
  "connectedSetup.js",
]) {
  assert.ok(packageDocument.build.files.includes(setupFile));
}

console.log(
  JSON.stringify(
    { ok: true, suite: "vera-connected-desktop-security-v1" },
    null,
    2,
  ),
);
