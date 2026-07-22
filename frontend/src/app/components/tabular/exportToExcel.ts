"use client";

import ExcelJS from "exceljs";
import type {
    ColumnConfig,
    Document,
    TabularCell,
} from "../shared/types";
import { preprocessCitations, type ParsedCitation } from "./citation-utils";

export const MAX_PROJECT_DOCUMENT_BYTES = 100 * 1024 * 1024;

export type TabularReviewExcelParams = {
    reviewTitle: string;
    columns: ColumnConfig[];
    documents: Document[];
    cells: TabularCell[];
};

export type TabularReviewExcelExport = {
    blob: Blob;
    filename: string;
};

type CitationExportRow = {
    reference: string;
    reviewCell: string;
    sourceDocument: string;
    section: "Summary" | "Reasoning";
    locator: string;
    quote: string;
};

function formatCellForExport(cell: TabularCell | undefined): string {
    if (!cell) return "";
    if (cell.status === "pending" || cell.status === "generating") return "";
    if (cell.status === "error") return "Error";
    const summary = cell.content?.summary;
    if (!summary) return "";
    return removeCitationMarkers(summary);
}

function removeCitationMarkers(value: string): string {
    const { processed } = preprocessCitations(value);
    return processed
        .replace(/§\d+§/g, "")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/[ \t]+/g, " ")
        .trim();
}

function sanitizeFilename(name: string): string {
    return (
        name
            .replace(/[\\/:*?"<>|]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || "Tabular Review"
    );
}

function excelColumnName(columnNumber: number): string {
    let value = columnNumber;
    let name = "";
    while (value > 0) {
        const remainder = (value - 1) % 26;
        name = String.fromCharCode(65 + remainder) + name;
        value = Math.floor((value - 1) / 26);
    }
    return name;
}

function formatLocator(citation: ParsedCitation): string {
    if (citation.sheet && citation.cell) return `${citation.sheet}!${citation.cell}`;
    if (citation.cell) return citation.cell;
    if (citation.sheet) return citation.sheet;
    return citation.page ? `Page ${citation.page}` : "";
}

function collectCellCitations(params: {
    cell: TabularCell | undefined;
    document: Document;
    documentIndex: number;
    columnIndex: number;
}): CitationExportRow[] {
    const { cell, document, documentIndex, columnIndex } = params;
    if (!cell?.content || cell.status !== "done") return [];

    const reviewCell = `${excelColumnName(columnIndex + 2)}${documentIndex + 2}`;
    const citationSections: Array<{
        name: CitationExportRow["section"];
        citationCode: "S" | "R";
        text: string | undefined;
    }> = [
        {
            name: "Summary",
            citationCode: "S",
            text: cell.content.summary,
        },
        {
            name: "Reasoning",
            citationCode: "R",
            text: cell.content.reasoning,
        },
    ];

    return citationSections.flatMap(({ name, citationCode, text }) => {
        const { citations } = preprocessCitations(text ?? "");
        return citations.map((citation, citationIndex) => ({
            // This stays stable for the same review row/column and source section.
            // It deliberately avoids exposing document IDs in a client-facing export.
            reference: `C-${String(documentIndex + 1).padStart(2, "0")}-${String(columnIndex + 1).padStart(2, "0")}-${citationCode}-${String(citationIndex + 1).padStart(2, "0")}`,
            reviewCell,
            sourceDocument: document.filename,
            section: name,
            locator: formatLocator(citation),
            quote: citation.quote,
        }));
    });
}

/**
 * Builds a Matter-ready workbook without initiating a browser download.
 * Keeping construction separate lets the same output be downloaded or stored
 * through the existing project-document upload path.
 */
export async function buildTabularReviewExcel(
    params: TabularReviewExcelParams,
): Promise<TabularReviewExcelExport> {
    const { reviewTitle, columns, documents, cells } = params;
    const sortedCols = [...columns].sort((a, b) => a.index - b.index);
    const cellMap = new Map<string, TabularCell>();
    for (const cell of cells) {
        cellMap.set(`${cell.document_id}:${cell.column_index}`, cell);
    }

    const workbook = new ExcelJS.Workbook();
    const reviewSheet = workbook.addWorksheet("Review");
    const citationRows: CitationExportRow[] = [];

    reviewSheet.columns = [
        { header: "Document", width: 40 },
        ...sortedCols.map((column) => ({ header: column.name, width: 40 })),
    ];

    const reviewHeader = reviewSheet.getRow(1);
    reviewHeader.font = { bold: true };
    reviewHeader.alignment = { vertical: "middle" };
    reviewHeader.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF3F4F6" },
    };

    documents.forEach((document, documentIndex) => {
        const row: string[] = [document.filename];
        sortedCols.forEach((column, columnIndex) => {
            const cell = cellMap.get(`${document.id}:${column.index}`);
            const citations = collectCellCitations({
                cell,
                document,
                documentIndex,
                columnIndex,
            });
            citationRows.push(...citations);
            const referenceSuffix = citations.map((citation) => `[${citation.reference}]`).join(" ");
            const conclusion = formatCellForExport(cell);
            row.push([conclusion, referenceSuffix].filter(Boolean).join(" "));
        });
        const excelRow = reviewSheet.addRow(row);
        excelRow.alignment = { vertical: "top", wrapText: true };
    });

    const citationsSheet = workbook.addWorksheet("Citations");
    citationsSheet.columns = [
        { header: "Reference", width: 19 },
        { header: "Review cell", width: 14 },
        { header: "Source document", width: 36 },
        { header: "Section", width: 13 },
        { header: "Locator", width: 24 },
        { header: "Verbatim quote", width: 72 },
    ];
    const citationsHeader = citationsSheet.getRow(1);
    citationsHeader.font = { bold: true };
    citationsHeader.alignment = { vertical: "middle" };
    citationsHeader.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFF3F4F6" },
    };
    for (const citation of citationRows) {
        const citationRow = citationsSheet.addRow([
            citation.reference,
            citation.reviewCell,
            citation.sourceDocument,
            citation.section,
            citation.locator,
            citation.quote,
        ]);
        citationRow.alignment = { vertical: "top", wrapText: true };
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return {
        blob: new Blob([buffer], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        filename: `${sanitizeFilename(reviewTitle)}.xlsx`,
    };
}

export function isTabularReviewExcelWithinUploadLimit(blob: Blob): boolean {
    return blob.size <= MAX_PROJECT_DOCUMENT_BYTES;
}

export async function exportTabularReviewToExcel(
    params: TabularReviewExcelParams,
): Promise<void> {
    const { blob, filename } = await buildTabularReviewExcel(params);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
}
