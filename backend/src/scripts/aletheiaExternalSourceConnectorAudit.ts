import assert from "node:assert/strict";
import {
  ExternalSourceFetchPolicyError,
  externalSourceAllowedDomains,
  fetchAllowlistedExternalSource,
  isPublicIp,
  validateExternalSourceUrl,
} from "../lib/aletheia/externalSourceFetch";

async function main() {
  assert.deepEqual(
    externalSourceAllowedDomains("registry.example.gov, .court.example.gov, invalid host"),
    ["registry.example.gov", "court.example.gov"],
  );
  assert.equal(isPublicIp("8.8.8.8"), true);
  assert.equal(isPublicIp("10.0.0.8"), false);
  assert.equal(isPublicIp("127.0.0.1"), false);
  assert.equal(isPublicIp("::1"), false);
  assert.equal(isPublicIp("fc00::1"), false);
  assert.equal(isPublicIp("2606:4700:4700::1111"), true);

  const allowedDomains = ["registry.example.gov"];
  assert.equal(
    validateExternalSourceUrl("https://records.registry.example.gov/entity/42", allowedDomains).hostname,
    "records.registry.example.gov",
  );
  for (const url of [
    "http://registry.example.gov/entity/42",
    "https://registry.example.gov:8443/entity/42",
    "https://registry.example.gov@untrusted.example/entity/42",
    "https://untrusted.example/entity/42",
  ]) {
    assert.throws(
      () => validateExternalSourceUrl(url, allowedDomains),
      ExternalSourceFetchPolicyError,
    );
  }

  const result = await fetchAllowlistedExternalSource(
    { url: "https://registry.example.gov/entity/42", externalAccessOptIn: true },
    {
      allowedDomains,
      resolvePublicAddress: async () => ({ address: "203.0.113.25", family: 4 }),
      fetchPinnedHttps: async () => ({
        contentType: "text/html",
        body: Buffer.from("<html><script>ignore()</script><body>Registry <b>entity 42</b></body></html>"),
      }),
    },
  );
  assert.equal(result.connector, "allowlisted_https_fetch");
  assert.equal(result.networkFetchDispatched, true);
  assert.equal(result.host, "registry.example.gov");
  assert.equal(result.observation, "Registry entity 42");
  assert.match(result.urlHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.snapshotHash, /^sha256:[a-f0-9]{64}$/);

  await assert.rejects(
    () =>
      fetchAllowlistedExternalSource(
        { url: "https://registry.example.gov/entity/42", externalAccessOptIn: false },
        { allowedDomains },
      ),
    ExternalSourceFetchPolicyError,
  );
  await assert.rejects(
    () =>
      fetchAllowlistedExternalSource(
        { url: "https://registry.example.gov/entity/42", externalAccessOptIn: true },
        {
          allowedDomains,
          resolvePublicAddress: async () => ({ address: "203.0.113.25", family: 4 }),
          fetchPinnedHttps: async () => ({
            contentType: "application/pdf",
            body: Buffer.from("not allowed"),
          }),
        },
      ),
    ExternalSourceFetchPolicyError,
  );

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      suite: "aletheia-external-source-connector-audit-v1",
      checks: [
        "allowlist",
        "https-only",
        "public-address-policy",
        "pinned-fetch-capture",
        "explicit-opt-in",
        "content-type-restriction",
      ],
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
