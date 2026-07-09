# Refocus Architecture Decision

Updated: 2026-07-09

## Decision

Position Aletheia as a local-first agent harness for sensitive professional
document work. Describe the system as an Aletheia Kernel plus Domain Packs.

The Kernel is the reusable harness. Domain Packs configure it for specific
professional workflows. The first pack is Private Contract / Due Diligence
Review.

## Aletheia Kernel

The Aletheia Kernel is the product core shared by every domain pack:

- Local Vault: matter-scoped local documents, parsed chunks, indexes, exports,
  and metadata.
- Agent Loop Runtime: bounded runs with plans, steps, role labels, budgets,
  tool calls, model/provider metadata, errors, and human checkpoints.
- Typed Artifact Graph: structured artifacts with schema, owner, status,
  source IDs, review IDs, gate IDs, audit IDs, and export lineage.
- Permission + Tool Policy: least-privilege allowlists, denied capabilities,
  approval requirements, and local/private defaults.
- Review + Gate Console: expert review state, unsupported-claim flags, missing
  material tracking, checkpoint decisions, and fail-closed export gates.
- Audit Trace: replayable matter events, agent steps, tool calls, work-product
  changes, review decisions, gate outcomes, exports, and hashes where present.
- Eval Replay: review-derived cases, retrieval checks, source-provenance tests,
  and regression fixtures that point back to evidence, reviews, gates, runs,
  and audit events.
- Human-approved Skills: matter-scoped memory, versioned playbooks, candidate
  skill proposals, approval records, and eval checks before future use.

## Domain Packs

Domain Packs sit above the Kernel. They should not fork the safety model.

Examples:

- Contract / Due Diligence Review Pack;
- Compliance Obligation Pack;
- Audit Evidence Pack;
- Regulatory Response Pack;
- Litigation Chronology Pack.

Each pack can define:

- source document checklists;
- artifact schemas;
- workflow templates;
- review tags;
- gate policies;
- export packet shapes;
- eval replay cases;
- approved skills/playbooks.

Domain Packs must preserve Kernel constraints: local-first storage, evidence
binding, expert review, fail-closed gates, audit traces, eval replay, and human
approval for skills.

## Local-First Storage And Runtime Assumptions

The repository currently supports a local/private-pilot baseline. Public-facing
architecture should make that boundary explicit.

Baseline assumptions:

- local matters live under a local data root such as `.data/aletheia/`;
- SQLite persists matters, work products, reviews, audit events, evidence,
  run traces, memory, playbooks, and related local state;
- filesystem storage keeps source documents, exports, parsed text, and indexes;
- local retrieval is the default path for sensitive source material;
- external model calls are disabled by default for sensitive/private data;
- any external provider path must be explicit, logged, configurable,
  auditable, and restricted by permission/tool policy;
- Supabase/Postgres is a compatibility adapter, not the core product boundary;
- production SaaS readiness is not claimed by the current local/private-pilot
  validation.

## Agent Loop Lifecycle

The preferred lifecycle is:

```text
Matter intake
-> source document import
-> parse/chunk/index
-> bounded plan
-> evidence mapping
-> typed artifact draft
-> review packet/diff
-> gate evaluation
-> expert decision
-> final export or revision
-> audit trace
-> eval replay case
-> candidate skill/playbook proposal
-> human approval before reuse
```

Agent loops must be bounded. They should expose plan state, source use, tool
I/O, validation errors, budget state, checkpoint requirements, and generated
artifacts. A final professional output should not bypass review and gates.

## Typed Artifact Graph

Aletheia should treat outputs as graph nodes, not free-form answers.

Representative artifacts:

- `agent_plan`;
- `chronology`;
- `issue_map`;
- `evidence_matrix`;
- `draft_memo`;
- `red_flag_memo`;
- `compliance_register`;
- `final_memo`;
- `registry_snapshot`;
- `audit_pack`;
- `feedback_export`;
- `eval_case`;
- `playbook_proposal`.

Each artifact should carry enough provenance to answer:

- which matter and source documents it used;
- which evidence and claims it depends on;
- which run, step, model/tool calls, and checkpoints produced it;
- which review tags and gate results apply;
- whether it is draft, blocked, approved, exported, or superseded;
- which audit events and eval cases reference it.

## Permission And Tool Policy

Default policy should be least privilege.

Allowed by default for the private-pilot harness:

- list/read local matters;
- search matter-scoped documents;
- read source/evidence items;
- create draft work products;
- add review tags;
- append audit events;
- request approval-gated exports.

Denied or gated by default:

- terminal access;
- browser automation;
- broad web search;
- email;
- destructive filesystem operations;
- cross-matter memory access;
- autonomous skill/playbook mutation;
- final/high-risk export without passing gates and explicit expert approval.

## Review And Gate Model

The review/gate model is the professional control boundary.

Review should support:

- expert acceptance, edits, rejection, and comments;
- unsupported claim, missing fact, contradiction, overclaim, and accepted
  analysis tags;
- links back to claim IDs, evidence IDs, source chunks, work products, runs,
  and audit events.

Gates should evaluate:

- citation/source coverage;
- unsupported or contradicted claims;
- missing materials;
- expert approval;
- tool policy compliance;
- matter isolation;
- export authorization;
- audit/eval provenance completeness.

High-risk exports must fail closed when required review, evidence, approval, or
gate state is missing.

## Audit, Eval, And Skills Loop

The audit/eval/skills loop is:

```text
review decision -> audit event -> feedback/eval case -> replay -> candidate skill/playbook -> human approval -> future bounded run
```

Audit traces must remain replayable and tied to source records. Eval outputs are
regression material, not professional conclusions. Skills and playbooks are
governed assets: they require matter/source provenance, versioning, approver
identity, timestamp, and replay evidence before they influence future runs.

## Consequences

- README and reviewer docs should lead with the Kernel positioning, not with a
  list of legal/compliance/audit/regulatory markets.
- Existing features should be regrouped rather than removed.
- Legal language should remain as first-pack domain insight, not the product
  category.
- Internal development language should be excluded from public-facing docs or
  clearly isolated in `.agentops`.
- The honest stage remains local/private-pilot until implementation and
  validation support stronger claims.
