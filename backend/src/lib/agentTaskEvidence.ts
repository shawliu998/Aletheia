import { extractDocxBodyText } from "./docxTrackedChanges";
import { isSpreadsheetDocumentType } from "./documentTypes";
import { extractPdfText } from "./chat/tools/documentOps";
import { spreadsheetToLLMText } from "./spreadsheet";
import { downloadFile } from "./storage";
import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type AgentEvidenceStatus =
  | "exact"
  | "drifted"
  | "missing"
  | "version_mismatch";

type CitationQuote = {
  page: number | string | null;
  quote: string;
  sheet: string | null;
  cell: string | null;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function citationQuotes(row: Record<string, unknown>): CitationQuote[] {
  const nested = Array.isArray(row.quotes) ? row.quotes : [];
  const quotes = nested.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const quote = entry as Record<string, unknown>;
    return [
      {
        page:
          typeof quote.page === "number" || typeof quote.page === "string"
            ? quote.page
            : null,
        quote: text(quote.quote),
        sheet: text(quote.sheet) || null,
        cell: text(quote.cell) || null,
      },
    ];
  });
  if (quotes.length) return quotes;
  return [
    {
      page:
        typeof row.page === "number" || typeof row.page === "string"
          ? row.page
          : null,
      quote: text(row.quote),
      sheet: text(row.sheet) || null,
      cell: text(row.cell) || null,
    },
  ];
}

async function extractVersionText(version: {
  storage_path: string | null;
  file_type: string | null;
}) {
  if (!version.storage_path) return null;
  const raw = await downloadFile(version.storage_path);
  if (!raw) return null;
  const fileType = (version.file_type ?? "").toLowerCase();
  if (fileType === "pdf") return extractPdfText(raw);
  if (fileType === "docx" || fileType === "doc") {
    return extractDocxBodyText(Buffer.from(raw));
  }
  if (isSpreadsheetDocumentType(fileType)) {
    return spreadsheetToLLMText(Buffer.from(raw));
  }
  return null;
}

export async function getAgentTaskEvidence(
  db: Db,
  input: {
    taskId: string;
    userId: string;
    artifactId: string;
  },
) {
  const { data: task } = await db
    .from("agent_tasks")
    .select("id")
    .eq("id", input.taskId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (!task) return null;

  const { data: artifact } = await db
    .from("agent_artifact_links")
    .select("artifact_id")
    .eq("task_id", input.taskId)
    .eq("artifact_type", "citation_snapshot")
    .eq("artifact_id", input.artifactId)
    .maybeSingle();
  if (!artifact) return null;

  const [{ data: message, error: messageError }, { data: linkedDocuments }] =
    await Promise.all([
      db
        .from("chat_messages")
        .select("id,citations")
        .eq("id", input.artifactId)
        .maybeSingle(),
      db
        .from("agent_artifact_links")
        .select("artifact_id,artifact_type")
        .eq("task_id", input.taskId)
        .in("artifact_type", ["document", "draft", "tabular_review"]),
    ]);
  if (messageError) throw new Error(messageError.message);
  if (!message) return null;

  const rawCitations = Array.isArray(message.citations)
    ? message.citations
    : [];
  const allowedDocumentIds = new Set(
    (linkedDocuments ?? []).map((source) => source.artifact_id as string),
  );
  const documentIds = Array.from(
    new Set(
      rawCitations.flatMap((citation) => {
        if (!citation || typeof citation !== "object") return [];
        const documentId = text(
          (citation as Record<string, unknown>).document_id,
        );
        return documentId ? [documentId] : [];
      }),
    ),
  );
  const versionIds = Array.from(
    new Set(
      rawCitations.flatMap((citation) => {
        if (!citation || typeof citation !== "object") return [];
        const versionId = text(
          (citation as Record<string, unknown>).version_id,
        );
        return versionId ? [versionId] : [];
      }),
    ),
  );

  const [{ data: documents }, { data: versions }] = await Promise.all([
    documentIds.length
      ? db
          .from("documents")
          .select("id,current_version_id")
          .in("id", documentIds)
          .eq("user_id", input.userId)
      : Promise.resolve({ data: [] }),
    versionIds.length
      ? db
          .from("document_versions")
          .select(
            "id,document_id,storage_path,version_number,filename,file_type,deleted_at",
          )
          .in("id", versionIds)
      : Promise.resolve({ data: [] }),
  ]);
  const documentById = new Map(
    (documents ?? []).map((document) => [document.id as string, document]),
  );
  const versionById = new Map(
    (versions ?? []).map((version) => [version.id as string, version]),
  );
  const extractedByVersion = new Map<string, Promise<string | null>>();

  const citations = [];
  for (const [citationIndex, rawCitation] of rawCitations.entries()) {
    const row =
      rawCitation && typeof rawCitation === "object"
        ? (rawCitation as Record<string, unknown>)
        : {};
    const documentId = text(row.document_id) || null;
    const versionId = text(row.version_id) || null;
    const document = documentId ? documentById.get(documentId) : null;
    const version = versionId ? versionById.get(versionId) : null;
    const quotes = citationQuotes(row);

    for (const [quoteIndex, quote] of quotes.entries()) {
      let status: AgentEvidenceStatus = "missing";
      let detail = "Citation data or its source is missing.";
      const sourceAllowed = Boolean(
        documentId && allowedDocumentIds.has(documentId),
      );
      const versionAvailable = Boolean(
        document &&
        version &&
        !version.deleted_at &&
        version.document_id === documentId,
      );

      if (sourceAllowed && versionAvailable && quote.quote) {
        const key = versionId as string;
        let extracted = extractedByVersion.get(key);
        if (!extracted) {
          extracted = extractVersionText({
            storage_path: (version?.storage_path as string | null) ?? null,
            file_type:
              (version?.file_type as string | null) ?? null,
          });
          extractedByVersion.set(key, extracted);
        }
        const sourceText = await extracted;
        const anchor = normalize(quote.quote).slice(0, 120);
        const located = Boolean(
          sourceText && anchor && normalize(sourceText).includes(anchor),
        );
        if (!located) {
          status = "drifted";
          detail =
            "Source opened, but the quoted anchor could not be relocated.";
        } else if (document?.current_version_id !== versionId) {
          status = "version_mismatch";
          detail =
            "Located in the cited version; the source now has a newer current version.";
        } else {
          status = "exact";
          detail = "Located in the cited source version.";
        }
      }

      citations.push({
        id: `${input.artifactId}:${citationIndex}:${quoteIndex}`,
        ref: typeof row.ref === "number" ? row.ref : null,
        document_id: documentId,
        version_id: versionId,
        current_version_id:
          (document?.current_version_id as string | null) ?? null,
        version_number: (version?.version_number as number | null) ?? null,
        filename:
          text(version?.filename) || "Source document",
        file_type:
          text(version?.file_type) || null,
        page: quote.page,
        quote: quote.quote,
        sheet: quote.sheet,
        cell: quote.cell,
        status,
        detail,
        openable: Boolean(sourceAllowed && versionAvailable && documentId),
      });
    }
  }

  return { artifact_id: input.artifactId, citations };
}
