-- Cortex phase 2: roles and module access, My Work (to-dos, routines), the merged Projects board, the
-- outreach → pipeline automation, billing plans, money in, expenses, software costs and timesheets.
-- Contract: docs/PHASE2.md sections 1 and 3. Runs once on top of 0001 (which is already live and may hold
-- rows), in one transaction; it is also safe to re-run. Never re-run 0001 after this one: 0001 would put
-- back the phase 1 roles, policies and functions. Tested locally with `node scripts/test-db.mjs`.

begin;

-- 1. Roles ------------------------------------------------------------------------------------------
-- member becomes staff; superadmin is new. The old check is found by definition, not by name.

do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.profiles'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ '\mrole\M' loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

update public.profiles set role = 'staff' where role = 'member';

alter table public.profiles alter column role set default 'staff';
alter table public.profiles add constraint profiles_role_check check (role in ('superadmin', 'admin', 'staff'));

-- Setup only, as in 0001: the role someone listed here gets when they sign up.
alter table public.admin_emails
  add column if not exists role text not null default 'admin' check (role in ('superadmin', 'admin'));

-- 2. Access helpers -----------------------------------------------------------------------------------

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() and exists (
    select 1 from public.profiles where id = auth.uid() and role in ('superadmin', 'admin')
  );
$$;

create or replace function public.is_superadmin() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() and exists (
    select 1 from public.profiles where id = auth.uid() and role = 'superadmin'
  );
$$;

-- Per-staff overrides of the module defaults (admins always edit, so their rows would be ignored).
create table if not exists public.module_access (
  user_id uuid not null references public.profiles (id) on delete cascade,
  module text not null check (module in ('projects', 'marketing', 'outreach', 'pipeline', 'clients')),
  level text not null check (level in ('none', 'view', 'edit')),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (user_id, module)
);

-- Effective level for the signed-in user: admin role → edit; else the override; else the staff default.
-- Same rules as src/lib/access.js.
create or replace function public.module_level(p_module text) returns text
language sql stable security definer set search_path = public as $$
  select case
    when not public.is_staff() then 'none'
    when public.is_admin() then 'edit'
    else coalesce(
      (select level from public.module_access where user_id = auth.uid() and module = p_module),
      case p_module when 'projects' then 'edit' when 'marketing' then 'edit' when 'pipeline' then 'view'
        when 'clients' then 'view' else 'none' end)
  end;
$$;

create or replace function public.can_view(p_module text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.module_level(p_module) in ('view', 'edit');
$$;

create or replace function public.can_edit(p_module text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.module_level(p_module) = 'edit';
$$;

-- Only a superadmin changes role, active or email (admins still edit anyone's name and colour, staff their
-- own). Writes with no signed-in user (SQL editor, setup-admins.sql) pass through, but nobody can demote or
-- deactivate the last active superadmin.
create or replace function public.protect_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_superadmin() then
    new.role := old.role;
    new.active := old.active;
    new.email := old.email;
  end if;
  if old.role = 'superadmin' and old.active and not (new.role = 'superadmin' and new.active) then
    perform pg_advisory_xact_lock(hashtext('cortex.superadmins'));
    if not exists (select 1 from public.profiles where role = 'superadmin' and active and id <> old.id) then
      raise exception 'Cortex needs at least one active SuperAdmin' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

-- As in 0001, with the role taken from admin_emails (else staff).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  palette text[] := array['#9cd326', '#579bfc', '#a78bfa', '#ff9a3c', '#ff7575', '#21b8b0', '#ff5ac4', '#fdab3d'];
  v_email text := lower(coalesce(new.email, ''));
  v_name text;
  v_words text[];
  v_initials text;
begin
  if v_email !~ '^[^@]+@assetstackai\.com$' then
    raise exception 'Only @assetstackai.com accounts can sign in' using errcode = 'insufficient_privilege';
  end if;

  v_name := coalesce(nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(v_email, '@', 1));
  v_words := regexp_split_to_array(trim(regexp_replace(v_name, '[^[:alnum:]]+', ' ', 'g')), ' ');
  v_initials := upper(case
    when cardinality(v_words) > 1 then left(v_words[1], 1) || left(v_words[cardinality(v_words)], 1)
    else left(v_words[1], 2)
  end);

  insert into public.profiles (id, email, name, initials, color, role)
  values (
    new.id, v_email, v_name, coalesce(nullif(v_initials, ''), '?'),
    palette[(abs(hashtext(v_email)::bigint) % cardinality(palette))::int + 1],
    coalesce((select a.role from public.admin_emails a where lower(a.email) = v_email
              order by a.role = 'superadmin' desc limit 1), 'staff')
  )
  on conflict (id) do nothing;

  insert into public.channel_members (channel_id, user_id)
  select c.id, new.id from public.channels c where c.name = 'general'
  on conflict do nothing;

  return new;
end;
$$;

-- 3. Boards: Admin merges into Projects; owner (one user id) becomes people (user ids) ----------------

do $$
declare v_base int;
begin
  if exists (select 1 from public.board_groups where board_key = 'admin') then
    select coalesce(max(position) + 1, 0) into v_base from public.board_groups where board_key = 'projects';
    update public.board_groups
    set board_key = 'projects', name = case when name = 'To do' then 'Admin' else name end, position = v_base + position
    where board_key = 'admin';
  end if;
end $$;

update public.items set board_key = 'projects' where board_key = 'admin';

do $$
declare c record;
begin
  for c in select conrelid::regclass as tbl, conname from pg_constraint
           where conrelid in ('public.board_groups'::regclass, 'public.items'::regclass) and contype = 'c'
             and pg_get_constraintdef(oid) ~ '\mboard_key\M' loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

alter table public.board_groups add constraint board_groups_board_key_check check (board_key in ('projects', 'marketing'));
alter table public.items add constraint items_board_key_check check (board_key in ('projects', 'marketing'));

-- An item sits on its group's board (the app places items by group), so the boards' RLS on items.board_key covers
-- it: without this, someone who edits Projects could file an item under a Marketing group they only view.
update public.items i set board_key = g.board_key
from public.board_groups g where g.id = i.group_id and i.board_key <> g.board_key;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.board_groups'::regclass
                 and conname = 'board_groups_id_board_key_key') then
    alter table public.board_groups add constraint board_groups_id_board_key_key unique (id, board_key);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.items'::regclass
                 and conname = 'items_group_board_fkey') then
    alter table public.items add constraint items_group_board_fkey foreign key (group_id, board_key)
      references public.board_groups (id, board_key) on update cascade on delete cascade;
  end if;
end $$;

-- An owner that is a user id joins people; anything else (no owner, a stale id) leaves it empty.
with v as (
  select id, case when jsonb_typeof("values") = 'object' then "values" else '{}'::jsonb end as vals
  from public.items
  where "values" ? 'owner' or jsonb_typeof("values" -> 'people') is distinct from 'array'
)
update public.items i
set "values" = (v.vals - 'owner') || jsonb_build_object('people',
  coalesce((
    select jsonb_agg(p order by n)
    from (
      select p, min(n) as n
      from (
        select x.p, x.n from jsonb_array_elements_text(
          case when jsonb_typeof(v.vals -> 'people') = 'array' then v.vals -> 'people' else '[]'::jsonb end
        ) with ordinality as x (p, n)
        union all
        select pr.id::text, 0 from public.profiles pr where pr.id::text = v.vals ->> 'owner'
      ) all_people
      group by p
    ) people
  ), '[]'::jsonb))
from v
where i.id = v.id;

-- 4. New columns on existing tables (billing_plans first: invoices.plan_id refers to it) ----------------

create table if not exists public.billing_plans (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  description text not null default '',
  amount numeric not null default 0,
  frequency text not null default 'monthly' check (frequency in ('monthly', 'quarterly', 'annually')),
  next_date date,
  -- The day of the month it bills on (0: next_date's day). next_date is that day, or the month's last when shorter.
  anchor_day int not null default 0 check (anchor_day between 0 and 31),
  -- Periods already invoiced. Only generate_due_invoices writes it; the app never sends it.
  billed_periods date[] not null default '{}',
  active boolean not null default true,
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

alter table public.contacts add column if not exists owner_id uuid references public.profiles (id) on delete set null;
alter table public.deals add column if not exists contact_id uuid references public.contacts (id) on delete set null;
alter table public.invoices add column if not exists plan_id uuid references public.billing_plans (id) on delete set null;
alter table public.invoices add column if not exists sent_at timestamptz;
alter table public.invoices add column if not exists paid_on date;

-- 5. New tables (parent before child) -------------------------------------------------------------------

create table if not exists public.routines (
  id uuid primary key default gen_random_uuid(),
  title text not null default '',
  category text not null default 'Other',
  minutes int not null default 30,
  assignee_id uuid not null references public.profiles (id) on delete cascade,
  weekdays int[] not null default '{1,2,3,4,5}' check (weekdays <@ '{1,2,3,4,5,6,7}'),
  start_time time,
  active boolean not null default true,
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.todos (
  id uuid primary key default gen_random_uuid(),
  assignee_id uuid not null references public.profiles (id) on delete cascade,
  created_by uuid default auth.uid(),
  title text not null default '',
  notes text not null default '',
  day date not null,
  start_time time,
  minutes int not null default 30,
  category text not null default 'Other',
  source text not null default 'manual' check (source in ('manual', 'routine', 'automation')),
  routine_id uuid references public.routines (id) on delete set null,
  ref text not null default '',
  done boolean not null default false,
  done_at timestamptz,
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

-- Each routine runs once per person and day (ensure_todos), so a routine to-do that was deleted or moved to another
-- day doesn't come back. Only ensure_todos reads and writes it (no policies, not synced).
create table if not exists public.routine_runs (
  routine_id uuid not null references public.routines (id) on delete cascade,
  assignee_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (routine_id, assignee_id, day)
);

create table if not exists public.client_usage (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  month date not null,
  assets int not null default 0,
  sites int not null default 0,
  seats int not null default 0,
  notes text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  unique (client_id, month)
);

create table if not exists public.bank_statements (
  id uuid primary key default gen_random_uuid(),
  week_start date,
  file_path text not null default '',
  note text not null default '',
  uploaded_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid references public.invoices (id) on delete set null,
  client_id uuid not null references public.clients (id) on delete cascade,
  amount numeric not null default 0,
  received_on date,
  reference text not null default '',
  statement_id uuid references public.bank_statements (id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

-- amount includes GST.
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  "date" date,
  vendor text not null default '',
  category text not null default '',
  amount numeric not null default 0,
  gst numeric not null default 0,
  client_id uuid references public.clients (id) on delete set null,
  receipt_path text not null default '',
  notes text not null default '',
  created_by uuid default auth.uid(),
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  vendor text not null default '',
  category text not null default '',
  amount numeric not null default 0,
  cycle text not null default 'monthly' check (cycle in ('monthly', 'annually')),
  renews_on date,
  active boolean not null default true,
  notes text not null default '',
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.time_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  day date not null,
  start_time time,
  minutes int not null default 60,
  category text not null default 'Other',
  note text not null default '',
  source text not null default 'manual' check (source in ('manual', 'suggested')),
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

-- One to-do per routine, person and day, and one automation to-do per person, ref and day: ensure_todos and
-- contact_pipeline insert with on conflict do nothing, so they never duplicate.
create unique index if not exists todos_routine_day_key on public.todos (routine_id, assignee_id, day)
  where routine_id is not null;
create unique index if not exists todos_automation_ref_key on public.todos (assignee_id, ref, day)
  where source = 'automation';
create index if not exists todos_assignee_day_idx on public.todos (assignee_id, day);
create index if not exists routines_assignee_id_idx on public.routines (assignee_id);
create index if not exists billing_plans_client_id_idx on public.billing_plans (client_id);
create index if not exists payments_invoice_id_idx on public.payments (invoice_id);
create index if not exists payments_client_id_idx on public.payments (client_id);
create index if not exists payments_statement_id_idx on public.payments (statement_id);
create index if not exists expenses_client_id_idx on public.expenses (client_id);
create index if not exists time_entries_user_day_idx on public.time_entries (user_id, day);
create index if not exists contacts_owner_id_idx on public.contacts (owner_id);
create index if not exists deals_contact_id_idx on public.deals (contact_id);
create index if not exists invoices_plan_id_idx on public.invoices (plan_id);

-- Routine to-dos made before the run log existed count as runs.
insert into public.routine_runs (routine_id, assignee_id, day)
select distinct routine_id, assignee_id, day from public.todos where routine_id is not null
on conflict do nothing;

-- 6. Triggers -------------------------------------------------------------------------------------------

-- Staff never approve, send, void or mark paid, even with edit access to clients. The insert check runs after the
-- insert, which fires only for rows really inserted: an upsert of an existing invoice (what the sync engine sends)
-- fires the update check instead, so re-saving one is fine and nothing slips between a check and the insert.
create or replace function public.protect_invoice_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.status in ('Approved', 'Sent', 'Paid', 'Void') or new.paid_on is not null then
      raise exception 'Only admins can approve, send, void or mark invoices paid' using errcode = 'insufficient_privilege';
    end if;
  elsif (new.status is distinct from old.status and new.status in ('Approved', 'Sent', 'Paid', 'Void'))
        or new.paid_on is distinct from old.paid_on then
    raise exception 'Only admins can approve, send, void or mark invoices paid' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create or replace trigger protect_invoice_status
  before update on public.invoices
  for each row execute function public.protect_invoice_status();

create or replace trigger protect_invoice_insert
  after insert on public.invoices
  for each row execute function public.protect_invoice_status();

-- created_by is whoever inserted the to-do and never changes, so "delete: creator or admin" can't be gamed.
create or replace function public.protect_todo() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
  else
    new.created_by := old.created_by;
  end if;
  return new;
end;
$$;

create or replace trigger protect_todo
  before insert or update on public.todos
  for each row execute function public.protect_todo();

-- The board an item (and so its updates and subtasks) belongs to, read past the items policies.
create or replace function public.item_board(item uuid) returns text
language sql stable security definer set search_path = public as $$
  select board_key from public.items where id = item;
$$;

-- 7. RLS, touch(), grants and realtime for the new tables -------------------------------------------------

do $$
declare
  synced text[] := array[
    'module_access', 'routines', 'todos', 'billing_plans', 'client_usage', 'bank_statements', 'payments',
    'expenses', 'subscriptions', 'time_entries'];
  t text;
begin
  foreach t in array synced loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create or replace trigger touch before insert or update on public.%I
      for each row execute function public.touch()', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- The routine run log: RLS on with no policies and no grants, like admin_emails; only ensure_todos uses it.
alter table public.routine_runs enable row level security;
create or replace trigger touch before insert or update on public.routine_runs
  for each row execute function public.touch();
revoke all on public.routine_runs from anon, authenticated;

-- 8. Policies. Existing ones on the re-scoped tables are dropped first; see 0001 for why the insert policies
-- also matter for upserts. ------------------------------------------------------------------------------

do $$
declare
  t text;
  p record;
begin
  foreach t in array array[
    'contacts', 'emails', 'sequences', 'approvals', 'deals', 'clients', 'client_notes', 'client_tasks', 'invoices',
    'invoice_lines', 'client_access', 'board_groups', 'items', 'item_updates', 'subtasks', 'module_access', 'routines',
    'todos', 'billing_plans', 'client_usage', 'bank_statements', 'payments', 'expenses', 'subscriptions',
    'time_entries'] loop
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- Module tables: view to read, edit to write.
do $$
declare m record;
begin
  for m in select * from (values
    ('contacts', 'outreach'), ('emails', 'outreach'), ('sequences', 'outreach'), ('approvals', 'outreach'),
    ('deals', 'pipeline'),
    ('clients', 'clients'), ('client_tasks', 'clients'), ('invoices', 'clients'), ('invoice_lines', 'clients'),
    ('client_access', 'clients'), ('billing_plans', 'clients'), ('client_usage', 'clients')
  ) as x (tbl, module) loop
    execute format('create policy module_select on public.%I for select to authenticated
      using (public.can_view(%L))', m.tbl, m.module);
    execute format('create policy module_insert on public.%I for insert to authenticated
      with check (public.can_edit(%L))', m.tbl, m.module);
    execute format('create policy module_update on public.%I for update to authenticated
      using (public.can_edit(%L)) with check (public.can_edit(%L))', m.tbl, m.module, m.module);
    execute format('create policy module_delete on public.%I for delete to authenticated
      using (public.can_edit(%L))', m.tbl, m.module);
  end loop;
end $$;

-- Client notes keep their own-row rules inside the clients module.
create policy module_select on public.client_notes for select to authenticated
  using (public.can_view('clients'));
create policy author_insert on public.client_notes for insert to authenticated
  with check (user_id = auth.uid() and public.can_edit('clients'));
create policy author_update on public.client_notes for update to authenticated
  using ((user_id = auth.uid() or public.is_admin()) and public.can_edit('clients'))
  with check ((user_id = auth.uid() or public.is_admin()) and public.can_edit('clients'));
create policy author_delete on public.client_notes for delete to authenticated
  using ((user_id = auth.uid() or public.is_admin()) and public.can_edit('clients'));

-- Boards: each board is its own module (projects, marketing).
do $$
declare t text;
begin
  foreach t in array array['board_groups', 'items'] loop
    execute format('create policy board_select on public.%I for select to authenticated
      using (public.can_view(board_key))', t);
    execute format('create policy board_insert on public.%I for insert to authenticated
      with check (public.can_edit(board_key))', t);
    execute format('create policy board_update on public.%I for update to authenticated
      using (public.can_edit(board_key)) with check (public.can_edit(board_key))', t);
    execute format('create policy board_delete on public.%I for delete to authenticated
      using (public.can_edit(board_key))', t);
  end loop;
end $$;

create policy board_select on public.subtasks for select to authenticated
  using (public.can_view(public.item_board(item_id)));
create policy board_insert on public.subtasks for insert to authenticated
  with check (public.can_edit(public.item_board(item_id)));
create policy board_update on public.subtasks for update to authenticated
  using (public.can_edit(public.item_board(item_id))) with check (public.can_edit(public.item_board(item_id)));
create policy board_delete on public.subtasks for delete to authenticated
  using (public.can_edit(public.item_board(item_id)));

create policy board_select on public.item_updates for select to authenticated
  using (public.can_view(public.item_board(item_id)));
create policy author_insert on public.item_updates for insert to authenticated
  with check (user_id = auth.uid() and public.can_edit(public.item_board(item_id)));
create policy author_update on public.item_updates for update to authenticated
  using ((user_id = auth.uid() or public.is_admin()) and public.can_edit(public.item_board(item_id)))
  with check ((user_id = auth.uid() or public.is_admin()) and public.can_edit(public.item_board(item_id)));
create policy author_delete on public.item_updates for delete to authenticated
  using ((user_id = auth.uid() or public.is_admin()) and public.can_edit(public.item_board(item_id)));

-- module_access: staff read their own overrides, admins read all, only the superadmin changes them.
create policy access_select on public.module_access for select to authenticated
  using ((user_id = auth.uid() and public.is_staff()) or public.is_admin());
create policy access_insert on public.module_access for insert to authenticated
  with check (public.is_superadmin());
create policy access_update on public.module_access for update to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());
create policy access_delete on public.module_access for delete to authenticated
  using (public.is_superadmin());

-- todos: your own list; admins see and add to everyone's.
create policy todos_select on public.todos for select to authenticated
  using ((assignee_id = auth.uid() and public.is_staff()) or public.is_admin());
create policy todos_insert on public.todos for insert to authenticated
  with check ((assignee_id = auth.uid() and public.is_staff()) or public.is_admin());
create policy todos_update on public.todos for update to authenticated
  using ((assignee_id = auth.uid() and public.is_staff()) or public.is_admin())
  with check ((assignee_id = auth.uid() and public.is_staff()) or public.is_admin());
create policy todos_delete on public.todos for delete to authenticated
  using ((created_by = auth.uid() and public.is_staff()) or public.is_admin());

create policy routines_select on public.routines for select to authenticated
  using (public.is_staff());
create policy routines_insert on public.routines for insert to authenticated
  with check (public.is_admin());
create policy routines_update on public.routines for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy routines_delete on public.routines for delete to authenticated
  using (public.is_admin());

-- Money in, expenses and software costs: admins only.
do $$
declare t text;
begin
  foreach t in array array['bank_statements', 'payments', 'expenses', 'subscriptions'] loop
    execute format('create policy admin_all on public.%I for all to authenticated
      using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- time_entries: everyone writes only their own; admins read everyone's.
create policy time_select on public.time_entries for select to authenticated
  using ((user_id = auth.uid() and public.is_staff()) or public.is_admin());
create policy time_insert on public.time_entries for insert to authenticated
  with check (user_id = auth.uid() and public.is_staff());
create policy time_update on public.time_entries for update to authenticated
  using (user_id = auth.uid() and public.is_staff()) with check (user_id = auth.uid() and public.is_staff());
create policy time_delete on public.time_entries for delete to authenticated
  using (user_id = auth.uid() and public.is_staff());

-- 9. RPCs ---------------------------------------------------------------------------------------------

-- The team's calendar day for automations (the app uses each person's local day). Database sessions run in UTC,
-- which is still yesterday on Australian mornings.
create or replace function public.team_today() returns date
language sql stable set search_path = public as $$
  select (now() at time zone 'Australia/Perth')::date;
$$;

-- Next to-do position in someone's day (positions count within each person's day, as in schema.js).
create or replace function public.next_todo_position(p_assignee uuid, p_day date) returns int
language sql stable security definer set search_path = public as $$
  select coalesce(max(position) + 1, 0) from public.todos where assignee_id = p_assignee and day = p_day;
$$;

-- The caller's routine to-dos for p_day, plus (admins, Mondays) the bank screenshot reminder until that week's
-- statement is uploaded. Each routine runs once per person and day (routine_runs), so a to-do deleted or moved to
-- another day doesn't come back. Safe to call any number of times; returns the rows it added.
create or replace function public.ensure_todos(p_day date) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_added int := 0;
  v_n int;
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

  return v_added;
end;
$$;

-- Invoices for every active plan that is due (on the team's day), catching up missed periods: each is Awaiting
-- approval, numbered after the highest number with the org prefix (from 1001), issued on its period date. Periods
-- fall on the plan's billing day (anchor_day, else next_date's day), or the month's last day when it is shorter, so a
-- plan on the 31st is back on the 31st after a short month; next_date moves on by whole periods until it is in the
-- future. A period already invoiced (billed_periods) is skipped: a slow client's save can put back the next_date this
-- just moved on. A plan more than two years behind (a mistyped year) is left as it is rather than billed hundreds of
-- times.
create or replace function public.generate_due_invoices() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_today date := public.team_today();
  v_prefix text;
  v_terms int;
  v_next numeric;
  v_plan record;
  v_months int;
  v_day int;
  v_k int;
  v_month date;
  v_date date;
  v_billed date[];
  v_position int;
  v_invoice uuid;
  v_added int := 0;
begin
  if not public.is_admin() then
    raise exception 'Only admins can generate invoices' using errcode = 'insufficient_privilege';
  end if;

  -- One run at a time, and no other invoice can take a number meanwhile.
  lock table public.invoices in share row exclusive mode;

  select invoice_prefix, payment_terms_days into v_prefix, v_terms from public.org_settings where id = 1;
  v_prefix := coalesce(v_prefix, 'INV-');
  v_terms := coalesce(v_terms, 30);
  select greatest(coalesce(max(substr(number, length(v_prefix) + 1)::numeric) + 1, 1001), 1001) into v_next
  from public.invoices
  where left(number, length(v_prefix)) = v_prefix and substr(number, length(v_prefix) + 1) ~ '^[0-9]+$';

  for v_plan in
    select * from public.billing_plans
    where active and next_date is not null and next_date <= v_today
      and next_date >= (v_today - interval '2 years')::date
    order by next_date, position, id
    for update
  loop
    v_months := case v_plan.frequency when 'quarterly' then 3 when 'annually' then 12 else 1 end;
    v_day := case when v_plan.anchor_day between 1 and 31 then v_plan.anchor_day else extract(day from v_plan.next_date)::int end;
    v_billed := v_plan.billed_periods;
    select coalesce(max(position) + 1, 0) into v_position from public.invoices where client_id = v_plan.client_id;
    v_k := 0;
    v_date := v_plan.next_date;
    while v_date <= v_today loop
      if not v_date = any (v_billed) then
        insert into public.invoices (client_id, number, issued, due, status, plan_id, position)
        values (v_plan.client_id, v_prefix || v_next::text, v_date, v_date + v_terms, 'Awaiting approval', v_plan.id, v_position)
        returning id into v_invoice;
        insert into public.invoice_lines (invoice_id, position, description, qty, rate)
        values (v_invoice, 0, v_plan.description, '1', trim_scale(v_plan.amount)::text);
        v_billed := v_billed || v_date;
        v_added := v_added + 1;
        v_next := v_next + 1;
        v_position := v_position + 1;
      end if;
      v_k := v_k + 1;
      v_month := (date_trunc('month', v_plan.next_date) + make_interval(months => v_k * v_months))::date;
      v_date := make_date(extract(year from v_month)::int, extract(month from v_month)::int,
                          least(v_day, extract(day from v_month + interval '1 month - 1 day')::int));
    end loop;
    update public.billing_plans set next_date = v_date, anchor_day = v_day, billed_periods = v_billed where id = v_plan.id;
  end loop;

  return v_added;
end;
$$;

revoke execute on function public.next_todo_position(uuid, date) from public, anon, authenticated;
revoke execute on function public.ensure_todos(date) from public, anon;
revoke execute on function public.generate_due_invoices() from public, anon;
grant execute on function public.ensure_todos(date) to authenticated;
grant execute on function public.generate_due_invoices() to authenticated;

-- 10. Outreach → pipeline ---------------------------------------------------------------------------------
-- A contact that becomes Replied or Meeting booked gets a deal (or its deal moves on to First meetings) and
-- its owner a follow-up to-do for today (the team's day). security definer: staff who can edit outreach but only
-- view the pipeline still get their deal.
create or replace function public.contact_pipeline() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_booked boolean := new.status = 'Meeting booked';
  v_name text := coalesce(nullif(btrim(new.name), ''), nullif(btrim(new.org), ''), 'contact');
  v_owner uuid := coalesce(new.owner_id, auth.uid());
  v_day date := public.team_today();
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

create or replace trigger contact_pipeline
  after insert or update of status on public.contacts
  for each row execute function public.contact_pipeline();

-- 11. Storage: private `finance` bucket for bank screenshots (statements/<uuid>-<file>) and receipts
-- (receipts/<uuid>-<file>), admins only. Skipped where there is no storage schema (local test databases).

do $$
declare
  t text;
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    return;
  end if;

  insert into storage.buckets (id, name, public) values ('finance', 'finance', false) on conflict (id) do nothing;

  foreach t in array array['select', 'insert', 'update', 'delete'] loop
    execute format('drop policy if exists %I on storage.objects', 'cortex_finance_' || t);
  end loop;
  create policy cortex_finance_select on storage.objects for select to authenticated
    using (bucket_id = 'finance' and public.is_admin());
  create policy cortex_finance_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'finance' and public.is_admin());
  create policy cortex_finance_update on storage.objects for update to authenticated
    using (bucket_id = 'finance' and public.is_admin()) with check (bucket_id = 'finance' and public.is_admin());
  create policy cortex_finance_delete on storage.objects for delete to authenticated
    using (bucket_id = 'finance' and public.is_admin());
end $$;

commit;
