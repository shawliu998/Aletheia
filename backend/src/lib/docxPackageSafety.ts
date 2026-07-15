import { XMLParser, XMLValidator } from "fast-xml-parser";
import { TextDecoder } from "node:util";
import { inflateRawSync } from "node:zlib";
import PizZip from "pizzip";

export const DEFAULT_DOCX_MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_DOCX_MAX_EXPANDED_BYTES = 40 * 1024 * 1024;
export const DEFAULT_DOCX_MAX_ENTRIES = 5_000;

const MAX_XML_TRAVERSAL_NODES = 600_000;
const MAX_XML_TRAVERSAL_DEPTH = 256;

type XmlTraversalBudget = { visited: number };

export type DocxPackageSafetyErrorCode =
  | "DOCX_INVALID"
  | "DOCX_TOO_LARGE"
  | "DOCX_UNSAFE_PATH"
  | "DOCX_ACTIVE_CONTENT"
  | "DOCX_EXTERNAL_RELATIONSHIP"
  | "DOCX_TRACKED_CHANGES"
  | "DOCX_REQUIRED_PART_MISSING";

export class DocxPackageSafetyError extends Error {
  constructor(
    message: string,
    readonly code: DocxPackageSafetyErrorCode,
  ) {
    super(message);
    this.name = "DocxPackageSafetyError";
  }
}

export type DocxPackageWarning = {
  code: "DOCX_IMAGES_IGNORED";
  message: string;
};

export type InspectDocxPackageOptions = {
  maxInputBytes?: number;
  maxExpandedBytes?: number;
  maxEntries?: number;
  requiredParts?: readonly string[];
  drawingPolicy?: "reject" | "warn";
};

const objectParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
  processEntities: false,
});
const orderedParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
  processEntities: false,
});

function safetyError(code: DocxPackageSafetyErrorCode, message: string): never {
  throw new DocxPackageSafetyError(message, code);
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function parseXml(xml: string, label: string, ordered = false): unknown {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    return safetyError(
      "DOCX_INVALID",
      `${label} contains a forbidden document type or entity declaration.`,
    );
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    return safetyError("DOCX_INVALID", `${label} is not valid XML.`);
  }
  try {
    return (ordered ? orderedParser : objectParser).parse(xml);
  } catch {
    return safetyError("DOCX_INVALID", `${label} is not valid XML.`);
  }
}

function walkObject(
  value: unknown,
  visit: (key: string, value: unknown) => void,
  budget: XmlTraversalBudget = { visited: 0 },
): void {
  const pending: Array<{ value: unknown; depth: number }> = [
    { value, depth: 0 },
  ];
  while (pending.length > 0) {
    const current = pending.pop()!;
    budget.visited += 1;
    if (budget.visited > MAX_XML_TRAVERSAL_NODES) {
      safetyError("DOCX_INVALID", "DOCX XML contains too many nodes.");
    }
    if (current.depth > MAX_XML_TRAVERSAL_DEPTH) {
      safetyError("DOCX_INVALID", "DOCX XML nesting is too deep.");
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: current.value[index],
          depth: current.depth + 1,
        });
      }
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    for (const [key, item] of Object.entries(
      current.value as Record<string, unknown>,
    )) {
      visit(key, item);
      if (item && typeof item === "object") {
        pending.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
}

function localName(value: string): string {
  return value.split(":").at(-1) ?? value;
}

function isUnsafePackagePath(name: string): boolean {
  if (
    !name ||
    name.includes("\0") ||
    name.startsWith("/") ||
    name.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(name)
  ) {
    return true;
  }
  const segments = name.split("/");
  return segments.some(
    (part, index) =>
      part === "." ||
      part === ".." ||
      (part === "" && index !== segments.length - 1),
  );
}

function canonicalPackagePath(name: string): string {
  return name.normalize("NFC").replace(/\/+$/u, "").toLowerCase();
}

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const ZIP_DATA_DESCRIPTOR = 0x08074b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DATA_DESCRIPTOR_FLAG = 0x0008;
const ZIP_ENCRYPTED_FLAGS = 0x0041;
const ZIP_ALLOWED_FLAGS = 0x080e;
const ZIP_STORE = 0;
const ZIP_DEFLATE = 8;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const ZIP_MAX_ENTRY_NAME_BYTES = 4_096;

type ZipLocalRange = Readonly<{
  start: number;
  end: number;
}>;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function invalidZip(message: string): never {
  return safetyError("DOCX_INVALID", message);
}

function readUInt16(bytes: Buffer, offset: number, label: string): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    return invalidZip(`The DOCX contains a truncated ${label}.`);
  }
  return bytes.readUInt16LE(offset);
}

function readUInt32(bytes: Buffer, offset: number, label: string): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    return invalidZip(`The DOCX contains a truncated ${label}.`);
  }
  return bytes.readUInt32LE(offset);
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const earliest = Math.max(0, bytes.length - (22 + ZIP_MAX_COMMENT_BYTES));
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = readUInt16(
      bytes,
      offset + 20,
      "ZIP end-of-directory record",
    );
    if (offset + 22 + commentLength === bytes.length) return offset;
  }
  return invalidZip("The uploaded file is not a valid DOCX ZIP package.");
}

function assertNoZip64Extra(extra: Buffer, label: string): void {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) {
      invalidZip(`The DOCX contains a malformed ${label} extra field.`);
    }
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + size > extra.length) {
      invalidZip(`The DOCX contains a truncated ${label} extra field.`);
    }
    if (id === ZIP64_EXTRA_FIELD) {
      invalidZip("ZIP64 DOCX packages are not supported.");
    }
    offset += size;
  }
}

function decodeEntryName(nameBytes: Buffer): string {
  if (nameBytes.length < 1 || nameBytes.length > ZIP_MAX_ENTRY_NAME_BYTES) {
    return safetyError(
      "DOCX_UNSAFE_PATH",
      "The DOCX contains an invalid package path length.",
    );
  }
  try {
    return utf8Decoder.decode(nameBytes);
  } catch {
    return safetyError(
      "DOCX_UNSAFE_PATH",
      "The DOCX contains a package path that is not valid UTF-8.",
    );
  }
}

let crc32Table: Uint32Array | undefined;

function calculateCrc32(bytes: Buffer): number {
  if (!crc32Table) {
    crc32Table = new Uint32Array(256);
    for (let index = 0; index < crc32Table.length; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
      }
      crc32Table[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ value) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function inflateEntryWithinBudget(
  compressed: Buffer,
  method: number,
  remainingBudget: number,
): Buffer {
  if (method === ZIP_STORE) return compressed;
  try {
    return inflateRawSync(compressed, {
      maxOutputLength: remainingBudget + 1,
    });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_BUFFER_TOO_LARGE"
    ) {
      return safetyError(
        "DOCX_TOO_LARGE",
        "The DOCX expands beyond the configured safety limit.",
      );
    }
    return invalidZip("The DOCX contains invalid compressed ZIP data.");
  }
}

function descriptorTupleMatches(
  bytes: Buffer,
  offset: number,
  limit: number,
  crc32: number,
  compressedSize: number,
  uncompressedSize: number,
): boolean {
  return (
    offset >= 0 &&
    offset + 12 <= limit &&
    bytes.readUInt32LE(offset) === crc32 &&
    bytes.readUInt32LE(offset + 4) === compressedSize &&
    bytes.readUInt32LE(offset + 8) === uncompressedSize
  );
}

function dataDescriptorEnd(
  bytes: Buffer,
  dataEnd: number,
  centralOffset: number,
  crc32: number,
  compressedSize: number,
  uncompressedSize: number,
): number {
  const candidates: number[] = [];
  if (
    descriptorTupleMatches(
      bytes,
      dataEnd,
      centralOffset,
      crc32,
      compressedSize,
      uncompressedSize,
    )
  ) {
    candidates.push(dataEnd + 12);
  }
  if (
    dataEnd + 4 <= centralOffset &&
    bytes.readUInt32LE(dataEnd) === ZIP_DATA_DESCRIPTOR &&
    descriptorTupleMatches(
      bytes,
      dataEnd + 4,
      centralOffset,
      crc32,
      compressedSize,
      uncompressedSize,
    )
  ) {
    candidates.push(dataEnd + 16);
  }
  if (candidates.length !== 1) {
    invalidZip("The DOCX contains a malformed or ambiguous data descriptor.");
  }
  return candidates[0]!;
}

function inspectCentralDirectory(
  bytes: Buffer,
  maxEntries: number,
  maxExpandedBytes: number,
): { names: readonly string[]; expandedBytes: number } {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const diskNumber = readUInt16(bytes, eocdOffset + 4, "ZIP directory");
  const centralDisk = readUInt16(bytes, eocdOffset + 6, "ZIP directory");
  const recordsOnDisk = readUInt16(bytes, eocdOffset + 8, "ZIP directory");
  const recordCount = readUInt16(bytes, eocdOffset + 10, "ZIP directory");
  const centralSize = readUInt32(bytes, eocdOffset + 12, "ZIP directory");
  const centralOffset = readUInt32(bytes, eocdOffset + 16, "ZIP directory");

  if (
    diskNumber === 0xffff ||
    centralDisk === 0xffff ||
    recordsOnDisk === 0xffff ||
    recordCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    invalidZip("ZIP64 DOCX packages are not supported.");
  }
  if (recordCount > maxEntries) {
    safetyError(
      "DOCX_TOO_LARGE",
      `The DOCX contains more than ${maxEntries} ZIP entries.`,
    );
  }
  if (diskNumber !== 0 || centralDisk !== 0 || recordsOnDisk !== recordCount) {
    invalidZip("Split DOCX ZIP packages are not allowed.");
  }
  const centralEnd = centralOffset + centralSize;
  if (
    (eocdOffset >= 20 &&
      readUInt32(bytes, eocdOffset - 20, "ZIP64 locator") ===
        ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR) ||
    (centralEnd + 4 <= eocdOffset &&
      readUInt32(bytes, centralEnd, "ZIP64 directory") ===
        ZIP64_END_OF_CENTRAL_DIRECTORY)
  ) {
    invalidZip("ZIP64 DOCX packages are not supported.");
  }
  if (centralEnd !== eocdOffset) {
    invalidZip("The DOCX contains an inconsistent ZIP directory offset.");
  }
  if (centralOffset > bytes.length || centralSize > bytes.length) {
    invalidZip("The DOCX contains an out-of-bounds ZIP directory.");
  }

  const names: string[] = [];
  const canonicalNames = new Set<string>();
  const localRanges: ZipLocalRange[] = [];
  let expandedBytes = 0;
  let declaredExpandedBytes = 0;
  let cursor = centralOffset;

  for (let index = 0; index < recordCount; index += 1) {
    if (
      cursor + 46 > eocdOffset ||
      readUInt32(bytes, cursor, "ZIP central-directory header") !==
        ZIP_CENTRAL_DIRECTORY_HEADER
    ) {
      invalidZip("The DOCX contains a malformed ZIP central directory.");
    }
    const flags = readUInt16(bytes, cursor + 8, "ZIP entry flags");
    const method = readUInt16(bytes, cursor + 10, "ZIP compression method");
    const modifiedTime = readUInt16(bytes, cursor + 12, "ZIP timestamp");
    const modifiedDate = readUInt16(bytes, cursor + 14, "ZIP timestamp");
    const crc32 = readUInt32(bytes, cursor + 16, "ZIP CRC");
    const compressedSize = readUInt32(
      bytes,
      cursor + 20,
      "ZIP compressed size",
    );
    const uncompressedSize = readUInt32(
      bytes,
      cursor + 24,
      "ZIP uncompressed size",
    );
    const nameLength = readUInt16(bytes, cursor + 28, "ZIP filename");
    const extraLength = readUInt16(bytes, cursor + 30, "ZIP extra field");
    const commentLength = readUInt16(bytes, cursor + 32, "ZIP comment");
    const diskStart = readUInt16(bytes, cursor + 34, "ZIP disk number");
    const localOffset = readUInt32(
      bytes,
      cursor + 42,
      "ZIP local-header offset",
    );
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      diskStart === 0xffff ||
      localOffset === 0xffffffff
    ) {
      invalidZip("ZIP64 DOCX packages are not supported.");
    }
    if (diskStart !== 0) {
      invalidZip("Split DOCX ZIP entries are not allowed.");
    }
    if ((flags & ZIP_ENCRYPTED_FLAGS) !== 0) {
      invalidZip("Encrypted DOCX ZIP entries are not allowed.");
    }
    if ((flags & ~ZIP_ALLOWED_FLAGS) !== 0) {
      invalidZip("The DOCX contains unsupported ZIP entry flags.");
    }
    if (method !== ZIP_STORE && method !== ZIP_DEFLATE) {
      invalidZip("The DOCX contains an unsupported ZIP compression method.");
    }
    if (method === ZIP_STORE && compressedSize !== uncompressedSize) {
      invalidZip("The DOCX contains an inconsistent stored ZIP entry.");
    }

    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > eocdOffset) {
      invalidZip("The DOCX contains a truncated ZIP central-directory entry.");
    }
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    if (
      (flags & ZIP_UTF8_FLAG) === 0 &&
      nameBytes.some((value) => value > 0x7f)
    ) {
      invalidZip("Non-ASCII DOCX paths must use the ZIP UTF-8 flag.");
    }
    const name = decodeEntryName(nameBytes);
    const centralExtra = bytes.subarray(
      cursor + 46 + nameLength,
      cursor + 46 + nameLength + extraLength,
    );
    assertNoZip64Extra(centralExtra, "central-directory");
    if (isUnsafePackagePath(name)) {
      safetyError(
        "DOCX_UNSAFE_PATH",
        "The DOCX contains an unsafe package path.",
      );
    }
    const canonicalName = canonicalPackagePath(name);
    if (!canonicalName || canonicalNames.has(canonicalName)) {
      safetyError(
        "DOCX_INVALID",
        "The DOCX contains duplicate or ambiguous ZIP entry names.",
      );
    }
    canonicalNames.add(canonicalName);
    names.push(name);

    if (declaredExpandedBytes > maxExpandedBytes - uncompressedSize) {
      safetyError(
        "DOCX_TOO_LARGE",
        `The DOCX expands beyond the ${maxExpandedBytes} byte safety limit.`,
      );
    }
    declaredExpandedBytes += uncompressedSize;

    if (
      localOffset + 30 > centralOffset ||
      readUInt32(bytes, localOffset, "ZIP local-file header") !==
        ZIP_LOCAL_FILE_HEADER
    ) {
      invalidZip("The DOCX contains an invalid ZIP local-file header.");
    }
    const localFlags = readUInt16(bytes, localOffset + 6, "ZIP entry flags");
    const localMethod = readUInt16(
      bytes,
      localOffset + 8,
      "ZIP compression method",
    );
    const localModifiedTime = readUInt16(
      bytes,
      localOffset + 10,
      "ZIP timestamp",
    );
    const localModifiedDate = readUInt16(
      bytes,
      localOffset + 12,
      "ZIP timestamp",
    );
    const localCrc32 = readUInt32(bytes, localOffset + 14, "ZIP CRC");
    const localCompressedSize = readUInt32(
      bytes,
      localOffset + 18,
      "ZIP compressed size",
    );
    const localUncompressedSize = readUInt32(
      bytes,
      localOffset + 22,
      "ZIP uncompressed size",
    );
    const localNameLength = readUInt16(bytes, localOffset + 26, "ZIP filename");
    const localExtraLength = readUInt16(
      bytes,
      localOffset + 28,
      "ZIP extra field",
    );
    if (
      localCompressedSize === 0xffffffff ||
      localUncompressedSize === 0xffffffff
    ) {
      invalidZip("ZIP64 DOCX packages are not supported.");
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataStart > centralOffset || dataEnd > centralOffset) {
      invalidZip("The DOCX contains out-of-bounds ZIP entry data.");
    }
    const localNameBytes = bytes.subarray(
      localOffset + 30,
      localOffset + 30 + localNameLength,
    );
    const localExtra = bytes.subarray(
      localOffset + 30 + localNameLength,
      dataStart,
    );
    assertNoZip64Extra(localExtra, "local-header");
    const usesDataDescriptor =
      (flags & ZIP_DATA_DESCRIPTOR_FLAG) === ZIP_DATA_DESCRIPTOR_FLAG;
    const localSizesAreZero =
      localCrc32 === 0 &&
      localCompressedSize === 0 &&
      localUncompressedSize === 0;
    const localSizesMatchCentral =
      localCrc32 === crc32 &&
      localCompressedSize === compressedSize &&
      localUncompressedSize === uncompressedSize;
    if (
      !localNameBytes.equals(nameBytes) ||
      localFlags !== flags ||
      localMethod !== method ||
      localModifiedTime !== modifiedTime ||
      localModifiedDate !== modifiedDate ||
      (usesDataDescriptor
        ? !localSizesAreZero && !localSizesMatchCentral
        : !localSizesMatchCentral)
    ) {
      invalidZip(
        "The DOCX contains inconsistent ZIP central and local headers.",
      );
    }
    const localRangeEnd = usesDataDescriptor
      ? dataDescriptorEnd(
          bytes,
          dataEnd,
          centralOffset,
          crc32,
          compressedSize,
          uncompressedSize,
        )
      : dataEnd;
    localRanges.push({ start: localOffset, end: localRangeEnd });

    const remainingBudget = maxExpandedBytes - expandedBytes;
    const expanded = inflateEntryWithinBudget(
      bytes.subarray(dataStart, dataEnd),
      method,
      remainingBudget,
    );
    if (expanded.byteLength > remainingBudget) {
      safetyError(
        "DOCX_TOO_LARGE",
        `The DOCX expands beyond the ${maxExpandedBytes} byte safety limit.`,
      );
    }
    if (expanded.byteLength !== uncompressedSize) {
      invalidZip("The DOCX contains an inconsistent compressed entry size.");
    }
    if (calculateCrc32(expanded) !== crc32) {
      invalidZip("The DOCX contains an invalid compressed-entry checksum.");
    }
    expandedBytes += expanded.byteLength;
    cursor = entryEnd;
  }

  if (cursor !== eocdOffset || cursor - centralOffset !== centralSize) {
    invalidZip("The DOCX contains an inconsistent ZIP central directory.");
  }
  localRanges.sort((left, right) => left.start - right.start);
  let expectedLocalOffset = 0;
  for (const range of localRanges) {
    if (range.start !== expectedLocalOffset || range.end < range.start) {
      invalidZip("The DOCX contains overlapping or hidden ZIP entry data.");
    }
    expectedLocalOffset = range.end;
  }
  if (expectedLocalOffset !== centralOffset) {
    invalidZip("The DOCX contains unreferenced ZIP data before its directory.");
  }
  if (expandedBytes !== declaredExpandedBytes) {
    invalidZip("The DOCX contains inconsistent ZIP expansion metadata.");
  }
  return { names, expandedBytes };
}

function relationshipTargetIsUnsafe(target: string): boolean {
  const pathTarget = target.split(/[?#]/, 1)[0];
  return (
    !target ||
    target.includes("\0") ||
    target.includes("\\") ||
    pathTarget.startsWith("/") ||
    pathTarget.split("/").some((segment) => segment === "." || segment === "..")
  );
}

function assertSafeRelationshipTarget(target: string): void {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    safetyError(
      "DOCX_UNSAFE_PATH",
      "The DOCX contains an invalid percent-encoded relationship target.",
    );
  }
  if (
    [target, decoded].some((candidate) =>
      /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(candidate),
    )
  ) {
    safetyError(
      "DOCX_EXTERNAL_RELATIONSHIP",
      "External DOCX relationships are not allowed.",
    );
  }
  if (
    relationshipTargetIsUnsafe(target) ||
    relationshipTargetIsUnsafe(decoded)
  ) {
    safetyError(
      "DOCX_UNSAFE_PATH",
      "The DOCX contains an unsafe relationship target.",
    );
  }
}

function inspectRelationships(
  archive: PizZip,
  traversalBudget: XmlTraversalBudget,
): void {
  const relationFiles = Object.keys(archive.files).filter((name) =>
    name.toLowerCase().endsWith(".rels"),
  );
  for (const name of relationFiles) {
    const file = archive.file(name);
    if (!file) continue;
    const parsed = parseXml(file.asText(), name);
    walkObject(
      parsed,
      (key, value) => {
        if (localName(key) !== "Relationship") return;
        const rows = Array.isArray(value) ? value : [value];
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          const relation = row as Record<string, unknown>;
          const targetMode = String(relation["@_TargetMode"] ?? "")
            .trim()
            .toLowerCase();
          const target = String(relation["@_Target"] ?? "").trim();
          if (targetMode === "external") {
            safetyError(
              "DOCX_EXTERNAL_RELATIONSHIP",
              "External DOCX relationships are not allowed.",
            );
          }
          assertSafeRelationshipTarget(target);
          const relationshipType = String(relation["@_Type"] ?? "")
            .split("/")
            .at(-1)
            ?.toLowerCase();
          if (
            relationshipType &&
            ["attachedtemplate", "oleobject", "package"].includes(
              relationshipType,
            )
          ) {
            safetyError(
              "DOCX_ACTIVE_CONTENT",
              "Attached templates and embedded packages are not allowed.",
            );
          }
        }
      },
      traversalBudget,
    );
  }
}

function packageDocumentTags(
  archive: PizZip,
  traversalBudget: XmlTraversalBudget,
): Set<string> {
  const documentXml = archive.file("word/document.xml")?.asText();
  if (documentXml === undefined) {
    return safetyError(
      "DOCX_REQUIRED_PART_MISSING",
      "The DOCX is missing word/document.xml.",
    );
  }
  const tags = new Set<string>();
  const wordXmlParts = Object.keys(archive.files).filter(
    (name) =>
      name.toLowerCase().startsWith("word/") &&
      name.toLowerCase().endsWith(".xml"),
  );
  for (const name of wordXmlParts) {
    const xml = archive.file(name)?.asText();
    if (xml === undefined) continue;
    const parsed = parseXml(xml, `DOCX part ${name}`, true) as Record<
      string,
      unknown
    >[];
    walkObject(
      parsed,
      (key) => {
        if (key !== ":@" && key !== "#text" && !key.startsWith("@_")) {
          tags.add(key);
        }
      },
      traversalBudget,
    );
  }
  return tags;
}

function inspectContentTypes(
  archive: PizZip,
  traversalBudget: XmlTraversalBudget,
): void {
  const xml = archive.file("[Content_Types].xml")?.asText();
  if (xml === undefined) {
    safetyError(
      "DOCX_REQUIRED_PART_MISSING",
      "The DOCX is missing [Content_Types].xml.",
    );
  }
  const parsed = parseXml(xml, "DOCX content types");
  walkObject(parsed, () => undefined, traversalBudget);
  if (
    /(?:macroenabled|vbaproject|activex|oleobject|embeddedpackage)/i.test(xml)
  ) {
    safetyError(
      "DOCX_ACTIVE_CONTENT",
      "Macro-enabled and embedded active content types are not allowed.",
    );
  }
}

function inspectRemainingXmlParts(
  archive: PizZip,
  traversalBudget: XmlTraversalBudget,
): void {
  const names = Object.keys(archive.files).filter((name) => {
    const lower = name.toLowerCase();
    return (
      lower.endsWith(".xml") &&
      lower !== "[content_types].xml" &&
      !lower.startsWith("word/")
    );
  });
  for (const name of names) {
    const xml = archive.file(name)?.asText();
    if (xml === undefined) continue;
    const parsed = parseXml(xml, `DOCX part ${name}`, true);
    walkObject(parsed, () => undefined, traversalBudget);
  }
}

function containsLocalTag(
  tags: Set<string>,
  names: readonly string[],
): boolean {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return [...tags].some((tag) => wanted.has(localName(tag).toLowerCase()));
}

/**
 * Performs the one shared, fail-closed inspection used before any Vera DOCX
 * parser. It returns an in-memory archive only after package paths, expansion,
 * relationships, active content, and the main OOXML document have passed.
 */
export function inspectDocxPackage(
  bytes: Buffer,
  options: InspectDocxPackageOptions = {},
): { archive: PizZip; warnings: DocxPackageWarning[]; expandedBytes: number } {
  const maxInputBytes = boundedLimit(
    options.maxInputBytes,
    DEFAULT_DOCX_MAX_INPUT_BYTES,
  );
  const maxExpandedBytes = boundedLimit(
    options.maxExpandedBytes,
    DEFAULT_DOCX_MAX_EXPANDED_BYTES,
  );
  const maxEntries = boundedLimit(options.maxEntries, DEFAULT_DOCX_MAX_ENTRIES);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length < 1 ||
    bytes.length > maxInputBytes
  ) {
    safetyError(
      "DOCX_TOO_LARGE",
      `DOCX must be between 1 byte and ${maxInputBytes} bytes.`,
    );
  }

  const centralDirectory = inspectCentralDirectory(
    bytes,
    maxEntries,
    maxExpandedBytes,
  );

  let archive: PizZip;
  try {
    archive = new PizZip(bytes);
  } catch {
    return safetyError(
      "DOCX_INVALID",
      "The uploaded file is not a valid DOCX package.",
    );
  }

  const names = Object.keys(archive.files);
  const centralDirectoryNames = new Set(centralDirectory.names);
  if (
    names.length !== centralDirectory.names.length ||
    names.some((name) => !centralDirectoryNames.has(name))
  ) {
    safetyError(
      "DOCX_INVALID",
      "The DOCX ZIP directory could not be represented without ambiguity.",
    );
  }
  const requiredParts = options.requiredParts ?? [
    "[Content_Types].xml",
    "word/document.xml",
  ];
  for (const requiredPart of requiredParts) {
    if (!names.includes(requiredPart) || !archive.file(requiredPart)) {
      safetyError(
        "DOCX_REQUIRED_PART_MISSING",
        `The DOCX is missing ${requiredPart}.`,
      );
    }
  }

  // Raw preflight has already bounded and verified every entry's actual
  // expansion before PizZip can allocate it. Later XML reads are therefore
  // limited to this already-proven package-wide budget.
  const expandedBytes = centralDirectory.expandedBytes;

  const lowerNames = names.map((name) => name.toLowerCase());
  if (
    lowerNames.some((name) =>
      /(^|\/)(encryptioninfo|encryptedpackage)$/.test(name),
    )
  ) {
    safetyError(
      "DOCX_ACTIVE_CONTENT",
      "Encrypted DOCX packages cannot be inspected safely.",
    );
  }
  if (
    lowerNames.some(
      (name) =>
        /(^|\/)vbaproject\.bin$/.test(name) ||
        name.startsWith("word/activex/") ||
        name.startsWith("word/embeddings/") ||
        name.startsWith("word/oleobject") ||
        name.startsWith("customxml/"),
    )
  ) {
    safetyError(
      "DOCX_ACTIVE_CONTENT",
      "Macros, ActiveX, embedded objects, OLE, and custom XML are not allowed.",
    );
  }

  const traversalBudget: XmlTraversalBudget = { visited: 0 };
  inspectContentTypes(archive, traversalBudget);
  inspectRelationships(archive, traversalBudget);
  const tags = packageDocumentTags(archive, traversalBudget);
  inspectRemainingXmlParts(archive, traversalBudget);
  if (containsLocalTag(tags, ["ins", "del", "moveFrom", "moveTo"])) {
    safetyError(
      "DOCX_TRACKED_CHANGES",
      "Accept or reject all tracked changes in Word before importing this DOCX.",
    );
  }
  if (
    containsLocalTag(tags, [
      "altChunk",
      "object",
      "oleObject",
      "fldSimple",
      "fldChar",
      "instrText",
      "pict",
      "txbxContent",
    ])
  ) {
    safetyError(
      "DOCX_ACTIVE_CONTENT",
      "Alternate content, executable fields, and embedded objects are not allowed.",
    );
  }

  const warnings: DocxPackageWarning[] = [];
  const hasDrawing = containsLocalTag(tags, ["drawing"]);
  const hasImageParts = lowerNames.some((name) =>
    name.startsWith("word/media/"),
  );
  if (hasDrawing || hasImageParts) {
    if ((options.drawingPolicy ?? "reject") === "reject") {
      safetyError(
        "DOCX_ACTIVE_CONTENT",
        "Embedded drawings and images are not allowed.",
      );
    }
    warnings.push({
      code: "DOCX_IMAGES_IGNORED",
      message:
        "Embedded DOCX drawings and images are ignored during Markdown import.",
    });
  }

  return { archive, warnings, expandedBytes };
}
