import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import JSZip from "jszip";
import {
  extractDocxBodyText,
  extractDocxReviewMarkup,
  type DocxReviewMarkupItem,
} from "../src/lib/docxTrackedChanges";

const FIXTURE_PARTS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "word/_rels/document.xml.rels",
  "word/document.xml",
  "word/comments.xml",
] as const;

async function buildFixture(): Promise<Buffer> {
  const root = join(__dirname, "fixtures", "docx-review-markup");
  const zip = new JSZip();
  for (const part of FIXTURE_PARTS) {
    zip.file(part, await readFile(join(root, part)));
  }
  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

function item(
  items: DocxReviewMarkupItem[],
  kind: DocxReviewMarkupItem["kind"],
): DocxReviewMarkupItem {
  const match = items.find((candidate) => candidate.kind === kind);
  assert.ok(match, `Expected ${kind} markup`);
  return match;
}

async function run(): Promise<void> {
  const fixture = await buildFixture();
  assert.equal(fixture.subarray(0, 2).toString("ascii"), "PK");

  const acceptedText = await extractDocxBodyText(fixture);
  assert.equal(acceptedText, "The new clause requires notice.");

  const markup = await extractDocxReviewMarkup(fixture);
  assert.equal(markup.finalText, acceptedText);
  assert.equal(markup.items.length, 3);
  assert.deepEqual(
    markup.items.map((candidate) => candidate.kind),
    ["deletion", "insertion", "comment"],
  );
  assert.deepEqual(item(markup.items, "deletion"), {
    kind: "deletion",
    id: "10",
    author: "Original drafter",
    date: "2026-07-20T08:00:00Z",
    text: "old",
    paragraphIndex: 0,
    finalStart: 4,
    finalEnd: 4,
  });
  assert.deepEqual(item(markup.items, "insertion"), {
    kind: "insertion",
    id: "11",
    author: "Review lawyer",
    date: "2026-07-21T09:30:00Z",
    text: "new",
    paragraphIndex: 0,
    finalStart: 4,
    finalEnd: 7,
  });
  assert.deepEqual(item(markup.items, "comment"), {
    kind: "comment",
    id: "12",
    author: "Review lawyer",
    date: "2026-07-21T09:35:00Z",
    text: "Confirm the notice period.",
    anchorText: "requires notice",
    paragraphStart: 0,
    paragraphEnd: 0,
    finalStart: 15,
    finalEnd: 30,
  });

  process.stdout.write("DOCX review-markup extraction passed.\n");
}

void run();
