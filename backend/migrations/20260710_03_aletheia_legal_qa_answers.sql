-- Migration date: 2026-07-10

-- Source-grounded legal Q&A answers are reviewable work products. They remain
-- preliminary until a human reviewer confirms the source support and scope.

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
      'registry_snapshot',
      'external_source_workpaper',
      'shareholder_penetration_graph',
      'legal_qa_answer'
    )
  );
