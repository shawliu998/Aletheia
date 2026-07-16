import assert from "node:assert/strict";

import type { MatterPolicy } from "../matter/profile/contracts";
import { WorkspaceAssistantLegalResearchToolModule } from "../lib/workspace/services/assistantLegalResearchTools";
import { WorkspaceAssistantToolRegistry } from "../lib/workspace/services/assistantToolRegistry";
import {
  BoundedInMemoryLegalResearchSessionOwnership,
  WorkspaceLegalResearchTools,
} from "../lib/workspace/services/legalResearchTools";
import { WorkspaceLegalResearchProviderRegistry } from "../lib/workspace/services/legalResearchProvider";
import {
  createDeterministicFakeLegalResearchProvider,
} from "../lib/workspace/services/testing/deterministicFakeLegalResearchProvider";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const context = {
  jobId: "22222222-2222-4222-8222-222222222222",
  attempt: 3,
  chatId: "33333333-3333-4333-8333-333333333333",
  projectId: PROJECT_ID,
  modelProfileId: "44444444-4444-4444-8444-444444444444",
  documents: [],
} as const;

function policy(
  externalEgressMode: MatterPolicy["externalEgressMode"],
): MatterPolicy {
  return {
    projectId: PROJECT_ID,
    externalEgressMode,
    executionLocations: ["standard_remote"],
    allowExternalLegalSources: true,
    allowWordBridge: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function main() {
  const provider = createDeterministicFakeLegalResearchProvider({
    testingOnly: true,
  });
  const tools = new WorkspaceLegalResearchTools(
    provider.id,
    WorkspaceLegalResearchProviderRegistry.forTesting([provider]),
    new BoundedInMemoryLegalResearchSessionOwnership(),
    {
      async capture(input) {
        return {
          snapshotId: "55555555-5555-4555-8555-555555555555",
          excerpts: [
            {
              anchorCandidateId: `anchor:${input.sourceRef}`,
              text: input.document.content,
              locator: input.document.locator,
            },
          ],
        };
      },
    },
  );
  let currentPolicy = policy("approval");
  const module = new WorkspaceAssistantLegalResearchToolModule(tools, {
    get: () => currentPolicy,
  });
  assert.deepEqual(await module.registeredTools(context), []);

  currentPolicy = policy("allowed_by_policy");
  const wrongMatterPolicy = { ...currentPolicy, projectId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  currentPolicy = wrongMatterPolicy;
  assert.deepEqual(await module.registeredTools(context), []);
  currentPolicy = policy("allowed_by_policy");
  const registry = new WorkspaceAssistantToolRegistry([module]);
  const registration = await registry.registeredTools(context);
  assert.deepEqual(
    registration.tools.map((tool) => tool.name),
    ["search_legal_sources", "read_legal_source"],
  );
  const search = await registry.execute({
    context,
    call: {
      id: "search-1",
      name: "search_legal_sources",
      input: { query: "deterministic", limit: 1 },
    },
    signal: new AbortController().signal,
  });
  const parsed = JSON.parse(search.content) as {
    results: Array<{ sourceRef: string }>;
  };
  assert.equal(parsed.results.length, 1);

  currentPolicy = policy("disabled");
  await assert.rejects(
    registry.execute({
      context,
      call: {
        id: "read-1",
        name: "read_legal_source",
        input: { sourceRef: parsed.results[0]!.sourceRef },
      },
      signal: new AbortController().signal,
    }),
    /not allowed for this Matter/i,
  );

  console.log(
    "Vera Workspace Assistant Legal Research module audit passed (Matter egress recheck, fixed tools, job-attempt routing).",
  );
}

void main();
