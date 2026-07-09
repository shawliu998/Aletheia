# Aletheia Product Kernel

Updated: 2026-07-09

## One-Line Positioning

Aletheia is a local-first agent harness for sensitive professional document work.

Short form:

```text
Codex for sensitive professional work.
```

It brings bounded agent loops, typed artifacts, evidence-bound outputs, human
review, gates, audit traces, eval replay, and human-approved skills to local
matter vaults.

## Why Not "Legal AI"

Aletheia is not a legal chatbot, legal advice generator, or lawyer replacement.
Legal review is founder/domain insight and the first concrete domain pack, not
the whole product category.

The sharper product category is sensitive professional work where an expert must
inspect the source material, review the reasoning path, approve the output, and
retain an audit/eval trail. Legal, compliance, audit, regulatory, and diligence
work are domain packs on top of the same local-first harness.

Public wording should avoid implying:

- autonomous legal advice;
- guaranteed legal correctness;
- replacement of lawyers, auditors, compliance officers, or other experts;
- generic multi-industry SaaS readiness;
- production compliance guarantees beyond what the repository actually
  validates.

## Kernel vs Domain Packs

### Aletheia Kernel

The Kernel is the reusable product core:

- Local Vault;
- Agent Loop Runtime;
- Typed Artifact Graph;
- Permission + Tool Policy;
- Review + Gate Console;
- Audit Trace;
- Eval Replay;
- Human-approved Skills.

The Kernel owns the cross-domain mechanics: matter-scoped storage, bounded run
state, document/source provenance, work-product schemas, tool allowlists, human
checkpoints, gate decisions, audit events, eval cases, and approved playbooks.

### Domain Packs

Domain Packs configure the Kernel for a professional workflow without changing
the underlying safety model.

Current and planned pack language:

- Contract / Due Diligence Review Pack;
- Compliance Obligation Pack;
- Audit Evidence Pack;
- Regulatory Response Pack;
- Litigation Chronology Pack.

Domain Packs may define templates, artifact schemas, source checklists, review
tags, gate policies, export formats, and evaluation cases. They must still use
Kernel boundaries for local storage, evidence binding, expert review, gates,
audit traces, eval replay, and skill approval.

## Codex Analogy

Codex:

```text
repo -> agent edits code -> tests run -> diff opens -> human reviews -> merge
```

Aletheia:

```text
local matter vault -> agent creates professional artifacts -> gates run -> diff/review packet opens -> expert reviews -> final export
```

The analogy is about workflow shape, not code editing. Aletheia should make the
professional output inspectable before it is accepted: source materials,
artifact diffs, gate failures, approvals, and audit records should be visible to
the responsible expert.

## Hermes Analogy

Aletheia adapts the Hermes-style skills/memory/eval loop to professional work:

```text
expert review -> structured feedback -> candidate skill/playbook update -> human approval -> replay/eval -> future bounded run
```

The important boundary is governance. Skills and playbooks are not silently
self-modified by agents. Matter Memory stays matter-scoped, candidate skills
remain inactive until approved, and eval replay must preserve source evidence,
review tags, gate results, audit events, and approver identity.

## Local-First Boundary

Local-first is the central strategy, not a temporary implementation detail.

Default assumptions:

- sensitive source documents start inside a local matter vault;
- SQLite/filesystem local storage is the private-pilot baseline;
- external model calls are off by default for sensitive/private data;
- any external provider use must be explicit, configurable, logged, auditable,
  and bounded by tool policy;
- Supabase/Postgres compatibility is an adapter path, not the public product
  boundary;
- no public wording should imply production SaaS unless the repository has
  matching implementation, security review, operations, and validation evidence.

## First Domain Pack

First public/private-pilot pack:

```text
Private Contract / Due Diligence Review
```

This pack should be the default demo and reviewer story. It uses a local matter
vault containing contracts, schedules, disclosure materials, diligence files,
emails, notices, and related source documents. The agent loop produces
evidence matrices, issue/risk maps, red flag memos, diligence questions,
review packets, audit packs, and eval cases.

Adjacent legal/compliance/audit/regulatory examples should be framed as future
or secondary Domain Packs unless they are the immediate demo path.

## Non-Goals

- A generic chatbot.
- A legal advice system.
- A replacement for qualified professional judgment.
- A broad multi-industry SaaS positioning.
- Autonomous final exports without expert review.
- Autonomous skill or playbook self-modification.
- Global legal memory or cross-matter leakage.
- Browser/terminal/email/web automation as default tools for sensitive matters.
- Production SaaS, compliance certification, or guaranteed correctness claims
  without implementation and validation evidence.
