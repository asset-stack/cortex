-- Cortex 0013: task emails (docs/PHASE2.md §21). Run in the Supabase SQL editor after 0012. Safe to re-run, also
-- statement by statement (the SQL editor may run it that way). The app opens and works without it (Settings → Business
-- shows which file to run); the google function's task-mail route needs it.
--
-- - A task's owner (values.people[0]) gets an email when someone else hands them the task (a new owner that isn't the
--   one saving it, also on a new task) or posts an update on it. Nobody is emailed about their own action, a done task
--   being handed over, Work in Progress rows (the pipeline board's Contact isn't an owner) or rows written with no
--   signed-in user (the SQL editor, imports run there).
-- - private.task_mail is the queue: triggers on items and item_updates add to it in the same transaction as the save.
--   Nothing in the app reads or writes it. The google function's task-mail route (any active teammate's call, after a
--   save, on opening Cortex and every few minutes while it is open) claims what is due (task_mail_claim), sends one email
--   per person from the sender's Gmail, and records the result (task_mail_done). A row is sent once; a failure is tried
--   again later, five times at most.
-- - When it is sent, an email still goes only to an active teammate who is still the task's owner and can still see its
--   board (their own access rules, board_level()), about a task that still exists; otherwise it is dropped unsent.
-- - The sender is one admin's connected Google account (Gmail and Drive, Settings → Business), chosen with Send task
--   emails from my Google (task_mail_use_me) and switched off with Stop (task_mail_off); admins only. No sender: nothing
--   is sent and the queue waits (two days at most).

begin;

-- 1. The sender and the last result --------------------------------------------------------------------------------

create table if not exists private.task_mail_settings (
  id int primary key default 1 check (id = 1),
  sender uuid references public.profiles (id) on delete set null,
  sent_at timestamptz,
  error text not null default '',
  updated_at timestamptz not null default now()
);
insert into private.task_mail_settings (id) values (1) on conflict (id) do nothing;
alter table private.task_mail_settings enable row level security;
revoke all on private.task_mail_settings from public, anon, authenticated;

-- 2. The queue ---------------------------------------------------------------------------------------------------

create table if not exists private.task_mail (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('assigned', 'update')),
  item_id uuid not null references public.items (id) on delete cascade,
  update_id uuid references public.item_updates (id) on delete cascade,
  recipient uuid not null references public.profiles (id) on delete cascade,
  actor uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  attempts int not null default 0,
  sent_at timestamptz,
  error text not null default ''
);
create index if not exists task_mail_due_idx on private.task_mail (id) where sent_at is null;
create unique index if not exists task_mail_update_idx on private.task_mail (update_id) where update_id is not null;
alter table private.task_mail enable row level security;
revoke all on private.task_mail from public, anon, authenticated;

-- A task's owner: the first of values.people when it is a user id (src/lib/work.js ownerOf), else null.
create or replace function private.task_owner(p_values jsonb) returns uuid
language sql immutable set search_path = public as $$
  select case
    when jsonb_typeof(p_values -> 'people') = 'array'
     and coalesce(p_values -> 'people' ->> 0, '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (p_values -> 'people' ->> 0)::uuid
  end;
$$;
revoke all on function private.task_owner(jsonb) from public, anon, authenticated;

-- 3. Queueing (in the save's own transaction) ------------------------------------------------------------------------

-- A task handed to someone else: a new owner that isn't whoever saves it.
create or replace function private.queue_task_assigned() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_new uuid := private.task_owner(new."values");
  v_old uuid := case when tg_op = 'UPDATE' then private.task_owner(old."values") end;
begin
  if auth.uid() is null or new.board_key = 'pipeline' or new.done
     or v_new is null or v_new = auth.uid() or v_new is not distinct from v_old then
    return null;
  end if;
  insert into private.task_mail (kind, item_id, recipient, actor) values ('assigned', new.id, v_new, auth.uid());
  return null;
end;
$$;
revoke all on function private.queue_task_assigned() from public, anon, authenticated;

drop trigger if exists queue_task_assigned on public.items;
create trigger queue_task_assigned after insert or update of "values", done on public.items
  for each row execute function private.queue_task_assigned();

-- An update posted on someone else's task.
create or replace function private.queue_task_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_key text;
begin
  if auth.uid() is null or btrim(coalesce(new.text, '')) = '' then
    return null;
  end if;
  select private.task_owner(i."values"), i.board_key into v_owner, v_key from public.items i where i.id = new.item_id;
  if v_owner is null or v_key = 'pipeline' or v_owner = auth.uid() then
    return null;
  end if;
  insert into private.task_mail (kind, item_id, update_id, recipient, actor)
  values ('update', new.item_id, new.id, v_owner, auth.uid())
  on conflict do nothing;
  return null;
end;
$$;
revoke all on function private.queue_task_update() from public, anon, authenticated;

drop trigger if exists queue_task_update on public.item_updates;
create trigger queue_task_update after insert on public.item_updates
  for each row execute function private.queue_task_update();

-- 4. Sending (the google function, secret key only) ---------------------------------------------------------------

-- The sender's account when it can send: an active admin whose Google connection has Gmail send. → their id, or null.
create or replace function private.task_mail_sender() returns uuid
language sql stable security definer set search_path = public as $$
  select p.id
  from private.task_mail_settings s
  join public.profiles p on p.id = s.sender
  join private.google_accounts g on g.user_id = p.id
  where s.id = 1 and p.active and p.role in ('superadmin', 'admin')
    and regexp_split_to_array(coalesce(g.scopes, ''), '\s+') @> array['https://www.googleapis.com/auth/gmail.send'];
$$;
revoke all on function private.task_mail_sender() from public, anon, authenticated;

-- Claims what is due (at most p_limit rows, none another run claimed in the last 5 minutes) and returns it grouped by
-- person: { sender, mails: [{ ids, to, name, events: [{ kind, at, actor, item, board, board_owner, module, item_id,
-- board_id, values, text }] }] }. Rows that may no longer go (see the top) are closed unsent; rows older than two days
-- that never went, and sent ones after 30 days, are removed. Without a sender nothing is claimed. Each person's access
-- is checked as them (auth.uid() set to them for the check only), so the rules are board_level()'s own.
create or replace function public.task_mail_claim(p_limit int default 100) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_sender uuid := private.task_mail_sender();
  v_sub text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  v_ids bigint[];
  v_drop bigint[] := '{}';
  r record;
begin
  delete from private.task_mail
  where (sent_at is null and created_at < now() - interval '2 days') or sent_at < now() - interval '30 days';
  if v_sender is null then
    return jsonb_build_object('sender', null, 'mails', '[]'::jsonb);
  end if;

  with due as (
    select id from private.task_mail
    where sent_at is null and attempts < 5 and (claimed_at is null or claimed_at < now() - interval '5 minutes')
    order by id limit greatest(coalesce(p_limit, 100), 1)
    for update skip locked
  ), claimed as (
    update private.task_mail m set claimed_at = now(), attempts = m.attempts + 1
    from due where m.id = due.id
    returning m.id
  )
  select coalesce(array_agg(id order by id), '{}') into v_ids from claimed;

  for r in
    select m.id, m.kind, m.recipient, i.id as item_id, i.board_id, i.done, private.task_owner(i."values") as owner,
           p.active
    from private.task_mail m
    left join public.items i on i.id = m.item_id
    left join public.profiles p on p.id = m.recipient
    where m.id = any(v_ids)
  loop
    perform set_config('request.jwt.claim.sub', r.recipient::text, true);
    if r.item_id is null or not coalesce(r.active, false) or r.owner is distinct from r.recipient
       or (r.kind = 'assigned' and r.done) or not public.can_view_board(r.board_id) then
      v_drop := v_drop || r.id;
    end if;
  end loop;
  perform set_config('request.jwt.claim.sub', v_sub, true);

  if cardinality(v_drop) > 0 then
    update private.task_mail set sent_at = now(), error = 'not sent: no longer theirs' where id = any(v_drop);
  end if;

  return jsonb_build_object('sender', v_sender, 'mails', coalesce((
    select jsonb_agg(jsonb_build_object('ids', x.ids, 'to', x.email, 'name', x.name, 'events', x.events) order by x.name)
    from (
      select p.email, p.name, array_agg(m.id order by m.id) as ids,
             jsonb_agg(jsonb_build_object(
               'kind', m.kind, 'at', m.created_at, 'actor', coalesce(a.name, ''), 'item', i.name, 'item_id', i.id,
               'board_id', b.id, 'board', b.name, 'board_owner', coalesce(o.name, ''), 'module', b.module,
               'values', jsonb_build_object('priority', i."values" -> 'priority', 'due', i."values" -> 'due',
                                            'status', i."values" -> 'status'),
               'text', coalesce(u.text, '')) order by m.id) as events
      from private.task_mail m
      join public.profiles p on p.id = m.recipient
      join public.items i on i.id = m.item_id
      join public.boards b on b.id = i.board_id
      left join public.profiles o on o.id = b.owner_id
      left join public.profiles a on a.id = m.actor
      left join public.item_updates u on u.id = m.update_id
      where m.id = any(v_ids) and not (m.id = any(v_drop))
      group by p.id, p.email, p.name
    ) x), '[]'::jsonb));
end;
$$;

-- The run's result for the rows it claimed: sent (p_error '') or failed (tried again later, five times at most).
create or replace function public.task_mail_done(p_ids bigint[], p_error text default '') returns void
language plpgsql security definer set search_path = public as $$
declare
  v_error text := left(btrim(coalesce(p_error, '')), 500);
begin
  if v_error = '' then
    update private.task_mail set sent_at = now(), error = '' where id = any(coalesce(p_ids, '{}')) and sent_at is null;
    update private.task_mail_settings set sent_at = now(), error = '' where id = 1;
  else
    update private.task_mail set claimed_at = null, error = v_error where id = any(coalesce(p_ids, '{}')) and sent_at is null;
    update private.task_mail_settings set error = v_error where id = 1;
  end if;
end;
$$;

-- 5. Settings → Business (admins) ------------------------------------------------------------------------------------

-- { sender_id, sender_name, sender_email (their Google account), ready (it can send), sent_at, error, waiting }.
create or replace function public.task_mail_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  return (
    select jsonb_build_object(
      'sender_id', s.sender, 'sender_name', coalesce(p.name, ''), 'sender_email', coalesce(g.email, ''),
      'ready', s.sender is not null and private.task_mail_sender() = s.sender,
      'sent_at', s.sent_at, 'error', s.error,
      'waiting', (select count(*) from private.task_mail where sent_at is null))
    from private.task_mail_settings s
    left join public.profiles p on p.id = s.sender
    left join private.google_accounts g on g.user_id = s.sender
    where s.id = 1);
end;
$$;

-- Task emails go from the caller's Google account from now on: an admin whose Google connection can send Gmail.
create or replace function public.task_mail_use_me() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from private.google_accounts g where g.user_id = auth.uid()
                 and regexp_split_to_array(coalesce(g.scopes, ''), '\s+') @> array['https://www.googleapis.com/auth/gmail.send']) then
    raise exception 'Connect Google first.' using errcode = 'invalid_parameter_value';
  end if;
  update private.task_mail_settings set sender = auth.uid(), error = '', updated_at = now() where id = 1;
  return true;
end;
$$;

-- No more task emails (what is queued waits, two days at most, for a sender).
create or replace function public.task_mail_off() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  update private.task_mail_settings set sender = null, error = '', updated_at = now() where id = 1;
  return true;
end;
$$;

-- Supabase grants EXECUTE on new functions to everyone; narrow it.
revoke all on function public.task_mail_claim(int) from public, anon, authenticated;
revoke all on function public.task_mail_done(bigint[], text) from public, anon, authenticated;
revoke all on function public.task_mail_status() from public, anon;
revoke all on function public.task_mail_use_me() from public, anon;
revoke all on function public.task_mail_off() from public, anon;
grant execute on function public.task_mail_status() to authenticated;
grant execute on function public.task_mail_use_me() to authenticated;
grant execute on function public.task_mail_off() to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.task_mail_claim(int) to service_role;
    grant execute on function public.task_mail_done(bigint[], text) to service_role;
  end if;
end $$;

commit;

select 'Cortex 0013 applied' as done;
