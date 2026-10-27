// Runs supabase/migrations/0001_cortex.sql in PGlite (Postgres compiled to WASM, no network) on top
// of a minimal Supabase stub and checks the sign-up gate, triggers and row-level security as
// different users; then applies 0002_team_workflow.sql on top of the rows those checks leave behind (as on
// the live database) and checks roles, module access, the board merge, automations, finance and storage; then
// 0003_timezones_projects_view.sql (Sydney business day, per-person time zones, Projects view-only for staff); then
// 0004_clients_google.sql (client contacts and contracts, credits, approve / contract to-dos, Google accounts); then
// 0005_work_tools.sql (each person's Tools in My Work); then 0006_boards.sql (sub-boards under Projects and Marketing,
// each person's own Projects page, and who sees and edits which board); then 0007_outreach.sql (outreach mailboxes,
// the agent's emails read from its sheet, notes and the sheet's link: who reads and writes what, the guards, and the
// dashboard RPCs, which must give the same numbers as src/lib/outreach.js); then 0008_pipeline_stages.sql (Pipeline's
// stages, Work in Progress); then 0009_calendar.sql (the team's calendar events, each person's Google meetings and the
// calendar sync's RPCs, a calendar on boards); then 0010_outreach_gmail.sql (each outreach mailbox's Gmail connection,
// the Gmail sync's RPCs, cold threads and their messages, the forgetting, and the dashboard RPCs, which must give the same
// numbers and lists as src/lib/outreach.js); then 0011_team_access_read.sql (every active teammate reads everyone's module
// access levels, for the Team pages); then 0012_crm_profile.sql (deals' and clients' notes, meetings and links, who reads
// and writes them, and how they follow a deal to its client). Last, the sync engine's writes of every synced table (flatten() rows as
// PostgREST upserts), personal pages, Outreach and calendar events included.
// Usage: node scripts/test-db.mjs (exits non-zero on any failure).
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { register } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { TABLES, flatten, normalizeRow } from '../src/data/backend/schema.js';

const root = new URL('../', import.meta.url);
const migration = await readFile(new URL('supabase/migrations/0001_cortex.sql', root), 'utf8');
const migration2 = await readFile(new URL('supabase/migrations/0002_team_workflow.sql', root), 'utf8');
const migration3 = await readFile(new URL('supabase/migrations/0003_timezones_projects_view.sql', root), 'utf8');
const migration4 = await readFile(new URL('supabase/migrations/0004_clients_google.sql', root), 'utf8');
const migration5 = await readFile(new URL('supabase/migrations/0005_work_tools.sql', root), 'utf8');
const migration6 = await readFile(new URL('supabase/migrations/0006_boards.sql', root), 'utf8');
const migration7 = await readFile(new URL('supabase/migrations/0007_outreach.sql', root), 'utf8');
const migration8 = await readFile(new URL('supabase/migrations/0008_pipeline_stages.sql', root), 'utf8');
const migration9 = await readFile(new URL('supabase/migrations/0009_calendar.sql', root), 'utf8');
const migration10 = await readFile(new URL('supabase/migrations/0010_outreach_gmail.sql', root), 'utf8');
const migration11 = await readFile(new URL('supabase/migrations/0011_team_access_read.sql', root), 'utf8');
const migration12 = await readFile(new URL('supabase/migrations/0012_crm_profile.sql', root), 'utf8');
const migration13 = await readFile(new URL('supabase/migrations/0013_task_emails.sql', root), 'utf8');
const setupAdmins = await readFile(new URL('supabase/setup-admins.sql', root), 'utf8');

// The parts of a Supabase project the migration relies on. auth.uid() / auth.jwt() read the same
// settings PostgREST sets per request. PGlite is single-user, so a "request" is simulated with
// set role + request.jwt.claim.sub (see as()). The default privileges mirror Supabase, which grants
// anon and authenticated everything on new public tables; the migration has to narrow that.
// pgcrypto comes from PGlite's contrib bundle into an `extensions` schema, as on Supabase. The
// publication only records membership here; realtime itself is not exercised.
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema extensions;
  create schema auth;
  grant usage on schema auth to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  create table auth.users (
    id uuid primary key,
    email text,
    raw_user_meta_data jsonb not null default '{}'
  );
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
    )::uuid
  $$;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim', true), ''),
      nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
  $$;
  create publication supabase_realtime;
`;

// Supabase Storage keeps files in storage.objects (one row per file, RLS on) and buckets in storage.buckets.
// Only created after 0002's first run, so that run also shows the storage section is skipped without it.
const STORAGE_STUB = `
  create schema storage;
  grant usage on schema storage to anon, authenticated;
  create table storage.buckets (id text primary key, name text not null unique, public boolean not null default false);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text not null,
    owner uuid default auth.uid(),
    unique (bucket_id, name)
  );
  alter table storage.objects enable row level security;
  grant select on storage.buckets to anon, authenticated;
  grant select, insert, update, delete on storage.objects to anon, authenticated;
  insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true);
`;

const db = new PGlite({ extensions: { pgcrypto } });
let passed = 0;
let failed = 0;

function check(name, ok, detail) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`);
}

const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];
// Rows changed, or the error message if the statement raised (so `=== 0` checks fail cleanly).
const affected = async (sql, params) => db.query(sql, params).then((r) => r.affectedRows, (e) => e.message);
// Resolves to the error message, or null when the statement succeeded.
const error = async (sql, params) => {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e.message;
  }
};

// Act as a signed-in user (uuid) or, with null, as the owner with no JWT (SQL editor / setup).
async function as(userId) {
  if (userId) {
    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
  } else {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

// What supabase-js .upsert(rows, { onConflict, ignoreDuplicates }) makes PostgREST run: the JSON body through
// json_to_recordset, ON CONFLICT on the key, and RETURNING (so SELECT policies apply to the new rows).
async function postgrestUpsert(table, body, { onConflict = 'id', ignoreDuplicates = false } = {}) {
  const types = Object.fromEntries((await rows(`select attname, format_type(atttypid, atttypmod) as type from pg_attribute
    where attrelid = $1::regclass and attnum > 0 and not attisdropped`, [`public.${table}`])).map((r) => [r.attname, r.type]));
  const cols = Object.keys(body[0]);
  const missing = cols.filter((c) => !types[c]);
  if (missing.length) return `${table} has no column ${missing.join(', ')}`;
  const q = (c) => `"${c}"`;
  const keys = onConflict.split(',');
  const action = ignoreDuplicates ? 'do nothing'
    : `do update set ${cols.filter((c) => !keys.includes(c)).map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}`;
  return error(`with pgrst_source as (
      insert into public.${table} (${cols.map(q).join(', ')})
      select ${cols.map(q).join(', ')} from json_to_recordset($1::json) as _(${cols.map((c) => `${q(c)} ${types[c]}`).join(', ')})
      on conflict (${keys.map(q).join(', ')}) ${action} returning 1)
    select count(*) from pgrst_source`, [JSON.stringify(body)]);
}
// Sorted-key JSON, as diff() compares rows.
const stable = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

async function signUp(email, fullName) {
  await as(null);
  const id = randomUUID();
  await db.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)',
    [id, email, fullName ? { full_name: fullName } : {}]);
  return id;
}

async function main() {
  // 0. Migration ----------------------------------------------------------------------------------

  await db.exec(SUPABASE_STUB);
  try {
    await db.exec(migration);
    check('migration runs on a fresh database', true);
  } catch (e) {
    check('migration runs on a fresh database', false, e.message);
    return;
  }
  const rerun = await db.exec(migration).then(() => null, (e) => e.message);
  check('migration re-runs cleanly', rerun === null, rerun);

  const noRls = await rows(`select relname from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`);
  check('RLS is enabled on every public table', noRls.length === 0, noRls);

  const published = (await rows(`select tablename from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'`)).map((r) => r.tablename);
  check('realtime publishes the 21 synced tables, not admin_emails',
    published.length === 21 && !published.includes('admin_emails'), published);

  const seed = await one(`select
    (select count(*)::int from org_settings where id = 1 and invoice_prefix = 'INV-' and payment_terms_days = 30) as org,
    (select string_agg(board_key || ':' || name, ',' order by board_key, position) from board_groups) as groups,
    (select count(*)::int from channels where name = 'general') as general`);
  check('seed: org row, board groups and #general',
    seed.org === 1 && seed.groups === 'admin:To do,marketing:This month,projects:Active,projects:Backlog' && seed.general === 1, seed);

  // 1. Sign-up gate -------------------------------------------------------------------------------

  const outsiders = ['someone@gmail.com', 'x@assetstackai.com.example.com', 'x@notassetstackai.com', 'x@sub.assetstackai.com'];
  const outsiderErrors = [];
  for (const email of outsiders) outsiderErrors.push(await error(
    'insert into auth.users (id, email) values ($1, $2)', [randomUUID(), email]));
  const leftovers = await one(`select (select count(*)::int from auth.users) as users, (select count(*)::int from profiles) as profiles`);
  check('1. sign-ups outside @assetstackai.com are rejected (gmail.com and look-alikes)',
    outsiderErrors.every((m) => m && m.includes('Only @assetstackai.com')) && leftovers.users === 0 && leftovers.profiles === 0,
    { outsiderErrors, leftovers });

  // 2. Staff sign-up creates an active member and joins #general ----------------------------------

  const alice = await signUp('alice@assetstackai.com', 'Alice Example');
  const aliceProfile = await one('select * from profiles where id = $1', [alice]);
  const aliceGeneral = await one(`select count(*)::int as n from channel_members m join channels c on c.id = m.channel_id
    where m.user_id = $1 and c.name = 'general'`, [alice]);
  check('2. @assetstackai.com sign-up creates an active member profile',
    aliceProfile?.role === 'member' && aliceProfile.active === true && aliceProfile.name === 'Alice Example'
      && aliceProfile.initials === 'AE' && /^#[0-9a-f]{6}$/.test(aliceProfile.color),
    aliceProfile);
  check('2. ...and a #general membership', aliceGeneral.n === 1, aliceGeneral);

  // 3. Admins -------------------------------------------------------------------------------------

  await db.query("insert into admin_emails (email) values ('boss@assetstackai.com')");
  const boss = await signUp('Boss@AssetStackAI.com');
  const bossProfile = await one('select email, name, initials, role from profiles where id = $1', [boss]);
  check('3. an email in admin_emails signs up as admin (case-insensitive, name from the address)',
    bossProfile?.role === 'admin' && bossProfile.email === 'boss@assetstackai.com' && bossProfile.name === 'boss'
      && bossProfile.initials === 'BO',
    bossProfile);

  // Signs in before being listed; setup-admins.sql promotes them once 0002 has run (section 10).
  const early = await signUp('you@assetstackai.com', 'Early Bird');

  // 4. Members work with the business tables ------------------------------------------------------

  await as(alice);
  const client = await one("insert into clients (name, sector, team) values ('Example Council', 'Government', array[$1::uuid]) returning id, updated_by", [alice]);
  const group = await one("select id from board_groups where board_key = 'projects' and name = 'Active'");
  const item = await one(`insert into items (board_key, group_id, name, "values") values ('projects', $1, 'Kick-off', '{"owner": "x"}') returning id`, [group.id]);
  await db.query("insert into subtasks (item_id, text) values ($1, 'Agenda')", [item.id]);
  const invoice = await one("insert into invoices (client_id, number, issued, status) values ($1, 'INV-9001', '2026-10-01', 'Draft') returning id", [client.id]);
  await db.query("insert into invoice_lines (invoice_id, description, qty, rate) values ($1, 'Licence', '1', '1,000')", [invoice.id]);
  const upsertClient = await error(`insert into clients (id, name, sector) values ($1, 'Example Council', 'Local government')
    on conflict (id) do update set name = excluded.name, sector = excluded.sector`, [client.id]);
  const seen = await one(`select
    (select sector from clients where id = $1) as sector,
    (select count(*)::int from items where id = $2) as items,
    (select count(*)::int from subtasks where item_id = $2) as subtasks,
    (select count(*)::int from invoices where id = $3) as invoices,
    (select rate from invoice_lines where invoice_id = $3) as rate`, [client.id, item.id, invoice.id]);
  check('4. a member can insert, upsert and read clients, board items and invoices',
    upsertClient === null && seen.sector === 'Local government' && seen.items === 1 && seen.subtasks === 1
      && seen.invoices === 1 && seen.rate === '1,000',
    { upsertClient, seen });
  check('4. touch() stamps updated_by with the signed-in user', client.updated_by === alice, client);

  const ownNote = await error("insert into client_notes (client_id, user_id, text) values ($1, $2, 'Met the team')", [client.id, alice]);
  const forgedNote = await error("insert into client_notes (client_id, user_id, text) values ($1, $2, 'Not me')", [client.id, boss]);
  check('4. notes and item updates can only be written as yourself', ownNote === null && forgedNote !== null, { ownNote, forgedNote });

  // 5. Profile protection and org settings --------------------------------------------------------

  await as(alice);
  await db.query(`update profiles set role = 'admin', active = false, email = 'other@assetstackai.com', name = 'Alice E'
    where id = $1`, [alice]);
  const selfEdit = await one('select role, active, email, name from profiles where id = $1', [alice]);
  check('5. a member cannot change their own role, active flag or email (name still saves)',
    selfEdit.role === 'member' && selfEdit.active === true && selfEdit.email === 'alice@assetstackai.com' && selfEdit.name === 'Alice E',
    selfEdit);

  const ownUpsert = await error(`insert into profiles (id, email, name, initials, color, role, active)
    values ($1, 'alice@assetstackai.com', 'Alice Example', 'AE', '#579bfc', 'admin', true)
    on conflict (id) do update set name = excluded.name, initials = excluded.initials, color = excluded.color,
      role = excluded.role, active = excluded.active, email = excluded.email`, [alice]);
  const afterUpsert = await one('select role, name from profiles where id = $1', [alice]);
  check('5. a member can upsert their own profile; role stays member',
    ownUpsert === null && afterUpsert.role === 'member' && afterUpsert.name === 'Alice Example', { ownUpsert, afterUpsert });

  const otherProfile = await affected("update profiles set name = 'Changed' where id = $1", [boss]);
  check("5. a member cannot edit someone else's profile", otherProfile === 0, otherProfile);

  const orgUpdate = await affected("update org_settings set business_name = 'Member Pty Ltd' where id = 1");
  const orgUpsert = await error(`insert into org_settings (id, business_name) values (1, 'Member Pty Ltd')
    on conflict (id) do update set business_name = excluded.business_name`);
  const orgNew = await error('insert into org_settings (id) values (2)');
  check('5. a member cannot update or upsert org_settings', orgUpdate === 0 && orgUpsert !== null && orgNew !== null,
    { orgUpdate, orgUpsert, orgNew });

  await as(boss);
  const adminOrg = await affected("update org_settings set business_name = 'Example Pty Ltd', bsb = '000-000' where id = 1");
  const adminOrgUpsert = await error(`insert into org_settings (id, payment_terms_days) values (1, 14)
    on conflict (id) do update set payment_terms_days = excluded.payment_terms_days`);
  const org = await one('select business_name, payment_terms_days, updated_by from org_settings where id = 1');
  check('5. an admin can update and upsert org_settings',
    adminOrg === 1 && adminOrgUpsert === null && org.business_name === 'Example Pty Ltd' && org.payment_terms_days === 14 && org.updated_by === boss,
    { adminOrg, adminOrgUpsert, org });

  await db.query("update profiles set role = 'admin' where id = $1", [alice]);
  const promoted = (await one('select role from profiles where id = $1', [alice])).role;
  await db.query("update profiles set role = 'member' where id = $1", [alice]);
  const demoted = (await one('select role from profiles where id = $1', [alice])).role;
  check("5. an admin can change someone's role", promoted === 'admin' && demoted === 'member', { promoted, demoted });

  // 6. Channels and messages ----------------------------------------------------------------------

  const general = (await one("select id from channels where name = 'general'")).id;

  await as(boss);
  const privateChannel = (await one("insert into channels (name) values ('leadership') returning id")).id;
  await db.query('insert into channel_members (channel_id, user_id) values ($1, $2)', [privateChannel, boss]);
  await db.query("insert into messages (channel_id, user_id, text) values ($1, $2, 'Board pack is ready')", [privateChannel, boss]);

  await as(alice);
  const outsiderView = await one(`select
    (select count(*)::int from messages where channel_id = $1) as messages,
    (select count(*)::int from channels where id = $1) as channels,
    (select count(*)::int from channel_members where channel_id = $1) as members`, [privateChannel]);
  const outsiderPost = await error("insert into messages (channel_id, user_id, text) values ($1, $2, 'hi')", [privateChannel, alice]);
  const outsiderJoin = await error('insert into channel_members (channel_id, user_id) values ($1, $2)', [privateChannel, alice]);
  check('6. a non-member cannot read, post to or join a private channel',
    outsiderView.messages === 0 && outsiderView.channels === 0 && outsiderView.members === 0 && outsiderPost !== null && outsiderJoin !== null,
    { outsiderView, outsiderPost, outsiderJoin });

  const forgedMessage = await error("insert into messages (channel_id, user_id, text) values ($1, $2, 'as boss')", [general, boss]);
  const ownMessage = await error("insert into messages (channel_id, user_id, text) values ($1, $2, 'Morning all')", [general, alice]);
  check('6. a member cannot post as another user, but can post as themselves', forgedMessage !== null && ownMessage === null,
    { forgedMessage, ownMessage });

  await as(boss);
  const invite = await error('insert into channel_members (channel_id, user_id) values ($1, $2)', [privateChannel, alice]);
  // What the sync engine sends for a membership that already exists (ignoreDuplicates).
  const reinvite = await error(`insert into channel_members (channel_id, user_id) values ($1, $2)
    on conflict (channel_id, user_id) do nothing`, [privateChannel, alice]);
  const bossReadsGeneral = (await one('select count(*)::int as n from messages where channel_id = $1', [general])).n;

  await as(alice);
  const memberView = (await one('select count(*)::int as n from messages where channel_id = $1', [privateChannel])).n;
  check('6. once added, a member can read the private channel (re-upserting a membership is fine)',
    invite === null && reinvite === null && memberView === 1, { invite, reinvite, memberView });
  check('6. members of #general read its messages', bossReadsGeneral === 1, bossReadsGeneral);

  const ownChannel = (await one("insert into channels (name) values ('alice-project') returning id")).id;
  const creatorAdds = await error('insert into channel_members (channel_id, user_id) values ($1, $2), ($1, $3)', [ownChannel, alice, early]);
  const renameGeneral = await affected("update channels set name = 'random' where id = $1", [general]);
  check('6. a channel creator can add members; members cannot rename #general', creatorAdds === null && renameGeneral === 0,
    { creatorAdds, renameGeneral });

  // Only the member themselves or an admin removes a membership, and an update can't move one elsewhere instead.
  const removeOther = await affected('delete from channel_members where channel_id = $1 and user_id = $2', [privateChannel, boss]);
  const moveOther = await affected('update channel_members set channel_id = $3 where channel_id = $1 and user_id = $2',
    [privateChannel, boss, ownChannel]);
  const swapOther = await affected('update channel_members set user_id = $3 where channel_id = $1 and user_id = $2',
    [privateChannel, boss, early]);
  const moveGeneral = await affected('update channel_members set channel_id = $3 where channel_id = $1 and user_id = $2',
    [general, early, ownChannel]);
  await as(boss);
  const bossStillReads = (await one('select count(*)::int as n from messages where channel_id = $1', [privateChannel])).n;
  await as(alice);
  check("6. a member cannot remove, move or swap out someone else's membership",
    removeOther === 0 && moveOther === 0 && swapOther === 0 && moveGeneral === 0 && bossStillReads === 1,
    { removeOther, moveOther, swapOther, moveGeneral, bossStillReads });

  // The sync engine's shape: the channel row, then every membership (creator included) in one upsert. PostgREST
  // always adds RETURNING, so the new rows must also pass the SELECT policy while the creator isn't a member yet.
  const synced = (await one("insert into channels (name) values ('alice-launch') returning id")).id;
  const syncedAdd = await error(`with pgrst_source as (
      insert into channel_members (channel_id, user_id) values ($1, $2), ($1, $3)
      on conflict (channel_id, user_id) do nothing returning 1)
    select count(*) from pgrst_source`, [synced, alice, early]);
  const syncedMembers = (await one('select count(*)::int as n from channel_members where channel_id = $1', [synced])).n;
  check('6. a new channel and all its members save in one PostgREST-style upsert', syncedAdd === null && syncedMembers === 2,
    { syncedAdd, syncedMembers });

  // 7. Read state is private ----------------------------------------------------------------------

  await as(boss);
  await db.query('insert into read_state (user_id, channel_id, last_read_at) values ($1, $2, now())', [boss, general]);
  await as(alice);
  await db.query(`insert into read_state (user_id, channel_id, last_read_at) values ($1, $2, now())
    on conflict (user_id, channel_id) do update set last_read_at = excluded.last_read_at`, [alice, general]);
  const visibleReads = await rows('select user_id from read_state');
  const forgedRead = await error('insert into read_state (user_id, channel_id, last_read_at) values ($1, $2, now())', [boss, privateChannel]);
  const touchedOthers = await affected('update read_state set last_read_at = now() where user_id = $1', [boss]);
  check("7. read_state rows of other users are invisible and untouchable",
    visibleReads.length === 1 && visibleReads[0].user_id === alice && forgedRead !== null && touchedOthers === 0,
    { visibleReads, forgedRead, touchedOthers });

  // 8. Deactivated accounts see nothing -----------------------------------------------------------

  const carol = await signUp('carol@assetstackai.com', 'Carol Example');
  await as(carol);
  await db.query('insert into read_state (user_id, channel_id, last_read_at) values ($1, $2, now())', [carol, general]);
  const activeStaff = (await one('select public.is_staff() as staff')).staff;
  await as(null);
  await db.query('update profiles set active = false where id = $1', [carol]);

  await as(carol);
  const staff = (await one('select public.is_staff() as staff')).staff;
  const tables = (await rows(`select tablename from pg_tables where schemaname = 'public' and tablename <> 'admin_emails'
    order by tablename`)).map((r) => r.tablename);
  const visible = {};
  for (const t of tables) {
    const n = (await one(`select count(*)::int as n from public.${t}`)).n;
    if (n) visible[t] = n;
  }
  const inactiveWrite = await error("insert into clients (name) values ('Should fail')");
  const inactivePost = await error("insert into messages (channel_id, user_id, text) values ($1, $2, 'hello?')", [general, carol]);
  check('8. an inactive profile is not staff and sees no rows in any table',
    activeStaff === true && staff === false && tables.length === 21 && Object.keys(visible).length === 0,
    { activeStaff, staff, tables: tables.length, visible });
  check('8. ...and cannot write', inactiveWrite !== null && inactivePost !== null, { inactiveWrite, inactivePost });

  // Extra: the anon key and admin_emails ----------------------------------------------------------

  await as(null);
  await db.exec('set role anon');
  const anonRead = await error('select * from public.clients');
  await as(alice);
  const adminEmailsRead = await error('select * from public.admin_emails');
  check('anon has no table access; signed-in users cannot read admin_emails', anonRead !== null && adminEmailsRead !== null,
    { anonRead, adminEmailsRead });

  await as(null);
  return { alice, boss, early, carol, client: client.id, item: item.id, invoice: invoice.id, projectsActive: group.id };
}

// Phase 2: 0002_team_workflow.sql on top of 0001 and the rows above (docs/PHASE2.md §7) -----------------

const uid = () => randomUUID();
// First row of a statement, or the error message if it raised.
const attempt = async (sql, params) => db.query(sql, params).then((r) => r.rows[0] ?? null, (e) => e.message);

async function applyMigration2() {
  await as(null);
  try {
    await db.exec(migration2);
    return null;
  } catch (e) {
    await db.exec('rollback').catch(() => {});
    return e.message;
  }
}

async function phase2({ alice, boss, early, carol, client, item, invoice, projectsActive }) {
  // 9. 0002 on a database that already holds rows -------------------------------------------------------

  // What the live Admin board may hold: the seeded To do group plus one of the team's own, items with and
  // without an owner (and an owner id that no longer exists).
  await as(null);
  const adminToDo = (await one("select id from board_groups where board_key = 'admin' and name = 'To do'")).id;
  const adminLater = (await one(`insert into board_groups (board_key, name, color, position)
    values ('admin', 'Later', '#e6eaf2', 1) returning id`)).id;
  const marketingGroup = (await one("select id from board_groups where board_key = 'marketing'")).id;
  const addItem = async (board, groupId, name, values) => (await one(`insert into items (board_key, group_id, name, "values")
    values ($1, $2, $3, $4) returning id`, [board, groupId, name, values])).id;
  const owned = await addItem('admin', adminToDo, 'Renew insurance', { owner: alice, status: 'In progress' });
  const unowned = await addItem('admin', adminToDo, 'File BAS', { owner: '', status: 'Not started' });
  const stale = await addItem('admin', adminLater, 'Old task', { owner: uid() });
  const promo = await addItem('marketing', marketingGroup, 'Golf day post', { owner: boss, channel: 'LinkedIn' });
  const bare = await addItem('projects', projectsActive, 'No owner yet', { status: 'Done' });
  await db.query("insert into subtasks (item_id, text) values ($1, 'Find the policy')", [owned]);

  const first = await applyMigration2();
  const storageSkipped = (await one("select to_regnamespace('storage') is null as skipped")).skipped;
  const body = migration2.replace(/--.*$/gm, '').trim();
  check('9. 0002 runs on top of 0001 and its rows, as one transaction (storage part skipped without a storage schema)',
    first === null && storageSkipped === true && /^begin;/i.test(body) && /commit;$/i.test(body), { first, storageSkipped });
  if (first) return;

  await db.exec(STORAGE_STUB);
  const second = await applyMigration2();
  check('9. 0002 re-runs cleanly (and sets up storage once the schema exists)', second === null, second);
  if (second) return;

  const noRls = await rows(`select relname from pg_class
    where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`);
  const untouched = await rows(`select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    and not exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'touch')`);
  check('9. RLS and touch() on every public table, new ones included', noRls.length === 0 && untouched.length === 0, { noRls, untouched });

  const NEW_TABLES = ['module_access', 'routines', 'todos', 'billing_plans', 'client_usage', 'bank_statements', 'payments',
    'expenses', 'subscriptions', 'time_entries'];
  const published = (await rows(`select tablename from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'`)).map((r) => r.tablename);
  check('9. realtime publishes the 31 synced tables (the 10 new ones too), not admin_emails',
    published.length === 31 && NEW_TABLES.every((t) => published.includes(t)) && !published.includes('admin_emails'), published);

  // 10. Roles --------------------------------------------------------------------------------------------

  const roles = await one(`select
    (select string_agg(email || ':' || role, ',' order by email) from profiles) as roles,
    (select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = 'role') as def,
    (select string_agg(email || ':' || role, ',' order by email) from admin_emails) as listed`);
  const memberAgain = await error("update profiles set role = 'member' where id = $1", [alice]);
  const badListing = await error("insert into admin_emails (email, role) values ('x@assetstackai.com', 'staff')");
  check('10. role migration: members become staff, admins stay admin, member is gone, new profiles default to staff',
    roles.roles === 'alice@assetstackai.com:staff,boss@assetstackai.com:admin,carol@assetstackai.com:staff,you@assetstackai.com:staff'
      && String(roles.def).startsWith("'staff'") && memberAgain !== null,
    { roles, memberAgain });
  check('10. admin_emails gains a role: admin by default, superadmin or admin only',
    roles.listed === 'boss@assetstackai.com:admin' && badListing !== null, { listed: roles.listed, badListing });

  const before = (await one('select role from profiles where id = $1', [early])).role;
  await db.exec(setupAdmins);
  const after = await one(`select p.role, a.role as listed from profiles p join admin_emails a on lower(a.email) = p.email
    where p.id = $1`, [early]);
  check('3. setup-admins.sql promotes someone who signed in earlier',
    before === 'staff' && after?.role === after?.listed && ['admin', 'superadmin'].includes(after?.role), { before, after });

  await db.query("insert into admin_emails (email, role) values ('super.example@assetstackai.com', 'superadmin')");
  const david = await signUp('super.example@assetstackai.com', 'Super Example');
  const hello = await signUp('staff.example@assetstackai.com', 'Staff Example');
  await db.query("update profiles set role = 'admin' where id = $1 and role = 'superadmin'", [early]); // David is the one superadmin
  const signedUp = await one('select (select role from profiles where id = $1) as david, (select role from profiles where id = $2) as hello',
    [david, hello]);
  check('10. sign-up takes the role listed in admin_emails (superadmin here), else staff',
    signedUp.david === 'superadmin' && signedUp.hello === 'staff', signedUp);

  // 11. Board merge and owner → people -----------------------------------------------------------------------

  const groups = (await rows('select board_key, name, position from board_groups order by board_key, position'))
    .map((g) => `${g.board_key}:${g.name}:${g.position}`).join(',');
  const merged = await one(`select
    (select string_agg(distinct board_key, ',' order by board_key) from items where id = any($1::uuid[])) as keys,
    (select group_id from items where id = $2) as owned_group,
    (select name from board_groups where id = $3) as todo_name,
    (select count(*)::int from subtasks where item_id = $2) as subtasks`, [[owned, unowned, stale], owned, adminToDo]);
  const adminGroup = await error("insert into board_groups (board_key, name) values ('admin', 'Nope')");
  const adminItem = await error(`insert into items (board_key, group_id, name) values ('admin', $1, 'Nope')`, [adminToDo]);
  check('11. board merge: Admin groups and items move to Projects after its groups (seeded To do renamed Admin); admin is no longer a board',
    groups === 'marketing:This month:0,projects:Active:0,projects:Backlog:1,projects:Admin:2,projects:Later:3'
      && merged.keys === 'projects' && merged.owned_group === adminToDo && merged.todo_name === 'Admin' && merged.subtasks === 1
      && adminGroup !== null && adminItem !== null,
    { groups, merged, adminGroup, adminItem });

  const values = Object.fromEntries((await rows('select id, "values" as v from items where id = any($1::uuid[])',
    [[owned, unowned, stale, promo, bare, item]])).map((r) => [r.id, r.v]));
  const expected = {
    [owned]: { people: [alice], status: 'In progress' },
    [unowned]: { people: [], status: 'Not started' },
    [stale]: { people: [] },
    [promo]: { people: [boss], channel: 'LinkedIn' },
    [bare]: { people: [], status: 'Done' },
    [item]: { people: [] }, // phase 1 owner 'x' is not a user
  };
  const wrong = Object.entries(expected).filter(([id, v]) => stable(values[id]) !== stable(v)).map(([id, v]) => ({ want: v, got: values[id] }));
  const leftovers = (await one(`select count(*)::int as n from items
    where "values" ? 'owner' or jsonb_typeof("values" -> 'people') is distinct from 'array'`)).n;
  check('11. items.values: owner becomes people (user ids; empty when there was no owner or it is not a user)',
    !wrong.length && leftovers === 0, { wrong, leftovers });

  // 12. Module access ------------------------------------------------------------------------------------

  const levels = async (user) => {
    await as(user);
    return one(`select public.module_level('projects') as projects, public.module_level('marketing') as marketing,
      public.module_level('outreach') as outreach, public.module_level('pipeline') as pipeline, public.module_level('clients') as clients`);
  };
  const staffLevels = await levels(alice);
  const adminLevels = await levels(boss);
  const superLevels = await levels(david);
  const inactiveLevels = await levels(carol);
  const all = (o, level) => Object.values(o).every((l) => l === level);
  check('12. module_level: staff defaults (projects/marketing edit, outreach none, pipeline/clients view); admins edit all; inactive none',
    stable(staffLevels) === stable({ projects: 'edit', marketing: 'edit', outreach: 'none', pipeline: 'view', clients: 'view' })
      && all(adminLevels, 'edit') && all(superLevels, 'edit') && all(inactiveLevels, 'none'),
    { staffLevels, adminLevels, superLevels, inactiveLevels });

  await as(boss);
  const robin = (await one(`insert into contacts (name, org, email, status, owner_id)
    values ('Robin Example', 'Example Water', 'robin@example.com', 'Sent', $1) returning id`, [boss])).id;
  await db.query("insert into emails (kind, contact_id, contact, subject) values ('sent', $1, 'Robin Example', 'Hello')", [robin]);
  await db.query("insert into sequences (name, steps) values ('Intro', 3)");
  await db.query("insert into approvals (contact_id, contact, subject, by_id) values ($1, 'Robin Example', 'Draft', $2)", [robin, boss]);
  const outreach = `select (select count(*)::int from contacts) as contacts, (select count(*)::int from emails) as emails,
    (select count(*)::int from sequences) as sequences, (select count(*)::int from approvals) as approvals`;
  const adminSees = await one(outreach);

  await as(alice);
  const hidden = await one(outreach);
  const hiddenInsert = await error("insert into contacts (name) values ('Not yet')");
  check('12. staff cannot see or write outreach until granted',
    all(hidden, 0) && hiddenInsert !== null && all(adminSees, 1), { hidden, hiddenInsert, adminSees });

  const grant = "insert into module_access (user_id, module, level) values ($1, 'outreach', 'view')";
  await as(boss);
  const adminGrant = await error(grant, [alice]);
  await as(alice);
  const selfGrant = await error(grant, [alice]);
  await as(david);
  const superGrant = await error(grant, [alice]);
  check('12. only the superadmin grants module access', adminGrant !== null && selfGrant !== null && superGrant === null,
    { adminGrant, selfGrant, superGrant });

  await as(alice);
  const viewing = await one(outreach);
  const viewInsert = await error("insert into contacts (name) values ('Not yet')");
  const viewUpdate = await affected("update contacts set status = 'Opened' where id = $1", [robin]);
  const viewDelete = await affected('delete from emails');
  check('12. with view, staff read outreach but cannot write it',
    all(viewing, 1) && viewInsert !== null && viewUpdate === 0 && viewDelete === 0, { viewing, viewInsert, viewUpdate, viewDelete });

  await as(david);
  const upgrade = await affected("update module_access set level = 'edit' where user_id = $1 and module = 'outreach'", [alice]);
  await as(alice);
  const editInsert = await error("insert into contacts (name, org, status) values ('Lee Example', 'Example Shire', 'New')");
  check('12. with edit, staff write outreach', upgrade === 1 && editInsert === null, { upgrade, editInsert });

  await as(david);
  await db.query("insert into module_access (user_id, module, level) values ($1, 'marketing', 'view'), ($1, 'projects', 'none')", [hello]);
  await as(alice);
  const ownAccess = await rows('select user_id from module_access');
  await as(boss);
  const allAccess = (await one('select count(*)::int as n from module_access')).n;
  const adminChange = await affected("update module_access set level = 'edit' where user_id = $1", [hello]);
  const adminRemove = await affected('delete from module_access where user_id = $1', [hello]);
  check('12. staff read only their own overrides; admins read all but cannot change them',
    ownAccess.length === 1 && ownAccess[0].user_id === alice && allAccess === 3 && adminChange === 0 && adminRemove === 0,
    { ownAccess, allAccess, adminChange, adminRemove });

  // 13. Boards follow their module ------------------------------------------------------------------------

  await as(hello); // projects none, marketing view
  const helloBoards = await one(`select
    (select count(*)::int from board_groups where board_key = 'projects') as project_groups,
    (select count(*)::int from items where board_key = 'projects') as project_items,
    (select count(*)::int from subtasks where item_id = $1) as project_subtasks,
    (select count(*)::int from items where id = $2) as marketing_item`, [owned, promo]);
  const viewItem = await error("insert into items (board_key, group_id, name) values ('marketing', $1, 'Nope')", [marketingGroup]);
  const viewRename = await affected("update items set name = 'Renamed' where id = $1", [promo]);
  const viewSubtask = await error("insert into subtasks (item_id, text) values ($1, 'Nope')", [promo]);
  const viewComment = await error("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Nope')", [promo, hello]);
  check('13. boards follow their module: none hides Projects (groups, items, subtasks); view reads Marketing but cannot write it',
    helloBoards.project_groups === 0 && helloBoards.project_items === 0 && helloBoards.project_subtasks === 0
      && helloBoards.marketing_item === 1 && viewItem !== null && viewRename === 0 && viewSubtask !== null && viewComment !== null,
    { helloBoards, viewItem, viewRename, viewSubtask, viewComment });

  await as(alice); // defaults: edit both
  const staffItem = (await one(`insert into items (board_key, group_id, name, "values") values ('projects', $1, 'Plan launch', $2)
    returning id`, [projectsActive, { people: [alice] }])).id;
  const staffSubtask = await error("insert into subtasks (item_id, text) values ($1, 'Draft')", [staffItem]);
  const staffComment = await error("insert into item_updates (item_id, user_id, text) values ($1, $2, '@Hello can you help?')", [staffItem, alice]);
  const forgedComment = await error("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Not me')", [staffItem, boss]);
  const marketingEdit = await affected("update items set name = 'Golf day posts' where id = $1", [promo]);
  check('13. by default staff edit Projects and Marketing items and subtasks, and post updates as themselves',
    staffSubtask === null && staffComment === null && forgedComment !== null && marketingEdit === 1,
    { staffSubtask, staffComment, forgedComment, marketingEdit });

  // An item's board is its group's: a board you edit can't carry an item into a group on a board you only view.
  const boardBound = async (editable, viewOnly, editGroup, viewGroup) => {
    await as(david);
    await db.query(`insert into module_access (user_id, module, level) values ($1, $2, 'edit'), ($1, $3, 'view')
      on conflict (user_id, module) do update set level = excluded.level`, [hello, editable, viewOnly]);
    await as(hello);
    const own = (await one('insert into items (board_key, group_id, name) values ($1, $2, $3) returning id', [editable, editGroup, 'Mine'])).id;
    return {
      own: Boolean(own),
      smuggled: await error('insert into items (board_key, group_id, name) values ($1, $2, $3)', [editable, viewGroup, 'Smuggled']),
      moved: await affected('update items set group_id = $2 where id = $1', [own, viewGroup]),
      stayed: (await one('select group_id from items where id = $1', [own])).group_id === editGroup,
    };
  };
  const intoMarketing = await boardBound('projects', 'marketing', projectsActive, marketingGroup);
  const intoProjects = await boardBound('marketing', 'projects', marketingGroup, projectsActive);
  await as(david);
  await db.query("update module_access set level = 'view' where user_id = $1 and module = 'marketing'", [hello]);
  await db.query("update module_access set level = 'none' where user_id = $1 and module = 'projects'", [hello]);
  const bound = (r) => r.own && typeof r.smuggled === 'string' && typeof r.moved === 'string' && r.stayed;
  check("13. an item's board is its group's: editing one board never files an item under a group on a board you only view",
    bound(intoMarketing) && bound(intoProjects), { intoMarketing, intoProjects });

  // 14. Pipeline -----------------------------------------------------------------------------------------

  await as(boss);
  const bossDeal = (await one("insert into deals (name, stage, owner_id) values ('Example Port', 'Opportunities', $1) returning id", [boss])).id;
  await as(alice);
  const dealSeen = (await one('select count(*)::int as n from deals where id = $1', [bossDeal])).n;
  const dealInsert = await error("insert into deals (name) values ('Nope')");
  const dealUpdate = await affected("update deals set stage = 'Won' where id = $1", [bossDeal]);
  const dealDelete = await affected('delete from deals where id = $1', [bossDeal]);
  check('14. the pipeline is view-only for staff', dealSeen === 1 && dealInsert !== null && dealUpdate === 0 && dealDelete === 0,
    { dealSeen, dealInsert, dealUpdate, dealDelete });

  // 15. contact_pipeline -----------------------------------------------------------------------------------

  await as(alice); // outreach edit, pipeline view
  const lastDeal = (await one('select max(position)::int as p from deals')).p;
  await db.query("update contacts set status = 'Replied' where id = $1", [robin]);
  const created = await rows('select name, stage, owner_id, priority, next_step, position from deals where contact_id = $1', [robin]);
  await as(boss);
  const followUp = await rows(`select title, category, source, assignee_id, day = public.team_today() as today from todos where ref = $1`,
    [`contact:${robin}`]);
  check('15. contact_pipeline: Replied creates a P2 deal at the end of Opportunities (even when the editor only views the pipeline)',
    created.length === 1 && created[0].name === 'Example Water' && created[0].stage === 'Opportunities' && created[0].owner_id === boss
      && created[0].priority === 'P2' && created[0].next_step === 'Reply to Robin Example' && created[0].position === lastDeal + 1,
    { created, lastDeal });
  check("15. ...and today's follow-up to-do for the contact's owner",
    followUp.length === 1 && followUp[0].title === 'Follow up: Robin Example replied' && followUp[0].category === 'Outreach'
      && followUp[0].source === 'automation' && followUp[0].assignee_id === boss && followUp[0].today === true,
    followUp);

  // Sessions run in UTC (Supabase) or anywhere else; the automations' "today" is the team's day in Perth either way.
  const teamDay = [];
  for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    await db.exec(`set timezone = '${zone}'`);
    teamDay.push(await one(`select public.team_today()::text as day, (now() at time zone 'Australia/Perth')::date::text as perth`));
  }
  await db.exec('reset timezone');
  check("15. the automations' day is the team's (Australia/Perth), whatever the session's time zone",
    teamDay.every((r) => r.day === r.perth), teamDay);

  await as(alice);
  // What the sync engine sends when something else on the contact changes: the same status again.
  const resend = await postgrestUpsert('contacts', [{
    id: robin, name: 'Robin Example', org: 'Example Water', email: 'robin@example.com', status: 'Replied', owner_id: boss,
  }]);
  await db.query("update contacts set status = 'Meeting booked' where id = $1", [robin]);
  const advanced = await rows('select stage from deals where contact_id = $1', [robin]);
  await as(boss);
  const followUps = (await one('select count(*)::int as n from todos where ref = $1', [`contact:${robin}`])).n;
  check('15. re-saving the status changes nothing; Meeting booked moves the deal to First meetings (one deal, one to-do a day)',
    resend === null && advanced.length === 1 && advanced[0].stage === 'First meetings' && followUps === 1,
    { resend, advanced, followUps });

  await as(alice);
  const sam = (await one("insert into contacts (name, status) values ('Sam Example', 'Meeting booked') returning id")).id;
  const samDeal = await one('select name, stage, owner_id, next_step from deals where contact_id = $1', [sam]);
  const samTodo = await one('select title, assignee_id from todos where ref = $1', [`contact:${sam}`]);
  check('15. a new contact at Meeting booked (no owner, no org) gets a First meetings deal and to-do for whoever saved it',
    samDeal?.name === 'Sam Example' && samDeal.stage === 'First meetings' && samDeal.owner_id === alice
      && samDeal.next_step === 'Prepare meeting with Sam Example' && samTodo?.title === 'Prepare: meeting with Sam Example'
      && samTodo.assignee_id === alice,
    { samDeal, samTodo });

  const kim = (await one("insert into contacts (name, org, status) values ('Kim Example', 'Example Rail', 'Replied') returning id")).id;
  await as(boss);
  await db.query("update deals set stage = 'Demos' where contact_id = $1", [kim]);
  await as(alice);
  await db.query("update contacts set status = 'Meeting booked' where id = $1", [kim]);
  const kimDeals = await rows('select stage from deals where contact_id = $1', [kim]);
  const jo = (await one("insert into contacts (name, status) values ('Jo Example', 'Opened') returning id")).id;
  const joDeals = (await one('select count(*)::int as n from deals where contact_id = $1', [jo])).n;
  check('15. a deal already past Opportunities stays put; other statuses make no deal',
    kimDeals.length === 1 && kimDeals[0].stage === 'Demos' && joDeals === 0, { kimDeals, joDeals });

  await as(david);
  const revoke = await affected("delete from module_access where user_id = $1 and module = 'outreach'", [alice]);
  await as(alice);
  const revoked = await one(outreach);
  check('15. removing the override hides outreach from staff again', revoke === 1 && all(revoked, 0), { revoke, revoked });

  // 16. ensure_todos ---------------------------------------------------------------------------------------

  await as(boss);
  const routine = async (assignee, title, weekdays, start, active = true) => (await one(`insert into routines
    (title, category, minutes, assignee_id, weekdays, start_time, active) values ($1, 'LinkedIn', 20, $2, $3::int[], $4::time, $5)
    returning id`, [title, assignee, weekdays, start, active])).id;
  const daily = await routine(alice, 'LinkedIn engagement', '{1,2,3,4,5}', '09:00');
  const weekly = await routine(alice, 'Weekly report', '{1}', null);
  await routine(alice, 'Paused routine', '{1,2,3,4,5}', null, false);
  await routine(hello, 'Inbox zero', '{1,2,3,4,5}', '08:30');

  await as(alice);
  const staffRoutine = await error("insert into routines (title, assignee_id) values ('Mine', $1)", [alice]);
  const routinesSeen = (await one('select count(*)::int as n from routines')).n;
  const days = await one(`select extract(isodow from date '2026-10-05')::int as mon, extract(isodow from date '2026-10-10')::int as sat`);
  const ensure = (day) => attempt('select public.ensure_todos($1::date) as n', [day]).then((r) => (typeof r === 'string' ? r : r.n));
  const monday = await ensure('2026-10-05');
  const mondayAgain = await ensure('2026-10-05');
  // A routine added later that day: only its to-do is added, next in the day after the ones already there.
  await as(boss);
  await routine(alice, 'Wrap-up', '{1}', '23:00');
  await as(alice);
  const lateAdded = await ensure('2026-10-05');
  const tuesday = await ensure('2026-10-06');
  const saturday = await ensure('2026-10-10');
  const routineTodos = await rows(`select title, category, minutes, to_char(start_time, 'HH24:MI') as start, source, routine_id,
    created_by, assignee_id, day::text as day from todos where source = 'routine' order by day, title`);
  check("16. ensure_todos adds the caller's active routines for that weekday, once (re-runs add nothing); only admins write routines",
    days.mon === 1 && days.sat === 6 && monday === 2 && mondayAgain === 0 && tuesday === 1 && saturday === 0
      && staffRoutine !== null && routinesSeen === 4 && routineTodos.length === 4 && lateAdded === 1,
    { days, monday, mondayAgain, lateAdded, tuesday, saturday, staffRoutine, routinesSeen, routineTodos });
  const [first1, second1] = routineTodos;
  check('16. ...copying title, category, minutes and time from the routine',
    first1?.title === 'LinkedIn engagement' && first1.category === 'LinkedIn' && first1.minutes === 20 && first1.start === '09:00'
      && first1.routine_id === daily && first1.created_by === alice && first1.assignee_id === alice && first1.day === '2026-10-05'
      && second1?.routine_id === weekly && second1.start === null,
    routineTodos);

  await as(hello);
  const helloMonday = await ensure('2026-10-05');
  const helloBank = (await one("select count(*)::int as n from todos where ref like 'bank:%'")).n;
  await as(boss);
  const bossMonday = await ensure('2026-10-05');
  const bossAgain = await ensure('2026-10-05');
  const bank = await one("select title, category, source, assignee_id from todos where ref = 'bank:2026-10-05'");
  await db.query("insert into bank_statements (week_start, file_path) values ('2026-10-12', $1)", [`statements/${uid()}-week-42.png`]);
  const covered = await ensure('2026-10-12');
  const bossTuesday = await ensure('2026-10-06');
  await as(carol);
  const inactiveEnsure = await ensure('2026-10-05');
  check("16. Mondays give admins \"Upload this week's bank screenshot\" until that week's statement exists; never staff",
    helloMonday === 1 && helloBank === 0 && bossMonday === 1 && bossAgain === 0 && bank?.title === "Upload this week's bank screenshot"
      && bank.category === 'Admin' && bank.source === 'automation' && bank.assignee_id === boss && covered === 0 && bossTuesday === 0,
    { helloMonday, helloBank, bossMonday, bossAgain, bank, covered, bossTuesday });
  check('16. inactive accounts cannot call ensure_todos', typeof inactiveEnsure === 'string', inactiveEnsure);

  // schema.js numbers to-dos within each person's day; rows the database adds follow the same rule, so clients
  // don't rewrite them. So far every to-do came from ensure_todos or contact_pipeline.
  await as(null);
  const dayPositions = await rows(`select assignee_id, day::text as day, string_agg(position::text, ',' order by position) as positions,
    count(*)::int as n from todos group by assignee_id, day`);
  const gaps = dayPositions.filter((g) => g.positions !== Array.from({ length: g.n }, (_, i) => i).join(','));
  check("16. generated to-dos take the next position in that person's day (0, 1, 2… with no gaps)",
    dayPositions.length >= 5 && gaps.length === 0, { dayPositions, gaps });

  // A routine runs once per person and day: its to-do, deleted or moved to another day, doesn't come back.
  await as(alice);
  const dropped = await affected("delete from todos where routine_id = $1 and day = '2026-10-05'", [daily]);
  const moved = await affected("update todos set day = '2026-10-07' where routine_id = $1 and day = '2026-10-06'", [daily]);
  const afterDelete = await ensure('2026-10-05');
  const afterMove = await ensure('2026-10-06');
  const left = await one(`select (select count(*)::int from todos where routine_id = $1 and day = '2026-10-05') as deleted_day,
    (select count(*)::int from todos where routine_id = $1 and day = '2026-10-06') as moved_day`, [daily]);
  const runsRead = await error('select * from public.routine_runs');
  const runsWrite = await error("insert into public.routine_runs (routine_id, assignee_id, day) values ($1, $2, '2026-10-08')", [daily, alice]);
  check("16. a routine to-do deleted or moved away isn't made again that day; the run log is ensure_todos' own",
    dropped === 1 && moved === 1 && afterDelete === 0 && afterMove === 0 && left.deleted_day === 0 && left.moved_day === 0
      && runsRead !== null && runsWrite !== null,
    { dropped, moved, afterDelete, afterMove, left, runsRead, runsWrite });

  // 17. Staff view clients but never approve, mark paid or see money -------------------------------------------

  await as(boss);
  await db.query("insert into client_usage (client_id, month, assets, sites, seats) values ($1, '2026-09-01', 1200, 4, 9)", [client]);
  const bossNote = (await one("insert into client_notes (client_id, user_id, text) values ($1, $2, 'Renewal due') returning id", [client, boss])).id;
  await as(alice); // clients: view
  const clientsView = await one(`select (select count(*)::int from invoices where id = $1) as invoices,
    (select count(*)::int from client_usage where client_id = $2) as usage, (select count(*)::int from client_notes where id = $3) as notes`,
  [invoice, client, bossNote]);
  const viewEdit = await affected("update invoices set due = '2026-11-30' where id = $1", [invoice]);
  const viewNew = await error("insert into invoices (client_id, number, status) values ($1, 'INV-9100', 'Draft')", [client]);
  const viewNote = await error("insert into client_notes (client_id, user_id, text) values ($1, $2, 'Hi')", [client, alice]);
  const viewPlan = await error("insert into billing_plans (client_id, description) values ($1, 'Nope')", [client]);
  const viewUsage = await error("insert into client_usage (client_id, month) values ($1, '2026-10-01')", [client]);
  check('17. staff view clients, invoices, notes and usage but cannot write them by default',
    all(clientsView, 1) && viewEdit === 0 && viewNew !== null && viewNote !== null && viewPlan !== null && viewUsage !== null,
    { clientsView, viewEdit, viewNew, viewNote, viewPlan, viewUsage });

  await as(boss);
  const statement = await one(`insert into bank_statements (week_start, file_path, note) values ('2026-10-05', $1, 'Week 41')
    returning id, uploaded_by`, [`statements/${uid()}-week-41.png`]);
  const payment = await error(`insert into payments (invoice_id, client_id, amount, received_on, reference, statement_id)
    values ($1, $2, 1100, '2026-10-09', 'EFT', $3)`, [invoice, client, statement.id]);
  const expense = await error(`insert into expenses ("date", vendor, category, amount, gst, client_id, receipt_path)
    values ('2026-10-03', 'Example Hosting', 'Software', 110, 10, $1, $2)`, [client, `receipts/${uid()}-receipt.pdf`]);
  const software = await error(`insert into subscriptions (name, vendor, category, amount, cycle, renews_on)
    values ('Example Suite', 'Example Co', 'Software', 29.99, 'monthly', '2026-11-01')`);
  check('17. admins record bank statements, payments, expenses and software costs',
    statement.uploaded_by === boss && payment === null && expense === null && software === null, { statement, payment, expense, software });

  await as(david);
  await db.query("insert into module_access (user_id, module, level) values ($1, 'clients', 'edit')", [alice]);
  await as(alice); // clients: edit
  const finance = await one(`select (select count(*)::int from bank_statements) as statements, (select count(*)::int from payments) as payments,
    (select count(*)::int from expenses) as expenses, (select count(*)::int from subscriptions) as subscriptions`);
  const staffMoney = [
    await error("insert into bank_statements (week_start) values ('2026-10-19')"),
    await error('insert into payments (client_id, amount) values ($1, 1)', [client]),
    await error("insert into expenses (vendor, amount) values ('Nope', 1)"),
    await error("insert into subscriptions (name) values ('Nope')"),
  ];
  check('17. money in, expenses and software costs stay admin-only, even for staff with clients edit',
    all(finance, 0) && staffMoney.every((e) => e !== null), { finance, staffMoney });

  const statusTo = (status) => affected('update invoices set status = $2 where id = $1', [invoice, status]);
  const editDue = await affected("update invoices set due = '2026-11-30' where id = $1", [invoice]);
  const locked = {
    approve: await statusTo('Approved'),
    send: await statusTo('Sent'),
    pay: await statusTo('Paid'),
    void: await statusTo('Void'),
    paidOn: await affected("update invoices set paid_on = '2026-10-10' where id = $1", [invoice]),
    newPaid: await error("insert into invoices (client_id, number, status) values ($1, 'INV-9101', 'Paid')", [client]),
    newPaidOn: await error("insert into invoices (client_id, number, status, paid_on) values ($1, 'INV-9103', 'Draft', '2026-10-10')", [client]),
  };
  const overdue = await statusTo('Overdue');
  const newDraft = await error("insert into invoices (client_id, number, status) values ($1, 'INV-9102', 'Draft')", [client]);
  check('17. staff with clients edit edit invoices but never approve, send, void, mark paid or set paid_on',
    editDue === 1 && Object.values(locked).every((r) => typeof r === 'string') && overdue === 1 && newDraft === null,
    { editDue, locked, overdue, newDraft });

  const ownNote = await error("insert into client_notes (client_id, user_id, text) values ($1, $2, 'Called them')", [client, alice]);
  const forgedNote = await error("insert into client_notes (client_id, user_id, text) values ($1, $2, 'Not me')", [client, boss]);
  const othersNote = await affected("update client_notes set text = 'Changed' where id = $1", [bossNote]);
  check("17. client notes keep their own-row rules inside the clients module", ownNote === null && forgedNote !== null && othersNote === 0,
    { ownNote, forgedNote, othersNote });

  await as(boss);
  const bossApprove = await affected("update invoices set status = 'Approved', sent_at = now() where id = $1", [invoice]);
  const bossPaid = await affected("update invoices set status = 'Paid', paid_on = '2026-10-10' where id = $1", [invoice]);
  await as(alice);
  const paidRow = { id: invoice, client_id: client, number: 'INV-9001', issued: '2026-10-01', due: '2026-12-31', status: 'Paid', paid_on: '2026-10-10' };
  const resave = await postgrestUpsert('invoices', [paidRow]);
  const unpay = await postgrestUpsert('invoices', [{ ...paidRow, paid_on: null }]);
  const draft = (await one("select id from invoices where number = 'INV-9102'")).id;
  const sneak = await postgrestUpsert('invoices', [{ id: draft, client_id: client, number: 'INV-9102', status: 'Paid' }]);
  const final = await one('select status, paid_on::text as paid_on, due::text as due from invoices where id = $1', [invoice]);
  check('17. admins approve and mark paid; staff re-saving a paid invoice as the sync engine does is fine, changing its status is not',
    bossApprove === 1 && bossPaid === 1 && resave === null && unpay !== null && sneak !== null
      && final.status === 'Paid' && final.paid_on === '2026-10-10' && final.due === '2026-12-31',
    { bossApprove, bossPaid, resave, unpay, sneak, final });

  // The insert check runs after the insert, for rows really inserted, with nothing to skip it: a row deleted just
  // before (or by a delete still committing) and upserted again Paid is a new row and is refused.
  const draftRow = { id: draft, client_id: client, number: 'INV-9102', status: 'Draft' };
  const draftResave = await postgrestUpsert('invoices', [{ ...draftRow, due: '2026-12-01' }]);
  await db.query('delete from invoices where id = $1', [draft]);
  const reinserted = await postgrestUpsert('invoices', [{ ...draftRow, status: 'Paid' }]);
  const gone = (await one('select count(*)::int as n from invoices where id = $1', [draft])).n;
  await as(null);
  const triggers = await rows(`select t.tgname, (t.tgtype & 2) <> 0 as before, (t.tgtype & 4) <> 0 as on_insert,
      (t.tgtype & 16) <> 0 as on_update
    from pg_trigger t where t.tgrelid = 'public.invoices'::regclass and t.tgfoid = 'public.protect_invoice_status'::regproc
    order by t.tgname`);
  check('17. ...a staff insert is checked after it happens (never skipped for an id that exists); upserts of existing rows by the update check',
    draftResave === null && reinserted !== null && gone === 0
      && stable(triggers) === stable([
        { tgname: 'protect_invoice_insert', before: false, on_insert: true, on_update: false },
        { tgname: 'protect_invoice_status', before: true, on_insert: false, on_update: true },
      ]),
    { draftResave, reinserted, gone, triggers });

  // 18. generate_due_invoices --------------------------------------------------------------------------------

  await as(boss);
  await db.query("update org_settings set invoice_prefix = 'TST-' where id = 1");
  const billed = (await one("insert into clients (name) values ('Example Utility') returning id")).id;
  await db.query("insert into invoices (client_id, number, status, position) values ($1, 'TST-0042', 'Paid', 0), ($1, 'TST-77B', 'Draft', 1)", [billed]);
  const plan = async (description, amount, frequency, nextDate, active = true) => (await one(`insert into billing_plans
    (client_id, description, amount, frequency, next_date, active) values ($1, $2, $3, $4, ${nextDate}, $5) returning id`,
  [billed, description, amount, frequency, active])).id;
  // Due means on or before the team's day (team_today(), Perth), which isn't always the session's UTC date.
  const monthly = await plan('Platform licence', 1500.5, 'monthly', "(public.team_today() - interval '2 months')::date");
  const quarterly = await plan('Support', 1200, 'quarterly', "(public.team_today() - interval '7 months')::date");
  const annual = await plan('Hosting', 9000, 'annually', 'public.team_today()');
  const future = await plan('Not due yet', 50, 'monthly', 'public.team_today() + 1');
  const paused = await plan('Paused', 75, 'monthly', "(public.team_today() - interval '1 month')::date", false);
  const undated = await plan('No date', 80, 'monthly', 'null');
  const startDates = Object.fromEntries((await rows('select id, next_date::text as d from billing_plans where client_id = $1', [billed]))
    .map((r) => [r.id, r.d]));

  await as(alice);
  const staffRun = await attempt('select public.generate_due_invoices() as n');
  await as(boss);
  const run = await attempt('select public.generate_due_invoices() as n');
  const rerun = await attempt('select public.generate_due_invoices() as n');
  const generated = await rows(`select i.number, i.plan_id, i.issued::text as issued, i.due - i.issued as terms, i.status, i.position,
      (select count(*)::int from invoice_lines x where x.invoice_id = i.id) as lines, l.description, l.qty, l.rate
    from invoices i join invoice_lines l on l.invoice_id = i.id
    where i.client_id = $1 and i.plan_id is not null order by i.number`, [billed]);
  const nextDates = Object.fromEntries((await rows('select id, next_date::text as d from billing_plans where client_id = $1', [billed]))
    .map((r) => [r.id, r.d]));
  const want = await one(`select ($1::date + interval '3 months')::date::text as monthly, ($2::date + interval '9 months')::date::text as quarterly,
    ($3::date + interval '12 months')::date::text as annual, public.team_today()::text as today`,
  [startDates[monthly], startDates[quarterly], startDates[annual]]);
  const terms = (await one('select payment_terms_days as t from org_settings where id = 1')).t;
  const forPlan = (id) => generated.filter((r) => r.plan_id === id);
  const numbers = (id) => forPlan(id).map((r) => r.number).join(',');
  const rising = (list) => list.every((r, i) => i === 0 || r.issued > list[i - 1].issued);
  check('18. generate_due_invoices is admins only', typeof staffRun === 'string', staffRun);
  check('18. it catches up every missed period of each active plan, numbered on from the prefix (from 1001), and only once',
    run?.n === 7 && rerun?.n === 0
      && generated.map((r) => r.number).join(',') === 'TST-1001,TST-1002,TST-1003,TST-1004,TST-1005,TST-1006,TST-1007'
      && numbers(quarterly) === 'TST-1001,TST-1002,TST-1003' && numbers(monthly) === 'TST-1004,TST-1005,TST-1006'
      && numbers(annual) === 'TST-1007' && [quarterly, monthly, annual].every((id) => rising(forPlan(id)))
      && forPlan(quarterly)[0]?.issued === startDates[quarterly] && forPlan(annual)[0]?.issued === want.today,
    { run, rerun, generated: generated.map((r) => `${r.number} ${r.issued}`) });
  check('18. ...each Awaiting approval with one line (description, qty 1, rate = amount), due after the payment terms, on top of the list',
    generated.every((r) => r.status === 'Awaiting approval' && r.lines === 1 && r.qty === '1' && r.terms === terms)
      && forPlan(monthly).every((r) => r.description === 'Platform licence' && r.rate === '1500.5')
      && forPlan(quarterly).every((r) => r.rate === '1200') && forPlan(annual).every((r) => r.rate === '9000')
      && generated.map((r) => r.position).join(',') === '2,3,4,5,6,7,8',
    generated);
  check('18. ...and moves each next date on by whole periods into the future; other plans are left alone',
    nextDates[monthly] === want.monthly && nextDates[quarterly] === want.quarterly && nextDates[annual] === want.annual
      && nextDates[future] === startDates[future] && nextDates[paused] === startDates[paused] && nextDates[undated] === null,
    { nextDates, want, startDates });

  // A plan on the 31st, far enough back that a short month is followed by a 31-day one before today.
  const anchor = (await one(`select max(d)::date::text as d from generate_series(public.team_today() - interval '16 months',
    public.team_today() - interval '5 months', interval '1 day') d where extract(day from d) = 31`)).d;
  const monthEnd = await plan('Month-end retainer', 100, 'monthly', `'${anchor}'::date`);
  const catchUp = await attempt('select public.generate_due_invoices() as n');
  const monthEndRows = await rows('select number, issued::text as issued from invoices where plan_id = $1 order by issued', [monthEnd]);
  const issued = monthEndRows.map((r) => r.issued);
  const backOn31st = issued.some((d, i) => i > 0 && d.endsWith('-31') && !issued[i - 1].endsWith('-31'));
  const consecutive = monthEndRows.every((r, i) => r.number === `TST-${1008 + i}`);
  check('18. a plan on the 31st bills on the last day of shorter months and is back on the 31st after them (no drift)',
    catchUp?.n === issued.length && issued.length >= 5 && issued[0] === anchor && backOn31st && consecutive,
    { anchor, catchUp, monthEndRows });

  // Billed one period at a time (each run moves next_date to a shorter month's last day), it still keeps its day: the
  // plan as a run on its 30 Sep would leave it, then the next run.
  const shortEnd = (await one(`select max(d)::date::text as d from generate_series(public.team_today() - interval '16 months',
    public.team_today() - interval '2 months', interval '1 day') d
    where extract(day from d) = 30 and extract(day from d + interval '1 day') = 1`)).d; // a 30-day month's end (the next has 31)
  const monthEnd2 = (await one(`insert into billing_plans (client_id, description, amount, frequency, next_date, anchor_day)
    values ($1, 'Month-end support', 50, 'monthly', $2, 31) returning id`, [billed, shortEnd])).id;
  const perRun = await attempt('select public.generate_due_invoices() as n');
  const perRunIssued = (await rows('select issued::text as d from invoices where plan_id = $1 order by issued', [monthEnd2])).map((r) => r.d);
  const plan31 = await one('select anchor_day, next_date::text as next from billing_plans where id = $1', [monthEnd2]);
  const filled = await one('select anchor_day from billing_plans where id = $1', [monthly]);
  check("18. ...also when billed one period per run: the plan's billing day (anchor_day) is kept, not the shorter month's",
    perRun?.n === perRunIssued.length && perRunIssued[0] === shortEnd && perRunIssued[1]?.endsWith('-31')
      && plan31.anchor_day === 31 && filled.anchor_day === Number(startDates[monthly].slice(8, 10)),
    { shortEnd, perRun, perRunIssued, plan31, filled });

  // A slow client's full-row save can put back the next_date a run just moved on: the period isn't billed twice.
  const beforeStale = await one('select next_date::text as next, (select count(*)::int from invoices where plan_id = $1) as n from billing_plans where id = $1',
    [monthly]);
  await postgrestUpsert('billing_plans', [{
    id: monthly, client_id: billed, description: 'Platform licence', amount: 1500.5, frequency: 'monthly', next_date: startDates[monthly],
    anchor_day: Number(startDates[monthly].slice(8, 10)), active: true, position: 0,
  }]);
  const rerunStale = await attempt('select public.generate_due_invoices() as n');
  const afterStale = await one('select next_date::text as next, (select count(*)::int from invoices where plan_id = $1) as n from billing_plans where id = $1',
    [monthly]);
  check('18. a period already invoiced is never billed again, even when an old next_date is saved back',
    rerunStale?.n === 0 && afterStale.n === beforeStale.n && afterStale.next === beforeStale.next, { beforeStale, rerunStale, afterStale });

  // A mistyped year (0026) would mean hundreds of invoices: a plan over two years behind is left as it is.
  const typo = (await one(`insert into billing_plans (client_id, description, amount, frequency, next_date)
    values ($1, 'Typo', 10, 'monthly', '0026-07-01') returning id`, [billed])).id;
  const twoYears = await plan('Two years behind', 10, 'quarterly', "(public.team_today() - interval '2 years')::date");
  const bounded = await attempt('select public.generate_due_invoices() as n');
  const typoRow = await one(`select next_date::text as next, (select count(*)::int from invoices where plan_id = $1) as n
    from billing_plans where id = $1`, [typo]);
  const twoYearsN = (await one('select count(*)::int as n from invoices where plan_id = $1', [twoYears])).n;
  check('18. a plan more than two years behind (a mistyped year) makes no invoices and is left alone; two years still catches up',
    bounded?.n === 9 && typoRow.next === '0026-07-01' && typoRow.n === 0 && twoYearsN === 9, { bounded, typoRow, twoYearsN });
  await db.query("update org_settings set invoice_prefix = 'INV-' where id = 1");

  // 19. To-dos and time entries are private -------------------------------------------------------------------

  await as(boss);
  const assigned = await one(`insert into todos (assignee_id, title, day, category) values ($1, 'Call the council', '2026-10-12', 'Clients')
    returning id, created_by`, [alice]);
  await as(alice);
  const othersTodos = (await one('select count(*)::int as n from todos where assignee_id <> $1', [alice])).n;
  const seesAssigned = (await one('select count(*)::int as n from todos where id = $1', [assigned.id])).n;
  const forHello = await error("insert into todos (assignee_id, title, day) values ($1, 'For you', '2026-10-12')", [hello]);
  const own = await one("insert into todos (assignee_id, created_by, title, day) values ($1, $2, 'Write proposal', '2026-10-12') returning id, created_by",
    [alice, boss]);
  const tick = await affected('update todos set done = true, done_at = now() where id = $1', [assigned.id]);
  const handOff = await affected('update todos set assignee_id = $2 where id = $1', [assigned.id, hello]);
  const claim = await affected('update todos set created_by = $2 where id = $1', [assigned.id, alice]);
  const deleteAssigned = await affected('delete from todos where id = $1', [assigned.id]);
  const deleteOwn = await affected('delete from todos where id = $1', [own.id]);
  await as(hello);
  const helloSees = (await one('select count(*)::int as n from todos where assignee_id = $1', [alice])).n;
  await as(boss);
  const bossSees = await one('select done, created_by, assignee_id from todos where id = $1', [assigned.id]);
  check("19. to-dos: staff see and tick off only their own; admins see and add to everyone's",
    othersTodos === 0 && seesAssigned === 1 && forHello !== null && tick === 1 && helloSees === 0 && bossSees?.done === true
      && assigned.created_by === boss,
    { othersTodos, seesAssigned, forHello, tick, helloSees, bossSees });
  check('19. ...staff cannot hand off, claim or delete work an admin assigned, but can delete their own (created_by is never forged)',
    typeof handOff === 'string' && claim === 1 && bossSees?.created_by === boss && bossSees.assignee_id === alice
      && deleteAssigned === 0 && deleteOwn === 1 && own.created_by === alice,
    { handOff, claim, bossSees, deleteAssigned, deleteOwn, own });

  await as(alice);
  const entry = (await one(`insert into time_entries (user_id, day, start_time, minutes, category, note)
    values ($1, '2026-10-12', '09:00', 60, 'Projects', 'Plan') returning id`, [alice])).id;
  const entryForHello = await error("insert into time_entries (user_id, day) values ($1, '2026-10-12')", [hello]);
  await as(hello);
  await db.query(`insert into time_entries (user_id, day, start_time, category, source)
    values ($1, '2026-10-12', '10:00', 'Email marketing', 'suggested')`, [hello]);
  const helloEntries = await rows('select user_id from time_entries');
  const helloEdits = await affected("update time_entries set note = 'Mine now' where id = $1", [entry]);
  await as(boss);
  const bossEntries = (await one('select count(*)::int as n from time_entries')).n;
  const bossEdit = await affected("update time_entries set note = 'Edited' where id = $1", [entry]);
  const bossDelete = await affected('delete from time_entries where id = $1', [entry]);
  const bossFor = await error("insert into time_entries (user_id, day) values ($1, '2026-10-12')", [alice]);
  check("19. time entries: everyone writes only their own; admins read everyone's",
    entryForHello !== null && helloEntries.length === 1 && helloEntries[0].user_id === hello && helloEdits === 0
      && bossEntries === 2 && bossEdit === 0 && bossDelete === 0 && bossFor !== null,
    { entryForHello, helloEntries, helloEdits, bossEntries, bossEdit, bossDelete, bossFor });

  // 20. Only the superadmin changes roles, active and email; the last one stays ------------------------------

  await as(boss);
  await db.query(`update profiles set role = 'admin', active = false, email = 'x@assetstackai.com', name = 'Alice Renamed'
    where id = $1`, [alice]);
  const byAdmin = await one('select role, active, email, name from profiles where id = $1', [alice]);
  await db.query("update profiles set role = 'superadmin' where id = $1", [boss]);
  const bossSelf = (await one('select role from profiles where id = $1', [boss])).role;
  await as(alice);
  await db.query("update profiles set role = 'superadmin' where id = $1", [alice]);
  const bySelf = (await one('select role from profiles where id = $1', [alice])).role;
  await as(david);
  await db.query("update profiles set role = 'admin' where id = $1", [alice]);
  const promoted = (await one('select role from profiles where id = $1', [alice])).role;
  await db.query("update profiles set role = 'staff', name = 'Alice Example' where id = $1", [alice]);
  await db.query('update profiles set active = false where id = $1', [hello]);
  const deactivated = (await one('select active from profiles where id = $1', [hello])).active;
  await db.query('update profiles set active = true where id = $1', [hello]);
  check('20. only the superadmin changes role, active or email (admins still edit names; nobody promotes themselves)',
    byAdmin.role === 'staff' && byAdmin.active === true && byAdmin.email === 'alice@assetstackai.com' && byAdmin.name === 'Alice Renamed'
      && bossSelf === 'admin' && bySelf === 'staff' && promoted === 'admin' && deactivated === false,
    { byAdmin, bossSelf, bySelf, promoted, deactivated });

  const demoteSelf = await error("update profiles set role = 'admin' where id = $1", [david]);
  const deactivateSelf = await error('update profiles set active = false where id = $1', [david]);
  await as(null);
  const editorDemote = await error("update profiles set role = 'staff' where id = $1", [david]);
  await as(david);
  const handOver = await error("update profiles set role = 'superadmin' where id = $1", [boss]);
  const stepDown = await error("update profiles set role = 'admin' where id = $1", [david]);
  await as(boss);
  const bossAlone = await error('update profiles set active = false where id = $1', [boss]);
  const restore = await error("update profiles set role = 'superadmin' where id = $1", [david]);
  const bossBack = await error("update profiles set role = 'admin' where id = $1", [boss]);
  const supers = (await rows("select id from profiles where role = 'superadmin' and active")).map((r) => r.id);
  check('20. the last active superadmin cannot be demoted or deactivated (not even from the SQL editor); a handover works',
    demoteSelf !== null && deactivateSelf !== null && editorDemote !== null && handOver === null && stepDown === null
      && bossAlone !== null && restore === null && bossBack === null && supers.length === 1 && supers[0] === david,
    { demoteSelf, deactivateSelf, editorDemote, handOver, stepDown, bossAlone, restore, bossBack, supers });

  // 21. Storage: the private finance bucket --------------------------------------------------------------------

  await as(null);
  const bucket = await one("select public from storage.buckets where id = 'finance'");
  await as(boss);
  const adminUpload = await error("insert into storage.objects (bucket_id, name) values ('finance', $1)", [`statements/${uid()}-week-41.png`]);
  const adminFiles = (await one("select count(*)::int as n from storage.objects where bucket_id = 'finance'")).n;
  const otherBucket = await error("insert into storage.objects (bucket_id, name) values ('avatars', 'x.png')");
  await as(alice);
  const staffFiles = (await one("select count(*)::int as n from storage.objects where bucket_id = 'finance'")).n;
  const staffUpload = await error("insert into storage.objects (bucket_id, name) values ('finance', $1)", [`receipts/${uid()}-receipt.pdf`]);
  const staffRename = await affected("update storage.objects set name = 'statements/x' where bucket_id = 'finance'");
  const staffDelete = await affected("delete from storage.objects where bucket_id = 'finance'");
  await as(david);
  const superFiles = (await one("select count(*)::int as n from storage.objects where bucket_id = 'finance'")).n;
  check('21. storage: private finance bucket; only admins list, upload, change or delete its files (other buckets untouched)',
    bucket?.public === false && adminUpload === null && adminFiles === 1 && otherBucket !== null && staffFiles === 0
      && staffUpload !== null && staffRename === 0 && staffDelete === 0 && superFiles === 1,
    { bucket, adminUpload, adminFiles, otherBucket, staffFiles, staffUpload, staffRename, staffDelete, superFiles });

  // 23. Still nothing for inactive accounts or anon ----------------------------------------------------------

  await as(carol);
  const tables = (await rows(`select tablename from pg_tables where schemaname = 'public'
    and tablename not in ('admin_emails', 'routine_runs') order by tablename`)).map((r) => r.tablename);
  const visible = {};
  for (const t of tables) {
    const n = (await one(`select count(*)::int as n from public.${t}`)).n;
    if (n) visible[t] = n;
  }
  const inactiveTodo = await error("insert into todos (assignee_id, title, day) values ($1, 'Hello?', current_date)", [carol]);
  const inactiveTime = await error('insert into time_entries (user_id, day) values ($1, current_date)', [carol]);
  check('23. after 0002 an inactive profile still sees no rows in any of the 31 tables and cannot write its own',
    tables.length === 31 && Object.keys(visible).length === 0 && inactiveTodo !== null && inactiveTime !== null,
    { tables: tables.length, visible, inactiveTodo, inactiveTime });

  await as(null);
  const rpcGrants = await one(`select
    has_function_privilege('anon', 'public.ensure_todos(date)', 'execute') as anon_ensure,
    has_function_privilege('anon', 'public.generate_due_invoices()', 'execute') as anon_generate,
    has_function_privilege('authenticated', 'public.ensure_todos(date)', 'execute') as user_ensure,
    has_function_privilege('authenticated', 'public.generate_due_invoices()', 'execute') as user_generate`);
  await db.exec('set role anon');
  const anonDenied = [
    await error('select * from public.todos'),
    await error('select * from public.module_access'),
    await error('select public.ensure_todos(current_date)'),
    await error('select public.generate_due_invoices()'),
  ];
  check('23. anon cannot read the new tables or call the RPCs (granted to authenticated only)',
    anonDenied.every((e) => e !== null) && stable(rpcGrants) === stable({ anon_ensure: false, anon_generate: false, user_ensure: true, user_generate: true }),
    { anonDenied, rpcGrants });

  await as(null);
  return { alice, boss, david, hello, carol, projectsActive, marketingGroup, staffItem };
}

// Phase 3: 0003_timezones_projects_view.sql on top of 0002 and the rows above ------------------------------

async function applyMigration3() {
  await as(null);
  try {
    await db.exec(migration3);
    return null;
  } catch (e) {
    await db.exec('rollback').catch(() => {});
    return e.message;
  }
}

async function phase3({ alice, boss, david, hello, carol, projectsActive, marketingGroup, staffItem }) {
  // 24. 0003 on a database that already holds rows -----------------------------------------------------------

  const first = await applyMigration3();
  const body = migration3.replace(/--.*$/gm, '').trim();
  check('24. 0003 runs on top of 0002 and its rows, as one transaction', first === null && /^begin;/i.test(body) && /commit;$/i.test(body), first);
  if (first) return;
  const second = await applyMigration3();
  check('24. 0003 re-runs cleanly', second === null, second);
  if (second) return;

  const zones = await rows('select timezone, count(*)::int as n from profiles group by timezone');
  const newcomer = await signUp('new.example@assetstackai.com', 'New Example');
  const newZone = (await one('select timezone from profiles where id = $1', [newcomer])).timezone;
  check('24. existing profiles and new sign-ups start in Australia/Sydney',
    zones.length === 1 && zones[0].timezone === 'Australia/Sydney' && newZone === 'Australia/Sydney', { zones, newZone });

  // 25. Time zones ---------------------------------------------------------------------------------------------

  // The sync engine saves a profile as an update of the whole row (src/data/backend/sync.js).
  const saveProfile = async (user, patch) => error(`update profiles set ${Object.keys(patch).map((k, i) => `${k} = $${i + 2}`).join(', ')}
    where id = $1`, [user, ...Object.values(patch)]);
  await as(alice);
  const own = await saveProfile(alice, { name: 'Alice Example', timezone: 'Asia/Manila' });
  const unknown = await saveProfile(alice, { timezone: 'Mars/Olympus' });
  const blank = await saveProfile(alice, { timezone: '' });
  const othersZone = await affected("update profiles set timezone = 'Asia/Tbilisi' where id = $1", [boss]);
  await as(boss);
  const byAdmin = await saveProfile(boss, { timezone: 'Asia/Tbilisi' });
  const read = Object.fromEntries((await rows('select id, timezone from profiles where id = any($1)', [[alice, boss]])).map((r) => [r.id, r.timezone]));
  const back = normalizeRow('profiles', (await one('select row_to_json(p) as r from profiles p where id = $1', [alice])).r);
  check('25. everyone sets their own time zone (a real IANA name only); staff cannot set anyone else\'s',
    own === null && typeof unknown === 'string' && typeof blank === 'string' && othersZone === 0 && byAdmin === null
      && read[alice] === 'Asia/Manila' && read[boss] === 'Asia/Tbilisi' && back.timezone === 'Asia/Manila',
    { own, unknown, blank, othersZone, byAdmin, read, back });

  // Sessions run in UTC (Supabase) or anywhere else; the business day is Sydney's either way.
  const teamDay = [];
  for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    await db.exec(`set timezone = '${zone}'`);
    teamDay.push(await one(`select public.team_today()::text as day, (now() at time zone 'Australia/Sydney')::date::text as sydney`));
  }
  await db.exec('reset timezone');
  check("25. the business day (team_today(), invoice dates) is Sydney's, whatever the session's time zone",
    teamDay.every((r) => r.day === r.sydney), teamDay);

  // UTC+14 and UTC-11 are never on the same date, so these show whose zone a date came from.
  await as(null);
  await db.query("update profiles set timezone = 'Pacific/Kiritimati' where id = $1", [alice]);
  await db.query("update profiles set timezone = 'Pacific/Pago_Pago' where id = $1", [boss]);
  const days = await one(`select public.user_today($1)::text as alice, public.user_today($2)::text as boss, public.user_today($3)::text as nobody,
      (now() at time zone 'Pacific/Kiritimati')::date::text as kiritimati, (now() at time zone 'Pacific/Pago_Pago')::date::text as pago,
      (now() at time zone 'Australia/Sydney')::date::text as sydney`, [alice, boss, uid()]);
  const grants = await one(`select has_function_privilege('anon', 'public.user_today(uuid)', 'execute') as anon,
    has_function_privilege('authenticated', 'public.user_today(uuid)', 'execute') as authenticated`);
  check("25. user_today() is the person's own date (Sydney when unknown), for the automations only",
    days.alice === days.kiritimati && days.boss === days.pago && days.alice !== days.boss && days.nobody === days.sydney
      && grants.anon === false && grants.authenticated === false,
    { days, grants });

  await as(boss);
  const ownedBy = async (owner, name) => (await one(`insert into contacts (name, org, status, owner_id) values ($1, 'Example Co', 'Replied', $2)
    returning id`, [name, owner])).id;
  const forAlice = await ownedBy(alice, 'Ari Example');
  const forBoss = await ownedBy(boss, 'Bo Example');
  const followUps = Object.fromEntries((await rows('select ref, day::text as day from todos where ref = any($1)',
    [[`contact:${forAlice}`, `contact:${forBoss}`]])).map((r) => [r.ref, r.day]));
  check("25. contact_pipeline dates the follow-up to-do in its owner's time zone",
    followUps[`contact:${forAlice}`] === days.kiritimati && followUps[`contact:${forBoss}`] === days.pago, { followUps, days });
  await as(null);
  await db.query("update profiles set timezone = 'Australia/Sydney' where id = any($1)", [[alice, boss]]);

  // 26. Projects is view-only for staff by default -------------------------------------------------------------

  const levels = async (user) => {
    await as(user);
    return one(`select public.module_level('projects') as projects, public.module_level('marketing') as marketing,
      public.module_level('outreach') as outreach, public.module_level('pipeline') as pipeline`);
  };
  const staffLevels = await levels(newcomer);
  const helloLevels = await levels(hello); // overrides from 13: projects none, marketing view
  const adminLevels = await levels(boss);
  const inactiveLevels = await levels(carol);
  check('26. module_level: staff default for projects is now view (marketing still edit); overrides still win; admins edit',
    stable(staffLevels) === stable({ projects: 'view', marketing: 'edit', outreach: 'none', pipeline: 'view' })
      && helloLevels.projects === 'none' && helloLevels.marketing === 'view'
      && Object.values(adminLevels).every((l) => l === 'edit') && Object.values(inactiveLevels).every((l) => l === 'none'),
    { staffLevels, helloLevels, adminLevels, inactiveLevels });

  await as(boss);
  const assigned = (await one(`insert into items (board_key, group_id, name, "values") values ('projects', $1, 'Site visit', $2)
    returning id`, [projectsActive, { people: [alice] }])).id;
  await as(alice); // no projects override
  const sees = await one('select (select count(*)::int from items where id = $1) as assigned, (select count(*)::int from items where id = $2) as own',
    [assigned, staffItem]);
  const attempts = {
    insert: await error("insert into items (board_key, group_id, name) values ('projects', $1, 'Nope')", [projectsActive]),
    rename: await affected("update items set name = 'Renamed' where id = $1", [assigned]),
    tick: await affected('update items set done = true where id = $1', [assigned]),
    remove: await affected('delete from items where id = $1', [staffItem]),
    subtask: await error("insert into subtasks (item_id, text) values ($1, 'Nope')", [assigned]),
    comment: await error("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Nope')", [assigned, alice]),
    group: await error("insert into board_groups (board_key, name) values ('projects', 'Nope')"),
  };
  const marketingItem = await error("insert into items (board_key, group_id, name) values ('marketing', $1, 'Still mine')", [marketingGroup]);
  check('26. by default staff see Projects (their assigned items too) but cannot add, change, tick, delete or comment; Marketing stays editable',
    sees.assigned === 1 && sees.own === 1 && typeof attempts.insert === 'string' && attempts.rename === 0 && attempts.tick === 0
      && attempts.remove === 0 && typeof attempts.subtask === 'string' && typeof attempts.comment === 'string'
      && typeof attempts.group === 'string' && marketingItem === null,
    { sees, attempts, marketingItem });

  await as(david);
  await db.query("insert into module_access (user_id, module, level) values ($1, 'projects', 'edit')", [alice]);
  await as(alice);
  const granted = await affected("update items set name = 'Site visit (booked)' where id = $1", [assigned]);
  await as(david);
  await db.query("delete from module_access where user_id = $1 and module = 'projects'", [alice]);
  check('26. the SuperAdmin can still give one staff member edit on Projects', granted === 1, granted);

  await as(null);
  return { alice, boss, david, hello, carol, newcomer, projectsActive, marketingGroup };
}

// Phase 4: 0004_clients_google.sql on top of 0003 and the rows above ----------------------------------------------

async function applyMigration4() {
  await as(null);
  try {
    await db.exec(migration4);
    return null;
  } catch (e) {
    await db.exec('rollback').catch(() => {});
    return e.message;
  }
}

async function phase4({ alice, boss, david, hello, carol, newcomer }) {
  // 27. 0004 on a database that already holds rows ---------------------------------------------------------------

  // Clients as 0001-0003 left them: a key contact and email, an email only, neither.
  await as(null);
  const legacy = async (name, keyContact, email) => (await one(`insert into clients (name, status, key_contact, email)
    values ($1, 'Active', $2, $3) returning id`, [name, keyContact, email])).id;
  const both = await legacy('Legacy Both', 'Pat Example', ' Pat@Example.com ');
  const emailOnly = await legacy('Legacy Email', '', 'accounts@example.com');
  const neither = await legacy('Legacy Neither', '', '');
  const publishedBefore = (await one("select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime'")).n;

  const first = await applyMigration4();
  const body = migration4.replace(/--.*$/gm, '').trim();
  check('27. 0004 runs on top of 0003 and its rows, as one transaction', first === null && /^begin;/i.test(body) && /commit;$/i.test(body), first);
  if (first) return null;
  const second = await applyMigration4();
  check('27. 0004 re-runs cleanly', second === null, second);
  if (second) return null;
  check("27. 0004 never mentions module_level (test-sync reads the staff defaults from the newest file that does)",
    !migration4.includes('module_level'));

  const contactsOf = async (client) => rows(`select name, role, email, phone, billing, position from client_contacts
    where client_id = $1 order by position`, [client]);
  const moved = { both: await contactsOf(both), emailOnly: await contactsOf(emailOnly), neither: await contactsOf(neither) };
  const blanked = await one(`select count(*)::int as n from clients where key_contact <> '' or email <> ''`);
  check("27. each client's key contact / email became one billing contact (trimmed, email lower case); the old fields are blank",
    stable(moved) === stable({
      both: [{ name: 'Pat Example', role: '', email: 'pat@example.com', phone: '', billing: true, position: 0 }],
      emailOnly: [{ name: '', role: '', email: 'accounts@example.com', phone: '', billing: true, position: 0 }],
      neither: [],
    }) && blanked.n === 0, { moved, blanked });

  // An old browser tab still writing key_contact after the upgrade: re-running picks it up (after a client's existing
  // contacts; see 31.), and never duplicates.
  await db.query("update clients set key_contact = 'Late Example' where id in ($1, $2)", [both, neither]);
  await applyMigration4();
  const rerun = { both: (await contactsOf(both)).length, neither: (await contactsOf(neither)).map((x) => x.name) };
  check('27. re-running picks up a late key contact for a client with none (and one with contacts), and never duplicates',
    rerun.both === 2 && stable(rerun.neither) === stable(['Late Example']), rerun);

  const cols = await one(`select
    (select column_default from information_schema.columns where table_name = 'clients' and column_name = 'platform_url') as platform,
    (select column_default from information_schema.columns where table_name = 'client_usage' and column_name = 'credits') as credits,
    (select column_default from information_schema.columns where table_name = 'invoices' and column_name = 'sent_to') as sent_to,
    (select contract_template || '|' || contract_folder from org_settings where id = 1) as org`);
  check("27. new columns: clients.platform_url '', client_usage.credits 0, invoices.sent_to '', org contract links ''",
    /''/.test(cols.platform) && cols.credits === '0' && /''/.test(cols.sent_to) && cols.org === '|', cols);

  const noRls = (await rows(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind = 'r' and not c.relrowsecurity`)).map((r) => r.relname);
  const published = await rows(`select tablename from pg_publication_tables where pubname = 'supabase_realtime'
    and tablename in ('client_contacts', 'client_contracts', 'google_accounts') order by tablename`);
  const publishedAfter = (await one("select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime'")).n;
  const touched = (await rows(`select c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where t.tgname = 'touch' and c.relname in ('client_contacts', 'client_contracts', 'google_accounts')`)).map((r) => r.relname).sort();
  check('27. RLS on every table (private.google_accounts too); the two new tables are published to realtime (33), the tokens never',
    noRls.length === 0 && stable(published.map((r) => r.tablename)) === stable(['client_contacts', 'client_contracts'])
      && publishedAfter === publishedBefore + 2 && publishedAfter === 33
      && stable(touched) === stable(['client_contacts', 'client_contracts', 'google_accounts']),
    { noRls, published, publishedBefore, publishedAfter, touched });

  // 28. Contacts and contracts belong to the clients module ---------------------------------------------------

  const contractRow = "insert into client_contracts (client_id, title, annual_fee) values ($1, 'Agreement', 4500) returning id";
  await as(boss);
  const bossContact = await error("insert into client_contacts (client_id, name, email, billing) values ($1, 'Bo Example', 'bo@example.com', true)", [both]);
  const bossContract = (await one(contractRow, [both])).id;
  const contract = await one('select status, created_by, start_date, annual_fee from client_contracts where id = $1', [bossContract]);
  const badStatus = await error("update client_contracts set status = 'Pending' where id = $1", [bossContract]);
  await as(newcomer); // staff, clients view (default)
  const viewSees = await one(`select (select count(*)::int from client_contacts where client_id = $1) as contacts,
    (select count(*)::int from client_contracts where client_id = $1) as contracts`, [both]);
  const viewWrites = {
    contact: await error("insert into client_contacts (client_id, name) values ($1, 'Nope')", [both]),
    contract: await error(contractRow, [both]),
    edit: await affected("update client_contacts set billing = false where client_id = $1", [both]),
    sign: await affected("update client_contracts set status = 'Signed' where id = $1", [bossContract]),
    drop: await affected('delete from client_contracts where id = $1', [bossContract]),
  };
  await as(alice); // staff with clients edit (17.)
  const editWrite = await error("insert into client_contacts (client_id, name) values ($1, 'Alice adds')", [both]);
  await as(carol);
  const inactive = await one('select (select count(*)::int from client_contacts) as contacts, (select count(*)::int from client_contracts) as contracts');
  await db.exec('set role anon');
  const anon = await error('select * from public.client_contacts');
  await as(null);
  check('28. admins add contacts and contracts (Draft, created_by them); staff with view read but cannot write; with edit they write contacts (31.)',
    bossContact === null && contract.status === 'Draft' && contract.created_by === boss && contract.start_date === null
      && Number(contract.annual_fee) === 4500 && viewSees.contacts >= 2 && viewSees.contracts === 1
      && typeof viewWrites.contact === 'string' && typeof viewWrites.contract === 'string' && viewWrites.edit === 0
      && viewWrites.sign === 0 && viewWrites.drop === 0 && editWrite === null && typeof badStatus === 'string',
    { bossContact, contract, viewSees, viewWrites, editWrite, badStatus });
  check('28. inactive accounts and anon see no contacts or contracts', inactive.contacts === 0 && inactive.contracts === 0 && anon !== null,
    { inactive, anon });

  // 29. "Approve invoices" and "Prepare contract" to-dos -----------------------------------------------------

  await as(null);
  const awaiting = (await one("select count(*)::int as n from invoices where status = 'Awaiting approval'")).n;
  const tuesday = '2026-11-03';
  const ensure = async (user, day) => {
    await as(user);
    return attempt('select public.ensure_todos($1) as n', [day]);
  };
  await ensure(boss, tuesday);
  const again = await ensure(boss, tuesday);
  await ensure(newcomer, tuesday);
  await as(null);
  const approveTodos = await rows(`select assignee_id, title, category, source from todos where ref = 'approve:' || $1`, [tuesday]);
  check('29. while invoices await approval, an admin\'s ensure_todos adds "Approve invoices" once a day; staff never get it',
    awaiting > 0 && again?.n === 0 && approveTodos.length === 1 && approveTodos[0].assignee_id === boss
      && approveTodos[0].title === 'Approve invoices' && approveTodos[0].category === 'Clients' && approveTodos[0].source === 'automation',
    { awaiting, again, approveTodos });

  await db.query("update invoices set status = 'Approved' where status = 'Awaiting approval'");
  const wednesday = await ensure(boss, '2026-11-04');
  await as(null);
  const noneLeft = (await one("select count(*)::int as n from todos where ref = 'approve:2026-11-04'")).n;
  // The rest of ensure_todos is as 0002: a Monday still gives the bank reminder, a routine still runs once.
  const routine = (await one(`insert into routines (title, category, minutes, assignee_id, weekdays, active)
    values ('Check the pipeline', 'Meetings', 15, $1, '{1,2,3,4,5}', true) returning id`, [boss])).id;
  const monday = await ensure(boss, '2026-11-09');
  const mondayAgain = await ensure(boss, '2026-11-09');
  await as(null);
  const mondayTodos = (await rows("select ref, routine_id from todos where assignee_id = $1 and day = '2026-11-09'", [boss]))
    .map((r) => r.routine_id === routine ? 'routine' : r.ref).sort();
  const fn = await one("select prosecdef, array_to_string(proconfig, ',') as config from pg_proc where proname = 'ensure_todos'");
  check('29. nothing awaiting: no approve to-do; routines and the Monday bank reminder work as before; still security definer',
    wednesday?.n === 0 && noneLeft === 0 && monday?.n === 2 && mondayAgain?.n === 0
      && stable(mondayTodos) === stable(['bank:2026-11-09', 'routine']) && fn.prosecdef === true && /search_path=public/.test(fn.config),
    { wednesday, noneLeft, monday, mondayAgain, mondayTodos, fn });

  const contractTodos = async (client) => rows(`select assignee_id, title, category, source, day = public.user_today(assignee_id) as today
    from todos where ref = 'contract:' || $1`, [client]);
  const addClient = async (user, name, status, owner) => {
    await as(user);
    return (await one('insert into clients (name, status, contact_id) values ($1, $2, $3) returning id', [name, status, owner])).id;
  };
  const own = await addClient(boss, ' Example Strata ', 'Onboarding', boss);
  const staffOwned = await addClient(boss, 'Staff Owned', 'Onboarding', alice);
  const imported = await addClient(boss, 'Imported Active', 'Active', boss);
  const byStaff = await addClient(alice, 'Added By Staff', 'Onboarding', alice);
  const forDavid = await addClient(alice, 'For David', 'Onboarding', david);
  await as(null);
  const made = {
    own: await contractTodos(own), staffOwned: await contractTodos(staffOwned), imported: await contractTodos(imported),
    byStaff: await contractTodos(byStaff), forDavid: await contractTodos(forDavid),
  };
  // The sync engine re-saving an existing client (an upsert that updates) makes no second to-do.
  await as(boss);
  const resave = await postgrestUpsert('clients', [{ id: own, name: 'Example Strata', status: 'Onboarding', contact_id: boss }]);
  await as(null);
  const afterResave = (await contractTodos(own)).length;
  check('29. a new Onboarding client gives its admin owner (else the admin who added it) "Prepare contract: <name>" on their own today',
    made.own.length === 1 && made.own[0].assignee_id === boss && made.own[0].title === 'Prepare contract: Example Strata'
      && made.own[0].category === 'Clients' && made.own[0].source === 'automation' && made.own[0].today === true
      && made.staffOwned.length === 1 && made.staffOwned[0].assignee_id === boss
      && made.imported.length === 0 && made.byStaff.length === 0
      && made.forDavid.length === 1 && made.forDavid[0].assignee_id === david
      && resave === null && afterResave === 1,
    { made, resave, afterResave });

  // 30. Each admin's own Google account ------------------------------------------------------------------------

  await as(boss);
  const meBefore = await attempt('select public.google_me() as me');
  const tokenTable = await error('select * from private.google_accounts');
  const saveAsUser = await error("select public.google_save($1, 'x@assetstackai.com', 'token', 'scope')", [boss]);
  const readAsUser = await error('select public.google_token($1)', [boss]);
  await as(newcomer);
  const staffMe = await attempt('select public.google_me() as me');
  await as(carol);
  const inactiveMe = await attempt('select public.google_me() as me');
  await db.exec('set role anon');
  const anonMe = await error('select public.google_me()');
  const anonSave = await error("select public.google_save($1, 'x', 'y', 'z')", [boss]);

  await db.exec('set role service_role');
  await db.query("select public.google_save($1, 'Boss@AssetStackAI.com', 'refresh-boss', 'gmail.send drive')", [boss]);
  await db.query("select public.google_save($1, 'super.example@assetstackai.com', 'refresh-david', 'gmail.send drive')", [david]);
  await db.query("select public.google_save($1, 'boss@assetstackai.com', 'refresh-boss-2', 'gmail.send drive')", [boss]);
  const token = (await one('select public.google_token($1) as t', [boss])).t;
  const noToken = (await one('select public.google_token($1) as t', [newcomer])).t;
  await as(boss);
  const meAfter = (await one('select public.google_me() as me')).me;
  const disconnect = (await one('select public.google_disconnect() as ok')).ok;
  const disconnectAgain = (await one('select public.google_disconnect() as ok')).ok;
  await as(null);
  const left = (await rows('select user_id from private.google_accounts')).map((r) => r.user_id);
  const grants = await one(`select
    has_function_privilege('authenticated', 'public.google_save(uuid, text, text, text)', 'execute') as user_save,
    has_function_privilege('authenticated', 'public.google_token(uuid)', 'execute') as user_token,
    has_function_privilege('service_role', 'public.google_token(uuid)', 'execute') as service_token,
    has_function_privilege('anon', 'public.google_me()', 'execute') as anon_me,
    has_schema_privilege('authenticated', 'private', 'usage') as user_private`);
  check("30. google_me: the caller's own profile and connection (never the token); staff too; inactive and anon refused",
    meBefore?.me?.uid === boss && meBefore.me.admin === true && meBefore.me.email === 'boss@assetstackai.com' && meBefore.me.google_email === null
      && staffMe?.me?.admin === false && typeof inactiveMe === 'string' && anonMe !== null
      && meAfter.google_email === 'boss@assetstackai.com' && !JSON.stringify(meAfter).includes('refresh'),
    { meBefore, staffMe, inactiveMe, anonMe, meAfter });
  check('30. tokens: only the secret key (service_role) saves and reads them (one per person, replaced on reconnect); the table is out of reach',
    tokenTable !== null && saveAsUser !== null && readAsUser !== null && anonSave !== null
      && token?.refresh_token === 'refresh-boss-2' && token.email === 'boss@assetstackai.com' && noToken === null
      && grants.user_save === false && grants.user_token === false && grants.service_token === true && grants.anon_me === false
      && grants.user_private === false,
    { tokenTable, saveAsUser, readAsUser, anonSave, token, noToken, grants });
  check('30. google_disconnect removes only your own connection', disconnect === true && disconnectAgain === false
    && stable(left) === stable([david]), { disconnect, disconnectAgain, left });

  // 31. Contracts are admins' to write; one "Approve invoices" at a time; re-running picks up changed key contacts ----

  // As in the app (an admin makes a contract with their own Google account): staff with clients edit only read them,
  // also through a PostgREST upsert as the sync engine sends one.
  await as(alice);
  const staffContract = {
    sees: (await one('select count(*)::int as n from client_contracts where id = $1', [bossContract])).n,
    add: await error(contractRow, [both]),
    sign: await affected(`update client_contracts set status = 'Signed', signed_at = '2026-10-01',
      doc_url = 'https://attacker.example/doc', sent_by = $2 where id = $1`, [bossContract, boss]),
    upsert: await postgrestUpsert('client_contracts', [{ id: bossContract, client_id: both, status: 'Signed' }]),
    drop: await affected('delete from client_contracts where id = $1', [bossContract]),
  };
  await as(null);
  const untouchedContract = await one('select status, doc_url, sent_by from client_contracts where id = $1', [bossContract]);
  await as(david);
  const adminContract = {
    send: await affected("update client_contracts set status = 'Sent for signature', sent_by = $2, sent_at = now() where id = $1",
      [bossContract, david]),
    upsert: await postgrestUpsert('client_contracts', [{ id: bossContract, client_id: both, status: 'Signed', signed_at: '2026-11-02' }]),
    add: (await one(contractRow, [both])).id,
  };
  adminContract.drop = await affected('delete from client_contracts where id = $1', [adminContract.add]);
  await as(null);
  const signedContract = await one('select status, signed_at::text as signed from client_contracts where id = $1', [bossContract]);
  check('31. contracts: staff with clients edit read them but never add, sign, relink or delete one (upserts too); admins do',
    staffContract.sees === 1 && typeof staffContract.add === 'string' && staffContract.sign === 0
      && typeof staffContract.upsert === 'string' && staffContract.drop === 0
      && untouchedContract.status === 'Draft' && untouchedContract.doc_url === '' && untouchedContract.sent_by === null
      && adminContract.send === 1 && adminContract.upsert === null && adminContract.drop === 1
      && signedContract.status === 'Signed' && signedContract.signed === '2026-11-02',
    { staffContract, untouchedContract, adminContract, signedContract });

  // An invoice left Awaiting approval for days: an admin's undone reminder carries over instead of a new one each day.
  await as(null);
  const waitingInvoice = (await one(`insert into invoices (client_id, number, issued, status)
    values ($1, 'APPROVE-CHECK-1', '2026-11-10', 'Awaiting approval') returning id`, [both])).id;
  const undoneApprove = async (user) => (await rows(`select ref from todos where assignee_id = $1 and source = 'automation'
    and ref like 'approve:%' and not done order by ref`, [user])).map((r) => r.ref);
  await ensure(boss, '2026-11-10');
  await ensure(boss, '2026-11-11');
  await as(null);
  const carried = await undoneApprove(boss); // 29.'s, never ticked
  await db.query("update todos set done = true, done_at = now() where assignee_id = $1 and ref like 'approve:%'", [boss]);
  await ensure(boss, '2026-11-12');
  await ensure(boss, '2026-11-13');
  await ensure(david, '2026-11-13');
  await as(null);
  const afterTick = { boss: await undoneApprove(boss), david: await undoneApprove(david) };
  await db.query("update invoices set status = 'Approved' where id = $1", [waitingInvoice]);
  check('31. "Approve invoices": one undone reminder per admin at a time (carried over, not a new one each day); a new one once ticked',
    stable(carried) === stable(['approve:2026-11-03'])
      && stable(afterTick) === stable({ boss: ['approve:2026-11-12'], david: ['approve:2026-11-13'] }),
    { carried, afterTick });

  // An old tab changed the key contact of a client that already has contacts: re-running adds it after them (not
  // billing) instead of blanking it away; one the client already has (same email, else same name) is never added.
  await db.query("update clients set key_contact = 'Bob Example', email = ' Bob@Example.com' where id = $1", [emailOnly]);
  await db.query("update clients set key_contact = 'Pat Example', email = 'PAT@example.com ' where id = $1", [both]);
  await db.query("update clients set key_contact = 'late example', email = '' where id = $1", [neither]);
  const contactsBefore = { both: await contactsOf(both), neither: await contactsOf(neither) };
  const rerunLate = await applyMigration4();
  const picked = {
    emailOnly: await contactsOf(emailOnly),
    both: stable(await contactsOf(both)) === stable(contactsBefore.both),
    neither: stable(await contactsOf(neither)) === stable(contactsBefore.neither),
    late: (await contactsOf(both)).find((x) => x.name === 'Late Example'), // 27.'s, on a client that had Pat
    blank: (await one(`select count(*)::int as n from clients where key_contact <> '' or email <> ''`)).n,
  };
  check('31. re-running 0004 adds a key contact an old tab changed after the existing contacts (not billing), never one the client has',
    rerunLate === null && stable(picked.emailOnly) === stable([
      { name: '', role: '', email: 'accounts@example.com', phone: '', billing: true, position: 0 },
      { name: 'Bob Example', role: '', email: 'bob@example.com', phone: '', billing: false, position: 1 },
    ]) && picked.both && picked.neither && picked.late?.billing === false && picked.late?.position === 1 && picked.blank === 0,
    { rerunLate, picked });

  return { alice, boss, david, hello, carol, newcomer };
}

// Phase 5: 0005_work_tools.sql ------------------------------------------------------------------------------

async function applyMigration5() {
  await as(null);
  try {
    await db.exec(migration5);
    return null;
  } catch (e) {
    await db.exec('rollback').catch(() => {});
    return e.message;
  }
}

async function phase5({ alice, boss, david, hello, carol, newcomer }) {
  // 32. Each person's Tools ----------------------------------------------------------------------------------

  const publishedBefore = (await one("select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime'")).n;
  const first = await applyMigration5();
  const body = migration5.replace(/--.*$/gm, '').trim();
  check('32. 0005 runs as one transaction and re-runs cleanly',
    first === null && /^begin;/i.test(body) && /commit;$/i.test(body) && (first ?? await applyMigration5()) === null, first);
  if (first) return null;
  check('32. 0005 never mentions module_level', !migration5.includes('module_level'));
  const shape = await one(`select c.relrowsecurity as rls,
      exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'work_tools') as published,
      exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'touch') as touched,
      (select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime') as total
    from pg_class c where c.oid = 'public.work_tools'::regclass`);
  check('32. work_tools: RLS on, touch, published to realtime (34 tables)',
    shape.rls && shape.published && shape.touched && shape.total === publishedBefore + 1 && shape.total === 34, { shape, publishedBefore });

  const tool = "insert into work_tools (user_id, name, url, username, how) values ($1, $2, 'https://example.com', $3, 'Sign in with Google') returning id, created_by";
  await as(boss); // admin: sets up anyone's list
  const forHello = await one(tool, [hello, 'Apollo', 'hello@example.com']);
  const forAlice = await one(tool, [alice, 'Gmail', 'alice@example.com']);
  await as(hello);
  const own = await one(tool, [hello, 'Notes', '']);
  const helloSees = (await rows('select name from work_tools order by name')).map((r) => r.name);
  const forOther = await error(tool, [alice, 'Nope', '']);
  const editOwn = await affected("update work_tools set username = 'hello.new@example.com' where id = $1", [forHello.id]);
  const editOther = await affected("update work_tools set name = 'Mine' where id = $1", [forAlice.id]);
  const handOver = await error('update work_tools set user_id = $2 where id = $1', [own.id, alice]);
  const forged = await affected('update work_tools set created_by = $2 where id = $1', [own.id, boss]);
  const forgedRow = await one('select created_by from work_tools where id = $1', [own.id]);
  const insertForged = await one("insert into work_tools (user_id, name, created_by) values ($1, 'Forged', $2) returning created_by", [hello, boss]);
  const deleteOther = await affected('delete from work_tools where id = $1', [forAlice.id]);
  const deleteOwn = await affected('delete from work_tools where id = $1', [own.id]);
  await as(david);
  const adminSees = (await one('select count(*)::int as n from work_tools')).n;
  const adminDelete = await affected('delete from work_tools where id = $1', [insertForged ? (await one("select id from work_tools where name = 'Forged'")).id : null]);
  await as(carol);
  const inactive = (await one('select count(*)::int as n from work_tools')).n;
  const inactiveAdd = await error(tool, [carol, 'Nope', '']);
  await as(newcomer);
  const newcomerSees = (await one('select count(*)::int as n from work_tools')).n;
  await db.exec('set role anon');
  const anon = await error('select * from public.work_tools');
  await as(null);
  check("32. admins set up anyone's tools; people see and edit only their own; nobody else's",
    forHello.created_by === boss && forAlice.created_by === boss && own.created_by === hello
      && stable(helloSees) === stable(['Apollo', 'Notes']) && typeof forOther === 'string' && editOwn === 1 && editOther === 0
      && typeof handOver === 'string' && deleteOther === 0 && deleteOwn === 1 && adminSees === 3 && adminDelete === 1 && newcomerSees === 0,
    { forHello, forAlice, own, helloSees, forOther, editOwn, editOther, handOver, deleteOther, deleteOwn, adminSees, adminDelete, newcomerSees });
  check('32. created_by is whoever added it and never changes; inactive accounts and anon see nothing',
    forged === 1 && forgedRow.created_by === hello && insertForged?.created_by === hello
      && inactive === 0 && typeof inactiveAdd === 'string' && anon !== null,
    { forged, forgedRow, insertForged, inactive, inactiveAdd, anon });

  return { alice, boss, david, hello, carol, newcomer };
}

// Phase 6: 0006_boards.sql (sub-boards under Projects and Marketing, each person's own Projects page) -------------------

async function applyMigration6() {
  await as(null);
  try {
    await db.exec(migration6);
    return null;
  } catch (e) {
    await db.exec('rollback').catch(() => {});
    return e.message;
  }
}

// src/lib/access.js (boardLevel, compared with board_level() in 38.) reaches the store through Vite's '@/…' alias for
// its React hook: Node gets a stub for '@/data/store' (the hook isn't run here), as in scripts/test-sync.mjs.
async function importAccess() {
  const src = new URL('../src/', import.meta.url).href;
  const storeStub = `data:text/javascript,${encodeURIComponent('export const useStore = () => { throw new Error("no store in Node"); };')}`;
  register(`data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === '@/data/store') return { url: ${JSON.stringify(storeStub)}, shortCircuit: true };
      if (specifier.startsWith('@/')) return next(${JSON.stringify(src)} + specifier.slice(2) + (/\\.[a-z]+$/.test(specifier) ? '' : '.js'), context);
      return next(specifier, context);
    }
  `)}`);
  return import('../src/lib/access.js');
}

async function phase6({ alice, boss, david, hello, carol, newcomer }) {
  // 33. 0006 on a database that already holds board rows -----------------------------------------------------------

  await as(null);
  const early = (await one("select id from profiles where email = 'you@assetstackai.com'")).id; // the second admin (3., 10.)
  // Both modules as 0001-0005 left them (Projects: Active, Backlog, Admin, Later; Marketing: This month), with tasks,
  // subtasks and updates on each; one more Marketing group, so both of its groups have to land on Posting schedule.
  const nextMonth = (await one(`insert into board_groups (board_key, name, color, position)
    values ('marketing', 'Next month', '#bfe9ff', 1) returning id`)).id;
  const launch = (await one(`insert into items (board_key, group_id, name, "values")
    values ('marketing', $1, 'Launch post', '{"people": []}') returning id`, [nextMonth])).id;
  await db.query("insert into subtasks (item_id, text) values ($1, 'Write the copy')", [launch]);
  await db.query("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Draft is up')", [launch, boss]);
  const projectItem = (await one("select id from items where board_key = 'projects' order by name limit 1")).id;
  await db.query("insert into item_updates (item_id, user_id, text) values ($1, $2, 'On it')", [projectItem, alice]);
  const preGroups = await rows('select id, board_key from board_groups');
  const projectsBefore = preGroups.filter((g) => g.board_key === 'projects').map((g) => g.id);
  const marketingBefore = preGroups.filter((g) => g.board_key === 'marketing').map((g) => g.id);
  // What a set of groups holds, per module.
  const contents = (groupIds) => rows(`select g.board_key as module, count(distinct g.id)::int as groups,
      count(distinct i.id)::int as items, count(distinct s.id)::int as subtasks, count(distinct u.id)::int as updates
    from board_groups g left join items i on i.group_id = g.id left join subtasks s on s.item_id = i.id
    left join item_updates u on u.item_id = i.id where g.id = any($1::uuid[]) group by g.board_key order by g.board_key`, [groupIds]);
  const held = await contents(preGroups.map((g) => g.id));
  const publishedBefore = (await one("select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime'")).n;

  const first = await applyMigration6();
  const body = migration6.replace(/--.*$/gm, '').trim();
  const marker = (await one("select obj_description('public.boards'::regclass, 'pg_class') as m")).m;
  check('33. 0006 runs on top of 0005 and the boards as they were (begin … commit when run whole), and marks itself complete',
    first === null && /^begin;/i.test(body) && /commit;$/i.test(body) && marker === 'Cortex 0006 complete', { first, marker });
  if (first) return null;
  const snapshot = () => one(`select
    (select string_agg(module || ':' || name || ':' || position, ',' order by module, position, name) from boards where owner_id is null) as team,
    (select count(*)::int from boards) as boards, (select count(*)::int from board_groups) as groups`);
  const afterFirst = await snapshot();
  // Every board but General and Posting schedule (which got the old groups), right after the first run.
  const firstGroups = await rows(`select b.module, b.owner_id is not null as personal, count(g.id)::int as n,
      string_agg(g.name || ' ' || g.color || ' ' || g.position, ',') as groups
    from boards b left join board_groups g on g.board_id = b.id
    where b.id not in (select board_id from board_groups where id = any($1::uuid[]))
    group by b.id, b.module, b.owner_id`, [preGroups.map((g) => g.id)]);
  // The re-run goes statement by statement, as the SQL editor may run it (42.).
  await as(null);
  const secondErrors = await runSplit(db, migration6);
  const second = secondErrors[0] ?? null;
  const afterSecond = await snapshot();
  // 0006 redefines module_level (staff edit Projects again), so it may name it; it must define it, not just call it.
  check('33. 0006 re-runs cleanly (adding no boards or groups) and only mentions module_level to redefine it',
    second === null && stable(afterSecond) === stable(afterFirst)
      && migration6.includes('create or replace function public.module_level(p_module text)'),
    { second, afterFirst, afterSecond });
  if (second) return null;

  // Staff edit Projects by default again; overrides (hello: Projects none from 13.) still win; admins edit.
  const projectLevels = {};
  for (const [name, user] of Object.entries({ newcomer, hello, boss })) {
    await as(user);
    projectLevels[name] = (await one("select public.module_level('projects') as p, public.module_level('marketing') as m")).p;
  }
  await as(null);
  check('33. module_level: the staff default for Projects is edit again (0003 made it view); overrides still win; admins edit',
    projectLevels.newcomer === 'edit' && projectLevels.hello === 'none' && projectLevels.boss === 'edit', projectLevels);
  // alice keeps Projects at view from here on (an override), so the checks below still cover view-only staff.
  await db.query("insert into module_access (user_id, module, level) values ($1, 'projects', 'view')", [alice]);
  const shape = await one(`select c.relrowsecurity as rls,
      exists (select 1 from pg_trigger t where t.tgrelid = c.oid and t.tgname = 'touch') as touched,
      exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'boards') as published,
      (select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime') as total,
      (select string_agg(x.relname, ',' order by x.relname) from pg_trigger t join pg_class x on x.oid = t.tgrelid
        where t.tgname = 'place_on_board') as placed,
      exists (select 1 from pg_trigger t where t.tgrelid = 'public.profiles'::regclass and t.tgname = 'add_personal_board') as pages
    from pg_class c where c.oid = 'public.boards'::regclass`);
  check('33. boards: RLS on, touch, published to realtime (35 tables); place_on_board on groups and tasks, add_personal_board on profiles',
    shape.rls && shape.touched && shape.published && shape.total === publishedBefore + 1 && shape.total === 35
      && shape.placed === 'board_groups,items' && shape.pages,
    { shape, publishedBefore });

  // 34. Starting team boards and everyone's own page --------------------------------------------------------------

  check('34. the starting team boards, once each: Landing Page, Tender Portal, General (Projects 0-2); '
    + 'Daily Automation, Posting schedule, Campaigns, Events (Marketing 0-3)',
    afterFirst.team === 'marketing:Daily Automation:0,marketing:Posting schedule:1,marketing:Campaigns:2,marketing:Events:3,'
      + 'projects:Landing Page:0,projects:Tender Portal:1,projects:General:2',
    afterFirst.team);
  const pageShapes = await rows(`select p.email, count(b.id)::int as n,
      coalesce(bool_and(b.module = 'projects' and b.name = '' and b.position = 0), false) as shape
    from profiles p left join boards b on b.owner_id = p.id group by p.email order by p.email`);
  check('34. every profile (the inactive one too) has exactly one personal board: Projects, unnamed, position 0',
    pageShapes.length === 7 && pageShapes.every((r) => r.n === 1 && r.shape), pageShapes);
  const late = await signUp('late.example@assetstackai.com', 'Late Example');
  const latePage = await rows(`select b.module, b.name, b.position, g.board_key, g.name as group_name, g.color, g.position as group_position
    from boards b left join board_groups g on g.board_id = b.id where b.owner_id = $1`, [late]);
  check('34. someone who signs up after 0006 gets their own page, with one group (Active)',
    latePage.length === 1 && stable(latePage[0]) === stable({
      module: 'projects', name: '', position: 0, board_key: 'projects', group_name: 'Active', color: '#c9ffe6', group_position: 0,
    }), latePage);

  const board = Object.fromEntries((await rows('select name, id from boards where owner_id is null')).map((r) => [r.name, r.id]));
  const page = Object.fromEntries((await rows('select owner_id, id from boards where owner_id is not null')).map((r) => [r.owner_id, r.id]));
  const groupOn = async (boardId) => (await one('select id from board_groups where board_id = $1 order by position, name limit 1', [boardId]))?.id;
  const pageGroup = {};
  for (const [owner, id] of Object.entries(page)) pageGroup[owner] = await groupOn(id);

  // 35. Backfill ----------------------------------------------------------------------------------------------------

  const placed = await one(`select
    (select count(*)::int from board_groups where id = any($1::uuid[]) and board_id <> $3) as projects_elsewhere,
    (select count(*)::int from board_groups where id = any($2::uuid[]) and board_id <> $4) as marketing_elsewhere,
    (select count(*)::int from board_groups where board_id = $3) as on_general,
    (select count(*)::int from board_groups where board_id = $4) as on_posting,
    (select count(*)::int from items i join board_groups g on g.id = i.group_id where i.board_id <> g.board_id) as tasks_elsewhere,
    (select string_agg(table_name || ':' || is_nullable, ',' order by table_name) from information_schema.columns
      where table_schema = 'public' and column_name = 'board_id' and table_name in ('board_groups', 'items')) as nullable`,
  [projectsBefore, marketingBefore, board.General, board['Posting schedule']]);
  const kept = await contents(preGroups.map((g) => g.id));
  check("35. backfill: every Projects group is on General, every Marketing group on Posting schedule, every task on its group's board; nothing lost",
    held.length === 2 && held.every((m) => m.groups > 0 && m.items > 0 && m.subtasks > 0 && m.updates > 0) && marketingBefore.length === 2
      && placed.projects_elsewhere === 0 && placed.marketing_elsewhere === 0 && placed.on_general === projectsBefore.length
      && placed.on_posting === marketingBefore.length && placed.tasks_elsewhere === 0 && stable(kept) === stable(held),
    { held, kept, placed });
  check('35. board_id is NOT NULL on board_groups and items', placed.nullable === 'board_groups:NO,items:NO', placed.nullable);
  check('35. every other board (team boards and personal pages) starts with exactly one group: Active on Projects, To do on Marketing',
    firstGroups.length === 12 && firstGroups.filter((b) => b.personal).length === 7
      && firstGroups.every((b) => b.n === 1 && b.groups === `${b.module === 'projects' ? 'Active' : 'To do'} #c9ffe6 0`),
    firstGroups);

  // 36. Constraints and cascades ------------------------------------------------------------------------------------

  await as(null); // the SQL editor: constraints hold for everyone
  const generalGroup = await groupOn(board.General); // Active, from 0001
  const constraints = {
    personalMarketing: await error("insert into boards (module, owner_id) values ('marketing', $1)", [late]),
    secondPage: await error("insert into boards (module, owner_id) values ('projects', $1)", [alice]),
    groupModule: await error("insert into board_groups (board_key, board_id, name) values ('marketing', $1, 'Nope')", [board.General]),
    taskBoard: await error("insert into items (board_key, board_id, group_id, name) values ('projects', $1, $2, 'Nope')",
      [board['Landing Page'], generalGroup]),
    taskOnly: await error('update items set board_id = $2 where id = $1', [projectItem, board['Landing Page']]),
  };
  check("36. constraints: no personal Marketing board, one personal board each, a group on a board of its own module, a task on its group's board",
    /boards_personal_projects/.test(constraints.personalMarketing ?? '') && /boards_owner_key/.test(constraints.secondPage ?? '')
      && /board_groups_board_fkey/.test(constraints.groupModule ?? '') && /items_group_board_id_fkey/.test(constraints.taskBoard ?? '')
      && /items_group_board_id_fkey/.test(constraints.taskOnly ?? ''),
    constraints);

  await as(boss);
  const moving = (await one(`insert into board_groups (board_key, board_id, name, position) values ('projects', $1, 'Moving', 1)
    returning id`, [board['Landing Page']])).id;
  const movingTasks = [];
  for (const name of ['First', 'Second']) {
    movingTasks.push((await one(`insert into items (board_key, board_id, group_id, name) values ('projects', $1, $2, $3)
      returning id`, [board['Landing Page'], moving, name])).id);
  }
  await db.query("insert into subtasks (item_id, text) values ($1, 'Step')", [movingTasks[0]]);
  await db.query("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Moving soon')", [movingTasks[0], boss]);
  const moveGroup = await affected('update board_groups set board_id = $2 where id = $1', [moving, board['Tender Portal']]);
  await as(null);
  const carried = await one(`select (select string_agg(distinct board_id::text, ',') from items where group_id = $1) as boards,
    (select count(*)::int from items where group_id = $1) as tasks, (select count(*)::int from subtasks where item_id = $2) as subtasks,
    (select count(*)::int from item_updates where item_id = $2) as updates`, [moving, movingTasks[0]]);
  check('36. moving a group to another board (board_groups.board_id) carries its tasks, with their subtasks and updates',
    moveGroup === 1 && carried.boards === board['Tender Portal'] && carried.tasks === 2 && carried.subtasks === 1 && carried.updates === 1,
    { moveGroup, carried });

  await as(boss);
  const doomed = (await one("insert into boards (module, name, position) values ('marketing', 'Doomed', 4) returning id")).id;
  const doomedGroup = (await one("insert into board_groups (board_key, board_id, name) values ('marketing', $1, 'Soon gone') returning id",
    [doomed])).id;
  const doomedTask = (await one(`insert into items (board_key, board_id, group_id, name) values ('marketing', $1, $2, 'Gone too')
    returning id`, [doomed, doomedGroup])).id;
  await db.query("insert into subtasks (item_id, text) values ($1, 'Gone')", [doomedTask]);
  await db.query("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Gone')", [doomedTask, boss]);
  const dropBoard = await affected('delete from boards where id = $1', [doomed]);
  await as(null);
  const remains = async (boardId, taskId) => (await one(`select (select count(*)::int from boards where id = $1)
    + (select count(*)::int from board_groups where board_id = $1) + (select count(*)::int from items where board_id = $1)
    + (select count(*)::int from subtasks where item_id = $2) + (select count(*)::int from item_updates where item_id = $2) as n`,
  [boardId, taskId])).n;
  const doomedLeft = await remains(doomed, doomedTask);

  const temp = await signUp('temp.example@assetstackai.com', 'Temp Example');
  const tempPage = (await one('select id from boards where owner_id = $1', [temp])).id;
  const tempTask = (await one(`insert into items (board_key, board_id, group_id, name) values ('projects', $1, $2, 'Mine')
    returning id`, [tempPage, await groupOn(tempPage)])).id;
  await db.query("insert into subtasks (item_id, text) values ($1, 'Mine')", [tempTask]);
  // By someone else: item_updates.user_id (0001) has no on delete action, so a person who wrote an update can't be deleted.
  await db.query("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Mine')", [tempTask, boss]);
  const tempHad = await remains(tempPage, tempTask);
  const removePerson = await error('delete from auth.users where id = $1', [temp]);
  const tempLeft = await remains(tempPage, tempTask);
  check("36. deleting a board deletes its groups, tasks, subtasks and updates; deleting a person deletes their page and what's on it",
    dropBoard === 1 && doomedLeft === 0 && tempHad === 5 && removePerson === null && tempLeft === 0,
    { dropBoard, doomedLeft, tempHad, removePerson, tempLeft });

  // 37. Old app tabs (writes that don't name a board) ---------------------------------------------------------------

  await as(boss);
  const landingGroup = await groupOn(board['Landing Page']);
  const tenderGroup = await groupOn(board['Tender Portal']);
  const oldGroups = {
    projects: (await attempt("insert into board_groups (board_key, name, position) values ('projects', 'From an old tab', 9) returning board_id")),
    marketing: (await attempt("insert into board_groups (board_key, name, position) values ('marketing', 'From an old tab', 9) returning board_id")),
  };
  const oldTask = await attempt("insert into items (board_key, group_id, name) values ('projects', $1, 'Old tab task') returning id, board_id",
    [landingGroup]);
  const regrouped = await attempt('update items set group_id = $2 where id = $1 returning board_id', [oldTask?.id, tenderGroup]);
  await as(alice); // staff with a Projects view override, on their own page
  const ownOld = await attempt("insert into items (board_key, group_id, name) values ('projects', $1, 'From an old tab') returning id, board_id",
    [pageGroup[alice]]);
  check("37. old tabs: a new group without board_id lands on General / Posting schedule; a task takes its group's board; "
    + 'changing only group_id moves it along',
    oldGroups.projects?.board_id === board.General && oldGroups.marketing?.board_id === board['Posting schedule']
      && oldTask?.board_id === board['Landing Page'] && regrouped?.board_id === board['Tender Portal'] && ownOld?.board_id === page[alice],
    { oldGroups, oldTask, regrouped, ownOld });

  // An old tab's full-row re-save (a PostgREST upsert without board_id) of a group and a task on someone's page, by an
  // admin and by its owner with Projects edit (the old app only wrote Projects with edit; the proposed row is placed on
  // General before the conflict, and INSERT ... ON CONFLICT checks the insert policy on it).
  const oldRows = (name) => ({
    group: { id: pageGroup[alice], board_key: 'projects', name: 'Active', color: '#c9ffe6', position: 0 },
    task: { id: ownOld?.id, board_key: 'projects', group_id: pageGroup[alice], position: 0, name, values: { people: [] }, done: false },
  });
  await as(boss);
  const resavedByAdmin = {
    group: await postgrestUpsert('board_groups', [oldRows().group]),
    task: await postgrestUpsert('items', [oldRows('Re-saved by an admin').task]),
  };
  await as(david);
  await db.query("update module_access set level = 'edit' where user_id = $1 and module = 'projects'", [alice]);
  await as(alice);
  const resavedByOwner = {
    group: await postgrestUpsert('board_groups', [oldRows().group]),
    task: await postgrestUpsert('items', [oldRows('Re-saved by its owner').task]),
  };
  await as(david);
  await db.query("update module_access set level = 'view' where user_id = $1 and module = 'projects'", [alice]);
  await as(null);
  const stayed = await one(`select (select board_id from board_groups where id = $1) as group_board,
    (select board_id from items where id = $2) as task_board, (select name from items where id = $2) as name`, [pageGroup[alice], ownOld?.id]);
  check("37. an old tab's full-row re-save (upsert without board_id) of a group or task on a personal page leaves it on that page",
    resavedByAdmin.group === null && resavedByAdmin.task === null && resavedByOwner.group === null && resavedByOwner.task === null
      && stayed.group_board === page[alice] && stayed.task_board === page[alice] && stayed.name === 'Re-saved by its owner',
    { resavedByAdmin, resavedByOwner, stayed });

  // 38. Who sees which board ----------------------------------------------------------------------------------------

  // A task, a subtask and an update (by its owner) on everyone's page.
  await as(null);
  const people = { david, boss, early, alice, hello, carol, newcomer, late };
  const label = Object.fromEntries(Object.entries(people).map(([k, v]) => [v, k]));
  const task = {};
  const note = {};
  for (const [name, id] of Object.entries(people)) {
    task[id] = (await one(`insert into items (board_key, board_id, group_id, name) values ('projects', $1, $2, $3) returning id`,
      [page[id], pageGroup[id], `${name}'s task`])).id;
    await db.query("insert into subtasks (item_id, text) values ($1, 'Step one')", [task[id]]);
    note[id] = (await one("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Started') returning id", [task[id], id])).id;
  }
  const ownerOf = new Map((await rows('select id, owner_id from boards where owner_id is not null')).map((r) => [r.id, label[r.owner_id]]));
  const boardOf = new Map((await rows('select id, board_id from items')).map((r) => [r.id, r.board_id]));
  // Whose pages a user sees, table by table.
  const pagesSeen = async (user) => {
    await as(user);
    const owners = (boardIds) => [...new Set(boardIds.map((b) => ownerOf.get(b)).filter(Boolean))].sort();
    const out = {
      boards: owners((await rows('select id from boards')).map((r) => r.id)),
      groups: owners((await rows('select board_id from board_groups')).map((r) => r.board_id)),
      tasks: owners((await rows('select board_id from items')).map((r) => r.board_id)),
      subtasks: owners((await rows('select item_id from subtasks')).map((r) => boardOf.get(r.item_id))),
      updates: owners((await rows('select item_id from item_updates')).map((r) => boardOf.get(r.item_id))),
    };
    await as(null);
    return out;
  };
  const staffPages = ['alice', 'carol', 'hello', 'late', 'newcomer'];
  const want = {
    david: Object.keys(people).sort(),
    boss: ['boss', ...staffPages].sort(),
    early: ['early', ...staffPages].sort(),
    alice: ['alice'],
    newcomer: ['newcomer'],
    hello: [], // Projects at none (13.)
    carol: [], // inactive
  };
  const seen = {};
  for (const who of Object.keys(want)) seen[who] = await pagesSeen(people[who]);
  const matches = (who) => Object.values(seen[who]).every((got) => stable(got) === stable(want[who]));
  check("38. the SuperAdmin sees everyone's personal page with its groups, tasks, subtasks and updates", matches('david'), seen.david);
  check("38. an admin sees their own page and staff's, not the SuperAdmin's or another admin's", matches('boss') && matches('early'),
    { boss: seen.boss, early: seen.early });
  check('38. staff see only their own page; staff with Projects at none not even that; inactive accounts none',
    matches('alice') && matches('newcomer') && matches('hello') && matches('carol'),
    { alice: seen.alice, newcomer: seen.newcomer, hello: seen.hello, carol: seen.carol });

  const teamSeen = async (user) => {
    await as(user);
    const list = (await rows("select module || ':' || name as b from boards where owner_id is null order by module, position, name")).map((r) => r.b);
    const groups = await one(`select
      count(*) filter (where b.module = 'projects')::int as projects, count(*) filter (where b.module = 'marketing')::int as marketing
      from board_groups g join boards b on b.id = g.board_id where b.owner_id is null`);
    await as(null);
    return { list, groups };
  };
  const allTeam = await teamSeen(boss);
  const marketingOnly = allTeam.list.filter((b) => b.startsWith('marketing:'));
  const team = { alice: await teamSeen(alice), newcomer: await teamSeen(newcomer), hello: await teamSeen(hello), carol: await teamSeen(carol) };
  check('38. team boards (and their groups) show to anyone who can view the module: staff see both modules, Projects at none hides Projects',
    allTeam.list.length === 7 && allTeam.groups.projects > 0 && allTeam.groups.marketing > 0
      && stable(team.alice) === stable(allTeam) && stable(team.newcomer) === stable(allTeam)
      && stable(team.hello.list) === stable(marketingOnly) && team.hello.groups.projects === 0
      && team.hello.groups.marketing === allTeam.groups.marketing
      && team.carol.list.length === 0 && team.carol.groups.projects === 0 && team.carol.groups.marketing === 0,
    { allTeam, team });

  await db.exec('set role anon');
  const anonReads = {
    boards: await error('select * from public.boards'),
    groups: await error('select * from public.board_groups'),
    tasks: await error('select * from public.items'),
  };
  await as(null);
  check('38. anon reads no boards, groups or tasks', Object.values(anonReads).every((e) => e !== null), anonReads);

  // The same rules on both sides: board_level() for every user and board is what boardLevel() in src/lib/access.js gives.
  const access = await importAccess();
  const jsState = {
    users: (await rows('select id, role, active from profiles')).map((u) => ({ id: u.id, role: u.role, active: u.active })),
    moduleAccess: (await rows('select user_id, module, level from module_access')).map((a) => ({ userId: a.user_id, module: a.module, level: a.level })),
  };
  const allBoards = (await rows('select id, module, name, owner_id from boards'))
    .map((b) => ({ id: b.id, module: b.module, name: b.name, owner: b.owner_id || '' }));
  const differ = [];
  const levelsSeen = new Set();
  for (const user of Object.values(people)) {
    await as(user);
    const sql = Object.fromEntries((await rows('select id, public.board_level(id) as level from unnest($1::uuid[]) as id', [allBoards.map((b) => b.id)]))
      .map((r) => [r.id, r.level]));
    allBoards.forEach((b) => {
      const js = access.boardLevel(jsState, b, user);
      levelsSeen.add(js);
      if (js !== sql[b.id]) differ.push({ user: label[user], board: b.name || `${label[b.owner]}'s page`, js, sql: sql[b.id] });
    });
  }
  await as(null);
  check('38. board_level() gives every user the level boardLevel() in src/lib/access.js gives, on every board',
    differ.length === 0 && levelsSeen.size === 3, { differ, levelsSeen: [...levelsSeen] });

  // 39. Who writes which board ----------------------------------------------------------------------------------------

  const addTask = "insert into items (board_key, board_id, group_id, name) values ($1, $2, $3, $4) returning id";
  // Staff on their own page (Projects is only view for them; their page is theirs to edit).
  await as(alice);
  const ownGroup = await attempt("insert into board_groups (board_key, board_id, name, position) values ('projects', $1, 'Errands', 1) returning id",
    [page[alice]]);
  const ownTask = await attempt(addTask, ['projects', page[alice], ownGroup?.id, 'Book flights']);
  const ownSub = await attempt("insert into subtasks (item_id, text) values ($1, 'Compare fares') returning id", [ownTask?.id]);
  const ownNote = await attempt("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Booked') returning id", [ownTask?.id, alice]);
  const ownEdits = {
    renameGroup: await affected("update board_groups set name = 'Errands (this week)' where id = $1", [ownGroup?.id]),
    editTask: await affected("update items set name = 'Book flights and hotel', done = true where id = $1", [ownTask?.id]),
    tickSubtask: await affected('update subtasks set done = true where id = $1', [ownSub?.id]),
    editUpdate: await affected("update item_updates set text = 'Booked (window seat)' where id = $1", [ownNote?.id]),
    dropSubtask: await affected('delete from subtasks where id = $1', [ownSub?.id]),
    dropUpdate: await affected('delete from item_updates where id = $1', [ownNote?.id]),
    dropTask: await affected('delete from items where id = $1', [ownTask?.id]),
    dropGroup: await affected('delete from board_groups where id = $1', [ownGroup?.id]),
  };
  check('39. staff add, edit and delete groups, tasks, subtasks and updates on their own page',
    Boolean(ownGroup?.id && ownTask?.id && ownSub?.id && ownNote?.id) && Object.values(ownEdits).every((n) => n === 1),
    { ownGroup, ownTask, ownSub, ownNote, ownEdits });
  // ...but can't carry a group or task from it onto a team Projects board they only view, nor write anyone else's page.
  const offPage = {
    moveGroup: await error('update board_groups set board_id = $2 where id = $1', [pageGroup[alice], board.General]),
    moveTask: await error('update items set group_id = $2 where id = $1', [task[alice], generalGroup]),
    otherPage: await error(addTask, ['projects', page[newcomer], pageGroup[newcomer], 'Nope']),
    otherTask: await affected("update items set name = 'Nope' where id = $1", [task[newcomer]]),
  };
  await as(carol);
  offPage.inactive = await error(addTask, ['projects', page[carol], pageGroup[carol], 'Nope']);
  check("39. ...but can't move a group or task onto a team Projects board they only view, nor write anyone else's page; inactive accounts write nothing",
    typeof offPage.moveGroup === 'string' && typeof offPage.moveTask === 'string' && typeof offPage.otherPage === 'string'
      && offPage.otherTask === 0 && typeof offPage.inactive === 'string',
    offPage);

  // Team Projects boards: staff edit them by default (newcomer, 0006); with a view override they can't.
  await as(null);
  const generalTask = (await one('select id from items where group_id = $1 limit 1', [generalGroup])).id;
  await as(newcomer);
  const withEdit = {
    task: await attempt(addTask, ['projects', board['Landing Page'], landingGroup, 'Granted']),
    editTask: await affected("update items set name = 'Granted (edited)' where id = $1", [generalTask]),
  };
  await as(david);
  await db.query("insert into module_access (user_id, module, level) values ($1, 'projects', 'view')", [newcomer]);
  await as(newcomer);
  const viewOnly = {
    group: await error("insert into board_groups (board_key, board_id, name) values ('projects', $1, 'Nope')", [board['Landing Page']]),
    task: await error(addTask, ['projects', board.General, generalGroup, 'Nope']),
    renameGroup: await affected("update board_groups set name = 'Nope' where id = $1", [generalGroup]),
    editTask: await affected("update items set name = 'Nope' where id = $1", [generalTask]),
    subtask: await error("insert into subtasks (item_id, text) values ($1, 'Nope')", [generalTask]),
    update: await error("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Nope')", [generalTask, newcomer]),
    dropTask: await affected('delete from items where id = $1', [generalTask]),
  };
  await as(david);
  await db.query("delete from module_access where user_id = $1 and module = 'projects'", [newcomer]);
  check("39. staff write team Projects boards by default (0006), and can't with a view override",
    typeof viewOnly.group === 'string' && typeof viewOnly.task === 'string' && viewOnly.renameGroup === 0 && viewOnly.editTask === 0
      && typeof viewOnly.subtask === 'string' && typeof viewOnly.update === 'string' && viewOnly.dropTask === 0
      && Boolean(withEdit.task?.id) && withEdit.editTask === 1,
    { viewOnly, withEdit });

  // Team Marketing boards: staff edit them by default (newcomer); view-only staff (hello) can't.
  await as(newcomer);
  const mkGroup = await attempt("insert into board_groups (board_key, board_id, name, position) values ('marketing', $1, 'Spring', 1) returning id",
    [board.Campaigns]);
  const mkTask = await attempt(addTask, ['marketing', board.Campaigns, mkGroup?.id, 'Spring launch']);
  const mkWrites = {
    subtask: await error("insert into subtasks (item_id, text) values ($1, 'Pick a date')", [mkTask?.id]),
    update: await attempt("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Booked the venue') returning id", [mkTask?.id, newcomer]),
    renameGroup: await affected("update board_groups set name = 'Spring 2027' where id = $1", [mkGroup?.id]),
    editTask: await affected("update items set done = true where id = $1", [mkTask?.id]),
  };
  await as(hello); // Marketing view
  const helloWrites = {
    group: await error("insert into board_groups (board_key, board_id, name) values ('marketing', $1, 'Nope')", [board.Campaigns]),
    editTask: await affected("update items set name = 'Nope' where id = $1", [mkTask?.id]),
  };
  check('39. staff write team Marketing boards by default (groups, tasks, subtasks, updates); with Marketing view they cannot',
    Boolean(mkGroup?.id && mkTask?.id && mkWrites.update?.id) && mkWrites.subtask === null && mkWrites.renameGroup === 1
      && mkWrites.editTask === 1 && typeof helloWrites.group === 'string' && helloWrites.editTask === 0,
    { mkGroup, mkTask, mkWrites, helloWrites });

  // Admins write staff's pages (and their own), not the SuperAdmin's or another admin's; the SuperAdmin writes anyone's.
  const pageWrites = async (user, owners) => {
    await as(user);
    const out = {};
    for (const owner of owners) {
      out[label[owner]] = {
        add: await attempt(addTask, ['projects', page[owner], pageGroup[owner], `From ${label[user]}`]).then((r) => (r?.id ? 'ok' : r)),
        edit: await affected("update items set done = true where id = $1", [task[owner]]),
        subtask: await error("insert into subtasks (item_id, text) values ($1, 'Added')", [task[owner]]),
      };
    }
    await as(null);
    return out;
  };
  const allowed = (r) => r.add === 'ok' && r.edit === 1 && r.subtask === null;
  const refused = (r) => typeof r.add === 'string' && r.add !== 'ok' && r.edit === 0 && typeof r.subtask === 'string';
  const byBoss = await pageWrites(boss, [boss, alice, hello, carol, david, early]);
  check("39. an admin writes their own page and staff's (Projects none or inactive too), not the SuperAdmin's or another admin's",
    ['boss', 'alice', 'hello', 'carol'].every((w) => allowed(byBoss[w])) && refused(byBoss.david) && refused(byBoss.early), byBoss);
  const byDavid = await pageWrites(david, [david, boss, early, alice, hello]);
  check("39. the SuperAdmin writes anyone's page", Object.values(byDavid).every(allowed), byDavid);

  // Team boards are the admins' to add, rename, order and delete; personal pages are nobody's to change.
  await as(boss);
  const teamBoard = {
    add: await attempt("insert into boards (module, name, position) values ('projects', 'Partner Portal', 3) returning id, owner_id, updated_by"),
  };
  teamBoard.rename = await affected("update boards set name = 'Partner portal' where id = $1", [teamBoard.add?.id]);
  teamBoard.reorder = await affected('update boards set position = 4 where id = $1', [teamBoard.add?.id]);
  await as(alice); // staff, Marketing edit
  const staffBoards = {
    add: await error("insert into boards (module, name) values ('projects', 'Mine')"),
    addMarketing: await error("insert into boards (module, name) values ('marketing', 'Mine')"),
    addOwnPage: await error("insert into boards (module, owner_id) values ('projects', $1)", [alice]),
    rename: await affected("update boards set name = 'Mine' where id = $1", [board.Campaigns]),
    remove: await affected('delete from boards where id = $1', [board.Campaigns]),
  };
  await as(boss);
  teamBoard.remove = await affected('delete from boards where id = $1', [teamBoard.add?.id]);
  check("39. only admins add, rename, reorder and delete team boards; staff can't insert a board at all (not even their own page)",
    Boolean(teamBoard.add?.id) && teamBoard.add.owner_id === null && teamBoard.add.updated_by === boss && teamBoard.rename === 1
      && teamBoard.reorder === 1 && teamBoard.remove === 1
      && typeof staffBoards.add === 'string' && typeof staffBoards.addMarketing === 'string' && typeof staffBoards.addOwnPage === 'string'
      && staffBoards.rename === 0 && staffBoards.remove === 0,
    { teamBoard, staffBoards });

  const pageChanges = {};
  for (const [who, user, owner] of [['david on alice', david, alice], ['david on own', david, david], ['boss on alice', boss, alice],
    ['alice on own', alice, alice]]) {
    await as(user);
    pageChanges[who] = {
      rename: await affected("update boards set name = 'Renamed' where id = $1", [page[owner]]),
      toTeam: await affected('update boards set owner_id = null where id = $1', [page[owner]]),
      remove: await affected('delete from boards where id = $1', [page[owner]]),
    };
  }
  await as(boss);
  const makePersonal = {
    boss: await error('update boards set owner_id = $2 where id = $1', [board['Tender Portal'], late]),
  };
  await as(david);
  makePersonal.david = await error('update boards set owner_id = $2 where id = $1', [board['Tender Portal'], late]);
  makePersonal.insert = await error("insert into boards (module, owner_id) values ('projects', $1)", [late]);
  await as(null);
  const pagesIntact = await one(`select count(*)::int as n, bool_and(name = '' and owner_id is not null) as ok from boards
    where id = any($1::uuid[])`, [Object.values(page)]);
  const tender = await one('select owner_id from boards where id = $1', [board['Tender Portal']]);
  check('39. nobody (not even the SuperAdmin) renames, deletes or un-owns a personal page, or turns a team board into one',
    Object.values(pageChanges).every((c) => c.rename === 0 && c.toTeam === 0 && c.remove === 0)
      && Object.values(makePersonal).every((e) => /row-level security/.test(e ?? '')) && pagesIntact.n === Object.keys(page).length
      && pagesIntact.ok && tender.owner_id === null,
    { pageChanges, makePersonal, pagesIntact, tender });

  // Updates: their author edits and deletes them, an admin anyone's (on a board they can edit); staff never someone else's.
  await as(boss);
  const bossOnAlice = (await one("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Looks good') returning id",
    [task[alice], boss])).id;
  const bossOnCampaign = (await one("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Nice') returning id",
    [mkTask?.id, boss])).id;
  const updates = {
    adminEditsStaffs: await affected("update item_updates set text = 'Started (edited by an admin)' where id = $1", [note[alice]]),
    adminEditsSupers: await affected("update item_updates set text = 'Nope' where id = $1", [note[david]]),
  };
  await as(alice);
  updates.ownerEditsAdmins = await affected("update item_updates set text = 'Nope' where id = $1", [bossOnAlice]);
  updates.ownerDeletesAdmins = await affected('delete from item_updates where id = $1', [bossOnAlice]);
  updates.forged = await error("insert into item_updates (item_id, user_id, text) values ($1, $2, 'As Boss')", [task[alice], boss]);
  // Handing your update to someone else: the request goes through but the author stays (keep_board_links).
  updates.handOver = await error('update item_updates set user_id = $2 where id = $1', [note[alice], boss]);
  updates.handOverAuthor = (await one('select user_id from item_updates where id = $1', [note[alice]]))?.user_id;
  await as(newcomer);
  updates.authorEdits = await affected("update item_updates set text = 'Booked the venue (deposit paid)' where id = $1", [mkWrites.update?.id]);
  updates.staffEditsOthers = await affected("update item_updates set text = 'Nope' where id = $1", [bossOnCampaign]);
  updates.staffDeletesOthers = await affected('delete from item_updates where id = $1', [bossOnCampaign]);
  await as(boss);
  updates.adminDeletesStaffs = await affected('delete from item_updates where id = $1', [mkWrites.update?.id]);
  updates.adminDeletesOwn = await affected('delete from item_updates where id = $1', [bossOnAlice]);
  await as(null);
  check("39. updates: authors edit and delete their own, admins anyone's (on boards they edit); staff never someone else's, nor post as them",
    updates.adminEditsStaffs === 1 && updates.adminEditsSupers === 0 && updates.ownerEditsAdmins === 0 && updates.ownerDeletesAdmins === 0
      && typeof updates.forged === 'string' && updates.handOver === null && updates.handOverAuthor === alice && updates.authorEdits === 1
      && updates.staffEditsOthers === 0 && updates.staffDeletesOthers === 0 && updates.adminDeletesStaffs === 1 && updates.adminDeletesOwn === 1,
    updates);

  // 40. Helper functions and a re-run on a used database ---------------------------------------------------------------

  const HELPERS = ['sees_person', 'board_level', 'can_view_board', 'can_edit_board', 'item_board_id', 'can_write_board',
    'can_write_item', 'update_exists'];
  const grants = await rows(`select f, has_function_privilege('anon', 'public.' || f || '(uuid)', 'execute') as anon,
      has_function_privilege('authenticated', 'public.' || f || '(uuid)', 'execute') as authenticated,
      (select prosecdef from pg_proc where proname = f and pronamespace = 'public'::regnamespace) as definer
    from unnest($1::text[]) as f`, [HELPERS]);
  await db.exec('set role anon');
  const anonCalls = {};
  for (const f of HELPERS) anonCalls[f] = await error(`select public.${f}($1)`, [page[alice]]);
  await as(alice);
  const own = await one(`select public.sees_person($1) as self, public.sees_person($2) as other, public.can_edit_board($3) as page,
    public.can_view_board($4) as general, public.can_edit_board($4) as general_edit, public.item_board_id($5) as task_board`,
  [alice, boss, page[alice], board.General, task[alice]]);
  check('40. the board helpers are security definer, for signed-in users only (anon can\'t call them), and answer for the caller',
    grants.every((g) => !g.anon && g.authenticated && g.definer) && Object.values(anonCalls).every((e) => e !== null)
      && own.self === true && own.other === false && own.page === true && own.general === true && own.general_edit === false
      && own.task_board === page[alice],
    { grants, anonCalls, own });

  // An admin renamed a starting board; re-running neither brings it back nor adds anything else to a used database.
  await as(boss);
  await db.query("update boards set name = 'Meetups' where id = $1", [board.Events]);
  await as(null);
  const used = await snapshot();
  const third = await applyMigration6();
  const rerun = await snapshot();
  const strays = (await one(`select count(*)::int as n from items i join board_groups g on g.id = i.group_id where i.board_id <> g.board_id`)).n;
  check('40. re-running 0006 on a used database adds no boards or groups (a renamed starting board stays renamed)',
    third === null && stable(rerun) === stable(used) && !rerun.team.includes('Events') && rerun.team.includes('marketing:Meetups:3') && strays === 0,
    { third, used, rerun, strays });
  await db.query("update boards set name = 'Events' where id = $1", [board.Events]);

  // 41. Review fixes ------------------------------------------------------------------------------------------------

  {
    // The sync saves an edited update as an upsert, and INSERT ... ON CONFLICT checks the insert policies on the proposed
    // row: an admin re-saving a staff member's update goes through admin_resave to author_update; staff can't re-save
    // someone else's, and admin_resave never lets an admin create an update in someone else's name.
    const asSaved = async (id) => one('select id, item_id, user_id, text, created_at from item_updates where id = $1', [id]);
    const resave = async (user, row, text) => { await as(user); return postgrestUpsert('item_updates', [{ ...row, text, created_at: new Date(row.created_at).toISOString() }]); };
    await as(null);
    const staffNote = await asSaved(note[alice]);
    const bossDraft = await one('select id, item_id, user_id, text, created_at from item_updates where user_id = $1 order by created_at limit 1', [boss]);
    const adminEdit = await resave(boss, staffNote, 'Started (tidied by an admin)');
    const superEdit = await resave(david, staffNote, 'Started (tidied by the SuperAdmin)');
    await as(null);
    const afterAdmin = await asSaved(note[alice]);
    const staffEdit = await resave(alice, bossDraft, 'Changed by staff');
    const forged = await resave(boss, { id: randomUUID(), item_id: task[alice], user_id: alice, created_at: new Date().toISOString() }, 'Not Alice');
    const ownEdit = await resave(alice, staffNote, 'Started today');
    await as(null);
    const final = await one('select (select text from item_updates where id = $1) as staff_note, (select text from item_updates where id = $2) as boss_draft,'
      + ' (select count(*)::int from item_updates where text = \'Not Alice\') as forged', [note[alice], bossDraft.id]);
    check('41. an admin (or the SuperAdmin) re-saves a staff member\'s update as the sync does (upsert); staff can\'t re-save someone '
      + 'else\'s; an admin can\'t create an update in someone else\'s name; authors still edit their own',
      adminEdit === null && superEdit === null && afterAdmin.user_id === alice && staffEdit !== null && forged !== null && ownEdit === null
        && final.staff_note === 'Started today' && final.boss_draft === bossDraft.text && final.forged === 0,
      { adminEdit, superEdit, afterAdmin, staffEdit, forged, ownEdit, final });

    // A write under a board or task someone else just deleted fails on the foreign key (23503, which the sync drops as
    // "deleted elsewhere"), not on RLS (which it would retry and report).
    const codeOf = (sql, params) => db.query(sql, params).then(() => null, (e) => e.code || e.message);
    await as(boss);
    const doomed = (await one("insert into boards (module, name, position) values ('marketing', 'Temp', 9) returning id")).id;
    const tempGroup = (await one("insert into board_groups (board_key, board_id, name) values ('marketing', $1, 'Now') returning id", [doomed])).id;
    const tempTask = (await one("insert into items (board_key, board_id, group_id, name) values ('marketing', $1, $2, 'Short-lived') returning id",
      [doomed, tempGroup])).id;
    const goneTask = (await one("insert into items (board_key, board_id, group_id, name) values ('marketing', $1, $2, 'Gone soon') returning id",
      [board['Posting schedule'], await groupOn(board['Posting schedule'])])).id;
    await db.query('delete from items where id = $1', [goneTask]);
    await db.query('delete from boards where id = $1', [doomed]);
    await as(alice); // staff with Marketing edit
    const gone = {
      group: await codeOf("insert into board_groups (id, board_key, board_id, name) values ($1, 'marketing', $2, 'Late')", [tempGroup, doomed]),
      task: await codeOf("insert into items (id, board_key, board_id, group_id, name) values ($1, 'marketing', $2, $3, 'Late')",
        [tempTask, doomed, tempGroup]),
      subtask: await codeOf("insert into subtasks (item_id, text) values ($1, 'Late')", [goneTask]),
      update: await codeOf("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Late')", [goneTask, alice]),
    };
    // Still refused on boards that exist but can't be edited (Landing Page is view-only for alice, who has a Projects view override).
    const viewOnly = await codeOf("insert into board_groups (board_key, board_id, name) values ('projects', $1, 'Nope')", [board['Landing Page']]);
    check('41. writes under a board or task that was deleted elsewhere fail on the foreign key (23503), not RLS; '
      + 'view-only boards still refuse (42501)',
      Object.values(gone).every((c) => c === '23503') && viewOnly === '42501', { gone, viewOnly });

    // Tasks and groups move only within their audience: team board ⇄ team board, or within one person's page.
    await as(david);
    const generalGroup = await groupOn(board.General);
    const generalTask = (await one("insert into items (board_key, board_id, group_id, name) values ('projects', $1, $2, 'Mover') returning id",
      [board.General, generalGroup])).id;
    const tenderGroup2 = await groupOn(board['Tender Portal']);
    const moves = {
      teamToTeam: await codeOf('update items set board_id = $2, group_id = $3 where id = $1', [generalTask, board['Tender Portal'], tenderGroup2]),
      teamToPage: await codeOf('update items set board_id = $2, group_id = $3 where id = $1', [generalTask, page[alice], pageGroup[alice]]),
      // An old tab names only the group; place_on_board moves the board along and same_audience still refuses.
      oldTabToPage: await codeOf('update items set group_id = $2 where id = $1', [generalTask, pageGroup[alice]]),
      pageToPage: await codeOf('update items set board_id = $2, group_id = $3 where id = $1', [task[alice], page[hello], pageGroup[hello]]),
      groupToPage: await codeOf('update board_groups set board_id = $2 where id = $1', [generalGroup, page[alice]]),
    };
    const landed = (await one('select board_id from items where id = $1', [generalTask])).board_id;
    check('41. a task or group moves between team boards, but not onto, off or between personal pages (even for the SuperAdmin or an old tab)',
      moves.teamToTeam === null && landed === board['Tender Portal'] && ['teamToPage', 'oldTabToPage', 'pageToPage', 'groupToPage']
        .every((k) => moves[k] === '23514'), { moves, landed });

    // … nor between Projects and Marketing team boards (both have no owner; the module differs).
    const postingGroup = await groupOn(board['Posting schedule']);
    const crossModule = {
      task: await codeOf("update items set board_key = 'marketing', board_id = $2, group_id = $3 where id = $1",
        [generalTask, board['Posting schedule'], postingGroup]),
      group: await codeOf("update board_groups set board_key = 'marketing', board_id = $2 where id = $1", [tenderGroup2, board['Posting schedule']]),
    };
    check('41. a task or group can\'t move between a Projects and a Marketing team board',
      crossModule.task === '23514' && crossModule.group === '23514', crossModule);

    // A board's module, a subtask's or update's task and an update's author stay as written, whatever a signed-in
    // request sends (the app never changes them); an admin's edit of the text still saves.
    const generalSub = (await one("insert into subtasks (item_id, text) values ($1, 'Step') returning id", [generalTask])).id;
    await as(boss);
    const bossNote = (await one("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Mine') returning id", [generalTask, boss])).id;
    const pins = {
      module: await codeOf("update boards set module = 'marketing' where id = $1", [board['Tender Portal']]),
      subtask: await codeOf('update subtasks set item_id = $2 where id = $1', [generalSub, task[alice]]),
      reassign: await codeOf("update item_updates set user_id = $2, text = 'Approved - David' where id = $1", [bossNote, david]),
      moveNote: await codeOf('update item_updates set item_id = $2 where id = $1', [bossNote, task[alice]]),
    };
    await as(null);
    const pinned = await one(`select (select module from boards where id = $1) as module, (select item_id from subtasks where id = $2) as sub_item,
      (select user_id from item_updates where id = $3) as author, (select text from item_updates where id = $3) as text,
      (select item_id from item_updates where id = $3) as note_item`, [board['Tender Portal'], generalSub, bossNote]);
    check("41. a board's module, a subtask's or update's task and an update's author can't be changed by a request (text edits still save)",
      Object.values(pins).every((c) => c === null) && pinned.module === 'projects' && pinned.sub_item === generalTask
        && pinned.author === boss && pinned.text === 'Approved - David' && pinned.note_item === generalTask, { pins, pinned });
    await db.query('delete from items where id = $1', [generalTask]);

    // A re-run changes nothing people did: an emptied board stays empty (no starting group comes back).
    await as(alice);
    await db.query('delete from board_groups where board_id = $1', [page[alice]]);
    await as(null);
    const rerun2 = await applyMigration6();
    const aliceGroups = (await one('select count(*)::int as n from board_groups where board_id = $1', [page[alice]])).n;
    check('41. re-running 0006 leaves a board whose groups were all deleted empty',
      rerun2 === null && aliceGroups === 0, { rerun2, aliceGroups });
    await db.query("insert into board_groups (id, board_key, board_id, name, color, position) values ($1, 'projects', $2, 'Active', '#c9ffe6', 0)",
      [pageGroup[alice], page[alice]]);
  }

  return { alice, boss, david, hello, carol, newcomer, early, late, board, page };
}

// Phase 7: 0007_outreach.sql (outreach mailboxes, the agent's emails read from its sheet, notes, the sheet's link) ---------

async function applyMigration7() {
  await as(null);
  try {
    await db.exec(migration7);
    return null;
  } catch (e) {
    await db.exec('rollback').catch(() => {});
    return e.message;
  }
}

const OUTREACH_TABLES = ['outreach_mailboxes', 'outreach_emails', 'outreach_notes', 'outreach_settings'];
const OUTREACH_FUNCTIONS = ['protect_outreach_note', 'protect_outreach_settings', 'outreach_daily', 'outreach_breakdown', 'outreach_access'];

// Everything 0007 makes (tables, columns, constraints, indexes, triggers, policies, functions, grants, realtime and the
// settings row), in a form that compares across runs and databases.
async function outreachShape(dbx) {
  const q = async (sql, params) => (await dbx.query(sql, params)).rows;
  const ofTables = "(select oid from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[]))";
  return {
    tables: await q(`select c.relname, c.relrowsecurity as rls, (select array_agg(a::text order by a::text) from unnest(c.relacl) a) as acl
      from pg_class c where c.oid in ${ofTables} order by c.relname`, [OUTREACH_TABLES]),
    columns: await q(`select table_name, column_name, udt_name, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = any($1::text[]) order by table_name, ordinal_position`, [OUTREACH_TABLES]),
    constraints: await q(`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid in ${ofTables} order by 1, 2`, [OUTREACH_TABLES]),
    indexes: await q(`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = any($1::text[])
      order by 1, 2`, [OUTREACH_TABLES]),
    triggers: await q(`select tgrelid::regclass::text as t, tgname, pg_get_triggerdef(oid) as def from pg_trigger
      where not tgisinternal and tgrelid in ${ofTables} order by 1, 2`, [OUTREACH_TABLES]),
    policies: await q(`select tablename, policyname, cmd, permissive, roles::text as roles, qual, with_check from pg_policies
      where schemaname = 'public' and tablename = any($1::text[]) order by 1, 2`, [OUTREACH_TABLES]),
    functions: await q(`select proname, prosecdef, provolatile, proconfig, md5(prosrc) as src, pg_get_function_identity_arguments(oid) as args,
        pg_get_function_result(oid) as result, (select array_agg(a::text order by a::text) from unnest(proacl) a) as acl
      from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1::text[]) order by 1`, [OUTREACH_FUNCTIONS]),
    published: (await q(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = any($1::text[]) order by 1`, [OUTREACH_TABLES])).map((r) => r.tablename),
    settings: await q('select id, sheet_url, sheet_by, synced_at, sync_error, sync_stats from public.outreach_settings order by id'),
  };
}
// The parts of two shapes that differ.
const shapeDiff = (a, b) => Object.keys({ ...a, ...b }).filter((k) => stable(a[k]) !== stable(b[k]));

// The google function's outreach-sync writes with the secret key: PostgREST's service_role (bypasses RLS) with no
// signed-in user. Supabase grants service_role everything on public tables and the auth schema (auth.uid() in column
// defaults and touch()); the stub doesn't, so phase 7 grants it.
async function asSecretKey() {
  await as(null);
  await db.exec('set role service_role');
}

// src/lib/outreach.js has relative imports only, so Node loads it as it is (the store's demo mode runs the same code).
const outreachLib = () => import('../src/lib/outreach.js');

async function applyMigration8() {
  await as(null);
  try {
    await db.exec(migration8);
    return null;
  } catch (e) {
    await db.exec('rollback').catch(() => {});
    return e.message;
  }
}

// 59–62. 0008: Pipeline's stages are Opportunities → Contacted → First meetings → Demos (no Won) --------------------------
async function phase8(ctx) {
  const { david, boss, hello, newcomer } = ctx;
  const pipelineDef = async () => (await one("select pg_get_functiondef('public.contact_pipeline()'::regprocedure) as d")).d;
  // Before 0008: a Won deal made a client, a Won deal that wasn't, and deals linked to contacts at Contacted, Demos and
  // Opportunities.
  await as(boss);
  const client = (await one("insert into clients (name) values ('Example Rail') returning id")).id;
  const deal = async (name, stage, extra = {}) => (await one(`insert into deals (name, stage, owner_id, client_id, contact_id)
    values ($1, $2, $3, $4, $5) returning id`, [name, stage, boss, extra.client || null, extra.contact || null])).id;
  const contact = async (name) => (await one("insert into contacts (name, org, status, owner_id) values ($1, 'Example Org', 'Sent', $2) returning id",
    [name, boss])).id;
  const wonClient = await deal('Example Rail', 'Won', { client });
  const wonPlain = await deal('Example Port', 'Won');
  const [cContacted, cDemos, cOpp] = [await contact('Casey Contacted'), await contact('Dana Demos'), await contact('Oli Opportunity')];
  const dContacted = await deal('Contacted Org', 'Contacted', { contact: cContacted });
  const dDemos = await deal('Demos Org', 'Demos', { contact: cDemos });
  const dOpp = await deal('Opportunity Org', 'Opportunities', { contact: cOpp });

  const first = await applyMigration8();
  const def1 = await pipelineDef();
  const second = await applyMigration8();
  await as(null);
  const splitErrors = await runSplit(db, migration8, { continueOnError: true });
  const def2 = await pipelineDef();
  const stageOf = async (id) => (await one('select stage, client_id from deals where id = $1', [id]));
  const won = { client: await stageOf(wonClient), plain: await stageOf(wonPlain) };
  check('59. 0008 runs, re-runs and runs statement by statement (the editor) to the same contact_pipeline(); never mentions module_level',
    first === null && second === null && splitErrors.length === 0 && def1 === def2 && !/module_level/.test(migration8),
    { first, second, splitErrors });
  check('60. 0008: Won deals move to Demos; one made a client keeps it (and stays off the board)',
    won.client.stage === 'Demos' && won.client.client_id === client && won.plain.stage === 'Demos' && won.plain.client_id === null, won);

  await as(boss);
  await db.query("update contacts set status = 'Meeting booked' where id = any($1::uuid[])", [[cContacted, cDemos, cOpp]]);
  const booked = { contacted: (await stageOf(dContacted)).stage, demos: (await stageOf(dDemos)).stage, opp: (await stageOf(dOpp)).stage };
  check('61. contact_pipeline (0008): a booking moves a deal on to First meetings from Opportunities or Contacted, never back from Demos',
    booked.contacted === 'First meetings' && booked.opp === 'First meetings' && booked.demos === 'Demos', booked);

  // Editing a deal (Pipeline's Edit deal) is Pipeline edit: admins, and staff only with an Edit override.
  await as(david);
  await db.query(`insert into module_access (user_id, module, level) values ($1, 'pipeline', 'edit')
    on conflict (user_id, module) do update set level = excluded.level`, [newcomer]);
  const edits = {};
  for (const [name, user] of Object.entries({ hello, newcomer, boss })) {
    await as(user);
    edits[name] = {
      update: await affected("update deals set name = $2, value = 5000, priority = 'P1', next_step = 'Call' where id = $1", [dOpp, `Edited by ${name}`]),
      stage: await affected("update deals set stage = 'Contacted' where id = $1", [dOpp]),
    };
  }
  const deletes = {};
  for (const [name, user, id] of [['hello', hello, dDemos], ['newcomer', newcomer, dDemos], ['boss', boss, dContacted]]) {
    await as(user);
    deletes[name] = await affected('delete from deals where id = $1', [id]);
  }
  await as(null);
  check('62. deals: staff at Pipeline view can’t edit, move or delete one; staff with Pipeline edit and admins can',
    edits.hello.update === 0 && edits.hello.stage === 0 && deletes.hello === 0
      && edits.newcomer.update === 1 && edits.newcomer.stage === 1 && deletes.newcomer === 1
      && edits.boss.update === 1 && edits.boss.stage === 1 && deletes.boss === 1,
    { edits, deletes });

  // 63. Work in Progress: a team board of the pipeline board module, under the deals --------------------------------------
  {
    await as(null);
    const wip = await rows(`select b.id, b.name, b.position, (select array_agg(g.name order by g.position) from public.board_groups g where g.board_id = b.id) as groups
      from public.boards b where b.module = 'pipeline'`);
    const lists = (await rows(`select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conname in ('boards_module_check', 'board_groups_board_key_check', 'items_board_key_check') order by conname`))
      .map((r) => ['projects', 'marketing', 'outreach', 'clients', 'pipeline'].every((m) => r.def.includes(`'${m}'`)));
    const group = wip[0] && (await one('select id from public.board_groups where board_id = $1 order by position limit 1', [wip[0].id])).id;
    const add = async (user, name) => { await as(user); return error(`insert into items (board_key, group_id, name, "values") values ('pipeline', $1, $2, $3)`,
      [group, name, { details: 'Kick-off', status: 'In progress', people: [] }]); };
    const adds = { viewer: await add(hello, 'Nope'), editor: await add(newcomer, 'Example Council'), admin: await add(boss, 'Example Port') };
    await as(hello);
    const seenByStaff = (await rows("select name from public.boards where module = 'pipeline'")).map((r) => r.name);
    // A re-run of 0008 (and of 0007) after Work in Progress is renamed or deleted brings nothing back and keeps pipeline.
    await as(null);
    await db.query("update public.boards set name = 'WIP' where module = 'pipeline'");
    const again = [await applyMigration8(), await applyMigration7()];
    const afterRename = (await rows("select name from public.boards where module = 'pipeline'")).map((r) => r.name);
    await db.query("delete from public.boards where module = 'pipeline'");
    const third = await applyMigration8();
    const afterDelete = (await one("select count(*)::int as n from public.boards where module = 'pipeline'")).n;
    const stillAllowed = (await one("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'boards_module_check'")).def.includes("'pipeline'");
    check('63. 0008 starts Work in Progress (an Active group) once with the board checks widened to pipeline; it follows Pipeline access '
      + '(staff view read it, Pipeline edit and admins add rows); re-running 0008 or 0007 after a rename or delete brings nothing back',
      wip.length === 1 && wip[0].name === 'Work in Progress' && stable(wip[0].groups) === stable(['Active']) && lists.length === 3 && lists.every(Boolean)
        && adds.viewer !== null && adds.editor === null && adds.admin === null && stable(seenByStaff) === stable(['Work in Progress'])
        && again.every((e) => e === null) && stable(afterRename) === stable(['WIP']) && third === null && afterDelete === 0 && stillAllowed,
      { wip, lists, adds, seenByStaff, again, afterRename, third, afterDelete, stillAllowed });
  }
  await as(null);
  return ctx;
}

// Phase 9: 0009_calendar.sql (the team's calendar events, each person's Google meetings, the calendar sync, a calendar on
// boards) -----------------------------------------------------------------------------------------------------------

async function applyMigration9() {
  await as(null);
  try {
    await db.exec(migration9);
    return null;
  } catch (e) {
    await db.exec('rollback').catch(() => {});
    return e.message;
  }
}

const CALENDAR_TABLES = ['public.calendar_events', 'public.calendar_meetings', 'private.calendar_sync'];
const CALENDAR_FUNCTIONS = ['public.calendar_claim', 'public.calendar_save', 'public.calendar_status', 'public.calendar_forget',
  'public.calendar_share', 'public.calendar_stop', 'public.protect_calendar_event', 'public.google_me', 'private.has_calendar'];
const SCOPE = {
  read: 'https://www.googleapis.com/auth/calendar.readonly',
  full: 'https://www.googleapis.com/auth/calendar',
  events: 'https://www.googleapis.com/auth/calendar.events',
  business: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/drive',
};

// Everything 0009 makes (tables, columns, constraints, indexes, triggers, policies, functions, grants, realtime, the
// boards column and google_accounts' calendar flag), in a form that compares across runs and databases.
async function calendarShape(dbx) {
  const q = async (sql, params) => (await dbx.query(sql, params)).rows;
  const ofTables = `(select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname || '.' || c.relname = any($1::text[]))`;
  return {
    tables: await q(`select c.oid::regclass::text as t, c.relrowsecurity as rls, (select array_agg(a::text order by a::text) from unnest(c.relacl) a) as acl
      from pg_class c where c.oid in ${ofTables} order by 1`, [CALENDAR_TABLES]),
    columns: await q(`select table_schema, table_name, column_name, udt_name, is_nullable, column_default from information_schema.columns
      where table_schema || '.' || table_name = any($1::text[]) or (table_schema = 'public' and table_name = 'boards' and column_name = 'calendar')
        or (table_schema = 'private' and table_name = 'google_accounts' and column_name = 'calendar')
      order by 1, 2, ordinal_position`, [CALENDAR_TABLES]),
    constraints: await q(`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid in ${ofTables} order by 1, 2`, [CALENDAR_TABLES]),
    indexes: await q(`select schemaname, tablename, indexname, indexdef from pg_indexes
      where schemaname || '.' || tablename = any($1::text[]) order by 1, 2, 3`, [CALENDAR_TABLES]),
    triggers: await q(`select tgrelid::regclass::text as t, tgname, pg_get_triggerdef(oid) as def from pg_trigger
      where not tgisinternal and (tgrelid in ${ofTables} or tgname = 'calendar_forget') order by 1, 2`, [CALENDAR_TABLES]),
    policies: await q(`select schemaname, tablename, policyname, cmd, permissive, roles::text as roles, qual, with_check from pg_policies
      where schemaname || '.' || tablename = any($1::text[]) order by 1, 2, 3`, [CALENDAR_TABLES]),
    functions: await q(`select pronamespace::regnamespace::text as ns, proname, prosecdef, provolatile, proconfig, md5(prosrc) as src,
        pg_get_function_identity_arguments(oid) as args, pg_get_function_result(oid) as result,
        (select array_agg(a::text order by a::text) from unnest(proacl) a) as acl
      from pg_proc where pronamespace::regnamespace::text || '.' || proname = any($1::text[]) order by 1, 2`, [CALENDAR_FUNCTIONS]),
    published: (await q(`select schemaname || '.' || tablename as t from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname || '.' || tablename = any($1::text[]) order by 1`, [CALENDAR_TABLES])).map((r) => r.t),
  };
}

// 64–78. 0009: the team Calendar and a calendar on boards (docs/PHASE2.md §15) ---------------------------------------------
async function phase9(ctx) {
  const { alice, boss, david, hello, carol, newcomer, early, late, board } = ctx;
  const calendarBoards = async (dbx = db) => (await dbx.query(`select module || ':' || name as b from public.boards
    where calendar order by 1`)).rows.map((r) => r.b);

  // 64. On the database the phases above leave behind: whole, again, and statement by statement --------------------------

  await as(null);
  // A decoy: a Projects team board also called Posting schedule (only Marketing's team board gets the calendar).
  await db.query("insert into public.boards (module, name, position) values ('projects', 'Posting schedule', 9)");
  const publishedBefore = (await one("select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime'")).n;
  const first = await applyMigration9();
  const body = migration9.replace(/--.*$/gm, '').trim();
  check('64. 0009 runs on top of 0008 and its rows, as one transaction (begin … commit when run whole)',
    first === null && /^begin;/i.test(body) && /commit;$/i.test(body), first);
  if (first) return null;
  // Connections from before 0009 (David's business one, from phase 4) start not sharing.
  const existingFlags = (await rows('select user_id, calendar from private.google_accounts order by user_id'));
  const shape = await calendarShape(db);
  const flaggedFirst = await calendarBoards();
  const second = await applyMigration9();
  await as(null);
  const splitErrors = await runSplit(db, migration9, { continueOnError: true });
  const reshaped = await calendarShape(db);
  check('64. 0009 re-runs whole and statement by statement (the editor) cleanly, changing nothing, and never mentions module_level',
    second === null && !splitErrors.length && !shapeDiff(shape, reshaped).length && !migration9.includes('module_level')
      && stable(await calendarBoards()) === stable(flaggedFirst),
    { second, splitErrors, changed: shapeDiff(shape, reshaped) });

  // 65. On a fresh database after 0008: statement by statement ends as a whole run does; Supabase's default grants --------

  const freshAt8 = async (supabaseDefaults = false) => {
    const dbx = new PGlite({ extensions: { pgcrypto } });
    await dbx.exec(SUPABASE_STUB);
    if (supabaseDefaults) {
      await dbx.exec(`alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
        alter default privileges in schema public grant all on tables to service_role`);
    }
    for (const m of [migration, migration2, migration3, migration4, migration5, migration6, migration7, migration8]) await dbx.exec(m);
    return dbx;
  };
  const whole = await freshAt8();
  const wholeError = await whole.exec(migration9).then(() => null, (e) => e.message);
  const wholeShape = await calendarShape(whole);
  const wholeFlags = await calendarBoards(whole);
  await whole.close();
  const stop = await freshAt8();
  const stopErrors = await runSplit(stop, migration9);
  const stopShape = await calendarShape(stop);
  const stopFlags = await calendarBoards(stop);
  const againErrors = await runSplit(stop, migration9);
  const againShape = await calendarShape(stop);
  await stop.close();
  const carry = await freshAt8();
  const carryErrors = await runSplit(carry, migration9, { continueOnError: true });
  const carryShape = await calendarShape(carry);
  await carry.close();
  const statements = splitSql(migration9).length;
  check('65. 0009 run statement by statement on a fresh database (stopping at the first error, or carrying on) ends exactly as a '
    + 'whole run does, Posting schedule showing its calendar; a second statement-by-statement run changes nothing',
    statements > 25 && wholeError === null && !stopErrors.length && !carryErrors.length && !againErrors.length
      && !shapeDiff(wholeShape, stopShape).length && !shapeDiff(wholeShape, carryShape).length && !shapeDiff(wholeShape, againShape).length
      && stable(wholeFlags) === stable(['marketing:Posting schedule']) && stable(stopFlags) === stable(wholeFlags),
    { statements, wholeError, stopErrors, carryErrors, againErrors, stop: shapeDiff(wholeShape, stopShape),
      carry: shapeDiff(wholeShape, carryShape), again: shapeDiff(wholeShape, againShape), wholeFlags, stopFlags });
  check('65. ...and a fresh database ends with the same tables, policies, functions, triggers and grants as the used one',
    !shapeDiff(wholeShape, shape).length, shapeDiff(wholeShape, shape));

  const supa = await freshAt8(true);
  const supaRun = await supa.exec(migration9).then(() => null, (e) => e.message);
  const supaFns = supaRun ?? (await supa.query(`select f, has_function_privilege('anon', f, 'execute') as anon,
      has_function_privilege('authenticated', f, 'execute') as signed_in, has_function_privilege('service_role', f, 'execute') as secret
    from unnest(array['public.calendar_claim(int)', 'public.calendar_save(uuid, timestamptz, date, date, jsonb, text, boolean)',
      'public.calendar_share(uuid)', 'public.calendar_status()', 'public.calendar_stop()', 'public.google_me()',
      'private.has_calendar(text)']) f`)).rows;
  const supaTables = supaRun ?? (await supa.query(`select t,
      (select string_agg(p, ',') from unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p
        where has_table_privilege('anon', t, p)) as anon,
      (select string_agg(p, ',') from unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p
        where has_table_privilege('authenticated', t, p)) as signed_in
    from unnest(array['public.calendar_events', 'public.calendar_meetings']) t order by t`)).rows;
  await supa.close();
  const fn = (name) => (Array.isArray(supaFns) ? supaFns.find((r) => r.f.startsWith(name)) : null) || {};
  check('65. with Supabase\'s defaults (new functions granted to anon and everyone), anon calls none of them; signed-in users only '
    + 'calendar_status, calendar_stop and google_me; only the secret key claims, saves and shares; has_calendar is nobody\'s; anon '
    + 'reaches neither table and signed-in users only read the meetings',
    supaRun === null && supaFns.length === 7 && supaFns.every((r) => !r.anon)
      && !fn('public.calendar_claim').signed_in && fn('public.calendar_claim').secret
      && !fn('public.calendar_save').signed_in && fn('public.calendar_save').secret
      && !fn('public.calendar_share').signed_in && fn('public.calendar_share').secret
      && fn('public.calendar_status').signed_in && fn('public.calendar_stop').signed_in && fn('public.google_me').signed_in
      && !fn('private.has_calendar').signed_in && !fn('private.has_calendar').secret
      && supaTables.every((r) => r.anon === null) && supaTables.find((r) => r.t === 'public.calendar_meetings')?.signed_in === 'select',
    { supaRun, supaFns, supaTables });

  // 66. boards.calendar: on for Marketing's Posting schedule once; admins switch it; a re-run never switches it back ---------

  const posting = board['Posting schedule'];
  const column = await one(`select data_type, is_nullable, column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'boards' and column_name = 'calendar'`);
  const staffSwitch = {};
  for (const [name, user] of Object.entries({ hello, newcomer, alice })) {
    await as(user);
    staffSwitch[name] = {
      off: await affected('update public.boards set calendar = false where id = $1', [posting]),
      on: await affected("update public.boards set calendar = true where module = 'marketing' and owner_id is null and id <> $1", [posting]),
    };
  }
  await as(boss);
  const renamed = await affected("update public.boards set name = 'Posting plan' where id = $1", [posting]);
  const afterRename = await calendarBoards();
  const switchedOff = await affected('update public.boards set calendar = false where id = $1', [posting]);
  const rerunOff = await applyMigration9();
  const afterRerun = await calendarBoards();
  await as(boss);
  const pageSwitch = await affected('update public.boards set calendar = true where id = $1', [ctx.page[alice]]);
  const switchedOn = await affected("update public.boards set calendar = true, name = 'Posting schedule' where id = $1", [posting]);
  await as(null);
  const afterOn = await calendarBoards();
  check('66. boards.calendar (boolean, not null, default false) starts on for Marketing\'s Posting schedule team board only (not a '
    + 'Projects board of that name); a rename keeps it; staff can\'t switch it; admins switch team boards (never a personal '
    + 'page); switched off, a re-run of 0009 leaves it off',
    column?.data_type === 'boolean' && column.is_nullable === 'NO' && column.column_default === 'false'
      && stable(flaggedFirst) === stable(['marketing:Posting schedule'])
      && Object.values(staffSwitch).every((s) => s.off === 0 && s.on === 0)
      && renamed === 1 && stable(afterRename) === stable(['marketing:Posting plan']) && switchedOff === 1
      && rerunOff === null && stable(afterRerun) === stable([]) && pageSwitch === 0 && switchedOn === 1
      && stable(afterOn) === stable(['marketing:Posting schedule']),
    { column, flaggedFirst, staffSwitch, renamed, afterRename, switchedOff, rerunOff, afterRerun, pageSwitch, switchedOn, afterOn });

  // 67. calendar_events: who sees, adds, changes and removes what -------------------------------------------------------

  const addEvent = async (user, f = {}) => {
    if (user === 'anon') { await as(null); await db.exec('set role anon'); } else await as(user);
    const pick = (k, d) => (k in f ? f[k] : d);
    const r = await attempt(`insert into public.calendar_events (kind, title, day, end_day, starts_at, ends_at, people, created_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8) returning id, created_by`,
    [pick('kind', 'event'), pick('title', 'Event'), pick('day', '2026-10-22'), pick('endDay', null), pick('startsAt', null),
      pick('endsAt', null), pick('people', []), pick('createdBy', null)]);
    await as(null);
    return r;
  };
  const helloEvent = await addEvent(hello, { title: 'Site visit', createdBy: boss, people: [hello, alice] });
  const helloSpare = await addEvent(hello, { title: 'Spare', kind: 'reminder' });
  const bossEvent = await addEvent(boss, { kind: 'meeting', title: 'Board meeting', startsAt: '2026-10-22T23:00:00Z', endsAt: '2026-10-23T00:00:00Z' });
  const bossSpare = await addEvent(boss, { title: 'Conference', day: '2026-11-02', endDay: '2026-11-04' });
  const carolAdd = await addEvent(carol);
  const anonAdd = await addEvent('anon');
  const ownerAdd = await addEvent(null, { title: 'From the SQL editor', createdBy: alice });
  const ids = [helloEvent?.id, helloSpare?.id, bossEvent?.id, bossSpare?.id];
  const seen = {};
  for (const [name, user] of Object.entries({ hello, alice, boss, carol })) {
    await as(user);
    seen[name] = (await one('select count(*)::int as n from public.calendar_events where id = any($1::uuid[])', [ids])).n;
  }
  await as(null);
  await db.exec('set role anon');
  const anonRead = await error('select * from public.calendar_events');
  await as(hello);
  const own = {
    update: await affected("update public.calendar_events set title = 'Site visit (moved)', day = '2026-10-23' where id = $1", [helloEvent?.id]),
    reassign: await affected('update public.calendar_events set created_by = $2 where id = $1', [helloEvent?.id, alice]),
    others: await affected("update public.calendar_events set title = 'Mine now' where id = $1", [bossEvent?.id]),
    othersDelete: await affected('delete from public.calendar_events where id = $1', [bossEvent?.id]),
    delete: await affected('delete from public.calendar_events where id = $1', [helloSpare?.id]),
  };
  await as(alice);
  const helloRow = (await one('select row_to_json(e) as r from public.calendar_events e where id = $1', [helloEvent?.id]))?.r;
  const other = {
    update: await affected("update public.calendar_events set title = 'Changed' where id = $1", [helloEvent?.id]),
    delete: await affected('delete from public.calendar_events where id = $1', [helloEvent?.id]),
    upsert: await postgrestUpsert('calendar_events', [normalizeRow('calendar_events', { ...helloRow, title: 'Changed' })]),
  };
  await as(carol);
  const inactive = {
    update: await affected("update public.calendar_events set title = 'Changed' where id = $1", [helloEvent?.id]),
    delete: await affected('delete from public.calendar_events where id = $1', [bossSpare?.id]),
  };
  await as(boss);
  const admin = {
    update: await affected("update public.calendar_events set title = 'Site visit (confirmed)' where id = $1", [helloEvent?.id]),
    upsert: await postgrestUpsert('calendar_events', [normalizeRow('calendar_events', { ...helloRow, title: 'Site visit (confirmed)', created_by: boss })]),
  };
  await as(early);
  const otherAdminDelete = await affected('delete from public.calendar_events where id = $1', [bossSpare?.id]);
  await as(null);
  const after = await one('select title, day, created_by, updated_by from public.calendar_events where id = $1', [helloEvent?.id]);
  const left = (await rows('select id from public.calendar_events where id = any($1::uuid[]) order by title', [ids])).map((r) => r.id);
  check('67. calendar_events: staff add events as themselves (a spoofed created_by is replaced; the SQL editor may set it) and every '
    + 'staff member sees them; their author changes and removes their own, never someone else\'s or who added it',
    helloEvent?.created_by === hello && bossEvent?.created_by === boss && ownerAdd?.created_by === alice
      && seen.hello === 4 && seen.alice === 4 && seen.boss === 4 && seen.carol === 0
      && own.update === 1 && own.reassign === 1 && own.others === 0 && own.othersDelete === 0 && own.delete === 1,
    { helloEvent, bossEvent, ownerAdd, seen, own });
  check('67. ...another staff member can\'t change or remove it (nor upsert over it); an inactive account sees and writes nothing; anon '
    + 'nothing; admins change and remove anyone\'s, and the author stays',
    other.update === 0 && other.delete === 0 && typeof other.upsert === 'string' && typeof carolAdd === 'string'
      && inactive.update === 0 && inactive.delete === 0 && typeof anonAdd === 'string' && anonRead !== null
      && admin.update === 1 && admin.upsert === null && otherAdminDelete === 1 && after?.title === 'Site visit (confirmed)'
      && after.created_by === hello && after.updated_by === boss && stable(left) === stable([bossEvent?.id, helloEvent?.id]),
    { other, carolAdd, inactive, anonAdd, anonRead, admin, otherAdminDelete, after, left });

  // 68. calendar_events: what a row may hold -------------------------------------------------------------------------

  const shapes = {
    kind: await addEvent(hello, { kind: 'party' }),
    longTitle: await addEvent(hello, { title: 'x'.repeat(201) }),
    maxTitle: await addEvent(hello, { title: 'x'.repeat(200) }),
    noDay: await addEvent(hello, { day: null }),
    endBefore: await addEvent(hello, { day: '2026-10-22', endDay: '2026-10-21' }),
    sameDay: await addEvent(hello, { day: '2026-10-22', endDay: '2026-10-22' }),
    endOnly: await addEvent(hello, { endsAt: '2026-10-22T02:00:00Z' }),
    endsFirst: await addEvent(hello, { startsAt: '2026-10-22T02:00:00Z', endsAt: '2026-10-22T01:00:00Z' }),
    startOnly: await addEvent(hello, { kind: 'reminder', startsAt: '2026-10-22T02:00:00Z' }),
    timed: await addEvent(hello, { kind: 'meeting', startsAt: '2026-10-22T01:00:00Z', endsAt: '2026-10-22T01:00:00Z' }),
  };
  const refusedShape = ['kind', 'longTitle', 'noDay', 'endBefore', 'endOnly', 'endsFirst'];
  const savedShape = ['maxTitle', 'sameDay', 'startOnly', 'timed'];
  await as(hello);
  const defaults = await attempt("insert into public.calendar_events (day) values ('2026-12-01') returning id, kind, title, end_day, starts_at, ends_at, people, created_by");
  await as(null);
  check('68. calendar_events checks: kind is meeting, event or reminder; a title of at most 200; a day; end_day not before day; ends_at '
    + 'only with starts_at and not before it; an all-day event (no times) by default',
    refusedShape.every((k) => typeof shapes[k] === 'string') && savedShape.every((k) => typeof shapes[k]?.id === 'string')
      && defaults?.kind === 'event' && defaults.title === '' && defaults.end_day === null && defaults.starts_at === null
      && defaults.ends_at === null && stable(defaults.people) === stable([]) && defaults.created_by === hello,
    { shapes, defaults });
  await db.query('delete from public.calendar_events where id = any($1::uuid[])',
    [[...savedShape.map((k) => shapes[k]?.id), ownerAdd?.id, defaults?.id].filter(Boolean)]);

  // 69. Tables, grants and realtime --------------------------------------------------------------------------------------

  const tableInfo = await rows(`select t,
      (select relrowsecurity from pg_class where oid = t::regclass) as rls,
      exists (select 1 from pg_trigger where tgrelid = t::regclass and tgname = 'touch') as touch,
      exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname || '.' || tablename = t) as published,
      (select string_agg(p, ',') from unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p where has_table_privilege('anon', t, p)) as anon,
      (select string_agg(p, ',') from unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p
        where has_table_privilege('authenticated', t, p)) as signed_in
    from unnest($1::text[]) as t order by t`, [CALENDAR_TABLES]);
  const info = Object.fromEntries(tableInfo.map(({ t, ...r }) => [t, r]));
  const noRls = await rows(`select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind = 'r' and not c.relrowsecurity`);
  const publishedAfter = (await one("select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime'")).n;
  check('69. calendar tables: RLS on (private.calendar_sync too), no anon access; signed-in users write events (touch()), only read '
    + 'meetings, and never reach the sync table',
    CALENDAR_TABLES.every((t) => info[t]?.rls && info[t].anon === null) && !noRls.length
      && info['public.calendar_events'].touch && info['public.calendar_events'].signed_in.startsWith('select,insert,update,delete')
      && info['public.calendar_meetings'].signed_in === 'select' && info['private.calendar_sync'].signed_in === null,
    { info, noRls });
  check('69. realtime publishes calendar_events (38 → 39 tables), never the meetings or the sync table',
    publishedBefore === 38 && publishedAfter === 39 && info['public.calendar_events'].published
      && !info['public.calendar_meetings'].published && !info['private.calendar_sync'].published,
    { publishedBefore, publishedAfter });

  // 70. Who may call what -----------------------------------------------------------------------------------------------

  const fnInfo = await rows(`select f, has_function_privilege('anon', f, 'execute') as anon,
      has_function_privilege('authenticated', f, 'execute') as signed_in, has_function_privilege('service_role', f, 'execute') as secret,
      (select prosecdef from pg_proc where oid = f::regprocedure) as definer
    from unnest(array['public.calendar_claim(int)', 'public.calendar_save(uuid, timestamptz, date, date, jsonb, text, boolean)',
      'public.calendar_share(uuid)', 'public.calendar_status()', 'public.calendar_stop()', 'public.google_me()',
      'private.has_calendar(text)']) f`);
  const fi = Object.fromEntries(fnInfo.map(({ f, ...r }) => [f.replace(/\(.*$/, ''), r]));
  const tryCalls = async (user) => {
    if (user === 'anon') { await as(null); await db.exec('set role anon'); } else await as(user);
    const r = {
      claim: await error('select public.calendar_claim(30)'),
      save: await error("select public.calendar_save($1, now(), '2026-10-01', '2026-12-31', '[]'::jsonb)", [hello]),
      share: await error('select public.calendar_share($1)', [user === 'anon' ? hello : user]),
      status: await error('select public.calendar_status()'),
      hasCalendar: await error("select private.has_calendar('x')"),
    };
    await as(null);
    return r;
  };
  const calls = { staff: await tryCalls(hello), admin: await tryCalls(david), inactive: await tryCalls(carol), anon: await tryCalls('anon') };
  check('70. calendar_claim, calendar_save and calendar_share are the secret key\'s only (security definer; nobody signed in shares '
    + 'even their own calendar); calendar_status and calendar_stop are for signed-in staff; private.has_calendar is no one\'s to call',
    fi['public.calendar_claim'].secret && !fi['public.calendar_claim'].signed_in && !fi['public.calendar_claim'].anon
      && fi['public.calendar_save'].secret && !fi['public.calendar_save'].signed_in && !fi['public.calendar_save'].anon
      && fi['public.calendar_share'].secret && !fi['public.calendar_share'].signed_in && !fi['public.calendar_share'].anon
      && fi['public.calendar_stop'].signed_in && !fi['public.calendar_stop'].anon
      && fi['public.calendar_status'].signed_in && !fi['public.calendar_status'].anon && fi['public.google_me'].signed_in
      && !fi['public.google_me'].anon && !fi['private.has_calendar'].signed_in && !fi['private.has_calendar'].anon
      && fnInfo.filter((r) => r.f.startsWith('public.')).every((r) => r.definer)
      && Object.values(calls).every((c) => c.claim !== null && c.save !== null && c.share !== null && c.hasCalendar !== null)
      && calls.staff.status === null && calls.admin.status === null && calls.inactive.status !== null && calls.anon.status !== null,
    { fnInfo, calls });

  // 71. Which scopes read the calendar; google_me says so -------------------------------------------------------------

  const hasCalendar = await rows(`select s, private.has_calendar(s) as ok from unnest($1::text[]) with ordinality as x (s, i) order by i`, [[
    null, '', SCOPE.read, SCOPE.full, `openid email ${SCOPE.read}`, `openid  email\n${SCOPE.full} ${SCOPE.business}`,
    SCOPE.events, `${SCOPE.read}.x`, `x${SCOPE.full}`, `${SCOPE.full}/`, SCOPE.business, 'calendar.readonly',
  ]]);
  check('71. has_calendar: true only when one whole space-separated scope is calendar.readonly or calendar (not calendar.events, a '
    + 'longer or shorter look-alike, or none)',
    stable(hasCalendar.map((r) => r.ok)) === stable([false, false, true, true, true, true, false, false, false, false, false, false]),
    hasCalendar);

  // Google connections from here on: David business and calendar; Hello (staff) the calendar only; Boss the full calendar
  // scope; Josh (early) business only; New (newcomer) calendar.events only; Carol (inactive) the calendar; Late the calendar
  // but no longer an @assetstackai.com address (changed in the SQL editor); Alice none. Each is first stored as the
  // callback stores any connect (google_save), then the Calendar connects share (calendar_share, as the callback does for
  // purpose calendar): David, Hello, Boss, Carol and Late; Josh and New try and can't (no calendar scope stored).
  const connect = async (user, email, scopes, { share = false } = {}) => {
    await asSecretKey();
    await db.query("select public.google_save($1, $2, 'refresh-token', $3)", [user, email, scopes]);
    const shared = share ? (await db.query('select public.calendar_share($1) as ok', [user])).rows[0].ok : null;
    await as(null);
    return shared;
  };
  const shareCalendar = async (user) => {
    await asSecretKey();
    const r = await attempt('select public.calendar_share($1) as ok', [user]);
    await as(null);
    return typeof r === 'string' ? r : r?.ok;
  };
  const flagOf = async (user) => (await one('select calendar from private.google_accounts where user_id = $1', [user]))?.calendar ?? null;
  const meOf = async (user) => {
    await as(user);
    const r = (await one('select public.google_me() as me')).me;
    await as(null);
    return r;
  };
  const connectedNow = async () => {
    await as(alice);
    const s = (await one('select public.calendar_status() as s')).s;
    await as(null);
    return s.people.filter((p) => p.connected).map((p) => p.user_id).sort();
  };
  const claim = async (gap) => {
    await asSecretKey();
    const r = await db.query(gap === undefined ? 'select c as id from public.calendar_claim() c' : 'select c as id from public.calendar_claim($1) c',
      gap === undefined ? [] : [gap]);
    await as(null);
    return r.rows.map((x) => x.id).sort();
  };
  await connect(david, 'super.example@assetstackai.com', `openid email ${SCOPE.business} ${SCOPE.read}`);
  await connect(hello, 'staff.example@assetstackai.com', `openid email ${SCOPE.read}`);
  await connect(boss, 'boss@assetstackai.com', `openid email ${SCOPE.full}`);
  await connect(early, 'you@assetstackai.com', `openid email ${SCOPE.business}`);
  await connect(newcomer, 'new.example@assetstackai.com', `openid email ${SCOPE.events}`);
  await connect(carol, 'carol@assetstackai.com', `openid email ${SCOPE.read}`);
  await connect(late, 'late.example@assetstackai.com', `openid email ${SCOPE.read}`);
  const plain = { flags: {}, me: {} };
  for (const [name, user] of Object.entries({ david, hello, boss, early, newcomer, carol, late })) plain.flags[name] = await flagOf(user);
  for (const [name, user] of Object.entries({ david, hello, boss })) plain.me[name] = (await meOf(user)).calendar;
  plain.claimed = await claim();
  plain.connected = await connectedNow();
  plain.syncRows = (await one('select count(*)::int as n from private.calendar_sync')).n;
  check('71. a connection from before 0009 and a plain connect (google_save, no calendar_share) never share, even with '
    + 'calendar.readonly or calendar in their scopes: the flag is off, calendar_claim skips them, calendar_status shows them not '
    + 'connected and google_me says calendar false',
    stable(existingFlags) === stable([{ user_id: david, calendar: false }])
      && Object.values(plain.flags).every((f) => f === false) && Object.values(plain.me).every((c) => c === false)
      && stable(plain.claimed) === stable([]) && stable(plain.connected) === stable([]) && plain.syncRows === 0,
    { existingFlags, plain });

  const shared = {};
  for (const [name, user] of Object.entries({ david, hello, boss, carol, late, early, newcomer, alice })) shared[name] = await shareCalendar(user);
  shared.nobody = await shareCalendar(randomUUID());
  shared.again = await shareCalendar(hello);
  const sharedFlags = {};
  for (const [name, user] of Object.entries({ david, hello, boss, carol, late, early, newcomer, alice })) sharedFlags[name] = await flagOf(user);
  await db.query("update public.profiles set email = 'late.example@example.com' where id = $1", [late]);
  check('71. calendar_share (the callback, after a Calendar connect) turns sharing on only when the stored scopes read the calendar '
    + '(not business-only, calendar.events, no connection or no person), and says whether it did',
    stable(shared) === stable({ david: true, hello: true, boss: true, carol: true, late: true, early: false, newcomer: false, alice: false,
      nobody: false, again: true })
      && stable(sharedFlags) === stable({ david: true, hello: true, boss: true, carol: true, late: true, early: false, newcomer: false,
        alice: null }),
    { shared, sharedFlags });
  const me = {};
  for (const [name, user] of Object.entries({ david, hello, boss, early, newcomer, alice })) me[name] = await meOf(user);
  await as(carol);
  const carolMe = await error('select public.google_me()');
  await as(null);
  const flags = Object.fromEntries(Object.entries(me).map(([k, v]) => [k, [v.calendar, v.business]]));
  check('71. google_me keeps its fields (uid, name, email, admin, google_email, connected_at; never a token or scope) and adds calendar '
    + 'and business; staff and admins call it, inactive accounts can\'t',
    Object.values(me).every((v) => stable(Object.keys(v).sort()) === stable(['admin', 'business', 'calendar', 'connected_at', 'email',
      'google_email', 'name', 'uid']) && !/refresh|googleapis/.test(JSON.stringify(v)))
      && me.david.uid === david && me.david.admin === true && me.david.google_email === 'super.example@assetstackai.com'
      && me.hello.uid === hello && me.hello.admin === false && me.alice.google_email === null && me.alice.connected_at === null
      && stable(flags) === stable({
        david: [true, true], hello: [true, false], boss: [true, false], early: [false, true], newcomer: [false, false], alice: [false, false],
      })
      && typeof carolMe === 'string',
    { me, carolMe });

  // 72. calendar_claim: who is due a sync, at most once per gap ---------------------------------------------------------

  const ago = (user, seconds) => db.query("update private.calendar_sync set claimed_at = now() - make_interval(secs => $2) where user_id = $1",
    [user, seconds]);
  const sorted = (...list) => [...list].sort();
  const claims = { first: await claim(), again: await claim(), forced: await claim(60) };
  await ago(hello, 61);
  await ago(boss, 45);
  await ago(david, 20);
  claims.after61 = await claim(60);
  claims.floor = await claim(0);
  await ago(david, 599);
  claims.before600 = await claim();
  await ago(david, 601);
  claims.after600 = await claim();
  await db.query('update private.calendar_sync set claimed_at = null where user_id = $1', [hello]);
  claims.unclaimed = await claim();
  const syncRows = (await rows('select user_id from private.calendar_sync order by user_id')).map((r) => r.user_id);
  check('72. calendar_claim claims active @assetstackai.com staff who share their calendar (not business-only, '
    + 'calendar.events, inactive or another domain), each at most once per p_gap seconds (600 by default, never under 30)',
    stable(claims.first) === stable(sorted(boss, david, hello)) && stable(claims.again) === stable([]) && stable(claims.forced) === stable([])
      && stable(claims.after61) === stable([hello]) && stable(claims.floor) === stable([boss]) && stable(claims.before600) === stable([])
      && stable(claims.after600) === stable([david]) && stable(claims.unclaimed) === stable([hello])
      && stable(syncRows) === stable(sorted(boss, david, hello)),
    { claims, syncRows, expected: { boss, david, hello } });

  // 73. calendar_save: a person's meetings and their last sync -----------------------------------------------------------

  const save = async (user, started, list, { err = '', reconnect = false, from = '2026-10-01', to = '2026-12-31' } = {}) => {
    await asSecretKey();
    const r = await attempt(`select public.calendar_save($1::uuid, $2::timestamptz, $3::date, $4::date, $5::jsonb, $6::text, $7::boolean) as ok`,
      [user, started, from, to, JSON.stringify(list), err, reconnect]);
    await as(null);
    return typeof r === 'string' ? r : r?.ok;
  };
  const meeting = (id, f = {}) => {
    const start = f.start ?? '2026-10-22';
    const end = f.end ?? start;
    return {
      google_id: id, title: f.title ?? `Meeting ${id}`, busy: f.busy ?? false, all_day: Boolean(f.allDay), start_date: start, end_date: end,
      start_at: f.allDay ? null : `${start}T01:00:00.000Z`, end_at: f.allDay ? null : `${end}T02:00:00.000Z`,
    };
  };
  const meetingsOf = async (user) => (await rows(`select google_id, title, busy, all_day, start_date::text as start_date, end_date::text as end_date,
      start_at, end_at, synced_at from public.calendar_meetings where user_id = $1 order by google_id`, [user]))
    .map((r) => ({ ...r, start_at: r.start_at?.toISOString() ?? null, end_at: r.end_at?.toISOString() ?? null, synced_at: r.synced_at.toISOString() }));
  const syncOf = async (user) => {
    const r = await one('select claimed_at, synced_at, error, reconnect, events from private.calendar_sync where user_id = $1', [user]);
    return r && { synced_at: r.synced_at?.toISOString() ?? null, error: r.error, reconnect: r.reconnect, events: r.events };
  };
  const T = (m) => new Date(Date.UTC(2026, 9, 21, 0, m)).toISOString(); // runs started on 21 October, m minutes past midnight UTC
  const at = (list) => Object.fromEntries(list.map((r) => [r.google_id, r]));
  const runs = {};
  runs.first = await save(hello, T(10), [
    meeting('g1', { title: '  Standup  ' }), meeting('g2', { title: 'Private review', busy: true }),
    meeting('g3', { allDay: true, start: '2026-10-23', end: '2026-10-24' }), meeting('g4', { allDay: true, start: '2026-09-30', end: '2026-10-01' }),
    meeting('g5', { start: '2026-11-05' }), meeting('g6', { allDay: true, start: '2026-12-31', end: '2027-01-01' }),
    meeting('g9', { allDay: true, start: '2026-10-01' }),
  ]);
  const afterFirst = at(await meetingsOf(hello));
  const syncFirst = await syncOf(hello);
  runs.second = await save(hello, T(20), [meeting('g1', { title: 'Standup (moved)', start: '2026-10-29' }), meeting('g3', {
    allDay: true, start: '2026-10-23', end: '2026-10-24' })]);
  const afterSecond = at(await meetingsOf(hello));
  const syncSecond = await syncOf(hello);
  check('73. calendar_save stores a person\'s meetings (title trimmed; a private one busy with no title; all-day ones without times) '
    + 'and their sync (when, how many, no error)',
    runs.first === true && Object.keys(afterFirst).join() === 'g1,g2,g3,g4,g5,g6,g9' && afterFirst.g1.title === 'Standup'
      && afterFirst.g2.busy === true && afterFirst.g2.title === '' && afterFirst.g3.all_day === true && afterFirst.g3.start_at === null
      && afterFirst.g3.end_date === '2026-10-24' && afterFirst.g1.start_at === '2026-10-22T01:00:00.000Z'
      && Object.values(afterFirst).every((r) => r.synced_at === T(10))
      && stable(syncFirst) === stable({ synced_at: T(10), error: '', reconnect: false, events: 7 }),
    { runs, afterFirst, syncFirst });
  check('73. a newer run updates what it saw and removes what it didn\'t strictly inside the window (from and to inclusive); a meeting '
    + 'crossing the window\'s edge stays',
    runs.second === true && Object.keys(afterSecond).join() === 'g1,g3,g4,g6' && afterSecond.g1.title === 'Standup (moved)'
      && afterSecond.g1.start_date === '2026-10-29' && afterSecond.g1.synced_at === T(20) && afterSecond.g3.synced_at === T(20)
      && afterSecond.g4.synced_at === T(10) && afterSecond.g6.synced_at === T(10)
      && stable(syncSecond) === stable({ synced_at: T(20), error: '', reconnect: false, events: 2 }),
    { runs, afterSecond, syncSecond });

  runs.older = await save(hello, T(0), [meeting('g1', { title: 'Old title' }), meeting('g7', { start: '2026-11-10' })]);
  const afterOlder = at(await meetingsOf(hello));
  const syncOlder = await syncOf(hello);
  runs.failed = await save(hello, T(30), [meeting('g8')], { err: 'Too many events' });
  const afterFailed = at(await meetingsOf(hello));
  const syncFailed = await syncOf(hello);
  runs.reconnect = await save(hello, T(40), [], { err: 'Google needs reconnecting', reconnect: true });
  const syncReconnect = await syncOf(hello);
  runs.olderError = await save(hello, T(5), [], { err: 'An old error' });
  const syncOlderError = await syncOf(hello);
  runs.recovered = await save(hello, T(50), [meeting('g1', { title: 'Standup (moved)', start: '2026-10-29' }), meeting('g3', {
    allDay: true, start: '2026-10-23', end: '2026-10-24' })]);
  const afterRecovered = at(await meetingsOf(hello));
  const syncRecovered = await syncOf(hello);
  check('73. an older run never overwrites a newer one\'s meetings or sync; a run with an error writes and removes no meetings and '
    + 'keeps the last good sync\'s time and count; the next good run clears the error and reconnect flag',
    runs.older === true && afterOlder.g1.title === 'Standup (moved)' && afterOlder.g1.synced_at === T(20) && afterOlder.g7?.synced_at === T(0)
      && stable(syncOlder) === stable(syncSecond)
      && runs.failed === true && !afterFailed.g8 && afterFailed.g7 && Object.keys(afterFailed).join() === 'g1,g3,g4,g6,g7'
      && stable(syncFailed) === stable({ synced_at: T(20), error: 'Too many events', reconnect: false, events: 2 })
      && runs.reconnect === true && stable(syncReconnect) === stable({ synced_at: T(20), error: 'Google needs reconnecting', reconnect: true, events: 2 })
      && runs.olderError === true && stable(syncOlderError) === stable(syncReconnect)
      && runs.recovered === true && Object.keys(afterRecovered).join() === 'g1,g3,g4,g6' && afterRecovered.g1.synced_at === T(50)
      && stable(syncRecovered) === stable({ synced_at: T(50), error: '', reconnect: false, events: 2 }),
    { runs, afterOlder, syncOlder, afterFailed, syncFailed, syncReconnect, syncOlderError, afterRecovered, syncRecovered });

  runs.messy = await save(boss, T(10), [
    meeting('b1'), meeting('b1'), { ...meeting('b2'), google_id: '' }, { ...meeting('b3'), start_date: null },
    meeting('b4', { allDay: true, start: '2026-10-25', end: '2026-10-24' }), meeting('b5', { title: 'y'.repeat(250) }),
    { google_id: 'b6', start_date: '2026-10-26', end_date: '2026-10-26' },
  ]);
  const messy = at(await meetingsOf(boss));
  check('73. a malformed payload doesn\'t stop a save: a repeated meeting is saved once, one without an id or a start date is skipped, '
    + 'an end before the start is the start, a title is cut to 200, missing fields take their defaults',
    runs.messy === true && Object.keys(messy).join() === 'b1,b4,b5,b6' && messy.b4.end_date === '2026-10-25' && messy.b5.title.length === 200
      && messy.b6.title === '' && messy.b6.busy === false && messy.b6.all_day === false && messy.b6.start_at === null,
    { runs, messy });

  // 74. calendar_meetings: read by staff, written by no one signed in --------------------------------------------------

  const allMeetings = (await one('select count(*)::int as n from public.calendar_meetings')).n;
  const meetingAccess = {};
  for (const [name, user] of Object.entries({ hello, alice, boss, carol })) {
    await as(user);
    meetingAccess[name] = {
      read: (await one('select count(*)::int as n from public.calendar_meetings')).n,
      insert: await error("insert into public.calendar_meetings (user_id, google_id, start_date, end_date) values ($1, 'x', '2026-10-22', '2026-10-22')",
        [user]),
      update: await affected("update public.calendar_meetings set title = 'Changed' where user_id = $1", [user]),
      delete: await affected('delete from public.calendar_meetings where user_id = $1', [user]),
    };
  }
  await as(null);
  await db.exec('set role anon');
  const anonMeetings = await error('select * from public.calendar_meetings');
  await as(null);
  const meetingsAfter = (await one('select count(*)::int as n from public.calendar_meetings')).n;
  check('74. calendar_meetings: every active staff member reads everyone\'s; nobody signed in (not even an admin) inserts, changes or '
    + 'removes one; inactive accounts read nothing; anon nothing',
    allMeetings === 8 && meetingAccess.hello.read === 8 && meetingAccess.alice.read === 8 && meetingAccess.boss.read === 8
      && meetingAccess.carol.read === 0
      && Object.values(meetingAccess).every((a) => typeof a.insert === 'string' && typeof a.update === 'string' && typeof a.delete === 'string')
      && anonMeetings !== null && meetingsAfter === allMeetings,
    { allMeetings, meetingAccess, anonMeetings, meetingsAfter });

  // 75. calendar_status: the team's connections and syncs, never a token or scope --------------------------------------

  runs.bossReconnect = await save(boss, T(20), [], { err: 'Google needs reconnecting', reconnect: true });
  await as(alice);
  const status = (await one('select public.calendar_status() as s')).s;
  await as(null);
  const activeIds = (await rows('select id from public.profiles where active order by name, id')).map((r) => r.id);
  const person = (id) => status.people.find((p) => p.user_id === id);
  const iso = (v) => (v ? new Date(v).toISOString() : v);
  const earliest = (await one('select min(start_date)::text as d from public.calendar_meetings')).d;
  check('75. calendar_status (any staff member): every active person by name with whether they share their calendar and '
    + 'their last sync (when, error, reconnect needed); the earliest meeting kept and the newest sync; never a token or scope',
    stable(Object.keys(status).sort()) === stable(['earliest', 'people', 'synced_at'])
      && stable(status.people.map((p) => p.user_id)) === stable(activeIds) && !person(carol)
      && status.people.every((p) => stable(Object.keys(p).sort()) === stable(['connected', 'error', 'reconnect', 'synced_at', 'user_id']))
      && stable({ ...person(hello), synced_at: iso(person(hello)?.synced_at) })
        === stable({ user_id: hello, connected: true, synced_at: T(50), error: '', reconnect: false })
      && person(boss).connected === true && person(boss).error === 'Google needs reconnecting' && person(boss).reconnect === true
      && person(boss).synced_at !== null && person(david).connected === true && person(david).synced_at === null
      && person(early).connected === false && person(newcomer).connected === false && person(alice).connected === false
      && person(late).connected === true && status.earliest === earliest && earliest === '2026-09-30'
      && iso(status.synced_at) === T(50) && !/refresh|googleapis|scope/.test(JSON.stringify(status)),
    { status, activeIds, earliest });

  // 76. calendar_save forgets anyone no longer active staff sharing their calendar --------------------------------------

  const plant = async (user) => {
    await db.query(`insert into public.calendar_meetings (user_id, google_id, title, start_date, end_date) values ($1, 'planted', 'Planted',
      '2026-10-22', '2026-10-22') on conflict do nothing`, [user]);
    await db.query('insert into private.calendar_sync (user_id, synced_at) values ($1, now()) on conflict do nothing', [user]);
  };
  const leftFor = async (user) => (await one(`select (select count(*)::int from public.calendar_meetings where user_id = $1)
    + (select count(*)::int from private.calendar_sync where user_id = $1) as n`, [user])).n;
  const forgot = {};
  for (const [name, user] of Object.entries({ carol, late, alice, newcomer, early })) {
    await plant(user);
    const had = await leftFor(user);
    const ok = await save(user, T(60), [meeting('n1')]);
    forgot[name] = { had, ok, left: await leftFor(user) };
  }
  check('76. calendar_save forgets (and returns false for) someone inactive, no longer @assetstackai.com, with no Google account, or '
    + 'whose account doesn\'t read the calendar: their meetings and sync go, nothing new is written',
    Object.values(forgot).every((f) => f.had === 2 && f.ok === false && f.left === 0), forgot);

  // 77. Forgetting: disconnecting Google, reconnecting without the calendar, or being deactivated -------------------------

  runs.david = await save(david, T(60), [meeting('d1')]);
  runs.earlyShare = await connect(early, 'you@assetstackai.com', `openid email ${SCOPE.business} ${SCOPE.read}`, { share: true });
  runs.early = await save(early, T(60), [meeting('e1')]);
  const before77 = { hello: await leftFor(hello), boss: await leftFor(boss), david: await leftFor(david), early: await leftFor(early) };
  await as(hello);
  const disconnected = (await one('select public.google_disconnect() as ok')).ok;
  await as(null);
  // Boss (sharing) reconnects Gmail and Drive with a plain connect (no calendar_share): the token still carries the
  // calendar, and google_save leaves the flag alone, so Boss keeps sharing.
  await connect(boss, 'boss@assetstackai.com', `openid email ${SCOPE.business} ${SCOPE.full}`);
  const bossKept = { left: await leftFor(boss), flag: await flagOf(boss), me: (await meOf(boss)).calendar };
  await connect(boss, 'boss@assetstackai.com', `openid email ${SCOPE.business}`);
  const bossLost = { flag: await flagOf(boss), me: (await meOf(boss)).calendar };
  await as(david);
  const renameDavid = await affected("update public.profiles set name = 'Super Example', active = true where id = $1", [david]);
  const deactivate = await affected('update public.profiles set active = false where id = $1', [early]);
  await as(null);
  const after77 = { hello: await leftFor(hello), boss: await leftFor(boss), david: await leftFor(david), early: await leftFor(early) };
  await as(david);
  const reactivate = await affected('update public.profiles set active = true where id = $1', [early]);
  await as(null);
  const triggers = (await rows(`select tgrelid::regclass::text as t from pg_trigger where tgname = 'calendar_forget' order by 1`)).map((r) => r.t);
  check('77. a person\'s meetings and sync are forgotten when they disconnect Google, reconnect without the calendar (a plain '
    + 'reconnect with it, as an admin reconnecting Gmail and Drive, keeps the flag, the sharing and the meetings; google_save never '
    + 'touches the flag) or are deactivated (other profile changes keep them)',
    runs.earlyShare === true && runs.david === true && runs.early === true
      && stable(before77) === stable({ hello: 5, boss: 5, david: 2, early: 2 })
      && disconnected === true && stable(bossKept) === stable({ left: 5, flag: true, me: true })
      && stable(bossLost) === stable({ flag: true, me: false }) && renameDavid === 1 && deactivate === 1 && reactivate === 1
      && stable(after77) === stable({ hello: 0, boss: 0, david: 2, early: 0 })
      && stable(triggers) === stable(['private.google_accounts', 'profiles']),
    { runs, before77, disconnected, bossKept, bossLost, renameDavid, deactivate, after77, reactivate, triggers });

  // 78. Sharing is an explicit opt-in: reconnecting never restarts it; Stop sharing (calendar_stop) ---------------------

  // The regression: after a Calendar disconnect, a plain connect whose token still carries calendar.readonly (connect asks
  // for include_granted_scopes) must not start sharing again. Hello (staff) disconnected above; a fresh google_save:
  await connect(hello, 'staff.example@assetstackai.com', `openid email ${SCOPE.read}`);
  await plant(hello);
  const helloPlain = {
    flag: await flagOf(hello), me: (await meOf(hello)).calendar, claimed: (await claim(30)).includes(hello),
    connected: (await connectedNow()).includes(hello), save: await save(hello, T(70), [meeting('h1')]), left: await leftFor(hello),
  };
  // David (admin, sharing, with a meeting and a sync) stops sharing: his business connection stays, the flag goes off,
  // his meetings and sync go; a second call changes nothing. Then a plain reconnect (Settings → Business) whose token
  // still has the calendar doesn't start sharing again; only a Calendar connect does.
  const davidBefore = await leftFor(david);
  const rowOf = async (user) => one(`select email, refresh_token, scopes, calendar from private.google_accounts where user_id = $1`, [user]);
  const davidRow = await rowOf(david);
  await as(david);
  const davidStop = { first: (await one('select public.calendar_stop() as ok')).ok, again: (await one('select public.calendar_stop() as ok')).ok };
  await as(null);
  const davidStopped = { row: await rowOf(david), left: await leftFor(david), me: await meOf(david) };
  await connect(david, 'super.example@assetstackai.com', `openid email ${SCOPE.business} ${SCOPE.read}`);
  const davidPlain = {
    flag: await flagOf(david), me: (await meOf(david)).calendar, claimed: (await claim(30)).includes(david),
    connected: (await connectedNow()).includes(david),
  };
  const davidReshare = await connect(david, 'super.example@assetstackai.com', `openid email ${SCOPE.business} ${SCOPE.read}`, { share: true });
  const davidShares = { me: (await meOf(david)).calendar, connected: (await connectedNow()).includes(david) };
  check('78. after a disconnect, a fresh plain connect with calendar.readonly doesn\'t share (flag off, not claimed, not connected, '
    + 'google_me calendar false, and calendar_save forgets them)',
    stable(helloPlain) === stable({ flag: false, me: false, claimed: false, connected: false, save: false, left: 0 }), helloPlain);
  check('78. calendar_stop on an admin\'s business connection (Gmail and Drive): the connection stays as it was with the flag off, '
    + 'their meetings and sync go; again, it changes nothing; a plain reconnect with the calendar in its token doesn\'t share again, '
    + 'a Calendar connect (calendar_share) does',
    davidBefore === 2 && davidRow?.calendar === true && stable(davidStop) === stable({ first: true, again: false })
      && stable(davidStopped.row) === stable({ ...davidRow, calendar: false }) && davidStopped.left === 0
      && davidStopped.me.calendar === false && davidStopped.me.business === true && davidStopped.me.google_email === davidRow.email
      && stable(davidPlain) === stable({ flag: false, me: false, claimed: false, connected: false })
      && davidReshare === true && stable(davidShares) === stable({ me: true, connected: true }),
    { davidBefore, davidRow, davidStop, davidStopped, davidPlain, davidReshare, davidShares });

  // Hello connects the calendar (a Calendar connect), syncs, then stops: a calendar-only connection is removed.
  const helloShare = await connect(hello, 'staff.example@assetstackai.com', `openid email ${SCOPE.read}`, { share: true });
  const helloSave = await save(hello, T(80), [meeting('h1'), meeting('h2')]);
  const helloBefore = await leftFor(hello);
  const bossRow = await rowOf(boss);
  await as(hello);
  const helloStop = { first: (await one('select public.calendar_stop() as ok')).ok, again: (await one('select public.calendar_stop() as ok')).ok };
  await as(alice);
  const aliceStop = (await one('select public.calendar_stop() as ok')).ok;
  await as(carol);
  const carolStop = await error('select public.calendar_stop()');
  await as(null);
  await db.exec('set role anon');
  const anonStop = await error('select public.calendar_stop()');
  await as(null);
  const helloStopped = { row: await rowOf(hello), left: await leftFor(hello), me: await meOf(hello) };
  check('78. calendar_stop on a calendar-only connection removes it (and the meetings and sync with it); again, or with no '
    + 'connection, it changes nothing (false); only your own; an inactive account and anon are refused',
    helloShare === true && helloSave === true && helloBefore === 3 && stable(helloStop) === stable({ first: true, again: false })
      && helloStopped.row === undefined && helloStopped.left === 0 && helloStopped.me.google_email === null
      && helloStopped.me.calendar === false && aliceStop === false && typeof carolStop === 'string' && typeof anonStop === 'string'
      && stable(await rowOf(boss)) === stable(bossRow),
    { helloShare, helloSave, helloBefore, helloStop, aliceStop, carolStop, anonStop, helloStopped });

  // The forgetting fires on the flag going off (sharing again, or a change that keeps sharing, keeps the meetings).
  runs.earlyAgain = await save(early, T(80), [meeting('e2')]);
  const earlyBefore = await leftFor(early);
  const earlyReshare = await shareCalendar(early);
  const earlyKept = await leftFor(early);
  const flagOff = await affected('update private.google_accounts set calendar = false where user_id = $1', [early]);
  const earlyAfter = await leftFor(early);
  // calendar_save's check still forgets someone whose flag is off though their scopes read the calendar. Its lock (for share
  // of the profile and the connection) can't be interleaved with another transaction here (PGlite is one connection), so
  // the race it closes isn't exercised: the check only confirms the lock is taken.
  await plant(early);
  const earlyPlanted = await leftFor(early);
  runs.earlyOff = await save(early, T(90), [meeting('e3')]);
  const earlyGone = await leftFor(early);
  const locks = /perform 1 from public\.profiles p join private\.google_accounts g[^;]*\bg\.calendar and private\.has_calendar\(g\.scopes\)\s+for share of p, g;/
    .test(migration9);
  check('78. the forgetting fires when the flag goes off (not when sharing is turned on again); calendar_save then forgets them, '
    + 'its check locking the profile and the connection (for share of p, g)',
    runs.earlyAgain === true && earlyBefore === 2 && earlyReshare === true && earlyKept === 2 && flagOff === 1 && earlyAfter === 0
      && earlyPlanted === 2 && runs.earlyOff === false && earlyGone === 0 && locks,
    { runs, earlyBefore, earlyReshare, earlyKept, flagOff, earlyAfter, earlyPlanted, earlyGone, locks });

  // Back as the phases above left them (Late's address; David's own calendar stays connected for the sync check).
  await db.query("update public.profiles set email = 'late.example@assetstackai.com' where id = $1", [late]);
  await as(null);
  return ctx;
}

// Phase 10: 0010_outreach_gmail.sql (each outreach mailbox's Gmail: the connection, the sync's RPCs, cold threads and
// their messages, the forgetting, the dashboard's numbers and the threads list) -----------------------------------------

async function applyMigration10() {
  await as(null);
  try {
    await db.exec(migration10);
    return null;
  } catch (e) {
    await db.exec('rollback').catch(() => {});
    return e.message;
  }
}

const GMAIL_TABLES = ['private.outreach_gmail', 'private.outreach_gmail_sync', 'public.outreach_messages', 'public.outreach_threads'];
const GMAIL_FUNCTIONS = ['private.has_gmail_read', 'public.outreach_gmail_connect', 'public.outreach_gmail_known',
  'public.outreach_gmail_claim', 'public.outreach_gmail_job', 'public.outreach_gmail_save', 'public.outreach_gmail_status',
  'public.outreach_gmail_disconnect', 'public.outreach_gmail_daily', 'public.outreach_gmail_breakdown', 'public.outreach_gmail_threads',
  'public.outreach_gmail_forget', 'public.outreach_gmail_addresses'];
const GMAIL_SIGNATURES = {
  connect: 'public.outreach_gmail_connect(uuid, text, text, text, uuid, text)',
  known: 'public.outreach_gmail_known()',
  claim: 'public.outreach_gmail_claim(int, int)',
  job: 'public.outreach_gmail_job(uuid)',
  save: 'public.outreach_gmail_save(uuid, timestamptz, jsonb, jsonb, jsonb, boolean, text, boolean)',
  status: 'public.outreach_gmail_status()',
  disconnect: 'public.outreach_gmail_disconnect(uuid)',
  daily: 'public.outreach_gmail_daily(date, date)',
  breakdown: 'public.outreach_gmail_breakdown(date, date)',
  threads: 'public.outreach_gmail_threads(uuid, date, date, text, text, int, int)',
  forget: 'public.outreach_gmail_forget()',
  addresses: 'public.outreach_gmail_addresses()',
  hasGmailRead: 'private.has_gmail_read(text)',
};
const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_INDEXES = ['outreach_emails_contact_email_lower_idx', 'outreach_emails_thread_id_idx'];

// Everything 0010 makes (tables, columns, constraints, indexes, triggers, policies, functions, grants, realtime), in a
// form that compares across runs and databases.
async function gmailShape(dbx) {
  const q = async (sql, params) => (await dbx.query(sql, params)).rows;
  const ofTables = `(select c.oid from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname || '.' || c.relname = any($1::text[]))`;
  return {
    tables: await q(`select c.oid::regclass::text as t, c.relrowsecurity as rls, (select array_agg(a::text order by a::text) from unnest(c.relacl) a) as acl
      from pg_class c where c.oid in ${ofTables} order by 1`, [GMAIL_TABLES]),
    columns: await q(`select table_schema, table_name, column_name, udt_name, is_nullable, column_default from information_schema.columns
      where table_schema || '.' || table_name = any($1::text[]) order by 1, 2, ordinal_position`, [GMAIL_TABLES]),
    constraints: await q(`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid in ${ofTables} order by 1, 2`, [GMAIL_TABLES]),
    indexes: await q(`select schemaname, tablename, indexname, indexdef from pg_indexes
      where schemaname || '.' || tablename = any($1::text[]) or indexname = any($2::text[]) order by 1, 2, 3`, [GMAIL_TABLES, GMAIL_INDEXES]),
    triggers: await q(`select tgrelid::regclass::text as t, tgname, pg_get_triggerdef(oid) as def from pg_trigger
      where not tgisinternal and (tgrelid in ${ofTables} or tgname in ('outreach_gmail_forget', 'outreach_gmail_addresses')) order by 1, 2`,
    [GMAIL_TABLES]),
    policies: await q(`select schemaname, tablename, policyname, cmd, permissive, roles::text as roles, qual, with_check from pg_policies
      where schemaname || '.' || tablename = any($1::text[]) order by 1, 2, 3`, [GMAIL_TABLES]),
    functions: await q(`select pronamespace::regnamespace::text as ns, proname, prosecdef, provolatile, proconfig, md5(prosrc) as src,
        pg_get_function_identity_arguments(oid) as args, pg_get_function_result(oid) as result,
        (select array_agg(a::text order by a::text) from unnest(proacl) a) as acl
      from pg_proc where pronamespace::regnamespace::text || '.' || proname = any($1::text[]) order by 1, 2`, [GMAIL_FUNCTIONS]),
    published: (await q(`select schemaname || '.' || tablename as t from pg_publication_tables where pubname = 'supabase_realtime'
      and schemaname || '.' || tablename = any($1::text[]) order by 1`, [GMAIL_TABLES])).map((r) => r.t),
  };
}

// Who may call each 0010 function, and whether it runs as its owner.
async function gmailCallers(dbx) {
  const r = (await dbx.query(`select k, has_function_privilege('anon', f, 'execute') as anon,
      has_function_privilege('authenticated', f, 'execute') as signed_in, has_function_privilege('service_role', f, 'execute') as secret,
      (select prosecdef from pg_proc where oid = f::regprocedure) as definer
    from jsonb_each_text($1::jsonb) as x (k, f)`, [JSON.stringify(GMAIL_SIGNATURES)])).rows;
  return Object.fromEntries(r.map(({ k, ...x }) => [k, x]));
}

// 79–93. 0010: Outreach reads cold email from each mailbox's Gmail (docs/PHASE2.md §16) ------------------------------------
async function phase10(ctx) {
  const { alice, boss, david, hello, carol, newcomer, early } = ctx;
  const lib = await outreachLib();
  const sorted = (...list) => [...list].sort();
  const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
  const T = (m) => new Date(Date.UTC(2026, 9, 21, 0, m)).toISOString(); // runs started on 21 October, m minutes past midnight UTC

  // 79. On the database the phases above leave behind: whole, again, and statement by statement --------------------------

  await as(null);
  const publishedBefore = (await one("select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime'")).n;
  const first = await applyMigration10();
  const body = migration10.replace(/--.*$/gm, '').trim();
  check('79. 0010 runs on top of 0009 and its rows, as one transaction (begin … commit when run whole)',
    first === null && /^begin;/i.test(body) && /commit;$/i.test(body), first);
  if (first) return null;
  const shape = await gmailShape(db);
  const second = await applyMigration10();
  await as(null);
  const splitErrors = await runSplit(db, migration10, { continueOnError: true });
  const reshaped = await gmailShape(db);
  check('79. 0010 re-runs whole and statement by statement (the editor) cleanly, changing nothing, and never mentions module_level',
    second === null && !splitErrors.length && !shapeDiff(shape, reshaped).length && !migration10.includes('module_level'),
    { second, splitErrors, changed: shapeDiff(shape, reshaped) });

  // 80. On a fresh database after 0009: statement by statement ends as a whole run does; Supabase's default grants --------

  const freshAt9 = async (supabaseDefaults = false) => {
    const dbx = new PGlite({ extensions: { pgcrypto } });
    await dbx.exec(SUPABASE_STUB);
    if (supabaseDefaults) {
      await dbx.exec(`alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
        alter default privileges in schema public grant all on tables to service_role`);
    }
    for (const m of [migration, migration2, migration3, migration4, migration5, migration6, migration7, migration8, migration9]) await dbx.exec(m);
    return dbx;
  };
  const whole = await freshAt9();
  const wholeError = await whole.exec(migration10).then(() => null, (e) => e.message);
  const wholeShape = await gmailShape(whole);
  await whole.close();
  const stop = await freshAt9();
  const stopErrors = await runSplit(stop, migration10);
  const stopShape = await gmailShape(stop);
  const againErrors = await runSplit(stop, migration10);
  const againShape = await gmailShape(stop);
  await stop.close();
  const carry = await freshAt9();
  const carryErrors = await runSplit(carry, migration10, { continueOnError: true });
  const carryShape = await gmailShape(carry);
  await carry.close();
  const statements = splitSql(migration10).length;
  check('80. 0010 run statement by statement on a fresh database (stopping at the first error, or carrying on) ends exactly as a '
    + 'whole run does; a second statement-by-statement run changes nothing',
    statements > 40 && wholeError === null && !stopErrors.length && !carryErrors.length && !againErrors.length
      && !shapeDiff(wholeShape, stopShape).length && !shapeDiff(wholeShape, carryShape).length && !shapeDiff(wholeShape, againShape).length,
    { statements, wholeError, stopErrors, carryErrors, againErrors, stop: shapeDiff(wholeShape, stopShape),
      carry: shapeDiff(wholeShape, carryShape), again: shapeDiff(wholeShape, againShape) });
  check('80. ...and a fresh database ends with the same tables, policies, functions, triggers and grants as the used one',
    !shapeDiff(wholeShape, shape).length, shapeDiff(wholeShape, shape));

  // private.outreach_gmail_sync.failures (queued thread id → { n, at }: how often Gmail answered it with a server error). A
  // database that ran an earlier draft of 0010 lacks it: simulated by dropping it, with a mailbox's sync row in place; 0010
  // run again (whole, or statement by statement) adds it ({} for the row already there) and ends as a fresh run does.
  const FAILURES_COLUMN = { udt_name: 'jsonb', is_nullable: 'NO', column_default: "'{}'::jsonb" };
  const failuresColumn = (sh) => {
    const c = sh.columns.find((x) => x.table_schema === 'private' && x.table_name === 'outreach_gmail_sync' && x.column_name === 'failures');
    return c ? { udt_name: c.udt_name, is_nullable: c.is_nullable, column_default: c.column_default } : null;
  };
  const draftRerun = async (rerun) => {
    const dbx = await freshAt9();
    await dbx.exec(migration10);
    const box = (await dbx.query("insert into public.outreach_mailboxes (name, addresses) values ('Draft', array['draft@assetstackai.com']) returning id")).rows[0].id;
    await dbx.query("insert into private.outreach_gmail (mailbox_id, email, refresh_token, scopes) values ($1, 'draft@assetstackai.com', 'refresh-token-d', $2)",
      [box, GMAIL_READ]);
    await dbx.query("insert into private.outreach_gmail_sync (mailbox_id, history_id, pending) values ($1, '77', array['d1', 'd2'])", [box]);
    await dbx.exec('alter table private.outreach_gmail_sync drop column if exists failures');
    const dropped = failuresColumn(await gmailShape(dbx));
    const errors = await rerun(dbx);
    const sh = await gmailShape(dbx);
    const row = (await dbx.query(`select s.history_id, s.pending, to_jsonb(s) -> 'failures' as failures from private.outreach_gmail_sync s
      where s.mailbox_id = $1`, [box])).rows[0];
    const job = await dbx.query('select public.outreach_gmail_job($1) as j', [box]).then((r) => r.rows[0].j, (e) => ({ failures: e.message }));
    const saved = await dbx.query(`select public.outreach_gmail_save($1, now(), '[]', '[]', '{"pending": ["d2"], "failures": {"d2": 1}}') as ok`, [box])
      .then((r) => r.rows[0].ok, (e) => e.message);
    const after = (await dbx.query(`select s.pending, to_jsonb(s) -> 'failures' as failures from private.outreach_gmail_sync s
      where s.mailbox_id = $1`, [box])).rows[0];
    await dbx.close();
    return { dropped, errors, column: failuresColumn(sh), diff: shapeDiff(wholeShape, sh), row, job: job?.failures, saved, after };
  };
  const drafts = {
    whole: await draftRerun((dbx) => dbx.exec(migration10).then(() => [], async (e) => {
      await dbx.exec('rollback').catch(() => {});
      return [e.message];
    })),
    split: await draftRerun((dbx) => runSplit(dbx, migration10)),
  };
  check('80. private.outreach_gmail_sync.failures is jsonb, not null, default {} after a whole run (fresh or on the used database); on a '
    + 'database that ran an earlier draft without it (a sync row in place), 0010 run again whole or statement by statement adds it '
    + '({} for that row, its cursor kept), ends as a fresh run does, and the job and save use it',
    stable(failuresColumn(wholeShape)) === stable(FAILURES_COLUMN) && stable(failuresColumn(shape)) === stable(FAILURES_COLUMN)
      && Object.values(drafts).every((d) => d.dropped === null && !d.errors.length && stable(d.column) === stable(FAILURES_COLUMN)
        && !d.diff.length && stable(d.row) === stable({ history_id: '77', pending: ['d1', 'd2'], failures: {} }) && stable(d.job) === stable({})
        && d.saved === true && stable(d.after) === stable({ pending: ['d2'], failures: { d2: 1 } })),
    { whole: failuresColumn(wholeShape), used: failuresColumn(shape), drafts });

  const SIGNED_IN = ['status', 'disconnect', 'daily', 'breakdown', 'threads'];
  const SECRET = ['connect', 'known', 'claim', 'job', 'save'];
  const INVOKER = ['daily', 'breakdown', 'threads'];
  const callersOk = (c, defaults) => Object.keys(GMAIL_SIGNATURES).every((k) => c[k] && !c[k].anon
      && c[k].signed_in === SIGNED_IN.includes(k) && (!SECRET.includes(k) || c[k].secret)
      && c[k].definer === (k !== 'hasGmailRead' && !INVOKER.includes(k)))
    && !c.hasGmailRead.secret && (defaults || SIGNED_IN.every((k) => !c[k].secret));
  const supa = await freshAt9(true);
  const supaRun = await supa.exec(migration10).then(() => null, (e) => e.message);
  const supaFns = supaRun ?? await gmailCallers(supa);
  const supaTables = supaRun ?? (await supa.query(`select t,
      (select string_agg(p, ',') from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
        where has_table_privilege('anon', t, p)) as anon,
      (select string_agg(p, ',') from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
        where has_table_privilege('authenticated', t, p)) as signed_in
    from unnest($1::text[]) t order by t`, [GMAIL_TABLES])).rows;
  await supa.close();
  const callers = await gmailCallers(db);
  check('80. with Supabase\'s defaults too (new functions granted to anon and everyone), anon calls none of the 0010 functions; '
    + 'signed-in users only outreach_gmail_status, _disconnect, _daily, _breakdown and _threads; only the secret key connects, '
    + 'reads the known addresses, claims, reads a job and saves; has_gmail_read and the triggers\' functions are nobody\'s; '
    + 'the readers run as the caller (security invoker), the rest as definer',
    supaRun === null && callersOk(supaFns, true) && callersOk(callers, false)
      && supaTables.every((r) => r.anon === null)
      && stable(supaTables.map((r) => [r.t, r.signed_in])) === stable([['private.outreach_gmail', null], ['private.outreach_gmail_sync', null],
        ['public.outreach_messages', 'select'], ['public.outreach_threads', 'select']]),
    { supaRun, supaFns, callers, supaTables });

  // 81. Tables, grants, indexes and realtime -------------------------------------------------------------------------------

  const tableInfo = await rows(`select t, (select relrowsecurity from pg_class where oid = t::regclass) as rls,
      exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname || '.' || tablename = t) as published,
      (select string_agg(p, ',') from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
        where has_table_privilege('anon', t, p)) as anon,
      (select string_agg(p, ',') from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p
        where has_table_privilege('authenticated', t, p)) as signed_in,
      has_table_privilege('service_role', t, 'select') as secret_reads
    from unnest($1::text[]) as t order by t`, [GMAIL_TABLES]);
  const info = Object.fromEntries(tableInfo.map(({ t, ...r }) => [t, r]));
  const noRls = await rows(`select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private') and c.relkind = 'r' and not c.relrowsecurity`);
  const publishedAfter = (await one("select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime'")).n;
  const indexes = Object.fromEntries((await rows(`select indexname, indexdef from pg_indexes where indexname = any($1::text[])`, [[
    'outreach_threads_first_day_idx', 'outreach_threads_reply_day_idx', 'outreach_threads_bounce_day_idx', 'outreach_threads_mailbox_id_idx',
    'outreach_messages_day_idx', 'outreach_messages_thread_idx', ...GMAIL_INDEXES]])).map((r) => [r.indexname, r.indexdef]));
  const cons = (await rows(`select conrelid::regclass::text || ' ' || pg_get_constraintdef(oid) as d from pg_constraint
    where conrelid = any(array['public.outreach_threads', 'public.outreach_messages', 'private.outreach_gmail']::regclass[])`)).map((r) => r.d);
  const hasCon = (re) => cons.some((d) => re.test(d));
  check('81. the four Gmail tables: RLS on (the private ones too), nothing for anon; signed-in users only read threads and messages and '
    + 'never reach the private tables; the secret key reads the threads (the function checks which are stored)',
    GMAIL_TABLES.every((t) => info[t]?.rls && info[t].anon === null) && !noRls.length
      && info['public.outreach_threads'].signed_in === 'select' && info['public.outreach_messages'].signed_in === 'select'
      && info['private.outreach_gmail'].signed_in === null && info['private.outreach_gmail_sync'].signed_in === null
      && info['public.outreach_threads'].secret_reads,
    { info, noRls });
  check('81. realtime publishes none of them (39 tables before and after); the day, mailbox and sheet-matching indexes exist, and '
    + 'messages by mailbox and thread (for the cascade); threads are unique per mailbox, messages belong to a thread (removed with '
    + 'it), the client key is checked',
    publishedBefore === 39 && publishedAfter === 39 && GMAIL_TABLES.every((t) => !info[t].published)
      && Object.keys(indexes).length === 8 && /lower\(contact_email\)/.test(indexes.outreach_emails_contact_email_lower_idx)
      && /ON public\.outreach_messages USING btree \(mailbox_id, thread_id\)$/.test(indexes.outreach_messages_thread_idx ?? '')
      && /\(thread_id\)/.test(indexes.outreach_emails_thread_id_idx)
      && hasCon(/^outreach_threads UNIQUE \(mailbox_id, thread_id\)$/)
      && hasCon(/^outreach_messages FOREIGN KEY \(mailbox_id, thread_id\) REFERENCES outreach_threads\(mailbox_id, thread_id\) ON DELETE CASCADE$/)
      && hasCon(/^outreach_messages PRIMARY KEY \(mailbox_id, message_id\)$/) && hasCon(/^private\.outreach_gmail CHECK .*client/)
      && hasCon(/^outreach_threads CHECK \(\(char_length\(prospect_name\) <= 100\)\)$/) && hasCon(/^outreach_threads CHECK \(\(char_length\(subject\) <= 200\)\)$/),
    { publishedBefore, publishedAfter, indexes, cons });

  // 82. Which scopes read Gmail ------------------------------------------------------------------------------------------

  const hasRead = await rows('select private.has_gmail_read(s) as ok from unnest($1::text[]) with ordinality as x (s, i) order by i', [[
    null, '', GMAIL_READ, `openid email ${GMAIL_READ}`, `openid\n${GMAIL_READ}  email`, `${GMAIL_READ}x`, `x${GMAIL_READ}`,
    `${GMAIL_READ}/`, 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.modify', 'gmail.readonly',
  ]]);
  check('82. has_gmail_read: true only when one whole space-separated scope is gmail.readonly (not gmail.send / modify, a longer or '
    + 'shorter look-alike, or none)',
    stable(hasRead.map((r) => r.ok)) === stable([false, false, true, true, true, false, false, false, false, false, false]), hasRead);

  // 83. outreach_gmail_connect (the callback, secret key) ------------------------------------------------------------------

  // Gmail mailboxes from here on (added by an admin): One (two addresses, one in capitals), Two, Three, and Paused
  // (inactive). David and Josh (phase 7) are never connected.
  await as(boss);
  const addBox = async (name, addresses, position, active = true) => (await one(`insert into public.outreach_mailboxes (name, addresses, position, active)
    values ($1, $2, $3, $4) returning id`, [name, addresses, position, active])).id;
  const M1 = await addBox('Gmail One', ['One@AssetStackAI.com', 'one@assetstack.org'], 3);
  const M2 = await addBox('Gmail Two', ['two@assetstackai.com'], 4);
  const M3 = await addBox('Gmail Three', ['three@assetstackai.com'], 5);
  const MP = await addBox('Paused', ['paused@assetstackai.com'], 6, false);
  await as(null);
  const [boxA, boxB] = (await rows("select id from public.outreach_mailboxes where name in ('David', 'Josh') order by position")).map((r) => r.id);
  const READ = `openid email ${GMAIL_READ}`;
  const RESULTS = ['ok', 'no_mailbox', 'not_admin', 'wrong_account'];
  const gconnect = async (mailbox, email, { scopes = READ, by = boss, client, token = 'refresh-token-1' } = {}) => {
    await asSecretKey();
    const args = [mailbox, email, token, scopes, by];
    const r = await attempt(client === undefined ? 'select public.outreach_gmail_connect($1, $2, $3, $4, $5) as r'
      : 'select public.outreach_gmail_connect($1, $2, $3, $4, $5, $6) as r', client === undefined ? args : [...args, client]);
    await as(null);
    return r && typeof r === 'object' ? r.r : r;
  };
  const connOf = async (mailbox) => one(`select client, email, refresh_token, scopes, connected_by, connected_at from private.outreach_gmail
    where mailbox_id = $1`, [mailbox]);
  const connects = {
    unknown: await gconnect(randomUUID(), 'one@assetstackai.com'),
    inactive: await gconnect(MP, 'paused@assetstackai.com'),
    staffView: await gconnect(M1, 'one@assetstackai.com', { by: hello }),
    staffEdit: await gconnect(M1, 'one@assetstackai.com', { by: newcomer }),
    inactiveStaff: await gconnect(M1, 'one@assetstackai.com', { by: carol }),
    nobody: await gconnect(M1, 'one@assetstackai.com', { by: randomUUID() }),
    noBy: await gconnect(M1, 'one@assetstackai.com', { by: null }),
    otherMailbox: await gconnect(M1, 'two@assetstackai.com'),
    empty: await gconnect(M1, ''),
    lookalike: await gconnect(M1, 'one@assetstackai.com.au'),
    noToken: await gconnect(M1, 'one@assetstackai.com', { token: '' }),
    badClient: await gconnect(M1, 'one@assetstackai.com', { client: 'Bad-Client' }),
  };
  await as(david);
  await db.query('update public.profiles set active = false where id = $1', [early]);
  await as(null);
  connects.inactiveAdmin = await gconnect(M1, 'one@assetstackai.com', { by: early });
  await as(david);
  await db.query('update public.profiles set active = true where id = $1', [early]);
  await as(null);
  const storedBefore = (await one('select count(*)::int as n from private.outreach_gmail')).n;
  connects.one = await gconnect(M1, '  ONE@assetstackai.com ');
  connects.two = await gconnect(M2, 'two@assetstackai.com', { by: david, client: 'default', token: 'refresh-token-2' });
  connects.three = await gconnect(M3, 'three@assetstackai.com', { by: early, scopes: 'openid email', token: 'refresh-token-3' });
  const stored = { one: await connOf(M1), two: await connOf(M2), three: await connOf(M3) };
  // Paused's connection from before it was paused (the SQL editor here): connected, never read.
  await db.query('insert into private.outreach_gmail (mailbox_id, email, refresh_token, scopes) values ($1, $2, $3, $4)',
    [MP, 'paused@assetstackai.com', 'refresh-token-p', READ]);
  const connectLocks = /from public\.outreach_mailboxes m where m\.id = p_mailbox and m\.active\s+for update of m;/.test(migration10);
  const failed = (x) => typeof x === 'string' && !RESULTS.includes(x);
  check('83. outreach_gmail_connect: no_mailbox for an unknown or inactive mailbox; not_admin unless the connecting person is an active '
    + 'admin (staff with Outreach view or edit, inactive accounts, no one); wrong_account unless the Google account is one of the '
    + 'mailbox\'s addresses (not another mailbox\'s, a look-alike or none); no token or a bad client key is an error; nothing stored',
    connects.unknown === 'no_mailbox' && connects.inactive === 'no_mailbox' && connects.staffView === 'not_admin'
      && connects.staffEdit === 'not_admin' && connects.inactiveStaff === 'not_admin' && connects.inactiveAdmin === 'not_admin'
      && connects.nobody === 'not_admin' && connects.noBy === 'not_admin' && connects.otherMailbox === 'wrong_account'
      && connects.empty === 'wrong_account' && connects.lookalike === 'wrong_account' && failed(connects.noToken)
      && failed(connects.badClient) && storedBefore === 0,
    { connects, storedBefore });
  check('83. ...an admin signed in as one of its addresses (any case, spaces trimmed) connects it: the address lower-cased, the token, '
    + 'scopes, client (\'default\' unless given) and who connected it; the mailbox row is locked for update meanwhile',
    connects.one === 'ok' && connects.two === 'ok' && connects.three === 'ok' && connectLocks
      && stored.one?.email === 'one@assetstackai.com' && stored.one.client === 'default' && stored.one.refresh_token === 'refresh-token-1'
      && stored.one.scopes === READ && stored.one.connected_by === boss
      && stored.two?.connected_by === david && stored.two.client === 'default' && stored.two.refresh_token === 'refresh-token-2'
      && stored.three?.connected_by === early && stored.three.scopes === 'openid email',
    { connects, stored, connectLocks });

  // 84. outreach_gmail_claim: which mailboxes are due a read, at most once per gap ------------------------------------------

  const gclaim = async (...args) => {
    await asSecretKey();
    const r = await db.query(`select c as id from public.outreach_gmail_claim(${args.map((_, i) => `$${i + 1}`).join(', ')}) c`, args);
    await as(null);
    return r.rows.map((x) => x.id).sort();
  };
  const claimedAgo = (mailbox, seconds) => db.query(`update private.outreach_gmail_sync set claimed_at = now() - make_interval(secs => $2)
    where mailbox_id = $1`, [mailbox, seconds]);
  const claims = { first: await gclaim(), again: await gclaim(), forced: await gclaim(60) };
  const claimedRow = await one('select claimed_at, run_started from private.outreach_gmail_sync where mailbox_id = $1', [M1]);
  const nowish = (d) => d instanceof Date && Math.abs(Date.now() - d.getTime()) < 10 * 60e3;
  await claimedAgo(M1, 61);
  await claimedAgo(M2, 45);
  claims.after61 = await gclaim(60);
  claims.floor = await gclaim(0);
  await claimedAgo(M1, 599);
  claims.before600 = await gclaim();
  await claimedAgo(M1, 601);
  claims.after600 = await gclaim();
  // Three gets the Gmail scope (a reconnect as the same account); then all three are free, Two never synced, Three
  // synced before One: a limit of 2 takes Two and Three, the next One; a limit of 0 none.
  connects.threeRead = await gconnect(M3, 'three@assetstackai.com', { by: early, token: 'refresh-token-3' });
  await db.query('update private.outreach_gmail_sync set claimed_at = null, synced_at = $2 where mailbox_id = $1', [M1, T(10)]);
  await db.query('update private.outreach_gmail_sync set claimed_at = null, synced_at = null where mailbox_id = $1', [M2]);
  await db.query(`insert into private.outreach_gmail_sync (mailbox_id, synced_at) values ($1, $2)
    on conflict (mailbox_id) do update set synced_at = excluded.synced_at, claimed_at = null`, [M3, T(5)]);
  claims.none = await gclaim(600, 0);
  claims.oldestTwo = await gclaim(600, 2);
  claims.rest = await gclaim(600, 2);
  claims.empty = await gclaim(600, 2);
  // A released claim (a first read carrying on) goes before one that merely ran out, however recently it synced.
  await db.query("update private.outreach_gmail_sync set claimed_at = now() - interval '2 hours', synced_at = null where mailbox_id = $1", [M1]);
  await db.query('update private.outreach_gmail_sync set claimed_at = null, synced_at = now() where mailbox_id = $1', [M2]);
  claims.released = await gclaim(600, 1);
  claims.thenDue = await gclaim(600, 1);
  await db.query('update private.outreach_gmail_sync set synced_at = $2 where mailbox_id = $1', [M1, T(10)]);
  await db.query('update private.outreach_gmail_sync set synced_at = null where mailbox_id = $1', [M2]);
  const syncRows = (await rows('select mailbox_id from private.outreach_gmail_sync order by mailbox_id')).map((r) => r.mailbox_id);
  check('84. outreach_gmail_claim claims active mailboxes connected with the Gmail read scope (not without it, not inactive, not '
    + 'unconnected), each at most once per p_gap seconds (600 by default, never under 30), stamping claimed_at and run_started; a '
    + 'second claim at once gets none',
    stable(claims.first) === stable(sorted(M1, M2)) && stable(claims.again) === stable([]) && stable(claims.forced) === stable([])
      && nowish(claimedRow?.claimed_at) && +claimedRow.claimed_at === +claimedRow.run_started
      && stable(claims.after61) === stable([M1]) && stable(claims.floor) === stable([M2]) && stable(claims.before600) === stable([])
      && stable(claims.after600) === stable([M1]),
    { claims, claimedRow, expected: { M1, M2, M3, MP } });
  check('84. ...at most p_limit at a time, released ones first, then the least recently synced (never synced first); Paused and the unconnected '
    + 'mailboxes never get a sync row',
    connects.threeRead === 'ok' && stable(claims.none) === stable([]) && stable(claims.oldestTwo) === stable(sorted(M2, M3))
      && stable(claims.rest) === stable([M1]) && stable(claims.empty) === stable([])
      && stable(claims.released) === stable([M2]) && stable(claims.thenDue) === stable([M1])
      && stable(syncRows) === stable(sorted(M1, M2, M3)) && ![MP, boxA, boxB].some((m) => syncRows.includes(m)),
    { claims, syncRows });

  // 85. outreach_gmail_save: a run's threads, messages and cursor -----------------------------------------------------------

  // A run is claimed at a known time here (the claim stamps now(); the function passes the job's run_started back).
  const claimAt = (mailbox, started) => db.query(`insert into private.outreach_gmail_sync (mailbox_id, claimed_at, run_started)
    values ($1, now(), $2) on conflict (mailbox_id) do update set claimed_at = now(), run_started = excluded.run_started`, [mailbox, started]);
  const gsave = async (mailbox, started, threads, messages, cursor, { release = false, err = '', reconnect = false, raw = false } = {}) => {
    await asSecretKey();
    const j = (v) => (raw || v === null ? v : JSON.stringify(v));
    const r = await attempt(`select public.outreach_gmail_save($1::uuid, $2::timestamptz, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8) as ok`,
      [mailbox, started, j(threads), j(messages), j(cursor), release, err, reconnect]);
    await as(null);
    return r && typeof r === 'object' ? r.ok : r;
  };
  const thread = (id, f = {}) => ({
    thread_id: id, sender: f.sender ?? 'one@assetstackai.com', prospect_email: f.email ?? `${id}@prospect.example`,
    prospect_name: f.name ?? `Prospect ${id}`, recipients: f.recipients ?? 1, subject: f.subject ?? `Subject ${id}`, first_at: f.first,
    last_sent_at: f.last ?? f.first, sent_count: f.sent ?? 1, reply_at: f.reply ?? null,
    reply_message_id: f.replyId ?? (f.reply ? `${id}-r` : ''), auto_at: f.auto ?? null, bounce_at: f.bounce ?? null,
  });
  const message = (id, threadId, kind, at) => ({ message_id: id, thread_id: threadId, kind, at });
  const threadsOf = async (mailbox) => Object.fromEntries((await rows(`select thread_id, sender, prospect_email, prospect_name, recipients,
      subject, first_at, first_day::text as first_day, last_sent_at, sent_count, reply_at, reply_day::text as reply_day, reply_message_id,
      auto_at, auto_day::text as auto_day, bounce_at, bounce_day::text as bounce_day, reply_kind, synced_at
    from public.outreach_threads where mailbox_id = $1 order by thread_id`, [mailbox]))
    .map((r) => [r.thread_id, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, iso(v)]))]));
  const messagesOf = async (mailbox) => Object.fromEntries((await rows(`select message_id, thread_id, kind, at, day::text as day, synced_at
    from public.outreach_messages where mailbox_id = $1 order by message_id`, [mailbox]))
    .map((r) => [r.message_id, { thread: r.thread_id, kind: r.kind, at: iso(r.at), day: r.day, synced_at: iso(r.synced_at) }]));
  const syncOf = async (mailbox) => {
    const r = await one(`select claimed_at, run_started, synced_at, ready_at, history_id, scan_from, pending, failures, error, reconnect
      from private.outreach_gmail_sync where mailbox_id = $1`, [mailbox]);
    return r ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, iso(v)])) : null;
  };
  const LONG_NAME = `  ${'N'.repeat(120)}`;
  const LONG_SUBJECT = 'S'.repeat(250);
  // t1 starts at 01:30 on 22 October in Sydney (14:30 UTC the day before); t2 one second before Sydney midnight, its reply
  // on the stroke of it; t3 auto-replied and bounced. Messages: one of a thread never stored, and one of an unknown kind,
  // are skipped; one sent twice is saved once.
  const t1 = thread('t1', { email: ' Pat.Example@Prospect.EXAMPLE ', name: LONG_NAME, subject: LONG_SUBJECT, first: '2026-10-21T14:30:00.000Z', recipients: 2 });
  const t2 = thread('t2', { first: '2026-10-21T12:59:59.000Z', sent: 2, last: '2026-10-22T00:00:00.000Z', reply: '2026-10-21T13:00:00.000Z' });
  const t3 = thread('t3', { first: '2026-10-21T20:00:00.000Z', auto: '2026-10-22T01:00:00.000Z', bounce: '2026-10-22T02:00:00.000Z' });
  const MSGS = [
    message('m-t1-1', 't1', 'sent', '2026-10-21T14:30:00.000Z'), message('m-t2-1', 't2', 'sent', '2026-10-21T12:59:59.000Z'),
    message('m-t2-2', 't2', 'sent', '2026-10-22T00:00:00.000Z'), message('t2-r', 't2', 'reply', '2026-10-21T13:00:00.000Z'),
    message('m-t3-1', 't3', 'sent', '2026-10-21T20:00:00.000Z'), message('m-t3-a', 't3', 'auto', '2026-10-22T01:00:00.000Z'),
    message('m-t3-b', 't3', 'bounce', '2026-10-22T02:00:00.000Z'), message('m-x', 'never-stored', 'sent', '2026-10-21T20:00:00.000Z'),
    message('m-bad', 't3', 'draft', '2026-10-21T20:00:00.000Z'), message('m-t3-1', 't3', 'sent', '2026-10-21T20:00:00.000Z'),
  ];
  const runs = {};
  await claimAt(M1, T(10));
  runs.first = await gsave(M1, T(10), [t1, t2, t3], MSGS, { history_id: '1001', scan_from: '2026-07-23T00:00:00.000Z', pending: ['p1', 'p2'] });
  const afterFirst = await threadsOf(M1);
  const msgsFirst = await messagesOf(M1);
  const syncFirst = await syncOf(M1);
  check('85. outreach_gmail_save stores a run\'s cold threads (Sydney days worked out here: 14:30 UTC on 21 October is 22 October; '
    + 'the prospect\'s address trimmed and lower-cased; the name cut to 100 and the subject to 200) and their messages (each on its '
    + 'Sydney day; one whose thread isn\'t stored, or of an unknown kind, skipped; one sent twice saved once)',
    runs.first === true && Object.keys(afterFirst).join() === 't1,t2,t3'
      && afterFirst.t1.first_day === '2026-10-22' && afterFirst.t1.prospect_email === 'pat.example@prospect.example'
      && afterFirst.t1.prospect_name === 'N'.repeat(100) && afterFirst.t1.subject === 'S'.repeat(200) && afterFirst.t1.recipients === 2
      && afterFirst.t1.first_at === '2026-10-21T14:30:00.000Z' && afterFirst.t1.reply_day === null && afterFirst.t1.reply_kind === ''
      && afterFirst.t2.first_day === '2026-10-21' && afterFirst.t2.reply_day === '2026-10-22' && afterFirst.t2.reply_message_id === 't2-r'
      && afterFirst.t2.sent_count === 2 && afterFirst.t2.last_sent_at === '2026-10-22T00:00:00.000Z'
      && afterFirst.t3.auto_day === '2026-10-22' && afterFirst.t3.bounce_day === '2026-10-22' && afterFirst.t3.first_day === '2026-10-22'
      && Object.values(afterFirst).every((t) => t.synced_at === T(10))
      && Object.keys(msgsFirst).join() === 'm-t1-1,m-t2-1,m-t2-2,m-t3-1,m-t3-a,m-t3-b,t2-r'
      && msgsFirst['m-t2-1'].day === '2026-10-21' && msgsFirst['t2-r'].day === '2026-10-22' && msgsFirst['t2-r'].kind === 'reply'
      && msgsFirst['m-t1-1'].day === '2026-10-22' && Object.values(msgsFirst).every((m) => m.synced_at === T(10)),
    { runs, afterFirst, msgsFirst });
  check('85. ...and where the read got to: history id, scan start and the threads still queued; not ready while some are queued',
    syncFirst?.synced_at === T(10) && syncFirst.history_id === '1001' && syncFirst.scan_from === '2026-07-23T00:00:00.000Z'
      && stable(syncFirst.pending) === stable(['p1', 'p2']) && syncFirst.ready_at === null && syncFirst.error === ''
      && syncFirst.reconnect === false && syncFirst.run_started === T(10) && syncFirst.claimed_at !== null,
    syncFirst);

  // The same run saves again (an updated thread; reply_kind set meanwhile, as AI sorting will); a cursor without
  // history_id or scan_from keeps them.
  await db.query("update public.outreach_threads set reply_kind = 'interested' where mailbox_id = $1 and thread_id = 't2'", [M1]);
  runs.again = await gsave(M1, T(10), [{ ...t2, sent_count: 3, subject: 'Subject t2 (again)' }], [], { pending: ['p2'] });
  const afterAgain = await threadsOf(M1);
  const syncAgain = await syncOf(M1);
  // The next run (claimed at T(20)) finishes the queue: history_id null keeps it, pending [] → ready, once.
  await claimAt(M1, T(20));
  runs.second = await gsave(M1, T(20), [{ ...t1, sent_count: 2, last_sent_at: '2026-10-23T00:00:00.000Z' }],
    [message('m-t1-2', 't1', 'sent', '2026-10-23T00:00:00.000Z')], { history_id: null, pending: [] });
  const afterSecond = await threadsOf(M1);
  const syncSecond = await syncOf(M1);
  // The first run's late save (a newer run has claimed the mailbox) changes nothing, released or not.
  runs.late = await gsave(M1, T(10), [{ ...t1, subject: 'Late' }], [message('m-late', 't1', 'sent', '2026-10-21T15:00:00.000Z')],
    { history_id: '999', pending: ['p9'] }, { release: true });
  const afterLate = { threads: await threadsOf(M1), messages: await messagesOf(M1), sync: await syncOf(M1) };
  check('85. a run saving again updates its rows and never touches reply_kind; a cursor key left out or null keeps what\'s stored; '
    + 'the queue emptying marks the mailbox ready',
    runs.again === true && afterAgain.t2.sent_count === 3 && afterAgain.t2.subject === 'Subject t2 (again)'
      && afterAgain.t2.reply_kind === 'interested' && syncAgain.history_id === '1001' && syncAgain.scan_from === '2026-07-23T00:00:00.000Z'
      && stable(syncAgain.pending) === stable(['p2']) && syncAgain.ready_at === null
      && runs.second === true && afterSecond.t1.sent_count === 2 && afterSecond.t1.synced_at === T(20) && afterSecond.t2.synced_at === T(10)
      && afterSecond.t2.reply_kind === 'interested' && syncSecond.history_id === '1001' && syncSecond.scan_from === '2026-07-23T00:00:00.000Z'
      && stable(syncSecond.pending) === stable([]) && nowish(new Date(syncSecond.ready_at)) && syncSecond.synced_at === T(20),
    { runs, afterAgain, syncAgain, afterSecond, syncSecond });
  check('85. once a newer run has claimed the mailbox, an older run\'s save changes nothing (threads, messages, cursor, claim) and '
    + 'still answers true',
    runs.late === true && stable(afterLate.threads) === stable(afterSecond) && !afterLate.messages['m-late']
      && stable(afterLate.sync) === stable(syncSecond),
    afterLate);

  runs.failed = await gsave(M1, T(20), [thread('t9', { first: '2026-10-21T20:00:00.000Z' })], [message('m-t9', 't9', 'sent', '2026-10-21T20:00:00.000Z')],
    { history_id: '2002', pending: ['p5'] }, { err: `Gmail said no ${'E'.repeat(600)}`, reconnect: true });
  const afterFailed = { threads: await threadsOf(M1), sync: await syncOf(M1) };
  await claimAt(M1, T(30));
  runs.recovered = await gsave(M1, T(30), [], [], { pending: ['p3'] });
  const syncRecovered = await syncOf(M1);
  runs.done = await gsave(M1, T(30), [], [], { pending: [] }, { release: true });
  const syncDone = await syncOf(M1);
  check('85. a run with an error writes no threads or messages, keeps the cursor and the last good save\'s time, and records the error '
    + '(cut to 500) and whether to reconnect; the next good save clears both; ready_at is set once and kept; p_release frees the claim',
    runs.failed === true && !afterFailed.threads.t9 && afterFailed.sync.history_id === '1001' && stable(afterFailed.sync.pending) === stable([])
      && afterFailed.sync.synced_at === T(20) && afterFailed.sync.error.length === 500 && afterFailed.sync.error.startsWith('Gmail said no')
      && afterFailed.sync.reconnect === true && afterFailed.sync.ready_at === syncSecond.ready_at
      && runs.recovered === true && syncRecovered.error === '' && syncRecovered.reconnect === false && stable(syncRecovered.pending) === stable(['p3'])
      && syncRecovered.ready_at === syncSecond.ready_at && syncRecovered.synced_at === T(30) && syncRecovered.claimed_at !== null
      && runs.done === true && syncDone.ready_at === syncSecond.ready_at && syncDone.claimed_at === null && stable(syncDone.pending) === stable([]),
    { runs, afterFailed, syncRecovered, syncDone });

  // An older save never overwrites a newer one's rows (here a run on record older than the rows: the sync row was
  // removed and claimed again at T(5)).
  await db.query('delete from private.outreach_gmail_sync where mailbox_id = $1', [M1]);
  await claimAt(M1, T(5));
  runs.stale = await gsave(M1, T(5), [{ ...t1, subject: 'Stale' }], [message('m-t1-1', 't1', 'reply', '2026-10-21T14:31:00.000Z')], {});
  const afterStale = { threads: await threadsOf(M1), messages: await messagesOf(M1) };
  // A malformed payload doesn't stop a save: not arrays, a null cursor, rows without a thread id or first time, a thread
  // twice, a zero or missing count.
  await claimAt(M1, T(40));
  runs.malformed = await gsave(M1, T(40), '{"thread_id": "x"}', 'null', null, { raw: true });
  runs.messy = await gsave(M1, T(40), [
    { ...thread('t4', { first: '2026-10-22T03:00:00.000Z' }), sent_count: 0, recipients: null, prospect_email: null, prospect_name: null },
    thread('t4', { first: '2026-10-22T03:00:00.000Z' }), { ...thread('t5', { first: '2026-10-22T03:00:00.000Z' }), thread_id: '' },
    { ...thread('t6', {}), first_at: null },
  ], [{ message_id: 'm-t4-1', thread_id: 't4', kind: 'sent', at: null }, { message_id: '', thread_id: 't4', kind: 'sent', at: '2026-10-22T03:00:00.000Z' }],
  { history_id: '3003', scan_from: null, pending: 'not a list' });
  const afterMessy = { threads: await threadsOf(M1), messages: await messagesOf(M1), sync: await syncOf(M1) };
  check('85. an older save never overwrites a newer one\'s threads or messages; a malformed payload doesn\'t stop a save (non-arrays and '
    + 'a null cursor are nothing; rows without a thread id, first time, message id or time skipped; a repeated thread saved once; '
    + 'counts at least 1); a cursor key that isn\'t a list keeps what\'s stored',
    runs.stale === true && afterStale.threads.t1.subject === 'S'.repeat(200) && afterStale.threads.t1.synced_at === T(20)
      && afterStale.messages['m-t1-1'].kind === 'sent' && runs.malformed === true && runs.messy === true
      && Object.keys(afterMessy.threads).join() === 't1,t2,t3,t4' && afterMessy.threads.t4.sent_count >= 1 && afterMessy.threads.t4.recipients >= 1
      && !Object.keys(afterMessy.messages).some((k) => k === '' || k === 'm-t4-1')
      && afterMessy.sync.history_id === '3003' && afterMessy.sync.scan_from === null && afterMessy.sync.synced_at === T(40),
    { runs, afterStale, afterMessy });

  // The cursor's failures (queued thread id → { n, at }: how often Gmail answered it with a server error; the function keeps
  // only ids still queued): stored as given, replacing what was there; a key left out or null keeps it, as does one that
  // isn't an object; an error save never stores it; the job gives it back.
  const failuresOf = async (mailbox) => (await one(`select to_jsonb(s) -> 'failures' as failures from private.outreach_gmail_sync s
    where s.mailbox_id = $1`, [mailbox]))?.failures;
  const jobFailures = async (mailbox) => {
    await asSecretKey();
    const j = (await one('select public.outreach_gmail_job($1) as j', [mailbox])).j;
    await as(null);
    return j?.failures;
  };
  const FAILED = { f1: 1, f2: 4 };
  const fails = { before: await failuresOf(M1) };
  fails.store = await gsave(M1, T(40), [], [], { pending: ['f1', 'f2', 'f3'], failures: FAILED });
  fails.stored = await failuresOf(M1);
  fails.job = await jobFailures(M1);
  fails.missing = await gsave(M1, T(40), [], [], { pending: ['f1', 'f2', 'f3'] });
  fails.afterMissing = await failuresOf(M1);
  fails.nullKey = await gsave(M1, T(40), [], [], { pending: ['f1', 'f2', 'f3'], failures: null });
  fails.afterNull = await failuresOf(M1);
  fails.notObject = [];
  for (const bad of [['f1'], 'f1', 3, true]) {
    fails.notObject.push({ saved: await gsave(M1, T(40), [], [], { pending: ['f1', 'f2', 'f3'], failures: bad }), failures: await failuresOf(M1) });
  }
  fails.errorSave = await gsave(M1, T(40), [], [], { pending: ['f3'], failures: { f3: 1 } }, { err: 'Gmail is busy' });
  fails.afterError = await syncOf(M1);
  fails.replace = await gsave(M1, T(40), [], [], { pending: ['f2', 'f3'], failures: { f2: 5 } });
  fails.afterReplace = await syncOf(M1);
  fails.clear = await gsave(M1, T(40), [], [], { pending: [], failures: {} });
  fails.afterClear = await syncOf(M1);
  check('85. the cursor\'s failures (queued thread id → runs Gmail answered it with a server error): {} until given; stored as given, '
    + 'replacing what was there, and given back by the job; a key left out or null, or one that isn\'t an object, keeps what\'s stored; '
    + 'an error save never stores it (nor the queue)',
    stable(fails.before) === stable({}) && fails.store === true && stable(fails.stored) === stable(FAILED) && stable(fails.job) === stable(FAILED)
      && fails.missing === true && stable(fails.afterMissing) === stable(FAILED) && fails.nullKey === true && stable(fails.afterNull) === stable(FAILED)
      && fails.notObject.length === 4 && fails.notObject.every((x) => x.saved === true && stable(x.failures) === stable(FAILED))
      && fails.errorSave === true && fails.afterError.error === 'Gmail is busy' && stable(fails.afterError.failures) === stable(FAILED)
      && stable(fails.afterError.pending) === stable(['f1', 'f2', 'f3'])
      && fails.replace === true && stable(fails.afterReplace.failures) === stable({ f2: 5 }) && fails.afterReplace.error === ''
      && fails.clear === true && stable(fails.afterClear.failures) === stable({}) && stable(fails.afterClear.pending) === stable([])
      && fails.afterClear.history_id === '3003' && fails.afterClear.synced_at === T(40),
    fails);

  const statusOf = async (user) => {
    if (user === 'anon') { await as(null); await db.exec('set role anon'); } else await as(user);
    const r = await attempt('select public.outreach_gmail_status() as s');
    await as(null);
    return r && typeof r === 'object' ? r.s : r;
  };
  // A mailbox made inactive while a run holds it: its save is refused (false) and the claim released, but its sync row
  // (ready, cursor, queue) and what was read stay, so its Gmail numbers still count; the status shows it ready, inactive.
  await claimAt(M2, T(10));
  runs.two = await gsave(M2, T(10), [thread('n0', { sender: 'two@assetstackai.com', first: '2026-10-20T01:00:00.000Z' })],
    [message('m-n0', 'n0', 'sent', '2026-10-20T01:00:00.000Z')], { history_id: '50', pending: [] });
  const twoReady = await syncOf(M2);
  await claimAt(M2, T(20));
  await as(boss);
  const paused = await affected('update public.outreach_mailboxes set active = false where id = $1', [M2]);
  await as(null);
  runs.inactive = await gsave(M2, T(20), [thread('n1', { first: '2026-10-20T02:00:00.000Z' })], [], { pending: ['q1'] });
  const inactiveSync = await syncOf(M2);
  const inactiveStatus = (await statusOf(hello))?.mailboxes?.find((m) => m.mailbox_id === M2);
  const inactiveLeft = { threads: Object.keys(await threadsOf(M2)), messages: Object.keys(await messagesOf(M2)),
    connection: (await connOf(M2))?.email ?? null, claimed: (await gclaim(30)).includes(M2) };
  await as(boss);
  const resumed = await affected('update public.outreach_mailboxes set active = true where id = $1', [M2]);
  await as(null);
  runs.unknown = await gsave(randomUUID(), T(20), [], [], {});
  runs.unconnected = await gsave(boxA, T(20), [], [], {});
  const saveLocks = /perform 1 from public\.outreach_mailboxes m join private\.outreach_gmail g[^;]*private\.has_gmail_read\(g\.scopes\)\s+for share of m, g;/
    .test(migration10);
  check('85. a mailbox made inactive while a run holds it (or unknown, or not connected) gets no save (false): the claim is released, '
    + 'and it keeps its sync (ready, cursor, queue, last save), the threads and messages already read, and its connection; the status '
    + 'shows it ready and inactive; claims skip it; the save\'s check locks the mailbox and connection (for share)',
    runs.two === true && twoReady?.ready_at !== null && paused === 1 && runs.inactive === false
      && stable(inactiveLeft) === stable({ threads: ['n0'], messages: ['m-n0'], connection: 'two@assetstackai.com', claimed: false })
      && inactiveSync?.claimed_at === null && inactiveSync.ready_at === twoReady.ready_at && inactiveSync.history_id === '50'
      && stable(inactiveSync.pending) === stable([]) && inactiveSync.synced_at === T(10) && inactiveSync.run_started === T(20)
      && inactiveSync.error === ''
      && inactiveStatus?.ready === true && inactiveStatus.active === false && inactiveStatus.connected === true
      && inactiveStatus.pending === 0 && iso(new Date(inactiveStatus.synced_at)) === T(10)
      && resumed === 1 && runs.unknown === false && runs.unconnected === false && saveLocks,
    { runs, twoReady, inactiveSync, inactiveStatus, inactiveLeft, resumed, saveLocks });

  // 86. outreach_gmail_job: one mailbox's work, for the function only ------------------------------------------------------

  await asSecretKey();
  const jobs = {
    one: (await one('select public.outreach_gmail_job($1) as j', [M1])).j,
    two: (await one('select public.outreach_gmail_job($1) as j', [M2])).j,
    paused: (await one('select public.outreach_gmail_job($1) as j', [MP])).j,
    none: (await one('select public.outreach_gmail_job($1) as j', [boxA])).j,
  };
  await as(null);
  check('86. outreach_gmail_job gives the connection (account, token, scopes, client), the mailbox\'s addresses (lower case, once), the '
    + 'cursor (failures {} when none, or no sync row yet), the last save, whether it\'s ready and the run holding it; null for a mailbox '
    + 'with no connection',
    stable(Object.keys(jobs.one || {}).sort()) === stable(['addresses', 'client', 'email', 'failures', 'history_id', 'pending', 'ready',
      'refresh_token', 'run_started', 'scan_from', 'scopes', 'synced_at'])
      && stable(jobs.one.failures) === stable({}) && stable(jobs.two?.failures) === stable({}) && stable(jobs.paused?.failures) === stable({})
      && jobs.one.email === 'one@assetstackai.com' && jobs.one.refresh_token === 'refresh-token-1' && jobs.one.scopes === READ
      && jobs.one.client === 'default' && stable([...jobs.one.addresses].sort()) === stable(['one@assetstack.org', 'one@assetstackai.com'])
      && jobs.one.history_id === '3003' && stable(jobs.one.pending) === stable([]) && jobs.one.ready === true
      && iso(new Date(jobs.one.run_started)) === T(40) && iso(new Date(jobs.one.synced_at)) === T(40)
      && jobs.two?.history_id === '50' && jobs.two.ready === true && iso(new Date(jobs.two.synced_at)) === T(10)
      && stable(jobs.two.pending) === stable([])
      && jobs.paused?.history_id === '' && jobs.paused.ready === false && jobs.paused.synced_at === null
      && jobs.paused.run_started === null && stable(jobs.paused.pending) === stable([])
      && jobs.none === null,
    jobs);

  // 87. outreach_gmail_status: each mailbox's connection and sync, never a token or scope ------------------------------------

  // Two's last run failed and needs reconnecting.
  await claimAt(M2, T(50));
  runs.twoFailed = await gsave(M2, T(50), [], [], {}, { err: 'Google needs reconnecting', reconnect: true });
  const status = await statusOf(hello);
  const order = (await rows('select id from public.outreach_mailboxes order by position, id')).map((r) => r.id);
  const box = (id) => status?.mailboxes?.find((m) => m.mailbox_id === id);
  const KEYS = ['active', 'client', 'connected', 'connected_at', 'email', 'error', 'mailbox_id', 'pending', 'ready', 'reconnect', 'synced_at'];
  const activeOf = Object.fromEntries((await rows('select id, active from public.outreach_mailboxes')).map((r) => [r.id, r.active]));
  const refusedStatus = { alice: await statusOf(alice), carol: await statusOf(carol), anon: await statusOf('anon') };
  const allowedStatus = { david: await statusOf(david), newcomer: await statusOf(newcomer) };
  check('87. outreach_gmail_status (Outreach view): every mailbox by position with whether it\'s active, its connection (account, '
    + 'client, when) and sync (last save, ready, threads queued, error, reconnect); nulls for one never connected; never a token or scope',
    stable(Object.keys(status || {})) === stable(['mailboxes']) && stable(status.mailboxes.map((m) => m.mailbox_id)) === stable(order)
      && status.mailboxes.every((m) => stable(Object.keys(m).sort()) === stable(KEYS) && m.active === activeOf[m.mailbox_id])
      && box(MP).active === false && box(M1).active === true
      && stable(box(boxA)) === stable({ mailbox_id: boxA, active: true, connected: false, email: null, client: null, connected_at: null,
        synced_at: null, ready: null, pending: null, error: null, reconnect: null })
      && box(M1).connected === true && box(M1).email === 'one@assetstackai.com' && box(M1).client === 'default' && box(M1).connected_at !== null
      && iso(new Date(box(M1).synced_at)) === T(40) && box(M1).ready === true && box(M1).pending === 0 && box(M1).error === ''
      && box(M1).reconnect === false
      && box(M2).connected === true && box(M2).error === 'Google needs reconnecting' && box(M2).reconnect === true && box(M2).ready === true
      && iso(new Date(box(M2).synced_at)) === T(10) && box(M3).connected === true && box(M3).ready === false && box(MP).connected === true
      && !/refresh|googleapis|scope/.test(JSON.stringify(status)),
    { status, order });
  check('87. ...admins and staff with Outreach edit read it too; staff without Outreach, inactive accounts and anon are refused',
    stable(allowedStatus.david) === stable(status) && stable(allowedStatus.newcomer) === stable(status)
      && Object.values(refusedStatus).every((e) => typeof e === 'string'),
    { refusedStatus });

  // 88. Threads and messages: read with Outreach view; written by nobody signed in; the private tables by no one ---------------

  const counts = async () => ({
    threads: await one('select count(*)::int as n from public.outreach_threads').then((r) => r.n, (e) => e.message),
    messages: await one('select count(*)::int as n from public.outreach_messages').then((r) => r.n, (e) => e.message),
  });
  await as(null);
  const everything = await counts();
  const readers = {};
  for (const [name, user] of Object.entries({ david, boss, hello, newcomer, alice, carol })) {
    await as(user);
    readers[name] = await counts();
  }
  await as(null);
  await db.exec('set role anon');
  readers.anon = await counts();
  await as(null);
  const t1Id = (await one("select id from public.outreach_threads where mailbox_id = $1 and thread_id = 't1'", [M1])).id;
  const writes = {};
  for (const [name, user] of Object.entries({ david, boss, newcomer })) {
    await as(user);
    writes[name] = {
      insert: await error(`insert into public.outreach_threads (mailbox_id, thread_id, first_at, first_day) values ($1, 'mine', now(), current_date)`, [M1]),
      update: await error("update public.outreach_threads set reply_kind = 'mine' where id = $1", [t1Id]),
      delete: await error('delete from public.outreach_threads where id = $1', [t1Id]),
      message: await error(`insert into public.outreach_messages (mailbox_id, message_id, thread_id, kind, at, day) values ($1, 'mine', 't1', 'sent', now(), current_date)`, [M1]),
      messageDelete: await error('delete from public.outreach_messages where mailbox_id = $1', [M1]),
      connection: await error('select * from private.outreach_gmail'),
      sync: await error('select * from private.outreach_gmail_sync'),
    };
  }
  await asSecretKey();
  const secretRead = await one('select count(*)::int as n from public.outreach_threads where mailbox_id = $1 and thread_id = any($2::text[])',
    [M1, ['t1', 't2', 'nope']]).then((r) => r.n, (e) => e.message);
  await as(null);
  const none = { threads: 0, messages: 0 };
  check('88. threads and messages: admins and staff with Outreach view or edit read them all; staff without Outreach and inactive '
    + 'accounts read none; anon is refused; nobody signed in (not even the SuperAdmin) writes one or reaches the private tables; the '
    + 'secret key reads which threads are stored',
    everything.threads > 0 && everything.messages > 0 && ['david', 'boss', 'hello', 'newcomer'].every((n) => stable(readers[n]) === stable(everything))
      && stable(readers.alice) === stable(none) && stable(readers.carol) === stable(none)
      && Object.values(readers.anon).every((e) => typeof e === 'string')
      && Object.values(writes).every((w) => Object.values(w).every((e) => typeof e === 'string')) && secretRead === 2,
    { everything, readers, writes, secretRead });

  // 89. The dashboard's numbers and the threads list: outreach_gmail_daily / _breakdown / _threads ⇄ src/lib/outreach.js ------

  // A second run of One and Two (T(100)) over two weeks in October; the sheet has rows for some of the prospects (by thread
  // id, or by address: the newest sent, then logged, then id; rows out of the sheet never).
  const H = (month, day, h, m = 0) => new Date(Date.UTC(2026, month - 1, day, h, m)).toISOString();
  const mirror = (id, first, f = {}) => {
    const sent = f.sent ?? 1;
    const sends = Array.from({ length: sent }, (_, k) => new Date(Date.parse(first) + k * 2 * 86400e3).toISOString());
    return {
      thread: thread(id, { first, last: sends[sends.length - 1], sent, reply: f.reply, auto: f.auto, bounce: f.bounce, email: f.email,
        name: f.name, subject: f.subject, sender: f.sender }),
      messages: [...sends.map((at, k) => message(`${id}-s${k}`, id, 'sent', at)),
        ...['reply', 'auto', 'bounce'].filter((k) => f[k]).map((k) => message(`${id}-${k}`, id, k, f[k]))],
    };
  };
  const ONE = [
    mirror('mA', H(10, 5, 22), { name: 'Avery Example', subject: 'Asset data for Avery' }),
    mirror('mB', H(10, 6, 12, 59), { sent: 2, reply: H(10, 9, 13, 30), subject: 'Condition data' }), // 23:59 in Sydney
    mirror('mC', H(10, 6, 13), { sent: 3, auto: H(10, 7, 1), subject: 'Condition data' }), // midnight in Sydney: the next day
    mirror('mD', H(10, 7, 23), { sent: 4, auto: H(10, 8, 2), reply: H(10, 12, 3) }),
    mirror('mE', H(10, 8, 0), { bounce: H(10, 8, 0, 5) }),
    mirror('mF', H(10, 8, 0), { sent: 6, reply: H(10, 9, 0), bounce: H(10, 9, 1) }), // the same first time as mE
    mirror('mG', H(9, 30, 5), { sent: 2, reply: H(10, 6, 5) }), // started the week before
    mirror('mH', H(10, 11, 12, 30), { reply: H(10, 11, 13, 30) }), // the last day; replied the day after
    mirror('shared-1', H(10, 10, 1)),
    mirror('mirror-1', H(10, 9, 3), { sent: 2, email: 'kim@council-a.example', name: 'Kim Example' }),
  ];
  const TWO = [
    mirror('nA', H(10, 6, 1), { bounce: H(10, 6, 1, 1) }),
    mirror('nB', H(10, 9, 1), { sent: 2, reply: H(10, 10, 1) }),
    mirror('nC', H(10, 10, 1), { auto: H(10, 10, 2) }),
    mirror('shared-1', H(10, 10, 1)), // the same Gmail thread id as One's (ids are per mailbox) and the same first time
    mirror('mirror-2', H(10, 10, 4), { email: 'lee@council-b.example', reply: H(10, 11, 4) }),
    mirror('mirror-3', H(10, 7, 4), { email: 'ash@council-c.example', bounce: H(10, 7, 5) }),
    mirror('mirror-4', H(10, 8, 4), { email: 'sam@council-d.example' }),
    mirror('mirror-5', H(10, 9, 4), { email: 'pat.a1@example.com' }), // phase 7's sheet row a1
  ].map((x) => ({ ...x, thread: { ...x.thread, sender: 'two@assetstackai.com' } }));
  await asSecretKey();
  const sheetRow = (key, f) => db.query(`insert into public.outreach_emails (row_key, thread_id, contact_email, sent_on, date_logged,
      organisation, contact_role, tier, reply_status, in_sheet) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
  [key, f.thread ?? '', f.email ?? '', f.sent ?? null, f.logged ?? null, f.org ?? '', f.role ?? '', f.tier ?? '', f.reply ?? '', f.inSheet ?? true]);
  await sheetRow('g-s1', { thread: 'mirror-1', email: 'other@council-a.example', sent: '2026-10-01', org: 'Council A (thread)', role: 'Director', tier: 'A', reply: 'positive' });
  await sheetRow('g-s2', { email: 'KIM@Council-A.example', sent: '2026-10-20', org: 'Council A (by address)' });
  await sheetRow('g-s3', { email: 'lee@council-b.example', sent: '2026-10-05', org: 'Council B (older)' });
  await sheetRow('g-s4', { email: 'lee@council-b.example', sent: '2026-10-09', org: 'Council B (newest)', tier: 'B', role: 'Manager' });
  await sheetRow('g-s5', { email: 'lee@council-b.example', logged: '2026-10-30', org: 'Council B (not sent)' });
  await sheetRow('g-s6', { email: 'lee@council-b.example', sent: '2026-10-15', org: 'Council B (gone)', inSheet: false });
  await sheetRow('g-s7', { email: 'ash@council-c.example', logged: '2026-10-01', org: 'Council C (older)' });
  await sheetRow('g-s8', { email: 'ash@council-c.example', logged: '2026-10-02', org: 'Council C (newer)' });
  await sheetRow('g-s9', { email: 'sam@council-d.example', sent: '2026-10-08', logged: '2026-10-08', org: 'Council D (one)' });
  await sheetRow('g-s10', { email: 'sam@council-d.example', sent: '2026-10-08', logged: '2026-10-08', org: 'Council D (two)' });
  await as(null);
  await claimAt(M1, T(100));
  await claimAt(M2, T(100));
  runs.mirrorOne = await gsave(M1, T(100), ONE.map((x) => x.thread), ONE.flatMap((x) => x.messages), { pending: [] });
  runs.mirrorTwo = await gsave(M2, T(100), TWO.map((x) => x.thread), TWO.flatMap((x) => x.messages), { pending: [] });

  // What the app has: the threads (threadFromRow), messages and sheet rows as PostgREST returns them (json).
  const appData = async () => {
    await as(null);
    return {
      threads: (await one("select coalesce(json_agg(t), '[]') as r from public.outreach_threads t")).r.map(lib.threadFromRow),
      messages: (await one("select coalesce(json_agg(m), '[]') as r from public.outreach_messages m")).r
        .map((m) => ({ mailbox: m.mailbox_id, messageId: m.message_id, threadId: m.thread_id, kind: m.kind, day: m.day })),
      sheet: (await one("select coalesce(json_agg(e), '[]') as r from public.outreach_emails e")).r.map(lib.emailFromRow),
    };
  };
  // An RPC's rows (PostgREST returns json) in the lib's shape, or the error.
  const gmailRpc = async (user, fn, args) => {
    if (user === 'anon') { await as(null); await db.exec('set role anon'); } else await as(user);
    const out = await db.query(`select to_json(x) as r from public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) x`, args)
      .then((r) => r.rows.map((x) => x.r), (e) => e.message);
    await as(null);
    if (typeof out === 'string') return out;
    if (fn === 'outreach_gmail_daily') {
      return out.map((r) => ({ day: String(r.day).slice(0, 10), mailbox: r.mailbox_id, sent: r.sent, started: r.started, replies: r.replies,
        autos: r.autos, bounces: r.bounces }));
    }
    if (fn === 'outreach_gmail_breakdown') return out.map((r) => ({ mailbox: r.mailbox_id, kind: r.kind, value: r.value, n: r.n }));
    return out.map(lib.threadFromRow);
  };
  // The list as live mode would ask for it: one row more than the page, for `more`.
  const sqlList = async (user, { mailbox = null, from, to, search = '', only = 'sent', limit = 50, offset = 0 }) => {
    const got = await gmailRpc(user, 'outreach_gmail_threads', [mailbox, from, to, only, search, limit + 1, offset]);
    return typeof got === 'string' ? got : { rows: got.slice(0, limit), more: got.length > limit };
  };
  const canon = (list) => (Array.isArray(list) ? list.map((r) => stable(r)).sort() : list);
  const app = await appData();
  const RANGES = [['2026-10-05', '2026-10-11'], ['2026-10-06', '2026-10-06'], ['2026-10-07', '2026-10-07'], ['2026-10-10', '2026-10-12'],
    ['2026-09-01', '2026-12-31'], ['2026-10-22', '2026-10-22'], ['2026-10-11', '2026-10-05'], ['2027-01-01', '2027-01-31']];
  const wk = { from: '2026-10-05', to: '2026-10-11' };
  const LISTS = [{ ...wk }, { ...wk, only: 'replies' }, { ...wk, only: 'bounced' }, { ...wk, mailbox: M1 }, { ...wk, mailbox: M2, only: 'replies' },
    { from: '2026-09-01', to: '2026-12-31', limit: 100 }, { from: '2026-09-01', to: '2026-12-31', only: 'replies', limit: 100 },
    { ...wk, search: 'council b' }, { ...wk, search: ' KIM@ ' }, { ...wk, search: 'condition' }, { ...wk, search: 'Council C (newer)' },
    { ...wk, search: 'avery' }, { ...wk, search: 'zzz' }, { ...wk, search: '%' }, { ...wk, search: '_' }, { ...wk, limit: 3 },
    { ...wk, limit: 3, offset: 3 }, { ...wk, limit: 3, offset: 30 }, { from: '2026-10-22', to: '2026-10-22', mailbox: M1 }];
  const compare = async (user) => {
    const out = [];
    for (const [from, to] of RANGES) {
      const daily = await gmailRpc(user, 'outreach_gmail_daily', [from, to]);
      const jsDaily = lib.gmailDaily(app.threads, app.messages, from, to);
      if (stable(daily) !== stable(jsDaily)) out.push({ fn: 'daily', from, to, sql: daily, js: jsDaily });
      const breakdown = await gmailRpc(user, 'outreach_gmail_breakdown', [from, to]);
      const jsBreakdown = lib.gmailBreakdown(app.threads, from, to);
      if (stable(canon(breakdown)) !== stable(canon(jsBreakdown))) out.push({ fn: 'breakdown', from, to, sql: breakdown, js: jsBreakdown });
    }
    for (const opts of LISTS) {
      const sql = await sqlList(user, opts);
      const js = lib.filterThreads(app.threads, app.sheet, opts);
      if (stable(sql) !== stable(js)) out.push({ fn: 'threads', opts, sql, js });
    }
    return out;
  };
  const mismatches = await compare(david);
  check('89. outreach_gmail_daily, _breakdown and _threads give exactly what gmailDaily(), gmailBreakdown() and filterThreads() in '
    + 'src/lib/outreach.js give on the same rows (via threadFromRow): daily in the same order, every range (inclusive; reversed or '
    + 'empty: none), and the list\'s rows, sheet details, order and `more` for each mode, mailbox, search and page',
    runs.mirrorOne === true && runs.mirrorTwo === true && app.threads.length >= 22 && !mismatches.length, mismatches);

  // By hand: Sydney days across midnight; the sheet row each thread gets; Two's week.
  const byId = Object.fromEntries((await sqlList(david, { from: '2026-09-01', to: '2026-12-31', limit: 100 })).rows
    .map((t) => [`${t.mailbox === M1 ? 'one' : 'two'}:${t.threadId}`, t]));
  const days = ['one:mB', 'one:mC', 'one:mG', 'one:mH'].map((k) => [byId[k]?.firstDay, byId[k]?.replyDay || byId[k]?.autoDay || null]);
  const orgs = ['one:mirror-1', 'two:mirror-2', 'two:mirror-3', 'two:mirror-4', 'two:mirror-5', 'two:nA']
    .map((k) => byId[k]?.organisation);
  const sheetD = app.sheet.filter((e) => e.contactEmail === 'sam@council-d.example').sort((a, b) => (a.id < b.id ? -1 : 1))[0]?.organisation;
  const twoWeek = (await gmailRpc(david, 'outreach_gmail_breakdown', ['2026-10-05', '2026-10-11'])).filter((r) => r.mailbox === M2)
    .map((r) => `${r.kind} ${r.value} ${r.n}`).sort();
  check('89. ...by hand: a thread at 23:59 Sydney time is that day, one at midnight the next; the sheet row by thread id first (Council '
    + 'A), else the newest sent (B), then logged (C), then id (D), never one out of the sheet; Two\'s week: 2 bounced, 2 replied, '
    + '1 auto-reply, 3 waiting, one thread with a follow-up',
    stable(days) === stable([['2026-10-06', '2026-10-10'], ['2026-10-07', '2026-10-07'], ['2026-09-30', '2026-10-06'], ['2026-10-11', '2026-10-12']])
      && stable(orgs) === stable(['Council A (thread)', 'Council B (newest)', 'Council C (newer)', sheetD, 'Example Council a1', ''])
      && byId['one:mirror-1'].contactRole === 'Director' && byId['one:mirror-1'].tier === 'A' && byId['one:mirror-1'].sheetReplyStatus === 'positive'
      && stable(twoWeek) === stable(['followups 1 7', 'followups 2 1', 'outcome auto 1', 'outcome bounced 2', 'outcome replied 2', 'outcome waiting 3']),
    { days, orgs, sheetD, twoWeek });

  const asStaff = await compare(hello);
  const hidden = {};
  for (const [name, user] of Object.entries({ alice, carol })) {
    hidden[name] = [await gmailRpc(user, 'outreach_gmail_daily', ['2026-01-01', '2026-12-31']),
      await gmailRpc(user, 'outreach_gmail_breakdown', ['2026-01-01', '2026-12-31']),
      await gmailRpc(user, 'outreach_gmail_threads', [null, '2026-01-01', '2026-12-31', 'sent', '', 100, 0])];
  }
  const anonCalls = [await gmailRpc('anon', 'outreach_gmail_daily', ['2026-01-01', '2026-12-31']),
    await gmailRpc('anon', 'outreach_gmail_breakdown', ['2026-01-01', '2026-12-31']),
    await gmailRpc('anon', 'outreach_gmail_threads', [null, '2026-01-01', '2026-12-31', 'sent', '', 100, 0])];
  const openEnded = await gmailRpc(david, 'outreach_gmail_threads', [M2, null, null, 'sent', '', 100, 0]);
  check('89. the readers go through RLS: staff with Outreach view get the same; without Outreach, or inactive, nothing; anon is refused; '
    + 'a null p_from / p_to leaves that end open',
    !asStaff.length && Object.values(hidden).every((list) => list.every((r) => stable(r) === '[]'))
      && anonCalls.every((e) => typeof e === 'string') && Array.isArray(openEnded)
      && stable(openEnded.map((t) => t.threadId).sort()) === stable(['mirror-2', 'mirror-3', 'mirror-4', 'mirror-5', 'n0', 'nA', 'nB', 'nC', 'shared-1']),
    { asStaff, hidden, anonCalls, openEnded: Array.isArray(openEnded) ? openEnded.length : openEnded });

  // 90. outreach_gmail_disconnect: admins only; forgets ----------------------------------------------------------------------

  await claimAt(M3, T(10));
  runs.three = await gsave(M3, T(10), [thread('x1', { sender: 'three@assetstackai.com', first: '2026-10-20T01:00:00.000Z' })],
    [message('m-x1', 'x1', 'sent', '2026-10-20T01:00:00.000Z')], { pending: [] });
  const leftFor = async (mailbox) => (await one(`select (select count(*)::int from public.outreach_threads where mailbox_id = $1)
    + (select count(*)::int from public.outreach_messages where mailbox_id = $1)
    + (select count(*)::int from private.outreach_gmail_sync where mailbox_id = $1)
    + (select count(*)::int from private.outreach_gmail where mailbox_id = $1) as n`, [mailbox])).n;
  const disconnect = async (user, mailbox) => {
    if (user === 'anon') { await as(null); await db.exec('set role anon'); } else await as(user);
    const r = await attempt('select public.outreach_gmail_disconnect($1) as ok', [mailbox]);
    await as(null);
    return r && typeof r === 'object' ? r.ok : r;
  };
  const threeBefore = await leftFor(M3);
  const disconnects = {
    editor: await disconnect(newcomer, M3), viewer: await disconnect(hello, M3), noAccess: await disconnect(alice, M3),
    inactive: await disconnect(carol, M3), anon: await disconnect('anon', M3),
  };
  const threeKept = await leftFor(M3);
  disconnects.admin = await disconnect(boss, M3);
  disconnects.again = await disconnect(boss, M3);
  disconnects.superUnknown = await disconnect(david, randomUUID());
  const threeAfter = await leftFor(M3);
  check('90. outreach_gmail_disconnect: admins only (staff with Outreach edit or view, without it, inactive and anon are refused); it '
    + 'removes the connection and forgets the mailbox\'s threads, messages and sync; again, or for a mailbox with none, false',
    runs.three === true && threeBefore === 4 && ['editor', 'viewer', 'noAccess', 'inactive', 'anon'].every((k) => typeof disconnects[k] === 'string')
      && threeKept === 4 && disconnects.admin === true && disconnects.again === false && disconnects.superUnknown === false && threeAfter === 0,
    { runs, disconnects, threeBefore, threeKept, threeAfter });

  // 91. The forgetting --------------------------------------------------------------------------------------------------------

  const countsFor = async (mailbox) => one(`select (select count(*)::int from public.outreach_threads where mailbox_id = $1) as threads,
    (select count(*)::int from public.outreach_messages where mailbox_id = $1) as messages,
    (select count(*)::int from private.outreach_gmail_sync where mailbox_id = $1) as sync,
    (select count(*)::int from private.outreach_gmail where mailbox_id = $1) as connection`, [mailbox]);
  const seed = async (mailbox, started, id) => {
    await claimAt(mailbox, started);
    return gsave(mailbox, started, [thread(id, { first: '2026-10-20T01:00:00.000Z' })], [message(`m-${id}`, id, 'sent', '2026-10-20T01:00:00.000Z')],
      { pending: [] });
  };
  const forget = {};
  const oneBefore = await countsFor(M1);
  // A token refresh (the same account, client and scope) keeps everything.
  await db.query("update private.outreach_gmail set refresh_token = 'refresh-token-1b' where mailbox_id = $1", [M1]);
  forget.refresh = await countsFor(M1);
  // A failed run, then an admin reconnects the same account (another case): kept, and the error and reconnect flag clear.
  forget.failuresSave = await gsave(M1, T(100), [], [], { pending: ['g1'], failures: { g1: 2 } });
  forget.errorSave = await gsave(M1, T(100), [], [], {}, { err: 'Token has been expired or revoked.', reconnect: true });
  forget.errored = await syncOf(M1);
  forget.reconnect = await gconnect(M1, 'One@AssetStackAI.com', { by: david, token: 'refresh-token-1c' });
  forget.sameAccount = await countsFor(M1);
  const sameSync = await syncOf(M1);
  const sameConn = await connOf(M1);
  // Signed in as the mailbox's other address: another account, so what was read is forgotten.
  forget.other = await gconnect(M1, 'one@assetstack.org');
  forget.otherAccount = { ...(await countsFor(M1)), email: (await connOf(M1))?.email };
  // Another OAuth client (a later Workspace), set in the SQL editor here: forgotten.
  forget.seedClient = await seed(M1, T(110), 'c1');
  forget.failuresAfter = { row: await failuresOf(M1), job: await jobFailures(M1) };
  forget.beforeClient = await countsFor(M1);
  await db.query("update private.outreach_gmail set client = 'second' where mailbox_id = $1", [M1]);
  forget.client = await countsFor(M1);
  // Back to the default client (forgets again, nothing there); then the Gmail scope goes: forgotten, the connection stays
  // (shown not connected, needing a reconnect) and it is no longer claimed or saved.
  forget.back = await gconnect(M1, 'one@assetstack.org');
  forget.seedScope = await seed(M1, T(120), 's1');
  forget.beforeScope = await countsFor(M1);
  await db.query("update private.outreach_gmail set scopes = 'openid email' where mailbox_id = $1", [M1]);
  forget.scope = await countsFor(M1);
  const statusNoScope = (await statusOf(hello)).mailboxes.find((m) => m.mailbox_id === M1);
  forget.scopeClaimed = (await gclaim(30)).includes(M1);
  forget.scopeSave = await gsave(M1, T(130), [thread('s2', { first: '2026-10-20T01:00:00.000Z' })], [], {});
  forget.scopeLeft = await countsFor(M1);
  check('91. a token refresh, and an admin reconnecting the same account (any case) with the Gmail scope, keep what was read (and the '
    + 'reconnect clears the last error; the queue\'s failures stay); another account (the mailbox\'s other address) or another client '
    + 'forgets it (the sync row and its failures with it: the next claim starts at {})',
    oneBefore.threads > 0 && oneBefore.messages > 0 && oneBefore.sync === 1 && stable(forget.refresh) === stable(oneBefore)
      && forget.errorSave === true && forget.errored.reconnect === true && forget.errored.error !== ''
      && forget.reconnect === 'ok' && stable(forget.sameAccount) === stable(oneBefore) && sameSync.error === '' && sameSync.reconnect === false
      && forget.failuresSave === true && stable(sameSync.failures) === stable({ g1: 2 }) && stable(sameSync.pending) === stable(['g1'])
      && stable(forget.failuresAfter) === stable({ row: {}, job: {} })
      && sameConn.refresh_token === 'refresh-token-1c' && sameConn.connected_by === david && sameConn.email === 'one@assetstackai.com'
      && forget.other === 'ok' && stable(forget.otherAccount) === stable({ threads: 0, messages: 0, sync: 0, connection: 1, email: 'one@assetstack.org' })
      && forget.seedClient === true && forget.beforeClient.threads === 1 && forget.beforeClient.sync === 1
      && stable(forget.client) === stable({ threads: 0, messages: 0, sync: 0, connection: 1 }),
    { oneBefore, forget, sameSync, sameConn });
  check('91. ...so does losing the Gmail scope: the connection stays, shown not connected and needing a reconnect, and is no longer '
    + 'claimed or saved',
    forget.back === 'ok' && forget.seedScope === true && forget.beforeScope.threads === 1
      && stable(forget.scope) === stable({ threads: 0, messages: 0, sync: 0, connection: 1 })
      && statusNoScope.connected === false && statusNoScope.reconnect === true && statusNoScope.email === 'one@assetstack.org'
      && forget.scopeClaimed === false && forget.scopeSave === false && stable(forget.scopeLeft) === stable(forget.scope),
    { forget, statusNoScope });

  // Addresses: Two keeps its connection while its address stays (any case); taken off, the connection and data go.
  const twoBefore = await countsFor(M2);
  await as(boss);
  forget.addressKept = await affected("update public.outreach_mailboxes set addresses = array['TWO@assetstackai.com', 'two.b@assetstackai.com'] where id = $1", [M2]);
  await as(null);
  const twoKept = await countsFor(M2);
  await as(boss);
  forget.nameOnly = await affected("update public.outreach_mailboxes set name = 'Gmail 2', active = false where id = $1", [M2]);
  await as(null);
  const twoInactive = await countsFor(M2);
  await as(boss);
  forget.addressGone = await affected("update public.outreach_mailboxes set addresses = array['two.b@assetstackai.com'], active = true where id = $1", [M2]);
  await as(null);
  const twoGone = await countsFor(M2);
  // A mailbox removed takes its connection, sync, threads and messages with it.
  await as(boss);
  const M4 = await addBox('Gmail Four', ['four@assetstackai.com'], 7);
  await as(null);
  forget.four = await gconnect(M4, 'four@assetstackai.com');
  forget.seedFour = await seed(M4, T(10), 'f1');
  const fourBefore = await countsFor(M4);
  await as(boss);
  forget.removed = await affected('delete from public.outreach_mailboxes where id = $1', [M4]);
  await as(null);
  const fourAfter = await countsFor(M4);
  const triggers = (await rows(`select tgrelid::regclass::text || ':' || tgname as t from pg_trigger
    where tgname in ('outreach_gmail_forget', 'outreach_gmail_addresses') order by 1`)).map((r) => r.t);
  check('91. a mailbox address change that keeps the connected address (any case), or a rename or pause, keeps everything; taking the '
    + 'address off removes the connection and forgets its data; removing the mailbox removes it all',
    twoBefore.threads >= 9 && twoBefore.connection === 1 && forget.addressKept === 1 && stable(twoKept) === stable(twoBefore)
      && forget.nameOnly === 1 && stable(twoInactive) === stable(twoBefore) && forget.addressGone === 1
      && stable(twoGone) === stable({ threads: 0, messages: 0, sync: 0, connection: 0 })
      && forget.four === 'ok' && forget.seedFour === true && fourBefore.threads === 1 && fourBefore.connection === 1 && forget.removed === 1
      && stable(fourAfter) === stable({ threads: 0, messages: 0, sync: 0, connection: 0 })
      && stable(triggers) === stable(['outreach_mailboxes:outreach_gmail_addresses', 'private.outreach_gmail:outreach_gmail_forget']),
    { twoBefore, twoKept, twoInactive, twoGone, fourBefore, fourAfter, forget, triggers });

  // 92. outreach_gmail_known: who is never a cold prospect ----------------------------------------------------------------

  await as(null);
  const knownClient = (await one("insert into public.clients (name, email) values ('Gmail Known Client', ' Legacy@Example-Legacy.com.au ') returning id")).id;
  await db.query(`insert into public.client_contacts (client_id, name, email) values ($1, 'Kim', 'Kim@Example-Water.com.au '),
    ($1, 'Friend', 'friend@bigpond.com'), ($1, 'Ours', 'someone@assetstack.org'), ($1, 'Nobody', '')`, [knownClient]);
  await db.query("insert into public.client_access (client_id, name, email) values ($1, 'Ops', ' ops@Example-Port.com.au')", [knownClient]);
  await db.query(`insert into public.invoices (client_id, number, sent_to) values ($1, 'GMAIL-KNOWN-1',
    'pat@example-rail.com.au; Billing <Accounts@Example-Rail.com.au>,someone@gmail.com  ')`, [knownClient]);
  await db.query("insert into public.contacts (name, org, email) values ('Lead Example', 'Prospect Co', 'lead@prospect-co.example')");
  await asSecretKey();
  const known = (await one('select public.outreach_gmail_known() as k')).k;
  await as(hello);
  const knownStaff = await error('select public.outreach_gmail_known()');
  await as(null);
  const profileEmails = (await rows('select lower(email) as e from public.profiles')).map((r) => r.e);
  const FREE = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'yahoo.com.au', 'icloud.com',
    'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'tpg.com.au', 'iinet.net.au'];
  const tidy = (list) => Array.isArray(list) && stable(list) === stable([...new Set(list)].sort()) && list.every((x) => x === x.toLowerCase() && x === x.trim() && x);
  const has = (list, ...xs) => xs.every((x) => list.includes(x));
  const lacks = (list, ...xs) => xs.every((x) => !list.includes(x));
  check('92. outreach_gmail_known (secret key only): internal domains (ours, every mailbox address\'s, every profile\'s); known '
    + 'addresses (every profile, client contacts and access, the old clients.email, invoice recipients; lower case, once); client '
    + 'organisation domains (not free mail or internal); never the Outreach prospects',
    stable(Object.keys(known || {}).sort()) === stable(['domains', 'emails', 'internal']) && tidy(known.internal) && tidy(known.emails)
      && tidy(known.domains) && typeof knownStaff === 'string'
      && has(known.internal, 'assetstackai.com', 'assetstack.org', 'assetstackai.com.au', 'example.com', 'old.example.com', 'new.example.com')
      && has(known.emails, ...profileEmails, 'kim@example-water.com.au', 'friend@bigpond.com', 'someone@assetstack.org', 'ops@example-port.com.au',
        'legacy@example-legacy.com.au', 'pat@example-rail.com.au', 'accounts@example-rail.com.au', 'someone@gmail.com')
      && known.emails.every((e) => e.includes('@')) && lacks(known.emails, 'lead@prospect-co.example', 'billing')
      && has(known.domains, 'example-water.com.au', 'example-port.com.au', 'example-rail.com.au', 'example-legacy.com.au')
      && known.domains.every((d) => !FREE.includes(d) && !known.internal.includes(d))
      && lacks(known.domains, 'prospect-co.example', 'assetstack.org', 'gmail.com', 'bigpond.com', 'example.com'),
    known);

  // 93. A run from before a disconnect, reconnect or account change saves nothing on the new connection ----------------------

  // Five has two addresses. Each time a run claims it and reads its job, then (a) an admin connects it as its other
  // address, (b) disconnects it and connects the same account again, or (c) disconnects it; then the old run saves (its
  // threads, messages and cursor) and saves its error. A new claim afterwards reads and saves as usual.
  await as(boss);
  const M5 = await addBox('Gmail Five', ['five@assetstackai.com', 'five@assetstack.org'], 8);
  await as(null);
  const jobOf = async (mailbox) => {
    await asSecretKey();
    const j = (await one('select public.outreach_gmail_job($1) as j', [mailbox])).j;
    await as(null);
    return j;
  };
  const stale = { connect: await gconnect(M5, 'five@assetstackai.com') };
  const staleRun = async (name, change) => {
    const claimed = (await gclaim(30)).includes(M5);
    const job = await jobOf(M5);
    const changed = await change();
    const saved = await gsave(M5, job.run_started, [thread(`old-${name}`, { sender: 'five@assetstackai.com', first: '2026-10-20T01:00:00.000Z' })],
      [message(`m-old-${name}`, `old-${name}`, 'sent', '2026-10-20T01:00:00.000Z')],
      { history_id: '9001', scan_from: '2026-07-01T00:00:00.000Z', pending: [] });
    const errored = await gsave(M5, job.run_started, [], [], {}, { release: true, err: 'Old run: token expired or revoked', reconnect: true });
    const left = { ...(await countsFor(M5)), sync: await syncOf(M5), email: (await connOf(M5))?.email ?? null };
    const reconnected = changed === true ? await gconnect(M5, 'five@assetstackai.com') : null;
    const fresh = { claimed: (await gclaim(30)).includes(M5) };
    const job2 = await jobOf(M5);
    fresh.later = Date.parse(job2.run_started) > Date.parse(job.run_started);
    fresh.saved = await gsave(M5, job2.run_started, [thread(`new-${name}`, { sender: job2.email, first: '2026-10-21T01:00:00.000Z' })],
      [message(`m-new-${name}`, `new-${name}`, 'sent', '2026-10-21T01:00:00.000Z')], { history_id: '9100', pending: [] }, { release: true });
    fresh.threads = Object.keys(await threadsOf(M5));
    fresh.messages = Object.keys(await messagesOf(M5));
    fresh.sync = await syncOf(M5);
    return { claimed, started: job.run_started, changed, saved, errored, left, reconnected, fresh };
  };
  stale.account = await staleRun('a', () => gconnect(M5, 'five@assetstack.org'));
  stale.again = await staleRun('b', async () => [await disconnect(boss, M5), await gconnect(M5, 'five@assetstack.org')]);
  stale.gone = await staleRun('c', () => disconnect(boss, M5));
  const nothingLeft = (r, email) => r.claimed === true && typeof r.started === 'string' && r.saved === false && r.errored === false
    && stable(r.left) === stable({ threads: 0, messages: 0, sync: null, connection: email ? 1 : 0, email });
  const freshOk = (r, name) => r.fresh.claimed === true && r.fresh.later && r.fresh.saved === true
    && stable(r.fresh.threads) === stable([`new-${name}`]) && stable(r.fresh.messages) === stable([`m-new-${name}`])
    && r.fresh.sync?.history_id === '9100' && r.fresh.sync.ready_at !== null && r.fresh.sync.error === '' && r.fresh.sync.reconnect === false
    && r.fresh.sync.claimed_at === null && r.fresh.sync.scan_from === null;
  check('93. a run that claimed a mailbox before an admin connected it as another of its addresses, disconnected and reconnected it '
    + '(the same account), or disconnected it, gets no save (false), nor its error save: no threads, messages, cursor, ready or error '
    + 'land on the new connection (or none); a new claim afterwards reads and saves as usual',
    stale.connect === 'ok'
      && stale.account.changed === 'ok' && nothingLeft(stale.account, 'five@assetstack.org') && freshOk(stale.account, 'a')
      && stable(stale.again.changed) === stable([true, 'ok']) && nothingLeft(stale.again, 'five@assetstack.org') && freshOk(stale.again, 'b')
      && stale.gone.changed === true && nothingLeft(stale.gone, null) && stale.gone.reconnected === 'ok' && freshOk(stale.gone, 'c'),
    stale);
  await as(boss);
  await db.query('delete from public.outreach_mailboxes where id = $1', [M5]);

  await as(null);
  return ctx;
}

async function phase7(ctx) {
  const { alice, boss, david, hello, carol, newcomer, early, late } = ctx;

  // 43. 0007 on the database the phases above leave behind -----------------------------------------------------------

  await as(null);
  const publishedBefore = (await one("select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime'")).n;
  const first = await applyMigration7();
  const body = migration7.replace(/--.*$/gm, '').trim();
  check('43. 0007 runs on top of 0006 and its rows, as one transaction (begin … commit when run whole)',
    first === null && /^begin;/i.test(body) && /commit;$/i.test(body), first);
  if (first) return null;
  const shape = await outreachShape(db);
  const second = await applyMigration7();
  const reshaped = await outreachShape(db);
  check('43. 0007 re-runs cleanly, changing nothing, and never mentions module_level',
    second === null && !shapeDiff(shape, reshaped).length && !migration7.includes('module_level'),
    { second, changed: shapeDiff(shape, reshaped) });
  if (second) return null;

  // 44. As the SQL editor may run it: statement by statement on a fresh database after 0006 ---------------------------

  const freshAt6 = async () => {
    const dbx = new PGlite({ extensions: { pgcrypto } });
    await dbx.exec(SUPABASE_STUB);
    for (const m of [migration, migration2, migration3, migration4, migration5, migration6]) await dbx.exec(m);
    return dbx;
  };
  const whole = await freshAt6();
  const wholeError = await whole.exec(migration7).then(() => null, (e) => e.message);
  const wholeShape = await outreachShape(whole);
  await whole.close();
  const stop = await freshAt6();
  const stopErrors = await runSplit(stop, migration7);
  const stopShape = await outreachShape(stop);
  const againErrors = await runSplit(stop, migration7);
  const againShape = await outreachShape(stop);
  await stop.close();
  const carry = await freshAt6();
  const carryErrors = await runSplit(carry, migration7, { continueOnError: true });
  const carryShape = await outreachShape(carry);
  await carry.close();
  const statements = splitSql(migration7).length;
  check('44. 0007 run statement by statement on a fresh database (stopping at the first error, or carrying on) ends exactly as '
    + 'a whole run does; a second statement-by-statement run changes nothing',
    statements > 20 && wholeError === null && !stopErrors.length && !carryErrors.length && !againErrors.length
      && !shapeDiff(wholeShape, stopShape).length && !shapeDiff(wholeShape, carryShape).length && !shapeDiff(wholeShape, againShape).length,
    { statements, wholeError, stopErrors, carryErrors, againErrors, stop: shapeDiff(wholeShape, stopShape),
      carry: shapeDiff(wholeShape, carryShape), again: shapeDiff(wholeShape, againShape) });
  check('44. ...and a fresh database ends with the same tables, policies, functions, grants and settings row as the used one',
    !shapeDiff(wholeShape, shape).length, shapeDiff(wholeShape, shape));

  // Supabase's own defaults, which the stub leaves out: every new function and table in public is granted to anon,
  // authenticated and service_role, so 0007 has to take anon's away itself; and the database's collation need not be
  // byte order (here the reply_status column gets a linguistic one, 'negative' < 'Positive'), so a same-day reply tie
  // must be decided with collate "C" to match the lib's `<`.
  const supa = new PGlite({ extensions: { pgcrypto } });
  await supa.exec(SUPABASE_STUB);
  await supa.exec(`alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to service_role`);
  for (const m of [migration, migration2, migration3, migration4, migration5, migration6]) await supa.exec(m);
  const supaRun = await supa.exec(migration7).then(() => null, (e) => e.message);
  const supaAnon = supaRun ?? (await supa.query(`select f, has_function_privilege('anon', f, 'execute') as anon,
      has_function_privilege('authenticated', f, 'execute') as signed_in
    from unnest(array['public.outreach_daily(date, date)', 'public.outreach_breakdown(date, date)', 'public.outreach_access()']) f`)).rows;
  const supaTables = supaRun ?? (await supa.query(`select t from unnest($1::text[]) t
    where has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('anon', 'public.' || t, 'insert')
      or has_table_privilege('anon', 'public.' || t, 'update') or has_table_privilege('anon', 'public.' || t, 'delete')`, [OUTREACH_TABLES])).rows;
  let supaTie = supaRun;
  if (!supaRun) {
    await supa.exec(`alter table public.outreach_emails alter column reply_status type text collate "unicode";
      insert into public.outreach_emails (row_key, message_id, sent_on, reply_status, reply_on) values
        ('x1', 'm-tie-1', '2026-10-05', 'negative', '2026-10-06'), ('x2', 'm-tie-1', '2026-10-05', 'Positive', '2026-10-06'),
        ('x3', 'm-tie-2', '2026-10-05', 'referral', '2026-10-06'), ('x4', 'm-tie-2', '2026-10-05', 'negative', '2026-10-06')`);
    const lib = await outreachLib();
    const sqlRows = (await supa.query("select to_json(x) as r from public.outreach_breakdown('2026-10-01', '2026-10-31') x where x.kind = 'reply'"))
      .rows.map(({ r }) => `${r.value} ${r.n}`).sort();
    const app = (await supa.query("select to_json(e) as r from public.outreach_emails e")).rows.map(({ r }) => lib.emailFromRow(r));
    const jsRows = lib.outreachBreakdown(app, '2026-10-01', '2026-10-31').filter((x) => x.kind === 'reply').map((x) => `${x.value} ${x.n}`).sort();
    const linguistic = (await supa.query(`select (array_agg(reply_status order by reply_status))[1] as first from public.outreach_emails
      where message_id = 'm-tie-1'`)).rows[0].first;
    supaTie = { sqlRows, jsRows, linguistic };
  }
  await supa.close();
  check('44. with Supabase\'s defaults (new functions and tables granted to anon; a linguistic collation), anon still can\'t call '
    + 'the RPCs or reach the tables, and a same-day reply tie is still decided in byte order, as the lib does',
    supaRun === null && supaAnon.every((r) => !r.anon && r.signed_in) && supaTables.length === 0
      && supaTie.linguistic === 'negative' && stable(supaTie.sqlRows) === stable(['Positive 1', 'negative 1'])
      && stable(supaTie.jsRows) === stable(supaTie.sqlRows),
    { supaRun, supaAnon, supaTables, supaTie });

  // 45. Tables, grants and realtime ---------------------------------------------------------------------------------

  const tableInfo = await rows(`select t,
      (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) as rls,
      exists (select 1 from pg_trigger where tgrelid = ('public.' || t)::regclass and tgname = 'touch') as touch,
      exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) as published,
      (select string_agg(p, ',') from unnest(array['select', 'insert', 'update', 'delete', 'truncate']) p
        where has_table_privilege('anon', 'public.' || t, p)) as anon,
      (select string_agg(p, ',') from unnest(array['select', 'insert', 'update', 'delete']) p
        where has_table_privilege('authenticated', 'public.' || t, p)) as signed_in
    from unnest($1::text[]) as t order by t`, [OUTREACH_TABLES]);
  const info = Object.fromEntries(tableInfo.map(({ t, ...r }) => [t, r]));
  const noRls = await rows(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`);
  check('45. the four Outreach tables: RLS on, touch(), no anon access; signed-in users only read the emails, and only read '
    + 'and update the settings',
    OUTREACH_TABLES.every((t) => info[t]?.rls && info[t].touch && info[t].anon === null) && !noRls.length
      && info.outreach_mailboxes.signed_in === 'select,insert,update,delete' && info.outreach_emails.signed_in === 'select'
      && info.outreach_notes.signed_in === 'select,insert,update,delete' && info.outreach_settings.signed_in === 'select,update',
    { info, noRls });
  const publishedAfter = (await one("select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime'")).n;
  check('45. realtime publishes mailboxes, notes and settings (35 → 38 tables), never the emails',
    publishedBefore === 35 && publishedAfter === 38 && info.outreach_mailboxes.published && info.outreach_notes.published
      && info.outreach_settings.published && !info.outreach_emails.published,
    { publishedBefore, publishedAfter, info });

  // 46. One settings row ----------------------------------------------------------------------------------------------

  await as(null);
  const ownerSecond = await error('insert into public.outreach_settings (id) values (2)');
  const ownerAgain = await error('insert into public.outreach_settings (id) values (1)');
  await as(david);
  const superInsert = await error("insert into public.outreach_settings (id, sheet_url) values (2, 'https://example.com')");
  const superUpsert = await error(`insert into public.outreach_settings (id, sheet_url) values (1, 'https://example.com')
    on conflict (id) do update set sheet_url = excluded.sheet_url`);
  const superDelete = await error('delete from public.outreach_settings');
  const superMove = await affected('update public.outreach_settings set id = 2 where id = 1');
  await as(null);
  const settingsIds = (await rows('select id from public.outreach_settings')).map((r) => r.id);
  check('46. outreach_settings holds exactly one row (id 1): no second one even from the SQL editor; nobody signed in '
    + '(not even the SuperAdmin) inserts, upserts, deletes or renumbers it',
    stable(settingsIds) === stable([1]) && ownerSecond !== null && ownerAgain !== null && superInsert !== null && superUpsert !== null
      && superDelete !== null && superMove === 1,
    { settingsIds, ownerSecond, ownerAgain, superInsert, superUpsert, superDelete, superMove });

  // Outreach access from here on: Hello views and New and Late edit (staff overrides); Alice keeps the staff default
  // (none); Carol is inactive, so her edit override counts for nothing.
  await as(david);
  await db.query(`insert into module_access (user_id, module, level)
    values ($1, 'outreach', 'view'), ($2, 'outreach', 'edit'), ($3, 'outreach', 'edit'), ($4, 'outreach', 'edit')
    on conflict (user_id, module) do update set level = excluded.level`, [hello, newcomer, late, carol]);

  // 47. outreach_access() and who may call the RPCs -------------------------------------------------------------------

  const accessOf = {};
  for (const [name, user] of Object.entries({ david, boss, early, hello, newcomer, alice, carol })) {
    await as(user);
    accessOf[name] = (await one('select public.outreach_access() as a')).a;
  }
  await as(null);
  await db.exec('set role anon');
  const anonCalls = {
    daily: await error("select * from public.outreach_daily('2026-10-01', '2026-10-31')"),
    breakdown: await error("select * from public.outreach_breakdown('2026-10-01', '2026-10-31')"),
    access: await error('select public.outreach_access()'),
  };
  await as(null);
  const rpcInfo = await rows(`select proname, prosecdef as definer,
      has_function_privilege('anon', oid, 'execute') as anon, has_function_privilege('authenticated', oid, 'execute') as signed_in
    from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1::text[]) order by proname`,
  [['outreach_access', 'outreach_breakdown', 'outreach_daily']]);
  const all3 = (o, v) => stable(o) === stable({ view: v[0], edit: v[1], admin: v[2] });
  check('47. outreach_access() answers for the caller: admins view, edit and admin; Outreach view or edit as granted; '
    + 'staff on the default and inactive accounts nothing',
    all3(accessOf.david, [true, true, true]) && all3(accessOf.boss, [true, true, true]) && all3(accessOf.early, [true, true, true])
      && all3(accessOf.hello, [true, false, false]) && all3(accessOf.newcomer, [true, true, false])
      && all3(accessOf.alice, [false, false, false]) && all3(accessOf.carol, [false, false, false]),
    accessOf);
  check('47. anon can\'t call outreach_daily, outreach_breakdown or outreach_access; signed-in users can; the totals run as the '
    + 'caller (security invoker, so RLS applies) and only outreach_access is security definer',
    Object.values(anonCalls).every((e) => e !== null) && stable(rpcInfo) === stable([
      { proname: 'outreach_access', definer: true, anon: false, signed_in: true },
      { proname: 'outreach_breakdown', definer: false, anon: false, signed_in: true },
      { proname: 'outreach_daily', definer: false, anon: false, signed_in: true },
    ]),
    { anonCalls, rpcInfo });

  // 48. Mailboxes: admins add, change and remove them ----------------------------------------------------------------

  await as(boss);
  const addMailbox = (name, addresses, owner, position) => one(`insert into public.outreach_mailboxes (name, addresses, owner_id, position)
    values ($1, $2, $3, $4) returning id, updated_by`, [name, addresses, owner, position]);
  const mbDavid = await addMailbox('David', ['david@example.com', 'david@old.example.com'], david, 0);
  const mbJosh = await addMailbox('Josh', ['josh@example.com'], early, 1);
  const mbSarah = await addMailbox('Sarah', ['sarah@example.com'], null, 2);
  await as(early);
  const adminEdit = await affected("update public.outreach_mailboxes set addresses = array['josh@example.com', 'josh@new.example.com'] where id = $1",
    [mbJosh.id]);
  await as(david);
  const temp = await attempt("insert into public.outreach_mailboxes (name, position) values ('Temp', 3) returning id");
  const superRemove = await affected('delete from public.outreach_mailboxes where id = $1', [temp?.id]);
  const staffWrites = {};
  for (const [name, user] of Object.entries({ newcomer, hello, alice, carol })) {
    await as(user);
    staffWrites[name] = {
      insert: await error("insert into public.outreach_mailboxes (name) values ('Mine')"),
      update: await affected("update public.outreach_mailboxes set name = 'Mine', addresses = '{}' where id = $1", [mbDavid.id]),
      delete: await affected('delete from public.outreach_mailboxes where id = $1', [mbJosh.id]),
      upsert: await postgrestUpsert('outreach_mailboxes', [{ id: mbSarah.id, name: 'Mine', addresses: [], owner_id: null, active: true, position: 2 }]),
    };
  }
  await as(null);
  const mailboxesNow = await rows('select name, addresses, owner_id, position from public.outreach_mailboxes order by position');
  check('48. mailboxes: admins (and the SuperAdmin) add, change and remove them (touch() stamps who); staff with Outreach edit '
    + 'or view, without it, or inactive can\'t (insert, update, delete or the sync\'s upsert)',
    mbDavid.updated_by === boss && adminEdit === 1 && typeof temp?.id === 'string' && superRemove === 1
      && Object.values(staffWrites).every((w) => typeof w.insert === 'string' && w.update === 0 && w.delete === 0 && typeof w.upsert === 'string')
      && stable(mailboxesNow) === stable([
        { name: 'David', addresses: ['david@example.com', 'david@old.example.com'], owner_id: david, position: 0 },
        { name: 'Josh', addresses: ['josh@example.com', 'josh@new.example.com'], owner_id: early, position: 1 },
        { name: 'Sarah', addresses: ['sarah@example.com'], owner_id: null, position: 2 },
      ]),
    { mbDavid, adminEdit, temp, superRemove, staffWrites, mailboxesNow });

  // 49. Emails: only the sheet sync (secret key) writes them -----------------------------------------------------------

  await as(null);
  await db.exec(`grant usage on schema auth to service_role;
    grant all on ${OUTREACH_TABLES.map((t) => `public.${t}`).join(', ')} to service_role`);
  const A = mbDavid.id;
  const B = mbJosh.id;
  const C = mbSarah.id;
  const SENDERS = { [A]: 'david@example.com', [B]: 'josh@example.com', [C]: 'sarah@example.com' };
  // One row per contact, as the sync writes them (row_key is the sheet row's key; one email to two contacts is two rows
  // with one Gmail message id). Every row has every key. `msg` defaults to the row's own id once it is sent.
  const prospect = (key, mailbox, f = {}) => {
    const msg = f.msg ?? (f.sent ? `18c2f0a1b2c3${key.padStart(4, '0')}` : '');
    return {
      row_key: key, mailbox_id: mailbox, sender: f.sender ?? SENDERS[mailbox] ?? 'unknown@example.com', date_logged: f.logged ?? null,
      organisation: `Example Council ${key.replace(/[ab]$/, '')}`, contact_name: 'Pat Example', contact_role: 'Asset Manager',
      contact_email: `pat.${key}@example.com`, subject: f.sent ? 'Asset condition data' : '', status: f.status ?? (f.sent ? 'sent' : ''),
      sent_on: f.sent ?? null, message_id: msg, thread_id: msg, sequence_status: f.reply ? `replied-${f.reply}` : f.bounced ? 'bounced' : f.sent ? 'active' : '',
      bounced: Boolean(f.bounced), reply_status: f.reply ?? '', reply_on: f.replyOn ?? null, meeting_on: f.meeting ?? null,
      in_sheet: f.inSheet ?? true, raw: { kdm_name: 'Pat Example', sender: f.sender ?? '' },
    };
  };
  // The week checked below is 2026-10-05 … 2026-10-11 (Monday to Sunday).
  const PROSPECTS = [
    prospect('a1', A, { logged: '2026-10-05', sent: '2026-10-05' }), // the first day
    prospect('a2', A, { logged: '2026-10-05', sent: '2026-10-05', bounced: true }),
    prospect('a3', A, { logged: '2026-10-06', sent: '2026-10-06', reply: 'negative', replyOn: '2026-10-07' }),
    prospect('a4', A, { logged: '2026-10-06', sent: '2026-10-06', replyOn: '2026-10-07' }), // a reply date without a reply status
    prospect('a5', A, { logged: '2026-10-06', status: 'draft-saved' }),
    prospect('a6', A, { logged: '2026-10-06', status: 'skipped-unverified' }),
    // Sent the week before; replied and booked in the week.
    prospect('a7', A, { logged: '2026-10-04', sent: '2026-10-04', reply: 'positive', replyOn: '2026-10-06', meeting: '2026-10-09' }),
    // Sent on the last day; replied and booked after it.
    prospect('a8', A, { logged: '2026-10-11', sent: '2026-10-11', reply: 'referral', replyOn: '2026-10-12', meeting: '2026-10-15' }),
    prospect('a9', A, { logged: '2026-10-12', sent: '2026-10-12' }), // the day after
    prospect('a10', A, { sent: '2026-10-10' }), // no date logged
    prospect('a11', A, { logged: '2026-10-07', status: 'draft-lost', bounced: true }), // marked bounced but never sent
    prospect('a12', A, { logged: '2026-10-07', sent: '2026-10-07', reply: 'neutral' }), // a reply status without a date
    // One email to two contacts (two rows, one message id): counted once, bounced when either address bounced.
    prospect('t1a', A, { logged: '2026-10-08', sent: '2026-10-08', msg: '18c2f0a1b2c3t001', bounced: true }),
    prospect('t1b', A, { logged: '2026-10-08', sent: '2026-10-08', msg: '18c2f0a1b2c3t001' }),
    // ...replied on different days: the first reply's day and kind; the first meeting.
    prospect('t2a', A, { logged: '2026-10-08', sent: '2026-10-08', msg: '18c2f0a1b2c3t002', reply: 'positive', replyOn: '2026-10-10', meeting: '2026-10-11' }),
    prospect('t2b', A, { logged: '2026-10-08', sent: '2026-10-08', msg: '18c2f0a1b2c3t002', reply: 'negative', replyOn: '2026-10-09' }),
    // ...both replied on one day with different kinds: the smallest kind (byte order: collate "C" in SQL, < in JS).
    prospect('t3a', A, { logged: '2026-10-09', sent: '2026-10-09', msg: '18c2f0a1b2c3t003', reply: 'referral', replyOn: '2026-10-10' }),
    prospect('t3b', A, { logged: '2026-10-09', sent: '2026-10-09', msg: '18c2f0a1b2c3t003', reply: 'negative', replyOn: '2026-10-10' }),
    prospect('t4a', A, { logged: '2026-10-09', sent: '2026-10-09', msg: '18c2f0a1b2c3t004', reply: 'negative', replyOn: '2026-10-10' }),
    prospect('t4b', A, { logged: '2026-10-09', sent: '2026-10-09', msg: '18c2f0a1b2c3t004', reply: 'Positive', replyOn: '2026-10-10' }), // 'P' < 'n'
    // ...sent on different days (the first counts: before the week), each row still a contact logged in its period.
    prospect('t5a', A, { logged: '2026-10-04', sent: '2026-10-04', msg: '18c2f0a1b2c3t005' }),
    prospect('t5b', A, { logged: '2026-10-06', sent: '2026-10-06', msg: '18c2f0a1b2c3t005' }),
    // One message id in two mailboxes: an email each.
    prospect('t6a', A, { logged: '2026-10-10', sent: '2026-10-10', msg: '18c2f0a1b2c3t006' }),
    prospect('t6b', B, { logged: '2026-10-10', sent: '2026-10-10', msg: '18c2f0a1b2c3t006' }),
    // Rows no longer in the sheet count for nothing (not even through an email whose other row is still there).
    prospect('t7a', A, { logged: '2026-10-07', sent: '2026-10-06', msg: '18c2f0a1b2c3t007', bounced: true, reply: 'positive', replyOn: '2026-10-08',
      meeting: '2026-10-09', inSheet: false }),
    prospect('t7b', A, { logged: '2026-10-07', sent: '2026-10-07', msg: '18c2f0a1b2c3t007' }),
    prospect('g1', A, { logged: '2026-10-06', sent: '2026-10-06', reply: 'negative', replyOn: '2026-10-07', inSheet: false }),
    // Sent rows without a message id (logged before the agent kept them): each row is its own email (row_key).
    prospect('n1', A, { logged: '2026-10-08', sent: '2026-10-08', msg: '', reply: 'neutral', replyOn: '2026-10-09' }),
    prospect('n2', A, { logged: '2026-10-08', sent: '2026-10-08', msg: '' }),
    prospect('b1', B, { logged: '2026-10-07', sent: '2026-10-07', reply: 'positive', replyOn: '2026-10-08', meeting: '2026-10-10' }),
    prospect('b2', B, { logged: '2026-10-07', sent: '2026-10-07', bounced: true }),
    prospect('b3', B, { logged: '2026-10-08', status: 'skipped-colleague' }),
    prospect('b4', B, { logged: '2026-10-11', sent: '2026-10-11', reply: 'negative', replyOn: '2026-10-11' }), // replied the same day
    prospect('c1', C, { logged: '2026-10-09', sent: '2026-10-09' }),
    // Unassigned: a sender no mailbox lists.
    prospect('u1', null, { logged: '2026-10-08', sent: '2026-10-08', reply: 'neutral', replyOn: '2026-10-09' }),
    prospect('u2', null, { logged: '2026-10-08', sent: '2026-10-08', bounced: true }),
    prospect('u3', null, {}), // nothing dated
    prospect('u4', null, { logged: '2026-10-05', status: '' }), // logged without a status yet
    prospect('ut1a', null, { logged: '2026-10-10', sent: '2026-10-10', msg: '18c2f0a1b2c3u001' }),
    prospect('ut1b', null, { logged: '2026-10-10', sent: '2026-10-10', msg: '18c2f0a1b2c3u001', reply: 'referral', replyOn: '2026-10-11' }),
  ];
  await asSecretKey();
  const syncWrite = await postgrestUpsert('outreach_emails', PROSPECTS, { onConflict: 'row_key' });
  const syncResend = await postgrestUpsert('outreach_emails', PROSPECTS, { onConflict: 'row_key' }); // the next sync: same rows
  const syncUpdate = await affected("update public.outreach_emails set note = 'Checked' where row_key = 'a1'");
  await db.query("insert into public.outreach_emails (row_key) values ('gone')");
  const syncDelete = await affected("delete from public.outreach_emails where row_key = 'gone'");
  await as(null);
  const emailCount = (await one('select count(*)::int as n from public.outreach_emails')).n;
  const a1 = (await one("select id from public.outreach_emails where row_key = 'a1'")).id;
  const emailWrites = {};
  for (const [name, user] of Object.entries({ david, boss, newcomer })) {
    await as(user);
    emailWrites[name] = {
      insert: await error("insert into public.outreach_emails (row_key) values ('mine')"),
      update: await error("update public.outreach_emails set note = 'Mine' where id = $1", [a1]),
      delete: await error('delete from public.outreach_emails where id = $1', [a1]),
      upsert: await postgrestUpsert('outreach_emails', [{ row_key: 'a1', note: 'Mine' }], { onConflict: 'row_key' }),
    };
  }
  await as(null);
  const a1Note = (await one('select note from public.outreach_emails where id = $1', [a1])).note;
  check('49. emails: the sheet sync (secret key) inserts, re-sends (upsert on row_key), updates and deletes them; nobody signed in '
    + 'writes one (insert, update, delete or upsert), not even the SuperAdmin',
    syncWrite === null && syncResend === null && syncUpdate === 1 && syncDelete === 1 && emailCount === PROSPECTS.length && a1Note === 'Checked'
      && Object.values(emailWrites).every((w) => Object.values(w).every((e) => typeof e === 'string')),
    { syncWrite, syncResend, syncUpdate, syncDelete, emailCount, a1Note, emailWrites });

  // 50. Notes: written as yourself with Outreach edit -----------------------------------------------------------------

  const forgedAt = '2020-01-01T00:00:00+00:00';
  const recent = (ts) => Boolean(ts) && Math.abs(Date.now() - new Date(ts).getTime()) < 10 * 60e3;
  await as(newcomer);
  const staffNote = await attempt(`insert into public.outreach_notes (mailbox_id, pinned, body, author_id, created_at)
    values ($1, true, 'Lead with the live tender', $2, $3) returning id, author_id, created_at`, [A, boss, forgedAt]);
  await as(late);
  const lateNote = await attempt("insert into public.outreach_notes (body) values ('Councils answer before 10am') returning id, author_id, mailbox_id");
  await as(boss);
  const bossNote = await attempt("insert into public.outreach_notes (body, author_id) values ('Keep it under 90 words', $1) returning id, author_id",
    [newcomer]);
  await as(david);
  const sarahNote = await attempt("insert into public.outreach_notes (mailbox_id, body) values ($1, 'Sarah starts on Monday') returning id", [C]);
  const noInsert = {};
  for (const [name, user] of Object.entries({ hello, alice, carol })) {
    await as(user);
    noInsert[name] = await error("insert into public.outreach_notes (body, author_id) values ('Mine', $1)", [user]);
  }
  await as(null);
  await db.exec('set role anon');
  noInsert.anon = await error("insert into public.outreach_notes (body) values ('Mine')");
  await as(null);
  check('50. notes: staff with Outreach edit and admins add them as themselves (a forged author or date is replaced: the signed-in '
    + 'user, now); Outreach view, no Outreach, inactive accounts and anon can\'t',
    staffNote?.author_id === newcomer && recent(staffNote.created_at) && lateNote?.author_id === late && lateNote.mailbox_id === null
      && bossNote?.author_id === boss && typeof sarahNote?.id === 'string' && Object.values(noInsert).every((e) => typeof e === 'string'),
    { staffNote, lateNote, bossNote, sarahNote, noInsert });
  if (!staffNote?.id || !lateNote?.id || !sarahNote?.id) return null;

  // 51. Notes: changed and removed by their author or an admin ---------------------------------------------------------

  const noteNow = async (noteId) => { await as(null); return one('select author_id, created_at, body, pinned, mailbox_id from public.outreach_notes where id = $1', [noteId]); };
  // The row the sync engine sends for a note (flatten()), with a new body.
  const asSynced = async (noteId, text) => {
    await as(null);
    const row = normalizeRow('outreach_notes', (await one('select row_to_json(n) as r from public.outreach_notes n where id = $1', [noteId])).r);
    return { ...row, body: text };
  };
  const original = await noteNow(staffNote.id);
  await as(newcomer);
  const ownEdit = await affected("update public.outreach_notes set body = 'Lead with the tender', pinned = false, mailbox_id = null where id = $1",
    [staffNote.id]);
  const ownForge = await affected('update public.outreach_notes set author_id = $2, created_at = $3 where id = $1', [staffNote.id, boss, forgedAt]);
  const afterOwn = await noteNow(staffNote.id);
  const lateRow = await asSynced(staffNote.id, 'Late was here');
  await as(late);
  const other = {
    update: await affected("update public.outreach_notes set body = 'Late was here' where id = $1", [staffNote.id]),
    delete: await affected('delete from public.outreach_notes where id = $1', [staffNote.id]),
    upsert: await postgrestUpsert('outreach_notes', [lateRow]),
  };
  await as(hello);
  const viewer = {
    update: await affected("update public.outreach_notes set body = 'Hello was here' where id = $1", [staffNote.id]),
    delete: await affected('delete from public.outreach_notes where id = $1', [staffNote.id]),
  };
  const afterOthers = await noteNow(staffNote.id);
  await as(boss);
  const adminEdit2 = await affected("update public.outreach_notes set pinned = true where id = $1", [staffNote.id]);
  const adminRow = await asSynced(staffNote.id, 'Lead with the tender (tidied)');
  await as(boss);
  const adminUpsert = await postgrestUpsert('outreach_notes', [adminRow]);
  const afterAdmin = await noteNow(staffNote.id);
  // An author whose access drops to view can't change their own note any more.
  await as(david);
  await db.query("update module_access set level = 'view' where user_id = $1 and module = 'outreach'", [late]);
  await as(late);
  const viewOwn = {
    update: await affected("update public.outreach_notes set body = 'Changed' where id = $1", [lateNote.id]),
    delete: await affected('delete from public.outreach_notes where id = $1', [lateNote.id]),
  };
  await as(david);
  await db.query("update module_access set level = 'edit' where user_id = $1 and module = 'outreach'", [late]);
  await as(late);
  const ownDelete = await affected('delete from public.outreach_notes where id = $1', [lateNote.id]);
  await as(david);
  const superDeletesStaff = await affected('delete from public.outreach_notes where id = $1', [bossNote.id]);
  await as(null);
  check('51. notes: the author (with edit) changes and removes their own, but author and date stay put; another staff member '
    + 'can\'t (not even as the sync\'s upsert), nor can view-only staff, their own notes included',
    ownEdit === 1 && ownForge === 1 && afterOwn.body === 'Lead with the tender' && afterOwn.pinned === false && afterOwn.mailbox_id === null
      && afterOwn.author_id === newcomer && +afterOwn.created_at === +original.created_at
      && other.update === 0 && other.delete === 0 && typeof other.upsert === 'string' && viewer.update === 0 && viewer.delete === 0
      && afterOthers.body === 'Lead with the tender' && viewOwn.update === 0 && viewOwn.delete === 0 && ownDelete === 1,
    { ownEdit, ownForge, afterOwn, original, other, viewer, afterOthers, viewOwn, ownDelete });
  check('51. notes: admins change and remove anyone\'s, also as the sync\'s upsert (the author and date stay the writer\'s)',
    adminEdit2 === 1 && adminUpsert === null && afterAdmin.body === 'Lead with the tender (tidied)' && afterAdmin.pinned === true
      && afterAdmin.author_id === newcomer && +afterAdmin.created_at === +original.created_at && superDeletesStaff === 1,
    { adminEdit2, adminUpsert, afterAdmin, superDeletesStaff });

  // 52. Settings: admins set the sheet's link; the sync's results are the secret key's ---------------------------------

  const SHEET = 'https://docs.google.com/spreadsheets/d/1ExampleSheetIdAbCdEfGhIjKlMnOpQrStUv/edit#gid=0';
  const SHEET2 = 'https://docs.google.com/spreadsheets/d/1ExampleSheetIdZyXwVuTsRqPoNmLkJiHgFe/edit';
  const settingsNow = async () => {
    await as(null);
    return one('select sheet_url, sheet_by, synced_at, sync_error, sync_stats, updated_by from public.outreach_settings where id = 1');
  };
  const setLink = async (user, url) => { await as(user); return affected('update public.outreach_settings set sheet_url = $1 where id = 1', [url]); };
  const syncResults = async (error) => {
    await asSecretKey();
    return affected(`update public.outreach_settings set synced_at = '2026-10-18T01:00:00Z', sync_error = $1,
      sync_stats = '{"rows": 21, "unassigned": 3}' where id = 1`, [error]);
  };
  const T1 = '2026-10-18T01:00:00.000Z';
  const linked = await setLink(boss, SHEET);
  const afterLink = await settingsNow();
  const firstSync = await syncResults('No sender column');
  const afterFirstSync = await settingsNow();
  await as(boss);
  const forged = await affected(`update public.outreach_settings set synced_at = now(), sync_error = 'Forged', sync_stats = '{"rows": 99}',
    sheet_by = $1 where id = 1`, [david]);
  const afterForge = await settingsNow();
  await syncResults('Boss is no longer active.');
  const resaved = await setLink(early, SHEET); // another admin saves the same link: Use my Google
  const afterResave = await settingsNow();
  const relinked = await setLink(david, SHEET2);
  const afterRelink = await settingsNow();
  const staffLinks = {};
  for (const [name, user] of Object.entries({ newcomer, hello, alice, carol })) staffLinks[name] = await setLink(user, 'https://example.com/nope');
  const afterStaff = await settingsNow();
  await as(null);
  await db.exec('set role anon');
  const anonSettings = { read: await error('select * from public.outreach_settings'), update: await error("update public.outreach_settings set sheet_url = ''") };
  await asSecretKey();
  const synced = await affected(`update public.outreach_settings set synced_at = '2026-10-18T01:00:00Z', sync_error = 'No sender column',
    sync_stats = '{"rows": 21, "unassigned": 3}', sheet_by = $1 where id = 1`, [boss]);
  const afterSync = await settingsNow();
  const results = (x) => x.synced_at?.toISOString() === T1 && stable(x.sync_stats) === stable({ rows: 21, unassigned: 3 });
  check('52. settings: an admin sets the sheet\'s link and becomes sheet_by (the Google account the sync reads it with); another '
    + 'admin saving the same link takes it over (Use my Google) and clears the last error; a new link also clears the last sync',
    linked === 1 && afterLink.sheet_url === SHEET && afterLink.sheet_by === boss && afterLink.updated_by === boss
      && afterLink.synced_at === null && firstSync === 1 && results(afterFirstSync) && afterFirstSync.sync_error === 'No sender column'
      && resaved === 1 && afterResave.sheet_by === early && afterResave.sync_error === '' && results(afterResave)
      && relinked === 1 && afterRelink.sheet_url === SHEET2 && afterRelink.sheet_by === david && afterRelink.synced_at === null
      && stable(afterRelink.sync_stats) === '{}' && afterRelink.sync_error === '',
    { linked, afterLink, afterFirstSync, resaved, afterResave, relinked, afterRelink });
  check('52. settings: signed-in users can\'t set synced_at, sync_error, sync_stats or sheet_by (a save makes them sheet_by and '
    + 'clears the error); staff (edit, view, none, inactive) and anon can\'t change the link; the secret key writes the sync\'s '
    + 'results (and sheet_by)',
    forged === 1 && results(afterForge) && afterForge.sync_error === '' && afterForge.sheet_by === boss && afterForge.sheet_url === SHEET
      && Object.values(staffLinks).every((n) => n === 0) && afterStaff.sheet_url === SHEET2 && afterStaff.sheet_by === david
      && Object.values(anonSettings).every((e) => e !== null) && synced === 1 && afterSync.sheet_url === SHEET2
      && results(afterSync) && afterSync.sync_error === 'No sender column' && afterSync.sheet_by === boss,
    { forged, afterForge, staffLinks, afterStaff, anonSettings, synced, afterSync });

  // 53. Reading: everything with Outreach view ----------------------------------------------------------------------------

  const counts = async () => {
    const out = {};
    for (const t of OUTREACH_TABLES) out[t] = await one(`select count(*)::int as n from public.${t}`).then((r) => r.n, (e) => e.message);
    return out;
  };
  await as(null);
  const everything = await counts();
  const readers = {};
  for (const [name, user] of Object.entries({ david, boss, early, hello, newcomer, alice, carol })) {
    await as(user);
    readers[name] = await counts();
  }
  await as(null);
  await db.exec('set role anon');
  readers.anon = await counts();
  await as(null);
  const none = { outreach_mailboxes: 0, outreach_emails: 0, outreach_notes: 0, outreach_settings: 0 };
  check('53. reading: admins and staff with Outreach view or edit read every mailbox, email, note and the settings; staff '
    + 'without Outreach and inactive accounts read nothing; anon is refused',
    everything.outreach_mailboxes === 3 && everything.outreach_emails === PROSPECTS.length && everything.outreach_notes === 2
      && everything.outreach_settings === 1
      && ['david', 'boss', 'early', 'hello', 'newcomer'].every((n) => stable(readers[n]) === stable(everything))
      && stable(readers.alice) === stable(none) && stable(readers.carol) === stable(none)
      && Object.values(readers.anon).every((e) => typeof e === 'string'),
    { everything, readers });

  // 54. The dashboard's numbers: outreach_daily() / outreach_breakdown() ⇄ src/lib/outreach.js ------------------------

  const lib = await outreachLib();
  // The rows as the app reads them (PostgREST returns json), in its shape.
  const appRows = async () => {
    await as(null);
    return (await one("select coalesce(json_agg(e), '[]') as r from public.outreach_emails e")).r.map(lib.emailFromRow);
  };
  // An RPC's rows as liveOutreach() in src/data/store.jsx maps them (PostgREST returns json), or the error.
  const rpc = async (user, fn, from, to) => {
    await as(user);
    const out = await db.query(`select to_json(x) as r from public.${fn}($1, $2) x`, [from, to]).then((r) => r.rows.map((x) => x.r), (e) => e.message);
    await as(null);
    if (typeof out === 'string') return out;
    return fn === 'outreach_daily'
      ? out.map((r) => ({ day: String(r.day).slice(0, 10), mailbox: r.mailbox_id || '', sent: r.sent, replies: r.replies, bounces: r.bounces, meetings: r.meetings }))
      : out.map((r) => ({ mailbox: r.mailbox_id || '', kind: r.kind, value: r.value || '', n: r.n }));
  };
  // outreach_daily()'s order is the lib's (day, then mailbox, Unassigned last); outreach_breakdown()'s isn't specified,
  // so its rows compare as a set.
  const canon = (list) => (Array.isArray(list) ? list.map((r) => stable(r)).sort() : list);
  const same = (fn, sql, js) => (fn === 'outreach_daily' ? stable(sql) === stable(js) : stable(canon(sql)) === stable(canon(js)));
  const RANGES = [['2026-10-05', '2026-10-11'], ['2026-10-04', '2026-10-04'], ['2026-10-06', '2026-10-06'], ['2026-10-10', '2026-10-10'],
    ['2026-10-12', '2026-10-15'], ['2026-01-01', '2026-12-31'], ['2026-10-11', '2026-10-05'], ['2027-01-01', '2027-01-31']];
  const app = await appRows();
  const compare = async (user) => {
    const out = [];
    for (const [from, to] of RANGES) {
      for (const [fn, js] of [['outreach_daily', lib.outreachDaily], ['outreach_breakdown', lib.outreachBreakdown]]) {
        const sql = await rpc(user, fn, from, to);
        const mine = js(app, from, to);
        if (!same(fn, sql, mine)) out.push({ fn, from, to, sql, js: mine });
      }
    }
    return out;
  };
  const mismatches = await compare(david);
  check('54. outreach_daily() and outreach_breakdown() give exactly what outreachDaily() / outreachBreakdown() in src/lib/outreach.js '
    + 'give on the same rows (via emailFromRow), daily in the same order, for every range (inclusive; reversed or empty: none)',
    app.length === PROSPECTS.length && app.every((e) => e.rowKey) && !mismatches.length,
    mismatches);

  // The week by hand (mailboxes A, B, C; U = Unassigned): each email once (two contacts, one message id), on its first
  // sent day, bounced when either row bounced; replies on the first reply's day (a status needed), its kind the first
  // reply's (a same-day tie: the smaller kind, byte order); rows out of the sheet count for nothing; a row without a
  // message id is its own email. Contacts logged ('status') are still counted per row.
  const week = await rpc(david, 'outreach_daily', '2026-10-05', '2026-10-11');
  const weekBreakdown = await rpc(david, 'outreach_breakdown', '2026-10-05', '2026-10-11');
  const nameOf = { [A]: 'A', [B]: 'B', [C]: 'C', '': 'U' };
  const weekNamed = Array.isArray(week)
    ? week.map((r) => `${r.day} ${nameOf[r.mailbox]} ${r.sent}/${r.replies}/${r.bounces}/${r.meetings}`).sort() : week;
  const unassignedLast = Array.isArray(week) && week.every((r, i) => r.mailbox || i === week.length - 1 || week[i + 1].day !== r.day);
  const totals = Array.isArray(week) ? lib.outreachTotals(week) : week;
  const per = Array.isArray(week) ? Object.fromEntries(Object.entries(nameOf).map(([m, k]) => {
    const t = lib.outreachTotals(week, m);
    return [k, [t.sent, t.replies, t.bounces, t.meetings]];
  })) : week;
  const breakdownNamed = Array.isArray(weekBreakdown)
    ? weekBreakdown.map((r) => `${nameOf[r.mailbox]} ${r.kind} ${r.value || '(none)'} ${r.n}`).sort() : weekBreakdown;
  check('54. ...the week\'s numbers by hand: emails, not contacts (one message id to two people counts once, bounced if either '
    + 'bounced, its first reply and meeting); out-of-sheet rows ignored; no message id: the row is the email; Unassigned last in a day',
    unassignedLast && stable(weekNamed) === stable([
      '2026-10-05 A 2/0/1/0', '2026-10-06 A 2/1/0/0', '2026-10-07 A 2/1/0/0', '2026-10-08 A 4/0/1/0', '2026-10-09 A 2/2/0/1',
      '2026-10-10 A 2/2/0/0', '2026-10-11 A 1/0/0/1',
      '2026-10-07 B 2/0/1/0', '2026-10-08 B 0/1/0/0', '2026-10-10 B 1/0/0/1', '2026-10-11 B 1/1/0/0',
      '2026-10-09 C 1/0/0/0',
      '2026-10-08 U 2/0/1/0', '2026-10-09 U 0/1/0/0', '2026-10-10 U 1/0/0/0', '2026-10-11 U 0/1/0/0',
    ].sort())
      // outreachTotals() counts each sheet email as a prospect (started), with no auto-replies (those come from Gmail).
      && stable(totals) === stable({ sent: 23, started: 23, replies: 10, autos: 0, bounces: 4, meetings: 3, replyRate: 10 / 23, bounceRate: 4 / 23 })
      && stable(per) === stable({ A: [15, 6, 2, 2], B: [4, 2, 1, 1], C: [1, 0, 0, 0], U: [3, 2, 1, 0] }),
    { unassignedLast, weekNamed, totals, per });
  check('54. ...and the breakdown: contacts logged per row by status (in the sheet only), emails replied to by the first reply\'s '
    + 'kind (a same-day tie: \'negative\' over \'referral\', \'Positive\' over \'negative\')',
    stable(breakdownNamed) === stable([
      'A reply Positive 1', 'A reply negative 3', 'A reply neutral 1', 'A reply positive 1',
      'A status draft-lost 1', 'A status draft-saved 1', 'A status sent 19', 'A status skipped-unverified 1',
      'B reply negative 1', 'B reply positive 1', 'B status sent 4', 'B status skipped-colleague 1',
      'C status sent 1',
      'U reply neutral 1', 'U reply referral 1', 'U status (none) 1', 'U status sent 4',
    ].sort()),
    breakdownNamed);

  // The emails list as liveOutreach().emails in src/data/store.jsx asks PostgREST for it (keep the two in step): rows
  // in the sheet, the period on the mode's day column, replies with a status, the mailbox or Unassigned, the search
  // over six columns, newest first then id, one row more than the page for `more`. Same rows as filterEmails().
  const liveList = async (user, { mailbox = null, from, to, search = '', only = 'sent', limit = 50, offset = 0 }) => {
    const col = { sent: 'sent_on', replies: 'reply_on', logged: 'date_logged' }[only] || 'sent_on';
    const params = [from, to];
    const where = ['in_sheet', `${col} >= $1`, `${col} <= $2`];
    if (only === 'replies') where.push("reply_status <> ''");
    if (mailbox) { params.push(mailbox); where.push(`mailbox_id = $${params.length}`); } else if (mailbox === '') where.push('mailbox_id is null');
    const term = String(search ?? '').replace(/[,()*%\\]/g, ' ').trim();
    if (term) {
      params.push(`%${term}%`);
      where.push(`(${['organisation', 'contact_name', 'contact_role', 'contact_email', 'subject', 'sender'].map((c) => `${c} ilike $${params.length}`).join(' or ')})`);
    }
    params.push(limit + 1, offset);
    await as(user);
    const got = await one(`select coalesce(json_agg(e), '[]') as r from (select * from public.outreach_emails where ${where.join(' and ')}
      order by ${col} desc, id limit $${params.length - 1} offset $${params.length}) e`, params).then((r) => r.r.map(lib.emailFromRow), (e) => e.message);
    await as(null);
    return typeof got === 'string' ? got : { rows: got.slice(0, limit), more: got.length > limit };
  };
  const wk = { from: '2026-10-05', to: '2026-10-11' };
  const LISTS = [{ ...wk }, { ...wk, only: 'replies' }, { ...wk, only: 'logged' }, { ...wk, mailbox: A }, { ...wk, mailbox: '' },
    { ...wk, mailbox: B, only: 'logged' }, { ...wk, search: 'COUNCIL T2' }, { ...wk, search: ' josh@ ' }, { ...wk, search: 'pat.n1@' },
    { ...wk, limit: 5 }, { ...wk, limit: 5, offset: 5 }, { ...wk, limit: 5, offset: 20 }, { from: '2026-01-01', to: '2026-12-31', only: 'logged', limit: 100 }];
  const listMismatches = [];
  for (const opts of LISTS) {
    const sql = await liveList(newcomer, opts);
    const mine = lib.filterEmails(app, opts);
    const ids = (x) => (typeof x === 'string' ? x : { ids: x.rows.map((e) => e.rowKey), more: x.more });
    if (stable(ids(sql)) !== stable(ids(mine))) listMismatches.push({ opts, sql: ids(sql), js: ids(mine) });
  }
  const outOfSheet = lib.filterEmails(app, { from: '2026-01-01', to: '2026-12-31', only: 'logged', limit: 100 }).rows
    .filter((e) => ['t7a', 'g1'].includes(e.rowKey)).length;
  check('54. the emails list as live mode queries it (in the sheet only) gives the rows and `more` filterEmails() gives, for each '
    + 'mode, mailbox, Unassigned, search and page',
    !listMismatches.length && outOfSheet === 0, { listMismatches, outOfSheet });

  // 55. The RPCs read through RLS ----------------------------------------------------------------------------------------

  const asStaff = { hello: await compare(hello), newcomer: await compare(newcomer) };
  const hidden = {};
  for (const [name, user] of Object.entries({ alice, carol })) {
    hidden[name] = [await rpc(user, 'outreach_daily', '2026-01-01', '2026-12-31'), await rpc(user, 'outreach_breakdown', '2026-01-01', '2026-12-31')];
  }
  check('55. the RPCs read through RLS: staff with Outreach view or edit get the same numbers; without Outreach, or inactive, none',
    !asStaff.hello.length && !asStaff.newcomer.length && Object.values(hidden).every(([d, b]) => stable(d) === '[]' && stable(b) === '[]'),
    { asStaff, hidden });

  // 56. Removing a mailbox -----------------------------------------------------------------------------------------------

  await as(boss);
  const removed = await affected('delete from public.outreach_mailboxes where id = $1', [C]);
  await as(null);
  const leftover = await one(`select (select count(*)::int from public.outreach_notes where id = $1) as note,
    (select count(*)::int from public.outreach_emails where row_key = 'c1' and mailbox_id is null) as unassigned`, [sarahNote.id]);
  const appAfter = await appRows();
  const weekAfter = await rpc(david, 'outreach_daily', '2026-10-05', '2026-10-11');
  const unassignedAfter = Array.isArray(weekAfter) ? lib.outreachTotals(weekAfter, '').sent : weekAfter;
  check('56. removing a mailbox removes its notes (on delete cascade, as removeMailbox does in the app) and leaves its emails, '
    + 'as Unassigned, where the RPCs and the lib still agree',
    removed === 1 && leftover.note === 0 && leftover.unassigned === 1 && unassignedAfter === 4
      && stable(weekAfter) === stable(lib.outreachDaily(appAfter, '2026-10-05', '2026-10-11')),
    { removed, leftover, unassignedAfter, weekAfter });

  // 57. Two syncs at once -------------------------------------------------------------------------------------------------

  // Sync A started first; sync B started later (read the sheet later), after race-3 was deleted from it. B writes its rows
  // and flags race-3 as gone (stamping it with its start, as the function does); then A's upsert of all three lands late.
  // keep_newer_sync skips every A write, so B's rows stay B's and race-3 stays gone; A's own flagging touches nothing.
  const t0 = '2026-10-18T01:00:00.000Z';
  const tA = '2026-10-18T02:00:00.000Z';
  const tB = '2026-10-18T02:00:05.000Z';
  const raceRow = (key, at, subject) => ({ row_key: key, sender: 'david@example.com', subject, sent_on: '2026-10-17', in_sheet: true, synced_at: at });
  const flagGone = (at) => affected(`update public.outreach_emails set in_sheet = false, synced_at = $1
    where synced_at < $1 and in_sheet and row_key like 'race-%'`, [at]);
  await asSecretKey();
  const earlier = await postgrestUpsert('outreach_emails', [raceRow('race-3', t0, 'Old')], { onConflict: 'row_key' });
  const bUpsert = await postgrestUpsert('outreach_emails', [raceRow('race-1', tB, 'B'), raceRow('race-2', tB, 'B')], { onConflict: 'row_key' });
  const goneB = await flagGone(tB);
  const aUpsert = await postgrestUpsert('outreach_emails', [raceRow('race-1', tA, 'A'), raceRow('race-2', tA, 'A'), raceRow('race-3', tA, 'A')],
    { onConflict: 'row_key' });
  const goneA = await flagGone(tA);
  await as(null);
  const raced = await rows("select row_key, subject, in_sheet, synced_at from public.outreach_emails where row_key like 'race-%' order by row_key");
  const later = await (async () => {
    await asSecretKey();
    const n = await postgrestUpsert('outreach_emails', [raceRow('race-3', '2026-10-18T03:00:00.000Z', 'C')], { onConflict: 'row_key' });
    await as(null);
    return { n, row: await one("select subject, in_sheet, synced_at from public.outreach_emails where row_key = 'race-3'") };
  })();
  await asSecretKey();
  await db.query("delete from public.outreach_emails where row_key like 'race-%'");
  await as(null);
  check('57. two syncs at once: an older sync\'s late upsert never overwrites a newer sync\'s rows nor brings back a row it flagged '
    + 'as gone (keep_newer_sync; flagged rows carry the newer start); a later sync still writes (and restores a row back in the sheet)',
    earlier === null && bUpsert === null && goneB === 1 && aUpsert === null && goneA === 0
      && stable(raced.map((r) => [r.row_key, r.subject, r.in_sheet, r.synced_at.toISOString()])) === stable([
        ['race-1', 'B', true, tB], ['race-2', 'B', true, tB], ['race-3', 'Old', false, tB]])
      && later.n === null && later.row.subject === 'C' && later.row.in_sheet === true
      && later.row.synced_at.toISOString() === '2026-10-18T03:00:00.000Z',
    { earlier, bUpsert, goneB, aUpsert, goneA, raced, later });

  // 58. Outreach and Clients boards ------------------------------------------------------------------------------------

  // 0007 widens the three checks that list the board modules and starts Outreach with Sales Tasks and Clients with Demos
  // and Previews, each with a To do group. Team boards follow their module's level: Outreach (Hello view, New edit,
  // Alice none) and Clients (staff view by default, so New only reads there).
  {
    await as(null);
    const moduleBoards = async () => (await rows(`select b.module, b.name, b.position,
        coalesce((select array_agg(g.name order by g.position) from public.board_groups g where g.board_id = b.id), '{}') as groups
      from public.boards b where b.module in ('outreach', 'clients') order by b.module desc, b.position, b.name`))
      .map((r) => [r.module, r.name, r.position, r.groups]);
    const started = await moduleBoards();
    const lists = (await rows(`select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conname in ('boards_module_check', 'board_groups_board_key_check', 'items_board_key_check') order by conname`))
      .map((r) => [r.conname, ['projects', 'marketing', 'outreach', 'clients'].every((m) => r.def.includes(`'${m}'`))]);
    const groupOf = async (module, name) => (await one(`select g.id from public.board_groups g join public.boards b on b.id = g.board_id
      where b.module = $1 and b.name = $2 and b.owner_id is null order by g.position limit 1`, [module, name])).id;
    const salesGroup = await groupOf('outreach', 'Sales Tasks');
    const demosGroup = await groupOf('clients', 'Demos');
    const campaignGroup = await groupOf('marketing', 'Campaigns');
    const seen = {};
    for (const [name, user] of Object.entries({ david, boss, hello, newcomer, alice, carol })) {
      await as(user);
      seen[name] = (await rows("select module, name from public.boards where module in ('outreach', 'clients') order by module desc, position"))
        .map((r) => `${r.module}:${r.name}`).join(',');
    }
    const task = async (user, board, group, name) => { await as(user); return error('insert into items (board_key, group_id, name) values ($1, $2, $3)', [board, group, name]); };
    const tasks = {
      editSales: await task(newcomer, 'outreach', salesGroup, 'Call the referral'),
      viewSales: await task(hello, 'outreach', salesGroup, 'Nope'),
      noneSales: await task(alice, 'outreach', salesGroup, 'Nope'),
      viewDemos: await task(newcomer, 'clients', demosGroup, 'Nope'),
      adminDemos: await task(boss, 'clients', demosGroup, 'Coastal Rail demo'),
    };
    await as(newcomer);
    const staffBoard = await error("insert into public.boards (module, name, position) values ('outreach', 'Mine', 9)");
    await as(boss);
    const partners = await one("insert into public.boards (module, name, position) values ('outreach', 'Partners', 1) returning id");
    const renamed = await affected("update public.boards set name = 'Partner deals' where id = $1", [partners.id]);
    const removed = await affected('delete from public.boards where id = $1', [partners.id]);
    // Tasks and groups stay in their module: onto Marketing or across Outreach and Clients is refused, even for an admin.
    await as(null);
    const callTask = (await one("select id from public.items where name = 'Call the referral'")).id;
    const demosBoard = (await one("select id from public.boards where module = 'clients' and name = 'Demos'")).id;
    await as(boss);
    const moves = {
      toMarketing: await error("update public.items set board_key = 'marketing', group_id = $2 where id = $1", [callTask, campaignGroup]),
      toClients: await error("update public.items set board_key = 'clients', group_id = $2 where id = $1", [callTask, demosGroup]),
      groupToClients: await error("update public.board_groups set board_key = 'clients', board_id = $2 where id = $1", [salesGroup, demosBoard]),
    };
    // Running 0007 again changes nothing; nor after the starting boards are renamed or deleted (they never come back).
    const again = await applyMigration7();
    const afterAgain = await moduleBoards();
    await as(null);
    await db.query("update public.boards set name = 'Sales' where module = 'outreach' and name = 'Sales Tasks'");
    await db.query("delete from public.boards where module = 'clients' and name = 'Previews'");
    const third = await applyMigration7();
    const afterThird = await moduleBoards();
    await as(null);
    check('58. Outreach and Clients boards: 0007 starts Sales Tasks, Demos and Previews (a To do group each) once, with the board checks '
      + 'widened; they follow Outreach / Clients access (view reads, edit writes tasks, admins add, rename and delete boards); tasks and '
      + 'groups stay in their module; a re-run (also after a rename or delete) brings nothing back',
      stable(started) === stable([['outreach', 'Sales Tasks', 0, ['To do']], ['clients', 'Demos', 0, ['To do']], ['clients', 'Previews', 1, ['To do']]])
        && lists.length === 3 && lists.every(([, ok]) => ok)
        && seen.david === 'outreach:Sales Tasks,clients:Demos,clients:Previews' && seen.boss === seen.david
        && seen.hello === seen.david && seen.newcomer === seen.david && seen.alice === 'clients:Demos,clients:Previews' && seen.carol === ''
        && tasks.editSales === null && tasks.viewSales !== null && tasks.noneSales !== null && tasks.viewDemos !== null && tasks.adminDemos === null
        && staffBoard !== null && renamed === 1 && removed === 1 && Object.values(moves).every((e) => e !== null)
        && again === null && stable(afterAgain) === stable(started) && third === null
        && stable(afterThird) === stable([['outreach', 'Sales', 0, ['To do']], ['clients', 'Demos', 0, ['To do']]]),
      { started, lists, seen, tasks, staffBoard, renamed, removed, moves, again, afterAgain, third, afterThird });
  }

  await as(null);
  return ctx;
}

// 22. (After the newest migration, since flatten() writes every synced column and table.)
async function syncWriteCheck({ david, alice, boss, hello, early, newcomer, board, page }) {
  // The sync engine's writes: the superadmin (who may write every table) saves flatten() rows for every synced
  // table the way PostgREST sends them, and reading them back the way PostgREST returns them (json) gives the same
  // rows. Catches a column, type or FK order that schema.js and the migrations disagree on, and policies that refuse
  // a normal save. Boards are new team boards here (personal pages: below), and so are Outreach's (who: below).

  await as(david);
  const [grp, grp2, itm, cli, inv, pln, con, chn, rtn, stm, teamP, teamM, mbx, mbx2, dl] = Array.from({ length: 15 }, uid);
  const flat = flatten({
    me: david,
    users: [],
    org: {},
    moduleAccess: [{ userId: hello, module: 'outreach', level: 'view' }],
    boards: [
      { id: teamP, module: 'projects', name: 'Sync check', owner: '', groups: [{ id: grp, name: 'Sync check', color: '#d6e4ff', items: [{
        id: itm, name: 'Item', values: { people: [david, alice], status: 'Done', due: '2026-10-30' }, done: true,
        updates: [{ id: uid(), user: david, text: 'Update', ts: '2026-10-01T03:00:00.000Z' }], subtasks: [{ id: uid(), text: 'Sub', done: true }],
      }] }] },
      { id: teamM, module: 'marketing', name: 'Sync check', owner: '', calendar: true, groups: [{ id: grp2, name: 'Sync check', color: '#bfe9ff', items: [] }] },
    ],
    clients: [{
      id: cli, name: 'Example Client', group: 'Active', status: 'Active', priority: 'P1', next: 'Call', sector: 'Utilities',
      contact: david, team: [david, alice], lastContact: '2026-10-01', demo: '', demoUrl: '', platformUrl: 'https://example-client.example.com',
      avatar: '#3b82f6', abn: '', billingAddress: '1 Example St',
      contacts: [{ id: uid(), name: 'Pat', role: 'Finance', email: 'pat@example.com', phone: '0400 000 000', billing: true }],
      contracts: [{
        id: uid(), status: 'Signed', title: 'Software Subscription Agreement', docId: 'doc', docUrl: 'https://docs.google.com/document/d/doc/edit',
        startDate: '2026-11-01', endDate: '2027-10-31', annualFee: 4500.5, paymentTerms: 'Invoiced annually in advance', userLimit: '1 master user',
        platform: 'Property Management', customisations: 'Ten', mobileApp: 'Included', governingLaw: 'New South Wales', createdBy: david,
        sentBy: alice, sentAt: '2026-10-20T01:00:00.000Z', signedAt: '2026-10-22',
      }],
      notes: [{ id: uid(), user: david, text: 'Note', ts: '2026-10-02T00:00:00.000Z' }], tasks: [{ id: uid(), text: 'Task', done: false }],
      invoices: [{
        id: inv, number: 'SYNC-1001', issued: '2026-10-08', due: '', status: 'Paid', planId: pln, sentAt: '2026-10-08T02:00:00.000Z',
        paidOn: '2026-10-10', sentTo: 'pat@example.com', lines: [{ id: uid(), desc: 'Line', qty: '1,000', rate: 0.125 }],
      }],
      access: [{ id: uid(), name: 'Pat', email: 'pat@example.com', role: 'Viewer' }],
      plans: [{ id: pln, description: 'Licence', amount: 1500.5, frequency: 'quarterly', nextDate: '2026-11-01', active: true }],
      usage: [{ id: uid(), month: '2026-09-01', assets: 1200, sites: 4, seats: 9, credits: 1840.25, notes: 'Pilot' }],
    }],
    deals: [{
      id: dl, name: 'Example Client', sector: 'Utilities', value: '1,500.50', priority: 'P1', stage: 'Won', contact: alice, next: '',
      clientId: cli, contactId: con,
    }],
    // A client's meeting (from its deal) and link (0012).
    crmEntries: [
      { id: uid(), dealId: dl, clientId: cli, kind: 'meeting', title: 'Kick-off', body: 'Agreed the pilot',
        url: 'https://docs.google.com/document/d/example/edit', label: '', happenedOn: '2026-10-08', attendees: 'Pat', user: david,
        createdAt: '2026-10-08T00:00:00.000Z' },
      { id: uid(), dealId: '', clientId: cli, kind: 'link', title: 'Deck', body: '', url: 'https://example.com/deck', label: 'Deck',
        happenedOn: '', attendees: '', user: david, createdAt: '2026-10-09T00:00:00.000Z' },
    ],
    contacts: [{ id: con, name: 'Pat', org: 'Example Org', email: 'pat@example.com', stage: 'Won', status: 'Opened', last: '', owner: alice }],
    emails: [{ id: uid(), kind: 'sent', contactId: con, contact: 'Pat', subject: 'Hello', snippet: 'Hi', ts: '2026-10-04T00:00:00.000Z' }],
    sequences: [{ id: uid(), name: 'Intro', steps: 3, enrolled: 2, replyRate: 0.25 }],
    approvals: [{ id: uid(), contactId: con, contact: 'Pat', subject: 'Draft', body: 'Body', by: david, ts: '2026-10-05T00:00:00.000Z' }],
    channels: [{ id: chn, name: 'sync-check', members: [david, boss] }],
    messages: [{ id: uid(), channel: chn, user: david, text: 'hello', ts: '2026-10-06T00:00:00.000Z' }],
    lastRead: { [david]: { [chn]: '2026-10-06T00:00:00.000Z' } },
    routines: [{ id: rtn, title: 'Sync routine', category: 'LinkedIn', minutes: 20, assignee: david, weekdays: [1, 3, 5], start: '08:00', active: true }],
    todos: [{
      id: uid(), assignee: david, createdBy: david, title: 'Sync to-do', notes: 'Note', day: '2026-10-12', start: '09:30', minutes: 45,
      category: 'Demos', source: 'routine', routineId: rtn, ref: '', done: true, doneAt: '2026-10-12T01:00:00.000Z',
    }],
    bankStatements: [{
      id: stm, weekStart: '2026-10-05', filePath: `statements/${uid()}-week.png`, note: 'Week 41', uploadedBy: david,
      createdAt: '2026-10-06T00:00:00.000Z',
    }],
    payments: [{ id: uid(), invoiceId: inv, clientId: cli, amount: 1650.55, receivedOn: '2026-10-10', reference: 'EFT 123', statementId: stm }],
    expenses: [{
      id: uid(), date: '2026-10-03', vendor: 'Example Hosting', category: 'Software', amount: 110, gst: 10, clientId: cli,
      receiptPath: `receipts/${uid()}-receipt.pdf`, notes: '', createdBy: david,
    }],
    subscriptions: [{
      id: uid(), name: 'Example Suite', vendor: 'Example Co', category: 'Software', amount: 29.99, cycle: 'monthly', renewsOn: '2026-11-01',
      active: true, notes: '',
    }],
    timeEntries: [{ id: uid(), user: david, day: '2026-10-12', start: '09:00', minutes: 60, category: 'Demos', note: 'Prep', source: 'suggested' }],
    tools: [{ id: uid(), user: hello, name: 'Apollo', url: 'https://app.apollo.io', username: 'hello@example.com', how: 'Invite', notes: '', createdBy: david }],
    mailboxes: [
      { id: mbx, name: 'Sync check', addresses: [' Sync.Check@Example.com', 'sync.check@old.example.com'], owner: david, active: true },
      { id: mbx2, name: 'Paused', addresses: [], owner: '', active: false },
    ],
    outreachNotes: [
      { id: uid(), mailbox: mbx, pinned: true, body: 'Pinned', author: david, createdAt: '2026-10-07T00:00:00.000Z' },
      { id: uid(), mailbox: '', pinned: false, body: 'For every mailbox', author: david, createdAt: '2026-10-06T00:00:00.000Z' },
    ],
    outreachSheet: 'https://docs.google.com/spreadsheets/d/1ExampleSyncCheckSheetId0123456789/edit#gid=0',
    calendarEvents: [
      { id: uid(), kind: 'event', title: 'Sync check conference', day: '2026-10-20', endDay: '2026-10-22', startsAt: '', endsAt: '', people: [david, alice],
        createdBy: david },
      { id: uid(), kind: 'meeting', title: 'Sync check meeting', day: '2026-10-23', endDay: '', startsAt: '2026-10-22T23:00:00.000Z',
        endsAt: '2026-10-23T00:30:00.000Z', people: [], createdBy: david },
      { id: uid(), kind: 'reminder', title: 'Sync check reminder', day: '2026-10-24', endDay: '', startsAt: '2026-10-23T22:00:00.000Z', endsAt: '',
        people: [hello], createdBy: david },
    ],
  });
  // Columns the database sets itself whatever a signed-in request sends (protect_outreach_note: a note's date is when
  // it was saved): compared without them here, and checked to be the server's below.
  const SERVER_SET = { outreach_notes: ['created_at'], crm_entries: ['created_at'] };
  const withoutServerSet = (table, r) => {
    const x = { ...r };
    (SERVER_SET[table] || []).forEach((c) => { delete x[c]; });
    return x;
  };
  const writeErrors = {};
  const mismatched = {};
  // Profiles / org_settings / outreach_settings are plain updates (checked in 5., 20. and below).
  for (const t of TABLES.filter((x) => !x.update)) {
    const sent = [...flat[t.name].values()];
    if (!sent.length) { writeErrors[t.name] = 'fixture has no rows'; continue; }
    const err = await postgrestUpsert(t.name, sent, t);
    if (err) { writeErrors[t.name] = err; continue; }
    const back = (await one(`select coalesce(json_agg(x), '[]') as rows from public.${t.name} x`)).rows
      .map((r) => normalizeRow(t.name, r));
    const byKey = new Map(back.map((r) => [t.key(r), r]));
    const diffs = sent.filter((r) => {
      const got = byKey.get(t.key(r));
      return !got || stable(withoutServerSet(t.name, got)) !== stable(withoutServerSet(t.name, r));
    });
    if (diffs.length) mismatched[t.name] = { sent: diffs[0], back: byKey.get(t.key(diffs[0])) ?? null };
  }
  check('sync: flatten() rows for every synced table save as PostgREST sends them and read back unchanged',
    !Object.keys(writeErrors).length && !Object.keys(mismatched).length, { writeErrors, mismatched });
  const noteDates = (await rows('select created_at from public.outreach_notes where id = any($1::uuid[])', [[...flat.outreach_notes.keys()]]))
    .map((r) => r.created_at);
  check('sync: a new note\'s date is the database\'s (when it was saved), not the one the client sent',
    noteDates.length === 2 && noteDates.every((d) => Math.abs(Date.now() - d.getTime()) < 10 * 60e3), noteDates);

  // Outreach for whoever may write it, as the sync sends it: mailboxes are the admins'; a note its author's (with Outreach
  // edit), and an admin re-saving someone's keeps its author; the sheet's link the admins' (a plain update: TABLES marks
  // outreach_settings update-only, as the row always exists). Staff with Outreach view save nothing.
  const outRows = (table, st) => [...flatten({ users: [], org: {}, ...st })[table].values()];
  const saveOut = async (user, table, list) => { await as(user); const e = await postgrestUpsert(table, list); await as(null); return e; };
  const staffNote = { id: uid(), mailbox: mbx, pinned: false, body: 'From staff', author: newcomer, createdAt: '2026-10-08T00:00:00.000Z' };
  const outSaved = {
    adminMailbox: await saveOut(boss, 'outreach_mailboxes', outRows('outreach_mailboxes', {
      mailboxes: [{ id: uid(), name: 'Added by an admin', addresses: ['added@example.com'], owner: boss, active: true }],
    })),
    staffMailbox: await saveOut(newcomer, 'outreach_mailboxes', outRows('outreach_mailboxes', {
      mailboxes: [{ id: uid(), name: 'Added by staff', addresses: [], owner: '', active: true }],
    })),
    staffNote: await saveOut(newcomer, 'outreach_notes', outRows('outreach_notes', { outreachNotes: [staffNote] })),
    viewerNote: await saveOut(hello, 'outreach_notes', outRows('outreach_notes', { outreachNotes: [{ ...staffNote, id: uid(), author: hello }] })),
    adminResave: await saveOut(boss, 'outreach_notes', outRows('outreach_notes', { outreachNotes: [{ ...staffNote, body: 'From staff (tidied)' }] })),
  };
  const staffNoteBack = normalizeRow('outreach_notes', (await one('select row_to_json(n) as r from public.outreach_notes n where id = $1',
    [staffNote.id]))?.r);
  const sheet = flat.outreach_settings.get('1');
  const saveSheet = async (user) => {
    await as(user);
    const n = await affected('update public.outreach_settings set sheet_url = $1 where id = $2', [sheet.sheet_url, sheet.id]);
    await as(null);
    return n;
  };
  const sheetSaves = { viewer: await saveSheet(hello), editor: await saveSheet(newcomer), admin: await saveSheet(boss) };
  const sheetBack = normalizeRow('outreach_settings', await one('select * from public.outreach_settings where id = 1'));
  check('sync: Outreach saves for whoever may write it: mailboxes admins; notes their author with Outreach edit (an admin '
    + 're-saving one keeps its author), never view-only staff; the sheet\'s link admins, as an update',
    outSaved.adminMailbox === null && typeof outSaved.staffMailbox === 'string' && outSaved.staffNote === null
      && typeof outSaved.viewerNote === 'string' && outSaved.adminResave === null && staffNoteBack.author_id === newcomer
      && staffNoteBack.body === 'From staff (tidied)' && sheetSaves.viewer === 0 && sheetSaves.editor === 0 && sheetSaves.admin === 1
      && stable(sheetBack) === stable(sheet),
    { outSaved, staffNoteBack, sheetSaves, sheet, sheetBack });

  // Calendar events for whoever may write them, as the sync sends them: staff add their own and change them; another staff
  // member's upsert over one is refused; an admin re-saving one keeps its author; a spoofed author is the saver.
  const calRows = (list) => outRows('calendar_events', { calendarEvents: list });
  const staffEvent = { id: uid(), kind: 'event', title: 'From staff', day: '2026-10-27', endDay: '', startsAt: '', endsAt: '', people: [alice], createdBy: alice };
  const calSaved = {
    staffNew: await saveOut(alice, 'calendar_events', calRows([staffEvent])),
    staffEdit: await saveOut(alice, 'calendar_events', calRows([{ ...staffEvent, title: 'From staff (edited)' }])),
    otherStaff: await saveOut(hello, 'calendar_events', calRows([{ ...staffEvent, title: 'Not mine', createdBy: hello }])),
    spoofed: await saveOut(hello, 'calendar_events', calRows([{ ...staffEvent, id: uid(), title: 'Spoofed', createdBy: boss }])),
    adminResave: await saveOut(boss, 'calendar_events', calRows([{ ...staffEvent, title: 'From staff (tidied)', createdBy: boss }])),
  };
  const calBack = (await rows(`select title, created_by from public.calendar_events where title in ('From staff (tidied)', 'Spoofed')
    order by title`)).map((r) => [r.title, r.created_by]);
  check('sync: calendar events save for whoever may write them: staff their own (new and edited), never someone else\'s; an admin '
    + 're-saving one keeps its author; the author is always whoever saved it',
    calSaved.staffNew === null && calSaved.staffEdit === null && typeof calSaved.otherStaff === 'string' && calSaved.spoofed === null
      && calSaved.adminResave === null && stable(calBack) === stable([['From staff (tidied)', alice], ['Spoofed', hello]]),
    { calSaved, calBack });

  // Boards for the people who may write them (39.), saved the same way. A personal page's own row is never sent:
  // flatten() makes it exactly as the database holds it (unnamed, position 0), so diff() leaves it out (no client may
  // write it); only what's on the page is.
  const onBoard = (id, module, owner, author) => ({
    id, module, name: owner ? '' : 'Unchanged', owner: owner || '', groups: [{
      id: uid(), name: 'Synced', color: '#d6e4ff', items: [{
        id: uid(), name: 'Synced task', values: { people: [author] }, done: false,
        updates: [{ id: uid(), user: author, text: 'Synced', ts: '2026-10-16T00:00:00.000Z' }], subtasks: [{ id: uid(), text: 'Synced', done: false }],
      }],
    }],
  });
  const saveAs = async (user, spec, tables = ['board_groups', 'items', 'item_updates', 'subtasks']) => {
    const sent = flatten({ me: user, users: [], org: {}, boards: [spec] });
    await as(user);
    const out = {};
    for (const t of TABLES.filter((x) => tables.includes(x.name))) out[t.name] = await postgrestUpsert(t.name, [...sent[t.name].values()], t);
    await as(null);
    return out;
  };
  const saved = {
    staffOwnPage: await saveAs(alice, onBoard(page[alice], 'projects', alice, alice)),
    staffMarketing: await saveAs(alice, onBoard(board['Daily Automation'], 'marketing', '', alice)),
    staffProjects: await saveAs(alice, onBoard(board['Landing Page'], 'projects', '', alice)),
    adminStaffPage: await saveAs(boss, onBoard(page[alice], 'projects', alice, boss)),
    adminSuperPage: await saveAs(boss, onBoard(page[david], 'projects', david, boss)),
    adminAdminPage: await saveAs(boss, onBoard(page[early], 'projects', early, boss)),
    superAdminPage: await saveAs(david, onBoard(page[boss], 'projects', boss, david)),
    adminNewBoard: await saveAs(boss, { id: uid(), module: 'marketing', name: 'Synced board', owner: '', groups: [] }, ['boards']),
    staffNewBoard: await saveAs(alice, { id: uid(), module: 'marketing', name: 'Synced board', owner: '', groups: [] }, ['boards']),
  };
  const ok = (r) => Object.values(r).every((e) => e === null);
  const refused = (r) => Object.values(r).every((e) => typeof e === 'string');
  const pageRow = flatten({ boards: [{ id: page[alice], module: 'projects', name: '', owner: alice, groups: [] }] }).boards.get(page[alice]);
  const pageInDb = normalizeRow('boards', (await one('select row_to_json(b) as r from public.boards b where id = $1', [page[alice]])).r);
  check('sync: boards, groups (board_id) and tasks (board_id) save for whoever may write them: staff their page and Marketing, '
    + "admins staff's pages and new team boards, the SuperAdmin anyone's",
    ok(saved.staffOwnPage) && ok(saved.staffMarketing) && refused(saved.staffProjects) && ok(saved.adminStaffPage)
      && refused(saved.adminSuperPage) && refused(saved.adminAdminPage) && ok(saved.superAdminPage) && ok(saved.adminNewBoard)
      && refused(saved.staffNewBoard) && stable(pageRow) === stable(pageInDb),
    { saved, pageRow, pageInDb });

  await as(null);
}

// Editor-style runs ------------------------------------------------------------------------------------------------
// The Supabase SQL editor may run a pasted file statement by statement, each on its own (no surrounding transaction),
// and carry on after an error: 0006's first live run did. splitSql() cuts a file into statements (respecting quotes,
// comments and $tag$ bodies); runSplit() runs them one by one without begin/commit, stopping at the first error or
// carrying on, and skipping statements a test marks as failed (`skip`).

function splitSql(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') { const end = sql.indexOf('\n', i); const stop = end < 0 ? sql.length : end + 1; cur += sql.slice(i, stop); i = stop; continue; }
    if (two === '/*') { const stop = sql.indexOf('*/', i) + 2; cur += sql.slice(i, stop); i = stop; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === ch && sql[j + 1] !== ch)) j += sql[j] === ch ? 2 : 1;
      cur += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) { const stop = sql.indexOf(m[0], i + m[0].length) + m[0].length; cur += sql.slice(i, stop); i = stop; continue; }
    }
    if (ch === ';') { out.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  out.push(cur);
  const code = (st) => st.replace(/--.*$/gm, '').trim();
  return out.filter((st) => code(st) && !/^(begin|commit)$/i.test(code(st)));
}

// ── 0011: everyone reads module access levels ─────────────────────────────────────────────────────────────────────

async function phase11(ctx) {
  const { alice, boss, david, hello, carol } = ctx;
  const all = async (who) => { await as(who); return (await rows('select user_id, module, level from module_access order by user_id, module')).map((r) => `${r.user_id}:${r.module}:${r.level}`); };
  const before = { staff: await all(alice), admin: await all(boss) };

  // 94. Runs on top of 0010, whole, again, and statement by statement.
  await as(null);
  const first = await db.exec(migration11).then(() => null, async (e) => { await db.exec('rollback').catch(() => {}); return e.message; });
  const second = await db.exec(migration11).then(() => null, async (e) => { await db.exec('rollback').catch(() => {}); return e.message; });
  await as(null);
  const splitErrors = await runSplit(db, migration11, { continueOnError: true });
  const body = migration11.replace(/--.*$/gm, '').trim();
  check('94. 0011 runs on top of 0010, re-runs whole and statement by statement, and never mentions module_level',
    first === null && second === null && !splitErrors.length && /^begin;/i.test(body) && /commit;$/i.test(body) && !migration11.includes('module_level'),
    { first, second, splitErrors });
  if (first) return null;

  // 95. Staff now read every level, as admins do; inactive people read none; only the SuperAdmin changes them.
  const staffNow = await all(alice);
  const helloNow = await all(hello);
  const adminNow = await all(boss);
  const inactive = await all(carol);
  check('95. staff read everyone’s module access levels (before: only their own), the same rows admins read; an inactive profile reads none',
    before.staff.length < before.admin.length && staffNow.join() === adminNow.join() && helloNow.join() === adminNow.join()
      && adminNow.length === before.admin.length && adminNow.length > 0 && inactive.length === 0,
    { before, staffNow: staffNow.length, adminNow: adminNow.length, inactive });
  await as(alice);
  const staffInsert = await error("insert into module_access (user_id, module, level) values ($1, 'clients', 'edit')", [hello]);
  const staffUpdate = await affected("update module_access set level = 'edit' where user_id <> $1", [alice]);
  const staffDelete = await affected('delete from module_access');
  await as(boss);
  const adminUpdate = await affected("update module_access set level = 'none'");
  await as(david);
  const superUpdate = await affected("update module_access set level = level where user_id = $1", [alice]);
  check('95. …but staff and admins still can’t add, change or remove them; the SuperAdmin can',
    staffInsert !== null && staffUpdate === 0 && staffDelete === 0 && adminUpdate === 0 && superUpdate > 0,
    { staffInsert, staffUpdate, staffDelete, adminUpdate, superUpdate });
  await as(null);
  return ctx;
}

// ── 0012: the CRM profile (crm_entries) ───────────────────────────────────────────────────────────────────────────

async function phase12(ctx) {
  const { alice, boss, david, hello, carol } = ctx;

  // 96. Runs on top of 0011, whole, again, and statement by statement.
  await as(null);
  const run = async () => db.exec(migration12).then(() => null, async (e) => { await db.exec('rollback').catch(() => {}); return e.message; });
  const first = await run();
  const second = await run();
  await as(null);
  const splitErrors = await runSplit(db, migration12, { continueOnError: true });
  const body = migration12.replace(/--.*$/gm, '').trim();
  const published = (await one("select count(*)::int as n from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'crm_entries'")).n;
  const rls = (await one("select relrowsecurity as on from pg_class where oid = 'public.crm_entries'::regclass")).on;
  check('96. 0012 runs on top of 0011, re-runs whole and statement by statement, never mentions module_level; crm_entries has RLS on and is in realtime',
    first === null && second === null && !splitErrors.length && /^begin;/i.test(body) && /commit;$/i.test(body) && !migration12.includes('module_level')
      && published === 1 && rls === true, { first, second, splitErrors, published, rls });
  if (first) return null;

  // Access: Alice (staff) Pipeline edit and Clients view; Hello (staff) Pipeline view and Clients edit.
  await as(david);
  await db.query("delete from module_access where user_id = any($1) and module in ('pipeline', 'clients')", [[alice, hello]]);
  await db.query(`insert into module_access (user_id, module, level) values ($1, 'pipeline', 'edit'), ($1, 'clients', 'view'),
    ($2, 'pipeline', 'view'), ($2, 'clients', 'edit')`, [alice, hello]);
  await as(boss);
  const deal = (await one("insert into deals (name, stage) values ('Example Shire', 'First meetings') returning id")).id;
  const other = (await one("insert into deals (name, stage) values ('Example Water', 'Contacted') returning id")).id;
  const client = (await one("insert into clients (name) values ('Example Shire') returning id")).id;
  const spare = (await one("insert into clients (name) values ('Example Rail') returning id")).id;

  // 97. A deal's entries: Pipeline edit adds (as themselves, now); Pipeline view reads but doesn't add.
  await as(alice);
  const meeting = (await one(`insert into crm_entries (deal_id, kind, title, body, url, happened_on, attendees, user_id, created_at)
    values ($1, 'meeting', 'First meeting', 'Wants a pilot', 'https://docs.google.com/document/d/example/edit', '2026-10-24', 'Jo Example', $2, '2020-01-01')
    returning id, user_id, created_at`, [deal, boss]));
  const link = (await one("insert into crm_entries (deal_id, kind, label, title, url) values ($1, 'link', 'Deck', 'Pitch deck', 'https://example.com/deck') returning id", [deal])).id;
  const note = (await one("insert into crm_entries (deal_id, kind, body) values ($1, 'note', 'Call back Friday') returning id", [other])).id;
  const recent = Date.now() - Date.parse(meeting.created_at) < 60_000;
  await as(hello);
  const helloReads = (await rows('select id from crm_entries where deal_id = $1', [deal])).length;
  const helloAdd = await error("insert into crm_entries (deal_id, kind, body) values ($1, 'note', 'Nope')", [deal]);
  await as(carol);
  const inactiveReads = (await rows('select id from crm_entries')).length;
  check('97. Pipeline edit adds notes, meetings and links to a deal (author and date are theirs, now); Pipeline view reads them but adds none; inactive sees none',
    meeting.user_id === alice && recent && helloReads === 2 && helloAdd !== null && inactiveReads === 0,
    { meeting, recent, helloReads, helloAdd, inactiveReads });

  // 98. Their author (or an admin) changes and removes them; others with edit don't. No entry belongs to nothing.
  await as(david);
  await db.query("insert into module_access (user_id, module, level) values ($1, 'pipeline', 'edit') on conflict (user_id, module) do update set level = 'edit'", [hello]);
  await as(hello);
  const othersEdit = await affected("update crm_entries set body = 'Changed' where id = $1", [meeting.id]);
  const othersDelete = await affected('delete from crm_entries where id = $1', [link]);
  await as(alice);
  const ownEdit = await affected("update crm_entries set body = 'Wants a pilot in March' where id = $1", [meeting.id]);
  await as(boss);
  const adminEdit = await affected("update crm_entries set title = 'Deck v2' where id = $1", [link]);
  const orphan = await error("insert into crm_entries (kind, body) values ('note', 'Nowhere')");
  const badKind = await error("insert into crm_entries (deal_id, kind) values ($1, 'call')", [deal]);
  check('98. an entry’s author changes their own and an admin anyone’s; another editor can’t; every entry is on a deal or client, and of a known kind',
    othersEdit === 0 && othersDelete === 0 && ownEdit === 1 && adminEdit === 1 && orphan !== null && badKind !== null,
    { othersEdit, othersDelete, ownEdit, adminEdit, orphan, badKind });

  // 99. The deal and client an entry belongs to don't move, and its author and date stay.
  await as(alice);
  await db.query('update crm_entries set deal_id = $2, client_id = $3, user_id = $4, created_at = now() - interval \'1 day\' where id = $1',
    [meeting.id, other, spare, boss]);
  const kept = await one('select deal_id, client_id, user_id, created_at from crm_entries where id = $1', [meeting.id]);
  check('99. an edit can’t move an entry to another deal or onto a client, or change its author or date',
    kept.deal_id === deal && kept.client_id === null && kept.user_id === alice && Date.parse(kept.created_at) === Date.parse(meeting.created_at), kept);

  // 100. Make client: the deal's entries become the client's (whoever wrote them), and Clients view reads them.
  await as(boss);
  await db.query('update deals set client_id = $2 where id = $1', [deal, client]);
  const carried = await rows('select id, deal_id, client_id from crm_entries where deal_id = $1 order by id', [deal]);
  await as(david);
  await db.query("update module_access set level = 'none' where user_id = $1 and module = 'pipeline'", [hello]);
  await db.query("insert into module_access (user_id, module, level) values ($1, 'clients', 'view') on conflict (user_id, module) do update set level = 'view'", [hello]);
  await as(hello);
  const clientsViewReads = (await rows('select id from crm_entries where client_id = $1', [client])).length;
  const otherDealHidden = (await rows('select id from crm_entries where id = $1', [note])).length;
  // Now the client's: Pipeline edit alone no longer writes them; Clients edit does.
  await as(alice);
  const pipelineOnlyEdit = await affected("update crm_entries set body = 'x' where id = $1", [meeting.id]);
  await as(david);
  await db.query("update module_access set level = 'edit' where user_id = $1 and module = 'clients'", [alice]);
  await as(alice);
  const clientsEditEdit = await affected("update crm_entries set body = 'Pilot agreed' where id = $1", [meeting.id]);
  const clientNote = await error("insert into crm_entries (client_id, kind, body) values ($1, 'note', 'Kick-off booked')", [client]);
  check('100. Make client carries the deal’s entries to the client (keeping the deal); Clients view then reads them; writing them takes Clients edit',
    carried.length === 2 && carried.every((r) => r.client_id === client && r.deal_id === deal) && clientsViewReads === 2 && otherDealHidden === 0
      && pipelineOnlyEdit === 0 && clientsEditEdit === 1 && clientNote === null,
    { carried, clientsViewReads, otherDealHidden, pipelineOnlyEdit, clientsEditEdit, clientNote });

  // 101. Deleting a deal: its entries that never reached a client go; a client's stay (no longer on the deal).
  await as(boss);
  const dealGone = await affected('delete from deals where id = $1', [deal]);
  const otherGone = await affected('delete from deals where id = $1', [other]);
  await as(null);
  const afterDelete = await rows('select id, deal_id, client_id from crm_entries where id = any($1) order by id', [[meeting.id, link, note]]);
  // 102. Deleting a client takes its entries with it.
  await as(boss);
  const clientGone = await affected('delete from clients where id = $1', [client]);
  await as(null);
  const left = (await one('select count(*)::int as n from crm_entries where id = any($1)', [[meeting.id, link]])).n;
  check('101. deleting a deal deletes its entries that never reached a client; the client’s stay, off the deal',
    dealGone === 1 && otherGone === 1 && afterDelete.length === 2 && afterDelete.every((r) => r.deal_id === null && r.client_id === client), afterDelete);
  check('102. deleting a client deletes its entries', clientGone === 1 && left === 0, { clientGone, left });
  await db.query('delete from clients where id = $1', [spare]);

  // 103. An entry added to a deal is its deal's client's when it has one (so it takes Clients edit, and reaches the
  // client), and never another client's; Make client carries a deal's entries only when done with Clients edit; an edit
  // can't take an entry off a deal that still exists.
  await as(david);
  await db.query("delete from module_access where user_id = any($1) and module in ('pipeline', 'clients')", [[alice, hello]]);
  await db.query(`insert into module_access (user_id, module, level) values ($1, 'pipeline', 'edit'), ($1, 'clients', 'view'),
    ($2, 'pipeline', 'view'), ($2, 'clients', 'edit')`, [alice, hello]);
  await as(boss);
  const won = (await one("insert into deals (name, stage) values ('Example Port', 'Demos') returning id")).id;
  const open = (await one("insert into deals (name, stage) values ('Example Lakes', 'Contacted') returning id")).id;
  const port = (await one("insert into clients (name) values ('Example Port') returning id")).id;
  const unrelated = (await one("insert into clients (name) values ('Example Bay') returning id")).id;
  await db.query('update deals set client_id = $2 where id = $1', [won, port]);
  await as(alice); // Pipeline edit, Clients view
  const lateByPipeline = await error("insert into crm_entries (deal_id, kind, body) values ($1, 'note', 'After Make client')", [won]);
  const openNote = (await one("insert into crm_entries (deal_id, kind, body) values ($1, 'note', 'On the open deal') returning id", [open])).id;
  await as(hello); // Clients edit, Pipeline view
  const lateByClients = await error("insert into crm_entries (deal_id, kind, body) values ($1, 'note', 'Kick-off notes')", [won]);
  const smuggled = await error("insert into crm_entries (deal_id, client_id, kind, body) values ($1, $2, 'note', 'Not mine to add')", [open, unrelated]);
  await as(null);
  const lateRow = await one("select client_id from crm_entries where body = 'Kick-off notes'");
  await as(alice); // deals' rules let Pipeline edit set a deal's client; the app's Make client also needs Clients edit
  const relinked = await affected('update deals set client_id = $2 where id = $1', [open, unrelated]);
  await db.query('update crm_entries set deal_id = null where id = $1', [openNote]);
  await as(null);
  const openRow = await one('select deal_id, client_id from crm_entries where id = $1', [openNote]);
  check('103. an entry added to a deal that is a client is the client’s (Clients edit, not Pipeline edit, adds it), never another client’s; Make client without Clients edit carries nothing; an edit can’t take an entry off its deal',
    lateByPipeline !== null && lateByClients === null && lateRow?.client_id === port && smuggled !== null
      && relinked === 1 && openRow.client_id === null && openRow.deal_id === open,
    { lateByPipeline, lateByClients, lateRow, smuggled, relinked, openRow });

  // 104. The app saves edits as upserts (the whole row, as flatten() makes it): an edit is judged as the entry stands,
  // even when its deal's client has changed since or the deal is gone, and never moves it.
  const entryRow = async (id) => one(`select id, deal_id, client_id, kind, title, body, url, label, happened_on, attendees, user_id, created_at
    from crm_entries where id = $1`, [id]);
  const save = (r, patch) => postgrestUpsert('crm_entries', [{ ...r, ...patch }]);
  await as(hello); // Clients edit, Pipeline view: the author of the client's Kick-off notes
  const kickoff = await entryRow((await one("select id from crm_entries where body = 'Kick-off notes'")).id);
  await as(alice); // a Pipeline editor takes the deal off its client (REST, or a stale full-row save)
  await db.query('update deals set client_id = null where id = $1', [won]);
  await as(hello);
  const unlinkedSave = await save(kickoff, { body: 'Kick-off on the 4th' });
  await as(alice); // her own entry on the open deal, whose client was set without Clients edit (nothing carried)
  const aliceSave = await save(await entryRow(openNote), { body: 'Still open' });
  await as(boss);
  const adminSave = await save(await entryRow(openNote), { title: 'Checked' });
  await as(null);
  const afterSaves = await rows('select body, client_id from crm_entries where id = any($1) order by body', [[kickoff.id, openNote]]);
  check('104. an edit saved as an upsert is judged as the entry stands (its client’s rules, or its deal’s) and never moves it, whatever its deal’s client is now',
    unlinkedSave === null && aliceSave === null && adminSave === null
      && stable(afterSaves) === stable([{ body: 'Kick-off on the 4th', client_id: port }, { body: 'Still open', client_id: null }]),
    { unlinkedSave, aliceSave, adminSave, afterSaves });
  await as(boss);
  await db.query('delete from deals where id = any($1)', [[won, open]]);
  await db.query('delete from clients where id = any($1)', [[port, unrelated]]);
  return ctx;
}

// ── 0013: task emails (the queue, claim and settings) ─────────────────────────────────────────────────────────────

async function phase13(ctx) {
  const { alice, boss, david, hello } = ctx;

  // 104. Runs on top of 0012, whole, again, and statement by statement; ends with its done row.
  await as(null);
  const run = async () => db.exec(migration13).then((r) => r, async (e) => { await db.exec('rollback').catch(() => {}); return e.message; });
  const first = await run();
  const second = await run();
  await as(null);
  const splitErrors = await runSplit(db, migration13, { continueOnError: true });
  const body = migration13.replace(/--.*$/gm, '').trim();
  const doneRow = Array.isArray(first) ? first.at(-1)?.rows?.[0]?.done : null;
  check('104. 0013 runs on top of 0012, re-runs whole and statement by statement, never mentions module_level, and ends with its done row',
    doneRow === 'Cortex 0013 applied' && Array.isArray(second) && !splitErrors.length && /^begin;/i.test(body)
      && /commit;\s*select 'Cortex 0013 applied' as done;$/i.test(body) && !migration13.includes('module_level'),
    { first: Array.isArray(first) ? 'ok' : first, second: Array.isArray(second) ? 'ok' : second, splitErrors });
  if (!Array.isArray(first)) return null;

  // Staff at the default (Edit) on Operations for this phase; what earlier phases set comes back at the end.
  await as(null);
  const access = await rows("select user_id, level from module_access where user_id = any($1) and module = 'projects'", [[alice, hello]]);
  await db.query("delete from module_access where user_id = any($1) and module = 'projects'", [[alice, hello]]);
  const board = (await one("select id from boards where module = 'projects' and owner_id is null order by position, name limit 1")).id;
  const group = (await one('select id from board_groups where board_id = $1 order by position, name limit 1', [board])).id;
  const wipBoard = (await one("insert into boards (module, name, position) values ('pipeline', 'Example WIP', 9) returning id")).id;
  const wip = { board: wipBoard, grp: (await one("insert into board_groups (board_key, board_id, name, position) values ('pipeline', $1, 'Active', 0) returning id", [wipBoard])).id };
  const task = async (name, owner, { on = board, grp = group, key = 'projects', status = 'Not started' } = {}) => (await one(
    `insert into items (board_key, board_id, group_id, name, "values") values ($1, $2, $3, $4, $5) returning id`,
    [key, on, grp, name, { people: owner ? [owner] : [], status, priority: 'High', due: '2026-10-30' }])).id;
  const queue = async () => { await as(null); return rows('select kind, item_id, update_id, recipient, actor, sent_at from private.task_mail order by id'); };
  const svc = async () => { await db.exec('set role service_role'); await db.query("select set_config('request.jwt.claim.sub', '', false)"); };
  await as(null);
  await db.query('delete from private.task_mail');

  // 105. Queued: a task made for someone else, a task handed to someone else, an update on someone else's task. Not: your
  // own task, an edit that keeps the owner, your own update, rows written with no signed-in user, Work in Progress rows.
  await as(boss);
  const forAlice = await task('Council landing page', alice);
  await task('Mine', boss);
  const handed = await task('Tender pack', boss);
  await as(alice);
  await db.query(`update items set "values" = jsonb_set("values", '{status}', '"Working on it"') where id = $1`, [forAlice]);
  await db.query("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Draft is up')", [forAlice, alice]);
  await as(boss);
  await db.query(`update items set "values" = jsonb_set("values", '{people}', $2::jsonb) where id = $1`, [handed, JSON.stringify([hello])]);
  await as(hello);
  const update = (await one("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Can you check the hero copy?') returning id", [forAlice, hello])).id;
  await as(null);
  await task('Imported', alice);
  await as(boss);
  await task('Example Shire', alice, { on: wip.board, grp: wip.grp, key: 'pipeline' });
  const q1 = await queue();
  const shape = q1.map((r) => `${r.kind}:${r.item_id === forAlice ? 'forAlice' : r.item_id === handed ? 'handed' : r.item_id}:${r.recipient === alice ? 'alice' : r.recipient === hello ? 'hello' : r.recipient}:${r.actor === boss ? 'boss' : r.actor === hello ? 'hello' : r.actor}`);
  check('105. the queue gets a task made for someone else, one handed to someone else and an update on someone else’s task; not your own work, a kept owner, imports from the SQL editor or Work in Progress',
    shape.join() === 'assigned:forAlice:alice:boss,assigned:handed:hello:boss,update:forAlice:alice:hello' && q1[2].update_id === update, shape);

  // 106. A sync write (PostgREST upsert) that keeps the owner queues nothing; one that hands the task over queues once.
  await as(alice);
  const row = await one('select id, board_key, group_id, board_id, position, name, "values", done from items where id = $1', [forAlice]);
  const same = await postgrestUpsert('items', [{ ...row, values: row.values }]);
  const afterSame = (await queue()).length;
  await as(alice);
  const moved = await postgrestUpsert('items', [{ ...row, values: { ...row.values, people: [david] } }]);
  const afterMove = await queue();
  check('106. a sync upsert that keeps the owner queues nothing; one handing the task to someone else queues one email for them',
    same === null && moved === null && afterSame === 3 && afterMove.length === 4 && afterMove[3].recipient === david && afterMove[3].actor === alice,
    { same, moved, afterSame, last: afterMove[3] });
  await as(alice);
  await postgrestUpsert('items', [{ ...row, values: { ...row.values, people: [alice] } }]); // she takes it back: nothing queued

  // 107. Only the database and the function touch the queue: staff and admins can't read it or claim; the status and
  // sender settings are admins'.
  await as(alice);
  const staffRead = await error('select * from private.task_mail');
  const staffClaim = await error('select task_mail_claim()');
  const staffStatus = await error('select task_mail_status()');
  const staffUse = await error('select task_mail_use_me()');
  await as(boss);
  const adminClaim = await error('select task_mail_claim()');
  const adminDone = await error("select task_mail_done('{1}', '')");
  const adminStatus = await one('select task_mail_status() as s');
  check('107. nobody signed in reads the queue or claims it; only admins read the status or change the sender',
    staffRead !== null && staffClaim !== null && staffStatus !== null && staffUse !== null && adminClaim !== null && adminDone !== null
      && adminStatus.s.sender_id === null && adminStatus.s.ready === false && adminStatus.s.waiting === 4,
    { staffRead, staffClaim, staffStatus, staffUse, adminClaim, adminDone, adminStatus });

  // 108. No sender: nothing is claimed. An admin without Gmail send can't be the sender; with it they can.
  await svc();
  const idle = await one('select task_mail_claim() as c');
  await as(null);
  await db.query('delete from private.google_accounts where user_id = $1', [boss]);
  await as(boss);
  const noGoogle = await error('select task_mail_use_me()');
  await as(null);
  await db.query(`insert into private.google_accounts (user_id, email, refresh_token, scopes) values ($1, 'boss@example.com', 'r',
    'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/drive')
    on conflict (user_id) do update set scopes = excluded.scopes, refresh_token = 'r'`, [boss]);
  await as(boss);
  const chosen = await one('select task_mail_use_me() as ok');
  const ready = (await one('select task_mail_status() as s')).s;
  await as(null);
  const unclaimed = (await one('select count(*)::int as n from private.task_mail where claimed_at is not null')).n;
  check('108. without a sender nothing is claimed; an admin needs Gmail send to become the sender, then the status shows it ready',
    idle.c.sender === null && idle.c.mails.length === 0 && unclaimed === 0 && noGoogle !== null && chosen.ok === true
      && ready.ready === true && ready.sender_id === boss && ready.sender_email === 'boss@example.com',
    { idle: idle.c, noGoogle, ready });

  // 109. A claim: one entry per person with what each email needs; what's no longer theirs (Council landing page went to
  // David, then Alice took it back) is dropped unsent; a second claim straight after gets nothing.
  await svc();
  const claim = (await one('select task_mail_claim() as c')).c;
  const again = (await one('select task_mail_claim() as c')).c;
  await as(null);
  const dropped = (await rows("select recipient from private.task_mail where error = 'not sent: no longer theirs'")).map((r) => r.recipient);
  const byTo = Object.fromEntries(claim.mails.map((m) => [m.to, m]));
  const aliceMail = byTo['alice@assetstackai.com'] || claim.mails.find((m) => m.events.some((e) => e.item === 'Council landing page'));
  const helloMail = claim.mails.find((m) => m.events.some((e) => e.item === 'Tender pack'));
  const kinds = (m) => (m?.events || []).map((e) => `${e.kind}:${e.item}`).join();
  check('109. a claim groups by person (Alice: assigned and an update; Hello: Tender pack), with board, values, author and update text; David’s, no longer his, is dropped; a second claim gets nothing',
    claim.sender === boss && claim.mails.length === 2
      && kinds(aliceMail) === 'assigned:Council landing page,update:Council landing page'
      && kinds(helloMail) === 'assigned:Tender pack'
      && aliceMail.events[1].actor && aliceMail.events[1].text === 'Can you check the hero copy?' && aliceMail.events[0].module === 'projects'
      && aliceMail.events[0].board_id === board && aliceMail.events[0].values.priority === 'High' && aliceMail.events[0].values.due === '2026-10-30'
      && dropped.length === 1 && dropped[0] === david && again.mails.length === 0,
    { mails: claim.mails.map((m) => ({ to: m.to, kinds: kinds(m) })), dropped, again: again.mails.length });

  // 110. Done: sent rows are kept as sent; a failure frees them for a later claim (five tries at most) and shows in the status.
  await svc();
  await db.query("select task_mail_done($1, '')", [aliceMail.ids]);
  await db.query("select task_mail_done($1, 'Gmail said no')", [helloMail.ids]);
  await as(boss);
  const afterDone = (await one('select task_mail_status() as s')).s;
  await as(null);
  await db.query('update private.task_mail set claimed_at = null where id = any($1)', [helloMail.ids]);
  await svc();
  const retry = (await one('select task_mail_claim() as c')).c;
  await as(null);
  await db.query('update private.task_mail set attempts = 5, claimed_at = null where id = any($1)', [helloMail.ids]);
  await svc();
  const exhausted = (await one('select task_mail_claim() as c')).c;
  await as(null);
  const sent = (await one('select count(*)::int as n from private.task_mail where id = any($1) and sent_at is not null', [aliceMail.ids])).n;
  check('110. done marks rows sent (and the status’s last send); a failure is claimed again later, five tries at most, and shows as the last error',
    sent === aliceMail.ids.length && afterDone.error === 'Gmail said no' && Boolean(afterDone.sent_at) && afterDone.waiting === 1
      && retry.mails.length === 1 && retry.mails[0].ids.join() === helloMail.ids.join() && exhausted.mails.length === 0,
    { sent, afterDone, retry: retry.mails.length, exhausted: exhausted.mails.length });

  // 111. Checked as the person when sent: someone who can no longer see the board, or who isn't active, gets nothing;
  // a deleted update takes its email with it; the claim leaves the caller's identity as it was.
  await as(null);
  await db.query('delete from private.task_mail');
  await as(boss);
  const forHello = await task('Board pack', hello);
  const doomed = await task('Short lived', alice);
  await as(hello);
  const gone = (await one("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Delete me') returning id", [doomed, hello])).id;
  await db.query('delete from item_updates where id = $1', [gone]);
  await as(david);
  await db.query("insert into module_access (user_id, module, level) values ($1, 'projects', 'none') on conflict (user_id, module) do update set level = 'none'", [hello]);
  await svc();
  const blocked = (await one('select task_mail_claim() as c')).c;
  const who = (await one("select coalesce(current_setting('request.jwt.claim.sub', true), '') as sub")).sub;
  await as(null);
  const helloRow = await one('select sent_at, error from private.task_mail where item_id = $1', [forHello]);
  await as(david);
  await db.query("delete from module_access where user_id = $1 and module = 'projects'", [hello]);
  check('111. someone who can no longer see the board gets nothing (closed unsent); a deleted update’s email goes with it; the claim leaves the caller as it was',
    blocked.mails.length === 1 && blocked.mails[0].events.every((e) => e.item === 'Short lived' && e.kind === 'assigned')
      && Boolean(helloRow?.sent_at) && helloRow.error === 'not sent: no longer theirs' && who === '',
    { mails: blocked.mails.map((m) => kinds(m)), helloRow, who });

  // 112. Stop: admins only; then nothing is claimed.
  await as(alice);
  const staffOff = await error('select task_mail_off()');
  await as(boss);
  const off = await one('select task_mail_off() as ok');
  await svc();
  const afterOff = (await one('select task_mail_claim() as c')).c;
  await as(null);
  await db.query('delete from private.task_mail');
  check('112. only admins stop task emails; stopped, nothing is claimed',
    staffOff !== null && off.ok === true && afterOff.sender === null && afterOff.mails.length === 0, { staffOff, afterOff });
  for (const a of access) {
    await db.query("insert into module_access (user_id, module, level) values ($1, 'projects', $2) on conflict (user_id, module) do update set level = excluded.level", [a.user_id, a.level]);
  }
  return ctx;
}

async function runSplit(dbx, sql, { continueOnError = false, skip = () => false } = {}) {
  const errors = [];
  for (const st of splitSql(sql)) {
    if (skip(st)) continue;
    try {
      await dbx.exec(st);
    } catch (e) {
      errors.push(e.message);
      if (!continueOnError) break;
    }
  }
  return errors;
}

// 42. Running 0006 as the SQL editor did: statement by statement, carrying on after errors -------------------------
// On a fresh database with 0001-0005 and boards from before 0006: (a) a statement-by-statement first run ends in the
// intended state; (b) the live failure (the seeding statements failing, everything else applied, nothing marked
// complete) leaves rows unlinked and hidden, and running the current 0006 again repairs it; a further run changes nothing.
async function editorRunCheck() {
  const fresh = async () => {
    const dbx = new PGlite({ extensions: { pgcrypto } });
    await dbx.exec(SUPABASE_STUB);
    for (const m of [migration, migration2, migration3, migration4, migration5]) await dbx.exec(m);
    await dbx.exec("insert into public.admin_emails (email, role) values ('owner@assetstackai.com', 'superadmin') on conflict do nothing");
    const user = async (email, name) => {
      const id = randomUUID();
      await dbx.query('insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)', [id, email, { full_name: name }]);
      return id;
    };
    const owner = await user('owner@assetstackai.com', 'Owner Example');
    const staff = await user('staff@assetstackai.com', 'Staff Example');
    const one2 = async (q, p) => (await dbx.query(q, p)).rows[0];
    const legacy = {};
    for (const [module, name] of [['projects', 'Active'], ['projects', 'Admin'], ['marketing', 'October']]) {
      const g = (await one2('insert into board_groups (board_key, name, color, position) values ($1, $2, $3, 0) returning id', [module, name, '#c9ffe6'])).id;
      const it = (await one2(`insert into items (board_key, group_id, name, "values") values ($1, $2, $3, '{"people": []}') returning id`, [module, g, `${name} task`])).id;
      await dbx.query("insert into subtasks (item_id, text) values ($1, 'Step')", [it]);
      await dbx.query("insert into item_updates (item_id, user_id, text) values ($1, $2, 'Note')", [it, staff]);
      legacy[`${module}:${name}`] = { group: g, item: it };
    }
    return { dbx, owner, staff, legacy };
  };
  const state = async ({ dbx, staff, legacy }) => {
    const r = (await dbx.query(`select
      (select string_agg(module || ':' || name || ':' || position, ',' order by module, position) from boards where owner_id is null) as team,
      (select count(*)::int from boards where owner_id is not null) as pages,
      (select count(*)::int from profiles) as profiles,
      (select count(*)::int from board_groups where board_id is null) as groups_unlinked,
      (select count(*)::int from items where board_id is null) as tasks_unlinked,
      (select count(*)::int from boards b where not exists (select 1 from board_groups g where g.board_id = b.id)) as boards_without_group,
      (select string_agg(table_name || ':' || is_nullable, ',' order by table_name) from information_schema.columns
        where table_schema = 'public' and column_name = 'board_id') as nullable,
      obj_description('public.boards'::regclass, 'pg_class') as marker,
      (select string_agg(distinct tgname, ',' order by tgname) from pg_trigger where tgname in ('place_on_board', 'same_audience',
        'keep_board_links', 'add_personal_board')) as triggers,
      (select count(*)::int from board_groups) as groups, (select count(*)::int from items) as items,
      (select count(*)::int from subtasks) as subtasks, (select count(*)::int from item_updates) as updates`)).rows[0];
    const placed = (await dbx.query(`select g.id, b.name from board_groups g join boards b on b.id = g.board_id
      where g.id = any($1::uuid[])`, [Object.values(legacy).map((x) => x.group)])).rows;
    r.legacy_on = [...new Set(placed.map((x) => x.name))].sort().join(',');
    await dbx.exec('set role authenticated');
    await dbx.query("select set_config('request.jwt.claim.sub', $1, false)", [staff]);
    r.staff_sees_tasks = (await dbx.query('select count(*)::int as n from items where id = any($1::uuid[])',
      [Object.values(legacy).map((x) => x.item)])).rows[0].n;
    await dbx.exec('reset role');
    await dbx.query("select set_config('request.jwt.claim.sub', '', false)");
    return r;
  };
  const intended = (r) => r.team === 'marketing:Daily Automation:0,marketing:Posting schedule:1,marketing:Campaigns:2,marketing:Events:3,'
      + 'projects:Landing Page:0,projects:Tender Portal:1,projects:General:2'
    && r.pages === r.profiles && r.groups_unlinked === 0 && r.tasks_unlinked === 0 && r.boards_without_group === 0
    && r.nullable === 'board_groups:NO,items:NO' && r.marker === 'Cortex 0006 complete'
    && r.triggers === 'add_personal_board,keep_board_links,place_on_board,same_audience'
    && r.legacy_on === 'General,Posting schedule' && r.staff_sees_tasks === 3 && r.items === 3 && r.subtasks === 3 && r.updates === 3;

  // (a) A first run, statement by statement.
  const a = await fresh();
  const aErrors = await runSplit(a.dbx, migration6);
  const aState = await state(a);
  check('42. 0006 run statement by statement (as the SQL editor may) ends in the intended state',
    aErrors.length === 0 && intended(aState), { aErrors, aState });
  await a.dbx.close();

  // (b) The live failure, then the repair.
  const b = await fresh();
  const seed = (st) => /^\s*-- seed/m.test(st);
  const bErrors = await runSplit(b.dbx, migration6, { continueOnError: true, skip: seed });
  const broken = await state(b);
  check('42. a run whose seeding statements failed (the live 0006 run) leaves tasks unlinked and hidden, and is not marked complete',
    broken.team === null && broken.groups_unlinked === broken.groups && broken.tasks_unlinked === 3 && broken.staff_sees_tasks === 0
      && broken.marker === null && broken.items === 3 && broken.nullable === 'board_groups:YES,items:YES', { bErrors, broken });
  const repair = await b.dbx.exec(migration6).then(() => null, (e) => e.message);
  const repaired = await state(b);
  check('42. running the current 0006 again repairs it: starting boards once, old groups on General / Posting schedule, '
    + 'nothing unlinked, every board with a group, staff see their tasks again, marked complete',
    repair === null && intended(repaired), { repair, repaired });
  const again = await runSplit(b.dbx, migration6, { continueOnError: true });
  const afterAgain = await state(b);
  check('42. one more run (statement by statement) changes nothing',
    again.length === 0 && stable(afterAgain) === stable(repaired), { again, afterAgain });
  await b.dbx.close();
}

// An unexpected exception (e.g. a policy now raising where a check expected 0 rows) is a failure too.
try {
  const ctx = await main();
  const ctx2 = ctx && await phase2(ctx);
  const ctx3 = ctx2 && await phase3(ctx2);
  const ctx4 = ctx3 && await phase4(ctx3);
  const ctx5 = ctx4 && await phase5(ctx4);
  const ctx6 = ctx5 && await phase6(ctx5);
  const ctx7 = ctx6 && await phase7(ctx6);
  const ctx8 = ctx7 && await phase8(ctx7);
  const ctx9 = ctx8 && await phase9(ctx8);
  const ctx10 = ctx9 && await phase10(ctx9);
  const ctx11 = ctx10 && await phase11(ctx10);
  const ctx12 = ctx11 && await phase12(ctx11);
  const ctx13 = ctx12 && await phase13(ctx12);
  if (ctx13) await syncWriteCheck(ctx13);
  if (ctx6) await editorRunCheck();
} catch (e) {
  check('the run finished without an unexpected error', false, e.message);
}
await db.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
