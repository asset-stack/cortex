-- Cortex 0003: Sydney as the business time zone, per-person time zones, and Projects view-only for staff.
-- Run once in the Supabase SQL editor after 0001 and 0002 (both already applied). Never re-run 0001/0002.
--
-- - Business dates (invoice generation) use Sydney. Personal dates (a follow-up to-do for its owner) use the
--   owner's own time zone, kept up to date by the app from each person's browser.
-- - Staff now view Projects by default instead of editing it. A SuperAdmin can still give a staff member edit
--   access in Settings → Team (module_access overrides win).

begin;

-- 1. Each person's time zone (IANA name, e.g. 'Australia/Sydney', 'Asia/Tbilisi', 'Asia/Manila').
alter table public.profiles add column if not exists timezone text not null default 'Australia/Sydney';

create or replace function public.valid_timezone(p_tz text) returns boolean
language sql stable set search_path = public as $$
  select exists (select 1 from pg_timezone_names where name = p_tz);
$$;

-- A trigger rather than a CHECK constraint: CHECK can't look up pg_timezone_names.
create or replace function public.check_profile_timezone() returns trigger
language plpgsql set search_path = public as $$
begin
  if not public.valid_timezone(new.timezone) then
    raise exception 'Unknown time zone: %', new.timezone using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists check_profile_timezone on public.profiles;
create trigger check_profile_timezone
  before insert or update of timezone on public.profiles
  for each row execute function public.check_profile_timezone();

-- 2. Business day in Sydney; personal day in the person's own time zone (Sydney when unknown).
create or replace function public.team_today() returns date
language sql stable set search_path = public as $$
  select (now() at time zone 'Australia/Sydney')::date;
$$;

create or replace function public.user_today(p_user uuid) returns date
language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce(
    (select p.timezone from public.profiles p where p.id = p_user and public.valid_timezone(p.timezone)),
    'Australia/Sydney'))::date;
$$;

-- Only the automations call it (as the function owner), like next_todo_position.
revoke execute on function public.user_today(uuid) from public, anon, authenticated;

-- 3. Staff default for Projects becomes 'view' (admins always edit; explicit overrides still win).
create or replace function public.module_level(p_module text) returns text
language sql stable security definer set search_path = public as $$
  select case
    when not public.is_staff() then 'none'
    when public.is_admin() then 'edit'
    else coalesce(
      (select level from public.module_access where user_id = auth.uid() and module = p_module),
      case p_module when 'projects' then 'view' when 'marketing' then 'edit' when 'pipeline' then 'view'
        when 'clients' then 'view' else 'none' end)
  end;
$$;

-- 4. Follow-up to-dos land on the owner's own "today" (same as 0002 otherwise).
create or replace function public.contact_pipeline() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_booked boolean := new.status = 'Meeting booked';
  v_name text := coalesce(nullif(btrim(new.name), ''), nullif(btrim(new.org), ''), 'contact');
  v_owner uuid := coalesce(new.owner_id, auth.uid());
  v_day date := public.user_today(coalesce(new.owner_id, auth.uid()));
  v_deal uuid;
  v_stage text;
begin
  if new.status is null or new.status not in ('Replied', 'Meeting booked')
     or (tg_op = 'UPDATE' and new.status is not distinct from old.status) then
    return null;
  end if;

  select id, stage into v_deal, v_stage from public.deals where contact_id = new.id order by position, id limit 1;
  if v_deal is null then
    insert into public.deals (name, stage, owner_id, priority, next_step, contact_id, position)
    values (
      coalesce(nullif(btrim(new.org), ''), new.name),
      case when v_booked then 'First meetings' else 'Opportunities' end,
      v_owner, 'P2',
      case when v_booked then 'Prepare meeting with ' else 'Reply to ' end || v_name,
      new.id,
      (select coalesce(max(position) + 1, 0) from public.deals));
  elsif v_booked and v_stage = 'Opportunities' then
    update public.deals set stage = 'First meetings' where id = v_deal;
  end if;

  if v_owner is not null then
    insert into public.todos (assignee_id, title, day, category, source, ref, position)
    values (
      v_owner,
      case when v_booked then 'Prepare: meeting with ' || v_name else 'Follow up: ' || v_name || ' replied' end,
      v_day, 'Outreach', 'automation', 'contact:' || new.id,
      public.next_todo_position(v_owner, v_day))
    on conflict do nothing;
  end if;

  return null;
end;
$$;

commit;
