-- Cortex 0017 (docs/PHASE2.md §27): My list, each person's own list at the top of their Dashboard.
-- Run in the Supabase SQL editor BEFORE publishing the release that shows it: the app live now ignores my_list (it only
-- syncs the tables it knows) and copes with sections 5 and 6, while the new app without this file would hide an unticked
-- reminder after its first day. (If it does go the other way round, the new app still opens: it hides My list and tells
-- admins which file to run.) Safe to re-run, also statement by statement (the SQL editor may run it that way).
--
-- - Why (owner, 2026-11-15): the Dashboard should open with a plain list the person types into, not linked to anything:
--   lines added, ticked, edited and deleted, kept until removed (not tied to a day).
-- - Private: only its owner reads or writes a line (admins too only their own). Mirrored in the store's My list actions
--   (src/data/store.jsx) and shown only on your own Dashboard.
-- - Synced (src/data/backend/schema.js, since: '0017_my_list.sql'), so it is in the realtime publication.
-- - Reminders follow the day (section 5): the Dashboard no longer lists undone to-dos from earlier days (Carried over is
--   gone), so ensure_todos moves an undone automation to-do from an earlier day (Approve invoices, the bank screenshot,
--   Prepare contract, a follow-up) to the day it is called for. Otherwise "Approve invoices", made only while no undone
--   one exists, would never be seen again after its first day. Mirrored in ensureTodosLocal (src/lib/automations.js).
-- - contact_pipeline (section 6): a booking's "Prepare: meeting with …" gets its own ref (meeting:<contact>, the follow-up
--   keeps contact:<contact>). One automation to-do per person, ref and day, so a follow-up moved to today (above), or
--   made and ticked earlier that day, used to stop it. Nothing existing is changed or reopened. Mirrored in
--   contactPipelineLocal.

begin;

-- 1. The table -----------------------------------------------------------------------------------------------------

create table if not exists public.my_list (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  text text not null default '' check (char_length(text) <= 500),
  done boolean not null default false,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists my_list_user_idx on public.my_list (user_id, position);

-- 2. What a signed-in request can't change: whose line it is, and when it was made (the SQL editor still can) --------

create or replace function public.protect_my_list() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_my_list on public.my_list;
create trigger protect_my_list before update on public.my_list
  for each row execute function public.protect_my_list();

-- 3. RLS, grants and realtime --------------------------------------------------------------------------------------

alter table public.my_list enable row level security;

revoke all on public.my_list from anon;
grant select, insert, update, delete on public.my_list to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'my_list') then
    alter publication supabase_realtime add table public.my_list;
  end if;
end $$;

-- 4. Policies: your own lines only ----------------------------------------------------------------------------------

do $$
declare
  p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'my_list' loop
    execute format('drop policy %I on public.my_list', p.policyname);
  end loop;
end $$;

create policy my_list_select on public.my_list for select to authenticated
  using (public.is_staff() and user_id = auth.uid());
create policy my_list_insert on public.my_list for insert to authenticated
  with check (public.is_staff() and user_id = auth.uid());
create policy my_list_update on public.my_list for update to authenticated
  using (public.is_staff() and user_id = auth.uid())
  with check (public.is_staff() and user_id = auth.uid());
create policy my_list_delete on public.my_list for delete to authenticated
  using (public.is_staff() and user_id = auth.uid());

-- 5. ensure_todos: as 0004, plus reminders follow the day ---------------------------------------------------------
-- An undone automation to-do from before p_day moves to p_day, after that day's to-dos (next positions, oldest first),
-- keeping its ref (so "Approve invoices" is still one at a time). One per ref (the newest; a contact can have follow-ups
-- on several days, and a person has one to-do per ref and day), none when that ref already has a to-do on p_day or later.
-- Routine and other to-dos stay on their day. Returns the rows added or moved (the app reloads the day's to-dos when it's more
-- than 0).

create or replace function public.ensure_todos(p_day date) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_added int := 0;
  v_n int;
  v_base int;
begin
  if p_day is null or not public.is_staff() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;

  with fresh as (
    insert into public.routine_runs (routine_id, assignee_id, day)
    select r.id, v_me, p_day from public.routines r
    where r.assignee_id = v_me and r.active and extract(isodow from p_day)::int = any (r.weekdays)
    on conflict do nothing
    returning routine_id
  )
  insert into public.todos (assignee_id, title, category, minutes, start_time, day, source, routine_id, position)
  select r.assignee_id, r.title, r.category, r.minutes, r.start_time, p_day, 'routine', r.id,
         public.next_todo_position(v_me, p_day) + (row_number() over (order by r.start_time nulls last, r.position, r.id))::int - 1
  from public.routines r join fresh f on f.routine_id = r.id
  where not exists (select 1 from public.todos t where t.routine_id = r.id and t.assignee_id = v_me and t.day = p_day)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  v_added := v_n;

  if public.is_admin() and extract(isodow from p_day) = 1
     and not exists (select 1 from public.bank_statements where week_start = p_day) then
    insert into public.todos (assignee_id, title, category, day, source, ref, position)
    values (v_me, 'Upload this week''s bank screenshot', 'Admin', p_day, 'automation',
            'bank:' || to_char(p_day, 'YYYY-MM-DD'), public.next_todo_position(v_me, p_day))
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_added := v_added + v_n;
  end if;

  if public.is_admin() and exists (select 1 from public.invoices where status = 'Awaiting approval')
     and not exists (select 1 from public.todos where assignee_id = v_me and source = 'automation'
                     and ref like 'approve:%' and not done) then
    insert into public.todos (assignee_id, title, category, day, source, ref, position)
    values (v_me, 'Approve invoices', 'Clients', p_day, 'automation',
            'approve:' || to_char(p_day, 'YYYY-MM-DD'), public.next_todo_position(v_me, p_day))
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_added := v_added + v_n;
  end if;

  v_base := public.next_todo_position(v_me, p_day);
  with newest as (
    select distinct on (t.ref) t.id, t.day, t.position
    from public.todos t
    where t.assignee_id = v_me and t.source = 'automation' and not t.done and t.day < p_day
      and not exists (select 1 from public.todos o where o.assignee_id = v_me and o.source = 'automation' and o.ref = t.ref
                      and o.day >= p_day)
    order by t.ref, t.day desc, t.position desc, t.id desc
  ), moving as (
    select id, (row_number() over (order by day, position, id))::int as n from newest
  )
  update public.todos t set day = p_day, position = v_base + m.n - 1
  from moving m where t.id = m.id;
  get diagnostics v_n = row_count;
  v_added := v_added + v_n;

  return v_added;
end;
$$;

revoke execute on function public.ensure_todos(date) from public, anon;
grant execute on function public.ensure_todos(date) to authenticated;

-- 6. contact_pipeline: as 0008, but a booking's to-do has its own ref ---------------------------------------------
-- "Follow up: … replied" keeps contact:<id>; "Prepare: meeting with …" is meeting:<id>, so a follow-up already on the day
-- (made and ticked that day, or moved to it by ensure_todos) no longer stops it. Still once per ref and day, and an
-- existing to-do is never changed (a status set back and forth leaves them as they are, ticked or not).

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
  elsif v_booked and v_stage in ('Opportunities', 'Contacted') then
    update public.deals set stage = 'First meetings' where id = v_deal;
  end if;

  if v_owner is not null then
    insert into public.todos (assignee_id, title, day, category, source, ref, position)
    values (
      v_owner,
      case when v_booked then 'Prepare: meeting with ' || v_name else 'Follow up: ' || v_name || ' replied' end,
      v_day, 'Outreach', 'automation', case when v_booked then 'meeting:' else 'contact:' end || new.id,
      public.next_todo_position(v_owner, v_day))
    on conflict do nothing;
  end if;

  return null;
end;
$$;

commit;

select 'Cortex 0017 applied' as done;
