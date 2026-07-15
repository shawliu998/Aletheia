# Vera P1 OCR, Legal Sources, and Document Studio

Date: 2026-07-15

Status: the core local-client slices and bounded packaged acceptance are
complete for OCR/Project Sources, truthful legal-source readiness Settings,
and Project Document Studio/DOCX. This is not a claim that the full Gate C/D
convergence is complete: packaged citation-anchor recovery, source reopening,
Assistant/Workflow draft actions, and AI suggestion UX remain follow-on. Real
legal connectors remain deliberately disabled.

Product decision: `Project` remains Vera's generic container. OCR, legal
sources, and Document Studio are Project capabilities; none becomes a sixth
first-level navigation destination or a replacement litigation workspace.

## 1. Scope

P1 productizes three existing Vera capabilities without rebuilding their
security, storage, or document foundations:

- local OCR for scanned and mixed-text Project documents;
- truthful readiness and credential controls for explicitly configured
  legal-source providers; durable legal-authority snapshots remain behind the
  retention activation gate;
- a Project-scoped Document Studio with versioned drafts, citations, and safe
  DOCX interchange; Assistant/Workflow draft actions and AI suggestion UX are
  reserved for the follow-on convergence slice.

The end-to-end target is:

```text
Project document
  -> local OCR when required
  -> immutable source snapshot and citation anchors
  -> Assistant / Workflow / configured legal-source research
  -> Document Studio draft and explicit user edits
  -> versioned DOCX export
```

## 2. Reuse boundary

P1 reuses rather than duplicates:

- `desktop/native/aletheia-ocr.swift`, PDFKit, and Apple Vision;
- the Workspace document parser, encrypted blobs, jobs, chunks, and versions;
- the retained legal-source adapters and their hardened external transport;
- Mike-derived TipTap editing components;
- the existing DOCX generation, template, content-disarm, and round-trip code;
- SQLCipher, Keychain-backed application/database keys, the retained
  application-envelope-encrypted legal-source credential store, backup,
  restore, and desktop packaging. Model-provider credentials remain on the
  separate Keychain-only credential-worker path.

Legacy Matter, evidence-graph, approval-gate, and Word Add-in surfaces remain
outside the primary Vera product path. Compatibility adapters may call stable
legacy services, but new Project data must not be written into Matter tables.

## 3. Shared contracts

All three tracks converge on two transport-safe concepts:

### Source snapshot

A snapshot is immutable, Project-scoped provenance for either a Project
document version or a legal authority. It records the provider-neutral source
kind, content hash, locator, retrieval time, and declared retention policy.
Provider secrets, filesystem paths, and unrestricted vendor payloads are not
stored in the public projection. A legal source cannot be activated until the
retention policy has the fail-closed enforcement described below.

### Citation anchor

A citation anchor belongs to one snapshot and records an exact quote plus its
stable locator. A Project-document locator may include document version,
chunk, page, offsets, and OCR geometry. A legal-authority locator may include
the authority identifier, section, paragraph, or provider locator. Anchors
must carry a quote hash so stale or modified source text fails closed.

Existing Assistant message sources and Tabular citations remain compatible.
Adapters may project them into the shared contract; P1 does not require a
destructive rewrite of existing history.

## 4. OCR track

The default provider is packaged Apple Vision and it operates locally. The
original file is never overwritten. OCR is a resumable derived operation
bound to the original document version, provider version, requested pages,
and settings.

Required behaviour:

- OCR only pages for which normal extraction produced no usable text;
- retain page text, confidence, and source geometry sufficient to reopen the
  original location;
- provide bounded progress, cancellation, timeout, retry, and restart-safe
  terminal status;
- cache idempotently by source hash, page range, provider, and settings;
- make low-confidence pages visible for user review;
- make no cloud request unless a future provider is explicitly configured and
  selected by the user.

The native helper and its Node caller must remain backward compatible with the
packaged v1 audit until the v2 contract is fully covered.

## 5. Legal-source track

The provider contract owns search, metadata, document/excerpt retrieval,
citation resolution, health, and declared capabilities. The model gateway
never calls an external legal source directly.

Every provider declares:

- configured and connection status;
- whether full text, excerpts, or metadata may be persisted;
- cache time-to-live;
- whether content may be exported or sent to a configured model;
- supported search and citation-resolution capabilities.

Commercial providers are unavailable until the user supplies licensed API
configuration. Vera must not scrape a provider, invent an endpoint, silently
substitute fixtures, or display a successful connection without a real check.
Legal-source credentials use the retained compatibility path: the renderer
submits a write-only value once, the backend stores only application-envelope
ciphertext plus non-secret hint/status fields in SQLCipher, and decryption is
server-side only. The encryption keys remain Keychain-backed. Plaintext and
credential readback never enter renderer responses, logs, or diagnostics.

The current implementation provides the provider contract and reports the
real local configuration state only. `configured_unverified` means that a
configuration is present but a live connection has not been verified. It is
never a successful connection state. Public Project Source routes do not
accept `legal_authority` snapshot or anchor writes.

### Retention activation gate

A real legal connector must remain disabled, and the legal-source track must
not be described as completely launched, until all of the following are
implemented with fail-closed tests for `full_text_ttl`:

- an expired snapshot cannot be read or used to create a new citation anchor;
- an expired snapshot or anchor cannot be bound to a Document Studio version;
- export and configured-model use reject expired or policy-prohibited content;
- tombstone behaviour and physical cleanup timing are defined consistently
  across snapshots, anchors, Studio bindings, backups, and restart recovery.

This gate applies to retained legal-provider content. Current Project document
snapshots are user-provided and use `full_text_permitted` with no TTL, so their
Project Source and Studio citation flow is not blocked by this activation gate.

## 6. Document Studio track

Document Studio is an edit mode for a Project document, not a parallel root
document system. It extends the existing Workspace documents, immutable
versions, and edit suggestions.

Delivered local-client slice:

- create a blank Project draft;
- edit a canonical TipTap document with a safe plain-text/Markdown projection;
- save with compare-and-swap revision checks and explicit conflict handling;
- create immutable content checkpoints, list and read historical versions, and
  restore by creating a new version rather than mutating content history;
- attach citations to a specific document version and preserve their exact
  source identity;
- import and export macro-free DOCX through the existing safe round-trip path;
- remain fully readable and editable after desktop restart while model or legal
  providers are offline.

Assistant/Workflow-to-Studio creation, a shared source-reopen viewer, and AI
changes as explicit accept/reject suggestions are the next convergence slice;
the current UI does not claim those actions exist.

Pixel-perfect Word fidelity, Word Add-in, collaborative editing, cloud sync,
arbitrary HTML, and autonomous overwrite are not P1 requirements.

## 7. Delivery sequence

### Gate A: shared foundation

- additive Workspace migration and repositories for snapshots and anchors;
- verified reuse of the existing durable `document_parse` job type (no new
  competing OCR or Studio job constraint is needed for the first vertical);
- compatibility tests against a real v10 database and a fresh database;
- no product UI change.

### Gate B: independent verticals

- local OCR provider and Project document status/review;
- legal-source provider contract and Settings readiness;
- Document Studio persistence, routes, editor, versions, and DOCX interchange.

These tracks may run in parallel only after their table and file ownership is
explicit. They must not each create competing provenance or credential models.

### Gate C: convergence

- Project document and legal-authority citations use the same source viewer;
- Assistant and Workflow can create a Studio draft through a bounded action;
- OCR-derived citations reopen the original PDF page;
- legal-source licence policy is enforced during model use and export.

### Gate D: packaged acceptance

The packaged client must complete the full scanned-document-to-DOCX flow,
release its ports on exit, and recover the same encrypted Project, jobs,
citations, draft, and versions on restart. No fixture provider may satisfy this
gate.

The current release has passed the bounded core of this gate through the real
packaged Apple Vision helper, Project Source snapshot, Studio, DOCX, encrypted
restart, and port-release path. It does not yet claim the citation portion of
the full Gate D: the packaged audit deliberately creates no anchor because the
client has no public safe chunk/source-viewer path. Anchor binding and restart
integrity are covered at the backend P1 convergence layer until that public
client path exists.

## 8. Quality gates

Minimum evidence before a track is called complete:

- backend TypeScript build and focused Workspace migration/repository audits;
- provider contract tests for unavailable, configured, timeout, cancellation,
  redirect, retention, and redaction behaviour;
- native and packaged OCR audits using text-only, image-only, and mixed PDFs;
- frontend lint/source tests for real API wiring, accessibility, failure, and
  empty states;
- malicious or unsupported DOCX input fails closed;
- a packaged cross-restart E2E validates encrypted persistence and original
  source location;
- the pre-existing P0 client and desktop security suites remain green.

## 9. Rollback

Migrations are additive and legacy routes remain mounted. Each new UI surface
is capability-gated by the real local backend. If a vertical is disabled or
rolled back, existing Projects, document versions, Assistant history,
Workflows, and Tabular Reviews remain usable. Rollback must never delete source
snapshots or rewrite original files.

## 10. Implementation evidence (2026-07-15)

Completed:

- v11 Project source snapshots and citation anchors, including immutable
  provenance, Project isolation, policy metadata, and upgrade/rollback tests;
- the packaged Apple Vision OCR provider contract, mixed-PDF page selection,
  normalized top-left geometry, confidence, timeout, cancellation, and legacy
  helper compatibility;
- bounded `vera-document-chunk-ocr-v1` provenance in existing Workspace chunks:
  engine, coordinate space, page, page-local UTF-16 origin, page confidence,
  low-confidence state, and intersecting text-free block geometry; metadata is
  size/count bounded and rejects malformed page binding;
- versioned `vera-pdf-page-spans-v1` PDF extraction metadata, so Project page
  assignment is derived from structured UTF-16 spans rather than scanning
  user-controlled `[Page n]` text; malformed, discontinuous, duplicate, and
  surrogate-splitting spans fail closed;
- current-version OCR summaries and Mike-style OCR/review badges in the
  existing Project document list and side panel, including bounded
  low-confidence page numbers and truncation state, without a new top-level
  navigation destination;
- authenticated, Project-scoped Source APIs for capturing immutable Project
  document-version snapshots, bounded listing/detail reads, and verified
  exact-quote anchors; all snapshot identity, policy, hash, locator, and
  ordinal fields are derived or rechecked by the backend;
- strict citation offsets and integrity behaviour: chunk-local and page-local
  offsets are UTF-16 code units, verified document offsets explicitly identify
  the normalized document-text basis, duplicate quotes require explicit
  offsets, and historical padded chunks omit document offsets that cannot be
  proven rather than guessing them;
- UTF-16 chunk boundaries preserve surrogate pairs, including emoji at the
  fixed chunk and overlap boundaries, while multi-chunk coverage continues to
  advance without gaps and every quote anchor reproduces its exact source
  slice;
- immutable snapshot, version, chunk, and quote hashes are revalidated at the
  relevant read/write boundary. Tampered hashes, malformed OCR metadata,
  synthetic page-marker offsets, cross-Project references, and unsafe
  structured metadata fail closed; structured response metadata excludes
  filesystem paths and secrets;
- the legal-research provider boundary and truthful
  `configured_unverified`/`unavailable` configuration states for authorized
  gateways. This is a contract/readiness implementation, not evidence of a
  successful legal-provider connection, and public `legal_authority` writes
  remain closed;
- a code-owned production activation gate on every environment-backed legal
  Provider: even fully configured endpoint/allowlist/credential environments
  return `activation_gate_closed`, do not read the credential, and perform no
  outbound fetch until retention enforcement is implemented;
- a Mike-layout `/settings/legal-sources` page with strict local status reads,
  write-only locally encrypted credential entry, removal, responsive
  empty/error states, and no renderer-side provider call or synthetic
  connection test;
- v12 Project Document Studio over the existing encrypted documents, versions,
  blob records, and parse jobs;
- real blank-draft creation, Markdown editing, immutable CAS saves, historical
  reads, version listing, restore-as-new-version, version-bound citations, and
  restart persistence;
- Studio version content, content hashes, source lineage, and citation bindings
  are immutable. A user rename may update the current version's filename
  metadata for compatibility with the generic Project document model;
- the shared Mike-derived TipTap Markdown editor used by both Workflows and
  Document Studio, with no duplicate editor implementation;
- capability-gated Project UI: only real v12 draft/template lineage opens in
  Studio, and generic version upload cannot bypass the Studio lineage;
- complete Project-scoped DOCX import/export routes and Studio UI integration,
  including immutable historical export, CAS import, bounded warnings, and
  explicit simplification behaviour;
- a shared fail-closed DOCX package preflight used before PizZip, Mammoth, and
  the litigation compatibility path: raw ZIP directory/header validation,
  canonical duplicate/path rejection, CRC verification, ZIP64/multi-disk and
  active-content rejection, strict support for standard signed/unsigned ZIP
  data descriptors, and bounded DEFLATE expansion before downstream parsing.

Intentionally deferred gates and follow-on work:

- keep real legal connectors disabled until the retention activation gate is
  implemented and tested;
- follow-on convergence, outside this release gate: a shared source viewer,
  OCR-page reopen actions, Assistant/Workflow-to-Studio bounded actions, and
  explicit AI suggestion accept/reject UX;
- extend the packaged audit to create, reopen, and recover citation anchors
  once the bounded public source-viewer/chunk path exists, thereby closing the
  remaining full Gate D citation requirement.

Bounded core packaged acceptance passed on arm64 with the official local-only
unsigned build path. The isolated-client audit used a real image-only PDF and
the packaged Apple Vision helper, verified recognized text and OCR review
metadata, captured an immutable Project document snapshot, performed Studio
create/CAS save/DOCX export-import, relaunched the same encrypted profile with
the same keys, and revalidated Project text/source data, all three Studio
versions, historical reads/exports, disabled legal-source state, and released
ports. The generated DMG and ZIP both passed the published SHA-256 manifest.
This is `signed=false`, `notarized=false`, and local-only; it is not a public
release artifact or evidence that full Gate D is closed.

Acceptance artifacts:

- `desktop/dist/mac-arm64/Vera.app`;
- `desktop/dist/Vera-1.0.1-arm64.dmg`, SHA-256
  `ba906b9d418528ff2e7a2e708cb5cb895685fc4a54192a44133aa22dd230a17a`;
- `desktop/dist/Vera-1.0.1-arm64.zip`, SHA-256
  `6d53e2bdeacb08618cc18fc2118141ef994e70571e26633a439dc8c7d2a27097`;
- `desktop/dist/Vera-1.0.1-SHA256SUMS.txt`, reverified after the packaged P1
  audit.

Verified commands:

```text
cd backend && npm run test:workspace:migrations
cd backend && npm run test:workspace:source-foundation
cd backend && npm run test:workspace:ocr-provenance
cd backend && npm run test:workspace:ocr-summary
cd backend && npm run test:workspace:project-sources-route
cd backend && npm run test:workspace:document-studio
cd backend && npm run test:workspace:document-studio-route
cd backend && npm run test:workspace:document-studio-docx
cd backend && npm run test:workspace:p1-convergence
cd backend && npm run test:aletheia:document-parse-retry
cd backend && npm run test:aletheia:document-roundtrip
cd backend && npm run check:aletheia:legal-source-control
cd backend && npm run test:vera:legal-research-provider
cd backend && npm run test:vera:legal-research-gate
cd backend && npm run test:vera:legal-research-broker
cd backend && npm run test:workspace:p0-client
cd frontend && npm run test:p0-client
cd frontend && npm run test:legal-sources
cd frontend && npm run test:legal-sources:ui
cd frontend && npm run test:studio
cd frontend && npm run test:ocr-review
cd frontend && npm run build
cd desktop && npm run test:native-ocr
cd desktop && npm run test:p0-source
env -u ALETHEIA_PACKAGED_APP_PATH VERA_RELEASE_SIGNING=false \
  ./scripts/package-desktop-mac.sh
cd desktop && ALETHEIA_PACKAGED_APP_PATH="$PWD/dist/mac-arm64/Vera.app" \
  ALETHEIA_DESKTOP_FRONTEND_PORT=45360 \
  ALETHEIA_DESKTOP_BACKEND_PORT=45361 \
  npm run test:packaged-p1-convergence
git diff --check
```
