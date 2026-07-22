import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";

import {
    MAX_PROJECT_DOCUMENT_BYTES,
    buildTabularReviewExcel,
    isTabularReviewExcelWithinUploadLimit,
} from "./exportToExcel";

test("builds readable review cells and a citation sheet for page, spreadsheet, and reasoning sources", async () => {
    const result = await buildTabularReviewExcel({
        reviewTitle: "跨境 / 合同审阅",
        columns: [
            {
                index: 0,
                name: "风险结论",
                prompt: "Summarise the material risk.",
            },
        ],
        documents: [
            {
                id: "document-1",
                project_id: "matter-1",
                filename: "供应商主协议.docx",
                file_type: "docx",
                storage_path: null,
                pdf_storage_path: null,
                size_bytes: null,
                page_count: null,
                structure_tree: null,
                status: "ready",
                created_at: null,
            },
        ],
        cells: [
            {
                id: "cell-1",
                review_id: "review-1",
                document_id: "document-1",
                column_index: 0,
                status: "done",
                created_at: "2026-07-22T00:00:00.000Z",
                content: {
                    summary:
                        "合同会自动续期。[[page:4||quote:本合同将在期限届满时自动续期一年。]]",
                    reasoning:
                        "续期后价格可调整。[[sheet:报价表||cell:F18||quote:续期价格为人民币125000元。]][[page:9||quote:供应商应提前三十日通知价格调整。]]",
                },
            },
        ],
    });

    assert.equal(result.filename, "跨境 合同审阅.xlsx");

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await result.blob.arrayBuffer());
    const review = workbook.getWorksheet("Review");
    const citations = workbook.getWorksheet("Citations");

    assert.ok(review);
    assert.ok(citations);
    assert.equal(review?.getCell("B2").value,
        "合同会自动续期。 [C-01-01-S-01] [C-01-01-R-01] [C-01-01-R-02]");
    assert.equal(citations?.getCell("A2").value, "C-01-01-S-01");
    assert.equal(citations?.getCell("B2").value, "B2");
    assert.equal(citations?.getCell("C2").value, "供应商主协议.docx");
    assert.equal(citations?.getCell("D2").value, "Summary");
    assert.equal(citations?.getCell("E2").value, "Page 4");
    assert.equal(citations?.getCell("F2").value, "本合同将在期限届满时自动续期一年。");
    assert.equal(citations?.getCell("D3").value, "Reasoning");
    assert.equal(citations?.getCell("E3").value, "报价表!F18");
    assert.equal(citations?.getCell("F4").value, "供应商应提前三十日通知价格调整。");
});

test("uses the existing 100 MB Matter upload limit for save eligibility", () => {
    assert.equal(
        isTabularReviewExcelWithinUploadLimit(
            { size: MAX_PROJECT_DOCUMENT_BYTES } as Blob,
        ),
        true,
    );
    assert.equal(
        isTabularReviewExcelWithinUploadLimit(
            { size: MAX_PROJECT_DOCUMENT_BYTES + 1 } as Blob,
        ),
        false,
    );
});
