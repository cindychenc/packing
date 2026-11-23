-- Suitcase · migration 003 for the "Shape the trip" flow (Nov 23, 2026). Run after 002_planner.sql.
-- Phases can be named automatically from their first stop (the country, or the continent for a country).
-- auto_name stays true until someone renames the phase; then the app stops renaming it.
-- apply_layout() is unchanged: new phases start with auto_name = true, and renames are normal updates.

alter table public.phases add column if not exists auto_name boolean not null default true;

-- Phases that already have a name were named by hand.
update public.phases set auto_name = (name is null or trim(name) = '');
