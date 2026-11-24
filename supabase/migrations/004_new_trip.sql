-- Suitcase · migration 004 for the new trip pop-up and "Inspire me" (Nov 23, 2026). Run after 003_shape.sql.

-- Where the trip goes, as typed in "Where are you going?" (e.g. 'Patagonia, Peru'),
-- and the places picked from the suggestions: [{ name, kind, country, cc, lat, lng }].
alter table public.trips add column if not exists destination text;
alter table public.trips add column if not exists destination_places jsonb not null default '[]'::jsonb;

-- One row per AI draft, so the draft-trip function can limit how many drafts a person asks for per day.
-- No trip text is kept here.
create table if not exists public.ai_drafts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text not null check (kind in ('inspire', 'vague', 'paste')),
  created_at timestamptz not null default now()
);
create index if not exists ai_drafts_user_time on public.ai_drafts (user_id, created_at);

alter table public.ai_drafts enable row level security;
create policy "own drafts read" on public.ai_drafts for select to authenticated using (user_id = auth.uid());
create policy "own drafts add" on public.ai_drafts for insert to authenticated with check (user_id = auth.uid());
grant select, insert on public.ai_drafts to authenticated;
