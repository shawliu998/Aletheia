"use client";

// Authenticated local adaptation of Mike e32daad5a4c64a5561e04c53ee12411e3c5e7238:
// frontend/src/app/components/shared/views/SpreadsheetView.tsx
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/app/i18n";
import { ViewerError, ViewerLoading } from "./PdfView";
import { useVeraDisplayBlob } from "./useVeraDisplayBlob";

export type HighlightCell = { sheet?: string; cell?: string };

type SheetPreview = {
    name: string;
    rows: Array<Array<string | number | boolean>>;
};

type WorkbookPreviewState = {
    blob: Blob | null;
    sheets: SheetPreview[];
    error: unknown;
};

const MAX_PREVIEW_ROWS = 250;
const MAX_PREVIEW_COLUMNS = 60;

export function SpreadsheetView({
    documentId,
    versionId,
    highlightCells = [],
    rounded = true,
}: {
    documentId: string;
    versionId?: string | null;
    highlightCells?: HighlightCell[];
    rounded?: boolean;
}) {
    const { errorMessage } = useI18n();
    const { blob, loading, error } = useVeraDisplayBlob(
        documentId,
        versionId,
    );
    const [preview, setPreview] = useState<WorkbookPreviewState>({
        blob: null,
        sheets: [],
        error: null,
    });
    const [activeSheet, setActiveSheet] = useState(0);

    useEffect(() => {
        if (!blob) return;
        let cancelled = false;
        blob.arrayBuffer()
            .then(async (bytes) => {
                const ExcelJS = await import("exceljs");
                const workbook = new ExcelJS.Workbook();
                await workbook.xlsx.load(bytes);
                const loaded: SheetPreview[] = [];
                workbook.eachSheet((worksheet) => {
                    const rows: SheetPreview["rows"] = [];
                    const rowLimit = Math.min(
                        worksheet.actualRowCount,
                        MAX_PREVIEW_ROWS,
                    );
                    for (let rowNumber = 1; rowNumber <= rowLimit; rowNumber += 1) {
                        const row = worksheet.getRow(rowNumber);
                        const columnLimit = Math.min(
                            Math.max(row.actualCellCount, worksheet.actualColumnCount),
                            MAX_PREVIEW_COLUMNS,
                        );
                        const values: Array<string | number | boolean> = [];
                        for (let column = 1; column <= columnLimit; column += 1) {
                            values.push(displayCellValue(row.getCell(column).value));
                        }
                        rows.push(values);
                    }
                    loaded.push({ name: worksheet.name, rows });
                });
                if (!cancelled) {
                    setPreview({ blob, sheets: loaded, error: null });
                    setActiveSheet(0);
                }
            })
            .catch((reason: unknown) => {
                if (!cancelled) {
                    setPreview({ blob, sheets: [], error: reason });
                }
            });
        return () => {
            cancelled = true;
        };
    }, [blob]);

    const sheets = preview.blob === blob ? preview.sheets : [];
    const active = sheets[activeSheet];
    const highlighted = useMemo(
        () =>
            new Set(
                highlightCells
                    .filter(
                        (item) =>
                            !item.sheet || item.sheet === active?.name,
                    )
                    .flatMap((item) => {
                        const parsed = item.cell ? parseA1(item.cell) : null;
                        return parsed ? [`${parsed.row}:${parsed.column}`] : [];
                    }),
            ),
        [active?.name, highlightCells],
    );

    if (loading) return <ViewerLoading />;
    if (error || (preview.blob === blob && preview.error)) {
        return (
            <ViewerError
                message={errorMessage(
                    (error ?? preview.error) as Error,
                )}
            />
        );
    }
    if (!blob || preview.blob !== blob) return <ViewerLoading />;

    return (
        <div
            className={`flex h-full min-h-[360px] flex-col overflow-hidden bg-white ${
                rounded ? "rounded-xl" : ""
            }`}
        >
            {sheets.length > 1 && (
                <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-gray-200 p-2">
                    {sheets.map((sheet, index) => (
                        <button
                            key={sheet.name}
                            type="button"
                            onClick={() => setActiveSheet(index)}
                            aria-pressed={activeSheet === index}
                            className={`rounded-md px-2 py-1 text-xs ${
                                activeSheet === index
                                    ? "bg-gray-900 text-white"
                                    : "text-gray-500 hover:bg-gray-100"
                            }`}
                        >
                            {sheet.name}
                        </button>
                    ))}
                </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto">
                <table className="border-collapse text-xs text-gray-700">
                    <tbody>
                        {(active?.rows ?? []).map((row, rowIndex) => (
                            <tr key={rowIndex}>
                                {row.map((value, columnIndex) => (
                                    <td
                                        key={columnIndex}
                                        className={`min-w-24 border border-gray-200 px-2 py-1 align-top ${
                                            highlighted.has(`${rowIndex}:${columnIndex}`)
                                                ? "bg-yellow-100"
                                                : "bg-white"
                                        }`}
                                    >
                                        {String(value)}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function displayCellValue(value: unknown): string | number | boolean {
    if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
    ) {
        return value;
    }
    if (value instanceof Date) return value.toISOString();
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (typeof record.text === "string") return record.text;
        if (
            typeof record.result === "string" ||
            typeof record.result === "number" ||
            typeof record.result === "boolean"
        ) {
            return record.result;
        }
        if (Array.isArray(record.richText)) {
            return record.richText
                .map((part) =>
                    part && typeof part === "object" && "text" in part
                        ? String((part as { text: unknown }).text ?? "")
                        : "",
                )
                .join("");
        }
    }
    return "";
}

function parseA1(value: string): { row: number; column: number } | null {
    const match = value.trim().match(/^([A-Za-z]+)(\d+)$/);
    if (!match) return null;
    let column = 0;
    for (const character of match[1].toUpperCase()) {
        column = column * 26 + character.charCodeAt(0) - 64;
    }
    const row = Number.parseInt(match[2], 10);
    if (row < 1 || column < 1) return null;
    return { row: row - 1, column: column - 1 };
}
