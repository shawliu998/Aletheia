# Aletheia V1 Acceptance Matrix

Current stage: **V1 local/private-pilot candidate completed; production/SaaS
not claimed.**

| Function | Status | Evidence | Limitations |
| --- | --- | --- | --- |
| Matter workspace | Completed for local/private-pilot candidate | `/aletheia` workspace, Matter Queue, Remote Matter pages, full desktop/mobile UI smoke | Not production SaaS; inherited application routes may still require Supabase services |
| Ingestion | Completed for local/private-pilot candidate | Local upload, parser/chunk metadata, `needs_ocr`, TXT/DOCX/PDF local regression, `test:aletheia:batch-import-route` | Rich spreadsheet/table semantics and full source-page preview remain limited |
| Retrieval | Completed for local/private-pilot candidate | SQLite FTS5 matter-scoped search, local retrieval eval, 24-document compact fixture, source-index route | Supabase V1 document/chunk/source listing is unavailable; semantic/hybrid retrieval remains opt-in local prototype |
| Source provenance | Completed for local/private-pilot candidate | Source chunk IDs, document IDs, quote offsets, support status, source provenance audit | Production-grade external source governance remains future hardening |
| Review Studio | Partial with caveat | Unresolved review visibility, source-linked review anchors, memo badges, review logs, local eval fixture tests | Durable review-resolution API/status semantics are not implemented |
| Gates | Completed for local/private-pilot candidate | Citation/human approval/missing material/conflict/external source gates, fail-closed final export tests, approval policy audit | Privilege/confidentiality remains a visible caution policy rather than a deeper post-approval policy |
| Runtime / AgentOps | Partial with caveat | Deterministic provider, one-shot scheduler, run trace, token estimates, structured-output guard, local persistence audit | Supabase runtime persistence, public runtime persistence route, approval retry wiring, real providers, and exact pricing adapters remain unavailable |
| Export / audit pack | Completed for local/private-pilot candidate | Local AgentOps export packages, `audit_pack.source_index_manifest`, export authorization status, export package tests | No backend export route and no Supabase source-index implementation |
| Eval / skills | Partial with caveat | Gate/review failure eval fixtures and candidate-only skill output, V1 contract tests | Review-derived eval is not durable; approved skill activation workflow remains future work |
| Deployment docs | Completed for local/private-pilot candidate | README, status page, private/local deployment docs, release notes, validation commands | No signed installer, production SSO/session policy, or production SaaS claim |
| UI smoke | Completed for local/private-pilot candidate | Full Playwright desktop/mobile smoke passed with local backend/frontend servers | Browser coverage is focused on the validated local path |

