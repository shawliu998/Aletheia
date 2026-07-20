"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { normalizeConnectedAppUrl } = require("./connectedConfig");

const CONNECTION_FILE = "connection.json";
const CONNECTION_SCHEMA_VERSION = 1;
const MAX_CONNECTION_FILE_BYTES = 4096;

function connectionFilePath(userDataPath) {
  return path.join(userDataPath, CONNECTION_FILE);
}

function lstatIfPresent(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertRealDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directoryPath);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("Vera's desktop profile must be a real directory.");
  }
  fs.chmodSync(directoryPath, 0o700);
}

function readStoredConnection(userDataPath) {
  const filePath = connectionFilePath(userDataPath);
  const info = lstatIfPresent(filePath);
  if (!info) return null;
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > MAX_CONNECTION_FILE_BYTES ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error("The saved Vera connection is invalid.");
  }
  let document;
  try {
    document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error("The saved Vera connection could not be read.");
  }
  if (
    !document ||
    document.version !== CONNECTION_SCHEMA_VERSION ||
    typeof document.appUrl !== "string"
  ) {
    throw new Error("The saved Vera connection uses an unsupported format.");
  }
  return normalizeConnectedAppUrl(document.appUrl);
}

function writeStoredConnection(userDataPath, rawAppUrl) {
  const appUrl = normalizeConnectedAppUrl(rawAppUrl);
  assertRealDirectory(userDataPath);
  const filePath = connectionFilePath(userDataPath);
  const existing = lstatIfPresent(filePath);
  if (existing) {
    const info = existing;
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("The saved Vera connection path is unsafe.");
    }
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const payload = `${JSON.stringify(
    {
      version: CONNECTION_SCHEMA_VERSION,
      appUrl: appUrl.toString(),
    },
    null,
    2,
  )}\n`;
  try {
    fs.writeFileSync(temporaryPath, payload, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return appUrl;
}

module.exports = {
  CONNECTION_FILE,
  CONNECTION_SCHEMA_VERSION,
  MAX_CONNECTION_FILE_BYTES,
  connectionFilePath,
  readStoredConnection,
  writeStoredConnection,
};
