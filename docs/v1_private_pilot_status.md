# Aletheia V1 Private Pilot Status

Current stage: **V1 local/private-pilot candidate completed; production/SaaS
not claimed.**

Aletheia V1 is complete for bounded local reviewer evaluation. The validated
path shows a local-first professional AgentOps + Evidence Workspace for
high-risk legal, compliance, audit, due diligence, and regulatory workflows.
It is not legal advice software, not production SaaS, and not a replacement for
qualified professional judgment.

## What Is Validated

- Local/private startup for the Aletheia workspace.
- Local batch document import, parsing, chunking, and source indexing.
- Matter-scoped retrieval with source provenance and retrieval diagnostics.
- Source-linked evidence, issue/risk, review, gate, and export surfaces.
- Fail-closed gates for high-risk export flows.
- Local AgentOps export packages with source-index manifests and export
  authorization status.
- Local eval fixture output for review/gate failure cases.
- Reviewer-facing documentation and release notes that preserve the
  local/private-pilot boundary.

## Validation Evidence

Backend validation passed:

```bash
cd backend && npm run build
cd backend && npm run check:aletheia:operator
cd backend && npm run check:aletheia:source-provenance
cd backend && npm run check:aletheia:approval-policy
cd backend && npm run check:aletheia:run-trace
cd backend && npm run check:aletheia:audit-integrity
cd backend && node --import tsx src/scripts/aletheiaBackendApiScopingAudit.ts
cd backend && node --import tsx src/scripts/aletheiaV1RuntimePersistenceAudit.ts
```

Frontend and AgentOps validation passed:

```bash
cd frontend && npm run lint
cd frontend && npx tsc --noEmit --pretty false
cd frontend && ../backend/node_modules/.bin/tsx --test tests/agentops/exportPackage.test.ts tests/agentops/v1Contracts.test.ts tests/reviewStudio.test.ts tests/agentops/gates.test.ts tests/agentops/v1Runtime.test.ts tests/agentops/v1DocumentRetrievalAdapters.test.ts
cd frontend && ALETHEIA_UI_SMOKE_FRONTEND_PORT=5310 ALETHEIA_UI_SMOKE_BACKEND_PORT=5311 npx playwright test --config=playwright.config.ts
node .agentops/scripts/check-agentops.mjs
git diff --check
```

## Caveats

- Local/private-pilot only.
- No legal advice generation and no replacement for expert judgment.
- No production SaaS readiness is claimed.
- Supabase V1 document/chunk/source listing is unavailable.
- Supabase V1 runtime persistence is unavailable.
- No public `persistV1RuntimeResult` route or approval retry wiring exists.
- Review-derived eval is local/helper fixture output until durable
  review-resolution API/status semantics exist.
- External model calls remain off by default for sensitive/private data and
  must be explicit, configurable, logged, and auditable if enabled later.

## Reviewer Path

Start with:

- `README.md`
- `docs/status.md`
- `docs/v1_acceptance_matrix.md`
- `docs/demo_script.md`
- `docs/release_notes_local_first_mvp.md`

