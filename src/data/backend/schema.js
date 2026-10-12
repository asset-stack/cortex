// Pure mapping between the app state and Supabase rows (docs/BACKEND.md §1–3, docs/PHASE2.md §2 and §4).
// No Supabase or Vite imports: scripts/test-sync.mjs runs this file directly in Node.
import { TEAM_TIMEZONE } from '../../lib/format.js';

const BOARD_KEYS = ['projects', 'marketing']; // the board_groups.board_key check constraint (0002 merged admin into projects)

const DEFAULT_ORG = {
  businessName: '', abn: '', address: '', email: '', phone: '', bankAccountName: '', bsb: '', accountNumber: '',
  paymentTermsDays: 30, invoicePrefix: 'INV-',
};

// Column converters. Rows built from state (flatten) and rows read from Postgres (normalizeRow) go through
// the same ones, so equal data always serialises the same way and diff() only sees real changes.
const CONVERT = {
  id: (v) => String(v),
  text: (v) => (v == null ? '' : String(v)),
  fk: (v) => (v ? String(v) : null), // nullable uuid reference: '' ⇄ null
  date: (v) => (v ? String(v).slice(0, 10) : null), // 'YYYY-MM-DD': '' ⇄ null
  ts: (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  },
  int: (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; },
  num: (v) => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  },
  bool: (v) => Boolean(v),
  json: (v) => JSON.parse(JSON.stringify(v ?? {})),
  uuids: (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : []),
  // int[] (routine weekdays), kept sorted and unique. Accepts a Postgres array literal ('{1,2}') too.
  ints: (v) => {
    const list = Array.isArray(v) ? v : typeof v === 'string' ? v.replace(/[{}\s]/g, '').split(',') : [];
    return [...new Set(list.filter((x) => x !== '' && x != null).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
  },
  // time: 'HH:MM' ⇄ '', Postgres returns 'HH:MM:SS'.
  time: (v) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? ''));
    return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
  },
};

const t = 'text';
// Synced columns per table. updated_at / updated_by (and channels.created_by, profiles.created_at) are left
// to Postgres defaults and triggers, so they are never sent and are dropped from rows read back.
const COLUMNS = {
  profiles: { id: 'id', email: t, name: t, initials: t, color: t, role: t, active: 'bool', timezone: t },
  module_access: { user_id: 'id', module: t, level: t },
  org_settings: {
    id: 'int', business_name: t, abn: t, address: t, email: t, phone: t, bank_account_name: t, bsb: t,
    account_number: t, invoice_prefix: t, payment_terms_days: 'int',
  },
  board_groups: { id: 'id', board_key: t, name: t, color: t, position: 'int' },
  items: { id: 'id', board_key: t, group_id: 'id', position: 'int', name: t, values: 'json', done: 'bool' },
  item_updates: { id: 'id', item_id: 'id', user_id: 'fk', text: t, created_at: 'ts' },
  subtasks: { id: 'id', item_id: 'id', position: 'int', text: t, done: 'bool' },
  clients: {
    id: 'id', name: t, group_name: t, status: t, priority: t, next_step: t, sector: t, contact_id: 'fk', team: 'uuids',
    last_contact: 'date', demo: t, key_contact: t, email: t, demo_url: t, avatar: t, abn: t, billing_address: t, position: 'int',
  },
  deals: {
    id: 'id', name: t, sector: t, priority: t, stage: t, next_step: t, value: 'num', owner_id: 'fk', client_id: 'fk', contact_id: 'fk',
    position: 'int',
  },
  client_notes: { id: 'id', client_id: 'id', user_id: 'fk', text: t, created_at: 'ts' },
  client_tasks: { id: 'id', client_id: 'id', position: 'int', text: t, done: 'bool' },
  // billed_periods is the database's own (generate_due_invoices), so a full-row upsert never sends it.
  billing_plans: {
    id: 'id', client_id: 'id', description: t, amount: 'num', frequency: t, next_date: 'date', anchor_day: 'int', active: 'bool',
    position: 'int',
  },
  invoices: {
    id: 'id', client_id: 'id', number: t, issued: 'date', due: 'date', status: t, plan_id: 'fk', sent_at: 'ts', paid_on: 'date',
    position: 'int',
  },
  invoice_lines: { id: 'id', invoice_id: 'id', position: 'int', description: t, qty: t, rate: t },
  client_access: { id: 'id', client_id: 'id', position: 'int', name: t, email: t, role: t },
  client_usage: { id: 'id', client_id: 'id', month: 'date', assets: 'int', sites: 'int', seats: 'int', notes: t },
  bank_statements: { id: 'id', week_start: 'date', file_path: t, note: t, uploaded_by: 'fk', created_at: 'ts' },
  payments: { id: 'id', invoice_id: 'fk', client_id: 'id', amount: 'num', received_on: 'date', reference: t, statement_id: 'fk' },
  expenses: {
    id: 'id', date: 'date', vendor: t, category: t, amount: 'num', gst: 'num', client_id: 'fk', receipt_path: t, notes: t,
    created_by: 'fk', position: 'int',
  },
  subscriptions: {
    id: 'id', name: t, vendor: t, category: t, amount: 'num', cycle: t, renews_on: 'date', active: 'bool', notes: t, position: 'int',
  },
  contacts: { id: 'id', name: t, org: t, email: t, stage: t, status: t, last_at: 'ts', owner_id: 'fk', position: 'int' },
  emails: { id: 'id', kind: t, contact_id: 'fk', contact: t, subject: t, snippet: t, ts: 'ts' },
  sequences: { id: 'id', name: t, steps: 'int', enrolled: 'int', reply_rate: 'num', position: 'int' },
  approvals: { id: 'id', contact_id: 'fk', contact: t, subject: t, body: t, by_id: 'fk', ts: 'ts' },
  channels: { id: 'id', name: t },
  channel_members: { channel_id: 'id', user_id: 'id' },
  messages: { id: 'id', channel_id: 'id', user_id: 'fk', text: t, ts: 'ts' },
  read_state: { user_id: 'id', channel_id: 'id', last_read_at: 'ts' },
  routines: {
    id: 'id', title: t, category: t, minutes: 'int', assignee_id: 'id', weekdays: 'ints', start_time: 'time', active: 'bool',
    position: 'int',
  },
  todos: {
    id: 'id', assignee_id: 'id', created_by: 'fk', title: t, notes: t, day: 'date', start_time: 'time', minutes: 'int', category: t,
    source: t, routine_id: 'fk', ref: t, done: 'bool', done_at: 'ts', position: 'int',
  },
  time_entries: {
    id: 'id', user_id: 'id', day: 'date', start_time: 'time', minutes: 'int', category: t, note: t, source: t, position: 'int',
  },
};

const byId = (r) => String(r.id);

// Parents before children (FK-safe insert order; deletes run in reverse).
// update: the rows always exist (sign-up trigger, seeded org row), so the sync engine updates them in place. A
//   change RLS refuses (a member editing org settings) then changes nothing instead of failing the batch forever.
// parent: the table this one nests under in state, used by diff() to tell deletes from rows state never had.
// inState: rows of a top-level table that state can show; others (a board that no longer exists) are never deleted.
// setNull: links (column → table) the database clears when the row they point at is deleted (on delete set null).
export const TABLES = [
  { name: 'profiles', key: byId, update: true },
  { name: 'org_settings', key: byId, update: true },
  { name: 'module_access', key: (r) => `${r.user_id}:${r.module}`, onConflict: 'user_id,module' },
  { name: 'board_groups', key: byId, inState: (r) => BOARD_KEYS.includes(r.board_key) },
  { name: 'items', key: byId, parent: ['board_groups', 'group_id'] },
  { name: 'item_updates', key: byId, parent: ['items', 'item_id'] },
  { name: 'subtasks', key: byId, parent: ['items', 'item_id'] },
  { name: 'clients', key: byId },
  { name: 'contacts', key: byId, setNull: { owner_id: 'profiles' } }, // before deals (deals.contact_id)
  { name: 'deals', key: byId, setNull: { client_id: 'clients', contact_id: 'contacts' } },
  { name: 'client_notes', key: byId, parent: ['clients', 'client_id'] },
  { name: 'client_tasks', key: byId, parent: ['clients', 'client_id'] },
  { name: 'billing_plans', key: byId, parent: ['clients', 'client_id'] }, // before invoices (invoices.plan_id)
  { name: 'invoices', key: byId, parent: ['clients', 'client_id'], setNull: { plan_id: 'billing_plans' } },
  { name: 'invoice_lines', key: byId, parent: ['invoices', 'invoice_id'] },
  { name: 'client_access', key: byId, parent: ['clients', 'client_id'] },
  { name: 'client_usage', key: byId, parent: ['clients', 'client_id'] },
  { name: 'bank_statements', key: byId },
  // After invoices and bank_statements.
  { name: 'payments', key: byId, setNull: { invoice_id: 'invoices', statement_id: 'bank_statements' } },
  { name: 'expenses', key: byId, setNull: { client_id: 'clients' } },
  { name: 'subscriptions', key: byId },
  { name: 'emails', key: byId, setNull: { contact_id: 'contacts' } },
  { name: 'sequences', key: byId },
  { name: 'approvals', key: byId, setNull: { contact_id: 'contacts' } },
  { name: 'channels', key: byId },
  // Key-only rows with no update policy: an existing membership is left alone (on conflict do nothing).
  {
    name: 'channel_members', key: (r) => `${r.channel_id}:${r.user_id}`, onConflict: 'channel_id,user_id',
    ignoreDuplicates: true, parent: ['channels', 'channel_id'],
  },
  { name: 'messages', key: byId },
  { name: 'read_state', key: (r) => `${r.user_id}:${r.channel_id}`, onConflict: 'user_id,channel_id', parent: ['channels', 'channel_id'] },
  { name: 'routines', key: byId },
  { name: 'todos', key: byId, setNull: { routine_id: 'routines' } }, // after routines (todos.routine_id)
  { name: 'time_entries', key: byId },
];

const TABLE = Object.fromEntries(TABLES.map((x) => [x.name, x]));

// A Postgres row (select, realtime) or a raw state-derived row → the canonical row diff() compares.
export function normalizeRow(table, row) {
  const out = {};
  for (const [col, type] of Object.entries(COLUMNS[table])) out[col] = CONVERT[type](row?.[col]);
  return out;
}

// Sorted-key JSON, so jsonb key order (Postgres reorders keys) never counts as a change.
export const stable = (v) => JSON.stringify(v, (_, x) => (
  x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
    : x
));

export function flatten(state) {
  const rows = Object.fromEntries(TABLES.map((x) => [x.name, new Map()]));
  const put = (table, raw) => {
    const row = normalizeRow(table, raw);
    rows[table].set(TABLE[table].key(row), row);
  };

  (state.users || []).forEach((u) => put('profiles', {
    id: u.id, email: u.email, name: u.name, initials: u.initials, color: u.color, role: u.role || 'staff', active: u.active !== false,
    timezone: u.timezone || TEAM_TIMEZONE, // the database refuses '' (it checks real IANA names)
  }));
  (state.moduleAccess || []).forEach((a) => put('module_access', { user_id: a.userId, module: a.module, level: a.level }));

  const org = state.org || {};
  put('org_settings', {
    id: 1, business_name: org.businessName, abn: org.abn, address: org.address, email: org.email, phone: org.phone,
    bank_account_name: org.bankAccountName, bsb: org.bsb, account_number: org.accountNumber,
    invoice_prefix: org.invoicePrefix ?? DEFAULT_ORG.invoicePrefix, payment_terms_days: org.paymentTermsDays ?? DEFAULT_ORG.paymentTermsDays,
  });

  BOARD_KEYS.forEach((board) => (state.boards?.[board]?.groups || []).forEach((g, gi) => {
    put('board_groups', { id: g.id, board_key: board, name: g.name, color: g.color, position: gi });
    (g.items || []).forEach((it, ii) => {
      put('items', { id: it.id, board_key: board, group_id: g.id, position: ii, name: it.name, values: it.values, done: it.done });
      (it.updates || []).forEach((u) => put('item_updates', { id: u.id, item_id: it.id, user_id: u.user, text: u.text, created_at: u.ts }));
      (it.subtasks || []).forEach((s, si) => put('subtasks', { id: s.id, item_id: it.id, position: si, text: s.text, done: s.done }));
    });
  }));

  // Clients, contacts and a client's invoices are added at the top, so their positions count from the end:
  // adding one then leaves every other row as it was, instead of rewriting them all over other people's edits.
  const fromEnd = (list, i) => list.length - 1 - i;
  // To-dos and timesheet entries are numbered within one person's day, so the person and their admins (who see
  // everyone's) agree on positions, and a change on one day never renumbers another.
  const counters = new Map();
  const nextIn = (...group) => {
    const k = group.join('|');
    const i = counters.get(k) || 0;
    counters.set(k, i + 1);
    return i;
  };
  (state.clients || []).forEach((c, ci) => {
    put('clients', {
      id: c.id, name: c.name, group_name: c.group, status: c.status, priority: c.priority, next_step: c.next, sector: c.sector,
      contact_id: c.contact, team: c.team, last_contact: c.lastContact, demo: c.demo, key_contact: c.keyContact, email: c.email,
      demo_url: c.demoUrl, avatar: c.avatar, abn: c.abn, billing_address: c.billingAddress, position: fromEnd(state.clients, ci),
    });
    (c.notes || []).forEach((n) => put('client_notes', { id: n.id, client_id: c.id, user_id: n.user, text: n.text, created_at: n.ts }));
    (c.tasks || []).forEach((x, i) => put('client_tasks', { id: x.id, client_id: c.id, position: i, text: x.text, done: x.done }));
    (c.invoices || []).forEach((inv, i) => {
      put('invoices', {
        id: inv.id, client_id: c.id, number: inv.number, issued: inv.issued, due: inv.due, status: inv.status, plan_id: inv.planId,
        sent_at: inv.sentAt, paid_on: inv.paidOn, position: fromEnd(c.invoices, i),
      });
      (inv.lines || []).forEach((l, li) => put('invoice_lines', {
        id: l.id, invoice_id: inv.id, position: li, description: l.desc, qty: l.qty, rate: l.rate,
      }));
    });
    (c.access || []).forEach((a, i) => put('client_access', { id: a.id, client_id: c.id, position: i, name: a.name, email: a.email, role: a.role }));
    (c.plans || []).forEach((p, i) => put('billing_plans', {
      id: p.id, client_id: c.id, description: p.description, amount: p.amount, frequency: p.frequency, next_date: p.nextDate,
      anchor_day: p.anchorDay, active: p.active !== false, position: i,
    }));
    (c.usage || []).forEach((u) => put('client_usage', {
      id: u.id, client_id: c.id, month: u.month, assets: u.assets, sites: u.sites, seats: u.seats, notes: u.notes,
    }));
  });

  (state.deals || []).forEach((d, i) => put('deals', {
    id: d.id, name: d.name, sector: d.sector, priority: d.priority, stage: d.stage, next_step: d.next, value: d.value,
    owner_id: d.contact, client_id: d.clientId, contact_id: d.contactId, position: i,
  }));

  (state.contacts || []).forEach((c, i) => put('contacts', {
    id: c.id, name: c.name, org: c.org, email: c.email, stage: c.stage, status: c.status, last_at: c.last, owner_id: c.owner,
    position: fromEnd(state.contacts, i),
  }));
  (state.emails || []).forEach((e) => put('emails', {
    id: e.id, kind: e.kind, contact_id: e.contactId, contact: e.contact, subject: e.subject, snippet: e.snippet, ts: e.ts,
  }));
  (state.sequences || []).forEach((q, i) => put('sequences', {
    id: q.id, name: q.name, steps: q.steps, enrolled: q.enrolled, reply_rate: q.replyRate, position: i,
  }));
  (state.approvals || []).forEach((a) => put('approvals', {
    id: a.id, contact_id: a.contactId, contact: a.contact, subject: a.subject, body: a.body, by_id: a.by, ts: a.ts,
  }));

  (state.channels || []).forEach((ch) => {
    put('channels', { id: ch.id, name: ch.name });
    (ch.members || []).filter(Boolean).forEach((u) => put('channel_members', { channel_id: ch.id, user_id: u }));
  });
  (state.messages || []).forEach((m) => put('messages', { id: m.id, channel_id: m.channel, user_id: m.user, text: m.text, ts: m.ts }));

  // Only the current user's read positions are stored, and only for channels that exist.
  const channelIds = new Set((state.channels || []).map((ch) => ch.id));
  Object.entries(state.lastRead?.[state.me] || {}).forEach(([ch, ts]) => {
    if (channelIds.has(ch)) put('read_state', { user_id: state.me, channel_id: ch, last_read_at: ts });
  });

  (state.payments || []).forEach((p) => put('payments', {
    id: p.id, invoice_id: p.invoiceId, client_id: p.clientId, amount: p.amount, received_on: p.receivedOn, reference: p.reference,
    statement_id: p.statementId,
  }));
  (state.bankStatements || []).forEach((b) => put('bank_statements', {
    id: b.id, week_start: b.weekStart, file_path: b.filePath, note: b.note, uploaded_by: b.uploadedBy, created_at: b.createdAt,
  }));
  // Expenses are added at the top, like clients.
  (state.expenses || []).forEach((x, i) => put('expenses', {
    id: x.id, date: x.date, vendor: x.vendor, category: x.category, amount: x.amount, gst: x.gst, client_id: x.clientId,
    receipt_path: x.receiptPath, notes: x.notes, created_by: x.createdBy, position: fromEnd(state.expenses, i),
  }));
  (state.subscriptions || []).forEach((x, i) => put('subscriptions', {
    id: x.id, name: x.name, vendor: x.vendor, category: x.category, amount: x.amount, cycle: x.cycle, renews_on: x.renewsOn,
    active: x.active !== false, notes: x.notes, position: i,
  }));

  (state.routines || []).forEach((r, i) => put('routines', {
    id: r.id, title: r.title, category: r.category, minutes: r.minutes, assignee_id: r.assignee, weekdays: r.weekdays,
    start_time: r.start, active: r.active !== false, position: i,
  }));
  (state.todos || []).forEach((x) => put('todos', {
    id: x.id, assignee_id: x.assignee, created_by: x.createdBy, title: x.title, notes: x.notes, day: x.day, start_time: x.start,
    minutes: x.minutes, category: x.category, source: x.source, routine_id: x.routineId, ref: x.ref, done: x.done, done_at: x.doneAt,
    position: nextIn('todo', x.assignee, CONVERT.date(x.day)),
  }));
  (state.timeEntries || []).forEach((e) => put('time_entries', {
    id: e.id, user_id: e.user, day: e.day, start_time: e.start, minutes: e.minutes, category: e.category, note: e.note, source: e.source,
    position: nextIn('time', e.user, CONVERT.date(e.day)),
  }));

  return rows;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byPos = (a, b) => a.position - b.position || cmp(a.id, b.id);
const byPosDesc = (a, b) => b.position - a.position || cmp(a.id, b.id); // positions counted from the end
const newest = (col) => (a, b) => cmp(b[col] || '', a[col] || '') || cmp(a.id, b.id);
const oldest = (col) => (a, b) => cmp(a[col] || '', b[col] || '') || cmp(a.id, b.id);
const byDay = (a, b) => cmp(a.day || '', b.day || '') || a.position - b.position || cmp(a.id, b.id);
const groupBy = (list, col) => {
  const m = new Map();
  list.forEach((r) => { if (!m.has(r[col])) m.set(r[col], []); m.get(r[col]).push(r); });
  return m;
};
const kids = (m, parentId, sort) => (m.get(parentId) || []).sort(sort);

// Rows (Maps from flatten/loadAll, or arrays) → every state field except version / mode / me.
// Children whose parent row is missing are left out until it arrives.
export function assemble(rowsByTable, { me } = {}) {
  const all = (table) => [...(rowsByTable[table]?.values() ?? [])];

  const updates = groupBy(all('item_updates'), 'item_id');
  const subtasks = groupBy(all('subtasks'), 'item_id');
  const items = groupBy(all('items'), 'group_id');
  const groups = groupBy(all('board_groups'), 'board_key');
  const boards = Object.fromEntries(BOARD_KEYS.map((board) => [board, {
    groups: kids(groups, board, byPos).map((g) => ({
      id: g.id, name: g.name, color: g.color,
      items: kids(items, g.id, byPos).map((it) => ({
        id: it.id, name: it.name, values: { ...it.values }, done: it.done,
        updates: kids(updates, it.id, newest('created_at')).map((u) => ({ id: u.id, user: u.user_id ?? '', text: u.text, ts: u.created_at ?? '' })),
        subtasks: kids(subtasks, it.id, byPos).map((s) => ({ id: s.id, text: s.text, done: s.done })),
      })),
    })),
  }]));

  const notes = groupBy(all('client_notes'), 'client_id');
  const tasks = groupBy(all('client_tasks'), 'client_id');
  const invoices = groupBy(all('invoices'), 'client_id');
  const lines = groupBy(all('invoice_lines'), 'invoice_id');
  const access = groupBy(all('client_access'), 'client_id');
  const plans = groupBy(all('billing_plans'), 'client_id');
  const usage = groupBy(all('client_usage'), 'client_id');
  const clients = all('clients').sort(byPosDesc).map((c) => ({
    id: c.id, name: c.name, group: c.group_name, status: c.status, priority: c.priority, next: c.next_step, sector: c.sector,
    contact: c.contact_id ?? '', team: [...c.team], lastContact: c.last_contact ?? '', demo: c.demo, keyContact: c.key_contact,
    email: c.email, demoUrl: c.demo_url, avatar: c.avatar, abn: c.abn, billingAddress: c.billing_address,
    notes: kids(notes, c.id, newest('created_at')).map((n) => ({ id: n.id, user: n.user_id ?? '', text: n.text, ts: n.created_at ?? '' })),
    tasks: kids(tasks, c.id, byPos).map((x) => ({ id: x.id, text: x.text, done: x.done })),
    invoices: kids(invoices, c.id, byPosDesc).map((inv) => ({
      id: inv.id, number: inv.number, issued: inv.issued ?? '', due: inv.due ?? '', status: inv.status,
      planId: inv.plan_id ?? '', sentAt: inv.sent_at ?? '', paidOn: inv.paid_on ?? '',
      lines: kids(lines, inv.id, byPos).map((l) => ({ id: l.id, desc: l.description, qty: l.qty, rate: l.rate })),
    })),
    access: kids(access, c.id, byPos).map((a) => ({ id: a.id, name: a.name, email: a.email, role: a.role })),
    plans: kids(plans, c.id, byPos).map((p) => ({
      id: p.id, description: p.description, amount: p.amount, frequency: p.frequency, nextDate: p.next_date ?? '', anchorDay: p.anchor_day,
      active: p.active,
    })),
    // Newest month first.
    usage: kids(usage, c.id, newest('month')).map((u) => ({
      id: u.id, month: u.month ?? '', assets: u.assets, sites: u.sites, seats: u.seats, notes: u.notes,
    })),
  }));

  const o = all('org_settings')[0];
  const org = o ? {
    businessName: o.business_name, abn: o.abn, address: o.address, email: o.email, phone: o.phone,
    bankAccountName: o.bank_account_name, bsb: o.bsb, accountNumber: o.account_number,
    paymentTermsDays: o.payment_terms_days, invoicePrefix: o.invoice_prefix,
  } : { ...DEFAULT_ORG };

  const members = groupBy(all('channel_members'), 'channel_id');
  const lastRead = me ? { [me]: {} } : {};
  all('read_state').forEach((r) => { (lastRead[r.user_id] ||= {})[r.channel_id] = r.last_read_at ?? ''; });

  return {
    users: all('profiles')
      .sort((a, b) => cmp(a.name.toLowerCase(), b.name.toLowerCase()) || cmp(a.id, b.id))
      .map((u) => ({ id: u.id, name: u.name, initials: u.initials, color: u.color, email: u.email, role: u.role, active: u.active, timezone: u.timezone || TEAM_TIMEZONE })),
    moduleAccess: all('module_access')
      .sort((a, b) => cmp(a.user_id, b.user_id) || cmp(a.module, b.module))
      .map((a) => ({ userId: a.user_id, module: a.module, level: a.level })),
    org,
    boards,
    deals: all('deals').sort(byPos).map((d) => ({
      id: d.id, name: d.name, sector: d.sector, value: d.value, priority: d.priority, stage: d.stage,
      contact: d.owner_id ?? '', next: d.next_step, contactId: d.contact_id ?? '', ...(d.client_id ? { clientId: d.client_id } : {}),
    })),
    clients,
    contacts: all('contacts').sort(byPosDesc).map((c) => ({
      id: c.id, name: c.name, org: c.org, email: c.email, stage: c.stage, status: c.status, last: c.last_at ?? '', owner: c.owner_id ?? '',
    })),
    emails: all('emails').sort(newest('ts')).map((e) => ({
      id: e.id, kind: e.kind, ...(e.contact_id ? { contactId: e.contact_id } : {}), contact: e.contact,
      subject: e.subject, snippet: e.snippet, ts: e.ts ?? '',
    })),
    sequences: all('sequences').sort(byPos).map((q) => ({
      id: q.id, name: q.name, steps: q.steps, enrolled: q.enrolled, replyRate: q.reply_rate,
    })),
    approvals: all('approvals').sort(newest('ts')).map((a) => ({
      id: a.id, ...(a.contact_id ? { contactId: a.contact_id } : {}), contact: a.contact, subject: a.subject, body: a.body,
      by: a.by_id ?? '', ts: a.ts ?? '',
    })),
    // #general first, then by name.
    channels: all('channels')
      .sort((a, b) => (b.name === 'general') - (a.name === 'general') || cmp(a.name, b.name) || cmp(a.id, b.id))
      .map((ch) => ({ id: ch.id, name: ch.name, members: (members.get(ch.id) || []).map((m) => m.user_id) })),
    messages: all('messages').sort(oldest('ts')).map((m) => ({
      id: m.id, channel: m.channel_id, user: m.user_id ?? '', text: m.text, ts: m.ts ?? '',
    })),
    lastRead,
    routines: all('routines').sort(byPos).map((r) => ({
      id: r.id, title: r.title, category: r.category, minutes: r.minutes, assignee: r.assignee_id, weekdays: [...r.weekdays],
      start: r.start_time ?? '', active: r.active,
    })),
    // By day, then position (numbered within each person's day).
    todos: all('todos').sort(byDay).map((x) => ({
      id: x.id, assignee: x.assignee_id, createdBy: x.created_by ?? '', title: x.title, notes: x.notes, day: x.day ?? '',
      start: x.start_time ?? '', minutes: x.minutes, category: x.category, source: x.source, routineId: x.routine_id ?? '', ref: x.ref,
      done: x.done, doneAt: x.done_at ?? '',
    })),
    timeEntries: all('time_entries').sort(byDay).map((e) => ({
      id: e.id, user: e.user_id, day: e.day ?? '', start: e.start_time ?? '', minutes: e.minutes, category: e.category, note: e.note,
      source: e.source,
    })),
    // Newest first.
    payments: all('payments').sort(newest('received_on')).map((p) => ({
      id: p.id, invoiceId: p.invoice_id ?? '', clientId: p.client_id, amount: p.amount, receivedOn: p.received_on ?? '',
      reference: p.reference, statementId: p.statement_id ?? '',
    })),
    bankStatements: all('bank_statements').sort(newest('week_start')).map((b) => ({
      id: b.id, weekStart: b.week_start ?? '', filePath: b.file_path, note: b.note, uploadedBy: b.uploaded_by ?? '', createdAt: b.created_at ?? '',
    })),
    expenses: all('expenses').sort(byPosDesc).map((x) => ({
      id: x.id, date: x.date ?? '', vendor: x.vendor, category: x.category, amount: x.amount, gst: x.gst, clientId: x.client_id ?? '',
      receiptPath: x.receipt_path, notes: x.notes, createdBy: x.created_by ?? '',
    })),
    subscriptions: all('subscriptions').sort(byPos).map((x) => ({
      id: x.id, name: x.name, vendor: x.vendor, category: x.category, amount: x.amount, cycle: x.cycle, renewsOn: x.renews_on ?? '',
      active: x.active, notes: x.notes,
    })),
  };
}

// Keys of rows whose parent chain is present. A row outside it (an item whose group hasn't loaded yet, a read
// position for a channel this user can't see, a group on the old admin board before 0002 moves it) was never in
// state, so its absence from `next` is not a delete.
function reachable(rows) {
  const ok = {};
  const has = (table, key) => (ok[table] ? ok[table].has(key) : Boolean(rows[table]?.has(key)));
  TABLES.forEach(({ name, parent, inState }) => {
    if ((!parent && !inState) || !rows[name]) return;
    ok[name] = new Set([...rows[name]]
      .filter(([, r]) => (!inState || inState(r)) && (!parent || has(parent[0], String(r[parent[1]]))))
      .map(([k]) => k));
  });
  return has;
}

// Row maps before/after a change → ops for the sync engine, in TABLES order.
export function diff(prev, next) {
  const ops = [];
  const known = reachable(prev);
  TABLES.forEach(({ name }) => {
    const before = prev[name] || new Map();
    const after = next[name] || new Map();
    after.forEach((row, key) => {
      const old = before.get(key);
      if (!old || stable(old) !== stable(row)) ops.push({ table: name, op: 'upsert', key, row });
    });
    before.forEach((row, key) => {
      if (!after.has(key) && known(name, key)) ops.push({ table: name, op: 'delete', key, row });
    });
  });
  return ops;
}
