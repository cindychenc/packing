-- Suitcase · migration 005 (Nov 25, 2026). Run after 004_new_trip.sql.
-- A trip made from a generated route now fills in only the fixed days (travel, highlights, multi-day events).
--   • days.plan_auto: the plan was filled in by Suitcase; the planner shows a small mark until someone edits it.
--   • stop_ideas: everything else Claude suggested for a stop, kept for the ideas feature. Not shown anywhere yet.
-- Safe to run twice.

alter table public.days add column if not exists plan_auto boolean not null default false;

create table if not exists public.stop_ideas (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.trips (id) on delete cascade,
  place       text not null,                        -- the stop's name, as on the trip's days
  text        text not null check (length(text) between 1 and 300),
  source      text not null default 'route' check (source in ('route', 'mine', 'claude')),
  sort        int not null default 0,
  created_by  uuid references auth.users (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists stop_ideas_trip on public.stop_ideas (trip_id, place, sort);

-- the app's signed-in role needs table access too (as in 001); RLS below still limits it to the trip's members
grant select, insert, update, delete on public.stop_ideas to authenticated;

alter table public.stop_ideas enable row level security;
drop policy if exists "members read" on public.stop_ideas;
drop policy if exists "editors write" on public.stop_ideas;
drop policy if exists "editors update" on public.stop_ideas;
drop policy if exists "editors delete" on public.stop_ideas;
create policy "members read" on public.stop_ideas for select to authenticated using (public.is_trip_member(trip_id));
create policy "editors write" on public.stop_ideas for insert to authenticated with check (public.is_trip_editor(trip_id));
create policy "editors update" on public.stop_ideas for update to authenticated using (public.is_trip_editor(trip_id)) with check (public.is_trip_editor(trip_id));
create policy "editors delete" on public.stop_ideas for delete to authenticated using (public.is_trip_editor(trip_id));
