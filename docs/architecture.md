# Architecture

Vera is a local-first civil-litigation workspace. Architecturally, a reusable
Kernel provides document, model, storage, permission, review, and audit
foundations, while V1 exposes only the Civil Litigation domain.

```text
+--------------------------------------------------------------+
| Active Domain: Civil Litigation                              |
| Intake | Evidence | Claims | Research | Procedure | Drafting |
+-----------------------------+--------------------------------+
| Aletheia Kernel                                             |
| Local Vault | Agent Loop | Typed Artifacts | Review Gates     |
+-----------------------------+--------------------------------+
| Kernel Internals                                             |
| documents | indexes | permissions | audit | eval | skills     |
+--------------------------------------------------------------+
| Base Application Layer                                       |
| auth | projects | storage | LLM providers | API routes       |
+--------------------------------------------------------------+
```

## Layers

### Base Application Layer

Provides authentication, project containers, document storage, model provider adapters, and existing API structure.

### Aletheia Kernel

Adds the reusable local-first harness:

- Local Vault;
- Agent Loop Runtime;
- Typed Artifact Graph;
- Permission + Tool Policy;
- Review + Gate Console;
- Audit Trace;
- Eval Replay;
- Human-approved Skills.

The Matter Queue, Template Registry, Evidence Registry, Human Review Queue,
Audit Timeline, and matter-level workspace are current UI surfaces for the
Kernel.

### Active Domain

V1 configures the Kernel only for Civil Litigation. Earlier contract,
compliance, diligence, and generic workspace implementations are compatibility
code, not active product surfaces.

### Agent Loop Runtime

MVP functions are deterministic:

```text
generateAgentPlan(matter, documents)
generateIssueMap(matter, documents)
generateEvidenceMatrix(matter, documents, issues)
generateDraftMemo(matter, issues, evidence)
runReviewer(memo, evidence)
createAuditEvent(...)
```

The current demo is a persisted `civil_litigation` matter created by the local
backend. Frontend fallback matters are not used in the installed product.

The backend now has an agent runtime skeleton:

```text
Agent Run
-> Agent Steps
-> Tool Calls
-> Human Checkpoints
-> Work Products
-> Audit Events
```

This follows the Hermes-style runtime idea without coupling Aletheia to any
specific runtime implementation. The runtime records are meant to capture plan
state, tool inputs and outputs, required human approvals, validation errors, and
final structured artifacts.

### API Boundary

The first API surface is mounted under `/aletheia`:

```text
GET  /aletheia/matters
POST /aletheia/matters
GET  /aletheia/matters/:matterId
POST /aletheia/matters/:matterId/work-products
POST /aletheia/matters/:matterId/reviews
POST /aletheia/matters/:matterId/audit-events
POST /aletheia/matters/:matterId/memory
POST /aletheia/matters/:matterId/playbooks
POST /aletheia/matters/:matterId/playbooks/:playbookId/approve
POST /aletheia/matters/:matterId/agent-runs
GET  /aletheia/tool-adapter/tools
POST /aletheia/tool-adapter/tools/:toolName/call
```

The frontend client lives in `frontend/src/app/lib/aletheiaApi.ts`. The demo
matter remains deterministic, while newly created matters use the API-backed
route and database schema.

`/aletheia` redirects to an API-backed matter queue. The queue shows only
`civil_litigation` records and explicitly reports backend unavailability;
non-litigation and fallback matters are not merged into the active product.

`POST /aletheia/matters/:matterId/work-products` is the persistence boundary for
structured artifacts. It accepts agent plans, issue maps, evidence matrices,
draft memos, audit packs, and feedback exports, then records a matching audit
event. This keeps generation, human review, and export history replayable from
the database.

Matter creation also writes a deterministic `agent_plan` work product and an
`agent_plan_generated` audit event. This gives every persisted matter an initial
reviewable scaffold before retrieval, parsing, and model orchestration are
connected.

### Storage Boundary

The Aletheia backend route talks to a repository contract backed by the local
repository only:

```text
Aletheia Route
-> AletheiaRepository
-> LocalAletheiaRepository
```

The repository persists to:

```text
.data/aletheia/aletheia.db
.data/aletheia/documents/
.data/aletheia/exports/
.data/aletheia/index/
```

The local repository supports Aletheia routes in single-user local mode with
SQLite persistence, filesystem document storage, parsed source chunks, FTS5
search, matter-scoped memory, draft/approved playbooks, agent run traces, and
approval-gated high-risk exports.

### Review, Gates, Audit, Eval, And Skills

Every meaningful event should become an audit event:

- matter created;
- document uploaded;
- agent plan generated;
- evidence mapped;
- memo generated;
- review added;
- audit pack exported;
- feedback dataset exported.

### Database Schema

```text
aletheia_matters
aletheia_matter_documents
aletheia_work_products
aletheia_evidence_items
aletheia_review_items
aletheia_audit_events
aletheia_agent_runs
aletheia_agent_steps
aletheia_tool_calls
aletheia_human_checkpoints
aletheia_matter_memory_items
aletheia_playbooks
```

`aletheia_work_products` stores structured JSON payloads for the agent plan,
chronology, issue map, evidence matrix, draft memo, compliance register, red flag
memo, audit pack, and feedback export. `aletheia_evidence_items`,
`aletheia_review_items`, and `aletheia_audit_events` keep source grounding,
expert judgment, and provenance separate so each workflow can be reviewed and
replayed.

`aletheia_agent_runs`, `aletheia_agent_steps`, `aletheia_tool_calls`, and
`aletheia_human_checkpoints` capture workflow execution state. They are the
database shape for plan-before-answer runs, tool registry calls, and human
approval gates.

`aletheia_matter_memory_items` and `aletheia_playbooks` capture matter-scoped
procedural and factual context. They are deliberately attached to a matter so
sensitive professional context does not leak across unrelated work.
