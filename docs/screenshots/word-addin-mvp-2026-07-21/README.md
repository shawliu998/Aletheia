# Vera Word Add-in MVP acceptance

## Visual truth

- Primary Mike Assistant truth: `../mike-work-task-alignment-2026-07-21/01-mike-reference-1728x851.png` (1728 × 851). `01-mike-assistant-reference-340x851.png` is the exact leftmost 340 × 851 crop, retaining the Mike navigation, gray selected state, compact labels, and restrained spacing without rescaling.
- Mike v0.4-derived Document side-panel density reference: `../mike-v040-baseline/project-document-preview-qa.png` (1585 × 851). That repository image already carries a Vera brand overlay, so it is a structural reference rather than pure Mike visual truth; `08-mike-derived-document-rail-reference-340x851.png` records its rightmost 340 × 851 rail.
- Vera task pane: `02-vera-browser-taskpane-340x851.png` (340 × 851).
- Same-size comparison: `03-mike-vera-side-by-side-680x851.png`, with the unscaled 340 × 851 pure Mike crop on the left and the 340 × 851 Vera pane on the right.
- Full-document suggestion queue: `04-vera-document-review-340x851.png` (340 × 851).
- Long Chinese review: `05-vera-chinese-review-340x851.png` (340 × 851).
- Current same-size comparison: `08-mike-vera-document-review-side-by-side-680x851.png`, with the unchanged Mike crop on the left and the full-document Vera review on the right.
- Polished Vera task pane: `11-vera-polished-document-review-340x851.png` (340 × 851).
- Polished same-size comparison: `15-mike-vera-polished-side-by-side-680x851.png`, with the unchanged Mike crop on the left and the refined Vera review pane on the right.

The Vera pane keeps Mike's restrained single-column composer language: quiet gray surfaces, compact labels, rounded controls, serif document text, a single suggestion surface, and one consequential action group. It does not copy the whole document editor or introduce a separate design system.

## Browser acceptance completed

- Production build route `/office/word?preview=ready` rendered at 340 × 851 with no console warnings or errors.
- Matter selection, suggestion generation fixture, pending-review diff, citations, disabled Office-only actions, and copy fallback are visible in the structured selection → suggestion → action path.
- Keyboard focus was visible on the native Matter selector; interactive controls are native `select`, `button`, `textarea`, and links with `focus-visible` treatment.
- `06-vera-long-chinese-340x851.png` verifies long Chinese selection and instruction text at 340 × 851. Measured document and body `scrollWidth` both remained 340 px.
- `04-vera-browser-zoom-125.png` uses a 272 × 681 CSS viewport to apply 125%-equivalent reflow pressure. `05-vera-browser-zoom-150.png` uses 227 × 567 for 150%-equivalent pressure. The 150% run measured `scrollWidth === clientWidth` (227 px).
- `07-vera-suggestion-actions-340x851.png` records the pending-review diff, source, disabled tracked-change/comment actions in browser preview, copy fallback, and the no-auto-accept notice.
- `04-vera-document-review-340x851.png` verifies the bounded suggestion queue, previous/next controls, exact original/replacement distinction, reason, sources, and one-at-a-time review actions.
- Queue navigation passed both pointer and keyboard activation. Skipping one item updates only that suggestion to `Skipped`; the other item remains pending.
- `05-vera-chinese-review-340x851.png` verifies that long Chinese original and replacement text wrap without horizontal overflow at the real task-pane width.
- `09-vera-document-review-125-equivalent-272x681.png` and `10-vera-document-review-150-equivalent-227x567.png` apply 125%/150%-equivalent reflow pressure to the current document queue. Both runs measured `scrollWidth === clientWidth`; the complete workflow remains vertically scrollable with no horizontal overflow.
- `12-vera-polished-150-equivalent-227x567.png` and `14-vera-polished-125-equivalent-272x681.png` repeat the reflow acceptance after visual polish. The suggestion counter and navigation remain on one line, compact actions reflow without horizontal overflow, and every consequential action retains a 44 px minimum height.
- `13-vera-polished-chinese-340x851.png` verifies the explicit `PingFang SC`/`Microsoft YaHei` CJK fallback and long Chinese original/replacement wrapping after the typography update.

The polish pass keeps Mike's pill geometry but removes glass blur, inset highlights, active scaling, and decorative multi-layer shadows. It also reduces legal diff text to a denser 14 px/24 px reading rhythm and moves `Skip` into the queue toolbar at normal Word task-pane widths. No workflow, API, Office host, authentication, permission, or document-mutation behavior changed.

These are browser tests, not Office Host tests. Preview fixtures never call the Matter chat API or mutate a document.

## Mac Word host acceptance

The development add-in has also passed a real Mac Word host smoke test using the existing synthetic document: host connection, Matter session, exact selection read, model generation, saved Matter chat, native comment insertion, and a native tracked replacement that remained pending in Word. The selection-scope reference capture is `office-addin/host-e2e/screenshots/word-host-deepseek-tracked-change-20260722.png`.

The document-scope path was then exercised in Word 16.111 with DeepSeek V4 Flash. Vera read the 167-character synthetic document, produced two short non-overlapping suggestions, preflighted both exact anchors, inserted the first as a pending native tracked change, and added the second as a native comment without changing its source text. `office-addin/host-e2e/screenshots/word-host-document-review-apply-comment-20260722.png` records the result.

The document queue reuses the already-tested `OfficeJsWordHost` methods for document context, exact document anchor lookup, comments, and tracked replacements. Each generated anchor is limited to 255 characters, one paragraph, one unique occurrence, and a non-overlapping passage. The current document context is capped at the first 20,000 characters and the task pane states that limit when it applies.

The remaining host regression checklist is:

1. Repeat the document-scope flow on a multi-page synthetic contract that crosses the 20,000-character boundary.
2. Verify the third `Skip` state in the real host; pointer and keyboard preview acceptance already passed.
3. Repeat long Chinese text at 125% and 150% Word zoom inside the Office Host. The current real-host run at 133% showed no horizontal overflow.

## Dependency and boundary record

- No npm or backend dependency was added; the existing lockfile and build configuration are unchanged.
- Office.js is loaded from Microsoft's hosted `https://appsforoffice.microsoft.com/lib/1/hosted/office.js` endpoint, so there is no vendored library, package-size increment, or third-party license addition.
- The implementation reuses the existing Matter list, selected-model state, and project Assistant Chat stream. It adds no table, API route, permission framework, document accept/reject route, or editor integration.
