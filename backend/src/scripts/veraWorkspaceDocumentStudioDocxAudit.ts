import assert from "node:assert/strict";

import { Document, ImageRun, Packer, Paragraph, TextRun } from "docx";
import * as mammoth from "mammoth";
import PizZip from "pizzip";

import {
  DEFAULT_DOCX_MAX_ENTRIES,
  DocxPackageSafetyError,
  inspectDocxPackage,
} from "../lib/docxPackageSafety";
import {
  DOCUMENT_STUDIO_MAX_DOCX_BYTES,
  DOCUMENT_STUDIO_MAX_MARKDOWN_BYTES,
  DocumentStudioDocxError,
  exportDocumentStudioMarkdownToDocx,
  importDocumentStudioDocxToMarkdown,
} from "../lib/workspace/documentStudioDocx";

function editPart(
  bytes: Buffer,
  name: string,
  edit: (value: string) => string,
): Buffer {
  const archive = new PizZip(bytes);
  const value = archive.file(name)?.asText();
  assert.notEqual(value, undefined, `${name} must exist in audit fixture`);
  archive.file(name, edit(value!));
  return archive.generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  }) as Buffer;
}

function duplicateZipEntry(
  bytes: Buffer,
  originalName: string,
  placeholderName: string,
): Buffer {
  assert.equal(
    Buffer.byteLength(originalName),
    Buffer.byteLength(placeholderName),
    "duplicate ZIP fixture names must be byte-exact in length",
  );
  const archive = new PizZip(bytes);
  const original = archive.file(originalName)?.asUint8Array();
  assert.notEqual(original, undefined, `${originalName} must exist`);
  archive.file(placeholderName, original!);
  const generated = archive.generate({
    type: "nodebuffer",
    compression: "STORE",
  }) as Buffer;
  const from = Buffer.from(placeholderName, "utf8");
  const to = Buffer.from(originalName, "utf8");
  let cursor = 0;
  let replacements = 0;
  while ((cursor = generated.indexOf(from, cursor)) >= 0) {
    to.copy(generated, cursor);
    cursor += to.length;
    replacements += 1;
  }
  assert.equal(
    replacements,
    2,
    "placeholder must occur once in a local header and once in the central directory",
  );
  return generated;
}

function zipWithCopiedEntry(
  bytes: Buffer,
  originalName: string,
  copiedName: string,
): Buffer {
  const archive = new PizZip(bytes);
  const original = archive.file(originalName)?.asUint8Array();
  assert.notEqual(original, undefined, `${originalName} must exist`);
  archive.file(copiedName, original!);
  return archive.generate({
    type: "nodebuffer",
    compression: "STORE",
  }) as Buffer;
}

type TestZipEntry = Readonly<{
  centralOffset: number;
  localOffset: number;
  nameLength: number;
  extraLength: number;
}>;

function testEocdOffset(bytes: Buffer): number {
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - (22 + 0xffff));
    offset -= 1
  ) {
    if (
      bytes.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    ) {
      return offset;
    }
  }
  assert.fail("audit fixture must contain a valid ZIP EOCD record");
}

function testZipEntries(bytes: Buffer): Map<string, TestZipEntry> {
  const eocdOffset = testEocdOffset(bytes);
  const count = bytes.readUInt16LE(eocdOffset + 10);
  let cursor = bytes.readUInt32LE(eocdOffset + 16);
  const entries = new Map<string, TestZipEntry>();
  for (let index = 0; index < count; index += 1) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    entries.set(name, {
      centralOffset: cursor,
      localOffset: bytes.readUInt32LE(cursor + 42),
      nameLength,
      extraLength,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, eocdOffset);
  return entries;
}

function renameZipEntryHeader(
  bytes: Buffer,
  originalName: string,
  replacementName: string,
  header: "central" | "local" | "both",
): Buffer {
  assert.equal(
    Buffer.byteLength(originalName),
    Buffer.byteLength(replacementName),
    "renamed ZIP audit paths must be byte-exact in length",
  );
  const result = Buffer.from(bytes);
  const entry = testZipEntries(result).get(originalName);
  assert(entry, `${originalName} must exist in the ZIP audit fixture`);
  assert.equal(entry.nameLength, Buffer.byteLength(originalName));
  const replacement = Buffer.from(replacementName, "utf8");
  if (header === "central" || header === "both") {
    replacement.copy(result, entry.centralOffset + 46);
  }
  if (header === "local" || header === "both") {
    assert.equal(result.readUInt32LE(entry.localOffset), 0x04034b50);
    assert.equal(
      result.readUInt16LE(entry.localOffset + 26),
      replacement.length,
    );
    replacement.copy(result, entry.localOffset + 30);
  }
  return result;
}

function addCentralZip64Extra(bytes: Buffer, name: string): Buffer {
  const originalEocdOffset = testEocdOffset(bytes);
  const originalCentralSize = bytes.readUInt32LE(originalEocdOffset + 12);
  const entry = testZipEntries(bytes).get(name);
  assert(entry, `${name} must exist in the ZIP64 audit fixture`);
  const insertionOffset =
    entry.centralOffset + 46 + entry.nameLength + entry.extraLength;
  const zip64Extra = Buffer.from([0x01, 0x00, 0x00, 0x00]);
  const result = Buffer.concat([
    bytes.subarray(0, insertionOffset),
    zip64Extra,
    bytes.subarray(insertionOffset),
  ]);
  result.writeUInt16LE(
    entry.extraLength + zip64Extra.length,
    entry.centralOffset + 30,
  );
  const newEocdOffset = originalEocdOffset + zip64Extra.length;
  result.writeUInt32LE(
    originalCentralSize + zip64Extra.length,
    newEocdOffset + 12,
  );
  return result;
}

function addZip64Locator(bytes: Buffer): Buffer {
  const eocdOffset = testEocdOffset(bytes);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  return Buffer.concat([
    bytes.subarray(0, eocdOffset),
    locator,
    bytes.subarray(eocdOffset),
  ]);
}

type StreamingDescriptorFixture = Readonly<{
  bytes: Buffer;
  name: string;
  dataEnd: number;
  descriptorLength: 12 | 16;
}>;

function addStreamingDataDescriptor(
  bytes: Buffer,
  signature: boolean,
): StreamingDescriptorFixture {
  const originalEocdOffset = testEocdOffset(bytes);
  const originalCentralOffset = bytes.readUInt32LE(originalEocdOffset + 16);
  const entries = testZipEntries(bytes);
  const lastEntry = [...entries.entries()].find(([, entry]) => {
    const localNameLength = bytes.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(entry.localOffset + 28);
    const compressedSize = bytes.readUInt32LE(entry.centralOffset + 20);
    return (
      entry.localOffset +
        30 +
        localNameLength +
        localExtraLength +
        compressedSize ===
      originalCentralOffset
    );
  });
  assert(lastEntry, "audit fixture must have a final local ZIP entry");
  const [name, entry] = lastEntry;
  const crc32 = bytes.readUInt32LE(entry.centralOffset + 16);
  const compressedSize = bytes.readUInt32LE(entry.centralOffset + 20);
  const uncompressedSize = bytes.readUInt32LE(entry.centralOffset + 24);
  const descriptorLength: 12 | 16 = signature ? 16 : 12;
  const descriptor = Buffer.alloc(descriptorLength);
  const tupleOffset = signature ? 4 : 0;
  if (signature) descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc32, tupleOffset);
  descriptor.writeUInt32LE(compressedSize, tupleOffset + 4);
  descriptor.writeUInt32LE(uncompressedSize, tupleOffset + 8);

  const result = Buffer.concat([
    bytes.subarray(0, originalCentralOffset),
    descriptor,
    bytes.subarray(originalCentralOffset),
  ]);
  const newCentralOffset = originalCentralOffset + descriptorLength;
  const newEocdOffset = originalEocdOffset + descriptorLength;
  result.writeUInt32LE(newCentralOffset, newEocdOffset + 16);
  const shiftedCentralEntry = entry.centralOffset + descriptorLength;
  result.writeUInt16LE(
    result.readUInt16LE(shiftedCentralEntry + 8) | 0x0008,
    shiftedCentralEntry + 8,
  );
  result.writeUInt16LE(
    result.readUInt16LE(entry.localOffset + 6) | 0x0008,
    entry.localOffset + 6,
  );
  result.writeUInt32LE(0, entry.localOffset + 14);
  result.writeUInt32LE(0, entry.localOffset + 18);
  result.writeUInt32LE(0, entry.localOffset + 22);
  return {
    bytes: result,
    name,
    dataEnd: originalCentralOffset,
    descriptorLength,
  };
}

function descriptorLocalSizesMatchCentral(
  fixture: StreamingDescriptorFixture,
): Buffer {
  const result = Buffer.from(fixture.bytes);
  const entry = testZipEntries(result).get(fixture.name);
  assert(entry);
  result.writeUInt32LE(
    result.readUInt32LE(entry.centralOffset + 16),
    entry.localOffset + 14,
  );
  result.writeUInt32LE(
    result.readUInt32LE(entry.centralOffset + 20),
    entry.localOffset + 18,
  );
  result.writeUInt32LE(
    result.readUInt32LE(entry.centralOffset + 24),
    entry.localOffset + 22,
  );
  return result;
}

function lieAboutUncompressedSize(
  bytes: Buffer,
  name: string,
  declaredSize: number,
): Buffer {
  const result = Buffer.from(bytes);
  const entry = testZipEntries(result).get(name);
  assert(entry, `${name} must exist in the expansion audit fixture`);
  result.writeUInt32LE(declaredSize, entry.centralOffset + 24);
  result.writeUInt32LE(declaredSize, entry.localOffset + 22);
  return result;
}

function collapseAuditEntryNames(bytes: Buffer): Buffer {
  const binary = bytes.toString("latin1");
  const matches = binary.match(/audit\/\d{4}\.txt/g) ?? [];
  assert.equal(matches.length, 2 * (DEFAULT_DOCX_MAX_ENTRIES + 1));
  return Buffer.from(
    binary.replace(/audit\/\d{4}\.txt/g, "audit/0000.txt"),
    "latin1",
  );
}

async function expectStudioCode(
  operation: () => Promise<unknown>,
  code: DocumentStudioDocxError["code"],
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert(error instanceof DocumentStudioDocxError);
    assert.equal(error.code, code);
    return true;
  });
}

function expectSafetyCode(
  operation: () => unknown,
  code: DocxPackageSafetyError["code"],
): void {
  assert.throws(operation, (error: unknown) => {
    assert(error instanceof DocxPackageSafetyError);
    assert.equal(error.code, code);
    return true;
  });
}

async function imageDocx(): Promise<Buffer> {
  const onePixelPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  return Packer.toBuffer(
    new Document({
      sections: [
        {
          children: [
            new Paragraph({
              children: [
                new TextRun("Before image"),
                new ImageRun({
                  data: onePixelPng,
                  type: "png",
                  transformation: { width: 1, height: 1 },
                }),
                new TextRun("After image"),
              ],
            }),
          ],
        },
      ],
    }),
  );
}

async function main() {
  const markdown = [
    "# 服务协议",
    "",
    "## 付款义务",
    "",
    "1. 甲方应支付人民币 5,000 元。",
    "2. 乙方应出具收据。",
    "   - 收据须加盖公章。",
    "",
    "> 引用条款保留 Unicode：诚信与公平。",
    ">",
    "> | 引用项 | 值 |",
    "> | --- | --- |",
    "> | 管辖 | 上海 |",
    "",
    "| 项目 | 内容 |",
    "| --- | --- |",
    "| 期限 | 三十日 |",
    "| 语言 | 中文 / English |",
  ].join("\n");

  const exported = await exportDocumentStudioMarkdownToDocx({
    title: "Vera 合同审查",
    markdown,
  });
  assert(exported.bytes.length > 0);
  assert(exported.bytes.length <= DOCUMENT_STUDIO_MAX_DOCX_BYTES);
  assert(
    exported.warnings.some(
      (warning) => warning.code === "MARKDOWN_BLOCKQUOTE_SIMPLIFIED",
    ),
  );

  const packageResult = inspectDocxPackage(exported.bytes, {
    drawingPolicy: "reject",
  });
  const documentXml =
    packageResult.archive.file("word/document.xml")?.asText() ?? "";
  assert(documentXml.includes("Times New Roman"));
  assert(documentXml.includes("w:numPr"));
  assert(documentXml.includes("w:tbl"));
  assert(documentXml.includes("人民币 5,000 元"));
  assert(documentXml.includes("诚信与公平"));

  const signedDescriptor = addStreamingDataDescriptor(exported.bytes, true);
  assert(
    new PizZip(signedDescriptor.bytes)
      .file("word/document.xml")
      ?.asText()
      .includes("人民币 5,000 元"),
  );
  const signedDescriptorResult = inspectDocxPackage(signedDescriptor.bytes);
  assert.equal(
    signedDescriptorResult.expandedBytes,
    packageResult.expandedBytes,
  );

  const unsignedDescriptor = addStreamingDataDescriptor(exported.bytes, false);
  assert(
    new PizZip(unsignedDescriptor.bytes)
      .file("word/document.xml")
      ?.asText()
      .includes("人民币 5,000 元"),
  );
  const unsignedDescriptorResult = inspectDocxPackage(unsignedDescriptor.bytes);
  assert.equal(
    unsignedDescriptorResult.expandedBytes,
    packageResult.expandedBytes,
  );

  const exactLocalDescriptor =
    descriptorLocalSizesMatchCentral(signedDescriptor);
  assert.equal(
    inspectDocxPackage(exactLocalDescriptor).expandedBytes,
    packageResult.expandedBytes,
  );

  const descriptorCrcMismatch = Buffer.from(signedDescriptor.bytes);
  descriptorCrcMismatch.writeUInt32LE(
    (descriptorCrcMismatch.readUInt32LE(signedDescriptor.dataEnd + 4) ^ 1) >>>
      0,
    signedDescriptor.dataEnd + 4,
  );
  expectSafetyCode(
    () => inspectDocxPackage(descriptorCrcMismatch),
    "DOCX_INVALID",
  );

  const descriptorBadSignature = Buffer.from(signedDescriptor.bytes);
  descriptorBadSignature.writeUInt32LE(0x09074b50, signedDescriptor.dataEnd);
  expectSafetyCode(
    () => inspectDocxPackage(descriptorBadSignature),
    "DOCX_INVALID",
  );

  const descriptorFlagMismatch = Buffer.from(signedDescriptor.bytes);
  const descriptorFlagEntry = testZipEntries(descriptorFlagMismatch).get(
    signedDescriptor.name,
  );
  assert(descriptorFlagEntry);
  descriptorFlagMismatch.writeUInt16LE(
    descriptorFlagMismatch.readUInt16LE(descriptorFlagEntry.localOffset + 6) &
      ~0x0008,
    descriptorFlagEntry.localOffset + 6,
  );
  expectSafetyCode(
    () => inspectDocxPackage(descriptorFlagMismatch),
    "DOCX_INVALID",
  );

  const hiddenDescriptor = descriptorLocalSizesMatchCentral(signedDescriptor);
  const hiddenDescriptorEntry = testZipEntries(hiddenDescriptor).get(
    signedDescriptor.name,
  );
  assert(hiddenDescriptorEntry);
  hiddenDescriptor.writeUInt16LE(
    hiddenDescriptor.readUInt16LE(hiddenDescriptorEntry.centralOffset + 8) &
      ~0x0008,
    hiddenDescriptorEntry.centralOffset + 8,
  );
  hiddenDescriptor.writeUInt16LE(
    hiddenDescriptor.readUInt16LE(hiddenDescriptorEntry.localOffset + 6) &
      ~0x0008,
    hiddenDescriptorEntry.localOffset + 6,
  );
  expectSafetyCode(() => inspectDocxPackage(hiddenDescriptor), "DOCX_INVALID");

  const rawText = await mammoth.extractRawText({ buffer: exported.bytes });
  assert(rawText.value.includes("合同审查"));
  assert(rawText.value.includes("付款义务"));
  assert(rawText.value.includes("人民币 5,000 元"));
  assert(rawText.value.includes("三十日"));
  assert(rawText.value.includes("诚信与公平"));

  const imported = await importDocumentStudioDocxToMarkdown({
    bytes: exported.bytes,
  });
  assert(imported.markdown.includes("付款义务"));
  assert(imported.markdown.includes("人民币 5,000 元"));
  assert(imported.markdown.includes("三十日"));
  assert(imported.markdown.includes("诚信与公平"));
  assert(
    imported.warnings.some(
      (warning) => warning.code === "DOCX_FORMATTING_SIMPLIFIED",
    ),
  );

  const external = editPart(
    exported.bytes,
    "word/_rels/document.xml.rels",
    (xml) =>
      xml.replace(
        "</Relationships>",
        '<Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid" TargetMode="External"/></Relationships>',
      ),
  );
  await expectStudioCode(
    () => importDocumentStudioDocxToMarkdown({ bytes: external }),
    "DOCX_EXTERNAL_RELATIONSHIP",
  );

  const unsafeRelationship = editPart(
    exported.bytes,
    "word/_rels/document.xml.rels",
    (xml) =>
      xml.replace(
        "</Relationships>",
        '<Relationship Id="escape" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../escape.png"/></Relationships>',
      ),
  );
  await expectStudioCode(
    () => importDocumentStudioDocxToMarkdown({ bytes: unsafeRelationship }),
    "DOCX_UNSAFE_PATH",
  );

  const encodedTraversal = editPart(
    exported.bytes,
    "word/_rels/document.xml.rels",
    (xml) =>
      xml.replace(
        "</Relationships>",
        '<Relationship Id="encoded-escape" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="%2e%2e%2fescape.png"/></Relationships>',
      ),
  );
  await expectStudioCode(
    () => importDocumentStudioDocxToMarkdown({ bytes: encodedTraversal }),
    "DOCX_UNSAFE_PATH",
  );

  const invalidEncoding = editPart(
    exported.bytes,
    "word/_rels/document.xml.rels",
    (xml) =>
      xml.replace(
        "</Relationships>",
        '<Relationship Id="invalid-encoding" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="bad%2-path.png"/></Relationships>',
      ),
  );
  await expectStudioCode(
    () => importDocumentStudioDocxToMarkdown({ bytes: invalidEncoding }),
    "DOCX_UNSAFE_PATH",
  );

  const tracked = editPart(exported.bytes, "word/document.xml", (xml) =>
    xml.replace(
      "</w:body>",
      "<w:ins><w:r><w:t>tracked</w:t></w:r></w:ins></w:body>",
    ),
  );
  await expectStudioCode(
    () => importDocumentStudioDocxToMarkdown({ bytes: tracked }),
    "DOCX_TRACKED_CHANGES",
  );

  const complexField = editPart(exported.bytes, "word/document.xml", (xml) =>
    xml.replace(
      "</w:body>",
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r></w:p></w:body>',
    ),
  );
  await expectStudioCode(
    () => importDocumentStudioDocxToMarkdown({ bytes: complexField }),
    "DOCX_ACTIVE_CONTENT",
  );

  const malformedXml = editPart(exported.bytes, "word/document.xml", (xml) =>
    xml.replace("</w:document>", ""),
  );
  await expectStudioCode(
    () => importDocumentStudioDocxToMarkdown({ bytes: malformedXml }),
    "DOCX_INVALID",
  );

  const entityXml = editPart(exported.bytes, "word/document.xml", (xml) =>
    xml.replace(
      "<w:document",
      '<!DOCTYPE w:document [<!ENTITY probe "unsafe">]><w:document',
    ),
  );
  await expectStudioCode(
    () => importDocumentStudioDocxToMarkdown({ bytes: entityXml }),
    "DOCX_INVALID",
  );

  const malformedCustomArchive = new PizZip(exported.bytes);
  malformedCustomArchive.file(
    "docProps/custom.xml",
    "<Properties><property></Properties>",
  );
  const malformedCustom = malformedCustomArchive.generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  }) as Buffer;
  await expectStudioCode(
    () => importDocumentStudioDocxToMarkdown({ bytes: malformedCustom }),
    "DOCX_INVALID",
  );

  const customEntityArchive = new PizZip(exported.bytes);
  customEntityArchive.file(
    "docProps/custom.xml",
    '<!DOCTYPE Properties [<!ENTITY probe "unsafe">]><Properties/>',
  );
  const customEntity = customEntityArchive.generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  }) as Buffer;
  await expectStudioCode(
    () => importDocumentStudioDocxToMarkdown({ bytes: customEntity }),
    "DOCX_INVALID",
  );

  const macroContentType = editPart(
    exported.bytes,
    "[Content_Types].xml",
    (xml) =>
      xml.replace(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        "application/vnd.ms-word.document.macroEnabled.main+xml",
      ),
  );
  await expectStudioCode(
    () => importDocumentStudioDocxToMarkdown({ bytes: macroContentType }),
    "DOCX_ACTIVE_CONTENT",
  );

  const unsafePathArchive = new PizZip(exported.bytes);
  unsafePathArchive.file("../escape.xml", "<escape/>");
  const unsafePathBytes = unsafePathArchive.generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  }) as Buffer;
  await expectStudioCode(
    () => importDocumentStudioDocxToMarkdown({ bytes: unsafePathBytes }),
    "DOCX_UNSAFE_PATH",
  );

  for (const [originalName, placeholderName] of [
    ["[Content_Types].xml", "[Content_Types].xmm"],
    ["word/document.xml", "word/documenz.xml"],
    ["word/_rels/document.xml.rels", "word/_rels/document.xml.relt"],
  ] as const) {
    const duplicate = duplicateZipEntry(
      exported.bytes,
      originalName,
      placeholderName,
    );
    assert.equal(
      Object.keys(new PizZip(duplicate).files).filter(
        (name) => name === originalName,
      ).length,
      1,
      "the public PizZip map must demonstrate duplicate-name folding",
    );
    expectSafetyCode(() => inspectDocxPackage(duplicate), "DOCX_INVALID");
  }

  const copiedDocument = zipWithCopiedEntry(
    exported.bytes,
    "word/document.xml",
    "word/documenz.xml",
  );
  const centralOnlyDuplicate = renameZipEntryHeader(
    copiedDocument,
    "word/documenz.xml",
    "word/document.xml",
    "central",
  );
  assert(
    Object.prototype.hasOwnProperty.call(
      new PizZip(centralOnlyDuplicate).files,
      "word/documenz.xml",
    ),
    "PizZip must demonstrate that a local name can overwrite the central name",
  );
  expectSafetyCode(
    () => inspectDocxPackage(centralOnlyDuplicate),
    "DOCX_INVALID",
  );

  const localOnlyDuplicate = renameZipEntryHeader(
    copiedDocument,
    "word/documenz.xml",
    "word/document.xml",
    "local",
  );
  expectSafetyCode(
    () => inspectDocxPackage(localOnlyDuplicate),
    "DOCX_INVALID",
  );

  const zip64Sentinel = Buffer.from(exported.bytes);
  const zip64SentinelEntry =
    testZipEntries(zip64Sentinel).get("word/document.xml");
  assert(zip64SentinelEntry);
  zip64Sentinel.writeUInt32LE(
    0xffffffff,
    zip64SentinelEntry.centralOffset + 24,
  );
  expectSafetyCode(() => inspectDocxPackage(zip64Sentinel), "DOCX_INVALID");

  const zip64Extra = addCentralZip64Extra(exported.bytes, "word/document.xml");
  expectSafetyCode(() => inspectDocxPackage(zip64Extra), "DOCX_INVALID");

  const zip64Locator = addZip64Locator(exported.bytes);
  expectSafetyCode(() => inspectDocxPackage(zip64Locator), "DOCX_INVALID");

  const bombArchive = new PizZip(exported.bytes);
  const bombBytes = Buffer.alloc(2 * 1024 * 1024, 0x41);
  bombArchive.file("audit/bomb.bin", bombBytes);
  const compressedBomb = bombArchive.generate({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  }) as Buffer;
  const bombEntry = testZipEntries(compressedBomb).get("audit/bomb.bin");
  assert(bombEntry);
  assert.equal(compressedBomb.readUInt16LE(bombEntry.centralOffset + 10), 8);
  assert.equal(
    compressedBomb.readUInt32LE(bombEntry.centralOffset + 24),
    bombBytes.length,
  );
  assert.equal(
    compressedBomb.readUInt32LE(bombEntry.localOffset + 22),
    bombBytes.length,
  );
  assert(
    compressedBomb.readUInt32LE(bombEntry.centralOffset + 20) < 4_096,
    "the expansion fixture must remain highly compressed",
  );
  const lyingBomb = lieAboutUncompressedSize(
    compressedBomb,
    "audit/bomb.bin",
    1,
  );
  const lyingBombEntry = testZipEntries(lyingBomb).get("audit/bomb.bin");
  assert(lyingBombEntry);
  assert.equal(lyingBomb.readUInt32LE(lyingBombEntry.centralOffset + 24), 1);
  assert.equal(lyingBomb.readUInt32LE(lyingBombEntry.localOffset + 22), 1);
  expectSafetyCode(
    () =>
      inspectDocxPackage(lyingBomb, {
        maxExpandedBytes: packageResult.expandedBytes + 1_024,
      }),
    "DOCX_TOO_LARGE",
  );

  const caseAmbiguousArchive = new PizZip(exported.bytes);
  caseAmbiguousArchive.file("WORD/DOCUMENT.XML", "<ambiguous/>");
  const caseAmbiguous = caseAmbiguousArchive.generate({
    type: "nodebuffer",
    compression: "STORE",
  }) as Buffer;
  expectSafetyCode(() => inspectDocxPackage(caseAmbiguous), "DOCX_INVALID");

  const entryArchive = new PizZip(exported.bytes);
  for (let index = 0; index <= DEFAULT_DOCX_MAX_ENTRIES; index += 1) {
    entryArchive.file(`audit/${String(index).padStart(4, "0")}.txt`, "");
  }
  const entryBytes = entryArchive.generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  }) as Buffer;
  expectSafetyCode(() => inspectDocxPackage(entryBytes), "DOCX_TOO_LARGE");
  const duplicateEntryBytes = collapseAuditEntryNames(entryBytes);
  assert(
    Object.keys(new PizZip(duplicateEntryBytes).files).length <
      DEFAULT_DOCX_MAX_ENTRIES,
    "the folded public archive must under-report the repeated raw entries",
  );
  expectSafetyCode(
    () => inspectDocxPackage(duplicateEntryBytes),
    "DOCX_TOO_LARGE",
  );
  assert.equal(DEFAULT_DOCX_MAX_ENTRIES, 5_000);

  await expectStudioCode(
    () =>
      exportDocumentStudioMarkdownToDocx({
        title: "Oversized Markdown",
        markdown: "x".repeat(DOCUMENT_STUDIO_MAX_MARKDOWN_BYTES + 1),
      }),
    "MARKDOWN_TOO_LARGE",
  );
  await expectStudioCode(
    () =>
      exportDocumentStudioMarkdownToDocx({
        title: "Complex Markdown",
        markdown: `\`\`\`text\n${"x\n".repeat(100_001)}\`\`\``,
      }),
    "MARKDOWN_TOO_COMPLEX",
  );
  await expectStudioCode(
    () =>
      importDocumentStudioDocxToMarkdown({
        bytes: Buffer.alloc(DOCUMENT_STUDIO_MAX_DOCX_BYTES + 1, 1),
      }),
    "DOCX_TOO_LARGE",
  );

  const withImage = await imageDocx();
  const imageImport = await importDocumentStudioDocxToMarkdown({
    bytes: withImage,
  });
  assert(imageImport.markdown.includes("Before image"));
  assert(imageImport.markdown.includes("After image"));
  assert(
    imageImport.warnings.some(
      (warning) => warning.code === "DOCX_IMAGES_IGNORED",
    ),
  );
  assert.equal(imageImport.markdown.includes("data:image"), false);

  console.log(
    JSON.stringify(
      {
        ok: true,
        suite: "vera-workspace-document-studio-docx-v1",
        checks: {
          mikeLegalLayoutAndUnicode: true,
          headingListTableReadableByMammoth: true,
          blockquoteContentPreservedWithWarning: true,
          sharedZipEntryAndPathLimits: true,
          duplicateZipEntriesRejectedBeforeArchiveFolding: true,
          centralAndLocalZipNamesCrossChecked: true,
          zip64PackagesRejected: true,
          compressedExpansionBoundedBeforePizZip: true,
          signedAndUnsignedDataDescriptorsVerified: true,
          malformedDataDescriptorsRejected: true,
          externalAndUnsafeRelationshipsRejected: true,
          trackedChangesAndComplexFieldsRejected: true,
          macroContentTypesRejected: true,
          malformedXmlAndEntitiesRejected: true,
          downstreamCustomPropertiesXmlValidated: true,
          markdownAndDocxLimits: true,
          renderedNodeBudget: true,
          imagesIgnoredWithWarning: true,
        },
      },
      null,
      2,
    ),
  );
}

void main();
