-- Migration date: 2026-07-09

-- Budget and telemetry fields for governed agent loops, plus richer human
-- checkpoint decisions. These are JSONB so future token/cost/latency telemetry
-- can evolve without repeatedly widening the runtime tables.

alter table public.aletheia_agent_runs
  add column if not exists budget jsonb not null default '{}'::jsonb;

alter table public.aletheia_agent_steps
  add column if not exists metrics jsonb not null default '{}'::jsonb;

alter table public.aletheia_tool_calls
  add column if not exists metrics jsonb not null default '{}'::jsonb;

alter table public.aletheia_human_checkpoints
  drop constraint if exists aletheia_human_checkpoints_status_check;

alter table public.aletheia_human_checkpoints
  add constraint aletheia_human_checkpoints_status_check
  check (status in ('open', 'approved', 'rejected', 'resolved', 'cancelled'));

alter table public.aletheia_human_checkpoints
  drop constraint if exists aletheia_human_checkpoints_decision_check;

alter table public.aletheia_human_checkpoints
  add constraint aletheia_human_checkpoints_decision_check
  check (
    decision is null
    or decision in ('approved', 'rejected', 'edited', 'responded')
  );
