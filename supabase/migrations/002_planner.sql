-- Suitcase · database update 002: the Planner (Nov 22, 2026)
-- Paste into Supabase → SQL Editor → New query → Run, once, after 001_schema.sql.
-- Runs as one transaction: if anything fails, nothing changes.
--
-- What changes:
--   • Trips can be planned before they have dates: start_date is optional, the trip stores its length
--     (length_days); end_date is now worked out from start_date + length_days.
--   • Days are kept in order by position (idx = 0, 1, 2…), not by date, so adding a day to one phase can move the
--     next phases later. A day's date = the trip's start_date + idx (see the days_dated view); none without a start date.
--   • Phases can be unnamed (the manager shows "First area to explore…").
--   • apply_layout(): one call that saves a whole new order of phases and days (resize, reorder, add/remove a day,
--     new phase, undo), all or nothing.
-- Bookings (stays, flights, cars, transfers) keep their own dates and never move with the days.

begin;

-- ───────────────────────── trips: optional start date + length ─────────────────────────

alter table public.trips add column length_days int;
update public.trips set length_days = end_date - start_date + 1;
alter table public.trips alter column length_days set not null;
alter table public.trips add constraint trip_length check (length_days between 1 and 731);

drop trigger trips_after_update_dates on public.trips;
drop function public.trip_dates_changed();

-- phase_spans reads days.date, which goes away below; it comes back further down.
drop view public.phase_spans;

alter table public.trips drop constraint trip_dates;
alter table public.trips drop column end_date;
alter table public.trips alter column start_date drop not null;
alter table public.trips add column end_date date generated always as (start_date + (length_days - 1)) stored;

-- ───────────────────────── days: position instead of date ─────────────────────────

alter table public.days add column idx int;
update public.days d set idx = d.date - t.start_date from public.trips t where t.id = d.trip_id;
alter table public.days alter column idx set not null;
alter table public.days drop column date;                     -- also drops unique (trip_id, date)
alter table public.days add constraint day_idx check (idx >= 0);
-- Deferrable, so a whole trip can be renumbered inside one transaction.
alter table public.days add constraint days_trip_idx unique (trip_id, idx) deferrable initially deferred;

-- ───────────────────────── phases: name optional ─────────────────────────

alter table public.phases alter column name drop not null;

-- ───────────────────────── views ─────────────────────────

-- Days with their dates (null when the trip has no start date yet). For Carryon's feed and for matching bookings.
create view public.days_dated with (security_invoker = true) as
  select d.*, t.start_date + d.idx as date
  from public.days d join public.trips t on t.id = d.trip_id;

-- A phase's span, worked out from its days (dates are null when the trip has no start date).
create view public.phase_spans with (security_invoker = true) as
  select p.id as phase_id, p.trip_id,
         min(d.idx) as first_idx, max(d.idx) as last_idx, count(d.id) as days,
         t.start_date + min(d.idx) as start_date, t.start_date + max(d.idx) as end_date
  from public.phases p
  join public.trips t on t.id = p.trip_id
  left join public.days d on d.phase_id = p.id
  group by p.id, p.trip_id, t.start_date;

-- ───────────────────────── rules ─────────────────────────

-- New trip: make its owner a member and create length_days empty days.
create or replace function public.trip_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into trip_members (trip_id, user_id, role) values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  insert into days (trip_id, idx)
  select new.id, g from generate_series(0, new.length_days - 1) g;
  return new;
end $$;

-- Length changed: add empty days at the end, or remove days from the end.
-- Refused if a day that would be removed has a location, plan or notes (the manager asks first and deletes them).
-- Changing start_date never touches days: it only moves the whole trip on the calendar.
create or replace function public.trip_length_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.length_days = old.length_days then
    return new;
  end if;
  if exists (select 1 from days d where d.trip_id = new.id and d.idx >= new.length_days
             and (coalesce(trim(d.location), '') <> '' or coalesce(trim(d.plan), '') <> ''
                  or coalesce(trim(d.notes), '') <> '')) then
    raise exception 'DAYS_WITH_CONTENT_OUTSIDE_DATES'
      using hint = 'Delete the days at the end of the trip first.';
  end if;
  delete from days d where d.trip_id = new.id and d.idx >= new.length_days;
  insert into days (trip_id, idx)
  select new.id, g from generate_series(0, new.length_days - 1) g
  where not exists (select 1 from days d where d.trip_id = new.id and d.idx = g);
  return new;
end $$;

create trigger trips_after_update_length
  after update of length_days on public.trips
  for each row execute function public.trip_length_changed();

-- ───────────────────────── apply_layout ─────────────────────────
-- Saves a whole new order of phases and days for one trip, all or nothing.
--   p_phases: [{id, name, colour, photo_url, photo_credit, sort}, …]   phases left out are deleted
--   p_days:   [{id, idx, phase_id, location, plan, notes}, …]          days left out are deleted; new ids are added
--   p_expect: the trip's updated_at as the manager last saw it (null = don't check)
-- Rules checked: idx runs 0…n-1; every phase has at least one day and its days are next to each other;
-- phases come in sort order; days without a phase come after all phases.
-- Returns the trip's new updated_at.
create or replace function public.apply_layout(p_trip uuid, p_expect timestamptz, p_phases jsonb, p_days jsonb)
returns timestamptz
language plpgsql security invoker set search_path = public as $$
declare
  v_updated timestamptz;
  n int := jsonb_array_length(p_days);
begin
  if not is_trip_editor(p_trip) then
    raise exception 'NOT_ALLOWED';
  end if;
  select updated_at into v_updated from trips where id = p_trip for update;
  if not found then
    raise exception 'TRIP_NOT_FOUND';
  end if;
  if p_expect is not null and v_updated <> p_expect then
    raise exception 'LAYOUT_CHANGED' using hint = 'This trip was changed somewhere else. Reload it.';
  end if;
  if n < 1 or n > 731 then
    raise exception 'BAD_LAYOUT: a trip is 1 to 731 days';
  end if;

  if (select count(*) <> n or count(distinct idx) <> n or min(idx) <> 0 or max(idx) <> n - 1 or count(distinct id) <> n
      or bool_or(id is null) from jsonb_to_recordset(p_days) as _d(id uuid, idx int, phase_id uuid, location text, plan text, notes text)) then
    raise exception 'BAD_LAYOUT: days must be numbered 0 to %', n - 1;
  end if;
  if (select count(distinct id) <> count(*) or count(distinct sort) <> count(*) or bool_or(id is null) from jsonb_to_recordset(p_phases) as _p(id uuid, name text, colour text, photo_url text, photo_credit text, sort int)) then
    raise exception 'BAD_LAYOUT: phases need unique ids and sort values';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_days) as _d(id uuid, idx int, phase_id uuid, location text, plan text, notes text) where phase_id is not null and phase_id not in (select id from jsonb_to_recordset(p_phases) as _p(id uuid, name text, colour text, photo_url text, photo_credit text, sort int))) then
    raise exception 'BAD_LAYOUT: a day points to a phase that is not in the layout';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_days) as _d(id uuid, idx int, phase_id uuid, location text, plan text, notes text) join days d on d.id = _d.id where d.trip_id <> p_trip)
     or exists (select 1 from jsonb_to_recordset(p_phases) as _p(id uuid, name text, colour text, photo_url text, photo_credit text, sort int) join phases p on p.id = _p.id where p.trip_id <> p_trip) then
    raise exception 'BAD_LAYOUT: rows from another trip';
  end if;
  -- each phase: at least one day, all next to each other
  if exists (select 1 from jsonb_to_recordset(p_phases) as _p(id uuid, name text, colour text, photo_url text, photo_credit text, sort int) left join jsonb_to_recordset(p_days) as _d(id uuid, idx int, phase_id uuid, location text, plan text, notes text) on _d.phase_id = _p.id group by _p.id
             having count(_d.id) = 0 or max(_d.idx) - min(_d.idx) + 1 <> count(_d.id)) then
    raise exception 'BAD_LAYOUT: every phase needs days that are next to each other';
  end if;
  -- phases in sort order
  if exists (select 1 from (select _p.sort, min(_d.idx) as a from jsonb_to_recordset(p_phases) as _p(id uuid, name text, colour text, photo_url text, photo_credit text, sort int) join jsonb_to_recordset(p_days) as _d(id uuid, idx int, phase_id uuid, location text, plan text, notes text) on _d.phase_id = _p.id group by _p.id, _p.sort) x
             join (select _p.sort, min(_d.idx) as a from jsonb_to_recordset(p_phases) as _p(id uuid, name text, colour text, photo_url text, photo_credit text, sort int) join jsonb_to_recordset(p_days) as _d(id uuid, idx int, phase_id uuid, location text, plan text, notes text) on _d.phase_id = _p.id group by _p.id, _p.sort) y
             on x.sort < y.sort and x.a > y.a) then
    raise exception 'BAD_LAYOUT: phases are not in sort order';
  end if;
  -- days without a phase come last
  if (select min(idx) from jsonb_to_recordset(p_days) as _d(id uuid, idx int, phase_id uuid, location text, plan text, notes text) where phase_id is null) < (select max(idx) from jsonb_to_recordset(p_days) as _d(id uuid, idx int, phase_id uuid, location text, plan text, notes text) where phase_id is not null) then
    raise exception 'BAD_LAYOUT: days without a phase must come after the phases';
  end if;

  -- phases first (new ones are inserted), so days can point to them
  insert into phases (id, trip_id, name, colour, photo_url, photo_credit, sort)
  select id, p_trip, nullif(trim(name), ''), colour, photo_url, photo_credit, sort from jsonb_to_recordset(p_phases) as _p(id uuid, name text, colour text, photo_url text, photo_credit text, sort int)
  on conflict (id) do update set name = excluded.name, colour = excluded.colour, photo_url = excluded.photo_url,
    photo_credit = excluded.photo_credit, sort = excluded.sort;

  delete from days where trip_id = p_trip and id not in (select id from jsonb_to_recordset(p_days) as _d(id uuid, idx int, phase_id uuid, location text, plan text, notes text));
  insert into days (id, trip_id, idx, phase_id, location, plan, notes)
  select id, p_trip, idx, phase_id, location, plan, notes from jsonb_to_recordset(p_days) as _d(id uuid, idx int, phase_id uuid, location text, plan text, notes text)
  on conflict (id) do update set idx = excluded.idx, phase_id = excluded.phase_id, location = excluded.location,
    plan = excluded.plan, notes = excluded.notes;

  delete from phases where trip_id = p_trip and id not in (select id from jsonb_to_recordset(p_phases) as _p(id uuid, name text, colour text, photo_url text, photo_credit text, sort int));

  update trips set length_days = n where id = p_trip returning updated_at into v_updated;
  return v_updated;
end $$;

revoke execute on function public.apply_layout(uuid, timestamptz, jsonb, jsonb) from public, anon;
grant execute on function public.apply_layout(uuid, timestamptz, jsonb, jsonb) to authenticated;

-- ───────────────────────── access ─────────────────────────

grant select on public.days_dated, public.phase_spans to authenticated;

commit;
