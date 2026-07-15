#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function createTextAndBlankPdf() {
  const visibleText = "BT /F1 18 Tf 72 720 Td (SEARCHABLE TEXT PAGE) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(visibleText)} >>\nstream\n${visibleText}\nendstream`,
    "<< /Length 0 >>\nstream\nendstream",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function assertLayout(page) {
  assert.ok(Array.isArray(page.blocks) && page.blocks.length > 0);
  assert.equal(
    page.text,
    page.blocks.map((block) => block.text).join("\n"),
  );
  for (const block of page.blocks) {
    assert.ok(block.confidence >= 0 && block.confidence <= 1);
    const { x, y, width, height } = block.boundingBox;
    for (const value of [x, y, width, height]) {
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
    }
    assert.ok(x + width <= 1.000001);
    assert.ok(y + height <= 1.000001);
  }
}

function writeNodeHelper(root, name, source) {
  const target = path.join(root, name);
  fs.writeFileSync(target, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return target;
}

function hasOcrCode(code) {
  return (error) => error && error.code === code;
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("This audit requires macOS.");
  }
  const desktopDir = path.resolve(__dirname, "..");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aletheia-ocr-audit-"));
  const binary = path.join(desktopDir, ".runtime", "native", "aletheia-ocr");
  const fixture = path.join(root, "scanned.pdf");
  const civilFixture = path.join(root, "civil-case.pdf");
  const mixedFixture = path.join(root, "mixed.pdf");
  try {
    execFileSync(
      "/usr/bin/xcrun",
      ["swift", path.join(desktopDir, "native", "ocr-audit-fixture.swift"), fixture],
      { stdio: "inherit" },
    );
    execFileSync(
      "/usr/bin/xcrun",
      ["swift", path.join(desktopDir, "native", "civil-case-ocr-fixture.swift"), civilFixture],
      { stdio: "inherit" },
    );
    execFileSync(
      "/usr/bin/xcrun",
      ["swift", path.join(desktopDir, "native", "mixed-ocr-audit-fixture.swift"), mixedFixture],
      { stdio: "inherit" },
    );

    const pdf = fs.readFileSync(fixture);
    const civilPdf = fs.readFileSync(civilFixture);
    const mixedPdf = fs.readFileSync(mixedFixture);
    const direct = spawnSync(binary, [], {
      input: pdf,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(direct.status, 0, direct.stderr.toString("utf8"));
    const output = JSON.parse(direct.stdout.toString("utf8"));
    assert.equal(output.schemaVersion, "aletheia-native-ocr-v1");
    assert.equal(output.engine, "apple-vision");
    assert.equal(output.coordinateSpace, "normalized-top-left");
    assert.equal(output.pages.length, 1);
    assert.match(output.pages[0].text, /PAYMENT DUE/i);
    assert.match(output.pages[0].text, /2026-09-01/);
    assert.ok(output.pages[0].confidence >= 0.5);
    assertLayout(output.pages[0]);

    const ranged = spawnSync(binary, ["--pages", "2-3"], {
      input: civilPdf,
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(ranged.status, 0, ranged.stderr.toString("utf8"));
    const rangedOutput = JSON.parse(ranged.stdout.toString("utf8"));
    assert.deepEqual(rangedOutput.pages.map((page) => page.page), [2, 3]);
    assert.match(rangedOutput.pages[0].text, /PAYMENT LEDGER TABLE/i);
    assert.match(rangedOutput.pages[1].text, /COURT SERVICE RECORD/i);
    rangedOutput.pages.forEach(assertLayout);
    for (const selection of ["0", "4", "2,2", "3-2"]) {
      const invalidRange = spawnSync(binary, ["--pages", selection], {
        input: civilPdf,
      });
      assert.notEqual(invalidRange.status, 0, selection);
    }

    process.env.ALETHEIA_OCR_ENABLED = "true";
    process.env.ALETHEIA_OCR_BINARY = binary;
    const parser = require("../../backend/dist/lib/aletheia/documentParser.js");
    const {
      AppleVisionOcrProvider,
    } = require("../../backend/dist/lib/aletheia/appleVisionOcrProvider.js");
    const {
      extractionRequiresOcr,
    } = require("../../backend/dist/lib/workspace/documentParsing.js");
    const provider = new AppleVisionOcrProvider({ binaryPath: binary });
    const selected = await provider.recognizePdf({
      pdf: civilPdf,
      pageCount: 3,
      pages: [2],
    });
    assert.deepEqual(selected.pages.map((page) => page.page), [2]);
    assert.equal(selected.coordinateSpace, "normalized-top-left");

    const extracted = await parser.extractMatterDocument({
      filename: "scanned-contract.pdf",
      buffer: pdf,
    });
    assert.equal(extracted.metadata.parser, "pdf+apple-vision");
    assert.equal(extracted.metadata.pageCount, 1);
    assert.equal(extracted.metadata.textLayerPageCount, 0);
    assert.equal(extracted.metadata.ocrPageCount, 1);
    assert.equal(extracted.metadata.ocrEngine, "apple-vision");
    assert.equal(extracted.metadata.ocrCoordinateSpace, "normalized-top-left");
    assert.match(extracted.text, /\[Page 1\]/);
    assert.match(extracted.text, /PAYMENT DUE/i);
    const chunks = parser.chunkMatterDocument(extracted.text);
    assert.ok(chunks.length > 0);
    assert.equal(chunks[0].page, 1);

    const mixed = await parser.extractMatterDocument({
      filename: "mixed.pdf",
      buffer: mixedPdf,
    });
    assert.equal(mixed.metadata.pageCount, 3);
    assert.equal(mixed.metadata.textLayerPageCount, 1);
    assert.equal(mixed.metadata.ocrPageCount, 1);
    assert.deepEqual(mixed.metadata.ocrAttemptedPages, [2, 3]);
    assert.deepEqual(mixed.metadata.unresolvedPages, []);
    assert.deepEqual(mixed.metadata.ocrEmptyPages, [3]);
    assert.match(mixed.text, /SEARCHABLE CONTRACT COVER PAGE/);
    assert.match(mixed.text, /SCANNED EXHIBIT PAYMENT 480000/i);
    assert.equal(extractionRequiresOcr(mixed), false);
    assert.ok(mixed.metadata.ocrPages[0].blocks.length > 0);

    const textAndBlank = await parser.extractMatterDocument({
      filename: "text-and-blank.pdf",
      buffer: createTextAndBlankPdf(),
    });
    assert.equal(textAndBlank.metadata.textLayerPageCount, 1);
    assert.deepEqual(textAndBlank.metadata.ocrAttemptedPages, [2]);
    assert.deepEqual(textAndBlank.metadata.ocrEmptyPages, [2]);
    assert.deepEqual(textAndBlank.metadata.unresolvedPages, []);
    assert.equal(extractionRequiresOcr(textAndBlank), false);
    assert.equal(
      extractionRequiresOcr({
        text: "",
        metadata: {
          parser: "pdf",
          pageCount: 1,
          textLayerPageCount: 0,
          ocrPageCount: 0,
          unresolvedPageCount: 0,
        },
      }),
      true,
    );

    let contractRequest = null;
    const contractProvider = {
      id: "ocr-contract-audit",
      local: true,
      isAvailable: () => true,
      recognizePdf: async (request) => {
        contractRequest = request;
        return {
          schemaVersion: "aletheia-native-ocr-v1",
          engine: "ocr-contract-audit",
          coordinateSpace: "normalized-top-left",
          pages: [
            {
              page: 2,
              text: "OCR CONTRACT PAGE",
              confidence: 0.91,
              blocks: [
                {
                  text: "OCR CONTRACT PAGE",
                  confidence: 0.91,
                  boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
                },
              ],
            },
          ],
        };
      },
    };
    const contractExtraction = await parser.extractMatterDocument({
      filename: "contract.pdf",
      buffer: createTextAndBlankPdf(),
      ocrProvider: contractProvider,
    });
    assert.deepEqual(contractRequest.pages, [2]);
    assert.match(contractExtraction.text, /OCR CONTRACT PAGE/);
    assert.deepEqual(contractExtraction.metadata.ocrPages[0].blocks[0], {
      textStart: 0,
      textEnd: "OCR CONTRACT PAGE".length,
      confidence: 0.91,
      boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.1 },
    });

    const legacyHelper = writeNodeHelper(
      root,
      "legacy-helper",
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({schemaVersion:"aletheia-native-ocr-v1",engine:"apple-vision",pages:[{page:1,text:"legacy one",confidence:0.8},{page:2,text:"legacy two",confidence:0.9}]})));`,
    );
    const legacy = await new AppleVisionOcrProvider({
      binaryPath: legacyHelper,
    }).recognizePdf({
      pdf: createTextAndBlankPdf(),
      pageCount: 2,
      pages: [2],
    });
    assert.equal(legacy.coordinateSpace, null);
    assert.deepEqual(legacy.pages.map((page) => page.page), [2]);
    assert.deepEqual(legacy.pages[0].blocks, []);

    const exactRangeViolation = writeNodeHelper(
      root,
      "exact-range-violation",
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(JSON.stringify({schemaVersion:"aletheia-native-ocr-v1",engine:"apple-vision",coordinateSpace:"normalized-top-left",pages:[{page:1,text:"",confidence:0,blocks:[]},{page:2,text:"",confidence:0,blocks:[]}]})));`,
    );
    await assert.rejects(
      () =>
        new AppleVisionOcrProvider({
          binaryPath: exactRangeViolation,
        }).recognizePdf({
          pdf: createTextAndBlankPdf(),
          pageCount: 2,
          pages: [2],
        }),
      hasOcrCode("OCR_OUTPUT_INVALID"),
    );

    const strictProtocolViolations = [
      {
        schemaVersion: "aletheia-native-ocr-v1",
        engine: "apple-vision",
        coordinateSpace: "normalized-top-left",
        pages: [{ page: "1", text: "bad", confidence: 0.8, blocks: [] }],
      },
      {
        schemaVersion: "aletheia-native-ocr-v1",
        engine: "apple-vision",
        coordinateSpace: "normalized-top-left",
        pages: [{ page: 1, text: "bad", confidence: "0.8", blocks: [] }],
      },
      {
        schemaVersion: "aletheia-native-ocr-v1",
        engine: "apple-vision",
        coordinateSpace: "normalized-top-left",
        unexpected: true,
        pages: [{ page: 1, text: "bad", confidence: 0.8, blocks: [] }],
      },
      {
        schemaVersion: "aletheia-native-ocr-v1",
        engine: "apple-vision",
        coordinateSpace: "normalized-top-left",
        pages: [
          { page: 1, text: "bad", confidence: 0.8, blocks: [], extra: true },
        ],
      },
      {
        schemaVersion: "aletheia-native-ocr-v1",
        engine: "apple-vision",
        coordinateSpace: "normalized-top-left",
        pages: [
          {
            page: 1,
            text: "bad",
            confidence: 0.8,
            blocks: [
              {
                text: "bad",
                confidence: 0.8,
                boundingBox: { x: 0, y: 0, width: 1, height: 1 },
                extra: true,
              },
            ],
          },
        ],
      },
    ];
    for (const [index, payload] of strictProtocolViolations.entries()) {
      const helper = writeNodeHelper(
        root,
        `strict-protocol-${index}`,
        `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(
          JSON.stringify(payload),
        )}));`,
      );
      await assert.rejects(
        () =>
          new AppleVisionOcrProvider({ binaryPath: helper }).recognizePdf({
            pdf,
            pageCount: 1,
            pages: [1],
          }),
        hasOcrCode("OCR_OUTPUT_INVALID"),
      );
    }

    const slowHelper = writeNodeHelper(
      root,
      "slow-helper",
      `process.stdin.resume(); setInterval(() => {}, 1000);`,
    );
    await assert.rejects(
      () =>
        new AppleVisionOcrProvider({
          binaryPath: slowHelper,
          timeoutMs: 50,
        }).recognizePdf({ pdf, pageCount: 1, pages: [1] }),
      hasOcrCode("OCR_TIMEOUT"),
    );
    const controller = new AbortController();
    const aborted = new AppleVisionOcrProvider({
      binaryPath: slowHelper,
      timeoutMs: 5_000,
    }).recognizePdf({
      pdf,
      pageCount: 1,
      pages: [1],
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(aborted, hasOcrCode("OCR_ABORTED"));

    const invalidHelper = writeNodeHelper(
      root,
      "invalid-helper",
      `process.stdin.resume(); process.stdin.on("end", () => process.stdout.write('{"schemaVersion":"wrong","pages":[]}'));`,
    );
    process.env.ALETHEIA_OCR_BINARY = invalidHelper;
    await assert.rejects(
      () =>
        parser.extractMatterDocument({
          filename: "scanned-contract.pdf",
          buffer: pdf,
        }),
      hasOcrCode("OCR_OUTPUT_INVALID"),
    );
    const symlinkHelper = path.join(root, "symlink-helper");
    fs.symlinkSync(binary, symlinkHelper);
    process.env.ALETHEIA_OCR_BINARY = symlinkHelper;
    const blocked = await parser.extractMatterDocument({
      filename: "scanned-contract.pdf",
      buffer: pdf,
    });
    assert.equal(blocked.text, "");
    assert.equal(blocked.metadata.ocrPageCount, 0);
    assert.deepEqual(blocked.metadata.unresolvedPages, [1]);
    process.env.ALETHEIA_OCR_BINARY = binary;

    const invalid = spawnSync(binary, [], { input: Buffer.from("not a pdf") });
    assert.notEqual(invalid.status, 0);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          suite: "aletheia-native-ocr-v1",
          checks: [
            "real Apple Vision image-only PDF recognition",
            "strict ranged recognition and invalid range rejection",
            "normalized block coordinates and page confidence",
            "only missing-text pages sent to OCR",
            "mixed text, scanned, and valid blank page semantics",
            "legacy v1 full-document output compatibility",
            "AbortSignal and timeout fail-closed behavior",
            "invalid output, symlink, and invalid PDF rejection",
          ],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
