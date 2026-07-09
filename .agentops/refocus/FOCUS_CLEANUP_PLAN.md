# Focus Cleanup Plan

Updated: 2026-07-09

## Goal

Make a reviewer understand in under 60 seconds that Aletheia is a local-first
agent harness for sensitive professional document work, not a scattered
legal/compliance/audit tool collection.

This plan is additive. It does not remove implemented functionality. It
regroups existing surfaces under Aletheia Kernel and Domain Packs.

## Progress

2026-07-09 follow-up pass applied the first public-doc cleanup:

- README now leads with the local-first sensitive-work harness, Codex analogy,
  Aletheia Kernel, Domain Packs, and Private Contract / Due Diligence Review as
  the first pack.
- `docs/product_thesis.md`, `docs/feature_map.md`, `docs/architecture.md`,
  `docs/reviewer_walkthrough.md`, `docs/demo_script.md`,
  `docs/deepseek_pitch.md`, and `docs/v1_private_pilot_status.md` now use the
  Kernel plus Domain Packs framing.
- `docs/product_kernel.md` and
  `docs/domain_packs/private_contract_due_diligence_review.md` were added as
  public-facing source docs for the new positioning.
- `.agentops/v1/V1_PRODUCT_SPEC.md` was updated to keep V1 aligned with the
  first domain-pack story.

2026-07-09 heartbeat follow-up applied a secondary-doc wording sweep:

- `docs/hermes_inspiration.md`, `docs/workflow_templates.md`,
  `docs/local_first_runtime.md`, and `docs/status.md` were updated to replace
  remaining old first-pack labels with Kernel/Domain Pack wording.
- `docs/public_wording_checklist.md` was added to prevent future public-doc
  broadening.

Remaining cleanup is limited to future opportunistic sweeps when new public
docs are added or old secondary docs are promoted into reviewer-facing material.

## README Wording To Change

- Replace the current opening category, "high-stakes professional Agent
  Workspace: an AgentOps + Evidence Workspace," with "local-first agent harness
  for sensitive professional document work."
- Move "legal, compliance, audit, due diligence, and regulatory workflows" out
  of the top positioning paragraph and into a Domain Packs paragraph.
- Add the Codex analogy near the top:
  `local matter vault -> agent creates professional artifacts -> gates run -> diff/review packet opens -> expert reviews -> final export`.
- Rename "Aletheia Core" in public architecture wording to "Aletheia Kernel"
  where the reusable product core is meant.
- Present workflow templates as Domain Packs. Lead with Private Contract / Due
  Diligence Review.
- Keep the caveats: local/private-pilot only, not production SaaS, not legal
  advice, external model calls off by default.
- Keep implemented terms such as audit pack, feedback export, gate engine, run
  trace, Matter Memory, and Playbooks, but explain them as Kernel capabilities.

## Docs Wording To Change

- `docs/product_thesis.md`: change "legal, compliance, and diligence work" to
  "sensitive professional document work" in the thesis, then list legal and
  diligence as first-pack examples.
- `docs/feature_map.md`: regroup sections as "Aletheia Kernel" and "Domain
  Packs." Preserve the existing Core, AgentOps, Trust Layer, and Eval Lab
  capabilities as Kernel submodules.
- `docs/architecture.md`: lead with Kernel + Domain Packs. Clarify that the
  Agent Workflow Layer, Trust & Governance Layer, and Knowledge & Document
  Layer are Kernel internals.
- `docs/reviewer_walkthrough.md`: update section 1 so the first mental model is
  "Codex for sensitive professional work." Move broad domain examples to a
  later "Domain Packs" section.
- `docs/demo_script.md`: use Private Contract / Due Diligence Review as the
  default demo path. Keep adjacent compliance/audit/regulatory templates as
  secondary pack previews.
- `docs/deepseek_pitch.md`: replace "Professional AgentOps + Evidence
  Workspace" as the headline with "local-first agent harness." Preserve the
  evidence/review/gates/audit/eval argument.
- `docs/v1_private_pilot_status.md`: keep status facts, but describe the
  validated path as the first domain pack on the Kernel.
- `.agentops/PRODUCT_SHAPE.md`: consider adding a prominent note that it is an
  internal coordination record and that public docs should use the refocus
  language in `.agentops/refocus/PRODUCT_KERNEL.md`.
- `.agentops/v1/V1_PRODUCT_SPEC.md`: keep V1 status, but rename the primary use
  case to Private Contract / Due Diligence Review and describe other personas
  as future/secondary packs.

## Features To Rename Or Regroup

- "Aletheia Core" -> "Aletheia Kernel" for reusable platform mechanics.
- "Aletheia AgentOps" -> "Agent Loop Runtime" or "Run Trace" when facing
  public reviewers; keep AgentOps internally if useful.
- "Aletheia Trust Layer" -> Kernel capabilities: Review + Gate Console,
  Permission + Tool Policy, Audit Trace.
- "Aletheia Eval Lab" -> Kernel capability: Eval Replay.
- "Legal Matter Review" -> "Private Contract / Due Diligence Review" for the
  first public/private-pilot pack.
- "Compliance Impact Review" -> "Compliance Obligation Pack."
- "Deal Due Diligence Memo" -> part of the Contract / Due Diligence Review Pack
  unless it needs a separate pack later.
- "Matter Workspace" -> "Local Matter Vault" where storage and boundary are the
  point; keep "workspace" for UI screens.
- "Professional Skills Loop" -> "Human-approved Skills" in public summaries.

## Places Where Aletheia Sounds Too Broad

- `README.md` opening paragraphs list legal, compliance, audit, due diligence,
  and regulatory workflows before the product category is crisp.
- `README.md` "What A Reviewer Should Notice" says the demo generalizes beyond
  legal into several domains; this should become "Domain Packs share the same
  Kernel."
- `docs/deepseek_pitch.md` frames many professional settings in the first
  screen instead of leading with the local-first harness.
- `docs/reviewer_walkthrough.md` describes "expert-led legal, compliance,
  audit, due diligence, and regulatory work" as the product category.
- `docs/v1_private_pilot_status.md` describes the validated path across all
  high-risk domains rather than as Kernel plus first pack.
- `.agentops/PRODUCT_SHAPE.md` contains many modules and cycle notes that are
  useful internally but too wide for a public reviewer.

## Places Where Aletheia Sounds Too Legal-Specific

- `README.md` demo flow uses "sample Legal Matter Review" and "legal review
  memo" before introducing the broader sensitive-work harness.
- `docs/status.md` says the completed flow demonstrates a full Legal Matter
  Review flow; that should be reframed as the first domain pack.
- `docs/demo_script.md` says "unsupervised legal advice" in the demo talk track;
  keep the caveat, but prefer "unsupervised professional advice" except where
  explicitly discussing legal boundaries.
- `.agentops/v1/V1_PRODUCT_SPEC.md` personas lead with legal reviewer and then
  expand; the refocus should keep legal as first pack, not the category.
- Any "no global legal memory" language should remain as a safety boundary, but
  public docs should also say "no cross-matter professional memory leakage."

## Places Where Internal Codex Development Language Should Be Removed

These should remain in `.agentops` if needed for coordination, but not appear in
public-facing docs:

- "this thread";
- "Codex heartbeat";
- "heartbeat";
- "supervisor cycles";
- "owner thread";
- "dirty worktree";
- "worktree handoff";
- "Cycle 20", "Cycle 31", or similar internal cycle notes;
- "route smoke" as a product claim without context;
- "fixture-backed prototype" unless clearly marked as reviewer caveat;
- "AgentOps checker" in public story docs, except in operator validation docs.

Observed internal-heavy files:

- `.agentops/PRODUCT_SHAPE.md`;
- `.agentops/STATUS_ROLLUP.md`;
- `.agentops/v1/SUPERVISOR_STATUS.md`;
- `.agentops/v1/status/*.json`;
- `docs/reviewer_walkthrough.md` and `docs/demo_script.md` have some
  fixture/route language that should be shortened for public use.

## Public-Facing Docs To Create

- `docs/product_kernel.md`: concise public version of Kernel + Domain Packs.
- `docs/domain_packs/private_contract_due_diligence_review.md`: first pack
  overview, artifacts, gates, demo script, and caveats.
- `docs/local_first_boundary.md`: what local-first means, what leaves the
  machine by default, and what external-provider configuration requires.
- `docs/review_gate_audit_eval_loop.md`: one-page explanation of the
  evidence-bound review loop.
- `docs/public_demo_path.md`: 2-5 minute reviewer path focused on the first
  domain pack.
- `docs/non_goals.md`: not legal advice, not production SaaS, not replacement
  for experts, not autonomous skill mutation.
- `docs/public_wording_checklist.md`: done.

## Suggested Cleanup Order

1. Update README opening, architecture summary, and workflow template labels.
2. Update `docs/product_thesis.md`, `docs/feature_map.md`, and
   `docs/reviewer_walkthrough.md` to use Kernel + Domain Packs.
3. Update `docs/demo_script.md` so Private Contract / Due Diligence Review is
   the default path.
4. Add public `docs/product_kernel.md` and first-pack docs.
5. Move internal cycle/status language out of public reviewer paths.
6. Add a short "Public wording checklist" to prevent future broadening. Done in
   `docs/public_wording_checklist.md`.
