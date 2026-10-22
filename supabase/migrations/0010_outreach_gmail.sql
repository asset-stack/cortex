-- Cortex 0010: Outreach reads cold sales email straight from each outreach mailbox's Gmail (the agent's Google Sheet
-- stays as a reference log). Run in the Supabase SQL editor after 0009, BEFORE the app version that uses it goes live.
-- Safe to re-run, also statement by statement (the SQL editor may run it that way): no statement relies on another
-- having run in the same transaction or session. Contract: docs/PHASE2.md §16.
--
-- - private.outreach_gmail: each mailbox's Gmail connection (gmail.readonly), made by an admin signing in to that
--   mailbox's Google account in Settings → Outreach. The google Edge Function's callback stores it
--   (outreach_gmail_connect, secret key) only when the Google account is one of the mailbox's addresses. `client` names
--   the Google OAuth client it was made with ('default': the @assetstackai.com Workspace), so another Workspace's client
--   can be added later. The refresh token never leaves the private schema except to the function (outreach_gmail_job).
-- - private.outreach_gmail_sync: each connected mailbox's read of Gmail: the claim that keeps two runs apart, the run that
--   holds it, Gmail's history cursor, the threads still to read (and, for those Gmail answered with a server error, how
--   many times, counted at most once every 10 minutes), the last result, and when the first full read finished.
-- - outreach_threads: the COLD threads (we wrote first, to a new outside contact; the function decides, once) with only
--   their headers' facts: who, our first subject, when, how many of ours, and the first reply, auto-reply and bounce.
--   Never a body, snippet or reply subject. outreach_messages: each of our emails and each answer in them (sent, reply,
--   auto, bounce), for the daily numbers. Read with Outreach view (can_view('outreach')); written only by the sync
--   (outreach_gmail_save, secret key); not in realtime and not synced by the app. reply_kind is for sorting replies
--   later; nothing writes it yet. Days are Sydney days, worked out here.
-- - outreach_gmail_daily / _breakdown / _threads: the dashboard's numbers and the threads list (security invoker, so
--   RLS applies), the same rules as gmailDaily / gmailBreakdown / filterThreads in src/lib/outreach.js. The list brings
--   along the sheet's row for the thread (by thread id, else the prospect's address).
-- - outreach_gmail_status: each mailbox's connection, sync and active flag, never a token or scope.
--   outreach_gmail_disconnect: admins.
-- - A mailbox's Gmail data is forgotten when its connection goes (disconnect), moves to another Google account or
--   client, loses the Gmail scope, or its address is taken off the mailbox; removing the mailbox removes it all. A run
--   that claimed the mailbox before then saves nothing. A mailbox made inactive keeps its history and its sync (still
--   ready; it's just no longer read).

begin;

-- 1. Which scopes read Gmail ---------------------------------------------------------------------------------------

-- True when one whole space-separated entry is gmail.readonly (not a substring or a look-alike).
create or replace function private.has_gmail_read(p_scopes text) returns boolean
language sql immutable set search_path = public as $$
  select 'https://www.googleapis.com/auth/gmail.readonly' = any (regexp_split_to_array(coalesce(p_scopes, ''), '\s+'));
$$;

revoke all on function private.has_gmail_read(text) from public, anon, authenticated;

-- 2. Tables ------------------------------------------------------------------------------------------------------

create table if not exists private.outreach_gmail (
  mailbox_id uuid primary key references public.outreach_mailboxes (id) on delete cascade,
  client text not null default 'default' check (client ~ '^[a-z][a-z0-9_]{0,19}$'),
  email text not null,
  refresh_token text not null,
  scopes text not null default '',
  connected_by uuid references public.profiles (id) on delete set null,
  connected_at timestamptz not null default now()
);

alter table private.outreach_gmail enable row level security;
revoke all on private.outreach_gmail from public, anon, authenticated;

create table if not exists private.outreach_gmail_sync (
  mailbox_id uuid primary key references public.outreach_mailboxes (id) on delete cascade,
  claimed_at timestamptz,
  run_started timestamptz,
  synced_at timestamptz,
  ready_at timestamptz,
  history_id text not null default '',
  scan_from timestamptz,
  pending text[] not null default '{}',
  error text not null default '',
  reconnect boolean not null default false,
  failures jsonb not null default '{}'::jsonb
);

-- failures: queued thread id → { n, at }: how many times Gmail answered it with a server error, counted at most once every
-- 10 minutes, and when last counted (the function drops it at five).
-- Added here too for a database that ran an earlier draft of this file without it.
alter table private.outreach_gmail_sync add column if not exists failures jsonb not null default '{}'::jsonb;

alter table private.outreach_gmail_sync enable row level security;
revoke all on private.outreach_gmail_sync from public, anon, authenticated;

create table if not exists public.outreach_threads (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid not null references public.outreach_mailboxes (id) on delete cascade,
  thread_id text not null,
  sender text not null default '',
  prospect_email text not null default '',
  prospect_name text not null default '' check (char_length(prospect_name) <= 100),
  recipients int not null default 1,
  subject text not null default '' check (char_length(subject) <= 200),
  first_at timestamptz not null,
  first_day date not null,
  last_sent_at timestamptz,
  sent_count int not null default 1,
  reply_at timestamptz,
  reply_day date,
  reply_message_id text not null default '',
  auto_at timestamptz,
  auto_day date,
  bounce_at timestamptz,
  bounce_day date,
  reply_kind text not null default '',
  synced_at timestamptz not null default now(),
  constraint outreach_threads_mailbox_id_thread_id_key unique (mailbox_id, thread_id)
);

create index if not exists outreach_threads_first_day_idx on public.outreach_threads (first_day);
create index if not exists outreach_threads_reply_day_idx on public.outreach_threads (reply_day);
create index if not exists outreach_threads_bounce_day_idx on public.outreach_threads (bounce_day);
create index if not exists outreach_threads_mailbox_id_idx on public.outreach_threads (mailbox_id);

create table if not exists public.outreach_messages (
  mailbox_id uuid not null,
  message_id text not null,
  thread_id text not null,
  kind text not null check (kind in ('sent', 'reply', 'auto', 'bounce')),
  at timestamptz not null,
  day date not null,
  synced_at timestamptz not null default now(),
  constraint outreach_messages_pkey primary key (mailbox_id, message_id),
  constraint outreach_messages_thread_fkey foreign key (mailbox_id, thread_id)
    references public.outreach_threads (mailbox_id, thread_id) on delete cascade
);

create index if not exists outreach_messages_day_idx on public.outreach_messages (day);
-- Removing a thread removes its messages (the foreign key's cascade looks them up by mailbox and thread).
create index if not exists outreach_messages_thread_idx on public.outreach_messages (mailbox_id, thread_id);

-- The threads list finds the sheet's row for a thread by its Gmail thread id, else the prospect's address.
create index if not exists outreach_emails_contact_email_lower_idx on public.outreach_emails (lower(contact_email));
create index if not exists outreach_emails_thread_id_idx on public.outreach_emails (thread_id);

-- 3. RLS and grants: read with Outreach view; written only by the sync (secret key); not in realtime ---------------

alter table public.outreach_threads enable row level security;
alter table public.outreach_messages enable row level security;

revoke all on public.outreach_threads from anon, authenticated;
revoke all on public.outreach_messages from anon, authenticated;
grant select on public.outreach_threads to authenticated;
grant select on public.outreach_messages to authenticated;

do $$
declare
  t text;
  p record;
begin
  foreach t in array array['outreach_threads', 'outreach_messages'] loop
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

create policy outreach_select on public.outreach_threads for select to authenticated
  using (public.can_view('outreach'));
create policy outreach_select on public.outreach_messages for select to authenticated
  using (public.can_view('outreach'));

-- 4. Connecting a mailbox's Gmail (the google function's callback, secret key) -------------------------------------

-- Stores the connection when the mailbox exists and is active, p_by is an active admin, and the Google account signed in
-- is one of the mailbox's addresses (any case). The mailbox row stays locked until it commits, so an address change or
-- removal arriving meanwhile waits and then applies its own rule. Reconnecting as the same account keeps what was read
-- (and clears the last error); another account forgets it (§8). → 'ok' | 'no_mailbox' | 'not_admin' | 'wrong_account'
create or replace function public.outreach_gmail_connect(p_mailbox uuid, p_email text, p_token text, p_scopes text, p_by uuid,
  p_client text default 'default') returns text
language plpgsql security definer set search_path = public as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_addresses text[];
begin
  if coalesce(p_token, '') = '' then
    raise exception 'outreach_gmail_connect needs a refresh token' using errcode = 'invalid_parameter_value';
  end if;
  select array(select lower(btrim(a)) from unnest(m.addresses) a where a is not null) into v_addresses
  from public.outreach_mailboxes m where m.id = p_mailbox and m.active
  for update of m;
  if not found then
    return 'no_mailbox';
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_by and p.active and p.role in ('superadmin', 'admin')
                 and lower(p.email) ~ '^[^@]+@assetstackai\.com$') then
    return 'not_admin';
  end if;
  if v_email = '' or not (v_email = any (v_addresses)) then
    return 'wrong_account';
  end if;
  insert into private.outreach_gmail as g (mailbox_id, client, email, refresh_token, scopes, connected_by, connected_at)
  values (p_mailbox, coalesce(nullif(btrim(p_client), ''), 'default'), v_email, p_token, coalesce(p_scopes, ''), p_by, now())
  on conflict (mailbox_id) do update
    set client = excluded.client, email = excluded.email, refresh_token = excluded.refresh_token, scopes = excluded.scopes,
        connected_by = excluded.connected_by, connected_at = excluded.connected_at;
  update private.outreach_gmail_sync set error = '', reconnect = false where mailbox_id = p_mailbox;
  return 'ok';
end;
$$;

-- 5. The sync (the google function's outreach-gmail-sync route, secret key only) ----------------------------------

-- Who counts as known, so a thread to them is never cold: internal domains (ours, every mailbox address's and every
-- profile's), and the addresses and organisation domains of the people we already deal with (the team, client contacts
-- and access, invoice recipients). Free-mail domains never count as an organisation. Outreach prospects
-- (public.contacts) are deliberately not read: a thread to one of them is still a cold email.
create or replace function public.outreach_gmail_known() returns jsonb
language sql stable security definer set search_path = public as $$
  with internal as (
    select distinct d from (
      select unnest(array['assetstackai.com', 'assetstack.org', 'assetstackai.com.au']) as d
      union all
      select substring(lower(btrim(a)) from '@([^@]+)$') from public.outreach_mailboxes m, unnest(m.addresses) a
      union all
      select substring(lower(btrim(p.email)) from '@([^@]+)$') from public.profiles p
    ) x where coalesce(d, '') <> ''
  ),
  client_side as (
    select lower(btrim(x.e, ' <>"''')) as e from (
      select c.email as e from public.client_contacts c
      union all select c.email from public.clients c
      union all select a.email from public.client_access a
      union all select regexp_split_to_table(i.sent_to, '[\s,;]+') from public.invoices i
    ) x
  ),
  emails as (
    select distinct e from (
      select lower(btrim(p.email)) as e from public.profiles p
      union all select e from client_side
    ) x where position('@' in coalesce(e, '')) > 0
  ),
  domains as (
    select distinct substring(e from '@([^@]+)$') as d from client_side where position('@' in coalesce(e, '')) > 0
  )
  select jsonb_build_object(
    'internal', coalesce((select jsonb_agg(d order by d collate "C") from internal), '[]'::jsonb),
    'emails', coalesce((select jsonb_agg(e order by e collate "C") from emails), '[]'::jsonb),
    'domains', coalesce((select jsonb_agg(d order by d collate "C") from domains
      where coalesce(d, '') <> '' and d not in (select d from internal)
        and d not in ('gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com',
                      'yahoo.com.au', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'bigpond.com',
                      'bigpond.net.au', 'optusnet.com.au', 'tpg.com.au', 'iinet.net.au')), '[]'::jsonb));
$$;

-- Claims up to p_limit active mailboxes with a Gmail read connection that weren't claimed in the last p_gap seconds
-- (never less than 30): released or never claimed ones first (a first read carrying on), then the least recently
-- synced, and returns them. Atomic: two runs at once never claim one mailbox.
-- The run that claims it is the one that holds it (run_started): an older run's later saves change nothing.
create or replace function public.outreach_gmail_claim(p_gap int default 600, p_limit int default 3) returns setof uuid
language sql security definer set search_path = public as $$
  insert into private.outreach_gmail_sync as s (mailbox_id, claimed_at, run_started)
  select m.id, now(), now()
  from public.outreach_mailboxes m
  join private.outreach_gmail g on g.mailbox_id = m.id
  left join private.outreach_gmail_sync x on x.mailbox_id = m.id
  where m.active and private.has_gmail_read(g.scopes)
    and (x.claimed_at is null or x.claimed_at < now() - make_interval(secs => greatest(coalesce(p_gap, 600), 30)))
  order by x.claimed_at is not null, x.synced_at nulls first, m.position, m.id
  limit greatest(coalesce(p_limit, 3), 0)
  on conflict (mailbox_id) do update set claimed_at = excluded.claimed_at, run_started = excluded.run_started
    where s.claimed_at is null or s.claimed_at < now() - make_interval(secs => greatest(coalesce(p_gap, 600), 30))
  returning s.mailbox_id;
$$;

-- One claimed mailbox's job: its connection (with the token, for the function only), its addresses, where the last read
-- got to (failures: {} when none), and run_started (the claim's time: pass it back as outreach_gmail_save's p_started).
-- Null with no connection.
create or replace function public.outreach_gmail_job(p_mailbox uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'email', g.email,
    'refresh_token', g.refresh_token,
    'scopes', g.scopes,
    'client', g.client,
    'addresses', coalesce((select jsonb_agg(distinct lower(btrim(a))) from unnest(m.addresses) a where btrim(coalesce(a, '')) <> ''),
                          '[]'::jsonb),
    'history_id', coalesce(s.history_id, ''),
    'scan_from', s.scan_from,
    'pending', to_jsonb(coalesce(s.pending, '{}'::text[])),
    'failures', coalesce(s.failures, '{}'::jsonb),
    'synced_at', s.synced_at,
    'ready', s.ready_at is not null,
    'run_started', s.run_started)
  from private.outreach_gmail g
  join public.outreach_mailboxes m on m.id = g.mailbox_id
  left join private.outreach_gmail_sync s on s.mailbox_id = g.mailbox_id
  where g.mailbox_id = p_mailbox;
$$;

-- Saves part of one mailbox's run, started at p_started: its cold threads (p_threads: [{thread_id, sender,
-- prospect_email, prospect_name, recipients, subject, first_at, last_sent_at, sent_count, reply_at, reply_message_id,
-- auto_at, bounce_at}]), their messages (p_messages: [{message_id, thread_id, kind, at}]) and where the read got to
-- (p_cursor: {history_id, scan_from, pending, failures}; a key left out or null keeps what's stored, as does a pending
-- that isn't a list or failures that isn't an object). Days are Sydney's.
-- A mailbox no longer active, or no longer connected with the read scope, gets no save (false): the claim is released
-- and its sync row (ready, cursor, queue) and threads stay; a connection that went or lost the scope was forgotten then
-- (§8), sync row and all. The check locks the mailbox and the connection (for share) until the save commits, so a
-- disconnect or account change arriving meanwhile waits and then forgets what this run wrote. No sync row means the
-- claim went with a forgotten connection (every claim makes one; the forgetting removes it): a run from before a
-- disconnect, reconnect or account change gets no save either (false), so nothing of it (threads, cursor, ready, error)
-- lands on the new connection. A newer run having claimed the mailbox, nothing changes (true). An older save never
-- overwrites a newer one's rows. A run with an error writes no threads or messages and keeps the cursor and the last
-- good sync's time. p_release frees the claim (the client may then start the next run). Nothing is ever pruned.
create or replace function public.outreach_gmail_save(p_mailbox uuid, p_started timestamptz, p_threads jsonb, p_messages jsonb,
  p_cursor jsonb, p_release boolean default false, p_error text default '', p_reconnect boolean default false) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_error text := left(coalesce(p_error, ''), 500);
  v_threads jsonb := case when jsonb_typeof(p_threads) = 'array' then p_threads else '[]'::jsonb end;
  v_messages jsonb := case when jsonb_typeof(p_messages) = 'array' then p_messages else '[]'::jsonb end;
  v_cursor jsonb := case when jsonb_typeof(p_cursor) = 'object' then p_cursor else '{}'::jsonb end;
  v_failures jsonb := case when jsonb_typeof(v_cursor -> 'failures') = 'object' then v_cursor -> 'failures' end;
  v_pending text[];
  v_run timestamptz;
begin
  if p_mailbox is null or p_started is null then
    raise exception 'outreach_gmail_save needs a mailbox and a start time' using errcode = 'invalid_parameter_value';
  end if;

  perform 1 from public.outreach_mailboxes m join private.outreach_gmail g on g.mailbox_id = m.id
  where m.id = p_mailbox and m.active and private.has_gmail_read(g.scopes)
  for share of m, g;
  if not found then
    update private.outreach_gmail_sync set claimed_at = null where mailbox_id = p_mailbox;
    return false;
  end if;

  select s.run_started into v_run from private.outreach_gmail_sync s where s.mailbox_id = p_mailbox for update;
  if not found then
    return false;
  end if;
  if v_run is not null and v_run > p_started then
    return true;
  end if;

  if v_error = '' then
    insert into public.outreach_threads as t (mailbox_id, thread_id, sender, prospect_email, prospect_name, recipients, subject,
      first_at, first_day, last_sent_at, sent_count, reply_at, reply_day, reply_message_id, auto_at, auto_day, bounce_at,
      bounce_day, synced_at)
    select distinct on (r.thread_id)
           p_mailbox, r.thread_id, btrim(coalesce(r.sender, '')), lower(btrim(coalesce(r.prospect_email, ''))),
           left(btrim(coalesce(r.prospect_name, '')), 100), greatest(coalesce(r.recipients, 1), 1),
           left(btrim(coalesce(r.subject, '')), 200),
           r.first_at, (r.first_at at time zone 'Australia/Sydney')::date, r.last_sent_at, greatest(coalesce(r.sent_count, 1), 1),
           r.reply_at, (r.reply_at at time zone 'Australia/Sydney')::date, coalesce(r.reply_message_id, ''),
           r.auto_at, (r.auto_at at time zone 'Australia/Sydney')::date,
           r.bounce_at, (r.bounce_at at time zone 'Australia/Sydney')::date,
           p_started
    from jsonb_to_recordset(v_threads) as r (thread_id text, sender text, prospect_email text, prospect_name text, recipients int,
      subject text, first_at timestamptz, last_sent_at timestamptz, sent_count int, reply_at timestamptz, reply_message_id text,
      auto_at timestamptz, bounce_at timestamptz)
    where coalesce(r.thread_id, '') <> '' and r.first_at is not null
    order by r.thread_id
    on conflict (mailbox_id, thread_id) do update
      set sender = excluded.sender, prospect_email = excluded.prospect_email, prospect_name = excluded.prospect_name,
          recipients = excluded.recipients, subject = excluded.subject, first_at = excluded.first_at,
          first_day = excluded.first_day, last_sent_at = excluded.last_sent_at, sent_count = excluded.sent_count,
          reply_at = excluded.reply_at, reply_day = excluded.reply_day, reply_message_id = excluded.reply_message_id,
          auto_at = excluded.auto_at, auto_day = excluded.auto_day, bounce_at = excluded.bounce_at,
          bounce_day = excluded.bounce_day, synced_at = excluded.synced_at
      where t.synced_at <= excluded.synced_at;

    insert into public.outreach_messages as x (mailbox_id, message_id, thread_id, kind, at, day, synced_at)
    select distinct on (r.message_id)
           p_mailbox, r.message_id, r.thread_id, r.kind, r.at, (r.at at time zone 'Australia/Sydney')::date, p_started
    from jsonb_to_recordset(v_messages) as r (message_id text, thread_id text, kind text, at timestamptz)
    where coalesce(r.message_id, '') <> '' and r.at is not null and r.kind in ('sent', 'reply', 'auto', 'bounce')
      and exists (select 1 from public.outreach_threads t where t.mailbox_id = p_mailbox and t.thread_id = r.thread_id)
    order by r.message_id
    on conflict (mailbox_id, message_id) do update
      set thread_id = excluded.thread_id, kind = excluded.kind, at = excluded.at, day = excluded.day,
          synced_at = excluded.synced_at
      where x.synced_at <= excluded.synced_at;

    if jsonb_typeof(v_cursor -> 'pending') = 'array' then
      v_pending := array(select jsonb_array_elements_text(v_cursor -> 'pending'));
    end if;
    insert into private.outreach_gmail_sync as s (mailbox_id, run_started, synced_at, history_id, scan_from, pending, failures,
      error, reconnect, ready_at)
    values (p_mailbox, p_started, p_started, coalesce(v_cursor ->> 'history_id', ''), (v_cursor ->> 'scan_from')::timestamptz,
            coalesce(v_pending, '{}'), coalesce(v_failures, '{}'::jsonb), '', false,
            case when cardinality(coalesce(v_pending, '{}')) = 0 then now() end)
    on conflict (mailbox_id) do update
      set synced_at = p_started,
          history_id = coalesce(v_cursor ->> 'history_id', s.history_id),
          scan_from = coalesce((v_cursor ->> 'scan_from')::timestamptz, s.scan_from),
          pending = coalesce(v_pending, s.pending),
          failures = coalesce(v_failures, s.failures),
          error = '',
          reconnect = false,
          ready_at = case when cardinality(coalesce(v_pending, s.pending)) = 0 then coalesce(s.ready_at, now()) else s.ready_at end;
  else
    insert into private.outreach_gmail_sync as s (mailbox_id, run_started, error, reconnect)
    values (p_mailbox, p_started, v_error, coalesce(p_reconnect, false))
    on conflict (mailbox_id) do update set error = excluded.error, reconnect = excluded.reconnect;
  end if;

  if coalesce(p_release, false) then
    update private.outreach_gmail_sync set claimed_at = null where mailbox_id = p_mailbox;
  end if;
  return true;
end;
$$;

-- 6. For the app: each mailbox's connection and sync; disconnecting ------------------------------------------------

-- Every mailbox (by position) with whether it's active (an inactive one is paused, not read), whether its Gmail is
-- connected (with the read scope), which account and client, when, and its sync: when it last saved, whether the first
-- full read is done (ready), how many threads are still queued, the last error and whether it needs reconnecting. Nulls
-- for a mailbox with no connection. Never a token or scope.
create or replace function public.outreach_gmail_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_view('outreach') then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  return jsonb_build_object('mailboxes', coalesce((
    select jsonb_agg(jsonb_build_object(
             'mailbox_id', m.id,
             'active', m.active,
             'connected', g.mailbox_id is not null and private.has_gmail_read(g.scopes),
             'email', g.email,
             'client', g.client,
             'connected_at', g.connected_at,
             'synced_at', s.synced_at,
             'ready', case when g.mailbox_id is not null then s.ready_at is not null end,
             'pending', case when g.mailbox_id is not null then coalesce(cardinality(s.pending), 0) end,
             'error', case when g.mailbox_id is not null then coalesce(s.error, '') end,
             'reconnect', case when g.mailbox_id is not null
                               then coalesce(s.reconnect, false) or not private.has_gmail_read(g.scopes) end)
           order by m.position, m.id)
    from public.outreach_mailboxes m
    left join private.outreach_gmail g on g.mailbox_id = m.id
    left join private.outreach_gmail_sync s on s.mailbox_id = m.id and g.mailbox_id is not null), '[]'::jsonb));
end;
$$;

-- An admin disconnects a mailbox's Gmail (revoking it at Google is that account's myaccount.google.com → Security →
-- Third-party connections). Its threads and sync are forgotten (§8). True when there was a connection.
create or replace function public.outreach_gmail_disconnect(p_mailbox uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = 'insufficient_privilege';
  end if;
  delete from private.outreach_gmail where mailbox_id = p_mailbox;
  return found;
end;
$$;

-- 7. Reading: the dashboard's numbers and the threads list (RLS applies: security invoker) ------------------------

-- Per Sydney day and mailbox: our cold emails sent (each first email and follow-up), prospects emailed (threads
-- started), and threads first replied to, auto-replied to and bounced, on those days. Same rules as gmailDaily().
create or replace function public.outreach_gmail_daily(p_from date, p_to date)
returns table (day date, mailbox_id uuid, sent int, started int, replies int, autos int, bounces int)
language sql stable security invoker set search_path = public as $$
  select x.day, x.mailbox_id, sum(x.sent)::int, sum(x.started)::int, sum(x.replies)::int, sum(x.autos)::int, sum(x.bounces)::int
  from (
    select m.day, m.mailbox_id, 1 as sent, 0 as started, 0 as replies, 0 as autos, 0 as bounces
    from public.outreach_messages m where m.kind = 'sent' and m.day between p_from and p_to
    union all
    select t.first_day, t.mailbox_id, 0, 1, 0, 0, 0 from public.outreach_threads t where t.first_day between p_from and p_to
    union all
    select t.reply_day, t.mailbox_id, 0, 0, 1, 0, 0 from public.outreach_threads t where t.reply_day between p_from and p_to
    union all
    select t.auto_day, t.mailbox_id, 0, 0, 0, 1, 0 from public.outreach_threads t where t.auto_day between p_from and p_to
    union all
    select t.bounce_day, t.mailbox_id, 0, 0, 0, 0, 1 from public.outreach_threads t where t.bounce_day between p_from and p_to
  ) x
  group by x.day, x.mailbox_id
  order by x.day, x.mailbox_id;
$$;

-- Threads started in the period, by mailbox: what became of them (outcome: bounced, else replied, else auto, else
-- waiting) and how many emails we sent in each (followups: 1, 2, 3, 4+). Same rules as gmailBreakdown().
create or replace function public.outreach_gmail_breakdown(p_from date, p_to date)
returns table (mailbox_id uuid, kind text, value text, n int)
language sql stable security invoker set search_path = public as $$
  select t.mailbox_id, 'outcome'::text,
         case when t.bounce_at is not null then 'bounced' when t.reply_at is not null then 'replied'
              when t.auto_at is not null then 'auto' else 'waiting' end,
         count(*)::int
  from public.outreach_threads t where t.first_day between p_from and p_to
  group by 1, 3
  union all
  select t.mailbox_id, 'followups'::text, case when t.sent_count >= 4 then '4+' else greatest(t.sent_count, 1)::text end, count(*)::int
  from public.outreach_threads t where t.first_day between p_from and p_to
  group by 1, 3
  order by 1, 2, 3;
$$;

-- The cold threads list, for one mailbox (null: all), newest first, p_limit at a time from p_offset. p_only: 'sent'
-- (started in the period), 'replies' (first replied to in it) or 'bounced' (bounced in it); a null p_from or p_to leaves
-- that end open. p_search (trimmed, any case) matches the prospect's address and name, the subject and the sheet's
-- organisation. Each thread brings the sheet's row for it (still in the sheet; its Gmail thread id, else the newest for
-- the prospect's address): organisation, role, tier and the agent's reply status. Same rules as filterThreads().
create or replace function public.outreach_gmail_threads(p_mailbox uuid default null, p_from date default null,
  p_to date default null, p_only text default 'sent', p_search text default '', p_limit int default 50, p_offset int default 0)
returns table (id uuid, mailbox_id uuid, thread_id text, sender text, prospect_email text, prospect_name text, recipients int,
  subject text, first_at timestamptz, first_day date, last_sent_at timestamptz, sent_count int, reply_at timestamptz,
  reply_day date, auto_at timestamptz, auto_day date, bounce_at timestamptz, bounce_day date, reply_kind text,
  organisation text, contact_role text, tier text, sheet_reply_status text)
language sql stable security invoker set search_path = public as $$
  with listed as (
    select t.*, case p_only when 'replies' then t.reply_day when 'bounced' then t.bounce_day else t.first_day end as listed_day
    from public.outreach_threads t
    where p_mailbox is null or t.mailbox_id = p_mailbox
  ),
  matched as (
    select l.*, coalesce(e.organisation, '') as organisation, coalesce(e.contact_role, '') as contact_role,
           coalesce(e.tier, '') as tier, coalesce(e.reply_status, '') as sheet_reply_status
    from listed l
    left join lateral (
      select e.organisation, e.contact_role, e.tier, e.reply_status
      from public.outreach_emails e
      where e.in_sheet
        and ((l.thread_id <> '' and e.thread_id = l.thread_id) or (l.prospect_email <> '' and lower(e.contact_email) = l.prospect_email))
      order by (e.thread_id = l.thread_id) desc, e.sent_on desc nulls last, e.date_logged desc nulls last, e.id
      limit 1
    ) e on true
    where l.listed_day is not null and (p_from is null or l.listed_day >= p_from) and (p_to is null or l.listed_day <= p_to)
  )
  select r.id, r.mailbox_id, r.thread_id, r.sender, r.prospect_email, r.prospect_name, r.recipients, r.subject, r.first_at,
         r.first_day, r.last_sent_at, r.sent_count, r.reply_at, r.reply_day, r.auto_at, r.auto_day, r.bounce_at, r.bounce_day,
         r.reply_kind, r.organisation, r.contact_role, r.tier, r.sheet_reply_status
  from matched r
  cross join (select lower(btrim(coalesce(p_search, ''))) as term) q
  where q.term = '' or strpos(lower(r.prospect_email), q.term) > 0 or strpos(lower(r.prospect_name), q.term) > 0
     or strpos(lower(r.subject), q.term) > 0 or strpos(lower(r.organisation), q.term) > 0
  order by r.listed_day desc, r.first_at desc, r.id
  limit greatest(coalesce(p_limit, 50), 0) offset greatest(coalesce(p_offset, 0), 0);
$$;

-- 8. Forgetting a mailbox's Gmail data ----------------------------------------------------------------------------

-- When its connection is removed (disconnect), or changes to another Google account or client, or no longer reads
-- Gmail. Reconnecting as the same account and client with the read scope keeps what was read.
create or replace function public.outreach_gmail_forget() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.email = old.email and new.client = old.client and private.has_gmail_read(new.scopes) then
    return null;
  end if;
  delete from public.outreach_threads where mailbox_id = old.mailbox_id;
  delete from private.outreach_gmail_sync where mailbox_id = old.mailbox_id;
  return null;
end;
$$;

drop trigger if exists outreach_gmail_forget on private.outreach_gmail;
create trigger outreach_gmail_forget after delete or update on private.outreach_gmail
  for each row execute function public.outreach_gmail_forget();

-- When the connected account's address is taken off the mailbox, the connection goes (and with it, above, the data).
-- A mailbox made inactive keeps everything; a mailbox removed takes it all with it (on delete cascade).
create or replace function public.outreach_gmail_addresses() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from private.outreach_gmail g
  where g.mailbox_id = new.id
    and g.email <> all (array(select lower(btrim(a)) from unnest(new.addresses) a where a is not null));
  return null;
end;
$$;

drop trigger if exists outreach_gmail_addresses on public.outreach_mailboxes;
create trigger outreach_gmail_addresses after update of addresses on public.outreach_mailboxes
  for each row execute function public.outreach_gmail_addresses();

-- 9. Who may call what (Supabase grants EXECUTE on new functions to everyone; narrow it) ---------------------------

revoke all on function public.outreach_gmail_connect(uuid, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.outreach_gmail_known() from public, anon, authenticated;
revoke all on function public.outreach_gmail_claim(int, int) from public, anon, authenticated;
revoke all on function public.outreach_gmail_job(uuid) from public, anon, authenticated;
revoke all on function public.outreach_gmail_save(uuid, timestamptz, jsonb, jsonb, jsonb, boolean, text, boolean)
  from public, anon, authenticated;
revoke all on function public.outreach_gmail_forget() from public, anon, authenticated;
revoke all on function public.outreach_gmail_addresses() from public, anon, authenticated;
revoke all on function public.outreach_gmail_status() from public, anon;
revoke all on function public.outreach_gmail_disconnect(uuid) from public, anon;
revoke all on function public.outreach_gmail_daily(date, date) from public, anon;
revoke all on function public.outreach_gmail_breakdown(date, date) from public, anon;
revoke all on function public.outreach_gmail_threads(uuid, date, date, text, text, int, int) from public, anon;
grant execute on function public.outreach_gmail_status() to authenticated;
grant execute on function public.outreach_gmail_disconnect(uuid) to authenticated;
grant execute on function public.outreach_gmail_daily(date, date) to authenticated;
grant execute on function public.outreach_gmail_breakdown(date, date) to authenticated;
grant execute on function public.outreach_gmail_threads(uuid, date, date, text, text, int, int) to authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.outreach_gmail_connect(uuid, text, text, text, uuid, text) to service_role;
    grant execute on function public.outreach_gmail_known() to service_role;
    grant execute on function public.outreach_gmail_claim(int, int) to service_role;
    grant execute on function public.outreach_gmail_job(uuid) to service_role;
    grant execute on function public.outreach_gmail_save(uuid, timestamptz, jsonb, jsonb, jsonb, boolean, text, boolean) to service_role;
    -- The function checks which threads are already stored cold ones (outreach_threads?mailbox_id=eq.…&thread_id=in.(…)).
    grant select on public.outreach_threads to service_role;
  end if;
end $$;

commit;
