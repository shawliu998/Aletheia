import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { verifierRepairAlreadyAttempted } from "../src/lib/agentTasks";
import {
  classifyAgentCitationRelocation,
  quotedAnchorLocated,
} from "../src/lib/agentTaskEvidence";
import { summarizeTaskCitationRelocation } from "../src/lib/agentStepExecutor";
import { selectActiveTools } from "../src/lib/chat/streaming";
import { spreadsheetCitationText } from "../src/lib/spreadsheet";

function main() {
  const baseTools = [{ name: "read_document" }];
  const mcpTools = [{ name: "mcp_search" }];
  const extraTools = [{ name: "custom_tool" }];

  assert.deepEqual(
    selectActiveTools({
      disableTools: true,
      baseTools,
      mcpTools,
      extraTools,
    }),
    [],
    "the verifier must receive no built-in, MCP, or extra tools",
  );
  assert.deepEqual(
    selectActiveTools({
      disableTools: false,
      baseTools,
      mcpTools,
      extraTools,
    }),
    [...baseTools, ...mcpTools, ...extraTools],
    "ordinary steps must retain their configured tools",
  );

  assert.equal(
    verifierRepairAlreadyAttempted({
      latest_checkpoint: {
        summary: "Verifier repair 1/1 started: missing risk matrix.",
      },
    }),
    true,
  );
  assert.equal(
    verifierRepairAlreadyAttempted({
      latest_checkpoint: {
        summary:
          "Provider queue during verifier repair 1/1: request timed out.",
      },
    }),
    true,
    "a provider interruption must not reset the repair allowance",
  );
  assert.equal(
    verifierRepairAlreadyAttempted({
      latest_checkpoint: {
        summary: "Model is busy. Retrying automatically at 12:00:00 PM.",
        runner_retry: {
          attempt: 2,
          retry_at: "2026-07-21T12:00:00.000Z",
          classification: "provider_unavailable",
        },
      },
    }),
    false,
    "a transient runner retry must not consume the verifier repair allowance",
  );
  assert.equal(
    verifierRepairAlreadyAttempted({
      latest_checkpoint: { summary: "Verifier completed with four PASS." },
    }),
    false,
  );
  assert.equal(verifierRepairAlreadyAttempted({}), false);

  assert.equal(
    quotedAnchorLocated(
      "The agreement terminates on 31 December 2027.",
      "terminates on 31 December 2027",
    ),
    true,
    "the shared evidence matcher must relocate normalized source text",
  );
  assert.equal(
    quotedAnchorLocated(
      "The agreement terminates on 31 December 2027.",
      "renews automatically for five years",
    ),
    false,
    "a non-existent quote must fail relocation",
  );
  assert.equal(quotedAnchorLocated(null, "any quote"), false);
  assert.equal(quotedAnchorLocated("any source", ""), false);
  assert.equal(
    classifyAgentCitationRelocation({
      source: {
        text: "The agreement has a two-year term.",
        spreadsheet: null,
        pdf: false,
      },
      quote: {
        page: 1,
        quote: "The agreement renews automatically.",
        sheet: null,
        cell: null,
      },
      versionId: "version-1",
      currentVersionId: "version-1",
    }).status,
    "drifted",
    "a quote absent from the cited version content must not relocate",
  );

  const pdfSource = {
    text: [
      "[Page 1]\nThe agreement has a two-year term.",
      "[Page 2]\nThe agreement renews automatically.",
      "[Page 3]\nThe renewal notice period is 30 days.",
    ].join("\n\n"),
    spreadsheet: null,
    pdf: true,
  };
  const pdfQuote = {
    page: 2,
    quote: "The agreement renews automatically.",
    sheet: null,
    cell: null,
  };
  assert.equal(
    classifyAgentCitationRelocation({
      source: pdfSource,
      quote: pdfQuote,
      versionId: "version-1",
      currentVersionId: "version-1",
    }).status,
    "exact",
    "a PDF quote on the cited page must relocate",
  );
  assert.equal(
    classifyAgentCitationRelocation({
      source: pdfSource,
      quote: { ...pdfQuote, page: 1 },
      versionId: "version-1",
      currentVersionId: "version-1",
    }).status,
    "drifted",
    "a matching PDF quote on a different page must not relocate",
  );
  assert.equal(
    classifyAgentCitationRelocation({
      source: pdfSource,
      quote: { ...pdfQuote, page: "1-2" },
      versionId: "version-1",
      currentVersionId: "version-1",
    }).status,
    "exact",
    "a bounded PDF page range may relocate text on any included page",
  );
  assert.equal(
    classifyAgentCitationRelocation({
      source: pdfSource,
      quote: { ...pdfQuote, page: null },
      versionId: "version-1",
      currentVersionId: "version-1",
    }).status,
    "missing",
    "a PDF citation without a page locator must fail closed",
  );
  assert.equal(
    classifyAgentCitationRelocation({
      source: pdfSource,
      quote: { ...pdfQuote, page: "2-last" },
      versionId: "version-1",
      currentVersionId: "version-1",
    }).status,
    "missing",
    "an invalid PDF page range must fail closed",
  );

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Clause", "Value"],
      ["Term", "31 December 2027"],
      ["Renewal", "Five years"],
    ]),
    "Contract",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["31 December 2027"]]),
    "Other",
  );
  const workbookBytes = XLSX.write(workbook, {
    type: "buffer",
    bookType: "xlsx",
  }) as Buffer;
  assert.equal(
    spreadsheetCitationText(workbookBytes, "Contract", "B2"),
    "31 December 2027",
    "spreadsheet relocation must read the cited sheet and cell",
  );
  assert.equal(
    spreadsheetCitationText(workbookBytes, "Contract", "B99"),
    "",
    "an empty cited cell must not borrow a matching value elsewhere",
  );
  assert.equal(
    spreadsheetCitationText(workbookBytes, "Missing", "B2"),
    null,
    "an unknown sheet must fail closed",
  );
  const spreadsheetSource = {
    text: "",
    spreadsheet: workbookBytes,
    pdf: false,
  };
  const spreadsheetQuote = {
    page: null,
    quote: "31 December 2027",
    sheet: "Contract",
    cell: "B2",
  };
  assert.equal(
    classifyAgentCitationRelocation({
      source: spreadsheetSource,
      quote: spreadsheetQuote,
      versionId: "version-1",
      currentVersionId: "version-1",
    }).status,
    "exact",
  );
  assert.equal(
    classifyAgentCitationRelocation({
      source: spreadsheetSource,
      quote: { ...spreadsheetQuote, cell: "B99" },
      versionId: "version-1",
      currentVersionId: "version-1",
    }).status,
    "drifted",
    "a quote elsewhere in the workbook must not validate the wrong cited cell",
  );
  assert.equal(
    classifyAgentCitationRelocation({
      source: spreadsheetSource,
      quote: spreadsheetQuote,
      versionId: "version-1",
      currentVersionId: "version-2",
    }).status,
    "version_mismatch",
    "a quote in an older cited version must not pass the current-version guard",
  );
  assert.equal(
    classifyAgentCitationRelocation({
      source: null,
      quote: spreadsheetQuote,
      versionId: "version-1",
      currentVersionId: "version-1",
    }).status,
    "missing",
    "an unreadable cited version must fail closed",
  );

  assert.deepEqual(
    summarizeTaskCitationRelocation([], ["source-1"]),
    { total: 0, relocatable: 0, missing: 0 },
    "an empty relocation set must keep missing within total",
  );
  assert.deepEqual(
    summarizeTaskCitationRelocation(
      [{ document_id: "source-1", status: "exact" }],
      ["source-1"],
    ),
    { total: 1, relocatable: 1, missing: 0 },
  );
  assert.deepEqual(
    summarizeTaskCitationRelocation(
      [
        { document_id: "source-1", status: "drifted" },
        { document_id: "source-1", status: "version_mismatch" },
        { document_id: "source-1", status: "missing" },
      ],
      ["source-1"],
      1,
    ),
    { total: 4, relocatable: 0, missing: 4 },
    "missing quotes, version drift, unreadable content, and missing snapshots must all fail closed",
  );
  assert.deepEqual(
    summarizeTaskCitationRelocation(
      [{ document_id: "generated-draft", status: "exact" }],
      ["source-1"],
    ),
    { total: 1, relocatable: 0, missing: 1 },
    "a generated-artifact citation must fail the source-backed gate without making missing exceed total",
  );

  console.log(
    JSON.stringify({ ok: true, suite: "verifier-guards-smoke-v1" }, null, 2),
  );
}

main();
