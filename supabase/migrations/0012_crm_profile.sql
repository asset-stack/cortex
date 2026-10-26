-- Cortex 0012: a CRM profile for deals and clients (docs/PHASE2.md §19). Run in the Supabase SQL editor after 0011,
-- BEFORE the app version that uses it goes live. Safe to re-run, also statement by statement (the SQL editor may run it
-- that way): no statement relies on another having run in the same transaction or session.
--
-- - crm_entries: what the team records against a deal (Pipeline) or a client (Clients): notes, meetings (a date, title,
--   who attended, a link to the meeting notes, e.g. a Google Doc, and a short summary) and labelled links (Meeting
--   notes, Demo, Deck, Proposal, Recording, Other). Synced by the app like any other table.
-- - Who: an entry on a client is the client's (Clients view to read, Clients edit to write); one on a deal that isn't a
--   client yet is Pipeline's. Its author changes and removes their own, admins anyone's. The author and date are whoever
--   added it, when; the deal and client it belongs to don't change, except as below.
-- - Make client: when a deal gets its client (deals.client_id), its entries become that client's too (they keep the
--   deal), so the client's profile carries the deal's history. Deleting a deal deletes the entries that never reached a
--   client; the others stay with their client.
-- - Next steps are board tasks (items.values: client / deal), not rows here.

begin;

-- 1. The table -----------------------------------------------------------------------------------------------------

create table if not exists public.crm_entries (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid references public.deals (id) on delete set null,
  client_id uuid references public.clients (id) on delete cascade,
  kind text not null default 'note' check (kind in ('note', 'meeting', 'link')),
  title text not null default '' check (char_length(title) <= 300),
  body text not null default '' check (char_length(body) <= 20000),
  url text not null default '' check (char_length(url) <= 2000),
  label text not null default '' check (char_length(label) <= 60),
  happened_on date,
  attendees text not null default '' check (char_length(attendees) <= 1000),
  user_id uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  constraint crm_entries_owner_check check (deal_id is not null or client_id is not null)
);

create index if not exists crm_entries_deal_idx on public.crm_entries (deal_id);
create index if not exists crm_entries_client_idx on public.crm_entries (client_id);

-- 2. Guards --------------------------------------------------------------------------------------------------------

-- An entry's author and date are whoever added it, when (the SQL editor and the secret key, with no signed-in user, may
-- set them). Its deal never changes (the database may clear it when the deal is deleted); its client is set only once,
-- to its deal's client (Make client), and never moved or cleared by an edit.
create or replace function public.protect_crm_entry() returns trigger
language plpgsql set search_path = public as $$
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
  if tg_op = 'UPDATE' then
    if new.deal_id is not null then
      new.deal_id := old.deal_id;
    end if;
    if new.client_id is distinct from old.client_id and not coalesce(
      old.client_id is null and new.deal_id is not null
      and new.client_id = (select d.client_id from public.deals d where d.id = new.deal_id), false
    ) then
      new.client_id := old.client_id;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_crm_entry on public.crm_entries;
create trigger protect_crm_entry before insert or update on public.crm_entries
  for each row execute function public.protect_crm_entry();

-- 3. Make client and deleting a deal --------------------------------------------------------------------------------

-- A deal made a client: its entries become the client's (whoever wrote them; RLS would let the converter change only
-- their own, hence security definer).
create or replace function public.crm_carry_to_client() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.client_id is not null and new.client_id is distinct from old.client_id then
    update public.crm_entries set client_id = new.client_id where deal_id = new.id and client_id is null;
  end if;
  return new;
end;
$$;

revoke all on function public.crm_carry_to_client() from public, anon, authenticated;

drop trigger if exists crm_carry_to_client on public.deals;
create trigger crm_carry_to_client after update of client_id on public.deals
  for each row execute function public.crm_carry_to_client();

-- A deal deleted: the entries that never reached a client go with it (the others keep their client; the foreign key
-- clears their deal).
create or replace function public.crm_drop_deal_entries() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.crm_entries where deal_id = old.id and client_id is null;
  return old;
end;
$$;

revoke all on function public.crm_drop_deal_entries() from public, anon, authenticated;

drop trigger if exists crm_drop_deal_entries on public.deals;
create trigger crm_drop_deal_entries before delete on public.deals
  for each row execute function public.crm_drop_deal_entries();

-- 4. RLS, touch(), grants and realtime (as 0002 §7) -----------------------------------------------------------------

alter table public.crm_entries enable row level security;

create or replace trigger touch before insert or update on public.crm_entries
  for each row execute function public.touch();

revoke all on public.crm_entries from anon;
grant select, insert, update, delete on public.crm_entries to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'crm_entries') then
    alter publication supabase_realtime add table public.crm_entries;
  end if;
end $$;

-- 5. Policies ------------------------------------------------------------------------------------------------------

do $$
declare
  p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'crm_entries' loop
    execute format('drop policy %I on public.crm_entries', p.policyname);
  end loop;
end $$;

-- Read: a client's entries with Clients view, a deal's with Pipeline view (a client's entry that came from a deal is
-- both: either will do).
create policy crm_select on public.crm_entries for select to authenticated
  using (public.is_staff() and (
    (client_id is not null and public.can_view('clients')) or (deal_id is not null and public.can_view('pipeline'))));
-- Write: a client's entry with Clients edit; a deal's (not a client yet) with Pipeline edit. Changing and removing:
-- its author, or an admin.
create policy crm_insert on public.crm_entries for insert to authenticated
  with check (public.is_staff() and case when client_id is not null then public.can_edit('clients') else public.can_edit('pipeline') end);
create policy crm_update on public.crm_entries for update to authenticated
  using (public.is_staff() and (user_id = auth.uid() or public.is_admin())
    and case when client_id is not null then public.can_edit('clients') else public.can_edit('pipeline') end)
  with check (public.is_staff() and case when client_id is not null then public.can_edit('clients') else public.can_edit('pipeline') end);
create policy crm_delete on public.crm_entries for delete to authenticated
  using (public.is_staff() and (user_id = auth.uid() or public.is_admin())
    and case when client_id is not null then public.can_edit('clients') else public.can_edit('pipeline') end);

commit;
