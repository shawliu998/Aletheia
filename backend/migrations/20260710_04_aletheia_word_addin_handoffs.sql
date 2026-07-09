-- Migration date: 2026-07-10

-- Word Add-in handoffs retain the document, selected-text hash, proposed edit,
-- review, and audit trail before a Word client may apply any tracked change.

alter table public.aletheia_work_products
  drop constraint if exists aletheia_work_products_kind_check;

alter table public.aletheia_work_products
  add constraint aletheia_work_products_kind_check
  check (
    kind in (
      'agent_plan', 'chronology', 'issue_map', 'evidence_matrix',
      'draft_memo', 'final_memo', 'compliance_register', 'red_flag_memo',
      'audit_pack', 'feedback_export', 'registry_snapshot',
      'external_source_workpaper', 'shareholder_penetration_graph',
      'legal_qa_answer', 'word_addin_handoff'
    )
  );
