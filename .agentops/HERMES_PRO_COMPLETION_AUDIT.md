# Hermes Professional Completion Audit

Last reviewed: 2026-07-10T03:45:00+08:00

This audit evaluates the user's professional Hermes scope against current
repository evidence. It is intentionally conservative: a contract, fixture,
or UI panel is not treated as a production capability without runtime and
verification evidence.

## Phase Evidence

| Requirement | Current evidence | Status |
| --- | --- | --- |
| Phase 1 supervision baseline | 10-minute execution and supervisor heartbeat records; phase plan and supervisor status | Complete |
| Phase 2 trust contracts | typed provenance, gates, audit/export/eval checks, source-backed parity contracts | Complete |
| General legal Q&A | `LegalQaPanel` creates source-grounded, reviewable answers with local approval and audit events | Local V1 complete |
| External-source checks | explicit opt-in, URL/snapshot hashes, workpapers, review and audit workflow; allowlisted HTTPS connector blocks private addresses, redirects, unsafe content and oversized responses | Deployable connector complete; domain configuration and live-source acceptance remain |
| Shareholder penetration | source-backed multi-beneficial-owner branches, review, accepted transition, audit | Local V1 multi-branch complete; registry ingestion/conflict resolution missing |
| Word Add-in | Office.js Word task pane, manifest, current-selection capture, matter-linked review/audit handoff; no DOCX mutation | Native implementation complete; deployed Word-host acceptance missing |
| Preference learning | matter-scoped, opt-in, revocable candidate memory maps to a new approved matter playbook only after linked review and audit checks; no automatic application | Local V1 approval mapping complete |
| Phase 4 evidence | completion, privacy, provenance, isolation, approval, restore, retrieval, package and operator checks | Complete with dirty-worktree warning |

## Verified Commands

- `npm run test:aletheia:completion`: 11/11 passed.
- `npm run check:aletheia:privacy`: passed with no secret findings.
- `npm run check:aletheia:source-provenance`: passed.
- `npm run check:aletheia:matter-isolation`: passed.
- `npm run check:aletheia:approval-policy`: passed.
- `npm run test:aletheia:local`: passed.
- `npm run test:aletheia:restore-drill`: passed with real SQLite backup/restore.
- `npm run test:aletheia:retrieval-eval`: 5/5 passed, including cross-matter isolation.
- `npm run check:aletheia:external-source-connector`: allowlist, HTTPS-only,
  public-address policy, pinned fetch capture, opt-in and content-type checks passed.
- `npm run check:aletheia:word-addin-manifest`: XML manifest, Word host,
  HTTPS task pane, read-only permission, selection capture and no-write policy passed.
- `cd frontend && npm run build`: optimized Next.js production build passed.
- focused desktop Playwright workpaper flow: passed for legal Q&A,
  external-source workpaper, graph, Word handoff, and preference candidate,
  including the implemented local approval transitions.
- focused mobile Playwright workpaper flow passed for legal Q&A,
  external-source workpaper, shareholder graph, Word handoff approval, and
  preference candidate, including reload persistence.

## Release Blocks

1. The external-source connector is intentionally allowlist-only. Configure
   approved domains and complete a live-source acceptance test before any
   automated verification claim; it is not an unrestricted whole-web crawler.
2. The Office.js task pane requires a deployed trusted HTTPS origin and a real
   Word desktop/web smoke test before it can be claimed as installed or released.
3. Preference candidates cannot cross matters or auto-apply. Any future automatic
   application requires a separately consented, revocable policy and runtime evaluation.
4. Supabase adapters fail closed for the new Local V1 approval transitions.
5. The worktree is dirty and must be intentionally reviewed and split before a release commit.

## Current Claim Boundary

Hermes is a local/private-pilot professional expert-support workflow with
source, review, approval, audit, and export controls for the implemented Local
V1 surfaces. It is not a production web-research service, a native Word Add-in,
or an autonomous legal-advice system.
