import assert from "node:assert/strict";
import path from "node:path";

import type { MatterPolicy } from "../matter/profile/contracts";
import { WorkspaceYuanDianLegalResearchProvider } from "../lib/workspace/providers/yuandianLegalResearchProvider";
import { WorkspaceAssistantLegalResearchToolModule } from "../lib/workspace/services/assistantLegalResearchTools";
import { WorkspaceAssistantToolRegistry } from "../lib/workspace/services/assistantToolRegistry";
import {
  BoundedInMemoryLegalResearchSessionOwnership,
  WorkspaceLegalResearchTools,
} from "../lib/workspace/services/legalResearchTools";
import { WorkspaceLegalResearchProviderRegistry } from "../lib/workspace/services/legalResearchProvider";
import {
  LegalProviderProfileIdV18Schema,
  LegalProviderCredentialReferenceV18Schema,
} from "../lib/workspace/legalProviderPersistenceContractsV18";

type KeychainModule = {
  workspaceLegalProviderCredentialLocator(input: {
    reference: string;
    binding: {
      profileId: string;
      provider: "yuandian";
      endpointSetId: "yuandian-official-mcp-v1";
    };
  }): { service: string; account: string };
  readGenericPassword(input: {
    service: string;
    account: string;
  }): string | null;
};

const keychain = require(
  path.resolve(__dirname, "../../../desktop/macOsKeychain.js"),
) as KeychainModule;

const profileId = LegalProviderProfileIdV18Schema.parse(
  process.env.VERA_YUANDIAN_PROFILE_ID,
);
const credentialRef = LegalProviderCredentialReferenceV18Schema.parse(
  process.env.VERA_YUANDIAN_CREDENTIAL_REF,
);
assert.ok(credentialRef.includes(`/${profileId}/`));
let acceptanceStage = "bootstrap";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const context = {
  jobId: "22222222-2222-4222-8222-222222222222",
  attempt: 1,
  leaseOwner: "yuandian-live-agent-acceptance",
  chatId: "33333333-3333-4333-8333-333333333333",
  projectId: PROJECT_ID,
  modelProfileId: "44444444-4444-4444-8444-444444444444",
  documents: [],
} as const;

const matterPolicy: MatterPolicy = {
  projectId: PROJECT_ID,
  externalEgressMode: "allowed_by_policy",
  executionLocations: ["standard_remote"],
  allowExternalLegalSources: true,
  allowWordBridge: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

async function resolveCredential(reference: string) {
  assert.equal(reference, credentialRef);
  const locator = keychain.workspaceLegalProviderCredentialLocator({
    reference,
    binding: {
      profileId,
      provider: "yuandian",
      endpointSetId: "yuandian-official-mcp-v1",
    },
  });
  return keychain.readGenericPassword(locator);
}

async function main() {
  acceptanceStage = "provider_setup";
  const provider = new WorkspaceYuanDianLegalResearchProvider(
    {
      credentialRef,
      technicalPoc: {
        enabled: true,
        environment: "development",
        userAuthorized: true,
      },
      maxResults: 3,
    },
    { resolveCredential },
  );
  const providerRegistry = WorkspaceLegalResearchProviderRegistry.production([
    provider,
  ]);
  acceptanceStage = "connection_probe";
  await provider.verifyTechnicalPocConnection(new AbortController().signal);
  const tools = new WorkspaceLegalResearchTools(
    provider.id,
    providerRegistry,
    new BoundedInMemoryLegalResearchSessionOwnership(),
    null,
  );
  const registry = new WorkspaceAssistantToolRegistry([
    new WorkspaceAssistantLegalResearchToolModule(tools, {
      get: () => matterPolicy,
    }),
  ]);
  const registration = await registry.registeredTools(context);
  assert.deepEqual(
    registration.tools.map((tool) => tool.name),
    ["search_legal_sources", "read_legal_source"],
  );
  const signal = new AbortController().signal;
  acceptanceStage = "search";
  const searched = await registry.execute({
    context,
    call: {
      id: "live-search",
      name: "search_legal_sources",
      input: {
        query: process.env.VERA_YUANDIAN_TEST_QUERY ?? "民法典合同解除",
        sourceTypes: [
          "statute",
          "regulation",
          "judicial_interpretation",
          "guidance",
        ],
        limit: 3,
      },
    },
    signal,
  });
  const searchResult = JSON.parse(searched.content) as {
    durable: boolean;
    results: Array<{ sourceRef: string; sourceType: string }>;
  };
  assert.equal(searchResult.durable, false);
  assert.ok(searchResult.results.length > 0);

  acceptanceStage = "read";
  const read = await registry.execute({
    context,
    call: {
      id: "live-read",
      name: "read_legal_source",
      input: { sourceRef: searchResult.results[0]!.sourceRef },
    },
    signal,
  });
  const readResult = JSON.parse(read.content) as {
    durable: boolean;
    snapshotId: string | null;
    excerpts: Array<{ text: string }>;
  };
  assert.equal(readResult.durable, false);
  assert.equal(readResult.snapshotId, null);
  assert.ok(readResult.excerpts[0]?.text.length);
  const status = await provider.status({
    projectId: PROJECT_ID,
    researchSessionId: `${context.jobId}:${context.attempt}`,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      suite: "vera-workspace-yuandian-live-agent-acceptance-v1",
      providerState: status.state,
      productionReady: false,
      toolNames: registration.tools.map((tool) => tool.name),
      resultCount: searchResult.results.length,
      firstSourceType: searchResult.results[0]!.sourceType,
      readCompleted: true,
      durable: false,
      snapshotId: null,
    })}\n`,
  );
}

void main().catch((error: unknown) => {
  const failure =
    error instanceof Error
      ? {
          name: error.name.slice(0, 120),
          code:
            "code" in error && typeof error.code === "string"
              ? error.code.slice(0, 120)
              : "unknown",
          stage: acceptanceStage,
          message: error.message.slice(0, 240),
        }
      : {
          name: "UnknownError",
          code: "unknown",
          stage: acceptanceStage,
          message: "Unknown failure",
        };
  process.stderr.write(
    `YuanDian live Agent acceptance failed safely: ${JSON.stringify(failure)}\n`,
  );
  process.exitCode = 1;
});
