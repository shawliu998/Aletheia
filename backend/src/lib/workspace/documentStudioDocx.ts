import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  LevelSuffix,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
} from "docx";
import { lexer, type Token, type Tokens } from "marked";

import {
  DEFAULT_DOCX_MAX_INPUT_BYTES,
  DocxPackageSafetyError,
  inspectDocxPackage,
} from "../docxPackageSafety";

export const DOCUMENT_STUDIO_DOCX_MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const DOCUMENT_STUDIO_MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
export const DOCUMENT_STUDIO_MAX_DOCX_BYTES = DEFAULT_DOCX_MAX_INPUT_BYTES;

const MAX_MARKDOWN_CODE_POINTS = 2_000_000;
const MAX_MARKDOWN_TOKENS = 100_000;
const MAX_MARKDOWN_NESTING = 32;
const MAX_RENDERED_NODES = 40_000;
const MAX_TABLE_CELLS = 15_000;
const MAX_TITLE_CODE_POINTS = 240;
const FONT = "Times New Roman";
const FONT_SIZE = 22;
const LEGAL_NUMBERING_REFERENCE = "vera-legal-clause-numbering";
const ORDERED_LIST_REFERENCE = "vera-ordered-list";
const BULLET_LIST_REFERENCE = "vera-bullet-list";

export type DocumentStudioDocxErrorCode =
  | "MARKDOWN_INVALID"
  | "MARKDOWN_TOO_LARGE"
  | "MARKDOWN_TOO_COMPLEX"
  | "DOCX_INVALID"
  | "DOCX_TOO_LARGE"
  | "DOCX_UNSAFE_PATH"
  | "DOCX_ACTIVE_CONTENT"
  | "DOCX_EXTERNAL_RELATIONSHIP"
  | "DOCX_TRACKED_CHANGES"
  | "DOCX_CONVERSION_FAILED";

export class DocumentStudioDocxError extends Error {
  constructor(
    message: string,
    readonly code: DocumentStudioDocxErrorCode,
  ) {
    super(message);
    this.name = "DocumentStudioDocxError";
  }
}

export type DocumentStudioDocxWarning = {
  code:
    | "DOCX_IMAGES_IGNORED"
    | "DOCX_FORMATTING_SIMPLIFIED"
    | "DOCX_CONVERTER_WARNING"
    | "MARKDOWN_IMAGES_OMITTED"
    | "MARKDOWN_HTML_AS_TEXT"
    | "MARKDOWN_BLOCKQUOTE_SIMPLIFIED";
  message: string;
};

export type ExportDocumentStudioDocxResult = {
  bytes: Buffer;
  mimeType: typeof DOCUMENT_STUDIO_DOCX_MIME_TYPE;
  warnings: DocumentStudioDocxWarning[];
};

export type ImportDocumentStudioDocxResult = {
  markdown: string;
  warnings: DocumentStudioDocxWarning[];
};

function fail(code: DocumentStudioDocxErrorCode, message: string): never {
  throw new DocumentStudioDocxError(message, code);
}

function exceedsCodePoints(value: string, limit: number): boolean {
  let count = 0;
  for (const _point of value) {
    count += 1;
    if (count > limit) return true;
  }
  return false;
}

function validateTitle(value: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    exceedsCodePoints(value, MAX_TITLE_CODE_POINTS) ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    fail("MARKDOWN_INVALID", "Document title is invalid.");
  }
  return value.trim();
}

function validateMarkdown(value: string): string {
  if (typeof value !== "string") {
    fail("MARKDOWN_INVALID", "Studio Markdown must be a string.");
  }
  if (Buffer.byteLength(value, "utf8") > DOCUMENT_STUDIO_MAX_MARKDOWN_BYTES) {
    fail("MARKDOWN_TOO_LARGE", "Studio Markdown exceeds the 4 MB limit.");
  }
  if (exceedsCodePoints(value, MAX_MARKDOWN_CODE_POINTS)) {
    fail("MARKDOWN_TOO_LARGE", "Studio Markdown exceeds the 4 MB limit.");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    fail("MARKDOWN_INVALID", "Studio Markdown contains unsupported controls.");
  }
  return value;
}

function dedupeWarnings(
  warnings: readonly DocumentStudioDocxWarning[],
): DocumentStudioDocxWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    if (seen.has(warning.code)) return false;
    seen.add(warning.code);
    return true;
  });
}

type RenderState = {
  warnings: DocumentStudioDocxWarning[];
  visitedTokens: number;
  renderedNodes: number;
};

function visitToken(state: RenderState, depth: number): void {
  state.visitedTokens += 1;
  if (
    state.visitedTokens > MAX_MARKDOWN_TOKENS ||
    depth > MAX_MARKDOWN_NESTING
  ) {
    fail("MARKDOWN_TOO_COMPLEX", "Studio Markdown is too complex to export.");
  }
}

function consumeRenderedNodes(state: RenderState, count = 1): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    fail("MARKDOWN_TOO_COMPLEX", "Studio Markdown render size is invalid.");
  }
  state.renderedNodes += count;
  if (state.renderedNodes > MAX_RENDERED_NODES) {
    fail(
      "MARKDOWN_TOO_COMPLEX",
      "Studio Markdown renders too many DOCX nodes.",
    );
  }
}

type InlineStyle = {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  font?: string;
  underline?: { type: typeof UnderlineType.SINGLE };
  color?: string;
};

function textRun(text: string, style: InlineStyle = {}): TextRun {
  return new TextRun({ text, font: FONT, size: FONT_SIZE, ...style });
}

function tokenChildren(token: Token): Token[] {
  const children = (token as unknown as { tokens?: unknown }).tokens;
  return Array.isArray(children) ? (children as Token[]) : [];
}

function tokenText(token: Token): string {
  const text = (token as unknown as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function inlineRuns(
  tokens: readonly Token[],
  state: RenderState,
  depth: number,
  style: InlineStyle = {},
): TextRun[] {
  const runs: TextRun[] = [];
  for (const token of tokens) {
    visitToken(state, depth);
    consumeRenderedNodes(state);
    switch (token.type) {
      case "strong":
        runs.push(
          ...inlineRuns(tokenChildren(token), state, depth + 1, {
            ...style,
            bold: true,
          }),
        );
        break;
      case "em":
        runs.push(
          ...inlineRuns(tokenChildren(token), state, depth + 1, {
            ...style,
            italics: true,
          }),
        );
        break;
      case "del":
        runs.push(
          ...inlineRuns(tokenChildren(token), state, depth + 1, {
            ...style,
            strike: true,
          }),
        );
        break;
      case "codespan":
        runs.push(textRun(tokenText(token), { ...style, font: "Courier New" }));
        break;
      case "br":
        runs.push(
          new TextRun({ break: 1, font: FONT, size: FONT_SIZE, ...style }),
        );
        break;
      case "link": {
        const link = token as Tokens.Link;
        runs.push(
          ...inlineRuns(tokenChildren(token), state, depth + 1, {
            ...style,
            color: "1F4E79",
            underline: { type: UnderlineType.SINGLE },
          }),
        );
        const label = link.text.trim();
        if (link.href && link.href !== label) {
          consumeRenderedNodes(state);
          runs.push(textRun(` (${link.href})`, style));
        }
        break;
      }
      case "image":
        const image = token as Tokens.Image;
        state.warnings.push({
          code: "MARKDOWN_IMAGES_OMITTED",
          message:
            "Markdown images are represented by alt text only in DOCX export.",
        });
        runs.push(
          textRun(
            `[Image omitted${image.text ? `: ${image.text}` : ""}]`,
            style,
          ),
        );
        break;
      case "html":
        state.warnings.push({
          code: "MARKDOWN_HTML_AS_TEXT",
          message: "Raw Markdown HTML is exported as inert text.",
        });
        runs.push(textRun(tokenText(token), style));
        break;
      case "escape":
      case "text": {
        const nested = tokenChildren(token);
        if (nested?.length) {
          runs.push(...inlineRuns(nested, state, depth + 1, style));
        } else {
          runs.push(textRun(tokenText(token), style));
        }
        break;
      }
      default: {
        const generic = token as Tokens.Generic;
        if (generic.tokens?.length) {
          runs.push(...inlineRuns(generic.tokens, state, depth + 1, style));
        } else if (tokenText(token)) {
          runs.push(textRun(tokenText(token), style));
        }
      }
    }
  }
  return runs;
}

function tableBorder() {
  return {
    top: { style: BorderStyle.SINGLE, size: 1, color: "B7B7B7" },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: "B7B7B7" },
    left: { style: BorderStyle.SINGLE, size: 1, color: "B7B7B7" },
    right: { style: BorderStyle.SINGLE, size: 1, color: "B7B7B7" },
  };
}

function tableCell(
  cell: Tokens.TableCell,
  state: RenderState,
  header: boolean,
): TableCell {
  return new TableCell({
    borders: tableBorder(),
    ...(header ? { shading: { fill: "F2F2F2" } } : {}),
    children: [
      new Paragraph({
        children: inlineRuns(cell.tokens, state, 1, { bold: header }),
      }),
    ],
  });
}

type DocChild = Paragraph | Table;

function renderList(
  token: Tokens.List,
  state: RenderState,
  depth: number,
  output: DocChild[],
): void {
  visitToken(state, depth);
  const level = Math.min(depth, 4);
  for (const item of token.items) {
    visitToken(state, depth + 1);
    consumeRenderedNodes(state);
    const inline: Token[] = [];
    const nested: Tokens.List[] = [];
    for (const itemToken of item.tokens) {
      if (itemToken.type === "list") nested.push(itemToken as Tokens.List);
      else if (itemToken.type === "paragraph" || itemToken.type === "text") {
        const children = tokenChildren(itemToken);
        inline.push(...(children.length ? children : [itemToken]));
      } else {
        inline.push(itemToken);
      }
    }
    const prefix = item.task ? `${item.checked ? "☒" : "☐"} ` : "";
    if (prefix) consumeRenderedNodes(state);
    output.push(
      new Paragraph({
        numbering: {
          reference: token.ordered
            ? ORDERED_LIST_REFERENCE
            : BULLET_LIST_REFERENCE,
          level,
        },
        spacing: { after: 80 },
        children: [
          ...(prefix ? [textRun(prefix)] : []),
          ...inlineRuns(inline, state, depth + 1),
        ],
      }),
    );
    for (const child of nested) {
      renderList(child, state, depth + 1, output);
    }
  }
}

function renderBlocks(
  tokens: readonly Token[],
  state: RenderState,
  depth = 0,
): DocChild[] {
  const output: DocChild[] = [];
  for (const token of tokens) {
    visitToken(state, depth);
    switch (token.type) {
      case "space":
      case "def":
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        const headingLevels = [
          HeadingLevel.HEADING_1,
          HeadingLevel.HEADING_2,
          HeadingLevel.HEADING_3,
          HeadingLevel.HEADING_4,
          HeadingLevel.HEADING_5,
          HeadingLevel.HEADING_6,
        ] as const;
        const headingIndex = Math.max(0, Math.min(heading.depth - 1, 5));
        consumeRenderedNodes(state);
        output.push(
          new Paragraph({
            heading: headingLevels[headingIndex],
            numbering:
              headingIndex <= 3
                ? {
                    reference: LEGAL_NUMBERING_REFERENCE,
                    level: headingIndex,
                  }
                : undefined,
            spacing: { before: 160, after: 100 },
            children: inlineRuns(heading.tokens, state, depth + 1, {
              bold: true,
            }),
          }),
        );
        break;
      }
      case "paragraph":
      case "text": {
        const children = tokenChildren(token);
        const inline = children.length ? children : [token];
        consumeRenderedNodes(state);
        output.push(
          new Paragraph({
            spacing: { after: 120 },
            children: inlineRuns(inline, state, depth + 1),
          }),
        );
        break;
      }
      case "list":
        renderList(token as Tokens.List, state, depth, output);
        break;
      case "table": {
        const table = token as Tokens.Table;
        const tableCells = table.header.length * (table.rows.length + 1);
        if (table.header.length > 50 || table.rows.length > 10_000) {
          fail(
            "MARKDOWN_TOO_COMPLEX",
            "Markdown table is too large to export.",
          );
        }
        if (tableCells > MAX_TABLE_CELLS) {
          fail(
            "MARKDOWN_TOO_COMPLEX",
            "Markdown table contains too many cells to export.",
          );
        }
        consumeRenderedNodes(state, tableCells + table.rows.length + 3);
        const rows = [
          new TableRow({
            tableHeader: true,
            children: table.header.map((cell) => tableCell(cell, state, true)),
          }),
          ...table.rows.map(
            (row) =>
              new TableRow({
                children: table.header.map((_, index) =>
                  tableCell(
                    row[index] ?? { text: "", tokens: [] },
                    state,
                    false,
                  ),
                ),
              }),
          ),
        ];
        output.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows,
          }),
          new Paragraph({ text: "" }),
        );
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        let lineCount = 1;
        for (const character of code.text) {
          if (character === "\n") lineCount += 1;
        }
        consumeRenderedNodes(state, lineCount);
        output.push(
          ...code.text.split("\n").map(
            (line) =>
              new Paragraph({
                spacing: { after: 40 },
                indent: { left: 360 },
                children: [textRun(line, { font: "Courier New" })],
              }),
          ),
        );
        break;
      }
      case "blockquote": {
        const blockquote = token as Tokens.Blockquote;
        const children = renderBlocks(blockquote.tokens, state, depth + 1);
        state.warnings.push({
          code: "MARKDOWN_BLOCKQUOTE_SIMPLIFIED",
          message:
            "Blockquote content is preserved, but its indentation may be simplified in DOCX export.",
        });
        consumeRenderedNodes(state);
        output.push(
          new Paragraph({
            indent: { left: 720 },
            spacing: { after: 60 },
            children: [
              textRun("Quoted content", { bold: true, italics: true }),
            ],
          }),
          ...children,
        );
        break;
      }
      case "hr":
        consumeRenderedNodes(state);
        output.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 80, after: 80 },
            children: [textRun("────────────────────────")],
          }),
        );
        break;
      case "html":
        state.warnings.push({
          code: "MARKDOWN_HTML_AS_TEXT",
          message: "Raw Markdown HTML is exported as inert text.",
        });
        consumeRenderedNodes(state);
        output.push(
          new Paragraph({
            spacing: { after: 120 },
            children: [textRun(token.text)],
          }),
        );
        break;
      default:
        if ("tokens" in token && Array.isArray(token.tokens)) {
          output.push(...renderBlocks(token.tokens, state, depth + 1));
        }
    }
  }
  return output;
}

const legalNumberingLevels = [
  { level: 0, format: LevelFormat.DECIMAL, text: "%1." },
  { level: 1, format: LevelFormat.DECIMAL, text: "%1.%2" },
  { level: 2, format: LevelFormat.LOWER_LETTER, text: "(%3)" },
  { level: 3, format: LevelFormat.LOWER_ROMAN, text: "(%4)" },
].map((level) => ({
  ...level,
  alignment: AlignmentType.START,
  suffix: LevelSuffix.TAB,
  style: {
    paragraph: {
      indent: {
        left: level.level < 2 ? 720 : 1440,
        hanging: 720,
      },
    },
    run: { font: FONT, size: FONT_SIZE, bold: level.level === 0 },
  },
}));

function listNumberingLevels(ordered: boolean) {
  return Array.from({ length: 5 }, (_, level) => ({
    level,
    format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
    text: ordered ? `%${level + 1}.` : level % 2 === 0 ? "•" : "◦",
    alignment: AlignmentType.START,
    suffix: LevelSuffix.TAB,
    style: {
      paragraph: {
        indent: { left: 720 * (level + 1), hanging: 360 },
      },
      run: { font: FONT, size: FONT_SIZE },
    },
  }));
}

function mapSafetyError(error: DocxPackageSafetyError): never {
  const code =
    error.code === "DOCX_REQUIRED_PART_MISSING" ? "DOCX_INVALID" : error.code;
  return fail(code, error.message);
}

export async function exportDocumentStudioMarkdownToDocx(input: {
  title: string;
  markdown: string;
}): Promise<ExportDocumentStudioDocxResult> {
  const title = validateTitle(input.title);
  const markdown = validateMarkdown(input.markdown);
  const state: RenderState = {
    warnings: [],
    visitedTokens: 0,
    renderedNodes: 1,
  };
  let tokens: Token[];
  try {
    tokens = lexer(markdown, { gfm: true, breaks: false });
  } catch {
    return fail("MARKDOWN_INVALID", "Studio Markdown could not be parsed.");
  }
  const children: DocChild[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [textRun(title.toUpperCase(), { bold: true })],
    }),
    ...renderBlocks(tokens, state),
  ];
  const document = new Document({
    creator: "Vera",
    title,
    description: "Vera Document Studio export",
    numbering: {
      config: [
        {
          reference: LEGAL_NUMBERING_REFERENCE,
          levels: legalNumberingLevels,
        },
        {
          reference: ORDERED_LIST_REFERENCE,
          levels: listNumberingLevels(true),
        },
        {
          reference: BULLET_LIST_REFERENCE,
          levels: listNumberingLevels(false),
        },
      ],
    },
    styles: {
      default: {
        document: { run: { font: FONT, size: FONT_SIZE } },
        title: { run: { font: FONT, size: FONT_SIZE, bold: true } },
        heading1: { run: { font: FONT, size: FONT_SIZE, bold: true } },
        heading2: { run: { font: FONT, size: FONT_SIZE, bold: true } },
        heading3: { run: { font: FONT, size: FONT_SIZE, bold: true } },
        heading4: { run: { font: FONT, size: FONT_SIZE, bold: true } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: { top: 1_440, right: 1_440, bottom: 1_440, left: 1_440 },
          },
        },
        children,
      },
    ],
  });
  let bytes: Buffer;
  try {
    bytes = await Packer.toBuffer(document);
  } catch {
    return fail("DOCX_CONVERSION_FAILED", "DOCX export failed.");
  }
  if (bytes.byteLength > DOCUMENT_STUDIO_MAX_DOCX_BYTES) {
    fail("DOCX_TOO_LARGE", "Generated DOCX exceeds the 10 MB limit.");
  }
  try {
    inspectDocxPackage(bytes, { drawingPolicy: "reject" });
  } catch (error) {
    if (error instanceof DocxPackageSafetyError) mapSafetyError(error);
    throw error;
  }
  return {
    bytes,
    mimeType: DOCUMENT_STUDIO_DOCX_MIME_TYPE,
    warnings: dedupeWarnings(state.warnings),
  };
}

export async function importDocumentStudioDocxToMarkdown(input: {
  bytes: Buffer;
}): Promise<ImportDocumentStudioDocxResult> {
  let packageWarnings: ReturnType<typeof inspectDocxPackage>["warnings"];
  try {
    packageWarnings = inspectDocxPackage(input.bytes, {
      drawingPolicy: "warn",
    }).warnings;
  } catch (error) {
    if (error instanceof DocxPackageSafetyError) mapSafetyError(error);
    throw error;
  }

  const mammoth = await import("mammoth");
  let result: { value: string; messages: Array<{ message: string }> };
  try {
    const convertToMarkdown = (
      mammoth as unknown as {
        convertToMarkdown: (
          source: { buffer: Buffer },
          options: Record<string, unknown>,
        ) => Promise<typeof result>;
      }
    ).convertToMarkdown;
    result = await convertToMarkdown(
      { buffer: input.bytes },
      {
        externalFileAccess: false,
        includeEmbeddedStyleMap: false,
        convertImage: async () => [],
      },
    );
  } catch {
    return fail(
      "DOCX_CONVERSION_FAILED",
      "DOCX could not be converted to Markdown.",
    );
  }
  const markdown = validateMarkdown(result.value);
  const warnings: DocumentStudioDocxWarning[] = [
    {
      code: "DOCX_FORMATTING_SIMPLIFIED",
      message:
        "DOCX formatting outside supported headings, lists, tables, and text may be simplified.",
    },
    ...packageWarnings.map(
      (warning) =>
        ({
          code: warning.code,
          message: warning.message,
        }) as DocumentStudioDocxWarning,
    ),
    ...result.messages.slice(0, 20).map((message) => ({
      code: "DOCX_CONVERTER_WARNING" as const,
      message: String(message.message).slice(0, 500),
    })),
  ];
  return { markdown, warnings: dedupeWarnings(warnings) };
}
