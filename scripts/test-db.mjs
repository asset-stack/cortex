// Runs supabase/migrations/0001_cortex.sql in PGlite (Postgres compiled to WASM, no network) on top
// of a minimal Supabase stub and checks the sign-up gate, triggers and row-level security as
// different users; then applies 0002_team_workflow.sql on top of the rows those checks leave behind (as on
// the live database) and checks roles, module access, the board merge, automations, finance and storage; then
// 0003_timezones_projects_view.sql (Sydney business day, per-person time zones, Projects view-only for staff); then
// 0004_clients_google.sql (client contacts and contracts, credits, approve / contract to-dos, Google accounts); then
// 0005_work_tools.sql (each person's Tools in My Work); then 0006_boards.sql (sub-boards under Projects and Marketing,
// each person's own Projects page, and who sees and edits which board); then 0007_outreach.sql (outreach mailboxes,
// the agent's emails read from its sheet, notes and the sheet's link: who reads and writes what, the guards, and the
// dashboard RPCs, which must give the same numbers as src/lib/outreach.js). Last, the sync engine's writes of every
// synced table (flatten() rows as PostgREST upserts), personal pages and Outreach included.
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
      && stable(totals) === stable({ sent: 23, replies: 10, bounces: 4, meetings: 3, replyRate: 10 / 23, bounceRate: 4 / 23 })
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
  const [grp, grp2, itm, cli, inv, pln, con, chn, rtn, stm, teamP, teamM, mbx, mbx2] = Array.from({ length: 14 }, uid);
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
      { id: teamM, module: 'marketing', name: 'Sync check', owner: '', groups: [{ id: grp2, name: 'Sync check', color: '#bfe9ff', items: [] }] },
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
      id: uid(), name: 'Example Client', sector: 'Utilities', value: '1,500.50', priority: 'P1', stage: 'Won', contact: alice, next: '',
      clientId: cli, contactId: con,
    }],
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
  });
  // Columns the database sets itself whatever a signed-in request sends (protect_outreach_note: a note's date is when
  // it was saved): compared without them here, and checked to be the server's below.
  const SERVER_SET = { outreach_notes: ['created_at'] };
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
  if (ctx8) await syncWriteCheck(ctx8);
  if (ctx6) await editorRunCheck();
} catch (e) {
  check('the run finished without an unexpected error', false, e.message);
}
await db.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
