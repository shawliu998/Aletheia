-- Append-only lawyer review decisions for completed Agent tasks. Execution
-- completion remains on agent_tasks; review state is derived from this log.

create table if not exists public.agent_task_review_decisions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  status text not null
    check (status in ('review_required', 'changes_requested', 'approved')),
  reviewer_id text,
  reviewer_email text,
  reviewer_name text,
  note text not null default ''
    check (char_length(note) <= 4000),
  artifact_snapshot jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agent_task_review_decisions_task_created_idx
  on public.agent_task_review_decisions(task_id, created_at asc, id asc);

alter table public.agent_task_review_decisions enable row level security;

revoke all on public.agent_task_review_decisions from anon, authenticated;
revoke all on public.agent_task_review_decisions from service_role;
grant select, insert on public.agent_task_review_decisions to service_role;

comment on table public.agent_task_review_decisions is
  'Append-only audit log. Application code must never update or delete individual decisions.';
