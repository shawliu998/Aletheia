import assert from "node:assert/strict";

import {
  DOWNLOAD_CAPABILITY_DEFAULT_TTL_MS,
  DOWNLOAD_CAPABILITY_HARD_MAX_TTL_MS,
  DownloadCapabilityUnavailableError,
  InMemoryDownloadCapabilityStore,
  downloadCapabilityUrl,
  isDownloadCapabilityToken,
  type DownloadCapabilityBinding,
} from "../lib/workspace/downloadCapabilities";

const INITIAL_TIME = 1_800_000_000_000;

function deterministicRandomSource(): (size: number) => Uint8Array {
  let sequence = 0;
  return (size) => {
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(Math.max(0, size - 4), sequence, false);
    sequence += 1;
    return bytes;
  };
}

function encoded(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function main(): void {
  let now = INITIAL_TIME;
  const clock = () => now;
  const binding: DownloadCapabilityBinding = {
    documentId: "00000000-0000-4000-8000-000000000101",
    versionId: "00000000-0000-4000-8000-000000000102",
    purpose: "display",
  };

  const store = new InMemoryDownloadCapabilityStore({
    clock,
    randomBytes: deterministicRandomSource(),
    capacity: 128,
  });

  const first = store.issue(binding);
  const second = store.issue(binding);
  assert.notEqual(first.token, second.token, "every capability must receive a unique token");
  assert.equal(isDownloadCapabilityToken(first.token), true);
  assert.equal(first.url, `/api/v1/downloads/${first.token}`);
  assert.equal(downloadCapabilityUrl(first.token), first.url);
  assert.equal(first.expiresAt - now, DOWNLOAD_CAPABILITY_DEFAULT_TTL_MS);
  for (const unsafeBinding of [
    { ...binding, documentId: "/Users/private/client-document.pdf" },
    { ...binding, versionId: "credential=do-not-store" },
    { ...binding, documentId: "../escape" },
  ]) {
    assert.throws(
      () => store.issue(unsafeBinding),
      DownloadCapabilityUnavailableError,
      "capability bindings reject path- or credential-shaped identifiers",
    );
  }

  for (const output of [first.token, first.url]) {
    for (const sensitiveInput of [binding.documentId, binding.versionId]) {
      assert.equal(output.includes(sensitiveInput), false, "token URLs must not contain input identifiers or paths");
      assert.equal(output.includes(encoded(sensitiveInput)), false, "token URLs must not encode input identifiers");
    }
    assert.equal(output.includes("secret"), false);
    assert.equal(output.includes("credential"), false);
    assert.equal(output.includes("Users"), false);
  }

  assert.deepEqual(store.resolve(first.token), {
    ...binding,
    expiresAt: first.expiresAt,
  });
  assert.deepEqual(store.resolve(first.token, binding), {
    ...binding,
    expiresAt: first.expiresAt,
  });
  assert.equal(store.resolve(first.token, { ...binding, documentId: "another-document" }), null);
  assert.equal(store.resolve(first.token, { ...binding, versionId: "another-version" }), null);
  assert.equal(store.resolve(first.token, { ...binding, purpose: "download" }), null);

  const tampered = `${first.token.slice(0, -1)}${first.token.endsWith("A") ? "B" : "A"}`;
  for (const invalid of [tampered, "", "../token", "vdl_short", `${first.token}/suffix`, null, undefined]) {
    assert.equal(store.resolve(invalid), null, "invalid, unknown, and tampered tokens share the same result");
    assert.doesNotThrow(() => store.revoke(invalid));
  }
  assert.equal(downloadCapabilityUrl("../token"), null);

  const short = store.issue({ documentId: "doc-expiry", versionId: "version-expiry", purpose: "download" }, 25);
  now += 24;
  assert.notEqual(store.resolve(short.token), null);
  now += 1;
  assert.equal(store.resolve(short.token), null, "expiry is enforced at the exact boundary");

  const cleanupA = store.issue({ documentId: "cleanup-a", versionId: "v1", purpose: "docx" }, 10);
  const cleanupB = store.issue({ documentId: "cleanup-b", versionId: "v1", purpose: "zip" }, 20);
  now += 10;
  assert.equal(store.cleanupExpired(), 1);
  assert.equal(store.resolve(cleanupA.token), null);
  assert.notEqual(store.resolve(cleanupB.token), null);
  now += 10;
  assert.equal(store.cleanupExpired(), 1);
  assert.equal(store.resolve(cleanupB.token), null);

  const hardCapped = store.issue(
    { documentId: "hard-cap", versionId: "v1", purpose: "download" },
    DOWNLOAD_CAPABILITY_HARD_MAX_TTL_MS * 10,
  );
  assert.equal(hardCapped.expiresAt - now, DOWNLOAD_CAPABILITY_HARD_MAX_TTL_MS);

  const overconfigured = new InMemoryDownloadCapabilityStore({
    clock,
    randomBytes: deterministicRandomSource(),
    defaultTtlMs: DOWNLOAD_CAPABILITY_HARD_MAX_TTL_MS,
    maxTtlMs: DOWNLOAD_CAPABILITY_HARD_MAX_TTL_MS * 10,
  });
  const clampedDefault = overconfigured.issue({ documentId: "default-cap", versionId: "v1", purpose: "display" });
  assert.equal(clampedDefault.expiresAt - now, DOWNLOAD_CAPABILITY_DEFAULT_TTL_MS);

  const bounded = new InMemoryDownloadCapabilityStore({
    clock,
    randomBytes: deterministicRandomSource(),
    capacity: 2,
  });
  const boundedA = bounded.issue({ documentId: "a", versionId: "v1", purpose: "display" });
  bounded.issue({ documentId: "b", versionId: "v1", purpose: "display" });
  assert.throws(
    () => bounded.issue({ documentId: "sensitive-third-id", versionId: "v1", purpose: "display" }),
    (error: unknown) => {
      assert.equal(error instanceof DownloadCapabilityUnavailableError, true);
      assert.equal((error as Error).message, "Download capability unavailable.");
      assert.equal((error as Error).message.includes("sensitive-third-id"), false);
      return true;
    },
  );
  bounded.revoke(boundedA.token);
  assert.equal(bounded.resolve(boundedA.token), null);
  assert.doesNotThrow(() => bounded.issue({ documentId: "c", versionId: "v1", purpose: "display" }));

  const survivesOnlyInOriginalProcess = store.issue({
    documentId: "restart-doc",
    versionId: "restart-version",
    purpose: "zip",
  });
  const restarted = new InMemoryDownloadCapabilityStore({ clock });
  assert.equal(restarted.resolve(survivesOnlyInOriginalProcess.token), null, "new instances must not inherit authority");

  const revokeTarget = store.issue({ documentId: "revoke-doc", versionId: "v1", purpose: "docx" });
  store.revoke(revokeTarget.token);
  assert.equal(store.resolve(revokeTarget.token), null);

  const clearA = store.issue({ documentId: "clear-a", versionId: "v1", purpose: "display" });
  const clearB = store.issue({ documentId: "clear-b", versionId: "v1", purpose: "download" });
  store.clear();
  assert.equal(store.resolve(clearA.token), null);
  assert.equal(store.resolve(clearB.token), null);

  const tokens = new Set<string>();
  const uniquenessStore = new InMemoryDownloadCapabilityStore({ capacity: 64 });
  for (let index = 0; index < 64; index += 1) {
    const issued = uniquenessStore.issue({ documentId: `doc-${index}`, versionId: "v1", purpose: "download" });
    assert.equal(tokens.has(issued.token), false);
    tokens.add(issued.token);
  }

  console.log(
    JSON.stringify(
      {
        audit: "vera-workspace-download-capabilities",
        status: "pass",
        endpoint: "/api/v1/downloads/<opaque-token>",
        tokenCountChecked: tokens.size,
        defaultTtlMs: DOWNLOAD_CAPABILITY_DEFAULT_TTL_MS,
        hardMaxTtlMs: DOWNLOAD_CAPABILITY_HARD_MAX_TTL_MS,
      },
      null,
      2,
    ),
  );
}

main();
