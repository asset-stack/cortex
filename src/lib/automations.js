// Demo-mode copies of the database automations in supabase/migrations/0002_team_workflow.sql (and 0003): ensure_todos,
// generate_due_invoices and the contact_pipeline trigger, applied to a state draft with the same rules. Live mode
// never runs these (the database does). Also the invoice numbering and date helpers both modes share.
// Pure: no React and no store, so scripts/test-sync.mjs runs this file in Node.
import { TEAM_TIMEZONE, localYmd, ymdIn } from './format.js';

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

  const approve = `approve:${day}`;
  if (adminRole(state, me) && (state.clients || []).some((c) => (c.invoices || []).some((i) => i.status === 'Awaiting approval'))
    && !hasAutomation(state, me, approve, day)) {
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

// The contact_pipeline trigger, for a contact whose status was `prevStatus` ('' for a new contact). When it becomes
// Replied or Meeting booked: a deal for it (named after the organisation, owned by the contact's owner or `me`), or
// its deal moves from Opportunities to First meetings on a booking; and the owner gets a follow-up to-do for `day`,
// by default the owner's own today (user_today()), once per contact and day. → { deal, todo } (todo null when it
// already existed), or null when nothing applies.
export function contactPipelineLocal(state, contactId, prevStatus = '', { day, me = state.me, uid: newId = uid } = {}) {
  const c = (state.contacts || []).find((x) => x.id === contactId);
  if (!c || !PIPELINE_STATUSES.includes(c.status) || c.status === prevStatus) return null;
  state.deals ||= [];
  state.todos ||= [];
  const booked = c.status === 'Meeting booked';
  const name = String(c.name ?? '').trim() || String(c.org ?? '').trim() || 'contact';
  const owner = c.owner || me;
  day ||= ymdIn((state.users || []).find((u) => u.id === owner)?.timezone || TEAM_TIMEZONE);

  let deal = state.deals.find((x) => x.contactId === c.id);
  if (!deal) {
    deal = {
      id: newId(), name: String(c.org ?? '').trim() || c.name, sector: '', value: 0, priority: 'P2',
      stage: booked ? 'First meetings' : 'Opportunities', contact: owner,
      next: booked ? `Prepare meeting with ${name}` : `Reply to ${name}`, contactId: c.id,
    };
    state.deals.push(deal);
  } else if (booked && deal.stage === 'Opportunities') {
    deal.stage = 'First meetings';
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
