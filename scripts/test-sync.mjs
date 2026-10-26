// Checks the live-mode mapping and sync engine without a network: node scripts/test-sync.mjs
// (a) flatten/assemble round trip, (b) diff ops for common edits, (c) the sync queue against a fake Supabase,
// (d) roles and module access, the demo automations, the seed and the demo-data migration (docs/PHASE2.md), and the
// boards under Projects and Marketing (0006: board access, src/lib/boards.js helpers, seed and migration).
// Exits non-zero when any check fails.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import { TABLES, flatten, assemble, diff, normalizeRow } from '../src/data/backend/schema.js';
import { createSync } from '../src/data/backend/sync.js';

// src/lib/access.js reaches the store through Vite's '@/…' alias (for its React hook): Node gets a stub for
// '@/data/store' (the hook isn't run here) and resolves other '@/…' imports to src/.
const SRC = new URL('../src/', import.meta.url).href;
const STORE_STUB = `data:text/javascript,${encodeURIComponent('export const useStore = () => { throw new Error("no store in Node"); };')}`;
register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if (specifier === '@/data/store') return { url: ${JSON.stringify(STORE_STUB)}, shortCircuit: true };
    if (specifier.startsWith('@/')) return next(${JSON.stringify(SRC)} + specifier.slice(2) + (/\\.[a-z]+$/.test(specifier) ? '' : '.js'), context);
    return next(specifier, context);
  }
`)}`);

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
    { id: U1, name: 'Ana', initials: 'AN', color: '#579bfc', email: 'ana@example.com', role: 'superadmin', active: true, timezone: 'Australia/Sydney' },
    { id: U2, name: 'Ben', initials: 'BE', color: '#ff7575', email: 'ben@example.com', role: 'staff', active: false, timezone: 'Asia/Manila' },
  ],
  moduleAccess: [{ userId: U2, module: 'outreach', level: 'view' }, { userId: U2, module: 'pipeline', level: 'none' }],
  org: {
    businessName: 'Example Pty Ltd', abn: '00 000 000 000', address: '1 Example St', email: 'accounts@example.com',
    phone: '0000 000 000', bankAccountName: 'Example', bsb: '000-000', accountNumber: '00000000',
    paymentTermsDays: 14, invoicePrefix: 'EX-',
    contractTemplate: 'https://docs.google.com/document/d/template-id/edit', contractFolder: 'https://drive.google.com/drive/folders/folder-id',
  },
  // In assembled order (0006): Projects then Marketing; personal pages first (by owner name), then team boards.
  boards: [
    { id: 'b-ana', module: 'projects', name: '', owner: U1, calendar: false, groups: [
      { id: 'g-ana', name: 'Active', color: '#c9ffe6', items: [
        { id: 'it-ana', name: 'Own task', values: { people: [U1], status: 'Not started' }, done: false, updates: [], subtasks: [] },
      ] },
    ] },
    { id: 'b-ben', module: 'projects', name: '', owner: U2, calendar: false, groups: [{ id: 'g-ben', name: 'Active', color: '#c9ffe6', items: [] }] },
    { id: 'b-web', module: 'projects', name: 'Landing Page', owner: '', calendar: false, groups: [
      { id: 'g-1', name: 'Active', color: '#c9ffe6', items: [
        {
          id: 'it-1', name: 'First', values: { people: [U1, U2], status: 'In progress', due: '2026-10-30' }, done: false,
          updates: [
            { id: 'up-2', user: U2, text: 'Newer', ts: '2026-10-02T03:00:00.000Z' },
            { id: 'up-1', user: U1, text: 'Older', ts: '2026-10-01T03:00:00.000Z' },
          ],
          subtasks: [{ id: 'st-1', text: 'One', done: true }, { id: 'st-2', text: 'Two', done: false }],
        },
        { id: 'it-2', name: 'Second', values: { status: 'Done', people: [] }, done: true, updates: [], subtasks: [] },
      ] },
      { id: 'g-2', name: 'Backlog', color: '#e6eaf2', items: [] },
      { id: 'g-3', name: 'Admin', color: '#ffe6b0', items: [
        { id: 'it-3', name: 'Admin task', values: { people: [U2], status: 'Stuck' }, done: false, updates: [], subtasks: [] },
      ] },
    ] },
    { id: 'b-gen', module: 'projects', name: 'General', owner: '', calendar: false, groups: [{ id: 'g-gen', name: 'Active', color: '#c9ffe6', items: [] }] },
    { id: 'b-post', module: 'marketing', name: 'Posting schedule', owner: '', calendar: true, groups: [
      { id: 'g-oct', name: 'October', color: '#bfe9ff', items: [
        { id: 'it-m1', name: 'Golf Day post', values: { people: [U2], status: 'In progress', channel: 'LinkedIn' }, done: false, updates: [], subtasks: [] },
      ] },
    ] },
    { id: 'b-events', module: 'marketing', name: 'Events', owner: '', calendar: false, groups: [] },
  ],
  deals: [
    { id: 'd-1', name: 'Deal one', sector: 'Government', value: 70000, priority: 'P2', stage: 'Opportunities', contact: U1, next: 'Call', contactId: 'p-1' },
    { id: 'd-2', name: 'Client one', sector: 'Utilities', value: '1,500', priority: 'P1', stage: 'Won', contact: '', next: '', contactId: '', clientId: 'c-1' },
  ],
  clients: [
    {
      id: 'c-1', name: 'Client one', group: 'Onboarding', status: 'Onboarding', priority: 'P1', next: 'Kick-off', sector: 'Utilities',
      contact: U1, team: [U1, U2], lastContact: '2026-10-01', demo: 'Live', demoUrl: 'https://demo.example.com',
      platformUrl: 'https://client-one.example.com', avatar: '#3b82f6', abn: '11 111 111 111', billingAddress: '2 Example Rd',
      contacts: [
        { id: 'pc-1', name: 'Pat Doe', role: 'Asset manager', email: 'pat@example.com', phone: '0400 000 000', billing: false },
        { id: 'pc-2', name: 'Accounts', role: 'Finance', email: 'accounts@example.com', phone: '', billing: true },
      ],
      contracts: [
        {
          id: 'k-2', status: 'Draft', title: 'Renewal', docId: 'doc-2', docUrl: 'https://docs.google.com/document/d/doc-2/edit',
          startDate: '2027-11-01', endDate: '', annualFee: 5000, paymentTerms: 'Invoiced annually in advance', userLimit: '', platform: 'Asset Management',
          customisations: '', mobileApp: '', governingLaw: 'New South Wales', createdBy: U1, sentBy: '', sentAt: '', signedAt: '',
        },
        {
          id: 'k-1', status: 'Signed', title: 'Software Subscription Agreement', docId: 'doc-1', docUrl: 'https://docs.google.com/document/d/doc-1/edit',
          startDate: '2026-11-01', endDate: '2027-10-31', annualFee: 4500.5, paymentTerms: 'Invoiced annually in advance, payable within 14 days',
          userLimit: '1 master user', platform: 'Property Management', customisations: 'Ten per 12-month period', mobileApp: 'Included',
          governingLaw: 'New South Wales', createdBy: U1, sentBy: U2, sentAt: '2026-10-20T01:00:00.000Z', signedAt: '2026-10-22',
        },
      ],
      notes: [
        { id: 'n-2', user: U2, text: 'Newer note', ts: '2026-10-05T00:00:00.000Z' },
        { id: 'n-1', user: U1, text: 'Older note', ts: '2026-10-04T00:00:00.000Z' },
      ],
      tasks: [{ id: 't-1', text: 'Book meeting', done: false }],
      invoices: [
        { id: 'i-2', number: 'EX-1002', issued: '2026-10-08', due: '', status: 'Awaiting approval', planId: 'bp-1', sentAt: '', paidOn: '', sentTo: '', lines: [
          { id: 'l-3', desc: 'Licence', qty: 1, rate: 18450 },
        ] },
        { id: 'i-1', number: 'EX-1001', issued: '2026-09-01', due: '2026-10-01', status: 'Paid', planId: '', sentAt: '2026-09-01T02:00:00.000Z',
          paidOn: '2026-09-20', sentTo: 'accounts@example.com, pat@example.com', lines: [
            { id: 'l-1', desc: 'Capture', qty: '2', rate: '1,000' },
            { id: 'l-2', desc: 'Travel', qty: 1, rate: 250.5 },
          ] },
      ],
      access: [{ id: 'a-1', name: 'Pat Doe', email: 'pat@example.com', role: 'Client admin' }],
      plans: [
        { id: 'bp-1', description: 'Licence', amount: 2400, frequency: 'monthly', nextDate: '2026-11-01', anchorDay: 1, active: true },
        { id: 'bp-2', description: 'Support', amount: 99.5, frequency: 'annually', nextDate: '', anchorDay: 0, active: false },
      ],
      usage: [
        { id: 'cu-2', month: '2026-10-01', assets: 5200, sites: 12, seats: 6, credits: 1840.5, notes: 'Import' },
        { id: 'cu-1', month: '2026-09-01', assets: 3400, sites: 9, seats: 5, credits: 0, notes: '' },
      ],
    },
    {
      id: 'c-0', name: 'Client two', group: 'Active', status: 'Passive', priority: 'P2', next: '', sector: '', contact: '', team: [],
      lastContact: '', demo: '', demoUrl: '', platformUrl: '', avatar: '#f59e0b', abn: '', billingAddress: '',
      contacts: [], contracts: [], notes: [], tasks: [], invoices: [], access: [], plans: [], usage: [],
    },
  ],
  contacts: [
    { id: 'p-1', name: 'Pat Doe', org: 'Client one', email: 'pat@example.com', stage: 'Won', status: 'Replied', last: '2026-10-03T01:00:00.000Z', owner: U1 },
    { id: 'p-2', name: 'Sam Roe', org: '', email: 'sam@example.com', stage: 'Opportunity', status: 'New', last: '', owner: '' },
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
  routines: [
    { id: 'r-1', title: 'LinkedIn engagement', category: 'LinkedIn', minutes: 60, assignee: U2, weekdays: [1, 2, 3, 4, 5], start: '09:00', active: true },
    { id: 'r-2', title: 'Pipeline review', category: 'Meetings', minutes: 30, assignee: U1, weekdays: [1], start: '', active: false },
  ],
  // In assembled order: by day, then position within each person's day.
  todos: [
    { id: 't-4', assignee: U2, createdBy: U1, title: 'Carried', notes: '', day: '2026-10-09', start: '', minutes: 30, category: 'Other',
      source: 'manual', routineId: '', ref: '', done: false, doneAt: '' },
    { id: 't-1', assignee: U2, createdBy: U2, title: 'LinkedIn engagement', notes: '', day: '2026-10-12', start: '09:00', minutes: 60,
      category: 'LinkedIn', source: 'routine', routineId: 'r-1', ref: '', done: false, doneAt: '' },
    { id: 't-3', assignee: U1, createdBy: U1, title: "Upload this week's bank screenshot", notes: '', day: '2026-10-12', start: '', minutes: 30,
      category: 'Admin', source: 'automation', routineId: '', ref: 'bank:2026-10-12', done: false, doneAt: '' },
    { id: 't-2', assignee: U2, createdBy: U1, title: 'Send deck', notes: 'Use v2', day: '2026-10-12', start: '13:30', minutes: 45,
      category: 'Outreach', source: 'manual', routineId: '', ref: '', done: true, doneAt: '2026-10-12T03:00:00.000Z' },
  ],
  timeEntries: [
    { id: 'te-1', user: U2, day: '2026-10-09', start: '09:00', minutes: 60, category: 'LinkedIn', note: 'Posts', source: 'suggested' },
    { id: 'te-3', user: U1, day: '2026-10-09', start: '09:00', minutes: 30, category: 'Admin', note: '', source: 'manual' },
    { id: 'te-2', user: U2, day: '2026-10-09', start: '10:00', minutes: 60, category: 'Outreach', note: '', source: 'manual' },
  ],
  // By person, then their own order (as assemble gives them back).
  tools: [
    { id: 'wt-1', user: U1, name: 'Gmail', url: 'https://mail.google.com', username: 'ana@example.com', how: 'Sign in with Google', notes: '', createdBy: U1 },
    { id: 'wt-3', user: U1, name: 'Claude', url: 'https://claude.ai', username: '', how: '', notes: 'Team plan', createdBy: '' },
    { id: 'wt-2', user: U2, name: 'Apollo', url: 'app.apollo.io', username: 'ben@example.com', how: 'Invite from Ana', notes: '', createdBy: U1 },
  ],
  // CRM profile (0012): newest first; one on a deal, one carried to a client, one on a client only.
  crmEntries: [
    { id: 'ce-n3', dealId: '', clientId: 'c-1', kind: 'link', title: 'Pitch deck', body: '', url: 'https://example.com/deck', label: 'Deck',
      happenedOn: '', attendees: '', user: U1, createdAt: '2026-10-21T03:00:00.000Z' },
    { id: 'ce-n2', dealId: 'd-1', clientId: '', kind: 'meeting', title: 'First meeting', body: 'Wants a pilot',
      url: 'https://docs.google.com/document/d/example/edit', label: '', happenedOn: '2026-10-20', attendees: 'Jo Example', user: U2,
      createdAt: '2026-10-20T05:00:00.000Z' },
    { id: 'ce-n1', dealId: 'd-1', clientId: '', kind: 'note', title: '', body: 'Call back Friday', url: '', label: '', happenedOn: '',
      attendees: '', user: U1, createdAt: '2026-10-19T01:00:00.000Z' },
  ],
  // Calendar (0009): by day, then start (all-day first).
  calendarEvents: [
    { id: 'ce-1', kind: 'meeting', title: 'Planning', day: '2026-10-19', endDay: '', startsAt: '2026-10-18T23:00:00.000Z',
      endsAt: '2026-10-19T00:00:00.000Z', people: [U1, U2], createdBy: U1 },
    { id: 'ce-2', kind: 'event', title: 'Expo', day: '2026-10-29', endDay: '2026-11-02', startsAt: '', endsAt: '', people: [], createdBy: '' },
    { id: 'ce-3', kind: 'reminder', title: 'Renew the domain', day: '2026-11-05', endDay: '', startsAt: '', endsAt: '', people: [U2], createdBy: U2 },
  ],
  // Outreach (0007): mailboxes in order, notes newest first, the sheet's link (only for someone who can read Outreach).
  mailboxes: [
    { id: 'mb-1', name: 'Ana', addresses: ['ana@example.com', 'ana@old.example.com'], owner: U1, active: true },
    { id: 'mb-2', name: 'Shared', addresses: [], owner: '', active: false },
  ],
  outreachNotes: [
    { id: 'on-2', mailbox: 'mb-1', pinned: false, body: 'Councils reply to v2', author: U2, createdAt: '2026-10-08T00:00:00.000Z' },
    { id: 'on-1', mailbox: '', pinned: true, body: 'Lead with the tender', author: U1, createdAt: '2026-10-07T00:00:00.000Z' },
    { id: 'on-0', mailbox: 'mb-2', pinned: false, body: 'Paused for now', author: '', createdAt: '' },
  ],
  outreachSheet: 'https://docs.google.com/spreadsheets/d/1ExampleSheetIdAbCdEfGhIjKlMnOp/edit#gid=0',
  payments: [
    { id: 'pay-1', invoiceId: 'i-1', clientId: 'c-1', amount: 2750.55, receivedOn: '2026-09-20', reference: 'EX-1001', statementId: 'bs-1' },
    { id: 'pay-0', invoiceId: '', clientId: 'c-0', amount: 100, receivedOn: '2026-09-02', reference: '', statementId: '' },
  ],
  bankStatements: [
    { id: 'bs-1', weekStart: '2026-09-14', filePath: 'statements/0000-statement.png', note: 'Week 38', uploadedBy: U1, createdAt: '2026-09-21T00:00:00.000Z' },
    { id: 'bs-0', weekStart: '2026-09-07', filePath: '', note: '', uploadedBy: '', createdAt: '' },
  ],
  expenses: [
    { id: 'x-2', date: '2026-10-03', vendor: 'Golf club', category: 'Marketing', amount: 1650, gst: 150, clientId: '', receiptPath: '', notes: '', createdBy: U1 },
    { id: 'x-1', date: '2026-10-01', vendor: 'Airline', category: 'Travel', amount: 412.5, gst: 37.5, clientId: 'c-1', receiptPath: 'receipts/0000-r.pdf',
      notes: 'Visit', createdBy: U2 },
  ],
  subscriptions: [
    { id: 'sub-1', name: 'Workspace', vendor: 'Example', category: 'Software', amount: 69, cycle: 'monthly', renewsOn: '2026-11-01', active: true, notes: '3 seats' },
    { id: 'sub-2', name: 'Domains', vendor: 'Registrar', category: 'Hosting', amount: 60, cycle: 'annually', renewsOn: '', active: false, notes: '' },
  ],
});

// ── (a) Round trip ─────────────────────────────────────────────────────────────

let createSeed = null;
let migrate = null;
let outreachDemo = null;
try {
  ({ createSeed, migrate, outreachDemo } = await import('../src/data/seed.js'));
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
    payment_terms_days: 14, contract_template: 'https://docs.google.com/document/d/template-id/edit',
    contract_folder: 'https://drive.google.com/drive/folders/folder-id',
  });
  assert.deepEqual(rows.deals.get('d-2'), {
    id: 'd-2', name: 'Client one', sector: 'Utilities', priority: 'P1', stage: 'Won', next_step: '', value: 1500,
    owner_id: null, client_id: 'c-1', contact_id: null, position: 1,
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
    'messages', 'org', 'sequences', 'users', 'moduleAccess', 'routines', 'todos', 'timeEntries', 'payments', 'bankStatements',
    'expenses', 'subscriptions', 'tools', 'mailboxes', 'outreachNotes', 'outreachSheet', 'calendarEvents', 'crmEntries'].sort());
  assert.deepEqual(back.crmEntries, s.crmEntries, 'CRM entries newest first, every field back');
  assert.deepEqual(back.boards.map((b) => b.id), ['b-ana', 'b-ben', 'b-web', 'b-gen', 'b-post', 'b-events']);
  const web = back.boards.find((b) => b.id === 'b-web');
  assert.deepEqual(web.groups.map((g) => g.id), ['g-1', 'g-2', 'g-3']);
  assert.deepEqual(web.groups[0].items.map((i) => i.id), ['it-1', 'it-2']);
  assert.deepEqual(web.groups[0].items[0].updates.map((u) => u.id), ['up-2', 'up-1']); // newest first
  assert.deepEqual(back.boards.at(-1), { id: 'b-events', module: 'marketing', name: 'Events', owner: '', calendar: false, groups: [] });
  assert.deepEqual(back.calendarEvents, s.calendarEvents);
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
  ['boards', 'contacts', 'emails', 'sequences', 'approvals', 'messages', 'moduleAccess', 'routines', 'todos', 'timeEntries', 'payments',
    'bankStatements', 'expenses', 'subscriptions', 'tools', 'mailboxes', 'outreachNotes', 'outreachSheet']
    .forEach((k) => assert.deepEqual(back[k], s[k], k));
  assert.deepEqual(back.clients[1], s.clients[1]);
  assert.deepEqual(back.clients[0].plans, s.clients[0].plans);
  assert.deepEqual(back.clients[0].usage, s.clients[0].usage); // newest month first
  assert.deepEqual(back.clients[0].invoices.map(({ lines: _l, ...inv }) => inv), s.clients[0].invoices.map(({ lines: _l, ...inv }) => inv));
  assert.deepEqual(back.deals, s.deals.map((d) => ({ ...d, value: Number(String(d.value).replace(/,/g, '')) })));
});

await check('profiles: time zones round trip; a blank or missing one is Sydney (0003)', () => {
  const s = fixture();
  assert.deepEqual([...flatten(s).profiles.values()].map((r) => r.timezone), ['Australia/Sydney', 'Asia/Manila']);
  s.users[1].timezone = '';
  delete s.users[0].timezone;
  assert.deepEqual([...flatten(s).profiles.values()].map((r) => r.timezone), ['Australia/Sydney', 'Australia/Sydney'], 'never sends a blank');
  const rows = flatten(fixture());
  rows.profiles.get(U2).timezone = null;
  assert.deepEqual(assemble(rows, { me: U1 }).users.map((u) => u.timezone), ['Australia/Sydney', 'Australia/Sydney'], 'read before 0003 ran');
});

await check('assemble: empty rows give a usable state', () => {
  const back = assemble({}, { me: U1 });
  assert.deepEqual(back.boards, []);
  ['moduleAccess', 'routines', 'todos', 'timeEntries', 'payments', 'bankStatements', 'expenses', 'subscriptions', 'tools', 'mailboxes',
    'outreachNotes'].forEach((k) => assert.deepEqual(back[k], [], k));
  assert.ok(!('outreachSheet' in back), 'no settings row (no Outreach access): no sheet link in state');
  assert.equal(back.org.paymentTermsDays, 30);
  assert.equal(back.org.invoicePrefix, 'INV-');
  assert.deepEqual(back.lastRead, { [U1]: {} });
  assert.deepEqual(back.clients, []);
});

await check('flatten: boards, and the board on every group and task (0006)', () => {
  const s = fixture();
  const rows = flatten(s);
  assert.deepEqual(rows.boards.get('b-ana'), { id: 'b-ana', module: 'projects', name: '', owner_id: U1, position: 0, calendar: false });
  assert.deepEqual(rows.boards.get('b-gen'), { id: 'b-gen', module: 'projects', name: 'General', owner_id: null, position: 1, calendar: false });
  // The 3-month calendar flag (0009) is a team board's: a personal page never sends one.
  assert.equal(rows.boards.get('b-post').calendar, true);
  assert.equal(flatten({ ...s, boards: [{ ...s.boards[0], calendar: true }] }).boards.get('b-ana').calendar, false);
  // Team boards are numbered within their module, in array order; a personal board is always 0.
  assert.deepEqual(s.boards.map((b) => [b.id, rows.boards.get(b.id).position]),
    [['b-ana', 0], ['b-ben', 0], ['b-web', 0], ['b-gen', 1], ['b-post', 0], ['b-events', 1]]);
  assert.deepEqual(rows.board_groups.get('g-2'), { id: 'g-2', board_key: 'projects', board_id: 'b-web', name: 'Backlog', color: '#e6eaf2', position: 1 });
  assert.deepEqual(['g-ana', 'g-oct'].map((k) => [rows.board_groups.get(k).board_key, rows.board_groups.get(k).board_id]),
    [['projects', 'b-ana'], ['marketing', 'b-post']]);
  assert.deepEqual(rows.items.get('it-3'), {
    id: 'it-3', board_key: 'projects', board_id: 'b-web', group_id: 'g-3', position: 0, name: 'Admin task', values: { people: [U2], status: 'Stuck' },
    done: false,
  });
  assert.deepEqual(['it-ana', 'it-m1'].map((k) => [rows.items.get(k).board_key, rows.items.get(k).board_id]), [['projects', 'b-ana'], ['marketing', 'b-post']]);
  // A personal board's name is never sent (its title comes from its owner), personal boards in between don't count
  // in the team positions, and a board of another module is not sent at all (nor its groups).
  const odd = fixture();
  odd.boards = [odd.boards[2], { ...odd.boards[0], name: 'Mine' }, odd.boards[3],
    { id: 'b-admin', module: 'admin', name: 'Admin', owner: '', groups: [{ id: 'g-admin', name: 'To do', color: '', items: [] }] }];
  const r = flatten(odd);
  assert.deepEqual([...r.boards.values()].map((b) => [b.id, b.name, b.position]), [['b-web', 'Landing Page', 0], ['b-ana', '', 0], ['b-gen', 'General', 1]]);
  assert.ok(!r.board_groups.has('g-admin'));
  // No boards, or the pre-0006 object shape (migrate() converts it first): no board rows.
  [undefined, { projects: { groups: [] }, marketing: { groups: [] } }].forEach((boards) => {
    const x = flatten({ ...fixture(), boards });
    ['boards', 'board_groups', 'items', 'item_updates', 'subtasks'].forEach((t) => assert.equal(x[t].size, 0, t));
  });
});

await check('assemble: boards are Projects then Marketing, personal pages by owner name, team boards by position (0006)', () => {
  const rows = flatten(fixture());
  // Rows arrive in any order (pages, realtime).
  const mixed = Object.fromEntries(Object.entries(rows).map(([t, m]) => [t, new Map([...m].reverse())]));
  mixed.boards = new Map(['b-events', 'b-gen', 'b-post', 'b-ben', 'b-web', 'b-ana'].map((k) => [k, rows.boards.get(k)]));
  const back = assemble(mixed, { me: U1 });
  assert.deepEqual(back.boards.map((b) => b.id), ['b-ana', 'b-ben', 'b-web', 'b-gen', 'b-post', 'b-events']);
  assert.deepEqual(back.boards, fixture().boards);
  // By the owner's name (any case), not their id; team boards by position, then id; Projects first whatever the
  // positions say.
  const moved = structuredClone(mixed);
  moved.profiles.get(U2).name = 'aaron';
  [['b-web', 5], ['b-gen', 2], ['b-post', 1], ['b-events', 1]].forEach(([k, p]) => { moved.boards.get(k).position = p; });
  const order = assemble(moved, { me: U1 }).boards;
  assert.deepEqual(order.map((b) => b.id), ['b-ben', 'b-ana', 'b-gen', 'b-web', 'b-events', 'b-post']);
  // The round trip is stable: same boards back, and their rows don't change again.
  const again = flatten({ ...assemble(moved, { me: U1 }), me: U1 });
  assert.deepEqual(assemble(again, { me: U1 }).boards, order);
  assert.deepEqual(plain(flatten({ ...assemble(again, { me: U1 }), me: U1 })), plain(again));
  assert.deepEqual([again.boards.get('b-gen').position, again.boards.get('b-web').position, again.boards.get('b-events').position], [0, 1, 0]);
  // A group (and its tasks) whose board row is missing (not loaded yet, or not visible) is left out, as is a board
  // of another module.
  const partial = structuredClone(mixed);
  partial.boards.delete('b-web');
  partial.boards.set('b-admin', { id: 'b-admin', module: 'admin', name: 'Admin', owner_id: null, position: 0 });
  partial.board_groups.set('g-admin', { id: 'g-admin', board_key: 'admin', board_id: 'b-admin', name: 'To do', color: '', position: 0 });
  const p = assemble(partial, { me: U1 });
  assert.deepEqual(p.boards.map((b) => b.id), ['b-ana', 'b-ben', 'b-gen', 'b-post', 'b-events']);
  const json = JSON.stringify(p.boards);
  ['g-1', 'g-2', 'g-3', 'it-1', 'it-3', 'up-1', 'st-1', 'g-admin'].forEach((id) => assert.ok(!json.includes(`"${id}"`), id));
});

await check('flatten: phase 2 tables and columns', () => {
  const rows = flatten(fixture());
  assert.deepEqual(rows.module_access.get(`${U2}:outreach`), { user_id: U2, module: 'outreach', level: 'view' });
  assert.equal(rows.contacts.get('p-1').owner_id, U1);
  assert.equal(rows.contacts.get('p-2').owner_id, null);
  assert.equal(rows.deals.get('d-1').contact_id, 'p-1');
  assert.deepEqual(
    ['plan_id', 'sent_at', 'paid_on'].map((k) => [rows.invoices.get('i-2')[k], rows.invoices.get('i-1')[k]]),
    [['bp-1', null], [null, '2026-09-01T02:00:00.000Z'], [null, '2026-09-20']],
  );
  assert.deepEqual(rows.billing_plans.get('bp-2'), {
    id: 'bp-2', client_id: 'c-1', description: 'Support', amount: 99.5, frequency: 'annually', next_date: null, anchor_day: 0, active: false,
    position: 1,
  });
  assert.deepEqual(rows.client_usage.get('cu-2'), {
    id: 'cu-2', client_id: 'c-1', month: '2026-10-01', assets: 5200, sites: 12, seats: 6, credits: 1840.5, notes: 'Import',
  });
  assert.deepEqual(rows.routines.get('r-1').weekdays, [1, 2, 3, 4, 5]);
  assert.equal(rows.routines.get('r-1').start_time, '09:00');
  assert.equal(rows.routines.get('r-2').start_time, null);
  assert.deepEqual(rows.todos.get('t-2'), {
    id: 't-2', assignee_id: U2, created_by: U1, title: 'Send deck', notes: 'Use v2', day: '2026-10-12', start_time: '13:30', minutes: 45,
    category: 'Outreach', source: 'manual', routine_id: null, ref: '', done: true, done_at: '2026-10-12T03:00:00.000Z', position: 1,
  });
  assert.equal(rows.todos.get('t-1').routine_id, 'r-1');
  assert.equal(rows.todos.get('t-3').done_at, null);
  // Positions count within one person's day (t-1 and t-3 share a day but not a person; t-4 is another day).
  [['todos', 't-4', 0], ['todos', 't-1', 0], ['todos', 't-3', 0], ['todos', 't-2', 1], ['time_entries', 'te-1', 0], ['time_entries', 'te-3', 0],
    ['time_entries', 'te-2', 1], ['routines', 'r-2', 1], ['expenses', 'x-2', 1], ['expenses', 'x-1', 0], ['subscriptions', 'sub-2', 1]]
    .forEach(([table, key, pos]) => assert.equal(rows[table].get(key).position, pos, `${table} ${key}`));
  assert.deepEqual(rows.payments.get('pay-0'), {
    id: 'pay-0', invoice_id: null, client_id: 'c-0', amount: 100, received_on: '2026-09-02', reference: '', statement_id: null,
  });
  assert.deepEqual(rows.bank_statements.get('bs-0'), { id: 'bs-0', week_start: '2026-09-07', file_path: '', note: '', uploaded_by: null, created_at: null });
  assert.equal(rows.expenses.get('x-2').client_id, null);
  assert.equal(rows.subscriptions.get('sub-2').renews_on, null);
  assert.deepEqual(rows.time_entries.get('te-2'), {
    id: 'te-2', user_id: U2, day: '2026-10-09', start_time: '10:00', minutes: 60, category: 'Outreach', note: '', source: 'manual', position: 1,
  });
});

await check('flatten: client contacts, contracts, platform, credits and sentTo (0004)', () => {
  const rows = flatten(fixture());
  assert.equal(rows.clients.get('c-1').platform_url, 'https://client-one.example.com');
  assert.ok(!('key_contact' in rows.clients.get('c-1')) && !('email' in rows.clients.get('c-1')), 'legacy columns are no longer synced');
  assert.deepEqual(rows.client_contacts.get('pc-2'), {
    id: 'pc-2', client_id: 'c-1', position: 1, name: 'Accounts', role: 'Finance', email: 'accounts@example.com', phone: '', billing: true,
  });
  assert.equal(rows.client_contacts.get('pc-1').position, 0);
  // Contracts are added at the top, like invoices: positions count from the end.
  assert.deepEqual(rows.client_contracts.get('k-1'), {
    id: 'k-1', client_id: 'c-1', position: 0, status: 'Signed', title: 'Software Subscription Agreement', doc_id: 'doc-1',
    doc_url: 'https://docs.google.com/document/d/doc-1/edit', start_date: '2026-11-01', end_date: '2027-10-31', annual_fee: 4500.5,
    payment_terms: 'Invoiced annually in advance, payable within 14 days', user_limit: '1 master user', platform: 'Property Management',
    customisations: 'Ten per 12-month period', mobile_app: 'Included', governing_law: 'New South Wales', created_by: U1, sent_by: U2,
    sent_at: '2026-10-20T01:00:00.000Z', signed_at: '2026-10-22',
  });
  assert.deepEqual([rows.client_contracts.get('k-2').position, rows.client_contracts.get('k-2').end_date, rows.client_contracts.get('k-2').sent_by],
    [1, null, null]);
  assert.equal(rows.invoices.get('i-1').sent_to, 'accounts@example.com, pat@example.com');
  assert.equal(rows.invoices.get('i-2').sent_to, '');
  // Both new tables come after clients (FK order) and nest under it (cascade-aware deletes).
  const order = TABLES.map((t) => t.name);
  ['client_contacts', 'client_contracts'].forEach((t) => {
    assert.ok(order.indexOf(t) > order.indexOf('clients'), t);
    assert.deepEqual(TABLES.find((x) => x.name === t).parent, ['clients', 'client_id']);
  });
});

await check('normalizeRow: Postgres time, int[] and numeric values come back in state form', () => {
  const todo = normalizeRow('todos', { id: 't', assignee_id: U1, day: '2026-10-12', start_time: '09:30:00', minutes: '15', done_at: '2026-10-12T01:02:03.456789+00:00' });
  assert.equal(todo.start_time, '09:30');
  assert.equal(todo.minutes, 15);
  assert.equal(todo.done_at, '2026-10-12T01:02:03.456Z');
  assert.equal(todo.created_by, null);
  assert.equal(normalizeRow('time_entries', { start_time: '7:05' }).start_time, '07:05');
  assert.equal(normalizeRow('time_entries', { start_time: '25:00' }).start_time, null);
  assert.deepEqual(normalizeRow('routines', { weekdays: [5, 1, 1] }).weekdays, [1, 5]);
  assert.deepEqual(normalizeRow('routines', { weekdays: '{3,2}' }).weekdays, [2, 3]);
  assert.deepEqual(normalizeRow('routines', { weekdays: null }).weekdays, []);
  assert.equal(normalizeRow('billing_plans', { amount: '2400.50' }).amount, 2400.5);
  assert.equal(normalizeRow('expenses', { gst: '37.50' }).gst, 37.5);
});

await check('flatten / assemble: outreach mailboxes, notes and the sheet\'s link (0007)', () => {
  const rows = flatten(fixture());
  assert.deepEqual([...rows.outreach_mailboxes.values()], [
    { id: 'mb-1', name: 'Ana', addresses: ['ana@example.com', 'ana@old.example.com'], owner_id: U1, active: true, position: 0 },
    { id: 'mb-2', name: 'Shared', addresses: [], owner_id: null, active: false, position: 1 },
  ], 'position is the array index; no owner is null');
  assert.deepEqual(rows.outreach_notes.get('on-1'), {
    id: 'on-1', mailbox_id: null, pinned: true, body: 'Lead with the tender', author_id: U1, created_at: '2026-10-07T00:00:00.000Z',
  }, 'a note for every mailbox has no mailbox_id');
  assert.deepEqual(rows.outreach_notes.get('on-0'), { id: 'on-0', mailbox_id: 'mb-2', pinned: false, body: 'Paused for now', author_id: null, created_at: null });
  assert.deepEqual([...rows.outreach_settings.entries()], [['1', { id: 1, sheet_url: fixture().outreachSheet }]], 'one settings row: id 1, the link only');
  // Addresses are kept lower-case and trimmed (as the database's text[] holds them, so a re-read is no change); blanks go.
  const odd = fixture();
  odd.mailboxes[0].addresses = [' Ana@Example.COM ', '', 'ANA@old.example.com'];
  delete odd.mailboxes[1].active; // missing: active
  assert.deepEqual(flatten(odd).outreach_mailboxes.get('mb-1').addresses, ['ana@example.com', 'ana@old.example.com']);
  assert.equal(flatten(odd).outreach_mailboxes.get('mb-2').active, true);
  assert.deepEqual(diff(rows, flatten({ ...odd, mailboxes: [{ ...odd.mailboxes[0] }, fixture().mailboxes[1]] })), [], 'normalised addresses are no change');
  // The sheet's link: absent (someone without Outreach: no settings row loaded) → no row at all, so nothing is ever written
  // for them; '' (an admin cleared it) → a row with ''.
  const without = fixture();
  delete without.outreachSheet;
  assert.equal(flatten(without).outreach_settings.size, 0);
  // diff() lists the row's disappearance as a delete, which the sync never sends for an update-only table ((c) below).
  assert.deepEqual(diff(rows, flatten(without)).map((o) => `${o.op} ${o.table} ${o.key}`), ['delete outreach_settings 1']);
  assert.equal(TABLES.find((t) => t.name === 'outreach_settings').update, true);
  assert.deepEqual(flatten({ ...fixture(), outreachSheet: '' }).outreach_settings.get('1'), { id: 1, sheet_url: '' });
  [undefined, null, 0].forEach((v) => assert.equal(flatten({ ...fixture(), outreachSheet: v }).outreach_settings.size, 0, String(v)));
  // Assembled: mailboxes by position, notes newest first (undated last), the link only when its row was loaded.
  const mixed = Object.fromEntries(Object.entries(rows).map(([t, m]) => [t, new Map([...m].reverse())]));
  const back = assemble(mixed, { me: U1 });
  assert.deepEqual(back.mailboxes.map((m) => m.id), ['mb-1', 'mb-2']);
  assert.deepEqual(back.outreachNotes.map((n) => n.id), ['on-2', 'on-1', 'on-0']);
  assert.equal(back.outreachSheet, fixture().outreachSheet);
  const noSettings = { ...rows, outreach_settings: new Map() };
  assert.ok(!('outreachSheet' in assemble(noSettings, { me: U1 })));
  assert.equal(flatten({ ...assemble(noSettings, { me: U1 }), me: U1 }).outreach_settings.size, 0, 'round trip without access: still no row');
  // A note on a mailbox that isn't loaded still shows (the page shows it under all mailboxes); assemble never drops one.
  const orphan = structuredClone(rows);
  orphan.outreach_mailboxes.delete('mb-2');
  assert.deepEqual(assemble(orphan, { me: U1 }).outreachNotes.map((n) => [n.id, n.mailbox]), [['on-2', 'mb-1'], ['on-1', ''], ['on-0', 'mb-2']]);
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
const boardOf = (s, id) => s.boards.find((b) => b.id === id);
const item1 = (s) => boardOf(s, 'b-web').groups[0].items[0];

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
  const ops = opsAfter((s) => { boardOf(s, 'b-web').groups[0].items.shift(); });
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

await check('diff: a new to-do only writes that row', () => {
  const ops = opsAfter((s) => {
    s.todos.push({ id: 't-new', assignee: U2, createdBy: U2, title: 'New', notes: '', day: '2026-10-12', start: '', minutes: 30, category: 'Other',
      source: 'manual', routineId: '', ref: '', done: false, doneAt: '' });
  });
  assert.deepEqual(labels(ops), ['upsert todos t-new']);
  assert.equal(ops[0].row.position, 2);
});

await check('diff: to-dos are numbered within a person\'s day, so other days never move', () => {
  assert.deepEqual(labels(opsAfter((s) => { s.todos = s.todos.filter((t) => t.id !== 't-4'); })), ['delete todos t-4']);
  const ops = opsAfter((s) => {
    const t = s.todos.find((x) => x.id === 't-1');
    t.day = '2026-10-13';
  });
  assert.deepEqual(labels(ops), ['upsert todos t-1', 'upsert todos t-2']); // t-2 moves up to position 0 of that day
  assert.equal(ops.find((o) => o.key === 't-2').row.position, 0);
  assert.deepEqual(labels(opsAfter((s) => { s.timeEntries = s.timeEntries.filter((e) => e.user !== U2); })), ['delete time_entries te-1', 'delete time_entries te-2']);
});

await check('diff: module access overrides upsert and delete by user and module', () => {
  const ops = opsAfter((s) => {
    s.moduleAccess = s.moduleAccess.filter((a) => a.module !== 'pipeline');
    s.moduleAccess[0].level = 'edit';
    s.moduleAccess.push({ userId: U2, module: 'clients', level: 'none' });
  });
  assert.deepEqual(labels(ops), [`delete module_access ${U2}:pipeline`, `upsert module_access ${U2}:clients`, `upsert module_access ${U2}:outreach`]);
});

await check('diff: plans, usage, payments, expenses and subscriptions', () => {
  const ops = opsAfter((s) => {
    s.clients[0].plans[0].nextDate = '2026-12-01';
    s.clients[0].usage.unshift({ id: 'cu-3', month: '2026-11-01', assets: 1, sites: 1, seats: 1, notes: '' });
    s.payments.unshift({ id: 'pay-2', invoiceId: 'i-2', clientId: 'c-1', amount: 1, receivedOn: '2026-10-10', reference: '', statementId: '' });
    s.expenses.unshift({ id: 'x-3', date: '2026-10-10', vendor: 'V', category: 'Other', amount: 11, gst: 1, clientId: '', receiptPath: '', notes: '', createdBy: U1 });
    s.subscriptions[1].active = true;
  });
  assert.deepEqual(labels(ops), [
    'upsert billing_plans bp-1', 'upsert client_usage cu-3', 'upsert expenses x-3', 'upsert payments pay-2', 'upsert subscriptions sub-2',
  ]); // the new expense goes on top without renumbering the others
  assert.equal(ops.find((o) => o.key === 'x-3').row.position, 2);
});

await check('diff: a new client contact or contract writes only that row; deleting a client deletes them', () => {
  const added = opsAfter((s) => {
    s.clients[0].contacts.push({ id: 'pc-3', name: 'New', role: '', email: 'new@example.com', phone: '', billing: false });
    s.clients[0].contracts.unshift({ ...s.clients[0].contracts[0], id: 'k-3', status: 'Draft', title: 'Another' });
  });
  assert.deepEqual(labels(added), ['upsert client_contacts pc-3', 'upsert client_contracts k-3']);
  assert.equal(added.find((o) => o.key === 'k-3').row.position, 2, 'on top without renumbering the others');
  const removed = opsAfter((s) => { s.clients.shift(); });
  ['delete client_contacts pc-1', 'delete client_contacts pc-2', 'delete client_contracts k-1', 'delete client_contracts k-2', 'delete clients c-1']
    .forEach((l) => assert.ok(labels(removed).includes(l), l));
});

await check('flatten: work tools are numbered within each person\'s list; a new one writes only itself (0005)', () => {
  const rows = flatten(fixture());
  assert.deepEqual(rows.work_tools.get('wt-3'), {
    id: 'wt-3', user_id: U1, position: 1, name: 'Claude', url: 'https://claude.ai', username: '', how: '', notes: 'Team plan', created_by: null,
  });
  assert.deepEqual(['wt-1', 'wt-2'].map((k) => rows.work_tools.get(k).position), [0, 0]);
  assert.equal(rows.work_tools.get('wt-2').url, 'app.apollo.io', 'the link is kept as typed');
  const ops = opsAfter((s) => {
    s.tools.push({ id: 'wt-4', user: U2, name: 'LinkedIn', url: 'https://www.linkedin.com', username: '', how: '', notes: '', createdBy: U1 });
  });
  assert.deepEqual(labels(ops), ['upsert work_tools wt-4']);
  assert.equal(ops[0].row.position, 1);
});

await check('diff: deleting a plan unlinks its invoices before the plan goes', () => {
  const ops = opsAfter((s) => {
    s.clients[0].plans.shift();
    s.clients[0].invoices[0].planId = '';
  });
  assert.deepEqual(labels(ops), ['delete billing_plans bp-1', 'upsert billing_plans bp-2', 'upsert invoices i-2']); // sync sends upserts first
});

await check('diff: groups still on the old admin board (before 0002 moves them) are never deleted', () => {
  const prev = flatten(base);
  prev.board_groups.set('g-old', { id: 'g-old', board_key: 'admin', name: 'To do', color: '', position: 0 }); // no board_id before 0006
  prev.items.set('it-old', { ...prev.items.get('it-3'), id: 'it-old', board_key: 'admin', group_id: 'g-old' });
  assert.deepEqual(diff(prev, flatten(base)), []);
  // Nor a board of another module and what is on it, or a group on a board whose row this user doesn't have (0006).
  prev.boards.set('b-old', { id: 'b-old', module: 'admin', name: 'Admin', owner_id: null, position: 0 });
  prev.board_groups.set('g-old2', { id: 'g-old2', board_key: 'admin', board_id: 'b-old', name: 'To do', color: '', position: 0 });
  prev.items.set('it-old2', { ...prev.items.get('it-3'), id: 'it-old2', board_key: 'admin', board_id: 'b-old', group_id: 'g-old2' });
  prev.board_groups.set('g-hidden', { ...prev.board_groups.get('g-ben'), id: 'g-hidden', board_id: 'b-hidden' });
  assert.deepEqual(diff(prev, flatten(base)), []);
});

await check('diff: renaming, reordering or adding a team board writes only those boards; a personal page is never renamed (0006)', () => {
  const renamed = opsAfter((s) => { boardOf(s, 'b-gen').name = 'General ops'; });
  assert.deepEqual(labels(renamed), ['upsert boards b-gen']);
  assert.deepEqual(renamed[0].row, { id: 'b-gen', module: 'projects', name: 'General ops', owner_id: null, position: 1, calendar: false });
  const shown = opsAfter((s) => { boardOf(s, 'b-gen').calendar = true; });
  assert.deepEqual(shown.map((o) => [o.op, o.key, o.row.calendar]), [['upsert', 'b-gen', true]], 'Show calendar writes only that board');
  assert.deepEqual(opsAfter((s) => { boardOf(s, 'b-ana').name = 'Mine'; }), [], "a personal page's name is never sent");
  const swapped = opsAfter((s) => {
    const i = s.boards.findIndex((b) => b.id === 'b-gen');
    s.boards.splice(i - 1, 2, s.boards[i], s.boards[i - 1]);
  });
  assert.deepEqual(swapped.map((o) => [o.op, o.key, o.row.position]).sort(), [['upsert', 'b-gen', 0], ['upsert', 'b-web', 1]]);
  assert.ok(swapped.every((o) => o.table === 'boards'));
  const added = opsAfter((s) => {
    s.boards.push({ id: 'b-new', module: 'marketing', name: 'Webinars', owner: '', groups: [{ id: 'g-new', name: 'To do', color: '#c9ffe6', items: [] }] });
  });
  assert.deepEqual(labels(added), ['upsert board_groups g-new', 'upsert boards b-new'], 'at the end: nothing else moves');
  assert.deepEqual(added.find((o) => o.key === 'b-new').row, { id: 'b-new', module: 'marketing', name: 'Webinars', owner_id: null, position: 2, calendar: false });
  assert.deepEqual(added.find((o) => o.key === 'g-new').row.board_id, 'b-new');
});

await check('diff: deleting a board deletes its groups, tasks, updates and subtasks; only the team boards after it move up (0006)', () => {
  const ops = opsAfter((s) => { s.boards = s.boards.filter((b) => b.id !== 'b-web'); });
  assert.deepEqual(labels(ops), [
    'delete board_groups g-1', 'delete board_groups g-2', 'delete board_groups g-3', 'delete boards b-web',
    'delete item_updates up-1', 'delete item_updates up-2', 'delete items it-1', 'delete items it-2', 'delete items it-3',
    'delete subtasks st-1', 'delete subtasks st-2',
    'upsert boards b-gen', // position 1 → 0
  ]);
  assert.equal(ops.find((o) => o.key === 'b-gen').row.position, 0);
  const mk = opsAfter((s) => { s.boards = s.boards.filter((b) => b.id !== 'b-post'); });
  assert.deepEqual(labels(mk), ['delete board_groups g-oct', 'delete boards b-post', 'delete items it-m1', 'upsert boards b-events'],
    'the other module is left alone');
  assert.deepEqual(labels(opsAfter((s) => { s.boards = s.boards.filter((b) => b.id !== 'b-events'); })), ['delete boards b-events'], 'the last one');
});

await check('diff: moving a task to another board writes that task with its new board and group (0006)', () => {
  const moveTo = (s, itemId, boardId, groupId) => {
    const from = s.boards.flatMap((b) => b.groups).find((g) => g.items.some((i) => i.id === itemId));
    const [it] = from.items.splice(from.items.findIndex((i) => i.id === itemId), 1);
    boardOf(s, boardId).groups.find((g) => g.id === groupId).items.push(it);
  };
  const last = opsAfter((s) => moveTo(s, 'it-2', 'b-gen', 'g-gen'));
  assert.deepEqual(labels(last), ['upsert items it-2']);
  assert.deepEqual(last[0].row, {
    id: 'it-2', board_key: 'projects', board_id: 'b-gen', group_id: 'g-gen', position: 0, name: 'Second', values: { status: 'Done', people: [] },
    done: true,
  });
  // The first task of its group: the one after it moves up; its updates and subtasks go with it, unwritten.
  const first = opsAfter((s) => moveTo(s, 'it-1', 'b-ana', 'g-ana'));
  assert.deepEqual(labels(first), ['upsert items it-1', 'upsert items it-2']);
  assert.deepEqual(['board_id', 'group_id', 'position'].map((k) => first.find((o) => o.key === 'it-1').row[k]), ['b-ana', 'g-ana', 1]);
  assert.equal(first.find((o) => o.key === 'it-2').row.position, 0);
  // Another group on the same board.
  const within = opsAfter((s) => moveTo(s, 'it-3', 'b-web', 'g-2'));
  assert.deepEqual(labels(within), ['upsert items it-3']);
  assert.deepEqual(['board_id', 'group_id', 'position'].map((k) => within[0].row[k]), ['b-web', 'g-2', 0]);
});

await check('diff: dragging a task (withItemPlaced) writes only the tasks whose place changed; Sort on a sorted group writes nothing', async () => {
  const { withItemPlaced, sortedItems } = await import('../src/lib/boards.js');
  const place = (itemId, groupId, beforeId) => opsAfter((s) => {
    const b = boardOf(s, 'b-web');
    b.groups = withItemPlaced(b.groups, itemId, groupId, beforeId);
  });
  const up = place('it-2', 'g-1', 'it-1');
  assert.deepEqual(labels(up), ['upsert items it-1', 'upsert items it-2']);
  assert.deepEqual(up.map((o) => [o.key, o.row.position]).sort(), [['it-1', 1], ['it-2', 0]]);
  // Into another group, between two tasks: it and the task after it; the group it left had nothing after it.
  const across = place('it-3', 'g-1', 'it-2');
  assert.deepEqual(labels(across), ['upsert items it-2', 'upsert items it-3']);
  assert.deepEqual(across.map((o) => [o.key, o.row.group_id, o.row.position]).sort(), [['it-2', 'g-1', 2], ['it-3', 'g-1', 1]]);
  assert.deepEqual(across.find((o) => o.key === 'it-3').row.board_id, 'b-web');
  const sorted = opsAfter((s) => {
    boardOf(s, 'b-web').groups.forEach((g) => { g.items = sortedItems(g.items, 'due', { priorities: ['High', 'Medium', 'Low'] }); });
  });
  assert.deepEqual(sorted, []);
});

await check('diff: a new outreach note, an edited note or mailbox, a moved mailbox or a new sheet link writes only that row (0007)', () => {
  const note = { id: 'on-new', mailbox: 'mb-1', pinned: false, body: 'Short subject lines', author: U1, createdAt: '2026-10-09T00:00:00.000Z' };
  const added = opsAfter((s) => { s.outreachNotes.unshift(note); });
  assert.deepEqual(labels(added), ['upsert outreach_notes on-new']);
  assert.deepEqual(added[0].row, {
    id: 'on-new', mailbox_id: 'mb-1', pinned: false, body: 'Short subject lines', author_id: U1, created_at: '2026-10-09T00:00:00.000Z',
  });
  assert.deepEqual(labels(opsAfter((s) => { s.outreachNotes[1].pinned = false; s.outreachNotes[1].body = 'Lead with the live tender'; })),
    ['upsert outreach_notes on-1']);
  const edited = opsAfter((s) => { s.mailboxes[0].addresses = ['ana@example.com', 'Ana@New.Example.com ']; });
  assert.deepEqual(labels(edited), ['upsert outreach_mailboxes mb-1']);
  assert.deepEqual(edited[0].row, { id: 'mb-1', name: 'Ana', addresses: ['ana@example.com', 'ana@new.example.com'], owner_id: U1, active: true, position: 0 });
  const moved = opsAfter((s) => { s.mailboxes.reverse(); });
  assert.deepEqual(moved.map((o) => [o.op, o.table, o.key, o.row.position]).sort(),
    [['upsert', 'outreach_mailboxes', 'mb-1', 1], ['upsert', 'outreach_mailboxes', 'mb-2', 0]]);
  const linked = opsAfter((s) => { s.outreachSheet = 'https://docs.google.com/spreadsheets/d/1AnotherExampleSheetId0123456/edit'; });
  assert.deepEqual(linked.map((o) => [o.op, o.table, o.key, o.row]),
    [['upsert', 'outreach_settings', '1', { id: 1, sheet_url: 'https://docs.google.com/spreadsheets/d/1AnotherExampleSheetId0123456/edit' }]]);
});

await check('diff: removing a mailbox deletes it and its notes (other notes stay); the mailboxes after it move up (0007)', () => {
  const ops = opsAfter((s) => {
    s.mailboxes = s.mailboxes.filter((m) => m.id !== 'mb-1');
    s.outreachNotes = s.outreachNotes.filter((n) => n.mailbox !== 'mb-1');
  });
  assert.deepEqual(labels(ops), ['delete outreach_mailboxes mb-1', 'delete outreach_notes on-2', 'upsert outreach_mailboxes mb-2']);
  assert.equal(ops.find((o) => o.key === 'mb-2').row.position, 0);
  assert.equal(ops.find((o) => o.key === 'on-2').row.mailbox_id, 'mb-1', 'deletes carry the old row');
  // The last one: only its own rows.
  assert.deepEqual(labels(opsAfter((s) => {
    s.mailboxes = s.mailboxes.filter((m) => m.id !== 'mb-2');
    s.outreachNotes = s.outreachNotes.filter((n) => n.mailbox !== 'mb-2');
  })), ['delete outreach_mailboxes mb-2', 'delete outreach_notes on-0']);
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
            result = { data: null, error: { message: f.message, code: f.code ?? '', details: f.details ?? '' }, status: f.status ?? 400 };
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

// What PostgREST says for a foreign key violation (23503): the constraint in the message, the key in details.
const fkError = (table, cols, values, ref) => ({
  table, method: 'upsert', code: '23503', sticky: true,
  message: `insert or update on table "${table}" violates foreign key constraint "${table}_${cols.replace(', ', '_')}_fkey"`,
  details: `Key (${cols})=(${values}) is not present in table "${ref}".`,
});

await check('sync: a link the database clears on delete, to a row deleted elsewhere, goes again cleared (never dropped or given up)', async () => {
  const rejected = [];
  const { sb, sync, states } = setup(undefined, { onRejected: (list) => rejected.push(list) });
  const gone = (col) => (call) => call.rows.some((r) => r[col] === 'gone');
  sb.failures.push(
    { ...fkError('invoices', 'plan_id', 'gone', 'billing_plans'), match: gone('plan_id') },
    { ...fkError('todos', 'routine_id', 'gone', 'routines'), match: gone('routine_id') },
  );
  sync.queue([
    up('invoices', 'i1', { id: 'i1', client_id: 'c1', number: 'INV-1001', status: 'Approved', plan_id: 'gone' }),
    up('todos', 't1', { id: 't1', assignee_id: 'u1', title: 'Post', done: true, routine_id: 'gone' }),
  ]);
  await tick(400);
  assert.equal(sync.isPending('invoices', 'i1'), true, 'kept');
  assert.equal(sync.isPending('todos', 't1'), true, 'kept');
  await tick(400);
  const sent = (table) => sb.calls.filter((c) => c.table === table).map((c) => c.rows[0]);
  assert.deepEqual(sent('invoices'), [
    { id: 'i1', client_id: 'c1', number: 'INV-1001', status: 'Approved', plan_id: 'gone' },
    { id: 'i1', client_id: 'c1', number: 'INV-1001', status: 'Approved', plan_id: null },
  ]);
  assert.deepEqual(sent('todos').map((r) => [r.routine_id, r.done]), [['gone', true], [null, true]]);
  assert.equal(sync.hasPending(), false);
  assert.equal(rejected.length, 0);
  assert.deepEqual(states(), ['saving', 'saved'], 'never an error');
  assert.equal(sync.staleEcho('invoices', 'i1', sent('invoices')[1]), false, 'its echo is applied, clearing the link in the store');
  sync.dispose();
});

await check('sync: a missing parent is told from another foreign key by the key PostgREST names', async () => {
  const rejected = [];
  const { sb, sync } = setup(undefined, { onRejected: (list) => rejected.push(list) });
  sb.failures.push(
    fkError('subtasks', 'item_id', 'it-gone', 'items'),
    fkError('items', 'group_id, board_key', 'g-gone, projects', 'board_groups'),
    fkError('client_notes', 'user_id', 'u-gone', 'profiles'),
  );
  sync.queue([
    up('subtasks', 'st-1', { id: 'st-1', item_id: 'it-gone', position: 0, text: 'x', done: false }),
    up('items', 'it-1', { id: 'it-1', board_key: 'projects', group_id: 'g-gone', position: 0, name: 'x', values: {}, done: false }),
    up('client_notes', 'n1', { id: 'n1', client_id: 'c1', user_id: 'u-gone', text: 'x' }),
  ]);
  await tick(400);
  assert.equal(sync.isPending('subtasks', 'st-1'), false, 'parent item deleted elsewhere: dropped');
  assert.equal(sync.isPending('items', 'it-1'), false, 'parent group deleted elsewhere (key with the board): dropped');
  assert.equal(sync.isPending('client_notes', 'n1'), true, 'not about its client: kept');
  await tick(2000);
  await tick(5000);
  assert.equal(sb.calls.filter((c) => c.table === 'client_notes').length, 3);
  assert.deepEqual(rejected.flat().map((r) => [r.table, r.key]), [['client_notes', 'n1']], 'given up like any refused row');
  sync.dispose();
});

await check('sync: a group or task whose board was deleted elsewhere is dropped (0006 foreign keys)', async () => {
  const { sb, sync, statuses } = setup();
  sb.failures.push(
    fkError('board_groups', 'board_id, board_key', 'b-gone, projects', 'boards'),
    fkError('items', 'group_id, board_id', 'g-gone, b-1', 'board_groups'),
  );
  sync.queue([
    up('board_groups', 'g-1', { id: 'g-1', board_key: 'projects', board_id: 'b-gone', name: 'Active', color: '', position: 0 }),
    up('items', 'it-1', { id: 'it-1', board_key: 'projects', board_id: 'b-1', group_id: 'g-gone', position: 0, name: 'x', values: {}, done: false }),
    del('subtasks', 'st-old'),
  ]);
  await tick(400);
  assert.deepEqual(seq(sb), ['upsert board_groups', 'upsert items', 'delete subtasks'], 'deletes not held back');
  assert.equal(sync.hasPending(), false);
  assert.equal(statuses.at(-1).state, 'saved');
  await tick(60000);
  assert.equal(sb.calls.length, 3, 'never retried');
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
  boardOf(s, 'b-web').groups[0].items.shift();
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
    boards: [{ id: 'b1', module: 'projects', name: 'Landing Page', owner_id: null, position: 0, updated_at: 'x', updated_by: 'u1' }],
    board_groups: [{ id: 'g1', board_key: 'projects', board_id: 'b1', name: 'Active', color: '#c9ffe6', position: 0, updated_at: 'x', updated_by: 'u1' }],
    items: [{
      id: 'it1', board_key: 'projects', board_id: 'b1', group_id: 'g1', position: 0, name: 'X', values: { b: 1, a: 2 }, done: false,
      updated_at: 'x', updated_by: 'u1',
    }],
    channel_members: [{ channel_id: 'c1', user_id: 'u1', updated_at: 'x', updated_by: 'u1' }],
    channels: [{ id: 'c1', name: 'general', created_by: 'u1', updated_at: 'x', updated_by: 'u1' }],
    deals: [{ id: 'd1', name: 'D', sector: 'S', priority: 'P1', stage: 'Won', next_step: '', value: '1200.50', owner_id: null, client_id: null, position: 0 }],
    messages,
  });
  const rows = await sync.loadAll();
  assert.deepEqual(Object.keys(rows), TABLES.map((x) => x.name));
  assert.deepEqual(rows.boards.get('b1'), { id: 'b1', module: 'projects', name: 'Landing Page', owner_id: null, position: 0, calendar: false });
  assert.deepEqual(rows.items.get('it1'), {
    id: 'it1', board_key: 'projects', board_id: 'b1', group_id: 'g1', position: 0, name: 'X', values: { b: 1, a: 2 }, done: false,
  });
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
  assert.deepEqual(assemble(rows, { me: 'u1' }).boards.map((b) => [b.id, b.name, b.owner, b.groups[0].items[0].id]), [['b1', 'Landing Page', '', 'it1']]);
  sync.dispose();
});

// A release that gets ahead of its migration (the live 0012 outage: "Could not find the table 'public.crm_entries' in
// the schema cache") loses that feature, not the workspace.
const NOT_FOUND = { code: 'PGRST205', message: "Could not find the table 'public.crm_entries' in the schema cache" };
await check('sync: a table whose migration hasn’t run (TABLES since) is left out — no rows, no realtime, no writes — and the rest loads', async () => {
  assert.deepEqual(TABLES.filter((t) => t.since).map((t) => [t.name, t.since]), [['crm_entries', '0012_crm_profile.sql']]);
  const { sb, sync } = setup({ deals: [{ id: 'd1', name: 'D', value: 0, position: 0 }] });
  sb.failures.push({ table: 'crm_entries', method: 'select', ...NOT_FOUND, sticky: true });
  assert.deepEqual(await sync.probe(), ['crm_entries']);
  assert.deepEqual(sb.calls.map((c) => [c.table, c.columns, c.range]), [['crm_entries', 'id', [0, 0]]], 'one small select per since table');
  sync.subscribe(() => {});
  const tables = sb.channels.at(-1).handlers.map((h) => h.filter.table);
  assert.ok(!tables.includes('crm_entries') && tables.includes('deals') && tables.length === TABLES.length - 1, 'left out of realtime');
  const rows = await sync.loadAll();
  assert.equal(rows.crm_entries.size, 0);
  assert.equal(rows.deals.size, 1);
  assert.equal(sb.calls.filter((c) => c.table === 'crm_entries').length, 1, 'not loaded');
  sync.queue([up('crm_entries', 'e1'), up('deals', 'd2')]);
  sync.queue([del('crm_entries', 'e2')]);
  await sync.flush();
  assert.deepEqual(sb.calls.filter((c) => c.method !== 'select').map((c) => `${c.method} ${c.table}`), ['upsert deals'], 'no writes to it');
  assert.deepEqual([sync.missing(), sync.hasPending()], [['crm_entries'], false]);
  sync.dispose();
});

await check('sync: a since table found missing during a load (no probe, or it came back unsure) loads as no rows; a probe that finds it there forgets it', async () => {
  const { sb, sync } = setup({ crm_entries: [{ id: 'e1', kind: 'note', body: 'x' }] });
  sb.failures.push({ table: 'crm_entries', method: 'select', code: '42P01', message: 'relation "public.crm_entries" does not exist' });
  const rows = await sync.loadAll();
  assert.deepEqual([rows.crm_entries.size, sync.missing()], [0, ['crm_entries']]);
  assert.deepEqual(await sync.probe(), [], 'its migration has run since');
  assert.equal((await sync.loadAll()).crm_entries.size, 1);
  sync.dispose();
});

await check('sync: a core table that is missing, or a since table failing for any other reason, still fails the load', async () => {
  const core = setup();
  core.sb.failures.push({ table: 'deals', method: 'select', ...NOT_FOUND, message: "Could not find the table 'public.deals' in the schema cache", sticky: true });
  assert.deepEqual(await core.sync.probe(), [], 'only since tables are probed');
  await assert.rejects(core.sync.loadAll(), /Loading deals failed/);
  core.sync.dispose();
  const other = setup();
  other.sb.failures.push({ table: 'crm_entries', method: 'select', code: '42501', message: 'permission denied for table crm_entries', sticky: true });
  assert.deepEqual(await other.sync.probe(), [], 'not "not found": left to the load');
  await assert.rejects(other.sync.loadAll(), /Loading crm_entries failed: permission denied/);
  other.sync.dispose();
  const column = setup();
  column.sb.failures.push({ table: 'crm_entries', method: 'select', code: '42703', message: 'column crm_entries.kind does not exist', sticky: true });
  assert.deepEqual(await column.sync.probe(), [], 'a missing column isn’t a missing table');
  column.sync.dispose();
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

await check('sync: module_access upserts on (user_id, module) and deletes by both', async () => {
  const { sb, sync } = setup();
  sync.queue([
    up('module_access', 'u1:outreach', { user_id: 'u1', module: 'outreach', level: 'view' }),
    del('module_access', 'u2:pipeline', { user_id: 'u2', module: 'pipeline', level: 'edit' }),
    del('module_access', 'u2:clients', { user_id: 'u2', module: 'clients', level: 'none' }),
  ]);
  await sync.flush();
  const call = (method) => sb.calls.find((c) => c.method === method && c.table === 'module_access');
  assert.deepEqual(call('upsert').options, { onConflict: 'user_id,module', ignoreDuplicates: false });
  assert.deepEqual(call('delete').filters, [['eq', 'user_id', 'u2'], ['in', 'module', ['pipeline', 'clients']]]);
  sync.dispose();
});

await check('sync: phase 2 tables are written parents first', async () => {
  const order = TABLES.map((t) => t.name);
  [['deals', 'contacts'], ['invoices', 'billing_plans'], ['billing_plans', 'clients'], ['client_usage', 'clients'], ['payments', 'invoices'],
    ['payments', 'bank_statements'], ['expenses', 'clients'], ['todos', 'routines'], ['todos', 'profiles'], ['routines', 'profiles'],
    ['time_entries', 'profiles'], ['module_access', 'profiles'], ['contacts', 'profiles'], ['boards', 'profiles'], ['board_groups', 'boards'],
    ['items', 'board_groups'], ['outreach_mailboxes', 'profiles'], ['outreach_notes', 'outreach_mailboxes'], ['outreach_notes', 'profiles']]
    .forEach(([child, parent]) => assert.ok(order.indexOf(parent) < order.indexOf(child), `${parent} before ${child}`));
  const { sb, sync } = setup();
  const names = ['todos', 'routines', 'payments', 'bank_statements', 'invoices', 'billing_plans', 'deals', 'contacts', 'client_usage', 'clients'];
  sync.queue(names.map((t) => up(t, `${t}-1`)));
  await sync.flush();
  assert.deepEqual(seq(sb), ['upsert clients', 'upsert contacts', 'upsert deals', 'upsert billing_plans', 'upsert invoices',
    'upsert client_usage', 'upsert bank_statements', 'upsert payments', 'upsert routines', 'upsert todos']);
  sync.dispose();
});

await check('sync: removing a mailbox sends its notes\' delete before the mailbox\'s; the sheet\'s link is an update of row 1, '
  + 'and a settings row that vanished from state is never deleted (0007)', async () => {
  const removed = structuredClone(base);
  removed.mailboxes = removed.mailboxes.filter((m) => m.id !== 'mb-1');
  removed.outreachNotes = removed.outreachNotes.filter((n) => n.mailbox !== 'mb-1');
  const a = setup();
  a.sync.queue(diff(rows0, flatten(removed)));
  await a.sync.flush();
  assert.deepEqual(seq(a.sb), ['upsert outreach_mailboxes', 'delete outreach_notes', 'delete outreach_mailboxes']);
  assert.deepEqual(a.sb.calls.filter((c) => c.method === 'delete').map((c) => c.filters), [[['in', 'id', ['on-2']]], [['in', 'id', ['mb-1']]]]);
  a.sync.dispose();

  const b = setup();
  b.sync.queue(diff(rows0, flatten({ ...structuredClone(base), outreachSheet: 'https://docs.google.com/spreadsheets/d/1AnotherExampleSheetId0123456/edit' })));
  await b.sync.flush();
  assert.deepEqual(b.sb.calls.map((c) => [c.method, c.table, c.patch, c.filters]), [
    ['update', 'outreach_settings', { sheet_url: 'https://docs.google.com/spreadsheets/d/1AnotherExampleSheetId0123456/edit' }, [['eq', 'id', 1]]],
  ]);
  b.sync.dispose();

  const c = setup();
  const lost = structuredClone(base);
  delete lost.outreachSheet;
  c.sync.queue(diff(rows0, flatten(lost)));
  await c.sync.flush();
  assert.deepEqual(c.sb.calls, []);
  c.sync.dispose();
});

globalThis.setTimeout = realTimers.setTimeout;
globalThis.clearTimeout = realTimers.clearTimeout;

// ── (d) Access, demo automations, seed and migration ──────────────────────────

const access = await import('../src/lib/access.js');
const auto = await import('../src/lib/automations.js');
const boardsLib = await import('../src/lib/boards.js');

const person = (id, role, active = true) => ({ id, name: id, initials: id.slice(0, 2).toUpperCase(), color: '#579bfc', email: `${id}@example.com`, role, active });
const team = () => ({
  me: 'sue',
  users: [person('sue', 'superadmin'), person('al', 'admin'), person('stu', 'staff'), person('mem', 'member'), person('off', 'staff', false),
    person('ex', 'superadmin', false)],
  moduleAccess: [
    { userId: 'stu', module: 'outreach', level: 'edit' }, { userId: 'stu', module: 'pipeline', level: 'none' },
    { userId: 'stu', module: 'clients', level: 'bogus' }, { userId: 'al', module: 'clients', level: 'none' },
  ],
});

await check('access: modules, staff defaults and roles', () => {
  assert.deepEqual(access.MODULES, ['projects', 'marketing', 'outreach', 'pipeline', 'clients']);
  // 0006: staff edit Projects again (0003 had made it view).
  assert.deepEqual(access.STAFF_DEFAULTS, { projects: 'edit', marketing: 'edit', outreach: 'none', pipeline: 'view', clients: 'view' });
  const st = team();
  assert.deepEqual(['sue', 'al', 'stu', 'mem', 'nobody'].map((u) => access.roleOf(st, u)), ['superadmin', 'admin', 'staff', 'staff', '']);
  assert.equal(access.roleOf(st), 'superadmin', 'defaults to me');
  assert.deepEqual(['superadmin', 'admin', 'staff', 'member', ''].map(access.isAdminRole), [true, true, false, false, false]);
  assert.deepEqual(['sue', 'al', 'stu', 'ex'].map((u) => access.isSuperadmin(st, u)), [true, false, false, false]);
  assert.deepEqual(['sue', 'al', 'stu', 'ex'].map((u) => access.isAdmin(st, u)), [true, true, false, false]);
  assert.equal(access.isSuperadmin(st), true);
});

await check('access: effective module level (admins edit, staff override else default, inactive none)', () => {
  const st = team();
  const levels = (u) => access.MODULES.map((m) => access.moduleLevel(st, m, u));
  assert.deepEqual(levels('sue'), ['edit', 'edit', 'edit', 'edit', 'edit']);
  assert.deepEqual(levels('al'), ['edit', 'edit', 'edit', 'edit', 'edit'], 'overrides never apply to admins');
  assert.deepEqual(levels('mem'), ['edit', 'edit', 'none', 'view', 'view'], 'phase 1 member gets the staff defaults');
  assert.deepEqual(levels('stu'), ['edit', 'edit', 'edit', 'none', 'view'], 'overrides; an invalid level is ignored');
  assert.deepEqual(levels('off'), ['none', 'none', 'none', 'none', 'none']);
  assert.deepEqual(levels('ex'), ['none', 'none', 'none', 'none', 'none']);
  assert.equal(access.moduleLevel(st, 'projects', 'nobody'), 'none');
  assert.equal(access.moduleLevel(st, 'settings'), 'none');
  assert.equal(access.moduleLevel(st, 'outreach'), 'edit', 'defaults to me');
  assert.deepEqual([access.canView(st, 'pipeline', 'mem'), access.canEdit(st, 'pipeline', 'mem')], [true, false]);
  assert.deepEqual([access.canView(st, 'pipeline', 'stu'), access.canEdit(st, 'outreach', 'stu')], [false, true]);
  assert.deepEqual([access.canView({ ...st, moduleAccess: undefined }, 'clients', 'stu')], [true]);
});

// The staff defaults live in the newest migration that (re)defines public.module_level().
const migrationsDir = new URL('../supabase/migrations/', import.meta.url);
const levelsSql = existsSync(migrationsDir) && readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => [f, readFileSync(new URL(f, migrationsDir), 'utf8')]).filter(([, sql]) => sql.includes('function public.module_level')).at(-1);
if (levelsSql) {
  await check(`access: STAFF_DEFAULTS match public.module_level() in ${levelsSql[0]}`, () => {
    const sql = levelsSql[1];
    const fn = sql.slice(sql.indexOf('function public.module_level'));
    const body = fn.slice(0, fn.indexOf('$$;'));
    const pairs = Object.fromEntries([...body.matchAll(/when '(\w+)' then '(\w+)'/g)].map((m) => [m[1], m[2]]));
    assert.ok(Object.keys(pairs).length, 'module_level defaults not found');
    const expected = Object.fromEntries(Object.entries(access.STAFF_DEFAULTS).filter(([, level]) => level !== 'none'));
    assert.deepEqual(pairs, expected); // anything else falls through to 'none'
  });
}

// ── Boards (0006): pure helpers, board access, seed and migration ─────────────

// Users for the board access rules: the SuperAdmin, two admins, two staff and an inactive staff member.
const crew = (moduleAccess = []) => ({
  me: 'sue',
  users: [person('sue', 'superadmin'), person('al', 'admin'), person('ann', 'admin'), person('stu', 'staff'), person('sam', 'staff'),
    person('off', 'staff', false)],
  moduleAccess,
});
const teamBoard = (module) => ({ id: `t-${module}`, module, name: 'Team', owner: '', groups: [] });
const ownPage = (owner) => ({ id: `p-${owner}`, module: 'projects', name: '', owner, groups: [] });

await check('access: whose own Projects page each person may open (seesPerson ⇄ sees_person in 0006)', () => {
  const st = crew();
  const ids = st.users.map((u) => u.id);
  const sees = (viewer) => ids.filter((owner) => access.seesPerson(st, owner, viewer));
  assert.deepEqual(sees('sue'), ids, "the SuperAdmin sees everyone's");
  assert.deepEqual(sees('al'), ['al', 'stu', 'sam', 'off'], "an admin: their own and staff's, not another admin's or the SuperAdmin's");
  assert.deepEqual(sees('ann'), ['ann', 'stu', 'sam', 'off']);
  assert.deepEqual(sees('stu'), ['stu'], 'staff: only their own');
  assert.deepEqual(sees('off'), [], 'an inactive user: nothing, not even their own');
  assert.deepEqual(sees('nobody'), []);
  assert.equal(access.seesPerson(st, 'stu'), true, 'defaults to me');
  assert.equal(access.seesPerson({ ...st, me: 'stu' }, 'sam'), false);
  assert.deepEqual(['', undefined, null].map((owner) => access.seesPerson(st, owner, 'sue')), [false, false, false], 'no owner');
});

await check('access: board levels — team boards follow the module, own pages are edit for whoever may open them (boardLevel ⇄ board_level)', () => {
  const st = crew();
  const level = (board, u, s = st) => access.boardLevel(s, board, u);
  // Team boards: the module's level (staff default: Projects and Marketing edit, 0006); admins edit; inactive none.
  assert.deepEqual(['sue', 'al', 'stu', 'off', 'nobody'].map((u) => [level(teamBoard('projects'), u), level(teamBoard('marketing'), u)]),
    [['edit', 'edit'], ['edit', 'edit'], ['edit', 'edit'], ['none', 'none'], ['none', 'none']]);
  // Overrides are honoured for staff, never for admins.
  const over = crew([
    { userId: 'stu', module: 'projects', level: 'view' }, { userId: 'stu', module: 'marketing', level: 'none' },
    { userId: 'sam', module: 'marketing', level: 'view' }, { userId: 'al', module: 'marketing', level: 'none' },
  ]);
  assert.deepEqual([['stu', 'projects'], ['stu', 'marketing'], ['sam', 'marketing'], ['al', 'marketing']].map(([u, m]) => level(teamBoard(m), u, over)),
    ['view', 'none', 'view', 'edit']);
  // … and their own page stays editable with Projects at view.
  assert.equal(level(ownPage('stu'), 'stu', over), 'edit');
  // Own pages: edit for whoever may open them, else none.
  assert.deepEqual(['sue', 'al', 'ann', 'stu', 'sam', 'off'].map((u) => level(ownPage('stu'), u)), ['edit', 'edit', 'edit', 'edit', 'none', 'none']);
  assert.deepEqual(['sue', 'al', 'ann', 'stu'].map((u) => level(ownPage('al'), u)), ['edit', 'edit', 'none', 'none']);
  assert.deepEqual(['sue', 'al', 'stu'].map((u) => level(ownPage('sue'), u)), ['edit', 'none', 'none']);
  assert.equal(level(ownPage('off'), 'off'), 'none');
  // … but none for someone whose Projects is none, even their own; their admins still edit it.
  const hidden = crew([{ userId: 'stu', module: 'projects', level: 'none' }]);
  assert.deepEqual(['stu', 'al', 'sue'].map((u) => level(ownPage('stu'), u, hidden)), ['none', 'edit', 'edit']);
  // Unknown modules and missing boards are none.
  assert.deepEqual([null, undefined, { ...teamBoard('projects'), module: 'admin' }, { ...ownPage('sue'), module: 'settings' }].map((b) => level(b, 'sue')),
    ['none', 'none', 'none', 'none']);
  // canViewBoard / canEditBoard, for me by default.
  const asStu = { ...st, me: 'stu' };
  assert.deepEqual([teamBoard('projects'), teamBoard('marketing'), ownPage('stu'), ownPage('sam')]
    .map((b) => [access.canViewBoard(asStu, b), access.canEditBoard(asStu, b)]), [[true, true], [true, true], [true, true], [false, false]]);
  assert.deepEqual([access.canViewBoard(st, ownPage('stu'), 'sam'), access.canEditBoard(st, teamBoard('projects'), 'al')], [false, true]);
});

await check('boards: first names, titles ("Shem’s notes") and links', () => {
  const { boardTitle, firstName, boardHref } = boardsLib;
  assert.deepEqual(['Shem Example', '  David  ', 'Hello', 'Mary-Jane O’Neil', '', '   ', null, undefined].map(firstName),
    ['Shem', 'David', 'Hello', 'Mary-Jane', 'Someone', 'Someone', 'Someone', 'Someone']);
  const st = { users: [{ id: 'shem', name: 'Shem Example' }, { id: 'dv', name: ' David ' }] };
  const shem = boardTitle(st, ownPage('shem'));
  assert.equal(shem, 'Shem’s notes', 'first name only, curly apostrophe');
  assert.ok(!shem.includes("'"));
  assert.equal(boardTitle(st, { ...ownPage('dv'), name: 'Ignored' }), 'David’s notes', "a personal page's stored name is not its title");
  assert.equal(boardTitle(st, ownPage('gone')), 'Someone’s notes');
  assert.equal(boardTitle(st, { ...teamBoard('projects'), name: '  Landing Page ' }), 'Landing Page');
  assert.equal(boardTitle(st, { ...teamBoard('projects'), name: ' ' }), 'Untitled board');
  assert.equal(boardTitle(st, null), '');
  assert.equal(boardHref({ id: 'b1', module: 'projects' }), '#/projects/b1');
  assert.equal(boardHref({ id: 'b2', module: 'marketing' }, 'it 1&x'), '#/marketing/b2?item=it%201%26x');
  assert.equal(boardHref(null), '#/dashboard');
  assert.equal(boardHref(undefined, 'it1'), '#/dashboard');
});

// Projects: my page, Stu's page, two team boards; Marketing: two team boards.
const boardSet = () => {
  const b = (id, module, owner = '', items = []) => ({
    id, module, name: owner ? '' : id, owner, groups: [{ id: `g-${id}`, name: 'Active', color: '', items: items.map((x) => ({ id: x })) }],
  });
  return [b('own', 'projects', 'me', ['it-own']), b('stus', 'projects', 'stu', ['it-stu']), b('web', 'projects', '', ['it-web']), b('gen', 'projects'),
    b('daily', 'marketing', '', ['it-m']), b('post', 'marketing')];
};

await check('boards: a task or group moves only within its audience (sameAudience ⇄ same_audience in 0006)', () => {
  const { sameAudience } = boardsLib;
  const lp = teamBoard('projects');
  const tp = { ...teamBoard('projects'), id: 'tp' };
  const mk = teamBoard('marketing');
  assert.deepEqual([
    [lp, tp], [lp, lp], [ownPage('stu'), ownPage('stu')], // team ⇄ team, one board, one person's page
    [lp, ownPage('stu')], [ownPage('stu'), lp], [ownPage('stu'), ownPage('sam')], [lp, mk], [lp, null], [null, lp],
  ].map(([a, b]) => sameAudience(a, b)), [true, true, true, false, false, false, false, false, false]);
});

await check('boards: withItemPlaced puts a task before another (or at a group’s end), in its group or another; null when nothing changes', () => {
  const { withItemPlaced } = boardsLib;
  const t = (id) => ({ id, name: id, values: {} });
  const groups = () => [{ id: 'a', items: [t('1'), t('2'), t('3')] }, { id: 'b', items: [t('4')] }, { id: 'c', items: [] }];
  const ids = (gs) => gs && gs.map((g) => `${g.id}:${g.items.map((i) => i.id).join('')}`).join(' ');
  assert.equal(ids(withItemPlaced(groups(), '3', 'a', '1')), 'a:312 b:4 c:', 'up');
  assert.equal(ids(withItemPlaced(groups(), '1', 'a', '3')), 'a:213 b:4 c:', 'down, before the last');
  assert.equal(ids(withItemPlaced(groups(), '1', 'a', null)), 'a:231 b:4 c:', 'to the end');
  assert.equal(ids(withItemPlaced(groups(), '2', 'b', '4')), 'a:13 b:24 c:', 'into another group, before a task');
  assert.equal(ids(withItemPlaced(groups(), '2', 'c', null)), 'a:13 b:4 c:2', 'into an empty group');
  assert.equal(ids(withItemPlaced(groups(), '2', 'b', 'gone')), 'a:13 b:42 c:', 'a before-task not in that group: its end');
  // With a filter hiding task 2, a drop below task 1 names the next task in the full order (2): 3 lands between them.
  assert.equal(ids(withItemPlaced(groups(), '3', 'a', '2')), 'a:132 b:4 c:');
  for (const [item, group, before] of [['1', 'a', '2'], ['3', 'a', null], ['1', 'a', '1'], ['x', 'a', null], ['1', 'zz', null]]) {
    assert.equal(withItemPlaced(groups(), item, group, before), null, `${item} → ${group} before ${before}`);
  }
  const g = groups();
  const out = withItemPlaced(g, '3', 'a', '1');
  assert.equal(out[0].items[0], g[0].items[2], 'the task object itself moves');
  assert.equal(ids(g), 'a:123 b:4 c:', 'the groups passed in are left as they were');
  assert.equal(out[1], g[1], 'a group not involved is the same object');
  assert.equal(withItemPlaced(null, '1', 'a', null), null);
});

await check('boards: sortedItems — Sort by due date (soonest first, no date last, ties by priority) or by priority (High first, ties '
  + 'by due); tasks that tie keep their order', () => {
  const { sortedItems } = boardsLib;
  const P = ['High', 'Medium', 'Low'];
  const t = (id, due, priority) => ({ id, values: { due, priority } });
  const list = [t('a', '', 'Low'), t('b', '2026-11-02', ''), t('c', '2026-10-30', 'High'), t('d', '2026-10-30', 'Medium'),
    t('e', '', 'High'), t('f', 'not a date', ''), t('g', '2026-10-30T00:00:00Z', 'Medium')];
  const ids = (l) => l.map((i) => i.id).join('');
  const before = ids(list);
  assert.equal(ids(sortedItems(list, 'due', { priorities: P })), 'cdgbeaf');
  assert.equal(ids(sortedItems(list, 'priority', { priorities: P })), 'cedgabf');
  assert.equal(ids(list), before, 'the list passed in is left as it was');
  assert.equal(ids(sortedItems([t('x', '', 'Urgent'), t('y', '', ''), t('z', '', 'Low')], 'priority', { priorities: P })), 'zxy',
    'a value that isn’t one of the priorities sorts as none');
  assert.equal(ids(sortedItems(list, 'priority')), ids(sortedItems(list, 'due')), 'no priorities: by due alone');
  const same = [t('p', '2026-10-30', 'High'), t('q', '2026-10-30', 'High'), t('r', '2026-10-30', 'High')];
  assert.equal(ids(sortedItems(same, 'due', { priorities: P })), 'pqr');
  assert.equal(ids(sortedItems([{ id: 'm', values: { when: '2026-12-01' } }, { id: 'n', values: { when: '2026-11-01' } }], 'due', { dateKey: 'when' })), 'nm');
  assert.deepEqual([sortedItems(null, 'due'), sortedItems([], 'priority')], [[], []]);
});

await check('boards: lookups (findBoard, personalBoard, teamBoards, boardOfItem, boardItems)', () => {
  const { findBoard, personalBoard, teamBoards, boardOfItem, boardItems } = boardsLib;
  const st = { me: 'me', boards: boardSet() };
  assert.equal(findBoard(st, 'gen')?.id, 'gen');
  assert.deepEqual([findBoard(st, 'nope'), findBoard({}, 'gen'), findBoard(null, 'gen')], [undefined, undefined, undefined]);
  assert.equal(personalBoard(st, 'stu')?.id, 'stus');
  assert.equal(personalBoard(st, 'nobody'), undefined);
  assert.deepEqual(teamBoards(st, 'projects').map((x) => x.id), ['web', 'gen']);
  assert.deepEqual(teamBoards(st, 'marketing').map((x) => x.id), ['daily', 'post']);
  assert.equal(boardOfItem(st, 'it-m')?.id, 'daily');
  assert.equal(boardOfItem(st, 'nope'), undefined);
  assert.deepEqual(boardItems(st.boards[0]).map((x) => x.id), ['it-own']);
  assert.deepEqual([boardItems(undefined), boardItems({})], [[], []]);
});

await check('boards: resolveBoard — the addressed board, else the one holding the task, else the module default', () => {
  const { resolveBoard } = boardsLib;
  const all = boardSet();
  const st = { me: 'me', boards: all };
  const at = (visible, module, sub = '', itemId = '') => resolveBoard(st, visible, module, sub, itemId)?.id ?? null;
  assert.equal(at(all, 'projects', 'gen'), 'gen', 'by sub');
  assert.equal(at(all, 'projects', '', 'it-web'), 'web', 'by task id (old #/projects?item= links)');
  assert.equal(at(all, 'projects', 'gen', 'it-web'), 'gen', 'the sub wins');
  assert.equal(at(all, 'projects'), 'web', 'Projects: its first team board (team work first)');
  assert.equal(at(all, 'marketing'), 'daily', 'Marketing: its first team board');
  assert.equal(at(all, 'marketing', 'gen', 'it-web'), 'daily', 'a board or task of another module is not shown here');
  const visible = all.filter((x) => x.id !== 'stus');
  assert.equal(at(visible, 'projects', 'stus'), 'web', 'a sub you cannot see falls back');
  assert.equal(at(visible, 'projects', '', 'it-stu'), 'web', 'so does a task on a board you cannot see');
  assert.equal(at([all[1], all[0]], 'projects'), 'own', 'no team board you can see: your own page, wherever it sits');
  assert.equal(at(all.filter((x) => x.id !== 'own'), 'projects'), 'web', 'no own page: the first team board');
  assert.equal(at([all[1]], 'projects'), 'stus', "only someone else's page: that one");
  assert.equal(at([], 'projects'), null);
  assert.equal(at(all.filter((x) => x.module === 'projects'), 'marketing'), null, 'nothing visible in the module');
  // Outreach and Clients open on their own page (MODULE_HOMES): no default board, only a named one or a task's.
  const homes = [
    { id: 'sales', module: 'outreach', name: 'Sales Tasks', owner: '', groups: [{ id: 'g-s', items: [{ id: 'it-s' }] }] },
    { id: 'demos', module: 'clients', name: 'Demos', owner: '', groups: [] },
  ];
  assert.deepEqual(Object.keys(boardsLib.MODULE_HOMES), ['outreach', 'clients']);
  assert.deepEqual(Object.values(boardsLib.MODULE_HOMES).map((h) => [h.href, new Set(Object.values(boardsLib.MODULE_HOMES).map((x) => x.id)).size]),
    [['#/outreach', 2], ['#/clients', 2]], 'their own addresses; menu ids unique');
  assert.equal(at(homes, 'outreach'), null, '#/outreach is the email dashboard');
  assert.equal(at(homes, 'clients'), null, '#/clients is the client list');
  assert.equal(at(homes, 'outreach', 'sales'), 'sales');
  assert.equal(at(homes, 'clients', 'nope'), null, 'a board that is gone: back to the page');
  assert.equal(at(homes, 'outreach', '', 'it-s'), 'sales', 'a task link still finds its board');
});

// ── Owners and priorities (docs/PHASE2.md §17): src/lib/work.js ──────────────────
const work = await import('../src/lib/work.js');
const { BOARD_SCHEMAS: SCHEMAS, PRIORITY: PRIO, PRIORITY_HINTS } = await import('../src/data/boards.js');

await check('owners: Projects, Marketing, Outreach and Clients boards have one Owner and Priority (Urgent → Low, each with a meaning); Work in Progress keeps its people', () => {
  const cols = (m) => SCHEMAS[m].columns.map((c) => `${c.key}:${c.type}`).join(' ');
  assert.equal(cols('projects'), 'people:owner status:status priority:label due:date');
  assert.equal(cols('outreach'), 'deal:deal people:owner status:status priority:label due:date', 'Outreach boards link a task to its deal');
  assert.equal(cols('clients'), 'client:client people:owner status:status priority:label due:date', 'Clients boards say which client');
  assert.equal(cols('marketing'), 'people:owner status:status priority:label type:label channel:label approval:label due:date');
  assert.equal(cols('pipeline'), 'details:text status:status people:people');
  assert.deepEqual(Object.keys(PRIO), ['Urgent', 'High', 'Medium', 'Low']);
  assert.deepEqual(Object.keys(PRIORITY_HINTS), Object.keys(PRIO), 'every priority says what it means');
  ['projects', 'marketing', 'outreach', 'clients'].forEach((m) => {
    const p = SCHEMAS[m].columns.find((c) => c.key === 'priority');
    assert.equal(p.options, PRIO, m);
    assert.equal(p.hints, PRIORITY_HINTS, m);
    assert.equal(SCHEMAS[m].columns.find((c) => c.type === 'owner').label, 'Owner', m);
    assert.equal(work.hasOwner({ module: m }), true, m);
  });
  assert.deepEqual([work.hasOwner({ module: 'pipeline' }), work.hasOwner({ module: 'admin' }), work.hasOwner(null)], [false, false, false]);
  // Sort → Priority puts Urgent first (the store passes PRIORITY's order).
  const t = (id, priority) => ({ id, values: { priority } });
  assert.equal(boardsLib.sortedItems([t('l', 'Low'), t('n', ''), t('u', 'Urgent'), t('h', 'High')], 'priority', { priorities: Object.keys(PRIO) })
    .map((i) => i.id).join(''), 'uhln');
});

await check('owners: nextValues — picking an owner sets people to them; handing it to someone else records who and when; taking it or clearing it forgets that', () => {
  const now = '2026-10-25T01:00:00.000Z';
  const base = { people: ['ana'], status: 'In progress', priority: 'High' };
  assert.deepEqual(work.nextValues(base, { owner: 'ben' }, { me: 'ana', now }),
    { people: ['ben'], status: 'In progress', priority: 'High', assignedBy: 'ana', assignedAt: now }, 'handed to Ben by Ana');
  const handed = work.nextValues(base, { owner: 'ben' }, { me: 'ana', now });
  assert.deepEqual(work.nextValues(handed, { status: 'Done' }, { me: 'ben', now: 'later' }), { ...handed, status: 'Done', acceptedAt: 'later' },
    'other edits keep it (and the owner changing its status accepts it)');
  assert.deepEqual(work.nextValues(handed, { owner: 'ben' }, { me: 'cat', now: 'later' }), handed, 'the same owner again changes nothing');
  assert.deepEqual(work.nextValues(handed, { owner: 'cat' }, { me: 'cat', now }), { people: ['cat'], status: 'In progress', priority: 'High' },
    'taking it yourself: not New');
  assert.deepEqual(work.nextValues(handed, { owner: '' }, { me: 'ana', now }), { people: [], status: 'In progress', priority: 'High' }, 'cleared');
  // A task with several people: picking one of them (even the first) makes them the only owner.
  assert.deepEqual(work.nextValues({ people: ['ana', 'ben'] }, { owner: 'ana' }, { me: 'ben', now }), { people: ['ana'] }, 'the first: no hand-over');
  assert.deepEqual(work.nextValues({ people: ['ana', 'ben'] }, { owner: 'ben' }, { me: 'ana', now }), { people: ['ben'], assignedBy: 'ana', assignedAt: now });
  // A people list (Work in Progress' Contact) follows the same rule on its first person; Phase 1's owner key still works.
  assert.deepEqual(work.nextValues({ people: [] }, { people: ['ben', 'cat'] }, { me: 'ana', now }), { people: ['ben', 'cat'], assignedBy: 'ana', assignedAt: now });
  assert.deepEqual(work.nextValues({ owner: 'ana' }, { priority: 'Low' }, { me: 'ana', now }), { people: ['ana'], priority: 'Low' });
  // Only the store sets them: a patch can't.
  assert.deepEqual(work.nextValues(base, { assignedBy: 'zed', assignedAt: 'x', due: '2026-11-01' }, { me: 'ana', now }), { ...base, due: '2026-11-01' });
  assert.deepEqual(work.nextValues(undefined, { owner: 'ana' }, { me: 'ana', now }), { people: ['ana'] });
  assert.deepEqual([work.ownerOf({ values: { people: ['b', 'c'] } }), work.ownerOf({ values: { people: [] } }), work.ownerOf({}), work.ownerOf(null)],
    ['b', '', '', '']);
});

await check('accept: a task handed to someone waits on them until they accept it or start it; a new owner waits again; a patch can’t set it', () => {
  const now = '2026-10-25T01:00:00.000Z';
  const handed = work.nextValues({ people: ['ana'], status: 'Not started' }, { owner: 'ben' }, { me: 'ana', now });
  assert.equal(work.isWaiting({ values: handed }), true);
  // Ben accepts.
  const ok = work.acceptedValues(handed, { me: 'ben', now: 'later' });
  assert.deepEqual(ok, { ...handed, acceptedAt: 'later' });
  assert.equal(work.isWaiting({ values: ok }), false);
  // Only the owner accepts, and only a waiting task.
  assert.deepEqual([work.acceptedValues(handed, { me: 'ana' }), work.acceptedValues(ok, { me: 'ben' }), work.acceptedValues({ people: ['ben'] }, { me: 'ben' })],
    [null, null, null]);
  // Starting it (any status change by the owner) accepts it; someone else changing it doesn't.
  assert.equal(work.nextValues(handed, { status: 'In progress' }, { me: 'ben', now: 'start' }).acceptedAt, 'start');
  assert.equal(work.isWaiting({ values: work.nextValues(handed, { status: 'In progress' }, { me: 'ana', now }) }), true);
  assert.equal(work.isWaiting({ values: work.nextValues(handed, { priority: 'Low' }, { me: 'ben', now }) }), true, 'a priority change is not starting it');
  // Handed on to Cat: waits on Cat; taken back by Ana: nothing waits.
  const toCat = work.nextValues(ok, { owner: 'cat' }, { me: 'ben', now: 'cat' });
  assert.deepEqual([toCat.assignedBy, toCat.assignedAt, 'acceptedAt' in toCat, work.isWaiting({ values: toCat })], ['ben', 'cat', false, true]);
  const back = work.nextValues(toCat, { owner: 'ana' }, { me: 'ana', now });
  assert.deepEqual([back.assignedBy, back.acceptedAt, work.isWaiting({ values: back })], [undefined, undefined, false]);
  // A patch can't accept or hand over by itself.
  assert.equal(work.nextValues(handed, { acceptedAt: 'x', assignedBy: 'zed' }, { me: 'ana', now }).acceptedAt, undefined);
  assert.equal(work.nextValues(handed, { acceptedAt: 'x' }, { me: 'ana', now }).assignedBy, 'ana');
  // Someone else on a task that still has several people never waits; a task with no owner neither.
  assert.deepEqual([work.isWaiting({ values: { people: [], assignedBy: 'ana' } }), work.isWaiting({ values: { people: ['ana'], assignedBy: 'ana' } }), work.isWaiting(null)],
    [false, false, false]);
});

await check('new task: starts Not started with you as owner; made for someone else it waits on them; values as an edit', () => {
  const now = '2026-10-25T01:00:00.000Z';
  assert.deepEqual(work.newTaskValues({}, { me: 'ana', now }), { status: 'Not started', people: ['ana'] });
  assert.deepEqual(work.newTaskValues({ owner: 'ben', priority: 'High', due: '2026-10-30', client: 'c-1' }, { me: 'ana', now }),
    { status: 'Not started', people: ['ben'], priority: 'High', due: '2026-10-30', client: 'c-1', assignedBy: 'ana', assignedAt: now });
  assert.deepEqual(work.newTaskValues({ owner: '' }, { me: 'ana', now }), { status: 'Not started', people: [] });
  assert.deepEqual(work.newTaskValues({ owner: 'ana', status: 'In progress' }, { me: 'ana', now }), { status: 'In progress', people: ['ana'] });
  assert.equal(work.newTaskValues({ owner: 'ben', acceptedAt: 'x' }, { me: 'ana', now }).acceptedAt, undefined);
});

await check('where a task lives: department (Operations for Projects) › board › client; a personal page is its notes', () => {
  const { MODULE_LABELS } = boardsLib;
  assert.deepEqual(MODULE_LABELS, { projects: 'Operations', marketing: 'Marketing', outreach: 'Outreach', clients: 'Clients', pipeline: 'Pipeline' });
  const st = { users: [{ id: 'dv', name: 'David' }], clients: [{ id: 'c-1', name: 'Example Council' }] };
  const it = (values = {}) => ({ id: 'i', values });
  assert.deepEqual(work.whereOf(st, { module: 'projects', name: 'BAU', owner: '' }, it()), ['Operations', 'BAU']);
  assert.deepEqual(work.whereOf(st, { module: 'clients', name: 'Previews', owner: '' }, it({ client: 'c-1' })), ['Clients', 'Previews', 'Example Council']);
  assert.deepEqual(work.whereOf(st, { module: 'clients', name: 'Previews', owner: '' }, it({ client: 'gone' })), ['Clients', 'Previews']);
  assert.deepEqual(work.whereOf(st, { module: 'projects', name: '', owner: 'dv' }, it()), ['David’s notes']);
  assert.deepEqual(work.whereOf(st, null, it()), []);
  assert.deepEqual([work.hasClient({ module: 'clients' }), work.hasClient({ module: 'projects' }), work.hasClient(null)], [true, false, false]);
});

// Ann (admin), Stu (staff, Outreach none and Clients view by default), one client; boards in state order.
const taskState = () => {
  const it = (id, values, extra = {}) => ({ id, name: id, values, done: values.status === 'Done', updates: [], subtasks: [], ...extra });
  const bd = (id, module, items, owner = '') => ({ id, module, name: owner ? '' : id, owner, groups: [{ id: `g-${id}`, name: 'Active', items }] });
  return {
    me: 'ann',
    users: [person('ann', 'admin'), person('stu', 'staff'), person('sue', 'superadmin'), person('off', 'staff', false)],
    moduleAccess: [],
    clients: [{ id: 'c-1', name: 'Example Council' }],
    boards: [
      bd('p-stu', 'projects', [it('own-1', { people: ['stu'], priority: 'Low', status: 'In progress' })], 'stu'),
      bd('p-sue', 'projects', [it('sue-1', { people: ['sue'] })], 'sue'),
      bd('p-ann', 'projects', [it('ann-own', { people: ['ann'], priority: 'High' },
        { updates: [{ id: 'u5', user: 'sue', text: '@ann see this', ts: '2026-10-24T14:00:00Z' }] })], 'ann'),
      bd('web', 'projects', [
        it('w-none', { people: ['stu'], due: '2026-10-20' }),
        it('w-high-late', { people: ['stu'], priority: 'High', due: '2026-10-30', status: 'In progress' }),
        it('w-high-soon', { people: ['stu', 'ann'], priority: 'High', due: '2026-10-26', status: 'Stuck' }),
        it('w-urgent', { people: ['stu'], priority: 'Urgent', status: 'In progress', assignedBy: 'ann', assignedAt: '2026-10-24T12:00:00Z' },
          { updates: [{ id: 'u1', user: 'ann', text: '@stu please start here', ts: '2026-10-24T12:00:00Z' },
            { id: 'u2', user: 'stu', text: 'On it @ann', ts: '2026-10-24T13:00:00Z' }] }),
        it('w-done', { people: ['stu'], priority: 'Urgent', status: 'Done' }),
        it('w-nobody', { people: [], priority: 'Medium' }),
        it('w-ann', { people: ['ann'], priority: 'Medium', due: '2026-10-29' }),
      ]),
      bd('post', 'marketing', [it('m-1', { people: ['stu'], status: 'In progress' }, { updates: [{ id: 'u3', user: 'sue', text: '@here and @stu', ts: '2026-10-23T00:00:00Z' }] })]),
      bd('sales', 'outreach', [it('o-1', { people: ['stu'], priority: 'Urgent' }, { updates: [{ id: 'u4', user: 'ann', text: '@stu call them', ts: '2026-10-25T00:00:00Z' }] })]),
      bd('demos', 'clients', [it('d-1', { people: ['stu'], priority: 'Urgent', client: 'c-1', status: 'In progress' }), it('d-2', { people: ['ann'], client: 'c-1', status: 'Done' }),
        it('d-3', { people: ['ann'], client: 'gone', priority: 'Low' })]),
      bd('wip', 'pipeline', [it('wip-1', { people: ['stu'], status: 'In progress' }),
        it('wip-2', { people: ['ann', 'stu'], assignedBy: 'sue', assignedAt: '2026-10-24T12:00:00Z' })]),
    ],
  };
};
const names = (rows) => rows.map((r) => r.item.id).join(' ');

await check('do today: a to-do linked to a task (ref item:<id>), one per task, person and day; it finds its task while you can see it', () => {
  assert.equal(work.itemRef('it-1'), 'item:it-1');
  assert.deepEqual(['item:it-1', 'contact:p', '', undefined].map((ref) => work.todoItemId({ ref })), ['it-1', '', '', '']);
  const todos = [{ id: 't1', assignee: 'stu', day: '2026-10-25', ref: 'item:w-urgent' }, { id: 't2', assignee: 'stu', day: '2026-10-25', ref: 'contact:x' }];
  assert.equal(work.todoForItem(todos, 'w-urgent', 'stu', '2026-10-25')?.id, 't1');
  assert.deepEqual([work.todoForItem(todos, 'w-urgent', 'ann', '2026-10-25'), work.todoForItem(todos, 'w-urgent', 'stu', '2026-10-26'), work.todoForItem(null, 'x', 'stu', 'd')],
    [null, null, null]);
  const st = taskState();
  assert.equal(work.itemOfTodo(st, todos[0])?.board.id, 'web');
  assert.equal(work.itemOfTodo(st, { ref: 'item:o-1' }, { viewer: 'stu' }), null, 'a task on a board you can’t see');
  assert.equal(work.itemOfTodo({ ...st, me: 'ann' }, { ref: 'item:o-1' })?.item.id, 'o-1');
  assert.deepEqual([work.itemOfTodo(st, { ref: 'item:gone' }), work.itemOfTodo(st, todos[1]), work.itemOfTodo(st, null)], [null, null, null]);
});

await check('priorities: the Dashboard’s tasks are the open tasks someone is on, Urgent → none, then the soonest due, then board order; waiting ones are marked', () => {
  const st = taskState();
  // Stu: Outreach is none for staff, so Sales Tasks isn't there; Work in Progress is (its Contact).
  const stu = work.prioritiesFor(st, 'stu', { today: '2026-10-25', viewer: 'stu' });
  assert.equal(names(stu), 'w-urgent d-1 w-high-soon w-high-late own-1 w-none m-1 wip-1 wip-2');
  const by = Object.fromEntries(stu.map((r) => [r.item.id, r]));
  assert.deepEqual([by['w-urgent'].waiting, by['w-urgent'].from, by['d-1'].waiting, by['d-1'].from], [true, 'ann', false, '']);
  assert.deepEqual([by['w-none'].overdue, by['w-high-soon'].overdue, by['w-none'].priority, by['d-1'].priority], [true, false, '', 'Urgent']);
  assert.equal(by['d-1'].client?.name, 'Example Council');
  assert.equal(by['w-high-late'].client, null);
  assert.deepEqual(work.workload(stu), { waiting: 1, urgent: 2, inProgress: 5, overdue: 1, open: 7 }, "Work in Progress' rows aren't tasks");
  // Waiting only for its owner, and only on a board with an owner column: wip-2 (Work in Progress, handed to Ann by Sue,
  // Stu second) waits on nobody, so it stays in their lists.
  assert.equal(by['wip-2'].waiting, false);
  const annWip = work.prioritiesFor(st, 'ann', { today: '2026-10-25' }).find((r) => r.item.id === 'wip-2');
  assert.deepEqual([annWip.waiting, annWip.from], [false, '']);
  const annTask = { ...st, boards: st.boards.map((b) => (b.id === 'web' ? { ...b, groups: [{ ...b.groups[0], items: [...b.groups[0].items,
    { id: 'w-handed', name: 'w-handed', values: { people: ['ann'], assignedBy: 'sue', assignedAt: '2026-10-24T12:00:00Z' }, done: false }] }] } : b)) };
  const handedRow = work.prioritiesFor(annTask, 'ann', { today: '2026-10-25' }).find((r) => r.item.id === 'w-handed');
  assert.deepEqual([handedRow.waiting, handedRow.from], [true, 'sue']);
  // Ann (admin) looking at Stu's: what Stu sees, so still no Sales Tasks; her own includes Outreach.
  assert.equal(names(work.prioritiesFor(st, 'stu', { today: '2026-10-25', viewer: 'ann' })), names(stu));
  assert.equal(names(work.prioritiesFor(st, 'ann', { today: '2026-10-25' })), 'w-high-soon ann-own w-ann d-3 wip-2', 'High: the dated one first');
  // Stu looking at Ann's (an admin may look at the SuperAdmin's): only boards both see, so not Ann's own page.
  assert.equal(names(work.prioritiesFor(st, 'ann', { viewer: 'stu' })), 'w-high-soon w-ann d-3 wip-2');
  // Team pages: team boards only, never a personal page (notes stay private), whoever looks.
  assert.equal(names(work.prioritiesFor(st, 'stu', { viewer: 'stu', teamOnly: true })), 'w-urgent d-1 w-high-soon w-high-late w-none m-1 wip-1 wip-2');
  assert.equal(names(work.prioritiesFor(st, 'ann', { teamOnly: true })), 'w-high-soon w-ann d-3 wip-2');
  assert.deepEqual([work.prioritiesFor(st, '', {}), work.prioritiesFor({}, 'stu', {})], [[], []]);
  assert.deepEqual(work.workload([]), { waiting: 0, urgent: 0, inProgress: 0, overdue: 0, open: 0 });
  assert.deepEqual([work.MAX_URGENT, work.MAX_IN_PROGRESS, work.ACCEPT_WITHIN], [1, 2, 864e5]);
});

await check('stages: someone’s tasks in sections — Stuck, In progress, Up next (with a priority), No priority — each keeping the priority / due / board order', () => {
  const st = taskState();
  const stu = work.prioritiesFor(st, 'stu', { today: '2026-10-25', viewer: 'stu' });
  assert.deepEqual(work.STAGES, ['Stuck', 'In progress', 'Up next', 'No priority']);
  const groups = work.byStage(stu);
  assert.deepEqual(groups.map((g) => [g.stage, names(g.rows)]), [
    ['Stuck', 'w-high-soon'],
    ['In progress', 'w-urgent d-1 w-high-late own-1 m-1 wip-1'],
    ['No priority', 'w-none wip-2'],
  ], 'Up next is left out when empty; Work in Progress rows go by their status');
  assert.equal(groups.flatMap((g) => g.rows).length, stu.length, 'every row once');
  const row = (status, priority) => ({ item: { values: { status } }, priority });
  assert.deepEqual([row('Stuck', ''), row('In progress', 'Low'), row('Not started', 'High'), row('Not started', ''), row(undefined, 'Medium'), row('Done', '')]
    .map(work.stageOf), ['Stuck', 'In progress', 'Up next', 'No priority', 'Up next', 'No priority']);
  // Inside a stage, prioritiesFor's order holds: Urgent first, then the soonest due.
  const upNext = work.byStage(work.prioritiesFor(st, 'ann', { today: '2026-10-25' })).find((g) => g.stage === 'Up next');
  assert.equal(names(upNext.rows), 'ann-own w-ann d-3');
  assert.deepEqual([work.byStage([]), work.byStage(null), work.stageOf(null)], [[], [], 'No priority']);
});

await check('priorities: Needs attention lists open team-board tasks that are overdue, Stuck, not accepted after a day, have no owner (or only people who can’t edit the board) or several people, or no priority', () => {
  const st = taskState();
  const now = Date.parse('2026-10-25T00:00:00Z'); // w-urgent was handed to Stu 12 hours before
  const rows = work.needsAttention(st, { today: '2026-10-25', now });
  assert.deepEqual(rows.map((r) => [r.item.id, r.reasons.join('+')]), [
    ['w-none', 'Overdue+No priority'],
    ['w-high-soon', 'Stuck+Several people'],
    ['w-nobody', 'No owner'],
    ['o-1', 'No owner'], // Stu can't open Outreach (staff default none)
    ['d-1', 'No owner'], // … and only views Clients (staff default view), so can't update it either
    ['m-1', 'No priority'],
  ], "personal pages, done tasks, Work in Progress and tasks with a priority and an owner who can edit aren't listed");
  // Board access: as Stu (staff), the boards Stu sees (not Sales Tasks); with Projects none, Marketing's and Clients'.
  const asStu = { ...st, me: 'stu' };
  assert.deepEqual(work.needsAttention(asStu, { today: '2026-10-25', now }).map((r) => r.item.id), ['w-none', 'w-high-soon', 'w-nobody', 'd-1', 'm-1']);
  const hidden = { ...asStu, moduleAccess: [{ userId: 'stu', module: 'projects', level: 'none' }] };
  assert.deepEqual(work.needsAttention(hidden, { today: '2026-10-25', now }).map((r) => r.item.id), ['d-1', 'm-1']);
  // Clients edit for Stu: d-1 has an owner again.
  const clientsEdit = { ...st, moduleAccess: [{ userId: 'stu', module: 'clients', level: 'edit' }] };
  assert.equal(work.needsAttention(clientsEdit, { today: '2026-10-25', now }).some((r) => r.item.id === 'd-1'), false);
  // A deactivated owner is no owner.
  const gone = { ...st, users: st.users.map((u) => (u.id === 'ann' ? { ...u, active: false } : u)), me: 'sue' };
  assert.deepEqual(work.needsAttention(gone, { today: '2026-10-25', now }).filter((r) => ['w-ann', 'd-3'].includes(r.item.id)).map((r) => r.reasons.join('+')),
    ['No owner', 'No owner']);
  // No date to compare with: nothing is overdue. A client that's gone is no client.
  assert.deepEqual(work.needsAttention(st, { now }).map((r) => r.reasons.join('+')),
    ['Stuck+Several people', 'No owner', 'No owner', 'No owner', 'No priority', 'No priority']);
  // A day after it was handed over, still not accepted: Not accepted (after Stuck, before No owner).
  const later = work.needsAttention(st, { today: '2026-10-25', now: now + 864e5 });
  assert.deepEqual(later.slice(0, 3).map((r) => [r.item.id, r.reasons.join('+')]),
    [['w-none', 'Overdue+No priority'], ['w-high-soon', 'Stuck+Several people'], ['w-urgent', 'Not accepted']]);
  // Accepted, or started by its owner: off the list.
  const accepted = { ...st, boards: st.boards.map((b) => ({ ...b, groups: b.groups.map((g) => ({ ...g, items: g.items.map((i) => (i.id === 'w-urgent' ? { ...i, values: { ...i.values, acceptedAt: 'x' } } : i)) })) })) };
  assert.equal(work.needsAttention(accepted, { today: '2026-10-25', now: now + 864e5 }).some((r) => r.item.id === 'w-urgent'), false);
  const d3 = { ...st, boards: st.boards.map((b) => (b.id === 'demos' ? { ...b, groups: [{ ...b.groups[0], items: [{ ...b.groups[0].items[2], values: { client: 'gone', people: [] } }] }] } : b)) };
  assert.equal(work.needsAttention(d3, { now }).find((r) => r.item.id === 'd-3').client, null);
  assert.deepEqual(work.ATTENTION, ['Overdue', 'Stuck', 'Not accepted', 'No owner', 'Several people', 'No priority']);
  assert.deepEqual(work.needsAttention({}), []);
});

await check('priorities: task updates that @name someone are their mentions (newest first, boards they see, not their own, @here alone is no one)', () => {
  const st = taskState();
  const stu = st.users.find((u) => u.id === 'stu');
  assert.deepEqual(work.taskMentions(st, stu, { viewer: 'stu' }).map((m) => [m.id, m.user, m.item.id, m.board.id, m.kind]),
    [['task:u1', 'ann', 'w-urgent', 'web', 'task'], ['task:u3', 'sue', 'm-1', 'post', 'task']], "Sales Tasks' update isn't on a board Stu sees");
  assert.deepEqual(work.taskMentions(st, stu, { viewer: 'ann' }).map((m) => m.id), ['task:u1', 'task:u3'], 'an admin looking: the same');
  assert.deepEqual(work.taskMentions(st, st.users[0]).map((m) => m.id), ['task:u5', 'task:u2'], 'newest first');
  assert.deepEqual(work.taskMentions(st, st.users[0], { viewer: 'stu' }).map((m) => m.id), ['task:u2'], 'not from a board the viewer can’t see');
  assert.deepEqual(work.taskMentions(st, st.users.find((u) => u.id === 'off')), [], 'an inactive person is never named');
  assert.deepEqual([work.taskMentions(st, null), work.taskMentions(st, {})], [[], []]);
});

await check('priorities: a client’s open linked tasks, on the boards you see', () => {
  const st = taskState();
  assert.deepEqual(work.clientTasks(st, 'c-1').map((r) => [r.item.id, r.board.id]), [['d-1', 'demos']], 'done ones are left out');
  assert.deepEqual(work.clientTasks({ ...st, me: 'stu', moduleAccess: [{ userId: 'stu', module: 'clients', level: 'none' }] }, 'c-1'), []);
  assert.deepEqual([work.clientTasks(st, ''), work.clientTasks(st, 'c-2')], [[], []]);
  // Only boards with a Client column count: a client id on another board's task (no column to clear it) doesn't.
  const stray = { ...st, boards: st.boards.map((b) => (b.id === 'web' ? { ...b, groups: [{ ...b.groups[0], items: [{ id: 'w-x', name: 'x', values: { client: 'c-1' }, done: false }] }] } : b)) };
  assert.deepEqual(work.clientTasks(stray, 'c-1').map((r) => r.item.id), ['d-1']);
});

await check('priorities: the demo seed — tasks have one owner (but a few left for Needs attention), Urgent work, client links and a hand-over', () => {
  if (!createSeed) return;
  const s = createSeed();
  const tasks = s.boards.filter((b) => work.hasOwner(b)).flatMap((b) => b.groups.flatMap((g) => g.items.map((item) => ({ item, board: b }))));
  const several = tasks.filter(({ item }) => item.values.people.length > 1).map(({ item }) => item.name);
  assert.deepEqual(several, ['Insurance renewal']);
  assert.ok(tasks.some(({ item }) => item.values.priority === 'Urgent'));
  assert.ok(tasks.filter(({ board }) => board.module === 'marketing').some(({ item }) => item.values.priority), 'Marketing has priorities');
  const linked = tasks.filter(({ item }) => item.values.client);
  assert.ok(linked.length >= 4 && linked.every(({ board, item }) => board.module === 'clients' && s.clients.some((c) => c.id === item.values.client)));
  const handed = tasks.filter(({ item }) => item.values.assignedBy);
  assert.deepEqual(handed.map(({ item }) => [item.name, item.values.people[0], item.values.assignedBy, Boolean(item.values.acceptedAt)]), [
    ['Council landing page', 'hello', 'david', false],
    ['Coastal Rail preview with sample assets', 'josh', 'david', true],
    ['New video from the Northside preview', 'josh', 'david', false],
  ]);
  assert.equal(work.prioritiesFor(s, 'hello', { viewer: 'hello' }).filter((r) => r.waiting).length, 1);
  assert.deepEqual(work.prioritiesFor(s, 'josh', { viewer: 'josh' }).filter((r) => r.waiting).map((r) => r.item.name), ['New video from the Northside preview']);
  // David's Do today to-do points at his Urgent walkthrough.
  const today = s.todos.filter((t) => work.todoItemId(t));
  assert.deepEqual(today.map((t) => [t.assignee, work.itemOfTodo(s, t)?.item.name, t.source]), [['david', 'Northside Diocese: asset register walkthrough', 'manual']]);
  assert.ok(work.taskMentions(s, s.users.find((u) => u.id === 'hello'), { viewer: 'hello' }).length >= 1);
  assert.ok(work.needsAttention(s).some((r) => r.reasons.includes('No owner')));
});

// ── CRM profile (0012, docs/PHASE2.md §19): src/lib/crm.js ──────────────────────────────────────────────────────
const crm = await import('../src/lib/crm.js');

// Ann (admin), Stu (staff: Pipeline view, Clients view by default), Sam (staff with Pipeline and Clients edit), Off
// (inactive). One deal (d-open), one deal made a client (d-won → c-won), and a client of its own (c-own).
const crmState = () => ({
  me: 'ann',
  users: [person('ann', 'admin'), person('stu', 'staff'), person('sam', 'staff'), person('off', 'staff', false)],
  moduleAccess: [{ userId: 'sam', module: 'pipeline', level: 'edit' }, { userId: 'sam', module: 'clients', level: 'edit' }],
  deals: [{ id: 'd-open', name: 'Open deal', clientId: '' }, { id: 'd-won', name: 'Won deal', clientId: 'c-won' }],
  clients: [
    { id: 'c-won', name: 'Won deal', demoUrl: 'demo.example.com', platformUrl: '', notes: [{ id: 'n1', user: 'ann', text: 'Old note', ts: '2026-10-01T00:00:00.000Z' }] },
    { id: 'c-own', name: 'Own client', demoUrl: '', platformUrl: 'javascript:alert(1)', notes: [] },
  ],
  crmEntries: [
    { id: 'e1', dealId: 'd-open', clientId: '', kind: 'note', body: 'Call Friday', user: 'sam', createdAt: '2026-10-20T00:00:00.000Z' },
    { id: 'e2', dealId: 'd-open', clientId: '', kind: 'meeting', title: 'Intro', happenedOn: '2026-10-22', body: '', url: 'https://docs.google.com/document/d/x/edit',
      user: 'ann', createdAt: '2026-10-19T00:00:00.000Z' },
    { id: 'e3', dealId: 'd-open', clientId: '', kind: 'link', label: 'Deck', title: 'Deck', url: 'https://example.com/deck', user: 'sam', createdAt: '2026-10-21T00:00:00.000Z' },
    // d-won's, not yet carried to its client here (the database does it; realtime brings it back)
    { id: 'e4', dealId: 'd-won', clientId: '', kind: 'meeting', title: 'Pilot review', happenedOn: '2026-10-02', user: 'ann', createdAt: '2026-10-02T00:00:00.000Z' },
    { id: 'e5', dealId: '', clientId: 'c-won', kind: 'note', body: 'Kick-off booked', user: 'sam', createdAt: '2026-10-23T00:00:00.000Z' },
    { id: 'e6', dealId: '', clientId: 'c-won', kind: 'link', label: 'Other', title: 'Bad', url: 'javascript:alert(1)', user: 'sam', createdAt: '2026-10-24T00:00:00.000Z' },
  ],
});

await check('crm: who reads, adds and changes an entry (0012’s policies): a client’s takes Clients, a deal’s Pipeline; changing it takes its author or an admin', () => {
  const st = crmState();
  const e = (id) => st.crmEntries.find((x) => x.id === id);
  assert.deepEqual(['ann', 'stu', 'sam', 'off'].map((u) => crm.canReadEntry(st, e('e1'), u)), [true, true, true, false], 'a deal’s: Pipeline view');
  const noPipeline = { ...st, moduleAccess: [...st.moduleAccess, { userId: 'stu', module: 'pipeline', level: 'none' }] };
  assert.deepEqual([crm.canReadEntry(noPipeline, e('e1'), 'stu'), crm.canReadEntry(noPipeline, e('e5'), 'stu'), crm.canReadEntry(noPipeline, { dealId: 'd-won', clientId: 'c-won' }, 'stu')],
    [false, true, true], 'without Pipeline: a client’s still, and one on both');
  assert.deepEqual(['ann', 'stu', 'sam', 'off'].map((u) => crm.canAddEntry(st, { dealId: 'd-open' }, u)), [true, false, true, false]);
  assert.deepEqual(['ann', 'stu', 'sam'].map((u) => crm.canAddEntry(st, { clientId: 'c-own' }, u)), [true, false, true]);
  const pipelineOnly = { ...st, moduleAccess: [{ userId: 'sam', module: 'pipeline', level: 'edit' }] };
  assert.deepEqual([crm.canAddEntry(pipelineOnly, { dealId: 'd-won', clientId: 'c-won' }, 'sam'), crm.canAddEntry(st, {}, 'ann')], [false, false],
    'one on a client takes Clients edit even with its deal; nothing for nowhere');
  assert.deepEqual([crm.canChangeEntry(st, e('e1'), 'sam'), crm.canChangeEntry(st, e('e2'), 'sam'), crm.canChangeEntry(st, e('e2'), 'ann'), crm.canChangeEntry(st, e('e1'), 'stu'), crm.canChangeEntry(st, null, 'ann')],
    [true, false, true, false, false], 'its author, or an admin; never without edit');
});

await check('crm: cleanEntry keeps what an entry needs — a known kind, http(s) links only, a meeting’s date, a link’s label — and refuses empty ones', () => {
  assert.deepEqual(crm.cleanEntry({ kind: 'note', body: '  Call back  ', url: 'x', title: ' T ' }),
    { kind: 'note', title: 'T', body: 'Call back', url: 'https://x/', label: '', happenedOn: '', attendees: '' });
  assert.deepEqual(crm.cleanEntry({ kind: 'meeting', title: 'Intro', happenedOn: '2026-10-22', attendees: ' Jo ', url: 'docs.google.com/document/d/x' }),
    { kind: 'meeting', title: 'Intro', body: '', url: 'https://docs.google.com/document/d/x', label: '', happenedOn: '2026-10-22', attendees: 'Jo' });
  assert.equal(crm.cleanEntry({ kind: 'meeting', title: 'X', happenedOn: '22/10/2026' }).happenedOn, '', 'a date that isn’t YYYY-MM-DD is dropped');
  assert.deepEqual(crm.cleanEntry({ kind: 'link', url: 'example.com/deck', label: 'Deck' }).label, 'Deck');
  assert.equal(crm.cleanEntry({ kind: 'link', url: 'example.com', label: 'Whatever' }).label, 'Other');
  assert.deepEqual([crm.cleanEntry({ kind: 'link', url: 'javascript:alert(1)' }), crm.cleanEntry({ kind: 'note', body: '  ' }), crm.cleanEntry({ kind: 'meeting' })],
    [null, null, null]);
  assert.equal(crm.cleanEntry({ kind: 'call', body: 'x' }).kind, 'note', 'an unknown kind is a note');
  assert.equal(crm.cleanEntry({ kind: 'note', body: 'x'.repeat(30000) }).body.length, 20000);
  // A link is measured as saved (https:// added, spaces and accents encoded), never cut: too long is no link.
  const fits = `https://example.com/${'a'.repeat(crm.URL_MAX - 20)}`;
  assert.equal(crm.cleanEntry({ kind: 'link', url: fits }).url, fits);
  assert.deepEqual([crm.cleanEntry({ kind: 'link', url: `example.com/${'a'.repeat(1990)}` }), crm.cleanEntry({ kind: 'link', url: `https://example.com/${'é'.repeat(340)}` })],
    [null, null], 'over the limit once https:// is added or the accents are encoded');
  assert.deepEqual(crm.cleanEntry({ kind: 'meeting', title: 'Kick-off', url: `https://example.com/${'a b'.repeat(660)}` }).url, '', 'a meeting keeps the rest');
  assert.deepEqual([crm.entryUrl(' example.com/x '), crm.entryUrl(''), crm.entryUrl('ftp://example.com')], ['https://example.com/x', '', '']);
  assert.deepEqual(crm.LINK_LABELS, ['Meeting notes', 'Demo', 'Deck', 'Proposal', 'Recording', 'Other']);
});

await check('crm: a deal’s and client’s timeline and links — newest first (a meeting by its day), a client’s with its older notes and its deal’s entries; unsafe links left out', () => {
  const st = crmState();
  assert.deepEqual(crm.timelineOf(st, { dealId: 'd-open' }).map((x) => x.id), ['e2', 'e1'], 'the meeting on the 22nd before the note added on the 20th; links aren’t in it');
  assert.deepEqual(crm.timelineOf(st, { clientId: 'c-won' }).map((x) => x.id), ['e5', 'e4', 'note:n1'], 'its own, its deal’s, its older notes');
  const legacy = crm.timelineOf(st, { clientId: 'c-won' }).at(-1);
  assert.deepEqual([legacy.legacy, legacy.body, legacy.user, legacy.kind], [true, 'Old note', 'ann', 'note']);
  assert.deepEqual(crm.linksOf(st, { dealId: 'd-open' }).map((x) => x.id), ['e3']);
  assert.deepEqual(crm.linksOf(st, { clientId: 'c-won' }).map((x) => [x.id, x.label, Boolean(x.fixed)]), [['fixed:Demo', 'Demo', true]], 'the Demo field; the javascript: link is left out');
  assert.deepEqual(crm.linksOf(st, { clientId: 'c-own' }), [], 'an unsafe Platform field is left out');
  assert.deepEqual(crm.dealsOfClient(st, 'c-won').map((d) => d.id), ['d-won']);
  assert.deepEqual([crm.dealsOfClient(st, 'c-own'), crm.dealsOfClient(st, ''), crm.timelineOf(st, {}), crm.linksOf(null, {})], [[], [], [], []]);
  // A second deal for the same organisation, made the same client: its entries show on the client too.
  st.deals.push({ id: 'd-again', name: 'Won deal', clientId: 'c-won' });
  st.crmEntries.push({ id: 'e7', dealId: 'd-again', clientId: '', kind: 'note', body: 'Second order', user: 'sam', createdAt: '2026-10-25T00:00:00.000Z' },
    { id: 'e8', dealId: 'd-again', clientId: '', kind: 'link', label: 'Proposal', title: 'Phase 2', url: 'https://example.com/p2', user: 'sam', createdAt: '2026-10-25T00:00:00.000Z' });
  assert.deepEqual(crm.timelineOf(st, { clientId: 'c-won' }).map((x) => x.id), ['e7', 'e5', 'e4', 'note:n1'], 'both deals’ entries');
  assert.deepEqual(crm.linksOf(st, { clientId: 'c-won' }).map((x) => x.id), ['fixed:Demo', 'e8']);
  assert.deepEqual(crm.dealsOfClient(st, 'c-won').map((d) => d.id), ['d-won', 'd-again']);
});

await check('crm: the timeline goes by the day here — a note added this morning (yesterday in UTC) is above a meeting held yesterday', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Australia/Sydney';
  try {
    const st = crmState();
    st.crmEntries = [
      { id: 'meet', dealId: 'd-open', clientId: '', kind: 'meeting', title: 'Walkthrough', happenedOn: '2026-10-25', user: 'ann', createdAt: '2026-10-26T03:00:00.000Z' },
      { id: 'note', dealId: 'd-open', clientId: '', kind: 'note', body: 'Rang back', user: 'ann', createdAt: '2026-10-25T22:30:00.000Z' }, // 26 Oct, 9:30 in Sydney
    ];
    assert.deepEqual(crm.timelineOf(st, { dealId: 'd-open' }).map((x) => x.id), ['note', 'meet']);
  } finally {
    if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  }
});

await check('crm: demo mode’s Make client carries a deal’s entries to its client; deleting a deal drops the ones that never reached a client (as 0012’s triggers)', () => {
  const st = crmState();
  crm.carryDealEntriesLocal(st, 'd-won', 'c-won');
  assert.deepEqual(st.crmEntries.filter((e) => e.dealId === 'd-won').map((e) => e.clientId), ['c-won']);
  crm.carryDealEntriesLocal(st, 'd-open', '');
  assert.ok(st.crmEntries.filter((e) => e.dealId === 'd-open').every((e) => !e.clientId), 'no client: nothing carried');
  crm.dropDealEntriesLocal(st, 'd-open');
  assert.deepEqual(st.crmEntries.map((e) => e.id), ['e4', 'e5', 'e6'], 'd-open’s three gone');
  crm.dropDealEntriesLocal(st, 'd-won');
  assert.deepEqual(st.crmEntries.map((e) => [e.id, e.dealId, e.clientId]), [['e4', '', 'c-won'], ['e5', '', 'c-won'], ['e6', '', 'c-won']], 'carried ones stay, off the deal');
});

await check('crm: next steps are tasks — a deal’s (Outreach boards’ Deal column) show on its profile and, once it is a client, on the client’s', () => {
  const st = taskState();
  st.deals = [{ id: 'd-1', name: 'Example deal', clientId: 'c-1' }, { id: 'd-2', name: 'Open deal', clientId: '' }];
  const sales = st.boards.find((b) => b.id === 'sales');
  sales.groups[0].items.push({ id: 'o-2', name: 'Send the scope', values: { people: ['ann'], deal: 'd-2' }, done: false, updates: [], subtasks: [] },
    { id: 'o-3', name: 'Book kick-off', values: { people: ['ann'], deal: 'd-1' }, done: false, updates: [], subtasks: [] },
    { id: 'o-4', name: 'Done one', values: { people: ['ann'], deal: 'd-2' }, done: true, updates: [], subtasks: [] });
  assert.deepEqual(work.dealTasks(st, 'd-2').map((r) => r.item.id), ['o-2'], 'open ones only');
  assert.deepEqual(work.clientTasks(st, 'c-1').map((r) => r.item.id), ['o-3', 'd-1'], 'the client’s deal’s next steps, then its own Clients tasks (board order)');
  assert.deepEqual(work.dealTasks({ ...st, me: 'stu' }, 'd-2'), [], 'Outreach none: not visible');
  // A second deal made the same client: its next steps join the client's.
  st.deals.push({ id: 'd-3', name: 'Example deal', clientId: 'c-1' });
  sales.groups[0].items.push({ id: 'o-5', name: 'Phase 2 quote', values: { people: ['ann'], deal: 'd-3' }, done: false, updates: [], subtasks: [] });
  assert.deepEqual(work.clientTasks(st, 'c-1').map((r) => r.item.id), ['o-3', 'o-5', 'd-1'], 'both deals’ next steps');
  // Deals are Pipeline's: without Pipeline view (live mode reads none) only the client's own tasks.
  const blind = { ...st, moduleAccess: [...(st.moduleAccess || []), { userId: 'stu', module: 'pipeline', level: 'none' }, { userId: 'stu', module: 'outreach', level: 'view' }] };
  assert.deepEqual([work.clientTasks(blind, 'c-1', { viewer: 'stu' }).map((r) => r.item.id), work.dealTasks(blind, 'd-3', { viewer: 'stu' }).map((r) => r.item.id)],
    [['d-1'], ['o-5']], 'the deal’s next steps stay on the Outreach board, not on the client');
  assert.deepEqual([work.dealTasks(st, ''), work.hasDeal({ module: 'outreach' }), work.hasDeal({ module: 'clients' })], [[], true, false]);
});

await check('crm: the demo seed — Northside’s deal has a meeting with its notes linked, a note, a proposal and a next step; Westbay’s history came with its deal', () => {
  if (!createSeed) return;
  const s = createSeed();
  const northside = s.deals.find((d) => d.name === 'Northside Diocese');
  const westbay = s.clients.find((c) => c.name === 'Westbay Council');
  const tl = crm.timelineOf(s, { dealId: northside.id });
  assert.deepEqual(tl.map((e) => e.kind), ['meeting', 'note']);
  assert.ok(/docs\.google\.com/.test(tl[0].url) && tl[0].body && tl[0].attendees);
  assert.deepEqual(crm.linksOf(s, { dealId: northside.id }).map((l) => l.label), ['Proposal']);
  assert.deepEqual(work.dealTasks(s, northside.id).map((r) => r.item.name), ['Send Northside the scope document']);
  const wt = crm.timelineOf(s, { clientId: westbay.id });
  assert.ok(wt.some((e) => e.kind === 'meeting' && e.dealId), 'the deal’s meeting, now the client’s');
  assert.ok(crm.linksOf(s, { clientId: westbay.id }).some((l) => l.label === 'Demo' && !l.fixed));
  assert.ok(s.crmEntries.every((e) => e.user && e.createdAt && (e.dealId || e.clientId)));
});

// The starting boards and first group the app uses are the ones the database makes: 0006 for Projects and Marketing,
// 0007 for Outreach and Clients (which also widens the checks that list the board modules).
const migrationFile = (prefix) => {
  const f = existsSync(migrationsDir) && readdirSync(migrationsDir).find((x) => x.startsWith(prefix) && x.endsWith('.sql'));
  return f ? [f, readFileSync(new URL(f, migrationsDir), 'utf8')] : null;
};
const boardsSql = migrationFile('0006_');
const outreachBoardsSql = migrationFile('0007_');
const pipelineBoardsSql = migrationFile('0008_');
if (boardsSql && outreachBoardsSql && pipelineBoardsSql) {
  await check(`boards: STARTING_BOARDS, EXISTING_BOARD and FIRST_GROUP match ${boardsSql[0]}, ${outreachBoardsSql[0]} and ${pipelineBoardsSql[0]}`, () => {
    const sql = boardsSql[1];
    const starting = {};
    [...sql.matchAll(/\('(projects|marketing)', '([^']+)', (\d+)\)/g)].forEach(([, module, name, pos]) => { (starting[module] ||= [])[+pos] = name; });
    const existing = /case g\.board_key when 'projects' then '([^']+)' else '([^']+)' end/.exec(sql);
    assert.ok(existing, 'where the existing groups go: not found');
    assert.deepEqual({ projects: existing[1], marketing: existing[2] }, boardsLib.EXISTING_BOARD);
    const first = /case b\.module when 'projects' then '([^']+)' else '([^']+)' end, '(#[0-9a-f]{6})'/.exec(sql);
    assert.ok(first, 'first group: not found');
    // 0007: Outreach's and Clients' starting boards, each with one group, made once with the checks that list the
    // board modules.
    const sql7 = outreachBoardsSql[1];
    const values = /from \(values ([^\n]+)\) as x \(module, name, position\)/.exec(sql7);
    assert.ok(values, "0007's starting boards: not found");
    [...values[1].matchAll(/\('(outreach|clients)', '([^']+)', (\d+)\)/g)].forEach(([, module, name, pos]) => { (starting[module] ||= [])[+pos] = name; });
    const group7 = /select b\.module, b\.id, '([^']+)', '(#[0-9a-f]{6})', 0 from b/.exec(sql7);
    assert.ok(group7, "0007's first group: not found");
    // 0008: Pipeline's Work in Progress, the same way.
    const sql8 = pipelineBoardsSql[1];
    const board8 = /values \('pipeline', '([^']+)', 0\) returning id, module/.exec(sql8);
    const group8 = /select b\.module, b\.id, '([^']+)', '(#[0-9a-f]{6})', 0 from b/.exec(sql8);
    assert.ok(board8 && group8, "0008's Work in Progress: not found");
    starting.pipeline = [board8[1]];
    assert.deepEqual(starting, boardsLib.STARTING_BOARDS);
    assert.deepEqual([{ projects: first[1], marketing: first[2], outreach: group7[1], clients: group7[1], pipeline: group8[1] }, first[3], group7[2], group8[2]],
      [boardsLib.FIRST_GROUP, boardsLib.FIRST_GROUP_COLOR, boardsLib.FIRST_GROUP_COLOR, boardsLib.FIRST_GROUP_COLOR]);
    assert.deepEqual(boardsLib.BOARD_MODULES, ['projects', 'marketing', 'outreach', 'clients', 'pipeline']);
    assert.deepEqual(boardsLib.MENU_BOARD_MODULES, ['projects', 'marketing', 'outreach', 'clients'], 'Pipeline’s boards sit on its page');
    const listsOf = (sql) => [...sql.matchAll(/check \((module|board_key) in \(([^)]*)\)\)/g)]
      .map(([, col, list]) => [col, list.replace(/['\s]/g, '').split(',')]);
    [[outreachBoardsSql[1], boardsLib.BOARD_MODULES.slice(0, 4)], [sql8, boardsLib.BOARD_MODULES]].forEach(([sql, modules]) => {
      const lists = listsOf(sql);
      assert.deepEqual(lists.map(([col]) => col), ['module', 'board_key', 'board_key'], 'boards, board_groups and items');
      lists.forEach(([, list]) => assert.deepEqual(list, modules));
    });
    assert.ok(boardsLib.GROUP_COLORS.includes(boardsLib.FIRST_GROUP_COLOR));
  });
}

await check('automations: date helpers match Postgres', () => {
  assert.deepEqual(['2026-10-12', '2026-10-18', '2026-10-14'].map(auto.isoDow), [1, 7, 3]);
  assert.equal(auto.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(auto.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(auto.mondayOf('2026-10-18'), '2026-10-12');
  assert.equal(auto.mondayOf('2026-10-12'), '2026-10-12');
  assert.equal(auto.addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(auto.addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(auto.addMonths('2026-11-30', 3), '2027-02-28');
  assert.equal(auto.addMonths('2026-10-12', 12), '2027-10-12');
  assert.equal(auto.addMonthsOnDay('2026-09-30', 1, 31), '2026-10-31');
  assert.equal(auto.addMonthsOnDay('2027-01-31', 1, 31), '2027-02-28');
  assert.equal(auto.addMonthsOnDay('2026-11-30', 3, 30), '2027-02-28');
  assert.deepEqual(['2026-10-12', '0026-07-01', '0002-10-01', '1999-12-31', '2100-01-01', '', '2026-1-1'].map(auto.isPlanDate),
    [true, false, false, false, false, false, false]);
  assert.deepEqual(['9:05', '09:05:00', '24:00', '', 'x'].map(auto.toHhmm), ['09:05', '09:05', '', '', '']);
});

await check('automations: invoice numbers continue the prefix from 1001', () => {
  const st = (prefix, numbers) => ({ org: { invoicePrefix: prefix }, clients: [{ invoices: numbers.map((number) => ({ number })) }] });
  assert.equal(auto.nextInvoiceNumber(st('EX-', ['EX-1002', 'INV-5000', 'EX-12a'])), 'EX-1003');
  assert.equal(auto.nextInvoiceNumber(st('EX-', [])), 'EX-1001');
  assert.equal(auto.nextInvoiceNumber(st('2026-', ['2026-1001', '2025-1009'])), '2026-1002');
  assert.equal(auto.nextInvoiceNumber({ clients: [] }), 'INV-1001');
});

const workState = () => ({
  me: 'stu',
  users: [person('al', 'admin'), person('stu', 'staff'), person('off', 'staff', false)],
  routines: [
    { id: 'r-late', title: 'No time', category: 'Outreach', minutes: 15, assignee: 'stu', weekdays: [1], start: '', active: true },
    { id: 'r-li', title: 'LinkedIn engagement', category: 'LinkedIn', minutes: 60, assignee: 'stu', weekdays: [1, 2, 3, 4, 5], start: '09:00', active: true },
    { id: 'r-off', title: 'Paused', category: 'Other', minutes: 10, assignee: 'stu', weekdays: [1, 2, 3, 4, 5, 6, 7], start: '', active: false },
    { id: 'r-al', title: 'Pipeline review', category: 'Meetings', minutes: 30, assignee: 'al', weekdays: [1], start: '08:30', active: true },
    { id: 'r-gone', title: 'Inactive person', category: 'Other', minutes: 10, assignee: 'off', weekdays: [1], start: '', active: true },
  ],
  todos: [],
  bankStatements: [{ id: 'bs', weekStart: '2026-10-19', filePath: '', note: '', uploadedBy: 'al', createdAt: '' }],
});

await check('automations: ensureTodosLocal adds routine to-dos once per routine, person and day', () => {
  const st = workState();
  assert.equal(auto.ensureTodosLocal(st, '2026-10-12'), 2); // Monday
  assert.deepEqual(st.todos.map((t) => t.routineId), ['r-li', 'r-late'], 'by start time, untimed last');
  const { id: _id, ...li } = st.todos[0];
  assert.deepEqual(li, {
    assignee: 'stu', createdBy: 'stu', title: 'LinkedIn engagement', notes: '', day: '2026-10-12', start: '09:00', minutes: 60,
    category: 'LinkedIn', source: 'routine', routineId: 'r-li', ref: '', done: false, doneAt: '',
  });
  assert.equal(auto.ensureTodosLocal(st, '2026-10-12'), 0, 'idempotent');
  st.todos[0].done = true;
  assert.equal(auto.ensureTodosLocal(st, '2026-10-12'), 0, 'a done to-do still counts');
  assert.equal(auto.ensureTodosLocal(st, '2026-10-13'), 1); // Tuesday: weekday routine only
  assert.equal(auto.ensureTodosLocal(st, '2026-10-18'), 0); // Sunday
  assert.equal(auto.ensureTodosLocal(st, '2026-10-12', { me: 'off' }), 0, 'inactive person');
  assert.equal(auto.ensureTodosLocal(st, 'not a day'), 0);
});

await check('automations: a routine to-do deleted or moved to another day is not made again that day', () => {
  const st = workState();
  assert.equal(auto.ensureTodosLocal(st, '2026-10-12'), 2);
  st.todos = st.todos.filter((t) => t.routineId !== 'r-li');
  st.todos.find((t) => t.routineId === 'r-late').day = '2026-10-14';
  assert.equal(auto.ensureTodosLocal(st, '2026-10-12'), 0);
  assert.equal(st.todos.filter((t) => t.day === '2026-10-12').length, 0);
  assert.equal(auto.ensureTodosLocal(st, '2026-10-13'), 1, 'the next day runs as usual');
  assert.deepEqual(st.routineRuns, ['2026-10-12|r-li|stu', '2026-10-12|r-late|stu', '2026-10-13|r-li|stu']);
  auto.ensureTodosLocal(st, '2026-10-27');
  assert.ok(st.routineRuns.every((r) => r >= '2026-10-13'), 'runs older than two weeks are let go');
});

await check('automations: ensureTodosLocal adds the Monday bank reminder for admins until the statement is in', () => {
  const st = workState();
  assert.equal(auto.ensureTodosLocal(st, '2026-10-12', { me: 'al' }), 2);
  const bank = st.todos.find((t) => t.source === 'automation');
  assert.deepEqual({ ...bank, id: '' }, {
    id: '', assignee: 'al', createdBy: 'al', title: auto.BANK_TODO_TITLE, notes: '', day: '2026-10-12', start: '', minutes: 30, category: 'Admin',
    source: 'automation', routineId: '', ref: 'bank:2026-10-12', done: false, doneAt: '',
  });
  assert.equal(auto.ensureTodosLocal(st, '2026-10-12', { me: 'al' }), 0);
  assert.equal(auto.ensureTodosLocal(st, '2026-10-19', { me: 'al' }), 1, 'statement uploaded for that week: routine only');
  assert.equal(auto.ensureTodosLocal(st, '2026-10-13', { me: 'al' }), 0, 'Mondays only');
  assert.ok(!st.todos.some((t) => t.assignee === 'stu'));
  auto.ensureTodosLocal(st, '2026-10-26');
  assert.ok(!st.todos.some((t) => t.assignee === 'stu' && t.source === 'automation'), 'staff never get it');
});

const format = await import('../src/lib/format.js');

await check('automations: "Approve invoices" for admins while any invoice awaits approval, once a day (0004)', () => {
  const st = workState();
  st.clients = [{ id: 'cl', name: 'Client', status: 'Active', contact: 'al', invoices: [{ id: 'iv', status: 'Awaiting approval' }] }];
  auto.ensureTodosLocal(st, '2026-10-13', { me: 'al' });
  const approve = st.todos.filter((t) => t.ref === 'approve:2026-10-13');
  assert.equal(approve.length, 1);
  assert.deepEqual([approve[0].assignee, approve[0].title, approve[0].category, approve[0].source], ['al', auto.APPROVE_TODO_TITLE, 'Clients', 'automation']);
  assert.equal(auto.ensureTodosLocal(st, '2026-10-13', { me: 'al' }), 0, 'once a day');
  auto.ensureTodosLocal(st, '2026-10-13', { me: 'stu' });
  assert.ok(!st.todos.some((t) => t.assignee === 'stu' && t.ref.startsWith('approve:')), 'staff never get it');
  auto.ensureTodosLocal(st, '2026-10-14', { me: 'al' });
  assert.ok(!st.todos.some((t) => t.ref === 'approve:2026-10-14'), 'an undone reminder carries over: no new one each day');
  approve[0].done = true;
  auto.ensureTodosLocal(st, '2026-10-15', { me: 'al' });
  assert.equal(st.todos.filter((t) => t.ref === 'approve:2026-10-15').length, 1, 'once ticked, a new one while invoices still wait');
  st.clients[0].invoices[0].status = 'Approved';
  st.todos.forEach((t) => { t.done = true; });
  auto.ensureTodosLocal(st, '2026-10-16', { me: 'al' });
  assert.ok(!st.todos.some((t) => t.ref === 'approve:2026-10-16'), 'nothing awaiting: no to-do');
});

await check('automations: clientCreatedLocal gives an admin owner a "Prepare contract" to-do on their own day (0004)', () => {
  const st = {
    me: 'al',
    users: [{ ...person('al', 'admin'), timezone: 'Pacific/Pago_Pago' }, { ...person('stu', 'staff'), timezone: 'Pacific/Kiritimati' },
      { ...person('su', 'superadmin'), timezone: 'Pacific/Kiritimati' }],
    clients: [
      { id: 'c-new', name: ' Example Body Corporate ', status: 'Onboarding', contact: 'su' },
      { id: 'c-staff', name: 'Staff owned', status: 'Onboarding', contact: 'stu' },
      { id: 'c-active', name: 'Imported', status: 'Active', contact: 'al' },
      { id: 'c-blank', name: '  ', status: 'Onboarding', contact: '' },
    ],
    todos: [],
  };
  const todo = auto.clientCreatedLocal(st, 'c-new');
  assert.deepEqual([todo.assignee, todo.createdBy, todo.title, todo.category, todo.source, todo.ref],
    ['su', 'al', 'Prepare contract: Example Body Corporate', 'Clients', 'automation', 'contract:c-new']);
  assert.equal(todo.day, format.ymdIn('Pacific/Kiritimati'), "the owner's own today");
  assert.equal(auto.clientCreatedLocal(st, 'c-new'), null, 'once per client and day');
  assert.equal(auto.clientCreatedLocal(st, 'c-staff').assignee, 'al', 'a staff owner: the admin who added it');
  assert.equal(auto.clientCreatedLocal(st, 'c-staff', { me: 'stu' }), null, 'staff adding a staff-owned client: nobody');
  assert.equal(auto.clientCreatedLocal(st, 'c-active'), null, 'only Onboarding clients');
  assert.equal(auto.clientCreatedLocal(st, 'c-blank').title, 'Prepare contract: new client');
});

const outreachState = () => ({
  me: 'al',
  users: [person('al', 'admin'), person('stu', 'staff')],
  contacts: [
    { id: 'c1', name: 'Pat Doe', org: 'Example Water', email: '', stage: 'Opportunity', status: 'Replied', last: '', owner: 'stu' },
    { id: 'c2', name: 'Lee Roe', org: '  ', email: '', stage: 'Opportunity', status: 'Meeting booked', last: '', owner: '' },
    { id: 'c3', name: 'Kim Poe', org: 'Org', email: '', stage: 'Opportunity', status: 'Opened', last: '', owner: 'stu' },
  ],
  deals: [{ id: 'd0', name: 'Existing', sector: '', value: 5, priority: 'P1', stage: 'Opportunities', contact: 'al', next: '', contactId: '' }],
  todos: [],
});

await check('format: dates and clocks in a time zone', () => {
  const at = new Date('2026-10-12T13:30:00Z'); // Tue 00:30 in Sydney (AEDT), 17:30 Mon in Tbilisi, 21:30 Mon in Manila
  assert.equal(format.TEAM_TIMEZONE, 'Australia/Sydney');
  assert.deepEqual(['Australia/Sydney', 'Asia/Tbilisi', 'Asia/Manila', 'UTC'].map((z) => format.ymdIn(z, at)),
    ['2026-10-13', '2026-10-12', '2026-10-12', '2026-10-12']);
  assert.equal(format.ymdIn('Mars/Olympus', at), format.localYmd(at), 'unknown zone: this machine\'s date');
  assert.match(format.localClock('Asia/Tbilisi', at), /^Tbilisi · 5:30\s?pm$/i);
  assert.match(format.localClock('America/Los_Angeles', at), /^Los Angeles · 6:30\s?am$/i);
  assert.match(format.localTime('Asia/Manila', at), /^9:30\s?pm$/i);
  assert.deepEqual([format.localClock('', at), format.localClock('Mars/Olympus', at), format.localTime(undefined, at)], ['', '', '']);
  assert.equal(typeof format.browserTimezone(), 'string');
  // The world clocks: time, weekday and hour (for day or night) in each city.
  const now = (z) => { const n = format.zoneNow(z, at); return n && [n.time.replace(/\s/g, ' ').toLowerCase(), n.day, n.hour]; };
  assert.deepEqual(['Australia/Sydney', 'Asia/Tbilisi', 'Asia/Manila'].map(now), [['12:30 am', 'Tue', 0], ['5:30 pm', 'Mon', 17], ['9:30 pm', 'Mon', 21]]);
  assert.deepEqual([format.zoneNow('', at), format.zoneNow('Mars/Olympus', at), format.zoneNow(undefined, at)], [null, null, null]);
});

await check("automations: contactPipelineLocal dates the follow-up on its owner's today (user_today()), Sydney when unknown", () => {
  const st = outreachState();
  st.users = [{ ...person('al', 'admin'), timezone: 'Pacific/Pago_Pago' }, { ...person('stu', 'staff'), timezone: 'Pacific/Kiritimati' }];
  const forStu = auto.contactPipelineLocal(st, 'c1', 'Sent'); // owner stu
  const forAl = auto.contactPipelineLocal(st, 'c2', ''); // no owner: whoever saved it (al)
  assert.equal(forStu.todo.day, format.ymdIn('Pacific/Kiritimati'));
  assert.equal(forAl.todo.day, format.ymdIn('Pacific/Pago_Pago'));
  assert.notEqual(forStu.todo.day, forAl.todo.day, 'UTC+14 and UTC-11 are never on the same date');
  const plain = outreachState(); // people without a time zone
  assert.equal(auto.contactPipelineLocal(plain, 'c1', 'Sent').todo.day, format.ymdIn('Australia/Sydney'));
});

await check('automations: contactPipelineLocal creates the deal and the follow-up once', () => {
  const st = outreachState();
  const out = auto.contactPipelineLocal(st, 'c1', 'Sent', { day: '2026-10-12' });
  assert.deepEqual({ ...out.deal, id: '' }, {
    id: '', name: 'Example Water', sector: '', value: 0, priority: 'P2', stage: 'Opportunities', contact: 'stu', next: 'Reply to Pat Doe', contactId: 'c1',
  });
  assert.equal(st.deals.at(-1), out.deal, 'at the end of the pipeline');
  assert.deepEqual({ ...out.todo, id: '' }, {
    id: '', assignee: 'stu', createdBy: 'al', title: 'Follow up: Pat Doe replied', notes: '', day: '2026-10-12', start: '', minutes: 30,
    category: 'Outreach', source: 'automation', routineId: '', ref: 'contact:c1', done: false, doneAt: '',
  });
  assert.equal(auto.contactPipelineLocal(st, 'c1', 'Replied', { day: '2026-10-12' }), null, 'status unchanged');
  st.contacts[0].status = 'Meeting booked';
  const again = auto.contactPipelineLocal(st, 'c1', 'Replied', { day: '2026-10-12' });
  assert.equal(again.deal, out.deal);
  assert.equal(out.deal.stage, 'First meetings', 'a booking moves it on');
  assert.equal(again.todo, null, 'one follow-up per contact and day');
  st.contacts[0].status = 'Replied';
  auto.contactPipelineLocal(st, 'c1', 'Meeting booked', { day: '2026-10-13' });
  assert.equal(out.deal.stage, 'First meetings', 'never moves back');
  assert.equal(st.todos.at(-1).title, 'Follow up: Pat Doe replied');
  assert.equal(st.deals.length, 2);
  assert.equal(st.todos.length, 2);
});

await check('automations: contactPipelineLocal names, owners and stages', () => {
  const st = outreachState();
  const booked = auto.contactPipelineLocal(st, 'c2', '', { day: '2026-10-12' });
  assert.equal(booked.deal.name, 'Lee Roe', 'blank org: the contact name');
  assert.equal(booked.deal.stage, 'First meetings');
  assert.equal(booked.deal.next, 'Prepare meeting with Lee Roe');
  assert.equal(booked.deal.contact, 'al', 'no owner: whoever changed it');
  assert.equal(booked.todo.title, 'Prepare: meeting with Lee Roe');
  assert.equal(booked.todo.assignee, 'al');
  assert.equal(auto.contactPipelineLocal(st, 'c3', 'Sent'), null, 'Opened does nothing');
  assert.equal(auto.contactPipelineLocal(st, 'missing', ''), null);
  st.deals.push({ id: 'd-demo', name: 'Org', sector: '', value: 0, priority: 'P2', stage: 'Demos', contact: 'stu', next: '', contactId: 'c3' });
  st.contacts[2].status = 'Meeting booked';
  assert.equal(auto.contactPipelineLocal(st, 'c3', 'Opened', { day: '2026-10-12' }).deal.stage, 'Demos', 'Demos stays put');
});

await check('automations: a booking moves a deal on from Opportunities or Contacted, never back from later stages (0008)', () => {
  const at = (stage) => {
    const st = outreachState();
    st.deals.push({ id: 'd-x', name: 'Org', sector: '', value: 0, priority: 'P2', stage, contact: 'stu', next: '', contactId: 'c3' });
    st.contacts[2].status = 'Meeting booked';
    return auto.contactPipelineLocal(st, 'c3', 'Opened', { day: '2026-10-12' }).deal.stage;
  };
  assert.deepEqual(['Opportunities', 'Contacted', 'First meetings', 'Demos'].map(at), ['First meetings', 'First meetings', 'First meetings', 'Demos']);
});

await check('pipeline: stages Opportunities → Contacted → First meetings → Demos; dealStage() shows the old Won in Demos', async () => {
  const data = await import('../src/data/boards.js');
  assert.deepEqual(data.DEAL_STAGES, ['Opportunities', 'Contacted', 'First meetings', 'Demos']);
  assert.deepEqual(data.DEAL_PRIORITIES, ['P1', 'P2', 'P3']);
  assert.deepEqual(['Opportunities', 'Contacted', 'First meetings', 'Demos', 'Won', '', 'Lost', undefined].map((stage) => data.dealStage({ stage })),
    ['Opportunities', 'Contacted', 'First meetings', 'Demos', 'Demos', 'Opportunities', 'Opportunities', 'Opportunities']);
  assert.equal(data.dealStage(null), 'Opportunities');
  // 0008 makes the same moves in the database: Won → Demos, the booking rule from Opportunities or Contacted.
  const sql8 = readFileSync(new URL('0008_pipeline_stages.sql', migrationsDir), 'utf8');
  assert.match(sql8, /update public\.deals set stage = 'Demos' where stage = 'Won';/);
  assert.match(sql8, /v_stage in \('Opportunities', 'Contacted'\)/);
});

await check('pipeline: Work in Progress has a row per client with Details (text), Status and Contact (people), no dates', async () => {
  const data = await import('../src/data/boards.js');
  const wip = data.BOARD_SCHEMAS.pipeline;
  assert.deepEqual(wip.columns.map((c) => [c.key, c.label, c.type]), [['details', 'Details', 'text'], ['status', 'Status', 'status'], ['people', 'Contact', 'people']]);
  assert.deepEqual([data.itemWord(wip), data.itemWord(data.BOARD_SCHEMAS.projects), data.itemWord(undefined)], ['Client', 'Task', 'Task']);
  assert.deepEqual([data.hasDates(wip), data.hasDates(data.BOARD_SCHEMAS.projects), data.hasDates(data.BOARD_SCHEMAS.marketing)], [false, true, true]);
  // Imported rows: the Details column fills details (it beats Notes for that header), people and status as on every board.
  const { autoMap, normalise, fieldsFor } = await import('../src/lib/importers.js');
  assert.deepEqual(fieldsFor('tasks', 'pipeline').filter((f) => f.column).map((f) => f.key), ['details']);
  const headers = ['Client', 'Details', 'Status', 'Contact'];
  const map = autoMap(headers, 'tasks', 'pipeline');
  // The list's own headers map whole: Client (or Organisation) is the name there, and only there.
  assert.deepEqual([map.name, map.details, map.status, map.people], [0, 1, 2, 3]);
  assert.equal(autoMap(['Organisation', 'Details'], 'tasks', 'pipeline').name, 0);
  assert.deepEqual(((m) => [m.name, m.people])(autoMap(['Client', 'Task', 'Owner'], 'tasks', 'projects')), [1, 2]);
  assert.equal(autoMap(['Client', 'Details'], 'tasks', 'projects').name, -1);
  const users = [{ id: 'u1', name: 'Dale Example', email: 'dale@example.com' }];
  const rec = normalise('tasks', ['Example Council', 'Onboarding call', 'In progress', 'Dale Example'], { ...map, name: 0, people: 3 },
    { users, me: 'u1', board: 'pipeline' });
  assert.deepEqual([rec.name, rec.values.details, rec.values.status, rec.values.people], ['Example Council', 'Onboarding call', 'In progress', ['u1']]);
});

await check('pipeline: cleanDealPatch keeps valid edits only (Edit deal)', async () => {
  const { cleanDealPatch } = await import('../src/data/boards.js');
  const users = ['u1', 'u2'];
  assert.deepEqual(cleanDealPatch({ name: '  Example Water ', sector: ' Utilities ', next: ' Call ', value: '250000', priority: 'P1', stage: 'Contacted', contact: 'u2' }, users),
    { name: 'Example Water', sector: 'Utilities', next: 'Call', value: 250000, priority: 'P1', stage: 'Contacted', contact: 'u2' });
  assert.deepEqual(cleanDealPatch({ name: '   ', value: -5, priority: 'P9', stage: 'Won', contact: 'ghost' }, users), { contact: '' },
    'no blank name, negative value, unknown priority or stage; an unknown owner is none');
  assert.deepEqual(cleanDealPatch({ value: '' }, users), {}, 'an empty value is no change');
  assert.deepEqual(cleanDealPatch({ value: 0, sector: '' }, users), { value: 0, sector: '' });
  assert.deepEqual(cleanDealPatch({}, users), {});
  assert.deepEqual(cleanDealPatch({ id: 'x', clientId: 'c', contactId: 'p' }, users), {}, 'links and ids are never edited');
});

await check('automations: generateDueInvoicesLocal catches up every period, numbered in order', () => {
  const plan = (id, frequency, nextDate, amount, active = true) => ({ id, description: `Plan ${id}`, amount, frequency, nextDate, active });
  const st = {
    org: { invoicePrefix: 'EX-', paymentTermsDays: 14 },
    clients: [
      { id: 'cA', invoices: [{ id: 'old', number: 'EX-1005', lines: [] }], plans: [
        plan('pA', 'monthly', '2026-08-31', 2400), plan('pB', 'quarterly', '2026-12-01', 10), plan('pC', 'monthly', '2026-01-01', 10, false),
      ] },
      { id: 'cB', invoices: [], plans: [plan('pD', 'annually', '2025-10-12', 99.5), plan('pE', 'monthly', '', 10)] },
    ],
  };
  assert.equal(auto.generateDueInvoicesLocal(st, '2026-10-12', { uid: (() => { let i = 0; return () => `id${++i}`; })() }), 4);
  const [cA, cB] = st.clients;
  // Oldest plan date first: pD's two years, then pA's two months.
  assert.deepEqual(cB.invoices.map((i) => [i.number, i.issued, i.due]), [['EX-1007', '2026-10-12', '2026-10-26'], ['EX-1006', '2025-10-12', '2025-10-26']]);
  assert.deepEqual(cA.invoices.map((i) => [i.number, i.issued]), [['EX-1009', '2026-09-30'], ['EX-1008', '2026-08-31'], ['EX-1005', undefined]]);
  assert.deepEqual(cA.invoices[0], {
    id: 'id7', number: 'EX-1009', issued: '2026-09-30', due: '2026-10-14', status: 'Awaiting approval', planId: 'pA', sentAt: '', paidOn: '', sentTo: '',
    lines: [{ id: 'id8', desc: 'Plan pA', qty: '1', rate: '2400' }],
  });
  assert.equal(cB.invoices[0].lines[0].rate, '99.5');
  assert.deepEqual(st.clients.flatMap((c) => c.plans.map((p) => p.nextDate)), ['2026-10-31', '2026-12-01', '2026-01-01', '2027-10-12', ''],
    'the 31st stays the 31st; future, inactive and undated plans untouched');
  assert.equal(auto.generateDueInvoicesLocal(st, '2026-10-12'), 0, 'nothing due twice');
  assert.equal(cA.plans[0].anchorDay, 31, 'its billing day is kept with the plan');
});

await check('automations: billed one period per run, a plan on the 31st keeps its day (no month-end drift)', () => {
  const p31 = { id: 'p31', description: 'Retainer', amount: 100, frequency: 'monthly', nextDate: '2026-08-31', active: true }; // no anchorDay yet
  const st = { org: { invoicePrefix: 'EX-', paymentTermsDays: 30 }, clients: [{ id: 'c', invoices: [], plans: [p31] }] };
  const days = ['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31'];
  days.forEach((day) => assert.equal(auto.generateDueInvoicesLocal(st, day), 1, day));
  assert.deepEqual(st.clients[0].invoices.map((i) => i.issued).reverse(), days);
  assert.deepEqual([p31.nextDate, p31.anchorDay], ['2027-04-30', 31]);
  const once = { ...p31, nextDate: '2026-08-31', anchorDay: 31 };
  const st2 = { org: st.org, clients: [{ id: 'c', invoices: [], plans: [once] }] };
  auto.generateDueInvoicesLocal(st2, '2027-03-31');
  assert.deepEqual(st2.clients[0].invoices.map((i) => i.issued).reverse(), days, 'the same dates as one catch-up run');
});

await check('automations: a plan more than two years behind (a mistyped year) is left alone', () => {
  const plan = (id, frequency, nextDate) => ({ id, description: id, amount: 10, frequency, nextDate, anchorDay: 0, active: true });
  const st = { org: { invoicePrefix: 'EX-' }, clients: [{ id: 'c', invoices: [], plans: [plan('typo', 'monthly', '0026-07-01'), plan('two', 'quarterly', '2024-10-12')] }] };
  assert.equal(auto.generateDueInvoicesLocal(st, '2026-10-12'), 9, 'two years back still catches up');
  assert.deepEqual(st.clients[0].plans.map((p) => p.nextDate), ['0026-07-01', '2027-01-12']);
  assert.ok(st.clients[0].invoices.every((i) => i.planId === 'two'));
});

await check('import: deal stages map to the new columns (won, signed, quote or contract → Demos, contacted → Contacted, uncontacted → Opportunities)', async () => {
  const { normalise } = await import('../src/lib/importers.js');
  const stage = (v) => normalise('deals', ['Example Water', v], { name: 0, stage: 1 }, { users: [], me: 'u-me' }).stage;
  assert.deepEqual(['Opportunities', 'contacted', 'Emailed', 'Reached out', 'First meetings', 'Discovery call', 'Demo booked', 'Proposal',
    'Quote sent', 'Contract out', 'Won', 'Closed won', 'Signed', 'Client', 'Lost', "Won't proceed", 'Not signed', 'Uncontacted',
    'Un-contacted', 'Not yet contacted', '', 'Prospect'].map(stage),
  ['Opportunities', 'Contacted', 'Contacted', 'Contacted', 'First meetings', 'First meetings', 'Demos', 'Demos',
    'Demos', 'Demos', 'Demos', 'Demos', 'Demos', 'Demos', 'Opportunities', 'Opportunities', 'Opportunities', 'Opportunities',
    'Opportunities', 'Opportunities', 'Opportunities', 'Opportunities']);
});

await check('import: contact statuses as written, Meeting booked included (negated wording is not a booking)', async () => {
  const { normalise } = await import('../src/lib/importers.js');
  const status = (v) => normalise('contacts', ['Ben South', v], { name: 0, status: 1 }).status;
  assert.deepEqual(
    ['Meeting booked', 'meeting  booked', 'Booked', 'Replied - meeting booked', 'Meeting not booked', 'No meeting booked',
      'Cancelled meeting', 'Email scheduled', 'Replied', 'No reply', 'Sent', 'Opened', 'New'].map(status),
    ['Meeting booked', 'Meeting booked', 'Meeting booked', 'Meeting booked', 'New', 'New',
      'New', 'New', 'Replied', 'No reply', 'Sent', 'Opened', 'New'],
  );
});

if (createSeed) {
  await check('seed: the team, phase 2 demo data, and only placeholder emails', () => {
    const s = createSeed();
    const today = s.todos.find((t) => t.source === 'automation').day;
    assert.deepEqual(s.users.map((u) => [u.id, u.name, u.role, u.timezone]), [['david', 'David', 'superadmin', 'Australia/Sydney'],
      ['josh', 'Josh', 'admin', 'Asia/Tbilisi'], ['hello', 'Hello', 'staff', 'Asia/Manila']]);
    const emails = JSON.stringify(s).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || [];
    assert.ok(emails.length && emails.every((e) => e.endsWith('@example.com')), emails.filter((e) => !e.endsWith('@example.com')).join(', '));
    assert.ok(Array.isArray(s.boards));
    assert.ok(s.boards.find((b) => b.module === 'projects' && b.name === 'General').groups.some((g) => g.name === 'Admin'),
      'the former Admin board is a group on General');
    const items = s.boards.flatMap((b) => b.groups.flatMap((g) => g.items));
    assert.ok(items.every((it) => Array.isArray(it.values.people) && !('owner' in it.values)));
    assert.deepEqual(s.moduleAccess, [], 'staff start on the defaults (docs/PHASE2.md §1): no outreach for Hello');
    // Hello's day: an automation follow-up, a carried-over routine, and work the admins assigned.
    const hello = s.todos.filter((t) => t.assignee === 'hello');
    const quinn = s.contacts.find((c) => c.status === 'Replied' && s.todos.some((t) => t.ref === `contact:${c.id}`));
    assert.ok(quinn && s.deals.some((d) => d.contactId === quinn.id), 'a replied contact already has its deal');
    assert.ok(hello.some((t) => t.source === 'automation' && t.day === today && !t.done));
    assert.ok(hello.some((t) => t.source === 'routine' && t.day < today && !t.done), 'carried over');
    assert.ok(hello.some((t) => t.source === 'manual' && t.day === today && ['david', 'josh'].includes(t.createdBy)));
    if (auto.isoDow(today) <= 5) assert.ok(hello.some((t) => t.source === 'routine' && t.day === today));
    assert.equal(auto.ensureTodosLocal(s, today, { me: 'hello' }), 0, 'seeded routine to-dos follow the routines');
    assert.ok(s.routines.some((r) => r.title === 'LinkedIn engagement' && r.minutes === 60 && r.weekdays.join() === '1,2,3,4,5'));
    // Clients: plans, one invoice awaiting approval from a plan, payments that add up, a statement without a file.
    const invoices = s.clients.flatMap((c) => c.invoices);
    const awaiting = invoices.filter((i) => i.status === 'Awaiting approval');
    assert.equal(awaiting.length, 1);
    assert.ok(s.clients.some((c) => c.plans.some((p) => p.id === awaiting[0].planId)));
    s.payments.forEach((p) => assert.ok(invoices.some((i) => i.id === p.invoiceId) && s.clients.some((c) => c.id === p.clientId)));
    const paid = invoices.find((i) => i.status === 'Paid');
    assert.equal(s.payments.filter((p) => p.invoiceId === paid.id).reduce((t, p) => t + p.amount, 0), 7975);
    assert.ok(s.bankStatements.some((b) => b.filePath === ''));
    ['expenses', 'subscriptions', 'timeEntries', 'tools'].forEach((k) => assert.ok(s[k].length, k));
    assert.ok(s.tools.every((t) => t.user === 'hello' && t.username.endsWith('@example.com') && t.url.startsWith('https://')));
    assert.ok(s.clients.some((c) => c.usage.length));
    assert.equal(auto.generateDueInvoicesLocal(s, today), 0, 'plans are up to date');
  });

  await check('seed: own Projects pages for David, Josh and Hello, then the starting team boards (0006)', () => {
    const s = createSeed();
    const { BOARD_MODULES, STARTING_BOARDS, teamBoards, boardTitle, boardItems } = boardsLib;
    assert.deepEqual(s.boards.filter((b) => b.owner).map((b) => [b.module, b.name, b.owner]),
      [['projects', '', 'david'], ['projects', '', 'josh'], ['projects', '', 'hello']]);
    assert.deepEqual(s.boards.filter((b) => b.owner).map((b) => boardTitle(s, b)), ['David’s notes', 'Josh’s notes', 'Hello’s notes']);
    BOARD_MODULES.forEach((module) => assert.deepEqual(teamBoards(s, module).map((b) => b.name), STARTING_BOARDS[module], module));
    // Projects (own pages first), Marketing, then Outreach, as the live order has them; every board has somewhere to add
    // tasks.
    assert.deepEqual(s.boards.map((b) => `${b.module}:${b.owner ? 'own' : 'team'}`), [
      ...Array(3).fill('projects:own'), ...Array(STARTING_BOARDS.projects.length).fill('projects:team'),
      ...Array(STARTING_BOARDS.marketing.length).fill('marketing:team'), ...Array(STARTING_BOARDS.outreach.length).fill('outreach:team'),
      ...Array(STARTING_BOARDS.clients.length).fill('clients:team'), ...Array(STARTING_BOARDS.pipeline.length).fill('pipeline:team'),
    ]);
    assert.deepEqual(s.seededBoards, BOARD_MODULES, 'the demo has every module’s starting boards');
    s.boards.forEach((b) => assert.ok(b.groups.length, boardTitle(s, b)));
    // Ids are unique across boards, groups, tasks, updates and subtasks; people are real users.
    const ids = s.boards.flatMap((b) => [b.id, ...b.groups.flatMap((g) => [g.id, ...g.items.flatMap((it) => [
      it.id, ...it.updates.map((u) => u.id), ...it.subtasks.map((x) => x.id)])])]);
    assert.equal(new Set(ids).size, ids.length);
    const userIds = new Set(s.users.map((u) => u.id));
    s.boards.flatMap(boardItems).forEach((it) => it.values.people.forEach((p) => assert.ok(userIds.has(p), p)));
    // Who sees which page in the demo: David everyone's, Josh his and Hello's, Hello only hers (and every team board).
    const pagesFor = (me) => s.boards.filter((b) => access.canViewBoard({ ...s, me }, b));
    assert.deepEqual(['david', 'josh', 'hello'].map((me) => pagesFor(me).filter((b) => b.owner).map((b) => b.owner)),
      [['david', 'josh', 'hello'], ['josh', 'hello'], ['hello']]);
    assert.deepEqual(pagesFor('hello').filter((b) => !b.owner).map((b) => [b.name, access.canEditBoard({ ...s, me: 'hello' }, b)]),
      [...[...STARTING_BOARDS.projects, ...STARTING_BOARDS.marketing].map((n) => [n, true]),
        ...[...STARTING_BOARDS.clients, ...STARTING_BOARDS.pipeline].map((n) => [n, false])],
      'staff edit every Projects and Marketing team board by default (0006); Clients’, Pipeline’s and Outreach’s follow those modules (view, view, none)');
    // Outreach's boards follow each person's Outreach level: none by default for staff, then view or edit.
    const sales = teamBoards(s, 'outreach')[0];
    const helloAt = (level) => {
      const st = { ...s, me: 'hello', moduleAccess: [...(s.moduleAccess || []).filter((a) => !(a.userId === 'hello' && a.module === 'outreach')),
        ...(level ? [{ userId: 'hello', module: 'outreach', level }] : [])] };
      return [access.canViewBoard(st, sales), access.canEditBoard(st, sales)];
    };
    assert.deepEqual([helloAt(''), helloAt('view'), helloAt('edit')], [[false, false], [true, false], [true, true]]);
    assert.deepEqual(['david', 'josh'].map((me) => access.canEditBoard({ ...s, me }, sales)), [true, true], 'admins edit');
    assert.deepEqual(sales.groups.map((g) => g.name), ['To do', 'Done']);
    assert.deepEqual(teamBoards(s, 'clients').map((b) => [b.name, b.groups.map((g) => g.name)]), [['Demos', ['To do', 'Done']], ['Previews', ['To do']]]);
  });
}

if (migrate) {
  const phase1 = () => ({
    version: 1,
    me: 'dale',
    users: [
      { id: 'david', name: 'David', initials: 'DV', color: '#9cd326', email: 'david@example.com', role: 'admin', active: true },
      { id: 'dale', name: 'Dale', initials: 'DL', color: '#579bfc', email: 'dale@example.com', role: 'member', active: true },
      { id: 'sam', name: 'Sam', initials: 'SM', color: '#ff7575' },
    ],
    org: { businessName: 'AssetStack' },
    boards: {
      projects: { groups: [{ id: 'g1', name: 'Active', color: '#c9ffe6', items: [
        { id: 'i1', name: 'A', values: { owner: 'dale', status: 'Done' }, done: true, updates: [], subtasks: [] },
      ] }] },
      admin: { groups: [
        { id: 'g2', name: 'To do', color: '#ffe6b0', items: [{ id: 'i2', name: 'B', values: { owner: 'gone', status: 'Stuck' }, done: false, updates: [], subtasks: [] }] },
        { id: 'g3', name: 'This quarter', color: '#ffe6b0', items: [{ id: 'i3', name: 'C', values: { owner: '' }, done: false, updates: [], subtasks: [] }] },
      ] },
      marketing: { groups: [{ id: 'g4', name: 'October', color: '#bfe9ff', items: [
        { id: 'i4', name: 'D', values: { owner: 'sam', people: ['dale'] }, done: false, updates: [], subtasks: [] },
      ] }] },
    },
    deals: [{ id: 'd1', name: 'X', sector: '', value: 1, priority: 'P2', stage: 'Opportunities', contact: 'Dale', next: '' }],
    clients: [{
      id: 'c1', name: 'C', group: 'Active', status: 'Active', priority: 'P2', next: '', sector: '', contact: 'dale', team: ['dale'], lastContact: '',
      demo: '', keyContact: '', email: '', demoUrl: '', avatar: '#3b82f6', notes: [], tasks: [], access: [],
      invoices: [{ id: 'inv1', number: 'INV-1001', issued: '2026-09-01', due: '2026-10-01', status: 'Sent', lines: [] }],
    }],
    contacts: [{ id: 'p1', name: 'P', org: '', email: '', stage: 'Opportunity', status: 'New', last: '' }],
    emails: [], sequences: [], approvals: [],
    channels: [{ id: 'ch1', name: 'general', members: ['david', 'dale', 'sam'] }],
    messages: [],
    lastRead: { ch1: '2026-10-01T00:00:00.000Z' },
  });

  await check('migrate: phase 1 demo data gets roles, the merged board, people and the new lists', () => {
    const m = migrate(phase1());
    assert.deepEqual(m.users.map((u) => [u.id, u.role, u.email, u.active, u.timezone]), [
      ['david', 'superadmin', 'david@example.com', true, 'Australia/Sydney'], ['dale', 'staff', 'dale@example.com', true, 'Australia/Sydney'],
      ['sam', 'staff', 'sam@example.com', true, 'Australia/Sydney'],
    ]);
    assert.ok(Array.isArray(m.boards));
    const named = (module, name) => m.boards.find((b) => b.module === module && b.name === name && !b.owner);
    // The Projects groups (with the Admin board's at the end) go on General, Marketing's on Posting schedule (0006).
    assert.deepEqual(named('projects', 'General').groups.map((g) => [g.id, g.name]), [['g1', 'Active'], ['g2', 'Admin'], ['g3', 'This quarter']]);
    assert.deepEqual(named('marketing', 'Posting schedule').groups.map((g) => [g.id, g.name]), [['g4', 'October']]);
    assert.deepEqual(m.boards.filter((b) => b.owner).map((b) => [b.module, b.name, b.owner]),
      [['projects', '', 'david'], ['projects', '', 'dale'], ['projects', '', 'sam']], 'everyone has their own page');
    const values = Object.fromEntries(m.boards.flatMap((b) => b.groups.flatMap((g) => g.items)).map((it) => [it.id, it.values]));
    assert.deepEqual(values, {
      i1: { status: 'Done', people: ['dale'] }, i2: { status: 'Stuck', people: [] }, i3: { people: [] }, i4: { people: ['sam', 'dale'] },
    });
    assert.deepEqual([m.deals[0].contact, m.deals[0].contactId], ['dale', '']);
    assert.equal(m.contacts[0].owner, '');
    assert.deepEqual([m.clients[0].plans, m.clients[0].usage, m.clients[0].abn], [[], [], '']);
    assert.deepEqual(['planId', 'sentAt', 'paidOn'].map((k) => m.clients[0].invoices[0][k]), ['', '', '']);
    ['moduleAccess', 'todos', 'routines', 'payments', 'bankStatements', 'expenses', 'subscriptions', 'timeEntries', 'tools'].forEach((k) => assert.deepEqual(m[k], [], k));
    assert.deepEqual(m.lastRead.dale, { ch1: '2026-10-01T00:00:00.000Z' });
    assert.equal(m.org.invoicePrefix, 'INV-');
    assert.deepEqual(migrate(structuredClone(m)), m, 'running it again changes nothing');
    assert.deepEqual(plain(roundTrip({ ...m, mode: 'live' })), plain(flatten(m)));
    assert.equal(access.moduleLevel(m, 'outreach'), 'none', 'dale is staff now');
    assert.equal(auto.ensureTodosLocal(m, '2026-10-12'), 0);
  });

  await check('migrate: phase 2 demo data gets billing days and the routine run log', () => {
    const p = migrate(phase1());
    p.clients[0].plans = [{ id: 'bp', description: 'Licence', amount: 1, frequency: 'monthly', nextDate: '2026-10-31', active: true },
      { id: 'bp2', description: 'Later', amount: 1, frequency: 'monthly', nextDate: '', active: false }];
    p.routines = [{ id: 'r1', title: 'Post', category: 'LinkedIn', minutes: 10, assignee: 'dale', weekdays: [1], start: '', active: true }];
    p.todos = [auto.makeTodo({ assignee: 'dale', title: 'Post', day: '2026-10-12', source: 'routine', routineId: 'r1' })];
    delete p.routineRuns;
    const m = migrate(p);
    assert.deepEqual(m.clients[0].plans.map((x) => x.anchorDay), [31, 0]);
    assert.deepEqual(m.routineRuns, ['2026-10-12|r1|dale']);
    m.todos = [];
    assert.equal(auto.ensureTodosLocal(m, '2026-10-12'), 0, 'a routine to-do deleted before the upgrade stays deleted');
  });

  await check('migrate: an existing superadmin is kept, and the seed is already current', () => {
    const p = phase1();
    p.users[1].role = 'superadmin';
    p.users[2].timezone = 'Asia/Manila';
    assert.deepEqual(migrate(p).users.map((u) => [u.role, u.timezone]),
      [['admin', 'Australia/Sydney'], ['superadmin', 'Australia/Sydney'], ['staff', 'Asia/Manila']], 'a time zone already set is kept');
    const s = createSeed();
    assert.deepEqual(migrate(structuredClone(s)), s);
  });

  await check('migrate: 0004 turns the key contact / email into a billing contact, once', () => {
    const p = migrate(phase1());
    const old = structuredClone(p);
    old.clients[0].keyContact = 'Dale Example';
    old.clients[0].email = ' Dale@Example.com ';
    delete old.clients[0].contacts;
    delete old.clients[0].contracts;
    delete old.clients[0].platformUrl;
    old.clients[0].usage = [{ id: 'u', month: '2026-10-01', assets: 1, sites: 1, seats: 1, notes: '' }];
    old.clients[0].invoices.forEach((inv) => { delete inv.sentTo; });
    const m = migrate(old);
    const c = m.clients[0];
    assert.deepEqual(c.contacts.map(({ id: _id, ...x }) => x), [{ name: 'Dale Example', role: '', email: 'dale@example.com', phone: '', billing: true }]);
    assert.ok(!('keyContact' in c) && !('email' in c));
    assert.deepEqual([c.platformUrl, c.contracts, c.usage[0].credits, c.invoices[0].sentTo], ['', [], 0, '']);
    assert.deepEqual(migrate(structuredClone(m)), m, 'running it again changes nothing');
    assert.deepEqual(phase1().clients.map((x) => migrate({ ...phase1(), clients: [{ ...x, keyContact: '', email: '' }] }).clients[0].contacts), [[]],
      'no key contact: no contacts');
  });

  await check('migrate: 0006 sub-boards — the starting team boards, the old groups on them, one own page per person, once', () => {
    const { BOARD_MODULES, STARTING_BOARDS, EXISTING_BOARD, FIRST_GROUP, FIRST_GROUP_COLOR } = boardsLib;
    const boardIds = (data) => data.boards.flatMap((b) => [b.id, ...b.groups.map((g) => g.id)]);
    // Every user has exactly one personal Projects page, with one empty group.
    const ownPages = (data) => {
      data.users.forEach((u) => assert.equal(data.boards.filter((b) => b.owner === u.id).length, 1, u.id));
      data.boards.filter((b) => b.owner).forEach((b) => assert.deepEqual([b.module, b.name], ['projects', ''], b.owner));
    };
    const m = migrate(phase1());
    ownPages(m);
    m.boards.filter((b) => b.owner).forEach((b) => assert.deepEqual(b.groups.map((g) => [g.name, g.color, g.items]), [['Active', FIRST_GROUP_COLOR, []]]));
    // The starting team boards in order: the old groups on General / Posting schedule, the others one empty group.
    BOARD_MODULES.forEach((module) => {
      const starting = m.boards.filter((b) => b.module === module && !b.owner);
      assert.deepEqual(starting.map((b) => b.name), STARTING_BOARDS[module], module);
      starting.filter((b) => b.name !== EXISTING_BOARD[module])
        .forEach((b) => assert.deepEqual(b.groups.map((g) => [g.name, g.color, g.items]), [[FIRST_GROUP[module], FIRST_GROUP_COLOR, []]], b.name));
    });
    assert.equal(new Set(boardIds(m)).size, boardIds(m).length, 'ids unique');
    // Running it again adds nothing; someone new gets their page on the next run, and nothing else changes.
    assert.deepEqual(migrate(structuredClone(m)), m);
    const more = structuredClone(m);
    more.users.push({ id: 'newbie', name: 'Newbie', initials: 'NB', color: '#579bfc', email: 'newbie@example.com', role: 'staff', active: true,
      timezone: 'Asia/Manila' });
    const after = migrate(more);
    ownPages(after);
    assert.deepEqual(after.boards.filter((b) => b.owner !== 'newbie'), m.boards);
    assert.equal(new Set(boardIds(after)).size, boardIds(after).length);
    // Older shapes: no Marketing groups (Posting schedule starts with one), or no boards at all.
    [{ projects: { groups: [] } }, undefined, {}].forEach((boards) => {
      const x = migrate({ ...phase1(), boards });
      ownPages(x);
      assert.deepEqual(x.boards.filter((b) => !b.owner).map((b) => [b.module, b.name, b.groups.map((g) => g.name)]),
        BOARD_MODULES.flatMap((module) => STARTING_BOARDS[module].map((name) => [module, name, [FIRST_GROUP[module]]])), JSON.stringify(boards));
      assert.equal(new Set(boardIds(x)).size, boardIds(x).length);
      assert.deepEqual(plain(roundTrip({ ...x, mode: 'live' })), plain(flatten(x)));
    });
  });
}

let timesheet = null;
try {
  timesheet = await import('../src/lib/timesheet.js');
} catch (e) {
  console.log(`SKIP suggestBlocks: src/lib/timesheet.js is not importable in Node (${String(e?.message).split('\n')[0]})`);
}
if (timesheet?.suggestBlocks) {
  await check('timesheet: suggestBlocks gives eight hourly blocks, Other when nothing was done', () => {
    const blocks = timesheet.suggestBlocks({ todosDone: [], emailsSent: [], itemsTouched: [], messagesSent: [] }, { start: '09:00', end: '17:00' });
    assert.deepEqual(blocks.map((b) => b.start), ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
    assert.ok(blocks.every((b) => b.category === 'Other'));
  });
}

// ── Outreach (0007): src/lib/outreach.js, the demo seed and its migration ──────
// The lib is what demo mode computes with and what outreach_daily() / outreach_breakdown() must equal in live mode
// (scripts/test-db.mjs compares the two on the same rows); here, every export on its own.

const outreach = await import('../src/lib/outreach.js');
// An app-shape row: emailFromRow()'s defaults with the fields a case needs.
const em = (id, mailbox, f = {}) => ({ ...outreach.emailFromRow({ id, row_key: `rk-${id}`, mailbox_id: mailbox }), ...f });
const sortedRows = (list) => list.map((r) => JSON.stringify(r)).sort();

await check('outreach: emailFromRow maps a database row to the app shape; defaults for a blank row; null mailbox is Unassigned', () => {
  assert.deepEqual(outreach.emailFromRow(), {
    id: '', rowKey: '', mailbox: '', sender: '', dateLogged: '', vertical: '', organisation: '', domain: '', location: '', contactName: '',
    contactRole: '', contactEmail: '', tier: '', signal: '', subject: '', variant: '', status: '', sentOn: '', messageId: '', threadId: '',
    sequenceStatus: '', followupStage: 0, nextFollowup: '', bounced: false, replyStatus: '', replyOn: '', replySummary: '', note: '',
    meetingOn: '', inSheet: true,
  });
  const row = {
    id: 'e-1', row_key: 'pat@example.com|2026-10-05', mailbox_id: null, sender: ' david@example.com ', date_logged: '2026-10-05',
    vertical: 'Local government', organisation: ' Northbrook Shire Council ', domain: 'example.com', location: 'Northbrook VIC',
    contact_name: 'Pat Example', contact_role: 'Asset Manager', contact_email: 'pat@example.com', tier: 'A', signal: 'Open tender',
    subject: 'Asset data', variant: 'v2', status: 'sent', sent_on: '2026-10-06T03:00:00+00:00', message_id: '18c2f0a1b2c3d4e5',
    thread_id: '18c2f0a1b2c3d4e5', sequence_status: 'replied-negative', followup_stage: '2', next_followup: null, bounced: true,
    reply_status: 'negative', reply_on: '05/10/2026', reply_summary: 'Not now.', note: '', meeting_on: '2026-10-09', in_sheet: false,
    raw: { kdm_name: 'Pat Example' }, synced_at: '2026-10-18T00:00:00+00:00', updated_at: '2026-10-18T00:00:00+00:00', updated_by: null,
  };
  const e = outreach.emailFromRow(row);
  assert.deepEqual(e, {
    id: 'e-1', rowKey: 'pat@example.com|2026-10-05', mailbox: '', sender: 'david@example.com', dateLogged: '2026-10-05',
    vertical: 'Local government', organisation: 'Northbrook Shire Council', domain: 'example.com', location: 'Northbrook VIC',
    contactName: 'Pat Example', contactRole: 'Asset Manager', contactEmail: 'pat@example.com', tier: 'A', signal: 'Open tender',
    subject: 'Asset data', variant: 'v2', status: 'sent', sentOn: '2026-10-06', messageId: '18c2f0a1b2c3d4e5', threadId: '18c2f0a1b2c3d4e5',
    sequenceStatus: 'replied-negative', followupStage: 2, nextFollowup: '', bounced: true, replyStatus: 'negative', replyOn: '',
    replySummary: 'Not now.', note: '', meetingOn: '2026-10-09', inSheet: false,
  }, 'dates cut to the day (an unreadable one is blank), text trimmed, extra columns dropped');
  assert.equal(outreach.emailFromRow({ ...row, mailbox_id: 'mb-1', in_sheet: null, followup_stage: 'x' }).mailbox, 'mb-1');
  assert.equal(outreach.emailFromRow({ ...row, in_sheet: null }).inSheet, true, 'only false means out of the sheet');
  assert.equal(outreach.emailFromRow({ ...row, followup_stage: 'x' }).followupStage, 0);
});

await check('outreach: emailKey is the Gmail message id, else the row key, else the id', () => {
  assert.equal(outreach.emailKey(em('1', 'mb-a', { messageId: 'm1' })), 'm1');
  assert.equal(outreach.emailKey(em('1', 'mb-a')), 'rk-1');
  assert.equal(outreach.emailKey({ ...em('1', 'mb-a'), rowKey: '' }), '1');
});

// Per-day fixture for the week 2026-10-05 … 2026-10-11.
const DAILY_ROWS = () => [
  em('1', 'mb-a', { sentOn: '2026-10-04' }), // the day before
  em('2', 'mb-a', { sentOn: '2026-10-05' }), // the first day
  em('3', 'mb-b', { sentOn: '2026-10-05', bounced: true }),
  em('4', '', { sentOn: '2026-10-05' }), // Unassigned: last in its day
  em('5', 'mb-a', { sentOn: '2026-10-11' }), // the last day
  em('6', 'mb-a', { sentOn: '2026-10-12' }), // the day after
  em('7', 'mb-a', { dateLogged: '2026-10-06', bounced: true }), // bounced but never sent: nothing
  em('8', 'mb-a', { sentOn: '2026-10-01', bounced: true, replyStatus: 'negative', replyOn: '2026-10-06' }), // only its reply is in the week
  em('9', 'mb-a', { sentOn: '2026-10-06', replyOn: '2026-10-07' }), // a reply day without a kind: no reply
  em('10', 'mb-a', { sentOn: '2026-10-06', replyStatus: 'neutral' }), // a kind without a day: no reply
  em('11', 'mb-b', { sentOn: '2026-10-07', replyStatus: 'positive', replyOn: '2026-10-08', meetingOn: '2026-10-10' }),
  // One email to two contacts: once, bounced when either bounced, its first reply and first meeting.
  em('12a', 'mb-a', { messageId: 'm12', sentOn: '2026-10-08', bounced: true, replyStatus: 'positive', replyOn: '2026-10-10', meetingOn: '2026-10-11' }),
  em('12b', 'mb-a', { messageId: 'm12', sentOn: '2026-10-08', replyStatus: 'negative', replyOn: '2026-10-09', meetingOn: '2026-10-12' }),
  // ...sent on two days: the first.
  em('13a', 'mb-a', { messageId: 'm13', sentOn: '2026-10-09' }),
  em('13b', 'mb-a', { messageId: 'm13', sentOn: '2026-10-08' }),
  // One message id in two mailboxes: an email each.
  em('14a', 'mb-a', { messageId: 'm14', sentOn: '2026-10-09' }),
  em('14b', 'mb-b', { messageId: 'm14', sentOn: '2026-10-09' }),
  // Out of the sheet: nothing, not even as an email's earlier row.
  em('15a', 'mb-a', { messageId: 'm15', sentOn: '2026-10-05', bounced: true, replyStatus: 'positive', replyOn: '2026-10-06', meetingOn: '2026-10-07', inSheet: false }),
  em('15b', 'mb-a', { messageId: 'm15', sentOn: '2026-10-10' }),
  em('16', '', { sentOn: '2026-10-10', inSheet: false }),
];
const day = (d, mailbox, sent, replies, bounces, meetings) => ({ day: `2026-10-${d}`, mailbox, sent, replies, bounces, meetings });
const DAILY_WEEK = [
  day('05', 'mb-a', 1, 0, 0, 0), day('05', 'mb-b', 1, 0, 1, 0), day('05', '', 1, 0, 0, 0),
  day('06', 'mb-a', 2, 1, 0, 0),
  day('07', 'mb-b', 1, 0, 0, 0),
  day('08', 'mb-a', 2, 0, 1, 0), day('08', 'mb-b', 0, 1, 0, 0),
  day('09', 'mb-a', 1, 1, 0, 0), day('09', 'mb-b', 1, 0, 0, 0),
  day('10', 'mb-a', 1, 0, 0, 0), day('10', 'mb-b', 0, 0, 0, 1),
  day('11', 'mb-a', 1, 0, 0, 1),
];

await check('outreach: outreachDaily counts emails per day and mailbox (inclusive days; bounces only on sent; replies need a kind; '
  + 'two contacts on one message once; out-of-sheet rows never), by day then mailbox, Unassigned last', () => {
  assert.deepEqual(outreach.outreachDaily(DAILY_ROWS(), '2026-10-05', '2026-10-11'), DAILY_WEEK);
  assert.deepEqual(outreach.outreachDaily(DAILY_ROWS().reverse(), '2026-10-05', '2026-10-11'), DAILY_WEEK, 'whatever the rows\' order');
  assert.deepEqual(outreach.outreachDaily(DAILY_ROWS(), '2026-10-05', '2026-10-05'), DAILY_WEEK.slice(0, 3), 'one day');
  assert.deepEqual(outreach.outreachDaily(DAILY_ROWS(), '2026-10-04', '2026-10-04'), [day('04', 'mb-a', 1, 0, 0, 0)]);
  assert.deepEqual(outreach.outreachDaily(DAILY_ROWS(), '2026-10-01', '2026-10-01'), [day('01', 'mb-a', 1, 0, 1, 0)], 'bounced on its sent day');
  assert.deepEqual(outreach.outreachDaily(DAILY_ROWS(), '2026-10-12', '2026-10-12'), [day('12', 'mb-a', 1, 0, 0, 0)],
    'the later meeting of an email that already met counts for nothing');
  assert.deepEqual(outreach.outreachDaily(DAILY_ROWS(), '2026-10-11', '2026-10-05'), [], 'a reversed range');
  [null, undefined, []].forEach((rows) => assert.deepEqual(outreach.outreachDaily(rows, '2026-10-05', '2026-10-11'), []));
  // Unassigned is last in its day whatever the mailbox ids; rows without a message id are each their own email.
  const order = outreach.outreachDaily([em('x', '', { sentOn: '2026-10-05' }), em('y', 'zz', { sentOn: '2026-10-05' }),
    em('z', '0a', { sentOn: '2026-10-05' }), em('w', '', { sentOn: '2026-10-04' })], '2026-10-01', '2026-10-31');
  assert.deepEqual(order.map((d) => `${d.day} ${d.mailbox || '-'} ${d.sent}`), ['2026-10-04 - 1', '2026-10-05 0a 1', '2026-10-05 zz 1', '2026-10-05 - 1']);
  assert.equal(outreach.outreachDaily([em('p', 'mb-a', { sentOn: '2026-10-05' }), em('q', 'mb-a', { sentOn: '2026-10-05' })], '2026-10-05', '2026-10-05')[0].sent, 2);
});

await check('outreach: outreachBreakdown counts contacts logged per row by status, and emails by their first reply\'s kind '
  + '(a same-day tie: the smaller kind, byte order)', () => {
  const rows = [
    em('1', 'mb-a', { dateLogged: '2026-10-04', status: 'sent' }), // before
    em('2', 'mb-a', { dateLogged: '2026-10-05', status: 'sent' }),
    em('3', 'mb-a', { dateLogged: '2026-10-11', status: 'sent' }),
    em('4', 'mb-a', { dateLogged: '2026-10-06', status: 'draft-saved' }),
    em('5', '', { dateLogged: '2026-10-06', status: '' }),
    em('6', 'mb-a', { dateLogged: '2026-10-07', status: 'sent', inSheet: false }),
    em('7a', 'mb-b', { messageId: 'm7', dateLogged: '2026-10-07', status: 'sent', replyStatus: 'referral', replyOn: '2026-10-08' }),
    em('7b', 'mb-b', { messageId: 'm7', dateLogged: '2026-10-07', status: 'sent', replyStatus: 'negative', replyOn: '2026-10-08' }),
    em('8a', 'mb-b', { messageId: 'm8', dateLogged: '2026-10-01', status: 'sent', replyStatus: 'positive', replyOn: '2026-10-09' }),
    em('8b', 'mb-b', { messageId: 'm8', dateLogged: '2026-10-01', status: 'sent', replyStatus: 'negative', replyOn: '2026-10-12' }),
    em('9a', '', { messageId: 'm9', replyStatus: 'negative', replyOn: '2026-10-10' }),
    em('9b', '', { messageId: 'm9', replyStatus: 'Positive', replyOn: '2026-10-10' }), // 'P' < 'n'
    em('10', 'mb-a', { replyStatus: 'neutral', replyOn: '2026-10-12' }), // after
    em('11', 'mb-a', { replyStatus: 'neutral' }), // no day
    em('12', 'mb-a', { replyOn: '2026-10-06' }), // no kind
    em('13a', 'mb-a', { messageId: 'm13', replyStatus: 'positive', replyOn: '2026-10-04' }), // first reply before the week…
    em('13b', 'mb-a', { messageId: 'm13', replyStatus: 'negative', replyOn: '2026-10-06' }), // …so a later one in it doesn't count
    em('14', 'mb-a', { replyStatus: 'negative', replyOn: '2026-10-07', inSheet: false }),
  ];
  const want = [
    { mailbox: 'mb-a', kind: 'status', value: 'sent', n: 2 }, { mailbox: 'mb-a', kind: 'status', value: 'draft-saved', n: 1 },
    { mailbox: '', kind: 'status', value: '', n: 1 }, { mailbox: 'mb-b', kind: 'status', value: 'sent', n: 2 },
    { mailbox: 'mb-b', kind: 'reply', value: 'negative', n: 1 }, { mailbox: 'mb-b', kind: 'reply', value: 'positive', n: 1 },
    { mailbox: '', kind: 'reply', value: 'Positive', n: 1 },
  ];
  assert.deepEqual(sortedRows(outreach.outreachBreakdown(rows, '2026-10-05', '2026-10-11')), sortedRows(want));
  assert.deepEqual(sortedRows(outreach.outreachBreakdown([...rows].reverse(), '2026-10-05', '2026-10-11')), sortedRows(want), 'whatever the order');
  assert.deepEqual(sortedRows(outreach.outreachBreakdown(rows, '2026-10-04', '2026-10-04')),
    sortedRows([{ mailbox: 'mb-a', kind: 'status', value: 'sent', n: 1 }, { mailbox: 'mb-a', kind: 'reply', value: 'positive', n: 1 }]));
  [null, undefined, []].forEach((x) => assert.deepEqual(outreach.outreachBreakdown(x, '2026-10-05', '2026-10-11'), []));
  // The reply in the breakdown is the one the daily counts: same email, same day.
  const replies = outreach.outreachDaily(rows, '2026-10-05', '2026-10-11').reduce((t, d) => t + d.replies, 0);
  assert.equal(replies, want.filter((x) => x.kind === 'reply').reduce((t, x) => t + x.n, 0));
});

await check('outreach: outreachTotals sums days for all mailboxes or one (\'\' = Unassigned), with reply and bounce rates', () => {
  // Sheet rows: every email is a prospect (started = sent); no auto-replies.
  const r = (sent, replies, bounces, meetings) => ({
    sent, started: sent, replies, autos: 0, bounces, meetings, replyRate: sent ? replies / sent : 0, bounceRate: sent ? bounces / sent : 0,
  });
  assert.deepEqual(outreach.outreachTotals(DAILY_WEEK), r(12, 3, 2, 2));
  assert.deepEqual(outreach.outreachTotals(DAILY_WEEK, null), r(12, 3, 2, 2));
  assert.deepEqual(outreach.outreachTotals(DAILY_WEEK, 'mb-a'), r(8, 2, 1, 1));
  assert.deepEqual(outreach.outreachTotals(DAILY_WEEK, 'mb-b'), r(3, 1, 1, 1));
  assert.deepEqual(outreach.outreachTotals(DAILY_WEEK, ''), r(1, 0, 0, 0), 'Unassigned only');
  assert.deepEqual(outreach.outreachTotals(DAILY_WEEK, 'mb-x'), r(0, 0, 0, 0), 'no sends: rates 0, not NaN');
  assert.deepEqual(outreach.outreachTotals(null), r(0, 0, 0, 0));
  assert.deepEqual(outreach.outreachTotals([day('05', 'mb-a', 0, 2, 0, 1)]), r(0, 2, 0, 1), 'replies without sends in the period: rate 0');
});

await check('outreach: filterEmails lists contacts in the sheet by mode, mailbox and search, newest first, a page at a time', () => {
  const rows = [
    em('a', 'mb-a', { sentOn: '2026-10-06', dateLogged: '2026-10-05', organisation: 'Northbrook Shire', contactName: 'Alex Morgan', subject: 'Asset data' }),
    em('b', 'mb-a', { sentOn: '2026-10-08', dateLogged: '2026-10-08', organisation: 'Riverbend Water', contactRole: 'Asset Manager',
      replyStatus: 'negative', replyOn: '2026-10-09' }),
    em('c', 'mb-b', { sentOn: '2026-10-08', dateLogged: '2026-10-07', contactEmail: 'casey@example.com', replyOn: '2026-10-09' }), // no kind
    em('d', '', { sentOn: '2026-10-07', sender: 'Unknown@Example.com' }),
    em('e', 'mb-a', { dateLogged: '2026-10-09', status: 'draft-saved', vertical: 'Water utility', location: 'Riverbend QLD' }),
    em('f', 'mb-a', { sentOn: '2026-10-09', dateLogged: '2026-10-09', organisation: 'Gone Council', inSheet: false }),
    em('g', 'mb-b', { sentOn: '2026-10-12', replyStatus: 'positive', replyOn: '2026-10-11' }),
  ];
  const wk = { from: '2026-10-05', to: '2026-10-11' };
  const ids = (opts) => outreach.filterEmails(rows, { ...wk, ...opts }).rows.map((e) => e.id);
  assert.deepEqual(ids({}), ['b', 'c', 'd', 'a'], 'sent in the period (the default), newest first, then id; out-of-sheet rows never');
  assert.deepEqual(ids({ only: 'replies' }), ['g', 'b'], 'replied in the period, with a kind');
  assert.deepEqual(ids({ only: 'logged' }), ['e', 'b', 'c', 'a']);
  assert.deepEqual([ids({ mailbox: 'mb-a' }), ids({ mailbox: 'mb-b' }), ids({ mailbox: '' }), ids({ mailbox: null })],
    [['b', 'a'], ['c'], ['d'], ['b', 'c', 'd', 'a']], "a mailbox, Unassigned (''), all (null)");
  assert.deepEqual([ids({ search: 'riverbend' }), ids({ search: ' RIVERBEND ' }), ids({ search: 'asset manager' }), ids({ search: 'casey@' }),
    ids({ search: 'unknown@example' }), ids({ search: 'alex' }), ids({ search: 'asset data' }), ids({ search: '   ' })],
  [['b'], ['b'], ['b'], ['c'], ['d'], ['a'], ['a'], ['b', 'c', 'd', 'a']], 'organisation, role, email, sender, contact, subject; any case');
  assert.deepEqual([ids({ only: 'logged', search: 'water' }), ids({ only: 'logged', search: 'qld' })], [['b'], []],
    'vertical and location aren\'t searched');
  const page = (limit, offset) => { const r = outreach.filterEmails(rows, { ...wk, limit, offset }); return [r.rows.map((e) => e.id), r.more]; };
  assert.deepEqual([page(2, 0), page(2, 2), page(2, 4), page(3, 1), page(4, 0)],
    [[['b', 'c'], true], [['d', 'a'], false], [[], false], [['c', 'd', 'a'], false], [['b', 'c', 'd', 'a'], false]]);
  assert.equal(outreach.filterEmails(rows, wk).rows.length, 4, 'limit 50, offset 0 by default');
  assert.deepEqual(outreach.filterEmails(null, wk), { rows: [], more: false });
});

await check('outreach: periodRange (n days ending today, across months, years and a leap day) and daysBetween', () => {
  assert.deepEqual(outreach.periodRange(7, '2026-10-18'), { from: '2026-10-12', to: '2026-10-18' });
  [1, 0, -3].forEach((n) => assert.deepEqual(outreach.periodRange(n, '2026-10-18'), { from: '2026-10-18', to: '2026-10-18' }, String(n)));
  assert.equal(outreach.periodRange(7, '2026-03-03').from, '2026-02-25');
  assert.equal(outreach.periodRange(3, '2026-03-01').from, '2026-02-27');
  assert.equal(outreach.periodRange(3, '2028-03-01').from, '2028-02-28', 'leap year');
  assert.equal(outreach.periodRange(30, '2027-01-15').from, '2026-12-17');
  assert.equal(outreach.periodRange(14, '2026-10-05').from, '2026-09-22', 'a daylight-saving change in between moves nothing');
  [1, 7, 14, 30, 90].forEach((n) => {
    const { from, to } = outreach.periodRange(n, '2026-10-18');
    assert.equal(outreach.daysBetween(from, to).length, n, String(n));
  });
  assert.deepEqual(outreach.daysBetween('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(outreach.daysBetween('2026-12-31', '2027-01-01'), ['2026-12-31', '2027-01-01']);
  assert.deepEqual(outreach.daysBetween('2028-02-28', '2028-03-01'), ['2028-02-28', '2028-02-29', '2028-03-01']);
  assert.deepEqual(outreach.daysBetween('2026-10-18', '2026-10-18'), ['2026-10-18']);
  assert.deepEqual(outreach.daysBetween('2026-10-18', '2026-10-17'), []);
});

await check('outreach: parseAddresses and mailboxFor (a sender\'s mailbox, any case; \'\' when none lists it)', () => {
  assert.deepEqual(outreach.parseAddresses('A@x.com, b@y.com; c@z.com\nd@w.com  e@v.com'), ['a@x.com', 'b@y.com', 'c@z.com', 'd@w.com', 'e@v.com']);
  assert.deepEqual(outreach.parseAddresses('a@x.com A@X.COM a@x.com'), ['a@x.com'], 'distinct, lower-case');
  assert.deepEqual(outreach.parseAddresses('nope, a@b, @x.com, two@@example.com, good@example.com'), ['good@example.com'], 'invalid ones dropped');
  assert.deepEqual(outreach.parseAddresses([' A@Example.com ', 'b@example.com', '', 'b@example.com']), ['a@example.com', 'b@example.com']);
  [null, undefined, '', '  , ;'].forEach((x) => assert.deepEqual(outreach.parseAddresses(x), [], String(x)));
  const boxes = [
    { id: 'mb-a', addresses: outreach.parseAddresses('Ana@Example.com, ana@old.example.com') },
    { id: 'mb-b', addresses: ['ben@example.com'] },
    { id: 'mb-c' }, // no addresses yet
  ];
  assert.deepEqual([' Ana@Old.Example.com ', 'ana@example.com', 'BEN@example.com', 'someone@example.com', '', null].map((s) => outreach.mailboxFor(boxes, s)),
    ['mb-a', 'mb-a', 'mb-b', '', '', '']);
  assert.equal(outreach.mailboxFor(undefined, 'ana@example.com'), '');
});

await check('outreach: gmailThreadUrl (the sending mailbox\'s Gmail, encoded) and sheetFromUrl (id and tab; \'\' for other links)', () => {
  assert.equal(outreach.gmailThreadUrl('ana@example.com', '18c2f0a1b2c3d4e5'), 'https://mail.google.com/mail/u/ana%40example.com/#all/18c2f0a1b2c3d4e5');
  assert.equal(outreach.gmailThreadUrl(' ana@example.com ', ' 18c2f0a1b2c3d4e5 '), 'https://mail.google.com/mail/u/ana%40example.com/#all/18c2f0a1b2c3d4e5');
  assert.equal(outreach.gmailThreadUrl('a+b@example.com', 'x/y z'), 'https://mail.google.com/mail/u/a%2Bb%40example.com/#all/x%2Fy%20z');
  assert.equal(outreach.gmailThreadUrl('', 'abc'), 'https://mail.google.com/mail/u/0/#all/abc', 'no sender: the first signed-in account');
  [['ana@example.com', ''], ['ana@example.com', null], ['', '  ']].forEach(([s, t]) => assert.equal(outreach.gmailThreadUrl(s, t), ''));
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123-456';
  const base = `https://docs.google.com/spreadsheets/d/${id}`;
  assert.deepEqual(outreach.sheetFromUrl(`${base}/edit#gid=123`), { id, gid: '123' });
  assert.deepEqual(outreach.sheetFromUrl(`${base}/edit?gid=0#gid=0`), { id, gid: '0' });
  assert.deepEqual(outreach.sheetFromUrl(`${base}/edit?usp=sharing&gid=55`), { id, gid: '55' });
  assert.deepEqual(outreach.sheetFromUrl(`${base}/edit`), { id, gid: '' });
  assert.deepEqual(outreach.sheetFromUrl(` ${base} `), { id, gid: '' });
  [`https://docs.google.com/document/d/${id}/edit`, `https://example.com/spreadsheets/d/${id}`, 'https://docs.google.com/spreadsheets/d/short/edit',
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vExample/pubhtml', '', null, undefined]
    .forEach((url) => assert.deepEqual(outreach.sheetFromUrl(url), { id: '', gid: '' }, String(url)));
});

// ── Outreach from Gmail (0010): the mirrors of outreach_gmail_daily() / _breakdown() / _threads() and mergeDaily ──
const th = (id, mailbox, f = {}) => ({ ...outreach.threadFromRow({ id, mailbox_id: mailbox, thread_id: `t${id}` }), ...f });
const msg = (thread, kind, d) => ({ mailbox: thread.mailbox, messageId: `${thread.threadId}-${kind}-${d}`, threadId: thread.threadId, kind, day: `2026-10-${d}` });
// The week 2026-10-05 … 2026-10-11 again.
const GMAIL_THREADS = () => [
  th('1', 'mb-a', { firstDay: '2026-10-04', replyDay: '2026-10-05' }), // started the day before; only its reply is in the week
  th('2', 'mb-a', { firstDay: '2026-10-05', sentCount: 3, autoDay: '2026-10-05', prospectEmail: 'pat@example.com' }),
  th('3', 'mb-b', { firstDay: '2026-10-06', bounceDay: '2026-10-06', prospectName: 'Casey Ng' }),
  th('4', 'mb-a', { firstDay: '2026-10-11', replyDay: '2026-10-12', subject: 'Bridges' }), // replied the day after
  th('5', 'mb-b', { firstDay: '2026-10-12' }), // the day after
  th('6', 'mb-a', { firstDay: '2026-10-07', autoDay: '2026-10-07', replyDay: '2026-10-08', prospectEmail: 'pat@example.com' }),
];
const GMAIL_MESSAGES = () => {
  const [t1, t2, t3, t4, t5, t6] = GMAIL_THREADS();
  return [
    msg(t1, 'sent', '04'), msg(t1, 'reply', '05'),
    msg(t2, 'sent', '05'), msg(t2, 'auto', '05'), msg(t2, 'sent', '08'), msg(t2, 'sent', '11'),
    msg(t3, 'sent', '06'), msg(t3, 'bounce', '06'),
    msg(t4, 'sent', '11'), msg(t5, 'sent', '12'),
    msg(t6, 'sent', '07'), msg(t6, 'auto', '07'), msg(t6, 'reply', '08'),
  ];
};
const g = (d, mailbox, sent, started, replies, autos, bounces) => ({ day: `2026-10-${d}`, mailbox, sent, started, replies, autos, bounces });
const GMAIL_WEEK = [
  g('05', 'mb-a', 1, 1, 1, 1, 0), g('06', 'mb-b', 1, 1, 0, 0, 1), g('07', 'mb-a', 1, 1, 0, 1, 0), g('08', 'mb-a', 1, 0, 1, 0, 0),
  g('11', 'mb-a', 2, 1, 0, 0, 0),
];

await check('outreach gmail: threadFromRow maps outreach_gmail_threads() rows (defaults for a blank row; extra columns dropped)', () => {
  assert.deepEqual(outreach.threadFromRow(), {
    id: '', mailbox: '', threadId: '', sender: '', prospectEmail: '', prospectName: '', recipients: 1, subject: '', firstAt: '', firstDay: '',
    lastSentAt: '', sentCount: 1, replyAt: '', replyDay: '', autoAt: '', autoDay: '', bounceAt: '', bounceDay: '', replyKind: '',
    organisation: '', contactRole: '', tier: '', sheetReplyStatus: '',
  });
  assert.deepEqual(outreach.threadFromRow({
    id: 'gt-1', mailbox_id: 'mb-1', thread_id: '18c2f0a1b2c3d4e5', sender: ' david@example.com ', prospect_email: 'pat@example.com',
    prospect_name: 'Pat Example', recipients: 2, subject: 'Asset data', first_at: '2026-10-05T23:30:00+00:00', first_day: '2026-10-06',
    last_sent_at: '2026-10-13T23:30:00+00:00', sent_count: 3, reply_at: null, reply_day: null, auto_at: '2026-10-05T23:31:00+00:00',
    auto_day: '2026-10-06', bounce_at: null, bounce_day: null, reply_kind: '', organisation: 'Northbrook Shire Council', contact_role: 'Asset Manager',
    tier: 'A', sheet_reply_status: 'positive', reply_message_id: 'm9', synced_at: '2026-10-18T00:00:00+00:00',
  }), {
    id: 'gt-1', mailbox: 'mb-1', threadId: '18c2f0a1b2c3d4e5', sender: 'david@example.com', prospectEmail: 'pat@example.com', prospectName: 'Pat Example',
    recipients: 2, subject: 'Asset data', firstAt: '2026-10-05T23:30:00+00:00', firstDay: '2026-10-06', lastSentAt: '2026-10-13T23:30:00+00:00',
    sentCount: 3, replyAt: '', replyDay: '', autoAt: '2026-10-05T23:31:00+00:00', autoDay: '2026-10-06', bounceAt: '', bounceDay: '', replyKind: '',
    organisation: 'Northbrook Shire Council', contactRole: 'Asset Manager', tier: 'A', sheetReplyStatus: 'positive',
  });
});

await check('outreach gmail: gmailOutcome — bounced, else replied, else an auto-reply, else waiting', () => {
  assert.equal(outreach.gmailOutcome({ bounceDay: '2026-10-05', replyDay: '2026-10-06', autoDay: '2026-10-05' }), 'bounced');
  assert.equal(outreach.gmailOutcome({ replyAt: '2026-10-06T00:00:00Z', autoDay: '2026-10-05' }), 'replied');
  assert.equal(outreach.gmailOutcome({ autoDay: '2026-10-05' }), 'auto');
  assert.equal(outreach.gmailOutcome(outreach.threadFromRow()), 'waiting');
});

await check('outreach gmail: gmailDaily counts our emails (follow-ups too) on their days, prospects on the first day, and replies, '
  + 'auto-replies and bounces on theirs; by day then mailbox', () => {
  assert.deepEqual(outreach.gmailDaily(GMAIL_THREADS(), GMAIL_MESSAGES(), '2026-10-05', '2026-10-11'), GMAIL_WEEK);
  assert.deepEqual(outreach.gmailDaily(GMAIL_THREADS().reverse(), GMAIL_MESSAGES().reverse(), '2026-10-05', '2026-10-11'), GMAIL_WEEK, 'any order');
  assert.deepEqual(outreach.gmailDaily(GMAIL_THREADS(), GMAIL_MESSAGES(), '2026-10-12', '2026-10-12'),
    [g('12', 'mb-a', 0, 0, 1, 0, 0), g('12', 'mb-b', 1, 1, 0, 0, 0)], 'a reply after the period is on its own day');
  assert.deepEqual(outreach.gmailDaily(GMAIL_THREADS(), GMAIL_MESSAGES(), '2026-10-11', '2026-10-05'), [], 'a reversed range');
  assert.deepEqual(outreach.gmailDaily(null, undefined, '2026-10-05', '2026-10-11'), []);
  const total = (k) => outreach.gmailDaily(GMAIL_THREADS(), GMAIL_MESSAGES(), '2026-10-01', '2026-10-31').reduce((t, d) => t + d[k], 0);
  assert.deepEqual(['sent', 'started', 'replies', 'autos', 'bounces'].map(total), [8, 6, 3, 2, 1], 'replies and auto-replies are never sent');
});

await check('outreach gmail: gmailBreakdown — prospects first emailed in the period by outcome and by emails sent (1, 2, 3, 4+)', () => {
  assert.deepEqual(sortedRows(outreach.gmailBreakdown(GMAIL_THREADS(), '2026-10-05', '2026-10-11')), sortedRows([
    { mailbox: 'mb-a', kind: 'outcome', value: 'auto', n: 1 }, { mailbox: 'mb-a', kind: 'followups', value: '3', n: 1 },
    { mailbox: 'mb-b', kind: 'outcome', value: 'bounced', n: 1 }, { mailbox: 'mb-b', kind: 'followups', value: '1', n: 1 },
    { mailbox: 'mb-a', kind: 'outcome', value: 'replied', n: 2 }, { mailbox: 'mb-a', kind: 'followups', value: '1', n: 2 },
  ]), 'a reply after the period still makes the prospect replied');
  const counts = [0, 1, 2, 3, 4, 7].map((n) => th(`f${n}`, 'mb-a', { firstDay: '2026-10-05', sentCount: n }));
  assert.deepEqual(sortedRows(outreach.gmailBreakdown(counts, '2026-10-05', '2026-10-05').filter((r) => r.kind === 'followups')), sortedRows([
    { mailbox: 'mb-a', kind: 'followups', value: '1', n: 2 }, { mailbox: 'mb-a', kind: 'followups', value: '2', n: 1 },
    { mailbox: 'mb-a', kind: 'followups', value: '3', n: 1 }, { mailbox: 'mb-a', kind: 'followups', value: '4+', n: 2 },
  ]));
  assert.deepEqual(outreach.gmailBreakdown(null, '2026-10-05', '2026-10-11'), []);
});

// Sheet rows for the threads: one by thread id, the prospect's by address (the newest still in the sheet wins).
const SHEET_FOR_THREADS = () => [
  em('s1', 'mb-a', { threadId: 't2', contactEmail: 'someone@example.com', organisation: 'Org by thread', sentOn: '2026-10-01' }),
  em('s2', 'mb-a', { contactEmail: 'Pat@Example.com', organisation: 'Older', sentOn: '2026-10-01' }),
  em('s3', 'mb-a', { contactEmail: 'pat@example.com', organisation: 'Newer', sentOn: '2026-10-03', contactRole: 'Asset Manager', tier: 'A', replyStatus: 'positive' }),
  em('s4', 'mb-a', { contactEmail: 'pat@example.com', organisation: 'Gone', sentOn: '2026-10-09', inSheet: false }),
];

await check('outreach gmail: withSheet adds the sheet\'s details by thread id, else the prospect\'s newest row still in the sheet', () => {
  const [, t2, t3, , , t6] = GMAIL_THREADS();
  assert.equal(outreach.withSheet(t2, SHEET_FOR_THREADS()).organisation, 'Org by thread', 'the thread id beats a newer row for the address');
  const six = outreach.withSheet(t6, SHEET_FOR_THREADS());
  assert.deepEqual([six.organisation, six.contactRole, six.tier, six.sheetReplyStatus], ['Newer', 'Asset Manager', 'A', 'positive']);
  assert.equal(outreach.withSheet(t3, SHEET_FOR_THREADS()), t3, 'no row: the thread as it is');
  assert.equal(outreach.withSheet(t6, null), t6);
  const tie = [em('a2', 'mb-a', { contactEmail: 'pat@example.com', organisation: 'B', sentOn: '2026-10-03', dateLogged: '2026-10-02' }),
    em('a1', 'mb-a', { contactEmail: 'pat@example.com', organisation: 'A', sentOn: '2026-10-03', dateLogged: '2026-10-02' }),
    em('a0', 'mb-a', { contactEmail: 'pat@example.com', organisation: 'Logged earlier', sentOn: '2026-10-03', dateLogged: '2026-10-01' })];
  assert.equal(outreach.withSheet(t6, tie).organisation, 'A', 'same sent day: later logged, then the lower id');
});

await check('outreach gmail: filterThreads lists prospect threads by mode, mailbox and search (with the sheet\'s organisation), newest first, '
  + 'a page at a time', () => {
  const wk = { from: '2026-10-05', to: '2026-10-11' };
  const ids = (opts) => outreach.filterThreads(GMAIL_THREADS(), SHEET_FOR_THREADS(), { ...wk, ...opts }).rows.map((t) => t.id);
  assert.deepEqual(ids({}), ['4', '6', '3', '2'], 'sent: first emailed in the period');
  assert.deepEqual(ids({ mailbox: 'mb-b' }), ['3']);
  assert.deepEqual(ids({ mailbox: '' }), [], 'Unassigned: Gmail threads always have a mailbox');
  assert.deepEqual(ids({ only: 'replies' }), ['6', '1'], 'replies: first replied to in the period');
  assert.deepEqual(ids({ only: 'bounced' }), ['3']);
  assert.deepEqual(ids({ search: ' NEWER ' }), ['6'], 'the sheet\'s organisation');
  assert.deepEqual(ids({ search: 'org by' }), ['2']);
  assert.deepEqual(ids({ search: 'casey' }), ['3'], 'the prospect\'s name');
  assert.deepEqual(ids({ search: 'bridg' }), ['4'], 'the subject');
  assert.deepEqual(ids({ search: 'pat@' }), ['6', '2'], 'the address');
  assert.deepEqual(ids({ search: 'nothing like it' }), []);
  const rows = outreach.filterThreads(GMAIL_THREADS(), SHEET_FOR_THREADS(), wk).rows;
  assert.equal(rows.find((t) => t.id === '6').organisation, 'Newer', 'rows carry the sheet\'s details');
  const page = (limit, offset) => { const r = outreach.filterThreads(GMAIL_THREADS(), [], { ...wk, limit, offset }); return [r.rows.map((t) => t.id), r.more]; };
  assert.deepEqual(page(2, 0), [['4', '6'], true]);
  assert.deepEqual(page(2, 2), [['3', '2'], false]);
  const sameDay = [th('x', 'mb-a', { firstDay: '2026-10-05', firstAt: '2026-10-04T22:00:00Z' }), th('y', 'mb-a', { firstDay: '2026-10-05', firstAt: '2026-10-05T01:00:00Z' }),
    th('w', 'mb-a', { firstDay: '2026-10-05', firstAt: '2026-10-05T01:00:00Z' })];
  assert.deepEqual(outreach.filterThreads(sameDay, [], wk).rows.map((t) => t.id), ['w', 'y', 'x'], 'one day: the later first email, then the id');
  assert.deepEqual(outreach.filterThreads(null, null, wk), { rows: [], more: false });
});

await check('outreach gmail: mergeDaily — a mailbox counted from Gmail takes everything but meetings from Gmail; the rest (and Unassigned) '
  + 'stay on the sheet, each email a prospect', () => {
  const m = (d, mailbox, sent, started, replies, autos, bounces, meetings) => ({ day: `2026-10-${d}`, mailbox, sent, started, replies, autos, bounces, meetings });
  const sheet = [day('05', 'mb-a', 5, 1, 1, 0), day('05', 'mb-c', 2, 1, 0, 1), day('05', '', 1, 0, 0, 0), day('06', 'mb-a', 0, 0, 0, 1),
    day('07', 'mb-a', 3, 0, 0, 0)];
  const gmail = [g('05', 'mb-a', 1, 1, 1, 1, 0), g('06', 'mb-b', 1, 1, 0, 0, 1)];
  const merged = outreach.mergeDaily(sheet, gmail, new Set(['mb-a']));
  assert.deepEqual(merged, [
    m('05', 'mb-a', 1, 1, 1, 1, 0, 0), m('05', 'mb-c', 2, 2, 1, 0, 0, 1), m('05', '', 1, 1, 0, 0, 0, 0), m('06', 'mb-a', 0, 0, 0, 0, 0, 1),
  ], 'mb-a\'s sheet sends drop out (only its meeting stays); mb-b is not counted from Gmail yet; Unassigned last');
  assert.deepEqual(outreach.mergeDaily(sheet, gmail), [
    m('05', 'mb-a', 5, 5, 1, 0, 1, 0), m('05', 'mb-c', 2, 2, 1, 0, 0, 1), m('05', '', 1, 1, 0, 0, 0, 0), m('06', 'mb-a', 0, 0, 0, 0, 0, 1),
    m('07', 'mb-a', 3, 3, 0, 0, 0, 0),
  ], 'no Gmail: the sheet as it was');
  assert.deepEqual(outreach.mergeDaily(null, null, new Set(['mb-a'])), []);
  assert.deepEqual(outreach.outreachTotals(merged), { sent: 4, started: 4, replies: 2, autos: 1, bounces: 0, meetings: 2, replyRate: 0.5, bounceRate: 0 },
    'reply rate: replies per prospect');
  assert.deepEqual(outreach.outreachTotals(merged, 'mb-a'), { sent: 1, started: 1, replies: 1, autos: 1, bounces: 0, meetings: 1, replyRate: 1, bounceRate: 0 });
});

if (outreachDemo) {
  // Ids replaced by their order of appearance, so two runs (random ids) compare.
  const withoutIds = (demo) => {
    const ids = [...demo.mailboxes, ...demo.outreachEmails, ...demo.outreachNotes].map((x) => x.id).sort((a, b) => b.length - a.length);
    let json = JSON.stringify(demo);
    ids.forEach((x, i) => { json = json.split(x).join(`#${i}`); });
    return JSON.parse(json);
  };
  const counter = () => { let k = 0; return (p) => `${p}_${++k}`; };

  await check('seed: outreach demo data is the same every time for a given day (only the ids differ)', () => {
    assert.deepEqual(outreachDemo('2026-10-18', counter()), outreachDemo('2026-10-18', counter()));
    assert.deepEqual(withoutIds(outreachDemo('2026-10-18')), withoutIds(outreachDemo('2026-10-18')));
    assert.notDeepEqual(withoutIds(outreachDemo('2026-10-18')), withoutIds(outreachDemo('2026-10-25')), 'it follows the day');
  });

  await check('seed: outreach demo — three mailboxes, every row in one, placeholder addresses, twelve working days, emails to '
    + 'two contacts, and every number on the page has something to show', () => {
    const today = '2026-10-18';
    const d = outreachDemo(today, counter());
    assert.deepEqual(d.mailboxes.map((m) => [m.name, m.addresses, m.owner, m.active]), [
      ['David', ['david@example.com'], 'david', true], ['Josh', ['josh@example.com'], 'josh', true], ['Sarah', ['sarah@example.com'], '', true],
    ]);
    assert.equal(d.outreachSheet, '');
    const boxes = new Set(d.mailboxes.map((m) => m.id));
    const rows = d.outreachEmails;
    assert.ok(rows.length > 100, String(rows.length));
    rows.forEach((e) => {
      assert.ok(boxes.has(e.mailbox), `${e.id}: mailbox ${e.mailbox}`);
      assert.equal(outreach.mailboxFor(d.mailboxes, e.sender), e.mailbox, `${e.id}: its sender is its mailbox's`);
      assert.deepEqual(Object.keys(e).sort(), Object.keys(outreach.emailFromRow()).sort(), `${e.id}: the app shape`);
      assert.equal(e.rowKey, `${e.contactEmail}|${e.dateLogged}`);
      assert.ok(e.inSheet && e.dateLogged <= today && auto.isoDow(e.dateLogged) <= 5, e.id);
      [e.sentOn, e.replyOn, e.meetingOn].filter(Boolean).forEach((x) => assert.ok(x <= today, `${e.id}: ${x} after today`));
      if (e.sentOn) assert.ok(e.messageId && e.threadId && e.sentOn === e.dateLogged, e.id);
      else assert.ok(!e.messageId && !e.bounced && !e.replyStatus, e.id);
    });
    assert.equal(new Set(rows.map((e) => e.dateLogged)).size, 12, 'twelve working days');
    const emails = JSON.stringify(d).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || [];
    assert.ok(emails.length && emails.every((x) => x.endsWith('@example.com')), emails.filter((x) => !x.endsWith('@example.com')).join(', '));
    // Twins: one message to two contacts (same mailbox, send, thread and reply; the second never bounced).
    const byMessage = new Map();
    rows.filter((e) => e.messageId).forEach((e) => byMessage.set(e.messageId, [...(byMessage.get(e.messageId) || []), e]));
    const twins = [...byMessage.values()].filter((list) => list.length > 1);
    assert.ok(twins.length > 0, 'some emails go to two contacts');
    twins.forEach(([a, b, ...more]) => {
      assert.equal(more.length, 0);
      ['mailbox', 'sentOn', 'threadId', 'replyStatus', 'replyOn', 'meetingOn'].forEach((k) => assert.equal(b[k], a[k], `${a.messageId} ${k}`));
      assert.ok(a.contactEmail !== b.contactEmail && !b.bounced, a.messageId);
    });
    // The numbers, by the lib, against a plain count: one per message sent, bounced, replied to or met.
    const t = outreach.outreachTotals(outreach.outreachDaily(rows, '2000-01-01', today));
    const groups = [...byMessage.values()];
    assert.deepEqual([t.sent, t.bounces, t.replies, t.meetings], [
      groups.length, groups.filter((g) => g.some((e) => e.bounced)).length, groups.filter((g) => g.some((e) => e.replyStatus && e.replyOn)).length,
      groups.filter((g) => g.some((e) => e.meetingOn)).length,
    ]);
    assert.ok(t.sent < rows.filter((e) => e.sentOn).length, 'emails, not contacts');
    assert.ok(t.replies > 0 && t.bounces > 0 && t.meetings > 0, JSON.stringify(t));
    assert.ok(outreach.outreachBreakdown(rows, '2000-01-01', today).some((x) => x.kind === 'status' && x.value.startsWith('skipped-')));
    // Whatever the day, at least one meeting.
    for (let k = 0; k < 35; k++) {
      const day = auto.addDays('2026-10-01', k);
      assert.ok(outreachDemo(day, counter()).outreachEmails.some((e) => e.meetingOn && e.meetingOn <= day), day);
    }
    // Notes: one pinned for every mailbox, one on Josh's.
    assert.deepEqual(sortedRows(d.outreachNotes.map((n) => [n.mailbox, n.pinned, n.author])),
      sortedRows([['', true, 'david'], [d.mailboxes[1].id, false, 'josh']]));
  });

  await check('seed: every outreach demo row has its own rowKey (row_key is unique in outreach_emails; the sheet sync keeps one row '
    + 'per key)', () => {
    const rows = outreachDemo('2026-10-18', counter()).outreachEmails;
    const seen = new Map();
    rows.forEach((e) => seen.set(e.rowKey, (seen.get(e.rowKey) || 0) + 1));
    const repeated = [...seen].filter(([, n]) => n > 1);
    assert.deepEqual(repeated.slice(0, 3), [], `${repeated.length} keys repeat (of ${rows.length} rows), e.g. ${repeated.slice(0, 3).map(([k, n]) => `${k} ×${n}`).join(', ')}`);
  });

  await check('seed: outreach notes are newest first, as assemble() and addOutreachNote keep them', () => {
    const d = outreachDemo('2026-10-18', counter());
    const live = assemble(flatten({ users: [], org: {}, ...d }), { me: 'david' }).outreachNotes.map((n) => n.id);
    assert.deepEqual(d.outreachNotes.map((n) => n.id), live, `seed order ${d.outreachNotes.map((n) => `${n.author} ${n.createdAt}`).join(', ')}`);
  });

  await check('seed: Gmail demo (0010) — David and Josh connected, Sarah on the sheet; every sheet email of theirs a thread, three sent by hand; '
    + 'messages match the threads; headers only', () => {
    const today = '2026-10-18';
    const d = outreachDemo(today, counter());
    const [david, josh, sarah] = d.mailboxes;
    assert.deepEqual(Object.keys(d.outreachGmail).sort(), [david.id, josh.id].sort());
    assert.deepEqual(Object.values(d.outreachGmail).map((x) => x.email).sort(), ['david@example.com', 'josh@example.com']);
    Object.values(d.outreachGmail).forEach((x) => assert.ok(x.readyAt && x.syncedAt && x.connectedAt, 'read already'));
    assert.ok(d.outreachThreads.every((t) => t.mailbox !== sarah.id) && d.outreachMessages.every((x) => x.mailbox !== sarah.id));
    const keys = new Set([...Object.keys(outreach.threadFromRow()), 'replyMessageId']);
    d.outreachThreads.forEach((t) => {
      assert.deepEqual(Object.keys(t).filter((k) => !keys.has(k)), [], 'thread fields only (no text)');
      assert.match(t.prospectEmail, /@example\.com$/);
      assert.equal(t.prospectEmail, t.prospectEmail.toLowerCase());
      const mine = d.outreachMessages.filter((x) => x.threadId === t.threadId);
      assert.ok(mine.every((x) => x.mailbox === t.mailbox));
      assert.equal(mine.filter((x) => x.kind === 'sent').length, t.sentCount, t.threadId);
      assert.equal(mine.filter((x) => x.kind === 'sent').map((x) => x.day).sort()[0], t.firstDay);
      ['reply', 'auto', 'bounce'].forEach((k) => assert.equal(mine.filter((x) => x.kind === k).length, t[`${k}Day`] ? 1 : 0, `${t.threadId} ${k}`));
      assert.ok(t.firstDay <= today && (!t.replyDay || t.replyDay >= t.firstDay));
      if (t.bounceDay) assert.equal(t.sentCount, 1, 'no follow-ups after a bounce');
    });
    assert.equal(new Set(d.outreachThreads.map((t) => t.threadId)).size, d.outreachThreads.length);
    assert.equal(new Set(d.outreachMessages.map((x) => `${x.mailbox}|${x.messageId}`)).size, d.outreachMessages.length);
    // Every email David's and Josh's sheet rows sent is a thread; David has three more the sheet never had.
    [david, josh].forEach((mb) => {
      const sheetEmails = new Set(d.outreachEmails.filter((e) => e.mailbox === mb.id && e.sentOn).map((e) => e.messageId || e.id));
      const threads = d.outreachThreads.filter((t) => t.mailbox === mb.id);
      assert.equal(threads.length, sheetEmails.size + (mb === david ? 3 : 0), mb.name);
    });
    assert.deepEqual(d.outreachThreads.filter((t) => t.threadId.startsWith('thr-hand')).map((t) => t.prospectEmail).sort(),
      ['casey.ng@example.com', 'jordan.lee@example.com', 'sam.taylor@example.com']);
    // Every number on the page has something to show.
    const daily = outreach.gmailDaily(d.outreachThreads, d.outreachMessages, '2026-09-19', today);
    ['sent', 'started', 'replies', 'autos', 'bounces'].forEach((k) => assert.ok(daily.reduce((t, x) => t + x[k], 0) > 0, k));
    assert.ok(daily.reduce((t, x) => t + x.sent, 0) > daily.reduce((t, x) => t + x.started, 0), 'follow-ups');
  });

}

if (createSeed && migrate) {
  await check('seed: createSeed has the outreach demo, and its synced part round-trips (the emails stay out of synced state)', () => {
    const s = createSeed();
    assert.deepEqual(s.mailboxes.map((m) => m.name), ['David', 'Josh', 'Sarah']);
    assert.ok(s.outreachEmails.length && s.outreachNotes.length === 2 && s.outreachSheet === '');
    const rows = flatten(s);
    assert.deepEqual([rows.outreach_mailboxes.size, rows.outreach_notes.size, rows.outreach_settings.size], [3, 2, 1]);
    assert.ok(!Object.keys(rows).some((t) => t === 'outreach_emails'), 'no emails table in TABLES');
    s.outreachNotes.forEach((n) => assert.ok(s.users.some((u) => u.id === n.author), n.author));
    s.mailboxes.filter((m) => m.owner).forEach((m) => assert.ok(s.users.some((u) => u.id === m.owner), m.owner));
  });

  await check('pipeline demo: every deal in a column, none at Won; Westbay made a client; older Won deals move to Demos once', async () => {
    const { DEAL_STAGES } = await import('../src/data/boards.js');
    const s = createSeed();
    assert.ok(s.deals.every((d) => DEAL_STAGES.includes(d.stage)), JSON.stringify(s.deals.map((d) => d.stage)));
    assert.deepEqual(DEAL_STAGES.map((st) => s.deals.filter((d) => d.stage === st && !d.clientId).length).map((n) => n > 0), [true, true, true, true],
      'something in every column');
    const westbay = s.deals.find((d) => d.name === 'Westbay Council');
    assert.ok(westbay.clientId && s.clients.some((c) => c.id === westbay.clientId), 'made a client: off the board');
    assert.equal(s.deals.filter((d) => d.clientId).length, 1);
    const old = structuredClone(s);
    old.deals.forEach((d) => { if (d.clientId) d.stage = 'Won'; });
    old.deals.push({ id: 'd-won', name: 'Old win', sector: '', value: 1, priority: 'P2', stage: 'Won', contact: 'david', next: '', contactId: '' });
    const m = migrate(structuredClone(old));
    assert.deepEqual([m.deals.find((d) => d.id === westbay.id).stage, m.deals.find((d) => d.id === 'd-won').stage], ['Demos', 'Demos']);
    assert.equal(m.deals.find((d) => d.id === westbay.id).clientId, westbay.clientId, 'its client kept');
    assert.deepEqual(migrate(structuredClone(m)), m, 'running it again changes nothing');
  });

  await check('migrate: older demo data gets Outreach’s, Clients’ (0007) and Pipeline’s (0008) starting boards once; deleting them sticks', () => {
    const { STARTING_BOARDS, FIRST_GROUP, FIRST_GROUP_COLOR, teamBoards } = boardsLib;
    const added = ['outreach', 'clients', 'pipeline'];
    const old = createSeed();
    old.boards = old.boards.filter((b) => !added.includes(b.module));
    delete old.seededBoards;
    const m = migrate(structuredClone(old));
    added.forEach((module) => assert.deepEqual(
      teamBoards(m, module).map((b) => [b.name, b.owner, b.groups.map((g) => [g.name, g.color, g.items])]),
      STARTING_BOARDS[module].map((n) => [n, '', [[FIRST_GROUP[module], FIRST_GROUP_COLOR, []]]]), module));
    assert.deepEqual(m.boards.slice(-4).map((b) => b.module), ['outreach', 'clients', 'clients', 'pipeline'], 'after Marketing, as the live order has them');
    assert.deepEqual(m.seededBoards, ['projects', 'marketing', 'outreach', 'clients', 'pipeline']);
    assert.deepEqual(migrate(structuredClone(m)), m, 'running it again adds nothing');
    const deleted = structuredClone(m);
    deleted.boards = deleted.boards.filter((b) => !added.includes(b.module));
    assert.deepEqual(migrate(structuredClone(deleted)).boards.filter((b) => added.includes(b.module)), [], 'deleted starting boards stay deleted');
    // An older demo that already has a board in the module (renamed) keeps it and gets no starting boards there.
    const own = structuredClone(old);
    own.boards.push({ id: 'b-own', module: 'clients', name: 'Onboarding', owner: '', groups: [] });
    const kept = migrate(own);
    assert.deepEqual([teamBoards(kept, 'clients').map((b) => b.name), teamBoards(kept, 'outreach').map((b) => b.name)],
      [['Onboarding'], STARTING_BOARDS.outreach]);
  });

  await check('migrate: older demo data gets the outreach demo once; outreach data already there is left as it is', () => {
    const old = createSeed();
    ['mailboxes', 'outreachNotes', 'outreachEmails', 'outreachSheet'].forEach((k) => { delete old[k]; });
    const m = migrate(structuredClone(old));
    assert.deepEqual(m.mailboxes.map((x) => x.name), ['David', 'Josh', 'Sarah']);
    assert.ok(m.outreachEmails.length > 100 && m.outreachEmails.every((e) => m.mailboxes.some((x) => x.id === e.mailbox)));
    assert.deepEqual([m.outreachNotes.length, m.outreachSheet], [2, '']);
    assert.deepEqual(migrate(structuredClone(m)), m, 'running it again adds nothing');
    // Someone's own outreach data (or none: every mailbox removed) is kept.
    const own = structuredClone(old);
    Object.assign(own, {
      mailboxes: [{ id: 'mb-own', name: 'Mine', addresses: ['me@example.com'], owner: 'david', active: false }],
      outreachNotes: [{ id: 'on-own', mailbox: 'mb-own', pinned: false, body: 'Mine', author: 'david', createdAt: '2026-10-01T00:00:00.000Z' }],
      outreachEmails: [em('e-own', 'mb-own', { sentOn: '2026-10-01' })],
      outreachSheet: 'https://docs.google.com/spreadsheets/d/1ExampleSheetIdAbCdEfGhIjKlMnOp/edit',
    });
    const kept = migrate(structuredClone(own));
    ['mailboxes', 'outreachNotes', 'outreachEmails', 'outreachSheet'].forEach((k) => assert.deepEqual(kept[k], own[k], k));
    const emptied = migrate({ ...structuredClone(old), mailboxes: [], outreachNotes: [], outreachEmails: [], outreachSheet: '' });
    assert.deepEqual([emptied.mailboxes, emptied.outreachNotes, emptied.outreachEmails, emptied.outreachSheet], [[], [], [], '']);
    const partial = migrate({ ...structuredClone(old), mailboxes: own.mailboxes });
    assert.deepEqual([partial.mailboxes, partial.outreachNotes, partial.outreachEmails, partial.outreachSheet], [own.mailboxes, [], [], '']);
  });

  await check('migrate: older demo data gets the Gmail demo (0010) once, for its own emails and mailboxes; a disconnected demo stays so', () => {
    const old = createSeed();
    ['outreachGmail', 'outreachThreads', 'outreachMessages'].forEach((k) => { delete old[k]; });
    const m = migrate(structuredClone(old));
    assert.deepEqual(Object.keys(m.outreachGmail).sort(), m.mailboxes.slice(0, 2).map((x) => x.id).sort());
    assert.ok(m.outreachThreads.length > 10 && m.outreachMessages.length > m.outreachThreads.length);
    assert.ok(m.outreachThreads.every((t) => m.outreachGmail[t.mailbox]));
    assert.deepEqual(migrate(structuredClone(m)), m, 'running it again adds nothing');
    const none = migrate({ ...structuredClone(old), outreachGmail: {}, outreachThreads: [], outreachMessages: [] });
    assert.deepEqual([none.outreachGmail, none.outreachThreads, none.outreachMessages], [{}, [], []], 'every mailbox disconnected: stays so');
    const noMailboxes = migrate({ ...structuredClone(old), mailboxes: [], outreachEmails: [] });
    assert.deepEqual([noMailboxes.outreachGmail, noMailboxes.outreachThreads, noMailboxes.outreachMessages], [{}, [], []]);
    const partial = structuredClone(old);
    partial.outreachGmail = {};
    const filled = migrate(partial);
    assert.deepEqual([filled.outreachThreads, filled.outreachMessages], [[], []], 'missing lists start empty');
  });
}

// ── Usage import and the clients importer ─────────────────────────────────────
const usage = await import('../src/lib/usageImport.js');

await check('usage import: columns found by header synonyms, any case or spacing; ids and balances never', () => {
  const { detectColumns } = usage;
  assert.deepEqual(detectColumns(['Date', 'Credits Used', 'Assets', 'Locations', 'Users']), { month: 0, credits: 1, assets: 2, sites: 3, seats: 4 });
  assert.deepEqual(detectColumns(['  PERIOD ', 'credit_usage', 'SEATS']), { month: 0, credits: 1, assets: -1, sites: -1, seats: 2 });
  assert.deepEqual(detectColumns(['timestamp', 'usageCredits', 'Sites']), { month: 0, credits: 1, assets: -1, sites: 2, seats: -1 });
  assert.deepEqual(detectColumns(['Month', 'Credit']), { month: 0, credits: 1, assets: -1, sites: -1, seats: -1 });
  assert.deepEqual(detectColumns(['Day', 'credits']), { month: 0, credits: 1, assets: -1, sites: -1, seats: -1 });
  assert.deepEqual(detectColumns(['Site ID', 'User ID', 'Credits remaining', 'Credit limit', 'Usage date (UTC)', 'Credits']),
    { month: 4, credits: 5, assets: -1, sites: -1, seats: -1 });
  assert.deepEqual(detectColumns(['Organisation', 'Notes']), { month: -1, credits: -1, assets: -1, sites: -1, seats: -1 });
  assert.equal(usage.readUsage('Date,Credits used\n2026-10-01,5').mapping.credits, 1, 'readUsage exports the mapping');
});

await check('usage import: the month from ISO dates and date-times, AU day-first dates, yyyy-mm, month names, mm/yyyy', () => {
  const cases = {
    '2026-10-05': '2026-10-01', '2026-10-31T23:30:00Z': '2026-10-01', '2026-10-05 09:30:00': '2026-10-01', '2026/10/05': '2026-10-01',
    '5/10/2026': '2026-10-01', '05-10-2026': '2026-10-01', '5.10.26': '2026-10-01', '31/1/2026': '2026-01-01', '1/31/2026': '2026-01-01',
    '5/10/2026 14:00': '2026-10-01', '2026-10': '2026-10-01', 'Oct 2026': '2026-10-01', 'October 2026': '2026-10-01',
    'Sept 2026': '2026-09-01', 'Oct-26': '2026-10-01', '10/2026': '2026-10-01', '9-2026': '2026-09-01', '5 Oct 2026': '2026-10-01',
    'Mon 5 October 2026': '2026-10-01', 'Oct 5, 2026': '2026-10-01',
    '': '', 'Total': '', '31/02/2026': '', '13/2026': '', '2026-13': '', 'Mayor 2026': '', '2026': '', 'TBC': '', '45567': '',
  };
  Object.entries(cases).forEach(([v, want]) => assert.equal(usage.monthOf(v), want, JSON.stringify(v)));
  assert.equal(usage.monthOf(null), '');
  assert.deepEqual(['1,234', '$1,234.50', ' 1 234 ', '(5)', '7', '', ' - ', '—', 'n/a', 'abc', '12%'].map(usage.numberOf),
    [1234, 1234.5, 1234, -5, 7, null, null, null, null, NaN, NaN]);
});

await check('usage import: credits summed per month, assets / sites / seats the month\'s highest, newest first', () => {
  const csv = [
    'Date,Credits used,Assets,Sites,Users',
    '05/10/2026,"1,200",10,2,5',
    '2026-10-20,$300.50,14,3,4',
    '2026-09-30T23:00:00Z,0.1,9,,3',
    '30/09/2026,0.2,7,1,',
  ].join('\r\n');
  const r = usage.parseUsage(csv);
  assert.deepEqual(r.months, [
    { month: '2026-10-01', credits: 1500.5, assets: 14, sites: 3, seats: 5 },
    { month: '2026-09-01', credits: 0.3, assets: 9, sites: 1, seats: 3 },
  ]);
  assert.deepEqual([r.rows, r.skipped], [4, []]);
  // A column mapped by hand (the dialog's override), and one taken away: those figures are left out.
  const byHand = usage.parseUsage(csv, { mapping: { month: 0, credits: 2, assets: -1, sites: -1, seats: -1 } });
  assert.deepEqual(byHand.months, [{ month: '2026-10-01', credits: 24 }, { month: '2026-09-01', credits: 16 }]);
  const noCredits = usage.parseUsage(csv, { mapping: { month: 0, credits: -1, assets: 2, sites: -1, seats: -1 } });
  assert.deepEqual(noCredits.months, [{ month: '2026-10-01', assets: 14 }, { month: '2026-09-01', assets: 9 }]);
  assert.deepEqual(usage.parseUsage(csv, { mapping: { month: 0 } }).months, [], 'no figures mapped: nothing to import');
});

await check('usage import: without a date column every row counts toward the month given', () => {
  const csv = 'User,Credits,Seats\nana@example.com,5,1\nben@example.com,"1,000",3\n';
  const r = usage.parseUsage(csv, { month: '2026-09-15' });
  assert.equal(r.mapping.month, -1);
  assert.deepEqual(r.months, [{ month: '2026-09-01', credits: 1005, seats: 3 }]);
  assert.equal(r.rows, 2);
  assert.deepEqual(usage.parseUsage(csv).months, [], 'no month given: nothing');
  assert.deepEqual(usage.parseUsage(csv, { month: 'soon' }).months, []);
});

await check('usage import: skipped rows say why (dates, numbers, totals); title lines and blank lines are passed over', () => {
  const csv = [
    'Usage report,,', ',,',
    'Date,Credits,Seats',
    '2026-10-01,5,2',
    'not a date,3,1',
    ',4,1',
    '2026-10-02,abc,1',
    'Total,12,',
    '',
    '2026-10-03,-,',
  ].join('\n');
  const r = usage.parseUsage(csv);
  assert.deepEqual(r.headers, ['Date', 'Credits', 'Seats']);
  assert.deepEqual(r.months, [{ month: '2026-10-01', credits: 5, seats: 2 }]);
  assert.equal(r.rows, 2);
  assert.deepEqual(r.skipped, [
    { row: 5, reason: 'Not a date: not a date' },
    { row: 6, reason: 'No date' },
    { row: 7, reason: "Credits isn't a number: abc" },
    { row: 8, reason: 'Total row' },
  ]);
  // Messy input never throws.
  [null, undefined, '', '﻿', 42, '"unterminated', ',,,\n,,,', 'Date\n'].forEach((t) => {
    const x = usage.parseUsage(t);
    assert.ok(Array.isArray(x.months) && Array.isArray(x.skipped), String(t));
  });
  assert.deepEqual(usage.usageMonths(null, null), { months: [], rows: 0, skipped: [] });
  assert.deepEqual(usage.usageMonths([['1', '2'], 'x', null, [undefined, 3]], { month: 0, credits: 1 }).skipped,
    [{ row: 2, reason: 'Not a date: 1' }, { row: 5, reason: 'No date' }]);
});

await check('import: clients map the contact, email and phone to a billing contact, and the platform link', async () => {
  const { autoMap, normalise } = await import('../src/lib/importers.js');
  const users = [{ id: 'u-ana', name: 'Ana Example', email: 'ana@example.com' }];
  const headers = ['Client name', 'Contact', 'Email', 'Phone', 'Platform URL', 'Owner'];
  const map = autoMap(headers, 'clients');
  assert.deepEqual([map.name, map.keyContact, map.email, map.phone, map.platformUrl, map.contact], [0, 1, 2, 3, 4, 5]);
  const rec = normalise('clients', ['Example Council', ' Dale  Example ', 'Dale <Dale@Example.com>', '0400 000 000', 'https://example.assetstack.site', 'ana@example.com'], map, { users, me: 'u-me' });
  assert.deepEqual(rec.contacts, [{ name: 'Dale Example', role: '', email: 'dale@example.com', phone: '0400 000 000', billing: true }]);
  assert.deepEqual([rec.platformUrl, rec.contact], ['https://example.assetstack.site', 'u-ana']);
  assert.ok(!('keyContact' in rec) && !('email' in rec), 'no legacy key contact / email fields');
  // Next to a Key contact column, Contact is the owner (the old export); a phone alone still makes a contact.
  const both = autoMap(['Name', 'Key contact', 'Contact', 'Site', 'Mobile number'], 'clients');
  assert.deepEqual([both.keyContact, both.contact, both.platformUrl, both.phone], [1, 2, 3, 4]);
  assert.deepEqual(normalise('clients', ['Example', '', '', '', '0400 000 001'], both, { users, me: 'u-me' }).contacts,
    [{ name: '', role: '', email: '', phone: '0400 000 001', billing: true }]);
  assert.deepEqual(normalise('clients', ['Example', '', 'not an email'], { name: 0, keyContact: 1, email: 2 }).contacts, [], 'nothing usable: no contact');
  ['Platform', 'platform link', 'Platform address', 'site', 'PlatformUrl'].forEach((h) => assert.equal(autoMap(['Name', h], 'clients').platformUrl, 1, h));
});

await check('import: a bare Contact column is the owner next to any key contact column, else the client contact', async () => {
  const { autoMap } = await import('../src/lib/importers.js');
  ['Key contact', 'Primary contact', 'Main contact', 'Client contact', 'Contact name', 'Contact person', 'Billing contact'].forEach((h) => {
    const m = autoMap(['Name', 'Contact', h], 'clients');
    assert.deepEqual([m.contact, m.keyContact], [1, 2], h);
    const r = autoMap(['Name', h, 'Contact'], 'clients');
    assert.deepEqual([r.contact, r.keyContact], [2, 1], `${h} first`);
  });
  // Alone, or next to an owner column, it is the client's contact; the owner column keeps the owner.
  assert.deepEqual(((m) => [m.contact, m.keyContact])(autoMap(['Name', 'Contact'], 'clients')), [-1, 1]);
  assert.deepEqual(((m) => [m.contact, m.keyContact])(autoMap(['Name', 'Contact', 'Owner'], 'clients')), [2, 1]);
  assert.deepEqual(((m) => [m.contact, m.keyContact])(autoMap(['Name', 'Contact owner', 'Contact'], 'clients')), [1, 2]);
  assert.deepEqual(((m) => [m.contact, m.keyContact])(autoMap(['Name', 'Account owner', 'contact'], 'clients')), [1, 2]);
  // Other kinds keep Contact as the owner / person as before.
  assert.equal(autoMap(['Name', 'Contact'], 'deals').contact, 1);
  assert.equal(autoMap(['Contact', 'Company'], 'contacts').name, 0);
});

// ── Calendar (0009): src/lib/calendar.js, the demo seed and its migration ─────────

const cal = await import('../src/lib/calendar.js');

await check('calendar: ISO weeks, a month as Monday-first weeks, the 12 months and the Archive', () => {
  assert.deepEqual(['2026-10-19', '2026-12-29', '2027-01-03', '2027-01-04', '2026-01-01'].map(cal.isoWeek), [43, 53, 53, 1, 1]);
  // November 2026 starts on a Sunday: six rows, from Monday 26 October to Sunday 6 December.
  const nov = cal.monthWeeks('2026-11');
  assert.deepEqual(nov.map((w) => w.monday), ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);
  assert.deepEqual([nov[0].days[0], nov[0].days[6], nov[5].days[6]], ['2026-10-26', '2026-11-01', '2026-12-06']);
  assert.deepEqual(nov.map((w) => w.week), [44, 45, 46, 47, 48, 49]);
  // February 2027 starts on a Monday and ends on a Sunday: exactly four.
  assert.deepEqual(cal.monthWeeks('2027-02').map((w) => w.monday), ['2027-02-01', '2027-02-08', '2027-02-15', '2027-02-22']);
  assert.deepEqual(cal.nextMonths('2026-10-21'), ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05',
    '2027-06', '2027-07', '2027-08', '2027-09']);
  assert.deepEqual(cal.nextMonths('2026-12-31', 3), ['2026-12', '2027-01', '2027-02']);
  // Finished months, newest first; nothing older than the earliest entry, nothing for this month.
  assert.deepEqual(cal.archiveMonths('2026-10-21', '2026-07-15'), ['2026-09', '2026-08', '2026-07']);
  assert.deepEqual(cal.archiveMonths('2026-10-21', '2026-10-02'), []);
  assert.deepEqual(cal.archiveMonths('2026-10-21', ''), []);
  assert.deepEqual(cal.archiveMonths('2027-01-05', '2026-11-30'), ['2026-12', '2026-11']);
  assert.equal(cal.archiveMonths('2026-10-21', '2020-01-01').length, 60);
});

await check('calendar: an instant sits on the viewer\'s own date and time (Sydney vs Tbilisi)', () => {
  assert.deepEqual(cal.placeAt('2026-10-20T19:30:00Z', 'Australia/Sydney'), { date: '2026-10-21', time: '06:30' });
  assert.deepEqual(cal.placeAt('2026-10-20T19:30:00Z', 'Asia/Tbilisi'), { date: '2026-10-20', time: '23:30' });
  assert.deepEqual(cal.placeAt('', 'Asia/Tbilisi'), { date: '', time: '' });
  assert.deepEqual(cal.placeAt('nonsense', 'Asia/Tbilisi'), { date: '', time: '' });
});

const calState = () => ({
  me: 'u-admin',
  users: [
    { id: 'u-admin', name: 'Dee', role: 'superadmin', active: true },
    { id: 'u-staff', name: 'Sam', role: 'staff', active: true },
  ],
  moduleAccess: [],
  boards: [
    { id: 'b-own', module: 'projects', name: '', owner: 'u-admin', calendar: false, groups: [{ id: 'g0', items: [
      { id: 'i-own', name: 'Private plan', values: { people: ['u-admin'], due: '2026-10-22' }, done: false },
    ] }] },
    { id: 'b-gen', module: 'projects', name: 'General', owner: '', calendar: false, groups: [{ id: 'g1', items: [
      { id: 'i-1', name: 'Report', values: { people: ['u-staff'], status: 'Done', due: '2026-10-20' }, done: true },
      { id: 'i-2', name: 'No date', values: { people: [], due: '' }, done: false },
    ] }] },
    { id: 'b-post', module: 'marketing', name: 'Posting schedule', owner: '', calendar: true, groups: [{ id: 'g2', items: [
      { id: 'i-3', name: ' Golf Day post ', values: { people: ['u-staff'], status: 'In progress', due: '2026-10-24' }, done: false },
    ] }] },
    { id: 'b-sales', module: 'outreach', name: 'Sales Tasks', owner: '', calendar: false, groups: [{ id: 'g3', items: [
      { id: 'i-4', name: 'Call list', values: { people: [], due: '2026-10-21' }, done: false },
    ] }] },
    { id: 'b-wip', module: 'pipeline', name: 'Work in Progress', owner: '', calendar: false, groups: [{ id: 'g4', items: [
      { id: 'i-5', name: 'Westbay', values: { details: 'x', due: '2026-10-21' }, done: false },
    ] }] },
  ],
  calendarEvents: [
    { id: 'e-1', kind: 'event', title: 'Expo', day: '2026-10-30', endDay: '2026-11-02', startsAt: '', endsAt: '', people: ['u-admin'], createdBy: 'u-admin' },
    { id: 'e-2', kind: 'meeting', title: 'Planning', day: '2026-10-21', endDay: '', startsAt: '2026-10-20T22:30:00.000Z',
      endsAt: '2026-10-20T23:30:00.000Z', people: ['u-staff'], createdBy: 'u-staff' },
    { id: 'e-3', kind: 'party', title: 'Unknown kind', day: '2026-10-21', endDay: '', startsAt: '', endsAt: '', people: [], createdBy: '' },
  ],
  clients: [{ id: 'c-1', name: 'Westbay', invoices: [
    { id: 'inv-1', number: 'INV-1', due: '2026-11-01', status: 'Sent' },
    { id: 'inv-2', number: 'INV-2', due: '2026-11-02', status: 'Void' },
    { id: 'inv-3', number: 'INV-3', due: '', status: 'Draft' },
  ], contracts: [
    { id: 'k-1', title: 'Agreement', status: 'Signed', startDate: '2026-11-01', endDate: '2027-10-31' },
    { id: 'k-2', title: 'Old', status: 'Cancelled', startDate: '2026-10-25', endDate: '' },
  ] }],
});
const meetings = [
  { id: 'm-1', user_id: 'u-staff', title: '', busy: true, all_day: false, start_date: '2026-10-21', end_date: '2026-10-21',
    start_at: '2026-10-21T01:00:00Z', end_at: '2026-10-21T02:00:00Z' },
  { id: 'm-2', user_id: 'u-admin', title: 'Leave', busy: false, all_day: true, start_date: '2026-10-29', end_date: '2026-10-30',
    start_at: null, end_at: null },
];

await check('calendar: entries from every source, each with its own access rule (staff without Clients see no invoices)', () => {
  const st = calState();
  const keys = (list) => list.map((e) => e.key);
  const all = cal.collectEntries(st, { meetings, tz: 'Australia/Sydney' });
  assert.deepEqual(keys(all), ['item:i-1', 'item:i-own', 'event:e-2', 'meeting:m-1', 'item:i-4', 'item:i-3', 'meeting:m-2', 'event:e-1',
    'contract:k-1:startDate', 'invoice:inv-1', 'contract:k-1:endDate'].sort((a, b) => keys(all).indexOf(a) - keys(all).indexOf(b)));
  const by = Object.fromEntries(all.map((e) => [e.key, e]));
  assert.deepEqual([by['item:i-1'].kind, by['item:i-1'].done, by['item:i-3'].kind, by['item:i-3'].title], ['task', true, 'post', 'Golf Day post']);
  assert.deepEqual([by['item:i-3'].boardId, by['item:i-3'].itemId], ['b-post', 'i-3']);
  assert.deepEqual([by['event:e-2'].date, by['event:e-2'].time, by['event:e-2'].endTime], ['2026-10-21', '09:30', '10:30']);
  assert.deepEqual([by['event:e-1'].date, by['event:e-1'].endDate, by['event:e-1'].time], ['2026-10-30', '2026-11-02', '']);
  assert.deepEqual([by['meeting:m-1'].title, by['meeting:m-1'].busy, by['meeting:m-1'].time, by['meeting:m-1'].people], ['Busy', true, '12:00', ['u-staff']]);
  assert.deepEqual([by['meeting:m-2'].date, by['meeting:m-2'].endDate], ['2026-10-29', '2026-10-30']);
  assert.equal(by['invoice:inv-1'].title, 'INV-1 due · Westbay');
  assert.equal(by['invoice:inv-1'].href, '#/clients?tab=invoices');
  assert.deepEqual([by['contract:k-1:startDate'].title, by['contract:k-1:endDate'].date], ['Westbay: Agreement starts', '2027-10-31']);
  // Void invoices, undated ones, cancelled contracts, undated tasks, an unknown event kind and Work in Progress (no dates) stay off.
  ['invoice:inv-2', 'invoice:inv-3', 'contract:k-2:startDate', 'item:i-2', 'event:e-3', 'item:i-5'].forEach((k) => assert.ok(!by[k], k));
  // On a day: meetings and events first (by time), then tasks.
  const day = all.filter((e) => e.date === '2026-10-21').map((e) => e.key);
  assert.deepEqual(day, ['event:e-2', 'meeting:m-1', 'item:i-4']);

  // Staff (Sam): no admin's own page, no Outreach board (none by default); Clients at view by default shows invoices.
  const staff = cal.collectEntries(st, { meetings, tz: 'Australia/Sydney', userId: 'u-staff' });
  assert.ok(!staff.some((e) => ['item:i-own', 'item:i-4'].includes(e.key)));
  assert.ok(staff.some((e) => e.key === 'invoice:inv-1') && staff.some((e) => e.key === 'event:e-1') && staff.some((e) => e.key === 'meeting:m-2'));
  // …and with Clients at none, no invoice or contract dates at all.
  st.moduleAccess = [{ userId: 'u-staff', module: 'clients', level: 'none' }];
  const noClients = cal.collectEntries(st, { meetings, tz: 'Australia/Sydney', userId: 'u-staff' });
  assert.ok(!noClients.some((e) => cal.CLIENT_KINDS.includes(e.kind)));
  // An inactive viewer sees no boards.
  st.users[1].active = false;
  assert.ok(!cal.collectEntries(st, { tz: 'Australia/Sydney', userId: 'u-staff' }).some((e) => e.boardId));
});

await check('calendar: a multi-day event is on each of its days in each month; filters by person and kind', () => {
  const all = cal.collectEntries(calState(), { meetings, tz: 'Asia/Tbilisi' });
  const oct = cal.entriesByDay(all, '2026-10');
  const nov = cal.entriesByDay(all, '2026-11');
  const has = (m, d, k) => (m.get(d) || []).some((e) => e.key === k);
  assert.ok(has(oct, '2026-10-30', 'event:e-1') && has(oct, '2026-10-31', 'event:e-1') && !has(oct, '2026-10-29', 'event:e-1'));
  assert.ok(has(nov, '2026-11-01', 'event:e-1') && has(nov, '2026-11-02', 'event:e-1') && !has(nov, '2026-11-03', 'event:e-1'));
  assert.ok(has(oct, '2026-10-29', 'meeting:m-2') && has(oct, '2026-10-30', 'meeting:m-2'));
  // In Tbilisi the 09:30 Sydney planning meeting is at 02:30.
  const planning = all.find((e) => e.key === 'event:e-2');
  assert.deepEqual([planning.date, planning.time, planning.endTime], ['2026-10-21', '02:30', '03:30']);
  assert.equal(cal.inMonth(all, '2026-11').some((e) => e.key === 'event:e-1'), true);
  assert.equal(cal.inMonth(all, '2026-12').length, 0);
  assert.deepEqual(cal.filterEntries(all, { person: 'u-staff' }).map((e) => e.key).sort(),
    ['event:e-2', 'item:i-1', 'item:i-3', 'meeting:m-1'].sort());
  assert.deepEqual(cal.filterEntries(all, { kinds: new Set(['google']) }).map((e) => e.key).sort(), ['meeting:m-1', 'meeting:m-2']);
  assert.equal(cal.filterEntries(all, { kinds: new Set() }).length, all.length);
  assert.equal(cal.earliestDate(all), '2026-10-20');
  assert.equal(cal.earliestDate([]), '');
});

await check('calendar: a team event is cleaned before it is saved (calendar_events\' checks)', () => {
  const users = ['u1', 'u2'];
  assert.deepEqual(cal.cleanCalendarEvent({ kind: 'meeting', title: '  Planning ', day: '2026-10-21', startsAt: '2026-10-20T22:30:00Z',
    endsAt: '2026-10-20T23:30:00Z', endDay: '2026-10-25', people: ['u1', 'u1', 'ghost'] }, users), {
    kind: 'meeting', title: 'Planning', day: '2026-10-21', endDay: '', startsAt: '2026-10-20T22:30:00.000Z', endsAt: '2026-10-20T23:30:00.000Z',
    people: ['u1'],
  });
  assert.deepEqual(cal.cleanCalendarEvent({ kind: 'event', title: 'Expo', day: '2026-10-30', endDay: '2026-11-02' }, users), {
    kind: 'event', title: 'Expo', day: '2026-10-30', endDay: '2026-11-02', startsAt: '', endsAt: '', people: [],
  });
  assert.equal(cal.cleanCalendarEvent({ kind: 'event', title: 'Expo', day: '2026-10-30', endDay: '2026-10-30' }, users).endDay, '');
  assert.equal(cal.cleanCalendarEvent({ kind: 'event', title: 'x'.repeat(250), day: '2026-10-30' }, users).title.length, 200);
  [
    { kind: 'party', title: 'x', day: '2026-10-21' },
    { kind: 'event', title: '  ', day: '2026-10-21' },
    { kind: 'event', title: 'x', day: '21/10/2026' },
    { kind: 'event', title: 'x', day: '2026-10-21', endDay: '2026-10-20' },
    { kind: 'meeting', title: 'x', day: '2026-10-21', startsAt: '2026-10-21T10:00:00Z', endsAt: '2026-10-21T09:00:00Z' },
    { kind: 'meeting', title: 'x', day: '2026-10-21', startsAt: '2026-10-21T10:00:00Z', endsAt: '' },
    { kind: 'meeting', title: 'x', day: '2026-10-21', startsAt: '', endsAt: '2026-10-21T10:00:00Z' },
  ].forEach((f) => assert.equal(cal.cleanCalendarEvent(f, users), null, JSON.stringify(f)));
  assert.equal(cal.localInstant('2026-10-21', '9:30'), '');
  assert.equal(cal.localInstant('', '09:30'), '');
  assert.equal(new Date(cal.localInstant('2026-10-21', '09:30')).getMinutes(), 30);
});

if (createSeed) {
  await check('calendar seed: Posting schedule shows its calendar, the team events and Google meetings are relative to today', async () => {
    const { demoCalendarEvents, demoMeetings } = await import('../src/data/seed.js');
    const s = createSeed();
    const flagged = s.boards.filter((b) => b.calendar).map((b) => `${b.module}:${b.name}`);
    assert.deepEqual(flagged, ['marketing:Posting schedule']);
    assert.ok(s.boards.every((b) => typeof b.calendar === 'boolean'));
    assert.equal(s.calendarSeeded, true);
    assert.deepEqual(s.calendarEvents.map((e) => e.kind), ['meeting', 'event', 'reminder']);
    const users = s.users.map((u) => u.id);
    s.calendarEvents.forEach((e) => assert.ok(cal.cleanCalendarEvent(e, users), `${e.title} passes the checks`));
    const today = '2026-10-21';
    const ev = demoCalendarEvents(today);
    assert.deepEqual([ev[1].day, ev[1].endDay, ev[2].day], ['2026-10-30', '2026-11-01', '2026-11-05']);
    const m = demoMeetings(today);
    assert.ok(m.some((x) => x.busy && x.title === '') && m.some((x) => x.all_day));
    assert.ok(m.some((x) => x.start_date < '2026-10-01'), 'last month, for the Archive');
    assert.ok(m.every((x) => ['david', 'josh', 'hello'].includes(x.user_id) && x.end_date >= x.start_date));
  });

  await check('calendar migrate: Posting schedule\'s calendar is switched on once; switched off it stays off', () => {
    const old = createSeed();
    delete old.calendarSeeded;
    delete old.calendarEvents;
    old.boards.forEach((b) => { delete b.calendar; });
    const once = migrate(old);
    assert.deepEqual(once.boards.filter((b) => b.calendar).map((b) => b.name), ['Posting schedule']);
    assert.equal(once.calendarEvents.length, 3);
    once.boards.find((b) => b.calendar).calendar = false;
    once.calendarEvents = [];
    const twice = migrate(once);
    assert.equal(twice.boards.filter((b) => b.calendar).length, 0, 'a switched-off calendar stays off');
    assert.equal(twice.calendarEvents.length, 0, 'deleted team events stay deleted');
    assert.ok(twice.boards.every((b) => typeof b.calendar === 'boolean'));
  });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
