# Hermes Professional Phase Plan

Last updated: 2026-07-10T01:30:46+08:00

Purpose: restart coordinated Hermes-style professional hardening after the V1
local/private-pilot loop reached P0 completion. This file is the stable entry
point for the 10-minute execution and supervisor heartbeats created on
2026-07-10.

## Active Coordination

- Execution heartbeat: `hermes`, attached to the current thread, every 10
  minutes.
- Supervisor heartbeat: `hermes-2`, attached to supervisor thread
  `019f47ee-4bb3-7602-a1e8-3375c50e0a77`, every 10 minutes.
- Current execution rule: keep changes narrow, preserve user/parallel-thread
  work, and record each cycle before moving to the next phase.
- Current supervisor rule: read-only supervision unless explicitly assigned an
  implementation slice.

## Phase 1: Execution And Supervision Baseline

Goal: make the long-running work controllable before new feature hardening.

Acceptance:

- 10-minute execution heartbeat exists.
- 10-minute supervisor heartbeat exists.
- A supervisor window exists and has a read-only coordination brief.
- The current dirty worktree is treated as existing work and not reverted.
- Fast operator health is run and recorded for the resumed cycle.
- The next implementation target is chosen from existing post-P0 handoff docs.

Recommended close command:

```bash
cd backend && npm run check:aletheia:operator
node .agentops/scripts/check-agentops.mjs
```

## Phase 2: Professional Core Hardening

Goal: harden the professional trust boundary beyond P0 view coverage.

Priority order:

1. Preserve persisted gate evidence IDs in export, typed handoff, and eval
   snapshots.
2. Map Big @ unresolved or ambiguous reference outcomes to explicit audit or
   review candidates.
3. Ensure eval snapshots and candidate skills preserve source review, gate,
   evidence, audit, feedback export, and approved playbook provenance.
4. Keep approved exports behind persisted approval, gate, and audit evidence.

Source docs:

- `.agentops/PERSISTENCE_SEMANTICS_PLAN.md`
- `.agentops/PERSISTED_GATE_ACCEPTANCE.md`
- `.agentops/BIG_AT_REFERENCE_SEMANTICS_HANDOFF.md`
- `.agentops/TYPED_HANDOFF_PROVENANCE_HANDOFF.md`
- `.agentops/EVAL_SNAPSHOT_PERSISTENCE_HANDOFF.md`
- `.agentops/AUDIT_EXPORT_PROVENANCE_HANDOFF.md`
- `.agentops/ANDUAI_PARITY_HERMES_REQUIREMENTS.md`

AnduAI parity requirements added on 2026-07-10:

- general legal Q&A with citation/review controls;
- whole-web / external-source automated checks with retained workpapers;
- shareholder penetration and related-party graphing with source-backed edges;
- Word Add-in workflow for selected-text Q&A, drafting, comments, tracked
  changes, and matter sync;
- user habit learning as opt-in, scoped, inspectable, revocable, and
  human-approved preference/playbook learning.

## Phase 3: Professional Experience And Packaging

Goal: make the private/professional experience easier to inspect, install, and
operate without broadening product claims.

Candidate work:

- Desktop/private deployment packaging checks.
- Word Add-in proof-of-concept and matter sync workflow.
- Legal Q&A / network-check / shareholder-graph professional UI surfaces.
- Reviewer-facing clarity around preview downloads versus approved exports.
- Operator health, backup, restore, privacy, and release-evidence workflows.
- UI polish only where it improves professional inspection and decision making.

## Phase 4: Release Evidence And Commit Readiness

Goal: prepare a reviewable professional release slice.

Acceptance:

- Relevant backend checks pass for changed surfaces.
- Frontend lint/typecheck and UI smoke pass when UI behavior changes.
- AgentOps status/checker passes.
- Docs preserve local/private-pilot caveats.
- Dirty worktree is split intentionally according to existing commit guidance.

## Stop Conditions

Pause and record a conflict before proceeding if any change:

- treats AgentOps view models as source-of-truth professional records;
- enables broad web checks, legal Q&A, Word Add-in edits, graph conclusions, or
  preference learning without source, review, gate, audit, and privacy controls;
- authorizes final exports from UI-only booleans;
- drops matter, document, source chunk, evidence, review, checkpoint, audit,
  run, feedback export, or approved playbook provenance;
- promotes candidate skills without human-approved playbook provenance;
- broadens Aletheia/Hermes claims beyond local/private-pilot evidence.
