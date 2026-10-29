-- Cortex 0016: the Leads page (docs/PHASE2.md §23). Run in the Supabase SQL editor after 0015. Safe to re-run, also
-- statement by statement (the SQL editor may run it that way). The app opens and works without it (Leads shows which file
-- to run until it has).
--
-- - lead_lists: named lists of prospects (from a CSV export: Apollo, LinkedIn, HubSpot …), each with its leads.
-- - leads: one prospect each (name, title, email, phone, LinkedIn, company and its domain, sector, country, region, time
--   zone, size), its status (new → queued for the outreach agent → contacted → replied / meeting / not interested /
--   bounced, or converted into the CRM), the CRM account and contact it became (set null if they go), an owner and a note.
--   Deleting a list deletes its leads. Leads keep the order they were added in (created_at; no position, so removing
--   one never rewrites the rest).
-- - suppressions: emails and domains never to contact (with why); the app also treats suppressed accounts and contacts
--   marked Do not contact as suppressed.
-- - All three follow the Outreach access level (can_view / can_edit('outreach')): admins, and staff given Outreach.

begin;

create table if not exists public.lead_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null default '' check (char_length(name) <= 200),
  source text not null default 'csv' check (source in ('csv', 'apollo', 'manual')),
  notes text not null default '' check (char_length(notes) <= 2000),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references public.lead_lists (id) on delete cascade,
  name text not null default '' check (char_length(name) <= 200),
  title text not null default '' check (char_length(title) <= 200),
  email text not null default '' check (char_length(email) <= 254),
  phone text not null default '' check (char_length(phone) <= 50),
  linkedin text not null default '' check (char_length(linkedin) <= 2000),
  company text not null default '' check (char_length(company) <= 200),
  domain text not null default '' check (char_length(domain) <= 253),
  sector text not null default '' check (char_length(sector) <= 100),
  country text not null default '' check (char_length(country) <= 100),
  region text not null default '' check (char_length(region) <= 100),
  timezone text not null default '' check (char_length(timezone) <= 64),
  size text not null default '' check (char_length(size) <= 100),
  status text not null default 'new' check (status in
    ('new', 'queued', 'contacted', 'replied', 'meeting', 'not_interested', 'bounced', 'converted')),
  account_id uuid references public.accounts (id) on delete set null,
  person_id uuid references public.crm_contacts (id) on delete set null,
  owner_id uuid references public.profiles (id) on delete set null,
  note text not null default '' check (char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
create index if not exists leads_list_idx on public.leads (list_id);
create index if not exists leads_email_idx on public.leads (lower(email));
create index if not exists leads_domain_idx on public.leads (domain);

create table if not exists public.suppressions (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'email' check (kind in ('email', 'domain')),
  value text not null check (char_length(value) between 1 and 254 and value = lower(btrim(value))),
  reason text not null default '' check (char_length(reason) <= 200),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  unique (kind, value)
);

-- Who added a list or a suppression is whoever did (the SQL editor, with no signed-in user, may set it), and stays.
create or replace function public.protect_created() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  elsif auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
  p record;
begin
  foreach t in array array['lead_lists', 'leads', 'suppressions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create or replace trigger touch before insert or update on public.%I for each row execute function public.touch()', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy module_select on public.%I for select to authenticated
      using (public.is_staff() and public.can_view(''outreach''))', t);
    execute format('create policy module_insert on public.%I for insert to authenticated
      with check (public.is_staff() and public.can_edit(''outreach''))', t);
    execute format('create policy module_update on public.%I for update to authenticated
      using (public.is_staff() and public.can_edit(''outreach'')) with check (public.is_staff() and public.can_edit(''outreach''))', t);
    execute format('create policy module_delete on public.%I for delete to authenticated
      using (public.is_staff() and public.can_edit(''outreach''))', t);
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

drop trigger if exists protect_created on public.lead_lists;
create trigger protect_created before insert or update on public.lead_lists
  for each row execute function public.protect_created();
drop trigger if exists protect_created on public.suppressions;
create trigger protect_created before insert or update on public.suppressions
  for each row execute function public.protect_created();

commit;

select 'Cortex 0016 applied' as done;
