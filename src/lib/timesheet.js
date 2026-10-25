// Timesheets (docs/PHASE2.md §6): hourly blocks for a working day, suggested from what the person did that day,
// and the 16:30 prompt's snooze. Pure apart from the snooze helpers (the one localStorage use outside the store,
// per person and day), so scripts/test-sync.mjs can run suggestBlocks in Node.
import { localYmd } from './format.js';
import { CATEGORIES } from '../data/boards.js';

export const TIMESHEET_HOURS = { start: '09:00', end: '17:00' };
export const PROMPT_AT = '16:30'; // weekdays, in the person's own time zone
export const EMAIL_MINUTES = 10; // per email sent → Email marketing
export const ITEM_MINUTES = 30; // per board item worked on → its module's category (Projects, Marketing, …)
export const BOARD_CATEGORY = { projects: 'Projects', marketing: 'Marketing', outreach: 'Outreach', clients: 'Clients', pipeline: 'Clients' };

const pad = (n) => String(n).padStart(2, '0');
const toMin = (hhmm) => { const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? '')); return m ? +m[1] * 60 + +m[2] : NaN; };
const fromMin = (n) => `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
const listOf = (v) => (Array.isArray(v) ? v : []);
const countOf = (v) => (Array.isArray(v) ? v.length : Math.max(0, Math.floor(Number(v) || 0)));

// Local 'HH:MM' of an ISO timestamp; '' when it isn't one.
export function clockOf(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
}
// Local 'YYYY-MM-DD' of an ISO timestamp; '' when it isn't one.
export function dayOf(iso) {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? localYmd(d) : '';
}

// '45m', '1h', '1h 30m'.
export function formatMinutes(minutes) {
  const n = Math.max(0, Math.round(Number(minutes) || 0));
  if (n < 60) return `${n}m`;
  return n % 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : `${n / 60}h`;
}

// Start times of the whole hours from `start` to `end`: 09:00 … 16:00 for the default day.
export function hourSlots({ start, end } = TIMESHEET_HOURS) {
  let s = toMin(start), e = toMin(end);
  if (!(s >= 0 && e > s)) { s = toMin(TIMESHEET_HOURS.start); e = toMin(TIMESHEET_HOURS.end); }
  const out = [];
  for (let t = s; t + 60 <= e && t < 24 * 60; t += 60) out.push(fromMin(t));
  return out;
}

// n roughly equal runs of `labels`, in order; a block with no label of its own repeats the last one.
function spread(labels, n) {
  if (!labels.length) return Array(n).fill('');
  if (labels.length <= n) return Array.from({ length: n }, (_, i) => labels[Math.min(i, labels.length - 1)]);
  const out = [];
  let from = 0;
  for (let i = 0; i < n; i++) {
    const to = Math.round(((i + 1) * labels.length) / n);
    out.push(labels.slice(from, to).join(', '));
    from = to;
  }
  return out;
}

const EMAILS = '\u0000emails'; // stands in for the "N emails" note until the count is known

/**
 * A day's hourly blocks from what was done:
 * - `todosDone`: completed to-dos; each counts its `minutes` towards its `category` (at `at`, else its `start`, else
 *   when it was ticked off).
 * - `emailsSent`: emails sent (or a count); 10 minutes each towards Email marketing.
 * - `itemsTouched`: board items worked on ({ board, name, ts }, or a count of Projects items); 30 minutes each
 *   towards the board's module (Projects, Marketing, Outreach or Clients).
 * - `messagesSent`: team chat messages (or a count); no minutes of their own, noted on the first spare hour.
 * The minutes per category are scaled to whole hours by largest remainder (to the nearest hour of activity, at least
 * one when there was any, at most the day), categories in order of their first activity, and the hours left are
 * Other. → [{ start, minutes: 60, category, note, source: 'suggested' }]
 */
export function suggestBlocks({ todosDone, emailsSent, itemsTouched, messagesSent } = {}, hours = TIMESHEET_HOURS) {
  const slots = hourSlots(hours);
  const events = [];
  const push = (category, minutes, at, label) => {
    const m = Number(minutes) || 0;
    if (m > 0) events.push({ category: Object.prototype.hasOwnProperty.call(CATEGORIES, category) ? category : 'Other', minutes: m, at: at || '', label: label || '' });
  };

  listOf(todosDone).forEach((t) => push(t?.category, t?.minutes, t?.at || t?.start || clockOf(t?.doneAt), String(t?.title ?? '').trim()));
  if (Array.isArray(emailsSent)) emailsSent.forEach((e) => push('Email marketing', EMAIL_MINUTES, e?.at || clockOf(e?.ts), EMAILS));
  else for (let i = countOf(emailsSent); i > 0; i--) push('Email marketing', EMAIL_MINUTES, '', EMAILS);
  if (Array.isArray(itemsTouched)) {
    itemsTouched.forEach((x) => push(BOARD_CATEGORY[x?.board] || 'Projects', ITEM_MINUTES, x?.at || clockOf(x?.ts), String(x?.name ?? '').trim()));
  } else for (let i = countOf(itemsTouched); i > 0; i--) push('Projects', ITEM_MINUTES, '', '');
  const emails = countOf(emailsSent);
  const messages = countOf(messagesSent);

  // Earliest first; activity without a time goes last. Array sort is stable, so ties keep their input order.
  events.sort((a, b) => (!a.at) - (!b.at) || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const cats = new Map();
  events.forEach((ev) => {
    const c = cats.get(ev.category) || { category: ev.category, minutes: 0, labels: [], index: cats.size };
    c.minutes += ev.minutes;
    if (ev.label && !c.labels.includes(ev.label)) c.labels.push(ev.label);
    cats.set(ev.category, c);
  });
  const list = [...cats.values()];

  // Largest remainder: whole hours first, then the hours left to the biggest remainders (earlier activity on a tie).
  const total = list.reduce((t, c) => t + c.minutes, 0);
  const target = total > 0 ? Math.min(slots.length, Math.max(1, Math.round(total / 60))) : 0;
  list.forEach((c) => {
    const quota = (c.minutes * target) / total;
    c.hours = Math.floor(quota);
    c.rest = quota - c.hours;
  });
  let left = target - list.reduce((t, c) => t + c.hours, 0);
  [...list].sort((a, b) => b.rest - a.rest || a.index - b.index).forEach((c) => { if (left > 0) { c.hours++; left--; } });

  const emailNote = `${emails} email${emails === 1 ? '' : 's'}`;
  const blocks = [];
  list.filter((c) => c.hours > 0).forEach((c) => {
    spread(c.labels.map((l) => (l === EMAILS ? emailNote : l)), c.hours).forEach((note) => {
      blocks.push({ category: c.category, note });
    });
  });
  const spare = blocks.length;
  while (blocks.length < slots.length) blocks.push({ category: 'Other', note: blocks.length === spare && messages > 0 ? 'Team chat' : '' });
  return blocks.slice(0, slots.length).map((b, i) => ({ start: slots[i], minutes: 60, category: b.category, note: b.note, source: 'suggested' }));
}

// What `userId` did on `day` (local days), from the state: to-dos ticked off that day, emails sent to contacts
// they own, board items they posted an update on (any module), and chat messages they sent.
export function dayActivity(state, userId, day) {
  const on = (iso) => dayOf(iso) === day;
  const todosDone = (state?.todos || [])
    .filter((t) => t.assignee === userId && t.done && (t.doneAt ? on(t.doneAt) : t.day === day))
    .map((t) => ({ ...t, at: (t.day === day && t.start) || clockOf(t.doneAt) }));

  const owners = new Map((state?.contacts || []).map((c) => [c.id, c.owner]));
  const emailsSent = (state?.emails || []).filter((e) => e.kind === 'sent' && on(e.ts) && e.contactId && owners.get(e.contactId) === userId);

  const itemsTouched = [];
  (Array.isArray(state?.boards) ? state.boards : []).filter((b) => BOARD_CATEGORY[b.module]).forEach((b) => (b.groups || []).forEach((g) => (g.items || []).forEach((it) => {
    const mine = (it.updates || []).filter((u) => u.user === userId && on(u.ts)).map((u) => u.ts).sort();
    if (mine.length) itemsTouched.push({ board: b.module, id: it.id, name: it.name, ts: mine[0] });
  })));

  const messagesSent = (state?.messages || []).filter((m) => m.user === userId && on(m.ts));
  return { todosDone, emailsSent, itemsTouched, messagesSent };
}

// Saved entries as editable rows: one per hourly slot (an empty slot is Other), plus any entry outside the slots
// so saving never drops it.
export function blocksFromEntries(entries, hours = TIMESHEET_HOURS) {
  const slots = hourSlots(hours);
  const row = (e) => ({ start: e.start, minutes: Number(e.minutes) || 60, category: e.category || 'Other', note: String(e.note ?? ''), source: e.source === 'suggested' ? 'suggested' : 'manual' });
  const byStart = new Map(listOf(entries).map((e) => [e.start, e]));
  const rows = slots.map((s) => (byStart.has(s) ? row(byStart.get(s)) : { start: s, minutes: 60, category: 'Other', note: '', source: 'manual' }));
  listOf(entries).filter((e) => !slots.includes(e.start)).forEach((e) => rows.push(row(e)));
  return rows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

// The 16:30 prompt: weekdays from PROMPT_AT, local time.
export function isPromptDue(now = new Date()) {
  const dow = now.getDay();
  return dow !== 0 && dow !== 6 && `${pad(now.getHours())}:${pad(now.getMinutes())}` >= PROMPT_AT;
}

// ── Snooze until tomorrow: a localStorage flag per person and day (older days' flags are cleared) ──

const SNOOZE = 'cortex:timesheet-snooze';
const snoozeKey = (userId, day) => `${SNOOZE}:${userId}:${day}`;

export function isSnoozed(userId, day = localYmd()) {
  try {
    return localStorage.getItem(snoozeKey(userId, day)) === '1';
  } catch {
    return false; // storage unavailable: the prompt shows (and the caller remembers the snooze for this visit)
  }
}

export function snoozeUntilTomorrow(userId, day = localYmd()) {
  try {
    const mine = `${SNOOZE}:${userId}:`;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(mine) && k !== snoozeKey(userId, day)) localStorage.removeItem(k);
    }
    localStorage.setItem(snoozeKey(userId, day), '1');
    return true;
  } catch {
    return false;
  }
}

// 'Mon 12 Oct' (with the year when it isn't this year).
export function dayLabel(day) {
  const d = new Date(`${day}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-AU', opts);
}
