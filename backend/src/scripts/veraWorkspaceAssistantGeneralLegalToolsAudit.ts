import assert from "node:assert/strict";

import type { AssistantToolContext } from "../lib/workspace/services/assistantRuntime";
import { reduceTabularStudioHandoff } from "../lib/workspace/tabularStudioHandoff";
import {
  AssistantGeneralLegalToolError,
  WorkspaceAssistantGeneralLegalToolModule,
} from "../lib/workspace/services/assistantGeneralLegalTools";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const JOB = "33333333-3333-4333-8333-333333333333";
const CHAT = "44444444-4444-4444-8444-444444444444";
const MODEL = "55555555-5555-4555-8555-555555555555";
const DOC = "66666666-6666-4666-8666-666666666666";
const VERSION = "77777777-7777-4777-8777-777777777777";
const DOC_2 = "88888888-8888-4888-8888-888888888888";
const VERSION_2 = "99999999-9999-4999-8999-999999999999";

function context(attempt = 1): AssistantToolContext {
  return {
    jobId: JOB,
    attempt,
    leaseOwner: "general-legal-audit",
    chatId: CHAT,
    projectId: PROJECT,
    modelProfileId: MODEL,
    documents: [
      { documentId: DOC, versionId: VERSION, attached: true },
      { documentId: DOC_2, versionId: VERSION_2, attached: true },
    ],
  };
}
class FakeTabular {
  readonly reviews = new Map<string, any>();
  creates = 0;
  runs = 0;
  completeOnRun = false;
  get(id: string) {
    const review = this.reviews.get(id);
    if (!review) throw new Error("missing");
    return review;
  }
  createPresetReviewWithId(id: string, value: any) {
    this.creates += 1;
    const columns = value.columns.map((column: any, index: number) => ({
      id: `${id}:${index}`,
      key: column.key,
      title: column.title,
      prompt: column.prompt,
      outputType: column.outputType,
      ordinal: index,
    }));
    const review = {
      review: {
        id,
        projectId: value.projectId,
        workflowId: null,
        modelProfileId: value.modelProfileId,
        title: value.title,
        documentIds: value.documentIds,
        status: "draft",
      },
      columns,
      cells: value.documentIds.flatMap((documentId: string) =>
        columns.map((column: any) => ({
          id: `${documentId}:${column.id}`,
          documentId,
          columnId: column.id,
          status: "empty",
          error: null,
          value: null,
          content: null,
        })),
      ),
    };
    this.reviews.set(id, review);
    return review;
  }
  runReview(id: string) {
    this.runs += 1;
    const review = this.get(id);
    review.review.status = "running";
    for (const cell of review.cells) cell.status = "running";
    if (this.completeOnRun) {
      review.review.status = "complete";
      for (const cell of review.cells) cell.status = "complete";
    }
    return { review };
  }
  cancelReview(id: string) {
    const review = this.get(id);
    review.review.status = "cancelled";
    for (const cell of review.cells) cell.status = "cancelled";
    return review;
  }
}
async function call(
  module: WorkspaceAssistantGeneralLegalToolModule,
  ctx: AssistantToolContext,
  name: string,
  input: Record<string, unknown>,
  id = `${name}-1`,
) {
  return module.execute({
    context: ctx,
    call: { id, name, input } as any,
    signal: new AbortController().signal,
  });
}
async function rejects(fn: () => Promise<unknown>) {
  await assert.rejects(fn, AssistantGeneralLegalToolError);
}

async function main() {
  const tabular = new FakeTabular();
  const writes: any[] = [];
  const tabularWrites: any[] = [];
  const actionRecords = new Map<string, any>();
  const actions = {
    reserve(input: any) {
      const existing = actionRecords.get(input.actionKey);
      if (existing) {
        if (existing.input !== JSON.stringify(input.input)) {
          throw new AssistantGeneralLegalToolError(
            "recovery must reserve the same immutable extraction projection",
          );
        }
        return { record: existing, created: false };
      }
      const record = {
        jobId: input.jobId,
        actionKey: input.actionKey,
        actionType: input.actionType,
        projectId: input.projectId,
        status: "reserved",
        resourceType: null,
        resourceId: null,
        input: JSON.stringify(input.input),
      };
      actionRecords.set(input.actionKey, record);
      return { record, created: true };
    },
    complete(input: any) {
      const record = actionRecords.get(input.actionKey);
      Object.assign(record, {
        status: "complete",
        resourceType: input.resourceType,
        resourceId: input.resourceId,
      });
      return { record, completed: true };
    },
    get(_jobId: string, actionKey: string) {
      return actionRecords.get(actionKey) ?? null;
    },
    list(_jobId: string, actionType: string) {
      return [...actionRecords.values()].filter(
        (record) => record.actionType === actionType,
      );
    },
  };
  const tabularDrafts = new Map<string, any>();
  const module = new WorkspaceAssistantGeneralLegalToolModule(
    () => tabular as any,
    {
      actions: actions as any,
      maxWaitMs: 0,
      initialPollMs: 1,
      maxPollMs: 1,
      delay: async () => {},
      assertCurrentDocuments(projectId, docs) {
        assert.equal(projectId, PROJECT);
        assert.deepEqual(docs, [
          { documentId: DOC, versionId: VERSION },
          { documentId: DOC_2, versionId: VERSION_2 },
        ]);
      },
      async createDraft(_context, input) {
        writes.push(input);
        return {
          documentId: input.documentId,
          versionId: input.versionId,
          title: input.title,
        };
      },
      async createDraftFromTabularReview(_context, input) {
        const existing = tabularDrafts.get(input.operationId);
        if (existing) return existing;
        tabularWrites.push(input);
        const result = {
          documentId: input.documentId,
          versionId: input.versionId,
          title: input.title,
        };
        tabularDrafts.set(input.operationId, result);
        return result;
      },
    },
  );
  const tools = await module.registeredTools(context());
  assert.deepEqual(
    tools.map((tool) => tool.name),
    [
      "run_custom_extraction",
      "create_legal_memo",
      "create_memo_from_tabular_review",
    ],
  );
  const extractionSchema = tools[0]?.inputSchema as any;
  assert.equal(extractionSchema.type, "object");
  assert.equal(extractionSchema.oneOf.length, 2);
  assert.deepEqual(
    extractionSchema.oneOf.map((branch: any) => branch.properties.mode.enum),
    [["custom"], ["timeline"]],
  );
  assert.deepEqual(extractionSchema.oneOf[0].required, [
    "mode",
    "title",
    "columns",
  ]);
  assert.deepEqual(extractionSchema.oneOf[1].required, ["mode"]);
  assert.equal(extractionSchema.oneOf[0].additionalProperties, false);
  assert.equal(extractionSchema.oneOf[1].additionalProperties, false);
  assert.equal(JSON.stringify(extractionSchema).includes('"preset"'), false);
  const custom = await call(module, context(), "run_custom_extraction", {
    mode: "custom",
    title: "Fact extraction",
    columns: [{ name: "Party", instruction: "Extract parties." }],
  });
  const customResult = JSON.parse(custom.content);
  assert.equal(customResult.review.status, "running");
  assert.equal(tabular.creates, 1);
  assert.equal(custom.events?.[0]?.type, "tabular_review_created");
  const replay = await call(module, context(), "run_custom_extraction", {
    title: "Fact extraction",
    columns: [{ name: "Party", instruction: "Extract parties." }],
  });
  assert.equal(
    JSON.parse(replay.content).review.review_id,
    customResult.review.review_id,
  );
  assert.equal(tabular.creates, 1);
  await rejects(() =>
    call(module, context(), "run_custom_extraction", {
      mode: "custom",
      title: "bad",
      columns: [
        { name: "Duplicate", instruction: "x" },
        { name: "duplicate", instruction: "y" },
      ],
    }),
  );
  const timeline = await call(
    module,
    context(),
    "run_custom_extraction",
    { mode: "timeline" },
    "timeline-call",
  );
  const timelineId = JSON.parse(timeline.content).review.review_id;
  assert.equal(tabular.get(timelineId).columns.length, 7);
  const legacyTimeline = await call(
    module,
    context(),
    "run_custom_extraction",
    { preset: "timeline" },
    "legacy-timeline-call",
  );
  assert.equal(JSON.parse(legacyTimeline.content).review.review_id, timelineId);
  assert.equal(tabular.creates, 2);
  await rejects(() => call(module, context(), "run_custom_extraction", {}));
  await rejects(() =>
    call(module, context(), "run_custom_extraction", {
      mode: "custom",
      title: "Missing columns",
    }),
  );
  await rejects(() =>
    call(module, context(), "run_custom_extraction", {
      mode: "timeline",
      columns: [{ name: "Unexpected", instruction: "Reject this." }],
    }),
  );
  await rejects(() =>
    call(module, context(), "run_custom_extraction", {
      mode: "other",
    }),
  );
  await rejects(() =>
    call(module, context(), "run_custom_extraction", {
      mode: "timeline",
      preset: "timeline",
    }),
  );
  await rejects(() =>
    call(module, context(), "create_memo_from_tabular_review", {
      review_id: customResult.review.review_id,
    }),
  );
  const completed = tabular.get(customResult.review.review_id);
  completed.review.status = "complete";
  for (const cell of completed.cells) {
    cell.status = "complete";
    cell.content = { summary: "Acme Ltd." };
  }
  const customReduced = reduceTabularStudioHandoff(
    {
      kind: "custom_extraction_summary",
      detail: completed,
      source: {
        orderedUniqueSources: [
          {
            documentId: DOC,
            versionId: VERSION,
            chunkId: "chunk-1",
            quote: "Acme Ltd.",
            startOffset: 0,
            endOffset: 9,
          },
        ],
      },
    } as any,
    { projectId: PROJECT, title: "Extraction summary" },
  );
  assert.equal(customReduced.documentType, "general_legal_document");
  assert.match(customReduced.content, /\| Source document \| Party \|/);
  assert.match(customReduced.content, /Acme Ltd\./);
  assert.match(customReduced.content, /\[1\]/);
  const lifecycle = await module.settleLifecycle?.({
    phase: "after_execution",
    context: context(),
    call: {
      id: "run_custom_extraction-1",
      name: "run_custom_extraction",
      input: {},
    } as any,
    result: custom,
    signal: new AbortController().signal,
  });
  assert.equal(
    JSON.parse(lifecycle?.replacementContent ?? "{}").review.status,
    "complete",
  );
  const completedTimeline = tabular.get(timelineId);
  completedTimeline.review.status = "complete";
  const timelineValues: Record<string, string> = {
    Date: "2026-01-12",
    Event: "The claimant sent a payment demand.",
    Participants: "Claimant; Respondent",
    "Source file": "demand-letter.pdf",
    "Original evidence": "Payment is due within seven days.",
    "Potential significance": "May establish notice before filing.",
    "Open questions": "Confirm the delivery receipt.",
  };
  for (const cell of completedTimeline.cells) {
    const column = completedTimeline.columns.find(
      (candidate: any) => candidate.id === cell.columnId,
    );
    cell.status = "complete";
    cell.content = { summary: timelineValues[column.title] };
  }
  const timelineReduced = reduceTabularStudioHandoff(
    {
      kind: "case_fact_summary",
      detail: completedTimeline,
      source: {
        orderedUniqueSources: [
          {
            documentId: DOC,
            versionId: VERSION,
            chunkId: "chunk-2",
            quote: "Payment is due within seven days.",
            startOffset: 0,
            endOffset: 34,
          },
        ],
      },
    } as any,
    { projectId: PROJECT, title: "Matter facts" },
  );
  assert.equal(timelineReduced.documentType, "general_legal_document");
  assert.match(timelineReduced.content, /## 核心时间线/);
  assert.match(timelineReduced.content, /Payment is due within seven days\./);
  assert.match(timelineReduced.content, /## 证据引用/);
  // Simulate the precise crash window after the Review action is committed
  // but before runReview begins. The reclaimed attempt must start this same
  // durable Review rather than merely waiting or creating another one.
  completed.review.status = "draft";
  for (const cell of completed.cells) cell.status = "empty";
  const runsBeforeRecovery = tabular.runs;
  tabular.completeOnRun = true;
  const restarted = new WorkspaceAssistantGeneralLegalToolModule(
    () => tabular as any,
    {
      actions: actions as any,
      assertCurrentDocuments(projectId, docs) {
        assert.equal(projectId, PROJECT);
        assert.deepEqual(docs, [
          { documentId: DOC, versionId: VERSION },
          { documentId: DOC_2, versionId: VERSION_2 },
        ]);
      },
      async createDraft() {
        throw new Error("not reached");
      },
      async createDraftFromTabularReview(_context, input) {
        const existing = tabularDrafts.get(input.operationId);
        if (existing) return existing;
        tabularWrites.push(input);
        const result = {
          documentId: input.documentId,
          versionId: input.versionId,
          title: input.title,
        };
        tabularDrafts.set(input.operationId, result);
        return result;
      },
    },
  );
  await restarted.registeredTools(context(2));
  const recovered = await restarted.settleLifecycle({
    phase: "before_final",
    context: context(2),
    signal: new AbortController().signal,
  });
  assert.equal(
    recovered?.events?.filter(
      (event) => event.type === "tabular_review_created",
    ).length,
    2,
    "reclaimed attempt must recover both completed extraction bindings",
  );
  assert.equal(tabular.creates, 2, "recovery must not create another Review");
  assert.equal(
    tabular.runs,
    runsBeforeRecovery + 1,
    "recovery must start the persisted draft Review exactly once",
  );
  const recoveredCustom = await call(
    restarted,
    context(2),
    "create_memo_from_tabular_review",
    { review_id: customResult.review.review_id },
    "restarted-custom-memo",
  );
  assert.equal(
    JSON.parse(recoveredCustom.content).memo.draft_id,
    tabularWrites[0].documentId,
  );
  assert.equal(tabularWrites[0].reviewId, customResult.review.review_id);
  assert.equal(tabularWrites[0].kind, "custom_extraction_summary");
  const recoveredCustomReplay = await call(
    restarted,
    context(2),
    "create_memo_from_tabular_review",
    {
      review_id: customResult.review.review_id,
      title: "Model-proposed replacement title must not create another Draft",
    },
    "restarted-custom-memo-replay",
  );
  assert.equal(
    JSON.parse(recoveredCustomReplay.content).memo.draft_id,
    tabularWrites[0].documentId,
  );
  assert.equal(
    tabularWrites.length,
    1,
    "restart must not create a second custom memo",
  );
  const recoveredTimeline = await call(
    restarted,
    context(2),
    "create_memo_from_tabular_review",
    { review_id: timelineId },
    "restarted-timeline-memo",
  );
  assert.equal(
    JSON.parse(recoveredTimeline.content).memo.draft_id,
    tabularWrites[1].documentId,
  );
  assert.equal(tabularWrites[1].reviewId, timelineId);
  assert.equal(tabularWrites[1].kind, "case_fact_summary");
  assert.match(tabularWrites[1].title, /案件事实摘要/);
  assert.equal(
    tabularWrites.length,
    2,
    "restart must replay the deterministic timeline memo write without a second Draft",
  );
  tabular.get(timelineId).columns[0].key = "date_changed_1";
  await rejects(() =>
    call(
      restarted,
      context(2),
      "create_memo_from_tabular_review",
      { review_id: timelineId },
      "ambiguous-timeline-memo",
    ),
  );
  assert.equal(tabularWrites.length, 2);
  const unboundReviewId = "abababab-abab-4bab-8bab-abababababab";
  const unbound = tabular.createPresetReviewWithId(unboundReviewId, {
    projectId: PROJECT,
    workflowId: null,
    title: "Foreign custom extraction",
    documentIds: [DOC, DOC_2],
    modelProfileId: MODEL,
    columns: [
      {
        key: "party_1",
        title: "Party",
        prompt: "Extract parties.",
        outputType: "text",
      },
    ],
  });
  unbound.review.status = "complete";
  for (const cell of unbound.cells) cell.status = "complete";
  const actionsBeforeForeignMemo = actionRecords.size;
  await rejects(() =>
    call(
      restarted,
      context(2),
      "create_memo_from_tabular_review",
      { review_id: unboundReviewId },
      "foreign-unbound-memo",
    ),
  );
  assert.equal(
    actionRecords.size,
    actionsBeforeForeignMemo,
    "an unbound same-Matter Review must not reserve a new action",
  );
  const direct = await call(module, context(), "create_legal_memo", {
    title: "Legal note",
    documentType: "general_legal_document",
    contentMarkdown: "# Note",
  });
  assert.equal(JSON.parse(direct.content).memo.title, "Legal note");
  assert.equal(writes.length, 1);
  assert.equal(tabularWrites.length, 2);
  await module.registeredTools(context(2));
  await rejects(() => module.registeredTools(context(1)));
  const foreign = new WorkspaceAssistantGeneralLegalToolModule(
    () => tabular as any,
    {
      actions: actions as any,
      assertCurrentDocuments(projectId) {
        if (projectId === OTHER) throw new Error("foreign");
      },
      async createDraft() {
        throw new Error("not reached");
      },
      async createDraftFromTabularReview() {
        throw new Error("not reached");
      },
    },
  );
  await foreign.registeredTools({ ...context(), projectId: OTHER });
  await rejects(() =>
    call(
      foreign,
      { ...context(), projectId: OTHER },
      "create_memo_from_tabular_review",
      { review_id: customResult.review.review_id },
    ),
  );
  console.log(
    "veraWorkspaceAssistantGeneralLegalToolsAudit passed: custom and timeline extraction, deterministic replay, reclaimed-action recovery before memo creation, no duplicate Review or Draft, immutable recovered projection checks, unbound same-Matter rejection, lifecycle settlement, generation fencing, direct memo, and input rejection.",
  );
}
void main();
