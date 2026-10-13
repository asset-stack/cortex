-- Cortex 0004: client contacts, platform links, contracts, credits, and each admin's own Google account (Gmail for
-- invoices, Drive and Docs for contracts). Run once in the Supabase SQL editor after 0001, 0002 and 0003 (all
-- applied), BEFORE the app version that uses it goes live. Safe to re-run.
--
-- - Clients get a platform link and a list of contacts (name, role, email, phone, billing). Each client's old
--   key contact / email becomes its first, billing contact; the old columns stay but are no longer used.
-- - Contracts: one row per generated Google Doc (Draft → Sent for signature → Signed / Cancelled) with the Key
--   Details it was filled from. The org settings hold the contracts folder and the template.
-- - Usage gets credits (imported from each client's platform export); invoices record who they were emailed to.
-- - Admins get an "Approve invoices" to-do while any invoice awaits approval, and a new client in Onboarding gives
--   its (admin) owner a "Prepare contract" to-do.
-- - Each admin connects their own Google account. The refresh tokens live in a private schema that the Data API
--   doesn't expose; only the google Edge Function (with the secret key) reads them.

begin;

-- 1. New columns -------------------------------------------------------------------------------------------------

alter table public.clients add column if not exists platform_url text not null default '';
alter table public.client_usage add column if not exists credits numeric not null default 0;
alter table public.invoices add column if not exists sent_to text not null default '';
alter table public.org_settings add column if not exists contract_template text not null default '';
alter table public.org_settings add column if not exists contract_folder text not null default '';

-- 2. New tables ----------------------------------------------------------------------------------------------------

create table if not exists public.client_contacts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  position int not null default 0,
  name text not null default '',
  role text not null default '',
  email text not null default '',
  phone text not null default '',
  billing boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.client_contracts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  position int not null default 0,
  status text not null default 'Draft'
    check (status in ('Draft', 'Sent for signature', 'Signed', 'Cancelled')),
  title text not null default '',
  doc_id text not null default '',
  doc_url text not null default '',
  start_date date,
  end_date date,
  annual_fee numeric not null default 0,
  payment_terms text not null default '',
  user_limit text not null default '',
  platform text not null default '',
  customisations text not null default '',
  mobile_app text not null default '',
  governing_law text not null default '',
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  sent_by uuid references public.profiles (id) on delete set null,
  sent_at timestamptz,
  signed_at date,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create index if not exists client_contacts_client_id_idx on public.client_contacts (client_id);
create index if not exists client_contracts_client_id_idx on public.client_contracts (client_id);

-- 3. RLS, touch(), grants and realtime (as 0002 §7) ---------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['client_contacts', 'client_contracts'] loop
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

-- 4. Policies: part of the clients module (view to read, edit to write), as 0002 §8 ------------------------------

do $$
declare
  t text;
  p record;
begin
  foreach t in array array['client_contacts', 'client_contracts'] loop
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy module_select on public.%I for select to authenticated
      using (public.can_view(%L))', t, 'clients');
    execute format('create policy module_insert on public.%I for insert to authenticated
      with check (public.can_edit(%L))', t, 'clients');
    execute format('create policy module_update on public.%I for update to authenticated
      using (public.can_edit(%L)) with check (public.can_edit(%L))', t, 'clients', 'clients');
    execute format('create policy module_delete on public.%I for delete to authenticated
      using (public.can_edit(%L))', t, 'clients');
  end loop;
end $$;

-- 5. Each client's key contact / email becomes its first, billing contact (only for clients with no contacts yet,
-- so re-running picks up anything an old browser tab wrote meanwhile without duplicating). ------------------------

insert into public.client_contacts (client_id, position, name, email, billing)
select c.id, 0, btrim(c.key_contact), lower(btrim(c.email)), true
from public.clients c
where (btrim(c.key_contact) <> '' or btrim(c.email) <> '')
  and not exists (select 1 from public.client_contacts x where x.client_id = c.id);

update public.clients set key_contact = '', email = '' where key_contact <> '' or email <> '';

-- 6. ensure_todos: as 0002, plus an "Approve invoices" to-do for admins while any invoice awaits approval. ---------

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

  if public.is_admin() and exists (select 1 from public.invoices where status = 'Awaiting approval') then
    insert into public.todos (assignee_id, title, category, day, source, ref, position)
    values (v_me, 'Approve invoices', 'Clients', p_day, 'automation',
            'approve:' || to_char(p_day, 'YYYY-MM-DD'), public.next_todo_position(v_me, p_day))
    on conflict do nothing;
    get diagnostics v_n = row_count;
    v_added := v_added + v_n;
  end if;

  return v_added;
end;
$$;

-- 7. A new client in Onboarding gives its owner a "Prepare contract" to-do (the owner if they're an admin, else the
-- admin who added it; staff can't make contracts). Imported Active clients don't. --------------------------------

create or replace function public.client_contract_todo() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_day date;
begin
  if new.status is distinct from 'Onboarding' then
    return null;
  end if;
  select p.id into v_owner from public.profiles p
  where p.id in (new.contact_id, auth.uid()) and p.active and p.role in ('superadmin', 'admin')
  order by (p.id = new.contact_id) desc
  limit 1;
  if v_owner is null then
    return null;
  end if;
  v_day := public.user_today(v_owner);
  insert into public.todos (assignee_id, title, category, day, source, ref, position)
  values (v_owner, 'Prepare contract: ' || coalesce(nullif(btrim(new.name), ''), 'new client'), 'Clients', v_day,
          'automation', 'contract:' || new.id, public.next_todo_position(v_owner, v_day))
  on conflict do nothing;
  return null;
end;
$$;

drop trigger if exists client_contract_todo on public.clients;
create trigger client_contract_todo
  after insert on public.clients
  for each row execute function public.client_contract_todo();

-- 8. Each admin's own Google account (Gmail send, Drive and Docs) ---------------------------------------------

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.google_accounts (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  email text not null default '',
  refresh_token text not null default '',
  scopes text not null default '',
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
alter table private.google_accounts enable row level security;
revoke all on private.google_accounts from public, anon, authenticated;
create or replace trigger touch before insert or update on private.google_accounts
  for each row execute function public.touch();

-- Who is calling, and their Google connection (never the token). The google Edge Function uses it, with the caller's
-- own JWT, to find out who is asking; the app uses it for the Settings screen.
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
    'connected_at', v_google.connected_at);
end;
$$;

-- Disconnect your own account (revoking it at Google is myaccount.google.com → Security → Third-party connections).
create or replace function public.google_disconnect() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  delete from private.google_accounts where user_id = auth.uid();
  return found;
end;
$$;

-- For the Edge Function only (secret key): store and read a person's refresh token.
create or replace function public.google_save(p_user uuid, p_email text, p_token text, p_scopes text) returns void
language sql security definer set search_path = public as $$
  insert into private.google_accounts (user_id, email, refresh_token, scopes, connected_at)
  values (p_user, lower(p_email), p_token, coalesce(p_scopes, ''), now())
  on conflict (user_id) do update
    set email = excluded.email, refresh_token = excluded.refresh_token, scopes = excluded.scopes,
        connected_at = excluded.connected_at;
$$;

create or replace function public.google_token(p_user uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('email', g.email, 'refresh_token', g.refresh_token, 'scopes', g.scopes)
  from private.google_accounts g where g.user_id = p_user;
$$;

-- Supabase grants EXECUTE on new functions to everyone; narrow it.
revoke execute on function public.google_me() from public, anon;
revoke execute on function public.google_disconnect() from public, anon;
revoke execute on function public.google_save(uuid, text, text, text) from public, anon, authenticated;
revoke execute on function public.google_token(uuid) from public, anon, authenticated;
grant execute on function public.google_me() to authenticated;
grant execute on function public.google_disconnect() to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.google_save(uuid, text, text, text) to service_role;
    grant execute on function public.google_token(uuid) to service_role;
  end if;
end $$;

commit;
