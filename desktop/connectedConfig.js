"use strict";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function normalizeConnectedAppUrl(rawValue, { allowLoopbackHttp = true } = {}) {
  const raw = String(rawValue ?? "").trim();
  if (!raw)
    throw new Error(
      "A Vera workspace address is required.",
    );

  let value;
  try {
    value = new URL(raw);
  } catch {
    throw new Error("The workspace address must be a valid absolute URL.");
  }
  if (value.username || value.password) {
    throw new Error("The workspace address must not contain credentials.");
  }
  const secure = value.protocol === "https:";
  const localDevelopment =
    allowLoopbackHttp &&
    value.protocol === "http:" &&
    LOOPBACK_HOSTS.has(value.hostname);
  if (!secure && !localDevelopment) {
    throw new Error(
      "The workspace address must use HTTPS. HTTP is allowed only on localhost during development.",
    );
  }
  value.hash = "";
  if (value.pathname === "/" || !value.pathname) value.pathname = "/assistant";
  return value;
}

function isSameConnectedOrigin(candidate, applicationUrl) {
  try {
    return new URL(candidate).origin === applicationUrl.origin;
  } catch {
    return false;
  }
}

function isExternalBrowserUrl(candidate) {
  try {
    const value = new URL(candidate);
    return value.protocol === "https:" || value.protocol === "mailto:";
  } catch {
    return false;
  }
}

module.exports = {
  isExternalBrowserUrl,
  isSameConnectedOrigin,
  normalizeConnectedAppUrl,
};
