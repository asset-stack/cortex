-- Cortex 0014: the CRM: accounts, their contacts, and opportunities with HubSpot-style stages (docs/PHASE2.md §22). Run
-- in the Supabase SQL editor after 0013, BEFORE the app version that uses it goes live (it writes the new deal columns;
-- the app now live keeps working with it). Safe to re-run, also statement by statement (the SQL editor may run it that
-- way): no statement relies on another having run in the same transaction or session.
--
-- - accounts: one row per organisation (a prospect, customer, partner or supplier): sector, country, region and time
--   zone, domain and website, size, its lifecycle (new → contacted → engaged → meeting → opportunity → customer, or
--   nurture with a revisit date, watching for an RFP, not now, suppressed), who referred it, guardrails (what not to say)
--   and a prep pack link. A customer's account links to its Clients record (client_id, at most one account each).
-- - crm_contacts: the people at an account: title, email, phone, LinkedIn, time zone, their role in the deal (decision
--   maker, champion …) and whether they're still there. Deleting an account deletes its contacts.
-- - deals: an account (account_id), the contacts on it (contact_ids), a currency, an expected close date, a probability
--   (null: the stage's default), who it waits on (us / them), a lost reason, and when it reached its stage (stage_at, the
--   database's: set when the stage changes). Stages are now Interested → Meeting booked → Intro held → Demo held →
--   Proposal sent → Contract sent, plus Lost; Won is still Make client. The old ones are renamed once (Opportunities and
--   Contacted → Interested, First meetings → Meeting booked, Demos and Won → Demo held).
-- - The outreach automation (contact_pipeline) also files the contact's organisation as an account and the person as its
--   contact, and uses the new stages.
-- - crm_entries can be on an account or a contact too (Pipeline's rules), never moved by an edit.
-- - Existing data, once: every client gets a customer account; every deal its account (its client's, else the account
--   with its name, else a new one); a deal that came from an outreach contact gets that person as its contact.
-- - Both new tables follow the Pipeline access level (can_view / can_edit('pipeline'), as deals do).

begin;

-- 1. Accounts ------------------------------------------------------------------------------------------------------

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null default '' check (char_length(name) <= 200),
  kind text not null default 'prospect' check (kind in ('prospect', 'customer', 'partner', 'supplier')),
  lifecycle text not null default 'new' check (lifecycle in
    ('new', 'contacted', 'engaged', 'meeting', 'opportunity', 'customer', 'nurture', 'rfp', 'not_now', 'suppressed')),
  lifecycle_note text not null default '' check (char_length(lifecycle_note) <= 500),
  revisit_on date,
  sector text not null default '' check (char_length(sector) <= 100),
  country text not null default '' check (char_length(country) <= 100),
  region text not null default '' check (char_length(region) <= 100),
  timezone text not null default '' check (char_length(timezone) <= 64),
  domain text not null default '' check (char_length(domain) <= 253),
  website text not null default '' check (char_length(website) <= 2000),
  size text not null default '' check (char_length(size) <= 100),
  guardrails text not null default '' check (char_length(guardrails) <= 5000),
  prep_url text not null default '' check (char_length(prep_url) <= 2000),
  referred_by uuid references public.accounts (id) on delete set null,
  owner_id uuid references public.profiles (id) on delete set null,
  client_id uuid references public.clients (id) on delete set null,
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
create unique index if not exists accounts_client_idx on public.accounts (client_id) where client_id is not null;
create index if not exists accounts_name_idx on public.accounts (lower(btrim(name)));

-- 2. Contacts (people at an account) ----------------------------------------------------------------------------------

create table if not exists public.crm_contacts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts (id) on delete cascade,
  name text not null default '' check (char_length(name) <= 200),
  title text not null default '' check (char_length(title) <= 200),
  email text not null default '' check (char_length(email) <= 254),
  phone text not null default '' check (char_length(phone) <= 50),
  linkedin text not null default '' check (char_length(linkedin) <= 2000),
  timezone text not null default '' check (char_length(timezone) <= 64),
  role text not null default '' check (role in
    ('', 'decision_maker', 'champion', 'influencer', 'gatekeeper', 'assistant', 'user', 'other')),
  status text not null default 'active' check (status in ('active', 'left', 'do_not_contact')),
  owner_id uuid references public.profiles (id) on delete set null,
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
create index if not exists crm_contacts_account_idx on public.crm_contacts (account_id);
create index if not exists crm_contacts_email_idx on public.crm_contacts (lower(email));

-- 3. Deals: the account, contacts and the new fields ------------------------------------------------------------------

alter table public.deals add column if not exists account_id uuid references public.accounts (id) on delete set null;
alter table public.deals add column if not exists contact_ids uuid[] not null default '{}';
alter table public.deals add column if not exists currency text not null default 'AUD'
  check (currency in ('AUD', 'NZD', 'GBP', 'USD', 'EUR', 'CAD', 'AED', 'SAR'));
alter table public.deals add column if not exists close_on date;
alter table public.deals add column if not exists probability int check (probability between 0 and 100);
alter table public.deals add column if not exists waiting_on text not null default '' check (waiting_on in ('', 'us', 'them'));
alter table public.deals add column if not exists lost_reason text not null default '' check (char_length(lost_reason) <= 500);
alter table public.deals add column if not exists stage_at timestamptz;
create index if not exists deals_account_idx on public.deals (account_id);

-- Existing deals reached their stage no later than their last change.
update public.deals set stage_at = coalesce(updated_at, now()) where stage_at is null;
alter table public.deals alter column stage_at set default now();
alter table public.deals alter column stage_at set not null;

-- The new stages (once: only the old names match). A Contacted deal was waiting on them. Before the trigger below, so
-- a rename keeps the deal's time in its stage (a re-run after the trigger exists finds nothing to rename).
update public.deals set
  waiting_on = case when stage = 'Contacted' and waiting_on = '' then 'them' else waiting_on end,
  stage = case stage when 'Opportunities' then 'Interested' when 'Contacted' then 'Interested'
                     when 'First meetings' then 'Meeting booked' else 'Demo held' end
where stage in ('Opportunities', 'Contacted', 'First meetings', 'Demos', 'Won');

-- When a deal reached its stage: now, whenever the stage changes; kept otherwise, whatever the writer sends.
create or replace function public.deal_stage_at() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.stage_at := coalesce(new.stage_at, now());
  elsif new.stage is distinct from old.stage then
    new.stage_at := now();
  else
    new.stage_at := old.stage_at;
  end if;
  return new;
end;
$$;

drop trigger if exists deal_stage_at on public.deals;
create trigger deal_stage_at before insert or update on public.deals
  for each row execute function public.deal_stage_at();

-- 4. RLS, touch(), grants and realtime (as 0002 §7) -----------------------------------------------------------------

alter table public.accounts enable row level security;
alter table public.crm_contacts enable row level security;

create or replace trigger touch before insert or update on public.accounts
  for each row execute function public.touch();
create or replace trigger touch before insert or update on public.crm_contacts
  for each row execute function public.touch();

revoke all on public.accounts from anon;
revoke all on public.crm_contacts from anon;
grant select, insert, update, delete on public.accounts to authenticated;
grant select, insert, update, delete on public.crm_contacts to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['accounts', 'crm_contacts'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Pipeline's access level, as deals (0002's module policies).
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['accounts', 'crm_contacts'] loop
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy module_select on public.%I for select to authenticated
      using (public.is_staff() and public.can_view(''pipeline''))', t);
    execute format('create policy module_insert on public.%I for insert to authenticated
      with check (public.is_staff() and public.can_edit(''pipeline''))', t);
    execute format('create policy module_update on public.%I for update to authenticated
      using (public.is_staff() and public.can_edit(''pipeline'')) with check (public.is_staff() and public.can_edit(''pipeline''))', t);
    execute format('create policy module_delete on public.%I for delete to authenticated
      using (public.is_staff() and public.can_edit(''pipeline''))', t);
  end loop;
end $$;

-- 5. Timeline entries on an account or a contact -------------------------------------------------------------------

alter table public.crm_entries add column if not exists account_id uuid references public.accounts (id) on delete cascade;
alter table public.crm_entries add column if not exists contact_id uuid references public.crm_contacts (id) on delete cascade;
create index if not exists crm_entries_account_idx on public.crm_entries (account_id);
create index if not exists crm_entries_contact_idx on public.crm_entries (contact_id);
alter table public.crm_entries drop constraint if exists crm_entries_owner_check;
alter table public.crm_entries add constraint crm_entries_owner_check
  check (deal_id is not null or client_id is not null or account_id is not null or contact_id is not null);

-- As 0012, plus: an entry's account and contact never change either (only deleting them takes the entry with it).
create or replace function public.protect_crm_entry() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.user_id := auth.uid();
      new.created_at := now();
    else
      new.user_id := old.user_id;
      new.created_at := old.created_at;
    end if;
  end if;
  if tg_op = 'INSERT' then
    if exists (select 1 from public.crm_entries e where e.id = new.id) then
      select e.deal_id, e.client_id, e.account_id, e.contact_id into new.deal_id, new.client_id, new.account_id, new.contact_id
      from public.crm_entries e where e.id = new.id;
    elsif new.deal_id is not null then
      new.client_id := (select d.client_id from public.deals d where d.id = new.deal_id);
    end if;
  end if;
  if tg_op = 'UPDATE' then
    if new.deal_id is not null
      or exists (select 1 from public.deals d where d.id = old.deal_id) then
      new.deal_id := old.deal_id;
    end if;
    if new.client_id is distinct from old.client_id and not coalesce(
      old.client_id is null and new.deal_id is not null
      and new.client_id = (select d.client_id from public.deals d where d.id = new.deal_id), false
    ) then
      new.client_id := old.client_id;
    end if;
    new.account_id := old.account_id;
    new.contact_id := old.contact_id;
  end if;
  return new;
end;
$$;

revoke all on function public.protect_crm_entry() from public, anon, authenticated;

-- Read: as 0012, plus an account's or a contact's entries with Pipeline view. Writing follows 0012's policies: a
-- client's entry takes Clients edit, any other Pipeline edit.
drop policy if exists crm_select on public.crm_entries;
create policy crm_select on public.crm_entries for select to authenticated
  using (public.is_staff() and (
    (client_id is not null and public.can_view('clients'))
    or ((deal_id is not null or account_id is not null or contact_id is not null) and public.can_view('pipeline'))));

-- 6. The outreach automation: the account and the person too, and the new stages ------------------------------------

-- As 0008, plus: the contact's organisation is found (by name) or added as an account (a prospect, engaged or meeting),
-- an earlier lifecycle moves on (never back, never over customer, nurture, an RFP, not now or suppressed), and the person
-- is found (by email, else by name) or added as its contact and put on the deal. A reply makes an Interested deal waiting
-- on us; a booking moves Interested on to Meeting booked (never back from later on).
create or replace function public.contact_pipeline() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_booked boolean := new.status = 'Meeting booked';
  v_name text := coalesce(nullif(btrim(new.name), ''), nullif(btrim(new.org), ''), 'contact');
  v_org text := left(coalesce(nullif(btrim(new.org), ''), nullif(btrim(new.name), ''), 'New account'), 200);
  v_email text := left(lower(btrim(coalesce(new.email, ''))), 254);
  v_owner uuid := coalesce(new.owner_id, auth.uid());
  v_day date := public.user_today(coalesce(new.owner_id, auth.uid()));
  v_account uuid;
  v_person uuid;
  v_deal uuid;
  v_stage text;
begin
  if new.status is null or new.status not in ('Replied', 'Meeting booked')
     or (tg_op = 'UPDATE' and new.status is not distinct from old.status) then
    return null;
  end if;

  select id into v_account from public.accounts where lower(btrim(name)) = lower(v_org) order by position, id limit 1;
  if v_account is null then
    insert into public.accounts (name, kind, lifecycle, owner_id, position)
    values (v_org, 'prospect', case when v_booked then 'meeting' else 'engaged' end, v_owner,
            (select coalesce(max(position) + 1, 0) from public.accounts))
    returning id into v_account;
  else
    update public.accounts set lifecycle = case when v_booked then 'meeting' else 'engaged' end
    where id = v_account and (lifecycle in ('new', 'contacted') or (v_booked and lifecycle = 'engaged'));
  end if;

  if btrim(coalesce(new.name, '')) <> '' or v_email <> '' then
    select id into v_person from public.crm_contacts
    where account_id = v_account
      and ((v_email <> '' and lower(email) = v_email)
        or (v_email = '' and lower(btrim(name)) = lower(btrim(coalesce(new.name, '')))))
    order by position, id limit 1;
    if v_person is null then
      insert into public.crm_contacts (account_id, name, email, owner_id, position)
      values (v_account, left(btrim(coalesce(new.name, '')), 200), v_email, v_owner,
              (select coalesce(max(position) + 1, 0) from public.crm_contacts where account_id = v_account))
      returning id into v_person;
    end if;
  end if;

  select id, stage into v_deal, v_stage from public.deals where contact_id = new.id order by position, id limit 1;
  if v_deal is null then
    insert into public.deals (name, stage, owner_id, priority, next_step, contact_id, account_id, contact_ids, waiting_on, position)
    values (
      v_org,
      case when v_booked then 'Meeting booked' else 'Interested' end,
      v_owner, 'P2',
      case when v_booked then 'Prepare meeting with ' else 'Reply to ' end || v_name,
      new.id, v_account, case when v_person is null then '{}'::uuid[] else array[v_person] end, 'us',
      (select coalesce(max(position) + 1, 0) from public.deals));
  elsif v_booked and v_stage in ('Interested', 'Opportunities', 'Contacted') then
    update public.deals set stage = 'Meeting booked' where id = v_deal;
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

-- 7. Existing data (once per row: a re-run finds nothing left to do) ----------------------------------------------

do $$
declare
  c record;
  d record;
  v_account uuid;
  v_person uuid;
  v_next int;
begin
  -- Every client: a customer account (named as the client, its owner the client's).
  select coalesce(max(position) + 1, 0) into v_next from public.accounts;
  for c in select * from public.clients cl
           where not exists (select 1 from public.accounts a where a.client_id = cl.id)
           order by cl.position, cl.id loop
    insert into public.accounts (name, kind, lifecycle, sector, owner_id, client_id, position)
    values (left(coalesce(nullif(btrim(c.name), ''), 'Client'), 200), 'customer', 'customer', left(c.sector, 100),
            c.contact_id, c.id, v_next);
    v_next := v_next + 1;
  end loop;

  -- Every deal: its client's account, else the account with its name, else a new one (an opportunity).
  for d in select * from public.deals where account_id is null order by position, id loop
    v_account := null;
    if d.client_id is not null then
      select id into v_account from public.accounts where client_id = d.client_id;
    end if;
    if v_account is null then
      select id into v_account from public.accounts where lower(btrim(name)) = lower(btrim(d.name)) order by position, id limit 1;
    end if;
    if v_account is null then
      insert into public.accounts (name, kind, lifecycle, sector, owner_id, position)
      values (left(coalesce(nullif(btrim(d.name), ''), 'New account'), 200), 'prospect', 'opportunity', left(d.sector, 100),
              d.owner_id, v_next)
      returning id into v_account;
      v_next := v_next + 1;
    end if;
    update public.deals set account_id = v_account where id = d.id;
  end loop;

  -- A deal from an outreach contact, with no contacts yet: that person, on the deal's account.
  for d in select dl.id, dl.account_id, ct.name, lower(btrim(ct.email)) as email, ct.owner_id
           from public.deals dl join public.contacts ct on ct.id = dl.contact_id
           where dl.account_id is not null and cardinality(dl.contact_ids) = 0
             and (btrim(ct.name) <> '' or btrim(ct.email) <> '') loop
    select id into v_person from public.crm_contacts
    where account_id = d.account_id
      and ((d.email <> '' and lower(email) = d.email) or (d.email = '' and lower(btrim(name)) = lower(btrim(d.name))))
    order by position, id limit 1;
    if v_person is null then
      insert into public.crm_contacts (account_id, name, email, owner_id)
      values (d.account_id, left(btrim(d.name), 200), left(d.email, 254), d.owner_id)
      returning id into v_person;
    end if;
    update public.deals set contact_ids = array[v_person] where id = d.id;
  end loop;
end $$;

commit;

select 'Cortex 0014 applied' as done;
