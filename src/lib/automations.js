// Demo-mode copies of the database automations in supabase/migrations/0002_team_workflow.sql (and 0003): ensure_todos,
// generate_due_invoices and the contact_pipeline trigger, applied to a state draft with the same rules. Live mode
// never runs these (the database does). Also the invoice numbering and date helpers both modes share.
// Pure: no React and no store, so scripts/test-sync.mjs runs this file in Node.
import { TEAM_TIMEZONE, localYmd, ymdIn } from './format.js';
import { lifecycleAfter } from './accounts.js';

// Runtime ids are uuids in both modes (live rows use them as primary keys). randomUUID needs a secure
// context, so a plain-http preview (a phone on the LAN) falls back to getRandomValues.
export const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

// ── Dates as 'YYYY-MM-DD' strings, computed in UTC so daylight saving can't shift them ──────────────────────

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));
const parts = (day) => String(day).slice(0, 10).split('-').map(Number);
const fmt = (t) => new Date(t).toISOString().slice(0, 10);

export const addDays = (day, n) => { const [y, m, d] = parts(day); return fmt(Date.UTC(y, m - 1, d + n)); };
// 1 = Monday … 7 = Sunday (Postgres isodow).
export const isoDow = (day) => { const [y, m, d] = parts(day); return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7; };
export const mondayOf = (day) => addDays(day, 1 - isoDow(day));
// Postgres `date + interval 'n months'`: the same day of the month, or the month's last day when it has fewer.
export const addMonths = (day, n) => addMonthsOnDay(day, n, parts(day)[2]);
// Day `anchor` of the month n months after `day`'s, or that month's last day when it is shorter.
export function addMonthsOnDay(day, n, anchor) {
  const [y, m] = parts(day);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return fmt(Date.UTC(y, m - 1 + n, Math.min(anchor, last)));
}
// 'HH:MM' from '9:05', '09:05:00' …; '' when it isn't a time.
export function toHhmm(v) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? ''));
  return m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

// ── Invoices ───────────────────────────────────────────────────────────────────────────────────────────────

// Payment terms from the business details, in days (30 when unset).
export const termsOf = (state) => { const n = parseInt(state.org?.paymentTermsDays, 10); return n >= 0 ? n : 30; };

// The next invoice number under the current prefix: one past the highest number made with it, from 1001. Only the
// digits after the prefix count, so a prefix ending in digits (a year) never merges into the counter, and a new
// prefix (next year's) starts again at 1001.
export function nextInvoiceNumber(state) {
  const prefix = state.org?.invoicePrefix ?? 'INV-';
  const counter = (number) => {
    const rest = String(number ?? '');
    const n = rest.startsWith(prefix) && /^\d+$/.test(rest.slice(prefix.length)) ? Number(rest.slice(prefix.length)) : 0;
    return Number.isSafeInteger(n) ? n : 0;
  };
  const next = Math.max(1000, ...(state.clients || []).flatMap((c) => (c.invoices || []).map((i) => counter(i.number)))) + 1;
  return `${prefix}${next}`;
}

export const PLAN_MONTHS = { monthly: 1, quarterly: 3, annually: 12 };
// A billing plan's date is a day this century; anything else (a year typed digit by digit passes through 0002) is
// never saved.
export const isPlanDate = (v) => isYmd(v) && v >= '2000-01-01' && v <= '2099-12-31';
// The day of the month a plan bills on: its anchor day, else its next date's day.
export const billingDay = (plan) => (plan.anchorDay >= 1 && plan.anchorDay <= 31 ? plan.anchorDay : parts(plan.nextDate)[2]);
// How far behind a plan may be and still catch up: further back is a mistyped date, left as it is.
export const PLAN_CATCH_UP_MONTHS = 24;

// generate_due_invoices: every active plan that is due (and no more than two years behind) gets an invoice per
// missed period (Awaiting approval, issued on the period date, due after the payment terms, one line for the plan),
// oldest plan date first. Periods fall on the plan's billing day, or the month's last day when it is shorter, so a
// plan on the 31st is back on the 31st after a short month; its next date moves on until it is in the future.
// "Today" is Sydney's, as team_today(). → invoices created.
export function generateDueInvoicesLocal(state, today = ymdIn(TEAM_TIMEZONE), { uid: newId = uid } = {}) {
  const due = [];
  const oldest = addMonths(today, -PLAN_CATCH_UP_MONTHS);
  (state.clients || []).forEach((client) => (client.plans || []).forEach((plan, position) => {
    if (plan.active && isYmd(plan.nextDate) && plan.nextDate <= today && plan.nextDate >= oldest) due.push({ client, plan, position });
  }));
  due.sort((a, b) => cmp(a.plan.nextDate, b.plan.nextDate) || a.position - b.position || cmp(a.plan.id, b.plan.id));

  const terms = termsOf(state);
  let made = 0;
  due.forEach(({ client, plan }) => {
    const months = PLAN_MONTHS[plan.frequency] || 1;
    const start = plan.nextDate;
    const anchor = billingDay(plan);
    let date = start;
    for (let k = 1; date <= today; k++) {
      client.invoices.unshift({
        id: newId(), number: nextInvoiceNumber(state), issued: date, due: addDays(date, terms), status: 'Awaiting approval',
        planId: plan.id, sentAt: '', paidOn: '', sentTo: '',
        lines: [{ id: newId(), desc: plan.description, qty: '1', rate: String(Number(plan.amount) || 0) }],
      });
      made++;
      date = addMonthsOnDay(start, k * months, anchor);
    }
    plan.nextDate = date;
    plan.anchorDay = anchor;
  });
  return made;
}

// ── My Work ────────────────────────────────────────────────────────────────────────────────────────────────

export const BANK_TODO_TITLE = "Upload this week's bank screenshot";
export const APPROVE_TODO_TITLE = 'Approve invoices';

// A to-do with every field set (state never holds null or missing fields).
export function makeTodo(fields = {}, newId = uid) {
  return {
    assignee: '', createdBy: '', title: '', notes: '', day: localYmd(), start: '', minutes: 30, category: 'Other',
    source: 'manual', routineId: '', ref: '', done: false, doneAt: '', ...fields, id: fields.id || newId(),
  };
}

const adminRole = (state, userId) => {
  const u = (state.users || []).find((x) => x.id === userId);
  return Boolean(u) && u.active !== false && ['superadmin', 'admin'].includes(u.role); // isAdmin() in access.js
};
const hasAutomation = (state, assignee, ref, day) => state.todos
  .some((t) => t.source === 'automation' && t.assignee === assignee && t.ref === ref && t.day === day);

// Days of demo routine runs kept (state.routineRuns): My Work only ever asks about today.
const RUNS_KEPT_DAYS = 14;

// ensure_todos(day) for `me`: a to-do for each of their active routines that runs on that weekday, and for admins on
// a Monday the bank screenshot reminder until that week's statement is in, and "Approve invoices" while any invoice
// awaits approval (0004). A routine runs once per person and day
// (state.routineRuns, '<day>|<routine id>|<user id>', as the routine_runs table does in the database), so a to-do
// deleted or moved to another day doesn't come back. → to-dos added.
export function ensureTodosLocal(state, day = localYmd(), { me = state.me, uid: newId = uid } = {}) {
  const user = (state.users || []).find((u) => u.id === me);
  if (!isYmd(day) || !user || user.active === false) return 0;
  state.todos ||= [];
  const kept = addDays(day, -RUNS_KEPT_DAYS);
  state.routineRuns = (state.routineRuns || []).filter((run) => run.slice(0, 10) >= kept);
  const runs = new Set(state.routineRuns);
  const dow = isoDow(day);
  let added = 0;

  (state.routines || [])
    .map((r, position) => ({ r, position }))
    .filter(({ r }) => r.assignee === me && r.active && (r.weekdays || []).includes(dow))
    .sort((a, b) => (!a.r.start) - (!b.r.start) || cmp(a.r.start, b.r.start) || a.position - b.position || cmp(a.r.id, b.r.id))
    .forEach(({ r }) => {
      const run = `${day}|${r.id}|${me}`;
      if (runs.has(run)) return;
      runs.add(run);
      state.routineRuns.push(run);
      if (state.todos.some((t) => t.routineId === r.id && t.assignee === me && t.day === day)) return;
      state.todos.push(makeTodo({
        assignee: me, createdBy: me, title: r.title, day, start: r.start, minutes: r.minutes, category: r.category,
        source: 'routine', routineId: r.id,
      }, newId));
      added++;
    });

  const ref = `bank:${day}`;
  if (adminRole(state, me) && dow === 1 && !(state.bankStatements || []).some((b) => b.weekStart === day)
    && !hasAutomation(state, me, ref, day)) {
    state.todos.push(makeTodo({ assignee: me, createdBy: me, title: BANK_TODO_TITLE, day, category: 'Admin', source: 'automation', ref }, newId));
    added++;
  }

  // One undone reminder at a time: it carries over (My Work's carried-over list) instead of a new one each day.
  const approve = `approve:${day}`;
  if (adminRole(state, me) && (state.clients || []).some((c) => (c.invoices || []).some((i) => i.status === 'Awaiting approval'))
    && !hasAutomation(state, me, approve, day)
    && !state.todos.some((t) => t.source === 'automation' && t.assignee === me && t.ref.startsWith('approve:') && !t.done)) {
    state.todos.push(makeTodo({
      assignee: me, createdBy: me, title: APPROVE_TODO_TITLE, day, category: 'Clients', source: 'automation', ref: approve,
    }, newId));
    added++;
  }
  return added;
}

// The client_contract_todo trigger (0004): a new client in Onboarding gives its owner, if they're an admin, else `me`
// if they are, a "Prepare contract" to-do on their own today. Staff can't make contracts. → the to-do, or null.
export function clientCreatedLocal(state, clientId, { me = state.me, uid: newId = uid } = {}) {
  const c = (state.clients || []).find((x) => x.id === clientId);
  if (!c || c.status !== 'Onboarding') return null;
  const owner = [c.contact, me].find((id) => id && adminRole(state, id));
  if (!owner) return null;
  const tz = (state.users || []).find((u) => u.id === owner)?.timezone || TEAM_TIMEZONE;
  const day = ymdIn(tz);
  const ref = `contract:${c.id}`;
  state.todos ||= [];
  if (hasAutomation(state, owner, ref, day)) return null;
  const todo = makeTodo({
    assignee: owner, createdBy: me, title: `Prepare contract: ${String(c.name ?? '').trim() || 'new client'}`, day,
    category: 'Clients', source: 'automation', ref,
  }, newId);
  state.todos.push(todo);
  return todo;
}

// ── Outreach → Pipeline ────────────────────────────────────────────────────────────────────────────────────

export const PIPELINE_STATUSES = ['Replied', 'Meeting booked'];
// The stages a booking moves a deal on from (0014's contact_pipeline(); the last two are the names before 0014).
const EARLY_STAGES = ['Interested', 'Opportunities', 'Contacted'];
const norm = (s) => String(s ?? '').trim().toLowerCase();

/** A deal's fields from 0014 on, as a new deal starts (the database's defaults; reached its stage `at`). */
export const dealDefaults = (at = new Date().toISOString()) => ({
  accountId: '', contactIds: [], currency: 'AUD', closeOn: '', probability: null, waitingOn: '', lostReason: '', stageAt: at,
});
/** An account's fields as a new one starts (0014's defaults). */
export const accountDefaults = (at = new Date().toISOString()) => ({
  kind: 'prospect', lifecycle: 'new', lifecycleNote: '', revisitOn: '', sector: '', country: '', region: '', timezone: '', domain: '',
  website: '', size: '', guardrails: '', prepUrl: '', referredBy: '', owner: '', clientId: '', createdAt: at,
});
/** A contact's fields as a new one starts. */
export const personDefaults = (at = new Date().toISOString()) => ({
  name: '', title: '', email: '', phone: '', linkedin: '', timezone: '', role: '', status: 'active', owner: '', createdAt: at,
});

// The account named `name` (any case), else a new one with `fields`. → the account
function accountFor(state, name, fields, newId) {
  state.accounts ||= [];
  const found = state.accounts.find((a) => norm(a.name) === norm(name));
  if (found) return found;
  const a = { id: newId(), ...accountDefaults(), name: String(name).trim().slice(0, 200) || 'New account', ...fields };
  state.accounts.push(a);
  return a;
}
// The person at `account` with this email (else, without one, this name), else a new contact. → the contact, or null
// when there's neither a name nor an email.
function personFor(state, account, { name = '', email = '', owner = '' }, newId) {
  state.crmContacts ||= [];
  const n = String(name ?? '').trim();
  const e = norm(email);
  if (!n && !e) return null;
  const found = state.crmContacts.find((c) => c.accountId === account.id && (e ? norm(c.email) === e : norm(c.name) === norm(n)));
  if (found) return found;
  const c = { id: newId(), ...personDefaults(), accountId: account.id, name: n.slice(0, 200), email: e.slice(0, 254), owner };
  state.crmContacts.push(c);
  return c;
}

// The contact_pipeline trigger (0014), for a contact whose status was `prevStatus` ('' for a new contact). When it
// becomes Replied or Meeting booked: its organisation's account (found by name, or a new prospect; its lifecycle moves
// on as lifecycleAfter() says) and the person as its contact; a deal for it (named after the organisation, owned by the
// contact's owner or `me`, waiting on us, with the person on it), or its deal moves from Interested to Meeting booked on
// a booking (never back from later on); and the owner gets a follow-up to-do for `day`, by default the owner's own today
// (user_today()), once per contact and day. → { deal, todo } (todo null when it already existed), or null when nothing
// applies.
export function contactPipelineLocal(state, contactId, prevStatus = '', { day, me = state.me, uid: newId = uid } = {}) {
  const c = (state.contacts || []).find((x) => x.id === contactId);
  if (!c || !PIPELINE_STATUSES.includes(c.status) || c.status === prevStatus) return null;
  state.deals ||= [];
  state.todos ||= [];
  const booked = c.status === 'Meeting booked';
  const name = String(c.name ?? '').trim() || String(c.org ?? '').trim() || 'contact';
  const org = String(c.org ?? '').trim() || String(c.name ?? '').trim() || 'New account';
  const owner = c.owner || me;
  day ||= ymdIn((state.users || []).find((u) => u.id === owner)?.timezone || TEAM_TIMEZONE);

  const account = accountFor(state, org, { lifecycle: booked ? 'meeting' : 'engaged', owner }, newId);
  account.lifecycle = lifecycleAfter(account.lifecycle, booked ? 'booked' : 'replied');
  const person = personFor(state, account, { name: c.name, email: c.email, owner }, newId);

  let deal = state.deals.find((x) => x.contactId === c.id);
  if (!deal) {
    deal = {
      id: newId(), name: org.slice(0, 200), sector: '', value: 0, priority: 'P2',
      stage: booked ? 'Meeting booked' : 'Interested', contact: owner,
      next: booked ? `Prepare meeting with ${name}` : `Reply to ${name}`, contactId: c.id,
      ...dealDefaults(), accountId: account.id, contactIds: person ? [person.id] : [], waitingOn: 'us',
    };
    state.deals.push(deal);
    logStageLocal(state, deal, '', deal.stage, { by: me, uid: newId });
  } else if (booked && EARLY_STAGES.includes(deal.stage)) {
    logStageLocal(state, deal, deal.stage, 'Meeting booked', { by: me, uid: newId });
    deal.stage = 'Meeting booked';
    deal.stageAt = new Date().toISOString();
  }

  let todo = null;
  const ref = `contact:${c.id}`;
  if (owner && !hasAutomation(state, owner, ref, day)) {
    todo = makeTodo({
      assignee: owner, createdBy: me, title: booked ? `Prepare: meeting with ${name}` : `Follow up: ${name} replied`,
      day, category: 'Outreach', source: 'automation', ref,
    }, newId);
    state.todos.push(todo);
  }
  return { deal, todo };
}

// ── Deal stage history (0015) ───────────────────────────────────────────────────────────────────────────────────

/** Demo mode's log_deal_stage trigger: a row when a deal is added (from ''), moves stage, or is made a client (to 'Won').
 *  → the row, or null when nothing moved. */
export function logStageLocal(state, deal, from, to, { by = state.me || '', at = new Date().toISOString(), uid: newId = uid } = {}) {
  if (!deal || from === to) return null;
  const h = { id: newId(), dealId: deal.id, from: String(from ?? '').slice(0, 60), to: String(to ?? '').slice(0, 60), at, by };
  (state.dealHistory ||= []).push(h);
  return h;
}

/** 0015's one-off step: a starting row for each deal with none (its stage, or Won once made a client, when it reached it). */
export function historyBackfillLocal(state, { uid: newId = uid } = {}) {
  state.dealHistory ||= [];
  const has = new Set(state.dealHistory.map((h) => h.dealId));
  (state.deals || []).forEach((d) => {
    if (has.has(d.id)) return;
    state.dealHistory.push({ id: newId(), dealId: d.id, from: '', to: d.clientId ? 'Won' : String(d.stage || '').slice(0, 60), at: d.stageAt || new Date().toISOString(), by: '' });
  });
  return state;
}

const OLD_STAGES = { Opportunities: 'Interested', Contacted: 'Interested', 'First meetings': 'Meeting booked', Demos: 'Demo held', Won: 'Demo held' };

/** 0014's one-off steps for demo data saved before it: the old stages renamed (a Contacted deal waits on them), every
 *  client a customer account, every deal its account (its client's, else the one with its name, else a new one), and
 *  a deal from an outreach contact that person as its contact. Safe to run again (nothing is left to do). */
export function crmBackfillLocal(state, { uid: newId = uid } = {}) {
  state.accounts ||= [];
  state.crmContacts ||= [];
  (state.deals || []).forEach((d) => {
    Object.entries(dealDefaults(d.stageAt || new Date().toISOString())).forEach(([k, v]) => { if (d[k] === undefined) d[k] = v; });
    if (OLD_STAGES[d.stage]) {
      if (d.stage === 'Contacted' && !d.waitingOn) d.waitingOn = 'them';
      d.stage = OLD_STAGES[d.stage];
    }
  });
  (state.clients || []).forEach((cl) => {
    if (state.accounts.some((a) => a.clientId === cl.id)) return;
    state.accounts.push({
      id: newId(), ...accountDefaults(), name: String(cl.name || '').trim().slice(0, 200) || 'Client', kind: 'customer',
      lifecycle: 'customer', sector: String(cl.sector || '').slice(0, 100), owner: cl.contact || '', clientId: cl.id,
    });
  });
  (state.deals || []).forEach((d) => {
    if (d.accountId) return;
    const account = (d.clientId && state.accounts.find((a) => a.clientId === d.clientId))
      || accountFor(state, d.name, { lifecycle: 'opportunity', sector: String(d.sector || '').slice(0, 100), owner: d.contact || '' }, newId);
    d.accountId = account.id;
  });
  (state.deals || []).forEach((d) => {
    if (!d.accountId || (d.contactIds || []).length) return;
    const from = (state.contacts || []).find((c) => c.id === d.contactId);
    const account = state.accounts.find((a) => a.id === d.accountId);
    const person = from && account && personFor(state, account, { name: from.name, email: from.email, owner: from.owner || '' }, newId);
    if (person) d.contactIds = [person.id];
  });
  return state;
}
