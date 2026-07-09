# Reviewer Walkthrough

This is the fastest path for understanding the Aletheia repository without
reading the whole codebase.

## 1. Product Position

Start with `README.md`.

Aletheia 明证 is not a legal chatbot. It is a local-first MVP/private pilot
candidate for a sensitive-work agent harness: Codex for confidential
professional document work.

The shortest mental model is:

```text
Codex: repo -> agent edits code -> tests run -> diff opens -> human reviews -> merge
Aletheia: local matter vault -> agent creates professional artifacts -> gates run -> review packet opens -> expert reviews -> final export
```

Aletheia should be read as an Aletheia Kernel plus Domain Packs. The Kernel
provides the local vault, bounded agent loop runtime, typed artifact graph,
permission/tool policy, review/gate console, audit trace, eval replay, and
human-approved skills. The first public/private-pilot pack is Private Contract /
Due Diligence Review.

The core loop is:

```text
Evidence -> Issue/Risk -> Draft -> Review -> Gate -> Audit -> Eval
```

## 2. Reviewer Pitch

Read `docs/deepseek_pitch.md`.

The pitch explains why sensitive professional work needs
evidence/review/gates/audit/eval, and how Aletheia adapts ideas from Herdr,
Tutti, Hermes, and Codex without becoming a generic autonomous agent console.

## 3. Demo Path

Read `docs/demo_script.md`, then run the local demo if needed:

```bash
cd backend
npm run dev:aletheia:local
```

Open:

```text
http://localhost:3000/aletheia
```

The intended path is:

1. Open or create a Matter.
2. Load Private Contract / Due Diligence Review sample documents or uploaded
   source documents.
3. Inspect the matter workspace.
4. Open the matter-scoped Command Center route when available:
   `/aletheia/matters/[matterId]/agentops`.
5. Treat the generic `/aletheia/agentops` route as a fixture-backed prototype
   view, not persisted product truth.
6. Review source-linked evidence.
7. Inspect the Issue Map and Red Flag Register.
8. Review the draft memo.
9. Flag unsupported claims.
10. Watch gates block final export until citations and human approvals pass.
11. Export Audit Pack and Feedback Eval Dataset.

The current adapter direction is intentionally one-way:

```text
AletheiaMatterDetail + run trace records
-> AgentOps view model
-> Command Center / gates / eval / reference previews
```

That keeps existing Aletheia matter records as the source of truth.

## 4. What To Inspect In The UI

The reviewer path should show:

- Matter profile and document registry.
- Source Map and source-linked Evidence Matrix.
- Issue Map, Risk Register, Red Flag Register, or open questions.
- Draft memo with traceability to evidence and issues.
- Human review tags for unsupported claims, missing facts, overclaims, or
  accepted analysis.
- Trust Gates checklist, blocked/approved export state, and read-only gate
  provenance where available. Gate provenance currently maps display gates back
  to existing Aletheia records; it is not yet a first-class persisted gate
  event model.
- Agent run trace, tool calls, budgets, and human checkpoints where available.
- Audit Workbench, Audit Pack, and Feedback Eval Dataset exports.
- Matter-scoped Command Center cards, Eval Signals, and Big @ reference
  previews as adapter-backed view-layer evidence.
- Route-aware artifact links inside the Command Center. These are currently
  hash anchors into the in-page artifact queue, not durable artifact-detail
  routes.

## 5. Feature Map

Read `docs/feature_map.md`.

The map explains the Kernel and Domain Pack structure:

- Aletheia Kernel: Local Vault, Agent Loop Runtime, Typed Artifact Graph,
  Permission + Tool Policy, Review + Gate Console, Audit Trace, Eval Replay,
  and Human-approved Skills.
- Domain Packs: Private Contract / Due Diligence Review first, with compliance,
  audit, regulatory response, and litigation chronology as adjacent pack
  framing.

## 6. Current Status

Read `docs/status.md`.

The important boundary is that Aletheia is a local-first MVP/private pilot
candidate. It has meaningful local validation and demo depth, but it should not
be presented as production-ready SaaS, legal advice software, or a replacement
for expert judgment.

The Matter Command Center should be described as a local/private-pilot reviewer
surface unless the relevant persistence, gate, audit, and export boundaries are
explicitly validated for a stronger claim.

## 7. Screenshot And Smoke Evidence

For screenshot expectations and automated UI smoke checks, read
`docs/ui_smoke.md`.

Focused adapter-backed route smoke can support a demo claim, but it should not
be treated as a full release validation substitute.

The screenshot set should show:

- Matter Queue.
- Matter workspace.
- Matter-scoped adapter-backed Command Center.
- Document Registry.
- Source Map.
- Evidence Matrix.
- Issue Map or Red Flag Register.
- Draft Memo.
- Review Queue.
- Trust Gates checklist or gate state.
- Gate provenance if the adapter-backed Command Center route is shown.
- Audit Workbench or Audit Pack.
- Feedback/Eval export.
- Eval Signals or feedback dataset preview.
- Big @ reference previews if the Command Center route is shown.
- In-page artifact queue hash anchors, if artifact navigation is shown.

## 8. What This Proves

Aletheia proves product judgment about professional agents:

- the primary interface is a matter workspace, not a blank chat;
- outputs are typed deliverables, not loose answers;
- claims are evidence-bound;
- experts remain in control;
- gates fail closed for high-risk exports;
- audit and eval are first-class product surfaces.

That is the business-training signal: advanced agents need evidence,
observability, human approval, auditability, and regression loops before they
can be credible in high-risk professional organizations.
