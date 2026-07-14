import { randomBytes as cryptoRandomBytes } from "node:crypto";

export const DOWNLOAD_CAPABILITY_BASE_PATH = "/api/v1/downloads" as const;
export const DOWNLOAD_CAPABILITY_DEFAULT_TTL_MS = 5 * 60 * 1_000;
export const DOWNLOAD_CAPABILITY_HARD_MAX_TTL_MS = 15 * 60 * 1_000;

const DEFAULT_CAPACITY = 1_024;
const HARD_MAX_CAPACITY = 10_000;
const TOKEN_BYTES = 32;
const TOKEN_PREFIX = "vdl_";
const TOKEN_PATTERN = /^vdl_[A-Za-z0-9_-]{43}$/;
const LOGICAL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TOKEN_GENERATION_ATTEMPTS = 8;

export const DOWNLOAD_CAPABILITY_PURPOSES = ["display", "download", "docx", "zip"] as const;

export type DownloadCapabilityPurpose = (typeof DOWNLOAD_CAPABILITY_PURPOSES)[number];

export type DownloadCapabilityBinding = Readonly<{
  documentId: string;
  versionId: string;
  purpose: DownloadCapabilityPurpose;
}>;

export type IssuedDownloadCapability = Readonly<{
  token: string;
  url: string;
  expiresAt: number;
}>;

export type ResolvedDownloadCapability = DownloadCapabilityBinding &
  Readonly<{
    expiresAt: number;
  }>;

export type DownloadCapabilityStoreOptions = Readonly<{
  clock?: () => number;
  randomBytes?: (size: number) => Uint8Array;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  capacity?: number;
}>;

type StoredCapability = Readonly<{
  binding: DownloadCapabilityBinding;
  expiresAt: number;
}>;

/**
 * Deliberately generic: callers can map this to one safe response without
 * revealing whether capacity, configuration, or token generation caused it.
 */
export class DownloadCapabilityUnavailableError extends Error {
  readonly code = "DOWNLOAD_CAPABILITY_UNAVAILABLE" as const;

  constructor() {
    super("Download capability unavailable.");
    this.name = "DownloadCapabilityUnavailableError";
  }
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function isPurpose(value: unknown): value is DownloadCapabilityPurpose {
  return typeof value === "string" && DOWNLOAD_CAPABILITY_PURPOSES.includes(value as DownloadCapabilityPurpose);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && LOGICAL_IDENTIFIER_PATTERN.test(value);
}

function isBinding(value: unknown): value is DownloadCapabilityBinding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DownloadCapabilityBinding>;
  return isIdentifier(candidate.documentId) && isIdentifier(candidate.versionId) && isPurpose(candidate.purpose);
}

function sameBinding(left: DownloadCapabilityBinding, right: DownloadCapabilityBinding): boolean {
  return (
    left.documentId === right.documentId &&
    left.versionId === right.versionId &&
    left.purpose === right.purpose
  );
}

function safeNow(clock: () => number): number {
  const value = clock();
  if (!Number.isFinite(value)) throw new DownloadCapabilityUnavailableError();
  return Math.trunc(value);
}

export function isDownloadCapabilityToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_PATTERN.test(token);
}

export function downloadCapabilityUrl(token: unknown): string | null {
  return isDownloadCapabilityToken(token) ? `${DOWNLOAD_CAPABILITY_BASE_PATH}/${token}` : null;
}

/**
 * Process-local, short-lived download authority. Only opaque random tokens and
 * logical resource identifiers are retained; filesystem paths and credentials
 * are not part of this API and are never serialized into a token.
 */
export class InMemoryDownloadCapabilityStore {
  readonly #clock: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #defaultTtlMs: number;
  readonly #maxTtlMs: number;
  readonly #capacity: number;
  readonly #capabilities = new Map<string, StoredCapability>();

  constructor(options: DownloadCapabilityStoreOptions = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#randomBytes = options.randomBytes ?? ((size) => cryptoRandomBytes(size));
    this.#maxTtlMs = boundedInteger(
      options.maxTtlMs,
      DOWNLOAD_CAPABILITY_HARD_MAX_TTL_MS,
      1,
      DOWNLOAD_CAPABILITY_HARD_MAX_TTL_MS,
    );
    this.#defaultTtlMs = Math.min(
      this.#maxTtlMs,
      boundedInteger(
        options.defaultTtlMs,
        DOWNLOAD_CAPABILITY_DEFAULT_TTL_MS,
        1,
        DOWNLOAD_CAPABILITY_DEFAULT_TTL_MS,
      ),
    );
    this.#capacity = boundedInteger(options.capacity, DEFAULT_CAPACITY, 1, HARD_MAX_CAPACITY);
  }

  issue(binding: DownloadCapabilityBinding, ttlMs = this.#defaultTtlMs): IssuedDownloadCapability {
    if (!isBinding(binding)) throw new DownloadCapabilityUnavailableError();

    const now = safeNow(this.#clock);
    this.cleanupExpired(now);
    if (this.#capabilities.size >= this.#capacity) throw new DownloadCapabilityUnavailableError();

    const effectiveTtlMs = boundedInteger(ttlMs, this.#defaultTtlMs, 1, this.#maxTtlMs);
    const expiresAt = now + effectiveTtlMs;
    if (!Number.isSafeInteger(expiresAt)) throw new DownloadCapabilityUnavailableError();

    for (let attempt = 0; attempt < MAX_TOKEN_GENERATION_ATTEMPTS; attempt += 1) {
      const entropy = this.#randomBytes(TOKEN_BYTES);
      if (!(entropy instanceof Uint8Array) || entropy.byteLength !== TOKEN_BYTES) {
        throw new DownloadCapabilityUnavailableError();
      }

      const token = `${TOKEN_PREFIX}${Buffer.from(entropy).toString("base64url")}`;
      if (!isDownloadCapabilityToken(token) || this.#capabilities.has(token)) continue;

      this.#capabilities.set(token, {
        binding: Object.freeze({
          documentId: binding.documentId,
          versionId: binding.versionId,
          purpose: binding.purpose,
        }),
        expiresAt,
      });

      return Object.freeze({
        token,
        url: `${DOWNLOAD_CAPABILITY_BASE_PATH}/${token}`,
        expiresAt,
      });
    }

    throw new DownloadCapabilityUnavailableError();
  }

  resolve(token: unknown, expectedBinding?: DownloadCapabilityBinding): ResolvedDownloadCapability | null {
    if (!isDownloadCapabilityToken(token)) return null;

    const stored = this.#capabilities.get(token);
    if (!stored) return null;

    const now = safeNow(this.#clock);
    if (stored.expiresAt <= now) {
      this.#capabilities.delete(token);
      return null;
    }

    if (expectedBinding !== undefined && (!isBinding(expectedBinding) || !sameBinding(stored.binding, expectedBinding))) {
      return null;
    }

    return Object.freeze({
      documentId: stored.binding.documentId,
      versionId: stored.binding.versionId,
      purpose: stored.binding.purpose,
      expiresAt: stored.expiresAt,
    });
  }

  revoke(token: unknown): void {
    if (isDownloadCapabilityToken(token)) this.#capabilities.delete(token);
  }

  cleanupExpired(at = safeNow(this.#clock)): number {
    if (!Number.isFinite(at)) throw new DownloadCapabilityUnavailableError();
    const now = Math.trunc(at);
    let removed = 0;

    for (const [token, capability] of this.#capabilities) {
      if (capability.expiresAt <= now) {
        this.#capabilities.delete(token);
        removed += 1;
      }
    }

    return removed;
  }

  clear(): void {
    this.#capabilities.clear();
  }
}
