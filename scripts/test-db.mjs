// Runs supabase/migrations/0001_cortex.sql in PGlite (Postgres compiled to WASM, no network) on top
// of a minimal Supabase stub and checks the sign-up gate, triggers and row-level security as
// different users; then applies 0002_team_workflow.sql on top of the rows those checks leave behind (as on
// the live database) and checks roles, module access, the board merge, automations, finance and storage.
// Usage: node scripts/test-db.mjs (exits non-zero on any failure).
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { TABLES, flatten, normalizeRow } from '../src/data/backend/schema.js';

const root = new URL('../', import.meta.url);
const migration = await readFile(new URL('supabase/migrations/0001_cortex.sql', root), 'utf8');
const migration2 = await readFile(new URL('supabase/migrations/0002_team_workflow.sql', root), 'utf8');
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

  // 22. The sync engine's writes: the superadmin (who may write every table) saves flatten() rows for every synced
  // table the way PostgREST sends them, and reading them back the way PostgREST returns them (json) gives the same
  // rows. Catches a column, type or FK order that schema.js and the migrations disagree on, and policies that refuse
  // a normal save.

  await as(david);
  const [grp, grp2, itm, cli, inv, pln, con, chn, rtn, stm] = Array.from({ length: 10 }, uid);
  const flat = flatten({
    me: david,
    users: [],
    org: {},
    moduleAccess: [{ userId: hello, module: 'outreach', level: 'view' }],
    boards: {
      projects: { groups: [{ id: grp, name: 'Sync check', color: '#d6e4ff', items: [{
        id: itm, name: 'Item', values: { people: [david, alice], status: 'Done', due: '2026-10-30' }, done: true,
        updates: [{ id: uid(), user: david, text: 'Update', ts: '2026-10-01T03:00:00.000Z' }], subtasks: [{ id: uid(), text: 'Sub', done: true }],
      }] }] },
      marketing: { groups: [{ id: grp2, name: 'Sync check', color: '#bfe9ff', items: [] }] },
    },
    clients: [{
      id: cli, name: 'Example Client', group: 'Active', status: 'Active', priority: 'P1', next: 'Call', sector: 'Utilities',
      contact: david, team: [david, alice], lastContact: '2026-10-01', demo: '', keyContact: 'Pat', email: 'pat@example.com',
      demoUrl: '', avatar: '#3b82f6', abn: '', billingAddress: '1 Example St',
      notes: [{ id: uid(), user: david, text: 'Note', ts: '2026-10-02T00:00:00.000Z' }], tasks: [{ id: uid(), text: 'Task', done: false }],
      invoices: [{
        id: inv, number: 'SYNC-1001', issued: '2026-10-08', due: '', status: 'Paid', planId: pln, sentAt: '2026-10-08T02:00:00.000Z',
        paidOn: '2026-10-10', lines: [{ id: uid(), desc: 'Line', qty: '1,000', rate: 0.125 }],
      }],
      access: [{ id: uid(), name: 'Pat', email: 'pat@example.com', role: 'Viewer' }],
      plans: [{ id: pln, description: 'Licence', amount: 1500.5, frequency: 'quarterly', nextDate: '2026-11-01', active: true }],
      usage: [{ id: uid(), month: '2026-09-01', assets: 1200, sites: 4, seats: 9, notes: 'Pilot' }],
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
  });
  const writeErrors = {};
  const mismatched = {};
  for (const t of TABLES.filter((x) => !x.update)) { // profiles / org_settings are plain updates (checked in 5. and 20.)
    const sent = [...flat[t.name].values()];
    if (!sent.length) { writeErrors[t.name] = 'fixture has no rows'; continue; }
    const err = await postgrestUpsert(t.name, sent, t);
    if (err) { writeErrors[t.name] = err; continue; }
    const back = (await one(`select coalesce(json_agg(x), '[]') as rows from public.${t.name} x`)).rows
      .map((r) => normalizeRow(t.name, r));
    const byKey = new Map(back.map((r) => [t.key(r), r]));
    const diffs = sent.filter((r) => stable(byKey.get(t.key(r))) !== stable(r));
    if (diffs.length) mismatched[t.name] = { sent: diffs[0], back: byKey.get(t.key(diffs[0])) ?? null };
  }
  check('sync: flatten() rows for every synced table save as PostgREST sends them and read back unchanged',
    !Object.keys(writeErrors).length && !Object.keys(mismatched).length, { writeErrors, mismatched });

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
}

// An unexpected exception (e.g. a policy now raising where a check expected 0 rows) is a failure too.
try {
  const ctx = await main();
  if (ctx) await phase2(ctx);
} catch (e) {
  check('the run finished without an unexpected error', false, e.message);
}
await db.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
