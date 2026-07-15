import { Buffer } from "node:buffer";
import { z } from "zod";

export const DOCUMENT_CHUNK_OCR_METADATA_SCHEMA_VERSION =
  "vera-document-chunk-ocr-v1" as const;
export const DOCUMENT_CHUNK_OCR_LOW_CONFIDENCE_THRESHOLD = 0.5;
export const MAX_DOCUMENT_CHUNK_METADATA_BYTES = 128 * 1024;
export const MAX_DOCUMENT_CHUNK_OCR_BLOCKS = 768;
export const MAX_DOCUMENT_CHUNK_OCR_PAGE_OFFSET = 10_000_000;
export const MIN_DOCUMENT_CHUNK_OCR_PAGE_OFFSET = -64;

const UnitIntervalSchema = z.number().finite().min(0).max(1);

export const DocumentChunkOcrBoundingBoxSchema = z
  .object({
    x: UnitIntervalSchema,
    y: UnitIntervalSchema,
    width: UnitIntervalSchema,
    height: UnitIntervalSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.x + value.width > 1.000_001) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["width"],
        message: "OCR bounding box exceeds the normalized page width",
      });
    }
    if (value.y + value.height > 1.000_001) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["height"],
        message: "OCR bounding box exceeds the normalized page height",
      });
    }
  });

export const DocumentChunkOcrBlockSchema = z
  .object({
    textStart: z.number().int().min(0).max(MAX_DOCUMENT_CHUNK_OCR_PAGE_OFFSET),
    textEnd: z.number().int().min(1).max(MAX_DOCUMENT_CHUNK_OCR_PAGE_OFFSET),
    confidence: UnitIntervalSchema,
    boundingBox: DocumentChunkOcrBoundingBoxSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.textEnd <= value.textStart) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["textEnd"],
        message: "OCR block text range must be non-empty",
      });
    }
  });

export const DocumentChunkOcrMetadataSchema = z
  .object({
    schemaVersion: z.literal(DOCUMENT_CHUNK_OCR_METADATA_SCHEMA_VERSION),
    engine: z.literal("apple-vision"),
    coordinateSpace: z.literal("normalized-top-left").nullable(),
    page: z.number().int().min(1).max(500),
    chunkPageTextStart: z
      .number()
      .int()
      .min(MIN_DOCUMENT_CHUNK_OCR_PAGE_OFFSET)
      .max(MAX_DOCUMENT_CHUNK_OCR_PAGE_OFFSET),
    pageConfidence: UnitIntervalSchema,
    lowConfidence: z.boolean(),
    blocks: z
      .array(DocumentChunkOcrBlockSchema)
      .max(MAX_DOCUMENT_CHUNK_OCR_BLOCKS),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.lowConfidence !==
      value.pageConfidence < DOCUMENT_CHUNK_OCR_LOW_CONFIDENCE_THRESHOLD
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lowConfidence"],
        message: "OCR low-confidence marker does not match page confidence",
      });
    }
    if (value.coordinateSpace === null && value.blocks.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocks"],
        message: "OCR blocks require a declared coordinate space",
      });
    }
    for (let index = 1; index < value.blocks.length; index += 1) {
      if (value.blocks[index]!.textStart < value.blocks[index - 1]!.textEnd) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["blocks", index, "textStart"],
          message: "OCR block text ranges must be ordered and non-overlapping",
        });
        break;
      }
    }
  });

export const EmptyDocumentChunkMetadataSchema = z.object({}).strict();

export const DocumentChunkMetadataSchema = z.union([
  EmptyDocumentChunkMetadataSchema,
  DocumentChunkOcrMetadataSchema,
]);

export type DocumentChunkOcrMetadata = Readonly<
  z.infer<typeof DocumentChunkOcrMetadataSchema>
>;
export type DocumentChunkMetadata = Readonly<
  z.infer<typeof DocumentChunkMetadataSchema>
>;

function metadataError(): Error {
  return new Error("Workspace document chunk metadata is invalid.");
}

export function parseDocumentChunkMetadata(
  value: unknown,
): DocumentChunkMetadata {
  const parsed = DocumentChunkMetadataSchema.safeParse(value);
  if (!parsed.success) throw metadataError();
  const serialized = JSON.stringify(parsed.data);
  if (
    Buffer.byteLength(serialized, "utf8") > MAX_DOCUMENT_CHUNK_METADATA_BYTES
  ) {
    throw metadataError();
  }
  return parsed.data;
}

export function serializeDocumentChunkMetadata(value: unknown): string {
  return JSON.stringify(parseDocumentChunkMetadata(value));
}

export function parseDocumentChunkMetadataJson(
  value: unknown,
): DocumentChunkMetadata {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_DOCUMENT_CHUNK_METADATA_BYTES
  ) {
    throw metadataError();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw metadataError();
  }
  return parseDocumentChunkMetadata(decoded);
}

export function assertDocumentChunkMetadataPageBinding(
  metadata: DocumentChunkMetadata,
  pageStart: number | null,
  pageEnd: number | null,
  chunkText: string,
): void {
  if (!("schemaVersion" in metadata)) return;
  if (
    pageStart === null ||
    pageEnd === null ||
    pageStart !== pageEnd ||
    metadata.page !== pageStart
  ) {
    throw metadataError();
  }
  const chunkPageTextEnd = metadata.chunkPageTextStart + chunkText.length;
  if (
    chunkPageTextEnd < metadata.chunkPageTextStart ||
    chunkPageTextEnd > MAX_DOCUMENT_CHUNK_OCR_PAGE_OFFSET ||
    metadata.blocks.some(
      (block) =>
        block.textEnd <= metadata.chunkPageTextStart ||
        block.textStart >= chunkPageTextEnd,
    )
  ) {
    throw metadataError();
  }
}
