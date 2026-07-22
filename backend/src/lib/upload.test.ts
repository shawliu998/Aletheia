import assert from "node:assert/strict";
import test from "node:test";

import { restoreUtf8MulterFilename } from "./upload";

test("keeps an ASCII multipart filename unchanged", () => {
  assert.equal(
    restoreUtf8MulterFilename("tabular-review.xlsx"),
    "tabular-review.xlsx",
  );
});

test("restores a UTF-8 Chinese filename misread as latin1", () => {
  const original = "跨境 合同审阅.xlsx";
  const mojibake = Buffer.from(original, "utf8").toString("latin1");

  assert.equal(restoreUtf8MulterFilename(mojibake), original);
});

test("fails safe for invalid UTF-8 and ordinary latin1 filenames", () => {
  const invalidUtf8 = "R\xE9sum\xE9.xlsx";
  assert.equal(restoreUtf8MulterFilename(invalidUtf8), invalidUtf8);

  // This sequence happens to be valid UTF-8 bytes, but decodes only to a
  // latin1 character; leave it untouched rather than guessing intent.
  const ambiguousLatin1 = "\xC2\xA9-notes.xlsx";
  assert.equal(
    restoreUtf8MulterFilename(ambiguousLatin1),
    ambiguousLatin1,
  );
});
