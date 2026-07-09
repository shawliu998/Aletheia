import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import ExcelJS from "exceljs";
import type { createServerSupabase } from "./supabase";
import { docxToPdf, convertedPdfKey } from "./convert";
import { generatedDocKey, uploadFile } from "./storage";

type Supa = ReturnType<typeof createServerSupabase>;

export type GeneratedOfficeKind = "docx" | "xlsx";

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function normalizeGeneratedOfficeTitle(
  value: unknown,
  fallback: string,
): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value
    .trim()
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .slice(0, 120);
  return trimmed || fallback;
}

export async function createGeneratedOfficeDocument(args: {
  db: Supa;
  userId: string;
  projectId: string | null;
  kind: GeneratedOfficeKind;
  title: string;
}) {
  const filename = ensureExtension(args.title, args.kind);
  const bytes =
    args.kind === "docx"
      ? await createDocxBuffer(args.title)
      : await createXlsxBuffer(args.title);

  const { data: doc, error: docErr } = await args.db
    .from("documents")
    .insert({
      project_id: args.projectId,
      user_id: args.userId,
      status: "processing",
    })
    .select("*")
    .single();
  if (docErr || !doc) {
    throw new Error(
      `Failed to create document record: ${docErr?.message ?? "unknown"}`,
    );
  }

  const docId = doc.id as string;
  const key = generatedDocKey(args.userId, docId, filename);
  const contentType = args.kind === "docx" ? DOCX_MIME : XLSX_MIME;
  let pdfStoragePath: string | null = null;

  try {
    await uploadFile(key, toArrayBuffer(bytes), contentType);

    if (args.kind === "docx") {
      try {
        const pdfBuf = await docxToPdf(bytes);
        const pdfKey = convertedPdfKey(args.userId, docId);
        await uploadFile(pdfKey, toArrayBuffer(pdfBuf), "application/pdf");
        pdfStoragePath = pdfKey;
      } catch (err) {
        console.error(`[generated-office] DOCX→PDF conversion failed:`, err);
      }
    }

    const { data: versionRow, error: verErr } = await args.db
      .from("document_versions")
      .insert({
        document_id: docId,
        storage_path: key,
        pdf_storage_path: pdfStoragePath,
        source: "generated",
        version_number: 1,
        filename,
        file_type: args.kind,
        size_bytes: bytes.byteLength,
        page_count: null,
      })
      .select("id")
      .single();
    if (verErr || !versionRow) {
      throw new Error(
        `Failed to record generated version: ${verErr?.message ?? "unknown"}`,
      );
    }

    const { data: updated, error: updateErr } = await args.db
      .from("documents")
      .update({
        current_version_id: versionRow.id,
        status: "ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", docId)
      .select("*")
      .single();
    if (updateErr || !updated) {
      throw new Error(
        `Failed to finalize generated document: ${
          updateErr?.message ?? "unknown"
        }`,
      );
    }

    return {
      ...updated,
      filename,
      storage_path: key,
      pdf_storage_path: pdfStoragePath,
      file_type: args.kind,
      size_bytes: bytes.byteLength,
      page_count: null,
      active_version_number: 1,
    };
  } catch (err) {
    await args.db.from("documents").update({ status: "error" }).eq("id", docId);
    throw err;
  }
}

async function createDocxBuffer(title: string): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            spacing: { after: 240 },
            children: [new TextRun(title)],
          }),
          new Paragraph({
            children: [new TextRun("")],
          }),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

async function createXlsxBuffer(title: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Aletheia";
  workbook.created = new Date();
  workbook.modified = new Date();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.columns = [
    { header: title, key: "title", width: Math.max(18, title.length + 4) },
  ];
  sheet.getCell("A1").font = { bold: true };
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function ensureExtension(title: string, kind: GeneratedOfficeKind): string {
  const clean = title
    .replace(/[\\/]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const fallback = kind === "docx" ? "Untitled document" : "Untitled workbook";
  const base = clean || fallback;
  const withoutOfficeExt = base.replace(/\.(docx|xlsx)$/i, "");
  return `${withoutOfficeExt}.${kind}`;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}
