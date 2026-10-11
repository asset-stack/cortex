// Single data seam for the app. Today it persists to localStorage; swap the
// load/save pair (and make actions async) to move to Supabase or monday.com.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createSeed } from './seed';
import { emailSnippet, localYmd } from '@/lib/format';

const KEY = 'assetstack-ops:v1';
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;
const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

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
  return data;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data?.version === 1) return migrate(data);
    }
  } catch { /* storage unavailable: fall back to seed */ }
  return createSeed();
}

// A send moves a New / No reply contact to Sent (never downgrading Opened or Replied). Found by id;
// entries from older builds only carry the name.
function markContactSent(d, entry) {
  const c = entry.contactId ? d.contacts.find((x) => x.id === entry.contactId) : d.contacts.find((x) => x.name === entry.contact);
  if (!c) return;
  if (c.status === 'New' || c.status === 'No reply') c.status = 'Sent';
  c.last = new Date().toISOString();
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

export function StoreProvider({ children }) {
  const [state, setState] = useState(load);
  const lastRaw = useRef(null); // last JSON written here or adopted from another tab

  useEffect(() => {
    const raw = JSON.stringify(state);
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
        setState(migrate(data));
      } catch { /* ignore malformed payload */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // mutate(draft => { ... }) — clone-and-modify keeps every action a few lines.
  const mutate = useCallback((fn) => setState((s) => { const d = structuredClone(s); fn(d); return d; }), []);

  const actions = useMemo(() => ({
    reset: () => setState(createSeed()),
    setMe: (userId) => mutate((d) => { d.me = userId; }),

    // Boards
    addItem: (board, groupId, name = 'New task') => {
      const newId = uid('it'); // generated outside the updater so the caller can open it
      mutate((d) => {
        const g = d.boards[board].groups.find((x) => x.id === groupId) || d.boards[board].groups[0];
        g.items.push({ id: newId, name, values: { owner: d.me, status: 'Not started' }, updates: [], subtasks: [], done: false });
      });
      return newId;
    },
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
      d.boards[board].groups.push({ id: uid('g'), name, color: '#d6e4ff', items: [] });
    }),
    addUpdate: (board, itemId, text) => mutate((d) => {
      const { item } = findItem(d, board, itemId);
      item?.updates.unshift({ id: uid('u'), user: d.me, text, ts: new Date().toISOString() });
    }),
    addSubtask: (board, itemId, text) => mutate((d) => {
      findItem(d, board, itemId).item?.subtasks.push({ id: uid('s'), text, done: false });
    }),
    toggleSubtask: (board, itemId, subId) => mutate((d) => {
      const s = findItem(d, board, itemId).item?.subtasks.find((x) => x.id === subId);
      if (s) s.done = !s.done;
    }),

    // Pipeline
    addDeal: (deal) => mutate((d) => { d.deals.push({ id: uid('d'), stage: 'Opportunities', priority: 'P2', value: 0, ...deal }); }),
    moveDeal: (dealId, stage) => mutate((d) => { const x = d.deals.find((v) => v.id === dealId); if (x) x.stage = stage; }),
    convertDeal: (dealId) => {
      const clientId = uid('c');
      mutate((d) => {
        const deal = d.deals.find((v) => v.id === dealId);
        if (!deal) return;
        const existing = d.clients.find((c) => normName(c.name) === normName(deal.name));
        if (existing) { deal.clientId = existing.id; return; }
        // The deal owner keeps the client; fall back to whoever converts it.
        const owner = d.users.some((u) => u.id === deal.contact) ? deal.contact : d.me;
        d.clients.unshift({
          id: clientId, name: deal.name, group: 'Onboarding', status: 'Onboarding', priority: deal.priority === 'P3' ? 'P2' : deal.priority,
          next: 'Schedule onboarding kick-off', sector: deal.sector, contact: owner, team: Array.from(new Set([owner, d.me])), lastContact: localYmd(),
          demo: '', keyContact: '', email: '', demoUrl: '', avatar: '#3b82f6', notes: [], tasks: [], invoices: [], access: [],
        });
        deal.clientId = clientId;
      });
    },

    // Clients
    addClient: (name) => mutate((d) => {
      d.clients.unshift({
        id: uid('c'), name, group: 'Onboarding', status: 'Onboarding', priority: 'P2', next: '', sector: '', contact: d.me, team: [d.me],
        lastContact: localYmd(), demo: '', keyContact: '', email: '', demoUrl: '', avatar: '#3b82f6',
        notes: [], tasks: [], invoices: [], access: [],
      });
    }),
    updateClient: (clientId, patch) => mutate((d) => { Object.assign(d.clients.find((c) => c.id === clientId) || {}, patch); }),
    addClientNote: (clientId, text) => mutate((d) => {
      const c = d.clients.find((x) => x.id === clientId);
      c?.notes.unshift({ id: uid('n'), user: d.me, text, ts: new Date().toISOString() });
    }),
    addClientTask: (clientId, text) => mutate((d) => { d.clients.find((x) => x.id === clientId)?.tasks.push({ id: uid('t'), text, done: false }); }),
    toggleClientTask: (clientId, taskId) => mutate((d) => {
      const t = d.clients.find((x) => x.id === clientId)?.tasks.find((x) => x.id === taskId);
      if (t) t.done = !t.done;
    }),
    addInvoice: (clientId) => mutate((d) => {
      const all = d.clients.flatMap((c) => c.invoices.map((i) => parseInt(i.number.replace(/\D/g, ''), 10) || 0));
      const next = Math.max(1000, ...all) + 1;
      const issued = new Date();
      const due = new Date(issued.getFullYear(), issued.getMonth(), issued.getDate() + 30); // calendar days, safe across DST
      d.clients.find((x) => x.id === clientId)?.invoices.unshift({
        id: uid('i'), number: `INV-${next}`, issued: localYmd(issued), due: localYmd(due),
        status: 'Draft', lines: [{ id: uid('l'), desc: 'Platform licence', qty: 1, rate: 0 }],
      });
    }),
    updateInvoice: (clientId, invId, patch) => mutate((d) => {
      Object.assign(d.clients.find((x) => x.id === clientId)?.invoices.find((i) => i.id === invId) || {}, patch);
    }),
    addInvoiceLine: (clientId, invId) => mutate((d) => {
      d.clients.find((x) => x.id === clientId)?.invoices.find((i) => i.id === invId)?.lines.push({ id: uid('l'), desc: '', qty: 1, rate: 0 });
    }),
    updateInvoiceLine: (clientId, invId, lineId, patch) => mutate((d) => {
      const l = d.clients.find((x) => x.id === clientId)?.invoices.find((i) => i.id === invId)?.lines.find((x) => x.id === lineId);
      if (l) Object.assign(l, patch);
    }),
    removeInvoiceLine: (clientId, invId, lineId) => mutate((d) => {
      const inv = d.clients.find((x) => x.id === clientId)?.invoices.find((i) => i.id === invId);
      if (inv) inv.lines = inv.lines.filter((l) => l.id !== lineId);
    }),
    addAccess: (clientId, entry) => mutate((d) => { d.clients.find((x) => x.id === clientId)?.access.push({ id: uid('a'), ...entry }); }),
    removeAccess: (clientId, accessId) => mutate((d) => {
      const c = d.clients.find((x) => x.id === clientId);
      if (c) c.access = c.access.filter((a) => a.id !== accessId);
    }),

    // Outreach
    logEmail: (entry) => mutate((d) => {
      d.emails.unshift({ id: uid('e'), ts: new Date().toISOString(), ...entry });
      if (entry.kind === 'sent') markContactSent(d, entry);
    }),
    queueApproval: (entry) => mutate((d) => { d.approvals.unshift({ id: uid('ap'), ts: new Date().toISOString(), by: d.me, ...entry }); }),
    approveApproval: (apId) => mutate((d) => {
      const a = d.approvals.find((x) => x.id === apId);
      if (!a) return; // already handled
      d.approvals = d.approvals.filter((x) => x.id !== apId);
      const entry = { kind: 'sent', contactId: a.contactId, contact: a.contact, subject: a.subject, snippet: emailSnippet(a.body) };
      d.emails.unshift({ id: uid('e'), ts: new Date().toISOString(), ...entry });
      markContactSent(d, entry);
    }),
    discardApproval: (apId) => mutate((d) => { d.approvals = d.approvals.filter((x) => x.id !== apId); }),
    addContact: (contact) => mutate((d) => { d.contacts.unshift({ id: uid('p'), stage: 'Opportunity', status: 'New', last: new Date().toISOString(), ...contact }); }),

    // Team chat
    createChannel: (name, members) => {
      const chId = uid('ch');
      mutate((d) => {
        const base = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
        // Keep names distinguishable: a taken name gets -2, -3 …
        const taken = new Set(d.channels.map((c) => c.name));
        let clean = base;
        for (let i = 2; taken.has(clean); i++) clean = `${base}-${i}`;
        d.channels.push({ id: chId, name: clean, members: Array.from(new Set([d.me, ...members])) });
        markSeen(d, chId, new Date().toISOString());
      });
      return chId;
    },
    addChannelMembers: (chId, members) => mutate((d) => {
      const ch = d.channels.find((c) => c.id === chId);
      if (ch) ch.members = Array.from(new Set([...ch.members, ...members]));
    }),
    sendMessage: (chId, text) => mutate((d) => {
      const ts = new Date().toISOString();
      d.messages.push({ id: uid('m'), channel: chId, user: d.me, text, ts });
      markSeen(d, chId, ts);
    }),
    // Read up to the newest message even if its timestamp is ahead of this clock, so unread reaches 0.
    markRead: (chId) => mutate((d) => {
      const now = new Date().toISOString();
      const newest = d.messages.reduce((t, m) => (m.channel === chId && m.ts > t ? m.ts : t), '');
      markSeen(d, chId, newest > now ? newest : now);
    }),
  }), [mutate]);

  const value = useMemo(() => ({ state, actions }), [state, actions]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
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
