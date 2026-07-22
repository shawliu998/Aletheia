import type { RequestHandler } from "express";
import multer from "multer";

export const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_SIZE_MB = Math.round(
  MAX_UPLOAD_SIZE_BYTES / (1024 * 1024),
);

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_SIZE_BYTES,
    files: 1,
  },
});

/**
 * Busboy/Multer can expose a UTF-8 multipart filename as a latin1 string.
 * Recover only a conservative case: the latin1 bytes form valid UTF-8 and
 * the result contains a character outside latin1. This fixes CJK/emoji names
 * while leaving ASCII, ordinary latin1, and invalid byte sequences untouched.
 */
export function restoreUtf8MulterFilename(filename: string): string {
  if (!/[\x80-\xFF]/.test(filename)) return filename;

  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(filename, "latin1"),
    );
    if (
      decoded !== filename &&
      [...decoded].some((character) => character.codePointAt(0)! > 0xff)
    ) {
      return decoded;
    }
  } catch {
    // Invalid UTF-8 bytes are not safe to reinterpret.
  }
  return filename;
}

export function singleFileUpload(fieldName: string): RequestHandler {
  return (req, res, next) => {
    memoryUpload.single(fieldName)(req, res, (err) => {
      if (!err) {
        if (req.file?.originalname) {
          req.file.originalname = restoreUtf8MulterFilename(
            req.file.originalname,
          );
        }
        return next();
      }

      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return void res.status(413).json({
            detail: `File too large. Maximum size is ${MAX_UPLOAD_SIZE_MB} MB.`,
          });
        }
        return void res.status(400).json({
          detail: `Upload failed: ${err.message}`,
        });
      }

      return next(err);
    });
  };
}
