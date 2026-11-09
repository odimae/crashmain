-- CrashAid: one-time database setup for Supabase.
-- Run once in Supabase: SQL Editor > New query > paste all > Run.
-- Safe to run again: every step checks before it creates.

create extension if not exists postgis with schema extensions;
alter database postgres set search_path to public, extensions;
set search_path to public, extensions;

-- ───────── Tables
create table if not exists providers (
  id serial primary key, name text not null, phone text,
  type text not null check (type in ('ambulance','hospital','police','insurer','lawyer','mechanic')),
  location geography(Point,4326)
);

create table if not exists units (
  id serial primary key, provider_id int references providers(id), callsign text unique not null,
  type text not null default 'ambulance',
  status text not null default 'available' check (status in ('available','dispatched','offline')),
  location geography(Point,4326), updated_at timestamptz default now()
);

create table if not exists users (
  id serial primary key, name text not null, email text unique not null, phone text,
  password_hash text not null,
  role text not null default 'victim' check (role in ('victim','dispatcher','admin','ambulance','police','insurer','lawyer','mechanic')),
  unit_id int references units(id), provider_id int references providers(id),
  created_at timestamptz default now()
);

create table if not exists incidents (
  id serial primary key, reporter_id int references users(id), description text default '',
  severity text not null default 'unknown' check (severity in ('minor','serious','critical','unknown')),
  status text not null default 'new' check (status in ('new','dispatched','en_route','on_scene','resolved','cancelled')),
  location geography(Point,4326) not null, assigned_unit_id int references units(id),
  provider_id int references providers(id),
  plate text, ob_number text, ob_filed_at timestamptz, escalated_at timestamptz,
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create table if not exists incident_events (
  id serial primary key, incident_id int not null references incidents(id) on delete cascade,
  actor_id int references users(id), note text not null, created_at timestamptz default now()
);

create table if not exists claims (
  id serial primary key, incident_id int not null references incidents(id) on delete cascade,
  client_id int not null references users(id), provider_id int not null references providers(id),
  status text not null default 'review' check (status in ('review','info','approved')),
  created_at timestamptz default now(), updated_at timestamptz default now()
);

create table if not exists legal_leads (
  id serial primary key, incident_id int not null references incidents(id) on delete cascade,
  client_id int not null references users(id), lawyer_id int references users(id),
  status text not null default 'new' check (status in ('new','accepted')), created_at timestamptz default now()
);

create table if not exists tow_requests (
  id serial primary key, incident_id int not null references incidents(id) on delete cascade,
  client_id int not null references users(id), mechanic_id int references users(id),
  status text not null default 'new' check (status in ('new','accepted','done')),
  eta_minutes int, created_at timestamptz default now()
);

-- Signed-out login tokens (replaces Redis)
create table if not exists revoked_tokens (jti text primary key, expires_at timestamptz not null);

create index if not exists units_loc_idx on units using gist (location);
create index if not exists incidents_loc_idx on incidents using gist (location);
create index if not exists incidents_status_idx on incidents (status);

-- ───────── Starting data (providers and ambulance units). Coordinates are approximate: replace with verified ones.
insert into providers (name, phone, type, location)
select v.name, v.phone, v.type, st_makepoint(v.lng, v.lat)::geography
from (values
  ('AAR Ambulance',     '+254 20 2715318', 'ambulance', 36.8108, -1.2676),
  ('St. John Kenya',    '+254 20 2210000', 'ambulance', 36.8070, -1.2990),
  ('Aga Khan Hospital', '+254 20 3662000', 'hospital',  36.8156, -1.2634),
  ('KPS Westlands',     '999',             'police',    36.8030, -1.2658),
  ('AA Kenya Recovery', '+254 20 3868000', 'mechanic',  36.8200, -1.3020)
) as v(name, phone, type, lng, lat)
where not exists (select 1 from providers p where p.name = v.name);

insert into units (provider_id, callsign, type, location)
select p.id, v.callsign, 'ambulance', st_makepoint(v.lng, v.lat)::geography
from (values
  ('AAR Ambulance',  'AAR-01', 36.8110, -1.2680),
  ('AAR Ambulance',  'AAR-02', 36.7800, -1.2600),
  ('St. John Kenya', 'SJK-01', 36.8075, -1.2985),
  ('St. John Kenya', 'SJK-02', 36.8900, -1.2900)
) as v(pname, callsign, lng, lat)
join providers p on p.name = v.pname
on conflict (callsign) do nothing;

-- ───────── Dispatch (replaces the BullMQ worker): nearest available ambulance, assigned atomically
create or replace function public.dispatch_incident(p_id int) returns boolean
language plpgsql set search_path = public, extensions as $$
declare
  inc record; u record; fallback boolean;
begin
  select i.id, i.status, i.provider_id, p.type as provider_type into inc
    from incidents i left join providers p on p.id = i.provider_id
   where i.id = p_id for update of i;
  if not found or inc.status <> 'new' then return false; end if;
  -- SOS sent to a hospital, police or tow provider: no automatic ambulance, the dispatcher handles it
  if inc.provider_type is not null and inc.provider_type <> 'ambulance' then return false; end if;

  select un.id, un.callsign, un.provider_id into u
    from units un, incidents i
   where i.id = p_id and un.status = 'available' and un.type = 'ambulance' and un.location is not null
   order by (un.provider_id = inc.provider_id) desc nulls last, un.location <-> i.location
   limit 1
   for update of un skip locked;
  if not found then return false; end if;

  update units set status = 'dispatched', updated_at = now() where id = u.id;
  update incidents set status = 'dispatched', assigned_unit_id = u.id, updated_at = now() where id = p_id;
  fallback := inc.provider_id is not null and u.provider_id is distinct from inc.provider_id;
  insert into incident_events (incident_id, note)
  values (p_id, 'Auto-dispatched ' || u.callsign || case when fallback then ' (chosen provider had no free unit)' else '' end);
  return true;
end $$;

-- Retry every minute for incidents still waiting; flag any that waited over 3 minutes so a person notices
create or replace function public.dispatch_pending() returns int
language plpgsql set search_path = public, extensions as $$
declare r record; n int := 0;
begin
  for r in select id, created_at, escalated_at from incidents where status = 'new' order by created_at limit 50 loop
    if public.dispatch_incident(r.id) then
      n := n + 1;
    elsif r.created_at < now() - interval '3 minutes' and r.escalated_at is null then
      update incidents set escalated_at = now() where id = r.id;
      insert into incident_events (incident_id, note)
      values (r.id, 'Still waiting for a unit after 3 minutes. Dispatcher attention needed.');
    end if;
  end loop;
  return n;
end $$;

-- ───────── Security: the API talks to Postgres directly. Supabase's public web API (anon key) must see NOTHING.
alter table providers enable row level security;
alter table units enable row level security;
alter table users enable row level security;
alter table incidents enable row level security;
alter table incident_events enable row level security;
alter table claims enable row level security;
alter table legal_leads enable row level security;
alter table tow_requests enable row level security;
alter table revoked_tokens enable row level security;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- ───────── Minute-by-minute retry. If this block errors, enable pg_cron under Database > Extensions, then run ONLY this block again.
create extension if not exists pg_cron;
do $$ begin
  perform cron.unschedule('crashaid-dispatch') where exists (select 1 from cron.job where jobname = 'crashaid-dispatch');
end $$;
select cron.schedule('crashaid-dispatch', '* * * * *', 'select public.dispatch_pending()');
