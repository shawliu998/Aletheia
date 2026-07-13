# Feature Map

Current stage: **civil-litigation local-first MVP / private pilot candidate**. This repository
shows a professional prototype and validation posture; it should not be
overclaimed as production-ready SaaS, legal advice software, or a replacement
for expert judgment.

## Product Shape

Vera is a local-first civil-litigation workspace built on a reusable Kernel.
Only the Civil Litigation domain is active in V1.

## Aletheia Kernel

Purpose: reusable local-first harness for bounded professional agent loops.

Key surfaces:

- Local Vault: Matter Queue, matter profile, Document Registry, SQLite,
  filesystem documents, local exports, persisted civil-litigation demo data, and private
  pilot defaults.
- Agent Loop Runtime: bounded run traces with steps, specialist role labels,
  budgets, tool calls, workflow graph metadata, and human checkpoints.
- Typed Artifact Graph: plans, evidence, issues, registers, memos, snapshots,
  audit packs, feedback exports, and final exports.
- Permission + Tool Policy: narrow Tool Adapter and least-privilege policy for
  approved external-agent access.
- Review + Gate Console: human review tags, unsupported-claim flags, approval
  checkpoints, and fail-closed high-risk export gates.
- Audit Trace: Audit Workbench, reviewable events, registry snapshots, JSON
  exports, source provenance, and matter isolation.
- Eval Replay: feedback datasets, retrieval evals, completion/source-provenance
  audits, badcase regression, and playbook improvement proposals.
- Human-approved Skills: matter-scoped memory, approved playbooks, candidate
  skill proposals, and no autonomous playbook mutation.

Representative artifacts:

- `agent_plan`
- `chronology`
- `issue_map`
- `evidence_matrix`
- `draft_memo`
- `compliance_register`
- `red_flag_memo`
- `final_memo`

Status: MVP path exists for local demos and private pilot evaluation. Storage
is local SQLite plus owner-only filesystem data.

## Active Domain

Civil Litigation is the only active V1 domain. It covers intake, source
documents, facts and evidence, claims and defenses, legal authorities and
research, procedural events, deadlines, drafting, hearing preparation, review,
approval, and audit export.

Contract review, compliance, diligence, regulatory, and generic Agent Studio
implementations are isolated compatibility code and are not exposed as current
product workflows.

Status: the civil-litigation MVP path exists for demos and private pilot
evaluation. Production SaaS deployment and additional domains remain outside
the current boundary.

## Reviewer Takeaway

Aletheia demonstrates a product thesis for sensitive professional agents:

```text
Documents + Agent Runs
-> Evidence
-> Issues/Risks
-> Draft Work Products
-> Expert Review
-> Approval Gates
-> Audit Pack
-> Eval Cases
```

The meaningful innovation is not "AI answers legal questions." The meaningful
innovation is a governed workspace where high-risk professional outputs are
evidence-bound, human-approved, audit-ready, and eval-driven.
