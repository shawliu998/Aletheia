# Vera macOS Word Add-in — review UX specification

**Status:** implementation-ready UX specification; no product code, manifest, API, permission, security, or backend change is included.

**Canonical host artboard:** **340 × 851 CSS px at 100% zoom**. This is the real narrow Word task-pane baseline already exercised by Vera, not a mobile breakpoint. The pane may grow wider, but must not depend on width greater than 340 px for its primary path.

## Visual truth and acceptance comparison

| Reference | Exact size | What is binding |
| --- | ---: | --- |
| Mike Assistant crop | 340 × 851 | quiet white/gray surface, compact labels, black consequential action, generous empty space, serif document text |
| Current Vera Word pane | 340 × 851 | Matter → selection → instruction → suggestion sequence, document text card, grouped controls |
| Proposed Vera review artboard | 340 × 851 | same Mike density and interaction rhythm; adds a review queue only when more than one suggestion exists |

The existing unscaled comparison is [03-mike-vera-side-by-side-680x851.png](/Users/a1-6/.codex/worktrees/433a/new%20agent/docs/screenshots/word-addin-mvp-2026-07-21/03-mike-vera-side-by-side-680x851.png). Current verification evidence is in [the Word MVP acceptance record](/Users/a1-6/.codex/worktrees/433a/new%20agent/docs/screenshots/word-addin-mvp-2026-07-21/README.md). The companion same-size proposed sketch is [word-addin-review-sketch-340x851.svg](word-addin-review-sketch-340x851.svg).

### Source distinction

| Source | Reuse | Deliberately not copied |
| --- | --- | --- |
| Mike | neutral canvas, compact typography, rounded white controls, one dark consequential button, visible focus language | desktop sidebar, full workspace navigation, an alternate visual system |
| Current Vera Word pane | Matter selector, Word selection refresh, Review/Rewrite mode, current model egress notice, inline red/green diff, tracked change/comment/copy actions, source link | a long serial form before a reviewer can see the first result; a one-result-only mental model |
| Legora Word walkthrough | document-adjacent entry points, selected-text contextual action, progressive suggestion review, workflow and prompt entry at the composer | its identity, orange/green styling, global product tabs, mass "apply all" default, or any implication that Vera auto-accepts a Word change |
| Harvey / Spellbook pattern (interaction reference) | anchored, individually reviewable edits; reviewer retains final decision; source/reason stays close to the proposed change | bulk unreviewed document rewrite, hidden anchor failure, or a separate editor/workbench inside the task pane |

## Scope and object model

No new table, page, generalized review framework, or permission model is warranted. The requirement is carried by existing objects:

| Need | Existing object / contract | Surface treatment |
| --- | --- | --- |
| legal context | selected **Matter** | compact selector in the persistent header area |
| text to change | current Word **selection** plus original-text snapshot | selection excerpt and its freshness state |
| suggestion and explanation | existing Assistant **chat** result / citation payload | single diff card; link opens the saved Matter chat |
| individual accept / reject | existing Word review action | tracked replacement, comment, or copy; Word remains the final review surface |
| multiple outputs and workflow execution | existing **Task**, **artifact**, **review**, and **Workflow** objects | ordered review cards and a Workflow result summary; no new queue object |

This increment shortens review time and controls a consequential edit. It must not show hashes, internal IDs, security details, chain-of-thought, or tool-call streams. The current Word bridge already verifies the selection before a write; the UX exposes only the actionable recovery state, never the underlying technical detail.

## Information architecture

Top navigation is a 40 px, three-item segmented control directly below the 56 px Vera/connection header. It is task-pane navigation, not a new global product navigation.

| Nav | Purpose | Default content |
| --- | --- | --- |
| **Assistant** | create one focused request from the current selection | Matter, selection chip/excerpt, composer, Prompt Library entry, workflow entry |
| **Review** | inspect and disposition generated output | active suggestion, grouped multi-suggestion review, sources, Word actions |
| **Actions** | start an existing workflow or use a saved prompt | six-or-fewer context-valid actions; Prompt Library is a composer entry, never a fourth primary tab |

Default selection:

- Connected with a selection: Assistant.
- A generation returns one or more suggestions: Review, focused on the first unresolved item.
- An existing workflow result opens: Review.
- Not connected, host unsupported, read-only, or empty selection: Assistant with a concise recovery state.

## Exact layout and component contract

All sizes are CSS pixels on the 340 px artboard. Horizontal inset is 12 px below 360 px and 16 px at 360 px or wider. `min-height: 40px` applies to every actionable control; icon-only controls are 40 × 40 px.

| Component | Dimensions / placement | States and behaviour |
| --- | --- | --- |
| Host header | 56 h; 12/16 px inset; bottom border `#E5E7EB` | Vera mark/name left. Right is text plus dot: `Word connected`, `Connecting`, `Word unavailable`, or `Read-only`. Do not use a permanent security banner. |
| Connection exception | variable; 12 px inset, 10 px vertical padding | amber only for unsupported/browser; red only for a blocking error. One sentence + recovery action, e.g. `Open this pane from Word.` |
| Primary nav | 40 h, margin 10 px 12/16 px 0 | three equal segments: Assistant / Review / Actions. `aria-current="page"`; active is white with 1 px shadow on `#F3F4F6`. |
| Matter compact row | 40 h | existing native selector, one-line truncation; changing it invalidates unresolved generated results with a confirm only if they would be discarded. |
| Selection capsule | 72–144 h, `overflow:auto` | label, last-read timestamp only when needed, serif 16/26 content. `Refresh` remains a 40 px secondary button. Empty selection shows a button-like instruction, not an empty gray card. |
| Composer | auto; textarea min 96 h, max 192 h | Review/Rewrite is a compact segmented control. A quiet one-row model selector is shown because the Office webview has independent local storage and must not silently fall back to an unconfigured provider. Prompt Library opens as a bottom-aligned picker and returns a filled instruction to the same composer. Workflow entry is a quiet secondary button below the textarea. |
| Generate control | 40 h, full width | black Mike-style pill. Loading changes label to `Generating suggestion…` and exposes `Cancel`; never show a streaming implementation trace. |
| Review summary | 40 h | `1 of 3 to review`, progress, and Previous/Next icon buttons. Hidden for a single suggestion. Keyboard order remains heading → review controls → diff. |
| Suggestion card | 12 px radius; gray `#F3F4F6`; 12 px padding | Original uses muted red strikethrough; proposed text uses muted green without underline. Preserve paragraphs and line breaks. Reason and up to three sources appear after the diff. |
| Suggestion actions | 40 h primary plus 40 h secondary | Primary `Apply as tracked change`; secondary `Insert comment`; tertiary `Copy`. `Dismiss` is a text button. Never offer `Apply all` as a default. |
| Workflow result | 12 px radius; summary plus 3–6 result rows | Each output is an existing artifact/review row with a status, source link where present, and one `Review` action. |
| Sticky footer (optional) | only when an action would otherwise scroll out of view | white, top border, 12 px inset; use only for the active review action and never obscure text or focus. |

### Tokens

Use the existing Mike/Vera implementation language rather than introducing tokens: Inter for controls and status labels, EB Garamond for selected/proposed document text, `#F9FAFB` canvas, white surfaces, `#111827` consequential action, `#0088FF` focus/links, and existing restrained amber/red/green status tones. Corners are 8–12 px for cards and 10 px for action buttons. No gradients beyond the existing Mike button treatment.

## State specification

| State | Assistant | Review / Actions outcome | Required recovery |
| --- | --- | --- | --- |
| **Not connected** | host exception + `Open in Word` guidance; Matter/composer unavailable | Review is disabled with an explanatory empty state | no false selection; browser preview remains clearly non-mutating |
| **Idle, no selection** | Matter remains available; selection card says `Select text in Word, then refresh` | Review shows no active item | focus `Refresh` after a selection becomes available |
| **Idle, selected** | selection excerpt and composer; Prompt Library and Workflow entry enabled | no generated work yet | Generate is enabled only with Matter + selection + instruction |
| **Generating** | selection and Matter are visually locked; composer retains text but is disabled | Review is available only as a skeleton; current partial text is labelled `Drafting suggestion…` | Cancel returns to Idle selected without losing the instruction |
| **Single suggestion** | Assistant keeps the request, Review receives focus | one diff card, sources, actions; label `Pending review` | after action, announce outcome and retain an `Open saved Matter chat` link if one exists |
| **Multiple suggestions** | Assistant returns a concise `3 suggestions ready` status | one active card at a time; progress `1 of 3`; Previous/Next and an expandable compact list of titles/statuses | accepting/dismissing advances to the next unresolved item; no mass action |
| **Workflow result** | Actions shows the selected workflow as a composer chip | Review groups results by output, not by hidden process steps; show completed/needs-review/blocked only | `Open in Vera` opens the existing artifact/task; blocked row explains the single next user action |
| **Stale anchor** | selected text changed after generation | active diff becomes unavailable and visibly marked `Selection changed`; do not reveal old text as actionable | primary: `Refresh selection`; secondary: `Copy suggestion`; re-generation requires explicit user action |
| **503 / provider queued** | Composer stays intact | status card: `Vera is waiting for the model. Your request is queued.` with `Keep waiting` and `Cancel` | poll/retry only through the existing task/chat mechanism; no technical codes in ordinary UI |
| **Read-only / WordApi capability absent** | host header says `Read-only`; generation and copy remain available | tracked-change and comment are disabled with one sentence; copy stays enabled | `Copy suggestion` is the primary available action; never change permissions from the UI |
| **Success** | a compact toast/status confirms the specific action | `Tracked change inserted — review it in Word` or `Comment added — document text was not changed`; outcome stays visible until the active card changes | no claim that Vera accepted the document change automatically |

## Interaction rules

1. **Anchor integrity.** Capture the original selection when generating. Before tracked replacement or comment insertion, compare Word's current selection using the existing bridge. A mismatch is a stale anchor, not a generic failure.
2. **No automatic acceptance.** `Apply as tracked change` only inserts a pending Word tracked change. A comment does not mutate the document text. Both messages say this plainly.
3. **Prompt Library.** It is reached from the Assistant composer and Actions quick list. Selecting a prompt pre-fills the existing instruction field and returns focus to it. It is not a separate persistent navigation destination.
4. **Workflow.** Actions exposes only workflows valid for the selected Matter/selection. The task pane shows outcome and blockers, not intermediate agent work.
5. **Model egress.** Keep the existing factual notice immediately below generation: selected text is sent to the configured model. Do not add a general security page or encryption claim.
6. **Connection status.** The ordinary connected state is a quiet header label. Exception detail appears only on connection failure, read-only capability, or egress.

## Keyboard, text, zoom, and resizing acceptance

- Tab order: host header action (if any) → primary nav → Matter → Refresh → Review/Rewrite → model → instruction → Prompt Library → Workflow → Generate/Cancel → review traversal → suggestion actions → saved-chat/artifact link.
- `Enter` on a focused button activates it. In the instruction textarea, `Cmd/Ctrl+Enter` generates; ordinary Enter inserts a newline. Escape closes Prompt Library or an Actions picker and restores focus to its trigger.
- Every focusable control has a 2 px visible azure focus ring with 2 px outside space. Focus never disappears under a sticky footer or after a state transition.
- Chinese: `lang="zh-CN"`; preserve CJK line breaks; `overflow-wrap:anywhere`; never require a 340 px horizontal scroll. Matter names and source filenames truncate to one line with an accessible full name; document/instruction/suggestion text wraps and remains selectable.
- At 125% use the existing 272 × 681 CSS-pressure check; at 150% use 227 × 567. Vertical scrolling is expected; horizontal scrolling is not. At 150%, nav labels may use 12 px but must remain three visible choices; controls may stack, never overlap.
- From 227 to 480 px, only the content column changes: 12 px → 16 px inset at 360 px, source rows wrap, and action buttons stack. Above 480 px, cap the pane content at 480 px and add the existing vertical borders; do not turn it into a desktop workspace.

## Implementation handoff and non-goals

The implementation extends `frontend/src/app/components/office/WordTaskPane.tsx` in the integration candidate, reusing `wordOfficeBridge.ts`, `wordSuggestion.ts`, Matter list, selected model, project chat stream, PillButton, and current citations. It must not modify manifest permissions or Word host capabilities. The current implementation's tracked-change and comment operations are kept; this specification merely clarifies their review states and adds multiple-result/workflow presentation using existing Task/artifact/review objects.

Explicit non-goals: a cloned Legora sidebar, a Word document editor, bulk/automatic application, a new review database/table, user roles, audit/security UI, hidden model-chain output, and a second visual design system.

## Figma delivery note

Figma MCP was available and authenticated but the attempt to create `Vera Word Add-in — Review UX v1` failed at the connector transport layer (`https://chatgpt.com/backend-api/ps/mcp`). No Figma file was created or modified. The same-size SVG and this specification are the direct-implementation fallback; re-run the file creation once the connector is reachable, using one 340 × 851 artboard per state above.
