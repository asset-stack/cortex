// Runs supabase/migrations/0001_cortex.sql in PGlite (Postgres compiled to WASM, no network) on top
// of a minimal Supabase stub, then checks the sign-up gate, triggers and row-level security as
// different users. Usage: node scripts/test-db.mjs (exits non-zero on any failure).
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { TABLES, flatten, normalizeRow } from '../src/data/backend/schema.js';

const root = new URL('../', import.meta.url);
const migration = await readFile(new URL('supabase/migrations/0001_cortex.sql', root), 'utf8');
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

  const early = await signUp('you@assetstackai.com', 'Early Bird');
  const before = (await one('select role from profiles where id = $1', [early])).role;
  await as(null);
  await db.exec(setupAdmins);
  const after = (await one('select role from profiles where id = $1', [early])).role;
  check('3. setup-admins.sql promotes someone who signed in earlier', before === 'member' && after === 'admin', { before, after });

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

  // The sync engine's writes: a member saves flatten() rows for every synced table the way PostgREST sends them,
  // and reading them back the way PostgREST returns them (json) gives the same rows. Catches a column or type
  // that schema.js and the migration disagree on, and policies that refuse a normal save.
  await as(alice);
  const uid = () => randomUUID();
  const [grp, itm, cli, inv, con, chn] = [uid(), uid(), uid(), uid(), uid(), uid()];
  const flat = flatten({
    me: alice,
    users: [],
    org: {},
    boards: { projects: { groups: [{ id: grp, name: 'Sync check', color: '#d6e4ff', items: [{
      id: itm, name: 'Item', values: { owner: alice, status: 'Done', due: '2026-10-30' }, done: true,
      updates: [{ id: uid(), user: alice, text: 'Update', ts: '2026-10-01T03:00:00.000Z' }], subtasks: [{ id: uid(), text: 'Sub', done: true }],
    }] }] } },
    clients: [{
      id: cli, name: 'Example Client', group: 'Active', status: 'Active', priority: 'P1', next: 'Call', sector: 'Utilities',
      contact: alice, team: [alice, boss], lastContact: '2026-10-01', demo: '', keyContact: 'Pat', email: 'pat@example.com',
      demoUrl: '', avatar: '#3b82f6', abn: '', billingAddress: '1 Example St',
      notes: [{ id: uid(), user: alice, text: 'Note', ts: '2026-10-02T00:00:00.000Z' }], tasks: [{ id: uid(), text: 'Task', done: false }],
      invoices: [{ id: inv, number: 'SYNC-1001', issued: '2026-10-08', due: '', status: 'Draft', lines: [{ id: uid(), desc: 'Line', qty: '1,000', rate: 0.125 }] }],
      access: [{ id: uid(), name: 'Pat', email: 'pat@example.com', role: 'Viewer' }],
    }],
    deals: [{ id: uid(), name: 'Example Client', sector: 'Utilities', value: '1,500.50', priority: 'P1', stage: 'Won', contact: alice, next: '', clientId: cli }],
    contacts: [{ id: con, name: 'Pat', org: 'Example Org', email: 'pat@example.com', stage: 'Won', status: 'Replied', last: '' }],
    emails: [{ id: uid(), kind: 'sent', contactId: con, contact: 'Pat', subject: 'Hello', snippet: 'Hi', ts: '2026-10-04T00:00:00.000Z' }],
    sequences: [{ id: uid(), name: 'Intro', steps: 3, enrolled: 2, replyRate: 0.25 }],
    approvals: [{ id: uid(), contactId: con, contact: 'Pat', subject: 'Draft', body: 'Body', by: alice, ts: '2026-10-05T00:00:00.000Z' }],
    channels: [{ id: chn, name: 'sync-check', members: [alice, boss] }],
    messages: [{ id: uid(), channel: chn, user: alice, text: 'hello', ts: '2026-10-06T00:00:00.000Z' }],
    lastRead: { [alice]: { [chn]: '2026-10-06T00:00:00.000Z' } },
  });
  const writeErrors = {};
  const mismatched = {};
  for (const t of TABLES.filter((x) => !x.update)) { // profiles / org_settings are plain updates (checked in 5.)
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
  check('sync: a member saves flatten() rows for every table as PostgREST sends them, and they read back unchanged',
    !Object.keys(writeErrors).length && !Object.keys(mismatched).length, { writeErrors, mismatched });

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
}

// An unexpected exception (e.g. a policy now raising where a check expected 0 rows) is a failure too.
try {
  await main();
} catch (e) {
  check('the run finished without an unexpected error', false, e.message);
}
await db.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
