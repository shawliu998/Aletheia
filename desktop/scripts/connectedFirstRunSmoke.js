#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const packagedApp = process.env.VERA_PACKAGED_APP_PATH;
assert.ok(packagedApp, "VERA_PACKAGED_APP_PATH is required.");
const executable = path.join(packagedApp, "Contents", "MacOS", "Vera");
assert.ok(fs.existsSync(executable), "The packaged Vera executable is missing.");

const isolatedProfile = fs.mkdtempSync(
  path.join(os.tmpdir(), "vera-connected-first-run-"),
);
fs.chmodSync(isolatedProfile, 0o700);
const environment = { ...process.env };
delete environment.VERA_APP_URL;
Object.assign(environment, {
  VERA_DESKTOP_PROFILE_DIR: isolatedProfile,
  VERA_TEST_AUTO_QUIT_MS: "750",
});

const child = spawn(executable, [], {
  cwd: path.dirname(executable),
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let rendererReady = false;
let timedOut = false;
let cleanupSignal = null;
let cleanupTimer = null;
const append = (chunk) => {
  output = `${output}${chunk.toString()}`.slice(-16_384);
  if (!rendererReady && /\[vera-connected\] renderer-ready origin=status/.test(output)) {
    rendererReady = true;
    cleanupTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        // Startup is the behavior under test. Force-stop the isolated app
        // after readiness because macOS may defer SIGTERM or app.quit().
        cleanupSignal = "SIGKILL";
        child.kill(cleanupSignal);
      }
    }, 100);
  }
};
child.stdout.on("data", append);
child.stderr.on("data", append);

const timeout = setTimeout(() => {
  timedOut = true;
  cleanupSignal = "SIGKILL";
  child.kill(cleanupSignal);
}, 30_000);

child.once("exit", (code, signal) => {
  clearTimeout(timeout);
  if (cleanupTimer) clearTimeout(cleanupTimer);
  try {
    assert.equal(timedOut, false, output);
    assert.equal(rendererReady, true, output);
    assert.ok(
      (signal === null && code === 0) ||
        (cleanupSignal === "SIGKILL" && signal === "SIGKILL"),
      output,
    );
    assert.equal(
      fs.existsSync(path.join(isolatedProfile, "connection.json")),
      false,
      "First-run setup must not invent or persist a workspace address.",
    );
    console.log(
      JSON.stringify(
        { ok: true, suite: "vera-connected-first-run-smoke-v1" },
        null,
        2,
      ),
    );
  } finally {
    fs.rmSync(isolatedProfile, { recursive: true, force: true });
  }
});
