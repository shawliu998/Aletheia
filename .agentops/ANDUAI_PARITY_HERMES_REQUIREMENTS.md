# AnduAI Parity Requirements For Sensitive Hermes

Last updated: 2026-07-10T01:45:00+08:00

Purpose: capture the user's expanded requirement that Hermes Professional should
cover the practical feature surface associated with AnduAI/AutoDocs while
preserving Aletheia's sensitive-work trust boundary.

## Source Read

Sources checked on 2026-07-10:

- `https://www.anduai.com/` and `https://autodocs.cn/` search snippets describe
  capital-market and M&A regulatory workflows with automatic data collection,
  workpaper retention, analysis management, network checks, shareholder
  penetration checks, related-party checks, and customer/supplier checks.
- 36Kr reporting describes AutoDocs as RPA + AI for information collection,
  evidence retention, document production, and end-to-end due diligence /
  compliance workflows, with shareholder penetration as a core example.
- AIbase / ai-bot.cn summaries describe contract review, due diligence,
  penetration checks, custom review rules/templates, user habit learning, and
  continuous optimization.

These sources are treated as competitive feature inputs, not as proof that any
feature is safe to copy without Aletheia's evidence, gate, audit, and expert
review controls.

## Required Product Capabilities

Add these to the professional Hermes target:

1. General legal Q&A
   - Must be framed as expert-support research/Q&A, not legal advice.
   - Answers must cite matter sources, internal knowledge, or approved external
     sources.
   - Unknown or uncited answers must fail into "needs professional review."

2. Whole-web / external-source automated checks
   - Must run through an explicit external-source connector with source capture,
     timestamps, URLs, hashes where available, and screenshot/PDF/workpaper
     retention.
   - External web is disabled by default in sensitive local workflows and must
     be opt-in per matter or deployment.
   - Outputs must be review items or audit candidates until approved.

3. Shareholder penetration graph
   - Must support entity, shareholder, beneficial-owner, controller, related
     party, customer, supplier, and investment-relationship records.
   - Must preserve source evidence for every edge in the graph.
   - Graph conclusions must distinguish confirmed, inferred, conflicting, and
     missing evidence.

4. Word Add-in
   - Must support Word-native review/drafting flows without weakening final
     export gates.
   - Minimum professional surface: ask about selected text, cite source
     evidence, suggest clause edits, insert review comments, preserve tracked
     changes, and sync approved work products back to the matter.
   - Add-in output remains draft/review state until Aletheia approval, gate, and
     audit records authorize final use.

5. User habit / preference learning
   - The product should learn review preferences, clause styles, risk
     thresholds, playbook edits, and accepted/rejected suggestions.
   - For sensitive work, this must be opt-in, user/organization/matter scoped,
     inspectable, exportable, revocable, and human-approved before changing
     professional playbooks.
   - No global autonomous legal memory and no silent learning across unrelated
     clients or matters.

## Phase Mapping

Phase 2: core trust contracts

- Add typed contracts for external-source checks, entity graph edges, Q&A
  citations, and preference-learning proposals.
- Preserve persisted gate evidence IDs in export, handoff, and eval outputs.
- Add policy checks that block web-derived, graph-derived, or preference-derived
  professional conclusions without source/audit/review links.

Phase 3: professional experience

- Build UI surfaces for legal Q&A, network-check workpapers, shareholder graph
  review, and Word Add-in handoff.
- Keep each surface tied to matter evidence, review comments, gate state, audit
  events, and eval feedback.

Phase 4: release evidence

- Add regression fixtures and audit scripts for web check provenance, graph
  source edges, Word Add-in handoff records, and approved preference learning.
- Update reviewer docs to show these as professional expert-support workflows,
  not autonomous legal advice.

## Stop Conditions

Stop and record a conflict if implementation:

- enables broad web access by default for sensitive local data;
- treats web search snippets as evidence without retained source records;
- renders shareholder graph edges without source IDs and confidence/status;
- lets Word Add-in text bypass Aletheia review/gate/audit records;
- silently learns user/client behavior into global memory;
- presents general legal Q&A as legal advice or a replacement for professionals.
