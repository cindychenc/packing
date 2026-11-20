-- Suitcase · database setup v1 (Nov 19, 2026)
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run once on an empty project.
-- Creates: trips and everything in them, share links for Carryon, access rules (row-level security),
-- automatic day rows when a trip is created or its dates change, and a profile for each new account.

create extension if not exists pgcrypto;

-- ───────────────────────── helpers ─────────────────────────

create type public.booking_status as enum ('booked', 'to book', 'on arrival', 'cancelled');
-- (no status = not a booking: camping, a free ferry, a night on a bus)

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ───────────────────────── accounts ─────────────────────────

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text,
  home_currency text not null default 'CAD',
  phrase_lang   text not null default 'es',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- A profile row for every new account (magic link or, later, Google).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────────────────── trips ─────────────────────────

create table public.trips (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  subtitle    text,
  start_date  date not null,
  end_date    date not null,
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint trip_dates check (end_date >= start_date and end_date - start_date <= 730)
);

create table public.trip_members (
  trip_id    uuid not null references public.trips (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);

-- Used by the access rules. "security definer" so the rules don't loop through trip_members' own rules.
create or replace function public.is_trip_member(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from trip_members m where m.trip_id = t and m.user_id = auth.uid());
$$;

create or replace function public.is_trip_editor(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from trip_members m where m.trip_id = t and m.user_id = auth.uid()
                 and m.role in ('owner', 'editor'));
$$;

-- Share links for Carryon. The token goes in carryon.boringcase.com/#<token>.
create table public.share_links (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.trips (id) on delete cascade,
  token       text not null unique
              default translate(encode(gen_random_bytes(18), 'base64'), '+/', '-_'),
  permission  text not null default 'view' check (permission in ('view', 'view+plan')),
  label       text,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ───────────────────────── phases and days ─────────────────────────

-- A phase's dates are worked out from its days (see the phase_spans view below), as in the sheet.
create table public.phases (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references public.trips (id) on delete cascade,
  name         text not null,
  colour       text,                -- e.g. '#4A7A0E'
  photo_url    text check (photo_url is null or photo_url ~* '^https://'),
  photo_credit text,
  sort         int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.days (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.trips (id) on delete cascade,
  date        date not null,
  phase_id    uuid references public.phases (id) on delete set null,
  location    text,
  plan        text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (trip_id, date)
);

create view public.phase_spans with (security_invoker = true) as
  select p.id as phase_id, p.trip_id, min(d.date) as start_date, max(d.date) as end_date, count(d.id) as days
  from public.phases p left join public.days d on d.phase_id = p.id
  group by p.id, p.trip_id;

-- New trip: make its owner a member and create one day per date.
create or replace function public.trip_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into trip_members (trip_id, user_id, role) values (new.id, new.owner_id, 'owner')
  on conflict do nothing;
  insert into days (trip_id, date)
  select new.id, g::date from generate_series(new.start_date, new.end_date, interval '1 day') g;
  return new;
end $$;

create trigger trips_after_insert
  after insert on public.trips
  for each row execute function public.trip_created();

-- Dates changed: add the missing days, remove empty days outside the new dates.
-- If a day outside the new dates has a location, plan or notes, the change is refused
-- (the manager asks first and deletes those days itself before changing the dates).
create or replace function public.trip_dates_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.start_date = old.start_date and new.end_date = old.end_date then
    return new;
  end if;
  if exists (select 1 from days d where d.trip_id = new.id
             and (d.date < new.start_date or d.date > new.end_date)
             and (coalesce(trim(d.location), '') <> '' or coalesce(trim(d.plan), '') <> ''
                  or coalesce(trim(d.notes), '') <> '')) then
    raise exception 'DAYS_WITH_CONTENT_OUTSIDE_DATES'
      using hint = 'Delete or move the days outside the new dates first.';
  end if;
  delete from days d where d.trip_id = new.id and (d.date < new.start_date or d.date > new.end_date);
  insert into days (trip_id, date)
  select new.id, g::date from generate_series(new.start_date, new.end_date, interval '1 day') g
  on conflict (trip_id, date) do nothing;
  return new;
end $$;

create trigger trips_after_update_dates
  after update of start_date, end_date on public.trips
  for each row execute function public.trip_dates_changed();

-- ───────────────────────── bookings ─────────────────────────
-- What Carryon may show lives here. Confirmation numbers, manage links and private notes
-- live in booking_private, which the Carryon feed never reads.

create table public.stays (
  id             uuid primary key default gen_random_uuid(),
  trip_id        uuid not null references public.trips (id) on delete cascade,
  status         public.booking_status,
  place          text,
  check_in_date  date not null,
  check_out_date date not null,
  name           text,
  address        text,
  booked_via     text,
  check_in_time  time,
  check_out_time time,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint stay_dates check (check_out_date > check_in_date)
);

create table public.flights (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips (id) on delete cascade,
  status        public.booking_status,
  date          date not null,
  airline_iata  text,
  flight_no     text,
  from_iata     text,
  to_iata       text,
  departs       time,
  arrives       time,
  arrival_date  date,
  booked_via    text,
  status_link   text check (status_link is null or status_link ~* '^https://'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.car_rentals (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips (id) on delete cascade,
  status        public.booking_status,
  company       text,
  pickup_date   date not null,
  pickup_time   time,
  pickup_place  text,
  return_date   date,
  return_time   time,
  return_place  text,
  car           text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.transfers (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips (id) on delete cascade,
  status        public.booking_status,
  date          date not null,
  kind          text not null default 'Bus',   -- Bus, Train, Ferry, Shuttle…
  from_place    text,
  to_place      text,
  company       text,
  departs       time,
  arrives       time,
  booking_link  text check (booking_link is null or booking_link ~* '^https?://'),  -- sent to Carryon only while "to book"
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.booking_private (
  id               uuid primary key default gen_random_uuid(),
  trip_id          uuid not null references public.trips (id) on delete cascade,
  booking_type     text not null check (booking_type in ('stay', 'flight', 'car', 'transfer')),
  booking_id       uuid not null,
  confirmation_no  text,
  manage_link      text,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (booking_type, booking_id)
);

-- Deleting a booking deletes its private details too.
create or replace function public.delete_booking_private() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from booking_private where booking_type = tg_argv[0] and booking_id = old.id;
  return old;
end $$;

create trigger stays_private_cleanup       after delete on public.stays       for each row execute function public.delete_booking_private('stay');
create trigger flights_private_cleanup     after delete on public.flights     for each row execute function public.delete_booking_private('flight');
create trigger car_rentals_private_cleanup after delete on public.car_rentals for each row execute function public.delete_booking_private('car');
create trigger transfers_private_cleanup   after delete on public.transfers   for each row execute function public.delete_booking_private('transfer');

-- ───────────────────────── checklist ─────────────────────────

create table public.checklist_items (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.trips (id) on delete cascade,
  done        boolean not null default false,
  item        text not null,
  note        text,
  date        date,
  type        text check (type in ('Activity', 'Tickets', 'Restaurants', 'Transport', 'Other')),
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- ───────────────────────── map and rates caches ─────────────────────────

-- Pins per trip (the same name can mean different places on different trips, e.g. Copacabana).
create table public.places (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.trips (id) on delete cascade,
  name        text not null,
  search_as   text,
  lat         double precision,
  lng         double precision,
  country     text,
  altitude_m  int,
  found_as    text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (trip_id, name)
);

-- Road routes between two pins, shared by all trips. Only the backend functions read and write these.
create table public.routes (
  from_ll     text not null,      -- '-45.5712,-72.0685'
  to_ll       text not null,
  polyline    text,
  km          int,
  found       boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (from_ll, to_ll)
);

create table public.fx (
  base        text primary key,   -- 'USD'
  as_of       date not null,
  rates       jsonb not null,
  fetched_at  timestamptz not null default now()
);

-- ───────────────────────── indexes ─────────────────────────

create index on public.trips (owner_id);
create index on public.trip_members (user_id);
create index on public.share_links (trip_id);
create index on public.phases (trip_id);
create index on public.days (phase_id);
create index on public.stays (trip_id, check_in_date);
create index on public.flights (trip_id, date);
create index on public.car_rentals (trip_id, pickup_date);
create index on public.transfers (trip_id, date);
create index on public.booking_private (trip_id);
create index on public.checklist_items (trip_id);

-- ───────────────────────── updated_at ─────────────────────────

create trigger touch before update on public.profiles        for each row execute function public.touch_updated_at();
create trigger touch before update on public.trips           for each row execute function public.touch_updated_at();
create trigger touch before update on public.share_links     for each row execute function public.touch_updated_at();
create trigger touch before update on public.phases          for each row execute function public.touch_updated_at();
create trigger touch before update on public.days            for each row execute function public.touch_updated_at();
create trigger touch before update on public.stays           for each row execute function public.touch_updated_at();
create trigger touch before update on public.flights         for each row execute function public.touch_updated_at();
create trigger touch before update on public.car_rentals     for each row execute function public.touch_updated_at();
create trigger touch before update on public.transfers       for each row execute function public.touch_updated_at();
create trigger touch before update on public.booking_private for each row execute function public.touch_updated_at();
create trigger touch before update on public.checklist_items for each row execute function public.touch_updated_at();
create trigger touch before update on public.places          for each row execute function public.touch_updated_at();

-- ───────────────────────── access rules (row-level security) ─────────────────────────
-- Signed-in owners/editors can read and change their trips. Viewers (later) can read.
-- People with only a Carryon link never touch these tables: they go through the feed function,
-- which runs on the server and leaves private fields out. routes and fx have no rules at all,
-- so only the server can use them.

alter table public.profiles        enable row level security;
alter table public.trips           enable row level security;
alter table public.trip_members    enable row level security;
alter table public.share_links     enable row level security;
alter table public.phases          enable row level security;
alter table public.days            enable row level security;
alter table public.stays           enable row level security;
alter table public.flights         enable row level security;
alter table public.car_rentals     enable row level security;
alter table public.transfers       enable row level security;
alter table public.booking_private enable row level security;
alter table public.checklist_items enable row level security;
alter table public.places          enable row level security;
alter table public.routes          enable row level security;
alter table public.fx              enable row level security;

create policy "own profile" on public.profiles
  for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "members read trips" on public.trips
  for select to authenticated using (public.is_trip_member(id) or owner_id = auth.uid());
create policy "create own trips" on public.trips
  for insert to authenticated with check (owner_id = auth.uid());
create policy "editors change trips" on public.trips
  for update to authenticated using (public.is_trip_editor(id)) with check (public.is_trip_editor(id));
create policy "owner deletes trip" on public.trips
  for delete to authenticated using (owner_id = auth.uid());

create policy "members see members" on public.trip_members
  for select to authenticated using (public.is_trip_member(trip_id));

create policy "editors manage share links" on public.share_links
  for all to authenticated using (public.is_trip_editor(trip_id)) with check (public.is_trip_editor(trip_id));
create policy "editors manage private details" on public.booking_private
  for all to authenticated using (public.is_trip_editor(trip_id)) with check (public.is_trip_editor(trip_id));

-- The same pair of rules for every table inside a trip.
do $$
declare t text;
begin
  foreach t in array array['phases', 'days', 'stays', 'flights', 'car_rentals', 'transfers', 'checklist_items', 'places'] loop
    execute format('create policy "members read" on public.%I for select to authenticated using (public.is_trip_member(trip_id))', t);
    execute format('create policy "editors write" on public.%I for insert to authenticated with check (public.is_trip_editor(trip_id))', t);
    execute format('create policy "editors update" on public.%I for update to authenticated using (public.is_trip_editor(trip_id)) with check (public.is_trip_editor(trip_id))', t);
    execute format('create policy "editors delete" on public.%I for delete to authenticated using (public.is_trip_editor(trip_id))', t);
  end loop;
end $$;

-- ───────────────────────── table access for the app ─────────────────────────
-- Signed-in users get table access (the rules above still decide which rows).
-- Signed-out visitors get none.

revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on
  public.profiles, public.trips, public.share_links, public.phases, public.days,
  public.stays, public.flights, public.car_rentals, public.transfers,
  public.booking_private, public.checklist_items, public.places
  to authenticated;
grant select on public.trip_members, public.phase_spans to authenticated;
grant usage on type public.booking_status to authenticated;
revoke all on public.routes, public.fx from anon, authenticated;
revoke execute on function public.is_trip_member(uuid), public.is_trip_editor(uuid) from anon;
