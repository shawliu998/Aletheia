-- Migration date: 2026-07-08

-- Source document chunks and evidence quote anchors for Aletheia.

create table if not exists public.aletheia_document_chunks (
  id uuid primary key default gen_random_uuid(),
  matter_id uuid not null references public.aletheia_matters(id) on delete cascade,
  matter_document_id uuid not null references public.aletheia_matter_documents(id) on delete cascade,
  user_id text not null,
  chunk_index integer not null,
  page integer,
  section text,
  text text not null,
  quote_start integer not null default 0,
  quote_end integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_aletheia_document_chunks_document_index
  on public.aletheia_document_chunks(matter_document_id, chunk_index);

create index if not exists idx_aletheia_document_chunks_matter
  on public.aletheia_document_chunks(matter_id);

alter table public.aletheia_document_chunks enable row level security;

drop policy if exists aletheia_document_chunks_visible on public.aletheia_document_chunks;
create policy aletheia_document_chunks_visible
  on public.aletheia_document_chunks
  for select
  using (
    exists (
      select 1
      from public.aletheia_matters m
      where m.id = matter_id
        and (
          m.user_id = auth.uid()::text
          or m.shared_with @> jsonb_build_array(auth.jwt() ->> 'email')
        )
    )
  );

drop policy if exists aletheia_document_chunks_owner_write on public.aletheia_document_chunks;
create policy aletheia_document_chunks_owner_write
  on public.aletheia_document_chunks
  for all
  using (user_id = auth.uid()::text)
  with check (user_id = auth.uid()::text);

alter table public.aletheia_evidence_items
  add column if not exists source_chunk_id uuid references public.aletheia_document_chunks(id) on delete set null,
  add column if not exists quote_start integer,
  add column if not exists quote_end integer;

create index if not exists idx_aletheia_evidence_items_source_chunk
  on public.aletheia_evidence_items(source_chunk_id);

revoke all on public.aletheia_document_chunks from anon, authenticated;
