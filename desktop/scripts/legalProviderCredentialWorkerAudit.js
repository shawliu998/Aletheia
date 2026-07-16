"use strict";

const assert = require("node:assert/strict");

const {
  WORKSPACE_LEGAL_PROVIDER_CREDENTIAL_SERVICE,
  workspaceLegalProviderCredentialAccount,
  workspaceLegalProviderCredentialLocator,
} = require("../macOsKeychain");
const { createCredentialWorkerHandler } = require("../credentialWorker");

const PROFILE_ID = "2d54f222-acde-4d42-8a87-23ecf2d31df1";
const LOCATOR_ID = "0123456789abcdef";
const REFERENCE =
  `keychain://vera/legal-provider/${PROFILE_ID}/${LOCATOR_ID}`;
const BINDING = Object.freeze({
  profileId: PROFILE_ID,
  provider: "yuandian",
  endpointSetId: "yuandian-official-mcp-v1",
});

function request(operation, payload) {
  return {
    schema: "vera-credential-rpc-v1",
    id: `legal_${operation}_0123456789abcdef`,
    operation,
    payload,
  };
}

function main() {
  const locator = workspaceLegalProviderCredentialLocator({
    reference: REFERENCE,
    binding: BINDING,
  });
  assert.equal(locator.service, WORKSPACE_LEGAL_PROVIDER_CREDENTIAL_SERVICE);
  assert.equal(
    locator.account,
    workspaceLegalProviderCredentialAccount({
      ...BINDING,
      locatorId: LOCATOR_ID,
    }),
  );
  assert.throws(() =>
    workspaceLegalProviderCredentialLocator({
      reference: REFERENCE,
      binding: { ...BINDING, profileId: "c45d71a0-c5df-44ce-a2d8-43d487ce0eef" },
    }),
  );
  assert.throws(() =>
    workspaceLegalProviderCredentialLocator({
      reference: REFERENCE,
      binding: { ...BINDING, endpointSetId: "caller-selected-url" },
    }),
  );
  assert.throws(() =>
    workspaceLegalProviderCredentialLocator({
      reference: REFERENCE.toUpperCase(),
      binding: BINDING,
    }),
  );
  assert.doesNotThrow(() =>
    workspaceLegalProviderCredentialAccount({
      ...BINDING,
      profileId: "2d54f222-acde-7d42-8a87-23ecf2d31df1",
      locatorId: LOCATOR_ID,
    }),
  );

  const stored = new Map();
  const handler = createCredentialWorkerHandler({
    platform: "darwin",
    writeGenericPassword({ service, account, secret }) {
      const key = `${service}\0${account}`;
      if (stored.has(key)) {
        const error = new Error("collision");
        error.name = "MacOsKeychainItemCollisionError";
        throw error;
      }
      stored.set(key, secret);
    },
    readGenericPassword({ service, account }) {
      return stored.get(`${service}\0${account}`) ?? null;
    },
    deleteWorkspaceLegalProviderCredential(input) {
      const target = workspaceLegalProviderCredentialLocator(input);
      return stored.delete(`${target.service}\0${target.account}`);
    },
  });

  const secret = "fixture-only-legal-provider-secret";
  const saved = handler(
    request("legal_store", {
      reference: REFERENCE,
      binding: BINDING,
      secret,
    }),
  );
  assert.deepEqual(saved.result, { stored: true });
  const resolved = handler(
    request("legal_resolve", { reference: REFERENCE, binding: BINDING }),
  );
  assert.deepEqual(resolved.result, { secret });
  const deleted = handler(
    request("legal_delete", { reference: REFERENCE, binding: BINDING }),
  );
  assert.deepEqual(deleted.result, { deleted: true });
  assert.equal(
    handler(
      request("legal_resolve", { reference: REFERENCE, binding: BINDING }),
    ).error.code,
    "CREDENTIAL_NOT_FOUND",
  );

  const invalid = handler(
    request("legal_store", {
      reference: REFERENCE,
      binding: { ...BINDING, provider: "openai" },
      secret,
    }),
  );
  assert.equal(invalid.error.code, "INVALID_REQUEST");
  assert.equal(JSON.stringify(invalid).includes(secret), false);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      suite: "vera-legal-provider-credential-worker-v1",
      checks: [
        "dedicated-keychain-service-and-origin-set-bound-account",
        "strict-legal-provider-reference-and-binding",
        "create-resolve-delete-without-renderer-readback",
        "model-provider-binding-cannot-cross-legal-boundary",
        "secret-free-protocol-failures",
      ],
    })}\n`,
  );
}

main();
