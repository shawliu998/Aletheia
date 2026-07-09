import { createHash } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import https from "node:https";
import net from "node:net";

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_OBSERVATION_CHARS = 12_000;
const REQUEST_TIMEOUT_MS = 12_000;
const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "application/json",
  "application/xml",
  "text/xml",
];

export class ExternalSourceFetchPolicyError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 403 | 422 | 502 = 400,
  ) {
    super(message);
    this.name = "ExternalSourceFetchPolicyError";
  }
}

export type ExternalSourceFetchResult = {
  connector: "allowlisted_https_fetch";
  networkFetchDispatched: true;
  url: string;
  host: string;
  capturedAt: string;
  urlHash: string;
  snapshotHash: string;
  observation: string;
  contentType: string;
  responseBytes: number;
};

type ResolvedAddress = { address: string; family: 4 | 6 };
type ExternalSourceFetcherDeps = {
  allowedDomains?: string[];
  resolvePublicAddress?: (hostname: string) => Promise<ResolvedAddress>;
  fetchPinnedHttps?: (
    url: URL,
    resolved: ResolvedAddress,
  ) => Promise<{ body: Buffer; contentType: string }>;
};

function sha256(value: string | Buffer) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function externalSourceAllowedDomains(raw = process.env.ALETHEIA_EXTERNAL_SOURCE_ALLOWED_DOMAINS) {
  return (raw ?? "")
    .split(",")
    .map((domain) => domain.trim().toLowerCase().replace(/^\./, ""))
    .filter((domain) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain));
}

function isAllowedHost(host: string, allowedDomains: string[]) {
  return allowedDomains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

function isPublicIpv4(address: string) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

function isPublicIpv6(address: string) {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return false;
  }
  if (normalized.startsWith("::ffff:")) {
    return isPublicIpv4(normalized.slice("::ffff:".length));
  }
  return true;
}

export function isPublicIp(address: string) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

export function validateExternalSourceUrl(value: string, allowedDomains: string[]) {
  if (!allowedDomains.length) {
    throw new ExternalSourceFetchPolicyError(
      "Automatic external retrieval is unavailable until ALETHEIA_EXTERNAL_SOURCE_ALLOWED_DOMAINS is configured.",
      403,
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ExternalSourceFetchPolicyError("A valid HTTPS source URL is required.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new ExternalSourceFetchPolicyError(
      "Automatic retrieval accepts only HTTPS URLs without credentials or custom ports.",
    );
  }
  if (!isAllowedHost(url.hostname.toLowerCase(), allowedDomains)) {
    throw new ExternalSourceFetchPolicyError(
      "The source host is not in the configured external-source allowlist.",
      403,
    );
  }
  return url;
}

async function resolvePublicAddress(hostname: string): Promise<ResolvedAddress> {
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  const addresses: ResolvedAddress[] = [];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const address of result.value) {
      const family = net.isIP(address);
      if (family === 4 || family === 6) addresses.push({ address, family });
    }
  }
  const publicAddress = addresses.find((candidate) => isPublicIp(candidate.address));
  if (!publicAddress) {
    throw new ExternalSourceFetchPolicyError(
      "The source host did not resolve to an allowed public address.",
      403,
    );
  }
  return publicAddress;
}

function extractObservation(contentType: string, body: Buffer) {
  const decoded = body.toString("utf8");
  const plain = contentType === "text/html"
    ? decoded
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
    : decoded;
  const observation = plain.replace(/\s+/g, " ").trim().slice(0, MAX_OBSERVATION_CHARS);
  if (!observation) {
    throw new ExternalSourceFetchPolicyError("The source response did not contain usable text.", 422);
  }
  return observation;
}

function fetchPinnedHttps(url: URL, resolved: ResolvedAddress): Promise<{ body: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "text/html,text/plain,application/json,application/xml,text/xml;q=0.9",
          "User-Agent": "Hermes-Aletheia-Source-Check/1.0",
        },
        lookup: (_hostname, _options, callback) => callback(null, resolved.address, resolved.family),
      },
      (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          response.resume();
          reject(new ExternalSourceFetchPolicyError(
            statusCode >= 300 && statusCode < 400
              ? "Redirected sources are not permitted by the external-source connector."
              : `The source returned HTTP ${statusCode}.`,
            502,
          ));
          return;
        }
        const rawContentType = String(response.headers["content-type"] ?? "");
        const contentType = rawContentType.split(";", 1)[0].trim().toLowerCase();
        if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
          response.resume();
          reject(new ExternalSourceFetchPolicyError("The source response content type is not permitted.", 422));
          return;
        }
        const declaredLength = Number(response.headers["content-length"] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
          response.resume();
          reject(new ExternalSourceFetchPolicyError("The source response exceeds the 1 MB capture limit.", 422));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_RESPONSE_BYTES) {
            request.destroy(new ExternalSourceFetchPolicyError("The source response exceeds the 1 MB capture limit.", 422));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ body: Buffer.concat(chunks), contentType }));
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new ExternalSourceFetchPolicyError("The source request timed out.", 502));
    });
    request.on("error", (error) => reject(error));
    request.end();
  });
}

export async function fetchAllowlistedExternalSource(
  input: { url: string; externalAccessOptIn: boolean },
  deps: ExternalSourceFetcherDeps = {},
) {
  if (!input.externalAccessOptIn) {
    throw new ExternalSourceFetchPolicyError("Explicit per-matter external-source authorization is required.", 403);
  }
  const url = validateExternalSourceUrl(
    input.url,
    deps.allowedDomains ?? externalSourceAllowedDomains(),
  );
  const resolved = await (deps.resolvePublicAddress ?? resolvePublicAddress)(url.hostname);
  let fetched: { body: Buffer; contentType: string };
  try {
    fetched = await (deps.fetchPinnedHttps ?? fetchPinnedHttps)(url, resolved);
  } catch (error) {
    if (error instanceof ExternalSourceFetchPolicyError) throw error;
    throw new ExternalSourceFetchPolicyError("The source could not be retrieved safely.", 502);
  }
  if (!ALLOWED_CONTENT_TYPES.includes(fetched.contentType)) {
    throw new ExternalSourceFetchPolicyError("The source response content type is not permitted.", 422);
  }
  const capturedAt = new Date().toISOString();
  return {
    connector: "allowlisted_https_fetch" as const,
    networkFetchDispatched: true as const,
    url: url.toString(),
    host: url.hostname,
    capturedAt,
    urlHash: sha256(url.toString()),
    snapshotHash: sha256(fetched.body),
    observation: extractObservation(fetched.contentType, fetched.body),
    contentType: fetched.contentType,
    responseBytes: fetched.body.length,
  } satisfies ExternalSourceFetchResult;
}
