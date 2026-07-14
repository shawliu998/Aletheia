"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const SECURITY_PATH = "/usr/bin/security";
const SECURITY_TIMEOUT_MS = 10_000;
const ITEM_NOT_FOUND_MESSAGE =
  "The specified item could not be found in the keychain.";

function securityExecOptions() {
  return {
    encoding: "utf8",
    timeout: SECURITY_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  };
}

function strict32ByteBase64(value) {
  if (typeof value !== "string") return false;
  if (value.trim() !== value) return false;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === 32 && decoded.toString("base64") === value;
}

function securityErrorText(error) {
  const parts = [];
  if (typeof error?.stderr === "string" && error.stderr.trim()) {
    parts.push(error.stderr.trim());
  } else if (Buffer.isBuffer(error?.stderr) && error.stderr.length > 0) {
    parts.push(error.stderr.toString("utf8").trim());
  }
  if (typeof error?.stdout === "string" && error.stdout.trim()) {
    parts.push(error.stdout.trim());
  } else if (Buffer.isBuffer(error?.stdout) && error.stdout.length > 0) {
    parts.push(error.stdout.toString("utf8").trim());
  }
  if (error instanceof Error && error.message.trim()) {
    parts.push(error.message.trim());
  } else if (error !== undefined && error !== null) {
    parts.push(String(error).trim());
  }
  return parts.join("\n");
}

function isMacOsKeychainItemNotFound(error) {
  if (error && Number.isInteger(error.status) && error.status === 44) {
    return true;
  }
  const text = securityErrorText(error);
  return (
    text.includes(ITEM_NOT_FOUND_MESSAGE) ||
    /\berrSecItemNotFound\b/.test(text) ||
    /\b-25300\b/.test(text)
  );
}

function keychainFailure(productName, label) {
  return new Error(
    `Unable to access the ${productName} ${label} key in macOS Keychain.`,
  );
}

function findGenericPassword({ service, account, execFileSyncImpl }) {
  try {
    return {
      state: "found",
      value: String(
        execFileSyncImpl(
          SECURITY_PATH,
          ["find-generic-password", "-s", service, "-a", account, "-w"],
          securityExecOptions(),
        ),
      ).trim(),
    };
  } catch (error) {
    if (isMacOsKeychainItemNotFound(error)) return { state: "missing" };
    return { state: "error", error };
  }
}

function ensureMacOsKeychainKey({
  service,
  account,
  label,
  productName,
  platform = process.platform,
  execFileSyncImpl = execFileSync,
  randomBytesImpl = crypto.randomBytes,
}) {
  if (platform !== "darwin") {
    throw new Error(`${label} needs an operator-provided key on this platform.`);
  }

  const existing = findGenericPassword({ service, account, execFileSyncImpl });
  if (existing.state === "found") {
    if (!strict32ByteBase64(existing.value)) {
      throw keychainFailure(productName, label);
    }
    return;
  }
  if (existing.state !== "missing") {
    throw keychainFailure(productName, label);
  }

  const generated = Buffer.from(randomBytesImpl(32)).toString("base64");
  if (!strict32ByteBase64(generated)) {
    throw keychainFailure(productName, label);
  }

  try {
    execFileSyncImpl(
      SECURITY_PATH,
      ["add-generic-password", "-s", service, "-a", account, "-w", generated],
      securityExecOptions(),
    );
  } catch {
    throw keychainFailure(productName, label);
  }

  const verified = findGenericPassword({ service, account, execFileSyncImpl });
  if (
    verified.state !== "found" ||
    !strict32ByteBase64(verified.value) ||
    verified.value !== generated
  ) {
    throw keychainFailure(productName, label);
  }
}

module.exports = {
  SECURITY_PATH,
  ensureMacOsKeychainKey,
  isMacOsKeychainItemNotFound,
  strict32ByteBase64,
};
