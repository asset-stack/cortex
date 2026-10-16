// Single data seam for the app (docs/BACKEND.md §4, docs/PHASE2.md §5). Every screen uses useStore() →
// { state, actions, sync } with the same state shape in both modes. Demo mode keeps state in localStorage; live mode
// loads it from Supabase, turns each change into row writes and folds other people's changes back in over realtime.
// Every action checks access first (src/lib/access.js) and returns false, changing nothing, when the signed-in user
// can't do it; RLS is the real enforcement.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createSeed, migrate } from './seed';
import { withPeople } from './boards';
import { LIVE, supabase } from '@/data/backend/client';
import { TABLES, assemble, diff, flatten, normalizeRow, stable } from '@/data/backend/schema';
import { createSync } from '@/data/backend/sync';
import { GateScreen, Spinner } from '@/components/auth/AuthGate';
import { LEVELS, MODULES, ROLES, STAFF_DEFAULTS, canEdit, canEditBoard, isAdmin, isSuperadmin } from '@/lib/access';
import { BOARD_MODULES, FIRST_GROUP, FIRST_GROUP_COLOR, GROUP_COLORS, findBoard, sameAudience } from '@/lib/boards';
import {
  PLAN_MONTHS, addDays, addMonths, clientCreatedLocal, contactPipelineLocal, ensureTodosLocal, generateDueInvoicesLocal, isPlanDate,
  isYmd, makeTodo, mondayOf, nextInvoiceNumber, termsOf, toHhmm, uid,
} from '@/lib/automations';
import { TEAM_TIMEZONE, browserTimezone, daysBetween, emailSnippet, invoiceTotals, localYmd, parseAmount, ymdIn } from '@/lib/format';
import { mentionedUserIds } from '@/lib/mentions';
import { cleanTool } from '@/lib/tools';
import { createContractDoc, googleConnectUrl, sendGoogleEmail, sendInvoiceEmail } from '@/integrations/google';

const KEY = 'assetstack-ops:v1';
// Who has had a day's routine to-dos made in this page load (`${me}|${day}`): My Work asks ensureTodos once per key.
// Demo reset and data adopted from another tab start it again.
export const ensuredTodos = new Set();
const SAVED = { state: 'saved', message: '' };
const ROW_KEY = Object.fromEntries(TABLES.map((t) => [t.name, t.key]));
const ROW_PK = Object.fromEntries(TABLES.map((t) => [t.name, (t.onConflict || 'id').split(',')]));
const PAGE = 1000; // PostgREST's default max rows per request
const BUCKET = 'finance'; // private storage bucket for bank screenshots and receipts (admins only)
const DEMO_FILE_WARN = 2 * 1024 * 1024;
const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const nowIso = () => new Date().toISOString();
const fresh = (list) => (list || []).map((x) => ({ ...x, id: uid() }));
const userExists = (d, userId) => d.users.some((u) => u.id === userId);

// Money and counts are numbers in state: '1,200' → 1200, anything unparseable → 0 (or the fallback).
const toNum = (v) => { const n = typeof v === 'number' ? v : parseAmount(v); return Number.isFinite(n) ? n : 0; };
const toInt = (v, fallback = 0) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : fallback; };
const textOf = (v) => String(v ?? '');
const ymdOr = (v, fallback = '') => (isYmd(v) ? v : fallback);

// Only admins approve, send, void or mark invoices paid; until an invoice leaves these it isn't issued.
const ADMIN_STATUSES = ['Approved', 'Sent', 'Paid', 'Void'];
const UNISSUED = ['Draft', 'Awaiting approval'];
// Invoices are dated on the business day (Sydney), wherever the admin is.
const teamToday = () => ymdIn(TEAM_TIMEZONE);
const CONTRACT_STATUSES = ['Draft', 'Sent for signature', 'Signed', 'Cancelled'];
const lowerTrim = (v) => textOf(v).trim().toLowerCase();

// A client's person (client.contacts[]), cleaned. Not an outreach contact (state.contacts).
const cleanPerson = (x = {}, id = uid()) => ({
  id, name: textOf(x.name).trim(), role: textOf(x.role).trim(), email: lowerTrim(x.email), phone: textOf(x.phone).trim(),
  billing: Boolean(x.billing),
});

// A contract's Key Details as typed (the Doc is filled from these). Dates must be real days, or empty.
const cleanContract = (k = {}) => ({
  title: textOf(k.title).trim(), startDate: ymdOr(k.startDate), endDate: ymdOr(k.endDate), annualFee: toNum(k.annualFee),
  paymentTerms: textOf(k.paymentTerms).trim(), userLimit: textOf(k.userLimit).trim(), platform: textOf(k.platform).trim(),
  customisations: textOf(k.customisations).trim(), mobileApp: textOf(k.mobileApp).trim(), governingLaw: textOf(k.governingLaw).trim(),
});

// Once nothing awaits approval, the admins' "Approve invoices" to-dos are done.
function tickApproveTodos(d) {
  if (d.clients.some((c) => c.invoices.some((i) => i.status === 'Awaiting approval'))) return;
  d.todos.forEach((t) => {
    if (t.source === 'automation' && t.ref.startsWith('approve:') && !t.done) Object.assign(t, { done: true, doneAt: nowIso() });
  });
}

function load() {
  let data = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1) data = migrate(parsed);
    }
  } catch { /* storage unavailable or unreadable: fall back to seed */ }
  return { ...(data || createSeed()), mode: 'demo' };
}

// `mode` is set by the provider, never saved.
const persist = ({ mode: _mode, ...data }) => JSON.stringify(data);

// Storage path for an upload: statements/<uuid>-<file> or receipts/<uuid>-<file>.
const storagePath = (folder, file) => `${folder}/${uid()}-${textOf(file?.name || 'file').replace(/[^\w.-]+/g, '-').slice(-80)}`;
const readDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

// A send moves a New / No reply contact to Sent (never downgrading Opened or Replied). Found by id;
// entries from older builds only carry the name.
function markContactSent(d, entry) {
  const c = entry.contactId ? d.contacts.find((x) => x.id === entry.contactId) : d.contacts.find((x) => x.name === entry.contact);
  if (!c) return;
  if (c.status === 'New' || c.status === 'No reply') c.status = 'Sent';
  c.last = nowIso();
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

function findItem(state, boardId, itemId) {
  for (const g of findBoard(state, boardId)?.groups || []) {
    const it = g.items.find((i) => i.id === itemId);
    if (it) return { group: g, item: it };
  }
  return {};
}

const firstGroup = (module) => ({ id: uid(), name: FIRST_GROUP[module] || 'To do', color: FIRST_GROUP_COLOR, items: [] });
// One step up (-1) or down (1) in a list; false at either end.
function step(list, i, dir) {
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return false;
  [list[i], list[j]] = [list[j], list[i]];
  return true;
}

const findClient = (d, clientId) => d.clients.find((c) => c.id === clientId);
const findInvoice = (d, clientId, invId) => findClient(d, clientId)?.invoices.find((i) => i.id === invId);

// `people` is who the item starts with (the person adding it) unless the record names its own.
const newItem = (r, people = []) => {
  const values = withPeople({ status: 'Not started', people, ...r.values });
  return { ...r, id: uid(), name: r.name, values, done: values.status === 'Done', updates: fresh(r.updates), subtasks: fresh(r.subtasks) };
};

const newClient = (d, r) => ({
  group: 'Onboarding', status: 'Onboarding', priority: 'P2', next: '', sector: '', contact: d.me, team: [d.me],
  lastContact: '', demo: '', demoUrl: '', platformUrl: '', avatar: '#3b82f6', abn: '', billingAddress: '',
  ...r,
  id: uid(), notes: fresh(r.notes), tasks: fresh(r.tasks), access: fresh(r.access), plans: fresh(r.plans), usage: fresh(r.usage),
  contacts: (r.contacts || []).map((x) => cleanPerson(x)), contracts: fresh(r.contracts),
  invoices: (r.invoices || []).map((inv) => ({ planId: '', sentAt: '', paidOn: '', sentTo: '', ...inv, id: uid(), lines: fresh(inv.lines) })),
});

const newContact = (d, r) => ({
  org: '', email: '', stage: 'Opportunity', status: 'New', last: nowIso(), owner: d.me, ...r, id: uid(),
});

const newDeal = (r) => {
  const { clientId: _clientId, ...rest } = r;
  return { sector: '', value: 0, priority: 'P2', stage: 'Opportunities', contact: '', next: '', contactId: '', ...rest, id: uid() };
};

// `prev` is the plan before the edit: a date that isn't a real day this century keeps the previous one ('' clears it).
// The billing day follows the date someone picks; generating invoices moves the date on and keeps it.
const cleanPlan = (p, id, prev = {}) => {
  const nextDate = p.nextDate === '' || isPlanDate(p.nextDate) ? p.nextDate : prev.nextDate || '';
  return {
    id, description: textOf(p.description), amount: toNum(p.amount), frequency: PLAN_MONTHS[p.frequency] ? p.frequency : 'monthly',
    nextDate, anchorDay: nextDate === prev.nextDate ? toInt(prev.anchorDay) : toInt(nextDate.slice(8, 10)), active: p.active !== false,
  };
};

// null when the assignee isn't a team member.
const cleanRoutine = (d, r, id) => (userExists(d, r.assignee) ? {
  id, title: textOf(r.title), category: r.category || 'Other', minutes: toInt(r.minutes, 30), assignee: r.assignee,
  weekdays: [...new Set((r.weekdays || []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))].sort((a, b) => a - b),
  start: toHhmm(r.start), active: r.active !== false,
} : null);

// Amount includes GST; GST defaults to amount / 11.
const cleanExpense = (x, id) => {
  const amount = toNum(x.amount);
  return {
    id, date: ymdOr(x.date, localYmd()), vendor: textOf(x.vendor), category: x.category || 'Other', amount,
    gst: x.gst === undefined || x.gst === '' ? Math.round((amount * 100) / 11) / 100 : toNum(x.gst), clientId: x.clientId || '',
    receiptPath: textOf(x.receiptPath), notes: textOf(x.notes), createdBy: x.createdBy || '',
  };
};

const cleanSubscription = (x, id) => ({
  id, name: textOf(x.name), vendor: textOf(x.vendor), category: x.category || 'Software', amount: toNum(x.amount),
  cycle: x.cycle === 'annually' ? 'annually' : 'monthly', renewsOn: ymdOr(x.renewsOn), active: x.active !== false, notes: textOf(x.notes),
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

// Every action edits a draft through mutate(fn) and may return a value (a new id, an import count). Returning false
// means refused: mutate then saves nothing. `mode` supplies what differs per mode: reset / setMe / signOut (public),
// read (fn of the current state), rpc + pull (live), and the finance file store (upload, fileUrl, removeFile).
function createActions(mutate, mode) {
  // fn runs only when the signed-in user may do it; otherwise false and nothing changes.
  const editing = (module, fn) => mutate((d) => (canEdit(d, module) ? fn(d) : false));
  const admin = (fn) => mutate((d) => (isAdmin(d) ? fn(d) : false));
  // fn runs only when the signed-in user can edit that board (src/lib/access.js boardLevel).
  const onBoard = (boardId, fn) => mutate((d) => {
    const b = findBoard(d, boardId);
    return b && canEditBoard(d, b) ? fn(d, b) : false;
  });
  // Team boards (the sub-menus under Projects and Marketing) are the admins' to add, rename, order and delete.
  const onTeamBoard = (boardId, fn) => admin((d) => {
    const b = findBoard(d, boardId);
    return b && !b.owner ? fn(d, b) : false;
  });
  // Your own to-dos, or anyone's for admins.
  const mayTodo = (d, t) => Boolean(t) && (t.assignee === d.me || isAdmin(d));
  // The database keeps one to-do per routine, person and day, and one automation to-do per ref, person and day.
  const clashes = (d, t, day, assignee) => d.todos.some((x) => x.id !== t.id && x.assignee === assignee && x.day === day
    && ((t.routineId && x.routineId === t.routineId) || (t.source === 'automation' && x.source === 'automation' && x.ref === t.ref)));

  const actions = {
    reset: mode.reset,
    setMe: mode.setMe,
    signOut: mode.signOut,

    // ── People, access, business details ──

    // Admins edit anyone's name, initials and colour; staff their own. Role, active and email are the SuperAdmin's,
    // and the last active SuperAdmin can't be demoted or deactivated.
    updateProfile: (userId, patch = {}) => mutate((d) => {
      const u = d.users.find((x) => x.id === userId);
      if (!u) return false;
      const guarded = ['role', 'active', 'email'].some((k) => k in patch && patch[k] !== u[k]);
      if (guarded ? !isSuperadmin(d) : !(isAdmin(d) || userId === d.me)) return false;
      if ('role' in patch && !ROLES.includes(patch.role)) return false;
      const demotes = ('role' in patch && patch.role !== 'superadmin') || patch.active === false;
      const supers = d.users.filter((x) => x.role === 'superadmin' && x.active !== false);
      if (demotes && supers.length === 1 && supers[0].id === userId) return false;
      Object.assign(u, patch, { id: u.id });
      return true;
    }),
    // SuperAdmin only. Setting a module back to the staff default removes the override.
    setModuleAccess: (userId, module, level) => mutate((d) => {
      if (!isSuperadmin(d) || !userExists(d, userId) || !MODULES.includes(module) || !LEVELS.includes(level)) return false;
      const i = d.moduleAccess.findIndex((x) => x.userId === userId && x.module === module);
      if (level === STAFF_DEFAULTS[module]) {
        if (i >= 0) d.moduleAccess.splice(i, 1);
      } else if (i >= 0) {
        d.moduleAccess[i].level = level;
      } else {
        d.moduleAccess.push({ userId, module, level });
      }
      return true;
    }),
    updateOrg: (patch) => admin((d) => {
      d.org = { ...d.org, ...patch };
      return true;
    }),

    // Bulk add from src/lib/importers.js (records already in state shape). Names that already exist, or repeat
    // in the file, are skipped. Tasks go into options.board, in group options.groupId or a new group named
    // options.groupName. → { added, skipped }, or false without edit access to where they go.
    importRecords: (kind, records, options = {}) => mutate((d) => {
      const result = { added: 0, skipped: 0 };
      const target = kind === 'tasks' ? findBoard(d, options.board) : null;
      const module = { clients: 'clients', contacts: 'outreach', deals: 'pipeline', tasks: target?.module }[kind];
      if (!module) {
        result.skipped = records?.length || 0;
        return result;
      }
      if (kind === 'tasks' ? !canEditBoard(d, target) : !canEdit(d, module)) return false;
      if (kind === 'clients') {
        const added = takeNew(d.clients, records, (r) => newClient(d, r), result);
        d.clients.unshift(...added);
        if (!mode.live) added.forEach((c) => clientCreatedLocal(d, c.id)); // live: the client_contract_todo trigger
      } else if (kind === 'contacts') {
        const added = takeNew(d.contacts, records, (r) => newContact(d, r), result);
        d.contacts.unshift(...added);
        if (!mode.live) added.forEach((c) => contactPipelineLocal(d, c.id, '')); // live: the contact_pipeline trigger
      } else if (kind === 'deals') {
        // Imported contacts that replied already made their $0 deal (the contact automation): the deal's row in the file
        // fills it in instead of being skipped as a duplicate. It stays linked to its contact.
        const made = new Map(d.deals.filter((x) => x.contactId && !toNum(x.value)).map((x) => [normName(x.name), x]));
        let filled = 0;
        const rest = (records || []).filter((r) => {
          const x = made.get(normName(r?.name));
          if (!x) return true;
          made.delete(normName(r?.name)); // a repeat in the file is still a duplicate
          const { id: _id, name: _name, contactId: _contactId, clientId: _clientId, ...fields } = r;
          Object.entries(fields).forEach(([k, v]) => { if (v !== '' && v != null) x[k] = v; });
          filled++;
          return false;
        });
        d.deals.push(...takeNew(d.deals, rest, newDeal, result));
        result.added += filled;
      } else {
        const board = target;
        const items = takeNew(board.groups.flatMap((g) => g.items), records, (r) => newItem(r), result);
        if (items.length) {
          let g = board.groups.find((x) => x.id === options.groupId);
          if (!g) {
            g = { id: uid(), name: String(options.groupName || '').trim() || 'Imported', color: '#d6e4ff', items: [] };
            board.groups.push(g);
          }
          g.items.push(...items);
        }
      }
      return result;
    }),

    // ── Boards (Projects, Marketing): team boards are the admins'; groups and tasks need edit access to the board ──

    // A new team board at the end of its module, with one group. → id
    addBoard: (module, name) => admin((d) => {
      const title = textOf(name).trim();
      if (!BOARD_MODULES.includes(module) || !title) return false;
      const b = { id: uid(), module, name: title, owner: '', groups: [firstGroup(module)] };
      const last = d.boards.reduce((at, x, i) => (x.module === module ? i : at), -1);
      d.boards.splice(last + 1, 0, b);
      return b.id;
    }),
    renameBoard: (boardId, name) => onTeamBoard(boardId, (d, b) => {
      const title = textOf(name).trim();
      if (!title) return false;
      b.name = title;
      return true;
    }),
    // Among its module's team boards.
    moveBoard: (boardId, dir) => onTeamBoard(boardId, (d, b) => {
      const at = d.boards.map((x, i) => (x.module === b.module && !x.owner ? i : -1)).filter((i) => i >= 0);
      const k = at.indexOf(d.boards.indexOf(b));
      const j = k + (dir < 0 ? -1 : 1);
      if (k < 0 || j < 0 || j >= at.length) return false;
      [d.boards[at[k]], d.boards[at[j]]] = [d.boards[at[j]], d.boards[at[k]]];
      return true;
    }),
    // With its groups, tasks, subtasks and updates.
    removeBoard: (boardId) => onTeamBoard(boardId, (d, b) => {
      d.boards = d.boards.filter((x) => x !== b);
      return true;
    }),

    // Into `groupId` (else the board's first group; a board with none gets one). → id
    addItem: (boardId, groupId, name = 'New task') => onBoard(boardId, (d, b) => {
      if (!b.groups.length) b.groups.push(firstGroup(b.module));
      const g = b.groups.find((x) => x.id === groupId) || b.groups[0];
      const item = newItem({ name: textOf(name).trim() || 'New task', values: {} }, [d.me]);
      g.items.push(item);
      return item.id; // so the caller can open it
    }),
    updateItem: (boardId, itemId, patch = {}) => onBoard(boardId, (d) => {
      const { item } = findItem(d, boardId, itemId);
      if (!item) return false;
      const { values, id: _id, updates: _updates, subtasks: _subtasks, ...rest } = patch;
      if ('name' in rest && !textOf(rest.name).trim()) delete rest.name; // a task always has a name
      Object.assign(item, rest);
      if (values) {
        const next = { ...values };
        if ('owner' in next && !('people' in next)) next.people = next.owner ? [next.owner] : []; // a single-person picker
        delete next.owner;
        item.values = withPeople({ ...item.values, ...next });
        if ('status' in values) item.done = item.values.status === 'Done'; // done always follows status
      }
      return true;
    }),
    deleteItem: (boardId, itemId) => onBoard(boardId, (d, b) => {
      if (!findItem(d, boardId, itemId).item) return false;
      b.groups.forEach((g) => { g.items = g.items.filter((i) => i.id !== itemId); });
      return true;
    }),
    // To another group, on this board or another board you can edit with the same audience (two team boards of a
    // module, or within one person's page; 0006's same_audience trigger), to the end of the group (the target
    // board's first group when no group is named).
    moveItem: (boardId, itemId, { board: toBoardId = boardId, group: toGroupId } = {}) => onBoard(boardId, (d, b) => {
      const { group, item } = findItem(d, boardId, itemId);
      const to = findBoard(d, toBoardId);
      if (!item || !sameAudience(b, to) || !canEditBoard(d, to)) return false;
      if (!to.groups.length) to.groups.push(firstGroup(to.module));
      const g = to.groups.find((x) => x.id === toGroupId) || to.groups[0];
      if (g === group) return false;
      group.items = group.items.filter((i) => i !== item);
      g.items.push(item);
      return true;
    }),

    // Groups (Active, Backlog …) on a board. → id
    addGroup: (boardId, name) => onBoard(boardId, (d, b) => {
      const color = GROUP_COLORS[b.groups.length % GROUP_COLORS.length];
      const g = { id: uid(), name: textOf(name).trim() || 'New group', color, items: [] };
      b.groups.push(g);
      return g.id;
    }),
    renameGroup: (boardId, groupId, name) => onBoard(boardId, (d, b) => {
      const g = b.groups.find((x) => x.id === groupId);
      const title = textOf(name).trim();
      if (!g || !title) return false;
      g.name = title;
      return true;
    }),
    moveGroup: (boardId, groupId, dir) => onBoard(boardId, (d, b) => step(b.groups, b.groups.findIndex((x) => x.id === groupId), dir)),
    // With its tasks.
    removeGroup: (boardId, groupId) => onBoard(boardId, (d, b) => {
      if (!b.groups.some((x) => x.id === groupId)) return false;
      b.groups = b.groups.filter((x) => x.id !== groupId);
      return true;
    }),

    // Everyone @mentioned in an update is added to the item's people.
    addUpdate: (boardId, itemId, text) => onBoard(boardId, (d) => {
      const { item } = findItem(d, boardId, itemId);
      if (!item || !textOf(text).trim()) return false;
      item.updates.unshift({ id: uid(), user: d.me, text: textOf(text).trim(), ts: nowIso() });
      item.values = withPeople({ ...item.values, people: [...(item.values.people || []), ...mentionedUserIds(text, d.users)] });
      return true;
    }),
    // Your own updates, or anyone's for admins (as the database allows).
    editUpdate: (boardId, itemId, updateId, text) => onBoard(boardId, (d) => {
      const u = findItem(d, boardId, itemId).item?.updates.find((x) => x.id === updateId);
      if (!u || !(u.user === d.me || isAdmin(d)) || !textOf(text).trim()) return false;
      u.text = textOf(text).trim();
      return true;
    }),
    removeUpdate: (boardId, itemId, updateId) => onBoard(boardId, (d) => {
      const { item } = findItem(d, boardId, itemId);
      const u = item?.updates.find((x) => x.id === updateId);
      if (!u || !(u.user === d.me || isAdmin(d))) return false;
      item.updates = item.updates.filter((x) => x !== u);
      return true;
    }),
    addSubtask: (boardId, itemId, text) => onBoard(boardId, (d) => {
      const { item } = findItem(d, boardId, itemId);
      if (!item || !textOf(text).trim()) return false;
      item.subtasks.push({ id: uid(), text: textOf(text).trim(), done: false });
      return true;
    }),
    toggleSubtask: (boardId, itemId, subId) => onBoard(boardId, (d) => {
      const s = findItem(d, boardId, itemId).item?.subtasks.find((x) => x.id === subId);
      if (!s) return false;
      s.done = !s.done;
      return true;
    }),
    renameSubtask: (boardId, itemId, subId, text) => onBoard(boardId, (d) => {
      const s = findItem(d, boardId, itemId).item?.subtasks.find((x) => x.id === subId);
      if (!s || !textOf(text).trim()) return false;
      s.text = textOf(text).trim();
      return true;
    }),
    removeSubtask: (boardId, itemId, subId) => onBoard(boardId, (d) => {
      const { item } = findItem(d, boardId, itemId);
      if (!item?.subtasks.some((x) => x.id === subId)) return false;
      item.subtasks = item.subtasks.filter((x) => x.id !== subId);
      return true;
    }),

    // ── My Work ──

    // Staff add to their own list; admins to anyone's. → id
    addTodo: (todo = {}) => mutate((d) => {
      const assignee = todo.assignee || d.me;
      if (!userExists(d, assignee) || (assignee !== d.me && !isAdmin(d))) return false;
      const t = makeTodo({
        assignee, createdBy: d.me, title: textOf(todo.title).trim() || 'New to-do', notes: textOf(todo.notes),
        day: ymdOr(todo.day, localYmd()), start: toHhmm(todo.start), minutes: toInt(todo.minutes, 30), category: todo.category || 'Other',
      });
      d.todos.push(t);
      return t.id;
    }),
    // Where a to-do came from and who made it never change; only admins move it to someone else.
    updateTodo: (id, patch = {}) => mutate((d) => {
      const t = d.todos.find((x) => x.id === id);
      if (!mayTodo(d, t)) return false;
      if ('assignee' in patch && patch.assignee !== t.assignee && !(isAdmin(d) && userExists(d, patch.assignee))) return false;
      if ('day' in patch && !isYmd(patch.day)) return false;
      if (clashes(d, t, patch.day ?? t.day, patch.assignee ?? t.assignee)) return false;
      const { id: _id, createdBy: _createdBy, source: _source, routineId: _routineId, ref: _ref, ...next } = patch;
      if ('title' in next) next.title = textOf(next.title);
      if ('start' in next) next.start = toHhmm(next.start);
      if ('minutes' in next) next.minutes = toInt(next.minutes, t.minutes);
      if ('done' in next) next.doneAt = next.done ? (next.doneAt || t.doneAt || nowIso()) : '';
      Object.assign(t, next);
      return true;
    }),
    toggleTodo: (id) => mutate((d) => {
      const t = d.todos.find((x) => x.id === id);
      if (!mayTodo(d, t)) return false;
      t.done = !t.done;
      t.doneAt = t.done ? nowIso() : '';
      return true;
    }),
    // The person who added it, or an admin (as the database allows).
    deleteTodo: (id) => mutate((d) => {
      const t = d.todos.find((x) => x.id === id);
      if (!t || !(isAdmin(d) || t.createdBy === d.me)) return false;
      d.todos = d.todos.filter((x) => x.id !== id);
      return true;
    }),
    // To the end of that day's list.
    moveTodo: (id, day) => mutate((d) => {
      const i = d.todos.findIndex((x) => x.id === id);
      if (i < 0 || !mayTodo(d, d.todos[i]) || !isYmd(day) || clashes(d, d.todos[i], day, d.todos[i].assignee)) return false;
      const [t] = d.todos.splice(i, 1);
      d.todos.push({ ...t, day });
      return true;
    }),
    // Daily routines (admins). → id
    addRoutine: (routine = {}) => admin((d) => {
      const r = cleanRoutine(d, {
        title: '', category: 'Other', minutes: 30, assignee: d.me, weekdays: [1, 2, 3, 4, 5], start: '', active: true, ...routine,
      }, uid());
      if (!r) return false;
      d.routines.push(r);
      return r.id;
    }),
    updateRoutine: (id, patch = {}) => admin((d) => {
      const r = d.routines.find((x) => x.id === id);
      const next = r && cleanRoutine(d, { ...r, ...patch }, r.id);
      if (!next) return false;
      Object.assign(r, next);
      return true;
    }),
    // Its to-dos stay, unlinked (routine_id is set null in the database).
    deleteRoutine: (id) => admin((d) => {
      if (!d.routines.some((x) => x.id === id)) return false;
      d.routines = d.routines.filter((x) => x.id !== id);
      d.todos.forEach((t) => { if (t.routineId === id) t.routineId = ''; });
      return true;
    }),
    // The signed-in user's routine to-dos for `day` (and an admin's Monday bank reminder). Safe to call repeatedly.
    // → Promise<number added | false>
    // Admins first raise any invoices that are due, so "Approve invoices" shows up on their first visit of the day.
    ensureTodos: async (day = localYmd()) => {
      if (!isYmd(day)) return false;
      if (!mode.live) {
        return mutate((d) => {
          if (isAdmin(d)) generateDueInvoicesLocal(d);
          return ensureTodosLocal(d, day);
        });
      }
      if (mode.read(isAdmin)) await actions.generateDueInvoices();
      const added = await mode.rpc('ensure_todos', { p_day: day });
      if (added > 0) await mode.pull('todos', { assignee_id: mode.read((s) => s.me), day });
      return added;
    },

    // ── Tools (each person's logins and links in My Work): your own, or anyone's for admins ──

    // → id
    addTool: (userId, fields = {}) => mutate((d) => {
      if (!userExists(d, userId) || !(userId === d.me || isAdmin(d))) return false;
      const x = { ...cleanTool(fields), id: uid(), user: userId, createdBy: d.me };
      if (!x.name && !x.url) return false;
      d.tools.push(x);
      return x.id;
    }),
    updateTool: (id, patch = {}) => mutate((d) => {
      const x = d.tools.find((t) => t.id === id);
      if (!x || !(x.user === d.me || isAdmin(d))) return false;
      Object.assign(x, cleanTool({ ...x, ...patch }));
      return true;
    }),
    removeTool: (id) => mutate((d) => {
      const x = d.tools.find((t) => t.id === id);
      if (!x || !(x.user === d.me || isAdmin(d))) return false;
      d.tools = d.tools.filter((t) => t.id !== id);
      return true;
    }),
    // One place up (-1) or down (1) within that person's list.
    moveTool: (id, dir) => mutate((d) => {
      const x = d.tools.find((t) => t.id === id);
      if (!x || !(x.user === d.me || isAdmin(d))) return false;
      const mine = d.tools.filter((t) => t.user === x.user);
      const other = mine[mine.indexOf(x) + (dir < 0 ? -1 : 1)];
      if (!other) return false;
      const i = d.tools.indexOf(x);
      const j = d.tools.indexOf(other);
      [d.tools[i], d.tools[j]] = [d.tools[j], d.tools[i]];
      return true;
    }),

    // ── Timesheet ──

    // Replaces the signed-in user's entries for `day` with `blocks` ({ start, minutes, category, note, source }).
    saveTimesheet: (day, blocks = []) => mutate((d) => {
      if (!isYmd(day) || !userExists(d, d.me)) return false;
      const entries = (blocks || []).filter((b) => toHhmm(b?.start)).map((b) => ({
        id: uid(), user: d.me, day, start: toHhmm(b.start), minutes: toInt(b.minutes, 60), category: b.category || 'Other',
        note: textOf(b.note), source: b.source === 'suggested' ? 'suggested' : 'manual',
      })).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
      d.timeEntries = [...d.timeEntries.filter((e) => !(e.user === d.me && e.day === day)), ...entries];
      return true;
    }),

    // ── Pipeline ──

    addDeal: (deal = {}) => editing('pipeline', (d) => {
      const x = newDeal(deal);
      d.deals.push(x);
      return x.id;
    }),
    moveDeal: (dealId, stage) => editing('pipeline', (d) => {
      const x = d.deals.find((v) => v.id === dealId);
      if (!x) return false;
      x.stage = stage;
      return true;
    }),
    // Needs edit access to the pipeline and to clients. → client id
    convertDeal: (dealId) => mutate((d) => {
      const deal = d.deals.find((v) => v.id === dealId);
      if (!deal || !canEdit(d, 'pipeline') || !canEdit(d, 'clients')) return false;
      const existing = d.clients.find((c) => normName(c.name) === normName(deal.name));
      if (existing) { deal.clientId = existing.id; return existing.id; }
      // The deal owner keeps the client; fall back to whoever converts it.
      const owner = userExists(d, deal.contact) ? deal.contact : d.me;
      // The outreach contact the deal came from becomes the client's first, billing contact.
      const from = d.contacts.find((c) => c.id === deal.contactId);
      const client = newClient(d, {
        name: deal.name, priority: deal.priority === 'P3' ? 'P2' : deal.priority, next: 'Schedule onboarding kick-off',
        sector: deal.sector, contact: owner, team: Array.from(new Set([owner, d.me])), lastContact: localYmd(),
        contacts: from && (from.name || from.email) ? [{ name: from.name, email: from.email, billing: true }] : [],
      });
      d.clients.unshift(client);
      deal.clientId = client.id;
      if (!mode.live) clientCreatedLocal(d, client.id); // live: the client_contract_todo trigger
      return client.id;
    }),

    // ── Clients: edit access to clients ──

    addClient: (name) => editing('clients', (d) => {
      const c = newClient(d, { name, lastContact: localYmd() });
      d.clients.unshift(c);
      if (!mode.live) clientCreatedLocal(d, c.id); // live: the client_contract_todo trigger
      return c.id;
    }),
    // A client's people: name, role, email, phone and whether invoices go to them (billing). → id
    addClientContact: (clientId, person = {}) => editing('clients', (d) => {
      const c = findClient(d, clientId);
      if (!c) return false;
      const x = cleanPerson(person);
      c.contacts.push(x);
      return x.id;
    }),
    updateClientContact: (clientId, personId, patch = {}) => editing('clients', (d) => {
      const x = findClient(d, clientId)?.contacts.find((p) => p.id === personId);
      if (!x) return false;
      Object.assign(x, cleanPerson({ ...x, ...patch }, x.id));
      return true;
    }),
    removeClientContact: (clientId, personId) => editing('clients', (d) => {
      const c = findClient(d, clientId);
      if (!c?.contacts.some((p) => p.id === personId)) return false;
      c.contacts = c.contacts.filter((p) => p.id !== personId);
      return true;
    }),
    updateClient: (clientId, patch) => editing('clients', (d) => {
      const c = findClient(d, clientId);
      if (!c) return false;
      Object.assign(c, patch, { id: c.id });
      return true;
    }),
    addClientNote: (clientId, text) => editing('clients', (d) => {
      const c = findClient(d, clientId);
      if (!c) return false;
      c.notes.unshift({ id: uid(), user: d.me, text, ts: nowIso() });
      return true;
    }),
    addClientTask: (clientId, text) => editing('clients', (d) => {
      const c = findClient(d, clientId);
      if (!c) return false;
      c.tasks.push({ id: uid(), text, done: false });
      return true;
    }),
    toggleClientTask: (clientId, taskId) => editing('clients', (d) => {
      const t = findClient(d, clientId)?.tasks.find((x) => x.id === taskId);
      if (!t) return false;
      t.done = !t.done;
      return true;
    }),
    // Numbered after the highest number with the current prefix; prefix and payment terms come from the business details.
    addInvoice: (clientId) => editing('clients', (d) => {
      const c = findClient(d, clientId);
      if (!c) return false;
      const issued = teamToday();
      const inv = {
        id: uid(), number: nextInvoiceNumber(d), issued, due: addDays(issued, termsOf(d)), status: 'Draft', planId: '', sentAt: '',
        paidOn: '', sentTo: '', lines: [{ id: uid(), desc: 'Platform licence', qty: 1, rate: 0 }],
      };
      c.invoices.unshift(inv);
      return inv.id;
    }),
    // Approving, sending, voiding and paying are for admins (the database refuses them from staff too). Leaving Draft
    // or Awaiting approval is when an invoice is issued: it's dated today and keeps its payment terms.
    updateInvoice: (clientId, invId, patch = {}) => editing('clients', (d) => {
      const inv = findInvoice(d, clientId, invId);
      if (!inv) return false;
      const was = inv.status;
      const status = patch.status ?? was;
      const byAdmin = isAdmin(d);
      if (!byAdmin && ((status !== was && ADMIN_STATUSES.includes(status)) || ('paidOn' in patch && patch.paidOn !== inv.paidOn))) return false;
      if (UNISSUED.includes(was) && !UNISSUED.includes(status)) {
        const kept = daysBetween(inv.issued, inv.due);
        const today = teamToday();
        inv.issued = today;
        inv.due = addDays(today, Number.isInteger(kept) && kept >= 0 ? kept : termsOf(d));
      }
      Object.assign(inv, patch, { id: inv.id });
      if (status === 'Sent' && !inv.sentAt) inv.sentAt = nowIso();
      if (byAdmin && status === 'Paid' && !inv.paidOn) inv.paidOn = teamToday();
      if (byAdmin && was === 'Paid' && status !== 'Paid' && !('paidOn' in patch)) inv.paidOn = '';
      if (was === 'Awaiting approval') tickApproveTodos(d);
      return true;
    }),
    // Admins. Approved, issued today (Sydney) and due after the payment terms. With `email` ({ to, subject, text }) it
    // is then emailed from the approver's own Gmail and marked Sent; otherwise the PDF goes out by hand (Mark as sent).
    // → Promise<{ status: 'Approved' | 'Sent', error? } | false>
    approveInvoice: async (clientId, invId, email = null) => {
      const approved = admin((d) => {
        const invoice = findInvoice(d, clientId, invId);
        if (!invoice || !UNISSUED.includes(invoice.status)) return false;
        const today = teamToday();
        Object.assign(invoice, { status: 'Approved', issued: today, due: addDays(today, termsOf(d)) });
        tickApproveTodos(d);
        return true;
      });
      if (!approved) return false;
      if (!email) return { status: 'Approved' };
      const res = await actions.emailInvoice(clientId, invId, email);
      return res.ok ? { status: 'Sent' } : { status: 'Approved', error: res.error };
    },
    // Admins: email an Approved (or resend a Sent) invoice from your own Gmail, with its PDF. Recorded as Sent to
    // those addresses. → Promise<{ ok: true } | { ok: false, error }>
    emailInvoice: async (clientId, invId, { to = [], subject = '', text = '' } = {}) => {
      const found = mode.read((s) => {
        const client = s.clients.find((c) => c.id === clientId);
        const invoice = client?.invoices.find((i) => i.id === invId);
        return isAdmin(s) && invoice && ['Approved', 'Sent'].includes(invoice.status) ? { client, invoice, org: s.org } : null;
      });
      if (!found) return { ok: false, error: 'Only an approved invoice can be emailed.' };
      const res = await sendInvoiceEmail(mode.invoke, { ...found, to, subject, text });
      if (!res.ok) return res;
      admin((d) => {
        const inv = findInvoice(d, clientId, invId);
        if (!inv || !['Approved', 'Sent'].includes(inv.status)) return false;
        Object.assign(inv, { status: 'Sent', sentAt: nowIso(), sentTo: to.join(', ') });
        return true;
      });
      return { ok: true };
    },
    // Admins: the PDF went out by hand.
    markInvoiceSent: (clientId, invId) => admin((d) => {
      const inv = findInvoice(d, clientId, invId);
      if (!inv || inv.status === 'Paid' || inv.status === 'Void') return false;
      if (UNISSUED.includes(inv.status)) {
        const today = teamToday();
        Object.assign(inv, { issued: today, due: addDays(today, termsOf(d)) });
      }
      Object.assign(inv, { status: 'Sent', sentAt: nowIso() });
      tickApproveTodos(d);
      return true;
    }),
    addInvoiceLine: (clientId, invId) => editing('clients', (d) => {
      const inv = findInvoice(d, clientId, invId);
      if (!inv) return false;
      inv.lines.push({ id: uid(), desc: '', qty: 1, rate: 0 });
      return true;
    }),
    updateInvoiceLine: (clientId, invId, lineId, patch) => editing('clients', (d) => {
      const l = findInvoice(d, clientId, invId)?.lines.find((x) => x.id === lineId);
      if (!l) return false;
      Object.assign(l, patch, { id: l.id });
      return true;
    }),
    removeInvoiceLine: (clientId, invId, lineId) => editing('clients', (d) => {
      const inv = findInvoice(d, clientId, invId);
      if (!inv) return false;
      inv.lines = inv.lines.filter((l) => l.id !== lineId);
      return true;
    }),
    addAccess: (clientId, entry) => editing('clients', (d) => {
      const c = findClient(d, clientId);
      if (!c) return false;
      const a = { ...entry, id: uid() };
      c.access.push(a);
      return a.id;
    }),
    removeAccess: (clientId, accessId) => editing('clients', (d) => {
      const c = findClient(d, clientId);
      if (!c) return false;
      c.access = c.access.filter((a) => a.id !== accessId);
      return true;
    }),
    // Billing plans ({ description, amount, frequency: monthly | quarterly | annually, nextDate, active }). → id
    addPlan: (clientId, plan = {}) => editing('clients', (d) => {
      const c = findClient(d, clientId);
      if (!c) return false;
      const p = cleanPlan({ nextDate: addMonths(`${localYmd().slice(0, 7)}-01`, 1), ...plan }, uid());
      c.plans.push(p);
      return p.id;
    }),
    updatePlan: (clientId, planId, patch = {}) => editing('clients', (d) => {
      const p = findClient(d, clientId)?.plans.find((x) => x.id === planId);
      if (!p) return false;
      Object.assign(p, cleanPlan({ ...p, ...patch }, p.id, p));
      return true;
    }),
    // Its invoices stay, unlinked (plan_id is set null in the database).
    deletePlan: (clientId, planId) => editing('clients', (d) => {
      const c = findClient(d, clientId);
      if (!c?.plans.some((x) => x.id === planId)) return false;
      c.plans = c.plans.filter((x) => x.id !== planId);
      c.invoices.forEach((inv) => { if (inv.planId === planId) inv.planId = ''; });
      return true;
    }),
    // Admins. Invoices Awaiting approval for every plan that is due. → Promise<number made | false>
    generateDueInvoices: async () => {
      if (!mode.read(isAdmin)) return false;
      if (!mode.live) return mutate((d) => generateDueInvoicesLocal(d));
      const made = await mode.rpc('generate_due_invoices');
      if (made > 0) await Promise.all(['billing_plans', 'invoices', 'invoice_lines'].map((t) => mode.pull(t)));
      return made;
    },
    // A client's platform usage for a month ('YYYY-MM' or any day in it); creates the row if needed. → id
    upsertUsage: (clientId, month, patch = {}) => editing('clients', (d) => {
      const c = findClient(d, clientId);
      const m = /^\d{4}-\d{2}/.test(textOf(month)) ? `${textOf(month).slice(0, 7)}-01` : '';
      if (!c || !isYmd(m)) return false;
      let row = c.usage.find((u) => u.month === m);
      if (!row) {
        row = { id: uid(), month: m, assets: 0, sites: 0, seats: 0, credits: 0, notes: '' };
        c.usage = [...c.usage, row].sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0)); // newest first
      }
      ['assets', 'sites', 'seats'].forEach((k) => { if (k in patch) row[k] = toInt(patch[k], row[k]); });
      if ('credits' in patch) row.credits = Math.max(0, toNum(patch.credits));
      if ('notes' in patch) row.notes = textOf(patch.notes);
      return row.id;
    }),
    // A platform export, totalled per month (src/lib/usageImport.js): each month's figures replace what was there, so
    // importing the same file again changes nothing. → number of months, or false.
    importUsage: (clientId, months = []) => editing('clients', (d) => {
      const c = findClient(d, clientId);
      const rows = (months || []).filter((x) => /^\d{4}-\d{2}-01$/.test(textOf(x?.month)));
      if (!c || !rows.length) return false;
      rows.forEach((x) => {
        let row = c.usage.find((u) => u.month === x.month);
        if (!row) {
          row = { id: uid(), month: x.month, assets: 0, sites: 0, seats: 0, credits: 0, notes: '' };
          c.usage.push(row);
        }
        if (x.credits != null) row.credits = Math.max(0, toNum(x.credits));
        ['assets', 'sites', 'seats'].forEach((k) => { if (x[k] != null) row[k] = toInt(x[k], row[k]); });
      });
      c.usage.sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0)); // newest first
      return rows.length;
    }),

    // ── Contracts (admins make them from the Google Doc template; everyone with clients access sees them) ──

    // Copies the template into the contracts folder, filled from `details`, as the signed-in admin (their Google
    // account). With `docUrl` an existing Doc is linked instead. → Promise<{ ok: true, id, url } | { ok: false, error }>
    createContract: async (clientId, details = {}, { docUrl = '' } = {}) => {
      const ctx = mode.read((s) => {
        const client = s.clients.find((c) => c.id === clientId);
        return isAdmin(s) && client ? { client, org: s.org } : null;
      });
      if (!ctx) return { ok: false, error: 'Only admins can make contracts.' };
      const k = cleanContract(details);
      let doc = { id: '', url: textOf(docUrl).trim(), name: k.title };
      if (!doc.url) {
        const res = await createContractDoc(mode.invoke, { client: ctx.client, org: ctx.org, contract: k });
        if (!res.ok) return res;
        doc = res;
      }
      const id = admin((d) => {
        const c = findClient(d, clientId);
        if (!c) return false;
        const row = {
          id: uid(), status: 'Draft', ...k, title: k.title || doc.name || 'Software Subscription Agreement', docId: doc.id || '',
          docUrl: doc.url, createdBy: d.me, sentBy: '', sentAt: '', signedAt: '',
        };
        c.contracts.unshift(row);
        d.todos.forEach((t) => {
          if (t.source === 'automation' && t.ref === `contract:${clientId}` && !t.done) Object.assign(t, { done: true, doneAt: nowIso() });
        });
        return row.id;
      });
      return id ? { ok: true, id, url: doc.url } : { ok: false, error: 'The client is gone.' };
    },
    // Admins. Key Details while it's a Draft; status moves Draft → Sent for signature → Signed (or Cancelled).
    // `plan` (Signed only): also set up billing from it ({ amount, frequency, nextDate, description }). → true | false
    updateContract: (clientId, contractId, patch = {}, { plan = null } = {}) => admin((d) => {
      const c = findClient(d, clientId);
      const k = c?.contracts.find((x) => x.id === contractId);
      if (!k) return false;
      const status = patch.status ?? k.status;
      if (!CONTRACT_STATUSES.includes(status)) return false;
      if (k.status === 'Draft') Object.assign(k, cleanContract({ ...k, ...patch }));
      if ('docUrl' in patch) k.docUrl = textOf(patch.docUrl).trim();
      if (status !== k.status) {
        if (status === 'Sent for signature') Object.assign(k, { sentBy: d.me, sentAt: nowIso() });
        if (status === 'Signed') k.signedAt = ymdOr(patch.signedAt, teamToday());
        k.status = status;
      }
      if (plan && status === 'Signed') {
        c.plans.push(cleanPlan({
          description: plan.description || `${k.platform || 'AssetStack'} subscription`, amount: plan.amount ?? k.annualFee,
          frequency: plan.frequency || 'annually', nextDate: ymdOr(plan.nextDate, k.startDate || teamToday()), active: true,
        }, uid()));
      }
      return true;
    }),
    removeContract: (clientId, contractId) => admin((d) => {
      const c = findClient(d, clientId);
      if (!c?.contracts.some((x) => x.id === contractId)) return false;
      c.contracts = c.contracts.filter((x) => x.id !== contractId);
      return true;
    }),

    // ── Your Google account (admins): Gmail for invoices, Drive and Docs for contracts ──

    // → Promise<{ ok: true, url } | { ok: false, error }>: the browser goes to `url` (Google) and comes back to Settings.
    connectGoogle: () => googleConnectUrl(mode.invoke, window.location.origin),
    disconnectGoogle: async () => {
      const ok = await mode.googleDisconnect();
      await mode.refreshGoogle();
      return ok;
    },
    refreshGoogle: () => mode.refreshGoogle(),
    // A short email to yourself, from yourself. → Promise<{ ok } | { ok: false, error }>
    sendTestEmail: async () => {
      const me = mode.read((s) => s.users.find((u) => u.id === s.me));
      if (!me?.email) return { ok: false, error: 'Your profile has no email.' };
      return sendGoogleEmail(mode.invoke, {
        to: [me.email], subject: 'Cortex test email', text: 'This is a test from Cortex. Invoice emails will come from this address.',
      });
    },

    // ── Money in, expenses, software costs: admins only ──

    // A payment against an invoice (or just a client). When an invoice's payments reach its total inc GST it is Paid,
    // on the day the last one arrived. → id
    recordPayment: (payment = {}) => admin((d) => {
      const client = payment.invoiceId
        ? d.clients.find((c) => c.invoices.some((i) => i.id === payment.invoiceId))
        : findClient(d, payment.clientId);
      const amount = toNum(payment.amount);
      if (!client || !amount) return false;
      const p = {
        id: uid(), invoiceId: payment.invoiceId || '', clientId: client.id, amount, receivedOn: ymdOr(payment.receivedOn, localYmd()),
        reference: textOf(payment.reference), statementId: payment.statementId || '',
      };
      d.payments.unshift(p);
      const inv = client.invoices.find((i) => i.id === p.invoiceId);
      if (inv && inv.status !== 'Paid' && inv.status !== 'Void') {
        const paid = d.payments.filter((x) => x.invoiceId === inv.id).reduce((t, x) => t + Math.round(toNum(x.amount) * 100), 0);
        if (paid >= Math.round(invoiceTotals(inv).total * 100)) Object.assign(inv, { status: 'Paid', paidOn: p.receivedOn });
      }
      return p.id;
    }),
    // The week's bank screenshot (image or PDF; optional). Also ticks off that week's upload reminders.
    // → Promise<id | false>
    addBankStatement: async ({ weekStart, file, note = '' } = {}) => {
      if (!mode.read(isAdmin)) return false;
      const filePath = file ? await mode.upload('statements', file) : '';
      if (file && !filePath) return false;
      const week = isYmd(weekStart) ? weekStart : mondayOf(localYmd());
      return admin((d) => {
        const b = { id: uid(), weekStart: week, filePath, note: textOf(note), uploadedBy: d.me, createdAt: nowIso() };
        d.bankStatements.unshift(b);
        d.todos.forEach((t) => {
          if (t.source === 'automation' && t.ref === `bank:${week}` && !t.done) Object.assign(t, { done: true, doneAt: nowIso() });
        });
        return b.id;
      });
    },
    // { date, vendor, category, amount (inc GST), gst, clientId, notes } plus an optional receipt file.
    // → Promise<id | false>
    addExpense: async (expense = {}, file) => {
      if (!mode.read(isAdmin)) return false;
      const receiptPath = file ? await mode.upload('receipts', file) : '';
      if (file && !receiptPath) return false;
      return admin((d) => {
        const x = cleanExpense({ ...expense, receiptPath: receiptPath || expense.receiptPath, createdBy: d.me }, uid());
        d.expenses.unshift(x);
        return x.id;
      });
    },
    updateExpense: (id, patch = {}) => admin((d) => {
      const x = d.expenses.find((e) => e.id === id);
      if (!x) return false;
      Object.assign(x, cleanExpense({ ...x, ...patch, createdBy: x.createdBy }, x.id));
      return true;
    }),
    deleteExpense: (id) => admin((d) => {
      const x = d.expenses.find((e) => e.id === id);
      if (!x) return false;
      d.expenses = d.expenses.filter((e) => e.id !== id);
      if (x.receiptPath) mode.removeFile(x.receiptPath);
      return true;
    }),
    addSubscription: (sub = {}) => admin((d) => {
      const x = cleanSubscription(sub, uid());
      d.subscriptions.push(x);
      return x.id;
    }),
    updateSubscription: (id, patch = {}) => admin((d) => {
      const x = d.subscriptions.find((s) => s.id === id);
      if (!x) return false;
      Object.assign(x, cleanSubscription({ ...x, ...patch }, x.id));
      return true;
    }),
    deleteSubscription: (id) => admin((d) => {
      if (!d.subscriptions.some((s) => s.id === id)) return false;
      d.subscriptions = d.subscriptions.filter((s) => s.id !== id);
      return true;
    }),
    // A short-lived link to a bank screenshot or receipt ('' when there is none). → Promise<string | false>
    fileUrl: async (path) => {
      if (!mode.read(isAdmin)) return false;
      return path ? mode.fileUrl(path) : '';
    },

    // ── Outreach: edit access to outreach ──

    logEmail: (entry) => editing('outreach', (d) => {
      d.emails.unshift({ id: uid(), ts: nowIso(), ...entry });
      if (entry.kind === 'sent') markContactSent(d, entry);
      return true;
    }),
    queueApproval: (entry) => editing('outreach', (d) => {
      d.approvals.unshift({ id: uid(), ts: nowIso(), by: d.me, ...entry });
      return true;
    }),
    approveApproval: (apId) => editing('outreach', (d) => {
      const a = d.approvals.find((x) => x.id === apId);
      if (!a) return false; // already handled
      d.approvals = d.approvals.filter((x) => x.id !== apId);
      const entry = { kind: 'sent', contactId: a.contactId, contact: a.contact, subject: a.subject, snippet: emailSnippet(a.body) };
      d.emails.unshift({ id: uid(), ts: nowIso(), ...entry });
      markContactSent(d, entry);
      return true;
    }),
    discardApproval: (apId) => editing('outreach', (d) => {
      d.approvals = d.approvals.filter((x) => x.id !== apId);
      return true;
    }),
    // A contact that is (or becomes) Replied or Meeting booked gets a deal and its owner a follow-up to-do: the
    // contact_pipeline trigger in live mode (never client-side there), the same rules here in demo mode.
    addContact: (contact = {}) => editing('outreach', (d) => {
      const c = newContact(d, contact);
      d.contacts.unshift(c);
      if (!mode.live) contactPipelineLocal(d, c.id, '');
      return c.id;
    }),
    updateContact: (id, patch = {}) => editing('outreach', (d) => {
      const c = d.contacts.find((x) => x.id === id);
      if (!c) return false;
      const was = c.status;
      Object.assign(c, patch, { id: c.id });
      if (!mode.live) contactPipelineLocal(d, c.id, was);
      return true;
    }),

    // ── Team chat (everyone) ──

    createChannel: (name, members) => mutate((d) => {
      const base = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'group';
      // Keep names distinguishable: a taken name gets -2, -3 …
      const taken = new Set(d.channels.map((c) => c.name));
      let clean = base;
      for (let i = 2; taken.has(clean); i++) clean = `${base}-${i}`;
      const chId = uid();
      d.channels.push({ id: chId, name: clean, members: Array.from(new Set([d.me, ...members])) });
      markSeen(d, chId, nowIso());
      return chId;
    }),
    addChannelMembers: (chId, members) => mutate((d) => {
      const ch = d.channels.find((c) => c.id === chId);
      if (!ch) return false;
      ch.members = Array.from(new Set([...ch.members, ...members]));
      return true;
    }),
    sendMessage: (chId, text) => mutate((d) => {
      const ts = nowIso();
      d.messages.push({ id: uid(), channel: chId, user: d.me, text, ts });
      markSeen(d, chId, ts);
      return true;
    }),
    // Read up to the newest message even if its timestamp is ahead of this clock, so unread reaches 0.
    markRead: (chId) => mutate((d) => {
      const now = nowIso();
      const newest = d.messages.reduce((t, m) => (m.channel === chId && m.ts > t ? m.ts : t), '');
      markSeen(d, chId, newest > now ? newest : now);
      return true;
    }),
  };
  return actions;
}

// ── Demo mode: localStorage, shared between tabs ───────────────────────────────

function DemoProvider({ children }) {
  const [state, setState] = useState(load);
  const stateRef = useRef(state);
  const lastRaw = useRef(null); // last JSON written here or adopted from another tab
  const files = useRef(new Map()); // uploads: storage path → data URL, in memory only (never saved)
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
        ensuredTodos.clear();
        commit({ ...migrate(data), mode: 'demo' });
      } catch { /* ignore malformed payload */ }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [commit]);

  // Runs synchronously against the latest state, so each action's logic runs exactly once. A refused action
  // (false) changes nothing.
  const mutate = useCallback((fn) => {
    const d = structuredClone(stateRef.current);
    const out = fn(d);
    if (out !== false) commit(d);
    return out;
  }, [commit]);

  const actions = useMemo(() => createActions(mutate, {
    live: false,
    read: (fn) => fn(stateRef.current),
    // My Work made today's routine to-dos for the signed-in person once this page load; the fresh seed has none.
    reset: () => {
      files.current.clear();
      ensuredTodos.clear();
      const next = { ...createSeed(), mode: 'demo' };
      ensureTodosLocal(next, localYmd());
      commit(next);
    },
    setMe: (userId) => mutate((d) => { d.me = userId; }),
    signOut: async () => {},
    // Files stay in this tab's memory: the path is saved, the file is gone after a reload.
    upload: async (folder, file) => {
      if (file.size > DEMO_FILE_WARN) console.warn(`Demo mode keeps ${file.name} in memory only, and it is over 2 MB.`);
      const path = storagePath(folder, file);
      try {
        files.current.set(path, await readDataUrl(file));
        return path;
      } catch {
        return '';
      }
    },
    fileUrl: async (path) => files.current.get(path) || '',
    removeFile: (path) => { files.current.delete(path); },
    // Google (Gmail, Drive, Docs) needs the server function: live mode only.
    invoke: async () => ({ ok: false, error: 'Google works in live mode only.' }),
    googleDisconnect: async () => false,
    refreshGoogle: async () => {},
  }), [mutate, commit]);

  const value = useMemo(() => ({ state, actions, sync: SAVED, google: DEMO_GOOGLE }), [state, actions]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

// The signed-in admin's own Google account (Settings → Business): not synced state, read from google_me().
const DEMO_GOOGLE = { ready: true, demo: true, connected: false, email: '' };
const googleFrom = (me) => ({
  ready: true, demo: false, connected: Boolean(me?.google_email), email: me?.google_email || '', connectedAt: me?.connected_at || '',
});

// ── Live mode: Supabase rows ⇄ state ───────────────────────────────────────────

// Rows state can't show yet (a child whose parent hasn't arrived) aren't in flatten(next); keep them until it does.
function keepOrphans(prev, next, ops) {
  const deleted = new Set(ops.filter((o) => o.op === 'delete').map((o) => `${o.table}|${o.key}`));
  Object.entries(prev).forEach(([table, rows]) => rows.forEach((row, key) => {
    if (next[table] && !next[table].has(key) && !deleted.has(`${table}|${key}`)) next[table].set(key, row);
  }));
}

// The module whose edit access a row's write needs (the RLS rules in 0002); '' for tables outside the modules.
const MODULE_OF = {
  deals: 'pipeline', contacts: 'outreach', emails: 'outreach', sequences: 'outreach', approvals: 'outreach',
  clients: 'clients', client_notes: 'clients', client_tasks: 'clients', invoices: 'clients', invoice_lines: 'clients',
  client_access: 'clients', billing_plans: 'clients', client_usage: 'clients', client_contacts: 'clients', client_contracts: 'clients',
};
// Whether the signed-in user may write a row (the RLS rules in 0002, 0004 and 0006); null for tables outside the
// modules and boards. Boards' groups, tasks, subtasks and updates follow their board (0006).
function mayWrite(d, table, row, rows) {
  if (table === 'boards') return isAdmin(d);
  if (table === 'board_groups' || table === 'items') return canEditBoard(d, findBoard(d, String(row.board_id)));
  if (table === 'item_updates' || table === 'subtasks') {
    const it = rows.items?.get(String(row.item_id));
    return it ? canEditBoard(d, findBoard(d, String(it.board_id))) : null;
  }
  if (table === 'client_contracts') return isAdmin(d);
  return MODULE_OF[table] ? canEdit(d, MODULE_OF[table]) : null;
}
// Only `position` differs: flatten() renumbering an order the database holds with a gap or two rows on one position.
const onlyPosition = (before, after) => Boolean(before) && 'position' in after
  && stable({ ...before, position: 0 }) === stable({ ...after, position: 0 });

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
  const loads = new Set(); // per resync or pull in flight: the `${table}|${key}` changed here or over realtime meanwhile

  const build = () => ({ ...assemble(rows, { me }), version: 1, mode: 'live', me });
  const publish = (next) => { state = next; if (!closed) onState(next); };
  // Realtime changes go into rows at once and into state once per burst.
  const refresh = () => {
    clearTimeout(timer);
    timer = null;
    if (dirty && rows) { dirty = false; publish(build()); }
  };
  const later = () => { dirty = true; timer ||= setTimeout(refresh, 50); };
  const touch = (table, key) => { loads.forEach((seen) => seen.add(`${table}|${key}`)); };
  const put = (table, raw) => {
    const row = normalizeRow(table, raw);
    const key = ROW_KEY[table](row);
    touch(table, key);
    if (!sync.isPending(table, key)) rows[table].set(key, row); // a local edit still on its way wins
    return row;
  };

  // An echo of an older write of ours, arriving after a newer one went through, is dropped: applying it would
  // undo the newer edit.
  // The SuperAdmin changed this user's role, active flag or module access: RLS now lets them read different rows,
  // and realtime only streams changes, so they reload everything (once nothing of theirs is still saving).
  function apply({ table, eventType, row }) {
    if (!rows?.[table] || !row) return;
    let access = false;
    if (eventType === 'DELETE') {
      const key = ROW_KEY[table](row); // deletes carry only the primary key
      touch(table, key);
      if (sync.staleEcho(table, key, null) || sync.isPending(table, key) || !rows[table].delete(key)) return;
      access = table === 'module_access' && String(row.user_id) === me;
    } else {
      if (sync.staleEcho(table, ROW_KEY[table](row), row)) return;
      const before = rows[table].get(ROW_KEY[table](normalizeRow(table, row)));
      const r = put(table, row);
      // Added to a channel someone else made: its row wasn't visible to us until now, so fetch it.
      if (table === 'channel_members' && r.user_id === me && !rows.channels.has(r.channel_id)) fetchChannel(r.channel_id);
      access = (table === 'module_access' && r.user_id === me && before?.level !== r.level)
        || (table === 'profiles' && r.id === me && (before?.role !== r.role || before?.active !== r.active))
        // An admin sees staff members' Projects pages (sees_person): someone else becoming or stopping being staff
        // changes which pages they may read.
        || (table === 'profiles' && r.id !== me && before && before.role !== r.role && isAdmin(state) && !isSuperadmin(state));
    }
    later();
    if (access) { missed = true; maybeResync(); }
  }

  // Rows an RPC or trigger just wrote (filtered by column = value), without waiting for their realtime echo. Every
  // page is in before any is applied, in one go, so a change never diffs against half a table; a row that changed
  // here or over realtime since the pull began is newer than its snapshot and stays.
  async function pull(table, match = {}) {
    if (!rows?.[table]) return;
    const seen = new Set();
    const got = [];
    loads.add(seen);
    try {
      for (let from = 0; ; from += PAGE) {
        let q = supabase.from(table).select('*');
        Object.entries(match).forEach(([col, v]) => { q = q.eq(col, v); });
        const { data, error } = await q.order('id').range(from, from + PAGE - 1);
        if (closed || error || !data) break;
        got.push(...data);
        if (data.length < PAGE) break;
      }
    } catch { /* realtime or the next load brings them */ }
    loads.delete(seen);
    if (closed) return;
    got.forEach((raw) => {
      if (!seen.has(`${table}|${ROW_KEY[table](normalizeRow(table, raw))}`)) put(table, raw);
    });
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
    const touched = new Set();
    loads.add(touched);
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
      loads.delete(touched);
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
    if (out === false) return false; // refused: nothing changes
    const next = flatten(d);
    // Renumbering rows this user can't write (a module or board they only view, team boards for staff) would be
    // refused and retried forever: keep the database's positions instead (the order on screen is the same).
    const ops = diff(rows, next).filter((o) => {
      const before = o.op === 'upsert' && rows[o.table].get(o.key);
      if (!before || !onlyPosition(before, o.row) || mayWrite(d, o.table, o.row, next) !== false) return true;
      next[o.table].set(o.key, before);
      return false;
    });
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
  const read = (fn) => (state ? fn(state) : undefined);
  return { start, stop, mutate, read, pull, flush, pending };
}

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });

function LiveProvider({ userId, children }) {
  const [state, setState] = useState(null);
  const [phase, setPhase] = useState({ status: 'loading' });
  const [sync, setSync] = useState(SAVED);
  const [attempt, setAttempt] = useState(0);
  const [google, setGoogle] = useState({ ready: false, demo: false, connected: false, email: '' });
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

  // Keep my profile's time zone in step with this browser, so my follow-up to-dos land on my own "today"
  // (the database dates them with profiles.timezone) and teammates see my local time. Once per sign-in, so two
  // open devices set to different zones don't keep overwriting each other.
  const myZone = state?.users?.find((u) => u.id === userId)?.timezone;
  const zoneChecked = useRef(false);
  useEffect(() => {
    if (phase.status !== 'ready' || !myZone || zoneChecked.current) return;
    zoneChecked.current = true;
    const zone = browserTimezone();
    if (!zone || myZone === zone) return;
    engine.current?.mutate((d) => {
      const u = d.users.find((x) => x.id === userId);
      if (!u) return false;
      u.timezone = zone;
      return true;
    });
  }, [phase.status, myZone, userId]);

  // Your Google connection (admins only: google_me() works for staff too, but only admins use it).
  const refreshGoogle = useCallback(async () => {
    try {
      const { data, error } = await supabase.rpc('google_me');
      setGoogle(error ? { ready: true, demo: false, connected: false, email: '', error: error.message } : googleFrom(data));
    } catch (e) {
      setGoogle({ ready: true, demo: false, connected: false, email: '', error: e?.message || 'Unavailable' });
    }
  }, []);
  const ready = phase.status === 'ready';
  useEffect(() => { if (ready) refreshGoogle(); }, [ready, refreshGoogle]);

  const actions = useMemo(() => {
    const fail = (message) => { setSync({ state: 'error', message }); };
    return createActions(mutate, {
      live: true,
      read: (fn) => engine.current?.read(fn),
      reset: () => {}, // demo only
      setMe: () => {}, // demo only: live `me` is the signed-in user
      // → { unsaved: true } without signing out while edits still haven't saved, unless `force`.
      signOut: async ({ force = false } = {}) => {
        await Promise.race([engine.current?.flush(), wait(3000)]).catch(() => {});
        if (!force && engine.current?.pending()) return { unsaved: true };
        await supabase.auth.signOut({ scope: 'local' }); // this browser only; AuthGate then shows sign-in
        return { unsaved: false };
      },
      // Database functions (ensure_todos, generate_due_invoices) → the number they return, or false on error.
      rpc: async (name, args) => {
        try {
          const { data, error } = await supabase.rpc(name, args);
          if (error) throw error;
          return Number(data) || 0;
        } catch (e) {
          fail(e?.message || 'Something went wrong');
          return false;
        }
      },
      pull: (table, match) => engine.current?.pull(table, match),
      // Bank screenshots and receipts: the private finance bucket (admins only), short-lived signed links.
      upload: async (folder, file) => {
        const path = storagePath(folder, file);
        try {
          const { error } = await supabase.storage.from(BUCKET).upload(path, file);
          if (error) throw error;
          return path;
        } catch (e) {
          fail(e?.message || 'Upload failed');
          return '';
        }
      },
      fileUrl: async (path) => {
        try {
          const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 300);
          return error ? '' : data?.signedUrl || '';
        } catch {
          return '';
        }
      },
      removeFile: (path) => { supabase.storage.from(BUCKET).remove([path]).catch(() => {}); },
      // The google Edge Function (supabase/functions/google). → { ok: true, ...data } | { ok: false, error }
      invoke: async (name, body) => {
        try {
          const { data, error } = await supabase.functions.invoke(name, { body });
          if (!error) return { ok: true, ...(data || {}) };
          const detail = await error.context?.json?.().catch(() => null);
          return { ok: false, error: detail?.error || error.message || 'Google request failed' };
        } catch (e) {
          return { ok: false, error: e?.message || 'Google request failed' };
        }
      },
      googleDisconnect: async () => {
        try {
          const { data, error } = await supabase.rpc('google_disconnect');
          return !error && Boolean(data);
        } catch {
          return false;
        }
      },
      refreshGoogle,
    });
  }, [mutate, refreshGoogle]);

  const value = useMemo(() => ({ state, actions, sync, google }), [state, actions, sync, google]);

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

// Admin or SuperAdmin. For module access use useAccess() from src/lib/access.js.
export function useIsAdmin() {
  const { state } = useStore();
  return isAdmin(state);
}
