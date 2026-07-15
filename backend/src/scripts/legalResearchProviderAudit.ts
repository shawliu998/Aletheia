import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LegalSourceAdapterError } from "../lib/aletheia/legalSourceAdapter";
import {
  createOfficialPublicLegalResearchProvider,
  createOfficialPublicLegalResearchProviderFromEnvironment,
  createPkulawLegalResearchProvider,
  createPkulawLegalResearchProviderFromEnvironment,
  createWoltersLegalResearchProvider,
  createWoltersLegalResearchProviderFromEnvironment,
  projectLegalResearchProviderConnectionStatus,
} from "../lib/aletheia/legalResearchProvider";

const endpoint = "https://api.pkulaw.example/v1/legal";
const credentialRef = "PKULAW_OFFICIAL_API";

function config() {
  return {
    endpoint,
    allowedHosts: ["pkulaw.example"],
    credentialRef,
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function adapterError(code: LegalSourceAdapterError["code"]) {
  return (error: unknown) =>
    error instanceof LegalSourceAdapterError && error.code === code;
}

const environmentKeys = [
  "VERA_PKULAW_API_ENDPOINT",
  "VERA_PKULAW_API_ALLOWED_HOSTS",
  "VERA_PKULAW_API_CREDENTIAL_REF",
  "VERA_WOLTERS_API_ENDPOINT",
  "VERA_WOLTERS_API_ALLOWED_HOSTS",
  "VERA_WOLTERS_API_CREDENTIAL_REF",
  "VERA_OFFICIAL_LEGAL_API_ENDPOINT",
  "VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS",
] as const;

type EnvironmentKey = (typeof environmentKeys)[number];
type EnvironmentSnapshot = ReadonlyMap<
  EnvironmentKey,
  Readonly<{ present: boolean; value: string | undefined }>
>;

function snapshotEnvironment(): EnvironmentSnapshot {
  return new Map(
    environmentKeys.map(
      (key) =>
        [
          key,
          {
            present: Object.prototype.hasOwnProperty.call(process.env, key),
            value: process.env[key],
          },
        ] as const,
    ),
  );
}

function restoreEnvironment(saved: EnvironmentSnapshot) {
  for (const key of environmentKeys) {
    const entry = saved.get(key);
    assert.ok(entry);
    if (!entry.present) delete process.env[key];
    else {
      assert.notEqual(entry.value, undefined);
      process.env[key] = entry.value;
    }
  }
}

function assertEnvironmentRestored(saved: EnvironmentSnapshot) {
  for (const key of environmentKeys) {
    const entry = saved.get(key);
    assert.ok(entry);
    assert.equal(
      Object.prototype.hasOwnProperty.call(process.env, key),
      entry.present,
    );
    assert.equal(process.env[key], entry.value);
  }
}

async function main() {
  const requests: Array<Record<string, string>> = [];
  const provider = createPkulawLegalResearchProvider(
    config(),
    {
      now: () => new Date("2026-07-15T08:00:00.000Z"),
      resolveCredential: async (reference) => {
        assert.equal(reference, credentialRef);
        return "audit-only-credential";
      },
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        requests.push(body);
        return body.operation === "search"
          ? jsonResponse({
              results: [
                {
                  id: "civil-code-509",
                  title: "Civil Code Article 509",
                  summary: "Performance must follow the agreement.",
                  url: "https://www.api.pkulaw.example/documents/civil-code-509",
                  effectiveDate: "2021-01-01",
                  documentKind: "statute",
                },
              ],
            })
          : jsonResponse({
              document: {
                id: "civil-code-509",
                title: "Civil Code Article 509",
                content:
                  "Parties shall fully perform their obligations as agreed.",
                url: "https://www.api.pkulaw.example/documents/civil-code-509",
                effectiveDate: "2021-01-01",
                documentKind: "statute",
              },
            });
      },
    },
    {
      dataUsePolicy: {
        basis: "deployment_contract",
        retention: "metadata_only",
        export: "exact_quotes_only",
        modelUse: "local_only",
      },
    },
  );

  assert.equal(provider.contractVersion, "vera-legal-research-provider-v1");
  assert.equal(provider.integration, "authorized_json_gateway");
  assert.deepEqual(provider.capabilities, {
    search: true,
    fetchFullText: true,
    pagination: false,
    getByCitation: false,
    jurisdictionFilter: false,
    asOfDateFilter: false,
    structuredFilters: false,
    dynamicToolInvocation: false,
    requiresExplicitEgressApproval: true,
    documentKinds: ["statute", "judicial_interpretation", "case", "other"],
  });
  assert.deepEqual(provider.dataUsePolicy, {
    basis: "deployment_contract",
    retention: "metadata_only",
    export: "exact_quotes_only",
    modelUse: "local_only",
  });
  assert.deepEqual(await provider.connectionStatus(), {
    state: "configured_unverified",
    reason: null,
    connectionTested: false,
  });

  const serialized = JSON.stringify(provider);
  assert.equal(serialized.includes(endpoint), false);
  assert.equal(serialized.includes(credentialRef), false);
  assert.equal(serialized.includes("audit-only-credential"), false);

  const results = await provider.search({ query: "contract performance" });
  assert.equal(results[0]?.documentId, "civil-code-509");
  assert.equal(results[0]?.snapshot.sourceType, "pkulaw");
  const document = await provider.fetch({ documentId: "civil-code-509" });
  assert.equal(document.documentId, "civil-code-509");
  assert.equal(document.snapshot.sourceType, "pkulaw");
  assert.deepEqual(requests, [
    { operation: "search", query: "contract performance" },
    { operation: "fetch", documentId: "civil-code-509" },
  ]);

  let officialAuthorization: string | null = null;
  const configuredOfficial = createOfficialPublicLegalResearchProvider(
    {
      endpoint: "https://api.official.example/v1/legal",
      allowedHosts: ["official.example"],
    },
    {
      fetch: async (_input, init) => {
        officialAuthorization = new Headers(init?.headers).get("authorization");
        return jsonResponse({ results: [] });
      },
    },
  );
  assert.equal(configuredOfficial.provider, "official");
  assert.deepEqual(await configuredOfficial.connectionStatus(), {
    state: "configured_unverified",
    reason: null,
    connectionTested: false,
  });
  assert.deepEqual(
    await configuredOfficial.search({ query: "civil code" }),
    [],
  );
  assert.equal(officialAuthorization, null);

  const missingCredential = createWoltersLegalResearchProvider(
    {
      ...config(),
      endpoint: "https://api.wolters.example/v1/legal",
      allowedHosts: ["wolters.example"],
    },
    { resolveCredential: async () => undefined },
  );
  assert.deepEqual(await missingCredential.connectionStatus(), {
    state: "unavailable",
    reason: "credential_unavailable",
    connectionTested: false,
  });
  assert.deepEqual(missingCredential.dataUsePolicy, {
    basis: "not_declared",
    retention: "not_declared",
    export: "not_declared",
    modelUse: "not_declared",
  });
  await assert.rejects(
    () => missingCredential.search({ query: "contract" }),
    adapterError("credential_unavailable"),
  );

  const savedPkulawEndpoint = process.env.VERA_PKULAW_API_ENDPOINT;
  const savedPkulawHosts = process.env.VERA_PKULAW_API_ALLOWED_HOSTS;
  const savedPkulawCredentialRef = process.env.VERA_PKULAW_API_CREDENTIAL_REF;
  delete process.env.VERA_PKULAW_API_ENDPOINT;
  delete process.env.VERA_PKULAW_API_ALLOWED_HOSTS;
  process.env.VERA_PKULAW_API_CREDENTIAL_REF = "configured-but-not-readable";
  let credentialReadAttempted = false;
  try {
    const unavailablePkulaw = createPkulawLegalResearchProviderFromEnvironment({
      resolveCredential: async () => {
        credentialReadAttempted = true;
        return "must-not-be-read";
      },
    });
    assert.deepEqual(await unavailablePkulaw.connectionStatus(), {
      state: "unavailable",
      reason: "endpoint_missing",
      connectionTested: false,
    });
    assert.equal(credentialReadAttempted, false);
  } finally {
    if (savedPkulawEndpoint === undefined)
      delete process.env.VERA_PKULAW_API_ENDPOINT;
    else process.env.VERA_PKULAW_API_ENDPOINT = savedPkulawEndpoint;
    if (savedPkulawHosts === undefined)
      delete process.env.VERA_PKULAW_API_ALLOWED_HOSTS;
    else process.env.VERA_PKULAW_API_ALLOWED_HOSTS = savedPkulawHosts;
    if (savedPkulawCredentialRef === undefined)
      delete process.env.VERA_PKULAW_API_CREDENTIAL_REF;
    else process.env.VERA_PKULAW_API_CREDENTIAL_REF = savedPkulawCredentialRef;
  }

  const savedEndpoint = process.env.VERA_OFFICIAL_LEGAL_API_ENDPOINT;
  const savedHosts = process.env.VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS;
  delete process.env.VERA_OFFICIAL_LEGAL_API_ENDPOINT;
  delete process.env.VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS;
  try {
    const official = createOfficialPublicLegalResearchProviderFromEnvironment();
    assert.deepEqual(await official.connectionStatus(), {
      state: "unavailable",
      reason: "endpoint_missing",
      connectionTested: false,
    });
    await assert.rejects(
      () => official.search({ query: "civil code" }),
      adapterError("configuration_error"),
    );
  } finally {
    if (savedEndpoint === undefined)
      delete process.env.VERA_OFFICIAL_LEGAL_API_ENDPOINT;
    else process.env.VERA_OFFICIAL_LEGAL_API_ENDPOINT = savedEndpoint;
    if (savedHosts === undefined)
      delete process.env.VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS;
    else process.env.VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS = savedHosts;
  }

  const savedConfiguredEnvironment = snapshotEnvironment();
  let environmentCredentialReads = 0;
  let environmentFetches = 0;
  try {
    process.env.VERA_PKULAW_API_ENDPOINT =
      "https://api.pkulaw.example/v1/legal";
    process.env.VERA_PKULAW_API_ALLOWED_HOSTS = "pkulaw.example";
    process.env.VERA_PKULAW_API_CREDENTIAL_REF = "PKULAW_GATE_AUDIT";
    process.env.VERA_WOLTERS_API_ENDPOINT =
      "https://api.wolters.example/v1/legal";
    process.env.VERA_WOLTERS_API_ALLOWED_HOSTS = "wolters.example";
    process.env.VERA_WOLTERS_API_CREDENTIAL_REF = "WOLTERS_GATE_AUDIT";
    process.env.VERA_OFFICIAL_LEGAL_API_ENDPOINT =
      "https://api.official.example/v1/legal";
    process.env.VERA_OFFICIAL_LEGAL_API_ALLOWED_HOSTS = "official.example";

    const environmentDependencies = {
      resolveCredential: async () => {
        environmentCredentialReads += 1;
        return "must-not-be-read-while-activation-gate-is-closed";
      },
      fetch: async () => {
        environmentFetches += 1;
        return jsonResponse({ results: [] });
      },
    };
    const environmentProviders = [
      createPkulawLegalResearchProviderFromEnvironment(environmentDependencies),
      createWoltersLegalResearchProviderFromEnvironment(
        environmentDependencies,
      ),
      createOfficialPublicLegalResearchProviderFromEnvironment(
        environmentDependencies,
      ),
    ];
    for (const environmentProvider of environmentProviders) {
      assert.deepEqual(await environmentProvider.connectionStatus(), {
        state: "unavailable",
        reason: "activation_gate_closed",
        connectionTested: false,
      });
      await assert.rejects(
        () => environmentProvider.search({ query: "activation gate audit" }),
        adapterError("configuration_error"),
      );
      await assert.rejects(
        () => environmentProvider.fetch({ documentId: "gate-audit-document" }),
        adapterError("configuration_error"),
      );
    }
    assert.equal(environmentCredentialReads, 0);
    assert.equal(environmentFetches, 0);
  } finally {
    restoreEnvironment(savedConfiguredEnvironment);
  }
  assertEnvironmentRestored(savedConfiguredEnvironment);

  const legalResearchRouteSource = readFileSync(
    resolve(process.cwd(), "src/routes/legalResearch.ts"),
    "utf8",
  );
  const productionAdapterStart = legalResearchRouteSource.indexOf(
    "function productionAdapter",
  );
  const productionAdapterEnd = legalResearchRouteSource.indexOf(
    "\nfunction routeError",
    productionAdapterStart,
  );
  assert.ok(
    productionAdapterStart >= 0 &&
      productionAdapterEnd > productionAdapterStart,
  );
  const productionAdapterSource = legalResearchRouteSource.slice(
    productionAdapterStart,
    productionAdapterEnd,
  );
  for (const gatedConstructor of [
    "createOfficialPublicLegalResearchProviderFromEnvironment",
    "createPkulawLegalResearchProviderFromEnvironment",
    "createWoltersLegalResearchProviderFromEnvironment",
  ]) {
    assert.equal(productionAdapterSource.includes(gatedConstructor), true);
  }
  assert.equal(
    productionAdapterSource.includes("createPkulawLegalResearchProvider("),
    false,
  );
  assert.equal(
    productionAdapterSource.includes("createWoltersLegalResearchProvider("),
    false,
  );
  assert.equal(
    productionAdapterSource.includes(
      "createOfficialPublicLegalResearchProvider(",
    ),
    false,
  );

  assert.deepEqual(
    projectLegalResearchProviderConnectionStatus({
      deployment: {
        endpointConfigured: true,
        allowlisted: true,
        credentialReferenceConfigured: true,
      },
      credentialRequired: true,
      credentialAvailable: true,
      secretStorageAvailable: false,
    }),
    {
      state: "unavailable",
      reason: "secret_storage_unavailable",
      connectionTested: false,
    },
  );

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      suite: "vera-legal-research-provider-audit-v1",
      checks: [
        "legacy-adapter-compatible-provider-contract",
        "credentialless-official-provider-wrapper",
        "capability-and-data-use-policy-projection",
        "configured-unverified-and-unavailable-status",
        "endpoint-credential-redaction",
        "missing-endpoint-does-not-read-credential",
        "official-missing-configuration-boundary",
        "configured-environment-activation-gate-blocks-credential-and-fetch",
        "production-route-uses-only-gated-environment-providers",
        "secret-storage-unavailable-boundary",
      ],
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
