-- Migration date: 2026-07-08

-- Matter-scoped memory and human-approved playbooks. There is intentionally no
-- global memory table to avoid cross-matter contamination.

create table if not exists public.aletheia_matter_memory_items (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.aletheia_matters(id) on delete cascade,
  user_id text not null,
  category text not null check (
    category in (
      'confirmed_fact',
      'output_preference',
      'excluded_path',
      'missing_material',
      'reviewer_feedback'
    )
  ),
  title text not null,
  body text not null,
  source text not null default 'human' check (source in ('human', 'review', 'system')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_aletheia_matter_memory_items_matter
  on public.aletheia_matter_memory_items(matter_id, created_at desc);

alter table public.aletheia_matter_memory_items enable row level security;

create table if not exists public.aletheia_playbooks (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.aletheia_matters(id) on delete cascade,
  user_id text not null,
  name text not null,
  description text,
  version text not null default 'v0.1',
  status text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  content jsonb not null default '{}'::jsonb,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_aletheia_playbooks_matter
  on public.aletheia_playbooks(matter_id, created_at desc);

alter table public.aletheia_playbooks enable row level security;

drop policy if exists aletheia_matter_memory_items_visible on public.aletheia_matter_memory_items;
create policy aletheia_matter_memory_items_visible
  on public.aletheia_matter_memory_items
  for select
  using (
    exists (
      select 1 from public.aletheia_matters m
      where m.id = matter_id
        and (
          m.user_id = auth.uid()::text
          or m.shared_with @> jsonb_build_array(auth.jwt() ->> 'email')
        )
    )
  );

drop policy if exists aletheia_matter_memory_items_owner_write on public.aletheia_matter_memory_items;
create policy aletheia_matter_memory_items_owner_write
  on public.aletheia_matter_memory_items
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

drop policy if exists aletheia_playbooks_visible on public.aletheia_playbooks;
create policy aletheia_playbooks_visible
  on public.aletheia_playbooks
  for select
  using (
    exists (
      select 1 from public.aletheia_matters m
      where m.id = matter_id
        and (
          m.user_id = auth.uid()::text
          or m.shared_with @> jsonb_build_array(auth.jwt() ->> 'email')
        )
    )
  );

drop policy if exists aletheia_playbooks_owner_write on public.aletheia_playbooks;
create policy aletheia_playbooks_owner_write
  on public.aletheia_playbooks
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

revoke all on public.aletheia_matter_memory_items from anon, authenticated;
revoke all on public.aletheia_playbooks from anon, authenticated;
