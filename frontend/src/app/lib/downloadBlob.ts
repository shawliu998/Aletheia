/** Trigger a browser download for a response that has already been validated. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  queueMicrotask(() => URL.revokeObjectURL(url));
}

/**
 * Native save dialogs report a cancellation as an AbortError (or an explicit
 * `canceled` result). Browser downloads do not expose their save dialog, but
 * callers can use this guard when a desktop bridge is available.
 */
export function isSaveDialogCancellation(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; canceled?: unknown };
  return candidate.name === "AbortError" || candidate.canceled === true;
}
