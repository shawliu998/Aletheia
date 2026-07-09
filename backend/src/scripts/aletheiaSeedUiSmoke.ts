import "dotenv/config";
import { createAletheiaRepository } from "../lib/aletheia";
import type { AletheiaUserContext } from "../lib/aletheia/repository";

async function main() {
  process.env.ALETHEIA_STORAGE_DRIVER =
    process.env.ALETHEIA_STORAGE_DRIVER ?? "local";
  process.env.ALETHEIA_AUTH_MODE =
    process.env.ALETHEIA_AUTH_MODE ?? "single_user";
  process.env.ALETHEIA_DATA_DIR =
    process.env.ALETHEIA_DATA_DIR ?? ".data/aletheia";
  process.env.ALETHEIA_LOCAL_USER_ID =
    process.env.ALETHEIA_LOCAL_USER_ID ?? "local-user";
  process.env.ALETHEIA_LOCAL_USER_EMAIL =
    process.env.ALETHEIA_LOCAL_USER_EMAIL ?? "local@aletheia.internal";

  const frontendUrl =
    process.env.ALETHEIA_UI_SMOKE_FRONTEND_URL ?? "http://localhost:3000";
  const ctx: AletheiaUserContext = {
    userId: process.env.ALETHEIA_LOCAL_USER_ID,
    userEmail: process.env.ALETHEIA_LOCAL_USER_EMAIL,
  };
  const repo = createAletheiaRepository();
  const timestamp =
    process.env.ALETHEIA_UI_SMOKE_TIMESTAMP ?? new Date().toISOString();

  const matter: any = await repo.createMatter(ctx, {
    title: `Aletheia UI Smoke Matter ${timestamp.slice(0, 10)}`,
    objective:
      "Demonstrate a local-first professional workspace with source evidence, run trace, human approval, Matter Memory, and an approved Matter Playbook.",
    template: "legal_matter_review",
    status: "in_progress",
    riskLevel: "high",
    clientOrProject: "Synthetic local demo",
    sourceProjectId: null,
    sharedWith: [],
    metadata: { seededBy: "aletheiaSeedUiSmoke", timestamp },
  });

  const sourceText = [
    "Synthetic source record for Aletheia UI smoke.",
    "The agreement includes a termination clause requiring 30 days notice.",
    "The indemnity covenant survives closing.",
    "Board approval is required before transfer.",
    "The renewal clause remains ambiguous and requires human review.",
  ].join("\n");
  const document: any = await repo.uploadMatterDocument(ctx, matter.id, {
    filename: "aletheia-ui-smoke-source.txt",
    mimeType: "text/plain",
    sizeBytes: Buffer.byteLength(sourceText, "utf8"),
    buffer: Buffer.from(sourceText, "utf8"),
  });

  const searchResults: any[] | null = await repo.searchMatterDocuments(
    ctx,
    matter.id,
    { query: "termination notice", limit: 3 },
  );
  if (!searchResults?.length) {
    throw new Error("Seed document did not produce searchable chunks");
  }

  const evidence: any = await repo.createEvidenceItem(ctx, matter.id, {
    sourceChunkId: searchResults[0].chunk_id,
    relevance: "direct",
    supportStatus: "supports",
    confidence: "high",
    metadata: { seededBy: "aletheiaSeedUiSmoke" },
  });

  const issueMap = await repo.generateIssueMap(ctx, matter.id);
  const matrix = await repo.generateEvidenceMatrix(ctx, matter.id);
  const draftMemo = await repo.generateDraftMemo(ctx, matter.id);
  const memory = await repo.addMatterMemory(ctx, matter.id, {
    category: "confirmed_fact",
    title: "Termination notice period confirmed",
    body: "The source record states that termination requires 30 days notice.",
    source: "human",
    metadata: { evidenceId: evidence.id },
  });
  const playbook: any = await repo.createPlaybook(ctx, matter.id, {
    name: "Legal Matter Review Playbook",
    description: "Synthetic UI smoke workflow manual.",
    version: "v0.1",
    content: {
      format: "markdown",
      body: "1. Parse local sources\n2. Map evidence\n3. Draft memo\n4. Require human approval before reliance",
      controls: {
        matterScoped: true,
        agentMayAutoModify: false,
        requiresHumanApprovalForUpdates: true,
      },
    },
  });
  await repo.approvePlaybook(ctx, matter.id, playbook.id);
  const run: any = await repo.createAgentRun(ctx, matter.id, {
    workflow: "legal_matter_review",
    goal: "UI smoke run trace",
    status: "queued",
    metadata: { seededBy: "aletheiaSeedUiSmoke" },
  });

  const checkpoint: any = await repo.requestApproval(ctx, matter.id, {
    action: "audit_pack_export",
    prompt: "Approve seeded UI smoke audit pack export.",
    requestedPayload: { seededBy: "aletheiaSeedUiSmoke" },
  });
  await repo.decideApproval(ctx, matter.id, checkpoint.id, {
    decision: "approved",
    comment: "Approved for local UI smoke demo.",
  });
  const auditPack: any = await repo.createWorkProduct(ctx, matter.id, {
    kind: "audit_pack",
    title: "Aletheia UI Smoke Audit Pack",
    status: "generated",
    schemaVersion: "aletheia-audit-pack-v0",
    content: {
      matterId: matter.id,
      documentId: document.id,
      evidenceId: evidence.id,
      issueMapId: (issueMap as any).id,
      matrixId: (matrix as any).id,
      draftMemoId: (draftMemo as any).id,
      memoryId: (memory as any).id,
      playbookId: playbook.id,
      runId: run.id,
      seededBy: "aletheiaSeedUiSmoke",
    },
    validationErrors: [],
    generatedBy: "human",
    model: null,
    approvalCheckpointId: checkpoint.id,
  });

  const matterUrl = `${frontendUrl.replace(/\/$/, "")}/aletheia/matters/${matter.id}`;
  console.log(
    JSON.stringify(
      {
        ok: true,
        dataDir: process.env.ALETHEIA_DATA_DIR,
        matterId: matter.id,
        matterUrl,
        documentId: document.id,
        evidenceId: evidence.id,
        issueMapId: (issueMap as any).id,
        auditPackId: auditPack.id,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error("[aletheia-seed-ui-smoke] failed", error);
  process.exit(1);
});
