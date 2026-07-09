import "dotenv/config";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAletheiaRepository } from "../lib/aletheia";
import { CapabilityNotAvailableError } from "../lib/aletheia/repository";
import type { AletheiaUserContext } from "../lib/aletheia/repository";

type EvalCase = {
  id: string;
  matterId: string;
  mode: "keyword" | "semantic" | "hybrid";
  query: string;
  expectedDocument: string | null;
  expectedFound: boolean;
};

type EvalResult = EvalCase & {
  passed: boolean;
  topDocument: string | null;
  resultCount: number;
  retrievalLayers: string[];
  retrievalRank: number | null;
  retrievalScoreDirection: string | null;
  retrievalBasis: string | null;
  error?: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function createMatterWithDocument(args: {
  ctx: AletheiaUserContext;
  repo: ReturnType<typeof createAletheiaRepository>;
  title: string;
  filename: string;
  body: string;
}) {
  const matter: any = await args.repo.createMatter(args.ctx, {
    title: args.title,
    objective: "Retrieval evaluation fixture with matter-isolated evidence.",
    template: "legal_matter_review",
    status: "draft",
    riskLevel: "medium",
    clientOrProject: "Retrieval eval",
    sourceProjectId: null,
    sharedWith: [],
    metadata: { evalSuite: "aletheia-retrieval-eval-v0" },
  });
  const document: any = await args.repo.uploadMatterDocument(
    args.ctx,
    matter.id,
    {
      filename: args.filename,
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength(args.body, "utf8"),
      buffer: Buffer.from(args.body, "utf8"),
    },
  );
  assert(document.parsed_status === "parsed", `${args.filename} should parse`);
  return { matter, document };
}

async function runEvalCase(
  repo: ReturnType<typeof createAletheiaRepository>,
  ctx: AletheiaUserContext,
  evalCase: EvalCase,
): Promise<EvalResult> {
  try {
    const results: any[] | null = await repo.searchMatterDocuments(
      ctx,
      evalCase.matterId,
      {
        query: evalCase.query,
        mode: evalCase.mode,
        limit: 5,
      },
    );
    const top = results?.[0] ?? null;
    const topDocument = top?.document_name ?? null;
    const hasDiagnostics =
      !top ||
      (top.retrieval_rank === 1 &&
        typeof top.retrieval_score === "number" &&
        typeof top.retrieval_score_direction === "string" &&
        typeof top.retrieval_explanation?.basis === "string");
    const foundExpected = evalCase.expectedFound
      ? topDocument === evalCase.expectedDocument
      : (results?.length ?? 0) === 0;
    return {
      ...evalCase,
      passed: foundExpected && hasDiagnostics,
      topDocument,
      resultCount: results?.length ?? 0,
      retrievalLayers: top?.retrieval_layers ?? [],
      retrievalRank: top?.retrieval_rank ?? null,
      retrievalScoreDirection: top?.retrieval_score_direction ?? null,
      retrievalBasis: top?.retrieval_explanation?.basis ?? null,
    };
  } catch (error) {
    return {
      ...evalCase,
      passed: false,
      topDocument: null,
      resultCount: 0,
      retrievalLayers: [],
      retrievalRank: null,
      retrievalScoreDirection: null,
      retrievalBasis: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const dataDir = path.join(
    os.tmpdir(),
    `aletheia-retrieval-eval-${Date.now()}`,
  );
  rmSync(dataDir, { recursive: true, force: true });

  process.env.ALETHEIA_STORAGE_DRIVER = "local";
  process.env.ALETHEIA_AUTH_MODE = "single_user";
  process.env.ALETHEIA_DATA_DIR = dataDir;
  process.env.ALETHEIA_LOCAL_USER_ID = "local-user";
  process.env.ALETHEIA_LOCAL_USER_EMAIL = "local@aletheia.internal";
  delete process.env.ALETHEIA_SEMANTIC_INDEX_ENABLED;
  delete process.env.ALETHEIA_SEMANTIC_INDEX_DRIVER;
  delete process.env.ALETHEIA_RETRIEVAL_MODE;

  const ctx: AletheiaUserContext = {
    userId: "local-user",
    userEmail: "local@aletheia.internal",
  };
  const repo = createAletheiaRepository();

  const alpha = await createMatterWithDocument({
    ctx,
    repo,
    title: "Retrieval Eval Alpha Contract",
    filename: "alpha-termination-agreement.txt",
    body: [
      "Alpha agreement source.",
      "The termination clause requires thirty days notice before cancellation.",
      "The indemnity covenant survives closing and remains enforceable.",
    ].join("\n"),
  });
  const beta = await createMatterWithDocument({
    ctx,
    repo,
    title: "Retrieval Eval Beta Privacy Matter",
    filename: "beta-privacy-addendum.txt",
    body: [
      "Beta privacy addendum source.",
      "Security incidents require breach notification within seventy two hours.",
      "Customer data retention is capped at twenty four months.",
    ].join("\n"),
  });

  let failClosedPassed = false;
  try {
    await repo.searchMatterDocuments(ctx, alpha.matter.id, {
      query: "termination notice",
      mode: "semantic",
    });
  } catch (error) {
    failClosedPassed = error instanceof CapabilityNotAvailableError;
  }

  process.env.ALETHEIA_SEMANTIC_INDEX_ENABLED = "true";
  process.env.ALETHEIA_SEMANTIC_INDEX_DRIVER = "local-json";

  const cases: EvalCase[] = [
    {
      id: "keyword-alpha-termination",
      matterId: alpha.matter.id,
      mode: "keyword",
      query: "termination notice",
      expectedDocument: "alpha-termination-agreement.txt",
      expectedFound: true,
    },
    {
      id: "keyword-beta-breach",
      matterId: beta.matter.id,
      mode: "keyword",
      query: "breach notification",
      expectedDocument: "beta-privacy-addendum.txt",
      expectedFound: true,
    },
    {
      id: "semantic-alpha-notice",
      matterId: alpha.matter.id,
      mode: "semantic",
      query: "notice termination cancellation",
      expectedDocument: "alpha-termination-agreement.txt",
      expectedFound: true,
    },
    {
      id: "hybrid-beta-incident",
      matterId: beta.matter.id,
      mode: "hybrid",
      query: "security incident breach notification",
      expectedDocument: "beta-privacy-addendum.txt",
      expectedFound: true,
    },
    {
      id: "isolation-alpha-cannot-see-beta",
      matterId: alpha.matter.id,
      mode: "keyword",
      query: "breach notification",
      expectedDocument: null,
      expectedFound: false,
    },
  ];

  const results = await Promise.all(
    cases.map((evalCase) => runEvalCase(repo, ctx, evalCase)),
  );
  const failed = results.filter((result) => !result.passed);
  const output = {
    ok: failClosedPassed && failed.length === 0,
    suite: "aletheia-retrieval-eval-v0",
    dataDir,
    cases: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: failed.length,
    failClosedPassed,
    semanticDriver: "local-json",
    coverage: [
      "fail-closed semantic policy",
      "matter-scoped search",
      "cross-matter isolation",
      "retrieval diagnostics",
    ],
    matters: {
      alpha: alpha.matter.id,
      beta: beta.matter.id,
    },
    results,
  };
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) process.exit(1);
}

main().catch((error) => {
  console.error("[aletheia-retrieval-eval] failed", error);
  process.exit(1);
});
