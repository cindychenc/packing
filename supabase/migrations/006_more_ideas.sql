-- Suitcase · migration 006 (Nov 26, 2026). Run after 005_ideas.sql.
-- "Find more" in the planner's ideas card:
--   • trips.prefs: what the traveller said they like when making the trip (interests, how active, who, pace),
--     for the "For you" ideas.
--   • stop_ideas: two more sources ('you' for For you, 'top' for Top visited), plus each idea's note, length and,
--     for For you, the reason ("You like markets").
--   • place_ideas: a shared cache of those lists by place (and preferences), so the same list is only asked of
--     Claude once. It holds no trip or personal data. Only the stop-ideas Edge Function reads and writes it.
-- Safe to run twice.

alter table public.trips add column if not exists prefs jsonb;

alter table public.stop_ideas add column if not exists note text check (note is null or length(note) <= 300);
alter table public.stop_ideas add column if not exists len text check (len is null or length(len) <= 40);
alter table public.stop_ideas add column if not exists reason text check (reason is null or length(reason) <= 80);
alter table public.stop_ideas drop constraint if exists stop_ideas_source_check;
alter table public.stop_ideas add constraint stop_ideas_source_check check (source in ('route', 'mine', 'claude', 'you', 'top'));

create table if not exists public.place_ideas (
  key        text primary key,          -- kind | place | country | month | preferences, lower case
  items      jsonb not null,
  model      text,
  created_at timestamptz not null default now()
);
-- No policies and no grants: the browser can't see it. The Edge Function uses the service role.
alter table public.place_ideas enable row level security;
revoke all on public.place_ideas from anon, authenticated;

-- Calls for ideas have their own daily limit (they don't use up route drafts), and record their token use.
alter table public.ai_drafts drop constraint if exists ai_drafts_kind_check;
alter table public.ai_drafts add constraint ai_drafts_kind_check check (kind in ('inspire', 'vague', 'paste', 'ideas'));
alter table public.ai_drafts add column if not exists tokens_in int;
alter table public.ai_drafts add column if not exists tokens_out int;
