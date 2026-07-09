# Private Contract / Due Diligence Review Pack

This is the first public/private-pilot Domain Pack for Aletheia.

It configures the Aletheia Kernel for confidential contract and diligence work:
local source documents, bounded agent loops, typed artifacts, evidence-bound
outputs, expert review, fail-closed gates, audit traces, eval replay, and
human-approved skills.

## Source Materials

Representative local matter files:

- agreements and amendments;
- schedules and exhibits;
- disclosure materials;
- VDR exports;
- emails and notices;
- payment records;
- diligence questions and responses.

## Artifacts

Representative typed artifacts:

- `agent_plan`;
- `chronology`;
- `issue_map`;
- `evidence_matrix`;
- `red_flag_memo`;
- `diligence_questions`;
- `review_packet`;
- `final_memo`;
- `audit_pack`;
- `feedback_export`;
- `eval_case`.

## Review And Gates

Expert review remains required. The pack should make unsupported claims,
missing facts, contradictions, overclaims, source gaps, approval state, and gate
failures visible before final export.

High-risk exports must fail closed unless required citations, human approvals,
tool-policy checks, and audit provenance are present.

## Demo Path

```text
local matter vault
-> import contracts and diligence files
-> parse/chunk/index
-> map source-linked evidence
-> create issue/risk map
-> draft red flag memo and diligence questions
-> open review packet
-> run gates
-> expert approves or requests revision
-> export final packet
-> replay eval cases from review/gate outcomes
```

## Boundaries

This pack supports expert-led review. It does not provide legal advice,
guaranteed legal correctness, autonomous final professional conclusions, or
production SaaS readiness. External model calls remain off by default for
sensitive/private data.
