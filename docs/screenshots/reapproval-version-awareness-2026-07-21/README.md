# Reapproval after manual edits — desktop acceptance

Window size: 1152 × 768. The Mike reference is copied from the existing background-runner acceptance set at the same size.

- `00-mike-reference-1152x768.png`: Mike visual baseline.
- `01-vera-edited-after-approval-1152x768.png`: approved Word V1 was given a new V2 through the existing document version flow; the task derives `Review required`, marks only the edited output, and keeps the previous approved export available.
- `02-vera-reapproved-history-1152x768.png`: V2 was approved from the task page; the review record retains the earlier decision and appends the new approval.
- `03-vera-reapproved-150-percent-1152x768.png`: 150% zoom check.
- `04-vera-reapproved-125-percent-1152x768.png`: 125% zoom check.

Acceptance notes:

- The reapproval note was entered in Chinese and submitted with keyboard navigation (`Tab`, `Return`).
- The effective narrow widths at 125% and 150% preserve the single Mike-style primary column, wrap long text, and keep output actions reachable.
- The current Word version opens as V2; the locked export remains tied to the latest explicit approved snapshot.
- Excel version divergence, missing approved versions, locked-hash mismatch, and backward-compatible snapshots are covered by the focused backend smoke test.
