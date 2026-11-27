-- Suitcase · migration 007 (Nov 26, 2026). Run after 006_more_ideas.sql.
-- Where each idea is, so the planner's map can pin it in the right place:
--   where_name: the specific place Claude named for it ("Lago di Misurina"), or null
--   lat, lng:   found by looking that up near the stop (Mapbox), or null when there's no clear place
--   geo_tried:  looked up already, so it isn't looked up again
-- Safe to run twice.

alter table public.stop_ideas add column if not exists where_name text check (where_name is null or length(where_name) <= 120);
alter table public.stop_ideas add column if not exists lat double precision check (lat is null or lat between -90 and 90);
alter table public.stop_ideas add column if not exists lng double precision check (lng is null or lng between -180 and 180);
alter table public.stop_ideas add column if not exists geo_tried boolean not null default false;
