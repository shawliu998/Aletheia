import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Request, RequestHandler, Response } from "express";
import {
  WORKSPACE_LOCAL_PRINCIPAL_EMAIL,
  WORKSPACE_LOCAL_PRINCIPAL_ID,
} from "../lib/workspace/principal";

export {
  WORKSPACE_LOCAL_PRINCIPAL_EMAIL,
  WORKSPACE_LOCAL_PRINCIPAL_ID,
} from "../lib/workspace/principal";

export const WORKSPACE_API_ROUTE_PREFIX = "/api/v1";
export const WORKSPACE_AUTH_KIND = "workspace_bootstrap";
const MINIMUM_BOOTSTRAP_TOKEN_LENGTH = 32;

type WorkspaceAuthFailureCode = "UNAUTHORIZED" | "NOT_FOUND" | "INTERNAL_ERROR";

type WorkspaceAuthResponse = {
  detail: string;
  code: WorkspaceAuthFailureCode;
  error: {
    code: WorkspaceAuthFailureCode;
    message: string;
    retryable: false;
  };
};

export interface WorkspaceAuthRequestLike {
  originalUrl?: string;
  headers?: {
    authorization?: string | string[] | undefined;
  };
  rawHeaders?: string[];
  socket?: {
    remoteAddress?: string | undefined;
  };
}

export interface WorkspaceAuthEnvironment {
  ALETHEIA_AUTH_MODE?: string | undefined;
  ALET_HEIA_AUTH_MODE?: string | undefined;
  ALETHEIA_PRIVATE_AUTH_TOKEN?: string | undefined;
  NODE_ENV?: string | undefined;
  VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV?: string | undefined;
}

export type WorkspaceAuthConfiguration =
  | {
      kind: "private_token";
      expectedToken: string;
    }
  | {
      kind: "single_user_dev";
    };

export type WorkspaceAuthFailure = {
  ok: false;
  status: 401 | 404 | 500;
  code: WorkspaceAuthFailureCode;
  message: string;
};

type WorkspaceBearerTokenResult =
  | { ok: true; token: string }
  | WorkspaceAuthFailure;

export type WorkspaceAuthResult =
  | { ok: true; authKind: typeof WORKSPACE_AUTH_KIND }
  | WorkspaceAuthFailure;

function authFailure(
  status: 401 | 404 | 500,
  code: WorkspaceAuthFailureCode,
  message: string,
): WorkspaceAuthFailure {
  return { ok: false, status, code, message };
}

function normalizedAuthMode(
  env: WorkspaceAuthEnvironment,
): "private_token" | "single_user" | "invalid" {
  const value =
    env.ALETHEIA_AUTH_MODE?.trim() ?? env.ALET_HEIA_AUTH_MODE?.trim() ?? "";
  if (value === "" || value === "private_token") return "private_token";
  if (value === "single_user") return "single_user";
  return "invalid";
}

export function workspaceRouteAllowed(
  request: WorkspaceAuthRequestLike,
): boolean {
  if (typeof request.originalUrl !== "string") return false;
  const path = request.originalUrl.split("?", 1)[0] ?? "";
  return (
    path === WORKSPACE_API_ROUTE_PREFIX ||
    path.startsWith(`${WORKSPACE_API_ROUTE_PREFIX}/`)
  );
}

export function workspaceRequestRemoteAddress(
  request: WorkspaceAuthRequestLike,
): string | null {
  const value = request.socket?.remoteAddress ?? null;
  if (typeof value !== "string") return null;
  return value === "" ? null : value;
}

export function isLoopbackRemoteAddress(address: string): boolean {
  if (address === "" || address !== address.trim() || address.includes("%")) {
    return false;
  }

  const family = isIP(address);
  if (family === 4) {
    const firstOctet = address.split(".", 1)[0];
    return firstOctet === "127";
  }
  if (family !== 6) return false;

  // WHATWG URL parsing gives one canonical spelling for every valid IPv6
  // literal. `isIP` above rejects brackets, ports, zone IDs and malformed
  // input before the value reaches this canonicalization step.
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (canonical === "[::1]") return true;

  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(canonical);
  if (mapped === null) return false;
  const highWord = Number.parseInt(mapped[1], 16);
  return highWord >= 0x7f00 && highWord <= 0x7fff;
}

export function constantTimeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  const targetLength = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const normalizedLeft = Buffer.alloc(targetLength);
  const normalizedRight = Buffer.alloc(targetLength);
  leftBuffer.copy(normalizedLeft);
  rightBuffer.copy(normalizedRight);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(normalizedLeft, normalizedRight)
  );
}

function authorizationHeaderValues(
  request: WorkspaceAuthRequestLike,
): string[] {
  const rawHeaders = Array.isArray(request.rawHeaders)
    ? request.rawHeaders
    : [];
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length - 1; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "authorization") {
      values.push(String(rawHeaders[index + 1] ?? ""));
    }
  }
  if (values.length > 0) return values;
  const header = request.headers?.authorization;
  if (Array.isArray(header)) return header.map((value) => String(value));
  return typeof header === "string" ? [header] : [];
}

export function parseWorkspaceBearerToken(
  request: WorkspaceAuthRequestLike,
): WorkspaceBearerTokenResult {
  const values = authorizationHeaderValues(request);
  if (values.length === 0) {
    return authFailure(
      401,
      "UNAUTHORIZED",
      "Workspace API authentication failed.",
    );
  }
  if (values.length !== 1) {
    return authFailure(
      401,
      "UNAUTHORIZED",
      "Workspace API authentication failed.",
    );
  }
  const header = values[0];
  if (
    header.trim() !== header ||
    header.includes("\n") ||
    header.includes("\r") ||
    !header.startsWith("Bearer ")
  ) {
    return authFailure(
      401,
      "UNAUTHORIZED",
      "Workspace API authentication failed.",
    );
  }
  const token = header.slice("Bearer ".length);
  if (
    token === "" ||
    token.trim() !== token ||
    /\s/.test(token) ||
    token.includes(",")
  ) {
    return authFailure(
      401,
      "UNAUTHORIZED",
      "Workspace API authentication failed.",
    );
  }
  return { ok: true, token };
}

export function resolveWorkspaceAuthConfiguration(
  env: WorkspaceAuthEnvironment = process.env,
): WorkspaceAuthConfiguration | WorkspaceAuthFailure {
  const mode = normalizedAuthMode(env);
  if (mode === "invalid") {
    return authFailure(
      500,
      "INTERNAL_ERROR",
      "Workspace API authentication is not configured.",
    );
  }
  if (mode === "single_user") {
    if (env.NODE_ENV?.trim().toLowerCase() === "production") {
      return authFailure(
        500,
        "INTERNAL_ERROR",
        "Workspace API authentication is not configured.",
      );
    }
    if (env.VERA_WORKSPACE_ALLOW_SINGLE_USER_DEV !== "true") {
      return authFailure(
        500,
        "INTERNAL_ERROR",
        "Workspace API authentication is not configured.",
      );
    }
    return { kind: "single_user_dev" };
  }
  const expectedToken = env.ALETHEIA_PRIVATE_AUTH_TOKEN?.trim() ?? "";
  if (expectedToken.length < MINIMUM_BOOTSTRAP_TOKEN_LENGTH) {
    return authFailure(
      500,
      "INTERNAL_ERROR",
      "Workspace API authentication is not configured.",
    );
  }
  return { kind: "private_token", expectedToken };
}

export function authenticateWorkspaceRequest(
  request: WorkspaceAuthRequestLike,
  config: WorkspaceAuthConfiguration,
): WorkspaceAuthResult {
  if (!workspaceRouteAllowed(request)) {
    return authFailure(404, "NOT_FOUND", "Workspace API route not found.");
  }
  const remoteAddress = workspaceRequestRemoteAddress(request);
  if (remoteAddress === null || !isLoopbackRemoteAddress(remoteAddress)) {
    return authFailure(
      401,
      "UNAUTHORIZED",
      "Workspace API authentication failed.",
    );
  }
  if (config.kind === "single_user_dev") {
    return { ok: true, authKind: WORKSPACE_AUTH_KIND };
  }
  const token = parseWorkspaceBearerToken(request);
  if (token.ok === false) return token;
  if (!constantTimeTokenEqual(token.token, config.expectedToken)) {
    return authFailure(
      401,
      "UNAUTHORIZED",
      "Workspace API authentication failed.",
    );
  }
  return { ok: true, authKind: WORKSPACE_AUTH_KIND };
}

function writeWorkspaceAuthFailure(
  res: Response,
  failure: WorkspaceAuthFailure,
): void {
  const body: WorkspaceAuthResponse = {
    detail: failure.message,
    code: failure.code,
    error: {
      code: failure.code,
      message: failure.message,
      retryable: false,
    },
  };
  res.status(failure.status).json(body);
}

function setWorkspaceLocalPrincipal(res: Response): void {
  res.locals.userId = WORKSPACE_LOCAL_PRINCIPAL_ID;
  res.locals.userEmail = WORKSPACE_LOCAL_PRINCIPAL_EMAIL;
  res.locals.authKind = WORKSPACE_AUTH_KIND;
  res.locals.workspacePrincipal = {
    id: WORKSPACE_LOCAL_PRINCIPAL_ID,
    email: WORKSPACE_LOCAL_PRINCIPAL_EMAIL,
    kind: "local_single_user",
  };
}

export function createWorkspaceAuthMiddleware(
  env: WorkspaceAuthEnvironment = process.env,
): RequestHandler {
  return function workspaceAuth(req, res, next): void {
    const configuration = resolveWorkspaceAuthConfiguration(env);
    if (!("kind" in configuration)) {
      writeWorkspaceAuthFailure(res, configuration);
      return;
    }
    const authentication = authenticateWorkspaceRequest(req, configuration);
    if (authentication.ok === false) {
      writeWorkspaceAuthFailure(res, authentication);
      return;
    }
    setWorkspaceLocalPrincipal(res);
    next();
  };
}

export const requireWorkspaceAuth = createWorkspaceAuthMiddleware();
