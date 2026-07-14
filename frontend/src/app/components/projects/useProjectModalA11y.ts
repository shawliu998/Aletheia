"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Accessibility adapter for the quality-gated shared Mike modal primitive. */
export function useProjectModalA11y(
  open: boolean,
  onClose: () => void,
  contentRef: RefObject<HTMLDivElement | null>,
  ariaLabel: string,
  focusKey: string,
) {
  useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    function handleKeyDown(event: KeyboardEvent) {
      const panel = contentRef.current?.parentElement?.parentElement;
      if (!panel) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((element) => !element.hidden);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [contentRef, onClose, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = contentRef.current?.parentElement?.parentElement;
      panel?.setAttribute("role", "dialog");
      panel?.setAttribute("aria-modal", "true");
      panel?.setAttribute("aria-label", ariaLabel);
      panel
        ?.querySelector<HTMLElement>("[data-project-modal-autofocus]")
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ariaLabel, contentRef, focusKey, open]);
}
