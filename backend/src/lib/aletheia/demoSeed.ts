import { createAletheiaRepository } from ".";
import type { AletheiaRepository, AletheiaUserContext } from "./repository";

const DEFAULT_DEMO_SEED_ID = "vera-civil-litigation-demo-v2";
const DEFAULT_DEMO_TITLE = "Civil Litigation Demo";

type SeedDecision = {
  shouldSeed: boolean;
  reason: string;
};

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function envText(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function demoSeedId(): string {
  return envText("ALETHEIA_DEMO_SEED_ID", DEFAULT_DEMO_SEED_ID);
}

function demoMatterTitle(): string {
  const suffix = process.env.ALETHEIA_DEMO_SEED_TITLE_SUFFIX?.trim();
  return suffix ? `${DEFAULT_DEMO_TITLE} — ${suffix}` : DEFAULT_DEMO_TITLE;
}

function localUserContext(): AletheiaUserContext {
  return {
    userId: process.env.ALETHEIA_LOCAL_USER_ID ?? "local-user",
    userEmail:
      process.env.ALETHEIA_LOCAL_USER_EMAIL ?? "local@aletheia.internal",
  };
}

function hasDemoSeed(matters: unknown[], seedId: string): boolean {
  return matters.some(
    (matter: any) => matter?.metadata?.demoSeedId === seedId,
  );
}

function existingDemoMatter(matters: unknown[], seedId: string) {
  return matters.find(
    (matter: any) => matter?.metadata?.demoSeedId === seedId,
  ) as { id?: string; title?: string } | undefined;
}

async function seedDecision(
  repo: AletheiaRepository,
  ctx: AletheiaUserContext,
): Promise<SeedDecision> {
  if (!envFlag("ALETHEIA_DEMO_SEED_ENABLED", false)) {
    return { shouldSeed: false, reason: "disabled" };
  }
  const matters = await repo.listMatters(ctx);
  if (hasDemoSeed(matters, demoSeedId())) {
    return { shouldSeed: false, reason: "already-seeded" };
  }

  const mode = (process.env.ALETHEIA_DEMO_SEED_MODE ?? "empty")
    .trim()
    .toLowerCase();
  if (mode === "always") {
    return { shouldSeed: true, reason: "always" };
  }
  if (
    mode === "empty" &&
    !matters.some((matter: any) => matter?.template === "civil_litigation")
  ) {
    return { shouldSeed: true, reason: "empty-workspace" };
  }
  return { shouldSeed: false, reason: `mode-${mode}-with-existing-data` };
}

async function approve(
  repo: AletheiaRepository,
  ctx: AletheiaUserContext,
  matterId: string,
  action: "audit_pack_export" | "feedback_dataset_export" | "final_memo_export",
  prompt: string,
  seedId: string,
) {
  const checkpoint: any = await repo.requestApproval(ctx, matterId, {
    action,
    prompt,
    requestedPayload: { demoSeedId: seedId },
  });
  if (!checkpoint?.id) {
    throw new Error(`Demo seed could not request ${action} approval`);
  }
  await repo.decideApproval(ctx, matterId, checkpoint.id, {
    decision: "approved",
    comment: "Approved for the bundled local demo workspace.",
  });
  return checkpoint;
}

export async function seedAletheiaDemoMatter(
  repo: AletheiaRepository,
  ctx: AletheiaUserContext,
) {
  const seedId = demoSeedId();
  const title = demoMatterTitle();
  const timestamp = new Date().toISOString();
  const matter: any = await repo.createMatter(ctx, {
    title,
    objective:
      "Review the civil dispute from intake and source evidence through claims, procedure, legal research, drafting, approval, and audited export.",
    template: "civil_litigation",
    status: "in_progress",
    riskLevel: "high",
    clientOrProject: "Vera civil litigation demo",
    sourceProjectId: null,
    sharedWith: [],
    metadata: {
      seededBy: "aletheiaDemoSeed",
      demoSeedId: seedId,
      seededAt: timestamp,
      localOnly: true,
    },
  });

  const sourceText = [
    "杭州市中级人民法院开庭通知",
    "本院定于2026年8月10日上午9时就华信制造有限公司与兰亭贸易有限公司买卖合同纠纷一案开庭审理。",
    "被告应于2026年8月3日前完成证据材料内部复核，并按法院要求提交证据目录。",
    "付款记录显示，争议款项约定付款日为2026年9月1日。",
    "原告主张被告已经逾期付款；被告主张起诉时付款期限尚未届满。",
  ].join("\n");

  const document: any = await repo.uploadMatterDocument(ctx, matter.id, {
    filename: "hearing-notice-and-payment-record.txt",
    mimeType: "text/plain",
    sizeBytes: Buffer.byteLength(sourceText, "utf8"),
    buffer: Buffer.from(sourceText, "utf8"),
  });

  const sourceIndex: any = await repo.listV1SourceIndex(ctx, matter.id, {
    includeChunks: true,
    includeEvidenceLinks: true,
    chunkLimit: 100,
  });
  const chunks = (sourceIndex?.chunks ?? []) as Array<Record<string, any>>;
  const hearingQuote = "2026年8月10日上午9时";
  const paymentQuote = "争议款项约定付款日为2026年9月1日";
  const hearingChunk = chunks.find((item) =>
    String(item.text).includes(hearingQuote),
  );
  const paymentChunk = chunks.find((item) =>
    String(item.text).includes(paymentQuote),
  );
  if (!hearingChunk || !paymentChunk) {
    throw new Error("Civil litigation demo source anchors were not indexed");
  }
  const hearingStart = String(hearingChunk.text).indexOf(hearingQuote);
  const paymentStart = String(paymentChunk.text).indexOf(paymentQuote);
  const evidenceItems = [];
  const evidenceChunks = new Map(
    [hearingChunk, paymentChunk].map((chunk) => [String(chunk.id), chunk]),
  );
  for (const chunk of evidenceChunks.values()) {
    const evidence: any = await repo.createEvidenceItem(ctx, matter.id, {
      sourceChunkId: String(chunk.id),
      relevance: "direct",
      supportStatus: "supports",
      confidence: "high",
      metadata: {
        seededBy: "aletheiaDemoSeed",
        demoSeedId: seedId,
        domain: "civil_litigation",
      },
    });
    if (evidence) evidenceItems.push(evidence);
  }

  const hearingFact: any = await repo.createLitigationFact(ctx, matter.id, {
    statement: "法院定于2026年8月10日上午9时开庭审理本案。",
    occurredAt: "2026-08-10T09:00:00+08:00",
    datePrecision: "day",
    sourceRelation: "supports",
    helpfulness: "neutral",
    confidence: "high",
    createdBy: "agent",
    source: {
      sourceChunkId: String(hearingChunk.id),
      quoteStart: hearingStart,
      quoteEnd: hearingStart + hearingQuote.length,
    },
  });
  await repo.decideLitigationFact(ctx, matter.id, hearingFact.id, {
    decision: "confirmed",
    comment: "已与法院开庭通知逐字核对。",
  });
  const paymentFact: any = await repo.createLitigationFact(ctx, matter.id, {
    statement: "争议款项的合同约定付款日为2026年9月1日。",
    occurredAt: "2026-09-01T00:00:00+08:00",
    datePrecision: "day",
    sourceRelation: "supports",
    helpfulness: "helpful",
    confidence: "high",
    createdBy: "agent",
    source: {
      sourceChunkId: String(paymentChunk.id),
      quoteStart: paymentStart,
      quoteEnd: paymentStart + paymentQuote.length,
    },
  });
  await repo.decideLitigationFact(ctx, matter.id, paymentFact.id, {
    decision: "confirmed",
    comment: "已与付款记录逐字核对。",
  });
  const defense: any = await repo.createLitigationClaim(ctx, matter.id, {
    kind: "defense",
    title: "起诉时付款义务尚未届期",
    legalBasis: "合同履行期限及债务未届期抗辩",
    confidence: "medium",
    uncertainty: "仍需核实起诉日期及合同是否存在加速到期条款。",
    sourceRelation: "supports",
    source: {
      sourceChunkId: String(paymentChunk.id),
      quoteStart: paymentStart,
      quoteEnd: paymentStart + paymentQuote.length,
    },
    createdBy: "agent",
  });
  const element: any = await repo.createLitigationElement(
    ctx,
    matter.id,
    defense.id,
    {
      title: "约定付款期限",
      sequence: 1,
      description: "合同约定的付款日在起诉日之后。",
      createdBy: "agent",
    },
  );
  await repo.linkLitigationElementFact(ctx, matter.id, element.id, {
    factId: paymentFact.id,
    relation: "supports",
  });
  const proceduralEvent: any = await repo.createLitigationProceduralEvent(
    ctx,
    matter.id,
    {
      eventType: "hearing_notice",
      title: "收到法院开庭通知",
      occurredAt: timestamp,
      createdBy: "agent",
      source: {
        sourceChunkId: String(hearingChunk.id),
        quoteStart: hearingStart,
        quoteEnd: hearingStart + hearingQuote.length,
      },
    },
  );
  const deadline: any = await repo.createLitigationDeadline(ctx, matter.id, {
    title: "完成证据材料内部复核",
    dueAt: "2026-08-03T18:00:00+08:00",
    triggeringEventId: proceduralEvent.id,
    ruleLabel: "法院开庭通知及内部复核安排",
    ruleVersion: "demo-2026-01",
    calculation: "按法院通知载明日期完成内部证据复核。",
    createdBy: "agent",
    source: {
      sourceChunkId: String(hearingChunk.id),
      quoteStart: hearingStart,
      quoteEnd: hearingStart + hearingQuote.length,
    },
  });
  await repo.decideLitigationDeadline(ctx, matter.id, deadline.id, {
    decision: "confirmed",
    comment: "已与法院通知核对并由律师确认。",
  });
  const taskResult: any = await repo.createTaskFromLitigationDeadline(
    ctx,
    matter.id,
    deadline.id,
    { title: "完成证据材料内部复核", priority: "high" },
  );

  const evidenceCatalog: any = await repo.generateLitigationArtifact(
    ctx,
    matter.id,
    "evidence_catalog",
  );
  const claimDefenseMatrix: any = await repo.generateLitigationArtifact(
    ctx,
    matter.id,
    "claim_defense_matrix",
  );
  const proceduralClock: any = await repo.generateLitigationArtifact(
    ctx,
    matter.id,
    "procedural_clock",
  );
  const litigationBrief: any = await repo.generateLitigationArtifact(
    ctx,
    matter.id,
    "litigation_brief",
  );

  const review: any = await repo.addReview(ctx, matter.id, {
    targetType: "work_product",
    targetId: litigationBrief.id,
    tag: "missing_material",
    comment:
      "起诉日期及加速到期条款仍待核实，诉讼意见不得将未届期抗辩表述为确定结论。",
    workProductId: litigationBrief.id,
    evidenceItemId: evidenceItems[0]?.id ?? null,
    reviewerName: "Local demo reviewer",
  });
  if (review?.id) {
    await repo.resolveReview(ctx, matter.id, review.id, {
      status: "needs_material",
      comment: "Converted to a durable eval case for the local demo.",
      createEvalCase: true,
    });
  }

  const memory = await repo.addMatterMemory(ctx, matter.id, {
    category: "missing_material",
    title: "未届期抗辩须核实起诉日期",
    body: "在确认起诉日期和加速到期条款前，不得将付款义务未届期作为确定性结论。",
    source: "review",
    metadata: { demoSeedId: seedId, reviewId: review?.id ?? null },
  });

  const playbook: any = await repo.createPlaybook(ctx, matter.id, {
    name: "Civil Litigation Demo Playbook",
    description:
      "Local-only reviewer-approved workflow for source-bound civil litigation demos.",
    version: "v0.1",
    content: {
      format: "markdown",
      body: [
        "1. Ingest local sources and preserve source anchors.",
        "2. Confirm source-bound facts before relying on them.",
        "3. Map claims, defenses, elements, facts, and procedural events.",
        "4. Confirm every deadline before creating a task.",
        "5. Require explicit approval before litigation exports.",
      ].join("\n"),
      controls: {
        localOnly: true,
        matterScoped: true,
        agentMayAutoModify: false,
        requiresHumanApprovalForUpdates: true,
      },
    },
  });
  await repo.approvePlaybook(ctx, matter.id, playbook.id);

  const run: any = await repo.createAgentRun(ctx, matter.id, {
    workflow: "civil_litigation",
    goal: "Seed the local civil litigation demo workflow",
    status: "queued",
    metadata: { seededBy: "aletheiaDemoSeed", demoSeedId: seedId },
  });

  const auditApproval = await approve(
    repo,
    ctx,
    matter.id,
    "audit_pack_export",
    "Approve bundled local demo audit/export package.",
    seedId,
  );
  const evalApproval = await approve(
    repo,
    ctx,
    matter.id,
    "feedback_dataset_export",
    "Approve bundled local demo eval export.",
    seedId,
  );
  const finalMemoApproval = await approve(
    repo,
    ctx,
    matter.id,
    "final_memo_export",
    "Approve bundled local demo final memo export gate.",
    seedId,
  );

  const auditPack: any = await repo.createWorkProduct(ctx, matter.id, {
    kind: "audit_pack",
    title: "Civil Litigation Demo Audit Pack",
    status: "generated",
    schemaVersion: "aletheia-audit-pack-v0",
    content: {
      matterId: matter.id,
      documentId: document.id,
      evidenceIds: evidenceItems.map((item: any) => item.id),
      evidenceCatalogId: evidenceCatalog?.id ?? null,
      claimDefenseMatrixId: claimDefenseMatrix?.id ?? null,
      proceduralClockId: proceduralClock?.id ?? null,
      litigationBriefId: litigationBrief?.id ?? null,
      factIds: [hearingFact.id, paymentFact.id],
      defenseId: defense.id,
      deadlineId: deadline.id,
      taskId: taskResult?.task?.id ?? null,
      memoryId: (memory as any)?.id ?? null,
      playbookId: playbook.id,
      runId: run?.id ?? null,
      demoSeedId: seedId,
    },
    validationErrors: [],
    generatedBy: "system",
    model: null,
    approvalCheckpointId: auditApproval.id,
  });

  const localExportPackage: any = await repo.createLocalExportPackage(
    ctx,
    matter.id,
    { approvalCheckpointId: auditApproval.id, includeChunks: true },
  );
  const durableEvalExport: any = await repo.createDurableEvalExport(
    ctx,
    matter.id,
    { approvalCheckpointId: evalApproval.id, includeClosed: true },
  );

  await repo.createWorkProduct(ctx, matter.id, {
    kind: "final_memo",
    title: "Civil Litigation Demo Final Memorandum",
    status: "approved",
    schemaVersion: "aletheia-final-memo-v0",
    content: {
      summary:
        "Demo final memo approved for local workflow inspection only; it is not legal advice.",
      sourceLitigationBriefId: litigationBrief?.id ?? null,
      unresolvedLimitations: ["起诉日期及加速到期条款仍待核实。"],
      gateResults: [
        {
          id: "demo-citation-gate",
          matter_id: matter.id,
          gate_type: "citation",
          status: "passed",
          reason: "Demo memo claims are linked to local source evidence.",
          affected_artifact_ids: [
            litigationBrief?.id,
            evidenceItems[0]?.id,
          ].filter(
            Boolean,
          ),
        },
        {
          id: "demo-human-approval-gate",
          matter_id: matter.id,
          gate_type: "human_approval",
          status: "passed",
          reason: "Demo final memo export was approved by the local reviewer.",
          affected_artifact_ids: [
            litigationBrief?.id,
            finalMemoApproval.id,
          ].filter(Boolean),
        },
        {
          id: "demo-export-gate",
          matter_id: matter.id,
          gate_type: "export",
          status: "passed",
          reason: "Demo final memo export is authorized for local inspection.",
          affected_artifact_ids: [
            litigationBrief?.id,
            finalMemoApproval.id,
          ].filter(Boolean),
        },
      ],
      gateProvenance: [
        {
          gate_id: "demo-citation-gate",
          gate_type: "citation",
          status: "passed",
          displayed_reason: "Source-linked evidence is present.",
          source_record_refs: [
            {
              type: "evidence_item",
              id: evidenceItems[0]?.id,
              role: "provenance",
            },
          ],
          unresolved_source_requirements: [],
        },
        {
          gate_id: "demo-human-approval-gate",
          gate_type: "human_approval",
          status: "passed",
          displayed_reason: "Approved checkpoint is persisted.",
          source_record_refs: [
            {
              type: "human_checkpoint",
              id: finalMemoApproval.id,
              role: "approval",
            },
          ],
          unresolved_source_requirements: [],
        },
        {
          gate_id: "demo-export-gate",
          gate_type: "export",
          status: "passed",
          displayed_reason:
            "Final export is authorized by the same checkpoint.",
          source_record_refs: [
            {
              type: "human_checkpoint",
              id: finalMemoApproval.id,
              role: "approval",
            },
          ],
          unresolved_source_requirements: [],
        },
      ],
      demoSeedId: seedId,
    },
    validationErrors: ["起诉日期及加速到期条款仍待核实。"],
    generatedBy: "system",
    model: null,
    approvalCheckpointId: finalMemoApproval.id,
  });

  return {
    matterId: matter.id,
    matterTitle: title,
    documentId: document.id,
    evidenceCount: evidenceItems.length,
    evidenceCatalogId: evidenceCatalog?.id ?? null,
    claimDefenseMatrixId: claimDefenseMatrix?.id ?? null,
    proceduralClockId: proceduralClock?.id ?? null,
    litigationBriefId: litigationBrief?.id ?? null,
    factIds: [hearingFact.id, paymentFact.id],
    defenseId: defense.id,
    deadlineId: deadline.id,
    taskId: taskResult?.task?.id ?? null,
    reviewId: review?.id ?? null,
    auditPackId: auditPack?.id ?? null,
    localExportId: localExportPackage?.export_id ?? null,
    durableEvalExportId: durableEvalExport?.export_id ?? null,
  };
}

export async function seedAletheiaDemoIfNeeded() {
  const ctx = localUserContext();
  const repo = createAletheiaRepository();
  const decision = await seedDecision(repo, ctx);
  if (!decision.shouldSeed) {
    const matters = await repo.listMatters(ctx);
    const existing = existingDemoMatter(matters, demoSeedId());
    return {
      seeded: false,
      reason: decision.reason,
      ...(existing?.id ? { matterId: existing.id } : {}),
      ...(existing?.title ? { matterTitle: existing.title } : {}),
    };
  }
  const result = await seedAletheiaDemoMatter(repo, ctx);
  return { seeded: true, reason: decision.reason, ...result };
}
