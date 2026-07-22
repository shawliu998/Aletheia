# Tabular source QA — 2026-07-22

This acceptance run uses a synthetic local-only matter and document. No user
document or personal account data is included.

## Mike baseline

- `mike-tabular-chat-1280x720.png`: unchanged Mike v0.4 layout at 1280 × 720.
- `mike-tabular-citation-highlight-1280x720.png`: selecting a chat citation
  highlights the referenced table cell; it does not open the original source.

## Vera capability increment

- `vera-tabular-one-click-source-1280x720.png`: the same citation opens the
  existing document source panel at the cited passage. The underlying table,
  chat layout, routes, and data contracts remain Mike-compatible.
- `vera-long-chinese-393x1200.png`: long Chinese titles and responses wrap or
  truncate without horizontal overflow.
- `vera-one-click-source-393x1200.png`: at a 393 px viewport, the source and
  cell-detail panes stack within the window instead of overflowing off-screen.

## Interaction and responsive checks

- Keyboard: the chat citation receives a visible 2 px focus outline and Enter
  opens the source panel.
- 125% equivalent: 1024 × 720 viewport, no horizontal overflow.
- 150% equivalent: 853 × 720 viewport, no horizontal overflow.
- The source resolver fails closed when a multi-citation cell cannot be matched
  to the chat excerpt, avoiding a jump to unrelated evidence.
