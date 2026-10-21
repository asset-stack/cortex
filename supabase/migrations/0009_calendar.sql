-- Cortex 0009: the team Calendar (events the team adds, and each person's Google Calendar meetings) and a calendar on
-- boards. Run in the Supabase SQL editor after 0008, BEFORE the app version that uses it goes live. Safe to re-run, also
-- statement by statement (the SQL editor may run it that way): no statement relies on another having run in the same
-- transaction or session, and one-time work is gated on the catalog. Contract: docs/PHASE2.md §15.
--
-- - calendar_events: meetings, events and reminders anyone on the team adds (one day or several; all day, or with a
--   start and end time), with the people they're for. Synced by the app like any other table. Everyone sees them; their
--   author edits and deletes their own, admins anyone's.
-- - private.google_accounts.calendar: whether the person shares their Google Calendar with the team, an explicit
--   opt-in. Someone shares their calendar when this flag is on AND their stored Google scopes read it (calendar.readonly
--   or calendar); that one rule is used everywhere (calendar_claim, calendar_save, calendar_status, google_me and the
--   forgetting). Only the google function's callback for a Calendar connect turns it on (calendar_share, secret key).
--   google_save (0004) never touches it: a new connection starts off, so a plain connect (Settings → Business), whose
--   token may still carry calendar.readonly (connect asks for include_granted_scopes), never starts sharing, while an
--   admin already sharing who reconnects Gmail and Drive keeps sharing. calendar_stop() (Stop sharing) turns it off: an
--   admin's business connection (Gmail and Drive) stays with the flag off; any other (calendar-only) one is removed.
-- - calendar_meetings: each person's Google Calendar meetings, read with their own Google account (calendar.readonly)
--   by the google Edge Function's calendar-sync route with the secret key (calendar_claim / calendar_save). Only times
--   and titles (private ones as busy, no title): never descriptions, locations, attendees or links. The app reads them
--   on demand; they're not in realtime and no signed-in user writes them.
-- - private.calendar_sync: each person's last sync (when, error, reconnect needed, how many meetings) and the claim
--   that keeps two runs from syncing one person at once. calendar_status() shows it to the team, never a token.
-- - google_me() also says whether the caller shares their calendar (calendar) and whether their Google account sends
--   invoices and writes contracts (business).
-- - A person's meetings are forgotten when they stop sharing, disconnect Google, reconnect without the calendar, or are
--   deactivated.
-- - boards.calendar: a team board shows a calendar above its tasks (Marketing → Posting schedule to start). Admins
--   switch it on and off (boards_update, 0006).

begin;

-- 1. Sharing a calendar: the opt-in flag, and which Google scopes read the calendar ------------------------------

-- Off for every existing connection (an admin's business one included) and for every new one; only calendar_share turns
-- it on. google_save (0004) never sets it, so a reconnect keeps it.
alter table private.google_accounts add column if not exists calendar boolean not null default false;

-- True when one whole space-separated entry is a calendar scope (not a substring: '…/calendar.events' doesn't count).
create or replace function private.has_calendar(p_scopes text) returns boolean
language sql immutable set search_path = public as $$
  select regexp_split_to_array(coalesce(p_scopes, ''), '\s+')
    && array['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar'];
$$;

revoke all on function private.has_calendar(text) from public, anon, authenticated;

-- 2. Tables ------------------------------------------------------------------------------------------------------

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'event' check (kind in ('meeting', 'event', 'reminder')),
  title text not null default '' check (char_length(title) <= 200),
  day date not null,
  end_day date,
  starts_at timestamptz,
  ends_at timestamptz,
  people uuid[] not null default '{}',
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  constraint calendar_events_end_day_check check (end_day is null or end_day >= day),
  constraint calendar_events_ends_at_check check (ends_at is null or (starts_at is not null and ends_at >= starts_at))
);

create index if not exists calendar_events_day_idx on public.calendar_events (day);

-- start_date / end_date (inclusive): an all-day meeting's dates; a timed one's are the UTC dates of start_at / end_at.
create table if not exists public.calendar_meetings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  google_id text not null,
  title text not null default '',
  busy boolean not null default false,
  all_day boolean not null default false,
  start_date date not null,
  end_date date not null,
  start_at timestamptz,
  end_at timestamptz,
  synced_at timestamptz not null default now(),
  constraint calendar_meetings_dates_check check (end_date >= start_date),
  constraint calendar_meetings_user_id_google_id_key unique (user_id, google_id)
);

create index if not exists calendar_meetings_start_date_idx on public.calendar_meetings (start_date);
create index if not exists calendar_meetings_end_date_idx on public.calendar_meetings (end_date);

create table if not exists private.calendar_sync (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  claimed_at timestamptz,
  synced_at timestamptz,
  error text not null default '',
  reconnect boolean not null default false,
  events int not null default 0
);

alter table private.calendar_sync enable row level security;
revoke all on private.calendar_sync from public, anon, authenticated;

-- 3. Guards ------------------------------------------------------------------------------------------------------

-- An event's author and date are whoever added it, when (the SQL editor and the secret key, with no signed-in user,
-- may set them).
create or replace function public.protect_calendar_event() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
      new.created_at := now();
    else
      new.created_by := old.created_by;
      new.created_at := old.created_at;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_calendar_event on public.calendar_events;
create trigger protect_calendar_event before insert or update on public.calendar_events
  for each row execute function public.protect_calendar_event();

-- 4. RLS, touch(), grants and realtime (as 0002 §7) ---------------------------------------------------------------

alter table public.calendar_events enable row level security;
alter table public.calendar_meetings enable row level security;

create or replace trigger touch before insert or update on public.calendar_events
  for each row execute function public.touch();

revoke all on public.calendar_events from anon;
revoke all on public.calendar_meetings from anon;
grant select, insert, update, delete on public.calendar_events to authenticated;
revoke insert, update, delete, truncate on public.calendar_meetings from authenticated;
grant select on public.calendar_meetings to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'calendar_events') then
    alter publication supabase_realtime add table public.calendar_events;
  end if;
end $$;

-- 5. Policies ----------------------------------------------------------------------------------------------------

do $$
declare
  t text;
  p record;
begin
  foreach t in array array['calendar_events', 'calendar_meetings'] loop
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- Events: the team sees and adds them; their author changes and removes their own, admins anyone's.
create policy staff_select on public.calendar_events for select to authenticated
  using (public.is_staff());
create policy staff_insert on public.calendar_events for insert to authenticated
  with check (public.is_staff());
create policy author_update on public.calendar_events for update to authenticated
  using ((created_by = auth.uid() and public.is_staff()) or public.is_admin())
  with check (public.is_staff());
create policy author_delete on public.calendar_events for delete to authenticated
  using ((created_by = auth.uid() and public.is_staff()) or public.is_admin());

-- Meetings: read only; the calendar sync writes them with the secret key (calendar_save).
create policy staff_select on public.calendar_meetings for select to authenticated
  using (public.is_staff());

-- 6. The calendar sync (the google function, secret key only) ----------------------------------------------------

-- Claims the people due a sync (active staff who share their calendar, not claimed in the last p_gap seconds, never
-- less than 30) and returns them. Atomic: two runs at once never claim the same person.
create or replace function public.calendar_claim(p_gap int default 600) returns setof uuid
language sql security definer set search_path = public as $$
  insert into private.calendar_sync as s (user_id, claimed_at)
  select p.id, now()
  from public.profiles p
  join private.google_accounts g on g.user_id = p.id
  where p.active and lower(p.email) ~ '^[^@]+@assetstackai\.com$' and g.calendar and private.has_calendar(g.scopes)
  on conflict (user_id) do update set claimed_at = excluded.claimed_at
    where s.claimed_at is null
       or s.claimed_at < now() - make_interval(secs => greatest(coalesce(p_gap, 600), 30))
  returning s.user_id;
$$;

-- Saves one person's sync, started at p_started, of the window p_from … p_to (Sydney dates): their meetings
-- (p_rows: [{google_id, title, busy, all_day, start_date, end_date, start_at, end_at}]) and the run's result. Someone
-- no longer active staff sharing their calendar is forgotten instead (false). The check locks their profile and Google
-- connection (for share) until the save commits: a disconnect, Stop sharing, a reconnect without the calendar or a
-- deactivation arriving meanwhile waits for it, and its forgetting then removes what this run wrote (one that committed
-- first fails the check). An older run never overwrites a newer one's meetings or result; meetings the run didn't see
-- are removed only strictly inside the window (one crossing its edge may simply be outside what was read). A run with
-- an error writes no meetings and removes none.
create or replace function public.calendar_save(p_user uuid, p_started timestamptz, p_from date, p_to date, p_rows jsonb,
  p_error text default '', p_reconnect boolean default false) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_error text := left(coalesce(p_error, ''), 500);
  v_rows jsonb := case when jsonb_typeof(p_rows) = 'array' then p_rows else '[]'::jsonb end;
begin
  if p_user is null or p_started is null then
    raise exception 'calendar_save needs a person and a start time' using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.profiles p join private.google_accounts g on g.user_id = p.id
  where p.id = p_user and p.active and lower(p.email) ~ '^[^@]+@assetstackai\.com$'
    and g.calendar and private.has_calendar(g.scopes)
  for share of p, g;
  if not found then
    delete from public.calendar_meetings where user_id = p_user;
    delete from private.calendar_sync where user_id = p_user;
    return false;
  end if;

  if v_error = '' then
    insert into public.calendar_meetings as m
      (user_id, google_id, title, busy, all_day, start_date, end_date, start_at, end_at, synced_at)
    select distinct on (r.google_id)
           p_user, r.google_id,
           case when coalesce(r.busy, false) then '' else left(btrim(coalesce(r.title, '')), 200) end,
           coalesce(r.busy, false), coalesce(r.all_day, false),
           r.start_date, greatest(coalesce(r.end_date, r.start_date), r.start_date),
           case when coalesce(r.all_day, false) then null else r.start_at end,
           case when coalesce(r.all_day, false) then null else r.end_at end,
           p_started
    from jsonb_to_recordset(v_rows) as r (google_id text, title text, busy boolean, all_day boolean, start_date date,
                                          end_date date, start_at timestamptz, end_at timestamptz)
    where coalesce(r.google_id, '') <> '' and r.start_date is not null
    order by r.google_id
    on conflict (user_id, google_id) do update
      set title = excluded.title, busy = excluded.busy, all_day = excluded.all_day, start_date = excluded.start_date,
          end_date = excluded.end_date, start_at = excluded.start_at, end_at = excluded.end_at, synced_at = excluded.synced_at
      where m.synced_at <= excluded.synced_at;

    delete from public.calendar_meetings
    where user_id = p_user and synced_at < p_started and start_date >= p_from and end_date <= p_to;
  end if;

  insert into private.calendar_sync as s (user_id, synced_at, error, reconnect, events)
  values (p_user, case when v_error = '' then p_started end, v_error, coalesce(p_reconnect, false),
          case when v_error = '' then jsonb_array_length(v_rows) else 0 end)
  on conflict (user_id) do update
    set synced_at = coalesce(excluded.synced_at, s.synced_at),
        error = excluded.error,
        reconnect = excluded.reconnect,
        events = case when excluded.error = '' then excluded.events else s.events end
    where s.synced_at is null or s.synced_at <= p_started;
  return true;
end;
$$;

-- 7. Reading: the team's sync status (never a token or scope) ----------------------------------------------------

-- people: every active profile by name, with whether they share their calendar (connected) and their last sync;
-- earliest: the first day any meeting is kept for; synced_at: the newest sync.
create or replace function public.calendar_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  return jsonb_build_object(
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', p.id,
               'connected', coalesce(g.calendar, false) and private.has_calendar(g.scopes),
               'synced_at', s.synced_at,
               'error', coalesce(s.error, ''),
               'reconnect', coalesce(s.reconnect, false))
             order by p.name, p.id)
      from public.profiles p
      left join private.google_accounts g on g.user_id = p.id
      left join private.calendar_sync s on s.user_id = p.id
      where p.active), '[]'::jsonb),
    'earliest', (select min(start_date) from public.calendar_meetings),
    'synced_at', (select max(synced_at) from private.calendar_sync));
end;
$$;

-- As 0004, plus calendar (the caller shares their calendar) and business (their Google account sends invoices from
-- Gmail and writes contracts in Drive).
create or replace function public.google_me() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_profile public.profiles;
  v_google private.google_accounts;
begin
  if not public.is_staff() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  select * into v_profile from public.profiles where id = auth.uid();
  select * into v_google from private.google_accounts where user_id = auth.uid();
  return jsonb_build_object(
    'uid', v_profile.id,
    'name', v_profile.name,
    'email', v_profile.email,
    'admin', public.is_admin(),
    'google_email', v_google.email,
    'connected_at', v_google.connected_at,
    'calendar', coalesce(v_google.calendar, false) and private.has_calendar(v_google.scopes),
    'business', regexp_split_to_array(coalesce(v_google.scopes, ''), '\s+')
      @> array['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/drive']);
end;
$$;

-- For the google function's callback only (secret key), after google_save for a Calendar connect: the person starts
-- sharing, if the connection just stored reads the calendar. True when it did.
create or replace function public.calendar_share(p_user uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update private.google_accounts set calendar = true where user_id = p_user and private.has_calendar(scopes);
  return found;
end;
$$;

-- Stop sharing your own calendar. An admin's business connection (Gmail and Drive) stays, with the flag off; any
-- other connection only read the calendar and is removed. Either way the forgetting (§8) removes your meetings and
-- sync. True when something changed (false when you weren't sharing and have no calendar-only connection).
create or replace function public.calendar_stop() returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_business boolean;
begin
  if not public.is_staff() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  select regexp_split_to_array(g.scopes, '\s+')
           @> array['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/drive']
    into v_business
  from private.google_accounts g where g.user_id = auth.uid()
  for update;
  if not found then
    return false;
  end if;
  if v_business then
    update private.google_accounts set calendar = false where user_id = auth.uid() and calendar;
  else
    delete from private.google_accounts where user_id = auth.uid();
  end if;
  return found;
end;
$$;

-- Supabase grants EXECUTE on new functions to everyone; narrow it.
revoke all on function public.calendar_claim(int) from public, anon, authenticated;
revoke all on function public.calendar_save(uuid, timestamptz, date, date, jsonb, text, boolean) from public, anon, authenticated;
revoke all on function public.calendar_share(uuid) from public, anon, authenticated;
revoke all on function public.calendar_status() from public, anon;
revoke all on function public.calendar_stop() from public, anon;
revoke all on function public.google_me() from public, anon;
grant execute on function public.calendar_status() to authenticated;
grant execute on function public.calendar_stop() to authenticated;
grant execute on function public.google_me() to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.calendar_claim(int) to service_role;
    grant execute on function public.calendar_save(uuid, timestamptz, date, date, jsonb, text, boolean) to service_role;
    grant execute on function public.calendar_share(uuid) to service_role;
  end if;
end $$;

-- 8. Forgetting a person's meetings ------------------------------------------------------------------------------

-- When their Google account is disconnected, they no longer share their calendar (Stop sharing turned the flag off,
-- or a reconnect stored scopes without the calendar), or they're deactivated.
create or replace function public.calendar_forget() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_user uuid;
begin
  if tg_table_name = 'google_accounts' then
    if tg_op = 'UPDATE' and new.calendar and private.has_calendar(new.scopes) then
      return null;
    end if;
    v_user := old.user_id;
  else
    if new.active then
      return null;
    end if;
    v_user := new.id;
  end if;
  delete from public.calendar_meetings where user_id = v_user;
  delete from private.calendar_sync where user_id = v_user;
  return null;
end;
$$;

drop trigger if exists calendar_forget on private.google_accounts;
create trigger calendar_forget after delete or update of scopes, calendar on private.google_accounts
  for each row execute function public.calendar_forget();
drop trigger if exists calendar_forget on public.profiles;
create trigger calendar_forget after update of active on public.profiles
  for each row when (not new.active) execute function public.calendar_forget();

-- 9. A calendar on boards ----------------------------------------------------------------------------------------

-- The first time (boards has no calendar column yet) the column comes in and Posting schedule shows its calendar, in
-- this one statement, so a re-run never switches it back on after an admin turned it off.
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'boards' and column_name = 'calendar') then
    alter table public.boards add column calendar boolean not null default false;
    update public.boards set calendar = true where module = 'marketing' and owner_id is null and name = 'Posting schedule';
  end if;
end $$;

commit;
