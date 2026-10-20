-- Cortex 0007: Outreach monitors the cold email a Claude agent sends from each outreach mailbox. Run in the Supabase SQL
-- editor after 0006, BEFORE the app version that uses it goes live. Safe to re-run, also statement by statement (the
-- SQL editor may run it that way): no statement relies on another having run in the same transaction or session.
-- Contract: docs/PHASE2.md §12.
--
-- - The agent keeps its own Google Sheet (one row per prospect: research, Gmail draft and send, follow-ups, reply,
--   meeting) and fills a `sender` column with the mailbox it sent from. The google Edge Function's outreach-sync route
--   reads the sheet into outreach_emails (with the secret key; the app never writes those rows) and writes a Summary
--   and a Notes tab back into the sheet.
-- - outreach_mailboxes: each mailbox is its own data set; `addresses` lists every address it sends as (an old and a
--   new domain count as one). Admins manage them in Settings → Outreach.
-- - outreach_notes: what the team knows (the current strategy that works), pinned first; mirrored to the sheet.
-- - outreach_settings (one row): the sheet's link, set by an admin, and the last sync's time, error and counts.
-- - Everything is read with Outreach view access (can_view('outreach')); notes are written with edit access.
-- - Outreach and Clients also get team boards, like Marketing (Outreach: Sales Tasks; Clients: Demos, Previews), on
--   0006's boards: they follow the Outreach / Clients access level as every team board follows its module's.

begin;

-- 1. Tables ------------------------------------------------------------------------------------------------------

create table if not exists public.outreach_mailboxes (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  addresses text[] not null default '{}',
  owner_id uuid references public.profiles (id) on delete set null,
  active boolean not null default true,
  position int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.outreach_emails (
  id uuid primary key default gen_random_uuid(),
  row_key text not null unique,
  mailbox_id uuid references public.outreach_mailboxes (id) on delete set null,
  sender text not null default '',
  date_logged date,
  vertical text not null default '',
  organisation text not null default '',
  domain text not null default '',
  location text not null default '',
  contact_name text not null default '',
  contact_role text not null default '',
  contact_email text not null default '',
  tier text not null default '',
  signal text not null default '',
  subject text not null default '',
  variant text not null default '',
  status text not null default '',
  sent_on date,
  message_id text not null default '',
  thread_id text not null default '',
  sequence_status text not null default '',
  followup_stage int not null default 0,
  next_followup date,
  bounced boolean not null default false,
  reply_status text not null default '',
  reply_on date,
  reply_summary text not null default '',
  note text not null default '',
  meeting_on date,
  in_sheet boolean not null default true,
  raw jsonb not null default '{}',
  synced_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create index if not exists outreach_emails_sent_on_idx on public.outreach_emails (sent_on);
create index if not exists outreach_emails_reply_on_idx on public.outreach_emails (reply_on);
create index if not exists outreach_emails_date_logged_idx on public.outreach_emails (date_logged);
create index if not exists outreach_emails_mailbox_id_idx on public.outreach_emails (mailbox_id);

create table if not exists public.outreach_notes (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid references public.outreach_mailboxes (id) on delete cascade,
  pinned boolean not null default false,
  body text not null default '',
  author_id uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

create table if not exists public.outreach_settings (
  id int primary key default 1 check (id = 1),
  sheet_url text not null default '',
  sheet_by uuid references public.profiles (id) on delete set null,
  synced_at timestamptz,
  sync_error text not null default '',
  sync_stats jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

insert into public.outreach_settings (id) values (1) on conflict (id) do nothing;

-- 2. Guards ------------------------------------------------------------------------------------------------------

-- A note's author and date are whoever wrote it, when (the SQL editor, with no signed-in user, may set them).
create or replace function public.protect_outreach_note() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.author_id := auth.uid();
      new.created_at := now();
    else
      new.author_id := old.author_id;
      new.created_at := old.created_at;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_outreach_note on public.outreach_notes;
create trigger protect_outreach_note before insert or update on public.outreach_notes
  for each row execute function public.protect_outreach_note();

-- The app sets only the sheet's link. Whoever saves it (an admin; saving the same link again is how another admin takes
-- it over: Use my Google) is the Google account the sync reads it with, and the last sync's error no longer applies; a
-- new link also hasn't been synced yet. The sync's results are written by the google function (secret key, no
-- signed-in user) and never by the app.
create or replace function public.protect_outreach_settings() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null then
    new.id := old.id;
    new.sheet_by := auth.uid();
    new.sync_error := '';
    if new.sheet_url is distinct from old.sheet_url then
      new.synced_at := null;
      new.sync_stats := '{}';
    else
      new.synced_at := old.synced_at;
      new.sync_stats := old.sync_stats;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_outreach_settings on public.outreach_settings;
create trigger protect_outreach_settings before update on public.outreach_settings
  for each row execute function public.protect_outreach_settings();

-- Two syncs can overlap (two people open Outreach at once). Each stamps the rows it writes with its start time and then
-- flags the rows it didn't write as gone from the sheet, so an older sync must never overwrite a newer one's rows:
-- its write is skipped (the newer sync read the sheet later).
create or replace function public.keep_newer_outreach_sync() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.synced_at < old.synced_at then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists keep_newer_sync on public.outreach_emails;
create trigger keep_newer_sync before update on public.outreach_emails
  for each row execute function public.keep_newer_outreach_sync();

-- 3. Reading: totals for the dashboard (RLS applies: security invoker) --------------------------------------------

-- The sheet has one row per contact; an email sent to two people at one organisation is two rows with one Gmail
-- message. These count emails: rows are grouped by their message (else the row itself) and mailbox, and each email
-- counts once on its first sent day (with whether any of its addresses bounced), its first reply's day (rows with a
-- reply status) and its first meeting's day. Rows no longer in the sheet don't count. Same rules as outreachDaily() /
-- outreachBreakdown() in src/lib/outreach.js and the sheet's Summary tab (the google function).
create or replace function public.outreach_daily(p_from date, p_to date)
returns table (day date, mailbox_id uuid, sent int, replies int, bounces int, meetings int)
language sql stable security invoker set search_path = public as $$
  with m as (
    select e.mailbox_id,
           min(e.sent_on) as sent_on,
           bool_or(e.bounced) as bounced,
           min(e.reply_on) filter (where e.reply_status <> '') as reply_on,
           min(e.meeting_on) as meeting_on
    from public.outreach_emails e
    where e.in_sheet
    group by coalesce(nullif(e.message_id, ''), e.row_key), e.mailbox_id
  )
  select x.day, x.mailbox_id, sum(x.sent)::int, sum(x.replies)::int, sum(x.bounces)::int, sum(x.meetings)::int
  from (
    select m.sent_on as day, m.mailbox_id, 1 as sent, 0 as replies, m.bounced::int as bounces, 0 as meetings
    from m where m.sent_on between p_from and p_to
    union all
    select m.reply_on, m.mailbox_id, 0, 1, 0, 0 from m where m.reply_on between p_from and p_to
    union all
    select m.meeting_on, m.mailbox_id, 0, 0, 0, 1 from m where m.meeting_on between p_from and p_to
  ) x
  group by x.day, x.mailbox_id
  order by x.day, x.mailbox_id;
$$;

-- Contacts logged between p_from and p_to by mailbox and status (draft-saved, sent, skipped-…), and emails first
-- replied to in the period by kind (the first reply's; on the same day, the first kind alphabetically).
create or replace function public.outreach_breakdown(p_from date, p_to date)
returns table (mailbox_id uuid, kind text, value text, n int)
language sql stable security invoker set search_path = public as $$
  with r as (
    select e.mailbox_id,
           min(e.reply_on) as reply_on,
           (array_agg(e.reply_status order by e.reply_on, e.reply_status collate "C"))[1] as reply_status
    from public.outreach_emails e
    where e.in_sheet and e.reply_status <> '' and e.reply_on is not null
    group by coalesce(nullif(e.message_id, ''), e.row_key), e.mailbox_id
  )
  select e.mailbox_id, 'status', e.status, count(*)::int
  from public.outreach_emails e where e.in_sheet and e.date_logged between p_from and p_to
  group by e.mailbox_id, e.status
  union all
  select r.mailbox_id, 'reply', r.reply_status, count(*)::int
  from r where r.reply_on between p_from and p_to
  group by r.mailbox_id, r.reply_status
  order by 1, 2, 3;
$$;

-- Whether the caller may see Outreach (the google function asks before it syncs on someone's behalf).
create or replace function public.outreach_access() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('view', public.can_view('outreach'), 'edit', public.can_edit('outreach'), 'admin', public.is_admin());
$$;

revoke all on function public.outreach_daily(date, date) from public, anon;
revoke all on function public.outreach_breakdown(date, date) from public, anon;
revoke all on function public.outreach_access() from public, anon;
grant execute on function public.outreach_daily(date, date) to authenticated;
grant execute on function public.outreach_breakdown(date, date) to authenticated;
grant execute on function public.outreach_access() to authenticated;

-- 4. RLS, touch(), grants and realtime (as 0002 §7) ---------------------------------------------------------------

alter table public.outreach_mailboxes enable row level security;
alter table public.outreach_emails enable row level security;
alter table public.outreach_notes enable row level security;
alter table public.outreach_settings enable row level security;

create or replace trigger touch before insert or update on public.outreach_mailboxes
  for each row execute function public.touch();
create or replace trigger touch before insert or update on public.outreach_emails
  for each row execute function public.touch();
create or replace trigger touch before insert or update on public.outreach_notes
  for each row execute function public.touch();
create or replace trigger touch before insert or update on public.outreach_settings
  for each row execute function public.touch();

revoke all on public.outreach_mailboxes from anon;
revoke all on public.outreach_emails from anon;
revoke all on public.outreach_notes from anon;
revoke all on public.outreach_settings from anon;
grant select, insert, update, delete on public.outreach_mailboxes to authenticated;
revoke insert, update, delete, truncate on public.outreach_emails from authenticated;
grant select on public.outreach_emails to authenticated;
grant select, insert, update, delete on public.outreach_notes to authenticated;
revoke insert, delete, truncate on public.outreach_settings from authenticated;
grant select, update on public.outreach_settings to authenticated;

do $$
declare t text;
begin
  foreach t in array array['outreach_mailboxes', 'outreach_notes', 'outreach_settings'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 5. Policies ----------------------------------------------------------------------------------------------------

do $$
declare
  t text;
  p record;
begin
  foreach t in array array['outreach_mailboxes', 'outreach_emails', 'outreach_notes', 'outreach_settings'] loop
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- Mailboxes: seen with Outreach; added, changed and removed by admins.
create policy outreach_select on public.outreach_mailboxes for select to authenticated
  using (public.can_view('outreach'));
create policy admin_insert on public.outreach_mailboxes for insert to authenticated
  with check (public.is_admin());
create policy admin_update on public.outreach_mailboxes for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy admin_delete on public.outreach_mailboxes for delete to authenticated
  using (public.is_admin());

-- Emails: read only; the sync writes them with the secret key (which bypasses RLS).
create policy outreach_select on public.outreach_emails for select to authenticated
  using (public.can_view('outreach'));

-- Notes: read with Outreach; written with edit access, as yourself; changed or removed by their author or an admin.
create policy outreach_select on public.outreach_notes for select to authenticated
  using (public.can_view('outreach'));
create policy author_insert on public.outreach_notes for insert to authenticated
  with check (author_id = auth.uid() and public.can_edit('outreach'));
create policy author_update on public.outreach_notes for update to authenticated
  using ((author_id = auth.uid() or public.is_admin()) and public.can_edit('outreach'))
  with check (public.can_edit('outreach'));
create policy author_delete on public.outreach_notes for delete to authenticated
  using ((author_id = auth.uid() or public.is_admin()) and public.can_edit('outreach'));

-- Settings: read with Outreach; the sheet's link is set by admins (the row always exists, so no insert or delete).
create policy outreach_select on public.outreach_settings for select to authenticated
  using (public.can_view('outreach'));
create policy admin_update on public.outreach_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 6. Outreach and Clients boards ---------------------------------------------------------------------------------

-- Team boards under Outreach (Sales Tasks first) and Clients (Demos, Previews), on 0006's boards: its access functions,
-- policies and triggers already work per module (a team board follows its module's level), so only the three checks
-- that list the board modules change. The first time (the boards check doesn't list them yet) the checks widen and
-- each module gets its starting boards with one group, all in this one statement, so a re-run never brings back a
-- starting board someone deleted.
do $$
declare
  v_def text := coalesce((select pg_get_constraintdef(oid) from pg_constraint
                          where conrelid = 'public.boards'::regclass and conname = 'boards_module_check'), '');
begin
  if v_def not like '%outreach%' or v_def not like '%clients%' then
    alter table public.boards drop constraint if exists boards_module_check;
    alter table public.boards add constraint boards_module_check
      check (module in ('projects', 'marketing', 'outreach', 'clients'));
    alter table public.board_groups drop constraint if exists board_groups_board_key_check;
    alter table public.board_groups add constraint board_groups_board_key_check
      check (board_key in ('projects', 'marketing', 'outreach', 'clients'));
    alter table public.items drop constraint if exists items_board_key_check;
    alter table public.items add constraint items_board_key_check
      check (board_key in ('projects', 'marketing', 'outreach', 'clients'));
    with b as (
      insert into public.boards (module, name, position)
      select x.module, x.name, x.position
      from (values ('outreach', 'Sales Tasks', 0), ('clients', 'Demos', 0), ('clients', 'Previews', 1)) as x (module, name, position)
      where v_def not like '%' || x.module || '%'
      returning id, module
    )
    insert into public.board_groups (board_key, board_id, name, color, position)
    select b.module, b.id, 'To do', '#c9ffe6', 0 from b;
  end if;
end $$;

commit;
