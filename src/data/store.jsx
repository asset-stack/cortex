// Single data seam for the app. Today it persists to localStorage; swap the
// load/save pair (and make actions async) to move to Supabase or monday.com.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createSeed } from './seed';

const KEY = 'assetstack-ops:v1';
const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data?.version === 1) return data;
    }
  } catch { /* storage unavailable: fall back to seed */ }
  return createSeed();
}

function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore quota / private mode */ }
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
  useEffect(() => { save(state); }, [state]);

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
        const existing = d.clients.find((c) => c.name === deal.name);
        if (existing) { deal.clientId = existing.id; return; }
        d.clients.unshift({
          id: clientId, name: deal.name, group: 'Onboarding', status: 'Onboarding', priority: deal.priority === 'P3' ? 'P2' : deal.priority,
          next: 'Schedule onboarding kick-off', sector: deal.sector, contact: d.me, team: [d.me], lastContact: new Date().toISOString().slice(0, 10),
          demo: '', keyContact: '', email: '', demoUrl: '', avatar: '#3b82f6', notes: [], tasks: [], invoices: [], access: [],
        });
        deal.clientId = clientId;
      });
    },

    // Clients
    addClient: (name) => mutate((d) => {
      d.clients.unshift({
        id: uid('c'), name, group: 'Onboarding', status: 'Onboarding', priority: 'P2', next: '', sector: '', contact: d.me, team: [d.me],
        lastContact: new Date().toISOString().slice(0, 10), demo: '', keyContact: '', email: '', demoUrl: '', avatar: '#3b82f6',
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
      const due = new Date(issued.getTime() + 30 * 864e5);
      d.clients.find((x) => x.id === clientId)?.invoices.unshift({
        id: uid('i'), number: `INV-${next}`, issued: issued.toISOString().slice(0, 10), due: due.toISOString().slice(0, 10),
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
      const c = d.contacts.find((x) => x.name === entry.contact);
      if (c && entry.kind === 'sent') { c.status = 'Sent'; c.last = new Date().toISOString(); }
    }),
    queueApproval: (entry) => mutate((d) => { d.approvals.unshift({ id: uid('ap'), ts: new Date().toISOString(), by: d.me, ...entry }); }),
    addContact: (contact) => mutate((d) => { d.contacts.unshift({ id: uid('p'), stage: 'Opportunity', status: 'New', last: new Date().toISOString(), ...contact }); }),

    // Team chat
    createChannel: (name, members) => {
      const chId = uid('ch');
      mutate((d) => {
        const clean = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
        d.channels.push({ id: chId, name: clean, members: Array.from(new Set([d.me, ...members])) });
        d.lastRead[chId] = new Date().toISOString();
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
      d.lastRead[chId] = ts;
    }),
    markRead: (chId) => mutate((d) => { d.lastRead[chId] = new Date().toISOString(); }),
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
