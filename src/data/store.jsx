// Single data seam for the app (docs/BACKEND.md §4). Every screen uses useStore() → { state, actions, sync }
// with the same state shape in both modes. Demo mode keeps state in localStorage; live mode loads it from
// Supabase, turns each change into row writes and folds other people's changes back in over realtime.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createSeed, ORG, USERS } from './seed';
import { LIVE, supabase } from '@/data/backend/client';
import { TABLES, assemble, diff, flatten, normalizeRow } from '@/data/backend/schema';
import { createSync } from '@/data/backend/sync';
import { GateScreen, Spinner } from '@/components/auth/AuthGate';
import { daysBetween, emailSnippet, localYmd } from '@/lib/format';

const KEY = 'assetstack-ops:v1';
const SAVED = { state: 'saved', message: '' };
const ROW_KEY = Object.fromEntries(TABLES.map((t) => [t.name, t.key]));
const ROW_PK = Object.fromEntries(TABLES.map((t) => [t.name, (t.onConflict || 'id').split(',')]));
const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// Runtime ids are uuids in both modes (live rows use them as primary keys). randomUUID needs a secure
// context, so a plain-http preview (a phone on the LAN) falls back to getRandomValues.
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const fresh = (list) => (list || []).map((x) => ({ ...x, id: uid() }));
const isAdmin = (d) => d.users.some((u) => u.id === d.me && u.role === 'admin');

// Bring v1 data saved by older builds up to the current shape.
function migrate(data) {
  // lastRead used to be one map shared by everyone; it is now { [userId]: { [channelId]: ts } }.
  const lr = data.lastRead || {};
  if (Object.values(lr).some((v) => typeof v === 'string')) data.lastRead = Object.fromEntries(data.users.map((u) => [u.id, { ...lr }]));
  // Deal owners used to be display names; they are now user ids.
  (data.deals || []).forEach((dl) => {
    const u = data.users.find((x) => x.id === dl.contact || normName(x.name) === normName(dl.contact));
    if (u) dl.contact = u.id;
  });
  // Business details, user accounts and client billing fields arrived with live mode.
  data.org = { ...ORG, ...data.org };
  data.users = data.users.map((u) => {
    const seed = USERS.find((x) => x.id === u.id);
    return { email: seed?.email ?? `${u.id}@example.com`, role: seed?.role ?? 'member', active: true, ...u };
  });
  (data.clients || []).forEach((c) => { c.abn ??= ''; c.billingAddress ??= ''; });
  return data;
}

function load() {
  let data = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1) data = migrate(parsed);
    }
  } catch { /* storage unavailable: fall back to seed */ }
  return { ...(data || createSeed()), mode: 'demo' };
}

// `mode` is set by the provider, never saved.
const persist = ({ mode: _mode, ...data }) => JSON.stringify(data);

// A send moves a New / No reply contact to Sent (never downgrading Opened or Replied). Found by id;
// entries from older builds only carry the name.
function markContactSent(d, entry) {
  const c = entry.contactId ? d.contacts.find((x) => x.id === entry.contactId) : d.contacts.find((x) => x.name === entry.contact);
  if (!c) return;
  if (c.status === 'New' || c.status === 'No reply') c.status = 'Sent';
  c.last = new Date().toISOString();
}

// Payment terms from the business details, in days (30 when unset), and a date that many calendar days on
// (safe across DST).
const termsOf = (d) => { const n = parseInt(d.org?.paymentTermsDays, 10); return n >= 0 ? n : 30; };
const daysAfter = (from, days) => localYmd(new Date(from.getFullYear(), from.getMonth(), from.getDate() + days));

// The next invoice number under the current prefix: one past the highest number made with it. Only the digits
// after the prefix count, so a prefix ending in digits (a year) never merges into the counter, and a new prefix
// (next year's) starts again at 1001.
function nextInvoiceNumber(d) {
  const prefix = d.org?.invoicePrefix ?? 'INV-';
  const counter = (number) => {
    const rest = String(number ?? '');
    const n = rest.startsWith(prefix) && /^\d+$/.test(rest.slice(prefix.length)) ? Number(rest.slice(prefix.length)) : 0;
    return Number.isSafeInteger(n) ? n : 0;
  };
  const next = Math.max(1000, ...d.clients.flatMap((c) => c.invoices.map((i) => counter(i.number)))) + 1;
  return `${prefix}${next}`;
}

// Another channel, one this user can't see, has the name: the next -2, -3 … instead.
function nextChannelName(d, name) {
  const m = String(name).match(/^(.*)-(\d{1,2})$/);
  const [base, from] = m ? [m[1], +m[2] + 1] : [name, 2];
  const taken = new Set(d.channels.map((c) => c.name));
  let i = from;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// Chat read positions are per viewer and only move forward.
function markSeen(d, chId, ts) {
  const mine = d.lastRead[d.me] || {};
  d.lastRead[d.me] = { ...mine, [chId]: (mine[chId] || '') > ts ? mine[chId] : ts };
}

const StoreContext = createContext(null);

function findItem(state, boardKey, itemId) {
  for (const g of state.boards[boardKey].groups) {
    const it = g.items.find((i) => i.id === itemId);
    if (it) return { group: g, item: it };
  }
  return {};
}

const newItem = (r) => {
  const values = { owner: '', status: 'Not started', ...r.values };
  return { ...r, id: uid(), name: r.name, values, done: values.status === 'Done', updates: fresh(r.updates), subtasks: fresh(r.subtasks) };
};

const newClient = (d, r) => ({
  group: 'Onboarding', status: 'Onboarding', priority: 'P2', next: '', sector: '', contact: d.me, team: [d.me],
  lastContact: '', demo: '', keyContact: '', email: '', demoUrl: '', avatar: '#3b82f6', abn: '', billingAddress: '',
  ...r,
  id: uid(), notes: fresh(r.notes), tasks: fresh(r.tasks), access: fresh(r.access),
  invoices: (r.invoices || []).map((inv) => ({ ...inv, id: uid(), lines: fresh(inv.lines) })),
});

// Records whose name is new (case-insensitive, also within the batch) → built entries; the rest are counted as skipped.
function takeNew(existing, records, build, result) {
  const seen = new Set(existing.map((x) => normName(x.name)));
  const out = [];
  (records || []).forEach((r) => {
    const name = normName(r?.name);
    if (!name || seen.has(name)) { result.skipped++; return; }
    seen.add(name);
    out.push(build(r));
  });
  result.added = out.length;
  return out;
}

// Every action edits a draft through mutate(fn) and may return a value (a new id, an import count).
// `modeActions` supplies reset / setMe / signOut, which differ per mode.
function createActions(mutate, modeActions) {
  return {
    ...modeActions,

    // People and business details. Admins edit anyone; others only their own name, initials and colour
    // (what RLS allows). The last active admin can't be demoted or deactivated. Returns whether it applied.
    updateProfile: (userId, patch) => mutate((d) => {
      const u = d.users.find((x) => x.id === userId);
      if (!u) return false;
      if (!isAdmin(d) && (userId !== d.me || ['role', 'active', 'email'].some((k) => k in patch))) return false;
      const demotes = ('role' in patch && patch.role !== 'admin') || patch.active === false;
      const admins = d.users.filter((x) => x.role === 'admin' && x.active !== false);
      if (demotes && admins.length === 1 && admins[0].id === userId) return false;
      Object.assign(u, patch, { id: u.id });
      return true;
    }),
    updateOrg: (patch) => mutate((d) => {
      if (!isAdmin(d)) return false;
      d.org = { ...d.org, ...patch };
      return true;
    }),

    // Bulk add from src/lib/importers.js (records already in state shape). Names that already exist, or repeat
    // in the file, are skipped. Tasks go into options.board, in group options.groupId or a new group named
    // options.groupName. → { added, skipped }
    importRecords: (kind, records, options = {}) => mutate((d) => {
      const result = { added: 0, skipped: 0 };
      if (kind === 'clients') {
        d.clients.unshift(...takeNew(d.clients, records, (r) => newClient(d, r), result));
      } else if (kind === 'contacts') {
        d.contacts.unshift(...takeNew(d.contacts, records, (r) => ({
          org: '', email: '', stage: 'Opportunity', status: 'New', last: new Date().toISOString(), ...r, id: uid(),
        }), result));
      } else if (kind === 'deals') {
        d.deals.push(...takeNew(d.deals, records, (r) => {
          const { clientId: _clientId, ...rest } = r;
          return { sector: '', value: 0, priority: 'P2', stage: 'Opportunities', contact: '', next: '', ...rest, id: uid() };
        }, result));
      } else if (kind === 'tasks' && d.boards[options.board]) {
        const board = d.boards[options.board];
        const items = takeNew(board.groups.flatMap((g) => g.items), records, newItem, result);
        if (items.length) {
          let g = board.groups.find((x) => x.id === options.groupId);
          if (!g) {
            g = { id: uid(), name: String(options.groupName || '').trim() || 'Imported', color: '#d6e4ff', items: [] };
            board.groups.push(g);
          }
          g.items.push(...items);
        }
      } else {
        result.skipped = records?.length || 0;
      }
      return result;
    }),

    // Boards
    addItem: (board, groupId, name = 'New task') => mutate((d) => {
      const g = d.boards[board].groups.find((x) => x.id === groupId) || d.boards[board].groups[0];
      const item = newItem({ name, values: { owner: d.me } });
      g.items.push(item);
      return item.id; // so the caller can open it
    }),
    updateItem: (board, itemId, patch) => mutate((d) => {
      const { item } = findItem(d, board, itemId);
      if (!item) return;
      const { values, ...rest } = patch;
      Object.assign(item, rest);
      if (values) Object.assign(item.values, values);
      if (values && 'status' in values) item.done = item.values.status === 'Done'; // done always follows status
    }),
    deleteItem: (board, itemId) => mutate((d) => {
      d.boards[board].groups.forEach((g) => { g.items = g.items.filter((i) => i.id !== itemId); });
    }),
    addGroup: (board, name) => mutate((d) => {
      d.boards[board].groups.push({ id: uid(), name, color: '#d6e4ff', items: [] });
    }),
    addUpdate: (board, itemId, text) => mutate((d) => {
      const { item } = findItem(d, board, itemId);
      item?.updates.unshift({ id: uid(), user: d.me, text, ts: new Date().toISOString() });
    }),
    addSubtask: (board, itemId, text) => mutate((d) => {
      findItem(d, board, itemId).item?.subtasks.push({ id: uid(), text, done: false });
    }),
    toggleSubtask: (board, itemId, subId) => mutate((d) => {
      const s = findItem(d, board, itemId).item?.subtasks.find((x) => x.id === subId);
      if (s) s.done = !s.done;
    }),

    // Pipeline
    addDeal: (deal) => mutate((d) => { d.deals.push({ id: uid(), stage: 'Opportunities', priority: 'P2', value: 0, ...deal }); }),
    moveDeal: (dealId, stage) => mutate((d) => { const x = d.deals.find((v) => v.id === dealId); if (x) x.stage = stage; }),
    convertDeal: (dealId) => mutate((d) => {
      const deal = d.deals.find((v) => v.id === dealId);
      if (!deal) return undefined;
      const existing = d.clients.find((c) => normName(c.name) === normName(deal.name));
      if (existing) { deal.clientId = existing.id; return existing.id; }
      // The deal owner keeps the client; fall back to whoever converts it.
      const owner = d.users.some((u) => u.id === deal.contact) ? deal.contact : d.me;
      const client = newClient(d, {
        name: deal.name, priority: deal.priority === 'P3' ? 'P2' : deal.priority, next: 'Schedule onboarding kick-off',
        sector: deal.sector, contact: owner, team: Array.from(new Set([owner, d.me])), lastContact: localYmd(),
      });
      d.clients.unshift(client);
      deal.clientId = client.id;
      return client.id;
    }),

    // Clients
    addClient: (name) => mutate((d) => { d.clients.unshift(newClient(d, { name, lastContact: localYmd() })); }),
    updateClient: (clientId, patch) => mutate((d) => { Object.assign(d.clients.find((c) => c.id === clientId) || {}, patch); }),
    addClientNote: (clientId, text) => mutate((d) => {
      const c = d.clients.find((x) => x.id === clientId);
      c?.notes.unshift({ id: uid(), user: d.me, text, ts: new Date().toISOString() });
    }),
    addClientTask: (clientId, text) => mutate((d) => { d.clients.find((x) => x.id === clientId)?.tasks.push({ id: uid(), text, done: false }); }),
    toggleClientTask: (clientId, taskId) => mutate((d) => {
      const t = d.clients.find((x) => x.id === clientId)?.tasks.find((x) => x.id === taskId);
      if (t) t.done = !t.done;
    }),
    // Numbered after the highest number with the current prefix; prefix and payment terms come from the business details.
    addInvoice: (clientId) => mutate((d) => {
      const issued = new Date();
      d.clients.find((x) => x.id === clientId)?.invoices.unshift({
        id: uid(), number: nextInvoiceNumber(d), issued: localYmd(issued), due: daysAfter(issued, termsOf(d)),
        status: 'Draft', lines: [{ id: uid(), desc: 'Platform licence', qty: 1, rate: 0 }],
      });
    }),
    // Leaving Draft is when an invoice is issued: it's dated today and keeps its payment terms.
    updateInvoice: (clientId, invId, patch) => mutate((d) => {
      const inv = d.clients.find((x) => x.id === clientId)?.invoices.find((i) => i.id === invId);
      if (!inv) return;
      if (inv.status === 'Draft' && patch.status && patch.status !== 'Draft') {
        const kept = daysBetween(inv.issued, inv.due);
        const issued = new Date();
        inv.issued = localYmd(issued);
        inv.due = daysAfter(issued, Number.isInteger(kept) && kept >= 0 ? kept : termsOf(d));
      }
      Object.assign(inv, patch);
    }),
    addInvoiceLine: (clientId, invId) => mutate((d) => {
      d.clients.find((x) => x.id === clientId)?.invoices.find((i) => i.id === invId)?.lines.push({ id: uid(), desc: '', qty: 1, rate: 0 });
    }),
    updateInvoiceLine: (clientId, invId, lineId, patch) => mutate((d) => {
      const l = d.clients.find((x) => x.id === clientId)?.invoices.find((i) => i.id === invId)?.lines.find((x) => x.id === lineId);
      if (l) Object.assign(l, patch);
    }),
    removeInvoiceLine: (clientId, invId, lineId) => mutate((d) => {
      const inv = d.clients.find((x) => x.id === clientId)?.invoices.find((i) => i.id === invId);
      if (inv) inv.lines = inv.lines.filter((l) => l.id !== lineId);
    }),
    addAccess: (clientId, entry) => mutate((d) => { d.clients.find((x) => x.id === clientId)?.access.push({ id: uid(), ...entry }); }),
    removeAccess: (clientId, accessId) => mutate((d) => {
      const c = d.clients.find((x) => x.id === clientId);
      if (c) c.access = c.access.filter((a) => a.id !== accessId);
    }),

    // Outreach
    logEmail: (entry) => mutate((d) => {
      d.emails.unshift({ id: uid(), ts: new Date().toISOString(), ...entry });
      if (entry.kind === 'sent') markContactSent(d, entry);
    }),
    queueApproval: (entry) => mutate((d) => { d.approvals.unshift({ id: uid(), ts: new Date().toISOString(), by: d.me, ...entry }); }),
    approveApproval: (apId) => mutate((d) => {
      const a = d.approvals.find((x) => x.id === apId);
      if (!a) return; // already handled
      d.approvals = d.approvals.filter((x) => x.id !== apId);
      const entry = { kind: 'sent', contactId: a.contactId, contact: a.contact, subject: a.subject, snippet: emailSnippet(a.body) };
      d.emails.unshift({ id: uid(), ts: new Date().toISOString(), ...entry });
      markContactSent(d, entry);
    }),
    discardApproval: (apId) => mutate((d) => { d.approvals = d.approvals.filter((x) => x.id !== apId); }),
    addContact: (contact) => mutate((d) => { d.contacts.unshift({ id: uid(), stage: 'Opportunity', status: 'New', last: new Date().toISOString(), ...contact }); }),

    // Team chat
    createChannel: (name, members) => mutate((d) => {
      const base = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
      // Keep names distinguishable: a taken name gets -2, -3 …
      const taken = new Set(d.channels.map((c) => c.name));
      let clean = base;
      for (let i = 2; taken.has(clean); i++) clean = `${base}-${i}`;
      const chId = uid();
      d.channels.push({ id: chId, name: clean, members: Array.from(new Set([d.me, ...members])) });
      markSeen(d, chId, new Date().toISOString());
      return chId;
    }),
    addChannelMembers: (chId, members) => mutate((d) => {
      const ch = d.channels.find((c) => c.id === chId);
      if (ch) ch.members = Array.from(new Set([...ch.members, ...members]));
    }),
    sendMessage: (chId, text) => mutate((d) => {
      const ts = new Date().toISOString();
      d.messages.push({ id: uid(), channel: chId, user: d.me, text, ts });
      markSeen(d, chId, ts);
    }),
    // Read up to the newest message even if its timestamp is ahead of this clock, so unread reaches 0.
    markRead: (chId) => mutate((d) => {
      const now = new Date().toISOString();
      const newest = d.messages.reduce((t, m) => (m.channel === chId && m.ts > t ? m.ts : t), '');
      markSeen(d, chId, newest > now ? newest : now);
    }),
  };
}

// ── Demo mode: localStorage, shared between tabs ───────────────────────────────

function DemoProvider({ children }) {
  const [state, setState] = useState(load);
  const stateRef = useRef(state);
  const lastRaw = useRef(null); // last JSON written here or adopted from another tab
  const commit = useCallback((next) => { stateRef.current = next; setState(next); }, []);

  useEffect(() => {
    const raw = persist(state);
    if (raw === lastRaw.current) return; // don't echo state that just arrived from another tab
    lastRaw.current = raw;
    try { localStorage.setItem(KEY, raw); } catch { /* ignore quota / private mode */ }
  }, [state]);

  // Keep tabs in sync: adopt what another tab saved instead of later overwriting it with stale state.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== KEY || !e.newValue || e.newValue === lastRaw.current) return;
      try {
        const data = JSON.parse(e.newValue);
        if (data?.version !== 1) return;
        lastRaw.current = e.newValue;
        commit({ ...migrate(data), mode: 'demo' });
      } catch { /* ignore malformed payload */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [commit]);

  // Runs synchronously against the latest state, so each action's logic runs exactly once.
  const mutate = useCallback((fn) => {
    const d = structuredClone(stateRef.current);
    const out = fn(d);
    commit(d);
    return out;
  }, [commit]);

  const actions = useMemo(() => createActions(mutate, {
    reset: () => commit({ ...createSeed(), mode: 'demo' }),
    setMe: (userId) => mutate((d) => { d.me = userId; }),
    signOut: async () => {},
  }), [mutate, commit]);

  const value = useMemo(() => ({ state, actions, sync: SAVED }), [state, actions]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

// ── Live mode: Supabase rows ⇄ state ───────────────────────────────────────────

// Rows state can't show yet (a child whose parent hasn't arrived) aren't in flatten(next); keep them until it does.
function keepOrphans(prev, next, ops) {
  const deleted = new Set(ops.filter((o) => o.op === 'delete').map((o) => `${o.table}|${o.key}`));
  Object.entries(prev).forEach(([table, rows]) => rows.forEach((row, key) => {
    if (next[table] && !next[table].has(key) && !deleted.has(`${table}|${key}`)) next[table].set(key, row);
  }));
}

// Plain closure rather than hooks, so every action and realtime change runs once against the latest rows.
function createLiveEngine({ me, onState, onPhase, onSync }) {
  let state = null;
  let rows = null; // { [table]: Map<key, row> }, mirrors what Supabase holds
  let early = []; // realtime changes that arrived before the first load finished
  let dirty = false;
  let timer = null;
  let sync = null;
  let unsubscribe = null;
  let closed = false;
  let edits = 0; // local changes since the last resync started
  let live = false; // the realtime channel is joined and streaming
  let missed = false; // changes may not have arrived (realtime was down, or joined after the load): reload
  let resyncing = false;
  let touched = null; // `${table}|${key}` changed here or over realtime while a resync loads

  const build = () => ({ ...assemble(rows, { me }), version: 1, mode: 'live', me });
  const publish = (next) => { state = next; if (!closed) onState(next); };
  // Realtime changes go into rows at once and into state once per burst.
  const refresh = () => {
    clearTimeout(timer);
    timer = null;
    if (dirty && rows) { dirty = false; publish(build()); }
  };
  const later = () => { dirty = true; timer ||= setTimeout(refresh, 50); };
  const touch = (table, key) => { touched?.add(`${table}|${key}`); };
  const put = (table, raw) => {
    const row = normalizeRow(table, raw);
    const key = ROW_KEY[table](row);
    touch(table, key);
    if (!sync.isPending(table, key)) rows[table].set(key, row); // a local edit still on its way wins
    return row;
  };

  // An echo of an older write of ours, arriving after a newer one went through, is dropped: applying it would
  // undo the newer edit.
  function apply({ table, eventType, row }) {
    if (!rows?.[table] || !row) return;
    if (eventType === 'DELETE') {
      const key = ROW_KEY[table](row); // deletes carry only the primary key
      touch(table, key);
      if (sync.staleEcho(table, key, null) || sync.isPending(table, key) || !rows[table].delete(key)) return;
    } else {
      if (sync.staleEcho(table, ROW_KEY[table](row), row)) return;
      const r = put(table, row);
      // Added to a channel someone else made: its row wasn't visible to us until now, so fetch it.
      if (table === 'channel_members' && r.user_id === me && !rows.channels.has(r.channel_id)) fetchChannel(r.channel_id);
    }
    later();
  }

  async function fetchChannel(chId) {
    const parts = [['channels', 'id'], ['channel_members', 'channel_id'], ['messages', 'channel_id']];
    try {
      const res = await Promise.all(parts.map(([table, col]) => supabase.from(table).select('*').eq(col, chId)));
      if (closed) return;
      parts.forEach(([table], i) => (res[i].data || []).forEach((raw) => put(table, raw)));
      later();
    } catch { /* shows up on the next load */ }
  }

  // Rows the database kept refusing, which sync gave up on. A duplicate invoice number or group name takes the
  // next free one; anything else goes back to what the database holds (or away, if it never saved).
  function onRejected(list) {
    if (closed || !rows) return;
    restore(list.filter((op) => !(op.op === 'upsert' && op.error.code === '23505' && renumber(op))));
  }

  // → whether the row took a new number or name (and is queued again).
  function renumber({ table, key }) {
    if (table !== 'invoices' && table !== 'channels') return false;
    return mutate((d) => {
      const x = table === 'invoices'
        ? d.clients.flatMap((c) => c.invoices).find((i) => i.id === key)
        : d.channels.find((c) => c.id === key);
      if (!x) return false;
      if (table === 'invoices') x.number = nextInvoiceNumber(d);
      else x.name = nextChannelName(d, x.name);
      return true;
    }) === true;
  }

  async function restore(list) {
    if (!list.length) return;
    await Promise.all(list.map(async ({ table, key, row }) => {
      try {
        let q = supabase.from(table).select('*');
        ROW_PK[table].forEach((col) => { q = q.eq(col, row[col]); });
        const { data, error } = await q.maybeSingle();
        if (closed || error || sync.isPending(table, key)) return;
        if (data) rows[table].set(key, normalizeRow(table, data));
        else rows[table].delete(key);
      } catch { /* put right on the next load */ }
    }));
    if (!closed) later();
  }

  // Changes made while realtime was down never arrive, and the first join can land after the load's selects:
  // reload and merge. Only once nothing local is queued or in flight, so a write landing after a table's
  // snapshot can't be undone by it; anything that changes while the load runs is newer than the snapshot.
  // Rows missing from the reload are dropped only when nothing local changed the whole time.
  function maybeResync() {
    if (missed && live && rows && !resyncing && !closed && !sync.hasPending()) resync();
  }

  async function resync() {
    resyncing = true;
    missed = false;
    edits = 0;
    touched = new Set();
    let ok = false;
    try {
      const loaded = await sync.loadAll();
      if (closed) return;
      const newer = (table, key) => sync.isPending(table, key) || touched.has(`${table}|${key}`);
      const prune = edits === 0 && !sync.hasPending();
      Object.entries(loaded).forEach(([table, fresh]) => {
        const local = rows[table];
        if (!local) return;
        fresh.forEach((row, key) => { if (!newer(table, key)) local.set(key, row); });
        if (prune) [...local.keys()].forEach((key) => { if (!fresh.has(key) && !newer(table, key)) local.delete(key); });
      });
      later();
      ok = true;
    } catch {
      missed = true; // try again on the next reconnect or save
    } finally {
      resyncing = false;
      touched = null;
    }
    if (ok) maybeResync(); // realtime dropped again while this one loaded
  }

  function onStatus(s) {
    if (closed) return;
    if (s.state === 'offline') missed = true;
    onSync({ state: s.state, message: s.message || '' });
    maybeResync();
  }

  function onRealtime(status) {
    if (closed) return;
    live = status === 'SUBSCRIBED';
    missed = true;
    maybeResync();
  }

  async function start() {
    onPhase({ status: 'loading' });
    sync = createSync({ supabase, onStatus, onRealtime, onRejected });
    unsubscribe = sync.subscribe((change) => {
      if (closed) return;
      if (rows) apply(change);
      else early.push(change);
    });
    try {
      const loaded = await sync.loadAll();
      if (closed) return;
      rows = loaded;
      early.forEach(apply);
      early = [];
      dirty = false;
      clearTimeout(timer);
      timer = null;
      publish(build());
      onPhase({ status: 'ready' });
      maybeResync(); // realtime joined while this loaded
    } catch (e) {
      if (!closed) onPhase({ status: 'error', message: e?.message || 'Loading failed' });
    }
  }

  function stop() {
    closed = true;
    clearTimeout(timer);
    unsubscribe?.();
    if (sync) { sync.flush(); sync.dispose(); } // best effort; signOut flushes first
  }

  // Same contract as demo mode, plus: diff against the rows Supabase holds and queue the difference.
  function mutate(fn) {
    if (!rows || closed) return undefined;
    refresh(); // fold in pending realtime changes first, or the diff would undo them
    const d = structuredClone(state);
    const out = fn(d);
    const next = flatten(d);
    const ops = diff(rows, next);
    keepOrphans(rows, next, ops);
    rows = next;
    edits++;
    ops.forEach((o) => touch(o.table, o.key));
    publish(d);
    sync.queue(ops);
    return out;
  }

  const flush = () => sync?.flush();
  const pending = () => Boolean(sync?.hasPending()); // edits not saved yet
  return { start, stop, mutate, flush, pending };
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

function LiveProvider({ userId, children }) {
  const [state, setState] = useState(null);
  const [phase, setPhase] = useState({ status: 'loading' });
  const [sync, setSync] = useState(SAVED);
  const [attempt, setAttempt] = useState(0);
  const engine = useRef(null);

  useEffect(() => {
    const e = createLiveEngine({ me: userId, onState: setState, onPhase: setPhase, onSync: setSync });
    engine.current = e;
    // Started a tick later so StrictMode's dev-only mount, unmount, mount opens one realtime channel, not two.
    const t = setTimeout(e.start, 0);
    return () => { clearTimeout(t); e.stop(); };
  }, [userId, attempt]);

  // Send queued edits when the tab is hidden, and warn before closing it with edits still unsaved.
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') engine.current?.flush(); };
    const warn = (e) => { if (engine.current?.pending()) { e.preventDefault(); e.returnValue = ''; } };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', warn);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('beforeunload', warn);
    };
  }, []);

  const mutate = useCallback((fn) => engine.current?.mutate(fn), []);
  const actions = useMemo(() => createActions(mutate, {
    reset: () => {}, // demo only
    setMe: () => {}, // demo only: live `me` is the signed-in user
    // → { unsaved: true } without signing out while edits still haven't saved, unless `force`.
    signOut: async ({ force = false } = {}) => {
      await Promise.race([engine.current?.flush(), wait(3000)]).catch(() => {});
      if (!force && engine.current?.pending()) return { unsaved: true };
      await supabase.auth.signOut({ scope: 'local' }); // this browser only; AuthGate then shows sign-in
      return { unsaved: false };
    },
  }), [mutate]);

  const value = useMemo(() => ({ state, actions, sync }), [state, actions, sync]);

  if (phase.status === 'error') {
    return (
      <GateScreen>
        <p className="dim">Couldn&rsquo;t load your workspace.</p>
        <p className="mt-1 break-words text-[12.5px] dimmer">{phase.message}</p>
        <div className="mt-5 flex justify-center gap-2">
          <button type="button" onClick={() => actions.signOut()} className="rounded-full chip px-4 h-10 font-semibold">Sign out</button>
          <button type="button" onClick={() => setAttempt((n) => n + 1)} className="btn-primary rounded-full px-5 h-10 font-semibold">Retry</button>
        </div>
      </GateScreen>
    );
  }
  if (phase.status !== 'ready' || !state) return <GateScreen><Spinner label="Loading" /></GateScreen>;
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

/** Live mode needs `userId` (the signed-in Supabase user); demo mode ignores it. */
export function StoreProvider({ userId, children }) {
  return LIVE ? <LiveProvider userId={userId}>{children}</LiveProvider> : <DemoProvider>{children}</DemoProvider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside StoreProvider');
  return ctx;
}

export function useUsers() {
  const { state } = useStore();
  return useMemo(() => Object.fromEntries(state.users.map((u) => [u.id, u])), [state.users]);
}

export function useIsAdmin() {
  const { state } = useStore();
  return isAdmin(state);
}
