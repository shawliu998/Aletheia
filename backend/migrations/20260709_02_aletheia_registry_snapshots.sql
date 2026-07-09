-- Migration date: 2026-07-09

-- Matter-scoped registry snapshots store filtered Evidence/Review/Audit
-- registry views as reviewable work products. They are local working snapshots,
-- not final audit packs.

alter table public.aletheia_work_products
  drop constraint if exists aletheia_work_products_kind_check;

alter table public.aletheia_work_products
  add constraint aletheia_work_products_kind_check
  check (
    kind in (
      'agent_plan',
      'chronology',
      'issue_map',
      'evidence_matrix',
      'draft_memo',
      'final_memo',
      'compliance_register',
      'red_flag_memo',
      'audit_pack',
      'feedback_export',
      'registry_snapshot'
    )
  );
