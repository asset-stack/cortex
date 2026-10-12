// Checks the live-mode mapping and sync engine without a network: node scripts/test-sync.mjs
// (a) flatten/assemble round trip, (b) diff ops for common edits, (c) the sync queue against a fake Supabase.
// Exits non-zero when any check fails.
import assert from 'node:assert/strict';
import { TABLES, flatten, assemble, diff } from '../src/data/backend/schema.js';
import { createSync } from '../src/data/backend/sync.js';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}\n  ${String(e?.stack || e).split('\n').slice(0, 12).join('\n  ')}`);
  }
}

// Row maps → plain objects with sorted keys, so Map insertion order doesn't matter.
const plain = (rows) => Object.fromEntries(Object.entries(rows).map(([table, m]) => [
  table, Object.fromEntries([...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
]));
// What the store does: state → rows → state (with `me` put back) → rows.
const roundTrip = (s) => flatten({ ...assemble(flatten(s), { me: s.me }), version: 1, mode: 'live', me: s.me });

// A hand-built state that fills every table. All names and emails are placeholders.
const U1 = 'u-ana';
const U2 = 'u-ben';
const fixture = () => ({
  version: 1,
  mode: 'live',
  me: U1,
  users: [
    { id: U1, name: 'Ana', initials: 'AN', color: '#579bfc', email: 'ana@example.com', role: 'admin', active: true },
    { id: U2, name: 'Ben', initials: 'BE', color: '#ff7575', email: 'ben@example.com', role: 'member', active: false },
  ],
  org: {
    businessName: 'Example Pty Ltd', abn: '00 000 000 000', address: '1 Example St', email: 'accounts@example.com',
    phone: '0000 000 000', bankAccountName: 'Example', bsb: '000-000', accountNumber: '00000000',
    paymentTermsDays: 14, invoicePrefix: 'EX-',
  },
  boards: {
    projects: {
      groups: [
        { id: 'g-1', name: 'Active', color: '#c9ffe6', items: [
          {
            id: 'it-1', name: 'First', values: { owner: U1, status: 'In progress', due: '2026-10-30' }, done: false,
            updates: [
              { id: 'up-2', user: U2, text: 'Newer', ts: '2026-10-02T03:00:00.000Z' },
              { id: 'up-1', user: U1, text: 'Older', ts: '2026-10-01T03:00:00.000Z' },
            ],
            subtasks: [{ id: 'st-1', text: 'One', done: true }, { id: 'st-2', text: 'Two', done: false }],
          },
          { id: 'it-2', name: 'Second', values: { status: 'Done', owner: '' }, done: true, updates: [], subtasks: [] },
        ] },
        { id: 'g-2', name: 'Backlog', color: '#e6eaf2', items: [] },
      ],
    },
    admin: { groups: [{ id: 'g-3', name: 'To do', color: '#ffe6b0', items: [
      { id: 'it-3', name: 'Admin task', values: { owner: U2, status: 'Stuck' }, done: false, updates: [], subtasks: [] },
    ] }] },
    marketing: { groups: [] },
  },
  deals: [
    { id: 'd-1', name: 'Deal one', sector: 'Government', value: 70000, priority: 'P2', stage: 'Opportunities', contact: U1, next: 'Call' },
    { id: 'd-2', name: 'Client one', sector: 'Utilities', value: '1,500', priority: 'P1', stage: 'Won', contact: '', next: '', clientId: 'c-1' },
  ],
  clients: [
    {
      id: 'c-1', name: 'Client one', group: 'Onboarding', status: 'Onboarding', priority: 'P1', next: 'Kick-off', sector: 'Utilities',
      contact: U1, team: [U1, U2], lastContact: '2026-10-01', demo: 'Live', keyContact: 'Pat Doe', email: 'pat@example.com',
      demoUrl: 'https://demo.example.com', avatar: '#3b82f6', abn: '11 111 111 111', billingAddress: '2 Example Rd',
      notes: [
        { id: 'n-2', user: U2, text: 'Newer note', ts: '2026-10-05T00:00:00.000Z' },
        { id: 'n-1', user: U1, text: 'Older note', ts: '2026-10-04T00:00:00.000Z' },
      ],
      tasks: [{ id: 't-1', text: 'Book meeting', done: false }],
      invoices: [
        { id: 'i-2', number: 'EX-1002', issued: '2026-10-08', due: '', status: 'Draft', lines: [
          { id: 'l-3', desc: 'Licence', qty: 1, rate: 18450 },
        ] },
        { id: 'i-1', number: 'EX-1001', issued: '2026-09-01', due: '2026-10-01', status: 'Paid', lines: [
          { id: 'l-1', desc: 'Capture', qty: '2', rate: '1,000' },
          { id: 'l-2', desc: 'Travel', qty: 1, rate: 250.5 },
        ] },
      ],
      access: [{ id: 'a-1', name: 'Pat Doe', email: 'pat@example.com', role: 'Client admin' }],
    },
    {
      id: 'c-0', name: 'Client two', group: 'Active', status: 'Passive', priority: 'P2', next: '', sector: '', contact: '', team: [],
      lastContact: '', demo: '', keyContact: '', email: '', demoUrl: '', avatar: '#f59e0b', abn: '', billingAddress: '',
      notes: [], tasks: [], invoices: [], access: [],
    },
  ],
  contacts: [
    { id: 'p-1', name: 'Pat Doe', org: 'Client one', email: 'pat@example.com', stage: 'Won', status: 'Replied', last: '2026-10-03T01:00:00.000Z' },
    { id: 'p-2', name: 'Sam Roe', org: '', email: 'sam@example.com', stage: 'Opportunity', status: 'New', last: '' },
  ],
  emails: [
    { id: 'e-2', kind: 'sent', contactId: 'p-1', contact: 'Pat Doe', subject: 'Hello', snippet: 'Hi Pat', ts: '2026-10-06T00:00:00.000Z' },
    { id: 'e-1', kind: 'reply', contact: 'Sam Roe', subject: 'Re: Hello', snippet: 'Thanks', ts: '2026-10-05T00:00:00.000Z' },
  ],
  sequences: [{ id: 'q-1', name: 'Intro', steps: 4, enrolled: 18, replyRate: 0.22 }],
  approvals: [{ id: 'ap-1', contactId: 'p-2', contact: 'Sam Roe', subject: 'Follow up', body: 'Body', by: U2, ts: '2026-10-07T00:00:00.000Z' }],
  channels: [
    { id: 'ch-1', name: 'general', members: [U1, U2] },
    { id: 'ch-2', name: 'sales', members: [U1] },
  ],
  messages: [
    { id: 'm-1', channel: 'ch-1', user: U2, text: 'Morning', ts: '2026-10-08T00:00:00.000Z' },
    { id: 'm-2', channel: 'ch-2', user: U1, text: '@ben ping', ts: '2026-10-09T00:00:00.000Z' },
  ],
  lastRead: {
    [U1]: { 'ch-1': '2026-10-08T01:00:00.000Z', 'ch-2': '2026-10-09T01:00:00.000Z' },
    [U2]: { 'ch-1': '2026-10-08T02:00:00.000Z' }, // another viewer: not stored
  },
});

// ── (a) Round trip ─────────────────────────────────────────────────────────────

let createSeed = null;
try {
  ({ createSeed } = await import('../src/data/seed.js'));
} catch (e) {
  console.log(`SKIP createSeed round trip: seed.js is not importable in Node (${String(e?.message).split('\n')[0]})`);
}

if (createSeed) {
  await check('round trip: createSeed()', () => {
    const s = createSeed();
    assert.deepEqual(plain(roundTrip(s)), plain(flatten(s)));
  });
}

await check('round trip: fixture covering every table', () => {
  const s = fixture();
  const rows = flatten(s);
  TABLES.forEach(({ name }) => assert.ok(rows[name]?.size > 0, `fixture has no ${name} rows`));
  assert.deepEqual(plain(roundTrip(s)), plain(rows));
});

await check('flatten: DB column shapes', () => {
  const rows = flatten(fixture());
  assert.deepEqual(rows.org_settings.get('1'), {
    id: 1, business_name: 'Example Pty Ltd', abn: '00 000 000 000', address: '1 Example St', email: 'accounts@example.com',
    phone: '0000 000 000', bank_account_name: 'Example', bsb: '000-000', account_number: '00000000', invoice_prefix: 'EX-',
    payment_terms_days: 14,
  });
  assert.deepEqual(rows.deals.get('d-2'), {
    id: 'd-2', name: 'Client one', sector: 'Utilities', priority: 'P1', stage: 'Won', next_step: '', value: 1500,
    owner_id: null, client_id: 'c-1', position: 1,
  });
  assert.equal(rows.clients.get('c-0').last_contact, null);
  // position is the array index ('c-0' sits second, so id order can't stand in for it), counted from the end for
  // the lists that grow at the top (clients, contacts, a client's invoices).
  [['board_groups', 'g-2', 1], ['items', 'it-2', 1], ['subtasks', 'st-2', 1], ['clients', 'c-0', 0], ['clients', 'c-1', 1],
    ['deals', 'd-2', 1], ['invoices', 'i-1', 0], ['invoices', 'i-2', 1], ['invoice_lines', 'l-2', 1], ['contacts', 'p-2', 0],
    ['contacts', 'p-1', 1], ['sequences', 'q-1', 0]]
    .forEach(([table, key, pos]) => assert.equal(rows[table].get(key).position, pos, `${table} ${key}`));
  assert.equal(rows.invoices.get('i-2').due, null);
  assert.deepEqual(rows.invoice_lines.get('l-1'), { id: 'l-1', invoice_id: 'i-1', position: 0, description: 'Capture', qty: '2', rate: '1,000' });
  assert.equal(rows.contacts.get('p-2').last_at, null);
  assert.equal(rows.emails.get('e-1').contact_id, null);
  assert.deepEqual([...rows.read_state.keys()].sort(), [`${U1}:ch-1`, `${U1}:ch-2`]);
  assert.deepEqual([...rows.channel_members.keys()].sort(), [`ch-1:${U1}`, `ch-1:${U2}`, `ch-2:${U1}`]);
  Object.values(rows).forEach((m) => m.forEach((r) => {
    assert.ok(!('updated_at' in r) && !('updated_by' in r), 'never emits updated_at/updated_by');
  }));
});

await check('assemble: order and state fields', () => {
  const s = fixture();
  const back = assemble(flatten(s), { me: U1 });
  assert.deepEqual(Object.keys(back).sort(), ['approvals', 'boards', 'channels', 'clients', 'contacts', 'deals', 'emails', 'lastRead',
    'messages', 'org', 'sequences', 'users'].sort());
  assert.deepEqual(back.boards.projects.groups.map((g) => g.id), ['g-1', 'g-2']);
  assert.deepEqual(back.boards.projects.groups[0].items.map((i) => i.id), ['it-1', 'it-2']);
  assert.deepEqual(back.boards.projects.groups[0].items[0].updates.map((u) => u.id), ['up-2', 'up-1']); // newest first
  assert.deepEqual(back.boards.marketing, { groups: [] });
  assert.deepEqual(back.clients[0].invoices.map((i) => i.id), ['i-2', 'i-1']);
  assert.deepEqual(back.clients[0].invoices[1].lines[0], { id: 'l-1', desc: 'Capture', qty: '2', rate: '1,000' });
  assert.deepEqual(back.clients[0].notes.map((n) => n.id), ['n-2', 'n-1']);
  assert.equal(back.clients[1].lastContact, '');
  assert.equal(back.deals[1].clientId, 'c-1');
  assert.ok(!('clientId' in back.deals[0]));
  assert.equal(back.deals[1].value, 1500);
  assert.equal(back.emails[0].contactId, 'p-1');
  assert.ok(!('contactId' in back.emails[1]));
  assert.deepEqual(back.messages.map((m) => m.id), ['m-1', 'm-2']); // oldest first
  assert.deepEqual(back.channels, s.channels);
  assert.deepEqual(back.org, s.org);
  assert.deepEqual(back.lastRead, { [U1]: s.lastRead[U1] });
  assert.deepEqual(back.users, s.users);
  // Parts of the fixture already in canonical form come back exactly (no extra or missing fields).
  ['boards', 'contacts', 'emails', 'sequences', 'approvals', 'messages'].forEach((k) => assert.deepEqual(back[k], s[k], k));
  assert.deepEqual(back.clients[1], s.clients[1]);
  assert.deepEqual(back.deals[0], s.deals[0]);
});

await check('assemble: empty rows give a usable state', () => {
  const back = assemble({}, { me: U1 });
  assert.deepEqual(back.boards, { projects: { groups: [] }, admin: { groups: [] }, marketing: { groups: [] } });
  assert.equal(back.org.paymentTermsDays, 30);
  assert.equal(back.org.invoicePrefix, 'INV-');
  assert.deepEqual(back.lastRead, { [U1]: {} });
  assert.deepEqual(back.clients, []);
});

// ── (b) diff ──────────────────────────────────────────────────────────────────

const base = fixture();
const rows0 = flatten(base);
const opsAfter = (edit) => {
  const s = structuredClone(base);
  edit(s);
  return diff(rows0, flatten(s));
};
const labels = (ops) => ops.map((o) => `${o.op} ${o.table} ${o.key}`).sort();
const item1 = (s) => s.boards.projects.groups[0].items[0];

await check('diff: no change → no ops', () => {
  assert.deepEqual(diff(rows0, flatten(structuredClone(base))), []);
});

await check('diff: jsonb key order is not a change', () => {
  const s = structuredClone(base);
  const v = item1(s).values;
  item1(s).values = Object.fromEntries(Object.entries(v).reverse());
  assert.deepEqual(diff(rows0, flatten(s)), []);
});

await check('diff: edit an item value', () => {
  const ops = opsAfter((s) => { item1(s).values.status = 'Done'; });
  assert.deepEqual(labels(ops), ['upsert items it-1']);
  assert.equal(ops[0].row.values.status, 'Done');
});

await check('diff: add a subtask', () => {
  const ops = opsAfter((s) => { item1(s).subtasks.push({ id: 'st-new', text: 'Three', done: false }); });
  assert.deepEqual(labels(ops), ['upsert subtasks st-new']);
  assert.deepEqual(ops[0].row, { id: 'st-new', item_id: 'it-1', position: 2, text: 'Three', done: false });
});

await check('diff: delete an item and its children rows', () => {
  const ops = opsAfter((s) => { s.boards.projects.groups[0].items.shift(); });
  assert.deepEqual(labels(ops), [
    'delete item_updates up-1', 'delete item_updates up-2', 'delete items it-1', 'delete subtasks st-1', 'delete subtasks st-2',
    'upsert items it-2', // moved up: position 1 → 0
  ]);
  assert.equal(ops.find((o) => o.key === 'it-2').row.position, 0);
  assert.equal(ops.find((o) => o.key === 'it-1').row.group_id, 'g-1'); // deletes carry the old row
});

await check('diff: add a channel with members', () => {
  const ops = opsAfter((s) => {
    s.channels.push({ id: 'ch-new', name: 'design', members: [U1, U2] });
    s.lastRead[U1]['ch-new'] = '2026-10-10T00:00:00.000Z';
  });
  assert.deepEqual(labels(ops), [
    `upsert channel_members ch-new:${U1}`, `upsert channel_members ch-new:${U2}`, 'upsert channels ch-new', `upsert read_state ${U1}:ch-new`,
  ]);
  assert.deepEqual(ops.find((o) => o.table === 'channels').row, { id: 'ch-new', name: 'design' });
});

await check('diff: move a deal', () => {
  const ops = opsAfter((s) => { s.deals[0].stage = 'Won'; });
  assert.deepEqual(labels(ops), ['upsert deals d-1']);
  assert.equal(ops[0].row.stage, 'Won');
});

await check('diff: edit org', () => {
  const ops = opsAfter((s) => { s.org.bsb = '111-111'; });
  assert.deepEqual(labels(ops), ['upsert org_settings 1']);
  assert.equal(ops[0].row.bsb, '111-111');
});

await check('diff: adding a client, contact or invoice at the top only writes the new row', () => {
  const ops = opsAfter((s) => {
    s.clients.unshift({ ...structuredClone(s.clients[1]), id: 'c-new', name: 'New client' });
    s.contacts.unshift({ id: 'p-new', name: 'New contact', org: '', email: '', stage: 'Opportunity', status: 'New', last: '' });
    s.clients[1].invoices.unshift({ id: 'i-new', number: 'EX-1003', issued: '2026-10-12', due: '', status: 'Draft', lines: [] });
  });
  assert.deepEqual(labels(ops), ['upsert clients c-new', 'upsert contacts p-new', 'upsert invoices i-new']);
  assert.equal(ops.find((o) => o.key === 'c-new').row.position, 2);
  assert.equal(ops.find((o) => o.key === 'i-new').row.position, 2);
});

await check('diff: add an invoice line', () => {
  const ops = opsAfter((s) => { s.clients[0].invoices[0].lines.push({ id: 'l-new', desc: '', qty: 1, rate: 0 }); });
  assert.deepEqual(labels(ops), ['upsert invoice_lines l-new']);
  assert.deepEqual(ops[0].row, { id: 'l-new', invoice_id: 'i-2', position: 1, description: '', qty: '1', rate: '0' });
});

await check('diff: rows state never had (orphans) are not deleted', () => {
  const prev = flatten(base);
  prev.items.set('it-orphan', { ...prev.items.get('it-1'), id: 'it-orphan', group_id: 'g-missing' });
  prev.item_updates.set('up-orphan', { ...prev.item_updates.get('up-1'), id: 'up-orphan', item_id: 'it-orphan' });
  prev.read_state.set(`${U1}:ch-hidden`, { user_id: U1, channel_id: 'ch-hidden', last_read_at: null });
  assert.deepEqual(diff(prev, flatten(base)), []);
});

// ── (c) Sync queue against a fake Supabase ────────────────────────────────────

// Fake clock: replaces setTimeout/clearTimeout; tick(ms) fires due timers in order and lets promises settle.
const clock = { now: 0, seq: 0, timers: new Map() };
const realTimers = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
globalThis.setTimeout = (fn, ms = 0) => { const id = ++clock.seq; clock.timers.set(id, { at: clock.now + ms, fn }); return id; };
globalThis.clearTimeout = (id) => { clock.timers.delete(id); };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
async function tick(ms) {
  const end = clock.now + ms;
  for (;;) {
    let due = null;
    clock.timers.forEach((t, id) => { if (t.at <= end && (!due || t.at < due.t.at)) due = { id, t }; });
    if (!due) break;
    clock.timers.delete(due.id);
    clock.now = due.t.at;
    due.t.fn();
    await settle();
  }
  clock.now = end;
  await settle();
}

// Records every request when it is awaited. `failures` entries fail the next matching request once (every
// matching request when `sticky`); `match(call)` narrows one to particular rows.
function fakeSupabase(db = {}) {
  let gate = null;
  const sb = {
    calls: [],
    failures: [],
    channels: [],
    removed: [],
    hold() {
      let open;
      gate = new Promise((r) => { open = r; });
      return () => { gate = null; open(); };
    },
    from(table) {
      const call = { table, method: '', filters: [] };
      const q = {
        upsert(rows, options) { Object.assign(call, { method: 'upsert', rows, options }); return q; },
        update(patch) { Object.assign(call, { method: 'update', patch }); return q; },
        delete() { call.method = 'delete'; return q; },
        select(columns, options) { Object.assign(call, { method: 'select', columns, options }); return q; },
        eq(col, v) { call.filters.push(['eq', col, v]); return q; },
        in(col, v) { call.filters.push(['in', col, v]); return q; },
        order(col) { (call.order ||= []).push(col); return q; },
        range(from, to) { call.range = [from, to]; return q; },
        then(resolve, reject) {
          sb.calls.push(call);
          const i = sb.failures.findIndex((f) => f.table === table && f.method === call.method && (!f.match || f.match(call)));
          let result;
          if (i >= 0) {
            const f = sb.failures[i];
            if (!f.sticky) sb.failures.splice(i, 1);
            result = { data: null, error: { message: f.message, code: f.code ?? '' }, status: f.status ?? 400 };
          } else if (call.method === 'select') {
            const all = db[table] || [];
            result = { data: all.slice(call.range[0], call.range[1] + 1), error: null, count: all.length, status: 200 };
          } else {
            result = { data: null, error: null, status: 201 };
          }
          return Promise.resolve(gate).then(() => result).then(resolve, reject);
        },
      };
      return q;
    },
    channel(name, opts) {
      const ch = {
        name,
        opts,
        handlers: [],
        on(type, filter, cb) { ch.handlers.push({ type, filter, cb }); return ch; },
        subscribe(cb) { ch.status = cb; cb('SUBSCRIBED'); return ch; },
      };
      sb.channels.push(ch);
      return ch;
    },
    removeChannel(ch) { sb.removed.push(ch); return Promise.resolve('ok'); },
  };
  return sb;
}

const up = (table, key, row = { id: key }) => ({ table, op: 'upsert', key, row });
const del = (table, key, row = { id: key }) => ({ table, op: 'delete', key, row });
const seq = (sb) => sb.calls.map((c) => `${c.method} ${c.table}`);
function setup(db, options) {
  const sb = fakeSupabase(db);
  const statuses = [];
  const sync = createSync({ supabase: sb, onStatus: (s) => statuses.push(s), ...options });
  return { sb, sync, statuses, states: () => statuses.map((s) => s.state) };
}

await check('sync: debounce 400 ms after the last change, coalesced per row', async () => {
  const { sb, sync, states } = setup();
  sync.queue([up('items', 'a', { id: 'a', name: 'v1' })]);
  assert.equal(sync.isPending('items', 'a'), true);
  await tick(300);
  sync.queue([up('items', 'a', { id: 'a', name: 'v2' }), up('items', 'b')]);
  await tick(399);
  assert.equal(sb.calls.length, 0, 'nothing sent before 400 ms of quiet');
  assert.equal(sync.isPending('items', 'a'), true);
  await tick(1);
  assert.deepEqual(seq(sb), ['upsert items']);
  assert.deepEqual(sb.calls[0].rows, [{ id: 'a', name: 'v2' }, { id: 'b' }]);
  assert.equal(sync.isPending('items', 'a'), false);
  assert.equal(sync.isPending('items', 'b'), false);
  assert.deepEqual(states(), ['saving', 'saved']);
  sync.dispose();
});

await check('sync: delete beats upsert for the same row', async () => {
  const { sb, sync } = setup();
  sync.queue([del('items', 'x')]);
  sync.queue([up('items', 'x', { id: 'x', name: 'stale' })]);
  sync.queue([up('items', 'y')]);
  sync.queue([del('items', 'y')]);
  await sync.flush();
  assert.deepEqual(seq(sb), ['delete items']);
  assert.deepEqual(sb.calls[0].filters, [['in', 'id', ['x', 'y']]]);
  sync.dispose();
});

await check('sync: upserts parents first, deletes children first, deletes after upserts', async () => {
  const { sb, sync } = setup();
  sync.queue([
    up('invoice_lines', 'l1'), up('invoices', 'i1'), up('clients', 'c1'),
    del('clients', 'c2'), del('invoices', 'i2'), del('invoice_lines', 'l2'),
    up('items', 'it1'), up('board_groups', 'g1'), del('board_groups', 'g2'), del('items', 'it2'), del('item_updates', 'u2'),
  ]);
  await sync.flush();
  assert.deepEqual(seq(sb), [
    'upsert board_groups', 'upsert items', 'upsert clients', 'upsert invoices', 'upsert invoice_lines',
    'delete invoice_lines', 'delete invoices', 'delete clients', 'delete item_updates', 'delete items', 'delete board_groups',
  ]);
  sync.dispose();
});

await check('sync: onConflict for channel_members / read_state, composite deletes, update-only tables', async () => {
  const { sb, sync } = setup();
  sync.queue([
    up('channels', 'c1', { id: 'c1', name: 'design' }),
    up('channel_members', 'c1:u1', { channel_id: 'c1', user_id: 'u1' }),
    up('read_state', 'u1:c1', { user_id: 'u1', channel_id: 'c1', last_read_at: '2026-10-10T00:00:00.000Z' }),
    del('channel_members', 'c2:u2', { channel_id: 'c2', user_id: 'u2' }),
    del('channel_members', 'c2:u3', { channel_id: 'c2', user_id: 'u3' }),
    del('read_state', 'u1:c3', { user_id: 'u1', channel_id: 'c3', last_read_at: null }),
    up('org_settings', '1', { id: 1, bsb: '111-111', payment_terms_days: 14 }),
    up('profiles', 'u1', { id: 'u1', name: 'Ana', active: true }),
    del('profiles', 'u9', { id: 'u9' }),
  ]);
  await sync.flush();
  const call = (method, table) => sb.calls.find((c) => c.method === method && c.table === table);
  assert.deepEqual(call('upsert', 'channel_members').options, { onConflict: 'channel_id,user_id', ignoreDuplicates: true });
  assert.deepEqual(call('upsert', 'read_state').options, { onConflict: 'user_id,channel_id', ignoreDuplicates: false });
  assert.equal(call('upsert', 'channels').options, undefined);
  assert.deepEqual(call('delete', 'channel_members').filters, [['eq', 'channel_id', 'c2'], ['in', 'user_id', ['u2', 'u3']]]);
  assert.deepEqual(call('delete', 'read_state').filters, [['eq', 'user_id', 'u1'], ['in', 'channel_id', ['c3']]]);
  assert.deepEqual(call('update', 'org_settings').patch, { bsb: '111-111', payment_terms_days: 14 });
  assert.deepEqual(call('update', 'org_settings').filters, [['eq', 'id', 1]]);
  assert.deepEqual(call('update', 'profiles').patch, { name: 'Ana', active: true });
  assert.ok(!sb.calls.some((c) => c.table === 'profiles' && c.method !== 'update'), 'profiles are only ever updated');
  assert.ok(!sb.calls.some((c) => c.table === 'org_settings' && c.method !== 'update'), 'org_settings is only ever updated');
  sync.dispose();
});

await check('sync: failed write stays queued, reports error, retries after 2 s', async () => {
  const { sb, sync, statuses } = setup();
  sb.failures.push({ table: 'items', method: 'upsert', message: 'boom', code: 'XX000' });
  sync.queue([up('items', 'a'), up('deals', 'd'), del('board_groups', 'g-old')]);
  await tick(400);
  assert.deepEqual(seq(sb), ['upsert items', 'upsert deals'], 'deletes wait while an upsert is failing');
  assert.deepEqual(statuses.at(-1), { state: 'error', message: 'boom' });
  assert.equal(sync.isPending('items', 'a'), true);
  assert.equal(sync.isPending('board_groups', 'g-old'), true);
  assert.equal(sync.isPending('deals', 'd'), false);
  await tick(1999);
  assert.equal(sb.calls.length, 2);
  await tick(1);
  assert.deepEqual(seq(sb).slice(2), ['upsert items', 'delete board_groups']);
  assert.equal(statuses.at(-1).state, 'saved');
  ['items|a', 'board_groups|g-old'].forEach((k) => assert.equal(sync.isPending(...k.split('|')), false, k));
  sync.dispose();
});

await check('sync: a change during backoff goes out after the usual 400 ms, and the failed row with it', async () => {
  const { sb, sync, statuses } = setup();
  sb.failures.push({ table: 'items', method: 'upsert', message: 'boom', code: 'XX000' });
  sync.queue([up('items', 'a')]);
  await tick(400);
  sync.queue([up('contacts', 'p1')]);
  await tick(399);
  assert.equal(sb.calls.length, 1);
  await tick(1);
  assert.deepEqual(seq(sb), ['upsert items', 'upsert items', 'upsert contacts']);
  assert.equal(statuses.at(-1).state, 'saved');
  await tick(30000);
  assert.equal(sb.calls.length, 3, 'no retry left over');
  sync.dispose();
});

await check('sync: offline, a change during backoff waits for the retry', async () => {
  const { sb, sync, statuses } = setup();
  sb.failures.push({ table: 'items', method: 'upsert', message: 'Failed to fetch', status: 0 });
  sync.queue([up('items', 'a')]);
  await tick(400);
  assert.equal(statuses.at(-1).state, 'offline');
  sync.queue([up('contacts', 'p1')]);
  await tick(1999);
  assert.equal(sb.calls.length, 1);
  await tick(1);
  assert.deepEqual(seq(sb), ['upsert items', 'upsert items', 'upsert contacts']);
  assert.equal(statuses.at(-1).state, 'saved');
  sync.dispose();
});

await check('sync: a row the database keeps refusing is given up after 3 tries and handed back', async () => {
  const rejected = [];
  const { sb, sync, statuses } = setup(undefined, { onRejected: (list) => rejected.push(list) });
  const has = (col, v) => (call) => call.rows.some((r) => r[col] === v);
  sb.failures.push({ table: 'channels', method: 'upsert', message: 'duplicate key value', code: '23505', match: has('id', 'c-bad'), sticky: true });
  sync.queue([up('channels', 'c-bad', { id: 'c-bad', name: 'design' }), del('items', 'it-old')]);
  await tick(400);
  assert.deepEqual(seq(sb), ['upsert channels', 'delete items'], 'a unique clash holds nothing back');
  assert.deepEqual(statuses.at(-1), { state: 'error', message: 'duplicate key value' });
  sync.queue([up('items', 'it-1')]); // not held back by the failing row
  await tick(400);
  assert.deepEqual(seq(sb).slice(2), ['upsert items', 'upsert channels']);
  assert.equal(rejected.length, 0);
  assert.equal(sync.isPending('channels', 'c-bad'), true);
  await tick(5000);
  assert.equal(sb.calls.filter((c) => c.table === 'channels').length, 3);
  assert.equal(rejected.length, 1);
  assert.deepEqual(rejected[0].map((r) => [r.table, r.op, r.key, r.error.code]), [['channels', 'upsert', 'c-bad', '23505']]);
  assert.equal(sync.isPending('channels', 'c-bad'), false);
  assert.equal(sync.hasPending(), false);
  assert.deepEqual(statuses.at(-1), { state: 'error', message: 'duplicate key value' }, 'reported until the next change');
  await tick(60000);
  assert.equal(sb.calls.filter((c) => c.table === 'channels').length, 3, 'no more retries');
  sync.queue([up('items', 'it-2')]);
  await tick(400);
  assert.equal(statuses.at(-1).state, 'saved');
  sync.dispose();
});

await check('sync: an edit to a failing row starts its tries again', async () => {
  const rejected = [];
  const { sb, sync } = setup(undefined, { onRejected: (list) => rejected.push(list) });
  sb.failures.push({ table: 'invoices', method: 'upsert', message: 'duplicate key value', code: '23505', sticky: true });
  sync.queue([up('invoices', 'i1', { id: 'i1', number: 'INV-1' })]);
  await tick(400);
  await tick(2000);
  sync.queue([up('invoices', 'i1', { id: 'i1', number: 'INV-2' })]);
  await tick(400);
  await tick(10000);
  assert.equal(sb.calls.length, 4);
  assert.equal(rejected.length, 0, 'two tries of the edited row, two of the old one');
  await tick(30000);
  assert.equal(sb.calls.length, 5);
  assert.deepEqual(rejected.flat().map((r) => r.row.number), ['INV-2']);
  sync.dispose();
});

await check('sync: a child whose parent was deleted elsewhere is dropped and holds no deletes back', async () => {
  const { sb, sync, statuses } = setup();
  sb.failures.push({ table: 'subtasks', method: 'upsert', message: 'foreign key violation', code: '23503', sticky: true });
  sync.queue([up('subtasks', 'st-1', { id: 'st-1', item_id: 'it-gone', position: 0, text: 'x', done: true })]);
  await tick(400);
  sync.queue([del('items', 'it-other')]);
  await tick(400);
  assert.deepEqual(seq(sb), ['upsert subtasks', 'delete items']);
  assert.equal(sync.hasPending(), false);
  assert.equal(statuses.at(-1).state, 'saved');
  await tick(60000);
  assert.equal(sb.calls.length, 2, 'never retried');
  sync.dispose();
});

await check('sync: dispose stops the retries of a write still in flight', async () => {
  const { sb, sync } = setup();
  sb.failures.push({ table: 'items', method: 'upsert', message: 'permission denied', code: '42501', sticky: true });
  const release = sb.hold();
  sync.queue([up('items', 'a')]);
  await tick(400);
  const done = sync.flush();
  sync.dispose();
  release();
  await done;
  const sent = sb.calls.length;
  await tick(120000);
  assert.equal(sb.calls.length, sent);
  sync.queue([up('items', 'b')]);
  await tick(1000);
  assert.equal(sb.calls.length, sent, 'a disposed engine queues nothing');
});

await check('sync: a late echo of a write we have since replaced is recognised', async () => {
  const { sync } = setup();
  const row = (desc) => ({ id: 'l1', invoice_id: 'i1', position: 0, description: desc, qty: '1', rate: '0' });
  sync.queue([up('invoice_lines', 'l1', row('Lic'))]);
  await tick(400);
  sync.queue([up('invoice_lines', 'l1', row('Licence'))]);
  await tick(400);
  assert.equal(sync.isPending('invoice_lines', 'l1'), false);
  assert.equal(sync.staleEcho('invoice_lines', 'l1', row('Someone else')), false, "another person's change");
  assert.equal(sync.staleEcho('invoice_lines', 'l1', row('Lic')), true, 'older echo: dropped');
  assert.equal(sync.staleEcho('invoice_lines', 'l1', row('Licence')), false, 'latest echo: applied');
  assert.equal(sync.staleEcho('invoice_lines', 'l1', row('Lic')), false, 'nothing of ours left to match');
  // Same value twice: each echo uses up one entry, in order.
  ['A', 'B', 'A'].forEach((v) => { sync.queue([up('invoice_lines', 'l1', row(v))]); });
  await sync.flush();
  sync.queue([up('invoice_lines', 'l1', row('B'))]);
  await sync.flush();
  sync.queue([up('invoice_lines', 'l1', row('A'))]);
  await sync.flush();
  assert.deepEqual(['A', 'B', 'A'].map((v) => sync.staleEcho('invoice_lines', 'l1', row(v))), [true, true, false]);
  // An update echo arriving after our own delete went through is stale; the delete's echo isn't.
  sync.queue([up('invoice_lines', 'l2', { ...row('x'), id: 'l2' })]);
  await sync.flush();
  sync.queue([del('invoice_lines', 'l2', { ...row('x'), id: 'l2' })]);
  await sync.flush();
  assert.equal(sync.staleEcho('invoice_lines', 'l2', { ...row('x'), id: 'l2' }), true);
  assert.equal(sync.staleEcho('invoice_lines', 'l2', null), false);
  sync.dispose();
});

await check('sync: a write that failed is not taken for ours when its row arrives', async () => {
  const { sb, sync } = setup();
  sb.failures.push({ table: 'items', method: 'upsert', message: 'boom', code: 'XX000' });
  sync.queue([up('items', 'a', { id: 'a', name: 'v1' })]);
  await tick(400);
  sync.queue([up('items', 'a', { id: 'a', name: 'v2' })]);
  await tick(400);
  assert.equal(sync.staleEcho('items', 'a', { id: 'a', name: 'v1' }), false);
  sync.dispose();
});

await check('sync: backoff grows 2 s → 5 s', async () => {
  const { sb, sync } = setup();
  sb.failures.push({ table: 'items', method: 'upsert', message: 'boom' }, { table: 'items', method: 'upsert', message: 'boom' });
  sync.queue([up('items', 'a')]);
  await tick(400);
  await tick(2000);
  assert.equal(sb.calls.length, 2);
  await tick(4999);
  assert.equal(sb.calls.length, 2);
  await tick(1);
  assert.equal(sb.calls.length, 3);
  assert.equal(sync.isPending('items', 'a'), false);
  sync.dispose();
});

await check('sync: unique clash still runs the deletes that may free the value', async () => {
  const { sb, sync, statuses } = setup();
  sb.failures.push({ table: 'channels', method: 'upsert', message: 'duplicate key value violates unique constraint', code: '23505' });
  sync.queue([up('channels', 'c-new', { id: 'c-new', name: 'design' }), del('channels', 'c-old', { id: 'c-old', name: 'design' })]);
  await sync.flush();
  assert.deepEqual(seq(sb), ['upsert channels', 'delete channels']);
  assert.equal(statuses.at(-1).state, 'error');
  await tick(2000);
  assert.deepEqual(seq(sb), ['upsert channels', 'delete channels', 'upsert channels']);
  assert.equal(statuses.at(-1).state, 'saved');
  sync.dispose();
});

await check('sync: a bad row only holds back itself and the deletes it nests under', async () => {
  const { sb, sync, statuses } = setup();
  const has = (col, v) => (call) => call.rows.some((r) => r[col] === v);
  sb.failures.push(
    { table: 'channels', method: 'upsert', message: 'duplicate key value', code: '23505', match: has('id', 'c-bad'), sticky: true },
    { table: 'channel_members', method: 'upsert', message: 'foreign key violation', code: '23503', match: has('channel_id', 'c-bad'), sticky: true },
  );
  sync.queue([
    up('channels', 'c-bad', { id: 'c-bad', name: 'design' }), up('channels', 'c-ok', { id: 'c-ok', name: 'ops' }),
    up('channel_members', 'c-bad:u1', { channel_id: 'c-bad', user_id: 'u1' }),
    up('channel_members', 'c-ok:u1', { channel_id: 'c-ok', user_id: 'u1' }),
    del('items', 'it-old'), del('channels', 'c-gone'),
  ]);
  await sync.flush();
  assert.deepEqual(seq(sb), [
    'upsert channels', 'upsert channels', 'upsert channels',
    'upsert channel_members', 'upsert channel_members', 'upsert channel_members',
    'delete items',
  ], 'batch, then row by row; unrelated deletes still run');
  assert.equal(statuses.at(-1).state, 'error');
  [['channels', 'c-ok'], ['channel_members', 'c-ok:u1'], ['items', 'it-old']].forEach(([t, k]) => assert.equal(sync.isPending(t, k), false, k));
  [['channels', 'c-bad'], ['channel_members', 'c-bad:u1'], ['channels', 'c-gone']].forEach(([t, k]) => assert.equal(sync.isPending(t, k), true, k));
  sb.failures.length = 0; // e.g. renamed by the time of the retry
  await tick(2000);
  assert.deepEqual(seq(sb).slice(7), ['upsert channels', 'upsert channel_members', 'delete channels']);
  assert.equal(statuses.at(-1).state, 'saved');
  sync.dispose();
});

await check('sync: network failure reports offline', async () => {
  const { sb, sync, statuses } = setup();
  sb.failures.push({ table: 'items', method: 'upsert', message: 'TypeError: Failed to fetch', status: 0 });
  sync.queue([up('items', 'a')]);
  await tick(400);
  assert.equal(statuses.at(-1).state, 'offline');
  await tick(2000);
  assert.equal(statuses.at(-1).state, 'saved');
  sync.dispose();
});

await check('sync: isPending stays true while a write is in flight', async () => {
  const { sb, sync } = setup();
  const release = sb.hold();
  sync.queue([up('items', 'a', { id: 'a', name: 'v1' })]);
  await tick(400);
  assert.equal(sb.calls.length, 1);
  assert.equal(sync.isPending('items', 'a'), true, 'in flight');
  sync.queue([up('items', 'a', { id: 'a', name: 'v2' })]);
  release();
  await settle();
  assert.equal(sync.isPending('items', 'a'), true, 'newer change still queued');
  await tick(400);
  assert.deepEqual(sb.calls[1].rows, [{ id: 'a', name: 'v2' }]);
  assert.equal(sync.isPending('items', 'a'), false);
  sync.dispose();
});

await check('sync: flush() during a write also sends what was queued meanwhile', async () => {
  const { sb, sync } = setup();
  const release = sb.hold();
  sync.queue([up('items', 'a')]);
  await tick(400);
  sync.queue([up('deals', 'd')]);
  const done = sync.flush();
  release();
  await done;
  assert.deepEqual(seq(sb), ['upsert items', 'upsert deals']);
  assert.equal(sync.isPending('deals', 'd'), false);
  sync.dispose();
});

await check('sync: store flow (diff → queue → flush) for deleting an item', async () => {
  const { sb, sync } = setup();
  const s = structuredClone(base);
  s.boards.projects.groups[0].items.shift();
  sync.queue(diff(rows0, flatten(s)));
  assert.equal(sync.isPending('subtasks', 'st-1'), true);
  await tick(400);
  assert.deepEqual(seq(sb), ['upsert items', 'delete subtasks', 'delete item_updates', 'delete items']);
  assert.deepEqual(sb.calls.find((c) => c.method === 'delete' && c.table === 'items').filters, [['in', 'id', ['it-1']]]);
  sync.dispose();
});

await check('sync: loadAll pages every table and normalises rows', async () => {
  const messages = Array.from({ length: 2500 }, (_, i) => ({
    id: `m-${String(i).padStart(4, '0')}`, channel_id: 'c1', user_id: null, text: `#${i}`, ts: '2026-10-11T01:02:03.456789+00:00',
    updated_at: '2026-10-11T01:02:03+00:00', updated_by: 'u1',
  }));
  const { sb, sync } = setup({
    items: [{ id: 'it1', board_key: 'projects', group_id: 'g1', position: 0, name: 'X', values: { b: 1, a: 2 }, done: false, updated_at: 'x', updated_by: 'u1' }],
    channel_members: [{ channel_id: 'c1', user_id: 'u1', updated_at: 'x', updated_by: 'u1' }],
    channels: [{ id: 'c1', name: 'general', created_by: 'u1', updated_at: 'x', updated_by: 'u1' }],
    deals: [{ id: 'd1', name: 'D', sector: 'S', priority: 'P1', stage: 'Won', next_step: '', value: '1200.50', owner_id: null, client_id: null, position: 0 }],
    messages,
  });
  const rows = await sync.loadAll();
  assert.deepEqual(Object.keys(rows), TABLES.map((x) => x.name));
  assert.deepEqual(rows.items.get('it1'), { id: 'it1', board_key: 'projects', group_id: 'g1', position: 0, name: 'X', values: { b: 1, a: 2 }, done: false });
  assert.deepEqual(rows.channel_members.get('c1:u1'), { channel_id: 'c1', user_id: 'u1' });
  assert.deepEqual(rows.channels.get('c1'), { id: 'c1', name: 'general' });
  assert.equal(rows.deals.get('d1').value, 1200.5);
  assert.equal(rows.messages.size, 2500);
  assert.equal(rows.messages.get('m-0000').ts, '2026-10-11T01:02:03.456Z');
  assert.equal(sb.calls.filter((c) => c.table === 'messages').length, 3);
  assert.deepEqual(sb.calls.find((c) => c.table === 'channel_members').order, ['channel_id', 'user_id']);
  assert.ok(sb.calls.every((c) => c.method === 'select' && c.columns === '*'));
  // Loaded rows assemble into state.
  assert.equal(assemble(rows, { me: 'u1' }).channels[0].members[0], 'u1');
  sync.dispose();
});

await check('sync: subscribe listens to every table on one channel', async () => {
  const { sb, sync, statuses } = setup();
  const changes = [];
  const off = sync.subscribe((c) => changes.push(c));
  assert.equal(sb.channels.length, 1);
  const ch = sb.channels[0];
  assert.equal(ch.handlers.length, TABLES.length);
  ch.handlers.forEach((h, i) => {
    assert.equal(h.type, 'postgres_changes');
    assert.deepEqual(h.filter, { event: '*', schema: 'public', table: TABLES[i].name });
  });
  const handler = (table) => ch.handlers.find((h) => h.filter.table === table).cb;
  handler('messages')({
    eventType: 'INSERT', old: {},
    new: { id: 'm1', channel_id: 'c1', user_id: 'u1', text: 'hi', ts: '2026-10-11T01:02:03.456789+00:00', updated_at: 'x', updated_by: 'u1' },
  });
  handler('channel_members')({ eventType: 'DELETE', new: {}, old: { channel_id: 'c1', user_id: 'u2' } });
  assert.deepEqual(changes, [
    { table: 'messages', eventType: 'INSERT', key: 'm1', row: { id: 'm1', channel_id: 'c1', user_id: 'u1', text: 'hi', ts: '2026-10-11T01:02:03.456Z' } },
    { table: 'channel_members', eventType: 'DELETE', key: 'c1:u2', row: { channel_id: 'c1', user_id: 'u2' } },
  ]);
  ch.status('CHANNEL_ERROR');
  assert.equal(statuses.at(-1).state, 'offline');
  ch.status('SUBSCRIBED');
  assert.equal(statuses.at(-1).state, 'saved');
  off();
  assert.deepEqual(sb.removed, [ch]);
  sync.dispose();
});

await check('sync: realtime status goes to onRealtime, and SUBSCRIBED waits for changes to stream', async () => {
  const realtime = [];
  const { sb, sync, states } = setup(undefined, { onRealtime: (st) => realtime.push([st, states().at(-1)]) });
  sync.subscribe(() => {});
  const ch = sb.channels[0];
  assert.deepEqual(ch.opts, { config: { postgres_changes_options: { wait: true } } });
  ch.status('CHANNEL_ERROR');
  sync.queue([up('items', 'a')]);
  ch.status('SUBSCRIBED');
  await tick(400);
  assert.deepEqual(realtime.map(([st]) => st), ['SUBSCRIBED', 'CHANNEL_ERROR', 'SUBSCRIBED']);
  assert.equal(states().at(-1), 'saved');
  sync.dispose();
});

globalThis.setTimeout = realTimers.setTimeout;
globalThis.clearTimeout = realTimers.clearTimeout;

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
