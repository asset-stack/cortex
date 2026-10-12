-- Cortex schema, triggers, row-level security, realtime and the empty-start seed.
-- Contract: docs/BACKEND.md section 2. Safe to re-run (SQL editor or `supabase db push`).
-- Every policy also requires an active @assetstackai.com profile (is_staff), so deactivating someone
-- removes all of their access at once. Tested locally with `node scripts/test-db.mjs`.

create extension if not exists pgcrypto with schema extensions;

-- Tables (parent before child). The sync engine never sends updated_at / updated_by. -----------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique,
  name text not null,
  initials text not null,
  color text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

-- Setup only (supabase/setup-admins.sql); not synced and not readable by clients.
create table if not exists public.admin_emails (
  email text primary key,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.org_settings (
  id int primary key default 1 check (id = 1),
  business_name text not null default '',
  abn text not null default '',
  address text not null default '',
  email text not null default '',
  phone text not null default '',
  bank_account_name text not null default '',
  bsb text not null default '',
  account_number text not null default '',
  invoice_prefix text not null default 'INV-',
  payment_terms_days int not null default 30,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.board_groups (
  id uuid primary key default gen_random_uuid(),
  board_key text not null check (board_key in ('projects', 'admin', 'marketing')),
  name text not null default '',
  color text not null default '',
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  board_key text not null,
  group_id uuid not null references public.board_groups (id) on delete cascade,
  position int not null default 0,
  name text not null default '',
  "values" jsonb not null default '{}',
  done boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.item_updates (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items (id) on delete cascade,
  user_id uuid references public.profiles (id),
  text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.subtasks (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items (id) on delete cascade,
  position int not null default 0,
  text text not null default '',
  done boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  group_name text not null default '',
  status text not null default '',
  priority text not null default '',
  next_step text not null default '',
  sector text not null default '',
  contact_id uuid references public.profiles (id),
  team uuid[] not null default '{}',
  last_contact date,
  demo text not null default '',
  key_contact text not null default '',
  email text not null default '',
  demo_url text not null default '',
  avatar text not null default '',
  abn text not null default '',
  billing_address text not null default '',
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  sector text not null default '',
  priority text not null default '',
  stage text not null default '',
  next_step text not null default '',
  value numeric not null default 0,
  owner_id uuid references public.profiles (id),
  client_id uuid references public.clients (id) on delete set null,
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.client_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  user_id uuid references public.profiles (id),
  text text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.client_tasks (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  position int not null default 0,
  text text not null default '',
  done boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  number text not null unique,
  issued date,
  due date,
  status text not null default '',
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

-- qty and rate are kept as typed (e.g. '1,000').
create table if not exists public.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices (id) on delete cascade,
  position int not null default 0,
  description text not null default '',
  qty text not null default '',
  rate text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.client_access (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  position int not null default 0,
  name text not null default '',
  email text not null default '',
  role text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  org text not null default '',
  email text not null default '',
  stage text not null default '',
  status text not null default '',
  last_at timestamptz,
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.emails (
  id uuid primary key default gen_random_uuid(),
  kind text not null default '',
  contact_id uuid references public.contacts (id) on delete set null,
  contact text not null default '',
  subject text not null default '',
  snippet text not null default '',
  ts timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.sequences (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  steps int not null default 0,
  enrolled int not null default 0,
  reply_rate numeric not null default 0,
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.approvals (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts (id) on delete set null,
  contact text not null default '',
  subject text not null default '',
  body text not null default '',
  by_id uuid references public.profiles (id),
  ts timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_by uuid not null default auth.uid(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.channel_members (
  channel_id uuid not null references public.channels (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (channel_id, user_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels (id) on delete cascade,
  user_id uuid references public.profiles (id),
  text text not null default '',
  ts timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.read_state (
  user_id uuid not null references public.profiles (id) on delete cascade,
  channel_id uuid not null references public.channels (id) on delete cascade,
  last_read_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (user_id, channel_id)
);

create index if not exists items_group_id_idx on public.items (group_id);
create index if not exists item_updates_item_id_idx on public.item_updates (item_id);
create index if not exists subtasks_item_id_idx on public.subtasks (item_id);
create index if not exists deals_client_id_idx on public.deals (client_id);
create index if not exists client_notes_client_id_idx on public.client_notes (client_id);
create index if not exists client_tasks_client_id_idx on public.client_tasks (client_id);
create index if not exists invoices_client_id_idx on public.invoices (client_id);
create index if not exists invoice_lines_invoice_id_idx on public.invoice_lines (invoice_id);
create index if not exists client_access_client_id_idx on public.client_access (client_id);
create index if not exists channel_members_user_id_idx on public.channel_members (user_id);
create index if not exists messages_channel_id_ts_idx on public.messages (channel_id, ts);

-- Helpers for the policies. security definer so they read profiles / channel_members without
-- going through those tables' own policies.

create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and active and lower(email) ~ '^[^@]+@assetstackai\.com$'
  );
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() and exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- Also requires is_staff(), so a deactivated account loses its channels too.
create or replace function public.is_member(channel uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_staff() and exists (
    select 1 from public.channel_members where channel_id = channel and user_id = auth.uid()
  );
$$;

-- Triggers ---------------------------------------------------------------------------------

create or replace function public.touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- Signed-in non-admins can only change their own name, initials and colour. Writes with no
-- signed-in user (SQL editor, setup-admins.sql, the sign-up trigger) pass through.
create or replace function public.protect_profile() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    new.role := old.role;
    new.active := old.active;
    new.email := old.email;
  end if;
  return new;
end;
$$;

-- Sign-up gate. Raising here rolls back the auth.users insert, so the sign-in returns with an
-- error instead of creating the account.
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
    case when exists (select 1 from public.admin_emails a where lower(a.email) = v_email) then 'admin' else 'member' end
  )
  on conflict (id) do nothing;

  insert into public.channel_members (channel_id, user_id)
  select c.id, new.id from public.channels c where c.name = 'general'
  on conflict do nothing;

  return new;
end;
$$;

create or replace trigger protect_profile
  before update on public.profiles
  for each row execute function public.protect_profile();

-- RLS, touch(), grants and realtime for every table. Existing policies are dropped first so the
-- create policy statements below can be re-run.
do $$
declare
  synced text[] := array[
    'profiles', 'org_settings', 'board_groups', 'items', 'item_updates', 'subtasks', 'clients', 'deals',
    'client_notes', 'client_tasks', 'invoices', 'invoice_lines', 'client_access', 'contacts', 'emails',
    'sequences', 'approvals', 'channels', 'channel_members', 'messages', 'read_state'];
  t text;
  p record;
begin
  foreach t in array synced || 'admin_emails'::text loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create or replace trigger touch before insert or update on public.%I
      for each row execute function public.touch()', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;

  foreach t in array synced loop
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;

  revoke all on public.admin_emails from anon, authenticated;
end $$;

-- Policies. Postgres checks INSERT policies on every upsert (INSERT ... ON CONFLICT DO UPDATE),
-- even when the row exists, and a conflicting upsert needs an UPDATE policy. The *_upsert
-- policies below exist only so the sync engine's upserts pass; they never allow a new row that
-- the contract forbids. ---------------------------------------------------------------------

-- Business tables: any active staff member can read and write.
do $$
declare t text;
begin
  foreach t in array array[
    'board_groups', 'items', 'subtasks', 'clients', 'deals', 'client_tasks', 'invoices', 'invoice_lines',
    'client_access', 'contacts', 'emails', 'sequences', 'approvals'] loop
    execute format('create policy staff_all on public.%I for all to authenticated
      using (public.is_staff()) with check (public.is_staff())', t);
  end loop;
end $$;

-- Authored rows: everyone reads, only the author (or an admin) edits.
do $$
declare t text;
begin
  foreach t in array array['item_updates', 'client_notes'] loop
    execute format('create policy staff_select on public.%I for select to authenticated
      using (public.is_staff())', t);
    execute format('create policy author_insert on public.%I for insert to authenticated
      with check (user_id = auth.uid() and public.is_staff())', t);
    execute format('create policy author_update on public.%I for update to authenticated
      using ((user_id = auth.uid() and public.is_staff()) or public.is_admin())
      with check ((user_id = auth.uid() and public.is_staff()) or public.is_admin())', t);
    execute format('create policy author_delete on public.%I for delete to authenticated
      using ((user_id = auth.uid() and public.is_staff()) or public.is_admin())', t);
  end loop;
end $$;

-- profiles: rows come from handle_new_user; no insert or delete.
create policy profiles_select on public.profiles for select to authenticated
  using (public.is_staff());
create policy profiles_update on public.profiles for update to authenticated
  using (public.is_admin() or (id = auth.uid() and public.is_staff()))
  with check (public.is_admin() or (id = auth.uid() and public.is_staff()));
-- Upserts only: a staff member's own profile always exists, so this resolves to the update.
create policy profiles_upsert on public.profiles for insert to authenticated
  with check (public.is_admin() or (id = auth.uid() and public.is_staff()));

-- org_settings: the single seeded row; admins edit it.
create policy org_select on public.org_settings for select to authenticated
  using (public.is_staff());
create policy org_update on public.org_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
-- Upserts only: id is pinned to 1 and that row is seeded, so this resolves to the update.
create policy org_upsert on public.org_settings for insert to authenticated
  with check (public.is_admin());

create policy channels_select on public.channels for select to authenticated
  using (public.is_member(id) or (created_by = auth.uid() and public.is_staff()));
create policy channels_insert on public.channels for insert to authenticated
  with check (created_by = auth.uid() and public.is_staff());
create policy channels_update on public.channels for update to authenticated
  using (public.is_admin() or (created_by = auth.uid() and public.is_staff()))
  with check (public.is_admin() or (created_by = auth.uid() and public.is_staff()));
create policy channels_delete on public.channels for delete to authenticated
  using (public.is_admin() or (created_by = auth.uid() and public.is_staff()));

-- The creator clause in select matters too: PostgREST writes use RETURNING, so a new channel's memberships
-- (sent in one upsert, before the creator's own row is visible to is_member) must be readable by the creator.
create policy members_select on public.channel_members for select to authenticated
  using (public.is_staff() and (user_id = auth.uid() or public.is_member(channel_id) or exists (
    select 1 from public.channels c where c.id = channel_id and c.created_by = auth.uid())));
create policy members_insert on public.channel_members for insert to authenticated
  with check (public.is_staff() and (public.is_member(channel_id) or exists (
    select 1 from public.channels c where c.id = channel_id and c.created_by = auth.uid())));
-- No update policy: the sync engine upserts memberships with on conflict do nothing, and an update could move
-- someone else's membership (changing channel_id or user_id) around the delete rule below.
create policy members_delete on public.channel_members for delete to authenticated
  using ((user_id = auth.uid() and public.is_staff()) or public.is_admin());

create policy messages_select on public.messages for select to authenticated
  using (public.is_member(channel_id));
create policy messages_insert on public.messages for insert to authenticated
  with check (user_id = auth.uid() and public.is_member(channel_id));
create policy messages_update on public.messages for update to authenticated
  using (user_id = auth.uid() and public.is_staff())
  with check (user_id = auth.uid() and public.is_member(channel_id));
create policy messages_delete on public.messages for delete to authenticated
  using (user_id = auth.uid() and public.is_staff());

create policy read_state_own on public.read_state for all to authenticated
  using (user_id = auth.uid() and public.is_staff())
  with check (user_id = auth.uid() and public.is_staff());

-- Seed for an empty start -------------------------------------------------------------------

insert into public.org_settings (id) values (1) on conflict (id) do nothing;

insert into public.board_groups (board_key, name, color, position)
select * from (values
  ('projects', 'Active', '#c9ffe6', 0),
  ('projects', 'Backlog', '#e6eaf2', 1),
  ('admin', 'To do', '#ffe6b0', 0),
  ('marketing', 'This month', '#bfe9ff', 0)
) as g (board_key, name, color, position)
where not exists (select 1 from public.board_groups);

-- created_by is the nil uuid ("system"), so only admins can rename or delete #general.
insert into public.channels (name, created_by)
values ('general', '00000000-0000-0000-0000-000000000000')
on conflict (name) do nothing;

-- Last, so the seed above exists before anyone can sign up.
create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
